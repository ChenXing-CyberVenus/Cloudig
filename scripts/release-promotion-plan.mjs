#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { currentBookmarkletBuildTargets } from "./build-current-bookmarklets.mjs";
import { bookmarkSetVersion } from "./bookmarklet-targets.mjs";
import { pendingBookmarkletTestTargets } from "./refresh-bookmarklet-test-set.mjs";

export const RELEASE_PROMOTION_PLAN_FORMAT = "cloudig/release-promotion-plan";
export const RELEASE_PROMOTION_PLAN_VERSION = "0.1.0";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8").replace(/^\uFEFF/u, ""));
}

function oneCapture(root, relative, expression, label) {
  const source = readFileSync(path.join(root, relative), "utf8");
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1 || !matches[0][1]) throw new Error(`${label} must have one source value`);
  return matches[0][1];
}

function assertVersion(value, label) {
  if (!SEMVER.test(String(value))) throw new Error(`${label} is not semantic: ${value}`);
  return String(value);
}

export function readSourcePromotionFacts(root) {
  const parserHistory = readJson(root, "parser/version-history.json");
  const managerPackage = readJson(root, "manager/bookmarks/bookmark-package.json");
  const source = {
    components: {
      parser: assertVersion(parserHistory.current, "Parser"),
      reader: assertVersion(oneCapture(root, "reader/src/core.js", /const READER_VERSION = "([^"]+)";/gu, "Reader"), "Reader"),
      library: assertVersion(oneCapture(root, "library/v1.mjs", /export const VERSION = "([^"]+)";/gu, "Library"), "Library"),
      parse_state: assertVersion(oneCapture(root, "parser/src/parse-state-v1.mjs", /export const PARSE_STATE_V1_VERSION = "([^"]+)";/gu, "parse-state"), "parse-state"),
      conversation_schemas: {
        flat: oneCapture(root, "library/v1.mjs", /export const CONVERSATION_SCHEMA = "([^"]+)";/gu, "unified conversation schema"),
        branches: oneCapture(root, "library/v1.mjs", /export const CONVERSATION_SCHEMA = "([^"]+)";/gu, "unified conversation schema")
      }
    },
    bookmarklets: {
      current_set_version: bookmarkSetVersion,
      profiles: {
        light: currentBookmarkletBuildTargets.filter((target) => target.profile === "light").length,
        full: currentBookmarkletBuildTargets.filter((target) => target.profile === "full").length,
        all_branches: currentBookmarkletBuildTargets.filter((target) => target.profile === "all-branches").length,
        total: currentBookmarkletBuildTargets.length
      },
      pending_acceptance: pendingBookmarkletTestTargets.map((target) => ({
        id: target.id,
        version: target.version
      }))
    },
    manager_bookmark_package: {
      version: managerPackage.version,
      bookmark_set_version: managerPackage.bookmark_set_version,
      platform_count: managerPackage.platform_count,
      variant_count: managerPackage.variant_count
    }
  };
  if (source.bookmarklets.profiles.total !== 32) throw new Error("current bookmarklet source set must contain 32 variants");
  return source;
}

function sameComponents(left, right) {
  return left?.parser === right?.parser
    && left?.reader === right?.reader
    && left?.library === right?.library
    && left?.parse_state === right?.parse_state
    && left?.conversation_schemas?.flat === right?.conversation_schemas?.flat
    && left?.conversation_schemas?.branches === right?.conversation_schemas?.branches;
}

