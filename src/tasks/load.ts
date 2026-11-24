import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config/schema.ts";
import type { TaskFileRow, TaskRow } from "../store/types.ts";
import type { CommitRecord, TaskAdapter, TaskRecord, TaskSourceContext } from "./types.ts";

/**
 * Источники задач. Задачи приходят откуда угодно — из трекера (beads), из файла задач в репозитории,
 * из своего адаптера и из истории git: номер задачи в сообщении коммита, а коммит без номера — отдельное
 * «изменение». Всё сливается по ID: текст и поля трекера главнее, git добавляет файлы и даты.
 * Сервер не ходит в сеть и не хранит ключи: трекер с API подключается своим адаптером.
 */

/** Коммит больше этого числа файлов в связь «задача → файлы» не входит: это массовые правки. */
export const TASK_COMMIT_MAX_FILES = 150;
/** Префикс ID «изменения» — коммита без номера задачи. */
export const CHANGE_PREFIX = "commit:";
/** Длина хэша в ID «изменения». */
const CHANGE_HASH_LEN = 10;
const BUILTIN = new Set(["git", "beads", "jsonl"]);
/** Описание задачи из коммитов — не длиннее: поиск похожих идёт по нему. */
const MAX_DESCRIPTION = 4000;

export interface TaskSourceStats {
  name: string;
  tasks: number;
  /** Свой адаптер упал при загрузке: индексация идёт дальше без его задач. */
  error?: string;
}

export interface LoadedTasks {
  tasks: TaskRow[];
  taskFiles: TaskFileRow[];
  /** Шаблон номера задачи: из конфига, по префиксам трекера или найденный в коммитах; null — нет. */
  idPattern: string | null;
  /** Откуда шаблон: config, tracker, commits. */
  idPatternFrom: "config" | "tracker" | "commits" | null;
  sources: TaskSourceStats[];
  /** «Изменения» — коммиты без номера задачи. */
  changes: number;
}

type SourceSpec = { use: string; options: Record<string, unknown> };

/** ID «изменения» по хэшу коммита. */
export const changeId = (hash: string) => `${CHANGE_PREFIX}${hash.slice(0, CHANGE_HASH_LEN)}`;

/** Родительские ID: явный родитель и эпик по префиксу (`proj-camera.4` → `proj-camera`). */
export function taskFamily(id: string, parent: string | null): string[] {
  const out = [id];
  if (parent) out.push(parent);
  const dot = id.indexOf(".");
  if (dot > 0 && !id.startsWith(CHANGE_PREFIX)) out.push(id.slice(0, dot));
  return [...new Set(out)];
}

/** Источники из конфига; по умолчанию — beads, если есть его файл, и git. */
function resolveSources(root: string, config: Config): SourceSpec[] {
  const t = config.tasks;
  if (t.sources) return t.sources.map((s) => (typeof s === "string" ? { use: s, options: {} } : { use: s.use, options: s.options ?? {} }));
  const out: SourceSpec[] = [];
  const beads = t.beads ?? ".beads/issues.jsonl";
  if (fs.existsSync(path.join(root, beads))) out.push({ use: "beads", options: { path: beads } });
  out.push({ use: "git", options: {} });
  return out;
}

