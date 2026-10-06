import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { observeAuxiliarySnapshot, writeAuxiliarySnapshot } from "../../../src/adapters/storage/auxiliary.mts";

test("auxiliary snapshots plateau and failed writes leave no owned temporary file", async () => {
  const base = path.join(process.cwd(), "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "disk-lifecycle-"));
  const relative = "Data/Indexes/Catalog/snapshot.json";
  try {
    for (let index = 0; index < 24; index++) {
      const expected = await observeAuxiliarySnapshot(root, relative);
      assert.equal(await writeAuxiliarySnapshot(root, relative, Buffer.from(JSON.stringify({ index })), expected), "written");
      assert.deepEqual(await readdir(path.join(root, "Data/Indexes/Catalog")), ["snapshot.json"]);
    }
    assert.equal(await writeAuxiliarySnapshot(root, relative, Buffer.from("conflict"), undefined), "conflict");
    assert.deepEqual(await readdir(path.join(root, "Data/Indexes/Catalog")), ["snapshot.json"]);
    const directoryTarget = "Data/Indexes/Catalog/blocked.json";
    await mkdir(path.join(root, directoryTarget));
    await assert.rejects(writeAuxiliarySnapshot(root, directoryTarget, Buffer.from("failure"), undefined));
    assert.deepEqual((await readdir(path.join(root, "Data/Indexes/Catalog"))).sort(), ["blocked.json", "snapshot.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop and exact EXE audit do not depend on unbounded system extraction", async () => {
  const project = await readFile("src/desktop/Cloudig.Desktop/Cloudig.Desktop.csproj", "utf8");
  assert.match(project, /<IncludeNativeLibrariesForSelfExtract>false<\/IncludeNativeLibrariesForSelfExtract>/u);
  assert.doesNotMatch(project, /<IncludeAllContentForSelfExtract>true/u);
  const audit = await readFile("scripts/run-v1-visual-matrix.mjs", "utf8");
  assert.match(audit, /DOTNET_BUNDLE_EXTRACT_BASE_DIR: auditExtractRoot/u);
  assert.match(audit, /await exit;/u);
  assert.match(audit, /rm\(auditExtractRoot,/u);
});
