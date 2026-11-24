import path from "node:path";
import picomatch from "picomatch";
import type { z } from "zod";
import type { LoadedConfig, ResolvedRule } from "../config/load.ts";
import type { Match } from "../config/schema.ts";
import { topLevelKeys } from "../extractors/contracts.ts";
import { parseFrontmatter } from "../extractors/markdown.ts";
import { globalOptionsFor, type AnyExtractor } from "../extractors/registry.ts";
import { sha256, stableStringify } from "../util/text.ts";

export interface Selection {
  extractor: AnyExtractor;
  options: Record<string, unknown>;
  optionsHash: string;
  /** Чем выбран экстрактор — для `explain-file` и `index_status`. */
  reason: string;
  rule: ResolvedRule | null;
}

const matcherCache = new Map<string, (p: string) => boolean>();
function globMatch(pattern: string, p: string): boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    m = picomatch(pattern, { dot: true });
    matcherCache.set(pattern, m);
  }
  return m(p);
}

interface FileView {
  path: string;
  text: string;
}

export function matchRule(match: Match, file: FileView, lazy: { frontmatter(): Record<string, unknown> | null; keys(): Set<string> }): boolean {
  if (match.path && !globMatch(match.path, file.path)) return false;
  if (match.frontmatter) {
    const fm = lazy.frontmatter();
    if (!fm) return false;
    for (const [k, v] of Object.entries(match.frontmatter)) if (String(fm[k]) !== String(v)) return false;
  }
  if (match.has_key && !lazy.keys().has(match.has_key)) return false;
  if (match.content) {
    const head = file.text.split("\n", 50).join("\n");
    if (!new RegExp(match.content, "mu").test(head)) return false;
  }
  return true;
}

/**
 * Порядок разрешения: поле `extractor` в шапке файла → первое подошедшее правило из конфига →
 * встроенные правила (контракты по ключу верхнего уровня) → экстрактор по расширению → файл пропускается.
 */
export function selectExtractor(file: FileView, loaded: LoadedConfig, registry: ReadonlyMap<string, AnyExtractor>): Selection | null {
  const ext = path.posix.extname(file.path).toLowerCase();
  let fm: Record<string, unknown> | null | undefined;
  let keys: Set<string> | undefined;
  const lazy = {
    frontmatter: () => (fm === undefined ? (fm = ext === ".md" || ext === ".markdown" ? parseFrontmatter(file.text) : null) : fm),
    keys: () => (keys ??= ext === ".json" || ext === ".yaml" || ext === ".yml" ? topLevelKeys(file.text, ext) : new Set<string>()),
  };

  const build = (name: string, rawOptions: Record<string, unknown> | undefined, reason: string, rule: ResolvedRule | null): Selection | null => {
    const extractor = registry.get(name);
    if (!extractor) return null;
    const merged = { ...globalOptionsFor(name, loaded.config), ...(rawOptions ?? {}) };
    const options = (extractor.optionsSchema as z.ZodType).parse(merged) as Record<string, unknown>;
    return { extractor, options, optionsHash: sha256(`${stableStringify(options)}${extractor.sourceHash ? `\u0000${extractor.sourceHash}` : ""}`).slice(0, 16), reason, rule };
  };

  const fmExtractor = lazy.frontmatter()?.extractor;
  if (typeof fmExtractor === "string" && registry.has(fmExtractor)) {
    return build(fmExtractor, undefined, "поле extractor в шапке файла", null);
  }
  for (const rule of loaded.rules) {
    if (!matchRule(rule.match, file, lazy)) continue;
    const reason =
      rule.index !== null
        ? `правило ${rule.index}${rule.line ? ` (строка ${rule.line} в ${loaded.file ?? ".mcp/context.yaml"})` : ""}`
        : `встроенное правило: ${describeMatch(rule.match)} → ${rule.use}`;
    return build(rule.use, rule.options, reason, rule);
  }
  const byExt = loaded.defaults[ext];
  if (byExt) return build(byExt, undefined, `по расширению ${ext}`, null);
  return null;
}

function describeMatch(m: Match): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}
