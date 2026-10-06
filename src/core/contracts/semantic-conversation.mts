import { createHash } from "node:crypto";

import { computeConversationContentSha256 } from "./deterministic-json.mts";
import { validateRange, validateUtcTimestamp } from "./semantic-common.mts";
import { validateConversationSchema } from "./schema-registry.mts";
import type { JsonObject, JsonValue, ValidationIssue, ValidationResult } from "./types.mts";
import { isJsonObject } from "./types.mts";
import resourceLimits from "./machine/resource-limits.json" with { type: "json" };

export type ObservedResourceBody = Readonly<{
  bytes: number;
  sha256: string;
}>;

function issue(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function validatePool(
  values: JsonValue[] | undefined,
  idField: string,
  prefix: string,
  path: string,
  issues: ValidationIssue[]
): Map<string, JsonObject> {
  const pool = new Map<string, JsonObject>();
  for (const [index, raw] of (values ?? []).entries()) {
    if (!isJsonObject(raw)) continue;
    const id = raw[idField];
    if (typeof id !== "string") continue;
    if (pool.has(id)) {
      issue(issues, "CLOUDIG_REFERENCE_DUPLICATE_ID", `${path}/${index}/${idField}`, `Duplicate ${prefix} ID`);
      continue;
    }
    pool.set(id, raw);
  }
  return pool;
}

function validateLifecycle(conversation: JsonObject, issues: ValidationIssue[]): void {
  const lifecycle = conversation["lifecycle"];
  if (!isJsonObject(lifecycle)) return;
  const first = lifecycle["first_parsed_at"];
  const last = lifecycle["last_parsed_at"];
  const edited = lifecycle["cloudig_edited_at"];
  if (isJsonObject(first) && first["basis"] === "parser") {
    validateUtcTimestamp(first["value"], "/lifecycle/first_parsed_at/value", issues);
  }
  validateUtcTimestamp(last, "/lifecycle/last_parsed_at", issues);
  validateUtcTimestamp(edited, "/lifecycle/cloudig_edited_at", issues);
  if (
    isJsonObject(first)
    && typeof first["value"] === "string"
    && typeof last === "string"
    && first["value"] > last
  ) {
    issue(issues, "CLOUDIG_LIFECYCLE_ORDER_INVALID", "/lifecycle/last_parsed_at", "last_parsed_at precedes first_parsed_at");
  }
  if (typeof last === "string" && typeof edited === "string" && last > edited) {
    issue(issues, "CLOUDIG_LIFECYCLE_ORDER_INVALID", "/lifecycle/cloudig_edited_at", "cloudig_edited_at precedes last_parsed_at");
  }
}

function validateSource(conversation: JsonObject, issues: ValidationIssue[]): void {
  const source = conversation["source"];
  if (!isJsonObject(source)) return;
  const file = source["file"];
  if (file === "." || file === "..") {
    issue(issues, "CLOUDIG_SOURCE_BASENAME_INVALID", "/source/file", "Source file must be a basename, not a path segment");
  }
  const captured = source["captured_at"];
  if (isJsonObject(captured)) validateUtcTimestamp(captured["value"], "/source/captured_at/value", issues);
  const created = source["conversation_created_at"];
  const updated = source["conversation_updated_at"];
  if (created !== undefined) validateUtcTimestamp(created, "/source/conversation_created_at", issues);
  if (updated !== undefined) validateUtcTimestamp(updated, "/source/conversation_updated_at", issues);
  if (typeof created === "string" && typeof updated === "string" && created > updated) {
    issue(issues, "CLOUDIG_SOURCE_TIME_ORDER_INVALID", "/source/conversation_updated_at", "Source update time precedes source creation time");
  }
}

function decodeEmbeddedResource(resource: JsonObject, path: string, issues: ValidationIssue[]): void {
  if (resource["availability"] !== "embedded") return;
  const expectedBytes = resource["bytes"];
  const expectedHash = resource["sha256"];
  const chunks = resource["data_base64"];
  const hash = createHash("sha256");
  let decodedBytes = 0;
  if (Array.isArray(chunks)) {
    for (const [index, chunk] of chunks.entries()) {
      if (typeof chunk !== "string") continue;
      const buffer = Buffer.from(chunk, "base64");
      if (buffer.toString("base64") !== chunk) {
        issue(issues, "CLOUDIG_RESOURCE_BASE64_NONCANONICAL", `${path}/data_base64/${index}`, "Embedded resource chunk is not canonical Base64");
      }
      if (index < chunks.length - 1 && buffer.byteLength !== resourceLimits.base64_decoded_chunk_bytes) {
        issue(issues, "CLOUDIG_RESOURCE_BASE64_CHUNK_SIZE", `${path}/data_base64/${index}`, "Every non-final decoded resource chunk must use the configured size");
      }
      if (index === chunks.length - 1 && buffer.byteLength > resourceLimits.base64_decoded_chunk_bytes) {
        issue(issues, "CLOUDIG_RESOURCE_BASE64_CHUNK_SIZE", `${path}/data_base64/${index}`, "Final decoded resource chunk exceeds the configured size");
      }
      hash.update(buffer);
      decodedBytes += buffer.byteLength;
    }
  }
  if (typeof expectedBytes === "number" && decodedBytes !== expectedBytes) {
    issue(issues, "CLOUDIG_RESOURCE_BYTE_COUNT_MISMATCH", `${path}/bytes`, "Decoded resource byte count does not match bytes");
  }
  const actualHash = hash.digest("hex");
  if (typeof expectedHash === "string" && actualHash !== expectedHash) {
    issue(issues, "CLOUDIG_RESOURCE_HASH_MISMATCH", `${path}/sha256`, "Decoded resource SHA-256 does not match");
  }
}

function requireResource(
  id: JsonValue | undefined,
  path: string,
  resources: Map<string, JsonObject>,
  issues: ValidationIssue[],
  expectedKind?: string
): void {
  if (typeof id !== "string") return;
  const resource = resources.get(id);
  if (!resource) {
    issue(issues, "CLOUDIG_REFERENCE_RESOURCE_MISSING", path, `Unknown resource ${id}`);
  } else if (expectedKind && resource["kind"] !== expectedKind) {
    issue(issues, "CLOUDIG_REFERENCE_RESOURCE_KIND", path, `Resource ${id} must be ${expectedKind}`);
  }
}

function requireSource(
  id: JsonValue,
  path: string,
  sources: Map<string, JsonObject>,
  issues: ValidationIssue[]
): void {
  if (typeof id === "string" && !sources.has(id)) {
    issue(issues, "CLOUDIG_REFERENCE_SOURCE_MISSING", path, `Unknown source ${id}`);
  }
}

function validateMessageContent(
  content: JsonValue[],
  messageIndex: number,
  resources: Map<string, JsonObject>,
  sources: Map<string, JsonObject>,
  issues: ValidationIssue[]
): void {
  const toolKinds = new Set<string>();
  for (const [blockIndex, raw] of content.entries()) {
    if (!isJsonObject(raw)) continue;
    const path = `/messages/${messageIndex}/content/${blockIndex}`;
    switch (raw["type"]) {
      case "image":
        requireResource(raw["resource"], `${path}/resource`, resources, issues, "image");
        break;
      case "attachment":
      case "unknown":
        requireResource(raw["resource"], `${path}/resource`, resources, issues);
        break;
      case "diagram":
        requireResource(raw["rendered"], `${path}/rendered`, resources, issues);
        break;
      case "interactive":
        requireResource(raw["preview"], `${path}/preview`, resources, issues);
        if (Array.isArray(raw["files"])) {
          for (const [fileIndex, file] of raw["files"].entries()) {
            if (isJsonObject(file)) requireResource(file["resource"], `${path}/files/${fileIndex}/resource`, resources, issues);
          }
        }
        break;
      case "search":
      case "citations": {
        const ids = raw["sources"];
        if (Array.isArray(ids)) {
          ids.forEach((id, index) => requireSource(id, `${path}/sources/${index}`, sources, issues));
        }
        break;
      }
      case "tool": {
        requireResource(raw["input_resource"], `${path}/input_resource`, resources, issues);
        requireResource(raw["output_resource"], `${path}/output_resource`, resources, issues);
        const call = raw["call"];
        const kind = raw["kind"];
        if (typeof call === "string" && typeof kind === "string") {
          const key = `${kind}:${call}`;
          if (toolKinds.has(key)) {
            issue(issues, "CLOUDIG_TOOL_ASSOCIATION_DUPLICATE", `${path}/call`, "A message cannot contain duplicate tool association roles");
          }
          toolKinds.add(key);
        }
        break;
      }
      default:
        break;
    }
  }
}

function validateMessages(
  conversation: JsonObject,
  resources: Map<string, JsonObject>,
  sources: Map<string, JsonObject>,
  issues: ValidationIssue[]
): void {
  const messages = conversation["messages"];
  if (!Array.isArray(messages)) return;
  const hasTreeIds = messages.some((message) => isJsonObject(message) && message["id"] !== undefined);
  const seen = new Set<string>();
  const timestamps: string[] = [];
  for (const [index, raw] of messages.entries()) {
    if (!isJsonObject(raw)) continue;
    const id = raw["id"];
    const parent = raw["parent"];
    if (hasTreeIds && typeof id !== "string") {
      issue(issues, "CLOUDIG_MESSAGE_TREE_ID_REQUIRED", `/messages/${index}/id`, "Every message in a tree conversation must have an ID");
    }
    if (!hasTreeIds && parent !== undefined) {
      issue(issues, "CLOUDIG_MESSAGE_LINEAR_PARENT_FORBIDDEN", `/messages/${index}/parent`, "Linear conversations cannot carry parent references");
    }
    if (typeof id === "string") {
      if (seen.has(id)) issue(issues, "CLOUDIG_MESSAGE_ID_DUPLICATE", `/messages/${index}/id`, "Message ID is duplicated");
      seen.add(id);
    }
    if (typeof parent === "string" && !seen.has(parent)) {
      issue(issues, "CLOUDIG_MESSAGE_PARENT_NOT_EARLIER", `/messages/${index}/parent`, "Parent must reference an earlier message");
    }
    if (typeof raw["timestamp"] === "string") {
      validateUtcTimestamp(raw["timestamp"], `/messages/${index}/timestamp`, issues);
      timestamps.push(raw["timestamp"]);
    }
    const content = raw["content"];
    if (Array.isArray(content)) validateMessageContent(content, index, resources, sources, issues);
  }
  const currentMessage = conversation["current_message"];
  if (typeof currentMessage === "string" && (!hasTreeIds || !seen.has(currentMessage))) {
    issue(issues, "CLOUDIG_CURRENT_MESSAGE_MISSING", "/current_message", "current_message must reference a message in the current tree");
  }
  validateMessageTimeSummary(conversation["message_time"], timestamps, issues);
}

function validateMessageTimeSummary(
  summary: JsonValue | undefined,
  timestamps: string[],
  issues: ValidationIssue[]
): void {
  const ordered = [...new Set(timestamps)].sort();
  if (ordered.length === 0) {
    if (summary !== undefined) issue(issues, "CLOUDIG_MESSAGE_TIME_WITHOUT_EVIDENCE", "/message_time", "message_time must be absent without reliable message timestamps");
    return;
  }
  if (!isJsonObject(summary)) {
    issue(issues, "CLOUDIG_MESSAGE_TIME_REQUIRED", "/message_time", "Reliable message timestamps require message_time");
    return;
  }
  if (summary["start"] !== ordered[0]) {
    issue(issues, "CLOUDIG_MESSAGE_TIME_START_MISMATCH", "/message_time/start", "message_time.start must be the earliest reliable message timestamp");
  }
  const expectedEnd = ordered.length > 1 ? ordered.at(-1) : undefined;
  if (expectedEnd === undefined && summary["end"] !== undefined) {
    issue(issues, "CLOUDIG_MESSAGE_TIME_END_REDUNDANT", "/message_time/end", "A single message time must omit end");
  } else if (expectedEnd !== undefined && summary["end"] !== expectedEnd) {
    issue(issues, "CLOUDIG_MESSAGE_TIME_END_MISMATCH", "/message_time/end", "message_time.end must be the latest distinct message timestamp");
  }
}

function validateContentTimes(conversation: JsonObject, issues: ValidationIssue[]): void {
  const parserTime = conversation["content_time"];
  if (isJsonObject(parserTime) && parserTime["range"] !== undefined) {
    validateRange(parserTime["range"]!, "/content_time/range", issues);
  }
  const user = conversation["user"];
  if (isJsonObject(user)) {
    validateUtcTimestamp(user["edited_at"], "/user/edited_at", issues);
    const contentTime = user["content_time"];
    if (isJsonObject(contentTime) && contentTime["range"] !== undefined) {
      validateRange(contentTime["range"]!, "/user/content_time/range", issues);
    }
  }
}

function validateConversationSemantics(
  conversation: JsonObject,
  verifyInlineResourceBodies: boolean,
  initialIssues: readonly ValidationIssue[] = []
): ValidationResult<JsonObject> {
  const issues: ValidationIssue[] = [...initialIssues];

  validateLifecycle(conversation, issues);
  validateSource(conversation, issues);
  validateContentTimes(conversation, issues);

  const resourcesValue = conversation["resources"];
  const resources = validatePool(
    Array.isArray(resourcesValue) ? resourcesValue : undefined,
    "id",
    "resource",
    "/resources",
    issues
  );
  if (verifyInlineResourceBodies) {
    for (const [index, resource] of (Array.isArray(resourcesValue) ? resourcesValue : []).entries()) {
      if (isJsonObject(resource)) decodeEmbeddedResource(resource, `/resources/${index}`, issues);
    }
  }

  const sourcesValue = conversation["sources"];
  const sources = validatePool(
    Array.isArray(sourcesValue) ? sourcesValue : undefined,
    "id",
    "source",
    "/sources",
    issues
  );
  validateMessages(conversation, resources, sources, issues);

  const actualHash = computeConversationContentSha256(conversation);
  if (conversation["content_sha256"] !== actualHash) {
    issue(issues, "CLOUDIG_CONTENT_HASH_MISMATCH", "/content_sha256", "content_sha256 does not match the canonical content projection");
  }

  return issues.length === 0 ? { ok: true, value: conversation } : { ok: false, issues };
}

export function validateConversation(value: unknown): ValidationResult<JsonObject> {
  const schema = validateConversationSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  return validateConversationSemantics(schema.value, true);
}

export function validateConversationMetadata(
  value: unknown,
  observedBodies: ReadonlyMap<string, ObservedResourceBody>
): ValidationResult<JsonObject> {
  if (!isJsonObject(value)) return validateConversationSchema<JsonObject>(value);
  const conversation = structuredClone(value);
  const schemaCandidate = structuredClone(conversation);
  const resources = Array.isArray(conversation["resources"]) ? conversation["resources"] : [];
  const schemaResources = Array.isArray(schemaCandidate["resources"]) ? schemaCandidate["resources"] : [];
  const issues: ValidationIssue[] = [];
  const expectedBodies = new Set<string>();
  for (const [index, raw] of resources.entries()) {
    if (!isJsonObject(raw)) continue;
    const schemaResource = isJsonObject(schemaResources[index]) ? schemaResources[index] : undefined;
    const id = raw["id"];
    if (raw["data_base64"] !== undefined) {
      issue(issues, "CLOUDIG_RESOURCE_METADATA_BODY_PRESENT", `/resources/${index}/data_base64`, "Streaming Conversation metadata must not retain Base64 bodies");
    }
    if (raw["availability"] !== "embedded" || typeof id !== "string") continue;
    const bytes = raw["bytes"];
    const sha256 = raw["sha256"];
    if (typeof bytes !== "number" || bytes === 0 || typeof sha256 !== "string") continue;
    expectedBodies.add(id);
    const observed = observedBodies.get(id);
    if (!observed) {
      issue(issues, "CLOUDIG_RESOURCE_BODY_INDEX_MISSING", `/resources/${index}`, `Embedded resource ${id} has no verified body index`);
    } else if (observed.bytes !== bytes || observed.sha256 !== sha256) {
      issue(issues, "CLOUDIG_RESOURCE_BODY_INDEX_MISMATCH", `/resources/${index}`, `Embedded resource ${id} body index disagrees with metadata`);
    }
    if (schemaResource) schemaResource["data_base64"] = ["AA=="];
  }
  for (const id of observedBodies.keys()) {
    if (!expectedBodies.has(id)) {
      issue(issues, "CLOUDIG_RESOURCE_BODY_INDEX_UNEXPECTED", "/resources", `Unexpected body index for ${id}`);
    }
  }
  const schema = validateConversationSchema<JsonObject>(schemaCandidate);
  if (!schema.ok) return { ok: false, issues: [...schema.issues, ...issues] };
  return validateConversationSemantics(conversation, false, issues);
}
