import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { extractHtmlRecord, extractClaudeRecord, type ExtractedRecord } from "../../../src/app/parser/record-source.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import { saveExtractedRecord, recordHistoryKey, recordHistoryPath } from "../../../src/adapters/library-data/record-parser-commit.mts";
import { saveConversationMark } from "../../../src/adapters/library-data/record-mark.mts";
import { readConversationRecord } from "../../../src/adapters/library-data/record-reading.mts";
import { readRecordCatalog } from "../../../src/adapters/library-data/record-catalog.mts";
import { readStoredRecord, withRecordSnapshot } from "../../../src/adapters/storage/record-store.mts";
import { frontName, SourceFronts, userModelFront } from "../../../src/core/records/front.mts";
import { validateRecord, encodeRecord } from "../../../src/core/records/index.mts";
import { prepareRecordConversationView } from "../../../src/app/reader/view-model.mts";
import { buildRecordMarkdown } from "../../../src/app/export/markdown.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { RecordReaderEngineCommands } from "../../../src/engine/record-reader-commands.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";

const base = fileURLToPath(new URL("../../private/schema-rebuild/", import.meta.url));
const fixture = fileURLToPath(new URL("../../fixtures/chatgpt-light-items-v2.html", import.meta.url));
const timestamp = "2026-09-11T15:00:00Z", later = "2026-09-11T16:00:00Z";
const obj = (value: unknown): JsonObject => value as JsonObject;
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const builtins = { user: { name: "采云用户", avatar: "app/user.svg", localizedNames: { en: "User" } }, assistant: { name: "智能伙伴", avatar: "app/ai.svg", localizedNames: { en: "AI" } }, platforms: {} };
const request = { page: { offset: 0, limit: 100 }, navigationPage: { offset: 0, limit: 100 }, branchPage: { offset: 0, limit: 100 } };

async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "flow-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true }); } else console.error(`Retained failed flow: ${root}`); }
}
async function html(root: string, file = "First (1).html") {
  const sourcePath = `Inbox/${file}`; await copyFile(fixture, path.join(root, sourcePath));
  const extracted = await extractHtmlRecord({ filePath: path.join(root, sourcePath), temporaryRoot: path.join(root, "cache") });
  return { extracted, sourcePath, parserVersion: "1.1.0", timestamp };
}
function claude(): JsonObject {
  return { uuid: "record-A", name: "Official conversation", model: "Opus 4.6", current_leaf_message_uuid: "b", chat_messages: [
    { uuid: "u", sender: "human", content: [{ type: "text", text: "  user indentation\n\n" }] },
    { uuid: "a", parent_message_uuid: "u", sender: "assistant", content: [
      { type: "thinking", thinking: "  thinking  \n" }, { type: "tool_use", id: "call1", name: "python", input: { code: "1 + 1" } },
      { type: "tool_result", tool_use_id: "call1", content: [{ type: "text", text: "2" }] }, { type: "text", text: "Branch A" }
    ] },
    { uuid: "b", parent_message_uuid: "u", sender: "assistant", model: "Fable 5.1", content: [{ type: "text", text: "Branch B" }] },
    { uuid: "orphan", parent_message_uuid: "outside", sender: "assistant", content: [{ type: "api_error", text: "Native platform error" }] }
  ] };
}
async function official(root: string): Promise<{ extracted: ExtractedRecord; sourcePath: string; parserVersion: string; timestamp: string }> {
  const record = claude(), bytes = JSON.stringify([record]); const sourcePath = "Inbox/conversations.json";
  await writeFile(path.join(root, sourcePath), bytes);
  return { extracted: extractClaudeRecord({ record, source: { file: "conversations.json", bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }, captured: { at: timestamp, from: "filesystem:last_write_time" } }), sourcePath, parserVersion: "1.1.0", timestamp };
}

