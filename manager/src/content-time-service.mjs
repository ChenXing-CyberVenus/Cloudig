import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { libraryPaths } from "../../library/src/init.mjs";
import { serializeLibraryV1 } from "../../library/v1.mjs";
import { serializeV1 } from "../../schema/canonical-v1.mjs";
import {
  assertLibraryDomainV1,
  commitContainment,
  commitCounterpart,
  commitLibraryPreferences,
  commitNodeDeletion,
  commitTerranMapping,
  commitTerranPreset,
  commitSovereignDisplayOrder,
  commitTimeNode,
  createOperationPlan,
  materializeConversationEffectiveSnapshot,
  planNodeDeletion,
  planReferenceRemoval,
  planTimelineMutation,
  planConversationMetadataCommit,
  previewContentTimeRange
} from "../../library/domain-v1.mjs";
import { validateConversationV1 } from "../../schema/validate-v1.mjs";
import {
  acquireFileTransactionLock,
  atomicWriteText,
  beginFileSnapshotTransaction,
  fingerprintFile
} from "../../parser/src/atomic.mjs";
import { createLibraryBackup } from "./user-state-history.mjs";
import { scanConversationMetadata } from "./conversation-catalog.mjs";

const require = createRequire(import.meta.url);
const terranPreset = require("../../time/presets/terran-cloudig-1.0.0.json");

export const RECENT_OPERATIONS_FORMAT = "cloudig/recent-operations";
export const RECENT_OPERATIONS_VERSION = "1.0.0";
export const RECENT_OPERATIONS_MAX = 128;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_LIBRARY_BYTES = 16 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 256 * 1024 * 1024;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, stableValue(value[key])]));
}

function stableText(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function domainError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requiredSha(value, code, message) {
  const result = String(value || "").toLowerCase();
  if (!SHA256.test(result)) throw domainError(code, message);
  return result;
}

function requiredUuid(value, code, message) {
  const result = String(value || "").toLowerCase();
  if (!UUID.test(result)) throw domainError(code, message);
  return result;
}

function dateFromClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Cloudig content-time clock returned an invalid date");
  return value;
}

export function localAnchor(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Cloudig content-time anchor date is invalid");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const magnitude = Math.abs(offset);
  const offsetText = magnitude === 0 ? "Z" : `${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
  return {
    date: `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    captured_at: date.toISOString(),
    utc_offset: offsetText
  };
}

function safeConversationPath(paths, value) {
  const relative = String(value || "").trim().replaceAll("\\", "/");
  const segments = relative.split("/");
  if (segments[0] !== "Conversations" || segments.length < 2 || segments[1] === ".Cloudig-Archive"
    || !segments.at(-1).toLowerCase().endsWith(".json")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/u.test(segment))) {
    throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation metadata can update only an active JSON file inside Conversations");
  }
  const absolute = path.resolve(paths.root, ...segments);
  const inside = path.relative(path.resolve(paths.conversations), absolute);
  if (!inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation metadata target escaped Conversations");
  }
  return { relative, absolute };
}

async function readRegularText(target, maximum, label) {
  const information = await lstat(target);
  if (!information.isFile() || information.isSymbolicLink() || information.size < 1 || information.size > maximum) {
    throw domainError("CLOUDIG_CONVERSATION_CHANGED", `${label} is not a supported regular JSON file`);
  }
  const text = await readFile(target, "utf8");
  if (Buffer.byteLength(text) !== information.size) throw domainError("CLOUDIG_CONVERSATION_CHANGED", `${label} changed while it was being read`);
  return { text, information, sha256: digest(text) };
}

