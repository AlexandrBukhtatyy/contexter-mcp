import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../config/load.ts";
import { createKit, loadRegistry } from "../extractors/registry.ts";
import { defaultDbPath, runIndex } from "../indexer/index.ts";
import { selectExtractor } from "../indexer/select.ts";
import { normalizeText, sha256, toPosix, truncate } from "../util/text.ts";

const HELP = `mcp-context — MCP-сервер контекста задачи

Команды:
  index         [--root DIR] [--full] [--no-embeddings]   собрать или обновить индекс; векторы для поиска по смыслу — если настроен embeddings
  explain-file  <путь> [--root DIR]            какой экстрактор выбран, каким правилом и что он извлёк
  status        [--root DIR] [--json]          состояние индекса (то же, что инструмент index_status)
  check         [--root DIR] [--json] [--kind KIND]  битые ссылки, устаревшие разделы, непокрытый код, расхождения с контрактами
  context       "<текст задачи>" [--task-id ID] [--open a.ts,b.ts] [--budget 6000] [--task-history] [--similar-tasks] [--as-of-task ID]   пакет контекста (то же, что get_task_context);
                --as-of-task — как в eval: без истории этой задачи и её семейства и без задач, заведённых позже неё
  eval          [--root DIR] [--set FILE] [--ids a,b] [--k 10] [--budget N] [--json] [--snapshots [--work DIR]]   замер на эталонном наборе;
                --snapshots — на коде до задачи: каждая задача на родителе своего коммита-решения (commits в наборе);
                --explain — для каждого не вошедшего файла и документа: место среди кандидатов, списки, место в поиске;
                --no-vectors — без поиска по смыслу, даже если он настроен (для сравнения)
  serve         [--root DIR]                   MCP-сервер по stdio
  calls         [--root DIR] [--json]          сводка журнала вызовов сервера (.mcp/cache/calls.jsonl; включается log.calls в конфиге)

Общие параметры:
  --root DIR    корень индексируемого репозитория (по умолчанию текущий каталог)
  --db FILE     путь к индексу (по умолчанию <root>/.mcp/cache/index.sqlite)
`;

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      db: { type: "string" },
      full: { type: "boolean" },
      "no-embeddings": { type: "boolean" },
      "no-vectors": { type: "boolean" },
      json: { type: "boolean" },
      kind: { type: "string" },
      set: { type: "string" },
      k: { type: "string" },
      limit: { type: "string" },
      "task-id": { type: "string" },
      open: { type: "string" },
      budget: { type: "string" },
      "task-history": { type: "boolean" },
      "similar-tasks": { type: "boolean" },
      "as-of-task": { type: "string" },
      ids: { type: "string" },
      snapshots: { type: "boolean" },
      explain: { type: "boolean" },
      work: { type: "string" },
      debug: { type: "boolean" },
      shares: { type: "string" },
    },
  });
  const root = path.resolve(values.root ?? process.cwd());
  const dbPath = values.db ? path.resolve(values.db) : defaultDbPath(root);
  try {
    switch (command) {
      case "index":
        return await cmdIndex(root, dbPath, values.full ?? false, !(values["no-embeddings"] ?? false));
      case "explain-file":
        return await cmdExplain(root, positionals[0]);
      case "status": {
        const { cmdStatus } = await import("./query-commands.ts");
        return await cmdStatus(dbPath, values.json ?? false);
      }
      case "check": {
        const { cmdCheck } = await import("./query-commands.ts");
        return await cmdCheck(dbPath, values.json ?? false, values.kind, Number(values.limit ?? 30));
      }
      case "eval": {
        const { cmdEval } = await import("./query-commands.ts");
        return await cmdEval(root, dbPath, {
          ...(values.set ? { setPath: values.set } : {}),
          k: Number(values.k ?? 10),
          ...(values.budget ? { budget: Number(values.budget) } : {}),
          ...(values.shares ? { shares: parseShares(values.shares) } : {}),
          ...(values.ids ? { ids: values.ids.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
          ...(values.snapshots ? { snapshots: true } : {}),
          ...(values.explain ? { explain: true } : {}),
          ...(values["no-vectors"] ? { vectors: false } : {}),
          ...(values.work ? { workDir: path.resolve(values.work) } : {}),
          asJson: values.json ?? false,
        });
      }
      case "context": {
        const { cmdContext } = await import("./query-commands.ts");
        return await cmdContext(root, dbPath, {
          ...(positionals.length ? { task: positionals.join(" ") } : {}),
          ...(values["task-id"] ? { task_id: values["task-id"] } : {}),
          ...(values.open ? { open_files: values.open.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
          ...(values.budget ? { budget_tokens: Number(values.budget) } : {}),
          ...(values["task-history"] ? { task_history: true } : {}),
          ...(values["similar-tasks"] ? { similar_tasks: true } : {}),
        }, values.debug ?? false, values["as-of-task"]);
      }
      case "calls": {
        const { CALL_LOG_REL_PATH, summarizeCallLog } = await import("../server/call-log.ts");
        const file = path.join(root, CALL_LOG_REL_PATH);
        const files = [file.replace(/\.jsonl$/, ".1.jsonl"), file].filter((f) => fs.existsSync(f));
        if (!files.length) {
          process.stderr.write(`журнала нет: ${file}. Включите его в конфиге: log: { calls: true }\n`);
          return 2;
        }
        const entries = files.flatMap((f) =>
          fs
            .readFileSync(f, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l)),
        );
        process.stdout.write(values.json ? `${JSON.stringify(entries, null, 1)}\n` : `${summarizeCallLog(entries)}\n`);
        return 0;
      }
      case "serve": {
        const { serveStdio } = await import("../server/server.ts");
        await serveStdio(dbPath, root);
        return 0;
      }
      default:
        process.stderr.write(`неизвестная команда «${command}»\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`ошибка конфига:\n${e.message}\n`);
      return 2;
    }
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
    return 1;
  }
}

async function cmdIndex(root: string, dbPath: string, full: boolean, embeddings: boolean): Promise<number> {
  const report = await runIndex({ root, dbPath, full, embeddings, log: (m) => process.stderr.write(`${m}\n`) });
  process.stderr.write(`готово за ${(report.ms / 1000).toFixed(1)} с: ${report.dbPath}\n`);
  for (const e of report.errors.slice(0, 20)) process.stderr.write(`  ошибка: ${e.path}: ${e.error}\n`);
  if (report.errors.length > 20) process.stderr.write(`  … и ещё ${report.errors.length - 20}\n`);
  return 0;
}

async function cmdExplain(root: string, file: string | undefined): Promise<number> {
  if (!file) {
    process.stderr.write("укажите путь файла: mcp-context explain-file <путь>\n");
    return 2;
  }
  const registry = await loadRegistry(root);
  const loaded = loadConfig(root, registry);
  const rel = toPosix(path.isAbsolute(file) ? path.relative(root, file) : file);
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`файл не найден: ${abs}\n`);
    return 2;
  }
  const text = normalizeText(fs.readFileSync(abs, "utf8"));
  const out: string[] = [`файл: ${rel}`, `конфиг: ${loaded.file ?? "нет (настройки по умолчанию)"}`];
  const sel = selectExtractor({ path: rel, text }, loaded, registry);
  if (!sel) {
    out.push("экстрактор: нет — ни правило, ни расширение не подошли; файл в индекс не попадёт");
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }
  out.push(`экстрактор: ${sel.extractor.name} v${sel.extractor.version} — ${sel.extractor.description}`);
  out.push(`выбран: ${sel.reason}`);
  out.push(`параметры: ${JSON.stringify(sel.options)}`);
  const result = await sel.extractor.extract({ path: rel, text, hash: sha256(text) }, sel.options, createKit(registry, loaded.config));
  if (result.kind === "skip") {
    out.push(`результат: файл пропускается (${result.reason})`);
  } else if (result.kind === "document") {
    const d = result.document;
    out.push(`документ: «${d.title}», формат ${d.format}, тип из шапки: ${d.type ?? "—"}, статус: ${d.status ?? "—"}, covers: ${d.covers.join(", ") || "—"}`);
    out.push(`фрагментов: ${d.chunks.length}`);
    for (const c of d.chunks) {
      out.push(`  [${c.lineStart}-${c.lineEnd}] ${c.tokens} ток. ${c.id}`);
      out.push(`      ${c.headingPath.join(" › ")}${c.refs.length ? ` · ссылок: ${c.refs.length}` : ""}${c.api ? ` · api: ${c.api.kind} ${c.api.key}` : ""}${c.entities?.length ? ` · сущности: ${c.entities.map((e) => `${e.kind} ${e.name}`).join(", ")}` : ""}`);
    }
  } else {
    const c = result.code;
    out.push(`код: ${c.lang}${c.isTest ? ", тест" : ""}${c.generated ? ", сгенерирован" : ""}${c.unitName ? `, package ${c.unitName}` : ""}`);
    out.push(`символов: ${c.symbols.length}, импортов: ${c.imports.length}, строковых ключей: ${c.keys.length}`);
    for (const s of c.symbols) out.push(`  [${s.lineStart}-${s.lineEnd}] ${s.kind} ${s.qualified}${s.exported ? "" : " (не экспортируется)"} — ${truncate(s.signature, 110)}`);
    for (const i of c.imports) out.push(`  импорт: ${i.specifier} {${i.names.join(", ")}} строка ${i.line}`);
    for (const e of c.entities ?? []) out.push(`  сущность: ${e.kind} ${e.name} строка ${e.line}${e.symbolId ? ` (${e.symbolId.split("#").pop()})` : ""}`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

function parseShares(v: string): { docs: number; code: number; rules: number } {
  const [docs = 0.55, code = 0.3, rules = 0.15] = v.split(",").map(Number);
  return { docs, code, rules };
}
