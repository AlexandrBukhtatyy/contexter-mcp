import path from "node:path";
import type { Heading, List, Nodes, Root, RootContent, Table } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import YAML from "yaml";
import { z } from "zod";
import { countTokens } from "../util/tokens.ts";
import { IdAllocator, dedupeRefs, identifiersFromCode, makeChunk, slugify } from "./common.ts";
import type { ChunkRecord, Extractor, ExtractResult, RefRecord, SourceFile } from "./types.ts";

export const MarkdownOptions = z.strictObject({
  min_tokens: z.number().int().positive().default(80),
  target_tokens: z.number().int().positive().default(600),
  max_tokens: z.number().int().positive().default(1000),
});
export type MarkdownOptions = z.infer<typeof MarkdownOptions>;

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml"]);

const IDENT_LANGS = new Set(["", "ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "go", "golang"]);

interface Section {
  chain: string[];
  depth: number;
  nodes: RootContent[];
}

/** Неделимая единица при делении длинного раздела: блок или часть большого блока. */
interface Unit {
  start: number;
  end: number;
  /** Строки, которые надо поставить перед частью: заголовок таблицы при делении по строкам. */
  prefix?: string;
  tokens: number;
}

interface ChunkDraft {
  anchor: string;
  chain: string[];
  start: number;
  end: number;
  prefix?: string;
  tokens: number;
  partOf?: string;
}

export const markdownExtractor: Extractor<MarkdownOptions> = {
  name: "markdown",
  version: 5,
  description: "Фрагменты по заголовкам: короткие разделы присоединяются к предыдущему, длинные делятся по блокам.",
  optionsSchema: MarkdownOptions,
  extract(file, options) {
    return extractMarkdown(file, options);
  },
};

export function parseFrontmatter(text: string): Record<string, unknown> | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  try {
    const value = YAML.parse(text.slice(4, end)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function extractMarkdown(file: SourceFile, options: MarkdownOptions): ExtractResult {
  const tree = processor.parse(file.text) as Root;
  const lines = file.text.split("\n");
  const warnings: string[] = [];

  let frontmatter: Record<string, unknown> | null = null;
  const body = tree.children.filter((n) => {
    if (n.type !== "yaml") return true;
    try {
      const v = YAML.parse(n.value) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) frontmatter = v as Record<string, unknown>;
    } catch (e) {
      warnings.push(`шапка не разобрана: ${(e as Error).message.split("\n")[0]}`);
    }
    return false;
  });
  const fm = frontmatter as Record<string, unknown> | null;

  // Разделы: каждый заголовок открывает новый раздел, путь — цепочка заголовков над ним.
  const sections: Section[] = [];
  const stack: Array<{ depth: number; text: string }> = [];
  let current: Section = { chain: [], depth: 0, nodes: [] };
  for (const node of body) {
    if (node.type === "heading") {
      sections.push(current);
      while (stack.length && (stack[stack.length - 1]?.depth ?? 0) >= node.depth) stack.pop();
      stack.push({ depth: node.depth, text: headingText(node) });
      current = { chain: stack.map((s) => s.text), depth: node.depth, nodes: [node] };
    } else {
      current.nodes.push(node);
    }
  }
  sections.push(current);

  const firstH1 = body.find((n): n is Heading => n.type === "heading" && n.depth === 1);
  const title =
    (typeof fm?.title === "string" && fm.title.trim()) ||
    (firstH1 ? headingText(firstH1) : "") ||
    path.posix.basename(file.path).replace(/\.(md|markdown)$/i, "");

  const ids = new IdAllocator();
  const drafts: ChunkDraft[] = [];
  sections.forEach((sec, i) => {
    if (sec.nodes.length === 0) return;
    // Вступление из одних HTML-комментариев (шаблонная подсказка автору) — не содержание документа.
    if (sec.chain.length === 0 && sec.nodes.every((n) => n.type === "html" && /^\s*<!--[\s\S]*-->\s*$/.test(n.value))) return;
    const onlyHeading = sec.nodes.length === 1 && sec.nodes[0]?.type === "heading";
    const next = sections[i + 1];
    // Заголовок без текста, за которым идут его подразделы, отдельным фрагментом не становится:
    // он уже есть в пути заголовков подразделов.
    if (onlyHeading && next && next.depth > sec.depth) return;

    const start = startLine(sec.nodes[0]);
    const end = endLine(sec.nodes[sec.nodes.length - 1]);
    const text = lines.slice(start - 1, end).join("\n");
    const tokens = countTokens(text);
    const anchor = ids.take(sec.chain.length ? sec.chain.map(slugify).join("/") : "_intro");
    const chain = sec.chain.length ? sec.chain : [title];

    if (tokens > options.max_tokens) {
      const parts = packUnits(sectionUnits(sec.nodes, lines, options), options.target_tokens);
      parts.forEach((part, n) => {
        drafts.push({
          anchor: n === 0 ? anchor : `${anchor}~${n + 1}`,
          chain,
          start: part.start,
          end: part.end,
          ...(part.prefix ? { prefix: part.prefix } : {}),
          tokens: part.tokens,
          partOf: anchor,
        });
      });
      return;
    }
    const last = drafts[drafts.length - 1];
    // Короткий раздел присоединяется к предыдущему фрагменту: идентификатор предыдущего не меняется.
    if (tokens < options.min_tokens && last && !last.partOf && last.tokens + tokens <= options.max_tokens) {
      last.end = end;
      last.tokens = countTokens(lines.slice(last.start - 1, end).join("\n"));
      return;
    }
    drafts.push({ anchor, chain, start, end, tokens });
  });

  const refs = collectRefs(body, lines);
  const chunks: ChunkRecord[] = drafts.map((d, ordinal) => {
    const slice = lines.slice(d.start - 1, d.end).join("\n");
    const text = d.prefix ? `${d.prefix}\n${slice}` : slice;
    return makeChunk({
      id: `${file.path}#${d.anchor}`,
      headingPath: d.chain,
      ordinal,
      kind: "section",
      text,
      lineStart: d.start,
      lineEnd: d.end,
      refs: dedupeRefs(refs.filter((r) => r.line >= d.start && r.line <= d.end)),
    });
  });

  const covers = fm?.covers;
  return {
    kind: "document",
    document: {
      title,
      type: typeof fm?.type === "string" ? fm.type : null,
      status: typeof fm?.status === "string" ? fm.status : null,
      owner: typeof fm?.owner === "string" ? fm.owner : null,
      covers: Array.isArray(covers) ? covers.map(String) : typeof covers === "string" ? [covers] : [],
      frontmatter: fm,
      format: "markdown",
      chunks,
    },
    warnings,
  };
}

function headingText(node: Heading): string {
  return toPlainText(node).replace(/\s+/g, " ").trim();
}

function toPlainText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(toPlainText).join("");
  return "";
}

const startLine = (n: { position?: { start: { line: number } } } | undefined) => n?.position?.start.line ?? 1;
const endLine = (n: { position?: { end: { line: number } } } | undefined) => n?.position?.end.line ?? 1;

/** Делит раздел на единицы: блок кода остаётся с абзацем перед ним, таблица и список не режутся без нужды. */
function sectionUnits(nodes: RootContent[], lines: string[], options: MarkdownOptions): Unit[] {
  const units: Unit[] = [];
  const text = (a: number, b: number) => lines.slice(a - 1, b).join("\n");
  let prevType = "";
  for (const node of nodes) {
    const s = startLine(node);
    const e = endLine(node);
    const last = units[units.length - 1];
    if (node.type === "code" && prevType === "paragraph" && last && !last.prefix) {
      const merged = countTokens(text(last.start, e));
      if (merged <= options.max_tokens) {
        last.end = e;
        last.tokens = merged;
        prevType = node.type;
        continue;
      }
    }
    prevType = node.type;
    const tokens = countTokens(text(s, e));
    if (tokens <= options.max_tokens) {
      units.push({ start: s, end: e, tokens });
      continue;
    }
    for (const u of splitBigBlock(node, lines, options.target_tokens)) {
      // Пункт списка или строка таблицы тоже бывают огромными — тогда делим их по строкам.
      if (u.tokens > options.max_tokens && u.end > u.start) units.push(...splitByLines(u, lines, options.target_tokens));
      else units.push(u);
    }
  }
  return units;
}

function splitByLines(u: Unit, lines: string[], target: number): Unit[] {
  const out: Unit[] = [];
  let a = u.start;
  let acc = 0;
  for (let ln = u.start; ln <= u.end; ln++) {
    const t = countTokens(lines[ln - 1] ?? "") + 1;
    if (acc > 0 && acc + t > target) {
      out.push({ start: a, end: ln - 1, tokens: acc, ...(u.prefix ? { prefix: u.prefix } : {}) });
      a = ln;
      acc = 0;
    }
    acc += t;
  }
  out.push({ start: a, end: u.end, tokens: acc, ...(u.prefix ? { prefix: u.prefix } : {}) });
  return out;
}

/** Большой блок делится по строкам таблицы (с повтором заголовка), пунктам списка или строкам. */
function splitBigBlock(node: RootContent, lines: string[], target: number): Unit[] {
  const s = startLine(node);
  const e = endLine(node);
  const text = (a: number, b: number) => lines.slice(a - 1, b).join("\n");
  if (node.type === "table") {
    const table = node as Table;
    const header = table.children[0];
    const headerEnd = header ? endLine(header) + 1 : s; // строка-разделитель |---|
    const prefix = text(s, Math.min(headerEnd, e));
    const out: Unit[] = [];
    for (const row of table.children.slice(1)) {
      out.push({ start: startLine(row), end: endLine(row), prefix, tokens: countTokens(text(startLine(row), endLine(row))) });
    }
    return out.length ? out : [{ start: s, end: e, tokens: countTokens(text(s, e)) }];
  }
  if (node.type === "list") {
    return (node as List).children.map((item) => ({
      start: startLine(item),
      end: endLine(item),
      tokens: countTokens(text(startLine(item), endLine(item))),
    }));
  }
  // Абзац, блок кода и прочее: по строкам, примерно по целевому размеру.
  const out: Unit[] = [];
  let a = s;
  let acc = 0;
  for (let ln = s; ln <= e; ln++) {
    const t = countTokens(lines[ln - 1] ?? "") + 1;
    if (acc > 0 && acc + t > target) {
      out.push({ start: a, end: ln - 1, tokens: acc });
      a = ln;
      acc = 0;
    }
    acc += t;
  }
  out.push({ start: a, end: e, tokens: acc });
  return out;
}

/** Жадная упаковка единиц в части примерно целевого размера. */
function packUnits(units: Unit[], target: number): Array<{ start: number; end: number; prefix?: string; tokens: number }> {
  const parts: Array<{ start: number; end: number; prefix?: string; tokens: number }> = [];
  let cur: { start: number; end: number; prefix?: string; tokens: number } | null = null;
  for (const u of units) {
    const prefixTokens = u.prefix && (!cur || cur.prefix !== u.prefix) ? countTokens(u.prefix) : 0;
    if (cur && cur.tokens + u.tokens > target) {
      parts.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = { start: u.start, end: u.end, tokens: u.tokens + (u.prefix ? countTokens(u.prefix) : 0) };
      if (u.prefix) cur.prefix = u.prefix;
    } else {
      cur.end = u.end;
      cur.tokens += u.tokens + prefixTokens;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Сырые ссылки раздела: Markdown-ссылки, строки в обратных кавычках, идентификаторы из блоков кода. */
function collectRefs(nodes: RootContent[], lines: string[]): RefRecord[] {
  const out: RefRecord[] = [];
  const visit = (node: Nodes) => {
    const line = node.position?.start.line ?? 1;
    if (node.type === "link" || node.type === "definition") {
      const url = node.url.trim();
      if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("#")) {
        let decoded = url;
        try {
          decoded = decodeURI(url);
        } catch {
          /* ссылка с неверной кодировкой остаётся как есть */
        }
        out.push({ kind: "link", value: decoded, line });
      }
    } else if (node.type === "inlineCode") {
      const v = node.value.trim();
      if (v && v.length <= 300) out.push({ kind: "code", value: v, line });
    } else if (node.type === "code") {
      const lang = (node.lang ?? "").toLowerCase();
      if (IDENT_LANGS.has(lang)) out.push(...identifiersFromCode(node.value, line + 1));
    }
    if ("children" in node) for (const child of node.children as Nodes[]) visit(child);
  };
  for (const n of nodes) visit(n);
  void lines;
  return out;
}
