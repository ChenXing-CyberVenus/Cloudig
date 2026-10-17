import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { openCanonicalConversationFile } from "../../../src/adapters/reader/index.mts";
import { base64Chunks } from "../../../src/adapters/parser/embedded-data.mts";
import { fingerprintFile, RESOURCE_BASE64_DECODED_CHUNK_BYTES } from "../../../src/adapters/storage/stream.mts";
import { buildConversationPage } from "../../../src/app/reader/index.mts";
import { finalizeConversation, serializeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import type { ResolvedArchiveView } from "../../../src/core/library/overlay.mts";

function sourceConversation(bytes: Buffer): JsonObject {
  return finalizeConversation({
    schema: "cloudig/conversation/1.0.0",
    archive: "a1",
    generation: 1,
    content_sha256: "0".repeat(64),
    parser: { version: "1.0.0", adapter: { id: "reader-fixture", version: "1.0.0" } },
    lifecycle: {
      first_parsed_at: { basis: "parser", value: "2026-08-31T20:00:00.000Z" },
      last_parsed_at: "2026-08-31T20:00:00.000Z",
      cloudig_edited_at: "2026-08-31T20:00:00.000Z"
    },
    source: { file: "fixture.html", sha256: "1".repeat(64), bytes: 10, format: "exporter-html" },
    content_time: { basis: "unavailable" },
    provider: "fixture",
    platform: "chatgpt",
    title: "Streaming fixture",
    messages: [{ role: "user", content: [{ type: "attachment", resource: "r1", text: "Exact bytes" }] }],
    resources: [{
      id: "r1",
      kind: "file",
      availability: "embedded",
      name: "fixture.bin",
      mime: "application/octet-stream",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data_base64: base64Chunks(bytes)
    }]
  });
}

const resolved: ResolvedArchiveView = {
  archive: "a1",
  platform: "chatgpt",
  archiveLayer: "none",
  conversationName: "Streaming fixture",
  models: [],
  userName: "User",
  assistantName: "AI",
  userAvatar: "Assets/user.svg",
  assistantAvatar: "Assets/assistant.svg",
  contentTime: { state: "unavailable" }
};

async function scope(): Promise<{ root: string; file: string }> {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "cloudig-reader-file-"));
  return { root, file: path.join(root, "conversation.json") };
}

function pageInput(
  conversation: JsonObject,
  resourceBodies: NonNullable<Parameters<typeof buildConversationPage>[0]["resourceBodies"]>
): Parameters<typeof buildConversationPage>[0] {
  return {
    conversation,
    resourceBodies,
    resolved,
    page: { offset: 0, limit: 20 },
    navigationPage: { offset: 0, limit: 20 },
    branchPage: { offset: 0, limit: 20 }
  };
}

test("canonical Conversation scanning omits Base64 from memory and lazily restores exact resource bytes", async () => {
  const testScope = await scope();
  const bytes = Buffer.alloc(RESOURCE_BASE64_DECODED_CHUNK_BYTES + 17, 0x5a);
  let opened;
  try {
    await writeFile(testScope.file, serializeConversation(sourceConversation(bytes)), "utf8");
    opened = await openCanonicalConversationFile({ filePath: testScope.file });
    assert.deepEqual(opened.index.fingerprint, await fingerprintFile(testScope.file));
    const resource = (opened.index.conversation["resources"] as JsonObject[])[0]!;
    assert.equal(resource["data_base64"], undefined);
    const body = opened.index.resourceBodies.get("r1")!;
    assert.equal(body.bytes, bytes.byteLength);
    assert.equal(body.chunks.length, 2);
    assert.equal(body.sha256, createHash("sha256").update(bytes).digest("hex"));
    const view = buildConversationPage(pageInput(opened.index.conversation, opened.index.resourceBodies));
    const viewResource = (((view["messages"] as JsonObject[])[0]!["blocks"] as JsonObject[])[0]!["resources"] as JsonObject[])[0]!;
    assert.equal(viewResource["id"], "r1");
    assert.equal(viewResource["data_base64"], undefined);

    const target = path.join(testScope.root, "resource.bin");
    let finalProgress = 0;
    const materialized = await opened.materializeResource({
      resource: "r1",
      stagingPath: target,
      onProgress: (completed) => { finalProgress = completed; }
    });
    assert.deepEqual(materialized, { bytes: bytes.byteLength, sha256: body.sha256 });
    assert.equal(finalProgress, bytes.byteLength);
    assert.deepEqual(await readFile(target), bytes);
  } finally {
    await opened?.close();
    await rm(testScope.root, { recursive: true, force: true });
  }
});

