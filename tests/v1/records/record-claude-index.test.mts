import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { indexRecordClaudeContainer, extractIndexedClaudeRecord } from "../../../src/adapters/parser/record-claude-index.mts";
import { saveExtractedRecord } from "../../../src/adapters/library-data/record-parser-commit.mts";
import { fingerprintFile } from "../../../src/adapters/storage/stream.mts";
import { saveConversationMark } from "../../../src/adapters/library-data/record-mark.mts";

const base = path.resolve("tests/private/schema-rebuild"), timestamp = "2026-09-11T19:00:00Z";
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "claude-index-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true }); } else console.error(`Retained Claude index test: ${root}`); }
}
const data = () => [{ uuid: "one", name: "First", chat_messages: [{ uuid: "m1", sender: "human", text: "Hello" }, { uuid: "m2", sender: "assistant", parent_message_uuid: "m1", text: "Answer" }] }, { uuid: "two", name: "Second", chat_messages: [{ uuid: "n1", sender: "assistant", text: "Automatic answer" }] }];

test("Claude cold/warm index lives in appdata and exact selected records enter the new Conversation chain", async () => temporary(async root => {
  const relative = "Inbox/conversations.json", file = path.join(root, relative); await writeFile(file, JSON.stringify(data()));
  const original = await readFile(file), phases: string[] = [];
  const first = await indexRecordClaudeContainer(root, relative, { onProgress: event => { phases.push(event.phase); } });
  assert.equal(first.reused, false); assert.equal(first.index.records.length, 2); assert(phases.includes("record"));
  const [indexName] = await readdir(path.join(root, "appdata/indexes/claude")); const indexFile = path.join(root, "appdata/indexes/claude", indexName!), before = await lstat(indexFile, { bigint: true });
  phases.length = 0; const warm = await indexRecordClaudeContainer(root, relative, { onProgress: event => { phases.push(event.phase); } });
  assert(warm.reused); assert(!phases.includes("record")); assert.equal((await lstat(indexFile, { bigint: true })).mtimeNs, before.mtimeNs); assert(!(await readdir(root)).includes("Data"));
  const selected = await extractIndexedClaudeRecord(root, warm.index, String(warm.index.records[1]!["selector"]));
  const saved = await saveExtractedRecord(root, { extracted: selected, sourcePath: relative, parserVersion: "1.1.0", timestamp });
  assert.equal((saved.conversation["title"] as Record<string, unknown>)["original"], "Second"); assert.deepEqual(await readFile(file), original);
}));

test("cancelled or invalid rebuild leaves the last valid index intact", async () => temporary(async root => {
  const relative = "Inbox/conversations.json", file = path.join(root, relative); await writeFile(file, JSON.stringify(data())); await indexRecordClaudeContainer(root, relative);
  const [name] = await readdir(path.join(root, "appdata/indexes/claude")), indexFile = path.join(root, "appdata/indexes/claude", name!), before = await readFile(indexFile);
  const changed = data(); changed[0]!.name = "Changed"; await writeFile(file, JSON.stringify(changed)); const controller = new AbortController();
  await assert.rejects(indexRecordClaudeContainer(root, relative, { signal: controller.signal, onProgress: e => { if (e.phase === "record") controller.abort(); } }));
  assert.deepEqual(await readFile(indexFile), before);
  await writeFile(file, '[{"uuid":"a","uuid":"b","chat_messages":[]}]'); await assert.rejects(indexRecordClaudeContainer(root, relative)); assert.deepEqual(await readFile(indexFile), before);
}));

test("a changed selected range is not silently extracted through an old index", async () => temporary(async root => {
  const relative = "Inbox/conversations.json", file = path.join(root, relative); await writeFile(file, JSON.stringify(data())); const indexed = await indexRecordClaudeContainer(root, relative);
  const changed = data(); changed[0]!.name = "Other"; await writeFile(file, JSON.stringify(changed));
  await assert.rejects(extractIndexedClaudeRecord(root, indexed.index, String(indexed.index.records[0]!["selector"])));
}));

const real = process.env["CLOUDIG_RECORD_CLAUDE"];

