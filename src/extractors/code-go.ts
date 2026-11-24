import { z } from "zod";
import { IdAllocator } from "./common.ts";
import { KEY_RE } from "./code-ts.ts";
import type { CodeKeyRecord, Extractor, RawImportRecord, SourceFile, SymbolRecord } from "./types.ts";

/**
 * Экстрактор Go без внешних парсеров: лексер и разбор объявлений верхнего уровня.
 * Тела функций не разбираются, из них берутся только строковые литералы с контекстом.
 */
export const GoOptions = z.strictObject({
  comments: z.boolean().default(true),
  keys: z.boolean().default(true),
});
export type GoOptions = z.infer<typeof GoOptions>;

export const goExtractor: Extractor<GoOptions> = {
  name: "code-go",
  version: 7,
  description: "Go: функции, методы (`Type.Method`), типы, константы и переменные пакета, doc-комментарии, импорты, строковые ключи.",
  optionsSchema: GoOptions,
  extract(file, options) {
    return { kind: "code", code: extractGo(file, options) };
  },
};

type TokType = "ident" | "string" | "rawstring" | "rune" | "number" | "op" | "comment" | "newline";
interface Tok {
  t: TokType;
  v: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
}

const MAX_SIGNATURE = 400;
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const GENERATED_GO_RE = /^\/\/ Code generated .* DO NOT EDIT\.$/m;
/** Тест-функции пакета testing: `TestXxx`, `BenchmarkXxx`, `FuzzXxx`, `ExampleXxx`. */
const GO_TEST_FUNC_RE = /^(Test|Benchmark|Fuzz|Example)([A-Z_0-9]|$)/;

export function tokenizeGo(text: string): Tok[] {
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const push = (t: TokType, start: number, end: number, startLine: number) =>
    toks.push({ t, v: text.slice(start, end), start, end, line: startLine, endLine: line });
  while (i < n) {
    const c = text[i] as string;
    if (c === "\n") {
      push("newline", i, i + 1, line);
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    const startLine = line;
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      const end = e < 0 ? n : e;
      push("comment", i, end, startLine);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      for (let k = i; k < end; k++) if (text[k] === "\n") line++;
      push("comment", i, end, startLine);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      push(c === '"' ? "string" : "rune", i, end, startLine);
      i = end;
      continue;
    }
    if (c === "`") {
      const e = text.indexOf("`", i + 1);
      const end = e < 0 ? n : e + 1;
      for (let k = i; k < end; k++) if (text[k] === "\n") line++;
      push("rawstring", i, end, startLine);
      i = end;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_]/u.test(text[j] as string)) j++;
      push("ident", i, j, startLine);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j] as string)) {
        if (/[eEpP]/.test(text[j] as string) && /[+-]/.test(text[j + 1] ?? "")) j++;
        j++;
      }
      push("number", i, j, startLine);
      i = j;
      continue;
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    const op = three === "..." ? three : [":=", "<-", "&&", "||", "==", "!=", "<=", ">=", "++", "--"].includes(two) ? two : c;
    push("op", i, i + op.length, startLine);
    i += op.length;
  }
  return toks;
}

function unquote(tok: Tok): string {
  if (tok.t === "rawstring") return tok.v.slice(1, -1);
  try {
    return JSON.parse(tok.v) as string;
  } catch {
    return tok.v.slice(1, -1);
  }
}

const collapse = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_SIGNATURE ? `${t.slice(0, MAX_SIGNATURE - 1)}…` : t;
};
const isExportedName = (name: string) => /^\p{Lu}/u.test(name);

