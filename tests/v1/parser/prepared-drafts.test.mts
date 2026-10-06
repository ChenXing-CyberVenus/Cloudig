import { testRuntimeRoot } from "../helpers/runtime-root.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PreparedDraftStore, parserParallelism } from "../../../src/app/parser/prepared-drafts.mts";
import { parseExporterHtmlToDraft } from "../../../src/app/parser/host.mts";
import { createLocalLibrary } from "../../../src/adapters/library-data/index.mts";
import { commitNewParsedSource, prepareCatalogForParser } from "../../../src/adapters/library-data/parser-commit.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { prepareParseBatch, runPreparedParseBatch } from "../../../src/app/parser/batch.mts";
import { readCatalogCache } from "../../../src/adapters/library-data/index.mts";
import { validateConversation } from "../../../src/core/contracts/index.mts";

async function scope(run: (root: string) => Promise<void>): Promise<void> {
  const temporary = path.join(process.cwd(), "tmp"); await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "parser-workers-"));
  try { await mkdir(path.join(root, "Inbox")); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const fixture = () => readFile(path.join(process.cwd(), "tests/v1/parser/fixtures/chatgpt-light.html"));

test("parallelism leaves CPU/memory headroom and never rejects a single large input", () => {
  assert.equal(parserParallelism(24, 48 * 1024 ** 3), 6);
  assert.equal(parserParallelism(4, 2 * 1024 ** 3), 1);
  assert.equal(parserParallelism(8, 4 * 1024 ** 3), 2);
  assert.equal(parserParallelism(1, 100), 1);
});

test("two real worker threads retain exact drafts on disk and isolate one bad file", async () => scope(async root => {
  const bytes = await fixture();
  const names = ["a.html", "bad.html", "b.html", "c.html"];
  for (const name of names) await writeFile(path.join(root, "Inbox", name), name === "bad.html" ? "not an exporter" : bytes);
  const store = await PreparedDraftStore.create(root, names.map(name => `Inbox/${name}`), { runtimeRoot: testRuntimeRoot(root), workers: 2 });
  try {
    await assert.rejects(store.preview(1));
    for (const index of [0, 2, 3]) {
      const preview = await store.preview(index);
      const expected = await parseExporterHtmlToDraft({ filePath: path.join(root, "Inbox", names[index]!) });
      assert.equal(preview.messages, (expected.draft["messages"] as unknown[]).length);
      const prepared = (await store.take(`Inbox/${names[index]}`))!;
      const { verifiedResources, ...body } = prepared;
      assert.ok(verifiedResources);
      assert.deepEqual(body, expected);
    }
    await store.finish();
    assert.equal(store.metrics.parsed, 3);
    assert.equal(store.metrics.maxActive, 2);
    assert.equal(new Set(store.metrics.threadIds).size, 2);
    assert.equal(await store.take("Inbox/a.html"), undefined);
  } finally { await store.dispose(); }
  assert.deepEqual(await readdir(path.join(testRuntimeRoot(root), "ParserDrafts")), []);
  assert.deepEqual(await readFile(path.join(root, "Inbox/a.html")), bytes);
}));

test("a changed transient draft fails closed without re-reading or reparsing its source", async () => scope(async root => {
  await writeFile(path.join(root, "Inbox/a.html"), await fixture());
  const store = await PreparedDraftStore.create(root, ["Inbox/a.html"], { runtimeRoot: testRuntimeRoot(root), workers: 1 });
  try {
    await store.preview(0); await store.finish();
    const base = path.join(testRuntimeRoot(root), "ParserDrafts");
    const [directory] = await readdir(base);
    await writeFile(path.join(base, directory!, "0.bin"), "modified");
    await assert.rejects(store.take("Inbox/a.html"), /changed after preview/u);
  } finally { await store.dispose(); }
}));

test("cancellation stops active workers and removes only this preparation's transient files", async () => scope(async root => {
  const bytes = await fixture();
  for (const name of ["a", "b", "c"]) await writeFile(path.join(root, `Inbox/${name}.html`), bytes);
  const controller = new AbortController();
  const store = await PreparedDraftStore.create(root, ["Inbox/a.html", "Inbox/b.html", "Inbox/c.html"], { runtimeRoot: testRuntimeRoot(root),
    workers: 2, signal: controller.signal, onProgress: () => controller.abort()
  });
  try { await assert.rejects(store.preview(0), { name: "AbortError" }); }
  finally { await store.dispose(); }
  assert.deepEqual(await readdir(path.join(testRuntimeRoot(root), "ParserDrafts")), []);
  assert.deepEqual(await readdir(path.join(root, "Inbox")), ["a.html", "b.html", "c.html"]);
}));

test("worker resource proof never substitutes for verification of the actual staged bytes", async () => scope(async root => {
  const library = path.join(root, "Library");
  await createLocalLibrary({ root: library, transaction: "x_WORKERPROOFLIBAA", timestamp: "2026-09-07T01:00:00.000Z", localDate: "2026-09-07", offset: "Z", language: "zh-CN" });
  await writeFile(path.join(library, "Inbox/a.html"), await fixture());
  assert.equal((await prepareCatalogForParser(library, "2026-09-07T01:00:00.000Z")).status, "ready");
  const store = await PreparedDraftStore.create(library, ["Inbox/a.html"], { runtimeRoot: testRuntimeRoot(library), workers: 1 });
  try {
    await store.preview(0); await store.finish();
    const parsed = (await store.take("Inbox/a.html"))!;
    const resource = (parsed.draft["resources"] as JsonObject[]).find(row => Array.isArray(row["data_base64"]))!;
    assert.ok(resource, "fixture must exercise acquired resource bytes");
    const chunks = resource["data_base64"] as string[];
    const originalChunk = chunks[0]!;
    chunks[0] = (chunks[0]![0] === "A" ? "B" : "A") + chunks[0]!.slice(1);
    await assert.rejects(commitNewParsedSource({ libraryRoot: library, sourcePath: "Inbox/a.html", parsed, transaction: "x_WORKERPROOFCOMMIT", recoveryTransaction: "x_WORKERPROOFRECOVR", timestamp: "2026-09-07T01:01:00.000Z", recoveryAlreadyCapturedThisBatch: false }), /bytes\/SHA verification/u);
    assert.deepEqual(await readdir(path.join(library, "Conversations")), []);
    chunks[0] = originalChunk;
    (parsed.draft["resources"] as JsonObject[]).push(structuredClone(resource));
    await assert.rejects(commitNewParsedSource({ libraryRoot: library, sourcePath: "Inbox/a.html", parsed, transaction: "x_WORKERDUPLICATEAA", recoveryTransaction: "x_WORKERPROOFRECOVR", timestamp: "2026-09-07T01:01:00.000Z", recoveryAlreadyCapturedThisBatch: false }), /prepared metadata validation/u);
  } finally { await store.dispose(); }
}));

test("cancelling after the first committed file flushes only its Catalog delta and keeps later files unparsed", async () => scope(async root => {
  const library = path.join(root, "Library");
  await createLocalLibrary({ root: library, transaction: "x_BATCHCANCELCREAT", timestamp: "2026-09-07T01:00:00.000Z", localDate: "2026-09-07", offset: "Z", language: "zh-CN" });
  for (const name of ["a", "b"]) await writeFile(path.join(library, `Inbox/${name}.html`), await fixture());
  const plan = await prepareParseBatch({ runtimeRoot: testRuntimeRoot(library), libraryRoot: library, sourcePaths: ["Inbox/a.html", "Inbox/b.html"], operation: "o_BATCHCANCELPLANAA", preservePrevious: false, copyUserStateOnPreserve: true });
  const controller = new AbortController();
  const result = await runPreparedParseBatch({ runtimeRoot: testRuntimeRoot(library), libraryRoot: library, plan, operation: "o_BATCHCANCELRUNAAA", transactionTokens: ["x_BATCHCANCELONEAA", "x_BATCHCANCELTWOAA"], recoveryTransaction: "x_BATCHCANCELRECOV", timestamp: "2026-09-07T01:01:00.000Z", copyUserStateOnPreserve: true, signal: controller.signal,
    onEvent: event => { if (event["phase"] === "verify" && (event["file"] as JsonObject)?.["index"] === 1) controller.abort(); }
  });
  assert.equal(result.items[0]?.status, "created");
  assert.equal(result.items[1]?.status, "cancelled");
  assert.equal((await readdir(path.join(library, "Conversations"))).length, 1);
  const catalog = (await readCatalogCache(library))!;
  const rows = catalog["sources"] as JsonObject[];
  assert.equal(rows.find(row => row["path"] === "Inbox/a.html")?.["status"], "complete");
  assert.equal(rows.find(row => row["path"] === "Inbox/b.html")?.["status"], "pending");
  assert.deepEqual(await readdir(path.join(testRuntimeRoot(library), "ParserDrafts")), []);
}));

test("prepared plain-text archives keep an absent resources field absent and retain the exact content hash", async () => scope(async root => {
  const library = path.join(root, "Library");
  await createLocalLibrary({ root: library, transaction: "x_PLAINPROOFLIBAAA", timestamp: "2026-09-07T01:00:00.000Z", localDate: "2026-09-07", offset: "Z", language: "zh-CN" });
  const source = path.join(library, "Inbox/plain.html"); await writeFile(source, await fixture());
  await prepareCatalogForParser(library, "2026-09-07T01:00:00.000Z");
  const original = await parseExporterHtmlToDraft({ filePath: source });
  const draft = structuredClone(original.draft);
  for (const message of draft["messages"] as JsonObject[]) message["content"] = [{ type: "markdown", text: "Only text, no resources." }];
  delete draft["resources"];
  const result = await commitNewParsedSource({ libraryRoot: library, sourcePath: "Inbox/plain.html", parsed: { ...original, draft, verifiedResources: {} }, transaction: "x_PLAINPROOFCOMMIT", recoveryTransaction: "x_PLAINPROOFRECOVR", timestamp: "2026-09-07T01:01:00.000Z", recoveryAlreadyCapturedThisBatch: false });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  const archived = JSON.parse(await readFile(path.join(library, ...result.path.split("/")), "utf8"));
  assert.equal(Object.hasOwn(archived, "resources"), false);
  assert.equal(validateConversation(archived).ok, true);
}));
