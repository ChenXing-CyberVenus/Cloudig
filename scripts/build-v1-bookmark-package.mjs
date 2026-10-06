import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentBookmarkletBuildTargets,
  validateCurrentBookmarkletBuildTargets
} from "./build-current-bookmarklets.mjs";
import { bookmarkSetVersion } from "./bookmarklet-targets.mjs";
import { pendingBookmarkletTestIds } from "./refresh-bookmarklet-test-set.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const platformOrder = Object.freeze([
  ["chatgpt", "ChatGPT"],
  ["claude", "Claude"],
  ["deepseek", "DeepSeek"],
  ["gemini", "Gemini"],
  ["grok", "Grok"],
  ["doubao", "豆包"],
  ["kimi", "Kimi"],
  ["qwen", "Qwen"],
  ["chatglm", "ChatGLM"],
  ["zai", "Z.ai"],
  ["yuanbao", "腾讯元宝"],
  ["mistral", "Mistral"]
]);

const profileMap = Object.freeze({
  light: "light",
  full: "full",
  "all-branches": "all_branches"
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictUrl(bytes, target) {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(value.startsWith("javascript:"), `${target.id} is not a bookmarklet URL`);
  assert.doesNotMatch(value, /[\r\n]/u, `${target.id} is not a strict one-line bookmarklet`);
  assert.ok(value.length <= 480 * 1024, `${target.id} exceeds the Chrome bookmark URL budget`);
  return value;
}

export async function buildV1BookmarkPackage(outputRoot, {
  projectRoot = repository,
  allowPending = false
} = {}) {
  const resolvedOutput = path.resolve(outputRoot);
  const relativeOutput = path.relative(projectRoot, resolvedOutput);
  assert.ok(relativeOutput && !relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput), "V1 bookmark package output must stay inside the project");
  if (!allowPending) {
    assert.deepEqual(pendingBookmarkletTestIds, [], "V1 cannot package bookmarklets still awaiting focused acceptance");
  }
  validateCurrentBookmarkletBuildTargets();

  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(path.join(resolvedOutput, "artifacts"), { recursive: true });
  const targets = new Map(currentBookmarkletBuildTargets.map((target) => [target.id, target]));
  const platforms = [];
  let variantCount = 0;

  for (const [platform, label] of platformOrder) {
    const variants = [];
    for (const sourceProfile of ["light", "full", "all-branches"]) {
      const target = targets.get(`${platform}:${sourceProfile}`);
      if (!target) continue;
      const profile = profileMap[sourceProfile];
      assert.ok(profile, `Unknown bookmark profile ${sourceProfile}`);
      const source = path.resolve(projectRoot, "bookmarklets", ...target.min.split("/"));
      const bytes = await readFile(source);
      const url = strictUrl(bytes, target);
      const artifact = `${platform}/${profile}.min.js`;
      const destination = path.join(resolvedOutput, "artifacts", ...artifact.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      assert.deepEqual(await readFile(destination), bytes, `${target.id} package copy drifted`);
      variants.push({
        id: `${platform}:${profile}`,
        profile,
        version: target.version,
        artifact,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        characters: url.length
      });
      variantCount += 1;
    }
    assert.ok(variants.some((entry) => entry.profile === "light") && variants.some((entry) => entry.profile === "full"), `${platform} lacks Light or Full`);
    const platformEntry = {
      id: platform,
      label,
      title_zh: `保存 ${label} 会话-Cloudig`,
      title_en: `Save ${label} conversation-Cloudig`,
      variants
    };
    if (!variants.some((entry) => entry.profile === "all_branches")) {
      platformEntry.fallback = { all_branches: "full" };
    }
    platforms.push(platformEntry);
  }

  assert.equal(platforms.length, 12);
  assert.equal(variantCount, 32);
  assert.equal(platforms.filter((platform) => platform.fallback).length, 4);
  const manifest = {
    format: "cloudig/bookmark-package",
    version: "0.2.0",
    bookmark_set_version: bookmarkSetVersion,
    default_profile: "light",
    profiles: ["light", "full", "all_branches"],
    platform_count: 12,
    variant_count: 32,
    effective_count_per_profile: 12,
    platforms
  };
  await writeFile(path.join(resolvedOutput, "bookmark-package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await copyFile(path.join(projectRoot, "BOOKMARKLET_CHANGELOG.md"), path.join(resolvedOutput, "BOOKMARKLET_CHANGELOG.md"));
  return manifest;
}