/** Строки JSONL; битая строка пропускается. */
function readJsonl(file: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === "object") out.push(o as Record<string, unknown>);
    } catch {
      /* битая строка */
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** beads: `.beads/issues.jsonl` — ID, тип, статус, заголовок, описание с критериями, родитель, дата создания. */
const beadsAdapter: TaskAdapter = {
  name: "beads",
  load(ctx) {
    const rel = str(ctx.options.path) ?? ".beads/issues.jsonl";
    const file = path.join(ctx.root, rel);
    if (!fs.existsSync(file)) {
      ctx.log(`задачи beads: файла нет — ${rel}`);
      return [];
    }
    return readJsonl(file).flatMap((o) => {
      if (typeof o.id !== "string" || typeof o.title !== "string") return [];
      const deps = Array.isArray(o.dependencies) ? (o.dependencies as Array<Record<string, unknown>>) : [];
      const parent = deps.find((d) => d.type === "parent-child" && d.issue_id === o.id)?.depends_on_id;
      return [
        {
          id: o.id,
          title: o.title,
          description: [o.description, o.acceptance_criteria].filter((x): x is string => typeof x === "string" && x.trim() !== "").join("\n\n"),
          type: str(o.issue_type),
          status: str(o.status),
          parent: typeof parent === "string" ? parent : null,
          created_at: str(o.created_at),
        },
      ];
    });
  },
};

/** Файл задач в нейтральном формате: строки JSON с полями TaskRecord (`id`, `title`, `description`, …). */
const jsonlAdapter: TaskAdapter = {
  name: "jsonl",
  load(ctx) {
    const rel = str(ctx.options.path);
    if (!rel) throw new Error("источник задач jsonl: нужен options.path — путь к файлу задач в репозитории");
    const file = path.join(ctx.root, rel);
    if (!fs.existsSync(file)) throw new Error(`источник задач jsonl: файла нет — ${rel}`);
    return readJsonl(file).flatMap((o) => normalize(o));
  },
};

/** Запись адаптера → TaskRecord; без id и title — пропускается. */
function normalize(o: unknown): TaskRecord[] {
  if (!o || typeof o !== "object") return [];
  const r = o as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id.trim() || typeof r.title !== "string") return [];
  return [
    {
      id: r.id.trim(),
      title: r.title,
      description: typeof r.description === "string" ? r.description : "",
      type: str(r.type),
      status: str(r.status),
      parent: str(r.parent),
      created_at: str(r.created_at),
    },
  ];
}

/** Свой адаптер — ES-модуль внутри репозитория с default-экспортом `{ name, load(ctx) }`. */
async function loadPlugin(root: string, rel: string): Promise<TaskAdapter> {
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error(`адаптер задач вне репозитория: ${rel}`);
  if (!fs.existsSync(file)) throw new Error(`адаптер задач не найден: ${rel}`);
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const a = mod.default as Partial<TaskAdapter> | undefined;
  if (!a || typeof a.name !== "string" || typeof a.load !== "function") throw new Error(`адаптер задач ${rel}: ожидается { name, load(ctx) } в default-экспорте`);
  return a as TaskAdapter;
}

/** Префиксы ID документов (`ADR-(\d{4})` → ADR): такие номера — ссылки на документы, а не задачи. */
function docIdPrefixes(config: Config): Set<string> {
  const out = new Set<string>();
  for (const r of config.documents.id_refs) {
    const m = r.pattern.replace(/\\b|\(|\)|\^/g, "").match(/^([A-Za-z]+)-/);
    if (m?.[1]) out.add(m[1].toUpperCase());
  }
  return out;
}

/** Обозначения, похожие на номер задачи, но им не являющиеся. */
const NOT_TASK_PREFIXES = new Set(["UTF", "SHA", "ISO", "RFC", "HTTP", "TLS", "SSL", "CVE", "MD", "AES", "RSA", "X", "COVID", "GPT", "H", "UUID", "BASE", "WIN", "IE"]);

/**
 * Шаблон номера задачи по коммитам: `PROJ-123` (Jira, YouTrack) и `#123` (GitLab, GitHub). Префикс берётся,
 * только если встречается хотя бы в minCommits коммитах и в 2% коммитов; префиксы ID документов, обозначения
 * вроде UTF-8 и номера, которые чаще пишутся с ведущим нулём (`AT-04` — критерий приёмки), — нет.
 * null — номеров задач в коммитах не видно.
 */
