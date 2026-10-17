import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allocateArchive,
  archiveUserValuesEqual,
  classifyArchiveConflict,
  copyArchiveStateWithoutInventingEdit,
  decideArchiveWrite,
  recoverNextArchive,
  resolveArchiveView
} from "../../../src/core/index.mts";
import type { ArchiveWriteEvidence, Fingerprint, SourceLineIdentity } from "../../../src/core/archive/safe-replace.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";

const contractFixtures = new URL("../contracts/fixtures/", import.meta.url);

test("Content Time is empty until a user sets it, regardless of source, message or Parser timestamps", async () => {
  const conversation = await fixture("conversation-minimal.json");
  conversation["message_time"] = { start: "2024-01-01T00:00:00.000Z" };
  conversation["content_time"] = { basis: "message_start", range: { start: { kind: "calendar", era: "AD", year: 2024 } } };
  const builtins = { user: { name: "User", avatar: "user.svg" }, assistant: { name: "AI", avatar: "ai.svg" }, platforms: {} };
  const library: JsonObject = { archives: {} };
  const view = () => resolveArchiveView(conversation, library, builtins, new Set()).contentTime;
  assert.deepEqual(view(), { state: "unavailable" }, "an old inferred root time is not a user assertion");
  const range = { start: { kind: "calendar", era: "BC", year: 2000 } };
  library["archives"] = { a1: { content_time: { state: "set", range } } };
  assert.deepEqual(view(), { state: "set", range });
  library["archives"] = { a1: { content_time: { state: "cleared" } } };
  assert.deepEqual(view(), { state: "cleared" });
  library["archives"] = { a1: {} };
  assert.deepEqual(view(), { state: "unavailable" });
  delete library["archives"];
  conversation["user"] = { content_time: { state: "set", range } };
  assert.deepEqual(view(), { state: "set", range }, "a real portable user snapshot remains valid");
});

async function fixture(name: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(new URL(name, contractFixtures), "utf8"));
  assert.equal(isJsonObject(value), true);
  return value as JsonObject;
}

const OLD_SOURCE: Fingerprint = { bytes: 100, sha256: "1".repeat(64) };
const NEW_SOURCE: Fingerprint = { bytes: 101, sha256: "2".repeat(64) };
const TARGET: Fingerprint = { bytes: 200, sha256: "3".repeat(64) };
const LINE: SourceLineIdentity = {
  format: "exporter-html",
  platform: "chatgpt",
  family: "chatgpt",
  payload: "ai-chat-archive/export-v1",
  profile: "light",
  selector: { kind: "single" }
};

function evidence(overrides: Partial<ArchiveWriteEvidence> = {}): ArchiveWriteEvidence {
  const base: ArchiveWriteEvidence = {
    source: { path: "Inbox/chat.html", fingerprint: NEW_SOURCE, identity: LINE },
    binding: {
      fresh: true,
      sourcePath: "Inbox/chat.html",
      sourceFingerprint: OLD_SOURCE,
      sourceIdentity: LINE,
      archive: "a7",
      generation: 3,
      targetPath: "Conversations/chat--a7.json",
      targetFingerprint: TARGET
    },
    target: {
      path: "Conversations/chat--a7.json",
      fingerprint: TARGET,
      schemaSupported: true,
      archive: "a7",
      generation: 3
    },
    candidate: { valid: true, archive: "a7", generation: 4 },
    compatibility: "same_adapter",
    preservePrevious: false,
    copyUserStateOnPreserve: true,
    expectedStillCurrent: true,
    registeredPathMigrationProven: false
  };
  return { ...base, ...overrides };
}

test("safe replace only updates one proven registered source line", () => {
  assert.deepEqual(decideArchiveWrite(evidence()), {
    action: "replace",
    reason: "registered_source_changed",
    archive: "a7",
    generation: 4,
    copyUserState: true
  });
  assert.equal(decideArchiveWrite(evidence({
    source: { path: "Inbox/chat.html", fingerprint: OLD_SOURCE, identity: LINE }
  })).action, "unchanged");
  assert.equal(decideArchiveWrite(evidence({
    source: { path: "Inbox/copy.html", fingerprint: NEW_SOURCE, identity: LINE }
  })).reason, "different_source_path");
  assert.equal(decideArchiveWrite(evidence({
    source: { path: "Inbox/chat.html", fingerprint: NEW_SOURCE, identity: { ...LINE, profile: "full" } }
  })).reason, "source_line_identity_changed");
});

