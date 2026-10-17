import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultLibraryRoot,
  createDefaultLibraryV1,
  initializeLegacyLibraryForRegression,
  initializeLibrary,
  libraryPaths
} from "../../library/src/init.mjs";
import {
  assertLegacyWritable,
  isLibraryV1,
  normalizeLibraryDocument,
  serializeLibraryDocument
} from "../../library/compat.mjs";
import {
  DEFAULT_INPUT_ADAPTERS,
  createFileInput,
  probeInputAdapters
} from "../../parser/src/input-adapters.mjs";
import {
  conversationOutputGenerationStatus,
  parseCloudigLibrary,
  parseCloudigLibraryLegacyForRegression,
  reconcileCloudigState,
  sourceGenerationStatus,
  sourceRequiresReexport
} from "../../parser/src/library-orchestrator.mjs";
import { PARSER } from "../../parser/src/index.mjs";
import {
  extractClaudeConversations,
  getClaudeIndex,
  indexClaudeExport,
  listClaudeIndexes
} from "../../parser/src/claude-library.mjs";
import {
  loadParseState,
  saveParseState,
  setSourceState,
  sourceStateMap
} from "../../parser/src/parse-state.mjs";
import { createParseStateV1, serializeParseStateV1 } from "../../parser/src/parse-state-v1.mjs";
import {
  acquireFileTransactionLock,
  atomicWriteText,
  beginFileSnapshotTransaction,
  fingerprintFile,
  pathExists,
  sha256File
} from "../../parser/src/atomic.mjs";
import {
  buildParseBatchPlan,
  loadParseBatchSettings,
  normalizeParseBatchSettings,
  saveParseBatchSettings
} from "./parse-batch.mjs";
import { commitLibraryPreferencesCommand } from "./content-time-service.mjs";
import { moveConversationFiles, scanConversationArchive } from "./archive-library.mjs";
import {
  executeLibraryMove,
  planLibraryMove,
  recoverLibraryMove
} from "./library-move.mjs";
import {
  LIBRARY_HISTORY_MAX_TOTAL_BYTES,
  LIBRARY_HISTORY_MAX_VERSIONS,
  USER_STATE_HISTORY_FORMAT,
  USER_STATE_HISTORY_VERSION,
  createLibraryBackup,
  listLibraryBackups,
  readLibraryBackup
} from "./user-state-history.mjs";

const require = createRequire(import.meta.url);
const libraryCore = require("../../library/core.js");
const readerCore = require("../../reader/src/core.js");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_IMPORT_FILES = 1000;
const MAX_MARKDOWN_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_LIBRARY_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_READER_CONVERSATION_BYTES = 256 * 1024 * 1024;
const ASSET_USAGES = Object.freeze({
  cover: { directory: "covers", prefix: "cover" },
  project_icon: { directory: "covers", prefix: "project-icon" },
  user_avatar: { directory: "avatars", prefix: "user-avatar" },
  assistant_avatar: { directory: "avatars", prefix: "assistant-avatar" }
});
const IDENTITY_PLATFORMS = new Set([
  "chatgpt", "claude", "gemini", "grok", "qwen", "chatglm",
  "yuanbao", "zai", "deepseek", "kimi", "doubao", "mistral"
]);

function assetUsageDefinition(value) {
  const usage = String(value || "");
  if (ASSET_USAGES[usage]) return ASSET_USAGES[usage];
  const match = /^platform_assistant_avatar:([a-z0-9_-]+)$/u.exec(usage);
  if (!match || !IDENTITY_PLATFORMS.has(match[1])) return null;
  return { directory: "avatars", prefix: `${match[1]}-assistant-avatar` };
}

function detectRasterImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", mime_type: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", mime_type: "image/jpeg" };
  }
  const prefix = buffer.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return { extension: ".gif", mime_type: "image/gif" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: ".webp", mime_type: "image/webp" };
  }
  return null;
}

function resolveLibraryAsset(paths, relativePath) {
  const relative = String(relativePath || "").replaceAll("\\", "/");
  if (!/^Data\/Assets\/(?:Covers|Avatars|PlatformIcons)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(relative) || relative.includes("..")) return "";
  const absolute = path.resolve(paths.root, ...relative.split("/"));
  const assetRoot = path.resolve(paths.assets);
  return absolute.startsWith(`${assetRoot}${path.sep}`) ? absolute : "";
}

