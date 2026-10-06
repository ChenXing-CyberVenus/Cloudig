import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir, rm, realpath, lstat, rename, utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
import { recordImportOriginPath } from "../../../src/adapters/library-data/record-source-import.mts";
import { RecordArchiverEngineCommands } from "../../../src/engine/record-archiver-commands.mts";
import { RecordLibraryEngineCommands } from "../../../src/engine/record-library-commands.mts";
import { RecordSystemLogEngineCommands } from "../../../src/engine/record-system-log-commands.mts";
import { readRecordCatalog } from "../../../src/adapters/library-data/record-catalog.mts";
import { updateRecordSystemLog, readRecordSystemLog } from "../../../src/adapters/library-data/record-system-log.mts";
import { scanRecordSources, recordParseFailure } from "../../../src/adapters/library-data/record-parse-status.mts";
import { commitRecords, withRecordSnapshot } from "../../../src/adapters/storage/record-store.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { extractClaudeRecord } from "../../../src/app/parser/record-source.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import { savePreparedRecord } from "../../../src/adapters/library-data/record-parser-commit.mts";
import { PARSER_VERSION } from "../../../src/app/parser/registry.mts";
import { assertIpcValue, type EngineCommandHandler } from "../../../src/engine/protocol.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), fixture = path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), timestamp = "2026-09-11T18:00:00Z", obj = (v: unknown) => v as JsonObject, items = (v: JsonObject) => v["items"] as JsonObject[];
const call = (engine: { handlers(): Readonly<Record<string, EngineCommandHandler>> }, events: JsonObject[] = []) => async (name: string, payload: JsonObject) => { assertIpcValue(payload); const result = await engine.handlers()[name]!(payload, { request: "q_archiver", signal: new AbortController().signal, emit: async e => { assertIpcValue(e); events.push(e); } }); assertIpcValue(result); return obj(result); };

test("source snapshot pages and chunked selection cover more than a single IPC selection, but stale sources cannot be planned", async () => temporary(async (root, _runtime, engine) => {
  const html = await readFile(fixture);
  for (let i = 0; i < 1003; i++) await writeFile(path.join(root, `Inbox/Page${String(i).padStart(4, "0")}.html`), html);
  const request = call(engine), first = await request("archiver.sources.query", { offset: 0, limit: 200, sort: "title" }), selected = items(first).map(r => r["capability"]!);
  for (let offset = 200; offset < Number(first["total"]); offset += 200) selected.push(...items(await request("archiver.sources.query", { snapshot: first["snapshot"]!, offset, limit: 200 })).map(r => r["capability"]!));
  assert.equal(new Set(selected).size, 1003);
  await assert.rejects(request("archiver.sources.query", { snapshot: first["snapshot"]!, offset: 0, limit: 200, sort: "title" }));
  await assert.rejects(request("archiver.parse.plan", { sources: selected }));
  let selection: string | undefined;
  for (let offset = 0; offset < selected.length; offset += 500) {
    const payload = { sources: selected.slice(offset, offset + 500), ...(selection ? { selection } : {}) };
    assert(Buffer.byteLength(JSON.stringify(payload)) < 65536);
    const saved = await request("archiver.sources.select", payload); selection = String(saved["selection"]);
  }
  const plan = await request("archiver.parse.plan", { selection: selection! }); assert.equal(plan["total"], 1003);
  await assert.rejects(request("archiver.parse.plan", { selection: selection! }), { code: "CLOUDIG_SOURCE_CAPABILITY_STALE" });
  const old = await request("archiver.sources.select", { sources: [selected[0]!] });
  await writeFile(path.join(root, "Inbox/Page0000.html"), `${html.toString()}\nchanged`);
  assert.equal(items(await request("archiver.sources.query", { snapshot: first["snapshot"]!, offset: 0, limit: 1 }))[0]!["capability"], selected[0], "paging remains a view, not a silent refresh");
  await assert.rejects(request("archiver.parse.plan", { selection: old["selection"]! }), { code: "CLOUDIG_SOURCE_CAPABILITY_STALE" });
  assert.equal((await readdir(path.join(root, "Conversations"))).length, 0, "selection and preview never parse files");
}));

