import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assertOfflineShell, currentBookmarkBuild, hashInputs, visualCoverageComplete } from "../../../scripts/v1-release-preflight.mjs";
import { extractRealLibraryResult, journeyPackageFingerprint } from "../../../scripts/run-v1-real-library-evidence.mjs";
import { percentile, parseBenchmarkArgs, benchmarkEvidenceSchema, matchingBenchmarkJourney } from "../../../scripts/run-v1-release-benchmark.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("offline shell gate distinguishes explicit browser links from fetched dependencies", async () => {
  const contact = '<a href="https://example.org/comments" target="_blank" rel="noopener noreferrer">Contact</a>';
  assert.doesNotThrow(() => assertOfflineShell(`<template>${contact}</template><img src="/local.svg"><img src="https://cloudig-runtime.local/resource">`));
  assert.doesNotThrow(() => assertOfflineShell('<meta content="img-src https://cloudig-runtime.local; connect-src https://cloudig-runtime.local">'));
  assert.doesNotThrow(() => assertOfflineShell('<meta content="frame-src https://cloudig-work.invalid"><iframe src="https://cloudig-work.invalid/runtime/interactive-frame.html"></iframe>'));
  assert.doesNotThrow(() => assertOfflineShell('<meta content="frame-src https://cloudig-map.local"><iframe src="https://cloudig-map.local/runtime/map-frame.html"></iframe>'));
  const currentShell = await readFile("src/ui/shell/index.html", "utf8");
  assert.doesNotThrow(() => assertOfflineShell(currentShell));
  for (const fragment of [
    '<img src="https://example.org/image.png">', '<script src="https://example.org/main.js"></script>',
    '<link href="https://example.org/theme.css" rel="stylesheet">', '<style>div{background:url(https://example.org/image.png)}</style>',
    '<img src="https://cloudig-runtime.local.example.org/image.png">', '<img src="//manager/old.png">',
    '<iframe src="https://cloudig-work.invalid.example.org/runtime/interactive-frame.html"></iframe>',
    '<iframe src="http://cloudig-work.invalid/runtime/interactive-frame.html"></iframe>',
    '<iframe src="https://user@cloudig-work.invalid/runtime/interactive-frame.html"></iframe>',
    '<iframe src="https://cloudig-map.local.attacker.test/runtime/map-frame.html"></iframe>',
    contact.replace('target="_blank"', ''), contact.replace('noopener noreferrer', 'noopener'), contact.replace('https:', 'http:')
  ]) assert.throws(() => assertOfflineShell(fragment));
});

test("release input hashing is path-stable, deterministic and byte-sensitive", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "cloudig-v1-preflight-"));
  try {
    await mkdir(path.join(root, "contracts", "nested"), { recursive: true });
    await writeFile(path.join(root, "contracts", "a.json"), "{\"a\":1}\n", "utf8");
    await writeFile(path.join(root, "contracts", "nested", "b.json"), "{\"b\":2}\n", "utf8");
    const first = hashInputs(root, ["contracts"]);
    const second = hashInputs(root, ["contracts/nested", "contracts/a.json"]);
    assert.equal(first.file_count, 2);
    assert.equal(first.aggregate_sha256, second.aggregate_sha256);
    assert.deepEqual(first.files.map((entry) => entry.path), ["contracts/a.json", "contracts/nested/b.json"]);
    assert.equal(first.files[0].sha256, sha256(await readFile(path.join(root, "contracts", "a.json"))));
    await writeFile(path.join(root, "contracts", "a.json"), "{\"a\":3}\n", "utf8");
    assert.notEqual(hashInputs(root, ["contracts"]).aggregate_sha256, first.aggregate_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release input hashing refuses paths outside the project", () => {
  assert.throws(() => hashInputs(process.cwd(), ["../outside"]), /stay inside|escaped/iu);
});

