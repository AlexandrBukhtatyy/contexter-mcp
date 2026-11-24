import path from "node:path";
import { LineCounter, isMap, isNode, isPair, isScalar, isSeq, parseDocument, type Document, type Node as YNode, type YAMLMap } from "yaml";
import { z } from "zod";
import { IdAllocator, dedupeRefs, makeChunk } from "./common.ts";
import type { ApiItemRecord, ChunkRecord, Extractor, ExtractResult, RefRecord, SourceFile } from "./types.ts";

/**
 * Контракты OpenAPI и AsyncAPI. Фрагмент — операция, схема, канал; текст фрагмента — исходный
 * кусок YAML (агент получает его без изменений), а для поиска собирается описание по-человечески.
 * Парсер `yaml` с LineCounter сохраняет позиции и комментарии; `$ref` не подставляются.
 */
const ContractOptions = z.strictObject({});
type ContractOptions = z.infer<typeof ContractOptions>;

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];
const COMPONENT_SECTIONS: Record<string, string> = {
  schemas: "schema",
  responses: "response",
  parameters: "parameter",
  requestBodies: "request-body",
  messages: "message",
  headers: "header",
};

export const openapiExtractor: Extractor<ContractOptions> = {
  name: "openapi",
  version: 2,
  description: "OpenAPI 3: фрагмент на операцию и на компонент; метод, путь и operationId — отдельными полями.",
  optionsSchema: ContractOptions,
  extract(file) {
    return extractContract(file, "openapi");
  },
};

export const asyncapiExtractor: Extractor<ContractOptions> = {
  name: "asyncapi",
  version: 2,
  description: "AsyncAPI 2/3: фрагмент на канал, операцию, сообщение и схему; адрес канала — отдельным полем.",
  optionsSchema: ContractOptions,
  extract(file) {
    return extractContract(file, "asyncapi");
  },
};

interface Ctx {
  file: SourceFile;
  lines: string[];
  lc: LineCounter;
  title: string;
  ids: IdAllocator;
  chunks: ChunkRecord[];
}

function extractContract(file: SourceFile, format: "openapi" | "asyncapi"): ExtractResult {
  const lc = new LineCounter();
  const doc = parseDocument(file.text, { lineCounter: lc, keepSourceTokens: false });
  if (doc.errors.length) {
    const e = doc.errors[0];
    const pos = e ? lc.linePos(e.pos[0]) : { line: 1 };
    throw new Error(`ошибка YAML в строке ${pos.line}: ${e?.message.split("\n")[0] ?? ""}`);
  }
  const root = doc.contents;
  if (!isMap(root)) return { kind: "skip", reason: "корень контракта — не объект" };
  const info = toJs(getNode(root, "info")) as Record<string, unknown> | undefined;
  const title = (typeof info?.title === "string" && info.title) || path.posix.basename(file.path);
  const ctx: Ctx = { file, lines: file.text.split("\n"), lc, title, ids: new IdAllocator(), chunks: [] };

  addInfoChunk(ctx, doc, root, format);
  if (format === "openapi") extractOpenApi(ctx, root);
  else extractAsyncApi(ctx, root);
  extractComponents(ctx, root);

  ctx.chunks.forEach((c, i) => (c.ordinal = i));
  return {
    kind: "document",
    document: { title, type: "api", status: null, owner: null, covers: [], frontmatter: null, format, chunks: ctx.chunks },
  };
}

// ---------- OpenAPI ----------

