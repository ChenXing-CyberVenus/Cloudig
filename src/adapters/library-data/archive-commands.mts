import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";

import type { JsonObject } from "../../core/contracts/types.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { safeWindowsLeaf } from "../storage/names.mts";
import { parseManagedRelativePath, resolveManagedPath } from "../storage/path.mts";
import { readCurrentAuthorityPair } from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";

const ARCHIVE_DIRECTORY = ".Cloudig-Archive";

function directoryName(value: string): string {
  const name = safeWindowsLeaf(value, "user directory name");
  if (name === "." || name === ".." || name === ARCHIVE_DIRECTORY) throw new TypeError("Invalid user directory name");
  return name;
}

export async function listArchiveDirectories(libraryRoot: string): Promise<readonly string[]> {
  const conversations = await resolveManagedPath(libraryRoot, "Conversations", { mustExist: true });
  const names: string[] = [];
  for (const entry of await readdir(conversations, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ARCHIVE_DIRECTORY) continue;
    const name = directoryName(entry.name);
    const absolute = await resolveManagedPath(libraryRoot, `Conversations/${name}`, { mustExist: true });
    const info = await lstat(absolute);
    if (info.isDirectory() && !info.isSymbolicLink()) names.push(name);
  }
  return names.sort((left, right) => left.localeCompare(right, "en"));
}

export async function createArchiveDirectory(libraryRoot: string, name: string): Promise<void> {
  const writer = await acquireSingleWriter(libraryRoot);
  try {
    await readCurrentAuthorityPair(libraryRoot);
    const target = await resolveManagedPath(libraryRoot, `Conversations/${directoryName(name)}`);
    await mkdir(target, { recursive: false });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("Created archive directory is not a confined directory");
  } finally {
    await writer.release();
  }
}

