import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  serializeCatalogCache,
  serializeOperation,
  serializeSystemLog,
  serializeTransaction,
  validateCatalogCache,
  validateOperation,
  validateSystemLog,
  validateTransaction
} from "../../../src/core/contracts/index.mts";
import type { JsonObject, JsonValue, ValidationResult } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

async function fixture(name: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
  assert.equal(isJsonObject(value), true);
  return value as JsonObject;
}

function issueCodes(result: ValidationResult<JsonObject>): string[] {
  return result.ok ? [] : result.issues.map((entry) => entry.code);
}

function reverseObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

test("Operation events carry sparse progress without source names or fake totals", async () => {
  for (const name of ["operation-progress.json", "operation-completed.json", "operation-failed.json"]) {
    const value = await fixture(name);
    assert.equal(validateOperation(value).ok, true, name);
    assert.equal(validateOperation(JSON.parse(serializeOperation(value))).ok, true, name);
  }
  const privateField = await fixture("operation-progress.json");
  privateField["filename"] = "chat.html";
  assert.ok(issueCodes(validateOperation(privateField)).includes("CLOUDIG_SCHEMA_INVALID"));
});

test("Operation counters reject overflow, incomplete final totals, and fake capacity failures", async () => {
  const overflow = await fixture("operation-progress.json");
  const bytes = overflow["bytes"];
  assert.ok(isJsonObject(bytes));
  bytes["completed"] = 1001;
  assert.ok(issueCodes(validateOperation(overflow)).includes("CLOUDIG_OPERATION_PROGRESS_OVERFLOW"));

  const incomplete = await fixture("operation-completed.json");
  const files = incomplete["file"];
  assert.ok(isJsonObject(files));
  files["completed"] = 2;
  assert.ok(issueCodes(validateOperation(incomplete)).includes("CLOUDIG_OPERATION_FINAL_PROGRESS_INCOMPLETE"));

  const fakeCapacity = await fixture("operation-failed.json");
  const error = fakeCapacity["error"];
  assert.ok(isJsonObject(error) && isJsonObject(error["capacity"]));
  error["capacity"]["observed"] = 1048576;
  assert.ok(issueCodes(validateOperation(fakeCapacity)).includes("CLOUDIG_OPERATION_CAPACITY_NOT_EXCEEDED"));
});

test("planned and committed journals validate exact ownership and fingerprints", async () => {
  for (const name of ["transaction-planned.json", "transaction-committed.json"]) {
    const value = await fixture(name);
    assert.equal(validateTransaction(value).ok, true, name);
    assert.equal(validateTransaction(JSON.parse(serializeTransaction(value))).ok, true, name);
  }
  const withSpool = await fixture("transaction-planned.json");
  withSpool["spools"] = [{
    resource: "r1",
    path: `Data/Transactions/${String(withSpool["transaction"])}/resources/000000.bin`,
    status: "written",
    expected: { bytes: 3, sha256: "6".repeat(64) },
    observed: { bytes: 3, sha256: "6".repeat(64) }
  }];
  assert.equal(validateTransaction(withSpool).ok, true);
  assert.equal(validateTransaction(JSON.parse(serializeTransaction(withSpool))).ok, true);

  const markdown = await fixture("transaction-planned.json");
  markdown["intent"] = "export-markdown";
  const markdownTarget = (markdown["targets"] as JsonObject[])[0]!;
  markdownTarget["path"] = "Exports/conversation.md";
  markdownTarget["semantic"] = { kind: "markdown_export" };
  assert.equal(validateTransaction(markdown).ok, true);
});

test("recovery journals distinguish unusable authority from exact target fingerprints", async () => {
  const recovery = await fixture("transaction-planned.json");
  recovery["authority"] = {
    library: { state: "unusable", bytes: 17, sha256: "5".repeat(64) },
    time: { state: "missing" }
  };
  assert.equal(validateTransaction(recovery).ok, true);

  const targets = recovery["targets"];
  assert.ok(Array.isArray(targets) && isJsonObject(targets[0]));
  targets[0]["expected_before"] = { state: "unusable", bytes: 17, sha256: "5".repeat(64) };
  assert.ok(issueCodes(validateTransaction(recovery)).includes("CLOUDIG_SCHEMA_INVALID"));
});

