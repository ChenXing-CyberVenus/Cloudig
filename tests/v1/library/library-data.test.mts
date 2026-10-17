import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createLocalLibrary,
  createArchiveDirectory,
  adoptConflictingArchive,
  deleteEmptyArchiveDirectory,
  archiveConversation,
  inspectLocalLibrary,
  importSourceStream,
  listArchiveRows,
  moveArchiveFile,
  openConversationExact,
  planRecycleConversation,
  readCatalogCache,
  refreshCatalogAfterArchiveMove,
  refreshCatalogAfterArchiveRemoval,
  readSystemLog,
  rebuildCatalogFromAuthority,
  rebuildCatalogCache,
  renameArchiveDirectory,
  restoreConversation,
  scanLibraryFiles,
  updateSystemLog
} from "../../../src/adapters/library-data/index.mts";
import {
  capturePreviousAuthority,
  fingerprintFile,
  readPreviousAuthorityPair,
  restorePreviousAuthority,
  stageJournalTargets
} from "../../../src/adapters/storage/index.mts";
import { serializeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

async function disposable(): Promise<{ base: string; root: string; cleanup: () => Promise<void> }> {
  const temporaryRoot = path.join(process.cwd(), "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const base = await mkdtemp(path.join(temporaryRoot, "cloudig-v1-library-"));
  const root = path.join(base, "Cloudig");
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const CREATE = {
  transaction: "x_CREATELIBRARYABCDE",
  timestamp: "2026-08-31T14:00:00.000Z",
  localDate: "2026-08-31",
  offset: "-07:00",
  language: "zh-CN" as const
};

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(absolute);
      else {
        const info = await stat(absolute, { bigint: true });
        const bytes = await readFile(absolute);
        result[relative] = `${info.size}:${info.mtimeNs}:${createHash("sha256").update(bytes).digest("hex")}`;
      }
    }
  }
  await walk(root);
  return result;
}

test("clean Library creation uses one transaction and freezes Dawn defaults", async () => {
  const scope = await disposable();
  try {
    const pair = await createLocalLibrary({ root: scope.root, ...CREATE });
    assert.equal(pair.library["next_archive"], 1);
    assert.deepEqual(pair.library["preferences"], { language: "zh-CN", theme: "dawn" });
    const parse = pair.library["parse"] as JsonObject;
    assert.deepEqual(parse["ordinary"], { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false });
    assert.deepEqual(parse["claude"], parse["ordinary"]);
    assert.deepEqual(pair.library["workflow"], {
      parser: { sort: "time_desc", time_field: "file_modified_at" },
      archiver: { sort: "time_desc", time_field: "cloudig_edited_at" },
      reader: { sort: "time_desc", time_field: "cloudig_edited_at" },
      claude: { sort: "time_desc", time_field: "updated_at" }
    });
    const terran = pair.time["terran_values"] as JsonObject;
    assert.deepEqual(Object.keys(terran), ["p13", "p14", "p15"]);
    assert.equal((await inspectLocalLibrary(scope.root)).status, "valid");
    for (const relative of ["Inbox", "Conversations", "Exports", "Data/State", "Data/Assets/User", "Data/Indexes", "Data/Transactions", "Data/Recovery/Previous", "Data/Runtime", "Data/Logs"]) {
      assert.equal((await stat(path.join(scope.root, ...relative.split("/")))).isDirectory(), true, relative);
    }
  } finally {
    await scope.cleanup();
  }
});

test("create refuses nonempty roots and never overwrites an existing Library", async () => {
  const scope = await disposable();
  try {
    await mkdir(scope.root);
    const marker = path.join(scope.root, "user-file.txt");
    await writeFile(marker, "mine", "utf8");
    await assert.rejects(createLocalLibrary({ root: scope.root, ...CREATE }), /missing or an explicitly empty/u);
    assert.equal(await readFile(marker, "utf8"), "mine");

    await rm(scope.root, { recursive: true, force: true });
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const beforeLibrary = await fingerprintFile(path.join(scope.root, "cloudig-library.json"));
    await assert.rejects(createLocalLibrary({ root: scope.root, ...CREATE, transaction: "x_CREATELIBRARYBCDEF" }));
    assert.deepEqual(await fingerprintFile(path.join(scope.root, "cloudig-library.json")), beforeLibrary);
  } finally {
    await scope.cleanup();
  }
});

test("open.inspect is byte-for-byte zero-write for a valid Library", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const before = await inventory(scope.root);
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "valid");
    assert.deepEqual(await inventory(scope.root), before);
  } finally {
    await scope.cleanup();
  }
});

