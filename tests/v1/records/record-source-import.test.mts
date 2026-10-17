import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { importRecordPicker, readRecordImportCapture, recordImportOriginPath } from "../../../src/adapters/library-data/record-source-import.mts";
import { prepareRecordPicker } from "../../../src/adapters/library-data/record-picker.mts";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
import { commitRecords, pendingRecordOperations, recoverRecords } from "../../../src/adapters/storage/record-store.mts";
import { fileCaptureTime } from "../../../src/app/parser/record-source.mts";
import { officialAssetLeaf, officialAssetDirectory } from "../../../src/adapters/parser/official-json-assets.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T19:00:00Z", capturedAt = "2020-02-03T04:05:06.000Z";
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
async function temporary(run: (root: string, runtime: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "source-import-")); let passed = false;
  await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); const cache = await createRuntimeCacheSession(path.join(root, "cache"), root);
  try { await run(root, cache.root); passed = true; } finally { await cache.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained import test: ${root}`); }
}
async function stage(runtime: string, filename = "capture.html", bytes = Buffer.from("source")) {
  const picker = `p_${randomBytes(32).toString("base64url")}`, dir = path.join(runtime, "Pickers", picker); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "payload.bin"), bytes); await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ schema: "cloudig/picker/1.0.0", picker, filename, bytes: bytes.length, sha256: sha(bytes), captured_at: capturedAt, captured_from: "filesystem:creation_time" })); return { picker, dir, bytes };
}
test("import preserves exact source, no-replace filename and original capture provenance without changing Library", async () => temporary(async (root, runtime) => {
  const library = await readFile(path.join(root, "CloudigLibrary.json")), a = await stage(runtime), first = await importRecordPicker(root, runtime, a.picker), b = await stage(runtime), second = await importRecordPicker(root, runtime, b.picker);
  assert.notEqual(first.path, second.path); assert.equal(first.path, "Inbox/capture.html"); assert.deepEqual(await readFile(path.join(root, first.path)), a.bytes); assert.deepEqual(await readFile(path.join(root, second.path)), b.bytes);
  assert.deepEqual(await fileCaptureTime(path.join(root, first.path), first.fingerprint.sha256), { at: capturedAt, from: "filesystem:creation_time" }); assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), library);
  assert.deepEqual(await readdir(path.join(runtime, "Pickers")), []); assert.equal(first.pickerCleaned, true); assert.equal((await pendingRecordOperations(root)).length, 0);
}));

test("long Unicode source collisions import both exact originals under distinct names", async () => temporary(async (root, runtime) => {
  const filename = "😀".repeat(116) + "xx.html";
  const a = await stage(runtime, filename, Buffer.from("first source")), first = await importRecordPicker(root, runtime, a.picker);
  const b = await stage(runtime, filename, Buffer.from("second source")), second = await importRecordPicker(root, runtime, b.picker);
  assert.notEqual(first.path, second.path); assert(second.filename.endsWith(" (2).html")); assert(second.filename.isWellFormed());
  assert.deepEqual(await readFile(path.join(root, first.path)), a.bytes);
  assert.deepEqual(await readFile(path.join(root, second.path)), b.bytes);
  assert.deepEqual(await fileCaptureTime(path.join(root, second.path), second.fingerprint.sha256), { at: capturedAt, from: "filesystem:creation_time" });
}));
test("incomplete import recovers source and capture fact together; rollback preserves the selected source staging", async () => temporary(async (root, runtime) => {
  const picked = await stage(runtime);
  await assert.rejects(importRecordPicker(root, runtime, picked.picker, { fault: point => { if (point === "installed_0") throw new Error("simulated interruption"); } }));
  const pending = await pendingRecordOperations(root); assert.equal(pending.length, 1); await recoverRecords(root, pending[0]!, "complete");
  assert.deepEqual(await readFile(path.join(root, "Inbox/capture.html")), picked.bytes); assert.deepEqual(await readRecordImportCapture(root, "Inbox/capture.html", sha(picked.bytes)), { at: capturedAt, from: "filesystem:creation_time" });
  const next = await stage(runtime, "rollback.json"); await assert.rejects(importRecordPicker(root, runtime, next.picker, { fault: point => { if (point === "prepared") throw new Error("before installation"); } }));
  await recoverRecords(root, (await pendingRecordOperations(root))[0]!, "rollback"); assert(!await lstat(path.join(root, "Inbox/rollback.json")).catch(() => undefined)); assert.deepEqual(await readFile(path.join(next.dir, "payload.bin")), next.bytes);
}));
test("source import cannot overwrite or delete Inbox originals; stale capture facts never apply to different bytes", async () => temporary(async (root, runtime) => {
  const picked = await stage(runtime), first = await importRecordPicker(root, runtime, picked.picker);
  await assert.rejects(commitRecords(root, [{ action: "import", path: first.path, expected: first.fingerprint.sha256, sha256: first.fingerprint.sha256, bytes: picked.bytes.length, source: () => Readable.from([picked.bytes]) }]));
  await assert.rejects(commitRecords(root, [{ action: "delete", path: first.path, expected: first.fingerprint.sha256 }]));
  await assert.rejects(commitRecords(root, [{ action: "import", path: "Exports/not-source.json", expected: null, sha256: first.fingerprint.sha256, bytes: picked.bytes.length, source: () => Readable.from([picked.bytes]) }]));
  assert.equal(await readRecordImportCapture(root, first.path, "f".repeat(64)), undefined); assert.deepEqual(await readFile(path.join(root, first.path)), picked.bytes);
}));
test("large import streams bounded chunks and completed recovery retains no duplicate source bodies", async () => temporary(async root => {
  const chunk = Buffer.alloc(64 * 1024, 3), count = 256, hash = createHash("sha256"); for (let i = 0; i < count; i++) hash.update(chunk); let sent = 0;
  await commitRecords(root, [{ action: "import", path: "Inbox/large.html", expected: null, sha256: hash.digest("hex"), bytes: chunk.length * count,
    source: () => Readable.from((async function* () { for (let i = 0; i < count; i++) { sent++; yield chunk; } })()) }]);
  assert.equal(sent, count); assert.equal((await lstat(path.join(root, "Inbox/large.html"))).size, chunk.length * count);
  const recovery = path.join(root, "appdata/recovery"); const groups = await readdir(recovery); for (const group of groups) { const after = path.join(recovery, group, "after"); if (await lstat(after).catch(() => undefined)) assert.deepEqual(await readdir(after), []); }
}));

test("ambiguous old capture facts use a real filesystem fallback without rewriting the original claim", async () => temporary(async (root, runtime) => {
  const picked = await stage(runtime), manifest = path.join(picked.dir, "manifest.json");
  const raw = JSON.parse(await readFile(manifest, "utf8")); delete raw.captured_from;
  const before = JSON.stringify(raw); await writeFile(manifest, before);
  assert.equal((await prepareRecordPicker(runtime, picked.picker)).capturedFrom, undefined, "shared picker does not invent provenance");
  await assert.rejects(importRecordPicker(root, runtime, picked.picker), /provenance/u);
  assert.equal(await readFile(manifest, "utf8"), before); assert.deepEqual(await readFile(path.join(picked.dir, "payload.bin")), picked.bytes);
  const fresh = await stage(runtime), imported = await importRecordPicker(root, runtime, fresh.picker);
  const origin = path.join(root, recordImportOriginPath(imported.path)), fact = JSON.parse(await readFile(origin, "utf8"));
  delete fact.file_times; fact.captured.from = "filesystem:earliest_creation_or_write"; const legacy = JSON.stringify(fact); await writeFile(origin, legacy);
  const file = await lstat(path.join(root, imported.path));
  const expected = file.birthtimeMs <= file.mtimeMs ? { at: new Date(file.birthtimeMs).toISOString(), from: "filesystem:creation_time" } : { at: new Date(file.mtimeMs).toISOString(), from: "filesystem:last_write_time" };
  assert.deepEqual(await fileCaptureTime(path.join(root, imported.path), imported.fingerprint.sha256), expected, "fallback records the filesystem field actually used, not an invented original field");
  assert.equal(await readFile(origin, "utf8"), legacy);
}));

test("official source and companion bytes import and recover together without replacing a same-name bundle", async () => temporary(async (root, runtime) => {
  const asset = Buffer.from('attachment\n'), key = 'notes.txt', leaf = officialAssetLeaf('mistral', key);
  const bundle = async () => {
    const selected = await stage(runtime, 'native.json', Buffer.from('[]'));
    await writeFile(path.join(selected.dir, leaf), asset);
    await writeFile(path.join(selected.dir, 'assets.json'), JSON.stringify({ schema: 'cloudig/picker-assets/1.0.0', platform: 'mistral', source_sha256: sha(selected.bytes), items: [{ key, leaf, bytes: asset.length, sha256: sha(asset) }] }));
    return selected;
  };
  const first = await bundle(), imported = await importRecordPicker(root, runtime, first.picker);
  assert.equal(imported.pickerCleaned, true); assert.deepEqual(await readFile(path.join(root, officialAssetDirectory(imported.path), leaf)), asset);
  const second = await bundle();
  await assert.rejects(importRecordPicker(root, runtime, second.picker, { fault: point => { if (point === 'installed_0') throw new Error('interrupted bundle'); } }));
  const operation = (await pendingRecordOperations(root))[0]!; await recoverRecords(root, operation, 'complete');
  assert.deepEqual(await readFile(path.join(root, 'Inbox/native (2).json.assets', leaf)), asset);
  assert.deepEqual(await readFile(path.join(root, officialAssetDirectory(imported.path), leaf)), asset);
  const third = await bundle(); await writeFile(path.join(third.dir, leaf), 'changed');
  await assert.rejects(importRecordPicker(root, runtime, third.picker), /Companion bytes changed/);
  await assert.rejects(commitRecords(root, [{ action: 'import', path: 'Inbox/arbitrary/secret.bin', expected: null, sha256: sha(asset), bytes: asset.length, source: () => Readable.from([asset]) }]));
}));
