import { DATA_NOTE, LINK_REASON, chunkRef, contractTests, describeIncoming, findSymbols, freshnessOf, importersOf } from "../search/queries.ts";
import type { IndexReader, KeyRefRow, LinkRow } from "../store/types.ts";
import { dirOf } from "../util/text.ts";

const ROLE_TITLES: Record<string, string> = {
  implements: "реализует",
  client: "функция клиента",
  calls: "вызывает через клиент",
  publish: "публикует",
  subscribe: "читает",
  mention: "упоминает адрес",
  tests: "проверяет",
};

/** Связанное в обе стороны: документация к коду, код к документации, импорты, совместные правки, контракты. */
export function related(reader: IndexReader, args: { target: string; limit?: number }) {
  const limit = args.limit ?? 15;
  const t = args.target.trim();
  const chunk = reader.getChunk(t);
  if (chunk) return relatedToChunk(reader, chunk.id, limit);
  if (reader.getDocument(t)) return relatedToDoc(reader, t, limit);
  if (reader.getFile(t)) return relatedToFile(reader, t, limit);
  const symbol = findSymbols(reader, t)[0];
  if (symbol) return { symbol: symbol.qualified, at: `${symbol.file}:${symbol.lineStart}`, ...relatedToFile(reader, symbol.file, limit, symbol.id) };
  return { error: `не найдено: ${t}. Передайте путь файла, путь документа, id фрагмента или имя символа.` };
}

function codeTarget(reader: IndexReader, l: LinkRow) {
  const why = LINK_REASON[l.source] ?? l.source;
  const role = l.role ? ROLE_TITLES[l.role] ?? l.role : undefined;
  if (l.targetKind === "symbol") {
    const s = reader.getSymbol(l.targetId);
    return { symbol: s?.qualified ?? l.targetId, at: s ? `${s.file}:${s.lineStart}` : null, kind: s?.kind, why, confidence: l.confidence, ...(role ? { role } : {}) };
  }
  if (l.targetKind === "file") return { file: l.targetId, ...(l.line && l.role ? { at: `${l.targetId}:${l.line}` } : {}), why, confidence: l.confidence, ...(role ? { role } : {}) };
  if (l.targetKind === "dir") return { dir: l.targetId, why, confidence: l.confidence };
  return { glob: l.targetId, why, confidence: l.confidence };
}

function relatedToFile(reader: IndexReader, file: string, limit: number, symbolId?: string) {
  const f = reader.getFile(file);
  const incoming = symbolId ? [...reader.linksTo("symbol", symbolId), ...reader.linksToFile(file).filter((l) => l.targetKind !== "symbol")] : reader.linksToFile(file);
  // Документация — только из Markdown; связи контрактов с кодом идут отдельным разделом.
  const docLinks = incoming.filter((l) => reader.getChunk(l.chunkId) && !["operation-id", "client-fn", "client-call", "channel-key", "test-endpoint", "test-call"].includes(l.source));
  const docs = describeIncoming(reader, docLinks).slice(0, limit);

  const imports = [...new Set(reader.importsFrom(file).map((i) => i.toFile))];
  // Импортёры — и через реэкспорты (barrel `index.ts`, типы пакета); тесты — отдельно.
  const symbol = symbolId ? reader.getSymbol(symbolId) : null;
  const names = symbol ? new Set([symbol.name]) : new Set(reader.symbolsInFile(file).filter((s) => s.exported).map((s) => s.name));
  const importers = importersOf(reader, file, names.size ? names : null);
  const importedBy = importers.filter((i) => !i.test).map((i) => (i.via ? `${i.file} (через ${i.via})` : i.file));
  const testedBy = [
    ...importers.filter((i) => i.test).map((i) => i.file),
    ...contractTests(reader, file, symbolId).map((t) => `${t.at} — ${t.test} (${t.via})`),
  ];
  const samePackage =
    f?.lang === "go"
      ? reader
          .filesInDir(dirOf(file))
          .filter((x) => x.lang === "go" && x.path !== file && !x.isTest)
          .map((x) => x.path)
      : [];
  const changesWith = reader.cochange(file, limit).map((c) => ({ file: c.fileB, commits: c.weight }));

  const keyRefs = reader.keyRefsByFile(file).filter((k) => !symbolId || k.symbolId === symbolId || k.symbolId === null);
  const contracts = new Map<string, { contract: ReturnType<typeof chunkRef>; roles: string[]; lines: number[] }>();
  const hidden: Array<{ file: string; role: string; via: string; at: string }> = [];
  for (const k of keyRefs) {
    if (!k.chunkId) continue;
    const c = reader.getChunk(k.chunkId);
    if (!c) continue;
    const entry = contracts.get(k.chunkId) ?? { contract: chunkRef(c), roles: [], lines: [] };
    const role = ROLE_TITLES[k.role] ?? k.role;
    if (!entry.roles.includes(role)) entry.roles.push(role);
    entry.lines.push(k.line);
    contracts.set(k.chunkId, entry);
    // Скрытая зависимость: другие файлы, которые работают с тем же каналом или операцией без импорта.
    for (const other of reader.keyRefsByChunk(k.chunkId)) {
      if (other.file === file || other.file === undefined) continue;
      if (k.kind === "operation" && !["calls", "implements"].includes(other.role)) continue;
      hidden.push({ file: other.file, role: ROLE_TITLES[other.role] ?? other.role, via: k.kind === "channel" ? `канал ${k.key}` : `операция ${k.key}`, at: `${other.file}:${other.line}` });
    }
  }
  const hiddenUnique = dedupeBy(hidden, (h) => `${h.file}\u0000${h.via}\u0000${h.role}`).slice(0, limit * 2);

  return {
    target: file,
    kind: f ? `${f.lang}${f.isTest ? ", тест" : ""}${f.generated ? ", сгенерирован" : ""}` : undefined,
    package: f?.package ?? null,
    ...(reader.entitiesInFile(file).length ? { declares: reader.entitiesInFile(file).map((e) => `${e.kind} ${e.name} :${e.line}`).slice(0, limit * 2) } : {}),
    read_before_editing: docs,
    contracts: [...contracts.values()].map((c) => ({ ...c.contract, role: c.roles.join(", "), in_this_file_at_lines: c.lines.slice(0, 5) })),
    hidden_dependencies: hiddenUnique.length ? hiddenUnique : undefined,
    imports: imports.slice(0, limit),
    imported_by: importedBy.slice(0, limit),
    imported_by_total: importedBy.length,
    ...(testedBy.length ? { tested_by: [...new Set(testedBy)].slice(0, limit), tested_by_total: new Set(testedBy).size } : {}),
    ...(samePackage.length ? { same_package: samePackage.slice(0, limit) } : {}),
    changes_with: changesWith,
  };
}

