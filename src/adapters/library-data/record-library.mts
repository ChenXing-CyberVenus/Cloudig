import { mkdir, lstat } from "node:fs/promises";
import { createLibraryRecords, type LibraryDefaultsInput, type NewRecord } from "../../app/library/record-defaults.mts";
import { commitRecords, resolveRecordPath } from "../storage/record-store.mts";
import { requireFreshRecordLayout } from "./record-preferences.mts";

/** Initialize records without overwriting any existing authority or clearing user directories. */
export async function createRecordLibrary(root: string, input: LibraryDefaultsInput): Promise<readonly NewRecord[]> {
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new TypeError("Library root cannot be a junction or symbolic link");
  await requireFreshRecordLayout(root);
  const records = createLibraryRecords(input);
  for (const directory of ["Inbox", "Conversations", "Marks", "Archives", "Exports", "cache"]) await mkdir(await resolveRecordPath(root, directory), { recursive: true });
  await commitRecords(root, records.map(record => ({ action: "write", ...record, expected: null })), { preflight: () => requireFreshRecordLayout(root) });
  return records;
}
