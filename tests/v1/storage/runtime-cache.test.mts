import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
import policy from "../../../src/core/contracts/machine/cache-policy.json" with { type: "json" };
import { validateCachePolicySchema } from "../../../src/core/contracts/schema-registry.mts";

async function scope() {
  await mkdir(path.join(process.cwd(), "tmp"), { recursive: true });
  const base = await mkdtemp(path.join(process.cwd(), "tmp", "runtime-cache-"));
  await mkdir(path.join(base, "Library"));
  return { base, cache: path.join(base, "cache"), library: path.join(base, "Library") };
}

test("cache policy is explicit and cannot reclassify indexes or user state", () => {
  assert.equal(validateCachePolicySchema(policy).ok, true);
  assert.equal(validateCachePolicySchema({ ...policy, directory: "Data/Indexes" }).ok, false);
  assert.equal(validateCachePolicySchema({ ...policy, persistent_reuse: true }).ok, false);
  assert.equal(validateCachePolicySchema({ ...policy, archive: "a1" }).ok, false);
});

test("cache owners isolate Libraries, never remove a live owner and plateau after repeated runs", async () => {
  const s = await scope();
  try {
    await mkdir(path.join(s.library, "Data", "Indexes"), { recursive: true });
    const binding = path.join(s.library, "Data", "Indexes", "binding.json");
    await writeFile(binding, "preserve source/version binding");
    const first = await createRuntimeCacheSession(s.cache, s.library);
    await writeFile(path.join(first.root, "work.bin"), Buffer.alloc(10000));
    const second = await createRuntimeCacheSession(s.cache, s.library);
    assert.equal((await readFile(path.join(first.root, "work.bin"))).length, 10000);
    await mkdir(path.join(s.base, "OtherLibrary"));
    const other = await createRuntimeCacheSession(s.cache, path.join(s.base, "OtherLibrary"));
    assert.notEqual(first.root, other.root);
    assert.notEqual(JSON.parse(await readFile(path.join(first.root, "owner.json"), "utf8")).library_key, JSON.parse(await readFile(path.join(other.root, "owner.json"), "utf8")).library_key);
    await second.close(); await other.close();
    for (let index = 0; index < 12; index++) {
      const next = await createRuntimeCacheSession(s.cache, s.library);
      await writeFile(path.join(next.root, "work.bin"), Buffer.alloc(5000));
      await next.close();
      assert.deepEqual(await readdir(path.dirname(first.root)), [path.basename(first.root)]);
    }
    // Simulates the user deleting disposable bytes while the Engine remains alive.
    await rm(first.root, { recursive: true });
    await Promise.all([first.ensure(), first.ensure(), first.ensure()]);
    assert.equal(JSON.parse(await readFile(path.join(first.root, "owner.json"), "utf8")).session, path.basename(first.root));
    await first.close();
    await rm(s.cache, { recursive: true });
    const reopened = await createRuntimeCacheSession(s.cache, s.library);
    assert.equal(await readFile(binding, "utf8"), "preserve source/version binding");
    await reopened.close();
    const changed = await createRuntimeCacheSession(s.cache, s.library);
    await writeFile(path.join(changed.root, "owner.json"), JSON.stringify({ schema: "unknown", session: "not-ours" }));
    await changed.close();
    assert.ok((await readdir(path.dirname(changed.root))).includes(path.basename(changed.root)), "changed ownership is retained, not swept on close");
    const unknown = path.join(path.dirname(changed.root), `s_${"a".repeat(32)}`); await mkdir(unknown); await writeFile(path.join(unknown, "owner.json"), "null");
    const afterUnknown = await createRuntimeCacheSession(s.cache, s.library); await afterUnknown.close();
    assert.equal(await readFile(path.join(unknown, "owner.json"), "utf8"), "null", "unknown stale ownership does not prevent startup and is not deleted");
  } finally { await rm(s.base, { recursive: true, force: true }); }
});

test("a moved Library never regrows its old root, and moved cache still respects the original live lease", async () => {
  const s = await scope(); const moved = path.join(s.base, "Moved");
  const first = await createRuntimeCacheSession(path.join(s.library, "cache"), s.library);
  try {
    await writeFile(path.join(first.root, "work.bin"), "live disposable bytes");
    const relative = path.relative(s.library, first.root);
    await rename(s.library, moved);
    await assert.rejects(first.ensure(), { code: "CLOUDIG_LIBRARY_ROOT_CHANGED" });
    assert(!await lstat(s.library).catch(() => undefined));
    const second = await createRuntimeCacheSession(path.join(moved, "cache"), moved);
    assert.equal(await readFile(path.join(moved, relative, "work.bin"), "utf8"), "live disposable bytes");
    await first.close();
    const third = await createRuntimeCacheSession(path.join(moved, "cache"), moved);
    assert(!await lstat(path.join(moved, relative)).catch(() => undefined));
    await second.close(); await third.close();
    assert(!await lstat(s.library).catch(() => undefined));
  } finally { await first.close(); await rm(s.base, { recursive: true, force: true }); }
});

test("after a forced Engine exit only its proven stale cache is reclaimed", async () => {
  const s = await scope();
  const child = spawn(process.execPath, ["tests/v1/helpers/cache-owner.mts", s.cache, s.library], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.setEncoding("utf8");
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", value => { output += value; if (output.includes("\n")) resolve(output.trim()); });
    child.once("error", reject);
    child.once("exit", code => { if (!output.includes("\n")) reject(new Error(`Cache helper exited ${code}`)); });
  });
  try {
    const old = await ready;
    const alive = await createRuntimeCacheSession(s.cache, s.library);
    assert.ok((await readdir(path.dirname(old))).includes(path.basename(old)));
    const exit = once(child, "exit"); child.kill(); await exit;
    const next = await createRuntimeCacheSession(s.cache, s.library);
    assert.equal((await readdir(path.dirname(old))).includes(path.basename(old)), false);
    assert.ok((await readdir(path.dirname(alive.root))).includes(path.basename(alive.root)));
    await alive.close(); await next.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    await rm(s.base, { recursive: true, force: true });
  }
});
