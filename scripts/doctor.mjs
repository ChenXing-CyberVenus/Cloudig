#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertStrictBookmarkletArtifact,
  currentBookmarkletBuildTargets,
  validateCurrentBookmarkletBuildTargets
} from "./build-current-bookmarklets.mjs";
import {
  bookmarkSetVersion,
  validateBookmarkSetVersion
} from "./bookmarklet-targets.mjs";
import {
  collectWindowsBuildInputs,
  windowsBuildInputFormat,
  windowsBuildInputVersion
} from "../manager/scripts/windows-build-inputs.mjs";

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseSpecPath = "release-spec.json";
const semverPattern = /^\d+\.\d+\.\d+$/u;
const sha256UpperPattern = /^[0-9A-F]{64}$/u;
const canonicalWindowsPaths = Object.freeze({
  publish_script: "manager/scripts/publish-windows.ps1",
  desktop_project: "manager/windows/Cloudig.Desktop/Cloudig.Desktop.csproj",
  bookmark_package: "manager/bookmarks/bookmark-package.json",
  bookmark_package_verifier: "manager/scripts/verify-bookmark-package.mjs",
  runtime_lock: "manager/windows/runtime-lock.json"
});
const windowsBuildInputsPath = "manager/scripts/windows-build-inputs.mjs";
const windowsReleaseVerifierPath = "manager/scripts/verify-windows-release.ps1";
const bookmarkPackageFactsCache = new Map();
const preservedPackageFactsCache = new Map();
const ignoreObservationCache = new Map();

function normalizeRelative(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\/+/u, "");
}

function lowerRelative(value) {
  return normalizeRelative(value).toLocaleLowerCase("en-US");
}