test("resource-body corruption is rejected even though content_sha256 excludes Base64", async () => {
  const testScope = await scope();
  try {
    const bytes = Buffer.alloc(RESOURCE_BASE64_DECODED_CHUNK_BYTES + 5, 0x31);
    const serialized = serializeConversation(sourceConversation(bytes));
    const marker = "        \"";
    const dataAt = serialized.indexOf("      \"data_base64\": [");
    const chunkAt = serialized.indexOf(marker, dataAt) + marker.length;
    const replacement = serialized[chunkAt] === "A" ? "B" : "A";
    await writeFile(testScope.file, `${serialized.slice(0, chunkAt)}${replacement}${serialized.slice(chunkAt + 1)}`, "utf8");
    await assert.rejects(() => openCanonicalConversationFile({ filePath: testScope.file }), /body index disagrees|contract validation/iu);
  } finally {
    await rm(testScope.root, { recursive: true, force: true });
  }
});

test("resource cancellation removes only its exact unfinished staging file", async () => {
  const testScope = await scope();
  const bytes = Buffer.alloc(RESOURCE_BASE64_DECODED_CHUNK_BYTES * 2 + 7, 0x44);
  let opened;
  try {
    await writeFile(testScope.file, serializeConversation(sourceConversation(bytes)), "utf8");
    opened = await openCanonicalConversationFile({ filePath: testScope.file });
    const target = path.join(testScope.root, "cancelled.bin");
    const abort = new AbortController();
    await assert.rejects(() => opened!.materializeResource({
      resource: "r1",
      stagingPath: target,
      signal: abort.signal,
      onProgress: (completed: number) => {
        if (completed >= RESOURCE_BASE64_DECODED_CHUNK_BYTES) abort.abort();
      }
    }), /abort/iu);
    await assert.rejects(() => stat(target), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
  } finally {
    await opened?.close();
    await rm(testScope.root, { recursive: true, force: true });
  }
});

test("an open view rejects source changes before materializing a cached resource", async () => {
  const testScope = await scope();
  const bytes = Buffer.alloc(17, 0x22);
  let opened;
  try {
    await writeFile(testScope.file, serializeConversation(sourceConversation(bytes)), "utf8");
    opened = await openCanonicalConversationFile({ filePath: testScope.file });
    await writeFile(testScope.file, `${await readFile(testScope.file, "utf8")} `, "utf8");
    const target = path.join(testScope.root, "stale.bin");
    await assert.rejects(() => opened!.materializeResource({ resource: "r1", stagingPath: target }), /changed while its view was open/iu);
    await assert.rejects(() => stat(target), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
  } finally {
    await opened?.close();
    await rm(testScope.root, { recursive: true, force: true });
  }
});

test("canonical line capacity is explicit and does not truncate a Conversation", async () => {
  const testScope = await scope();
  try {
    await writeFile(testScope.file, serializeConversation(sourceConversation(Buffer.alloc(17, 0x11))), "utf8");
    await assert.rejects(() => openCanonicalConversationFile({ filePath: testScope.file, maxLineBytes: 32 }), /line exceeds/iu);
  } finally {
    await rm(testScope.root, { recursive: true, force: true });
  }
});
