#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const windowsBuildInputFormat = "cloudig/windows-build-inputs";
export const windowsBuildInputVersion = "0.2.0";

const directoryMappings = Object.freeze([
  { source: "manager/web", target: "web", extensions: [".css", ".gif", ".html", ".js", ".json", ".png", ".svg"] },
  { source: "manager/src", target: "engine/manager/src", extensions: [".mjs"] },
  { source: "library", target: "engine/library", extensions: [".js", ".json", ".md", ".mjs"] },
  { source: "parser", target: "engine/parser", extensions: [".json", ".md", ".mjs"] },
  { source: "schema", target: "engine/schema", extensions: [".json", ".md", ".mjs"] },
  { source: "time", target: "engine/time", extensions: [".js", ".json", ".md"] },
  { source: "reader/assets", target: "engine/reader/assets", extensions: [".gif", ".md", ".png", ".svg"] },
  { source: "reader/src", target: "engine/reader/src", extensions: [".css", ".html", ".js"] },
  { source: "reader/vendor", target: "engine/reader/vendor", extensions: [".css", ".js", ".md", ".txt", ".woff2"] }
]);

const exactPayloadMappings = Object.freeze([
  { source: "reader/build.mjs", target: "engine/reader/build.mjs", role: "mapped_payload" },
  { source: "manager/bookmarks/bookmark-package.json", target: "payload/bookmarks/bookmark-package.json", role: "mapped_payload" },
  { source: "BOOKMARKLET_CHANGELOG.md", target: "BOOKMARKLET_CHANGELOG.md", role: "runtime_documentation" },
  { source: "LICENSE", target: "LICENSE.txt", role: "runtime_policy" },
  { source: "manager/windows/runtime-lock.json", target: "runtime-lock.json", role: "runtime_policy" }
]);

const desktopRoots = Object.freeze([
  "manager/windows/Cloudig.Desktop",
  "manager/windows/Cloudig.Bookmarks"
]);

const desktopExtensions = new Set([".cs", ".csproj", ".ico", ".manifest", ".xaml"]);

const buildTools = Object.freeze([
  "manager/scripts/build-windows-icon.ps1",
  "manager/scripts/publish-windows.ps1",
  "manager/scripts/verify-bookmark-package.mjs",
  "manager/scripts/verify-windows-release.ps1",
  "manager/scripts/windows-build-inputs.mjs"
]);

function normalizeRelative(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\/+/u, "");
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Lower(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableWindowsPublishContract(spec) {
  const windows = spec?.windows_candidate ?? {};
  return {
    format: spec?.format,
    version: spec?.version,
    product: spec?.product,
    components: spec?.components,
    bookmarklets: spec?.bookmarklets,
    windows_candidate: {
      architecture: windows.architecture,
      release_name: windows.release_name,
      publish_script: windows.publish_script,
      desktop_project: windows.desktop_project,
      release_manifest_version: windows.release_manifest_version,
      bookmark_package: windows.bookmark_package,
      bookmark_package_verifier: windows.bookmark_package_verifier,
      bookmark_package_version: windows.bookmark_package_version,
      packaged_bookmark_set_version: windows.packaged_bookmark_set_version,
      packaged_platform_count: windows.packaged_platform_count,
      packaged_variant_count: windows.packaged_variant_count,
      effective_count_per_profile: windows.effective_count_per_profile,
      bookmark_integration: windows.bookmark_integration,
      package_selection: windows.package_selection,
      runtime_lock: windows.runtime_lock
    },
    policy: {
      forbidden_tracked_prefixes: spec?.policy?.forbidden_tracked_prefixes,
      forbidden_tracked_patterns: spec?.policy?.forbidden_tracked_patterns
    }
  };
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveInside(root, relative, label = relative) {
  const normalized = normalizeRelative(relative);
  assertCondition(
    normalized
      && !path.isAbsolute(normalized)
      && normalized !== ".."
      && !normalized.startsWith("../")
      && !normalized.includes("/../"),
    `${label} is not a safe project-relative path: ${relative}`
  );
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  assertCondition(
    resolved !== resolvedRoot && resolved.startsWith(`${resolvedRoot}${path.sep}`),
    `${label} escaped the project root: ${relative}`
  );
  return resolved;
}

export function assertPlainPathWithinRoot(root, relative, label = relative) {
  const resolvedRoot = path.resolve(root);
  const target = resolveInside(resolvedRoot, relative, label);
  const rootInformation = lstatSync(resolvedRoot);
  assertCondition(rootInformation.isDirectory() && !rootInformation.isSymbolicLink(), `${label} project root is not a plain directory`);
  let cursor = resolvedRoot;
  for (const component of path.relative(resolvedRoot, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const information = lstatSync(cursor);
    assertCondition(!information.isSymbolicLink(), `${label} contains a reparse point or symbolic link: ${normalizeRelative(path.relative(resolvedRoot, cursor))}`);
  }
  const realRoot = realpathSync(resolvedRoot);
  const realTarget = realpathSync(target);
  const fromRoot = path.relative(realRoot, realTarget);
  assertCondition(
    fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot),
    `${label} resolves outside the project root`
  );
  return target;
}

export function assertNoReparseTree(root, relative, label = relative) {
  const treeRoot = assertPlainPathWithinRoot(root, relative, label);
  const pending = [treeRoot];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const information = lstatSync(absolute);
      const projectRelative = normalizeRelative(path.relative(root, absolute));
      assertCondition(!information.isSymbolicLink(), `${label} contains a reparse point or symbolic link: ${projectRelative}`);
      if (information.isDirectory()) pending.push(absolute);
      else assertCondition(information.isFile(), `${label} contains a non-file entry: ${projectRelative}`);
    }
  }
}

function collectTrackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    windowsHide: true
  }).split("\0").filter(Boolean).map(normalizeRelative);
}

function collectIgnoredPaths(root, files) {
  if (files.length === 0) return [];
  const result = spawnSync(
    "git",
    ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"],
    { input: `${files.join("\0")}\0`, encoding: "utf8", windowsHide: true }
  );
  if (result.error) throw result.error;
  assertCondition(result.status === 0 || result.status === 1, result.stderr || `git check-ignore failed with status ${result.status}`);
  return result.status === 0
    ? result.stdout.split("\0").filter(Boolean).map(normalizeRelative)
    : [];
}

function validatePrivacyPolicy(root, selectedSources) {
  const spec = JSON.parse(readFileSync(path.join(root, "release-spec.json"), "utf8").replace(/^\uFEFF/u, ""));
  const prefixes = (spec?.policy?.forbidden_tracked_prefixes ?? []).map((value) => normalizeRelative(value).toLowerCase());
  const expressions = (spec?.policy?.forbidden_tracked_patterns ?? []).map((value) => new RegExp(value, "u"));
  for (const source of selectedSources) {
    const lowered = source.toLowerCase();
    assertCondition(
      !prefixes.some((prefix) => lowered.startsWith(prefix) || (prefix.endsWith("/") && lowered === prefix.slice(0, -1)))
        && !expressions.some((expression) => expression.test(lowered)),
      `Windows build input is forbidden by the release privacy policy: ${source}`
    );
  }
  const ignored = collectIgnoredPaths(root, selectedSources);
  assertCondition(ignored.length === 0, `Windows build inputs must not be Git-ignored: ${ignored.slice(0, 5).join(", ")}`);
}

function fileEntry(root, { role, source, target = null }) {
  const absolute = assertPlainPathWithinRoot(root, source, `Windows build input ${source}`);
  const information = lstatSync(absolute);
  assertCondition(information.isFile(), `Windows build input is not a plain file: ${source}`);
  const bytes = readFileSync(absolute);
  return {
    role,
    source: normalizeRelative(source),
    target: target === null ? null : normalizeRelative(target),
    bytes: bytes.length,
    sha256: sha256Lower(bytes)
  };
}

function validateExtension(source, allowed, label) {
  const extension = path.extname(source).toLowerCase();
  assertCondition(allowed.has(extension), `${label} has an unapproved file type: ${source}`);
}

function collectPhysicalBuildSources(root, relativeRoot) {
  const absoluteRoot = resolveInside(root, relativeRoot, relativeRoot);
  const pending = [absoluteRoot];
  const result = [];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && current === absoluteRoot && (entry.name === "bin" || entry.name === "obj")) continue;
      const absolute = path.join(current, entry.name);
      const projectRelative = normalizeRelative(path.relative(root, absolute));
      const information = lstatSync(absolute);
      assertCondition(!information.isSymbolicLink(), `Windows desktop source contains a reparse point or symbolic link: ${projectRelative}`);
      if (information.isDirectory()) pending.push(absolute);
      else if (information.isFile() && desktopExtensions.has(path.extname(entry.name).toLowerCase())) result.push(projectRelative);
    }
  }
  return result.sort(compareOrdinal);
}