export function detectIdPattern(commits: CommitRecord[], exclude: Set<string>): string | null {
  if (!commits.length) return null;
  const minCommits = Math.max(3, Math.ceil(commits.length * 0.02));
  const byPrefix = new Map<string, number>();
  // Номера с ведущим нулём (AT-01, ADR-0001) — нумерация документов и критериев; трекеры нулями не дополняют.
  const padded = new Map<string, number>();
  const refs = new Map<string, number>();
  let hashRefs = 0;
  for (const c of commits) {
    const found = [...c.message.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)];
    for (const p of new Set(found.map((m) => m[1] as string))) byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
    for (const m of found) {
      const p = m[1] as string;
      refs.set(p, (refs.get(p) ?? 0) + 1);
      if ((m[2] as string).length > 1 && m[2]?.startsWith("0")) padded.set(p, (padded.get(p) ?? 0) + 1);
    }
    if (/(?<![\w&/#])#\d{1,6}\b/.test(c.message)) hashRefs++;
  }
  const prefixes = [...byPrefix]
    .filter(([p, n]) => n >= minCommits && !exclude.has(p) && !NOT_TASK_PREFIXES.has(p) && (padded.get(p) ?? 0) * 2 < (refs.get(p) ?? 0))
    .map(([p]) => p)
    .sort();
  const parts: string[] = [];
  if (prefixes.length) parts.push(`\\b(?:${prefixes.join("|")})-\\d+\\b`);
  if (hashRefs >= minCommits) parts.push("(?<![\\w&/#])#\\d+\\b");
  return parts.length ? parts.join("|") : null;
}

/**
 * Задачи из git: номер задачи в сообщении коммита — коммиты одной задачи вместе (заголовок — тема первого,
 * описание — сообщения, дата — первого коммита, файлы — их файлы); коммит без номера — «изменение»
 * `commit:<хэш>` со своим сообщением и файлами. Файлы — только из индекса, массовые коммиты — без файлов.
 */
function gitTasks(
  commits: CommitRecord[],
  idPattern: string | null,
  indexed: ReadonlySet<string>,
  opts: { commitsWithoutId: boolean; maxCommits: number },
): { tasks: Map<string, TaskRecord>; files: Map<string, number>; changes: number } {
  const recent = commits.slice(0, opts.maxCommits);
  const idRe = idPattern ? new RegExp(idPattern, "gu") : null;
  const byTask = new Map<string, CommitRecord[]>();
  const tasks = new Map<string, TaskRecord>();
  const files = new Map<string, number>();
  const addFiles = (id: string, c: CommitRecord) => {
    if (c.files.length > TASK_COMMIT_MAX_FILES) return;
    for (const f of c.files) if (indexed.has(f)) files.set(`${id}\u0000${f}`, (files.get(`${id}\u0000${f}`) ?? 0) + 1);
  };
  let changes = 0;
  for (const c of recent) {
    const ids = idRe ? [...new Set([...c.message.matchAll(idRe)].map((m) => m[0]))] : [];
    if (ids.length) {
      for (const id of ids) {
        const list = byTask.get(id) ?? [];
        list.push(c);
        byTask.set(id, list);
        addFiles(id, c);
      }
    } else if (opts.commitsWithoutId) {
      const id = changeId(c.hash);
      const [subject = "", ...body] = c.message.split("\n");
      tasks.set(id, { id, title: subject.trim() || c.hash.slice(0, CHANGE_HASH_LEN), description: body.join("\n").trim().slice(0, MAX_DESCRIPTION), created_at: new Date(c.time).toISOString() });
      addFiles(id, c);
      changes++;
    }
  }
  for (const [id, list] of byTask) {
    const ordered = [...list].sort((a, b) => a.time - b.time);
    const first = ordered[0] as CommitRecord;
    const messages = [...new Set(ordered.map((c) => c.message))].join("\n\n").slice(0, MAX_DESCRIPTION);
    tasks.set(id, { id, title: first.message.split("\n")[0]?.trim() || id, description: messages, created_at: new Date(first.time).toISOString() });
  }
  return { tasks, files, changes };
}

/**
 * Задачи всех источников с файлами из истории git. `indexed` — файлы индекса: связь «задача → файлы» только
 * с ними. Ошибка своего адаптера или файла задач — исключение: конфиг указывает на то, чего нет.
 */
export async function loadTaskSources(
  root: string,
  config: Config,
  commits: CommitRecord[],
  indexed: ReadonlySet<string>,
  log: (msg: string) => void = () => {},
): Promise<LoadedTasks> {
  const specs = resolveSources(root, config);
  const stats: TaskSourceStats[] = [];
  const merged = new Map<string, TaskRow>();
  // Трекеры и файлы задач — первыми: их текст и поля главнее того, что выводится из коммитов.
  for (const spec of specs.filter((s) => s.use !== "git")) {
    const adapter = spec.use === "beads" ? beadsAdapter : spec.use === "jsonl" ? jsonlAdapter : BUILTIN.has(spec.use) ? null : await loadPlugin(root, spec.use);
    if (!adapter) continue;
    const ctx: TaskSourceContext = { root, options: spec.options, commits, log };
    let records: TaskRecord[];
    try {
      records = (await adapter.load(ctx)).flatMap((r) => normalize(r));
    } catch (e) {
      // Встроенный источник с ошибкой — ошибка конфига; свой адаптер (сеть, ключи) не должен ронять индексацию.
      if (BUILTIN.has(spec.use)) throw e;
      const error = (e as Error).message ?? String(e);
      log(`источник задач ${adapter.name}: ошибка — ${error}; задачи из него не загружены`);
      stats.push({ name: adapter.name, tasks: 0, error });
      continue;
    }
    let added = 0;
    for (const r of records) {
      if (merged.has(r.id)) continue;
      merged.set(r.id, toRow(r, adapter.name));
      added++;
    }
    stats.push({ name: adapter.name, tasks: added });
  }

  // Шаблон номера задачи: из конфига, по префиксам ID трекера, иначе — по коммитам.
  let idPattern: string | null = config.tasks.id_pattern ?? null;
  let idPatternFrom: LoadedTasks["idPatternFrom"] = idPattern ? "config" : null;
  if (!idPattern && merged.size) {
    const prefixes = [...new Set([...merged.keys()].map((id) => id.split("-")[0]).filter((p): p is string => !!p && /^[A-Za-z]\w*$/.test(p)))].sort();
    if (prefixes.length) {
      idPattern = `\\b(?:${prefixes.join("|")})-[a-z0-9]+(?:\\.[a-z0-9]+)*\\b`;
      idPatternFrom = "tracker";
    }
  }
  const useGit = specs.some((s) => s.use === "git");
  if (!idPattern && useGit) {
    idPattern = detectIdPattern(commits, docIdPrefixes(config));
    if (idPattern) idPatternFrom = "commits";
  }

  // Задачи из git: ID из сообщений — дополняют задачи трекера файлами и датой; «изменения» — свои записи.
  let files = new Map<string, number>();
  let changes = 0;
  if (useGit) {
    const g = gitTasks(commits, idPattern, indexed, { commitsWithoutId: config.tasks.git.commits_without_id, maxCommits: config.tasks.git.max_commits });
    files = g.files;
    changes = g.changes;
    let fromGit = 0;
    for (const [id, r] of g.tasks) {
      const prev = merged.get(id);
      if (prev) {
        if (!prev.created_at) prev.created_at = r.created_at ?? null;
        continue;
      }
      merged.set(id, toRow(r, id.startsWith(CHANGE_PREFIX) ? "commit" : "git"));
      if (!id.startsWith(CHANGE_PREFIX)) fromGit++;
    }
    stats.push({ name: "git", tasks: fromGit });
  }

  const taskFiles = [...files.entries()]
    .map(([k, n]) => {
      const [taskId = "", file = ""] = k.split("\u0000");
      return { taskId, file, commits: n };
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.file.localeCompare(b.file));
  return { tasks: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)), taskFiles, idPattern, idPatternFrom, sources: stats, changes };
}

function toRow(r: TaskRecord, source: string): TaskRow {
  return {
    id: r.id,
    type: r.type ?? null,
    status: r.status ?? null,
    title: r.title,
    description: r.description ?? "",
    parent: r.parent ?? null,
    created_at: r.created_at ?? null,
    source,
  };
}
