import path from "node:path";
import { z } from "zod";
import { IdAllocator } from "./common.ts";
import type { Extractor, ExtractResult, SourceFile, SymbolRecord } from "./types.ts";

/**
 * Коллекции Bruno (`.bru`): HTTP-сценарий — чёрный ящик против API. Запрос становится символом
 * `http-test` с сигнатурой `МЕТОД /путь` (по ней шаг связывания находит операцию контракта),
 * тесты `test("…")` из скриптов — символами `test`, блок `docs` — комментарием.
 */
const BrunoOptions = z.strictObject({});
const METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];

export const brunoExtractor: Extractor<Record<string, never>> = {
  name: "bruno",
  version: 1,
  description: "Bruno: HTTP-сценарий — метод и путь запроса, название, docs и тесты из скриптов.",
  optionsSchema: BrunoOptions,
  extract(file) {
    return extractBruno(file);
  },
};

interface Block {
  name: string;
  body: string[];
  /** Строка первой строки тела (с 1). */
  bodyStart: number;
  start: number;
  end: number;
}

/** Блоки верхнего уровня: `имя {` … `}` в первой колонке (тело может содержать JSON со своими скобками). */
export function parseBruBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(/^([A-Za-z][\w:-]*)\s*\{\s*$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trimEnd() !== "}") j++;
    blocks.push({ name: m[1] ?? "", body: lines.slice(i + 1, j).map((l) => l.replace(/^ {2}/, "")), bodyStart: i + 2, start: i + 1, end: j + 1 });
    i = j;
  }
  return blocks;
}

/** `{{baseUrl}}/anpr/{{cameraSecret}}/events?x=1` → `/anpr/{cameraSecret}/events`. */
export function bruPath(url: string): string {
  let p = url.trim().replace(/^https?:\/\/[^/]+/i, "");
  p = p.replace(/^(\{\{[^}]+\}\})+/, "");
  p = p.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, "{$1}").replace(/[?#].*$/, "");
  return p.startsWith("/") ? p : `/${p}`;
}

function extractBruno(file: SourceFile): ExtractResult {
  const blocks = parseBruBlocks(file.text);
  const request = blocks.find((b) => METHODS.includes(b.name.toLowerCase()));
  const url = request?.body.map((l) => l.match(/^url:\s*(.+)$/)?.[1]).find(Boolean);
  if (!request || !url) return { kind: "skip", reason: "в файле нет HTTP-запроса (окружение или настройки коллекции)" };

  const meta = Object.fromEntries(
    (blocks.find((b) => b.name === "meta")?.body ?? []).map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2]]),
  ) as Record<string, string>;
  const name = meta.name?.trim() || path.posix.basename(file.path, ".bru");
  const method = request.name.toUpperCase();
  const docs = blocks.find((b) => b.name === "docs")?.body.join("\n").trim() ?? "";
  const lineCount = file.text.split("\n").length;

  const ids = new IdAllocator();
  const symbols: SymbolRecord[] = [
    {
      id: ids.take(`${file.path}#${name}`),
      name,
      qualified: name,
      kind: "http-test",
      signature: `${method} ${bruPath(url)}`,
      comment: docs.slice(0, 1200),
      lineStart: 1,
      lineEnd: lineCount,
      exported: false,
    },
  ];
  for (const b of blocks) {
    if (b.name !== "tests" && !b.name.startsWith("script")) continue;
    b.body.forEach((line, k) => {
      for (const m of line.matchAll(/\btest\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
        const title = m[2] ?? "";
        symbols.push({
          id: ids.take(`${file.path}#${name} › ${title}`),
          name: title,
          qualified: `${name} › ${title}`,
          kind: "test",
          signature: `test(${JSON.stringify(title)})`,
          comment: "",
          lineStart: b.bodyStart + k,
          lineEnd: b.bodyStart + k,
          exported: false,
        });
      }
    });
  }
  return {
    kind: "code",
    code: { lang: "bru", isTest: true, generated: false, unitName: null, symbols, imports: [], keys: [], dataKeys: [] },
  };
}