test("HTML -> independent records -> source-preserving Mark -> Reader and Markdown", async () => temporary(async root => {
  const input = await html(root), saved = await saveExtractedRecord(root, input), conversation = saved.conversation;
  assert.equal(validateRecord("conversation", conversation).ok, true);
  assert.equal(obj(conversation["title"])["filename"], "First (1)");
  assert(!("archive" in conversation)); assert(!("user" in conversation)); assert(!("content_time" in conversation));
  assert((obj(conversation["messages"])["items"] as JsonObject[]).every(m => !("role" in m) && !("model" in m) && typeof m["speaker"] === "string"));
  const original = await readFile(path.join(root, saved.path));
  const view = await readConversationRecord(root, String(conversation["conversation_id"]), builtins);
  assert.equal(view.resolved.contentTime.state, "unavailable");
  const userId = String((await readStoredRecord(root, "identitySettings", "Identities/identity-settings.json")).value["subject"]);
  const mark = await saveConversationMark(root, { conversationId: String(conversation["conversation_id"]), expectedConversation: sha(original), expectedMark: null, timestamp: later,
    settings: { conversation_title: "My title", models: [userModelFront("My declared model", userId, later)], names: { user: "老婆" } } });
  assert(mark && !obj((mark["models"] as JsonObject[])[0])["front_id"]);
  assert.deepEqual(await readFile(path.join(root, saved.path)), original);
  const read = await readConversationRecord(root, String(conversation["conversation_id"]), builtins);
  assert.equal(read.resolved.conversationName, "My title"); assert.equal(read.resolved.effectiveEditedAt, later);
  assert.deepEqual(read.resolved.models, ["My declared model"]);
  const page = prepareRecordConversationView(read).page(request);
  assert.equal(page["conversation_id"], conversation["conversation_id"]);
  assert((page["messages"] as JsonObject[]).every(m => !m["model"]), "a user declaration does not relabel historical speakers");
  const markdown = buildRecordMarkdown({ ...read, locale: "zh-CN" }).parts.filter(p => typeof p === "string").join("");
  assert(markdown.startsWith("# My title\n")); assert(!markdown.includes("generation")); assert(markdown.includes("My declared model"));
}));

test("new-format parse updates the Library declaration atomically while ordinary parses leave the old declaration alone", async () => temporary(async root => {
  const old = JSON.parse(await readFile(new URL("./fixtures/01-1.json", import.meta.url), "utf8"));
  await writeFile(path.join(root, "CloudigLibrary.json"), encodeRecord("library", old));
  const before = await readFile(path.join(root, "CloudigLibrary.json"));
  const input = await html(root);
  await saveExtractedRecord(root, input);
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), before);
  const messages = input.extracted.parsed.draft["messages"] as JsonObject[];
  (messages[0]!["content"] as JsonObject[]).push({ type: "interactive", display: "box", source: "claude.ai_quiz_display_v0", format: "structured", data: { input: { title: "Quiz", questions: [] } } });
  const saved = await saveExtractedRecord(root, input);
  assert.equal(saved.conversation["schema"], "cloudig/conversation/1.0.1");
  const current = JSON.parse(await readFile(path.join(root, "CloudigLibrary.json"), "utf8"));
  assert.equal(current.schema, "cloudig/library/1.0.1"); assert.equal(current.schemas.conversation, "1.0.1");
  assert.deepEqual(current.settings, old.settings);
  const read = await readConversationRecord(root, String(saved.conversation["conversation_id"]), builtins);
  const page = prepareRecordConversationView(read).page(request);
  const views = (page["messages"] as JsonObject[]).flatMap(m => m["blocks"] as JsonObject[]);
  assert(views.some(b => obj(b["value"])["type"] === "interactive" && b["category"] === "content"));
  assert(buildRecordMarkdown({ ...read, locale: "zh-CN" }).parts.join("").includes("Quiz"));
}));

test("empty models is a setting, absence restores source, an empty Mark is removed", async () => temporary(async root => {
  const saved = await saveExtractedRecord(root, await html(root)); const id = String(saved.conversation["conversation_id"]);
  const before = await readConversationRecord(root, id, builtins), fingerprint = before.evidence.conversation.sha256;
  await saveConversationMark(root, { conversationId: id, expectedConversation: fingerprint, expectedMark: null, settings: { models: [] }, timestamp: later });
  let view = await readConversationRecord(root, id, builtins); assert.deepEqual(view.resolved.models, ["ChatGPT"]); assert(view.mark);
  await saveConversationMark(root, { conversationId: id, expectedConversation: fingerprint, expectedMark: view.evidence.mark!.sha256, settings: {}, timestamp: later });
  view = await readConversationRecord(root, id, builtins); assert(!view.mark); assert.deepEqual(view.resolved.models, before.resolved.models); assert.equal((await readdir(path.join(root, "Marks"))).length, 0);
  assert.equal(view.evidence.conversation.sha256, fingerprint);
}));

