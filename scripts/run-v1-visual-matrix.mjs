import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, rm, writeFile, utimes, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hashInputs } from "./v1-release-preflight.mjs";

if (process.platform !== "win32") throw new Error("Cloudig fixed-EXE visual matrix requires Windows");

const argumentsList = process.argv.slice(2);
const searchEntryOnly = argumentsList.includes("--search-entry-only");
const claudeContext = argumentsList.includes("--claude-context");
const sourceEmpty = argumentsList.includes("--source-empty");
const parserStatus = argumentsList.includes("--parser-status");
const indexReopen = argumentsList.includes("--index-reopen");
const sourcePicker = argumentsList.includes("--source-picker");
const readerResources = argumentsList.includes("--reader-resources");
const claudeSourceIndex = argumentsList.indexOf("--claude-source");
const officialSourceIndex = argumentsList.indexOf("--official-source");
const claudeSource = officialSourceIndex >= 0 ? argumentsList[officialSourceIndex + 1] : claudeSourceIndex >= 0 ? argumentsList[claudeSourceIndex + 1] : null;
const quick = argumentsList.includes("--quick");
const recordUi = argumentsList.includes("--record-ui");
const captureIndex = argumentsList.indexOf("--capture-time-json");
const captureJson = captureIndex >= 0 ? argumentsList[captureIndex + 1] : null;
if (captureIndex >= 0 && (!captureJson || !recordUi)) throw new Error("--capture-time-json requires a real Claude JSON and --record-ui");
const guideCapture = argumentsList.includes("--guide-capture");
if (guideCapture && !recordUi) throw new Error("Guide captures require an owned real Library (--record-ui)");
const requireBranch = argumentsList.includes("--require-branch");
const lineBoundaryIndex = argumentsList.indexOf("--minimum-line-boundaries");
const minimumLineBoundaries = lineBoundaryIndex < 0 ? 0 : Number(argumentsList[lineBoundaryIndex + 1]);
if (!Number.isSafeInteger(minimumLineBoundaries) || minimumLineBoundaries < 0 || (lineBoundaryIndex >= 0 && minimumLineBoundaries === 0)) throw new Error("--minimum-line-boundaries requires a positive integer");
const resizeRoundtrip = argumentsList.includes("--resize-roundtrip");
const outputIndex = argumentsList.indexOf("--output");
const languageIndex = argumentsList.indexOf("--language");
const themeIndex = argumentsList.indexOf("--theme");
const surfaceIndex = argumentsList.indexOf("--surface");
const viewportIndex = argumentsList.indexOf("--viewport");
const realSampleIndex = argumentsList.indexOf("--real-sample");
const realConversationIndex = argumentsList.indexOf("--real-conversation");
const executableIndex = argumentsList.indexOf("--executable");
const realConversation = realConversationIndex >= 0 ? argumentsList[realConversationIndex + 1] : null;
const searchCompanionsIndex = argumentsList.indexOf("--search-companions");
const searchCompanions = searchCompanionsIndex >= 0 ? JSON.parse(argumentsList[searchCompanionsIndex + 1]) : null;
const requestedLanguage = languageIndex >= 0 ? argumentsList[languageIndex + 1] : null;
const requestedTheme = themeIndex >= 0 ? argumentsList[themeIndex + 1] : null;
const requestedSurface = surfaceIndex >= 0 ? argumentsList[surfaceIndex + 1] : null;
if (sourcePicker && (!recordUi || requestedSurface !== 'platform-json-entry')) throw new Error('--source-picker requires --record-ui and platform-json-entry');
if (readerResources && (!realConversation || requestedSurface !== 'reader-conversation')) throw new Error('--reader-resources requires --real-conversation and reader-conversation');
if (minimumLineBoundaries && requestedSurface !== "reader-conversation") throw new Error("Line geometry requires the reader-conversation surface");
if (searchEntryOnly && !requestedSurface?.startsWith("search-")) throw new Error("--search-entry-only requires a search surface");
const requestedViewport = viewportIndex >= 0 ? argumentsList[viewportIndex + 1] : null;
const realSample = realSampleIndex >= 0 ? argumentsList[realSampleIndex + 1] : null;
const galleryIndex = argumentsList.indexOf("--diagram-gallery");
const diagramGallery = galleryIndex >= 0 ? argumentsList[galleryIndex + 1] : null;
if (galleryIndex >= 0 && (!diagramGallery || realSample || requestedSurface !== "reader-conversation")) throw new Error("--diagram-gallery is an isolated Reader-only derived fixture, not a real source journey");
const batchIndex = argumentsList.indexOf("--batch-samples");
const batchSamples = batchIndex >= 0 ? argumentsList[batchIndex + 1] : null;
if (batchIndex >= 0 && (!batchSamples || realSample || diagramGallery || requestedSurface !== "archiver-parse-batch")) throw new Error("--batch-samples requires the isolated Archiver parse journey");
if (realConversationIndex >= 0 && (!realConversation || realSample || diagramGallery || batchSamples || !["reader-conversation", "reader-map", "reader-works", "reader-cards", "reader-summaries", "reader-catalog-open", "archiver", "archiver-record-compatibility", "search-reader", "search-archiver"].includes(requestedSurface))) throw new Error("--real-conversation requires one canonical JSON and a supported Reader/Archiver surface");
if (requestedSurface?.startsWith("search-") && (!realConversation || !Array.isArray(searchCompanions) || searchCompanions.length !== 2)) throw new Error("Search journey needs its primary real Tree and two --search-companions");
if (recordUi && (realSample || diagramGallery || batchSamples || realConversation)) throw new Error("--record-ui owns one synthetic Library through the packaged Engine; do not mix inputs");
if (requireBranch && !realSample && !realConversation) throw new Error("--require-branch needs an actual HTML or Conversation input");
const realFixture = Boolean(realSample || diagramGallery || batchSamples || realConversation || recordUi);
if (claudeContext && (!realConversation || requestedSurface !== "reader-conversation")) throw new Error("--claude-context requires a real parsed Conversation and reader-conversation surface");
if (sourceEmpty && (!realConversation || requestedSurface !== "reader-conversation")) throw new Error("--source-empty requires a real parsed Conversation");
if (sourceEmpty && requireBranch) throw new Error("A source-empty audit cannot stand in for an interactive branch audit");
if ((claudeSourceIndex >= 0 || officialSourceIndex >= 0) && (!claudeSource || !recordUi || requestedSurface !== "claude-container")) throw new Error("An official source requires --record-ui and claude-container");
if (parserStatus && !claudeSource) throw new Error("--parser-status requires a real --claude-source in an owned Library");
if (indexReopen && (officialSourceIndex < 0 || !claudeSource)) throw new Error("--index-reopen requires a real --official-source ZIP");
if (parserStatus && (!requestedTheme || !requestedViewport || !requestedLanguage)) throw new Error("--parser-status mutates its fixture: use one explicit theme, viewport and language per owned Library");
if (realSampleIndex >= 0 && (!realSample || !requestedSurface?.split(",").every(surface => ["reader-conversation", "reader-nested-process", "reader-schedule", "reader-catalog-open", "reader-row-menu", "reader-title-hover", "archiver-title-hover", "archiver-information", "conversation-info", "archiver-external-refresh", "archiver-batch-delete"].includes(surface)))) {
  throw new Error("--real-sample requires one HTML file and a supported Reader/Archiver surface");
}
if (requestedSurface?.split(",").includes("reader-schedule") && !realSample) throw new Error("reader-schedule needs a real captured task-list HTML");
if (requestedLanguage !== null && !["zh-CN", "en"].includes(requestedLanguage)) throw new Error("--language must be zh-CN or en");
if (requestedTheme !== null && !["dawn", "star-night"].includes(requestedTheme)) throw new Error("--theme must be dawn or star-night");
if (batchSamples && requestedTheme === "star-night") throw new Error("Batch parse audit uses the dawn fixture");
const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z");
const outputRoot = path.resolve(outputIndex >= 0 ? argumentsList[outputIndex + 1] : path.join("artifacts", "v1-visual-audit", stamp));
const executable = executableIndex < 0 ? path.join(process.cwd(), "artifacts", "v1-desktop", "app", "Cloudig.exe") : path.resolve(argumentsList[executableIndex + 1]);
if (!executable.startsWith(process.cwd() + path.sep) || path.basename(executable) !== "Cloudig.exe") throw new Error("Audit executable must be a Cloudig.exe within this project");
const executableBytes = await readFile(executable);
const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
const engineFile = path.join(path.dirname(executable), "app", "engine", "engine.mjs");
const engineSha256 = createHash("sha256").update(await readFile(engineFile)).digest("hex");
const programPath = path.relative(process.cwd(), path.join(path.dirname(executable), "app")).replaceAll("\\", "/");
const programFingerprint = hashInputs(process.cwd(), [programPath]);
const auditUserDataRoot = path.join(outputRoot, "cache", "WebView2");
const auditExtractRoot = path.join(outputRoot, ".bundle-extract");
let extractionEntries = 0;
await mkdir(path.dirname(outputRoot), { recursive: true });
await mkdir(outputRoot, { recursive: false });

const availableViewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 }
];
const requestedSize = requestedViewport?.match(/^(\d+)x(\d+)$/u);
const viewports = requestedViewport === null ? availableViewports : requestedSize
  ? [{ width: Number(requestedSize[1]), height: Number(requestedSize[2]) }] : [];
