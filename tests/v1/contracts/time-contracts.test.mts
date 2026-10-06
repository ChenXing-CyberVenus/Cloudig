import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  machineFiles,
  serializeSovereignSnapshot,
  serializeTerranPreset,
  serializeTimeLimits,
  serializeResourceLimits,
  serializeTimeSystem,
  serializeTimeValue,
  validateSovereignSnapshot,
  validateTerranPreset,
  validateResourceLimitsSchema,
  validateTimeLimits,
  validateTimeSystem,
  validateTimeValue
} from "../../../src/core/contracts/index.mts";
import { canonicalizeJcs } from "../../../src/core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue, ValidationResult } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

async function fixture(name: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
  assert.equal(isJsonObject(value), true);
  return value as JsonObject;
}

function issueCodes(result: ValidationResult<JsonObject>): string[] {
  return result.ok ? [] : result.issues.map((entry) => entry.code);
}

function reverseObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

test("Terran values validate real dates and canonical offsets", async () => {
  const valid = await fixture("time-terran-full.json");
  assert.equal(validateTimeValue(valid).ok, true);
  assert.equal(validateTimeValue(JSON.parse(serializeTimeValue(valid))).ok, true);

  const invalidOffset = validateTimeValue(await fixture("time-invalid-offset.json"));
  assert.ok(issueCodes(invalidOffset).includes("CLOUDIG_SCHEMA_INVALID"));
});

test("portable sovereign snapshots allow an unreachable target without inventing a path", async () => {
  const unreachable = await fixture("sovereign-snapshot-unreachable.json");
  assert.equal("path" in unreachable, false);
  assert.equal(validateSovereignSnapshot(unreachable).ok, true);
  assert.equal(validateSovereignSnapshot(JSON.parse(serializeSovereignSnapshot(unreachable))).ok, true);

  const invalidKind = validateSovereignSnapshot(await fixture("sovereign-snapshot-invalid-kind.json"));
  assert.ok(issueCodes(invalidKind).includes("CLOUDIG_TIME_TARGET_KIND_MISMATCH"));

  const unsortable = structuredClone(unreachable);
  unsortable["sort"] = { start: { kind: "unknown" } };
  assert.ok(issueCodes(validateSovereignSnapshot(unsortable)).includes("CLOUDIG_TIME_SNAPSHOT_SORT_UNORDERED"));
});

test("minimal and cyclic full Time Systems pass schema, semantics, and deterministic round-trip", async () => {
  for (const name of ["time-system-minimal.json", "time-system-full.json"]) {
    const value = await fixture(name);
    assert.equal(validateTimeSystem(value).ok, true, name);
    assert.equal(validateTimeSystem(JSON.parse(serializeTimeSystem(value))).ok, true, name);
  }
});

test("Time serializers ignore object insertion order but never reorder semantic arrays", async () => {
  const system = await fixture("time-system-full.json");
  assert.equal(serializeTimeSystem(system), serializeTimeSystem(reverseObjectKeys(system)));
  const reversedDisplay = structuredClone(system);
  assert.ok(Array.isArray(reversedDisplay["display_order"]));
  reversedDisplay["display_order"] = [...reversedDisplay["display_order"]].reverse();
  assert.notEqual(serializeTimeSystem(system), serializeTimeSystem(reversedDisplay));
});

test("Time contracts reject session state and snapshot graph copies", async () => {
  const sessionState = await fixture("time-system-minimal.json");
  sessionState["session"] = { selection: "v1" };
  assert.ok(issueCodes(validateTimeSystem(sessionState)).includes("CLOUDIG_SCHEMA_INVALID"));

  const graphCopy = await fixture("sovereign-snapshot-unreachable.json");
  graphCopy["parents"] = ["v2"];
  assert.ok(issueCodes(validateSovereignSnapshot(graphCopy)).includes("CLOUDIG_SCHEMA_INVALID"));
});

test("Time System watermarks and direct references never guess through missing authority", async () => {
  const invalidNext = validateTimeSystem(await fixture("time-system-invalid-next.json"));
  assert.ok(issueCodes(invalidNext).includes("CLOUDIG_TIME_NEXT_NOT_MONOTONIC"));

  const dangling = validateTimeSystem(await fixture("time-system-invalid-dangling.json"));
  assert.ok(issueCodes(dangling).includes("CLOUDIG_TIME_NODE_MISSING"));
});

