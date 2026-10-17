import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { readRecordPreferences } from "../../../src/adapters/library-data/record-preferences.mts";
import { acquireSingleWriter, singleWriterEndpoint } from "../../../src/adapters/storage/writer-lock.mts";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";

test("a pending whole-root move blocks record access and new cache writes, while owned cache can still close", async () => {
  const base = path.resolve("tests/private/schema-rebuild"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "move-gate-")); let passed = false;
  try {
    await createRecordLibrary(root, { timestamp: "2026-09-11T12:00:00Z", anchor: { date: "2026-09-11", offset: "Z" } });
    const before = await readFile(path.join(root, "CloudigLibrary.json"));
    const cache = await createRuntimeCacheSession(path.join(root, "cache"), root);
    assert.match(await singleWriterEndpoint(root), /^\\\\\.\\pipe\\Cloudig-V1-Writer-[a-f0-9]{32}$/u);
    const lease = await acquireSingleWriter(root);
    await mkdir(path.join(root, "appdata/Move"), { recursive: true }); await writeFile(path.join(root, "appdata/Move/request.json"), '{"pending":true}'); await lease.release();
    await assert.rejects(acquireSingleWriter(root), { code: "CLOUDIG_LIBRARY_MOVE_PENDING" });
    await assert.rejects(readRecordPreferences(root), { code: "CLOUDIG_LIBRARY_MOVE_PENDING" });
    await assert.rejects(cache.ensure(), { code: "CLOUDIG_LIBRARY_MOVE_PENDING" });
    await assert.rejects(createRuntimeCacheSession(path.join(root, "cache"), root), { code: "CLOUDIG_LIBRARY_MOVE_PENDING" });
    await cache.close(); assert(!await lstat(cache.root).catch(() => undefined));
    assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), before);
    await rm(path.join(root, "appdata/Move/request.json")); assert.equal((await readRecordPreferences(root)).library["schema"], "cloudig/library/1.0.0"); passed = true;
  } finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } }
});
