#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  knownSlowRegressionTests,
  regressionSuiteNames,
  selectRegressionTests
} from "./regression-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/run-regressions.mjs [options]",
    "",
    `  --suite <name>   ${regressionSuiteNames.join(" | ")}`,
    "  --scope <name>   constrain --match to one suite (for example bookmarklets)",
    "  --match <text>   select tests whose path contains text; repeatable",
    "  --with-fast      union the fast suite into the selection",
    "  --exclude-slow   omit the catalogued release, pressure, cold-DOM and private tests",
    "  --list           print the selected plan without executing it",
    "  --private        legacy alias for --suite private",
    "  --help           print this help",
    "",
    "No options preserves the historical full-public behavior. npm test uses --suite fast."
  ].join("\n");
}

function parseArgs(args) {
  const options = {
    suite: null,
    scope: null,
    matches: [],
    withFast: false,
    excludeSlow: false,
    list: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") return { ...options, help: true };
    if (argument === "--private") {
      if (options.suite !== null) throw new Error("--private cannot be combined with --suite");
      options.suite = "private";
      continue;
    }
    if (argument === "--suite") {
      if (options.suite !== null) throw new Error("--suite may be provided only once");
      options.suite = args[index += 1] ?? "";
      if (!options.suite) throw new Error("--suite requires a name");
      continue;
    }
    if (argument === "--scope") {
      if (options.scope !== null) throw new Error("--scope may be provided only once");
      options.scope = args[index += 1] ?? "";
      if (!options.scope) throw new Error("--scope requires a name");
      continue;
    }
    if (argument === "--match") {
      const match = args[index += 1] ?? "";
      if (!match) throw new Error("--match requires text");
      options.matches.push(match);
      continue;
    }
    if (argument === "--with-fast") {
      options.withFast = true;
      continue;
    }
    if (argument === "--exclude-slow") {
      options.excludeSlow = true;
      continue;
    }
    if (argument === "--list") {
      options.list = true;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function seconds(milliseconds) {
  return Math.round(milliseconds) / 1000;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exit(2);
}

if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

let tests;
try {
  tests = selectRegressionTests(options);
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exit(2);
}

if (options.list) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    suite: options.suite ?? (options.matches.length > 0 ? "matched" : "full"),
    scope: options.scope,
    matches: options.matches,
    with_fast: options.withFast,
    exclude_slow: options.excludeSlow,
    tests: tests.map((test) => ({
      path: test,
      slow: knownSlowRegressionTests.includes(test)
    }))
  }, null, 2)}\n`);
  process.exit(0);
}

const suiteStart = performance.now();
const timings = [];
for (const [index, test] of tests.entries()) {
  const label = `[AIChatArchive ${index + 1}/${tests.length}] ${test}`;
  process.stdout.write(`\n${label}\n`);
  const testStart = performance.now();
  const result = spawnSync(process.execPath, [path.join(root, test)], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true
  });
  const durationMs = performance.now() - testStart;
  timings.push({ test, duration_ms: Math.round(durationMs) });
  process.stdout.write(`[duration] ${seconds(durationMs).toFixed(3)}s\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`[failed] ${test} after ${seconds(durationMs).toFixed(3)}s\n`);
    process.exit(result.status || 1);
  }
}

const totalMs = performance.now() - suiteStart;
const slowest = [...timings]
  .sort((left, right) => right.duration_ms - left.duration_ms)
  .slice(0, Math.min(5, timings.length));
process.stdout.write(`\n${JSON.stringify({
  ok: true,
  suite: options.suite ?? (options.matches.length > 0 ? "matched" : "full"),
  scope: options.scope,
  tests: tests.length,
  duration_ms: Math.round(totalMs),
  slowest
}, null, 2)}\n`);