test("periodic selectors are explicit and bounded by their target", async () => {
  const invalidPrefix = await fixture("time-system-full.json");
  const contains = invalidPrefix["contains"];
  assert.ok(isJsonObject(contains) && Array.isArray(contains["v2"]));
  const periodicLink = contains["v2"][1];
  assert.ok(isJsonObject(periodicLink) && isJsonObject(periodicLink["occurrences"]));
  periodicLink["occurrences"]["count"] = 13;
  assert.ok(issueCodes(validateTimeSystem(invalidPrefix)).includes("CLOUDIG_TIME_INVALID_SELECTOR"));

  const missingRelationSelector = await fixture("time-system-full.json");
  const counterparts = missingRelationSelector["counterparts"];
  assert.ok(Array.isArray(counterparts) && isJsonObject(counterparts[0]) && isJsonObject(counterparts[0]["right"]));
  delete counterparts[0]["right"]["occurrences"];
  assert.ok(issueCodes(validateTimeSystem(missingRelationSelector)).includes("CLOUDIG_TIME_SELECTOR_REQUIRED"));
});

test("Terran mappings reject exact duplicates without rejecting reversed user ranges", async () => {
  const duplicate = await fixture("time-system-full.json");
  const mappings = duplicate["terran_mappings"];
  assert.ok(Array.isArray(mappings) && isJsonObject(mappings[0]));
  const repeated = structuredClone(mappings[0]);
  repeated["edited_at"] = "2026-08-31T11:30:00.000Z";
  mappings.push(repeated);
  assert.ok(issueCodes(validateTimeSystem(duplicate)).includes("CLOUDIG_TIME_MAPPING_DUPLICATE"));

  const reversed = await fixture("time-system-full.json");
  const reversedMappings = reversed["terran_mappings"];
  assert.ok(Array.isArray(reversedMappings) && isJsonObject(reversedMappings[0]) && isJsonObject(reversedMappings[0]["range"]));
  const range = reversedMappings[0]["range"];
  const start = range["start"];
  range["start"] = range["end"]!;
  range["end"] = start!;
  assert.equal(validateTimeSystem(reversed).ok, true);
});

test("frozen machine files validate and serialize deterministically", () => {
  assert.deepEqual(machineFiles.resourceLimits, {
    schema: "cloudig/resource-limits/1.0.0",
    version: "1.0.0",
    base64_decoded_chunk_bytes: 196_608,
    canonical_json_line_max_bytes: 67_108_864,
    ipc_json_line_max_bytes: 1_048_576,
    ipc_json_depth_max: 32,
    ipc_json_nodes_max: 20_000,
    ipc_concurrent_commands_max: 4,
    reader_message_page_max: 200,
    reader_navigation_page_max: 500,
    reader_branch_page_max: 200,
    avatar_file_max_bytes: 67_108_864
  });
  assert.equal(validateResourceLimitsSchema(machineFiles.resourceLimits).ok, true);
  assert.equal(validateResourceLimitsSchema(JSON.parse(serializeResourceLimits(machineFiles.resourceLimits))).ok, true);
  assert.equal(validateTimeLimits(machineFiles.timeLimits).ok, true);
  assert.equal(validateTerranPreset(machineFiles.terranPreset).ok, true);
  assert.equal(validateTimeLimits(JSON.parse(serializeTimeLimits(machineFiles.timeLimits))).ok, true);
  assert.equal(validateTerranPreset(JSON.parse(serializeTerranPreset(machineFiles.terranPreset))).ok, true);
  assert.deepEqual(machineFiles.terranPreset.nodes.map((node) => node.id), Array.from({ length: 17 }, (_, index) => `p${index + 1}`));
  assert.equal(
    createHash("sha256").update(canonicalizeJcs(machineFiles.timeLimits), "utf8").digest("hex"),
    "911146f3ad0c1541d3a3b7bbbed24ade715e17edacabd33ae5635bfd2da5b331"
  );
  assert.equal(
    createHash("sha256").update(canonicalizeJcs(machineFiles.terranPreset), "utf8").digest("hex"),
    "aca7ce536d7c5ff5faf86a430016063b56cb029d393bfa3799bd67ceadd23c1b"
  );
});
