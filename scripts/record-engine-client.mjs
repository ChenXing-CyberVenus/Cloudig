import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { ENGINE_PROTOCOL, assertIpcValue } from "../src/engine/protocol.mts";

/** Test/evidence client for the actual packaged Engine, not source-handler mocks. */
export function startRecordEngine({ packageRoot, libraryRoot, timeoutMs = 180000 }) {
  const program = path.join(packageRoot, "app");
  const child = spawn(path.join(program, "runtime/node/node.exe"), [path.join(program, "engine/engine.mjs"), "--library-root", libraryRoot, "--cache-root", path.join(libraryRoot, "cache")], {
    cwd: packageRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map(); let ordinal = 0, stderr = "";
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  const exited = new Promise((resolve, reject) => {
    child.once("error", error => { fail(error); reject(error); });
    child.once("exit", (code, signal) => { fail(new Error(`Engine exited ${code}/${signal}: ${stderr}`)); resolve({ code, signal }); });
  });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr = (stderr + value).slice(-16384); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line); assertIpcValue(message);
      const p = pending.get(message.request); if (!p) return;
      if (message.kind === "event") { p.onEvent?.(message.event); return; }
      pending.delete(message.request); clearTimeout(p.timer);
      if (message.ok) p.resolve(message.result);
      else p.reject(Object.assign(new Error(`${p.command}: ${message.error?.message ?? "Engine request failed"}`), { code: message.error?.code, command: p.command }));
    } catch (error) { fail(error); }
  });
  const request = (command, payload = {}, onEvent) => new Promise((resolve, reject) => {
    assertIpcValue(payload); const id = `q_evidence_${++ordinal}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Engine request timed out: ${command}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, onEvent, timer, command });
    child.stdin.write(JSON.stringify({ protocol: ENGINE_PROTOCOL, kind: "request", request: id, command, payload }) + "\n", error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
  });
  return { request, pid: child.pid, exited, async close() {
    if (child.exitCode === null && child.signalCode === null) {
      try { await request("engine.shutdown"); }
      finally {
        child.stdin.end(); const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    await exited; lines.close(); fail(new Error("Evidence client closed"));
  } };
}
