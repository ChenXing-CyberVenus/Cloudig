import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveBookmarkletTargets,
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
const bookmarkletRoot = join(projectRoot, "bookmarklets");
const candidateRoot = join(bookmarkletRoot, "candidate");

export const bookmarkletTestDirectory = join(candidateRoot, "test");
export const bookmarkletTestInstallerFilename = "00_安装当前书签测试.exe";
export const bookmarkletTestInstallerSource = join(
  projectRoot,
  "manager",
  "installers",
  "bookmark-test",
  bookmarkletTestInstallerFilename
);

const platformLabels = Object.freeze({
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  grok: "Grok",
  doubao: "豆包",
  chatglm: "ChatGLM",
  kimi: "Kimi",
  mistral: "Mistral",
  qwen: "Qwen",
  zai: "Z.ai",
  yuanbao: "腾讯元宝",
  claude: "Claude"
});

const profileLabels = Object.freeze({
  light: "轻装（Light）",
  full: "全量（Full）",
  "all-branches": "整树（Tree）"
});

const profileNumbers = Object.freeze({
  light: 1,
  full: 2,
  "all-branches": 3
});

/*
 * This is the only hand-edited acceptance state.
 *
 * Remove an id after the user explicitly accepts that exact current artifact.
 * Add it again whenever that profile receives a new version requiring retest.
 * This list controls acceptance metadata only. It must never reduce the files
 * copied into candidate/test: the one-click installer treats its sibling
 * .min.js files as the complete managed set and removes managed bookmarks that
 * are absent. The generated directory must therefore always contain all 32
 * current artifacts and must never be edited by hand.
 */
export const pendingBookmarkletTestIds = Object.freeze([
  // No pending tracks: ChatGPT 3.7.52 / 1.0.49 / 1.0.49 were accepted from the latest Downloads set.
]);

function currentTargets() {
  validateBookmarkletTargets(bookmarkletTargets);
  validateArchiveBookmarkletTargets(archiveBookmarkletTargets);

  const claudeLight = claudeLayoutVariants.find(
    (target) => target.state === "candidate" && target.profile === "light"
  );
  assert.ok(claudeLight, "Claude candidate Light target is missing");

  const targets = [
    ...bookmarkletTargets.map((target) => ({
      id: `${target.id}:light`,
      platform: target.id,
      profile: "light",
      version: target.version,
      min: target.min
    })),
    {
      id: "claude:light",
      platform: "claude",
      profile: "light",
      version: claudeLight.version,
      min: claudeLight.min
    },
    ...archiveBookmarkletTargets
      .filter((target) => target.status === "ready")
      .map((target) => ({
        id: target.id,
        platform: target.platform,
        profile: target.profile,
        version: target.version,
        min: target.min
      }))
  ];

  assert.equal(targets.length, 32, "Current acceptance matrix must contain 32 artifacts");
  assert.equal(targets.filter((target) => target.profile === "light").length, 12);
  assert.equal(targets.filter((target) => target.profile === "full").length, 12);
  assert.equal(targets.filter((target) => target.profile === "all-branches").length, 8);
  assert.equal(new Set(targets.map((target) => target.id)).size, targets.length);
  return targets;
}

