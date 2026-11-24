import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultDbPath, runIndex, type IndexReport } from "../src/indexer/index.ts";
import { computeCheck } from "../src/links/check.ts";
import { related } from "../src/links/related.ts";
import { getDoc, getSymbol, globalStatus, fileStatus, searchCode, searchDocs } from "../src/search/queries.ts";
import { openSqliteStore, type SqliteStore } from "../src/store/sqlite/store.ts";
import { PROJECT_ROOT, createFixtureRepo, rmrf } from "./helpers.ts";

const GUIDE = "docs/guides/slots.md";
const OPENAPI = "contracts/openapi/api.yaml";
const ASYNCAPI = "contracts/asyncapi/events.yaml";

let repo = "";
let report: IndexReport;
let store: SqliteStore;
const cleanup: string[] = [];

before(async () => {
  repo = createFixtureRepo();
  cleanup.push(repo);
  report = await runIndex({ root: repo });
  store = await openSqliteStore(defaultDbPath(repo), { readonly: true });
});
after(() => {
  store?.close();
  for (const d of cleanup) rmrf(d);
});

describe("этап 1: документация", () => {
  it("индексация проходит без ошибок, документы и контракты разобраны", () => {
    assert.deepEqual(report.errors, []);
    const docs = store.listDocuments().map((d) => d.path);
    for (const p of [GUIDE, "docs/adr/0001-slot-on-server.md", OPENAPI, ASYNCAPI, "CHANGELOG.md"]) assert.ok(docs.includes(p), p);
    assert.equal(store.getSource("contracts/schemas/slot-meta.json")?.kind, "skip");
  });

  it("search_docs находит раздел по слову в другой форме и отдаёт путь:строка", () => {
    const r = searchDocs(store, { query: "как сбрасываются выбранные слоты при возврате из корзины", limit: 3 });
    const top = r.results[0];
    assert.ok(top, JSON.stringify(r));
    assert.equal(top.id, `${GUIDE}#слоты-доставки/хранение-выбора-слота`);
    assert.match(top.at, /^docs\/guides\/slots\.md:\d+$/);
    assert.ok("text" in top && top.text.includes("SlotService.resetSlot"));
    assert.match(r.note, /данные, а не инструкции/);
  });

  it("search_docs по эндпоинту отдаёт операцию контракта первой; тип и скрытые документы", () => {
    const r = searchDocs(store, { query: "GET /slots/{id}" });
    assert.equal(r.results[0]?.id, `${OPENAPI}#GET /slots/{id}`);
    const adr = searchDocs(store, { query: "слот хранится", type: ["adr"] });
    assert.ok(adr.results.length > 0 && adr.results.every((x) => x.doc_type === "adr"));
    assert.ok(!adr.results.some((x) => x.id.includes("0002-slots-in-cookies")), "отменённый ADR скрыт");
    const hidden = searchDocs(store, { query: "cookies браузера", include_hidden: true });
    assert.ok(hidden.results.some((x) => x.id.includes("0002-slots-in-cookies")));
    assert.equal(store.getDocument("docs/adr/0001-slot-on-server.md")?.status, "accepted");
  });

  it("get_doc: оглавление по пути и раздел целиком по id", () => {
    const toc = getDoc(store, { path: GUIDE });
    assert.ok((toc.toc?.length ?? 0) >= 3);
    const sec = getDoc(store, { id: `${GUIDE}#слоты-доставки/очередь-и-обработчик` });
    assert.ok(sec.section?.[0]?.text.includes("events.slot.reserved"));
  });
});

