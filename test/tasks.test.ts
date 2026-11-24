import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { getTaskContext } from "../src/context/build.ts";
import { ConfigError, LOCAL_CONFIG_REL_PATH, parseConfigText } from "../src/config/load.ts";
import { solutionGuard } from "../src/eval/measure.ts";
import { builtinExtractors } from "../src/extractors/registry.ts";
import { runIndex } from "../src/indexer/index.ts";
import { globalStatus } from "../src/search/queries.ts";
import { openSqliteStore, type SqliteStore } from "../src/store/sqlite/store.ts";
import { changeId, detectIdPattern, loadTaskSources } from "../src/tasks/load.ts";
import type { CommitRecord } from "../src/tasks/types.ts";
import { PROJECT_ROOT, createFixtureRepo, rmrf } from "./helpers.ts";

/**
 * Источники задач на учебном репозитории. История (helpers.ts): init; dispatch 1 и 2 (fx-2);
 * service: событие резервирования (fx-3); здесь добавляется коммит с EXT-1 для своего адаптера.
 * Индексы с разными источниками строятся из одного репозитория в разные файлы — меняется только личный конфиг.
 */
let repo = "";
const stores: SqliteStore[] = [];

const gitOut = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

async function indexWith(name: string, localConfig: string): Promise<SqliteStore> {
  fs.writeFileSync(path.join(repo, LOCAL_CONFIG_REL_PATH), localConfig);
  const dbPath = path.join(repo, ".mcp", "cache", `${name}.sqlite`);
  await runIndex({ root: repo, dbPath, embeddings: false });
  const store = await openSqliteStore(dbPath, { readonly: true, vectors: false });
  stores.push(store);
  return store;
}

const similar = (p: ReturnType<typeof getTaskContext>) => (p.meta.anchors as { similar_tasks?: string[] }).similar_tasks ?? [];
const RESERVE_TASK = "Резервирование слота должно публиковать событие для воркера";

let byDefault: SqliteStore;
let gitOnly: SqliteStore;
let changesOnly: SqliteStore;
let withAdapter: SqliteStore;
let tasksOn: SqliteStore;

before(async () => {
  repo = createFixtureRepo();
  fs.appendFileSync(path.join(repo, "apps/worker/internal/dispatch/helper.go"), "// правка 3\n");
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-05-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-05-01T10:00:00Z" };
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "dispatch: лимит повторов EXT-1"],
    { env, stdio: "pipe" },
  );
  fs.mkdirSync(path.join(repo, ".mcp", "tasks"), { recursive: true });
  fs.copyFileSync(path.join(PROJECT_ROOT, "test", "fixtures", "tasks", "ext-tracker.mjs"), path.join(repo, ".mcp", "tasks", "ext-tracker.mjs"));
  fs.writeFileSync(
    path.join(repo, ".mcp", "tasks", "down.mjs"),
    'export default { name: "down", async load() { throw new Error("трекер недоступен"); } };\n',
  );

  byDefault = await indexWith("default", "");
  gitOnly = await indexWith("git", "tasks:\n  sources: [git]\n  id_pattern: '\\bfx-\\d+\\b'\n");
  changesOnly = await indexWith("changes", "tasks:\n  sources: [git]\n");
  tasksOn = await indexWith("tasks-on", "tasks:\n  sources: [git]\ncontext:\n  tasks: { history: true, similar: true }\n");
  withAdapter = await indexWith("adapter", "tasks:\n  sources:\n    - use: .mcp/tasks/ext-tracker.mjs\n      options: { marker: m1 }\n    - git\n");
});
after(() => {
  for (const s of stores) s.close();
  rmrf(repo);
});

