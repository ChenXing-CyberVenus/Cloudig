import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { atomicWriteText } from "../../parser/src/atomic.mjs";
import { serializeLibraryV1 } from "../../library/v1.mjs";
import { applyConversationOverlay } from "../../library/compat.mjs";

const require = createRequire(import.meta.url);
const libraryCore = require("../../library/core.js");
const readerCore = require("../../reader/src/core.js");

export const ARCHIVE_DIRECTORY = ".Cloudig-Archive";
export const CONVERSATION_CATALOG_FORMAT = "cloudig/conversation-catalog";
export const CONVERSATION_CATALOG_VERSION = "1.0.0";
export const CONVERSATION_CATALOG_FILE = "conversation-catalog.json";
export const CONTENT_TIME_REFERENCE_INDEX_FORMAT = "cloudig/content-time-reference-index";
export const CONTENT_TIME_REFERENCE_INDEX_VERSION = "1.0.0";
export const CONTENT_TIME_REFERENCE_INDEX_FILE = "content-time-reference-index.json";

const CATALOG_ENTRY_KEYS = new Set([
  "relative_path", "size_bytes", "modified_at", "file_created_at", "sha256",
  "conversation_key", "archive_id", "artifact_role", "title", "provider", "platform", "models", "content_time",
  "content_time_source", "content_time_state", "content_time_label_zh", "content_time_label_en",
  "content_time_binding_ids", "content_time_snapshot_sha256", "content_time_sort_descriptor",
  "first_parsed_at", "last_parsed_at", "cloudig_edited_at", "source_captured_at", "source_file",
  "message_start", "message_end", "messages", "parser_version", "parser_adapter",
  "exporter_version", "schema", "compatibility", "error_code", "error"
]);
const FIRST_PARSE_BASES = new Set(["parser_creation", "legacy_output_birthtime_estimate", "legacy_last_parse_upper_bound", "unavailable"]);
const SOURCE_CAPTURE_BASES = new Set(["bookmark_metadata", "source_metadata", "filesystem_earliest_create_or_modify", "filesystem_modified_time", "legacy_exported_at", "legacy_source_time", "unavailable"]);

