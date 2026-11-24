import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import { getTaskContext } from "../src/context/build.ts";
import { applyTemplate, createEmbedder, finishVector, type EmbeddingSettings } from "../src/embeddings/provider.ts";
import { QueryEmbedder } from "../src/embeddings/query.ts";
import { loadRegistry } from "../src/extractors/registry.ts";
import { defaultDbPath, runIndex } from "../src/indexer/index.ts";
import { globalStatus, searchDocs } from "../src/search/queries.ts";
import { openSqliteStore } from "../src/store/sqlite/store.ts";
import { PROJECT_ROOT, createFixtureRepo, rmrf } from "./helpers.ts";

const SCRIPT = path.join(PROJECT_ROOT, "test/fixtures/embeddings/hash-embed.mjs").replace(/\\/g, "/");
const settings = (over: Partial<EmbeddingSettings>): EmbeddingSettings => ({
  provider: "none",
  format: "openai",
  headers: {},
  query_template: "{text}",
  document_template: "{text}",
  batch: 32,
  timeout_ms: 5000,
  max_chars: 2000,
  targets: ["docs", "code"],
  ...over,
});
/** Дописывает раздел embeddings в конфиг учебного репозитория. */
const withEmbeddings = (repo: string, yaml: string) => fs.appendFileSync(path.join(repo, ".mcp/context.yaml"), `\nembeddings:\n${yaml}\n`);

describe("поставщики эмбеддингов", () => {
  it("вектор обрезается до dimensions и нормируется; шаблон подставляет текст и заголовок", () => {
    const v = finishVector([3, 4, 12], 2);
    assert.equal(v.length, 2);
    assert.ok(Math.abs((v[0] as number) - 0.6) < 1e-6 && Math.abs((v[1] as number) - 0.8) < 1e-6);
    assert.equal(applyTemplate("title: {title} | text: {text}", "тело", ""), "title: none | text: тело");
  });

  it("http, формат openai: ключ из переменной окружения, повтор после 500, порядок по index", async () => {
    let calls = 0;
    const seen: Array<{ auth: string | undefined; body: { model: string; input: string[] } }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        calls++;
        if (calls === 1) {
          res.statusCode = 500;
          res.end("временно");
          return;
        }
        const parsed = JSON.parse(body) as { model: string; input: string[] };
        seen.push({ auth: req.headers.authorization, body: parsed });
        const data = parsed.input.map((t, i) => ({ index: i, embedding: [t.length, 1, 0] })).reverse();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.TEST_EMB_KEY = "sk-test";
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`;
      const e = createEmbedder(settings({ provider: "http", url, model: "m", api_key_env: "TEST_EMB_KEY" }), PROJECT_ROOT);
      const [a, b] = (await e?.embed(["ab", "abcd"], "document")) ?? [];
      assert.equal(calls, 2, "первый ответ 500 — повтор");
      assert.equal(seen[0]?.auth, "Bearer sk-test");
      assert.equal(seen[0]?.body.model, "m");
      assert.ok(a && b && (a[0] as number) < (b[0] as number), "векторы по порядку index");
    } finally {
      delete process.env.TEST_EMB_KEY;
      server.close();
    }
  });

  it("http, формат ollama (/api/embed)", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ embeddings: [[1, 0], [0, 1]] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/embed`;
      const vs = await createEmbedder(settings({ provider: "http", url, model: "m", format: "ollama" }), PROJECT_ROOT)?.embed(["x", "y"], "query");
      assert.deepEqual(vs?.map((v) => [...v]), [[1, 0], [0, 1]]);
    } finally {
      server.close();
    }
  });

  it("проверка сервиса: 5xx — жив (модель грузится), 4xx — отказ с причиной", async () => {
    let status = 503;
    const server = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end(status === 404 ? 'model "x" not found' : "загружается");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`;
      const e = createEmbedder(settings({ provider: "http", url, model: "x" }), PROJECT_ROOT);
      assert.equal(await e?.probe?.(), null);
      status = 404;
      assert.match((await e?.probe?.()) ?? "", /404.*not found/);
    } finally {
      server.close();
    }
  });

  it("вектор запроса: одна попытка без повторов, после сбоя минуту сервис не дёргается", async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => {
      calls++;
      res.statusCode = 500;
      res.end("упал");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`;
      const s = settings({ provider: "http", url, model: "m" });
      const q = new QueryEmbedder(createEmbedder(s, PROJECT_ROOT), s);
      // Индекс с векторами той же метки: иначе запрос к сервису не пойдёт.
      const reader = { vectorStats: () => [{ kind: "chunk" as const, label: createEmbedder(s, PROJECT_ROOT)?.label ?? "", dim: 2, count: 1 }] };
      const first = await q.vector(reader as never, "задача");
      assert.ok(first && "error" in first);
      assert.equal(calls, 1, "без повторов");
      const second = await q.vector(reader as never, "другая задача");
      assert.ok(second && "error" in second && /через минуту/.test(second.error));
      assert.equal(calls, 1, "сервис не дёргается после сбоя");
    } finally {
      server.close();
    }
  });

  it("command: свой скрипт по протоколу построчного JSON; ошибка скрипта — исключение", async () => {
    const e = createEmbedder(settings({ provider: "command", command: ["node", SCRIPT] }), PROJECT_ROOT);
    try {
      const [a, b, c] = (await e?.embed(["слот доставки", "слот доставки и корзина", "кадр GSM"], "document")) ?? [];
      const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * (y[i] as number), 0);
      assert.ok(a && b && c && dot(a, b) > dot(a, c), "похожие тексты ближе");
      await assert.rejects(() => e?.embed(["сломай"], "query") ?? Promise.resolve(), /не умею/);
    } finally {
      await e?.close();
    }
  });

  it("конфиг: для http нужны url и model, для command — команда", async () => {
    const dir = createFixtureRepo({ history: false });
    try {
      withEmbeddings(dir, "  provider: http");
      assert.throws(() => loadConfig(dir, new Map()), (e: unknown) => e instanceof ConfigError && /url/.test(e.message) && /model/.test(e.message));
    } finally {
      rmrf(dir);
    }
  });
});

