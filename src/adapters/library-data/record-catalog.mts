import { readdir, lstat, readFile } from "node:fs/promises";
import { readStoredRecord, readStoredConversationMetadata, resolveRecordPath } from "../storage/record-store.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { parseRecordJson } from "../../core/records/index.mts";
import { validateConversationHeader } from "../../core/records/schema-registry.mts";
import { writeRecordProjection } from "../storage/record-projection.mts";
import { RecordSchemaError } from "../../core/records/errors.mts";

export type CatalogRecord = Readonly<{ path: string; value: JsonObject; sha256: string }>;
export type CatalogConversation = Readonly<{ path: string; header: JsonObject; sha256: string; bytes: number; mtimeNs: string; messageCount: number; resourceCount: number }>;
export type RecordCatalog = Readonly<{ conversations: readonly CatalogConversation[]; marks: readonly CatalogRecord[]; issues: readonly { path: string; error: string; code?: string }[] }>;
type IndexedHeader = { stamp: string; sha256: string; header: JsonObject; messageCount: number; resourceCount: number };
const INDEX = "appdata/indexes/conversations.json";
const isMissing = (e: unknown): boolean => e instanceof Error && "code" in e && e.code === "ENOENT";

async function indexFile(root: string): Promise<{ text: string; files: Record<string, IndexedHeader> }> {
  try {
    const text = await readFile(await resolveRecordPath(root, INDEX), "utf8"), value = parseRecordJson(text) as JsonObject;
    if (value["schema"] !== "cloudig/conversation-index/1.0.0" || !value["files"] || typeof value["files"] !== "object" || Array.isArray(value["files"])) return { text, files: {} };
    const files: Record<string, IndexedHeader> = Object.create(null);
    for (const [key, raw] of Object.entries(value["files"])) {
      const r = raw as unknown as IndexedHeader;
      if (r && typeof r.stamp === "string" && /^[a-f0-9]{64}$/u.test(r.sha256) && validateConversationHeader(r.header) && [r.messageCount, r.resourceCount].every(n => Number.isSafeInteger(n) && n >= 0)) files[key] = r;
    }
    return { text, files };
  } catch (e) { if (isMissing(e) || e instanceof SyntaxError || e instanceof TypeError) return { text: "", files: {} }; throw e; }
}

/** Caller holds the snapshot/writer lock. Only the rebuildable small index is written. */
export async function readRecordCatalog(root: string, options: Readonly<{ force?: boolean; onInspect?: (path: string) => void }> = {}): Promise<RecordCatalog> {
  const conversations: CatalogConversation[] = [], marks: CatalogRecord[] = [], issues: { path: string; error: string; code?: string }[] = [];
  const prior = await indexFile(root), next: Record<string, IndexedHeader> = Object.create(null);
  for (const area of ["Conversations", "Archives", "Marks"]) {
    const todo = [area];
    while (todo.length) {
      const directory = todo.pop()!;
      let entries;
      try { entries = await readdir(await resolveRecordPath(root, directory), { withFileTypes: true }); }
      catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") continue; throw e; }
      for (const entry of entries) {
        const file = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) { issues.push({ path: file, error: "Linked content is outside the managed record set" }); continue; }
        if (entry.isDirectory()) { if (area !== "Marks") todo.push(file); continue; }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
        try {
          if (area === "Marks") { marks.push({ path: file, ...await readStoredRecord(root, "mark", file) }); continue; }
          const absolute = await resolveRecordPath(root, file), before = await lstat(absolute, { bigint: true });
          const stamp = (info: typeof before): string => [info.size, info.mtimeNs, info.ctimeNs, info.dev, info.ino].join(":");
          let indexed = options.force ? undefined : prior.files[file];
          if (!indexed || indexed.stamp !== stamp(before)) {
            options.onInspect?.(file);
            const record = await readStoredConversationMetadata(root, file), after = await lstat(absolute, { bigint: true });
            if (stamp(before) !== stamp(after)) throw new TypeError("Conversation changed during catalog inspection");
            const { messages: _messages, resources: _resources, references: _references, limitations: _limitations, ...header } = record.value;
            indexed = { stamp: stamp(after), sha256: record.sha256, header, messageCount: ((record.value["messages"] as JsonObject)["items"] as JsonObject[]).length, resourceCount: (record.value["resources"] as JsonObject[] | undefined)?.length ?? 0 };
          }
          next[file] = indexed; conversations.push({ path: file, header: indexed.header, sha256: indexed.sha256, bytes: Number(before.size), mtimeNs: String(before.mtimeNs), messageCount: indexed.messageCount, resourceCount: indexed.resourceCount });
        } catch (e) { issues.push({ path: file, error: e instanceof Error ? e.message : String(e), ...(e instanceof RecordSchemaError ? { code: e.code } : {}) }); }
      }
    }
  }
  const text = JSON.stringify({ schema: "cloudig/conversation-index/1.0.0", files: Object.fromEntries(Object.keys(next).sort().map(k => [k, next[k]])) }, null, 2) + "\n";
  if (text !== prior.text) try { await writeRecordProjection(root, INDEX, text); } catch (e) { issues.push({ path: INDEX, error: `Index refresh could not be saved: ${e instanceof Error ? e.message : String(e)}` }); }
  return { conversations, marks, issues };
}

export function uniqueConversation(catalog: RecordCatalog, id: string): CatalogConversation | undefined {
  const found = catalog.conversations.filter(r => r.header["conversation_id"] === id);
  if (found.length > 1) throw new TypeError("Conversation UUID conflict; both originals are preserved");
  return found[0];
}
export function uniqueMark(catalog: RecordCatalog, id: string): CatalogRecord | undefined {
  const found = catalog.marks.filter(r => r.value["target"] === id);
  if (found.length > 1) throw new TypeError("Multiple Marks target this Conversation; no automatic winner is chosen");
  return found[0];
}
