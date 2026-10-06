import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { allocateArchive, recoverNextArchive } from "../../core/archive/ids.mts";
import { serializeLibrary } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { RootStringFieldRewriter } from "../storage/json-root-rewrite.mts";
import { resolveManagedPath } from "../storage/path.mts";
import {
  capturePreviousAuthority,
  readCurrentAuthorityPair,
  type AuthorityPair
} from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";
import { parseEditableConversationPath } from "./archive-commands.mts";
import { readCatalogCache, refreshCatalogAfterArchiveAdoption } from "./catalog.mts";

export type ArchiveAdoptionResult =
  | Readonly<{
    status: "adopted";
    path: string;
    previousArchive: string;
    archive: string;
    generation: number;
    fingerprint: ByteFingerprint;
    catalog: "written" | "conflict" | "missing" | "invalid";
  }>
  | Readonly<{ status: "conflict"; reason: string }>;

function catalogRows(catalog: JsonObject): JsonObject[] {
  return Array.isArray(catalog["archives"])
    ? catalog["archives"].filter((entry): entry is JsonObject => isJsonObject(entry))
    : [];
}

function exactFingerprint(left: ByteFingerprint, right: ByteFingerprint): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

export async function adoptConflictingArchive(input: Readonly<{
  libraryRoot: string;
  path: string;
  expected: ByteFingerprint & Readonly<{ archive: string; generation: number }>;
  transaction: string;
  recoveryTransaction: string;
  recoveryAlreadyCapturedThisBatch: boolean;
  timestamp: string;
}>): Promise<ArchiveAdoptionResult> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Adoption and recovery transactions require distinct tokens");
  const managed = parseEditableConversationPath(input.path).relative;
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    const catalog = await readCatalogCache(input.libraryRoot);
    if (!catalog) return { status: "conflict", reason: "catalog_missing_or_invalid" };
    const rows = catalogRows(catalog);
    const selected = rows.filter((entry) => entry["path"] === managed);
    if (selected.length !== 1) return { status: "conflict", reason: "catalog_path_not_unique" };
    const row = selected[0]!;
    if (
      row["archive"] !== input.expected.archive
      || row["generation"] !== input.expected.generation
      || row["bytes"] !== input.expected.bytes
      || row["sha256"] !== input.expected.sha256
    ) return { status: "conflict", reason: "catalog_selection_changed" };
    if (!rows.some((entry) => entry["path"] !== managed && entry["archive"] === input.expected.archive)) {
      return { status: "conflict", reason: "archive_id_is_not_conflicting" };
    }
    const absolute = await resolveManagedPath(input.libraryRoot, managed, { mustExist: true });
    const observed = await fingerprintFile(absolute);
    if (!exactFingerprint(observed, input.expected)) return { status: "conflict", reason: "conversation_bytes_changed" };

    const libraryArchives = isJsonObject(authority.library["archives"])
      ? Object.keys(authority.library["archives"])
      : [];
    const visibleArchiveIds = [...rows.map((entry) => String(entry["archive"])), ...libraryArchives];
    const recoveredWatermark = recoverNextArchive(visibleArchiveIds);
    const allocation = allocateArchive(
      Math.max(authority.library["next_archive"] as number, recoveredWatermark),
      visibleArchiveIds
    );
    const nextLibrary = structuredClone(authority.library);
    nextLibrary["next_archive"] = allocation.nextArchive;
    nextLibrary["revision"] = (nextLibrary["revision"] as number) + 1;
    nextLibrary["edited_at"] = input.timestamp;
    const nextLibraryBytes = Buffer.from(serializeLibrary(nextLibrary), "utf8");

    const recovery = await capturePreviousAuthority(input.libraryRoot, {
      transaction: input.recoveryTransaction,
      recordedAt: input.timestamp,
      alreadyCapturedThisBatch: input.recoveryAlreadyCapturedThisBatch
    });
    if (recovery === "conflict") return { status: "conflict", reason: "recovery_point_conflict" };

    const rewriter = new RootStringFieldRewriter("archive", input.expected.archive, allocation.archive);
    const rewritten = createReadStream(absolute).pipe(rewriter);
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "adopt-conflicting-archive",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: authority.library["revision"]!, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets: [
        {
          action: "replace",
          path: managed,
          status: "planned",
          expected_before: { state: "present", ...observed },
          semantic: {
            kind: "conversation",
            archive: allocation.archive,
            generation: input.expected.generation,
            schema: "cloudig/conversation/1.0.0"
          }
        },
        {
          action: "replace",
          path: "cloudig-library.json",
          status: "planned",
          expected_before: { state: "present", ...authority.libraryFingerprint },
          semantic: { kind: "library" }
        }
      ]
    };
    const staged = await stageJournalTargets(input.libraryRoot, journal, new Map([
      [0, rewritten],
      [1, Readable.from([nextLibraryBytes])]
    ]));
    if (rewriter.replacementCount !== 1 || rewriter.previousValue !== input.expected.archive) {
      throw new TypeError("Conversation archive identity was not rewritten exactly once");
    }
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") return { status: "conflict", reason: "transaction_precondition_changed" };
    const installedPair: AuthorityPair = await readCurrentAuthorityPair(input.libraryRoot);
    if (
      installedPair.library["revision"] !== nextLibrary["revision"]
      || installedPair.library["next_archive"] !== allocation.nextArchive
    ) throw new TypeError("Adoption did not install the expected Library watermark");
    const installedFingerprint = await fingerprintFile(absolute);
    const targetState = (committed["targets"] as JsonObject[])[0];
    const stagedAfter = targetState?.["staged_after"] as JsonObject | undefined;
    if (
      installedFingerprint.bytes !== stagedAfter?.["bytes"]
      || installedFingerprint.sha256 !== stagedAfter?.["sha256"]
    ) throw new TypeError("Adopted Conversation does not match the staged bytes");
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Archive adoption cleanup failed");
    const catalogStatus = await refreshCatalogAfterArchiveAdoption(input.libraryRoot, {
      path: managed,
      previousArchive: input.expected.archive,
      nextArchive: allocation.archive,
      generation: input.expected.generation,
      fingerprint: installedFingerprint,
      builtAt: input.timestamp
    });
    return {
      status: "adopted",
      path: managed,
      previousArchive: input.expected.archive,
      archive: allocation.archive,
      generation: input.expected.generation,
      fingerprint: installedFingerprint,
      catalog: catalogStatus
    };
  } finally {
    await writer.release();
  }
}
