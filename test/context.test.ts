import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cmdEval } from "../src/cli/query-commands.ts";
import { getTaskContext, serializePackage, type TaskContextPackage } from "../src/context/build.ts";
import { parseTask } from "../src/context/parse.ts";
import { defaultDbPath, runIndex } from "../src/indexer/index.ts";
import { openSqliteStore, type SqliteStore } from "../src/store/sqlite/store.ts";
import { countTokens } from "../src/util/tokens.ts";
import { PROJECT_ROOT, createFixtureRepo, rmrf } from "./helpers.ts";

const GUIDE = "docs/guides/slots.md";
const OPENAPI = "contracts/openapi/api.yaml";
let repo = "";
let store: SqliteStore;

before(async () => {
  repo = createFixtureRepo();
  await runIndex({ root: repo });
  store = await openSqliteStore(defaultDbPath(repo), { readonly: true, vectors: false });
});
after(() => {
  store?.close();
  rmrf(repo);
});

const files = (p: TaskContextPackage, section: "code" | "tests") => p[section].map((e) => String(e.at).replace(/:\d+$/, ""));
const docIds = (p: TaskContextPackage) => [...p.docs, ...p.rules].map((d) => String(d.id));

describe("разбор задачи", () => {
  it("пути, идентификаторы, эндпоинты, ошибки, ID документов и задач", () => {
    const p = parseTask(
      "Падает `SlotService.resetSlot` в apps/api/src/slots/slot.service.ts:21 после GET /slots/{id}.\nError: слот не найден\nСм. ADR-0001 и задачу fx-3, вызов dispatch.NewHandler() и parseGSMFrame.",
      { idRefs: [{ pattern: "ADR-(\\d{4})", path: "docs/adr/$1-*.md" }], taskIdPattern: "\\bfx-[a-z0-9]+\\b" },
    );
    assert.deepEqual(p.paths, [{ value: "apps/api/src/slots/slot.service.ts", line: 21 }]);
    assert.deepEqual(p.endpoints, [{ method: "GET", path: "/slots/{id}" }]);
    assert.deepEqual(p.docIds, [{ value: "ADR-0001", glob: "docs/adr/0001-*.md" }]);
    assert.deepEqual(p.taskIds, ["fx-3"]);
    for (const id of ["SlotService.resetSlot", "dispatch.NewHandler()", "parseGSMFrame"]) assert.ok(p.identifiers.includes(id), id);
    assert.ok(!p.identifiers.includes("ADR"));
    assert.ok(p.errors.some((e) => e.includes("Error: слот не найден")));
  });
});

