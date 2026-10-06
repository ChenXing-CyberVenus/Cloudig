import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";
import { buildV1BookmarkPackage } from "./build-v1-bookmark-package.mjs";
import { currentBookmarkletBuildTargets } from "./build-current-bookmarklets.mjs";
import { checkV1AssetsCurrent } from "./check-v1-assets-current.mjs";
import { hashInputs } from "./v1-release-preflight.mjs";
import { writeV1ThirdPartyInventory } from "./v1-third-party-inventory.mjs";
import { buildWorkDependencies } from "./build-v1-work-dependencies.mjs";
import { buildMapRuntime } from "./build-v1-map-runtime.mjs";
import { installV1ProgramFiles } from "./v1-program-install.mjs";
import { buildV1SchemaPackage } from "./build-v1-schema-package.mjs";
import { packagePlatformExamples } from "./package-platform-examples.mjs";

const repository = process.cwd();
const argumentsList = process.argv.slice(2);
const reuseAcceptedBookmarks = argumentsList.includes("--reuse-accepted-bookmarks");
const includePendingBookmarks = argumentsList.includes("--include-pending-bookmarks");
assert.equal(!(reuseAcceptedBookmarks && includePendingBookmarks), true, "Cannot reuse accepted bookmarks and include pending bookmarks together");
assert.deepEqual(argumentsList.filter(argument => !["--reuse-accepted-bookmarks", "--include-pending-bookmarks", "--reuse-existing-examples"].includes(argument)), [], "Unknown build-v1-desktop argument");
const bookmarkBuildMode = reuseAcceptedBookmarks ? "reused-accepted" : includePendingBookmarks ? "current-pending" : "current";
const productVersion = JSON.parse(await readFile(path.join(repository, 'release/v1-preflight-spec.json'), 'utf8')).product.version;
assert.match(productVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
assert.equal((await readFile(path.join(repository, 'src/desktop/Cloudig.Desktop/Cloudig.Desktop.csproj'), 'utf8')).match(/<Version>([^<]+)<\/Version>/u)?.[1], productVersion, 'Desktop/release product versions differ');
const { bookmarkPublications, bookmarkDocumentText } = await import('./build-bookmark-documents.mjs');
const { buildPlatformExamples, exampleBuildRoot } = await import('./build-platform-examples.mts');
await bookmarkPublications(true);
const { featurePublications } = await import('./build-feature-document.mjs');
await featurePublications(true);
const exampleManifest = await buildPlatformExamples(true, { reuseExisting: true });
// Publication input is deterministic and independent of Parser/Schema waterlines.
const { compileStandard } = await import('./build-standard-document.mjs');
const { compileHistory, compileDialogueSources, historyPublicationOptions, historyManuscriptForPackage } = await import('./build-history-document.mjs');
const historyOptions = await historyPublicationOptions();
assert.deepEqual(JSON.parse(await readFile(path.join(repository, 'src/ui/shell/pages/document/content/history-dialogues.json'), 'utf8')), compileDialogueSources(historyOptions.dialogues), 'Build history dialogue sources before packaging');
const { licensePublication } = await import('./build-license-document.mjs');
assert.deepEqual(JSON.parse(await readFile(path.join(repository, 'src/ui/shell/pages/document/content/license.json'), 'utf8')), await licensePublication(), 'Build the LICENSE document before packaging');
for (const language of ['zh-CN', 'en']) {
  const source = await readFile(path.join(repository, `src/ui/documents/standard/${language}.md`), 'utf8');
  const publication = JSON.parse(await readFile(path.join(repository, `src/ui/shell/pages/document/content/standard-${language}.json`), 'utf8'));
  assert.deepEqual(publication, compileStandard(source, language), 'Build the Standard document before packaging');
  const history = await readFile(path.join(repository, `src/ui/documents/history/${language}.md`), 'utf8');
  assert.deepEqual(JSON.parse(await readFile(path.join(repository, `src/ui/shell/pages/document/content/history-${language}.json`), 'utf8')), compileHistory(history, language, historyOptions), 'Build History and Future before packaging');
}
const artifactRoot = path.join(repository, "artifacts", "v1-desktop");
const payloadRoot = path.join(artifactRoot, "payload");
const programPayloadRoot = path.join(payloadRoot, "app");
const publishRoot = path.join(artifactRoot, "app");
const nodeRoot = path.join(repository, "manager", ".cache", "node-v24.18.0-win-x64");
const dotnet = process.env.CLOUDIG_DOTNET || path.join(repository, "manager", ".cache", "dotnet", "dotnet.exe");
const packages = path.join(process.env.USERPROFILE ?? "", ".nuget", "packages");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const dollarSource = (await readFile(path.join(repository, "bookmarklets/vendor/osis-math-delimiters.js"), "utf8")).replaceAll("\r\n", "\n").trimEnd();
const dollarModule = (await readFile(path.join(repository, "src/ui/shared/conversation-renderer/dollar-boundaries.mjs"), "utf8")).replaceAll("\r\n", "\n");
assert.equal(dollarModule.slice(dollarModule.indexOf("/* Single-dollar"), dollarModule.indexOf("\n\nexport {")), dollarSource, "Reader/bookmark dollar recognizers diverged; verify the new rule before packaging");

assert.equal(path.dirname(artifactRoot), path.join(repository, "artifacts"));
await checkV1AssetsCurrent({ repository });
const temporaryRoot = path.join(repository, "tmp");
await mkdir(temporaryRoot, { recursive: true });
const bookmarkScratch = await mkdtemp(path.join(temporaryRoot, "v1-bookmark-package-"));
let bookmarkManifest;
let bookmarkManifestSha256;
try {
  if (reuseAcceptedBookmarks) {
    const previousBookmarkRoot = path.join(publishRoot, "bookmarks");
    const manifestBytes = await readFile(path.join(previousBookmarkRoot, "bookmark-package.json"));
    bookmarkManifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(bookmarkManifest.format, "cloudig/bookmark-package");
    assert.equal(bookmarkManifest.platform_count, 12);
    assert.equal(bookmarkManifest.variant_count, 32);
    for (const platform of bookmarkManifest.platforms) {
      for (const variant of platform.variants) {
        const artifact = await readFile(path.join(previousBookmarkRoot, "artifacts", ...variant.artifact.split("/")));
        assert.equal(artifact.byteLength, variant.bytes, `Reusable bookmark bytes drifted: ${variant.id}`);
        assert.equal(sha256(artifact), variant.sha256, `Reusable bookmark hash drifted: ${variant.id}`);
      }
    }
    await readFile(path.join(previousBookmarkRoot, "BOOKMARKLET_CHANGELOG.md"));
    await cp(previousBookmarkRoot, bookmarkScratch, { recursive: true });
    bookmarkManifestSha256 = sha256(manifestBytes);
  } else {
    bookmarkManifest = await buildV1BookmarkPackage(bookmarkScratch, { projectRoot: repository, allowPending: includePendingBookmarks });
    bookmarkManifestSha256 = sha256(await readFile(path.join(bookmarkScratch, "bookmark-package.json")));
  }
} catch (error) {
  await rm(bookmarkScratch, { recursive: true, force: true });
  throw error;
}
try {
  // The fixed root can contain user records and cache.
  // Only generated program components are replaceable; never clear app/root.
  await rm(payloadRoot, { recursive: true, force: true });
  await mkdir(path.join(programPayloadRoot, "engine"), { recursive: true });
  await mkdir(path.join(programPayloadRoot, "runtime", "node"), { recursive: true });
  await mkdir(path.join(programPayloadRoot, "web", "runtime"), { recursive: true });
  await cp(bookmarkScratch, path.join(payloadRoot, "bookmarks"), { recursive: true });
} finally {
  await rm(bookmarkScratch, { recursive: true, force: true });
}

// Bundled CommonJS dependencies (notably yauzl) still require Node built-ins.
// Keep the runtime self-contained while providing require in both ESM entries.
const nodeEsmBanner = { js: 'import { createRequire as cloudigCreateRequire } from "node:module"; const require = cloudigCreateRequire(import.meta.url);' };
const engine = await build({
  entryPoints: [path.join(repository, "src", "engine", "main.mts")],
  bundle: true,
  outfile: path.join(programPayloadRoot, "engine", "engine.mjs"),
  format: "esm",
  banner: nodeEsmBanner,
  legalComments: "linked",
  metafile: true,
  minify: true,
  platform: "node",
  sourcemap: false,
  target: ["node20.19"]
});

const parserWorker = await build({
  entryPoints: [path.join(repository, "src/app/parser/record-worker-entry.mts")],
  bundle: true, outfile: path.join(programPayloadRoot, "engine/record-parser-worker.mjs"),
  format: "esm", banner: nodeEsmBanner, legalComments: "linked", metafile: true, minify: true,
  platform: "node", sourcemap: false, target: ["node20.19"]
});

const renderer = await build({
  entryPoints: [path.join(repository, "src", "ui", "shared", "conversation-renderer", "browser-entry.mts")],
  bundle: true,
  outdir: path.join(programPayloadRoot, "web", "runtime"),
  entryNames: "conversation-renderer",
  assetNames: "assets/[name]-[hash]",
  format: "iife",
  globalName: "CloudigConversationRenderer",
  legalComments: "linked",
  loader: { ".ttf": "file", ".woff": "file", ".woff2": "file" },
  metafile: true,
  minify: true,
  platform: "browser",
  sourcemap: false,
  target: ["chrome120"]
});

const mermaidLayout = await build({
  entryPoints: [path.join(repository, "src/ui/shared/conversation-renderer/mermaid-frame.mts")],
  bundle: true, outfile: path.join(programPayloadRoot, "web/runtime/mermaid-frame.js"),
  format: "iife", legalComments: "linked", metafile: true, minify: true, platform: "browser", target: ["chrome120"]
});
await cp(path.join(repository, "src/ui/shared/conversation-renderer/mermaid-frame.html"), path.join(programPayloadRoot, "web/runtime/mermaid-frame.html"));
const interactiveFrame = await build({
  entryPoints: [path.join(repository, "src/ui/shared/conversation-renderer/interactive-frame.mts")],
  bundle: true, outfile: path.join(programPayloadRoot, "web/runtime/interactive-frame.js"),
  format: "iife", legalComments: "linked", metafile: true, minify: true, platform: "browser", target: ["chrome120"]
});
await cp(path.join(repository, "src/ui/shared/conversation-renderer/interactive-frame.html"), path.join(programPayloadRoot, "web/runtime/interactive-frame.html"));
const workDependencies = await buildWorkDependencies(repository, path.join(programPayloadRoot, "web/runtime/dependencies"));
const mapRuntime = await buildMapRuntime(repository, path.join(programPayloadRoot, "web/runtime"));
for (const metafile of [engine.metafile, parserWorker.metafile, renderer.metafile, mermaidLayout.metafile, interactiveFrame.metafile, workDependencies.metafile, ...Object.values(mapRuntime.metafiles)]) {
  assert.equal(Object.keys(metafile.inputs).some((entry) => /^https?:/iu.test(entry)), false);
}

await cp(path.join(repository, "src", "ui", "shell"), path.join(programPayloadRoot, "web"), { recursive: true });
await cp(path.join(repository, "src", "ui", "shared", "time"), path.join(programPayloadRoot, "web", "shared", "time"), { recursive: true });
await cp(path.join(repository, "src/ui/shared/parser-history.js"), path.join(programPayloadRoot, "web/shared/parser-history.js"));
await cp(path.join(repository, "src/ui/shared/record-text-input.js"), path.join(programPayloadRoot, "web/shared/record-text-input.js"));
await build({
  entryPoints: [path.join(repository, "src/core/records/text-limits.mts")],
  outfile: path.join(programPayloadRoot, "web/shared/record-text-limits.js"),
  bundle: true, format: "esm", minify: true, platform: "browser", target: ["chrome120"]
});
await cp(path.join(repository, "src/adapters/parser/contracts/parser-history.json"), path.join(programPayloadRoot, "web/shared/parser-history.json"));
await build({
  entryPoints: [path.join(repository, "src/core/time/format-endpoint.mts")],
  outfile: path.join(programPayloadRoot, "web/shared/time/core-format.js"),
  bundle: true, format: "esm", minify: true, platform: "browser", target: ["chrome120"]
});
await build({
  entryPoints: [path.join(repository, "src/core/records/time-labels.mts")],
  outfile: path.join(programPayloadRoot, "web/shared/time/record-format.js"),
  bundle: true, format: "esm", minify: true, platform: "browser", target: ["chrome120"]
});
await cp(path.join(repository, "src", "ui", "assets"), path.join(programPayloadRoot, "web", "assets"), { recursive: true });
await cp(path.join(nodeRoot, "node.exe"), path.join(programPayloadRoot, "runtime", "node", "node.exe"));
await cp(path.join(nodeRoot, "LICENSE"), path.join(programPayloadRoot, "runtime", "node", "LICENSE.node.txt"));
await cp(path.join(repository, "LICENSE"), path.join(payloadRoot, "LICENSE"));
await cp(path.join(repository, "NOTICE.md"), path.join(payloadRoot, "NOTICE.md"));
await buildV1SchemaPackage(repository, path.join(payloadRoot, "docs/schemas"));
const exampleDelivery = await packagePlatformExamples(repository, payloadRoot, exampleManifest);
await mkdir(path.join(payloadRoot, 'docs/bookmarks'), { recursive: true });
for (const language of ['zh-CN', 'en']) {
  const guide = bookmarkDocumentText(await readFile(path.join(repository, `src/ui/documents/bookmarks/${language}.md`), 'utf8'), 'bookmark', language);
  await writeFile(path.join(payloadRoot, `docs/bookmarks/Cloudig-Bookmarklet-Guide.${language}.md`), guide.replace('(cloudig:platforms)', `(../examples/Cloudig-Platform-Examples.${language}.md)`));
}
await cp(path.join(repository, 'src/ui/shell/pages/document/assets/bookmark-guide'), path.join(payloadRoot, 'docs/bookmarks/assets/bookmark-guide'), { recursive: true });
await mkdir(path.join(payloadRoot, 'docs/standard'), { recursive: true });
await mkdir(path.join(payloadRoot, 'docs/history'), { recursive: true });
await cp(path.join(repository, 'src/ui/documents/history/appeal.txt'), path.join(payloadRoot, 'docs/history/07_深渊48日_原文.txt'));
await cp(path.join(repository, 'src/ui/shell/pages/document/assets/anthropic-mail.png'), path.join(payloadRoot, 'docs/history/07_Anthropic邮件.png'));
for (const language of ['zh-CN', 'en']) {
  await cp(path.join(repository, `src/ui/documents/standard/${language}.md`), path.join(payloadRoot, `docs/standard/Cloudig-Standard.${language}.md`));
  const historyText = await readFile(path.join(repository, `src/ui/documents/history/${language}.md`), 'utf8');
  await writeFile(path.join(payloadRoot, `docs/history/Cloudig-History-and-Future.${language}.md`), historyManuscriptForPackage(historyText, language, historyOptions.prefaceEnglish));
}

const runtimeLock = {
  schema: "cloudig/runtime-lock/1.0.0",
  cloudig: productVersion,
  engine: "0.1.0-dev",
  node: "24.18.0",
  dotnet_sdk: "10.0.302",
  webview2_package: "1.0.4078.44",
  renderer: {
    markdown_it: "15.0.1",
    katex: "0.18.5",
    mermaid: "11.17.2"
  },
  bookmarks: {
    mode: bookmarkBuildMode,
    package: bookmarkManifest.version,
    set: bookmarkManifest.bookmark_set_version,
    light: 12,
    full: 12,
    tree: 8
  }
};
await writeFile(path.join(programPayloadRoot, "runtime-lock.json"), `${JSON.stringify(runtimeLock, null, 2)}\n`, "utf8");

const thirdParty = await writeV1ThirdPartyInventory({
  repository,
  outputRoot: path.join(payloadRoot, "docs"),
  metafiles: { engine: engine.metafile, parser_worker: parserWorker.metafile, renderer: renderer.metafile, mermaid_layout: mermaidLayout.metafile, interactive_frame: interactiveFrame.metafile, interactive_react: workDependencies.metafile, ...mapRuntime.metafiles }
});
await writeFile(path.join(programPayloadRoot, 'web/pages/document/content/license-third-party.json'), JSON.stringify(thirdParty.publication) + '\n', 'utf8');

const git = (args) => {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
const sourceStatus = git(["status", "--porcelain", "--untracked-files=all"]);
const sourceInputs = hashInputs(repository, [
  "src",
  "manager/windows/Cloudig.Bookmarks",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "NOTICE.md",
  "release/v1-preflight-spec.json",
  "scripts/build-v1-bookmark-package.mjs",
  "scripts/build-v1-desktop.mjs",
  "scripts/build-v1-map-runtime.mjs",
  "scripts/build-license-document.mjs",
  "scripts/build-bookmark-documents.mjs",
  "scripts/build-feature-document.mjs",
  "scripts/build-platform-examples.mts",
  "scripts/package-platform-examples.mjs",
  "scripts/v1-release-preflight.mjs",
  "scripts/run-v1-real-library-evidence.mjs",
  "scripts/run-v1-release-benchmark.mjs",
  "scripts/v1-third-party-inventory.mjs",
  "tsconfig.v1.json",
  ...(reuseAcceptedBookmarks ? [] : currentBookmarkletBuildTargets.map((target) => `bookmarklets/${target.min}`))
], { excludeNativeBuildOutputs: true });
const buildProvenance = {
  schema: "cloudig/build-provenance/1.0.0",
  product: runtimeLock.cloudig,
  source: {
    commit: git(["rev-parse", "HEAD"]),
    commit_time: git(["show", "-s", "--format=%cI", "HEAD"]),
    working_tree_clean: sourceStatus === ""
  },
  inputs: {
    file_count: sourceInputs.file_count,
    total_bytes: sourceInputs.total_bytes,
    aggregate_sha256: sourceInputs.aggregate_sha256
  },
  bookmarks: {
    mode: bookmarkBuildMode,
    set: bookmarkManifest.bookmark_set_version,
    manifest_sha256: bookmarkManifestSha256
  },
  examples: {
    ...exampleDelivery,
    parser_input_sha256: exampleManifest.parser_input_sha256,
    manifest_sha256: sha256(await readFile(path.join(exampleBuildRoot, "manifest.json")))
  },
  environment: {
    platform: process.platform,
    architecture: process.arch,
    build_node: process.version.replace(/^v/u, ""),
    packaged_node: runtimeLock.node,
    dotnet_sdk: runtimeLock.dotnet_sdk,
    target_framework: "net10.0-windows",
    runtime_identifier: "win-x64",
    self_contained: true,
    single_file: false,
    native_dependencies: "app-directory-no-self-extraction",
    webview2_package: runtimeLock.webview2_package
  }
};
await writeFile(path.join(programPayloadRoot, "build-provenance.json"), `${JSON.stringify(buildProvenance, null, 2)}\n`, "utf8");

const publish = spawnSync(dotnet, [
  "publish",
  "src/desktop/Cloudig.Desktop/Cloudig.Desktop.csproj",
  "-c", "Release",
  "-m:1",
  "-r", "win-x64",
  "--self-contained", "true",
  `-p:RestorePackagesPath=${packages}`,
  `-p:CloudigPayloadRoot=${programPayloadRoot}`,
  `-p:CloudigPortableRoot=${payloadRoot}`,
  `-p:Version=${runtimeLock.cloudig}`,
  "-o", programPayloadRoot,
  "--nologo"
], {
  cwd: repository,
  encoding: "utf8",
  env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
  windowsHide: true
});
if (publish.error) throw new Error(`Desktop publish could not start: ${publish.error.code ?? publish.error.message}`);
if (publish.status !== 0) throw new Error(`${publish.stdout}\n${publish.stderr}`);
await installV1ProgramFiles(payloadRoot, publishRoot);

for (const required of [
  "Cloudig.exe",
  "engine/engine.mjs",
  "engine/record-parser-worker.mjs",
  "runtime/node/node.exe",
  "bookmarks/bookmark-package.json",
  "bookmarks/BOOKMARKLET_CHANGELOG.md",
  "bookmarks/artifacts/chatgpt/light.min.js",
  "bookmarks/artifacts/claude/all_branches.min.js",
  "web/index.html",
  "web/shell.css",
  "web/shell.js",
  "web/startup.js",
  "web/operation-progress.js",
  "web/operation-progress.css",
  "web/overflow-text.js",
  "web/pages/reader/reader.css",
  "web/pages/document/license.js",
  "web/pages/document/license.css",
  "web/pages/document/content/license.json",
  "web/pages/document/content/license-third-party.json",
  "web/pages/reader/reader-cover.js",
  "web/pages/reader/conversation.css",
  "web/pages/reader/reader-conversation.js",
  "web/pages/archiver/archiver.css",
  "web/pages/archiver/archiver.js",
  "web/pages/archiver/claude-container.css",
  "web/pages/archiver/claude-container.js",
  "web/pages/archiver/platform-json.js",
  "web/pages/archiver/platform-json-presentation.js",
  "web/pages/archiver/platform-json.css",
  "web/assets/platforms/platform-codex.svg",
  "web/assets/platforms/Codex-LICENSE.txt",
  "web/assets/platforms/platform-cline.svg",
  "web/assets/platforms/platform-sillytavern.svg",
  "web/assets/platforms/platform-kimi-code.svg",
  "web/assets/platforms/platform-claude-code.svg",
  "web/assets/platforms/platform-agent-instance.svg",
  "web/pages/conversation-info/conversation-info.css",
  "web/pages/conversation-info/conversation-info.js",
  "web/pages/time-cover/time-cover.css",
  "web/pages/time-cover/time-cover.js",
  "web/pages/time-editor/time-editor.css",
  "web/pages/time-editor/time-editor.js",
  "web/shared/time/endpoint-editor.css",
  "web/shared/time/endpoint-editor.js",
  "web/shared/time/core-format.js",
  "web/shared/parser-history.js",
  "web/shared/parser-history.json",
  "web/assets/editor/EditorBack-Tao.svg",
  "web/assets/editor/EditorBack-Drawer.svg",
  "web/assets/editor/ContentTimeTitleBack-Dawn.svg",
  "web/assets/editor/ContentTimeTitleBack-StarNight.svg",
  "web/assets/editor/TimeLOGO-Terran.svg",
  "web/assets/editor/TimeLOGO-Sovereign.svg",
  "web/assets/editor/Title-Paper-Editor-Dawn.svg",
  "web/assets/editor/Title-Paper-Editor-StarNight.svg",
  "web/locales/zh-CN.json",
  "web/locales/en.json",
  "web/assets/asset-sources.json",
  "web/assets/welcome/OsisLogo-Main-1024.png",
  "web/assets/reader/Waiting-Sun.gif",
  "web/assets/reader/Conversation-Title-Back-Dawn.svg",
  "web/assets/reader/ToolBar-Pattern-StarNight.svg",
  "web/assets/archiver/TitleDec-Explosion.svg",
  "web/assets/archiver/TitleDec-Garden.svg",
  "web/assets/archiver/TitleDec-Pompeii.svg",
  "web/assets/archiver/TitleDec-Conquer.svg",
  "web/assets/archiver/TitleDec-Planet.svg",
  "web/assets/archiver/TitleDec-Homeland.svg",
  "web/assets/reader/RCSD-桌面与杂物.svg",
  "web/assets/reader/RCSS-桌面与电脑-黑灯.svg",
  "web/assets/platforms/platform-chatgpt.svg",
  "web/assets/platforms/platform-doubao.png",
  "web/runtime/conversation-renderer.js",
  "web/runtime/conversation-renderer.css",
  "web/runtime/mermaid-frame.html",
  "web/runtime/mermaid-frame.js",
  "web/runtime/map-frame.html",
  "web/runtime/map-frame.js",
  "web/runtime/map-frame.css",
  "web/runtime/map-worker.js",
  "build-provenance.json",
  "third-party-inventory.json",
  "THIRD-PARTY-LICENSES.txt",
  "runtime-lock.json",
  "LICENSE",
  "NOTICE.md"
]) {
  const relative = /^(?:engine|runtime|web)\//u.test(required) || ["build-provenance.json", "runtime-lock.json"].includes(required)
    ? `app/${required}` : ["third-party-inventory.json", "THIRD-PARTY-LICENSES.txt"].includes(required) ? `docs/${required}` : required;
  const info = await stat(path.join(publishRoot, ...relative.split("/")));
  assert.ok(info.isFile() && info.size > 0, `Missing packaged file: ${required}`);
}

const engineOutput = Object.values(engine.metafile.outputs).reduce((sum, value) => sum + value.bytes, 0);
const rendererOutput = Object.values(renderer.metafile.outputs).reduce((sum, value) => sum + value.bytes, 0);
const executable = await stat(path.join(publishRoot, "Cloudig.exe"));
console.log(JSON.stringify({ publishRoot, exeBytes: executable.size, engineBytes: engineOutput, rendererBytes: rendererOutput }));