function resolveProjectPath(root, relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`project path must be relative and stay inside the repository: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`project path escaped the repository: ${relativePath}`);
  }
  return resolved;
}

function readBytes(root, relativePath) {
  return readFileSync(assertProjectFile(root, relativePath));
}

function readText(root, relativePath) {
  return readBytes(root, relativePath).toString("utf8");
}

function readJson(root, relativePath) {
  try {
    return JSON.parse(readText(root, relativePath).replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function sha256Upper(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSemver(value, label) {
  assertCondition(semverPattern.test(String(value)), `${label} must be a complete SemVer: ${value}`);
}

function assertPositiveInteger(value, label, { allowZero = false } = {}) {
  assertCondition(
    Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0),
    `${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`
  );
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  assertCondition(
    Array.isArray(value)
      && (allowEmpty || value.length > 0)
      && value.every((item) => typeof item === "string" && item.length > 0),
    `${label} must be ${allowEmpty ? "a" : "a non-empty"} string array`
  );
  assertCondition(new Set(value).size === value.length, `${label} contains duplicate values`);
}

function assertProjectFile(root, relativePath, label = relativePath) {
  const target = resolveProjectPath(root, relativePath);
  assertCondition(existsSync(target), `${label} does not exist: ${relativePath}`);
  const information = lstatSync(target);
  assertCondition(!information.isSymbolicLink(), `${label} must not be a symbolic link: ${relativePath}`);
  assertCondition(information.isFile(), `${label} is not a plain file: ${relativePath}`);
  assertRealPathInsideRoot(root, target, label);
  return target;
}

function assertProjectDirectory(root, relativePath, label = relativePath) {
  const target = resolveProjectPath(root, relativePath);
  assertCondition(existsSync(target), `${label} does not exist: ${relativePath}`);
  const information = lstatSync(target);
  assertCondition(!information.isSymbolicLink(), `${label} must not be a symbolic link or junction: ${relativePath}`);
  assertCondition(information.isDirectory(), `${label} is not a plain directory: ${relativePath}`);
  assertRealPathInsideRoot(root, target, label);
  return target;
}

function assertRealPathInsideRoot(root, target, label) {
  const realRoot = realpathSync(path.resolve(root));
  const realTarget = realpathSync(target);
  const fromRoot = path.relative(realRoot, realTarget);
  assertCondition(
    fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot),
    `${label} resolves outside the repository`
  );
  return realTarget;
}

function assertUniqueLiteral(text, literal, label) {
  const count = String(text).split(String(literal)).length - 1;
  assertCondition(count === 1, `${label} must contain exactly one ${JSON.stringify(literal)}; got ${count}`);
}

function assertContains(text, literal, label) {
  assertCondition(String(text).includes(String(literal)), `${label} is missing ${JSON.stringify(literal)}`);
}

function extractUniqueMatch(text, expression, label) {
  assertCondition(expression.global, `${label} validator expression must be global`);
  const matches = [...String(text).matchAll(expression)];
  assertCondition(matches.length === 1, `${label} must have exactly one match; got ${matches.length}`);
  return matches[0];
}

function extractUniqueXmlValue(text, tag, label = tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = extractUniqueMatch(
    text,
    new RegExp(`<${escaped}>([^<]+)</${escaped}>`, "gu"),
    label
  );
  return match[1].trim();
}

function collectTrackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    windowsHide: true
  });
  return output.split("\0").filter(Boolean).map(normalizeRelative);
}

function addCheck(checks, id, run) {
  try {
    const detail = run();
    checks.push({
      id,
      ok: true,
      ...(detail === undefined ? {} : { detail })
    });
  } catch (error) {
    checks.push({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function validateSpecShape(spec) {
  assertCondition(spec?.format === "cloudig/release-spec", "release spec format must be cloudig/release-spec");
  assertCondition(spec?.version === "0.2.0", "release spec version must be 0.2.0");
  assertSemver(spec?.product?.version, "product.version");
  assertCondition(spec.product.display_version === `V${spec.product.version}`, "product.display_version must match product.version");
  assertCondition(
    spec.snapshot_id === `cloudig-${spec.product.version}+bookmarks-${spec.bookmarklets?.accepted_set_version}`,
    "snapshot_id must identify the product and accepted bookmarklet snapshots"
  );

  for (const [name, version] of Object.entries({
    parser: spec?.components?.parser,
    reader: spec?.components?.reader,
    library: spec?.components?.library,
    parse_state: spec?.components?.parse_state
  })) {
    assertSemver(version, `components.${name}`);
  }
  const schemas = spec?.components?.conversation_schemas;
  assertCondition(
    typeof schemas?.flat === "string" && typeof schemas?.branches === "string"
      && Object.keys(schemas).length === 2,
    "components.conversation_schemas must declare exactly flat and branches"
  );

  validateBookmarkSetVersion(spec?.bookmarklets?.accepted_set_version, "release spec");
  const profiles = spec.bookmarklets.profiles;
  for (const name of ["light", "full", "all_branches", "total"]) {
    assertPositiveInteger(profiles?.[name], `bookmarklets.profiles.${name}`);
  }
  assertCondition(
    profiles.total === profiles.light + profiles.full + profiles.all_branches,
    "bookmarklet total must equal Light + Full + AllBranches"
  );
  const accepted = spec.bookmarklets.accepted_artifacts;
  for (const name of ["pair_count", "file_count", "total_bytes", "min_total_bytes"]) {
    assertPositiveInteger(accepted?.[name], `bookmarklets.accepted_artifacts.${name}`);
  }
  assertCondition(accepted.file_count === accepted.pair_count * 2, "accepted artifact file_count must be two files per pair");
  assertCondition(
    sha256UpperPattern.test(accepted.manifest_sha256),
    "accepted artifact manifest_sha256 must be uppercase SHA-256"
  );

  const windows = spec?.windows_candidate;
  assertCondition(windows?.architecture === "win-x64", "windows_candidate.architecture must be win-x64");
  assertCondition(
    windows.release_name === `${spec.product.name}-V${spec.product.version}-${windows.architecture}`,
    "windows_candidate.release_name must match the product snapshot"
  );
  assertSemver(windows.release_manifest_version, "windows_candidate.release_manifest_version");
  assertSemver(windows.bookmark_package_version, "windows_candidate.bookmark_package_version");
  assertPositiveInteger(windows.packaged_platform_count, "windows_candidate.packaged_platform_count");
  assertPositiveInteger(windows.packaged_variant_count, "windows_candidate.packaged_variant_count");
  assertPositiveInteger(windows.effective_count_per_profile, "windows_candidate.effective_count_per_profile");
  assertCondition(
    ["integrated", "pending"].includes(windows.bookmark_integration),
    "windows_candidate.bookmark_integration must be integrated or pending"
  );
  assertCondition(
    windows?.package_selection?.status === "verified",
    "release spec 0.2.0 requires package_selection.status=verified"
  );
  assertCondition(
    JSON.stringify(windows.package_selection.profiles) === JSON.stringify(["light", "full", "all_branches"]),
    "package_selection.profiles must be light, full, all_branches in canonical order"
  );
  assertCondition(
    windows.package_selection.default_profile === "light",
    "package_selection.default_profile must be light"
  );
  assertCondition(
    JSON.stringify(windows.package_selection.all_branches_fallbacks) === JSON.stringify({
      gemini: "full",
      doubao: "full",
      chatglm: "full",
      yuanbao: "full"
    }),
    "package_selection.all_branches_fallbacks must declare the four accepted Full fallbacks"
  );
  assertCondition(
    ["ready", "blocked"].includes(windows.publish_readiness),
    "windows_candidate.publish_readiness must be ready or blocked"
  );
  for (const name of [
    "publish_script",
    "desktop_project",
    "bookmark_package",
    "bookmark_package_verifier"
  ]) {
    assertCondition(
      normalizeRelative(windows?.[name]) === canonicalWindowsPaths[name],
      `windows_candidate.${name} must be ${canonicalWindowsPaths[name]}`
    );
  }
  assertStringArray(windows.readiness_blockers, "windows_candidate.readiness_blockers", {
    allowEmpty: windows.publish_readiness === "ready"
  });

  const runtime = windows.runtime_lock;
  assertCondition(
    normalizeRelative(runtime?.path) === canonicalWindowsPaths.runtime_lock,
    `windows_candidate.runtime_lock.path must be ${canonicalWindowsPaths.runtime_lock}`
  );
  assertCondition(runtime?.format === "cloudig/windows-runtime-lock", "runtime lock format is invalid");
  assertSemver(runtime?.version, "windows_candidate.runtime_lock.version");
  assertSemver(runtime?.node_version, "windows_candidate.runtime_lock.node_version");
  assertCondition(
    /^\d+\.\d+\.\d+\.\d+$/u.test(String(runtime?.webview2_sdk_version)),
    "windows_candidate.runtime_lock.webview2_sdk_version must be a four-part SDK version"
  );
  assertCondition(typeof runtime?.target_framework === "string" && runtime.target_framework, "runtime target framework is missing");
  assertCondition(typeof runtime?.runtime_identifier === "string" && runtime.runtime_identifier, "runtime identifier is missing");
  assertCondition(typeof runtime?.self_contained === "boolean", "runtime self_contained must be boolean");
  assertCondition(typeof runtime?.webview2_runtime_channel === "string" && runtime.webview2_runtime_channel, "WebView2 runtime channel is missing");
  assertCondition(
    runtime?.webview2_offline_fallback === "optional_microsoft_signed_evergreen_standalone_x64",
    "WebView2 offline fallback policy is missing or unsupported"
  );
  assertCondition(
    runtime?.webview2_installer_bundled_by_default === false,
    "WebView2 offline installer must remain an explicit publisher input"
  );
  assertCondition(
    runtime?.webview2_installer_auto_execute === false,
    "WebView2 offline installer must not be auto-executed by the portable package"
  );
  assertCondition(
    runtime?.webview2_installer_authenticode_signer === "Microsoft Corporation",
    "WebView2 offline installer Authenticode signer policy is missing or unsupported"
  );
  assertStringArray(
    runtime?.webview2_approved_installers,
    "windows_candidate.runtime_lock.webview2_approved_installers",
    { allowEmpty: true }
  );
  assertCondition(
    runtime.webview2_approved_installers.every((digest) => /^[0-9a-f]{64}$/u.test(digest)),
    "windows_candidate.runtime_lock.webview2_approved_installers must contain lowercase SHA-256 values"
  );

  const candidate = windows.candidate_package;
  assertCondition(typeof candidate?.required_locally === "boolean", "candidate_package.required_locally must be boolean");
  for (const name of ["directory", "archive", "manifest"]) {
    assertCondition(typeof candidate?.[name] === "string" && candidate[name], `candidate_package.${name} is missing`);
  }
  assertCondition(
    normalizeRelative(candidate.directory) === `manager/dist/${windows.release_name}`,
    "candidate package directory must be derived from release_name"
  );
  assertCondition(
    normalizeRelative(candidate.archive) === `manager/dist/${windows.release_name}.zip`,
    "candidate package archive must be derived from release_name"
  );
  assertCondition(
    normalizeRelative(candidate.manifest) === `${normalizeRelative(candidate.directory)}/release-manifest.json`,
    "candidate package manifest must be inside its release directory"
  );
  assertCondition(
    typeof candidate?.executable?.path === "string" && candidate.executable.path,
    "candidate package executable path is missing"
  );
  assertCondition(
    normalizeRelative(candidate.executable.path) === "Cloudig.exe",
    "candidate package executable path must be Cloudig.exe"
  );
  assertPositiveInteger(candidate.payload_count, "candidate_package.payload_count");
  for (const [label, item] of Object.entries({
    manifest_file: candidate.manifest_file,
    executable: candidate.executable,
    archive_file: candidate.archive_file
  })) {
    assertPositiveInteger(item?.bytes, `candidate_package.${label}.bytes`);
    assertCondition(
      sha256UpperPattern.test(item?.sha256),
      `candidate_package.${label}.sha256 must be uppercase SHA-256`
    );
  }

  const preserved = windows.previous_preserved_package;
  assertCondition(
    typeof preserved?.required_locally === "boolean",
    "previous_preserved_package.required_locally must be boolean"
  );
  assertCondition(
    typeof preserved?.release_name === "string" && preserved.release_name !== windows.release_name,
    "previous_preserved_package.release_name must identify a different release"
  );
  validateBookmarkSetVersion(preserved?.bookmark_set_version, "previous preserved package");
  for (const name of ["directory", "archive", "manifest"]) {
    assertCondition(
      typeof preserved?.[name] === "string" && preserved[name],
      `previous_preserved_package.${name} is missing`
    );
  }
  assertCondition(
    normalizeRelative(preserved.directory) === `manager/dist/${preserved.release_name}`,
    "previous preserved package directory must be derived from its release_name"
  );
  assertCondition(
    normalizeRelative(preserved.archive) === `manager/dist/${preserved.release_name}.zip`,
    "previous preserved package archive must be derived from its release_name"
  );
  assertCondition(
    normalizeRelative(preserved.manifest) === `${normalizeRelative(preserved.directory)}/release-manifest.json`,
    "previous preserved package manifest must be inside its release directory"
  );
  assertPositiveInteger(preserved.payload_count, "previous_preserved_package.payload_count");
  for (const [label, item] of Object.entries({
    manifest_file: preserved.manifest_file,
    executable: preserved.executable,
    archive_file: preserved.archive_file
  })) {
    assertPositiveInteger(item?.bytes, `previous_preserved_package.${label}.bytes`);
    assertCondition(
      sha256UpperPattern.test(item?.sha256),
      `previous_preserved_package.${label}.sha256 must be uppercase SHA-256`
    );
  }
  assertCondition(
    typeof preserved.executable.path === "string" && preserved.executable.path,
    "previous preserved package executable path is missing"
  );
  assertCondition(
    normalizeRelative(preserved.executable.path) === "Cloudig.exe",
    "previous preserved package executable path must be Cloudig.exe"
  );

  const policy = spec?.policy;
  assertPositiveInteger(policy?.project_state_max_lines, "policy.project_state_max_lines");
  for (const name of [
    "required_entries",
    "license_required_lines",
    "forbidden_tracked_prefixes",
    "forbidden_tracked_patterns"
  ]) {
    assertStringArray(policy?.[name], `policy.${name}`);
  }
  for (const expression of policy.forbidden_tracked_patterns) {
    try {
      new RegExp(expression, "u");
    } catch (error) {
      throw new Error(`invalid forbidden tracked pattern ${JSON.stringify(expression)}: ${error.message}`);
    }
  }
  assertCondition(Array.isArray(policy.ignore_sentinels) && policy.ignore_sentinels.length > 0, "policy.ignore_sentinels must be non-empty");
  const sentinelPaths = new Set();
  for (const sentinel of policy.ignore_sentinels) {
    assertCondition(
      typeof sentinel?.path === "string" && sentinel.path && typeof sentinel?.ignored === "boolean",
      "each ignore sentinel must have a path and boolean ignored result"
    );
    const normalized = normalizeRelative(sentinel.path);
    assertCondition(!sentinelPaths.has(normalized), `duplicate ignore sentinel: ${normalized}`);
    sentinelPaths.add(normalized);
  }
  assertCondition(
    policy.ignore_sentinels.some((sentinel) => sentinel.path === ".env.example" && sentinel.ignored === false),
    "ignore sentinels must preserve the public .env.example negation"
  );
  return spec.snapshot_id;
}

function validateComponentVersions(root, spec) {
  const parserSource = readText(root, "parser/src/index.mjs");
  assertUniqueLiteral(parserSource, "version: PARSER_VERSION_HISTORY.current", "Parser version-history projection");
  const parserHistory = readJson(root, "parser/version-history.json");
  assertCondition(parserHistory?.format === "cloudig/parser-version-history", "Parser version history format is invalid");
  assertSemver(parserHistory?.version, "Parser version history version");
  assertCondition(parserHistory?.current === spec.components.parser, "Parser version history current release drifted");
  assertCondition(Array.isArray(parserHistory.releases) && parserHistory.releases.length > 0, "Parser version history must contain releases");
  const parserHistoryVersions = new Set();
  for (const release of parserHistory.releases) {
    assertSemver(release?.parser_version, "Parser version history release");
    assertCondition(!parserHistoryVersions.has(release.parser_version), `duplicate Parser version history release ${release.parser_version}`);
    parserHistoryVersions.add(release.parser_version);
    assertCondition(release?.adapters && typeof release.adapters === "object" && !Array.isArray(release.adapters), `Parser ${release.parser_version} needs an adapter map`);
    for (const [id, version] of Object.entries(release.adapters)) {
      assertCondition(/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id), `invalid Parser adapter id ${id}`);
      assertSemver(version, `Parser adapter ${id}`);
    }
  }
  const currentParserHistory = parserHistory.releases.find((release) => release.parser_version === parserHistory.current);
  assertCondition(Boolean(currentParserHistory), "Parser version history omits its current release");
  const sourceRegistry = readJson(root, "parser/source-families.json");
  const expectedAdapterIds = [...sourceRegistry.sources.map((source) => source.id), "anthropic-claude-export-json"].sort();
  assertCondition(
    JSON.stringify(Object.keys(currentParserHistory.adapters).sort()) === JSON.stringify(expectedAdapterIds),
    "Current Parser version history must map every registered web adapter and the Claude official-export adapter exactly once"
  );
  assertUniqueLiteral(
    parserSource,
    `output_schema: "${spec.components.conversation_schemas.flat}"`,
    "Parser flat schema source"
  );
  assertContains(
    parserSource,
    `"${spec.components.conversation_schemas.branches}"`,
    "Parser branches schema source"
  );

  const claudeSource = readText(root, "parser/src/claude-json-adapter.mjs");
  assertUniqueLiteral(
    claudeSource,
    `export const CLAUDE_CONVERSATION_SCHEMA = "${spec.components.conversation_schemas.branches}";`,
    "Claude Parser schema constant"
  );
  assertUniqueLiteral(claudeSource, "schema: CLAUDE_CONVERSATION_SCHEMA,", "Claude Parser schema projection");
  assertUniqueLiteral(claudeSource, "parser_version: PARSER.version,", "Claude Parser version projection");

  const parseStateSource = readText(root, "parser/src/parse-state.mjs");
  assertUniqueLiteral(
    parseStateSource,
    `export const PARSE_STATE_VERSION = "${spec.components.parse_state}";`,
    "parse-state version source"
  );

  const versionPolicy = readJson(root, "parser/version-policy.json");
  assertCondition(versionPolicy?.format === "cloudig/parser-version-policy", "Parser version policy format is invalid");
  assertCondition(Array.isArray(versionPolicy.rules) && versionPolicy.rules.length > 0, "Parser version policy must contain rules");
  const matchingRules = versionPolicy.rules.filter((rule) =>
    rule?.active_from_parser === spec.components.parser
  );
  assertCondition(
    matchingRules.length === 1,
    `Parser version policy must contain exactly one rule active from ${spec.components.parser}`
  );
  const [rule] = matchingRules;
  assertCondition(rule.match?.parser_version_before === spec.components.parser, "Parser version policy parser threshold drifted");
  assertCondition(rule.match?.include_missing_parser_version === true, "Parser version policy must cover missing Parser watermarks");
  assertCondition(rule.match?.include_missing_parser_adapter === true, "Parser version policy must cover missing Parser adapter watermarks");
  assertCondition(
    rule.match?.minimum_schema_by_family?.["ai-chat-archive/conversation/0.1"] === spec.components.conversation_schemas.flat,
    "Parser flat minimum schema policy drifted"
  );
  assertCondition(
    rule.match?.minimum_schema_by_family?.["ai-chat-archive/conversation/0.2"] === spec.components.conversation_schemas.branches,
    "Parser branches minimum schema policy drifted"
  );

  const librarySource = readText(root, "library/core.js");
  assertUniqueLiteral(librarySource, 'const FORMAT = "cloudig/library";', "Library format source");
  assertUniqueLiteral(librarySource, `const VERSION = "${spec.components.library}";`, "Library version source");
  assertUniqueLiteral(
    librarySource,
    "isRecord, cleanString, validateLibrary, assertLibrary, normalizeLibrary, serializeLibrary,",
    "Library validator public export"
  );
  const librarySchema = readJson(root, `library/cloudig-library-${spec.components.library}.schema.json`);
  assertCondition(
    librarySchema.$id === `urn:cloudig:schema:library:${spec.components.library}`,
    "Library schema $id does not match the component version"
  );
  assertCondition(librarySchema?.properties?.format?.const === "cloudig/library", "Library schema format discriminator drifted");
  assertCondition(
    librarySchema?.properties?.version?.const === spec.components.library,
    "Library schema version discriminator drifted"
  );
  assertCondition(
    Array.isArray(librarySchema.required)
      && librarySchema.required.includes("format")
      && librarySchema.required.includes("version"),
    "Library schema must require format and version"
  );

  const readerSource = readText(root, "reader/src/core.js");
  assertUniqueLiteral(readerSource, `const READER_VERSION = "${spec.components.reader}";`, "Reader version source");
  assertUniqueLiteral(
    readerSource,
    `const SCHEMA = "${spec.components.conversation_schemas.flat}";`,
    "Reader flat schema source"
  );
  assertContains(readerSource, `"${spec.components.conversation_schemas.branches}"`, "Reader branches schema support");
  assertUniqueLiteral(
    readText(root, "reader/src/index.html"),
    `<b>V${spec.components.reader}</b>`,
    "Reader source UI version"
  );
  assertUniqueLiteral(
    readText(root, "reader/reader.html"),
    `<b>V${spec.components.reader}</b>`,
    "Reader built UI version"
  );

  return {
    parser: spec.components.parser,
    reader: spec.components.reader,
    library: spec.components.library,
    parse_state: spec.components.parse_state
  };
}

function validateConversationSchemas(root, spec) {
  const validator = readText(root, "schema/validate.mjs");
  assertUniqueLiteral(
    validator,
    `export const CONVERSATION_SCHEMA_CURRENT = "${spec.components.conversation_schemas.flat}";`,
    "flat schema validator constant"
  );
  assertUniqueLiteral(
    validator,
    `export const CONVERSATION_SCHEMA_BRANCHES_CURRENT = "${spec.components.conversation_schemas.branches}";`,
    "branches schema validator constant"
  );

  for (const [family, schemaName] of Object.entries(spec.components.conversation_schemas)) {
    const version = schemaName.slice(schemaName.lastIndexOf("/") + 1);
    const schema = readJson(root, `schema/conversation-${version}.schema.json`);
    assertCondition(
      schema.$id === `urn:ai-chat-archive:schema:conversation:${version}`,
      `${family} schema $id does not match ${schemaName}`
    );
    assertCondition(schema?.properties?.schema?.const === schemaName, `${family} schema discriminator does not match ${schemaName}`);
    assertCondition(
      Array.isArray(schema.required) && schema.required.includes("parser_version"),
      `${family} current schema must require parser_version`
    );
    assertCondition(
      Array.isArray(schema.required) && schema.required.includes("parser_adapter")
        && schema?.properties?.parser_adapter?.additionalProperties === false,
      `${family} current schema must require an exact parser_adapter record`
    );
  }
  return spec.components.conversation_schemas;
}

function validateRuntimeLock(root, spec) {
  const windows = spec.windows_candidate;
  const declared = windows.runtime_lock;
  const lock = readJson(root, declared.path);
  assertCondition(lock?.format === declared.format, "runtime-lock format drifted");
  assertCondition(lock?.version === declared.version, "runtime-lock version drifted");
  assertCondition(lock?.node?.version === declared.node_version, "runtime-lock Node version drifted");
  assertCondition(lock?.dotnet?.target_framework === declared.target_framework, "runtime-lock target framework drifted");
  assertCondition(lock?.dotnet?.runtime_identifier === declared.runtime_identifier, "runtime-lock runtime identifier drifted");
  assertCondition(lock?.dotnet?.self_contained === declared.self_contained, "runtime-lock self-contained flag drifted");
  assertCondition(lock?.webview2?.sdk_version === declared.webview2_sdk_version, "runtime-lock WebView2 SDK drifted");
  assertCondition(lock?.webview2?.runtime_channel === declared.webview2_runtime_channel, "runtime-lock WebView2 channel drifted");
  const webviewDistribution = lock?.webview2?.distribution;
  assertCondition(webviewDistribution?.primary === "system_evergreen", "runtime-lock WebView2 primary distribution drifted");
  assertCondition(
    webviewDistribution?.offline_fallback === declared.webview2_offline_fallback,
    "runtime-lock WebView2 offline fallback drifted"
  );
  assertCondition(
    webviewDistribution?.installer_filename === "MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
    "runtime-lock WebView2 offline installer filename drifted"
  );
  assertCondition(
    Array.isArray(webviewDistribution?.silent_install_arguments)
      && webviewDistribution.silent_install_arguments.join(" ") === "/silent /install",
    "runtime-lock WebView2 silent install arguments drifted"
  );
  assertCondition(
    webviewDistribution?.bundled_by_default === declared.webview2_installer_bundled_by_default
      && webviewDistribution?.auto_execute === declared.webview2_installer_auto_execute
      && webviewDistribution?.authenticode_signer_cn === declared.webview2_installer_authenticode_signer
      && webviewDistribution?.authenticode_required_when_bundled === true
      && webviewDistribution?.product_identity_required_when_bundled === true,
    "runtime-lock WebView2 signed opt-in bundle policy drifted"
  );
  assertStringArray(webviewDistribution?.approved_installers, "runtime-lock WebView2 approved_installers", {
    allowEmpty: true
  });
  assertCondition(
    webviewDistribution.approved_installers.every((digest) => /^[0-9a-f]{64}$/u.test(digest)),
    "runtime-lock WebView2 approved_installers must contain lowercase SHA-256 values"
  );
  assertCondition(
    JSON.stringify(webviewDistribution.approved_installers)
      === JSON.stringify(declared.webview2_approved_installers),
    "runtime-lock WebView2 approved installer allowlist drifted"
  );

  const publishScript = readText(root, windows.publish_script);
  for (const token of [
    "WebView2Installer",
    "approved_installers",
    "Get-AuthenticodeSignature",
    "Microsoft Corporation",
    "ProductName",
    "FileDescription",
    "OriginalFilename",
    "signer_thumbprint",
    "cloudig/webview2-offline-prerequisite",
    "auto_execute = $false",
    "Assert-NoReparseComponents",
    "Assert-NoReparseTree"
  ]) {
    assertCondition(publishScript.includes(token), `Windows publisher is missing WebView2 prerequisite token: ${token}`);
  }

  const smokeScript = readText(root, "manager/scripts/smoke-webview2.ps1");
  for (const forbidden of ["Get-CimInstance", "MainWindowHandle", "Stop-Process"]) {
    assertCondition(!smokeScript.includes(forbidden), `WebView2 smoke must not depend on ${forbidden}`);
  }
  for (const required of [
    "CreateToolhelp32Snapshot",
    "QueryFullProcessImageNameW",
    "GetProcessTimes",
    "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
    "CREATE_SUSPENDED",
    "AssignProcessToJobObject",
    "ResumeThread",
    "TerminateAndClose",
    "process_enumerator = \"Toolhelp32\"",
    "job_kill_on_close = $true"
  ]) {
    assertCondition(smokeScript.includes(required), `WebView2 smoke native lifecycle is missing ${required}`);
  }
  const smokeCleanupRemove = smokeScript.lastIndexOf("Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force");
  const smokeComponentGuard = smokeScript.lastIndexOf("Assert-NoReparseComponents $resolvedSmokeRoot");
  const smokeTreeGuard = smokeScript.lastIndexOf("Assert-NoReparseTree $resolvedSmokeRoot");
  assertCondition(
    smokeComponentGuard >= 0
      && smokeTreeGuard > smokeComponentGuard
      && smokeCleanupRemove > smokeTreeGuard,
    "WebView2 smoke cleanup must reject reparse components and the full tree before recursive removal"
  );

  const project = readText(root, windows.desktop_project);
  assertCondition(
    extractUniqueXmlValue(project, "TargetFramework", "Windows TargetFramework") === declared.target_framework,
    "Windows project target framework does not match runtime-lock"
  );
  assertCondition(
    extractUniqueXmlValue(project, "RuntimeIdentifier", "Windows RuntimeIdentifier") === declared.runtime_identifier,
    "Windows project runtime identifier does not match runtime-lock"
  );
  assertCondition(
    extractUniqueXmlValue(project, "SelfContained", "Windows SelfContained") === String(declared.self_contained),
    "Windows project self-contained flag does not match runtime-lock"
  );
  assertCondition(
    extractUniqueXmlValue(project, "PublishSingleFile", "Windows PublishSingleFile") === "true",
    "Windows project must remain a single-file publish"
  );
  const webview = extractUniqueMatch(
    project,
    /<PackageReference Include="Microsoft\.Web\.WebView2" Version="([^"]+)"\s*\/>/gu,
    "Windows WebView2 PackageReference"
  )[1];
  assertCondition(webview === declared.webview2_sdk_version, "Windows project WebView2 SDK does not match runtime-lock");

  return {
    node: declared.node_version,
    target_framework: declared.target_framework,
    runtime_identifier: declared.runtime_identifier,
    webview2: declared.webview2_sdk_version
  };
}

function validateManagerSnapshot(root, spec) {
  const { product, windows_candidate: windows } = spec;
  const project = readText(root, windows.desktop_project);
  assertCondition(extractUniqueXmlValue(project, "Version", "Windows project version") === product.version, "Windows project version drifted");
  assertCondition(
    !project.includes('..\\..\\..\\bookmarklets\\*.min.js'),
    "Windows project must not scan the empty bookmarklet root"
  );

  const appManifest = readText(root, "manager/windows/Cloudig.Desktop/app.manifest");
  assertUniqueLiteral(appManifest, `assemblyIdentity version="${product.version}.0"`, "Windows assembly identity");

  const mainWindow = readText(root, "manager/windows/Cloudig.Desktop/MainWindow.xaml.cs");
  assertUniqueLiteral(mainWindow, `version = "${product.display_version}"`, "Windows startup version");

  const managerHtml = readText(root, "manager/web/index.html");
  assertCondition(
    managerHtml.split(product.display_version).length - 1 >= 2,
    "Manager source UI must expose the product version in both cover and toolbar"
  );
  const managerJs = readText(root, "manager/web/app.js");
  assertCondition(
    managerJs.split(`|| "${product.display_version}"`).length - 1 >= 2,
    "Manager source fallback must expose the product version in both cover and toolbar"
  );

  const publish = readText(root, windows.publish_script);
  assertCondition(
    !publish.includes('Get-ChildItem -LiteralPath (Join-Path $projectRoot "bookmarklets") -Filter "*.min.js" -File'),
    "Windows publish must not scan the empty bookmarklet root"
  );
  for (const [label, literal] of Object.entries({
    release_name: "$releaseSpec.windows_candidate.release_name",
    architecture: "$releaseSpec.windows_candidate.architecture",
    release_manifest_version: "$releaseSpec.windows_candidate.release_manifest_version",
    bookmark_package_version: "$releaseSpec.windows_candidate.bookmark_package_version",
    packaged_bookmark_set_version: "$releaseSpec.windows_candidate.packaged_bookmark_set_version",
    packaged_variant_count: "$releaseSpec.windows_candidate.packaged_variant_count",
    cloudig: "$releaseSpec.product.version",
    parser: "$releaseSpec.components.parser",
    reader: "$releaseSpec.components.reader",
    library: "$releaseSpec.components.library",
    parse_state: "$releaseSpec.components.parse_state",
    flat_schema: "$releaseSpec.components.conversation_schemas.flat",
    branches_schema: "$releaseSpec.components.conversation_schemas.branches"
  })) {
    assertContains(publish, literal, `Windows publish ${label} projection`);
  }
  const buildInputsSource = readText(root, windowsBuildInputsPath);
  assertContains(buildInputsSource, "for (const platform of bookmarkManifest.platforms)", "Windows release bookmark platform projection");
  assertContains(buildInputsSource, "for (const variant of platform.variants)", "Windows release bookmark variant projection");
  for (const literal of [
    "build_inputs = $buildInputs",
    "Commit-ReleaseTransaction",
    "Invoke-WindowsReleaseVerifier",
    "non-permitted path"
  ]) assertContains(publish, literal, "Windows hardened publisher");
  assertProjectFile(root, windowsReleaseVerifierPath, "Windows release verifier");
  assertContains(
    publish,
    "bookmark_package_version = $bookmarkPackage.version",
    "Windows release bookmark package version projection"
  );
  assertContains(
    publish,
    "bookmark_variant_count = [int]$bookmarkPackage.variant_count",
    "Windows release bookmark variant count projection"
  );
  assertContains(
    publish,
    "bookmark_set_version = $bookmarkPackage.bookmark_set_version",
    "Windows release bookmark snapshot projection"
  );

  return { release: windows.release_name, architecture: windows.architecture };
}

function runBookmarkPackageVerifier(root, spec) {
  const windows = spec.windows_candidate;
  assertCondition(
    normalizeRelative(windows.bookmark_package_verifier) === canonicalWindowsPaths.bookmark_package_verifier,
    `bookmark package verifier must be ${canonicalWindowsPaths.bookmark_package_verifier}`
  );
  const verifierPath = assertProjectFile(
    root,
    canonicalWindowsPaths.bookmark_package_verifier,
    "bookmark package verifier"
  );
  const cacheKey = `${path.resolve(root)}\0${verifierPath}`;
  let facts = bookmarkPackageFactsCache.get(cacheKey);
  if (!facts) {
    const result = spawnSync(process.execPath, [verifierPath], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error) throw result.error;
    assertCondition(result.status === 0, result.stderr || result.stdout || "bookmark package verifier failed");
    try {
      facts = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`bookmark package verifier did not return JSON: ${error.message}`);
    }
    bookmarkPackageFactsCache.set(cacheKey, facts);
  }

  const manifest = readJson(root, windows.bookmark_package);
  assertCondition(manifest?.format === "cloudig/bookmark-package", "Manager bookmark package format is invalid");
  assertCondition(
    manifest?.version === windows.bookmark_package_version,
    "Manager bookmark package version drifted"
  );
  assertCondition(
    manifest.bookmark_set_version === windows.packaged_bookmark_set_version,
    "Manager bookmark package does not match the declared Windows bookmark snapshot"
  );
  assertCondition(
    manifest.platform_count === windows.packaged_platform_count,
    "Manager bookmark package platform_count does not match the release spec"
  );
  assertCondition(
    manifest.variant_count === windows.packaged_variant_count,
    "Manager bookmark package variant_count does not match the release spec"
  );
  assertCondition(
    manifest.effective_count_per_profile === windows.effective_count_per_profile,
    "Manager bookmark package effective_count_per_profile does not match the release spec"
  );
  assertCondition(
    JSON.stringify(manifest.profiles) === JSON.stringify(windows.package_selection.profiles),
    "Manager bookmark package profiles do not match package_selection"
  );
  assertCondition(
    manifest.default_profile === windows.package_selection.default_profile,
    "Manager bookmark package default_profile does not match package_selection"
  );
  const manifestFallbacks = Object.fromEntries(
    (manifest.platforms ?? [])
      .filter((platform) => platform?.fallback?.all_branches)
      .map((platform) => [platform.id, platform.fallback.all_branches])
  );
  assertCondition(
    JSON.stringify(manifestFallbacks) === JSON.stringify(windows.package_selection.all_branches_fallbacks),
    "Manager bookmark package AllBranches fallback map does not match package_selection"
  );
  assertCondition(facts?.ok === true, "bookmark package verifier did not report ok");
  assertCondition(
    facts.bookmark_set_version === windows.packaged_bookmark_set_version,
    "verified bookmark package set drifted"
  );
  assertCondition(
    facts.platform_count === windows.packaged_platform_count,
    "verified bookmark package platform_count drifted"
  );
  assertCondition(
    facts.variant_count === windows.packaged_variant_count,
    "verified bookmark package variant_count drifted"
  );
  assertCondition(
    facts.effective_count_per_profile === windows.effective_count_per_profile,
    "verified bookmark package effective_count_per_profile drifted"
  );
  assertCondition(facts.artifacts_modified === 0, "bookmark package verifier must not modify artifacts");
  return facts;
}

function safeManifestRelative(value, label) {
  const normalized = normalizeRelative(value);
  assertCondition(
    normalized
      && !path.isAbsolute(normalized)
      && normalized !== ".."
      && !normalized.startsWith("../")
      && !normalized.includes("/../"),
    `${label} is not a safe relative path: ${value}`
  );
  return normalized;
}

function walkPlainFiles(rootDirectory, relativeDirectory = "", output = []) {
  const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relative = normalizeRelative(path.join(relativeDirectory, entry.name));
    const absolute = path.join(rootDirectory, relative);
    const information = lstatSync(absolute);
    assertCondition(!information.isSymbolicLink(), `preserved package contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) walkPlainFiles(rootDirectory, relative, output);
    else {
      assertCondition(entry.isFile(), `preserved package contains a non-file entry: ${relative}`);
      output.push(relative);
    }
  }
  return output;
}

