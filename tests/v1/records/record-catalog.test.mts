import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, lstat, utimes, readdir, realpath, rm, rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordCatalog } from "../../../src/adapters/library-data/record-catalog.mts";
import { readConversationRecord } from "../../../src/adapters/library-data/record-reading.mts";
import { commitRecords, withRecordSnapshot } from "../../../src/adapters/storage/record-store.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { encodeRecord } from "../../../src/core/records/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T18:00:00Z";
const builtins = { user: { name: "User", avatar: "app/user.svg" }, assistant: { name: "AI", avatar: "app/ai.svg" }, platforms: {} };
async function temporary(run: (root: string, records: JsonObject[]) => Promise<void>): Promise<void> {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "catalog-")); let passed = false;
  try {
    await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); const records: JsonObject[] = [];
    for (let i = 0; i < 2; i++) {
      const c = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8")) as JsonObject;
      c["conversation_id"] = uuidV7(); c["title"] = { filename: `Record ${i}` };
      const first = ((c["messages"] as JsonObject)["items"] as JsonObject[])[0]!;
      first["content"] = [{ type: "markdown", text: "Large readable body ".repeat(20000) }]; records.push(c);
      await commitRecords(root, [{ action: "write", kind: "conversation", path: `Conversations/${i}.json`, value: c, expected: null }]);
    }
    await run(root, records); passed = true;
  } finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true }); } else console.error(`Retained catalog test: ${root}`); }
}
const inspect = async (root: string) => {
  const inspected: string[] = []; const result = await withRecordSnapshot(root, () => readRecordCatalog(root, { onInspect: file => { inspected.push(file); } }));
  return { result, inspected };
};

test("legal Conversation files with uppercase JSON extensions remain listed and readable", async () => temporary(async (root, records) => {
  await inspect(root);
  await rename(path.join(root, "Conversations/0.json"), path.join(root, "Conversations/External.JSON"));
  const { result } = await inspect(root);
  assert.equal(result.conversations.length, 2);
  assert(result.conversations.some(c => c.path === "Conversations/External.JSON"));
  assert.equal(result.issues.length, 0);
  const opened = await readConversationRecord(root, String(records[0]!["conversation_id"]), builtins);
  assert.equal(opened.conversation["conversation_id"], records[0]!["conversation_id"]);
}));

test("warm catalog holds small headers, not every body, and does not rewrite records or recovery history", async () => temporary(async (root, records) => {
  const libraryBefore = await readFile(path.join(root, "CloudigLibrary.json")), groups = await readdir(path.join(root, "appdata/recovery"));
  assert.equal((await inspect(root)).inspected.length, 2);
  const indexPath = path.join(root, "appdata/indexes/conversations.json"), indexBefore = await lstat(indexPath, { bigint: true });
  const warm = await inspect(root); assert.deepEqual(warm.inspected, []); assert.equal(warm.result.conversations.length, 2);
  assert(warm.result.conversations.every(r => !r.header["messages"] && !r.header["resources"])); assert((await lstat(indexPath)).size < 20000);
  assert.equal((await lstat(indexPath, { bigint: true })).mtimeNs, indexBefore.mtimeNs);
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), libraryBefore); assert.deepEqual(await readdir(path.join(root, "appdata/recovery")), groups);
  const opened = await readConversationRecord(root, String(records[1]!["conversation_id"]), builtins);
  assert(String((((opened.conversation["messages"] as JsonObject)["items"] as JsonObject[])[0]!["content"] as JsonObject[])[0]!["text"]).startsWith("Large readable body"));
}));

test("external writes with restored mtime and external deletion refresh only the changed rows", async () => temporary(async (root, records) => {
  await inspect(root); const file = path.join(root, "Conversations/0.json"), before = await lstat(file);
  const changed = structuredClone(records[0]!); changed["title"] = { filename: "Record X" };
  await writeFile(file, encodeRecord("conversation", changed)); await utimes(file, before.atime, before.mtime);
  const after = await inspect(root); assert.deepEqual(after.inspected, ["Conversations/0.json"]); assert.equal(after.result.conversations.find(r => r.path.endsWith("0.json"))!.header["title"] && (after.result.conversations.find(r => r.path.endsWith("0.json"))!.header["title"] as JsonObject)["filename"], "Record X");
  await rm(path.join(root, "Conversations/1.json")); const removed = await inspect(root); assert.deepEqual(removed.inspected, []); assert.equal(removed.result.conversations.length, 1);
}));

test("missing or corrupt small indexes rebuild without changing Conversation bytes", async () => temporary(async root => {
  const file = path.join(root, "Conversations/0.json"), before = await readFile(file); await inspect(root);
  const index = path.join(root, "appdata/indexes/conversations.json"); await writeFile(index, "{broken"); assert.equal((await inspect(root)).inspected.length, 2);
  await rm(index); assert.equal((await inspect(root)).inspected.length, 2); assert.deepEqual(await readFile(file), before);
  assert.deepEqual((await readdir(path.dirname(index))).filter(n => n.endsWith(".next")), []);
}));