if (!viewports.length || viewports.some(({width,height}) => width < 1280 || width > 7680 || height < 720 || height > 4320)) throw new Error("--viewport must be a client DIP size within 1280x720 through 7680x4320");
const themes = requestedTheme ? [requestedTheme] : batchSamples ? ["dawn"] : ["dawn", "star-night"];
const languages = requestedLanguage ? [requestedLanguage] : quick ? ["zh-CN"] : ["zh-CN", "en"];
const surfaces = [
  ...["reader", "archiver"].map(route => ({ id: `search-${route}`, route, fixture: "real", phase: "motion-freeze", interaction: "search-copy" })),
  ...["welcome", "reader", "archiver"].map(route => ({ id: `english-${route}`, route, fixture: "real", phase: "motion-freeze", interaction: "english-layout" })),
  ...["welcome", "reader", "archiver"].map(route => ({ id: `update-${route}`, route, fixture: route === "archiver" ? "archiver" : "sample", phase: "motion-freeze", interaction: "update-check" })),
  { id: "contact-reader", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "author-contact" },
  { id: "contact-archiver", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "author-contact" },
  { id: "features-welcome", route: "welcome", fixture: "sample", phase: "motion-freeze", interaction: "features-document" },
  { id: "features-reader", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "features-document" },
  { id: "features-archiver", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "features-document" },
  ...(guideCapture ? ["welcome", "archiver", "reader", "time-cover"].map(route => ({ id: `guide-${route}`, route, fixture: "real", phase: "motion-freeze", interaction: "feature-guide-capture" })) : []),
  { id: "document-refinements-reader", route: "reader", fixture: "real", phase: "motion-freeze", interaction: "document-refinements" },
  { id: "document-refinements-archiver", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "document-refinements" },
  { id: "bookmark-doc-reader", route: "reader", fixture: "real", phase: "motion-freeze", interaction: "bookmark-document" },
  { id: "bookmark-doc-archiver", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "bookmark-document" },
  { id: "license-reader", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "license-document" },
  { id: "license-archiver", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "license-document" },
  { id: "history-reader", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "history-document" },
  { id: "history-archiver", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "history-document" },
  { id: "standard-reader", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "standard-document" },
  { id: "standard-archiver", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "standard-document" },
  { id: "reader-nested-process", route: "conversation", fixture: "real", phase: "motion-freeze", interaction: "nested-process" },
  { id: "reader-schedule", route: "conversation", fixture: "real", phase: "motion-freeze", interaction: "schedule-cards" },
  { id: "reader-map", route: "conversation", fixture: "real", phase: "motion-freeze", interaction: "saved-map" },
  { id: "reader-works", route: "conversation", fixture: "real", phase: "motion-freeze", interaction: "saved-works" },
  { id: "reader-cards", route: "conversation", fixture: "real", phase: "motion-freeze", interaction: "saved-cards" },
  { id: "reader-summaries", route: "conversation", fixture: "real", phase: "motion-freeze", interaction: "summary-sequences" },
  { id: "archiver-record-compatibility", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "record-compatibility" },
  { id: "welcome", route: "welcome", fixture: "sample", phase: "start", referencePhase: { dawn: "second", "star-night": "start" } },
  { id: "reader-cover", route: "reader", fixture: "sample", phase: "motion-freeze" },
  { id: "reader-directory-fonts", route: "reader", fixture: "real", phase: "motion-freeze", interaction: "feature-guide-capture", directoryFonts: true },
  { id: "reader-time-compatibility", route: "reader", fixture: "real", phase: "motion-freeze", interaction: "time-compatibility" },
  { id: "reader-row-menu", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "reader-row-menu" },
  { id: "reader-title-hover", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "title-hover" },
  { id: "reader-empty", route: "reader", fixture: "empty", phase: "motion-freeze" },
  { id: "reader-conversation", route: "conversation", fixture: "sample", phase: "motion-freeze" },
  { id: "reader-catalog-open", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "reader-catalog-open" },
  ...["short", "medium", "long"].map(titleCase => ({ id: `reader-title-${titleCase}`, route: "conversation", fixture: "sample", phase: "motion-freeze", titleCase })),
  { id: "reader-model-tags", route: "conversation", fixture: "sample", phase: "motion-freeze", titleCase: "models" },
  { id: "archiver", route: "archiver", fixture: "archiver", phase: "motion-freeze" },
  { id: "archiver-column-alignment", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "archive-column-alignment" },
  ...(captureJson ? [{ id: "archiver-capture-time", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "source-capture-time" }] : []),
  { id: "archiver-workflow-normal", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "workflow-normal" },
  { id: "archiver-missing-records", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "missing-records" },
  { id: "archiver-splitter", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "archive-splitter" },
  { id: "archiver-seasons", route: "archiver", fixture: "archiver", phase: "live", motion: "rooster" },
  { id: "archiver-theme-roundtrip", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "theme-roundtrip" },
  { id: "archiver-time-field", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "archive-time-field" },
  { id: "archiver-parse-settings", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "parse-settings" },
  { id: "archiver-empty-parse-settings", route: "archiver", fixture: "empty", phase: "motion-freeze", interaction: "parse-settings" },
  { id: "archiver-doc-navigation", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "docs-navigation" },
  { id: "archiver-title-hover", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "title-hover" },
  { id: "archiver-information", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "archive-information" },
  { id: "archiver-external-refresh", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "external-refresh" },
  { id: "archiver-batch-delete", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "batch-delete" },
  { id: "archiver-parse-batch", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "parse-batch" },
  { id: "archiver-parse-destination", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "parse-destination" },
  { id: "archiver-parse-settings-directory", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "parse-settings-directory" },
  { id: "archiver-editor-modal", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "info-modal" },
  { id: "archiver-bookmark-install", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "bookmark-install" },
  { id: "reader-theme-roundtrip", route: "reader", fixture: "sample", phase: "motion-freeze", interaction: "theme-roundtrip" },
  { id: "welcome-theme-roundtrip", route: "welcome", fixture: "sample", phase: "start", interaction: "theme-roundtrip" },
  { id: "welcome-startup", route: "welcome", fixture: "sample", phase: "start", interaction: "startup" },
  { id: "archiver-empty", route: "archiver", fixture: "empty", phase: "motion-freeze" },
  { id: "archiver-bookmarks-expanded", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "bookmarks-expanded" },
  { id: "archiver-profile-hover", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "bookmark-profile-hover" },
  { id: "archiver-bookmark-version", route: "archiver", fixture: "archiver", phase: "motion-freeze", interaction: "bookmark-version-hover" },
  { id: "claude-container", route: "claude", fixture: "archiver", phase: "motion-freeze" },
  { id: "platform-json-entry", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "platform-json", jsonPlatform: "index" },
  { id: "platform-import-guide", route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "platform-json", jsonPlatform: "index", jsonGuide: true },
  ...["codex"].map(platform => ({ id: `platform-json-${platform}`, route: "archiver", fixture: "real", phase: "motion-freeze", interaction: "platform-json", jsonPlatform: platform })),
  { id: "claude-settings", route: "claude", fixture: "archiver", phase: "motion-freeze", interaction: "claude-settings" },
  { id: "claude-parse-roundtrip", route: "claude", fixture: "real", phase: "motion-freeze", interaction: "claude-parse" },
  { id: "claude-title-hover", route: "claude", fixture: "archiver", phase: "motion-freeze", interaction: "title-hover" },
  { id: "identity-global", route: "identity-editor", fixture: "sample", phase: "motion-freeze" },
  { id: "identity-save-roundtrip", route: "identity-editor", fixture: "real", phase: "motion-freeze", interaction: "identity-save" },
  { id: "identity-conversation", route: "identity-conversation", fixture: "sample", phase: "motion-freeze" },
  { id: "conversation-info", route: "conversation-info", fixture: "sample", phase: "motion-freeze" },
  { id: "conversation-info-endpoints", route: "conversation-info", fixture: "sample", phase: "motion-freeze", interaction: "info-endpoints" },
  { id: "conversation-info-parser-history", route: "conversation-info", fixture: "sample", phase: "motion-freeze", interaction: "parser-history" },
  { id: "conversation-info-timezone", route: "conversation-info", fixture: "sample", phase: "motion-freeze", interaction: "timezone" },
  { id: "conversation-info-fuzzy", route: "conversation-info", fixture: "sample", phase: "motion-freeze", interaction: "info-fuzzy" },
  { id: "conversation-info-sovereign", route: "conversation-info", fixture: "sample", phase: "motion-freeze", interaction: "info-sovereign" },
  { id: "time-cover", route: "time-cover", fixture: "sample", phase: "motion-freeze" },
  { id: "time-cover-empty", route: "time-cover", fixture: "sample", phase: "empty" },
  { id: "time-editor-timeline", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "timeline" },
  { id: "time-editor-time", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "time" },
  { id: "time-editor-create-timeline", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "create-timeline" },
  { id: "time-editor-create-time", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "create-time" },
  { id: "time-save-roundtrip", route: "time-editor", fixture: "real", phase: "motion-freeze", editor: "create-time", interaction: "time-save" },
  { id: "time-editor-mapping", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "timeline", interaction: "mapping" },
  { id: "time-editor-timezone", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "timeline", interaction: "timezone-mapping" },
  { id: "time-editor-relative", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "timeline", interaction: "relative" },
  { id: "time-editor-counterpart", route: "time-editor", fixture: "sample", phase: "motion-freeze", editor: "time", interaction: "counterpart" },
  { id: "system-log", route: "system-log", fixture: "sample", phase: "motion-freeze" }
];
const quickSurfaceIds = new Set(["welcome", "reader-cover", "reader-conversation", "archiver", "archiver-empty", "claude-container", "identity-global", "conversation-info", "time-cover", "time-editor-timeline", "time-editor-time", "time-editor-create-timeline", "time-editor-create-time", "system-log"]);
const selectedSurfaces = requestedSurface !== null
  ? surfaces.filter((surface) => requestedSurface.split(",").includes(surface.id))
  : quick ? surfaces.filter((surface) => quickSurfaceIds.has(surface.id)) : surfaces.filter(surface => !surface.id.startsWith("english-") && !["reader-nested-process", "reader-schedule", "reader-time-compatibility", "archiver-external-refresh", "archiver-batch-delete", "time-save-roundtrip", "identity-save-roundtrip", "claude-parse-roundtrip", "archiver-parse-destination", "archiver-parse-settings-directory"].includes(surface.id));
