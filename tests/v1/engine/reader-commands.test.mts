import { testRuntimeRoot } from "../helpers/runtime-root.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createArchiveDirectory,
  createLocalLibrary,
  readCatalogCache,
  rebuildCatalogCache
} from "../../../src/adapters/library-data/index.mts";
import { base64Chunks } from "../../../src/adapters/parser/embedded-data.mts";
import { fingerprintFile } from "../../../src/adapters/storage/stream.mts";
import { finalizeConversation, serializeConversation, serializeLibrary } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { ReaderEngineCommands } from "../../../src/engine/index.mts";

function tokenFactory(): (prefix: "e" | "v" | "r" | "i" | "p") => string {
  let ordinal = 0;
  return (prefix) => `${prefix}_${String(++ordinal).padStart(43, "0")}`;
}

function context() {
  return { request: "q_test", signal: new AbortController().signal, emit: async () => undefined };
}

async function readVirtual(root: string, virtualPath: string): Promise<Buffer> {
  return readFile(path.join(testRuntimeRoot(root), "Views", ...virtualPath.slice(1).split("/")));
}

test("Reader Engine commands keep archive paths private across query, open, page, identity, resource and close", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-reader-engine-"));
  const root = path.join(base, "Library");
  const avatarBytes = Buffer.from("managed-avatar", "utf8");
  const resourceBytes = Buffer.from("embedded-image", "utf8");
  let commands: ReaderEngineCommands | undefined;
  try {
    await createLocalLibrary({
      root,
      transaction: "x_READERENGINEHOSTA",
      timestamp: "2026-08-31T20:00:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const avatarRelative = "Data/Assets/User/user.png";
    await writeFile(path.join(root, ...avatarRelative.split("/")), avatarBytes);
    const libraryPath = path.join(root, "cloudig-library.json");
    const library = JSON.parse(await readFile(libraryPath, "utf8")) as JsonObject;
    library["identity"] = { global: { user: { name: "晨星", avatar: avatarRelative } } };
    await writeFile(libraryPath, serializeLibrary(library), "utf8");

    const conversation = finalizeConversation({
      schema: "cloudig/conversation/1.0.0",
      archive: "a1",
      generation: 1,
      content_sha256: "0".repeat(64),
      parser: { version: "1.0.0", adapter: { id: "engine-fixture", version: "1.0.0" } },
      lifecycle: {
        first_parsed_at: { basis: "parser", value: "2026-08-31T20:00:00.000Z" },
        last_parsed_at: "2026-08-31T20:00:00.000Z",
        cloudig_edited_at: "2026-08-31T20:00:00.000Z"
      },
      source: { file: "fixture.html", sha256: "1".repeat(64), bytes: 10, format: "exporter-html" },
      content_time: { basis: "message_start", range: { start: { kind: "calendar", era: "AD", year: 2026, month: 8, day: 31 } } },
      provider: "openai",
      platform: "chatgpt",
      title: "Reader command fixture",
      models: ["GPT-5.6-Sol"],
      messages: [
        { role: "user", content: [{ type: "markdown", text: "Question" }] },
        { role: "assistant", content: [{ type: "image", resource: "r1", alt: "Image" }, { type: "markdown", text: "Answer" }] }
      ],
      resources: [{
        id: "r1",
        kind: "image",
        availability: "embedded",
        name: "image.png",
        mime: "image/png",
        bytes: resourceBytes.byteLength,
        sha256: createHash("sha256").update(resourceBytes).digest("hex"),
        data_base64: base64Chunks(resourceBytes)
      }]
    });
    const relative = "Conversations/Research/External/reader-command.json";
    const conversationPath = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(conversationPath), { recursive: true });
    await writeFile(conversationPath, serializeConversation(conversation), "utf8");
    const fingerprint = await fingerprintFile(conversationPath);
    const catalog = await rebuildCatalogCache(root, {
      builtAt: "2026-08-31T21:00:00.000Z",
      adapterBundleSha256: "2".repeat(64),
      archiveRows: {
        [relative]: {
          sha256: fingerprint.sha256,
          conversation_schema: "cloudig/conversation/1.0.0",
          archive: "a1",
          generation: 1,
          source_file: "fixture.html",
          source_title: "Reader command fixture",
          platform: "chatgpt",
          models: ["GPT-5.6-Sol"],
          message_count: 2,
          resource_count: 1,
          times: {
            json_edited_at: "2026-08-31T20:00:00.000Z",
            json_created_at: "2026-08-31T20:00:00.000Z",
            content: { start: { kind: "calendar", era: "AD", year: 2026, month: 8, day: 31 } }
          }
        }
      }
    });
    assert.equal(catalog.status, "written");

    let archiveOrdinal = 0;
    commands = new ReaderEngineCommands({ runtimeRoot: testRuntimeRoot(root),
      libraryRoot: root,
      builtins: {
        user: { name: "User", avatar: "Assets/Defaults/user.svg" },
        assistant: { name: "AI", avatar: "Assets/Defaults/assistant.svg" },
        platforms: { chatgpt: { name: "ChatGPT", avatar: "Assets/Platforms/chatgpt.svg" } }
      },
      availableAssets: new Set([avatarRelative]),
      token: tokenFactory(),
      archiveToken: () => `a_${String(++archiveOrdinal).padStart(43, "0")}`
    });
    const handlers = commands.handlers();
    for (const archive of ["C:\\Users\\someone\\archive.json", "\\\\server\\share\\a.json", "file:///a.json"]) {
      await assert.rejects(handlers["reader.view.open"]!({ archive, request: {} }, context()), /capability|token|archive/iu);
    }
    const listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    const item = (listed["items"] as JsonObject[])[0]!;
    const directory = (listed["directories"] as JsonObject[])[0]!;
    assert.equal(item["title"], "Reader command fixture");
    assert.equal(directory["name"], "Research");
    assert.deepEqual(listed["stats"], { bytes: item["bytes"], files: 1, directories: 1, archived_bytes: 0, archived_files: 0 });
    assert.doesNotMatch(JSON.stringify(listed), /Conversations\/|[A-Za-z]:\\/u);
    const filtered = await handlers["reader.archives.query"]!({ offset: 0, limit: 20, directory: directory["capability"]! }, context()) as JsonObject;
    assert.equal((filtered["items"] as JsonObject[]).length, 1);
    assert.equal(((filtered["items"] as JsonObject[])[0] as JsonObject)["capability"], item["capability"]);
    const multiFiltered = await handlers["reader.archives.query"]!({ offset: 0, limit: 20, directories: [directory["capability"]!] }, context()) as JsonObject;
    assert.equal((multiFiltered["items"] as JsonObject[]).length, 1);
    assert.equal(((multiFiltered["items"] as JsonObject[])[0] as JsonObject)["capability"], item["capability"]);
    await assert.rejects(
      handlers["reader.archives.query"]!({ offset: 0, limit: 20, directory: directory["capability"]!, directories: [directory["capability"]!] }, context()),
      /mutually exclusive/iu
    );

    const libraryBeforeExport = await readFile(libraryPath);
    const firstExport = await handlers["reader.archive.exportMarkdown"]!({ archive: item["capability"]! }, context()) as JsonObject;
    assert.deepEqual(
      { status: firstExport["status"], filename: firstExport["filename"], messages: firstExport["messages"] },
      { status: "exported", filename: "reader-command.md", messages: 2 }
    );
    const markdown = await readFile(path.join(root, "Exports", "reader-command.md"), "utf8");
    assert.match(markdown, /^# Reader command fixture$/mu);
    assert.match(markdown, /^## 晨星$/mu);
    assert.match(markdown, /^## ChatGPT$/mu);
    assert.match(markdown, new RegExp(`data:image/png;base64,${resourceBytes.toString("base64")}`, "u"));
    assert.doesNotMatch(markdown, /data_base64|[A-Za-z]:\\/u);
    assert.deepEqual(await readFile(libraryPath), libraryBeforeExport);
    const secondExport = await handlers["reader.archive.exportMarkdown"]!({ archive: item["capability"]! }, context()) as JsonObject;
    assert.equal(secondExport["filename"], "reader-command (2).md");
    assert.equal(await readFile(path.join(root, "Exports", "reader-command (2).md"), "utf8"), markdown);

    const request = {
      messages: { offset: 0, limit: 20 },
      navigation: { offset: 0, limit: 20 },
      branches: { offset: 0, limit: 20 }
    };
    const opened = await handlers["reader.view.open"]!({ archive: item["capability"]!, request }, context()) as JsonObject;
    assert.doesNotMatch(JSON.stringify(opened), /Conversations\/|data_base64|[A-Za-z]:\\/u);
    const view = JSON.parse((await readVirtual(root, (opened["page"] as JsonObject)["virtual_path"] as string)).toString("utf8")) as JsonObject;
    const messages = view["messages"] as JsonObject[];
    const userIdentity = ((messages[0]!["party"] as JsonObject)["avatar"] as string);
    const [resolvedIdentity, duplicateIdentity] = await Promise.all([
      handlers["reader.identity.resolve"]!({ view: opened["token"]!, identity: userIdentity }, context()),
      handlers["reader.identity.resolve"]!({ view: opened["token"]!, identity: userIdentity }, context())
    ]) as JsonObject[];
    assert.ok(resolvedIdentity && duplicateIdentity);
    assert.deepEqual(duplicateIdentity, resolvedIdentity);
    assert.equal(resolvedIdentity["kind"], "runtime");
    assert.deepEqual(await readVirtual(root, ((resolvedIdentity["asset"] as JsonObject)["virtual_path"] as string)), avatarBytes);

    const resource = await handlers["reader.resource.materialize"]!({ view: opened["token"]!, resource: "r1" }, context()) as JsonObject;
    assert.deepEqual(await readVirtual(root, resource["virtual_path"] as string), resourceBytes);
    const closed = await handlers["reader.view.close"]!({ view: opened["token"]! }, context()) as JsonObject;
    assert.equal(closed["status"], "removed");
    await assert.rejects(() => handlers["reader.view.page"]!({ view: opened["token"]!, request }, context()), /stale/iu);
  } finally {
    await commands?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("Reader archive commands move, archive and complete a WPF-mediated recycle without exposing managed paths to page commands", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-reader-actions-"));
  const root = path.join(base, "Library");
  let commands: ReaderEngineCommands | undefined;
  try {
    await createLocalLibrary({
      root,
      transaction: "x_READERACTIONHOSTA",
      timestamp: "2026-08-31T22:00:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    await createArchiveDirectory(root, "Folder");
    await createArchiveDirectory(root, "Target");

    const makeConversation = (archive: string, title: string): JsonObject => finalizeConversation({
      schema: "cloudig/conversation/1.0.0",
      archive,
      generation: 1,
      content_sha256: "0".repeat(64),
      parser: { version: "1.0.0", adapter: { id: "engine-action-fixture", version: "1.0.0" } },
      lifecycle: {
        first_parsed_at: { basis: "parser", value: "2026-08-31T22:00:00.000Z" },
        last_parsed_at: "2026-08-31T22:00:00.000Z",
        cloudig_edited_at: "2026-08-31T22:00:00.000Z"
      },
      source: { file: `${archive}.html`, sha256: archive === "a1" ? "1".repeat(64) : "2".repeat(64), bytes: 10, format: "exporter-html" },
      content_time: { basis: "message_start", range: { start: { kind: "calendar", era: "AD", year: 2026, month: 8, day: 31 } } },
      provider: "openai",
      platform: "chatgpt",
      title,
      messages: [{ role: "user", content: [{ type: "markdown", text: title }] }]
    });
    const moveRelative = "Conversations/Folder/move.json";
    const deleteRelative = "Conversations/delete.json";
    const movePath = path.join(root, ...moveRelative.split("/"));
    const deletePath = path.join(root, ...deleteRelative.split("/"));
    const moveBytes = serializeConversation(makeConversation("a1", "Move me"));
    const deleteBytes = serializeConversation(makeConversation("a2", "Recycle me"));
    await writeFile(movePath, moveBytes, "utf8");
    await writeFile(deletePath, deleteBytes, "utf8");
    const moveFingerprint = await fingerprintFile(movePath);
    const deleteFingerprint = await fingerprintFile(deletePath);
    const catalog = await rebuildCatalogCache(root, {
      builtAt: "2026-08-31T22:01:00.000Z",
      adapterBundleSha256: "3".repeat(64),
      archiveRows: {
        [moveRelative]: {
          sha256: moveFingerprint.sha256,
          conversation_schema: "cloudig/conversation/1.0.0",
          archive: "a1",
          generation: 1,
          source_file: "a1.html",
          source_title: "Move me",
          platform: "chatgpt",
          message_count: 1,
          resource_count: 0
        },
        [deleteRelative]: {
          sha256: deleteFingerprint.sha256,
          conversation_schema: "cloudig/conversation/1.0.0",
          archive: "a2",
          generation: 1,
          source_file: "a2.html",
          source_title: "Recycle me",
          platform: "chatgpt",
          message_count: 1,
          resource_count: 0
        }
      }
    });
    assert.equal(catalog.status, "written");

    let archiveOrdinal = 0;
    let directoryOrdinal = 0;
    let recycleOrdinal = 0;
    commands = new ReaderEngineCommands({ runtimeRoot: testRuntimeRoot(root),
      libraryRoot: root,
      builtins: {
        user: { name: "User", avatar: "Assets/Defaults/user.svg" },
        assistant: { name: "AI", avatar: "Assets/Defaults/assistant.svg" },
        platforms: { chatgpt: { name: "ChatGPT", avatar: "Assets/Platforms/chatgpt.svg" } }
      },
      availableAssets: new Set(),
      token: tokenFactory(),
      archiveToken: () => `a_${String(++archiveOrdinal).padStart(43, "0")}`,
      directoryToken: () => `d_${String(++directoryOrdinal).padStart(43, "0")}`,
      recycleToken: () => `z_${String(++recycleOrdinal).padStart(43, "0")}`,
      clock: () => "2026-08-31T22:02:00.000Z"
    });
    const handlers = commands.handlers();
    let listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    const directories = listed["directories"] as JsonObject[];
    assert.deepEqual(directories.map((entry) => [entry["name"], entry["count"]]), [["Folder", 1], ["Target", 0]]);
    const moveItem = (listed["items"] as JsonObject[]).find((entry) => entry["title"] === "Move me")!;
    const targetDirectory = directories.find((entry) => entry["name"] === "Target")!;
    const moved = await handlers["reader.archive.move"]!({ archive: moveItem["capability"]!, directory: targetDirectory["capability"]! }, context()) as JsonObject;
    assert.deepEqual(moved, { status: "moved", catalog: "written" });
    await assert.rejects(
      () => handlers["reader.archive.archive"]!({ archive: moveItem["capability"]! }, context()),
      /stale/iu
    );
    assert.equal(await readFile(path.join(root, "Conversations", "Target", "move.json"), "utf8"), moveBytes);

    listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    let updatedDirectories = listed["directories"] as JsonObject[];
    const targetAfterMove = updatedDirectories.find((entry) => entry["name"] === "Target")!;
    assert.deepEqual(await handlers["reader.directory.rename"]!({ directory: targetAfterMove["capability"]!, name: "Renamed" }, context()), { status: "renamed", catalog: "written" });
    assert.equal(await readFile(path.join(root, "Conversations", "Renamed", "move.json"), "utf8"), moveBytes);

    listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    updatedDirectories = listed["directories"] as JsonObject[];
    const emptyFolder = updatedDirectories.find((entry) => entry["name"] === "Folder")!;
    assert.deepEqual(await handlers["reader.directory.delete"]!({ directory: emptyFolder["capability"]! }, context()), { status: "deleted" });
    assert.deepEqual(await handlers["reader.directory.create"]!({ name: "Fresh" }, context()), { status: "created" });

    listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    assert.ok((listed["directories"] as JsonObject[]).some((entry) => entry["name"] === "Fresh" && entry["count"] === 0));
    let movedItem = (listed["items"] as JsonObject[]).find((entry) => entry["title"] === "Move me")!;
    assert.deepEqual(await handlers["reader.archive.archive"]!({ archive: movedItem["capability"]! }, context()), { status: "moved", catalog: "written" });

    let archived = await handlers["reader.archives.query"]!({ offset: 0, limit: 20, archived: true }, context()) as JsonObject;
    assert.equal(archived["total"], 1);
    const archivedItem = (archived["items"] as JsonObject[])[0]!;
    assert.equal(archivedItem["archived"], true);
    assert.deepEqual(await handlers["reader.archive.restore"]!({ archive: archivedItem["capability"]! }, context()), { status: "moved", catalog: "written" });

    listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    movedItem = (listed["items"] as JsonObject[]).find((entry) => entry["title"] === "Move me")!;
    assert.deepEqual(await handlers["reader.archive.archive"]!({ archive: movedItem["capability"]! }, context()), { status: "moved", catalog: "written" });

    listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    assert.equal(listed["total"], 1);
    const recycleItem = (listed["items"] as JsonObject[])[0]!;
    const plan = await handlers["reader.archive.recycle.plan"]!({ archive: recycleItem["capability"]! }, context()) as JsonObject;
    assert.equal(plan["path"], deleteRelative);
    assert.doesNotMatch(JSON.stringify(plan), /[A-Za-z]:\\/u);
    await rm(deletePath);
    assert.deepEqual(await handlers["reader.archive.recycle.complete"]!({ plan: plan["plan"]! }, context()), { status: "recycled", catalog: "written" });
    const finalCatalog = (await readCatalogCache(root))!;
    assert.deepEqual((finalCatalog["archives"] as JsonObject[]).map((entry) => [entry["archive"], entry["archived"]]), [["a1", true]]);

    // One confirmed multi-selection is consumed without refreshing between rows.
    // Creating its destination must not invalidate that selection either.
    for (const archive of ["a3", "a4", "a5"]) {
      await writeFile(path.join(root, "Conversations", `${archive}.json`), serializeConversation(makeConversation(archive, `Bulk ${archive}`)), "utf8");
    }
    const bulkQuery = async (archived = false) => {
      const result = await handlers["reader.archives.query"]!({ offset: 0, limit: 20, search: "Bulk", archived }, context()) as JsonObject;
      return result["items"] as JsonObject[];
    };
    let bulk = await bulkQuery();
    assert.equal(bulk.length, 3);
    await handlers["reader.directory.create"]!({ name: "Batch" }, context());
    const withDestination = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    const destination = (withDestination["directories"] as JsonObject[]).find(row => row["name"] === "Batch")!["capability"]!;
    for (const row of bulk) assert.equal((await handlers["reader.archive.move"]!({ archive: row["capability"]!, directory: destination }, context()) as JsonObject)["status"], "moved");
    bulk = await bulkQuery();
    for (const row of bulk) assert.equal((await handlers["reader.archive.archive"]!({ archive: row["capability"]! }, context()) as JsonObject)["status"], "moved");
    bulk = await bulkQuery(true);
    assert.equal(bulk.length, 3);
    for (const row of bulk) assert.equal((await handlers["reader.archive.restore"]!({ archive: row["capability"]! }, context()) as JsonObject)["status"], "moved");
    bulk = await bulkQuery();
    for (const row of bulk) {
      const recycle = await handlers["reader.archive.recycle.plan"]!({ archive: row["capability"]! }, context()) as JsonObject;
      await rm(path.join(root, ...String(recycle["path"]).split("/")));
      assert.equal((await handlers["reader.archive.recycle.complete"]!({ plan: recycle["plan"]! }, context()) as JsonObject)["status"], "recycled");
    }
    assert.equal((await bulkQuery()).length, 0);
    const changedPath = path.join(root, "Conversations", "a6.json");
    const unchanged = serializeConversation(makeConversation("a6", "Bulk externally changed"));
    await writeFile(changedPath, unchanged, "utf8");
    const [changed] = await bulkQuery();
    await writeFile(changedPath, `${unchanged}\n `, "utf8");
    await assert.rejects(() => handlers["reader.archive.recycle.plan"]!({ archive: changed!["capability"]! }, context()), /changed/iu);
    assert.equal(await readFile(changedPath, "utf8"), `${unchanged}\n `);
  } finally {
    await commands?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("Conversation Info edits only the current aN Library layer with CAS, sparse tombstones and anchored no-op semantics", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-conversation-info-"));
  const root = path.join(base, "Library");
  let commands: ReaderEngineCommands | undefined;
  try {
    await createLocalLibrary({
      root,
      transaction: "x_CONVERSATIONINFOA",
      timestamp: "2026-08-31T23:00:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const conversation = finalizeConversation({
      schema: "cloudig/conversation/1.0.0",
      archive: "a1",
      generation: 1,
      content_sha256: "0".repeat(64),
      parser: { version: "1.0.0", adapter: { id: "conversation-info-fixture", version: "1.2.3" } },
      lifecycle: {
        first_parsed_at: { basis: "parser", value: "2026-08-31T23:00:00.000Z" },
        last_parsed_at: "2026-08-31T23:00:00.000Z",
        cloudig_edited_at: "2026-08-31T23:00:00.000Z"
      },
      source: {
        file: "source.html",
        sha256: "3".repeat(64),
        bytes: 20,
        format: "exporter-html",
        captured_at: { basis: "manifest", field: "captured_at", value: "2026-08-31T22:00:00.000Z" }
      },
      content_time: { basis: "message_start", range: { start: { kind: "calendar", era: "AD", year: 2026, month: 8, day: 31 } } },
      provider: "openai",
      platform: "chatgpt",
      title: "Source title",
      models: ["GPT-5.6-Sol"],
      message_time: { start: "2026-08-31T20:00:00.000Z", end: "2026-08-31T20:05:00.000Z" },
      messages: [
        { role: "user", timestamp: "2026-08-31T20:00:00.000Z", content: [{ type: "markdown", text: "Question" }] },
        { role: "assistant", timestamp: "2026-08-31T20:05:00.000Z", content: [{ type: "markdown", text: "Answer" }] }
      ],
      user: {
        revision: 4,
        edited_at: "2026-08-31T23:10:00.000Z",
        conversation_name: "Portable name",
        models: ["Portable model"],
        names: { user: "晨星", assistant: "奥思" }
      }
    });
    const relative = "Conversations/conversation-info.json";
    const absolute = path.join(root, ...relative.split("/"));
    const originalBytes = serializeConversation(conversation);
    await writeFile(absolute, originalBytes, "utf8");
    const fingerprint = await fingerprintFile(absolute);
    assert.equal((await rebuildCatalogCache(root, {
      builtAt: "2026-08-31T23:01:00.000Z",
      adapterBundleSha256: "4".repeat(64),
      archiveRows: {
        [relative]: {
          sha256: fingerprint.sha256,
          conversation_schema: "cloudig/conversation/1.0.0",
          archive: "a1",
          generation: 1,
          source_file: "source.html",
          source_title: "Source title",
          platform: "chatgpt",
          models: ["GPT-5.6-Sol"],
          message_count: 1,
          resource_count: 0
        }
      }
    })).status, "written");

    let archiveOrdinal = 0;
    let transactionOrdinal = 0;
    commands = new ReaderEngineCommands({ runtimeRoot: testRuntimeRoot(root),
      libraryRoot: root,
      builtins: {
        user: { name: "User", avatar: "Assets/Defaults/user.svg" },
        assistant: { name: "AI", avatar: "Assets/Defaults/assistant.svg" },
        platforms: { chatgpt: { name: "ChatGPT", avatar: "Assets/Platforms/chatgpt.svg" } }
      },
      availableAssets: new Set(),
      token: tokenFactory(),
      archiveToken: () => `a_${String(++archiveOrdinal).padStart(43, "0")}`,
      transaction: () => `x_${String.fromCharCode(65 + (++transactionOrdinal % 20)).repeat(16)}`,
      clock: () => "2026-09-01T12:34:56.000Z",
      anchor: () => ({ date: "2026-09-01", offset: "-07:00" })
    });
    const handlers = commands.handlers();
    let listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    let item = (listed["items"] as JsonObject[])[0]!;
    const queried = await handlers["reader.archive.info.query"]!({ archive: item["capability"]! }, context()) as JsonObject;
    assert.deepEqual(queried["revision"], { library: 1, archive: 0 });
    assert.equal(((queried["effective"] as JsonObject)["conversation_name"]), "Portable name");
    assert.equal(((queried["file"] as JsonObject)["filename"]), "conversation-info.json");
    assert.doesNotMatch(JSON.stringify(queried), /Conversations\/|[A-Za-z]:\\/u);

    const draft = {
      conversation_name: { state: "set", value: "Edited conversation" },
      models: { state: "set", values: [] },
      content_time: {
        state: "set",
        range: { start: { kind: "relative", direction: "before", unit: "wan", value: "2.0", anchor: { date: "2020-01-01", offset: "Z" } } }
      }
    };
    const invalidDraft = { ...draft, content_time: { state: "set", range: { start: { kind: "calendar", era: "AD", year: 2026, month: 2, day: 30 } } } };
    const beforeInvalidTime = await readFile(path.join(root, "cloudig-library.json"));
    await assert.rejects(() => handlers["reader.archive.info.preview"]!({ archive: item["capability"]!, draft: invalidDraft, language: "zh-CN" }, context()), error => (error as { code?: string }).code === "CLOUDIG_TIME_RANGE_INVALID" && String(error).includes("CLOUDIG_TIME_INVALID_CALENDAR_DATE"));
    assert.deepEqual(await readFile(path.join(root, "cloudig-library.json")), beforeInvalidTime);
    assert.equal(await readFile(absolute, "utf8"), originalBytes);
    const preview = await handlers["reader.archive.info.preview"]!({ archive: item["capability"]!, draft, language: "en" }, context()) as JsonObject;
    assert.equal(preview["changed"], true);
    assert.equal(preview["anchor_sensitive"], true);
    assert.equal((preview["content_time"] as JsonObject)["state"], "set");

    const committed = await handlers["reader.archive.info.commit"]!({
      archive: item["capability"]!,
      expected_library_revision: 1,
      expected_archive_revision: 0,
      draft,
      touch_on_noop: false
    }, context()) as JsonObject;
    assert.equal(committed["status"], "updated");
    assert.deepEqual(committed["revision"], { library: 2, archive: 1 });
    assert.equal(await readFile(absolute, "utf8"), originalBytes);
    const library = JSON.parse(await readFile(path.join(root, "cloudig-library.json"), "utf8")) as JsonObject;
    const saved = ((library["archives"] as JsonObject)["a1"] as JsonObject);
    assert.deepEqual(saved["names"], { user: "晨星", assistant: "奥思" });
    assert.equal(saved["conversation_name"], "Edited conversation");
    assert.deepEqual(saved["models"], []);
    assert.deepEqual((((saved["content_time"] as JsonObject)["range"] as JsonObject)["start"] as JsonObject)["anchor"], { date: "2026-09-01", offset: "-07:00" });
    await assert.rejects(() => handlers["reader.archive.info.query"]!({ archive: item["capability"]! }, context()), /stale/iu);

    listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    item = (listed["items"] as JsonObject[])[0]!;
    const refreshed = await handlers["reader.archive.info.query"]!({ archive: item["capability"]! }, context()) as JsonObject;
    assert.equal((refreshed["facts"] as JsonObject)["cloudig_edited_at"], "2026-09-01T12:34:56.000Z");
    const beforeNoop = await readFile(path.join(root, "cloudig-library.json"));
    const unchanged = await handlers["reader.archive.info.commit"]!({
      archive: item["capability"]!,
      expected_library_revision: 2,
      expected_archive_revision: 1,
      draft: refreshed["draft"]!,
      touch_on_noop: false
    }, context()) as JsonObject;
    assert.equal(unchanged["status"], "unchanged");
    assert.deepEqual(await readFile(path.join(root, "cloudig-library.json")), beforeNoop);
    const identity = await handlers["reader.archive.identity.query"]!({ archive: item["capability"]! }, context()) as JsonObject;
    assert.deepEqual(identity["names"], { user: "晨星", assistant: "奥思" });
    assert.deepEqual(identity["resolved"], { user: "晨星", assistant: "奥思" });
    const identityCommitted = await handlers["reader.archive.identity.commit"]!({
      archive: item["capability"]!,
      expected_library_revision: 2,
      expected_archive_revision: 1,
      names: { user: "老婆", assistant: "万卷同辉" }
    }, context()) as JsonObject;
    assert.equal(identityCommitted["status"], "updated");
    assert.deepEqual(identityCommitted["revision"], { library: 3, archive: 2 });
    const identityLibrary = JSON.parse(await readFile(path.join(root, "cloudig-library.json"), "utf8")) as JsonObject;
    assert.deepEqual((((identityLibrary["archives"] as JsonObject)["a1"] as JsonObject)["names"]), { user: "老婆", assistant: "万卷同辉" });
    assert.equal(await readFile(absolute, "utf8"), originalBytes);
    listed = await handlers["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    item = (listed["items"] as JsonObject[])[0]!;
    const touched = await handlers["reader.archive.info.commit"]!({
      archive: item["capability"]!,
      expected_library_revision: 3,
      expected_archive_revision: 2,
      draft: refreshed["draft"]!,
      touch_on_noop: true
    }, context()) as JsonObject;
    assert.equal(touched["status"], "updated");
    assert.deepEqual(touched["revision"], { library: 4, archive: 3 });
  } finally {
    await commands?.close();
    await rm(base, { recursive: true, force: true });
  }
});
