import { createHash } from "node:crypto";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { libraryPaths } from "../../library/src/init.mjs";
import { normalizeConversation, serializeConversation } from "../../schema/serialize.mjs";
import { validateConversation } from "../../schema/validate.mjs";
import {
  acquireFileTransactionLock,
  atomicWriteText,
  beginFileSnapshotTransaction,
  fingerprintFile,
  pathExists,
  recoverFileSnapshotTransactions,
  sha256File
} from "./atomic.mjs";
import {
  CLAUDE_EXPORT_ADAPTER_ID,
  CLAUDE_EXPORT_ADAPTER_VERSION,
  CLAUDE_EXPORT_FORMAT,
  CLAUDE_CONVERSATION_SCHEMA,
  buildClaudeIndexRecord,
  claudeConversationKey,
  claudeExportSourceKey,
  convertClaudeConversation
} from "./claude-json-adapter.mjs";
import {
  DEFAULT_PROBE_LIMITS,
  claudeExportInputAdapter,
  createFileInput,
  probeInputAdapters
} from "./input-adapters.mjs";
import {
  conversationOutputGenerationStatus,
  reconcileCloudigState
} from "./library-orchestrator.mjs";
import { parseJsonArrayItem, readJsonSlice, streamTopLevelJsonArray } from "./json-array-stream.mjs";
import { createConversationOutputBatch, outputOwnership } from "./output-transaction.mjs";
import { prepareV1ParseTransaction } from "./v1-write-transaction.mjs";
import { PARSER } from "./index.mjs";
import { parserTimestamp } from "./time.mjs";
import {
  createParseState,
  normalizeParseState,
  serializeParseState,
  setSourceState,
  sourceStateMap
} from "./parse-state.mjs";
import { isSemanticVersion } from "./semver.mjs";

export const CLAUDE_INDEX_FORMAT = "cloudig/claude-export-index";
export const CLAUDE_INDEX_VERSION = "0.1.1";
const LEGACY_CLAUDE_INDEX_VERSION = "0.1.0";
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ADAPTER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const CONVERSATION_SCHEMA = /^ai-chat-archive\/conversation\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MAX_SELECTION = 2_000;
const DEFAULT_MAX_INDEX_ITEMS = 250_000;
const DEFAULT_MAX_ITEM_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_SELECTED_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_TRANSACTION_DISK_BYTES = 8 * 1024 * 1024 * 1024;
const TRANSACTION_JOURNAL_ALLOWANCE_BYTES = 1024 * 1024;
const OUTPUT_WATERMARK_FIELDS = Object.freeze([
  "schema",
  "schema_invalid",
  "parser_version",
  "parser_version_invalid",
  "parser_adapter",
  "exporter_version",
  "archive_id",
  "role",
  "first_parsed_at",
  "last_parsed_at"
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveSafeInteger(value, fallback, label) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function claudeResourceLimits(value = {}) {
  const limits = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    maxItemBytes: Math.min(
      DEFAULT_MAX_ITEM_BYTES,
      positiveSafeInteger(limits.maxItemBytes, DEFAULT_MAX_ITEM_BYTES, "limits.maxItemBytes")
    ),
    maxSelection: Math.min(
      MAX_SELECTION,
      positiveSafeInteger(limits.maxSelection, MAX_SELECTION, "limits.maxSelection")
    ),
    maxIndexItems: Math.min(
      DEFAULT_MAX_INDEX_ITEMS,
      positiveSafeInteger(limits.maxIndexItems, DEFAULT_MAX_INDEX_ITEMS, "limits.maxIndexItems")
    ),
    maxSelectedInputBytes: Math.min(
      DEFAULT_MAX_SELECTED_INPUT_BYTES,
      positiveSafeInteger(
        limits.maxSelectedInputBytes,
        DEFAULT_MAX_SELECTED_INPUT_BYTES,
        "limits.maxSelectedInputBytes"
      )
    ),
    maxTransactionDiskBytes: Math.min(
      DEFAULT_MAX_TRANSACTION_DISK_BYTES,
      positiveSafeInteger(
        limits.maxTransactionDiskBytes,
        DEFAULT_MAX_TRANSACTION_DISK_BYTES,
        "limits.maxTransactionDiskBytes"
      )
    )
  });
}

function serializedTarget(target, serialized) {
  const value = String(serialized);
  return Object.freeze({
    target,
    exists: true,
    sizeBytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
    atomicWriteBytes: Buffer.byteLength(value)
  });
}

function absentTarget(target) {
  return Object.freeze({ target, exists: false, atomicWriteBytes: 0 });
}

function bytesPrecondition(target, bytes) {
  return Object.freeze({
    target,
    exists: true,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

async function readParseStateSnapshot(filePath, { signal = null } = {}) {
  try {
    const bytes = signal ? await readFile(filePath, { signal }) : await readFile(filePath);
    const state = normalizeParseState(JSON.parse(bytes.toString("utf8")));
    throwIfAborted(signal, "Claude parse-state read");
    return Object.freeze({
      state,
      precondition: bytesPrecondition(filePath, bytes)
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ state: createParseState(), precondition: absentTarget(filePath) });
    }
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    throw new Error(`Cannot read parse-state.json: ${error.message}`, { cause: error });
  }
}

async function beginClaudeCompoundTransaction(paths, expectedTargets, {
  preconditionTargets = [],
  cleanupPaths = [],
  stagedBytes = 0,
  limits,
  signal = null,
  transactionLock = null
} = {}) {
  const deduplicated = new Map();
  for (const expected of expectedTargets) {
    const target = path.resolve(expected.target);
    const normalized = { ...expected, target };
    const previous = deduplicated.get(target);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`Conflicting expected states for Claude transaction target: ${path.basename(target)}`);
    }
    deduplicated.set(target, normalized);
  }
  const preconditions = new Map();
  for (const precondition of preconditionTargets) {
    const target = path.resolve(precondition.target);
    const normalized = { ...precondition, target };
    const previous = preconditions.get(target);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`Conflicting preconditions for Claude transaction target: ${path.basename(target)}`);
    }
    preconditions.set(target, normalized);
  }
  if (preconditions.size !== deduplicated.size
    || [...deduplicated.keys()].some((target) => !preconditions.has(target))) {
    throw new TypeError("Claude transaction preconditions must match its target set exactly");
  }
  const snapshotBytes = [...preconditions.values()]
    .reduce((total, precondition) => total + (precondition.exists === false ? 0 : Number(precondition.sizeBytes)), 0);
  const atomicWriteBytes = [...deduplicated.values()]
    .reduce((total, expected) => total + Number(expected.atomicWriteBytes || 0), 0);
  const requiredBytes = snapshotBytes + Number(stagedBytes || 0) + atomicWriteBytes + TRANSACTION_JOURNAL_ALLOWANCE_BYTES;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > limits.maxTransactionDiskBytes) {
    throw new RangeError(
      `Claude transaction staging, journal and rollback snapshots exceed the ${limits.maxTransactionDiskBytes}-byte disk limit`
    );
  }
  return beginFileSnapshotTransaction(paths.root, [...deduplicated.keys()], {
    cleanupPaths,
    lock: transactionLock,
    signal,
    preconditionTargets: [...preconditions.values()].map((precondition) => ({
      target: precondition.target,
      exists: precondition.exists,
      ...(precondition.exists === false ? {} : {
        sizeBytes: precondition.sizeBytes,
        sha256: precondition.sha256
      })
    })),
    expectedTargets: [...deduplicated.values()].map((expected) => ({
      target: expected.target,
      exists: expected.exists,
      ...(expected.exists ? { sizeBytes: expected.sizeBytes, sha256: expected.sha256 } : {})
    }))
  });
}

