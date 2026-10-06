import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, readdir, rm, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordCatalog } from "../../../src/adapters/library-data/record-catalog.mts";
import { commitRecords, readStoredRecord, recordFileIdentity, pendingRecordOperations, recoverRecords, withRecordSnapshot } from "../../../src/adapters/storage/record-store.mts";
import { RecordReaderEngineCommands } from "../../../src/engine/record-reader-commands.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { encodeRecord } from "../../../src/core/records/index.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T18:00:00Z";
const obj = (v: unknown) => v as JsonObject, rows = (v: JsonObject, key = "items") => v[key] as JsonObject[];
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const builtins = { user: { name: "User", avatar: "app/user.svg" }, assistant: { name: "AI", avatar: "app/ai.svg" }, platforms: {} };
async function temporary(run: (root: string, engine: RecordReaderEngineCommands) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-files-")); let passed = false;
  const engine = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, "cache"), builtins, clock: () => timestamp });
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root, engine); passed = true; }
  finally { await engine.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained file operation test: ${root}`); }
}
const call = (engine: RecordReaderEngineCommands) => async (name: string, payload: JsonObject): Promise<JsonObject> => { const result = await engine.handlers()[name]!(payload, { request: "q_files", signal: new AbortController().signal, emit: async () => undefined }); assertIpcValue(result); return obj(result); };
const query = (engine: RecordReaderEngineCommands, archived = false) => call(engine)("reader.archives.query", { offset: 0, limit: 200, archived, sort: "title" });
async function fixture(root: string, file = "Conversations/source.json") {
  const value = obj(JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8"))); value["conversation_id"] = uuidV7();
  await mkdir(path.dirname(path.join(root, file)), { recursive: true }); const bytes = Buffer.from(JSON.stringify(value, null, 3) + "\n\n"); await writeFile(path.join(root, file), bytes); return { file, value, bytes };
}
async function output(root: string, value: string) {
  const record = await readStoredRecord(root, "library", "CloudigLibrary.json"); obj(record.value["settings"])["default_output_directory"] = value;
  await commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", value: record.value, expected: record.sha256 }]);
}

test("directory commands preserve the whole tree, follow a default output path and remove only truly empty folders", async () => temporary(async (root, engine) => {
  const request = call(engine); await request("reader.directory.create", { name: "One" }); await mkdir(path.join(root, "Conversations/One/Child"));
  await writeFile(path.join(root, "Conversations/One/Child/user.txt"), "user-owned note"); await output(root, "Conversations/One/Child");
  let list = await query(engine), directory = rows(list, "directories").find(d => d["name"] === "One")!["capability"]!;
  await request("reader.directory.rename", { directory, name: "Renamed" });
  assert.equal(await readFile(path.join(root, "Conversations/Renamed/Child/user.txt"), "utf8"), "user-owned note");
  assert.equal(obj((await readStoredRecord(root, "library", "CloudigLibrary.json")).value["settings"])["default_output_directory"], "Conversations/Renamed/Child");
  list = await query(engine); await assert.rejects(request("reader.directory.delete", { directory }), { code: "CLOUDIG_READER_DIRECTORY_STALE" });
  directory = rows(list, "directories").find(d => d["name"] === "Renamed")!["capability"]!;
  await assert.rejects(request("reader.directory.delete", { directory }), /empty/); assert.equal(await readFile(path.join(root, "Conversations/Renamed/Child/user.txt"), "utf8"), "user-owned note");
  await request("reader.directory.create", { name: "Empty" }); await output(root, "Conversations/Empty"); directory = rows(await query(engine), "directories").find(d => d["name"] === "Empty")!["capability"]!;
  await request("reader.directory.delete", { directory }); assert.equal(obj((await readStoredRecord(root, "library", "CloudigLibrary.json")).value["settings"])["default_output_directory"], "Conversations");
  await assert.rejects(lstat(path.join(root, "Conversations/Empty")), { code: "ENOENT" });
  await assert.rejects(request("reader.directory.create", { name: "../escape" })); assert((await readdir(path.join(root, "appdata/recovery"))).length <= 2);
}));

test("move/archive/restore keep exact source formatting, UUID, mtime and Mark while collisions only rename the destination file", async () => temporary(async (root, engine) => {
  const c = await fixture(root), mark: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: c.value["conversation_id"]!, edited_at: timestamp, conversation_title: "Edited" }, markFile = `Marks/${mark["mark_id"]}.json`;
  await writeFile(path.join(root, markFile), encodeRecord("mark", mark)); const markBytes = await readFile(path.join(root, markFile)), stamp = (await lstat(path.join(root, c.file), { bigint: true })).mtimeNs;
  const request = call(engine); await request("reader.directory.create", { name: "Target" }); await fixture(root, "Conversations/Target/source.json");
  const list = await query(engine), archive = rows(list).find(r => r["conversation_id"] === c.value["conversation_id"])!["capability"]!, directory = rows(list, "directories")[0]!["capability"]!;
  const moved = await request("reader.archive.move", { archive, directory }); assert.equal(moved["path"], "Conversations/Target/source (2).json");
  assert.deepEqual(await readFile(path.join(root, String(moved["path"]))), c.bytes); assert.equal((await lstat(path.join(root, String(moved["path"])), { bigint: true })).mtimeNs, stamp);
  let cap = rows(await query(engine)).find(r => r["conversation_id"] === c.value["conversation_id"])!["capability"]!;
  const archived = await request("reader.archive.archive", { archive: cap }); assert.equal(archived["path"], "Archives/source (2).json");
  cap = rows(await query(engine, true))[0]!["capability"]!; const restored = await request("reader.archive.restore", { archive: cap }); assert.equal(restored["path"], "Conversations/source (2).json");
  assert.deepEqual(await readFile(path.join(root, String(restored["path"]))), c.bytes); assert.deepEqual(await readFile(path.join(root, markFile)), markBytes);
  const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.equal(catalog.conversations.filter(v => v.header["conversation_id"] === c.value["conversation_id"]).length, 1); assert.equal(catalog.marks.length, 1);
  const recoveries = await readdir(path.join(root, "appdata/recovery")); for (const id of recoveries) assert.deepEqual(await readdir(path.join(root, "appdata/recovery", id, "before")), [], "moving a large JSON must not duplicate its bytes into recovery snapshots");
}));

test("replaced directory handles and externally changed Conversation bytes cannot move unrelated content", async () => temporary(async (root, engine) => {
  const c = await fixture(root), request = call(engine); await request("reader.directory.create", { name: "Folder" });
  const list = await query(engine), directory = rows(list, "directories")[0]!["capability"]!, archive = rows(list)[0]!["capability"]!;
  await rename(path.join(root, "Conversations/Folder"), path.join(root, "Conversations/Held")); await mkdir(path.join(root, "Conversations/Folder"));
  await assert.rejects(request("reader.directory.rename", { directory, name: "Unexpected" }), /replaced/); assert((await lstat(path.join(root, "Conversations/Folder"))).isDirectory());
  await writeFile(path.join(root, c.file), c.bytes + " "); await assert.rejects(request("reader.archive.archive", { archive }), /changed/); assert.deepEqual(await readdir(path.join(root, "Archives")), []);
  const refreshed = await query(engine); assert.notEqual(rows(refreshed, "directories").find(d => d["name"] === "Folder")!["capability"], directory);
}));

for (const recovery of ["complete", "rollback"] as const) test(`directory relocation and output settings recover together after interruption: ${recovery}`, async () => temporary(async root => {
  await mkdir(path.join(root, "Conversations/From")); await writeFile(path.join(root, "Conversations/From/note.txt"), "keep"); await output(root, "Conversations/From");
  const library = await readStoredRecord(root, "library", "CloudigLibrary.json"), value = structuredClone(library.value); obj(value["settings"])["default_output_directory"] = "Conversations/To";
  await assert.rejects(commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", expected: library.sha256, value }], {
    relocations: [{ from: "Conversations/From", to: "Conversations/To", kind: "directory", identity: await recordFileIdentity(root, "Conversations/From", "directory") }], fault: point => { if (point === "relocated_0") throw new Error("interrupted"); } }));
  const [id] = await pendingRecordOperations(root); assert(id); await assert.rejects(withRecordSnapshot(root, async () => undefined)); await recoverRecords(root, id, recovery);
  const expected = recovery === "complete" ? "To" : "From"; assert.equal(await readFile(path.join(root, `Conversations/${expected}/note.txt`), "utf8"), "keep");
  assert.equal(obj((await readStoredRecord(root, "library", "CloudigLibrary.json")).value["settings"])["default_output_directory"], `Conversations/${expected}`); assert.deepEqual(await pendingRecordOperations(root), []);
}));

test("real process exit after no-replace relocation resumes without duplicate conversations or lost bytes", async () => temporary(async root => {
  const c = await fixture(root), relocation = { from: c.file, to: "Archives/source.json", kind: "file", identity: await recordFileIdentity(root, c.file, "file"), sha256: sha(c.bytes) };
  const code = `import { commitRecords } from ${JSON.stringify(pathToFileURL(path.resolve("src/adapters/storage/record-store.mts")).href)}; const p=JSON.parse(process.argv[1]); await commitRecords(p.root, [], {relocations:[p.relocation], fault(point){ if(point==='relocation_linked_0') process.exit(73); }});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ root, relocation })], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); let stderr = ""; child.stderr.on("data", b => { stderr += String(b); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); assert.equal(exit, 73, stderr);
  await assert.rejects(lstat(path.join(root, c.file)), { code: "ENOENT" }); assert.deepEqual(await readFile(path.join(root, relocation.to)), c.bytes);
  const [id] = await pendingRecordOperations(root); await recoverRecords(root, id!, "complete"); await assert.rejects(lstat(path.join(root, c.file)), { code: "ENOENT" }); assert.deepEqual(await readFile(path.join(root, relocation.to)), c.bytes);
}));

