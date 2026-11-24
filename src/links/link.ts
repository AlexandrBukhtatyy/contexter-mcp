import path from "node:path";
import picomatch from "picomatch";
import type { Config, KeyRole } from "../config/schema.ts";
import { normalizeApiPath } from "../store/sqlite/store.ts";
import type {
  ApiItemRow,
  ChunkRow,
  Confidence,
  DocumentRow,
  EntityRow,
  FileRow,
  ImportRow,
  IndexWriter,
  KeyRefRow,
  LinkRow,
  ProblemRow,
  SymbolRow,
  TargetKind,
} from "../store/types.ts";
import { isExternalPath } from "../indexer/files.ts";
import { dirOf, joinRepoPath } from "../util/text.ts";
import type { ProjectInfo } from "./project.ts";

/** Символы-тесты: набор (`describe`), тест (`it`, `test`), HTTP-сценарий Bruno. */
export const TEST_KINDS = new Set(["suite", "test", "http-test"]);

/** Корень внешнего пакета для пути внутри него: `…/node_modules/@scope/name`. */
export function externalRoot(p: string): string | null {
  const m = p.match(/^(.*?node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  return m?.[1] ?? null;
}

/**
 * Шаг связывания: считается целиком после разбора всех изменённых файлов, потому что связи
 * зависят от других файлов (появился файл — ссылка на него перестала быть битой).
 */
export interface LinkStats {
  links: number;
  imports: number;
  keyRefs: number;
  problems: number;
  ms: number;
}

/** Роли по умолчанию: проверяются после ролей из конфига. */
const DEFAULT_ROLES: KeyRole[] = [{ kind: "operation", context: "(^|\\.)operationId$", role: "implements" }];

export const ENDPOINT_RE = /(?<![A-Za-z])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[A-Za-z0-9_\-{:~][A-Za-z0-9_\-./{}:~]*)/g;
const IDENT_FULL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** Расширения файлов, путь с которыми в тексте считается путём в репозитории (для отчёта о битых путях). */
const REPO_FILE_EXT = /\.(md|mdx|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|mod|sum|ya?ml|json|jsonl|sql|sh|ps1|toml|html|css|scss|txt|proto|env|lock|ini|conf|xml|csv|cjs|bru|dockerfile)$/i;

type ChunkLite = Pick<ChunkRow, "id" | "docPath" | "text" | "lineStart" | "lineEnd" | "kind">;

export function runLinking(store: IndexWriter, project: ProjectInfo, config: Config): LinkStats {
  const t0 = Date.now();
  const docs = store.allDocuments();
  const chunks = store.allChunksLite();
  const refs = store.allChunkRefs();
  const files = store.allFiles();
  const symbols = store.allSymbols();
  const rawImports = store.allRawImports();
  const codeKeys = store.allCodeKeys();
  const dataKeyNames = store.dataKeyNames();
  const apiItems = store.allApiItems();
  const entities = store.allEntities();

  const links: LinkRow[] = [];
  const problems: ProblemRow[] = [];
  const brokenPaths: Array<{ paths: string[]; problem: ProblemRow }> = [];
  const keyRefs: KeyRefRow[] = [];
  const linkSeen = new Set<string>();
  const addLink = (l: LinkRow) => {
    const k = `${l.chunkId}\u0000${l.targetKind}\u0000${l.targetId}\u0000${l.source}\u0000${l.role ?? ""}`;
    if (linkSeen.has(k)) return;
    linkSeen.add(k);
    links.push(l);
  };

  // ---------- пакеты и владельцы ----------
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const fileMeta = files.map((f) => {
    if (f.lang === "go") {
      const mod = project.goModuleOf(f.path);
      return { path: f.path, package: mod?.path ?? null, packageDir: mod?.dir ?? null, unit: project.goImportPathOf(dirOf(f.path)), owner: project.ownerOf(f.path) };
    }
    const pkg = project.tsPackageOf(f.path);
    return { path: f.path, package: pkg?.name ?? null, packageDir: pkg?.dir ?? null, unit: pkg?.name ?? null, owner: project.ownerOf(f.path) };
  });
  store.updateFileMeta(fileMeta);
  for (const m of fileMeta) {
    const f = fileByPath.get(m.path);
    if (f) Object.assign(f, m);
  }

  // ---------- импорты ----------
  const goFilesByDir = new Map<string, FileRow[]>();
  for (const f of files) {
    if (f.lang !== "go") continue;
    const d = dirOf(f.path);
    const list = goFilesByDir.get(d) ?? [];
    list.push(f);
    goFilesByDir.set(d, list);
  }
  const imports: ImportRow[] = [];
  for (const imp of rawImports) {
    if (imp.lang === "go") {
      const dir = project.goDirOf(imp.specifier);
      if (dir === null) continue;
      for (const target of goFilesByDir.get(dir) ?? []) {
        if (target.isTest) continue;
        imports.push({ fromFile: imp.fromFile, toFile: target.path, names: imp.names, line: imp.line, kind: imp.kind });
      }
    } else {
      const to = project.resolveTsImport(imp.fromFile, imp.specifier);
      if (to && to !== imp.fromFile) imports.push({ fromFile: imp.fromFile, toFile: to, names: imp.names, line: imp.line, kind: imp.kind });
    }
  }
  store.replaceImports(imports);

  // ---------- документы: тип, статус, скрытие ----------
  const chunksByDoc = new Map<string, ChunkLite[]>();
  for (const c of chunks) {
    const list = chunksByDoc.get(c.docPath) ?? [];
    list.push(c);
    chunksByDoc.set(c.docPath, list);
  }
  const typeRules = config.documents.types.map((t) => ({ m: picomatch(t.path, { dot: true }), type: t.type }));
  const statusRules = config.documents.status.map((s) => ({ m: picomatch(s.path, { dot: true }), re: new RegExp(s.regex, "imu") }));
  const hiddenStatuses = new Set(config.documents.hidden_statuses.map((s) => s.toLowerCase()));
  const docMeta = docs.map((d) => {
    const type = d.typeHint ?? typeRules.find((r) => r.m(d.path))?.type ?? (isExternalPath(d.path) ? "library" : "doc");
    let status = d.statusHint;
    if (!status) {
      const rule = statusRules.find((r) => r.m(d.path));
      if (rule) {
        const head = (chunksByDoc.get(d.path) ?? []).slice(0, 3).map((c) => c.text).join("\n");
        const m = head.match(rule.re);
        if (m?.[1]) status = m[1];
      }
    }
    if (status) {
      const lower = status.trim().toLowerCase();
      status = config.documents.status_map[lower] ?? lower;
    }
    const pkg = project.tsPackageOf(d.path);
    const goMod = project.goModuleOf(d.path);
    const packageDir = [pkg?.dir, goMod?.dir].filter((x): x is string => x !== undefined && x !== "").sort((a, b) => b.length - a.length)[0] ?? null;
    return { path: d.path, type, status: status ?? null, hidden: status ? hiddenStatuses.has(status) : false, package: packageDir };
  });
  store.updateDocumentMeta(docMeta);
  const docByPath = new Map<string, DocumentRow>(docs.map((d) => [d.path, d]));
  for (const m of docMeta) {
    const d = docByPath.get(m.path);
    if (d) Object.assign(d, m);
  }

  // ---------- индексы для разрешения ссылок ----------
  const allPaths = [...project.files];
  const basenameIndex = new Map<string, string[]>();
  for (const p of allPaths) {
    const b = path.posix.basename(p);
    const list = basenameIndex.get(b) ?? [];
    list.push(p);
    basenameIndex.set(b, list);
  }
  const symbolsByName = new Map<string, SymbolRow[]>();
  const symbolsByQualified = new Map<string, SymbolRow[]>();
  const push = (m: Map<string, SymbolRow[]>, k: string, s: SymbolRow) => {
    const list = m.get(k) ?? [];
    list.push(s);
    m.set(k, list);
  };
  const goPackageNames = new Set<string>();
  /** Классы TS и типы Go: `Class.method()` с несуществующим методом — битая ссылка. */
  const typeNames = new Set<string>();
  for (const s of symbols) {
    if (s.isTest) continue;
    push(symbolsByName, s.name, s);
    if (s.qualified !== s.name) push(symbolsByQualified, s.qualified, s);
    const f = fileByPath.get(s.file);
    if (f?.lang === "go" && f.unitName) {
      goPackageNames.add(f.unitName);
      push(symbolsByQualified, `${f.unitName}.${s.qualified}`, s);
    }
    if (s.kind === "class" || s.kind === "struct") typeNames.add(s.name);
  }
  const operationsByEndpoint = new Map<string, ApiItemRow[]>();
  const operationTemplates: Array<{ item: ApiItemRow; method: string; segments: string[] }> = [];
  const channelsByAddress = new Map<string, ApiItemRow>();
  const componentByDocKey = new Map<string, ApiItemRow>();
  for (const a of apiItems) {
    if (a.kind === "operation" && a.method && a.pathNorm) {
      const k = `${a.method} ${a.pathNorm}`;
      operationsByEndpoint.set(k, [...(operationsByEndpoint.get(k) ?? []), a]);
      operationTemplates.push({ item: a, method: a.method, segments: a.pathNorm.split("/") });
    } else if (a.kind === "channel" && a.address) {
      channelsByAddress.set(a.address, a);
    }
    componentByDocKey.set(`${a.docPath}\u0000${a.chunkId.slice(a.chunkId.indexOf("#") + 1)}`, a);
  }
  const hasContracts = operationTemplates.length > 0;
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const firstChunkOfDoc = new Map<string, string>();
  for (const [p, list] of chunksByDoc) if (list[0]) firstChunkOfDoc.set(p, list[0].id);

  const nearest = <T>(candidates: T[], from: string, pathOf: (t: T) => string): T | undefined => {
    let best: T | undefined;
    let bestScore = -1;
    for (const c of candidates) {
      const score = commonPrefixDepth(from, pathOf(c));
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  };
  const limit = config.links.ambiguous_limit;

  /** Имя символа → связь: уникальное имя — высокое доверие, иначе ближайший по пути — среднее. */
  const linkSymbol = (chunk: ChunkLite, name: string, line: number, source: string, kindOfRef: "code" | "ident"): boolean => {
    const isCall = /\(\)$/.test(name);
    const clean = name.replace(/\(\)$/, "").replace(/<.*>$/, "");
    if (!IDENT_FULL_RE.test(clean)) return false;
    const qualified = clean.includes(".");
    // Простое слово в нижнем регистре (`status`, `address`) — не имя символа, а слово: связь была бы шумом.
    const camel = /[A-Z_$]/.test(clean.slice(1));
    if (!qualified && !camel && !/^[A-Z]/.test(clean)) return false;
    let candidates = (qualified ? symbolsByQualified.get(clean) : symbolsByName.get(clean)) ?? [];
    // Голое имя метода (`handle`) указывает на метод класса, только если имя составное (`getBarrier`).
    if (!qualified && !camel) candidates = candidates.filter((s) => s.qualified === s.name);
    // Голое имя, которое совпало только с методами, но в коде служит и ключом данных (поле DTO, ключ JSON,
    // json-тег Go), неоднозначно: в тексте это обычно поле (`organizationIds` в payload журнала), а не метод
    // `TenantContextService.organizationIds`. Связь с методом — только при вызове со скобками: `organizationIds()`.
    if (!qualified && !isCall && candidates.length > 0 && candidates.every((s) => s.qualified !== s.name) && dataKeyNames.has(clean)) {
      return false;
    }
    if (!qualified && clean.length < config.links.min_symbol_length) return false;
    if (candidates.length === 0) {
      if (qualified && kindOfRef === "code") {
        const [qual, member] = [clean.slice(0, clean.lastIndexOf(".")), clean.slice(clean.lastIndexOf(".") + 1)];
        // Поля структур и свойства классов символами не считаются, поэтому битой считается только
        // ссылка на член Go-пакета (`pkg.Func`) или вызов метода (`Type.Method()`).
        if (goPackageNames.has(qual) || (isCall && typeNames.has(qual))) {
          problems.push({
            kind: "broken-symbol",
            chunkId: chunk.id,
            path: chunk.docPath,
            line,
            value: clean,
            message: `«${qual}» есть в коде, а «${member}» в нём не найден`,
          });
        }
      }
      return false;
    }
    const exported = candidates.filter((c) => c.exported);
    let pool = exported.length ? exported : candidates;
    // «Своя сторона»: документ репозитория ссылается на символы репозитория, документация библиотеки —
    // на символы этой библиотеки. `Alert` в гайде проекта — локальный компонент, а не одноимённый из ui-kit.
    const docRoot = externalRoot(chunk.docPath);
    const sameSide = pool.filter((s) => (docRoot ? s.file.startsWith(`${docRoot}/`) : !isExternalPath(s.file)));
    if (sameSide.length) pool = sameSide;
    if (pool.length > limit) return false;
    const confidence: Confidence = pool.length === 1 ? "high" : "medium";
    const target = pool.length === 1 ? pool[0] : nearest(pool, chunk.docPath, (s) => s.file);
    if (!target) return false;
    addLink({ chunkId: chunk.id, targetKind: "symbol", targetId: target.id, source, confidence, line, role: null });
    return true;
  };

  const linkPath = (chunk: ChunkLite, raw: string, line: number, source: string, explicit: boolean): boolean => {
    let v = raw.trim().replace(/^<|>$/g, "");
    v = v.replace(/[#?].*$/, "").replace(/:\d+(-\d+)?$/, "").replace(/\/$/, "");
    if (!v || /\s/.test(v)) return false;
    const docDir = dirOf(chunk.docPath);
    const candidates = v.startsWith("/") ? [joinRepoPath("", v.slice(1))] : [joinRepoPath(docDir, v), joinRepoPath("", v)];
    if (/[*?]|\{[^}]*,[^}]*\}/.test(v)) {
      const m = picomatch(v.replace(/^\.\//, ""), { dot: true });
      if (allPaths.some((p) => m(p))) {
        addLink({ chunkId: chunk.id, targetKind: "glob", targetId: v.replace(/^\.\//, ""), source: "path-glob", confidence: "medium", line, role: null });
        return true;
      }
      return false;
    }
    for (const c of candidates) {
      if (c === null) continue;
      if (project.files.has(c)) {
        const kind: TargetKind = docByPath.has(c) ? "doc" : "file";
        if (kind === "doc" && c === chunk.docPath) return true;
        addLink({ chunkId: chunk.id, targetKind: kind, targetId: c, source, confidence: "high", line, role: null });
        return true;
      }
      if (c && project.dirs.has(c)) {
        addLink({ chunkId: chunk.id, targetKind: "dir", targetId: c, source, confidence: "high", line, role: null });
        return true;
      }
    }
    if (!v.includes("/") && /\.[A-Za-z0-9]{1,6}$/.test(v)) {
      const byName = basenameIndex.get(v) ?? [];
      if (byName.length >= 1 && byName.length <= limit) {
        const target = byName.length === 1 ? byName[0] : nearest(byName, chunk.docPath, (p) => p);
        if (target) {
          addLink({ chunkId: chunk.id, targetKind: docByPath.has(target) ? "doc" : "file", targetId: target, source: "path-basename", confidence: "medium", line, role: null });
          return true;
        }
      }
      return false;
    }
    // Путь в тексте, записанный относительно исходника, а не документа (`../../../../contracts/api.yaml`):
    // если без ведущих `../` файл есть — это он, но с меньшим доверием.
    if (!explicit && v.startsWith("../")) {
      const stripped = v.replace(/^(\.\.\/)+/, "");
      if (project.files.has(stripped)) {
        addLink({ chunkId: chunk.id, targetKind: docByPath.has(stripped) ? "doc" : "file", targetId: stripped, source, confidence: "medium", line, role: null });
        return true;
      }
    }
    // Шаблон (`stage-<N>-brief.md`, `${dir}/x.ts`) — не путь.
    if (!explicit && /[<>$]/.test(v)) return false;
    // Похоже на путь в репозитории: известное расширение и первый сегмент — каталог репозитория
    // (`/etc/hosts` и спецификатор импорта `./generated/client.gen` путями репозитория не считаются).
    const rel = v.replace(/^\.?\//, "");
    const first = rel.split("/")[0] ?? "";
    const looksLikeRepoPath =
      v.includes("/") && REPO_FILE_EXT.test(v) && ((first !== "" && project.dirs.has(first)) || v.startsWith("./") || v.startsWith("../"));
    if (explicit || looksLikeRepoPath) {
      // Пути из .gitignore (отчёты, кэши, scratch-каталоги) битыми не считаются: проверяется в конце.
      brokenPaths.push({
        paths: candidates.filter((c): c is string => c !== null && c !== ""),
        problem: {
          kind: explicit ? "broken-link" : "broken-path",
          chunkId: chunk.id,
          path: chunk.docPath,
          line,
          value: raw,
          message: explicit ? "ссылка на файл, которого нет в репозитории" : "путь в тексте указывает на несуществующий файл",
        },
      });
    }
    return false;
  };

  // ---------- связи документов ----------
  for (const d of docs) {
    const first = firstChunkOfDoc.get(d.path);
    if (!first) continue;
    for (const pattern of d.covers) {
      const isGlob = /[*?{]/.test(pattern);
      addLink({ chunkId: first, targetKind: isGlob ? "glob" : project.dirs.has(pattern.replace(/\/$/, "")) ? "dir" : "file", targetId: pattern.replace(/\/$/, ""), source: "covers", confidence: "high", line: null, role: null });
    }
    // Расположение: документ внутри каталога пакета описывает этот пакет.
    const meta = docMeta.find((m) => m.path === d.path);
    if (meta?.package) {
      addLink({ chunkId: first, targetKind: "dir", targetId: meta.package, source: "location", confidence: "medium", line: null, role: null });
    }
  }

  const idRefs = config.documents.id_refs.map((r) => ({ re: new RegExp(r.pattern, "gu"), path: r.path }));
  const docPaths = docs.map((d) => d.path);
  const idRefCache = new Map<string, string[]>();
  /** Документы по ID из текста (`ADR-0001`): шаблон пути из `id_refs` с подстановкой групп. */
  const docsByIdRef = (m: RegExpMatchArray, pathTemplate: string): string[] => {
    const key = `${pathTemplate}\u0000${m[0]}`;
    let matches = idRefCache.get(key);
    if (!matches) {
      const glob = pathTemplate.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "").replace(/\$0/g, m[0]);
      const g = picomatch(glob, { dot: true, nocase: true });
      matches = docPaths.filter((p) => g(p));
      idRefCache.set(key, matches);
    }
    return matches;
  };

  // ---------- сущности проекта (таблицы, экраны …): объявляют экстракторы, ссылаются документы и шапки ----------
  const entityKinds = config.entities;
  const entitiesByName = new Map<string, EntityRow[]>();
  for (const e of entities) {
    const list = entitiesByName.get(e.name) ?? [];
    list.push(e);
    entitiesByName.set(e.name, list);
  }
  const inText = (e: EntityRow) => (entityKinds[e.kind]?.in_text ?? "backticks") === "backticks";
  /** Сущности, на которые указывает строка в обратных кавычках: точное имя или `имя.поле` у видов с dotted. */
  const entitiesInCode = (v: string): EntityRow[] => {
    const exact = (entitiesByName.get(v) ?? []).filter(inText);
    if (exact.length) return exact;
    const dot = v.indexOf(".");
    if (dot <= 0) return [];
    return (entitiesByName.get(v.slice(0, dot)) ?? []).filter((e) => inText(e) && entityKinds[e.kind]?.dotted);
  };
  const linkEntity = (chunk: ChunkLite, e: EntityRow, line: number | null, source: string, confidence: Confidence) => {
    if (e.chunkId === chunk.id) return;
    const target: Pick<LinkRow, "targetKind" | "targetId"> = e.symbolId
      ? { targetKind: "symbol", targetId: e.symbolId }
      : e.chunkId
        ? { targetKind: "chunk", targetId: e.chunkId }
        : { targetKind: "file", targetId: e.file };
    addLink({ chunkId: chunk.id, ...target, source, confidence, line, role: e.kind });
  };

  // ---------- связи из шапок документов (documents.header_links) ----------
  const fieldValues = (fm: Record<string, unknown>, field: string): string[] => {
    let v: unknown = fm;
    for (const k of field.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
    return list.map((x) => String(x).trim()).filter((x) => x && !/^[—–-]$/.test(x));
  };
  for (const d of docs) {
    if (!d.frontmatter || !config.documents.header_links.length) continue;
    const firstId = firstChunkOfDoc.get(d.path);
    const first = firstId ? chunkById.get(firstId) : undefined;
    if (!first) continue;
    const broken = (field: string, value: string, message: string) =>
      problems.push({ kind: "broken-header-ref", chunkId: first.id, path: d.path, line: null, value, message: `шапка, поле ${field}: ${message}` });
    for (const h of config.documents.header_links) {
      for (const value of fieldValues(d.frontmatter, h.field)) {
        if (h.entity) {
          const found = (entitiesByName.get(value) ?? []).filter((e) => e.kind === h.entity);
          if (!found.length) broken(h.field, value, `${entityKinds[h.entity]?.title ?? h.entity} «${value}» не найдена`);
          for (const e of found) linkEntity(first, e, null, "header", "high");
        } else if (h.path) {
          const target = h.path.replace(/\$1/g, value);
          if (docByPath.has(target)) addLink({ chunkId: first.id, targetKind: "doc", targetId: target, source: "header", confidence: "high", line: null, role: null });
          else if (project.files.has(target)) addLink({ chunkId: first.id, targetKind: "file", targetId: target, source: "header", confidence: "high", line: null, role: null });
          else broken(h.field, value, `файла ${target} нет`);
        } else {
          let matched = false;
          for (const r of idRefs) {
            r.re.lastIndex = 0;
            const m = [...value.matchAll(r.re)][0];
            if (!m) continue;
            matched = true;
            const targets = docsByIdRef(m, r.path).filter((p) => p !== d.path);
            if (!targets.length) broken(h.field, value, "документ с таким ID не найден");
            for (const p of targets) addLink({ chunkId: first.id, targetKind: "doc", targetId: p, source: "header", confidence: "high", line: null, role: null });
          }
          if (!matched) broken(h.field, value, "значение не похоже на ID документа (documents.id_refs)");
        }
      }
    }
  }

  for (const ref of refs) {
    const chunk = chunkById.get(ref.chunkId);
    if (!chunk) continue;
    const doc = docByPath.get(chunk.docPath);
    if (ref.kind === "link") {
      linkPath(chunk, ref.value, ref.line, "link", true);
    } else if (ref.kind === "ref") {
      linkContractRef(chunk, ref.value, ref.line);
    } else if (ref.kind === "code") {
      const v = ref.value.trim();
      const ents = doc?.format === "markdown" ? entitiesInCode(v) : [];
      if (ents.length) {
        // Имя сущности проверено по реестру — исключение из правила «простое слово с символом не связывается».
        for (const e of ents) linkEntity(chunk, e, ref.line, "entity", "medium");
        continue;
      }
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(v)) continue; // эндпоинт — ниже, по тексту
      const ch = channelsByAddress.get(v);
      if (ch && doc?.format === "markdown") {
        addLink({ chunkId: chunk.id, targetKind: "chunk", targetId: ch.chunkId, source: "channel", confidence: "high", line: ref.line, role: null });
        continue;
      }
      if (v.includes("/") || /\.[A-Za-z0-9]{1,6}(:\d+(-\d+)?)?$/.test(v) && !IDENT_FULL_RE.test(v.replace(/:\d+(-\d+)?$/, ""))) {
        linkPath(chunk, v, ref.line, "path", false);
      } else if (/\.(ts|tsx|js|jsx|go|md|ya?ml|json|sql|sh|toml)(:\d+(-\d+)?)?$/.test(v)) {
        linkPath(chunk, v, ref.line, "path", false);
      } else {
        linkSymbol(chunk, v, ref.line, "symbol", "code");
      }
    } else if (ref.kind === "ident") {
      linkSymbol(chunk, ref.value, ref.line, "symbol", "ident");
    }
  }

  function linkContractRef(chunk: ChunkLite, value: string, line: number): void {
    const hash = value.indexOf("#");
    const filePart = hash >= 0 ? value.slice(0, hash) : value;
    const pointer = hash >= 0 ? value.slice(hash + 1) : "";
    const targetDoc = filePart ? joinRepoPath(dirOf(chunk.docPath), filePart) : chunk.docPath;
    if (targetDoc === null || !project.files.has(targetDoc)) {
      problems.push({ kind: "broken-ref", chunkId: chunk.id, path: chunk.docPath, line, value, message: "`$ref` указывает на файл, которого нет" });
      return;
    }
    if (filePart) {
      addLink({ chunkId: chunk.id, targetKind: docByPath.has(targetDoc) ? "doc" : "file", targetId: targetDoc, source: "ref", confidence: "high", line, role: null });
    }
    const m = pointer.match(/^\/components\/(\w+)\/([^/]+)$/) ?? pointer.match(/^\/(channels)\/([^/]+)$/);
    if (m && docByPath.has(targetDoc)) {
      const section = m[1] ?? "";
      const name = decodeURIComponent((m[2] ?? "").replace(/~1/g, "/").replace(/~0/g, "~"));
      const singular = { schemas: "schema", responses: "response", parameters: "parameter", requestBodies: "request-body", messages: "message", headers: "header", channels: "channel" }[section];
      const target = singular ? componentByDocKey.get(`${targetDoc}\u0000${singular}/${name}`) : undefined;
      if (target) {
        if (target.chunkId !== chunk.id) addLink({ chunkId: chunk.id, targetKind: "chunk", targetId: target.chunkId, source: "schema-ref", confidence: "high", line, role: null });
      } else if (singular) {
        problems.push({ kind: "broken-ref", chunkId: chunk.id, path: chunk.docPath, line, value, message: "`$ref` указывает на компонент, которого нет" });
      }
    }
  }

  // Эндпоинты и идентификаторы документов — по тексту Markdown-фрагментов.
  for (const chunk of chunks) {
    const doc = docByPath.get(chunk.docPath);
    if (!doc || doc.format !== "markdown") continue;
    const lines = chunk.text.split("\n");
    lines.forEach((lineText, i) => {
      const line = chunk.lineStart + i;
      if (hasContracts) {
        for (const m of lineText.matchAll(ENDPOINT_RE)) {
          const method = m[1] ?? "";
          const rawPath = (m[2] ?? "").replace(/[.,:;)]+$/, "");
          const resolved = resolveEndpoint(method, rawPath);
          if (resolved.items.length) {
            for (const it of resolved.items) addLink({ chunkId: chunk.id, targetKind: "chunk", targetId: it.chunkId, source: "endpoint", confidence: resolved.confidence, line, role: null });
          } else {
            problems.push({ kind: "broken-endpoint", chunkId: chunk.id, path: chunk.docPath, line, value: `${method} ${rawPath}`, message: "эндпоинта нет в контракте" });
          }
        }
      }
      for (const r of idRefs) {
        r.re.lastIndex = 0;
        for (const m of lineText.matchAll(r.re)) {
          const target = m[0];
          const matches = docsByIdRef(m, r.path);
          if (matches.length === 0) {
            problems.push({ kind: "broken-id-ref", chunkId: chunk.id, path: chunk.docPath, line, value: target, message: "документ с таким идентификатором не найден" });
          }
          for (const p of matches) {
            if (p !== chunk.docPath) addLink({ chunkId: chunk.id, targetKind: "doc", targetId: p, source: "id-ref", confidence: "high", line, role: null });
          }
        }
      }
    });
  }

  function resolveEndpoint(method: string, rawPath: string): { items: ApiItemRow[]; confidence: Confidence } {
    const norm = normalizeApiPath(rawPath);
    const exact = operationsByEndpoint.get(`${method} ${norm}`);
    if (exact?.length) return { items: exact, confidence: "high" };
    // Конкретное значение на месте параметра: `/users/123` ↔ `/users/{}`.
    const segs = norm.split("/");
    const byTemplate = operationTemplates.filter(
      (t) => t.method === method && t.segments.length === segs.length && t.segments.every((s, i) => s === segs[i] || s === "{}" || segs[i] === "{}"),
    );
    if (byTemplate.length) return { items: byTemplate.map((t) => t.item), confidence: "medium" };
    // Префикс прокси или версии (`/api/users`, `/v1/users`): в контракте путь без него.
    const unprefixed = rawPath.replace(/^\/(api|v\d+)(?=\/)/i, "");
    if (unprefixed !== rawPath) {
      const again = resolveEndpoint(method, unprefixed);
      if (again.items.length) return { items: again.items, confidence: "medium" };
    }
    return { items: [], confidence: "low" };
  }

  // ---------- контракт ↔ код ----------
  const roles = [...config.keys.roles, ...DEFAULT_ROLES].map((r) => ({
    ...r,
    pathMatch: r.path ? picomatch(r.path, { dot: true }) : null,
    contextRe: r.context ? new RegExp(r.context, "u") : null,
    valueRe: r.value ? new RegExp(r.value, "u") : null,
  }));
  const roleFor = (kind: string, file: string, context: string, value: string): string | null => {
    for (const r of roles) {
      if (r.kind && r.kind !== kind) continue;
      if (r.pathMatch && !r.pathMatch(file)) continue;
      if (r.contextRe && !r.contextRe.test(context)) continue;
      if (r.valueRe && !r.valueRe.test(value)) continue;
      return r.role;
    }
    return null;
  };
  const packageOfFile = (p: string) => fileByPath.get(p)?.package ?? null;
  const keysByValue = new Map<string, typeof codeKeys>();
  for (const k of codeKeys) {
    if (k.pattern) continue;
    const list = keysByValue.get(k.value) ?? [];
    list.push(k);
    keysByValue.set(k.value, list);
  }
  const importsByName = new Map<string, ImportRow[]>();
  for (const imp of imports) {
    for (const n of imp.names) {
      const list = importsByName.get(n) ?? [];
      list.push(imp);
      importsByName.set(n, list);
    }
  }

  const operations = apiItems.filter((a) => a.kind === "operation");
  let implemented = 0;
  for (const op of operations) {
    const key = op.key;
    let hasImpl = false;
    for (const k of keysByValue.get(key) ?? []) {
      const role = roleFor("operation", k.file, k.context, k.value);
      if (!role) continue;
      if (role === "implements") hasImpl = true;
      keyRefs.push({ key, kind: "operation", role, file: k.file, line: k.line, symbolId: k.symbolId, package: packageOfFile(k.file), confidence: "exact", chunkId: op.chunkId });
      addLink({ chunkId: op.chunkId, targetKind: k.symbolId ? "symbol" : "file", targetId: k.symbolId ?? k.file, source: "operation-id", confidence: "high", line: k.line, role });
    }
    // Функция сгенерированного клиента с именем operationId и те, кто её импортирует.
    for (const s of symbolsByName.get(key) ?? []) {
      const f = fileByPath.get(s.file);
      if (!f?.generated || !s.exported) continue;
      keyRefs.push({ key, kind: "operation", role: "client", file: s.file, line: s.lineStart, symbolId: s.id, package: f.package, confidence: "exact", chunkId: op.chunkId });
      addLink({ chunkId: op.chunkId, targetKind: "symbol", targetId: s.id, source: "client-fn", confidence: "high", line: s.lineStart, role: "client" });
      const clientDir = f.packageDir;
      for (const imp of importsByName.get(key) ?? []) {
        const inClientPkg = imp.toFile === s.file || (clientDir !== null && fileByPath.get(imp.toFile)?.packageDir === clientDir);
        if (!inClientPkg || fileByPath.get(imp.fromFile)?.packageDir === clientDir) continue;
        keyRefs.push({ key, kind: "operation", role: "calls", file: imp.fromFile, line: imp.line, symbolId: null, package: packageOfFile(imp.fromFile), confidence: "exact", chunkId: op.chunkId });
        addLink({ chunkId: op.chunkId, targetKind: "file", targetId: imp.fromFile, source: "client-call", confidence: "high", line: imp.line, role: "calls" });
      }
    }
    if (hasImpl) implemented++;
    else {
      problems.push({ kind: "operation-without-handler", chunkId: op.chunkId, path: op.docPath, line: chunkById.get(op.chunkId)?.lineStart ?? null, value: `${op.method ?? ""} ${op.path ?? ""} (${key})`.trim(), message: "у операции нет обработчика в коде" });
    }
  }
  if (operations.length && implemented === 0) {
    // Ни одной реализации: скорее всего, не настроены роли, а не пропали все обработчики.
    for (let i = problems.length - 1; i >= 0; i--) if (problems[i]?.kind === "operation-without-handler") problems.splice(i, 1);
    problems.push({ kind: "operation-without-handler", chunkId: null, path: operations[0]?.docPath ?? "", line: null, value: `${operations.length} операций`, message: "ни одна операция не связана с обработчиком: проверьте keys.roles в конфиге (контекст operationId)" });
  }

  // Каналы: строковые литералы, равные адресу; подписки с подстановками NATS; собранные из частей — неразрешённые.
  const channels = apiItems.filter((a) => a.kind === "channel" && a.address);
  const channelRoles = new Map<string, Set<string>>();
  const noteRole = (chunkId: string, role: string) => {
    const s = channelRoles.get(chunkId) ?? new Set<string>();
    s.add(role);
    channelRoles.set(chunkId, s);
  };
  for (const k of codeKeys) {
    if (k.pattern) {
      const prefix = k.value.slice(0, k.value.indexOf("*"));
      if (prefix.length >= 2 && channels.some((c) => (c.address ?? "").startsWith(prefix))) {
        keyRefs.push({ key: k.value, kind: "channel", role: roleFor("channel", k.file, k.context, k.value) ?? "mention", file: k.file, line: k.line, symbolId: k.symbolId, package: packageOfFile(k.file), confidence: "unresolved", chunkId: null });
      }
      continue;
    }
    const exact = channelsByAddress.get(k.value);
    const isWildcard = /(^|\.)(\*|>)(\.|$)/.test(k.value);
    const matched = exact ? [exact] : isWildcard ? channels.filter((c) => natsMatch(k.value, c.address ?? "")) : [];
    const configured = roleFor("channel", k.file, k.context, k.value);
    if (matched.length === 0) {
      if (configured === "publish" || configured === "subscribe") {
        problems.push({ kind: "unknown-channel", chunkId: null, path: k.file, line: k.line, value: k.value, message: `код ${configured === "publish" ? "публикует в" : "читает"} адрес, которого нет в контракте` });
      }
      continue;
    }
    const role = configured ?? (isWildcard ? "subscribe" : "mention");
    const confidence = configured || isWildcard ? "exact" : "mention";
    for (const ch of matched) {
      keyRefs.push({ key: ch.address ?? k.value, kind: "channel", role, file: k.file, line: k.line, symbolId: k.symbolId, package: packageOfFile(k.file), confidence, chunkId: ch.chunkId });
      addLink({ chunkId: ch.chunkId, targetKind: k.symbolId ? "symbol" : "file", targetId: k.symbolId ?? k.file, source: "channel-key", confidence: confidence === "exact" ? "high" : "medium", line: k.line, role });
      noteRole(ch.chunkId, role);
    }
  }
  for (const ch of channels) {
    const seen = channelRoles.get(ch.chunkId);
    if (!seen) {
      problems.push({ kind: "channel-without-code", chunkId: ch.chunkId, path: ch.docPath, line: chunkById.get(ch.chunkId)?.lineStart ?? null, value: ch.address ?? ch.key, message: "на канал не ссылается ни один файл кода" });
    } else if (seen.has("publish") && !seen.has("subscribe")) {
      problems.push({ kind: "channel-without-subscriber", chunkId: ch.chunkId, path: ch.docPath, line: null, value: ch.address ?? ch.key, message: "в канал публикуют, но никто его не читает" });
    } else if (seen.has("subscribe") && !seen.has("publish") && !seen.has("mention")) {
      problems.push({ kind: "channel-without-publisher", chunkId: ch.chunkId, path: ch.docPath, line: null, value: ch.address ?? ch.key, message: "канал читают, но никто в него не публикует" });
    }
  }
  // Операции AsyncAPI ссылаются на свой канал.
  for (const op of apiItems.filter((a) => a.kind === "async-operation" && a.address)) {
    const ch = channelsByAddress.get(op.address ?? "");
    if (ch) addLink({ chunkId: op.chunkId, targetKind: "chunk", targetId: ch.chunkId, source: "channel-ref", confidence: "high", line: null, role: null });
  }

  // ---------- тесты: ссылки из названий на документы и эндпоинты ----------
  // `test.describe("меню по правам (ADR-0025 п. 6, GET /me)")`, запрос Bruno `GET /slots/{id}`:
  // документ или операция → проверяющий их тест.
  const testedOps = new Set<string>();
  for (const s of symbols) {
    if (!TEST_KINDS.has(s.kind)) continue;
    const text = `${s.name}\n${s.signature}\n${s.comment}`;
    for (const m of text.matchAll(ENDPOINT_RE)) {
      const rawPath = (m[2] ?? "").replace(/[.,:;)]+$/, "");
      const resolved = resolveEndpoint(m[1] ?? "", rawPath);
      for (const op of resolved.items) {
        if (testedOps.has(`${s.id}\u0000${op.chunkId}`)) continue;
        testedOps.add(`${s.id}\u0000${op.chunkId}`);
        keyRefs.push({ key: op.key, kind: "operation", role: "tests", file: s.file, line: s.lineStart, symbolId: s.id, package: packageOfFile(s.file), confidence: resolved.confidence === "high" ? "exact" : "mention", chunkId: op.chunkId });
        addLink({ chunkId: op.chunkId, targetKind: "symbol", targetId: s.id, source: "test-endpoint", confidence: resolved.confidence, line: s.lineStart, role: "tests" });
      }
    }
    for (const r of idRefs) {
      r.re.lastIndex = 0;
      for (const m of text.matchAll(r.re)) {
        const glob = r.path.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "");
        const g = picomatch(glob, { dot: true, nocase: true });
        for (const p of docPaths) {
          const first = g(p) ? firstChunkOfDoc.get(p) : undefined;
          if (first) addLink({ chunkId: first, targetKind: "symbol", targetId: s.id, source: "test-ref", confidence: "high", line: null, role: "tests" });
        }
      }
    }
  }

  // HTTP-вызовы в тестах (`request(app).post("/passes")`): тест-кейс, внутри которого стоит вызов, проверяет операцию.
  for (const k of codeKeys) {
    if (k.context !== "http-call" || !fileByPath.get(k.file)?.isTest) continue;
    const m = k.value.match(/^([A-Z]+) (\/.*)$/);
    if (!m) continue;
    const resolved = resolveEndpoint(m[1] ?? "", m[2] ?? "");
    for (const op of resolved.items) {
      const owner = k.symbolId ?? k.file;
      if (testedOps.has(`${owner}\u0000${op.chunkId}`)) continue;
      testedOps.add(`${owner}\u0000${op.chunkId}`);
      keyRefs.push({ key: op.key, kind: "operation", role: "tests", file: k.file, line: k.line, symbolId: k.symbolId, package: packageOfFile(k.file), confidence: resolved.confidence === "high" ? "exact" : "mention", chunkId: op.chunkId });
      addLink({ chunkId: op.chunkId, targetKind: k.symbolId ? "symbol" : "file", targetId: owner, source: "test-call", confidence: resolved.confidence, line: k.line, role: "tests" });
    }
  }

  // Операции, к которым не обращается ни один тест (если тесты операций вообще находятся).
  const testedChunks = new Set(keyRefs.filter((k) => k.role === "tests" && k.chunkId).map((k) => k.chunkId));
  if (testedChunks.size > 0) {
    for (const op of operations) {
      if (testedChunks.has(op.chunkId)) continue;
      problems.push({
        kind: "operation-without-tests",
        chunkId: op.chunkId,
        path: op.docPath,
        line: chunkById.get(op.chunkId)?.lineStart ?? null,
        value: `${op.method ?? ""} ${op.path ?? ""} (${op.key})`.trim(),
        message: "к операции не обращается ни один тест: нет сценария Bruno, HTTP-вызова в тесте или эндпоинта в названии теста",
      });
    }
  }

  store.replaceLinks(links);
  store.replaceKeyRefs(keyRefs);
  const ignored = project.ignoredPaths(brokenPaths.flatMap((b) => b.paths));
  for (const b of brokenPaths) if (!b.paths.some((p) => ignored.has(p))) problems.push(b.problem);
  // Документация внешних пакетов — не документация репозитория: её проблемы в отчёт не идут.
  for (let i = problems.length - 1; i >= 0; i--) if (isExternalPath(problems[i]?.path ?? "")) problems.splice(i, 1);
  // Намеренные исключения из конфига: проблема скрывается, счётчик остаётся.
  const ignoreRules = config.checks.ignore.map((r) => ({
    ...r,
    pathMatch: r.path ? picomatch(r.path, { dot: true }) : null,
    valueRe: r.value ? new RegExp(r.value, "u") : null,
    count: 0,
  }));
  const kept = problems.filter((p) => {
    const rule = ignoreRules.find((r) => (!r.kind || r.kind === p.kind) && (!r.pathMatch || r.pathMatch(p.path)) && (!r.valueRe || r.valueRe.test(p.value)));
    if (rule) rule.count++;
    return !rule;
  });
  store.setState("problems_suppressed", JSON.stringify(ignoreRules.map((r) => ({ kind: r.kind ?? null, path: r.path ?? null, value: r.value ?? null, reason: r.reason, count: r.count }))));
  problems.length = 0;
  problems.push(...kept);
  store.replaceProblems(problems);
  return { links: links.length, imports: imports.length, keyRefs: keyRefs.length, problems: problems.length, ms: Date.now() - t0 };
}

/** Сопоставление подписки NATS: `*` — один токен, `>` — весь оставшийся хвост (не пустой). */
export function natsMatch(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    const tok = p[i];
    if (tok === ">") return s.length > i;
    if (i >= s.length) return false;
    if (tok !== "*" && tok !== s[i]) return false;
  }
  return p.length === s.length;
}

function commonPrefixDepth(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;
  while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i++;
  return i;
}
