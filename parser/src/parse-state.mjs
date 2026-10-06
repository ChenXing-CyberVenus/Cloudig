import { readFile } from "node:fs/promises";

import { atomicWriteText } from "./atomic.mjs";
import { isSemanticVersion } from "./semver.mjs";
import {
  PARSE_STATE_V1_VERSION,
  normalizeParseStateV1,
  parseStateV1SourceMap,
  serializeParseStateV1,
  setParseStateV1Source
} from "./parse-state-v1.mjs";

export const PARSE_STATE_FORMAT = "cloudig/parse-state";
export const PARSE_STATE_VERSION = "0.2.1";
const LEGACY_PARSE_STATE_VERSIONS = new Set(["0.1.0", "0.1.1", "0.1.2", "0.2.0"]);

const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ERROR_KINDS = new Set(["interrupted", "environment", "source", "internal"]);
const STATUSES = new Set([
  "pending", "parsing", "success", "failed", "unsupported", "cancelled", "source_missing"
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeRelativePath(value, label) {
  const text = cleanString(value).replaceAll("\\", "/");
  const segments = text.split("/");
  if (!text || text.startsWith("/") || /^[a-z]:/iu.test(text) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`${label} must be a safe relative path`);
  }
  return text;
}

function isoTime(value, label) {
  const text = cleanString(value);
  if (!text || !Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO date-time`);
  return new Date(text).toISOString();
}

function optionalIsoTime(value, label) {
  return value === undefined ? undefined : isoTime(value, label);
}

function normalizeAdapter(value, label) {
  if (!isRecord(value) || !ID.test(cleanString(value.id)) || !isSemanticVersion(cleanString(value.version))) {
    throw new TypeError(`${label} must contain a stable id and semantic version`);
  }
  const output = { id: cleanString(value.id), version: cleanString(value.version) };
  if (cleanString(value.format)) output.format = cleanString(value.format);
  return output;
}

function normalizeOutput(value, index) {
  if (!isRecord(value)) throw new TypeError(`outputs[${index}] must be an object`);
  const conversationKey = cleanString(value.conversation_key || value.conversation_id).toLowerCase();
  if (value.conversation_key !== undefined && value.conversation_id !== undefined
    && cleanString(value.conversation_key).toLowerCase() !== cleanString(value.conversation_id).toLowerCase()) {
    throw new TypeError(`outputs[${index}] contains conflicting conversation_key and conversation_id values`);
  }
  const sha256 = cleanString(value.sha256).toLowerCase();
  if (!SHA256.test(conversationKey)) throw new TypeError(`outputs[${index}].conversation_key must be a lowercase SHA-256 identity`);
  if (!SHA256.test(sha256)) throw new TypeError(`outputs[${index}].sha256 must be a lowercase SHA-256`);
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1) throw new TypeError(`outputs[${index}].size_bytes must be positive`);
  const output = {
    conversation_key: conversationKey,
    path: safeRelativePath(value.path, `outputs[${index}].path`),
    size_bytes: value.size_bytes,
    modified_at: isoTime(value.modified_at, `outputs[${index}].modified_at`),
    sha256
  };
  const schema = cleanString(value.schema);
  if (schema) {
    if (schema.length > 160 || /[\u0000-\u001f]/u.test(schema)) {
      throw new TypeError(`outputs[${index}].schema must be a readable format identifier`);
    }
    output.schema = schema;
  }
  if (value.schema_invalid !== undefined && typeof value.schema_invalid !== "boolean") {
    throw new TypeError(`outputs[${index}].schema_invalid must be a boolean`);
  }
  if (value.schema_invalid === true) output.schema_invalid = true;
  const generatedParserVersion = cleanString(value.parser_version);
  if (generatedParserVersion) {
    if (!isSemanticVersion(generatedParserVersion)) {
      throw new TypeError(`outputs[${index}].parser_version must be semantic version`);
    }
    output.parser_version = generatedParserVersion;
  }
  if (value.parser_version_invalid !== undefined && typeof value.parser_version_invalid !== "boolean") {
    throw new TypeError(`outputs[${index}].parser_version_invalid must be a boolean`);
  }
  if (value.parser_version_invalid === true) output.parser_version_invalid = true;
  if (value.parser_adapter !== undefined) output.parser_adapter = normalizeAdapter(value.parser_adapter, `outputs[${index}].parser_adapter`);
  const exporterVersion = typeof value.exporter_version === "string" ? value.exporter_version : "";
  if (value.exporter_version !== undefined && !exporterVersion.trim()) {
    throw new TypeError(`outputs[${index}].exporter_version must contain a non-whitespace character`);
  }
  if (exporterVersion) {
    if (exporterVersion.length > 128 || /[\u0000-\u001f]/u.test(exporterVersion)) {
      throw new TypeError(`outputs[${index}].exporter_version must be a readable version`);
    }
    output.exporter_version = exporterVersion;
  }
  return output;
}

function normalizeError(value) {
  if (!isRecord(value) || !ID.test(cleanString(value.code)) || !cleanString(value.message)) {
    throw new TypeError("error must contain a safe code and readable message");
  }
  const output = { code: cleanString(value.code), message: cleanString(value.message).slice(0, 1000) };
  const kind = cleanString(value.kind);
  if (kind) {
    if (!ERROR_KINDS.has(kind)) throw new TypeError("error.kind must be interrupted, environment, source or internal");
    output.kind = kind;
  }
  const supportKey = cleanString(value.support_key).toLowerCase();
  if (supportKey) {
    if (!SHA256.test(supportKey)) throw new TypeError("error.support_key must be a lowercase SHA-256");
    output.support_key = supportKey;
  }
  if (value.source_failures !== undefined) {
    if (!Number.isSafeInteger(value.source_failures) || value.source_failures < 1 || value.source_failures > 2) {
      throw new TypeError("error.source_failures must be 1 or 2");
    }
    output.source_failures = value.source_failures;
  }
  return output;
}

export function normalizeSourceState(value) {
  if (!isRecord(value)) throw new TypeError("Parse-state source must be an object");
  if (!Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0) throw new TypeError("size_bytes must be non-negative");
  if (!STATUSES.has(value.status)) throw new TypeError(`Unsupported parse status: ${value.status}`);
  const output = {
    path: safeRelativePath(value.path, "source.path"),
    size_bytes: value.size_bytes,
    modified_at: isoTime(value.modified_at, "source.modified_at")
  };
  const sourceCreatedAt = optionalIsoTime(value.source_created_at, "source.source_created_at");
  if (sourceCreatedAt) output.source_created_at = sourceCreatedAt;
  const sha256 = cleanString(value.sha256).toLowerCase();
  if (sha256) {
    if (!SHA256.test(sha256)) throw new TypeError("source.sha256 must be a lowercase SHA-256");
    output.sha256 = sha256;
  }
  const sourceKey = cleanString(value.source_key || sha256).toLowerCase();
  if (sourceKey) {
    if (!SHA256.test(sourceKey)) throw new TypeError("source.source_key must be a lowercase SHA-256 identity");
    output.source_key = sourceKey;
  }
  if (value.adapter !== undefined) output.adapter = normalizeAdapter(value.adapter, "source.adapter");
  if (value.source_adapter !== undefined) output.source_adapter = normalizeAdapter(value.source_adapter, "source.source_adapter");
  const parserVersion = cleanString(value.parser_version);
  if (value.parser_version !== undefined) {
    if (!isSemanticVersion(parserVersion)) throw new TypeError("source.parser_version must be semantic version");
    output.parser_version = parserVersion;
  }
  output.status = value.status;
  const lastAttemptAt = optionalIsoTime(value.last_attempt_at, "source.last_attempt_at");
  const lastSuccessAt = optionalIsoTime(value.last_success_at, "source.last_success_at");
  if (lastAttemptAt) output.last_attempt_at = lastAttemptAt;
  if (lastSuccessAt) output.last_success_at = lastSuccessAt;
  if (value.outputs !== undefined) {
    if (!Array.isArray(value.outputs)) throw new TypeError("source.outputs must be an array");
    output.outputs = value.outputs
      .map((item, index) => normalizeOutput(item, index))
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    const paths = new Set();
    for (const item of output.outputs) {
      if (paths.has(item.path)) throw new TypeError(`Duplicate parse-state output path: ${item.path}`);
      paths.add(item.path);
    }
  }
  if (value.error !== undefined) output.error = normalizeError(value.error);
  if (value.dismissed !== undefined && typeof value.dismissed !== "boolean") {
    throw new TypeError("source.dismissed must be a boolean");
  }
  if (value.dismissed === true) output.dismissed = true;
  return output;
}

export function createParseState() {
  return { format: PARSE_STATE_FORMAT, version: PARSE_STATE_VERSION, sources: [] };
}

export function normalizeParseState(value) {
  if (!isRecord(value)) throw new TypeError("Parse state must be an object");
  if (value.format !== PARSE_STATE_FORMAT) throw new TypeError(`Parse-state format must be ${PARSE_STATE_FORMAT}`);
  if (value.version === PARSE_STATE_V1_VERSION) return normalizeParseStateV1(value);
  if (!LEGACY_PARSE_STATE_VERSIONS.has(value.version) && value.version !== PARSE_STATE_VERSION) {
    throw new TypeError(`Unsupported parse-state version: ${value.version}`);
  }
  if (!Array.isArray(value.sources)) throw new TypeError("Parse-state sources must be an array");
  const sources = value.sources.map(normalizeSourceState).sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
  const paths = new Set();
  for (const source of sources) {
    if (paths.has(source.path)) throw new TypeError(`Duplicate parse-state source path: ${source.path}`);
    paths.add(source.path);
  }
  return { format: PARSE_STATE_FORMAT, version: PARSE_STATE_VERSION, sources };
}

export function serializeParseState(value) {
  if (value?.version === PARSE_STATE_V1_VERSION) return serializeParseStateV1(value);
  return `${JSON.stringify(normalizeParseState(value), null, 2)}\n`;
}

export async function loadParseState(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    const normalized = normalizeParseState(raw);
    if (raw.version !== PARSE_STATE_VERSION && raw.version !== PARSE_STATE_V1_VERSION) {
      await atomicWriteText(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    }
    return normalized;
  } catch (error) {
    if (error?.code === "ENOENT") return createParseState();
    throw new Error(`Cannot read parse-state.json: ${error.message}`, { cause: error });
  }
}

export async function saveParseState(filePath, state) {
  return atomicWriteText(filePath, serializeParseState(state));
}

export function sourceStateMap(state) {
  if (state?.version === PARSE_STATE_V1_VERSION) return parseStateV1SourceMap(state);
  return new Map(normalizeParseState(state).sources.map((source) => [source.path, source]));
}

export function setSourceState(state, source) {
  if (state?.version === PARSE_STATE_V1_VERSION) return setParseStateV1Source(state, source);
  const normalizedState = normalizeParseState(state);
  const normalizedSource = normalizeSourceState(source);
  const map = new Map(normalizedState.sources.map((item) => [item.path, item]));
  map.set(normalizedSource.path, normalizedSource);
  return normalizeParseState({ ...normalizedState, sources: [...map.values()] });
}

export function replaceSourceState(state, previousPath, source) {
  if (state?.version === PARSE_STATE_V1_VERSION) {
    const normalizedState = normalizeParseStateV1(state);
    const oldPath = safeRelativePath(previousPath, "previous source path");
    const map = parseStateV1SourceMap(normalizedState);
    if (!map.has(oldPath)) throw new Error(`Cannot replace an unregistered parse-state source: ${oldPath}`);
    if (source.path !== oldPath && map.has(source.path)) throw new Error(`Cannot move a parse-state source onto an existing path: ${source.path}`);
    map.delete(oldPath);
    return normalizeParseStateV1({ ...normalizedState, sources: [...map.values(), source] });
  }
  const normalizedState = normalizeParseState(state);
  const oldPath = safeRelativePath(previousPath, "previous source path");
  const normalizedSource = normalizeSourceState(source);
  const map = new Map(normalizedState.sources.map((item) => [item.path, item]));
  if (!map.has(oldPath)) throw new Error(`Cannot replace an unregistered parse-state source: ${oldPath}`);
  if (normalizedSource.path !== oldPath && map.has(normalizedSource.path)) {
    throw new Error(`Cannot move a parse-state source onto an existing path: ${normalizedSource.path}`);
  }
  map.delete(oldPath);
  map.set(normalizedSource.path, normalizedSource);
  return normalizeParseState({ ...normalizedState, sources: [...map.values()] });
}
