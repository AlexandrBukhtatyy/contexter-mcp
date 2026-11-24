import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CodeOptions, extractTs } from "../src/extractors/code-ts.ts";
import { GoOptions, extractGo } from "../src/extractors/code-go.ts";
import { brunoExtractor, bruPath } from "../src/extractors/bruno.ts";
import { normalizeText, sha256 } from "../src/util/text.ts";
import { FIXTURE_REPO } from "./helpers.ts";

const read = (rel: string) => {
  const text = normalizeText(fs.readFileSync(path.join(FIXTURE_REPO, rel), "utf8"));
  return { path: rel, text, hash: sha256(text) };
};

describe("экстрактор code (TS/JS)", () => {
  it("класс, методы с декораторами, комментарии и ключ operationId с контекстом", () => {
    const r = extractTs(read("apps/api/src/slots/slots.controller.ts"), CodeOptions.parse({}));
    const cls = r.symbols.find((s) => s.qualified === "SlotsController");
    assert.equal(cls?.kind, "class");
    assert.equal(cls?.comment, "HTTP-контроллер слотов доставки.");
    const get = r.symbols.find((s) => s.qualified === "SlotsController.get");
    assert.ok(get?.signature.includes('@Get(":id")'));
    assert.ok(get?.signature.includes("get(@Param"));
    const key = r.keys.find((k) => k.value === "getSlot");
    assert.equal(key?.context, "ApiOperation.operationId");
    assert.equal(key?.symbolId, get?.id);
    assert.ok(r.imports.some((i) => i.specifier === "./slot.service" && i.names.includes("SlotService")));
    assert.equal(r.isTest, false);
  });

  it("строковые ключи: переменная, вызов, шаблон с подстановкой — неразрешённый", () => {
    const r = extractTs(read("apps/api/src/slots/slot.service.ts"), CodeOptions.parse({}));
    assert.ok(r.keys.some((k) => k.value === "events.slot.reserved" && k.context === "SLOT_RESERVED_SUBJECT"));
    assert.ok(r.keys.some((k) => k.value === "events.slot.reserved" && k.context === "publish"));
    const pattern = r.keys.find((k) => k.pattern);
    assert.equal(pattern?.value, "events.slot.*");
    assert.ok(r.symbols.some((s) => s.qualified === "SlotService.resetSlot" && s.comment === "Сбрасывает выбранный слот."));
  });

  it("ключи данных: поля интерфейсов и ключи объектов, но не методы", () => {
    const r = extractTs(read("apps/api/src/slots/slot.service.ts"), CodeOptions.parse({}));
    for (const k of ["slotIds", "id", "window", "slotId"]) assert.ok(r.dataKeys.includes(k), k);
    for (const k of ["resetSlot", "find", "reserve"]) assert.ok(!r.dataKeys.includes(k), k);
  });

  it("тест и сгенерированный файл узнаются; у сгенерированного нет комментариев", () => {
    assert.equal(extractTs(read("apps/api/src/slots/slot.service.spec.ts"), CodeOptions.parse({})).isTest, true);
    const gen = extractTs(read("packages/api-client/src/generated/sdk.gen.ts"), CodeOptions.parse({}));
    assert.equal(gen.generated, true);
    assert.ok(gen.symbols.every((s) => s.comment === ""));
    assert.ok(gen.symbols.some((s) => s.name === "getSlot" && s.exported));
  });

  it("вспомогательный код в каталоге тестов — не тест; тестовое имя или тест-кейсы — тест", () => {
    const src = (p: string, text: string) => ({ path: p, text, hash: sha256(text) });
    const opts = CodeOptions.parse({});
    assert.equal(extractTs(src("apps/admin-e2e/tests/quality/config.ts", "export const changedRatio = 0.001;\n"), opts).isTest, false);
    assert.equal(extractTs(src("apps/admin-e2e/tests/unique.ts", "export function unique(p: string) { return `${p}-${Date.now()}`; }\n"), opts).isTest, false);
    // Тесты в цикле с вычисляемым названием не находятся, но имя файла тестовое.
    assert.equal(extractTs(src("apps/admin-e2e/tests/cases.spec.ts", "for (const c of cases) test(c.name, async () => {});\n"), opts).isTest, true);
    assert.equal(extractTs(src("apps/admin-e2e/tests/smoke.ts", 'test("открывает главную", async () => {});\n'), opts).isTest, true);
  });

  it("тест-кейсы: набор и тесты с цепочкой названий", () => {
    const r = extractTs(read("apps/api/src/slots/slot.service.spec.ts"), CodeOptions.parse({}));
    const tests = r.symbols.filter((s) => s.kind === "test" || s.kind === "suite").map((s) => [s.kind, s.qualified]);
    assert.deepEqual(tests, [
      ["suite", "SlotService"],
      ["test", "SlotService › resetSlot сбрасывает окно доставки"],
      ["test", "SlotService › резервирование отвечает 204"],
      ["test", "SlotService › GET /slots/{id} отдаёт сохранённый слот (ADR-0001)"],
    ]);
    assert.equal(r.symbols.find((s) => s.qualified.endsWith("(ADR-0001)"))?.comment, "Контракт чтения слота — ADR-0001.");
    const call = r.keys.find((k) => k.context === "http-call");
    assert.equal(call?.value, "POST /slots/{}/reserve");
    assert.equal(call?.symbolId, r.symbols.find((s) => s.qualified === "SlotService › резервирование отвечает 204")?.id);
  });

  it("Bruno: метод и путь запроса, docs и тесты из скриптов", () => {
    const text = normalizeText(fs.readFileSync(path.join(FIXTURE_REPO, "apps/api/bruno/slots/get-slot.bru"), "utf8"));
    const r = brunoExtractor.extract({ path: "apps/api/bruno/slots/get-slot.bru", text, hash: "h" }, {}) as { kind: string; code: { symbols: Array<{ kind: string; qualified: string; signature: string; comment: string }> } };
    assert.equal(r.kind, "code");
    assert.deepEqual(
      r.code.symbols.map((s) => [s.kind, s.qualified, s.signature]),
      [
        ["http-test", "get-slot", "GET /slots/{slotId}"],
        ["test", "get-slot › 200 и окно доставки в ответе", 'test("200 и окно доставки в ответе")'],
      ],
    );
    assert.match(r.code.symbols[0]?.comment ?? "", /ADR-0001/);
    assert.equal(bruPath("https://api.example.com/v1/{{x}}"), "/v1/{x}");
  });

  it("компонент React и импорт через алиас", () => {
    const r = extractTs(read("apps/admin/src/features/slots/SlotPage.tsx"), CodeOptions.parse({}));
    assert.equal(r.symbols.find((s) => s.name === "SlotPage")?.kind, "component");
    assert.ok(r.imports.some((i) => i.specifier === "@/shared/format"));
  });
});

