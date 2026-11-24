import { loadConfig } from "../config/load.ts";
import { loadRegistry } from "../extractors/registry.ts";
import type { IndexReader } from "../store/types.ts";
import { applyTemplate, createEmbedder, describeFetchError, type Embedder, type EmbeddingSettings } from "./provider.ts";

/** Вектор запроса для поиска по смыслу или причина, почему его нет. */
export type QueryVector = { vec: Float32Array; label: string } | { error: string };

/**
 * Векторы запросов: поставщик по конфигу на диске (адрес и ключ сервиса в индекс не пишутся).
 * Запрос сравнивается только с векторами той же метки модели; кэш последних запросов.
 */
export class QueryEmbedder {
  private readonly embedder: Embedder | null;
  private readonly settings: EmbeddingSettings;
  private readonly cache = new Map<string, QueryVector>();
  /** Есть ли в индексе векторы этой модели — проверка группирует всю таблицу, поэтому кэшируется на минуту. */
  private readonly labelChecked = new WeakMap<IndexReader, { ok: boolean; at: number }>();
  /** После сбоя поставщика запросы минуту идут без поиска по смыслу, не дожидаясь таймаута каждый раз. */
  private down: { until: number; error: string } | null = null;

  constructor(embedder: Embedder | null, settings: EmbeddingSettings) {
    this.embedder = embedder;
    this.settings = settings;
  }

  /** По конфигу репозитория; без поставщика — пустышка, которая отвечает «выключено». */
  static async fromRoot(root: string): Promise<QueryEmbedder> {
    const loaded = loadConfig(root, await loadRegistry(root));
    return new QueryEmbedder(createEmbedder(loaded.config.embeddings, root), loaded.config.embeddings);
  }

  get enabled(): boolean {
    return this.embedder !== null;
  }

  /** Вектор текста задачи; null — поиск по смыслу выключен в конфиге. */
  async vector(reader: IndexReader, text: string): Promise<QueryVector | null> {
    if (!this.embedder) return null;
    const label = this.embedder.label;
    let checked = this.labelChecked.get(reader);
    if (!checked || Date.now() - checked.at > 60_000) {
      checked = { ok: reader.vectorStats().some((v) => v.label === label), at: Date.now() };
      this.labelChecked.set(reader, checked);
    }
    if (!checked.ok) return { error: "в индексе нет векторов этой модели — пересоберите индекс" };
    const query = applyTemplate(this.settings.query_template, text.slice(0, this.settings.max_chars));
    const cached = this.cache.get(query);
    if (cached) return cached;
    if (this.down && Date.now() < this.down.until) return { error: `${this.down.error} (повтор через минуту после сбоя)` };
    let out: QueryVector;
    try {
      const [vec] = await this.embedder.embed([query], "query", { quick: true });
      out = vec ? { vec, label } : { error: "поставщик не вернул вектор" };
      this.down = null;
    } catch (e) {
      out = { error: describeFetchError(e) };
      this.down = { until: Date.now() + 60_000, error: out.error };
    }
    if ("vec" in out) {
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(query, out);
    }
    return out;
  }

  async close(): Promise<void> {
    await this.embedder?.close();
  }
}
