import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile, lstat, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { commitRecords, pendingRecordOperations, readStoredRecord, recoverRecords, resolveRecordPath, withRecordSnapshot } from "../../../src/adapters/storage/record-store.mts";
import { acquireSingleWriter } from "../../../src/adapters/storage/writer-lock.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { createLibraryRecords } from "../../../src/app/library/record-defaults.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const testBase = fileURLToPath(new URL("../../private/schema-rebuild/", import.meta.url));
const input = { timestamp: "2026-09-11T12:00:00Z", anchor: { date: "2026-09-11", offset: "Z" } };
const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const obj = (v: unknown): JsonObject => v as JsonObject;

async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  await mkdir(testBase, { recursive: true });
  const root = await mkdtemp(path.join(testBase, "records-")); let passed = false;
  try { await run(root); passed = true; }
  finally {
    if (passed) {
      const resolved = await realpath(root), base = await realpath(testBase);
      assert.equal(path.dirname(resolved), base); assert.equal((await lstat(root)).isSymbolicLink(), false);
      await rm(root, { recursive: true, force: false });
    } else console.error(`Retained failed isolated test: ${root}`);
  }
}

test("fresh Library creates 34 independent records and preserves preset IDs across libraries", async () => temporary(async root => {
  const records = await createRecordLibrary(root, input);
  assert.equal(records.length, 34);
  assert.equal(records.filter(r => r.kind === "contentTime").length, 17);
  assert.equal(records.filter(r => r.kind === "identity").length, 14);
  for (const r of records) assert.deepEqual((await readStoredRecord(root, r.kind, r.path)).value, r.value);
  const names = await readdir(root); assert(!names.includes("Data")); assert(!names.includes("Cloudig")); assert(names.includes("CloudigLibrary.json"));
  const before = await readFile(path.join(root, "CloudigLibrary.json"));
  await assert.rejects(createRecordLibrary(root, input)); assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), before);
  const timeNode = records.find(r => r.kind === "contentTime" && r.value["name"] === "现代社会")!;
  assert(timeNode.value["node_id"]); assert(!("owner" in timeNode.value));
  const later = createLibraryRecords({ timestamp: "2026-09-12T12:00:00Z", anchor: { date: "2026-09-12", offset: "Z" } });
  assert.deepEqual(later.filter(r => r.kind === "contentTime").map(r => r.value["node_id"]), records.filter(r => r.kind === "contentTime").map(r => r.value["node_id"]));
  assert.notEqual(later.find(r => r.kind === "identity")!.value["front_id"], records.find(r => r.kind === "identity")!.value["front_id"]);
}));

test("unchanged save does not write or produce a recovery group", async () => temporary(async root => {
  await createRecordLibrary(root, input);
  const original = await readStoredRecord(root, "library", "CloudigLibrary.json");
  const before = await lstat(path.join(root, "CloudigLibrary.json"), { bigint: true });
  const groups = await readdir(path.join(root, "appdata/recovery"));
  assert.equal(await commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: original.value, expected: original.sha256 }]), null);
  const after = await lstat(path.join(root, "CloudigLibrary.json"), { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs); assert.deepEqual(await readdir(path.join(root, "appdata/recovery")), groups);
}));

test("partial multi-record save is recoverable and blocks unrelated writes until resolved", async () => temporary(async root => {
  await createRecordLibrary(root, input);
  const before = await readStoredRecord(root, "library", "CloudigLibrary.json"); const changed = structuredClone(before.value);
  obj(changed["settings"])["language"] = "en";
  await assert.rejects(commitRecords(root, [
    { action: "write", path: "CloudigLibrary.json", kind: "library", value: changed, expected: before.sha256 },
    { action: "binary", path: "appdata/example.json", data: Buffer.from("{}"), expected: null }
  ], { fault(point) { if (point === "installed_0") throw new Error("simulated interruption"); } }));
  const ids = await pendingRecordOperations(root); assert.equal(ids.length, 1);
  await assert.rejects(withRecordSnapshot(root, () => readStoredRecord(root, "library", "CloudigLibrary.json")));
  await assert.rejects(commitRecords(root, [{ action: "binary", path: "appdata/other.json", data: Buffer.from("{}"), expected: null }]));
  await recoverRecords(root, ids[0]!, "rollback");
  assert.equal((await readStoredRecord(root, "library", "CloudigLibrary.json")).sha256, before.sha256);
  assert.deepEqual(await pendingRecordOperations(root), []);
  assert.equal((await withRecordSnapshot(root, () => readStoredRecord(root, "library", "CloudigLibrary.json"))).sha256, before.sha256);
}));