async function readReferencedAssets(paths, library) {
  const references = {
    user_avatar: library.user?.avatar,
    assistant_avatar: library.assistant?.avatar,
    project_icon: library.project?.icon,
    project_cover: library.project?.cover?.path
  };
  for (const [platform, override] of Object.entries(library.platform_overrides || {})) {
    if (override?.assistant_avatar) references[`platform_${platform}_assistant_avatar`] = override.assistant_avatar;
  }
  const assets = {};
  for (const [key, relativePath] of Object.entries(references)) {
    if (!relativePath) continue;
    const absolute = resolveLibraryAsset(paths, relativePath);
    if (!absolute) continue;
    try {
      const information = await stat(absolute);
      if (!information.isFile() || information.size < 1 || information.size > MAX_LIBRARY_ASSET_BYTES) continue;
      const bytes = await readFile(absolute);
      const image = detectRasterImage(bytes);
      if (!image) continue;
      assets[key] = {
        path: relativePath,
        mime_type: image.mime_type,
        size_bytes: bytes.length,
        data_url: `data:${image.mime_type};base64,${bytes.toString("base64")}`
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return assets;
}

async function readLibrary(paths) {
  const value = JSON.parse(await readFile(paths.library, "utf8"));
  return normalizeLibraryDocument(value);
}

function inputKind(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "html";
  if (extension === ".json") return "json";
  return extension.slice(1) || "file";
}

function metadataMatches(source, information) {
  return source?.size_bytes === information.size && source?.modified_at === information.mtime.toISOString();
}

function requiresSourceReexport(source) {
  return sourceRequiresReexport(source);
}

function versionStatus(source, { sourceMissing = false } = {}) {
  if (sourceMissing) return "source_missing";
  const generation = sourceGenerationStatus(source, PARSER.version);
  if (generation === "newer_generated") return generation;
  if (requiresSourceReexport(source)) return "needs_reexport";
  return generation;
}

function sourceVersionDetails(source, { sourceMissing = false } = {}) {
  const outputs = Array.isArray(source?.outputs) ? source.outputs : [];
  if (sourceMissing) {
    return {
      primary: "source_missing",
      statuses: ["source_missing"],
      counts: { source_missing: outputs.length }
    };
  }
  if (!outputs.length) {
    const primary = versionStatus(source);
    return { primary, statuses: [primary], counts: {} };
  }
  const counts = Object.create(null);
  for (const output of outputs) {
    const generation = conversationOutputGenerationStatus(source, output, PARSER.version);
    const status = generation === "newer_generated"
      ? generation
      : sourceRequiresReexport({ ...source, outputs: [output] })
        ? "needs_reexport"
        : generation;
    counts[status] = (counts[status] || 0) + 1;
  }
  const statuses = ["needs_reparse", "needs_reexport", "newer_generated", "current"]
    .filter((status) => Number(counts[status]) > 0);
  return {
    primary: statuses[0] || "current",
    statuses: statuses.length ? statuses : ["current"],
    counts: { ...counts }
  };
}

function outputVersionSummary(source) {
  const values = (field) => [...new Set((source?.outputs || [])
    .filter((output) => Object.prototype.hasOwnProperty.call(output || {}, field))
    .map((output) => String(output[field])))].sort();
  return {
    schemas: values("schema"),
    parser_versions: values("parser_version"),
    parser_adapters: [...new Map((source?.outputs || [])
      .filter((output) => output?.parser_adapter?.id && output?.parser_adapter?.version)
      .map((output) => [`${output.parser_adapter.id}@${output.parser_adapter.version}`, {
        id: output.parser_adapter.id,
        version: output.parser_adapter.version
      }])).values()].sort((left, right) => left.id.localeCompare(right.id, "en") || left.version.localeCompare(right.version, "en")),
    exporter_versions: values("exporter_version")
  };
}

async function existingConversationOutputs(paths, source, catalogByPath = null) {
  const existing = [];
  const effectiveOutputs = [];
  for (const output of source?.outputs || []) {
    let effectiveOutput = output;
    const relative = String(output?.path || "").replaceAll("\\", "/");
    const segments = relative.split("/");
    if (segments[0] !== "Conversations" || segments.length < 2 || !segments.at(-1).toLowerCase().endsWith(".json")
      || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      effectiveOutputs.push(effectiveOutput);
      continue;
    }
    const absolute = path.resolve(paths.root, ...relative.split("/"));
    const inside = path.relative(path.resolve(paths.conversations), absolute);
    if (!inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
      effectiveOutputs.push(effectiveOutput);
      continue;
    }
    const catalogEntry = catalogByPath?.get(relative.toLocaleLowerCase("en-US")) || null;
    if (catalogByPath) {
      if (catalogEntry) {
        existing.push(relative);
        effectiveOutput = { ...output };
        delete effectiveOutput.schema;
        delete effectiveOutput.schema_invalid;
        delete effectiveOutput.parser_version;
        delete effectiveOutput.parser_version_invalid;
        delete effectiveOutput.parser_adapter;
        delete effectiveOutput.exporter_version;
        if (catalogEntry.error_code !== "invalid_json") {
          if (catalogEntry.schema) effectiveOutput.schema = catalogEntry.schema;
          if (catalogEntry.parser_version) effectiveOutput.parser_version = catalogEntry.parser_version;
          if (catalogEntry.parser_adapter) effectiveOutput.parser_adapter = catalogEntry.parser_adapter;
          if (catalogEntry.exporter_version) effectiveOutput.exporter_version = catalogEntry.exporter_version;
        }
      }
    } else {
      try {
        const information = await stat(absolute);
        if (information.isFile()) {
          existing.push(relative);
          try {
            const document = JSON.parse(await readFile(absolute, "utf8"));
            effectiveOutput = { ...output };
            delete effectiveOutput.schema;
            delete effectiveOutput.schema_invalid;
            delete effectiveOutput.parser_version;
            delete effectiveOutput.parser_version_invalid;
            delete effectiveOutput.parser_adapter;
            delete effectiveOutput.exporter_version;
            if (document && Object.prototype.hasOwnProperty.call(document, "schema")) effectiveOutput.schema = document.schema;
            if (document && Object.prototype.hasOwnProperty.call(document, "parser_version")) effectiveOutput.parser_version = document.parser_version;
            if (document?.parser_adapter && typeof document.parser_adapter === "object") effectiveOutput.parser_adapter = document.parser_adapter;
            if (typeof document?.exporter_version === "string" && document.exporter_version) effectiveOutput.exporter_version = document.exporter_version;
          } catch {
            // A malformed target is not allowed to inherit reassuring version watermarks from parse-state.
            effectiveOutput = { ...output };
            delete effectiveOutput.schema;
            delete effectiveOutput.schema_invalid;
            delete effectiveOutput.parser_version;
            delete effectiveOutput.parser_version_invalid;
            delete effectiveOutput.parser_adapter;
            delete effectiveOutput.exporter_version;
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    effectiveOutputs.push(effectiveOutput);
  }
  return {
    paths: existing,
    source: source ? { ...source, outputs: effectiveOutputs } : source
  };
}

async function probeLibraryInput(absolute, name, information) {
  try {
    const input = await createFileInput(absolute, { relativePath: name, information });
    const selection = await probeInputAdapters(input, DEFAULT_INPUT_ADAPTERS);
    return {
      adapter: selection.adapter?.id || "",
      format: selection.probe?.format || "",
      source: selection.probe?.platform || "",
      error: ""
    };
  } catch (error) {
    return { adapter: "", format: "", source: "", error: String(error?.message || error) };
  }
}

export async function librarySummary(rootPath) {
  const paths = libraryPaths(rootPath);
  const libraryText = await readFile(paths.library, "utf8");
  const library = normalizeLibraryDocument(JSON.parse(libraryText));
  const parseBatchSettings = isLibraryV1(library)
    ? normalizeParseBatchSettings(library.workflow_preferences?.parse_batch || {})
    : await loadParseBatchSettings(paths.parseBatchSettings);
  let parseState = await loadParseState(paths.parseState);
  if (isLibraryV1(library) !== (parseState.version === "1.0.0")) {
    const error = new Error("Cloudig Library and parse-state generations do not match; complete or recover the V1 migration before continuing");
    error.code = "CLOUDIG_MIGRATION_INCOMPLETE";
    throw error;
  }
  const reconciliation = await reconcileCloudigState(paths, parseState);
  parseState = reconciliation.state;
  if (reconciliation.changed) await saveParseState(paths.parseState, parseState);
  const archive = await scanConversationArchive(paths, library);
  const conversationCatalog = new Map(archive.files.map((entry) => [
    entry.relative_path.toLocaleLowerCase("en-US"),
    entry
  ]));
  const registered = sourceStateMap(parseState);
  const entries = await readdir(paths.inbox, { withFileTypes: true });
  const files = [];
  const present = new Set();
  const existingConversationPaths = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }))) {
    if (!entry.isFile()) continue;
    const absolute = path.join(paths.inbox, entry.name);
    const information = await stat(absolute);
    const sourcePath = `Inbox/${entry.name}`;
    const source = registered.get(sourcePath) || null;
    const metadataCurrent = Boolean(
      source
      && metadataMatches(source, information)
      && (source.status !== "pending" || source.source_adapter)
    );
    const detected = metadataCurrent ? null : await probeLibraryInput(absolute, entry.name, information);
    const inspectedOutputs = await existingConversationOutputs(paths, source, conversationCatalog);
    const existingOutputs = inspectedOutputs.paths;
    const effectiveSource = inspectedOutputs.source;
    existingOutputs.forEach((output) => existingConversationPaths.add(output));
    present.add(sourcePath);
    let status = metadataCurrent
      ? source.status
      : detected?.error
        ? "failed"
        : detected?.adapter
          ? "pending"
          : "unsupported";
    if (status === "success" && existingOutputs.length !== (source?.outputs?.length || 0)) status = "pending";
    const generation = sourceVersionDetails(effectiveSource);
    files.push({
      name: entry.name,
      source_path: sourcePath,
      type: inputKind(entry.name),
      size_bytes: information.size,
      modified_at: information.mtime.toISOString(),
      source_created_at: source?.captured_at?.value || source?.source_created_at
        || (Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0
          ? information.birthtime
          : information.ctime).toISOString(),
      format: metadataCurrent ? source?.adapter?.format || "" : detected?.format || "",
      adapter: metadataCurrent ? source?.adapter?.id || "" : detected?.adapter || "",
      source: metadataCurrent ? source?.source_adapter?.id || "" : detected?.source || "",
      status,
      version_status: generation.primary,
      version_statuses: generation.statuses,
      version_counts: generation.counts,
      version_output_count: effectiveSource?.outputs?.length || 0,
      selective_update_required: (effectiveSource?.outputs?.length || 0) > 1
        && Number(generation.counts.needs_reparse) > 0,
      versions: outputVersionSummary(effectiveSource),
      last_attempt_at: source?.last_attempt_at || "",
      last_success_at: source?.last_success_at || "",
      conversations: existingOutputs.length,
      outputs: (source?.outputs || []).map((output) => output.path),
      error: metadataCurrent ? source?.error?.message || "" : detected?.error || ""
    });
  }
  for (const source of parseState.sources) {
    if (present.has(source.path)) continue;
    const inspectedOutputs = await existingConversationOutputs(paths, source, conversationCatalog);
    const existingOutputs = inspectedOutputs.paths;
    const effectiveSource = inspectedOutputs.source;
    existingOutputs.forEach((output) => existingConversationPaths.add(output));
    if (source.dismissed === true) continue;
    const generation = sourceVersionDetails(effectiveSource, { sourceMissing: true });
    files.push({
      name: path.basename(source.path),
      source_path: source.path,
      type: inputKind(source.path),
      size_bytes: source.size_bytes,
      modified_at: source.modified_at,
      source_created_at: source.captured_at?.value || source.source_created_at || "",
      format: source.adapter?.format || "",
      adapter: source.adapter?.id || "",
      source: source.source_adapter?.id || "",
      status: "source_missing",
      version_status: generation.primary,
      version_statuses: generation.statuses,
      version_counts: generation.counts,
      version_output_count: effectiveSource?.outputs?.length || 0,
      selective_update_required: false,
      versions: outputVersionSummary(effectiveSource),
      last_attempt_at: source.last_attempt_at || "",
      last_success_at: source.last_success_at || "",
      conversations: existingOutputs.length,
      outputs: (source.outputs || []).map((output) => output.path),
      error: source.error?.message || "The Inbox source is missing"
    });
  }
  files.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
  const claude = await listClaudeIndexes(paths.root);
  const claudeBySource = new Map(claude.map((index) => [index.source.file, index]));
  for (const file of files) {
    if (file.adapter !== "anthropic-claude-export-json" || file.status === "source_missing") continue;
    const index = claudeBySource.get(file.name);
    if (!index) continue;
    const counts = index.counts?.version_statuses || {};
    const statuses = ["needs_reparse", "needs_reexport", "newer_generated", "current"]
      .filter((status) => Number(counts[status]) > 0);
    file.version_counts = { ...counts };
    file.version_output_count = Object.values(counts).reduce((total, count) => total + (Number(count) || 0), 0);
    file.version_statuses = statuses.length ? statuses : ["current"];
    file.selective_update_required = false;
    file.version_status = statuses.includes("needs_reparse")
      ? "needs_reparse"
      : statuses.includes("needs_reexport")
        ? "needs_reexport"
        : statuses.includes("newer_generated")
          ? "newer_generated"
          : "current";
  }
  const statuses = Object.create(null);
  for (const file of files) statuses[file.status] = (statuses[file.status] || 0) + 1;
  const versionStatuses = Object.create(null);
  for (const file of files) {
    for (const [status, count] of Object.entries(file.version_counts || {})) {
      versionStatuses[status] = (versionStatuses[status] || 0) + (Number(count) || 0);
    }
  }
  const defaultIdentity = isLibraryV1(library)
    ? {
        user: { display_name: library.user?.display_name || (library.preferences?.language === "en" ? "User" : "采云用户") },
        assistant: { display_name: library.assistant?.display_name || (library.preferences?.language === "en" ? "AI" : "智能伙伴") }
      }
    : libraryCore.resolveConversationIdentity({ platform: "" }, library);
  return Object.freeze({
    ok: true,
    library: {
      root: paths.root,
      format: `${library.format}/${library.version}`,
      user_name: defaultIdentity.user.display_name,
      assistant_name: defaultIdentity.assistant.display_name,
      language: library.preferences?.language || "zh-CN",
      theme: library.preferences?.theme || "platform"
    },
    overlay: {
      document: library,
      sha256: createHash("sha256").update(libraryText).digest("hex"),
      assets: await readReferencedAssets(paths, library)
    },
    counts: {
      inbox: files.filter((file) => file.status !== "source_missing").length,
      conversations: archive.counts.active,
      statuses,
      version_statuses: versionStatuses
    },
    parse_batch: {
      settings: parseBatchSettings,
      target_directory: parseBatchSettings.archive_directory
        ? `Conversations/${parseBatchSettings.archive_directory}`
        : "Conversations"
    },
    files,
    claude,
    archive
  });
}

function normalizedInboxSourcePath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!/^Inbox\/[^/]+$/u.test(normalized)) {
    throw new Error("Cloudig missing-source cleanup requires one registered direct Inbox child");
  }
  return normalized;
}

function restoredSourceStatus(source) {
  if (source.last_success_at || (source.outputs || []).length) return "success";
  if (source.adapter?.id) return "pending";
  return "unsupported";
}

export async function dismissMissingSources(rootPath, { sourcePath = "", all = false } = {}) {
  const paths = libraryPaths(rootPath);
  await readLibrary(paths);
  let state = await loadParseState(paths.parseState);
  const reconciliation = await reconcileCloudigState(paths, state);
  state = reconciliation.state;
  const requested = [];
  if (all) {
    for (const source of state.sources) {
      if (source.dismissed === true) continue;
      const absolute = path.resolve(paths.root, ...source.path.split("/"));
      if (!await pathExists(absolute)) requested.push(source.path);
    }
  } else {
    requested.push(normalizedInboxSourcePath(sourcePath));
  }
  const dismissed = [];
  const skipped = [];
  const restored = [...new Set([
    ...reconciliation.source_restored,
    ...reconciliation.source_renames.map((item) => item.from)
  ])];
  let retainedOutputs = 0;

  for (const registeredPath of requested) {
    const source = sourceStateMap(state).get(registeredPath);
    if (!source) {
      skipped.push({ path: registeredPath, reason: "not_registered" });
      continue;
    }
    const absolute = path.resolve(paths.root, ...registeredPath.split("/"));
    if (path.dirname(absolute) !== path.resolve(paths.inbox)) {
      skipped.push({ path: registeredPath, reason: "unsafe_path" });
      continue;
    }
    if (await pathExists(absolute)) {
      state = setSourceState(state, {
        ...source,
        status: restoredSourceStatus(source),
        dismissed: false,
        error: undefined
      });
      restored.push(registeredPath);
      skipped.push({ path: registeredPath, reason: "source_restored" });
      continue;
    }
    if (source.dismissed === true) {
      skipped.push({ path: registeredPath, reason: "already_dismissed" });
      continue;
    }
    retainedOutputs += (await existingConversationOutputs(paths, source)).paths.length;
    state = setSourceState(state, {
      ...source,
      status: "source_missing",
      dismissed: true,
      error: {
        code: "source_missing",
        message: "The registered Inbox source is no longer present; derived conversations were retained"
      }
    });
    dismissed.push(registeredPath);
  }
  if (reconciliation.changed || dismissed.length || restored.length) await saveParseState(paths.parseState, state);
  return Object.freeze({
    ok: true,
    dismissed,
    skipped,
    restored: [...new Set(restored)],
    retained_outputs: retainedOutputs,
    dismissed_count: dismissed.length,
    skipped_count: skipped.length,
    restored_count: new Set(restored).size
  });
}

export async function createLibrary(rootPath = defaultLibraryRoot(), options = {}) {
  const initialized = await initializeLibrary(rootPath, options);
  return { initialized, summary: await librarySummary(initialized.root) };
}

export async function createLibraryLegacyForRegression(rootPath = defaultLibraryRoot(), options = {}) {
  const initialized = await initializeLegacyLibraryForRegression(rootPath, options);
  return { initialized, summary: await librarySummary(initialized.root) };
}

async function inspectLegacyDataDirectory(directory, label, result) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const relative = `${label}/${entry.name}`;
    if (entry.isDirectory()) await inspectLegacyDataDirectory(path.join(directory, entry.name), relative, result);
    else {
      result.count += 1;
      if (result.samples.length < 12) result.samples.push(relative);
    }
  }
}

