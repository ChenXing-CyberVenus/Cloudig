import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, lstat, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { moveFileNoReplace } from "../../../src/adapters/storage/no-replace.mts";

test("Windows native no-replace moves Unicode bytes, refuses collisions/escape/links, consumes source", { skip: !process.env["CLOUDIG_FILE_MOVES_PIPE"] }, async () => {
  const parent = path.resolve("tests/private"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "native-move-")); let passed = false;
  try {
    const first = path.join(root, "甲.bin"), second = path.join(root, "乙.bin");
    await writeFile(first, Buffer.from([0, 255, 2, 3]));
    await moveFileNoReplace(first, second);
    assert.deepEqual(await readFile(second), Buffer.from([0, 255, 2, 3]));
    await assert.rejects(lstat(first), { code: "ENOENT" });
    await writeFile(first, "other"); await assert.rejects(moveFileNoReplace(first, second), { code: "EEXIST" });
    assert.equal(await readFile(first, "utf8"), "other");
    await assert.rejects(moveFileNoReplace(first, path.resolve("package.json")), /escaped/);
    await mkdir(path.join(root, "sub")); await symlink(path.join(root, "sub"), path.join(root, "alias"), "junction");
    await assert.rejects(moveFileNoReplace(first, path.join(root, "alias", "file")), /reparse/);
    // A burst also checks the one native server handles queued Engine operations.
    await Promise.all(Array.from({ length: 8 }, async (_, i) => { const source = path.join(root, `parallel-${i}`); await writeFile(source, String(i)); await moveFileNoReplace(source, source + ".moved"); assert.equal(await readFile(source + ".moved", "utf8"), String(i)); }));
    passed = true;
  } finally {
    if (passed && path.dirname(root) === parent) { await rm(path.join(root, "alias")); await rm(root, { recursive: true }); }
    else if (!passed) console.error("Retained native move test:", root);
  }
});
