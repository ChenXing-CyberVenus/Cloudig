import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { build } from "esbuild";

import { ENGINE_PROTOCOL } from "../src/engine/protocol.mts";

const temporaryRoot = path.join(process.cwd(), "tmp");
await mkdir(temporaryRoot, { recursive: true });
const scope = await mkdtemp(path.join(temporaryRoot, "cloudig-engine-build-"));
const output = path.join(scope, "engine.mjs");
const library = path.join(scope, "Library");

function request(id, command) {
  return `${JSON.stringify({ protocol: ENGINE_PROTOCOL, kind: "request", request: id, command, payload: {} })}\n`;
}

try {
  const result = await build({
    entryPoints: { engine: path.join(process.cwd(), "src/engine/main.mts"), "parser-worker": path.join(process.cwd(), "src/app/parser/worker-entry.mts") },
    bundle: true,
    outdir: scope,
    outExtension: { ".js": ".mjs" },
    format: "esm",
    legalComments: "linked",
    metafile: true,
    minify: false,
    platform: "node",
    sourcemap: false,
    target: ["node20.19"]
  });
  assert.equal(Object.keys(result.metafile.inputs).some((entry) => /^https?:/iu.test(entry)), false);
  await mkdir(library);
  const child = spawn(process.execPath, [output, "--library-root", library, "--cache-root", path.join(scope, "cache")], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
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
  const send = (id, command) => new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(request(id, command), (error) => error ? reject(error) : undefined);
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
  assert.doesNotMatch(stdout, /[A-Za-z]:\\|data_base64/iu);
  assert.equal(messages.length, 5);
  assert.ok(handshake.result.commands.includes("reader.view.open"));
  assert.deepEqual(recovered.result, { status: "missing" });
  assert.deepEqual(created.result, { status: "created", revision: 1 });
  assert.equal(preferences.result.theme, "dawn");
  assert.deepEqual(stopped.result, { stopped: true });
  const files = await readdir(scope);
  assert.ok(files.includes("engine.mjs"));
  const bundled = Object.entries(result.metafile.outputs).find(([file]) => file.replaceAll("\\", "/").endsWith("/engine.mjs") || file === "engine.mjs");
  assert.ok(bundled);
  console.log(JSON.stringify({ bytes: bundled[1].bytes, commands: messages[0].result.commands.length }));
} finally {
  await rm(scope, { recursive: true, force: true });
}
