import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_REPO = path.join(PROJECT_ROOT, "test", "fixtures", "repo");

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcp-context-${prefix}-`));
}

function git(cwd: string, args: string[], date?: string): void {
  const env = { ...process.env, GIT_AUTHOR_DATE: date ?? "2026-01-01T10:00:00Z", GIT_COMMITTER_DATE: date ?? "2026-01-01T10:00:00Z" };
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env,
    stdio: "pipe",
  });
}

/**
 * Копия учебного репозитория во временном каталоге с историей git: вложенный `.git`
 * в рабочем дереве contexter-mcp держать нельзя, поэтому история создаётся при каждом прогоне.
 *  - 2026-01-01: всё;
 *  - 2026-02-01 и 2026-03-01: handler.go и helper.go меняются вместе (совместные правки);
 *  - 2026-04-01: slot.service.ts меняется позже руководства о нём (раздел устарел).
 */
export function createFixtureRepo(opts: { crlf?: boolean; history?: boolean } = {}): string {
  const dir = tempDir("repo");
  fs.cpSync(FIXTURE_REPO, dir, { recursive: true });
  // Внешний пакет — как после установки зависимостей; node_modules в .gitignore учебного репозитория.
  fs.cpSync(path.join(PROJECT_ROOT, "test", "fixtures", "packages", "fx-kit"), path.join(dir, "apps", "admin", "node_modules", "@fx", "kit"), { recursive: true });
  if (opts.crlf) {
    for (const file of walk(dir)) {
      if (!/\.(md|ts|tsx|go|ya?ml|json)$/.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"));
    }
  }
  if (opts.history === false) return dir;
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"], "2026-01-01T10:00:00Z");
  const append = (rel: string, line: string) => fs.appendFileSync(path.join(dir, rel), line);
  append("apps/worker/internal/dispatch/handler.go", "\n// правка 1\n");
  append("apps/worker/internal/dispatch/helper.go", "\n// правка 1\n");
  git(dir, ["commit", "-q", "-am", "dispatch 1 (fx-2)"], "2026-02-01T10:00:00Z");
  append("apps/worker/internal/dispatch/handler.go", "// правка 2\n");
  append("apps/worker/internal/dispatch/helper.go", "// правка 2\n");
  git(dir, ["commit", "-q", "-am", "dispatch 2 (fx-2)"], "2026-03-01T10:00:00Z");
  append("apps/api/src/slots/slot.service.ts", "\n// правка сервиса после документации\n");
  git(dir, ["commit", "-q", "-am", "service: событие резервирования (fx-3)"], "2026-04-01T10:00:00Z");
  return dir;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
