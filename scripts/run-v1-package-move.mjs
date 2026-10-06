import assert from "node:assert/strict";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { startRecordEngine } from "./record-engine-client.mjs";
import { hashInputs } from "./v1-release-preflight.mjs";

// An opt-in real package move. No user Library, actual Chrome or visible window.
const project = process.cwd();
const packageRoot = path.resolve("artifacts/v1-desktop/app");
const mainWindowJourney = process.argv.includes("--main-window");
const programPaths = ["Cloudig.exe", "app", "bookmarks", "docs", "LICENSE"];
const output = path.resolve(process.argv[2] ?? "artifacts/v1-release/evidence/package-move-engineering.json");
assert(output.startsWith(path.join(project, "artifacts") + path.sep));
await mkdir(path.dirname(output), { recursive: true });
const parent = path.resolve("tests/private/schema-rebuild"); await mkdir(parent, { recursive: true });
const scope = await mkdtemp(path.join(parent, "package-move-"));
const source = path.join(scope, "Cloudig"), target = path.join(scope, "Moved Cloudig");
let verified = false, client;

async function run(executable, args, cwd, timeoutMs = 90000) {
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DOTNET_ROOT: path.resolve("manager/.cache/dotnet") } });
  let out = "", err = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", x => { out = (out + x).slice(-32000); }); child.stderr.on("data", x => { err = (err + x).slice(-32000); });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try { const result = await ended; assert.equal(result.signal, null, err || "test process exceeded its deadline"); assert.equal(result.code, 0, err || out); return out; }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await ended; } }
}
async function files(root, prefix = "") {
  const result = [];
  for (const e of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${e.name}` : e.name;
    const info = await lstat(path.join(root, name)); assert(!info.isSymbolicLink(), "The test must not copy or follow a link");
    if (name === "cache") continue;
    if (e.isDirectory()) result.push(...await files(root, name)); else if (e.isFile()) result.push(name);
  }
  return result.sort();
}
try {
  const packagedBefore = hashInputs(packageRoot, programPaths);
  await mkdir(source); await mkdir(target);
  for (const name of programPaths) await cp(path.join(packageRoot, name), path.join(source, name), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  assert.equal(hashInputs(source, programPaths).aggregate_sha256, packagedBefore.aggregate_sha256);
  client = startRecordEngine({ packageRoot: source, libraryRoot: source });
  await client.request("library.create");
  await copyFile(path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), path.join(source, "Inbox", "Move test.html"));
  const plan = await client.request("archiver.parse.plan", { sources: [], one_click: true });
  assert.equal((await client.request("archiver.parse.commit", { plan: plan.plan })).completed, 1);
  const beforeRows = await client.request("reader.archives.query", { offset: 0, limit: 200 }), row = beforeRows.items[0];
  assert.match(row.conversation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const info = await client.request("reader.archive.info.query", { archive: row.capability });
  info.draft.conversation_name = { state: "set", value: "Moved with my Mark" };
  await client.request("reader.archive.info.commit", { archive: row.capability, expected_conversation: info.revision.conversation, expected_mark: info.revision.mark, draft: info.draft, touch_on_noop: false });
  await writeFile(path.join(source, "docs", "user-note.txt"), "User notes move with the whole folder.\n");
  const endpoints = await client.request("library.move.endpoints", { target });
  await client.close(); client = null;
  const preservedPaths = await files(source), before = hashInputs(source, preservedPaths);
  const dotnet = process.env.CLOUDIG_DOTNET ?? path.resolve("manager/.cache/dotnet/dotnet.exe");
  const screenshot = output.replace(/\.json$/u, ".wpf.png");
  let moved;
  if (mainWindowJourney) {
    await run(path.join(source, "Cloudig.exe"), ["--visual-audit-output", screenshot, "--visual-audit-query", "screenshot=1&fixture=real&route=archiver&theme=dawn&language=zh-CN&phase=motion-freeze&interaction=library-move", "--visual-audit-width", "1280", "--visual-audit-height", "720", "--visual-audit-move-target", target], source);
    const deadline = Date.now() + 90000;
    let manifest, trace = "";
    while (Date.now() < deadline) {
      const failure = await readFile(screenshot.replace(/\.png$/u, ".error.txt"), "utf8").catch(e => { if (e.code !== "ENOENT") throw e; return null; });
      assert.equal(failure, null, failure);
      manifest = await readFile(screenshot.replace(/\.png$/u, ".json"), "utf8").then(JSON.parse).catch(e => { if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e; return null; });
      trace = await readFile(screenshot.replace(/\.png$/u, ".trace.txt"), "utf8").catch(e => { if (e.code !== "ENOENT") throw e; return ""; });
      if (manifest && trace.match(/cache-profile-removed/gu)?.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(manifest && trace.match(/cache-profile-removed/gu)?.length === 2, "Both source and automatically reopened target must retire their own WebViews");
    const helper = trace.match(/library-move-helper-started\s+pid=(\d+);owner=(\d+)/u);
    assert(helper); assert.match(trace, /library-move-preview-cancel-passed/u);
    for (const pid of [Number(helper[1]), Number(helper[2]), manifest.executable.pid]) {
      let exited = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(pid, 0); } catch (e) { if (e.code !== "ESRCH") throw e; exited = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(exited, `Owned move process ${pid} did not exit`);
    }
    moved = JSON.parse(await readFile(path.join(target, "appdata/Move/result.json"), "utf8"));
    assert.equal(moved.status, "completed");
  } else {
    const native = await run(dotnet, ["run", "--project", "src/desktop/Cloudig.Desktop.Tests/Cloudig.Desktop.Tests.csproj", "-c", "Release", `-p:RestorePackagesPath=${path.join(process.env.USERPROFILE, ".nuget/packages")}`, "--", "--portable-move-existing-root-test", source, target, endpoints.source, endpoints.target], project);
    moved = JSON.parse(native.trim().split(/\r?\n/u).findLast(line => line.startsWith("{")));
    assert.equal(moved.status, "passed");
  }
  assert.equal(await lstat(source).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; }), false);
  assert.equal(hashInputs(target, preservedPaths).aggregate_sha256, before.aggregate_sha256, "Every pre-move program/user file keeps its exact bytes");
  client = startRecordEngine({ packageRoot: target, libraryRoot: target });
  assert.equal((await client.request("library.startup.recover")).status, "valid");
  const afterRows = await client.request("reader.archives.query", { offset: 0, limit: 200 });
  assert.equal(afterRows.total, 1); assert.equal(afterRows.items[0].conversation_id, row.conversation_id); assert.equal(afterRows.items[0].title, "Moved with my Mark");
  await client.close(); client = null;
  if (!mainWindowJourney) await run(path.join(target, "Cloudig.exe"), ["--visual-audit-output", screenshot, "--visual-audit-query", "screenshot=1&fixture=real&route=reader&theme=dawn&language=zh-CN&phase=motion-freeze", "--visual-audit-width", "1280", "--visual-audit-height", "720"], target);
  const visual = JSON.parse(await readFile(screenshot.replace(/\.png$/u, ".json"), "utf8"));
  assert.equal(visual.page.ready, true); assert.deepEqual(visual.page.images_failed, []); assert.equal(visual.page.surface, "reader");
  assert.match(await readFile(screenshot.replace(/\.png$/u, ".trace.txt"), "utf8"), /cache-profile-removed/u);
  assert.equal(hashInputs(packageRoot, programPaths).aggregate_sha256, packagedBefore.aggregate_sha256, "The fixed source package was never moved or edited");
  const evidence = { schema: "cloudig/package-move-engineering/1.0.0", status: "passed", release_eligible: false, native: moved, fixed_package: packagedBefore.aggregate_sha256, preserved_files: preservedPaths.length, preserved_bytes: before.total_bytes, conversation_id: row.conversation_id, mark_preserved: true, actual_target_apphost_opened: true, main_window_preview_cancel_confirm_shutdown: mainWindowJourney, target_automatically_reopened: mainWindowJourney, native_folder_picker_injected: mainWindowJourney, explicit_library_argument: false, visible_window: false, physical_cross_volume: false };
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n"); verified = true; console.log(JSON.stringify(evidence));
} finally {
  if (client) await client.close();
  if (verified) { assert(path.dirname(scope) === parent && !(await lstat(scope)).isSymbolicLink()); await rm(scope, { recursive: true }); }
  else console.error(`Failed test data preserved: ${scope}`);
}
