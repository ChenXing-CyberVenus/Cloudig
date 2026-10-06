#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ENGINE_PROTOCOL } from "../src/engine/protocol.mts";
import { hashInputs } from "./v1-release-preflight.mjs";
import { startRecordEngine } from "./record-engine-client.mjs";
import { journeyPackageFingerprint } from "./run-v1-real-library-evidence.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = "artifacts/v1-release/evidence/benchmark.json";
const repetitions = 9;
const diskBytes = 16 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("percentile requires samples");
  if (!(quantile > 0 && quantile <= 1)) throw new Error("percentile quantile must be in (0, 1]");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(values, unit) {
  return {
    unit,
    samples: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values)
  };
}

function workingSetBytes(pid) {
  if (process.platform !== "win32") return null;
  const command = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`cannot measure Engine working set: ${result.stderr}`);
  const value = Number(result.stdout.trim());
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid Engine working set: ${result.stdout.trim()}`);
  return value;
}

function peakWorkingSetBytes(pid) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).PeakWorkingSet64`], { encoding: "utf8", windowsHide: true });
  const bytes = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Cannot measure Engine peak working set");
  return bytes;
}

// One finite protocol session. Events are not replies; every request has a bound.
async function parseCycle(node, engine, cwd, library, source, cancel) {
  await mkdir(library, { recursive: true });
  const child = spawn(node, [engine, "--library-root", library, "--cache-root", path.join(library, "cache")], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let stderr = "", ordinal = 0, progressEvents = 0, cancelledAt = null, target = null, cancelTask = null;
  let firstProgress = null;
  const started = performance.now();
  const failPending = error => { for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); } pending.clear(); };
  const ended = new Promise(resolve => child.once("exit", (code, signal) => { failPending(new Error(`Engine exited: ${code}/${signal}`)); resolve({ code, signal }); }));
  child.on("error", failPending);
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr = (stderr + value).slice(-16000); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (command, payload = {}, request = `q_bench_${++ordinal}`) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(request); reject(new Error(`Benchmark timed out: ${command}`)); child.kill(); }, 180000);
    pending.set(request, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ protocol: ENGINE_PROTOCOL, kind: "request", request, command, payload }) + "\n");
  });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      if (message.kind === "event") {
        if (message.request === target) {
          if (message.event?.bytes?.completed > 0) { progressEvents++; firstProgress ??= performance.now(); }
          const cancelHere = cancel === "normalize"
            ? message.event?.phase === "normalize" && message.event?.items?.completed > 0
            : cancel === true && message.event?.bytes?.completed > 0;
          if (cancelHere && cancelledAt === null) { cancelledAt = performance.now(); cancelTask = send("engine.cancel", { target }); }
        }
        return;
      }
      const wait = pending.get(message.request); if (!wait) return;
      pending.delete(message.request); clearTimeout(wait.timer);
      if (message.ok === false) wait.reject(new Error(JSON.stringify(message.error))); else wait.resolve(message.result);
    } catch (error) { failPending(error); }
  });
  try {
    await send("engine.handshake"); await send("library.startup.recover"); await send("library.create");
    await copyFile(source, path.join(library, "Inbox", "capacity-sample.html"));
    const listed = await send("archiver.sources.query", { offset: 0, limit: 200 });
    if (listed.items.length !== 1) throw new Error("Capacity source was not listed");
    const plan = await send("archiver.parse.plan", { sources: [listed.items[0].capability] });
    target = `q_parse_${++ordinal}`;
    const parsingAt = performance.now();
    const result = await send("archiver.parse.commit", { plan: plan.plan }, target);
    const finished = performance.now();
    if (cancelTask) await cancelTask;
    const expected = cancel ? "cancelled" : "completed";
    if (result.state !== expected || !progressEvents || (!cancel && result.items[0]?.status !== "created")) throw new Error(`Capacity ${expected} check failed: ${JSON.stringify(result)}`);
    const archives = await send("reader.archives.query", { offset: 0, limit: 200 });
    if (archives.items.length !== (cancel ? 0 : 1)) throw new Error("Cancellation/publication boundary failed");
    let reader = null;
    if (!cancel) {
      const readStarted = performance.now();
      const request = { messages: { offset: 0, limit: 200 }, navigation: { offset: 0, limit: 500 }, branches: { offset: 0, limit: 200 } };
      const view = await send("reader.view.open", { archive: archives.items[0].capability, request });
      const runtime = (await send("engine.storage")).runtime_root;
      let page = view.page, count = 0, pages = 0, total = 0;
      for (;;) {
        if (!/^\/v_[A-Za-z0-9_-]{43}\/pages\/p_[A-Za-z0-9_-]{43}\.json$/u.test(page.virtual_path)) throw new Error("Unexpected runtime page capability");
        const file = path.join(runtime, "Views", ...page.virtual_path.slice(1).split("/"));
        const value = JSON.parse(await readFile(file, "utf8"));
        count += value.messages.length; pages++; total = value.pagination.total_visible;
        if (!value.pagination.has_next) break;
        if (!value.messages.length || pages > 1000) throw new Error("Reader capacity pagination made no progress");
        request.messages.offset = count;
        page = await send("reader.view.page", { view: view.token, request });
      }
      if (count !== total) throw new Error("Reader capacity pages lost messages");
      await send("reader.view.close", { view: view.token });
      reader = { messages: count, pages, open_and_read_ms: Number((performance.now() - readStarted).toFixed(1)) };
    }
    const measurement = { input_bytes: (await stat(source)).size, parse_ms: Number((finished - parsingAt).toFixed(1)), first_progress_ms: Number((firstProgress - parsingAt).toFixed(1)), progress_events: progressEvents, peak_working_set_bytes: peakWorkingSetBytes(child.pid), state: result.state, archives: archives.items.length,
      ...(cancel ? { cancel_response_ms: Number((finished - cancelledAt).toFixed(1)) } : {}) };
    await send("engine.shutdown"); child.stdin.end();
    const exit = await ended; if (exit.code !== 0 || exit.signal || stderr) throw new Error(`Capacity Engine failed: ${stderr}`);
    return { ...measurement, reader, cycle_ms: Number((performance.now() - started).toFixed(1)) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended; lines.close(); failPending(new Error("Benchmark finished"));
  }
}