for (const recovery of ["complete", "rollback"] as const) test(`portable relocation recovery accepts changed filesystem IDs but requires exact content: ${recovery}`, { skip: process.env["CLOUDIG_PORTABLE_FILE_IDENTITIES"] !== "1" }, async () => temporary(async root => {
  const c = await fixture(root), to = "Archives/source.json";
  await assert.rejects(commitRecords(root, [], { relocations: [{ from: c.file, to, kind: "file", identity: await recordFileIdentity(root, c.file, "file"), sha256: sha(c.bytes) }],
    fault: async p => { if (p === "relocated_0") {
      // NTFS substitute for FAT's changed file ID, preserving exactly the archived bytes.
      const temporary = path.join(root, "Archives/same-bytes.tmp"); await writeFile(temporary, c.bytes);
      await rm(path.join(root, to)); await rename(temporary, path.join(root, to)); throw new Error("interrupted");
    } } }));
  const [id] = await pendingRecordOperations(root); await recoverRecords(root, id!, recovery);
  assert.deepEqual(await readFile(path.join(root, recovery === "complete" ? to : c.file)), c.bytes);
  assert.deepEqual(await pendingRecordOperations(root), []);
}));

test("occupied destinations are never replaced and rollback preserves externally changed targets", async () => temporary(async root => {
  const c = await fixture(root); await mkdir(path.join(root, "Conversations/One")); await mkdir(path.join(root, "Conversations/Two"));
  // Verify the Windows directory primitive itself, not just our preflight.
  await assert.rejects(rename(path.join(root, "Conversations/One"), path.join(root, "Conversations/Two"))); assert((await lstat(path.join(root, "Conversations/One"))).isDirectory()); assert((await lstat(path.join(root, "Conversations/Two"))).isDirectory());
  const relocation = { from: c.file, to: "Archives/source.json", kind: "file" as const, identity: await recordFileIdentity(root, c.file, "file"), sha256: sha(c.bytes) };
  await writeFile(path.join(root, relocation.to), "unrelated"); await assert.rejects(commitRecords(root, [], { relocations: [relocation] })); assert.equal(await readFile(path.join(root, relocation.to), "utf8"), "unrelated");
  await rm(path.join(root, relocation.to)); await assert.rejects(commitRecords(root, [], { relocations: [relocation], fault: p => { if (p === "relocated_0") throw new Error("interrupted"); } }));
  const [id] = await pendingRecordOperations(root); await writeFile(path.join(root, relocation.to), "user changed"); await assert.rejects(recoverRecords(root, id!, "rollback")); assert.equal(await readFile(path.join(root, relocation.to), "utf8"), "user changed");
  // Restore only the test's own known bytes, then finish its interrupted transaction.
  await writeFile(path.join(root, relocation.to), c.bytes); await recoverRecords(root, id!, "rollback"); assert.deepEqual(await readFile(path.join(root, c.file)), c.bytes);
}));