test("rollback restores original bytes without whole-file reads of recovery bodies", async t => temporary(async root => {
  await createRecordLibrary(root, input);
  const original = Buffer.alloc(2 * 1024 * 1024, 0x51), target = "appdata/large-original.bin";
  await commitRecords(root, [{ action: "binary", path: target, expected: null, data: original }]);
  await assert.rejects(commitRecords(root, [{ action: "binary", path: target, expected: sha(original), data: Buffer.from("new") }], { fault(point) { if (point === "installed_0") throw new Error("interrupted replacement"); } }));
  const [id] = await pendingRecordOperations(root);
  const originalRead = fsPromises.readFile;
  const guarded = t.mock.method(fsPromises, "readFile", (file: Parameters<typeof fsPromises.readFile>[0], ...args: unknown[]) => {
    if (/[\\/]before[\\/]0\.bin$/u.test(String(file))) throw new Error("Recovery body must stream, not readFile");
    return Reflect.apply(originalRead, fsPromises, [file, ...args]);
  });
  syncBuiltinESMExports();
  try { await recoverRecords(root, id!, "rollback"); }
  finally { guarded.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(await readFile(path.join(root, target)), original);
  assert.deepEqual(await pendingRecordOperations(root), []);
}));

test("recovery can complete a replacement interrupted after displacement", async () => temporary(async root => {
  await createRecordLibrary(root, input);
  const before = await readStoredRecord(root, "library", "CloudigLibrary.json"); const changed = structuredClone(before.value); obj(changed["settings"])["language"] = "en";
  await assert.rejects(commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: changed, expected: before.sha256 }], { fault(point) { if (point === "displaced_0") throw new Error("interrupted"); } }));
  const [id] = await pendingRecordOperations(root); await recoverRecords(root, id!, "complete");
  assert.deepEqual((await readStoredRecord(root, "library", "CloudigLibrary.json")).value, changed);
}));

test("external edits survive rejected completion and rollback", async () => temporary(async root => {
  await createRecordLibrary(root, input);
  const before = await readStoredRecord(root, "library", "CloudigLibrary.json"), changed = structuredClone(before.value); obj(changed["settings"])["language"] = "en";
  await assert.rejects(commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: changed, expected: before.sha256 }], { fault(point) { if (point === "prepared") throw new Error("interrupted"); } }));
  const external = Buffer.from("external user bytes"); await writeFile(path.join(root, "CloudigLibrary.json"), external);
  const [id] = await pendingRecordOperations(root); await assert.rejects(recoverRecords(root, id!, "complete")); await assert.rejects(recoverRecords(root, id!, "rollback"));
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), external);
}));

test("completed history is bounded to two groups and is not linked to current records", async () => temporary(async root => {
  await createRecordLibrary(root, input);
  for (let n = 0; n < 5; n++) {
    const before = await readStoredRecord(root, "library", "CloudigLibrary.json"), changed = structuredClone(before.value);
    obj(changed["settings"])["language"] = n % 2 ? "zh-CN" : "en";
    await commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: changed, expected: before.sha256 }]);
    assert((await readdir(path.join(root, "appdata/recovery"))).length <= 2);
  }
  const group = (await readdir(path.join(root, "appdata/recovery"))).at(-1)!;
  const backup = path.join(root, "appdata/recovery", group, "before/0.bin"), saved = await readFile(backup);
  await writeFile(path.join(root, "CloudigLibrary.json"), "edited externally"); assert.deepEqual(await readFile(backup), saved);
}));

test("corrupt retired history is preserved without blocking new saves or valid-history rotation", async () => temporary(async root => {
  await createRecordLibrary(root, input);
  const historyRoot = path.join(root, "appdata/recovery"), [oldId] = await readdir(historyRoot);
  const journal = path.join(historyRoot, oldId!, "journal.json"), broken = "{incomplete old recovery history";
  await writeFile(journal, broken);
  for (let index = 0; index < 4; index++) {
    const current = await readStoredRecord(root, "library", "CloudigLibrary.json");
    obj(current.value["settings"])["language"] = index % 2 ? "zh-CN" : "en";
    const saved = await commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", expected: current.sha256, value: current.value }]);
    assert(saved); assert(saved.maintenanceWarnings.some(w => w.includes(oldId!)));
    assert.equal((obj((await readStoredRecord(root, "library", "CloudigLibrary.json")).value["settings"]))["language"], index % 2 ? "zh-CN" : "en");
    assert.equal(await readFile(journal, "utf8"), broken);
  }
  assert.equal((await readdir(historyRoot)).filter(id => id !== oldId).length, 2);
  assert.deepEqual(await pendingRecordOperations(root), []);
}));

test("normal writes and recovery share the same cross-process exclusion", async () => temporary(async root => {
  await createRecordLibrary(root, input); const lock = await acquireSingleWriter(root);
  try {
    await assert.rejects(commitRecords(root, [{ action: "binary", path: "appdata/test.json", data: Buffer.from("{}"), expected: null }]));
    await assert.rejects(recoverRecords(root, uuidV7(), "rollback"));
  } finally { await lock.release(); }
}));

