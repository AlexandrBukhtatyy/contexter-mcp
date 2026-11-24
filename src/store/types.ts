/**
 * Интерфейсы хранилища индекса. Весь SQL живёт в `src/store/sqlite/`; остальной код работает
 * только с этими интерфейсами, чтобы хранилище можно было заменить (например, на графовую БД).
 */
import type { ApiItemRecord, ChunkRecord, CodeRecord, DocumentRecord, RefRecord } from "../extractors/types.ts";

export interface SourceRow {
  path: string;
  /** document | code | skip | error */
  kind: string;
  extractor: string | null;
  extractorVersion: number | null;
  optionsHash: string | null;
  hash: string;
  /** Чем выбран экстрактор: «правило 3 (строка 12)», «по расширению .md», «поле extractor в шапке». */
  rule: string | null;
  error: string | null;
  bytes: number;
}

export interface DocumentRow {
  path: string;
  title: string;
  type: string;
  status: string | null;
  /** Тип и статус из шапки; итоговые `type` и `status` считает шаг связывания с учётом конфига. */
  typeHint: string | null;
  statusHint: string | null;
  owner: string | null;
  covers: string[];
  frontmatter: Record<string, unknown> | null;
  format: string;
  hidden: boolean;
  package: string | null;
  changedAt: number | null;
}

export interface ChunkRow {
  id: string;
  docPath: string;
  headingPath: string[];
  ordinal: number;
  kind: string;
  text: string;
  lineStart: number;
  lineEnd: number;
  tokens: number;
  hash: string;
  changedAt: number | null;
}

export interface FileRow {
  path: string;
  lang: string;
  package: string | null;
  packageDir: string | null;
  /** Go: путь импорта пакета; TS: имя пакета из package.json. */
  unit: string | null;
  /** Go: имя из `package`. */
  unitName: string | null;
  owner: string | null;
  isTest: boolean;
  generated: boolean;
  changedAt: number | null;
}

export interface SymbolRow {
  id: string;
  file: string;
  name: string;
  qualified: string;
  kind: string;
  signature: string;
  comment: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  isTest: boolean;
  changedAt: number | null;
  /** Видимые тексты символа (подписи JSX, сообщения) — для поиска по смыслу. */
  searchText: string;
}

/** Вектор для поиска по смыслу: раздел документации или символ кода. */
export type VectorKind = "chunk" | "symbol";
export interface VectorRow {
  kind: VectorKind;
  id: string;
  /** Хэш текста, по которому посчитан вектор. */
  hash: string;
  /** Модель, размерность и шаблоны. */
  label: string;
  vec: Float32Array;
}

export interface RawImportRow {
  fromFile: string;
  specifier: string;
  names: string[];
  line: number;
  kind: string;
  lang: string;
}

export interface ImportRow {
  fromFile: string;
  toFile: string;
  names: string[];
  line: number;
  /** import, export (реэкспорт: `export * from`, `export { X } from`), dynamic, require */
  kind: string;
}

export interface CodeKeyRow {
  file: string;
  line: number;
  value: string;
  context: string;
  symbolId: string | null;
  pattern: boolean;
}

/** Сущность проекта: где объявлена (символ кода или раздел документа). */
export interface EntityRow {
  kind: string;
  name: string;
  file: string;
  line: number;
  symbolId: string | null;
  chunkId: string | null;
}

export interface ApiItemRow extends ApiItemRecord {
  chunkId: string;
  docPath: string;
  pathNorm: string | null;
}

export interface ChunkRefRow extends RefRecord {
  chunkId: string;
}

export type TargetKind = "file" | "dir" | "glob" | "symbol" | "chunk" | "doc";
export type Confidence = "high" | "medium" | "low";

export interface LinkRow {
  /** Фрагмент, от которого идёт связь. */
  chunkId: string;
  targetKind: TargetKind;
  targetId: string;
  /** covers, link, path, symbol, location, endpoint, channel, id-ref, schema-ref, operation-id, client-fn, channel-key … */
  source: string;
  confidence: Confidence;
  line: number | null;
  /** Для связей контракта с кодом: implements, calls, publish, subscribe, mention. */
  role: string | null;
}

