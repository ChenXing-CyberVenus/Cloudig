import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { acquireSingleWriter } from "../../../src/adapters/storage/writer-lock.mts";

test("ordinary same-process operations queue while explicit leases still exclude them", async () => {
  const parent = path.resolve("tests/private/schema-rebuild"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "writer-queue-"));
  try {
    const first = await acquireSingleWriter(root, { waitForLocal: true }); let acquired = false;
    const next = acquireSingleWriter(root, { waitForLocal: true }).then(lease => { acquired = true; return lease; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(acquired, false);
    await assert.rejects(acquireSingleWriter(root));
    await first.release(); const second = await next; assert.equal(acquired, true); await second.release(); await second.release();
    const explicit = await acquireSingleWriter(root);
    await assert.rejects(acquireSingleWriter(root, { waitForLocal: true }));
    await explicit.release();
    const again = await acquireSingleWriter(root, { waitForLocal: true }); await again.release();
  } finally { await rm(root, { recursive: true }); }
});