function acceptanceFilename(target) {
  const platformNumber = String(bookmarkletPlatforms.indexOf(target.platform) + 1).padStart(2, "0");
  assert.notEqual(platformNumber, "00", `Unknown platform: ${target.platform}`);
  const profileNumber = profileNumbers[target.profile];
  const platformLabel = platformLabels[target.platform];
  const profileLabel = profileLabels[target.profile];
  assert.ok(profileNumber && platformLabel && profileLabel, `Unknown acceptance target: ${target.id}`);
  const filename = `${platformNumber}-${profileNumber}_${platformLabel}_${profileLabel}_${target.version}.min.js`;
  assert.equal(/[<>:"/\\|?*\u0000-\u001f]/u.test(filename), false, `Unsafe filename: ${filename}`);
  return filename;
}

const currentTargetMap = new Map(currentTargets().map((target) => [target.id, target]));
assert.equal(new Set(pendingBookmarkletTestIds).size, pendingBookmarkletTestIds.length);

export const pendingBookmarkletTestTargets = Object.freeze(
  pendingBookmarkletTestIds.map((id) => {
    const target = currentTargetMap.get(id);
    assert.ok(target, `Pending acceptance id is not a current artifact: ${id}`);
    return Object.freeze({
      ...target,
      filename: acceptanceFilename(target)
    });
  })
);

export const bookmarkletTestTargets = Object.freeze(
  [...currentTargetMap.values()].map((target) => Object.freeze({
    ...target,
    filename: acceptanceFilename(target)
  }))
);

function ensureExactDerivedPath(directory, leaf) {
  const actual = resolve(directory);
  assert.equal(dirname(actual), candidateRoot, `${leaf} must stay directly under candidate/`);
  assert.equal(basename(actual), leaf, `Unexpected derived directory: ${actual}`);
  return actual;
}

function sourceBytes(target) {
  const source = resolve(bookmarkletRoot, target.min);
  assert.equal(
    source.startsWith(`${bookmarkletRoot}\\`) || source.startsWith(`${bookmarkletRoot}/`),
    true,
    `Bookmarklet source escaped the project root: ${target.min}`
  );
  assert.equal(existsSync(source), true, `Bookmarklet source is missing: ${target.min}`);
  const bytes = readFileSync(source);
  const text = bytes.toString("utf8");
  assert.equal(text.startsWith("javascript:"), true, `${target.id} is not installable`);
  assert.equal(/[\r\n]/u.test(text), false, `${target.id} is not strict one-line`);
  assert.equal(text.length <= 480 * 1024, true, `${target.id} exceeds the Chrome character gate`);
  return bytes;
}

export function validateBookmarkletTestDirectory(directory = bookmarkletTestDirectory) {
  const actualDirectory = resolve(directory);
  assert.equal(existsSync(actualDirectory), true, `Bookmarklet test directory is missing: ${actualDirectory}`);

  const entries = readdirSync(actualDirectory, { withFileTypes: true });
  assert.equal(entries.every((entry) => entry.isFile()), true, "candidate/test must not contain subdirectories");

  const expectedNames = [
    ...bookmarkletTestTargets.map((target) => target.filename),
    bookmarkletTestInstallerFilename
  ].sort();
  const actualNames = entries.map((entry) => entry.name).sort();
  assert.deepEqual(
    actualNames,
    expectedNames,
    "candidate/test must contain the complete current strict one-line set and the exact registered installer"
  );

  let totalBytes = 0;
  const aggregate = createHash("sha256");
  for (const target of bookmarkletTestTargets) {
    const expected = sourceBytes(target);
    const copy = readFileSync(join(actualDirectory, target.filename));
    assert.equal(copy.equals(expected), true, `${target.filename} is not byte-identical to ${target.min}`);
    totalBytes += copy.length;
    aggregate.update(target.filename);
    aggregate.update("\0");
    aggregate.update(copy);
  }
  assert.equal(existsSync(bookmarkletTestInstallerSource), true, "canonical bookmark test installer is missing");
  const expectedInstaller = readFileSync(bookmarkletTestInstallerSource);
  assert.equal(
    expectedInstaller.length > 2 && expectedInstaller[0] === 0x4d && expectedInstaller[1] === 0x5a,
    true,
    "canonical bookmark test installer is not a Windows executable"
  );
  const installerCopy = readFileSync(join(actualDirectory, bookmarkletTestInstallerFilename));
  assert.equal(
    installerCopy.equals(expectedInstaller),
    true,
    "candidate/test installer is not byte-identical to its canonical manager artifact"
  );

  return Object.freeze({
    files: bookmarkletTestTargets.length,
    auxiliary_files: 1,
    platforms: new Set(bookmarkletTestTargets.map((target) => target.platform)).size,
    light: bookmarkletTestTargets.filter((target) => target.profile === "light").length,
    full: bookmarkletTestTargets.filter((target) => target.profile === "full").length,
    all_branches: bookmarkletTestTargets.filter((target) => target.profile === "all-branches").length,
    pending_files: pendingBookmarkletTestTargets.length,
    pending_platforms: new Set(pendingBookmarkletTestTargets.map((target) => target.platform)).size,
    total_bytes: totalBytes,
    sha256: aggregate.digest("hex").toUpperCase(),
    installer_bytes: installerCopy.length,
    installer_sha256: createHash("sha256").update(installerCopy).digest("hex").toUpperCase()
  });
}

export function refreshBookmarkletTestDirectory() {
  const targetDirectory = ensureExactDerivedPath(bookmarkletTestDirectory, "test");
  const nextDirectory = ensureExactDerivedPath(join(candidateRoot, ".test-next"), ".test-next");
  const previousDirectory = ensureExactDerivedPath(join(candidateRoot, ".test-previous"), ".test-previous");

  rmSync(nextDirectory, { recursive: true, force: true });
  rmSync(previousDirectory, { recursive: true, force: true });
  mkdirSync(nextDirectory);

  let movedPrevious = false;
  try {
    for (const target of bookmarkletTestTargets) {
      copyFileSync(resolve(bookmarkletRoot, target.min), join(nextDirectory, target.filename));
    }
    assert.equal(existsSync(bookmarkletTestInstallerSource), true, "canonical bookmark test installer is missing");
    copyFileSync(
      bookmarkletTestInstallerSource,
      join(nextDirectory, bookmarkletTestInstallerFilename)
    );
    validateBookmarkletTestDirectory(nextDirectory);

    if (existsSync(targetDirectory)) {
      renameSync(targetDirectory, previousDirectory);
      movedPrevious = true;
    }
    renameSync(nextDirectory, targetDirectory);
    rmSync(previousDirectory, { recursive: true, force: true });
    movedPrevious = false;
    return validateBookmarkletTestDirectory(targetDirectory);
  } catch (error) {
    if (!existsSync(targetDirectory) && movedPrevious && existsSync(previousDirectory)) {
      renameSync(previousDirectory, targetDirectory);
      movedPrevious = false;
    }
    throw error;
  } finally {
    rmSync(nextDirectory, { recursive: true, force: true });
    if (!movedPrevious) rmSync(previousDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.every((arg) => arg === "--check"), true, `Unknown argument: ${args.join(" ")}`);
  const checkOnly = args.includes("--check");
  const result = checkOnly
    ? validateBookmarkletTestDirectory()
    : refreshBookmarkletTestDirectory();
  process.stdout.write(`${JSON.stringify({ ok: true, mode: checkOnly ? "check" : "refresh", ...result }, null, 2)}\n`);
}