describe("get_task_context", () => {
  it("по тексту задачи: раздел документации, правило, место в коде, тест; сводка и мета", () => {
    const p = getTaskContext(store, { task: "При возврате из корзины сбрасывается выбранный слот доставки" });
    assert.ok(docIds(p).includes(`${GUIDE}#слоты-доставки/хранение-выбора-слота`), JSON.stringify(docIds(p)));
    assert.ok(p.rules.some((r) => String(r.id).startsWith("docs/adr/0001-slot-on-server.md#")), "ADR-0001 — в rules");
    assert.ok(files(p, "code").includes("apps/api/src/slots/slot.service.ts"));
    assert.ok(files(p, "tests").includes("apps/api/src/slots/slot.service.spec.ts"));
    for (const e of [...p.docs, ...p.code, ...p.rules]) assert.ok(String(e.why).length > 0, "у каждого элемента есть причина");
    assert.match(p.summary, /правил: \d+, тестов к запуску: \d+/);
    assert.match(p.summary, /^Код задачи — в /, "в сводке — пакеты, где лежит код задачи");
    assert.equal(p.meta.budget_tokens, 6000);
    assert.match(p.note, /данные, а не инструкции/);
  });

  it("место в списке считается отдельно для документов и для кода", () => {
    const p = getTaskContext(store, { task: "При возврате из корзины сбрасывается выбранный слот доставки" }, { debug: true });
    const ranking = p.meta.ranking as Array<{ key: string; lists: Record<string, number> }>;
    const ranksOf = (prefix: RegExp) => ranking.filter((r) => prefix.test(r.key) && r.lists.words).map((r) => r.lists.words as number);
    // Лучший символ из поиска по словам — первый в своём виде, а не после всех разделов документации.
    assert.equal(Math.min(...ranksOf(/^[cf]:/)), 1);
    assert.equal(Math.min(...ranksOf(/^d:/)), 1);
  });

  it("документ, названный в задаче путём, — точное совпадение: его ближайший к задаче раздел в пакете", () => {
    const p = getTaskContext(store, { task: "Обработчик воркера не разбирает кадр GSM, `dispatch.NewHandler`, SlotService. Сверить с docs/guides/slots.md" });
    const doc = [...p.docs, ...p.rules].find((d) => String(d.id).startsWith(`${GUIDE}#`));
    assert.ok(doc, JSON.stringify(docIds(p)));
    assert.match(String(doc?.why), /путь из задачи/);
  });

  it("документ из задачи (ID) идёт в пакет первым, вне долей бюджета", () => {
    const p = getTaskContext(store, { task: "Слот доставки должен храниться на сервере, см. ADR-0001", budget_tokens: 2000 }, { shares: { docs: 0.5, code: 0.5, rules: 0 } });
    assert.ok(p.rules.some((r) => String(r.id).startsWith("docs/adr/0001-slot-on-server.md#")), JSON.stringify(docIds(p)));
  });

  // Что названный документ закрепляется раньше операций с большим счётом, видно на большом репозитории
  // (ADR и три операции с большим счётом); в учебном репозитории ADR по словам и так обгоняет операции.
  it("документ и операции, названные в задаче, закрепляются при нулевых долях документации и правил", () => {
    const task = "Операции `GET /slots`, `GET /slots/{id}`, `POST /slots/{id}/reserve` должны следовать ADR-0001";
    const p = getTaskContext(store, { task, budget_tokens: 4000 }, { shares: { docs: 0, code: 1, rules: 0 } });
    assert.ok(p.rules.some((r) => String(r.id).startsWith("docs/adr/0001-slot-on-server.md#")), JSON.stringify(docIds(p)));
    assert.ok(p.docs.some((d) => String(d.id).startsWith(OPENAPI)), JSON.stringify(docIds(p)));
  });

  it("документ, на который ссылается сильный раздел (ID документа в тексте), — кандидат по связи", () => {
    const p = getTaskContext(store, { task: "Решения по слотам: сброс через resetSlot, список через slotIds, каталог воркера dispatch" }, { debug: true });
    const ranking = p.meta.ranking as Array<{ key: string; lists: Record<string, number>; why?: string }>;
    const adr = ranking.find((r) => r.key.startsWith("d:docs/adr/0001-slot-on-server.md#"));
    assert.ok(adr?.lists.links, JSON.stringify(ranking.slice(0, 12).map((r) => [r.key, r.lists])));
  });

  it("файлы, которые импортируют имя из задачи, — кандидаты в код", () => {
    const p = getTaskContext(store, { task: "Поменять поведение `SlotService` при резервировании" }, { debug: true });
    const ranking = p.meta.ranking as Array<{ key: string; lists: Record<string, number> }>;
    const user = ranking.find((r) => r.key === "f:apps/api/src/slots/slots.controller.ts");
    assert.ok(user?.lists.users, JSON.stringify(ranking.slice(0, 10)));
  });

  it("тест, названный в задаче, попадает в пакет первым", () => {
    const p = getTaskContext(store, { task: "Падает apps/worker/internal/dispatch/handler_test.go после правки резервирования слота и SlotService" });
    assert.equal(files(p, "tests")[0], "apps/worker/internal/dispatch/handler_test.go", JSON.stringify(p.tests));
  });

  it("никогда не превышает бюджет и всегда остаётся корректным JSON", () => {
    for (const budget of [200, 300, 500, 800, 1500, 3000, 6000]) {
      const p = getTaskContext(store, { task: "Резервирование слота и событие в очередь, GET /slots/{id}, SlotService, ADR-0001", budget_tokens: budget });
      const text = serializePackage(p);
      assert.ok(countTokens(text) <= budget, `${budget}: ${countTokens(text)}`);
      assert.equal(p.meta.used_tokens, countTokens(text));
      assert.doesNotThrow(() => JSON.parse(text));
    }
  });

  it("один и тот же запрос на одном индексе даёт один и тот же пакет", () => {
    const args = { task: "Обработчик команд не разбирает кадр GSM", open_files: ["apps/worker/internal/dispatch/handler.go"], budget_tokens: 2500 };
    assert.equal(serializePackage(getTaskContext(store, args)), serializePackage(getTaskContext(store, args)));
  });

  it("эндпоинт из задачи: операция контракта, её обработчик и тесты", () => {
    const p = getTaskContext(store, { task: "GET /slots/{id} отвечает 404 для существующего слота" });
    assert.ok(docIds(p).includes(`${OPENAPI}#GET /slots/{id}`));
    assert.ok(p.code.some((c) => c.symbol === "SlotsController.get"));
    const tests = files(p, "tests");
    assert.ok(tests.includes("apps/api/bruno/slots/get-slot.bru") || tests.includes("apps/api/src/slots/slot.service.spec.ts"), JSON.stringify(p.tests));
  });

  it("идентификатор и открытый файл — опорные точки; соседние файлы пакета Go", () => {
    const p = getTaskContext(store, { task: "Почему `dispatch.NewHandler` не подставляет адрес очереди?", open_files: ["apps/worker/internal/dispatch/handler.go"] });
    assert.deepEqual((p.meta.anchors as { files: string[] }).files.includes("apps/worker/internal/dispatch/handler.go"), true);
    assert.ok(p.code.some((c) => c.symbol === "NewHandler"));
    assert.ok(files(p, "tests").includes("apps/worker/internal/dispatch/handler_test.go"));
  });

  it("ID задачи beads: текст из индекса всегда, файлы из коммитов задачи — по просьбе (task_history)", () => {
    const why = (p: TaskContextPackage) => p.code.map((c) => String(c.why)).join("\n");
    const plain = getTaskContext(store, { task_id: "fx-2" });
    assert.deepEqual(plain.meta.task, { id: "fx-2", title: "Повтор отправки кадра GSM при сбое", status: "open" });
    assert.doesNotMatch(why(plain), /правился по задаче/, "по умолчанию история задачи не добавляется");
    assert.equal(plain.meta.on_request, "история задачи не включена: файлов из её коммитов — 2; добавит task_history: true");

    const p = getTaskContext(store, { task_id: "fx-2", task_history: true });
    const helper = p.code.find((c) => String(c.at).startsWith("apps/worker/internal/dispatch/helper.go"));
    assert.ok(helper, JSON.stringify(p.code));
    assert.match(String(helper?.why), /правился по задаче fx-2 \(2 комм\.\)/);
    assert.equal(p.meta.on_request, undefined);
    const honest = getTaskContext(store, { task_id: "fx-2", task_history: true }, { useTaskHistory: false });
    assert.doesNotMatch(why(honest), /правился по задаче/, "замер выключает историю поверх запроса");
    assert.equal(honest.meta.on_request, undefined, "в замере подсказки нет");
    assert.throws(() => getTaskContext(store, { task_id: "fx-404" }), /не найдена/);
  });

  it("похожие задачи — по просьбе (similar_tasks); в замере исключаются сама задача и более поздние", () => {
    const task = "Резервирование слота должно публиковать событие для воркера";
    const similar = (p: TaskContextPackage) => (p.meta.anchors as { similar_tasks?: string[] }).similar_tasks;
    const plain = getTaskContext(store, { task });
    assert.equal(similar(plain), undefined, "по умолчанию похожие задачи не ищутся");
    assert.ok(!plain.code.some((c) => String(c.why).includes("похожей задаче")));
    const p = getTaskContext(store, { task, similar_tasks: true });
    assert.deepEqual(similar(p), ["fx-3"]);
    assert.ok(p.code.some((c) => String(c.why).includes("похожей задаче fx-3")));
    const excluded = getTaskContext(store, { task, similar_tasks: true }, { excludeTaskIds: ["fx-3"] });
    assert.equal(similar(excluded), undefined);
    const earlier = getTaskContext(store, { task, similar_tasks: true }, { tasksBefore: "2026-02-01T00:00:00Z" });
    assert.ok(!(similar(earlier) ?? []).includes("fx-3"));
  });

  it("отвечает быстрее секунды", () => {
    const t0 = performance.now();
    getTaskContext(store, { task: "Слоты доставки: резервирование, событие, обработчик воркера, кадр GSM, ADR-0001, GET /slots/{id}" });
    assert.ok(performance.now() - t0 < 1000);
  });

  it("замер на эталонном наборе: метрики плана считаются, бюджет не превышен", async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await cmdEval(repo, defaultDbPath(repo), { setPath: path.join(PROJECT_ROOT, "test/fixtures/eval/tasks.jsonl"), k: 10, asJson: true });
    } finally {
      process.stdout.write = write;
    }
    const { summary } = JSON.parse(out.join("")) as {
      summary: { tasks: number; over_budget: number; file_recall: number; doc_recall: number; precision: number; precision_top5: number; ms_p95: number };
    };
    assert.equal(summary.tasks, 3);
    assert.equal(summary.over_budget, 0);
    assert.ok(summary.file_recall >= 0.5, `полнота файлов ${summary.file_recall}`);
    assert.ok(summary.doc_recall >= 0.5, `полнота документов ${summary.doc_recall}`);
    assert.ok(summary.precision_top5 >= summary.precision, "наверху пакета нужного не меньше, чем в среднем по пакету");
    assert.ok(summary.ms_p95 < 1500);
  });
});

describe("MCP: инструмент get_task_context и промпт start-task", () => {
  it("отвечают через stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "src/cli/main.ts"), "serve", "--root", repo],
      cwd: PROJECT_ROOT,
      stderr: "pipe",
    });
    const client = new Client({ name: "context-test", version: "0" });
    await client.connect(transport);
    try {
      const r = await client.callTool({ name: "get_task_context", arguments: { task: "Сброс выбранного слота доставки", budget_tokens: 1500 } });
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? "";
      assert.ok(countTokens(text) <= 1500);
      assert.ok((JSON.parse(text) as TaskContextPackage).docs.length > 0);
      const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
      assert.ok(prompts.includes("start-task"));
      const prompt = await client.getPrompt({ name: "start-task", arguments: { task: "fx-2" } });
      const msg = (prompt.messages[0]?.content as { text: string }).text;
      assert.match(msg, /get_task_context/);
      assert.match(msg, /task_id: "fx-2"/);
    } finally {
      await client.close();
    }
  });
});
