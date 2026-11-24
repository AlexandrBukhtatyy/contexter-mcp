// Учебный экстрактор проекта: файл схемы БД — обычный код TS (встроенный экстрактор code) плюс сущности
// «таблица» из вызовов pgTable("имя", …). Так подключается свой экстрактор из .mcp/extractors/.
export default {
  name: "tables",
  version: 1,
  description: "схема БД: код TS и таблицы из pgTable",
  async extract(file, options, kit) {
    const res = await kit.run("code", file);
    if (res.kind !== "code") return res;
    const lines = file.text.split("\n");
    const entities = [];
    lines.forEach((text, i) => {
      for (const m of text.matchAll(new RegExp(`${options.call ?? "pgTable"}\\(\\s*"([a-z_][a-z0-9_]*)"`, "g"))) {
        const line = i + 1;
        const symbol = res.code.symbols.find((s) => s.lineStart <= line && line <= s.lineEnd);
        entities.push({ kind: "table", name: m[1], line, symbolId: symbol?.id ?? null });
      }
    });
    return { kind: "code", code: { ...res.code, entities } };
  },
};
