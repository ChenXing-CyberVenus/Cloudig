import { createRequire } from "node:module";
import { CONVERSATION_SCHEMA_BRANCHES_CURRENT, validateConversation as validateLegacyConversation } from "./validate.mjs";

const require = createRequire(import.meta.url);
const time = require("../time/core.js");

export const CONVERSATION_SCHEMA_V1 = "ai-chat-archive/conversation/1.0.0";
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DATE_TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const ROOT_KEYS = new Set(["schema", "identity", "generation", "lifecycle", "source", "message_time", "content_time", "title", "provider", "platform", "models", "messages", "resources", "sources", "warnings"]);
const MAX_ERRORS = time.LIMITS.validation.max_errors;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function add(errors, code, path, message, details = undefined) {
  if (errors.length >= MAX_ERRORS) return;
  errors.push({ code, path, message, ...(details === undefined ? {} : { details }) });
}

function requireFields(value, fields, path, errors) {
  if (!isRecord(value)) return;
  for (const field of fields) if (!hasOwn(value, field)) add(errors, "CLOUDIG_V1_REQUIRED", path, `Missing required field ${field}`);
}

function allowedFields(value, fields, path, errors) {
  if (!isRecord(value)) return;
  for (const field of Object.keys(value)) if (!fields.has(field)) add(errors, "CLOUDIG_V1_UNKNOWN_FIELD", `${path}.${field}`, "Unknown field");
}

function record(value, path, errors) {
  if (isRecord(value)) return true;
  add(errors, "CLOUDIG_V1_INVALID", path, "Must be an object");
  return false;
}

function string(value, path, errors, pattern = null) {
  if (typeof value !== "string" || !value.trim()) {
    add(errors, "CLOUDIG_V1_INVALID", path, "Must be a non-empty string");
    return false;
  }
  if (pattern && !pattern.test(value)) {
    add(errors, "CLOUDIG_V1_INVALID", path, "Has an invalid canonical format");
    return false;
  }
  return true;
}

function utc(value, path, errors) {
  if (!string(value, path, errors, UTC_Z)) return false;
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    add(errors, "CLOUDIG_V1_INVALID", path, "Must be a canonical UTC date-time");
    return false;
  }
  return true;
}

function integer(value, path, errors, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    add(errors, "CLOUDIG_V1_INVALID", path, `Must be a safe integer greater than or equal to ${minimum}`);
    return false;
  }
  return true;
}

function mapLegacyPath(path) {
  return path
    .replace(/^\$\.parser_version/u, "$.generation.parser_version")
    .replace(/^\$\.parser_adapter/u, "$.generation.parser_adapter")
    .replace(/^\$\.parsed_at/u, "$.lifecycle.last_parsed_at")
    .replace(/^\$\.exporter_version/u, "$.generation.exporter_version")
    .replace(/^\$\.conversation_key/u, "$.identity.conversation_key")
    .replace(/^\$\.source_file/u, "$.source.file.name")
    .replace(/^\$\.source_sha256/u, "$.source.file.sha256")
    .replace(/^\$\.source_size_bytes/u, "$.source.file.size_bytes")
    .replace(/^\$\.source_url/u, "$.source.url")
    .replace(/^\$\.created_at/u, "$.source.conversation_created_at")
    .replace(/^\$\.updated_at/u, "$.source.conversation_updated_at");
}