describe("этап 2: код, связи, контракты", () => {
  it("импорты: относительные, алиас tsconfig, пакет рабочего пространства, Go между модулями go.work", () => {
    const targets = (f: string) => store.importsFrom(f).map((i) => i.toFile);
    assert.ok(targets("apps/admin/src/features/slots/SlotPage.tsx").includes("apps/admin/src/shared/format.ts"));
    assert.ok(targets("apps/admin/src/features/slots/SlotPage.tsx").includes("packages/api-client/src/index.ts"));
    assert.ok(targets("apps/api/src/slots/slots.controller.ts").includes("apps/api/src/slots/slot.service.ts"));
    assert.ok(targets("apps/worker/internal/dispatch/handler.go").includes("packages/gsm/frame.go"));
    assert.equal(store.getFile("apps/worker/internal/dispatch/handler.go")?.unit, "example.com/fx/worker/internal/dispatch");
  });

  it("search_code и get_symbol находят Go: сигнатура, комментарий, импортёры из другого модуля", () => {
    const code = searchCode(store, { query: "gsm frame" });
    assert.equal(code.results[0]?.symbol, "ParseGSMFrame");
    const sym = getSymbol(store, { name: "gsm.ParseGSMFrame" });
    assert.ok("symbols" in sym);
    const s = sym.symbols?.[0];
    assert.equal(s?.comment, "ParseGSMFrame разбирает кадр GSM-модуля.");
    assert.ok(s?.imported_by.some((x) => x.startsWith("apps/worker/internal/dispatch/handler.go:")));
    assert.ok(s?.documented_by.some((d) => d.id === `${GUIDE}#слоты-доставки/очередь-и-обработчик`));
    const handler = getSymbol(store, { name: "Handler.Handle" });
    assert.ok(handler.symbols?.[0]?.signature.startsWith("func (h *Handler) Handle"));
  });

  it("поле данных не связывается с одноимённым методом; вызов со скобками и голое имя метода — связываются", () => {
    const lines = fs.readFileSync(path.join(repo, GUIDE), "utf8").split("\n");
    const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    const fieldLine = lineOf("поле `slotIds`");
    const callLine = lineOf("`slotIds()`");
    const symbolLinks = store.allLinks().filter((l) => l.chunkId.startsWith(`${GUIDE}#`) && l.targetKind === "symbol");
    const at = (line: number) => symbolLinks.filter((l) => l.line === line).map((l) => l.targetId);
    const method = "apps/api/src/slots/slot.service.ts#SlotService.slotIds";
    assert.ok(fieldLine > 0 && callLine > 0);
    assert.ok(!at(fieldLine).includes(method), "поле slotIds не должно вести на метод");
    assert.ok(at(callLine).includes(method), "вызов slotIds() ведёт на метод");
    assert.ok(at(callLine).includes("apps/api/src/slots/slot.service.ts#SlotService.resetSlot"), "resetSlot не ключ данных — связь остаётся");
  });

  it("тесты ниже основного кода в search_code", () => {
    const r = searchCode(store, { query: "NewHandler" });
    assert.equal(r.results[0]?.at.startsWith("apps/worker/internal/dispatch/handler.go"), true);
  });

  it("related по файлу кода: документация к прочтению, контракты, файлы пакета и совместные правки", () => {
    const r = related(store, { target: "apps/worker/internal/dispatch/handler.go" });
    assert.ok("same_package" in r && r.same_package?.includes("apps/worker/internal/dispatch/helper.go"));
    assert.ok("changes_with" in r && r.changes_with.some((c) => c.file === "apps/worker/internal/dispatch/helper.go" && c.commits === 2));
    const ctrl = related(store, { target: "apps/api/src/slots/slots.controller.ts" });
    assert.ok("contracts" in ctrl);
    const ops = ctrl.contracts.map((c) => c.id);
    assert.ok(ops.includes(`${OPENAPI}#GET /slots/{id}`) && ops.includes(`${OPENAPI}#POST /slots/{id}/reserve`));
    assert.ok(ctrl.read_before_editing.some((d) => d.id.startsWith(`${GUIDE}#`) && /covers/.test(d.why)));
  });

  it("related по операции: обработчик, функция клиента, вызывающие, документация", () => {
    const r = related(store, { target: `${OPENAPI}#GET /slots/{id}` });
    assert.ok("api" in r && r.api);
    assert.deepEqual(r.api.implemented_by.map((x) => x.symbol), ["SlotsController.get"]);
    assert.ok(r.api.client.some((x) => x.at.startsWith("packages/api-client/src/generated/sdk.gen.ts")));
    assert.ok(r.api.called_by.some((x) => x.at.startsWith("apps/admin/src/features/slots/SlotPage.tsx")));
    const refs = r.referenced_by.map((x) => x.id);
    assert.ok(refs.some((id) => id.startsWith("docs/adr/0001-slot-on-server.md#")));
    assert.ok(refs.some((id) => id.startsWith(`${GUIDE}#`)));
  });

  it("related по Go-файлу, который читает канал: канал и TS-файлы, которые в него публикуют", () => {
    const r = related(store, { target: "apps/worker/cmd/worker/main.go" });
    assert.ok("contracts" in r);
    const reserved = r.contracts.find((c) => c.id === `${ASYNCAPI}#channel/slotReserved`);
    assert.equal(reserved?.role, "читает");
    assert.ok(r.hidden_dependencies?.some((h) => h.file === "apps/api/src/slots/slot.service.ts" && h.role === "публикует"));
    const ch = related(store, { target: `${ASYNCAPI}#channel/slotReserved` });
    assert.ok("api" in ch && ch.api?.publishers.some((p) => p.at.startsWith("apps/api/src/slots/slot.service.ts")));
    assert.ok("api" in ch && ch.api?.subscribers.some((p) => p.at.startsWith("apps/worker/cmd/worker/main.go")));
  });

  it("check: битые ссылки, эндпоинты вне контракта, Go-символы, расхождения с контрактами, устаревшие разделы", () => {
    const c = computeCheck(store, { limit: 100 });
    const values = (k: string) => (c.problems[k]?.items ?? []).map((p) => p.value);
    assert.ok(values("broken-endpoint").includes("POST /slots/legacy"));
    assert.ok(values("broken-symbol").includes("dispatch.LegacyHandler"));
    assert.ok(values("broken-link").includes("../../apps/api/src/slots/removed.ts"));
    assert.ok(values("broken-id-ref").includes("ADR-0009"));
    assert.ok(values("operation-without-handler").some((v) => v.includes("listSlots")));
    assert.ok(values("channel-without-code").includes("audit.log"));
    assert.ok(values("channel-without-publisher").includes("events.slot.cancelled"));
    assert.ok(values("unknown-channel").includes("audit.unknown"));
    assert.deepEqual(values("operation-without-tests"), ["GET /slots (listSlots)"]);
    // Намеренное исключение: проблема скрыта, счётчик с причиной остаётся.
    assert.ok(!values("broken-endpoint").includes("GET /livez"));
    assert.deepEqual(
      c.suppressed.map((r) => [r.reason, r.count]),
      [["health-проба вне контракта намеренно", 1]],
    );
    assert.ok(!values("broken-symbol").includes("gsm.ParseGSMFrame"));
    // Не пути репозитория — не битые ссылки; префикс прокси у эндпоинта узнаётся.
    for (const v of ["docs/plans/stage-<N>-brief.md", "/etc/hosts.yaml", "./generated/sdk.gen", "../../../contracts/openapi/api.yaml"]) {
      assert.ok(!values("broken-path").includes(v), v);
    }
    assert.ok(!values("broken-endpoint").includes("GET /api/slots/{id}"));
    assert.ok(store.allLinks().some((l) => l.chunkId.startsWith(`${GUIDE}#`) && l.targetId === `${OPENAPI}#GET /slots/{id}` && l.confidence === "medium"));
    assert.ok(store.allLinks().some((l) => l.chunkId.startsWith(`${GUIDE}#`) && l.targetId === OPENAPI && l.confidence === "medium"));
    // Непокрытый код: на apps/admin/src/shared не ссылается ни один раздел; на apps/api/src/slots ссылается руководство.
    assert.ok(c.uncovered.some((u) => u.dir === "apps/admin/src/shared"));
    assert.ok(!c.uncovered.some((u) => u.dir === "apps/api/src/slots"));
    // slot.service.ts изменён 2026-04-01, руководство — 2026-01-01.
    assert.ok(c.stale.some((s) => s.docPath === GUIDE && s.targets.some((t) => t.id.startsWith("apps/api/src/slots/slot.service.ts"))));
  });

  it("index_status: неразрешённые обращения, файл с правилом выбора", () => {
    const s = globalStatus(store);
    assert.ok(s.channel_refs.unresolved > 0 && s.channel_refs.unresolved_share > 0);
    assert.equal(s.unparsed_files.length, 0);
    const f = fileStatus(store, "packages/api-client/src/generated/sdk.gen.ts");
    assert.match(String(f.extractor), /^code v\d+$/);
    assert.match(String(f.selected_by), /правило 1/);
  });
});

