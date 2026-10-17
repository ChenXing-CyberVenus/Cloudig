import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir, lstat, realpath, rm, utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { RecordSourceReads, commitRecords } from "../../../src/adapters/storage/record-store.mts";
import { runRecordParseBatch, type RecordBatchProgress } from "../../../src/app/parser/record-batch.mts";
import { recordParserParallelism, prepareRecordJobs } from "../../../src/app/parser/record-workers.mts";
import { indexRecordClaudeContainer } from "../../../src/adapters/parser/record-claude-index.mts";
import { decodeRecord } from "../../../src/core/records/index.mts";
import { readRecordSystemLog } from "../../../src/adapters/library-data/record-system-log.mts";

const base = path.resolve("tests/private/schema-rebuild"), fixture = path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), timestamp = "2026-09-11T20:00:00Z";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-batch-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained batch test: ${root}`); }
}
async function noSpools(root: string) { assert.deepEqual(await readdir(path.join(root, "cache/Engine")), []); }

test("worker admission uses hardware headroom without making it an input size limit", () => {
  assert.equal(recordParserParallelism(1, 100), 1); assert.equal(recordParserParallelism(32, 64 * 1024 ** 3), 6); assert.equal(recordParserParallelism(8, 3 * 1024 ** 3), 2);
});

test("confirmed batch uses workers, reports progress, preserves distinct filenames and collects individual failures", async () => temporary(async root => {
  const files = ["First (1).html", "First (2).html", "Broken.html"];
  for (const file of files.slice(0, 2)) await copyFile(fixture, path.join(root, "Inbox", file));
  await writeFile(path.join(root, "Inbox/Broken.html"), "<html>not an exporter</html>");
  const events: RecordBatchProgress[] = [], metrics: unknown[] = [];
  const result = await runRecordParseBatch(root, files.map(name => ({ sourcePath: `Inbox/${name}` })), { parserVersion: "1.1.0", timestamp, workers: 2, onProgress: event => events.push(event), onWorkerMetrics: value => metrics.push(value) });
  assert.equal(result.state, "completed"); assert.deepEqual(result.items.map(i => i.status), ["created", "created", "failed"]);
  assert.deepEqual(result.maintenanceWarnings, []); assert.equal(((await readRecordSystemLog(root))["files"] as Array<Record<string, unknown>>)[0]!["path"], "Inbox/Broken.html");
  assert.equal(events[0]!.phase, "start"); assert.equal(events.at(-1)!.phase, "done"); assert.equal(events.at(-1)!.completed, 3);
  assert(events.some(e => e.phase === "extract") && events.some(e => e.phase === "commit"));
  const titles: string[] = [], ids: string[] = [];
  for (const item of result.items) if ("path" in item) {
    const record = decodeRecord("conversation", await readFile(path.join(root, item.path))); assert(record.ok);
    titles.push(String((record.value["title"] as Record<string, unknown>)["filename"])); ids.push(String(record.value["conversation_id"]));
  }
  assert.deepEqual(titles, ["First (1)", "First (2)"]); assert.equal(new Set(ids).size, 2); assert.equal(result.sourceChecks.hashes, 2); assert(result.sourceChecks.reused >= 2); assert.equal(metrics.length, 1); await noSpools(root);
}));

test("many records from one Claude container hash the source once per batch, not once per conversation", async () => temporary(async root => {
  const records = Array.from({ length: 4 }, (_, i) => ({ uuid: `record-${i}`, name: `Claude ${i}`, chat_messages: [{ uuid: `m${i}`, sender: "assistant", text: "Automatic message" }] }));
  const file = path.join(root, "Inbox/conversations.json"), original = JSON.stringify(records); await writeFile(file, original);
  const { index } = await indexRecordClaudeContainer(root, "Inbox/conversations.json");
  const result = await runRecordParseBatch(root, index.records.map(record => ({ sourcePath: index.source.path, claude: { source: index.source, record } })), { parserVersion: "1.1.0", timestamp, workers: 2 });
  assert.equal(result.items.filter(i => i.status === "created").length, 4); assert.equal(result.sourceChecks.hashes, 1); assert.equal(result.sourceChecks.reused, 7);
  assert.equal(await readFile(file, "utf8"), original); await noSpools(root);
}));

test("source read memo invalidates external changes even when mtime is restored, and never shortcuts write targets", async () => temporary(async root => {
  const source = "Inbox/source.html", file = path.join(root, source), reads = new RecordSourceReads(); await writeFile(file, "old"); const info = await lstat(file);
  const guard = [{ path: source, expected: sha("old") }];
  await commitRecords(root, [{ action: "binary", path: "appdata/one.json", expected: null, data: Buffer.from("one") }], { reads: guard, sourceReads: reads });
  await writeFile(file, "new"); await utimes(file, info.atime, info.mtime);
  await assert.rejects(commitRecords(root, [{ action: "binary", path: "appdata/two.json", expected: null, data: Buffer.from("two") }], { reads: guard, sourceReads: reads }), /dependency changed/);
  assert.equal(reads.metrics.hashes, 2);
  await writeFile(file, "old"); await writeFile(path.join(root, "appdata/one.json"), "external");
  await assert.rejects(commitRecords(root, [{ action: "binary", path: "appdata/one.json", expected: sha("one"), data: Buffer.from("changed") }], { reads: guard, sourceReads: reads }), /Target changed/);
}));

test("cancellation after one save keeps it and retires workers and their cache without parsing the remaining files", async () => temporary(async root => {
  const jobs = Array.from({ length: 4 }, (_, i) => ({ sourcePath: `Inbox/${i}.html` })); for (const job of jobs) await copyFile(fixture, path.join(root, job.sourcePath));
  const controller = new AbortController();
  const result = await runRecordParseBatch(root, jobs, { parserVersion: "1.1.0", timestamp, workers: 1, signal: controller.signal, onProgress: event => { if (event.phase === "item_done") controller.abort(); } });
  assert.equal(result.state, "cancelled"); assert.equal(result.items.filter(i => i.status === "created").length, 1); assert.equal(result.items.filter(i => i.status === "not_started").length, 3); await noSpools(root);
}));

test("duplicate record jobs are rejected before worker cache or output creation", async () => temporary(async root => {
  await copyFile(fixture, path.join(root, "Inbox/one.html"));
  await assert.rejects(async () => { for await (const _ of prepareRecordJobs(root, [{ sourcePath: "Inbox/one.html" }, { sourcePath: "Inbox/one.html" }], { parserVersion: "1.1.0", timestamp })) {} }, /twice/);
  assert.deepEqual(await readdir(path.join(root, "cache")), []); assert.deepEqual(await readdir(path.join(root, "Conversations")), []);
}));

const sample = process.env["CLOUDIG_RECORD_SAMPLE"];
test("latest real HTML set through worker extraction and new-record persistent batch", { skip: !sample }, async () => temporary(async root => {
  const names = (await readdir(sample!)).filter(name => /\.html?$/iu.test(name)).sort(); assert(names.length > 0);
  for (const name of names) await copyFile(path.join(sample!, name), path.join(root, "Inbox", name));
  const started = performance.now(); let metrics: unknown;
  const result = await runRecordParseBatch(root, names.map(name => ({ sourcePath: `Inbox/${name}` })), { parserVersion: "1.1.0", timestamp, onWorkerMetrics: value => { metrics = value; } });
  assert.equal(result.items.filter(i => i.status === "created").length, names.length, JSON.stringify(result.items.filter(i => i.status !== "created")));
  console.log(JSON.stringify({ record_batch: { files: names.length, elapsedMs: performance.now() - started, sourceChecks: result.sourceChecks, workers: metrics } })); await noSpools(root);
}));

const official = process.env["CLOUDIG_RECORD_CLAUDE_ALL"];
test("complete real Claude export through new-record worker batch", { skip: !official }, async () => temporary(async root => {
  const sourcePath = "Inbox/conversations.json"; await copyFile(official!, path.join(root, sourcePath));
  const { index } = await indexRecordClaudeContainer(root, sourcePath), started = performance.now(); let metrics: unknown;
  const result = await runRecordParseBatch(root, index.records.map(record => ({ sourcePath, claude: { source: index.source, record } })), { parserVersion: "1.1.0", timestamp, onWorkerMetrics: value => { metrics = value; } });
  assert.equal(result.state, "completed"); assert.equal(result.items.filter(i => i.status === "created").length, index.records.length, JSON.stringify(result.items.filter(i => i.status !== "created"))); assert.deepEqual(result.maintenanceWarnings, []);
  console.log(JSON.stringify({ claude_record_batch: { sourceBytes: index.source.bytes, records: index.records.length, elapsedMs: performance.now() - started, sourceChecks: result.sourceChecks, workers: metrics } })); await noSpools(root);
}));