async function writeCapacityFixture(root, target) {
  const fixture = await readFile(path.join(root, "tests/v1/parser/fixtures/chatgpt-light.html"), "utf8");
  const manifest = fixture.match(/<script type="application\/json" id="ai-chat-archive-manifest">([\s\S]*?)<\/script>/u)?.[1];
  if (!manifest) throw new Error("Capacity fixture manifest not found");
  const handle = await open(target, "wx");
  try {
    await handle.writeFile(`<!doctype html><meta charset="utf-8"><script type="application/json" id="ai-chat-archive-manifest">${manifest}</script><script type="application/json" id="chatgpt-export-data">{"format":"osis.chatgpt.chat-export/light-items-v2","platform":"chatgpt","title":"Capacity fixture","items":[`);
    const text = "Capacity text for a deterministic offline archive. ".repeat(5400); // about 256 KiB per message, no giant temporary string.
    for (let index = 0; index < 512; index++) {
      const item = { kind: index % 2 ? "assistant" : "user", message_id: `capacity-${index}`, node_id: `capacity-node-${index}`, parts: [{ type: "md", text }] };
      await handle.writeFile((index ? "," : "") + JSON.stringify(item));
    }
    await handle.writeFile("]}</script>"); await handle.sync();
  } finally { await handle.close(); }
}