async function rollbackCompoundTransaction(transaction, originalError) {
  if (!transaction) throw originalError;
  try {
    await transaction.rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      `Claude transaction failed and automatic rollback could not complete: ${rollbackError.message}`
    );
  }
  throw originalError;
}

function throwIfAborted(signal, operation) {
  if (!signal?.aborted) return;
  const error = new Error(`${operation} was cancelled`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

async function reportProgress(onProgress, signal, phase, bytesDone, bytesTotal, itemsDone) {
  throwIfAborted(signal, phase);
  if (onProgress !== null && onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function");
  }
  if (typeof onProgress === "function") {
    await onProgress(Object.freeze({
      phase,
      bytesDone: Math.max(0, Number(bytesDone) || 0),
      bytesTotal: Math.max(0, Number(bytesTotal) || 0),
      itemsDone: Math.max(0, Number(itemsDone) || 0)
    }));
  }
  throwIfAborted(signal, phase);
}

async function runTransactionStep(callback, step, signal = null) {
  throwIfAborted(signal, `Claude transaction ${step}`);
  if (callback === null || callback === undefined) return;
  if (typeof callback !== "function") throw new TypeError("transactionStep must be a function");
  await callback(step);
  throwIfAborted(signal, `Claude transaction ${step}`);
}

function sourcePathFor(fileName) {
  return `Inbox/${fileName}`;
}

function indexKey(fileName) {
  return createHash("sha256").update(sourcePathFor(fileName).toLocaleLowerCase("en-US")).digest("hex").slice(0, 20);
}

function indexPath(paths, fileName) {
  return path.join(paths.indexes, `claude-${indexKey(fileName)}.json`);
}

function resolveInboxFile(paths, fileName) {
  const name = path.basename(cleanString(fileName));
  if (!name || name !== cleanString(fileName)) throw new Error("Claude source must be a direct child of the Cloudig Inbox directory");
  const absolute = path.resolve(paths.inbox, name);
  if (path.dirname(absolute) !== path.resolve(paths.inbox)) throw new Error("Claude source escaped the Cloudig Inbox directory");
  return { name, absolute };
}

function outputPath(paths, relativePath) {
  const normalized = cleanString(relativePath).replaceAll("\\", "/");
  if (!/^Conversations\/[^/]+\.json$/iu.test(normalized)) return "";
  const absolute = path.resolve(paths.root, ...normalized.split("/"));
  return path.dirname(absolute) === path.resolve(paths.conversations) ? absolute : "";
}

function normalizeOutput(value) {
  if (!value || typeof value !== "object") return undefined;
  const conversationKey = cleanString(value.conversation_key || value.conversation_id).toLowerCase();
  const sha256 = cleanString(value.sha256).toLowerCase();
  if (!SHA256.test(conversationKey) || !SHA256.test(sha256) || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1) return undefined;
  if (!cleanString(value.path) || !Number.isFinite(Date.parse(value.modified_at))) return undefined;
  const output = {
    conversation_key: conversationKey,
    path: cleanString(value.path).replaceAll("\\", "/"),
    size_bytes: value.size_bytes,
    modified_at: new Date(value.modified_at).toISOString(),
    sha256
  };
  if (value.schema_invalid === true) output.schema_invalid = true;
  if (Object.prototype.hasOwnProperty.call(value, "schema")) {
    const schema = typeof value.schema === "string" ? value.schema : "";
    if (CONVERSATION_SCHEMA.test(schema)) output.schema = schema;
    else output.schema_invalid = true;
  }
  if (value.parser_version_invalid === true) output.parser_version_invalid = true;
  if (Object.prototype.hasOwnProperty.call(value, "parser_version")) {
    const parserVersion = typeof value.parser_version === "string" ? value.parser_version : "";
    if (isSemanticVersion(parserVersion)) output.parser_version = parserVersion;
    else output.parser_version_invalid = true;
  }
  if (Object.prototype.hasOwnProperty.call(value, "parser_adapter")) {
    const adapterId = cleanString(value.parser_adapter?.id);
    const adapterVersion = cleanString(value.parser_adapter?.version);
    if (ADAPTER_ID.test(adapterId) && isSemanticVersion(adapterVersion)) {
      output.parser_adapter = { id: adapterId, version: adapterVersion };
    } else {
      output.parser_version_invalid = true;
    }
  }
  const exporterVersion = typeof value.exporter_version === "string" ? value.exporter_version : "";
  if (exporterVersion.trim()) output.exporter_version = exporterVersion;
  if (value.archive_id !== undefined || value.role !== undefined) {
    const archiveId = cleanString(value.archive_id).toLowerCase();
    if (UUID.test(archiveId) && ["current", "historical"].includes(value.role)
      && value.first_parsed_at && typeof value.first_parsed_at === "object"
      && Number.isFinite(Date.parse(value.last_parsed_at))) {
      output.archive_id = archiveId;
      output.role = value.role;
      output.first_parsed_at = structuredClone(value.first_parsed_at);
      output.last_parsed_at = new Date(value.last_parsed_at).toISOString();
    } else output.parser_version_invalid = true;
  }
  return output;
}

function withoutOutputWatermarks(value) {
  const output = { ...value };
  for (const field of OUTPUT_WATERMARK_FIELDS) delete output[field];
  return output;
}

function normalizeIndexRecord(value, position) {
  const conversationKey = cleanString(value?.conversation_key || value?.conversation_id).toLowerCase();
  if (!value || typeof value !== "object" || !SHA256.test(conversationKey)) {
    throw new TypeError(`Claude index conversation ${position} has an invalid identity`);
  }
  if (!Number.isSafeInteger(value.offset) || value.offset < 0 || !Number.isSafeInteger(value.length) || value.length < 1) {
    throw new TypeError(`Claude index conversation ${position} has an invalid byte range`);
  }
  if (!SHA256.test(cleanString(value.item_sha256))) throw new TypeError(`Claude index conversation ${position} has an invalid item hash`);
  const record = {
    conversation_key: conversationKey,
    offset: value.offset,
    length: value.length,
    item_sha256: cleanString(value.item_sha256),
    title: cleanString(value.title) || "Claude conversation",
    messages: Number.isSafeInteger(value.messages) && value.messages >= 0 ? value.messages : 0
  };
  for (const field of ["created_at", "updated_at"]) {
    if (cleanString(value[field]) && Number.isFinite(Date.parse(value[field]))) record[field] = new Date(value[field]).toISOString();
  }
  for (const field of ["branches", "fork_points", "orphan_parents"]) {
    if (Number.isSafeInteger(value[field]) && value[field] > 0) record[field] = value[field];
  }
  const output = normalizeOutput(value.output);
  if (output) record.output = output;
  if (value.stale === true && output) record.stale = true;
  return record;
}

function normalizeClaudeIndex(value) {
  if (!value || typeof value !== "object" || value.format !== CLAUDE_INDEX_FORMAT
    || ![LEGACY_CLAUDE_INDEX_VERSION, CLAUDE_INDEX_VERSION].includes(value.version)) {
    throw new TypeError("Unsupported Cloudig Claude export index");
  }
  const source = value.source;
  if (!source || typeof source !== "object" || path.basename(cleanString(source.file)) !== cleanString(source.file)) {
    throw new TypeError("Claude index source is invalid");
  }
  if (!Number.isSafeInteger(source.size_bytes) || source.size_bytes < 1 || !SHA256.test(cleanString(source.sha256))) {
    throw new TypeError("Claude index source metadata is invalid");
  }
  if (!Number.isFinite(Date.parse(source.modified_at))) throw new TypeError("Claude index source modified_at is invalid");
  if (!Array.isArray(value.conversations)) throw new TypeError("Claude index conversations must be an array");
  const conversations = value.conversations.map(normalizeIndexRecord);
  const identities = new Set();
  for (const record of conversations) {
    if (identities.has(record.conversation_key)) throw new TypeError(`Duplicate Claude conversation identity ${record.conversation_key}`);
    identities.add(record.conversation_key);
  }
  const sourceKey = cleanString(source.source_key || source.sha256).toLowerCase();
  if (!SHA256.test(sourceKey)) throw new TypeError("Claude index source_key is invalid");
  return {
    format: CLAUDE_INDEX_FORMAT,
    version: CLAUDE_INDEX_VERSION,
    source: {
      file: cleanString(source.file),
      source_key: sourceKey,
      size_bytes: source.size_bytes,
      modified_at: new Date(source.modified_at).toISOString(),
      sha256: cleanString(source.sha256)
    },
    adapter: {
      id: cleanString(value.adapter?.id) || CLAUDE_EXPORT_ADAPTER_ID,
      version: isSemanticVersion(cleanString(value.adapter?.version))
        ? cleanString(value.adapter.version)
        : CLAUDE_EXPORT_ADAPTER_VERSION,
      format: cleanString(value.adapter?.format) || CLAUDE_EXPORT_FORMAT
    },
    indexed_at: Number.isFinite(Date.parse(value.indexed_at)) ? new Date(value.indexed_at).toISOString() : new Date(0).toISOString(),
    conversations
  };
}

export function serializeClaudeIndex(value) {
  return `${JSON.stringify(normalizeClaudeIndex(value), null, 2)}\n`;
}

async function readClaudeIndexSnapshot(paths, fileName, { signal = null } = {}) {
  const target = indexPath(paths, fileName);
  try {
    const bytes = signal ? await readFile(target, { signal }) : await readFile(target);
    const index = normalizeClaudeIndex(JSON.parse(bytes.toString("utf8")));
    throwIfAborted(signal, "Claude index read");
    return Object.freeze({
      index,
      precondition: bytesPrecondition(target, bytes)
    });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ index: null, precondition: absentTarget(target) });
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    throw new Error(`Cannot read the Claude index for ${path.basename(fileName)}: ${error.message}`, { cause: error });
  }
}

