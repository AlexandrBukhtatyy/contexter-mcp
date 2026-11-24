import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { EvalTask } from "../src/eval/measure.ts";
import { HistoryCache, planSnapshot, runSnapshotEval } from "../src/eval/snapshots.ts";
import { createFixtureRepo, rmrf, tempDir } from "./helpers.ts";

const git = (cwd: string, args: string[], date = "2026-05-01T10:00:00Z") =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const CONTROLLER = "apps/api/src/slots/slots.controller.ts";
const RENAMED = "apps/api/src/slots/slot.controller.ts";
const CREATED = "apps/api/src/slots/slot-limit.ts";

let repo = "";
let work = "";
let solution = "";
let base = "";

before(() => {
  repo = createFixtureRepo();
  base = git(repo, ["rev-parse", "HEAD"]);
  // Коммит-решение задачи fx-9: правит контроллер и создаёт новый файл.
  fs.appendFileSync(path.join(repo, CONTROLLER), "\n// лимит слотов\n");
  fs.writeFileSync(path.join(repo, CREATED), "export const SLOT_LIMIT = 3;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "slots: лимит слотов (fx-9)"], "2026-05-01T10:00:00Z");
  solution = git(repo, ["rev-parse", "HEAD"]);
  // Позже контроллер переименован: в наборе он записан по текущему имени.
  git(repo, ["mv", CONTROLLER, RENAMED]);
  git(repo, ["commit", "-q", "-m", "slots: переименование контроллера"], "2026-06-01T10:00:00Z");
  work = path.join(tempDir("snapshot"), "copy");
});
after(() => {
  rmrf(repo);
  rmrf(path.dirname(work));
});

const TASK: EvalTask = {
  id: "fx-9",
  task: "GET /slots/{id} отвечает 404 для существующего слота; нужен лимит слотов",
  files: [RENAMED, CREATED],
  docs: ["contracts/openapi/api.yaml"],
};

describe("замер на коде до задачи", () => {
  it("снимок — родитель коммита-решения; пути того времени по истории переименований; созданное решением — отдельно", () => {
    const plan = planSnapshot(new HistoryCache(repo), { ...TASK, commits: [solution.slice(0, 8)] });
    assert.ok(base.startsWith(plan.base), `${plan.base} / ${base}`);
    assert.deepEqual(plan.files, [CONTROLLER]);
    assert.deepEqual(plan.newFiles, [CREATED]);
    assert.deepEqual(plan.docs, ["contracts/openapi/api.yaml"]);
    assert.deepEqual(plan.dropped, []);
  });

  it("явные пути до задачи (`before`) заменяют выведенные; неизвестный коммит — ошибка", () => {
    const plan = planSnapshot(new HistoryCache(repo), { ...TASK, commits: [solution], before: { files: ["apps/api/src/slots/slot.service.ts", "нет/такого.ts"] } });
    assert.deepEqual(plan.files, ["apps/api/src/slots/slot.service.ts"]);
    assert.deepEqual(plan.dropped, ["нет/такого.ts"]);
    assert.throws(() => planSnapshot(new HistoryCache(repo), { ...TASK, commits: ["deadbeef"] }), /не найден/);
  });

  it("меряет на копии в состоянии до задачи, задачи без коммитов пропускает, исходный репозиторий не трогает", async () => {
    const statusBefore = git(repo, ["status", "--porcelain"]);
    const run = await runSnapshotEval(repo, [{ ...TASK, commits: [solution] }, { id: "fx-x", task: "без коммитов", files: [] }], { k: 10, workDir: work });
    assert.deepEqual(run.skipped, ["fx-x"]);
    assert.deepEqual(run.errors, []);
    assert.equal(run.rows.length, 1);
    const row = run.rows[0];
    assert.equal(row?.expected_files, 1, "контроллер есть в индексе снимка под прежним именем");
    assert.deepEqual(row?.snapshot.new_files, [CREATED]);
    assert.ok(row && row.tokens <= row.budget);
    assert.equal(git(work, ["rev-parse", "HEAD"]), base);
    assert.ok(!fs.existsSync(path.join(work, CREATED)), "в снимке нет файла, созданного решением");
    assert.equal(git(repo, ["status", "--porcelain"]), statusBefore);
    assert.equal(git(repo, ["rev-parse", "HEAD"]).length, 40);
  });
});