test("read dependencies and target paths are enforced before any write", async () => temporary(async root => {
  await createRecordLibrary(root, input); const original = await readFile(path.join(root, "CloudigLibrary.json"));
  await assert.rejects(commitRecords(root, [{ action: "binary", path: "appdata/test.json", data: Buffer.from("{}"), expected: null }], { reads: [{ path: "CloudigLibrary.json", expected: "0".repeat(64) }] }));
  for (const p of ["../outside", "Conversations/../evil", "Conversations/CON.json", "Conversations/a:stream", "Conversations/a\\b", "Conversations/a."]) await assert.rejects(resolveRecordPath(root, p));
  await assert.rejects(commitRecords(root, [{ action: "binary", path: "CloudigLibrary.json", data: Buffer.from("bad"), expected: sha(original) }]));
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), original);
}));

test("cancellation during staging can discard the attempt without requiring unstaged backups", async () => temporary(async root => {
  await createRecordLibrary(root, input); const old = await readStoredRecord(root, "library", "CloudigLibrary.json");
  const changed = structuredClone(old.value); obj(changed["settings"])["language"] = "en"; const abort = new AbortController();
  await assert.rejects(commitRecords(root, [
    { action: "write", path: "CloudigLibrary.json", kind: "library", value: changed, expected: old.sha256 },
    { action: "binary", path: "appdata/not-yet.json", data: Buffer.from("{}"), expected: null }
  ], { signal: abort.signal, fault(point) { if (point === "staged_0") abort.abort(); } }), { name: "AbortError" });
  const [id] = await pendingRecordOperations(root); await recoverRecords(root, id!, "rollback");
  assert.equal((await readStoredRecord(root, "library", "CloudigLibrary.json")).sha256, old.sha256); assert.deepEqual(await pendingRecordOperations(root), []);
}));

test("a real process exit releases the writer and preserves the displaced original", async () => temporary(async root => {
  await createRecordLibrary(root, input); const old = await readStoredRecord(root, "library", "CloudigLibrary.json");
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./store-crash-child.mts", import.meta.url)), root], { windowsHide: true, stdio: "pipe" });
    let errors = ""; child.stderr.on("data", chunk => { errors += String(chunk); }); child.on("error", reject); child.on("exit", result => result === 19 ? resolve(result) : reject(new Error(errors || `Unexpected exit ${result}`)));
  });
  assert.equal(code, 19); const [id] = await pendingRecordOperations(root); await recoverRecords(root, id!, "rollback");
  assert.equal((await readStoredRecord(root, "library", "CloudigLibrary.json")).sha256, old.sha256);
}));

test("completed cleanup preserves later external changes to the installed file", async () => temporary(async root => {
  await createRecordLibrary(root, input); const old = await readStoredRecord(root, "library", "CloudigLibrary.json"); obj(old.value["settings"])["language"] = "en";
  await assert.rejects(commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: old.value, expected: old.sha256 }], { fault(point) { if (point === "completed") throw new Error("crash before cleanup"); } }));
  const external = Buffer.from("external later update"); await writeFile(path.join(root, "CloudigLibrary.json"), external);
  const [id] = await pendingRecordOperations(root); await recoverRecords(root, id!, "complete"); assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), external);
}));

test("deleting cache does not change records, defaults or node IDs", async () => temporary(async root => {
  const records = await createRecordLibrary(root, input);
  await mkdir(path.join(root, "cache/preview")); await writeFile(path.join(root, "cache/preview/file"), "disposable");
  const cache = await realpath(path.join(root, "cache")); assert.equal(path.dirname(cache), await realpath(root));
  await rm(cache, { recursive: true, force: false });
  for (const record of records) assert.deepEqual((await readStoredRecord(root, record.kind, record.path)).value, record.value);
}));

test("directory junctions cannot redirect record writes outside the Library", async () => temporary(async root => {
  const library = path.join(root, "Library"), outside = path.join(root, "Outside"); await mkdir(outside);
  await createRecordLibrary(library, input); await writeFile(path.join(outside, "sentinel"), "keep");
  await symlink(outside, path.join(library, "Conversations/linked"), "junction");
  await assert.rejects(resolveRecordPath(library, "Conversations/linked/sentinel"));
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "keep");
}));

test("the newest two recovery groups survive even if the system clock moves backwards", async () => temporary(async root => {
  await createRecordLibrary(root, input); const originalNow = Date.now, start = originalNow(); const committed: string[] = [];
  try {
    for (let n = 0; n < 3; n++) {
      Date.now = () => start - n * 3600000;
      const old = await readStoredRecord(root, "library", "CloudigLibrary.json"); obj(old.value["settings"])["language"] = n % 2 ? "zh-CN" : "en";
      const result = await commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: old.value, expected: old.sha256 }]); assert(result); committed.push(result.operationId);
    }
  } finally { Date.now = originalNow; }
  assert.deepEqual((await readdir(path.join(root, "appdata/recovery"))).sort(), committed.slice(-2).sort());
}));