async function oneEngineCycle(library, cwd) {
  const started = performance.now();
  await mkdir(library, { recursive: true });
  const client = startRecordEngine({ packageRoot: cwd, libraryRoot: library, timeoutMs: 15000 });
  let memory;
  try {
    const handshake = await client.request("engine.handshake");
    if (handshake.protocol !== ENGINE_PROTOCOL) throw new Error("Engine benchmark handshake failed");
    await client.request("library.startup.recover");
    if ((await client.request("library.create")).status !== "created") throw new Error("Engine benchmark Library create failed");
    await client.request("library.preferences.query");
    memory = workingSetBytes(client.pid);
  } finally { await client.close(); }
  const exit = await client.exited;
  if (exit.code !== 0 || exit.signal) throw new Error(`Engine benchmark failed: code=${exit.code} signal=${exit.signal ?? "none"}`);
  return { milliseconds: Number((performance.now() - started).toFixed(3)), working_set_bytes: memory };
}

async function diskBenchmark(directory) {
  const payload = Buffer.alloc(diskBytes, 0x5a);
  const expected = sha256(payload);
  const writes = [];
  const reads = [];
  for (let index = 0; index < 5; index += 1) {
    const file = path.join(directory, `disk-${index}.bin`);
    let started = performance.now();
    await writeFile(file, payload);
    const handle = await open(file, "r+");
    await handle.sync();
    await handle.close();
    writes.push(Number((diskBytes / 1024 / 1024 / ((performance.now() - started) / 1000)).toFixed(3)));
    started = performance.now();
    const bytes = await readFile(file);
    if (sha256(bytes) !== expected) throw new Error("disk benchmark bytes changed");
    reads.push(Number((diskBytes / 1024 / 1024 / ((performance.now() - started) / 1000)).toFixed(3)));
  }
  return { bytes_per_sample: diskBytes, write: summarize(writes, "MiB/s"), read: summarize(reads, "MiB/s") };
}

export function parseBenchmarkArgs(args) {
  const values = { output: path.resolve(defaultRoot, args.includes("--engineering") ? "artifacts/v1-release/evidence/benchmark-engineering.json" : defaultOutput), engineering: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--engineering") { values.engineering = true; continue; }
    if (!args[index + 1] || !["--output", "--sample-root"].includes(args[index])) throw new Error("Usage: node scripts/run-v1-release-benchmark.mjs [--engineering] [--output <file>] [--sample-root <directory>]");
    values[args[index] === "--output" ? "output" : "sampleRoot"] = path.resolve(args[index + 1]);
    index++;
  }
  return values;
}

export function benchmarkEvidenceSchema(engineering = false) {
  return engineering ? "cloudig/engineering-benchmark/1.0.0" : "cloudig/release-benchmark/1.0.0";
}

export function matchingBenchmarkJourney(journey, packaged) {
  if (journey?.status !== "passed" || journey.result?.execution !== "packaged-record-engine"
      || journey.package?.program?.aggregate_sha256 !== packaged.program.aggregate_sha256
      || ["executable", "engine", "worker"].some(key => journey.package?.[key]?.sha256 !== packaged[key].sha256)) return null;
  return { run_id: journey.run_id, duration_ms: journey.outcome.duration_ms, html_files: journey.result.sample_files, claude_records: journey.result.claude?.records ?? null };
}

