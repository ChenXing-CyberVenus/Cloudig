#!/usr/bin/env node
/*
 * Unified builder for the 32 bookmarklets currently presented for acceptance.
 *
 * Write mode builds every source into the project temporary directory first, then
 * replaces only changed artifacts as one transaction. Check mode performs the
 * same builds and comparisons without writing any bookmarklet artifact.
 *
 * This command intentionally does not refresh bookmarklets/candidate/test.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveBookmarkletContract,
  archiveBookmarkletTargets,
  readyArchiveBookmarkletTargets,
  validateArchiveBookmarkletTargets
} from "./archive-bookmarklet-targets.mjs";
import {
  bookmarkletPlatforms,
  claudeLayoutVariants
} from "./bookmarklet-layout.mjs";
import {
  bookmarkletTargets,
  validateBookmarkletTargets
} from "./bookmarklet-targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bookmarkletRoot = resolve(projectRoot, "bookmarklets");
const builder = resolve(projectRoot, "scripts/build-bookmarklet.mjs");

export const currentBookmarkletBuildUsage = [
  "Usage:",
  "  node scripts/build-current-bookmarklets.mjs",
  "  node scripts/build-current-bookmarklets.mjs --check",
  "",
  "Builds the current 12 Light, 12 Full, and 8 AllBranches artifacts.",
  "--check rebuilds into the project temporary directory and never writes artifacts.",
  "This command does not refresh bookmarklets/candidate/test."
].join("\n");

function freezeTarget(target) {
  return Object.freeze({
    ...target,
    buildFlags: Object.freeze([...target.buildFlags])
  });
}

function findClaudeCandidateLight() {
  const matches = claudeLayoutVariants.filter(
    (target) => target.state === "candidate" && target.profile === "light"
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Claude candidate Light target, got ${matches.length}`);
  }
  return matches[0];
}

const claudeCandidateLight = findClaudeCandidateLight();

export const currentBookmarkletBuildTargets = Object.freeze([
  ...bookmarkletTargets.map((target) => freezeTarget({
    id: `${target.id}:light`,
    platform: target.id,
    label: `${target.label} Light`,
    profile: "light",
    version: target.version,
    source: target.source,
    min: target.min,
    buildFlags: [
      "--temml",
      ...(target.katex ? ["--katex-runtime"] : [])
    ]
  })),
  freezeTarget({
    id: "claude:light",
    platform: "claude",
    label: "Claude Light",
    profile: "light",
    version: claudeCandidateLight.version,
    source: claudeCandidateLight.source,
    min: claudeCandidateLight.min,
    buildFlags: ["--temml-mhchem"]
  }),
  ...readyArchiveBookmarkletTargets().map((target) => freezeTarget({
    id: target.id,
    platform: target.platform,
    label: `${target.label} ${target.profile === "full" ? "Full" : "AllBranches"}`,
    profile: target.profile,
    version: target.version,
    source: target.source,
    min: target.min,
    buildFlags: target.buildFlags
  }))
]);

function readVersion(sourceText, target) {
  const declarations = [...String(sourceText).matchAll(/\bconst VERSION = "([^"]+)";/gu)];
  if (declarations.length !== 1) {
    throw new Error(`${target.id} source must declare exactly one VERSION; got ${declarations.length}`);
  }
  return declarations[0][1];
}

function resolveBookmarkletPath(pathname, target, kind) {
  const absolute = resolve(bookmarkletRoot, pathname);
  const fromRoot = relative(bookmarkletRoot, absolute);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`${target.id} ${kind} escaped bookmarklets/: ${pathname}`);
  }
  return absolute;
}

export function validateCurrentBookmarkletBuildTargets({
  readSourceText = (target) => readFileSync(resolveBookmarkletPath(target.source, target, "source"), "utf8")
} = {}) {
  validateBookmarkletTargets(bookmarkletTargets, {
    readSourceText: (target) => readSourceText({
      ...target,
      id: `${target.id}:light`
    })
  });
  validateArchiveBookmarkletTargets(archiveBookmarkletTargets, {
    readSourceText
  });

  if (currentBookmarkletBuildTargets.length !== 32) {
    throw new Error(`Current build matrix must contain 32 targets, got ${currentBookmarkletBuildTargets.length}`);
  }
  const counts = {
    light: currentBookmarkletBuildTargets.filter((target) => target.profile === "light").length,
    full: currentBookmarkletBuildTargets.filter((target) => target.profile === "full").length,
    allBranches: currentBookmarkletBuildTargets.filter((target) => target.profile === "all-branches").length
  };
  if (counts.light !== 12 || counts.full !== 12 || counts.allBranches !== 8) {
    throw new Error(`Current build matrix must be 12 Light, 12 Full, and 8 AllBranches; got ${counts.light}, ${counts.full}, and ${counts.allBranches}`);
  }
  if (new Set(currentBookmarkletBuildTargets.map((target) => target.id)).size !== 32) {
    throw new Error("Current build matrix contains duplicate ids");
  }
  if (new Set(currentBookmarkletBuildTargets.map((target) => target.source)).size !== 32) {
    throw new Error("Current build matrix contains duplicate source paths");
  }
  if (new Set(currentBookmarkletBuildTargets.map((target) => target.min)).size !== 32) {
    throw new Error("Current build matrix contains duplicate artifact paths");
  }
  if (new Set(currentBookmarkletBuildTargets.map((target) => target.platform)).size !== bookmarkletPlatforms.length) {
    throw new Error(`Current build matrix must cover all ${bookmarkletPlatforms.length} platforms`);
  }

  for (const target of currentBookmarkletBuildTargets) {
    resolveBookmarkletPath(target.source, target, "source");
    resolveBookmarkletPath(target.min, target, "artifact");
    if (!Array.isArray(target.buildFlags)
      || target.buildFlags.length === 0
      || target.buildFlags.some((flag) => !["--temml", "--temml-mhchem", "--katex-runtime"].includes(flag))) {
      throw new Error(`${target.id} has invalid build flags`);
    }
  }

  const claudeLightTarget = currentBookmarkletBuildTargets.find(
    (target) => target.id === "claude:light"
  );
  const claudeSource = readSourceText(claudeLightTarget);
  if (readVersion(claudeSource, claudeLightTarget) !== claudeCandidateLight.version) {
    throw new Error("Claude candidate Light source VERSION does not match its layout registry");
  }
  return currentBookmarkletBuildTargets;
}

export function assertStrictBookmarkletArtifact(text, target) {
  if (!text.startsWith("javascript:")) {
    throw new Error(`${target.id} artifact must start with javascript:`);
  }
  if (/[\r\n]/u.test(text)) {
    throw new Error(`${target.id} artifact is not a strict single line`);
  }
  if (text.length > archiveBookmarkletContract.bookmarkUrlCharacterBudget) {
    throw new Error(`${target.id} artifact ${text.length} characters exceeds the ${archiveBookmarkletContract.bookmarkUrlCharacterBudget}-character Chrome bookmark URL safety budget`);
  }
}

export function replaceCurrentBookmarkletArtifactSet(items, {
  injectedFailureAt = 0
} = {}) {
  if (!Number.isInteger(injectedFailureAt) || injectedFailureAt < 0) {
    throw new Error("injectedFailureAt must be a non-negative integer");
  }
  if (!items.length) return;

  const transactionId = `osis-current-bookmarklet-transaction-${process.pid}-${Date.now()}-${randomUUID()}`;
  const prepared = items.map((item) => {
    const existed = existsSync(item.destination);
    const originalBytes = existed ? readFileSync(item.destination) : null;
    return {
      ...item,
      existed,
      originalBytes,
      temporaryPath: `${item.destination}.${transactionId}.tmp`,
      backupPath: `${item.destination}.${transactionId}.bak`
    };
  });
  const replaced = [];

  try {
    for (const item of prepared) {
      writeFileSync(item.temporaryPath, item.bytes, { flag: "wx" });
      if (item.existed) writeFileSync(item.backupPath, item.originalBytes, { flag: "wx" });
    }

    try {
      for (let index = 0; index < prepared.length; index += 1) {
        if (injectedFailureAt === index + 1) {
          throw new Error(`Injected current bookmarklet artifact replacement failure at ${injectedFailureAt}`);
        }
        const item = prepared[index];
        renameSync(item.temporaryPath, item.destination);
        replaced.push(item);
      }
    } catch (replacementError) {
      const rollbackErrors = [];
      for (const item of [...replaced].reverse()) {
        try {
          if (item.existed) renameSync(item.backupPath, item.destination);
          else rmSync(item.destination, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(new Error(`${item.target.id} rollback failed: ${rollbackError.message}`, {
            cause: rollbackError
          }));
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [replacementError, ...rollbackErrors],
          "Current bookmarklet artifact replacement failed and rollback was incomplete"
        );
      }
      throw replacementError;
    }
  } finally {
    for (const item of prepared) {
      rmSync(item.temporaryPath, { force: true });
      rmSync(item.backupPath, { force: true });
    }
  }
}

function parseCliArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    return Object.freeze({ help: true, checkOnly: false });
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error(currentBookmarkletBuildUsage);
  }
  return Object.freeze({ help: false, checkOnly: args[0] === "--check" });
}

export function buildCurrentBookmarklets({ checkOnly = false } = {}) {
  validateCurrentBookmarkletBuildTargets();
  const projectTmpRoot = resolve(projectRoot, "tmp");
  mkdirSync(projectTmpRoot, { recursive: true });
  const stagingRoot = mkdtempSync(join(projectTmpRoot, "osis-current-bookmarklet-set-"));
  const staged = [];

  try {
    for (const target of currentBookmarkletBuildTargets) {
      const stagedPath = join(stagingRoot, target.min);
      mkdirSync(dirname(stagedPath), { recursive: true });
      const result = spawnSync(
        process.execPath,
        [builder, `bookmarklets/${target.source}`, stagedPath, ...target.buildFlags],
        {
          cwd: projectRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        }
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `${target.id} build failed`);
      }
      process.stdout.write(result.stdout);
      const bytes = readFileSync(stagedPath);
      assertStrictBookmarkletArtifact(bytes.toString("utf8"), target);
      staged.push({
        target,
        bytes,
        destination: resolveBookmarkletPath(target.min, target, "artifact")
      });
    }

    const changed = staged.filter((item) => (
      !existsSync(item.destination)
      || !item.bytes.equals(readFileSync(item.destination))
    ));
    if (checkOnly && changed.length) {
      const details = changed.map(
        (item) => `${item.target.id}${existsSync(item.destination) ? "" : " (missing)"}`
      );
      throw new Error(`Current sources and strict one-line artifacts differ: ${details.join(", ")}`);
    }
    if (!checkOnly) replaceCurrentBookmarkletArtifactSet(changed);

    return Object.freeze({
      ok: true,
      mode: checkOnly ? "check" : "write",
      targets: staged.length,
      light: staged.filter((item) => item.target.profile === "light").length,
      full: staged.filter((item) => item.target.profile === "full").length,
      all_branches: staged.filter((item) => item.target.profile === "all-branches").length,
      artifacts_modified: checkOnly ? 0 : changed.length,
      candidate_test_refreshed: false
    });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${currentBookmarkletBuildUsage}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(buildCurrentBookmarklets(options))}\n`);
  }
}
