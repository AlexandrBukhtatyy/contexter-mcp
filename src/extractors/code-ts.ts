import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { IdAllocator } from "./common.ts";
import type { CodeKeyRecord, Extractor, RawImportRecord, SourceFile, SymbolRecord } from "./types.ts";

export const CodeOptions = z.strictObject({
  /** Брать комментарии над символами. Для сгенерированного кода выключается автоматически. */
  comments: z.boolean().default(true),
  /** Регулярное выражение пути тестового файла. */
  test_pattern: z.string().default("(^|/)(__tests__|tests?|e2e)/|\\.(spec|test|e2e-spec)\\.[cm]?[jt]sx?$"),
  /** Собирать строковые ключи (operationId, адреса каналов) для связей с контрактами. */
  keys: z.boolean().default(true),
});
export type CodeOptions = z.infer<typeof CodeOptions>;

export const GENERATED_RE = /auto-generated|Code generated .* DO NOT EDIT|DO NOT EDIT|@generated/i;
export const KEY_RE = /^[A-Za-z0-9_.:/>*{}@#-]{2,160}$/;
/** Методы HTTP-клиентов в тестах (supertest, Playwright `request`): вызов с путём — обращение к операции. */
const HTTP_CALL_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/** Вызовы, которые объявляют тест или набор: jest, vitest, mocha, node:test, Playwright. Шаги `test.step` — нет. */
const TEST_CALL_RE = /^(describe|it|test|suite|context)(\.(describe|only|skip|todo|each|concurrent|serial|parallel|fixme|fail|slow))*$/;
/** Тестовое имя файла: тестом считается и без найденных тест-кейсов (тесты в цикле с вычисляемыми названиями). */
const TEST_FILE_NAME_RE = /\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/;
const MAX_SIGNATURE = 400;
const MAX_COMMENT = 1200;

export const codeExtractor: Extractor<CodeOptions> = {
  name: "code",
  version: 8,
  description: "TS/JS: символы, сигнатуры, комментарии, импорты и строковые ключи — TypeScript Compiler API без проверки типов.",
  optionsSchema: CodeOptions,
  extract(file, options) {
    return { kind: "code", code: extractTs(file, options) };
  },
};

function scriptKind(p: string): ts.ScriptKind {
  const ext = path.posix.extname(p).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const collapse = (s: string, max = MAX_SIGNATURE) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function extractTs(file: SourceFile, options: CodeOptions) {
  const kind = scriptKind(file.path);
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
  const text = file.text;
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const head = text.split("\n", 6).join("\n");
  const generated = GENERATED_RE.test(head);
  const withComments = options.comments && !generated;
  // Файл по пути тестовый (`test_pattern`). Тестом он считается, если в нём есть тест-кейсы или имя
  // тестовое (`.spec.ts`); иначе это вспомогательный код тестов (`tests/unique.ts`, `tests/quality/config.ts`):
  // его правят как обычный код, поэтому он ищется и попадает в пакет наравне с основным.
  const inTestPath = new RegExp(options.test_pattern).test(file.path);
  let isTest = inTestPath;
  const isJsx = kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX;

  const symbols: SymbolRecord[] = [];
  const imports: RawImportRecord[] = [];
  const keys: CodeKeyRecord[] = [];
  const ids = new IdAllocator();
  const exportedNames = new Set<string>();

  const commentOf = (node: ts.Node): string => {
    if (!withComments) return "";
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
    if (!ranges.length) return "";
    // Берём только комментарии, примыкающие к объявлению без пустой строки.
    const attached: ts.CommentRange[] = [];
    let nextStart = node.getStart(sf);
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i] as ts.CommentRange;
      const gap = text.slice(r.end, nextStart);
      if ((gap.match(/\n/g) ?? []).length > 1) break;
      attached.unshift(r);
      nextStart = r.pos;
    }
    const raw = attached.map((r) => text.slice(r.pos, r.end)).join("\n");
    return cleanComment(raw).slice(0, MAX_COMMENT);
  };

  const addSymbol = (node: ts.Node, name: string, qualified: string, symKind: string, signature: string, exported: boolean) => {
    const id = ids.take(`${file.path}#${qualified}`);
    symbols.push({
      id,
      name,
      qualified,
      kind: symKind,
      signature: collapse(signature),
      comment: commentOf(node),
      lineStart: lineOf(node.getStart(sf)),
      lineEnd: lineOf(node.getEnd()),
      exported,
    });
    return id;
  };

  const hasModifier = (node: ts.Node, k: ts.SyntaxKind) =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === k) ?? false;
  const isExported = (node: ts.Node) => hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const isPascal = (n: string) => /^[A-Z][A-Za-z0-9]*$/.test(n);
  const decoratorsText = (node: ts.Node) => {
    const decs = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    return decs
      .map((d) => {
        const t = d.getText(sf);
        return t.length <= 80 ? t : `@${d.expression.getText(sf).split("(")[0]}(…)`;
      })
      .join(" ");
  };
  const sliceSig = (from: number, to: number) => text.slice(from, to).replace(/[{=]\s*$/, "");

  // symbolSpans: для ключей — какому символу принадлежит позиция.
  const spans: Array<{ start: number; end: number; id: string }> = [];

  for (const stmt of sf.statements) {
    const exported = isExported(stmt);
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const sig = sliceSig(stmt.getStart(sf), stmt.body ? stmt.body.getStart(sf) : stmt.getEnd());
      const id = addSymbol(stmt, name, name, isJsx && isPascal(name) ? "component" : "function", sig, exported);
      spans.push({ start: stmt.getStart(sf), end: stmt.getEnd(), id });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const classSig = sliceSig(stmt.getStart(sf), stmt.members.pos);
      const classId = addSymbol(stmt, name, name, "class", classSig, exported);
      for (const m of stmt.members) {
        const memberName = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null;
        if (!memberName) continue;
        const priv = hasModifier(m, ts.SyntaxKind.PrivateKeyword) || hasModifier(m, ts.SyntaxKind.ProtectedKeyword);
        let memberKind: string | null = null;
        let bodyStart = m.getEnd();
        if (ts.isMethodDeclaration(m)) {
          memberKind = "method";
          if (m.body) bodyStart = m.body.getStart(sf);
        } else if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) {
          memberKind = "method";
          bodyStart = m.initializer.body.getStart(sf);
        } else if (ts.isGetAccessorDeclaration(m)) {
          memberKind = "getter";
          if (m.body) bodyStart = m.body.getStart(sf);
        }
        if (!memberKind) continue;
        const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
        const sigStart = mods?.[0]?.getStart(sf) ?? m.name?.getStart(sf) ?? m.getStart(sf);
        const decos = decoratorsText(m);
        const sig = `${decos ? `${decos} ` : ""}${sliceSig(sigStart, bodyStart)}`;
        const id = addSymbol(m, memberName, `${name}.${memberName}`, memberKind, sig, exported && !priv);
        spans.push({ start: m.getStart(sf), end: m.getEnd(), id });
      }
      spans.push({ start: stmt.getStart(sf), end: stmt.getEnd(), id: classId });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      addSymbol(stmt, stmt.name.text, stmt.name.text, "interface", stmt.getText(sf), exported);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      addSymbol(stmt, stmt.name.text, stmt.name.text, "type", stmt.getText(sf), exported);
    } else if (ts.isEnumDeclaration(stmt)) {
      const id = addSymbol(stmt, stmt.name.text, stmt.name.text, "enum", stmt.getText(sf), exported);
      spans.push({ start: stmt.getStart(sf), end: stmt.getEnd(), id });
    } else if (ts.isVariableStatement(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        let symKind = isConst ? "const" : "variable";
        let sigEnd = Math.min(decl.getEnd(), decl.getStart(sf) + 300);
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          symKind = isJsx && isPascal(name) ? "component" : "function";
          sigEnd = init.body.getStart(sf);
        } else if (init && ts.isClassExpression(init)) {
          symKind = "class";
        }
        const keyword = isConst ? "const" : "let";
        const sig = `${exported ? "export " : ""}${keyword} ${sliceSig(decl.getStart(sf), sigEnd)}`;
        // Комментарий берётся у всего объявления, а строки — у самого символа.
        const id = ids.take(`${file.path}#${name}`);
        symbols.push({
          id,
          name,
          qualified: name,
          kind: symKind,
          signature: collapse(sig),
          comment: commentOf(stmt),
          lineStart: lineOf(stmt.getStart(sf)),
          lineEnd: lineOf(decl.getEnd()),
          exported,
        });
        spans.push({ start: decl.getStart(sf), end: decl.getEnd(), id });
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) exportedNames.add((el.propertyName ?? el.name).text);
    } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      exportedNames.add(stmt.expression.text);
    }
  }
  for (const s of symbols) if (!s.exported && exportedNames.has(s.qualified)) s.exported = true;

  // Тест-кейсы: `describe`/`it`/`test` (и `test.describe` Playwright, `it.each(...)("…")`) — символы
  // с цепочкой названий «набор › тест». Названия часто ссылаются на ADR, истории и эндпоинты.
  if (inTestPath) {
    const titleOf = (arg: ts.Expression | undefined): string | null => {
      if (!arg) return null;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
      if (ts.isTemplateExpression(arg)) return arg.head.text + arg.templateSpans.map((s) => `\${…}${s.literal.text}`).join("");
      return null;
    };
    const walkTests = (node: ts.Node, chain: string[]) => {
      if (ts.isCallExpression(node)) {
        const calleeNode = ts.isCallExpression(node.expression) ? node.expression.expression : node.expression;
        const callee = calleeNode.getText(sf).replace(/\s+/g, "");
        const title = TEST_CALL_RE.test(callee) ? titleOf(node.arguments[0]) : null;
        if (title !== null) {
          const isSuite = /^(describe|suite|context)\b|\.describe\b/.test(callee);
          const qualified = [...chain, title.replace(/\s+/g, " ").trim()].join(" › ");
          const owner = node.parent && ts.isExpressionStatement(node.parent) ? node.parent : node;
          const id = ids.take(`${file.path}#${qualified}`);
          symbols.push({
            id,
            name: title,
            qualified,
            kind: isSuite ? "suite" : "test",
            signature: collapse(`${callee}(${JSON.stringify(title)})`),
            comment: commentOf(owner),
            lineStart: lineOf(node.getStart(sf)),
            lineEnd: lineOf(node.getEnd()),
            exported: false,
          });
          spans.push({ start: node.getStart(sf), end: node.getEnd(), id });
          for (const a of node.arguments.slice(1)) walkTests(a, isSuite ? qualified.split(" › ") : chain);
          return;
        }
      }
      ts.forEachChild(node, (c) => walkTests(c, chain));
    };
    walkTests(sf, []);
    isTest = TEST_FILE_NAME_RE.test(file.path) || symbols.some((s) => s.kind === "suite" || s.kind === "test");
  }

  // Импорты и ключи — обходом всего дерева.
  const symbolAt = (pos: number): string | null => {
    let best: { start: number; end: number; id: string } | null = null;
    for (const s of spans) if (pos >= s.start && pos < s.end && (!best || s.end - s.start < best.end - best.start)) best = s;
    return best?.id ?? null;
  };
  const moduleSpecifierNodes = new Set<ts.Node>();
  const dataKeys = new Set<string>();
  // Видимые тексты (подписи JSX, сообщения, тексты ошибок) — только для поиска, по символу, где они стоят.
  const naturalText = new Map<string, string[]>();
  const noteText = (pos: number, raw: string) => {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 200 || !/\p{L}{2}/u.test(t)) return;
    const id = symbolAt(pos);
    if (!id) return;
    const list = naturalText.get(id) ?? [];
    if (!list.includes(t) && list.join(" ").length < 800) list.push(t);
    naturalText.set(id, list);
  };
  const isFunctionLike = (n: ts.Node | undefined) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  const propName = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null);

  const visit = (node: ts.Node) => {
    // Ключи данных: поля интерфейсов и типов, поля классов без функций, ключи объектных литералов.
    let dataKey: string | null = null;
    if (ts.isPropertySignature(node) && !(node.type && ts.isFunctionTypeNode(node.type))) dataKey = propName(node.name);
    else if (ts.isPropertyDeclaration(node) && !isFunctionLike(node.initializer)) dataKey = propName(node.name);
    else if (ts.isPropertyAssignment(node) && !isFunctionLike(node.initializer)) dataKey = propName(node.name);
    else if (ts.isShorthandPropertyAssignment(node)) dataKey = node.name.text;
    if (dataKey) dataKeys.add(dataKey);
    if (ts.isJsxText(node)) noteText(node.getStart(sf), node.getText(sf));
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /\s/.test(node.text) && !moduleSpecifierNodes.has(node)) noteText(node.getStart(sf), node.text);
    else if (ts.isTemplateExpression(node)) noteText(node.getStart(sf), [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" … "));

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      moduleSpecifierNodes.add(node.moduleSpecifier);
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push("default");
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
        else for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
      }
      imports.push({ specifier: node.moduleSpecifier.text, names, line: lineOf(node.getStart(sf)), kind: "import" });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      moduleSpecifierNodes.add(node.moduleSpecifier);
      const names =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((el) => (el.propertyName ?? el.name).text)
          : ["*"];
      imports.push({ specifier: node.moduleSpecifier.text, names, line: lineOf(node.getStart(sf)), kind: "export" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) {
        moduleSpecifierNodes.add(expr);
        imports.push({ specifier: expr.text, names: ["*"], line: lineOf(node.getStart(sf)), kind: "require" });
      }
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg)) {
        moduleSpecifierNodes.add(arg);
        imports.push({ specifier: arg.text, names: ["*"], line: lineOf(node.getStart(sf)), kind: isRequire ? "require" : "dynamic" });
      }
      // HTTP-вызов в тесте: `request(app).post("/passes")`, `` .get(`/passes/${id}`) `` → «МЕТОД /путь» для связи с операцией.
      if (inTestPath && options.keys && ts.isPropertyAccessExpression(node.expression) && HTTP_CALL_METHODS.has(node.expression.name.text) && arg) {
        let p: string | null = null;
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) p = arg.text;
        else if (ts.isTemplateExpression(arg)) p = arg.head.text + arg.templateSpans.map((s) => `{}${s.literal.text}`).join("");
        if (p && /^\/[A-Za-z0-9_{]/.test(p)) {
          keys.push({
            value: `${node.expression.name.text.toUpperCase()} ${p.replace(/[?#].*$/, "")}`,
            line: lineOf(node.getStart(sf)),
            context: "http-call",
            symbolId: symbolAt(node.getStart(sf)),
            pattern: false,
          });
        }
      }
    } else if (options.keys && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      if (!moduleSpecifierNodes.has(node) && keyAllowedHere(node)) {
        const value = node.text;
        if (KEY_RE.test(value) && /[A-Za-z]/.test(value)) {
          keys.push({ value, line: lineOf(node.getStart(sf)), context: keyContext(node, sf), symbolId: symbolAt(node.getStart(sf)), pattern: false });
        }
      }
    } else if (options.keys && ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) value += `*${span.literal.text}`;
      if (KEY_RE.test(value) && value.replace(/\*/g, "").length >= 2 && /[A-Za-z]/.test(value)) {
        keys.push({ value, line: lineOf(node.getStart(sf)), context: keyContext(node, sf), symbolId: symbolAt(node.getStart(sf)), pattern: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const s of symbols) {
    const texts = naturalText.get(s.id);
    if (texts?.length) s.searchText = texts.join("\n");
  }

  return {
    lang: kind === ts.ScriptKind.TS || kind === ts.ScriptKind.TSX ? ("ts" as const) : ("js" as const),
    isTest,
    generated,
    unitName: null,
    symbols,
    imports,
    keys,
    dataKeys: [...dataKeys].sort(),
  };
}

function keyAllowedHere(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isLiteralTypeNode(p)) return false;
  if (ts.isJsxAttribute(p)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) return false;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  return true;
}

