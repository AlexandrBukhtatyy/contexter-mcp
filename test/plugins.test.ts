import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import YAML from "yaml";
import { ConfigError, parseConfigText } from "../src/config/load.ts";
import { getTaskContext } from "../src/context/build.ts";
import { builtinExtractors, loadRegistry } from "../src/extractors/registry.ts";
import { defaultDbPath, runIndex } from "../src/indexer/index.ts";
import { related } from "../src/links/related.ts";
import { toFtsQuery } from "../src/search/analyze.ts";
import { fileStatus, globalStatus } from "../src/search/queries.ts";
import { openSqliteStore, type SqliteStore } from "../src/store/sqlite/store.ts";
import { PROJECT_ROOT, createFixtureRepo, rmrf } from "./helpers.ts";

/**
 * Свои экстракторы проекта из `.mcp/extractors/`: учебные плагины test/fixtures/plugins (таблицы из схемы БД
 * поверх встроенного code, экраны из манифеста маршрутов), сущности, ссылки на них из текста, шапок и задачи.
 */
const SCHEMA = "packages/db/schema.ts";
const ROUTES = "apps/admin/routes.gen.json";
const STORY = "docs/stories/US-01-book.md";
let repo = "";
let store: SqliteStore;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

before(async () => {
  repo = createFixtureRepo();
  for (const p of ["tables.mjs", "routes.mjs"]) write(`.mcp/extractors/${p}`, fs.readFileSync(path.join(PROJECT_ROOT, "test", "fixtures", "plugins", p), "utf8"));
  write(
    SCHEMA,
    [
      'import { pgTable, text } from "drizzle-orm/pg-core";',
      "",
      "/** Слоты доставки. */",
      'export const slots = pgTable("slots", {',
      '  id: text("id").primaryKey(),',
      '  status: text("status"),',
      "});",
      "",
      'export const courierShifts = pgTable("courier_shifts", { id: text("id") });',
      "",
    ].join("\n"),
  );
  write(
    ROUTES,
    JSON.stringify(
      [
        { path: "/slots/:id", title: "Слот", component: "SlotPage", tabs: [{ value: "deliverywindow", label: "Окно доставки" }] },
        { path: "/couriers", title: "Курьеры", component: "CouriersPage" },
      ],
      null,
      2,
    ),
  );
  write("docs/flows/booking.md", "# Бронирование\n\nПоток бронирования слота клиентом.\n");
  write(
    STORY,
    [
      "---",
      "id: US-01",
      "related:",
      "  adr: [ADR-0001, ADR-0404]",
      "  flows: [booking, nope]",
      "entities: [slots, ghosts]",
      "---",
      "# US-01: Клиент бронирует слот",
      "",
      "Статус слота хранится в `slots.status`, смена курьера — в `courier_shifts`. Экран слота — `/slots/:id`.",
      "",
    ].join("\n"),
  );
  const cfgPath = path.join(repo, ".mcp", "context.yaml");
  const cfg = YAML.parse(fs.readFileSync(cfgPath, "utf8")) as {
    plugins?: string[];
    extractors: { rules: unknown[] };
    entities?: unknown;
    documents: { header_links?: unknown };
  };
  cfg.plugins = [".mcp/extractors/tables.mjs", ".mcp/extractors/routes.mjs"];
  cfg.extractors.rules.unshift({ match: { path: SCHEMA }, use: "tables" }, { match: { path: "**/routes.gen.json" }, use: "routes", options: { title: "Экраны admin" } });
  cfg.entities = { table: { dotted: true, title: "таблица" }, screen: { title: "экран" } };
  cfg.documents.header_links = [{ field: "related.adr" }, { field: "related.flows", path: "docs/flows/$1.md" }, { field: "entities", entity: "table" }];
  fs.writeFileSync(cfgPath, YAML.stringify(cfg));
  await runIndex({ root: repo, embeddings: false });
  store = await openSqliteStore(defaultDbPath(repo), { readonly: true, vectors: false });
});
after(() => {
  store?.close();
  rmrf(repo);
});

