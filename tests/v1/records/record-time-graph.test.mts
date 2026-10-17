import assert from "node:assert/strict";
import test from "node:test";
import { RecordTimeGraph } from "../../../src/core/records/time-graph.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { validateRecord } from "../../../src/core/records/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const timestamp = "2026-09-11T22:00:00Z";
const node = (name: string, extra: JsonObject = {}): JsonObject => ({ schema: "cloudig/content-time/1.0.0", node_id: uuidV7(), kind: "single", name, edited_at: timestamp, ...extra });
const year = (value: number): JsonObject => ({ kind: "calendar", era: "AD", year: value });
const id = (n: JsonObject) => String(n["node_id"]);
const mapping = (start: number, end?: number): JsonObject => ({ range: { start: year(start), ...(end ? { end: year(end) } : {}) }, edited_at: timestamp });

test("counterparts are stored once, display only direct edges and compute transitive earliest Terran ranges", async () => {
  const a = node("贞观元年"), b = node("另一种纪年"), c = node("公历627年", { terran_mappings: [mapping(627, 628), mapping(650)] });
  a["counterparts"] = [{ target: { node: id(b) } }]; b["counterparts"] = [{ target: { node: id(c) } }];
  const graph = new RecordTimeGraph([a, b, c]);
  assert.deepEqual(graph.directCounterparts(id(a)).map(e => e.node), [id(b)]);
  assert.deepEqual(graph.directCounterparts(id(c)).map(e => e.node), [id(b)]);
  const mapped = await graph.mappedRanges({ node: id(a) }); assert.equal(mapped.status, "complete"); assert.equal(mapped.ranges.length, 2);
  const endpoint = await graph.snapshot({ node: id(a) }); const snapshot = endpoint["snapshot"] as JsonObject;
  assert.deepEqual(snapshot["sort"], { start: year(627), end: year(628) });
  const mark = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: uuidV7(), edited_at: timestamp, content_time: { range: { start: endpoint } } };
  assert.equal(validateRecord("mark", mark).ok, true); assert(!JSON.stringify(endpoint).includes("lineage")); assert(!JSON.stringify(endpoint).includes("revision"));
});

test("contains cycles and multiple parents preserve first reachable order without inventing equality", async () => {
  const root = node("轴", { kind: "timeline", author: "老婆", created_at: timestamp, version: "1.0", terran_mappings: [mapping(2000)] }), a = node("无限久前"), b = node("共同子节点");
  root["contains"] = [{ node: id(a) }, { node: id(b) }]; a["contains"] = [{ node: id(root) }, { node: id(b) }];
  const graph = new RecordTimeGraph([root, a, b]); const found = await graph.path(id(root), id(b)); assert.deepEqual(found.path, [1, 2]);
  const endpoint = await graph.snapshot({ node: id(b), timeline: id(root) });
  assert.deepEqual((endpoint["snapshot"] as JsonObject)["path"], [1, 2]); assert(!(endpoint["snapshot"] as JsonObject)["sort"]);
  assert.equal(((endpoint["snapshot"] as JsonObject)["timeline"] as JsonObject)["author"], "老婆");
});

test("large periodic selections are intersected algebraically and included prefixes constrain Mark selection", async () => {
  const root = node("周期轴", { kind: "timeline", author: "A", created_at: timestamp }), a = node("轮回", { kind: "periodic", count: 99999999 }), b = node("映射目标", { kind: "periodic", count: 99999999 });
  root["contains"] = [{ node: id(a), count: 3 }];
  a["counterparts"] = [{ occurrences: { first: 1, step: 2, last: 99999999 }, target: { node: id(b), occurrences: { all: true } } }];
  b["terran_mappings"] = [{ ...mapping(2026), occurrences: { first: 2, step: 2, last: 99999998 } }];
  const graph = new RecordTimeGraph([root, a, b]);
  assert.equal((await graph.mappedRanges({ node: id(a), occurrences: { first: 2, step: 1, last: 2 } })).ranges.length, 0);
  const result = await graph.mappedRanges({ node: id(a), occurrences: { first: 1, step: 1, last: 1 } }); assert.equal(result.ranges.length, 1); assert(result.visited <= 4);
  await assert.rejects(graph.snapshot({ node: id(a), timeline: id(root), occurrences: { first: 5, step: 1, last: 5 } }), /included prefix/);
  assert(await graph.snapshot({ node: id(a), timeline: id(root), occurrences: { first: 3, step: 1, last: 3 } }));
  await assert.rejects(graph.snapshot({ node: id(a), occurrences: { all: true } }), /out of bounds/);
});

test("missing relations and exhausted computation never publish a partial sorting answer", async () => {
  const a = node("A", { terran_mappings: [mapping(2)] }), b = node("B", { terran_mappings: [mapping(1)] }); a["counterparts"] = [{ target: { node: id(b) } }];
  const graph = new RecordTimeGraph([a, b]); assert.deepEqual((await graph.mappedRanges({ node: id(a) }, { states: 1 })).ranges, []);
  await assert.rejects(graph.snapshot({ node: id(a) }, { states: 1 }), /incomplete/);
  b["counterparts"] = [{ target: { node: uuidV7() } }]; const missing = new RecordTimeGraph([a, b]);
  assert(missing.issues.some(i => i.code === "CLOUDIG_REFERENCE_MISSING")); assert.equal((await missing.mappedRanges({ node: id(a) })).status, "missing");
  const controller = new AbortController(); controller.abort(); await assert.rejects(graph.mappedRanges({ node: id(a) }, { signal: controller.signal }), { name: "AbortError" });
});

test("duplicated opposite-direction counterpart facts are rejected, not silently collapsed", () => {
  const a = node("A"), b = node("B"); a["counterparts"] = [{ target: { node: id(b) } }]; b["counterparts"] = [{ target: { node: id(a) } }];
  assert.throws(() => new RecordTimeGraph([a, b]), /stored once/);
});

test("top-level order is distinct from contains order and never injects absent nodes", () => {
  const a = node("A"), b = node("B", { edited_at: "2026-09-12T00:00:00Z" }), c = node("C"); a["contains"] = [{ node: id(c) }, { node: id(b) }];
  const graph = new RecordTimeGraph([a, b, c]); assert.deepEqual(graph.ordered([id(c), "missing", id(c)]), [id(c), id(b), id(a)]);
  assert.deepEqual((graph.nodes.get(id(a))!["contains"] as JsonObject[]).map(r => r["node"]), [id(c), id(b)]);
});

test("unknown and whenever mappings retain their special meaning in an offline snapshot", async () => {
  const a = node("某时", { terran_mappings: [{ range: { start: { kind: "unknown" } }, edited_at: timestamp }] });
  const value = await new RecordTimeGraph([a]).snapshot({ node: id(a) });
  assert.deepEqual((value["snapshot"] as JsonObject)["sort"], { start: { kind: "unknown" } });
});
