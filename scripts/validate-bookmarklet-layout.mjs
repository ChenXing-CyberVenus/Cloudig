import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveBookmarkletTargets } from "./archive-bookmarklet-targets.mjs";
import { validateBookmarkletTestDirectory } from "./refresh-bookmarklet-test-set.mjs";
import {
  bookmarkletPlatforms,
  claudeLayoutVariants
} from "./bookmarklet-layout.mjs";
import { bookmarkletTargets } from "./bookmarklet-targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bookmarkletRoot = join(projectRoot, "bookmarklets");
const platformSet = new Set(bookmarkletPlatforms);

function walkFiles(root, skippedRootDirectories = new Set(), depth = 0) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !(depth === 0 && skippedRootDirectories.has(entry.name))) {
      files.push(...walkFiles(path, skippedRootDirectories, depth + 1));
    }
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function jsPaths(root, skippedDirectories) {
  return walkFiles(root, skippedDirectories)
    .filter((path) => path.endsWith(".js"))
    .map((path) => relative(bookmarkletRoot, path).replaceAll("\\", "/"))
    .sort();
}

function expectedPaths(targets) {
  return targets.flatMap((target) => [target.source, target.min]).sort();
}

function validateStatePath(path, state) {
  const [actualState, platform, filename, ...extra] = path.split("/");
  assert.equal(actualState, state, `${path} is outside ${state}`);
  assert.equal(platformSet.has(platform), true, `${path} uses an unknown platform directory`);
  assert.equal(Boolean(filename) && extra.length === 0, true, `${path} is not directly paired under its platform`);
}