function textTargetState(target, text) {
  return {
    target,
    exists: true,
    sizeBytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex")
  };
}

function fingerprintTargetState(target, fingerprint) {
  if (!fingerprint.exists) return { target, exists: false };
  if (fingerprint.regularFile !== true || fingerprint.stable === false) {
    const error = new Error(`Cloudig V1 initialization target is not a stable regular file: ${path.basename(target)}`);
    error.code = "CLOUDIG_V1_INITIALIZATION_CONFLICT";
    throw error;
  }
  return { target, exists: true, sizeBytes: fingerprint.sizeBytes, sha256: fingerprint.sha256 };
}

export async function prepareEmptyLegacyLibraryV1(rootPath = defaultLibraryRoot(), options = {}) {
  const paths = libraryPaths(rootPath);
  const lock = await acquireFileTransactionLock(paths.root, { signal: options.signal || null });
  let status = "ready";
  let legacyEntries = { count: 0, samples: [] };
  try {
    await mkdir(paths.inbox, { recursive: true });
    await mkdir(paths.conversations, { recursive: true });
    const libraryText = await readFile(paths.library, "utf8");
    const library = normalizeLibraryDocument(JSON.parse(libraryText));
    const parseState = await loadParseState(paths.parseState);
    if (isLibraryV1(library)) {
      if (parseState.version !== "1.0.0") {
        const error = new Error("Cloudig Library 1.0 and parse-state are not the same generation");
        error.code = "CLOUDIG_LIBRARY_INITIALIZATION_INCOMPLETE";
        throw error;
      }
    } else {
      if (parseState.version === "1.0.0") {
        const error = new Error("Legacy Cloudig Library is paired with parse-state 1.0");
        error.code = "CLOUDIG_LIBRARY_INITIALIZATION_INCOMPLETE";
        throw error;
      }
      const inbox = { count: 0, samples: [] };
      const conversations = { count: 0, samples: [] };
      await inspectLegacyDataDirectory(paths.inbox, "Inbox", inbox);
      await inspectLegacyDataDirectory(paths.conversations, "Conversations", conversations);
      legacyEntries = {
        count: inbox.count + conversations.count,
        inbox: inbox.count,
        conversations: conversations.count,
        samples: [...inbox.samples, ...conversations.samples].slice(0, 12)
      };
      if (legacyEntries.count) status = "legacy_nonempty";
      else {
        const clock = typeof options.clock === "function" ? options.clock : () => new Date();
        const nextLibraryText = serializeLibraryDocument(createDefaultLibraryV1({
          clock,
          language: options.language || "zh-CN",
          theme: options.theme || "platform"
        }));
        const nextParseStateText = serializeParseStateV1(createParseStateV1());
        const targets = [
          { target: paths.library, text: nextLibraryText },
          { target: paths.parseState, text: nextParseStateText }
        ];
        const preconditions = [];
        for (const target of targets) preconditions.push(fingerprintTargetState(target.target, await fingerprintFile(target.target)));
        const transaction = await beginFileSnapshotTransaction(paths.root, targets.map((entry) => entry.target), {
          lock,
          preconditionTargets: preconditions,
          expectedTargets: targets.map((entry) => textTargetState(entry.target, entry.text))
        });
        try {
          await transaction.beginMutation();
          for (const target of targets) {
            const before = preconditions.find((entry) => entry.target === target.target);
            await transaction.assertBefore(target.target);
            await atomicWriteText(target.target, target.text, {
              precondition: before.exists
                ? { exists: true, sizeBytes: before.sizeBytes, sha256: before.sha256 }
                : { exists: false }
            });
          }
          await transaction.commit();
          status = "initialized_v1";
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
      }
    }
  } finally {
    await lock.release();
  }
  await initializeLibrary(paths.root, options);
  return Object.freeze({
    ok: status !== "legacy_nonempty",
    status,
    legacy_entries: legacyEntries,
    summary: await librarySummary(paths.root)
  });
}

function collisionName(originalName, index) {
  const extension = path.extname(originalName);
  const stem = path.basename(originalName, extension);
  return `${stem} (${index})${extension}`;
}

async function chooseImportTarget(inbox, originalName, sourcePath) {
  const initial = path.join(inbox, path.basename(originalName));
  if (path.resolve(initial).toLowerCase() === path.resolve(sourcePath).toLowerCase()) return { target: initial, alreadyInInbox: true };
  if (!await pathExists(initial)) return { target: initial, alreadyInInbox: false };
  const [sourceInformation, targetInformation] = await Promise.all([stat(sourcePath), stat(initial)]);
  if (sourceInformation.size === targetInformation.size && await sha256File(sourcePath) === await sha256File(initial)) {
    return { target: initial, alreadyInInbox: true };
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.join(inbox, collisionName(originalName, index));
    if (!await pathExists(candidate)) return { target: candidate, alreadyInInbox: false };
  }
  throw new Error(`Too many Inbox name collisions for ${path.basename(originalName)}`);
}

async function copyImportAtomically(source, target) {
  const before = await stat(source);
  const temporary = path.join(path.dirname(target), `.cloudig-import-${process.pid}-${randomUUID()}`);
  const hash = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      createReadStream(source),
      hashingStream,
      createWriteStream(temporary, { flags: "wx" })
    );
    const [after, copied] = await Promise.all([stat(source), stat(temporary)]);
    if (before.size !== after.size || before.mtime.toISOString() !== after.mtime.toISOString() || copied.size !== before.size) {
      throw new Error(`Source changed while Cloudig was importing ${path.basename(source)}`);
    }
    await rename(temporary, target);
    return { size_bytes: copied.size, sha256: hash.digest("hex") };
  } finally {
    await rm(temporary, { force: true });
  }
}