async function readLibraryState(paths) {
  const state = await readRegularText(paths.library, MAX_LIBRARY_BYTES, "cloudig-library.json");
  let document;
  try { document = assertLibraryDomainV1(JSON.parse(state.text)); }
  catch (cause) { throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json is not a valid Library 1.0 document", { cause: String(cause?.message || cause) }); }
  return { ...state, document };
}

async function readConversationState(paths, relativePath) {
  const target = safeConversationPath(paths, relativePath);
  const [realConversations, realTarget] = await Promise.all([realpath(paths.conversations), realpath(target.absolute)]);
  const inside = path.relative(realConversations, realTarget);
  if (!inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation metadata target resolved outside Conversations");
  }
  const state = await readRegularText(realTarget, MAX_CONVERSATION_BYTES, "Conversation JSON");
  let document;
  try { document = JSON.parse(state.text); }
  catch { throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation JSON is syntactically invalid"); }
  const validation = validateConversationV1(document);
  if (!validation.valid) throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation JSON is not a valid Conversation 1.0 document", { errors: validation.errors });
  return { ...state, document, relative_path: target.relative, absolute: realTarget };
}

function emptyRecentOperations() {
  return { format: RECENT_OPERATIONS_FORMAT, version: RECENT_OPERATIONS_VERSION, operations: [] };
}

function normalizeRecentOperations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== RECENT_OPERATIONS_FORMAT || value.version !== RECENT_OPERATIONS_VERSION
    || !Array.isArray(value.operations)) throw new TypeError("Cloudig recent-operation journal is invalid");
  const requestIds = new Set();
  const operations = value.operations.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Cloudig recent operation must be an object");
    const request_id = requiredUuid(entry.request_id, "CLOUDIG_TIME_REQUEST_REUSED", "Recent operation request_id is invalid");
    if (requestIds.has(request_id)) throw new TypeError("Cloudig recent-operation journal contains duplicate request IDs");
    requestIds.add(request_id);
    const payload_sha256 = requiredSha(entry.payload_sha256, "CLOUDIG_TIME_REQUEST_REUSED", "Recent operation payload digest is invalid");
    const plan_id = requiredSha(entry.plan_id, "CLOUDIG_TIME_PLAN_STALE", "Recent operation plan ID is invalid");
    const committed_at = new Date(entry.committed_at).toISOString();
    return { request_id, payload_sha256, plan_id, committed_at, result: clone(entry.result || {}) };
  }).slice(-RECENT_OPERATIONS_MAX);
  return { format: RECENT_OPERATIONS_FORMAT, version: RECENT_OPERATIONS_VERSION, operations };
}

async function readRecentOperations(paths) {
  try {
    const text = await readFile(paths.recentOperations, "utf8");
    return { document: normalizeRecentOperations(JSON.parse(text)), text, fingerprint: await fingerprintFile(paths.recentOperations) };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { document: emptyRecentOperations(), text: "", fingerprint: Object.freeze({ exists: false }) };
  }
}

function requestDigest(operation, payload) {
  const intent = clone(payload || {});
  delete intent.root;
  return digest(stableText({ operation, payload: intent }));
}

function replayOrReject(recent, requestId, payloadSha256) {
  const existing = recent.operations.find((entry) => entry.request_id === requestId);
  if (!existing) return null;
  if (existing.payload_sha256 !== payloadSha256) throw domainError("CLOUDIG_TIME_REQUEST_REUSED", "request_id was already used for different content-time intent");
  return { ...clone(existing.result), status: "replayed", request_id: requestId, plan_id: existing.plan_id };
}

function appendRecentOperation(recent, entry) {
  return normalizeRecentOperations({
    format: RECENT_OPERATIONS_FORMAT,
    version: RECENT_OPERATIONS_VERSION,
    operations: [...recent.operations, entry].slice(-RECENT_OPERATIONS_MAX)
  });
}

function transactionState(target, text) {
  return { target, exists: true, sizeBytes: Buffer.byteLength(text), sha256: digest(text) };
}

function preconditionState(target, fingerprint) {
  if (!fingerprint.exists) return { target, exists: false };
  if (fingerprint.regularFile !== true || fingerprint.stable === false) throw domainError("CLOUDIG_TRANSACTION_RECOVERY_CONFLICT", `Transaction precondition is not a stable file: ${path.basename(target)}`);
  return { target, exists: true, sizeBytes: fingerprint.sizeBytes, sha256: fingerprint.sha256 };
}