if (selectedSurfaces.some(surface => surface.interaction === "english-layout") && (!recordUi || requestedLanguage !== "en")) throw new Error("English layout audit requires --record-ui --language en");
if (selectedSurfaces.some(surface => ["archiver-external-refresh", "archiver-batch-delete"].includes(surface.id)) && !realSample) throw new Error("Destructive audit requires --real-sample for an isolated Library");
if (selectedSurfaces.length === 0) throw new Error(`Unknown --surface value: ${requestedSurface}`);
const emptyRecordSurfaces = new Set(["reader-empty", "archiver-empty", "archiver-empty-parse-settings", "time-cover-empty"]);
if (selectedSurfaces.some(surface => surface.id === "archiver-capture-time") && !captureJson) throw new Error("Capture-time journey requires its real container input");
const emptyRecordUi = recordUi && selectedSurfaces.every(surface => emptyRecordSurfaces.has(surface.id));
if (recordUi && !emptyRecordUi && selectedSurfaces.some(surface => emptyRecordSurfaces.has(surface.id))) throw new Error("Run empty-Library surfaces separately from populated ones");
if (recordUi && selectedSurfaces.some(surface => !["welcome", "reader", "conversation", "archiver", "identity-editor", "identity-conversation", "conversation-info", "system-log", "claude", "time-cover", "time-editor"].includes(surface.route))) throw new Error("--record-ui needs a production route supported by the owned synthetic Library");
if (selectedSurfaces.some(surface => surface.id === "time-save-roundtrip") && !recordUi) throw new Error("Time save roundtrip requires --record-ui");
if (selectedSurfaces.some(surface => surface.id === "identity-save-roundtrip") && !recordUi) throw new Error("Identity save roundtrip requires --record-ui");
if (selectedSurfaces.some(surface => surface.id === "reader-time-compatibility") && !recordUi) throw new Error("Time compatibility roundtrip requires --record-ui");
if (selectedSurfaces.some(surface => surface.id === "claude-parse-roundtrip") && !recordUi) throw new Error("Claude parse roundtrip requires --record-ui");
if (selectedSurfaces.some(surface => surface.id === "archiver-missing-records") && !recordUi) throw new Error("Missing-record roundtrip requires --record-ui");
if (selectedSurfaces.some(surface => ["archiver-parse-destination", "archiver-parse-settings-directory"].includes(surface.id)) && !recordUi) throw new Error("Parse destination roundtrip requires --record-ui");
const rows = [];
let sourceEvidence = null;
let readerBoundary = null;

async function prepareReaderBoundary() {
  // Direct JSON's existing branch-only journey intentionally has no full-scroll
  // claim. Do not attach an unverified completion boundary to that evidence.
  if (!realFixture || realConversation && !readerResources || !selectedSurfaces.some(surface => surface.id === "reader-conversation")) return;
  const { startRecordEngine } = await import("./record-engine-client.mjs");
  const engine = startRecordEngine({ packageRoot: path.dirname(executable), libraryRoot: path.join(outputRoot, "Library") });
  let token;
  try {
    const catalog = await engine.request("reader.archives.query", { offset: 0, limit: 1 });
    assert.equal(catalog.items.length, 1, "Reader boundary requires a real archive");
    const request = { messages: { offset: 0, limit: 1 }, navigation: { offset: 0, limit: 1 }, branches: { offset: 0, limit: 1 } };
    const opened = await engine.request("reader.view.open", { archive: catalog.items[0].capability, request });
    token = opened.token;
    const runtime = (await engine.request("engine.storage")).runtime_root;
    const page = async descriptor => {
      assert.match(descriptor.virtual_path, /^\/v_[\w-]+\/pages\/[\w.-]+\.json$/u);
      return JSON.parse(await readFile(path.join(runtime, "Views", descriptor.virtual_path.slice(1)), "utf8"));
    };
    const first = await page(opened.page);
    request.messages.offset = Math.max(0, first.pagination.total_visible - 1);
    request.navigation.offset = Math.max(0, first.navigation.total - 1);
    const last = await page(await engine.request("reader.view.page", { view: token, request }));
    readerBoundary = {
      messages: first.pagination.total_visible,
      last_message: last.messages.at(-1)?.anchor ?? null,
      navigation: first.navigation.total,
      last_navigation: last.navigation.items.at(-1)?.anchor ?? null
    };
    sourceEvidence.reader_boundary = readerBoundary;
    console.log(`Reader default path: ${readerBoundary.messages} messages; ${readerBoundary.navigation} navigation entries`);
  } finally {
    try { if (token) await engine.request("reader.view.close", { view: token }); }
    finally { await engine.close(); }
  }
}

async function recordGraphFacts(root, relative) {
  const { readStoredConversationMetadata } = await import("../src/adapters/storage/record-store.mts");
  const { value } = await readStoredConversationMetadata(root, relative);
  const children = new Map();
  for (const message of value.messages.items) if (typeof message.parent === "string") children.set(message.parent, (children.get(message.parent) ?? 0) + 1);
  return { platform: value.platform, profile: value.source.profile, messages: value.messages.items.length, contentful_messages: value.messages.items.filter(message => message.content.length > 0).length, branch_points: [...children.values()].filter(count => count > 1).length };
}