async function writeClaudeIndex(paths, index, { signal = null, precondition = null } = {}) {
  return atomicWriteText(indexPath(paths, index.source.file), serializeClaudeIndex(index), { signal, precondition });
}

async function readClaudeIndexEntries(paths, { signal = null } = {}) {
  let names = [];
  try {
    names = await readdir(paths.indexes);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const name of names.filter((value) => /^claude-[0-9a-f]{20}\.json$/u.test(value)).sort()) {
    throwIfAborted(signal, "Claude index list");
    const filePath = path.join(paths.indexes, name);
    try {
      const bytes = signal ? await readFile(filePath, { signal }) : await readFile(filePath);
      entries.push({
        filePath,
        index: normalizeClaudeIndex(JSON.parse(bytes.toString("utf8"))),
        precondition: bytesPrecondition(filePath, bytes)
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
      // A malformed operational index remains isolated and can be rebuilt explicitly.
    }
  }
  return entries;
}

async function resolvePreviousIndex(paths, predicate, label, currentFileName, { signal = null } = {}) {
  const matches = (await readClaudeIndexEntries(paths, { signal }))
    .filter(({ index }) => index.source.file !== currentFileName && predicate(index));
  const present = [];
  const missing = [];
  for (const match of matches) {
    throwIfAborted(signal, "Claude previous-index resolution");
    if (await pathExists(path.join(paths.inbox, match.index.source.file))) present.push(match);
    else missing.push(match);
  }
  if (present.length) {
    return {
      previous: null,
      conflicts: present.map(({ index }) => index.source.file).sort((left, right) => left.localeCompare(right, "en"))
    };
  }
  if (missing.length > 1) {
    throw new Error(`Multiple missing Claude indexes match ${label}; Cloudig will not guess their identity`);
  }
  return { previous: missing[0] || null, conflicts: [] };
}

function mergeClaudeOutputs(...groups) {
  const outputs = new Map();
  for (const group of groups) {
    for (const value of group || []) {
      const output = normalizeOutput(value);
      if (!output) continue;
      const previous = outputs.get(output.conversation_key);
      if (previous && (previous.path !== output.path || previous.sha256 !== output.sha256)) {
        throw new Error(`Multiple normalized outputs claim Claude conversation ${output.conversation_key.slice(0, 12)}; Cloudig will not guess`);
      }
      if (!previous) {
        outputs.set(output.conversation_key, output);
        continue;
      }
      const merged = withoutOutputWatermarks({ ...previous, ...output });
      for (const field of OUTPUT_WATERMARK_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(output, field)) merged[field] = output[field];
        else if (previous.archive_id && Object.prototype.hasOwnProperty.call(previous, field)) merged[field] = previous[field];
      }
      outputs.set(output.conversation_key, merged);
    }
  }
  return [...outputs.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function reconcileClaudeParseState(paths, state, index, information, previousFileName = "") {
  const normalized = normalizeParseState(state);
  const relativeSource = sourcePathFor(index.source.file);
  const current = sourceStateMap(normalized).get(relativeSource) || null;
  const previousPath = previousFileName && previousFileName !== index.source.file
    ? sourcePathFor(previousFileName)
    : "";
  const candidates = new Map();
  for (const source of normalized.sources) {
    if (source.path === relativeSource) continue;
    if (source.path === previousPath || source.source_key === index.source.source_key) {
      candidates.set(source.path, source);
    }
  }
  const present = [];
  const missing = [];
  for (const source of candidates.values()) {
    const absolute = path.resolve(paths.root, ...source.path.split("/"));
    if (await pathExists(absolute)) present.push(source);
    else missing.push(source);
  }
  if (present.length) {
    throw new Error(`Another current Claude export has the same stable source identity: ${present.map((source) => path.basename(source.path)).join(", ")}`);
  }
  if (missing.length > 1) {
    throw new Error("Multiple missing Claude parse-state sources have the same stable identity; Cloudig will not guess");
  }
  const previous = missing[0] || null;
  const outputs = mergeClaudeOutputs(
    previous?.outputs,
    current?.outputs,
    index.conversations.map((record) => record.output).filter(Boolean)
  );
  const sourceCreatedAt = previous?.source_created_at
    || current?.source_created_at
    || (Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0
      ? information.birthtime
      : information.ctime).toISOString();
  const sourceModifiedAt = information.mtime.toISOString();
  const capturedAt = previous?.captured_at || current?.captured_at || {
    value: [sourceCreatedAt, sourceModifiedAt].sort((left, right) => Date.parse(left) - Date.parse(right))[0],
    basis: "filesystem_earliest_create_or_modify"
  };
  const base = previous || current || {};
  const nextSource = {
    ...base,
    path: relativeSource,
    size_bytes: index.source.size_bytes,
    modified_at: index.source.modified_at,
    ...(normalized.version === "1.0.0" ? { captured_at: capturedAt } : { source_created_at: sourceCreatedAt }),
    source_key: index.source.source_key,
    sha256: index.source.sha256,
    adapter: current?.adapter || previous?.adapter || {
      id: CLAUDE_EXPORT_ADAPTER_ID,
      version: CLAUDE_EXPORT_ADAPTER_VERSION,
      format: CLAUDE_EXPORT_FORMAT
    },
    source_adapter: previous?.source_adapter || current?.source_adapter,
    parser_version: normalized.version === "1.0.0" ? PARSER.version : base.parser_version || PARSER.version,
    status: outputs.length ? "success" : "pending",
    last_attempt_at: current?.last_attempt_at || previous?.last_attempt_at,
    last_success_at: previous?.last_success_at || current?.last_success_at,
    outputs,
    dismissed: false,
    error: undefined
  };
  const replacedPaths = new Set([relativeSource, ...candidates.keys()]);
  const next = normalizeParseState({
    ...normalized,
    sources: [
      ...normalized.sources.filter((source) => !replacedPaths.has(source.path)),
      nextSource
    ]
  });
  return {
    state: next,
    changed: JSON.stringify(next) !== JSON.stringify(normalized),
    previous_path: previous?.path || ""
  };
}

async function prepareClaudeParseState(paths, index, information, previousFileName = "", { signal = null } = {}) {
  const snapshot = await readParseStateSnapshot(paths.parseState, { signal });
  throwIfAborted(signal, "Claude parse-state preparation");
  const general = await reconcileCloudigState(paths, snapshot.state);
  throwIfAborted(signal, "Claude parse-state preparation");
  const specialized = await reconcileClaudeParseState(paths, general.state, index, information, previousFileName);
  throwIfAborted(signal, "Claude parse-state preparation");
  return {
    state: specialized.state,
    changed: general.changed || specialized.changed,
    precondition: snapshot.precondition
  };
}

async function activeClaudeIndexConflicts(paths, index, { signal = null } = {}) {
  const conflicts = [];
  for (const entry of await readClaudeIndexEntries(paths, { signal })) {
    throwIfAborted(signal, "Claude active-index conflict scan");
    if (entry.index.source.file === index.source.file) continue;
    if (entry.index.source.source_key !== index.source.source_key) continue;
    if (await pathExists(path.join(paths.inbox, entry.index.source.file))) conflicts.push(entry.index.source.file);
  }
  return conflicts.sort((left, right) => left.localeCompare(right, "en"));
}

async function commitClaudeIndexAndParseState(paths, index, information, previousFileName, {
  migrateParseState,
  limits,
  transactionStep = null,
  signal = null,
  transactionLock = null,
  indexPrecondition,
  previousPrecondition = null
}) {
  const target = indexPath(paths, index.source.file);
  const serializedIndex = serializeClaudeIndex(index);
  const expectedTargets = [serializedTarget(target, serializedIndex)];
  const preconditionTargets = [indexPrecondition];
  const oldName = path.basename(cleanString(previousFileName));
  const previous = oldName && oldName !== index.source.file ? indexPath(paths, oldName) : "";
  if (previous && previous !== target) {
    if (!previousPrecondition) throw new TypeError("Claude index migration requires the prior index precondition");
    expectedTargets.push(absentTarget(previous));
    preconditionTargets.push(previousPrecondition);
  }
  let preparedState = null;
  let serializedState = "";
  if (migrateParseState) {
    preparedState = await prepareClaudeParseState(paths, index, information, previousFileName, { signal });
    if (preparedState.changed) {
      serializedState = serializeParseState(preparedState.state);
      expectedTargets.push(serializedTarget(paths.parseState, serializedState));
      preconditionTargets.push(preparedState.precondition);
    }
  }
  const transaction = await beginClaudeCompoundTransaction(paths, expectedTargets, {
    preconditionTargets,
    limits,
    signal,
    transactionLock
  });
  try {
    await transaction.beginMutation({ signal });
    await runTransactionStep(transactionStep, "after_snapshot", signal);
    const status = await atomicWriteText(target, serializedIndex, { signal, precondition: indexPrecondition });
    await runTransactionStep(transactionStep, "after_index", signal);
    if (previous && previous !== target) {
      await transaction.assertBefore(previous, { signal });
      if (await pathExists(previous)) {
        await transaction.assertBefore(previous, { signal });
        throwIfAborted(signal, "Claude prior index removal");
        await unlink(previous);
        throwIfAborted(signal, "Claude prior index removal");
      }
    }
    if (serializedState) {
      await atomicWriteText(paths.parseState, serializedState, {
        signal,
        precondition: preparedState.precondition
      });
    }
    await runTransactionStep(transactionStep, "after_parse_state", signal);
    await transaction.commit({ signal });
    return status;
  } catch (error) {
    await rollbackCompoundTransaction(transaction, error);
  }
}

function indexSummary(index) {
  const conversations = index.conversations.map((record) => {
    const versionStatus = record.output
      ? conversationOutputGenerationStatus({}, record.output)
      : "current";
    return {
      conversation_key: record.conversation_key,
      title: record.title,
      created_at: record.created_at || "",
      updated_at: record.updated_at || "",
      messages: record.messages,
      branches: record.branches || 0,
      fork_points: record.fork_points || 0,
      orphan_parents: record.orphan_parents || 0,
      status: record.stale || versionStatus === "needs_reparse"
        ? "stale"
        : record.output ? "parsed" : "ready",
      version_status: versionStatus,
      output: record.output?.path || ""
    };
  });
  const versionStatuses = Object.create(null);
  for (const record of conversations) {
    if (!record.output) continue;
    versionStatuses[record.version_status] = (versionStatuses[record.version_status] || 0) + 1;
  }
  return {
    ok: true,
    source: { ...index.source },
    indexed_at: index.indexed_at,
    counts: {
      total: conversations.length,
      parsed: conversations.filter((record) => record.status === "parsed").length,
      stale: conversations.filter((record) => record.status === "stale").length,
      ready: conversations.filter((record) => record.status === "ready").length,
      version_statuses: versionStatuses
    },
    conversations
  };
}

export async function getClaudeIndex(rootPath, fileName) {
  const paths = libraryPaths(rootPath);
  const transactionLock = await acquireFileTransactionLock(paths.root);
  try {
  await recoverFileSnapshotTransactions(paths.root, { lock: transactionLock });
  const snapshot = await readClaudeIndexSnapshot(paths, fileName);
  let index = snapshot.index;
  if (!index) throw new Error(`Claude export has not been indexed: ${path.basename(fileName)}`);
  index = await refreshClaudeOutputStatuses(rootPath, index, { precondition: snapshot.precondition, lock: transactionLock });
  return indexSummary(index);
  } finally {
    await transactionLock.release();
  }
}

export async function listClaudeIndexes(rootPath) {
  const paths = libraryPaths(rootPath);
  const transactionLock = await acquireFileTransactionLock(paths.root);
  try {
  await recoverFileSnapshotTransactions(paths.root, { lock: transactionLock });
  const results = [];
  for (const { index, precondition } of await readClaudeIndexEntries(paths)) {
    try {
      const value = await refreshClaudeOutputStatuses(rootPath, index, { precondition, lock: transactionLock });
      results.push(indexSummary(value));
    } catch {
      // A malformed operational index remains isolated and is rebuilt explicitly.
    }
  }
  return results;
  } finally {
    await transactionLock.release();
  }
}

export async function indexClaudeExport(rootPath, fileName, {
  force = false,
  clock = () => new Date(),
  signal = null,
  onProgress = null,
  transactionStep = null,
  limits: rawLimits = {}
} = {}) {
  const limits = claudeResourceLimits(rawLimits);
  throwIfAborted(signal, "Claude index");
  const paths = libraryPaths(rootPath);
  const transactionLock = await acquireFileTransactionLock(paths.root, { signal });
  try {
  await recoverFileSnapshotTransactions(paths.root, { lock: transactionLock });
  throwIfAborted(signal, "Claude index recovery");
  const source = resolveInboxFile(paths, fileName);
  const information = await stat(source.absolute);
  if (!information.isFile()) throw new Error("Selected Claude Inbox item is not a regular file");
  const currentIndexSnapshot = await readClaudeIndexSnapshot(paths, source.name, { signal });
  let previous = currentIndexSnapshot.index;
  let previousPrecondition = null;
  let previousFileName = previous?.source.file || "";
  if (!force && previous
    && previous.source.size_bytes === information.size
    && previous.source.modified_at === information.mtime.toISOString()
    && previous.adapter.version === CLAUDE_EXPORT_ADAPTER_VERSION) {
    throwIfAborted(signal, "Claude index refresh");
    const refreshed = await refreshClaudeOutputStatuses(rootPath, previous, {
      signal,
      precondition: currentIndexSnapshot.precondition,
      lock: transactionLock
    });
    return { ...indexSummary(refreshed), write_status: "unchanged", reason: "metadata_unchanged" };
  }

  const input = await createFileInput(source.absolute, { relativePath: sourcePathFor(source.name), information });
  const probeBytes = Math.min(Number.MAX_SAFE_INTEGER, limits.maxItemBytes + 64 * 1024);
  const selection = await probeInputAdapters(input, [claudeExportInputAdapter], {
    ...DEFAULT_PROBE_LIMITS,
    sequentialBytes: probeBytes,
    maxItemBytes: limits.maxItemBytes
  });
  if (selection.adapter?.id !== CLAUDE_EXPORT_ADAPTER_ID) {
    const reason = selection.attempts.find(({ adapter }) => adapter.id === CLAUDE_EXPORT_ADAPTER_ID)?.result.reason || "";
    if (/item limit/u.test(reason)) throw new RangeError(reason);
    throw new Error("Selected JSON is not a supported Claude account export");
  }
  await reportProgress(onProgress, signal, "hash", 0, information.size, 0);
  const sourceSha256 = await sha256File(source.absolute, {
    signal,
    onProgress: (bytesDone) => reportProgress(onProgress, signal, "hash", bytesDone, information.size, 0)
  });
  const sourceConflicts = new Set();
  if (!previous) {
    const resolution = await resolvePreviousIndex(
      paths,
      (candidate) => candidate.source.sha256 === sourceSha256,
      "the renamed Claude source bytes",
      source.name,
      { signal }
    );
    resolution.conflicts.forEach((name) => sourceConflicts.add(name));
    previous = resolution.previous?.index || null;
    previousPrecondition = resolution.previous?.precondition || null;
    previousFileName = previous?.source.file || "";
  }
  if (!force && previous?.source.sha256 === sourceSha256) {
    const refreshed = {
      ...previous,
      source: {
        ...previous.source,
        file: source.name,
        size_bytes: information.size,
        modified_at: information.mtime.toISOString()
      },
      indexed_at: clock().toISOString()
    };
    await reportProgress(onProgress, signal, "precommit", information.size, information.size, refreshed.conversations.length);
    await runTransactionStep(transactionStep, "after_precommit", signal);
    const writeStatus = await commitClaudeIndexAndParseState(paths, refreshed, information, previousFileName, {
      migrateParseState: true,
      limits,
      transactionStep,
      signal,
      transactionLock,
      indexPrecondition: currentIndexSnapshot.precondition,
      previousPrecondition
    });
    return {
      ...indexSummary(refreshed),
      write_status: writeStatus,
      reason: "source_hash_unchanged",
      source_conflicts: []
    };
  }

  const conversations = [];
  let discoveredSourceKey = "";
  let scannedItems = 0;
  await reportProgress(onProgress, signal, "scan", 0, information.size, 0);
  try {
    for await (const item of streamTopLevelJsonArray(input.openStream({ highWaterMark: 512 * 1024 }), {
      maxItemBytes: limits.maxItemBytes,
      maxItems: limits.maxIndexItems,
      signal
    })) {
      const original = parseJsonArrayItem(item);
      const itemSourceKey = claudeExportSourceKey(original, sourceSha256);
      if (discoveredSourceKey && discoveredSourceKey !== itemSourceKey) {
        throw new Error("Claude export contains conversations from more than one source identity");
      }
      discoveredSourceKey = itemSourceKey;
      conversations.push(buildClaudeIndexRecord(original, item));
      scannedItems += 1;
      await reportProgress(
        onProgress,
        signal,
        "scan",
        Math.min(information.size, item.offset + item.length),
        information.size,
        scannedItems
      );
    }
  } catch (error) {
    if (error?.code === "JSON_ARRAY_MAX_ITEMS") {
      throw new RangeError(`Claude export exceeds the ${limits.maxIndexItems}-item index limit`, { cause: error });
    }
    throw error;
  }
  await reportProgress(onProgress, signal, "scan", information.size, information.size, scannedItems);
  if (!previous && discoveredSourceKey) {
    const resolution = await resolvePreviousIndex(
      paths,
      (candidate) => candidate.source.source_key === discoveredSourceKey,
      "the Claude source identity",
      source.name,
      { signal }
    );
    resolution.conflicts.forEach((name) => sourceConflicts.add(name));
    previous = resolution.previous?.index || null;
    previousPrecondition = resolution.previous?.precondition || null;
    previousFileName = previous?.source.file || "";
  }
  const previousRecords = new Map((previous?.conversations || []).map((record) => [record.conversation_key, record]));
  for (const record of conversations) {
    const old = previousRecords.get(record.conversation_key);
    if (!old?.output) continue;
    record.output = old.output;
    if (old.item_sha256 !== record.item_sha256 || old.stale) record.stale = true;
  }
  const index = {
    format: CLAUDE_INDEX_FORMAT,
    version: CLAUDE_INDEX_VERSION,
    source: {
      file: source.name,
      source_key: previous?.source.source_key || discoveredSourceKey || sourceSha256,
      size_bytes: information.size,
      modified_at: information.mtime.toISOString(),
      sha256: sourceSha256
    },
    adapter: {
      id: CLAUDE_EXPORT_ADAPTER_ID,
      version: CLAUDE_EXPORT_ADAPTER_VERSION,
      format: CLAUDE_EXPORT_FORMAT
    },
    indexed_at: clock().toISOString(),
    conversations
  };
  await reportProgress(onProgress, signal, "precommit", information.size, information.size, scannedItems);
  await runTransactionStep(transactionStep, "after_precommit", signal);
  const writeStatus = await commitClaudeIndexAndParseState(paths, index, information, previousFileName, {
    migrateParseState: !sourceConflicts.size,
    limits,
    transactionStep,
    signal,
    transactionLock,
    indexPrecondition: currentIndexSnapshot.precondition,
    previousPrecondition
  });
  return {
    ...indexSummary(index),
    write_status: writeStatus,
    reason: sourceConflicts.size ? "source_identity_conflict" : "indexed",
    source_conflicts: [...sourceConflicts].sort((left, right) => left.localeCompare(right, "en"))
  };
  } finally {
    await transactionLock.release();
  }
}

export async function extractClaudeConversations(rootPath, fileName, conversationKeys, {
  clock = () => new Date(),
  preservePrevious = false,
  signal = null,
  onProgress = null,
  transactionStep = null,
  limits: rawLimits = {}
} = {}) {
  const limits = claudeResourceLimits(rawLimits);
  throwIfAborted(signal, "Claude extraction");
  const selected = [...new Set((conversationKeys || []).map((value) => cleanString(value).toLowerCase()))];
  if (!selected.length) throw new Error("Select at least one Claude conversation to parse");
  if (selected.length > limits.maxSelection) throw new Error(`At most ${limits.maxSelection} Claude conversations can be parsed in one transaction`);
  if (selected.some((identity) => !SHA256.test(identity))) throw new Error("Claude conversation selection contains an invalid identity");
  const paths = libraryPaths(rootPath);
  const transactionLock = await acquireFileTransactionLock(paths.root, { signal });
  try {
  await recoverFileSnapshotTransactions(paths.root, { lock: transactionLock });
  throwIfAborted(signal, "Claude extraction recovery");
  const source = resolveInboxFile(paths, fileName);
  const information = await stat(source.absolute);
  const indexSnapshot = await readClaudeIndexSnapshot(paths, source.name, { signal });
  let index = indexSnapshot.index;
  if (!index) throw new Error("Index this Claude export before selecting conversations");
  if (index.source.size_bytes !== information.size || index.source.modified_at !== information.mtime.toISOString()) {
    throw new Error("Claude export changed after indexing; rebuild its conversation list before parsing");
  }
  const records = new Map(index.conversations.map((record) => [record.conversation_key, record]));
  const missing = selected.filter((identity) => !records.has(identity));
  if (missing.length) throw new Error(`${missing.length} selected Claude conversations are absent from the current index`);
  const selectedSet = new Set(selected);
  const selectedRecords = index.conversations.filter((record) => selectedSet.has(record.conversation_key));
  let selectedInputBytes = 0;
  for (const record of selectedRecords) {
    if (record.length > limits.maxItemBytes) {
      throw new RangeError(`Selected Claude conversation exceeds the ${limits.maxItemBytes}-byte item limit`);
    }
    selectedInputBytes += record.length;
    if (!Number.isSafeInteger(selectedInputBytes) || selectedInputBytes > limits.maxSelectedInputBytes) {
      throw new RangeError(`Selected Claude conversations exceed the ${limits.maxSelectedInputBytes}-byte transaction input limit`);
    }
  }
  throwIfAborted(signal, "Claude extraction preflight");
  const activeIndexConflicts = await activeClaudeIndexConflicts(paths, index, { signal });
  if (activeIndexConflicts.length) {
    throw new Error(`Another current Claude export has the same stable source identity: ${activeIndexConflicts.join(", ")}`);
  }
  throwIfAborted(signal, "Claude extraction preflight");
  index = await refreshClaudeOutputStatuses(rootPath, index, { persist: false, signal, lock: transactionLock });
  throwIfAborted(signal, "Claude extraction refresh");

  const parseStateSnapshot = await readParseStateSnapshot(paths.parseState, { signal });
  let parseState = parseStateSnapshot.state;
  throwIfAborted(signal, "Claude parse-state reconciliation");
  const reconciliation = await reconcileCloudigState(paths, parseState);
  throwIfAborted(signal, "Claude parse-state reconciliation");
  const specialized = await reconcileClaudeParseState(paths, reconciliation.state, index, information);
  throwIfAborted(signal, "Claude parse-state reconciliation");
  parseState = specialized.state;
  const relativeSource = sourcePathFor(source.name);
  const previousSource = sourceStateMap(parseState).get(relativeSource) || null;
  const sourceCreatedAt = previousSource?.captured_at?.value || previousSource?.source_created_at
    || (Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0
      ? information.birthtime
      : information.ctime).toISOString();
  const previousOutputs = mergeClaudeOutputs(
    previousSource?.outputs,
    index.conversations.map((record) => record.output).filter(Boolean)
  );
  const newerSelected = index.conversations.filter((record) =>
    selectedSet.has(record.conversation_key)
    && record.output
    && conversationOutputGenerationStatus(previousSource, record.output) === "newer_generated"
  );
  if (newerSelected.length) {
    throw new Error(`${newerSelected.length} selected Claude conversation(s) were generated by a newer Parser; Cloudig kept them unchanged`);
  }
  const parsedAt = parserTimestamp({ clock });
  if (parseState.version === "1.0.0") {
    const legacyConversations = [];
    let processedBytes = 0;
    let processedItems = 0;
    for (const record of selectedRecords) {
      const raw = await readJsonSlice(source.absolute, record.offset, record.length, {
        maxBytes: limits.maxItemBytes,
        signal,
        onProgress: (itemBytesDone) => reportProgress(
          onProgress,
          signal,
          "slice",
          processedBytes + itemBytesDone,
          selectedInputBytes,
          processedItems
        )
      });
      if (createHash("sha256").update(raw).digest("hex") !== record.item_sha256) {
        throw new Error(`Indexed Claude conversation ${record.conversation_key.slice(0, 12)} changed on disk`);
      }
      const original = JSON.parse(raw.toString("utf8"));
      if (claudeConversationKey(original.uuid) !== record.conversation_key) throw new Error("Claude conversation identity does not match its index");
      const normalized = normalizeConversation({
        ...convertClaudeConversation(original, {
          sourceFile: source.name,
          sourceSha256: index.source.sha256,
          sourceSizeBytes: index.source.size_bytes,
          sourceCreatedAt,
          parsedAt
        }),
        schema: CLAUDE_CONVERSATION_SCHEMA
      });
      const validation = validateConversation(normalized);
      if (!validation.valid) throw new Error(`Claude unified conversation validation failed: ${validation.errors[0]}`);
      legacyConversations.push(normalized);
      processedBytes += record.length;
      processedItems += 1;
      await reportProgress(onProgress, signal, "convert", processedBytes, selectedInputBytes, processedItems);
    }
    const sourceCreation = (Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0
      ? information.birthtime
      : information.ctime).toISOString();
    const capturedAt = previousSource?.captured_at || {
      value: [sourceCreation, information.mtime.toISOString()].sort((left, right) => Date.parse(left) - Date.parse(right))[0],
      basis: "filesystem_earliest_create_or_modify"
    };
    let nextIndex = null;
    const prepared = await prepareV1ParseTransaction({
      paths,
      source: {
        path: relativeSource,
        size_bytes: index.source.size_bytes,
        modified_at: index.source.modified_at,
        captured_at: capturedAt,
        source_key: index.source.source_key,
        sha256: index.source.sha256,
        adapter: { id: CLAUDE_EXPORT_ADAPTER_ID, version: CLAUDE_EXPORT_ADAPTER_VERSION, format: CLAUDE_EXPORT_FORMAT },
        source_adapter: { id: CLAUDE_EXPORT_ADAPTER_ID, version: CLAUDE_EXPORT_ADAPTER_VERSION },
        parser_version: PARSER.version,
        status: "parsing",
        last_attempt_at: parsedAt,
        last_success_at: previousSource?.last_success_at,
        outputs: previousOutputs
      },
      legacyConversations,
      parsedAt,
      preservePrevious,
      retainUnselectedCurrent: true,
      transactionLock,
      signal,
      dependencies: {
        begin_transaction(_root, _targets, transactionOptions) {
          return beginClaudeCompoundTransaction(paths, transactionOptions.expectedTargets.map((target) => ({
            ...target,
            atomicWriteBytes: target.exists ? target.sizeBytes : 0
          })), {
            preconditionTargets: transactionOptions.preconditionTargets,
            limits,
            signal: transactionOptions.signal,
            transactionLock: transactionOptions.lock
          });
        }
      },
      additionalTargetBuilder({ outputs }) {
        const currentOutputs = new Map(outputs
          .filter((output) => output.role === "current")
          .map((output) => [output.conversation_key, output]));
        nextIndex = {
          ...index,
          conversations: index.conversations.map((record) => {
            const current = currentOutputs.get(record.conversation_key);
            if (!current) return record;
            return selectedSet.has(record.conversation_key)
              ? { ...record, output: current, stale: undefined }
              : { ...record, output: current };
          }),
          indexed_at: parsedAt
        };
        return [{ target: indexPath(paths, nextIndex.source.file), text: serializeClaudeIndex(nextIndex) }];
      }
    });
    await reportProgress(onProgress, signal, "stage", selectedInputBytes, selectedInputBytes, selectedRecords.length);
    await reportProgress(onProgress, signal, "precommit", selectedInputBytes, selectedInputBytes, selectedRecords.length);
    await runTransactionStep(transactionStep, "after_precommit", signal);
    const transaction = await prepared.commit();
    await runTransactionStep(transactionStep, "after_parse_state", signal);
    return {
      ok: true,
      source: source.name,
      selected: selected.length,
      parsed: nextIndex.conversations.filter((record) => record.output && !record.stale).length,
      total: nextIndex.conversations.length,
      write_status: transaction.write_status,
      backup: "",
      outputs: selected.map((identity) => transaction.outputs.find((output) => output.role === "current" && output.conversation_key === identity)?.path).filter(Boolean)
    };
  }
  let batch = await createConversationOutputBatch({
    paths,
    inputName: source.name,
    sourcePath: relativeSource,
    sourceSha256: index.source.sha256,
    previousOutputs,
    ownership: outputOwnership(parseState),
    forceMultiple: true,
    retainPreviousOutputs: true,
    now: new Date(parsedAt)
  });
  let compoundTransaction = null;
  try {
    let processedBytes = 0;
    let processedItems = 0;
    for (const record of selectedRecords) {
      const raw = await readJsonSlice(source.absolute, record.offset, record.length, {
        maxBytes: limits.maxItemBytes,
        signal,
        onProgress: (itemBytesDone) => reportProgress(
          onProgress,
          signal,
          "slice",
          processedBytes + itemBytesDone,
          selectedInputBytes,
          processedItems
        )
      });
      const digest = createHash("sha256").update(raw).digest("hex");
      if (digest !== record.item_sha256) throw new Error(`Indexed Claude conversation ${record.conversation_key.slice(0, 12)} changed on disk`);
      const original = JSON.parse(raw.toString("utf8"));
      if (claudeConversationKey(original.uuid) !== record.conversation_key) throw new Error("Claude conversation identity does not match its index");
      await reportProgress(onProgress, signal, "convert", processedBytes, selectedInputBytes, processedItems);
      const normalized = normalizeConversation({
        ...convertClaudeConversation(original, {
          sourceFile: source.name,
          sourceSha256: index.source.sha256,
          sourceSizeBytes: index.source.size_bytes,
          sourceCreatedAt,
          parsedAt
        }),
        schema: CLAUDE_CONVERSATION_SCHEMA,
        parser_version: PARSER.version
      });
      const validation = validateConversation(normalized);
      if (!validation.valid) throw new Error(`Claude unified conversation validation failed: ${validation.errors[0]}`);
      await reportProgress(
        onProgress,
        signal,
        "convert",
        processedBytes + record.length,
        selectedInputBytes,
        processedItems + 1
      );
      await batch.stage({
        conversationKey: normalized.conversation_key,
        serialized: serializeConversation(normalized),
        schema: normalized.schema,
        parserVersion: PARSER.version,
        parserAdapter: normalized.parser_adapter,
        signal
      });
      processedBytes += record.length;
      processedItems += 1;
      await reportProgress(onProgress, signal, "stage", processedBytes, selectedInputBytes, processedItems);
    }
    await reportProgress(onProgress, signal, "precommit", selectedInputBytes, selectedInputBytes, selectedRecords.length);
    await runTransactionStep(transactionStep, "after_precommit", signal);
    const plan = await batch.plan({ signal });
    const outputs = new Map(plan.outputs.map((output) => [output.conversation_key, { ...output }]));
    const nextIndex = {
      ...index,
      conversations: index.conversations.map((record) => selectedSet.has(record.conversation_key)
        ? { ...record, output: outputs.get(record.conversation_key), stale: undefined }
        : record),
      indexed_at: clock().toISOString()
    };
    const completedAt = clock().toISOString();
    const nextParseState = setSourceState(parseState, {
      path: relativeSource,
      size_bytes: nextIndex.source.size_bytes,
      modified_at: nextIndex.source.modified_at,
      source_created_at: sourceCreatedAt,
      source_key: nextIndex.source.source_key,
      sha256: nextIndex.source.sha256,
      adapter: { id: CLAUDE_EXPORT_ADAPTER_ID, version: CLAUDE_EXPORT_ADAPTER_VERSION, format: CLAUDE_EXPORT_FORMAT },
      source_adapter: { id: CLAUDE_EXPORT_ADAPTER_ID, version: CLAUDE_EXPORT_ADAPTER_VERSION },
      parser_version: PARSER.version,
      status: "success",
      last_attempt_at: completedAt,
      last_success_at: completedAt,
      outputs: plan.outputs
    });
    const serializedIndex = serializeClaudeIndex(nextIndex);
    const serializedState = serializeParseState(nextParseState);
    compoundTransaction = await beginClaudeCompoundTransaction(paths, [
      ...plan.targets.map((target) => ({
        target: target.targetPath,
        exists: true,
        sizeBytes: target.sizeBytes,
        sha256: target.sha256,
        atomicWriteBytes: 0
      })),
      ...plan.obsolete.map((target) => absentTarget(target.targetPath)),
      serializedTarget(indexPath(paths, nextIndex.source.file), serializedIndex),
      serializedTarget(paths.parseState, serializedState)
    ], {
      preconditionTargets: [
        ...plan.preconditions,
        indexSnapshot.precondition,
        parseStateSnapshot.precondition
      ],
      cleanupPaths: plan.rollbackCleanupPaths,
      stagedBytes: plan.stagedBytes,
      limits,
      signal,
      transactionLock
    });
    await compoundTransaction.beginMutation({ signal });
    await runTransactionStep(transactionStep, "after_snapshot", signal);
    const transaction = await batch.commit({ signal });
    batch = null;
    await runTransactionStep(transactionStep, "after_outputs", signal);
    await atomicWriteText(indexPath(paths, nextIndex.source.file), serializedIndex, {
      signal,
      precondition: indexSnapshot.precondition
    });
    await runTransactionStep(transactionStep, "after_index", signal);
    await atomicWriteText(paths.parseState, serializedState, {
      signal,
      precondition: parseStateSnapshot.precondition
    });
    await runTransactionStep(transactionStep, "after_parse_state", signal);
    await compoundTransaction.commit({ signal });
    compoundTransaction = null;
    return {
      ok: true,
      source: source.name,
      selected: selected.length,
      parsed: nextIndex.conversations.filter((record) => record.output && !record.stale).length,
      total: nextIndex.conversations.length,
      write_status: transaction.writeStatus,
      backup: transaction.backup || "",
      outputs: selected.map((identity) => outputs.get(identity)?.path).filter(Boolean)
    };
  } catch (error) {
    await batch?.abort();
    await rollbackCompoundTransaction(compoundTransaction, error);
  }
  } finally {
    await transactionLock.release();
  }
}

export async function refreshClaudeOutputStatuses(rootPath, index, {
  persist = true,
  signal = null,
  precondition = null,
  lock = null
} = {}) {
  const paths = libraryPaths(rootPath);
  const transactionLock = lock || await acquireFileTransactionLock(paths.root, { signal });
  try {
  await recoverFileSnapshotTransactions(paths.root, { lock: transactionLock });
  throwIfAborted(signal, "Claude output refresh");
  const target = indexPath(paths, index.source.file);
  const writePrecondition = persist
    ? precondition || { target, ...await fingerprintFile(target, { signal }) }
    : null;
  let changed = false;
  const registeredPaths = new Set(index.conversations.map((record) => record.output?.path).filter(Boolean));
  const missing = index.conversations.filter((record) => {
    const absolute = record.output ? outputPath(paths, record.output.path) : "";
    return record.output && (!absolute || !record.output.path);
  });
  for (const record of index.conversations) {
    if (!record.output) continue;
    const absolute = outputPath(paths, record.output.path);
    if (absolute && !await pathExists(absolute) && !missing.includes(record)) missing.push(record);
  }
  const missingSizes = new Set(missing.map((record) => record.output.size_bytes));
  const renamedCandidates = new Map();
  if (missingSizes.size) {
    for (const entry of await readdir(paths.conversations, { withFileTypes: true })) {
      throwIfAborted(signal, "Claude output refresh");
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const relativePath = `Conversations/${entry.name}`;
      if (registeredPaths.has(relativePath)) continue;
      const absolute = path.join(paths.conversations, entry.name);
      const information = await stat(absolute);
      if (!missingSizes.has(information.size)) continue;
      const signature = `${information.size}:${await sha256File(absolute, { signal })}`;
      const group = renamedCandidates.get(signature) || [];
      group.push({ relativePath, information });
      renamedCandidates.set(signature, group);
    }
  }
  for (const record of index.conversations) {
    throwIfAborted(signal, "Claude output refresh");
    if (!record.output) continue;
    let absolute = outputPath(paths, record.output.path);
    if (!absolute || !await pathExists(absolute)) {
      const signature = `${record.output.size_bytes}:${record.output.sha256}`;
      const candidates = renamedCandidates.get(signature) || [];
      if (candidates.length === 1) {
        record.output = {
          ...record.output,
          path: candidates[0].relativePath,
          modified_at: candidates[0].information.mtime.toISOString()
        };
        delete record.stale;
        changed = true;
        absolute = path.join(paths.root, ...candidates[0].relativePath.split("/"));
      }
      else if (candidates.length > 1) {
        if (!record.stale) changed = true;
        record.stale = true;
        continue;
      }
      else {
        delete record.output;
        delete record.stale;
        changed = true;
        continue;
      }
    }
    const information = await stat(absolute);
    let bytes;
    try {
      bytes = signal ? await readFile(absolute, { signal }) : await readFile(absolute);
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
      if (!record.stale) changed = true;
      record.stale = true;
      continue;
    }
    let document;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      const damaged = withoutOutputWatermarks(record.output);
      if (JSON.stringify(damaged) !== JSON.stringify(record.output)) {
        record.output = damaged;
        changed = true;
      }
      if (!record.stale) changed = true;
      record.stale = true;
      continue;
    }
    const refreshed = withoutOutputWatermarks(record.output);
    const generation = document?.schema === "ai-chat-archive/conversation/1.0.0" ? document.generation : document;
    const exporterVersion = typeof generation?.exporter_version === "string" ? generation.exporter_version : "";
    if (Object.prototype.hasOwnProperty.call(document || {}, "schema")) {
      const schema = typeof document.schema === "string" ? document.schema : "";
      if (CONVERSATION_SCHEMA.test(schema)) refreshed.schema = schema;
      else refreshed.schema_invalid = true;
    }
    if (Object.prototype.hasOwnProperty.call(generation || {}, "parser_version")) {
      const parserVersion = typeof generation.parser_version === "string" ? generation.parser_version : "";
      if (isSemanticVersion(parserVersion)) refreshed.parser_version = parserVersion;
      else refreshed.parser_version_invalid = true;
    }
    if (Object.prototype.hasOwnProperty.call(generation || {}, "parser_adapter")) {
      const adapterId = cleanString(generation.parser_adapter?.id);
      const adapterVersion = cleanString(generation.parser_adapter?.version);
      if (ADAPTER_ID.test(adapterId) && isSemanticVersion(adapterVersion)) {
        refreshed.parser_adapter = { id: adapterId, version: adapterVersion };
      } else {
        refreshed.parser_version_invalid = true;
      }
    }
    if (exporterVersion.trim()) refreshed.exporter_version = exporterVersion;
    if (document?.schema === "ai-chat-archive/conversation/1.0.0"
      && UUID.test(cleanString(document.identity?.archive_id))
      && Number.isFinite(Date.parse(document.lifecycle?.last_parsed_at))) {
      refreshed.archive_id = document.identity.archive_id;
      refreshed.role = record.output.role || "current";
      refreshed.first_parsed_at = structuredClone(document.lifecycle.first_parsed_at);
      refreshed.last_parsed_at = new Date(document.lifecycle.last_parsed_at).toISOString();
    }
    if (JSON.stringify(refreshed) !== JSON.stringify(record.output)) {
      record.output = refreshed;
      changed = true;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if ((information.size !== record.output.size_bytes || digest !== record.output.sha256) && !record.stale) {
      record.stale = true;
      changed = true;
    }
  }
  throwIfAborted(signal, "Claude output refresh");
  if (changed && persist) await writeClaudeIndex(paths, index, { signal, precondition: writePrecondition });
  return index;
  } finally {
    if (!lock) await transactionLock.release();
  }
}
