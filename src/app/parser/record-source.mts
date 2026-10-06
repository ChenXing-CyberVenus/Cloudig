import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { readExporterEnvelope } from "../../adapters/parser/html-envelope.mts";
import { claudeRecordSelector, claudeRecordToDraft } from "../../adapters/parser/claude-export-record.mts";
import { claudeContainerAdapter } from "../../adapters/parser/claude-container.mts";
import { captureDiagnosticErrors, canonicalDiagnosticErrors } from "./diagnostics.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import type { ParsedSourceDraft, SourceMessageFacts } from "./adapter.mts";
import type { SourceRecordFacts } from "./conversation-record.mts";
import { fileCaptureTime } from "../../adapters/library-data/record-source-import.mts";
import { exporterCapture, validCaptureTime } from "../../core/records/source-time.mts";
export { fileCaptureTime } from "../../adapters/library-data/record-source-import.mts";

export type ExtractedRecord = Readonly<{ parsed: ParsedSourceDraft; facts: SourceRecordFacts }>;
export type CapturedSourceTime = NonNullable<SourceRecordFacts["captured"]>;
const object = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const label = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length > 0 ? v : undefined;

export async function extractHtmlRecord(input: Readonly<{
  filePath: string; temporaryRoot: string; captured?: CapturedSourceTime | undefined; signal?: AbortSignal;
  onProgress?: (phase: string, completed: number, total: number) => void;
}>): Promise<ExtractedRecord> {
  const envelope = await readExporterEnvelope({ filePath: input.filePath, temporaryRoot: input.temporaryRoot,
    ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {}) });
  const fileCaptured = input.captured && validCaptureTime(input.captured.at) ? input.captured : await fileCaptureTime(input.filePath, envelope.fingerprint.sha256);
  const captured = exporterCapture(envelope.manifest, envelope.payload) ?? fileCaptured;
  const sourceMessages: SourceMessageFacts[] = [];
  const blockSpeakers = new Map<JsonObject, SourceMessageFacts>();
  let sourceCurrent: string | undefined, explicitModel: string | undefined;
  const draft = await envelope.adapter.parse({ manifest: envelope.manifest, payload: envelope.payload,
    source: { file: path.basename(input.filePath), ...envelope.fingerprint, ...(fileCaptured ? { fileSystemCapturedAt: fileCaptured.at } : {}) }, reading: envelope.reading,
    record: { message(index, facts) { if (sourceMessages[index]) throw new TypeError("Duplicate message witness"); sourceMessages[index] = facts; }, current(id) { sourceCurrent = id; }, conversationModel(model) { explicitModel = model; }, block(value, facts) { blockSpeakers.set(value, facts); } },
    async onProgress(completed, total) { input.onProgress?.("normalize", completed, total); await setImmediate(); input.signal?.throwIfAborted(); } });
  // Capture inference belongs to this shared boundary, not twelve different fallback expressions.
  // Remove only the old draft's capture field; preserve raw message dates and all source content.
  const draftSource = object(draft["source"]);
  delete draftSource["captured_at"];
  if (captured) draftSource["captured_at"] = { value: captured.at, basis: captured.from.startsWith("bookmark:") ? "manifest" : "file_system_earliest" };
  const conversationModel = explicitModel;
  if (sourceMessages.length && (sourceMessages.length !== (draft["messages"] as JsonObject[]).length || Object.keys(sourceMessages).length !== sourceMessages.length)) throw new TypeError("Incomplete message source witnesses");
  if (!sourceCurrent && draft["current_message"] && sourceMessages.length) {
    const index = (draft["messages"] as JsonObject[]).findIndex(m => m["id"] === draft["current_message"]);
    sourceCurrent = sourceMessages[index]?.id;
  }
  return { parsed: { draft, adapter: envelope.adapter.manifest, sourceFingerprint: envelope.fingerprint,
    systemLogErrors: [...captureDiagnosticErrors(envelope.manifest), ...canonicalDiagnosticErrors(draft)] },
    facts: { ...(captured ? { captured } : {}), ...(conversationModel ? { conversationModel } : {}), ...(sourceCurrent ? { current: sourceCurrent } : {}), ...(sourceMessages.length ? { messages: sourceMessages } : {}), ...(blockSpeakers.size ? { blockSpeakers } : {}) } };
}

export function extractClaudeRecord(input: Readonly<{
  record: JsonObject; source: Readonly<{ file: string; bytes: number; sha256: string }>; captured?: CapturedSourceTime | undefined;
}>): ExtractedRecord {
  const ordered: JsonObject[] = [];
  const blockSpeakers = new Map<JsonObject, SourceMessageFacts>();
  const captured = input.captured && validCaptureTime(input.captured.at) ? input.captured : undefined;
  const parsed = claudeRecordToDraft({ record: input.record, selector: claudeRecordSelector(String(input.record["uuid"])),
    source: { ...input.source, ...(captured ? { capturedAt: captured.at } : {}) }, onSourceMessage: message => { ordered.push(message); },
    onSystemContent: block => { blockSpeakers.set(block, { role: "system", name: "Claude platform context" }); } });
  const sourceCurrent = label(input.record["current_leaf_message_uuid"] ?? input.record["current_message_uuid"]);
  const known = new Set(ordered.map(m => label(m["uuid"])));
  return { parsed: { draft: parsed, adapter: claudeContainerAdapter.manifest,
    sourceFingerprint: { bytes: input.source.bytes, sha256: input.source.sha256 }, systemLogErrors: canonicalDiagnosticErrors(parsed) },
    facts: { ...(captured ? { captured } : {}),
      ...(blockSpeakers.size ? { blockSpeakers } : {}),
      ...(sourceCurrent && known.has(sourceCurrent) ? { current: sourceCurrent } : {}),
      messages: ordered.map(raw => {
        const role = raw["sender"] === "human" ? "user" : label(raw["sender"]) ?? "assistant";
        const id = label(raw["uuid"]), parent = label(raw["parent_message_uuid"]), model = label(raw["model"] ?? raw["model_name"] ?? raw["model_slug"]);
        const sourceId = label(raw["sender_id"]), name = label(raw["sender_name"]);
        return { ...(id ? { id } : {}), ...(parent ? { parent } : {}), role,
          ...(model ? { model } : {}), ...(sourceId ? { sourceId } : {}), ...(name ? { name } : {}) };
      }) } };
}
