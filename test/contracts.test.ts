import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { asyncapiExtractor, openapiExtractor } from "../src/extractors/contracts.ts";
import type { DocumentRecord, Extractor } from "../src/extractors/types.ts";
import { normalizeText, sha256 } from "../src/util/text.ts";
import { FIXTURE_REPO } from "./helpers.ts";

async function run(extractor: Extractor<Record<string, unknown>>, rel: string, text?: string): Promise<DocumentRecord> {
  const t = normalizeText(text ?? fs.readFileSync(path.join(FIXTURE_REPO, rel), "utf8"));
  const r = await extractor.extract({ path: rel, text: t, hash: sha256(t) }, {});
  assert.equal(r.kind, "document");
  return (r as { document: DocumentRecord }).document;
}
const OPENAPI = "contracts/openapi/api.yaml";
const ASYNCAPI = "contracts/asyncapi/events.yaml";

describe("экстрактор openapi", () => {
  it("фрагмент на операцию: метод, путь, operationId и строка в YAML", async () => {
    const d = await run(openapiExtractor as never, OPENAPI);
    const op = d.chunks.find((c) => c.id === `${OPENAPI}#GET /slots/{id}`);
    assert.ok(op);
    assert.deepEqual(op.api, { kind: "operation", key: "getSlot", method: "GET", path: "/slots/{id}" });
    const lines = fs.readFileSync(path.join(FIXTURE_REPO, OPENAPI), "utf8").split("\n");
    assert.equal(lines[op.lineStart - 1]?.trim(), "get:");
    assert.ok(lines[op.lineStart]?.includes("operationId: getSlot"));
    assert.ok(op.text.startsWith("get:\n  operationId: getSlot"));
    assert.ok(op.searchText?.includes("Слот по идентификатору"));
    assert.ok(op.refs.some((r) => r.kind === "ref" && r.value === "#/components/schemas/SlotDto"));
    assert.equal(d.type, "api");
  });

  it("схемы — отдельные фрагменты, внешний $ref сохраняется", async () => {
    const d = await run(openapiExtractor as never, OPENAPI);
    const schema = d.chunks.find((c) => c.id === `${OPENAPI}#schema/SlotDto`);
    assert.ok(schema?.refs.some((r) => r.value === "../schemas/slot-meta.json#/definitions/Meta"));
    assert.ok(d.chunks.some((c) => c.kind === "info" && c.text.includes("Fixture API")));
  });

  it("правка одной операции не меняет идентификаторы остальных", async () => {
    const original = fs.readFileSync(path.join(FIXTURE_REPO, OPENAPI), "utf8");
    const edited = original.replace("summary: Зарезервировать слот", "summary: Зарезервировать слот на час\n      description: Новое описание.");
    const a = await run(openapiExtractor as never, OPENAPI, original);
    const b = await run(openapiExtractor as never, OPENAPI, edited);
    assert.deepEqual(b.chunks.map((c) => c.id), a.chunks.map((c) => c.id));
    const changed = b.chunks.filter((c, i) => c.hash !== a.chunks[i]?.hash).map((c) => c.id);
    assert.deepEqual(changed, [`${OPENAPI}#POST /slots/{id}/reserve`]);
  });
});

describe("экстрактор asyncapi", () => {
  it("каналы с адресами, операции и шапка с комментарием", async () => {
    const d = await run(asyncapiExtractor as never, ASYNCAPI);
    const ch = d.chunks.find((c) => c.id === `${ASYNCAPI}#channel/slotReserved`);
    assert.deepEqual(ch?.api, { kind: "channel", key: "slotReserved", address: "events.slot.reserved" });
    const lines = fs.readFileSync(path.join(FIXTURE_REPO, ASYNCAPI), "utf8").split("\n");
    assert.equal(lines[(ch?.lineStart ?? 0) - 1]?.trim(), "slotReserved:");
    const op = d.chunks.find((c) => c.id === `${ASYNCAPI}#operation/onSlotReserved`);
    assert.equal(op?.api?.address, "events.slot.reserved");
    const info = d.chunks.find((c) => c.kind === "info");
    assert.ok(info?.text.includes("ADR-0001"));
    assert.equal(info?.lineStart, 1);
    assert.ok(d.chunks.some((c) => c.id === `${ASYNCAPI}#message/SlotReserved`));
  });
});
