import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, rm, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { ENGINE_PROTOCOL, assertIpcValue } from "../../../src/engine/protocol.mts";
import { commitRecords, readStoredRecord, pendingRecordOperations } from "../../../src/adapters/storage/record-store.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), obj = (v: unknown) => v as JsonObject, items = (v: JsonObject) => v["items"] as JsonObject[];
async function temporary(run: (root: string, script: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "production-main-")), directory = path.join(root, "app/engine"); let passed = false;
  try {
    await mkdir(directory, { recursive: true });
    const main = await build({ entryPoints: [path.resolve("src/engine/main.mts")], outfile: path.join(directory, "engine.mjs"), bundle: true, format: "esm", platform: "node", target: "node24", metafile: true });
    const inputPaths = Object.keys(main.metafile!.inputs); for (const old of ["library", "archiver", "identity", "reader", "time", "system-log"]) assert(!inputPaths.includes(`src/engine/${old}-commands.mts`), `production main must not instantiate old ${old} commands`);
    for (const old of ["src/adapters/runtime/legacy-conversation-views.mts", "src/adapters/runtime/index.mts", "src/adapters/storage/recovery-point.mts", "src/adapters/reader/conversation-file.mts"]) assert(!inputPaths.includes(old), `record Engine must not bundle old AuthorityPair runtime: ${old}`);
    await build({ entryPoints: [path.resolve("src/app/parser/record-worker-entry.mts")], outfile: path.join(directory, "record-parser-worker.mjs"), bundle: true, format: "esm", platform: "node", target: "node24" });
    await run(root, path.join(directory, "engine.mjs")); passed = true;
  } finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained production Engine: ${root}`); }
}

async function start(root: string, script: string, cacheRoot = path.join(root, "cache")) {
  const child = spawn(process.execPath, [script, "--library-root", root, "--cache-root", cacheRoot], { cwd: path.dirname(script), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<string, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>(); const events: JsonObject[] = []; let sequence = 0, stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr = (stderr + value).slice(-16384); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", code => { for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(new Error(`Engine exited ${code}: ${stderr}`)); } pending.clear(); resolve(code); }); });
  const lines = createInterface({ input: child.stdout }); lines.on("line", line => {
    const value = obj(JSON.parse(line)); assertIpcValue(value);
    if (value["kind"] === "event") { events.push(obj(value["event"])); return; }
    const p = pending.get(String(value["request"])); if (!p) return; pending.delete(String(value["request"])); clearTimeout(p.timeout);
    if (value["ok"]) p.resolve(obj(value["result"])); else p.reject(Object.assign(new Error(String(obj(value["error"])["message"])), { code: obj(value["error"])["code"] }));
  });
  const request = (command: string, payload: JsonObject = {}): Promise<JsonObject> => new Promise((resolve, reject) => {
    const id = `q_${++sequence}`, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Engine timeout: ${command}: ${stderr}`)); }, 60000);
    pending.set(id, { resolve, reject, timeout }); child.stdin.write(JSON.stringify({ protocol: ENGINE_PROTOCOL, kind: "request", request: id, command, payload }) + "\n");
  });
  return { request, events, exited, stderr: () => stderr, async close() {
    if (child.exitCode === null) {
      try { await request("engine.shutdown"); }
      finally {
        child.stdin.end();
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    await exited; lines.close();
  } };
}

test("the bundled production entry creates flat records, parses with its packaged worker, edits Mark and reopens persistent state", async () => temporary(async (root, script) => {
  let engine = await start(root, script);
  try {
    const handshake = await engine.request("engine.handshake"); for (const command of ["identity.query", "time.cover.query", "archiver.parse.items", "systemLog.list", "reader.view.open"]) assert((handshake["commands"] as string[]).includes(command));
    assert.equal((await engine.request("library.startup.recover"))["status"], "missing"); assert(!await lstat(path.join(root, "CloudigLibrary.json")).catch(() => undefined));
    await engine.request("library.create"); assert.equal((await engine.request("library.startup.recover"))["status"], "valid");
    const preferences = await engine.request("library.preferences.query"); assert.equal(preferences["theme"], "dawn"); assert.equal(preferences["theme_switched"], false);
    const identity = await engine.request("identity.query"), subjectBefore = await readFile(path.join(root, "Identities/identity-settings.json"));
    assert.equal(obj(obj(identity["global"])["user"])["resolved_name"], "采云用户");
    await copyFile(path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), path.join(root, "Inbox/Live(2).html"));
    const queue = await engine.request("archiver.sources.query", { offset: 0, limit: 200 }), plan = await engine.request("archiver.parse.plan", { sources: [items(queue)[0]!["capability"]!] });
    assert.deepEqual(await readdir(path.join(root, "Conversations")), []);
    const parsed = await engine.request("archiver.parse.commit", { plan: plan["plan"]! }); assert.equal(items(parsed)[0]!["status"], "created");
    assert(engine.events.some(e => { const bytes = obj(e["bytes"] ?? {})["completed"]; return typeof bytes === "number" && bytes > 0 && obj(e["file"])["index"] === 1; }), "the bundled worker must report actual within-file byte progress");
    assert(engine.events.some(e => obj(e["file"] ?? {})["completed"] === 1 && obj(e["file"])["total"] === 1), "the completion event must report this file, not merely a generic phase name");
    const simultaneous = await Promise.all([engine.request("archiver.sources.query", { offset: 0, limit: 200 }), engine.request("reader.archives.query", { offset: 0, limit: 200 }), engine.request("library.preferences.query"), engine.request("identity.query")]);
    assert.equal(simultaneous[0]!["total"], 1); assert.equal(simultaneous[1]!["total"], 1);
    const archives = await engine.request("reader.archives.query", { offset: 0, limit: 200 }), archive = items(archives)[0]!["capability"]!, info = await engine.request("reader.archive.info.query", { archive });
    const draft = obj(info["draft"]); draft["conversation_name"] = { state: "set", value: "User Mark title" };
    await engine.request("reader.archive.info.commit", { archive, expected_conversation: obj(info["revision"])["conversation"]!, expected_mark: obj(info["revision"])["mark"]!, draft, touch_on_noop: false });
    const page = { offset: 0, limit: 100 }, opened = await engine.request("reader.view.open", { archive, request: { messages: page, navigation: page, branches: page } }); assert.equal(typeof opened["token"], "string"); await engine.request("reader.view.close", { view: opened["token"]! });
    await engine.request("library.preferences.commit", { expected_revision: preferences["revision"]!, theme: "star-night", language: "en" });
    await engine.close(); engine = await start(root, script);
    assert.equal((await engine.request("library.startup.recover"))["status"], "valid"); const reopened = await engine.request("library.preferences.query"); assert.equal(reopened["theme"], "star-night"); assert.equal(reopened["theme_switched"], true); assert.equal(reopened["user_name"], "User");
    assert.equal(items(await engine.request("reader.archives.query", { offset: 0, limit: 200 }))[0]!["title"], "User Mark title"); assert.deepEqual(await readFile(path.join(root, "Identities/identity-settings.json")), subjectBefore);
    const conversation = JSON.parse(await readFile(path.join(root, "Conversations", (await readdir(path.join(root, "Conversations")))[0]!), "utf8")); assert.equal(conversation.schema, "cloudig/conversation/1.0.0"); assert(conversation.conversation_id); assert(!Object.hasOwn(conversation, "user")); assert(!Object.hasOwn(conversation, "content_time"));
    for (const old of ["cloudig-library.json", "Data", "Library", "Device", "Cloudig"]) assert(!await lstat(path.join(root, old)).catch(() => undefined));
  } finally { await engine.close(); }
}));