test("inspect reports previous recovery without mutating damaged current authority", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    assert.equal(await capturePreviousAuthority(scope.root, {
      transaction: "x_CAPTUREPREVIOUSABC",
      recordedAt: "2026-08-31T14:01:00.000Z",
      alreadyCapturedThisBatch: false
    }), "captured");
    await writeFile(path.join(scope.root, "cloudig-library.json"), "{broken", "utf8");
    const before = await inventory(scope.root);
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "recovery_available");
    assert.deepEqual(await inventory(scope.root), before);
  } finally {
    await scope.cleanup();
  }
});

test("previous recovery replaces damaged current authority with a new revision and preserves the recovery point", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    assert.equal(await capturePreviousAuthority(scope.root, {
      transaction: "x_CAPTURERESTOREABCD",
      recordedAt: "2026-08-31T14:03:00.000Z",
      alreadyCapturedThisBatch: false
    }), "captured");
    const previous = await readPreviousAuthorityPair(scope.root);
    const recoveryBefore = {
      library: await fingerprintFile(path.join(scope.root, "Data", "Recovery", "Previous", "cloudig-library.json")),
      time: await fingerprintFile(path.join(scope.root, "Data", "Recovery", "Previous", "content-time.json")),
      manifest: await fingerprintFile(path.join(scope.root, "Data", "Recovery", "Previous", "manifest.json"))
    };
    await writeFile(path.join(scope.root, "cloudig-library.json"), "{broken", "utf8");
    await writeFile(path.join(scope.root, "Data", "State", "content-time.json"), "[]", "utf8");

    const restored = await restorePreviousAuthority(scope.root, {
      transaction: "x_RESTOREPREVIOUSABC",
      restoredAt: "2026-08-31T14:04:00.000Z"
    });
    assert.equal(restored.library["revision"], (previous.library["revision"] as number) + 1);
    assert.equal(restored.time["revision"], (previous.time["revision"] as number) + 1);
    assert.equal(restored.library["edited_at"], "2026-08-31T14:04:00.000Z");
    assert.equal(restored.time["edited_at"], "2026-08-31T14:04:00.000Z");
    assert.deepEqual(await inspectLocalLibrary(scope.root), { status: "valid", pair: restored });
    assert.deepEqual({
      library: await fingerprintFile(path.join(scope.root, "Data", "Recovery", "Previous", "cloudig-library.json")),
      time: await fingerprintFile(path.join(scope.root, "Data", "Recovery", "Previous", "content-time.json")),
      manifest: await fingerprintFile(path.join(scope.root, "Data", "Recovery", "Previous", "manifest.json"))
    }, recoveryBefore);
    assert.deepEqual(await readdir(path.join(scope.root, "Data", "Transactions")), []);
  } finally {
    await scope.cleanup();
  }
});

test("previous recovery recreates missing current authority but never replaces a valid pair", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    assert.equal(await capturePreviousAuthority(scope.root, {
      transaction: "x_CAPTUREMISSINGABCD",
      recordedAt: "2026-08-31T14:05:00.000Z",
      alreadyCapturedThisBatch: false
    }), "captured");
    await rm(path.join(scope.root, "cloudig-library.json"));
    await rm(path.join(scope.root, "Data", "State", "content-time.json"));
    const restored = await restorePreviousAuthority(scope.root, {
      transaction: "x_RESTOREMISSINGABCD",
      restoredAt: "2026-08-31T14:06:00.000Z"
    });
    assert.equal((await inspectLocalLibrary(scope.root)).status, "valid");
    const before = await inventory(scope.root);
    await assert.rejects(restorePreviousAuthority(scope.root, {
      transaction: "x_REFUSEVALIDPAIRABC",
      restoredAt: "2026-08-31T14:07:00.000Z"
    }), /Current authority is valid/u);
    assert.deepEqual(await inventory(scope.root), before);
    assert.equal(restored.library["edited_at"], "2026-08-31T14:06:00.000Z");
  } finally {
    await scope.cleanup();
  }
});

test("inspect reports unresolved journals before claiming current authority is ready", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const pending: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: "x_PENDINGJOURNALABCD",
      state: "planned",
      intent: "test-pending",
      created_at: "2026-08-31T14:02:00.000Z",
      updated_at: "2026-08-31T14:02:00.000Z",
      authority: { library: { state: "missing" } },
      targets: [{
        action: "create",
        path: "Inbox/pending.html",
        status: "planned",
        expected_before: { state: "missing" },
        semantic: { kind: "source_import" }
      }]
    };
    await stageJournalTargets(scope.root, pending, new Map([[0, Readable.from([Buffer.from("pending")])]]));
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "transaction_recovery");
    if (inspection.status === "transaction_recovery") assert.deepEqual(inspection.transactions, ["x_PENDINGJOURNALABCD"]);
  } finally {
    await scope.cleanup();
  }
});