async function prepareRealLibrary() {
  const { createRecordLibrary } = await import("../src/adapters/library-data/record-library.mts");
  const { fingerprintFile } = await import("../src/adapters/storage/index.mts");
  const root = path.join(outputRoot, "Library");
  const timestamp = new Date().toISOString();
  if (recordUi) {
    const { startRecordEngine } = await import("./record-engine-client.mjs");
    await mkdir(root);
    const engine = startRecordEngine({ packageRoot: path.dirname(executable), libraryRoot: root });
    try {
      await engine.request("library.create");
      if (claudeSource) {
        const { fingerprintFile } = await import("../src/adapters/storage/stream.mts");
        const original = await fingerprintFile(path.resolve(claudeSource));
        const importedSource = /\.zip$/iu.test(claudeSource) ? 'Inbox/conversations.zip' : 'Inbox/conversations.json';
        await copyFile(path.resolve(claudeSource), path.join(root, importedSource));
        const rows = await engine.request("archiver.sources.query", { offset: 0, limit: 200 });
        const indexed = await engine.request("archiver.claude.index", { source: rows.items[0].capability });
        const records = await engine.request("archiver.claude.records.query", { container: indexed.container, offset: 0, limit: 200 });
        if (parserStatus) {
          const { indexRecordOfficialContainer, extractIndexedOfficialRecord } = await import('../src/adapters/parser/record-official-index.mts');
          const { assembleConversationRecord } = await import('../src/app/parser/conversation-record.mts');
          const { savePreparedRecord } = await import('../src/adapters/library-data/record-parser-commit.mts');
          const { PARSER_VERSION } = await import('../src/app/parser/registry.mts');
          const nativeIndex = (await indexRecordOfficialContainer(root, importedSource)).index;
          const originals = [...nativeIndex.records].filter(r => r.messages > (r.empty_messages ?? 0)).sort((a,b) => a.length-b.length).slice(0,2);
          assert.equal(originals.length, 2);
          for (const [i, record] of originals.entries()) {
            const conversation = assembleConversationRecord({ ...await extractIndexedOfficialRecord(root, nativeIndex, record.selector), timestamp, parserVersion: PARSER_VERSION });
            if (i === 0) conversation.parser.adapter.version = '0.0.1';
            await savePreparedRecord(root, { conversation, sourcePath: importedSource });
          }
          const updated = await engine.request('archiver.claude.records.query', { container: indexed.container, offset: 0, limit: 200 });
          assert.equal(updated.statuses.update, 1); assert.equal(updated.statuses.parsed, 1); assert.equal(updated.statuses.ready, records.total - 2);
        } else if (officialSourceIndex >= 0) assert(records.items.length > 0);
        else assert(records.items.some(row => row.empty_messages > 0 && row.empty_messages === row.messages));
        assert.deepEqual(await fingerprintFile(path.resolve(claudeSource)), original);
        sourceEvidence = { kind: parserStatus ? "real-official-partial-parse-with-old-adapter-fixture" : officialSourceIndex >= 0 ? "real-official-index-through-packaged-engine" : "real-Claude-empty-record-index-through-packaged-engine", source: original, records: records.total, source_unchanged: true };
        return;
      }
      if (emptyRecordUi) { sourceEvidence = { kind: "empty-library-through-packaged-record-engine", html: 0, claude_records: 0, custom_time_nodes: 0 }; return; }
      await copyFile(path.resolve(guideCapture ? "src/ui/documents/examples/html/ChatGPT-整树-Chat.html" : "tests/fixtures/chatgpt-light-items-v2.html"), path.join(root, "Inbox", guideCapture ? "My first archive.html" : "视觉校验.html"));
      await writeFile(path.join(root, "Inbox", "conversations.json"), JSON.stringify([
        { uuid: "visual-claude-tree", name: "Claude UI · 分支与选择", created_at: "2026-06-16T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", chat_messages: [
          { uuid: "u", sender: "human", text: "Question" }, { uuid: "a", parent_message_uuid: "u", sender: "assistant", text: "First branch" }, { uuid: "b", parent_message_uuid: "u", sender: "assistant", text: "Second branch" }
        ] },
        { uuid: "visual-claude-empty", name: "Claude UI · 尚未解析", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", chat_messages: [] }
      ]));
      const plan = await engine.request("archiver.parse.plan", { sources: [], one_click: true });
      assert.equal(plan.total, 1); assert.equal((await engine.request("archiver.parse.commit", { plan: plan.plan })).completed, 1);
      if (captureJson) {
        const { fingerprintFile } = await import("../src/adapters/storage/stream.mts");
        const { recordImportOriginPath } = await import("../src/adapters/library-data/record-source-import.mts");
        const fingerprint = await fingerprintFile(path.resolve(captureJson));
        await mkdir(path.join(root, "appdata/imports"), { recursive: true });
        // Replace only this owned synthetic container; the actual source stays read-only.
        for (const [name, at] of [["conversations.json", "1980-01-01T00:00:00Z"], ["Older.json", "2024-01-02T00:00:00Z"], ["Newer.json", "2026-01-02T00:00:00Z"]]) {
          const relative = `Inbox/${name}`, target = path.join(root, relative); await copyFile(path.resolve(captureJson), target);
          await utimes(target, new Date("1980-01-01T00:00:00Z"), new Date("1980-01-01T00:00:00Z"));
          await writeFile(path.join(root, recordImportOriginPath(relative)), JSON.stringify({ schema: "cloudig/source-import/1.0.0", path: relative, sha256: fingerprint.sha256, captured: { at, from: "filesystem:last_write_time" } }));
        }
        const rows = await engine.request("archiver.sources.query", { offset: 0, limit: 200, sort: "captured_asc" });
        const capturedAt = new Date((await stat(path.join(root, "Inbox/conversations.json"))).birthtimeMs).toISOString();
        assert.equal(rows.items.at(-1).filename, "conversations.json"); assert.equal(rows.items.at(-1).captured_at, capturedAt);
        assert.equal(rows.items.at(-1).captured_from, "filesystem:creation_time");
        const container = await engine.request("archiver.claude.index", { source: rows.items.at(-1).capability });
        assert.equal(container.source.captured_at, capturedAt);
        const records = await engine.request("archiver.claude.records.query", { container: container.container, offset: 0, limit: 200 });
        const preview = await engine.request("archiver.claude.extract.preview", { container: container.container, selectors: [records.items[0].selector] });
        const result = await engine.request("archiver.claude.extract.commit", { plans: [preview.plan] }); assert.equal(result.completed, 1);
        const conversation = JSON.parse(await readFile(path.join(root, result.items[0].path), "utf8"));
        assert.equal(conversation.source.captured_at, capturedAt); assert.equal(conversation.source.captured_from, "filesystem:creation_time");
        assert.equal((await fingerprintFile(path.resolve(captureJson))).sha256, fingerprint.sha256);
        sourceEvidence = { kind: "real-Claude-container-capture-time-through-packaged-engine", source: fingerprint, records: records.total, parsed: 1, capture: capturedAt, captured_from: "filesystem:creation_time", source_unchanged: true, remaining_ui_fixture: "ChatGPT synthetic" };
        return;
      }
      if (guideCapture) {
        await copyFile(path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), path.join(root, "Inbox", "准备收藏的对话.html"));
        const { updateRecordSystemLog } = await import("../src/adapters/library-data/record-system-log.mts");
        await updateRecordSystemLog(root, [{ path: "Inbox/准备收藏的对话.html", recorded_at: timestamp, errors: [{ source: "exporter", code: "DEMO_ONLY", message: "演示记录 / Demonstration only: an image could not be downloaded." }] }]);
      }
      if (selectedSurfaces.some(surface => surface.id === "archiver-workflow-normal"))
        await copyFile(path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), path.join(root, "Inbox", "待解析颜色检查.html"));
      if (selectedSurfaces.some(surface => surface.id === "archiver-missing-records")) {
        for (const file of ["Missing-A.txt", "Missing-B.txt"]) await writeFile(path.join(root, "Inbox", file), "owned missing-record fixture");
        await engine.request("archiver.sources.query", { offset: 0, limit: 200 });
        for (const file of ["Missing-A.txt", "Missing-B.txt", "视觉校验.html"]) await rm(path.join(root, "Inbox", file));
      }
      for (const metadata of [
        { kind: "timeline", name: "星河纪元", author: "晨星", standard_name: null, version: "1.2" },
        { kind: "single", name: "初见" },
        { kind: "periodic", name: "月相", count: 12, prefix: null, unit: null, display_empty: false }
      ]) {
        const cover = await engine.request("time.cover.query", { return_to: "reader-cover" });
        const preview = await engine.request("time.editor.preview", { route: cover.route, action: metadata.kind === "timeline" ? "create_timeline" : "create_time", draft: { metadata, children: [], counterparts: [], mappings: [] } });
        await engine.request("time.editor.commit", { plan: preview.plan, strategy: "in_place", selected_references: [] });
      }
      sourceEvidence = { kind: "synthetic-ui-data-through-packaged-record-engine", html: 1, claude_records: 2, custom_time_nodes: 3, actual_chrome_excluded: true };
    } finally { await engine.close(); }
    return;
  }
  await createRecordLibrary(root, { timestamp, anchor: { date: timestamp.slice(0, 10), offset: "Z" }, language: "zh-CN" });
  if (batchSamples) {
    const directory = path.resolve(batchSamples), files = [];
    for (const filename of (await readdir(directory)).filter(file => /\.html$/iu.test(file)).sort()) {
      const source = path.join(directory, filename);
      await copyFile(source, path.join(root, "Inbox", filename));
      files.push({ filename, ...await fingerprintFile(source) });
    }
    assert.ok(files.length > 0);
    sourceEvidence = { kind: "real-wpf-parse-batch", files };
    return;
  }
  if (diagramGallery || realConversation) {
    const { validateRecord, parseRecordJson } = await import("../src/core/records/index.mts");
    const source = path.resolve(diagramGallery ?? realConversation), bytes = await readFile(source);
    const target = path.join(root, "Conversations", path.basename(source));
    await writeFile(target, bytes);
    assert.equal(validateRecord("conversation", parseRecordJson(bytes.toString("utf8"))).ok, true, "Visual source must use the current Conversation Schema");
    sourceEvidence = { kind: realConversation ? "real-conversation-copy" : "derived-diagram-gallery-not-source-journey", file: path.basename(source), ...await fingerprintFile(source), ...await recordGraphFacts(root, `Conversations/${path.basename(source)}`) };
    if (sourceEmpty) assert.equal(sourceEvidence.contentful_messages, 0, "Empty-source audit must use a verified wholly empty original, not hide real branch content");
    if (searchCompanions) {
      const { prepareSearchAudit } = await import("./prepare-search-audit.mts");
      sourceEvidence.search = await prepareSearchAudit(root, outputRoot, source, searchCompanions, path.dirname(executable));
    }
    return;
  }
  const source = path.resolve(realSample);
  const fingerprint = await fingerprintFile(source);
  const count = selectedSurfaces.some(surface => surface.id === "archiver-batch-delete") ? 3 : 1;
  for (let index = 0; index < count; index++) {
    await copyFile(source, path.join(root, "Inbox", index ? `batch-${index}-${path.basename(source)}` : path.basename(source)));
  }
  const { startRecordEngine } = await import("./record-engine-client.mjs");
  const engine = startRecordEngine({ packageRoot: path.dirname(executable), libraryRoot: root });
  try {
  const listed = await engine.request("archiver.sources.query", { offset: 0, limit: 200 });
  assert.equal(listed.items.length, count);
  const plan = await engine.request("archiver.parse.plan", { sources: listed.items.map(item => item.capability) });
  const result = await engine.request("archiver.parse.commit", { plan: plan.plan });
  assert.equal(result.state, "completed");
  assert.equal(result.items.filter(item => item.status === "created").length, count, JSON.stringify(result));
  sourceEvidence = { kind: "real-html-through-packaged-record-engine", file: path.basename(source), ...fingerprint, archive_status: "created", ...await recordGraphFacts(root, result.items[0].path) };
  if (count === 3) {
    const archives = await engine.request("reader.archives.query", { offset: 0, limit: 3 });
    const archive = archives.items[0].capability;
    const info = await engine.request("reader.archive.info.query", { archive });
    const draft = structuredClone(info.draft);
    draft.conversation_name = { state: "set", value: "Owned recycle verification Mark" };
    await engine.request("reader.archive.info.commit", { archive, expected_conversation: info.revision.conversation, expected_mark: info.revision.mark, draft, touch_on_noop: false });
    assert.equal((await readdir(path.join(root, "Marks"))).filter(file => file.endsWith(".json")).length, 1);
    sourceEvidence.prepared_mark_files = 1;
  }
  } finally { await engine.close(); }
}

function exactGeometry(value, expected, label) {
  assert.ok(value && typeof value === "object", `${label} geometry is missing`);
  // Blink quantizes layout to 1/64 CSS px; fractional native zoom adds one
  // final rounding step. This remains far below one physical display pixel.
  for (const key of ["width", "height", "x", "y"]) assert.ok(Math.abs(value[key] - expected[key]) <= .05, `${label} ${key} drifted: ${value[key]} vs ${expected[key]}`);
}