export function extractGo(file: SourceFile, options: GoOptions) {
  const text = file.text;
  const all = tokenizeGo(text);
  const comments = all.filter((t) => t.t === "comment");
  const toks = all.filter((t) => t.t !== "comment");
  const isOp = (k: number, v: string) => toks[k]?.t === "op" && toks[k]?.v === v;
  const isIdent = (k: number, v?: string) => toks[k]?.t === "ident" && (v === undefined || toks[k]?.v === v);

  const pkgIdx = toks.findIndex((t) => t.t === "ident" && t.v === "package");
  const beforePackage = pkgIdx >= 0 ? text.slice(0, toks[pkgIdx]?.start ?? 0) : text.slice(0, 2000);
  const generated = GENERATED_GO_RE.test(beforePackage);
  const withComments = options.comments && !generated;
  const isTest = file.path.endsWith("_test.go");

  const symbols: SymbolRecord[] = [];
  const imports: RawImportRecord[] = [];
  const keys: CodeKeyRecord[] = [];
  const naturalText = new Map<string, string[]>();
  const ids = new IdAllocator();
  let unitName: string | null = null;

  // Комментарии по последней строке: doc-комментарий — непрерывная цепочка над объявлением.
  const commentByEndLine = new Map<number, Tok>();
  for (const c of comments) commentByEndLine.set(c.endLine, c);
  const docFor = (line: number): string => {
    if (!withComments) return "";
    const parts: string[] = [];
    let l = line - 1;
    let c = commentByEndLine.get(l);
    while (c && !hasCodeOnLine(c.line, c.start)) {
      parts.unshift(cleanGoComment(c.v));
      l = c.line - 1;
      c = commentByEndLine.get(l);
    }
    return parts.join("\n").trim().slice(0, 1200);
  };
  const firstTokOnLine = new Map<number, number>();
  for (const t of toks) if (t.t !== "newline" && !firstTokOnLine.has(t.line)) firstTokOnLine.set(t.line, t.start);
  function hasCodeOnLine(line: number, before: number): boolean {
    const s = firstTokOnLine.get(line);
    return s !== undefined && s < before;
  }

  const matchClose = (k: number): number => {
    const open = toks[k]?.v ?? "";
    const close = OPEN[open];
    let depth = 0;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j] as Tok;
      if (t.t !== "op") continue;
      if (t.v === open) depth++;
      else if (t.v === close) {
        depth--;
        if (depth === 0) return j;
      }
    }
    return toks.length - 1;
  };
  /** Конец конструкции: перевод строки или `;` на нулевой глубине (скобки пропускаются целиком). */
  const endOfSpec = (k: number, stop: number): number => {
    let j = k;
    while (j < stop) {
      const t = toks[j] as Tok;
      if (t.t === "newline" || (t.t === "op" && t.v === ";")) return j;
      if (t.t === "op" && OPEN[t.v]) {
        j = matchClose(j) + 1;
        continue;
      }
      j++;
    }
    return stop;
  };

  const addSymbol = (name: string, qualified: string, kind: string, signature: string, startTok: Tok, endTok: Tok, docLine: number) => {
    const id = ids.take(`${file.path}#${qualified}`);
    symbols.push({
      id,
      name,
      qualified,
      kind,
      signature: collapse(signature),
      comment: docFor(docLine),
      lineStart: startTok.line,
      lineEnd: endTok.endLine,
      exported: isExportedName(name),
    });
    return id;
  };

  const collectKeys = (from: number, to: number, symbolId: string | null, fallbackContext: string) => {
    if (!options.keys) return;
    for (let k = from; k <= to && k < toks.length; k++) {
      const t = toks[k] as Tok;
      if (t.t !== "string" && t.t !== "rawstring") continue;
      let value = unquote(t);
      // Сообщения и тексты ошибок («пустой кадр») — только для поиска, по функции, где они стоят.
      if (symbolId && /\s/.test(value) && /\p{L}{2}/u.test(value) && value.length <= 200) {
        const list = naturalText.get(symbolId) ?? [];
        const clean = value.replace(/%[-+# 0-9.]*[a-zA-Z]/g, " ").replace(/\s+/g, " ").trim();
        if (!list.includes(clean) && list.join(" ").length < 800) list.push(clean);
        naturalText.set(symbolId, list);
      }
      let pattern = false;
      if (/%[-+# 0-9.]*[a-zA-Z]/.test(value)) {
        value = value.replace(/%[-+# 0-9.]*[a-zA-Z]/g, "*");
        pattern = true;
      }
      if (isOp(k + 1, "+")) {
        value = `${value}*`;
        pattern = true;
      }
      if (isOp(k - 1, "+")) {
        value = `*${value}`;
        pattern = true;
      }
      if (!KEY_RE.test(value) || !/[A-Za-z]/.test(value)) continue;
      if (pattern && value.replace(/\*/g, "").length < 2) continue;
      keys.push({ value, line: t.line, context: contextAt(k) || fallbackContext, symbolId, pattern });
    }
  };

  /** Контекст литерала: вызов, поле составного литерала, присваивание. */
  const contextAt = (k: number): string => {
    const prev = toks[k - 1];
    if (!prev) return "";
    if (prev.t === "ident" && (prev.v === "case" || prev.v === "return")) return prev.v;
    if (prev.t === "op" && prev.v === ":" && toks[k - 2]?.t === "ident") return toks[k - 2]?.v ?? "";
    if (prev.t === "op" && (prev.v === "=" || prev.v === ":=") && toks[k - 2]?.t === "ident") return toks[k - 2]?.v ?? "";
    // Ищем ближайшую незакрытую скобку слева.
    let depth = 0;
    for (let j = k - 1; j >= 0 && j > k - 400; j--) {
      const t = toks[j] as Tok;
      if (t.t !== "op") continue;
      if (t.v === ")" || t.v === "]" || t.v === "}") depth++;
      else if (t.v === "(" || t.v === "[" || t.v === "{") {
        if (depth > 0) {
          depth--;
          continue;
        }
        if (t.v === "(") {
          const chain: string[] = [];
          let m = j - 1;
          while (m >= 0 && toks[m]?.t === "ident") {
            chain.unshift(toks[m]?.v ?? "");
            if (isOp(m - 1, ".")) m -= 2;
            else break;
          }
          return chain.slice(-2).join(".");
        }
        if (t.v === "{") {
          // Составной литерал: имя переменной или поля слева от него.
          let m = j - 1;
          while (m >= 0 && toks[m]?.t !== "newline" && !(toks[m]?.t === "op" && ["=", ":=", ":"].includes(toks[m]?.v ?? ""))) m--;
          if (m >= 1 && toks[m]?.t === "op" && toks[m - 1]?.t === "ident") return toks[m - 1]?.v ?? "";
        }
        return "";
      }
    }
    return "";
  };

  let i = 0;
  while (i < toks.length) {
    const t = toks[i] as Tok;
    if (t.t === "newline" || (t.t === "op" && t.v === ";")) {
      i++;
      continue;
    }
    if (t.t !== "ident") {
      i = endOfSpec(i, toks.length) + 1;
      continue;
    }
    switch (t.v) {
      case "package":
        unitName = toks[i + 1]?.v ?? null;
        i += 2;
        break;
      case "import":
        i = parseImport(i + 1);
        break;
      case "func":
        i = parseFunc(i);
        break;
      case "type":
      case "const":
      case "var":
        i = parseDecl(i, t.v);
        break;
      default:
        i = endOfSpec(i, toks.length) + 1;
    }
  }

  function parseImport(k: number): number {
    const spec = (from: number, to: number) => {
      let alias: string | null = null;
      for (let j = from; j < to; j++) {
        const tk = toks[j] as Tok;
        if (tk.t === "ident" || (tk.t === "op" && (tk.v === "." || tk.v === "_"))) alias = tk.v;
        if (tk.t === "string" || tk.t === "rawstring") {
          imports.push({ specifier: unquote(tk), names: [alias ?? "*"], line: tk.line, kind: "import" });
          return;
        }
      }
    };
    if (isOp(k, "(")) {
      const close = matchClose(k);
      let j = k + 1;
      while (j < close) {
        const end = endOfSpec(j, close);
        spec(j, end);
        j = end + 1;
      }
      return close + 1;
    }
    const end = endOfSpec(k, toks.length);
    spec(k, end);
    return end + 1;
  }

  function parseFunc(k: number): number {
    const start = toks[k] as Tok;
    let j = k + 1;
    let receiver: string | null = null;
    if (isOp(j, "(")) {
      const close = matchClose(j);
      const inner = toks.slice(j + 1, close).filter((x) => x.t !== "newline");
      let p = 0;
      if (inner.length >= 2 && inner[0]?.t === "ident" && (inner[1]?.t === "ident" || (inner[1]?.t === "op" && inner[1]?.v === "*"))) p = 1;
      while (inner[p]?.t === "op" && inner[p]?.v === "*") p++;
      receiver = inner[p]?.t === "ident" ? (inner[p]?.v ?? null) : null;
      j = close + 1;
    }
    if (!isIdent(j)) return endOfSpec(j, toks.length) + 1;
    const name = toks[j]?.v as string;
    j++;
    if (isOp(j, "[")) j = matchClose(j) + 1;
    if (isOp(j, "(")) j = matchClose(j) + 1;
    // Результат: до `{` тела; фигурные скобки `struct{}` и `interface{}` в типе результата пропускаются.
    let bodyOpen = -1;
    while (j < toks.length) {
      const tk = toks[j] as Tok;
      if (tk.t === "newline") break;
      if (tk.t === "op" && tk.v === "{") {
        if (isIdent(j - 1, "struct") || isIdent(j - 1, "interface")) {
          j = matchClose(j) + 1;
          continue;
        }
        bodyOpen = j;
        break;
      }
      if (tk.t === "op" && OPEN[tk.v]) {
        j = matchClose(j) + 1;
        continue;
      }
      j++;
    }
    const sigEnd = bodyOpen >= 0 ? (toks[bodyOpen]?.start ?? start.end) : (toks[j - 1]?.end ?? start.end);
    const signature = text.slice(start.start, sigEnd);
    const qualified = receiver ? `${receiver}.${name}` : name;
    const bodyClose = bodyOpen >= 0 ? matchClose(bodyOpen) : j - 1;
    const endTok = toks[Math.max(bodyClose, k)] as Tok;
    const isTestFunc = isTest && !receiver && GO_TEST_FUNC_RE.test(name);
    const id = addSymbol(name, qualified, receiver ? "method" : isTestFunc ? "test" : "function", signature, start, endTok, start.line);
    if (bodyOpen >= 0) {
      const keysBefore = keys.length;
      collectKeys(bodyOpen, bodyClose, id, "");
      if (isTestFunc) {
        const subtests = parseSubtests(bodyOpen, bodyClose, name);
        // Литерал внутри подтеста принадлежит самому глубокому подтесту, который его содержит.
        for (const key of keys.slice(keysBefore)) {
          let best: { id: string; from: number; to: number } | null = null;
          for (const s of subtests) if (key.line >= s.from && key.line <= s.to && (!best || s.to - s.from <= best.to - best.from)) best = s;
          if (best) key.symbolId = best.id;
        }
      }
    }
    return bodyClose + 1;
  }

  /**
   * Подтесты `t.Run("название", func(t *testing.T) {…})` внутри тест-функции: символы `test` с цепочкой
   * «TestXxx › подтест › вложенный». Название не литерал (`t.Run(tc.name, …)`) — символа нет, вложенные
   * подтесты цепляются к ближайшему известному родителю.
   */
  function parseSubtests(from: number, to: number, testName: string): Array<{ id: string; from: number; to: number }> {
    const calls: Array<{ title: string | null; startTok: Tok; open: number; close: number }> = [];
    for (let k = from; k < to; k++) {
      if (!(isIdent(k, "Run") && isOp(k - 1, ".") && isOp(k + 1, "("))) continue;
      const recv = toks[k - 2];
      if (!recv || !(recv.t === "ident" || (recv.t === "op" && recv.v === ")"))) continue;
      const arg = toks[k + 2];
      const title = arg && (arg.t === "string" || arg.t === "rawstring") && (isOp(k + 3, ",") || isOp(k + 3, ")")) ? unquote(arg) : null;
      calls.push({ title, startTok: recv.t === "ident" ? recv : (toks[k] as Tok), open: k + 1, close: matchClose(k + 1) });
    }
    const out: Array<{ id: string; from: number; to: number }> = [];
    const stack: Array<{ title: string | null; close: number }> = [];
    for (const c of calls) {
      while (stack.length && (stack[stack.length - 1]?.close ?? 0) < c.open) stack.pop();
      if (c.title === null) {
        // Табличный подтест: имена случаев — литералы таблицы. Случай — символ на строке, где он объявлен;
        // код у случаев общий, поэтому литералы внутри замыкания остаются у тест-функции.
        const parents = stack.map((s) => s.title).filter((t): t is string => t !== null);
        for (const tc of tableCaseNames(from, c.open)) {
          const qualified = [testName, ...parents, tc.name.replace(/\s+/g, " ").trim()].join(" › ");
          symbols.push({
            id: ids.take(`${file.path}#${qualified}`),
            name: tc.name,
            qualified,
            kind: "test",
            signature: `t.Run(${text.slice(toks[c.open + 1]?.start ?? 0, toks[argEnd(c.open)]?.start ?? 0).trim()}) — случай таблицы ${JSON.stringify(tc.name)}`,
            comment: docFor(tc.tok.line),
            lineStart: tc.tok.line,
            lineEnd: tc.tok.endLine,
            exported: false,
          });
        }
      }
      if (c.title !== null) {
        const chain = [testName, ...stack.map((s) => s.title).filter((t): t is string => t !== null), c.title.replace(/\s+/g, " ").trim()];
        const qualified = chain.join(" › ");
        const endTok = toks[c.close] as Tok;
        const id = ids.take(`${file.path}#${qualified}`);
        symbols.push({
          id,
          name: c.title,
          qualified,
          kind: "test",
          signature: `${toks[c.open - 3]?.t === "ident" ? (toks[c.open - 3]?.v ?? "t") : "t"}.Run(${JSON.stringify(c.title)})`,
          comment: docFor(c.startTok.line),
          lineStart: c.startTok.line,
          lineEnd: endTok.endLine,
          exported: false,
        });
        out.push({ id, from: c.startTok.line, to: endTok.endLine });
      }
      stack.push({ title: c.title, close: c.close });
    }
    return out;
  }

  /** Конец первого аргумента вызова: `,` или `)` на глубине вызова. */
  function argEnd(open: number): number {
    let j = open + 1;
    while (j < toks.length && !isOp(j, ",") && !isOp(j, ")")) j = toks[j]?.t === "op" && OPEN[toks[j]?.v ?? ""] ? matchClose(j) + 1 : j + 1;
    return j;
  }

  /** Строковые элементы составного литерала с открывающей `{` в позиции open: значения или ключи словаря. */
  function literalStrings(open: number, keys: boolean): Tok[] {
    const close = matchClose(open);
    const out: Tok[] = [];
    let depth = 0;
    for (let j = open; j <= close; j++) {
      const tk = toks[j] as Tok;
      if (tk.t === "op" && OPEN[tk.v]) depth++;
      else if (tk.t === "op" && (tk.v === "}" || tk.v === ")" || tk.v === "]")) depth--;
      else if (depth === 1 && (tk.t === "string" || tk.t === "rawstring")) {
        const next = toks[j + 1];
        const isKey = next?.t === "op" && next.v === ":";
        const prevOk = isOp(j - 1, "{") || isOp(j - 1, ",") || toks[j - 1]?.t === "newline";
        if (prevOk && isKey === keys && (keys || isOp(j + 1, ",") || isOp(j + 1, "}") || toks[j + 1]?.t === "newline")) out.push(tk);
      }
    }
    return out;
  }

  /**
   * Составной литерал, который начинается с позиции j: `[]string{…}`, `map[string]T{…}`, `[]struct{…}{…}`.
   * Возвращает позицию его `{` и признак словаря; тип пропускается, тело `struct{…}` — тоже.
   */
  function compositeLiteral(j: number, stop: number): { open: number; isMap: boolean; structOpen: number | null } | null {
    // Литерал среза или словаря начинается с типа `[]T` или `map[K]V`; иначе это не литерал (`range configs {`).
    if (!isOp(j, "[") && !isIdent(j, "map")) return null;
    let isMap = false;
    let structOpen: number | null = null;
    for (let m = j; m < stop; m++) {
      const tk = toks[m];
      if (!tk || tk.t === "newline") return null;
      if (tk.t === "ident" && tk.v === "map") isMap = true;
      if (isOp(m, "[")) {
        m = matchClose(m);
        continue;
      }
      if (isOp(m, "{")) {
        if (isIdent(m - 1, "struct") || isIdent(m - 1, "interface")) {
          if (isIdent(m - 1, "struct")) structOpen = m;
          m = matchClose(m);
          continue;
        }
        return { open: m, isMap, structOpen };
      }
    }
    return null;
  }

  /** Номер поля в объявлении `struct { name string; a, b int }` (встроенное поле тоже занимает позицию). */
  function structFieldIndex(structOpen: number, field: string): number {
    const close = matchClose(structOpen);
    let idx = 0;
    let j = structOpen + 1;
    while (j < close) {
      if (toks[j]?.t === "newline" || isOp(j, ";")) {
        j++;
        continue;
      }
      const names: string[] = [];
      while (toks[j]?.t === "ident") {
        names.push(toks[j]?.v ?? "");
        if (isOp(j + 1, ",")) j += 2;
        else {
          j++;
          break;
        }
      }
      for (const n of names) {
        if (n === field) return idx;
        idx++;
      }
      j = endOfSpec(j, close) + 1;
    }
    return -1;
  }

  /** Строки таблицы без имён полей: `{"open by staff", "open", …}` — элемент с номером index в каждой строке. */
  function positionalStrings(open: number, index: number): Tok[] {
    const close = matchClose(open);
    const out: Tok[] = [];
    for (let m = open + 1; m < close; m++) {
      if (!isOp(m, "{")) {
        if (toks[m]?.t === "op" && OPEN[toks[m]?.v ?? ""]) m = matchClose(m);
        continue;
      }
      const rowClose = matchClose(m);
      let el = 0;
      let k = m + 1;
      while (k < rowClose && toks[k]?.t === "newline") k++;
      while (k < rowClose && el < index) {
        if (isOp(k, ",")) {
          el++;
          k++;
          while (k < rowClose && toks[k]?.t === "newline") k++;
          continue;
        }
        k = toks[k]?.t === "op" && OPEN[toks[k]?.v ?? ""] ? matchClose(k) + 1 : k + 1;
      }
      const tk = toks[k];
      if (el === index && tk && (tk.t === "string" || tk.t === "rawstring") && (isOp(k + 1, ",") || isOp(k + 1, "}") || toks[k + 1]?.t === "newline")) out.push(tk);
      m = rowClose;
    }
    return out;
  }

  /** Источник цикла `for k, v := range X` над вызовом: литерал X (прямо в цикле или присвоенный выше) и позиция переменной. */
  function rangeSource(bodyStart: number, open: number, v: string): { lit: NonNullable<ReturnType<typeof compositeLiteral>>; pos: number } | null {
    for (let j = open - 1; j >= bodyStart; j--) {
      if (!isIdent(j, "for")) continue;
      let r = j + 1;
      const vars: string[] = [];
      while (r < open && !isIdent(r, "range") && toks[r]?.t !== "newline") {
        if (toks[r]?.t === "ident") vars.push(toks[r]?.v ?? "");
        r++;
      }
      if (!isIdent(r, "range")) continue;
      const pos = vars.indexOf(v);
      if (pos < 0) return null;
      let lit = compositeLiteral(r + 1, open);
      if (!lit && toks[r + 1]?.t === "ident") {
        const name = toks[r + 1]?.v;
        for (let m = bodyStart; m < j && !lit; m++) {
          if (isIdent(m, name) && (isOp(m + 1, ":=") || isOp(m + 1, "="))) lit = compositeLiteral(m + 2, j);
        }
      }
      return lit ? { lit, pos } : null;
    }
    return null;
  }

  /**
   * Имена случаев табличного подтеста по первому аргументу `t.Run`:
   *  - `tc.name` — литералы поля `name: "…"` в теле тест-функции до вызова;
   *  - `status` — переменная цикла `for _, status := range []string{"a", "b"}` или ключ
   *    `for name, h := range cases`, где `cases := map[string]T{"…": …}`.
   */
  function tableCaseNames(bodyStart: number, open: number): Array<{ name: string; tok: Tok }> {
    const a0 = toks[open + 1];
    const end = argEnd(open);
    if (!a0 || a0.t !== "ident") return [];
    const named = (ts: Tok[]) => ts.map((t) => ({ name: unquote(t), tok: t }));
    // tc.name
    if (end === open + 4 && isOp(open + 2, ".") && toks[open + 3]?.t === "ident") {
      const field = toks[open + 3]?.v ?? "";
      // Строки таблицы с именами полей: `{name: "…", …}`.
      const keyed: Tok[] = [];
      for (let j = bodyStart; j < open; j++) {
        const s = toks[j + 2];
        if (isIdent(j, field) && isOp(j + 1, ":") && s && (s.t === "string" || s.t === "rawstring") && (isOp(j - 1, "{") || isOp(j - 1, ",") || toks[j - 1]?.t === "newline")) keyed.push(s);
      }
      if (keyed.length) return named(keyed);
      // Строки без имён полей: позиция поля — из объявления структуры таблицы.
      const src = rangeSource(bodyStart, open, a0.v);
      if (!src || src.pos !== 1 || src.lit.isMap || src.lit.structOpen === null) return [];
      const index = structFieldIndex(src.lit.structOpen, field);
      return index < 0 ? [] : named(positionalStrings(src.lit.open, index));
    }
    if (end !== open + 2) return [];
    // Переменная цикла: словарь — имя случая в ключе (первая переменная), срез — в значении (вторая).
    const src = rangeSource(bodyStart, open, a0.v);
    if (!src) return [];
    if (src.lit.isMap && src.pos === 0) return named(literalStrings(src.lit.open, true));
    if (!src.lit.isMap && src.pos === 1) return named(literalStrings(src.lit.open, false));
    return [];
  }

  function parseDecl(k: number, kw: string): number {
    const declTok = toks[k] as Tok;
    if (isOp(k + 1, "(")) {
      const close = matchClose(k + 1);
      let j = k + 2;
      let lastType: string | null = null;
      while (j < close) {
        if (toks[j]?.t === "newline" || isOp(j, ";")) {
          j++;
          continue;
        }
        const end = endOfSpec(j, close);
        lastType = parseSpec(kw, j, end, declTok, lastType);
        j = end + 1;
      }
      return close + 1;
    }
    const end = endOfSpec(k + 1, toks.length);
    parseSpec(kw, k + 1, end, declTok, null, true);
    return end + 1;
  }

  /** Одна спецификация `type`, `const` или `var`. Возвращает тип (для групп const с iota). */
  function parseSpec(kw: string, from: number, to: number, declTok: Tok, _prevType: string | null, single = false): string | null {
    const first = toks[from];
    if (!first) return null;
    const last = toks[Math.max(from, to - 1)] as Tok;
    const specText = text.slice(single ? declTok.start : first.start, last.end);
    const docLine = single ? declTok.line : first.line;
    if (kw === "type") {
      if (first.t !== "ident") return null;
      const name = first.v;
      let j = from + 1;
      if (isOp(j, "[") && toks[j + 1]?.t === "ident" && (toks[j + 2]?.t === "ident" || isOp(j + 2, ","))) j = matchClose(j) + 1;
      let kind = "type";
      if (isOp(j, "=")) kind = "alias";
      else if (isIdent(j, "struct")) kind = "struct";
      else if (isIdent(j, "interface")) kind = "interface";
      const id = addSymbol(name, name, kind, specText, single ? declTok : first, last, docLine);
      if (kind === "interface" && isOp(j + 1, "{")) {
        const close = matchClose(j + 1);
        let m = j + 2;
        while (m < close) {
          const end = endOfSpec(m, close);
          if (toks[m]?.t === "ident" && isOp(m + 1, "(")) {
            const mt = toks[m] as Tok;
            const methodLast = toks[Math.max(m, end - 1)] as Tok;
            const mid = ids.take(`${file.path}#${name}.${mt.v}`);
            symbols.push({
              id: mid,
              name: mt.v,
              qualified: `${name}.${mt.v}`,
              kind: "method",
              signature: collapse(text.slice(mt.start, methodLast.end)),
              comment: docFor(mt.line),
              lineStart: mt.line,
              lineEnd: methodLast.endLine,
              exported: isExportedName(mt.v),
            });
          }
          m = end + 1;
        }
      }
      collectKeys(from, to, id, name);
      return null;
    }
    // const / var: имена через запятую в начале спецификации.
    const names: Tok[] = [];
    let j = from;
    while (toks[j]?.t === "ident") {
      names.push(toks[j] as Tok);
      if (isOp(j + 1, ",")) j += 2;
      else break;
    }
    let firstId: string | null = null;
    for (const nt of names) {
      if (nt.v === "_") continue;
      const id = addSymbol(nt.v, nt.v, kw === "const" ? "const" : "variable", specText, single ? declTok : first, last, docLine);
      firstId ??= id;
    }
    collectKeys(from, to, firstId, names[0]?.v ?? "");
    return null;
  }

  // Ключи данных — имена из тегов полей структур: `json:"organizationIds,omitempty"`.
  const dataKeys = new Set<string>();
  for (const t of toks) {
    if (t.t !== "rawstring") continue;
    for (const m of t.v.matchAll(/\b(?:json|yaml|db):"([^",]+)/g)) if (m[1] && m[1] !== "-") dataKeys.add(m[1]);
  }

  for (const s of symbols) {
    const texts = naturalText.get(s.id);
    if (texts?.length) s.searchText = texts.join("\n");
  }
  return { lang: "go" as const, isTest, generated, unitName, symbols, imports, keys, dataKeys: [...dataKeys].sort() };
}

function cleanGoComment(raw: string): string {
  if (raw.startsWith("//")) return raw.replace(/^\/\/\s?/, "").trimEnd();
  return raw
    .replace(/^\/\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd())
    .join("\n")
    .trim();
}