test("same locator, bytes, title, or body never grant a second path replacement authority", () => {
  for (const fingerprint of [OLD_SOURCE, NEW_SOURCE]) {
    const result = decideArchiveWrite(evidence({
      source: {
        path: "Inbox/duplicate.html",
        fingerprint,
        identity: { ...LINE, selector: { kind: "single", locator: "same-vendor-id" } }
      }
    }));
    assert.equal(result.action, "create_new");
  }
});

test("a moved source keeps its line only with explicit old-missing and unique-SHA proof", () => {
  const moved = decideArchiveWrite(evidence({
    source: { path: "Inbox/renamed.html", fingerprint: OLD_SOURCE, identity: LINE },
    registeredPathMigrationProven: true
  }));
  assert.equal(moved.action, "unchanged");
  assert.equal(moved.reason, "registered_source_moved");

  const changedAtNewPath = decideArchiveWrite(evidence({
    source: { path: "Inbox/renamed.html", fingerprint: NEW_SOURCE, identity: LINE },
    registeredPathMigrationProven: true
  }));
  assert.equal(changedAtNewPath.action, "create_new");
});

test("preserve, stale evidence, candidate failure, and commit races stay conservative", () => {
  assert.deepEqual(decideArchiveWrite(evidence({ preservePrevious: true })), {
    action: "create_new",
    reason: "preserve_previous",
    copyUserState: true
  });
  assert.equal(decideArchiveWrite(evidence({ binding: { ...evidence().binding!, fresh: false } })).reason, "catalog_binding_stale");
  assert.equal(decideArchiveWrite(evidence({ candidate: { valid: false } })).action, "reject_candidate");
  assert.equal(decideArchiveWrite(evidence({ expectedStillCurrent: false })).action, "conflict");
  assert.equal(decideArchiveWrite(evidence({ candidate: { valid: true, archive: "a8", generation: 1 } })).reason, "candidate_identity_mismatch");
});

test("adapter policy produces explicit reparse, redownload, upgrade, and unsupported results", () => {
  assert.equal(decideArchiveWrite(evidence({
    source: { path: "Inbox/chat.html", fingerprint: OLD_SOURCE, identity: LINE },
    compatibility: "reparse_source"
  })).reason, "adapter_reparse");
  assert.equal(decideArchiveWrite(evidence({ compatibility: "redownload_source" })).action, "redownload_required");
  assert.equal(decideArchiveWrite(evidence({ compatibility: "upgrade_cloudig" })).action, "upgrade_required");
  assert.equal(decideArchiveWrite(evidence({ compatibility: "unsupported" })).action, "unsupported");
  assert.deepEqual(decideArchiveWrite(evidence({ compatibility: "unknown_policy" })), { action: "create_new", reason: "unknown_policy", copyUserState: false });
});

test("archive allocation is monotonic and conflicts never pick a winner", () => {
  assert.equal(recoverNextArchive(["a1", "a9", "not-an-id"]), 10);
  assert.deepEqual(allocateArchive(15, ["a1", "a9"]), { archive: "a15", nextArchive: 16 });
  assert.throws(() => allocateArchive(9, ["a1", "a9"]), /reuse or backfill/u);
  assert.equal(classifyArchiveConflict("a2", "Conversations/new.json", [{ archive: "a1", path: "Conversations/old.json" }]), "available");
  assert.equal(classifyArchiveConflict("a1", "Conversations/old.json", [{ archive: "a1", path: "Conversations/old.json" }]), "same_file");
  assert.equal(classifyArchiveConflict("a1", "Conversations/new.json", [{ archive: "a1", path: "Conversations/old.json" }]), "read_only_conflict");
});

const BUILTINS = {
  user: { name: "User", avatar: "Assets/builtin-user.svg", localizedNames: { "zh-CN": "采云用户", en: "User" } },
  assistant: { name: "AI", avatar: "Assets/builtin-ai.svg", localizedNames: { "zh-CN": "智能伙伴", en: "AI" } },
  platforms: {
    chatgpt: { name: "ChatGPT", avatar: "Assets/chatgpt.svg" }
  }
} as const;

