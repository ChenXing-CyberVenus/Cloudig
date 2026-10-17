import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "./types.mts";
import { isJsonObject } from "./types.mts";

const FIELD_ORDER = [
  "schema",
  "conversation_schema",
  "archive",
  "generation",
  "content_sha256",
  "parser",
  "lifecycle",
  "source",
  "content_time",
  "provider",
  "platform",
  "title",
  "models",
  "message_time",
  "current_message",
  "messages",
  "resources",
  "sources",
  "limitations",
  "user",
  "next_archive",
  "revision",
  "edited_at",
  "preferences",
  "parse",
  "identity",
  "workflow",
  "onboarding",
  "archives",
  "next",
  "terran_values",
  "lineages",
  "variants",
  "times",
  "contains",
  "spools",
  "counterparts",
  "terran_mappings",
  "display_order",
  "version",
  "adapter",
  "selector",
  "ordinal",
  "offset",
  "length",
  "item_sha256",
  "id",
  "parent",
  "role",
  "name",
  "model",
  "timestamp",
  "content",
  "type",
  "kind",
  "basis",
  "value",
  "range",
  "start",
  "end",
  "era",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "offset",
  "direction",
  "unit",
  "anchor",
  "target",
  "left",
  "right",
  "snapshot",
  "timeline",
  "lineage",
  "current",
  "next_variant",
  "owner",
  "number",
  "author",
  "standard_name",
  "created_at",
  "path",
  "sort",
  "node",
  "occurrences",
  "mode",
  "first",
  "step",
  "last",
  "count",
  "prefix",
  "display_empty",
  "endpoint",
  "nodes",
  "text",
  "code",
  "language",
  "filename",
  "tex",
  "mathml",
  "display",
  "html",
  "label",
  "format",
  "duration",
  "effort",
  "resource",
  "expected",
  "observed",
  "alt",
  "caption",
  "purpose",
  "query",
  "status",
  "call",
  "success",
  "input",
  "input_resource",
  "output",
  "output_resource",
  "rendered",
  "availability",
  "mime",
  "bytes",
  "sha256",
  "data_base64",
  "url",
  "dimensions",
  "width",
  "height",
  "original_name",
  "original_mime",
  "original_url",
  "original_bytes",
  "original_sha256",
  "snippet",
  "at",
  "detail",
  "state",
  "conversation_name",
  "names",
  "first_parsed_at",
  "last_parsed_at",
  "cloudig_edited_at",
  "file",
  "payload",
  "profile",
  "exporter",
  "locator",
  "captured_at",
  "field",
  "conversation_created_at",
  "conversation_updated_at",
  "ordinary",
  "claude",
  "parse_unparsed",
  "parse_selected",
  "update_outdated",
  "preserve_previous",
  "failures",
  "code",
  "attempts",
  "adapter_version",
  "failed_at",
  "theme",
  "global",
  "platforms",
  "assistant",
  "apply_to_all",
  "archiver",
  "reader",
  "time_field",
  "theme_switched"
] as const;

const FIELD_RANK = new Map<string, number>(FIELD_ORDER.map((field, index) => [field, index]));
const LOCAL_ID = /^(?:a|l|m|p|r|s|t|v|x)([1-9][0-9]*)$/u;

function rank(fields: readonly string[]): Map<string, number> {
  return new Map(fields.map((field, index) => [field, index]));
}

const ROOT_FIELD_RANKS = new Map<string, Map<string, number>>([
  ["cloudig/operation/1.0.0", rank(["schema", "operation", "phase", "state", "file", "bytes", "items", "error"])],
  ["cloudig/transaction/1.0.0", rank(["schema", "transaction", "state", "intent", "created_at", "updated_at", "authority", "targets"])],
  ["cloudig/catalog-cache/1.0.0", rank(["schema", "built_at", "adapter_bundle_sha256", "sources", "archives"])],
  ["cloudig/system-log/1.0.0", rank(["schema", "files"])],
  ["cloudig/time-system/1.0.0", rank(["schema", "revision", "edited_at", "next", "terran_values", "lineages", "variants", "times", "contains", "counterparts", "terran_mappings", "display_order"])]
]);

