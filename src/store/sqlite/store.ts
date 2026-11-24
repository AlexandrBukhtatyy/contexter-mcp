import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import picomatch from "picomatch";
import type { CodeRecord, DocumentRecord } from "../../extractors/types.ts";
import type {
  AnalyzedChunk,
  AnalyzedSymbol,
  ApiItemRow,
  ChunkHit,
  ChunkRefRow,
  ChunkRow,
  ChunkSearchOptions,
  CochangeRow,
  CodeKeyRow,
  DocumentRow,
  EntityRow,
  FileRow,
  ImportRow,
  IndexStore,
  KeyRefRow,
  LinkRow,
  ProblemRow,
  RawImportRow,
  SourceRow,
  SymbolHit,
  SymbolRow,
  SymbolSearchOptions,
  TargetKind,
  TaskFileRow,
  TaskRow,
  VectorKind,
  VectorRow,
} from "../types.ts";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

export const INDEX_REL_PATH = ".mcp/cache/index.sqlite";
export const HEADING_SEPARATOR = " › ";

type Row = Record<string, SQLInputValue>;

export interface OpenOptions {
  readonly?: boolean;
  /** Загрузить sqlite-vec, если пакет установлен (по умолчанию да). */
  vectors?: boolean;
}

export class IndexSchemaMismatchError extends Error {}

/** Есть ли миграции от версии до текущей подряд. */
function migrationChain(from: number): boolean {
  for (let v = from; v < SCHEMA_VERSION; v++) if (!MIGRATIONS[v]) return false;
  return true;
}

