import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultDbPath, runIndex } from "../src/indexer/index.ts";
import { CallLog, summarizeCallLog, type CallLogEntry } from "../src/server/call-log.ts";
import { createServer } from "../src/server/server.ts";
import { openSqliteStore, type SqliteStore } from "../src/store/sqlite/store.ts";
import { createFixtureRepo, rmrf, tempDir } from "./helpers.ts";

let repo = "";
let store: SqliteStore;
let dir = "";

before(async () => {
  repo = createFixtureRepo();
  await runIndex({ root: repo });
  store = await openSqliteStore(defaultDbPath(repo), { readonly: true });
  dir = tempDir("calls");
});
after(() => {
  store?.close();
  rmrf(repo);
  rmrf(dir);
});

/** Клиент MCP, подключённый к серверу в памяти, с журналом в файл. */
async function connect(log: CallLog) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(store, { root: repo, log }).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}
const read = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as CallLogEntry);

describe("журнал вызовов сервера", () => {
  it("пишет инструмент, время, размер пакета и режим поиска; текст задачи — только длиной; ошибки — тоже", async () => {
    const file = path.join(dir, "a", "calls.jsonl");
    const client = await connect(new CallLog(file));
    const task = "Выбранный слот доставки сбрасывается после возврата из корзины";
    await client.callTool({ name: "get_task_context", arguments: { task } });
    await client.callTool({ name: "get_task_context", arguments: { task_id: "fx-404" } });
    await client.callTool({ name: "search_docs", arguments: { query: "слот доставки" } });
    await client.close();

    const [ok, failed, search] = read(file);
    assert.equal(ok?.tool, "get_task_context");
    assert.equal(ok?.ok, true);
    assert.equal(ok?.args.task_chars, task.length);
    assert.equal(ok?.args.task, undefined, "текст задачи не пишется");
    assert.ok(Number(ok?.result?.tokens) > 0 && Number(ok?.result?.code) > 0, JSON.stringify(ok?.result));
    assert.match(String(ok?.result?.search), /по словам/);
    assert.equal(failed?.ok, false);
    assert.match(String(failed?.error), /не найдена/);
    assert.equal(failed?.args.task_id, "fx-404");
    assert.equal(search?.tool, "search_docs");
    assert.ok(Number(search?.result?.results) > 0);

    const summary = summarizeCallLog(read(file));
    assert.match(summary, /\| get_task_context \| 2 \| 1 \|/);
    assert.match(summary, /первый вызов запуска — get_task_context: 1 из 1/);
  });

  it("с task_text — пишет и текст задачи", async () => {
    const file = path.join(dir, "b", "calls.jsonl");
    const client = await connect(new CallLog(file, { taskText: true }));
    await client.callTool({ name: "get_task_context", arguments: { task: "кадр GSM" } });
    await client.close();
    assert.equal(read(file)[0]?.args.task, "кадр GSM");
  });
});
