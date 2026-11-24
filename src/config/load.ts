import fs from "node:fs";
import path from "node:path";
import { LineCounter, isMap, isNode, isPair, isScalar, parseDocument, type Document } from "yaml";
import type { z } from "zod";
import type { Extractor } from "../extractors/types.ts";
import { sha256, stableStringify } from "../util/text.ts";
import { BUILTIN_DEFAULTS, BUILTIN_RULES, ConfigSchema, type Config, type Rule } from "./schema.ts";

export const CONFIG_REL_PATH = ".mcp/context.yaml";
/**
 * Личные настройки поверх общего конфига, не для git: например, поиск по смыслу у того, у кого есть
 * локальная модель. Вложенные разделы сливаются, значения и списки — заменяются.
 */
export const LOCAL_CONFIG_REL_PATH = ".mcp/context.local.yaml";

export interface ConfigProblem {
  file: string;
  line: number;
  column: number;
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly problems: ConfigProblem[];
  constructor(problems: ConfigProblem[]) {
    super(problems.map(formatProblem).join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function formatProblem(p: ConfigProblem): string {
  const where = p.path ? `${p.path}: ` : "";
  return `${p.file}:${p.line}:${p.column}: ${where}${p.message}`;
}

export interface ResolvedRule extends Rule {
  /** Номер правила в конфиге (с 1) или null для встроенного. */
  index: number | null;
  /** Строка правила в конфиге. */
  line: number | null;
  /** Параметры после проверки схемой экстрактора. */
  parsedOptions: Record<string, unknown>;
}

export interface LoadedConfig {
  config: Config;
  /** Путь файла конфига относительно корня репозитория или null, если конфига нет. */
  file: string | null;
  hash: string;
  rules: ResolvedRule[];
  defaults: Record<string, string>;
  /** Параметры экстракторов из `defaults` (без правил) после проверки схемой. */
  defaultOptions: Map<string, Record<string, unknown>>;
}

export type ExtractorRegistry = ReadonlyMap<string, Extractor<Record<string, unknown>>>;

/** Общий конфиг и поверх него личный (`.mcp/context.local.yaml`), если он есть. */
export function loadConfig(root: string, registry: ExtractorRegistry, file = CONFIG_REL_PATH): LoadedConfig {
  const sources: Array<{ raw: string; file: string }> = [];
  for (const f of file === CONFIG_REL_PATH ? [file, LOCAL_CONFIG_REL_PATH] : [file]) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) sources.push({ raw: fs.readFileSync(abs, "utf8"), file: f });
  }
  if (!sources.length) return buildLoaded(ConfigSchema.parse({}), null, registry, []);
  return parseConfigFiles(sources, registry);
}

export function parseConfigText(raw: string, file: string, registry: ExtractorRegistry): LoadedConfig {
  return parseConfigFiles([{ raw, file }], registry);
}

interface ParsedFile {
  file: string;
  doc: Document;
  lineCounter: LineCounter;
}

/** Плоские объекты сливаются вглубь, значения и списки из `over` заменяют значения `base`. */
function deepMerge(base: unknown, over: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** Файл, в котором задан путь (самый длинный совпавший префикс; при равенстве — более поздний, личный). */
function ownerOf(files: ParsedFile[], p: (string | number)[]): ParsedFile | undefined {
  let best: ParsedFile | undefined;
  let bestLen = -1;
  for (const f of files) {
    let len = 0;
    while (len < p.length && f.doc.hasIn(p.slice(0, len + 1))) len++;
    if (len >= bestLen) {
      best = f;
      bestLen = len;
    }
  }
  return best;
}

function parseConfigFiles(sources: Array<{ raw: string; file: string }>, registry: ExtractorRegistry): LoadedConfig {
  const problems: ConfigProblem[] = [];
  const files: ParsedFile[] = [];
  let data: unknown = {};
  for (const s of sources) {
    const lineCounter = new LineCounter();
    const doc = parseDocument(s.raw, { lineCounter, prettyErrors: false });
    for (const err of doc.errors) {
      const pos = lineCounter.linePos(err.pos[0]);
      problems.push({ file: s.file, line: pos.line, column: pos.col, path: "", message: `ошибка YAML: ${err.message.split("\n")[0]}` });
    }
    files.push({ file: s.file, doc, lineCounter });
    data = deepMerge(data, doc.toJS() ?? {});
  }
  if (problems.length) throw new ConfigError(problems);

  const at = (p: (string | number)[], key: boolean) => {
    const f = ownerOf(files, p) ?? (files[0] as ParsedFile);
    return { file: f.file, ...positionOf(f.doc, f.lineCounter, p, key) };
  };
  const parsed = ConfigSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const keys = (issue as { keys?: string[] }).keys;
      const issuePath = issue.path.map((p) => (typeof p === "symbol" ? String(p) : p));
      if (issue.code === "unrecognized_keys" && keys?.length) {
        for (const key of keys) problems.push({ ...at([...issuePath, key], true), path: [...issuePath, key].join("."), message: `неизвестный ключ «${key}»` });
        continue;
      }
      problems.push({ ...at(issuePath, false), path: issuePath.join("."), message: translateIssue(issue) });
    }
    throw new ConfigError(problems);
  }
  return buildLoaded(parsed.data, files.map((f) => f.file).join(" + "), registry, files);
}