function appendLegacyContentErrors(value, errors) {
  if (!Array.isArray(value.messages)) return;
  const generation = isRecord(value.generation) ? value.generation : {};
  const identity = isRecord(value.identity) ? value.identity : {};
  const lifecycle = isRecord(value.lifecycle) ? value.lifecycle : {};
  const source = isRecord(value.source) ? value.source : {};
  const sourceFile = isRecord(source.file) ? source.file : {};
  const fallbackTime = value.message_time?.start || source.captured_at?.value || lifecycle.last_parsed_at || "2000-01-01T00:00:00.000Z";
  const legacy = {
    schema: CONVERSATION_SCHEMA_BRANCHES_CURRENT,
    parser_version: typeof generation.parser_version === "string" && SEMVER.test(generation.parser_version) ? generation.parser_version : "0.0.0",
    parser_adapter: {
      id: typeof generation.parser_adapter?.id === "string" && SLUG.test(generation.parser_adapter.id) ? generation.parser_adapter.id : "invalid-adapter",
      version: typeof generation.parser_adapter?.version === "string" && SEMVER.test(generation.parser_adapter.version) ? generation.parser_adapter.version : "0.0.0"
    },
    parsed_at: UTC_Z.test(lifecycle.last_parsed_at || "") ? lifecycle.last_parsed_at : "2000-01-01T00:00:00.000Z",
    ...(typeof generation.exporter_version === "string" && generation.exporter_version.trim() ? { exporter_version: generation.exporter_version } : {}),
    conversation_key: typeof identity.conversation_key === "string" && SHA256.test(identity.conversation_key) ? identity.conversation_key : "0".repeat(64),
    source_file: typeof sourceFile.name === "string" && sourceFile.name && !/[\\/]/u.test(sourceFile.name) ? sourceFile.name : "invalid-source",
    source_sha256: typeof sourceFile.sha256 === "string" && SHA256.test(sourceFile.sha256) ? sourceFile.sha256 : "0".repeat(64),
    source_size_bytes: Number.isSafeInteger(sourceFile.size_bytes) && sourceFile.size_bytes > 0 ? sourceFile.size_bytes : 1,
    ...(typeof source.url === "string" ? { source_url: source.url } : {}),
    content_time: UTC_Z.test(fallbackTime) ? fallbackTime : "2000-01-01T00:00:00.000Z",
    ...(typeof source.conversation_created_at === "string" ? { created_at: source.conversation_created_at } : {}),
    ...(typeof source.conversation_updated_at === "string" ? { updated_at: source.conversation_updated_at } : {}),
    title: typeof value.title === "string" && value.title ? value.title : "invalid",
    provider: typeof value.provider === "string" && SLUG.test(value.provider) ? value.provider : "invalid",
    platform: typeof value.platform === "string" && SLUG.test(value.platform) ? value.platform : "invalid",
    ...(Array.isArray(value.models) ? { models: value.models } : {}),
    messages: value.messages,
    ...(Array.isArray(value.resources) ? { resources: value.resources } : {}),
    ...(Array.isArray(value.sources) ? { sources: value.sources } : {}),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings } : {})
  };
  const result = validateLegacyConversation(legacy);
  for (const legacyError of result.errors) {
    const separator = legacyError.indexOf(": ");
    const legacyPath = separator >= 0 ? legacyError.slice(0, separator) : "$";
    const message = separator >= 0 ? legacyError.slice(separator + 2) : legacyError;
    add(errors, "CLOUDIG_V1_CONTENT_INVALID", mapLegacyPath(legacyPath), message);
  }
}

function endpointFromUtc(value) {
  const date = new Date(value);
  return {
    kind: "terran_exact",
    era: "AD",
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    utc_offset: "Z"
  };
}

function validateIdentity(value, errors) {
  if (!record(value, "$.identity", errors)) return;
  allowedFields(value, new Set(["conversation_key", "archive_id"]), "$.identity", errors);
  requireFields(value, ["conversation_key", "archive_id"], "$.identity", errors);
  if (hasOwn(value, "conversation_key")) string(value.conversation_key, "$.identity.conversation_key", errors, SHA256);
  if (hasOwn(value, "archive_id")) string(value.archive_id, "$.identity.archive_id", errors, UUID);
}

function validateGeneration(value, errors) {
  if (!record(value, "$.generation", errors)) return;
  allowedFields(value, new Set(["parser_version", "parser_adapter", "exporter_version"]), "$.generation", errors);
  requireFields(value, ["parser_version", "parser_adapter"], "$.generation", errors);
  if (hasOwn(value, "parser_version")) string(value.parser_version, "$.generation.parser_version", errors, SEMVER);
  if (hasOwn(value, "exporter_version")) string(value.exporter_version, "$.generation.exporter_version", errors);
  if (record(value.parser_adapter, "$.generation.parser_adapter", errors)) {
    allowedFields(value.parser_adapter, new Set(["id", "version"]), "$.generation.parser_adapter", errors);
    requireFields(value.parser_adapter, ["id", "version"], "$.generation.parser_adapter", errors);
    if (hasOwn(value.parser_adapter, "id")) string(value.parser_adapter.id, "$.generation.parser_adapter.id", errors, SLUG);
    if (hasOwn(value.parser_adapter, "version")) string(value.parser_adapter.version, "$.generation.parser_adapter.version", errors, SEMVER);
  }
}

