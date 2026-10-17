import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { RecordTimeGraph } from "../../../src/core/records/time-graph.mts";
import { planRecordTimeEdit, RecordTimeComputationLimit } from "../../../src/core/records/time-edit.mts";
import { validateRecord } from "../../../src/core/records/index.mts";

const timestamp = "2026-09-11T22:00:00Z", later = "2026-09-11T23:00:00Z";
const node = (name: string, extra: JsonObject = {}): JsonObject => ({ schema: "cloudig/content-time/1.0.0", node_id: uuidV7(), kind: "single", name, edited_at: timestamp, ...extra });
const id = (n: JsonObject) => String(n["node_id"]);
const axis = (name: string) => node(name, { kind: "timeline", author: "晨星", version: "1.0", created_at: timestamp });
async function mark(nodes: JsonObject[], target: { node: string; timeline?: string; occurrences?: JsonObject }): Promise<JsonObject> {
  return { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: uuidV7(), edited_at: timestamp, content_time: { range: { start: await new RecordTimeGraph(nodes).snapshot(target) } } };
}
const start = (m: JsonObject): JsonObject => ((m["content_time"] as JsonObject)["range"] as JsonObject)["start"] as JsonObject;

test("all synchronization keeps UUIDs and changes only genuinely affected Mark endpoints", async () => {
  const a = node("A"), b = node("B"), nodes = [a, b], ma = await mark(nodes, { node: id(a) }), mb = await mark(nodes, { node: id(b) });
  const before = JSON.stringify({ nodes, marks: [ma, mb] });
  const result = await planRecordTimeEdit({ nodes, marks: [ma, mb], node: id(a), patch: { name: "A edited" }, timestamp: later, synchronize: "all" });
  assert.deepEqual(result.affected, [ma["mark_id"]]); assert.equal(result.copies.size, 0); assert.equal(result.nodes[0]!["node_id"], id(a)); assert.equal(result.marks.length, 1);
  assert.equal(((start(result.marks[0]!)["snapshot"] as JsonObject)["node"] as JsonObject)["name"], "A edited");
  assert.equal(JSON.stringify({ nodes, marks: [ma, mb] }), before); assert.equal(validateRecord("mark", result.marks[0]).ok, true);
});

test("partial synchronization preserves old axis and unselected Mark, copying shared descendants once", async () => {
  const l = axis("旧轴"), a = node("A"), b = node("B"); l["contains"] = [{ node: id(a) }, { node: id(b) }]; a["contains"] = [{ node: id(b) }];
  const nodes = [l, a, b], ma = await mark(nodes, { node: id(a), timeline: id(l) }), mb = await mark(nodes, { node: id(b), timeline: id(l) });
  const before = JSON.stringify({ nodes, ma, mb });
  const result = await planRecordTimeEdit({ nodes, marks: [ma, mb], node: id(l), patch: { name: "新轴" }, timestamp: later, synchronize: new Set([String(ma["mark_id"])]) });
  assert.equal(result.copies.size, 3); assert.equal(result.marks.length, 1); assert.equal(result.marks[0]!["mark_id"], ma["mark_id"]);
  const target = start(result.marks[0]!)["target"] as JsonObject; assert.equal(target["node"], result.copies.get(id(a))); assert.equal(target["timeline"], result.copies.get(id(l)));
  assert(result.nodes.every(n => n["forked_from"] && n["node_id"] !== n["forked_from"])); assert.equal(JSON.stringify({ nodes, ma, mb }), before);
});

