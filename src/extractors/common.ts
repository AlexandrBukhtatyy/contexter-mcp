import { countTokens } from "../util/tokens.ts";
import { shortHash } from "../util/text.ts";
import type { ChunkRecord, RefRecord } from "./types.ts";

/** Якорь заголовка: нижний регистр, буквы, цифры и дефисы; кириллица сохраняется. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[`*_~[\]()<>{}"'«»„“”.,:;!?|\\/#@$%^&=+]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

/** Делает идентификаторы уникальными в пределах файла, не трогая первый экземпляр. */
export class IdAllocator {
  private readonly used = new Map<string, number>();
  take(id: string): string {
    const n = (this.used.get(id) ?? 0) + 1;
    this.used.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  }
}

export function makeChunk(fields: Omit<ChunkRecord, "tokens" | "hash"> & { tokens?: number }): ChunkRecord {
  const tokenSource = fields.searchText ? `${fields.text}\n${fields.searchText}` : fields.text;
  return {
    ...fields,
    tokens: fields.tokens ?? countTokens(fields.text),
    hash: shortHash(tokenSource),
  };
}

export function dedupeRefs(refs: RefRecord[]): RefRecord[] {
  const seen = new Set<string>();
  const out: RefRecord[] = [];
  for (const r of refs) {
    const key = `${r.kind}\u0000${r.value}\u0000${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

const QUALIFIED_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g;
const IDENT_RE = /\b[A-Za-z_$][\w$]{3,}\b/g;
const IDENT_STOP = new Set([
  "const", "function", "return", "import", "export", "default", "async", "await", "interface", "extends", "implements",
  "string", "number", "boolean", "undefined", "null", "true", "false", "this", "super", "class", "type", "enum", "public",
  "private", "protected", "static", "readonly", "void", "never", "unknown", "package", "func", "struct", "range", "error",
  "select", "switch", "case", "break", "continue", "defer", "else", "chan", "Promise", "Array", "Record", "Partial",
  "console", "require", "module", "exports", "from", "throw", "catch", "finally", "while", "yield", "typeof", "instanceof",
]);

/** Идентификаторы из блока кода: квалифицированные имена и имена с регистром или подчёркиванием. */
export function identifiersFromCode(code: string, firstLine: number, limit = 60): RefRecord[] {
  const out: RefRecord[] = [];
  const seen = new Set<string>();
  const lines = code.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i] ?? "";
    const qualified = new Set<string>();
    for (const m of line.matchAll(QUALIFIED_RE)) {
      const v = m[0];
      qualified.add(v);
      if (!seen.has(v)) {
        seen.add(v);
        out.push({ kind: "ident", value: v, line: firstLine + i });
      }
    }
    for (const m of line.matchAll(IDENT_RE)) {
      const v = m[0];
      if (IDENT_STOP.has(v) || seen.has(v)) continue;
      if (!/[A-Z_]/.test(v.slice(1)) && !/^[A-Z]/.test(v)) continue;
      if ([...qualified].some((q) => q.split(".").includes(v))) continue;
      seen.add(v);
      out.push({ kind: "ident", value: v, line: firstLine + i });
    }
  }
  return out;
}
