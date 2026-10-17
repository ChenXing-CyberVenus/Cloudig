import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { recoverNextArchive } from "../../core/archive/ids.mts";
import {
  serializeLibrary,
  validateConversation,
  validateTimeValue
} from "../../core/contracts/index.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import {
  archiveUserValuesEqual,
  resolveArchiveView,
  sparseArchiveUserValues,
  type BuiltinIdentity,
  type ResolvedArchiveView
} from "../../core/library/overlay.mts";
import { normalizeRange } from "../../core/time/index.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { capturePreviousAuthority, readCurrentAuthorityPair } from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";
import { parseEditableConversationPath } from "./archive-commands.mts";

export type ArchiveUserPatch = Readonly<{
  conversationName?: Readonly<{ state: "inherit" }> | Readonly<{ state: "set"; value: string }>;
  models?: Readonly<{ state: "inherit" }> | Readonly<{ state: "set"; values: readonly string[] }>;
  names?: Readonly<{
    user: Readonly<{ state: "inherit" }> | Readonly<{ state: "set"; value: string }>;
    assistant: Readonly<{ state: "inherit" }> | Readonly<{ state: "set"; value: string }>;
  }>;
  contentTime?:
    | Readonly<{ state: "inherit" }>
    | Readonly<{ state: "cleared" }>
    | Readonly<{ state: "set"; range: JsonObject }>;
}>;

export type ArchiveUserContext = Readonly<{
  conversation: JsonObject;
  view: ResolvedArchiveView;
  libraryRevision: number;
  archiveRevision: number;
  userValues: JsonObject;
  filename: string;
  fingerprint: ByteFingerprint;
}>;

function exactFingerprint(left: ByteFingerprint, right: ByteFingerprint): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function archiveState(library: JsonObject, archive: string): JsonObject | undefined {
  const archives = isJsonObject(library["archives"]) ? library["archives"] : undefined;
  return archives && isJsonObject(archives[archive]) ? archives[archive] : undefined;
}

function portableState(conversation: JsonObject): JsonObject | undefined {
  return isJsonObject(conversation["user"]) ? conversation["user"] : undefined;
}

function requireConversationIdentity(
  conversation: JsonObject,
  expected: Readonly<{ archive: string; generation: number }>
): void {
  if (conversation["archive"] !== expected.archive || conversation["generation"] !== expected.generation) {
    throw new TypeError("Conversation identity changed");
  }
}

