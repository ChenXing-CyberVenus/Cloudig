import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, utimes } from "node:fs/promises";
import path from "node:path";

import { effectiveContentTimeFromLibrary } from "../../library/domain-v1.mjs";
import { normalizeLibraryV1, serializeLibraryV1 } from "../../library/v1.mjs";
import { validateConversationV1 } from "../../schema/validate-v1.mjs";
import {
  assertFileFingerprint,
  atomicWriteText,
  beginFileSnapshotTransaction,
  fingerprintFile,
  pathExists
} from "./atomic.mjs";
import { createConversationEnvelopeV1, PARSER_V1_VERSION } from "./envelope-v1.mjs";
import {
  normalizeParseStateV1,
  normalizeParseStateV1Source,
  serializeParseStateV1,
  setParseStateV1Source
} from "./parse-state-v1.mjs";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, stable(value[key])]));
}

function digest(value) {
  const input = typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value));
  return createHash("sha256").update(input).digest("hex");
}

function utc(value, label) {
  const milliseconds = Date.parse(String(value || ""));
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function safeStem(fileName) {
  const extension = path.extname(fileName);
  const raw = path.basename(fileName, extension)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim();
  return Array.from(raw || "conversation").slice(0, 120).join("");
}

function absoluteConversation(paths, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments[0] !== "Conversations" || segments.length < 2 || !segments.at(-1).toLowerCase().endsWith(".json")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`Unsafe conversation output path: ${relativePath}`);
  }
  const absolute = path.resolve(paths.root, ...segments);
  const inside = path.relative(path.resolve(paths.conversations), absolute);
  if (!inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    throw new TypeError(`Conversation output escapes its directory: ${relativePath}`);
  }
  return absolute;
}

function transactionState(target, text) {
  return { target, exists: true, sizeBytes: Buffer.byteLength(text), sha256: digest(text) };
}

function preconditionState(target, fingerprint) {
  if (!fingerprint.exists) return { target, exists: false };
  if (fingerprint.regularFile !== true || fingerprint.stable === false) throw new Error(`CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT: ${path.basename(target)} is not a stable regular file`);
  return { target, exists: true, sizeBytes: fingerprint.sizeBytes, sha256: fingerprint.sha256 };
}

function sourceByPath(state, sourcePath) {
  return state.sources.find((source) => source.path === sourcePath) || null;
}

function outputOwnership(state) {
  const result = new Map();
  for (const source of state.sources) for (const output of source.outputs || []) result.set(output.path, source.path);
  return result;
}

function currentOutputByConversation(state) {
  const result = new Map();
  for (const source of state.sources) {
    for (const output of source.outputs || []) {
      if (output.role !== "current") continue;
      if (result.has(output.conversation_key)) throw new Error(`CLOUDIG_ARCHIVE_ROLE_CONFLICT: multiple current artifacts for ${output.conversation_key}`);
      result.set(output.conversation_key, { source, output });
    }
  }
  return result;
}