export function collectWindowsBuildInputs({ root, trackedFiles } = {}) {
  const resolvedRoot = path.resolve(root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const selectedTracked = (trackedFiles ?? collectTrackedFiles(resolvedRoot)).map(normalizeRelative);
  const tracked = new Set(selectedTracked);
  const descriptors = [];
  assertCondition(tracked.has("release-spec.json"), "Windows release contract must be Git-tracked: release-spec.json");
  assertPlainPathWithinRoot(resolvedRoot, "release-spec.json", "Windows release contract");

  for (const mapping of directoryMappings) {
    assertNoReparseTree(resolvedRoot, mapping.source, `Windows mapped source ${mapping.source}`);
    const prefix = `${mapping.source}/`;
    const sources = selectedTracked.filter((source) => source.startsWith(prefix)).sort(compareOrdinal);
    assertCondition(sources.length > 0, `Windows mapped source has no Git-tracked files: ${mapping.source}`);
    const allowed = new Set(mapping.extensions);
    for (const source of sources) {
      validateExtension(source, allowed, `Windows mapped source ${mapping.source}`);
      descriptors.push({
        role: "mapped_payload",
        source,
        target: `${mapping.target}/${source.slice(prefix.length)}`
      });
    }
  }

  for (const mapping of exactPayloadMappings) {
    assertCondition(tracked.has(mapping.source), `Windows package input must be Git-tracked: ${mapping.source}`);
    descriptors.push(mapping);
  }

  for (const desktopRoot of desktopRoots) {
    assertNoReparseTree(resolvedRoot, desktopRoot, `Windows desktop source ${desktopRoot}`);
    const prefix = `${desktopRoot}/`;
    const sources = selectedTracked.filter((source) => source.startsWith(prefix)).sort(compareOrdinal);
    assertCondition(sources.length > 0, `Windows desktop source has no Git-tracked files: ${desktopRoot}`);
    for (const source of sources) {
      validateExtension(source, desktopExtensions, `Windows desktop source ${desktopRoot}`);
      descriptors.push({ role: "desktop_source", source, target: null });
    }
    const untrackedBuildSources = collectPhysicalBuildSources(resolvedRoot, desktopRoot)
      .filter((source) => !tracked.has(source));
    assertCondition(
      untrackedBuildSources.length === 0,
      `Windows desktop build source must be Git-tracked before publishing: ${untrackedBuildSources.slice(0, 5).join(", ")}`
    );
  }

  for (const source of buildTools) {
    assertCondition(tracked.has(source), `Windows build tool must be Git-tracked: ${source}`);
    descriptors.push({ role: "build_tool", source, target: null });
  }

  const bookmarkManifestPath = assertPlainPathWithinRoot(
    resolvedRoot,
    "manager/bookmarks/bookmark-package.json",
    "Windows bookmark package manifest"
  );
  const bookmarkManifest = JSON.parse(readFileSync(bookmarkManifestPath, "utf8").replace(/^\uFEFF/u, ""));
  assertCondition(Array.isArray(bookmarkManifest?.platforms), "Windows bookmark package platforms must be an array");
  let bookmarkArtifactCount = 0;
  for (const platform of bookmarkManifest.platforms) {
    assertCondition(Array.isArray(platform?.variants), "Windows bookmark package variants must be arrays");
    for (const variant of platform.variants) {
      const artifact = normalizeRelative(variant?.artifact);
      const source = normalizeRelative(`manager/bookmarks/artifacts/${artifact}`);
      assertCondition(tracked.has(source), `Windows bookmark artifact must be Git-tracked: ${source}`);
      assertCondition(path.extname(source).toLowerCase() === ".js", `Windows bookmark artifact has an unapproved file type: ${source}`);
      const target = `payload/bookmarks/artifacts/${artifact}`;
      const entry = fileEntry(resolvedRoot, { role: "bookmark_artifact", source, target });
      assertCondition(entry.bytes === variant.bytes, `Windows bookmark artifact byte count drifted: ${source}`);
      assertCondition(entry.sha256 === variant.sha256, `Windows bookmark artifact SHA-256 drifted: ${source}`);
      descriptors.push({ role: "bookmark_artifact", source, target });
      bookmarkArtifactCount += 1;
    }
  }
  assertCondition(bookmarkArtifactCount === bookmarkManifest.variant_count, "Windows bookmark artifact count drifted from bookmark-package.json");

  const selectedSources = descriptors.map((item) => normalizeRelative(item.source));
  assertCondition(new Set(selectedSources).size === selectedSources.length, "Windows build input source paths are duplicated");
  validatePrivacyPolicy(resolvedRoot, selectedSources);

  const files = descriptors.map((descriptor) => fileEntry(resolvedRoot, descriptor));
  const releaseSpec = JSON.parse(readFileSync(path.join(resolvedRoot, "release-spec.json"), "utf8").replace(/^\uFEFF/u, ""));
  const contractBytes = Buffer.from(JSON.stringify(stableWindowsPublishContract(releaseSpec)), "utf8");
  files.push({
    role: "contract_projection",
    source: "release-spec.json",
    target: null,
    projection: "stable_windows_publish_contract",
    bytes: contractBytes.length,
    sha256: sha256Lower(contractBytes)
  });
  const targeted = files.filter((entry) => entry.target !== null).map((entry) => entry.target);
  assertCondition(new Set(targeted.map((value) => value.toLowerCase())).size === targeted.length, "Windows package target paths are duplicated");
  files.sort((left, right) => compareOrdinal(
    `${left.role}\0${left.source}\0${left.target ?? ""}\0${left.projection ?? ""}`,
    `${right.role}\0${right.source}\0${right.target ?? ""}\0${right.projection ?? ""}`
  ));
  const canonical = files
    .map((entry) => `${entry.role}\0${entry.source}\0${entry.target ?? ""}\0${entry.projection ?? ""}\0${entry.bytes}\0${entry.sha256}\n`)
    .join("");
  return {
    format: windowsBuildInputFormat,
    version: windowsBuildInputVersion,
    aggregate_sha256: sha256Lower(Buffer.from(canonical, "utf8")),
    file_count: files.length,
    files
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    throw new Error("Usage: node manager/scripts/windows-build-inputs.mjs [--json]");
  }
  const snapshot = collectWindowsBuildInputs();
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
