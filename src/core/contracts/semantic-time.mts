import { canonicalizeJcs } from "./deterministic-json.mts";
import {
  validateEndpoint,
  validateProgressionSelector,
  validateRange,
  validateSovereignSnapshotSemantics,
  validateUtcTimestamp
} from "./semantic-common.mts";
import {
  validateSovereignSnapshotSchema,
  validateTerranPresetSchema,
  validateTimeLimitsSchema,
  validateTimeSchema,
  validateTimeSystemSchema
} from "./schema-registry.mts";
import type { JsonObject, JsonValue, ValidationIssue, ValidationResult } from "./types.mts";
import { isJsonObject } from "./types.mts";

const PRESET_NODE_IDS = new Set(Array.from({ length: 17 }, (_, index) => `p${index + 1}`));
const PRESET_ORDER = [...PRESET_NODE_IDS];

function issue(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function pool(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function idNumber(id: string, prefix: string): bigint | undefined {
  const match = new RegExp(`^${prefix}([1-9][0-9]*)$`, "u").exec(id);
  return match ? BigInt(match[1]!) : undefined;
}

function validateWatermark(
  next: JsonValue | undefined,
  poolValue: JsonObject,
  prefix: string,
  path: string,
  issues: ValidationIssue[]
): void {
  if (typeof next !== "number" || !Number.isSafeInteger(next)) return;
  let maximum = 0n;
  for (const id of Object.keys(poolValue)) {
    const numeric = idNumber(id, prefix);
    if (numeric !== undefined && numeric > maximum) maximum = numeric;
  }
  if (BigInt(next) <= maximum) {
    issue(issues, "CLOUDIG_TIME_NEXT_NOT_MONOTONIC", path, `Next ${prefix} watermark must exceed every allocated ID`);
  }
}

function validateTimestampOrder(
  value: JsonObject,
  path: string,
  systemEditedAt: string,
  issues: ValidationIssue[]
): void {
  const created = value["created_at"];
  const edited = value["edited_at"];
  validateUtcTimestamp(created, `${path}/created_at`, issues);
  validateUtcTimestamp(edited, `${path}/edited_at`, issues);
  if (typeof created === "string" && typeof edited === "string" && created > edited) {
    issue(issues, "CLOUDIG_TIME_EDIT_PRECEDES_CREATE", `${path}/edited_at`, "edited_at precedes created_at");
  }
  if (typeof edited === "string" && systemEditedAt && edited > systemEditedAt) {
    issue(issues, "CLOUDIG_TIME_MEMBER_EDIT_AHEAD_OF_SYSTEM", `${path}/edited_at`, "Member edited_at is later than the Time System edit");
  }
}

type NodeInfo = {
  kind: "variant" | "preset" | "single" | "periodic";
  count?: number;
};

function nodeInfo(node: string, variants: JsonObject, times: JsonObject): NodeInfo | undefined {
  if (isJsonObject(variants[node])) return { kind: "variant" };
  if (PRESET_NODE_IDS.has(node)) return { kind: "preset" };
  const time = times[node];
  if (!isJsonObject(time)) return undefined;
  if (time["kind"] === "periodic" && typeof time["count"] === "number") {
    return { kind: "periodic", count: time["count"] };
  }
  return time["kind"] === "single" ? { kind: "single" } : undefined;
}

function validateNodeRef(
  value: JsonValue,
  path: string,
  context: "contains" | "relation",
  variants: JsonObject,
  times: JsonObject,
  issues: ValidationIssue[]
): void {
  if (!isJsonObject(value) || typeof value["node"] !== "string") return;
  const info = nodeInfo(value["node"], variants, times);
  if (!info) {
    issue(issues, "CLOUDIG_TIME_NODE_MISSING", `${path}/node`, `Unknown Time node ${value["node"]}`);
    return;
  }
  const occurrences = value["occurrences"];
  if (info.kind !== "periodic") {
    if (occurrences !== undefined) {
      issue(issues, "CLOUDIG_TIME_SELECTOR_NOT_ALLOWED", `${path}/occurrences`, "Only periodic nodes can carry occurrence selectors");
    }
    return;
  }
  if (!isJsonObject(occurrences)) {
    issue(issues, "CLOUDIG_TIME_SELECTOR_REQUIRED", `${path}/occurrences`, "Periodic references require an explicit selector");
    return;
  }
  if (context === "contains") {
    if (occurrences["mode"] !== "prefix") {
      issue(issues, "CLOUDIG_TIME_SELECTOR_MODE_INVALID", `${path}/occurrences/mode`, "Contains requires a prefix selector for periodic children");
      return;
    }
    const count = occurrences["count"];
    if (typeof count === "number" && info.count !== undefined && count > info.count) {
      issue(issues, "CLOUDIG_TIME_INVALID_SELECTOR", `${path}/occurrences`, "Prefix selector exceeds the periodic child count");
    }
    return;
  }
  if (occurrences["mode"] === "progression" && info.count !== undefined) {
    validateProgressionSelector(occurrences, info.count, `${path}/occurrences`, issues);
  }
}

function validateLineagesAndVariants(
  system: JsonObject,
  lineages: JsonObject,
  variants: JsonObject,
  issues: ValidationIssue[]
): void {
  const systemEditedAt = typeof system["edited_at"] === "string" ? system["edited_at"] : "";
  const numbersByLineage = new Map<string, Set<number>>();
  for (const [key, raw] of Object.entries(variants)) {
    if (!isJsonObject(raw)) continue;
    const path = `/variants/${key}`;
    if (raw["id"] !== key) issue(issues, "CLOUDIG_TIME_POOL_ID_MISMATCH", `${path}/id`, "Variant ID must match its pool key");
    validateTimestampOrder(raw, path, systemEditedAt, issues);
    const lineage = raw["lineage"];
    if (typeof lineage !== "string" || !isJsonObject(lineages[lineage])) {
      issue(issues, "CLOUDIG_TIME_LINEAGE_MISSING", `${path}/lineage`, "Variant owner lineage does not exist");
      continue;
    }
    const number = raw["number"];
    if (typeof number === "number") {
      const seen = numbersByLineage.get(lineage) ?? new Set<number>();
      if (seen.has(number)) {
        issue(issues, "CLOUDIG_TIME_VARIANT_NUMBER_DUPLICATE", `${path}/number`, "Variant number is duplicated within its lineage");
      }
      seen.add(number);
      numbersByLineage.set(lineage, seen);
    }
  }
  for (const [key, raw] of Object.entries(lineages)) {
    if (!isJsonObject(raw)) continue;
    const path = `/lineages/${key}`;
    if (raw["id"] !== key) issue(issues, "CLOUDIG_TIME_POOL_ID_MISMATCH", `${path}/id`, "Lineage ID must match its pool key");
    const current = raw["current"];
    const currentVariant = typeof current === "string" ? variants[current] : undefined;
    if (!isJsonObject(currentVariant) || currentVariant["lineage"] !== key) {
      issue(issues, "CLOUDIG_TIME_CURRENT_VARIANT_INVALID", `${path}/current`, "Current variant must exist inside this lineage");
    }
    const nextVariant = raw["next_variant"];
    const numbers = numbersByLineage.get(key) ?? new Set<number>();
    const maximum = numbers.size === 0 ? 0 : Math.max(...numbers);
    if (typeof nextVariant === "number" && nextVariant <= maximum) {
      issue(issues, "CLOUDIG_TIME_NEXT_VARIANT_NOT_MONOTONIC", `${path}/next_variant`, "next_variant must exceed every allocated #N in its lineage");
    }
  }
}

function validateTimes(
  system: JsonObject,
  variants: JsonObject,
  times: JsonObject,
  issues: ValidationIssue[]
): void {
  const systemEditedAt = typeof system["edited_at"] === "string" ? system["edited_at"] : "";
  for (const [key, raw] of Object.entries(times)) {
    if (!isJsonObject(raw)) continue;
    const path = `/times/${key}`;
    if (raw["id"] !== key) issue(issues, "CLOUDIG_TIME_POOL_ID_MISMATCH", `${path}/id`, "Time node ID must match its pool key");
    validateTimestampOrder(raw, path, systemEditedAt, issues);
    if (typeof raw["owner"] !== "string" || !isJsonObject(variants[raw["owner"]])) {
      issue(issues, "CLOUDIG_TIME_OWNER_MISSING", `${path}/owner`, "Time node owner variant does not exist");
    }
    if (raw["display_empty"] === true && typeof raw["count"] === "number" && raw["count"] > 20) {
      issue(issues, "CLOUDIG_TIME_EMPTY_EXPANSION_TOO_LARGE", `${path}/display_empty`, "display_empty is limited to periodic counts of 20 or fewer");
    }
  }
}

function validateContains(
  contains: JsonObject,
  variants: JsonObject,
  times: JsonObject,
  issues: ValidationIssue[]
): void {
  for (const [parent, rawLinks] of Object.entries(contains)) {
    if (!nodeInfo(parent, variants, times)) {
      issue(issues, "CLOUDIG_TIME_NODE_MISSING", `/contains/${parent}`, `Unknown contains parent ${parent}`);
    }
    if (!Array.isArray(rawLinks)) continue;
    rawLinks.forEach((link, index) => validateNodeRef(link, `/contains/${parent}/${index}`, "contains", variants, times, issues));
  }
}

function validateCounterparts(
  value: JsonValue | undefined,
  variants: JsonObject,
  times: JsonObject,
  issues: ValidationIssue[]
): void {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isJsonObject(raw)) continue;
    const path = `/counterparts/${index}`;
    const left = raw["left"];
    const right = raw["right"];
    validateNodeRef(left!, `${path}/left`, "relation", variants, times, issues);
    validateNodeRef(right!, `${path}/right`, "relation", variants, times, issues);
    const leftKey = canonicalizeJcs(left);
    const rightKey = canonicalizeJcs(right);
    if (leftKey > rightKey) {
      issue(issues, "CLOUDIG_TIME_COUNTERPART_NONCANONICAL", path, "Counterpart sides must use canonical NodeRef order");
    }
    const key = leftKey <= rightKey ? `${leftKey}|${rightKey}` : `${rightKey}|${leftKey}`;
    if (seen.has(key)) issue(issues, "CLOUDIG_TIME_COUNTERPART_DUPLICATE", path, "Exact counterpart is duplicated");
    seen.add(key);
  }
}