test("empty directory deletion can roll back before completion but refuses any newly arrived file", async () => temporary(async root => {
  await mkdir(path.join(root, "Conversations/Empty"));
  await assert.rejects(commitRecords(root, [], { relocations: [{ from: "Conversations/Empty", kind: "empty_directory", identity: await recordFileIdentity(root, "Conversations/Empty", "directory") }], fault: p => { if (p === "relocated_0") throw new Error("interrupted"); } }));
  const [id] = await pendingRecordOperations(root); await recoverRecords(root, id!, "rollback"); assert((await lstat(path.join(root, "Conversations/Empty"))).isDirectory());
  await writeFile(path.join(root, "Conversations/Empty/new.txt"), "preserve"); await assert.rejects(commitRecords(root, [], { relocations: [{ from: "Conversations/Empty", kind: "empty_directory", identity: await recordFileIdentity(root, "Conversations/Empty", "directory") }] }));
  assert.equal(await readFile(path.join(root, "Conversations/Empty/new.txt"), "utf8"), "preserve");
  await rm(path.join(root, "Conversations/Empty/new.txt"));
  await assert.rejects(commitRecords(root, [], { relocations: [{ from: "Conversations/Empty", kind: "empty_directory", identity: await recordFileIdentity(root, "Conversations/Empty", "directory") }], fault: async p => {
    if (p === "prepared") { await writeFile(path.join(root, "Conversations/Empty/new.txt"), "arrived later"); throw new Error("interrupted"); }
  } }));
  const [later] = await pendingRecordOperations(root); await recoverRecords(root, later!, "rollback"); assert.equal(await readFile(path.join(root, "Conversations/Empty/new.txt"), "utf8"), "arrived later");
}));

