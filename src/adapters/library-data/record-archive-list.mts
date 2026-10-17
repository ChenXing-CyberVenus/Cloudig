import { readdir } from "node:fs/promises";
import type { JsonObject } from "../../core/contracts/types.mts";
import { resolveRecordPresentation } from "../../core/records/presentation.mts";
import type { RecordArchiveFact } from "../../app/reader/record-archive-list.mts";
import { readStoredRecord, resolveRecordPath } from "../storage/record-store.mts";
import type { RecordCatalog } from "./record-catalog.mts";
import type { readRecordPresentationContext } from "./record-reading.mts";

export function recordArchiveFacts(catalog: RecordCatalog, context: Awaited<ReturnType<typeof readRecordPresentationContext>>): RecordArchiveFact[] {
  const ids = new Map<string, number>(), marks = new Map<string, typeof catalog.marks[number][]>();
  for (const c of catalog.conversations) { const id = String(c.header["conversation_id"]); ids.set(id, (ids.get(id) ?? 0) + 1); }
  for (const m of catalog.marks) { const id = String(m.value["target"]), values = marks.get(id) ?? []; values.push(m); marks.set(id, values); }
  const unreadableMark = catalog.issues.some(i => i.path.startsWith("Marks/"));
  return catalog.conversations.map(file => {
    const id = String(file.header["conversation_id"]), candidates = marks.get(id) ?? [], ambiguous = ids.get(id)! > 1 || candidates.length > 1, mark = !ambiguous ? candidates[0] : undefined;
    return { path: file.path, id, sha256: file.sha256, markSha: mark?.sha256 ?? null, bytes: file.bytes, mtimeNs: file.mtimeNs, messages: file.messageCount, resources: file.resourceCount, header: file.header, ...(mark ? { mark: mark.value } : {}),
      access: ambiguous || unreadableMark ? "read_only_conflict" : "normal", resolved: resolveRecordPresentation({ conversation: file.header, ...(mark ? { mark: mark.value } : {}), ...context }) };
  });
}

/** Actual directories, including empty/nested ones. No business records are inferred or rewritten. Caller holds the snapshot lock. */
export async function listRecordDirectories(root: string): Promise<string[]> {
  const todo = ["Conversations"], result: string[] = [];
  while (todo.length) {
    const parent = todo.pop()!;
    for (const entry of await readdir(await resolveRecordPath(root, parent), { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const relative = `${parent}/${entry.name}`; await resolveRecordPath(root, relative); result.push(relative.slice("Conversations/".length)); todo.push(relative);
    }
  }
  return result.sort((a, b) => a.localeCompare(b, "und"));
}
export async function recordTimeRootOrder(root: string): Promise<ReadonlyMap<string, number>> {
  const order = await readStoredRecord(root, "contentTimeOrder", "ContentTimes/order.json");
  return new Map((order.value["nodes"] as string[]).map((id, index) => [id, index]));
}