test("the same selected node in two reference axes preserves both contexts without owner or family", async () => {
  const l = axis("L"), r = axis("R"), a = node("A"); l["contains"] = [{ node: id(a) }]; r["contains"] = [{ node: id(a) }];
  const nodes = [l, r, a], ml = await mark(nodes, { node: id(a), timeline: id(l) }), mr = await mark(nodes, { node: id(a), timeline: id(r) });
  const result = await planRecordTimeEdit({ nodes, marks: [ml, mr], node: id(a), patch: { name: "A2" }, timestamp: later, synchronize: new Set([String(ml["mark_id"]), String(mr["mark_id"])]) });
  assert.equal(result.copies.size, 3); assert.equal(result.marks.length, 2);
  assert.deepEqual(result.marks.map(m => (start(m)["target"] as JsonObject)["timeline"]), [result.copies.get(id(l)), result.copies.get(id(r))]);
  assert(!JSON.stringify(result.nodes).includes('"owner"')); assert(!JSON.stringify(result.nodes).includes('"lineage"'));
});

test("no synchronization can shrink a periodic independent copy while its old axis keeps its old range", async () => {
  const l = axis("L"), p = node("P", { kind: "periodic", count: 100 }); l["contains"] = [{ node: id(p), count: 100 }];
  const nodes = [l, p], m = await mark(nodes, { node: id(p), timeline: id(l), occurrences: { first: 99, step: 1, last: 99 } });
  await assert.rejects(planRecordTimeEdit({ nodes, marks: [m], node: id(p), patch: { count: 10 }, timestamp: later, synchronize: "all" }), /relations/);
  const result = await planRecordTimeEdit({ nodes, marks: [m], node: id(p), patch: { count: 10 }, timestamp: later, synchronize: new Set() });
  assert.equal(result.nodes.length, 1); assert.equal(result.nodes[0]!["count"], 10); assert.equal(p["count"], 100); assert.equal(result.marks.length, 0);
});

test("external incoming counterpart is copied on the new side and no external original is changed", async () => {
  const a = node("A"), outside = node("Outside"); outside["counterparts"] = [{ target: { node: id(a) } }];
  const before = JSON.stringify(outside), result = await planRecordTimeEdit({ nodes: [a, outside], marks: [], node: id(a), patch: { name: "A2" }, timestamp: later, synchronize: new Set() });
  assert.equal(result.nodes.length, 1); assert.deepEqual(result.nodes[0]!["counterparts"], [{ target: { node: id(outside) } }]); assert.equal(JSON.stringify(outside), before);
  assert.doesNotThrow(() => new RecordTimeGraph([a, outside, ...result.nodes]));
});

test("equal edits do not create UUIDs, copies, or edited timestamps", async () => {
  const a = node("A"), result = await planRecordTimeEdit({ nodes: [a], marks: [], node: id(a), patch: { name: "A" }, timestamp: later, synchronize: new Set() });
  assert(result.unchanged); assert.equal(result.nodes.length, 0); assert.equal(result.copies.size, 0); assert.equal(a["edited_at"], timestamp);
});

test("impact computation has one aggregate budget and never returns a partial synchronization plan", async () => {
  const a = node("A"), m = await mark([a], { node: id(a) });
  await assert.rejects(planRecordTimeEdit({ nodes: [a], marks: [m], node: id(a), patch: { name: "changed" }, timestamp: later, synchronize: "all", states: 1 }), RecordTimeComputationLimit);
  assert.equal(a["name"], "A"); assert.equal(m["edited_at"], timestamp);
});

test("removing an externally stored relation without sync creates only the edited endpoint copy", async () => {
  const a = node("A"), b = node("B"); a["counterparts"] = [{ target: { node: id(b) } }];
  const original = JSON.stringify(a), result = await planRecordTimeEdit({ nodes: [a, b], marks: [], node: id(b), patch: {}, relatedPatches: new Map([[id(a), { counterparts: [] }]]), timestamp: later, synchronize: new Set() });
  assert.equal(result.nodes.length, 1); assert.equal(result.copies.get(id(b)), result.nodes[0]!["node_id"]); assert.equal(result.nodes[0]!["counterparts"], undefined);
  assert.equal(JSON.stringify(a), original); assert.equal(new RecordTimeGraph([a, b, ...result.nodes]).directCounterparts(String(result.nodes[0]!["node_id"])).length, 0);
});
