import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordTimes, createRecordTime, reorderRecordTimes, prepareRecordTimeSave, prepareRecordTimeDelete } from "../../../src/adapters/library-data/record-time.mts";
import { RecordSchemaError } from "../../../src/core/records/errors.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T23:00:00Z";
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "time-store-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained time store test: ${root}`); }
}

test("new Library has real preset nodes and node selection creates a valid small snapshot without rewriting defaults", async () => temporary(async root => {
  const before = await readRecordTimes(root); assert.equal(before.nodes.length, 17); assert.equal(before.issues.length, 0);
  const preset = before.nodes.find(n => n.value["name"] === "宇宙诞生")!, timeline = before.nodes.find(n => n.value["kind"] === "timeline")!;
  const bytes = await readFile(path.join(root, preset.path));
  const selected = await before.graph.snapshot({ node: String(preset.value["node_id"]), timeline: String(timeline.value["node_id"]) }); assert((selected["snapshot"] as JsonObject)["sort"]);
  assert.deepEqual(await readFile(path.join(root, preset.path)), bytes); assert.equal((await readRecordTimes(root)).order.sha256, before.order.sha256);
}));

test("a created axis and time each own an independent UUID file; parent inclusion is one atomic save", async () => temporary(async root => {
  const axis = await createRecordTime(root, { fields: { kind: "timeline", name: "星河", author: "晨星", version: "1.0" }, timestamp });
  const time = await createRecordTime(root, { fields: { kind: "periodic", name: "纪", count: 100, prefix: "第", unit: "纪" }, parent: String(axis.node["node_id"]), includedCount: 20, timestamp });
  const catalog = await readRecordTimes(root); assert.equal(catalog.nodes.length, 19); assert.equal(catalog.issues.length, 0);
  const parent = catalog.nodes.find(n => n.value["node_id"] === axis.node["node_id"])!.value;
  assert.deepEqual(parent["contains"], [{ node: time.node["node_id"], count: 20 }]); assert.equal(time.path, `ContentTimes/${time.node["node_id"]}.json`);
  assert(!JSON.stringify(parent).includes("owner")); assert(!JSON.stringify(time.node).includes("variant"));
  const before = await readFile(path.join(root, axis.path));
  await assert.rejects(createRecordTime(root, { fields: { kind: "periodic", name: "越界", count: 10 }, parent: String(axis.node["node_id"]), includedCount: 20, timestamp }));
  assert.deepEqual(await readFile(path.join(root, axis.path)), before); assert.equal((await readdir(path.join(root, "ContentTimes"))).length, 20);
}));

test("display reordering is separate, rejects stale state and does not modify node files", async () => temporary(async root => {
  const first = await createRecordTime(root, { fields: { kind: "single", name: "A" }, timestamp }), second = await createRecordTime(root, { fields: { kind: "single", name: "B" }, timestamp });
  const before = await readRecordTimes(root), bytes = await readFile(path.join(root, first.path));
  assert.equal((before.order.value["nodes"] as string[])[0], second.node["node_id"], "new root nodes enter at the top, as specified");
  await reorderRecordTimes(root, { nodes: [String(second.node["node_id"]), String(first.node["node_id"])], expected: before.order.sha256, timestamp });
  const after = await readRecordTimes(root); assert.equal(after.graph.ordered(after.order.value["nodes"] as string[])[0], second.node["node_id"]); assert.deepEqual(await readFile(path.join(root, first.path)), bytes);
  await assert.rejects(reorderRecordTimes(root, { nodes: [], expected: before.order.sha256, timestamp }), /changed/);
}));

test("invalid external time files are reported and preserved, not silently repaired", async () => temporary(async root => {
  const file = path.join(root, "ContentTimes/broken.json"), bytes = '{"unexpected":true}'; await writeFile(file, bytes);
  const catalog = await readRecordTimes(root); assert(catalog.issues.some(i => i.path === "ContentTimes/broken.json")); assert.equal(catalog.nodes.length, 17); assert.equal(await readFile(file, "utf8"), bytes);
}));

for (const target of ["custom", "preset", "order"] as const) test(`unsupported ${target} time version cannot become a partial editable graph`, async () => temporary(async root => {
  const custom = await createRecordTime(root, { fields: { kind: "single", name: "Keep this node" }, timestamp });
  const before = await readRecordTimes(root);
  const selected = target === "order" ? before.order : target === "preset" ? before.nodes.find(n => n.value["name"] === "现代社会")! : before.nodes.find(n => n.path === custom.path)!;
  const file = path.join(root, selected.path), original = await readFile(file);
  const future = { ...selected.value, schema: target === "order" ? "cloudig/content-time-order/1.1.0" : "cloudig/content-time/1.1.0" };
  await writeFile(file, JSON.stringify(future)); // Simulate an external newer record, not a production write.
  const names = (await readdir(path.join(root, "ContentTimes"))).sort();
  const bytes = await Promise.all(names.map(name => readFile(path.join(root, "ContentTimes", name))));
  const library = await readFile(path.join(root, "CloudigLibrary.json"));
  const incompatible = (error: unknown) => error instanceof RecordSchemaError && error.code === "CLOUDIG_RECORD_SCHEMA_UNSUPPORTED" && /请更新采云|update Cloudig/u.test(error.message);
  await assert.rejects(readRecordTimes(root), incompatible);
  await assert.rejects(reorderRecordTimes(root, { nodes: [], expected: before.order.sha256, timestamp }), incompatible);
  await assert.rejects(createRecordTime(root, { fields: { kind: "single", name: "Must not write" }, timestamp }), incompatible);
  await assert.rejects(prepareRecordTimeSave(root, { node: String(custom.node["node_id"]), patch: { name: "Must not replace" }, timestamp, synchronize: "all" }), incompatible);
  await assert.rejects(prepareRecordTimeDelete(root, { nodes: [String(custom.node["node_id"])], links: "remove", timestamp }), incompatible);
  assert.deepEqual((await readdir(path.join(root, "ContentTimes"))).sort(), names);
  for (const [index, name] of names.entries()) assert.deepEqual(await readFile(path.join(root, "ContentTimes", name)), bytes[index]);
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), library);
  await writeFile(file, original);
  assert.equal((await readRecordTimes(root)).nodes.length, before.nodes.length, "Restoring supported bytes works without restarting or clearing caches");
}));
