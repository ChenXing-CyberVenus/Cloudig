import { createRequire } from "node:module";
import { serializeV1 } from "../schema/canonical-v1.mjs";

const require = createRequire(import.meta.url);
const time = require("../time/core.js");
const timeSystem = require("../time/system.js");

export const FORMAT = "cloudig/library";
export const VERSION = "1.0.0";
export const CONVERSATION_SCHEMA = "ai-chat-archive/conversation/1.0.0";
export const CONTENT_TIME_SCHEMA = "cloudig/content-time/1.0.0";

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLATFORM_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ASSET_PATH = /^Data\/Assets\/(?:Covers|Avatars|PlatformIcons)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const ROOT_KEYS = new Set(["format", "version", "conversation_schema", "content_time_schema", "edited_at", "user", "assistant", "project", "preferences", "workflow_preferences", "platform_overrides", "conversation_overrides", "content_time_system"]);
const TIME_FIELDS = new Set(["content_time", "first_parsed_at", "last_parsed_at", "cloudig_edited_at", "source_captured_at", "source_conversation_created_at", "source_conversation_updated_at", "message_start", "message_end", "file_modified_at"]);
const SORT_MODES = new Set(["time_asc", "time_desc", "title_asc", "title_desc"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.path = path;
  throw error;
}

function object(value, path) {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function exactKeys(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
}

function required(value, fields, path) {
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(path, `missing required field ${field}`);
}

function text(value, path, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(path, "must be a string");
  const normalized = value.trim().normalize("NFC");
  if (!allowEmpty && !normalized) fail(path, "must not be empty");
  if ([...normalized].length > maximum) fail(path, `must not exceed ${maximum} Unicode code points`);
  return normalized;
}

function utc(value, path) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) fail(path, "must be an ISO date-time with offset");
  return new Date(value).toISOString();
}

function asset(value, path) {
  const normalized = text(value, path, 1000);
  if (!ASSET_PATH.test(normalized) || normalized.includes("..") || normalized.includes("\\") || normalized.includes("://")) fail(path, "must be a safe Data/Assets relative path");
  return normalized;
}

function nonEmpty(value, path) {
  if (!isRecord(value) || Object.keys(value).length === 0) fail(path, "must be a non-empty object");
  return value;
}

function normalizeIdentity(value, kind) {
  const path = `$.${kind}`;
  const allowed = kind === "user" ? new Set(["display_name", "avatar"]) : new Set(["display_name", "avatar", "apply_to_all"]);
  exactKeys(nonEmpty(value, path), allowed, path);
  const result = {};
  if (Object.hasOwn(value, "display_name")) result.display_name = text(value.display_name, `${path}.display_name`, 100);
  if (Object.hasOwn(value, "avatar")) result.avatar = asset(value.avatar, `${path}.avatar`);
  if (kind === "assistant" && Object.hasOwn(value, "apply_to_all")) {
    if (typeof value.apply_to_all !== "boolean") fail(`${path}.apply_to_all`, "must be boolean");
    result.apply_to_all = value.apply_to_all;
  }
  return result;
}

function normalizeProject(value) {
  const path = "$.project";
  exactKeys(nonEmpty(value, path), new Set(["title", "description", "icon", "cover"]), path);
  const result = {};
  if (Object.hasOwn(value, "title")) result.title = text(value.title, `${path}.title`, 200);
  if (Object.hasOwn(value, "description")) result.description = text(value.description, `${path}.description`, 1000);
  if (Object.hasOwn(value, "icon")) result.icon = asset(value.icon, `${path}.icon`);
  if (Object.hasOwn(value, "cover")) {
    exactKeys(nonEmpty(value.cover, `${path}.cover`), new Set(["path", "fit"]), `${path}.cover`);
    const cover = {};
    if (Object.hasOwn(value.cover, "path")) cover.path = asset(value.cover.path, `${path}.cover.path`);
    if (Object.hasOwn(value.cover, "fit")) {
      if (!["contain", "stretch"].includes(value.cover.fit)) fail(`${path}.cover.fit`, "must be contain or stretch");
      cover.fit = value.cover.fit;
    }
    result.cover = cover;
  }
  return result;
}

function normalizePreferences(value) {
  const path = "$.preferences";
  exactKeys(nonEmpty(value, path), new Set(["language", "theme", "name_rule_ack_version"]), path);
  const result = {};
  if (Object.hasOwn(value, "language")) {
    if (!["zh-CN", "en"].includes(value.language)) fail(`${path}.language`, "must be zh-CN or en");
    result.language = value.language;
  }
  if (Object.hasOwn(value, "theme")) {
    if (!["platform", "dawn", "star_night"].includes(value.theme)) fail(`${path}.theme`, "unsupported theme");
    result.theme = value.theme;
  }
  if (Object.hasOwn(value, "name_rule_ack_version")) {
    if (!Number.isSafeInteger(value.name_rule_ack_version) || value.name_rule_ack_version < 0) fail(`${path}.name_rule_ack_version`, "must be a non-negative safe integer");
    result.name_rule_ack_version = value.name_rule_ack_version;
  }
  return result;
}