test("inspect distinguishes missing and newer unsupported Library roots", async () => {
  const scope = await disposable();
  try {
    assert.equal((await inspectLocalLibrary(scope.root)).status, "missing");
    await mkdir(path.join(scope.root, "Data", "Transactions"), { recursive: true });
    await writeFile(path.join(scope.root, "cloudig-library.json"), JSON.stringify({ schema: "cloudig/library/2.0.0" }), "utf8");
    const inspection = await inspectLocalLibrary(scope.root);
    assert.deepEqual(inspection, { status: "unsupported", schema: "cloudig/library/2.0.0" });
  } finally {
    await scope.cleanup();
  }
});

test("System Log replaces only processed file groups, preserves cancellation, and removes clean success", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    await writeFile(path.join(scope.root, "Inbox", "one.html"), "source", "utf8");
    assert.equal(await updateSystemLog(scope.root, [{
      path: "Inbox/one.html",
      outcome: "errors",
      recordedAt: "2026-08-31T14:10:00.000Z",
      errors: [
        { source: "exporter", code: "first", message: "第一条" },
        { source: "parser", code: "second", stage: "normalize", message: "第二条" }
      ]
    }]), "written");
    let log = await readSystemLog(scope.root);
    assert.equal((log["files"] as JsonObject[]).length, 1);
    assert.deepEqual(((log["files"] as JsonObject[])[0]!["errors"] as JsonObject[]).map((entry) => entry["code"]), ["first", "second"]);

    assert.equal(await updateSystemLog(scope.root, [{ path: "Inbox/one.html", outcome: "cancelled" }]), "written");
    log = await readSystemLog(scope.root);
    assert.equal((log["files"] as JsonObject[]).length, 1);
    await rm(path.join(scope.root, "Inbox", "one.html"));
    assert.equal(((await readSystemLog(scope.root))["files"] as JsonObject[]).length, 1);

    assert.equal(await updateSystemLog(scope.root, [{ path: "Inbox/one.html", outcome: "success_no_errors" }]), "written");
    assert.deepEqual(await readSystemLog(scope.root), { schema: "cloudig/system-log/1.0.0", files: [] });
  } finally {
    await scope.cleanup();
  }
});

test("reading System Log is zero-write and never checks whether recorded files still exist", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    await updateSystemLog(scope.root, [{
      path: "Inbox/missing.html",
      outcome: "errors",
      recordedAt: "2026-08-31T14:11:00.000Z",
      errors: [{ source: "canonical", message: "来源缺少一个可见节点" }]
    }]);
    const before = await inventory(scope.root);
    const log = await readSystemLog(scope.root);
    assert.equal(((log["files"] as JsonObject[])[0]!["path"]), "Inbox/missing.html");
    assert.deepEqual(await inventory(scope.root), before);
  } finally {
    await scope.cleanup();
  }
});

