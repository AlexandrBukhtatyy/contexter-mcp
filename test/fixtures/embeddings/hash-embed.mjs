// Учебный скрипт эмбеддингов для provider: command — протокол построчного JSON через stdin/stdout.
// Запрос: {"id": 1, "kind": "query"|"document", "texts": ["…"]}. Ответ: {"id": 1, "vectors": [[…]]} или {"id": 1, "error": "…"}.
// Вектор — «мешок слов» (первые 5 букв слова в измерение по хэшу), как у заглушки stub.
// Текст «сломай» в запросе — ответ с ошибкой (проверка обработки ошибок).
import { createInterface } from "node:readline";

const DIMS = 64;
function vector(text) {
  const v = new Array(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\d]+/gu) ?? []) {
    const stem = w.slice(0, 5);
    let h = 2166136261;
    for (let i = 0; i < stem.length; i++) h = Math.imul(h ^ stem.charCodeAt(i), 16777619);
    v[(h >>> 0) % DIMS] += 1;
  }
  return v;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.texts.some((t) => t.includes("сломай"))) {
    process.stdout.write(`${JSON.stringify({ id: req.id, error: "не умею" })}\n`);
    return;
  }
  process.stderr.write(`hash-embed: ${req.kind}, ${req.texts.length}\n`);
  process.stdout.write(`${JSON.stringify({ id: req.id, vectors: req.texts.map(vector) })}\n`);
});