test("Claude index marks empty source slots and rebuilds the old projection once without changing the source", async () => temporary(async root => {
  const relative = "Inbox/conversations.json", file = path.join(root, relative);
  await writeFile(file, JSON.stringify([{ uuid: 'empty', name: '', chat_messages: [{ uuid: 'u', sender: 'human', text: '', content: [] }, { uuid: 'a', sender: 'assistant', parent_message_uuid: 'u', text: '', content: [] }, { uuid: 'b', sender: 'assistant', parent_message_uuid: 'u', text: '', content: [] }] }]));
  const before = await readFile(file), cold = await indexRecordClaudeContainer(root, relative);
  assert.equal(cold.index.records[0]!['messages'], 3); assert.equal(cold.index.records[0]!['branches'], 2); assert.equal(cold.index.records[0]!['empty_messages'], 3);
  const [name] = await readdir(path.join(root, 'appdata/indexes/claude')), indexFile = path.join(root, 'appdata/indexes/claude', name!);
  const old = JSON.parse(await readFile(indexFile, 'utf8')); delete old.records[0].empty_messages; await writeFile(indexFile, JSON.stringify(old));
  const rebuilt = await indexRecordClaudeContainer(root, relative); assert.equal(rebuilt.reused, false); assert.equal(rebuilt.index.records[0]!['empty_messages'], 3);
  assert.equal((await indexRecordClaudeContainer(root, relative)).reused, true); assert.deepEqual(await readFile(file), before);
}));

test("untitled official records can be reparsed without inventing an empty title or losing the original identity and Mark", async () => temporary(async root => {
  const relative = "Inbox/conversations.json", file = path.join(root, relative), records = data(); records[0]!.name = "";
  await writeFile(file, JSON.stringify(records));
  const indexed = await indexRecordClaudeContainer(root, relative), selector = String(indexed.index.records[0]!["selector"]);
  const extracted = await extractIndexedClaudeRecord(root, indexed.index, selector);
  const first = await saveExtractedRecord(root, { extracted, sourcePath: relative, parserVersion: "1.1.16", timestamp });
  assert.equal(first.conversation["title"], undefined);
  const mark = await saveConversationMark(root, { conversationId: String(first.conversation["conversation_id"]), expectedConversation: (await fingerprintFile(path.join(root, first.path))).sha256, expectedMark: null, timestamp,
    settings: { conversation_title: "My retained title" } }); assert(mark);
  const markFile = path.join(root, 'Marks', String(mark['mark_id']) + '.json'), markBefore = await readFile(markFile);
  const second = await saveExtractedRecord(root, { extracted, sourcePath: relative, parserVersion: "1.1.17", timestamp: "2026-09-12T19:00:00Z" });
  assert(second.replaced); assert.equal(second.path, first.path); assert.equal(second.conversation["title"], undefined);
  assert.equal(second.conversation["conversation_id"], first.conversation["conversation_id"]);
  assert.equal((second.conversation["lifecycle"] as Record<string, unknown>)["first_parsed_at"], timestamp);
  assert.deepEqual(await readFile(markFile), markBefore);
}));
test("real official container cold/warm index and selected new-format extraction", { skip: !real }, async () => temporary(async root => {
  const file = path.join(root, "Inbox/conversations.json"); await copyFile(real!, file);
  const original = await fingerprintFile(file), started = performance.now(); const cold = await indexRecordClaudeContainer(root, "Inbox/conversations.json"); const coldMs = performance.now() - started;
  const warmStart = performance.now(); const warm = await indexRecordClaudeContainer(root, "Inbox/conversations.json"); const warmMs = performance.now() - warmStart;
  assert(warm.reused && !cold.reused); assert.equal(cold.index.records.length, warm.index.records.length); assert.deepEqual(warm.index.source, { path: "Inbox/conversations.json", ...original });
  const row = warm.index.records.find(r => Number(r["length"]) < 5000000 && Number(r["messages"]) > 2)!; assert(row);
  const extracted = await extractIndexedClaudeRecord(root, warm.index, String(row["selector"]));
  const saved = await saveExtractedRecord(root, { extracted, sourcePath: "Inbox/conversations.json", parserVersion: "1.1.0", timestamp }); assert(saved.conversation["conversation_id"]);
  assert.deepEqual(await fingerprintFile(file), original);
  console.log(JSON.stringify({ claude_record_index: { sourceBytes: original.bytes, records: cold.index.records.length, coldMs, warmMs, extractedMessages: ((saved.conversation["messages"] as Record<string, unknown>)["items"] as unknown[]).length } }));
}));
