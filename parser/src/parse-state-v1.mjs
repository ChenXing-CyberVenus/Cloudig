import { readFile } from "node:fs/promises";

import { isSemanticVersion } from "./semver.mjs";

export const PARSE_STATE_V1_FORMAT = "cloudig/parse-state";
export const PARSE_STATE_V1_VERSION = "1.0.0";

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const STATUSES = new Set(["pending", "parsing", "success", "failed", "unsupported", "cancelled", "source_missing"]);
const ERROR_KINDS = new Set(["interrupted", "environment", "source", "internal"]);
const CAPTURE_BASES = new Set(["bookmark_metadata", "source_metadata", "filesystem_earliest_create_or_modify", "filesystem_modified_time", "unavailable"]);
const FIRST_PARSE_BASES = new Set(["parser_creation", "legacy_output_birthtime_estimate", "legacy_last_parse_upper_bound", "unavailable"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeRelative(value, prefix, label) {
  const text = clean(value).replaceAll("\\", "/");
  const segments = text.split("/");
  if (!text.startsWith(`${prefix}/`) || segments.some((segment) => !segment || segment === "." || segment === "..") || /^[a-z]:/iu.test(text)) {
    throw new TypeError(`${label} must be a safe ${prefix} relative path`);
  }
  return text;
}

function utc(value, label) {
  const text = clean(value);
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds)) throw new TypeError(`${label} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function optionalUtc(value, label) {
  return value === undefined ? undefined : utc(value, label);
}

function normalizeAdapter(value, label) {
  if (!isRecord(value) || !ID.test(clean(value.id)) || !isSemanticVersion(clean(value.version))) {
    throw new TypeError(`${label} must contain a stable id and semantic version`);
  }
  const result = { id: clean(value.id), version: clean(value.version) };
  if (clean(value.format)) result.format = clean(value.format);
  return result;
}

function normalizeEvidence(value, bases, label, { allowField = false } = {}) {
  if (!isRecord(value) || !bases.has(value.basis)) throw new TypeError(`${label}.basis is unsupported`);
  if (value.basis === "unavailable") {
    if (value.value !== undefined || value.field !== undefined) throw new TypeError(`${label} unavailable evidence cannot contain value or field`);
    return { basis: "unavailable" };
  }
  const result = { value: utc(value.value, `${label}.value`), basis: value.basis };
  if (value.field !== undefined) {
    if (!allowField || !clean(value.field) || clean(value.field).length > 200) throw new TypeError(`${label}.field is invalid`);
    result.field = clean(value.field);
  }
  return result;
}

function normalizeError(value) {
  if (!isRecord(value) || !ID.test(clean(value.code)) || !clean(value.message)) throw new TypeError("error must contain code and message");
  const result = { code: clean(value.code), message: clean(value.message).slice(0, 1000) };
  if (value.kind !== undefined) {
    if (!ERROR_KINDS.has(value.kind)) throw new TypeError("error.kind is unsupported");
    result.kind = value.kind;
  }
  if (value.support_key !== undefined) {
    const supportKey = clean(value.support_key).toLowerCase();
    if (!SHA256.test(supportKey)) throw new TypeError("error.support_key must be a SHA-256");
    result.support_key = supportKey;
  }
  if (value.source_failures !== undefined) {
    if (!Number.isSafeInteger(value.source_failures) || value.source_failures < 1 || value.source_failures > 2) throw new TypeError("error.source_failures must be 1 or 2");
    result.source_failures = value.source_failures;
  }
  return result;
}

export function normalizeParseStateV1Output(value, index = 0) {
  if (!isRecord(value)) throw new TypeError(`outputs[${index}] must be an object`);
  const conversationKey = clean(value.conversation_key).toLowerCase();
  const archiveId = clean(value.archive_id).toLowerCase();
  const sha256 = clean(value.sha256).toLowerCase();
  if (!SHA256.test(conversationKey)) throw new TypeError(`outputs[${index}].conversation_key must be a SHA-256`);
  if (!UUID.test(archiveId)) throw new TypeError(`outputs[${index}].archive_id must be a UUID`);
  if (!["current", "historical"].includes(value.role)) throw new TypeError(`outputs[${index}].role must be current or historical`);
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1) throw new TypeError(`outputs[${index}].size_bytes must be positive`);
  if (!SHA256.test(sha256)) throw new TypeError(`outputs[${index}].sha256 must be a SHA-256`);
  if (value.schema !== "ai-chat-archive/conversation/1.0.0") throw new TypeError(`outputs[${index}].schema must be conversation 1.0.0`);
  if (!isSemanticVersion(clean(value.parser_version))) throw new TypeError(`outputs[${index}].parser_version must be semantic`);
  const result = {
    conversation_key: conversationKey,
    archive_id: archiveId,
    role: value.role,
    path: safeRelative(value.path, "Conversations", `outputs[${index}].path`),
    size_bytes: value.size_bytes,
    modified_at: utc(value.modified_at, `outputs[${index}].modified_at`),
    sha256,
    schema: value.schema,
    parser_version: clean(value.parser_version),
    parser_adapter: normalizeAdapter(value.parser_adapter, `outputs[${index}].parser_adapter`),
    first_parsed_at: normalizeEvidence(value.first_parsed_at, FIRST_PARSE_BASES, `outputs[${index}].first_parsed_at`),
    last_parsed_at: utc(value.last_parsed_at, `outputs[${index}].last_parsed_at`)
  };
  if (value.exporter_version !== undefined) {
    const exporterVersion = String(value.exporter_version);
    if (!exporterVersion.trim() || exporterVersion.length > 128 || /[\u0000-\u001f]/u.test(exporterVersion)) throw new TypeError(`outputs[${index}].exporter_version is invalid`);
    result.exporter_version = exporterVersion;
  }
  return result;
}

export function normalizeParseStateV1Source(value, index = 0) {
  if (!isRecord(value)) throw new TypeError(`sources[${index}] must be an object`);
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0) throw new TypeError(`sources[${index}].size_bytes must be non-negative`);
  if (!STATUSES.has(value.status)) throw new TypeError(`sources[${index}].status is unsupported`);
  const result = {
    path: safeRelative(value.path, "Inbox", `sources[${index}].path`),
    size_bytes: value.size_bytes,
    modified_at: utc(value.modified_at, `sources[${index}].modified_at`),
    captured_at: normalizeEvidence(value.captured_at, CAPTURE_BASES, `sources[${index}].captured_at`, { allowField: true })
  };
  for (const key of ["sha256", "source_key"]) {
    if (value[key] === undefined) continue;
    const normalized = clean(value[key]).toLowerCase();
    if (!SHA256.test(normalized)) throw new TypeError(`sources[${index}].${key} must be a SHA-256`);
    result[key] = normalized;
  }
  if (value.adapter !== undefined) result.adapter = normalizeAdapter(value.adapter, `sources[${index}].adapter`);
  if (value.source_adapter !== undefined) result.source_adapter = normalizeAdapter(value.source_adapter, `sources[${index}].source_adapter`);
  if (value.parser_version !== undefined) {
    if (!isSemanticVersion(clean(value.parser_version))) throw new TypeError(`sources[${index}].parser_version must be semantic`);
    result.parser_version = clean(value.parser_version);
  }
  result.status = value.status;
  for (const key of ["last_attempt_at", "last_success_at"]) {
    const normalized = optionalUtc(value[key], `sources[${index}].${key}`);
    if (normalized) result[key] = normalized;
  }
  if (value.outputs !== undefined) {
    if (!Array.isArray(value.outputs)) throw new TypeError(`sources[${index}].outputs must be an array`);
    result.outputs = value.outputs.map(normalizeParseStateV1Output)
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    const paths = new Set();
    const archives = new Set();
    const currentKeys = new Set();
    for (const output of result.outputs) {
      if (paths.has(output.path)) throw new TypeError(`Duplicate output path: ${output.path}`);
      if (archives.has(output.archive_id)) throw new TypeError(`Duplicate archive_id: ${output.archive_id}`);
      if (output.role === "current" && currentKeys.has(output.conversation_key)) throw new TypeError(`Multiple current outputs for conversation_key: ${output.conversation_key}`);
      paths.add(output.path);
      archives.add(output.archive_id);
      if (output.role === "current") currentKeys.add(output.conversation_key);
    }
  }
  if (value.error !== undefined) result.error = normalizeError(value.error);
  if (value.dismissed !== undefined) {
    if (typeof value.dismissed !== "boolean") throw new TypeError(`sources[${index}].dismissed must be boolean`);
    if (value.dismissed === true) result.dismissed = true;
  }
  return result;
}

export function createParseStateV1() {
  return { format: PARSE_STATE_V1_FORMAT, version: PARSE_STATE_V1_VERSION, sources: [] };
}

export function normalizeParseStateV1(value) {
  if (!isRecord(value) || value.format !== PARSE_STATE_V1_FORMAT || value.version !== PARSE_STATE_V1_VERSION || !Array.isArray(value.sources)) {
    throw new TypeError("Parse state must be cloudig/parse-state 1.0.0");
  }
  const sources = value.sources.map(normalizeParseStateV1Source)
    .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
  const paths = new Set();
  const outputPaths = new Set();
  const archiveIds = new Set();
  const currentConversationKeys = new Set();
  for (const source of sources) {
    if (paths.has(source.path)) throw new TypeError(`Duplicate source path: ${source.path}`);
    paths.add(source.path);
    for (const output of source.outputs || []) {
      if (outputPaths.has(output.path)) throw new TypeError(`Parse state assigns output path more than once: ${output.path}`);
      if (archiveIds.has(output.archive_id)) throw new TypeError(`Parse state assigns archive_id more than once: ${output.archive_id}`);
      if (output.role === "current" && currentConversationKeys.has(output.conversation_key)) {
        throw new TypeError(`Parse state assigns more than one current artifact for conversation_key: ${output.conversation_key}`);
      }
      outputPaths.add(output.path);
      archiveIds.add(output.archive_id);
      if (output.role === "current") currentConversationKeys.add(output.conversation_key);
    }
  }
  return { format: PARSE_STATE_V1_FORMAT, version: PARSE_STATE_V1_VERSION, sources };
}

export function serializeParseStateV1(value) {
  return `${JSON.stringify(normalizeParseStateV1(value), null, 2)}\n`;
}

export async function readParseStateDocument(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    if (raw?.format !== PARSE_STATE_V1_FORMAT || typeof raw.version !== "string") throw new TypeError("Unknown parse-state document");
    return raw.version === PARSE_STATE_V1_VERSION
      ? { generation: "v1", document: normalizeParseStateV1(raw) }
      : { generation: "legacy", document: clone(raw) };
  } catch (error) {
    if (error?.code === "ENOENT") return { generation: "missing", document: null };
    throw error;
  }
}

export function parseStateV1SourceMap(value) {
  return new Map(normalizeParseStateV1(value).sources.map((source) => [source.path, source]));
}

export function setParseStateV1Source(value, source) {
  const state = normalizeParseStateV1(value);
  const normalized = normalizeParseStateV1Source(source);
  const map = new Map(state.sources.map((item) => [item.path, item]));
  map.set(normalized.path, normalized);
  return normalizeParseStateV1({ ...state, sources: [...map.values()] });
}
