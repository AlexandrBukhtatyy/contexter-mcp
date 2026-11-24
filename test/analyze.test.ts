import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeForIndex, analyzeQuery, splitIdentifier, stemWord } from "../src/search/analyze.ts";
import { countTokens } from "../src/util/tokens.ts";

const terms = (text: string) => new Set(analyzeForIndex(text).split(" "));
const matches = (query: string, text: string) => analyzeQuery(query).some((t) => terms(text).has(t));

describe("поиск по словам: морфология и идентификаторы", () => {
  it("русские формы слова сводятся к одной основе", () => {
    const forms = ["шлагбаум", "шлагбаума", "шлагбаумов", "шлагбаумами"];
    assert.equal(new Set(forms.map(stemWord)).size, 1);
    assert.ok(matches("шлагбаумов", "Открытие шлагбаума по звонку"));
    assert.ok(matches("сохраняется выбор слота", "Выбранный слот лежит в сторе"));
  });

  it("английские формы слова сводятся к одной основе", () => {
    assert.equal(stemWord("devices"), stemWord("device"));
    assert.ok(matches("devices", "The device receives a command"));
  });

  it("ё и е не различаются", () => {
    assert.equal(stemWord("ёлка"), stemWord("елка"));
  });

  it("идентификатор находится и целиком, и по частям", () => {
    assert.deepEqual(splitIdentifier("openForm"), ["open", "form"]);
    assert.deepEqual(splitIdentifier("parseGSMFrame"), ["parse", "gsm", "frame"]);
    assert.deepEqual(splitIdentifier("HTTPServer"), ["http", "server"]);
    assert.deepEqual(splitIdentifier("device-command"), ["device", "command"]);
    assert.ok(matches("open form", "Вызовите `openForm` из обработчика"));
    assert.ok(matches("gsm frame", "func parseGSMFrame(data []byte)"));
    assert.ok(matches("openForm", "Вызовите `openForm` из обработчика"));
    assert.ok(terms("resetSlot").has("resetslot"));
  });

  it("служебные слова не попадают в индекс", () => {
    assert.ok(!terms("и в на the of").has("и"));
    assert.equal(analyzeForIndex("и в на the of").trim(), "");
  });

  it("смешанный русско-английский текст", () => {
    assert.ok(matches("пропуск visit", "Пропуска учитываются по visits"));
  });
});

describe("приближённый счётчик токенов", () => {
  it("на русском тексте не занижает: не меньше символа на 3", () => {
    const text = "Выбранный слот лежит в сторе оформления и сбрасывается при возврате из корзины покупателя.";
    assert.ok(countTokens(text) >= Math.ceil(text.length / 3), `${countTokens(text)} < ${text.length / 3}`);
  });

  it("русский текст считается дороже английского той же длины", () => {
    const ru = "сервис принимает событие и решает допуск той же функцией";
    const en = "the service accepts the event and decides access with it";
    assert.ok(countTokens(ru) > countTokens(en));
  });

  it("длинные разделители таблиц не раздувают счёт", () => {
    assert.ok(countTokens("| --- | ------------------------------------------- |") < 20);
  });
});