function extractOpenApi(ctx: Ctx, root: YAMLMap): void {
  const paths = getNode(root, "paths");
  if (!isMap(paths)) return;
  for (const pathPair of paths.items) {
    if (!isPair(pathPair) || !isScalar(pathPair.key) || !isMap(pathPair.value)) continue;
    const apiPath = String(pathPair.key.value);
    for (const opPair of pathPair.value.items) {
      if (!isPair(opPair) || !isScalar(opPair.key)) continue;
      const method = String(opPair.key.value).toLowerCase();
      if (!HTTP_METHODS.includes(method) || !isNode(opPair.value)) continue;
      const op = (toJs(opPair.value) ?? {}) as Record<string, unknown>;
      const METHOD = method.toUpperCase();
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : [];
      const operationId = typeof op.operationId === "string" ? op.operationId : null;
      const search = [
        `${METHOD} ${apiPath}`,
        str(op.summary),
        str(op.description),
        operationId ? `operationId ${operationId}` : "",
        tags.length ? `теги ${tags.join(" ")}` : "",
        describeParameters(op.parameters),
        describeBody(op.requestBody),
        describeResponses(op.responses),
      ]
        .filter(Boolean)
        .join("\n");
      const api: ApiItemRecord = { kind: "operation", key: operationId ?? `${METHOD} ${apiPath}`, method: METHOD, path: apiPath };
      pushChunk(ctx, opPair.key, opPair.value, {
        anchor: `${METHOD} ${apiPath}`,
        heading: [ctx.title, tags[0] ?? "API", `${METHOD} ${apiPath}${op.summary ? ` — ${str(op.summary)}` : ""}`],
        kind: "operation",
        searchText: search,
        api,
      });
    }
  }
}

function describeParameters(params: unknown): string {
  if (!Array.isArray(params) || params.length === 0) return "";
  const parts = params.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    if (typeof o.$ref === "string") return refName(o.$ref);
    return `${str(o.name)} (${str(o.in)}${o.required ? ", обязательный" : ""}) ${str(o.description)}`.trim();
  });
  return `параметры: ${parts.join("; ")}`;
}

function describeBody(body: unknown): string {
  const schemas = collectRefNames(body);
  return schemas.length ? `тело запроса: ${schemas.join(", ")}` : "";
}

function describeResponses(responses: unknown): string {
  if (!responses || typeof responses !== "object") return "";
  const parts = Object.entries(responses as Record<string, unknown>).map(([code, r]) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const refs = collectRefNames(o);
    return `${code} ${str(o.description)}${refs.length ? ` (${refs.join(", ")})` : ""}`.trim();
  });
  return `ответы: ${parts.join("; ")}`;
}

// ---------- AsyncAPI ----------

function extractAsyncApi(ctx: Ctx, root: YAMLMap): void {
  const version = String(toJs(getNode(root, "asyncapi")) ?? "");
  const isV3 = version.startsWith("3");
  const channels = getNode(root, "channels");
  const addressByKey = new Map<string, string>();
  if (isMap(channels)) {
    for (const pair of channels.items) {
      if (!isPair(pair) || !isScalar(pair.key) || !isNode(pair.value)) continue;
      const key = String(pair.key.value);
      const ch = (toJs(pair.value) ?? {}) as Record<string, unknown>;
      const address = isV3 ? (typeof ch.address === "string" ? ch.address : key) : key;
      addressByKey.set(key, address);
      const messages = collectRefNames(ch.messages ?? ch.publish ?? ch.subscribe);
      const search = [
        `канал ${address}`,
        key !== address ? key : "",
        str(ch.title),
        str(ch.summary),
        str(ch.description),
        messages.length ? `сообщения ${messages.join(", ")}` : "",
        isV3 ? "" : describeV2Ops(ch),
      ]
        .filter(Boolean)
        .join("\n");
      pushChunk(ctx, pair.key, pair.value, {
        anchor: `channel/${key}`,
        heading: [ctx.title, "Каналы", address],
        kind: "channel",
        searchText: search,
        api: { kind: "channel", key, address },
      });
    }
  }
  const operations = getNode(root, "operations");
  if (isMap(operations)) {
    for (const pair of operations.items) {
      if (!isPair(pair) || !isScalar(pair.key) || !isNode(pair.value)) continue;
      const key = String(pair.key.value);
      const op = (toJs(pair.value) ?? {}) as Record<string, unknown>;
      const chRef = (op.channel as Record<string, unknown> | undefined)?.$ref;
      const chKey = typeof chRef === "string" ? refName(chRef) : "";
      const address = addressByKey.get(chKey) ?? chKey;
      const search = [`операция ${key}`, `${str(op.action)} ${address}`, str(op.title), str(op.summary), str(op.description)]
        .filter(Boolean)
        .join("\n");
      pushChunk(ctx, pair.key, pair.value, {
        anchor: `operation/${key}`,
        heading: [ctx.title, "Операции", `${key} (${str(op.action)} ${address})`],
        kind: "async-operation",
        searchText: search,
        api: { kind: "async-operation", key, address },
      });
    }
  }
}

