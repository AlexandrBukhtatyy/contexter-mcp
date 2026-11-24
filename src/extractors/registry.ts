import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import type { Config } from "../config/schema.ts";
import { sha256 } from "../util/text.ts";
import { brunoExtractor } from "./bruno.ts";
import { codeExtractor } from "./code-ts.ts";
import { goExtractor } from "./code-go.ts";
import { IdAllocator, makeChunk, slugify } from "./common.ts";
import { asyncapiExtractor, openapiExtractor } from "./contracts.ts";
import { markdownExtractor, parseFrontmatter } from "./markdown.ts";
import type { Extractor, ExtractorKit, ExtractResult, SourceFile } from "./types.ts";

export const skipExtractor: Extractor<Record<string, never>> = {
  name: "skip",
  version: 1,
  description: "Файл в индекс не попадает.",
  optionsSchema: z.strictObject({}),
  extract() {
    return { kind: "skip", reason: "экстрактор skip" };
  },
};

export type AnyExtractor = Extractor<Record<string, unknown>> & {
  /**
   * Свой экстрактор: хэш исходника модуля и версий встроенных экстракторов. Входит в хэш параметров,
   * поэтому правка модуля в `.mcp/extractors/` переиндексирует его файлы без ручной смены version.
   */
  sourceHash?: string;
};

const BUILTIN_NAMES = new Set(["markdown", "code", "code-go", "openapi", "asyncapi", "bruno"]);
/**
 * Версия того, как ядро индексирует записи своих экстракторов (поиск по словам, поля разделов). Входит в хэш
 * плагина: при смене правил их файлы переразбираются. 2 — searchText дополняет text, замена — searchOnly.
 */
const PLUGIN_FORMAT = 2;

export function builtinExtractors(): Map<string, AnyExtractor> {
  const list = [markdownExtractor, codeExtractor, goExtractor, openapiExtractor, asyncapiExtractor, brunoExtractor, skipExtractor] as unknown as AnyExtractor[];
  return new Map(list.map((e) => [e.name, e]));
}

/**
 * Встроенные экстракторы и свои — из модулей, перечисленных в `plugins` конфига. Модуль экспортирует
 * по умолчанию объект { name, version, description?, optionsSchema?, extract(file, options) }.
 * optionsSchema — схема zod или любой объект с методом safeParse; без неё параметры не проверяются.
 */
export async function loadRegistry(root: string, configFile = ".mcp/context.yaml"): Promise<Map<string, AnyExtractor>> {
  const registry = builtinExtractors();
  const abs = path.join(root, configFile);
  if (!fs.existsSync(abs)) return registry;
  let plugins: unknown;
  try {
    plugins = (YAML.parse(fs.readFileSync(abs, "utf8")) as { plugins?: unknown } | null)?.plugins;
  } catch {
    return registry; // синтаксическую ошибку покажет loadConfig с номером строки
  }
  if (!Array.isArray(plugins)) return registry;
  for (const rel of plugins) {
    if (typeof rel !== "string") continue;
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error(`плагин вне репозитория: ${rel}`);
    if (!fs.existsSync(file)) throw new Error(`плагин не найден: ${rel} (пути в plugins — от корня репозитория, например .mcp/extractors/x.mjs)`);
    const source = fs.readFileSync(file, "utf8");
    // Хэш исходника в адресе модуля: правленый модуль загружается заново и в долгоживущем процессе (замер на снимках).
    const mod = (await import(`${pathToFileURL(file).href}?v=${sha256(source).slice(0, 12)}`)) as { default?: unknown; extractor?: unknown };
    const ex = (mod.default ?? mod.extractor) as Partial<AnyExtractor> | undefined;
    if (!ex || typeof ex.name !== "string" || typeof ex.version !== "number" || typeof ex.extract !== "function") {
      throw new Error(`плагин ${rel}: ожидается экстрактор { name, version, extract } в default-экспорте`);
    }
    if (registry.has(ex.name)) throw new Error(`плагин ${rel}: экстрактор «${ex.name}» уже есть`);
    const builtinVersions = [`format:${PLUGIN_FORMAT}`, ...[...BUILTIN_NAMES].map((n) => `${n}:${registry.get(n)?.version ?? 0}`)].join(",");
    registry.set(ex.name, {
      sourceHash: sha256(`${source}\u0000${builtinVersions}`).slice(0, 16),
      name: ex.name,
      version: ex.version,
      description: ex.description ?? `свой экстрактор из ${rel}`,
      optionsSchema: (ex.optionsSchema ?? z.looseObject({})) as AnyExtractor["optionsSchema"],
      extract: ex.extract.bind(ex),
    });
  }
  return registry;
}

/**
 * Функции ядра для своего экстрактора (третий аргумент extract). `run` вызывает только встроенные
 * экстракторы — с общими параметрами конфига, как при обычном выборе.
 */
export function createKit(registry: ReadonlyMap<string, AnyExtractor>, config: Config): ExtractorKit {
  return {
    chunk: (fields) => makeChunk({ ...fields, refs: fields.refs ?? [] }),
    ids: () => new IdAllocator(),
    slugify,
    frontmatter: parseFrontmatter,
    z,
    async run(name: string, file: SourceFile, options: Record<string, unknown> = {}): Promise<ExtractResult> {
      const ex = BUILTIN_NAMES.has(name) ? registry.get(name) : undefined;
      if (!ex) throw new Error(`kit.run: встроенного экстрактора «${name}» нет; есть: ${[...BUILTIN_NAMES].join(", ")}`);
      const parsed = (ex.optionsSchema as z.ZodType).parse({ ...globalOptionsFor(name, config), ...options }) as Record<string, unknown>;
      return ex.extract(file, parsed);
    },
  };
}

/** Параметры из общих разделов конфига, которые влияют на записи экстрактора и входят в хэш параметров. */
export function globalOptionsFor(name: string, config: Config): Record<string, unknown> {
  if (name === "markdown") return { ...config.chunking };
  return {};
}