test("Reader exports the chosen source branch with embedded resources, exact progress and owned-cache cleanup", async () => temporary(async (root, engine) => {
  const c = await fixture(root), identity = c.value["identity"] as JsonObject[], user = identity.find(f => f["role"] === "user")!["source_id"]!, ai = identity.find(f => f["role"] === "assistant")!["source_id"]!;
  const resource = Buffer.from([255, 250, 171, 0, 1, 2]);
  c.value["messages"] = { current: "reply/right", items: [
    { id: "prompt/first", speaker: user, content: [{ type: "text", text: "Question" }] },
    { id: "reply/left", parent: "prompt/first", speaker: ai, content: [{ type: "text", text: "Left output" }] },
    { id: "reply/right", parent: "prompt/first", speaker: ai, content: [{ type: "reasoning", text: "Process only evidence" }, { type: "text", text: "Right output" }, { type: "attachment", resource: "r" }] }
  ] };
  c.value["resources"] = [{ id: "r", kind: "file", availability: "embedded", name: "data.bin", mime: "application/octet-stream", bytes: resource.length, sha256: sha(resource), data_base64: [resource.subarray(0, 1).toString("base64"), resource.subarray(1).toString("base64")] }];
  await writeFile(path.join(root, c.file), encodeRecord("conversation", c.value)); const before = await readFile(path.join(root, c.file)), archive = rows(await query(engine))[0]!["capability"]!;
  const events: JsonObject[] = [], handler = engine.handlers()["reader.archive.exportMarkdown"]!;
  const request = async (payload: JsonObject) => obj(await handler({ archive, ...payload }, { request: "q_export", signal: new AbortController().signal, emit: async e => { events.push(e); } }));
  const left = await request({ branch_choices: { "prompt/first": "reply/left" } }), leftText = await readFile(path.join(root, "Exports", String(left["filename"])), "utf8"); assert.match(leftText, /Left output/); assert.doesNotMatch(leftText, /Right output/);
  events.length = 0; const right = await request({}), text = await readFile(path.join(root, "Exports", String(right["filename"])), "utf8"); assert.match(text, /Right output/); assert.doesNotMatch(text, /Left output/);
  const embedded = /<data:application\/octet-stream;base64,([^>]+)>/u.exec(text)![1]!; assert.deepEqual(Buffer.from(embedded, "base64"), resource);
  assert.equal(obj(events[0]!["bytes"])["completed"], 0); assert.equal(obj(events.at(-1)!["bytes"])["completed"], Buffer.byteLength(text)); assert.equal(obj(events.at(-1)!["bytes"])["total"], Buffer.byteLength(text)); assert.notEqual(left["filename"], right["filename"]);
  const partial = await request({ content_mode: "body", messages: ["reply/right"] });
  const partialText = await readFile(path.join(root, "Exports", String(partial["filename"])), "utf8");
  assert.equal(partial["messages"], 1); assert.match(partialText, /Right output/); assert.doesNotMatch(partialText, /Question|Process only evidence|Left output/);
  assert.match(text, /Process only evidence/);
  await assert.rejects(request({ content_mode: "body", messages: ["reply/left"] }), { code: "CLOUDIG_EXPORT_FAILED" });
  const exportsBefore = await readdir(path.join(root, "Exports")), abort = new AbortController();
  await assert.rejects(handler({ archive }, { request: "q_cancel_export", signal: abort.signal, emit: async event => { if (Number(obj(event["bytes"])["completed"]) > 0) abort.abort(new DOMException("cancel", "AbortError")); } }));
  assert.deepEqual(await readdir(path.join(root, "Exports")), exportsBefore); assert.deepEqual(await readdir(path.join(root, "cache/Engine")), []); assert.deepEqual(await readFile(path.join(root, c.file)), before);
}));