function relatedToChunk(reader: IndexReader, id: string, limit: number) {
  const chunk = reader.getChunk(id);
  if (!chunk) return { error: `фрагмент не найден: ${id}` };
  const out = reader.linksFromChunk(id);
  const code = out.filter((l) => ["symbol", "file", "dir", "glob"].includes(l.targetKind) && !["client-call"].includes(l.source));
  const docsOut = out.filter((l) => l.targetKind === "doc" || l.targetKind === "chunk");
  const api = reader.apiItemByChunk(id);
  // Ссылка на весь контракт ничего не говорит о конкретной операции: для API — только ссылки на сам фрагмент.
  const incoming = api ? reader.linksTo("chunk", id) : [...reader.linksTo("chunk", id), ...reader.linksTo("doc", chunk.docPath)];
  const keyRefs = api ? reader.keyRefsByChunk(id) : [];
  const byRole = (role: string) => keyRefs.filter((k) => k.role === role).map((k) => keyRefView(reader, k));
  return {
    note: DATA_NOTE,
    target: chunkRef(chunk),
    freshness: freshnessOf(reader, chunk, out),
    code: dedupeBy(code.map((l) => codeTarget(reader, l)), (x) => JSON.stringify(x)).slice(0, limit * 2),
    references: dedupeBy(
      docsOut.map((l) => {
        const c = l.targetKind === "chunk" ? reader.getChunk(l.targetId) : null;
        return c ? { ...chunkRef(c), why: LINK_REASON[l.source] ?? l.source } : { doc: l.targetId, title: reader.getDocument(l.targetId)?.title, why: LINK_REASON[l.source] ?? l.source };
      }),
      (x) => JSON.stringify(x),
    ).slice(0, limit),
    referenced_by: describeIncoming(reader, incoming.filter((l) => l.chunkId !== id)).slice(0, limit),
    ...(api
      ? {
          api: {
            kind: api.kind,
            key: api.key,
            ...(api.method ? { endpoint: `${api.method} ${api.path}` } : {}),
            ...(api.address ? { address: api.address } : {}),
            implemented_by: byRole("implements"),
            client: byRole("client"),
            called_by: byRole("calls").slice(0, limit * 2),
            tested_by: byRole("tests").slice(0, limit * 2),
            publishers: byRole("publish"),
            subscribers: byRole("subscribe"),
            mentioned_in: byRole("mention").slice(0, limit * 2),
          },
        }
      : {}),
  };
}

function relatedToDoc(reader: IndexReader, docPath: string, limit: number) {
  const doc = reader.getDocument(docPath);
  const out = reader.linksFromDoc(docPath);
  const incoming = reader.linksTo("doc", docPath);
  return {
    target: { path: docPath, title: doc?.title, type: doc?.type, status: doc?.status },
    code: dedupeBy(out.filter((l) => ["symbol", "file", "dir", "glob"].includes(l.targetKind)).map((l) => codeTarget(reader, l)), (x) => JSON.stringify(x)).slice(0, limit * 2),
    references: dedupeBy(
      out
        .filter((l) => l.targetKind === "doc" || l.targetKind === "chunk")
        .map((l) => (l.targetKind === "doc" ? { doc: l.targetId, title: reader.getDocument(l.targetId)?.title } : { id: l.targetId })),
      (x) => JSON.stringify(x),
    ).slice(0, limit),
    referenced_by: describeIncoming(reader, incoming.filter((l) => !l.chunkId.startsWith(`${docPath}#`))).slice(0, limit),
    hint: "связи отдельного раздела — related с id фрагмента",
  };
}

function keyRefView(reader: IndexReader, k: KeyRefRow) {
  const s = k.symbolId ? reader.getSymbol(k.symbolId) : null;
  return { at: `${k.file}:${k.line}`, ...(s ? { symbol: s.qualified } : {}), package: k.package };
}

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
