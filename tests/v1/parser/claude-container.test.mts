import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  indexClaudeContainer,
  parseClaudeContainerRecord,
  queryClaudeContainerRecords
} from "../../../src/adapters/parser/claude-container.mts";
import {
  commitNewParsedSource,
  createLocalLibrary,
  importSourceStream,
  prepareCatalogForParser,
  readCatalogCache,
  readSystemLog,
  updateSystemLog
} from "../../../src/adapters/library-data/index.mts";
import {
  validateContainerIndexSchema,
  validateContainerRecordSchema,
  validateConversation
} from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";
import {
  prepareClaudeContainerSelection,
  previewClaudeContainerSelection,
  runPreparedClaudeContainerSelection,
  runClaudeContainerSelection
} from "../../../src/app/parser/claude-batch.mts";

function exportBytes(): Buffer {
  return Buffer.from(JSON.stringify([
    {
      uuid: "conversation-alpha",
      name: "Alpha archive",
      created_at: "2026-08-20T11:10:15.534544Z",
      updated_at: "2026-08-20T12:04:10.369737Z",
      account: { uuid: "private-account-id" },
      chat_messages: [
        {
          uuid: "a1",
          sender: "human",
          parent_message_uuid: null,
          created_at: "2026-08-20T11:11:00Z",
          content: [],
          text: "hello",
          attachments: [{ file_name: "notes.txt", file_type: "text/plain", file_size: 12, extracted_content: "attachment text" }],
          files: [{ file_uuid: "file-one", file_name: "source.pdf" }]
        },
        {
          uuid: "a2",
          sender: "assistant",
          parent_message_uuid: "a1",
          created_at: "2026-08-20T11:12:00Z",
          content: [
            { type: "thinking", thinking_hidden: true, hidden: false, summaries: ["public plan"] },
            { type: "tool_use", id: "tool-one", name: "web_search", input: { query: "Cloudig" }, display_content: { type: "table", title: "Official result card", table: [["Name", "Value"], ["Cloudig", "Reader"]] } },
            { type: "tool_result", tool_use_id: "tool-one", name: "web_search", content: [{ type: "text", text: "result" }, { type: "code_block", language: "text", code: "card result" }], is_error: false },
            { type: "text", text: "one", citations: [{ details: { type: "web_search_citation", url: "https://example.com/source" } }] }
          ]
        },
        { uuid: "a3", sender: "assistant", parent_message_uuid: "a1", content: [{ type: "text", text: "two" }] }
      ]
    },
    {
      uuid: "conversation-beta",
      name: "Beta archive",
      created_at: "2026-08-21T01:00:00Z",
      updated_at: "2026-08-21T02:00:00Z",
      account: { uuid: "private-account-id" },
      chat_messages: [
        { uuid: "b1", sender: "assistant", parent_message_uuid: "missing", content: [{ type: "text", text: "kept root" }] }
      ]
    }
  ], null, 2), "utf8");
}

