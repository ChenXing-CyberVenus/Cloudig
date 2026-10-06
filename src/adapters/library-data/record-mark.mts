import { uuidV7 } from "../../core/records/ids.mts";
import { isDeepStrictEqual } from "node:util";
import { validateRecord, validateRecordRange } from "../../core/records/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { normalizeRange } from "../../core/time/range.mts";
import { loadRecordTimes } from "./record-time.mts";
import type { TimeTarget } from "../../core/records/time-graph.mts";
import { commitRecords, readStoredRecord, withRecordSnapshot, type RecordChange } from "../storage/record-store.mts";
import { readRecordCatalog, uniqueConversation, uniqueMark } from "./record-catalog.mts";

/** Entire editable section; omitted fields mean explicitly restore source/default. */
export async function saveConversationMark(root: string, input: Readonly<{
  conversationId: string; expectedConversation: string; expectedMark: string | null; settings: JsonObject; timestamp: string;
  refreshAnchor?: Readonly<{ date: string; offset: string }>; forceEditedAt?: boolean;
}>): Promise<JsonObject | undefined> {
  if (input.forceEditedAt !== undefined && typeof input.forceEditedAt !== "boolean") throw new TypeError("Explicit timestamp refresh must be boolean");
  if (input.refreshAnchor && !validateRecordRange({ start: { kind: "now", anchor: input.refreshAnchor } }).ok) throw new TypeError("Invalid explicit time anchor");
  const prepared = await withRecordSnapshot(root, async () => {
    const catalog = await readRecordCatalog(root), conversation = uniqueConversation(catalog, input.conversationId), old = uniqueMark(catalog, input.conversationId);
    if (!conversation || conversation.sha256 !== input.expectedConversation || (old?.sha256 ?? null) !== input.expectedMark) throw new TypeError("Conversation or Mark changed; reopen the editor");
    // Invalid Mark originals cannot be treated as absence and overwritten by a
    // second Mark whose target we cannot reliably reconcile.
    if (catalog.issues.some(i => i.path.startsWith("Marks/"))) throw new TypeError("An unreadable Mark requires explicit recovery before editing");
    for (const key of Object.keys(input.settings)) if (!["conversation_title", "models", "names", "content_time"].includes(key)) throw new TypeError(`Not an editable Mark field: ${key}`);
    const bindings = await readStoredRecord(root, "identitySettings", "Identities/identity-settings.json");
    const userPath = `Identities/${bindings.value["subject"]}.json`, user = await readStoredRecord(root, "identity", userPath);
    const settings = structuredClone(input.settings);
    const oldSettings = old ? Object.fromEntries(Object.entries(old.value).filter(([k]) => ["conversation_title", "models", "names", "content_time"].includes(k))) as JsonObject : {};
    let timeReads: { path: string; expected: string }[] = [];
    const contentTime = settings["content_time"];
    if (isJsonObject(contentTime) && isJsonObject(contentTime["range"])) {
      const range = normalizeRange(contentTime["range"]), priorTime = oldSettings["content_time"];
      const priorRange = isJsonObject(priorTime) && isJsonObject(priorTime["range"]) ? priorTime["range"] : {};
      const changed = ["start", "end"].filter(side => isJsonObject(range[side]) && (range[side] as JsonObject)["kind"] === "node" && !isDeepStrictEqual(range[side], priorRange[side]));
      if (changed.length) {
        const times = await loadRecordTimes(root);
        for (const side of changed) {
          const target = (range[side] as JsonObject)["target"]; if (!isJsonObject(target)) throw new TypeError("Selected time node needs a target");
          range[side] = await times.graph.snapshot(target as TimeTarget);
        }
        timeReads = times.nodes.map(n => ({ path: n.path, expected: n.sha256 }));
      }
      contentTime["range"] = normalizeRange(range);
      if (input.refreshAnchor) {
        const refresh = (endpoint: JsonObject) => { if (["now", "relative"].includes(String(endpoint["kind"]))) endpoint["anchor"] = { ...input.refreshAnchor! }; };
        for (const endpoint of Object.values(contentTime["range"] as JsonObject)) if (isJsonObject(endpoint)) {
          if (endpoint["kind"] === "node") {
            const snapshot = endpoint["snapshot"], sort = isJsonObject(snapshot) ? snapshot["sort"] : undefined;
            if (isJsonObject(sort)) for (const value of Object.values(sort)) if (isJsonObject(value)) refresh(value);
          } else refresh(endpoint);
        }
        contentTime["range"] = normalizeRange(contentTime["range"] as JsonObject);
      }
    }
    for (const model of (settings["models"] ?? []) as JsonObject[]) for (const name of (model["names"] ?? []) as JsonObject[]) {
      const claimers = name["claimers"] as JsonObject[];
      if (!Array.isArray(claimers) || !claimers.length || claimers.some(c => c["front"] !== user.value["front_id"])) throw new TypeError("Model claims must reference this Library's user Identity");
    }
    if (isDeepStrictEqual(oldSettings, settings) && !input.forceEditedAt && !input.refreshAnchor) return { unchanged: true as const, value: old?.value };
    const value: JsonObject | undefined = Object.keys(settings).length ? { schema: "cloudig/mark/1.0.0", mark_id: old?.value["mark_id"] ?? uuidV7(Date.parse(input.timestamp)), target: input.conversationId, edited_at: input.timestamp, ...settings } : undefined;
    if (value) { const valid = validateRecord("mark", value); if (!valid.ok) throw new TypeError(`Invalid Mark: ${JSON.stringify(valid.issues)}`); }
    const markPath = old?.path ?? `Marks/${value?.["mark_id"]}.json`;
    const changes: RecordChange[] = value ? [{ action: "write", path: markPath, kind: "mark", value, expected: old?.sha256 ?? null }] : old ? [{ action: "delete", path: old.path, expected: old.sha256 }] : [];
    return { unchanged: false as const, value, changes, timeReads, reads: [ { path: conversation.path, expected: conversation.sha256 }, { path: "Identities/identity-settings.json", expected: bindings.sha256 }, { path: userPath, expected: user.sha256 }, ...timeReads ] };
  });
  if (!prepared.unchanged) await commitRecords(root, prepared.changes, { reads: prepared.reads, async preflight() {
    const catalog = await readRecordCatalog(root);
    if (catalog.issues.some(i => i.path.startsWith("Marks/")) || (uniqueMark(catalog, input.conversationId)?.sha256 ?? null) !== input.expectedMark) throw new TypeError("Mark changed before save; reopen the editor");
    if (prepared.timeReads.length) {
      const times = await loadRecordTimes(root), before = new Map(prepared.timeReads.map(r => [r.path, r.expected]));
      if (times.nodes.length !== before.size || times.nodes.some(n => before.get(n.path) !== n.sha256)) throw new TypeError("ContentTime graph changed before saving its snapshot");
    }
  } });
  return prepared.value;
}