describe("экстрактор code-go", () => {
  it("функции, методы с получателем, типы, методы интерфейса, константы и doc-комментарии", () => {
    const r = extractGo(read("apps/worker/internal/dispatch/handler.go"), GoOptions.parse({}));
    assert.equal(r.unitName, "dispatch");
    const byQ = new Map(r.symbols.map((s) => [s.qualified, s]));
    assert.equal(byQ.get("NewHandler")?.kind, "function");
    assert.equal(byQ.get("NewHandler")?.comment, "NewHandler создаёт обработчик команд.");
    assert.equal(byQ.get("Handler.Handle")?.kind, "method");
    assert.ok(byQ.get("Handler.Handle")?.signature.startsWith("func (h *Handler) Handle(ctx context.Context"));
    assert.equal(byQ.get("Handler.reply")?.exported, false);
    assert.equal(byQ.get("Handler")?.kind, "struct");
    assert.equal(byQ.get("Handler")?.comment, "Handler обрабатывает команды по слотам доставки\nи отправляет кадры GSM-модулю.");
    assert.equal(byQ.get("Store")?.kind, "interface");
    assert.equal(byQ.get("Store.Load")?.kind, "method");
    assert.equal(byQ.get("commandSubject")?.kind, "const");
    assert.deepEqual(
      r.imports.map((i) => [i.specifier, i.names[0]]),
      [
        ["context", "*"],
        ["fmt", "*"],
        ["example.com/fx/gsm", "gsm"],
      ],
    );
    assert.ok(r.keys.some((k) => k.value === "slot-command" && k.context === "commandSubject"));
    assert.deepEqual(r.dataKeys, ["subject"]);
  });

  it("контекст литерала в вызове и составном литерале", () => {
    const r = extractGo(read("apps/worker/cmd/worker/main.go"), GoOptions.parse({}));
    assert.ok(r.keys.some((k) => k.value === "events.slot.>" && k.context === "queue.Subscribe"));
    assert.ok(r.keys.some((k) => k.value === "slot-command" && k.context === "Subject"));
  });

  it("тестовый и сгенерированный файлы", () => {
    assert.equal(extractGo(read("apps/worker/internal/dispatch/handler_test.go"), GoOptions.parse({})).isTest, true);
    const gen = extractGo(read("apps/worker/internal/dispatch/zz_generated.go"), GoOptions.parse({}));
    assert.equal(gen.generated, true);
    assert.equal(gen.symbols[0]?.comment, "");
  });

  it("тест-функции и подтесты t.Run: цепочка названий, комментарии, литералы — у своего подтеста", () => {
    const r = extractGo(read("apps/worker/internal/dispatch/handler_test.go"), GoOptions.parse({}));
    const tests = r.symbols.filter((s) => s.kind === "test");
    assert.deepEqual(
      tests.map((s) => s.qualified),
      [
        "TestNewHandler",
        "TestNewHandler › адрес по умолчанию",
        "TestNewHandler › адрес по умолчанию › явный адрес не меняется",
        "TestNewHandler › табличный",
        "TestNewHandler › вложенный в табличный",
        "TestSubjects",
        "TestSubjects › первый адрес",
        "TestSubjects › второй адрес",
        "TestSubjects › пустой",
        "TestSubjects › заданный",
        "TestPositionalTable",
        "TestPositionalTable › позиционный первый",
        "TestPositionalTable › позиционный второй",
        "BenchmarkNewHandler",
      ],
    );
    const byQ = new Map(tests.map((s) => [s.qualified, s]));
    assert.equal(byQ.get("TestNewHandler")?.comment, "TestNewHandler проверяет настройки обработчика (ADR-0001).");
    assert.equal(byQ.get("TestNewHandler › адрес по умолчанию")?.comment, "Адрес очереди по умолчанию.");
    assert.equal(byQ.get("TestNewHandler › адрес по умолчанию")?.signature, 't.Run("адрес по умолчанию")');
    assert.deepEqual([byQ.get("TestNewHandler › адрес по умолчанию")?.lineStart, byQ.get("TestNewHandler › адрес по умолчанию")?.lineEnd], [11, 22]);
    // Случай таблицы — на строке, где он объявлен.
    assert.equal(byQ.get("TestNewHandler › табличный")?.lineStart, 24);
    assert.equal(byQ.get("TestNewHandler › табличный")?.signature, 't.Run(tc.name) — случай таблицы "табличный"');
    assert.equal(byQ.get("TestSubjects › заданный")?.lineStart, 38);
    const key = (v: string) => r.keys.find((k) => k.value === v)?.symbolId;
    assert.equal(key("slot-command"), byQ.get("TestNewHandler › адрес по умолчанию")?.id);
    assert.equal(key("custom-subject"), byQ.get("TestNewHandler › адрес по умолчанию › явный адрес не меняется")?.id);
    // В основном коде t.Run не ищется, а функции Test… в нетестовом файле — обычные функции.
    const main = extractGo({ path: "p/p.go", text: "package p\n\nfunc TestLike() {}\n", hash: "x" }, GoOptions.parse({}));
    assert.equal(main.symbols[0]?.kind, "function");
  });

  it("строки, комментарии и руны не путают разбор", () => {
    const src = 'package p\n\n// F — функция.\nfunc F() string {\n\ts := "a { b"\n\tr := \'{\'\n\t/* } */\n\treturn s + string(r) + `raw }`\n}\n\nfunc G() {}\n';
    const r = extractGo({ path: "p/p.go", text: src, hash: "x" }, GoOptions.parse({}));
    assert.deepEqual(r.symbols.map((s) => [s.qualified, s.lineStart, s.lineEnd]), [
      ["F", 4, 9],
      ["G", 11, 11],
    ]);
  });
});
