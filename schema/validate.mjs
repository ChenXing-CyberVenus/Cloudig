import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const CONVERSATION_SCHEMA = "ai-chat-archive/conversation/0.1.0";
export const CONVERSATION_SCHEMA_PREVIOUS = "ai-chat-archive/conversation/0.1.1";
export const CONVERSATION_SCHEMA_IDENTITY = "ai-chat-archive/conversation/0.1.2";
export const CONVERSATION_SCHEMA_VERSIONED = "ai-chat-archive/conversation/0.1.3";
export const CONVERSATION_SCHEMA_ADAPTER_VERSIONED = "ai-chat-archive/conversation/0.1.4";
export const CONVERSATION_SCHEMA_CURRENT = "ai-chat-archive/conversation/0.1.5";
export const CONVERSATION_SCHEMA_BRANCHES = "ai-chat-archive/conversation/0.2.0";
export const CONVERSATION_SCHEMA_BRANCHES_PREVIOUS = "ai-chat-archive/conversation/0.2.1";
export const CONVERSATION_SCHEMA_BRANCHES_IDENTITY = "ai-chat-archive/conversation/0.2.2";
export const CONVERSATION_SCHEMA_BRANCHES_VERSIONED = "ai-chat-archive/conversation/0.2.3";
export const CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED = "ai-chat-archive/conversation/0.2.4";
export const CONVERSATION_SCHEMA_BRANCHES_CURRENT = "ai-chat-archive/conversation/0.2.5";
export const CONVERSATION_SCHEMAS = Object.freeze(new Set([
  CONVERSATION_SCHEMA,
  CONVERSATION_SCHEMA_PREVIOUS,
  CONVERSATION_SCHEMA_IDENTITY,
  CONVERSATION_SCHEMA_VERSIONED,
  CONVERSATION_SCHEMA_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_CURRENT,
  CONVERSATION_SCHEMA_BRANCHES,
  CONVERSATION_SCHEMA_BRANCHES_PREVIOUS,
  CONVERSATION_SCHEMA_BRANCHES_IDENTITY,
  CONVERSATION_SCHEMA_BRANCHES_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]));
const GROUPED_CONVERSATION_SCHEMAS = new Set([
  CONVERSATION_SCHEMA_PREVIOUS,
  CONVERSATION_SCHEMA_IDENTITY,
  CONVERSATION_SCHEMA_VERSIONED,
  CONVERSATION_SCHEMA_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_CURRENT,
  CONVERSATION_SCHEMA_BRANCHES_PREVIOUS,
  CONVERSATION_SCHEMA_BRANCHES_IDENTITY,
  CONVERSATION_SCHEMA_BRANCHES_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]);
const CONVERSATION_KEY_SCHEMAS = new Set([
  CONVERSATION_SCHEMA_IDENTITY,
  CONVERSATION_SCHEMA_VERSIONED,
  CONVERSATION_SCHEMA_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_CURRENT,
  CONVERSATION_SCHEMA_BRANCHES_IDENTITY,
  CONVERSATION_SCHEMA_BRANCHES_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]);
const VERSION_WATERMARK_SCHEMAS = new Set([
  CONVERSATION_SCHEMA_VERSIONED,
  CONVERSATION_SCHEMA_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_CURRENT,
  CONVERSATION_SCHEMA_BRANCHES_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]);
const ADAPTER_WATERMARK_SCHEMAS = new Set([
  CONVERSATION_SCHEMA_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_CURRENT,
  CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]);
const PARSED_AT_SCHEMAS = new Set([
  CONVERSATION_SCHEMA_CURRENT,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]);
const FLAT_CONVERSATION_SCHEMAS = new Set([
  CONVERSATION_SCHEMA,
  CONVERSATION_SCHEMA_PREVIOUS,
  CONVERSATION_SCHEMA_IDENTITY,
  CONVERSATION_SCHEMA_VERSIONED,
  CONVERSATION_SCHEMA_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_CURRENT
]);
const BRANCH_GRAPH_SCHEMAS = new Set([
  CONVERSATION_SCHEMA_BRANCHES_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]);
const MESSAGE_ID_REQUIRED_SCHEMAS = new Set([
  CONVERSATION_SCHEMA_BRANCHES_ADAPTER_VERSIONED,
  CONVERSATION_SCHEMA_BRANCHES_CURRENT
]);

const ROOT_FIELDS = new Set([
  "schema",
  "parser_version",
  "parser_adapter",
  "parsed_at",
  "exporter_version",
  "conversation_key",
  "conversation_id",
  "source_file",
  "source_sha256",
  "source_size_bytes",
  "source_url",
  "exported_at",
  "content_time",
  "created_at",
  "updated_at",
  "title",
  "provider",
  "platform",
  "models",
  "messages",
  "resources",
  "sources",
  "warnings"
]);