export function createReleasePromotionPlan({
  releaseSpec,
  source,
  workingTreeClean,
  doctorVerified = false
}) {
  const pending = source.bookmarklets.pending_acceptance;
  const componentDrift = !sameComponents(releaseSpec.components, source.components);
  const frozenBookmarkDrift = releaseSpec.bookmarklets.accepted_set_version !== source.bookmarklets.current_set_version;
  const packageBookmarkDrift = source.manager_bookmark_package.bookmark_set_version !== source.bookmarklets.current_set_version;
  const visualPending = releaseSpec.windows_candidate.readiness_blockers.includes("windows-visual-and-interaction-acceptance-pending");
  const decisions = [];
  if (componentDrift || frozenBookmarkDrift) decisions.push("target_product_version");
  const blockers = [];
  if (pending.length > 0) blockers.push("bookmarklet-user-acceptance-pending");
  if (!workingTreeClean) blockers.push("working-tree-not-clean");
  if (componentDrift || frozenBookmarkDrift) blockers.push("frozen-release-spec-behind-source");
  if (packageBookmarkDrift) blockers.push("manager-bookmark-package-behind-source");
  if (visualPending) blockers.push("windows-visual-and-interaction-acceptance-pending");
  if (!doctorVerified) blockers.push("final-doctor-not-run");

  let nextAction = "release-complete";
  if (pending.length > 0) nextAction = "accept-pending-bookmarklet-profiles";
  else if (decisions.length > 0) nextAction = "choose-target-product-version";
  else if (!workingTreeClean) nextAction = "commit-exact-promotion-inputs";
  else if (componentDrift || frozenBookmarkDrift) nextAction = "freeze-release-spec";
  else if (packageBookmarkDrift) nextAction = "refresh-manager-bookmark-package";
  else if (visualPending) nextAction = "build-and-accept-windows-candidate";
  else if (!doctorVerified) nextAction = "run-final-doctor";

  return {
    format: RELEASE_PROMOTION_PLAN_FORMAT,
    version: RELEASE_PROMOTION_PLAN_VERSION,
    read_only: true,
    promotable: blockers.length === 0,
    next_action: nextAction,
    decisions_required: decisions,
    blockers,
    frozen_release: {
      snapshot_id: releaseSpec.snapshot_id,
      product: releaseSpec.product,
      components: releaseSpec.components,
      accepted_bookmark_set_version: releaseSpec.bookmarklets.accepted_set_version,
      packaged_bookmark_set_version: releaseSpec.windows_candidate.packaged_bookmark_set_version,
      readiness: releaseSpec.windows_candidate.publish_readiness
    },
    source_candidate: source,
    gates: {
      bookmarklet_user_acceptance_complete: pending.length === 0,
      working_tree_clean: Boolean(workingTreeClean),
      frozen_release_matches_source: !componentDrift && !frozenBookmarkDrift,
      manager_bookmark_package_matches_source: !packageBookmarkDrift,
      windows_visual_acceptance_complete: !visualPending,
      final_doctor_verified: Boolean(doctorVerified)
    },
    ordered_promotion: [
      "accept-pending-bookmarklet-profiles",
      "choose-target-product-version",
      "freeze-release-spec",
      "refresh-manager-bookmark-package",
      "build-windows-candidate-transactionally",
      "accept-windows-visual-and-interaction",
      "run-npm-doctor-release"
    ]
  };
}

export function isWorkingTreeClean(root) {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "git status failed");
  return result.stdout.trim() === "";
}

export function buildReleasePromotionPlan(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const releaseSpec = readJson(root, "release-spec.json");
  return createReleasePromotionPlan({
    releaseSpec,
    source: readSourcePromotionFacts(root),
    workingTreeClean: isWorkingTreeClean(root),
    doctorVerified: false
  });
}

export function formatReleasePromotionPlan(plan) {
  const lines = [
    `Cloudig release promotion: ${plan.promotable ? "READY" : "BLOCKED"}`,
    `frozen: ${plan.frozen_release.product.display_version} / ${plan.frozen_release.snapshot_id}`,
    `source: Parser ${plan.source_candidate.components.parser}; Reader ${plan.source_candidate.components.reader}; bookmarks ${plan.source_candidate.bookmarklets.current_set_version}`,
    `next: ${plan.next_action}`
  ];
  for (const blocker of plan.blockers) lines.push(`- ${blocker}`);
  return `${lines.join("\n")}\n`;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    process.stderr.write("Usage: node scripts/release-promotion-plan.mjs [--json]\n");
    process.exitCode = 2;
  } else {
    const plan = buildReleasePromotionPlan();
    process.stdout.write(args[0] === "--json" ? `${JSON.stringify(plan, null, 2)}\n` : formatReleasePromotionPlan(plan));
  }
}
