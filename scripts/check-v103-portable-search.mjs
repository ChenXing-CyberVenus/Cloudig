import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { startRecordEngine } from "./record-engine-client.mjs";

// Actual candidate evidence, not a second implementation of the product.
// All generated data stays in one new, explicit evidence directory. Cleanup is
// intentionally deferred until the final visual checks and process exit pass.
const [sourceArgument, outputArgument, resumeArgument] = process.argv.slice(2);
assert(sourceArgument && outputArgument, "Usage: node scripts/check-v103-portable-search.mjs <real Conversation> <new evidence directory>");
const source = path.resolve(sourceArgument), output = path.resolve(outputArgument);
const packageRoot = path.resolve("artifacts/v1-desktop/app");
assert(output.startsWith(path.resolve("artifacts/v1-visual-audit") + path.sep));
const resume = resumeArgument === "--resume-owned-fixture";
if (!resume) await mkdir(output); // Only explicitly resume this test's known fixture; never clear it.
const original = path.join(output, "Portable A"), moved = path.join(output, "Moved B");
const different = path.join(output, "Independent Library");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = await readFile(source), sourceHash = sha(sourceBytes);
const exeHash = sha(await readFile(path.join(packageRoot, "Cloudig.exe")));
if (!resume) {
  await cp(packageRoot, original, { recursive: true, errorOnExist: true, force: false });
  const setup = startRecordEngine({ packageRoot: original, libraryRoot: original });
  try { await setup.request("library.create"); }
  finally { await setup.close(); }
  await writeFile(path.join(original, "Conversations", path.basename(source)), sourceBytes, { flag: "wx" });
}
assert.equal(sha(await readFile(path.join(original, "Cloudig.exe"))), exeHash);
assert.equal(sha(await readFile(path.join(original, "Conversations", path.basename(source)))), sourceHash);

const evidence = { executable_sha256: exeHash, source: { path: source, bytes: sourceBytes.length, sha256: sourceHash }, checks: {}, hardware: "NTFS same-volume relocation; actual FAT/exFAT, unplug and power loss not available" };
const query = { query: "夫夫君", categories: ["user", "assistant", "process"], scope: {}, offset: 0, limit: 30 };
let engine = startRecordEngine({ packageRoot: original, libraryRoot: original });
try {
  const events = [], started = performance.now();
  const result = await engine.request("reader.search.query", query, event => events.push({ ms: performance.now() - started, ...event }));
  assert(result.total > 0 && events.some(event => event.messages > 0));
  evidence.checks.large_search = { elapsed_ms: performance.now() - started, total: result.total, matched_messages: result.matched_messages, events };
} finally { await engine.close(); }
engine = startRecordEngine({ packageRoot: original, libraryRoot: original });
try {
  let cancellation, requestedAt;
  // The test client's first command has the deterministic ID q_evidence_1.
  // Cancel only after this real file has begun yielding scanned messages.
  await assert.rejects(engine.request("reader.search.query", query, event => {
    if (!cancellation && event.messages > 0) { requestedAt = performance.now(); cancellation = engine.request("engine.cancel", { target: "q_evidence_1" }); }
  }), { code: "CLOUDIG_CANCELLED" });
  assert(cancellation, "The real search finished without reaching the cancellation checkpoint");
  const cancelled = await cancellation; assert.equal(cancelled.cancelled, true);
  const cancelMs = performance.now() - requestedAt;
  const retried = await engine.request("reader.search.query", query); assert(retried.total > 0);
  evidence.checks.cancel_retry = { cancellation_ms: cancelMs, retry_total: retried.total };
} finally { await engine.close(); }

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const running = new Set();
function launch(root, stem, extra = [], interaction = "reader-catalog-open") {
  const outputFile = path.join(output, `${stem}.png`);
  const args = ["--visual-audit-output", outputFile, "--visual-audit-query", `screenshot=1&fixture=real&route=${interaction ? "reader" : "welcome"}&theme=dawn&language=zh-CN&phase=motion-freeze${interaction ? `&interaction=${interaction}` : ""}`,
    "--visual-audit-width", "1440", "--visual-audit-height", "900", ...extra];
  const child = spawn(path.join(root, "Cloudig.exe"), args, { cwd: root, windowsHide: true, stdio: "ignore" });
  running.add(child);
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { running.delete(child); resolve({ code, signal }); }); });
  return { child, exited, stem, trace: path.join(output, `${stem}.trace.txt`) };
}
async function finished(run) {
  let timer;
  try {
    const result = await Promise.race([run.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned audit timed out; retained PID ${run.child.pid}`)), 60000); })]);
    assert.equal(result.code, 0, JSON.stringify({ stem: run.stem, ...result }));
    return result;
  } finally { clearTimeout(timer); }
}
async function waitReady(run) {
  for (let i = 0; i < 600; i++) {
    const trace = await readFile(run.trace, "utf8").catch(() => "");
    if (trace.includes("library-ready")) return;
    assert.equal(run.child.exitCode, null, "Owner exited before creating its real Library session");
    await delay(25);
  }
  throw new Error("No real Library startup evidence");
}
const first = launch(original, "original");
await waitReady(first);
const duplicate = launch(original, "duplicate");
const duplicateResult = await finished(duplicate);
assert.equal(first.child.exitCode, null, "First instance must still exist when duplicate startup exits");
assert.equal(await stat(duplicate.trace).then(() => true, () => false), false, "Duplicate reached a second Window/Engine instead of handing off");
await mkdir(different);
const independent = launch(original, "independent", ["--data-root", different], "");
await waitReady(independent);
evidence.checks.instances = { owner_pid: first.child.pid, duplicate_pid: duplicate.child.pid, duplicate_exit: duplicateResult.code, independent_pid: independent.child.pid, independent_ready_while_owner_alive: first.child.exitCode === null };
assert.equal(evidence.checks.instances.independent_ready_while_owner_alive, true);
await Promise.all([finished(first), finished(independent)]);
assert.match(await readFile(first.trace, "utf8"), /reader-catalog-open-passed/u);
await rename(original, moved);
const relocated = launch(moved, "relocated");
await finished(relocated);
assert.match(await readFile(relocated.trace, "utf8"), /reader-catalog-open-passed/u);
assert.equal(sha(await readFile(path.join(moved, "Cloudig.exe"))), exeHash);
assert.equal(sha(await readFile(path.join(moved, "Conversations", path.basename(source)))), sourceHash);
assert.equal(sha(await readFile(source)), sourceHash);
assert.equal(sha(await readFile(path.join(packageRoot, "Cloudig.exe"))), exeHash);
assert.equal(running.size, 0);
evidence.checks.portable = { old_path: original, new_path: moved, default_library_root: true, explicit_library_argument: false, real_reader_open_and_archiver_roundtrip: true, source_and_executable_unchanged: true, processes_exited: true };
await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