export function validateBookmarkletLayout() {
  const rootJs = readdirSync(bookmarkletRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name);
  assert.deepEqual(rootJs, [], "bookmarklets root must not contain loose JS files");

  const stableClaude = claudeLayoutVariants.filter((target) => target.state === "stable");
  const candidateClaudeLight = claudeLayoutVariants.filter((target) => target.state === "candidate");
  const expectedStable = expectedPaths([...bookmarkletTargets, ...stableClaude]);
  const expectedCandidate = expectedPaths([...archiveBookmarkletTargets, ...candidateClaudeLight]);
  const actualStable = jsPaths(join(bookmarkletRoot, "stable"));
  const actualCandidate = jsPaths(join(bookmarkletRoot, "candidate"), new Set(["test"]));

  assert.deepEqual(actualStable, expectedStable, "stable bookmarklet inventory differs from the accepted registry");
  assert.deepEqual(actualCandidate, expectedCandidate, "candidate bookmarklet inventory differs from the candidate registry");
  for (const path of actualStable) validateStatePath(path, "stable");
  for (const path of actualCandidate) validateStatePath(path, "candidate");

  const legacyRoot = join(bookmarkletRoot, "legacy");
  const legacyEntries = readdirSync(legacyRoot, { withFileTypes: true });
  const legacyRootFiles = legacyEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert.deepEqual(legacyRootFiles, ["README.md"], "legacy root may contain only its README");
  const legacyDirectories = legacyEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(legacyDirectories, [...bookmarkletPlatforms].sort(), "legacy must be partitioned by every supported platform");

  const actualLegacy = jsPaths(legacyRoot);
  // 2026-07-29 explicitly froze two consecutive 32-track sets as paired source/min artifacts: 579 + 64 + 64 = 707.
  // 2026-08-07 then froze the immediately preceding ChatGPT Light and Full source/min pairs before user Markdown/LaTeX rendering: 707 + 4 = 711.
  // 2026-08-08 froze the accepted ChatGPT Full and AllBranches source/min pairs before generated-file byte capture: 711 + 4 = 715.
  // 2026-08-09 froze the accepted ChatGPT baseline plus two failed memory-source candidates: 715 + 6 + 6 + 6 = 733.
  // The all-messages/all-branches repair froze its preceding three-track set (733 + 6 = 739),
  // then the ChatGPT Light SSE performance repair froze the accepted 3.7.18 source/min pair: 739 + 2 = 741,
  // and the equivalent Full / AllBranches repair froze their accepted source/min pairs: 741 + 4 = 745.
  // The accepted AllBranches SSE candidate was then frozen before the bounded whole-tree builder: 745 + 2 = 747.
  // The accepted three-track set was frozen before the bounded memory scheduler and page cache: 747 + 6 = 753.
  // ChatGPT's two Scheduled generations, Claude 1.1.8, Claude 1.1.9 and Claude 1.1.10 were frozen before their successors: 759 + 6 + 6 + 6 + 6 + 6 = 789.
  // Claude 1.1.11 was frozen before the stable-disclosure/single-recovery-path Cowork successor: 789 + 6 = 795.
  // Claude 1.1.12 was then frozen before the Cowork image-reveal/favicon successor: 795 + 6 = 801.
  // Claude 1.1.13 was frozen before confirmation-layer image-link recovery and honest unknown durations: 801 + 6 = 807.
  // Claude 1.1.14 was frozen before the Cowork Chat/Cowork split repair: 807 + 6 = 813.
  // Claude 1.1.15 was frozen before conversation-level model fallback: 813 + 6 = 819.
  // Claude 1.1.16 was frozen before current-selection and per-message model evidence were separated: 819 + 6 = 825.
  // ChatGPT's accepted three-track set and Claude 1.1.17 were frozen before the cross-platform performance repair: 825 + 6 + 6 = 837.
  // Claude 1.1.18 was frozen after its public-panel traversal was rejected for cross-screen remount chasing: 837 + 6 = 843.
  // Claude 1.1.20 was frozen before Chat moved to API-first sparse DOM enrichment: 849 + 6 = 855.
  // Claude 1.1.21 was frozen before Cowork split lazy loading from one-shot loaded-state reuse / forward fallback: 855 + 6 = 861.
  // Claude 1.1.22 was frozen before duplicate outer/inner Cowork thought headings were removed from the reading layer: 861 + 6 = 867.
  // Claude 1.1.24 was frozen before per-message timestamp capture: 873 + 6 = 879.
  // Claude 1.1.25 was frozen before scrollable Cowork timelines stopped treating complete article shells as complete rich content: 879 + 6 = 885.
  // Claude 1.1.26 was frozen before public image-search results received a second bounded proxy fallback: 885 + 6 = 891.
  // ChatGPT 3.7.24 / 1.0.20 / 1.0.20 were frozen before mixed api_tool text-plus-resource nodes were kept as folded tools: 891 + 6 = 897.
  // ChatGPT 1.0.21 Tree was frozen before large HTML shell assembly stopped using cross-document regular expressions: 897 + 2 = 899.
  // ChatGPT 3.7.25 / 1.0.21 / 1.0.22 were frozen before native Mermaid preview activation restored vendor diagrams: 899 + 6 = 905.
  // ChatGPT 3.7.26 / 1.0.22 / 1.0.23 were frozen before targeted virtual-window loading captured offscreen native Mermaid diagrams: 905 + 6 = 911.
  // Gemini 2.7.9 / 1.0.5 remain the accepted rollback anchor; seven ChatGPT redesign rounds plus Claude 1.1.27, 1.1.28 and 1.1.29 each freeze six source/min pairs: 919 + 6 + 6 + 6 + 6 + 6 + 6 + 6 + 6 + 6 + 6 = 979.
  // Kimi 2.9.9 / 1.0.5 / 1.0.5 were frozen before complete Kimi's Computer search tasks and explicit cited-source fields: 979 + 6 = 985.
  // Claude 1.1.30 was frozen before Chat footnote/Shadow-Mermaid recovery and Cowork inline Write-file capture: 985 + 6 = 991.
  // Claude 1.1.31 was frozen before DOM-rescued Chat TurnStatus thought/tool recovery: 991 + 6 = 997.
  // Claude Full/Tree 1.1.32 were frozen before Chat present_files byte capture: 997 + 4 = 1001.
  // Claude Light 1.1.32 and Full/Tree 1.1.33 were frozen before Cowork delayed-middle recovery and Chat current-path requests: 1001 + 6 = 1007.
  // Claude Light 1.1.35 was frozen before the verified page/API race: 1009 + 2 = 1011.
  // Claude Full/Tree 1.1.34 were frozen before duplicate create_file/present_files Artifact cards were collapsed in the reading layer: 1011 + 4 = 1015.
  // Rejected Claude Light 1.1.40 and Full/Tree 1.1.39 were frozen before the live reading-order repair: 1019 + 6 = 1025.
  // Rejected Claude Light 1.1.41 and Full/Tree 1.1.40 were frozen before footnote and Shadow-Mermaid rich DOM ownership was restored: 1025 + 6 = 1031.
  // Rejected Claude Light 1.1.42 and Full/Tree 1.1.41 were frozen before incomplete Cowork page state stopped truncating complete DOM: 1031 + 6 = 1037.
  // ChatGPT's 2026-10-02 branch-selection set adds six preserved predecessor source/min snapshots: 1340 + 6 = 1346.
  assert.equal(
    actualLegacy.length,
    1346, // Freeze the Mermaid-repair predecessor set, reverse-scroll redo baseline, and 2026-10-02 ChatGPT predecessors.
    "legacy JS inventory changed without an explicit layout update"
  );
  for (const path of actualLegacy) validateStatePath(path, "legacy");

  for (const path of [...expectedStable, ...expectedCandidate]) {
    assert.equal(existsSync(join(bookmarkletRoot, path)), true, `registered bookmarklet is missing: ${path}`);
  }
  validateBookmarkletTestDirectory();

  return Object.freeze({
    stable_files: actualStable.length,
    stable_pairs: actualStable.length / 2,
    candidate_files: actualCandidate.length,
    candidate_pairs: actualCandidate.length / 2,
    legacy_js_files: actualLegacy.length,
    platforms: bookmarkletPlatforms.length
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...validateBookmarkletLayout() })}\n`);
}
