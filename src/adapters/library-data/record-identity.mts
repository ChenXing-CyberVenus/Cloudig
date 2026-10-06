import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat } from "node:fs/promises";
import { editRecordFront, identityName, parseRecordIdentityDraft } from "../../core/records/identity-edit.mts";
import { uuidV7 } from "../../core/records/ids.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { commitRecords, readStoredRecord, resolveRecordPath, withRecordSnapshot, type RecordChange, type RecordReadGuard } from "../storage/record-store.mts";
import { fingerprintFile } from "../storage/stream.mts";
import { readRecordCatalog, uniqueConversation, uniqueMark } from "./record-catalog.mts";
import type { RecordConversationSelection } from "./record-file-operations.mts";
import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };

type Stored = Awaited<ReturnType<typeof readStoredRecord>> & { path: string };
export type RecordAvatarBytes = Readonly<{ bytes: Uint8Array; extension: "png" | "jpg" | "gif" | "webp" }>;
export type RecordIdentityNames = RecordConversationSelection & Readonly<{ names: { user?: string | null; assistant?: string | null } }>;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Caller owns the snapshot lock. Query never changes a Front or its image. */
export async function loadRecordIdentityState(root: string) {
  const library = await readStoredRecord(root, "library", "CloudigLibrary.json"), bindings: Stored = { ...await readStoredRecord(root, "identitySettings", "Identities/identity-settings.json"), path: "Identities/identity-settings.json" };
  const fronts = new Map<string, Stored>(), images = new Map<string, { bytes: number; sha256: string }>();
  const ids = new Set([String(bindings.value["subject"]), String(bindings.value["assistant"]), ...Object.values(bindings.value["platforms"] as JsonObject).map(String)]);
  for (const id of ids) {
    const path = `Identities/${id}.json`, front: Stored = { ...await readStoredRecord(root, "identity", path), path }; fronts.set(id, front);
    const image = front.value["image"];
    if (typeof image === "string" && image.startsWith("Identities/Images/") && !images.has(image)) {
      try { const file = await resolveRecordPath(root, image), stat = await lstat(file); if (stat.isFile() && stat.size <= resourceLimits.avatar_file_max_bytes) images.set(image, await fingerprintFile(file)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT") && !(error instanceof TypeError)) throw error; }
    }
  }
  const revision = hash(JSON.stringify([bindings.sha256, ...[...fronts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, value.sha256])]));
  return { revision, language: (library.value["settings"] as JsonObject)["language"] as "zh-CN" | "en", bindings, fronts, images };
}
export async function readRecordIdentityState(root: string) { return withRecordSnapshot(root, () => loadRecordIdentityState(root)); }

/** One explicit save may update Fronts, bindings, images and this conversation's names together. */
export async function commitRecordIdentity(root: string, input: Readonly<{
  expected: string; draft: JsonObject; timestamp: string; avatars?: ReadonlyMap<string, RecordAvatarBytes>; conversation?: RecordIdentityNames; signal?: AbortSignal;
}>) {
  const prepared = await withRecordSnapshot(root, async () => {
    const current = await loadRecordIdentityState(root); if (current.revision !== input.expected) throw new TypeError("Identity records changed; reopen the editor");
    const platformIds = current.bindings.value["platforms"] as JsonObject, draft = parseRecordIdentityDraft(input.draft, new Set(Object.keys(platformIds))), userId = String(current.bindings.value["subject"]);
    const changes = new Map<string, RecordChange>(), reads = new Map<string, RecordReadGuard>(), nextFronts = new Map<string, JsonObject>();
    for (const record of [current.bindings, ...current.fronts.values()]) reads.set(record.path, { path: record.path, expected: record.sha256 });
    const targets = [[userId, draft.global.user], [String(current.bindings.value["assistant"]), draft.global.assistant], ...Object.entries(draft.platforms).map(([key, value]) => [String(platformIds[key]), value])] as const;
    for (const [rawId, rawValue] of targets) {
      const id = rawId as string, value = rawValue as typeof draft.global.user, record = current.fronts.get(id)!; let image: string | undefined;
      if (value.avatar.state === "keep") {
        const path = record.value["image"]; if (typeof path === "string" && current.images.has(path)) { image = path; reads.set(path, { path, expected: current.images.get(path)!.sha256 }); }
      } else if (value.avatar.state === "picker") {
        const avatar = input.avatars?.get(value.avatar.picker); if (!avatar || !["png", "jpg", "gif", "webp"].includes(avatar.extension) || avatar.bytes.byteLength < 1 || avatar.bytes.byteLength > resourceLimits.avatar_file_max_bytes) throw new TypeError("Avatar selection is unavailable or outside its byte limit");
        const digest = hash(avatar.bytes); image = `Identities/Images/${digest}.${avatar.extension}`; let existing: string | null = null;
        try { existing = (await fingerprintFile(await resolveRecordPath(root, image))).sha256; } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        if (existing !== null && existing !== digest) throw new TypeError("Avatar destination has unrelated bytes");
        if (existing === null) changes.set(image, { action: "binary", path: image, data: avatar.bytes, expected: null }); else reads.set(image, { path: image, expected: existing });
      }
      const next = editRecordFront(record.value, value, userId, input.timestamp, image);
      if (!isDeepStrictEqual(next, record.value)) {
        const prior = nextFronts.get(id); if (prior && !isDeepStrictEqual(prior, next)) throw new TypeError("The same bound Front received incompatible edits"); nextFronts.set(id, next);
        changes.set(record.path, { action: "write", kind: "identity", path: record.path, value: next, expected: record.sha256 });
      }
    }
    if (current.bindings.value["apply_assistant_to_all"] !== draft.global.assistant.applyToAll) {
      const value = { ...current.bindings.value, apply_assistant_to_all: draft.global.assistant.applyToAll, edited_at: input.timestamp };
      changes.set(current.bindings.path, { action: "write", kind: "identitySettings", path: current.bindings.path, value, expected: current.bindings.sha256 });
    }
    if (input.conversation) {
      const selected = input.conversation, catalog = await readRecordCatalog(root), conversation = uniqueConversation(catalog, selected.id), mark = uniqueMark(catalog, selected.id);
      if (!conversation || conversation.path !== selected.path || conversation.sha256 !== selected.conversationSha || (mark?.sha256 ?? null) !== selected.markSha || catalog.issues.some(i => i.path.startsWith("Marks/"))) throw new TypeError("Conversation names changed; reopen the editor");
      if (Object.keys(selected.names).some(k => k !== "user" && k !== "assistant")) throw new TypeError("Invalid conversation names");
      const names: JsonObject = {}; for (const key of ["user", "assistant"] as const) { const name = identityName(selected.names[key]); if (name) names[key] = name; }
      const value: JsonObject = mark ? structuredClone(mark.value) : { schema: "cloudig/mark/1.0.0", mark_id: uuidV7(Date.parse(input.timestamp)), target: selected.id, edited_at: input.timestamp };
      if (Object.keys(names).length) value["names"] = names; else delete value["names"];
      const hasSettings = ["conversation_title", "models", "names", "content_time"].some(k => Object.hasOwn(value, k)), changed = !isDeepStrictEqual(mark?.value["names"], value["names"]);
      if (changed) { value["edited_at"] = input.timestamp; const path = mark?.path ?? `Marks/${value["mark_id"]}.json`; if (hasSettings) changes.set(path, { action: "write", path, kind: "mark", value, expected: mark?.sha256 ?? null }); else if (mark) changes.set(path, { action: "delete", path, expected: mark.sha256 }); }
      reads.set(conversation.path, { path: conversation.path, expected: conversation.sha256 }); if (mark) reads.set(mark.path, { path: mark.path, expected: mark.sha256 });
    }
    for (const path of changes.keys()) reads.delete(path);
    return { changes: [...changes.values()], reads: [...reads.values()] };
  });
  const result = await commitRecords(root, prepared.changes, { reads: prepared.reads, ...(input.signal ? { signal: input.signal } : {}), preflight: async () => {
    const current = await loadRecordIdentityState(root); if (current.revision !== input.expected) throw new TypeError("Identity records changed before save");
    if (input.conversation) { const catalog = await readRecordCatalog(root), conversation = uniqueConversation(catalog, input.conversation.id), mark = uniqueMark(catalog, input.conversation.id); if (!conversation || conversation.path !== input.conversation.path || conversation.sha256 !== input.conversation.conversationSha || (mark?.sha256 ?? null) !== input.conversation.markSha || catalog.issues.some(i => i.path.startsWith("Marks/"))) throw new TypeError("Conversation or Mark changed before identity save"); }
  } });
  return { status: result ? "updated" : "unchanged", maintenanceWarnings: [...(result?.maintenanceWarnings ?? [])] };
}
