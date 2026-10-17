import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { createRecordTime, readRecordTimes, prepareRecordTimeSave, commitRecordTimeSave, prepareRecordTimeEditorSave } from "../../../src/adapters/library-data/record-time.mts";
import { commitRecords, readStoredRecord } from "../../../src/adapters/storage/record-store.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { readConversationRecord } from "../../../src/adapters/library-data/record-reading.mts";
import { buildRecordMarkdown } from "../../../src/app/export/markdown.mts";
import { saveConversationMark } from "../../../src/adapters/library-data/record-mark.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T22:00:00Z", later = "2026-09-11T23:00:00Z";
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "time-save-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained time save test: ${root}`); }
}
async function setup(root: string) {
  const axis = await createRecordTime(root, { fields: { kind: "timeline", name: "轴", author: "老婆" }, timestamp });
  const a = await createRecordTime(root, { fields: { kind: "single", name: "A" }, parent: String(axis.node["node_id"]), timestamp });
  const b = await createRecordTime(root, { fields: { kind: "single", name: "B" }, parent: String(axis.node["node_id"]), timestamp });
  const graph = (await readRecordTimes(root)).graph, marks: JsonObject[] = [], conversations: string[] = [];
  for (const [index, node] of [a, b].entries()) {
    const conversation = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8")) as JsonObject; conversation["conversation_id"] = uuidV7();
    const file = `Conversations/${index}.json`; conversations.push(file);
    const mark: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: conversation["conversation_id"]!, edited_at: timestamp,
      content_time: { range: { start: await graph.snapshot({ node: String(node.node["node_id"]), timeline: String(axis.node["node_id"]) }) } } };
    marks.push(mark); await commitRecords(root, [{ action: "write", kind: "conversation", path: file, expected: null, value: conversation }, { action: "write", kind: "mark", path: `Marks/${mark["mark_id"]}.json`, expected: null, value: mark }]);
  }
  return { axis, a, b, marks, conversations };
}

test("actual all-sync changes Time and Mark but never the Conversation JSON", async () => temporary(async root => {
  const data = await setup(root), originals = await Promise.all(data.conversations.map(file => readFile(path.join(root, file))));
  const plan = await prepareRecordTimeSave(root, { node: String(data.a.node["node_id"]), patch: { name: "A revised" }, timestamp: later, synchronize: "all" });
  assert.equal(plan.result.affected.length, 1); assert.equal(plan.changes.length, 2); await commitRecordTimeSave(root, plan);
  const mark = await readStoredRecord(root, "mark", `Marks/${data.marks[0]!["mark_id"]}.json`); assert.equal(mark.value["edited_at"], later);
  const reading = await readConversationRecord(root, String(mark.value["target"]), { user: { name: "User", avatar: "Assets/user.svg" }, assistant: { name: "AI", avatar: "Assets/ai.svg" }, platforms: {} });
  assert(buildRecordMarkdown({ ...reading, locale: "zh-CN" }).parts.filter(p => typeof p === "string").join("").includes("轴 · A revised"));
  for (const [i, file] of data.conversations.entries()) assert.deepEqual(await readFile(path.join(root, file)), originals[i]);
  assert.equal((await readRecordTimes(root)).nodes.length, 20);
}));

test("actual partial-sync saves independent node files and leaves the old nodes and unselected Mark byte-identical", async () => temporary(async root => {
  const data = await setup(root), originalNodes = await Promise.all([data.axis, data.a, data.b].map(n => readFile(path.join(root, n.path))));
  const unselected = `Marks/${data.marks[1]!["mark_id"]}.json`, beforeMark = await readFile(path.join(root, unselected));
  const plan = await prepareRecordTimeSave(root, { node: String(data.axis.node["node_id"]), patch: { name: "新轴" }, timestamp: later, synchronize: new Set([String(data.marks[0]!["mark_id"])]) });
  assert.equal(plan.result.copies.size, 3); assert.equal(plan.changes.length, 5); await commitRecordTimeSave(root, plan);
  for (const [i, n] of [data.axis, data.a, data.b].entries()) assert.deepEqual(await readFile(path.join(root, n.path)), originalNodes[i]);
  assert.deepEqual(await readFile(path.join(root, unselected)), beforeMark); assert.equal((await readRecordTimes(root)).nodes.length, 23);
}));