test("Library archive tombstones outrank older Conversation snapshots field by field", async () => {
  const conversation = await fixture("conversation-full.json");
  const library = await fixture("library-full.json");
  const resolved = resolveArchiveView(
    conversation,
    library,
    BUILTINS,
    new Set(["Data/Assets/User/user.png", "Data/Assets/User/assistant.png", "Data/Assets/User/chatgpt.png"])
  );
  assert.equal(resolved.archiveLayer, "library");
  assert.equal(resolved.conversationName, "Scheduled tree example");
  assert.deepEqual(resolved.models, []);
  assert.equal(resolved.userName, "晨星");
  assert.equal(resolved.assistantName, "奥思");
  assert.equal(resolved.userAvatar, "Data/Assets/User/user.png");
  assert.equal(resolved.assistantAvatar, "Data/Assets/User/assistant.png");
  assert.deepEqual(resolved.contentTime, { state: "cleared" });
  assert.equal(resolved.effectiveEditedAt, "2026-08-31T12:00:00.000Z");
});

test("an archive with no Library row initializes from its own portable snapshot only", async () => {
  const conversation = await fixture("conversation-full.json");
  const library = await fixture("library-full.json");
  const archives = library["archives"];
  assert.ok(isJsonObject(archives));
  delete archives["a2"];
  const resolved = resolveArchiveView(conversation, library, BUILTINS, new Set());
  assert.equal(resolved.archiveLayer, "conversation_snapshot");
  assert.equal(resolved.conversationName, "My scheduled example");
  assert.equal(resolved.userName, "晨星");
  assert.equal(resolved.assistantName, "奥思");
  assert.equal(resolved.userAvatar, "Assets/builtin-user.svg");
  assert.equal(resolved.assistantAvatar, "Assets/chatgpt.svg");
  assert.deepEqual(resolved.contentTime, { state: "cleared" });
});

test("assistant identity respects apply-to-all, platform priority, global fallback, and missing assets", async () => {
  const conversation = await fixture("conversation-full.json");
  const library = await fixture("library-full.json");
  const archives = library["archives"];
  assert.ok(isJsonObject(archives) && isJsonObject(archives["a2"]));
  archives["a2"]["names"] = { assistant: "Archive AI" };
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).assistantName, "Archive AI");

  delete archives["a2"]["names"];
  const identity = library["identity"];
  assert.ok(isJsonObject(identity) && isJsonObject(identity["global"]) && isJsonObject(identity["global"]["assistant"]));
  delete identity["global"]["assistant"]["apply_to_all"];
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).assistantName, "ChatGPT");
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).assistantAvatar, "Assets/chatgpt.svg");
});

test("untouched builtin identity names follow the interface language while explicit names remain verbatim", async () => {
  const conversation = await fixture("conversation-full.json");
  const library = await fixture("library-full.json");
  delete conversation["user"];
  delete library["archives"];
  delete library["identity"];
  library["preferences"] = { language: "en", theme: "dawn" };
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).userName, "User");
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).assistantName, "ChatGPT");
  conversation["platform"] = "future-platform";
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).assistantName, "AI");
  library["identity"] = {
    global: {
      user: { name: "晨星.CyberVenus" },
      assistant: { name: "奥思", apply_to_all: true }
    }
  };
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).userName, "晨星.CyberVenus");
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).assistantName, "奥思");
  delete library["identity"];
  library["preferences"] = { language: "zh-CN", theme: "dawn" };
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).userName, "采云用户");
  assert.equal(resolveArchiveView(conversation, library, BUILTINS, new Set()).assistantName, "智能伙伴");
});

test("sparse user-state equality ignores revision bookkeeping and preserve copy keeps original edit facts", async () => {
  const library = await fixture("library-full.json");
  const archives = library["archives"];
  assert.ok(isJsonObject(archives) && isJsonObject(archives["a1"]));
  const state = archives["a1"];
  const sameValues = structuredClone(state);
  sameValues["revision"] = 99;
  sameValues["edited_at"] = "2026-09-01T00:00:00.000Z";
  assert.equal(archiveUserValuesEqual(state, sameValues), true);
  sameValues["conversation_name"] = "Changed";
  assert.equal(archiveUserValuesEqual(state, sameValues), false);
  assert.deepEqual(copyArchiveStateWithoutInventingEdit(state), state);
});
