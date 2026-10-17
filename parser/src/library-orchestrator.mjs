import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { normalizeConversation, serializeConversation } from "../../schema/serialize.mjs";
import { validateConversation } from "../../schema/validate.mjs";
import { validateConversationV1 } from "../../schema/validate-v1.mjs";
import { libraryPaths } from "../../library/src/init.mjs";
import { isLibraryV1, normalizeLibraryDocument } from "../../library/compat.mjs";
import { sha256File, pathExists } from "./atomic.mjs";
import {
  DEFAULT_INPUT_ADAPTERS,
  DEFAULT_PARSE_LIMITS,
  DEFAULT_PROBE_LIMITS,
  adapterAcceptsFileName,
  createFileInput,
  probeInputAdapters
} from "./input-adapters.mjs";
import { LEGACY_PROJECTION_PARSER_VERSION, PARSER } from "./index.mjs";
import { createConversationOutputBatch, outputOwnership } from "./output-transaction.mjs";
import { prepareV1ParseTransaction } from "./v1-write-transaction.mjs";
import {
  loadParseState,
  replaceSourceState,
  saveParseState,
  setSourceState,
  sourceStateMap
} from "./parse-state.mjs";
import { compareSemanticVersions, isSemanticVersion } from "./semver.mjs";
import { normalizeParserTimestamp, parserTimestamp } from "./time.mjs";

const require = createRequire(import.meta.url);
const libraryCore = require("../../library/core.js");
const VERSION_POLICY_FORMAT = "cloudig/parser-version-policy";
const VERSION_POLICY_ACTIONS = new Set(["reparse", "reexport"]);
const VERSION_POLICY_ROOT_KEYS = new Set(["format", "version", "rules"]);
const VERSION_POLICY_RULE_KEYS = new Set(["id", "action", "active_from_parser", "match", "reason"]);
const VERSION_POLICY_MATCH_KEYS = new Set([
  "source_adapter",
  "parser_adapter",
  "adapter",
  "platform",
  "exporter_version",
  "parser_version_before",
  "parser_adapter_version_before",
  "exporter_version_before",
  "include_missing_parser_version",
  "include_missing_parser_adapter",
  "include_missing_schema",
  "include_missing_exporter_version",
  "minimum_schema_by_family"
]);

function policyRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function assertKnownPolicyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
}

export function normalizeVersionPolicy(value) {
  const document = policyRecord(value, "Parser version policy");
  assertKnownPolicyKeys(document, VERSION_POLICY_ROOT_KEYS, "Parser version policy");
  if (document.format !== VERSION_POLICY_FORMAT) throw new TypeError(`Parser version policy format must be ${VERSION_POLICY_FORMAT}`);
  if (!isSemanticVersion(document.version)) throw new TypeError("Parser version policy version must be semantic version");
  if (!Array.isArray(document.rules)) throw new TypeError("Parser version policy rules must be an array");
  const identifiers = new Set();
  const rules = document.rules.map((rawRule, index) => {
    const rule = policyRecord(rawRule, `Parser version policy rule ${index}`);
    assertKnownPolicyKeys(rule, VERSION_POLICY_RULE_KEYS, `Parser version policy rule ${index}`);
    const id = String(rule.id || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) throw new TypeError(`Parser version policy rule ${index} has an invalid id`);
    if (identifiers.has(id)) throw new TypeError(`Duplicate Parser version policy rule id: ${id}`);
    identifiers.add(id);
    if (!VERSION_POLICY_ACTIONS.has(rule.action)) throw new TypeError(`Parser version policy rule ${id} has an unsupported action`);
    if (rule.active_from_parser !== undefined && !isSemanticVersion(rule.active_from_parser)) {
      throw new TypeError(`Parser version policy rule ${id} active_from_parser must be semantic version`);
    }
    const match = policyRecord(rule.match || {}, `Parser version policy rule ${id}.match`);
    assertKnownPolicyKeys(match, VERSION_POLICY_MATCH_KEYS, `Parser version policy rule ${id}.match`);
    for (const field of ["parser_version_before", "parser_adapter_version_before", "exporter_version_before"]) {
      if (match[field] !== undefined && !isSemanticVersion(match[field])) {
        throw new TypeError(`Parser version policy rule ${id} ${field} must be semantic version`);
      }
    }
    for (const field of ["include_missing_parser_version", "include_missing_parser_adapter", "include_missing_schema", "include_missing_exporter_version"]) {
      if (match[field] !== undefined && typeof match[field] !== "boolean") {
        throw new TypeError(`Parser version policy rule ${id} ${field} must be boolean`);
      }
    }
    for (const field of ["source_adapter", "parser_adapter", "adapter", "platform", "exporter_version"]) {
      if (match[field] !== undefined && (typeof match[field] !== "string" || !match[field].trim())) {
        throw new TypeError(`Parser version policy rule ${id} ${field} must be a non-empty string`);
      }
    }
    if (match.minimum_schema_by_family !== undefined) {
      policyRecord(match.minimum_schema_by_family, `Parser version policy rule ${id}.minimum_schema_by_family`);
      for (const [family, schema] of Object.entries(match.minimum_schema_by_family)) {
        const parsed = conversationSchema(schema);
        if (!parsed || parsed.family !== family) {
          throw new TypeError(`Parser version policy rule ${id} contains an invalid minimum schema for ${family}`);
        }
      }
    }
    if (rule.reason !== undefined && (typeof rule.reason !== "string" || !rule.reason.trim() || rule.reason.length > 1000)) {
      throw new TypeError(`Parser version policy rule ${id} reason must be a readable non-empty string`);
    }
    return Object.freeze({
      id,
      action: rule.action,
      ...(rule.active_from_parser ? { active_from_parser: rule.active_from_parser } : {}),
      match: Object.freeze({ ...match }),
      ...(rule.reason ? { reason: rule.reason } : {})
    });
  });
  return Object.freeze({
    format: VERSION_POLICY_FORMAT,
    version: document.version,
    rules: Object.freeze(rules)
  });
}

export const VERSION_POLICY = normalizeVersionPolicy(require("../version-policy.json"));