function importRejectionReason(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error);
  if (code === "ENOENT") return "source_not_found";
  if (code === "EACCES" || code === "EPERM") return "source_access_denied";
  if (message === "not a regular file") return "not_regular_file";
  if (message.startsWith("Input format is ambiguous between ")) return "ambiguous_format";
  if (message.startsWith("Source changed while Cloudig was importing ")) return "source_changed";
  return "import_failed";
}

async function registerImportedSource(paths, state, input, selection, target, sha256) {
  const sourcePath = `Inbox/${path.basename(target)}`;
  const previous = sourceStateMap(state).get(sourcePath) || null;
  const information = await stat(target);
  const status = previous && previous.status !== "source_missing" ? previous.status : "pending";
  const v1 = state.version === "1.0.0";
  const next = setSourceState(state, {
    ...(previous || {}),
    path: sourcePath,
    size_bytes: information.size,
    modified_at: information.mtime.toISOString(),
    ...(v1
      ? { captured_at: previous?.captured_at || { value: input.earliestCreatedOrModifiedAt, basis: "filesystem_earliest_create_or_modify" } }
      : { source_created_at: previous?.source_created_at || input.createdAt }),
    sha256,
    source_key: previous?.source_key || sha256,
    adapter: previous?.adapter || {
      id: selection.adapter.id,
      version: selection.adapter.version,
      format: selection.probe.format
    },
    parser_version: previous?.parser_version || PARSER.version,
    status,
    outputs: previous?.outputs || [],
    dismissed: false,
    error: status === "pending" ? undefined : previous?.error
  });
  await saveParseState(paths.parseState, next);
  return next;
}