test("a Mark added after preview invalidates all-sync before any node is written", async () => temporary(async root => {
  const data = await setup(root), before = await readFile(path.join(root, data.axis.path));
  const plan = await prepareRecordTimeSave(root, { node: String(data.axis.node["node_id"]), patch: { name: "changed" }, timestamp: later, synchronize: "all" });
  const extra = { ...data.marks[0]!, mark_id: uuidV7(), target: uuidV7() };
  await commitRecords(root, [{ action: "write", kind: "mark", path: `Marks/${extra["mark_id"]}.json`, value: extra, expected: null }]);
  await assert.rejects(commitRecordTimeSave(root, plan), /impact preview/); assert.deepEqual(await readFile(path.join(root, data.axis.path)), before);
}));

test("Mark edits resolve selected nodes on the backend and unrelated name edits do not refresh old time snapshots", async () => temporary(async root => {
  const data = await setup(root), conversation = await readStoredRecord(root, "conversation", data.conversations[0]!);
  const old = await readStoredRecord(root, "mark", `Marks/${data.marks[0]!["mark_id"]}.json`);
  const endpoint: JsonObject = { kind: "node", target: { node: data.b.node["node_id"]!, timeline: data.axis.node["node_id"]! }, snapshot: { node: { kind: "single", name: "Wrong client label" } } };
  const saved = await saveConversationMark(root, { conversationId: String(conversation.value["conversation_id"]), expectedConversation: conversation.sha256, expectedMark: old.sha256, timestamp: later,
    settings: { content_time: { range: { start: endpoint, end: structuredClone(endpoint) } } } });
  assert(saved); const time = structuredClone(saved["content_time"]);
  assert(JSON.stringify(time).includes('"name":"B"')); assert(!JSON.stringify(time).includes("Wrong client label")); assert(!((time as JsonObject)["range"] as JsonObject)["end"]);
  const b = (await readStoredRecord(root, "contentTime", data.b.path)).value; b["name"] = "Changed outside Cloudig"; await writeFile(path.join(root, data.b.path), JSON.stringify(b));
  const currentMark = await readStoredRecord(root, "mark", `Marks/${saved["mark_id"]}.json`);
  const edited = await saveConversationMark(root, { conversationId: String(conversation.value["conversation_id"]), expectedConversation: conversation.sha256, expectedMark: currentMark.sha256, timestamp: later,
    settings: { content_time: time!, names: { user: "Edited name only" } } });
  assert.deepEqual(edited?.["content_time"], time); assert.equal((await readStoredRecord(root, "conversation", data.conversations[0]!)).sha256, conversation.sha256);
}));

test("the editor removes an inbound counterpart from its actual file without duplicating the relation", async () => temporary(async root => {
  const data = await setup(root), a = await readStoredRecord(root, "contentTime", data.a.path);
  a.value["counterparts"] = [{ target: { node: data.b.node["node_id"]! } }]; await commitRecords(root, [{ action: "write", kind: "contentTime", path: data.a.path, expected: a.sha256, value: a.value }]);
  const kept = await prepareRecordTimeEditorSave(root, { node: String(data.b.node["node_id"]), patch: { name: "B2" }, counterparts: [{ target: { node: data.a.node["node_id"]! } }], timestamp: later, synchronize: "all" });
  assert(!kept.changes.some(c => c.path === data.a.path)); await commitRecordTimeSave(root, kept);
  const removed = await prepareRecordTimeEditorSave(root, { node: String(data.b.node["node_id"]), patch: {}, counterparts: [], timestamp: later, synchronize: "all" });
  await commitRecordTimeSave(root, removed); assert.deepEqual((await readStoredRecord(root, "contentTime", data.a.path)).value["counterparts"], []);
  assert.equal((await readRecordTimes(root)).graph.directCounterparts(String(data.b.node["node_id"])).length, 0);
}));

