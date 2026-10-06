import { lstat } from "node:fs/promises";
import type { JsonObject } from "../../core/contracts/types.mts";
import type { BuiltinIdentity } from "../../core/library/overlay.mts";
import { resolveRecordPresentation } from "../../core/records/presentation.mts";
import { RecordSchemaError } from "../../core/records/errors.mts";
import { readStoredRecord, readStoredConversationMetadata, resolveRecordPath, withRecordSnapshot } from "../storage/record-store.mts";
import { readRecordCatalog, uniqueConversation, uniqueMark, type RecordCatalog } from "./record-catalog.mts";

/** Caller holds the snapshot lock; load shared Identity/default data once per query. */
export async function readRecordPresentationContext(root: string, builtins: BuiltinIdentity) {
    const library = await readStoredRecord(root, "library", "CloudigLibrary.json"), bindings = await readStoredRecord(root, "identitySettings", "Identities/identity-settings.json");
    const identities = new Map<string, JsonObject>(), availableAssets = new Set<string>();
    const ids = new Set([String(bindings.value["subject"]), String(bindings.value["assistant"]), ...Object.values(bindings.value["platforms"] as JsonObject).map(String)]);
    for (const id of ids) {
      try {
        const record = await readStoredRecord(root, "identity", `Identities/${id}.json`); identities.set(id, record.value);
        const image = record.value["image"];
        if (typeof image === "string") {
          try { if ((await lstat(await resolveRecordPath(root, image))).isFile()) availableAssets.add(image); } catch { /* fallback display only; no read-time cleanup */ }
        }
      } catch (error) { if (error instanceof RecordSchemaError) throw error; /* Missing optional Identity must not prevent reading source content. */ }
    }
    const settings = library.value["settings"] as JsonObject;
    return { language: settings["language"] as "zh-CN" | "en", bindings: bindings.value, identities, builtins, availableAssets };
}

export function presentationFromCatalog(catalog: RecordCatalog, conversationId: string, context: Awaited<ReturnType<typeof readRecordPresentationContext>>) {
    const conversation = uniqueConversation(catalog, conversationId), mark = uniqueMark(catalog, conversationId);
    if (!conversation) throw new TypeError("Conversation is no longer present; refresh the list");
    const resolved = resolveRecordPresentation({ conversation: conversation.header, ...(mark ? { mark: mark.value } : {}), ...context });
    return { header: conversation.header, ...(mark ? { mark: mark.value } : {}), resolved,
      evidence: { conversation: { path: conversation.path, sha256: conversation.sha256 }, mark: mark ? { path: mark.path, sha256: mark.sha256 } : null }, issues: catalog.issues };
}

export async function conversationFromCatalog(root: string, catalog: RecordCatalog, conversationId: string, context: Awaited<ReturnType<typeof readRecordPresentationContext>>) {
  const summary = presentationFromCatalog(catalog, conversationId, context), actual = await readStoredConversationMetadata(root, summary.evidence.conversation.path);
  if (actual.value["conversation_id"] !== conversationId) throw new TypeError("Conversation identity changed; refresh the list");
  const resolved = resolveRecordPresentation({ conversation: actual.value, ...(summary.mark ? { mark: summary.mark } : {}), ...context });
  return { conversation: actual.value, resourceBodies: actual.resourceBodies, ...(summary.mark ? { mark: summary.mark } : {}), resolved,
    evidence: { ...summary.evidence, conversation: { path: summary.evidence.conversation.path, sha256: actual.sha256 } }, issues: summary.issues };
}

export async function readConversationRecord(root: string, conversationId: string, builtins: BuiltinIdentity) {
  return withRecordSnapshot(root, async () => conversationFromCatalog(root, await readRecordCatalog(root), conversationId, await readRecordPresentationContext(root, builtins)));
}