export async function importFiles(rootPath, sourcePaths, { adapters = DEFAULT_INPUT_ADAPTERS } = {}) {
  const paths = libraryPaths(rootPath);
  await readLibrary(paths);
  await mkdir(paths.inbox, { recursive: true });
  const selected = [...new Set((sourcePaths || []).map((value) => path.resolve(String(value))))];
  if (!selected.length) return { ok: true, imported: [], rejected: [] };
  if (selected.length > MAX_IMPORT_FILES) throw new Error(`At most ${MAX_IMPORT_FILES} files can be imported at once`);
  const imported = [];
  const rejected = [];
  let parseState = await loadParseState(paths.parseState);
  for (const sourcePath of selected) {
    try {
      const information = await stat(sourcePath);
      if (!information.isFile()) throw new Error("not a regular file");
      const input = await createFileInput(sourcePath, { relativePath: path.basename(sourcePath), information });
      const selection = await probeInputAdapters(input, adapters);
      if (!selection.adapter) {
        rejected.push({ file: path.basename(sourcePath), reason: "unsupported_format" });
        continue;
      }
      const destination = await chooseImportTarget(paths.inbox, input.name, sourcePath);
      if (destination.alreadyInInbox) {
        const sha256 = await sha256File(destination.target);
        parseState = (await reconcileCloudigState(paths, parseState)).state;
        parseState = await registerImportedSource(paths, parseState, input, selection, destination.target, sha256);
        imported.push({ file: path.basename(destination.target), status: "unchanged", adapter: selection.adapter.id, format: selection.probe.format });
        continue;
      }
      const copied = await copyImportAtomically(sourcePath, destination.target);
      parseState = (await reconcileCloudigState(paths, parseState)).state;
      parseState = await registerImportedSource(paths, parseState, input, selection, destination.target, copied.sha256);
      imported.push({
        file: path.basename(destination.target),
        status: "imported",
        adapter: selection.adapter.id,
        format: selection.probe.format,
        size_bytes: copied.size_bytes,
        sha256: copied.sha256
      });
    } catch (error) {
      rejected.push({ file: path.basename(sourcePath), reason: importRejectionReason(error) });
    }
  }
  return { ok: rejected.length === 0, imported, rejected };
}

export async function importLibraryAsset(rootPath, sourcePath, usage) {
  const paths = libraryPaths(rootPath);
  await readLibrary(paths);
  const definition = assetUsageDefinition(usage);
  if (!definition) throw new Error("Unsupported Cloudig asset usage");
  const source = path.resolve(String(sourcePath || ""));
  const information = await stat(source);
  if (!information.isFile()) throw new Error("Selected Cloudig asset is not a regular file");
  if (information.size < 1 || information.size > MAX_LIBRARY_ASSET_BYTES) {
    throw new Error(`Cloudig images must be between 1 byte and ${MAX_LIBRARY_ASSET_BYTES} bytes`);
  }
  const bytes = await readFile(source);
  const image = detectRasterImage(bytes);
  if (!image) throw new Error("Cloudig currently accepts PNG, JPEG, GIF, or WebP images");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = paths[definition.directory];
  await mkdir(directory, { recursive: true });
  const name = `${definition.prefix}-${sha256.slice(0, 20)}${image.extension}`;
  const target = path.join(directory, name);
  let status = "unchanged";
  if (!await pathExists(target)) {
    await copyImportAtomically(source, target);
    status = "imported";
  } else if (await sha256File(target) !== sha256) {
    throw new Error("Cloudig asset hash collision detected");
  }
  const relativePath = path.relative(paths.root, target).replaceAll(path.sep, "/");
  return {
    ok: true,
    status,
    usage,
    path: relativePath,
    mime_type: image.mime_type,
    size_bytes: bytes.length,
    sha256,
    data_url: `data:${image.mime_type};base64,${bytes.toString("base64")}`
  };
}

