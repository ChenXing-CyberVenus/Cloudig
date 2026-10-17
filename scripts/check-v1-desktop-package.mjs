import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { ENGINE_PROTOCOL } from "../src/engine/protocol.mts";
import { LIBRARY_SCHEMA } from "../src/core/records/schema-registry.mts";
import { currentBookmarkletBuildTargets } from "./build-current-bookmarklets.mjs";
import { bookmarkSetVersion } from "./bookmarklet-targets.mjs";
import { readV1SchemaPackage } from "./build-v1-schema-package.mjs";
import { assertOfflineShell } from "./v1-release-preflight.mjs";

const root = path.join(process.cwd(), "artifacts", "v1-desktop", "app");
const program = path.join(root, "app");
const productVersion = JSON.parse(await readFile("release/v1-preflight-spec.json", "utf8")).product.version;
for (const stale of ["engine", "web", "runtime", "runtimes", "app/Cloudig.exe"]) {
  await readFile(path.join(root, ...stale.split("/"))).then(() => {
    throw new Error(`Stale generated program path escaped the portable app root: ${stale}`);
  }, error => {
    if (error.code !== "ENOENT") throw error;
  });
}
assert.deepEqual(await readFile(path.join(program, "web/shared/parser-history.json")), await readFile("src/adapters/parser/contracts/parser-history.json"));
assert.deepEqual(await readFile(path.join(program, "web/shared/parser-history.js")), await readFile("src/ui/shared/parser-history.js"));
const dotnet = process.env.CLOUDIG_DOTNET || path.join(process.cwd(), "manager", ".cache", "dotnet", "dotnet.exe");
const packages = path.join(process.env.USERPROFILE ?? "", ".nuget", "packages");
const lock = JSON.parse(await readFile(path.join(program, "runtime-lock.json"), "utf8"));
assert.deepEqual(lock, {
  schema: "cloudig/runtime-lock/1.0.0",
  cloudig: productVersion,
  engine: "0.1.0-dev",
  node: "24.18.0",
  dotnet_sdk: "10.0.302",
  webview2_package: "1.0.4078.44",
  renderer: { markdown_it: "15.0.1", katex: "0.18.5", mermaid: "11.17.2" },
  bookmarks: {
    mode: lock.bookmarks.mode,
    package: "0.2.0",
    set: lock.bookmarks.set,
    light: 12,
    full: 12,
    tree: 8
  }
});
const provenance = JSON.parse(await readFile(path.join(program, "build-provenance.json"), "utf8"));
assert.equal(provenance.schema, "cloudig/build-provenance/1.0.0");
assert.equal(provenance.product, productVersion);
assert.equal(provenance.environment.native_dependencies, "app-directory-no-self-extraction");
assert.equal(provenance.environment.single_file, false);
assert.equal(provenance.examples.mode, "online-catalog");
const exampleCatalog = JSON.parse(await readFile(path.join(root, "docs/examples/manifest.json"), "utf8"));
assert.equal(exampleCatalog.distribution, "online");
assert.equal(exampleCatalog.examples.length, provenance.examples.count);
// Do not accidentally freeze an old local-example payload into 1.0.2.
for (const entry of exampleCatalog.examples) for (const kind of ["html", "record"]) {
  const file = path.join(root, "docs/examples", entry[kind].path);
  const present = await readFile(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  assert.equal(present, false, `Online-only example is still in the candidate: ${entry[kind].path}`);
}
for (const nativeLibrary of ["WebView2Loader.dll", "wpfgfx_cor3.dll", "PresentationNative_cor3.dll", "D3DCompiler_47_cor3.dll"]) {
  assert.ok((await readFile(path.join(program, nativeLibrary))).byteLength > 0, `Portable native dependency missing: ${nativeLibrary}`);
}
assert.match(provenance.source.commit, /^[0-9a-f]{40}$/u);
assert.equal(typeof provenance.source.working_tree_clean, "boolean");
assert.match(provenance.inputs.aggregate_sha256, /^[0-9a-f]{64}$/u);
assert.ok(["current", "current-pending", "reused-accepted"].includes(provenance.bookmarks.mode));
assert.equal(provenance.bookmarks.mode, lock.bookmarks.mode);
assert.equal(provenance.bookmarks.set, lock.bookmarks.set);
assert.match(provenance.bookmarks.manifest_sha256, /^[0-9a-f]{64}$/u);
const thirdParty = JSON.parse(await readFile(path.join(root, "docs/third-party-inventory.json"), "utf8"));
assert.equal(thirdParty.schema, "cloudig/third-party-inventory/1.0.0");
assert.equal(thirdParty.summary.runtime_components, 3);
assert.ok(thirdParty.summary.npm_packages > 20);
for (const name of ['yauzl', 'pend']) {
  const entry = thirdParty.npm_packages.find(item => item.name === name);
  assert.ok(entry?.consumers.includes('engine') && entry?.consumers.includes('parser_worker'), `ZIP reader dependency missing from the shipped license inventory: ${name}`);
}
assert.ok((await readFile(path.join(root, "docs/THIRD-PARTY-LICENSES.txt"), "utf8")).includes("Microsoft.Web.WebView2 SDK"));
const schemaIndex = JSON.parse(await readFile(path.join(root, "docs/schemas/index.json"), "utf8"));
assert.equal(schemaIndex.cloudig_standard, "1.0");
const schemaSources = await readV1SchemaPackage(process.cwd());
assert.equal(schemaIndex.schemas.length, schemaSources.length);
for (const row of schemaSources) {
  assert.deepEqual(await readFile(path.join(root, "docs/schemas", row.file)), row.bytes, `Packaged Schema drifted: ${row.file}`);
  assert.deepEqual(schemaIndex.schemas.find(item => item.file === row.file), { file: row.file, source: row.source, id: row.schema.$id, sha256: row.sha256 });
}
const bookmarkManifest = JSON.parse(await readFile(path.join(root, "bookmarks", "bookmark-package.json"), "utf8"));
assert.equal(bookmarkManifest.bookmark_set_version, lock.bookmarks.set);
assert.equal(bookmarkManifest.platform_count, 12);
assert.equal(bookmarkManifest.variant_count, 32);
const currentById = new Map(currentBookmarkletBuildTargets.map((target) => [target.id.replace(":all-branches", ":all_branches"), target]));
for (const platform of bookmarkManifest.platforms) {
  for (const variant of platform.variants) {
    const packaged = await readFile(path.join(root, "bookmarks", "artifacts", ...variant.artifact.split("/")));
    assert.equal(packaged.byteLength, variant.bytes, `packaged bookmark bytes drifted: ${variant.id}`);
    assert.equal(createHash("sha256").update(packaged).digest("hex"), variant.sha256, `packaged bookmark hash drifted: ${variant.id}`);
    if (["current", "current-pending"].includes(provenance.bookmarks.mode)) {
      const current = currentById.get(variant.id);
      assert.ok(current, `packaged bookmark ${variant.id} is not current`);
      const source = await readFile(path.join(process.cwd(), "bookmarklets", ...current.min.split("/")));
      assert.deepEqual(packaged, source, `packaged bookmark bytes drifted from current source: ${variant.id}`);
    }
  }
}
if (provenance.bookmarks.mode === "current") assert.equal(lock.bookmarks.set, bookmarkSetVersion);
const desktopBookmarkGate = spawnSync(dotnet, [
  "run",
  "--project", "src/desktop/Cloudig.Desktop.Tests/Cloudig.Desktop.Tests.csproj",
  "-c", "Release",
  `-p:RestorePackagesPath=${packages}`,
  "--",
  path.join(program, "runtime", "node", "node.exe"),
  path.join(root, "bookmarks"),
  path.join(program, "engine", "engine.mjs")
], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
if (desktopBookmarkGate.error) throw new Error(`Desktop bookmark gate could not start: ${desktopBookmarkGate.error.code ?? desktopBookmarkGate.error.message}`);
if (desktopBookmarkGate.status !== 0) throw new Error(`${desktopBookmarkGate.stdout}\n${desktopBookmarkGate.stderr}`);
assert.match(desktopBookmarkGate.stdout, /Cloudig desktop core checks passed\./u);
const license = await readFile(path.join(root, "LICENSE"), "utf8");
assert.match(license, /Justice For Open Good License 1\.1（JOG-1\.1）/u);
const shell = await readFile(path.join(program, "web", "index.html"), "utf8");
assert.ok((await readFile(path.join(program, "engine", "record-parser-worker.mjs"))).byteLength > 0, "new-record Parser worker must be packaged beside the Engine");
assert.match(shell, /data-page="welcome"/u);
assert.match(shell, /id="reader-cover-template"/u);
assert.match(shell, /data-page="reader"/u);
assert.match(shell, /Cloudig-Logo-Title-Slogan\.svg/u);
assert.match(shell, /Waiting-Sun\.gif/u);
assert.doesNotMatch(shell, /Cloudig-Reader-Cover-Scene/iu);
assertOfflineShell(shell);
for (const relative of [
  "web/shell.css",
  "web/shell.js",
  "web/startup.js",
  "web/operation-progress.js",
  "web/operation-progress.css",
  "web/overflow-text.js",
  "web/pages/reader/reader.css",
  "web/pages/reader/reader-cover.js",
  "web/pages/reader/conversation.css",
  "web/pages/reader/reader-conversation.js",
  "web/pages/archiver/archiver.css",
  "web/pages/archiver/archiver.js",
  "web/pages/archiver/claude-container.css",
  "web/pages/archiver/claude-container.js",
  "web/pages/archiver/platform-json.js",
  "web/pages/archiver/platform-json-presentation.js",
  "web/pages/archiver/platform-json.css",
  "web/assets/platforms/platform-codex.svg",
  "web/assets/platforms/Codex-LICENSE.txt",
  "web/assets/platforms/platform-cline.svg",
  "web/assets/platforms/platform-sillytavern.svg",
  "web/assets/platforms/platform-kimi-code.svg",
  "web/assets/platforms/platform-claude-code.svg",
  "web/assets/platforms/platform-agent-instance.svg",
  "web/pages/conversation-info/conversation-info.css",
  "web/pages/conversation-info/conversation-info.js",
  "web/pages/time-cover/time-cover.css",
  "web/pages/time-cover/time-cover.js",
  "web/pages/time-editor/time-editor.css",
  "web/pages/time-editor/time-editor.js",
  "web/shared/time/endpoint-editor.css",
  "web/shared/time/endpoint-editor.js",
  "web/shared/time/core-format.js",
  "web/shared/time/record-format.js",
  "web/shared/record-text-limits.js",
  "web/shared/record-text-input.js",
  "web/assets/editor/EditorBack-Tao.svg",
  "web/assets/editor/EditorBack-Drawer.svg",
  "web/assets/editor/ContentTimeTitleBack-Dawn.svg",
  "web/assets/editor/ContentTimeTitleBack-StarNight.svg",
  "web/assets/editor/TimeLOGO-Terran.svg",
  "web/assets/editor/TimeLOGO-Sovereign.svg",
  "web/assets/editor/Title-Paper-Editor-Dawn.svg",
  "web/assets/editor/Title-Paper-Editor-StarNight.svg",
  "web/locales/zh-CN.json",
  "web/locales/en.json",
  "web/assets/asset-sources.json",
  "web/assets/welcome/OsisLogo-Main-1024.png",
  "web/assets/welcome/Cloudig-Logo-Title-Slogan.svg",
  "web/assets/reader/Waiting-Sun.gif",
  "web/assets/reader/Conversation-Title-Back-Dawn.svg",
  "web/assets/reader/ToolBar-Pattern-StarNight.svg",
  "web/assets/archiver/TitleDec-Explosion.svg",
  "web/assets/archiver/TitleDec-Garden.svg",
  "web/assets/archiver/TitleDec-Pompeii.svg",
  "web/assets/archiver/TitleDec-Conquer.svg",
  "web/assets/archiver/TitleDec-Planet.svg",
  "web/assets/archiver/TitleDec-Homeland.svg",
  "web/assets/reader/RCSD-桌面与杂物.svg",
  "web/assets/reader/RCSS-桌面与电脑-黑灯.svg",
  "web/assets/platforms/platform-chatgpt.svg",
  "web/assets/platforms/platform-unknown.svg",
  "web/assets/platforms/platform-doubao.png",
  "build-provenance.json",
  "third-party-inventory.json",
  "THIRD-PARTY-LICENSES.txt"
]) {
  const parent = ["third-party-inventory.json", "THIRD-PARTY-LICENSES.txt"].includes(relative) ? path.join(root, "docs") : program;
  assert.ok((await readFile(path.join(parent, ...relative.split("/")))).byteLength > 0, `missing ${relative}`);
}
const temporary = path.join(process.cwd(), "tmp");
await mkdir(temporary, { recursive: true });
const scope = await mkdtemp(path.join(temporary, "cloudig-packaged-engine-"));
const library = path.join(scope, "CloudigTest");
try {
  await mkdir(library);
  const child = spawn(
    path.join(program, "runtime", "node", "node.exe"),
    [path.join(program, "engine", "engine.mjs"), "--library-root", library, "--cache-root", path.join(library, "cache")],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  let stdout = "";
  let stderr = "";
  const messages = [];
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    stdout += `${line}\n`;
    const message = JSON.parse(line);
    messages.push(message);
    pending.get(message.request)?.(message);
    pending.delete(message.request);
  });
  child.stderr.on("data", (value) => { stderr += value; });
  const frame = (request, command) => `${JSON.stringify({ protocol: ENGINE_PROTOCOL, kind: "request", request, command, payload: {} })}\n`;
  const send = (request, command) => new Promise((resolve, reject) => {
    pending.set(request, resolve);
    child.stdin.write(frame(request, command), (error) => error ? reject(error) : undefined);
  });
  const handshake = await send("q_handshake", "engine.handshake");
  const recovered = await send("q_recover", "library.startup.recover");
  const created = await send("q_create", "library.create");
  const preferences = await send("q_preferences", "library.preferences.query");
  const stopped = await send("q_shutdown", "engine.shutdown");
  child.stdin.end();
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /[A-Za-z]:\\|data_base64|manager\/|parser\/src/iu);
  assert.equal(messages.length, 5);
  assert.equal(handshake.result.protocol, ENGINE_PROTOCOL);
  assert.deepEqual(recovered.result, { status: "missing" });
  assert.equal(created.result.status, "created");
  assert.match(created.result.revision, /^[0-9a-f]{64}$/u);
  const initializedLibrary = JSON.parse(await readFile(path.join(library, "CloudigLibrary.json"), "utf8"));
  assert.equal(initializedLibrary.schema, LIBRARY_SCHEMA);
  assert.equal(initializedLibrary.cloudig_standard, "1.0");
  assert.equal(Object.keys(initializedLibrary)[0], "cloudig_standard");
  assert.equal(preferences.result.theme, "dawn");
  assert.deepEqual(stopped.result, { stopped: true });
  console.log(JSON.stringify({ packagedEngine: true, messages: messages.length }));
} finally {
  await rm(scope, { recursive: true, force: true });
}
