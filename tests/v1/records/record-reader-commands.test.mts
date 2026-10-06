import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordCatalog } from "../../../src/adapters/library-data/record-catalog.mts";
import { readRecordTimes } from "../../../src/adapters/library-data/record-time.mts";
import { commitRecords, readStoredRecord, withRecordSnapshot } from "../../../src/adapters/storage/record-store.mts";
import { RecordReaderEngineCommands } from "../../../src/engine/record-reader-commands.mts";
import { RecordTimeEngineCommands } from "../../../src/engine/record-time-commands.mts";
import { localRecordAnchor } from "../../../src/engine/record-library-commands.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { encodeRecord } from "../../../src/core/records/index.mts";
import { platformFront } from "../../../src/core/records/front.mts";
import { queryRecordArchives, RECORD_ARCHIVE_TIME_FIELDS, type RecordArchiveFact } from "../../../src/app/reader/record-archive-list.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T18:00:00Z";
const builtins = { user: { name: "User", avatar: "app/user.svg" }, assistant: { name: "AI", avatar: "app/ai.svg" }, platforms: {} };
const obj = (v: unknown) => v as JsonObject, rows = (v: JsonObject, key = "items") => v[key] as JsonObject[];
const context = { request: "q_record_reader", signal: new AbortController().signal, emit: async () => undefined };
async function temporary(run: (root: string, engine: RecordReaderEngineCommands, times: RecordTimeEngineCommands, clock: (value: string) => void) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-reader-")); let passed = false, now = timestamp;
  const times = new RecordTimeEngineCommands({ libraryRoot: root });
  const engine = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, "cache"), builtins, clock: () => now,
    projectTimeRange: range => times.projectDraftRange(range), resolveTimeRange: range => times.resolveDraftRange(range) });
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-01", offset: "Z" } }); await run(root, engine, times, value => { now = value; }); passed = true; }
  finally { await engine.close(); times.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained Reader test: ${root}`); }
}
const call = (engine: RecordReaderEngineCommands | RecordTimeEngineCommands) => async (name: string, payload: JsonObject) => { assertIpcValue(payload); const value = await engine.handlers()[name]!(payload, context); assertIpcValue(value); return obj(value); };
async function fixture(root: string, name: string, file = `Conversations/${name}.json`, overrides: JsonObject = {}) {
  const value = obj(JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8")));
  Object.assign(value, { conversation_id: uuidV7(), title: { filename: name }, ...overrides });
  ((obj(value["messages"])["items"] as JsonObject[])[0]!["content"] as JsonObject[])[0]!["text"] = "BODY_ONLY_NEEDLE";
  await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), encodeRecord("conversation", value)); return { value, file };
}
async function save(request: ReturnType<typeof call>, archive: string, info: JsonObject, draft: JsonObject, extra: JsonObject = {}) {
  return request("reader.archive.info.commit", { archive, expected_conversation: obj(info["revision"])["conversation"]!, expected_mark: obj(info["revision"])["mark"]!, draft, touch_on_noop: false, ...extra });
}

test("Reader catalogs more than 512 records without expiring earlier pages; real nested/empty directories and deletion stay authoritative", async () => temporary(async (root, engine) => {
  const seed = await fixture(root, "Record 0000"), template = seed.value;
  await mkdir(path.join(root, "Conversations/Empty/Nested"), { recursive: true }); await mkdir(path.join(root, "Conversations/Group/Child"), { recursive: true });
  for (let i = 1; i < 605; i++) { const c = structuredClone(template); c["conversation_id"] = uuidV7(); c["title"] = { filename: `Record ${String(i).padStart(4, "0")}` };
    await writeFile(path.join(root, `Conversations/${i === 604 ? "Group/Child/" : ""}${i}.json`), encodeRecord("conversation", c)); }
  const request = call(engine), first = await request("reader.archives.query", { offset: 0, limit: 200, sort: "title" }), cap = String(rows(first)[0]!["capability"]);
  assert.equal(first["total"], 605); assert(rows(first, "directories").some(d => d["name"] === "Empty/Nested" && d["count"] === 0));
  const seen = new Set(rows(first).map(r => r["capability"])); for (const offset of [200, 400, 600]) for (const r of rows(await request("reader.archives.query", { snapshot: first["snapshot"]!, offset, limit: 200 }))) seen.add(r["capability"]);
  assert.equal(seen.size, 605); assert.equal(obj((await request("reader.archive.info.query", { archive: cap }))["effective"])["conversation_name"], "Record 0000");
  const group = rows(first, "directories").find(d => d["name"] === "Group")!["capability"]!;
  assert.equal((await request("reader.archives.query", { offset: 0, limit: 200, directories: [group] }))["total"], 1);
  const inspected: string[] = []; await withRecordSnapshot(root, () => readRecordCatalog(root, { onInspect: p => { inspected.push(p); } })); assert.deepEqual(inspected, []);
  await rm(path.join(root, seed.file)); assert.equal((await request("reader.archives.query", { snapshot: first["snapshot"]!, offset: 0, limit: 200 }))["total"], 605, "snapshot is stable until an explicit fresh query");
  assert.equal((await request("reader.archives.query", { offset: 0, limit: 200 }))["total"], 604);
  await assert.rejects(request("reader.archive.info.query", { archive: cap }), { code: "CLOUDIG_CAPABILITY_EXPIRED" });
}));

test("Reader position is a disposable appdata preference and is ignored after a conversation source changes", async () => temporary(async (root, engine) => {
  const created = await fixture(root, "Positioned"), request = call(engine);
  let list = await request("reader.archives.query", { offset: 0, limit: 200, sort: "title" });
  const first = rows(list)[0]!, capability = String(first["capability"]);
  assert.deepEqual(await request("reader.position.query", { archive: capability }), { position: null });
  await request("reader.position.save", { archive: capability, message_id: "m1", selected_leaf: "m1", branch_choices: { root: "m1" } });
  const stored = JSON.parse(await readFile(path.join(root, "appdata/reader-state.json"), "utf8"));
  assert.equal(stored.schema, "cloudig/reader-state/1.0.0");
  assert.equal(stored.conversations[String(created.value["conversation_id"])].message_id, "m1");
  const saved = await request("reader.position.query", { archive: capability });
  assert.equal(obj(saved["position"])["message_id"], "m1");
  const reopened = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, "reopened-cache"), builtins, clock: () => timestamp });
  try {
    const reopenedRequest = call(reopened), reopenedList = await reopenedRequest("reader.archives.query", { offset: 0, limit: 200, sort: "title" });
    const reopenedPosition = await reopenedRequest("reader.position.query", { archive: rows(reopenedList)[0]!["capability"]! });
    assert.equal(obj(reopenedPosition["position"])["message_id"], "m1", "position survives a fresh Reader engine instance");
  } finally { await reopened.close(); }

  created.value["title"] = { filename: "Positioned changed" };
  await writeFile(path.join(root, created.file), encodeRecord("conversation", created.value));
  list = await request("reader.archives.query", { offset: 0, limit: 200, sort: "title" });
  const changed = rows(list)[0]!;
  assert.notEqual(changed["capability"], capability);
  assert.deepEqual(await request("reader.position.query", { archive: changed["capability"]! }), { position: null });
}));

test("Reader searches only title/filename, supports multiple directories, platform-none and archives, and keeps exact file statistics", async () => temporary(async (root, engine) => {
  await fixture(root, "Alpha", "Conversations/One/a.json"); await fixture(root, "Beta", "Conversations/Two/b.json", { platform: "claude" }); await fixture(root, "Gone", "Archives/g.json");
  const request = call(engine), list = await request("reader.archives.query", { offset: 0, limit: 200, sort: "title" });
  assert.deepEqual(rows(list).map(r => r["title"]), ["Alpha", "Beta"]); assert.equal(obj(list["stats"])["files"], 2); assert.equal(obj(list["stats"])["archived_files"], 1);
  assert.equal(obj(list["stats"])["bytes"], (await lstat(path.join(root, "Conversations/One/a.json"))).size + (await lstat(path.join(root, "Conversations/Two/b.json"))).size);
  assert.equal((await request("reader.archives.query", { offset: 0, limit: 200, platforms: [] }))["total"], 0);
  assert.deepEqual(rows(await request("reader.archives.query", { offset: 0, limit: 200, platforms: ["claude"] })).map(r => r["title"]), ["Beta"]);
  assert.equal((await request("reader.archives.query", { offset: 0, limit: 200, directories: rows(list, "directories").map(d => d["capability"]!) }))["total"], 2);
  assert.equal((await request("reader.archives.query", { offset: 0, limit: 200, search: "BODY_ONLY_NEEDLE" }))["total"], 0);
  assert.equal((await request("reader.archives.query", { offset: 0, limit: 200, search: "A.JSON" }))["total"], 1);
  assert.deepEqual(rows(await request("reader.archives.query", { offset: 0, limit: 200, archived: true })).map(r => r["title"]), ["Gone"]);
}));

test("unknown platforms remain readable without poisoning mixed catalogs or inventing platform claims", async () => temporary(async (root, engine) => {
  for (const platform of ["myplatform", "__proto__", "constructor"]) await fixture(root, platform, `Conversations/${platform}.json`, { platform });
  const bad = await fixture(root, "bad"), future = await fixture(root, "future");
  bad.value["not_declared"] = true; await writeFile(path.join(root, bad.file), JSON.stringify(bad.value));
  future.value["schema"] = "cloudig/conversation/1.1.0"; await writeFile(path.join(root, future.file), JSON.stringify(future.value));
  const request = call(engine), list = await request("reader.archives.query", { offset: 0, limit: 200 });
  assert.equal(list["total"], 3); assert.equal(rows(list, "issues").filter(i => i["code"] === "CLOUDIG_RECORD_SCHEMA_UNSUPPORTED").length, 1);
  for (const row of rows(list)) {
    const info = await request("reader.archive.info.query", { archive: row["capability"]! });
    assert.equal(obj(info["source"])["platform"], row["platform"]);
  }
}));

test("full-text Engine searches every branch with user/assistant defaults, stable paging and explicit cancellation", async () => temporary(async (root, engine) => {
  const a = await fixture(root, "Alpha", "Conversations/One/a.json"), b = await fixture(root, "Archived", "Archives/b.json");
  const tree = obj(a.value["messages"]), messages = rows(tree);
  messages.push({ id: "alternative", parent: "m1", speaker: "assistant-1", content: [{ type: "markdown", text: "HIDDEN_BRANCH_MATCH" }, { type: "reasoning", text: "PROCESS_ONLY_MATCH" }] });
  await writeFile(path.join(root, a.file), encodeRecord("conversation", a.value));
  const before = await Promise.all([a, b].map(f => readFile(path.join(root, f.file))));
  const request = call(engine), query = { query: "BODY_ONLY_NEEDLE", scope: { locations: ["conversations", "archives"] }, offset: 0, limit: 1 };
  const found = await request("reader.search.query", query); assert.equal(found["total"], 2); assert.equal(rows(found).length, 1);
  const second = await request("reader.search.query", { snapshot: found["snapshot"]!, offset: 1, limit: 1 }); assert.equal(rows(second).length, 1); assert.notEqual(rows(second)[0]!["archive"], rows(found)[0]!["archive"]);
  const branch = await request("reader.search.query", { ...query, query: "HIDDEN_BRANCH_MATCH" }); assert.equal(branch["total"], 1); assert.equal(rows(branch)[0]!["message"], "alternative");
  const hit = rows(branch)[0]!, bounds = { offset: 0, limit: 1 }, opened = await request("reader.search.open", { archive: hit["archive"]!, message: hit["message"]!, request: { messages: bounds, navigation: bounds, branches: bounds } });
  assert.equal(obj(opened["session"])["selected_leaf"], "alternative"); assert.equal(obj(opened["focus"])["source_index"], 2);
  const rendered = JSON.parse(await readFile(path.join(root, "cache", "Views", String(obj(opened["page"])["virtual_path"]).replace(/^\//u, "")), "utf8"));
  assert.equal(rendered.messages[0].id, "alternative"); await request("reader.view.close", { view: opened["token"]! });
  assert.equal((await request("reader.search.query", { ...query, query: "PROCESS_ONLY_MATCH" }))["total"], 0);
  assert.equal((await request("reader.search.query", { ...query, query: "PROCESS_ONLY_MATCH", categories: ["process"] }))["total"], 1);
  assert.equal((await request("reader.search.query", { ...query, categories: [] }))["total"], 0);
  await assert.rejects(request("reader.search.query", { ...query, scope: { search: "Old filtered title" } }), { code: "CLOUDIG_IPC_PAYLOAD_INVALID" });
  const controller = new AbortController(); const events: JsonObject[] = [];
  await assert.rejects(engine.handlers()["reader.search.query"]!(query, { ...context, signal: controller.signal, emit: async event => { events.push(event); controller.abort(); } }), { name: "AbortError" });
  assert.equal(events[0]!["phase"], "content-search");
  for (const [i, f] of [a, b].entries()) assert.deepEqual(await readFile(path.join(root, f.file)), before[i]);
}));

test("directory scope unions selected active directories with Archives, never with previous title matches", async () => temporary(async (root, engine) => {
  await fixture(root, "Alpha", "Conversations/One/a.json"); await fixture(root, "Beta", "Conversations/Two/b.json"); await fixture(root, "Gone", "Archives/Old/g.json");
  const request = call(engine), initial = await request("reader.archives.query", { offset: 0, limit: 200, search: "Alpha" });
  const one = rows(initial, "directories").find(d => d["name"] === "One")!["capability"]!;
  const two = rows(initial, "directories").find(d => d["name"] === "Two")!["capability"]!;
  const query = { offset: 0, limit: 200, sort: "title", locations: ["conversations", "archives"] };
  assert.deepEqual(rows(await request("reader.archives.query", { ...query, directories: [one] })).map(r => r["title"]), ["Alpha", "Gone"]);
  const both = await request("reader.archives.query", { ...query, directories: [one, two] });
  assert.deepEqual(rows(both).map(r => r["title"]), ["Alpha", "Beta", "Gone"]); assert.equal(both["catalog_total"], 3);
  assert.equal((await request("reader.archives.query", { ...query, locations: [] }))["total"], 0);
  assert.deepEqual(rows(await request("reader.archives.query", { ...query, directories: [one], locations: ["archives"] })).map(r => r["title"]), ["Gone"]);
  await assert.rejects(request("reader.archives.query", { ...query, archived: false }), { code: "CLOUDIG_IPC_PAYLOAD_INVALID" });
  await assert.rejects(request("reader.archives.query", { ...query, locations: ["Conversations/../"] }), { code: "CLOUDIG_IPC_PAYLOAD_INVALID" });
}));

test("all eight time selectors use their own facts; node endpoints sort by the selected end without changing snapshots", () => {
  const fact = (name: string, day: number): RecordArchiveFact => ({ path: `Conversations/${name}.json`, id: name, sha256: "c", markSha: null, bytes: 1, mtimeNs: String(BigInt(Date.parse(`2026-09-${day}T00:00:00Z`)) * 1000000n), messages: 1, resources: 0, access: "normal",
    header: { lifecycle: { first_parsed_at: `2026-09-${day}T01:00:00Z` }, source: { captured_at: `2026-09-${day}T02:00:00Z` }, message_time: { start: `2026-09-${day}T03:00:00Z`, end: `2026-09-${day}T04:00:00Z` } },
    resolved: { conversationName: name, platform: "chatgpt", models: [], userName: "U", assistantName: "A", userAvatar: "u", assistantAvatar: "a", effectiveEditedAt: `2026-09-${day}T05:00:00Z`, contentTime: { state: "set", range: { start: { kind: "calendar", era: "AD", year: 2026, month: 9, day }, end: { kind: "calendar", era: "AD", year: 2027, month: 9, day } } } } });
  const older = fact("Z older", 10), newer = fact("A newer", 12), facts = [newer, older];
  for (const timeField of RECORD_ARCHIVE_TIME_FIELDS) for (const [sort, expected] of [["content_asc", [older.id, newer.id]], ["content_desc", [newer.id, older.id]]] as const)
    assert.deepEqual(queryRecordArchives(facts, { offset: 0, limit: 10, sort, timeField }).rows.map(r => r.id), expected, timeField);
  const mixed = structuredClone(older), node = { kind: "node", target: { node: "node" }, snapshot: { node: { name: "Span", kind: "single" }, sort: { start: { kind: "calendar", era: "AD", year: 1900 }, end: { kind: "calendar", era: "AD", year: 2200 } } } };
  (mixed.resolved.contentTime as JsonObject)["range"] = { start: { kind: "calendar", era: "AD", year: 1800 }, end: node };
  const before = structuredClone(mixed);
  assert.deepEqual(queryRecordArchives([mixed, newer], { offset: 0, limit: 10, sort: "content_asc", timeField: "content_start" }).rows.map(r => r.id), [older.id, newer.id]);
  assert.deepEqual(queryRecordArchives([mixed, newer], { offset: 0, limit: 10, sort: "content_asc", timeField: "content_end" }).rows.map(r => r.id), [newer.id, older.id]); assert.deepEqual(mixed, before);
});

test("Conversation editor preserves originals, does not create empty Marks, and distinguishes source models from explicit generic reset", async () => temporary(async (root, engine) => {
  const c = await fixture(root, "Original"), before = await readFile(path.join(root, c.file)), request = call(engine);
  const archive = String(rows(await request("reader.archives.query", { offset: 0, limit: 200 }))[0]!["capability"]);
  let info = await request("reader.archive.info.query", { archive }), draft = obj(info["draft"]);
  assert.equal(typeof obj(info["facts"])["first_parsed_at"], "string"); assert.equal(typeof obj(info["source"])["captured_at"], "string");
  assert.equal(obj(obj(info["effective"])["content_time"])["state"], "unavailable");
  assert.equal((await request("reader.archive.info.preview", { archive, draft }))["can_touch"], false);
  assert.equal((await save(request, archive, info, draft, { touch_on_noop: true }))["status"], "unchanged"); assert.deepEqual(await readdir(path.join(root, "Marks")), []);
  // A preference change does not invalidate this edit.
  const lib = await readStoredRecord(root, "library", "CloudigLibrary.json"); obj(lib.value["settings"])["theme"] = "StarNight";
  await commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", expected: lib.sha256, value: lib.value }]);
  draft["models"] = { state: "set", values: ["User declared model"] }; await save(request, archive, info, draft);
  let catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)), model = (catalog.marks[0]!.value["models"] as JsonObject[])[0]!;
  const subject = (await readStoredRecord(root, "identitySettings", "Identities/identity-settings.json")).value["subject"];
  assert.equal(obj((obj((model["names"] as JsonObject[])[0])["claimers"] as JsonObject[])[0])["front"], subject); assert(!("front_id" in model)); assert(!("source_id" in model));
  info = await request("reader.archive.info.query", { archive }); draft = obj(info["draft"]); draft["models"] = { state: "set", values: [] }; await save(request, archive, info, draft);
  info = await request("reader.archive.info.query", { archive }); assert.deepEqual(obj(info["effective"])["models"], [String((platformFront(String(c.value["platform"]))["names"] as JsonObject[])[0]!["name"])]);
  catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.deepEqual(catalog.marks[0]!.value["models"], []);
  draft = obj(info["draft"]); draft["models"] = { state: "inherit" }; await save(request, archive, info, draft);
  assert.deepEqual(await readdir(path.join(root, "Marks")), []); assert.deepEqual(await readFile(path.join(root, c.file)), before);
  info = await request("reader.archive.info.query", { archive }); draft = obj(info["draft"]); draft["conversation_name"] = { state: "set", value: "Temporary title" }; await save(request, archive, info, draft);
  info = await request("reader.archive.info.query", { archive }); draft = obj(info["draft"]); draft["conversation_name"] = { state: "set", value: "   " }; await save(request, archive, info, draft);
  assert.deepEqual(await readdir(path.join(root, "Marks")), []); assert.equal(obj((await request("reader.archive.info.query", { archive }))["effective"])["conversation_name"], "Original");
}));

test("A-only anchor refresh updates only A Mark while title-only edits preserve saved anchors", async () => temporary(async (root, engine, times, clock) => {
  const a = await fixture(root, "A"), b = await fixture(root, "B"), request = call(engine), time = call(times);
  const cover = await time("time.cover.query", { return_to: "reader-cover" }), modern = rows(obj(cover["terran"])).find(r => r["name"] === "现代社会")!;
  const selected = (await time("time.endpoint.preview", { route: cover["route"]!, node: modern["node"]! }))["endpoint"]!;
  const list = rows(await request("reader.archives.query", { offset: 0, limit: 200, sort: "title" })), ca = String(list[0]!["capability"]), cb = String(list[1]!["capability"]);
  for (const archive of [ca, cb]) { const info = await request("reader.archive.info.query", { archive }), draft = obj(info["draft"]); draft["content_time"] = { state: "set", range: { start: selected } }; await save(request, archive, info, draft); }
  const before = await withRecordSnapshot(root, () => readRecordCatalog(root)), ma = before.marks.find(m => m.value["target"] === a.value["conversation_id"])!, mb = before.marks.find(m => m.value["target"] === b.value["conversation_id"])!;
  const nodeFiles = (await readRecordTimes(root)).nodes, nodeBytes = await Promise.all(nodeFiles.map(n => readFile(path.join(root, n.path)))), bBytes = await readFile(path.join(root, mb.path));
  const convoBytes = await Promise.all([a, b].map(c => readFile(path.join(root, c.file)))); clock("2026-09-14T18:00:00Z");
  let info = await request("reader.archive.info.query", { archive: ca }), draft = obj(info["draft"]); draft["conversation_name"] = { state: "set", value: "A title only" }; await save(request, ca, info, draft);
  let current = await readStoredRecord(root, "mark", ma.path); assert.deepEqual(current.value["content_time"], ma.value["content_time"]);
  info = await request("reader.archive.info.query", { archive: ca }); await save(request, ca, info, obj(info["draft"]), { refresh_anchor: true });
  current = await readStoredRecord(root, "mark", ma.path); const range = obj(obj(current.value["content_time"])["range"]), sort = obj(obj(obj(range["start"])["snapshot"])["sort"]);
  assert.deepEqual(obj(sort["end"])["anchor"], localRecordAnchor(new Date("2026-09-14T18:00:00Z")));
  assert.deepEqual(await readFile(path.join(root, mb.path)), bBytes); for (const [i, n] of nodeFiles.entries()) assert.deepEqual(await readFile(path.join(root, n.path)), nodeBytes[i]);
  for (const [i, c] of [a, b].entries()) assert.deepEqual(await readFile(path.join(root, c.file)), convoBytes[i]);
}));

test("source/Mark conflicts remain readable originals, never automatic winners or writable capabilities", async () => temporary(async (root, engine) => {
  const a = await fixture(root, "A"); await fixture(root, "B", "Conversations/B.json", { conversation_id: a.value["conversation_id"]! });
  const request = call(engine), list = await request("reader.archives.query", { offset: 0, limit: 200 }); assert.equal(list["total"], 2); assert(rows(list).every(r => r["access"] === "read_only_conflict"));
  const archive = String(rows(list)[0]!["capability"]), info = await request("reader.archive.info.query", { archive });
  await assert.rejects(save(request, archive, info, obj(info["draft"])), { code: "CLOUDIG_ARCHIVE_INFO_CONFLICT" });
  const page = { offset: 0, limit: 100 }, opened = await request("reader.view.open", { archive, request: { messages: page, navigation: page, branches: page } }); assert.equal(typeof opened["token"], "string"); await request("reader.view.close", { view: opened["token"]! });
}));
