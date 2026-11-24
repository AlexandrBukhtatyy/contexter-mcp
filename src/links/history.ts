import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config/schema.ts";
import { isExternalPath, isGitRepo } from "../indexer/files.ts";
import type { CochangeRow, IndexWriter } from "../store/types.ts";
import type { CommitRecord } from "../tasks/types.ts";

const execFileAsync = promisify(execFile);

export interface HistoryStats {
  commits: number;
  cochangePairs: number;
  blamed: number;
  ms: number;
}

/**
 * Коммиты истории, новые первыми: хэш, время, сообщение, файлы. Один проход `git log` — для совместных
 * правок, дат файлов и задач (номера задач в сообщениях, «изменения» без номера). Пусто, если история
 * выключена в конфиге или это не git.
 */
export function readCommits(root: string, config: Config): CommitRecord[] {
  if (!config.history.enabled || !isGitRepo(root)) return [];
  let log: string;
  try {
    // Запись коммита: \x1e хэш \x1f время \x1f сообщение \x1f, затем список файлов.
    log = execFileSync("git", ["-C", root, "-c", "core.quotepath=off", "log", "--no-merges", "--no-renames", "--format=%x1e%H%x1f%ct%x1f%B%x1f", "--name-only"], {
      maxBuffer: 1024 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  const out: CommitRecord[] = [];
  for (const record of log.split("\x1e")) {
    const [hash, ct, message = "", names = ""] = record.split("\x1f");
    const files = names.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!hash || !ct || !files.length) continue;
    out.push({ hash: hash.trim(), time: Number(ct) * 1000, message: message.trim(), files });
  }
  return out;
}

/**
 * История git: дата последнего изменения файла, файлы, которые меняются вместе (без крупных коммитов),
 * и даты строк через `git blame` — только для файлов, которые изменились с прошлой индексации.
 */
export async function runHistory(store: IndexWriter, root: string, config: Config, indexed: ReadonlySet<string>, commitList: CommitRecord[]): Promise<HistoryStats> {
  const t0 = Date.now();
  if (!commitList.length) return { commits: 0, cochangePairs: 0, blamed: 0, ms: 0 };
  const fileDates = new Map<string, number>();
  const pairs = new Map<string, number>();
  let commits = 0;
  for (const c of commitList) {
    const filesInCommit = c.files;
    commits++;
    for (const f of filesInCommit) if (!fileDates.has(f)) fileDates.set(f, c.time);
    const relevant = filesInCommit.filter((f) => indexed.has(f)).sort();
    if (filesInCommit.length > config.history.max_commit_files || relevant.length < 2) continue;
    for (let i = 0; i < relevant.length; i++) {
      for (let j = i + 1; j < relevant.length; j++) {
        const k = `${relevant[i]}\u0000${relevant[j]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
  }

  const rows: CochangeRow[] = [];
  for (const [k, w] of pairs) {
    if (w < config.history.min_cochange) continue;
    const [a, b] = k.split("\u0000");
    if (a && b) rows.push({ fileA: a, fileB: b, weight: w });
  }
  store.transaction(() => {
    store.replaceCochange(rows);
    store.setFileDates(fileDates);
  });

  let blamed = 0;
  if (config.history.blame) {
    // Файлы внешних пакетов вне git: blame для них бессмыслен и медленен.
    const todo = store.filesNeedingBlame().filter((p) => !isExternalPath(p));
    const sources = new Map(todo.map((p) => [p, store.getSource(p)?.hash ?? ""]));
    const results: Array<{ path: string; dates: number[] }> = [];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const p = todo[next++] as string;
        results.push({ path: p, dates: await blameFile(root, p) });
      }
    };
    await Promise.all(Array.from({ length: config.history.blame_concurrency }, worker));
    store.transaction(() => {
      for (const r of results) {
        store.applyLineDates(r.path, r.dates);
        store.markBlamed(r.path, sources.get(r.path) ?? "");
        blamed++;
      }
    });
  }
  return { commits, cochangePairs: rows.length, blamed, ms: Date.now() - t0 };
}

/** Время последнего изменения каждой строки (мс). Незакоммиченные строки — текущее время, файл вне git — его mtime. */
export async function blameFile(root: string, rel: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "blame", "--porcelain", "--", rel], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
    const commitTime = new Map<string, number>();
    const dates: number[] = [];
    let currentSha = "";
    let currentLine = 0;
    for (const line of stdout.split("\n")) {
      const header = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (header) {
        currentSha = header[1] ?? "";
        currentLine = Number(header[2]);
        continue;
      }
      if (line.startsWith("committer-time ")) {
        commitTime.set(currentSha, Number(line.slice(15)) * 1000);
        continue;
      }
      if (line.startsWith("\t")) {
        dates[currentLine - 1] = /^0{40}$/.test(currentSha) ? Date.now() : (commitTime.get(currentSha) ?? 0);
      }
    }
    return dates;
  } catch {
    try {
      const mtime = fs.statSync(path.join(root, rel)).mtimeMs;
      const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n").length;
      return new Array<number>(lines).fill(Math.round(mtime));
    } catch {
      return [];
    }
  }
}

export function gitHead(root: string): { commit: string | null; branch: string | null; dirty: boolean | null } {
  if (!isGitRepo(root)) return { commit: null, branch: null, dirty: null };
  const run = (args: string[]) => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const status = run(["status", "--porcelain", "--untracked-files=no"]);
  return { commit: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: status === null ? null : status.length > 0 };
}