test("Catalog scan is zero-write, Inbox-shallow, and isolates archives without summaries", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    await writeFile(path.join(scope.root, "Inbox", "chat.html"), "<html></html>", "utf8");
    await mkdir(path.join(scope.root, "Inbox", "ignored"));
    await writeFile(path.join(scope.root, "Inbox", "ignored", "nested.html"), "ignored", "utf8");
    const fixtureRoot = new URL("../contracts/fixtures/", import.meta.url);
    const conversation = JSON.parse(await readFile(new URL("conversation-full.json", fixtureRoot), "utf8")) as JsonObject;
    const conversationPath = path.join(scope.root, "Conversations", "chat.json");
    await writeFile(conversationPath, serializeConversation(conversation), "utf8");
    await writeFile(path.join(scope.root, "Conversations", "broken.json"), "{broken", "utf8");

    const before = await inventory(scope.root);
    const scan = await scanLibraryFiles(scope.root);
    assert.deepEqual(scan.sources.map((entry) => entry.path), ["Inbox/chat.html"]);
    assert.deepEqual(scan.archives.map((entry) => entry.path), ["Conversations/broken.json", "Conversations/chat.json"]);
    assert.deepEqual(await inventory(scope.root), before);

    const sourceObservation = scan.sources[0]!;
    const archiveObservation = scan.archives.find((entry) => entry.path === "Conversations/chat.json")!;
    const archiveFingerprint = await fingerprintFile(conversationPath);
    const result = await rebuildCatalogCache(scope.root, {
      builtAt: "2026-08-31T14:20:00.000Z",
      adapterBundleSha256: "a".repeat(64),
      sourceRows: {
        "Inbox/chat.html": {
          status: "complete",
          route: {
            format: "exporter-html",
            platform: "chatgpt",
            payload_schema: "ai-chat-archive/export-v1",
            profile: "tree",
            adapter: { id: "chatgpt-tree", version: "1.0.0" }
          },
          outputs: [{
            archive: "a2",
            generation: 3,
            path: "Conversations/chat.json",
            conversation_schema: "cloudig/conversation/1.0.0",
            parser: "1.0.0",
            adapter: { id: "chatgpt-tree", version: "1.0.0" },
            profile: "tree",
            payload_schema: "ai-chat-archive/export-v1"
          }],
          sha256: createHash("sha256").update(await readFile(path.join(scope.root, "Inbox", "chat.html"))).digest("hex")
        }
      },
      archiveRows: {
        "Conversations/chat.json": {
          sha256: archiveFingerprint.sha256,
          conversation_schema: "cloudig/conversation/1.0.0",
          archive: "a2",
          generation: 3,
          source_file: "scheduled-tree.html",
          source_title: "Scheduled tree example",
          platform: "chatgpt",
          models: ["GPT-5.6-Sol"],
          message_count: 2,
          resource_count: 2,
          times: {
            json_edited_at: "2026-08-31T12:00:00.000Z",
            json_created_at: "2026-08-30T10:00:00.000Z",
            message_start: "2026-08-30T09:00:00.000Z",
            message_end: "2026-08-31T10:00:00.000Z",
            ...(
              conversation["content_time"] && typeof conversation["content_time"] === "object"
              && (conversation["content_time"] as JsonObject)["range"] !== undefined
                ? { content: (conversation["content_time"] as JsonObject)["range"]! }
                : {}
            )
          }
        }
      }
    });
    assert.equal(sourceObservation.path, "Inbox/chat.html");
    assert.equal(archiveObservation.path, "Conversations/chat.json");
    assert.equal(result.status, "written");
    assert.ok(result.issues.some((entry) => entry.path === "Conversations/broken.json" && entry.code === "archive-summary-unavailable"));
    const catalog = await readCatalogCache(scope.root);
    assert.ok(catalog);
    assert.equal((catalog["sources"] as JsonObject[]).length, 1);
    assert.equal((catalog["archives"] as JsonObject[]).length, 1);
  } finally {
    await scope.cleanup();
  }
});

test("deleting Catalog loses no authority and only makes the next query cacheless", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const libraryBefore = await fingerprintFile(path.join(scope.root, "cloudig-library.json"));
    const timeBefore = await fingerprintFile(path.join(scope.root, "Data", "State", "content-time.json"));
    const result = await rebuildCatalogCache(scope.root, {
      builtAt: "2026-08-31T14:21:00.000Z",
      adapterBundleSha256: "b".repeat(64),
      archiveRows: {}
    });
    assert.equal(result.status, "written");
    const catalogPath = path.join(scope.root, "Data", "Indexes", "Catalog", "snapshot.json");
    await rm(catalogPath);
    assert.equal(await readCatalogCache(scope.root), undefined);
    assert.deepEqual(await fingerprintFile(path.join(scope.root, "cloudig-library.json")), libraryBefore);
    assert.deepEqual(await fingerprintFile(path.join(scope.root, "Data", "State", "content-time.json")), timeBefore);
  } finally {
    await scope.cleanup();
  }
});

test("a missing Catalog is rebuilt from Conversation authority while one broken archive stays isolated", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const fixtureRoot = new URL("../contracts/fixtures/", import.meta.url);
    const conversation = JSON.parse(await readFile(new URL("conversation-full.json", fixtureRoot), "utf8")) as JsonObject;
    await writeFile(path.join(scope.root, "Inbox", "scheduled-tree.html"), "source bytes", "utf8");
    await writeFile(path.join(scope.root, "Conversations", "chat.json"), serializeConversation(conversation), "utf8");
    await writeFile(path.join(scope.root, "Conversations", "broken.json"), "{broken", "utf8");
    await rm(path.join(scope.root, "Data", "Indexes"), { recursive: true, force: true });
    const progress: Array<[number, number]> = [];
    const rebuilt = await rebuildCatalogFromAuthority({
      libraryRoot: scope.root,
      builtAt: "2026-08-31T14:22:00.000Z",
      adapterBundleSha256: "c".repeat(64),
      onProgress: (completed, total) => progress.push([completed, total])
    });
    assert.equal(rebuilt.status, "written");
    assert.equal(rebuilt.archives, 1);
    assert.equal(rebuilt.sources, 1);
    assert.deepEqual(progress.at(-1), [2, 2]);
    assert.ok(rebuilt.issues.some((entry) => entry.path === "Conversations/broken.json" && entry.code === "archive-summary-unavailable"));
    const catalog = (await readCatalogCache(scope.root))!;
    const sources = catalog["sources"] as JsonObject[];
    const archives = catalog["archives"] as JsonObject[];
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!["path"], "Inbox/scheduled-tree.html");
    assert.equal((sources[0]!["outputs"] as JsonObject[])[0]!["archive"], conversation["archive"]);
    assert.equal(archives.length, 1);
    assert.equal(archives[0]!["path"], "Conversations/chat.json");
  } finally {
    await scope.cleanup();
  }
});

