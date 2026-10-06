import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SOURCE_CAPTURE_LIMITS, exporterCapture, fileTimesCapture, validCaptureTime } from "../../../src/core/records/source-time.mts";
import { importRecordPicker, fileCaptureTime, recordImportOriginPath } from "../../../src/adapters/library-data/record-source-import.mts";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
import { scanRecordSources } from "../../../src/adapters/library-data/record-parse-status.mts";
import { extractClaudeRecord, extractHtmlRecord } from "../../../src/app/parser/record-source.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import { validateRecord } from "../../../src/core/records/index.mts";
import { PARSER_VERSION } from "../../../src/app/parser/registry.mts";
import { Readable } from "node:stream";
import { parseStreamingJson } from "../../../src/adapters/parser/json-object-stream.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), now = "2026-09-23T12:00:00.000Z", old = "1980-01-01T00:00:00.000Z";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const obj = (value: unknown) => value as JsonObject;
async function temporary(run: (root: string, runtime: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "capture-time-")); let passed = false;
  await createRecordLibrary(root, { timestamp: now, anchor: { date: "2026-09-23", offset: "Z" } });
  const runtime = await createRuntimeCacheSession(path.join(root, "cache"), root);
  try { await run(root, runtime.root); passed = true; }
  finally { await runtime.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained capture-time test: ${root}`); }
}
async function stage(root: string, runtime: string, filename: string, bytes: Uint8Array, created = now, modified = old) {
  const picker = `p_${randomBytes(32).toString("base64url")}`, folder = path.join(runtime, "Pickers", picker); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "payload.bin"), bytes);
  await writeFile(path.join(folder, "manifest.json"), JSON.stringify({ schema: "cloudig/picker/1.0.0", picker, filename, bytes: bytes.length, sha256: sha(bytes), created_at: created, modified_at: modified }));
  return importRecordPicker(root, runtime, picker);
}

test("capture-time policy filters before choosing, including the exact UTC boundary", () => {
  assert.equal(SOURCE_CAPTURE_LIMITS.earliestUtc, "2020-01-01T00:00:00.000Z");
  for (const value of [undefined, null, "", "garbage", old, "2019-12-31T23:59:59.999Z", Infinity, 0]) assert.equal(validCaptureTime(value), undefined);
  assert.equal(validCaptureTime("2020-01-01T08:00:00+08:00"), SOURCE_CAPTURE_LIMITS.earliestUtc);
  assert.deepEqual(fileTimesCapture(now, old), { at: now, from: "filesystem:creation_time" });
  assert.deepEqual(fileTimesCapture(old, now), { at: now, from: "filesystem:last_write_time" });
  assert.deepEqual(fileTimesCapture(now, "2025-01-01T00:00:00Z"), { at: "2025-01-01T00:00:00.000Z", from: "filesystem:last_write_time" });
  assert.deepEqual(fileTimesCapture(now, now), { at: now, from: "filesystem:creation_time" });
  assert.equal(fileTimesCapture(old, "1979-12-31T16:00:00Z"), undefined);
});

test("supported export metadata is validated separately from source message dates", () => {
  assert.deepEqual(exporterCapture({ captured_at: old, exported_at: now }), { at: now, from: "bookmark:manifest.exported_at" });
  assert.deepEqual(exporterCapture({ captured_at: old }, { exported_at: now }), { at: now, from: "bookmark:payload.exported_at" });
  assert.equal(exporterCapture({ created_at: now, updated_at: now }), undefined);
});

test("metadata projection ignores nested dates and large text while retaining root timestamps after message arrays", async () => {
  const value = { messages: Array.from({ length: 100 }, () => ({ captured_at: now, text: '"exported_at": "fake" '.repeat(100) })), captured_at: old, exported_at: now };
  const bytes = Buffer.from(JSON.stringify(value));
  const chunks = Array.from({ length: Math.ceil(bytes.length / 101) }, (_, i) => bytes.subarray(i * 101, (i + 1) * 101));
  const projected = await parseStreamingJson(Readable.from(chunks), undefined, { rootKeys: ["captured_at", "exported_at"], string() { return undefined; } });
  assert.deepEqual(projected, { captured_at: old, exported_at: now });
});

test("new import retains original candidate facts and original mtime but chooses the valid creation date", async () => temporary(async (root, runtime) => {
  const bytes = Buffer.from("[]"), result = await stage(root, runtime, "conversations.json", bytes);
  assert.deepEqual(await fileCaptureTime(path.join(root, result.path), sha(bytes)), { at: now, from: "filesystem:creation_time" });
  assert.equal((await lstat(path.join(root, result.path))).mtime.toISOString(), old);
  const raw = JSON.parse(await readFile(path.join(root, recordImportOriginPath(result.path)), "utf8"));
  assert.deepEqual(raw.file_times, { created_at: now, modified_at: old });
  const rows = await scanRecordSources(root); assert.equal(rows[0]!.captured?.at, now);
  const cache = await readFile(path.join(root, "appdata/indexes/sources.json")); await scanRecordSources(root);
  assert.deepEqual(await readFile(path.join(root, "appdata/indexes/sources.json")), cache, "warm scans do not rewrite or reinterpret the capture fact");
}));

test("invalid original facts fall back to the current file without rewriting import provenance", async () => temporary(async (root, runtime) => {
  const bytes = Buffer.from("[]"), result = await stage(root, runtime, "conversations.json", bytes, old, old);
  const file = path.join(root, result.path), creation = new Date((await lstat(file)).birthtimeMs).toISOString();
  const expected = { at: creation, from: "filesystem:creation_time" };
  assert.deepEqual(await fileCaptureTime(file, sha(bytes)), expected);
  const origin = path.join(root, recordImportOriginPath(result.path));
  await writeFile(origin, JSON.stringify({ schema: "cloudig/source-import/1.0.0", path: result.path, sha256: sha(bytes), captured: { at: old, from: "filesystem:last_write_time" } }));
  assert.deepEqual(await fileCaptureTime(file, sha(bytes)), expected);
  assert.deepEqual((await scanRecordSources(root))[0]!.captured, expected);
  assert.equal(JSON.parse(await readFile(origin, "utf8")).captured.at, old, "reading does not rewrite old provenance");
  const writeTime = "2021-02-03T04:05:06.000Z"; await utimes(file, new Date(writeTime), new Date(writeTime));
  assert.deepEqual(await fileCaptureTime(file, sha(bytes)), { at: writeTime, from: "filesystem:last_write_time" }, "fallback still selects the earlier valid filesystem field");
  await writeFile(path.join(root, result.path), "[ ]");
  assert.equal((await fileCaptureTime(path.join(root, result.path), sha(Buffer.from("[ ]"))))?.from, "filesystem:creation_time", "different source bytes invalidate old origin facts");
}));

test("a cached 1.2 unknown from a legacy import is corrected on refresh, then stays stable", async () => temporary(async (root, runtime) => {
  const bytes = Buffer.from("[]"), result = await stage(root, runtime, "conversations.json", bytes);
  const origin = path.join(root, recordImportOriginPath(result.path));
  const legacy = JSON.stringify({ schema: "cloudig/source-import/1.0.0", path: result.path, sha256: sha(bytes), captured: { at: old, from: "filesystem:last_write_time" } });
  await writeFile(origin, legacy);
  const first = await scanRecordSources(root), indexFile = path.join(root, "appdata/indexes/sources.json");
  const index = JSON.parse(await readFile(indexFile, "utf8")); index.schema = "cloudig/source-index/1.2.0"; delete index.files[result.path].captured;
  await writeFile(indexFile, JSON.stringify(index));
  const rows = await scanRecordSources(root), expected = { at: new Date((await lstat(path.join(root, result.path))).birthtimeMs).toISOString(), from: "filesystem:creation_time" };
  assert.deepEqual(rows[0]!.captured, expected);
  assert.equal(rows[0]!.sha256, first[0]!.sha256); assert.equal(rows[0]!.stamp, first[0]!.stamp);
  assert.equal(await readFile(origin, "utf8"), legacy); assert.deepEqual(await readFile(path.join(root, result.path)), bytes);
  const refreshed = await readFile(indexFile); await scanRecordSources(root); assert.deepEqual(await readFile(indexFile), refreshed);
}));

test("direct Inbox sources and legacy source-index upgrade reject 1980 without reusing a stale date", async () => temporary(async root => {
  const file = path.join(root, "Inbox/direct.json"); await writeFile(file, "[]"); await utimes(file, new Date(old), new Date(old));
  const capture = await fileCaptureTime(file), creation = new Date((await lstat(file)).birthtimeMs).toISOString();
  assert.deepEqual(capture, { at: creation, from: "filesystem:creation_time" });
  const first = await scanRecordSources(root), indexFile = path.join(root, "appdata/indexes/sources.json");
  const index = JSON.parse(await readFile(indexFile, "utf8")); index.schema = "cloudig/source-index/1.1.0"; delete index.files["Inbox/direct.json"].captured; await writeFile(indexFile, JSON.stringify(index));
  const upgraded = await scanRecordSources(root); assert.deepEqual(upgraded[0]!.captured, capture); assert.equal(upgraded[0]!.sha256, first[0]!.sha256);
}));

test("HTML export time wins; invalid export and import times fall back to the existing file", async () => temporary(async (root, runtime) => {
  const fixture = await readFile("tests/fixtures/chatgpt-light-items-v2.html", "utf8");
  const html = (capture: string, payloadCapture = old) => fixture.replace(/(<script\b[^>]*type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/gu, (_all, start, json, end) => {
    const data = JSON.parse(json); delete data.exported_at; data.captured_at = start.includes("ai-chat-archive-manifest") ? capture : payloadCapture; return start + JSON.stringify(data) + end;
  });
  const valid = await stage(root, runtime, "valid.html", Buffer.from(html("2025-05-05T10:00:00Z")));
  const parsed = await extractHtmlRecord({ filePath: path.join(root, valid.path), temporaryRoot: path.join(root, "cache") });
  assert.deepEqual(parsed.facts.captured, { at: "2025-05-05T10:00:00.000Z", from: "bookmark:manifest.captured_at" });
  const payloadOnly = await stage(root, runtime, "payload-only.html", Buffer.from(html(old, "2025-06-06T00:00:00Z")));
  const payloadResult = await extractHtmlRecord({ filePath: path.join(root, payloadOnly.path), temporaryRoot: path.join(root, "cache") });
  assert.deepEqual(payloadResult.facts.captured, { at: "2025-06-06T00:00:00.000Z", from: "bookmark:payload.captured_at" });
  const invalid = await stage(root, runtime, "invalid.html", Buffer.from(html(old)));
  assert.deepEqual((await extractHtmlRecord({ filePath: path.join(root, invalid.path), temporaryRoot: path.join(root, "cache") })).facts.captured, { at: now, from: "filesystem:creation_time" });
  const unknown = await stage(root, runtime, "unknown.html", Buffer.from(html(old)), old, old);
  const result = await extractHtmlRecord({ filePath: path.join(root, unknown.path), temporaryRoot: path.join(root, "cache") });
  const fallback = { at: new Date((await lstat(path.join(root, unknown.path))).birthtimeMs).toISOString(), from: "filesystem:creation_time" };
  assert.deepEqual(result.facts.captured, fallback);
  const record = assembleConversationRecord({ ...result, parserVersion: PARSER_VERSION, timestamp: now });
  assert.equal(obj(record["source"])["captured_at"], fallback.at); assert.equal(obj(record["source"])["captured_from"], fallback.from); assert.equal(validateRecord("conversation", record).ok, true);
  const rows = await scanRecordSources(root);
  assert.deepEqual(rows.find(row => row.path === payloadOnly.path)?.captured, payloadResult.facts.captured, "list and Parser use the same payload witness");
  assert.deepEqual(rows.find(row => row.path === valid.path)?.captured, parsed.facts.captured);
  assert.deepEqual(rows.find(row => row.path === unknown.path)?.captured, fallback);
}));

test("Claude unknown capture preserves original conversation and message dates, including pre-2020 dates", () => {
  const raw = { uuid: "original-conversation", name: "Test", created_at: "2010-01-01T00:00:00Z", updated_at: now,
    chat_messages: [{ uuid: "message", sender: "human", text: "Original", created_at: "2010-01-01T00:00:00Z" }] };
  const extracted = extractClaudeRecord({ record: raw, source: { file: "conversations.json", bytes: 2, sha256: "a".repeat(64) } });
  const record = assembleConversationRecord({ ...extracted, parserVersion: PARSER_VERSION, timestamp: now }), source = obj(record["source"]);
  assert.equal(source["captured_at"], undefined); assert.equal(source["conversation_created_at"], "2010-01-01T00:00:00.000Z");
  assert.equal(obj((obj(record["messages"])["items"] as JsonObject[])[0])["timestamp"], "2010-01-01T00:00:00.000Z");
  assert.equal(validateRecord("conversation", record).ok, true);
});