function runWindowsReleaseVerifier(root, directory, archive, releaseName, label) {
  const verifier = assertProjectFile(root, windowsReleaseVerifierPath, "Windows release verifier");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      verifier,
      "-Directory",
      directory,
      "-Archive",
      archive,
      "-ReleaseName",
      releaseName,
      "-Boundary",
      path.resolve(root)
    ],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 }
  );
  if (result.error) throw result.error;
  assertCondition(
    result.status === 0,
    `${label} ZIP verification failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`
  );
  try {
    const facts = JSON.parse(result.stdout.replace(/^\uFEFF/u, "").trim());
    assertCondition(facts?.ok === true, `${label} ZIP verifier did not report success`);
    return facts;
  } catch (error) {
    throw new Error(`${label} ZIP verifier returned invalid JSON: ${error.message}`);
  }
}

function readLocalPackageFacts(root, packageSpec, label, releaseName) {

  let directory = resolveProjectPath(root, packageSpec.directory);
  let archive = resolveProjectPath(root, packageSpec.archive);
  let manifestPath = resolveProjectPath(root, packageSpec.manifest);
  const existence = {
    directory: existsSync(directory),
    archive: existsSync(archive),
    manifest: existsSync(manifestPath)
  };
  if (!existence.directory && !existence.archive && !existence.manifest) {
    return Object.freeze({ status: "absent" });
  }
  assertCondition(
    existence.directory && existence.archive && existence.manifest,
    `${label} is incomplete: ${JSON.stringify(existence)}`
  );
  directory = assertProjectDirectory(root, packageSpec.directory, `${label} directory`);
  archive = assertProjectFile(root, packageSpec.archive, `${label} archive`);
  manifestPath = assertProjectFile(root, packageSpec.manifest, `${label} manifest`);

  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} manifest is invalid JSON: ${error.message}`);
  }
  assertCondition(Array.isArray(manifest.files), `${label} manifest files must be an array`);
  const declaredFiles = new Map();
  for (const [index, item] of manifest.files.entries()) {
    const relative = safeManifestRelative(item?.path, `${label} manifest files[${index}].path`);
    assertCondition(!declaredFiles.has(relative), `${label} manifest contains duplicate path: ${relative}`);
    assertPositiveInteger(item?.bytes, `${label} manifest ${relative} bytes`);
    assertCondition(/^[0-9a-f]{64}$/u.test(item?.sha256), `${label} manifest ${relative} hash is invalid`);
    declaredFiles.set(relative, item);
  }

  const manifestRelative = normalizeRelative(path.relative(directory, manifestPath));
  const actualFiles = walkPlainFiles(directory).sort();
  const expectedFiles = [...declaredFiles.keys(), manifestRelative].sort();
  assertCondition(
    JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    `${label} directory file set does not exactly match its manifest plus release-manifest.json`
  );

  const verifiedPayloads = [];
  for (const [relative, item] of declaredFiles) {
    const bytes = readFileSync(path.join(directory, relative));
    assertCondition(bytes.length === item.bytes, `${label} byte count mismatch: ${relative}`);
    const digest = sha256Upper(bytes);
    assertCondition(digest === item.sha256.toUpperCase(), `${label} hash mismatch: ${relative}`);
    verifiedPayloads.push(`${relative}\0${bytes.length}\0${digest}`);
  }

  const archiveBytes = readFileSync(archive);
  const manifestDigest = sha256Upper(manifestBytes);
  const archiveDigest = sha256Upper(archiveBytes);
  const contentWatermark = sha256Upper(Buffer.from([
    `${manifestRelative}\0${manifestBytes.length}\0${manifestDigest}`,
    ...verifiedPayloads.sort(),
    `archive\0${archiveBytes.length}\0${archiveDigest}`
  ].join("\n"), "utf8"));
  const cacheKey = `${path.resolve(root)}\0${packageSpec.directory}\0${packageSpec.archive}\0${packageSpec.manifest}\0${packageSpec.executable.path}\0${releaseName}\0${contentWatermark}`;
  const cached = preservedPackageFactsCache.get(cacheKey);
  if (cached) return cached;

  const zipFacts = runWindowsReleaseVerifier(root, directory, archive, releaseName, label);
  assertCondition(zipFacts.payload_count === declaredFiles.size, `${label} ZIP verifier payload count drifted`);
  assertCondition(zipFacts.manifest_file?.sha256?.toUpperCase() === manifestDigest, `${label} ZIP verifier manifest hash drifted`);
  assertCondition(zipFacts.archive_file?.sha256?.toUpperCase() === archiveDigest, `${label} ZIP verifier archive hash drifted`);

  const prerequisiteMetadataPath = "prerequisites/webview2-runtime.json";
  const canonicalInstallerPath = "prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe";
  let webview2Prerequisite = null;
  if (declaredFiles.has(prerequisiteMetadataPath)) {
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(path.join(directory, prerequisiteMetadataPath), "utf8").replace(/^\uFEFF/u, ""));
    } catch (error) {
      throw new Error(`${label} WebView2 prerequisite metadata is invalid JSON: ${error.message}`);
    }
    assertCondition(metadata?.format === "cloudig/webview2-offline-prerequisite", `${label} WebView2 prerequisite format drifted`);
    assertCondition(metadata?.version === "0.2.0", `${label} WebView2 prerequisite version drifted`);
    assertCondition(metadata?.architecture === "x64", `${label} WebView2 prerequisite architecture drifted`);
    assertCondition(metadata?.auto_execute === false, `${label} WebView2 prerequisite must not auto-execute`);
    assertCondition(metadata?.authenticode_status === "Valid", `${label} WebView2 prerequisite signature status drifted`);
    assertCondition(
      /(?:^|,\s*)CN=Microsoft Corporation(?:,|$)/u.test(String(metadata?.signer_subject)),
      `${label} WebView2 prerequisite signer drifted`
    );
    assertCondition(/^[0-9A-F]{40}$/u.test(String(metadata?.signer_thumbprint)), `${label} WebView2 signer thumbprint is invalid`);
    assertCondition(/^[0-9a-f]{64}$/u.test(String(metadata?.sha256)), `${label} WebView2 prerequisite SHA-256 is invalid`);
    assertCondition(
      metadata?.installer === "MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
      `${label} WebView2 prerequisite installer name drifted`
    );
    assertCondition(
      typeof metadata?.product_name === "string"
        && /WebView2/iu.test(metadata.product_name)
        && /Runtime/iu.test(metadata.product_name),
      `${label} WebView2 prerequisite product name drifted`
    );
    assertCondition(
      typeof metadata?.file_description === "string"
        && /WebView2/iu.test(metadata.file_description)
        && /Runtime/iu.test(metadata.file_description),
      `${label} WebView2 prerequisite file description drifted`
    );
    assertCondition(
      typeof metadata?.original_filename === "string",
      `${label} WebView2 prerequisite original filename is missing`
    );
    assertCondition(
      JSON.stringify(metadata?.install_arguments) === JSON.stringify(["/silent", "/install"]),
      `${label} WebView2 prerequisite install arguments drifted`
    );
    const installerRelative = `prerequisites/${metadata.installer}`;
    const installerEntry = declaredFiles.get(installerRelative);
    assertCondition(installerEntry, `${label} WebView2 prerequisite installer is absent from the manifest`);
    assertCondition(
      installerEntry.sha256.toUpperCase() === metadata.sha256.toUpperCase(),
      `${label} WebView2 prerequisite metadata hash drifted from the release manifest`
    );
    webview2Prerequisite = Object.freeze({ metadata, installer: installerEntry });
  }
  assertCondition(
    !declaredFiles.has(canonicalInstallerPath) || webview2Prerequisite,
    `${label} WebView2 prerequisite installer exists without verified metadata`
  );

  const facts = Object.freeze({
    status: "present",
    manifest,
    payload_count: declaredFiles.size,
    manifest_file: Object.freeze({
      bytes: manifestBytes.length,
      sha256: manifestDigest
    }),
    archive_file: Object.freeze({
      bytes: archiveBytes.length,
      sha256: archiveDigest
    }),
    executable: Object.freeze({
      ...(declaredFiles.get(packageSpec.executable.path) ?? {})
    }),
    webview2_prerequisite: webview2Prerequisite,
    declared_files: declaredFiles,
    content_watermark: contentWatermark
  });
  preservedPackageFactsCache.set(cacheKey, facts);
  return facts;
}

function validateWebView2PrerequisiteTrust(facts, spec, label) {
  if (!facts.webview2_prerequisite) return;
  const digest = facts.webview2_prerequisite.metadata.sha256;
  assertCondition(
    spec.windows_candidate.runtime_lock.webview2_approved_installers.includes(digest),
    `${label} WebView2 prerequisite SHA-256 is absent from the Git-tracked allowlist`
  );
}

function validateCandidateBuildInputs(root, spec, manifest, facts, trackedFiles) {
  const declared = manifest?.build_inputs;
  assertCondition(declared?.format === windowsBuildInputFormat, "candidate release build_inputs format drifted");
  assertCondition(declared?.version === windowsBuildInputVersion, "candidate release build_inputs version drifted");
  assertCondition(Array.isArray(declared?.files), "candidate release build_inputs files must be an array");
  assertCondition(declared.file_count === declared.files.length, "candidate release build_inputs file_count drifted");
  assertCondition(/^[0-9a-f]{64}$/u.test(declared.aggregate_sha256), "candidate release build_inputs aggregate SHA-256 is invalid");

  const current = collectWindowsBuildInputs({ root, trackedFiles });
  assertCondition(
    JSON.stringify(declared) === JSON.stringify(current),
    "candidate release build_inputs drifted from the current Git-tracked Windows release sources"
  );

  const expectedPaths = new Map();
  for (const input of current.files) {
    if (input.target === null) continue;
    const normalized = safeManifestRelative(input.target, `candidate build input target ${input.source}`);
    const key = normalized.toLocaleLowerCase("en-US");
    assertCondition(!expectedPaths.has(key), `candidate build inputs contain a duplicate target: ${normalized}`);
    expectedPaths.set(key, normalized);
    const packaged = [...facts.declared_files.entries()].find(
      ([relative]) => relative.toLocaleLowerCase("en-US") === key
    );
    assertCondition(packaged, `candidate package is missing Git-whitelisted build input: ${normalized}`);
    assertCondition(packaged[0] === normalized, `candidate package target casing drifted: ${normalized}`);
    assertCondition(packaged[1].bytes === input.bytes, `candidate package build input byte count drifted: ${normalized}`);
    assertCondition(packaged[1].sha256 === input.sha256, `candidate package build input SHA-256 drifted: ${normalized}`);
  }
  for (const generated of [
    "Cloudig.exe",
    "Microsoft.Web.WebView2.Core.xml",
    "Microsoft.Web.WebView2.WinForms.xml",
    "Microsoft.Web.WebView2.Wpf.xml",
    "runtime/node/node.exe",
    "runtime/node/LICENSE.node.txt"
  ]) {
    expectedPaths.set(generated.toLocaleLowerCase("en-US"), generated);
  }
  if (facts.webview2_prerequisite) {
    for (const generated of [
      "prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
      "prerequisites/webview2-runtime.json"
    ]) expectedPaths.set(generated.toLocaleLowerCase("en-US"), generated);
  }
  assertCondition(
    facts.declared_files.size === expectedPaths.size,
    "candidate package contains a forbidden, private, or non-permitted path"
  );
  for (const relative of facts.declared_files.keys()) {
    const expected = expectedPaths.get(relative.toLocaleLowerCase("en-US"));
    assertCondition(expected === relative, `candidate package contains a forbidden, private, or non-permitted path: ${relative}`);
  }
  return current;
}

function validateCandidatePackage(root, spec, trackedFiles) {
  const { components, product, windows_candidate: windows } = spec;
  const candidate = windows.candidate_package;
  const shallowManifestPath = resolveProjectPath(root, candidate.manifest);
  if (existsSync(shallowManifestPath)) {
    const shallowManifest = JSON.parse(readFileSync(shallowManifestPath, "utf8").replace(/^\uFEFF/u, ""));
    assertCondition(shallowManifest?.build_inputs, "candidate release manifest lacks build_inputs provenance and must be rebuilt");
  }
  const facts = readLocalPackageFacts(root, candidate, "candidate package", windows.release_name);
  if (facts.status === "absent") {
    assertCondition(!candidate.required_locally, "candidate Windows package is required locally but absent");
    return { status: "absent_optional" };
  }

  const manifest = facts.manifest;
  assertCondition(manifest?.format === "cloudig/windows-release-manifest", "candidate release manifest format drifted");
  assertCondition(manifest?.version === windows.release_manifest_version, "candidate release manifest version drifted");
  assertCondition(manifest?.release === windows.release_name, "candidate release name drifted");
  assertCondition(manifest?.architecture === windows.architecture, "candidate release architecture drifted");
  assertCondition(manifest?.node_version === windows.runtime_lock.node_version, "candidate release Node version drifted");
  assertCondition(
    manifest?.bookmark_set_version === windows.packaged_bookmark_set_version,
    "candidate release bookmark set drifted"
  );
  assertCondition(
    (manifest?.webview2_offline_installer_bundled === true) === Boolean(facts.webview2_prerequisite),
    "candidate release WebView2 prerequisite flag and payload drifted"
  );
  validateWebView2PrerequisiteTrust(facts, spec, "candidate release");
  const buildInputs = validateCandidateBuildInputs(root, spec, manifest, facts, trackedFiles);
  const expectedComponents = {
    cloudig: product.version,
    parser: components.parser,
    reader: components.reader,
    library: components.library,
    parse_state: components.parse_state
  };
  for (const [name, version] of Object.entries(expectedComponents)) {
    assertCondition(manifest?.components?.[name] === version, `candidate release ${name} component drifted`);
  }
  assertCondition(
    JSON.stringify(manifest?.components?.conversation_schemas) === JSON.stringify(Object.values(components.conversation_schemas)),
    "candidate release conversation schema list drifted"
  );
  assertCondition(
    normalizeRelative(facts.executable.path) === normalizeRelative(candidate.executable.path),
    "candidate executable path drifted"
  );
  assertCondition(facts.payload_count === candidate.payload_count, "candidate release payload count drifted");
  for (const [label, expected, actual] of [
    ["manifest", candidate.manifest_file, facts.manifest_file],
    ["archive", candidate.archive_file, facts.archive_file],
    ["executable", candidate.executable, facts.executable]
  ]) {
    assertCondition(actual?.bytes === expected.bytes, `candidate ${label} byte count drifted`);
    assertCondition(actual?.sha256?.toUpperCase() === expected.sha256, `candidate ${label} SHA-256 drifted`);
  }
  return { status: "verified", payloads: facts.payload_count, build_inputs_sha256: buildInputs.aggregate_sha256 };
}

function validatePreviousPreservedPackage(root, spec) {
  const { windows_candidate: windows } = spec;
  const preserved = windows.previous_preserved_package;
  const facts = readLocalPackageFacts(root, preserved, "previous preserved package", preserved.release_name);
  if (facts.status === "absent") {
    assertCondition(
      !preserved.required_locally,
      "previous preserved Windows package is required locally but absent"
    );
    return { status: "absent_optional" };
  }

  const manifest = facts.manifest;
  assertCondition(
    manifest?.format === "cloudig/windows-release-manifest",
    "previous preserved release manifest format drifted"
  );
  assertCondition(
    manifest?.version === windows.release_manifest_version,
    "previous preserved release manifest version drifted"
  );
  assertCondition(manifest?.release === preserved.release_name, "previous preserved release name drifted");
  assertCondition(
    manifest?.architecture === windows.architecture,
    "previous preserved release architecture drifted"
  );
  assertCondition(
    manifest?.bookmark_set_version === preserved.bookmark_set_version,
    "previous preserved release bookmark set drifted"
  );
  validateWebView2PrerequisiteTrust(facts, spec, "previous preserved release");
  assertCondition(facts.payload_count === preserved.payload_count, "preserved release payload count drifted");

  for (const [label, expected, actual] of [
    ["manifest", preserved.manifest_file, facts.manifest_file],
    ["archive", preserved.archive_file, facts.archive_file],
    ["executable", preserved.executable, facts.executable]
  ]) {
    assertCondition(actual?.bytes === expected.bytes, `preserved ${label} byte count drifted`);
    assertCondition(actual?.sha256?.toUpperCase() === expected.sha256, `preserved ${label} SHA-256 drifted`);
  }
  assertCondition(
    normalizeRelative(facts.executable.path) === normalizeRelative(preserved.executable.path),
    "preserved executable path drifted"
  );
  return { status: "verified", payloads: facts.payload_count };
}

function validateBookmarkletSnapshot(root, spec) {
  const expectedRegistries = {
    current_build: "scripts/build-current-bookmarklets.mjs",
    light: "scripts/bookmarklet-targets.mjs",
    claude_light: "scripts/bookmarklet-layout.mjs",
    full_and_all_branches: "scripts/archive-bookmarklet-targets.mjs"
  };
  for (const [name, expected] of Object.entries(expectedRegistries)) {
    assertCondition(spec.bookmarklets.registries?.[name] === expected, `bookmarklet registry ${name} must be ${expected}`);
    assertProjectFile(root, expected, `bookmarklet registry ${name}`);
  }

  validateCurrentBookmarkletBuildTargets({
    readSourceText(target) {
      return readText(root, `bookmarklets/${target.source}`);
    }
  });
  assertCondition(
    bookmarkSetVersion === spec.bookmarklets.accepted_set_version,
    `bookmarklet registry set is ${bookmarkSetVersion}, expected ${spec.bookmarklets.accepted_set_version}`
  );
  assertCondition(currentBookmarkletBuildTargets.length === spec.bookmarklets.profiles.total, "current bookmarklet target total drifted");

  const targets = [...currentBookmarkletBuildTargets].sort((left, right) => {
    const leftKey = `${left.platform}:${left.profile}`;
    const rightKey = `${right.platform}:${right.profile}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const profileCounts = {
    light: targets.filter((target) => target.profile === "light").length,
    full: targets.filter((target) => target.profile === "full").length,
    all_branches: targets.filter((target) => target.profile === "all-branches").length,
    total: targets.length
  };
  for (const [name, actual] of Object.entries(profileCounts)) {
    assertCondition(actual === spec.bookmarklets.profiles[name], `bookmarklet ${name} count is ${actual}, expected ${spec.bookmarklets.profiles[name]}`);
  }

  let totalBytes = 0;
  let minTotalBytes = 0;
  let manifestLines = "";
  for (const target of targets) {
    const sourceRelative = `bookmarklets/${target.source}`;
    const minRelative = `bookmarklets/${target.min}`;
    assertProjectFile(root, sourceRelative, `${target.id} source`);
    assertProjectFile(root, minRelative, `${target.id} artifact`);
    const sourceBytes = readBytes(root, sourceRelative);
    const minBytes = readBytes(root, minRelative);
    const minText = minBytes.toString("utf8");
    assertStrictBookmarkletArtifact(minText, target);
    totalBytes += sourceBytes.length + minBytes.length;
    minTotalBytes += minBytes.length;
    manifestLines += `${JSON.stringify([
      target.id,
      target.version,
      target.source,
      sourceBytes.length,
      sha256Upper(sourceBytes),
      target.min,
      minBytes.length,
      sha256Upper(minBytes)
    ])}\n`;
  }
  const actual = {
    pair_count: targets.length,
    file_count: targets.length * 2,
    total_bytes: totalBytes,
    min_total_bytes: minTotalBytes,
    manifest_sha256: sha256Upper(Buffer.from(manifestLines, "utf8"))
  };
  for (const [name, value] of Object.entries(actual)) {
    assertCondition(
      value === spec.bookmarklets.accepted_artifacts[name],
      `accepted bookmarklet ${name} is ${value}, expected ${spec.bookmarklets.accepted_artifacts[name]}`
    );
  }
  return { accepted_set: spec.bookmarklets.accepted_set_version, profiles: profileCounts, artifacts: actual };
}

