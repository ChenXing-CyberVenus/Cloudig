#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(projectRoot, "manager", "bookmarks", "bookmark-package.json");
const artifactRoot = path.join(projectRoot, "manager", "bookmarks", "artifacts");
const MANIFEST_FORMAT = "cloudig/bookmark-package";
const MANIFEST_VERSION = "0.2.0";
const EXPECTED_BOOKMARK_SET_VERSION = "2026.08.08.1";
const MAXIMUM_CHARACTERS = 480 * 1024;
const PROFILES = Object.freeze(["light", "full", "all_branches"]);
const EFFECTIVE_COUNT_PER_PROFILE = 12;
const PROFILE_COUNTS = Object.freeze({
  light: EFFECTIVE_COUNT_PER_PROFILE,
  full: EFFECTIVE_COUNT_PER_PROFILE,
  all_branches: EFFECTIVE_COUNT_PER_PROFILE
});
const FALLBACKS = Object.freeze({
  gemini: Object.freeze({ all_branches: "full" }),
  doubao: Object.freeze({ all_branches: "full" }),
  chatglm: Object.freeze({ all_branches: "full" }),
  yuanbao: Object.freeze({ all_branches: "full" })
});
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--print") || args.filter((arg) => arg === "--print").length > 1) {
  throw new Error(`Unknown argument(s): ${args.join(" ")}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertStrictArtifact(text, target) {
  if (!text.startsWith("javascript:")) {
    throw new Error(`${target.id} artifact must start with javascript:`);
  }
  if (/[\r\n]/u.test(text)) {
    throw new Error(`${target.id} artifact is not a strict single line`);
  }
  if (text.length > MAXIMUM_CHARACTERS) {
    throw new Error(
      `${target.id} artifact ${text.length} characters exceeds the `
      + `${MAXIMUM_CHARACTERS}-character Chrome bookmark URL safety budget`
    );
  }
}

async function resolveOwnedArtifact(variant) {
  const segments = variant.artifact.split("/");
  const absolute = path.resolve(artifactRoot, ...segments);
  const relative = path.relative(artifactRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${variant.id} escaped the Manager-owned frozen artifact root`);
  }
  let cursor = artifactRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const status = await lstat(cursor);
    if (status.isSymbolicLink()) {
      throw new Error(`${variant.id} frozen artifact path cannot contain a link: ${variant.artifact}`);
    }
  }
  return absolute;
}

