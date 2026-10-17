import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordIdentityState } from "../../../src/adapters/library-data/record-identity.mts";
import { prepareRecordPicker, prepareRecordAvatar, cleanupRecordPicker } from "../../../src/adapters/library-data/record-picker.mts";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
import { commitRecords, readStoredRecord } from "../../../src/adapters/storage/record-store.mts";
import { readConversationRecord } from "../../../src/adapters/library-data/record-reading.mts";
import { RecordIdentityEngineCommands } from "../../../src/engine/record-identity-commands.mts";
import { RecordReaderEngineCommands } from "../../../src/engine/record-reader-commands.mts";
import { assertIpcValue, type EngineCommandHandler } from "../../../src/engine/protocol.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const timestamp = "2026-09-11T18:00:00Z", base = path.resolve("tests/private/schema-rebuild"), obj = (v: unknown) => v as JsonObject;
const builtins = { user: { name: "采云用户", avatar: "app/user.svg", localizedNames: { en: "User" } }, assistant: { name: "智能伙伴", avatar: "app/ai.svg", localizedNames: { en: "AI" } }, platforms: { chatgpt: { name: "ChatGPT", avatar: "app/chatgpt.svg" } } };
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"), sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
function draft(model: JsonObject): JsonObject {
  const party = (v: JsonObject) => ({ name: v["name"]!, avatar: { state: "keep" } }), global = obj(model["global"]);
  return { global: { user: party(obj(global["user"])), assistant: { ...party(obj(global["assistant"])), apply_to_all: obj(global["assistant"])["apply_to_all"]! } },
    platforms: Object.fromEntries((model["platforms"] as JsonObject[]).map(p => [String(p["platform"]), party(p)])) };
}
async function stage(runtime: string, bytes = gif, filename = "photo.png") {
  const picker = `p_${randomBytes(32).toString("base64url")}`, dir = path.join(runtime, "Pickers", picker); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "payload.bin"), bytes); await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ schema: "cloudig/picker/1.0.0", picker, filename, bytes: bytes.length, sha256: sha(bytes), captured_at: timestamp })); return { picker, dir };
}
async function temporary(run: (root: string, runtime: string, identity: RecordIdentityEngineCommands, reader: RecordReaderEngineCommands) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "identity-engine-")); let passed = false;
  await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); const cache = await createRuntimeCacheSession(path.join(root, "cache"), root);
  const reader = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: cache.root, builtins });
  const identity = new RecordIdentityEngineCommands({ libraryRoot: root, runtimeRoot: cache.root, builtins, resolveConversation: v => reader.resolveIdentityDraft(v), clock: () => timestamp });
  try { await run(root, cache.root, identity, reader); passed = true; }
  finally { await identity.close(); await reader.close(); await cache.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained identity engine test: ${root}`); }
}
const call = (engine: { handlers(): Readonly<Record<string, EngineCommandHandler>> }) => async (name: string, payload: JsonObject, signal = new AbortController().signal) => {
  assertIpcValue(payload); const value = await engine.handlers()[name]!(payload, { request: "q_identity", signal, emit: async () => undefined }); assertIpcValue(value); return obj(value);
};

test("identity Engine uses independent Front proofs and current UI DTO, and does not overwrite Library settings", async () => temporary(async (root, _runtime, identity) => {
  const request = call(identity), model = await request("identity.query", {}), value = draft(model); assert.match(String(model["revision"]), /^[a-f0-9]{64}$/); assert.equal((model["platforms"] as JsonObject[]).length, 12);
  const library = await readStoredRecord(root, "library", "CloudigLibrary.json"); obj(library.value["settings"])["language"] = "en";
  await commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: library.value, expected: library.sha256 }]);
  obj(obj(value["global"])["user"])["name"] = "老婆"; const before = await readFile(path.join(root, "CloudigLibrary.json"));
  const saved = await request("identity.commit", { expected_revision: model["revision"]!, draft: value }); assert.equal(saved["status"], "updated"); assert.equal(obj(obj(saved["global"])["user"])["resolved_name"], "老婆"); assert.equal(obj(obj(saved["global"])["assistant"])["resolved_name"], "AI");
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), before); await assert.rejects(request("identity.commit", { expected_revision: model["revision"]!, draft: value }), { code: "CLOUDIG_IDENTITY_EDIT_INVALID" });
}));

test("raster upload is capability-only, signature-checked, saved outside cache and survives reopening", async () => temporary(async (root, runtime, identity) => {
  const request = call(identity), picked = await stage(runtime), preview = await request("identity.avatar.preview", { picker: picked.picker });
  assert.match(String(preview["virtual_path"]), /^\/v_[\w-]+\/assets\/r_[\w-]+\.gif$/u); assert.deepEqual(await readFile(path.join(runtime, "Views", String(preview["virtual_path"]).slice(1))), gif);
  const model = await request("identity.query", {}), value = draft(model); obj(obj(value["global"])["user"])["avatar"] = { state: "picker", picker: picked.picker };
  const saved = await request("identity.commit", { expected_revision: model["revision"]!, draft: value }), user = obj(obj(saved["global"])["user"]); assert.equal(user["custom_avatar"], true);
  await assert.rejects(lstat(picked.dir), { code: "ENOENT" }); await assert.rejects(lstat(path.join(runtime, "Views", String(preview["virtual_path"]).slice(1))), { code: "ENOENT" });
  const shown = await request("identity.avatar.resolve", { avatar: obj(user["resolved_avatar"])["capability"]! }); assert.deepEqual(await readFile(path.join(runtime, "Views", String(shown["virtual_path"]).slice(1))), gif);
  const state = await readRecordIdentityState(root), image = String(state.fronts.get(String(state.bindings.value["subject"]))!.value["image"]); assert(image.startsWith("Identities/Images/")); await identity.close(); assert.deepEqual(await readFile(path.join(root, image)), gif);
  assert.equal(obj(obj((await request("identity.query", {}))["global"])["user"])["custom_avatar"], true); assert(!await lstat(path.join(root, "Data")).catch(() => undefined));
}));

test("picker validation preserves changed files, rejects malformed manifests and non-raster avatars, and cancels without writing Identity", async () => temporary(async (root, runtime, identity) => {
  const request = call(identity), picked = await stage(runtime), prepared = await prepareRecordPicker(runtime, picked.picker); assert.equal(prepared.capturedAt, "2026-09-11T18:00:00.000Z");
  await writeFile(path.join(picked.dir, "manifest.json"), "changed"); assert.equal(await cleanupRecordPicker(runtime, prepared), false); assert.deepEqual(await readFile(path.join(picked.dir, "payload.bin")), gif);
  const svg = await stage(runtime, Buffer.from("<svg/>"), "avatar.png"); await assert.rejects(prepareRecordAvatar(runtime, svg.picker), /Select a PNG/u);
  const duplicate = await stage(runtime); const manifest = await readFile(path.join(duplicate.dir, "manifest.json"), "utf8"); await writeFile(path.join(duplicate.dir, "manifest.json"), manifest.replace('"schema":', '"schema":"wrong","schema":')); await assert.rejects(prepareRecordPicker(runtime, duplicate.picker), /Duplicate/u);
  const before = await readRecordIdentityState(root), model = await request("identity.query", {}), cancel = new AbortController(); cancel.abort(); await assert.rejects(request("identity.commit", { expected_revision: model["revision"]!, draft: draft(model) }, cancel.signal), { name: "AbortError" }); assert.equal((await readRecordIdentityState(root)).revision, before.revision);
  await assert.rejects(request("identity.avatar.preview", { picker: "../not-a-capability" }), { code: "CLOUDIG_IDENTITY_EDIT_INVALID" });
}));

test("discard and repeated preview do not accumulate view copies; changed source avatar cannot silently change an issued preview", async () => temporary(async (root, runtime, identity) => {
  const request = call(identity);
  for (let i = 0; i < 6; i++) { const picked = await stage(runtime), first = await request("identity.avatar.preview", { picker: picked.picker }); assert.deepEqual(await request("identity.avatar.preview", { picker: picked.picker }), first); await request("identity.avatar.discard", { picker: picked.picker }); assert.deepEqual(await readdir(path.join(runtime, "Views")), []); assert(await cleanupRecordPicker(runtime, await prepareRecordPicker(runtime, picked.picker))); }
  const picked = await stage(runtime), model = await request("identity.query", {}), value = draft(model); obj(obj(value["global"])["user"])["avatar"] = { state: "picker", picker: picked.picker };
  const saved = await request("identity.commit", { expected_revision: model["revision"]!, draft: value }), descriptor = obj(obj(obj(saved["global"])["user"])["resolved_avatar"]);
  const state = await readRecordIdentityState(root), image = String(state.fronts.get(String(state.bindings.value["subject"]))!.value["image"]); await writeFile(path.join(root, image), Buffer.from("replaced"));
  await assert.rejects(request("identity.avatar.resolve", { avatar: descriptor["capability"]! }), { code: "CLOUDIG_IDENTITY_EDIT_INVALID" }); assert.deepEqual(await readdir(path.join(runtime, "Views")), []);
}));

test("existing Reader names query and combined identity save update only this Mark; stale Mark rejects the entire save", async () => temporary(async (root, _runtime, identity, reader) => {
  const c = obj(JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8"))); await commitRecords(root, [{ action: "write", kind: "conversation", path: "Conversations/a.json", value: c, expected: null }]); const original = await readFile(path.join(root, "Conversations/a.json"));
  const request = call(identity), read = call(reader), list = await read("reader.archives.query", { offset: 0, limit: 200 }), archive = (list["items"] as JsonObject[])[0]!["capability"]!, info = await read("reader.archive.identity.query", { archive }), model = await request("identity.query", {});
  const value = draft(model); obj(obj(value["global"])["assistant"])["name"] = "Global";
  const selected = { archive, expected_conversation: obj(info["revision"])["conversation"]!, expected_mark: obj(info["revision"])["mark"]!, names: { user: "Only A", assistant: "Partner A" } };
  await request("identity.commit", { expected_revision: model["revision"]!, draft: value, conversation: selected });
  const reading = await readConversationRecord(root, String(c["conversation_id"]), builtins); assert.equal(reading.resolved.userName, "Only A"); assert.equal(reading.resolved.assistantName, "Partner A"); assert(!reading.mark!["content_time"]); assert.deepEqual(await readFile(path.join(root, "Conversations/a.json")), original);
  const fresh = await request("identity.query", {}), attempted = draft(fresh); obj(obj(attempted["global"])["user"])["name"] = "Do not save";
  await assert.rejects(request("identity.commit", { expected_revision: fresh["revision"]!, draft: attempted, conversation: selected }), { code: "CLOUDIG_ARCHIVE_INFO_CONFLICT" }); assert.equal((await request("identity.query", {}))["revision"], fresh["revision"]);
}));