test("a replaced same-name output directory invalidates the confirmed plan before workers or files start", async () => temporary(async (root, runtime, engine) => {
  await copyFile(fixture, path.join(root, "Inbox/One.html")); await mkdir(path.join(root, "Conversations/Folder"));
  const request = call(engine), list = await request("archiver.sources.query", { offset: 0, limit: 200 });
  const plan = await request("archiver.parse.plan", { sources: [items(list)[0]!["capability"]!], directory: "d_folder" });
  await rename(path.join(root, "Conversations/Folder"), path.join(root, "Conversations/Original")); await mkdir(path.join(root, "Conversations/Folder"));
  await assert.rejects(request("archiver.parse.commit", { plan: plan["plan"]! }), /Output directory changed/);
  assert.deepEqual(await readdir(path.join(root, "Conversations/Folder")), []); assert(!await lstat(path.join(runtime, "Parser")).catch(() => undefined));
}));
async function temporary(run: (root: string, runtime: string, engine: RecordArchiverEngineCommands) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-archiver-")); let passed = false;
  await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); const cache = await createRuntimeCacheSession(path.join(root, "cache"), root);
  const engine = new RecordArchiverEngineCommands({ libraryRoot: root, runtimeRoot: cache.root, clock: () => timestamp, resolveDirectory: cap => { if (cap !== "d_folder") throw new TypeError("unknown directory"); return "Folder"; } });
  try { await run(root, cache.root, engine); passed = true; } finally { await engine.close(); await cache.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained Archiver test: ${root}`); }
}

test("metadata-only one-click covers all pages and stored scope/default output; ordinary parsing excludes Claude containers", async () => temporary(async (root, runtime, engine) => {
  const html = await readFile(fixture); for (let i = 0; i < 213; i++) await writeFile(path.join(root, `Inbox/Page${i}.html`), html);
  await writeFile(path.join(root, "Inbox/conversations.json"), "[]"); await mkdir(path.join(root, "Conversations/Folder"));
  const prefs = call(new RecordLibraryEngineCommands(root)), settings = await prefs("library.preferences.query", {}); await prefs("library.preferences.commit", { expected_revision: settings["revision"]!, default_output_directory: "Conversations/Folder", workflow_parser: { sort: "time_asc" } });
  const request = call(engine), query = await request("archiver.sources.query", { offset: 0, limit: 200 }), first = items(query).find(row => row["platform"] === "chatgpt")!;
  assert.equal(query["total"], 214); assert.equal(items(query).length, 200); assert.equal(obj(query["stats"])["bookmark_html"], 213); assert.equal(obj(query["statuses"])["pending"], 214);
  assert.equal(first["platform"], "chatgpt"); assert.equal(first["exporter_version"], "fixture"); assert(!String(first["filename"]).endsWith(".html"));
  const plan = await request("archiver.parse.plan", { sources: [], one_click: true }); assert.equal(plan["total"], 213); assert.equal(items(plan).length, 200); assert.equal(plan["directory"], "Conversations/Folder");
  const remaining = await request("archiver.parse.items", { plan: plan["plan"]!, offset: 200, limit: 200 }); assert.equal(items(remaining).length, 13); assert.equal(new Set([...items(plan), ...items(remaining)].map(r => r["filename"])).size, 213);
  assert.deepEqual(await readdir(path.join(root, "Conversations")), ["Folder"]); assert(!await lstat(path.join(runtime, "Parser")).catch(() => undefined));
  const single = await request("archiver.parse.plan", { sources: [first["capability"]!], directory: "root" }); assert.equal(items(single).length, 1); assert.equal(single["directory"], "Conversations");
}));

test("explicit parse/reparse preserves source identity and Mark; preserve-previous makes a different Conversation without copying Mark", async () => temporary(async (root, _runtime, engine) => {
  await copyFile(fixture, path.join(root, "Inbox/Title(1).html")); await copyFile(fixture, path.join(root, "Inbox/Title(2).html")); const events: JsonObject[] = [], request = call(engine, events);
  const list = await request("archiver.sources.query", { offset: 0, limit: 200, sort: "title" }), selected = items(list).map(r => r["capability"]!);
  const plan = await request("archiver.parse.plan", { sources: selected }); assert.equal(events.length, 0);
  const result = await request("archiver.parse.commit", { plan: plan["plan"]! }); assert(items(result).every(r => r["status"] === "created"));
  assert(events.some(e => obj(e["items"])["completed"] === 0)); assert(events.some(e => e["bytes"] && Number.isFinite(Number(obj(e["bytes"])["completed"]))));
  assert.deepEqual([...new Set(events.filter(e => e["bytes"] && Number(obj(e["bytes"])["completed"]) > 0).map(e => obj(e["file"])["index"]))].sort(), [1, 2]);
  const normalized = events.filter(e => e["phase"] === "normalize"); assert(normalized.length > 0);
  assert(normalized.every(e => !e["bytes"] && Number(obj(e["items"])["total"]) > 0), "message counts are not byte counts");
  let catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.equal(catalog.conversations.length, 2); assert.notEqual(catalog.conversations[0]!.header["conversation_id"], catalog.conversations[1]!.header["conversation_id"]);
  assert.deepEqual(catalog.conversations.map(c => obj(c.header["title"])["filename"]).sort(), ["Title(1)", "Title(2)"]);
  const originalId = String(catalog.conversations[0]!.header["conversation_id"]), markId = uuidV7(), markPath = `Marks/${markId}.json`, mark: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: markId, target: originalId, edited_at: timestamp, conversation_title: "User title", models: [] };
  await commitRecords(root, [{ action: "write", kind: "mark", path: markPath, value: mark, expected: null }]); const beforeMark = await readFile(path.join(root, markPath));
  const after = await request("archiver.sources.query", { offset: 0, limit: 200, sort: "title" }); assert(items(after).every(r => r["status"] === "complete"));
  const again = await request("archiver.parse.plan", { sources: [items(after)[0]!["capability"]!] }); await request("archiver.parse.commit", { plan: again["plan"]! }); assert.deepEqual(await readFile(path.join(root, markPath)), beforeMark);
  const preserve = await request("archiver.parse.plan", { sources: [items(after)[0]!["capability"]!], preserve_previous: true }); await request("archiver.parse.commit", { plan: preserve["plan"]! });
  catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.equal(catalog.conversations.length, 3); assert.equal(catalog.marks.length, 1); assert(catalog.conversations.some(c => c.header["conversation_id"] === originalId));
  await assert.rejects(request("archiver.parse.commit", { plan: preserve["plan"]! }), { code: "CLOUDIG_PARSE_PLAN_STALE" });
}));

test("single-file destination changes keep the preview scope and move only its safe reparse with UUID and Mark intact", async () => temporary(async (root, runtime, engine) => {
  await copyFile(fixture, path.join(root, "Inbox/Single.html")); await mkdir(path.join(root, "Conversations/Folder"));
  const settings = await readFile(path.join(root, "CloudigLibrary.json")), request = call(engine);
  const selected = items(await request("archiver.sources.query", { offset: 0, limit: 200 }))[0]!["capability"]!;
  const initial = await request("archiver.parse.plan", { sources: [selected] });
  await assert.rejects(request("archiver.parse.retarget", { plans: [initial["plan"]!], directory: "unknown" }));
  const retarget = await request("archiver.parse.retarget", { plans: [initial["plan"]!], directory: "d_folder" });
  assert.equal(retarget["directory"], "Conversations/Folder");
  assert.deepEqual(await readdir(path.join(root, "Conversations/Folder")), []); assert(!await lstat(path.join(runtime, "Parser")).catch(() => undefined));
  await assert.rejects(request("archiver.parse.commit", { plan: initial["plan"]! }), { code: "CLOUDIG_PARSE_PLAN_STALE" });
  await copyFile(fixture, path.join(root, "Inbox/ArrivedAfterPreview.html"));
  const parsed = await request("archiver.parse.commit", { plan: (retarget["plans"] as string[])[0]! }); assert.equal(parsed["completed"], 1);
  const output = items(parsed)[0]!, originalId = output["archive"]!, outputPath = String(output["path"]);
  assert.equal(outputPath, "Conversations/Folder/Single.json");
  const original = JSON.parse(await readFile(path.join(root, outputPath), "utf8"));
  const markId = uuidV7(), markPath = "Marks/" + markId + ".json";
  await commitRecords(root, [{ action: "write", kind: "mark", path: markPath, expected: null, value: { schema: "cloudig/mark/1.0.0", mark_id: markId, target: originalId, edited_at: timestamp, conversation_title: "Keep" } }]);
  const markBefore = await readFile(path.join(root, markPath));
  const unchangedTarget = await request("archiver.parse.plan", { sources: [selected] });
  assert.equal(items(await request("archiver.parse.commit", { plan: unchangedTarget["plan"]! }))[0]!["path"], outputPath, "default reparse remains in place");
  const other = { ...original, conversation_id: uuidV7() }, otherBytes = JSON.stringify(other);
  await writeFile(path.join(root, "Conversations/Single.json"), otherBytes);
  const second = await request("archiver.parse.plan", { sources: [selected] });
  const rootTarget = await request("archiver.parse.retarget", { plans: [second["plan"]!], directory: "root" });
  const moved = items(await request("archiver.parse.commit", { plan: (rootTarget["plans"] as string[])[0]! }))[0]!;
  assert.equal(moved["archive"], originalId); assert.equal(moved["path"], "Conversations/Single (2).json");
  assert(!(await lstat(path.join(root, outputPath)).catch(() => undefined)));
  assert.equal(await readFile(path.join(root, "Conversations/Single.json"), "utf8"), otherBytes); assert.deepEqual(await readFile(path.join(root, markPath)), markBefore);
  const fresh = JSON.parse(await readFile(path.join(root, String(moved["path"])), "utf8")); assert.equal(fresh.lifecycle.first_parsed_at, original.lifecycle.first_parsed_at);
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), settings);
  const list = await request("archiver.sources.query", { offset: 0, limit: 200 }); assert.equal(list["statuses"] && obj(list["statuses"])["pending"], 1);
}));

test("Claude single-record destination changes retain the selected record and reject a replaced target", async () => temporary(async (root, runtime, engine) => {
  await writeFile(path.join(root, "Inbox/conversations.json"), JSON.stringify([
    { uuid: "a", name: "A", chat_messages: [{ uuid: "u-a", sender: "human", text: "A" }] },
    { uuid: "b", name: "B", chat_messages: [{ uuid: "u-b", sender: "human", text: "B" }] }
  ])); await mkdir(path.join(root, "Conversations/Folder"));
  const request = call(engine), source = items(await request("archiver.sources.query", { offset: 0, limit: 200 }))[0]!;
  const indexed = await request("archiver.claude.index", { source: source["capability"]! });
  const records = items(await request("archiver.claude.records.query", { container: indexed["container"]!, offset: 0, limit: 200 }));
  const plan = await request("archiver.claude.extract.preview", { container: indexed["container"]!, selectors: [records[0]!["selector"]!] });
  const target = await request("archiver.parse.retarget", { plans: [plan["plan"]!], directory: "d_folder" });
  assert.deepEqual(await readdir(path.join(root, "Conversations/Folder")), []);
  const result = await request("archiver.claude.extract.commit", { plans: target["plans"]! }); assert.equal(result["completed"], 1);
  assert(String(items(result)[0]!["path"]).startsWith("Conversations/Folder/"));
  const after = items(await request("archiver.claude.records.query", { container: indexed["container"]!, offset: 0, limit: 200 })); assert.equal(after.filter(r => r["status"] === "parsed").length, 1); assert.equal(after.filter(r => r["status"] === "ready").length, 1);
  const second = await request("archiver.claude.extract.preview", { container: indexed["container"]!, selectors: [records[1]!["selector"]!] });
  const stale = await request("archiver.parse.retarget", { plans: [second["plan"]!], directory: "d_folder" });
  await rename(path.join(root, "Conversations/Folder"), path.join(root, "Conversations/Previous")); await mkdir(path.join(root, "Conversations/Folder"));
  await assert.rejects(request("archiver.claude.extract.commit", { plans: stale["plans"]! }), /Output directory changed/);
  assert.deepEqual(await readdir(path.join(root, "Conversations/Folder")), []);
}));

for (const kind of ['html', 'claude'] as const) test(`${kind}: explicit preview destination moves a safe reparse without a second directory change`, async () => temporary(async (root, _runtime, engine) => {
  await mkdir(path.join(root, 'Conversations/Folder'));
  if (kind === 'html') await copyFile(fixture, path.join(root, 'Inbox/Move.html'));
  else await writeFile(path.join(root, 'Inbox/conversations.json'), JSON.stringify([{ uuid: 'move', name: 'Move', chat_messages: [{ uuid: 'u', sender: 'human', text: 'Keep content' }] }]));
  const request = call(engine), source = items(await request('archiver.sources.query', { offset: 0, limit: 200 }))[0]!;
  let scope: JsonObject = { sources: [source['capability']!] };
  if (kind === 'claude') {
    const indexed = await request('archiver.claude.index', { source: source['capability']! });
    const rows = items(await request('archiver.claude.records.query', { container: indexed['container']!, offset: 0, limit: 200 }));
    scope = { container: indexed['container']!, selectors: [rows[0]!['selector']!] };
  }
  const parse = async (extra: JsonObject) => {
    const p = await request(kind === 'html' ? 'archiver.parse.plan' : 'archiver.claude.extract.preview', { ...scope, ...extra });
    const result = await request(kind === 'html' ? 'archiver.parse.commit' : 'archiver.claude.extract.commit', kind === 'html' ? { plan: p['plan']! } : { plans: [p['plan']!] });
    const row = items(result)[0]!; assert(!row['error'], JSON.stringify(row)); return row;
  };
  const first = await parse({}), originalPath = String(first['path']), original = JSON.parse(await readFile(path.join(root, originalPath), 'utf8'));
  const markId = uuidV7(), markPath = `Marks/${markId}.json`;
  await commitRecords(root, [{ action: 'write', kind: 'mark', path: markPath, expected: null, value: { schema: 'cloudig/mark/1.0.0', mark_id: markId, target: first['archive']!, edited_at: timestamp, conversation_title: 'User title' } }]);
  const markBytes = await readFile(path.join(root, markPath));
  const moved = await parse({ directory: 'd_folder' });
  assert.equal(moved['archive'], first['archive']); assert(String(moved['path']).startsWith('Conversations/Folder/'));
  assert(!(await lstat(path.join(root, originalPath)).catch(() => undefined)));
  assert.equal((await parse({}))['path'], moved['path'], 'An unspecified internal destination does not silently relocate');
  const returned = await parse({ directory: 'root' }); assert.equal(returned['path'], originalPath); assert.equal(returned['archive'], first['archive']);
  assert(!(await lstat(path.join(root, String(moved['path']))).catch(() => undefined)));
  assert.deepEqual(await readFile(path.join(root, markPath)), markBytes);
  assert.equal(JSON.parse(await readFile(path.join(root, originalPath), 'utf8')).lifecycle.first_parsed_at, original.lifecycle.first_parsed_at);
  const retained = await parse({ directory: 'd_folder', preserve_previous: true });
  assert.notEqual(retained['archive'], first['archive']); assert(await lstat(path.join(root, originalPath)));
  assert.deepEqual(await readFile(path.join(root, markPath)), markBytes);
}));

test("partially parsed containers expose only their old Adapter outputs as updates, then clear them after reparse", async () => temporary(async (root, _runtime, engine) => {
  const originals = ['Old', 'Current', 'Unparsed'].map(name => ({ uuid: name, name, chat_messages: [{ uuid: name + '-u', sender: 'human', text: name }] }));
  await writeFile(path.join(root, 'Inbox/conversations.json'), JSON.stringify(originals));
  const source = (await scanRecordSources(root))[0]!;
  for (const [i, record] of originals.slice(0, 2).entries()) {
    const conversation = assembleConversationRecord({ ...extractClaudeRecord({ record, source: { file: 'conversations.json', bytes: source.bytes, sha256: source.sha256 } }), timestamp, parserVersion: PARSER_VERSION });
    const parser = obj(conversation['parser']);
    if (i === 0) obj(parser['adapter'])['version'] = '0.0.1';
    else parser['version'] = '0.0.1'; // Total Parser version alone is not an update signal.
    await savePreparedRecord(root, { conversation, sourcePath: source.path });
  }
  const request = call(engine), sources = await request('archiver.sources.query', { offset: 0, limit: 200 });
  const indexed = await request('archiver.claude.index', { source: items(sources)[0]!['capability']! });
  const query = (statuses?: string[]) => request('archiver.claude.records.query', { container: indexed['container']!, offset: 0, limit: 200, ...(statuses ? { statuses } : {}) });
  const before = await query(); assert.deepEqual(before['statuses'], { update: 1, parsed: 1, ready: 1 });
  const old = items(await query(['update'])); assert.equal(old.length, 1); assert.equal(old[0]!['title'], 'Old');
  const plan = await request('archiver.claude.extract.preview', { container: indexed['container']!, selectors: [old[0]!['selector']!] });
  const result = await request('archiver.claude.extract.commit', { plans: [plan['plan']!] }); assert.equal(result['completed'], 1);
  assert.equal(items(await query(['update'])).length, 0);
  assert.deepEqual((await query())['statuses'], { parsed: 2, ready: 1 });
  assert.equal((await withRecordSnapshot(root, () => readRecordCatalog(root))).conversations.length, 2, 'Updating does not parse the remaining record or duplicate the old output');
}));

test("missing source rows survive refresh until explicitly dismissed; retry limits and replacements use their own source bytes", async () => temporary(async (root, _runtime, engine) => {
  await copyFile(fixture, path.join(root, "Inbox/One.html")); const request = call(engine), first = items(await request("archiver.sources.query", { offset: 0, limit: 200 }))[0]!;
  const unit = { source: (await scanRecordSources(root))[0]! }; await recordParseFailure(root, unit, "bad content", true); assert.equal(items(await request("archiver.sources.query", { offset: 0, limit: 200 }))[0]!["status"], "failed");
  await recordParseFailure(root, unit, "bad content", true); const unsupported = items(await request("archiver.sources.query", { offset: 0, limit: 200 }))[0]!; assert.equal(unsupported["status"], "unsupported");
  assert.equal(items(await request("archiver.parse.plan", { sources: [unsupported["capability"]!] })).length, 0);
  await rm(path.join(root, "Inbox/One.html")); let missing = items(await request("archiver.sources.query", { offset: 0, limit: 200 }))[0]!; assert.equal(missing["status"], "missing");
  assert.equal(items(await request("archiver.sources.query", { offset: 0, limit: 200 }))[0]!["status"], "missing"); await request("archiver.source.dismissMissing", { source: missing["capability"]! }); assert.equal((await request("archiver.sources.query", { offset: 0, limit: 200 }))["total"], 0);
  await copyFile(fixture, path.join(root, "Inbox/One.html")); await assert.rejects(request("archiver.parse.plan", { sources: [first["capability"]!] }), { code: "CLOUDIG_SOURCE_CAPABILITY_STALE" });
}));

test("bulk missing-record cleanup covers the whole queue, keeps restored files and never changes the archive", async () => temporary(async (root, _runtime, engine) => {
  const request = call(engine), html = await readFile(fixture);
  await writeFile(path.join(root, "Inbox/Parsed.html"), html);
  await writeFile(path.join(root, "Inbox/Keep.html"), html);
  await writeFile(path.join(root, "Inbox/Restored.html"), html);
  for (let i = 0; i < 202; i++) await writeFile(path.join(root, "Inbox/Missing-" + i + ".txt"), "owned fixture");
  const observed = await request("archiver.sources.query", { offset: 0, limit: 200, search: "Parsed" });
  const plan = await request("archiver.parse.plan", { sources: [items(observed)[0]!["capability"]!] });
  const parsed = await request("archiver.parse.commit", { plan: plan["plan"]! });
  const archive = String(items(parsed)[0]!["path"]), archiveBefore = await readFile(path.join(root, archive));
  const settingsBefore = await readFile(path.join(root, "CloudigLibrary.json"));
  await rm(path.join(root, "Inbox/Parsed.html")); await rm(path.join(root, "Inbox/Restored.html"));
  for (let i = 0; i < 202; i++) await rm(path.join(root, "Inbox/Missing-" + i + ".txt"));
  const filtered = await request("archiver.sources.query", { offset: 0, limit: 1, search: "Restored", statuses: ["missing"] });
  assert.equal(items(filtered).length, 1);
  await writeFile(path.join(root, "Inbox/Restored.html"), html);
  const result = await request("archiver.source.dismissMissing", { source: items(filtered)[0]!["capability"]!, all_missing: true });
  assert.equal(result["dismissed"], 203);
  const remaining = await request("archiver.sources.query", { offset: 0, limit: 200 });
  assert.deepEqual(items(remaining).map(r => r["source_file"]).sort(), ["Keep.html", "Restored.html"]);
  assert.deepEqual(await readFile(path.join(root, archive)), archiveBefore);
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), settingsBefore);
  assert.deepEqual(await readFile(path.join(root, "Inbox/Restored.html")), html);
  await assert.rejects(request("archiver.source.dismissMissing", { source: items(remaining)[0]!["capability"]!, all_missing: "yes" }));
}));

test("Claude indexing keeps identical containers independent; title/date selection and partial batches produce ordinary Tree records", async () => temporary(async (root, _runtime, engine) => {
  const data = [{ uuid: "a", name: "Alpha", created_at: "2020-01-02T00:00:00Z", updated_at: "2022-01-01T00:00:00Z", chat_messages: [{ uuid: "u", sender: "human", text: "Question" }, { uuid: "a1", parent_message_uuid: "u", sender: "assistant", text: "One" }, { uuid: "a2", parent_message_uuid: "u", sender: "assistant", text: "Two" }] }, { uuid: "b", name: "Beta", created_at: "2021-01-01T00:00:00Z", updated_at: "2021-01-01T00:00:00Z", chat_messages: [] }];
  for (const name of ["First", "Second"]) await writeFile(path.join(root, `Inbox/${name}.json`), JSON.stringify(data)); const request = call(engine), list = await request("archiver.sources.query", { offset: 0, limit: 200, sort: "title" });
  const a = await request("archiver.claude.index", { source: items(list)[0]!["capability"]! }), b = await request("archiver.claude.index", { source: items(list)[1]!["capability"]! }); assert.notEqual(a["container"], b["container"]);
  const query = { container: a["container"]!, offset: 0, limit: 200, time_field: "created_at", direction: "asc" }, rows = await request("archiver.claude.records.query", query); assert.deepEqual(items(rows).map(r => r["title"]), ["Alpha", "Beta"]);
  assert.equal(items(await request("archiver.claude.records.query", { container: a["container"]!, snapshot: rows["snapshot"]!, offset: 1, limit: 1 }))[0]!["title"], "Beta");
  await assert.rejects(request("archiver.claude.records.query", { container: b["container"]!, snapshot: rows["snapshot"]!, offset: 1, limit: 1 }), { code: "CLOUDIG_QUERY_EXPIRED" });
  assert.equal(items(await request("archiver.claude.records.query", { ...query, search: "Question" })).length, 0, "title search never leaks into body");
  const selected = items(rows)[0]!["selector"]!, plan = await request("archiver.claude.extract.preview", { container: a["container"]!, selectors: [selected] }); assert.equal(items(plan).length, 1); await request("archiver.claude.extract.commit", { plans: [plan["plan"]!] });
  const fresh = await request("archiver.claude.records.query", query); assert.deepEqual(items(fresh).map(r => r["status"]), ["parsed", "ready"]);
  const second = await request("archiver.claude.records.query", { ...query, container: b["container"]! }); assert(items(second).every(r => r["status"] === "ready"));
  const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)), c = JSON.parse(await readFile(path.join(root, catalog.conversations[0]!.path), "utf8")); assert.deepEqual(c.messages.items.map((m: JsonObject) => [m["id"], m["parent"] ?? null]), [["u", null], ["a1", "u"], ["a2", "u"]]);
}));

test("legacy invalid capture falls back across lists and Claude parsing; explicit repair preserves UUID/Mark", async () => temporary(async (root, _runtime, engine) => {
  const data = JSON.stringify([{ uuid: "a", name: "Capture repair", created_at: "2024-01-02T00:00:00Z", chat_messages: [{ uuid: "u", sender: "human", text: "Original message", created_at: "2024-01-02T00:00:00Z" }] }]);
  const hash = createHash("sha256").update(data).digest("hex"); await mkdir(path.join(root, "appdata/imports"), { recursive: true });
  for (const [name, at] of [["Unknown", "1980-01-01T00:00:00Z"], ["Older", "2024-01-02T00:00:00Z"], ["Newer", "2026-01-02T00:00:00Z"]]) {
    const file = `Inbox/${name}.json`; await writeFile(path.join(root, file), data);
    await utimes(path.join(root, file), new Date("1980-01-01T00:00:00Z"), new Date("1980-01-01T00:00:00Z"));
    await writeFile(path.join(root, recordImportOriginPath(file)), JSON.stringify({ schema: "cloudig/source-import/1.0.0", path: file, sha256: hash, captured: { at, from: "filesystem:last_write_time" } }));
  }
  const request = call(engine), capturedAt = new Date((await lstat(path.join(root, "Inbox/Unknown.json"))).birthtimeMs).toISOString();
  for (const sort of ["captured_asc", "captured_desc", "modified_asc", "modified_desc"]) {
    const rows = items(await request("archiver.sources.query", { offset: 0, limit: 200, sort }));
    assert.deepEqual(rows.map(r => r["filename"]), sort.endsWith("asc") ? ["Older.json", "Newer.json", "Unknown.json"] : ["Unknown.json", "Newer.json", "Older.json"]);
    assert.equal(rows.find(r => r["filename"] === "Unknown.json")!["captured_at"], capturedAt);
  }
  const list = await request("archiver.sources.query", { offset: 0, limit: 200, sort: "title" });
  const source = items(list).find(row => row["filename"] === "Unknown.json")!;
  const indexed = await request("archiver.claude.index", { source: source["capability"]! }); assert.equal(obj(indexed["source"])["captured_at"], capturedAt);
  const query = { container: indexed["container"]!, offset: 0, limit: 200 };
  const row = items(await request("archiver.claude.records.query", query))[0]!;
  const parse = async () => { const plan = await request("archiver.claude.extract.preview", { container: indexed["container"]!, selectors: [row["selector"]!] }); return request("archiver.claude.extract.commit", { plans: [plan["plan"]!] }); };
  await parse();
  const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)), saved = catalog.conversations[0]!, file = path.join(root, saved.path);
  const original = JSON.parse(await readFile(file, "utf8")); assert.equal(original.source.captured_at, capturedAt); assert.equal(original.source.captured_from, "filesystem:creation_time");
  const markId = uuidV7(), markPath = `Marks/${markId}.json`, mark = { schema: "cloudig/mark/1.0.0", mark_id: markId, target: original.conversation_id, edited_at: timestamp, conversation_title: "My title" };
  await commitRecords(root, [{ action: "write", kind: "mark", path: markPath, value: mark, expected: null }]); const markBytes = await readFile(path.join(root, markPath));
  original.source.captured_at = "1980-01-01T00:00:00.000Z"; original.source.captured_from = "filesystem:last_write_time";
  original.parser.adapter.version = "2.0.2";
  const oldBytes = JSON.stringify(original); await writeFile(file, oldBytes);
  // Seed a consistent old-version result and its history, not a user-edited file.
  for (const entry of await readdir(path.join(root, "appdata/parse-history"))) {
    const historyFile = path.join(root, "appdata/parse-history", entry), history = JSON.parse(await readFile(historyFile, "utf8"));
    if (history.output.conversation_id === original.conversation_id) { history.output.sha256 = createHash("sha256").update(oldBytes).digest("hex"); history.parser = original.parser; await writeFile(historyFile, JSON.stringify(history)); }
  }
  assert.equal(items(await request("archiver.claude.records.query", query))[0]!["status"], "update", "new Adapter waterline offers explicit repair");
  assert.equal(JSON.parse(await readFile(file, "utf8")).source.captured_at, original.source.captured_at, "listing is not migration");
  await parse();
  const repaired = JSON.parse(await readFile(file, "utf8")); assert.equal(repaired.source.captured_at, capturedAt); assert.equal(repaired.source.captured_from, "filesystem:creation_time");
  assert.equal(repaired.conversation_id, original.conversation_id); assert.equal(repaired.lifecycle.first_parsed_at, original.lifecycle.first_parsed_at);
  assert.deepEqual(repaired.messages, original.messages); assert.deepEqual(await readFile(path.join(root, markPath)), markBytes);
}));

test("System Log capabilities reject changed groups and deletion never deletes Inbox or another record's diagnostics", async () => temporary(async root => {
  const file = "Inbox/errors.json"; await writeFile(path.join(root, file), "[]"); const logs = new RecordSystemLogEngineCommands(root), request = call(logs);
  await updateRecordSystemLog(root, [{ path: file, locator: "a", recorded_at: timestamp, errors: [{ source: "parser", message: "A" }] }]); const first = items(await request("systemLog.list", { offset: 0, limit: 100 }))[0]!;
  assert.equal((await request("systemLog.reveal", { file: first["capability"]! }))["path"], file);
  await updateRecordSystemLog(root, [{ path: file, locator: "b", recorded_at: timestamp, errors: [{ source: "parser", message: "B" }] }]); await assert.rejects(request("systemLog.delete", { file: first["capability"]! }), { code: "CLOUDIG_SYSTEM_LOG_CAPABILITY_STALE" });
  const fresh = items(await request("systemLog.list", { offset: 0, limit: 100 }))[0]!; assert.equal((fresh["errors"] as JsonObject[]).length, 2); await request("systemLog.delete", { file: fresh["capability"]! }); assert.equal(await readFile(path.join(root, file), "utf8"), "[]"); assert.deepEqual((await readRecordSystemLog(root))["files"], []); logs.close();
}));

test("native-style staged bytes import through the real Engine, then parse; failed Claude indexing enters only System Log", async () => temporary(async (root, runtime, engine) => {
  const bytes = await readFile(fixture), picker = `p_${"a".repeat(43)}`, directory = path.join(runtime, "Pickers", picker); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "payload.bin"), bytes); await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schema: "cloudig/picker/1.0.0", picker, filename: "Imported(2).html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), captured_at: "2020-01-01T00:00:00Z", captured_from: "filesystem:creation_time", modified_at: "2021-01-01T00:00:00Z" }));
  const events: JsonObject[] = [], request = call(engine, events), imported = await request("source.import", { pickers: [picker] }); assert.equal(imported["state"], "completed"); assert.equal(items(imported)[0]!["filename"], "Imported(2).html"); assert(events.some(e => e["bytes"]));
  const list = await request("archiver.sources.query", { offset: 0, limit: 200 }), plan = await request("archiver.parse.plan", { sources: [items(list)[0]!["capability"]!] }); await request("archiver.parse.commit", { plan: plan["plan"]! });
  const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.equal(obj(catalog.conversations[0]!.header["title"])["filename"], "Imported(2)"); assert.deepEqual(await readFile(path.join(root, "Inbox/Imported(2).html")), bytes);
  await writeFile(path.join(root, "Inbox/bad.json"), "{}"); const bad = items(await request("archiver.sources.query", { offset: 0, limit: 200 })).find(r => r["source_file"] === "bad.json")!;
  await assert.rejects(request("archiver.claude.index", { source: bad["capability"]! }), { code: "CLOUDIG_ARCHIVER_OPERATION_FAILED" });
  const log = await readRecordSystemLog(root); assert.equal((log["files"] as JsonObject[])[0]!["path"], "Inbox/bad.json"); assert.equal(obj(((log["files"] as JsonObject[])[0]!["errors"] as JsonObject[])[0])["code"], "claude-index-failed");
  await writeFile(path.join(root, "Inbox/bad.json"), "[]"); const fixed = items(await request("archiver.sources.query", { offset: 0, limit: 200 })).find(r => r["source_file"] === "bad.json")!; await request("archiver.claude.index", { source: fixed["capability"]! }); assert.deepEqual((await readRecordSystemLog(root))["files"], []);
}));
