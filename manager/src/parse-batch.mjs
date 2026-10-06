import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText } from "../../parser/src/atomic.mjs";

export const PARSE_BATCH_SETTINGS_FORMAT = "cloudig/parse-batch-settings";
export const PARSE_BATCH_SETTINGS_VERSION = "0.2.0";
export const PARSE_BATCH_PLAN_FORMAT = "cloudig/parse-batch-plan";
export const PARSE_BATCH_PLAN_VERSION = "0.2.0";

const DEFAULTS = Object.freeze({
  archive_directory: "",
  parse_unparsed: true,
  parse_selected: true,
  update_outdated: false,
  preserve_previous: false
});
const MAX_ARCHIVE_DIRECTORY_NAME = 80;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanSetting(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizedArchiveDirectory(value) {
  const name = String(value || "").normalize("NFC").trim();
  if (!name) return "";
  if (Array.from(name).length > MAX_ARCHIVE_DIRECTORY_NAME
    || name === "."
    || name === ".."
    || name.startsWith(".")
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    || /[. ]$/u.test(name)
    || WINDOWS_RESERVED.test(name)) {
    throw new TypeError("archive_directory must be one valid Cloudig archive directory name or empty");
  }
  return name;
}

export function normalizeParseBatchSettings(value = {}) {
  if (!isRecord(value)) throw new TypeError("Parse batch settings must be an object");
  if (value.format !== undefined && value.format !== PARSE_BATCH_SETTINGS_FORMAT) {
    throw new TypeError(`Parse batch settings format must be ${PARSE_BATCH_SETTINGS_FORMAT}`);
  }
  if (value.version !== undefined && !["0.1.0", PARSE_BATCH_SETTINGS_VERSION].includes(value.version)) {
    throw new TypeError(`Unsupported parse batch settings version: ${value.version}`);
  }
  return Object.freeze({
    format: PARSE_BATCH_SETTINGS_FORMAT,
    version: PARSE_BATCH_SETTINGS_VERSION,
    archive_directory: normalizedArchiveDirectory(value.archive_directory ?? DEFAULTS.archive_directory),
    parse_unparsed: booleanSetting(value.parse_unparsed, DEFAULTS.parse_unparsed, "parse_unparsed"),
    parse_selected: booleanSetting(value.parse_selected, DEFAULTS.parse_selected, "parse_selected"),
    update_outdated: booleanSetting(value.update_outdated, DEFAULTS.update_outdated, "update_outdated"),
    preserve_previous: booleanSetting(value.preserve_previous, DEFAULTS.preserve_previous, "preserve_previous")
  });
}

export function serializeParseBatchSettings(value) {
  return `${JSON.stringify(normalizeParseBatchSettings(value), null, 2)}\n`;
}

export async function loadParseBatchSettings(filePath) {
  try {
    return normalizeParseBatchSettings(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeParseBatchSettings();
    throw new Error(`Cannot read parse-batch-settings.json: ${error.message}`, { cause: error });
  }
}

export async function saveParseBatchSettings(filePath, value) {
  const settings = normalizeParseBatchSettings(value);
  await atomicWriteText(filePath, serializeParseBatchSettings(settings));
  return settings;
}

function normalizedSelectedFiles(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError("selected_files must be an array");
  const selected = new Set();
  for (const value of values) {
    const name = String(value || "").trim();
    if (!name || path.basename(name) !== name || name === "." || name === "..") {
      throw new TypeError("selected_files must contain direct Inbox child names");
    }
    selected.add(name);
  }
  return [...selected].sort((left, right) => left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
}

function isClaudeContainer(file) {
  return file?.adapter === "anthropic-claude-export-json"
    || String(file?.source || "").toLowerCase() === "claude";
}

function hardBlockReason(file) {
  if (isClaudeContainer(file)) return "claude_selection_required";
  if (file?.status === "source_missing") return "source_missing";
  if (file?.status === "unsupported" || !file?.adapter) return "unsupported";
  const generations = new Set(file?.version_statuses || [file?.version_status]);
  if (generations.has("newer_generated")) return "newer_generated";
  if (generations.has("needs_reexport")) return "needs_reexport";
  if (file?.selective_update_required) return "selective_update_required";
  return "";
}

function planSeed({ paths, settings, selectedFiles, files, excluded }) {
  const archiveDirectory = settings.archive_directory;
  return {
    format: PARSE_BATCH_PLAN_FORMAT,
    version: PARSE_BATCH_PLAN_VERSION,
    library_root: paths.root,
    target_directory: archiveDirectory ? `Conversations/${archiveDirectory}` : "Conversations",
    archive_directory: archiveDirectory,
    delivery_mode: archiveDirectory ? "library_archive_directory" : "library",
    update_mode: settings.preserve_previous ? "preserve_previous" : "replace_previous",
    settings,
    selected_files: selectedFiles,
    files,
    excluded
  };
}

export function buildParseBatchPlan({ paths, summary, settings, selectedFiles = [] }) {
  const normalizedSettings = normalizeParseBatchSettings(settings);
  if (normalizedSettings.archive_directory) {
    const directories = new Set((summary?.archive?.directories || []).map((entry) => String(entry?.name || "")));
    if (!directories.has(normalizedSettings.archive_directory)) {
      throw new Error(`The selected Cloudig archive directory no longer exists: ${normalizedSettings.archive_directory}`);
    }
  }
  const normalizedSelection = normalizedSelectedFiles(selectedFiles);
  const byName = new Map((summary?.files || []).map((file) => [file.name, file]));
  const candidates = new Map();
  const excluded = [];

  function consider(file, reason) {
    const blocked = hardBlockReason(file);
    if (blocked) {
      excluded.push({ name: file.name, reason: blocked, requested_by: reason });
      return;
    }
    const sourcePath = file.source_path || `Inbox/${file.name}`;
    const current = candidates.get(sourcePath) || {
      name: file.name,
      source_path: sourcePath,
      size_bytes: Number(file.size_bytes) || 0,
      modified_at: file.modified_at,
      force: false,
      reasons: []
    };
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    if (reason !== "unparsed") current.force = true;
    candidates.set(sourcePath, current);
  }

  if (normalizedSettings.parse_unparsed) {
    for (const file of summary?.files || []) {
      if (file.status === "pending") consider(file, "unparsed");
    }
  }
  if (normalizedSettings.parse_selected) {
    for (const name of normalizedSelection) {
      const file = byName.get(name);
      if (!file) excluded.push({ name, reason: "not_found", requested_by: "selected" });
      else consider(file, "selected");
    }
  }
  if (normalizedSettings.update_outdated) {
    for (const file of summary?.files || []) {
      if ((file.version_statuses || [file.version_status]).includes("needs_reparse")) consider(file, "outdated");
    }
  }

  const files = [...candidates.values()]
    .map((file) => ({ ...file, reasons: [...file.reasons].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
  excluded.sort((left, right) => `${left.name}:${left.reason}:${left.requested_by}`.localeCompare(
    `${right.name}:${right.reason}:${right.requested_by}`,
    "zh-Hans-CN",
    { numeric: true, sensitivity: "base" }
  ));
  const seed = planSeed({
    paths,
    settings: normalizedSettings,
    selectedFiles: normalizedSelection,
    files,
    excluded
  });
  const planId = createHash("sha256").update(JSON.stringify(seed)).digest("hex");
  return Object.freeze({
    ok: true,
    ...seed,
    plan_id: planId,
    count: files.length,
    claude_automatic_parse: false,
    execution_supported: true,
    blocking_reason: ""
  });
}