async function commitTextTargets(paths, targets, preconditions, expected, {
  lock,
  write_text = atomicWriteText,
  begin_transaction = beginFileSnapshotTransaction
}) {
  const transaction = await begin_transaction(paths.root, targets.map((entry) => entry.target), {
    preconditionTargets: preconditions,
    expectedTargets: expected,
    lock
  });
  try {
    await transaction.beginMutation();
    for (const entry of targets) {
      const before = preconditions.find((item) => item.target === entry.target);
      await transaction.assertBefore(entry.target);
      await write_text(entry.target, entry.text, {
        precondition: before.exists
          ? { exists: true, sizeBytes: before.sizeBytes, sha256: before.sha256 }
          : { exists: false }
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export function previewTimeRange(payload, { clock = () => new Date() } = {}) {
  const current = dateFromClock(clock);
  return previewContentTimeRange({
    range: payload?.range,
    anchor: payload?.anchor || localAnchor(current),
    locale: payload?.locale || "zh-CN",
    context: payload?.context || {}
  });
}

export async function getTimeSystem(rootPath) {
  const paths = libraryPaths(rootPath);
  const library = await readLibraryState(paths);
  return Object.freeze({
    ok: true,
    library_sha256: library.sha256,
    limits_version: "1.0.0",
    preset_version: library.document.content_time_system.terran.preset_version,
    document_revision: library.document.content_time_system.revision,
    terran_preset: clone(terranPreset),
    content_time_system: clone(library.document.content_time_system)
  });
}

async function readLibraryForPlan(rootPath, expectedLibrarySha256) {
  const paths = libraryPaths(rootPath);
  const library = await readLibraryState(paths);
  const expected = requiredSha(expectedLibrarySha256, "CLOUDIG_LIBRARY_CHANGED", "Time-system plan requires expected_library_sha256");
  if (library.sha256 !== expected) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed after this editor opened");
  return library;
}

export async function planTimeNodeDeletion(rootPath, payload) {
  const library = await readLibraryForPlan(rootPath, payload?.expected_library_sha256);
  return Object.freeze({
    ok: true,
    expected_library_sha256: library.sha256,
    ...planNodeDeletion(library.document, payload.command || {})
  });
}

export async function planTimeReferenceRemoval(rootPath, payload) {
  const library = await readLibraryForPlan(rootPath, payload?.expected_library_sha256);
  const paths = libraryPaths(rootPath);
  const base = planReferenceRemoval(library.document, payload.command || {});
  const conversations = await locateConversations(paths, [...new Set(base.bindings.map((binding) => binding.conversation_key))]);
  const affected = [...conversations.values()].map((state) => ({
    conversation_key: state.document.identity.conversation_key,
    archive_id: state.document.identity.archive_id,
    title: state.document.title,
    relative_path: state.relative_path,
    bytes: Buffer.byteLength(state.text),
    expected_sha256: state.sha256
  })).sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.conversation_key.localeCompare(right.conversation_key, "en"));
  const plan = createOperationPlan({
    operation: base.operation,
    expected_library_sha256: library.sha256,
    source_time_system_revision: base.source_time_system_revision,
    bindings: base.bindings,
    affected_conversations: affected
  });
  return Object.freeze({
    ok: true,
    expected_library_sha256: library.sha256,
    ...plan,
    target_files: affected.length + 2,
    target_bytes: affected.reduce((sum, item) => sum + item.bytes, 0) + Buffer.byteLength(library.text)
  });
}

async function buildTimelineServicePlan(paths, library, payload, instant) {
  const requestId = requiredUuid(payload?.request_id, "CLOUDIG_TIME_REQUEST_REUSED", "Timeline plan requires request_id");
  const domainPlan = planTimelineMutation(library.document, payload.command || {}, {
    now: instant.toISOString(),
    anchor: localAnchor(instant),
    request_id: requestId
  });
  const conversations = await locateConversations(paths, domainPlan.affected_conversation_keys);
  const affected = [...conversations.values()].map((state) => ({
    conversation_key: state.document.identity.conversation_key,
    archive_id: state.document.identity.archive_id,
    title: state.document.title,
    relative_path: state.relative_path,
    bytes: Buffer.byteLength(state.text),
    expected_sha256: state.sha256
  })).sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.conversation_key.localeCompare(right.conversation_key, "en"));
  const facts = Object.fromEntries(Object.entries(domainPlan).filter(([key]) => key !== "library" && key !== "plan_id"));
  const plan = createOperationPlan({
    ...facts,
    expected_library_sha256: library.sha256,
    request_id: requestId,
    affected_conversations: affected
  });
  return { plan, domainPlan, conversations };
}

export async function planTimeTimelineMutation(rootPath, payload, { clock = () => new Date() } = {}) {
  const paths = libraryPaths(rootPath);
  const library = await readLibraryForPlan(rootPath, payload?.expected_library_sha256);
  const instant = dateFromClock(clock);
  const current = await buildTimelineServicePlan(paths, library, payload, instant);
  return Object.freeze({
    ok: true,
    ...current.plan,
    target_files: current.plan.affected_conversations.length + 2,
    target_bytes: current.plan.affected_conversations.reduce((sum, item) => sum + item.bytes, 0) + Buffer.byteLength(library.text)
  });
}

async function locateConversations(paths, conversationKeys) {
  const wanted = new Set(conversationKeys);
  let catalog;
  try { catalog = JSON.parse(await readFile(paths.conversationCatalog, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw domainError("CLOUDIG_TIME_PLAN_STALE", "Conversation catalog is missing; refresh the Archiver before planning a batch time edit");
    throw error;
  }
  if (catalog?.format !== "cloudig/conversation-catalog" || catalog?.version !== "1.0.0" || !Array.isArray(catalog.entries)) {
    throw domainError("CLOUDIG_TIME_PLAN_STALE", "Conversation catalog is invalid; refresh the Archiver before planning a batch time edit");
  }
  const currentMetadata = await scanConversationMetadata(paths);
  if (currentMetadata.source_revision !== catalog.source_revision) {
    throw domainError("CLOUDIG_TIME_PLAN_STALE", "Conversation catalog is stale; refresh the Archiver before planning a batch time edit");
  }
  const byKey = new Map();
  for (const entry of catalog.entries) {
    if (!wanted.has(entry.conversation_key) || entry.artifact_role !== "current" || entry.compatibility !== "supported") continue;
    if (!byKey.has(entry.conversation_key)) byKey.set(entry.conversation_key, []);
    byKey.get(entry.conversation_key).push(entry);
  }
  const result = new Map();
  for (const key of wanted) {
    const entries = byKey.get(key) || [];
    if (entries.length !== 1) throw domainError("CLOUDIG_TIME_PLAN_STALE", `Expected exactly one current conversation for ${key}`, { candidates: entries.map((entry) => entry.relative_path) });
    const state = await readConversationState(paths, entries[0].relative_path);
    if (state.sha256 !== entries[0].sha256 || state.document.identity.conversation_key !== key) {
      throw domainError("CLOUDIG_CONVERSATION_CHANGED", `Conversation changed after the catalog was built: ${entries[0].relative_path}`);
    }
    result.set(key, state);
  }
  return result;
}

function removeBindingsFromRange(range, removed) {
  const endpoints = [range?.start, range?.end].filter(Boolean)
    .filter((endpoint) => endpoint.kind !== "sovereign" || !removed.has(endpoint.binding_id));
  if (!endpoints.length) return null;
  return { start: endpoints[0], ...(endpoints[1] ? { end: endpoints[1] } : {}) };
}

function currentReferenceRemovalPlan(libraryState, command, conversations) {
  const base = planReferenceRemoval(libraryState.document, command);
  const affected = [...conversations.values()].map((state) => ({
    conversation_key: state.document.identity.conversation_key,
    archive_id: state.document.identity.archive_id,
    title: state.document.title,
    relative_path: state.relative_path,
    bytes: Buffer.byteLength(state.text),
    expected_sha256: state.sha256
  })).sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.conversation_key.localeCompare(right.conversation_key, "en"));
  return createOperationPlan({
    operation: base.operation,
    expected_library_sha256: libraryState.sha256,
    source_time_system_revision: base.source_time_system_revision,
    bindings: base.bindings,
    affected_conversations: affected
  });
}

export async function commitTimeReferenceRemoval(rootPath, payload, {
  clock = () => new Date(),
  id_factory = randomUUID,
  write_text = atomicWriteText,
  begin_transaction = beginFileSnapshotTransaction
} = {}) {
  const paths = libraryPaths(rootPath);
  const requestId = requiredUuid(payload?.request_id, "CLOUDIG_TIME_REQUEST_REUSED", "Reference removal commit requires request_id");
  const payloadSha256 = requestDigest("time.reference.remove.commit", payload);
  const lock = await acquireFileTransactionLock(paths.root);
  try {
    const recent = await readRecentOperations(paths);
    const replay = replayOrReject(recent.document, requestId, payloadSha256);
    if (replay) return Object.freeze(replay);
    const library = await readLibraryState(paths);
    const expectedLibrary = requiredSha(payload.expected_library_sha256, "CLOUDIG_LIBRARY_CHANGED", "Reference removal commit requires expected_library_sha256");
    if (library.sha256 !== expectedLibrary) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed after the removal plan opened");
    const base = planReferenceRemoval(library.document, payload.command || {});
    const conversations = await locateConversations(paths, [...new Set(base.bindings.map((binding) => binding.conversation_key))]);
    const currentPlan = currentReferenceRemovalPlan(library, payload.command || {}, conversations);
    const confirmedPlanId = requiredSha(payload.plan_id, "CLOUDIG_TIME_PLAN_STALE", "Reference removal commit requires plan_id");
    if (currentPlan.plan_id !== confirmedPlanId) throw domainError("CLOUDIG_TIME_PLAN_STALE", "Reference-removal plan changed before commit", { expected: confirmedPlanId, current: currentPlan.plan_id });
    const instant = dateFromClock(clock);
    const removed = new Set(base.bindings.map((binding) => binding.binding_id));
    let nextLibrary = library.document;
    const conversationPlans = [];
    for (const [conversationKey, state] of conversations) {
      const override = nextLibrary.conversation_overrides?.[conversationKey]?.content_time;
      if (!override || override.state !== "set") throw domainError("CLOUDIG_TIME_SNAPSHOT_CONFLICT", `Library binding has no matching user-set content time: ${conversationKey}`);
      const nextRange = removeBindingsFromRange(override.range, removed);
      const planned = planConversationMetadataCommit({
        library: nextLibrary,
        conversation: state.document,
        content_time: nextRange ? { action: "set", range: nextRange } : { action: "clear" },
        anchor_action: "preserve",
        now: instant.toISOString(),
        anchor: localAnchor(instant),
        request_id: requestId,
        id_factory
      });
      if (planned.status !== "planned") throw domainError("CLOUDIG_TIME_SNAPSHOT_CONFLICT", `Reference removal produced no conversation change: ${conversationKey}`);
      nextLibrary = planned.library;
      conversationPlans.push({ state, plan: planned });
    }
    nextLibrary = clone(nextLibrary);
    for (const bindingId of removed) delete nextLibrary.content_time_system.sovereign.conversation_bindings[bindingId];
    nextLibrary.content_time_system.revision = library.document.content_time_system.revision + 1;
    nextLibrary.edited_at = instant.toISOString();
    nextLibrary = assertLibraryDomainV1(nextLibrary);
    const libraryText = serializeLibraryV1(nextLibrary);
    const librarySha256 = digest(libraryText);
    const result = {
      ok: true,
      status: "committed",
      request_id: requestId,
      plan_id: currentPlan.plan_id,
      removed_binding_ids: [...removed].sort(),
      affected_conversations: conversationPlans.map(({ plan, state }) => ({
        conversation_key: plan.conversation_key,
        archive_id: plan.archive_id,
        relative_path: state.relative_path,
        sha256: plan.conversation_sha256
      })),
      library_sha256: librarySha256
    };
    const nextRecent = appendRecentOperation(recent.document, {
      request_id: requestId,
      payload_sha256: payloadSha256,
      plan_id: currentPlan.plan_id,
      committed_at: instant.toISOString(),
      result
    });
    const targets = [
      { target: paths.library, text: libraryText },
      ...conversationPlans.map(({ state, plan }) => ({ target: state.absolute, text: plan.conversation_text })),
      { target: paths.recentOperations, text: stableText(nextRecent) }
    ];
    const libraryFingerprint = await fingerprintFile(paths.library);
    if (libraryFingerprint.sha256 !== library.sha256) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed before transaction snapshot");
    const preconditions = [preconditionState(paths.library, libraryFingerprint)];
    for (const { state } of conversationPlans) {
      const fingerprint = await fingerprintFile(state.absolute);
      if (fingerprint.sha256 !== state.sha256) throw domainError("CLOUDIG_CONVERSATION_CHANGED", `Conversation changed before transaction snapshot: ${state.relative_path}`);
      preconditions.push(preconditionState(state.absolute, fingerprint));
    }
    preconditions.push(preconditionState(paths.recentOperations, recent.fingerprint));
    await createLibraryBackup(paths, library.text, { clock: () => instant });
    await commitTextTargets(paths, targets, preconditions, targets.map((entry) => transactionState(entry.target, entry.text)), {
      lock,
      write_text,
      begin_transaction
    });
    return Object.freeze(result);
  } finally {
    await lock.release();
  }
}

export async function commitTimeTimelineMutation(rootPath, payload, {
  clock = () => new Date(),
  write_text = atomicWriteText,
  begin_transaction = beginFileSnapshotTransaction
} = {}) {
  const paths = libraryPaths(rootPath);
  const requestId = requiredUuid(payload?.request_id, "CLOUDIG_TIME_REQUEST_REUSED", "Timeline commit requires request_id");
  const payloadSha256 = requestDigest("time.timeline.commit", payload);
  const lock = await acquireFileTransactionLock(paths.root);
  try {
    const recent = await readRecentOperations(paths);
    const replay = replayOrReject(recent.document, requestId, payloadSha256);
    if (replay) return Object.freeze(replay);
    const library = await readLibraryState(paths);
    const expectedLibrary = requiredSha(payload.expected_library_sha256, "CLOUDIG_LIBRARY_CHANGED", "Timeline commit requires expected_library_sha256");
    if (library.sha256 !== expectedLibrary) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed after the timeline plan opened");
    const instant = dateFromClock(clock);
    const current = await buildTimelineServicePlan(paths, library, payload, instant);
    const confirmedPlanId = requiredSha(payload.plan_id, "CLOUDIG_TIME_PLAN_STALE", "Timeline commit requires plan_id");
    if (current.plan.plan_id !== confirmedPlanId) throw domainError("CLOUDIG_TIME_PLAN_STALE", "Timeline sync plan changed before commit", { expected: confirmedPlanId, current: current.plan.plan_id });
    const nextLibrary = current.domainPlan.library;
    const libraryText = serializeLibraryV1(nextLibrary);
    const librarySha256 = digest(libraryText);
    const conversationTargets = [];
    for (const state of current.conversations.values()) {
      const document = materializeConversationEffectiveSnapshot(nextLibrary, state.document, instant.toISOString());
      const text = serializeV1(document);
      conversationTargets.push({ state, text, sha256: digest(text) });
    }
    const result = {
      ok: true,
      status: "committed",
      request_id: requestId,
      plan_id: current.plan.plan_id,
      variant_action: current.plan.variant_action,
      source_timeline_id: current.plan.source_timeline_id,
      target_timeline_id: current.plan.target_timeline_id,
      affected_conversations: conversationTargets.map(({ state, sha256 }) => ({
        conversation_key: state.document.identity.conversation_key,
        archive_id: state.document.identity.archive_id,
        relative_path: state.relative_path,
        sha256
      })),
      library_sha256: librarySha256
    };
    const nextRecent = appendRecentOperation(recent.document, {
      request_id: requestId,
      payload_sha256: payloadSha256,
      plan_id: current.plan.plan_id,
      committed_at: instant.toISOString(),
      result
    });
    const targets = [
      { target: paths.library, text: libraryText },
      ...conversationTargets.map(({ state, text }) => ({ target: state.absolute, text })),
      { target: paths.recentOperations, text: stableText(nextRecent) }
    ];
    const libraryFingerprint = await fingerprintFile(paths.library);
    if (libraryFingerprint.sha256 !== library.sha256) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed before timeline transaction snapshot");
    const preconditions = [preconditionState(paths.library, libraryFingerprint)];
    for (const { state } of conversationTargets) {
      const fingerprint = await fingerprintFile(state.absolute);
      if (fingerprint.sha256 !== state.sha256) throw domainError("CLOUDIG_CONVERSATION_CHANGED", `Conversation changed before timeline transaction snapshot: ${state.relative_path}`);
      preconditions.push(preconditionState(state.absolute, fingerprint));
    }
    preconditions.push(preconditionState(paths.recentOperations, recent.fingerprint));
    await createLibraryBackup(paths, library.text, { clock: () => instant });
    await commitTextTargets(paths, targets, preconditions, targets.map((entry) => transactionState(entry.target, entry.text)), {
      lock,
      write_text,
      begin_transaction
    });
    return Object.freeze(result);
  } finally {
    await lock.release();
  }
}

export async function commitConversationMetadata(rootPath, payload, {
  clock = () => new Date(),
  id_factory = randomUUID,
  write_text = atomicWriteText,
  begin_transaction = beginFileSnapshotTransaction
} = {}) {
  const paths = libraryPaths(rootPath);
  const requestId = requiredUuid(payload?.request_id, "CLOUDIG_TIME_REQUEST_REUSED", "Conversation metadata commit requires request_id");
  const payloadSha256 = requestDigest("conversation.metadata.commit", payload);
  const lock = await acquireFileTransactionLock(paths.root);
  try {
    const recent = await readRecentOperations(paths);
    const replay = replayOrReject(recent.document, requestId, payloadSha256);
    if (replay) return Object.freeze(replay);
    const [library, conversation] = await Promise.all([
      readLibraryState(paths),
      readConversationState(paths, payload.relative_path)
    ]);
    const expectedLibrary = requiredSha(payload.expected_library_sha256, "CLOUDIG_LIBRARY_CHANGED", "Conversation metadata commit requires the Library SHA-256 it opened");
    const expectedConversation = requiredSha(payload.expected_sha256, "CLOUDIG_CONVERSATION_CHANGED", "Conversation metadata commit requires the conversation SHA-256 it opened");
    if (library.sha256 !== expectedLibrary) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed after this editor opened");
    if (conversation.sha256 !== expectedConversation) throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation JSON changed after this editor opened");
    if (conversation.document.identity.conversation_key !== String(payload.conversation_key || "")) throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation key does not match the selected archive");
    if (conversation.document.identity.archive_id !== requiredUuid(payload.archive_id, "CLOUDIG_CONVERSATION_CHANGED", "Conversation archive_id is invalid")) throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation archive_id does not match the selected archive");

    const instant = dateFromClock(clock);
    const plan = planConversationMetadataCommit({
      library: library.document,
      conversation: conversation.document,
      patch: payload.patch || {},
      content_time: payload.content_time || { action: "preserve" },
      anchor_action: payload.anchor_action || "preserve",
      now: instant.toISOString(),
      anchor: localAnchor(instant),
      touch: payload.touch === true,
      request_id: requestId,
      id_factory
    });
    if (plan.status === "unchanged") return Object.freeze({
      ok: true,
      status: "unchanged",
      request_id: requestId,
      library_sha256: library.sha256,
      conversation_sha256: conversation.sha256,
      warnings: plan.warnings
    });

    const planFacts = createOperationPlan({
      operation: "conversation_metadata_commit",
      request_id: requestId,
      relative_path: conversation.relative_path,
      archive_id: plan.archive_id,
      before: { library_sha256: library.sha256, conversation_sha256: conversation.sha256 },
      after: { library_sha256: plan.library_sha256, conversation_sha256: plan.conversation_sha256 }
    });
    const result = {
      ok: true,
      status: "committed",
      request_id: requestId,
      plan_id: planFacts.plan_id,
      relative_path: conversation.relative_path,
      conversation_key: plan.conversation_key,
      archive_id: plan.archive_id,
      library_sha256: plan.library_sha256,
      conversation_sha256: plan.conversation_sha256,
      warnings: plan.warnings
    };
    const nextRecent = appendRecentOperation(recent.document, {
      request_id: requestId,
      payload_sha256: payloadSha256,
      plan_id: planFacts.plan_id,
      committed_at: instant.toISOString(),
      result
    });
    const recentText = stableText(nextRecent);
    const recentFingerprint = recent.fingerprint;
    const libraryFingerprint = await fingerprintFile(paths.library);
    const conversationFingerprint = await fingerprintFile(conversation.absolute);
    if (libraryFingerprint.sha256 !== library.sha256) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed before transaction snapshot");
    if (conversationFingerprint.sha256 !== conversation.sha256) throw domainError("CLOUDIG_CONVERSATION_CHANGED", "Conversation JSON changed before transaction snapshot");
    await createLibraryBackup(paths, library.text, { clock: () => instant });
    const targets = [
      { target: paths.library, text: plan.library_text },
      { target: conversation.absolute, text: plan.conversation_text },
      { target: paths.recentOperations, text: recentText }
    ];
    const preconditions = [
      preconditionState(paths.library, libraryFingerprint),
      preconditionState(conversation.absolute, conversationFingerprint),
      preconditionState(paths.recentOperations, recentFingerprint)
    ];
    const expected = targets.map((entry) => transactionState(entry.target, entry.text));
    await commitTextTargets(paths, targets, preconditions, expected, { lock, write_text, begin_transaction });
    return Object.freeze(result);
  } finally {
    await lock.release();
  }
}

async function commitLibraryOnly(rootPath, operation, payload, mutate, {
  clock = () => new Date(),
  id_factory = randomUUID,
  write_text = atomicWriteText,
  begin_transaction = beginFileSnapshotTransaction
} = {}) {
  const paths = libraryPaths(rootPath);
  const requestId = requiredUuid(payload?.request_id, "CLOUDIG_TIME_REQUEST_REUSED", `${operation} requires request_id`);
  const payloadSha256 = requestDigest(operation, payload);
  const lock = await acquireFileTransactionLock(paths.root);
  try {
    const recent = await readRecentOperations(paths);
    const replay = replayOrReject(recent.document, requestId, payloadSha256);
    if (replay) return Object.freeze(replay);
    const library = await readLibraryState(paths);
    const expectedLibrary = requiredSha(payload.expected_library_sha256, "CLOUDIG_LIBRARY_CHANGED", `${operation} requires expected_library_sha256`);
    if (library.sha256 !== expectedLibrary) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed after this editor opened");
    const instant = dateFromClock(clock);
    const mutation = mutate(library.document, payload, { now: instant.toISOString(), anchor: localAnchor(instant), id_factory });
    const libraryText = serializeLibraryV1(mutation.library);
    const librarySha256 = digest(libraryText);
    if (librarySha256 === library.sha256) return Object.freeze({ ok: true, status: "unchanged", request_id: requestId, library_sha256: library.sha256 });
    const plan = createOperationPlan({ operation, request_id: requestId, before: library.sha256, after: librarySha256, identity: mutation });
    const result = { ok: true, status: "committed", request_id: requestId, plan_id: plan.plan_id, library_sha256: librarySha256, ...Object.fromEntries(Object.entries(mutation).filter(([key]) => key !== "library" && key !== "status")) };
    const nextRecent = appendRecentOperation(recent.document, { request_id: requestId, payload_sha256: payloadSha256, plan_id: plan.plan_id, committed_at: instant.toISOString(), result });
    const recentText = stableText(nextRecent);
    const libraryFingerprint = await fingerprintFile(paths.library);
    if (libraryFingerprint.sha256 !== library.sha256) throw domainError("CLOUDIG_LIBRARY_CHANGED", "cloudig-library.json changed before transaction snapshot");
    await createLibraryBackup(paths, library.text, { clock: () => instant });
    const targets = [{ target: paths.library, text: libraryText }, { target: paths.recentOperations, text: recentText }];
    const preconditions = [preconditionState(paths.library, libraryFingerprint), preconditionState(paths.recentOperations, recent.fingerprint)];
    await commitTextTargets(paths, targets, preconditions, targets.map((entry) => transactionState(entry.target, entry.text)), { lock, write_text, begin_transaction });
    return Object.freeze(result);
  } finally {
    await lock.release();
  }
}

export const commitTimeNodeCommand = (root, payload, options) => commitLibraryOnly(root, "time.node.commit", payload, (library, value, context) => commitTimeNode(library, value.command, context), options);
export const commitLibraryPreferencesCommand = (root, payload, options) => commitLibraryOnly(root, "library.preferences.commit", payload, (library, value, context) => commitLibraryPreferences(library, value.patch || {}, context), options);
export const commitContainmentCommand = (root, payload, options) => commitLibraryOnly(root, "time.containment.commit", payload, (library, value, context) => commitContainment(library, value.command, context), options);
export const commitCounterpartCommand = (root, payload, options) => commitLibraryOnly(root, "time.counterpart.commit", payload, (library, value, context) => commitCounterpart(library, value.command, context), options);
export const commitTerranMappingCommand = (root, payload, options) => commitLibraryOnly(root, "time.terran-mapping.commit", payload, (library, value, context) => commitTerranMapping(library, value.command, context), options);
export const commitTerranPresetCommand = (root, payload, options) => commitLibraryOnly(root, "time.terran-preset.commit", payload, (library, value, context) => commitTerranPreset(library, value.command, context), options);
export const commitSovereignDisplayOrderCommand = (root, payload, options) => commitLibraryOnly(root, "time.display-order.commit", payload, (library, value, context) => commitSovereignDisplayOrder(library, value.command, context), options);
export const commitTimeNodeDeletionCommand = (root, payload, options) => commitLibraryOnly(root, "time.node.delete.commit", payload, (library, value, context) => commitNodeDeletion(library, value.command, context), options);