test("native Markdown copy streams beyond the IPC budget, never creates Exports, and releases its exact cache", async () => temporary(async (root, engine) => {
  const c = await fixture(root), tree = obj(c.value["messages"]), messages = rows(tree), body = "Large Markdown 正文\n".repeat(75_000);
  messages[1]!["content"] = [{ type: "markdown", text: body }, { type: "reasoning", text: "Do not copy process" }];
  await writeFile(path.join(root, c.file), encodeRecord("conversation", c.value)); const before = await readFile(path.join(root, c.file));
  const archive = rows(await query(engine))[0]!["capability"]!, request = call(engine), exportsBefore = await readdir(path.join(root, "Exports"));
  const menu = await request("reader.archive.markdown.messages", { archive, offset: 0, limit: 1, content_mode: "body" }); assert.equal(menu["total"], 2);
  const second = await request("reader.archive.markdown.messages", { snapshot: menu["snapshot"]!, offset: 1, limit: 1 }); assert.equal(rows(second)[0]!["id"], "m2");
  const prepared = await request("reader.archive.copyMarkdown.prepare", { archive, messages: ["m2"], content_mode: "body", include_header: false });
  assert(Number(prepared["bytes"]) > 1048576); assert(!Object.hasOwn(prepared, "text")); assert.equal(prepared["messages"], 1);
  const bytes = await readFile(String(prepared["file"])), markdown = bytes.toString("utf8"); assert.equal(sha(bytes), prepared["sha256"]); assert(markdown.includes(body)); assert.doesNotMatch(markdown, /Do not copy process|第一行|Cloudig Markdown export/);
  assert.deepEqual(await readdir(path.join(root, "Exports")), exportsBefore);
  await request("reader.archive.copyMarkdown.release", { copy: prepared["copy"]! }); await assert.rejects(readFile(String(prepared["file"])), { code: "ENOENT" });
  const selection = await request("reader.archive.markdown.select", { archive, messages: ["m2"] });
  assert.equal((await request("reader.archive.markdown.select", { archive, messages: ["m2"], selection: selection["selection"]! }))["count"], 1);
  const selectedCopy = await request("reader.archive.copyMarkdown.prepare", { archive, selection: selection["selection"]!, content_mode: "body", include_header: false });
  assert.equal(selectedCopy["sha256"], prepared["sha256"]); await request("reader.archive.copyMarkdown.release", { copy: selectedCopy["copy"]! });
  await request("reader.archive.markdown.releaseSelection", { selection: selection["selection"]! });
  await assert.rejects(request("reader.archive.copyMarkdown.prepare", { archive, selection: selection["selection"]! }), { code: "CLOUDIG_CAPABILITY_EXPIRED" });
  const cancel = new AbortController();
  await assert.rejects(engine.handlers()["reader.archive.copyMarkdown.prepare"]!({ archive, content_mode: "body" }, { request: "q_copy_cancel", signal: cancel.signal, emit: async () => { cancel.abort(); } }), { name: "AbortError" });
  assert.deepEqual(await readdir(path.join(root, "cache/Engine")), []); assert.deepEqual(await readFile(path.join(root, c.file)), before);
}));
