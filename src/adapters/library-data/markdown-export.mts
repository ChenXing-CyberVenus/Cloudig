import { readdir } from "node:fs/promises";
import { Readable } from "node:stream";

import { buildConversationMarkdown, type MarkdownExportLocale } from "../../app/export/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { resolveArchiveView, type BuiltinIdentity } from "../../core/library/overlay.mts";
import { openCanonicalConversationFile } from "../reader/index.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { chooseNoReplaceLeaf, safeWindowsLeaf } from "../storage/names.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { readCurrentAuthorityPair } from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";

export type MarkdownExportResult = Readonly<{
  status: "exported";
  filename: string;
  path: string;
  fingerprint: ByteFingerprint;
  messages: number;
  selectedLeaf?: string;
}> | Readonly<{
  status: "conflict";
  filename: string;
  path: string;
}>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function locale(library: JsonObject): MarkdownExportLocale {
  const preferences = library["preferences"];
  return preferences && typeof preferences === "object" && !Array.isArray(preferences) && preferences["language"] === "en"
    ? "en"
    : "zh-CN";
}

function conversationFilename(relativePath: string): string {
  const segments = relativePath.split("/");
  const filename = segments.at(-1);
  if (segments[0] !== "Conversations" || segments.length < 2 || !filename?.toLowerCase().endsWith(".json")) {
    throw new TypeError("Markdown export requires one exact Conversation JSON path");
  }
  return safeWindowsLeaf(filename, "Conversation filename");
}

export async function exportConversationMarkdown(input: Readonly<{
  libraryRoot: string;
  relativePath: string;
  expectedArchive: string;
  expectedGeneration: number;
  expectedFingerprint: ByteFingerprint;
  builtins: BuiltinIdentity;
  availableAssets: ReadonlySet<string>;
  transaction: string;
  timestamp: string;
  selectedLeaf?: string;
  branchChoices?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}>): Promise<MarkdownExportResult> {
  const writer = await acquireSingleWriter(input.libraryRoot);
  let file: Awaited<ReturnType<typeof openCanonicalConversationFile>> | undefined;
  try {
    throwIfAborted(input.signal);
    const sourceFilename = conversationFilename(input.relativePath);
    const absolute = await resolveManagedPath(input.libraryRoot, input.relativePath, { mustExist: true });
    file = await openCanonicalConversationFile({
      filePath: absolute,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
    });
    const conversation = file.index.conversation;
    if (
      conversation["archive"] !== input.expectedArchive
      || conversation["generation"] !== input.expectedGeneration
      || file.index.fingerprint.bytes !== input.expectedFingerprint.bytes
      || file.index.fingerprint.sha256 !== input.expectedFingerprint.sha256
    ) throw new TypeError("Archive capability no longer matches the selected Conversation");

    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    const resolved = resolveArchiveView(conversation, authority.library, input.builtins, input.availableAssets);
    const plan = buildConversationMarkdown({
      conversation,
      resolved,
      locale: locale(authority.library),
      ...(input.selectedLeaf ? { selectedLeaf: input.selectedLeaf } : {}),
      ...(input.branchChoices ? { branchChoices: input.branchChoices } : {})
    });
    const exports = await resolveManagedPath(input.libraryRoot, "Exports", { mustExist: true });
    const requested = sourceFilename.replace(/\.json$/iu, ".md");
    const filename = chooseNoReplaceLeaf(requested, new Set(await readdir(exports)));
    const relativePath = `Exports/${filename}`;

    async function* payload(): AsyncGenerator<Buffer> {
      if (!file) throw new TypeError("Conversation file is unavailable");
      for (const part of plan.parts) {
        throwIfAborted(input.signal);
        if (typeof part === "string") {
          yield Buffer.from(part, "utf8");
          continue;
        }
        yield Buffer.from(part.prefix, "utf8");
        for await (const chunk of file.encodedResourceChunks({
          resource: part.resource,
          ...(input.signal ? { signal: input.signal } : {})
        })) yield chunk;
        yield Buffer.from(part.suffix, "utf8");
      }
    }

    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "export-markdown",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: authority.library["revision"]!, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets: [{
        action: "create",
        path: relativePath,
        status: "planned",
        expected_before: { state: "missing" },
        semantic: { kind: "markdown_export" }
      }]
    };
    const staged = await stageJournalTargets(
      input.libraryRoot,
      journal,
      new Map([[0, Readable.from(payload())]]),
      input.signal
    );
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") return { status: "conflict", filename, path: relativePath };
    const target = await resolveManagedPath(input.libraryRoot, relativePath, { mustExist: true });
    const fingerprint = await fingerprintFile(target);
    const targetState = (committed["targets"] as JsonObject[])[0];
    const stagedAfter = targetState?.["staged_after"] as JsonObject | undefined;
    if (fingerprint.bytes !== stagedAfter?.["bytes"] || fingerprint.sha256 !== stagedAfter?.["sha256"]) {
      throw new TypeError("Markdown export bytes do not match the staged transaction");
    }
    await file.assertStable();
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Markdown export cleanup failed");
    return {
      status: "exported",
      filename,
      path: relativePath,
      fingerprint,
      messages: plan.messageCount,
      ...(plan.selectedLeaf ? { selectedLeaf: plan.selectedLeaf } : {})
    };
  } finally {
    await file?.close();
    await writer.release();
  }
}