async function readRegisteredConversation(paths, output, { signal = null, allowMissing = false } = {}) {
  const target = absoluteConversation(paths, output.path);
  const fingerprint = await fingerprintFile(target, { signal });
  if (!fingerprint.exists && allowMissing) return { target, fingerprint, document: null, missing: true };
  if (!fingerprint.exists || fingerprint.regularFile !== true || fingerprint.stable === false
    || fingerprint.sizeBytes !== output.size_bytes || fingerprint.sha256 !== output.sha256) {
    const error = new Error(`Registered conversation changed outside Cloudig: ${output.path}`);
    error.code = "CLOUDIG_CONVERSATION_CHANGED";
    throw error;
  }
  let document;
  try {
    document = JSON.parse(signal ? await readFile(target, { encoding: "utf8", signal }) : await readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read registered V1 conversation: ${output.path}`, { cause: error });
  }
  const validation = validateConversationV1(document);
  if (!validation.valid || document.identity.conversation_key !== output.conversation_key || document.identity.archive_id !== output.archive_id) {
    const error = new Error(`Registered V1 conversation identity or schema is invalid: ${output.path}`);
    error.code = "CLOUDIG_CONVERSATION_CHANGED";
    throw error;
  }
  return { target, fingerprint, document };
}

async function chooseNewOutputPath(paths, {
  inputName,
  conversationKey,
  archiveId,
  multiple,
  preferredDirectory = "Conversations",
  ownership,
  sourcePath,
  reserved,
  signal = null
}) {
  const stem = safeStem(inputName);
  const initial = multiple
    ? `${stem}--${conversationKey.slice(0, 16)}.json`
    : `${stem}.json`;
  const candidates = [
    initial,
    `${stem}--${conversationKey.slice(0, 16)}--${archiveId.slice(0, 8)}.json`
  ];
  for (let counter = 2; counter <= 10000; counter += 1) {
    candidates.push(`${stem}--${conversationKey.slice(0, 16)}--${archiveId.slice(0, 8)}--${counter}.json`);
  }
  for (const fileName of candidates) {
    if (signal?.aborted) throw Object.assign(new Error("V1 output selection was cancelled"), { name: "AbortError", code: "ABORT_ERR" });
    const relativePath = `${preferredDirectory}/${fileName}`.replaceAll("\\", "/");
    if (reserved.has(relativePath)) continue;
    const owner = ownership.get(relativePath);
    if (owner) continue;
    const target = absoluteConversation(paths, relativePath);
    if (await pathExists(target)) continue;
    reserved.add(relativePath);
    return relativePath;
  }
  throw new Error(`Unable to choose a non-overwriting V1 conversation path for ${inputName}`);
}

function outputRecord(conversation, relativePath, text, modifiedAt) {
  return {
    conversation_key: conversation.identity.conversation_key,
    archive_id: conversation.identity.archive_id,
    role: "current",
    path: relativePath,
    size_bytes: Buffer.byteLength(text),
    modified_at: modifiedAt,
    sha256: digest(text),
    schema: conversation.schema,
    parser_version: conversation.generation.parser_version,
    parser_adapter: clone(conversation.generation.parser_adapter),
    ...(conversation.generation.exporter_version ? { exporter_version: conversation.generation.exporter_version } : {}),
    first_parsed_at: clone(conversation.lifecycle.first_parsed_at),
    last_parsed_at: conversation.lifecycle.last_parsed_at
  };
}

function compareRegisteredOutput(left, right) {
  return left.path.localeCompare(right.path, "en");
}

export async function prepareV1ParseTransaction({
  paths,
  source,
  legacyConversations,
  parsedAt,
  preservePrevious = false,
  retainUnselectedCurrent = false,
  additionalTargetBuilder = null,
  transactionLock = null,
  archiveIdFactory = randomUUID,
  signal = null,
  dependencies = {}
} = {}) {
  if (!paths?.root || !paths?.library || !paths?.parseState || !paths?.conversations) throw new TypeError("Cloudig library paths are required");
  if (!Array.isArray(legacyConversations) || !legacyConversations.length) throw new TypeError("At least one parsed legacy conversation is required");
  const now = utc(parsedAt, "parsedAt");
  const read_file = dependencies.read_file || readFile;
  const [libraryBytes, stateBytes] = await Promise.all([
    read_file(paths.library),
    read_file(paths.parseState)
  ]);
  const library = normalizeLibraryV1(JSON.parse(Buffer.from(libraryBytes).toString("utf8")));
  const parseState = normalizeParseStateV1(JSON.parse(Buffer.from(stateBytes).toString("utf8")));
  const normalizedSource = normalizeParseStateV1Source({ ...source, outputs: source.outputs || [] });
  const existingSource = sourceByPath(parseState, normalizedSource.path);
  const previousOutputs = existingSource?.outputs || [];
  const currentByConversation = currentOutputByConversation(parseState);
  const ownership = outputOwnership(parseState);
  const reserved = new Set();
  const multiple = legacyConversations.length > 1;
  const candidates = [];
  const guardFiles = new Map();
  const missingRegisteredArchiveIds = new Set();

  for (const legacy of legacyConversations) {
    if (legacy.source_file !== path.basename(normalizedSource.path)
      || legacy.source_sha256 !== normalizedSource.sha256
      || legacy.source_size_bytes !== normalizedSource.size_bytes) {
      throw new Error("Adapter conversation source facts do not match the registered Inbox source");
    }
    const key = String(legacy.conversation_key || "").toLowerCase();
    const registered = currentByConversation.get(key) || null;
    if (registered && registered.source.path !== normalizedSource.path) {
      const error = new Error(`Another source already owns the current artifact for ${key}`);
      error.code = "CLOUDIG_ARCHIVE_ROLE_CONFLICT";
      throw error;
    }
    const registeredArtifact = registered
      ? await readRegisteredConversation(paths, registered.output, { signal, allowMissing: true })
      : null;
    const previous = registeredArtifact?.missing ? null : registeredArtifact;
    const missingRegistered = registeredArtifact?.missing ? registeredArtifact : null;
    if (missingRegistered) missingRegisteredArchiveIds.add(registered.output.archive_id);
    if (previous) guardFiles.set(previous.target, previous.fingerprint);
    const override = library.conversation_overrides?.[key] || null;
    const libraryEffective = effectiveContentTimeFromLibrary(library, key, now);
    if (previous?.document.content_time.effective?.source === "user" && libraryEffective.source !== "user") {
      const error = new Error("Conversation has a user content-time snapshot but Library authority is missing");
      error.code = "CLOUDIG_TIME_SNAPSHOT_CONFLICT";
      throw error;
    }
    const archiveId = previous && !preservePrevious
      ? previous.document.identity.archive_id
      : missingRegistered ? registered.output.archive_id : archiveIdFactory();
    const envelope = createConversationEnvelopeV1(legacy, {
      parserVersion: PARSER_V1_VERSION,
      parsedAt: now,
      sourceCapture: normalizedSource.captured_at,
      archiveId,
      previousConversation: previous && !preservePrevious ? previous.document : null,
      firstParsedAt: missingRegistered
        ? registered.output.first_parsed_at
        : previous && preservePrevious ? null : undefined,
      libraryContentTime: libraryEffective.source === "user" ? libraryEffective : null,
      libraryOverride: override
    });
    let relativePath;
    if ((previous && !preservePrevious) || missingRegistered) {
      relativePath = registered.output.path;
      reserved.add(relativePath);
    } else {
      const previousDirectory = previous ? path.posix.dirname(registered.output.path) : "Conversations";
      relativePath = await chooseNewOutputPath(paths, {
        inputName: path.basename(normalizedSource.path),
        conversationKey: key,
        archiveId: envelope.conversation.identity.archive_id,
        multiple,
        preferredDirectory: previousDirectory,
        ownership,
        sourcePath: normalizedSource.path,
        reserved,
        signal
      });
    }
    candidates.push({
      key,
      previous: previous ? { ...previous, output: registered.output } : null,
      missingPreviousOutput: missingRegistered ? clone(registered.output) : null,
      conversation: envelope.conversation,
      text: envelope.serialized,
      projection: envelope.projection,
      relativePath,
      target: absoluteConversation(paths, relativePath)
    });
  }

  const emittedKeys = new Set(candidates.map((candidate) => candidate.key));
  const retainedOutputs = [];
  for (const output of previousOutputs) {
    const isReplacedCurrent = output.role === "current" && emittedKeys.has(output.conversation_key);
    if (isReplacedCurrent && missingRegisteredArchiveIds.has(output.archive_id)) continue;
    if (isReplacedCurrent && !preservePrevious) continue;
    const role = output.role === "current" && !emittedKeys.has(output.conversation_key) && retainUnselectedCurrent
      ? "current"
      : output.role === "current" ? "historical" : output.role;
    retainedOutputs.push({ ...output, role });
    const verified = candidates.find((candidate) => candidate.previous?.output.archive_id === output.archive_id)?.previous
      || await readRegisteredConversation(paths, output, { signal });
    guardFiles.set(verified.target, verified.fingerprint);
  }

  const nextOutputs = [
    ...retainedOutputs,
    ...candidates.map((candidate) => outputRecord(candidate.conversation, candidate.relativePath, candidate.text, now))
  ].sort(compareRegisteredOutput);
  const nextSource = normalizeParseStateV1Source({
    ...normalizedSource,
    parser_version: PARSER_V1_VERSION,
    status: "success",
    last_attempt_at: now,
    last_success_at: now,
    outputs: nextOutputs,
    error: undefined,
    dismissed: undefined
  });
  const nextState = setParseStateV1Source(parseState, nextSource);
  const nextLibrary = normalizeLibraryV1({ ...library, edited_at: now });
  const stateText = serializeParseStateV1(nextState);
  const libraryText = serializeLibraryV1(nextLibrary);

  const additionalTargets = typeof additionalTargetBuilder === "function"
    ? await additionalTargetBuilder({
        source: clone(nextSource),
        outputs: clone(nextOutputs),
        conversations: candidates.map((candidate) => clone(candidate.conversation)),
        library: clone(nextLibrary),
        parse_state: clone(nextState)
      })
    : [];
  if (!Array.isArray(additionalTargets)) throw new TypeError("additionalTargetBuilder must return an array");
  const targetTexts = [
    ...candidates.map((candidate) => ({ target: candidate.target, text: candidate.text, setModifiedAt: now })),
    { target: paths.library, text: libraryText },
    { target: paths.parseState, text: stateText },
    ...additionalTargets.map((entry) => ({ target: path.resolve(entry.target), text: String(entry.text) }))
  ];
  if (new Set(targetTexts.map((entry) => entry.target.toLowerCase())).size !== targetTexts.length) throw new TypeError("V1 parse transaction contains duplicate targets");
  const preconditions = [];
  const expected = [];
  for (const entry of targetTexts) {
    const fingerprint = await fingerprintFile(entry.target, { signal });
    if (entry.target.endsWith(`${path.sep}cloudig-library.json`) && fingerprint.sha256 !== digest(libraryBytes)) {
      throw new Error("CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT: Library changed during V1 parse planning");
    }
    if (entry.target === paths.parseState && fingerprint.sha256 !== digest(stateBytes)) {
      throw new Error("CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT: parse-state changed during V1 parse planning");
    }
    const candidateForTarget = candidates.find((candidate) => candidate.target === entry.target);
    const registeredTarget = candidateForTarget?.previous?.target === entry.target ? candidateForTarget.previous : null;
    if (registeredTarget && fingerprint.sha256 !== registeredTarget.fingerprint.sha256) {
      throw new Error(`CLOUDIG_CONVERSATION_CHANGED: ${path.basename(entry.target)}`);
    }
    if (!registeredTarget && candidates.some((candidate) => candidate.target === entry.target) && fingerprint.exists) {
      throw new Error(`CLOUDIG_OUTPUT_COLLISION: ${path.basename(entry.target)}`);
    }
    preconditions.push(preconditionState(entry.target, fingerprint));
    expected.push(transactionState(entry.target, entry.text));
  }
  for (const entry of targetTexts) guardFiles.delete(entry.target);
  const guards = [...guardFiles.entries()].map(([target, fingerprint]) => ({ target, fingerprint }));
  const planId = digest({
    source: nextSource,
    preserve_previous: preservePrevious,
    retain_unselected_current: retainUnselectedCurrent,
    targets: expected.map((entry) => ({ target: path.relative(paths.root, entry.target).replaceAll("\\", "/"), size_bytes: entry.sizeBytes, sha256: entry.sha256 })),
    guards: guards.map((entry) => ({ target: path.relative(paths.root, entry.target).replaceAll("\\", "/"), sha256: entry.fingerprint.sha256 })),
    library_before: digest(libraryBytes),
    parse_state_before: digest(stateBytes)
  });
  let closed = false;

  async function assertGuards() {
    for (const guard of guards) {
      await assertFileFingerprint(guard.target, guard.fingerprint, {
        signal,
        operation: "Retained V1 archive guard"
      });
    }
  }

  async function commit({ expectedPlanId = planId } = {}) {
    if (closed) throw new Error("V1 parse transaction is already closed");
    if (expectedPlanId !== planId) throw Object.assign(new Error("V1 parse plan changed"), { code: "CLOUDIG_TIME_PLAN_STALE" });
    const begin_transaction = dependencies.begin_transaction || beginFileSnapshotTransaction;
    const write_text = dependencies.write_text || atomicWriteText;
    const set_times = dependencies.set_times || utimes;
    const transaction = await begin_transaction(paths.root, targetTexts.map((entry) => entry.target), {
      preconditionTargets: preconditions,
      expectedTargets: expected,
      signal,
      lock: transactionLock
    });
    try {
      await transaction.beginMutation({ signal });
      await assertGuards();
      for (const entry of targetTexts) {
        const before = preconditions.find((item) => item.target === entry.target);
        await transaction.assertBefore(entry.target, { signal });
        await write_text(entry.target, entry.text, {
          signal,
          precondition: before.exists
            ? { exists: true, sizeBytes: before.sizeBytes, sha256: before.sha256 }
            : { exists: false }
        });
        if (entry.setModifiedAt) {
          const value = new Date(entry.setModifiedAt);
          await set_times(entry.target, value, value);
        }
      }
      await assertGuards();
      await transaction.commit({ signal });
      closed = true;
      return Object.freeze({
        ok: true,
        plan_id: planId,
        source: clone(nextSource),
        outputs: clone(nextOutputs),
        write_status: preservePrevious && retainedOutputs.some((output) => output.role === "historical") ? "preserved_previous" : "committed"
      });
    } catch (error) {
      await transaction.rollback();
      closed = true;
      throw error;
    }
  }

  return Object.freeze({
    plan: Object.freeze({
      plan_id: planId,
      source_path: nextSource.path,
      preserve_previous: preservePrevious,
      conversations: Object.freeze(candidates.map((candidate) => Object.freeze({
        conversation_key: candidate.key,
        archive_id: candidate.conversation.identity.archive_id,
        path: candidate.relativePath,
        projection_sha256: candidate.projection.v1_sha256,
        previous_archive_id: candidate.previous?.output.archive_id || candidate.missingPreviousOutput?.archive_id || ""
      }))),
      outputs: Object.freeze(clone(nextOutputs))
    }),
    commit
  });
}