function describeV2Ops(ch: Record<string, unknown>): string {
  const out: string[] = [];
  for (const action of ["publish", "subscribe"]) {
    const op = ch[action] as Record<string, unknown> | undefined;
    if (op) out.push(`${action} ${str(op.operationId)} ${str(op.summary)} ${str(op.description)}`.trim());
  }
  return out.join("\n");
}

// ---------- общее ----------

function extractComponents(ctx: Ctx, root: YAMLMap): void {
  const components = getNode(root, "components");
  if (!isMap(components)) return;
  for (const section of components.items) {
    if (!isPair(section) || !isScalar(section.key) || !isMap(section.value)) continue;
    const sectionName = String(section.key.value);
    const singular = COMPONENT_SECTIONS[sectionName];
    if (!singular) continue;
    for (const pair of section.value.items) {
      if (!isPair(pair) || !isScalar(pair.key) || !isNode(pair.value)) continue;
      const name = String(pair.key.value);
      const value = (toJs(pair.value) ?? {}) as Record<string, unknown>;
      const props = value.properties && typeof value.properties === "object" ? (value.properties as Record<string, unknown>) : {};
      const propText = Object.entries(props)
        .map(([k, v]) => `${k} ${str((v as Record<string, unknown> | null)?.description)}`.trim())
        .join("; ");
      const search = [`${singular} ${name}`, str(value.title), str(value.summary), str(value.description), propText].filter(Boolean).join("\n");
      pushChunk(ctx, pair.key, pair.value, {
        anchor: `${singular}/${name}`,
        heading: [ctx.title, sectionName, name],
        kind: singular,
        searchText: search,
        api: { kind: singular === "schema" ? "schema" : singular === "message" ? "message" : "component", key: name },
      });
    }
  }
}