function relativeSourcePath(fileName) {
  return `Inbox/${fileName}`;
}

function resolveConversationOutput(paths, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments[0] !== "Conversations" || segments.length < 2 || !segments.at(-1).toLowerCase().endsWith(".json")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const absolute = path.resolve(paths.root, ...normalized.split("/"));
  const inside = path.relative(path.resolve(paths.conversations), absolute);
  return inside && !path.isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${path.sep}`) ? absolute : null;
}

export function compareParserVersions(left, right) {
  return compareSemanticVersions(left, right);
}

function conversationSchema(value) {
  const match = /^(ai-chat-archive\/conversation\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(0|[1-9]\d*)$/u.exec(String(value || ""));
  return match ? { family: match[1], patch: Number(match[2]) } : null;
}

function compareConversationSchemas(left, right) {
  const leftSchema = conversationSchema(left);
  const rightSchema = conversationSchema(right);
  if (!leftSchema || !rightSchema || leftSchema.family !== rightSchema.family) return null;
  if (leftSchema.patch === rightSchema.patch) return 0;
  return leftSchema.patch < rightSchema.patch ? -1 : 1;
}

function policyApplies(rule, currentParserVersion) {
  if (!rule || rule.action !== "reparse") return false;
  if (!rule.active_from_parser) return true;
  const activeComparison = compareParserVersions(currentParserVersion, rule.active_from_parser);
  return activeComparison === 0 || activeComparison === 1;
}

function ruleScopeMatches(rule, source, output) {
  const match = rule?.match || {};
  if (match.source_adapter && match.source_adapter !== source?.source_adapter?.id) return false;
  if (match.parser_adapter && match.parser_adapter !== (output?.parser_adapter?.id || source?.source_adapter?.id)) return false;
  if (match.adapter && match.adapter !== source?.adapter?.id) return false;
  if (match.platform) {
    const platform = String(match.platform).toLowerCase();
    const candidates = [
      source?.platform,
      source?.source_adapter?.id,
      source?.adapter?.id,
      source?.adapter?.format
    ].filter(Boolean).map((value) => String(value).toLowerCase());
    if (!candidates.some((value) => value === platform || value.split(/[./_-]+/u).includes(platform))) return false;
  }
  if (output && match.exporter_version && match.exporter_version !== output.exporter_version) return false;
  return true;
}

function outputNeedsPolicyReparse(source, output, currentParserVersion, policy = VERSION_POLICY) {
  return policy.rules.some((rule) => {
    if (!policyApplies(rule, currentParserVersion) || !ruleScopeMatches(rule, source, output)) return false;
    const match = rule.match || {};
    const parserVersion = output ? output.parser_version || "" : source?.parser_version || "";
    if (!parserVersion && match.include_missing_parser_version === true) return true;
    if (match.parser_version_before && compareParserVersions(parserVersion, match.parser_version_before) === -1) return true;
    const adapterVersion = output?.parser_adapter?.version || "";
    if (!adapterVersion && match.include_missing_parser_adapter === true) return true;
    if (adapterVersion && match.parser_adapter_version_before
      && compareSemanticVersions(adapterVersion, match.parser_adapter_version_before) === -1) return true;
    if (!output) return false;
    const schema = conversationSchema(output?.schema);
    if (!schema && match.include_missing_schema === true) return true;
    const minimumSchema = schema ? match.minimum_schema_by_family?.[schema.family] : "";
    return Boolean(minimumSchema && compareConversationSchemas(output.schema, minimumSchema) === -1);
  });
}

export function conversationOutputGenerationStatus(source, output, currentParserVersion = PARSER.version, policy = VERSION_POLICY) {
  if (output?.parser_version_invalid === true) return "newer_generated";
  const owner = output || source;
  const hasParserVersion = Boolean(owner) && Object.prototype.hasOwnProperty.call(owner, "parser_version");
  const parserVersion = hasParserVersion ? owner.parser_version : "";
  if (hasParserVersion && !isSemanticVersion(parserVersion)) return "newer_generated";
  if (compareParserVersions(parserVersion, currentParserVersion) === 1) return "newer_generated";
  if (output?.schema_invalid === true) return "newer_generated";
  const hasSchema = Boolean(output) && Object.prototype.hasOwnProperty.call(output, "schema");
  const schema = hasSchema && typeof output.schema === "string" ? conversationSchema(output.schema) : null;
  if (hasSchema && !schema) return "newer_generated";
  if (schema) {
    const knownTargets = policy.rules
      .map((rule) => rule.match?.minimum_schema_by_family?.[schema.family])
      .filter(Boolean);
    if (!knownTargets.length) return "newer_generated";
    const newestKnownTarget = knownTargets.reduce((newest, candidate) =>
      compareConversationSchemas(candidate, newest) === 1 ? candidate : newest
    );
    if (compareConversationSchemas(output.schema, newestKnownTarget) === 1) {
      return "newer_generated";
    }
  }
  return outputNeedsPolicyReparse(source, output, currentParserVersion, policy) ? "needs_reparse" : "current";
}

export function sourceGenerationStatus(source, currentParserVersion = PARSER.version, policy = VERSION_POLICY) {
  const outputs = Array.isArray(source?.outputs) ? source.outputs : [];
  if (!outputs.length) {
    if (!source?.last_success_at) return "current";
    const hasParserVersion = Boolean(source) && Object.prototype.hasOwnProperty.call(source, "parser_version");
    if (hasParserVersion && !isSemanticVersion(source.parser_version)) return "newer_generated";
    const comparison = compareParserVersions(hasParserVersion ? source.parser_version : "", currentParserVersion);
    if (comparison === 1) return "newer_generated";
    return outputNeedsPolicyReparse(source, null, currentParserVersion, policy) ? "needs_reparse" : "current";
  }
  let needsReparse = false;
  for (const output of outputs) {
    const status = conversationOutputGenerationStatus(source, output, currentParserVersion, policy);
    if (status === "newer_generated") return status;
    if (status === "needs_reparse") needsReparse = true;
  }
  return needsReparse ? "needs_reparse" : "current";
}

export function sourceRequiresReexport(source, currentParserVersion = PARSER.version, policy = VERSION_POLICY) {
  return policy.rules.some((rule) => {
    if (rule?.action !== "reexport" || !ruleScopeMatches(rule, source, null)) return false;
    if (rule.active_from_parser) {
      const activeComparison = compareParserVersions(currentParserVersion, rule.active_from_parser);
      if (activeComparison !== 0 && activeComparison !== 1) return false;
    }
    const outputs = Array.isArray(source?.outputs) && source.outputs.length ? source.outputs : [null];
    return outputs.some((output) => {
      if (!ruleScopeMatches(rule, source, output)) return false;
      const exporterVersion = output?.exporter_version || "";
      if (!exporterVersion) return rule.match?.include_missing_exporter_version === true;
      if (rule.match?.exporter_version) return exporterVersion === rule.match.exporter_version;
      if (rule.match?.exporter_version_before) {
        return compareSemanticVersions(exporterVersion, rule.match.exporter_version_before) === -1;
      }
      return false;
    });
  });
}

async function verifyOutputs(paths, outputs) {
  if (!Array.isArray(outputs)) return { valid: false, outputs: [] };
  const refreshed = [];
  let valid = true;
  for (const output of outputs) {
    const absolute = resolveConversationOutput(paths, output.path);
    if (!absolute || !await pathExists(absolute)) {
      valid = false;
      refreshed.push(output);
      continue;
    }
    const information = await stat(absolute);
    if (!information.isFile()) {
      valid = false;
      refreshed.push(output);
      continue;
    }
    const modifiedAt = information.mtime.toISOString();
    let bytes;
    let document;
    try {
      bytes = await readFile(absolute);
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      valid = false;
      const unreadable = { ...output, modified_at: modifiedAt };
      if (output.archive_id && output.role) {
        refreshed.push(unreadable);
        continue;
      }
      delete unreadable.schema;
      delete unreadable.schema_invalid;
      delete unreadable.parser_version;
      delete unreadable.parser_version_invalid;
      delete unreadable.parser_adapter;
      delete unreadable.exporter_version;
      refreshed.push(unreadable);
      continue;
    }
    if (output.archive_id && output.role) {
      const next = { ...output, modified_at: modifiedAt };
      const v1 = validateConversationV1(document);
      if (!v1.valid
        || document.schema !== "ai-chat-archive/conversation/1.0.0"
        || document.identity?.conversation_key !== output.conversation_key
        || document.identity?.archive_id !== output.archive_id
        || document.lifecycle?.last_parsed_at !== output.last_parsed_at) {
        valid = false;
      } else {
        next.schema = document.schema;
        next.parser_version = document.generation.parser_version;
        next.parser_adapter = sourceAdapterRecord(document.generation.parser_adapter);
        if (document.generation.exporter_version) next.exporter_version = document.generation.exporter_version;
        else delete next.exporter_version;
        next.first_parsed_at = document.lifecycle.first_parsed_at;
        next.last_parsed_at = document.lifecycle.last_parsed_at;
      }
      refreshed.push(next);
      const currentDigest = createHash("sha256").update(bytes).digest("hex");
      if (information.size !== output.size_bytes || currentDigest !== output.sha256) valid = false;
      continue;
    }
    const next = { ...output, modified_at: modifiedAt };
    delete next.schema;
    delete next.schema_invalid;
    delete next.parser_version;
    delete next.parser_version_invalid;
    delete next.parser_adapter;
    delete next.exporter_version;
    if (Object.prototype.hasOwnProperty.call(document || {}, "schema")) {
      if (typeof document.schema === "string" && conversationSchema(document.schema)) next.schema = document.schema;
      else next.schema_invalid = true;
    }
    const generation = document?.schema === "ai-chat-archive/conversation/1.0.0" ? document.generation : document;
    if (Object.prototype.hasOwnProperty.call(generation || {}, "parser_version")) {
      if (isSemanticVersion(generation.parser_version)) next.parser_version = generation.parser_version;
      else next.parser_version_invalid = true;
    }
    if (generation?.parser_adapter && typeof generation.parser_adapter === "object") {
      try {
        next.parser_adapter = sourceAdapterRecord(generation.parser_adapter);
      } catch {
        next.parser_version_invalid = true;
      }
    }
    if (typeof generation?.exporter_version === "string" && generation.exporter_version.trim()) {
      next.exporter_version = generation.exporter_version;
    }
    refreshed.push(next);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (information.size !== output.size_bytes || digest !== output.sha256) valid = false;
  }
  return { valid, outputs: refreshed };
}

function sameMetadata(previous, information) {
  return previous?.size_bytes === information.size && previous?.modified_at === information.mtime.toISOString();
}

function sameAdapter(previous, adapter) {
  return previous?.adapter?.id === adapter?.id
    && previous?.adapter?.version === adapter?.version
    && sourceGenerationStatus(previous) === "current";
}

function currentAdapterForPrevious(previous, adapters, fileName) {
  if (!previous?.adapter?.id) return null;
  return adapters.find((adapter) => adapter.id === previous.adapter.id && adapterAcceptsFileName(adapter, fileName)) || null;
}

const INTERRUPTED_ERROR_CODES = new Set(["ABORT_ERR", "ECANCELED"]);
const ENVIRONMENT_ERROR_CODES = new Set([
  "EACCES", "EBUSY", "EDQUOT", "EIO", "EMFILE", "ENFILE", "ENOENT", "ENOMEM", "ENOSPC", "ENOTDIR", "EPERM", "EROFS", "ESTALE", "ETIMEDOUT"
]);

function inputSupportKey(adapters, selectedAdapter = null) {
  const registry = (selectedAdapter ? [selectedAdapter] : adapters)
    .map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
      extensions: [...adapter.extensions].sort()
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  return createHash("sha256").update(JSON.stringify({
    parser_version: PARSER.version,
    policy_version: VERSION_POLICY.version,
    adapters: registry
  })).digest("hex");
}

function currentSourceSupportKey(previous, adapters, fileName) {
  return inputSupportKey(adapters, currentAdapterForPrevious(previous, adapters, fileName));
}

function sourceFailure(error) {
  const wrapped = new Error(String(error?.message || error || "Input adapter failed"), { cause: error });
  if (typeof error?.code === "string") wrapped.code = error.code;
  wrapped.cloudigFailureKind = "source";
  return wrapped;
}

async function* sourceClassifiedEvents(events) {
  try {
    for await (const event of events) yield event;
  } catch (error) {
    throw sourceFailure(error);
  }
}

function classifyParseFailure(error, { signal = null, fallbackKind = "internal" } = {}) {
  const code = String(error?.code || "").toUpperCase();
  if (signal?.aborted || INTERRUPTED_ERROR_CODES.has(code)) return "interrupted";
  if (ENVIRONMENT_ERROR_CODES.has(code)) return "environment";
  if (error?.cloudigFailureKind === "source" || fallbackKind === "source") return "source";
  return "internal";
}

function failureDecision(previous, { kind, supportKey, sourceSha256, phase, cancelled = false }) {
  const repeatedSourceFailure = kind === "source"
    && previous?.error?.kind === "source"
    && previous.error.support_key === supportKey
    && previous.sha256 === sourceSha256;
  const sourceFailures = kind === "source" ? (repeatedSourceFailure ? 2 : 1) : 0;
  const status = sourceFailures === 2 ? "unsupported" : cancelled ? "cancelled" : "failed";
  const code = status === "unsupported"
    ? "unsupported_source"
    : cancelled
      ? "cancelled"
      : `${phase}_${kind}_failed`;
  return {
    status,
    reason: status === "unsupported" ? "unsupported_after_retry" : code,
    error: {
      code,
      kind,
      support_key: supportKey,
      ...(sourceFailures ? { source_failures: sourceFailures } : {})
    }
  };
}

function cleanErrorMessage(error, paths, inputName) {
  let message = String(error?.message || error || "Unknown parser failure").split(/\r?\n/u)[0];
  for (const privatePath of [paths.root, paths.inbox, paths.conversations, paths.data]) {
    message = message.replaceAll(privatePath, "<library>");
  }
  return message.replaceAll("\\", "/").replace(inputName, path.basename(inputName)).slice(0, 1000);
}

function sourceAdapterRecord(value) {
  if (!value?.id) return undefined;
  const version = String(value.version || "");
  if (!isSemanticVersion(version)) throw new TypeError(`Source adapter ${value.id} is missing its registered semantic version`);
  return {
    id: String(value.id),
    version
  };
}

async function inboxFiles(paths, selectedFile) {
  if (selectedFile) {
    const absolute = path.isAbsolute(selectedFile)
      ? path.resolve(selectedFile)
      : path.resolve(paths.inbox, selectedFile);
    if (path.dirname(absolute) !== path.resolve(paths.inbox)) throw new Error("--file must select a direct child of the Cloudig Inbox directory");
    const information = await stat(absolute);
    if (!information.isFile()) throw new Error("Selected Inbox item is not a regular file");
    return [{ absolute, name: path.basename(absolute), information }];
  }
  const entries = await readdir(paths.inbox, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(paths.inbox, entry.name);
    files.push({ absolute, name: entry.name, information: await stat(absolute) });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
}

function resumableSourceStatus(source) {
  if (source.status !== "source_missing") return source.status;
  if (source.last_success_at || (source.outputs || []).length) return "success";
  if (source.adapter?.id) return "pending";
  return "unsupported";
}

async function reconcileSourceLocations(state, files) {
  let next = state;
  let changed = false;
  const renamed = [];
  const restored = [];
  const conflicts = [];
  const filesByPath = new Map(files.map((file) => [relativeSourcePath(file.name), file]));

  for (const source of next.sources) {
    const file = filesByPath.get(source.path);
    if (!file || (source.status !== "source_missing" && source.dismissed !== true)) continue;
    const metadataUnchanged = sameMetadata(source, file.information);
    next = setSourceState(next, {
      ...source,
      status: metadataUnchanged ? resumableSourceStatus(source) : "pending",
      dismissed: false,
      error: undefined
    });
    changed = true;
    restored.push(source.path);
  }

  const registered = sourceStateMap(next);
  const missingByHash = new Map();
  for (const source of next.sources) {
    if (filesByPath.has(source.path) || !source.sha256) continue;
    const group = missingByHash.get(source.sha256) || [];
    group.push(source);
    missingByHash.set(source.sha256, group);
  }
  if (!missingByHash.size) return { state: next, changed, renamed, restored, conflicts };

  const currentByHash = new Map();
  for (const file of files) {
    const sourcePath = relativeSourcePath(file.name);
    const currentSource = registered.get(sourcePath);
    const recordedHashIsCurrent = Boolean(
      currentSource?.sha256
      && sameMetadata(currentSource, file.information)
    );
    file.sha256 ||= recordedHashIsCurrent ? currentSource.sha256 : await sha256File(file.absolute);
    if (!missingByHash.has(file.sha256)) continue;
    const group = currentByHash.get(file.sha256) || [];
    group.push({ ...file, sourcePath, registered: Boolean(currentSource) });
    currentByHash.set(file.sha256, group);
  }

  for (const [sha256, oldSources] of missingByHash) {
    const currentFiles = currentByHash.get(sha256) || [];
    const newFiles = currentFiles.filter((file) => !file.registered);
    if (!newFiles.length) continue;
    if (oldSources.length !== 1 || currentFiles.length !== 1) {
      conflicts.push({
        sha256,
        registered: oldSources.map((source) => source.path),
        current: currentFiles.map((file) => file.sourcePath)
      });
      continue;
    }
    const previous = oldSources[0];
    const file = currentFiles[0];
    const sourcePath = file.sourcePath;
    next = replaceSourceState(next, previous.path, {
      ...previous,
      path: sourcePath,
      size_bytes: file.information.size,
      modified_at: file.information.mtime.toISOString(),
      sha256,
      source_key: previous.source_key || sha256,
      status: resumableSourceStatus(previous),
      dismissed: false,
      error: previous.status === "source_missing" ? undefined : previous.error
    });
    changed = true;
    renamed.push({ from: previous.path, to: sourcePath });
  }
  return { state: next, changed, renamed, restored, conflicts };
}

function reconcileInterruptedAttempts(state) {
  let next = state;
  const interrupted = [];
  for (const source of state.sources) {
    if (source.status !== "parsing") continue;
    next = setSourceState(next, {
      ...source,
      status: "failed",
      error: {
        code: "interrupted",
        kind: "interrupted",
        message: "The previous parsing attempt ended before it could finish; retrying is safe because no partial output was committed"
      }
    });
    interrupted.push(source.path);
  }
  return { state: next, changed: interrupted.length > 0, interrupted };
}

async function reconcileUnsupportedSupport(paths, state, files, adapters, probeLimits) {
  let next = state;
  let changed = false;
  const rescanned = [];
  const filesByPath = new Map(files.map((file) => [relativeSourcePath(file.name), file]));
  for (const source of state.sources) {
    if (source.status !== "unsupported") continue;
    const file = filesByPath.get(source.path);
    if (!file) continue;
    const supportKey = currentSourceSupportKey(source, adapters, file.name);
    if (sameMetadata(source, file.information) && source.error?.support_key === supportKey) continue;

    const input = await createFileInput(file.absolute, {
      relativePath: source.path,
      information: file.information
    });
    let selection;
    try {
      selection = await probeInputAdapters(input, adapters, probeLimits);
    } catch (error) {
      const kind = classifyParseFailure(error, { fallbackKind: "source" });
      next = setSourceState(next, {
        ...source,
        size_bytes: input.size,
        modified_at: input.modifiedAt,
        parser_version: PARSER.version,
        status: "failed",
        error: {
          code: `probe_${kind}_failed`,
          kind,
          support_key: supportKey,
          ...(kind === "source" ? { source_failures: 1 } : {}),
          message: cleanErrorMessage(error, paths, file.name)
        }
      });
      changed = true;
      rescanned.push({ path: source.path, status: "failed" });
      continue;
    }

    if (selection.adapter) {
      next = setSourceState(next, {
        ...source,
        size_bytes: input.size,
        modified_at: input.modifiedAt,
        adapter: {
          id: selection.adapter.id,
          version: selection.adapter.version,
          format: selection.probe.format
        },
        parser_version: PARSER.version,
        status: "pending",
        dismissed: false,
        error: undefined
      });
      changed = true;
      rescanned.push({ path: source.path, status: "pending" });
      continue;
    }

    next = setSourceState(next, {
      ...source,
      size_bytes: input.size,
      modified_at: input.modifiedAt,
      parser_version: PARSER.version,
      status: "unsupported",
      error: {
        code: "unsupported_format",
        kind: "source",
        support_key: inputSupportKey(adapters),
        source_failures: 1,
        message: "No registered Cloudig input adapter recognized this file within the bounded probe"
      }
    });
    changed = true;
    rescanned.push({ path: source.path, status: "unsupported" });
  }
  return { state: next, changed, rescanned };
}

async function reconcileOutputLocations(paths, state) {
  const registeredPaths = new Set();
  const missingBySignature = new Map();
  for (const source of state.sources) {
    for (const output of source.outputs || []) {
      registeredPaths.add(output.path);
      const absolute = resolveConversationOutput(paths, output.path);
      if (absolute && await pathExists(absolute)) continue;
      const signature = `${output.size_bytes}:${output.sha256}`;
      const group = missingBySignature.get(signature) || [];
      group.push({ sourcePath: source.path, output });
      missingBySignature.set(signature, group);
    }
  }
  if (!missingBySignature.size) return { state, changed: false, renamed: [], conflicts: [] };

  const sizes = new Set([...missingBySignature.keys()].map((signature) => Number(signature.split(":", 1)[0])));
  const candidatesBySignature = new Map();
  for (const entry of await readdir(paths.conversations, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const relativePath = `Conversations/${entry.name}`;
    if (registeredPaths.has(relativePath)) continue;
    const absolute = path.join(paths.conversations, entry.name);
    const information = await stat(absolute);
    if (!sizes.has(information.size)) continue;
    const signature = `${information.size}:${await sha256File(absolute)}`;
    if (!missingBySignature.has(signature)) continue;
    const group = candidatesBySignature.get(signature) || [];
    group.push({ relativePath, information });
    candidatesBySignature.set(signature, group);
  }

  let next = state;
  let changed = false;
  const renamed = [];
  const conflicts = [];
  for (const [signature, missing] of missingBySignature) {
    const candidates = candidatesBySignature.get(signature) || [];
    if (missing.length !== 1 || candidates.length !== 1) {
      if (candidates.length) conflicts.push({
        outputs: missing.map((item) => item.output.path),
        candidates: candidates.map((item) => item.relativePath)
      });
      continue;
    }
    const target = missing[0];
    const candidate = candidates[0];
    const source = sourceStateMap(next).get(target.sourcePath);
    const outputs = source.outputs.map((output) => output.path === target.output.path
      ? { ...output, path: candidate.relativePath, modified_at: candidate.information.mtime.toISOString() }
      : output);
    next = setSourceState(next, { ...source, outputs });
    changed = true;
    renamed.push({ from: target.output.path, to: candidate.relativePath });
  }
  return { state: next, changed, renamed, conflicts };
}

export async function reconcileCloudigState(
  paths,
  state,
  files = null,
  adapters = DEFAULT_INPUT_ADAPTERS,
  probeLimits = DEFAULT_PROBE_LIMITS
) {
  const currentFiles = files || await inboxFiles(paths, "");
  const interruptedResult = reconcileInterruptedAttempts(state);
  const sourceResult = await reconcileSourceLocations(interruptedResult.state, currentFiles);
  const supportResult = await reconcileUnsupportedSupport(paths, sourceResult.state, currentFiles, adapters, probeLimits);
  const outputResult = await reconcileOutputLocations(paths, supportResult.state);
  return Object.freeze({
    state: outputResult.state,
    files: currentFiles,
    changed: interruptedResult.changed || sourceResult.changed || supportResult.changed || outputResult.changed,
    interrupted_sources: interruptedResult.interrupted,
    support_rescans: supportResult.rescanned,
    source_renames: sourceResult.renamed,
    source_restored: sourceResult.restored,
    source_conflicts: sourceResult.conflicts,
    output_renames: outputResult.renamed,
    output_conflicts: outputResult.conflicts
  });
}

function assertConversationSource(conversation, input, sourceSha256) {
  if (conversation.source_file !== input.name) throw new Error("Adapter conversation source_file does not match the Inbox file name");
  if (conversation.source_sha256 !== sourceSha256) throw new Error("Adapter conversation source_sha256 does not match the scanned input bytes");
  if (conversation.source_size_bytes !== input.size) throw new Error("Adapter conversation source_size_bytes does not match the scanned input size");
}

async function readLibrary(paths) {
  let value;
  try {
    value = JSON.parse(await readFile(paths.library, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read cloudig-library.json; initialize the Cloudig library first. ${error.message}`, { cause: error });
  }
  return normalizeLibraryDocument(value);
}

