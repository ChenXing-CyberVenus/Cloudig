import { testRuntimeRoot } from "../helpers/runtime-root.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createLocalLibrary, listSourceQueueFacts, readCatalogCache, readCurrentListingSnapshot, rebuildCatalogFromAuthority } from "../../../src/adapters/library-data/index.mts";
import { finalizeConversation, serializeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { ReaderEngineCommands } from "../../../src/engine/index.mts";

test("live archive queries reconcile external deletion, moves and edits without reparsing Inbox or touching authority", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "catalog-refresh-"));
  const root = path.join(base, "Library");
  let commands: ReaderEngineCommands | undefined;
  try {
    await createLocalLibrary({ root, transaction: "x_REFRESHARCHIVECREATE", timestamp: "2026-09-07T07:00:00.000Z", localDate: "2026-09-07", offset: "Z", language: "zh-CN" });
    const fixture = JSON.parse(await readFile(new URL("../contracts/fixtures/conversation-minimal.json", import.meta.url), "utf8")) as JsonObject;
    const writeConversation = async (relative: string, archive: string, title: string) => {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      const conversation = finalizeConversation({ ...structuredClone(fixture), archive, title });
      await writeFile(absolute, serializeConversation(conversation), "utf8");
    };
    await writeFile(path.join(root, "Inbox/sample.html"), "original source remains", "utf8");
    await writeConversation("Conversations/Selected/first.json", "a1", "First");
    await writeConversation("Conversations/second.json", "a2", "Second");
    assert.equal((await rebuildCatalogFromAuthority({ libraryRoot: root, builtAt: "2026-09-07T07:01:00.000Z", adapterBundleSha256: "a".repeat(64) })).status, "written");
    const authorities = ["cloudig-library.json", "Data/State/content-time.json", "Inbox/sample.html"];
    const before = await Promise.all(authorities.map(relative => readFile(path.join(root, relative))));
    let ordinal = 0;
    commands = new ReaderEngineCommands({ runtimeRoot: testRuntimeRoot(root), libraryRoot: root,
      builtins: { user: { name: "User", avatar: "user.svg" }, assistant: { name: "AI", avatar: "ai.svg" }, platforms: {} },
      availableAssets: new Set(), token: prefix => `${prefix}_${String(++ordinal).padStart(43, "0")}`,
      archiveToken: () => `a_${String(++ordinal).padStart(43, "0")}`
    });
    const handlers = commands.handlers();
    const context = { request: "q_refresh", signal: new AbortController().signal, emit: async () => undefined };
    const query = async (extra: JsonObject = {}) => await handlers["reader.archives.query"]!({ offset: 0, limit: 200, ...extra }, context) as JsonObject;
    const initial = await query();
    assert.equal(initial["total"], 2);
    const selected = (initial["directories"] as JsonObject[]).find(row => row["name"] === "Selected")!;
    const deletedCapability = (initial["items"] as JsonObject[]).find(row => row["title"] === "First")!["capability"]!;
    assert.equal((await query({ directory: selected["capability"]! }))["total"], 1);

    const catalogPath = path.join(root, "Data/Indexes/Catalog/snapshot.json");
    const warm = { bytes: await readFile(catalogPath), mtime: (await stat(catalogPath, { bigint: true })).mtimeNs };
    await Promise.all([query(), listSourceQueueFacts(root)]);
    assert.deepEqual(await readFile(catalogPath), warm.bytes);
    assert.equal((await stat(catalogPath, { bigint: true })).mtimeNs, warm.mtime, "an unchanged refresh must not rewrite the cache");

    // Move the selected directory out while the same Engine instance remains alive.
    await rename(path.join(root, "Conversations/Selected"), path.join(base, "removed-selected"));
    const afterDelete = await query({ directories: [selected["capability"]!] });
    assert.equal(afterDelete["total"], 1);
    assert.equal(afterDelete["catalog_total"], 1);
    assert.equal((afterDelete["stats"] as JsonObject)["files"], 1);
    assert.deepEqual(afterDelete["directories"], []);
    await assert.rejects(handlers["reader.archive.exportMarkdown"]!({ archive: deletedCapability }, context), { code: "CLOUDIG_ARCHIVE_CAPABILITY_STALE" });

    // A byte-identical external rename keeps its existing source/output binding.
    await rename(path.join(root, "Conversations/second.json"), path.join(root, "Conversations/renamed.json"));
    assert.equal((await query())["total"], 1);
    const movedSource = (await readCatalogCache(root))!["sources"] as JsonObject[];
    assert.equal((movedSource[0]!["outputs"] as JsonObject[])[0]!["path"], "Conversations/renamed.json");
    await writeConversation("Conversations/renamed.json", "a2", "Externally edited title");
    const edited = await query();
    assert.equal((edited["items"] as JsonObject[])[0]!["title"], "Externally edited title");
    await writeConversation("Conversations/new.json", "a3", "New external archive");
    assert.equal((await query())["total"], 2);

    await rm(path.join(root, "Conversations/renamed.json"));
    await rm(path.join(root, "Conversations/new.json"));
    const [empty, sources] = await Promise.all([query(), listSourceQueueFacts(root)]);
    assert.equal(empty["total"], 0);
    assert.equal(empty["catalog_total"], 0);
    assert.deepEqual(empty["stats"], { bytes: 0, files: 0, directories: 0, archived_bytes: 0, archived_files: 0 });
    assert.equal(sources.rows[0]!.catalog!["status"], "pending");
    assert.equal(sources.rows[0]!.catalog!["outputs"], undefined);
    assert.deepEqual(await readdir(path.join(root, "Conversations")), [], "refresh must never regenerate deleted archives from Inbox");
    assert.deepEqual(await Promise.all(authorities.map(relative => readFile(path.join(root, relative)))), before);

    // Changes to source files must retain the prior observation for stale-parse detection.
    await writeFile(path.join(root, "Inbox/sample.html"), "source changed after parsing", "utf8");
    assert.equal((await listSourceQueueFacts(root)).rows[0]!.changed, true);
    await rm(catalogPath);
    assert.equal((await readCurrentListingSnapshot(root)).catalog, undefined);
    assert.equal((await query())["degraded"], true);
  } finally {
    await commands?.close();
    await rm(base, { recursive: true, force: true });
  }
});