export async function renameArchiveDirectory(libraryRoot: string, from: string, to: string): Promise<void> {
  const writer = await acquireSingleWriter(libraryRoot);
  try {
    await readCurrentAuthorityPair(libraryRoot);
    const source = await resolveManagedPath(libraryRoot, `Conversations/${directoryName(from)}`, { mustExist: true });
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new TypeError("Archive directory source must be a confined directory");
    const target = await resolveManagedPath(libraryRoot, `Conversations/${directoryName(to)}`);
    try {
      await lstat(target);
      throw new TypeError("Destination directory already exists");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await rename(source, target);
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new TypeError("Renamed archive directory is not a confined directory");
  } finally {
    await writer.release();
  }
}

export async function deleteEmptyArchiveDirectory(libraryRoot: string, name: string): Promise<void> {
  const writer = await acquireSingleWriter(libraryRoot);
  try {
    await readCurrentAuthorityPair(libraryRoot);
    const target = await resolveManagedPath(libraryRoot, `Conversations/${directoryName(name)}`, { mustExist: true });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("Archive directory target must be a confined directory");
    if ((await readdir(target)).length !== 0) throw new TypeError("Only completely empty directories can be deleted");
    await rmdir(target);
  } finally {
    await writer.release();
  }
}

export type EditableConversationPath = Readonly<{ relative: string; directory?: string; filename: string; archived: boolean }>;

export function parseEditableConversationPath(value: string): EditableConversationPath {
  const segments = parseManagedRelativePath(value);
  if (segments[0] !== "Conversations" || (segments.length !== 2 && segments.length !== 3)) {
    throw new TypeError("Archive writes only support the Conversations root and one first-level directory");
  }
  const filename = safeWindowsLeaf(segments.at(-1)!, "Conversation filename");
  if (!filename.toLowerCase().endsWith(".json")) throw new TypeError("Archive writes require a Conversation JSON path");
  const directory = segments.length === 3 ? segments[1]! : undefined;
  if (directory !== undefined && directory !== ARCHIVE_DIRECTORY) directoryName(directory);
  return { relative: segments.join("/"), ...(directory === undefined ? {} : { directory }), filename, archived: directory === ARCHIVE_DIRECTORY };
}

async function ensureArchiveTargetParent(libraryRoot: string, target: EditableConversationPath): Promise<void> {
  if (target.archived) {
    const archiveRoot = await resolveManagedPath(libraryRoot, `Conversations/${ARCHIVE_DIRECTORY}`);
    try {
      await mkdir(archiveRoot, { recursive: false });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
  const parentRelative = target.directory === undefined ? "Conversations" : `Conversations/${target.directory}`;
  const parent = await resolveManagedPath(libraryRoot, parentRelative, { mustExist: true });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("Archive target parent must be a confined directory");
}

export async function moveArchiveFile(input: Readonly<{
  libraryRoot: string;
  source: string;
  target: string;
  transaction: string;
  timestamp: string;
  expectedSource?: ByteFingerprint;
}>): Promise<"moved" | "conflict"> {
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const sourcePath = parseEditableConversationPath(input.source);
    const targetPath = parseEditableConversationPath(input.target);
    const source = await resolveManagedPath(input.libraryRoot, sourcePath.relative, { mustExist: true });
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new TypeError("Archive move source must be a confined regular file");
    if (sourcePath.relative === targetPath.relative) return "moved";
    await ensureArchiveTargetParent(input.libraryRoot, targetPath);
    const target = await resolveManagedPath(input.libraryRoot, targetPath.relative);
    const sourceFingerprint = await fingerprintFile(source);
    if (
      input.expectedSource
      && (
        sourceFingerprint.bytes !== input.expectedSource.bytes
        || sourceFingerprint.sha256 !== input.expectedSource.sha256
      )
    ) return "conflict";
    try {
      await lstat(target);
      return "conflict";
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "move-archive",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: authority.library["revision"]!, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets: [
        {
          action: "create",
          path: targetPath.relative,
          status: "planned",
          expected_before: { state: "missing" },
          source: { path: sourcePath.relative, ...sourceFingerprint },
          semantic: { kind: "archive_move" }
        },
        {
          action: "remove_generated",
          path: sourcePath.relative,
          status: "planned",
          expected_before: { state: "present", ...sourceFingerprint },
          semantic: { kind: "archive_move" }
        }
      ]
    };
    const staged = await stageJournalTargets(input.libraryRoot, journal, new Map([[0, createReadStream(source)]]));
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") return "conflict";
    try {
      await stat(source);
      throw new TypeError("Archive move left the source path installed");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const installed = await fingerprintFile(target);
    if (installed.bytes !== sourceFingerprint.bytes || installed.sha256 !== sourceFingerprint.sha256) {
      throw new TypeError("Archive move target does not match the source bytes");
    }
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    return cleaned["state"] === "cleaned" ? "moved" : "conflict";
  } finally {
    await writer.release();
  }
}

export async function archiveConversation(input: Omit<Parameters<typeof moveArchiveFile>[0], "target">): Promise<"moved" | "conflict"> {
  const source = parseEditableConversationPath(input.source);
  if (source.archived) throw new TypeError("Conversation is already archived");
  return moveArchiveFile({ ...input, target: `Conversations/${ARCHIVE_DIRECTORY}/${source.filename}` });
}

export async function restoreConversation(
  input: Omit<Parameters<typeof moveArchiveFile>[0], "target"> & Readonly<{ targetDirectory?: string }>
): Promise<"moved" | "conflict"> {
  const source = parseEditableConversationPath(input.source);
  if (!source.archived) throw new TypeError("Restore requires a Conversation inside .Cloudig-Archive");
  const directory = input.targetDirectory ? `${directoryName(input.targetDirectory)}/` : "";
  return moveArchiveFile({ ...input, target: `Conversations/${directory}${source.filename}` });
}

export async function planRecycleConversation(libraryRoot: string, relativePath: string): Promise<Readonly<{
  capability: "recycle-conversation";
  path: string;
  bytes: number;
  sha256: string;
}>> {
  const managed = parseEditableConversationPath(relativePath).relative;
  const absolute = await resolveManagedPath(libraryRoot, managed, { mustExist: true });
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new TypeError("Recycle target must be a confined regular file");
  const fingerprint = await fingerprintFile(absolute);
  return { capability: "recycle-conversation", path: managed, ...fingerprint };
}

export async function recycledConversationIsMissing(libraryRoot: string, relativePath: string): Promise<boolean> {
  const managed = parseEditableConversationPath(relativePath).relative;
  const absolute = await resolveManagedPath(libraryRoot, managed);
  try {
    await lstat(absolute);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
