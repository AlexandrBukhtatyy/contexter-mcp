/** Меняется при любой правке схемы: индекс со старой версией удаляется и собирается заново. */
export const SCHEMA_VERSION = 10;

/**
 * Миграции без пересборки: версия → SQL перехода на следующую. Только добавление пустых таблиц и индексов —
 * всё, что меняет смысл записей, требует пересборки (версия без миграции). Пересборка большого репозитория
 * с векторами занимает десятки минут, поэтому новую таблицу лучше добавлять миграцией.
 */
export const MIGRATIONS: Record<number, string> = {
  9: `CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, symbol_id TEXT, chunk_id TEXT, extractor TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS entities_file ON entities (file);
CREATE INDEX IF NOT EXISTS entities_name ON entities (name);`,
};

const FTS_TOKENIZER = "tokenize='unicode61 remove_diacritics 0'";

export const SCHEMA_SQL = `
CREATE TABLE index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Каждый файл, который видел индексатор, и чем он обработан.
CREATE TABLE sources (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  extractor TEXT,
  extractor_version INTEGER,
  options_hash TEXT,
  hash TEXT NOT NULL,
  rule TEXT,
  error TEXT,
  bytes INTEGER NOT NULL DEFAULT 0
);

-- документация
CREATE TABLE documents (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT,
  type_hint TEXT,
  status TEXT,
  status_hint TEXT,
  owner TEXT,
  covers TEXT NOT NULL DEFAULT '[]',
  frontmatter TEXT,
  format TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  package TEXT,
  hash TEXT NOT NULL,
  extractor TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  options_hash TEXT NOT NULL,
  changed_at INTEGER
);

CREATE TABLE chunks (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  doc_path TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  hash TEXT NOT NULL,
  changed_at INTEGER,
  extractor TEXT NOT NULL
);
CREATE INDEX chunks_doc ON chunks (doc_path, ordinal);
CREATE VIRTUAL TABLE chunks_fts USING fts5 (heading, body, ${FTS_TOKENIZER});

CREATE TABLE chunk_refs (chunk_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, line INTEGER NOT NULL);
CREATE INDEX chunk_refs_chunk ON chunk_refs (chunk_id);

CREATE TABLE api_items (
  chunk_id TEXT PRIMARY KEY,
  doc_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT,
  path TEXT,
  path_norm TEXT,
  address TEXT
);
CREATE INDEX api_items_key ON api_items (kind, key);
CREATE INDEX api_items_endpoint ON api_items (method, path_norm);

-- код
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  package TEXT,
  package_dir TEXT,
  unit TEXT,
  unit_name TEXT,
  owner TEXT,
  hash TEXT NOT NULL,
  extractor TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  options_hash TEXT NOT NULL,
  is_test INTEGER NOT NULL,
  generated INTEGER NOT NULL,
  changed_at INTEGER
);

CREATE TABLE symbols (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  comment TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  exported INTEGER NOT NULL,
  is_test INTEGER NOT NULL,
  changed_at INTEGER,
  extractor TEXT NOT NULL,
  -- видимые тексты символа (подписи JSX, сообщения) — для поиска по смыслу
  search_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX symbols_file ON symbols (file);
CREATE INDEX symbols_name ON symbols (name);
CREATE INDEX symbols_qualified ON symbols (qualified);
CREATE VIRTUAL TABLE symbols_fts USING fts5 (name, signature, comment, ${FTS_TOKENIZER});

CREATE TABLE raw_imports (from_file TEXT NOT NULL, specifier TEXT NOT NULL, names TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL, lang TEXT NOT NULL);
CREATE INDEX raw_imports_from ON raw_imports (from_file);

CREATE TABLE imports (from_file TEXT NOT NULL, to_file TEXT NOT NULL, names TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE INDEX imports_from ON imports (from_file);
CREATE INDEX imports_to ON imports (to_file);

CREATE TABLE code_keys (file TEXT NOT NULL, line INTEGER NOT NULL, value TEXT NOT NULL, context TEXT NOT NULL, symbol_id TEXT, pattern INTEGER NOT NULL, extractor TEXT NOT NULL);
CREATE INDEX code_keys_file ON code_keys (file);
CREATE INDEX code_keys_value ON code_keys (value);

-- Сущности проекта, объявленные экстракторами: таблица БД, экран, команда … (вид, имя, место объявления).
CREATE TABLE entities (kind TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, symbol_id TEXT, chunk_id TEXT, extractor TEXT NOT NULL);
CREATE INDEX entities_file ON entities (file);
CREATE INDEX entities_name ON entities (name);

-- Имена, которые служат ключами данных (поля DTO, ключи объектов, json-теги): поле в тексте документа ≠ метод.
CREATE TABLE data_keys (file TEXT NOT NULL, name TEXT NOT NULL);
CREATE INDEX data_keys_file ON data_keys (file);

-- связи и состояние
CREATE TABLE links (
  chunk_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  line INTEGER,
  role TEXT
);
CREATE INDEX links_chunk ON links (chunk_id);
CREATE INDEX links_target ON links (target_kind, target_id);

-- Регистрации и обращения по ключу (по образцу runtime_entries из дизайна): операции и каналы API.
CREATE TABLE key_refs (
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  symbol_id TEXT,
  package TEXT,
  confidence TEXT NOT NULL,
  chunk_id TEXT
);
CREATE INDEX key_refs_file ON key_refs (file);
CREATE INDEX key_refs_chunk ON key_refs (chunk_id);

CREATE TABLE problems (kind TEXT NOT NULL, chunk_id TEXT, path TEXT NOT NULL, line INTEGER, value TEXT NOT NULL, message TEXT NOT NULL);
CREATE INDEX problems_kind ON problems (kind);

CREATE TABLE cochange (file_a TEXT NOT NULL, file_b TEXT NOT NULL, weight INTEGER NOT NULL);
CREATE INDEX cochange_a ON cochange (file_a);
CREATE INDEX cochange_b ON cochange (file_b);

CREATE TABLE blame_state (path TEXT PRIMARY KEY, hash TEXT NOT NULL);

-- Задачи из всех источников (трекер, файл задач, свой адаптер, git): ID, тип, статус, заголовок, описание, источник —
-- без владельцев и исполнителей. «Изменения» — коммиты без номера задачи (id commit:<хэш>).
CREATE TABLE tasks (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, type TEXT, status TEXT, title TEXT NOT NULL, description TEXT NOT NULL, parent TEXT, created_at TEXT, source TEXT);
CREATE VIRTUAL TABLE tasks_fts USING fts5 (title, body, ${FTS_TOKENIZER});
-- Файлы, изменённые в коммитах, где упомянут ID задачи.
CREATE TABLE task_files (task_id TEXT NOT NULL, file TEXT NOT NULL, commits INTEGER NOT NULL);
CREATE INDEX task_files_task ON task_files (task_id);

-- Векторы для поиска по смыслу: kind — chunk или symbol; hash — хэш текста, по которому считан вектор;
-- label — модель, размерность и шаблоны (векторы с другой меткой не сравниваются). vec — float32 подряд.
CREATE TABLE vectors (kind TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, label TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (kind, id));
`;
