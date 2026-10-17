import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { commitRecords } from "../../../src/adapters/storage/record-store.mts";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
import { readConversationRecord } from "../../../src/adapters/library-data/record-reading.mts";
import { RuntimeConversationViews } from "../../../src/adapters/runtime/conversation-views.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { RecordReaderEngineCommands } from "../../../src/engine/record-reader-commands.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T22:00:00Z";
const builtins = { user: { name: "User", avatar: "Assets/Defaults/user.svg" }, assistant: { name: "AI", avatar: "Assets/Defaults/assistant.svg" }, platforms: {} };
const page = { page: { offset: 0, limit: 20 }, navigationPage: { offset: 0, limit: 20 }, branchPage: { offset: 0, limit: 20 } };
const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
async function temporary(run: (root: string, runtime: string, views: RuntimeConversationViews, reading: Awaited<ReturnType<typeof readConversationRecord>>, data: Buffer) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-runtime-")); let passed = false;
  await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } });
  const c = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8")) as JsonObject;
  const data = Buffer.from([0, 1, 2, 255]), user = (c["identity"] as JsonObject[]).find(f => f["role"] === "user")!["source_id"]!;
  c["messages"] = { items: [{ id: "actual-source-id", speaker: user, content: [{ type: "markdown", text: "多行正文\n".repeat(80000) + "\u0000" }, { type: "attachment", resource: "r1" }] }] };
  c["resources"] = [{ id: "r1", kind: "file", availability: "embedded", name: "file.bin", mime: "application/octet-stream", bytes: data.length, sha256: sha(data), data_base64: [data.subarray(0, 1).toString("base64"), data.subarray(1).toString("base64")] }];
  await commitRecords(root, [{ action: "write", path: "Conversations/Runtime.json", kind: "conversation", expected: null, value: c }]);
  const cache = await createRuntimeCacheSession(path.join(root, "cache"), root), views = new RuntimeConversationViews({ libraryRoot: root, runtimeRoot: cache.root });
  try { await run(root, cache.root, views, await readConversationRecord(root, String(c["conversation_id"]), builtins), data); passed = true; }
  finally {
    await views.closeAll(); await cache.close();
    if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained runtime test: ${root}`);
  }
}
const disk = (runtime: string, virtual: string) => path.join(runtime, "Views", ...virtual.slice(1).split("/"));

test("new record pages retain large/control-character body outside IPC and resource bytes stay behind capabilities", async () => temporary(async (root, runtime, views, reading, data) => {
  const original = await readFile(path.join(root, "Conversations/Runtime.json")), opened = await views.openRecord({ reading, page });
  assert.doesNotThrow(() => assertIpcValue(opened)); assert(opened.page.bytes > 1024 * 1024);
  const text = await readFile(disk(runtime, opened.page.virtual_path), "utf8"), value = JSON.parse(text);
  assert(text.includes("\\u0000")); assert(!text.includes("data_base64")); assert.throws(() => assertIpcValue(value));
  const [first, second] = await Promise.all([views.materializeResource({ token: opened.token, resource: "r1" }), views.materializeResource({ token: opened.token, resource: "r1" })]);
  assert.equal(first.capability, second.capability); assert.deepEqual(await readFile(disk(runtime, first.virtual_path)), data); assert.doesNotThrow(() => assertIpcValue(first));
  const manifest = JSON.parse(await readFile(path.join(runtime, "Views", opened.token, "manifest.json"), "utf8"));
  assert.equal(manifest.schema, "cloudig/runtime-view/2.0.0"); assert.equal(manifest.conversation_id, reading.conversation["conversation_id"]); assert(!("archive" in manifest)); assert(!("generation" in manifest));
  await unlink(disk(runtime, first.virtual_path)); const rebuilt = await views.materializeResource({ token: opened.token, resource: "r1" }); assert.deepEqual(await readFile(disk(runtime, rebuilt.virtual_path)), data);
  assert.deepEqual(await readFile(path.join(root, "Conversations/Runtime.json")), original);
}));

test("new record identities use Identities/Images, while builtins retain application capabilities", async () => temporary(async (root, runtime, views, reading) => {
  const image = "Identities/Images/avatar.png", bytes = Buffer.from("a test avatar payload"); await mkdir(path.dirname(path.join(root, image)), { recursive: true }); await writeFile(path.join(root, image), bytes);
  const opened = await views.openRecord({ reading: { ...reading, resolved: { ...reading.resolved, userAvatar: image } }, page });
  const projection = JSON.parse(await readFile(disk(runtime, opened.page.virtual_path), "utf8"));
  const avatar = projection.messages[0].party.avatar;
  const resolved = await views.resolveIdentity({ token: opened.token, identity: avatar }); assert.equal(resolved.kind, "runtime");
  if (resolved.kind === "runtime") assert.deepEqual(await readFile(disk(runtime, resolved.asset.virtual_path)), bytes);
}));

test("opening another record view revokes the old one; source changes reject further page reads", async () => temporary(async (root, runtime, views, reading) => {
  const first = await views.openRecord({ reading, page }), second = await views.openRecord({ reading, page });
  await assert.rejects(views.page(first.token, page), /stale|revoked/); assert.equal((await readdir(path.join(runtime, "Views"))).length, 1);
  await writeFile(path.join(root, "Conversations/Runtime.json"), (await readFile(path.join(root, "Conversations/Runtime.json"), "utf8")) + "\n");
  await assert.rejects(views.page(second.token, page), /changed/);
  assert.equal(await views.close(second.token), "removed"); assert.deepEqual(await readdir(path.join(runtime, "Views")), []);
}));

test("real Reader Engine sends only virtual capabilities and supports source branch IDs plus resource and avatar requests", async () => temporary(async (root, runtime, _views, reading, data) => {
  const relative = "Conversations/Runtime.json", raw = JSON.parse(await readFile(path.join(root, relative), "utf8")) as JsonObject;
  const messages = (raw["messages"] as JsonObject)["items"] as JsonObject[];
  messages.push({ id: "source-left-uuid", parent: "actual-source-id", speaker: "assistant-1", content: [{ type: "markdown", text: "LEFT ANSWER" }] }, { id: "source-right-uuid", parent: "actual-source-id", speaker: "assistant-1", content: [{ type: "markdown", text: "RIGHT ANSWER" }] });
  (raw["messages"] as JsonObject)["current"] = "source-left-uuid";
  await commitRecords(root, [{ action: "write", kind: "conversation", path: relative, expected: reading.evidence.conversation.sha256, value: raw }]);
  const original = await readFile(path.join(root, relative)), engine = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: runtime, builtins });
  const context = { request: "q_reader_runtime", signal: new AbortController().signal, emit: async () => undefined }, handlers = engine.handlers();
  const call = async (name: string, payload: JsonObject): Promise<JsonObject> => { const value = await handlers[name]!(payload, context); assertIpcValue(value); return value as JsonObject; };
  const request: JsonObject = { messages: page.page, navigation: page.navigationPage, branches: page.branchPage };
  try {
    const listed = await call("reader.archives.query", { offset: 0, limit: 100 }), archive = (listed["items"] as JsonObject[])[0]!["capability"]!;
    const opened = await call("reader.view.open", { archive, request }), view = opened["token"]!;
    const first = JSON.parse(await readFile(disk(runtime, String((opened["page"] as JsonObject)["virtual_path"])), "utf8"));
    assert.throws(() => assertIpcValue(first)); assert(JSON.stringify(first.messages).includes("LEFT ANSWER")); assert(!JSON.stringify(first.messages).includes("RIGHT ANSWER"));
    const selected = await call("reader.view.page", { view, request: { ...request, session: { selected_leaf: "source-right-uuid", branch_choices: { "actual-source-id": "source-right-uuid" }, expanded: { reasoning: false, tools: false, references: false }, hidden: { reasoning: false, tools: false }, navigation: { user: true, assistant: true, process: false } } } });
    const second = JSON.parse(await readFile(disk(runtime, String(selected["virtual_path"])), "utf8")); assert(JSON.stringify(second.messages).includes("RIGHT ANSWER")); assert(!JSON.stringify(second.messages).includes("LEFT ANSWER"));
    const resource = await call("reader.resource.materialize", { view, resource: "r1" }); assert.deepEqual(await readFile(disk(runtime, String(resource["virtual_path"]))), data);
    const avatar = await call("reader.identity.resolve", { view, identity: second.messages[0].party.avatar }); assert.equal(avatar["kind"], "application");
    await call("reader.view.close", { view }); await assert.rejects(call("reader.view.page", { view, request }));
    const reopened = await call("reader.view.open", { archive, request }); const reset = JSON.parse(await readFile(disk(runtime, String((reopened["page"] as JsonObject)["virtual_path"])), "utf8")); assert(JSON.stringify(reset.messages).includes("LEFT ANSWER")); assert(!JSON.stringify(reset.messages).includes("RIGHT ANSWER"));
    assert.deepEqual(await readFile(path.join(root, relative)), original);
  } finally { await engine.close(); }
  assert.deepEqual(await readdir(path.join(runtime, "Views")), []);
}));
