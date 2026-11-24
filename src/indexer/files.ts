import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import picomatch from "picomatch";
import { toPosix } from "../util/text.ts";

/** Каталоги, которые никогда не индексируются. */
const ALWAYS_EXCLUDED = [".git/**", ".mcp/**", "**/node_modules/**"];

const BINARY_EXT = new Set(
  (
    ".png .jpg .jpeg .gif .webp .ico .bmp .tiff .svgz .pdf .zip .gz .tgz .bz2 .xz .7z .rar .jar .war .class .wasm .dll .so .dylib .exe " +
    ".bin .o .a .lib .woff .woff2 .ttf .otf .eot .mp3 .mp4 .mov .avi .webm .ogg .wav .flac .sqlite .db .pyc .node .psd .ai .sketch .fig"
  ).split(" "),
);

export function isBinaryPath(p: string): boolean {
  return BINARY_EXT.has(path.posix.extname(p).toLowerCase());
}

export function isGitRepo(root: string): boolean {
  return fs.existsSync(path.join(root, ".git"));
}

/** Файлы репозитория относительно корня, через `/`, отсортированные. Учитываются все `.gitignore`. */
export function listRepoFiles(root: string, exclude: string[]): string[] {
  const excluded = picomatch([...ALWAYS_EXCLUDED, ...exclude], { dot: true });
  let files: string[];
  if (isGitRepo(root)) {
    const out = execFileSync("git", ["-C", root, "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      maxBuffer: 512 * 1024 * 1024,
      encoding: "utf8",
    });
    files = [...new Set(out.split("\0").filter(Boolean))].filter((p) => {
      try {
        return fs.statSync(path.join(root, p)).isFile();
      } catch {
        return false; // удалён в рабочем дереве, но ещё в индексе git
      }
    });
  } else {
    files = walk(root);
  }
  return files.map(toPosix).filter((p) => !excluded(p)).sort();
}

function walk(root: string): string[] {
  const out: string[] = [];
  const ig = ignore();
  const rootIgnore = path.join(root, ".gitignore");
  if (fs.existsSync(rootIgnore)) ig.add(fs.readFileSync(rootIgnore, "utf8"));
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(root);
  return out;
}

export interface PackageSpec {
  name: string;
  from: string;
  include: string[];
}

/** Путь внешнего пакета внутри репозитория — так его видит импортирующий код: `<from>/node_modules/<name>`. */
export function packageDir(spec: PackageSpec): string {
  return [spec.from.replace(/\/+$/, ""), "node_modules", spec.name].filter(Boolean).join("/");
}

/**
 * Файлы внешних пакетов (документация и типы) с путями `<from>/node_modules/<name>/…`.
 * Ссылки pnpm разворачиваются; вложенные node_modules пакета не обходятся.
 */
export function listPackageFiles(root: string, specs: PackageSpec[]): { files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  for (const spec of specs) {
    const dir = packageDir(spec);
    let real: string;
    try {
      real = fs.realpathSync(path.join(root, dir));
    } catch {
      missing.push(`${spec.name} (нет ${dir}: зависимости не установлены?)`);
      continue;
    }
    const match = picomatch(spec.include, { dot: false });
    const visit = (abs: string, rel: string) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const childAbs = path.join(abs, entry.name);
        const stat = fs.statSync(childAbs);
        if (stat.isDirectory()) visit(childAbs, childRel);
        else if (stat.isFile() && match(childRel)) files.push(`${dir}/${childRel}`);
      }
    };
    visit(real, "");
  }
  return { files: files.sort(), missing };
}

export const isExternalPath = (p: string) => p.includes("/node_modules/") || p.startsWith("node_modules/");

/** Похоже ли содержимое на двоичное: нулевой байт в начале файла. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
