/** Коммит из истории git: один проход `git log` нужен и истории (совместные правки, даты), и задачам. */
export interface CommitRecord {
  /** Полный хэш. */
  hash: string;
  /** Время коммита, мс. */
  time: number;
  /** Сообщение целиком: тема и тело. */
  message: string;
  /** Все файлы коммита. */
  files: string[];
}

/**
 * Задача в нейтральном виде — так её отдаёт любой источник: трекер, файл задач, свой адаптер.
 * Владельцы и исполнители сюда не попадают.
 */
export interface TaskRecord {
  id: string;
  title: string;
  /** Описание с критериями приёмки — текст, по которому ищутся похожие задачи. */
  description?: string;
  status?: string | null;
  type?: string | null;
  /** Родитель (эпик): его ID тоже исключается в честном замере. */
  parent?: string | null;
  /** Дата создания, ISO: похожие в честном замере — только созданные раньше. */
  created_at?: string | null;
}

/** Что получает адаптер источника задач. */
export interface TaskSourceContext {
  /** Корень репозитория. */
  root: string;
  /** Параметры источника из конфига (`tasks.sources[].options`). */
  options: Record<string, unknown>;
  /** Коммиты истории, новые первыми (пусто, если история выключена или это не git). */
  commits: CommitRecord[];
  log: (msg: string) => void;
}

/**
 * Адаптер источника задач: свой модуль (`tasks.sources: [{ use: ".mcp/tasks/jira.mjs" }]`) экспортирует по
 * умолчанию `{ name, load(ctx) }`. Ключи доступа и сеть — забота самого модуля: сервер их не знает.
 */
export interface TaskAdapter {
  name: string;
  load(ctx: TaskSourceContext): TaskRecord[] | Promise<TaskRecord[]>;
}