function deriveReleaseReadiness(spec) {
  const windows = spec.windows_candidate;
  const blockers = [];
  if (spec.bookmarklets.accepted_set_version !== windows.packaged_bookmark_set_version) {
    blockers.push("accepted-bookmark-set-not-packaged");
  }
  if (windows.readiness_blockers.includes("windows-visual-and-interaction-acceptance-pending")) {
    blockers.push("windows-visual-and-interaction-acceptance-pending");
  }
  return {
    blockers
  };
}

function validateReleaseReadiness(root, spec, candidatePackageFacts) {
  const windows = spec.windows_candidate;
  const derived = deriveReleaseReadiness(spec);
  const expectedIntegration = spec.bookmarklets.accepted_set_version === windows.packaged_bookmark_set_version
    ? "integrated"
    : "pending";
  assertCondition(
    windows.bookmark_integration === expectedIntegration,
    `Windows bookmark integration must be ${expectedIntegration} when accepted=${spec.bookmarklets.accepted_set_version} and packaged=${windows.packaged_bookmark_set_version}`
  );
  const declared = [...windows.readiness_blockers].sort();
  const staticBlockers = [...derived.blockers].sort();
  assertCondition(
    JSON.stringify(declared) === JSON.stringify(staticBlockers),
    `declared release blockers do not match reality; declared=${declared.join(",") || "(none)"}; actual=${staticBlockers.join(",") || "(none)"}`
  );
  const runtimeBlockers = candidatePackageFacts?.status === "verified"
    ? []
    : ["windows-candidate-package-not-built"];
  const actual = [...derived.blockers, ...runtimeBlockers];
  const expectedReadiness = actual.length === 0 ? "ready" : "blocked";
  assertCondition(
    windows.publish_readiness === expectedReadiness,
    `publish_readiness must be ${expectedReadiness}`
  );
  return {
    ...derived,
    blockers: actual,
    static_blockers: derived.blockers,
    runtime_blockers: runtimeBlockers,
    candidate_package_verified: runtimeBlockers.length === 0
  };
}