function validateMappings(
  value: JsonValue | undefined,
  systemEditedAt: string,
  variants: JsonObject,
  times: JsonObject,
  issues: ValidationIssue[]
): void {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  let previousSortKey: string | undefined;
  for (const [index, raw] of value.entries()) {
    if (!isJsonObject(raw)) continue;
    const path = `/terran_mappings/${index}`;
    const target = raw["target"];
    const range = raw["range"];
    validateNodeRef(target!, `${path}/target`, "relation", variants, times, issues);
    if (range !== undefined) validateRange(range, `${path}/range`, issues);
    validateUtcTimestamp(raw["edited_at"], `${path}/edited_at`, issues);
    if (typeof raw["edited_at"] === "string" && systemEditedAt && raw["edited_at"] > systemEditedAt) {
      issue(issues, "CLOUDIG_TIME_MEMBER_EDIT_AHEAD_OF_SYSTEM", `${path}/edited_at`, "Mapping edited_at is later than the Time System edit");
    }
    const identityKey = `${canonicalizeJcs(target)}|${canonicalizeJcs(range)}`;
    if (seen.has(identityKey)) issue(issues, "CLOUDIG_TIME_MAPPING_DUPLICATE", path, "Target and Terran range duplicate an existing mapping");
    seen.add(identityKey);
    const sortKey = `${identityKey}|${String(raw["edited_at"])}`;
    if (previousSortKey !== undefined && previousSortKey > sortKey) {
      issue(issues, "CLOUDIG_TIME_MAPPING_NONCANONICAL_ORDER", path, "Terran mappings must be stored in canonical target/range/edited_at order");
    }
    previousSortKey = sortKey;
  }
}

