import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computeConversationContentSha256,
  finalizeConversation,
  serializeConversation,
  serializeDeterministic,
  serializeLibrary,
  validateConversation,
  validateConversationMetadata,
  validateLibrary
} from "../../../src/core/contracts/index.mts";
import type { JsonObject, JsonValue, ValidationResult } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

async function fixture(name: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
  assert.equal(isJsonObject(value), true);
  return value as JsonObject;
}

function issueCodes(result: ValidationResult<JsonObject>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function reverseObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

test("valid Conversation fixtures pass schema and semantic validation", async () => {
  for (const name of ["conversation-minimal.json", "conversation-full.json"]) {
    const value = await fixture(name);
    const result = validateConversation(value);
    assert.equal(result.ok, true, name);
    const bytes = serializeConversation(value);
    assert.equal(bytes.endsWith("\n"), true);
    assert.equal(Buffer.from(bytes, "utf8").subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    assert.equal(validateConversation(JSON.parse(bytes)).ok, true);
  }
});

test("streaming Conversation metadata validates only with exact externally verified resource bodies", async () => {
  const value = await fixture("conversation-full.json");
  const embedded = (value["resources"] as JsonObject[]).filter((entry) => entry["availability"] === "embedded" && Number(entry["bytes"]) > 0);
  const observed = new Map(embedded.map((entry) => [
    String(entry["id"]),
    { bytes: Number(entry["bytes"]), sha256: String(entry["sha256"]) }
  ]));
  for (const entry of embedded) delete entry["data_base64"];
  const resource = embedded[0]!;
  const id = String(resource["id"]);
  assert.equal(validateConversationMetadata(value, observed).ok, true);
  const missing = new Map(observed);
  missing.delete(id);
  assert.ok(issueCodes(validateConversationMetadata(value, missing)).includes("CLOUDIG_RESOURCE_BODY_INDEX_MISSING"));
  const mismatched = new Map(observed);
  mismatched.set(id, { bytes: Number(resource["bytes"]) + 1, sha256: String(resource["sha256"]) });
  assert.ok(issueCodes(validateConversationMetadata(value, mismatched)).includes("CLOUDIG_RESOURCE_BODY_INDEX_MISMATCH"));
  assert.ok(issueCodes(validateConversationMetadata(value, new Map([...observed, ["r999", { bytes: 1, sha256: "0".repeat(64) }]]))).includes("CLOUDIG_RESOURCE_BODY_INDEX_UNEXPECTED"));
  resource["data_base64"] = ["AA=="];
  assert.ok(issueCodes(validateConversationMetadata(value, observed)).includes("CLOUDIG_RESOURCE_METADATA_BODY_PRESENT"));
});

test("valid Library fixtures pass schema and semantic validation", async () => {
  for (const name of ["library-minimal.json", "library-full.json"]) {
    const value = await fixture(name);
    assert.equal(validateLibrary(value).ok, true, name);
    const bytes = serializeLibrary(value);
    assert.equal(bytes.endsWith("\n"), true);
    assert.equal(validateLibrary(JSON.parse(bytes)).ok, true);
  }
});

test("schema entry rejects values outside the I-JSON interoperability envelope", async () => {
  const unsafeInteger = await fixture("conversation-minimal.json");
  unsafeInteger["archive"] = Number.MAX_SAFE_INTEGER + 1;
  assert.deepEqual(issueCodes(validateConversation(unsafeInteger)), ["CLOUDIG_IJSON_INVALID"]);

  const unpairedSurrogate = await fixture("library-minimal.json");
  unpairedSurrogate["edited_at"] = "\ud800";
  assert.deepEqual(issueCodes(validateLibrary(unpairedSurrogate)), ["CLOUDIG_IJSON_INVALID"]);
});

test("deterministic serialization ignores insertion order but preserves arrays", async () => {
  for (const name of ["conversation-full.json", "library-full.json"]) {
    const value = await fixture(name);
    const reversed = reverseObjectKeys(value);
    assert.equal(serializeDeterministic(value), serializeDeterministic(reversed));
  }
  const conversation = await fixture("conversation-full.json");
  const reversedMessages = structuredClone(conversation);
  assert.ok(Array.isArray(reversedMessages["messages"]));
  reversedMessages["messages"] = [...reversedMessages["messages"]].reverse();
  assert.notEqual(serializeDeterministic(conversation), serializeDeterministic(reversedMessages));
});

test("content hash excludes embedded Base64 while the storage contract still rejects noncanonical rechunking", async () => {
  const conversation = await fixture("conversation-full.json");
  const originalHash = computeConversationContentSha256(conversation);
  const rechunked = structuredClone(conversation);
  const resources = rechunked["resources"];
  assert.ok(Array.isArray(resources) && isJsonObject(resources[0]));
  resources[0]["data_base64"] = ["aA==", "aQ=="];
  assert.equal(computeConversationContentSha256(rechunked), originalHash);
  const rechunkedValidation = validateConversation(rechunked);
  assert.equal(rechunkedValidation.ok, false);
  if (!rechunkedValidation.ok) {
    assert.ok(rechunkedValidation.issues.some((entry) => entry.code === "CLOUDIG_RESOURCE_BASE64_CHUNK_SIZE"));
  }

  const renamed = structuredClone(conversation);
  const user = renamed["user"];
  assert.ok(isJsonObject(user));
  user["conversation_name"] = "A different user title";
  assert.equal(computeConversationContentSha256(renamed), originalHash);

  const changed = structuredClone(conversation);
  const messages = changed["messages"];
  assert.ok(Array.isArray(messages) && isJsonObject(messages[0]));
  const content = messages[0]["content"];
  assert.ok(Array.isArray(content) && isJsonObject(content[0]));
  content[0]["text"] = "Changed source content";
  assert.notEqual(computeConversationContentSha256(changed), originalHash);
});

test("finalizeConversation installs the exact content hash", async () => {
  const value = await fixture("conversation-minimal.json");
  value["content_sha256"] = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const finalized = finalizeConversation(value);
  assert.equal(finalized["content_sha256"], computeConversationContentSha256(finalized));
  assert.equal(validateConversation(finalized).ok, true);
});

test("Conversation invalid fixtures fail at the correct responsibility", async () => {
  const forbidden = validateConversation(await fixture("conversation-invalid-forbidden-field.json"));
  assert.ok(issueCodes(forbidden).includes("CLOUDIG_SCHEMA_INVALID"));

  const dangling = validateConversation(await fixture("conversation-invalid-dangling-resource.json"));
  assert.ok(issueCodes(dangling).includes("CLOUDIG_REFERENCE_RESOURCE_MISSING"));

  const resourceHash = validateConversation(await fixture("conversation-invalid-resource-hash.json"));
  assert.ok(issueCodes(resourceHash).includes("CLOUDIG_RESOURCE_HASH_MISMATCH"));
  assert.equal(issueCodes(resourceHash).includes("CLOUDIG_CONTENT_HASH_MISMATCH"), false);
});

test("Conversation tree, time, and canonical range invariants are semantic", async () => {
  const full = await fixture("conversation-full.json");
  const parentAfter = structuredClone(full);
  const messages = parentAfter["messages"];
  assert.ok(Array.isArray(messages) && isJsonObject(messages[0]));
  messages[0]["parent"] = "m2";
  parentAfter["content_sha256"] = computeConversationContentSha256(parentAfter);
  assert.ok(issueCodes(validateConversation(parentAfter)).includes("CLOUDIG_MESSAGE_PARENT_NOT_EARLIER"));

  const invalidDate = structuredClone(full);
  const parserTime = invalidDate["content_time"];
  assert.ok(isJsonObject(parserTime) && isJsonObject(parserTime["range"]));
  const start = parserTime["range"]["start"];
  assert.ok(isJsonObject(start));
  start["month"] = 2;
  start["day"] = 30;
  invalidDate["content_sha256"] = computeConversationContentSha256(invalidDate);
  assert.ok(issueCodes(validateConversation(invalidDate)).includes("CLOUDIG_TIME_INVALID_CALENDAR_DATE"));

  const collapsed = structuredClone(full);
  const collapsedTime = collapsed["content_time"];
  assert.ok(isJsonObject(collapsedTime) && isJsonObject(collapsedTime["range"]));
  collapsedTime["range"]["end"] = structuredClone(collapsedTime["range"]["start"]!);
  collapsed["content_sha256"] = computeConversationContentSha256(collapsed);
  assert.ok(issueCodes(validateConversation(collapsed)).includes("CLOUDIG_TIME_NONCANONICAL_COLLAPSED_RANGE"));
});

test("Library invalid fixtures reject hidden session state and unsafe authority", async () => {
  assert.ok(issueCodes(validateLibrary(await fixture("library-invalid-next-archive.json"))).includes("CLOUDIG_NEXT_ARCHIVE_NOT_MONOTONIC"));
  assert.ok(issueCodes(validateLibrary(await fixture("library-invalid-session-field.json"))).includes("CLOUDIG_SCHEMA_INVALID"));
  assert.ok(issueCodes(validateLibrary(await fixture("library-invalid-avatar-scope.json"))).includes("CLOUDIG_USER_ASSET_SCOPE_INVALID"));
});