function buildLoaded(config: Config, file: string | null, registry: ExtractorRegistry, files: ParsedFile[]): LoadedConfig {
  const problems: ConfigProblem[] = [];
  const fileName = file ?? CONFIG_REL_PATH;
  /** Где в конфиге задан путь: файл (общий или личный), строка и колонка. */
  const where = (p: (string | number)[], key = false) => {
    const f = ownerOf(files, p);
    return f ? { file: f.file, ...positionOf(f.doc, f.lineCounter, p, key) } : { file: fileName, line: 1, column: 1 };
  };

  const checkExtractor = (name: string, p: (string | number)[]) => {
    if (registry.has(name)) return true;
    problems.push({
      ...where(p),
      path: p.join("."),
      message: `неизвестный экстрактор «${name}»; доступны: ${[...registry.keys()].sort().join(", ")}`,
    });
    return false;
  };
  const checkOptions = (name: string, options: unknown, p: (string | number)[]): Record<string, unknown> => {
    const extractor = registry.get(name);
    if (!extractor) return {};
    const res = (extractor.optionsSchema as z.ZodType).safeParse(options ?? {});
    if (res.success) return res.data as Record<string, unknown>;
    for (const issue of res.error.issues) {
      const keys = (issue as { keys?: string[] }).keys;
      const sub = issue.path.map((x) => (typeof x === "symbol" ? String(x) : x));
      if (issue.code === "unrecognized_keys" && keys?.length) {
        for (const key of keys) {
          problems.push({
            ...where([...p, ...sub, key], true),
            path: [...p, ...sub, key].join("."),
            message: `неизвестный параметр «${key}» экстрактора «${name}»`,
          });
        }
      } else {
        problems.push({ ...where([...p, ...sub]), path: [...p, ...sub].join("."), message: translateIssue(issue) });
      }
    }
    return {};
  };
  const checkRegex = (value: string, p: (string | number)[]) => {
    try {
      new RegExp(value, "u");
    } catch (e) {
      problems.push({ ...where(p), path: p.join("."), message: `неверное регулярное выражение: ${(e as Error).message}` });
    }
  };

  const rules: ResolvedRule[] = [];
  config.extractors.rules.forEach((rule, i) => {
    const base = ["extractors", "rules", i];
    if (rule.match.content) checkRegex(rule.match.content, [...base, "match", "content"]);
    const ok = checkExtractor(rule.use, [...base, "use"]);
    const parsedOptions = ok ? checkOptions(rule.use, rule.options, [...base, "options"]) : {};
    rules.push({ ...rule, index: i + 1, line: where(base).line, parsedOptions });
  });
  for (const rule of BUILTIN_RULES) {
    rules.push({ ...rule, index: null, line: null, parsedOptions: checkOptions(rule.use, rule.options, []) });
  }
  const defaults = { ...BUILTIN_DEFAULTS, ...config.extractors.defaults };
  const defaultOptions = new Map<string, Record<string, unknown>>();
  for (const [ext, name] of Object.entries(config.extractors.defaults)) {
    checkExtractor(name, ["extractors", "defaults", ext]);
  }
  for (const name of new Set(Object.values(defaults))) {
    if (registry.has(name)) defaultOptions.set(name, checkOptions(name, {}, []));
  }
  config.documents.status.forEach((s, i) => checkRegex(s.regex, ["documents", "status", i, "regex"]));
  config.documents.id_refs.forEach((s, i) => checkRegex(s.pattern, ["documents", "id_refs", i, "pattern"]));
  config.checks.ignore.forEach((r, i) => r.value && checkRegex(r.value, ["checks", "ignore", i, "value"]));
  if (config.tasks.id_pattern) checkRegex(config.tasks.id_pattern, ["tasks", "id_pattern"]);
  config.documents.header_links.forEach((h, i) => {
    const p = ["documents", "header_links", i];
    if (h.path && h.entity) problems.push({ ...where(p), path: p.join("."), message: "укажите что-то одно: path (шаблон пути) или entity (вид сущности)" });
    if (h.path && !h.path.includes("$1")) problems.push({ ...where([...p, "path"]), path: [...p, "path"].join("."), message: "в шаблоне пути нужен $1 — место для значения из шапки" });
  });
  // Источник задач: встроенный или путь к модулю (существование модуля проверяется при индексации).
  (config.tasks.sources ?? []).forEach((s, i) => {
    const use = typeof s === "string" ? s : s.use;
    const isModule = /[\\/]|\.(m?js|ts)$/.test(use);
    const p = typeof s === "string" ? ["tasks", "sources", i] : ["tasks", "sources", i, "use"];
    if (!isModule && !["git", "beads", "jsonl"].includes(use)) {
      problems.push({ ...where(p), path: p.join("."), message: `неизвестный источник задач «${use}»; встроенные: git, beads, jsonl, или путь к своему модулю (.mjs)` });
    }
    if (isModule && (path.isAbsolute(use) || /^[a-z]:/i.test(use) || path.posix.normalize(use.replace(/\\/g, "/")).startsWith("../"))) {
      problems.push({ ...where(p), path: p.join("."), message: `модуль источника задач должен лежать внутри репозитория (путь от корня), а не «${use}»` });
    }
    if (use === "jsonl" && !(typeof s === "object" && typeof s.options?.path === "string")) {
      problems.push({ ...where(p), path: p.join("."), message: "источнику jsonl нужен options.path — путь к файлу задач" });
    }
  });
  const emb = config.embeddings;
  const need = (ok: boolean, key: string, message: string) => {
    if (!ok) problems.push({ ...where(["embeddings", "provider"]), path: `embeddings.${key}`, message });
  };
  if (emb.provider === "http") {
    need(Boolean(emb.url), "url", "для provider: http нужен url сервиса эмбеддингов");
    need(Boolean(emb.model), "model", "для provider: http нужно имя модели (model)");
  }
  if (emb.provider === "command") need(Boolean(emb.command?.length), "command", "для provider: command нужна команда (command), например [node, .mcp/embeddings/embed.mjs]");
  config.keys.roles.forEach((r, i) => {
    if (r.context) checkRegex(r.context, ["keys", "roles", i, "context"]);
    if (r.value) checkRegex(r.value, ["keys", "roles", i, "value"]);
  });

  if (problems.length) throw new ConfigError(problems);
  return { config, file, hash: sha256(stableStringify(config)), rules, defaults, defaultOptions };
}