test("source import is streaming, no-replace, collision-safe, and never parses or edits Library authority", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const libraryBefore = await fingerprintFile(path.join(scope.root, "cloudig-library.json"));
    const firstBytes = Buffer.from("first source", "utf8");
    const secondBytes = Buffer.from("second source", "utf8");
    const first = await importSourceStream({
      libraryRoot: scope.root,
      filename: "chat.html",
      source: Readable.from([firstBytes.subarray(0, 2), firstBytes.subarray(2)]),
      transaction: "x_IMPORTSOURCEABCDE",
      timestamp: "2026-08-31T14:25:00.000Z",
      capturedAt: "2026-06-30T12:34:56.000Z"
    });
    const second = await importSourceStream({
      libraryRoot: scope.root,
      filename: "chat.html",
      source: Readable.from([secondBytes]),
      transaction: "x_IMPORTSOURCEBCDEF",
      timestamp: "2026-08-31T14:26:00.000Z"
    });
    assert.equal(first.status, "imported");
    assert.equal(second.status, "imported");
    if (first.status === "imported" && second.status === "imported") {
      assert.equal(first.path, "Inbox/chat.html");
      assert.equal(second.path, "Inbox/chat (2).html");
      assert.deepEqual(await readFile(path.join(scope.root, ...first.path.split("/"))), firstBytes);
      assert.ok(Math.abs((await stat(path.join(scope.root, ...first.path.split("/")))).mtimeMs - Date.parse("2026-06-30T12:34:56.000Z")) < 1_000);
      assert.deepEqual(await readFile(path.join(scope.root, ...second.path.split("/"))), secondBytes);
    }
    assert.deepEqual(await readdir(path.join(scope.root, "Conversations")), []);
    assert.deepEqual(await fingerprintFile(path.join(scope.root, "cloudig-library.json")), libraryBefore);
  } finally {
    await scope.cleanup();
  }
});

test("first-level directories and archive moves are no-replace, journaled, and leave Library state untouched", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const libraryBefore = await fingerprintFile(path.join(scope.root, "cloudig-library.json"));
    const bytes = Buffer.from("conversation bytes", "utf8");
    await writeFile(path.join(scope.root, "Conversations", "chat.json"), bytes);

    await createArchiveDirectory(scope.root, "Folder");
    assert.equal(await moveArchiveFile({
      libraryRoot: scope.root,
      source: "Conversations/chat.json",
      target: "Conversations/Folder/chat.json",
      transaction: "x_MOVEARCHIVEABCDE",
      timestamp: "2026-08-31T14:30:00.000Z"
    }), "moved");
    await assert.rejects(stat(path.join(scope.root, "Conversations", "chat.json")));
    assert.deepEqual(await readFile(path.join(scope.root, "Conversations", "Folder", "chat.json")), bytes);

    await renameArchiveDirectory(scope.root, "Folder", "Renamed");
    await assert.rejects(deleteEmptyArchiveDirectory(scope.root, "Renamed"), /completely empty/u);
    assert.equal(await archiveConversation({
      libraryRoot: scope.root,
      source: "Conversations/Renamed/chat.json",
      transaction: "x_ARCHIVECONVABCDE",
      timestamp: "2026-08-31T14:31:00.000Z"
    }), "moved");
    await deleteEmptyArchiveDirectory(scope.root, "Renamed");
    assert.deepEqual(await readFile(path.join(scope.root, "Conversations", ".Cloudig-Archive", "chat.json")), bytes);

    assert.equal(await restoreConversation({
      libraryRoot: scope.root,
      source: "Conversations/.Cloudig-Archive/chat.json",
      transaction: "x_RESTORECONVABCDE",
      timestamp: "2026-08-31T14:32:00.000Z"
    }), "moved");
    const restored = path.join(scope.root, "Conversations", "chat.json");
    assert.deepEqual(await readFile(restored), bytes);
    assert.deepEqual(await planRecycleConversation(scope.root, "Conversations/chat.json"), {
      capability: "recycle-conversation",
      path: "Conversations/chat.json",
      ...await fingerprintFile(restored)
    });
    assert.deepEqual(await readFile(restored), bytes);
    assert.deepEqual(await fingerprintFile(path.join(scope.root, "cloudig-library.json")), libraryBefore);
  } finally {
    await scope.cleanup();
  }
});