async function scope(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-v1-claude-container-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function libraryWithClaudeSource(root: string): Promise<string> {
  await createLocalLibrary({
    root,
    transaction: "x_CREATECLAUDEIDXAB",
    timestamp: "2026-08-31T23:00:00.000Z",
    localDate: "2026-08-31",
    offset: "-07:00",
    language: "zh-CN"
  });
  const imported = await importSourceStream({
    libraryRoot: root,
    filename: "conversations.json",
    source: Readable.from([exportBytes()]),
    transaction: "x_IMPORTCLAUDEIDXAB",
    timestamp: "2026-08-31T23:01:00.000Z"
  });
  assert.equal(imported.status, "imported");
  if (imported.status !== "imported") throw new TypeError("Claude fixture import failed");
  return imported.path;
}

test("Claude container index is an atomic source-SHA projection with exact ranges and no raw UUIDs or selection", async () => {
  const testScope = await scope();
  try {
    const sourcePath = await libraryWithClaudeSource(testScope.root);
    const progress: JsonObject[] = [];
    const indexed = await indexClaudeContainer({
      libraryRoot: testScope.root,
      sourcePath,
      buildToken: "x_INDEXCLAUDECONTAB",
      builtAt: "2026-08-31T23:02:00.000Z",
      onProgress: (entry) => progress.push(entry as unknown as JsonObject)
    });
    assert.equal(indexed.status, "created");
    assert.equal(indexed.records, 2);
    assert.match(indexed.directory, /^Data\/Indexes\/Containers\/[0-9a-f]{64}$/u);
    const directory = path.join(testScope.root, ...indexed.directory.split("/"));
    const state = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    assert.equal(validateContainerIndexSchema(state).ok, true);
    assert.equal("selection" in state, false);
    const recordsText = await readFile(path.join(directory, "records.jsonl"), "utf8");
    assert.doesNotMatch(recordsText, /conversation-alpha|conversation-beta|private-account-id/u);
    const records = recordsText.trimEnd().split("\n").map((line) => JSON.parse(line) as JsonObject);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => validateContainerRecordSchema(record).ok));
    assert.equal(records[0]!["branches"], 2);
    assert.equal(records[0]!["fork_points"], 1);
    assert.equal(records[1]!["orphan_parents"], 1);
    const source = await readFile(path.join(testScope.root, ...sourcePath.split("/")));
    for (const [index, record] of records.entries()) {
      const offset = record["offset"] as number;
      const length = record["length"] as number;
      const original = JSON.parse(source.subarray(offset, offset + length).toString("utf8"));
      assert.equal(original.name, index === 0 ? "Alpha archive" : "Beta archive");
    }
    assert.equal(progress.at(-1)?.["phase"], "publish");
    assert.equal(progress.at(-1)?.["totalKnown"], true);

    const warmProgress: string[] = [];
    const warm = await indexClaudeContainer({ libraryRoot: testScope.root, sourcePath, buildToken: "x_WARMCLAUDEINDEXA", builtAt: "2026-09-08T10:00:00.000Z", onProgress: event => { warmProgress.push(event.phase); } });
    assert.equal(warm.status, "unchanged");
    assert.equal(warm.records, indexed.records);
    assert.equal(warmProgress.includes("record"), false, "a verified warm index must not reparse every conversation");

    const defaultQuery = await queryClaudeContainerRecords({ libraryRoot: testScope.root, sourceSha256: indexed.source.sha256 });
    assert.deepEqual(defaultQuery.records.map((record) => record["title"]), ["Beta archive", "Alpha archive"]);
    const titleQuery = await queryClaudeContainerRecords({
      libraryRoot: testScope.root,
      sourceSha256: indexed.source.sha256,
      sort: "title",
      direction: "asc",
      search: "alpha",
      limit: 10
    });
    assert.equal(titleQuery.visible, 1);
    assert.equal(titleQuery.records[0]?.["title"], "Alpha archive");

    assert.equal((await prepareCatalogForParser(testScope.root, "2026-08-31T23:02:30.000Z")).status, "ready");
    const firstParsed = await parseClaudeContainerRecord({
      libraryRoot: testScope.root,
      sourcePath,
      selector: records[0]!["selector"] as string,
      fileSystemCapturedAt: "2026-08-20T10:00:00.000Z"
    });
    const firstMessages = firstParsed.draft["messages"] as JsonObject[];
    assert.deepEqual(firstMessages.map((message) => [message["id"], message["parent"] ?? null]), [["m1", null], ["m2", "m1"], ["m3", "m1"]]);
    assert.equal((firstParsed.draft["resources"] as JsonObject[]).length, 2);
    assert.equal((firstParsed.draft["sources"] as JsonObject[]).length, 1);
    assert.ok((firstMessages[1]!["content"] as JsonObject[]).some((block) => block["type"] === "reasoning_summary"));
    assert.ok((firstMessages[1]!["content"] as JsonObject[]).some((block) => block["type"] === "tool" && block["kind"] === "call"));
    const officialCards = (firstMessages[1]!["content"] as JsonObject[]).filter((block) => block["type"] === "interactive");
    assert.equal(officialCards.length, 2, "official display_content and content Cards are projected separately");
    assert.equal(officialCards[0]!["source"], "claude.ai_table_display_v0");
    assert.equal(officialCards[1]!["source"], "claude.ai_code_block_display_v0");
    const firstCommit = await commitNewParsedSource({
      libraryRoot: testScope.root,
      sourcePath,
      parsed: firstParsed,
      transaction: "x_PARSECLAUDERECONE",
      recoveryTransaction: "x_PARSECLAUDERECOVA",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-08-31T23:02:40.000Z"
    });
    assert.equal(firstCommit.status, "created");
    if (firstCommit.status !== "created") return;
    const secondParsed = await parseClaudeContainerRecord({
      libraryRoot: testScope.root,
      sourcePath,
      selector: records[1]!["selector"] as string,
      fileSystemCapturedAt: "2026-08-20T10:00:00.000Z"
    });
    assert.ok((secondParsed.draft["limitations"] as JsonObject[]).some((entry) => entry["code"] === "source_parent_omitted"));
    const secondCommit = await commitNewParsedSource({
      libraryRoot: testScope.root,
      sourcePath,
      parsed: secondParsed,
      transaction: "x_PARSECLAUDERECTWO",
      recoveryTransaction: "x_PARSECLAUDERECOVB",
      recoveryAlreadyCapturedThisBatch: true,
      timestamp: "2026-08-31T23:02:50.000Z"
    });
    assert.equal(secondCommit.status, "created");
    if (secondCommit.status !== "created") return;
    const firstOutput = JSON.parse(await readFile(path.join(testScope.root, ...firstCommit.path.split("/")), "utf8"));
    const secondOutput = JSON.parse(await readFile(path.join(testScope.root, ...secondCommit.path.split("/")), "utf8"));
    assert.equal(validateConversation(firstOutput).ok, true);
    assert.equal(validateConversation(secondOutput).ok, true);
    assert.equal(firstOutput.title, firstParsed.draft["title"]);
    assert.equal(secondOutput.title, secondParsed.draft["title"]);
    assert.equal(firstOutput.user?.conversation_name, undefined, "do not name every container record conversations");
    assert.equal(secondOutput.user?.conversation_name, undefined);
    const catalog = await readCatalogCache(testScope.root);
    const catalogSources = catalog?.["sources"] as JsonObject[];
    const outputs = catalogSources[0]!["outputs"] as JsonObject[];
    assert.deepEqual(outputs.map((output) => output["selector"]), [records[0]!["selector"], records[1]!["selector"]]);
    const repeat = await commitNewParsedSource({
      libraryRoot: testScope.root,
      sourcePath,
      parsed: await parseClaudeContainerRecord({ libraryRoot: testScope.root, sourcePath, selector: records[0]!["selector"] as string }),
      transaction: "x_PARSECLAUDEREPEAT",
      recoveryTransaction: "x_PARSECLAUDERECOVC",
      recoveryAlreadyCapturedThisBatch: true,
      timestamp: "2026-08-31T23:02:55.000Z"
    });
    assert.deepEqual(repeat, { status: "conflict", reason: "source_record_already_has_output" });

    const unchanged = await indexClaudeContainer({
      libraryRoot: testScope.root,
      sourcePath,
      buildToken: "x_INDEXCLAUDECONTAC",
      builtAt: "2026-08-31T23:03:00.000Z"
    });
    assert.equal(unchanged.status, "unchanged");
    assert.deepEqual((await readdir(path.join(testScope.root, "Data", "Indexes", "Containers"))).filter((name) => name.startsWith(".building-")), []);

    await writeFile(path.join(directory, "state.json"), "{\"damaged\":true}\n", "utf8");
    const conflict = await indexClaudeContainer({
      libraryRoot: testScope.root,
      sourcePath,
      buildToken: "x_INDEXCLAUDECONTAD",
      builtAt: "2026-08-31T23:04:00.000Z"
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(await readFile(path.join(directory, "state.json"), "utf8"), "{\"damaged\":true}\n");
  } finally {
    await testScope.cleanup();
  }
});

test("Claude container cancellation publishes no half-index and removes only its build directory", async () => {
  const testScope = await scope();
  try {
    const sourcePath = await libraryWithClaudeSource(testScope.root);
    const controller = new AbortController();
    const result = await indexClaudeContainer({
      libraryRoot: testScope.root,
      sourcePath,
      buildToken: "x_INDEXCLAUDECANCEL",
      builtAt: "2026-08-31T23:05:00.000Z",
      signal: controller.signal,
      onProgress: (entry) => {
        if (entry.phase === "scan" && entry.bytesCompleted > 0) controller.abort();
      }
    });
    assert.equal(result.status, "cancelled");
    const containers = path.join(testScope.root, "Data", "Indexes", "Containers");
    assert.deepEqual(await readdir(containers), []);
  } finally {
    await testScope.cleanup();
  }
});

test("Claude multi-selection isolates a missing record and still commits the next selected record", async () => {
  const testScope = await scope();
  try {
    const sourcePath = await libraryWithClaudeSource(testScope.root);
    const indexed = await indexClaudeContainer({
      libraryRoot: testScope.root,
      sourcePath,
      buildToken: "x_INDEXCLAUDEMULTIA",
      builtAt: "2026-08-31T23:10:00.000Z"
    });
    assert.equal(indexed.status, "created");
    const query = await queryClaudeContainerRecords({
      libraryRoot: testScope.root,
      sourceSha256: indexed.source.sha256,
      sort: "title",
      direction: "asc"
    });
    const validSelector = query.records[0]!["selector"] as string;
    const missingSelector = "f".repeat(64);
    const preview = await previewClaudeContainerSelection({
      libraryRoot: testScope.root,
      sourceSha256: indexed.source.sha256,
      selectors: [missingSelector, validSelector]
    });
    assert.deepEqual(preview.items.map((item) => item.action), ["missing", "new"]);
    const events: JsonObject[] = [];
    const result = await runClaudeContainerSelection({
      libraryRoot: testScope.root,
      sourcePath,
      selectors: [missingSelector, validSelector],
      operation: "o_CLAUDEMULTIABCDE",
      transactionTokens: ["x_CLAUDEMULTIFAILX", "x_CLAUDEMULTIPASSX"],
      recoveryTransaction: "x_CLAUDEMULTIRECOV",
      timestamp: "2026-08-31T23:11:00.000Z",
      onEvent: (event) => events.push(event)
    });
    assert.deepEqual(result.items.map((item) => item.status), ["failed", "created"]);
    assert.equal((await readdir(path.join(testScope.root, "Conversations"))).length, 1);
    assert.doesNotMatch(JSON.stringify(events), /conversations\.json|[0-9a-f]{64}|Alpha archive/u);
    const refreshed = await queryClaudeContainerRecords({ libraryRoot: testScope.root, sourceSha256: indexed.source.sha256 });
    assert.equal(refreshed.records.find((record) => record["selector"] === validSelector)?.["status"], "parsed");
    const log = await readSystemLog(testScope.root);
    assert.equal(((log["files"] as JsonObject[])[0]!)["path"], sourcePath);
    assert.equal(((((log["files"] as JsonObject[])[0]!)["errors"] as JsonObject[])[0]!)["code"], "claude-record-failed", "A missing selection is not deterministic invalid source content");
  } finally {
    await testScope.cleanup();
  }
});

test("Claude multi-selection cancellation keeps the first committed record and leaves later work unstarted", async () => {
  const testScope = await scope();
  try {
    const sourcePath = await libraryWithClaudeSource(testScope.root);
    const indexed = await indexClaudeContainer({
      libraryRoot: testScope.root,
      sourcePath,
      buildToken: "x_INDEXCLAUDEMULTIB",
      builtAt: "2026-08-31T23:20:00.000Z"
    });
    const query = await queryClaudeContainerRecords({ libraryRoot: testScope.root, sourceSha256: indexed.source.sha256 });
    const selected = query.records.map((record) => record["selector"] as string);
    await updateSystemLog(testScope.root, [{
      path: sourcePath,
      outcome: "errors",
      recordedAt: "2026-08-31T23:19:00.000Z",
      errors: [{ source: "parser", code: "previous", message: "Previous diagnostic" }]
    }]);
    const controller = new AbortController();
    const result = await runClaudeContainerSelection({
      libraryRoot: testScope.root,
      sourcePath,
      selectors: selected,
      operation: "o_CLAUDECANCELABCDE",
      transactionTokens: ["x_CLAUDECANCELPASS", "x_CLAUDECANCELSTOP"],
      recoveryTransaction: "x_CLAUDECANCELRECOV",
      timestamp: "2026-08-31T23:21:00.000Z",
      signal: controller.signal,
      onEvent: (event) => {
        const file = event["file"];
        if (event["phase"] === "extract" && event["state"] === "started" && isJsonObject(file) && file["index"] === 2) {
          controller.abort();
        }
      }
    });
    assert.equal(result.state, "cancelled");
    assert.deepEqual(result.items.map((item) => item.status), ["created", "cancelled"]);
    assert.equal((await readdir(path.join(testScope.root, "Conversations"))).length, 1);
    const catalog = await readCatalogCache(testScope.root);
    const outputs = ((catalog?.["sources"] as JsonObject[])[0]!["outputs"] as JsonObject[]);
    assert.equal(outputs.length, 1);
    const refreshed = await queryClaudeContainerRecords({ libraryRoot: testScope.root, sourceSha256: indexed.source.sha256 });
    assert.equal(refreshed.records.filter((record) => record["status"] === "parsed").length, 1);
    const log = await readSystemLog(testScope.root);
    assert.equal(((((log["files"] as JsonObject[])[0]!)["errors"] as JsonObject[])[0]!)["code"], "previous");
  } finally {
    await testScope.cleanup();
  }
});

test("Claude record failures stop retrying after the second deterministic failure until the Adapter changes", async () => {
  const testScope = await scope();
  try {
    await createLocalLibrary({
      root: testScope.root,
      transaction: "x_CREATECLAUDEFAILA",
      timestamp: "2026-09-01T09:00:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00",
      language: "zh-CN"
    });
    const imported = await importSourceStream({
      libraryRoot: testScope.root,
      filename: "conversations.json",
      source: Readable.from([Buffer.from(JSON.stringify([{
        uuid: "broken-conversation",
        name: "Broken archive",
        chat_messages: [
          { uuid: "duplicate", sender: "human", parent_message_uuid: null, text: "one", content: [] },
          { uuid: "duplicate", sender: "assistant", parent_message_uuid: null, content: [{ type: "text", text: "two" }] }
        ]
      }]), "utf8")]),
      transaction: "x_IMPORTCLAUDEFAILA",
      timestamp: "2026-09-01T09:01:00.000Z"
    });
    assert.equal(imported.status, "imported");
    const indexed = await indexClaudeContainer({
      libraryRoot: testScope.root,
      sourcePath: imported.path,
      buildToken: "x_INDEXCLAUDEFAILAA",
      builtAt: "2026-09-01T09:02:00.000Z"
    });
    const initial = await queryClaudeContainerRecords({ libraryRoot: testScope.root, sourceSha256: indexed.source.sha256 });
    const selector = initial.records[0]!["selector"] as string;
    const execute = async (transaction: string, recovery: string, timestamp: string) => {
      const plan = await prepareClaudeContainerSelection({
        libraryRoot: testScope.root,
        sourcePath: imported.path,
        selectors: [selector],
        preservePrevious: false,
        copyUserStateOnPreserve: false
      });
      return runPreparedClaudeContainerSelection({
        libraryRoot: testScope.root,
        plan,
        copyUserStateOnPreserve: false,
        operation: "o_CLAUDEFAILUREAAAA",
        transactionTokens: [transaction],
        recoveryTransaction: recovery,
        timestamp
      });
    };
    assert.equal((await execute("x_CLAUDEFAILFIRSTA", "x_CLAUDEFAILFIRSTB", "2026-09-01T09:03:00.000Z")).items[0]?.status, "failed");
    const log = await readSystemLog(testScope.root);
    assert.equal(((log["files"] as JsonObject[])[0]!["path"]), imported.path);
    assert.equal(((((log["files"] as JsonObject[])[0]!)["errors"] as JsonObject[])[0]!)["code"], "claude-record-invalid");
    let queried = await queryClaudeContainerRecords({ libraryRoot: testScope.root, sourceSha256: indexed.source.sha256 });
    assert.deepEqual(queried.statuses, { ready: 0, parsed: 0, update: 0, failed: 1, unsupported: 0 });
    assert.equal(queried.records[0]?.["status"], "failed");
    assert.equal((await execute("x_CLAUDEFAILSECONDA", "x_CLAUDEFAILSECONDB", "2026-09-01T09:04:00.000Z")).items[0]?.status, "failed");
    queried = await queryClaudeContainerRecords({ libraryRoot: testScope.root, sourceSha256: indexed.source.sha256 });
    assert.deepEqual(queried.statuses, { ready: 0, parsed: 0, update: 0, failed: 0, unsupported: 1 });
    assert.equal(queried.records[0]?.["status"], "unsupported");
    assert.equal((await execute("x_CLAUDEFAILTHIRDA", "x_CLAUDEFAILTHIRDB", "2026-09-01T09:05:00.000Z")).items[0]?.status, "unsupported");
  } finally {
    await testScope.cleanup();
  }
});
