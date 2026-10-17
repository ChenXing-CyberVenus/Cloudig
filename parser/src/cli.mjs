#!/usr/bin/env node

import { access, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { atomicWriteText } from "./atomic.mjs";
import { PARSER, parseConversationFile } from "./index.mjs";
import { parseCloudigLibrary } from "./library-orchestrator.mjs";

function usage() {
  return `AI Chat Archive Parser ${PARSER.version}

Usage:
  node parser/src/cli.mjs FILE.html
  node parser/src/cli.mjs --output-dir DIR FILE_OR_DIRECTORY [...]
  node parser/src/cli.mjs --check FILE_OR_DIRECTORY [...]
  node parser/src/cli.mjs --library ROOT [--file INBOX_FILE]

Options:
  --output-dir DIR   Write one deterministic .json file per input.
  --library ROOT     Incrementally parse the flat ROOT/Inbox into ROOT/Conversations.
  --file FILE        With --library, parse one direct Inbox file only.
  --check            Parse and validate without writing output.
  --force            Allow replacing existing output files.
  --quiet            Suppress the summary written to stderr.
  --help             Show this help.

With one input and no --output-dir, canonical JSON is written to stdout.
Directories are scanned for direct child .html files only. The Parser never
executes source scripts and never makes network requests.
`;
}

function parseArguments(argv) {
  const options = {
    outputDir: null, libraryRoot: null, selectedFile: "",
    check: false, force: false, quiet: false, inputs: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (argument === "--check") options.check = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (["--output-dir", "--library", "--file"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--output-dir") options.outputDir = value;
      else if (argument === "--library") options.libraryRoot = value;
      else options.selectedFile = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.inputs.push(argument);
    }
  }
  return options;
}

async function inputFiles(inputs) {
  const result = [];
  for (const input of inputs) {
    const absolute = path.resolve(input);
    const information = await stat(absolute);
    if (information.isDirectory()) {
      const children = await readdir(absolute, { withFileTypes: true });
      for (const child of children) {
        if (child.isFile() && path.extname(child.name).toLowerCase() === ".html") {
          result.push(path.join(absolute, child.name));
        }
      }
    } else if (information.isFile()) {
      if (path.extname(absolute).toLowerCase() !== ".html") throw new Error(`Input is not HTML: ${absolute}`);
      result.push(absolute);
    } else {
      throw new Error(`Unsupported input: ${absolute}`);
    }
  }
  return [...new Set(result)].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(target, contents, force) {
  if (await exists(target)) {
    if (!force) throw new Error(`Output exists (use --force to replace): ${target}`);
  }
  return atomicWriteText(target, contents);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.libraryRoot) {
    if (options.inputs.length) throw new Error("--library cannot be combined with explicit input paths");
    if (options.outputDir) throw new Error("--library cannot be combined with --output-dir");
    if (options.check) throw new Error("--check is not used with --library; incremental parsing always validates before commit");
    const report = await parseCloudigLibrary({
      root: options.libraryRoot,
      selectedFile: options.selectedFile,
      force: options.force,
      legacyProjectionWriterForRegression: process.env.CLOUDIG_REGRESSION_LEGACY_WRITER === "1"
    });
    if (!options.quiet) process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (options.selectedFile) throw new Error("--file requires --library");
  if (!options.inputs.length) throw new Error(usage());
  const files = await inputFiles(options.inputs);
  if (!files.length) throw new Error("No HTML files found");
  if (!options.check && !options.outputDir && files.length !== 1) {
    throw new Error("Multiple inputs require --output-dir or --check");
  }
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : null;
  if (outputDir && !options.check) await mkdir(outputDir, { recursive: true });
  const summaries = [];
  for (const file of files) {
    const result = await parseConversationFile(file);
    let writeStatus = "checked";
    if (!options.check && outputDir) {
      const target = path.join(outputDir, `${path.basename(file, path.extname(file))}.json`);
      writeStatus = await atomicWrite(target, result.serialized, options.force);
    } else if (!options.check) {
      process.stdout.write(result.serialized);
      writeStatus = "stdout";
    }
    summaries.push({
      file: path.basename(file),
      adapter: result.adapter.id,
      messages: result.conversation.messages.length,
      resources: result.conversation.resources?.length ?? 0,
      sources: result.conversation.sources?.length ?? 0,
      warnings: result.conversation.warnings?.length ?? 0,
      write_status: writeStatus
    });
  }
  if (!options.quiet) process.stderr.write(`${JSON.stringify({
    ok: true,
    mode: "direct",
    files: summaries
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