function normalizeBatch(value, path, includeDirectory) {
  const keys = new Set([...(includeDirectory ? ["archive_directory"] : []), "parse_unparsed", "parse_selected", "update_outdated", "preserve_previous"]);
  exactKeys(value, keys, path);
  required(value, [...keys], path);
  const result = {};
  if (includeDirectory) result.archive_directory = text(value.archive_directory, `${path}.archive_directory`, 500, { allowEmpty: true });
  for (const key of ["parse_unparsed", "parse_selected", "update_outdated", "preserve_previous"]) {
    if (typeof value[key] !== "boolean") fail(`${path}.${key}`, "must be boolean");
    result[key] = value[key];
  }
  return result;
}

function normalizeWorkflowPreferences(value) {
  const path = "$.workflow_preferences";
  exactKeys(nonEmpty(value, path), new Set(["time_fields", "sorts", "parse_batch", "claude_batch"]), path);
  const result = {};
  if (Object.hasOwn(value, "time_fields")) {
    exactKeys(nonEmpty(value.time_fields, `${path}.time_fields`), new Set(["archiver", "claude", "reader"]), `${path}.time_fields`);
    result.time_fields = {};
    for (const [key, field] of Object.entries(value.time_fields)) {
      if (!TIME_FIELDS.has(field)) fail(`${path}.time_fields.${key}`, "unsupported time field");
      result.time_fields[key] = field;
    }
  }
  if (Object.hasOwn(value, "sorts")) {
    exactKeys(nonEmpty(value.sorts, `${path}.sorts`), new Set(["parser", "archiver", "claude", "reader"]), `${path}.sorts`);
    result.sorts = {};
    for (const [key, mode] of Object.entries(value.sorts)) {
      if (!SORT_MODES.has(mode)) fail(`${path}.sorts.${key}`, "unsupported sort mode");
      result.sorts[key] = mode;
    }
  }
  if (Object.hasOwn(value, "parse_batch")) result.parse_batch = normalizeBatch(value.parse_batch, `${path}.parse_batch`, true);
  if (Object.hasOwn(value, "claude_batch")) result.claude_batch = normalizeBatch(value.claude_batch, `${path}.claude_batch`, false);
  return result;
}

function normalizePlatformOverrides(value) {
  object(value, "$.platform_overrides");
  const result = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))) {
    if (!PLATFORM_KEY.test(key)) fail(`$.platform_overrides.${key}`, "invalid platform key");
    const item = nonEmpty(value[key], `$.platform_overrides.${key}`);
    exactKeys(item, new Set(["icon", "assistant_name", "assistant_avatar"]), `$.platform_overrides.${key}`);
    const normalized = {};
    if (Object.hasOwn(item, "icon")) normalized.icon = asset(item.icon, `$.platform_overrides.${key}.icon`);
    if (Object.hasOwn(item, "assistant_name")) normalized.assistant_name = text(item.assistant_name, `$.platform_overrides.${key}.assistant_name`, 100);
    if (Object.hasOwn(item, "assistant_avatar")) normalized.assistant_avatar = asset(item.assistant_avatar, `$.platform_overrides.${key}.assistant_avatar`);
    result[key] = normalized;
  }
  return result;
}

function normalizeContentTimeOverride(value, path) {
  exactKeys(value, new Set(["edit_id", "edited_at", "state", "range"]), path);
  required(value, ["edit_id", "edited_at", "state"], path);
  if (typeof value.edit_id !== "string" || !UUID.test(value.edit_id)) fail(`${path}.edit_id`, "must be a lowercase UUID");
  const result = { edit_id: value.edit_id, edited_at: utc(value.edited_at, `${path}.edited_at`) };
  if (value.state === "cleared") {
    if (Object.hasOwn(value, "range")) fail(`${path}.range`, "must be absent when state is cleared");
    result.state = "cleared";
    return result;
  }
  if (value.state !== "set") fail(`${path}.state`, "must be set or cleared");
  if (!Object.hasOwn(value, "range")) fail(path, "set state requires range");
  const validation = time.validateRange(value.range, { require_flags: true });
  if (!validation.valid) fail(`${path}.range${validation.errors[0].path.slice(1)}`, validation.errors[0].message);
  for (const endpoint of [validation.value.start, validation.value.end].filter(Boolean)) {
    if (endpoint.kind === "sovereign" && Object.hasOwn(endpoint, "snapshot")) fail(`${path}.range`, "Library authority stores Sovereign binding_id, not a conversation snapshot");
  }
  result.state = "set";
  result.range = validation.value;
  return result;
}