describe("источники задач", () => {
  it("по умолчанию — beads и git: текст из beads, файлы из коммитов, коммит без номера — «изменение»", () => {
    const fx2 = byDefault.getTask("fx-2");
    assert.equal(fx2?.source, "beads");
    assert.equal(fx2?.title, "Повтор отправки кадра GSM при сбое");
    assert.equal(fx2?.created_at, "2026-01-20T10:00:00Z", "дата трекера не заменяется датой коммита");
    const files = byDefault.taskFiles(["fx-2"]).map((f) => `${f.file}:${f.commits}`);
    assert.deepEqual(files, ["apps/worker/internal/dispatch/handler.go:2", "apps/worker/internal/dispatch/helper.go:2"]);
    const init = byDefault.getTask(changeId(gitOut("rev-list", "--max-parents=0", "HEAD")));
    assert.equal(init?.source, "commit");
    assert.equal(init?.title, "init");
    const status = globalStatus(byDefault).tasks;
    assert.deepEqual(status.sources, { beads: 3, git: 0 });
    assert.equal(status.changes, 2, "init и коммит с EXT-1 — номера beads в них нет");
    assert.equal(status.id_pattern_from, "tracker");
  });

  it("только git: задачи из номеров в коммитах — заголовок первого коммита, дата, файлы", () => {
    const fx2 = gitOnly.getTask("fx-2");
    assert.equal(fx2?.source, "git");
    assert.equal(fx2?.title, "dispatch 1 (fx-2)");
    assert.equal(fx2?.created_at, "2026-02-01T10:00:00.000Z");
    assert.match(fx2?.description ?? "", /dispatch 2 \(fx-2\)/);
    assert.deepEqual(
      gitOnly.taskFiles(["fx-2"]).map((f) => f.file),
      ["apps/worker/internal/dispatch/handler.go", "apps/worker/internal/dispatch/helper.go"],
    );
    assert.equal(gitOnly.getTask("fx-1"), null, "задачи без коммитов из git не берутся");
    const p = getTaskContext(gitOnly, { task_id: "fx-2", task_history: true });
    assert.ok(p.code.some((c) => String(c.why).includes("правился по задаче fx-2")), JSON.stringify(p.code));
    assert.deepEqual(globalStatus(gitOnly).tasks.sources, { git: 2 });
    assert.equal(globalStatus(gitOnly).tasks.id_pattern_from, "config");
  });

  it("без номеров задач каждый коммит — «изменение»; похожие правки находятся с причиной «в похожем коммите»", () => {
    const status = globalStatus(changesOnly).tasks;
    assert.equal(status.id_pattern, null, "строчные fx-2 за номер задачи не принимаются");
    assert.equal(status.changes, 5);
    const fx3 = gitOut("log", "-1", "--format=%H", "--grep", "fx-3");
    const p = getTaskContext(changesOnly, { task: RESERVE_TASK, similar_tasks: true });
    assert.ok(similar(p).includes(changeId(fx3)), JSON.stringify(p.meta.anchors));
    const service = p.code.find((c) => String(c.at).startsWith("apps/api/src/slots/slot.service.ts"));
    assert.match(String(service?.why), new RegExp(`в похожем коммите ${fx3.slice(0, 10)} «service: событие резервирования`));
  });

  it("честный замер на текущем коде: «изменение» коммита-решения и всё после него в похожие не попадает", () => {
    const fx3 = gitOut("log", "-1", "--format=%H", "--grep", "fx-3");
    const guard = solutionGuard(repo, [fx3.slice(0, 8), "deadbeef"]);
    assert.deepEqual(guard, { exclude: [changeId(fx3)], before: "2026-04-01T10:00:00.000Z" });
    const p = getTaskContext(changesOnly, { task: RESERVE_TASK, similar_tasks: true }, { useTaskHistory: false, excludeTaskIds: guard.exclude, tasksBefore: guard.before });
    assert.ok(!similar(p).includes(changeId(fx3)), JSON.stringify(p.meta.anchors));
    assert.deepEqual(solutionGuard(repo, undefined), { exclude: [], before: null });
  });

  it("свой адаптер: задачи из модуля с options, номер задачи по их ID находится в коммитах", () => {
    const ext1 = withAdapter.getTask("EXT-1");
    assert.equal(ext1?.source, "ext");
    assert.equal(ext1?.description, "из внешнего трекера (m1)");
    assert.equal(ext1?.created_at, "2026-05-01T10:00:00.000Z", "дата из первого коммита, если трекер её не дал");
    assert.deepEqual(withAdapter.taskFiles(["EXT-1"]).map((f) => f.file), ["apps/worker/internal/dispatch/helper.go"]);
    assert.equal(withAdapter.getTask("EXT-2")?.created_at, "2026-01-10T00:00:00Z");
    const status = globalStatus(withAdapter).tasks;
    assert.deepEqual(status.sources, { ext: 2, git: 0 });
    assert.equal(status.id_pattern_from, "tracker");
  });

  it("свой адаптер упал — индекс собирается без его задач, ошибка видна в status", async () => {
    const logs: string[] = [];
    fs.writeFileSync(path.join(repo, LOCAL_CONFIG_REL_PATH), "tasks:\n  sources: [.mcp/tasks/down.mjs, beads, git]\n");
    const dbPath = path.join(repo, ".mcp", "cache", "down.sqlite");
    await runIndex({ root: repo, dbPath, embeddings: false, log: (m) => logs.push(m) });
    const store = await openSqliteStore(dbPath, { readonly: true, vectors: false });
    stores.push(store);
    const status = globalStatus(store).tasks;
    assert.deepEqual(status.sources, { down: 0, beads: 3, git: 0 });
    assert.deepEqual(status.errors, { down: "трекер недоступен" });
    assert.ok(logs.some((m) => m.includes("источник задач down: ошибка — трекер недоступен")), logs.join("\n"));
    assert.equal(store.getTask("fx-2")?.source, "beads");
  });
});

