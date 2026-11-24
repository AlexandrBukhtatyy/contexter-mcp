/**
 * Черновик эталонного набора из истории репозитория с задачами в beads.
 *
 *   node scripts/eval-draft-from-beads.ts <корень репозитория> [--count 30] [--out .mcp/eval/tasks.jsonl]
 *
 * Задача — закрытая задача beads (bug, task, feature) с описанием. Правильные файлы — код, изменённый
 * в коммитах, где в сообщении упомянут ID задачи. Нужные документы нигде не записаны, поэтому
 * предлагаются автоматически: документы, на которые ссылается текст задачи (ADR-NNNN, US-XNN, пути .md),
 * и документы, изменённые в тех же коммитах. Набор помечается как черновик: его должен проверить человек.
 * Персональные поля задач (владелец, исполнитель, авторы) в набор не попадают.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { count: { type: "string" }, out: { type: "string" }, "max-files": { type: "string" } },
});
const root = path.resolve(positionals[0] ?? process.cwd());
const count = Number(values.count ?? 30);
const maxFiles = Number(values["max-files"] ?? 40);
const outPath = path.resolve(root, values.out ?? ".mcp/eval/tasks.jsonl");

interface Issue {
  id: string;
  title: string;
  description?: string;
  status: string;
  issue_type: string;
  closed_at?: string;
  close_reason?: string;
}

const issues = fs
  .readFileSync(path.join(root, ".beads/issues.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Issue)
  .filter((i) => i.status === "closed" && ["bug", "task", "feature"].includes(i.issue_type) && (i.description ?? "").length > 80);

// Коммиты: ID задач в сообщении и изменённые файлы — одним проходом git log.
const log = execFileSync("git", ["-C", root, "-c", "core.quotepath=off", "log", "--no-merges", "--format=%x1e%H%x1f%s%n%b%x1f", "--name-only"], {
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 1024,
});
const filesByIssue = new Map<string, Set<string>>();
// ID задач в сообщениях коммитов — с префиксами ID из beads (`proj-104`, `proj-104.2`).
const prefixes = [...new Set(issues.map((i) => i.id.split("-")[0]).filter((p): p is string => !!p && /^[A-Za-z]\w*$/.test(p)))];
const ID_RE = new RegExp(`\\b(?:${prefixes.join("|") || "(?!)"})-[a-z0-9]+(?:\\.\\d+)?`, "g");
for (const block of log.split("\x1e")) {
  const [, message = "", names = ""] = block.split("\x1f");
  const files = names.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!files.length || files.length > 60) continue;
  for (const m of message.matchAll(ID_RE)) {
    const set = filesByIssue.get(m[0]) ?? new Set<string>();
    for (const f of files) set.add(f);
    filesByIssue.set(m[0], set);
  }
}

const allDocs = execFileSync("git", ["-C", root, "ls-files", "*.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
const CODE_RE = /\.(ts|tsx|js|jsx|go)$/;
const docRefs = (text: string): string[] => {
  const out = new Set<string>();
  for (const m of text.matchAll(/ADR-(\d{4})/g)) for (const d of allDocs) if (d.startsWith(`docs/adr/${m[1]}-`)) out.add(d);
  for (const m of text.matchAll(/\bUS-([A-Z]\d{2})\b/g)) for (const d of allDocs) if (d.startsWith(`docs/user-story/US-${m[1]}-`)) out.add(d);
  for (const m of text.matchAll(/[\w./-]+\.md\b/g)) for (const d of allDocs) if (d.endsWith(m[0])) out.add(d);
  return [...out];
};

const candidates = issues
  .map((i) => {
    const changed = [...(filesByIssue.get(i.id) ?? [])];
    const code = changed.filter((f) => CODE_RE.test(f) && !/(\.spec|\.test|_test|\.e2e-spec)\./.test(f) && !f.includes("/generated/"));
    const docs = new Set([...docRefs(`${i.title}\n${i.description ?? ""}`), ...changed.filter((f) => f.endsWith(".md") && !f.startsWith(".beads/"))]);
    return { issue: i, code, docs: [...docs] };
  })
  .filter((c) => c.code.length >= 1 && c.code.length <= maxFiles && c.docs.length >= 1);

// Разнообразие: поровну по типам, внутри типа — равномерно по времени закрытия.
const byType = new Map<string, typeof candidates>();
for (const c of candidates.sort((a, b) => String(a.issue.closed_at).localeCompare(String(b.issue.closed_at)))) {
  const list = byType.get(c.issue.issue_type) ?? [];
  list.push(c);
  byType.set(c.issue.issue_type, list);
}
const picked: typeof candidates = [];
const types = [...byType.keys()].sort();
const perType = Math.ceil(count / Math.max(types.length, 1));
for (const t of types) {
  const list = byType.get(t) ?? [];
  const step = Math.max(1, list.length / perType);
  for (let k = 0; k < perType && Math.floor(k * step) < list.length; k++) picked.push(list[Math.floor(k * step)] as (typeof candidates)[number]);
}
const final = picked.slice(0, count);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const lines = final.map((c) =>
  JSON.stringify({
    id: c.issue.id,
    type: c.issue.issue_type,
    task: `${c.issue.title}\n\n${(c.issue.description ?? "").slice(0, 1500)}`,
    files: c.code.sort(),
    docs: c.docs.sort(),
    draft: true,
    source: "beads + git log; docs предложены автоматически — проверить",
  }),
);
fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
process.stderr.write(`кандидатов: ${candidates.length}, в наборе: ${final.length} (${types.map((t) => `${t}: ${final.filter((c) => c.issue.issue_type === t).length}`).join(", ")}) → ${outPath}\n`);
