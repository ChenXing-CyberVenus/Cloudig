import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalLibrary } from "../src/adapters/library-data/index.mts";
import { ArchiverEngineCommands } from "../src/engine/archiver-commands.mts";
import { assertIpcValue } from "../src/engine/protocol.mts";
import { createRuntimeCacheSession } from "../src/adapters/storage/runtime-cache.mts";

const args = process.argv.slice(2);
const source = path.resolve(args[0] ?? "../Cloudig-Test/Library/Inbox/conversations.json");
const output = path.resolve(args[1] ?? "artifacts/v1-release/evidence/claude-index-timing.json");
const temporary = path.resolve("tmp");
await mkdir(temporary, { recursive: true });
const base = await mkdtemp(path.join(temporary, "v1-claude-index-"));
const root = path.join(base, "Library");
const cache = await createRuntimeCacheSession(path.join(base, "cache"), root);
const evidence = { schema: "cloudig/claude-index-timing/1.0.0", layer: "source-engine-command-and-ipc-validation", input_bytes: (await stat(source)).size, user_library_touched: false, runs: [] };
try {
  await createLocalLibrary({ root, transaction: "x_CLAUDEINDEXBENCH", timestamp: "2026-09-08T10:00:00.000Z", localDate: "2026-09-08", offset: "-07:00", language: "zh-CN" });
  await copyFile(source, path.join(root, "Inbox/conversations.json"));
  const commands = new ArchiverEngineCommands({ libraryRoot: root, runtimeRoot: cache.root });
  const handlers = commands.handlers();
  let progress = 0;
  const context = { request: "q_benchmark", signal: new AbortController().signal, emit: async value => { assertIpcValue(value); progress += 1; } };
  const queried = await handlers["archiver.sources.query"]({ offset: 0, limit: 200 }, context);
  const selected = queried.items.find(item => item.filename === "conversations.json");
  assert.ok(selected);
  for (const temperature of ["cold", "warm"]) {
    const start = performance.now();
    progress = 0;
    const indexed = await handlers["archiver.claude.index"]({ source: selected.capability }, context);
    assertIpcValue(indexed);
    const indexedAt = performance.now();
    const listed = await handlers["archiver.claude.records.query"]({ container: indexed.container, offset: 0, limit: 200 }, context);
    let ipc_error = null;
    try { assertIpcValue(listed); } catch (error) { ipc_error = error.message; }
    evidence.runs.push({ temperature, index_ms: indexedAt - start, query_ms: performance.now() - indexedAt, status: indexed.status, records: indexed.records, returned: listed.items.length, progress, ipc_error });
  }
  const indexFolders = await import("node:fs/promises").then(fs => fs.readdir(path.join(root, "Data/Indexes/Containers")));
  const projection = indexFolders.find(name => /^[a-f0-9]{64}$/.test(name));
  const state = JSON.parse(await readFile(path.join(root, "Data/Indexes/Containers", projection, "state.json"), "utf8"));
  evidence.source_sha256 = state.source.sha256;
  evidence.records_sha256 = state.records.sha256;
  evidence.peak_rss_bytes = process.resourceUsage().maxRSS * 1024;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally { await cache.close(); await rm(base, { recursive: true, force: true }); }