function validateLifecycle(value, errors) {
  if (!record(value, "$.lifecycle", errors)) return;
  allowedFields(value, new Set(["first_parsed_at", "last_parsed_at", "cloudig_edited_at"]), "$.lifecycle", errors);
  requireFields(value, ["first_parsed_at", "last_parsed_at", "cloudig_edited_at"], "$.lifecycle", errors);
  const fact = value.first_parsed_at;
  if (record(fact, "$.lifecycle.first_parsed_at", errors)) {
    allowedFields(fact, new Set(["value", "basis"]), "$.lifecycle.first_parsed_at", errors);
    requireFields(fact, ["basis"], "$.lifecycle.first_parsed_at", errors);
    const bases = new Set(["parser_creation", "legacy_output_birthtime_estimate", "legacy_last_parse_upper_bound", "unavailable"]);
    if (!bases.has(fact.basis)) add(errors, "CLOUDIG_V1_INVALID", "$.lifecycle.first_parsed_at.basis", "Unsupported first-parse evidence basis");
    if (fact.basis === "unavailable" && hasOwn(fact, "value")) add(errors, "CLOUDIG_V1_INVALID", "$.lifecycle.first_parsed_at.value", "Unavailable evidence must not invent a value");
    if (fact.basis !== "unavailable" && !hasOwn(fact, "value")) add(errors, "CLOUDIG_V1_REQUIRED", "$.lifecycle.first_parsed_at", "Evidence basis requires value");
    if (hasOwn(fact, "value")) utc(fact.value, "$.lifecycle.first_parsed_at.value", errors);
  }
  if (hasOwn(value, "last_parsed_at")) utc(value.last_parsed_at, "$.lifecycle.last_parsed_at", errors);
  if (hasOwn(value, "cloudig_edited_at")) utc(value.cloudig_edited_at, "$.lifecycle.cloudig_edited_at", errors);
  if (fact?.basis === "parser_creation" && UTC_Z.test(fact.value || "") && UTC_Z.test(value.last_parsed_at || "") && fact.value > value.last_parsed_at) {
    add(errors, "CLOUDIG_V1_LIFECYCLE_MISMATCH", "$.lifecycle.first_parsed_at.value", "Exact first parse must not be later than last parse");
  }
}