test("safe reparse preserves UUID, first parse, initial filename and Mark; keep-old creates a separate record", async () => temporary(async root => {
  const input = await html(root), first = await saveExtractedRecord(root, input), id = String(first.conversation["conversation_id"]);
  await saveConversationMark(root, { conversationId: id, expectedConversation: sha(await readFile(path.join(root, first.path))), expectedMark: null, settings: { conversation_title: "Edited" }, timestamp: later });
  await mkdir(path.join(root, "Conversations/Moved")); const moved = "Conversations/Moved/Renamed.json";
  await rename(path.join(root, first.path), path.join(root, moved));
  const second = await saveExtractedRecord(root, { ...input, timestamp: later });
  assert.equal(second.path, moved); assert(second.replaced); assert.equal(second.conversation["conversation_id"], id);
  assert.equal(obj(second.conversation["lifecycle"])["first_parsed_at"], timestamp);
  assert.equal(obj(second.conversation["lifecycle"])["last_parsed_at"], later);
  assert.equal((await readConversationRecord(root, id, builtins)).resolved.conversationName, "Edited");
  const third = await saveExtractedRecord(root, { ...input, timestamp: later, keepPrevious: true });
  assert(!third.replaced); assert.notEqual(third.conversation["conversation_id"], id); assert(!(await readConversationRecord(root, String(third.conversation["conversation_id"]), builtins)).mark);
}));

test("filename collisions, missing parse history and external changes never overwrite unrelated content", async () => temporary(async root => {
  const input = await html(root), first = await saveExtractedRecord(root, input);
  const another = await html(root, "First (1).htm"), second = await saveExtractedRecord(root, another);
  assert.notEqual(first.path.toLowerCase(), second.path.toLowerCase()); assert(!second.replaced);
  const changed = structuredClone(first.conversation); obj(changed["title"])["original"] = "External edit";
  await writeFile(path.join(root, first.path), encodeRecord("conversation", changed));
  const third = await saveExtractedRecord(root, input); assert(!third.replaced); assert.notEqual(third.path, first.path);
  assert.equal(obj((await readStoredRecord(root, "conversation", first.path)).value["title"])["original"], "External edit");
  const history = await readdir(path.join(root, "appdata/parse-history"));
  for (const file of history) await rm(path.join(root, "appdata/parse-history", file));
  const fourth = await saveExtractedRecord(root, input); assert(!fourth.replaced); assert.notEqual(fourth.path, third.path);
}));

test("corrupt parse history cannot block explicit parsing or authorize overwriting an older Conversation", async () => temporary(async root => {
  for (const input of [await html(root), await official(root)]) {
    const first = await saveExtractedRecord(root, input), id = String(first.conversation["conversation_id"]);
    const original = await readFile(path.join(root, first.path)), source = await readFile(path.join(root, input.sourcePath));
    const mark = await saveConversationMark(root, { conversationId: id, expectedConversation: sha(original), expectedMark: null, timestamp: later, settings: { conversation_title: "Keep my edit" } });
    const markPath = path.join(root, "Marks", `${mark!["mark_id"]}.json`), markBytes = await readFile(markPath);
    const historyPath = path.join(root, recordHistoryPath(recordHistoryKey(input.sourcePath, first.conversation)));
    await writeFile(historyPath, '{"schema":');
    const second = await saveExtractedRecord(root, { ...input, timestamp: later });
    assert(!second.replaced);
    assert.notEqual(second.conversation["conversation_id"], id);
    assert.notEqual(second.path, first.path);
    assert.deepEqual(await readFile(path.join(root, first.path)), original);
    assert.deepEqual(await readFile(markPath), markBytes);
    assert.deepEqual(await readFile(path.join(root, input.sourcePath)), source);
    const third = await saveExtractedRecord(root, { ...input, timestamp: later });
    assert.equal(third.conversation["conversation_id"], second.conversation["conversation_id"]);
    assert(third.replaced, "the explicit successful parse repairs only its own history");
  }
}));

