import picomatch from "picomatch";
import { isExternalPath } from "../indexer/files.ts";
import type { IndexReader, ProblemRow } from "../store/types.ts";
import { dirOf } from "../util/text.ts";

/**
 * Связи контракта с кодом и связи «документ → проверяющий тест» — не описание кода документацией:
 * тест, поменявшийся позже ADR, не делает ADR устаревшим.
 */
const CONTRACT_SOURCES = new Set(["operation-id", "client-fn", "client-call", "channel-key", "test-ref", "test-endpoint", "test-call"]);

export interface StaleEntry {
  chunkId: string;
  docPath: string;
  chunkChangedAt: number;
  targets: Array<{ kind: string; id: string; changedAt: number }>;
}

export interface UncoveredUnit {
  dir: string;
  kind: "package" | "directory" | "go-package";
  name: string;
  files: number;
}

export interface SuppressedRule {
  kind: string | null;
  path: string | null;
  value: string | null;
  reason: string;
  count: number;
}

export interface CheckReport {
  problems: Record<string, { count: number; items: ProblemRow[] }>;
  stale: StaleEntry[];
  uncovered: UncoveredUnit[];
  summary: Record<string, number>;
  /** Сколько проблем скрыто правилами `checks.ignore` и почему. */
  suppressed: SuppressedRule[];
}

export function suppressedRules(reader: IndexReader): SuppressedRule[] {
  try {
    return JSON.parse(reader.getState().problems_suppressed ?? "[]") as SuppressedRule[];
  } catch {
    return [];
  }
}

export const PROBLEM_TITLES: Record<string, string> = {
  "broken-link": "битые Markdown-ссылки на файлы",
  "broken-path": "пути в тексте, которых нет в репозитории",
  "broken-symbol": "ссылки на символы, которых нет в коде",
  "broken-id-ref": "идентификаторы документов, которые не нашлись",
  "broken-header-ref": "ссылки из шапок документов, которые не разрешились (documents.header_links)",
  "broken-endpoint": "эндпоинты из документации, которых нет в контракте",
  "broken-ref": "`$ref` контрактов в никуда",
  "operation-without-handler": "операции контракта без обработчика в коде",
  "operation-without-tests": "операции контракта, к которым не обращается ни один тест",
  "channel-without-code": "каналы, на которые не ссылается код",
  "channel-without-publisher": "каналы, которые читают, но в которые никто не публикует",
  "channel-without-subscriber": "каналы, в которые публикуют, но которые никто не читает",
  "unknown-channel": "код публикует или читает адрес, которого нет в контракте",
  "stale-section": "возможно устаревшие разделы",
  "uncovered-code": "непокрытый код (пакеты и каталоги без документации)",
};

