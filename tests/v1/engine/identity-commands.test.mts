import { testRuntimeRoot } from "../helpers/runtime-root.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createLocalLibrary, projectCatalogArchiveSummary, rebuildCatalogCache } from "../../../src/adapters/library-data/index.mts";
import { serializeConversation } from "../../../src/core/contracts/index.mts";
import { fingerprintFile } from "../../../src/adapters/storage/stream.mts";
import { IdentityEngineCommands } from "../../../src/engine/identity-commands.mts";
import { ReaderEngineCommands } from "../../../src/engine/reader-commands.mts";
import type { EngineCommandContext } from "../../../src/engine/protocol.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const builtins = {
  user: { name: "采云用户", avatar: "Assets/Defaults/user.svg", localizedNames: { "zh-CN": "采云用户", en: "User" } },
  assistant: { name: "智能伙伴", avatar: "Assets/Defaults/assistant.svg", localizedNames: { "zh-CN": "智能伙伴", en: "AI" } },
  platforms: {
    chatgpt: { name: "ChatGPT", avatar: "Assets/Platforms/chatgpt.svg" },
    kimi: { name: "Kimi", avatar: "Assets/Platforms/kimi.svg" }
  }
} as const;

function context(): EngineCommandContext {
  return { request: "r_identity", signal: new AbortController().signal, emit: async () => undefined };
}