function normalizedRelative(value) {
  return String(value || "").trim().replaceAll("\\", "/");
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function directoryFromRelative(relative) {
  return normalizedRelative(relative).split("/").slice(1, -1).join("/");
}

function fileNameFromRelative(relative) {
  return normalizedRelative(relative).split("/").at(-1) || "conversation.json";
}

function isArchivedRelative(relative) {
  return normalizedRelative(relative).split("/")[1] === ARCHIVE_DIRECTORY;
}

function assertCatalogRelative(value) {
  const relative = normalizedRelative(value);
  const segments = relative.split("/");
  if (segments[0] !== "Conversations" || segments.length < 2 || !segments.at(-1).toLowerCase().endsWith(".json")) {
    throw new TypeError(`Conversation catalog path is invalid: ${value}`);
  }
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/u.test(segment))) {
    throw new TypeError(`Conversation catalog path is unsafe: ${value}`);
  }
  return relative;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validIsoTime(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function normalizeModels(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function normalizeParserAdapter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = String(value.id || "").trim();
  const version = String(value.version || "").trim();
  return id && version ? { id, version } : null;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeTimeFact(value, allowedBases, pathName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${pathName} must be an object`);
  const basis = String(value.basis || "");
  if (!allowedBases.has(basis)) throw new TypeError(`${pathName}.basis is invalid`);
  const result = { basis };
  if (value.value !== undefined) {
    if (!validIsoTime(value.value)) throw new TypeError(`${pathName}.value is invalid`);
    result.value = new Date(value.value).toISOString();
  }
  if (basis !== "unavailable" && !result.value) throw new TypeError(`${pathName}.value is required`);
  if (basis === "unavailable" && result.value) throw new TypeError(`${pathName}.value must be absent when unavailable`);
  if (value.field !== undefined) result.field = String(value.field || "").slice(0, 200);
  return result;
}

function normalizeSortDescriptor(value, relativePath) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !new Set(["terran_ordered", "special_independent", "sovereign_unmapped", "unset_or_invalid"]).has(value.domain)) {
    throw new TypeError(`Conversation catalog content-time descriptor is invalid: ${relativePath}`);
  }
  return cloneJson(value);
}

function optionalIsoTime(value, pathName) {
  const text = String(value || "");
  if (text && !validIsoTime(text)) throw new TypeError(`${pathName} is invalid`);
  return text ? new Date(text).toISOString() : "";
}

function normalizeCatalogEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Conversation catalog entry must be an object");
  for (const key of Object.keys(value)) {
    if (!CATALOG_ENTRY_KEYS.has(key)) throw new TypeError(`Conversation catalog entry contains an unknown field: ${key}`);
  }
  for (const key of CATALOG_ENTRY_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`Conversation catalog entry is missing field: ${key}`);
  }
  const relativePath = assertCatalogRelative(value.relative_path);
  const sizeBytes = Number(value.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TypeError(`Conversation catalog size is invalid: ${relativePath}`);
  if (!validIsoTime(value.modified_at)) throw new TypeError(`Conversation catalog modified_at is invalid: ${relativePath}`);
  if (!validIsoTime(value.file_created_at)) throw new TypeError(`Conversation catalog file_created_at is invalid: ${relativePath}`);
  const digest = String(value.sha256 || "");
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError(`Conversation catalog SHA-256 is invalid: ${relativePath}`);
  const compatibility = String(value.compatibility || "");
  if (!new Set(["supported", "unsupported", "invalid"]).has(compatibility)) {
    throw new TypeError(`Conversation catalog compatibility is invalid: ${relativePath}`);
  }
  const messages = Number(value.messages || 0);
  if (!Number.isSafeInteger(messages) || messages < 0) throw new TypeError(`Conversation catalog message count is invalid: ${relativePath}`);
  const errorCode = String(value.error_code || "");
  if (!new Set(["", "invalid_json", "invalid_conversation"]).has(errorCode)) {
    throw new TypeError(`Conversation catalog error code is invalid: ${relativePath}`);
  }
  if (!new Set(["", "parser", "user"]).has(String(value.content_time_source || ""))) throw new TypeError(`Conversation catalog content_time_source is invalid: ${relativePath}`);
  if (!new Set(["", "parser", "set", "cleared", "unavailable"]).has(String(value.content_time_state || ""))) throw new TypeError(`Conversation catalog content_time_state is invalid: ${relativePath}`);
  if (Array.isArray(value.content_time_binding_ids) && value.content_time_binding_ids.some((item) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(String(item)))) throw new TypeError(`Conversation catalog binding identity is invalid: ${relativePath}`);
  if (Array.isArray(value.content_time_snapshot_sha256) && value.content_time_snapshot_sha256.some((item) => !/^[0-9a-f]{64}$/u.test(String(item)))) throw new TypeError(`Conversation catalog snapshot digest is invalid: ${relativePath}`);
  if (!new Set(["current", "historical"]).has(String(value.artifact_role || ""))) throw new TypeError(`Conversation catalog artifact role is invalid: ${relativePath}`);
  const entry = {
    relative_path: relativePath,
    size_bytes: sizeBytes,
    modified_at: value.modified_at,
    file_created_at: value.file_created_at,
    sha256: digest,
    conversation_key: String(value.conversation_key || ""),
    archive_id: String(value.archive_id || ""),
    artifact_role: value.artifact_role,
    title: String(value.title || ""),
    provider: String(value.provider || ""),
    platform: String(value.platform || ""),
    models: normalizeModels(value.models),
    content_time: cloneJson(value.content_time ?? ""),
    content_time_source: String(value.content_time_source || ""),
    content_time_state: String(value.content_time_state || ""),
    content_time_label_zh: String(value.content_time_label_zh || ""),
    content_time_label_en: String(value.content_time_label_en || ""),
    content_time_binding_ids: Array.isArray(value.content_time_binding_ids) ? value.content_time_binding_ids.map(String) : [],
    content_time_snapshot_sha256: Array.isArray(value.content_time_snapshot_sha256) ? value.content_time_snapshot_sha256.map(String) : [],
    content_time_sort_descriptor: normalizeSortDescriptor(value.content_time_sort_descriptor ?? null, relativePath),
    first_parsed_at: normalizeTimeFact(value.first_parsed_at || { basis: "unavailable" }, FIRST_PARSE_BASES, `Conversation catalog first_parsed_at: ${relativePath}`),
    last_parsed_at: optionalIsoTime(value.last_parsed_at, `Conversation catalog last_parsed_at: ${relativePath}`),
    cloudig_edited_at: optionalIsoTime(value.cloudig_edited_at, `Conversation catalog cloudig_edited_at: ${relativePath}`),
    source_captured_at: normalizeTimeFact(value.source_captured_at || { basis: "unavailable" }, SOURCE_CAPTURE_BASES, `Conversation catalog source_captured_at: ${relativePath}`),
    source_file: String(value.source_file || ""),
    message_start: String(value.message_start || ""),
    message_end: String(value.message_end || ""),
    messages,
    parser_version: String(value.parser_version || ""),
    parser_adapter: normalizeParserAdapter(value.parser_adapter),
    exporter_version: String(value.exporter_version || ""),
    schema: String(value.schema || ""),
    compatibility,
    error_code: errorCode,
    error: String(value.error || "").split(/\r?\n/u)[0].slice(0, 500)
  };
  return entry;
}

function normalizeCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== CONVERSATION_CATALOG_FORMAT
    || value.version !== CONVERSATION_CATALOG_VERSION
    || !/^[0-9a-f]{64}$/u.test(String(value.source_revision || ""))
    || !Array.isArray(value.entries)) {
    throw new TypeError("Unsupported or incomplete Cloudig conversation catalog");
  }
  const paths = new Set();
  const entries = value.entries.map((entry) => {
    const normalized = normalizeCatalogEntry(entry);
    const folded = normalized.relative_path.toLocaleLowerCase("en-US");
    if (paths.has(folded)) throw new TypeError(`Duplicate conversation catalog path: ${normalized.relative_path}`);
    paths.add(folded);
    return normalized;
  });
  const sorted = [...entries].sort((left, right) => compareOrdinal(left.relative_path, right.relative_path));
  if (sorted.some((entry, index) => entry.relative_path !== entries[index].relative_path)) {
    throw new TypeError("Conversation catalog entries are not deterministically sorted");
  }
  return { format: CONVERSATION_CATALOG_FORMAT, version: CONVERSATION_CATALOG_VERSION, source_revision: value.source_revision, entries };
}

function serializeCatalog(value) {
  return `${JSON.stringify(normalizeCatalog(value), null, 2)}\n`;
}

function libraryReferenceSource(libraryValue) {
  const library = libraryValue && typeof libraryValue === "object" && !Array.isArray(libraryValue) ? libraryValue : null;
  if (library?.format === "cloudig/library" && library.version === "1.0.0") {
    return {
      sha256: sha256(serializeLibraryV1(library)),
      revision: Number(library.content_time_system?.revision) || 0,
      system: library.content_time_system || null
    };
  }
  const serialized = library ? libraryCore.serializeLibrary(library) : "{}\n";
  return { sha256: sha256(serialized), revision: 0, system: null };
}

function timelineIdForNode(system, nodeId) {
  const node = system?.sovereign?.nodes?.[nodeId];
  if (!node) return "";
  return node.kind === "timeline" ? nodeId : String(node.owner_timeline_id || "");
}

export function buildContentTimeReferenceIndex(catalogValue, libraryValue = null) {
  const catalog = normalizeCatalog(catalogValue);
  const observed = new Map();
  for (const entry of catalog.entries) {
    if (!entry.conversation_key || entry.compatibility === "invalid") continue;
    const positions = new Map();
    for (const position of ["start", "end"]) {
      const endpoint = entry.content_time && typeof entry.content_time === "object" ? entry.content_time[position] : null;
      if (endpoint?.kind === "sovereign" && endpoint.binding_id) {
        if (!positions.has(endpoint.binding_id)) positions.set(endpoint.binding_id, []);
        positions.get(endpoint.binding_id).push(position);
      }
    }
    for (const bindingId of entry.content_time_binding_ids) {
      if (!positions.has(bindingId)) positions.set(bindingId, ["unknown"]);
    }
    for (const [binding_id, valuePositions] of positions) {
      if (!observed.has(binding_id)) observed.set(binding_id, []);
      observed.get(binding_id).push({
        binding_id,
        conversation_key: entry.conversation_key,
        archive_id: entry.archive_id,
        relative_path: entry.relative_path,
        positions: [...new Set(valuePositions)].sort(),
        snapshot_sha256: [...entry.content_time_snapshot_sha256]
      });
    }
  }
  for (const artifacts of observed.values()) artifacts.sort((left, right) => compareOrdinal(left.conversation_key, right.conversation_key)
    || compareOrdinal(left.archive_id, right.archive_id) || compareOrdinal(left.relative_path, right.relative_path));
  const source = libraryReferenceSource(libraryValue);
  const bindings = source.system?.sovereign?.conversation_bindings
    ? Object.entries(source.system.sovereign.conversation_bindings).map(([binding_id, binding]) => ({ binding_id, ...binding }))
    : [...observed.entries()].flatMap(([binding_id, artifacts]) => artifacts.slice(0, 1).map((artifact) => ({
        binding_id,
        conversation_key: artifact.conversation_key,
        node_ref: null
      })));
  bindings.sort((left, right) => compareOrdinal(left.binding_id, right.binding_id));
  const byConversation = {};
  const byNode = {};
  const byTimeline = {};
  for (const binding of bindings) {
    const artifacts = (observed.get(binding.binding_id) || []).filter((artifact) => artifact.conversation_key === binding.conversation_key);
    const nodeId = String(binding.node_ref?.node_id || "");
    const timelineId = nodeId ? timelineIdForNode(source.system, nodeId) : "";
    const projected = {
      binding_id: binding.binding_id,
      ...(nodeId ? { node_id: nodeId } : {}),
      ...(timelineId ? { timeline_id: timelineId } : {}),
      ...(binding.node_ref?.occurrences ? { occurrences: cloneJson(binding.node_ref.occurrences) } : {}),
      positions: [...new Set(artifacts.flatMap((artifact) => artifact.positions))].sort(),
      artifacts: artifacts.map((artifact) => ({
        archive_id: artifact.archive_id,
        relative_path: artifact.relative_path,
        snapshot_sha256: [...artifact.snapshot_sha256]
      }))
    };
    if (!byConversation[binding.conversation_key]) byConversation[binding.conversation_key] = { bindings: [] };
    byConversation[binding.conversation_key].bindings.push(projected);
    if (nodeId) {
      if (!byNode[nodeId]) byNode[nodeId] = { binding_ids: [], conversation_keys: [] };
      byNode[nodeId].binding_ids.push(binding.binding_id);
      byNode[nodeId].conversation_keys.push(binding.conversation_key);
    }
    if (timelineId) {
      if (!byTimeline[timelineId]) byTimeline[timelineId] = { node_ids: [], binding_ids: [], conversation_keys: [] };
      byTimeline[timelineId].node_ids.push(nodeId);
      byTimeline[timelineId].binding_ids.push(binding.binding_id);
      byTimeline[timelineId].conversation_keys.push(binding.conversation_key);
    }
  }
  for (const value of Object.values(byConversation)) value.bindings.sort((left, right) => compareOrdinal(left.binding_id, right.binding_id));
  for (const value of Object.values(byNode)) {
    value.binding_ids = [...new Set(value.binding_ids)].sort();
    value.conversation_keys = [...new Set(value.conversation_keys)].sort();
  }
  for (const value of Object.values(byTimeline)) {
    value.node_ids = [...new Set(value.node_ids)].sort();
    value.binding_ids = [...new Set(value.binding_ids)].sort();
    value.conversation_keys = [...new Set(value.conversation_keys)].sort();
  }
  return {
    format: CONTENT_TIME_REFERENCE_INDEX_FORMAT,
    version: CONTENT_TIME_REFERENCE_INDEX_VERSION,
    source_library_sha256: source.sha256,
    source_time_system_revision: source.revision,
    by_conversation: byConversation,
    by_node: byNode,
    by_timeline: byTimeline
  };
}

function serializeContentTimeReferenceIndex(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function metadataRevision(files, directories) {
  const snapshot = {
    directories: directories.map((directory) => [directory.name, directory.files, directory.size_bytes]),
    files: files.map((file) => [file.relative_path, file.size_bytes, file.modified_at])
  };
  return sha256(JSON.stringify(snapshot));
}

function firstAndLastMessageTimes(document) {
  const times = (Array.isArray(document?.messages) ? document.messages : [])
    .map((message) => String(message?.timestamp || ""))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .map((value) => new Date(value).toISOString())
    .sort();
  return { message_start: times[0] || "", message_end: times.at(-1) || "" };
}

function stripSovereignSnapshots(range) {
  if (!range || typeof range !== "object" || Array.isArray(range)) return range ?? "";
  const bindings = [];
  const snapshots = [];
  const endpoint = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    if (value.kind !== "sovereign") return cloneJson(value);
    if (value.binding_id) bindings.push(String(value.binding_id));
    if (/^[0-9a-f]{64}$/u.test(String(value.snapshot?.sha256 || ""))) snapshots.push(String(value.snapshot.sha256));
    return { kind: "sovereign", binding_id: String(value.binding_id || "") };
  };
  const projected = {
    start: endpoint(range.start),
    ...(range.end ? { end: endpoint(range.end) } : {}),
    ...(typeof range.is_collapsed === "boolean" ? { is_collapsed: range.is_collapsed } : {}),
    ...(typeof range.is_reversed === "boolean" ? { is_reversed: range.is_reversed } : {})
  };
  return {
    range: projected,
    binding_ids: [...new Set(bindings)].sort(),
    snapshot_sha256: [...new Set(snapshots)].sort()
  };
}

function conversationTimeFacts(document) {
  if (document?.schema === readerCore.V1_SCHEMA) {
    return {
      archive_id: String(document.identity?.archive_id || ""),
      first_parsed_at: cloneJson(document.lifecycle?.first_parsed_at || { basis: "unavailable" }),
      last_parsed_at: String(document.lifecycle?.last_parsed_at || ""),
      cloudig_edited_at: String(document.lifecycle?.cloudig_edited_at || ""),
      source_captured_at: cloneJson(document.source?.captured_at || { basis: "unavailable" }),
      source_file: String(document.source?.file?.name || "")
    };
  }
  const parsedAt = String(document?.parsed_at || "");
  const exportedAt = String(document?.exported_at || "");
  const sourceTime = String(document?.source_created_at || "");
  return {
    archive_id: "",
    first_parsed_at: parsedAt ? { value: parsedAt, basis: "legacy_last_parse_upper_bound" } : { basis: "unavailable" },
    last_parsed_at: parsedAt,
    cloudig_edited_at: parsedAt,
    source_captured_at: exportedAt
      ? { value: exportedAt, basis: "legacy_exported_at", field: "exported_at" }
      : sourceTime ? { value: sourceTime, basis: "legacy_source_time" } : { basis: "unavailable" },
    source_file: String(document?.source_file || "")
  };
}

function contentTimeFacts(document) {
  const raw = readerCore.effectiveContentTime(document);
  const projected = stripSovereignSnapshots(raw);
  const range = projected && typeof projected === "object" && Object.hasOwn(projected, "range") ? projected.range : projected;
  const effective = document?.schema === readerCore.V1_SCHEMA ? document.content_time?.effective : null;
  const source = effective?.source === "user" ? "user" : "parser";
  const state = effective?.source === "user" ? String(effective.state || "") : range ? "parser" : "unavailable";
  return {
    content_time: range || "",
    content_time_source: source,
    content_time_state: state,
    content_time_label_zh: raw ? readerCore.contentTimeLabel(raw, "zh-CN") : "",
    content_time_label_en: raw ? readerCore.contentTimeLabel(raw, "en") : "",
    content_time_binding_ids: projected?.binding_ids || [],
    content_time_snapshot_sha256: projected?.snapshot_sha256 || [],
    content_time_sort_descriptor: raw ? readerCore.contentTimeSortDescriptor(raw) : null
  };
}

function invalidCatalogEntry(descriptor, digest, error, errorCode, document = null) {
  const compatibility = readerCore.conversationCompatibility(document);
  return {
    relative_path: descriptor.relative_path,
    size_bytes: descriptor.size_bytes,
    modified_at: descriptor.modified_at,
    file_created_at: descriptor.file_created_at,
    sha256: digest,
    conversation_key: "",
    archive_id: "",
    artifact_role: "current",
    title: "",
    provider: "",
    platform: "",
    models: [],
    content_time: "",
    content_time_source: "",
    content_time_state: "unavailable",
    content_time_label_zh: "",
    content_time_label_en: "",
    content_time_binding_ids: [],
    content_time_snapshot_sha256: [],
    content_time_sort_descriptor: null,
    first_parsed_at: { basis: "unavailable" },
    last_parsed_at: "",
    cloudig_edited_at: "",
    source_captured_at: { basis: "unavailable" },
    source_file: "",
    message_start: "",
    message_end: "",
    messages: 0,
    parser_version: compatibility.parser_version,
    parser_adapter: normalizeParserAdapter(compatibility.parser_adapter),
    exporter_version: String(document?.schema === readerCore.V1_SCHEMA ? document?.generation?.exporter_version || "" : document?.exporter_version || ""),
    schema: String(document?.schema || ""),
    compatibility: "invalid",
    error_code: errorCode,
    error: String(error?.message || error).split(/\r?\n/u)[0].slice(0, 500)
  };
}

async function readConversationEntry(descriptor) {
  const bytes = await readFile(descriptor.absolute);
  const digest = sha256(bytes);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return invalidCatalogEntry(descriptor, digest, error, "invalid_json");
  }
  const compatibility = readerCore.conversationCompatibility(document);
  try {
    if (!Array.isArray(document.messages)
      || document.messages.some((message) => !message || typeof message !== "object"
        || Array.isArray(message) || !Array.isArray(message.content))) {
      throw new TypeError("Conversation messages are structurally invalid");
    }
    if (compatibility.supported) readerCore.assertConversation(document);
    const stats = readerCore.documentStats(document);
    const presentation = readerCore.presentationDocument(document);
    const lifecycle = conversationTimeFacts(document);
    const content = contentTimeFacts(document);
    return {
      relative_path: descriptor.relative_path,
      size_bytes: descriptor.size_bytes,
      modified_at: descriptor.modified_at,
      file_created_at: descriptor.file_created_at,
      sha256: digest,
      conversation_key: readerCore.conversationIdentity(document),
      archive_id: lifecycle.archive_id,
      artifact_role: "current",
      title: String(presentation.title || ""),
      provider: String(presentation.provider || ""),
      platform: String(presentation.platform || ""),
      models: normalizeModels(presentation.models),
      ...content,
      first_parsed_at: lifecycle.first_parsed_at,
      last_parsed_at: lifecycle.last_parsed_at,
      cloudig_edited_at: lifecycle.cloudig_edited_at,
      source_captured_at: lifecycle.source_captured_at,
      source_file: lifecycle.source_file,
      ...firstAndLastMessageTimes(document),
      messages: Number(stats.messages) || 0,
      parser_version: compatibility.parser_version,
      parser_adapter: normalizeParserAdapter(compatibility.parser_adapter),
      exporter_version: String(document.schema === readerCore.V1_SCHEMA ? document.generation?.exporter_version || "" : document.exporter_version || ""),
      schema: String(document.schema || ""),
      compatibility: compatibility.supported ? "supported" : "unsupported",
      error_code: "",
      error: ""
    };
  } catch (error) {
    return invalidCatalogEntry(descriptor, digest, error, "invalid_conversation", document);
  }
}

function projectEntry(entry, library) {
  const fileName = fileNameFromRelative(entry.relative_path);
  const facts = {
    conversation_key: entry.conversation_key,
    title: entry.title,
    provider: entry.provider,
    platform: entry.platform,
    models: entry.models,
    content_time: entry.content_time
  };
  const effective = entry.compatibility === "invalid" ? facts : applyConversationOverlay(facts, library);
  const contentTime = readerCore.effectiveContentTime(effective) || "";
  const v1Override = library?.version === "1.0.0" ? library.conversation_overrides?.[entry.conversation_key]?.content_time : null;
  const contentTimeOverridden = v1Override
    ? v1Override.state === "cleared" || JSON.stringify(v1Override.range) !== JSON.stringify(entry.content_time)
    : effective.content_time !== entry.content_time;
  const contentTimeDescriptor = contentTimeOverridden ? readerCore.contentTimeSortDescriptor(contentTime) : entry.content_time_sort_descriptor;
  return {
    relative_path: entry.relative_path,
    file_name: fileName,
    directory: directoryFromRelative(entry.relative_path),
    archived: isArchivedRelative(entry.relative_path),
    size_bytes: entry.size_bytes,
    modified_at: entry.modified_at,
    created_at: entry.file_created_at,
    sha256: entry.sha256,
    error: entry.error,
    error_code: entry.error_code,
    conversation_key: entry.conversation_key,
    archive_id: entry.archive_id,
    artifact_role: entry.artifact_role,
    title: String(effective.title || path.basename(fileName, path.extname(fileName))),
    original_title: entry.title,
    provider: String(effective.provider || ""),
    original_provider: entry.provider,
    platform: String(effective.platform || ""),
    original_platform: entry.platform,
    models: normalizeModels(effective.models),
    original_models: entry.models,
    content_time: contentTime,
    original_content_time: entry.content_time,
    content_time_source: contentTimeOverridden ? "user" : entry.content_time_source,
    content_time_state: contentTimeOverridden ? "set" : entry.content_time_state,
    content_time_label_zh: contentTimeOverridden ? readerCore.contentTimeLabel(contentTime, "zh-CN") : entry.content_time_label_zh,
    content_time_label_en: contentTimeOverridden ? readerCore.contentTimeLabel(contentTime, "en") : entry.content_time_label_en,
    content_time_binding_ids: contentTimeOverridden ? [] : entry.content_time_binding_ids,
    content_time_snapshot_sha256: contentTimeOverridden ? [] : entry.content_time_snapshot_sha256,
    content_time_sort_descriptor: contentTimeDescriptor,
    first_parsed_at: entry.first_parsed_at,
    last_parsed_at: entry.last_parsed_at,
    cloudig_edited_at: entry.cloudig_edited_at,
    source_captured_at: entry.source_captured_at,
    parsed_at: entry.last_parsed_at,
    exported_at: entry.source_captured_at?.basis === "legacy_exported_at" ? entry.source_captured_at.value || "" : "",
    source_created_at: entry.source_captured_at?.value || "",
    source_modified_at: "",
    source_file: entry.source_file,
    message_start: entry.message_start,
    message_end: entry.message_end,
    messages: entry.messages,
    parser_version: entry.parser_version,
    parser_adapter: entry.parser_adapter,
    exporter_version: entry.exporter_version,
    schema: entry.schema,
    compatible: entry.compatibility === "supported",
    compatibility: entry.compatibility
  };
}

function withContentTimeRanks(files) {
  const result = files.map((file) => ({ ...file }));
  const stable = (left, right) => String(left.title || "").localeCompare(String(right.title || ""), "zh-CN", { numeric: true })
    || String(left.conversation_key || left.relative_path).localeCompare(String(right.conversation_key || right.relative_path), "en");
  for (const [field, direction] of [["content_time_rank_asc", "ascending"], ["content_time_rank_desc", "descending"]]) {
    const ordered = [...result].sort((left, right) => readerCore.compareContentTimeDescriptors(left.content_time_sort_descriptor, right.content_time_sort_descriptor, direction) || stable(left, right));
    ordered.forEach((file, index) => { file[field] = index; });
  }
  return result;
}

function catalogPath(paths) {
  return paths.conversationCatalog || path.join(paths.indexes, CONVERSATION_CATALOG_FILE);
}

function contentTimeReferenceIndexPath(paths) {
  return paths.contentTimeReferenceIndex || path.join(paths.indexes, CONTENT_TIME_REFERENCE_INDEX_FILE);
}

async function loadCatalog(paths) {
  try {
    const document = normalizeCatalog(JSON.parse(await readFile(catalogPath(paths), "utf8")));
    return { status: "available", document };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", document: null };
    return { status: "invalid", document: null, error };
  }
}

export async function scanConversationMetadata(paths) {
  const files = [];
  const directories = new Map();
  async function visit(directory, relativeDirectory = "Conversations") {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
    for (const entry of entries) {
      if (entry.name.startsWith(".cloudig-stage-")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const directoryName = relative.slice("Conversations/".length);
        if (directoryName && directoryName !== ARCHIVE_DIRECTORY && !directoryName.startsWith(`${ARCHIVE_DIRECTORY}/`)) {
          directories.set(directoryName, { name: directoryName, files: 0, size_bytes: 0 });
        }
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const information = await stat(absolute);
      const descriptor = {
        absolute,
        relative_path: assertCatalogRelative(relative),
        size_bytes: information.size,
        modified_at: information.mtime.toISOString(),
        file_created_at: information.birthtime.toISOString()
      };
      files.push(descriptor);
      const directoryName = directoryFromRelative(relative);
      if (directoryName && directoryName !== ARCHIVE_DIRECTORY && !directoryName.startsWith(`${ARCHIVE_DIRECTORY}/`)) {
        const summary = directories.get(directoryName) || { name: directoryName, files: 0, size_bytes: 0 };
        summary.files += 1;
        summary.size_bytes += descriptor.size_bytes;
        directories.set(directoryName, summary);
      }
    }
  }
  await visit(paths.conversations);
  files.sort((left, right) => compareOrdinal(left.relative_path, right.relative_path));
  const directoryList = [...directories.values()].sort((left, right) => compareOrdinal(left.name, right.name));
  return { files, directories: directoryList, source_revision: metadataRevision(files, directoryList) };
}

async function reconcileOnce(paths, library, { retry = true } = {}) {
  const snapshot = await scanConversationMetadata(paths);
  const loaded = await loadCatalog(paths);
  const cachedEntries = new Map((loaded.document?.entries || []).map((entry) => [entry.relative_path.toLocaleLowerCase("en-US"), entry]));
  const currentPaths = new Set(snapshot.files.map((entry) => entry.relative_path.toLocaleLowerCase("en-US")));
  const entries = [];
  let parsedFiles = 0;
  let reusedFiles = 0;
  for (const descriptor of snapshot.files) {
    const cached = cachedEntries.get(descriptor.relative_path.toLocaleLowerCase("en-US"));
    if (cached && cached.size_bytes === descriptor.size_bytes && cached.modified_at === descriptor.modified_at) {
      entries.push(cached);
      reusedFiles += 1;
    } else {
      entries.push(await readConversationEntry(descriptor));
      parsedFiles += 1;
    }
  }
  const removedFiles = [...cachedEntries.keys()].filter((key) => !currentPaths.has(key)).length;
  const catalog = {
    format: CONVERSATION_CATALOG_FORMAT,
    version: CONVERSATION_CATALOG_VERSION,
    source_revision: snapshot.source_revision,
    entries
  };
  const unchanged = loaded.status === "available"
    && loaded.document.source_revision === snapshot.source_revision
    && parsedFiles === 0
    && removedFiles === 0;
  let status = unchanged ? "reused" : loaded.status === "missing" ? "created" : loaded.status === "invalid" ? "rebuilt" : "updated";
  let written = false;
  let errorCode = "";
  if (!unchanged) {
    const after = await scanConversationMetadata(paths);
    if (after.source_revision !== snapshot.source_revision) {
      if (retry) return reconcileOnce(paths, library, { retry: false });
      status = "volatile";
      errorCode = "CLOUDIG_CATALOG_SOURCE_CHANGED";
    } else {
      try {
        const writeStatus = await atomicWriteText(catalogPath(paths), serializeCatalog(catalog));
        written = writeStatus !== "unchanged";
      } catch (error) {
        status = "write_failed";
        errorCode = String(error?.code || "CLOUDIG_CATALOG_WRITE_FAILED");
      }
    }
  }
  const referenceIndex = buildContentTimeReferenceIndex(catalog, library);
  let referenceWritten = false;
  let referenceErrorCode = "";
  if (!new Set(["volatile", "write_failed"]).has(status)) {
    try {
      const writeStatus = await atomicWriteText(contentTimeReferenceIndexPath(paths), serializeContentTimeReferenceIndex(referenceIndex));
      referenceWritten = writeStatus !== "unchanged";
    } catch (error) {
      referenceErrorCode = String(error?.code || "CLOUDIG_CONTENT_TIME_REFERENCE_INDEX_WRITE_FAILED");
    }
  }
  return {
    entries,
    files: withContentTimeRanks(entries.map((entry) => projectEntry(entry, library))),
    directories: snapshot.directories,
    catalog: Object.freeze({
      format: CONVERSATION_CATALOG_FORMAT,
      version: CONVERSATION_CATALOG_VERSION,
      path: `Data/Indexes/${CONVERSATION_CATALOG_FILE}`,
      source_revision: snapshot.source_revision,
      status,
      total_files: entries.length,
      parsed_files: parsedFiles,
      reused_files: reusedFiles,
      removed_files: removedFiles,
      written,
      error_code: errorCode
    }),
    content_time_references: Object.freeze({
      format: CONTENT_TIME_REFERENCE_INDEX_FORMAT,
      version: CONTENT_TIME_REFERENCE_INDEX_VERSION,
      path: `Data/Indexes/${CONTENT_TIME_REFERENCE_INDEX_FILE}`,
      source_library_sha256: referenceIndex.source_library_sha256,
      source_time_system_revision: referenceIndex.source_time_system_revision,
      references: Object.values(referenceIndex.by_conversation).reduce((sum, entry) => sum + entry.bindings.length, 0),
      written: referenceWritten,
      error_code: referenceErrorCode
    })
  };
}

export async function reconcileConversationCatalog(paths, library) {
  return reconcileOnce(paths, library);
}
