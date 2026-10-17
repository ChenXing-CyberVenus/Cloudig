import { mkdir, readdir } from "node:fs/promises";
import { moveFileNoReplace } from "../storage/no-replace.mts";
import path from "node:path";
import { Readable } from "node:stream";
import { buildRecordMarkdown } from "../../app/export/markdown.mts";
import type { BuiltinIdentity } from "../../core/library/overlay.mts";
import { readRecordCatalog } from "./record-catalog.mts";
import { conversationFromCatalog, readRecordPresentationContext } from "./record-reading.mts";
import { withRecordSnapshot, resolveRecordPath } from "../storage/record-store.mts";
import { chooseNoReplaceLeaf } from "../storage/names.mts";
import { streamRecordResource } from "../reader/record-resource.mts";
import { encodeBase64Chunks, fingerprintFile, RESOURCE_BASE64_DECODED_CHUNK_BYTES, writeOwnedStagingFile } from "../storage/stream.mts";
import { createRuntimeCacheSession } from "../storage/runtime-cache.mts";
import type { ContentMode } from "../../app/reader/content-selection.mts";

export type RecordMarkdownRequest = Readonly<{
  conversationId: string; expectedConversation: string; expectedMark: string | null; builtins: BuiltinIdentity;
  selectedLeaf?: string; branchChoices?: Readonly<Record<string, string>>; signal?: AbortSignal; onProgress?: (bytes: number, total: number) => void;
  contentMode?: ContentMode; messageIds?: readonly string[]; includeHeader?: boolean;
}>;

/** One streamed generator for file export and native clipboard transfer. Caller owns close(). */
export async function prepareRecordMarkdown(root: string, input: RecordMarkdownRequest) {
  input.signal?.throwIfAborted();
  // Cache creation takes the same writer lease: acquire it before the export
  // snapshot, never recursively from inside that snapshot's critical section.
  const session = await createRuntimeCacheSession(await resolveRecordPath(root, "cache"), root);
  const stagedPath = path.join(session.root, "payload.md");
  try { return await withRecordSnapshot(root, async () => {
    input.signal?.throwIfAborted();
    const context = await readRecordPresentationContext(root, input.builtins);
    const reading = await conversationFromCatalog(root, await readRecordCatalog(root), input.conversationId, context);
    if (reading.evidence.conversation.sha256 !== input.expectedConversation || (reading.evidence.mark?.sha256 ?? null) !== input.expectedMark) throw new TypeError("Conversation or Mark changed; reopen before export");
    const plan = buildRecordMarkdown({ ...reading, locale: context.language, ...(input.selectedLeaf ? { selectedLeaf: input.selectedLeaf } : {}), ...(input.branchChoices ? { branchChoices: input.branchChoices } : {}),
      ...(input.contentMode ? { contentMode: input.contentMode } : {}), ...(input.messageIds ? { messageIds: input.messageIds } : {}), ...(input.includeHeader === false ? { includeHeader: false } : {}) });
    const total = plan.parts.reduce((sum, part) => {
      if (typeof part === "string") return sum + Buffer.byteLength(part);
      const body = reading.resourceBodies.get(part.resource); if (!body) throw new TypeError("Resource byte evidence is missing for Markdown export");
      return sum + Buffer.byteLength(part.prefix) + Buffer.byteLength(part.suffix) + Math.ceil(body.bytes / 3) * 4;
    }, 0);
    const sourcePath = await resolveRecordPath(root, reading.evidence.conversation.path);
    const basename = path.basename(reading.evidence.conversation.path).replace(/\.json$/iu, ".md");
    input.onProgress?.(0, total);
    async function* payload() {
      for (const part of plan.parts) {
        input.signal?.throwIfAborted();
        if (typeof part === "string") { yield part; continue; }
        const body = reading.resourceBodies.get(part.resource);
        if (!body) throw new TypeError("Resource byte evidence is missing for Markdown export");
        yield part.prefix;
        yield* encodeBase64Chunks(streamRecordResource(sourcePath, body, input.signal), RESOURCE_BASE64_DECODED_CHUNK_BYTES, input.signal);
        yield part.suffix;
      }
    }
    const fingerprint = await writeOwnedStagingFile(Readable.from(payload()), stagedPath, { ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: (bytes: number) => input.onProgress!(bytes, total) } : {}) });
    if (fingerprint.bytes !== total) throw new TypeError("Markdown byte count differs from its stream plan");
    if ((await fingerprintFile(sourcePath, input.signal)).sha256 !== input.expectedConversation) throw new TypeError("Conversation changed during export");
    if (reading.evidence.mark && (await fingerprintFile(await resolveRecordPath(root, reading.evidence.mark.path), input.signal)).sha256 !== input.expectedMark) throw new TypeError("Mark changed during export");
    input.signal?.throwIfAborted();
    return { file: stagedPath, basename, fingerprint, messages: plan.messageCount, close: () => session.close(), ...(plan.selectedLeaf ? { selectedLeaf: plan.selectedLeaf } : {}) };
  });
  } catch (error) {
    try { await session.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Markdown preparation failed and temporary cleanup also needs attention"); }
    throw error;
  }
}

export async function exportRecordMarkdown(root: string, input: RecordMarkdownRequest) {
  const prepared = await prepareRecordMarkdown(root, input), maintenanceWarnings: string[] = []; let installed = false, failure: unknown;
  try {
    const exportsPath = await resolveRecordPath(root, "Exports"); await mkdir(exportsPath, { recursive: true });
    const filename = chooseNoReplaceLeaf(prepared.basename, new Set(await readdir(exportsPath)));
    input.signal?.throwIfAborted();
    await moveFileNoReplace(prepared.file, path.join(exportsPath, filename));
    installed = true;
    return { path: `Exports/${filename}`, filename, fingerprint: prepared.fingerprint, messages: prepared.messages, maintenanceWarnings, ...(prepared.selectedLeaf ? { selectedLeaf: prepared.selectedLeaf } : {}) };
  } catch (error) { failure = error; throw error;
  } finally {
    try { await prepared.close(); }
    catch (cleanup) {
      if (installed) maintenanceWarnings.push(cleanup instanceof Error ? cleanup.message : String(cleanup));
      else if (failure) throw new AggregateError([failure, cleanup], "Export failed and temporary cleanup also needs attention");
      else throw cleanup;
    }
  }
}
