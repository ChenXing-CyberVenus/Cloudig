import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ENGINE_PROTOCOL } from "../src/engine/protocol.mts";
import { build } from "esbuild";

// One finite packaged-Engine batch, not a microbenchmark of only the Adapter.
// Report each real request plus received progress; no synthetic UI delay.
const repository = process.cwd();
const sampleRoot = path.resolve(process.argv[2]);
const app = path.join(repository, "artifacts/v1-desktop/app");
const sampleFiles = (await readdir(sampleRoot)).filter(name => /\.html$/iu.test(name)).sort();
assert.ok(sampleFiles.length > 0);
const repeats = Number(process.env.CLOUDIG_BATCH_REPEATS ?? "1");
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 27);
const inputFiles = Array.from({ length: repeats }, (_, repeat) => sampleFiles.map(name => ({ source: name, target: repeat === 0 ? name : `${name.slice(0, -5)}__batch${repeat + 1}.html` }))).flat();
await mkdir(path.join(repository, "tmp"), { recursive: true });
const temporary = await mkdtemp(path.join(repository, "tmp/v1-batch-timing-"));
const library = path.join(temporary, "Library");
const fromSource = process.env.CLOUDIG_BATCH_SOURCE === "1";
const engineEntry = fromSource ? path.join(temporary, "engine.mjs") : path.join(app, "engine/engine.mjs");
if (fromSource) await build({ entryPoints: { engine: path.join(repository, "src/engine/main.mts"), "parser-worker": path.join(repository, "src/app/parser/worker-entry.mts") }, outdir: temporary, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", minify: process.env.CLOUDIG_BATCH_CPU_PROFILE !== "1", platform: "node", target: ["node24"] });
const profile = process.env.CLOUDIG_BATCH_CPU_PROFILE === "1" ? path.join(repository, "artifacts/v1-release/evidence/batch-cpu-profile") : null;
if (profile) await mkdir(profile, { recursive: true });
const ioProfile = process.env.CLOUDIG_BATCH_IO_PROFILE === "1" ? ["--import", pathToFileURL(path.join(repository, "scripts/profile-v1-io.mjs")).href] : [];
const child = spawn(path.join(app, "runtime/node/node.exe"), [...(profile ? ["--cpu-prof", `--cpu-prof-dir=${profile}`] : []), ...ioProfile, engineEntry, "--library-root", library, "--cache-root", path.join(path.dirname(library), "cache")], { cwd: repository, env: { ...process.env, CLOUDIG_PARSER_METRICS: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const pending = new Map(), measurements = [];
let ordinal = 0, stderr = "";
const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
const closed = new Promise(resolve => child.once("close", resolve));
child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-8000); });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const send = (command, payload = {}) => new Promise((resolve, reject) => {
  const request = `q_batch_timing_${++ordinal}`, started = performance.now();
  const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${command}`)); }, 360000);
  pending.set(request, { resolve, reject, timer, command, started, events: 0, spans: [], phase: null });
  child.stdin.write(JSON.stringify({ protocol: ENGINE_PROTOCOL, kind: "request", request, command, payload }) + "\n");
});
lines.on("line", line => {
  try {
    const message = JSON.parse(line), entry = pending.get(message.request);
    if (!entry) return;
    const now = performance.now();
    if (message.kind === "event") {
      entry.events++;
      const phase = `${message.event?.file?.index ?? 0}:${message.event?.phase ?? "unknown"}`;
      if (phase !== entry.phase) {
        if (entry.spans.length) entry.spans.at(-1).ms = now - entry.spans.at(-1).at;
        entry.spans.push({ phase, at: now, ms: 0 }); entry.phase = phase;
      }
      return;
    }
    pending.delete(message.request); clearTimeout(entry.timer);
    if (entry.spans.length) entry.spans.at(-1).ms = now - entry.spans.at(-1).at;
    const phases = {};
    for (const span of entry.spans) { const phase = span.phase.split(":")[1]; phases[phase] = (phases[phase] ?? 0) + span.ms; }
    const measured = { command: entry.command, ms: now - entry.started, events: entry.events, phases_ms: phases, per_file_phases: entry.spans.map(({ phase, ms }) => ({ phase, ms })) };
    measurements.push(measured);
    console.log(JSON.stringify({ ...measured, per_file_phases: undefined }));
    if (message.ok === false) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  } catch (error) { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); }
});
try {
  await send("engine.handshake"); await send("library.startup.recover"); await send("library.create");
  for (const file of inputFiles) await copyFile(path.join(sampleRoot, file.source), path.join(library, "Inbox", file.target));
  const listed = await send("archiver.sources.query", { offset: 0, limit: 200 });
  const allItems = [...listed.items];
  while (allItems.length < listed.total) allItems.push(...(await send("archiver.sources.query", { offset: allItems.length, limit: 200 })).items);
  assert.equal(allItems.length, inputFiles.length);
  const plan = await send("archiver.parse.plan", { sources: allItems.map(item => item.capability) });
  const committed = await send("archiver.parse.commit", { plan: plan.plan, copy_user_state: true });
  if (committed.state !== "completed") {
    console.error(JSON.stringify({ failures: committed.items.filter(item => item.status !== "created").map(item => ({ ...item, filename: allItems[item.index - 1]?.filename })) }));
    console.error(JSON.stringify(await send("systemLog.list", { offset: 0, limit: 200 })));
  }
  assert.equal(committed.state, "completed");
  assert.equal(committed.items.filter(item => item.status === "created").length, inputFiles.length);
  assert.equal(new Set(committed.items.map(item => item.archive)).size, inputFiles.length, "each physical source remains an independent archive");
  const refreshed = await send("archiver.sources.query", { offset: 0, limit: 200 });
  assert.equal(refreshed.total, inputFiles.length);
  await send("engine.shutdown");
  await closed;
  const parserMetrics = stderr.split(/\r?\n/u).filter(line => line.startsWith("CLOUDIG_PARSER_METRICS ")).map(line => JSON.parse(line.slice("CLOUDIG_PARSER_METRICS ".length)));
  const engineMetrics = stderr.split(/\r?\n/u).filter(line => line.startsWith("CLOUDIG_ENGINE_METRICS ")).map(line => JSON.parse(line.slice("CLOUDIG_ENGINE_METRICS ".length)));
  const report = { schema: "cloudig/parse-batch-timing/1.0.0", layer: fromSource ? "source-bundled-engine-ipc-not-wpf" : "packaged-engine-ipc-not-wpf", samples: inputFiles.length, files: allItems.map(item => item.displayFilename ?? item.filename), engine_sha256: createHash("sha256").update(await readFile(engineEntry)).digest("hex"), measurements, parserMetrics, engineMetrics, successful: committed.items.length };
  if (process.argv[3]) {
    const output = path.resolve(process.argv[3]);
    assert.ok(output.startsWith(path.join(repository, "artifacts") + path.sep));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ output, samples: report.samples, successful: report.successful }));
  } else console.log(JSON.stringify(report));
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 3000);
  await exited; clearTimeout(timeout); lines.close();
  assert.ok(temporary.startsWith(path.join(repository, "tmp") + path.sep));
  await rm(temporary, { recursive: true, force: true });
  if (stderr) console.error(stderr);
}