/** Где стоит литерал: `ApiOperation.operationId`, `publish`, `DEVICE_COMMAND_SUBJECT` … */
export function keyContext(node: ts.Node, sf: ts.SourceFile): string {
  const calleeName = (call: ts.CallExpression) => {
    const t = call.expression.getText(sf).replace(/\s+/g, "");
    const parts = t.split(".");
    return parts.slice(-2).join(".").slice(0, 60);
  };
  let p = node.parent;
  if (p && ts.isArrayLiteralExpression(p)) p = p.parent;
  if (!p) return "";
  if (ts.isPropertyAssignment(p)) {
    const prop = p.name.getText(sf).replace(/["']/g, "");
    const obj = p.parent;
    let owner = obj?.parent;
    while (owner && (ts.isAsExpression(owner) || ts.isSatisfiesExpression(owner) || ts.isParenthesizedExpression(owner))) owner = owner.parent;
    if (owner && ts.isCallExpression(owner)) return `${calleeName(owner)}.${prop}`;
    if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return `${owner.name.text}.${prop}`;
    return prop;
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    return ts.isCallExpression(p) ? calleeName(p) : p.expression.getText(sf).slice(0, 60);
  }
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyDeclaration(p)) return p.name.getText(sf);
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return p.left.getText(sf).split(".").pop()?.slice(0, 60) ?? "";
  }
  if (ts.isReturnStatement(p)) return "return";
  if (ts.isCaseClause(p)) return "case";
  return ts.SyntaxKind[p.kind] ?? "";
}

export function cleanComment(raw: string): string {
  return raw
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\s*\*\s?/, "")
        .replace(/^\s*\/\/\s?/, "")
        .trimEnd(),
    )
    .join("\n")
    .trim();
}