function validateEntrypoints(root, spec, trackedFiles) {
  const tracked = new Set(trackedFiles.map(normalizeRelative));
  const seen = new Set();
  for (const entry of spec.policy.required_entries) {
    const normalized = normalizeRelative(entry);
    assertCondition(!seen.has(normalized), `duplicate required entry: ${normalized}`);
    seen.add(normalized);
    assertProjectFile(root, normalized, "required entry");
    assertCondition(tracked.has(normalized), `required entry is not Git tracked: ${normalized}`);
  }
  return { files: seen.size, tracked: seen.size };
}

function validateProjectState(root, spec) {
  const projectState = readText(root, "PROJECT_STATE.md");
  const lineCount = projectState.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n").length;
  assertCondition(
    lineCount <= spec.policy.project_state_max_lines,
    `PROJECT_STATE.md has ${lineCount} lines; limit is ${spec.policy.project_state_max_lines}`
  );
  return { lines: lineCount, limit: spec.policy.project_state_max_lines };
}

function validateLicense(root, spec) {
  const license = readText(root, "LICENSE");
  for (const requiredLine of spec.policy.license_required_lines) {
    assertCondition(
      license.split(/\r?\n/gu).includes(requiredLine),
      `LICENSE must preserve exact line ${JSON.stringify(requiredLine)}`
    );
  }
  assertContains(license, "开放正义许可协议 1.1", "LICENSE");
  assertContains(license, "Justice For Open Good License 1.1（JOG-1.1）", "LICENSE");
  return { protected_lines: spec.policy.license_required_lines.length };
}