test("archive move and recycle refresh only the matching rebuildable Catalog row", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const sourceFile = path.join(scope.root, "Inbox", "source.html");
    const conversationFile = path.join(scope.root, "Conversations", "chat.json");
    await writeFile(sourceFile, "source", "utf8");
    await writeFile(conversationFile, "conversation bytes", "utf8");
    const sourceFingerprint = await fingerprintFile(sourceFile);
    const archiveFingerprint = await fingerprintFile(conversationFile);
    const output = {
      archive: "a1",
      generation: 1,
      path: "Conversations/chat.json",
      conversation_schema: "cloudig/conversation/1.0.0",
      parser: "1.0.0",
      adapter: { id: "fixture", version: "1.0.0" }
    } satisfies JsonObject;
    const row = {
      sha256: archiveFingerprint.sha256,
      conversation_schema: "cloudig/conversation/1.0.0",
      archive: "a1",
      generation: 1,
      source_file: "source.html",
      source_title: "Catalog move fixture",
      platform: "chatgpt",
      message_count: 1,
      resource_count: 0,
      archived: false
    } satisfies JsonObject;
    assert.equal((await rebuildCatalogCache(scope.root, {
      builtAt: "2026-08-31T14:29:00.000Z",
      adapterBundleSha256: "e".repeat(64),
      sourceRows: {
        "Inbox/source.html": {
          sha256: sourceFingerprint.sha256,
          status: "complete",
          outputs: [output]
        }
      },
      archiveRows: { "Conversations/chat.json": row }
    })).status, "written");

    await createArchiveDirectory(scope.root, "Folder");
    assert.equal(await moveArchiveFile({
      libraryRoot: scope.root,
      source: "Conversations/chat.json",
      target: "Conversations/Folder/chat.json",
      transaction: "x_CATALOGMOVEABCDE",
      timestamp: "2026-08-31T14:30:00.000Z"
    }), "moved");
    assert.equal(await refreshCatalogAfterArchiveMove(scope.root, {
      sourcePath: "Conversations/chat.json",
      targetPath: "Conversations/Folder/chat.json",
      targetArchived: false,
      expected: { archive: "a1", generation: 1, fingerprint: archiveFingerprint },
      builtAt: "2026-08-31T14:30:01.000Z"
    }), "written");
    let catalog = (await readCatalogCache(scope.root))!;
    assert.equal(((catalog["archives"] as JsonObject[])[0] as JsonObject)["path"], "Conversations/Folder/chat.json");
    assert.equal((((catalog["sources"] as JsonObject[])[0]!["outputs"] as JsonObject[])[0] as JsonObject)["path"], "Conversations/Folder/chat.json");

    assert.equal(await archiveConversation({
      libraryRoot: scope.root,
      source: "Conversations/Folder/chat.json",
      transaction: "x_CATALOGARCHIVEABC",
      timestamp: "2026-08-31T14:31:00.000Z"
    }), "moved");
    assert.equal(await refreshCatalogAfterArchiveMove(scope.root, {
      sourcePath: "Conversations/Folder/chat.json",
      targetPath: "Conversations/.Cloudig-Archive/chat.json",
      targetArchived: true,
      expected: { archive: "a1", generation: 1, fingerprint: archiveFingerprint },
      builtAt: "2026-08-31T14:31:01.000Z"
    }), "written");
    catalog = (await readCatalogCache(scope.root))!;
    assert.equal(((catalog["archives"] as JsonObject[])[0] as JsonObject)["archived"], true);

    await rm(path.join(scope.root, "Conversations", ".Cloudig-Archive", "chat.json"));
    assert.equal(await refreshCatalogAfterArchiveRemoval(scope.root, {
      path: "Conversations/.Cloudig-Archive/chat.json",
      expected: { archive: "a1", generation: 1, fingerprint: archiveFingerprint },
      builtAt: "2026-08-31T14:32:00.000Z"
    }), "written");
    catalog = (await readCatalogCache(scope.root))!;
    assert.deepEqual(catalog["archives"], []);
    assert.equal((catalog["sources"] as JsonObject[])[0]!["status"], "pending");
    assert.equal((catalog["sources"] as JsonObject[])[0]!["outputs"], undefined);
  } finally {
    await scope.cleanup();
  }
});

