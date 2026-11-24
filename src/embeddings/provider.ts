import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "../config/schema.ts";

export type EmbeddingSettings = Config["embeddings"];
/** Запрос и документ модели вроде EmbeddingGemma кодируют с разными подсказками. */
export type EmbedKind = "query" | "document";

/** Поставщик векторов. Векторы на выходе нормированы (косинус = скалярное произведение). */
export interface Embedder {
  /** Метка модели в индексе: модель, размерность и шаблоны — векторы с другой меткой не сравниваются. */
  readonly label: string;
  /** `quick` — одна попытка без повторов, таймаут до 15 с: вектор запроса агента. */
  embed(texts: string[], kind: EmbedKind, opts?: { quick?: boolean }): Promise<Float32Array[]>;
  /**
   * Проверка перед векторизацией: причина, если сервиса точно нет (соединение отклонено, адрес не найден,
   * ответ 4xx — например, нет такой модели), иначе null. Медленный ответ — не отказ: модель может грузиться.
   */
  probe?(): Promise<string | null>;
  close(): Promise<void>;
}

/** Таймаут попытки без повторов: холодный старт модели (загрузка в память) укладывается в него. */
const QUICK_TIMEOUT_MS = 15000;
/** Таймаут проверки: отвечает ли сервис вообще. Если не дождались — считаем, что модель грузится. */
const PROBE_TIMEOUT_MS = 5000;

/** Метка векторов: при смене модели, размерности или шаблонов векторы пересчитываются. */
export function embeddingLabel(s: EmbeddingSettings): string {
  return [s.provider, s.model ?? "", s.dimensions ?? "", s.query_template, s.document_template].join("|");
}

/** Текст запроса или документа по шаблону из конфига. */
export function applyTemplate(template: string, text: string, title = "none"): string {
  return template.replace(/\{title\}/g, title || "none").replace(/\{text\}/g, text);
}

/** Обрезка до `dimensions` (Matryoshka) и нормировка. */
export function finishVector(raw: ArrayLike<number>, dimensions?: number): Float32Array {
  const n = dimensions && dimensions < raw.length ? dimensions : raw.length;
  const v = new Float32Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(raw[i]);
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) v[i] = (v[i] as number) / norm;
  return v;
}

/** Поставщик по настройкам; null — поиск по смыслу выключен. `root` — рабочий каталог команды. */
export function createEmbedder(s: EmbeddingSettings, root: string): Embedder | null {
  switch (s.provider) {
    case "none":
      return null;
    case "stub":
      return new StubEmbedder(s);
    case "http":
      return new HttpEmbedder(s);
    case "command":
      return new CommandEmbedder(s, root);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Повторы при сбое сети, 429 и 5xx: 0,5 с, 1 с, 2 с. */
async function withRetries<T>(fn: () => Promise<T>, retriable: (e: unknown) => boolean, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!retriable(e) || i === attempts - 1) break;
      await sleep(500 * 2 ** i);
    }
  }
  throw last;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Сервис по HTTP. `openai` — POST {model, input: [...]} → {data: [{embedding, index}]}: Ollama `/v1/embeddings`,
 * llama.cpp, vLLM, LM Studio, text-embeddings-inference; `ollama` — POST {model, input} → {embeddings} (`/api/embed`).
 */
class HttpEmbedder implements Embedder {
  readonly label: string;
  private readonly s: EmbeddingSettings;
  constructor(s: EmbeddingSettings) {
    this.s = s;
    this.label = embeddingLabel(s);
  }
  async probe(): Promise<string | null> {
    try {
      await this.embed(["проверка"], "query", { quick: true, timeoutMs: PROBE_TIMEOUT_MS });
      return null;
    } catch (e) {
      // Не дождались или 5xx/429 — сервис жив, модель грузится или занята: векторизация пойдёт обычным путём.
      if ((e as Error).name === "TimeoutError" || (e instanceof HttpError && (e.status >= 500 || e.status === 429))) return null;
      return describeFetchError(e, this.s.url as string);
    }
  }