describe("тесты и внешние пакеты", () => {
  const KIT = "apps/admin/node_modules/@fx/kit";

  it("внешний пакет: типы и документация в индексе, исходники — нет; импорт и подпуть разрешаются в типы", () => {
    assert.equal(store.getFile(`${KIT}/dist/button.d.ts`)?.package, "@fx/kit");
    assert.equal(store.getSource(`${KIT}/src/button.tsx`), null);
    assert.equal(store.getDocument(`${KIT}/docs/button.md`)?.type, "library");
    const targets = store.importsFrom("apps/admin/src/features/slots/SlotPage.tsx").map((i) => i.toFile);
    assert.ok(targets.includes(`${KIT}/dist/index.d.ts`));
    assert.ok(targets.includes(`${KIT}/dist/fields/index.d.ts`));
    const docs = searchDocs(store, { query: "вид кнопки основная прозрачная" });
    assert.ok(docs.results[0]?.id.startsWith(`${KIT}/docs/button.md#`));
    const code = searchCode(store, { query: "кнопка действия" });
    assert.equal(code.results[0]?.package, "@fx/kit");
  });

  it("кто импортирует: через реэкспорт пакета и через barrel репозитория", () => {
    const button = getSymbol(store, { name: "Button" });
    assert.ok(button.symbols?.[0]?.imported_by.some((x) => x.startsWith("apps/admin/src/features/slots/SlotPage.tsx:") && x.includes("dist/index.d.ts")));
    const card = getSymbol(store, { name: "Card" });
    assert.ok(card.symbols?.[0]?.imported_by.some((x) => x.startsWith("apps/admin/src/features/slots/SlotPage.tsx:") && x.includes("components/index.ts")));
  });

  it("проблемы и покрытие внешних пакетов не попадают в отчёт репозитория", () => {
    const c = computeCheck(store, { limit: 1000 });
    for (const bucket of Object.values(c.problems)) assert.ok(!bucket.items.some((p) => p.path.includes("node_modules")), JSON.stringify(bucket.items[0]));
    assert.ok(!c.uncovered.some((u) => u.dir.includes("node_modules")));
  });

  it("тест-кейсы TS и сценарии Bruno — символы; окружение Bruno пропущено", () => {
    const tests = searchCode(store, { query: "окно доставки", kind: ["test"] }).results.map((r) => r.symbol);
    assert.ok(tests.includes("SlotService › resetSlot сбрасывает окно доставки"));
    assert.ok(tests.includes("get-slot › 200 и окно доставки в ответе"));
    const bru = getSymbol(store, { name: "get-slot" });
    assert.equal(bru.symbols?.[0]?.signature, "GET /slots/{slotId}");
    assert.equal(store.getSource("apps/api/bruno/environments/local.bru")?.kind, "skip");
  });

  it("операция и документ знают свои тесты: по эндпоинту и по ID документа в названии", () => {
    const op = related(store, { target: `${OPENAPI}#GET /slots/{id}` });
    const testedBy = ("api" in op ? op.api?.tested_by : []) ?? [];
    assert.ok(testedBy.some((t) => t.at.startsWith("apps/api/bruno/slots/get-slot.bru")));
    assert.ok(testedBy.some((t) => t.symbol === "SlotService › GET /slots/{id} отдаёт сохранённый слот (ADR-0001)"));
    assert.equal(new Set(testedBy.map((t) => t.at)).size, testedBy.length, "без повторов");
    const reserve = related(store, { target: `${OPENAPI}#POST /slots/{id}/reserve` });
    assert.ok(("api" in reserve ? reserve.api?.tested_by : [])?.some((t) => t.symbol === "SlotService › резервирование отвечает 204"), "HTTP-вызов в тесте");
    const ctrl = getSymbol(store, { name: "SlotsController.get" });
    assert.ok(ctrl.symbols?.[0]?.tested_by?.some((x) => x.includes("get-slot.bru")));
    const adr = related(store, { target: "docs/adr/0001-slot-on-server.md" });
    const adrTests = ("code" in adr ? adr.code : []).filter((c) => "role" in c && c.role === "проверяет").map((c) => ("symbol" in c ? c.symbol : ""));
    assert.ok(adrTests.includes("get-slot"));
    assert.ok(adrTests.includes("SlotService › GET /slots/{id} отдаёт сохранённый слот (ADR-0001)"));
    assert.ok(adrTests.includes("TestNewHandler"), "Go-тест с ADR-0001 в doc-комментарии");
    const goSub = searchCode(store, { query: "явный адрес", kind: ["test"] }).results[0];
    assert.equal(goSub?.symbol, "TestNewHandler › адрес по умолчанию › явный адрес не меняется");
    assert.match(goSub?.at ?? "", /^apps\/worker\/internal\/dispatch\/handler_test\.go:16$/);
    const service = related(store, { target: "apps/api/src/slots/slot.service.ts" });
    assert.ok("tested_by" in service && service.tested_by?.includes("apps/api/src/slots/slot.service.spec.ts"));
  });
});