function verifyArchiverScene(scene) {
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < .15, `${label}: ${actual} vs ${expected}`);
  near(scene.scene.left, scene.center.left, "Panorama left edge");
  near(scene.scene.right, scene.center.right, "Panorama right edge");
  near(scene.scene.bottom, scene.center.bottom, "Panorama bottom edge");
  near(scene.information_height, scene.scene.height, "List reservation follows intrinsic art height");
  assert.equal(scene.images.length, 2);
  for (const [index, image] of scene.images.entries()) {
    near(image.box.left, scene.center.left, "Shared image origin");
    near(image.box.width, scene.center.width, "Panorama must fill the center width");
    near(image.box.height, scene.center.width * (image.file.startsWith("Wave-") ? 117.88 : 120) / 1272, "SVG intrinsic aspect ratio");
    near(image.box.bottom, scene.center.bottom, "Image bottom anchor");
    const percentages = [...image.clip.matchAll(/(-?[\d.]+)%/gu)].map(match => Number(match[1]));
    assert.equal(percentages.length, 1, `Expected one moving clip edge: ${image.clip}`);
    near(percentages[0], (index === 0 ? 1 - scene.ratio : scene.ratio) * 100, "Clip edge follows splitter");
  }
  near(scene.workspaces[0].width, scene.center.width * scene.ratio, "Parser width");
  near(scene.workspaces[1].left, scene.workspaces[0].right, "Workspace boundary");
  for (const [index, list] of scene.lists.entries()) {
    near(list.bottom + scene.gap, scene.scene.top, "List-to-scene gap");
    near(scene.decorations[index].left, scene.workspaces[index].left, "Decoration stays with its workspace");
    near(scene.decorations[index].width, scene.workspaces[index].width, "Decoration coordinate width");
  }
  assert.equal(scene.dragging, false, "Pointer capture must end after the drag");
  for (const control of scene.controls ?? []) assert.ok(control.inside && control.hit, `A dragged header control is clipped or overlapped: ${JSON.stringify(control)}`);
}

function assertSurfaceGeometry(surface, viewport, page, viewportScale = 1) {
  if (surface.interaction === "search-copy" && !searchEntryOnly) surface = { ...surface, id: "reader-search-copy", route: "conversation" };
  const routes = {
    welcome: /^welcome$/u, reader: /^reader\/cover$/u,
    conversation: /^reader\/conversation\/[^/]+$/u,
    archiver: /^archiver$/u, claude: /^archiver\/claude$/u,
    "identity-editor": /^welcome$/u, "identity-conversation": /^reader\/cover$/u,
    "conversation-info": /^conversation\/info\/[^/]+$/u,
    "time-cover": /^time\/cover\//u, "time-editor": /^time\/(node|timeline)\//u,
    "system-log": /^system\/log$/u
  };
  assert.match(page.route ?? "", routes[surface.id === "features-welcome" ? "archiver" : surface.interaction === "reader-catalog-open" ? "conversation" : ["parse-destination", "parse-settings-directory"].includes(surface.interaction) ? "claude" : surface.route], `${surface.id} opened the wrong route`);
  assert.equal(page.ready, true);
  assert.equal(page.boot_state, "ready");
  assert.equal(page.runtime_errors, 0);
  if (surface.interaction === "search-copy" && searchEntryOnly) return; // native entry geometry/pointer checks; no unrelated clipboard journey
  if (surface.interaction === "platform-json") return; // dedicated native pointer/geometry probe for this central preview
  // This flow replaces only the central content. Its actual central geometry,
  // sidebar invariance, disclosure and return are verified by the native probe.
  if (["standard-document", "history-document", "license-document", "bookmark-document", "features-document", "document-refinements", "feature-guide-capture"].includes(surface.interaction)) return;
  if (["conversation-info", "time-cover", "time-editor"].includes(surface.route)) assert.equal(page.surface, "reader", "Reader-hosted overlays must retain their Reader titlebar palette");
  if (surface.route === "conversation" || surface.interaction === "reader-catalog-open") {
    assert.equal(page.conversation_ready, true, "Reader controller did not mount");
    if (!realFixture) assert.ok(page.math_struts > 0, "the offline math layout fixture was not rendered");
    assert.equal(page.math_unstyled, 0, "CSP blocked generated KaTeX layout styles");
  }
  const bodyHeight = viewport.height - 48;
  const geometry = page.geometry ?? {};
  if (surface.route === "archiver" && geometry.archiver_bookmark_profile) {
    const profile = geometry.archiver_bookmark_profile, action = geometry.archiver_bookmark_all;
    assert.ok(Math.abs(profile.height - 52) <= .05, "Bookmark choice plate must remain 52px high");
    assert.ok(Math.abs(action.height - 28) <= .05, "Install-all is an inset 28px button, not a stretched grid cell");
    assert.ok(profile.x + profile.width - action.x - action.width >= 10, "Install-all lost the designed right inset");
    if (viewport.width === 1920) { assert.equal(profile.width, 306); assert.ok(Math.abs(action.width - 96.58) < .03); }
    assert.ok(geometry.archiver_bookmark_caption.height <= 32, "A third caption line returned to the bookmark list");
    assert.ok(Math.abs(geometry.archiver_bookmark_icon.width - 32) <= .05); assert.ok(Math.abs(geometry.archiver_bookmark_icon.height - 32) <= .05);
  }
  if (surface.id.startsWith("reader-")) {
    // The conversation resize journey crosses the narrow layout, whose existing
    // controller collapses the catalog and retains that state on return.
    // Returning to a wide window must not silently change that catalog choice.
    const returnedCollapsed = resizeRoundtrip && (surface.id === "reader-conversation" || ["saved-map", "saved-works", "saved-cards"].includes(surface.interaction));
    const catalog = viewport.width <= 1280 || returnedCollapsed ? 48 : Math.min(400, Math.max(320, viewport.width * .166667 + 80));
    const navigation = Math.min(248, Math.max(216, viewport.width * .066667 + 120));
    const tracks = { catalog, main: viewport.width - catalog - navigation, navigation };
    // Opening a row menu explicitly expands the narrow catalog as an overlay;
    // its 320px surface must not resize the 48px grid track beneath it.
    const catalogWidth = viewport.width === 1280 && surface.interaction === "reader-row-menu" ? 320 : tracks.catalog;
    exactGeometry(geometry.reader_catalog, { x: 0, y: 48, width: catalogWidth, height: bodyHeight }, "Reader Catalog");
    exactGeometry(geometry.reader_main, { x: tracks.catalog, y: 48, width: tracks.main, height: bodyHeight }, "Reader Main");
    exactGeometry(geometry.reader_navigation, { x: tracks.catalog + tracks.main, y: 48, width: tracks.navigation, height: bodyHeight }, "Reader navigation");
    if (surface.route === "conversation" || surface.interaction === "reader-catalog-open") {
      assert.ok(Math.abs(geometry.reader_title?.width - tracks.main) <= .05, "Reader title width drifted");
      assert.ok(Math.abs(geometry.reader_toolbar?.width - tracks.main) <= .05, "Reader toolbar width drifted");
      // A one-message external file may not need a vertical scrollbar. The
      // designed column has 40px margins; only overflowing content spends the
      // additional 8px on the existing custom scrollbar. Do not force a gutter
      // into a valid short conversation just to satisfy the long-fixture test.
      const column = geometry.reader_message_column;
      // Pointer journeys can finish near the end of a conversation. Its
      // viewport-relative y then becomes negative; that is not evidence that
      // the 30,000px-long document suddenly stopped needing a scrollbar.
      const columnTop = Math.max(column.y, geometry.reader_toolbar.y + geometry.reader_toolbar.height);
      const hasBodyOverflow = columnTop + column.height + 84 > viewport.height + .5;
      assert.ok(Math.abs(column.width - Math.min(900, tracks.main - 40 - (hasBodyOverflow ? 8 : 0))) <= .05, "Reader message column width drifted");
      const layout = page.reader_title_layout;
      assert.ok(layout, "Reader title measurement is absent");
      const expected = layout.natural_width <= layout.l1 + .5 ? "body" : layout.natural_width <= layout.l2 + .5 ? "center" : "wrap";
      assert.equal(layout.mode, expected);
      assert.equal(layout.align, expected === "center" ? "center" : "left");
      assert.equal(layout.padding_top, layout.padding_bottom);
      assert.ok(layout.horizontal_overflow <= 1, "Reader title text overflowed horizontally");
      assert.ok(layout.vertical_overflow <= 1, "Reader header kept a fixed height and clipped its content");
      assert.ok(layout.content_top_inset >= parseFloat(layout.padding_top) - 1, "Reader tags escaped the header padding");
      assert.ok(layout.content_bottom_inset >= parseFloat(layout.padding_bottom) - 1, "Reader dates escaped the header padding");
      assert.notEqual(layout.rail_background, "rgba(0, 0, 0, 0)");
      assert.notEqual(layout.bird_shadow, "none");
      assert.ok(Math.abs(parseFloat(layout.option_border) - 2) * viewportScale < 1, "The declared 2px outline may only differ by native border pixel snapping");
    }
  }
  const controls = page.input_controls;
  for (const [index, info] of (page.archive_information_layout ?? []).entries()) {
    const scrollTop = page.information_titles?.[index]?.scroll_top ?? 0;
    assert.ok(info.text_top + scrollTop >= info.top - .5, "Archive information must not start above its scroll owner at scroll origin");
    if (info.scroll_height > info.client_height + 1) assert.equal(info.scrollable, true, "Narrow information must stay readable through the shared scrollbar");
    else assert.ok(info.text_bottom <= info.bottom + .5, "Archive information escaped its bottom artwork container");
  }
  if (page.archiver_scene) verifyArchiverScene(page.archiver_scene);
  if (page.claude_layout) {
    assert.equal(page.claude_layout.header_text_fits, true, "Claude count headings must fit their columns without touching each other");
    assert.ok(page.claude_layout.quote_overflow <= 1, "Claude epigraph text escaped its background");
    assert.ok(page.claude_layout.button_left_inset >= 10 && page.claude_layout.button_right_inset >= 10, "Claude one-click label lost its real text inset");
    assert.equal(page.claude_layout.facts_inside, true);
    if (page.claude_layout.menu_below_anchor !== null) {
      assert.equal(page.claude_layout.menu_below_anchor, true);
      assert.equal(page.claude_layout.menu_inside, true);
    }
    assert.ok(Math.abs(page.claude_layout.title_height - 112.2446) < .1, "The illustration horizon moved away from the fixed title boundary");
  }
  if (controls?.parse_note_centers) assert.ok(Math.abs(controls.parse_note_centers[0] - controls.parse_note_centers[1]) < .6, "Parse-settings circle and reminder are not vertically centered");
  for (const choice of controls?.parse_choice_alignment ?? []) {
    assert.equal(choice.align, "center"); assert.equal(choice.margin, "0px");
  }
  if (controls?.time_summary_lines?.length > 1) assert.equal(controls.time_summary_lines[1], "—");
  for (const zone of controls?.timezones ?? []) {
    assert.ok(zone.options > 100, "Timezone select lost its offset choices");
    assert.ok(zone.left >= zone.frame_left - 1 && zone.right <= zone.frame_right + 1, "Timezone select escaped the existing time-input frame");
  }
  if (controls?.navigation_mark) {
    assert.equal(controls.navigation_mark.left, "0px"); assert.equal(controls.navigation_mark.top, "0px");
    assert.ok(Math.abs(parseFloat(controls.navigation_mark.width) - controls.navigation_mark.frame_content_width) <= .05);
    assert.ok(Math.abs(parseFloat(controls.navigation_mark.height) - controls.navigation_mark.frame_content_height) <= .05);
    assert.match(controls.navigation_mark.mask, /data:image\/svg\+xml/u);
  }
  if (["archiver", "archiver-empty", "claude-container", "archiver-theme-roundtrip", "archiver-time-field", "archiver-parse-settings", "archiver-empty-parse-settings", "archiver-doc-navigation"].includes(surface.id)) {
    const address = geometry.archiver_library_address, actions = geometry.archiver_topbar_actions;
    assert.ok(address.x + address.width <= actions.x, "Library controls overlap the right-hand actions");
    for (const key of ["archiver_import_html", "archiver_import_claude"]) {
      const button = geometry[key]; if (button) assert.ok(button.scroll_width <= button.client_width + 1, `${key} text escaped its button`);
    }
    if (geometry.archiver_selected_actions && geometry.archiver_delete_action) {
      const bar = geometry.archiver_selected_actions, last = geometry.archiver_delete_action;
      assert.ok(last.x + last.width <= bar.x + bar.width, "The final Delete action is clipped from the archive action bar");
    }
    const bookmarks = viewport.width > 1600 ? 400 : viewport.width > 1320 ? 320 : 64;
    const docs = viewport.width > 1600 ? 248 : viewport.width > 1320 ? 216 : 200;
    const center = viewport.width - bookmarks - docs;
    const tracks = { bookmarks, center, docs, parser: center * (page.archiver_scene?.ratio ?? .5) };
    exactGeometry(geometry.archiver_bookmarks, { x: 0, y: 48, width: tracks.bookmarks, height: bodyHeight }, "Archiver bookmark rail");
    exactGeometry(geometry.archiver_center, { x: tracks.bookmarks, y: 48, width: tracks.center, height: bodyHeight }, "Archiver center");
    exactGeometry(geometry.archiver_docs, { x: tracks.bookmarks + tracks.center, y: 48, width: tracks.docs, height: bodyHeight }, "Archiver docs rail");
    if (viewport.width === 1920) {
      const themeSuffix = page.theme === "star-night" ? "star_night" : "dawn";
      exactGeometry(geometry[`archiver_brand_title_${themeSuffix}`], { x: 60, y: 8, width: 64.13, height: 32 }, "Archiver brand title");
      exactGeometry(geometry[`archiver_brand_slogan_${themeSuffix}`], { x: 136.13, y: 10, width: 252.14, height: 28 }, "Archiver brand slogan");
      if (surface.id !== "claude-container") {
        const panel = geometry.archiver_bookmark_panel;
        assert.equal(panel?.x, 32.43); assert.equal(panel?.y, 178); assert.equal(panel?.width, 335.15);
        assert.ok(panel.height > 0 && panel.height <= viewport.height - 238, "Bookmark panel must fit its content within the 60px bottom clearance");
        exactGeometry(geometry.archiver_doc_card, { x: 1692, y: 178, width: 208, height: 480 }, "Archiver document card");
      }
      if (surface.id !== "claude-container" && page.theme === "dawn") {
        exactGeometry(geometry.archiver_rock, { x: 1622.09, y: viewport.height - 79.99, width: 297.91, height: 79.99 }, "Archiver rock stage");
      }
    }
    if (surface.id !== "claude-container") {
      if (surface.id === "archiver") assert.equal(geometry.archiver_source_header?.y, geometry.archiver_archive_header?.y, "Both list headers must share the same baseline");
      exactGeometry(geometry.archiver_parser, { x: tracks.bookmarks, y: 48, width: tracks.parser, height: bodyHeight }, "Archiver Parser");
      exactGeometry(geometry.archiver_archive, { x: tracks.bookmarks + tracks.parser, y: 48, width: tracks.center - tracks.parser, height: bodyHeight }, "Archiver archive workspace");
      if (viewport.width === 1920 && page.language === "zh-CN" && surface.interaction !== "archive-splitter") {
        exactGeometry(geometry.archiver_import_html, { x: 549.5, y: 132.41, width: 129.96, height: 28 }, "Archiver HTML import");
        exactGeometry(geometry.archiver_import_claude, { x: 688.85, y: 132.41, width: 157.95, height: 28 }, "Archiver Claude JSON import");
        exactGeometry(geometry.archiver_parse_settings_button, { x: 887.2, y: 133.3, width: 26.2, height: 26.2 }, "Archiver parse settings");
        exactGeometry(geometry.archiver_parse_all, { x: 922.79, y: 132.41, width: 89.21, height: 28 }, "Archiver parse all");
      }
    }
  }
}

