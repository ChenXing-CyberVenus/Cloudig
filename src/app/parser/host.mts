import path from "node:path";
import { setImmediate } from "node:timers/promises";

import type { ParsedSourceDraft } from "./adapter.mts";
import { readExporterEnvelope } from "../../adapters/parser/html-envelope.mts";
import { captureDiagnosticErrors, canonicalDiagnosticErrors } from "./diagnostics.mts";
export { parserErrorMessage } from "./diagnostics.mts";

export async function parseExporterHtmlToDraft(input: Readonly<{
  filePath: string;
  temporaryRoot?: string;
  fileSystemCapturedAt?: string;
  jsonScriptMemoryThresholdBytes?: number;
  onProgress?: (event: Readonly<{
    phase: "fingerprint" | "extract" | "normalize";
    completed: number;
    total: number;
  }>) => void;
  signal?: AbortSignal;
}>): Promise<ParsedSourceDraft> {
  const envelope = await readExporterEnvelope({
    filePath: input.filePath,
    ...(input.temporaryRoot ? { temporaryRoot: input.temporaryRoot } : {}),
    ...(input.jsonScriptMemoryThresholdBytes === undefined ? {} : { jsonScriptMemoryThresholdBytes: input.jsonScriptMemoryThresholdBytes }),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? {
      onProgress: (phase, completed, total) => input.onProgress?.({ phase, completed, total })
    } : {})
  });
  input.signal?.throwIfAborted();
  const draft = await envelope.adapter.parse({
    manifest: envelope.manifest,
    payload: envelope.payload,
    source: {
      file: path.basename(input.filePath),
      ...envelope.fingerprint,
      ...(input.fileSystemCapturedAt ? { fileSystemCapturedAt: input.fileSystemCapturedAt } : {})
    },
    reading: envelope.reading,
    onProgress: async (completed, total) => {
      input.onProgress?.({ phase: "normalize", completed, total });
      await setImmediate();
      input.signal?.throwIfAborted();
    }
  });
  return {
    draft,
    adapter: envelope.adapter.manifest,
    sourceFingerprint: envelope.fingerprint,
    systemLogErrors: [...captureDiagnosticErrors(envelope.manifest), ...canonicalDiagnosticErrors(draft)]
  };
}