export async function parseLibrary(rootPath, { selectedFile = "", force = false, preservePrevious = false, signal = null, clock = () => new Date() } = {}) {
  return parseCloudigLibrary({ root: rootPath, selectedFile, force, preservePrevious, signal, clock });
}

export async function parseLibraryLegacyForRegression(rootPath, options = {}) {
  return parseCloudigLibraryLegacyForRegression({ root: rootPath, ...options });
}

export async function planLibraryRelocation(rootPath, targetRoot, options = {}) {
  return planLibraryMove(rootPath, targetRoot, options);
}

export async function executeLibraryRelocation(confirmedPlan, options = {}) {
  return executeLibraryMove(confirmedPlan, options);
}

export async function recoverLibraryRelocation(pendingPlan, options = {}) {
  return recoverLibraryMove(pendingPlan, options);
}

export async function getParseBatchSettings(rootPath) {
  const paths = libraryPaths(rootPath);
  const library = await readLibrary(paths);
  const settings = isLibraryV1(library)
    ? normalizeParseBatchSettings(library.workflow_preferences?.parse_batch || {})
    : await loadParseBatchSettings(paths.parseBatchSettings);
  return {
    ok: true,
    settings,
    target_directory: settings.archive_directory ? `Conversations/${settings.archive_directory}` : "Conversations"
  };
}

export async function setParseBatchSettings(rootPath, settings) {
  const paths = libraryPaths(rootPath);
  const library = await readLibrary(paths);
  const normalized = normalizeParseBatchSettings(settings);
  if (normalized.archive_directory) {
    const archive = await scanConversationArchive(paths);
    if (!archive.directories.some((entry) => entry.name === normalized.archive_directory)) {
      throw new Error(`The selected Cloudig archive directory no longer exists: ${normalized.archive_directory}`);
    }
  }
  let saved;
  if (isLibraryV1(library)) {
    const libraryBytes = await readFile(paths.library);
    await commitLibraryPreferencesCommand(paths.root, {
      request_id: randomUUID(),
      expected_library_sha256: createHash("sha256").update(libraryBytes).digest("hex"),
      patch: {
        workflow_preferences: {
          parse_batch: {
            archive_directory: normalized.archive_directory,
            parse_unparsed: normalized.parse_unparsed,
            parse_selected: normalized.parse_selected,
            update_outdated: normalized.update_outdated,
            preserve_previous: normalized.preserve_previous
          }
        }
      }
    });
    saved = normalized;
  } else {
    saved = await saveParseBatchSettings(paths.parseBatchSettings, normalized);
  }
  return {
    ok: true,
    settings: saved,
    target_directory: saved.archive_directory ? `Conversations/${saved.archive_directory}` : "Conversations"
  };
}

export async function planParseBatch(rootPath, { selectedFiles = [] } = {}) {
  const paths = libraryPaths(rootPath);
  const [summary, library] = await Promise.all([
    librarySummary(paths.root),
    readLibrary(paths)
  ]);
  const settings = isLibraryV1(library)
    ? normalizeParseBatchSettings(library.workflow_preferences?.parse_batch || {})
    : await loadParseBatchSettings(paths.parseBatchSettings);
  return buildParseBatchPlan({ paths, summary, settings, selectedFiles });
}

function parseBackupPath(paths, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  if (!/^Data\/Backups\/[^/]+$/u.test(normalized)) throw new Error(`Unsafe Parser backup path: ${relativePath}`);
  const target = path.resolve(paths.root, ...normalized.split("/"));
  if (path.dirname(target) !== path.resolve(paths.backups)) throw new Error(`Parser backup escapes Data/Backups: ${relativePath}`);
  return target;
}

async function discardAutomaticParseBackup(paths, relativePath) {
  if (!relativePath) return false;
  const target = parseBackupPath(paths, relativePath);
  await rm(target, { recursive: true, force: true });
  return true;
}

function assertSameParseBatchPlan(expected, current) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new TypeError("Confirmed parse batch plan must be an object");
  }
  if (String(expected.plan_id || "") !== current.plan_id) {
    const error = new Error("The one-click parse plan changed after confirmation; review the refreshed file list before parsing");
    error.code = "CLOUDIG_PARSE_PLAN_CHANGED";
    throw error;
  }
}

async function executeParseBatchWith(rootPath, confirmedPlan, { signal = null, onProgress = null } = {}, parseOperation) {
  const paths = libraryPaths(rootPath);
  const selectedFiles = Array.isArray(confirmedPlan?.selected_files) ? confirmedPlan.selected_files : [];
  const currentPlan = await planParseBatch(paths.root, { selectedFiles });
  assertSameParseBatchPlan(confirmedPlan, currentPlan);

  for (const file of currentPlan.files) {
    const absolute = path.join(paths.inbox, file.name);
    const information = await stat(absolute);
    if (information.size !== file.size_bytes || information.mtime.toISOString() !== file.modified_at) {
      const error = new Error(`The one-click parse source changed after confirmation: ${file.name}`);
      error.code = "CLOUDIG_PARSE_PLAN_CHANGED";
      throw error;
    }
  }

  const parsedResults = [];
  let discardedBackups = 0;
  const totalBytes = currentPlan.files.reduce((sum, file) => sum + Number(file.size_bytes || 0), 0);
  let completedBytes = 0;
  const batchTime = new Date();
  if (typeof onProgress === "function") await onProgress({
    phase: "parse_batch",
    bytesDone: 0,
    bytesTotal: totalBytes,
    itemsDone: 0
  });
  for (const [fileIndex, file] of currentPlan.files.entries()) {
    if (signal?.aborted) throw Object.assign(new Error("Cloudig one-click parsing was cancelled"), { name: "AbortError", code: "ABORT_ERR" });
    const result = await parseOperation(paths.root, {
      selectedFile: file.name,
      force: file.force,
      preservePrevious: currentPlan.settings.preserve_previous,
      signal,
      clock: () => batchTime
    });
    if (signal?.aborted) throw Object.assign(new Error("Cloudig one-click parsing was cancelled"), { name: "AbortError", code: "ABORT_ERR" });
    for (const item of result.files || []) {
      if (!currentPlan.settings.preserve_previous && item.backup) {
        discardedBackups += await discardAutomaticParseBackup(paths, item.backup) ? 1 : 0;
      }
      parsedResults.push({ ...item, requested_by: file.reasons });
    }
    completedBytes += Number(file.size_bytes || 0);
    if (typeof onProgress === "function") await onProgress({
      phase: "parse_batch",
      bytesDone: completedBytes,
      bytesTotal: totalBytes,
      itemsDone: fileIndex + 1
    });
  }
  if (signal?.aborted) throw Object.assign(new Error("Cloudig one-click parsing was cancelled"), { name: "AbortError", code: "ABORT_ERR" });
  const successfulOutputs = [...new Set(parsedResults
    .filter((item) => item.status === "success")
    .flatMap((item) => item.outputs || []))];
  const movement = currentPlan.archive_directory && successfulOutputs.length
    ? await moveConversationFiles(paths.root, successfulOutputs, currentPlan.archive_directory)
    : { moved: [] };
  const movedPaths = new Map((movement.moved || []).map((item) => [item.from, item.to]));
  const results = parsedResults.map((item) => {
    const outputs = (item.outputs || []).map((relativePath) => movedPaths.get(relativePath) || relativePath);
    return {
      ...item,
      outputs,
      delivered_outputs: item.status === "success"
        ? outputs.map((relativePath) => ({ source: relativePath, path: relativePath, status: "library" }))
        : []
    };
  });
  return Object.freeze({
    ok: results.every((item) => !["failed", "cancelled"].includes(item.status)),
    mode: "confirmed-one-click-parse",
    plan_id: currentPlan.plan_id,
    target_directory: currentPlan.target_directory,
    update_mode: currentPlan.update_mode,
    delivery_mode: currentPlan.delivery_mode,
    files: results,
    requested_count: currentPlan.count,
    completed_count: results.filter((item) => item.status === "success").length,
    failed_count: results.filter((item) => ["failed", "cancelled"].includes(item.status)).length,
    discarded_backups: discardedBackups,
    archive_directory: currentPlan.archive_directory
  });
}

