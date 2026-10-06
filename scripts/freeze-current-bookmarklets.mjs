#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentBookmarkletBuildTargets } from "./build-current-bookmarklets.mjs";
import { versionedBookmarkletName } from "./bookmarklet-layout.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bookmarkletRoot = resolve(projectRoot, "bookmarklets");
const write = process.argv.slice(2).includes("--write");
if (process.argv.length > 3 || (process.argv.length === 3 && !write)) {
  throw new Error("Usage: node scripts/freeze-current-bookmarklets.mjs [--write]");
}

const entries = currentBookmarkletBuildTargets.flatMap((target) => (
  ["source", "min"].map((kind) => {
    const source = resolve(bookmarkletRoot, target[kind]);
    const destination = resolve(
      bookmarkletRoot,
      "legacy",
      target.platform,
      versionedBookmarkletName(basename(target[kind]), target.version)
    );
    if (!existsSync(source)) throw new Error(`${target.id} ${kind} is missing: ${source}`);
    const bytes = readFileSync(source);
    if (existsSync(destination) && !bytes.equals(readFileSync(destination))) {
      throw new Error(`${target.id} ${kind} freeze target already exists with different bytes: ${destination}`);
    }
    return {
      id: target.id,
      kind,
      source,
      destination,
      bytes,
      alreadyFrozen: existsSync(destination)
    };
  })
));

const newEntries = entries.filter((entry) => !entry.alreadyFrozen);
const aggregate = createHash("sha256");
for (const entry of entries) {
  aggregate.update(`${entry.id}\0${entry.kind}\0`);
  aggregate.update(entry.bytes);
}

if (write && newEntries.length) {
  const transaction = `osis-freeze-${process.pid}-${Date.now()}-${randomUUID()}`;
  const prepared = [];
  const created = [];
  try {
    for (const entry of newEntries) {
      mkdirSync(dirname(entry.destination), { recursive: true });
      const temporary = `${entry.destination}.${transaction}.tmp`;
      writeFileSync(temporary, entry.bytes, { flag: "wx" });
      prepared.push({ ...entry, temporary });
    }
    for (const entry of prepared) {
      renameSync(entry.temporary, entry.destination);
      created.push(entry.destination);
    }
  } catch (error) {
    for (const entry of prepared) rmSync(entry.temporary, { force: true });
    for (const destination of created) rmSync(destination, { force: true });
    throw error;
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: write ? "write" : "check",
  targets: currentBookmarkletBuildTargets.length,
  files: entries.length,
  new_files: newEntries.length,
  already_frozen: entries.length - newEntries.length,
  bytes: entries.reduce((sum, entry) => sum + entry.bytes.length, 0),
  aggregate_sha256: aggregate.digest("hex")
})}\n`);