describe("задачи в пакете: конфиг и параметры запроса", () => {
  it("context.tasks в конфиге включает историю и похожие без параметров; параметр запроса главнее конфига", () => {
    const fx3 = changeId(gitOut("log", "-1", "--format=%H", "--grep", "fx-3"));
    const on = getTaskContext(tasksOn, { task: RESERVE_TASK });
    assert.ok(similar(on).includes(fx3), JSON.stringify(on.meta.anchors));
    const fx2 = changeId(gitOut("log", "-1", "--format=%H", "--grep", "dispatch 1"));
    const history = getTaskContext(tasksOn, { task_id: fx2 });
    assert.ok(history.code.some((c) => String(c.why).includes(`правился по задаче ${fx2}`)), JSON.stringify(history.code));
    const off = getTaskContext(tasksOn, { task: RESERVE_TASK, similar_tasks: false, task_history: false });
    assert.deepEqual(similar(off), []);
    assert.deepEqual(similar(getTaskContext(changesOnly, { task: RESERVE_TASK })), [], "без конфига и параметра — выключено");
  });
});

describe("номер задачи и конфиг источников", () => {
  const commit = (message: string, i: number): CommitRecord => ({ hash: String(i).padStart(40, "0"), time: i, message, files: [] });

  it("шаблон по коммитам: префикс задач — да, ID документов, UTF-8, номера с нулём и редкие префиксы — нет", () => {
    const msgs = [
      ...Array.from({ length: 4 }, (_, i) => `PROJ-${i + 1}: правка`),
      ...Array.from({ length: 5 }, () => "по ADR-0001, кодировка UTF-8"),
      ...Array.from({ length: 6 }, (_, i) => `критерий приёмки US-06 AT-0${i + 1}`),
      "разовое упоминание OTHER-5",
      ...Array.from({ length: 30 }, (_, i) => `правка ${i}`),
    ];
    assert.equal(detectIdPattern(msgs.map(commit), new Set(["ADR"])), "\\b(?:PROJ)-\\d+\\b");
    const gitlab = Array.from({ length: 10 }, (_, i) => `fix: кнопка (#${i + 10})`).map(commit);
    assert.equal(detectIdPattern(gitlab, new Set()), "(?<![\\w&/#])#\\d+\\b");
    assert.equal(detectIdPattern(["init", "правка"].map(commit), new Set()), null);
  });

  it("файл задач в нейтральном формате (jsonl): задачи с полями, битые строки и записи без id пропускаются", async () => {
    const dir = path.join(repo, ".mcp", "tasks");
    fs.writeFileSync(
      path.join(dir, "export.jsonl"),
      [
        JSON.stringify({ id: "PROJ-7", title: "Слот сбрасывается", description: "после корзины", status: "closed", type: "bug", parent: "PROJ-1", created_at: "2026-02-02T00:00:00Z", assignee: "кто-то" }),
        "{битая строка",
        JSON.stringify({ title: "без id" }),
        "",
      ].join("\n"),
    );
    const { config } = parseConfigText("tasks:\n  sources: [{ use: jsonl, options: { path: .mcp/tasks/export.jsonl } }]\n", ".mcp/context.yaml", builtinExtractors());
    const loaded = await loadTaskSources(repo, config, [], new Set());
    assert.deepEqual(loaded.tasks, [
      { id: "PROJ-7", type: "bug", status: "closed", title: "Слот сбрасывается", description: "после корзины", parent: "PROJ-1", created_at: "2026-02-02T00:00:00Z", source: "jsonl" },
    ]);
    assert.equal(loaded.idPatternFrom, "tracker");
    const missing = parseConfigText("tasks:\n  sources: [{ use: jsonl, options: { path: нет.jsonl } }]\n", ".mcp/context.yaml", builtinExtractors());
    await assert.rejects(loadTaskSources(repo, missing.config, [], new Set()), /файла нет — нет\.jsonl/);
  });

  it("модуль источника вне репозитория и неизвестный источник — ошибка конфига", () => {
    const problems = (yaml: string) => {
      try {
        parseConfigText(yaml, ".mcp/context.yaml", builtinExtractors());
      } catch (e) {
        assert.ok(e instanceof ConfigError, String(e));
        return e.problems.map((p) => `${p.path}: ${p.message}`).join("\n");
      }
      return "";
    };
    assert.match(problems("tasks:\n  sources:\n    - use: ../shared/jira.mjs\n"), /tasks\.sources\.0\.use: модуль источника задач должен лежать внутри репозитория/);
    assert.match(problems("tasks:\n  sources: ['C:/tools/jira.mjs']\n"), /внутри репозитория/);
    assert.match(problems("tasks:\n  sources: [jira]\n"), /неизвестный источник задач «jira»/);
    assert.match(problems("tasks:\n  sources: [jsonl]\n"), /нужен options\.path/);
    assert.equal(problems("tasks:\n  sources: [git, { use: .mcp/tasks/jira.mjs, options: { project: SEC } }]\n"), "");
  });
});