test("identity commands expose only fixed platform facts and commit sparse names with revision conflict protection", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-identity-engine-"));
  const root = path.join(base, "Library");
  await createLocalLibrary({
    root,
    transaction: "x_IDENTITYENGCREATE",
    timestamp: "2026-09-01T09:00:00.000Z",
    localDate: "2026-09-01",
    offset: "-07:00",
    language: "zh-CN"
  });
  const commands = new IdentityEngineCommands({ runtimeRoot: testRuntimeRoot(root),
    libraryRoot: root,
    builtins,
    clock: () => "2026-09-01T09:01:00.000Z"
  });
  try {
    const handlers = commands.handlers();
    const queried = await handlers["identity.query"]!({}, context()) as JsonObject;
    assert.equal(queried["revision"], 1);
    assert.deepEqual((queried["platforms"] as Record<string, unknown>[]).map((entry) => entry["platform"]), ["chatgpt", "kimi"]);
    const committed = await handlers["identity.commit"]!({
      expected_revision: 1,
      draft: {
        global: {
          user: { name: "晨星", avatar: { state: "clear" } },
          assistant: { name: "奥思", avatar: { state: "clear" }, apply_to_all: false }
        },
        platforms: {
          kimi: { name: "月海", avatar: { state: "clear" } }
        }
      }
    }, context()) as JsonObject;
    assert.equal(committed["status"], "updated");
    assert.equal(committed["revision"], 2);
    assert.equal(((committed["global"] as Record<string, unknown>)["user"] as Record<string, unknown>)["resolved_name"], "晨星");
    const platforms = committed["platforms"] as Record<string, unknown>[];
    assert.equal((platforms.find((entry) => entry["platform"] === "kimi")!)["resolved_name"], "月海");
    await assert.rejects(
      handlers["identity.commit"]!({
        expected_revision: 1,
        draft: {
          global: {
            user: { name: null, avatar: { state: "keep" } },
            assistant: { name: null, avatar: { state: "keep" }, apply_to_all: false }
          },
          platforms: {}
        }
      }, context()),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CLOUDIG_LIBRARY_REVISION_CONFLICT"
    );
  } finally {
    await commands.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("one identity save commits global and conversation names together, or leaves both unchanged on a stale archive", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-identity-atomic-"));
  const root = path.join(base, "Library");
  await createLocalLibrary({ root, transaction: "x_ATOMICIDENTCREATE", timestamp: "2026-09-05T08:00:00.000Z", localDate: "2026-09-05", offset: "Z", language: "zh-CN" });
  const archivePath = path.join(root, "Conversations", "sample.json");
  const conversation = JSON.parse(await readFile(new URL("../contracts/fixtures/conversation-minimal.json", import.meta.url), "utf8")) as JsonObject;
  await writeFile(archivePath, serializeConversation(conversation));
  await rebuildCatalogCache(root, { builtAt: "2026-09-05T08:00:00.000Z", adapterBundleSha256: "a".repeat(64), archiveRows: {
    "Conversations/sample.json": { ...projectCatalogArchiveSummary(conversation), sha256: (await fingerprintFile(archivePath)).sha256 }
  } });
  const reader = new ReaderEngineCommands({ runtimeRoot: testRuntimeRoot(root), libraryRoot: root, builtins, availableAssets: new Set() });
  const identity = new IdentityEngineCommands({ runtimeRoot: testRuntimeRoot(root), libraryRoot: root, builtins, resolveArchive: value => reader.identityArchiveDraft(value) });
  try {
    const listed = await reader.handlers()["reader.archives.query"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    const row = (listed["items"] as JsonObject[])[0]!;
    const before = await readFile(path.join(root, "cloudig-library.json"));
    const payload = { expected_revision: 1, draft: { global: { user: { name: "New global", avatar: { state: "keep" } }, assistant: { avatar: { state: "keep" }, apply_to_all: false } }, platforms: {} },
      conversation: { archive: row["capability"]!, expected_revision: 99, names: { user: "Only here", assistant: null } } };
    await assert.rejects(identity.handlers()["identity.commit"]!(payload, context()), /changed/iu);
    assert.deepEqual(await readFile(path.join(root, "cloudig-library.json")), before);
    payload.conversation.expected_revision = 0;
    const saved = await identity.handlers()["identity.commit"]!(payload, context()) as JsonObject;
    assert.equal(saved["revision"], 2);
    assert.equal(saved["archive_revision"], 1);
    const library = JSON.parse(await readFile(path.join(root, "cloudig-library.json"), "utf8"));
    assert.equal(library.identity.global.user.name, "New global");
    assert.equal(library.archives.a1.names.user, "Only here");
  } finally {
    await identity.close(); await reader.close(); await rm(base, { recursive: true, force: true });
  }
});

test("repeated avatar reads reuse one disposable copy and regenerate it after cache deletion", async () => {
  await mkdir("tmp", { recursive: true });
  const base = await mkdtemp(path.join(process.cwd(), "tmp", "avatar-cache-"));
  const root = path.join(base, "Library");
  await createLocalLibrary({ root, transaction: "x_AVATARCACHECREATE", timestamp: "2026-09-08T10:00:00.000Z", localDate: "2026-09-08", offset: "Z", language: "zh-CN" });
  const runtimeRoot = testRuntimeRoot(root);
  const commands = new IdentityEngineCommands({ libraryRoot: root, runtimeRoot, builtins });
  try {
    const reference = "Data/Assets/User/avatar-test.png";
    const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xQAAAAASUVORK5CYII=", "base64");
    await writeFile(path.join(root, reference), original);
    const file = path.join(root, "cloudig-library.json");
    const library = JSON.parse(await readFile(file, "utf8"));
    library.identity = { global: { user: { avatar: reference } } };
    await writeFile(file, JSON.stringify(library));
    const authorityBefore = await fingerprintFile(file);
    const handlers = commands.handlers();
    const state = await handlers["identity.query"]!({}, context()) as JsonObject;
    const avatar = (((state["global"] as JsonObject)["user"] as JsonObject)["resolved_avatar"] as JsonObject)["capability"]!;
    let first: JsonObject | undefined;
    for (let index = 0; index < 20; index++) {
      const result = await handlers["identity.avatar.resolve"]!({ avatar }, context()) as JsonObject;
      if (first) assert.deepEqual(result, first); else first = result;
    }
    assert.equal((await readdir(path.join(runtimeRoot, "Views"))).length, 1);
    await rm(runtimeRoot, { recursive: true });
    testRuntimeRoot(root);
    const restored = await handlers["identity.avatar.resolve"]!({ avatar }, context()) as JsonObject;
    assert.notDeepEqual(restored, first);
    assert.deepEqual(await readFile(path.join(root, reference)), original);
    assert.deepEqual(await fingerprintFile(file), authorityBefore);
  } finally { await commands.close(); await rm(base, { recursive: true, force: true }); }
});