function validateSource(value, errors) {
  if (!record(value, "$.source", errors)) return;
  allowedFields(value, new Set(["file", "url", "captured_at", "conversation_created_at", "conversation_updated_at"]), "$.source", errors);
  requireFields(value, ["file", "captured_at"], "$.source", errors);
  if (record(value.file, "$.source.file", errors)) {
    allowedFields(value.file, new Set(["name", "sha256", "size_bytes"]), "$.source.file", errors);
    requireFields(value.file, ["name", "sha256", "size_bytes"], "$.source.file", errors);
    if (hasOwn(value.file, "name") && string(value.file.name, "$.source.file.name", errors) && /[\\/]/u.test(value.file.name)) add(errors, "CLOUDIG_V1_INVALID", "$.source.file.name", "Must be a basename");
    if (hasOwn(value.file, "sha256")) string(value.file.sha256, "$.source.file.sha256", errors, SHA256);
    if (hasOwn(value.file, "size_bytes")) integer(value.file.size_bytes, "$.source.file.size_bytes", errors, 1);
  }
  if (hasOwn(value, "url") && (!string(value.url, "$.source.url", errors) || !/^https?:\/\//u.test(value.url))) add(errors, "CLOUDIG_V1_INVALID", "$.source.url", "Must be an HTTP(S) URL");
  const captured = value.captured_at;
  if (record(captured, "$.source.captured_at", errors)) {
    allowedFields(captured, new Set(["value", "basis", "field"]), "$.source.captured_at", errors);
    requireFields(captured, ["basis"], "$.source.captured_at", errors);
    const bases = new Set(["bookmark_metadata", "source_metadata", "filesystem_earliest_create_or_modify", "filesystem_modified_time", "unavailable"]);
    if (!bases.has(captured.basis)) add(errors, "CLOUDIG_V1_INVALID", "$.source.captured_at.basis", "Unsupported source-capture evidence basis");
    if (captured.basis === "unavailable" && hasOwn(captured, "value")) add(errors, "CLOUDIG_V1_INVALID", "$.source.captured_at.value", "Unavailable evidence must not invent a value");
    if (captured.basis !== "unavailable" && !hasOwn(captured, "value")) add(errors, "CLOUDIG_V1_REQUIRED", "$.source.captured_at", "Capture basis requires value");
    if (hasOwn(captured, "value")) utc(captured.value, "$.source.captured_at.value", errors);
    if (hasOwn(captured, "field") && string(captured.field, "$.source.captured_at.field", errors) && /[\\/]/u.test(captured.field)) add(errors, "CLOUDIG_V1_INVALID", "$.source.captured_at.field", "Must be a logical field path, not a file path");
  }
  if (hasOwn(value, "conversation_created_at")) utc(value.conversation_created_at, "$.source.conversation_created_at", errors);
  if (hasOwn(value, "conversation_updated_at")) utc(value.conversation_updated_at, "$.source.conversation_updated_at", errors);
}

function validateMessageTime(value, messages, errors) {
  if (!record(value, "$.message_time", errors)) return;
  allowedFields(value, new Set(["start", "end", "timestamped_messages", "total_messages"]), "$.message_time", errors);
  requireFields(value, ["timestamped_messages", "total_messages"], "$.message_time", errors);
  if (hasOwn(value, "start")) utc(value.start, "$.message_time.start", errors);
  if (hasOwn(value, "end")) utc(value.end, "$.message_time.end", errors);
  if (hasOwn(value, "timestamped_messages")) integer(value.timestamped_messages, "$.message_time.timestamped_messages", errors);
  if (hasOwn(value, "total_messages")) integer(value.total_messages, "$.message_time.total_messages", errors, 1);
  const valid = Array.isArray(messages)
    ? messages.map((message) => message?.timestamp).filter((timestamp) => typeof timestamp === "string" && DATE_TIME_WITH_ZONE.test(timestamp) && Number.isFinite(Date.parse(timestamp))).map((timestamp) => new Date(timestamp).toISOString()).sort()
    : [];
  if (value.total_messages !== (Array.isArray(messages) ? messages.length : 0)) add(errors, "CLOUDIG_V1_MESSAGE_TIME_MISMATCH", "$.message_time.total_messages", "Must equal messages.length");
  if (value.timestamped_messages !== valid.length) add(errors, "CLOUDIG_V1_MESSAGE_TIME_MISMATCH", "$.message_time.timestamped_messages", "Must equal the number of valid message timestamps");
  if (valid.length === 0 && (hasOwn(value, "start") || hasOwn(value, "end"))) add(errors, "CLOUDIG_V1_MESSAGE_TIME_MISMATCH", "$.message_time", "Start/end must be absent when no message has a valid timestamp");
  if (valid.length > 0 && (value.start !== valid[0] || value.end !== valid.at(-1))) add(errors, "CLOUDIG_V1_MESSAGE_TIME_MISMATCH", "$.message_time", "Start/end must be the min/max valid message instants");
}

function validateContentTime(value, messageTime, source, errors) {
  if (!record(value, "$.content_time", errors)) return;
  allowedFields(value, new Set(["parser_default", "effective"]), "$.content_time", errors);
  requireFields(value, ["parser_default", "effective"], "$.content_time", errors);
  const parserDefault = value.parser_default;
  if (record(parserDefault, "$.content_time.parser_default", errors)) {
    allowedFields(parserDefault, new Set(["edited_at", "derivation", "range"]), "$.content_time.parser_default", errors);
    requireFields(parserDefault, ["edited_at", "derivation"], "$.content_time.parser_default", errors);
    if (hasOwn(parserDefault, "edited_at")) utc(parserDefault.edited_at, "$.content_time.parser_default.edited_at", errors);
    if (!["message_start", "source_capture_fallback", "unavailable"].includes(parserDefault.derivation)) add(errors, "CLOUDIG_V1_INVALID", "$.content_time.parser_default.derivation", "Unsupported Parser default derivation");
    const unavailable = parserDefault.derivation === "unavailable";
    if (unavailable && hasOwn(parserDefault, "range")) add(errors, "CLOUDIG_V1_CONTENT_TIME_MISMATCH", "$.content_time.parser_default.range", "Unavailable Parser default must not contain a range");
    if (!unavailable && !hasOwn(parserDefault, "range")) add(errors, "CLOUDIG_V1_REQUIRED", "$.content_time.parser_default", "Available Parser default requires range");
    if (hasOwn(parserDefault, "range")) {
      const result = time.validateRange(parserDefault.range, { require_flags: true });
      for (const issue of result.errors) add(errors, issue.code, `$.content_time.parser_default.range${issue.path.slice(1)}`, issue.message, issue.details);
      if (result.valid && (!result.value.is_collapsed || result.value.start.kind === "sovereign")) add(errors, "CLOUDIG_V1_CONTENT_TIME_MISMATCH", "$.content_time.parser_default.range", "Parser default must be one collapsed Terran point");
      const expected = parserDefault.derivation === "message_start" ? messageTime?.start : parserDefault.derivation === "source_capture_fallback" ? source?.captured_at?.value : null;
      if (result.valid && expected && UTC_Z.test(expected) && !time.semanticEndpointEqual(result.value.start, endpointFromUtc(expected))) add(errors, "CLOUDIG_V1_CONTENT_TIME_MISMATCH", "$.content_time.parser_default.range.start", "Parser default does not match its declared derivation value");
    }
    if (parserDefault.derivation === "message_start" && !messageTime?.start) add(errors, "CLOUDIG_V1_CONTENT_TIME_MISMATCH", "$.content_time.parser_default.derivation", "message_start requires message_time.start");
    if (parserDefault.derivation === "source_capture_fallback" && (messageTime?.start || !source?.captured_at?.value)) add(errors, "CLOUDIG_V1_CONTENT_TIME_MISMATCH", "$.content_time.parser_default.derivation", "source fallback requires no message start and one source capture value");
  }
  const effective = value.effective;
  if (record(effective, "$.content_time.effective", errors)) {
    if (effective.source === "parser") {
      allowedFields(effective, new Set(["source"]), "$.content_time.effective", errors);
    } else if (effective.source === "user") {
      allowedFields(effective, new Set(["source", "state", "edit_id", "edited_at", "range"]), "$.content_time.effective", errors);
      requireFields(effective, ["source", "state", "edit_id", "edited_at"], "$.content_time.effective", errors);
      if (hasOwn(effective, "edit_id")) string(effective.edit_id, "$.content_time.effective.edit_id", errors, UUID);
      if (hasOwn(effective, "edited_at")) utc(effective.edited_at, "$.content_time.effective.edited_at", errors);
      if (effective.state === "set") {
        if (!hasOwn(effective, "range")) add(errors, "CLOUDIG_V1_REQUIRED", "$.content_time.effective", "User set requires range");
        else {
          const result = time.validateRange(effective.range, { require_flags: true });
          for (const issue of result.errors) add(errors, issue.code, `$.content_time.effective.range${issue.path.slice(1)}`, issue.message, issue.details);
        }
      } else if (effective.state === "cleared") {
        if (hasOwn(effective, "range")) add(errors, "CLOUDIG_V1_CONTENT_TIME_MISMATCH", "$.content_time.effective.range", "User cleared must not contain range");
      } else add(errors, "CLOUDIG_V1_INVALID", "$.content_time.effective.state", "User state must be set or cleared");
    } else add(errors, "CLOUDIG_V1_INVALID", "$.content_time.effective.source", "Effective source must be parser or user");
  }
}

export function validateConversationV1(value) {
  const errors = [];
  if (!record(value, "$", errors)) return { valid: false, errors };
  allowedFields(value, ROOT_KEYS, "$", errors);
  requireFields(value, ["schema", "identity", "generation", "lifecycle", "source", "message_time", "content_time", "title", "provider", "platform", "messages"], "$", errors);
  if (value.schema !== CONVERSATION_SCHEMA_V1) add(errors, "CLOUDIG_V1_INVALID", "$.schema", `Must equal ${CONVERSATION_SCHEMA_V1}`);
  validateIdentity(value.identity, errors);
  validateGeneration(value.generation, errors);
  validateLifecycle(value.lifecycle, errors);
  validateSource(value.source, errors);
  if (!Array.isArray(value.messages) || value.messages.length === 0) add(errors, "CLOUDIG_V1_INVALID", "$.messages", "Must be a non-empty array");
  validateMessageTime(value.message_time, value.messages, errors);
  validateContentTime(value.content_time, value.message_time, value.source, errors);
  if (hasOwn(value, "title")) string(value.title, "$.title", errors);
  if (hasOwn(value, "provider")) string(value.provider, "$.provider", errors, SLUG);
  if (hasOwn(value, "platform")) string(value.platform, "$.platform", errors, SLUG);
  appendLegacyContentErrors(value, errors);
  errors.sort((left, right) => left.path.localeCompare(right.path, "en") || left.code.localeCompare(right.code, "en") || left.message.localeCompare(right.message, "en"));
  return { valid: errors.length === 0, errors: errors.slice(0, MAX_ERRORS) };
}