test("explicit anchor refresh changes only A's Mark, not the shared modern-society node, B, or source Conversations", async () => temporary(async root => {
  const data = await setup(root), times = await readRecordTimes(root), modern = times.nodes.find(n => n.value["name"] === "现代社会")!;
  assert(modern); const endpoint = await times.graph.snapshot({ node: String(modern.value["node_id"]) });
  for (const mark of data.marks) {
    const markPath = `Marks/${mark["mark_id"]}.json`, stored = await readStoredRecord(root, "mark", markPath);
    stored.value["content_time"] = { range: { start: structuredClone(endpoint) } };
    await commitRecords(root, [{ action: "write", kind: "mark", path: markPath, value: stored.value, expected: stored.sha256 }]);
  }
  const a = await readStoredRecord(root, "mark", `Marks/${data.marks[0]!["mark_id"]}.json`), conversation = await readStoredRecord(root, "conversation", data.conversations[0]!);
  const protectedPaths = [modern.path, `Marks/${data.marks[1]!["mark_id"]}.json`, ...data.conversations];
  const originalBytes = await Promise.all(protectedPaths.map(p => readFile(path.join(root, p))));
  const refreshed = await saveConversationMark(root, { conversationId: String(a.value["target"]), expectedConversation: conversation.sha256, expectedMark: a.sha256,
    settings: { content_time: structuredClone(a.value["content_time"]!) }, timestamp: later, refreshAnchor: { date: "2026-10-01", offset: "+08:00" } });
  assert(refreshed); assert.equal(refreshed["edited_at"], later); assert.equal(refreshed["mark_id"], a.value["mark_id"]);
  const expected = structuredClone(a.value["content_time"]) as JsonObject, range = expected["range"] as JsonObject, snapshot = (range["start"] as JsonObject)["snapshot"] as JsonObject;
  const sort = snapshot["sort"] as JsonObject;
  assert(Object.values(sort).some(v => (v as JsonObject)["kind"] === "now"));
  for (const value of Object.values(sort) as JsonObject[]) if (["now", "relative"].includes(String(value["kind"]))) value["anchor"] = { date: "2026-10-01", offset: "+08:00" };
  assert.deepEqual(refreshed["content_time"], expected);
  for (const [index, p] of protectedPaths.entries()) assert.deepEqual(await readFile(path.join(root, p)), originalBytes[index]);
  const markPath = `Marks/${a.value["mark_id"]}.json`, fresh = await readStoredRecord(root, "mark", markPath);
  await assert.rejects(saveConversationMark(root, { conversationId: String(a.value["target"]), expectedConversation: conversation.sha256, expectedMark: fresh.sha256,
    settings: { content_time: refreshed["content_time"]! }, timestamp: later, refreshAnchor: { date: "2026-02-30", offset: "Z" } }), /Invalid explicit time anchor/);
  assert.equal((await readStoredRecord(root, "mark", markPath)).sha256, fresh.sha256);
}));

test("direct Terran anchor refresh is explicit and an unchanged save does not write unless requested", async () => temporary(async root => {
  const data = await setup(root), a = await readStoredRecord(root, "mark", `Marks/${data.marks[0]!["mark_id"]}.json`), conversation = await readStoredRecord(root, "conversation", data.conversations[0]!);
  const markPath = `Marks/${a.value["mark_id"]}.json`;
  const settings: JsonObject = { content_time: { range: { start: { kind: "now", anchor: { date: "2026-09-11", offset: "Z" } } } } };
  await saveConversationMark(root, { conversationId: String(a.value["target"]), expectedConversation: conversation.sha256, expectedMark: a.sha256, settings, timestamp });
  const before = await readStoredRecord(root, "mark", markPath);
  await saveConversationMark(root, { conversationId: String(a.value["target"]), expectedConversation: conversation.sha256, expectedMark: before.sha256, settings, timestamp: later });
  assert.equal((await readStoredRecord(root, "mark", markPath)).sha256, before.sha256);
  const saved = await saveConversationMark(root, { conversationId: String(a.value["target"]), expectedConversation: conversation.sha256, expectedMark: before.sha256, settings, timestamp: later, refreshAnchor: { date: "2026-10-01", offset: "Z" } });
  assert.equal(saved?.["edited_at"], later);
  assert.deepEqual(((saved?.["content_time"] as JsonObject)["range"] as JsonObject)["start"], { kind: "now", anchor: { date: "2026-10-01", offset: "Z" } });
  const changed = await readStoredRecord(root, "mark", markPath), next = "2026-09-12T00:00:00Z";
  const touch = await saveConversationMark(root, { conversationId: String(a.value["target"]), expectedConversation: conversation.sha256, expectedMark: changed.sha256, settings: { content_time: saved!["content_time"]! }, timestamp: next, forceEditedAt: true });
  assert.equal(touch?.["edited_at"], next); assert.deepEqual(touch?.["content_time"], saved?.["content_time"]);
}));