/** Строка и колонка узла YAML по пути; если узла нет, берётся ближайший существующий родитель. */
function positionOf(
  doc: Document,
  lineCounter: LineCounter,
  issuePath: (string | number)[],
  preferKey: boolean,
): { line: number; column: number } {
  for (let len = issuePath.length; len >= 0; len--) {
    const p = issuePath.slice(0, len);
    if (preferKey && len === issuePath.length && len > 0) {
      const parent = p.length > 1 ? doc.getIn(p.slice(0, -1), true) : doc.contents;
      if (isMap(parent)) {
        const last = p[p.length - 1];
        const pair = parent.items.find((it) => isPair(it) && isScalar(it.key) && it.key.value === last);
        if (pair && isNode(pair.key) && pair.key.range) {
          const pos = lineCounter.linePos(pair.key.range[0]);
          return { line: pos.line, column: pos.col };
        }
      }
      continue;
    }
    const node = len === 0 ? doc.contents : doc.getIn(p, true);
    if (isNode(node) && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return { line: 1, column: 1 };
}

function translateIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `ожидается ${issue.expected}`;
    case "too_small":
      return `значение слишком маленькое (минимум ${String(issue.minimum)})`;
    case "invalid_value":
      return `допустимые значения: ${issue.values.map((v) => String(v)).join(", ")}`;
    default:
      return issue.message;
  }
}
