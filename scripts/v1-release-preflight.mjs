#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";

import { currentBookmarkletBuildTargets } from "./build-current-bookmarklets.mjs";
import { bookmarkSetVersion } from "./bookmarklet-targets.mjs";
import { pendingBookmarkletTestTargets } from "./refresh-bookmarklet-test-set.mjs";

export const V1_RELEASE_PREFLIGHT_REPORT = "cloudig/v1-release-preflight-report/1.0.0";

/** Explicit browser links are not dependencies fetched to render the shell. */
export function assertOfflineShell(html) {
  const anchorHrefs = [], pending = [parse(html, { sourceCodeLocationInfo: true })];
  while (pending.length) {
    const node = pending.pop();
    pending.push(...node.childNodes ?? []);
    if (node.content) pending.push(node.content);
    if (node.tagName !== "a") continue;
    const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
    if (!/^https?:\/\//iu.test(attrs.href ?? "")) continue;
    const url = new URL(attrs.href), rel = new Set((attrs.rel ?? "").toLowerCase().split(/\s+/u));
    if (url.protocol !== "https:" || attrs.target !== "_blank" || !rel.has("noopener") || !rel.has("noreferrer")) throw new Error("External shell links must be explicit secure browser links");
    const position = node.sourceCodeLocation?.attrs?.href;
    if (!position) throw new Error("External shell link has no source location");
    anchorHrefs.push(position);
  }
  let dependencies = html;
  for (const { startOffset, endOffset } of anchorHrefs.sort((a, b) => b.startOffset - a.startOffset)) dependencies = dependencies.slice(0, startOffset) + dependencies.slice(endOffset);
  if (/manager[\\/]/iu.test(dependencies)) throw new Error("Packaged shell must not depend on the legacy manager directory");
  const localOrigins = new Set(["https://cloudig-runtime.local", "https://cloudig-work.invalid", "https://cloudig-map.local"]);
  for (const [raw] of dependencies.matchAll(/https?:\/\/[^\s"'<>;]+/giu)) {
    const url = new URL(raw);
    if (!localOrigins.has(url.origin) || url.username || url.password) throw new Error(`Packaged shell has a remote dependency: ${raw}`);
  }
}

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSpec = "release/v1-preflight-spec.json";

function normalize(relative) {
  return String(relative).replaceAll("\\", "/").replace(/^\.\/+|\/+$/gu, "");
}

function resolveInside(root, relative) {
  const clean = normalize(relative);
  if (!clean || path.isAbsolute(clean) || clean === ".." || clean.startsWith("../")) {
    throw new Error(`path must stay inside the project: ${relative}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, ...clean.split("/"));
  if (target === base || !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`path escaped the project: ${relative}`);
  }
  return target;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(file) {
  const bytes = readFileSync(file);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function collectFiles(root, relative, exclude) {
  const absolute = resolveInside(root, relative);
  if (exclude(normalize(relative))) return [];
  if (!existsSync(absolute)) throw new Error(`missing input: ${normalize(relative)}`);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) throw new Error(`symbolic links are not release inputs: ${normalize(relative)}`);
  if (info.isFile()) return [normalize(relative)];
  if (!info.isDirectory()) throw new Error(`release input is neither file nor directory: ${normalize(relative)}`);
  const result = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const child = path.join(directory, entry.name);
      const childRelative = normalize(`${prefix}/${entry.name}`);
      if (exclude(childRelative)) continue;
      const childInfo = lstatSync(child);
      if (childInfo.isSymbolicLink()) throw new Error(`symbolic links are not release inputs: ${childRelative}`);
      if (childInfo.isDirectory()) visit(child, childRelative);
      else if (childInfo.isFile()) result.push(childRelative);
      else throw new Error(`unsupported release input: ${childRelative}`);
    }
  };
  visit(absolute, normalize(relative));
  return result;
}

export function hashInputs(root, inputs, { excludeNativeBuildOutputs = false } = {}) {
  // Source evidence excludes only native compiler output roots. Package and
  // ordinary input hashes keep their default complete byte coverage.
  const exclude = relative => excludeNativeBuildOutputs && /^(?:src\/desktop\/[^/]+|manager\/windows\/Cloudig\.Bookmarks)\/(?:bin|obj)(?:\/|$)/u.test(relative);
  const paths = [...new Set(inputs.flatMap((entry) => collectFiles(root, entry, exclude)))].sort((a, b) => a.localeCompare(b, "en"));
  const files = paths.map((relative) => ({ path: relative, ...hashFile(resolveInside(root, relative)) }));
  const aggregate = createHash("sha256");
  for (const file of files) aggregate.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  return {
    files,
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    aggregate_sha256: aggregate.digest("hex")
  };
}

export function currentBookmarkBuild(provenance) {
  return provenance?.bookmarks?.mode === "current";
}

function gitFacts(root) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
    return result.stdout.trim();
  };
  const status = run(["status", "--porcelain", "--untracked-files=all"]);
  return { commit: run(["rev-parse", "HEAD"]), clean: status === "", dirty: status ? status.split(/\r?\n/u) : [] };
}

function gitPathsChanged(root, fromCommit, toCommit, paths) {
  const result = spawnSync("git", ["diff", "--quiet", `${fromCommit}..${toCommit}`, "--", ...paths], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(result.stderr || "git impact diff failed");
}

function packageFacts(root, spec, errors, blockers) {
  const packageRootRelative = normalize(spec.package_root);
  const packageRoot = resolveInside(root, packageRootRelative);
  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
    blockers.push("fixed-package-missing");
    return null;
  }
  for (const relative of spec.required_package_files) {
    const packaged = path.join(packageRoot, ...normalize(relative).split("/"));
    if (!existsSync(packaged) || !statSync(packaged).isFile() || statSync(packaged).size === 0) {
      errors.push({ id: "package-required-file", message: `missing packaged file: ${relative}` });
    }
  }
  const tree = hashInputs(root, [packageRootRelative]);
  const executable = tree.files.find((file) => file.path === `${packageRootRelative}/Cloudig.exe`);
  if (!executable) errors.push({ id: "package-executable", message: "Cloudig.exe is absent from the fixed package" });
  let runtime = null;
  try {
    runtime = readJson(path.join(packageRoot, "app/runtime-lock.json"));
    if (runtime.schema !== "cloudig/runtime-lock/1.0.0" || runtime.cloudig !== spec.product.version) {
      errors.push({ id: "runtime-lock", message: "runtime-lock.json does not describe the V1 development package" });
    }
  } catch (error) {
    errors.push({ id: "runtime-lock", message: error.message });
  }
  return { root: packageRootRelative, executable, tree, runtime };
}

export function visualCoverageComplete(scenarios, expected) {
  if (!Array.isArray(scenarios) || scenarios.length < expected.scenarios) return false;
  const surfaces = new Set(scenarios.map(row => row.surface));
  if (surfaces.size < expected.surfaces || (expected.required_surfaces ?? []).some(name => !surfaces.has(name))) return false;
  const keys = new Set(scenarios.map(row => `${row.surface}|${row.theme}|${row.language}|${row.viewport?.width}x${row.viewport?.height}`));
  for (const surface of expected.required_surfaces ?? surfaces) {
    for (const theme of expected.themes) for (const language of expected.languages) for (const viewport of expected.viewports) {
      if (!keys.has(`${surface}|${theme}|${language}|${viewport}`)) return false;
    }
  }
  return true;
}

function visualFacts(root, spec, executableSha256, errors, blockers) {
  const relative = normalize(spec.visual_evidence.manifest);
  const manifestFile = resolveInside(root, relative);
  if (!existsSync(manifestFile)) {
    blockers.push("fixed-exe-visual-matrix-missing");
    return null;
  }
  try {
    const matrix = readJson(manifestFile);
    if (matrix.schema !== "cloudig/visual-audit-matrix/1.0.0") throw new Error("unexpected matrix schema");
    if (!Array.isArray(matrix.scenarios)) throw new Error("visual matrix scenarios are missing");
    if (matrix.executable?.sha256 !== executableSha256) throw new Error("visual matrix executable does not match the fixed package");
    const engineSha256 = hashFile(resolveInside(root, `${spec.package_root}/app/engine/engine.mjs`)).sha256;
    if (matrix.engine?.sha256 !== engineSha256) throw new Error("visual matrix Engine does not match the fixed package");
    const program = hashInputs(root, [`${spec.package_root}/app`]);
    if (matrix.program?.aggregate_sha256 !== program.aggregate_sha256) throw new Error("visual matrix program files do not match the managed host, UI and runtime package");
    const directory = path.dirname(manifestFile);
    const surfaces = new Set();
    const themes = new Set();
    const languages = new Set();
    const viewports = new Set();
    for (const scenario of matrix.scenarios) {
      surfaces.add(scenario.surface);
      themes.add(scenario.theme);
      languages.add(scenario.language);
      viewports.add(`${scenario.viewport?.width}x${scenario.viewport?.height}`);
      const pngFile = path.join(directory, scenario.png);
      const runFile = path.join(directory, scenario.manifest);
      if (!existsSync(pngFile) || !existsSync(runFile)) throw new Error(`scenario files missing: ${scenario.manifest}`);
      const png = hashFile(pngFile);
      if (png.bytes !== scenario.png_bytes || png.sha256 !== scenario.png_sha256) throw new Error(`scenario PNG drifted: ${scenario.png}`);
      const run = readJson(runFile);
      if (run.schema !== "cloudig/visual-audit-run/1.0.0") throw new Error(`scenario manifest schema drifted: ${scenario.manifest}`);
      if (run.executable?.sha256 !== executableSha256) throw new Error(`scenario executable drifted: ${scenario.manifest}`);
      if (run.png?.sha256 !== png.sha256 || run.png?.bytes !== png.bytes) throw new Error(`scenario manifest PNG drifted: ${scenario.manifest}`);
      if (run.page?.ready !== true || run.page?.fonts !== "loaded" || run.page?.images !== true || run.page?.transition !== false) {
        throw new Error(`scenario was not captured in a ready state: ${scenario.manifest}`);
      }
      if (run.page.body_scroll_width !== run.page.body_client_width || run.page.body_scroll_height !== run.page.body_client_height) {
        throw new Error(`scenario has page-level overflow: ${scenario.manifest}`);
      }
      const titlebarFile = path.join(directory, run.titlebar?.file ?? "");
      if (!run.titlebar?.file || !existsSync(titlebarFile)) throw new Error(`scenario titlebar missing: ${scenario.manifest}`);
      const titlebar = hashFile(titlebarFile);
      if (titlebar.bytes !== run.titlebar.bytes || titlebar.sha256 !== run.titlebar.sha256) throw new Error(`scenario titlebar drifted: ${scenario.manifest}`);
    }
    const coverageComplete = visualCoverageComplete(matrix.scenarios, spec.visual_evidence);
    if (!coverageComplete) blockers.push("fixed-exe-visual-coverage-pending");
    return {
      manifest: relative,
      manifest_sha256: hashFile(manifestFile).sha256,
      executable_sha256: matrix.executable.sha256,
      engine_sha256: engineSha256,
      coverage_complete: coverageComplete,
      scenarios: matrix.scenarios.length,
      surfaces: surfaces.size,
      themes: [...themes].sort(),
      languages: [...languages].sort(),
      viewports: [...viewports].sort()
    };
  } catch (error) {
    errors.push({ id: "visual-evidence", message: error.message });
    return null;
  }
}

function currentBookmarkFacts(root, packageRoot, errors, blockers) {
  const manifestFile = path.join(packageRoot, "bookmarks", "bookmark-package.json");
  if (!existsSync(manifestFile)) return null;
  const manifest = readJson(manifestFile);
  if (manifest.bookmark_set_version !== bookmarkSetVersion) {
    blockers.push("packaged-bookmark-set-not-current");
  }
  const current = new Map(currentBookmarkletBuildTargets.map((target) => [target.id.replace(":all-branches", ":all_branches"), target]));
  let verified = 0, currentVerified = 0;
  const seen = new Set();
  for (const platform of manifest.platforms ?? []) {
    for (const variant of platform.variants ?? []) {
      if (seen.has(variant.id)) { errors.push({ id: "bookmark-variant", message: `duplicate packaged variant: ${variant.id}` }); continue; }
      seen.add(variant.id);
      const target = current.get(variant.id);
      if (!target) {
        errors.push({ id: "bookmark-variant", message: `packaged bookmark is not current: ${variant.id}` });
        continue;
      }
      const packaged = readFileSync(path.join(packageRoot, "bookmarks", "artifacts", ...normalize(variant.artifact).split("/")));
      const source = readFileSync(resolveInside(root, `bookmarklets/${normalize(target.min)}`));
      if (packaged.byteLength !== variant.bytes || sha256(packaged) !== variant.sha256) errors.push({ id: "bookmark-bytes", message: `packaged bookmark differs from its own manifest: ${variant.id}` });
      else verified += 1;
      if (packaged.equals(source)) currentVerified += 1;
    }
  }
  const pending = pendingBookmarkletTestTargets.map((target) => ({ id: target.id, version: target.version }));
  if (pending.length > 0) blockers.push("bookmarklet-user-acceptance-pending");
  if (verified !== 32 || manifest.variant_count !== 32) errors.push({ id: "bookmark-count", message: `expected 32 packaged variants, verified ${verified}` });
  if (currentVerified !== 32) blockers.push("packaged-bookmark-bytes-not-current");
  return { set: manifest.bookmark_set_version, current_set: bookmarkSetVersion, variants: verified, current_variants: currentVerified, pending };
}

function optionalJson(root, relative, expectedSchema, blocker, blockers, errors) {
  const clean = normalize(relative);
  const file = resolveInside(root, clean);
  if (!existsSync(file)) {
    blockers.push(blocker);
    return null;
  }
  try {
    const value = readJson(file);
    if (expectedSchema && value.schema !== expectedSchema) throw new Error(`expected ${expectedSchema}, found ${value.schema ?? "none"}`);
    return { path: clean, sha256: hashFile(file).sha256, value };
  } catch (error) {
    errors.push({ id: blocker, message: `${clean}: ${error.message}` });
    return null;
  }
}

export function runV1ReleasePreflight({ root = defaultRoot, specPath = defaultSpec, git = null } = {}) {
  const errors = [];
  const blockers = [];
  const specFile = resolveInside(root, specPath);
  const spec = readJson(specFile);
  if (spec.schema !== "cloudig/v1-release-preflight-spec/1.0.0") throw new Error(`unsupported V1 preflight spec: ${spec.schema}`);
  const source = git ?? gitFacts(root);
  if (spec.product.candidate !== true) blockers.push("product-not-release-candidate");
  if (!source.clean) blockers.push("working-tree-not-clean");
  const contracts = hashInputs(root, spec.contract_inputs);
  const licenseText = readFileSync(resolveInside(root, "LICENSE"), "utf8");
  for (const line of spec.license_required_lines) {
    if (!licenseText.includes(line)) errors.push({ id: "project-license", message: `LICENSE is missing required line: ${line}` });
  }
  const packageResult = packageFacts(root, spec, errors, blockers);
  const bookmarks = packageResult ? currentBookmarkFacts(root, resolveInside(root, spec.package_root), errors, blockers) : null;
  const visual = packageResult?.executable
    ? visualFacts(root, spec, packageResult.executable.sha256, errors, blockers)
    : null;
  const realLibrary = optionalJson(root, spec.release_evidence.real_library_journey, "cloudig/real-library-journey-evidence/1.0.0", "real-library-journey-evidence-missing", blockers, errors);
  const visualFidelity = optionalJson(root, spec.release_evidence.visual_fidelity, "cloudig/visual-fidelity-review/1.0.0", "visual-fidelity-review-missing", blockers, errors);
  const wpf = optionalJson(root, spec.release_evidence.wpf_interaction_journey, "cloudig/wpf-interaction-journey-evidence/1.0.0", "real-wpf-interaction-journey-pending", blockers, errors);
  const benchmark = optionalJson(root, spec.release_evidence.benchmark, "cloudig/release-benchmark/1.0.0", "release-benchmark-pending", blockers, errors);
  const provenance = optionalJson(root, spec.candidate_files.build_provenance, "cloudig/build-provenance/1.0.0", "build-provenance-missing", blockers, errors);
  const thirdParty = optionalJson(root, spec.candidate_files.third_party_inventory, "cloudig/third-party-inventory/1.0.0", "third-party-license-inventory-pending", blockers, errors);
  const thirdPartyNotices = resolveInside(root, spec.candidate_files.third_party_notices);
  if (!existsSync(thirdPartyNotices)) blockers.push("third-party-license-text-pending");
  const candidate = optionalJson(root, spec.candidate_files.candidate_manifest, "cloudig/release-candidate-manifest/1.0.0", "release-candidate-not-frozen", blockers, errors);
  const rollback = optionalJson(root, spec.candidate_files.rollback_manifest, "cloudig/release-rollback-manifest/1.0.0", "rollback-package-not-frozen", blockers, errors);
  const backendEvidencePaths = [
    "src/core",
    "src/adapters",
    "src/app",
    "src/engine",
    "tests/v1/journey/real-library.test.mts",
    "package.json",
    "package-lock.json",
    "tsconfig.v1.json"
  ];
  const packageImpactPaths = [
    "src",
    "manager/windows/Cloudig.Bookmarks",
    "package.json",
    "package-lock.json",
    "LICENSE",
    "NOTICE.md",
    "scripts/build-current-bookmarklets.mjs",
    "scripts/bookmarklet-targets.mjs",
    "scripts/bookmarklet-layout.mjs",
    "scripts/archive-bookmarklet-targets.mjs",
    "scripts/build-v1-bookmark-package.mjs",
    "scripts/build-v1-desktop.mjs",
    "scripts/v1-third-party-inventory.mjs",
    "tsconfig.v1.json",
    "BOOKMARKLET_CHANGELOG.md",
    ...currentBookmarkletBuildTargets.map((target) => `bookmarklets/${target.min}`)
  ];
  let realLibraryReuse = null;
  let provenanceReuse = null;
  if (realLibrary) {
    if (realLibrary.value.result?.execution !== "packaged-record-engine" || !realLibrary.value.package?.program?.aggregate_sha256) {
      blockers.push("real-library-packaged-engine-evidence-pending");
    } else if (packageResult) {
      const actualProgram = hashInputs(root, [`${spec.package_root}/app`]);
      if (realLibrary.value.package.program.aggregate_sha256 !== actualProgram.aggregate_sha256
        || realLibrary.value.package.executable?.sha256 !== packageResult.executable?.sha256) blockers.push("real-library-program-bytes-mismatch");
    }
    if (realLibrary.value.status !== "passed"
      || realLibrary.value.outcome?.tests !== 1
      || realLibrary.value.outcome?.passed !== 1
      || realLibrary.value.outcome?.failed !== 0
      || realLibrary.value.outcome?.skipped !== 0) {
      errors.push({ id: "real-library-evidence", message: "real Library evidence is not a true non-skipped pass" });
    }
    if (realLibrary.value.source_commit !== source.commit) {
      if (gitPathsChanged(root, realLibrary.value.source_commit, source.commit, backendEvidencePaths)) {
        blockers.push("real-library-evidence-source-mismatch");
      } else {
        realLibraryReuse = {
          evidence_commit: realLibrary.value.source_commit,
          current_commit: source.commit,
          unchanged_paths: backendEvidencePaths
        };
      }
    }
  }
  if (visualFidelity) {
    if (visualFidelity.value.status !== "accepted") blockers.push(`visual-fidelity-${visualFidelity.value.status ?? "unknown"}`);
    if (packageResult?.executable && visualFidelity.value.executable_sha256 !== packageResult.executable.sha256) blockers.push("visual-fidelity-executable-mismatch");
  }
  if (provenance && provenance.value.source?.commit !== source.commit) {
    if (gitPathsChanged(root, provenance.value.source?.commit, source.commit, packageImpactPaths)) {
      blockers.push("fixed-package-source-commit-mismatch");
    } else {
      provenanceReuse = {
        package_commit: provenance.value.source?.commit,
        current_commit: source.commit,
        unchanged_paths: packageImpactPaths
      };
    }
  }
  if (provenance && provenance.value.source?.working_tree_clean !== true) blockers.push("fixed-package-built-from-dirty-tree");
  if (provenance && !currentBookmarkBuild(provenance.value)) blockers.push("fixed-package-reuses-old-bookmarks");
  if (realLibrary && provenance && realLibrary.value.source_commit !== provenance.value.source?.commit
    && gitPathsChanged(root, realLibrary.value.source_commit, provenance.value.source?.commit, backendEvidencePaths)) {
    blockers.push("real-library-evidence-package-mismatch");
  }
  if (wpf && packageResult?.executable && wpf.value.executable_sha256 !== packageResult.executable.sha256) blockers.push("wpf-evidence-executable-mismatch");
  if (benchmark) {
    if (benchmark.value.status !== "passed") errors.push({ id: "release-benchmark", message: "release benchmark is not marked passed" });
    if (packageResult?.executable && benchmark.value.executable_sha256 !== packageResult.executable.sha256) blockers.push("benchmark-executable-mismatch");
    if (packageResult && benchmark.value.package_aggregate_sha256 !== packageResult.tree.aggregate_sha256) blockers.push("benchmark-package-mismatch");
  }
  const uniqueBlockers = [...new Set(blockers)];
  return {
    schema: V1_RELEASE_PREFLIGHT_REPORT,
    product: spec.product,
    source,
    preflight_valid: errors.length === 0,
    release_ready: errors.length === 0 && uniqueBlockers.length === 0,
    errors,
    blockers: uniqueBlockers,
    package: packageResult,
    contracts,
    bookmarks,
    evidence: {
      real_library: realLibrary && { path: realLibrary.path, sha256: realLibrary.sha256, impact_reuse: realLibraryReuse },
      visual,
      visual_fidelity: visualFidelity && { path: visualFidelity.path, sha256: visualFidelity.sha256, status: visualFidelity.value.status },
      wpf_interaction: wpf && { path: wpf.path, sha256: wpf.sha256 },
      benchmark: benchmark && { path: benchmark.path, sha256: benchmark.sha256 }
    },
    candidate: {
      provenance: provenance && { path: provenance.path, sha256: provenance.sha256, impact_reuse: provenanceReuse },
      third_party_inventory: thirdParty && { path: thirdParty.path, sha256: thirdParty.sha256 },
      third_party_notices: existsSync(thirdPartyNotices) ? { path: normalize(spec.candidate_files.third_party_notices), ...hashFile(thirdPartyNotices) } : null,
      manifest: candidate && { path: candidate.path, sha256: candidate.sha256 },
      rollback: rollback && { path: rollback.path, sha256: rollback.sha256 }
    }
  };
}

export function formatV1ReleasePreflight(report) {
  const lines = [
    `Cloudig V1 preflight: ${report.preflight_valid ? "VALID" : "INVALID"} / RELEASE ${report.release_ready ? "READY" : "BLOCKED"}`,
    `source: ${report.source.commit}${report.source.clean ? " (clean)" : " (dirty)"}`,
    `package: ${report.package ? `${report.package.tree.file_count} files / ${report.package.tree.total_bytes} bytes` : "missing"}`,
    `visual: ${report.evidence.visual ? `${report.evidence.visual.scenarios} scenarios / ${report.evidence.visual.executable_sha256}` : "missing"}`
  ];
  for (const blocker of report.blockers) lines.push(`- [blocker] ${blocker}`);
  for (const error of report.errors) lines.push(`- [${error.id}] ${error.message}`);
  return `${lines.join("\n")}\n`;
}

function parseArgs(args) {
  const allowed = new Set(["--json", "--require-ready"]);
  const seen = new Set();
  for (const argument of args) {
    if (!allowed.has(argument) || seen.has(argument)) throw new Error("Usage: node scripts/v1-release-preflight.mjs [--json] [--require-ready]");
    seen.add(argument);
  }
  return { json: seen.has("--json"), requireReady: seen.has("--require-ready") };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runV1ReleasePreflight();
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatV1ReleasePreflight(report));
    if (!report.preflight_valid || (options.requireReady && !report.release_ready)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
