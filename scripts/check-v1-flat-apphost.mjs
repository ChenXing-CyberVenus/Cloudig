import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, lstat, rm } from "node:fs/promises";
import path from "node:path";

const repository = process.cwd(), base = path.join(repository, "tests/private/schema-rebuild");
const dotnet = process.env.CLOUDIG_DOTNET || path.join(repository, "manager/.cache/dotnet/dotnet.exe");
const node = path.join(repository, "manager/.cache/node-v24.18.0-win-x64/node.exe");
await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "native-flat-")); let passed = false;
function run(file, args) {
  const result = spawnSync(file, args, { cwd: repository, windowsHide: true, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  run(dotnet, ["publish", "src/desktop/Cloudig.Desktop.Tests/Cloudig.Desktop.Tests.csproj", "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-p:PublishSingleFile=false", "-p:NuGetAudit=false", `-p:CloudigPortableRoot=${root}`, "-o", path.join(root, "app"), "--nologo"]);
  assert.deepEqual((await readdir(root)).sort(), ["Cloudig.Desktop.Tests.exe", "app"]);
  assert(!(await readdir(path.join(root, "app"))).includes("Cloudig.Desktop.Tests.exe"));
  assert.match(run(path.join(root, "Cloudig.Desktop.Tests.exe"), [node]), /Cloudig desktop core checks passed/u);
  passed = true; console.log("Native root apphost + app-local runtime passed; no visible window or global .NET installation used.");
} finally {
  if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); }
  else console.error(`Preserved native package test: ${root}`);
}
