import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigError, LOCAL_CONFIG_REL_PATH, loadConfig, parseConfigText } from "../src/config/load.ts";
import { builtinExtractors } from "../src/extractors/registry.ts";
import { defaultDbPath, runIndex } from "../src/indexer/index.ts";
import { selectExtractor } from "../src/indexer/select.ts";
import { searchDocs } from "../src/search/queries.ts";
import { openSqliteStore } from "../src/store/sqlite/store.ts";
import { rmrf, tempDir } from "./helpers.ts";

const registry = builtinExtractors();
const FILE = ".mcp/context.yaml";

function problems(yaml: string) {
  try {
    parseConfigText(yaml, FILE, registry);
  } catch (e) {
    assert.ok(e instanceof ConfigError, String(e));
    return e.problems;
  }
  assert.fail("ожидалась ошибка конфига");
}

describe("конфиг .mcp/context.yaml", () => {
  it("личный .mcp/context.local.yaml поверх общего: разделы сливаются, ошибка — с файлом и строкой личного", () => {
    const dir = tempDir("cfg");
    try {
      fs.mkdirSync(path.join(dir, ".mcp"), { recursive: true });
      fs.writeFileSync(path.join(dir, FILE), 'exclude: ["tmp/**"]\ncontext:\n  budget_tokens: 5000\n  max_expansion: 10\n');
      fs.writeFileSync(path.join(dir, LOCAL_CONFIG_REL_PATH), "context:\n  budget_tokens: 7000\nembeddings:\n  provider: stub\n");
      const loaded = loadConfig(dir, registry);
      assert.equal(loaded.config.context.budget_tokens, 7000, "личное значение заменяет общее");
      assert.equal(loaded.config.context.max_expansion, 10, "соседние ключи раздела остаются из общего");
      assert.deepEqual(loaded.config.exclude, ["tmp/**"]);
      assert.equal(loaded.config.embeddings.provider, "stub");
      assert.equal(loaded.file, `${FILE} + ${LOCAL_CONFIG_REL_PATH}`);

      fs.writeFileSync(path.join(dir, LOCAL_CONFIG_REL_PATH), "embeddings:\n  provider: http\n  modle: x\n");
      const err = (() => {
        try {
          loadConfig(dir, registry);
        } catch (e) {
          return e as ConfigError;
        }
        return null;
      })();
      assert.ok(err instanceof ConfigError);
      const typo = err.problems.find((p) => p.message.includes("modle"));
      assert.deepEqual([typo?.file, typo?.line], [LOCAL_CONFIG_REL_PATH, 3]);
    } finally {
      rmrf(dir);
    }
  });

  it("неизвестный экстрактор — ошибка с номером строки", () => {
    const p = problems("version: 1\nextractors:\n  rules:\n    - match: { path: \"**/*.md\" }\n      use: markdwn\n");
    assert.equal(p.length, 1);
    assert.equal(p[0]?.line, 5);
    assert.match(p[0]?.message ?? "", /неизвестный экстрактор «markdwn»/);
  });

  it("неизвестный ключ и неизвестный параметр экстрактора — с номерами строк", () => {
    const p = problems("version: 1\nexclud: []\nextractors:\n  rules:\n    - match: { path: \"a/**\" }\n      use: code\n      options:\n        coments: false\n");
    assert.deepEqual(
      p.map((x) => [x.line, x.message]),
      [[2, "неизвестный ключ «exclud»"]],
    );
    const p2 = problems("extractors:\n  rules:\n    - match: { path: \"a/**\" }\n      use: code\n      options:\n        coments: false\n");
    assert.equal(p2[0]?.line, 6);
    assert.match(p2[0]?.message ?? "", /неизвестный параметр «coments» экстрактора «code»/);
  });

  it("неверное регулярное выражение и ошибка YAML", () => {
    const p = problems("documents:\n  status:\n    - { path: \"docs/**\", regex: \"(\" }\n");
    assert.equal(p[0]?.line, 3);
    assert.match(p[0]?.message ?? "", /регулярное выражение/);
    const y = problems("version: 1\nexclude: [a\n");
    assert.match(y[0]?.message ?? "", /ошибка YAML/);
  });

  it("порядок выбора: шапка → правило → встроенное правило → расширение → пропуск", () => {
    const loaded = parseConfigText('extractors:\n  rules:\n    - match: { path: "docs/api/**" }\n      use: skip\n', FILE, registry);
    const pick = (path: string, text = "") => selectExtractor({ path, text }, loaded, registry);
    assert.equal(pick("docs/guide.md")?.extractor.name, "markdown");
    assert.match(pick("docs/guide.md")?.reason ?? "", /по расширению \.md/);
    assert.equal(pick("docs/api/x.md")?.extractor.name, "skip");
    assert.match(pick("docs/api/x.md")?.reason ?? "", /правило 1 \(строка 3/);
    assert.equal(pick("docs/api/y.md", "---\nextractor: markdown\n---\n# Y\n")?.extractor.name, "markdown");
    assert.equal(pick("contracts/x.yaml", "openapi: 3.0.0\npaths: {}\n")?.extractor.name, "openapi");
    assert.equal(pick("contracts/e.yaml", "asyncapi: 3.0.0\n")?.extractor.name, "asyncapi");
    assert.equal(pick("svc/main.go")?.extractor.name, "code-go");
    assert.equal(pick("image.svg"), null);
  });

  it("свой экстрактор подключается модулем из репозитория и выбирается правилом", async () => {
    const dir = tempDir("plugin");
    try {
      fs.mkdirSync(path.join(dir, ".mcp"), { recursive: true });
      fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "tools/csv.mjs"),
        `export default {
  name: "csv-table", version: 1,
  extract(file) {
    const rows = file.text.trim().split("\\n");
    return { kind: "document", document: { title: file.path, type: "table", status: null, owner: null, covers: [], frontmatter: null, format: "csv",
      chunks: [{ id: file.path + "#rows", headingPath: [file.path], ordinal: 0, kind: "section", text: file.text, lineStart: 1, lineEnd: rows.length, tokens: rows.length * 5, hash: "h", refs: [] }] } };
  },
};\n`,
      );
      fs.writeFileSync(path.join(dir, ".mcp/context.yaml"), 'plugins: ["tools/csv.mjs"]\nextractors:\n  rules:\n    - match: { path: "**/*.csv" }\n      use: csv-table\n');
      fs.writeFileSync(path.join(dir, "devices.csv"), "id,name\n1,шлагбаум северный\n");
      const report = await runIndex({ root: dir });
      assert.deepEqual(report.errors, []);
      const store = await openSqliteStore(defaultDbPath(dir), { readonly: true, vectors: false });
      try {
        assert.equal(store.getDocument("devices.csv")?.format, "csv");
        assert.equal(searchDocs(store, { query: "шлагбаумы" }).results[0]?.id, "devices.csv#rows");
      } finally {
        store.close();
      }
    } finally {
      rmrf(dir);
    }
  });

  it("общие настройки разбиения входят в параметры markdown и меняют их хэш", () => {
    const a = parseConfigText("chunking: { max_tokens: 900 }\n", FILE, registry);
    const b = parseConfigText("chunking: { max_tokens: 1200 }\n", FILE, registry);
    const sa = selectExtractor({ path: "a.md", text: "" }, a, registry);
    const sb = selectExtractor({ path: "a.md", text: "" }, b, registry);
    assert.equal(sa?.options.max_tokens, 900);
    assert.notEqual(sa?.optionsHash, sb?.optionsHash);
  });
});