test("official Claude uses source parents and Front models; tool results belong to the actual tool", async () => temporary(async root => {
  const saved = await saveExtractedRecord(root, await official(root));
  assert.equal(obj(saved.conversation["title"])["filename"], undefined);
  const messages = obj(saved.conversation["messages"])["items"] as JsonObject[];
  assert.deepEqual(messages.map(m => [m["id"], m["parent"]]), [["u", undefined], ["a", "u"], ["b", "u"], ["orphan", "outside"]]);
  assert.equal(obj((messages[0]!["content"] as JsonObject[])[0])["text"], "  user indentation\n\n");
  const fronts = new Map((saved.conversation["identity"] as JsonObject[]).map(f => [String(f["source_id"]), f]));
  assert.equal(frontName(fronts.get(String(messages[1]!["speaker"]))), "Claude");
  assert.equal(frontName(fronts.get(String(messages[2]!["speaker"]))), "Fable 5.1");
  assert.deepEqual(saved.conversation["models"], ["Fable 5.1"]);
  const tools = (messages[1]!["content"] as JsonObject[]).filter(b => b["type"] === "tool");
  assert.equal(tools[0]!["recipient"], tools[1]!["speaker"]); assert.equal(frontName(fronts.get(String(tools[1]!["speaker"]))), "python");
  const read = await readConversationRecord(root, String(saved.conversation["conversation_id"]), builtins);
  const defaultPage = prepareRecordConversationView(read).page(request), alternate = prepareRecordConversationView(read).page({ ...request, session: { expanded: { reasoning: false, tools: false, references: false }, hidden: { reasoning: false, tools: false }, navigation: { user: true, assistant: true, process: false }, branchChoices: { u: "a" } } });
  assert.equal(obj(defaultPage["pagination"])["total_visible"], 3);
  const activity = (alternate["messages"] as JsonObject[]).flatMap(m => m["blocks"] as JsonObject[]).filter(b => ["tool", "reasoning"].includes(String(b["category"])));
  assert.equal(activity.length, 3); assert(activity.every(b => b["collapsed"] === true));
  const md = buildRecordMarkdown({ ...read, locale: "en", branchChoices: { u: "a" } }).parts.filter(p => typeof p === "string").join("");
  assert(md.includes("Branch A")); assert(!md.includes("Branch B")); assert(md.includes("Native platform error")); assert(md.includes("python"));
}));

test("different real actors with the same name remain separate Fronts", () => {
  const pool = new SourceFronts("chatgpt");
  const one = pool.get({ role: "user", name: "Alex", sourceId: "person-A" }), two = pool.get({ role: "user", name: "Alex", sourceId: "person-B" });
  assert.equal(one, "person-A"); assert.equal(two, "person-B"); assert.notEqual(one, two); assert.equal(pool.values.length, 2);
});

test("Mark cannot claim another user; stale edits and duplicate target Marks remain explicit conflicts", async () => temporary(async root => {
  const saved = await saveExtractedRecord(root, await html(root)), id = String(saved.conversation["conversation_id"]), fingerprint = sha(await readFile(path.join(root, saved.path)));
  await assert.rejects(saveConversationMark(root, { conversationId: id, expectedConversation: fingerprint, expectedMark: null, timestamp: later,
    settings: { models: [userModelFront("Spoof", "01993bbc-0000-7000-8000-000000000001", later)] } }));
  const mark = await saveConversationMark(root, { conversationId: id, expectedConversation: fingerprint, expectedMark: null, settings: { models: [] }, timestamp: later });
  await assert.rejects(saveConversationMark(root, { conversationId: id, expectedConversation: fingerprint, expectedMark: null, settings: { names: { user: "Stale" } }, timestamp: later }));
  const duplicate = { ...mark!, mark_id: "01993bbc-0000-7000-8000-000000000002" };
  await writeFile(path.join(root, `Marks/${duplicate.mark_id}.json`), encodeRecord("mark", duplicate));
  await assert.rejects(readConversationRecord(root, id, builtins));
  assert.equal((await readdir(path.join(root, "Marks"))).length, 2);
}));

test("refresh observes externally removed files without stale catalog authority", async () => temporary(async root => {
  const saved = await saveExtractedRecord(root, await html(root)), id = String(saved.conversation["conversation_id"]);
  await saveConversationMark(root, { conversationId: id, expectedConversation: sha(await readFile(path.join(root, saved.path))), expectedMark: null, settings: { models: [] }, timestamp: later });
  await rm(path.join(root, saved.path));
  const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root));
  assert.equal(catalog.conversations.length, 0); assert.equal(catalog.marks.length, 1);
  await assert.rejects(readConversationRecord(root, id, builtins));
}));

test("assembler rejects unproven capture-time basis and unknown fields instead of silently dropping content", async () => temporary(async root => {
  const extracted = (await html(root)).extracted;
  assert.throws(() => assembleConversationRecord({ parsed: extracted.parsed, facts: {}, parserVersion: "1.1.0", timestamp }));
  const bad = structuredClone(extracted); const messages = bad.parsed.draft["messages"] as JsonObject[];
  (messages[0]!["content"] as JsonObject[]).push({ type: "invented", payload: "do not lose" });
  assert.throws(() => assembleConversationRecord({ ...bad, parserVersion: "1.1.0", timestamp }));
}));

