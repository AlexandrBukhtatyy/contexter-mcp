import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_REL_PATH, LOCAL_CONFIG_REL_PATH, loadConfig } from "../config/load.ts";
import { createEmbedder } from "../embeddings/provider.ts";
import { QueryEmbedder } from "../embeddings/query.ts";
import { loadRegistry } from "../extractors/registry.ts";
import { defaultDbPath, runIndex } from "../indexer/index.ts";
import { openSqliteStore } from "../store/sqlite/store.ts";
import { docOf, evaluateTask, type EvalRow, type EvalTask, type MeasureOptions } from "./measure.ts";

/**
 * Замер на коде до задачи. На текущем коде решение задачи уже лежит в репозитории, и поиск находит его
 * реализацию — оценка завышена. Здесь каждая задача меряется на родителе самого раннего коммита-решения:
 * в таком снимке нет ни кода решения, ни его коммитов, а задачи beads — только заведённые к тому времени.
 *
 * Снимки — одна копия репозитория (`git clone --shared`: исходный репозиторий только читается) с одним
 * индексом. Копия переключается с коммита на коммит, индекс обновляется по изменившимся файлам.
 * Конфиг берётся текущий (`.mcp/context.yaml` исходного репозитория): мерится нынешняя настройка.
 */

/** Каталог копии по умолчанию — внутри кэша индекса исходного репозитория. */
export const SNAPSHOT_REL_PATH = ".mcp/cache/snapshot";

export interface SnapshotPlan {
  id: string;
  /** Коммит, на котором мерится задача: родитель самого раннего коммита-решения. */
  base: string;
  baseDate: string;
  /** Файлы, которые задача меняет, — пути на момент `base`. */
  files: string[];
  /** Файлы, которые решение создало: в снимке их ещё нет, в полноту не входят. */
  newFiles: string[];
  docs: string[];
  /** Пути из набора, которых нет в снимке и которые решение не создавало. */
  dropped: string[];
}

export interface SnapshotRow extends EvalRow {
  snapshot: { base: string; date: string; new_files: string[]; dropped: string[] };
}

export interface SnapshotRun {
  rows: SnapshotRow[];
  /** Задачи без `commits`. */
  skipped: string[];
  errors: Array<{ id: string; error: string }>;
  work: string;
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** Кэш запросов к истории: деревья коммитов и прежние имена файлов. */
export class HistoryCache {
  private trees = new Map<string, Set<string>>();
  private names = new Map<string, Set<string>>();
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  /** Все файлы дерева коммита. */
  tree(commit: string): Set<string> {
    let t = this.trees.get(commit);
    if (!t) {
      t = new Set(git(this.root, ["ls-tree", "-r", "--name-only", "-z", commit]).split("\0").filter(Boolean));
      this.trees.set(commit, t);
    }
    return t;
  }