export interface KeyRefRow {
  key: string;
  /** operation | channel */
  kind: string;
  /** implements | calls | publish | subscribe | mention */
  role: string;
  file: string;
  line: number;
  symbolId: string | null;
  package: string | null;
  /** exact | mention | unresolved */
  confidence: string;
  /** Фрагмент контракта; пусто для неразрешённых обращений. */
  chunkId: string | null;
}

export interface ProblemRow {
  /** broken-link, broken-path, broken-endpoint, broken-symbol, broken-id-ref, unknown-channel … */
  kind: string;
  chunkId: string | null;
  path: string;
  line: number | null;
  value: string;
  message: string;
}

export interface TaskRow {
  id: string;
  type: string | null;
  status: string | null;
  title: string;
  description: string;
  parent: string | null;
  created_at: string | null;
  /** Откуда задача: beads, jsonl, свой адаптер, git (номер в коммитах) или commit («изменение» без номера). */
  source: string | null;
}

export interface TaskFileRow {
  taskId: string;
  file: string;
  commits: number;
}

export interface CochangeRow {
  fileA: string;
  fileB: string;
  weight: number;
}

export interface ChunkHit {
  chunk: ChunkRow;
  doc: DocumentRow;
  score: number;
}

export interface SymbolHit {
  symbol: SymbolRow;
  score: number;
}

export interface ChunkSearchOptions {
  types?: string[];
  /** Префикс пути или glob-шаблон (`*`, `?`). */
  path?: string;
  includeHidden?: boolean;
  limit: number;
}

export interface SymbolSearchOptions {
  kinds?: string[];
  path?: string;
  includeTests?: boolean;
  limit: number;
}

/** Всё, что пишет индексатор. */
export interface IndexWriter {
  transaction<T>(fn: () => T): T;
  getSource(path: string): SourceRow | null;
  listSources(): SourceRow[];
  /** Заменяет все записи файла результатом экстрактора. */
  putDocument(source: SourceRow, doc: DocumentRecord, analyzed: AnalyzedChunk[]): void;
  putCode(source: SourceRow, code: CodeRecord, analyzedSymbols: AnalyzedSymbol[]): void;
  putSkipped(source: SourceRow): void;
  removeSource(path: string): void;

  // Шаг связывания перестраивает производные таблицы целиком.
  allChunkRefs(): ChunkRefRow[];
  allChunksLite(): Array<Pick<ChunkRow, "id" | "docPath" | "text" | "lineStart" | "lineEnd" | "kind">>;
  allDocuments(): DocumentRow[];
  allFiles(): FileRow[];
  allSymbols(): SymbolRow[];
  allRawImports(): RawImportRow[];
  allCodeKeys(): CodeKeyRow[];
  allEntities(): EntityRow[];
  /** Имена ключей данных из нетестового кода. */
  dataKeyNames(): Set<string>;
  allApiItems(): ApiItemRow[];
  updateDocumentMeta(rows: Array<Pick<DocumentRow, "path" | "type" | "status" | "hidden" | "package">>): void;
  updateFileMeta(rows: Array<Pick<FileRow, "path" | "package" | "packageDir" | "unit" | "owner">>): void;
  replaceImports(rows: ImportRow[]): void;
  replaceLinks(rows: LinkRow[]): void;
  replaceKeyRefs(rows: KeyRefRow[]): void;
  replaceProblems(rows: ProblemRow[]): void;

  // История git и задачи.
  replaceCochange(rows: CochangeRow[]): void;
  replaceTasks(rows: TaskRow[], analyze: (text: string) => string): void;
  replaceTaskFiles(rows: TaskFileRow[]): void;
  setFileDates(dates: Map<string, number>): void;
  /** Даты строк файла: дата фрагмента или символа — самая поздняя из его строк. */
  applyLineDates(path: string, lineDates: number[]): void;
  /** Файлы, для которых даты строк ещё не посчитаны или устарели. */
  filesNeedingBlame(): string[];
  markBlamed(path: string, hash: string): void;

  // Векторы для поиска по смыслу.
  /** Хэш текста и метка модели уже посчитанных векторов. */
  vectorHashes(kind: VectorKind): Map<string, { hash: string; label: string }>;
  putVectors(rows: VectorRow[]): void;
  deleteVectors(kind: VectorKind, ids: string[]): void;

