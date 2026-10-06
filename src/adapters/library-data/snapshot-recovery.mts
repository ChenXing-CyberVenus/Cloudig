import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { createInitialAuthority } from "../../app/library/defaults.mts";
import { recoverNextArchive } from "../../core/archive/ids.mts";
import { serializeLibrary, validateLibrary } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { sparseArchiveUserValues } from "../../core/library/overlay.mts";
import { openCanonicalConversationFile } from "../reader/conversation-file.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { RootStringFieldRewriter } from "../storage/json-root-rewrite.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { readCurrentAuthorityPair, readPreviousAuthorityPair } from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";

type RecoveredConversation = Readonly<{
  path: string;
  absolute: string;
  archive: string;
  generation: number;
  fingerprint: ByteFingerprint;
  user?: JsonObject;
}>;

type Reassignment = Readonly<{
  conversation: RecoveredConversation;
  archive: string;
  rewriter: RootStringFieldRewriter;
}>;

export type SnapshotRecoveryResult = Readonly<{
  status: "restored_from_conversations";
  revision: number;
  archives: number;
  reassigned: number;
  isolated: number;
}>;

async function hasUsableCurrentOrPrevious(root: string): Promise<boolean> {
  try { await readCurrentAuthorityPair(root); return true; } catch { /* continue */ }
  try { await readPreviousAuthorityPair(root); return true; } catch { return false; }
}

async function conversationPaths(root: string): Promise<string[]> {
  const base = await resolveManagedPath(root, "Conversations", { mustExist: true });
  const result: string[] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const observed = await lstat(directory);
    if (!observed.isDirectory() || observed.isSymbolicLink()) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) result.push(`Conversations/${childRelative}`);
    }
  }
  await visit(base, "");
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

async function scanConversations(root: string): Promise<Readonly<{ values: RecoveredConversation[]; isolated: number }>> {
  const values: RecoveredConversation[] = [];
  let isolated = 0;
  for (const relative of await conversationPaths(root)) {
    let opened;
    try {
      const absolute = await resolveManagedPath(root, relative, { mustExist: true });
      opened = await openCanonicalConversationFile({ filePath: absolute });
      const conversation = opened.index.conversation;
      const archive = conversation["archive"];
      const generation = conversation["generation"];
      if (typeof archive !== "string" || !/^a[1-9][0-9]*$/u.test(archive) || typeof generation !== "number" || !Number.isSafeInteger(generation)) {
        throw new TypeError("Conversation identity is invalid");
      }
      values.push({
        path: relative,
        absolute,
        archive,
        generation,
        fingerprint: opened.index.fingerprint,
        ...(isJsonObject(conversation["user"]) ? { user: structuredClone(conversation["user"] as JsonObject) } : {})
      });
    } catch {
      isolated += 1;
    } finally {
      await opened?.close().catch(() => undefined);
    }
  }
  return { values, isolated };
}

function expected(observed: ByteFingerprint | undefined): JsonObject {
  return observed ? { state: "present", ...observed } : { state: "missing" };
}