const MESSAGE_FIELDS = new Set(["id", "parent_id", "turn_id", "role", "name", "model", "timestamp", "content"]);
const RESOURCE_FIELDS = new Set([
  "id",
  "kind",
  "availability",
  "name",
  "mime_type",
  "size_bytes",
  "original_size_bytes",
  "sha256",
  "data_url",
  "url",
  "width",
  "height",
  "original_width",
  "original_height"
]);
const SOURCE_FIELDS = new Set(["id", "url", "title", "site_name", "snippet"]);
const WARNING_FIELDS = new Set(["code", "message", "message_index", "resource_id"]);

const BLOCK_FIELDS = {
  markdown: new Set(["type", "text"]),
  text: new Set(["type", "text"]),
  reasoning: new Set(["type", "title", "text", "markdown", "html", "duration_seconds", "effort"]),
  reasoning_summary: new Set(["type", "title", "text", "markdown", "html", "duration_seconds", "effort"]),
  status: new Set(["type", "title", "text", "markdown", "html", "duration_seconds", "effort"]),
  code: new Set(["type", "code", "language", "filename"]),
  math: new Set(["type", "tex", "mathml", "display"]),
  image: new Set(["type", "resource_id", "purpose", "alt", "caption"]),
  attachment: new Set(["type", "resource_id", "text"]),
  search: new Set(["type", "query", "source_ids", "status", "duration_seconds"]),
  citations: new Set(["type", "source_ids", "label"]),
  tool: new Set(["type", "kind", "call_id", "name", "title", "text", "markdown", "html", "status", "success"]),
  diagram: new Set(["type", "format", "title", "source", "svg", "html", "resource_id"]),
  html: new Set(["type", "html", "label"]),
  unknown: new Set(["type", "label", "text", "html"])
};

const ROLES = new Set(["user", "assistant", "system", "developer", "tool", "other"]);
const IMAGE_PURPOSES = new Set(["uploaded", "generated", "inline", "search", "diagram"]);
const TOOL_KINDS = new Set(["call", "result", "activity"]);
const DIAGRAM_FORMATS = new Set(["mermaid", "markmap", "svg", "html", "image", "canvas", "writing_block", "other"]);
const RESOURCE_KINDS = new Set(["image", "attachment"]);
const RESOURCE_AVAILABILITY = new Set(["embedded", "metadata_only", "missing"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const NON_WHITESPACE_PATTERN = /\S/u;
const DATA_URL_PATTERN = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors, pathName, message) {
  errors.push(`${pathName}: ${message}`);
}

function requireFields(value, fields, pathName, errors) {
  for (const field of fields) {
    if (!hasOwn(value, field)) addError(errors, pathName, `missing required field ${field}`);
  }
}

function checkAllowedFields(value, allowed, pathName, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, `${pathName}.${key}`, "unknown field");
  }
}

function checkString(value, pathName, errors) {
  if (typeof value !== "string" || value.length === 0) {
    addError(errors, pathName, "must be a non-empty string");
    return false;
  }
  return true;
}

function checkPattern(value, pattern, pathName, label, errors) {
  if (!checkString(value, pathName, errors)) return false;
  if (!pattern.test(value)) {
    addError(errors, pathName, `must match ${label}`);
    return false;
  }
  return true;
}

function checkNumber(value, pathName, errors, { integer = false, minimum = 0, exclusiveMinimum = false } = {}) {
  const validNumber = typeof value === "number" && Number.isFinite(value);
  const belowMinimum = validNumber
    ? (exclusiveMinimum ? value <= minimum : value < minimum)
    : false;
  if (!validNumber || (integer && !Number.isInteger(value)) || belowMinimum) {
    addError(errors, pathName, `must be a ${integer ? "integer" : "number"} ${exclusiveMinimum ? ">" : ">="} ${minimum}`);
    return false;
  }
  return true;
}

function checkEnum(value, allowed, pathName, errors) {
  if (!allowed.has(value)) {
    addError(errors, pathName, `must be one of ${[...allowed].join(", ")}`);
    return false;
  }
  return true;
}

function checkDateTime(value, pathName, errors) {
  if (!checkString(value, pathName, errors)) return false;
  if (!DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    addError(errors, pathName, "must be an ISO 8601 date-time with timezone");
    return false;
  }
  return true;
}

function checkHttpUrl(value, pathName, errors) {
  if (!checkString(value, pathName, errors)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    addError(errors, pathName, "must be an absolute HTTP or HTTPS URL");
    return false;
  }
  return true;
}

function checkArray(value, pathName, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    addError(errors, pathName, "must be a non-empty array");
    return false;
  }
  return true;
}

function checkUniqueStrings(values, pathName, errors) {
  if (new Set(values).size !== values.length) addError(errors, pathName, "must not contain duplicates");
}

