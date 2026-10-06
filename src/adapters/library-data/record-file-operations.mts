import { mkdir, readdir } from "node:fs/promises";
import { commitRecords, readStoredRecord, recordFileIdentity, resolveRecordPath, withRecordSnapshot, type RecordChange, type RecordFileIdentity } from "../storage/record-store.mts";
import { safeWindowsLeaf, chooseNoReplaceLeaf } from "../storage/names.mts";
import { confinedRelativePath } from "../../core/records/layout.mts";
import { readRecordCatalog, uniqueConversation, uniqueMark } from "./record-catalog.mts";
import type { JsonObject } from "../../core/contracts/types.mts";

export type RecordDirectory = Readonly<{ name: string; identity: RecordFileIdentity }>;
export type RecordConversationSelection = Readonly<{ path: string; id: string; conversationSha: string; markSha: string | null }>;
const sameIdentity = (a: RecordFileIdentity, b: RecordFileIdentity) => a.device === b.device && a.inode === b.inode;
function directoryPath(name: string): string { if (!name) return "Conversations"; return confinedRelativePath(`Conversations/${name}`); }
export async function assertRecordDirectory(root: string, directory: RecordDirectory): Promise<void> {
  if (!directory.name) throw new TypeError("The Conversation root is not a user directory");
  if (!sameIdentity(await recordFileIdentity(root, directoryPath(directory.name), "directory"), directory.identity)) throw new TypeError("Selected directory was replaced; refresh the list");
}
export async function createRecordDirectory(root: string, name: string, signal?: AbortSignal): Promise<void> {
  safeWindowsLeaf(name, "directory name");
  await withRecordSnapshot(root, async () => {
    await readStoredRecord(root, "library", "CloudigLibrary.json");
    signal?.throwIfAborted();
    await mkdir(await resolveRecordPath(root, directoryPath(name)), { recursive: false });
  });
}
async function directorySettings(root: string, from: string, to: string, timestamp: string, preserveSuffix = true) {
  const library = await readStoredRecord(root, "library", "CloudigLibrary.json"), settings = library.value["settings"] as JsonObject, output = String(settings["default_output_directory"]);
  const changes: RecordChange[] = [];
  if (output === from || output.startsWith(`${from}/`)) {
    settings["default_output_directory"] = `${to}${preserveSuffix ? output.slice(from.length) : ""}`; library.value["edited_at"] = timestamp;
    changes.push({ action: "write", kind: "library", path: "CloudigLibrary.json", expected: library.sha256, value: library.value });
  }
  return { changes, reads: changes.length ? [] : [{ path: "CloudigLibrary.json", expected: library.sha256 }] };
}
export async function renameRecordDirectory(root: string, selected: RecordDirectory, name: string, timestamp: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  safeWindowsLeaf(name, "directory name"); const from = directoryPath(selected.name), pieces = from.split("/"); pieces[pieces.length - 1] = name; const to = pieces.join("/");
  if (from === to) { await withRecordSnapshot(root, () => assertRecordDirectory(root, selected)); return { status: "unchanged" }; }
  const plan = await withRecordSnapshot(root, async () => { await assertRecordDirectory(root, selected); return directorySettings(root, from, to, timestamp); });
  const saved = await commitRecords(root, plan.changes, { ...(signal ? { signal } : {}), reads: plan.reads, relocations: [{ from, to, kind: "directory", identity: selected.identity }] });
  return { status: "renamed", maintenanceWarnings: [...(saved?.maintenanceWarnings ?? [])] };
}
export async function deleteEmptyRecordDirectory(root: string, selected: RecordDirectory, timestamp: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const from = directoryPath(selected.name);
  const plan = await withRecordSnapshot(root, async () => {
    await assertRecordDirectory(root, selected); if ((await readdir(await resolveRecordPath(root, from))).length) throw new TypeError("Only completely empty directories can be deleted");
    return directorySettings(root, from, "Conversations", timestamp, false);
  });
  const saved = await commitRecords(root, plan.changes, { ...(signal ? { signal } : {}), reads: plan.reads, relocations: [{ from, kind: "empty_directory", identity: selected.identity }] });
  return { status: "deleted", maintenanceWarnings: [...(saved?.maintenanceWarnings ?? [])] };
}
async function selectedRecord(root: string, selected: RecordConversationSelection) {
  const catalog = await readRecordCatalog(root), conversation = uniqueConversation(catalog, selected.id), mark = uniqueMark(catalog, selected.id);
  if (!conversation || conversation.path !== selected.path || conversation.sha256 !== selected.conversationSha || (mark?.sha256 ?? null) !== selected.markSha || catalog.issues.some(i => i.path.startsWith("Marks/"))) throw new TypeError("Selected Conversation or Mark changed; refresh the list");
  return { conversation, mark };
}
/** Same-volume relocation preserves exact JSON bytes/mtime and UUID; Mark association is by UUID, not path. */
export async function moveRecordConversation(root: string, selected: RecordConversationSelection, area: "Conversations" | "Archives", directory?: RecordDirectory, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (area === "Archives" && directory) throw new TypeError("Archive destination does not accept a Conversation directory");
  const plan = await withRecordSnapshot(root, async () => {
    const { mark } = await selectedRecord(root, selected); if (directory) await assertRecordDirectory(root, directory);
    const parent = directory ? directoryPath(directory.name) : area, filename = selected.path.split("/").at(-1)!;
    const identity = await recordFileIdentity(root, selected.path, "file");
    if (selected.path.split("/").slice(0, -1).join("/") === parent) return { unchanged: true as const };
    const target = `${parent}/${chooseNoReplaceLeaf(filename, new Set(await readdir(await resolveRecordPath(root, parent))))}`;
    const parentIdentity = await recordFileIdentity(root, parent, "directory");
    return { unchanged: false as const, target, identity, parent, parentIdentity, reads: mark ? [{ path: mark.path, expected: mark.sha256 }] : [] };
  });
  if (plan.unchanged) return { status: "unchanged", path: selected.path, maintenanceWarnings: [] };
  const saved = await commitRecords(root, [], { ...(signal ? { signal } : {}), reads: plan.reads, relocations: [{ from: selected.path, to: plan.target, kind: "file", identity: plan.identity, sha256: selected.conversationSha }],
    preflight: async () => { await selectedRecord(root, selected); if (!sameIdentity(await recordFileIdentity(root, plan.parent, "directory"), plan.parentIdentity)) throw new TypeError("Destination directory changed"); } });
  return { status: "moved", path: plan.target, maintenanceWarnings: [...(saved?.maintenanceWarnings ?? [])] };
}