test("transaction journals reject foreign staging, mismatched installs, and duplicate targets", async () => {
  const foreign = await fixture("transaction-committed.json");
  const foreignTargets = foreign["targets"];
  assert.ok(Array.isArray(foreignTargets) && isJsonObject(foreignTargets[0]));
  foreignTargets[0]["temp"] = "Data/Transactions/x_BBBBBBBBBBBBBBBB/staged/chat.json";
  assert.ok(issueCodes(validateTransaction(foreign)).includes("CLOUDIG_TRANSACTION_OWNERSHIP_INVALID"));

  const mismatch = await fixture("transaction-committed.json");
  const mismatchTargets = mismatch["targets"];
  assert.ok(Array.isArray(mismatchTargets) && isJsonObject(mismatchTargets[0]) && isJsonObject(mismatchTargets[0]["installed"]));
  mismatchTargets[0]["installed"]["bytes"] = 3073;
  assert.ok(issueCodes(validateTransaction(mismatch)).includes("CLOUDIG_TRANSACTION_INSTALL_MISMATCH"));

  const duplicate = await fixture("transaction-planned.json");
  const duplicateTargets = duplicate["targets"];
  assert.ok(Array.isArray(duplicateTargets) && isJsonObject(duplicateTargets[0]));
  duplicateTargets.push(structuredClone(duplicateTargets[0]));
  assert.ok(issueCodes(validateTransaction(duplicate)).includes("CLOUDIG_TRANSACTION_TARGET_DUPLICATE"));

  const foreignSpool = await fixture("transaction-planned.json");
  foreignSpool["spools"] = [{
    resource: "r1",
    path: "Data/Transactions/x_BBBBBBBBBBBBBBBB/resources/000000.bin",
    status: "planned",
    expected: { bytes: 3, sha256: "6".repeat(64) }
  }];
  assert.ok(issueCodes(validateTransaction(foreignSpool)).includes("CLOUDIG_TRANSACTION_OWNERSHIP_INVALID"));

  const mismatchedSpool = await fixture("transaction-planned.json");
  mismatchedSpool["spools"] = [{
    resource: "r1",
    path: `Data/Transactions/${String(mismatchedSpool["transaction"])}/resources/000000.bin`,
    status: "written",
    expected: { bytes: 3, sha256: "6".repeat(64) },
    observed: { bytes: 4, sha256: "7".repeat(64) }
  }];
  assert.ok(issueCodes(validateTransaction(mismatchedSpool)).includes("CLOUDIG_TRANSACTION_SPOOL_FINGERPRINT_MISMATCH"));
});

test("Catalog is a rebuildable projection whose outputs must match observed archives", async () => {
  const catalog = await fixture("catalog-full.json");
  assert.equal(validateCatalogCache(catalog).ok, true);
  assert.equal(validateCatalogCache(JSON.parse(serializeCatalogCache(catalog))).ok, true);
  assert.equal(validateCatalogCache({
    schema: "cloudig/catalog-cache/1.0.0",
    built_at: "2026-08-31T12:00:00.000Z",
    adapter_bundle_sha256: "1".repeat(64),
    sources: [],
    archives: []
  }).ok, true);

  const mismatch = structuredClone(catalog);
  const sources = mismatch["sources"];
  assert.ok(Array.isArray(sources) && isJsonObject(sources[0]) && Array.isArray(sources[0]["outputs"]) && isJsonObject(sources[0]["outputs"][0]));
  sources[0]["outputs"][0]["generation"] = 2;
  assert.ok(issueCodes(validateCatalogCache(mismatch)).includes("CLOUDIG_CATALOG_OUTPUT_MISMATCH"));
});

