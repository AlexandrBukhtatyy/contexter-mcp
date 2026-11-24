import fs from "node:fs";
import path from "node:path";
import { getTaskContext, serializePackage, taskText, type TaskContextArgs } from "../context/build.ts";
import { QueryEmbedder } from "../embeddings/query.ts";
import { evaluateTask, formatExplain, formatReport, solutionGuard, summarize, type EvalTask, type MeasureOptions } from "../eval/measure.ts";
import { taskFamily } from "../tasks/load.ts";
import { PROBLEM_TITLES, computeCheck } from "../links/check.ts";
import { globalStatus } from "../search/queries.ts";
import { openSqliteStore } from "../store/sqlite/store.ts";

export async function cmdStatus(dbPath: string, asJson: boolean): Promise<number> {
  const store = await openSqliteStore(dbPath, { readonly: true });
  try {
    const s = globalStatus(store);
    if (asJson) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    else {
      process.stdout.write(
        [
          `коммит: ${s.commit ?? "—"} (${s.branch ?? "—"})${s.dirty_worktree ? ", есть незакоммиченные правки" : ""}`,
          `собран: ${s.built_at ?? "—"}`,
          `файлы: ${Object.entries(s.files).map(([k, v]) => `${k}=${v}`).join(", ")}`,
          `неразобранные: ${s.unparsed_files.length ? s.unparsed_files.map((e) => `${e.path} (${e.error})`).join("; ") : "нет"}`,
          `проблемы: ${Object.entries(s.problems).map(([k, v]) => `${k}=${v}`).join(", ") || "нет"}`,
          `обращения к каналам: ${s.channel_refs.total}, неразрешённых: ${s.channel_refs.unresolved} (${(s.channel_refs.unresolved_share * 100).toFixed(1)}%)`,
          `задачи: ${Object.entries(s.tasks.sources).map(([k, v]) => `${k}=${v}`).join(", ") || "нет"}${s.tasks.errors ? ` (ошибки: ${Object.entries(s.tasks.errors).map(([k, v]) => `${k} — ${v}`).join("; ")})` : ""}; изменений без номера: ${s.tasks.changes}; шаблон номера: ${s.tasks.id_pattern ?? "—"}${s.tasks.id_pattern_from ? ` (${s.tasks.id_pattern_from})` : ""}`,
          `поиск: ${s.search_mode}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * Пакет контекста из командной строки. asOfTask — повтор закрытой задачи «как до её начала»: история задачи
 * и её семейства не используется, похожие задачи — только заведённые раньше (тот же честный режим, что в eval).
 */
export async function cmdContext(root: string, dbPath: string, args: TaskContextArgs, debug = false, asOfTask?: string): Promise<number> {
  const store = await openSqliteStore(dbPath, { readonly: true });
  const queries = await QueryEmbedder.fromRoot(root);
  try {
    const known = asOfTask ? store.getTask(asOfTask) : null;
    const honest = asOfTask
      ? { useTaskHistory: false, excludeTaskIds: taskFamily(asOfTask, known?.parent ?? null), tasksBefore: known?.created_at ?? null }
      : {};
    const queryVector = await queries.vector(store, taskText(store, args));
    process.stdout.write(`${serializePackage(getTaskContext(store, args, { debug, ...honest, queryVector }))}\n`);
    return 0;
  } finally {
    await queries.close();
    store.close();
  }
}

export async function cmdCheck(dbPath: string, asJson: boolean, kind: string | undefined, limit: number): Promise<number> {
  const store = await openSqliteStore(dbPath, { readonly: true });
  try {
    const report = computeCheck(store, { limit, ...(kind ? { kind } : {}) });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const out: string[] = ["# Проверка документации", ""];
    out.push("## Сводка", "");
    for (const [k, v] of Object.entries(report.summary)) out.push(`- ${PROBLEM_TITLES[k] ?? k}: ${v}`);
    const hidden = report.suppressed.filter((r) => r.count > 0);
    if (hidden.length) {
      out.push("", `Скрыто правилами \`checks.ignore\` конфига: ${hidden.reduce((a, r) => a + r.count, 0)}`, "");
      for (const r of hidden) {
        const where = [r.kind && PROBLEM_TITLES[r.kind] ? PROBLEM_TITLES[r.kind] : r.kind, r.path && `в \`${r.path}\``, r.value && `значение \`${r.value}\``].filter(Boolean).join(", ");
        out.push(`- ${r.count} — ${r.reason} (${where})`);
      }
    }
    for (const [k, bucket] of Object.entries(report.problems)) {
      out.push("", `## ${PROBLEM_TITLES[k] ?? k} — ${bucket.count}`, "");
      for (const p of bucket.items) out.push(`- ${p.path}${p.line ? `:${p.line}` : ""} — \`${p.value}\`: ${p.message}`);
      if (bucket.count > bucket.items.length) out.push(`- … и ещё ${bucket.count - bucket.items.length}`);
    }
    if (!kind) {
      out.push("", `## Возможно устаревшие разделы — ${report.summary["stale-section"]}`, "", "Код, на который уверенно ссылается раздел, менялся позже раздела.", "");
      for (const s of report.stale.slice(0, limit)) {
        const newest = Math.max(...s.targets.map((t) => t.changedAt));
        out.push(`- ${s.chunkId} (раздел ${day(s.chunkChangedAt)}, код ${day(newest)}): ${s.targets.slice(0, 3).map((t) => t.id.split("#").pop() ?? t.id).join(", ")}`);
      }
      out.push("", `## Непокрытый код — ${report.uncovered.length}`, "", "Пакеты и каталоги, на которые не ссылается ни один раздел документации.", "");
      for (const u of report.uncovered.slice(0, limit)) out.push(`- ${u.dir || "."} (${u.kind}, файлов: ${u.files})`);
    }
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  } finally {
    store.close();
  }
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface EvalOptions extends MeasureOptions {
  setPath?: string;
  asJson: boolean;
  /** Только эти задачи набора. */
  ids?: string[];
  /** Мерить на коде до задачи — на родителе коммита-решения (`commits` в наборе). */
  snapshots?: boolean;
  /** Каталог копии репозитория для снимков; по умолчанию `.mcp/cache/snapshot`. */
  workDir?: string;
}

/**
 * Замер на эталонном наборе (JSONL: id, task, files, docs). Метрики раздела плана «Тестирование и замер качества»
 * для get_task_context — полнота файлов и документов, точность, размер пакета, время — и для сравнения
 * поиск отдельно: нужный документ в первых k результатах search_docs и файлы в первых k результатах search_code.
 * История задачи (коммиты с её ID) в замере не используется: на закрытой задаче она подсказала бы ответ.
 * С `snapshots` каждая задача меряется на коде до её решения (src/eval/snapshots.ts).
 */
export async function cmdEval(root: string, dbPath: string, opts: EvalOptions): Promise<number> {
  const file = path.resolve(opts.setPath ?? path.join(root, ".mcp/eval/tasks.jsonl"));
  if (!fs.existsSync(file)) {
    process.stderr.write(`эталонный набор не найден: ${file}\n`);
    return 2;
  }
  let tasks = parseJsonObjects(fs.readFileSync(file, "utf8")) as EvalTask[];
  if (opts.ids?.length) {
    const unknown = opts.ids.filter((id) => !tasks.some((t) => t.id === id));
    if (unknown.length) {
      process.stderr.write(`в наборе нет задач: ${unknown.join(", ")}\n`);
      return 2;
    }
    tasks = tasks.filter((t) => opts.ids?.includes(t.id));
  }

  if (opts.snapshots) {
    const { runSnapshotEval } = await import("../eval/snapshots.ts");
    const run = await runSnapshotEval(root, tasks, { ...opts, log: (m) => process.stderr.write(`${m}\n`) });
    const measured = tasks.filter((t) => run.rows.some((r) => r.id === t.id));
    const summary = summarize(file, measured, run.rows, opts.k);
    const extra = { work: run.work, skipped: run.skipped, errors: run.errors };
    if (opts.asJson) {
      process.stdout.write(`${JSON.stringify({ summary: { ...summary, snapshots: extra }, rows: run.rows }, null, 2)}\n`);
      return run.errors.length ? 1 : 0;
    }
    const notes = [
      run.skipped.length ? `без коммитов-решений (commits), пропущено: ${run.skipped.join(", ")}` : "",
      ...run.errors.map((e) => `не измерена ${e.id}: ${e.error}`),
      ...run.rows.filter((r) => r.snapshot.dropped.length).map((r) => `${r.id}: нет в снимке и решение не создавало — ${r.snapshot.dropped.join(", ")}`),
    ].filter(Boolean);
    const newFiles = run.rows.reduce((n, r) => n + r.snapshot.new_files.length, 0);
    process.stdout.write(
      `${formatReport(summary, `на коде до задачи (родитель коммита-решения), копия ${run.work}; созданные решением файлы (${newFiles}) в полноту не входят`)}\n${notes.length ? `\n${notes.join("\n")}\n` : ""}${formatExplain(run.rows)}\n`,
    );
    return run.errors.length ? 1 : 0;
  }

  const store = await openSqliteStore(dbPath, { readonly: true });
  const queries = opts.vectors === false ? null : await QueryEmbedder.fromRoot(root);
  try {
    const rows = [];
    for (const t of tasks) {
      const guarded = { ...t, guard: solutionGuard(root, t.commits) };
      rows.push(evaluateTask(store, guarded, opts, queries ? await queries.vector(store, t.task) : null));
    }
    const summary = summarize(file, tasks, rows, opts.k);
    if (opts.asJson) process.stdout.write(`${JSON.stringify({ summary, rows }, null, 2)}\n`);
    else process.stdout.write(`${formatReport(summary, "на текущем коде")}\n${formatExplain(rows)}\n`);
    return 0;
  } finally {
    await queries?.close();
    store.close();
  }
}

/**
 * Объекты JSON из файла набора: строки JSONL, массив JSON или объекты подряд в любом форматировании
 * (редактор может переформатировать JSONL в многострочные объекты).
 */
export function parseJsonObjects(text: string): unknown[] {
  const t = text.trim();
  if (t.startsWith("[")) return JSON.parse(t) as unknown[];
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(JSON.parse(t.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return out;
}
