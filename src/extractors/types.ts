import type { z } from "zod";

/**
 * Экстрактор превращает один файл в записи индекса. Он не знает про базу: получает файл
 * и параметры, возвращает записи. Всё, что зависит от других файлов (разрешение импортов,
 * связи документации с кодом, пакет файла), считается позже, на шаге связывания.
 */
export interface Extractor<O = Record<string, unknown>> {
  name: string;
  /** Меняется при любой правке, влияющей на записи: файлы этого экстрактора пересчитываются. */
  version: number;
  description: string;
  optionsSchema: z.ZodType<O>;
  /** kit — функции ядра для своих экстракторов (`.mcp/extractors/`); встроенным не нужен. */
  extract(file: SourceFile, options: O, kit?: ExtractorKit): ExtractResult | Promise<ExtractResult>;
}

/**
 * Функции ядра, которые получает свой экстрактор третьим аргументом: проекту не нужно ставить зависимости
 * contexter-mcp, чтобы собрать раздел, разобрать шапку или дополнить встроенный экстрактор.
 */
export interface ExtractorKit {
  /** Раздел документа: токены и хэш считаются сами. */
  chunk(fields: Omit<ChunkRecord, "tokens" | "hash" | "refs"> & { refs?: RefRecord[]; tokens?: number }): ChunkRecord;
  /** Выдача уникальных id в пределах файла: повтор получает суффикс `-2`, `-3`. */
  ids(): { take(id: string): string };
  slugify(text: string): string;
  /** YAML-шапка Markdown; null — шапки нет. */
  frontmatter(text: string): Record<string, unknown> | null;
  /** Встроенный экстрактор (markdown, code, code-go, openapi, asyncapi, bruno) на том же или другом тексте. */
  run(name: string, file: SourceFile, options?: Record<string, unknown>): Promise<ExtractResult>;
  /** zod — для optionsSchema своего экстрактора. */
  z: typeof z;
}

/**
 * Сущность проекта, объявленная в файле: таблица БД, экран, команда устройства … Документы, шапки и задачи
 * ссылаются на неё по имени (вид и правила — раздел `entities` конфига), связь ведёт к месту объявления.
 */
export interface EntityRecord {
  /** Вид: table, screen, command … */
  kind: string;
  /** Имя, по которому на сущность ссылаются в тексте: `passes`, `/users/:id`. */
  name: string;
  line: number;
  /** Символ кода, который её объявляет (из symbols этого же файла). */
  symbolId?: string | null;
}

export interface SourceFile {
  /** Путь относительно корня репозитория, через `/`. */
  path: string;
  /** Текст без BOM, переводы строк LF. */
  text: string;
  hash: string;
}

export type ExtractResult =
  | { kind: "document"; document: DocumentRecord; warnings?: string[] }
  | { kind: "code"; code: CodeRecord; warnings?: string[] }
  | { kind: "skip"; reason: string };

export interface DocumentRecord {
  title: string;
  /** Тип из шапки; если пусто, тип выводится из пути по конфигу. */
  type: string | null;
  status: string | null;
  owner: string | null;
  covers: string[];
  frontmatter: Record<string, unknown> | null;
  /** Формат источника: markdown, openapi, asyncapi. */
  format: string;
  chunks: ChunkRecord[];
}

export interface ChunkRecord {
  /** Устойчивый идентификатор: путь файла + якорь. */
  id: string;
  headingPath: string[];
  ordinal: number;
  /** section, operation, schema, channel, message, info … */
  kind: string;
  /** Исходный текст фрагмента: возвращается агенту без изменений. */
  text: string;
  /** Дополнительный текст для поиска по словам: ищется вместе с text (синонимы, ключи, значения вкладок). */
  searchText?: string;
  /**
   * true — в поиск по словам идёт только searchText, без text. Для текста, который нельзя искать как есть:
   * у операции контракта text — исходный YAML со служебными ключами, searchText — собранное описание.
   */
  searchOnly?: boolean;
  lineStart: number;
  lineEnd: number;
  tokens: number;
  hash: string;
  refs: RefRecord[];
  api?: ApiItemRecord;
  /** Сущности, объявленные этим разделом (экран из манифеста маршрутов). */
  entities?: EntityRecord[];
}

/** Сырые ссылки из текста фрагмента; во что они указывают, решает шаг связывания. */
export interface RefRecord {
  /** link — Markdown-ссылка; code — строка в обратных кавычках; ident — идентификатор из блока кода; ref — `$ref` контракта. */
  kind: "link" | "code" | "ident" | "ref";
  value: string;
  line: number;
}

export interface ApiItemRecord {
  /** operation, schema, channel, message, async-operation, component */
  kind: string;
  /** operationId, имя схемы, ключ канала … */
  key: string;
  method?: string;
  path?: string;
  /** Адрес канала AsyncAPI. */
  address?: string;
}

export interface CodeRecord {
  lang: "ts" | "js" | "go" | "bru";
  isTest: boolean;
  generated: boolean;
  /** Имя пакета из `package` в Go; для TS пусто. */
  unitName: string | null;
  symbols: SymbolRecord[];
  imports: RawImportRecord[];
  keys: CodeKeyRecord[];
  /**
   * Имена, которые в файле служат ключами данных: поля интерфейсов и DTO, ключи объектных литералов (TS),
   * имена из тегов `json:"…"` (Go). Нужны, чтобы не путать поле данных в тексте документа с одноимённым методом.
   */
  dataKeys: string[];
  /** Сущности, объявленные в файле (таблица в `pgTable("passes")`). */
  entities?: EntityRecord[];
}

export interface SymbolRecord {
  /** Путь файла + квалифицированное имя. */
  id: string;
  name: string;
  /** `Class.method`, `Type.Method` или просто имя. */
  qualified: string;
  kind: string;
  signature: string;
  comment: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  /**
   * Тексты для поиска, которые не показываются: подписи интерфейса из JSX, сообщения и тексты ошибок
   * в строках. Связывают слова задачи («кнопка „Пригласить гостя“») с кодом, который их выводит.
   */
  searchText?: string;
}

export interface RawImportRecord {
  specifier: string;
  /** Импортированные имена; `*` — всё пространство имён. */
  names: string[];
  line: number;
  /** import, export (реэкспорт), dynamic, require */
  kind: string;
}

/** Строковый литерал, похожий на ключ: `operationId`, адрес канала. */
export interface CodeKeyRecord {
  value: string;
  line: number;
  /** Где стоит литерал: `ApiOperation.operationId`, `boot.Env`, `Subject` … */
  context: string;
  symbolId: string | null;
  /** Литерал собран из частей (`events.${kind}`, `"events.%s"`): значение — шаблон с `*`. */
  pattern: boolean;
}
