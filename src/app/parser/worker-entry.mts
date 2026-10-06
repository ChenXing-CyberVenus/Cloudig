import { parentPort, threadId } from "node:worker_threads";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { serialize } from "node:v8";
import { parseExporterHtmlToDraft } from "./host.mts";
import { verifyBase64Chunks, RESOURCE_BASE64_DECODED_CHUNK_BYTES } from "../../adapters/storage/stream.mts";
import { isJsonObject } from "../../core/contracts/types.mts";

if (!parentPort) throw new Error("Parser worker requires its private parent channel");
const port = parentPort;
port.on("message", async (job: { index: number; file: string; spool: string; temporaryRoot: string; threshold?: number }) => {
  let lastPhase = "", lastProgress = 0;
  try {
    const parsed = await parseExporterHtmlToDraft({
      filePath: job.file,
      temporaryRoot: job.temporaryRoot,
      ...(job.threshold === undefined ? {} : { jsonScriptMemoryThresholdBytes: job.threshold }),
      onProgress: progress => {
        const now = performance.now();
        if (progress.phase === lastPhase && progress.completed !== progress.total && now - lastProgress < 80) return;
        lastPhase = progress.phase; lastProgress = now;
        port.postMessage({ type: "progress", index: job.index, progress, rss: process.memoryUsage().rss });
      }
    });
    // V8's binary encoding avoids sending large Base64 strings through the
    // parent channel, and avoids parsing this source again after preview.
    const verifiedResources: Record<string, { bytes: number; sha256: string }> = {};
    for (const resource of Array.isArray(parsed.draft["resources"]) ? parsed.draft["resources"] : []) {
      if (!isJsonObject(resource) || resource["availability"] !== "embedded") continue;
      const id = resource["id"], count = resource["bytes"], sha256 = resource["sha256"], chunks = resource["data_base64"];
      if (typeof id !== "string" || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || typeof sha256 !== "string") throw new TypeError("Embedded resource metadata is invalid");
      if (count === 0) {
        if (chunks !== undefined || sha256 !== createHash("sha256").digest("hex")) throw new TypeError("Zero-byte resource is not canonical");
        continue;
      }
      if (id in verifiedResources || !Array.isArray(chunks) || chunks.length === 0 || chunks.some(chunk => typeof chunk !== "string")) throw new TypeError("Embedded resource body is invalid");
      async function* encoded(): AsyncGenerator<string> { for (const chunk of chunks as string[]) yield chunk; }
      verifiedResources[id] = await verifyBase64Chunks(encoded(), { bytes: count, sha256 }, RESOURCE_BASE64_DECODED_CHUNK_BYTES);
    }
    const prepared = { ...parsed, verifiedResources };
    const bytes = serialize(prepared);
    await writeFile(job.spool, bytes, { flag: "wx", mode: 0o600 });
    port.postMessage({
      type: "result", index: job.index, threadId, rss: process.memoryUsage().rss,
      fingerprint: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      preview: {
        parsed: { ...parsed, draft: { source: parsed.draft["source"], platform: parsed.draft["platform"], title: parsed.draft["title"] }, systemLogErrors: [] },
        messages: Array.isArray(parsed.draft["messages"]) ? parsed.draft["messages"].length : 0,
        resources: Array.isArray(parsed.draft["resources"]) ? parsed.draft["resources"].length : 0
      }
    });
  } catch (error) {
    port.postMessage({ type: "error", index: job.index, threadId, error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
  }
});