function visualQuery(surface, theme, language) {
  const phase = surface.referencePhase?.[theme] ?? surface.phase;
  const query = new URLSearchParams({
    screenshot: "1",
    fixture: realFixture ? "real" : surface.fixture,
    route: surface.route,
    theme,
    language,
    phase
  });
  if (surface.editor) query.set("editor", surface.editor);
  if (surface.titleCase) query.set("title-case", surface.titleCase);
  if (surface.interaction) query.set("interaction", surface.interaction);
  if (surface.jsonPlatform) query.set("json-platform", surface.jsonPlatform);
  if (surface.jsonGuide) query.set("json-guide", "true");
  if (sourcePicker) query.set("source-picker", "true");
  if (searchEntryOnly) query.set("search-entry-only", "1");
  if (surface.directoryFonts) query.set("directory-fonts", "1");
  if (realConversation && !surface.interaction && !minimumLineBoundaries && !readerResources) query.set("interaction", "branch-only");
  if (minimumLineBoundaries) query.set("expected-line-boundaries", String(minimumLineBoundaries));
  if (claudeContext) query.set("claude-context", "1");
  if (sourceEmpty) query.set("source-empty", "1");
  if (claudeSource && (parserStatus || officialSourceIndex < 0)) query.set(parserStatus ? "parser-status" : "claude-empty-source", "1");
  if (indexReopen) query.set("index-reopen", "1");
  if (surface.motion) query.set("motion", surface.motion);
  if (resizeRoundtrip) query.set("resize", "roundtrip");
  if (surface.id === "reader-conversation" && readerBoundary) {
    query.set("expected-messages", String(readerBoundary.messages));
    if (readerBoundary.last_message) query.set("expected-last-message", readerBoundary.last_message);
    if (readerBoundary.last_navigation) query.set("expected-last-navigation", readerBoundary.last_navigation);
  }
  return query.toString();
}

