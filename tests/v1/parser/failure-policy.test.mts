import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createLocalLibrary, importSourceStream, readCatalogCache } from "../../../src/adapters/library-data/index.mts";
import { listSourceQueueFacts } from "../../../src/adapters/library-data/source-query.mts";
import { projectArchiverSources } from "../../../src/app/archiver/source-list.mts";
import { prepareParseBatch, runPreparedParseBatch } from "../../../src/app/parser/batch.mts";
import { isSourceContentError, nextContentFailureAttempts, sourceFailureWatermark } from "../../../src/app/parser/failure-policy.mts";
import { adapterBundleSha256, adapterBundleSnapshot } from "../../../src/app/parser/registry.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { testRuntimeRoot } from "../helpers/runtime-root.mts";

test("only deterministic source errors spend the content retry", () => {
  assert.equal(isSourceContentError(new SyntaxError("Unexpected token in JSON")), true);
  assert.equal(isSourceContentError(new TypeError("Claude export record contains a duplicate message UUID")), true);
  for (const error of [new DOMException("Cancelled", "AbortError"), Object.assign(new Error("Disk full"), { code: "ENOSPC" }), new TypeError("Cannot read properties of undefined"), new TypeError("Internal Catalog invalid"), new RangeError("Array buffer allocation failed")]) {
    assert.equal(isSourceContentError(error), false);
    assert.equal(nextContentFailureAttempts(1, isSourceContentError(error)), 1);
  }
  assert.equal(nextContentFailureAttempts(0, true), 1);
  assert.equal(nextContentFailureAttempts(1, true), 2);
  assert.equal(nextContentFailureAttempts(2, true), 2);
});

test("ordinary HTML retains one retry, cancellation does not spend it, and changed content starts fresh", async () => {
  const temp = path.join(process.cwd(), "tmp");
  await mkdir(temp, { recursive: true });
  const base = await mkdtemp(path.join(temp, "failure-policy-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({ root, transaction: "x_FAILUREPOLICYCREATE", timestamp: "2026-09-09T07:00:00.000Z", localDate: "2026-09-09", offset: "Z", language: "zh-CN" });
    const original = await readFile(new URL("./fixtures/chatgpt-light.html", import.meta.url), "utf8");
    const broken = original.replace(/(<script\b[^>]*id="chatgpt-export-data"[^>]*>)[\s\S]*?(<\/script>)/u, "$1{broken$2");
    assert.notEqual(broken, original);
    const imported = await importSourceStream({ libraryRoot: root, filename: "broken.html", source: Readable.from(broken), transaction: "x_FAILUREPOLICYIMPORT", timestamp: "2026-09-09T07:01:00.000Z" });
    assert.equal(imported.status, "imported");
    if (imported.status !== "imported") return;
    const execute = async (ordinal: number, cancel = false) => {
      const suffix = String.fromCharCode(65 + ordinal);
      const plan = await prepareParseBatch({ libraryRoot: root, runtimeRoot: testRuntimeRoot(root), sourcePaths: [imported.path], preservePrevious: false, copyUserStateOnPreserve: true, operation: `o_FAILUREPOLICYPREPARE${suffix}` });
      assert.equal(plan.items[0]?.contentFailure, true);
      const controller = new AbortController();
      if (cancel) controller.abort();
      return runPreparedParseBatch({ libraryRoot: root, runtimeRoot: testRuntimeRoot(root), plan, operation: `o_FAILUREPOLICYRUN${suffix}`, copyUserStateOnPreserve: true, transactionTokens: [`x_FAILUREPOLICYCOMMIT${suffix}`], recoveryTransaction: `x_FAILUREPOLICYRECOVERY${suffix}`, timestamp: `2026-09-09T07:0${ordinal + 1}:00.000Z`, signal: controller.signal });
    };
    const source = async () => ((await readCatalogCache(root))!["sources"] as JsonObject[])[0]!;
    assert.equal((await execute(1)).items[0]?.status, "failed");
    assert.equal((await source())["status"], "failed");
    assert.equal(((await source())["failure"] as JsonObject)["attempts"], 1);
    assert.equal((await execute(2, true)).state, "cancelled");
    assert.equal(((await source())["failure"] as JsonObject)["attempts"], 1);
    assert.equal((await execute(3)).items[0]?.status, "failed");
    assert.equal((await source())["status"], "unsupported");
    const listed = await listSourceQueueFacts(root);
    const adapters = adapterBundleSnapshot().adapters;
    assert.equal(projectArchiverSources(listed.rows, adapters, false, adapterBundleSha256())[0]?.status, "unsupported");
    const otherPlatform = adapters.map(a => a.id.startsWith("gemini") ? { ...a, version: "9.0.0" } : a);
    assert.equal(projectArchiverSources(listed.rows, otherPlatform, true, "b".repeat(64))[0]?.status, "unsupported");
    const relevant = adapters.map(a => a.routes.some(route => route.platform === "chatgpt") ? { ...a, version: "9.0.0" } : a);
    assert.equal(projectArchiverSources(listed.rows, relevant, true, "c".repeat(64))[0]?.status, "pending");
    assert.notEqual(sourceFailureWatermark({ platform: "chatgpt" }, relevant, "x"), ((await source())["failure"] as JsonObject)["watermark"]);
    await writeFile(path.join(root, imported.path), broken + "\nchanged\n", "utf8");
    await execute(4);
    assert.equal((await source())["status"], "failed");
    assert.equal(((await source())["failure"] as JsonObject)["attempts"], 1);
    assert.equal(JSON.parse(await readFile(path.join(root, "cloudig-library.json"), "utf8")).next_archive, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});
