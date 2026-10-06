import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildV1BookmarkPackage } from "../../../scripts/build-v1-bookmark-package.mjs";
import { currentBookmarkletBuildTargets } from "../../../scripts/build-current-bookmarklets.mjs";
import { bookmarkSetVersion } from "../../../scripts/bookmarklet-targets.mjs";

const projectRoot = process.cwd();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("V1 package freezes the current accepted 12/12/8 bookmarklet bytes without rebuilding them", async () => {
  const temporary = path.join(projectRoot, "tmp");
  await mkdir(temporary, { recursive: true });
  const scope = await mkdtemp(path.join(temporary, "cloudig-v1-bookmarks-"));
  const output = path.join(scope, "bookmarks");
  try {
    const manifest = await buildV1BookmarkPackage(output, { projectRoot });
    assert.equal(manifest.bookmark_set_version, bookmarkSetVersion);
    assert.equal(manifest.platform_count, 12);
    assert.equal(manifest.variant_count, 32);
    assert.deepEqual(manifest.profiles, ["light", "full", "all_branches"]);
    assert.equal(manifest.platforms.filter((platform) => platform.fallback).length, 4);

    const sourceById = new Map(currentBookmarkletBuildTargets.map((target) => [
      target.id.replace(":all-branches", ":all_branches"),
      target
    ]));
    for (const platform of manifest.platforms) {
      for (const variant of platform.variants) {
        const source = sourceById.get(variant.id);
        assert.ok(source, `missing current source for ${variant.id}`);
        const sourceBytes = await readFile(path.join(projectRoot, "bookmarklets", ...source.min.split("/")));
        const packagedBytes = await readFile(path.join(output, "artifacts", ...variant.artifact.split("/")));
        assert.deepEqual(packagedBytes, sourceBytes, `${variant.id} bytes changed in packaging`);
        assert.equal(variant.sha256, sha256(sourceBytes));
        assert.equal(variant.bytes, sourceBytes.byteLength);
      }
    }
  } finally {
    await rm(scope, { recursive: true, force: true });
  }
});
