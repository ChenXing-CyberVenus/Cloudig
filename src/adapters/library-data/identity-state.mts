import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import { recoverNextArchive } from "../../core/archive/ids.mts";
import { serializeLibrary, validateConversation } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };
import { archiveUserValuesEqual, sparseArchiveUserValues } from "../../core/library/overlay.mts";
import {
  cleanupJournal,
  installJournal,
  recoverJournal,
  removeCleanJournalFiles,
  stageJournalTargets
} from "../storage/journal.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { capturePreviousAuthority, readCurrentAuthorityPair } from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";
import { parseEditableConversationPath } from "./archive-commands.mts";
import { cleanupPreparedSourcePicker, prepareSourcePicker, type PreparedSourcePicker } from "./source-picker.mts";

export type AvatarIntent =
  | Readonly<{ state: "keep" }>
  | Readonly<{ state: "clear" }>
  | Readonly<{ state: "picker"; picker: string }>;

export type IdentityPartyDraft = Readonly<{
  name?: string;
  avatar: AvatarIntent;
}>;

export type IdentityDraft = Readonly<{
  global: Readonly<{
    user: IdentityPartyDraft;
    assistant: IdentityPartyDraft & Readonly<{ applyToAll: boolean }>;
  }>;
  platforms: Readonly<Record<string, IdentityPartyDraft>>;
}>;

export type IdentityCommitResult =
  | Readonly<{ status: "updated"; revision: number; archiveRevision?: number; identity?: JsonObject }>
  | Readonly<{ status: "unchanged"; revision: number; archiveRevision?: number; identity?: JsonObject }>
  | Readonly<{ status: "conflict" }>;

export type IdentityArchiveDraft = Readonly<{
  relativePath: string;
  expected: ByteFingerprint & Readonly<{ archive: string; generation: number }>;
  expectedArchiveRevision: number;
  names: Readonly<{ user?: string; assistant?: string }>;
}>;

export type PreparedIdentityAvatar = Readonly<{
  picker: PreparedSourcePicker;
  extension: "png" | "jpg" | "gif" | "webp";
  relativePath: string;
  existing?: ByteFingerprint;
}>;

function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function currentIdentity(library: JsonObject): JsonObject {
  return object(library["identity"]) ? structuredClone(library["identity"] as JsonObject) : {};
}

function currentAvatar(identity: JsonObject, scope: "user" | "assistant" | string): string | undefined {
  if (scope === "user" || scope === "assistant") {
    const global = object(identity["global"]);
    const party = object(global?.[scope]);
    return typeof party?.["avatar"] === "string" ? party["avatar"] : undefined;
  }
  const platforms = object(identity["platforms"]);
  const platform = object(platforms?.[scope]);
  const assistant = object(platform?.["assistant"]);
  return typeof assistant?.["avatar"] === "string" ? assistant["avatar"] : undefined;
}

async function avatarExtension(filePath: string): Promise<PreparedIdentityAvatar["extension"]> {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(16);
    const observed = await handle.read(bytes, 0, bytes.byteLength, 0);
    const head = bytes.subarray(0, observed.bytesRead);
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
    const signature = head.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "gif";
    if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
    throw new TypeError("Identity avatar must be a PNG, JPEG, GIF or WebP image");
  } finally {
    await handle.close();
  }
}