export async function parseCloudigLibrary({
  root,
  selectedFile = "",
  force = false,
  adapters = DEFAULT_INPUT_ADAPTERS,
  probeLimits = DEFAULT_PROBE_LIMITS,
  parseLimits = DEFAULT_PARSE_LIMITS,
  preservePrevious = false,
  legacyProjectionWriterForRegression = false,
  signal = null,
  clock = () => new Date()
} = {}) {
  if (!root) throw new TypeError("Cloudig library root is required");
  const paths = libraryPaths(root);
  const library = await readLibrary(paths);
  let state = await loadParseState(paths.parseState);
  const v1 = isLibraryV1(library);
  const writerVersion = v1 ? PARSER.version : LEGACY_PROJECTION_PARSER_VERSION;
  if (v1 !== (state.version === "1.0.0")) {
    const error = new Error("Cloudig Library and parse-state generations do not match; complete or recover the V1 migration before parsing");
    error.code = "CLOUDIG_MIGRATION_INCOMPLETE";
    throw error;
  }
  if (!v1 && PARSER.version === "0.6.0" && legacyProjectionWriterForRegression !== true) {
    const error = new Error("This Library must be migrated to Cloudig V1 before Parser 0.6 can write conversations");
    error.code = "CLOUDIG_LIBRARY_MIGRATION_REQUIRED";
    throw error;
  }
  const reconciliation = await reconcileCloudigState(paths, state, null, adapters, probeLimits);
  state = reconciliation.state;
  if (reconciliation.changed) await saveParseState(paths.parseState, state);
  const files = selectedFile ? await inboxFiles(paths, selectedFile) : reconciliation.files;
  const currentPaths = new Set(reconciliation.files.map((file) => relativeSourcePath(file.name)));
  const summaries = [];

  for (const file of files) {
    const sourcePath = relativeSourcePath(file.name);
    let previous = sourceStateMap(state).get(sourcePath) || null;
    const input = await createFileInput(file.absolute, {
      relativePath: sourcePath,
      information: file.information
    });
    const sourceCreatedAt = v1
      ? previous?.captured_at?.value || input.earliestCreatedOrModifiedAt
      : previous?.source_created_at || input.createdAt;
    const sourceCapture = v1
      ? previous?.captured_at || { value: input.earliestCreatedOrModifiedAt, basis: "filesystem_earliest_create_or_modify" }
      : null;
    let parsedSourceCapture = null;
    const sourceTimeState = (successful = false) => v1
      ? { captured_at: successful && parsedSourceCapture ? parsedSourceCapture : sourceCapture }
      : { source_created_at: sourceCreatedAt };
    const previousAdapter = currentAdapterForPrevious(previous, adapters, file.name);
    let previousOutputs = previous?.outputs || [];
    if (previousOutputs.length) {
      const verified = await verifyOutputs(paths, previousOutputs);
      if (JSON.stringify(verified.outputs) !== JSON.stringify(previousOutputs)) {
        previous = { ...previous, outputs: verified.outputs };
        previousOutputs = verified.outputs;
        state = setSourceState(state, previous);
        await saveParseState(paths.parseState, state);
      }
    }
    if (sourceGenerationStatus(previous) === "newer_generated") {
      summaries.push({
        file: file.name,
        status: "failed",
        adapter: previous?.adapter?.id || "",
        conversations: previousOutputs.length,
        write_status: "retained",
        reason: "newer_generated",
        blocked: true,
        outputs: previousOutputs.map((item) => item.path),
        error: `Existing conversation output uses a newer Parser or conversation schema than Cloudig ${PARSER.version}; Cloudig kept it unchanged`
      });
      continue;
    }

    if (!force
      && previous?.status === "unsupported"
      && sameMetadata(previous, file.information)
      && previous.error?.support_key === currentSourceSupportKey(previous, adapters, file.name)) {
      summaries.push({
        file: file.name,
        status: "unsupported",
        adapter: "",
        conversations: previousOutputs.length,
        write_status: previousOutputs.length ? "retained" : "unchanged",
        reason: "metadata_unchanged",
        outputs: previousOutputs.map((item) => item.path),
        error: previous.error?.message || "No registered Cloudig input adapter recognizes this file"
      });
      continue;
    }

    if (!force && previous?.status === "success" && sameMetadata(previous, file.information) && sameAdapter(previous, previousAdapter)) {
      const verified = await verifyOutputs(paths, previousOutputs);
      if (verified.valid) {
        if (JSON.stringify(verified.outputs) !== JSON.stringify(previousOutputs)) {
          state = setSourceState(state, { ...previous, outputs: verified.outputs });
          await saveParseState(paths.parseState, state);
        }
        summaries.push({
          file: file.name,
          status: "success",
          adapter: previous.adapter.id,
          conversations: verified.outputs.length,
          write_status: "unchanged",
          reason: "metadata_unchanged",
          outputs: verified.outputs.map((item) => item.path)
        });
        continue;
      }
    }

    const sourceSha256 = file.sha256 || await sha256File(file.absolute);
    const sourceKey = previous?.source_key || sourceSha256;
    if (!force && previous?.status === "success" && previous.sha256 === sourceSha256 && sameAdapter(previous, previousAdapter)) {
      const verified = await verifyOutputs(paths, previousOutputs);
      if (verified.valid) {
        state = setSourceState(state, {
          ...previous,
          size_bytes: input.size,
          modified_at: input.modifiedAt,
          ...sourceTimeState(),
          source_key: sourceKey,
          dismissed: false,
          outputs: verified.outputs
        });
        await saveParseState(paths.parseState, state);
        summaries.push({
          file: file.name,
          status: "success",
          adapter: previous.adapter.id,
          conversations: verified.outputs.length,
          write_status: "unchanged",
          reason: "source_hash_unchanged",
          outputs: verified.outputs.map((item) => item.path)
        });
        continue;
      }
    }

    let selection;
    try {
      selection = await probeInputAdapters(input, adapters, probeLimits);
    } catch (error) {
      selection = { adapter: null, probe: null, probeError: error };
    }
    const attemptedAt = normalizeParserTimestamp(clock(), "Parser attempt clock");
    if (!selection.adapter) {
      const message = selection.probeError
        ? cleanErrorMessage(selection.probeError, paths, file.name)
        : "No registered Cloudig input adapter recognized this file within the bounded probe";
      const supportKey = inputSupportKey(adapters);
      const kind = selection.probeError
        ? classifyParseFailure(selection.probeError, { signal, fallbackKind: "source" })
        : "source";
      const decision = selection.probeError
        ? failureDecision(previous, {
          kind,
          supportKey,
          sourceSha256,
          phase: "probe",
          cancelled: kind === "interrupted" && signal?.aborted === true
        })
        : {
          status: "unsupported",
          reason: "unsupported_format",
          error: {
            code: "unsupported_format",
            kind: "source",
            support_key: supportKey,
            source_failures: 1
          }
        };
      state = setSourceState(state, {
        path: sourcePath,
        size_bytes: input.size,
        modified_at: input.modifiedAt,
        ...sourceTimeState(),
        sha256: sourceSha256,
        source_key: sourceKey,
        parser_version: writerVersion,
        status: decision.status,
        last_attempt_at: attemptedAt,
        last_success_at: previous?.last_success_at,
        source_adapter: previous?.source_adapter,
        outputs: previousOutputs,
        error: { ...decision.error, message }
      });
      await saveParseState(paths.parseState, state);
      summaries.push({
        file: file.name,
        status: decision.status,
        adapter: "",
        conversations: previousOutputs.length,
        write_status: previousOutputs.length ? "retained" : "unchanged",
        reason: decision.reason,
        outputs: previousOutputs.map((item) => item.path),
        error: message
      });
      continue;
    }

    const adapterRecord = {
      id: selection.adapter.id,
      version: selection.adapter.version,
      format: selection.probe.format
    };
    if (selection.adapter.capabilities.selectable === true) {
      state = setSourceState(state, {
        path: sourcePath,
        size_bytes: input.size,
        modified_at: input.modifiedAt,
        ...sourceTimeState(),
        sha256: sourceSha256,
        source_key: sourceKey,
        adapter: adapterRecord,
        parser_version: writerVersion,
        status: "pending",
        last_attempt_at: attemptedAt,
        last_success_at: previous?.last_success_at,
        source_adapter: previous?.source_adapter,
        outputs: previousOutputs
      });
      await saveParseState(paths.parseState, state);
      summaries.push({
        file: file.name,
        status: "pending",
        adapter: selection.adapter.id,
        conversations: previousOutputs.length,
        write_status: previousOutputs.length ? "retained" : "unchanged",
        reason: "selection_required",
        outputs: previousOutputs.map((item) => item.path)
      });
      continue;
    }
    state = setSourceState(state, {
      path: sourcePath,
      size_bytes: input.size,
      modified_at: input.modifiedAt,
      ...sourceTimeState(),
      sha256: sourceSha256,
      source_key: sourceKey,
      adapter: adapterRecord,
      parser_version: writerVersion,
      status: "parsing",
      last_attempt_at: attemptedAt,
      last_success_at: previous?.last_success_at,
      source_adapter: previous?.source_adapter,
      outputs: previousOutputs
    });
    await saveParseState(paths.parseState, state);

    let outputBatch = null;
    try {
      if (signal?.aborted) throw new Error("Parsing was cancelled before the adapter started");
      let conversationCount = 0;
      let sourceAdapter;
      const v1Conversations = [];
      const parsedAt = parserTimestamp({ clock });
      if (!v1) {
        outputBatch = await createConversationOutputBatch({
          paths,
          inputName: input.name,
          sourcePath,
          sourceSha256,
          previousOutputs,
          ownership: outputOwnership(state),
          now: new Date(parsedAt)
        });
      }
      const context = Object.freeze({
        limits: Object.freeze({ ...DEFAULT_PARSE_LIMITS, ...parseLimits }),
        signal,
        sourceFile: input.name,
        sourceSha256,
        sourceKey,
        sourceSizeBytes: input.size,
        sourceCreatedAt,
        parsedAt,
        normalizeConversation,
        validateConversation,
        serializeConversation
      });
      for await (const event of sourceClassifiedEvents(selection.adapter.parse(input, context))) {
        if (signal?.aborted) throw new Error("Parsing was cancelled while the adapter event stream was active");
        if (!event || typeof event !== "object") throw new Error(`Input adapter ${selection.adapter.id} yielded an invalid event`);
        if (event.source_adapter) sourceAdapter = sourceAdapterRecord(event.source_adapter);
        if (v1 && event.source_capture) parsedSourceCapture = event.source_capture;
        if (event.type !== "conversation") continue;
        const persistedConversationKey = previousOutputs.length === 1
          ? previousOutputs[0].conversation_key
          : sourceKey;
        const adapterConversationKey = event.conversation_key
          || event.conversation_id
          || event.conversation?.conversation_key
          || event.conversation?.conversation_id;
        const adapterKeyHasStableLocator = selection.adapter.capabilities.one_to_many === true
          || (adapterConversationKey && adapterConversationKey !== sourceSha256);
        const eventConversationKey = adapterKeyHasStableLocator
          ? adapterConversationKey
          : persistedConversationKey;
        const schema = String(event.conversation?.schema || "");
        const newSchema = /\/(?:0\.1\.[2345]|0\.2\.[2345])$/u.test(schema);
        const parsedAtSchema = /\/(?:0\.1\.5|0\.2\.5)$/u.test(schema);
        const draft = newSchema
          ? {
            ...event.conversation,
            conversation_key: eventConversationKey,
            ...(parsedAtSchema ? { parsed_at: parsedAt } : {})
          }
          : event.conversation_id && !event.conversation?.conversation_id
            ? { ...event.conversation, conversation_id: event.conversation_id }
            : event.conversation;
        const conversation = normalizeConversation(draft);
        assertConversationSource(conversation, input, sourceSha256);
        const validation = validateConversation(conversation);
        if (!validation.valid) throw new Error(`Unified conversation validation failed: ${validation.errors[0]}`);
        if (v1) v1Conversations.push(conversation);
        else {
          await outputBatch.stage({
            conversationKey: conversation.conversation_key || conversation.conversation_id || eventConversationKey,
            serialized: serializeConversation(conversation),
            schema: conversation.schema,
            parserVersion: conversation.parser_version,
            parserAdapter: conversation.parser_adapter,
            exporterVersion: event.exporter_version || conversation.exporter_version || ""
          });
        }
        conversationCount += 1;
      }
      if (signal?.aborted) throw new Error("Parsing was cancelled before the output set was committed");
      if (conversationCount > 1 && selection.adapter.capabilities.one_to_many !== true) {
        throw new Error(`Input adapter ${selection.adapter.id} emitted multiple conversations without declaring one_to_many`);
      }

      let transaction;
      if (v1) {
        const prepared = await prepareV1ParseTransaction({
          paths,
          source: {
            path: sourcePath,
            size_bytes: input.size,
            modified_at: input.modifiedAt,
            ...sourceTimeState(true),
            sha256: sourceSha256,
            source_key: sourceKey,
            adapter: adapterRecord,
            source_adapter: sourceAdapter,
            parser_version: writerVersion,
            status: "parsing",
            last_attempt_at: attemptedAt,
            last_success_at: previous?.last_success_at,
            outputs: previousOutputs
          },
          legacyConversations: v1Conversations,
          parsedAt,
          preservePrevious,
          signal
        });
        transaction = await prepared.commit();
        state = setSourceState(state, transaction.source);
      } else {
        transaction = await outputBatch.commit();
        outputBatch = null;
        const succeededAt = clock().toISOString();
        state = setSourceState(state, {
          path: sourcePath,
          size_bytes: input.size,
          modified_at: input.modifiedAt,
          ...sourceTimeState(),
          sha256: sourceSha256,
          source_key: sourceKey,
          adapter: adapterRecord,
          source_adapter: sourceAdapter,
          parser_version: writerVersion,
          status: "success",
          last_attempt_at: attemptedAt,
          last_success_at: succeededAt,
          outputs: transaction.outputs
        });
        await saveParseState(paths.parseState, state);
      }
      summaries.push({
        file: file.name,
        status: "success",
        adapter: selection.adapter.id,
        conversations: transaction.outputs.length,
        write_status: transaction.writeStatus || transaction.write_status,
        reason: force ? "forced" : "parsed",
        outputs: transaction.outputs.map((item) => item.path),
        backup: transaction.backup || undefined
      });
    } catch (error) {
      await outputBatch?.abort();
      const cancelled = signal?.aborted;
      const message = cleanErrorMessage(error, paths, file.name);
      const kind = classifyParseFailure(error, { signal });
      const decision = failureDecision(previous, {
        kind,
        supportKey: inputSupportKey(adapters, selection.adapter),
        sourceSha256,
        phase: "parse",
        cancelled
      });
      state = setSourceState(state, {
        path: sourcePath,
        size_bytes: input.size,
        modified_at: input.modifiedAt,
        ...sourceTimeState(),
        sha256: sourceSha256,
        source_key: sourceKey,
        adapter: adapterRecord,
        parser_version: writerVersion,
        status: decision.status,
        last_attempt_at: attemptedAt,
        last_success_at: previous?.last_success_at,
        source_adapter: previous?.source_adapter,
        outputs: previousOutputs,
        error: { ...decision.error, message }
      });
      await saveParseState(paths.parseState, state);
      summaries.push({
        file: file.name,
        status: decision.status,
        adapter: selection.adapter.id,
        conversations: previousOutputs.length,
        write_status: previousOutputs.length ? "retained" : "none",
        reason: decision.reason,
        outputs: previousOutputs.map((item) => item.path),
        error: message
      });
    }
  }

  const missing = [];
  if (!selectedFile) {
    for (const previous of state.sources) {
      if (currentPaths.has(previous.path) || previous.status === "source_missing") continue;
      const marked = {
        ...previous,
        status: "source_missing",
        error: { code: "source_missing", message: "The registered Inbox source is no longer present; derived conversations were retained" }
      };
      state = setSourceState(state, marked);
      missing.push(previous.path);
    }
    await saveParseState(paths.parseState, state);
  }

  return Object.freeze({
    ok: !summaries.some((item) => ["failed", "cancelled"].includes(item.status)),
    mode: "cloudig-library",
    root: path.basename(paths.root),
    state_file: "Data/parse-state.json",
    files: summaries,
    missing,
    reconciliation: {
      source_renames: reconciliation.source_renames,
      source_restored: reconciliation.source_restored,
      source_conflicts: reconciliation.source_conflicts,
      output_renames: reconciliation.output_renames,
      output_conflicts: reconciliation.output_conflicts
    }
  });
}

export function parseCloudigLibraryLegacyForRegression(options = {}) {
  return parseCloudigLibrary({ ...options, legacyProjectionWriterForRegression: true });
}