function normalizeConversationOverrides(value) {
  object(value, "$.conversation_overrides");
  const result = {};
  const allowed = new Set(["conversation_name", "provider", "platform", "models", "user_name", "assistant_name", "content_time"]);
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))) {
    if (!SHA256.test(key)) fail(`$.conversation_overrides.${key}`, "must use conversation_key");
    const item = nonEmpty(value[key], `$.conversation_overrides.${key}`);
    exactKeys(item, allowed, `$.conversation_overrides.${key}`);
    const normalized = {};
    if (Object.hasOwn(item, "conversation_name")) normalized.conversation_name = text(item.conversation_name, `$.conversation_overrides.${key}.conversation_name`, 500);
    if (Object.hasOwn(item, "provider")) normalized.provider = text(item.provider, `$.conversation_overrides.${key}.provider`, 100);
    if (Object.hasOwn(item, "platform")) normalized.platform = text(item.platform, `$.conversation_overrides.${key}.platform`, 100);
    if (Object.hasOwn(item, "models")) {
      if (!Array.isArray(item.models) || item.models.length === 0) fail(`$.conversation_overrides.${key}.models`, "must be a non-empty array");
      normalized.models = item.models.map((model, index) => text(model, `$.conversation_overrides.${key}.models[${index}]`, 500));
      if (new Set(normalized.models).size !== normalized.models.length) fail(`$.conversation_overrides.${key}.models`, "must not contain duplicates");
    }
    if (Object.hasOwn(item, "user_name")) normalized.user_name = text(item.user_name, `$.conversation_overrides.${key}.user_name`, 100);
    if (Object.hasOwn(item, "assistant_name")) normalized.assistant_name = text(item.assistant_name, `$.conversation_overrides.${key}.assistant_name`, 100);
    if (Object.hasOwn(item, "content_time")) normalized.content_time = normalizeContentTimeOverride(item.content_time, `$.conversation_overrides.${key}.content_time`);
    result[key] = normalized;
  }
  return result;
}

export function createDefaultWorkflowPreferencesV1() {
  return {
    time_fields: {
      archiver: "content_time",
      claude: "source_conversation_created_at",
      reader: "content_time"
    },
    sorts: {
      parser: "time_desc",
      archiver: "time_desc",
      claude: "time_desc",
      reader: "time_asc"
    },
    parse_batch: {
      archive_directory: "",
      parse_unparsed: true,
      parse_selected: true,
      update_outdated: false,
      preserve_previous: false
    },
    claude_batch: {
      parse_unparsed: true,
      parse_selected: true,
      update_outdated: false,
      preserve_previous: false
    }
  };
}

export function createLibraryV1({ edited_at, anchor, language = "zh-CN", theme = "platform" }) {
  return normalizeLibraryV1({
    format: FORMAT,
    version: VERSION,
    conversation_schema: CONVERSATION_SCHEMA,
    content_time_schema: CONTENT_TIME_SCHEMA,
    edited_at,
    preferences: { language, theme },
    workflow_preferences: createDefaultWorkflowPreferencesV1(),
    content_time_system: timeSystem.createContentTimeSystem(anchor)
  });
}

export function normalizeLibraryV1(value) {
  exactKeys(value, ROOT_KEYS, "$");
  required(value, ["format", "version", "conversation_schema", "content_time_schema", "edited_at", "content_time_system"], "$");
  if (value.format !== FORMAT) fail("$.format", `must equal ${FORMAT}`);
  if (value.version !== VERSION) fail("$.version", `must equal ${VERSION}`);
  if (value.conversation_schema !== CONVERSATION_SCHEMA) fail("$.conversation_schema", `must equal ${CONVERSATION_SCHEMA}`);
  if (value.content_time_schema !== CONTENT_TIME_SCHEMA) fail("$.content_time_schema", `must equal ${CONTENT_TIME_SCHEMA}`);
  const result = {
    format: FORMAT,
    version: VERSION,
    conversation_schema: CONVERSATION_SCHEMA,
    content_time_schema: CONTENT_TIME_SCHEMA,
    edited_at: utc(value.edited_at, "$.edited_at")
  };
  if (Object.hasOwn(value, "user")) result.user = normalizeIdentity(value.user, "user");
  if (Object.hasOwn(value, "assistant")) result.assistant = normalizeIdentity(value.assistant, "assistant");
  if (Object.hasOwn(value, "project")) result.project = normalizeProject(value.project);
  if (Object.hasOwn(value, "preferences")) result.preferences = normalizePreferences(value.preferences);
  if (Object.hasOwn(value, "workflow_preferences")) result.workflow_preferences = normalizeWorkflowPreferences(value.workflow_preferences);
  if (Object.hasOwn(value, "platform_overrides")) result.platform_overrides = normalizePlatformOverrides(value.platform_overrides);
  if (Object.hasOwn(value, "conversation_overrides")) result.conversation_overrides = normalizeConversationOverrides(value.conversation_overrides);
  result.content_time_system = timeSystem.normalizeContentTimeSystem(value.content_time_system);
  return result;
}

export function serializeLibraryV1(value) {
  return serializeV1(normalizeLibraryV1(value));
}
