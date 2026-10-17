import { testRuntimeRoot } from "../helpers/runtime-root.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { RuntimeConversationViews } from "../../../src/adapters/runtime/index.mts";
import { base64Chunks } from "../../../src/adapters/parser/embedded-data.mts";
import { createLocalLibrary } from "../../../src/adapters/library-data/index.mts";
import { finalizeConversation, serializeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const builtins = {
  user: { name: "User", avatar: "Assets/Defaults/user.svg" },
  assistant: { name: "AI", avatar: "Assets/Defaults/assistant.svg" },
  platforms: { chatgpt: { name: "ChatGPT", avatar: "Assets/Platforms/chatgpt.svg" } }
} as const;

const page = {
  page: { offset: 0, limit: 20 },
  navigationPage: { offset: 0, limit: 20 },
  branchPage: { offset: 0, limit: 20 }
} as const;

function tokenFactory(): (prefix: "e" | "v" | "r" | "i" | "p") => string {
  let ordinal = 0;
  return (prefix) => `${prefix}_${String(++ordinal).padStart(43, "0")}`;
}

async function readVirtual(root: string, virtualPath: string): Promise<Buffer> {
  return readFile(path.join(testRuntimeRoot(root), "Views", ...virtualPath.slice(1).split("/")));
}

function conversation(bytes: Buffer): JsonObject {
  return finalizeConversation({
    schema: "cloudig/conversation/1.0.0",
    archive: "a1",
    generation: 1,
    content_sha256: "0".repeat(64),
    parser: { version: "1.0.0", adapter: { id: "runtime-fixture", version: "1.0.0" } },
    lifecycle: {
      first_parsed_at: { basis: "parser", value: "2026-08-31T20:00:00.000Z" },
      last_parsed_at: "2026-08-31T20:00:00.000Z",
      cloudig_edited_at: "2026-08-31T20:00:00.000Z"
    },
    source: { file: "fixture.html", sha256: "1".repeat(64), bytes: 10, format: "exporter-html" },
    content_time: { basis: "unavailable" },
    provider: "openai",
    platform: "chatgpt",
    title: "Runtime fixture",
    models: ["GPT-5.6-Sol"],
    messages: [
      { role: "user", content: [{ type: "markdown", text: "Question" }] },
      { role: "assistant", content: [{ type: "image", resource: "r1", alt: "Pixel" }, { type: "markdown", text: "Answer" }] }
    ],
    resources: [{
      id: "r1",
      kind: "image",
      availability: "embedded",
      name: "pixel.png",
      mime: "image/png",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data_base64: base64Chunks(bytes)
    }]
  });
}

async function fixture(): Promise<Readonly<{ root: string; file: string; bytes: Buffer }>> {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-runtime-view-"));
  const root = path.join(base, "Library");
  await createLocalLibrary({
    root,
    transaction: "x_RUNTIMEVIEWSTESTA",
    timestamp: "2026-08-31T20:00:00.000Z",
    localDate: "2026-08-31",
    offset: "-07:00",
    language: "zh-CN"
  });
  const bytes = Buffer.from("runtime-resource", "utf8");
  const file = path.join(root, "Conversations", "runtime.json");
  await writeFile(file, serializeConversation(conversation(bytes)), "utf8");
  return { root, file, bytes };
}

test("runtime view returns opaque paging and lazily materializes one exact virtual asset", async () => {
  const scope = await fixture();
  const runtime = new RuntimeConversationViews({ runtimeRoot: testRuntimeRoot(scope.root),
    libraryRoot: scope.root,
    builtins,
    availableAssets: new Set(),
    now: () => "2026-08-31T21:00:00.000Z",
    token: tokenFactory()
  });
  try {
    const opened = await runtime.open({ relativePath: "Conversations/runtime.json", expectedArchive: "a1", expectedGeneration: 1, page });
    assert.match(opened.token, /^v_[A-Za-z0-9_-]{43}$/u);
    assert.doesNotMatch(JSON.stringify(opened), /[A-Za-z]:\\|data_base64|Conversations\/runtime/u);
    assert.match(opened.page.capability, /^p_[A-Za-z0-9_-]{43}$/u);
    const initialView = JSON.parse((await readVirtual(scope.root, opened.page.virtual_path)).toString("utf8")) as JsonObject;
    const messages = initialView["messages"] as JsonObject[];
    const userAvatar = ((messages[0]!["party"] as JsonObject)["avatar"]);
    const assistantAvatar = ((messages[1]!["party"] as JsonObject)["avatar"]);
    assert.match(String(userAvatar), /^i_[A-Za-z0-9_-]{43}$/u);
    assert.match(String(assistantAvatar), /^i_[A-Za-z0-9_-]{43}$/u);
    assert.equal(runtime.identityReference(opened.token, String(userAvatar)), builtins.user.avatar);
    assert.equal(runtime.identityReference(opened.token, String(assistantAvatar)), builtins.platforms.chatgpt.avatar);

    const nextPage = await runtime.page(opened.token, { ...page, page: { offset: 1, limit: 1 } });
    const next = JSON.parse((await readVirtual(scope.root, nextPage.virtual_path)).toString("utf8")) as JsonObject;
    assert.equal((next["messages"] as JsonObject[]).length, 1);
    assert.equal((next["messages"] as JsonObject[])[0]!["source_index"], 1);
    assert.deepEqual(await runtime.page(opened.token, { ...page, page: { offset: 1, limit: 1 } }), nextPage);

    const asset = await runtime.materializeResource({ token: opened.token, resource: "r1" });
    assert.match(asset.capability, /^r_[A-Za-z0-9_-]{43}$/u);
    assert.match(asset.virtual_path, /^\/v_[A-Za-z0-9_-]{43}\/assets\/r_[A-Za-z0-9_-]{43}\.png$/u);
    assert.doesNotMatch(JSON.stringify(asset), /[A-Za-z]:\\|data_base64/u);
    assert.deepEqual(await readVirtual(scope.root, asset.virtual_path), scope.bytes);
    assert.deepEqual(await runtime.materializeResource({ token: opened.token, resource: "r1" }), asset);

    const sourceBefore = await readFile(scope.file);
    await rm(testRuntimeRoot(scope.root), { recursive: true });
    const restoredPage = await runtime.page(opened.token, page);
    assert.ok((await readVirtual(scope.root, restoredPage.virtual_path)).length > 0);
    const restoredAsset = await runtime.materializeResource({ token: opened.token, resource: "r1" });
    assert.deepEqual(await readVirtual(scope.root, restoredAsset.virtual_path), scope.bytes);
    assert.deepEqual(await readFile(scope.file), sourceBefore);

    const second = await runtime.open({ relativePath: "Conversations/runtime.json", page });
    await assert.rejects(() => runtime.page(opened.token, page), /stale or revoked/iu);
    await assert.rejects(() => stat(path.join(testRuntimeRoot(scope.root), "Views", opened.token)), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
    assert.equal(await runtime.close(second.token), "removed");
  } finally {
    await runtime.closeAll();
    await rm(path.dirname(scope.root), { recursive: true, force: true });
  }
});

test("parallel resources and pages keep every published file in the runtime manifest", async () => {
  const scope = await fixture();
  const value = conversation(scope.bytes);
  const original = (value["resources"] as JsonObject[])[0]!;
  value["resources"] = Array.from({ length: 8 }, (_, index) => ({ ...original, id: `r${index + 1}`, name: `pixel-${index + 1}.png` }));
  (value["messages"] as JsonObject[])[1]!["content"] = Array.from({ length: 8 }, (_, index) => ({ type: "image", resource: `r${index + 1}` }));
  await writeFile(scope.file, serializeConversation(finalizeConversation(value)), "utf8");
  const runtime = new RuntimeConversationViews({ runtimeRoot: testRuntimeRoot(scope.root), libraryRoot: scope.root, builtins, availableAssets: new Set(), token: tokenFactory() });
  try {
    const opened = await runtime.open({ relativePath: "Conversations/runtime.json", page });
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => runtime.materializeResource({ token: opened.token, resource: `r${index + 1}` })),
      runtime.page(opened.token, { ...page, page: { offset: 0, limit: 1 } }),
      runtime.page(opened.token, { ...page, page: { offset: 1, limit: 1 } })
    ]);
    const manifest = JSON.parse(await readFile(path.join(testRuntimeRoot(scope.root), "Views", opened.token, "manifest.json"), "utf8")) as { files: Array<{ file: string }> };
    assert.equal(manifest.files.length, 11, "initial page, two later pages and all eight resource bodies remain registered");
    assert.equal(new Set(manifest.files.map(file => file.file)).size, 11);
    for (const entry of manifest.files) assert.ok((await stat(path.join(testRuntimeRoot(scope.root), "Views", opened.token, entry.file))).isFile());
  } finally {
    await runtime.closeAll();
    await rm(path.dirname(scope.root), { recursive: true, force: true });
  }
});

test("runtime view rejects source mutation and refuses to delete a directory whose ownership manifest changed", async () => {
  const scope = await fixture();
  const runtime = new RuntimeConversationViews({ runtimeRoot: testRuntimeRoot(scope.root),
    libraryRoot: scope.root,
    builtins,
    availableAssets: new Set(),
    token: tokenFactory()
  });
  try {
    const opened = await runtime.open({ relativePath: "Conversations/runtime.json", page });
    await writeFile(scope.file, `${await readFile(scope.file, "utf8")} `, "utf8");
    await assert.rejects(() => runtime.page(opened.token, page), /changed while its view was open/iu);
    const directory = path.join(testRuntimeRoot(scope.root), "Views", opened.token);
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
    manifest["owner"] = `e_${"z".repeat(43)}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assert.equal(await runtime.close(opened.token), "ownership_lost");
    assert.equal((await stat(directory)).isDirectory(), true);
    await rm(directory, { recursive: true });
  } finally {
    await runtime.closeAll();
    await rm(path.dirname(scope.root), { recursive: true, force: true });
  }
});