test("Catalog rejects duplicate paths and authority fields it must never own", async () => {
  const duplicate = await fixture("catalog-full.json");
  const archives = duplicate["archives"];
  assert.ok(Array.isArray(archives) && isJsonObject(archives[0]));
  archives.push(structuredClone(archives[0]));
  const codes = issueCodes(validateCatalogCache(duplicate));
  assert.ok(codes.includes("CLOUDIG_CATALOG_PATH_DUPLICATE"));

  const userState = await fixture("catalog-full.json");
  userState["user"] = { conversation_name: "不应进入 Catalog" };
  assert.ok(issueCodes(validateCatalogCache(userState)).includes("CLOUDIG_SCHEMA_INVALID"));

  const staleError = await fixture("catalog-full.json");
  const sources = staleError["sources"];
  assert.ok(Array.isArray(sources) && isJsonObject(sources[0]));
  sources[0]["error"] = { code: "old-error", phase: "extract", retry: "immediate" };
  assert.ok(issueCodes(validateCatalogCache(staleError)).includes("CLOUDIG_CATALOG_ERROR_STALE"));
});

test("Catalog preserves duplicate aN rows at different physical paths for explicit read-only conflict handling", async () => {
  const catalog = await fixture("catalog-full.json");
  const archives = catalog["archives"];
  assert.ok(Array.isArray(archives) && isJsonObject(archives[0]));
  const duplicateId = structuredClone(archives[0]);
  duplicateId["path"] = "Conversations/imported/chat-copy.json";
  duplicateId["sha256"] = "4".repeat(64);
  archives.push(duplicateId);
  assert.equal(validateCatalogCache(catalog).ok, true);
});

test("System Log remains a small ordered error index with no hidden I/O state", async () => {
  const full = await fixture("system-log-full.json");
  assert.equal(validateSystemLog(full).ok, true);
  assert.equal(validateSystemLog(JSON.parse(serializeSystemLog(full))).ok, true);
  assert.equal(validateSystemLog({ schema: "cloudig/system-log/1.0.0", files: [] }).ok, true);

  const duplicate = structuredClone(full);
  const files = duplicate["files"];
  assert.ok(Array.isArray(files) && isJsonObject(files[0]));
  files.push(structuredClone(files[0]));
  assert.ok(issueCodes(validateSystemLog(duplicate)).includes("CLOUDIG_SYSTEM_LOG_FILE_DUPLICATE"));

  const stack = structuredClone(full);
  const stackFiles = stack["files"];
  assert.ok(Array.isArray(stackFiles) && isJsonObject(stackFiles[0]) && Array.isArray(stackFiles[0]["errors"]) && isJsonObject(stackFiles[0]["errors"][0]));
  stackFiles[0]["errors"][0]["stack"] = "private stack";
  assert.ok(issueCodes(validateSystemLog(stack)).includes("CLOUDIG_SCHEMA_INVALID"));

  const outside = await fixture("system-log-full.json");
  const outsideFiles = outside["files"];
  assert.ok(Array.isArray(outsideFiles) && isJsonObject(outsideFiles[0]));
  outsideFiles[0]["path"] = "Data/Logs/secret.json";
  assert.ok(issueCodes(validateSystemLog(outside)).includes("CLOUDIG_SYSTEM_LOG_PATH_SCOPE_INVALID"));
});

test("Phase 1C serializers ignore object insertion order and preserve source order arrays", async () => {
  const catalog = await fixture("catalog-full.json");
  assert.equal(serializeCatalogCache(catalog), serializeCatalogCache(reverseObjectKeys(catalog)));
  const reversed = structuredClone(catalog);
  const sources = reversed["sources"];
  assert.ok(Array.isArray(sources) && isJsonObject(sources[0]) && Array.isArray(sources[0]["outputs"]));
  sources[0]["outputs"] = [...sources[0]["outputs"]].reverse();
  assert.equal(serializeCatalogCache(catalog), serializeCatalogCache(reversed));

  const log = await fixture("system-log-full.json");
  const reversedLog = structuredClone(log);
  const files = reversedLog["files"];
  assert.ok(Array.isArray(files) && isJsonObject(files[0]) && Array.isArray(files[0]["errors"]));
  files[0]["errors"] = [...files[0]["errors"]].reverse();
  assert.notEqual(serializeSystemLog(log), serializeSystemLog(reversedLog));
});
