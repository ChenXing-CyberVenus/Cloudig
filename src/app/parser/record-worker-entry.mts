import { parentPort, threadId } from "node:worker_threads";
import { serialize } from "node:v8";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { extractHtmlRecord } from "./record-source.mts";
import { assembleConversationRecord } from "./conversation-record.mts";
import { extractIndexedClaudeRecord } from "../../adapters/parser/record-claude-index.mts";
import { extractIndexedOfficialRecord } from "../../adapters/parser/record-official-index.mts";
import { resolveRecordPath } from "../../adapters/storage/record-store.mts";
import { extractAgentRecord } from "../../adapters/parser/agent-json.mts";
import type { RecordParseJob, PreparedRecord } from "./record-workers.mts";

if (!parentPort) throw new Error("Parser worker requires its private parent channel");
const port = parentPort;
port.on("message", async (input: { root: string; directory: string; index: number; job: RecordParseJob; parserVersion: string; timestamp: string; progressIntervalMs: number }) => {
  let last = 0, lastPhase = "";
  const progress = (phase: string, completed: number, total: number) => {
    const now = performance.now(); if (phase === lastPhase && completed !== total && now - last < input.progressIntervalMs) return;
    last = now; lastPhase = phase; port.postMessage({ type: "progress", index: input.index, progress: { phase, completed, total } });
  };
  try {
    const job = input.job;
    const extracted = job.official
      ? await extractIndexedOfficialRecord(input.root, job.official, String(job.official.records[0]!["selector"]), undefined, job.zipWorkspace)
      : job.claude
      ? await extractIndexedClaudeRecord(input.root, { schema: "cloudig/claude-index/1.0.0", source: job.claude.source, records: [job.claude.record] }, String(job.claude.record["selector"]))
      : job.agent
      ? await extractAgentRecord({ filePath: await resolveRecordPath(input.root, job.sourcePath), ...(job.agent.shards ? { shards: await Promise.all(job.agent.shards.map(shard => resolveRecordPath(input.root, shard))) } : {}), source: { file: path.basename(job.sourcePath), ...job.agent.source }, format: job.agent.format, family: job.agent.family, onProgress: (phase, completed, total) => progress(phase, completed, total) })
      : await extractHtmlRecord({ filePath: await resolveRecordPath(input.root, job.sourcePath), temporaryRoot: input.directory, onProgress: progress });
    const prepared: PreparedRecord = { conversation: assembleConversationRecord({ ...extracted, parserVersion: input.parserVersion, timestamp: input.timestamp }), errors: extracted.parsed.systemLogErrors ?? [] };
    const bytes = serialize(prepared); await writeFile(path.join(input.directory, `${input.index}.bin`), bytes, { flag: "wx", mode: 0o600 });
    port.postMessage({ type: "result", index: input.index, threadId, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  } catch (e) { port.postMessage({ type: "error", index: input.index, error: { name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) } }); }
});