export function executeParseBatch(rootPath, confirmedPlan, options = {}) {
  return executeParseBatchWith(rootPath, confirmedPlan, options, parseLibrary);
}

export function executeParseBatchLegacyForRegression(rootPath, confirmedPlan, options = {}) {
  return executeParseBatchWith(rootPath, confirmedPlan, options, parseLibraryLegacyForRegression);
}

export async function indexClaudeLibraryExport(rootPath, fileName, options = {}) {
  return indexClaudeExport(rootPath, fileName, options);
}

export async function readClaudeLibraryIndex(rootPath, fileName) {
  return getClaudeIndex(rootPath, fileName);
}

export async function parseClaudeLibrarySelection(rootPath, fileName, conversationKeys, {
  preservePrevious = false,
  signal = null,
  onProgress = null
} = {}) {
  const paths = libraryPaths(rootPath);
  const result = await extractClaudeConversations(paths.root, fileName, conversationKeys, { preservePrevious, signal, onProgress });
  const discardedBackups = !preservePrevious && result.backup
    ? Number(await discardAutomaticParseBackup(paths, result.backup))
    : 0;
  return {
    ...result,
    backup: discardedBackups ? "" : result.backup,
    discarded_backups: discardedBackups
  };
}

function normalizedLibraryText(value) {
  return serializeLibraryDocument(normalizeLibraryDocument(JSON.parse(String(value))));
}

function validateLibraryBackup(value) {
  normalizedLibraryText(value);
}

export async function listLibraryStateHistory(rootPath) {
  const paths = libraryPaths(rootPath);
  const current = await readFile(paths.library, "utf8");
  let currentValid = true;
  try { validateLibraryBackup(current); } catch { currentValid = false; }
  const backups = await listLibraryBackups(paths, validateLibraryBackup);
  return Object.freeze({
    ok: true,
    format: USER_STATE_HISTORY_FORMAT,
    version: USER_STATE_HISTORY_VERSION,
    target: "cloudig-library.json",
    policy: {
      max_versions: LIBRARY_HISTORY_MAX_VERSIONS,
      max_total_bytes: LIBRARY_HISTORY_MAX_TOTAL_BYTES
    },
    current: {
      bytes: Buffer.byteLength(current),
      sha256: createHash("sha256").update(current).digest("hex"),
      valid: currentValid
    },
    backups
  });
}

export async function saveLibraryOverlay(rootPath, document, expectedSha256 = "") {
  const paths = libraryPaths(rootPath);
  const lock = await acquireFileTransactionLock(paths.root);
  try {
    const expected = String(expectedSha256 || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(expected)) throw new Error("Cloudig Reader requires the Library revision it opened");
    const precondition = await fingerprintFile(paths.library);
    const current = await readFile(paths.library, "utf8");
    const currentSha256 = createHash("sha256").update(current).digest("hex");
    if (currentSha256 !== expected) {
      const error = new Error("cloudig-library.json changed after this Reader opened; return to the Manager and reopen it before saving");
      error.code = "CLOUDIG_LIBRARY_CHANGED";
      throw error;
    }
    const normalized = assertLegacyWritable(document);
    if (isLibraryV1(JSON.parse(current))) {
      const error = new Error("Library 1.0 must be changed through Cloudig domain commands");
      error.code = "CLOUDIG_V1_DOMAIN_COMMAND_REQUIRED";
      throw error;
    }
    const serialized = serializeLibraryDocument(normalized);
    const nextSha256 = createHash("sha256").update(serialized).digest("hex");
    if (nextSha256 === currentSha256) {
      return { ok: true, status: "unchanged", sha256: nextSha256, bytes: Buffer.byteLength(serialized), backup: null };
    }
    const backup = await createLibraryBackup(paths, current);
    const status = await atomicWriteText(paths.library, serialized, { precondition });
    return {
      ok: true,
      status,
      sha256: nextSha256,
      bytes: Buffer.byteLength(serialized),
      backup
    };
  } finally {
    await lock.release();
  }
}

export async function restoreLibraryStateBackup(rootPath, backupId, expectedSha256 = "") {
  const paths = libraryPaths(rootPath);
  const lock = await acquireFileTransactionLock(paths.root);
  try {
    const expected = String(expectedSha256 || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(expected)) {
      const error = new Error("Cloudig Library recovery requires the current Library SHA-256");
      error.code = "CLOUDIG_LIBRARY_REVISION_REQUIRED";
      throw error;
    }
    const precondition = await fingerprintFile(paths.library);
    const current = await readFile(paths.library, "utf8");
    const currentSha256 = createHash("sha256").update(current).digest("hex");
    if (currentSha256 !== expected) {
      const error = new Error("cloudig-library.json changed after the recovery list was opened");
      error.code = "CLOUDIG_LIBRARY_CHANGED";
      throw error;
    }
    const selected = await readLibraryBackup(paths, backupId, validateLibraryBackup);
    const restored = normalizedLibraryText(selected.text);
    const restoredSha256 = createHash("sha256").update(restored).digest("hex");
    if (restoredSha256 === currentSha256) {
      return {
        ok: true,
        status: "unchanged",
        restored_from: selected.backup_id,
        sha256: restoredSha256,
        bytes: Buffer.byteLength(restored),
        previous_backup: null
      };
    }
    const previousBackup = await createLibraryBackup(paths, current);
    const status = await atomicWriteText(paths.library, restored, { precondition });
    return {
      ok: true,
      status,
      restored_from: selected.backup_id,
      sha256: restoredSha256,
      bytes: Buffer.byteLength(restored),
      previous_backup: previousBackup
    };
  } finally {
    await lock.release();
  }
}

