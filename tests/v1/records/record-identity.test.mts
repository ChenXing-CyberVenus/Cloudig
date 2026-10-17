import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordIdentityState, commitRecordIdentity } from "../../../src/adapters/library-data/record-identity.mts";
import { readStoredRecord, commitRecords } from "../../../src/adapters/storage/record-store.mts";
import { readConversationRecord } from "../../../src/adapters/library-data/record-reading.mts";
import { frontName } from "../../../src/core/records/front.mts";
import { projectRecordForReading } from "../../../src/core/records/presentation.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { encodeRecord } from "../../../src/core/records/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T18:00:00Z", later = "2026-09-11T19:00:00Z", obj = (v: unknown) => v as JsonObject;
const builtins = { user: { name: "采云用户", avatar: "app/user.svg", localizedNames: { en: "User" } }, assistant: { name: "智能伙伴", avatar: "app/ai.svg", localizedNames: { en: "AI" } }, platforms: { chatgpt: { name: "ChatGPT", avatar: "app/chatgpt.svg" } } };
type State = Awaited<ReturnType<typeof readRecordIdentityState>>;
function draft(state: State): JsonObject {
  const party = (id: string) => ({ name: frontName(state.fronts.get(id)!.value) ?? null, avatar: { state: "keep" } });
  return { global: { user: party(String(state.bindings.value["subject"])), assistant: { ...party(String(state.bindings.value["assistant"])), apply_to_all: state.bindings.value["apply_assistant_to_all"]! } },
    platforms: Object.fromEntries(Object.entries(state.bindings.value["platforms"] as JsonObject).map(([platform, id]) => [platform, party(String(id))])) };
}
function party(value: JsonObject, key: "user" | "assistant") { return obj(obj(value["global"])[key]); }
const selected = (state: State, role: "subject" | "assistant") => state.fronts.get(String(state.bindings.value[role]))!;
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-identity-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained identity test: ${root}`); }
}
async function conversation(root: string) { const value = obj(JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8"))); await writeFile(path.join(root, "Conversations/a.json"), encodeRecord("conversation", value)); return value; }

test("identity reads and unchanged saves do not rewrite originals or manufacture name choices", async () => temporary(async root => {
  const before = await readRecordIdentityState(root), library = await readFile(path.join(root, "CloudigLibrary.json")), recovery = await readdir(path.join(root, "appdata/recovery"));
  assert.equal(before.fronts.size, 14); assert.equal(frontName(selected(before, "subject").value), undefined);
  assert.equal((await commitRecordIdentity(root, { expected: before.revision, draft: draft(before), timestamp: later })).status, "unchanged");
  const after = await readRecordIdentityState(root); assert.equal(after.revision, before.revision); assert.deepEqual([...after.fronts.values()].map(f => f.sha256), [...before.fronts.values()].map(f => f.sha256));
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), library); assert.deepEqual(await readdir(path.join(root, "appdata/recovery")), recovery);
}));

test("existing platform bindings remain readable and are not silently renumbered", async () => temporary(async root => {
  const original = await readRecordIdentityState(root), ids = obj(original.bindings.value["platforms"]);
  const fixedId = String(ids["chatgpt"]), stored = original.fronts.get(fixedId)!, oldId = uuidV7();
  const oldFront = { ...stored.value, front_id: oldId };
  const bindings = structuredClone(original.bindings.value); obj(bindings["platforms"])["chatgpt"] = oldId;
  await commitRecords(root, [
    { action: "write", kind: "identity", path: `Identities/${oldId}.json`, value: oldFront, expected: null },
    { action: "write", kind: "identitySettings", path: original.bindings.path, value: bindings, expected: original.bindings.sha256 },
    { action: "delete", path: stored.path, expected: stored.sha256 }
  ]);
  const before = await readRecordIdentityState(root), bytes = await readFile(path.join(root, `Identities/${oldId}.json`));
  assert.equal(obj(before.bindings.value["platforms"])["chatgpt"], oldId);
  await commitRecordIdentity(root, { expected: before.revision, draft: draft(before), timestamp: later });
  const after = await readRecordIdentityState(root);
  assert.equal(obj(after.bindings.value["platforms"])["chatgpt"], oldId);
  assert.deepEqual(await readFile(path.join(root, `Identities/${oldId}.json`)), bytes);
  assert(!after.fronts.has(fixedId));
}));

test("names use stable Front IDs and user claimers; default restores only the selection and preserves all claims", async () => temporary(async root => {
  const before = await readRecordIdentityState(root), value = draft(before); party(value, "user")["name"] = "老婆"; party(value, "assistant")["name"] = "奥思";
  obj(obj(value["platforms"])["chatgpt"])["name"] = "承卷开霁";
  await commitRecordIdentity(root, { expected: before.revision, draft: value, timestamp: later }); let after = await readRecordIdentityState(root);
  const user = selected(after, "subject"), platformId = String(obj(after.bindings.value["platforms"])["chatgpt"]), platform = after.fronts.get(platformId)!;
  assert.equal(user.value["front_id"], selected(before, "subject").value["front_id"]); assert.equal(user.value["created_at"], timestamp); assert.equal(user.value["edited_at"], later);
  assert.deepEqual(obj((user.value["names"] as JsonObject[])[0])["claimers"], [{ front: user.value["front_id"] }]); assert.equal((platform.value["names"] as JsonObject[]).length, 2);
  const reset = draft(after); party(reset, "user")["name"] = null; obj(obj(reset["platforms"])["chatgpt"])["name"] = null;
  await commitRecordIdentity(root, { expected: after.revision, draft: reset, timestamp: "2026-09-11T20:00:00Z" }); after = await readRecordIdentityState(root);
  assert(!Object.hasOwn(selected(after, "subject").value, "display_name")); assert.deepEqual(selected(after, "subject").value["names"], user.value["names"]); assert.deepEqual(after.fronts.get(platformId)!.value["names"], platform.value["names"]);
  const choose = draft(after); obj(obj(choose["platforms"])["chatgpt"])["name"] = "ChatGPT";
  await commitRecordIdentity(root, { expected: after.revision, draft: choose, timestamp: "2026-09-11T21:00:00Z" }); after = await readRecordIdentityState(root);
  assert.equal(after.fronts.get(platformId)!.value["display_name"], 1); assert.deepEqual(obj((after.fronts.get(platformId)!.value["names"] as JsonObject[])[0])["claimers"], [{ name: "OpenAI" }]);
}));

test("global/platform fallback and apply-all remain independent for names and avatars", async () => temporary(async root => {
  const c = await conversation(root); let state = await readRecordIdentityState(root), value = draft(state); party(value, "assistant")["name"] = "Global"; obj(obj(value["platforms"])["chatgpt"])["name"] = "Platform";
  await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later }); let reading = await readConversationRecord(root, String(c["conversation_id"]), builtins);
  assert.equal(reading.resolved.assistantName, "Platform"); assert.equal(reading.resolved.assistantAvatar, "app/chatgpt.svg");
  state = await readRecordIdentityState(root); value = draft(state); party(value, "assistant")["apply_to_all"] = true;
  await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later }); reading = await readConversationRecord(root, String(c["conversation_id"]), builtins);
  assert.equal(reading.resolved.assistantName, "Global"); assert.equal(reading.resolved.assistantAvatar, "app/chatgpt.svg");
  state = await readRecordIdentityState(root); value = draft(state); party(value, "assistant")["name"] = null;
  await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later }); assert.equal((await readConversationRecord(root, String(c["conversation_id"]), builtins)).resolved.assistantName, "ChatGPT");
}));

test("uploaded avatars are original user assets, missing references fall back without erasing names, and explicit save clears only the missing reference", async () => temporary(async root => {
  await conversation(root); const bytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"), picker = `p_${"a".repeat(43)}`;
  let state = await readRecordIdentityState(root), value = draft(state); party(value, "user")["name"] = "Kept name"; party(value, "user")["avatar"] = { state: "picker", picker };
  await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later, avatars: new Map([[picker, { bytes, extension: "gif" }]]) }); state = await readRecordIdentityState(root);
  const user = selected(state, "subject"), image = String(user.value["image"]); assert(image.startsWith("Identities/Images/")); assert.deepEqual(await readFile(path.join(root, image)), bytes);
  value = draft(state); party(value, "user")["avatar"] = { state: "clear" }; await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later }); assert.deepEqual(await readFile(path.join(root, image)), bytes, "valid user-uploaded original is not cache garbage");
  state = await readRecordIdentityState(root); value = draft(state); party(value, "user")["avatar"] = { state: "picker", picker }; await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later, avatars: new Map([[picker, { bytes, extension: "gif" }]]) });
  state = await readRecordIdentityState(root); const reference = selected(state, "subject"); await rm(path.join(root, image)); const missing = await readRecordIdentityState(root); assert.equal(missing.images.size, 0); assert.equal(selected(missing, "subject").sha256, reference.sha256);
  await commitRecordIdentity(root, { expected: missing.revision, draft: draft(missing), timestamp: "2026-09-11T22:00:00Z" }); const after = selected(await readRecordIdentityState(root), "subject"); assert.equal(frontName(after.value), "Kept name"); assert(!Object.hasOwn(after.value, "image")); assert.deepEqual(after.value["names"], reference.value["names"]);
}));

test("a single identity save updates Front and conversation names atomically without changing source or time snapshots", async () => temporary(async root => {
  const c = await conversation(root), id = String(c["conversation_id"]), first = await readConversationRecord(root, id, builtins), mark: JsonObject = { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(), target: id, edited_at: timestamp, models: [], content_time: { range: { start: { kind: "now", anchor: { date: "2026-08-01", offset: "Z" } } } } };
  const markPath = `Marks/${mark["mark_id"]}.json`; await writeFile(path.join(root, markPath), encodeRecord("mark", mark));
  const original = await readFile(path.join(root, "Conversations/a.json")), reading = await readConversationRecord(root, id, builtins), state = await readRecordIdentityState(root), value = draft(state); party(value, "user")["name"] = "Global user";
  await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later, conversation: { path: first.evidence.conversation.path, id, conversationSha: reading.evidence.conversation.sha256, markSha: reading.evidence.mark!.sha256, names: { user: "Only here", assistant: "Partner" } } });
  const after = await readConversationRecord(root, id, builtins); assert.equal(after.resolved.userName, "Only here"); assert.equal(after.resolved.assistantName, "Partner"); assert.deepEqual(after.mark!["content_time"], mark["content_time"]); assert.deepEqual(after.mark!["models"], []); assert.deepEqual(await readFile(path.join(root, "Conversations/a.json")), original);
  const namedSource = structuredClone(after.conversation), userSource = (namedSource["identity"] as JsonObject[]).find(f => f["role"] === "user")!;
  userSource["names"] = [{ name: "Source user", claimers: [] }]; userSource["display_name"] = 1;
  assert.equal(obj((projectRecordForReading(namedSource, after.resolved, after.mark)["messages"] as JsonObject[])[0]!["party"])["name"], "Only here", "the explicit Mark name wins without rewriting the source Front");
  const reset = await readRecordIdentityState(root); await commitRecordIdentity(root, { expected: reset.revision, draft: draft(reset), timestamp: later, conversation: { path: first.evidence.conversation.path, id, conversationSha: after.evidence.conversation.sha256, markSha: after.evidence.mark!.sha256, names: { user: null, assistant: null } } });
  assert.equal((await readConversationRecord(root, id, builtins)).resolved.userName, "Global user"); assert.deepEqual((await readStoredRecord(root, "mark", markPath)).value["models"], []);
}));

test("unrelated preferences do not stale identity edits, but changed Fronts or Mark proofs prevent every part of a combined save", async () => temporary(async root => {
  const c = await conversation(root), state = await readRecordIdentityState(root), library = await readStoredRecord(root, "library", "CloudigLibrary.json"); obj(library.value["settings"])["language"] = "en";
  await commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", value: library.value, expected: library.sha256 }]);
  const value = draft(state); party(value, "user")["name"] = "User text"; await commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later });
  await assert.rejects(commitRecordIdentity(root, { expected: state.revision, draft: value, timestamp: later }), /changed/);
  const fresh = await readRecordIdentityState(root), reading = await readConversationRecord(root, String(c["conversation_id"]), builtins), attempted = draft(fresh); party(attempted, "user")["name"] = "Do not save";
  await assert.rejects(commitRecordIdentity(root, { expected: fresh.revision, draft: attempted, timestamp: later, conversation: { path: reading.evidence.conversation.path, id: String(c["conversation_id"]), conversationSha: reading.evidence.conversation.sha256, markSha: "0".repeat(64), names: { user: "Wrong" } } }));
  assert.equal((await readRecordIdentityState(root)).revision, fresh.revision); assert.deepEqual(await readdir(path.join(root, "Marks")), []);
}));
