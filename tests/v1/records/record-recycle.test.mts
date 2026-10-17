import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rename, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { commitRecords, readStoredRecord } from "../../../src/adapters/storage/record-store.mts";
import { RecordReaderEngineCommands } from "../../../src/engine/record-reader-commands.mts";
import { RecordLibraryEngineCommands } from "../../../src/engine/record-library-commands.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { encodeRecord } from "../../../src/core/records/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T18:00:00Z";
const builtins = { user: { name: "User", avatar: "app/u.svg" }, assistant: { name: "AI", avatar: "app/a.svg" }, platforms: {} }, obj = (v: unknown) => v as JsonObject;
const ctx = () => ({ request: "q_recycle", signal: new AbortController().signal, emit: async () => undefined });
const reader = (root: string) => new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, "cache"), builtins, clock: () => timestamp });
const call = (commands: RecordReaderEngineCommands) => async (name: string, payload: JsonObject = {}): Promise<JsonObject> => { const result = await commands.handlers()[name]!(payload, ctx()); assertIpcValue(result); return obj(result); };
async function temporary(run: (root: string, commands: RecordReaderEngineCommands, markFile: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-recycle-")), commands = reader(root); let passed = false;
  try {
    await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } });
    const c = obj(JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8"))), mark: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: c["conversation_id"]!, edited_at: timestamp, conversation_title: "User edit" };
    const markFile = `Marks/${mark["mark_id"]}.json`; await writeFile(path.join(root, "Conversations/a.json"), encodeRecord("conversation", c)); await writeFile(path.join(root, markFile), encodeRecord("mark", mark));
    await writeFile(path.join(root, "Inbox/original.html"), "source stays"); await mkdir(path.join(root, "FakeRecycle")); await run(root, commands, markFile); passed = true;
  } finally { await commands.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained recycle test: ${root}`); }
}
async function selected(request: ReturnType<typeof call>) { return (await request("reader.archives.query", { offset: 0, limit: 100 }))["items"] as JsonObject[]; }
async function pretendNativeRecycle(root: string, file: JsonObject) { const relative = String(file["path"]); await rename(path.join(root, relative), path.join(root, "FakeRecycle", path.basename(relative))); }

test("uppercase Conversation extensions retain the same exact recycle scope and Mark pairing", async () => temporary(async (root, commands, markFile) => {
  await rename(path.join(root, "Conversations/a.json"), path.join(root, "Conversations/External.JSON"));
  const request = call(commands), row = (await selected(request))[0]!;
  const plan = await request("reader.archive.recycle.plan", { archive: row["capability"]! });
  assert.deepEqual((plan["files"] as JsonObject[]).map(f => f["path"]), ["Conversations/External.JSON", markFile]);
  await request("reader.archive.recycle.begin", { plan: plan["plan"]! });
  for (const file of plan["files"] as JsonObject[]) await pretendNativeRecycle(root, file);
  assert.equal((await request("reader.archive.recycle.complete", { plan: plan["plan"]! }))["status"], "recycled");
  assert.deepEqual(await selected(request), []);
  assert.equal(await readFile(path.join(root, "Inbox/original.html"), "utf8"), "source stays");
}));

test("recycle plans list the exact Conversation and Mark, hold the writer boundary, and retire only the tiny intent on completion", async () => temporary(async (root, commands, markFile) => {
  const request = call(commands), row = (await selected(request))[0]!; assert.equal(row["mark_file"], path.basename(markFile));
  const library = await readStoredRecord(root, "library", "CloudigLibrary.json"), source = await readFile(path.join(root, "Inbox/original.html")), plan = await request("reader.archive.recycle.plan", { archive: row["capability"]! });
  assert.equal(await commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", value: library.value, expected: library.sha256 }]), null, "delivering a plan does not strand a writer lock");
  await request("reader.archive.recycle.begin", { plan: plan["plan"]! });
  const files = plan["files"] as JsonObject[]; assert.deepEqual(files.map(f => f["path"]), ["Conversations/a.json", markFile]);
  const saved = await readFile(path.join(root, "appdata/recycle", `${plan["operation"]}.json`)); assert(saved.length < 2048); assert(!saved.includes(Buffer.from("User edit")));
  await assert.rejects(commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", value: library.value, expected: library.sha256 }]));
  for (const file of files) await pretendNativeRecycle(root, file);
  assert.equal((await request("reader.archive.recycle.complete", { plan: plan["plan"]! }))["status"], "recycled");
  assert.deepEqual(await readdir(path.join(root, "appdata/recycle")), []); assert.deepEqual(await readdir(path.join(root, "Marks")), []); assert.deepEqual(await selected(request), []);
  assert.deepEqual(await readFile(path.join(root, "Inbox/original.html")), source); assert.equal((await readStoredRecord(root, "library", "CloudigLibrary.json")).sha256, library.sha256);
}));

test("cancel before native deletion keeps both originals and clears the intent without claiming a deletion", async () => temporary(async (root, commands, markFile) => {
  const request = call(commands), before = await readFile(path.join(root, markFile)), plan = await request("reader.archive.recycle.plan", { archive: (await selected(request))[0]!["capability"]! });
  assert.equal((await request("reader.archive.recycle.release", { plan: plan["plan"]! }))["status"], "cancelled");
  assert.equal((await request("reader.archive.recycle.release", { plan: plan["plan"]! }))["status"], "released");
  assert.deepEqual(await readFile(path.join(root, markFile)), before); assert.equal((await selected(request)).length, 1); assert.deepEqual(await readdir(path.join(root, "appdata/recycle")), []);
}));

test("cancelling plan preparation releases its writer and creates no pending delete", async () => temporary(async (root, commands) => {
  const request = call(commands), archive = (await selected(request))[0]!["capability"]!, cancel = new AbortController();
  const pending = commands.handlers()["reader.archive.recycle.plan"]!({ archive }, { ...ctx(), signal: cancel.signal }); setImmediate(() => cancel.abort(new DOMException("cancel", "AbortError")));
  await assert.rejects(pending, { name: "AbortError" }); assert.deepEqual((await request("reader.archive.recycle.pending"))["items"], []);
  const retry = await request("reader.archive.recycle.plan", { archive }); await request("reader.archive.recycle.release", { plan: retry["plan"]! }); assert.equal((await selected(request)).length, 1);
}));

test("partial native deletion survives Engine shutdown and only explicit resume removes the remaining Mark", async () => temporary(async (root, commands, markFile) => {
  const request = call(commands), plan = await request("reader.archive.recycle.plan", { archive: (await selected(request))[0]!["capability"]! });
  await request("reader.archive.recycle.begin", { plan: plan["plan"]! });
  await pretendNativeRecycle(root, (plan["files"] as JsonObject[])[0]!); await commands.close();
  const after = reader(root), next = call(after);
  try {
    const library = new RecordLibraryEngineCommands(root), startup = obj(await library.handlers()["library.startup.recover"]!({}, ctx())); assert.equal(startup["status"], "valid"); assert.equal((startup["pending_recycles"] as JsonObject[]).length, 1);
    assert((await lstat(path.join(root, markFile))).isFile()); assert.deepEqual(await selected(next), []);
    const resumed = await next("reader.archive.recycle.resume", { operation: plan["operation"]! }); assert.deepEqual((resumed["files"] as JsonObject[]).map(f => f["path"]), [markFile]);
    await next("reader.archive.recycle.begin", { plan: resumed["plan"]! });
    await pretendNativeRecycle(root, (resumed["files"] as JsonObject[])[0]!); await next("reader.archive.recycle.complete", { plan: resumed["plan"]! });
    assert.deepEqual((await next("reader.archive.recycle.pending"))["items"], []);
  } finally { await after.close(); }
}));

test("keeping the remaining files ends a partial deletion without deleting its orphan Mark", async () => temporary(async (root, commands, markFile) => {
  const request = call(commands), plan = await request("reader.archive.recycle.plan", { archive: (await selected(request))[0]!["capability"]! }), original = await readFile(path.join(root, markFile));
  await request("reader.archive.recycle.begin", { plan: plan["plan"]! });
  await pretendNativeRecycle(root, (plan["files"] as JsonObject[])[0]!); assert.equal((await request("reader.archive.recycle.release", { plan: plan["plan"]! }))["status"], "partial");
  await request("reader.archive.recycle.keepRemaining", { operation: plan["operation"]! }); assert.deepEqual(await readFile(path.join(root, markFile)), original); assert.deepEqual((await request("reader.archive.recycle.pending"))["items"], []);
}));

test("stale selections and changed pending Marks are preserved instead of recycling unreviewed edits", async () => temporary(async (root, commands, markFile) => {
  const request = call(commands), row = (await selected(request))[0]!, mark = obj(JSON.parse(await readFile(path.join(root, markFile), "utf8"))); mark["conversation_title"] = "Changed";
  await writeFile(path.join(root, markFile), encodeRecord("mark", mark)); await assert.rejects(request("reader.archive.recycle.plan", { archive: row["capability"]! }), /changed/);
  const plan = await request("reader.archive.recycle.plan", { archive: (await selected(request))[0]!["capability"]! }); await request("reader.archive.recycle.begin", { plan: plan["plan"]! }); await pretendNativeRecycle(root, (plan["files"] as JsonObject[])[0]!); await commands.close();
  mark["conversation_title"] = "Later edit"; await writeFile(path.join(root, markFile), encodeRecord("mark", mark)); const after = reader(root), next = call(after);
  try { await assert.rejects(next("reader.archive.recycle.resume", { operation: plan["operation"]! }), /changed/); await next("reader.archive.recycle.keepRemaining", { operation: plan["operation"]! }); assert.equal(obj(JSON.parse(await readFile(path.join(root, markFile), "utf8")))["conversation_title"], "Later edit"); }
  finally { await after.close(); }
}));

test("all files already gone permits intent finalization, while foreign-scope intents never grant native paths", async () => temporary(async (root, commands) => {
  const request = call(commands), plan = await request("reader.archive.recycle.plan", { archive: (await selected(request))[0]!["capability"]! });
  await request("reader.archive.recycle.begin", { plan: plan["plan"]! });
  for (const file of plan["files"] as JsonObject[]) await pretendNativeRecycle(root, file); await commands.close();
  const after = reader(root), next = call(after);
  try {
    const resumed = await next("reader.archive.recycle.resume", { operation: plan["operation"]! }); assert.deepEqual(resumed["files"], []); await next("reader.archive.recycle.begin", { plan: resumed["plan"]! }); await next("reader.archive.recycle.complete", { plan: resumed["plan"]! });
    const id = uuidV7(), bad = { schema: "cloudig/recycle/1.0.0", operation_id: id, conversation_id: uuidV7(), created_at: timestamp, files: [{ kind: "conversation", path: "Inbox/original.html", bytes: 1, sha256: "0".repeat(64) }] };
    await writeFile(path.join(root, "appdata/recycle", `${id}.json`), JSON.stringify(bad)); assert.equal(((await next("reader.archive.recycle.pending"))["issues"] as JsonObject[]).length, 1);
    await assert.rejects(next("reader.archive.recycle.resume", { operation: id })); assert.equal(await readFile(path.join(root, "Inbox/original.html"), "utf8"), "source stays");
  } finally { await after.close(); }
}));
