import { ENDPOINT_RE } from "../links/link.ts";

/**
 * Разбор текста задачи: всё, что можно сопоставить с индексом точно. Сервер не вызывает LLM —
 * только регулярные выражения, поэтому разбор быстрый и воспроизводимый.
 */
export interface ParsedTask {
  paths: Array<{ value: string; line: number | null }>;
  identifiers: string[];
  endpoints: Array<{ method: string; path: string }>;
  /** Тексты ошибок: строки с error/exception/ошибка/panic и фразы в кавычках. */
  errors: string[];
  /** ID документов по `documents.id_refs`: значение и glob пути. */
  docIds: Array<{ value: string; glob: string }>;
  taskIds: string[];
}

const CODE_EXT = "ts|tsx|mts|cts|js|jsx|mjs|cjs|go|md|mdx|ya?ml|json|sql|bru|sh|toml|proto|css|scss|html";
const PATH_RE = new RegExp(`(?:^|[\\s(\`'"«\\[])((?:\\.{0,2}/)?[\\w@.\\-]+(?:/[\\w@.{}\\-\\[\\]]+)*\\.(?:${CODE_EXT}))(?::(\\d+)(?:-\\d+)?)?(?=$|[\\s)\`'",.;:»\\]])`, "gimu");
const BACKTICK_RE = /`([^`\n]{2,120})`/g;
const IDENT_RE = /(?<![\w$./-])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?(?![\w$/-])/g;
const ERROR_LINE_RE = /(error|exception|panic|failed|ошибк|исключени|падает|не удалось|traceback|stack ?trace|\b[45]\d\d\b)/i;
const QUOTED_RE = /[«"“]([^«»"“”\n]{6,200})[»"”]/g;

/** Похоже на идентификатор кода: составное имя, PascalCase, квалифицированное имя или вызов. */
function looksLikeIdentifier(v: string): boolean {
  const core = v.replace(/\(\)$/, "");
  if (core.length < 3) return false;
  if (/^[A-Z0-9_]+$/.test(core) && core.length <= 4) return false; // ADR, HTTP, JSON
  if (core.includes(".")) return core.split(".").every((p) => p.length > 0) && !/^\d/.test(core);
  if (v.endsWith("()")) return true;
  return /[a-z][A-Z]|_[a-z]|^[A-Z][a-z]+[A-Z]/.test(core) || (/^[A-Z][a-z]{3,}/.test(core) && /[A-Z]/.test(core.slice(1)));
}

export function parseTask(text: string, opts: { idRefs?: Array<{ pattern: string; path: string }>; taskIdPattern?: string | null } = {}): ParsedTask {
  const paths: ParsedTask["paths"] = [];
  const seenPaths = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const value = (m[1] ?? "").replace(/^\.\//, "");
    if (!value || seenPaths.has(value) || /^https?:/i.test(value)) continue;
    seenPaths.add(value);
    paths.push({ value, line: m[2] ? Number(m[2]) : null });
  }

  const endpoints: ParsedTask["endpoints"] = [];
  for (const m of text.matchAll(ENDPOINT_RE)) {
    const path = (m[2] ?? "").replace(/[.,:;)]+$/, "");
    if (!endpoints.some((e) => e.method === m[1] && e.path === path)) endpoints.push({ method: m[1] ?? "", path });
  }

  const taskIds = opts.taskIdPattern ? [...new Set([...text.matchAll(new RegExp(opts.taskIdPattern, "gu"))].map((m) => m[0]))] : [];

  const docIds: ParsedTask["docIds"] = [];
  for (const r of opts.idRefs ?? []) {
    for (const m of text.matchAll(new RegExp(r.pattern, "gu"))) {
      const glob = r.path.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "");
      if (!docIds.some((d) => d.value === m[0])) docIds.push({ value: m[0], glob });
    }
  }

  // Идентификаторы: в обратных кавычках — любые похожие на имя; в тексте — только составные.
  const skip = new Set<string>([...seenPaths, ...taskIds, ...docIds.map((d) => d.value)]);
  const identifiers: string[] = [];
  const pushIdent = (v: string, strict: boolean) => {
    const clean = v.trim();
    if (!clean || skip.has(clean) || identifiers.includes(clean)) return;
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/.test(clean)) return;
    if (strict ? !looksLikeIdentifier(clean) : clean.replace(/\(\)$/, "").length < 3) return;
    identifiers.push(clean);
  };
  for (const m of text.matchAll(BACKTICK_RE)) pushIdent(m[1] ?? "", false);
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ");
  for (const m of withoutUrls.matchAll(IDENT_RE)) pushIdent(m[0], true);

  const errors: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && t.length <= 300 && ERROR_LINE_RE.test(t) && !errors.includes(t)) errors.push(t);
  }
  for (const m of text.matchAll(QUOTED_RE)) {
    const q = (m[1] ?? "").trim();
    if (q.includes(" ") && !errors.includes(q)) errors.push(q);
  }

  return { paths, identifiers, endpoints, errors: errors.slice(0, 8), docIds, taskIds };
}
