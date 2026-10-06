import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createLocalLibrary, updateSystemLog } from "../../../src/adapters/library-data/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { SystemLogEngineCommands } from "../../../src/engine/system-log-commands.mts";
import { isMissingSystemLogFile } from "../../../src/adapters/library-data/system-log.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";

const CREATE = {
  transaction: `x_${"S".repeat(16)}`,
  timestamp: "2026-09-01T12:00:00.000Z",
  localDate: "2026-09-01",
  offset: "-07:00",
  language: "zh-CN" as const
};

const context = () => ({ request: `q_${"S".repeat(16)}`, signal: new AbortController().signal, emit: async () => undefined });

test("System Log commands list copy-safe facts and reveal only a current opaque file selection", async () => {
  const temporary = path.join(process.cwd(), "tmp"); await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-system-log-engine-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({ root, ...CREATE });
    await mkdir(path.join(root, "Inbox"), { recursive: true });
    await writeFile(path.join(root, "Inbox", "one.html"), "source", "utf8");
    await updateSystemLog(root, [{
      path: "Inbox/one.html",
      outcome: "errors",
      recordedAt: "2026-09-01T12:01:00.000Z",
      errors: [
        { source: "exporter", code: "capture-note", stage: "capture", message: "一个资源使用了静态降级", ref: "resource:3" },
        { source: "parser", code: "canonical-missing", message: "一个可见节点没有 canonical 对应项" }
      ]
    }]);
    let ordinal = 0;
    const commands = new SystemLogEngineCommands({
      libraryRoot: root,
      fileToken: () => `sl_${String(++ordinal).padStart(43, "0")}`
    });
    const handlers = commands.handlers();
    const listed = await handlers["systemLog.list"]!({ offset: 0, limit: 20 }, context()) as JsonObject;
    assert.equal(listed["total"], 1);
    const item = (listed["items"] as JsonObject[])[0]!;
    assert.equal(item["path"], "Inbox/one.html");
    assert.deepEqual((item["errors"] as JsonObject[]).map((error) => error["code"]), ["capture-note", "canonical-missing"]);
    assert.doesNotMatch(JSON.stringify(listed), /[A-Za-z]:\\|file:\/\//u);
    assert.deepEqual(await handlers["systemLog.reveal"]!({ file: item["capability"]! }, context()), { path: "Inbox/one.html" });

    await updateSystemLog(root, [{ path: "Inbox/one.html", outcome: "success_no_errors" }]);
    await assert.rejects(
      () => handlers["systemLog.reveal"]!({ file: item["capability"]! }, context()),
      /stale|changed/iu
    );
    assert.deepEqual(await handlers["systemLog.list"]!({ offset: 0, limit: 20 }, context()), { offset: 0, limit: 20, total: 0, items: [] });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("log cleanup is explicit or confirmed-missing, preserves files, and rejects a replaced log token", async () => {
  const temporary = path.join(process.cwd(), "tmp"); await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-log-cleanup-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({ root, ...CREATE });
    await writeFile(path.join(root, "Inbox/one.html"), "source remains");
    await writeFile(path.join(root, "Conversations/one.json"), "archive remains");
    const error = (file: string, code = "old") => ({ path: file, outcome: "errors" as const, recordedAt: CREATE.timestamp, errors: [{ source: "parser", code, message: code }] });
    await updateSystemLog(root, [error("Inbox/one.html"), error("Inbox/gone.html"), error("Conversations/one.json")]);
    const handlers = new SystemLogEngineCommands({ libraryRoot: root }).handlers();
    const list = async () => await handlers["systemLog.list"]!({ offset: 0, limit: 200 }, context()) as JsonObject;
    let model = await list(); assertIpcValue(model); assert.equal(model["total"], 2);
    const old = (model["items"] as JsonObject[]).find(item => item["path"] === "Inbox/one.html")!;
    await rm(path.join(root, "Conversations/one.json"));
    model = await list(); assert.equal(model["total"], 1, "deleting the archive must not remove its existing HTML source log");
    await updateSystemLog(root, [error("Inbox/one.html", "new")]);
    await assert.rejects(handlers["systemLog.delete"]!({ file: old["capability"]! }, context()), /changed/iu);
    model = await list();
    const selected = (model["items"] as JsonObject[])[0]!;
    const deleted = await handlers["systemLog.delete"]!({ file: selected["capability"]! }, context()); assertIpcValue(deleted);
    assert.equal((await list())["total"], 0);
    assert.equal(await readFile(path.join(root, "Inbox/one.html"), "utf8"), "source remains");
    await updateSystemLog(root, [error("Inbox/one.html")]);
    assert.deepEqual(await handlers["systemLog.clear"]!({}, context()), { status: "written", removed: 1 });
    assert.equal((await list())["total"], 0);
    assert.equal(await readFile(path.join(root, "Inbox/one.html"), "utf8"), "source remains");
    assert.equal(isMissingSystemLogFile(Object.assign(new Error(), { code: "ENOENT" })), true);
    for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) assert.equal(isMissingSystemLogFile(Object.assign(new Error(), { code })), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});