function validateManifest(manifest) {
  if (manifest?.format !== MANIFEST_FORMAT || manifest?.version !== MANIFEST_VERSION) {
    throw new Error("Cloudig bookmark package manifest has an unsupported format or version");
  }
  if (manifest.bookmark_set_version !== EXPECTED_BOOKMARK_SET_VERSION) {
    throw new Error(
      `Cloudig bookmark package set version ${manifest.bookmark_set_version || "(missing)"} `
      + `does not match its frozen Manager snapshot ${EXPECTED_BOOKMARK_SET_VERSION}`
    );
  }
  if (manifest.default_profile !== "light"
    || JSON.stringify(manifest.profiles) !== JSON.stringify(PROFILES)
    || manifest.platform_count !== 12
    || manifest.variant_count !== 32
    || manifest.effective_count_per_profile !== EFFECTIVE_COUNT_PER_PROFILE
    || !Array.isArray(manifest.platforms)
    || manifest.platforms.length !== 12) {
    throw new Error("Cloudig bookmark package manifest has invalid profile or count metadata");
  }

  const platformIds = new Set();
  const variantIds = new Set();
  const artifactPaths = new Set();
  let variantCount = 0;
  const effectiveCounts = Object.fromEntries(PROFILES.map((profile) => [profile, 0]));

  for (const platform of manifest.platforms) {
    if (!/^[a-z][a-z0-9-]*$/u.test(platform?.id || "") || platformIds.has(platform.id)) {
      throw new Error(`Invalid or duplicate bookmark platform: ${platform?.id || "(missing)"}`);
    }
    platformIds.add(platform.id);
    if (typeof platform.label !== "string" || !platform.label
      || typeof platform.title_zh !== "string" || !platform.title_zh
      || typeof platform.title_en !== "string" || !platform.title_en
      || !Array.isArray(platform.variants)) {
      throw new Error(`Invalid bookmark platform presentation: ${platform.id}`);
    }

    const variantsByProfile = new Map();
    for (const variant of platform.variants) {
      if (!PROFILES.includes(variant?.profile)
        || variant.id !== `${platform.id}:${variant.profile}`
        || variantIds.has(variant.id)
        || variantsByProfile.has(variant.profile)
        || typeof variant.version !== "string" || !variant.version
        || typeof variant.artifact !== "string" || !variant.artifact
        || variant.artifact.includes("\\")
        || !variant.artifact.startsWith("bookmarklets/")
        || !variant.artifact.endsWith(".min.js")
        || !/^[a-f0-9]{64}$/u.test(variant.sha256)
        || !Number.isSafeInteger(variant.bytes) || variant.bytes < 1
        || !Number.isSafeInteger(variant.characters) || variant.characters < 1
        || variant.characters > MAXIMUM_CHARACTERS) {
        throw new Error(`Invalid or duplicate bookmark variant: ${variant?.id || "(missing)"}`);
      }
      if (artifactPaths.has(variant.artifact)) {
        throw new Error(`Duplicate bookmark artifact path: ${variant.artifact}`);
      }
      variantIds.add(variant.id);
      artifactPaths.add(variant.artifact);
      variantsByProfile.set(variant.profile, variant);
      variantCount += 1;
    }

    for (const required of ["light", "full"]) {
      if (!variantsByProfile.has(required)) {
        throw new Error(`${platform.id} is missing required ${required} bookmark variant`);
      }
    }

    const expectedFallback = FALLBACKS[platform.id] || null;
    const actualFallback = platform.fallback || null;
    if (JSON.stringify(actualFallback) !== JSON.stringify(expectedFallback)) {
      throw new Error(`${platform.id} has an invalid profile fallback`);
    }
    if (expectedFallback && variantsByProfile.has("all_branches")) {
      throw new Error(`${platform.id} must not publish an AllBranches artifact while using its Full fallback`);
    }
    if (!expectedFallback && !variantsByProfile.has("all_branches")) {
      throw new Error(`${platform.id} is missing its AllBranches bookmark variant`);
    }

    for (const requestedProfile of PROFILES) {
      const effectiveProfile = variantsByProfile.has(requestedProfile)
        ? requestedProfile
        : actualFallback?.[requestedProfile];
      if (!effectiveProfile || !variantsByProfile.has(effectiveProfile)) {
        throw new Error(`${platform.id}:${requestedProfile} has no effective bookmark variant`);
      }
      effectiveCounts[requestedProfile] += 1;
    }
  }

  if (variantCount !== 32 || variantIds.size !== 32 || artifactPaths.size !== 32) {
    throw new Error(`Cloudig expects exactly 32 unique bookmark variants, got ${variantCount}`);
  }
  if (JSON.stringify(effectiveCounts) !== JSON.stringify(PROFILE_COUNTS)) {
    throw new Error(`Cloudig effective profile counts are invalid: ${JSON.stringify(effectiveCounts)}`);
  }
  return manifest;
}

const committed = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const allVariants = committed.platforms.flatMap((platform) => platform.variants);
let totalBytes = 0;
for (const variant of allVariants) {
  const bytes = await readFile(await resolveOwnedArtifact(variant));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertStrictArtifact(text, variant);
  if (bytes.length !== variant.bytes || sha256(bytes) !== variant.sha256 || text.length !== variant.characters) {
    throw new Error(`Manager-owned frozen bookmark artifact drifted: ${variant.artifact}`);
  }
  totalBytes += bytes.length;
}
if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(committed, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    platform_count: committed.platform_count,
    variant_count: committed.variant_count,
    effective_count_per_profile: committed.effective_count_per_profile,
    bookmark_set_version: committed.bookmark_set_version,
    total_bytes: totalBytes,
    artifact_state: "manager-owned-frozen",
    artifacts_modified: 0
  }, null, 2)}\n`);
}
