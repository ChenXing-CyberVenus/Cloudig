import { readdir, utimes } from "node:fs/promises";
import type { Readable } from "node:stream";

import type { JsonObject } from "../../core/contracts/types.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { chooseNoReplaceLeaf } from "../storage/names.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { readCurrentAuthorityPair } from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";

export type SourceImportResult =
  | Readonly<{ status: "imported"; path: string; fingerprint: ByteFingerprint }>
  | Readonly<{ status: "conflict"; path: string }>;

export async function importSourceStream(input: Readonly<{
  libraryRoot: string;
  filename: string;
  source: Readable;
  transaction: string;
  timestamp: string;
  capturedAt?: string;
  signal?: AbortSignal;
}>): Promise<SourceImportResult> {
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    const inbox = await resolveManagedPath(input.libraryRoot, "Inbox", { mustExist: true });
    const occupied = new Set((await readdir(inbox)).map((entry) => entry));
    const filename = chooseNoReplaceLeaf(input.filename, occupied);
    const relativePath = `Inbox/${filename}`;
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "import-source",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: authority.library["revision"]!, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets: [{
        action: "create",
        path: relativePath,
        status: "planned",
        expected_before: { state: "missing" },
        semantic: { kind: "source_import" }
      }]
    };
    const staged = await stageJournalTargets(input.libraryRoot, journal, new Map([[0, input.source]]), input.signal);
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") return { status: "conflict", path: relativePath };
    const target = await resolveManagedPath(input.libraryRoot, relativePath, { mustExist: true });
    const fingerprint = await fingerprintFile(target);
    const targetState = (committed["targets"] as JsonObject[])[0];
    const stagedAfter = targetState?.["staged_after"] as JsonObject | undefined;
    if (fingerprint.bytes !== stagedAfter?.["bytes"] || fingerprint.sha256 !== stagedAfter?.["sha256"]) {
      throw new TypeError("Imported source bytes do not match the staged transaction");
    }
    if (input.capturedAt) {
      const capturedAt = new Date(input.capturedAt);
      if (!Number.isFinite(capturedAt.getTime())) throw new TypeError("Imported source capture time is invalid");
      await utimes(target, capturedAt, capturedAt);
    }
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Source import cleanup failed");
    return { status: "imported", path: relativePath, fingerprint };
  } finally {
    await writer.release();
  }
}