test("archive move conflict preserves both unknown target and source bytes", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const source = Buffer.from("source", "utf8");
    const target = Buffer.from("unknown target", "utf8");
    await writeFile(path.join(scope.root, "Conversations", "source.json"), source);
    await writeFile(path.join(scope.root, "Conversations", "target.json"), target);
    assert.equal(await moveArchiveFile({
      libraryRoot: scope.root,
      source: "Conversations/source.json",
      target: "Conversations/target.json",
      transaction: "x_MOVECONFLICTABCD",
      timestamp: "2026-08-31T14:33:00.000Z"
    }), "conflict");
    assert.deepEqual(await readFile(path.join(scope.root, "Conversations", "source.json")), source);
    assert.deepEqual(await readFile(path.join(scope.root, "Conversations", "target.json")), target);
  } finally {
    await scope.cleanup();
  }
});

test("archive writes reject deeper external directories and never create a missing user target directory", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const sourcePath = path.join(scope.root, "Conversations", "source.json");
    await writeFile(sourcePath, "source", "utf8");

    await assert.rejects(moveArchiveFile({
      libraryRoot: scope.root,
      source: "Conversations/source.json",
      target: "Conversations/Missing/source.json",
      transaction: "x_MOVEMISSINGDIRABC",
      timestamp: "2026-08-31T14:34:00.000Z"
    }));
    await assert.rejects(stat(path.join(scope.root, "Conversations", "Missing")));
    assert.equal(await readFile(sourcePath, "utf8"), "source");

    await mkdir(path.join(scope.root, "Conversations", "External", "Deep"), { recursive: true });
    await writeFile(path.join(scope.root, "Conversations", "External", "Deep", "deep.json"), "deep", "utf8");
    await assert.rejects(planRecycleConversation(scope.root, "Conversations/External/Deep/deep.json"), /root and one first-level/u);
    await assert.rejects(restoreConversation({
      libraryRoot: scope.root,
      source: "Conversations/source.json",
      transaction: "x_RESTORENOTARCHIVED",
      timestamp: "2026-08-31T14:35:00.000Z"
    }), /inside .Cloudig-Archive/u);
  } finally {
    await scope.cleanup();
  }
});

test("archive list keeps duplicate aN as separate read-only rows and exact open remains zero-write", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const fixtureRoot = new URL("../contracts/fixtures/", import.meta.url);
    const conversation = JSON.parse(await readFile(new URL("conversation-full.json", fixtureRoot), "utf8")) as JsonObject;
    const bytes = Buffer.from(serializeConversation(conversation), "utf8");
    const first = path.join(scope.root, "Conversations", "one.json");
    const second = path.join(scope.root, "Conversations", "two.json");
    await writeFile(first, bytes);
    await writeFile(second, bytes);
    const fingerprint = await fingerprintFile(first);
    const row = {
      sha256: fingerprint.sha256,
      conversation_schema: "cloudig/conversation/1.0.0",
      archive: "a2",
      generation: 3,
      source_file: "scheduled-tree.html",
      source_title: "Scheduled tree example",
      platform: "chatgpt",
      models: ["GPT-5.6-Sol"],
      message_count: 2,
      resource_count: 2,
      times: {
        json_edited_at: "2026-08-31T12:00:00.000Z",
        json_created_at: "2026-08-30T10:00:00.000Z",
        content: (conversation["content_time"] as JsonObject)["range"]!
      }
    } satisfies JsonObject;
    assert.equal((await rebuildCatalogCache(scope.root, {
      builtAt: "2026-08-31T14:40:00.000Z",
      adapterBundleSha256: "c".repeat(64),
      archiveRows: {
        "Conversations/one.json": row,
        "Conversations/two.json": { ...row, sha256: (await fingerprintFile(second)).sha256 }
      }
    })).status, "written");
    const builtins = {
      user: { name: "User", avatar: "Assets/user.svg" },
      assistant: { name: "AI", avatar: "Assets/ai.svg" },
      platforms: { chatgpt: { name: "ChatGPT", avatar: "Assets/chatgpt.svg" } }
    } as const;
    const list = await listArchiveRows(scope.root, {
      builtins,
      availableAssets: new Set(),
      portableUserSnapshots: {
        "Conversations/one.json": conversation["user"] as JsonObject,
        "Conversations/two.json": conversation["user"] as JsonObject
      }
    });
    assert.equal(list.degraded, false);
    assert.equal(list.rows.length, 2);
    assert.ok(list.rows.every((entry) => entry.access === "read_only_conflict"));
    assert.ok(list.rows.every((entry) => entry.view.conversationName === "My scheduled example"));
    const before = await inventory(scope.root);
    const opened = await openConversationExact(scope.root, "Conversations/one.json", builtins, new Set());
    assert.equal(opened.conversation["archive"], "a2");
    assert.equal(opened.view.conversationName, "My scheduled example");
    assert.deepEqual(await inventory(scope.root), before);
  } finally {
    await scope.cleanup();
  }
});