describe("поиск по смыслу в индексе и пакете", () => {
  let repo = "";
  before(async () => {
    repo = createFixtureRepo();
    withEmbeddings(repo, `  provider: command\n  command: [node, "${SCRIPT}"]\n  batch: 8`);
    await runIndex({ root: repo });
  });
  after(() => rmrf(repo));

  it("векторы считаются для разделов и символов, повторно — только для изменившегося", async () => {
    const store = await openSqliteStore(defaultDbPath(repo));
    const stats = store.vectorStats();
    store.close();
    const count = (k: string) => stats.filter((s) => s.kind === k).reduce((a, s) => a + s.count, 0);
    assert.ok(count("chunk") > 3 && count("symbol") > 3, JSON.stringify(stats));

    const again = await runIndex({ root: repo });
    assert.equal(again.embeddings?.embedded, 0);
    assert.equal(again.embeddings?.error, undefined);

    fs.appendFileSync(path.join(repo, "docs/guides/slots.md"), "\n## Новый раздел\n\nСлот можно отменить из корзины.\n");
    const changed = await runIndex({ root: repo });
    assert.ok((changed.embeddings?.embedded ?? 0) >= 1 && (changed.embeddings?.embedded ?? 0) <= 3, JSON.stringify(changed.embeddings));
  });

  it("пересчёт сорвался — у изменившегося текста нет вектора, а не старый", async () => {
    const chunkVectors = async () => {
      const s = await openSqliteStore(defaultDbPath(repo), { readonly: true });
      const v = s.vectorHashes("chunk");
      s.close();
      return v;
    };
    const before = await chunkVectors();
    const failing = { label: [...before.values()][0]?.label ?? "", embed: async () => Promise.reject(new Error("упал")), close: async () => {} };
    fs.appendFileSync(path.join(repo, "docs/guides/slots.md"), "\nЕщё строка в последний раздел.\n");
    const report = await runIndex({ root: repo, embedder: failing });
    assert.match(report.embeddings?.error ?? "", /упал/);
    assert.equal(report.embeddings?.embedded, 0);
    assert.equal((await chunkVectors()).size, before.size - 1, "вектор изменившегося раздела удалён");
  });

  it("пакет получает список vectors; search_docs ищет по смыслу; index_status показывает векторы", async () => {
    const store = await openSqliteStore(defaultDbPath(repo), { readonly: true });
    const queries = await QueryEmbedder.fromRoot(repo);
    try {
      const task = "Выбранный слот доставки сбрасывается после возврата из корзины";
      const qv = await queries.vector(store, task);
      assert.ok(qv && "vec" in qv);
      const p = getTaskContext(store, { task }, { debug: true, queryVector: qv });
      assert.equal(p.meta.search, "по словам, связям и смыслу");
      const ranking = p.meta.ranking as Array<{ lists: Record<string, number> }>;
      assert.ok(ranking.some((r) => r.lists.vectors), "есть кандидаты из списка vectors");
      const sem = searchDocs(store, { query: task, mode: "semantic", queryVector: qv });
      assert.equal(sem.search, "по смыслу");
      assert.ok(sem.results.length > 0 && String(sem.results[0]?.why).includes("близко по смыслу"));
      const status = globalStatus(store) as { search_mode: string; embeddings?: { vectors: { chunks: number } } };
      assert.match(status.search_mode, /смыслу/);
      assert.ok((status.embeddings?.vectors.chunks ?? 0) > 0);
    } finally {
      await queries.close();
      store.close();
    }
  });

  it("поставщик недоступен: индексация не падает, пакет собирается по словам с причиной в meta.search", async () => {
    const dir = createFixtureRepo({ history: false });
    try {
      withEmbeddings(dir, "  provider: http\n  url: http://127.0.0.1:9/v1/embeddings\n  model: m\n  timeout_ms: 2000");
      const t0 = Date.now();
      const report = await runIndex({ root: dir, registry: await loadRegistry(dir) });
      assert.match(report.embeddings?.error ?? "", /недоступен.*не отвечает/, "одна быстрая проверка, без повторов на каждой пачке");
      assert.ok(Date.now() - t0 < 30_000);
      const store = await openSqliteStore(defaultDbPath(dir), { readonly: true });
      const queries = await QueryEmbedder.fromRoot(dir);
      try {
        const qv = await queries.vector(store, "слот доставки");
        assert.ok(qv && "error" in qv);
        const p = getTaskContext(store, { task: "слот доставки" }, { queryVector: qv });
        assert.match(String(p.meta.search), /недоступен/);
        assert.ok(p.code.length + p.docs.length > 0);
      } finally {
        await queries.close();
        store.close();
      }
    } finally {
      rmrf(dir);
    }
  });
});