/** Открывает индекс. Индекс другой версии схемы при записи пересоздаётся, при чтении — ошибка. */
export async function openSqliteStore(dbPath: string, opts: OpenOptions = {}): Promise<SqliteStore> {
  const readonly = opts.readonly ?? false;
  if (readonly && !fs.existsSync(dbPath)) {
    throw new Error(`индекс не найден: ${dbPath}. Соберите его командой \`mcp-context index\``);
  }
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let db = new DatabaseSync(dbPath, { readOnly: readonly, allowExtension: true });
  let version = readSchemaVersion(db);
  const migratable = version !== null && version < SCHEMA_VERSION && migrationChain(version);
  if (migratable && !readonly) {
    // Добавочные изменения схемы — без пересборки индекса (векторы и разбор файлов сохраняются).
    for (let v = version as number; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v] as string);
    db.prepare("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    version = SCHEMA_VERSION;
  }
  if (version !== SCHEMA_VERSION) {
    if (readonly) {
      db.close();
      throw new IndexSchemaMismatchError(
        version === null
          ? `индекс ${dbPath} пуст или повреждён; пересоберите его`
          : migratable
            ? `индекс собран со схемой версии ${version}, сервер ждёт ${SCHEMA_VERSION}; запустите index — индекс обновится без пересборки`
            : `индекс собран со схемой версии ${version}, сервер ждёт ${SCHEMA_VERSION}; пересоберите индекс`,
      );
    }
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
    db = new DatabaseSync(dbPath, { allowExtension: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO index_state (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  const vec = opts.vectors === false ? null : await loadVectorExtension(db);
  db.enableLoadExtension(false);
  return new SqliteStore(db, vec);
}

function readSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare("SELECT value FROM index_state WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  } catch {
    return null;
  }
}

/** sqlite-vec — опциональная зависимость с нативным модулем; без неё сервер работает. */
async function loadVectorExtension(db: DatabaseSync): Promise<string | null> {
  try {
    const mod = (await import("sqlite-vec")) as { getLoadablePath(): string };
    db.loadExtension(mod.getLoadablePath());
    const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    return row.v;
  } catch {
    return null;
  }
}

const json = (v: unknown) => JSON.stringify(v ?? null);
const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return (JSON.parse(v) as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function globToSql(pattern: string): { clause: string; value: string } {
  if (/[*?[]/.test(pattern)) return { clause: "GLOB", value: pattern.replace(/\*\*\/?/g, "*") };
  return { clause: "LIKE", value: `${pattern.replace(/[%_]/g, (m) => `\\${m}`)}%` };
}

export class SqliteStore implements IndexStore {
  private readonly statements = new Map<string, StatementSync>();
  private readonly globCache = new Map<string, (p: string) => boolean>();
  readonly vectorExtension: string | null;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, vectorExtension: string | null) {
    this.db = db;
    this.vectorExtension = vectorExtension;
  }

  close(): void {
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]): { lastInsertRowid: number | bigint } {
    return this.stmt(sql).run(...params);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- источники ----------

  getSource(p: string): SourceRow | null {
    const r = this.get("SELECT * FROM sources WHERE path = ?", p);
    return r ? toSource(r) : null;
  }
  listSources(): SourceRow[] {
    return this.all("SELECT * FROM sources ORDER BY path").map(toSource);
  }
  private insertSource(s: SourceRow): void {
    this.run(
      "INSERT INTO sources (path, kind, extractor, extractor_version, options_hash, hash, rule, error, bytes) VALUES (?,?,?,?,?,?,?,?,?)",
      s.path,
      s.kind,
      s.extractor,
      s.extractorVersion,
      s.optionsHash,
      s.hash,
      s.rule,
      s.error,
      s.bytes,
    );
  }

  removeSource(p: string): void {
    this.run("DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE doc_path = ?)", p);
    this.run("DELETE FROM chunk_refs WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_path = ?)", p);
    this.run("DELETE FROM api_items WHERE doc_path = ?", p);
    this.run("DELETE FROM chunks WHERE doc_path = ?", p);
    this.run("DELETE FROM documents WHERE path = ?", p);
    this.run("DELETE FROM symbols_fts WHERE rowid IN (SELECT rowid FROM symbols WHERE file = ?)", p);
    this.run("DELETE FROM symbols WHERE file = ?", p);
    this.run("DELETE FROM raw_imports WHERE from_file = ?", p);
    this.run("DELETE FROM code_keys WHERE file = ?", p);
    this.run("DELETE FROM data_keys WHERE file = ?", p);
    this.run("DELETE FROM entities WHERE file = ?", p);
    this.run("DELETE FROM files WHERE path = ?", p);
    this.run("DELETE FROM blame_state WHERE path = ?", p);
    this.run("DELETE FROM sources WHERE path = ?", p);
  }

  putSkipped(source: SourceRow): void {
    this.removeSource(source.path);
    this.insertSource(source);
  }

  putDocument(source: SourceRow, doc: DocumentRecord, analyzed: AnalyzedChunk[]): void {
    this.removeSource(source.path);
    this.insertSource(source);
    this.run(
      `INSERT INTO documents (path, title, type, type_hint, status, status_hint, owner, covers, frontmatter, format, hash, extractor, extractor_version, options_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      source.path,
      doc.title,
      doc.type ?? "doc",
      doc.type,
      doc.status,
      doc.status,
      doc.owner,
      json(doc.covers),
      doc.frontmatter ? json(doc.frontmatter) : null,
      doc.format,
      source.hash,
      source.extractor,
      source.extractorVersion,
      source.optionsHash,
    );
    for (const a of analyzed) {
      const c = a.record;
      const res = this.run(
        `INSERT INTO chunks (id, doc_path, heading_path, ordinal, kind, text, line_start, line_end, tokens, hash, extractor)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        c.id,
        source.path,
        c.headingPath.join(HEADING_SEPARATOR),
        c.ordinal,
        c.kind,
        c.text,
        c.lineStart,
        c.lineEnd,
        c.tokens,
        c.hash,
        source.extractor,
      );
      this.run("INSERT INTO chunks_fts (rowid, heading, body) VALUES (?,?,?)", res.lastInsertRowid, a.ftsHeading, a.ftsBody);
      for (const ref of c.refs) {
        this.run("INSERT INTO chunk_refs (chunk_id, kind, value, line) VALUES (?,?,?,?)", c.id, ref.kind, ref.value, ref.line);
      }
      for (const e of c.entities ?? []) {
        this.run("INSERT INTO entities (kind, name, file, line, symbol_id, chunk_id, extractor) VALUES (?,?,?,?,?,?,?)", e.kind, e.name, source.path, e.line, null, c.id, source.extractor);
      }
      if (c.api) {
        this.run(
          "INSERT INTO api_items (chunk_id, doc_path, kind, key, method, path, path_norm, address) VALUES (?,?,?,?,?,?,?,?)",
          c.id,
          source.path,
          c.api.kind,
          c.api.key,
          c.api.method ?? null,
          c.api.path ?? null,
          c.api.path ? normalizeApiPath(c.api.path) : null,
          c.api.address ?? null,
        );
      }
    }
  }

  putCode(source: SourceRow, code: CodeRecord, analyzed: AnalyzedSymbol[]): void {
    this.removeSource(source.path);
    this.insertSource(source);
    this.run(
      `INSERT INTO files (path, lang, unit_name, hash, extractor, extractor_version, options_hash, is_test, generated)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      source.path,
      code.lang,
      code.unitName,
      source.hash,
      source.extractor,
      source.extractorVersion,
      source.optionsHash,
      code.isTest ? 1 : 0,
      code.generated ? 1 : 0,
    );
    code.symbols.forEach((s, i) => {
      const res = this.run(
        `INSERT INTO symbols (id, file, name, qualified, kind, signature, comment, line_start, line_end, exported, is_test, extractor, search_text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.id,
        source.path,
        s.name,
        s.qualified,
        s.kind,
        s.signature,
        s.comment,
        s.lineStart,
        s.lineEnd,
        s.exported ? 1 : 0,
        code.isTest ? 1 : 0,
        source.extractor,
        s.searchText ?? "",
      );
      const a = analyzed[i];
      if (a) {
        this.run("INSERT INTO symbols_fts (rowid, name, signature, comment) VALUES (?,?,?,?)", res.lastInsertRowid, a.ftsName, a.ftsSignature, a.ftsComment);
      }
    });
    for (const imp of code.imports) {
      this.run(
        "INSERT INTO raw_imports (from_file, specifier, names, line, kind, lang) VALUES (?,?,?,?,?,?)",
        source.path,
        imp.specifier,
        json(imp.names),
        imp.line,
        imp.kind,
        code.lang,
      );
    }
    for (const k of code.keys) {
      this.run(
        "INSERT INTO code_keys (file, line, value, context, symbol_id, pattern, extractor) VALUES (?,?,?,?,?,?,?)",
        source.path,
        k.line,
        k.value,
        k.context,
        k.symbolId,
        k.pattern ? 1 : 0,
        source.extractor,
      );
    }
    for (const name of code.dataKeys) this.run("INSERT INTO data_keys (file, name) VALUES (?, ?)", source.path, name);
    const symbolIds = new Set(code.symbols.map((x) => x.id));
    for (const e of code.entities ?? []) {
      const symbolId = e.symbolId && symbolIds.has(e.symbolId) ? e.symbolId : null;
      this.run("INSERT INTO entities (kind, name, file, line, symbol_id, chunk_id, extractor) VALUES (?,?,?,?,?,?,?)", e.kind, e.name, source.path, e.line, symbolId, null, source.extractor);
    }
  }

  // ---------- чтение для шага связывания ----------

  allChunkRefs(): ChunkRefRow[] {
    return this.all("SELECT chunk_id, kind, value, line FROM chunk_refs ORDER BY rowid").map((r) => ({
      chunkId: String(r.chunk_id),
      kind: String(r.kind) as ChunkRefRow["kind"],
      value: String(r.value),
      line: Number(r.line),
    }));
  }
  allChunksLite(): Array<Pick<ChunkRow, "id" | "docPath" | "text" | "lineStart" | "lineEnd" | "kind">> {
    return this.all("SELECT id, doc_path, text, line_start, line_end, kind FROM chunks ORDER BY doc_path, ordinal").map((r) => ({
      id: String(r.id),
      docPath: String(r.doc_path),
      text: String(r.text),
      lineStart: Number(r.line_start),
      lineEnd: Number(r.line_end),
      kind: String(r.kind),
    }));
  }
  allDocuments(): DocumentRow[] {
    return this.all("SELECT * FROM documents ORDER BY path").map(toDocument);
  }
  allFiles(): FileRow[] {
    return this.all("SELECT * FROM files ORDER BY path").map(toFile);
  }
  allSymbols(): SymbolRow[] {
    return this.all("SELECT * FROM symbols ORDER BY file, line_start").map(toSymbol);
  }
  allRawImports(): RawImportRow[] {
    return this.all("SELECT * FROM raw_imports ORDER BY from_file, line").map((r) => ({
      fromFile: String(r.from_file),
      specifier: String(r.specifier),
      names: parseJson<string[]>(r.names, []),
      line: Number(r.line),
      kind: String(r.kind),
      lang: String(r.lang),
    }));
  }
  allCodeKeys(): CodeKeyRow[] {
    return this.all("SELECT * FROM code_keys ORDER BY file, line").map(toCodeKey);
  }
  allEntities(): EntityRow[] {
    return this.all("SELECT * FROM entities ORDER BY kind, name, file, line").map(toEntity);
  }
  entitiesByName(name: string): EntityRow[] {
    return this.all("SELECT * FROM entities WHERE name = ? ORDER BY kind, file, line", name).map(toEntity);
  }
  entitiesInFile(path: string): EntityRow[] {
    return this.all("SELECT * FROM entities WHERE file = ? ORDER BY line", path).map(toEntity);
  }
  entityStats(): Array<{ kind: string; count: number }> {
    return this.all("SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind ORDER BY kind").map((r) => ({ kind: String(r.kind), count: Number(r.n) }));
  }
  dataKeyNames(): Set<string> {
    const rows = this.all("SELECT DISTINCT d.name FROM data_keys d JOIN files f ON f.path = d.file WHERE f.is_test = 0");
    return new Set(rows.map((r) => String(r.name)));
  }
  allApiItems(): ApiItemRow[] {
    return this.all("SELECT * FROM api_items ORDER BY doc_path, chunk_id").map(toApiItem);
  }

  updateDocumentMeta(rows: Array<Pick<DocumentRow, "path" | "type" | "status" | "hidden" | "package">>): void {
    for (const r of rows) {
      this.run("UPDATE documents SET type = ?, status = ?, hidden = ?, package = ? WHERE path = ?", r.type, r.status, r.hidden ? 1 : 0, r.package, r.path);
    }
  }
  updateFileMeta(rows: Array<Pick<FileRow, "path" | "package" | "packageDir" | "unit" | "owner">>): void {
    for (const r of rows) {
      this.run("UPDATE files SET package = ?, package_dir = ?, unit = ?, owner = ? WHERE path = ?", r.package, r.packageDir, r.unit, r.owner, r.path);
    }
  }
  replaceImports(rows: ImportRow[]): void {
    this.run("DELETE FROM imports");
    for (const r of rows) this.run("INSERT INTO imports (from_file, to_file, names, line, kind) VALUES (?,?,?,?,?)", r.fromFile, r.toFile, json(r.names), r.line, r.kind);
  }
  replaceLinks(rows: LinkRow[]): void {
    this.run("DELETE FROM links");
    for (const r of rows) {
      this.run(
        "INSERT INTO links (chunk_id, target_kind, target_id, source, confidence, line, role) VALUES (?,?,?,?,?,?,?)",
        r.chunkId,
        r.targetKind,
        r.targetId,
        r.source,
        r.confidence,
        r.line,
        r.role,
      );
    }
  }
  replaceKeyRefs(rows: KeyRefRow[]): void {
    this.run("DELETE FROM key_refs");
    for (const r of rows) {
      this.run(
        "INSERT INTO key_refs (key, kind, role, file, line, symbol_id, package, confidence, chunk_id) VALUES (?,?,?,?,?,?,?,?,?)",
        r.key,
        r.kind,
        r.role,
        r.file,
        r.line,
        r.symbolId,
        r.package,
        r.confidence,
        r.chunkId,
      );
    }
  }
  replaceProblems(rows: ProblemRow[]): void {
    this.run("DELETE FROM problems");
    for (const r of rows) {
      this.run("INSERT INTO problems (kind, chunk_id, path, line, value, message) VALUES (?,?,?,?,?,?)", r.kind, r.chunkId, r.path, r.line, r.value, r.message);
    }
  }

  // ---------- история ----------

  replaceCochange(rows: CochangeRow[]): void {
    this.run("DELETE FROM cochange");
    for (const r of rows) this.run("INSERT INTO cochange (file_a, file_b, weight) VALUES (?,?,?)", r.fileA, r.fileB, r.weight);
  }
  replaceTasks(rows: TaskRow[], analyze: (text: string) => string): void {
    this.run("DELETE FROM tasks_fts");
    this.run("DELETE FROM tasks");
    for (const r of rows) {
      const res = this.run(
        "INSERT OR REPLACE INTO tasks (id, type, status, title, description, parent, created_at, source) VALUES (?,?,?,?,?,?,?,?)",
        r.id,
        r.type,
        r.status,
        r.title,
        r.description,
        r.parent,
        r.created_at,
        r.source,
      );
      this.run("INSERT INTO tasks_fts (rowid, title, body) VALUES (?,?,?)", res.lastInsertRowid, analyze(r.title), analyze(r.description));
    }
  }
  searchTasks(ftsQuery: string, opts: { limit: number; exclude?: string[]; before?: string | null }): Array<{ task: TaskRow; score: number }> {
    const where = ["tasks_fts MATCH ?"];
    const params: SQLInputValue[] = [ftsQuery];
    if (opts.exclude?.length) {
      where.push(`t.id NOT IN (${opts.exclude.map(() => "?").join(",")})`);
      params.push(...opts.exclude);
    }
    if (opts.before) {
      where.push("t.created_at IS NOT NULL AND t.created_at < ?");
      params.push(opts.before);
    }
    params.push(opts.limit);
    return this.all(
      `SELECT t.*, bm25(tasks_fts, 3.0, 1.0) AS rank FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid WHERE ${where.join(" AND ")} ORDER BY rank, t.id LIMIT ?`,
      ...params,
    ).map((r) => ({ task: toTask(r), score: -Number(r.rank) }));
  }
  replaceTaskFiles(rows: TaskFileRow[]): void {
    this.run("DELETE FROM task_files");
    for (const r of rows) this.run("INSERT INTO task_files (task_id, file, commits) VALUES (?,?,?)", r.taskId, r.file, r.commits);
  }
  getTask(id: string): TaskRow | null {
    const r = this.get("SELECT * FROM tasks WHERE id = ?", id);
    return r ? toTask(r) : null;
  }
  taskFiles(ids: string[]): TaskFileRow[] {
    if (!ids.length) return [];
    return this.all(
      `SELECT task_id, file, commits FROM task_files WHERE task_id IN (${ids.map(() => "?").join(",")}) ORDER BY commits DESC, file`,
      ...ids,
    ).map((r) => ({ taskId: String(r.task_id), file: String(r.file), commits: Number(r.commits) }));
  }
  pathsBySuffix(suffix: string, limit: number): string[] {
    const s = suffix.replace(/^\.?\//, "");
    return this.all(
      "SELECT path FROM sources WHERE kind IN ('document', 'code') AND (path = ? OR path LIKE ? ESCAPE '\\') ORDER BY length(path), path LIMIT ?",
      s,
      `%/${s.replace(/[%_\\]/g, (m) => `\\${m}`)}`,
      limit,
    ).map((r) => String(r.path));
  }
  setFileDates(dates: Map<string, number>): void {
    for (const [p, t] of dates) {
      this.run("UPDATE files SET changed_at = ? WHERE path = ? AND changed_at IS NULL", t, p);
      this.run("UPDATE documents SET changed_at = ? WHERE path = ? AND changed_at IS NULL", t, p);
    }
  }
  applyLineDates(p: string, lineDates: number[]): void {
    const maxIn = (a: number, b: number) => {
      let m = 0;
      for (let i = Math.max(0, a - 1); i < Math.min(lineDates.length, b); i++) m = Math.max(m, lineDates[i] ?? 0);
      return m || null;
    };
    const all = maxIn(1, lineDates.length);
    for (const r of this.all("SELECT rowid, line_start, line_end FROM chunks WHERE doc_path = ?", p)) {
      this.run("UPDATE chunks SET changed_at = ? WHERE rowid = ?", maxIn(Number(r.line_start), Number(r.line_end)), r.rowid ?? null);
    }
    for (const r of this.all("SELECT rowid, line_start, line_end FROM symbols WHERE file = ?", p)) {
      this.run("UPDATE symbols SET changed_at = ? WHERE rowid = ?", maxIn(Number(r.line_start), Number(r.line_end)), r.rowid ?? null);
    }
    this.run("UPDATE documents SET changed_at = ? WHERE path = ?", all, p);
    this.run("UPDATE files SET changed_at = ? WHERE path = ?", all, p);
  }
  filesNeedingBlame(): string[] {
    return this.all(
      `SELECT s.path FROM sources s LEFT JOIN blame_state b ON b.path = s.path
       WHERE s.kind IN ('document', 'code') AND (b.hash IS NULL OR b.hash != s.hash) ORDER BY s.path`,
    ).map((r) => String(r.path));
  }
  markBlamed(p: string, hash: string): void {
    this.run("INSERT INTO blame_state (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash", p, hash);
  }

  setState(key: string, value: string): void {
    this.run("INSERT INTO index_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // ---------- векторы ----------

  /** Матрицы векторов по виду и метке — для поиска ближайших; сбрасываются при записи. */
  private readonly vectorCache = new Map<string, { ids: string[]; dim: number; mat: Float32Array }>();

  vectorHashes(kind: VectorKind): Map<string, { hash: string; label: string }> {
    const out = new Map<string, { hash: string; label: string }>();
    for (const r of this.all("SELECT id, hash, label FROM vectors WHERE kind = ?", kind)) out.set(String(r.id), { hash: String(r.hash), label: String(r.label) });
    return out;
  }
  putVectors(rows: VectorRow[]): void {
    for (const r of rows) {
      this.run(
        "INSERT INTO vectors (kind, id, hash, label, dim, vec) VALUES (?,?,?,?,?,?) ON CONFLICT(kind, id) DO UPDATE SET hash = excluded.hash, label = excluded.label, dim = excluded.dim, vec = excluded.vec",
        r.kind,
        r.id,
        r.hash,
        r.label,
        r.vec.length,
        new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength),
      );
    }
    this.vectorCache.clear();
  }
  deleteVectors(kind: VectorKind, ids: string[]): void {
    for (const id of ids) this.run("DELETE FROM vectors WHERE kind = ? AND id = ?", kind, id);
    this.vectorCache.clear();
  }
  vectorStats(): Array<{ kind: VectorKind; label: string; dim: number; count: number }> {
    return this.all("SELECT kind, label, dim, COUNT(*) AS n FROM vectors GROUP BY kind, label, dim ORDER BY kind, n DESC").map((r) => ({
      kind: String(r.kind) as VectorKind,
      label: String(r.label),
      dim: Number(r.dim),
      count: Number(r.n),
    }));
  }
  nearestVectors(kind: VectorKind, label: string, query: Float32Array, limit: number): Array<{ id: string; score: number }> {
    const key = `${kind}\u0000${label}`;
    let m = this.vectorCache.get(key);
    if (!m) {
      const rows = this.all("SELECT id, dim, vec FROM vectors WHERE kind = ? AND label = ? ORDER BY id", kind, label);
      const dim = rows.length ? Number(rows[0]?.dim) : query.length;
      const usable = rows.filter((r) => Number(r.dim) === dim);
      const mat = new Float32Array(usable.length * dim);
      usable.forEach((r, i) => {
        const b = r.vec as Uint8Array;
        mat.set(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), i * dim);
      });
      m = { ids: usable.map((r) => String(r.id)), dim, mat };
      this.vectorCache.set(key, m);
    }
    if (m.dim !== query.length || !m.ids.length) return [];
    // Перебор: на десятках тысяч векторов это миллисекунды; держим только лучшие `limit`.
    const best: Array<{ i: number; s: number }> = [];
    const { mat, dim } = m;
    for (let i = 0, off = 0; i < m.ids.length; i++, off += dim) {
      let s = 0;
      for (let j = 0; j < dim; j++) s += (mat[off + j] as number) * (query[j] as number);
      if (best.length < limit) {
        best.push({ i, s });
        if (best.length === limit) best.sort((a, b) => b.s - a.s);
      } else if (s > (best[limit - 1] as { s: number }).s) {
        let k = limit - 1;
        while (k > 0 && (best[k - 1] as { s: number }).s < s) k--;
        best.splice(k, 0, { i, s });
        best.pop();
      }
    }
    if (best.length < limit) best.sort((a, b) => b.s - a.s);
    return best.map((b) => ({ id: m.ids[b.i] as string, score: Math.round(b.s * 10000) / 10000 }));
  }

  // ---------- чтение для сервера ----------

  getState(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.all("SELECT key, value FROM index_state ORDER BY key")) out[String(r.key)] = String(r.value);
    return out;
  }
  sourceStats(): Array<{ kind: string; extractor: string | null; count: number }> {
    return this.all("SELECT kind, extractor, COUNT(*) AS n FROM sources GROUP BY kind, extractor ORDER BY kind, extractor").map((r) => ({
      kind: String(r.kind),
      extractor: str(r.extractor),
      count: Number(r.n),
    }));
  }
  erroredSources(limit: number): SourceRow[] {
    return this.all("SELECT * FROM sources WHERE kind = 'error' ORDER BY path LIMIT ?", limit).map(toSource);
  }

  searchChunks(ftsQuery: string, opts: ChunkSearchOptions): ChunkHit[] {
    const where: string[] = ["chunks_fts MATCH ?"];
    const params: SQLInputValue[] = [ftsQuery];
    if (!opts.includeHidden) where.push("d.hidden = 0");
    if (opts.types?.length) {
      where.push(`d.type IN (${opts.types.map(() => "?").join(",")})`);
      params.push(...opts.types);
    }
    if (opts.path) {
      const g = globToSql(opts.path);
      where.push(`c.doc_path ${g.clause} ?${g.clause === "LIKE" ? " ESCAPE '\\'" : ""}`);
      params.push(g.value);
    }
    params.push(opts.limit);
    const rows = this.all(
      `SELECT c.*, d.path AS d_path, d.title AS d_title, d.type AS d_type, d.status AS d_status, d.type_hint AS d_type_hint,
              d.status_hint AS d_status_hint, d.owner AS d_owner, d.covers AS d_covers, d.format AS d_format, d.hidden AS d_hidden,
              d.package AS d_package, d.changed_at AS d_changed_at, bm25(chunks_fts, 3.0, 1.0) AS rank
       FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN documents d ON d.path = c.doc_path
       WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
      ...params,
    );
    return rows.map((r) => ({
      chunk: toChunk(r),
      doc: toDocument({
        path: r.d_path ?? null,
        title: r.d_title ?? null,
        type: r.d_type ?? null,
        status: r.d_status ?? null,
        type_hint: r.d_type_hint ?? null,
        status_hint: r.d_status_hint ?? null,
        owner: r.d_owner ?? null,
        covers: r.d_covers ?? null,
        frontmatter: null,
        format: r.d_format ?? null,
        hidden: r.d_hidden ?? null,
        package: r.d_package ?? null,
        changed_at: r.d_changed_at ?? null,
      }),
      score: -Number(r.rank),
    }));
  }
  getChunk(id: string): ChunkRow | null {
    const r = this.get("SELECT * FROM chunks WHERE id = ?", id);
    return r ? toChunk(r) : null;
  }
  getDocument(p: string): DocumentRow | null {
    const r = this.get("SELECT * FROM documents WHERE path = ?", p);
    return r ? toDocument(r) : null;
  }
  documentChunks(p: string): ChunkRow[] {
    return this.all("SELECT * FROM chunks WHERE doc_path = ? ORDER BY ordinal", p).map(toChunk);
  }
  listDocuments(): DocumentRow[] {
    return this.allDocuments();
  }
  apiItemsByEndpoint(method: string, pathNorm: string): ApiItemRow[] {
    return this.all("SELECT * FROM api_items WHERE method = ? AND path_norm = ?", method.toUpperCase(), pathNorm).map(toApiItem);
  }
  apiItemByChunk(chunkId: string): ApiItemRow | null {
    const r = this.get("SELECT * FROM api_items WHERE chunk_id = ?", chunkId);
    return r ? toApiItem(r) : null;
  }
  apiItemsByKey(kind: string, key: string): ApiItemRow[] {
    return this.all("SELECT * FROM api_items WHERE kind = ? AND key = ?", kind, key).map(toApiItem);
  }

  searchSymbols(ftsQuery: string, opts: SymbolSearchOptions): SymbolHit[] {
    const where: string[] = ["symbols_fts MATCH ?"];
    const params: SQLInputValue[] = [ftsQuery];
    if (!opts.includeTests) where.push("s.is_test = 0");
    if (opts.kinds?.length) {
      where.push(`s.kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    if (opts.path) {
      const g = globToSql(opts.path);
      where.push(`s.file ${g.clause} ?${g.clause === "LIKE" ? " ESCAPE '\\'" : ""}`);
      params.push(g.value);
    }
    params.push(opts.limit);
    // Тесты и неэкспортируемые символы опускаются в выдаче: bm25 отрицателен, множитель меньше 1 ухудшает место.
    const rows = this.all(
      `SELECT s.*, bm25(symbols_fts, 4.0, 1.0, 1.0) * (CASE WHEN s.is_test = 1 THEN 0.4 ELSE 1.0 END)
              * (CASE WHEN s.exported = 1 THEN 1.0 ELSE 0.8 END) AS rank
       FROM symbols_fts JOIN symbols s ON s.rowid = symbols_fts.rowid
       WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
      ...params,
    );
    return rows.map((r) => ({ symbol: toSymbol(r), score: -Number(r.rank) }));
  }
  symbolsByName(name: string): SymbolRow[] {
    return this.all("SELECT * FROM symbols WHERE name = ? OR qualified = ? ORDER BY is_test, file, line_start", name, name).map(toSymbol);
  }
  getSymbol(id: string): SymbolRow | null {
    const r = this.get("SELECT * FROM symbols WHERE id = ?", id);
    return r ? toSymbol(r) : null;
  }
  symbolsInFile(p: string): SymbolRow[] {
    return this.all("SELECT * FROM symbols WHERE file = ? ORDER BY line_start", p).map(toSymbol);
  }
  getFile(p: string): FileRow | null {
    const r = this.get("SELECT * FROM files WHERE path = ?", p);
    return r ? toFile(r) : null;
  }
  filesInDir(dir: string): FileRow[] {
    const prefix = dir ? `${dir}/` : "";
    return this.all("SELECT * FROM files WHERE path LIKE ? ESCAPE '\\' AND instr(substr(path, ?), '/') = 0 ORDER BY path", `${prefix.replace(/[%_]/g, (m) => `\\${m}`)}%`, prefix.length + 1).map(toFile);
  }

  linksFromChunk(chunkId: string): LinkRow[] {
    return this.all("SELECT * FROM links WHERE chunk_id = ? ORDER BY line, target_kind, target_id", chunkId).map(toLink);
  }
  linksFromDoc(docPath: string): LinkRow[] {
    return this.all(
      "SELECT l.* FROM links l JOIN chunks c ON c.id = l.chunk_id WHERE c.doc_path = ? ORDER BY c.ordinal, l.line",
      docPath,
    ).map(toLink);
  }
  linksTo(kind: TargetKind, id: string): LinkRow[] {
    return this.all("SELECT * FROM links WHERE target_kind = ? AND target_id = ? ORDER BY chunk_id, line", kind, id).map(toLink);
  }
  linksToFile(p: string): LinkRow[] {
    const out = this.all(
      `SELECT * FROM links WHERE target_kind = 'file' AND target_id = ?
       UNION ALL SELECT * FROM links WHERE target_kind = 'symbol' AND target_id IN (SELECT id FROM symbols WHERE file = ?)
       UNION ALL SELECT * FROM links WHERE target_kind = 'dir' AND (? LIKE target_id || '/%' OR target_id = '')`,
      p,
      p,
      p,
    ).map(toLink);
    for (const r of this.all("SELECT * FROM links WHERE target_kind = 'glob'")) {
      const pattern = String(r.target_id);
      let m = this.globCache.get(pattern);
      if (!m) {
        m = picomatch(pattern, { dot: true });
        this.globCache.set(pattern, m);
      }
      if (m(p)) out.push(toLink(r));
    }
    return out;
  }
  importsFrom(file: string): ImportRow[] {
    return this.all("SELECT * FROM imports WHERE from_file = ? ORDER BY line, to_file", file).map(toImport);
  }
  importsTo(file: string): ImportRow[] {
    return this.all("SELECT * FROM imports WHERE to_file = ? ORDER BY from_file, line", file).map(toImport);
  }
  filesImportingName(name: string): string[] {
    const like = `%${JSON.stringify(name).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.all("SELECT from_file, names FROM raw_imports WHERE kind != 'export' AND names LIKE ? ESCAPE '\\' ORDER BY from_file", like);
    return [...new Set(rows.filter((r) => parseJson<string[]>(r.names, []).includes(name)).map((r) => String(r.from_file)))];
  }
  cochange(file: string, limit: number): CochangeRow[] {
    return this.all(
      `SELECT file_b AS other, weight FROM cochange WHERE file_a = ?
       UNION ALL SELECT file_a AS other, weight FROM cochange WHERE file_b = ?
       ORDER BY weight DESC, other LIMIT ?`,
      file,
      file,
      limit,
    ).map((r) => ({ fileA: file, fileB: String(r.other), weight: Number(r.weight) }));
  }
  keyRefsByFile(file: string): KeyRefRow[] {
    return this.all("SELECT * FROM key_refs WHERE file = ? ORDER BY line", file).map(toKeyRef);
  }
  keyRefsByChunk(chunkId: string): KeyRefRow[] {
    return this.all("SELECT * FROM key_refs WHERE chunk_id = ? ORDER BY role, file, line", chunkId).map(toKeyRef);
  }
  keyRefStats(): Array<{ kind: string; confidence: string; count: number }> {
    return this.all("SELECT kind, confidence, COUNT(*) AS n FROM key_refs GROUP BY kind, confidence ORDER BY kind, confidence").map((r) => ({
      kind: String(r.kind),
      confidence: String(r.confidence),
      count: Number(r.n),
    }));
  }
  problems(kind?: string): ProblemRow[] {
    const rows = kind
      ? this.all("SELECT * FROM problems WHERE kind = ? ORDER BY path, line", kind)
      : this.all("SELECT * FROM problems ORDER BY kind, path, line");
    return rows.map((r) => ({
      kind: String(r.kind),
      chunkId: str(r.chunk_id),
      path: String(r.path),
      line: num(r.line),
      value: String(r.value),
      message: String(r.message),
    }));
  }
  allLinks(): LinkRow[] {
    return this.all("SELECT * FROM links ORDER BY chunk_id, line").map(toLink);
  }
  chunkDates(): Map<string, { docPath: string; changedAt: number | null; kind: string }> {
    const out = new Map<string, { docPath: string; changedAt: number | null; kind: string }>();
    for (const r of this.all("SELECT id, doc_path, changed_at, kind FROM chunks")) {
      out.set(String(r.id), { docPath: String(r.doc_path), changedAt: num(r.changed_at), kind: String(r.kind) });
    }
    return out;
  }
  problemStats(): Array<{ kind: string; count: number }> {
    return this.all("SELECT kind, COUNT(*) AS n FROM problems GROUP BY kind ORDER BY kind").map((r) => ({ kind: String(r.kind), count: Number(r.n) }));
  }
}

/** Путь операции без имён параметров: `/users/{id}` и `/users/:userId` → `/users/{}`. */
export function normalizeApiPath(p: string): string {
  let out = p.trim().replace(/[?#].*$/, "");
  out = out.replace(/\{[^}/]*\}/g, "{}").replace(/:[A-Za-z_][\w-]*/g, "{}");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out.toLowerCase();
}

function toTask(r: Row): TaskRow {
  return {
    id: String(r.id),
    type: str(r.type),
    status: str(r.status),
    title: String(r.title),
    description: String(r.description),
    parent: str(r.parent),
    created_at: str(r.created_at),
    source: str(r.source),
  };
}

function toSource(r: Row): SourceRow {
  return {
    path: String(r.path),
    kind: String(r.kind),
    extractor: str(r.extractor),
    extractorVersion: num(r.extractor_version),
    optionsHash: str(r.options_hash),
    hash: String(r.hash),
    rule: str(r.rule),
    error: str(r.error),
    bytes: Number(r.bytes ?? 0),
  };
}
function toDocument(r: Row): DocumentRow {
  return {
    path: String(r.path),
    title: String(r.title ?? ""),
    type: String(r.type ?? "doc"),
    status: str(r.status),
    typeHint: str(r.type_hint),
    statusHint: str(r.status_hint),
    owner: str(r.owner),
    covers: parseJson<string[]>(r.covers, []),
    frontmatter: parseJson<Record<string, unknown> | null>(r.frontmatter, null),
    format: String(r.format ?? "markdown"),
    hidden: Number(r.hidden ?? 0) === 1,
    package: str(r.package),
    changedAt: num(r.changed_at),
  };
}
function toChunk(r: Row): ChunkRow {
  return {
    id: String(r.id),
    docPath: String(r.doc_path),
    headingPath: String(r.heading_path).split(HEADING_SEPARATOR).filter(Boolean),
    ordinal: Number(r.ordinal),
    kind: String(r.kind),
    text: String(r.text),
    lineStart: Number(r.line_start),
    lineEnd: Number(r.line_end),
    tokens: Number(r.tokens),
    hash: String(r.hash),
    changedAt: num(r.changed_at),
  };
}
function toFile(r: Row): FileRow {
  return {
    path: String(r.path),
    lang: String(r.lang),
    package: str(r.package),
    packageDir: str(r.package_dir),
    unit: str(r.unit),
    unitName: str(r.unit_name),
    owner: str(r.owner),
    isTest: Number(r.is_test) === 1,
    generated: Number(r.generated) === 1,
    changedAt: num(r.changed_at),
  };
}
function toSymbol(r: Row): SymbolRow {
  return {
    id: String(r.id),
    file: String(r.file),
    name: String(r.name),
    qualified: String(r.qualified),
    kind: String(r.kind),
    signature: String(r.signature),
    comment: String(r.comment),
    lineStart: Number(r.line_start),
    lineEnd: Number(r.line_end),
    exported: Number(r.exported) === 1,
    isTest: Number(r.is_test) === 1,
    changedAt: num(r.changed_at),
    searchText: String(r.search_text ?? ""),
  };
}
function toLink(r: Row): LinkRow {
  return {
    chunkId: String(r.chunk_id),
    targetKind: String(r.target_kind) as TargetKind,
    targetId: String(r.target_id),
    source: String(r.source),
    confidence: String(r.confidence) as LinkRow["confidence"],
    line: num(r.line),
    role: str(r.role),
  };
}
function toImport(r: Row): ImportRow {
  return { fromFile: String(r.from_file), toFile: String(r.to_file), names: parseJson<string[]>(r.names, []), line: Number(r.line), kind: String(r.kind) };
}
function toCodeKey(r: Row): CodeKeyRow {
  return {
    file: String(r.file),
    line: Number(r.line),
    value: String(r.value),
    context: String(r.context),
    symbolId: str(r.symbol_id),
    pattern: Number(r.pattern) === 1,
  };
}
function toEntity(r: Row): EntityRow {
  return { kind: String(r.kind), name: String(r.name), file: String(r.file), line: Number(r.line), symbolId: str(r.symbol_id), chunkId: str(r.chunk_id) };
}
function toApiItem(r: Row): ApiItemRow {
  const out: ApiItemRow = {
    chunkId: String(r.chunk_id),
    docPath: String(r.doc_path),
    kind: String(r.kind),
    key: String(r.key),
    pathNorm: str(r.path_norm),
  };
  if (r.method) out.method = String(r.method);
  if (r.path) out.path = String(r.path);
  if (r.address) out.address = String(r.address);
  return out;
}
function toKeyRef(r: Row): KeyRefRow {
  return {
    key: String(r.key),
    kind: String(r.kind),
    role: String(r.role),
    file: String(r.file),
    line: Number(r.line),
    symbolId: str(r.symbol_id),
    package: str(r.package),
    confidence: String(r.confidence),
    chunkId: str(r.chunk_id),
  };
}