async function readConversation(
  libraryRoot: string,
  relativePath: string
): Promise<Readonly<{ conversation: JsonObject; fingerprint: ByteFingerprint; filename: string }>> {
  const managed = parseEditableConversationPath(relativePath);
  const absolute = await resolveManagedPath(libraryRoot, managed.relative, { mustExist: true });
  const before = await fingerprintFile(absolute);
  const raw: unknown = JSON.parse(await readFile(absolute, "utf8"));
  const validation = validateConversation(raw);
  if (!validation.ok) throw new TypeError(`Conversation is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  const after = await fingerprintFile(absolute);
  if (!exactFingerprint(before, after)) throw new TypeError("Conversation changed while it was being read");
  return { conversation: validation.value, fingerprint: after, filename: managed.filename };
}

export async function queryArchiveUserContext(input: Readonly<{
  libraryRoot: string;
  relativePath: string;
  expected: ByteFingerprint & Readonly<{ archive: string; generation: number }>;
  builtins: BuiltinIdentity;
  availableAssets: ReadonlySet<string>;
}>): Promise<ArchiveUserContext> {
  const observed = await readConversation(input.libraryRoot, input.relativePath);
  if (!exactFingerprint(observed.fingerprint, input.expected)) throw new TypeError("Conversation bytes changed");
  requireConversationIdentity(observed.conversation, input.expected);
  const authority = await readCurrentAuthorityPair(input.libraryRoot);
  const state = archiveState(authority.library, input.expected.archive);
  return {
    conversation: observed.conversation,
    view: resolveArchiveView(observed.conversation, authority.library, input.builtins, input.availableAssets),
    libraryRevision: authority.library["revision"] as number,
    archiveRevision: typeof state?.["revision"] === "number" ? state["revision"] : 0,
    userValues: sparseArchiveUserValues(state ?? portableState(observed.conversation)),
    filename: observed.filename,
    fingerprint: observed.fingerprint
  };
}

function normalizePatchRange(range: JsonObject): JsonObject {
  const normalized = normalizeRange(range);
  const validation = validateTimeValue(normalized);
  if (!validation.ok) throw new TypeError(`Content time is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  return validation.value;
}

function refreshedEndpoint(value: JsonValue, anchor: Readonly<{ date: string; offset: string }>): JsonValue {
  if (!isJsonObject(value)) return structuredClone(value);
  const next = structuredClone(value);
  if (next["kind"] === "now" || next["kind"] === "relative") next["anchor"] = { ...anchor };
  return next;
}

function refreshRangeAnchors(range: JsonObject, anchor: Readonly<{ date: string; offset: string }>): JsonObject {
  const next: JsonObject = { start: refreshedEndpoint(range["start"]!, anchor) };
  if (range["end"] !== undefined) next["end"] = refreshedEndpoint(range["end"]!, anchor);
  return normalizePatchRange(next);
}

export function archivePatchUsesAnchor(patch: ArchiveUserPatch): boolean {
  if (patch.contentTime?.state !== "set") return false;
  const endpoints = [patch.contentTime.range["start"], patch.contentTime.range["end"]];
  return endpoints.some((value) => isJsonObject(value) && (value["kind"] === "now" || value["kind"] === "relative"));
}

export function applyArchiveUserPatch(
  current: JsonObject | undefined,
  patch: ArchiveUserPatch,
  anchor?: Readonly<{ date: string; offset: string }>
): JsonObject {
  const next = sparseArchiveUserValues(current);
  if (patch.conversationName?.state === "inherit") delete next["conversation_name"];
  else if (patch.conversationName?.state === "set") next["conversation_name"] = patch.conversationName.value;
  if (patch.models?.state === "inherit") delete next["models"];
  else if (patch.models?.state === "set") next["models"] = [...patch.models.values];
  if (patch.names) {
    const names = isJsonObject(next["names"]) ? next["names"] : {};
    for (const party of ["user", "assistant"] as const) {
      const value = patch.names[party];
      if (value.state === "inherit") delete names[party];
      else names[party] = value.value;
    }
    if (Object.keys(names).length === 0) delete next["names"];
    else next["names"] = names;
  }
  if (patch.contentTime?.state === "inherit") delete next["content_time"];
  else if (patch.contentTime?.state === "cleared") next["content_time"] = { state: "cleared" };
  else if (patch.contentTime?.state === "set") {
    next["content_time"] = {
      state: "set",
      range: anchor ? refreshRangeAnchors(patch.contentTime.range, anchor) : normalizePatchRange(patch.contentTime.range)
    };
  }
  return next;
}

export type ArchiveUserCommitResult =
  | Readonly<{
    status: "updated";
    libraryRevision: number;
    archiveRevision: number;
    editedAt: string;
    userValues: JsonObject;
  }>
  | Readonly<{ status: "unchanged"; libraryRevision: number; archiveRevision: number; userValues: JsonObject }>
  | Readonly<{ status: "conflict"; reason: string }>;

export async function commitArchiveUserState(input: Readonly<{
  libraryRoot: string;
  relativePath: string;
  expected: ByteFingerprint & Readonly<{ archive: string; generation: number }>;
  expectedLibraryRevision: number;
  expectedArchiveRevision: number;
  patch: ArchiveUserPatch;
  touchOnNoop: boolean;
  anchor: Readonly<{ date: string; offset: string }>;
  transaction: string;
  recoveryTransaction: string;
  timestamp: string;
}>): Promise<ArchiveUserCommitResult> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Archive edit and recovery transactions require distinct tokens");
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const observed = await readConversation(input.libraryRoot, input.relativePath);
    if (!exactFingerprint(observed.fingerprint, input.expected)) return { status: "conflict", reason: "conversation_bytes_changed" };
    try {
      requireConversationIdentity(observed.conversation, input.expected);
    } catch {
      return { status: "conflict", reason: "conversation_identity_changed" };
    }
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    if (authority.library["revision"] !== input.expectedLibraryRevision) return { status: "conflict", reason: "library_revision_changed" };
    const currentLibraryState = archiveState(authority.library, input.expected.archive);
    const currentArchiveRevision = typeof currentLibraryState?.["revision"] === "number" ? currentLibraryState["revision"] : 0;
    if (currentArchiveRevision !== input.expectedArchiveRevision) return { status: "conflict", reason: "archive_revision_changed" };
    const currentValues = sparseArchiveUserValues(currentLibraryState ?? portableState(observed.conversation));
    const nextValues = applyArchiveUserPatch(currentValues, input.patch, input.anchor);
    const unchanged = archiveUserValuesEqual(currentValues, nextValues);
    if (unchanged && !input.touchOnNoop) {
      return {
        status: "unchanged",
        libraryRevision: input.expectedLibraryRevision,
        archiveRevision: currentArchiveRevision,
        userValues: currentValues
      };
    }

    const nextArchiveRevision = currentArchiveRevision + 1;
    const nextLibrary = structuredClone(authority.library);
    const archives = isJsonObject(nextLibrary["archives"]) ? nextLibrary["archives"] : {};
    archives[input.expected.archive] = {
      revision: nextArchiveRevision,
      edited_at: input.timestamp,
      ...nextValues
    };
    nextLibrary["archives"] = archives;
    nextLibrary["next_archive"] = Math.max(nextLibrary["next_archive"] as number, recoverNextArchive(Object.keys(archives)));
    nextLibrary["revision"] = input.expectedLibraryRevision + 1;
    nextLibrary["edited_at"] = input.timestamp;
    const libraryBytes = Buffer.from(serializeLibrary(nextLibrary), "utf8");
    const recovery = await capturePreviousAuthority(input.libraryRoot, {
      transaction: input.recoveryTransaction,
      recordedAt: input.timestamp,
      alreadyCapturedThisBatch: false
    });
    if (recovery === "conflict") return { status: "conflict", reason: "recovery_point_conflict" };
    const beforeCommit = await fingerprintFile(await resolveManagedPath(input.libraryRoot, parseEditableConversationPath(input.relativePath).relative, { mustExist: true }));
    if (!exactFingerprint(beforeCommit, input.expected)) return { status: "conflict", reason: "conversation_changed_before_commit" };
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "update-archive-user-state",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: input.expectedLibraryRevision, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets: [{
        action: "replace",
        path: "cloudig-library.json",
        status: "planned",
        expected_before: { state: "present", ...authority.libraryFingerprint },
        semantic: { kind: "library" }
      }]
    };
    const staged = await stageJournalTargets(input.libraryRoot, journal, new Map([[0, Readable.from([libraryBytes])]]));
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") return { status: "conflict", reason: "transaction_precondition_changed" };
    const installed = await readCurrentAuthorityPair(input.libraryRoot);
    const installedState = archiveState(installed.library, input.expected.archive);
    if (installed.library["revision"] !== input.expectedLibraryRevision + 1 || installedState?.["revision"] !== nextArchiveRevision) {
      throw new TypeError("Archive user-state update installed the wrong revision");
    }
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Archive user-state cleanup failed");
    return {
      status: "updated",
      libraryRevision: input.expectedLibraryRevision + 1,
      archiveRevision: nextArchiveRevision,
      editedAt: input.timestamp,
      userValues: nextValues
    };
  } finally {
    await writer.release();
  }
}
