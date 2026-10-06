import { availableParallelism, freemem } from "node:os";
import { Worker } from "node:worker_threads";
import { mkdir, readFile, unlink, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import type { JsonObject } from "../../core/contracts/types.mts";
import type { RecordClaudeIndex } from "../../adapters/parser/record-claude-index.mts";
import type { RecordOfficialIndex } from "../../adapters/parser/record-official-index.mts";
import { resolveRecordPath } from "../../adapters/storage/record-store.mts";
import { createRuntimeCacheSession } from "../../adapters/storage/runtime-cache.mts";
import { officialCompanionBytes } from "../../adapters/parser/official-json-assets.mts";
import { prepareOfficialZipWorkspace, splitZipRecordSelector, type ZipWorkspace } from "../../adapters/parser/official-zip.mts";
import type { AgentFamily } from "../../adapters/parser/agent-json.mts";

export const RECORD_PARSER_LIMITS = Object.freeze({ maxWorkers: 6, reservedCpus: 2, memoryPerWorker: 1536 * 1024 ** 2,
  maxAdmissionBytes: 512 * 1024 ** 2, minimumAdmissionBytes: 32 * 1024 ** 2, sourceExpansion: 8, minimumJobBytes: 8 * 1024 ** 2, progressIntervalMs: 80 });
export function recordParserParallelism(logical = availableParallelism(), free = freemem()): number {
  return Math.max(1, Math.min(RECORD_PARSER_LIMITS.maxWorkers, logical - RECORD_PARSER_LIMITS.reservedCpus, Math.floor(free / RECORD_PARSER_LIMITS.memoryPerWorker)));
}
export type RecordParseJob = Readonly<{ sourcePath: string; official?: RecordOfficialIndex; zipWorkspace?: ZipWorkspace; claude?: Readonly<{ source: RecordClaudeIndex["source"]; record: JsonObject }>; agent?: Readonly<{ family: AgentFamily; format: "json" | "jsonl"; source: Readonly<{ bytes: number; sha256: string }>; shards?: readonly string[] }> }>;
export const recordJobSelector = (job: RecordParseJob): string | undefined => {
  const value = (job.official?.records[0] ?? job.claude?.record)?.["selector"];
  return typeof value === "string" ? value : undefined;
};
export type PreparedRecord = Readonly<{ conversation: JsonObject; errors: readonly JsonObject[] }>;
export type RecordWorkerProgress = Readonly<{ phase: string; completed: number; total: number }>;
export type RecordWorkerOutcome = Readonly<{ index: number }> & ({ prepared: PreparedRecord } | { error: Error });
type Work = { index: number; job: RecordParseJob; cost: number };
type Message = { type: "result"; index: number; sha256: string; bytes: number; threadId: number } | { type: "error"; index: number; error: { name: string; message: string } };
type Slot = { worker: Worker; work?: Work; ready?: Promise<Message>; finish?: (m: Message) => void };

/** Only runs after confirmation. At most one ready spool per worker, consumed before dispatching another. */
export async function* prepareRecordJobs(root: string, jobs: readonly RecordParseJob[], options: Readonly<{
  parserVersion: string; timestamp: string; signal?: AbortSignal; workers?: number;
  onProgress?: (index: number, event: RecordWorkerProgress) => void;
  onMetrics?: (value: Readonly<{ workers: number; maxActive: number; prepared: number; spoolBytes: number; threadIds: number[] }>) => void;
}>): AsyncGenerator<RecordWorkerOutcome> {
  if (options.workers !== undefined && (!Number.isSafeInteger(options.workers) || options.workers < 1)) throw new RangeError("Worker count must be positive");
  const seen = new Set<string>(), work: Work[] = [], early: RecordWorkerOutcome[] = [], companionBudgets = new Map<string, number>();
  for (const [index, job] of jobs.entries()) {
    const selectedRecord = job.official?.records[0] ?? job.claude?.record;
    const key = `${job.sourcePath}\0${selectedRecord?.["selector"] ?? "html"}`;
    if (seen.has(key)) throw new TypeError("The same source record cannot be parsed twice in one batch"); seen.add(key);
    try {
      if (!/^Inbox\/[^/\\]+$/u.test(job.sourcePath)) throw new TypeError("Parser source must be a direct Inbox file");
      if (job.claude && job.claude.source.path !== job.sourcePath) throw new TypeError("Claude index belongs to another source");
      if (job.official && (job.claude || job.agent || job.official.source.path !== job.sourcePath || job.official.records.length !== 1)) throw new TypeError("Official job needs exactly one record in its own source");
      const file = await resolveRecordPath(root, job.sourcePath), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new TypeError("Parser source must be an ordinary file");
      const bytes = selectedRecord ? Number(selectedRecord["length"]) : job.agent?.source.bytes ?? info.size;
      if (!Number.isSafeInteger(bytes) || bytes < 1) throw new TypeError("Source range has invalid length");
      let companionBytes = 0;
      if (job.official?.schema === "cloudig/official-zip-index/1.0.0") companionBytes = job.official.resource_bytes_by_record?.[String(selectedRecord?.["selector"])] ?? job.official.resource_bytes;
      else if (job.official && job.official.schema !== "cloudig/claude-index/1.0.0") {
        if (!companionBudgets.has(job.sourcePath)) companionBudgets.set(job.sourcePath, await officialCompanionBytes(root, job.sourcePath));
        companionBytes = companionBudgets.get(job.sourcePath)!;
      }
      // JSON range size alone omits companion images/documents. A conservative
      // per-source estimate is cached once; a large unit still runs exclusively.
      work.push({ index, job, cost: Math.max(RECORD_PARSER_LIMITS.minimumJobBytes, (bytes + companionBytes) * RECORD_PARSER_LIMITS.sourceExpansion) });
    } catch (e) { early.push({ index, error: e instanceof Error ? e : new Error(String(e)) }); }
  }
  for (const outcome of early) { options.signal?.throwIfAborted(); yield outcome; }
  if (!work.length) return;
  const cache = await resolveRecordPath(root, "cache"), session = await createRuntimeCacheSession(cache, await realpath(root));
  const directory = path.join(session.root, "Parser");
  const slots: Slot[] = [], metrics = { workers: Math.min(work.length, options.workers ?? recordParserParallelism(), recordParserParallelism()), maxActive: 0, prepared: 0, spoolBytes: 0, threadIds: [] as number[] };
  const admission = Math.max(RECORD_PARSER_LIMITS.minimumAdmissionBytes, Math.min(RECORD_PARSER_LIMITS.maxAdmissionBytes, freemem() / 8));
  let next = 0, activeBytes = 0, closing = false, callbackError: unknown;
  const abort = () => { for (const slot of slots) if (slot.work) slot.finish?.({ type: "error", index: slot.work.index, error: { name: "AbortError", message: "Parser cancelled" } }); };
  const dispatch = () => {
    for (const slot of slots) {
      if (slot.work || next >= work.length) continue;
      const job = work[next]!;
      if (activeBytes > 0 && activeBytes + job.cost > admission) continue;
      next++; activeBytes += job.cost; slot.work = job;
      slot.ready = new Promise(resolve => { slot.finish = resolve; });
      slot.worker.postMessage({ root, directory, ...job, parserVersion: options.parserVersion, timestamp: options.timestamp, progressIntervalMs: RECORD_PARSER_LIMITS.progressIntervalMs });
    }
    metrics.maxActive = Math.max(metrics.maxActive, slots.filter(s => s.work).length);
  };
  try {
    await mkdir(directory);
    // One decompression per selected JSON member for this whole batch, never
    // one full Grok JSON expansion per conversation/worker.
    const zipGroups = new Map<string, Work[]>();
    for (const item of work) if (item.job.official?.schema === "cloudig/official-zip-index/1.0.0") { const group = zipGroups.get(item.job.sourcePath) ?? []; group.push(item); zipGroups.set(item.job.sourcePath, group); }
    for (const [source, group] of zipGroups) {
      const index = group[0]!.job.official!;
      try {
        const names = group.map(item => splitZipRecordSelector(String(item.job.official!.records[0]!["selector"])).entry);
        const workspace = await prepareOfficialZipWorkspace(await resolveRecordPath(root, source), index.source, names,
          path.join(directory, createHash('sha256').update(source).digest('hex')), options.signal,
          (completed, total) => options.onProgress?.(group[0]!.index, { phase: 'unpack', completed, total }));
        for (const item of group) item.job = { ...item.job, zipWorkspace: workspace };
      } catch (e) {
        options.signal?.throwIfAborted();
        for (const item of group) { work.splice(work.indexOf(item), 1); yield { index: item.index, error: e instanceof Error ? e : new Error(String(e)) }; }
      }
    }
    metrics.workers = Math.min(metrics.workers, work.length); if (!work.length) return;
    const url = new URL(import.meta.url.endsWith(".mts") ? "./record-worker-entry.mts" : "./record-parser-worker.mjs", import.meta.url);
    for (let i = 0; i < metrics.workers; i++) {
      const slot: Slot = { worker: new Worker(url, { name: `cloudig-record-parser-${i + 1}` }) }; slots.push(slot);
      slot.worker.on("message", message => {
        if (closing || !slot.work || message.index !== slot.work.index) return;
        if (message.type === "progress") { try { options.onProgress?.(message.index, message.progress); } catch (e) { callbackError = e; abort(); } }
        else slot.finish?.(message as Message);
      });
      slot.worker.on("error", error => { if (!closing) { callbackError = error; abort(); } });
      slot.worker.on("exit", code => { if (!closing) { callbackError = new Error(`Parser worker exited (${code})`); abort(); } });
    }
    options.signal?.addEventListener("abort", abort, { once: true }); options.signal?.throwIfAborted(); dispatch();
    while (slots.some(s => s.work)) {
      const { slot, message } = await Promise.race(slots.filter(s => s.work).map(async slot => ({ slot, message: await slot.ready! })));
      options.signal?.throwIfAborted(); if (callbackError) throw callbackError;
      let outcome: RecordWorkerOutcome;
      if (message.type === "error") {
        const e = message.error; const error = e.name === "TypeError" ? new TypeError(e.message) : e.name === "SyntaxError" ? new SyntaxError(e.message) : new Error(e.message);
        error.name = e.name; outcome = { index: message.index, error };
      } else {
        const file = path.join(directory, `${message.index}.bin`), bytes = await readFile(file);
        if (bytes.length !== message.bytes || createHash("sha256").update(bytes).digest("hex") !== message.sha256) throw new TypeError("Prepared Parser bytes changed");
        const prepared = deserialize(bytes) as PreparedRecord; await unlink(file);
        metrics.prepared++; metrics.spoolBytes += bytes.length; if (!metrics.threadIds.includes(message.threadId)) metrics.threadIds.push(message.threadId);
        outcome = { index: message.index, prepared };
      }
      yield outcome;
      options.signal?.throwIfAborted(); if (callbackError) throw callbackError;
      activeBytes -= slot.work!.cost; delete slot.work; delete slot.ready; delete slot.finish; dispatch();
    }
  } finally {
    closing = true; options.signal?.removeEventListener("abort", abort); await Promise.all(slots.map(s => s.worker.terminate()));
    await session.close(); options.onMetrics?.(metrics);
  }
}
