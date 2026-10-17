import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = file => readFileSync(`scripts/${file}.ps1`, "utf8");

test("installer builder selects the named signed candidate before reading its manifest", () => {
  const source = read("build-windows-installer");
  assert.match(source, /\[ValidatePattern\('\^\[a-z0-9\]\[a-z0-9-\]\{0,63\}\$'\)\]\[string\]\$CandidateName/u);
  const route = source.indexOf("$versionRoot = Join-Path $versionRoot $CandidateName");
  assert(route > 0 && route < source.indexOf("$before = Get-Content"));
  assert(source.includes('Cloudig-$Version-Setup.exe'));
  assert(!source.includes('Setup-$CandidateName'));
  assert(source.includes("Existing receipt is immutable"));
  assert(source.includes("Never overwrite a signing handoff"));
});

test("native and final verification isolate candidate evidence and temporary installation paths", () => {
  for (const file of ["test-windows-installer-native", "verify-windows-release"]) {
    const source = read(file);
    assert(source.includes("[string]$CandidateName"));
    assert(source.includes("CandidateName and historical InstallerRevision cannot be combined"));
    assert(source.includes('$scope += "-$CandidateName"'));
  }
  const native = read("test-windows-installer-native");
  assert(native.indexOf('$release += "/$CandidateName"') < native.indexOf("$evidence ="));
  const final = read("verify-windows-release");
  assert(final.indexOf("$releaseRoot = Join-Path $releaseRoot $CandidateName") < final.indexOf("$before = Get-Content"));
  assert(final.includes("$candidateArgs.CandidateName = $CandidateName"));
  assert(final.includes("-Version $Version @candidateArgs"));
  assert(final.includes("Existing receipt is immutable"));
});

test("portable journey uses the same candidate for the native installer and a specified previous release", () => {
  const source = readFileSync("scripts/test-windows-installer.mjs", "utf8");
  assert(source.includes("process.argv.indexOf('--candidate')"));
  assert(source.includes('path.resolve(`releases/${version}`, candidate)'));
  assert(source.includes("args.push('-CandidateName', candidate)"));
  assert(source.includes("process.argv.indexOf('--from-version')"));
  assert(source.includes("process.argv.indexOf('--from-candidate')"));
  assert(source.includes('assert.match(previousCandidate, /^[a-z0-9][a-z0-9-]{0,63}$/u)'));
  assert(source.includes('path.resolve(`releases/${previousVersion}`, previousCandidate)'));
  assert(source.includes("path.join(previousRelease, 'Cloudig')"));
  assert(source.includes("path.join(previousRelease, 'SHA256-signed-payload.json')"));
  assert(source.includes('assert.equal(previous.product_version, previousVersion)'));
  assert(source.includes("from_candidate: previousCandidate || null"));
  assert(source.includes("from_source_build: previous.source_build.commit"));
});
