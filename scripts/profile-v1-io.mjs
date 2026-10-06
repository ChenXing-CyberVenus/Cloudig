// Opt-in benchmark preload only; never included in the desktop package.
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { threadId } from "node:worker_threads";
const totals = new Map();
const wrap = (owner, key, label = key) => {
  const original = owner[key];
  owner[key] = async function(...args) {
    const started = performance.now();
    try {
      const result = await original.apply(this, args);
      if (key === "open") for (const method of ["sync", "write", "writeFile", "readFile", "stat", "close"]) wrap(result, method, `handle.${method}`);
      return result;
    } finally {
      const entry = totals.get(label) ?? { count: 0, ms: 0 };
      entry.count++; entry.ms += performance.now() - started; totals.set(label, entry);
    }
  };
};
for (const name of ["realpath", "lstat", "stat", "readdir", "readFile", "writeFile", "open", "unlink", "rename", "link", "mkdir", "rm"]) wrap(fs, name);
syncBuiltinESMExports();
let written = false;
process.on("beforeExit", () => {
  if (written) return; written = true;
  const report = { pid: process.pid, thread: threadId, io: [...totals].sort((a, b) => b[1].ms - a[1].ms).map(([operation, facts]) => ({ operation, count: facts.count, ms: Math.round(facts.ms) })), memory: process.memoryUsage(), usage: process.resourceUsage() };
  if (threadId === 0) process.stderr.write(`CLOUDIG_IO_PROFILE ${JSON.stringify(report)}\n`);
});
