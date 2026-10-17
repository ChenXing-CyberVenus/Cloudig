import { createHash } from "node:crypto";
import { open, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { parseRecordJson } from "../../core/records/index.mts";
import { validateContainerRecordSchema } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { resolveRecordPath, withRecordSnapshot } from "../storage/record-store.mts";
import { writeRecordProjection } from "../storage/record-projection.mts";
import { fingerprintFile } from "../storage/stream.mts";
import { streamTopLevelJsonArrayRanges, parseJsonRange } from "./json-array-stream.mts";
import { projectClaudeContainerRecord } from "./claude-container.mts";
import { claudeRecordSelector } from "./claude-export-record.mts";
import { extractClaudeRecord, fileCaptureTime } from "../../app/parser/record-source.mts";

export type RecordClaudeIndex = Readonly<{ schema: "cloudig/claude-index/1.0.0"; built_at?: string; source: Readonly<{ path: string; bytes: number; sha256: string }>; records: readonly JsonObject[] }>;
const indexPath = (sourcePath: string): string => `appdata/indexes/claude/${createHash("sha256").update(sourcePath).digest("hex")}.json`;
const sourcePath = (relative: string): string => {
  if (!relative.startsWith("Inbox/") || relative.split("/").length !== 2) throw new TypeError("Claude container must be a direct Inbox file"); return relative;
};
function validIndex(raw: unknown, relative: string): raw is RecordClaudeIndex {
  if (!isJsonObject(raw) || raw["schema"] !== "cloudig/claude-index/1.0.0" || !isJsonObject(raw["source"]) || !Array.isArray(raw["records"])) return false;
  const source = raw["source"], records = raw["records"];
  return source["path"] === relative && Number.isSafeInteger(source["bytes"]) && Number(source["bytes"]) > 0 && /^[a-f0-9]{64}$/u.test(String(source["sha256"]))
    && records.every(r => isJsonObject(r) && validateContainerRecordSchema(r).ok
      && Number.isSafeInteger(r["empty_messages"]) && Number(r["empty_messages"]) >= 0 && Number(r["empty_messages"]) <= Number(r["messages"]))
    && new Set(records.map(r => (r as JsonObject)["selector"])).size === records.length;
}

export async function indexRecordClaudeContainer(root: string, relative: string, options: Readonly<{
  signal?: AbortSignal; rebuild?: boolean; onProgress?: (event: Readonly<{ phase: "scan" | "record" | "ready"; bytes: number; total: number; records: number }>) => void;
}> = {}): Promise<Readonly<{ index: RecordClaudeIndex; reused: boolean }>> {
  sourcePath(relative);
  // Reading an Inbox container does not own Conversation/Mark writes. Keep the
  // shared lock only for the small projection publication, not the heavy scan.
    const absolute = await resolveRecordPath(root, relative), info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new TypeError("Claude container is not a regular file");
    let prior: RecordClaudeIndex | undefined;
    try { const value = parseRecordJson(await readFile(await resolveRecordPath(root, indexPath(relative)), "utf8")); if (validIndex(value, relative)) prior = value; }
    catch (e) { if (!(e instanceof SyntaxError || e instanceof TypeError || e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
    options.onProgress?.({ phase: "scan", bytes: 0, total: info.size, records: 0 });
    if (prior && !options.rebuild) {
      const current = await fingerprintFile(absolute, options.signal);
      if (current.sha256 === prior.source.sha256 && current.bytes === prior.source.bytes) {
        const index = prior.built_at ? prior : { ...prior, built_at: (await lstat(await resolveRecordPath(root, indexPath(relative)))).mtime.toISOString() };
        options.onProgress?.({ phase: "ready", bytes: current.bytes, total: current.bytes, records: prior.records.length }); return { index, reused: true };
      }
    }
    const handle = await open(absolute, "r"), digest = createHash("sha256"), records: JsonObject[] = [], selectors = new Set<string>(); let bytes = 0;
    try {
      async function* source() { for await (const raw of handle.createReadStream({ autoClose: false, highWaterMark: 512 * 1024 })) { options.signal?.throwIfAborted(); const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); digest.update(chunk); bytes += chunk.length; yield chunk; } }
      for await (const range of streamTopLevelJsonArrayRanges(Readable.from(source()), { ...(options.signal ? { signal: options.signal } : {}), onProgress: completed => options.onProgress?.({ phase: "scan", bytes: completed, total: info.size, records: records.length }) })) {
        const record = await parseJsonRange(absolute, range, options.signal ? { signal: options.signal } : {});
        const summary = projectClaudeContainerRecord(record.value, range.index + 1, range.offset, range.length, record.fingerprint.sha256);
        if (selectors.has(String(summary["selector"]))) throw new TypeError("Claude container has ambiguous duplicate record identities");
        selectors.add(String(summary["selector"])); records.push(summary);
        options.onProgress?.({ phase: "record", bytes: Math.min(bytes, info.size), total: info.size, records: records.length });
      }
    } finally { await handle.close(); }
    const fingerprint = { bytes, sha256: digest.digest("hex") }, after = await fingerprintFile(absolute, options.signal);
    if (after.sha256 !== fingerprint.sha256 || after.bytes !== fingerprint.bytes) throw new TypeError("Claude source changed during indexing");
    const index: RecordClaudeIndex = { schema: "cloudig/claude-index/1.0.0", built_at: new Date().toISOString(), source: { path: relative, ...fingerprint }, records };
    options.signal?.throwIfAborted(); await withRecordSnapshot(root, () => writeRecordProjection(root, indexPath(relative), JSON.stringify(index, null, 2) + "\n"));
    options.onProgress?.({ phase: "ready", bytes, total: bytes, records: records.length }); return { index, reused: false };
}

export async function extractIndexedClaudeRecord(root: string, index: RecordClaudeIndex, selector: string, signal?: AbortSignal) {
  sourcePath(index.source.path);
  const row = index.records.find(r => r["selector"] === selector); if (!row) throw new TypeError("Claude record is absent from this index");
  const absolute = await resolveRecordPath(root, index.source.path), parsed = await parseJsonRange(absolute, { index: Number(row["ordinal"]) - 1, offset: Number(row["offset"]), length: Number(row["length"]) }, signal ? { signal } : {});
  if (!isJsonObject(parsed.value) || typeof parsed.value["uuid"] !== "string" || parsed.fingerprint.sha256 !== row["item_sha256"] || claudeRecordSelector(parsed.value["uuid"]) !== selector) throw new TypeError("Claude record bytes changed; refresh its index");
  return extractClaudeRecord({ record: parsed.value, source: { file: path.basename(index.source.path), bytes: index.source.bytes, sha256: index.source.sha256 }, captured: await fileCaptureTime(absolute, index.source.sha256) });
}
