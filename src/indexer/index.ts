import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import { runEmbeddings, type EmbeddingStats } from "../embeddings/index-vectors.ts";
import { createEmbedder, type Embedder } from "../embeddings/provider.ts";
import { createKit, loadRegistry, type AnyExtractor } from "../extractors/registry.ts";
import type { CodeRecord, DocumentRecord, ExtractResult, SourceFile } from "../extractors/types.ts";
import { gitHead, readCommits, runHistory, type HistoryStats } from "../links/history.ts";
import { runLinking, type LinkStats } from "../links/link.ts";
import { ProjectInfo } from "../links/project.ts";
import { analyzeForIndex } from "../search/analyze.ts";
import { INDEX_REL_PATH, openSqliteStore } from "../store/sqlite/store.ts";
import type { AnalyzedChunk, AnalyzedSymbol, IndexStore, SourceRow } from "../store/types.ts";
import { normalizeText, sha256 } from "../util/text.ts";
import { isBinaryPath, listPackageFiles, listRepoFiles, looksBinary } from "./files.ts";
import type { ContextSettings } from "../context/settings.ts";
import { selectExtractor } from "./select.ts";
import { loadTaskSources } from "../tasks/load.ts";

export interface IndexOptions {
  root: string;
  /** Путь индекса; по умолчанию `.mcp/cache/index.sqlite` в корне репозитория. */
  dbPath?: string;
  /** Пересобрать всё, игнорируя хэши. */
  full?: boolean;
  log?: (msg: string) => void;
  registry?: Map<string, AnyExtractor>;
  /** false — не считать векторы в этом прогоне (посчитанные остаются). */
  embeddings?: boolean;
  /** Готовый поставщик векторов вместо создаваемого по конфигу (замер на снимках держит один на весь прогон). */
  embedder?: Embedder | null;
}

export interface IndexReport {
  files: number;
  extracted: number;
  unchanged: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  removed: number;
  link: LinkStats;
  history: HistoryStats;
  /** null — поиск по смыслу выключен в конфиге или в этом прогоне. */
  embeddings: EmbeddingStats | null;
  ms: number;
  dbPath: string;
}

export function defaultDbPath(root: string): string {
  return path.join(root, INDEX_REL_PATH);
}

export async function runIndex(opts: IndexOptions): Promise<IndexReport> {
  const t0 = Date.now();
  const root = path.resolve(opts.root);
  const log = opts.log ?? (() => {});
  const registry = opts.registry ?? (await loadRegistry(root));
  const loaded = loadConfig(root, registry);
  const dbPath = opts.dbPath ?? defaultDbPath(root);
  const store = await openSqliteStore(dbPath);
  try {
    return await indexWithStore(store, root, loaded, registry, opts, log, t0, dbPath);
  } finally {
    store.close();
  }
}

