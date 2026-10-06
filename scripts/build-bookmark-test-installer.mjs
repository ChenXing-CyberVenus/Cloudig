import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const project = process.cwd();
const dotnet = process.env.CLOUDIG_DOTNET ?? path.join(project, "manager/.cache/dotnet/dotnet.exe");
const workerRoot = path.join(project, "manager/windows/Cloudig.BookmarkTestInstaller/bin/Release/net10.0-windows/win-x64/publish");
function run(file, argumentsList) {
  const result = spawnSync(file, argumentsList, { cwd: project, encoding: "utf8", windowsHide: true, env: { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
run(dotnet, ["publish", "manager/windows/Cloudig.BookmarkTestInstaller/Cloudig.BookmarkTestInstaller.csproj", "-c", "Release", "--no-restore", "--nologo", "-o", workerRoot]);
const worker = path.join(workerRoot, "Cloudig.BookmarkTestInstaller.exe");
assert.equal((await readdir(workerRoot)).some(file => file.endsWith(".dll")), false, "Standalone installer must remain a single EXE without extracted native dependencies");
console.log(JSON.stringify({ output: worker, bytes: (await stat(worker)).size }));