describe("сервер по stdio через клиент MCP", () => {
  it("каждый инструмент и оба ресурса отвечают", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "src/cli/main.ts"), "serve", "--root", repo],
      cwd: PROJECT_ROOT,
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, ["get_doc", "get_symbol", "get_task_context", "index_status", "related", "search_code", "search_docs"]);
      assert.match(client.getInstructions() ?? "", /search_docs/);
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        assert.notEqual(r.isError, true, `${name}: ${JSON.stringify(r.content)}`);
        return JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? "{}") as Record<string, unknown>;
      };
      assert.ok(((await call("search_docs", { query: "слоты доставки" })).results as unknown[]).length > 0);
      assert.ok("toc" in (await call("get_doc", { path: GUIDE })));
      assert.ok(((await call("search_code", { query: "SlotService" })).results as unknown[]).length > 0);
      assert.ok("symbols" in (await call("get_symbol", { name: "SlotService.resetSlot" })));
      assert.ok("read_before_editing" in (await call("related", { target: "apps/api/src/slots/slot.service.ts" })));
      assert.ok("commit" in (await call("index_status", {})));
      const toc = await client.readResource({ uri: "docs://toc" });
      assert.match(String((toc.contents[0] as { text: string }).text), /docs\/guides\/slots\.md/);
      const doc = await client.readResource({ uri: `docs://${GUIDE}` });
      assert.match(String((doc.contents[0] as { text: string }).text), /# Слоты доставки/);
    } finally {
      await client.close();
    }
  });
});

