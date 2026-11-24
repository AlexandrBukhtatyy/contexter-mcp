import { ConfigSchema, type Config } from "../config/schema.ts";
import type { IndexReader } from "../store/types.ts";

/** Настройки сборки контекста, сохранённые в индексе при индексации. */
export type ContextSettings = Config["context"] & {
  id_refs: Config["documents"]["id_refs"];
  task_id_pattern: string | null;
  /** Названия видов сущностей для причин: `table` → «таблица» (раздел `entities` конфига). */
  entity_titles: Record<string, string>;
};

export function readContextSettings(reader: IndexReader): ContextSettings {
  const defaults = ConfigSchema.parse({});
  const base: ContextSettings = { ...defaults.context, id_refs: [], task_id_pattern: null, entity_titles: {} };
  try {
    const saved = JSON.parse(reader.getState().context_settings ?? "{}") as Partial<ContextSettings>;
    return { ...base, ...saved, shares: { ...base.shares, ...(saved.shares ?? {}) }, tasks: { ...base.tasks, ...(saved.tasks ?? {}) } };
  } catch {
    return base;
  }
}
