import { getTaskContext } from "../context/build.ts";
import type { QueryVector } from "../embeddings/query.ts";
import { execFileSync } from "node:child_process";
import { changeId, taskFamily } from "../tasks/load.ts";
import { searchCode, searchDocs } from "../search/queries.ts";
import type { IndexReader } from "../store/types.ts";

/** Задача эталонного набора. */
export interface EvalTask {
  id: string;
  task: string;
  /** Файлы, которые задача меняет (пути в текущем коде). */
  files?: string[];
  /** Документы, которые нужно прочитать до правки. */
  docs?: string[];
  draft?: boolean;
  /** Кто проверил ответы: "human" или "claude" (ответы сверены с коммитами, но не человеком). */
  reviewed?: string;
  /** Коммиты-решения задачи. Замер на коде до задачи (`eval --snapshots`) идёт на родителе самого раннего. */
  commits?: string[];
  /**
   * Пути на момент до задачи, если их не вывести из истории переименований
   * (код перенесли в другой файл, а не переименовали файл). Заменяют выведенные.
   */
  before?: { files?: string[]; docs?: string[] };
  /**
   * Заполняется при замере на текущем коде по `commits` (solutionGuard): «изменения» коммитов-решений
   * и дата самого раннего из них — чтобы похожие не подсказали решение, если задачи нет в трекере.
   */
  guard?: { exclude: string[]; before: string | null };
}

/**
 * Защита честного замера по коммитам-решениям: ID их «изменений» (`commit:<хэш>`) и дата самого раннего.
 * Нужна на текущем коде, когда задачи нет в трекере и её дату не взять из индекса.
 */
export function solutionGuard(root: string, commits: string[] | undefined): { exclude: string[]; before: string | null } {
  const exclude: string[] = [];
  let before: string | null = null;
  for (const c of commits ?? []) {
    try {
      const [hash = "", date = ""] = execFileSync("git", ["-C", root, "log", "-1", "--format=%H %cI", c], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim()
        .split(" ");
      if (!hash) continue;
      exclude.push(changeId(hash));
      const iso = new Date(date).toISOString();
      if (!before || iso < before) before = iso;
    } catch {
      // коммита нет в этом репозитории — защищать нечего
    }
  }
  return { exclude, before };
}

export interface MeasureOptions {
  /** Сколько первых результатов `search_docs` и `search_code` брать для сравнения. */
  k: number;
  budget?: number;
  /** Доли бюджета docs,code,rules — для подбора. */
  shares?: { docs: number; code: number; rules: number };
  /** Разбор по каждому нужному файлу и документу: в пакете ли, место среди кандидатов, списки, место в поиске. */
  explain?: boolean;
  /** false — без поиска по смыслу, даже если он настроен (для сравнения). */
  vectors?: boolean;
}

/** Где оказался нужный файл или документ. */
export interface ExplainItem {
  path: string;
  in_package: boolean;
  /** Место лучшего кандидата из этого файла среди всех кандидатов (с 1); null — не кандидат. */
  rank: number | null;
  score: number | null;
  section: string | null;
  /** Списки и места в них у лучшего кандидата. */
  lists: Record<string, number> | null;
  /** Место в выдаче `search_code` / `search_docs` (первые 30); null — нет. */
  search_rank: number | null;
}

export interface EvalRow {
  id: string;
  expected_files: number;
  expected_docs: number;
  file_recall: number | null;
  doc_recall: number | null;
  /** Доля нужного среди всех элементов пакета (docs, rules, code) — для справки: растёт с сужением пакета. */
  precision: number | null;
  /** Доля нужного среди первых пяти мест кода и первых пяти разделов документации и правил — то, что агент читает первым. */
  precision_top5: number | null;
  tokens: number;
  budget: number;
  ms: number;
  baseline_doc_hit: boolean | null;
  baseline_file_recall: number | null;
  /** Как искал пакет: по словам и связям, со смыслом или почему без него (meta.search). */
  search: string;
  explain?: { candidates: number; files: ExplainItem[]; docs: ExplainItem[] };
}

export interface EvalSummary {
  set: string;
  tasks: number;
  draft: boolean;
  reviewed_by: string[];
  budget: number | null;
  file_recall: number;
  doc_recall: number;
  precision: number;
  precision_top5: number;
  tokens_avg: number;
  tokens_max: number;
  over_budget: number;
  ms_p95: number;
  /** Режимы поиска пакета и сколько задач в каждом. */
  search: Record<string, number>;
  baseline: { k: number; doc_hit_at_k: number; file_recall_at_k: number };
}

export const docOf = (idOrPath: string) => idOrPath.split("#")[0] ?? idOrPath;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};