function checkSparse(value, pathName, errors) {
  if (value === null || value === undefined) {
    addError(errors, pathName, "null and undefined are forbidden; omit absent fields");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) addError(errors, pathName, "empty arrays are forbidden; omit optional fields");
    value.forEach((item, index) => checkSparse(item, `${pathName}[${index}]`, errors));
    return;
  }
  if (isObject(value)) {
    if (Object.keys(value).length === 0) addError(errors, pathName, "empty objects are forbidden");
    for (const [key, child] of Object.entries(value)) checkSparse(child, `${pathName}.${key}`, errors);
    return;
  }
  if (typeof value === "string" && value.length === 0) addError(errors, pathName, "empty strings are forbidden");
}

function validateResource(resource, index, errors) {
  const pathName = `$.resources[${index}]`;
  if (!isObject(resource)) {
    addError(errors, pathName, "must be an object");
    return;
  }
  checkAllowedFields(resource, RESOURCE_FIELDS, pathName, errors);
  requireFields(resource, ["id", "kind", "availability"], pathName, errors);
  if (hasOwn(resource, "id")) checkPattern(resource.id, ID_PATTERN, `${pathName}.id`, "a lowercase identifier", errors);
  if (hasOwn(resource, "kind")) checkEnum(resource.kind, RESOURCE_KINDS, `${pathName}.kind`, errors);
  if (hasOwn(resource, "availability")) checkEnum(resource.availability, RESOURCE_AVAILABILITY, `${pathName}.availability`, errors);
  for (const field of ["name"]) if (hasOwn(resource, field)) checkString(resource[field], `${pathName}.${field}`, errors);
  if (hasOwn(resource, "mime_type")) checkPattern(resource.mime_type, MIME_PATTERN, `${pathName}.mime_type`, "a MIME type", errors);
  for (const field of ["size_bytes", "original_size_bytes", "width", "height", "original_width", "original_height"]) {
    if (hasOwn(resource, field)) checkNumber(resource[field], `${pathName}.${field}`, errors, { integer: true, minimum: 1 });
  }
  if (hasOwn(resource, "sha256")) checkPattern(resource.sha256, SHA256_PATTERN, `${pathName}.sha256`, "a lowercase SHA-256", errors);
  if (hasOwn(resource, "url")) checkHttpUrl(resource.url, `${pathName}.url`, errors);

  if (resource.availability === "embedded") {
    if (resource.kind !== "image") addError(errors, `${pathName}.kind`, "only images may be embedded in 0.1.0");
    requireFields(resource, ["mime_type", "size_bytes", "sha256", "data_url"], pathName, errors);
    if (hasOwn(resource, "url")) addError(errors, `${pathName}.url`, "embedded resources must omit the redundant remote URL");
    if (typeof resource.mime_type === "string" && !resource.mime_type.startsWith("image/")) {
      addError(errors, `${pathName}.mime_type`, "embedded resource MIME type must be image/*");
    }
    if (hasOwn(resource, "data_url")) {
      const match = typeof resource.data_url === "string" ? DATA_URL_PATTERN.exec(resource.data_url) : null;
      if (!match) {
        addError(errors, `${pathName}.data_url`, "must be a canonical base64 image data URL");
      } else {
        const [, dataMime, base64] = match;
        const bytes = Buffer.from(base64, "base64");
        const canonical = bytes.toString("base64");
        if (canonical !== base64) addError(errors, `${pathName}.data_url`, "base64 payload must be canonical");
        if (resource.mime_type !== dataMime) addError(errors, `${pathName}.data_url`, "data URL MIME type must match mime_type");
        if (resource.size_bytes !== bytes.length) addError(errors, `${pathName}.size_bytes`, "must equal the embedded byte length");
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (resource.sha256 !== digest) addError(errors, `${pathName}.sha256`, "must equal the embedded byte SHA-256");
      }
    }
  }

  if (resource.availability === "metadata_only" && hasOwn(resource, "data_url")) {
    addError(errors, `${pathName}.data_url`, "metadata-only resources cannot contain embedded bytes");
  }
  if (resource.availability === "missing") {
    if (hasOwn(resource, "data_url")) addError(errors, `${pathName}.data_url`, "missing resources cannot contain embedded bytes");
    if (hasOwn(resource, "url")) addError(errors, `${pathName}.url`, "missing resources cannot claim a usable URL");
  }
}

