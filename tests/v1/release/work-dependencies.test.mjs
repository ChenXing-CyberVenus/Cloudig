import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildWorkDependencies } from "../../../scripts/build-v1-work-dependencies.mjs";

test("saved work payload ships manifest fonts only, with pinned bytes and original licenses", async () => {
  const root = process.cwd(); await mkdir(path.join(root, "tmp"), { recursive: true });
  const output = await mkdtemp(path.join(root, "tmp", "work-dependencies-"));
  try {
    await buildWorkDependencies(root, output);
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    const expected = [...new Set(manifest.fonts.flatMap(font => [path.basename(font.file), path.basename(font.license)]))].sort();
    assert.deepEqual((await readdir(path.join(output, "fonts"))).sort(), expected);
    assert(!expected.includes("NotoSerifSC-400.ttf")); assert(!expected.includes("NotoSerifSC-700.ttf"));
    for (const font of manifest.fonts) assert.equal(createHash("sha256").update(await readFile(path.join(output, font.file))).digest("hex"), font.sha256);
  } finally { await rm(output, { recursive: true, force: true }); }
});