function contextualRank(value: JsonObject): Map<string, number> | undefined {
  const schema = value["schema"];
  if (typeof schema === "string" && ROOT_FIELD_RANKS.has(schema)) return ROOT_FIELD_RANKS.get(schema);
  if ("expected_before" in value && "action" in value) {
    return rank(["action", "path", "status", "expected_before", "staged_after", "installed", "temp", "displaced", "source", "semantic"]);
  }
  if ("mtime_ns" in value && "status" in value) {
    return rank(["path", "bytes", "mtime_ns", "sha256", "status", "route", "action", "outputs", "error"]);
  }
  if ("mtime_ns" in value && "archive" in value) {
    return rank(["path", "bytes", "mtime_ns", "sha256", "conversation_schema", "archive", "generation", "source_file", "source_title", "platform", "models", "message_count", "resource_count", "selector", "times", "archived"]);
  }
  if ("conversation_schema" in value && "parser" in value && "archive" in value) {
    return rank(["archive", "generation", "path", "conversation_schema", "parser", "adapter", "exporter", "profile", "payload_schema", "selector"]);
  }
  if ("format" in value && "platform" in value && "adapter" in value) {
    return rank(["format", "platform", "payload_schema", "profile", "adapter"]);
  }
  if ("recorded_at" in value && "errors" in value) return rank(["path", "recorded_at", "errors"]);
  if ("selector" in value && "ordinal" in value && "item_sha256" in value) {
    return rank(["schema", "selector", "ordinal", "offset", "length", "item_sha256", "title", "created_at", "updated_at", "messages", "branches", "fork_points", "orphan_parents"]);
  }
  if ("selector" in value && "attempts" in value && "adapter_version" in value) {
    return rank(["selector", "code", "attempts", "adapter_version", "failed_at"]);
  }
  if (value["schema"] === "cloudig/container-index/1.0.0") {
    return rank(["schema", "format", "source", "adapter", "built_at", "records", "outputs", "failures"]);
  }
  if ("resource" in value && "expected" in value && "path" in value) {
    return rank(["resource", "path", "status", "expected", "observed"]);
  }
  if ("completed" in value && ("total" in value || "total_known" in value)) {
    return rank(["index", "completed", "total", "total_known"]);
  }
  if ("id" in value && "version" in value && Object.keys(value).length <= 3) return rank(["id", "version"]);
  return undefined;
}

const nativeIsWellFormed = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;

function hasUnpairedSurrogate(value: string): boolean {
  if (nativeIsWellFormed) return !nativeIsWellFormed.call(value);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertString(value: string, path: string): void {
  if (hasUnpairedSurrogate(value)) throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
}

export function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertString(value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} contains an unsafe integer`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (!isJsonObject(value)) throw new TypeError(`${path} is not an I-JSON value`);
  for (const [key, entry] of Object.entries(value)) {
    assertString(key, `${path} key`);
    assertJsonValue(entry, `${path}.${key}`);
  }
}

function compareFields(left: string, right: string, localRank?: Map<string, number>): number {
  const leftId = LOCAL_ID.exec(left);
  const rightId = LOCAL_ID.exec(right);
  if (leftId && rightId && left[0] === right[0]) {
    const leftNumber = BigInt(leftId[1]!);
    const rightNumber = BigInt(rightId[1]!);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
  }
  const leftRank = localRank?.get(left) ?? FIELD_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = localRank?.get(right) ?? FIELD_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function orderedJsonKeys(value: JsonObject): string[] {
  const localRank = contextualRank(value);
  return Object.keys(value).sort((left, right) => compareFields(left, right, localRank));
}

export function orderJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(orderJson);
  if (!isJsonObject(value)) return value;
  const ordered: JsonObject = {};
  for (const key of orderedJsonKeys(value)) {
    ordered[key] = orderJson(value[key]!);
  }
  return ordered;
}

export function serializeDeterministic(value: unknown): string {
  assertJsonValue(value);
  return `${JSON.stringify(orderJson(value), null, 2)}\n`;
}

export function canonicalizeJcs(value: unknown): string {
  assertJsonValue(value);
  return encodeValidatedJcs(value);
}

// Validation walks the complete tree once. Recursively validating every
// subtree again made large message/markup trees pay for their depth repeatedly.
function encodeValidatedJcs(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeValidatedJcs).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeValidatedJcs(value[key]!)}`)
    .join(",")}}`;
}

function omitEmbeddedData(resource: JsonValue): JsonValue {
  if (!isJsonObject(resource)) return resource;
  const copy: JsonObject = {};
  for (const [key, value] of Object.entries(resource)) {
    if (key !== "data_base64") copy[key] = value;
  }
  return copy;
}

export function conversationContentProjection(conversation: JsonObject): JsonObject {
  const projection: JsonObject = {};
  for (const field of ["messages", "current_message", "sources", "limitations"] as const) {
    const value = conversation[field];
    if (value !== undefined) projection[field] = value;
  }
  const resources = conversation["resources"];
  if (Array.isArray(resources)) projection["resources"] = resources.map(omitEmbeddedData);
  return projection;
}

export function computeConversationContentSha256(conversation: JsonObject): string {
  const canonical = canonicalizeJcs(conversationContentProjection(conversation));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