export function validateTimeValue(value: unknown): ValidationResult<JsonObject> {
  const schema = validateTimeSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const issues: ValidationIssue[] = [];
  validateRange(schema.value, "", issues);
  return issues.length === 0 ? schema : { ok: false, issues };
}

export function validateSovereignSnapshot(value: unknown): ValidationResult<JsonObject> {
  const schema = validateSovereignSnapshotSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const issues: ValidationIssue[] = [];
  validateSovereignSnapshotSemantics(schema.value, "", issues);
  return issues.length === 0 ? schema : { ok: false, issues };
}

export function validateTimeSystem(value: unknown): ValidationResult<JsonObject> {
  const schema = validateTimeSystemSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const system = schema.value;
  const issues: ValidationIssue[] = [];
  validateUtcTimestamp(system["edited_at"], "/edited_at", issues);

  const next = pool(system["next"]);
  const lineages = pool(system["lineages"]);
  const variants = pool(system["variants"]);
  const times = pool(system["times"]);
  validateWatermark(next["lineage"], lineages, "l", "/next/lineage", issues);
  validateWatermark(next["variant"], variants, "v", "/next/variant", issues);
  validateWatermark(next["time"], times, "t", "/next/time", issues);
  validateLineagesAndVariants(system, lineages, variants, issues);
  validateTimes(system, variants, times, issues);
  validateContains(pool(system["contains"]), variants, times, issues);
  validateCounterparts(system["counterparts"], variants, times, issues);
  validateMappings(
    system["terran_mappings"],
    typeof system["edited_at"] === "string" ? system["edited_at"] : "",
    variants,
    times,
    issues
  );

  const terranValues = pool(system["terran_values"]);
  for (const [preset, range] of Object.entries(terranValues)) {
    validateRange(range, `/terran_values/${preset}`, issues);
  }
  const displayOrder = system["display_order"];
  if (Array.isArray(displayOrder)) {
    displayOrder.forEach((variant, index) => {
      if (typeof variant === "string" && !isJsonObject(variants[variant])) {
        issue(issues, "CLOUDIG_TIME_DISPLAY_VARIANT_MISSING", `/display_order/${index}`, "display_order references an unknown variant");
      }
    });
  }

  return issues.length === 0 ? schema : { ok: false, issues };
}