function addInfoChunk(ctx: Ctx, doc: Document, root: YAMLMap, format: string): void {
  const infoPair = root.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === "info");
  if (!infoPair || !isPair(infoPair) || !isNode(infoPair.value)) return;
  // Шапка файла (комментарий в начале и info) — один фрагмент: в комментарии часто ссылки на ADR.
  // info может стоять после paths, поэтому берутся только его строки и начальный комментарий.
  const end = endLineOf(ctx, infoPair.value);
  const start = isNode(infoPair.key) && infoPair.key.range ? ctx.lc.linePos(infoPair.key.range[0]).line : 1;
  let headerEnd = 0;
  while (headerEnd < ctx.lines.length && /^\s*(#.*)?$/.test(ctx.lines[headerEnd] ?? "") && headerEnd < start - 1) headerEnd++;
  const header = ctx.lines.slice(0, headerEnd).join("\n").trim();
  const info = (toJs(infoPair.value) ?? {}) as Record<string, unknown>;
  const tagsNode = getNode(root, "tags");
  const tags = (toJs(tagsNode) ?? []) as Array<Record<string, unknown>>;
  const search = [
    `${format} ${ctx.title}`,
    str(info.description),
    doc.commentBefore ?? "",
    Array.isArray(tags) ? tags.map((t) => `${str(t.name)} ${str(t.description)}`).join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
  const infoText = ctx.lines.slice(start - 1, end).join("\n");
  const text = header ? `${header}\n${infoText}` : infoText;
  ctx.chunks.push(
    makeChunk({
      id: `${ctx.file.path}#${ctx.ids.take("info")}`,
      headingPath: [ctx.title],
      ordinal: 0,
      kind: "info",
      text,
      searchText: search,
      searchOnly: true,
      lineStart: header ? 1 : start,
      lineEnd: end,
      refs: dedupeRefs([...refsIn(ctx, infoPair.value), ...textRefs(doc.commentBefore ?? "", 1)]),
    }),
  );
}

function pushChunk(
  ctx: Ctx,
  keyNode: unknown,
  valueNode: YNode,
  o: { anchor: string; heading: string[]; kind: string; searchText: string; api: ApiItemRecord },
): void {
  const start = isNode(keyNode) && keyNode.range ? ctx.lc.linePos(keyNode.range[0]).line : 1;
  const end = Math.max(start, endLineOf(ctx, valueNode));
  ctx.chunks.push(
    makeChunk({
      id: `${ctx.file.path}#${ctx.ids.take(o.anchor)}`,
      headingPath: o.heading,
      ordinal: 0,
      kind: o.kind,
      text: dedent(ctx.lines.slice(start - 1, end)),
      searchText: o.searchText,
      searchOnly: true,
      lineStart: start,
      lineEnd: end,
      refs: dedupeRefs(refsIn(ctx, valueNode)),
      api: o.api,
    }),
  );
}

function endLineOf(ctx: Ctx, node: YNode): number {
  if (!node.range) return 1;
  const endOffset = Math.max(node.range[0], node.range[1] - 1);
  let line = ctx.lc.linePos(endOffset).line;
  // Конец блока иногда указывает на перевод строки после значения.
  while (line > 1 && (ctx.lines[line - 1] ?? "").trim() === "") line--;
  return line;
}

/** Все `$ref` внутри узла с номерами строк. */
function refsIn(ctx: Ctx, node: unknown): RefRecord[] {
  const out: RefRecord[] = [];
  const visit = (n: unknown) => {
    if (isMap(n)) {
      for (const p of n.items) {
        if (isPair(p) && isScalar(p.key) && p.key.value === "$ref" && isScalar(p.value) && typeof p.value.value === "string") {
          const line = p.value.range ? ctx.lc.linePos(p.value.range[0]).line : 1;
          out.push({ kind: "ref", value: p.value.value, line });
        } else if (isPair(p)) visit(p.value);
      }
    } else if (isSeq(n)) {
      for (const it of n.items) visit(it);
    }
  };
  visit(node);
  return out;
}

/** Строки в обратных кавычках из комментария — те же ссылки, что в Markdown. */
function textRefs(text: string, firstLine: number): RefRecord[] {
  const out: RefRecord[] = [];
  text.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/`([^`]+)`/g)) out.push({ kind: "code", value: m[1] ?? "", line: firstLine + i });
  });
  return out;
}

function getNode(map: YAMLMap, key: string): unknown {
  const pair = map.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === key);
  return pair && isPair(pair) ? pair.value : undefined;
}

function toJs(node: unknown): unknown {
  if (node && typeof node === "object" && "toJSON" in node && typeof (node as { toJSON: () => unknown }).toJSON === "function") {
    try {
      return (node as { toJSON: () => unknown }).toJSON();
    } catch {
      return undefined;
    }
  }
  return node;
}

function refName(ref: string): string {
  const frag = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : ref;
  return frag.split("/").filter(Boolean).pop() ?? ref;
}

function collectRefNames(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "$ref" && typeof x === "string") out.add(refName(x));
        else visit(x);
      }
    }
  };
  visit(value);
  return [...out];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function dedent(lines: string[]): string {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(min, l.match(/^ */)?.[0].length ?? 0))).join("\n");
}

/** Ключи верхнего уровня YAML или JSON: для условия `has_key` в правилах выбора экстрактора. */
export function topLevelKeys(text: string, ext: string): Set<string> {
  const keys = new Set<string>();
  if (ext === ".json") {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) keys.add(k);
    } catch {
      /* не JSON — ключей нет */
    }
    return keys;
  }
  for (const m of text.matchAll(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:/gm)) keys.add(m[1] ?? m[2] ?? m[3] ?? "");
  return keys;
}