test("source provenance ignores native build outputs while package hashing still includes them", async () => {
  const parent = path.resolve("tests/private/schema-rebuild"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "source-inputs-"));
  try {
    const source = "src/desktop/Cloudig.Desktop/MainWindow.cs", generated = "src/desktop/Cloudig.Desktop/obj/output.dll";
    await mkdir(path.join(root, "src/desktop/Cloudig.Desktop/obj"), { recursive: true });
    await writeFile(path.join(root, source), "source"); await writeFile(path.join(root, generated), "build A");
    const first = hashInputs(root, ["src"], { excludeNativeBuildOutputs: true });
    const all = hashInputs(root, ["src"]);
    assert.deepEqual(first.files.map(file => file.path), [source]);
    await writeFile(path.join(root, generated), "build B");
    assert.equal(hashInputs(root, ["src"], { excludeNativeBuildOutputs: true }).aggregate_sha256, first.aggregate_sha256);
    assert.notEqual(hashInputs(root, ["src"]).aggregate_sha256, all.aggregate_sha256);
    await writeFile(path.join(root, source), "changed source");
    assert.notEqual(hashInputs(root, ["src"], { excludeNativeBuildOutputs: true }).aggregate_sha256, first.aggregate_sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release accepts only a package built from the current accepted bookmark set", () => {
  assert.equal(currentBookmarkBuild({ bookmarks: { mode: "current" } }), true);
  assert.equal(currentBookmarkBuild({ bookmarks: { mode: "reused-accepted" } }), false);
  assert.equal(currentBookmarkBuild({}), false);
});

test("release and local test entry use the flat new-schema package without consuming the old test Library", async () => {
  const spec = JSON.parse(await readFile("release/v1-preflight-spec.json", "utf8"));
  for (const file of ["Cloudig.exe", "app/Cloudig.dll", "app/engine/engine.mjs", "app/engine/record-parser-worker.mjs", "app/web/index.html", "app/runtime/node/node.exe", "bookmarks/bookmark-package.json", "docs/third-party-inventory.json"]) assert(spec.required_package_files.includes(file));
  assert(!spec.required_package_files.some(file => /^(?:engine|web|runtime)\//u.test(file)));
  assert(spec.contract_inputs.includes("src/core/records"));
  assert.equal(spec.candidate_files.build_provenance, `${spec.package_root}/app/build-provenance.json`);
  const launcher = await readFile("启动当前采云测试版.cmd", "utf8");
  assert.match(launcher, /CLOUDIG_TEST_DATA=%PROJECT_ROOT%tests\\private\\v1-library/u);
  assert.doesNotMatch(launcher, /set "CLOUDIG_TEST_DATA=[^\r\n]*\.\.\\Cloudig-Test/u);
});

test("partial new screenshots cannot replace full release coverage or hide missing combinations", () => {
  const expected = { scenarios: 8, surfaces: 2, required_surfaces: ["reader", "archiver"], themes: ["dawn", "star-night"], languages: ["zh-CN", "en"], viewports: ["1920x1080"] };
  const rows = expected.required_surfaces.flatMap(surface => expected.themes.flatMap(theme => expected.languages.map(language => ({ surface, theme, language, viewport: { width: 1920, height: 1080 } }))));
  assert.equal(visualCoverageComplete(rows, expected), true);
  assert.equal(visualCoverageComplete(rows.slice(0, 4), expected), false);
  assert.equal(visualCoverageComplete([...rows.slice(0, -1), rows[0]], expected), false);
  assert.equal(visualCoverageComplete(rows.map(row => ({ ...row, surface: row.surface === "archiver" ? "other" : row.surface })), expected), false);
});

test("real Library evidence rejects a skipped zero-work test", () => {
  const result = JSON.stringify({ sample_files: 37, execution: "packaged-record-engine", package_engine: { sha256: "a".repeat(64) }, source_originals_unchanged: true }) + "\nℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0\n";
  assert.equal(extractRealLibraryResult(result).result.sample_files, 37);
  assert.throws(
    () => extractRealLibraryResult(result.replace("skipped 0", "skipped 1")),
    /not a true non-skipped pass/iu
  );
  assert.throws(() => extractRealLibraryResult(result.replace("packaged-record-engine", "source-handlers")), /packaged record Engine/u);
});

test("real Library package evidence detects managed-host/UI changes even when the apphost EXE is unchanged", async () => {
  const parent = path.resolve("tests/private/schema-rebuild"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "journey-fingerprint-"));
  try {
    await mkdir(path.join(root, "app/engine"), { recursive: true });
    for (const file of ["Cloudig.exe", "app/Cloudig.dll", "app/engine/engine.mjs", "app/engine/record-parser-worker.mjs"]) await writeFile(path.join(root, file), file);
    const before = journeyPackageFingerprint(root, root);
    await writeFile(path.join(root, "app/Cloudig.dll"), "changed managed host");
    const after = journeyPackageFingerprint(root, root);
    assert.equal(before.executable.sha256, after.executable.sha256);
    assert.notEqual(before.program.aggregate_sha256, after.program.aggregate_sha256);
  } finally { await rm(root, { recursive: true }); }
});

test("release benchmark percentiles use nearest-rank ordering", () => {
  assert.equal(percentile([9, 1, 5, 3, 7], 0.5), 5);
  assert.equal(percentile([9, 1, 5, 3, 7], 0.95), 9);
  assert.throws(() => percentile([], 0.5), /requires samples/iu);
});

test("engineering measurements cannot masquerade as clean release benchmark evidence", () => {
  assert.equal(benchmarkEvidenceSchema(), "cloudig/release-benchmark/1.0.0");
  assert.equal(benchmarkEvidenceSchema(true), "cloudig/engineering-benchmark/1.0.0");
  const release = parseBenchmarkArgs([]), engineering = parseBenchmarkArgs(["--engineering"]);
  assert.equal(release.engineering, false); assert.equal(engineering.engineering, true);
  assert.notEqual(engineering.output, release.output);
  assert.equal(parseBenchmarkArgs(["--engineering", "--output", "tmp/measurement.json"]).output, path.resolve("tmp/measurement.json"));
  assert.throws(() => parseBenchmarkArgs(["--skip-clean"]), /Usage/u);
});

test("a benchmark never borrows a legacy or differently packaged Library journey", () => {
  const packaged = { program: { aggregate_sha256: "p" }, executable: { sha256: "a" }, engine: { sha256: "b" }, worker: { sha256: "c" } };
  const journey = { status: "passed", run_id: "run", package: structuredClone(packaged), outcome: { duration_ms: 3 }, result: { execution: "packaged-record-engine", sample_files: 37, claude: { records: 348 } } };
  assert.equal(matchingBenchmarkJourney(journey, packaged).claude_records, 348);
  assert.equal(matchingBenchmarkJourney({ ...journey, package: undefined }, packaged), null);
  assert.equal(matchingBenchmarkJourney({ ...journey, result: { ...journey.result, execution: undefined } }, packaged), null);
  journey.package.program.aggregate_sha256 = "older";
  assert.equal(matchingBenchmarkJourney(journey, packaged), null);
});
