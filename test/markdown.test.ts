import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractMarkdown, MarkdownOptions } from "../src/extractors/markdown.ts";
import type { DocumentRecord } from "../src/extractors/types.ts";
import { normalizeText, sha256 } from "../src/util/text.ts";

const opts = MarkdownOptions.parse({ min_tokens: 30, target_tokens: 200, max_tokens: 300 });
function doc(text: string, options = opts, path = "docs/a.md"): DocumentRecord {
  const t = normalizeText(text);
  const r = extractMarkdown({ path, text: t, hash: sha256(t) }, options);
  assert.equal(r.kind, "document");
  return (r as { document: DocumentRecord }).document;
}
const para = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} номер ${i} описывает поведение сервиса доставки.`).join(" ");

const BASE = `---
type: guide
covers: [apps/api/**]
---

# Заголовок

## Первый раздел

${para("Первый", 8)}

## Второй раздел

${para("Второй", 8)}

### Вложенный

${para("Вложенный", 8)}
`;

describe("экстрактор markdown", () => {
  it("шапка, заголовок, путь заголовков и строки", () => {
    const d = doc(BASE);
    assert.equal(d.title, "Заголовок");
    assert.equal(d.type, "guide");
    assert.deepEqual(d.covers, ["apps/api/**"]);
    const nested = d.chunks.find((c) => c.headingPath.at(-1) === "Вложенный");
    assert.ok(nested);
    assert.deepEqual(nested.headingPath, ["Заголовок", "Второй раздел", "Вложенный"]);
    assert.equal(nested.id, "docs/a.md#заголовок/второй-раздел/вложенный");
    assert.ok(BASE.split("\n")[nested.lineStart - 1]?.startsWith("### Вложенный"));
  });

  it("правка одного раздела не меняет идентификаторы других", () => {
    const before = doc(BASE).chunks.map((c) => c.id);
    const edited = BASE.replace(para("Первый", 8), `${para("Первый", 8)}\n\nНовый абзац с дополнительным текстом про слоты и корзину.`);
    const afterChunks = doc(edited).chunks;
    assert.deepEqual(afterChunks.map((c) => c.id), before);
    const changed = afterChunks.filter((c, i) => c.hash !== doc(BASE).chunks[i]?.hash).map((c) => c.id);
    assert.deepEqual(changed, ["docs/a.md#заголовок/первый-раздел"]);
  });

  it("короткий раздел присоединяется к предыдущему, а заголовок без текста не становится фрагментом", () => {
    const d = doc(`# Т\n\n## Длинный\n\n${para("Длинный", 6)}\n\n## Короткий\n\nОдна строка.\n`);
    assert.equal(d.chunks.length, 1);
    assert.ok(d.chunks[0]?.text.includes("## Короткий"));
    assert.ok(!d.chunks.some((c) => c.headingPath.length === 1 && c.text.trim() === "# Т"));
  });

  it("блок кода остаётся с абзацем, который его поясняет", () => {
    const text = `# Т\n\n## Р\n\n${para("Вводный", 10)}\n\nПример вызова ниже:\n\n\`\`\`ts\nconst slot = resetSlot(id);\n\`\`\`\n\n${para("Хвост", 10)}\n`;
    const d = doc(text);
    assert.ok(d.chunks.length >= 2);
    const withCode = d.chunks.find((c) => c.text.includes("resetSlot"));
    assert.ok(withCode?.text.includes("Пример вызова ниже"));
  });

  it("большая таблица делится по строкам с повтором заголовка", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| строка ${i} | значение ячейки номер ${i} с пояснением |`).join("\n");
    const d = doc(`# Т\n\n## Таблица\n\n| Ключ | Значение |\n| --- | --- |\n${rows}\n`);
    assert.ok(d.chunks.length > 1);
    for (const c of d.chunks.slice(1)) assert.ok(c.text.startsWith("| Ключ | Значение |\n| --- | --- |"), c.text.slice(0, 60));
    assert.ok(d.chunks.every((c) => c.tokens <= opts.max_tokens + 60));
  });

  it("вступление из одного HTML-комментария пропускается", () => {
    const d = doc(`<!-- подсказка шаблона -->\n\n# ADR\n\n${para("Текст", 5)}\n`);
    assert.ok(!d.chunks.some((c) => c.id.endsWith("#_intro")));
  });

  it("ссылки, строки в обратных кавычках и идентификаторы из блоков кода", () => {
    const d = doc(`# Т\n\nСм. [сервис](../apps/x.ts) и \`SlotService.resetSlot\`.\n\n\`\`\`go\nh := dispatch.NewHandler(cfg)\n\`\`\`\n`);
    const refs = d.chunks.flatMap((c) => c.refs);
    assert.ok(refs.some((r) => r.kind === "link" && r.value === "../apps/x.ts"));
    assert.ok(refs.some((r) => r.kind === "code" && r.value === "SlotService.resetSlot"));
    assert.ok(refs.some((r) => r.kind === "ident" && r.value === "dispatch.NewHandler"));
  });

  it("CRLF и LF дают одинаковые фрагменты и хэши", () => {
    const lf = doc(BASE);
    const crlf = doc(BASE.replace(/\n/g, "\r\n"));
    assert.deepEqual(
      crlf.chunks.map((c) => [c.id, c.hash, c.lineStart, c.lineEnd, c.text]),
      lf.chunks.map((c) => [c.id, c.hash, c.lineStart, c.lineEnd, c.text]),
    );
  });
});