function validateSource(source, index, errors) {
  const pathName = `$.sources[${index}]`;
  if (!isObject(source)) {
    addError(errors, pathName, "must be an object");
    return;
  }
  checkAllowedFields(source, SOURCE_FIELDS, pathName, errors);
  requireFields(source, ["id", "url"], pathName, errors);
  if (hasOwn(source, "id")) checkPattern(source.id, ID_PATTERN, `${pathName}.id`, "a lowercase identifier", errors);
  if (hasOwn(source, "url")) checkHttpUrl(source.url, `${pathName}.url`, errors);
  for (const field of ["title", "site_name", "snippet"]) {
    if (hasOwn(source, field)) checkString(source[field], `${pathName}.${field}`, errors);
  }
}

function validateStringIds(value, pathName, errors, knownIds) {
  if (!checkArray(value, pathName, errors)) return;
  value.forEach((id, index) => {
    if (checkPattern(id, ID_PATTERN, `${pathName}[${index}]`, "a lowercase identifier", errors) && !knownIds.has(id)) {
      addError(errors, `${pathName}[${index}]`, `unknown reference ${id}`);
    }
  });
  checkUniqueStrings(value, pathName, errors);
}

function validateRichSemanticBlock(block, pathName, errors) {
  const representations = ["text", "markdown", "html"].filter((field) => hasOwn(block, field));
  if (representations.length > 1) addError(errors, pathName, "must keep only one primary text representation");
  if (!hasOwn(block, "title") && representations.length === 0) {
    addError(errors, pathName, "requires title, text, markdown, or html");
  }
  for (const field of ["title", "text", "markdown", "html", "effort"]) {
    if (hasOwn(block, field)) checkString(block[field], `${pathName}.${field}`, errors);
  }
  if (hasOwn(block, "duration_seconds")) {
    checkNumber(block.duration_seconds, `${pathName}.duration_seconds`, errors, { exclusiveMinimum: true });
  }
}

