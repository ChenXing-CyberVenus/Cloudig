const ARCHIVE_ID = /^a([1-9][0-9]*)$/u;

export function archiveNumber(id: string): bigint | undefined {
  const match = ARCHIVE_ID.exec(id);
  return match ? BigInt(match[1]!) : undefined;
}

export function recoverNextArchive(visibleArchiveIds: Iterable<string>): number {
  let maximum = 0n;
  for (const id of visibleArchiveIds) {
    const value = archiveNumber(id);
    if (value !== undefined && value > maximum) maximum = value;
  }
  const next = maximum + 1n;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Archive ID space exceeds I-JSON safe integers");
  return Number(next);
}

export function allocateArchive(nextArchive: number, visibleArchiveIds: Iterable<string>): {
  archive: string;
  nextArchive: number;
} {
  if (!Number.isSafeInteger(nextArchive) || nextArchive < 1) throw new RangeError("next_archive must be a positive safe integer");
  const recovered = recoverNextArchive(visibleArchiveIds);
  if (nextArchive < recovered) throw new RangeError("next_archive would reuse or backfill an allocated archive ID");
  if (nextArchive === Number.MAX_SAFE_INTEGER) throw new RangeError("Archive ID space is exhausted");
  return { archive: `a${nextArchive}`, nextArchive: nextArchive + 1 };
}

export function classifyArchiveConflict(
  candidateArchive: string,
  candidatePath: string,
  observed: ReadonlyArray<{ archive: string; path: string }>
): "available" | "same_file" | "read_only_conflict" {
  const matches = observed.filter((entry) => entry.archive === candidateArchive);
  if (matches.length === 0) return "available";
  return matches.length === 1 && matches[0]!.path === candidatePath ? "same_file" : "read_only_conflict";
}
