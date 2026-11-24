#!/usr/bin/env node
/**
 * Точка входа CLI. Предупреждение Node об экспериментальном `node:sqlite` глушится до загрузки
 * остальных модулей: в режиме stdio stdout занят протоколом MCP, а stderr засорять незачем.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && /SQLite|Type Stripping/i.test(text)) return;
  (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { runCli } = await import("./commands.ts");
process.exitCode = await runCli(process.argv.slice(2));