async function fingerprintIfExists(filePath: string): Promise<ByteFingerprint | undefined> {
  try { return await fingerprintFile(filePath); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function nextEditedAt(restoredAt: string, conversations: readonly RecoveredConversation[]): string {
  return conversations.reduce((latest, conversation) => {
    const edited = conversation.user?.["edited_at"];
    return typeof edited === "string" && edited > latest ? edited : latest;
  }, restoredAt);
}

export async function restoreAuthorityFromConversationSnapshots(input: Readonly<{
  libraryRoot: string;
  transaction: string;
  restoredAt: string;
  localDate: string;
  offset: string;
}>): Promise<SnapshotRecoveryResult> {
  const writer = await acquireSingleWriter(input.libraryRoot);
  const streams: import("node:fs").ReadStream[] = [];
  try {
    if (await hasUsableCurrentOrPrevious(input.libraryRoot)) throw new TypeError("Conversation snapshot recovery is only available when both authority pairs are unusable");
    const scanned = await scanConversations(input.libraryRoot);
    if (scanned.values.length === 0) throw new TypeError("No valid Conversation snapshots are available for Library recovery");

    const used = new Set<string>();
    const assignments = new Map<string, string>();
    let watermark = recoverNextArchive(scanned.values.map((entry) => entry.archive));
    for (const conversation of scanned.values) {
      if (!used.has(conversation.archive)) {
        used.add(conversation.archive);
        assignments.set(conversation.path, conversation.archive);
        continue;
      }
      while (used.has(`a${watermark}`)) watermark += 1;
      const archive = `a${watermark++}`;
      used.add(archive);
      assignments.set(conversation.path, archive);
    }

    const initial = createInitialAuthority({
      timestamp: input.restoredAt,
      localDate: input.localDate,
      offset: input.offset,
      language: "zh-CN"
    });
    const library = structuredClone(initial.library);
    const archives: JsonObject = {};
    let highestRevision = 1;
    for (const conversation of scanned.values) {
      const archive = assignments.get(conversation.path)!;
      if (!conversation.user) continue;
      const revision = conversation.user["revision"];
      if (typeof revision === "number" && Number.isSafeInteger(revision)) highestRevision = Math.max(highestRevision, revision);
      archives[archive] = structuredClone(conversation.user);
    }
    if (Object.keys(archives).length > 0) library["archives"] = archives;
    library["next_archive"] = recoverNextArchive(used);
    library["revision"] = highestRevision + 1;
    library["edited_at"] = nextEditedAt(input.restoredAt, scanned.values);
    const validation = validateLibrary(library);
    if (!validation.ok) throw new TypeError(`Recovered Library is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
    const libraryBytes = Buffer.from(serializeLibrary(library), "utf8");

    const currentLibraryPath = await resolveManagedPath(input.libraryRoot, "cloudig-library.json");
    const currentTimePath = await resolveManagedPath(input.libraryRoot, "Data/State/content-time.json");
    const currentLibrary = await fingerprintIfExists(currentLibraryPath);
    const currentTime = await fingerprintIfExists(currentTimePath);
    const reassignments: Reassignment[] = scanned.values
      .filter((conversation) => assignments.get(conversation.path) !== conversation.archive)
      .map((conversation) => ({
        conversation,
        archive: assignments.get(conversation.path)!,
        rewriter: new RootStringFieldRewriter("archive", conversation.archive, assignments.get(conversation.path)!)
      }));
    const targets: JsonObject[] = [];
    const payloads = new Map<number, Readable>();
    for (const value of reassignments) {
      const index = targets.length;
      targets.push({
        action: "replace",
        path: value.conversation.path,
        status: "planned",
        expected_before: { state: "present", ...value.conversation.fingerprint },
        semantic: { kind: "conversation", archive: value.archive, generation: value.conversation.generation, schema: "cloudig/conversation/1.0.0" }
      });
      const stream = createReadStream(value.conversation.absolute);
      streams.push(stream);
      payloads.set(index, stream.pipe(value.rewriter));
    }
    const libraryIndex = targets.length;
    targets.push({
      action: currentLibrary ? "replace" : "create",
      path: "cloudig-library.json",
      status: "planned",
      expected_before: expected(currentLibrary),
      semantic: { kind: "library" }
    });
    payloads.set(libraryIndex, Readable.from([libraryBytes]));
    const timeIndex = targets.length;
    targets.push({
      action: currentTime ? "replace" : "create",
      path: "Data/State/content-time.json",
      status: "planned",
      expected_before: expected(currentTime),
      semantic: { kind: "time_system" }
    });
    payloads.set(timeIndex, Readable.from([initial.timeBytes]));
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "restore-conversation-snapshots",
      created_at: input.restoredAt,
      updated_at: input.restoredAt,
      authority: {
        library: currentLibrary ? { state: "unusable", ...currentLibrary } : { state: "missing" },
        ...(currentTime ? { time: { state: "unusable", ...currentTime } } : { time: { state: "missing" } })
      },
      targets
    };
    const staged = await stageJournalTargets(input.libraryRoot, journal, payloads);
    for (const value of reassignments) {
      if (value.rewriter.replacementCount !== 1 || value.rewriter.previousValue !== value.conversation.archive) {
        throw new TypeError("Duplicate Conversation archive identity was not rewritten exactly once");
      }
    }
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") throw new TypeError("Conversation snapshot recovery lost a file precondition");
    const restored = await readCurrentAuthorityPair(input.libraryRoot);
    if (restored.library["revision"] !== library["revision"] || restored.library["next_archive"] !== library["next_archive"]) {
      throw new TypeError("Conversation snapshot recovery installed the wrong authority");
    }
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Conversation snapshot recovery cleanup failed");
    const indexes = await resolveManagedPath(input.libraryRoot, "Data/Indexes");
    await rm(indexes, { recursive: true, force: true });
    await mkdir(indexes, { recursive: true });
    return {
      status: "restored_from_conversations",
      revision: library["revision"] as number,
      archives: scanned.values.length,
      reassigned: reassignments.length,
      isolated: scanned.isolated
    };
  } finally {
    for (const stream of streams) if (!stream.closed) stream.destroy();
    await writer.release();
  }
}