function validateBlock(block, pathName, errors, resources, sources, schema) {
  if (!isObject(block)) {
    addError(errors, pathName, "must be an object");
    return;
  }
  if (!hasOwn(block, "type")) {
    addError(errors, pathName, "missing required field type");
    return;
  }
  if (typeof block.type !== "string" || !hasOwn(BLOCK_FIELDS, block.type)) {
    addError(errors, `${pathName}.type`, `unsupported content type ${String(block.type)}`);
    return;
  }
  checkAllowedFields(block, BLOCK_FIELDS[block.type], pathName, errors);

  switch (block.type) {
    case "markdown":
    case "text":
      requireFields(block, ["text"], pathName, errors);
      if (hasOwn(block, "text")) checkString(block.text, `${pathName}.text`, errors);
      break;
    case "reasoning":
    case "reasoning_summary":
    case "status":
      validateRichSemanticBlock(block, pathName, errors);
      break;
    case "code":
      requireFields(block, ["code"], pathName, errors);
      if (hasOwn(block, "code")) checkString(block.code, `${pathName}.code`, errors);
      for (const field of ["language", "filename"]) if (hasOwn(block, field)) checkString(block[field], `${pathName}.${field}`, errors);
      break;
    case "math": {
      const representations = ["tex", "mathml"].filter((field) => hasOwn(block, field));
      if (representations.length !== 1) addError(errors, pathName, "requires exactly one of tex or mathml");
      for (const field of representations) checkString(block[field], `${pathName}.${field}`, errors);
      if (hasOwn(block, "mathml") && typeof block.mathml === "string" && !/^\s*<math(?:\s|>)/i.test(block.mathml)) {
        addError(errors, `${pathName}.mathml`, "must begin with a MathML <math> element");
      }
      if (hasOwn(block, "display") && block.display !== true) addError(errors, `${pathName}.display`, "omit the inline default; only true is allowed");
      break;
    }
    case "image": {
      requireFields(block, ["resource_id"], pathName, errors);
      if (hasOwn(block, "resource_id")) {
        checkPattern(block.resource_id, ID_PATTERN, `${pathName}.resource_id`, "a lowercase identifier", errors);
        const resource = resources.get(block.resource_id);
        if (!resource) addError(errors, `${pathName}.resource_id`, `unknown resource ${block.resource_id}`);
        else if (resource.kind !== "image") addError(errors, `${pathName}.resource_id`, "must reference an image resource");
      }
      if (hasOwn(block, "purpose")) checkEnum(block.purpose, IMAGE_PURPOSES, `${pathName}.purpose`, errors);
      for (const field of ["alt", "caption"]) if (hasOwn(block, field)) checkString(block[field], `${pathName}.${field}`, errors);
      break;
    }
    case "attachment": {
      requireFields(block, ["resource_id"], pathName, errors);
      if (hasOwn(block, "resource_id")) {
        checkPattern(block.resource_id, ID_PATTERN, `${pathName}.resource_id`, "a lowercase identifier", errors);
        const resource = resources.get(block.resource_id);
        if (!resource) addError(errors, `${pathName}.resource_id`, `unknown resource ${block.resource_id}`);
        else if (resource.kind !== "attachment") addError(errors, `${pathName}.resource_id`, "must reference an attachment resource");
      }
      if (hasOwn(block, "text")) checkString(block.text, `${pathName}.text`, errors);
      if (FLAT_CONVERSATION_SCHEMAS.has(schema) && hasOwn(block, "text")) addError(errors, `${pathName}.text`, "requires a conversation/0.2.x schema");
      break;
    }
    case "search":
      if (!hasOwn(block, "query") && !hasOwn(block, "source_ids")) addError(errors, pathName, "requires query or source_ids");
      if (hasOwn(block, "query")) checkString(block.query, `${pathName}.query`, errors);
      if (hasOwn(block, "source_ids")) validateStringIds(block.source_ids, `${pathName}.source_ids`, errors, sources);
      if (hasOwn(block, "status")) checkString(block.status, `${pathName}.status`, errors);
      if (hasOwn(block, "duration_seconds")) {
        checkNumber(block.duration_seconds, `${pathName}.duration_seconds`, errors, { exclusiveMinimum: true });
      }
      break;
    case "citations":
      requireFields(block, ["source_ids"], pathName, errors);
      if (hasOwn(block, "source_ids")) validateStringIds(block.source_ids, `${pathName}.source_ids`, errors, sources);
      if (hasOwn(block, "label")) checkString(block.label, `${pathName}.label`, errors);
      break;
    case "tool": {
      requireFields(block, ["kind"], pathName, errors);
      if (hasOwn(block, "kind")) checkEnum(block.kind, TOOL_KINDS, `${pathName}.kind`, errors);
      if (hasOwn(block, "call_id")) checkPattern(block.call_id, ID_PATTERN, `${pathName}.call_id`, "a lowercase identifier", errors);
      if (FLAT_CONVERSATION_SCHEMAS.has(schema) && hasOwn(block, "call_id")) addError(errors, `${pathName}.call_id`, "requires a conversation/0.2.x schema");
      const representations = ["text", "markdown", "html"].filter((field) => hasOwn(block, field));
      if (representations.length > 1) addError(errors, pathName, "must keep only one primary tool-body representation");
      if (!hasOwn(block, "name") && !hasOwn(block, "title") && representations.length === 0) {
        addError(errors, pathName, "requires name, title, text, markdown, or html");
      }
      for (const field of ["name", "title", "text", "markdown", "html", "status"]) {
        if (hasOwn(block, field)) checkString(block[field], `${pathName}.${field}`, errors);
      }
      if (hasOwn(block, "success") && typeof block.success !== "boolean") addError(errors, `${pathName}.success`, "must be boolean");
      break;
    }
    case "diagram": {
      requireFields(block, ["format"], pathName, errors);
      if (hasOwn(block, "format")) checkEnum(block.format, DIAGRAM_FORMATS, `${pathName}.format`, errors);
      const representations = ["source", "svg", "html", "resource_id"].filter((field) => hasOwn(block, field));
      if (representations.length !== 1) addError(errors, pathName, "requires exactly one diagram representation");
      for (const field of ["title", "source", "svg", "html"]) if (hasOwn(block, field)) checkString(block[field], `${pathName}.${field}`, errors);
      if (hasOwn(block, "svg") && typeof block.svg === "string" && !/^\s*<svg(?:\s|>)/i.test(block.svg)) {
        addError(errors, `${pathName}.svg`, "must begin with an SVG element");
      }
      if (hasOwn(block, "resource_id")) {
        checkPattern(block.resource_id, ID_PATTERN, `${pathName}.resource_id`, "a lowercase identifier", errors);
        const resource = resources.get(block.resource_id);
        if (!resource) addError(errors, `${pathName}.resource_id`, `unknown resource ${block.resource_id}`);
        else if (resource.kind !== "image") addError(errors, `${pathName}.resource_id`, "must reference an image resource");
      }
      break;
    }
    case "html":
      requireFields(block, ["html"], pathName, errors);
      if (hasOwn(block, "html")) checkString(block.html, `${pathName}.html`, errors);
      if (hasOwn(block, "label")) checkString(block.label, `${pathName}.label`, errors);
      break;
    case "unknown":
      requireFields(block, ["label"], pathName, errors);
      if (hasOwn(block, "label")) checkString(block.label, `${pathName}.label`, errors);
      if (hasOwn(block, "text") && hasOwn(block, "html")) addError(errors, pathName, "must keep only one unknown-body representation");
      for (const field of ["text", "html"]) if (hasOwn(block, field)) checkString(block[field], `${pathName}.${field}`, errors);
      break;
  }
}

