import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, lstat, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordTimes, createRecordTime, prepareRecordTimeSave, commitRecordTimeSave, prepareRecordTimeRestore, prepareRecordTimeDelete, commitRecordTimeDelete, prepareRecordTimeUnlink, commitRecordTimeUnlink } from "../../../src/adapters/library-data/record-time.mts";
import { readStoredRecord, commitRecords } from "../../../src/adapters/storage/record-store.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T22:00:00Z", later = "2026-09-11T23:00:00Z";
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "time-maintenance-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained time maintenance test: ${root}`); }
}

test("all builtin nodes are undeletable and the four special values cannot become concrete dates", async () => temporary(async root => {
  const catalog = await readRecordTimes(root), special = catalog.nodes.find(n => n.value["name"] === "无限久前")!;
  await assert.rejects(prepareRecordTimeDelete(root, { nodes: catalog.nodes.map(n => String(n.value["node_id"])), links: "remove", timestamp: later }), /builtins/);
  await assert.rejects(prepareRecordTimeSave(root, { node: String(special.value["node_id"]), patch: { terran_mappings: [{ range: { start: { kind: "calendar", era: "AD", year: 2026 } }, edited_at: later }] }, timestamp: later, synchronize: "all" }), /concrete time/);
  assert.equal((await readRecordTimes(root)).nodes.length, 17);
}));

test("restore default time uses the same preset source, preserves names and updates anchors only explicitly", async () => temporary(async root => {
  const original = (await readRecordTimes(root)).nodes.find(n => n.value["name"] === "宇宙诞生")!;
  await commitRecordTimeSave(root, await prepareRecordTimeSave(root, { node: String(original.value["node_id"]), patch: { name: "我的宇宙", terran_mappings: [{ range: { start: { kind: "calendar", era: "AD", year: 2000 } }, edited_at: later }] }, timestamp: later, synchronize: "all" }));
  const plan = await prepareRecordTimeRestore(root, { node: String(original.value["node_id"]), timestamp: later, anchor: { date: "2026-09-12", offset: "+08:00" }, synchronize: "all" }); await commitRecordTimeSave(root, plan);
  const restored = (await readStoredRecord(root, "contentTime", original.path)).value;
  assert.equal(restored["name"], "我的宇宙"); const range = ((restored["terran_mappings"] as JsonObject[])[0]!["range"] as JsonObject);
  assert.equal((range["start"] as JsonObject)["value"], "138.0"); assert.deepEqual((range["start"] as JsonObject)["anchor"], { date: "2026-09-12", offset: "+08:00" });
  const before = await readFile(path.join(root, original.path)); await readRecordTimes(root); assert.deepEqual(await readFile(path.join(root, original.path)), before);
}));

test("explicit custom-node deletion removes only selected nodes, reports affected Marks and preserves their snapshots", async () => temporary(async root => {
  const axis = await createRecordTime(root, { fields: { kind: "timeline", name: "L", author: "老婆" }, timestamp });
  const child = await createRecordTime(root, { fields: { kind: "single", name: "A" }, parent: String(axis.node["node_id"]), timestamp });
  const parent = await createRecordTime(root, { fields: { kind: "timeline", name: "P", author: "老婆", contains: [{ node: axis.node["node_id"]! }] }, timestamp });
  const mark: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: uuidV7(), edited_at: timestamp, content_time: { range: { start: await (await readRecordTimes(root)).graph.snapshot({ node: String(child.node["node_id"]), timeline: String(axis.node["node_id"]) }) } } };
  const markPath = `Marks/${mark["mark_id"]}.json`; await commitRecords(root, [{ action: "write", kind: "mark", path: markPath, value: mark, expected: null }]); const before = await readFile(path.join(root, markPath));
  const plan = await prepareRecordTimeDelete(root, { nodes: [String(axis.node["node_id"])], links: "remove", timestamp: later });
  assert.deepEqual(plan.retainedMarks, [mark["mark_id"]]); assert.deepEqual(plan.linkedNodes, [parent.node["node_id"]]);
  await commitRecordTimeDelete(root, plan); const after = await readRecordTimes(root);
  assert(after.nodes.some(n => n.value["node_id"] === child.node["node_id"])); assert(!after.nodes.some(n => n.value["node_id"] === axis.node["node_id"]));
  assert.deepEqual((await readStoredRecord(root, "contentTime", parent.path)).value["contains"], []); assert.deepEqual(await readFile(path.join(root, markPath)), before);
}));

test("cancel reference clears the whole time but retains other settings, including explicit empty models", async () => temporary(async root => {
  const node = await createRecordTime(root, { fields: { kind: "single", name: "T" }, timestamp }), graph = (await readRecordTimes(root)).graph;
  const first: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: uuidV7(), edited_at: timestamp, content_time: { range: { start: await graph.snapshot({ node: String(node.node["node_id"]) }) } } };
  const second = { ...structuredClone(first), mark_id: uuidV7(), target: uuidV7(), models: [] };
  for (const mark of [first, second]) await commitRecords(root, [{ action: "write", kind: "mark", path: `Marks/${mark["mark_id"]}.json`, value: mark, expected: null }]);
  const originalNode = await readFile(path.join(root, node.path)), plan = await prepareRecordTimeUnlink(root, { node: String(node.node["node_id"]), marks: [String(first["mark_id"]), String(second["mark_id"])], timestamp: later });
  assert.equal(plan.targets.length, 2); await commitRecordTimeUnlink(root, plan);
  await assert.rejects(readStoredRecord(root, "mark", `Marks/${first["mark_id"]}.json`));
  const kept = (await readStoredRecord(root, "mark", `Marks/${second["mark_id"]}.json`)).value; assert.deepEqual(kept["models"], []); assert(!kept["content_time"]);
  assert.deepEqual(await readFile(path.join(root, node.path)), originalNode);
}));

test("duplicate concrete start/end mappings are rejected regardless of their editing timestamps", async () => temporary(async root => {
  const range = { start: { kind: "calendar", era: "AD", year: 2026 } };
  await assert.rejects(createRecordTime(root, { fields: { kind: "single", name: "Duplicate", terran_mappings: [{ range, edited_at: timestamp }, { range: structuredClone(range), edited_at: later }] }, timestamp }), /already mapped/);
  assert.equal((await readRecordTimes(root)).nodes.length, 17);
}));
