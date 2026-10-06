import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("single-file installer needs no native extraction and its storage probe never touches Chrome", async () => {
  await mkdir("tmp", { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), "tmp", "installer-storage-"));
  const executable = path.join(process.cwd(), "manager/windows/Cloudig.BookmarkTestInstaller/bin/Release/net10.0-windows/win-x64/publish/Cloudig.BookmarkTestInstaller.exe");
  try {
    for (let index = 0; index < 3; index++) {
      const report = path.join(root, `probe-${index}.txt`);
      const extractionRoot = path.join(root, "cache", "native");
      const child = spawn(executable, ["--data-root", root, "--storage-probe", report], { windowsHide: true, stdio: "ignore", env: { ...process.env, DOTNET_BUNDLE_EXTRACT_BASE_DIR: extractionRoot } });
      const [code] = await once(child, "exit");
      assert.equal(code, 0, "noninteractive installer storage probe failed");
      const [data, extraction, count] = (await readFile(report, "utf8")).trim().split(/\r?\n/u);
      assert.equal(data, root);
      assert.equal(extraction, extractionRoot);
      assert.equal(Number(count), 0, "the published installer must require no extracted native files");
      assert.deepEqual((await readdir(root)).sort(), Array.from({ length: index + 1 }, (_, value) => `probe-${value}.txt`));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