export function validateTimeLimits(value: unknown): ValidationResult<JsonObject> {
  return validateTimeLimitsSchema<JsonObject>(value);
}

function validatePresetTemplateRange(value: JsonValue, path: string, issues: ValidationIssue[]): void {
  if (!isJsonObject(value)) return;
  const start = value["start"];
  const end = value["end"];
  if (start !== undefined) validateEndpoint(start, `${path}/start`, issues);
  if (end !== undefined) {
    validateEndpoint(end, `${path}/end`, issues);
    if (start !== undefined && canonicalizeJcs(start) === canonicalizeJcs(end)) {
      issue(issues, "CLOUDIG_TIME_NONCANONICAL_COLLAPSED_RANGE", `${path}/end`, "A point range must omit an endpoint equal to start");
    }
  }
}

export function validateTerranPreset(value: unknown): ValidationResult<JsonObject> {
  const schema = validateTerranPresetSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const issues: ValidationIssue[] = [];
  const nodes = schema.value["nodes"];
  const expectedKinds = new Map<string, string>([
    ["p1", "timeline"], ["p2", "special"], ["p3", "special"], ["p4", "special"],
    ["p5", "range"], ["p6", "range"], ["p7", "range"], ["p8", "range"], ["p9", "range"],
    ["p10", "range"], ["p11", "range"], ["p12", "range"], ["p13", "range"], ["p14", "range"],
    ["p15", "range"], ["p16", "range"], ["p17", "special"]
  ]);
  const expectedSpecial = new Map<string, string>([
    ["p2", "whenever"], ["p3", "unknown"], ["p4", "infinite_past"], ["p17", "infinite_future"]
  ]);
  if (Array.isArray(nodes)) {
    nodes.forEach((raw, index) => {
      if (!isJsonObject(raw)) return;
      const expectedId = PRESET_ORDER[index];
      const id = raw["id"];
      const path = `/nodes/${index}`;
      if (id !== expectedId) issue(issues, "CLOUDIG_TIME_PRESET_ORDER_INVALID", `${path}/id`, "Preset IDs must remain p1 through p17 in frozen order");
      if (typeof id === "string" && raw["kind"] !== expectedKinds.get(id)) {
        issue(issues, "CLOUDIG_TIME_PRESET_KIND_INVALID", `${path}/kind`, "Preset node kind does not match the frozen contract");
      }
      if (typeof id === "string" && isJsonObject(raw["endpoint"]) && raw["endpoint"]["kind"] !== expectedSpecial.get(id)) {
        issue(issues, "CLOUDIG_TIME_PRESET_SPECIAL_INVALID", `${path}/endpoint/kind`, "Preset special endpoint does not match the frozen contract");
      }
      if (raw["range"] !== undefined) validatePresetTemplateRange(raw["range"]!, `${path}/range`, issues);
    });
  }
  return issues.length === 0 ? schema : { ok: false, issues };
}
