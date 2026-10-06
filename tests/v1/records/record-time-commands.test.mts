import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { createRecordTime, readRecordTimes, prepareRecordTimeSave, commitRecordTimeSave } from "../../../src/adapters/library-data/record-time.mts";
import { RecordTimeEngineCommands } from "../../../src/engine/record-time-commands.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";
import { commitRecords, readStoredRecord } from "../../../src/adapters/storage/record-store.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { RecordSchemaError } from "../../../src/core/records/errors.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T22:00:00Z", later = "2026-09-11T23:00:00Z";
async function temporary(run: (root: string, commands: RecordTimeEngineCommands) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-time-engine-")); const commands = new RecordTimeEngineCommands({ libraryRoot: root }); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root, commands); passed = true; }
  finally { commands.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained Time Engine test: ${root}`); }
}
const context = () => ({ request: "q_record_time", signal: new AbortController().signal, emit: async () => undefined });
const call = (commands: RecordTimeEngineCommands) => async (name: string, payload: JsonObject): Promise<JsonObject> => { const result = await commands.handlers()[name]!(payload, context()); assertIpcValue(result); return result as JsonObject; };

test("a newer time file rejects queries and an already-open page's order save with the update-required code", async () => temporary(async (root, commands) => {
  const a = await createRecordTime(root, { fields: { kind: "single", name: "A" }, timestamp });
  const b = await createRecordTime(root, { fields: { kind: "single", name: "B" }, timestamp });
  const request = call(commands), cover = await request("time.cover.query", { return_to: "archiver" });
  const rows = (cover["sovereign"] as JsonObject)["items"] as JsonObject[], row = rows.find(n => n["name"] === "B")!;
  const orderFile = path.join(root, "ContentTimes/order.json"), orderBytes = await readFile(orderFile), aFile = path.join(root, a.path), original = await readFile(aFile);
  const futureBytes = Buffer.from(JSON.stringify({ ...a.node, schema: "cloudig/content-time/1.1.0" }));
  await writeFile(aFile, futureBytes);
  const incompatible = (error: unknown) => error instanceof RecordSchemaError && error.code === "CLOUDIG_RECORD_SCHEMA_UNSUPPORTED" && error.message.includes(a.path);
  await assert.rejects(request("time.cover.query", { return_to: "archiver" }), incompatible);
  await assert.rejects(request("time.sovereign.query", { route: cover["route"]!, offset: 0, limit: 10 }), incompatible);
  await assert.rejects(request("time.nodes.children", { route: cover["route"]!, node: row["node"]! }), incompatible);
  await assert.rejects(request("time.editor.query", { route: cover["route"]!, node: row["node"]! }), incompatible);
  const payload = { route: cover["route"]!, expected_time_revision: cover["revision"]!, expected_library_revision: cover["library_revision"]!, nodes: [...rows].reverse().map(n => n["node"]!) };
  await assert.rejects(request("time.order.commit", payload), incompatible);
  assert.deepEqual(await readFile(orderFile), orderBytes, "An unreadable node must never lose its order entry");
  assert.deepEqual(await readFile(aFile), futureBytes);
  assert.deepEqual((await readStoredRecord(root, "contentTime", b.path)).value, b.node);
  await writeFile(aFile, original);
  await request("time.order.commit", payload);
  assert.equal((await request("time.cover.query", { return_to: "archiver" }))["issues"] instanceof Array, true);
  assert.notDeepEqual(await readFile(orderFile), orderBytes, "The same session can reorder after compatible bytes return");
}));

test("Time Engine shows independent preset nodes, keeps a return route, and never rewrites records on query", async () => temporary(async (root, commands) => {
  const before = await readRecordTimes(root), bytes = await Promise.all(before.nodes.map(n => readFile(path.join(root, n.path)))), request = call(commands);
  const cover = await request("time.cover.query", { return_to: "archiver" }), terran = cover["terran"] as JsonObject, items = terran["items"] as JsonObject[];
  assert.equal(items.length, 16); assert.equal((cover["sovereign"] as JsonObject)["total"], 0); assert(items.every(n => n["kind"] === "single" && n["builtin"] && n["editable"]));
  assert.deepEqual(await request("time.route.resolve", { route: cover["route"]! }), { return_to: "archiver" });
  const modern = items.find(n => n["name"] === "现代社会")!;
  const preview = await request("time.endpoint.preview", { route: cover["route"]!, node: modern["node"]! });
  const range = await commands.resolveDraftRange({ start: preview["endpoint"]! }), start = range["start"] as JsonObject;
  assert.equal(start["kind"], "node"); assert.equal(((start["snapshot"] as JsonObject)["node"] as JsonObject)["name"], "现代社会");
  assert.match(String((start["target"] as JsonObject)["node"]), /^[a-f0-9-]{36}$/); assert.match(String((start["target"] as JsonObject)["timeline"]), /^[a-f0-9-]{36}$/);
  const projected = await request("time.range.preview", { range: { start: preview["endpoint"]! }, allow_sovereign: true, language: "zh-CN" }); assert(String(projected["summary"]).includes("现代社会"));
  for (const [i, n] of before.nodes.entries()) assert.deepEqual(await readFile(path.join(root, n.path)), bytes[i]);
  commands.close(); await assert.rejects(request("time.route.resolve", { route: cover["route"]! }), /stale/);
}));

test("children preserve a chosen reference axis and periodic prefix, while picker can find standalone times without owners", async () => temporary(async (root, commands) => {
  const axis = await createRecordTime(root, { fields: { kind: "timeline", name: "年", author: "老婆" }, timestamp });
  await createRecordTime(root, { fields: { kind: "periodic", name: "月", count: 12 }, parent: String(axis.node["node_id"]), includedCount: 6, timestamp });
  await createRecordTime(root, { fields: { kind: "single", name: "独立时刻" }, timestamp });
  const request = call(commands), cover = await request("time.cover.query", { return_to: "reader-cover" }), rows = (cover["sovereign"] as JsonObject)["items"] as JsonObject[];
  assert.equal(rows.length, 2); assert(rows.every(r => !Object.hasOwn(r, "owner") && !Object.hasOwn(r, "current") && !Object.hasOwn(r, "number")));
  const children = await request("time.nodes.children", { route: cover["route"]!, node: rows.find(r => r["name"] === "年")!["node"]! }), child = (children["items"] as JsonObject[])[0]!;
  assert.equal(child["included_count"], 6);
  const preview = await request("time.endpoint.preview", { route: cover["route"]!, node: child["node"]!, occurrences: { first: 2, step: 2, last: 6 } });
  const range = await commands.resolveDraftRange({ start: preview["endpoint"]! }); assert.equal(((range["start"] as JsonObject)["target"] as JsonObject)["timeline"], axis.node["node_id"]);
  await assert.rejects(request("time.endpoint.preview", { route: cover["route"]!, node: child["node"]!, occurrences: { first: 1, step: 1, last: 7 } }), /included prefix/);
  assert.equal((await request("time.sovereign.query", { route: cover["route"]!, offset: 0, limit: 100 }))["total"], 3);
  assert.equal((await request("time.sovereign.query", { route: cover["route"]!, offset: 0, limit: 100, top_level: true }))["total"], 2);
}));

test("stale fresh selections are rejected but projected stored snapshots remain readable without refreshing their anchor", async () => temporary(async (root, commands) => {
  const request = call(commands), cover = await request("time.cover.query", { return_to: "archiver" }), modern = ((cover["terran"] as JsonObject)["items"] as JsonObject[]).find(n => n["name"] === "现代社会")!;
  const fresh = (await request("time.endpoint.preview", { route: cover["route"]!, node: modern["node"]! }))["endpoint"]!;
  const stored = await commands.resolveDraftRange({ start: fresh }), projected = await commands.projectDraftRange(stored);
  const node = (await readRecordTimes(root)).nodes.find(n => n.value["name"] === "现代社会")!;
  await commitRecordTimeSave(root, await prepareRecordTimeSave(root, { node: String(node.value["node_id"]), patch: { name: "改名" }, synchronize: "all", timestamp: later }));
  await assert.rejects(commands.resolveDraftRange({ start: fresh }), /mapping changed/);
  assert.deepEqual(await commands.resolveDraftRange(projected), stored);
  await assert.rejects(commands.resolveDraftRange(stored), /current time picker/);
}));

test("top-level ordering preserves every node and writes only the display-order record", async () => temporary(async (root, commands) => {
  for (const name of ["A", "B"]) await createRecordTime(root, { fields: { kind: "single", name }, timestamp });
  const before = await readRecordTimes(root), request = call(commands), cover = await request("time.cover.query", { return_to: "archiver" }), rows = (cover["sovereign"] as JsonObject)["items"] as JsonObject[];
  const payload = { route: cover["route"]!, expected_time_revision: cover["revision"]!, expected_library_revision: cover["library_revision"]!, nodes: rows.map(r => r["node"]!).reverse() };
  await assert.rejects(request("time.order.commit", { ...payload, nodes: payload.nodes.slice(1) }), /preserve every/);
  const result = await request("time.order.commit", payload); assert.deepEqual((result["items"] as JsonObject[]).map(r => r["name"]), rows.map(r => r["name"]).reverse());
  const after = await readRecordTimes(root); assert.deepEqual(after.nodes.map(n => n.sha256), before.nodes.map(n => n.sha256)); assert.notEqual(after.order.sha256, before.order.sha256);
}));

async function editablePair(root: string, commands: RecordTimeEngineCommands) {
  const time = await createRecordTime(root, { fields: { kind: "single", name: "共同时间" }, timestamp });
  const endpoint = await (await readRecordTimes(root)).graph.snapshot({ node: String(time.node["node_id"]) }), marks: string[] = [], conversations: string[] = [];
  for (const title of ["A", "B"]) {
    const conversation = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8")) as JsonObject; conversation["conversation_id"] = uuidV7(); conversation["title"] = { filename: title, original: title };
    const mark: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: conversation["conversation_id"]!, edited_at: timestamp, models: [], content_time: { range: { start: structuredClone(endpoint) } } };
    marks.push(`Marks/${mark["mark_id"]}.json`); conversations.push(`Conversations/${title}.json`);
    await commitRecords(root, [{ action: "write", kind: "conversation", path: conversations.at(-1)!, value: conversation, expected: null }, { action: "write", kind: "mark", path: marks.at(-1)!, value: mark, expected: null }]);
  }
  const request = call(commands), cover = await request("time.cover.query", { return_to: "archiver" }), row = ((cover["sovereign"] as JsonObject)["items"] as JsonObject[]).find(r => r["name"] === "共同时间")!;
  const editor = await request("time.editor.query", { route: cover["route"]!, node: row["node"]! });
  const draft = (): JsonObject => ({ metadata: structuredClone(editor["metadata"]!), children: structuredClone(editor["children"]!), counterparts: structuredClone(editor["counterparts"]!), mappings: structuredClone(editor["mappings"]!) });
  return { time, marks, conversations, request, cover, row, editor, draft };
}

for (const strategy of ["all_references", "selected_references", "future_only"] as const) test(`Time Engine edit ${strategy} commits independent files and preserves every unselected original`, async () => temporary(async (root, commands) => {
  const data = await editablePair(root, commands), beforeTime = await readFile(path.join(root, data.time.path)), beforeMarks = await Promise.all(data.marks.map(p => readFile(path.join(root, p)))), sources = await Promise.all(data.conversations.map(p => readFile(path.join(root, p))));
  const draft = data.draft(); (draft["metadata"] as JsonObject)["name"] = "新的时间";
  const preview = await data.request("time.editor.preview", { route: data.cover["route"]!, action: "edit", node: data.row["node"]!, expected_node_revision: data.editor["node_revision"]!, draft });
  const affected = (preview["impact"] as JsonObject)["affected_references"] as JsonObject[]; assert.equal(affected.length, 2);
  assert.deepEqual(await readFile(path.join(root, data.time.path)), beforeTime);
  const selection = { plan: preview["plan"]!, strategy, selected_references: strategy === "selected_references" ? [affected.find(a => a["title"] === "A")!["reference"]!] : [] };
  if (strategy !== "all_references") { const scope = await data.request("time.editor.selection.preview", selection); assert.equal(scope["copy_count"], 1); }
  const result = await data.request("time.editor.commit", { ...selection, touch_on_noop: false });
  assert.equal(result["status"], "updated");
  const times = await readRecordTimes(root); assert.equal(times.nodes.length, strategy === "all_references" ? 18 : 19);
  if (strategy !== "all_references") assert.deepEqual(await readFile(path.join(root, data.time.path)), beforeTime);
  for (const [index, file] of data.marks.entries()) {
    const changed = strategy === "all_references" || strategy === "selected_references" && index === 0;
    if (!changed) assert.deepEqual(await readFile(path.join(root, file)), beforeMarks[index]);
    else { const mark = (await readStoredRecord(root, "mark", file)).value; assert(JSON.stringify(mark["content_time"]).includes("新的时间")); }
  }
  for (const [index, file] of data.conversations.entries()) assert.deepEqual(await readFile(path.join(root, file)), sources[index]);
}));

test("Time Engine cancellation and edit are one save; cancelled A keeps other settings while B receives the update", async () => temporary(async (root, commands) => {
  const data = await editablePair(root, commands), references = data.editor["references"] as JsonObject[], draft = data.draft(); (draft["metadata"] as JsonObject)["name"] = "改名";
  const preview = await data.request("time.editor.preview", { route: data.cover["route"]!, action: "edit", node: data.row["node"]!, draft, cancel_references: [references.find(r => r["title"] === "A")!["reference"]!] });
  assert.equal(((preview["impact"] as JsonObject)["affected_references"] as JsonObject[]).length, 1);
  await data.request("time.editor.commit", { plan: preview["plan"]!, strategy: "all_references", selected_references: [] });
  const a = await readStoredRecord(root, "mark", data.marks[0]!), b = await readStoredRecord(root, "mark", data.marks[1]!);
  assert(!Object.hasOwn(a.value, "content_time")); assert.deepEqual(a.value["models"], []); assert(JSON.stringify(b.value["content_time"]).includes("改名"));
}));

test("new Time Engine nodes require no owner; explicit delete removes that node and leaves Mark snapshots readable", async () => temporary(async (root, commands) => {
  const request = call(commands), cover = await request("time.cover.query", { return_to: "archiver" });
  const created = await request("time.editor.preview", { route: cover["route"]!, action: "create_time", draft: { metadata: { kind: "single", name: "没有所属轴" }, children: [], counterparts: [], mappings: [] } });
  const result = await request("time.editor.commit", { plan: created["plan"]!, strategy: "in_place", selected_references: [] }); assert.equal(result["status"], "updated");
  const data = await editablePair(root, commands), before = await Promise.all(data.marks.map(p => readFile(path.join(root, p))));
  const removal = await request("time.delete.preview", { route: data.cover["route"]!, node: data.row["node"]! });
  assert.equal((removal["impact"] as JsonObject)["snapshots_preserved"], true); assert.equal(((removal["impact"] as JsonObject)["affected_references"] as JsonObject[]).length, 2);
  await request("time.delete.commit", { plan: removal["plan"]! });
  for (const [index, file] of data.marks.entries()) assert.deepEqual(await readFile(path.join(root, file)), before[index]);
  assert(!(await readRecordTimes(root)).graph.nodes.has(String(data.time.node["node_id"])));
}));

test("unchanged editor preview writes nothing; late external Mark change invalidates the confirmation", async () => temporary(async (root, commands) => {
  const data = await editablePair(root, commands), unchanged = await data.request("time.editor.preview", { route: data.cover["route"]!, action: "edit", node: data.row["node"]!, draft: data.draft() });
  assert.equal(unchanged["no_change"], true);
  const draft = data.draft(); (draft["metadata"] as JsonObject)["name"] = "以后";
  const preview = await data.request("time.editor.preview", { route: data.cover["route"]!, action: "edit", node: data.row["node"]!, draft });
  const mark = await readStoredRecord(root, "mark", data.marks[0]!); mark.value["conversation_title"] = "外部编辑";
  await commitRecords(root, [{ action: "write", kind: "mark", path: data.marks[0]!, value: mark.value, expected: mark.sha256 }]);
  await assert.rejects(data.request("time.editor.commit", { plan: preview["plan"]!, strategy: "all_references", selected_references: [] }), /after preview/);
  assert.equal((await readStoredRecord(root, "contentTime", data.time.path)).value["name"], "共同时间");
}));

test("preset restore retains a custom name and its shortcut identity, and unchanged anchor refresh is previewed explicitly", async () => temporary(async (root, commands) => {
  const original = (await readRecordTimes(root)).nodes.find(n => n.value["name"] === "现代社会")!;
  await commitRecordTimeSave(root, await prepareRecordTimeSave(root, { node: String(original.value["node_id"]), timestamp: later, synchronize: "all", patch: { name: "我的现代", terran_mappings: [{ range: { start: { kind: "calendar", era: "AD", year: 2000 } }, edited_at: later }] } }));
  const request = call(commands), cover = await request("time.cover.query", { return_to: "archiver" }), row = ((cover["terran"] as JsonObject)["items"] as JsonObject[]).find(n => n["name"] === "我的现代")!; assert.equal(row["shortcut"], true);
  const editor = await request("time.editor.query", { route: cover["route"]!, node: row["node"]! }); assert.equal(editor["can_restore"], true);
  const draft = { metadata: editor["metadata"]!, children: editor["children"]!, counterparts: editor["counterparts"]!, mappings: editor["mappings"]!, restore_default_time: true };
  const preview = await request("time.editor.preview", { route: cover["route"]!, node: row["node"]!, action: "edit", draft });
  await request("time.editor.commit", { plan: preview["plan"]!, strategy: "in_place", selected_references: [] });
  const restored = await readStoredRecord(root, "contentTime", original.path); assert.equal(restored.value["name"], "我的现代"); assert(JSON.stringify(restored.value["terran_mappings"]).includes('"kind":"now"'));
  const nextCover = await request("time.cover.query", { return_to: "archiver" }), nextRow = ((nextCover["terran"] as JsonObject)["items"] as JsonObject[]).find(n => n["name"] === "我的现代")!;
  const nextEditor = await request("time.editor.query", { route: nextCover["route"]!, node: nextRow["node"]! });
  const refreshed = await request("time.editor.preview", { route: nextCover["route"]!, node: nextRow["node"]!, action: "edit", refresh_anchors: true, draft: { metadata: nextEditor["metadata"]!, children: nextEditor["children"]!, counterparts: nextEditor["counterparts"]!, mappings: nextEditor["mappings"]! } });
  assert.equal(refreshed["no_change"], false); assert.equal((await readStoredRecord(root, "contentTime", original.path)).sha256, restored.sha256);
}));

test("copy scope includes both selected reference axes, pages its names, and must be reviewed before committing", async () => temporary(async (root, commands) => {
  const data = await editablePair(root, commands);
  for (const [index, name] of ["甲轴", "乙轴"].entries()) {
    const axis = await createRecordTime(root, { fields: { kind: "timeline", name, author: "老婆", contains: [{ node: data.time.node["node_id"]! }] }, timestamp });
    const mark = await readStoredRecord(root, "mark", data.marks[index]!);
    mark.value["content_time"] = { range: { start: await (await readRecordTimes(root)).graph.snapshot({ node: String(data.time.node["node_id"]), timeline: String(axis.node["node_id"]) }) } };
    await commitRecords(root, [{ action: "write", kind: "mark", path: data.marks[index]!, expected: mark.sha256, value: mark.value }]);
  }
  const editor = await data.request("time.editor.query", { route: data.cover["route"]!, node: data.row["node"]! });
  const preview = await data.request("time.editor.preview", { route: data.cover["route"]!, node: data.row["node"]!, action: "edit", draft: { metadata: { ...(editor["metadata"] as JsonObject), name: "新时间" }, children: editor["children"]!, counterparts: editor["counterparts"]!, mappings: editor["mappings"]! } });
  const choice = { plan: preview["plan"]!, strategy: "selected_references", selected_references: ((preview["impact"] as JsonObject)["affected_references"] as JsonObject[]).map(r => r["reference"]!) };
  await assert.rejects(data.request("time.editor.commit", choice), /actual independent-copy scope/); assert.equal((await readRecordTimes(root)).nodes.length, 20);
  const first = await data.request("time.editor.selection.preview", { ...choice, offset: 0, limit: 1 });
  assert.equal(first["copy_count"], 3); assert.equal(first["updated_count"], 2); assert.equal((first["copies"] as JsonObject[]).length, 1);
  const second = await data.request("time.editor.selection.preview", { ...choice, offset: 1, limit: 2 });
  const names = [...first["copies"] as JsonObject[], ...second["copies"] as JsonObject[]].map(n => n["name"]).sort(); assert.deepEqual(names, ["新时间", "甲轴", "乙轴"].sort());
  await data.request("time.editor.commit", choice); assert.equal((await readRecordTimes(root)).nodes.length, 23);
}));

test("periodic source, target and Terran-mapping selections survive the Engine round trip independently", async () => temporary(async (root, commands) => {
  const source = await createRecordTime(root, { fields: { kind: "periodic", name: "源周期", count: 12 }, timestamp });
  await createRecordTime(root, { fields: { kind: "periodic", name: "目标周期", count: 12 }, timestamp });
  const request = call(commands), cover = await request("time.cover.query", { return_to: "archiver" }), rows = (cover["sovereign"] as JsonObject)["items"] as JsonObject[];
  const sourceRow = rows.find(r => r["name"] === "源周期")!, targetRow = rows.find(r => r["name"] === "目标周期")!;
  const editor = await request("time.editor.query", { route: cover["route"]!, node: sourceRow["node"]! });
  const a = { first: 1, step: 2, last: 11 }, b = { first: 2, step: 2, last: 12 }, c = { first: 3, step: 3, last: 12 };
  const preview = await request("time.editor.preview", { route: cover["route"]!, node: sourceRow["node"]!, action: "edit", draft: { metadata: editor["metadata"]!, children: [], counterparts: [{ target: { node: targetRow["node"]!, occurrences: b }, self_occurrences: a }], mappings: [{ range: { start: { kind: "calendar", era: "AD", year: 2030 } }, occurrences: c }] } });
  await request("time.editor.commit", { plan: preview["plan"]!, strategy: "in_place", selected_references: [] });
  const stored = (await readStoredRecord(root, "contentTime", source.path)).value, relation = (stored["counterparts"] as JsonObject[])[0]!;
  assert.deepEqual(relation["occurrences"], a); assert.deepEqual((relation["target"] as JsonObject)["occurrences"], b); assert.deepEqual((stored["terran_mappings"] as JsonObject[])[0]!["occurrences"], c);
  const reverse = await request("time.editor.query", { route: cover["route"]!, node: targetRow["node"]! }), projected = (reverse["counterparts"] as JsonObject[])[0]!;
  assert.deepEqual(projected["self_occurrences"], b); assert.deepEqual((projected["target"] as JsonObject)["occurrences"], a);
}));