test("explicit adoption gives one duplicate aN a new local identity in one authority transaction", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, ...CREATE });
    const fixtureRoot = new URL("../contracts/fixtures/", import.meta.url);
    const conversation = JSON.parse(await readFile(new URL("conversation-full.json", fixtureRoot), "utf8")) as JsonObject;
    const bytes = Buffer.from(serializeConversation(conversation), "utf8");
    const first = path.join(scope.root, "Conversations", "one.json");
    const second = path.join(scope.root, "Conversations", "two.json");
    await writeFile(first, bytes);
    await writeFile(second, bytes);
    const firstFingerprint = await fingerprintFile(first);
    const secondFingerprint = await fingerprintFile(second);
    const row = {
      conversation_schema: "cloudig/conversation/1.0.0",
      archive: "a2",
      generation: 3,
      source_file: "scheduled-tree.html",
      source_title: "Scheduled tree example",
      platform: "chatgpt",
      models: ["GPT-5.6-Sol"],
      message_count: 2,
      resource_count: 2,
      times: {
        json_edited_at: "2026-08-31T12:00:00.000Z",
        json_created_at: "2026-08-30T10:00:00.000Z",
        content: (conversation["content_time"] as JsonObject)["range"]!
      }
    } satisfies JsonObject;
    assert.equal((await rebuildCatalogCache(scope.root, {
      builtAt: "2026-08-31T14:50:00.000Z",
      adapterBundleSha256: "d".repeat(64),
      archiveRows: {
        "Conversations/one.json": { ...row, sha256: firstFingerprint.sha256 },
        "Conversations/two.json": { ...row, sha256: secondFingerprint.sha256 }
      }
    })).status, "written");

    const result = await adoptConflictingArchive({
      libraryRoot: scope.root,
      path: "Conversations/two.json",
      expected: { archive: "a2", generation: 3, ...secondFingerprint },
      transaction: "x_ADOPTARCHIVEABCDE",
      recoveryTransaction: "x_ADOPTRECOVERYABCDE",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-08-31T14:51:00.000Z"
    });
    assert.equal(result.status, "adopted");
    if (result.status === "adopted") {
      assert.equal(result.archive, "a3");
      assert.equal(result.catalog, "written");
    }
    const adopted = JSON.parse(await readFile(second, "utf8")) as JsonObject;
    assert.equal(adopted["archive"], "a3");
    assert.equal(adopted["generation"], 3);
    assert.equal(adopted["content_sha256"], conversation["content_sha256"]);
    assert.deepEqual(adopted["user"], conversation["user"]);
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "valid");
    if (inspection.status === "valid") {
      assert.equal(inspection.pair.library["next_archive"], 4);
      assert.equal(inspection.pair.library["revision"], 2);
    }
    const previous = await readPreviousAuthorityPair(scope.root);
    assert.equal(previous.library["next_archive"], 1);
    assert.equal(previous.library["revision"], 1);
    const catalog = await readCatalogCache(scope.root);
    assert.ok(catalog && Array.isArray(catalog["archives"]));
    assert.deepEqual((catalog["archives"] as JsonObject[]).map((entry) => entry["archive"]).sort(), ["a2", "a3"]);

    const beforeRetry = await inventory(scope.root);
    const retry = await adoptConflictingArchive({
      libraryRoot: scope.root,
      path: "Conversations/two.json",
      expected: { archive: "a2", generation: 3, ...secondFingerprint },
      transaction: "x_ADOPTARCHIVEBCDEF",
      recoveryTransaction: "x_ADOPTRECOVERYBCDEF",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-08-31T14:52:00.000Z"
    });
    assert.equal(retry.status, "conflict");
    assert.deepEqual(await inventory(scope.root), beforeRetry);
  } finally {
    await scope.cleanup();
  }
});