  async embed(texts: string[], _kind: EmbedKind, opts: { quick?: boolean; timeoutMs?: number } = {}): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const headers: Record<string, string> = { "content-type": "application/json", ...this.s.headers };
    if (this.s.api_key_env) {
      const key = process.env[this.s.api_key_env];
      if (!key) throw new Error(`переменная окружения ${this.s.api_key_env} с ключом сервиса эмбеддингов не задана`);
      headers.authorization = `Bearer ${key}`;
    }
    const body = JSON.stringify({ model: this.s.model, input: texts });
    const timeout = opts.timeoutMs ?? (opts.quick ? Math.min(this.s.timeout_ms, QUICK_TIMEOUT_MS) : this.s.timeout_ms);
    const raw = await withRetries(
      async () => {
        const res = await fetch(this.s.url as string, { method: "POST", headers, body, signal: AbortSignal.timeout(timeout) });
        if (!res.ok) throw new HttpError(res.status, `сервис эмбеддингов ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return (await res.json()) as unknown;
      },
      (e) => !(e instanceof HttpError) || e.status === 429 || e.status >= 500,
      opts.quick ? 1 : 4,
    );
    const vectors = this.s.format === "ollama" ? (raw as { embeddings?: number[][] }).embeddings : openAiVectors(raw);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error(`сервис эмбеддингов вернул ${Array.isArray(vectors) ? vectors.length : "не"} векторов на ${texts.length} текстов`);
    }
    return vectors.map((v) => finishVector(v, this.s.dimensions));
  }
  async close(): Promise<void> {}
}

/** Понятная причина сбоя запроса: «не отвечает» вместо `fetch failed`. */
export function describeFetchError(e: unknown, url = "сервис эмбеддингов"): string {
  const err = e as Error & { cause?: { code?: string } };
  if (err.name === "TimeoutError") return `${url} не ответил вовремя`;
  if (err.cause?.code || /fetch failed/.test(err.message)) return `${url} не отвечает (${err.cause?.code ?? err.message})`;
  return err.message;
}

function openAiVectors(raw: unknown): number[][] | undefined {
  const data = (raw as { data?: Array<{ embedding: number[]; index?: number }> }).data;
  if (!Array.isArray(data)) return undefined;
  return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}

/**
 * Свой скрипт: процесс запускается один раз, запросы и ответы — по строке JSON.
 * Запрос: {"id": 1, "kind": "query"|"document", "texts": ["…"]}. Ответ: {"id": 1, "vectors": [[…], …]} или {"id": 1, "error": "…"}.
 * Тексты уже по шаблонам конфига; `kind` — для скриптов, которые ставят подсказки сами. stderr скрипта идёт в stderr сервера.
 */
class CommandEmbedder implements Embedder {
  readonly label: string;
  private readonly s: EmbeddingSettings;
  private readonly root: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private exitError: Error | null = null;

  constructor(s: EmbeddingSettings, root: string) {
    this.s = s;
    this.root = root;
    this.label = embeddingLabel(s);
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const [cmd, ...args] = this.s.command as string[];
    const proc = spawn(cmd as string, args, { cwd: this.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    proc.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg: { id?: number; vectors?: number[][]; error?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        process.stderr.write(`скрипт эмбеддингов: строка не JSON: ${line.slice(0, 200)}\n`);
        return;
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`скрипт эмбеддингов: ${msg.error}`));
      else p.resolve(msg.vectors ?? []);
    });
    const fail = (e: Error) => {
      this.exitError = e;
      this.proc = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(e);
        this.pending.delete(id);
      }
    };
    proc.on("error", (e) => fail(new Error(`скрипт эмбеддингов не запустился (${this.s.command?.join(" ")}): ${e.message}`)));
    proc.on("exit", (code, signal) => fail(new Error(`скрипт эмбеддингов завершился (код ${code ?? signal})`)));
    this.proc = proc;
    this.exitError = null;
    return proc;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const proc = this.start();
    const id = this.nextId++;
    const vectors = await new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`скрипт эмбеддингов не ответил за ${this.s.timeout_ms} мс`));
      }, this.s.timeout_ms);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, kind, texts })}\n`, (e) => {
        if (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(this.exitError ?? e);
        }
      });
    });
    if (vectors.length !== texts.length) throw new Error(`скрипт эмбеддингов вернул ${vectors.length} векторов на ${texts.length} текстов`);
    return vectors.map((v) => finishVector(v, this.s.dimensions));
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/**
 * Заглушка для тестов: «мешок слов» — каждое слово (без регистра, первые 5 букв) в своё измерение по хэшу.
 * Тексты с общими словами близки; ничего не скачивает и не запускает.
 */
export class StubEmbedder implements Embedder {
  readonly label: string;
  private readonly dims: number;
  constructor(s: Pick<EmbeddingSettings, "dimensions" | "provider" | "model" | "query_template" | "document_template">) {
    this.dims = s.dimensions ?? 64;
    this.label = embeddingLabel({ ...(s as EmbeddingSettings), provider: "stub" });
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => stubVector(t, this.dims));
  }
  async close(): Promise<void> {}
}

export function stubVector(text: string, dims = 64): Float32Array {
  const v = new Float32Array(dims);
  for (const w of text.toLowerCase().match(/[\p{L}\d]+/gu) ?? []) {
    const stem = w.slice(0, 5);
    let h = 2166136261;
    for (let i = 0; i < stem.length; i++) h = Math.imul(h ^ stem.charCodeAt(i), 16777619);
    const i = (h >>> 0) % dims;
    v[i] = (v[i] as number) + 1;
  }
  return finishVector(v);
}