  setState(key: string, value: string): void;
}

/** Всё, что читает сервер. Сервер не знает про индексацию. */
export interface IndexReader {
  getState(): Record<string, string>;
  getSource(path: string): SourceRow | null;
  sourceStats(): Array<{ kind: string; extractor: string | null; count: number }>;
  erroredSources(limit: number): SourceRow[];

  searchChunks(ftsQuery: string, opts: ChunkSearchOptions): ChunkHit[];
  getChunk(id: string): ChunkRow | null;
  getDocument(path: string): DocumentRow | null;
  documentChunks(path: string): ChunkRow[];
  listDocuments(): DocumentRow[];
  apiItemsByEndpoint(method: string, pathNorm: string): ApiItemRow[];
  apiItemByChunk(chunkId: string): ApiItemRow | null;
  apiItemsByKey(kind: string, key: string): ApiItemRow[];
  /** Сущности с этим именем (любого вида). */
  entitiesByName(name: string): EntityRow[];
  entitiesInFile(path: string): EntityRow[];
  entityStats(): Array<{ kind: string; count: number }>;

  searchSymbols(ftsQuery: string, opts: SymbolSearchOptions): SymbolHit[];
  symbolsByName(name: string): SymbolRow[];
  getSymbol(id: string): SymbolRow | null;
  symbolsInFile(path: string): SymbolRow[];
  getFile(path: string): FileRow | null;
  filesInDir(dir: string): FileRow[];

  linksFromChunk(chunkId: string): LinkRow[];
  linksFromDoc(docPath: string): LinkRow[];
  linksTo(kind: TargetKind, id: string): LinkRow[];
  /** Связи к файлу: прямые, к его символам, к его каталогам и glob-шаблонам, которые его покрывают. */
  linksToFile(path: string): LinkRow[];
  importsFrom(file: string): ImportRow[];
  importsTo(file: string): ImportRow[];
  /** Файлы, которые импортируют имя (`import { name } from …`), — по тексту импорта, без разрешения пути; реэкспорты не в счёт. */
  filesImportingName(name: string): string[];
  cochange(file: string, limit: number): CochangeRow[];
  keyRefsByFile(file: string): KeyRefRow[];
  keyRefsByChunk(chunkId: string): KeyRefRow[];
  keyRefStats(): Array<{ kind: string; confidence: string; count: number }>;
  problems(kind?: string): ProblemRow[];
  problemStats(): Array<{ kind: string; count: number }>;

  // Задачи и поиск путей для сборки контекста.
  getTask(id: string): TaskRow | null;
  /** Похожие задачи по словам (без указанных ID; если задано before — созданные раньше). */
  searchTasks(ftsQuery: string, opts: { limit: number; exclude?: string[]; before?: string | null }): Array<{ task: TaskRow; score: number }>;
  /** Файлы из коммитов, где упомянут любой из ID. */
  taskFiles(ids: string[]): TaskFileRow[];
  /** Индексированные пути, равные `suffix` или оканчивающиеся на `/suffix`. */
  pathsBySuffix(suffix: string, limit: number): string[];

  // Полные выборки для проверки документации (check): устаревшие разделы и непокрытый код.
  allLinks(): LinkRow[];
  allFiles(): FileRow[];
  allSymbols(): SymbolRow[];
  chunkDates(): Map<string, { docPath: string; changedAt: number | null; kind: string }>;

  // Поиск по смыслу.
  /** Сколько векторов каждого вида и с какой меткой модели. */
  vectorStats(): Array<{ kind: VectorKind; label: string; dim: number; count: number }>;
  /** Ближайшие по косинусу векторы с меткой `label` (вектор запроса нормирован). */
  nearestVectors(kind: VectorKind, label: string, query: Float32Array, limit: number): Array<{ id: string; score: number }>;
}

export interface AnalyzedChunk {
  record: ChunkRecord;
  ftsHeading: string;
  ftsBody: string;
}

export interface AnalyzedSymbol {
  ftsName: string;
  ftsSignature: string;
  ftsComment: string;
}

export interface IndexStore extends IndexWriter, IndexReader {
  close(): void;
  /** Версия sqlite-vec или null, если расширение не загружено. */
  readonly vectorExtension: string | null;
}
