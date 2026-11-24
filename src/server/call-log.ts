import fs from "node:fs";
import path from "node:path";

/** Журнал вызовов сервера — для разбора пилота: что вызывал агент, сколько ждал, что получил. */
export const CALL_LOG_REL_PATH = ".mcp/cache/calls.jsonl";
/** Больше — файл переименовывается в calls.1.jsonl, и журнал начинается заново. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Ключи аргументов с текстом задачи или запроса: в журнал — только длина, если не разрешено иное. */
const TEXT_KEYS = new Set(["task", "query"]);

export interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface CallLogEntry {
  ts: string;
  /** Процесс сервера: вызовы одного запуска (одной сессии агента) — с одним pid. */
  pid: number;
  tool: string;
  ms: number;
  ok: boolean;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Журнал вызовов в JSONL: время, инструмент, длительность, краткие аргументы и ответ (размер пакета, режим
 * поиска, сколько чего вошло). Тексты задач и запросов — только если `taskText`, иначе их длина.
 */
export class CallLog {
  readonly file: string;
  private readonly taskText: boolean;

  constructor(file: string, opts: { taskText?: boolean } = {}) {
    this.file = file;
    this.taskText = opts.taskText ?? false;
  }

  record(tool: string, args: Record<string, unknown>, res: CallResult, ms: number): void {
    const text = res.content[0]?.text ?? "";
    const entry: CallLogEntry = { ts: new Date().toISOString(), pid: process.pid, tool, ms, ok: !res.isError, args: this.summarizeArgs(args) };
    if (res.isError) entry.error = text.replace(/^ошибка: /, "").slice(0, 300);
    else entry.result = summarizeResult(text);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file.replace(/\.jsonl$/, ".1.jsonl"));
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch (e) {
      // Журнал не должен ломать ответ агенту.
      process.stderr.write(`журнал вызовов не записан: ${(e as Error).message}\n`);
    }
  }

  private summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (v === undefined) continue;
      if (TEXT_KEYS.has(k) && typeof v === "string") {
        out[`${k}_chars`] = v.length;
        if (this.taskText) out[k] = v;
      } else if (Array.isArray(v)) out[k] = v.length <= 5 ? v : `[${v.length}]`;
      else if (typeof v === "string") out[k] = v.slice(0, 200);
      else out[k] = v;
    }
    return out;
  }
}

/** Ответ кратко: для пакета — размер, режим поиска и сколько чего вошло; для поиска — число результатов. */
function summarizeResult(text: string): Record<string, unknown> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { chars: text.length };
  }
  const len = (k: string) => (Array.isArray(data[k]) ? (data[k] as unknown[]).length : undefined);
  const meta = data.meta as Record<string, unknown> | undefined;
  if (meta && "used_tokens" in meta) {
    return {
      tokens: meta.used_tokens,
      budget: meta.budget_tokens,
      search: meta.search,
      docs: len("docs"),
      code: len("code"),
      rules: len("rules"),
      tests: len("tests"),
      omitted: len("omitted"),
      candidates: meta.candidates,
    };
  }
  if (Array.isArray(data.results)) return { results: len("results"), ...(data.search ? { search: data.search } : {}), chars: text.length };
  return { chars: text.length };
}

/** Сводка журнала для разбора пилота: по дням и инструментам. */
export function summarizeCallLog(entries: CallLogEntry[]): string {
  if (!entries.length) return "журнал пуст";
  const out: string[] = [];
  const days = [...new Set(entries.map((e) => e.ts.slice(0, 10)))].sort();
  out.push(`период: ${days[0]} — ${days[days.length - 1]}; вызовов: ${entries.length}; запусков сервера: ${new Set(entries.map((e) => `${e.ts.slice(0, 10)}:${e.pid}`)).size}`);
  out.push("", "| Инструмент | Вызовов | Ошибок | Время, медиана / макс., мс |", "| --- | --- | --- | --- |");
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)] ?? 0;
  };
  for (const tool of [...new Set(entries.map((e) => e.tool))].sort()) {
    const xs = entries.filter((e) => e.tool === tool);
    out.push(`| ${tool} | ${xs.length} | ${xs.filter((e) => !e.ok).length} | ${median(xs.map((e) => e.ms))} / ${Math.max(...xs.map((e) => e.ms))} |`);
  }
  const ctx = entries.filter((e) => e.tool === "get_task_context" && e.ok && e.result);
  if (ctx.length) {
    const avg = (k: string) => Math.round(ctx.reduce((a, e) => a + Number(e.result?.[k] ?? 0), 0) / ctx.length);
    const modes = new Map<string, number>();
    for (const e of ctx) {
      const m = String(e.result?.search ?? "").replace(/: .*$/, "");
      modes.set(m, (modes.get(m) ?? 0) + 1);
    }
    out.push(
      "",
      `get_task_context: в среднем ${avg("tokens")} токенов, документов ${avg("docs")}, мест кода ${avg("code")}, правил ${avg("rules")}, тестов ${avg("tests")}`,
      `режим поиска: ${[...modes].map(([m, n]) => `${m} — ${n}`).join("; ")}`,
    );
    const byTaskId = ctx.filter((e) => e.args.task_id).length;
    if (byTaskId) out.push(`по ID задачи из beads: ${byTaskId} из ${ctx.length}`);
  }
  // Начинал ли агент запуск сервера с get_task_context: первый вызов каждого запуска.
  const runs = new Map<string, CallLogEntry>();
  for (const e of [...entries].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const key = `${e.ts.slice(0, 10)}:${e.pid}`;
    if (!runs.has(key)) runs.set(key, e);
  }
  const first = [...runs.values()];
  out.push(`первый вызов запуска — get_task_context: ${first.filter((e) => e.tool === "get_task_context").length} из ${first.length}`);
  return out.join("\n");
}