function validateMessage(message, index, errors, resources, sources, messageIds, schema) {
  const pathName = `$.messages[${index}]`;
  if (!isObject(message)) {
    addError(errors, pathName, "must be an object");
    return;
  }
  checkAllowedFields(message, MESSAGE_FIELDS, pathName, errors);
  const requiredFields = GROUPED_CONVERSATION_SCHEMAS.has(schema) ? ["turn_id", "role", "content"] : ["role", "content"];
  if (MESSAGE_ID_REQUIRED_SCHEMAS.has(schema)) requiredFields.unshift("id");
  requireFields(message, requiredFields, pathName, errors);
  if (hasOwn(message, "id")) {
    if (checkPattern(message.id, ID_PATTERN, `${pathName}.id`, "a lowercase identifier", errors)) {
      if (messageIds.has(message.id)) addError(errors, `${pathName}.id`, `duplicate message id ${message.id}`);
      messageIds.add(message.id);
    }
  }
  if (hasOwn(message, "parent_id")) checkPattern(message.parent_id, ID_PATTERN, `${pathName}.parent_id`, "a lowercase identifier", errors);
  if (FLAT_CONVERSATION_SCHEMAS.has(schema) && hasOwn(message, "parent_id")) addError(errors, `${pathName}.parent_id`, "requires a conversation/0.2.x schema");
  if (hasOwn(message, "turn_id")) checkPattern(message.turn_id, ID_PATTERN, `${pathName}.turn_id`, "a lowercase identifier", errors);
  if (!GROUPED_CONVERSATION_SCHEMAS.has(schema) && hasOwn(message, "turn_id")) {
    addError(errors, `${pathName}.turn_id`, "requires a conversation/0.1.1+ or conversation/0.2.1+ schema");
  }
  if (hasOwn(message, "role")) checkEnum(message.role, ROLES, `${pathName}.role`, errors);
  for (const field of ["name", "model"]) if (hasOwn(message, field)) checkString(message[field], `${pathName}.${field}`, errors);
  if (hasOwn(message, "timestamp")) checkDateTime(message.timestamp, `${pathName}.timestamp`, errors);
  if (hasOwn(message, "content") && checkArray(message.content, `${pathName}.content`, errors)) {
    message.content.forEach((block, blockIndex) => validateBlock(block, `${pathName}.content[${blockIndex}]`, errors, resources, sources, schema));
  }
}

function validateCurrentBranchGraph(messages, errors) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  const indexById = new Map();
  for (const [index, message] of messages.entries()) {
    if (!isObject(message) || typeof message.id !== "string" || !ID_PATTERN.test(message.id)) continue;
    if (!indexById.has(message.id)) indexById.set(message.id, index);
  }

  const parentsWithChildren = new Set();
  for (const [childIndex, message] of messages.entries()) {
    if (!isObject(message) || typeof message.parent_id !== "string") continue;
    const parentIndex = indexById.get(message.parent_id);
    if (parentIndex === undefined) continue;
    parentsWithChildren.add(message.parent_id);
    if (parentIndex >= childIndex) {
      addError(errors, `$.messages[${childIndex}].parent_id`, "an included parent message must appear before its child");
    }
  }

  const resolvedIds = new Set();
  for (const [startIndex, startMessage] of messages.entries()) {
    if (!isObject(startMessage) || typeof startMessage.id !== "string" || !indexById.has(startMessage.id)) continue;
    if (resolvedIds.has(startMessage.id)) continue;
    const path = [];
    const positionById = new Map();
    let currentId = startMessage.id;
    while (indexById.has(currentId) && !resolvedIds.has(currentId)) {
      if (positionById.has(currentId)) {
        addError(errors, `$.messages[${startIndex}]`, `branch graph contains a cycle through message id ${currentId}`);
        break;
      }
      positionById.set(currentId, path.length);
      path.push(currentId);
      const currentMessage = messages[indexById.get(currentId)];
      if (!isObject(currentMessage) || typeof currentMessage.parent_id !== "string") break;
      currentId = currentMessage.parent_id;
    }
    for (const id of path) resolvedIds.add(id);
  }

  const finalMessage = messages.at(-1);
  if (isObject(finalMessage) && typeof finalMessage.id === "string" && parentsWithChildren.has(finalMessage.id)) {
    addError(errors, `$.messages[${messages.length - 1}].id`, "the final message must be a leaf");
  }
}

