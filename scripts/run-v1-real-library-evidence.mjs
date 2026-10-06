#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashInputs } from "./v1-release-preflight.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = "artifacts/v1-release/evidence/real-library-journey.json";

export function journeyPackageFingerprint(root, packageRoot = path.join(root, "artifacts/v1-desktop/app")) {
  const relative = path.relative(root, packageRoot).replaceAll("\\", "/");
  const prefix = relative ? `${relative}/` : "";
  const program = hashInputs(root, [`${prefix}app`]);
  const executable = hashInputs(root, [`${prefix}Cloudig.exe`]).files[0];
  const engine = program.files.find(file => file.path === `${prefix}app/engine/engine.mjs`);
  const worker = program.files.find(file => file.path === `${prefix}app/engine/record-parser-worker.mjs`);
  if (!engine || !worker) throw new Error("real Library journey requires the packaged record Engine and worker");
  return { executable, engine, worker, program: { path: `${prefix}app`, file_count: program.file_count, total_bytes: program.total_bytes, aggregate_sha256: program.aggregate_sha256 } };
}

async function hashStream(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export function extractRealLibraryResult(stdout) {
  const line = stdout.split(/\r?\n/u).find((entry) => /^\{"sample_files":/u.test(entry));
  if (!line) throw new Error("real Library journey did not emit its machine result");
  const result = JSON.parse(line);
  const count = (label) => {
    for (const outputLine of stdout.split(/\r?\n/u)) {
      const match = outputLine.trim().match(new RegExp(`(?:^|\\s)${label}\\s+(\\d+)$`, "u"));
      if (match) return Number(match[1]);
    }
    return null;
  };
  const tests = count("tests");
  const passed = count("pass");
  const failed = count("fail");
  const skipped = count("skipped");
  if (tests !== 1 || passed !== 1 || failed !== 0 || skipped !== 0) {
    throw new Error(`real Library journey was not a true non-skipped pass: tests=${tests} pass=${passed} fail=${failed} skipped=${skipped}`);
  }
  if (result.execution !== "packaged-record-engine" || !result.package_engine?.sha256 || result.source_originals_unchanged !== true) {
    throw new Error("real Library result must identify the packaged record Engine and unchanged originals");
  }
  return { result, node_test: { tests, passed, failed, skipped } };
}

async function sampleFingerprint(sampleRoot) {
  const names = (await readdir(sampleRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  const aggregate = createHash("sha256");
  let total = 0;
  for (const name of names) {
    const file = await hashStream(path.join(sampleRoot, name));
    total += file.bytes;
    aggregate.update(`${name}\0${file.bytes}\0${file.sha256}\n`);
  }
  return { file_count: names.length, total_bytes: total, aggregate_sha256: aggregate.digest("hex") };
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!value || !["--sample-root", "--claude-container", "--output"].includes(key)) {
      throw new Error("Usage: node scripts/run-v1-real-library-evidence.mjs --sample-root <directory> --claude-container <file> [--output <file>]");
    }
    values.set(key, value);
  }
  if (!values.has("--sample-root") || !values.has("--claude-container")) throw new Error("sample root and Claude container are required");
  return {
    sampleRoot: path.resolve(values.get("--sample-root")),
    claudeContainer: path.resolve(values.get("--claude-container")),
    output: path.resolve(defaultRoot, values.get("--output") ?? defaultOutput)
  };
}

async function runJourney(root, sampleRoot, claudeContainer) {
  const started = Date.now();
  const child = spawn(process.execPath, ["--test", "tests/v1/journey/real-library.test.mts"], {
    cwd: root,
    env: {
      ...process.env,
      CLOUDIG_REAL_SAMPLE_DIR: sampleRoot,
      CLOUDIG_REAL_CLAUDE_CONTAINER: claudeContainer,
      CLOUDIG_RECORD_PACKAGE_ROOT: path.join(root, "artifacts/v1-desktop/app"),
      CLOUDIG_KEEP_REAL_LIBRARY: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0 || exit.signal) throw new Error(`real Library journey failed: code=${exit.code} signal=${exit.signal ?? "none"}\n${stderr}`);
  return { ...extractRealLibraryResult(stdout), duration_ms: Date.now() - started, stdout_sha256: createHash("sha256").update(stdout).digest("hex") };
}

export async function runRealLibraryEvidence({ root = defaultRoot, sampleRoot, claudeContainer, output }) {
  const statusBefore = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (statusBefore) throw new Error("real Library evidence requires a clean source tree");
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const packaged = journeyPackageFingerprint(root);
  const waterlineFile = path.join(root, "src", "adapters", "parser", "contracts", "sample-waterline.json");
  const testFile = path.join(root, "tests", "v1", "journey", "real-library.test.mts");
  const waterline = JSON.parse(await readFile(waterlineFile, "utf8"));
  const [samples, container, waterlineHash, testHash] = await Promise.all([
    sampleFingerprint(sampleRoot),
    hashStream(claudeContainer),
    hashStream(waterlineFile),
    hashStream(testFile)
  ]);
  if (samples.file_count !== waterline.summary.files) throw new Error(`sample count ${samples.file_count} does not match waterline ${waterline.summary.files}`);
  const execution = await runJourney(root, sampleRoot, claudeContainer);
  const statusAfter = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (statusAfter) throw new Error("real Library journey changed tracked or unignored source files");
  if (JSON.stringify(journeyPackageFingerprint(root)) !== JSON.stringify(packaged)) throw new Error("packaged program changed during the real Library journey");
  if (execution.result.package_engine.sha256 !== packaged.engine.sha256) throw new Error("journey used a different packaged Engine");
  if ((await hashStream(testFile)).sha256 !== testHash.sha256 || (await hashStream(waterlineFile)).sha256 !== waterlineHash.sha256) throw new Error("journey inputs changed during verification");
  const stableRun = {
    source_commit: sourceCommit,
    sample_sha256: samples.aggregate_sha256,
    claude_sha256: container.sha256,
    test_sha256: testHash.sha256,
    package: packaged,
    result: execution.result
  };
  const evidence = {
    schema: "cloudig/real-library-journey-evidence/1.0.0",
    run_id: createHash("sha256").update(JSON.stringify(stableRun)).digest("hex"),
    completed_at: new Date().toISOString(),
    status: "passed",
    source_commit: sourceCommit,
    package: packaged,
    runtime: { node: process.version.replace(/^v/u, ""), platform: process.platform, architecture: process.arch },
    inputs: {
      waterline: { batch: waterline.batch, path: "src/adapters/parser/contracts/sample-waterline.json", ...waterlineHash },
      html_samples: samples,
      claude_container: { file: path.basename(claudeContainer), ...container },
      test: { path: "tests/v1/journey/real-library.test.mts", ...testHash }
    },
    outcome: { ...execution.node_test, duration_ms: execution.duration_ms, stdout_sha256: execution.stdout_sha256 },
    result: execution.result
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidence = await runRealLibraryEvidence({ root: defaultRoot, ...options });
    process.stdout.write(`${JSON.stringify({ evidence: path.relative(defaultRoot, options.output).replaceAll("\\", "/"), run_id: evidence.run_id, result: evidence.result })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