function collectGitIgnoredPaths(root, trackedFiles) {
  const paths = [...new Set(trackedFiles.map(normalizeRelative).filter(Boolean))];
  if (paths.length === 0) return [];
  const result = spawnSync(
    "git",
    ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"],
    {
      input: `${paths.join("\0")}\0`,
      encoding: "utf8",
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  assertCondition(
    result.status === 0 || result.status === 1,
    result.stderr || `git check-ignore failed with status ${result.status}`
  );
  return result.status === 0
    ? result.stdout.split("\0").filter(Boolean).map(normalizeRelative)
    : [];
}

function validateTrackedPrivacy(root, spec, trackedFiles) {
  const prefixes = spec.policy.forbidden_tracked_prefixes.map(lowerRelative);
  const expressions = spec.policy.forbidden_tracked_patterns.map((value) => new RegExp(value, "u"));
  const explicitViolations = trackedFiles
    .map(normalizeRelative)
    .filter((file) => {
      const lowered = lowerRelative(file);
      return prefixes.some((prefix) =>
        lowered.startsWith(prefix)
          || (prefix.endsWith("/") && lowered === prefix.slice(0, -1))
      )
        || expressions.some((expression) => expression.test(lowered));
    });
  const ignoredTracked = collectGitIgnoredPaths(root, trackedFiles);
  const violations = [...new Set([...explicitViolations, ...ignoredTracked])].sort();
  assertCondition(
    violations.length === 0,
    `private, generated or Git-ignored paths are tracked: ${violations.slice(0, 5).join(", ")}${violations.length > 5 ? " …" : ""}`
  );
  return { tracked_files: trackedFiles.length, ignored_tracked: 0, violations: 0 };
}

function observeGitIgnored(root, relativePath) {
  const normalized = normalizeRelative(relativePath);
  const cacheKey = `${path.resolve(root)}\0${normalized}`;
  if (ignoreObservationCache.has(cacheKey)) return ignoreObservationCache.get(cacheKey);
  const result = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", normalized], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  assertCondition(
    result.status === 0 || result.status === 1,
    result.stderr || `git check-ignore failed for ${normalized} with status ${result.status}`
  );
  const ignored = result.status === 0;
  ignoreObservationCache.set(cacheKey, ignored);
  return ignored;
}

function validateIgnoreBoundary(root, spec) {
  for (const sentinel of spec.policy.ignore_sentinels) {
    const actual = observeGitIgnored(root, sentinel.path);
    assertCondition(
      actual === sentinel.ignored,
      `git ignore result for ${sentinel.path} is ${actual ? "ignored" : "not ignored"}, expected ${sentinel.ignored ? "ignored" : "not ignored"}`
    );
  }
  return {
    sentinels: spec.policy.ignore_sentinels.length,
    ignored: spec.policy.ignore_sentinels.filter((item) => item.ignored).length,
    public: spec.policy.ignore_sentinels.filter((item) => !item.ignored).length
  };
}

function validatePackageScripts(root) {
  const packageJson = readJson(root, "package.json");
  assertCondition(packageJson?.scripts?.doctor === "node scripts/doctor.mjs", "package.json must expose npm run doctor");
  assertCondition(
    packageJson?.scripts?.["doctor:release"] === "node scripts/doctor.mjs --require-release-ready",
    "package.json must expose the opt-in release readiness gate"
  );
  assertCondition(
    packageJson?.scripts?.["test:doctor"] === "node tests/2026-07-31_Cloudig发布快照与Doctor回归-GPT-5.6-Sol.mjs",
    "package.json must expose npm run test:doctor"
  );
  return {
    doctor: packageJson.scripts.doctor,
    release: packageJson.scripts["doctor:release"],
    test: packageJson.scripts["test:doctor"]
  };
}

export function readReleaseSpec(root = defaultProjectRoot) {
  return readJson(path.resolve(root), releaseSpecPath);
}

export function runDoctor({
  root = defaultProjectRoot,
  spec,
  trackedFiles
} = {}) {
  // Per-run observations must be fresh. Preserved package facts use a strong
  // content watermark (manifest, every payload, and archive) instead of a
  // path-only cache key, so unchanged large ZIPs can still reuse verification.
  bookmarkPackageFactsCache.clear();
  ignoreObservationCache.clear();
  const resolvedRoot = path.resolve(root);
  const checks = [];
  let selectedSpec = spec;
  let releaseFacts = null;
  let candidatePackageFacts = null;

  addCheck(checks, "release-spec.read", () => {
    selectedSpec ??= readReleaseSpec(resolvedRoot);
    return { path: releaseSpecPath };
  });
  if (!selectedSpec) return createReport(checks, null, null);

  let selectedTrackedFiles;
  try {
    selectedTrackedFiles = trackedFiles ?? collectTrackedFiles(resolvedRoot);
  } catch (error) {
    selectedTrackedFiles = [];
    checks.push({
      id: "git.tracked-files",
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  addCheck(checks, "release-spec.shape", () => validateSpecShape(selectedSpec));
  addCheck(checks, "components.versions", () => validateComponentVersions(resolvedRoot, selectedSpec));
  addCheck(checks, "components.schemas", () => validateConversationSchemas(resolvedRoot, selectedSpec));
  addCheck(checks, "bookmarklets.accepted-artifacts", () => validateBookmarkletSnapshot(resolvedRoot, selectedSpec));
  addCheck(checks, "windows.snapshot", () => validateManagerSnapshot(resolvedRoot, selectedSpec));
  addCheck(checks, "windows.runtime-lock", () => validateRuntimeLock(resolvedRoot, selectedSpec));
  addCheck(checks, "windows.bookmark-package", () => runBookmarkPackageVerifier(resolvedRoot, selectedSpec));
  addCheck(checks, "windows.candidate-package", () => {
    candidatePackageFacts = validateCandidatePackage(resolvedRoot, selectedSpec, selectedTrackedFiles);
    return candidatePackageFacts;
  });
  addCheck(checks, "windows.previous-preserved-package", () => {
    return validatePreviousPreservedPackage(resolvedRoot, selectedSpec);
  });
  addCheck(checks, "release.readiness", () => {
    releaseFacts = validateReleaseReadiness(resolvedRoot, selectedSpec, candidatePackageFacts);
    return releaseFacts;
  });
  addCheck(checks, "entrypoints.tracked", () => validateEntrypoints(resolvedRoot, selectedSpec, selectedTrackedFiles));
  addCheck(checks, "project-state.limit", () => validateProjectState(resolvedRoot, selectedSpec));
  addCheck(checks, "license.protected-lines", () => validateLicense(resolvedRoot, selectedSpec));
  addCheck(checks, "git.private-boundary", () =>
    validateTrackedPrivacy(resolvedRoot, selectedSpec, selectedTrackedFiles)
  );
  addCheck(checks, "git.ignore-semantics", () => validateIgnoreBoundary(resolvedRoot, selectedSpec));
  addCheck(checks, "package.scripts", () => validatePackageScripts(resolvedRoot));

  return createReport(checks, selectedSpec, releaseFacts);
}

function createReport(checks, spec, releaseFacts) {
  const failed = checks.filter((check) => !check.ok);
  const snapshotValid = failed.length === 0;
  const derivedBlockers = releaseFacts?.blockers ?? spec?.windows_candidate?.readiness_blockers ?? [];
  const releaseReady = snapshotValid
    && spec?.windows_candidate?.publish_readiness === "ready"
    && derivedBlockers.length === 0;
  return {
    format: "cloudig/doctor-report",
    version: "0.2.0",
    snapshot_valid: snapshotValid,
    ok: snapshotValid,
    release_ready: releaseReady,
    snapshot_id: spec?.snapshot_id ?? null,
    checks: {
      passed: checks.length - failed.length,
      total: checks.length
    },
    snapshot: spec ? {
      product: spec?.product?.display_version ?? null,
      accepted_bookmark_set: spec?.bookmarklets?.accepted_set_version ?? null,
      windows_packaged_bookmark_set: spec?.windows_candidate?.packaged_bookmark_set_version ?? null,
      windows_bookmark_integration: spec?.windows_candidate?.bookmark_integration ?? null
    } : null,
    release: spec ? {
      declared: spec?.windows_candidate?.publish_readiness ?? null,
      blockers: [...derivedBlockers],
      static_blockers: [...(releaseFacts?.static_blockers ?? spec?.windows_candidate?.readiness_blockers ?? [])],
      runtime_blockers: [...(releaseFacts?.runtime_blockers ?? [])],
      candidate_package_verified: releaseFacts?.candidate_package_verified ?? false
    } : null,
    errors: failed.map(({ id, error }) => ({ id, message: error }))
  };
}

export function formatDoctorReport(report) {
  const lines = [
    `Cloudig doctor: SNAPSHOT ${report.snapshot_valid ? "VALID" : "INVALID"} / RELEASE ${report.release_ready ? "READY" : "NOT READY"}`,
    `snapshot: ${report.snapshot_id ?? "(unavailable)"}`,
    `checks: ${report.checks.passed}/${report.checks.total}`
  ];
  if (report.snapshot) {
    lines.push(
      `bookmarks: accepted ${report.snapshot.accepted_bookmark_set}; Windows ${report.snapshot.windows_packaged_bookmark_set} (${report.snapshot.windows_bookmark_integration})`
    );
  }
  for (const blocker of report.release?.blockers ?? []) lines.push(`- [release blocker] ${blocker}`);
  for (const error of report.errors) lines.push(`- [${error.id}] ${error.message}`);
  return `${lines.join("\n")}\n`;
}

function parseCliArgs(args) {
  const allowed = new Set(["--json", "--require-release-ready"]);
  const seen = new Set();
  for (const argument of args) {
    if (!allowed.has(argument) || seen.has(argument)) {
      throw new Error("Usage: node scripts/doctor.mjs [--json] [--require-release-ready]");
    }
    seen.add(argument);
  }
  return {
    json: seen.has("--json"),
    requireReleaseReady: seen.has("--require-release-ready")
  };
}

function runCli() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const report = runDoctor();
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatDoctorReport(report));
  if (!report.snapshot_valid || (options.requireReleaseReady && !report.release_ready)) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