function validateWarning(warning, index, errors, resources, messageCount) {
  const pathName = `$.warnings[${index}]`;
  if (!isObject(warning)) {
    addError(errors, pathName, "must be an object");
    return;
  }
  checkAllowedFields(warning, WARNING_FIELDS, pathName, errors);
  requireFields(warning, ["code"], pathName, errors);
  if (hasOwn(warning, "code")) checkPattern(warning.code, SLUG_PATTERN, `${pathName}.code`, "a lowercase slug", errors);
  if (hasOwn(warning, "message")) checkString(warning.message, `${pathName}.message`, errors);
  if (hasOwn(warning, "message_index")) {
    if (checkNumber(warning.message_index, `${pathName}.message_index`, errors, { integer: true, minimum: 0 }) && warning.message_index >= messageCount) {
      addError(errors, `${pathName}.message_index`, "must reference an existing message index");
    }
  }
  if (hasOwn(warning, "resource_id")) {
    checkPattern(warning.resource_id, ID_PATTERN, `${pathName}.resource_id`, "a lowercase identifier", errors);
    if (!resources.has(warning.resource_id)) addError(errors, `${pathName}.resource_id`, `unknown resource ${warning.resource_id}`);
  }
}

export function validateConversation(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["$: must be an object"] };
  checkSparse(value, "$", errors);
  checkAllowedFields(value, ROOT_FIELDS, "$", errors);
  const requiredRootFields = ["schema", "source_file", "source_sha256", "source_size_bytes", "title", "provider", "platform", "messages"];
  if (CONVERSATION_KEY_SCHEMAS.has(value.schema)) requiredRootFields.splice(1, 0, "conversation_key");
  if (GROUPED_CONVERSATION_SCHEMAS.has(value.schema)) requiredRootFields.splice(5, 0, "content_time");
  if (VERSION_WATERMARK_SCHEMAS.has(value.schema)) requiredRootFields.splice(1, 0, "parser_version");
  if (ADAPTER_WATERMARK_SCHEMAS.has(value.schema)) requiredRootFields.splice(2, 0, "parser_adapter");
  if (PARSED_AT_SCHEMAS.has(value.schema)) requiredRootFields.splice(3, 0, "parsed_at");
  requireFields(value, requiredRootFields, "$", errors);

  if (!CONVERSATION_SCHEMAS.has(value.schema)) addError(errors, "$.schema", `must equal ${[...CONVERSATION_SCHEMAS].join(" or ")}`);
  if (hasOwn(value, "parser_version")) {
    checkPattern(value.parser_version, SEMANTIC_VERSION_PATTERN, "$.parser_version", "a semantic Parser version", errors);
  }
  if (hasOwn(value, "parser_adapter")) {
    if (!isObject(value.parser_adapter)) {
      addError(errors, "$.parser_adapter", "must be an object");
    } else {
      checkAllowedFields(value.parser_adapter, new Set(["id", "version"]), "$.parser_adapter", errors);
      requireFields(value.parser_adapter, ["id", "version"], "$.parser_adapter", errors);
      if (hasOwn(value.parser_adapter, "id")) checkPattern(value.parser_adapter.id, SLUG_PATTERN, "$.parser_adapter.id", "a lowercase adapter id", errors);
      if (hasOwn(value.parser_adapter, "version")) checkPattern(value.parser_adapter.version, SEMANTIC_VERSION_PATTERN, "$.parser_adapter.version", "a semantic adapter version", errors);
    }
  }
  if (hasOwn(value, "exporter_version")) {
    checkPattern(value.exporter_version, NON_WHITESPACE_PATTERN, "$.exporter_version", "a value containing a non-whitespace character", errors);
  }
  if (!VERSION_WATERMARK_SCHEMAS.has(value.schema) && (hasOwn(value, "parser_version") || hasOwn(value, "exporter_version"))) {
    addError(errors, "$", "parser_version and exporter_version require a version-watermarked conversation schema");
  }
  if (!ADAPTER_WATERMARK_SCHEMAS.has(value.schema) && hasOwn(value, "parser_adapter")) {
    addError(errors, "$.parser_adapter", "requires a conversation/0.1.4+ or conversation/0.2.4+ schema");
  }
  if (hasOwn(value, "parsed_at")) checkDateTime(value.parsed_at, "$.parsed_at", errors);
  if (!PARSED_AT_SCHEMAS.has(value.schema) && hasOwn(value, "parsed_at")) {
    addError(errors, "$.parsed_at", "requires a conversation/0.1.5 or conversation/0.2.5 schema");
  }
  if (hasOwn(value, "conversation_id")) checkPattern(value.conversation_id, SHA256_PATTERN, "$.conversation_id", "a lowercase privacy-preserving SHA-256 identity", errors);
  if (hasOwn(value, "conversation_key")) checkPattern(value.conversation_key, SHA256_PATTERN, "$.conversation_key", "a lowercase privacy-preserving SHA-256 identity", errors);
  if (CONVERSATION_KEY_SCHEMAS.has(value.schema) && hasOwn(value, "conversation_id")) {
    addError(errors, "$.conversation_id", "is legacy-only; current schemas write conversation_key");
  }
  if (!CONVERSATION_KEY_SCHEMAS.has(value.schema) && hasOwn(value, "conversation_key")) {
    addError(errors, "$.conversation_key", "requires a conversation/0.1.2+ or conversation/0.2.2+ schema");
  }
  if (hasOwn(value, "conversation_id") && hasOwn(value, "conversation_key")) {
    addError(errors, "$", "must not contain both conversation_id and conversation_key");
  }
  if (hasOwn(value, "source_file")) {
    if (checkString(value.source_file, "$.source_file", errors) && /[\\/]/.test(value.source_file)) {
      addError(errors, "$.source_file", "must be a basename, not a local path");
    }
  }
  if (hasOwn(value, "source_sha256")) checkPattern(value.source_sha256, SHA256_PATTERN, "$.source_sha256", "a lowercase SHA-256", errors);
  if (hasOwn(value, "source_size_bytes")) checkNumber(value.source_size_bytes, "$.source_size_bytes", errors, { integer: true, minimum: 1 });
  if (hasOwn(value, "source_url")) checkHttpUrl(value.source_url, "$.source_url", errors);
  if (hasOwn(value, "exported_at")) checkDateTime(value.exported_at, "$.exported_at", errors);
  if (hasOwn(value, "content_time")) checkDateTime(value.content_time, "$.content_time", errors);
  if (!GROUPED_CONVERSATION_SCHEMAS.has(value.schema) && hasOwn(value, "content_time")) {
    addError(errors, "$.content_time", "requires a conversation/0.1.1+ or conversation/0.2.1+ schema");
  }
  if (hasOwn(value, "created_at")) checkDateTime(value.created_at, "$.created_at", errors);
  if (hasOwn(value, "updated_at")) checkDateTime(value.updated_at, "$.updated_at", errors);
  if (FLAT_CONVERSATION_SCHEMAS.has(value.schema) && (hasOwn(value, "created_at") || hasOwn(value, "updated_at"))) {
    addError(errors, "$", "created_at and updated_at require a conversation/0.2.x schema");
  }
  if (hasOwn(value, "title")) checkString(value.title, "$.title", errors);
  if (hasOwn(value, "provider")) checkPattern(value.provider, SLUG_PATTERN, "$.provider", "a lowercase slug", errors);
  if (hasOwn(value, "platform")) checkPattern(value.platform, SLUG_PATTERN, "$.platform", "a lowercase slug", errors);
  if (hasOwn(value, "models") && checkArray(value.models, "$.models", errors)) {
    value.models.forEach((model, index) => checkString(model, `$.models[${index}]`, errors));
    checkUniqueStrings(value.models, "$.models", errors);
  }

  const resources = new Map();
  if (hasOwn(value, "resources") && checkArray(value.resources, "$.resources", errors)) {
    value.resources.forEach((resource, index) => {
      validateResource(resource, index, errors);
      if (isObject(resource) && typeof resource.id === "string") {
        if (resources.has(resource.id)) addError(errors, `$.resources[${index}].id`, `duplicate resource id ${resource.id}`);
        resources.set(resource.id, resource);
      }
    });
  }

  const sources = new Map();
  if (hasOwn(value, "sources") && checkArray(value.sources, "$.sources", errors)) {
    value.sources.forEach((source, index) => {
      validateSource(source, index, errors);
      if (isObject(source) && typeof source.id === "string") {
        if (sources.has(source.id)) addError(errors, `$.sources[${index}].id`, `duplicate source id ${source.id}`);
        sources.set(source.id, source);
      }
    });
  }

  const messageIds = new Set();
  if (hasOwn(value, "messages") && checkArray(value.messages, "$.messages", errors)) {
    value.messages.forEach((message, index) => validateMessage(message, index, errors, resources, sources, messageIds, value.schema));
    if (BRANCH_GRAPH_SCHEMAS.has(value.schema)) validateCurrentBranchGraph(value.messages, errors);
  }

  if (hasOwn(value, "warnings") && checkArray(value.warnings, "$.warnings", errors)) {
    value.warnings.forEach((warning, index) => validateWarning(warning, index, errors, resources, Array.isArray(value.messages) ? value.messages.length : 0));
  }

  return { valid: errors.length === 0, errors };
}

async function runCli(files) {
  if (files.length === 0) {
    console.error("Usage: node schema/validate.mjs <conversation.json> [...]");
    process.exitCode = 2;
    return;
  }
  const reports = [];
  for (const filename of files) {
    try {
      const value = JSON.parse(await readFile(filename, "utf8"));
      const result = validateConversation(value);
      reports.push({ file: path.resolve(filename), ...result });
    } catch (error) {
      reports.push({ file: path.resolve(filename), valid: false, errors: [error.message] });
    }
  }
  console.log(JSON.stringify(reports, null, 2));
  if (reports.some((report) => !report.valid)) process.exitCode = 1;
}

const directUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === directUrl) await runCli(process.argv.slice(2));