async function launch(executablePath, args, errorFile) {
  const child = spawn(executablePath, args, {
    stdio: "ignore", windowsHide: true,
    env: { ...process.env, DOTNET_BUNDLE_EXTRACT_BASE_DIR: auditExtractRoot }
  });
  let timer;
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Cloudig visual audit timed out: ${path.basename(errorFile, ".error.txt")}`));
    }, args.some(value => /interaction=bookmark-document/u.test(String(value))) ? 300_000 : args.some(value => /expected-messages=|interaction=saved-(?:works|cards)/u.test(String(value))) ? 180_000 : args.some(value => String(value).includes("interaction=parse-batch")) ? 120_000 : 60_000);
  });
  try {
    const result = await Promise.race([exit, timeout]);
    assert.equal(result.signal, null, `Cloudig visual audit exited by ${result.signal}`);
    assert.equal(result.code, 0, `Cloudig visual audit failed${await readFile(errorFile, "utf8").then((value) => `: ${value.trim()}`).catch(() => "")}`);
  } finally {
    clearTimeout(timer);
    // kill() requests termination; wait for it before touching profile/extract
    // files. This also covers timeout, where Promise.race used to return early.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exit;
    }
  }
}

let verified = false;
try {
if (realFixture) await prepareRealLibrary();
await prepareReaderBoundary();
const missingIndexPath = path.join(outputRoot, "Library", "appdata", "indexes", "sources.json");
const missingIndexBaseline = selectedSurfaces.some(surface => surface.id === "archiver-missing-records") ? await readFile(missingIndexPath) : null;
if (requireBranch) assert(sourceEvidence?.branch_points > 0, "The declared branching sample lost all forks or the wrong source profile was selected");
for (const viewport of viewports) {
  for (const language of languages) {
    if (realFixture) {
      // The real Reader resolves default identity names from Library, not from
      // the screenshot URL. Keep both sides on the same locale as normal use.
      const { RecordLibraryEngineCommands } = await import("../src/engine/record-library-commands.mts");
      const commands = new RecordLibraryEngineCommands(path.join(outputRoot, "Library")).handlers();
      const context = { request: "q_visual_locale", signal: new AbortController().signal, emit: async () => {} };
      const current = await commands["library.preferences.query"]({}, context);
      if (current.language !== language) await commands["library.preferences.commit"]({ expected_revision: current.revision, language }, context);
      assert.equal((await commands["library.preferences.query"]({}, context)).language, language);
    }
    for (const theme of themes) {
      for (const surface of selectedSurfaces) {
        if ((recordUi && (surface.interaction === "english-layout" || ["archiver-parse-settings-directory", "archiver-capture-time"].includes(surface.id))) || surface.interaction === "search-copy") {
          // Real settings/navigation reload Library preferences; screenshot-only theme overrides are insufficient.
          const { RecordLibraryEngineCommands } = await import("../src/engine/record-library-commands.mts");
          const commands = new RecordLibraryEngineCommands(path.join(outputRoot, "Library")).handlers();
          const context = { request: "q_visual_settings_theme", signal: new AbortController().signal, emit: async () => {} };
          const current = await commands["library.preferences.query"]({}, context);
          if (current.theme !== theme || surface.id === "archiver-capture-time") await commands["library.preferences.commit"]({ expected_revision: current.revision, theme, ...(surface.id === "archiver-capture-time" ? { workflow_parser: { sort: "time_desc" } } : {}) }, context);
        }
        // The prior scenario really cleared the records. Restore only this
        // owned fixture's observation index after its process has exited.
        if (surface.id === "archiver-missing-records") await writeFile(missingIndexPath, missingIndexBaseline);
        const stem = `${surface.id}__${theme}__${language}__${viewport.width}x${viewport.height}`;
        const output = path.join(outputRoot, `${stem}.png`);
        const errorFile = path.join(outputRoot, `${stem}.error.txt`);
        await launch(executable, [
          "--library-root", path.join(outputRoot, "Library"),
          "--visual-audit-output", output,
          "--visual-audit-query", visualQuery(surface, theme, language),
          "--visual-audit-width", String(viewport.width),
          "--visual-audit-height", String(viewport.height)
        ], errorFile);
        const nativeTrace = await readFile(output.replace(/\.png$/u, ".trace.txt"), "utf8");
        if (minimumLineBoundaries) {
          const layout = JSON.parse(await readFile(output.replace(/\.png$/u, ".text-layout.json"), "utf8"));
          assert.ok(layout.boundaries >= minimumLineBoundaries, "No vacuous pass: the real source must expose the expected user line boundaries");
          assert.equal(layout.collapsed.length, 0, "Authored user line boundaries must have distinct rendered Y coordinates");
        }
        if (surface.interaction === "search-copy") assert.match(nativeTrace, searchEntryOnly ? /search-entry-pointer-passed/u : /search-copy-pointer-passed/u);
        if (surface.interaction === "saved-map") assert.match(nativeTrace, /reader-saved-map-pointer-passed/u);
        if (surface.interaction === "saved-works") assert.match(nativeTrace, /reader-saved-works-pointer-passed/u);
        if (surface.interaction === "saved-cards") assert.match(nativeTrace, /reader-saved-cards-pointer-passed/u);
        if (surface.interaction === "summary-sequences") assert.match(nativeTrace, /reader-summary-sequence-pointer-passed/u);
        if (surface.jsonGuide) assert.match(nativeTrace, /platform-import-guide-pointer-passed/u);
        if (surface.interaction === "record-compatibility") assert.match(nativeTrace, /record-compatibility-passed/u);
        if (surface.id === "archiver-capture-time") assert.match(nativeTrace, /source-capture-time-pointer-passed/u);
        if (surface.directoryFonts) assert.match(nativeTrace, /reader-directory-fonts-pointer-passed/u);
        if (surface.id === "reader-conversation" && readerBoundary && (!realConversation || readerResources)) {
          const scroll = JSON.parse(await readFile(output.replace(/\.png$/u, ".resource-scroll.json"), "utf8"));
          assert.equal(scroll.messages, readerBoundary.messages, "Native scroll stopped before the complete default Reader path");
          assert.match(nativeTrace, /reader-complete-pagination-passed/u);
          const endpoint = JSON.parse(await readFile(output.replace(/\.png$/u, ".pagination.json"), "utf8"));
          assert.equal(endpoint.last_message, readerBoundary.last_message);
          assert.equal(endpoint.last_navigation, readerBoundary.last_navigation);
          assert.equal(endpoint.pointer_last, readerBoundary.last_navigation !== null);
        }
        if (surface.interaction === "standard-document") assert.match(nativeTrace, /standard-document-pointer-roundtrip-passed/u);
        if (surface.interaction === "document-refinements") assert.match(nativeTrace, /document-refinements-pointer-passed/u);
        if (surface.interaction === "history-document") assert.match(nativeTrace, /history-document-pointer-roundtrip-passed/u);
        if (surface.interaction === "license-document") assert.match(nativeTrace, /license-document-pointer-roundtrip-passed/u);
        if (surface.interaction === "bookmark-document") assert.match(nativeTrace, /bookmark-document-pointer-roundtrip-passed/u);
        if (surface.interaction === "features-document") assert.match(nativeTrace, /features-document-pointer-roundtrip-passed/u);
        if (surface.interaction === "author-contact") assert.match(nativeTrace, /author-contact-native-external-passed/u);
        if (surface.interaction === "update-check") assert.match(nativeTrace, /update-check-pointer-roundtrip-passed/u);
        if (claudeContext) assert.match(nativeTrace, /claude-context-pointer-passed/u);
        if (sourceEmpty) assert.match(nativeTrace, /reader-empty-source-passed/u);
        if (claudeSource && (parserStatus || officialSourceIndex < 0)) assert.match(nativeTrace, parserStatus ? /parser-status-pointer-passed/u : /claude-empty-source-pointer-passed/u);
        if (indexReopen) assert.match(nativeTrace, /container-reopen-pointer-passed/u);
        if (sourcePicker) {
          for (const platform of ['chatgpt', 'claude']) assert.match(nativeTrace, new RegExp(`source-picker-native-passed\\s+\\{"platform":"${platform}"`, 'u'));
          assert.match(nativeTrace, /Official export ZIP/u); assert.match(nativeTrace, /Platform JSON/u);
        }
        if (surface.interaction === "platform-json" && !surface.jsonGuide) assert.match(nativeTrace, /platform-json-pointer-passed/u);
        if (surface.interaction === "english-layout") assert.match(nativeTrace, /english-layout-language-roundtrip-passed/u);
        assert.match(nativeTrace, /cache-profile-removed/u, "the EXE must retire its own profile after browser exit, before test cleanup");
        // These dedicated native journeys inspect cards/works, not branch
        // switching. Do not demand an event that their dispatcher never runs.
        // An explicit branch gate remains strict; the normal Reader journey
        // still switches/restores branching inputs as before.
        const dedicatedContentJourney = ["saved-cards", "saved-works", "saved-map", "schedule-cards"].includes(surface.interaction);
        if (surface.route === "conversation" && sourceEvidence?.branch_points > 0 && !sourceEmpty && (!dedicatedContentJourney || requireBranch)) assert.match(nativeTrace, /reader-branch-switch-and-restore-passed/u, "A genuinely branching source must switch and restore a real Reader path; a skipped branch probe is not evidence");
        if (surface.interaction === "reader-catalog-open") {
          assert.match(nativeTrace, /reader-catalog-open-passed\s+\{"native_clicks":2,"archiver_roundtrip":true/u);
          if (realFixture) assert.match(nativeTrace, /runtime-response\s+200;/u, "The real runtime file must cross the desktop resource mapping");
        }
        if (surface.interaction === "time-compatibility") {
          assert.match(nativeTrace, /time-compatibility-passed/u, "An unsupported time file must prompt in the real UI and recover without restarting");
          for (const suffix of [".time-update-required.png", ".time-compatible-again.png"]) assert.ok((await readFile(output.replace(/\.png$/u, suffix))).length > 100);
        }
        if (surface.interaction === "time-save") {
          assert.match(nativeTrace, /time-save-roundtrip-passed/u);
          const nodeFiles = (await readdir(path.join(outputRoot, "Library", "ContentTimes"))).filter(file => file !== "order.json");
          const saved = await Promise.all(nodeFiles.map(file => readFile(path.join(outputRoot, "Library", "ContentTimes", file), "utf8").then(JSON.parse)));
          assert(saved.some(node => node.kind === "periodic" && node.name === `UI roundtrip ${theme} ${language} ${viewport.width}` && node.count === 24), "UI create/edit must exist in an actual independent ContentTime file");
        }
        if (surface.interaction === "claude-parse") assert.match(nativeTrace, /claude-parse-roundtrip-passed/u, "Claude scope, cancellation, progress and preservation must cross the real UI/Engine boundary");
        const manifestFile = output.replace(/\.png$/u, ".json");
        const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
        assert.equal(manifest.executable.sha256, executableSha256);
        assert.equal(createHash("sha256").update(await readFile(engineFile)).digest("hex"), engineSha256, "Engine changed during a fixed-package audit");
        assert.equal(manifest.titlebar.surface, manifest.page.surface);
        assert.equal(manifest.titlebar.theme, theme);
        assert.ok(manifest.titlebar.bytes > 100);
        assert.ok((await readFile(path.join(outputRoot, manifest.titlebar.file))).length === manifest.titlebar.bytes);
        assert.deepEqual(manifest.requested_viewport, viewport);
        const scale = Math.max(1, Math.min(viewport.width / 1920, viewport.height / 1080));
        assert.ok(Math.abs(manifest.viewport_scale - scale) < .00001, "Actual desktop zoom must use the client size, without a second DPI multiplier");
        assert.ok(Math.abs(manifest.page.width - viewport.width / scale) <= 1);
        assert.ok(Math.abs(manifest.page.height - viewport.height / scale) <= 1);
        if (resizeRoundtrip) assert.equal(manifest.page.viewport_roundtrip, "passed");
        if (surface.interaction === "archive-splitter") {
          const frames = JSON.parse(await readFile(output.replace(/\.png$/u, ".splitter.json"), "utf8"));
          assert.equal(frames.length, 3);
          for (const frame of frames) {
            verifyArchiverScene(frame.scene);
            const width = frame.scene.center.width, minimum = Math.min(360, width / 2) / width;
            const expected = Math.max(minimum, Math.min(1 - minimum, frame.requested_ratio));
            assert.ok(Math.abs(frame.scene.ratio - expected) * width <= 1, "Actual pointer drag must move the separator to the requested bounded position");
            assert.ok((await readFile(path.join(outputRoot, frame.png))).length > 100);
            for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(frame.scene.scene[key] - frames[0].scene.scene[key]) < .15, "Dragging must not stretch or slide the panorama");
          }
        }
        assert.equal(manifest.page.theme, theme);
        for (const card of manifest.page.platform_cards ?? []) {
          assert.equal(card.background, card.platform === "kimi" ? "rgb(17, 17, 17)" : "rgb(255, 255, 255)", "Use the designed logo backing, not a theme-wide inversion");
          assert.equal(card.filter, "none", "Platform SVG colors must remain original");
        }
        for (const title of manifest.page.information_titles ?? []) {
          assert(title.height >= title.line_height - .5, "A bottom information title was vertically collapsed");
          if (title.scroll_top === 0) assert(title.top >= title.box_top - .5, "Unscrolled information starts above its visible viewport");
        }
        if (surface.interaction === "theme-roundtrip") assert.equal(manifest.page.theme_roundtrip, "passed", "Actual theme clicks must survive an intervening Library write");
        assert.equal(manifest.page.language, language);
        assert.equal(manifest.page.transition, false);
        assert.equal(manifest.page.body_scroll_width, manifest.page.body_client_width);
        assert.equal(manifest.page.body_scroll_height, manifest.page.body_client_height);
        const layout = manifest.page.geometry.app_root;
        assertSurfaceGeometry(surface, {width: layout.width, height: layout.height}, manifest.page, manifest.viewport_scale);
        if (surface.route === "conversation-info" && surface.interaction !== "parser-history") {
          const facts = manifest.page.conversation_time_layout;
          assert.ok(facts, "Conversation time geometry was not measured");
          assert.ok(Math.abs(facts.preset_heading_center - facts.timeline_button_center) <= .6, "Preset heading and timeline entry must share a centered row");
          assert.equal(facts.presets.length, 9);
          assert.ok(facts.presets.every((item, index) => Math.abs(item.y - facts.presets[Math.floor(index / 3) * 3].y) < .6), "Presets must occupy three rows of three");
          assert.ok(facts.presets.every(item => item.scroll_width <= item.width + 1), "Preset text must fit its chip");
          assert.ok(facts.scene_filter.includes(theme === "dawn" ? "0.5" : "0.8"), "The artwork uses separate AI shadow opacity by theme");
        }
        if (surface.interaction === "parser-history") assert.equal(manifest.page.parser_history_releases, JSON.parse(await readFile(path.join(path.dirname(executable), "app/web/shared/parser-history.json"), "utf8")).releases.length);
        if (surface.interaction === "counterpart") assert.ok(Object.values(manifest.page.time_picker_button ?? {missing: -1}).every(value => value >= 0), "Counterpart confirmation text must fit inside its button");
        rows.push({
          surface: surface.id,
          theme,
          language,
          viewport,
          viewport_scale: manifest.viewport_scale,
          css_viewport: {width: manifest.page.width, height: manifest.page.height},
          route: manifest.page.route,
          phase: surface.referencePhase?.[theme] ?? surface.phase,
          png: path.basename(output),
          manifest: path.basename(manifestFile),
          png_sha256: manifest.png.sha256,
          png_bytes: manifest.png.bytes,
          pixel_viewport: { width: manifest.png.pixel_width, height: manifest.png.pixel_height }
        });
        console.log(`${rows.length}/${selectedSurfaces.length * themes.length * languages.length * viewports.length} ${stem}`);
      }
    }
  }
}

if (batchSamples) {
  const root = path.join(outputRoot, "Library"), expected = sourceEvidence.files.length;
  const before = hashInputs(root, ["Inbox", "Conversations", "Marks", "CloudigLibrary.json"]).aggregate_sha256;
  const { startRecordEngine } = await import("./record-engine-client.mjs");
  const queryAfterRestart = async () => {
    const engine = startRecordEngine({ packageRoot: path.dirname(executable), libraryRoot: root });
    try {
      const list = await engine.request("archiver.sources.query", { offset: 0, limit: 200 });
      assert.equal(list.total, expected); assert.equal(list.statuses.complete, expected); assert.equal(list.statuses.pending ?? 0, 0);
      const next = await engine.request("archiver.parse.plan", { sources: [], one_click: true }); assert.equal(next.total, 0);
      return { complete: list.statuses.complete, pending: list.statuses.pending ?? 0, next_parse: next.total };
    } finally { await engine.close(); }
  };
  const restarted = await queryAfterRestart();
  // Reproduce old-address histories only inside this freshly parsed owned
  // Library. The actual user Library and every Conversation remain untouched.
  const catalog = JSON.parse(await readFile(path.join(root, "appdata/indexes/conversations.json"), "utf8"));
  const headers = new Map(Object.values(catalog.files).map(record => [record.header.conversation_id, record.header]));
  const historyRoot = path.join(root, "appdata/parse-history"); let restoredLegacy = 0;
  for (const file of await readdir(historyRoot)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
    const current = path.join(historyRoot, file), history = JSON.parse(await readFile(current, "utf8"));
    const locator = headers.get(history.output.conversation_id)?.source?.locator;
    if (history.source.format !== "exporter-html" || typeof locator !== "string" || !locator || history.source.locator) continue;
    history.source.locator = locator;
    const old = path.join(historyRoot, createHash("sha256").update(JSON.stringify(history.source)).digest("hex") + ".json");
    await writeFile(old, JSON.stringify(history, null, 2) + "\n", { flag: "wx" }); await rm(current); restoredLegacy++;
  }
  const legacyBefore = hashInputs(root, ["appdata/parse-history"]).aggregate_sha256;
  const legacy = await queryAfterRestart();
  assert.equal(hashInputs(root, ["appdata/parse-history"]).aggregate_sha256, legacyBefore, "Status recovery rewrote the old history");
  assert.equal(hashInputs(root, ["Inbox", "Conversations", "Marks", "CloudigLibrary.json"]).aggregate_sha256, before, "Status inspection changed an original or user setting");
  sourceEvidence.parse_status = { restarted, restored_legacy_histories: restoredLegacy, legacy, originals_unchanged: true, histories_unchanged_by_read: true };
}
assert.equal(hashInputs(process.cwd(), [programPath]).aggregate_sha256, programFingerprint.aggregate_sha256, "Packaged managed host, UI or runtime changed during the visual audit");
if (sourceEvidence?.search) {
  const { fingerprintFile } = await import("../src/adapters/storage/stream.mts");
  for (const source of sourceEvidence.search.inputs) assert.equal((await fingerprintFile(source.source)).sha256, source.sha256, "Search audit changed a user original");
}
verified = true;
} finally {
await new Promise((resolve) => setTimeout(resolve, 300));
extractionEntries = await readdir(auditExtractRoot).then(entries => entries.length).catch(error => {
  if (error.code === "ENOENT") return 0;
  throw error;
});
if (verified) await Promise.all([
  rm(path.join(outputRoot, "Library"), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }),
  rm(path.join(outputRoot, "Device"), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }),
  rm(auditExtractRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }),
  rm(auditUserDataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
]);
// A failed/forced host may still have a child using its Library or profile.
// Retain that exact test scope for diagnosis; never race deletion with it.
}
const run = {
  schema: "cloudig/visual-audit-matrix/1.0.0",
  generated_at: new Date().toISOString(),
  mode: `${quick ? "quick" : "full"}:${languages.join("+")}`,
  ...(sourceEvidence ? { real_source: sourceEvidence } : {}),
  executable: { file: "Cloudig.exe", sha256: executableSha256 },
  engine: { file: "app/engine/engine.mjs", sha256: engineSha256 },
  program: { path: "app", file_count: programFingerprint.file_count, total_bytes: programFingerprint.total_bytes, aggregate_sha256: programFingerprint.aggregate_sha256 },
  runtime: { self_extraction_entries: extractionEntries, owned_temporary_data_cleaned: true },
  scenarios: rows
};
await writeFile(path.join(outputRoot, "visual-audit-matrix.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output: outputRoot, scenarios: rows.length, executable_sha256: executableSha256 }));
