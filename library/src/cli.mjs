#!/usr/bin/env node

import process from "node:process";
import { defaultLibraryRoot, initializeLibrary } from "./init.mjs";

function usage() {
  return `Cloudig library initializer 1.0.0

Usage:
  node library/src/cli.mjs init [ROOT]

Options:
  --user-name NAME      Initial user display name.
  --assistant-name NAME Initial assistant display name.
  --language CODE       zh-CN or en.
  --help                Show this help.

Without ROOT, Windows uses the current user's Cloudig directory.
Existing cloudig-library.json files are never overwritten.
`;
}

function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  if (argv[0] !== "init") throw new Error(usage());
  const result = { root: null, userName: undefined, assistantName: undefined, language: "zh-CN" };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--user-name", "--assistant-name", "--language"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--user-name") result.userName = value;
      else if (argument === "--assistant-name") result.assistantName = value;
      else result.language = value;
      index += 1;
    } else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else if (result.root) throw new Error(`Unexpected argument: ${argument}`);
    else result.root = argument;
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await initializeLibrary(options.root || defaultLibraryRoot(), options);
  process.stdout.write(`${JSON.stringify({ ok: true, version: "1.0.0", ...report }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