function safeMarkdownFileName(value) {
  const base = path.basename(String(value || "conversation.md"))
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 180);
  const stem = base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
  return `${stem || "conversation"}.md`;
}

export async function saveMarkdownExport(rootPath, fileName, markdown) {
  const paths = libraryPaths(rootPath);
  await readLibrary(paths);
  if (typeof markdown !== "string" || !markdown.trim()) throw new Error("Cloudig Markdown export is empty");
  const serialized = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_MARKDOWN_EXPORT_BYTES) throw new Error(`Cloudig Markdown export exceeds ${MAX_MARKDOWN_EXPORT_BYTES} bytes`);
  const name = safeMarkdownFileName(fileName);
  const output = path.join(paths.exports, name);
  const status = await atomicWriteText(output, serialized);
  return {
    ok: true,
    status,
    output,
    file_name: name,
    bytes,
    sha256: createHash("sha256").update(serialized).digest("hex")
  };
}

function runProcess(executable, argumentsList, { cwd = projectRoot, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    const abort = () => {
      try { if (!child.killed) child.kill(); } catch { }
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(Object.assign(new Error("Cloudig Reader build was cancelled"), { name: "AbortError", code: "ABORT_ERR" }));
      } else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Process exited with code ${code}`));
    });
    if (signal?.aborted) abort();
  });
}

function readerConversationPath(paths, value) {
  const relative = String(value || "").trim().replaceAll("\\", "/");
  const segments = relative.split("/");
  if (segments[0] !== "Conversations"
    || segments.length < 2
    || segments[1] === ".Cloudig-Archive"
    || !segments.at(-1).toLowerCase().endsWith(".json")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/u.test(segment))) {
    const error = new Error("Cloudig Reader can read only an active JSON file inside Conversations");
    error.code = "CLOUDIG_READER_PATH_INVALID";
    throw error;
  }
  const absolute = path.resolve(paths.root, ...segments);
  const inside = path.relative(path.resolve(paths.conversations), absolute);
  if (!inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    const error = new Error("Cloudig Reader conversation path escaped Conversations");
    error.code = "CLOUDIG_READER_PATH_INVALID";
    throw error;
  }
  return { relative, absolute };
}

export async function readConversationForReader(rootPath, relativePath, expectedSha256) {
  const paths = libraryPaths(rootPath);
  await readLibrary(paths);
  const expected = String(expectedSha256 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(expected)) {
    const error = new Error("Cloudig Reader requires the catalog SHA-256 for a conversation read");
    error.code = "CLOUDIG_READER_REVISION_REQUIRED";
    throw error;
  }
  const target = readerConversationPath(paths, relativePath);
  const information = await lstat(target.absolute);
  if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_READER_CONVERSATION_BYTES) {
    const error = new Error("Cloudig Reader conversation is not a supported regular JSON file");
    error.code = "CLOUDIG_READER_FILE_INVALID";
    throw error;
  }
  const [realConversations, realTarget] = await Promise.all([
    realpath(paths.conversations),
    realpath(target.absolute)
  ]);
  const realInside = path.relative(realConversations, realTarget);
  if (!realInside || path.isAbsolute(realInside) || realInside === ".." || realInside.startsWith(`..${path.sep}`)) {
    const error = new Error("Cloudig Reader conversation resolved outside Conversations");
    error.code = "CLOUDIG_READER_PATH_INVALID";
    throw error;
  }
  const bytes = await readFile(realTarget);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) {
    const error = new Error("The conversation changed after this Reader catalog was opened; reopen Reader to refresh it");
    error.code = "CLOUDIG_CONVERSATION_CHANGED";
    error.retryable = true;
    throw error;
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    const error = new Error("The selected conversation JSON is syntactically invalid");
    error.code = "CLOUDIG_CONVERSATION_INVALID";
    throw error;
  }
  const compatibility = readerCore.conversationCompatibility(document);
  if (!compatibility.supported) {
    const error = new Error(`The selected conversation schema is not supported by Reader ${readerCore.READER_VERSION}`);
    error.code = "CLOUDIG_CONVERSATION_UNSUPPORTED";
    throw error;
  }
  try {
    readerCore.assertConversation(document);
  } catch (cause) {
    const error = new Error("The selected conversation failed Reader structure validation");
    error.code = "CLOUDIG_CONVERSATION_INVALID";
    error.cause = cause;
    throw error;
  }
  return Object.freeze({
    ok: true,
    relative_path: target.relative,
    size_bytes: bytes.length,
    modified_at: information.mtime.toISOString(),
    sha256: digest,
    document
  });
}

async function buildReaderArtifact(paths, target, { desktopCatalog = false, signal = null, onProgress = null } = {}) {
  // Reader construction is deliberately non-mutating with respect to Inbox,
  // parse-state ownership and Conversations. Only explicit parse.* commands
  // may recreate a missing or stale derived conversation.
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.Cloudig-Reader-${process.pid}-${randomUUID()}.tmp.html`);
  if (typeof onProgress === "function") await onProgress({ phase: "reader_build", bytesDone: 0, bytesTotal: 0, itemsDone: 0 });
  if (signal?.aborted) throw Object.assign(new Error("Cloudig Reader build was cancelled"), { name: "AbortError", code: "ABORT_ERR" });
  try {
    const argumentsList = [
      path.join(projectRoot, "reader", "build.mjs"),
      "--library-dir", paths.root
    ];
    if (desktopCatalog) argumentsList.push("--desktop-catalog");
    argumentsList.push("--output", temporary);
    const result = await runProcess(process.execPath, argumentsList, { signal });
    if (signal?.aborted) throw Object.assign(new Error("Cloudig Reader build was cancelled"), { name: "AbortError", code: "ABORT_ERR" });
    const contents = await readFile(temporary, "utf8");
    await atomicWriteText(target, contents, { signal });
    const build = JSON.parse(result.stdout);
    const expectedMode = desktopCatalog ? "desktop_catalog" : "portable";
    if (build.mode !== expectedMode) throw new Error(`Reader builder returned ${build.mode || "no mode"} instead of ${expectedMode}`);
    const bytes = Buffer.byteLength(contents);
    if (typeof onProgress === "function") await onProgress({ phase: "reader_build", bytesDone: bytes, bytesTotal: bytes, itemsDone: 1 });
    return { ok: true, output: target, build: { ...build, output: target } };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function buildPortableReader(rootPath, outputPath = "", { signal = null, onProgress = null } = {}) {
  const paths = libraryPaths(rootPath);
  await readLibrary(paths);
  const target = outputPath ? path.resolve(outputPath) : path.join(paths.exports, "Cloudig-Reader.html");
  return buildReaderArtifact(paths, target, { signal, onProgress });
}

export async function buildDesktopReader(rootPath, { signal = null, onProgress = null } = {}) {
  const paths = libraryPaths(rootPath);
  await readLibrary(paths);
  return buildReaderArtifact(paths, paths.desktopReader, { desktopCatalog: true, signal, onProgress });
}
