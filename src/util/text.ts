import { createHash } from "node:crypto";
import path from "node:path";

/** Нормализует текст файла: без BOM, переводы строк только LF. Хэши и фрагменты считаются от него. */
export function normalizeText(raw: string): string {
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.includes("\r")) text = text.replace(/\r\n?/g, "\n");
  return text;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function shortHash(text: string): string {
  return sha256(text).slice(0, 16);
}

/** Путь относительно корня репозитория, всегда через `/`. */
export function toRepoPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Склеивает и нормализует posix-путь внутри репозитория; null, если путь выходит за корень. */
export function joinRepoPath(baseDir: string, rel: string): string | null {
  const joined = path.posix.normalize(path.posix.join(baseDir || ".", rel));
  if (joined === ".." || joined.startsWith("../") || path.posix.isAbsolute(joined)) return null;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

export function dirOf(repoPath: string): string {
  const d = path.posix.dirname(repoPath);
  return d === "." ? "" : d;
}

export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Таблица начал строк: быстрый перевод смещения в номер строки. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  get lineCount(): number {
    return this.starts.length;
  }
}

export function sliceLines(text: string, lineStart: number, lineEnd: number): string {
  return text.split("\n").slice(lineStart - 1, lineEnd).join("\n");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