export async function runV1ReleaseBenchmark({ root = defaultRoot, output = path.resolve(defaultRoot, defaultOutput), sampleRoot, engineering = false } = {}) {
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (status && !engineering) throw new Error("release benchmark requires a clean source tree");
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const packageRoot = path.join(root, "artifacts", "v1-desktop", "app");
  const node = path.join(packageRoot, "app", "runtime", "node", "node.exe");
  const engine = path.join(packageRoot, "app", "engine", "engine.mjs");
  const executable = path.join(packageRoot, "Cloudig.exe");
  const provenance = JSON.parse(await readFile(path.join(packageRoot, "app", "build-provenance.json"), "utf8"));
  if (provenance.source?.working_tree_clean !== true && !engineering) throw new Error("fixed package was not built from a clean source tree");
  const beforePackage = hashInputs(root, ["artifacts/v1-desktop/app"]);
  const scopeParent = path.join(root, "tmp");
  await mkdir(scopeParent, { recursive: true });
  const scope = await mkdtemp(path.join(scopeParent, "cloudig-release-benchmark-"));
  try {
    const cycles = [];
    for (let index = 0; index < repetitions; index += 1) {
      cycles.push(await oneEngineCycle(path.join(scope, `Library-${index}`), packageRoot));
    }
    const disk = await diskBenchmark(scope);
    const large = path.join(scope, "capacity-128MiB.html");
    await writeCapacityFixture(root, large);
    process.stdout.write("Capacity: parsing the generated 512-message input\n");
    const capacity = { synthetic: await parseCycle(node, engine, packageRoot, path.join(scope, "Capacity-Library"), large, false), cancellation: await parseCycle(node, engine, packageRoot, path.join(scope, "Cancel-Library"), large, true), cancellation_normalize: await parseCycle(node, engine, packageRoot, path.join(scope, "Cancel-Normalize-Library"), large, "normalize") };
    if (sampleRoot) {
      const samples = await Promise.all((await readdir(sampleRoot, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".html")).map(async entry => ({ file: path.join(sampleRoot, entry.name), bytes: (await stat(path.join(sampleRoot, entry.name))).size })));
      samples.sort((a, b) => b.bytes - a.bytes);
      if (!samples.length) throw new Error("No real HTML input for capacity benchmark");
      process.stdout.write("Capacity: parsing the largest real HTML in the selected batch\n");
      capacity.real_largest = await parseCycle(node, engine, packageRoot, path.join(scope, "Real-Library"), samples[0].file, false);
    }
    const filesystem = await statfs(scope);
    const executableBytes = await readFile(executable);
    const packageTree = hashInputs(root, ["artifacts/v1-desktop/app"]);
    if (beforePackage.aggregate_sha256 !== packageTree.aggregate_sha256) throw new Error("Fixed package changed during benchmark");
    const runtimeLock = JSON.parse(await readFile(path.join(packageRoot, "app", "runtime-lock.json"), "utf8"));
    const realLibraryFile = path.join(root, "artifacts", "v1-release", "evidence", "real-library-journey.json");
    const realLibrary = await readFile(realLibraryFile, "utf8").then(JSON.parse).catch(() => null);
    const evidence = {
      schema: benchmarkEvidenceSchema(engineering),
      status: "passed",
      release_eligible: !engineering,
      ...(engineering ? { source_worktree_status: status, package_built_clean: provenance.source?.working_tree_clean === true } : {}),
      baseline: "initial-v1",
      source_commit: sourceCommit,
      executable_sha256: sha256(executableBytes),
      package_aggregate_sha256: packageTree.aggregate_sha256,
      hardware: {
        os: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpu: os.cpus()[0]?.model ?? "unknown",
        logical_processors: os.cpus().length,
        total_memory_bytes: os.totalmem(),
        disk_total_bytes: filesystem.blocks * filesystem.bsize,
        disk_free_bytes: filesystem.bfree * filesystem.bsize
      },
      runtime: runtimeLock,
      engine_empty_library_cycle: summarize(cycles.map((entry) => entry.milliseconds), "ms"),
      engine_working_set: summarize(cycles.map((entry) => entry.working_set_bytes).filter(Number.isFinite), "bytes"),
      disk,
      capacity,
      real_library_journey: matchingBenchmarkJourney(realLibrary, journeyPackageFingerprint(root, packageRoot)),
      comparison: { previous_baseline: null, p95_regression: null, explanation: "Initial V1 release baseline; no earlier V1 candidate exists." }
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return evidence;
  } finally {
    await rm(scope, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const options = parseBenchmarkArgs(process.argv.slice(2));
    const result = await runV1ReleaseBenchmark({ root: defaultRoot, ...options });
    process.stdout.write(`${JSON.stringify({ output: path.relative(defaultRoot, options.output).replaceAll("\\", "/"), executable_sha256: result.executable_sha256, engine_p50_ms: result.engine_empty_library_cycle.p50, engine_p95_ms: result.engine_empty_library_cycle.p95, working_set_p95: result.engine_working_set.p95 })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