/**
 * Метрики одной задачи на индексе: полнота файлов и документов пакета, точность, размер, время; для сравнения —
 * поиск отдельно. Честный режим: история самой задачи и её семейства и задачи, заведённые позже неё, не используются.
 * Файлы и документы, которых нет в индексе, не учитываются.
 */
export function evaluateTask(reader: IndexReader, t: EvalTask, opts: MeasureOptions, queryVector: QueryVector | null = null): EvalRow {
  const expectedDocs = new Set((t.docs ?? []).map(docOf).filter((d) => reader.getDocument(d)));
  const expectedFiles = new Set((t.files ?? []).filter((f) => reader.getFile(f)));

  const started = performance.now();
  const known = reader.getTask(t.id);
  const pkg = getTaskContext(
    reader,
    { task: t.task, ...(opts.budget ? { budget_tokens: opts.budget } : {}) },
    {
      useTaskHistory: false,
      // Сама задача, её семейство и «изменения» её коммитов-решений; похожие — только заведённые раньше.
      excludeTaskIds: [...taskFamily(t.id, known?.parent ?? null), ...(t.guard?.exclude ?? [])],
      tasksBefore: known?.created_at ?? t.guard?.before ?? null,
      ...(opts.shares ? { shares: opts.shares } : {}),
      ...(opts.explain ? { debug: true } : {}),
      queryVector,
    },
  );
  const ms = performance.now() - started;
  const pkgDocs = new Set([...pkg.docs, ...pkg.rules].map((d) => docOf(String(d.id))));
  const pkgFiles = new Set([...pkg.code, ...pkg.tests].map((c) => String(c.at).replace(/:\d+$/, "")));
  const items = [...pkg.docs, ...pkg.rules, ...pkg.code];
  const isRelevant = (it: Record<string, unknown>) => (it.id ? expectedDocs.has(docOf(String(it.id))) : expectedFiles.has(String(it.at).replace(/:\d+$/, "")));
  const relevant = items.filter(isRelevant).length;
  const top = [...[...pkg.docs, ...pkg.rules].slice(0, 5), ...pkg.code.slice(0, 5)];

  // Поиск отдельно — исходная точка для сравнения: первые k результатов. Для разбора — первые 30, по файлу.
  const searchLimit = opts.explain ? Math.max(opts.k, 30) : opts.k;
  const docsRaw = searchDocs(reader, { query: t.task, limit: searchLimit, max_tokens: 1, mode: "words" }).results.map((r) => docOf(r.id));
  const codeRaw = searchCode(reader, { query: t.task, limit: searchLimit, include_tests: false }).results.map((c) => c.at.replace(/:\d+$/, ""));
  const docsHits = docsRaw.slice(0, opts.k);
  const codeHits = new Set(codeRaw.slice(0, opts.k));
  const docsList = [...new Set(docsRaw)];
  const codeList = [...new Set(codeRaw)];

  let explain: EvalRow["explain"];
  if (opts.explain) {
    const ranking = (pkg.meta.ranking ?? []) as Array<{ key: string; section: string; score: number; lists: Record<string, number> }>;
    const pathOfKey = (key: string) => (key.slice(2).split("#")[0] ?? "");
    const firstRank = new Map<string, number>();
    ranking.forEach((r, i) => {
      const p = pathOfKey(r.key);
      if (!firstRank.has(p)) firstRank.set(p, i);
    });
    const item = (p: string, inPackage: boolean, searchList: string[]): ExplainItem => {
      const i = firstRank.get(p);
      const r = i === undefined ? undefined : ranking[i];
      const s = searchList.indexOf(p);
      return { path: p, in_package: inPackage, rank: i === undefined ? null : i + 1, score: r?.score ?? null, section: r?.section ?? null, lists: r?.lists ?? null, search_rank: s < 0 ? null : s + 1 };
    };
    explain = {
      candidates: Number(pkg.meta.ranking_total ?? ranking.length),
      files: [...expectedFiles].map((f) => item(f, pkgFiles.has(f), codeList)),
      docs: [...expectedDocs].map((d) => item(d, pkgDocs.has(d), docsList)),
    };
  }

  return {
    id: t.id,
    expected_files: expectedFiles.size,
    expected_docs: expectedDocs.size,
    file_recall: expectedFiles.size ? [...expectedFiles].filter((f) => pkgFiles.has(f)).length / expectedFiles.size : null,
    doc_recall: expectedDocs.size ? [...expectedDocs].filter((d) => pkgDocs.has(d)).length / expectedDocs.size : null,
    precision: items.length ? relevant / items.length : null,
    precision_top5: top.length ? top.filter(isRelevant).length / top.length : null,
    tokens: Number(pkg.meta.used_tokens),
    budget: Number(pkg.meta.budget_tokens),
    ms: Math.round(ms),
    baseline_doc_hit: expectedDocs.size ? docsHits.some((d) => expectedDocs.has(d)) : null,
    baseline_file_recall: expectedFiles.size ? [...expectedFiles].filter((f) => codeHits.has(f)).length / expectedFiles.size : null,
    search: String(pkg.meta.search ?? ""),
    ...(explain ? { explain } : {}),
  };
}

