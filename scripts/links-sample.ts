/**
 * Выборка связей документации с кодом для ручной проверки (критерий этапа 2: доля неверных среди
 * связей с высоким доверием — не выше 5%).
 *
 *   node scripts/links-sample.ts <корень репозитория> [--count 50] [--out .mcp/review/links-sample.md]
 *
 * Берутся связи из Markdown-документов, пропорционально источникам, с обязательной долей связей с Go;
 * порядок детерминирован (по хэшу), чтобы повторный запуск давал ту же выборку.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { LINK_REASON } from "../src/search/queries.ts";
import { openSqliteStore } from "../src/store/sqlite/store.ts";
import type { LinkRow } from "../src/store/types.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { count: { type: "string" }, out: { type: "string" } } });
const root = path.resolve(positionals[0] ?? process.cwd());
const count = Number(values.count ?? 50);
const outPath = path.resolve(root, values.out ?? ".mcp/review/links-sample.md");

const store = await openSqliteStore(path.join(root, ".mcp/cache/index.sqlite"), { readonly: true, vectors: false });
const docs = new Map(store.listDocuments().map((d) => [d.path, d]));
const symbols = new Map(store.allSymbols().map((s) => [s.id, s]));
const files = new Map(store.allFiles().map((f) => [f.path, f]));
const chunkDates = store.chunkDates();

const isGo = (l: LinkRow) =>
  (l.targetKind === "symbol" && files.get(symbols.get(l.targetId)?.file ?? "")?.lang === "go") || (l.targetKind === "file" && files.get(l.targetId)?.lang === "go");
const eligible = store.allLinks().filter((l) => {
  const c = chunkDates.get(l.chunkId);
  return c && docs.get(c.docPath)?.format === "markdown" && l.confidence === "high" && ["symbol", "file", "dir", "glob", "chunk"].includes(l.targetKind);
});
const key = (l: LinkRow) => createHash("sha1").update(`${l.chunkId}|${l.targetKind}|${l.targetId}|${l.source}`).digest("hex");
const bySource = new Map<string, LinkRow[]>();
for (const l of eligible.sort((a, b) => key(a).localeCompare(key(b)))) {
  const list = bySource.get(l.source) ?? [];
  list.push(l);
  bySource.set(l.source, list);
}
const goShare = Math.max(5, Math.round(count * 0.15));
const picked: LinkRow[] = eligible.filter(isGo).sort((a, b) => key(a).localeCompare(key(b))).slice(0, goShare);
const rest = count - picked.length;
for (const [, list] of [...bySource.entries()].sort()) {
  const n = Math.max(1, Math.round((list.length / eligible.length) * rest));
  for (const l of list) {
    if (picked.length >= count || n <= picked.filter((p) => p.source === l.source && !isGo(p)).length) break;
    if (!picked.includes(l)) picked.push(l);
  }
}

const target = (l: LinkRow) => {
  if (l.targetKind === "symbol") {
    const s = symbols.get(l.targetId);
    return s ? `${s.qualified} — \`${s.file}:${s.lineStart}\`` : l.targetId;
  }
  if (l.targetKind === "chunk") return `фрагмент \`${l.targetId}\``;
  return `${l.targetKind} \`${l.targetId}\``;
};
const lines = [
  "# Выборка связей для ручной проверки",
  "",
  `Связей с высоким доверием из Markdown: ${eligible.length}. В выборке: ${picked.length}, из них с Go-кодом: ${picked.filter(isGo).length}.`,
  "Отметьте в последней колонке: ✓ — связь верна, ✗ — неверна. Цель этапа 2: неверных не больше 5%.",
  "",
  "| # | Раздел документации | Строка | Источник связи | Куда указывает | Верна? |",
  "| - | ------------------- | ------ | -------------- | -------------- | ------ |",
  ...picked.map((l, i) => {
    const c = chunkDates.get(l.chunkId);
    return `| ${i + 1} | \`${l.chunkId}\` | ${c?.docPath}:${l.line ?? "—"} | ${LINK_REASON[l.source] ?? l.source} | ${target(l)} |  |`;
  }),
  "",
];
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join("\n"));
store.close();
process.stderr.write(`выборка: ${picked.length} связей → ${outPath}\n`);
