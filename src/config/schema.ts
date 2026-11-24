import { z } from "zod";

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const MatchSchema = z.strictObject({
  path: z.string().optional(),
  frontmatter: z.record(z.string(), Scalar).optional(),
  has_key: z.string().optional(),
  content: z.string().optional(),
});

export const RuleSchema = z.strictObject({
  match: MatchSchema,
  use: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const KeyRoleSchema = z.strictObject({
  kind: z.enum(["operation", "channel"]).optional(),
  path: z.string().optional(),
  context: z.string().optional(),
  /** Регулярное выражение для самого литерала: например, чтобы не путать адрес канала с именем переменной окружения. */
  value: z.string().optional(),
  role: z.enum(["implements", "calls", "publish", "subscribe", "mention"]),
});

export const ConfigSchema = z.strictObject({
  version: z.literal(1).optional(),
  /** Свои экстракторы: пути к ES-модулям относительно корня репозитория (default-экспорт — экстрактор). */
  plugins: z.array(z.string()).default([]),
  /**
   * Внешние пакеты из node_modules, которые индексируются вместе с репозиторием: документация и типы
   * библиотек, которыми пользуется код. Импорт пакета из кода разрешается в его типы.
   */
  packages: z
    .array(
      z.strictObject({
        name: z.string(),
        /** Каталог репозитория, из node_modules которого берётся пакет (как его видит импортирующий код). */
        from: z.string().default(""),
        include: z.array(z.string()).default(["package.json", "README.md", "docs/**/*.md", "**/*.d.ts"]),
      }),
    )
    .default([]),
  /** Glob-шаблоны путей, которые не индексируются, сверх `.gitignore`. */
  exclude: z.array(z.string()).default([]),
  /** Файлы больше этого размера пропускаются. */
  max_file_bytes: z.number().int().positive().default(4_000_000),
  extractors: z
    .strictObject({
      rules: z.array(RuleSchema).default([]),
      defaults: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  documents: z
    .strictObject({
      /** Тип документа по пути, если в шапке нет `type`. Первое совпадение. */
      types: z.array(z.strictObject({ path: z.string(), type: z.string() })).default([]),
      /** Статус по регулярному выражению в тексте, если в шапке нет `status`. Группа 1 — значение. */
      status: z.array(z.strictObject({ path: z.string(), regex: z.string() })).default([]),
      /** Приведение статусов: `superseded: deprecated`. Ключи в нижнем регистре. */
      status_map: z.record(z.string(), z.string()).default({}),
      /** Документы с этими статусами не попадают в выдачу. */
      hidden_statuses: z.array(z.string()).default(["deprecated"]),
      /** Ссылки на документы по идентификатору в тексте: `ADR-(\d{4})` → `docs/adr/$1-*.md`. */
      id_refs: z.array(z.strictObject({ pattern: z.string(), path: z.string() })).default([]),
      /**
       * Связи из YAML-шапки документа: поле (через точку — вложенное) и как разрешать его значения.
       * Без path и entity значение — ID документа по `id_refs`; `path` — шаблон пути (`$1` — значение);
       * `entity` — имя сущности этого вида (раздел `entities`). Неразрешённое — проблема `broken-header-ref`.
       */
      header_links: z
        .array(
          z.strictObject({
            field: z.string(),
            path: z.string().optional(),
            entity: z.string().optional(),
          }),
        )
        .default([]),
    })
    .prefault({}),
  /**
   * Сущности проекта, которые объявляют экстракторы (свои — из `.mcp/extractors/`): как на них ссылаются в тексте
   * документации и задач. Вид без настроек — по строке в обратных кавычках с точным именем.
   */
  entities: z
    .record(
      z.string(),
      z
        .strictObject({
          /** Ссылка в тексте: строка в обратных кавычках, совпадающая с именем; none — только из шапок. */
          in_text: z.enum(["backticks", "none"]).default("backticks"),
          /** `passes.organization_id` — тоже ссылка на `passes` (таблица и колонка). */
          dotted: z.boolean().default(false),
          /** Как называть вид в причинах и отчётах: «таблица», «экран». */
          title: z.string().optional(),
        })
        .prefault({}),
    )
    .default({}),
  chunking: z
    .strictObject({
      /** Раздел короче присоединяется к предыдущему фрагменту. */
      min_tokens: z.number().int().positive().default(80),
      /** Ориентир размера части при делении длинного раздела. */
      target_tokens: z.number().int().positive().default(600),
      /** Раздел длиннее делится на части. */
      max_tokens: z.number().int().positive().default(1000),
    })
    .prefault({}),
  links: z
    .strictObject({
      /** Имя символа, которое встречается в репозитории чаще, связью не считается. */
      ambiguous_limit: z.number().int().positive().default(5),
      /** Минимальная длина имени символа из текста документации. */
      min_symbol_length: z.number().int().positive().default(4),
    })
    .prefault({}),
  keys: z
    .strictObject({
      /** Роли строковых ключей в коде: кто реализует операцию, кто публикует в канал. */
      roles: z.array(KeyRoleSchema).default([]),
    })
    .prefault({}),
  /** Сборка пакета контекста (`get_task_context`). */
  context: z
    .strictObject({
      /**
       * Бюджет пакета по умолчанию, токенов. 6000 — замер на коде до задачи (эталонный набор, 28 задач): полнота файлов
       * 62% при 4000, 72% при 6000, 77% при 8000; документов — 75–77% при любом из них, точность падает с ростом.
       */
      budget_tokens: z.number().int().positive().default(6000),
      /**
       * Доли бюджета: документация, места в коде (вместе с тестами), правила. Неиспользованное переходит дальше.
       * Документы, названные в задаче, идут первыми вне долей, поэтому доля правил небольшая.
       */
      shares: z
        .strictObject({
          docs: z.number().min(0).max(1).default(0.4),
          code: z.number().min(0).max(1).default(0.5),
          rules: z.number().min(0).max(1).default(0.1),
        })
        .prefault({}),
      /** Типы документов, которые идут в `rules`. */
      rule_types: z.array(z.string()).default(["adr", "rule"]),
      /** Множители места по пути документа или файла: сгенерированное — ниже, ключевое — выше. */
      weights: z.array(z.strictObject({ path: z.string(), weight: z.number().positive() })).default([]),
      /** Сколько кандидатов добавляет расширение по связям. */
      max_expansion: z.number().int().positive().default(24),
      /**
       * Задачи в пакете. По умолчанию выключены: агент просит их параметрами get_task_context
       * (`task_history`, `similar_tasks`). Замер на эталонном наборе (код до задачи, 28 задач): похожие задачи меняют
       * полноту меньше чем на пункт — то же находят поиск по словам, связи и поиск по смыслу.
       */
      tasks: z
        .strictObject({
          /** Файлы из коммитов самой задачи — по `task_id` или номеру задачи в тексте («правился по задаче X»). */
          history: z.boolean().default(false),
          /** Файлы похожих задач и коммитов из истории («правился в похожей задаче X»). */
          similar: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * Поиск по смыслу (этап 4): векторы разделов документации и символов кода. Без поставщика сервер ищет
   * по словам и связям. Векторы помечены моделью: смена модели или шаблонов — пересчёт.
   */
  embeddings: z
    .strictObject({
      /**
       * none — выключено; http — сервис по HTTP (локальный или удалённый); command — свой скрипт
       * (`.mcp/embeddings/…`), построчный JSON через stdin/stdout; stub — детерминированная заглушка для тестов.
       */
      provider: z.enum(["none", "http", "command", "stub"]).default("none"),
      /** Имя модели: уходит в запрос HTTP и помечает векторы в индексе. */
      model: z.string().optional(),
      /** http: адрес, например `http://localhost:11434/v1/embeddings` (Ollama) или удалённый сервис. */
      url: z.string().optional(),
      /** http: openai — POST {model, input[]} → data[].embedding (Ollama /v1, llama.cpp, vLLM, LM Studio, TEI); ollama — /api/embed. */
      format: z.enum(["openai", "ollama"]).default("openai"),
      /** http: имя переменной окружения с ключом (заголовок `Authorization: Bearer …`); сам ключ в конфиг не пишется. */
      api_key_env: z.string().optional(),
      /** http: дополнительные заголовки. */
      headers: z.record(z.string(), z.string()).default({}),
      /** command: команда и аргументы, рабочий каталог — корень репозитория: `["node", ".mcp/embeddings/embed.mjs"]`. */
      command: z.array(z.string()).min(1).optional(),
      /** Шаблон текста запроса; `{text}` — текст задачи. Для EmbeddingGemma: `task: search result | query: {text}`. */
      query_template: z.string().default("{text}"),
      /** Шаблон текста документа; `{title}` — заголовок раздела или имя символа, `{text}` — текст. */
      document_template: z.string().default("{text}"),
      /** Обрезать вектор до стольких измерений (Matryoshka) и нормировать заново. */
      dimensions: z.number().int().positive().optional(),
      /** Текстов в одном запросе. */
      batch: z.number().int().positive().default(32),
      timeout_ms: z.number().int().positive().default(120000),
      /** Длина текста документа в символах: длиннее — обрезается. */
      max_chars: z.number().int().positive().default(2000),
      /** Что векторизовать: разделы документации, символы кода (без тестов и внешних пакетов). */
      targets: z.array(z.enum(["docs", "code"])).default(["docs", "code"]),
    })
    .prefault({}),
  /** Журнал вызовов сервера (`.mcp/cache/calls.jsonl`) — для разбора пилота; сводка — команда `calls`. */
  log: z
    .strictObject({
      /** Писать журнал: инструмент, время, длительность, размер пакета, режим поиска. */
      calls: z.boolean().default(false),
      /** Писать и тексты задач и запросов (по умолчанию — только их длину). */
      task_text: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Задачи: текст по ID, похожие задачи и связь задачи с файлами. Источники — трекер (beads), файл задач,
   * свой адаптер и история git (номер задачи в сообщении коммита; коммит без номера — «изменение»).
   */
  tasks: z
    .strictObject({
      /**
       * Источники задач по порядку важности: `git`, `beads`, `jsonl` или свой модуль `{ use: ".mcp/tasks/x.mjs", options }`.
       * По умолчанию — `beads`, если есть его файл, и `git`.
       */
      sources: z
        .array(
          z.union([
            z.string(),
            z.strictObject({
              /** Встроенный источник (git, beads, jsonl) или путь к своему модулю внутри репозитория. */
              use: z.string(),
              /** Параметры источника: `path` для beads и jsonl, свои — для своего модуля. */
              options: z.record(z.string(), z.unknown()).optional(),
            }),
          ]),
        )
        .optional(),
      /** Файл задач beads (`.beads/issues.jsonl`) для источника по умолчанию. */
      beads: z.string().optional(),
      /** Регулярное выражение номера задачи в тексте и сообщениях коммитов; по умолчанию — по префиксам ID трекера или по коммитам. */
      id_pattern: z.string().optional(),
      /** Задачи из истории git. */
      git: z
        .strictObject({
          /** Коммит без номера задачи — отдельное «изменение»: похожие правки ищутся и без трекера. */
          commits_without_id: z.boolean().default(true),
          /** Сколько последних коммитов разбирать. */
          max_commits: z.number().int().positive().default(5000),
        })
        .prefault({}),
    })
    .prefault({}),
  checks: z
    .strictObject({
      /**
       * Намеренные исключения из отчёта: проблема скрывается первым подошедшим правилом,
       * а в отчёте остаётся счётчик «скрыто правилом» с его причиной.
       */
      ignore: z
        .array(
          z.strictObject({
            kind: z.string().optional(),
            /** glob пути документа или файла, где найдена проблема */
            path: z.string().optional(),
            /** регулярное выражение по значению: эндпоинту, пути, имени */
            value: z.string().optional(),
            reason: z.string(),
          }),
        )
        .default([]),
    })
    .prefault({}),
  history: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Коммиты, где изменено больше файлов, в подсчёт совместных правок не входят. */
      max_commit_files: z.number().int().positive().default(30),
      /** Минимум общих коммитов, чтобы считать файлы связанными. */
      min_cochange: z.number().int().positive().default(2),
      /** Даты строк по `git blame`: дата фрагмента и символа. */
      blame: z.boolean().default(true),
      blame_concurrency: z.number().int().positive().default(8),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Match = z.infer<typeof MatchSchema>;
export type KeyRole = z.infer<typeof KeyRoleSchema>;

/** Экстракторы по расширению, если в конфиге не сказано иное. */
export const BUILTIN_DEFAULTS: Record<string, string> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".ts": "code",
  ".tsx": "code",
  ".mts": "code",
  ".cts": "code",
  ".js": "code",
  ".jsx": "code",
  ".mjs": "code",
  ".cjs": "code",
  ".go": "code-go",
  ".bru": "bruno",
};

/** Встроенные правила проверяются после правил из конфига: контракты узнаются по ключу верхнего уровня. */
export const BUILTIN_RULES: Rule[] = [
  { match: { path: "**/*.{yaml,yml,json}", has_key: "openapi" }, use: "openapi" },
  { match: { path: "**/*.{yaml,yml,json}", has_key: "swagger" }, use: "openapi" },
  { match: { path: "**/*.{yaml,yml,json}", has_key: "asyncapi" }, use: "asyncapi" },
];