export function computeCheck(reader: IndexReader, opts: { limit?: number; kind?: string } = {}): CheckReport {
  const limit = opts.limit ?? 30;
  const problems: CheckReport["problems"] = {};
  for (const p of reader.problems(opts.kind)) {
    const bucket = (problems[p.kind] ??= { count: 0, items: [] });
    bucket.count++;
    if (bucket.items.length < limit) bucket.items.push(p);
  }

  const docs = new Map(reader.listDocuments().map((d) => [d.path, d]));
  const chunks = reader.chunkDates();
  const files = reader.allFiles();
  const fileDates = new Map(files.map((f) => [f.path, f.changedAt]));
  const symbols = reader.allSymbols();
  const symbolInfo = new Map(symbols.map((s) => [s.id, s]));
  const links = reader.allLinks().filter((l) => !CONTRACT_SOURCES.has(l.source));

  // Возможно устарел: код, на который уверенно ссылается раздел, менялся позже раздела.
  const staleByChunk = new Map<string, StaleEntry>();
  for (const l of links) {
    if (l.confidence !== "high" || (l.targetKind !== "file" && l.targetKind !== "symbol")) continue;
    const c = chunks.get(l.chunkId);
    if (!c?.changedAt || docs.get(c.docPath)?.format !== "markdown") continue;
    const targetDate = l.targetKind === "file" ? fileDates.get(l.targetId) : symbolInfo.get(l.targetId)?.changedAt;
    if (!targetDate || targetDate <= c.changedAt) continue;
    const entry = staleByChunk.get(l.chunkId) ?? { chunkId: l.chunkId, docPath: c.docPath, chunkChangedAt: c.changedAt, targets: [] };
    if (!entry.targets.some((t) => t.id === l.targetId)) entry.targets.push({ kind: l.targetKind, id: l.targetId, changedAt: targetDate });
    staleByChunk.set(l.chunkId, entry);
  }
  const stale = [...staleByChunk.values()].sort((a, b) => gap(b) - gap(a) || a.chunkId.localeCompare(b.chunkId));

  // Непокрытый код: пакет или каталог, на который не ссылается ни один раздел документации.
  // Покрывают только ссылки внутрь каталога: ссылка на предка (`stacks/**`) не описывает каждый пакет под ним.
  const coveredFiles = new Set<string>();
  const coveredDirs: string[] = [];
  const globs: Array<{ base: string; match: (p: string) => boolean }> = [];
  for (const l of links) {
    const c = chunks.get(l.chunkId);
    if (!c || docs.get(c.docPath)?.format !== "markdown") continue;
    if (l.targetKind === "file") coveredFiles.add(l.targetId);
    else if (l.targetKind === "symbol") {
      const s = symbolInfo.get(l.targetId);
      if (s) coveredFiles.add(s.file);
    } else if (l.targetKind === "dir") coveredDirs.push(l.targetId);
    else if (l.targetKind === "glob") globs.push({ base: picomatch.scan(l.targetId).base, match: picomatch(l.targetId, { dot: true }) });
  }
  const codeFiles = files.filter((f) => !f.isTest && !f.generated && !isExternalPath(f.path));

  const units = new Map<string, UncoveredUnit>();
  for (const f of codeFiles) {
    if (f.lang === "go") {
      const d = dirOf(f.path);
      const u = units.get(d) ?? { dir: d, kind: "go-package" as const, name: f.unit ?? d, files: 0 };
      u.files++;
      units.set(d, u);
    } else if (f.packageDir !== null) {
      const pkg = units.get(f.packageDir) ?? { dir: f.packageDir, kind: "package" as const, name: f.package ?? f.packageDir, files: 0 };
      pkg.files++;
      units.set(f.packageDir, pkg);
      // Каталог первого уровня внутри src/ пакета: домены, модули, фичи.
      const rest = f.path.slice(f.packageDir ? f.packageDir.length + 1 : 0).split("/");
      if (rest[0] === "src" && rest.length > 2) {
        const d = [f.packageDir, "src", rest[1]].filter(Boolean).join("/");
        const u = units.get(d) ?? { dir: d, kind: "directory" as const, name: d, files: 0 };
        u.files++;
        units.set(d, u);
      }
    }
  }
  const inside = (p: string, dir: string) => dir === "" || p === dir || p.startsWith(`${dir}/`);
  const isCovered = (dir: string) => {
    if (coveredDirs.some((d) => inside(d, dir))) return true;
    if (globs.some((g) => inside(g.base, dir))) return true;
    for (const f of coveredFiles) if (inside(f, dir)) return true;
    return false;
  };
  const uncovered = [...units.values()].filter((u) => !isCovered(u.dir)).sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));

  const summary: Record<string, number> = {};
  for (const [k, v] of Object.entries(problems)) summary[k] = v.count;
  summary["stale-section"] = stale.length;
  summary["uncovered-code"] = uncovered.length;
  return { problems, stale: stale.slice(0, limit * 3), uncovered, summary, suppressed: suppressedRules(reader) };
}

function gap(e: StaleEntry): number {
  return Math.max(...e.targets.map((t) => t.changedAt)) - e.chunkChangedAt;
}