async function indexWithStore(
  store: IndexStore,
  root: string,
  loaded: LoadedConfig,
  registry: Map<string, AnyExtractor>,
  opts: IndexOptions,
  log: (msg: string) => void,
  t0: number,
  dbPath: string,
): Promise<IndexReport> {
  const config = loaded.config;
  const kit = createKit(registry, config);
  // Все файлы репозитория нужны для проверки ссылок: файл, исключённый из индекса, всё равно существует.
  const repoPaths = listRepoFiles(root, []);
  const excluded = config.exclude.length ? picomatch(config.exclude, { dot: true }) : null;
  // Внешние пакеты (документация и типы библиотек из node_modules) — сверх файлов репозитория.
  const pkgs = listPackageFiles(root, config.packages);
  for (const m of pkgs.missing) log(`пакет не найден: ${m}`);
  const allPaths = [...repoPaths, ...pkgs.files];
  const paths = [...(excluded ? repoPaths.filter((p) => !excluded(p)) : repoPaths), ...pkgs.files];
  const fileSet = new Set(paths);
  log(`файлов в репозитории: ${repoPaths.length}${pkgs.files.length ? `, во внешних пакетах: ${pkgs.files.length}` : ""}`);

  const existing = new Map(store.listSources().map((s) => [s.path, s]));
  let extracted = 0;
  let unchanged = 0;
  let skipped = 0;
  const errors: Array<{ path: string; error: string }> = [];
  const indexed = new Set<string>();

  const BATCH = 200;
  let pending: Array<() => void> = [];
  const flush = () => {
    if (!pending.length) return;
    const work = pending;
    pending = [];
    store.transaction(() => work.forEach((w) => w()));
  };

  for (const rel of paths) {
    const abs = path.join(root, rel);
    const prev = existing.get(rel);
    if (isBinaryPath(rel)) {
      if (prev?.kind !== "skip" || prev.rule !== "двоичный файл") {
        pending.push(() => store.putSkipped(skipRow(rel, "-", "двоичный файл", 0)));
      }
      skipped++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      errors.push({ path: rel, error: (e as Error).message });
      continue;
    }
    if (buf.length > config.max_file_bytes || looksBinary(buf)) {
      const reason = buf.length > config.max_file_bytes ? `больше ${config.max_file_bytes} байт` : "двоичный файл";
      pending.push(() => store.putSkipped(skipRow(rel, "-", reason, buf.length)));
      skipped++;
      continue;
    }
    const text = normalizeText(buf.toString("utf8"));
    const hash = sha256(text);
    const sel = selectExtractor({ path: rel, text }, loaded, registry);
    if (!sel) {
      if (!prev || prev.kind !== "skip" || prev.hash !== hash) pending.push(() => store.putSkipped(skipRow(rel, hash, "нет экстрактора для этого файла", buf.length)));
      skipped++;
      continue;
    }
    const source: SourceRow = {
      path: rel,
      kind: "pending",
      extractor: sel.extractor.name,
      extractorVersion: sel.extractor.version,
      optionsHash: sel.optionsHash,
      hash,
      rule: sel.reason,
      error: null,
      bytes: buf.length,
    };
    const same =
      !opts.full &&
      prev &&
      prev.kind !== "error" &&
      prev.hash === hash &&
      prev.extractor === source.extractor &&
      prev.extractorVersion === source.extractorVersion &&
      prev.optionsHash === source.optionsHash;
    if (same) {
      if (prev.kind === "document" || prev.kind === "code") indexed.add(rel);
      else skipped++;
      unchanged++;
      continue;
    }
    let result: ExtractResult;
    try {
      result = await sel.extractor.extract({ path: rel, text, hash } satisfies SourceFile, sel.options, kit);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      errors.push({ path: rel, error: message });
      pending.push(() => store.putSkipped({ ...source, kind: "error", error: message }));
      continue;
    }
    extracted++;
    if (result.kind === "document") {
      indexed.add(rel);
      const doc = result.document;
      pending.push(() => store.putDocument({ ...source, kind: "document" }, doc, analyzeChunks(doc)));
    } else if (result.kind === "code") {
      indexed.add(rel);
      const code = result.code;
      pending.push(() => store.putCode({ ...source, kind: "code" }, code, analyzeSymbols(code, rel)));
    } else {
      skipped++;
      pending.push(() => store.putSkipped({ ...source, kind: "skip", rule: `${source.rule}: ${result.reason}` }));
    }
    if (pending.length >= BATCH) flush();
  }
  flush();

  let removed = 0;
  store.transaction(() => {
    for (const p of existing.keys()) {
      if (!fileSet.has(p)) {
        store.removeSource(p);
        removed++;
      }
    }
  });
  log(`разобрано: ${extracted}, без изменений: ${unchanged}, пропущено: ${skipped}, удалено: ${removed}, ошибок: ${errors.length}`);

  const project = new ProjectInfo(root, new Set(allPaths));
  const link = store.transaction(() => runLinking(store, project, config));
  log(`связи: ${link.links}, импорты: ${link.imports}, ключи: ${link.keyRefs}, проблемы: ${link.problems} (${link.ms} мс)`);

  // История git: один проход `git log` — для совместных правок, дат и задач.
  const commits = readCommits(root, config);
  const history = await runHistory(store, root, config, indexed, commits);
  if (history.commits) {
    log(`история: коммитов ${history.commits}, пар совместных правок ${history.cochangePairs}, blame ${history.blamed} файлов (${history.ms} мс)`);
  }

  // Задачи из всех источников (трекер, файл задач, свой адаптер, git) и связь «задача → файлы».
  const tasks = await loadTaskSources(root, config, commits, indexed, log);
  store.transaction(() => {
    store.replaceTasks(tasks.tasks, analyzeForIndex);
    store.replaceTaskFiles(tasks.taskFiles);
  });
  if (tasks.tasks.length) {
    const bySource = tasks.sources.map((s) => `${s.name} ${s.tasks}`).join(", ");
    log(
      `задачи: ${bySource}${tasks.changes ? `, изменений без номера ${tasks.changes}` : ""}; связей «задача → файл» ${tasks.taskFiles.length}; ` +
        `номер задачи — ${tasks.idPattern ? `${tasks.idPatternFrom === "config" ? "из конфига" : tasks.idPatternFrom === "tracker" ? "по ID трекера" : "найден в коммитах"}: ${tasks.idPattern}` : "не найден"}`,
    );
  }

  // Векторы для поиска по смыслу: только новые и изменившиеся тексты.
  let embeddings: EmbeddingStats | null = null;
  if (opts.embeddings !== false && config.embeddings.provider !== "none") {
    const own = opts.embedder === undefined;
    const embedder = own ? createEmbedder(config.embeddings, root) : opts.embedder;
    if (embedder) {
      try {
        embeddings = await runEmbeddings(store, embedder, config.embeddings, log);
      } finally {
        if (own) await embedder.close();
      }
      log(
        `эмбеддинги: разделов ${embeddings.chunks}, символов ${embeddings.symbols}; посчитано ${embeddings.embedded}, без изменений ${embeddings.reused}, удалено ${embeddings.removed} (${embeddings.ms} мс)` +
          (embeddings.error ? `; сбой: ${embeddings.error}` : ""),
      );
    }
  }

  const head = gitHead(root);
  const ms = Date.now() - t0;
  store.transaction(() => {
    store.setState("commit", head.commit ?? "");
    store.setState("branch", head.branch ?? "");
    store.setState("dirty", head.dirty === null ? "" : String(head.dirty));
    store.setState("built_at", new Date().toISOString());
    store.setState("config_hash", loaded.hash);
    store.setState("config_file", loaded.file ?? "");
    store.setState("root", root);
    store.setState("vector_extension", store.vectorExtension ?? "");
    store.setState("last_run_ms", String(ms));
    store.setState("last_run_extracted", String(extracted));
    // Настройки сборки контекста: сервер читает их из индекса и не зависит от конфига на диске.
    store.setState(
      "context_settings",
      JSON.stringify({
        ...config.context,
        id_refs: config.documents.id_refs,
        task_id_pattern: tasks.idPattern,
        entity_titles: Object.fromEntries(Object.entries(config.entities).flatMap(([k, v]) => (v.title ? [[k, v.title]] : []))),
      } satisfies ContextSettings),
    );
    // Поиск по смыслу: что настроено и чем кончился последний прогон. Адрес и заголовки сервиса не пишутся.
    const e = config.embeddings;
    store.setState(
      "embeddings",
      JSON.stringify({
        provider: e.provider,
        model: e.model ?? null,
        targets: e.targets,
        ...(embeddings ? { label: embeddings.label, chunks: embeddings.chunks, symbols: embeddings.symbols, error: embeddings.error ?? null } : {}),
      }),
    );
    // Задачи: откуда и сколько, шаблон номера задачи и откуда он взят.
    store.setState(
      "tasks",
      JSON.stringify({ sources: Object.fromEntries(tasks.sources.map((s) => [s.name, s.tasks])), errors: Object.fromEntries(tasks.sources.filter((s) => s.error).map((s) => [s.name, s.error])), changes: tasks.changes, id_pattern: tasks.idPattern, id_pattern_from: tasks.idPatternFrom, task_files: tasks.taskFiles.length }),
    );
  });
  return { files: paths.length, extracted, unchanged, skipped, errors, removed, link, history, embeddings, ms, dbPath };
}

function skipRow(rel: string, hash: string, reason: string, bytes: number): SourceRow {
  return { path: rel, kind: "skip", extractor: null, extractorVersion: null, optionsHash: null, hash, rule: reason, error: null, bytes };
}

export function analyzeChunks(doc: DocumentRecord): AnalyzedChunk[] {
  return doc.chunks.map((c) => ({
    record: c,
    ftsHeading: analyzeForIndex(c.headingPath.join(" ")),
    // searchText дополняет text; searchOnly — только он (контракты: сырой YAML полон служебных ключей).
    ftsBody: analyzeForIndex(!c.searchText ? c.text : c.searchOnly ? c.searchText : `${c.text}\n${c.searchText}`),
  }));
}

export function analyzeSymbols(code: CodeRecord, filePath: string): AnalyzedSymbol[] {
  const pathWords = filePath.replace(/\.[^.]+$/, "");
  return code.symbols.map((s) => ({
    ftsName: analyzeForIndex(`${s.qualified} ${s.name}`),
    ftsSignature: analyzeForIndex(`${s.signature} ${pathWords}`),
    ftsComment: analyzeForIndex(s.searchText ? `${s.comment}\n${s.searchText}` : s.comment),
  }));
}
