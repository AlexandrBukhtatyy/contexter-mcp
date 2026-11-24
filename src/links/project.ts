import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import ts from "typescript";
import { dirOf, joinRepoPath } from "../util/text.ts";

/**
 * Структура репозитория, нужная шагу связывания: пакеты TS, модули Go, алиасы путей из tsconfig,
 * владельцы из CODEOWNERS. Считается заново при каждой индексации из текущего списка файлов.
 */
export interface TsPackage {
  name: string;
  dir: string;
  /** Точки входа из package.json, относительно каталога пакета. */
  entries: string[];
  /** Подпути из `exports`: `fields` → [`dist/fields/index.d.ts`, …]. */
  subpaths: Map<string, string[]>;
}

export interface GoModule {
  path: string;
  dir: string;
}

interface TsConfigInfo {
  /** Каталог, от которого считаются пути `paths`, относительно корня репозитория. */
  base: string;
  paths: Record<string, string[]>;
}

const TS_EXTS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export class ProjectInfo {
  readonly packages = new Map<string, TsPackage>();
  readonly packageByDir = new Map<string, TsPackage>();
  readonly goModules: GoModule[] = [];
  readonly dirs = new Set<string>();
  private readonly tsconfigByDir = new Map<string, TsConfigInfo | null>();
  private readonly tsconfigPaths = new Set<string>();
  private readonly owners: Array<{ match: (p: string) => boolean; owner: string }> = [];
  readonly root: string;
  readonly files: ReadonlySet<string>;

  constructor(root: string, files: ReadonlySet<string>) {
    this.root = root;
    this.files = files;
    for (const f of files) {
      let d = dirOf(f);
      while (d && !this.dirs.has(d)) {
        this.dirs.add(d);
        d = dirOf(d);
      }
    }
    this.dirs.add("");
    for (const f of files) {
      const base = path.posix.basename(f);
      if (base === "package.json") this.readPackageJson(f);
      else if (base === "go.mod") this.readGoMod(f);
      else if (/^tsconfig(\.[\w-]+)?\.json$/.test(base)) this.tsconfigPaths.add(f);
    }
    this.goModules.sort((a, b) => b.dir.length - a.dir.length);
    for (const candidate of ["CODEOWNERS", ".github/CODEOWNERS", ".gitlab/CODEOWNERS", "docs/CODEOWNERS"]) {
      if (files.has(candidate)) {
        this.readCodeowners(candidate);
        break;
      }
    }
  }

  private read(rel: string): string | null {
    try {
      return fs.readFileSync(path.join(this.root, rel), "utf8");
    } catch {
      return null;
    }
  }

  private readPackageJson(rel: string): void {
    const raw = this.read(rel);
    if (!raw) return;
    try {
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      if (typeof pkg.name !== "string") return;
      const collect = (v: unknown, out: string[]) => {
        if (typeof v === "string") out.push(v.replace(/^\.\//, ""));
        else if (v && typeof v === "object") for (const k of ["types", "import", "default", "require", "node"]) collect((v as Record<string, unknown>)[k], out);
      };
      const entries: string[] = [];
      const subpaths = new Map<string, string[]>();
      const exp = pkg.exports;
      if (typeof exp === "string") collect(exp, entries);
      else if (exp && typeof exp === "object") {
        const map = exp as Record<string, unknown>;
        collect(map["."] ?? (Object.keys(map).some((k) => k.startsWith(".")) ? undefined : exp), entries);
        for (const [k, v] of Object.entries(map)) {
          if (!k.startsWith("./") || k.includes("*")) continue;
          const list: string[] = [];
          collect(v, list);
          subpaths.set(k.slice(2), list);
        }
      }
      for (const k of ["types", "typings", "module", "main", "source"]) collect(pkg[k], entries);
      entries.push("src/index", "index");
      const info: TsPackage = { name: pkg.name, dir: dirOf(rel), entries, subpaths };
      this.packages.set(info.name, info);
      this.packageByDir.set(info.dir, info);
    } catch {
      /* битый package.json пропускается */
    }
  }

  private readGoMod(rel: string): void {
    const raw = this.read(rel);
    const m = raw?.match(/^module\s+(\S+)/m);
    if (m?.[1]) this.goModules.push({ path: m[1], dir: dirOf(rel) });
  }

  private readCodeowners(rel: string): void {
    const raw = this.read(rel) ?? "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("[")) continue;
      const [pattern, ...owners] = t.split(/\s+/);
      if (!pattern || owners.length === 0) continue;
      let glob = pattern.startsWith("/") ? pattern.slice(1) : `**/${pattern}`;
      if (glob.endsWith("/")) glob += "**";
      else if (!/[*?]/.test(path.posix.basename(glob)) && !path.posix.extname(glob)) glob = `{${glob},${glob}/**}`;
      this.owners.push({ match: picomatch(glob, { dot: true }), owner: owners.join(" ") });
    }
  }

  /** Какие из путей попадают под .gitignore (одним вызовом `git check-ignore`). */
  ignoredPaths(paths: string[]): Set<string> {
    const unique = [...new Set(paths.filter(Boolean))];
    if (!unique.length || !fs.existsSync(path.join(this.root, ".git"))) return new Set();
    let out: string;
    try {
      out = execFileSync("git", ["-C", this.root, "check-ignore", "--no-index", "--stdin"], { input: unique.join("\n"), encoding: "utf8" });
    } catch (e) {
      // Код выхода 1 — ни один путь не игнорируется.
      out = String((e as { stdout?: string }).stdout ?? "");
    }
    return new Set(out.split(/\r?\n/).filter(Boolean));
  }

  /** Владелец по CODEOWNERS: побеждает последнее подошедшее правило. */
  ownerOf(p: string): string | null {
    let owner: string | null = null;
    for (const o of this.owners) if (o.match(p)) owner = o.owner;
    return owner;
  }

  /** Ближайший пакет TS (каталог с package.json) над файлом. */
  tsPackageOf(p: string): TsPackage | null {
    let d = dirOf(p);
    for (;;) {
      const pkg = this.packageByDir.get(d);
      if (pkg) return pkg;
      if (!d) return null;
      d = dirOf(d);
    }
  }

  goModuleOf(p: string): GoModule | null {
    const d = dirOf(p);
    return this.goModules.find((m) => m.dir === "" || d === m.dir || d.startsWith(`${m.dir}/`)) ?? null;
  }

  /** Путь импорта Go-пакета по каталогу. */
  goImportPathOf(dir: string): string | null {
    const mod = this.goModules.find((m) => m.dir === "" || dir === m.dir || dir.startsWith(`${m.dir}/`));
    if (!mod) return null;
    const rest = mod.dir === "" ? dir : dir.slice(mod.dir.length).replace(/^\//, "");
    return rest ? `${mod.path}/${rest}` : mod.path;
  }

  /** Каталог Go-пакета по пути импорта, если пакет внутри репозитория. */
  goDirOf(importPath: string): string | null {
    for (const m of this.goModules) {
      if (importPath === m.path) return m.dir;
      if (importPath.startsWith(`${m.path}/`)) return joinRepoPath(m.dir, importPath.slice(m.path.length + 1));
    }
    return null;
  }

  /** Разрешает импорт TS/JS в файл репозитория. Внешние пакеты — null. */
  resolveTsImport(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith(".")) {
      const base = joinRepoPath(dirOf(fromFile), specifier);
      return base === null ? null : this.tryTsFile(base);
    }
    const cfg = this.tsconfigFor(fromFile);
    if (cfg) {
      for (const [pattern, targets] of Object.entries(cfg.paths)) {
        const star = pattern.indexOf("*");
        let captured: string | null = null;
        if (star < 0) captured = pattern === specifier ? "" : null;
        else {
          const pre = pattern.slice(0, star);
          const post = pattern.slice(star + 1);
          if (specifier.startsWith(pre) && specifier.endsWith(post) && specifier.length >= pre.length + post.length) {
            captured = specifier.slice(pre.length, specifier.length - post.length);
          }
        }
        if (captured === null) continue;
        for (const t of targets) {
          const candidate = joinRepoPath(cfg.base, t.replace("*", captured));
          const hit = candidate === null ? null : this.tryTsFile(candidate);
          if (hit) return hit;
        }
      }
    }
    // Пакет рабочего пространства: `@scope/name` или `@scope/name/sub`.
    const parts = specifier.split("/");
    const nameLen = specifier.startsWith("@") ? 2 : 1;
    const pkg = this.packages.get(parts.slice(0, nameLen).join("/"));
    if (!pkg) return null;
    const sub = parts.slice(nameLen).join("/");
    for (const e of sub ? (pkg.subpaths.get(sub) ?? []) : []) {
      const p = joinRepoPath(pkg.dir, e);
      const hit = p === null ? null : this.tryTsFile(p);
      if (hit) return hit;
    }
    if (sub) {
      const p = joinRepoPath(pkg.dir, sub);
      return (p !== null && (this.tryTsFile(p) ?? this.tryTsFile(joinRepoPath(pkg.dir, `src/${sub}`) ?? ""))) || null;
    }
    for (const e of pkg.entries) {
      const p = joinRepoPath(pkg.dir, e);
      const hit = p === null ? null : (this.tryTsFile(p) ?? this.tryTsFile(p.replace(/(^|\/)dist\//, "$1src/")));
      if (hit) return hit;
    }
    return null;
  }

  private tryTsFile(p: string): string | null {
    if (!p) return null;
    if (this.files.has(p) && TS_EXTS.some((e) => p.endsWith(e))) return p;
    const noJs = p.replace(/\.(js|jsx|mjs|cjs)$/, "");
    for (const base of noJs === p ? [p] : [noJs, p]) {
      for (const ext of TS_EXTS) if (this.files.has(base + ext)) return base + ext;
    }
    for (const ext of TS_EXTS) if (this.files.has(`${p}/index${ext}`)) return `${p}/index${ext}`;
    return null;
  }

  /** Ближайший tsconfig.json над файлом, с учётом `extends`. */
  private tsconfigFor(file: string): TsConfigInfo | null {
    let d = dirOf(file);
    const visited: string[] = [];
    for (;;) {
      if (this.tsconfigByDir.has(d)) {
        const v = this.tsconfigByDir.get(d) ?? null;
        for (const x of visited) this.tsconfigByDir.set(x, v);
        return v;
      }
      visited.push(d);
      const candidate = d ? `${d}/tsconfig.json` : "tsconfig.json";
      if (this.tsconfigPaths.has(candidate)) {
        const info = this.parseTsconfig(candidate);
        for (const x of visited) this.tsconfigByDir.set(x, info);
        return info;
      }
      if (!d) {
        for (const x of visited) this.tsconfigByDir.set(x, null);
        return null;
      }
      d = dirOf(d);
    }
  }

  private parseTsconfig(rel: string): TsConfigInfo | null {
    const abs = path.join(this.root, rel);
    const host: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: (f) => fs.existsSync(f),
      readFile: (f) => {
        try {
          return fs.readFileSync(f, "utf8");
        } catch {
          return undefined;
        }
      },
    };
    const read = ts.readConfigFile(abs, host.readFile);
    if (read.error || !read.config) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(abs), undefined, abs);
    const o = parsed.options;
    if (!o.paths) return null;
    const baseAbs = o.baseUrl ?? (o as { pathsBasePath?: string }).pathsBasePath ?? path.dirname(abs);
    const base = path.relative(this.root, baseAbs).split(path.sep).join("/");
    return { base: base === "." ? "" : base, paths: o.paths };
  }
}