test("production startup preserves old formats and pending transactions until an explicit recovery command", async () => temporary(async (root, script) => {
  await writeFile(path.join(root, "cloudig-library.json"), '{"legacy":"keep"}\n'); let engine = await start(root, script);
  try { assert.equal((await engine.request("library.startup.recover"))["status"], "unsupported"); await assert.rejects(engine.request("library.create"), { code: "CLOUDIG_LIBRARY_ALREADY_EXISTS" }); assert.equal(await readFile(path.join(root, "cloudig-library.json"), "utf8"), '{"legacy":"keep"}\n'); }
  finally { await engine.close(); }
  // Only this test's own legacy sentinel is removed before creating a separate test state.
  await rm(path.join(root, "cloudig-library.json")); engine = await start(root, script);
  try {
    await engine.request("library.create"); const before = await readStoredRecord(root, "library", "CloudigLibrary.json"); obj(before.value["settings"])["language"] = "en";
    await assert.rejects(commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", expected: before.sha256, value: before.value }], { fault: point => { if (point === "displaced_0") throw new Error("simulated interruption"); } }));
    const pending = await pendingRecordOperations(root); assert.equal(pending.length, 1); const status = await engine.request("library.startup.recover"); assert.equal(status["status"], "transaction_recovery"); assert.deepEqual(status["operations"], pending);
    await engine.request("library.recovery.commit", { operation: pending[0]!, action: "rollback" }); assert.equal((await engine.request("library.preferences.query"))["language"], "zh-CN");
  } finally { await engine.close(); }
}));

test("production Engine refuses a detached cache root instead of creating a second storage tree", async () => temporary(async (root, script) => {
  const other = path.join(root, "elsewhere"), engine = await start(root, script, other);
  assert.equal(await engine.exited, 1); assert.match(engine.stderr(), /CLOUDIG_ENGINE_START_FAILED/u); assert(!await lstat(other).catch(() => undefined)); await engine.close();
}));