describe("свои экстракторы проекта", () => {
  it("плагин дополняет встроенный code: символы файла остаются, таблицы — сущности с символом", () => {
    assert.ok(store.symbolsInFile(SCHEMA).some((s) => s.name === "slots"));
    assert.deepEqual(
      store.entitiesInFile(SCHEMA).map((e) => [e.kind, e.name, e.line, e.symbolId?.split("#").pop() ?? null]),
      [
        ["table", "slots", 4, "slots"],
        ["table", "courier_shifts", 9, "courierShifts"],
      ],
    );
    const st = fileStatus(store, SCHEMA) as { extractor: string; entities?: unknown[] };
    assert.match(st.extractor, /^tables v1/);
    assert.equal(st.entities?.length, 2);
    assert.deepEqual(globalStatus(store).entities, { screen: 2, table: 2 });
  });

  it("searchText дополняет text: экран находится по подписи вкладки и по её значению; YAML контракта (searchOnly) в поиск не идёт", () => {
    const find = (q: string) => store.searchChunks(toFtsQuery(q) ?? "", { limit: 20 }).map((h) => h.chunk.id);
    const screen = `${ROUTES}#slots-id`;
    assert.ok(find("Окно доставки").includes(screen), "слова из text");
    assert.ok(find("deliverywindow").includes(screen), "слова из searchText");
    const yamlOnly = find("responses content").filter((id) => id.startsWith("contracts/openapi/api.yaml#"));
    assert.deepEqual(yamlOnly, [], "служебные ключи YAML операций не ищутся");
  });

  it("манифест → экраны: раздел на маршрут, сущность-экран, связь на компонент страницы", () => {
    const chunks = store.documentChunks(ROUTES);
    assert.deepEqual(chunks.map((c) => c.headingPath.join(" › ")), ["Экраны admin › Слот", "Экраны admin › Курьеры"]);
    const screen = store.entitiesByName("/slots/:id")[0];
    assert.equal(screen?.chunkId, chunks[0]?.id);
    const toPage = store.linksFromChunk(chunks[0]?.id ?? "").find((l) => l.targetKind === "symbol");
    assert.match(String(toPage?.targetId), /SlotPage\.tsx#SlotPage$/);
  });

  it("сущность в обратных кавычках в документе — связь на объявление; related файла схемы показывает документ", () => {
    const story = store.documentChunks(STORY)[0];
    const ent = store.linksFromChunk(story?.id ?? "").filter((l) => l.source === "entity");
    assert.deepEqual(ent.map((l) => [l.role, l.targetKind, l.targetId.split("#").pop()]).sort(), [
      ["screen", "chunk", "slots-id"],
      ["table", "symbol", "courierShifts"],
      ["table", "symbol", "slots"],
    ]);
    const r = related(store, { target: SCHEMA }) as unknown as { declares?: string[]; read_before_editing: Array<{ doc?: string; why: string[] }> };
    assert.deepEqual(r.declares, ["table slots :4", "table courier_shifts :9"]);
    assert.ok(r.read_before_editing.some((d) => JSON.stringify(d).includes(STORY)), JSON.stringify(r.read_before_editing));
  });

  it("шапка документа: ADR по id_refs, flow по шаблону пути, таблица по сущности; неразрешённое — broken-header-ref", () => {
    const first = store.documentChunks(STORY)[0];
    const header = store.linksFromChunk(first?.id ?? "").filter((l) => l.source === "header");
    assert.deepEqual(header.map((l) => [l.targetKind, l.targetId.split("#").pop()]).sort(), [
      ["doc", "docs/adr/0001-slot-on-server.md"],
      ["doc", "docs/flows/booking.md"],
      ["symbol", "slots"],
    ]);
    assert.deepEqual(store.problems("broken-header-ref").map((p) => p.value).sort(), ["ADR-0404", "ghosts", "nope"]);
  });

  it("задача называет таблицу и экран в обратных кавычках — точные совпадения и опорные точки", () => {
    const p = getTaskContext(store, { task: "Добавить колонку в `slots.status` и показать её на экране `/slots/:id`" }, { debug: true });
    const ranking = p.meta.ranking as Array<{ key: string; lists: Record<string, number> }>;
    assert.ok(ranking.find((r) => r.key === `c:${SCHEMA}#slots`)?.lists.exact, JSON.stringify(ranking.slice(0, 8)));
    assert.ok(ranking.find((r) => r.key.startsWith(`d:${ROUTES}#`))?.lists.exact);
    assert.deepEqual((p.meta.anchors as { entities?: string[] }).entities, ["slots.status", "/slots/:id"]);
    assert.ok(!((p.meta.not_found as string[] | undefined) ?? []).includes("/slots/:id"));
    assert.ok(p.code.some((c) => String(c.why).includes("таблица `slots`")), JSON.stringify(p.code.map((c) => c.why)));
  });

  it("правка модуля плагина переиндексирует его файлы, остальные — нет", async () => {
    const again = await runIndex({ root: repo, embeddings: false, dbPath: path.join(repo, ".mcp", "cache", "second.sqlite") });
    const plugin = path.join(repo, ".mcp", "extractors", "tables.mjs");
    fs.appendFileSync(plugin, "\n// правка модуля\n");
    const after = await runIndex({ root: repo, embeddings: false, dbPath: path.join(repo, ".mcp", "cache", "second.sqlite") });
    assert.ok(again.extracted > 1);
    assert.equal(after.extracted, 1, "переразобран только файл схемы");
  });
});

describe("конфиг своих экстракторов", () => {
  it("модуль, которого нет, — понятная ошибка; path и entity вместе в header_links — ошибка конфига", async () => {
    const dir = createFixtureRepo({ history: false });
    try {
      fs.writeFileSync(path.join(dir, ".mcp", "context.yaml"), "plugins: [.mcp/extractors/none.mjs]\n");
      await assert.rejects(loadRegistry(dir), /плагин не найден: \.mcp\/extractors\/none\.mjs/);
    } finally {
      rmrf(dir);
    }
    try {
      parseConfigText("documents:\n  header_links:\n    - { field: x, path: 'a/$1.md', entity: table }\n    - { field: y, path: 'a/b.md' }\n", ".mcp/context.yaml", builtinExtractors());
      assert.fail("ожидалась ошибка конфига");
    } catch (e) {
      assert.ok(e instanceof ConfigError, String(e));
      const text = e.problems.map((p) => `${p.path}: ${p.message}`).join("\n");
      assert.match(text, /header_links\.0: укажите что-то одно/);
      assert.match(text, /header_links\.1\.path: в шаблоне пути нужен \$1/);
    }
  });
});