async function fingerprintIfExists(filePath: string): Promise<ByteFingerprint | undefined> {
  try {
    return await fingerprintFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function prepareIdentityAvatar(libraryRoot: string, token: string): Promise<PreparedIdentityAvatar> {
  const picker = await prepareSourcePicker(libraryRoot, token);
  if (picker.fingerprint.bytes < 1 || picker.fingerprint.bytes > resourceLimits.avatar_file_max_bytes) {
    throw new RangeError("Identity avatar exceeds the configured byte limit");
  }
  const extension = await avatarExtension(picker.payloadPath);
  const relativePath = `Data/Assets/User/avatar-${picker.fingerprint.sha256}.${extension}`;
  const absolute = await resolveManagedPath(libraryRoot, relativePath);
  const existing = await fingerprintIfExists(absolute);
  if (existing && (existing.bytes !== picker.fingerprint.bytes || existing.sha256 !== picker.fingerprint.sha256)) {
    throw new TypeError("Content-addressed identity avatar target is inconsistent");
  }
  return { picker, extension, relativePath, ...(existing ? { existing } : {}) };
}

function setName(target: JsonObject, value: string | undefined): void {
  if (value === undefined) delete target["name"];
  else target["name"] = value;
}

function avatarPath(intent: AvatarIntent, existing: string | undefined, prepared: ReadonlyMap<string, PreparedIdentityAvatar>): string | undefined {
  if (intent.state === "keep") return existing;
  if (intent.state === "clear") return undefined;
  const value = prepared.get(intent.picker);
  if (!value) throw new TypeError("Identity avatar picker is unavailable");
  return value.relativePath;
}

function setAvatar(target: JsonObject, value: string | undefined): void {
  if (value === undefined) delete target["avatar"];
  else target["avatar"] = value;
}

function compactParty(value: JsonObject): JsonObject | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}

function buildIdentity(current: JsonObject, draft: IdentityDraft, prepared: ReadonlyMap<string, PreparedIdentityAvatar>): JsonObject | undefined {
  const global: JsonObject = {};
  const user: JsonObject = {};
  setName(user, draft.global.user.name);
  setAvatar(user, avatarPath(draft.global.user.avatar, currentAvatar(current, "user"), prepared));
  const compactUser = compactParty(user);
  if (compactUser) global["user"] = compactUser;

  const assistant: JsonObject = {};
  setName(assistant, draft.global.assistant.name);
  setAvatar(assistant, avatarPath(draft.global.assistant.avatar, currentAvatar(current, "assistant"), prepared));
  if (draft.global.assistant.applyToAll) assistant["apply_to_all"] = true;
  const compactAssistant = compactParty(assistant);
  if (compactAssistant) global["assistant"] = compactAssistant;

  const platforms: JsonObject = {};
  for (const [platform, partyDraft] of Object.entries(draft.platforms).sort(([left], [right]) => left.localeCompare(right))) {
    const party: JsonObject = {};
    setName(party, partyDraft.name);
    setAvatar(party, avatarPath(partyDraft.avatar, currentAvatar(current, platform), prepared));
    const compact = compactParty(party);
    if (compact) platforms[platform] = { assistant: compact };
  }

  const result: JsonObject = {};
  if (Object.keys(global).length > 0) result["global"] = global;
  if (Object.keys(platforms).length > 0) result["platforms"] = platforms;
  return Object.keys(result).length === 0 ? undefined : result;
}

function pickerTokens(draft: IdentityDraft): string[] {
  const values = [draft.global.user.avatar, draft.global.assistant.avatar, ...Object.values(draft.platforms).map((entry) => entry.avatar)]
    .filter((entry): entry is Readonly<{ state: "picker"; picker: string }> => entry.state === "picker")
    .map((entry) => entry.picker);
  if (new Set(values).size !== values.length) throw new TypeError("Each identity avatar picker can be consumed only once");
  return values;
}

async function readArchiveForIdentity(libraryRoot: string, draft: IdentityArchiveDraft): Promise<JsonObject | undefined> {
  const managed = parseEditableConversationPath(draft.relativePath);
  const absolute = await resolveManagedPath(libraryRoot, managed.relative, { mustExist: true });
  const before = await fingerprintFile(absolute);
  if (before.bytes !== draft.expected.bytes || before.sha256 !== draft.expected.sha256) return undefined;
  const raw: unknown = JSON.parse(await readFile(absolute, "utf8"));
  const validation = validateConversation(raw);
  if (!validation.ok || validation.value["archive"] !== draft.expected.archive || validation.value["generation"] !== draft.expected.generation) return undefined;
  const after = await fingerprintFile(absolute);
  return after.bytes === before.bytes && after.sha256 === before.sha256 ? validation.value : undefined;
}

function archiveState(library: JsonObject, archive: string): JsonObject | undefined {
  return object(object(library["archives"])?.[archive]);
}

function nextArchiveUserState(
  conversation: JsonObject,
  current: JsonObject | undefined,
  names: IdentityArchiveDraft["names"]
): JsonObject {
  const values = sparseArchiveUserValues(current ?? object(conversation["user"]));
  const currentNames = object(values["names"]) ?? {};
  if (names.user === undefined) delete currentNames["user"];
  else currentNames["user"] = names.user;
  if (names.assistant === undefined) delete currentNames["assistant"];
  else currentNames["assistant"] = names.assistant;
  if (Object.keys(currentNames).length === 0) delete values["names"];
  else values["names"] = currentNames;
  return values;
}

async function abandonStagedJournal(libraryRoot: string, transaction: string): Promise<void> {
  try {
    const recovered = await recoverJournal(libraryRoot, transaction);
    const cleaned = await cleanupJournal(libraryRoot, recovered);
    if (cleaned["state"] === "cleaned") await removeCleanJournalFiles(libraryRoot, transaction);
  } catch {
    // Durable recovery remains available to normal startup reconciliation.
  }
}

export async function readIdentityState(libraryRoot: string): Promise<Readonly<{ revision: number; language: "zh-CN" | "en"; identity?: JsonObject }>> {
  const authority = await readCurrentAuthorityPair(libraryRoot);
  const identity = object(authority.library["identity"]);
  const preferences = object(authority.library["preferences"]);
  return {
    revision: authority.library["revision"] as number,
    language: preferences?.["language"] === "en" ? "en" : "zh-CN",
    ...(identity ? { identity: structuredClone(identity) } : {})
  };
}

export async function commitIdentityState(input: Readonly<{
  libraryRoot: string;
  expectedRevision: number;
  draft: IdentityDraft;
  transaction: string;
  recoveryTransaction: string;
  timestamp: string;
  archive?: IdentityArchiveDraft;
}>): Promise<IdentityCommitResult> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Identity and recovery transactions require distinct tokens");
  const tokens = pickerTokens(input.draft);
  const writer = await acquireSingleWriter(input.libraryRoot);
  const streams: import("node:fs").ReadStream[] = [];
  try {
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    if (authority.library["revision"] !== input.expectedRevision) return { status: "conflict" };
    const archiveConversation = input.archive ? await readArchiveForIdentity(input.libraryRoot, input.archive) : undefined;
    if (input.archive && !archiveConversation) return { status: "conflict" };
    const currentArchiveState = input.archive ? archiveState(authority.library, input.archive.expected.archive) : undefined;
    const currentArchiveRevision = typeof currentArchiveState?.["revision"] === "number" ? currentArchiveState["revision"] : 0;
    if (input.archive && currentArchiveRevision !== input.archive.expectedArchiveRevision) return { status: "conflict" };
    const prepared = new Map<string, PreparedIdentityAvatar>();
    for (const token of tokens) prepared.set(token, await prepareIdentityAvatar(input.libraryRoot, token));
    const before = currentIdentity(authority.library);
    const identity = buildIdentity(before, input.draft, prepared);
    const nextArchiveValues = input.archive && archiveConversation
      ? nextArchiveUserState(archiveConversation, currentArchiveState, input.archive.names)
      : undefined;
    const archiveChanged = input.archive && archiveConversation
      ? !archiveUserValuesEqual(sparseArchiveUserValues(currentArchiveState ?? object(archiveConversation["user"])), nextArchiveValues)
      : false;
    if (canonicalizeJcs(identity ?? {}) === canonicalizeJcs(before) && !archiveChanged) {
      await Promise.all([...prepared.values()].map((entry) => cleanupPreparedSourcePicker(input.libraryRoot, entry.picker).catch(() => false)));
      return {
        status: "unchanged",
        revision: input.expectedRevision,
        ...(input.archive ? { archiveRevision: currentArchiveRevision } : {}),
        ...(identity ? { identity } : {})
      };
    }

    const next = structuredClone(authority.library);
    if (identity) next["identity"] = identity;
    else delete next["identity"];
    let nextArchiveRevision: number | undefined;
    if (input.archive && nextArchiveValues && archiveChanged) {
      nextArchiveRevision = currentArchiveRevision + 1;
      const archives = object(next["archives"]) ?? {};
      archives[input.archive.expected.archive] = {
        revision: nextArchiveRevision,
        edited_at: input.timestamp,
        ...nextArchiveValues
      };
      next["archives"] = archives;
      next["next_archive"] = Math.max(next["next_archive"] as number, recoverNextArchive(Object.keys(archives)));
    }
    next["revision"] = input.expectedRevision + 1;
    next["edited_at"] = input.timestamp;
    const libraryBytes = Buffer.from(serializeLibrary(next), "utf8");
    const recovery = await capturePreviousAuthority(input.libraryRoot, {
      transaction: input.recoveryTransaction,
      recordedAt: input.timestamp,
      alreadyCapturedThisBatch: false
    });
    if (recovery === "conflict") return { status: "conflict" };
    if (input.archive && !(await readArchiveForIdentity(input.libraryRoot, input.archive))) return { status: "conflict" };

    const targets: JsonObject[] = [];
    const sources = new Map<number, Readable>();
    for (const avatar of prepared.values()) {
      if (avatar.existing) continue;
      const index = targets.length;
      targets.push({
        action: "create",
        path: avatar.relativePath,
        status: "planned",
        expected_before: { state: "missing" },
        semantic: { kind: "user_asset" }
      });
      const stream = createReadStream(avatar.picker.payloadPath);
      streams.push(stream);
      sources.set(index, stream);
    }
    const libraryIndex = targets.length;
    targets.push({
      action: "replace",
      path: "cloudig-library.json",
      status: "planned",
      expected_before: { state: "present", ...authority.libraryFingerprint },
      semantic: { kind: "library" }
    });
    sources.set(libraryIndex, Readable.from([libraryBytes]));
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "update-identity",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: input.expectedRevision, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets
    };
    const staged = await stageJournalTargets(input.libraryRoot, journal, sources);
    for (const [index, avatar] of [...prepared.values()].filter((entry) => !entry.existing).entries()) {
      const observed = (staged["targets"] as JsonObject[])[index]?.["staged_after"];
      if (!isJsonObject(observed) || observed["bytes"] !== avatar.picker.fingerprint.bytes || observed["sha256"] !== avatar.picker.fingerprint.sha256) {
        await abandonStagedJournal(input.libraryRoot, input.transaction);
        throw new TypeError("Identity avatar changed while it was being staged");
      }
    }
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") return { status: "conflict" };
    const installed = await readCurrentAuthorityPair(input.libraryRoot);
    if (installed.library["revision"] !== input.expectedRevision + 1) throw new TypeError("Identity update installed the wrong revision");
    if (input.archive && nextArchiveRevision !== undefined && archiveState(installed.library, input.archive.expected.archive)?.["revision"] !== nextArchiveRevision) {
      throw new TypeError("Conversation identity update installed the wrong archive revision");
    }
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Identity update cleanup failed");
    await Promise.all([...prepared.values()].map((entry) => cleanupPreparedSourcePicker(input.libraryRoot, entry.picker).catch(() => false)));
    return {
      status: "updated",
      revision: input.expectedRevision + 1,
      ...(input.archive ? { archiveRevision: nextArchiveRevision ?? currentArchiveRevision } : {}),
      ...(identity ? { identity } : {})
    };
  } finally {
    for (const stream of streams) if (!stream.closed) stream.destroy();
    await writer.release();
  }
}
