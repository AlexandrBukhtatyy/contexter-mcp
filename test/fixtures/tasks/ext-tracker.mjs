// Учебный адаптер задач для тестов: «внешний трекер» с ID вида EXT-n.
// Тест копирует его в .mcp/tasks/ временного репозитория и подключает через tasks.sources.
export default {
  name: "ext",
  load(ctx) {
    ctx.log(`ext: коммитов в истории ${ctx.commits.length}`);
    return [
      { id: "EXT-1", title: "Повтор отправки кадра модулю", description: `из внешнего трекера (${ctx.options.marker})`, status: "closed", type: "task" },
      { id: "EXT-2", title: "Задача без коммитов", created_at: "2026-01-10T00:00:00Z" },
      { title: "запись без id пропускается" },
    ];
  },
};
