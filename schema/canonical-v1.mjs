const CONVERSATION_ROOT_ORDER = [
  "schema", "identity", "generation", "lifecycle", "source", "message_time", "content_time",
  "title", "provider", "platform", "models", "messages", "resources", "sources", "warnings"
];
const LIBRARY_ROOT_ORDER = [
  "format", "version", "conversation_schema", "content_time_schema", "edited_at",
  "user", "assistant", "project", "preferences", "workflow_preferences",
  "platform_overrides", "conversation_overrides", "content_time_system"
];
const ORDERS = Object.freeze({
  identity: ["conversation_key", "archive_id"],
  generation: ["parser_version", "parser_adapter", "exporter_version"],
  parser_adapter: ["id", "version"],
  lifecycle: ["first_parsed_at", "last_parsed_at", "cloudig_edited_at"],
  first_parsed_at: ["value", "basis"],
  source: ["file", "url", "captured_at", "conversation_created_at", "conversation_updated_at"],
  file: ["name", "sha256", "size_bytes"],
  captured_at: ["value", "basis", "field"],
  message_time: ["start", "end", "timestamped_messages", "total_messages"],
  content_time: ["parser_default", "effective", "edit_id", "edited_at", "state", "range"],
  parser_default: ["edited_at", "derivation", "range"],
  effective: ["source", "state", "edit_id", "edited_at", "range"],
  range: ["start", "end", "is_collapsed", "is_reversed"],
  endpoint: ["kind", "era", "year", "month", "day", "hour", "minute", "second", "utc_offset", "direction", "unit", "coefficient", "anchor", "binding_id", "snapshot"],
  anchor: ["date", "captured_at", "utc_offset"],
  message: ["id", "parent_id", "turn_id", "role", "name", "model", "timestamp", "content"],
  user: ["display_name", "avatar"],
  assistant: ["display_name", "avatar", "apply_to_all"],
  project: ["title", "description", "icon", "cover"],
  cover: ["path", "fit"],
  preferences: ["language", "theme", "name_rule_ack_version"],
  workflow_preferences: ["time_fields", "sorts", "parse_batch", "claude_batch"],
  time_fields: ["archiver", "claude", "reader"],
  sorts: ["parser", "archiver", "claude", "reader"],
  parse_batch: ["archive_directory", "parse_unparsed", "parse_selected", "update_outdated", "preserve_previous"],
  claude_batch: ["parse_unparsed", "parse_selected", "update_outdated", "preserve_previous"],
  conversation_override: ["conversation_name", "provider", "platform", "models", "user_name", "assistant_name", "content_time"],
  time_system: ["format", "version", "revision", "terran", "sovereign"],
  terran: ["preset_version", "default_anchor", "preset_anchor_overrides", "preset_overrides"],
  sovereign: ["lineages", "nodes", "containment_links", "counterpart_links", "terran_mappings", "conversation_bindings", "display_order"]
});

const BLOCK_ORDERS = Object.freeze({
  markdown: ["type", "text"],
  text: ["type", "text"],
  reasoning: ["type", "title", "text", "markdown", "html", "duration_seconds", "effort"],
  reasoning_summary: ["type", "title", "text", "markdown", "html", "duration_seconds", "effort"],
  status: ["type", "title", "text", "markdown", "html", "duration_seconds", "effort"],
  code: ["type", "code", "language", "filename"],
  math: ["type", "tex", "mathml", "display"],
  image: ["type", "resource_id", "purpose", "alt", "caption"],
  attachment: ["type", "resource_id", "text"],
  search: ["type", "query", "source_ids", "status", "duration_seconds"],
  citations: ["type", "source_ids", "label"],
  tool: ["type", "kind", "call_id", "name", "title", "text", "markdown", "html", "status", "success"],
  diagram: ["type", "format", "title", "source", "svg", "html", "resource_id"],
  html: ["type", "label", "html"],
  unknown: ["type", "label", "text", "html"]
});

const RESOURCE_ORDER = ["id", "kind", "availability", "name", "mime_type", "size_bytes", "original_size_bytes", "sha256", "data_url", "url", "width", "height", "original_width", "original_height"];
const SOURCE_ORDER = ["id", "url", "title", "site_name", "snippet"];
const WARNING_ORDER = ["code", "message", "message_index", "resource_id"];

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function orderFor(pathName, value, parentKey) {
  if (pathName === "$" && value?.schema === "ai-chat-archive/conversation/1.0.0") return CONVERSATION_ROOT_ORDER;
  if (pathName === "$" && value?.format === "cloudig/library" && value?.version === "1.0.0") return LIBRARY_ROOT_ORDER;
  if (/\.messages\[\d+\]$/u.test(pathName)) return ORDERS.message;
  if (/\.content\[\d+\]$/u.test(pathName)) return BLOCK_ORDERS[value?.type] || ["type"];
  if (/\.resources\[\d+\]$/u.test(pathName)) return RESOURCE_ORDER;
  if (/\.sources\[\d+\]$/u.test(pathName)) return SOURCE_ORDER;
  if (/\.warnings\[\d+\]$/u.test(pathName)) return WARNING_ORDER;
  if (/^\$\.conversation_overrides\.[0-9a-f]{64}$/u.test(pathName)) return ORDERS.conversation_override;
  if (parentKey === "start" || parentKey === "end") return ORDERS.endpoint;
  if (parentKey === "anchor" || parentKey === "default_anchor" || /\.preset_anchor_overrides\.[0-9a-f-]{36}$/u.test(pathName)) return ORDERS.anchor;
  if (parentKey === "content_time" && ("state" in value || "edit_id" in value)) return ORDERS.content_time;
  if (parentKey === "content_time_system") return ORDERS.time_system;
  return ORDERS[parentKey] || [];
}

function orderedKeys(value, order) {
  const rank = new Map(order.map((key, index) => [key, index]));
  return Object.keys(value).sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right, "en");
  });
}

function canonicalize(value, pathName, parentKey = "") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${pathName} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${pathName}[${index}]`, parentKey));
  if (!isPlainObject(value)) throw new TypeError(`${pathName} is not a plain JSON value`);
  const order = orderFor(pathName, value, parentKey);
  const result = {};
  for (const key of orderedKeys(value, order)) {
    if (value[key] === undefined) throw new TypeError(`${pathName}.${key} is undefined`);
    result[key] = canonicalize(value[key], `${pathName}.${key}`, key);
  }
  return result;
}

export function canonicalizeV1(value) {
  if (!isPlainObject(value)) throw new TypeError("V1 document root must be a plain object");
  const recognized = value.schema === "ai-chat-archive/conversation/1.0.0"
    || (value.format === "cloudig/library" && value.version === "1.0.0");
  if (!recognized) throw new TypeError("canonicalizeV1 only accepts Cloudig conversation/library 1.0.0 documents");
  return canonicalize(value, "$", "");
}

export function serializeV1(value) {
  return `${JSON.stringify(canonicalizeV1(value), null, 2)}\n`;
}