/** Разбор не вошедшего: по строке на нужный файл или документ, которого нет в пакете. */
export function formatExplain(rows: EvalRow[]): string {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.explain) continue;
    const missed = [...r.explain.files.map((x) => ({ ...x, kind: "файл" })), ...r.explain.docs.map((x) => ({ ...x, kind: "документ" }))].filter((x) => !x.in_package);
    if (!missed.length) continue;
    out.push(`### ${r.id} — кандидатов ${r.explain.candidates}`);
    for (const m of missed) {
      const lists = m.lists ? Object.entries(m.lists).map(([k, v]) => `${k} ${v}`).join(", ") : "";
      const where = m.rank === null ? "не кандидат" : `место ${m.rank} (${m.section}, счёт ${m.score}; ${lists})`;
      const search = m.kind === "файл" ? "search_code" : "search_docs";
      out.push(`- ${m.kind} ${m.path}: ${where}; ${search}: ${m.search_rank === null ? "нет в первых 30" : `место ${m.search_rank}`}`);
    }
  }
  return out.length ? `\nНе вошло в пакет:\n${out.join("\n")}` : "";
}

export function summarize(set: string, tasks: EvalTask[], rows: EvalRow[], k: number): EvalSummary {
  const vals = (key: keyof EvalRow) => rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
  return {
    set,
    tasks: rows.length,
    draft: tasks.some((t) => t.draft),
    reviewed_by: [...new Set(tasks.map((t) => t.reviewed).filter((r): r is string => Boolean(r)))],
    budget: rows[0]?.budget ?? null,
    file_recall: avg(vals("file_recall")),
    doc_recall: avg(vals("doc_recall")),
    precision: avg(vals("precision")),
    precision_top5: avg(vals("precision_top5")),
    tokens_avg: Math.round(avg(vals("tokens"))),
    tokens_max: Math.max(0, ...vals("tokens")),
    over_budget: rows.filter((r) => r.tokens > r.budget).length,
    ms_p95: percentile(vals("ms"), 95),
    search: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.search]: (acc[r.search] ?? 0) + 1 }), {}),
    baseline: {
      k,
      doc_hit_at_k: avg(rows.filter((r) => r.baseline_doc_hit !== null).map((r) => (r.baseline_doc_hit ? 1 : 0))),
      file_recall_at_k: avg(vals("baseline_file_recall")),
    },
  };
}

/** Отчёт в Markdown: метрики рядом с целями плана. `where` — на каком коде мерили. */
export function formatReport(s: EvalSummary, where: string): string {
  const checked = s.draft
    ? " (черновик — ответы не проверены человеком)"
    : s.reviewed_by.length && !s.reviewed_by.includes("human")
      ? ` (ответы проверены: ${s.reviewed_by.join(", ")}; человеком — нет)`
      : "";
  return [
    `набор: ${s.set}${checked}`,
    `задач: ${s.tasks}, бюджет пакета: ${s.budget} токенов; ${where}; история задач не используется`,
    `поиск: ${Object.entries(s.search).map(([k, n]) => (Object.keys(s.search).length > 1 ? `${k} — ${n}` : k)).join("; ")}`,
    "",
    "| Метрика | get_task_context | Цель к пилоту |",
    "| --- | --- | --- |",
    `| Полнота файлов (изменённые файлы в пакете) | ${pct(s.file_recall)} | не меньше 70% |`,
    `| Полнота документов | ${pct(s.doc_recall)} | не меньше 80% |`,
    `| Точность первых пяти (первые 5 мест кода и 5 разделов документации и правил) | ${pct(s.precision_top5)} | не меньше 50% |`,
    `| Точность всего пакета (для справки: растёт с сужением пакета) | ${pct(s.precision)} | — |`,
    `| Размер пакета: средний / наибольший | ${s.tokens_avg} / ${s.tokens_max} токенов, превышений бюджета: ${s.over_budget} | в пределах бюджета |`,
    `| Время ответа, 95-й перцентиль | ${s.ms_p95} мс | до 1500 мс |`,
    "",
    `Для сравнения — только поиск: нужный документ в первых ${s.baseline.k} результатах search_docs — ${pct(s.baseline.doc_hit_at_k)}, изменённые файлы в первых ${s.baseline.k} результатах search_code — ${pct(s.baseline.file_recall_at_k)}.`,
  ].join("\n");
}