test("real Engine handlers keep editable state in Mark, preserve source bytes and reopen the same records", async () => temporary(async root => {
  const saved = await saveExtractedRecord(root, await official(root));
  const engine = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, "cache"), builtins, clock: () => later });
  const ctx = { request: "q_records", signal: new AbortController().signal, emit: async () => undefined };
  const handlers = engine.handlers();
  const call = async (name: string, payload: JsonObject): Promise<JsonObject> => {
    assertIpcValue(payload); const result = await handlers[name]!(payload, ctx); assertIpcValue(result); return obj(result);
  };
  const listed = await call("reader.archives.query", { offset: 0, limit: 100 });
  const archive = (listed["items"] as JsonObject[])[0]!["capability"]!;
  const before = await readFile(path.join(root, saved.path));
  const direct = { range: { start: { kind: "calendar", era: "AD", year: 2026, month: 9 } } };
  const initial = await call("reader.archive.info.query", { archive });
  await call("reader.archive.info.commit", { archive, expected_conversation: obj(initial["revision"])["conversation"]!, expected_mark: null, touch_on_noop: false,
    draft: { conversation_name: { state: "inherit" }, models: { state: "inherit" }, names: { assistant: "奥思" }, content_time: { state: "set", ...direct } } });
  assert.deepEqual(await readFile(path.join(root, saved.path)), before);
  const info = await call("reader.archive.info.query", { archive }); assert.deepEqual(obj(obj(info["draft"])["content_time"])["range"], direct.range);
  const wireRequest = { messages: request.page, navigation: request.navigationPage, branches: request.branchPage };
  const opened = await call("reader.view.open", { archive, request: wireRequest }), view = opened["token"]!;
  const capability = await call("reader.view.page", { view, request: wireRequest });
  const page = JSON.parse(await readFile(path.join(root, "cache", "Views", String(capability["virtual_path"]).slice(1)), "utf8")); assert.equal(obj(obj(page["header"])["content_time"])["state"], "set");
  await call("reader.view.close", { view }); await assert.rejects(call("reader.view.page", { view, request: wireRequest }));
  await engine.close();
  const reopened = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, "cache"), builtins });
  const rows = obj(await reopened.handlers()["reader.archives.query"]!({ offset: 0, limit: 100 }, ctx));
  assert.equal(rows["total"], 1); await reopened.close();
  const read = await readConversationRecord(root, String(saved.conversation["conversation_id"]), builtins); assert.deepEqual(read.resolved.contentTime.range, direct.range);
  assert(buildRecordMarkdown({ ...read, locale: "zh-CN" }).parts.filter(p => typeof p === "string").join("").includes("2026"));
}));

test("equivalent Mark key order is a no-op and two simultaneous new Marks cannot both win", async () => temporary(async root => {
  const saved = await saveExtractedRecord(root, await html(root)), id = String(saved.conversation["conversation_id"]), fingerprint = sha(await readFile(path.join(root, saved.path)));
  const input = { conversationId: id, expectedConversation: fingerprint, expectedMark: null, timestamp: later, settings: { conversation_title: "Same", names: { user: "老婆" } } };
  const concurrent = await Promise.allSettled([saveConversationMark(root, input), saveConversationMark(root, input)]);
  assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
  const reading = await readConversationRecord(root, id, builtins);
  const again = await saveConversationMark(root, { ...input, expectedMark: reading.evidence.mark!.sha256, timestamp: "2026-09-12T00:00:00Z", settings: { names: { user: "老婆" }, conversation_title: "Same" } });
  assert.equal(again?.["edited_at"], later); assert.equal((await readdir(path.join(root, "Marks"))).length, 1);
}));

test("duplicate Conversation UUIDs are preserved, not silently re-numbered or resolved by newest date", async () => temporary(async root => {
  const saved = await saveExtractedRecord(root, await html(root)), before = await readFile(path.join(root, saved.path));
  await writeFile(path.join(root, "Conversations/Imported copy.json"), before);
  await assert.rejects(readConversationRecord(root, String(saved.conversation["conversation_id"]), builtins));
  const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.equal(catalog.conversations.length, 2);
  assert.deepEqual(await readFile(path.join(root, saved.path)), before);
}));
