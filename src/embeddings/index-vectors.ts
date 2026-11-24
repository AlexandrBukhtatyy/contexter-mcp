import { isExternalPath } from "../indexer/files.ts";
import type { IndexStore, VectorKind } from "../store/types.ts";
import { sha256 } from "../util/text.ts";
import { applyTemplate, type Embedder, type EmbeddingSettings } from "./provider.ts";

export interface EmbeddingStats {
  label: string;
  /** Сколько разделов и символов должно иметь векторы. */
  chunks: number;
  symbols: number;
  /** Посчитано заново в этом прогоне. */
  embedded: number;
  /** Взято из индекса без пересчёта. */
  reused: number;
  removed: number;
  ms: number;
  /** Сбой поставщика: векторы посчитаны не все, сервер ищет по тем, что есть. */
  error?: string;
}

interface Target {
  kind: VectorKind;
  id: string;
  text: string;
  hash: string;
}

/** Текст символа для модели: вид и имя, путь, сигнатура, комментарий, видимые тексты (подписи JSX, сообщения). */
export function symbolText(s: { kind: string; qualified: string; file: string; signature: string; comment: string; searchText: string }): string {
  return [`${s.kind} ${s.qualified}`, s.file, s.signature, s.comment, s.searchText].filter((x) => x && x.trim()).join("\n");
}

/**
 * Векторы разделов документации и символов кода. Считаются только для новых и изменившихся текстов
 * (хэш текста вместе с меткой модели), пачками; векторы исчезнувших записей удаляются.
 * Сбой поставщика не роняет индексацию: посчитанное сохраняется, причина — в `error`.
 */
export async function runEmbeddings(store: IndexStore, embedder: Embedder, s: EmbeddingSettings, log: (msg: string) => void): Promise<EmbeddingStats> {
  const t0 = Date.now();
  const targets: Target[] = [];
  const add = (kind: VectorKind, id: string, title: string, body: string) => {
    const text = applyTemplate(s.document_template, body.slice(0, s.max_chars), title);
    targets.push({ kind, id, text, hash: sha256(`${embedder.label}\n${text}`) });
  };
  if (s.targets.includes("docs")) {
    for (const doc of store.listDocuments()) {
      if (doc.hidden) continue;
      for (const c of store.documentChunks(doc.path)) add("chunk", c.id, c.headingPath.join(" › ") || doc.title, c.text);
    }
  }
  if (s.targets.includes("code")) {
    const files = new Map(store.allFiles().map((f) => [f.path, f]));
    for (const sym of store.allSymbols()) {
      const f = files.get(sym.file);
      if (!f || f.isTest || f.generated || sym.isTest || isExternalPath(sym.file)) continue;
      add("symbol", sym.id, sym.qualified, symbolText(sym));
    }
  }

  const stats: EmbeddingStats = {
    label: embedder.label,
    chunks: targets.filter((t) => t.kind === "chunk").length,
    symbols: targets.filter((t) => t.kind === "symbol").length,
    embedded: 0,
    reused: 0,
    removed: 0,
    ms: 0,
  };
  const todo: Target[] = [];
  for (const kind of ["chunk", "symbol"] as const) {
    const have = store.vectorHashes(kind);
    const want = targets.filter((t) => t.kind === kind);
    const wanted = new Set(want.map((t) => t.id));
    const gone = [...have.keys()].filter((id) => !wanted.has(id));
    stats.removed += gone.length;
    // Вектор изменившегося текста удаляется сразу: если пересчёт сорвётся, лучше без вектора, чем со старым —
    // на снимках «до задачи» старый вектор мог быть посчитан по тексту с решением.
    const outdated: string[] = [];
    for (const t of want) {
      const prev = have.get(t.id);
      if (prev?.hash === t.hash) stats.reused++;
      else {
        todo.push(t);
        if (prev) outdated.push(t.id);
      }
    }
    if (gone.length || outdated.length) store.transaction(() => store.deleteVectors(kind, [...gone, ...outdated]));
  }

  // Сервис не отвечает — одна строка в журнале вместо повторов на каждой пачке; посчитанное остаётся.
  if (todo.length && embedder.probe) {
    const down = await embedder.probe();
    if (down) {
      stats.error = `сервис эмбеддингов недоступен, векторы не пересчитаны: ${down}`;
      stats.ms = Date.now() - t0;
      return stats;
    }
  }
  let nextReport = 0.1;
  try {
    for (let i = 0; i < todo.length; i += s.batch) {
      const part = todo.slice(i, i + s.batch);
      const vecs = await embedder.embed(
        part.map((p) => p.text),
        "document",
      );
      store.transaction(() => store.putVectors(part.map((p, k) => ({ kind: p.kind, id: p.id, hash: p.hash, label: embedder.label, vec: vecs[k] as Float32Array }))));
      stats.embedded += part.length;
      if (todo.length >= 500 && stats.embedded / todo.length >= nextReport) {
        log(`эмбеддинги: ${stats.embedded} из ${todo.length} (${Math.round((Date.now() - t0) / 1000)} с)`);
        nextReport += 0.1;
      }
    }
  } catch (e) {
    stats.error = (e as Error).message;
  }
  stats.ms = Date.now() - t0;
  return stats;
}