describe("повторяемость и обновление", () => {
  it("два индекса одного дерева совпадают, CRLF и LF дают один индекс", async () => {
    const a = createFixtureRepo();
    const b = createFixtureRepo({ crlf: true });
    cleanup.push(a, b);
    await runIndex({ root: a });
    await runIndex({ root: a, full: true, dbPath: path.join(a, ".mcp/cache/second.sqlite") });
    await runIndex({ root: b });
    const dumpA = await dump(defaultDbPath(a));
    assert.deepEqual(await dump(path.join(a, ".mcp/cache/second.sqlite")), dumpA);
    assert.deepEqual(await dump(defaultDbPath(b)), dumpA);
  });

  it("правка одного раздела переразбирает один файл и не меняет идентификаторы других разделов", async () => {
    const dir = createFixtureRepo({ history: false });
    cleanup.push(dir);
    await runIndex({ root: dir });
    const db = defaultDbPath(dir);
    const before = (await dump(db)).chunks.filter((c) => c.startsWith(`${GUIDE}#`));
    const file = path.join(dir, GUIDE);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Слотов хватает всегда.", "Слотов хватает всегда, кроме праздников."));
    const second = await runIndex({ root: dir });
    assert.equal(second.extracted, 1);
    const afterChunks = (await dump(db)).chunks.filter((c) => c.startsWith(`${GUIDE}#`));
    assert.deepEqual(afterChunks.map(idOf), before.map(idOf));
    assert.equal(afterChunks.filter((c, i) => c !== before[i]).length, 1);
    const third = await runIndex({ root: dir });
    assert.equal(third.extracted, 0);
  });
});

const idOf = (line: string) => line.split("\u0000")[0];

/** Содержимое индекса без дат и времени сборки — для сравнения двух индексов. */
async function dump(dbPath: string) {
  const s = await openSqliteStore(dbPath, { readonly: true, vectors: false });
  try {
    const chunks = s.listDocuments().flatMap((d) => s.documentChunks(d.path).map((c) => [c.id, c.hash, c.lineStart, c.lineEnd, c.tokens].join("\u0000")));
    const symbols = s.allSymbols().map((x) => [x.id, x.signature, x.comment, x.lineStart, x.lineEnd].join("\u0000"));
    const links = s.allLinks().map((l) => [l.chunkId, l.targetKind, l.targetId, l.source, l.confidence, l.line, l.role].join("\u0000")).sort();
    const files = s.allFiles().map((f) => [f.path, f.package, f.unit, f.isTest, f.generated].join("\u0000"));
    const problems = s.problems().map((p) => [p.kind, p.path, p.line, p.value].join("\u0000")).sort();
    return { chunks, symbols, links, files, problems };
  } finally {
    s.close();
  }
}
