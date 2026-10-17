import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { extractHtmlRecord, extractClaudeRecord, fileCaptureTime } from "../../../src/app/parser/record-source.mts";
import { saveExtractedRecord } from "../../../src/adapters/library-data/record-parser-commit.mts";
import { readConversationRecord } from "../../../src/adapters/library-data/record-reading.mts";
import { saveConversationMark } from "../../../src/adapters/library-data/record-mark.mts";
import { prepareRecordConversationView } from "../../../src/app/reader/view-model.mts";
import { buildRecordMarkdown } from "../../../src/app/export/markdown.mts";
import { streamTopLevelJsonArrayRanges, parseJsonRange } from "../../../src/adapters/parser/json-array-stream.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const sample = process.env["CLOUDIG_RECORD_SAMPLE"], official = process.env["CLOUDIG_RECORD_CLAUDE"];
const base = path.resolve("tests/private/schema-rebuild");
const hash = (v: string | Uint8Array): string => createHash("sha256").update(v).digest("hex");

test("latest real HTML and an actual official Claude record use the same new Library, Mark, Reader and export", { skip: !sample || !official }, async () => {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "real-flow-")); let passed = false;
  const timestamp = new Date().toISOString(), day = timestamp.slice(0, 10);
  try {
    await createRecordLibrary(root, { timestamp, anchor: { date: day, offset: "Z" } });
    const filename = (await readdir(sample!)).find(n => n.includes("绯缎缠骨") && !/ \(\d+\)\.html$/u.test(n) && n.endsWith(".html"));
    assert(filename);
    const sourcePath = `Inbox/${filename}`; await copyFile(path.join(sample!, filename), path.join(root, sourcePath));
    const extracted = await extractHtmlRecord({ filePath: path.join(root, sourcePath), temporaryRoot: path.join(root, "cache"), captured: await fileCaptureTime(path.join(sample!, filename)) });
    const html = await saveExtractedRecord(root, { extracted, sourcePath, parserVersion: "1.1.0", timestamp });
    let record: JsonObject | undefined, originalRange: { offset: number; bytes: number; sha256: string } | undefined;
    for await (const range of streamTopLevelJsonArrayRanges(createReadStream(official!))) {
      if (range.length > 5_000_000) continue; // S2 is one bounded real record, not the full-container benchmark.
      const value = await parseJsonRange(official!, range);
      const candidate = value.value as JsonObject;
      if (Array.isArray(candidate["chat_messages"]) && candidate["chat_messages"].length >= 3) {
        record = candidate; originalRange = { offset: range.offset, bytes: range.length, sha256: value.fingerprint.sha256 }; break;
      }
    }
    assert(record && originalRange);
    const bytes = Buffer.from(JSON.stringify([record]));
    await writeFile(path.join(root, "Inbox/conversations.json"), bytes);
    const claude = await saveExtractedRecord(root, { extracted: extractClaudeRecord({ record,
      source: { file: "conversations.json", bytes: bytes.length, sha256: hash(bytes) }, captured: await fileCaptureTime(official!) }),
      sourcePath: "Inbox/conversations.json", parserVersion: "1.1.0", timestamp });
    const results: JsonObject[] = [];
    const builtins = { user: { name: "采云用户", avatar: "app/default-user.svg" }, assistant: { name: "智能伙伴", avatar: "app/default-ai.svg" }, platforms: {} };
    for (const saved of [html, claude]) {
      const id = String(saved.conversation["conversation_id"]), original = await readFile(path.join(root, saved.path));
      const before = await readConversationRecord(root, id, builtins);
      await saveConversationMark(root, { conversationId: id, expectedConversation: before.evidence.conversation.sha256, expectedMark: null, timestamp, settings: { conversation_title: "Isolated verification", models: [] } });
      assert.deepEqual(await readFile(path.join(root, saved.path)), original);
      const view = await readConversationRecord(root, id, builtins);
      const prepared = prepareRecordConversationView(view);
      const page = prepared.page({ page: { offset: 0, limit: 100 }, navigationPage: { offset: 0, limit: 100 }, branchPage: { offset: 0, limit: 100 } });
      assert.equal((page["header"] as JsonObject)["title"], "Isolated verification");
      const markdown = buildRecordMarkdown({ ...view, locale: "zh-CN" }); assert(markdown.messageCount > 0);
      assert.equal(view.resolved.contentTime.state, "unavailable");
      const reparse = saved === html
        ? await saveExtractedRecord(root, { extracted, sourcePath, parserVersion: "1.1.0", timestamp: new Date().toISOString() })
        : undefined;
      if (reparse) assert.equal(reparse.conversation["conversation_id"], id);
      results.push({ platform: saved.conversation["platform"]!, messages: ((saved.conversation["messages"] as JsonObject)["items"] as JsonObject[]).length,
        fronts: (saved.conversation["identity"] as JsonObject[]).length, bytes: original.length, markdown_messages: markdown.messageCount,
        resources: ((saved.conversation["resources"] ?? []) as JsonObject[]).length, mark_did_not_change_source: true });
    }
    console.log(JSON.stringify({ real_record_flow: results, source_claude_range: originalRange, sample_batch: path.basename(sample!) })); passed = true;
  } finally {
    if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true }); }
    else console.error(`Retained failed real record flow: ${root}`);
  }
});
