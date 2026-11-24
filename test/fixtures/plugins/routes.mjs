// Учебный экстрактор проекта: JSON-манифест маршрутов → документ «экраны», раздел на маршрут.
// Раздел объявляет сущность «экран» с именем пути и ссылается на компонент страницы (ident → символ).
export default {
  name: "routes",
  version: 1,
  description: "манифест маршрутов: экраны, вкладки, компоненты",
  extract(file, options, kit) {
    const routes = JSON.parse(file.text);
    const ids = kit.ids();
    const lines = file.text.split("\n");
    const lineOf = (needle) => Math.max(1, lines.findIndex((l) => l.includes(needle)) + 1);
    const chunks = routes.map((r, ordinal) => {
      const line = lineOf(`"${r.path}"`);
      const tabs = (r.tabs ?? []).map((t) => t.label);
      const text = [`Экран «${r.title}» — \`${r.path}\``, tabs.length ? `Вкладки: ${tabs.join(", ")}` : "", `Компонент \`${r.component}\``].filter(Boolean).join("\n");
      return kit.chunk({
        id: `${file.path}#${ids.take(kit.slugify(r.path) || "root")}`,
        headingPath: [options.title ?? "Экраны", r.title],
        ordinal,
        kind: "screen",
        text,
        // Дополнительные слова для поиска: значения вкладок (ищутся вместе с text).
        searchText: (r.tabs ?? []).map((t) => t.value).join(" "),
        lineStart: line,
        lineEnd: line,
        refs: [{ kind: "ident", value: r.component, line }],
        entities: [{ kind: "screen", name: r.path, line }],
      });
    });
    return {
      kind: "document",
      document: { title: options.title ?? "Экраны", type: "screen", status: null, owner: null, covers: [], frontmatter: null, format: "routes", chunks },
    };
  },
};