  /** Путь и все его прежние имена по истории переименований (`git log --follow`). */
  namesOf(file: string): Set<string> {
    let n = this.names.get(file);
    if (!n) {
      n = new Set([file]);
      try {
        for (const line of git(this.root, ["log", "--follow", "--name-only", "--format=", "--", file]).split("\n")) if (line.trim()) n.add(line.trim());
      } catch {
        // файла нет в истории — остаётся только текущее имя
      }
      this.names.set(file, n);
    }
    return n;
  }
}

/** Что задача меняет и что читает — в путях на момент до решения. */
export function planSnapshot(history: HistoryCache, t: EvalTask): SnapshotPlan {
  const root = history.root;
  if (!t.commits?.length) throw new Error("нет коммитов-решений (commits)");
  const resolved = t.commits.map((c) => {
    try {
      return git(root, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`]).trim();
    } catch {
      throw new Error(`коммит ${c} не найден`);
    }
  });
  // Самый ранний по дате коммита; на нём и после него задача уже решается.
  const dated = git(root, ["log", "--no-walk=unsorted", "--format=%H %ct", ...resolved])
    .trim()
    .split("\n")
    .map((l) => {
      const [h, ct] = l.split(" ");
      return { h: h ?? "", ct: Number(ct) };
    });
  const earliest = dated.reduce((a, b) => (b.ct < a.ct ? b : a));
  let base: string;
  try {
    base = git(root, ["rev-parse", "--verify", "--quiet", `${earliest.h}^`]).trim();
  } catch {
    throw new Error(`у коммита ${earliest.h.slice(0, 8)} нет родителя`);
  }
  const baseDate = git(root, ["log", "-1", "--format=%cI", base]).trim();
  const tree = history.tree(base);

  // Что решение создало и что задело — пути того времени.
  const added = new Set<string>();
  const touched = new Set<string>();
  for (const c of resolved) {
    const parts = git(root, ["show", "--name-status", "-z", "-M", "--format=", c]).split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++] ?? "";
      if (status.startsWith("R") || status.startsWith("C")) {
        const from = parts[i++] ?? "";
        const to = parts[i++] ?? "";
        touched.add(from).add(to);
        if (status.startsWith("C")) added.add(to);
      } else {
        const p = parts[i++] ?? "";
        touched.add(p);
        if (status === "A") added.add(p);
      }
    }
  }

  const plan: SnapshotPlan = { id: t.id, base: base.slice(0, 12), baseDate, files: [], newFiles: [], docs: [], dropped: [] };
  const place = (paths: string[], explicit: boolean, into: string[]) => {
    for (const p of paths) {
      if (explicit) {
        (tree.has(p) ? into : plan.dropped).push(p);
        continue;
      }
      const names = [...history.namesOf(p)];
      const atBase = names.filter((n) => tree.has(n));
      if (atBase.length) into.push(atBase.find((n) => touched.has(n)) ?? (atBase[0] as string));
      else if (names.some((n) => added.has(n))) plan.newFiles.push(names.find((n) => added.has(n)) as string);
      else plan.dropped.push(p);
    }
  };
  place(t.before?.files ?? t.files ?? [], Boolean(t.before?.files), plan.files);
  place([...new Set((t.before?.docs ?? t.docs ?? []).map(docOf))], Boolean(t.before?.docs), plan.docs);
  return plan;
}

function ensureClone(root: string, work: string): void {
  if (fs.existsSync(path.join(work, ".git"))) return;
  if (fs.existsSync(work) && fs.readdirSync(work).length) throw new Error(`каталог для снимков занят и это не копия репозитория: ${work}`);
  fs.mkdirSync(path.dirname(work), { recursive: true });
  execFileSync("git", ["clone", "--shared", "--no-checkout", "-q", root, work], { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Прогон набора на снимках «до задачи». Задачи без `commits` пропускаются. Задачи с общим коммитом-основой
 * меряются на одном снимке; снимки идут по времени, чтобы индекс обновлялся небольшими шагами.
 */
export async function runSnapshotEval(root: string, tasks: EvalTask[], opts: MeasureOptions & { workDir?: string; log?: (msg: string) => void }): Promise<SnapshotRun> {
  const log = opts.log ?? (() => {});
  const work = path.resolve(opts.workDir ?? path.join(root, SNAPSHOT_REL_PATH));
  const history = new HistoryCache(root);
  const skipped: string[] = [];
  const errors: SnapshotRun["errors"] = [];
  const planned: Array<{ task: EvalTask; plan: SnapshotPlan }> = [];
  for (const t of tasks) {
    if (!t.commits?.length) {
      skipped.push(t.id);
      continue;
    }
    try {
      planned.push({ task: t, plan: planSnapshot(history, t) });
    } catch (e) {
      errors.push({ id: t.id, error: (e as Error).message });
    }
  }
  planned.sort((a, b) => a.plan.baseDate.localeCompare(b.plan.baseDate) || a.plan.base.localeCompare(b.plan.base) || a.task.id.localeCompare(b.task.id));

  ensureClone(root, work);
  const registry = await loadRegistry(root);
  // Поиск по смыслу: один поставщик на весь прогон — по конфигу исходного репозитория (скрипт `command` —
  // из его `.mcp/embeddings/`); векторы снимка считаются при его индексации только для изменившихся текстов.
  const settings = loadConfig(root, registry).config.embeddings;
  const embedder = opts.vectors === false ? null : createEmbedder(settings, root);
  const queries = new QueryEmbedder(embedder, settings);
  const rows: SnapshotRow[] = [];
  let current = "";
  try {
    for (const { task, plan } of planned) {
      if (plan.base !== current) {
        const t0 = Date.now();
        git(work, ["-c", "advice.detachedHead=false", "checkout", "-q", "-f", "--detach", plan.base]);
        // Конфиг — текущий, общий и личный: мерится нынешняя настройка.
        for (const rel of [CONFIG_REL_PATH, LOCAL_CONFIG_REL_PATH]) {
          const src = path.join(root, rel);
          const dst = path.join(work, rel);
          if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
          } else fs.rmSync(dst, { force: true });
        }
        const report = await runIndex({ root: work, registry, embedder, embeddings: embedder !== null });
        current = plan.base;
        const emb = report.embeddings ? `; векторов посчитано ${report.embeddings.embedded}${report.embeddings.error ? `, сбой: ${report.embeddings.error}` : ""}` : "";
        log(`снимок ${plan.base} (${plan.baseDate.slice(0, 10)}): разобрано ${report.extracted}, без изменений ${report.unchanged}${emb}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      }
      const store = await openSqliteStore(defaultDbPath(work), { readonly: true });
      try {
        const qv = embedder ? await queries.vector(store, task.task) : null;
        const row = evaluateTask(store, { ...task, files: plan.files, docs: plan.docs }, opts, qv);
        rows.push({ ...row, snapshot: { base: plan.base, date: plan.baseDate, new_files: plan.newFiles, dropped: plan.dropped } });
      } finally {
        store.close();
      }
    }
  } finally {
    await queries.close();
  }
  return { rows, skipped, errors, work };
}
