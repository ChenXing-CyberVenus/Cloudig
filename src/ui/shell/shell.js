import { mountReaderCover, readerCoverPreload, visualReaderFixture } from "./pages/reader/reader-cover.js";
import {
  defaultReaderSession,
  mountReaderConversation,
  readerConversationPreload,
  visualConversationFixture
} from "./pages/reader/reader-conversation.js";
import { labels as readerRendererLabels } from "./pages/reader/reader-conversation.js";
import { openContentSearch } from "./content-search.js";
import { chooseMarkdown, MARKDOWN_SELECTION_LIMITS } from "./markdown-options.js";
import { archiverPreload, mountArchiver, visualArchiverEmptyFixture, visualArchiverFixture } from "./pages/archiver/archiver.js";
import { visualClaudeContainerFixture } from "./pages/archiver/claude-container.js";
import { platformJsonDefinitions } from "./pages/archiver/platform-json-presentation.js";
import {
  conversationInfoPreload,
  commitCurrentConversationInfo,
  mountConversationInfo,
  visualConversationInfoFixture
} from "./pages/conversation-info/conversation-info.js";
import { mountTimeCover, timeCoverPreload, visualTimeCoverFixture } from "./pages/time-cover/time-cover.js";
import { mountTimeEditor, timeEditorPreload, visualTimeEditorFixture } from "./pages/time-editor/time-editor.js";
import { mountSystemLog, visualSystemLogFixture } from "./pages/system-log/system-log.js";
import { mountIdentityEditor, visualIdentityFixture } from "./pages/identity-editor/identity-editor.js";
import { formatTimeRange } from "/shared/time/endpoint-editor.js";
import { archiveQuerySort, archiveQueryTimeField, defaultArchiveWorkflow, normalizeArchiveWorkflow } from "./archive-workflow.js";
import { commitPreferencePatch } from "./preferences.js";
import { runArchiveDeletion } from "./operation-progress.js";
import { mountParseTarget } from "./parse-target.js";
import { mountStandardDocument } from "./pages/document/document.js";
import { mountHistoryDocument } from "./pages/document/history.js";
import { mountLicenseDocument } from "./pages/document/license.js";
import { mountBookmarkDocument } from './pages/document/bookmarks.js';
import { mountFeatureDocument } from './pages/document/features.js';
import { openUpdateCheck, checkStartupUpdate } from './update-check.js';

const protocol = "cloudig/web-bridge/1.0.0";
const root = document.documentElement;
const app = document.querySelector(".app-root");
const routeHost = document.querySelector(".route-host");
const readerTemplate = document.querySelector("#reader-cover-template");
const conversationTemplate = document.querySelector("#reader-conversation-template");
const archiverTemplate = document.querySelector("#archiver-template");
const conversationInfoTemplate = document.querySelector("#conversation-info-template");
const timeCoverTemplate = document.querySelector("#time-cover-template");
const timeEditorTemplate = document.querySelector("#time-editor-template");
const systemLogTemplate = document.querySelector("#system-log-template");
const identityEditorTemplate = document.querySelector("#identity-editor-template");
const transition = document.querySelector(".route-transition");
const overlayRoot = document.querySelector(".overlay-root");
const overlayScrollOwners = ".cloudig-dialog, .cloudig-dialog-list, .cloudig-time-delete-impact, .cloudig-dialog-choices";
function registerOverlayScrollOwners(scope) {
  if (scope instanceof Element && scope.matches(overlayScrollOwners)) scope.dataset.scrollRegion = "";
  for (const owner of scope.querySelectorAll?.(overlayScrollOwners) ?? []) owner.dataset.scrollRegion = "";
}
new MutationObserver((records) => {
  for (const record of records) for (const node of record.addedNodes) registerOverlayScrollOwners(node);
}).observe(overlayRoot, { childList: true, subtree: true });
let scrollRegionDragTarget = null;

function scrollRegions() {
  return Array.from(document.querySelectorAll("[data-scroll-region]"));
}

function scrollRegionHit(node, event) {
  const rect = node.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return false;
  const verticalWidth = Math.max(node.offsetWidth - node.clientWidth, 8);
  const horizontalHeight = Math.max(node.offsetHeight - node.clientHeight, 8);
  const vertical = node.scrollHeight > node.clientHeight + 1 && event.clientX >= rect.right - verticalWidth;
  const horizontal = node.scrollWidth > node.clientWidth + 1 && event.clientY >= rect.bottom - horizontalHeight;
  return vertical || horizontal;
}

function updateScrollRegionState(event) {
  for (const node of scrollRegions()) {
    node.classList.toggle("cloudig-scroll-operating", node === scrollRegionDragTarget || scrollRegionHit(node, event));
  }
}

function beginScrollRegionOperation(event) {
  scrollRegionDragTarget = scrollRegions().find((node) => scrollRegionHit(node, event)) ?? null;
  updateScrollRegionState(event);
}

function endScrollRegionOperation(event) {
  scrollRegionDragTarget = null;
  updateScrollRegionState(event);
}

document.addEventListener("pointermove", updateScrollRegionState, { passive: true });
document.addEventListener("pointerdown", beginScrollRegionOperation, { passive: true });
globalThis.addEventListener("pointerup", endScrollRegionOperation, { passive: true });
globalThis.addEventListener("pointercancel", endScrollRegionOperation, { passive: true });
globalThis.addEventListener("blur", () => {
  scrollRegionDragTarget = null;
  for (const node of scrollRegions()) node.classList.remove("cloudig-scroll-operating");
});
const welcomeBlueprint = routeHost.firstElementChild.cloneNode(true);
const pending = new Map();
const screenshotQuery = new URLSearchParams(location.search);
let timeAuditEditorOpened = false;
let ordinal = 0;
let routeOrdinal = 0;
let currentRoute = "welcome";
let currentPage = null;
let activeDocument = null;
let documentRequest = 0;
let openingDocument = false;
function closeDocument() {
  documentRequest++;
  activeDocument?.close(); activeDocument = null;
}
async function openStandard(topic = 'json', restore = {}) {
  if (!currentPage?.element || openingDocument) return;
  if (activeDocument) {
    if (currentPage.element.dataset.document === ({archive:'features',roadmap:'history',license:'license',bookmark:'bookmark',platforms:'platforms'}[topic] ?? 'standard')) return;
    closeDocument();
  }
  const page = currentPage.element, ticket = ++documentRequest;
  openingDocument = true;
  try {
    const mount = topic === 'archive' ? mountFeatureDocument : ['bookmark','platforms'].includes(topic) ? mountBookmarkDocument : topic === 'roadmap' ? mountHistoryDocument : topic === 'license' ? mountLicenseDocument : mountStandardDocument;
    const document = await mount({ page, language: state.language, topic, restore, onClose: closeDocument, onError: showActionError,
      onDocument: next => openStandard(next).catch(showActionError), onDemo: openExampleDemo,
      onChrome: example => request('shell.example.open', { example }),
      onDownloadHtml: (example, options) => requestWithSignal('shell.example.download', { example: example.id, format: 'html' }, options.signal, options.onProgress),
      onDownloadRecord: (example, options) => requestWithSignal('shell.example.download', { example: example.id, format: 'json' }, options.signal, options.onProgress),
      onExternal: url => request('shell.openExternal', { url }).catch(showActionError) });
    if (ticket !== documentRequest || currentPage?.element !== page) { document?.close(); return; }
    activeDocument = document;
    activeDocument?.updateLanguage(state.language);
  } finally { openingDocument = false; }
}
let activeConversation = null;
let exampleReturn = null;
async function openExampleDemo(example, documentState) {
  // Opening another example from a demo must not save that read-only demo as
  // an archive return target (its previous runtime capability has been closed).
  const nestedDemo = Boolean(activeConversation?.row.example);
  const back = { route: nestedDemo ? 'reader/cover' : currentRoute, row: nestedDemo ? null : activeConversation?.row, document: documentState,
    session: structuredClone(nestedDemo && exampleReturn ? exampleReturn.session : readerSessionState), branch: nestedDemo && exampleReturn ? exampleReturn.branch : readerBranchArchive };
  const crossSurface = !currentRoute.startsWith('reader');
  closeDocument();
  if (crossSurface) await showTransition();
  try {
    await revealRoute('reader/cover', false);
    exampleReturn = back;
    readerSessionState = structuredClone(defaultReaderSession);
    await openReaderConversation({ capability: example.id, example: example.id, title: example.html.file.replace(/\.html$/u, ''), filename: example.html.file, platform: example.platform });
  } finally { if (crossSurface) hideTransition(routeOrdinal); }
}
async function returnExampleDemo() {
  const back = exampleReturn; if (!back) return;
  exampleReturn = null;
  disposeActiveConversation();
  readerSessionState = back.session; readerBranchArchive = back.branch;
  await revealRoute(back.route.startsWith('archiver') ? 'archiver' : 'reader/cover', back.route.startsWith('archiver'));
  if (back.row && back.route.startsWith('reader/conversation/')) await openReaderConversation(back.row);
  await openStandard('platforms', back.document);
}
let activeConversationInfo = null;
let activeTimeCover = null;
let activeTimeEditor = null;
let activeSystemLog = null;
let activeIdentityEditor = null;
let currentLocale = null;
let readerSessionState = structuredClone(defaultReaderSession);
let readerBranchArchive = null;
let activeParseOperation = null;
let activeExportOperation = false;
let indexRebuildPromise = null;
let state = {
  revision: null,
  theme: "dawn",
  language: "zh-CN",
  themeSwitched: false,
  userName: "采云用户",
  assistantName: "智能伙伴",
  userNameCustom: false,
  assistantNameCustom: false,
  userAvatar: { kind: "application", asset: "Assets/Defaults/user.svg" },
  assistantAvatar: { kind: "application", asset: "Assets/Defaults/assistant.svg" },
  userAvatarUrl: null,
  assistantAvatarUrl: null,
  parseOrdinary: { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false },
  parseClaude: { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false },
  workflowArchiver: { ...defaultArchiveWorkflow },
  workflowReader: { ...defaultArchiveWorkflow },
  workflowClaude: { sort: "time_desc", time_field: "updated_at" }
};

function localAnchor() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const minutes = -now.getTimezoneOffset();
  if (minutes === 0) return { date, offset: "Z" };
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return { date, offset: `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}` };
}

function beginRequest(command, payload = {}, onEvent) {
  if (!globalThis.chrome?.webview) return {
    id: null,
    promise: Promise.reject(new Error("native bridge unavailable")),
    cancel: () => Promise.resolve({ cancelled: false })
  };
  const id = `w_${++ordinal}`;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent });
    try { globalThis.chrome.webview.postMessage({ protocol, request: id, command, payload }); }
    catch (error) { pending.delete(id); reject(error); }
  });
  return {
    id,
    promise,
    cancel: () => request("request.cancel", { target: id })
  };
}

function request(command, payload = {}, onEvent) {
  const operation = beginRequest(command, payload, onEvent);
  return operation?.promise ?? Promise.reject(new Error("native bridge unavailable"));
}

async function requestWithSignal(command, payload, signal, onEvent) {
  signal.throwIfAborted();
  const operation = beginRequest(command, payload, onEvent);
  const cancel = () => { operation.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try { return await operation.promise; }
  finally { signal.removeEventListener("abort", cancel); }
}

let runtimeErrorCount = 0;
const markRuntimeError = () => { root.dataset.runtimeErrors = String(++runtimeErrorCount); };
addEventListener("error", (event) => { if (event.error) markRuntimeError(); });
addEventListener("unhandledrejection", markRuntimeError);

function bridgeError(error) {
  let message = error?.message ?? "request failed";
  if (error?.code === "CLOUDIG_ENGINE_UNAVAILABLE") message = state.language === "en"
      ? "The local Engine connection failed. Restart Cloudig to continue."
      : "采云本地引擎连接已中断，请重新打开采云后继续。";
  if (error?.code === "CLOUDIG_EXTERNAL_OPEN_FAILED") message = state.language === "en"
      ? "Could not open the default browser. Check Windows default browser settings and retry."
      : "无法打开默认浏览器。请检查 Windows 的默认浏览器设置后重试。";
  return Object.assign(new Error(message), { code: error?.code });
}

globalThis.chrome?.webview?.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.protocol !== protocol || !["event", "response"].includes(message.kind)) return;
  const handler = pending.get(message.request);
  if (!handler) return;
  if (message.kind === "event") {
    handler.onEvent?.(message.event);
    return;
  }
  pending.delete(message.request);
  if (message.ok) handler.resolve(message.result);
  else handler.reject(bridgeError(message.error));
});

async function locale(language) {
  const response = await fetch(`/locales/${language}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error("locale unavailable");
  return response.json();
}

function valueAt(values, key) {
  return key.split(".").reduce((current, part) => current?.[part], values);
}

function translate(key) {
  const value = currentLocale ? valueAt(currentLocale, key) : undefined;
  return typeof value === "string" ? value : undefined;
}

function translated(key, fallback) {
  return translate(key) ?? fallback;
}

function archiveActionCopy(operation) {
  const english = state.language === "en";
  const rows = operation.rows ?? (operation.row ? [operation.row] : []);
  const filename = rows.length > 1
    ? (english ? `${rows.length} selected archives` : `已选择 ${rows.length} 份档案`)
    : operation.row?.filename ?? operation.row?.title ?? (english ? "Selected archive" : "所选档案");
  if (operation.action === "move") return {
    title: translated("reader.moveDialogTitle", english ? "Move Archive" : "移动档案"),
    message: translated("reader.moveDialogMessage", english ? "Move this exact archive to the selected directory?" : "将这份精确档案移动到所选目录？"),
    filename,
    target: operation.directoryName ?? translated("reader.rootDirectory", english ? "Conversation root" : "对话根目录"),
    targetLabel: translated("reader.targetDirectory", english ? "Target directory" : "目标目录"),
    confirm: translated("reader.confirmMove", english ? "Move" : "移动")
  };
  if (operation.action === "archive") return {
    title: translated("reader.archiveDialogTitle", english ? "Archive Conversation" : "归档会话"),
    message: translated("reader.archiveDialogMessage", english ? "Move this exact archive into the Cloudig archive area?" : "将这份精确档案移入采云归档区？"),
    filename,
    target: translated("reader.archiveArea", english ? "Cloudig archive area" : "采云归档区"),
    targetLabel: translated("reader.targetDirectory", english ? "Target" : "目标位置"),
    confirm: translated("reader.confirmArchive", english ? "Archive" : "归档")
  };
  if (operation.action === "restore") return {
    title: english ? "Restore Conversation" : "恢复归档会话",
    message: english ? "Restore the selected exact archive files to the chosen conversation directory?" : "将所选精确档案恢复到指定对话目录？",
    filename,
    target: operation.directoryName ?? translated("reader.rootDirectory", english ? "Conversation root" : "对话根目录"),
    targetLabel: translated("reader.targetDirectory", english ? "Target directory" : "目标目录"),
    confirm: english ? "Restore" : "恢复"
  };
  return {
    title: translated("reader.recycleDialogTitle", english ? "Move Archive to Recycle Bin" : "将档案移入回收站"),
    message: translated(rows.length > 1 ? "reader.recycleManyDialogMessage" : "reader.recycleDialogMessage", english ? "The selected Conversations and their listed Marks will be moved to the Windows Recycle Bin. Sources and other archives stay untouched." : "将所选 Conversation 及列出的对应 Mark 一起移入 Windows 回收站；来源与其他档案不删除。"),
    filename,
    confirm: translated("reader.confirmRecycle", english ? "Move to Recycle Bin" : "移入回收站"),
    agreement: translated(rows.length > 1 ? "reader.recycleManyAgreement" : "reader.recycleAgreement", english ? "Move the selected files to the Windows Recycle Bin" : "将所选文件移入 Windows 回收站")
  };
}

function showArchiveConfirmation(operation) {
  const copy = archiveActionCopy(operation);
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = `cloudig-dialog${operation.action === "delete" ? " cloudig-dialog-danger" : ""}`;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", `cloudig-dialog-title-${ordinal + 1}`);
    const title = document.createElement("h2");
    title.id = `cloudig-dialog-title-${ordinal + 1}`;
    title.textContent = copy.title;
    const message = document.createElement("p");
    message.textContent = copy.message;
    const facts = document.createElement("dl");
    const fileLabel = document.createElement("dt");
    fileLabel.textContent = translated("reader.archiveFile", state.language === "en" ? "Archive file" : "档案文件");
    const fileValue = document.createElement("dd");
    fileValue.textContent = copy.filename;
    fileValue.title = copy.filename;
    facts.append(fileLabel, fileValue);
    if (copy.target) {
      const targetLabel = document.createElement("dt");
      targetLabel.textContent = copy.targetLabel;
      const targetValue = document.createElement("dd");
      targetValue.textContent = copy.target;
      targetValue.title = copy.target;
      facts.append(targetLabel, targetValue);
    }
    const rows = operation.rows ?? (operation.row ? [operation.row] : []);
    let exactFiles;
    if (rows.length > 1 || operation.action === "delete" && rows.some(row => row.mark_file)) {
      exactFiles = document.createElement("ul");
      exactFiles.className = "cloudig-dialog-list";
      exactFiles.dataset.scrollRegion = "";
      for (const row of rows) {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = row.filename ?? row.title;
        item.append(name);
        if (operation.action === "delete" && row.mark_file) { const mark = document.createElement("span"); mark.textContent = `Mark · ${row.mark_file}`; item.append(mark); }
        exactFiles.append(item);
      }
    }
    let agreement;
    if (copy.agreement) {
      agreement = document.createElement("label");
      agreement.className = "cloudig-dialog-check cloudig-choice";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const checkCopy = document.createElement("span");
      checkCopy.textContent = copy.agreement;
      agreement.append(checkbox, checkCopy);
    }
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = translated("reader.cancel", state.language === "en" ? "Cancel" : "取消");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = copy.confirm;
    if (agreement) confirm.disabled = true;
    footer.append(cancel, confirm);
    dialog.append(title, message, facts, ...(exactFiles ? [exactFiles] : []), ...(agreement ? [agreement] : []), footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const close = (accepted) => {
      layer.remove();
      previousFocus?.focus?.();
      resolve(accepted);
    };
    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    agreement?.querySelector("input")?.addEventListener("change", (event) => { confirm.disabled = !event.target.checked; });
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) close(false); });
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") close(false); });
    (agreement?.querySelector("input") ?? cancel).focus();
  });
}

function showTimeDeleteConfirmation(preview) {
  return new Promise((resolve) => {
    const english = state.language === "en";
    const impact = preview.impact;
    const previousFocus = document.activeElement;
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog cloudig-dialog-danger cloudig-time-delete-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = english ? "Delete Time Node" : "删除时间节点";
    const message = document.createElement("p");
    message.textContent = english
      ? `Delete “${impact.target.display.name}” only after reviewing every direct impact below. No child node outside this deletion set will be deleted.`
      : `删除“${impact.target.display.name}”前，请核对以下全部直接影响。删除范围外的子节点不会被删除。`;
    const impactBody = document.createElement("div");
    impactBody.className = "cloudig-time-delete-impact";
    impactBody.dataset.scrollRegion = "";
    const addGroup = (heading, rows) => {
      if (!rows.length) return;
      const section = document.createElement("section");
      const label = document.createElement("h3");
      label.textContent = heading;
      const list = document.createElement("ul");
      for (const value of rows) { const item = document.createElement("li"); item.textContent = value; list.append(item); }
      section.append(label, list);
      impactBody.append(section);
    };
    const nodeName = (entry) => entry?.display?.name ?? (english ? "Unknown node" : "未知节点");
    addGroup(english ? "Nodes removed" : "删除节点", impact.deleted_nodes.map((entry) => nodeName(entry)));
    addGroup(english ? "Parent links removed" : "解除父节点关系", impact.parents.map((entry) => `${nodeName(entry.parent)} → ${nodeName(entry.child)}`));
    addGroup(english ? "Child links removed" : "解除子节点关系", impact.children.map((entry) => `${nodeName(entry.parent)} → ${nodeName(entry.child)}`));
    addGroup(english ? "Internal links removed" : "删除范围内关系", impact.internal_contains.map((entry) => `${nodeName(entry.parent)} → ${nodeName(entry.child)}`));
    addGroup(english ? "Counterparts removed" : "解除对映关系", impact.counterparts.map((entry) => `${nodeName(entry.left)} ↔ ${nodeName(entry.right)}`));
    addGroup(english ? "Terran mappings removed" : "解除此地时间映射", impact.mappings.map((entry) => `${nodeName(entry.target)} · ${formatTimeRange(entry.range, state.language)}`));
    addGroup(english ? "Conversation snapshots preserved" : "以下会话保留原内容时间快照", impact.affected_references.map((entry) => `${entry.title} · ${entry.endpoints.join(" / ")}`));

    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = english ? "Cancel" : "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = english ? "Delete" : "删除";
    footer.append(cancel, confirm);
    dialog.append(title, message, impactBody, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const close = (value) => { layer.remove(); previousFocus?.focus?.(); resolve(value); };
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", () => close({ confirmed: true }));
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) close(null); });
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") close(null); });
    cancel.focus();
  });
}

function showParseConfirmation(items, settings = {}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = translated("archiver.parseConfirmTitle", state.language === "en" ? "Confirm Parse" : "确认解析");
    const message = document.createElement("p");
    message.textContent = translated("archiver.parseConfirmMessage", state.language === "en" ? "This run will process the following exact source files:" : "本次将解析以下精确来源文件：");
    const facts = document.createElement("p");
    facts.textContent = settings.preserve_previous
      ? state.language === "en" ? "Keep previous results" : "保留旧版解析结果"
      : state.language === "en" ? "Update matched archives; keep unrelated files" : "更新对应档案；不覆盖无关同名文件";
    const list = document.createElement("ul");
    list.className = "cloudig-dialog-list";
    list.dataset.scrollRegion = "";
    for (const item of items) {
      const row = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = item.filename;
      const action = document.createElement("span");
      const labels = state.language === "en" ? {
        parse: "Parse or update",
        new: "New archive", safe_update: "Safely update the same archive", conservative_new: "Keep existing and create a new archive",
        preserve: "Preserve previous and create a new archive", unchanged: "Unchanged · zero write", excluded: "Excluded"
      } : {
        parse: "解析或更新",
        new: "新建档案", safe_update: "安全更新同一档案", conservative_new: "保留现有档案并新建",
        preserve: "保留旧版并新建档案", unchanged: "未变化 · 零写", excluded: "排除"
      };
      action.textContent = item.action === "unchanged" && item.reason === "registered_source_moved"
        ? state.language === "en" ? "Archive unchanged · update source location" : "档案未变化 · 更新来源位置"
        : labels[item.action] ?? item.action;
      row.dataset.action = item.action;
      row.append(name, action);
      list.append(row);
    }
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = translated("reader.cancel", state.language === "en" ? "Cancel" : "取消");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = translated("archiver.confirmParse", state.language === "en" ? "Parse" : "确认解析");
    confirm.disabled = items.length === 0;
    footer.append(cancel, confirm);
    const target = mountParseTarget({ language: state.language, directories: settings.directories ?? [], initialDirectory: settings.directoryLabel ?? "Conversations",
      onCreate: createParseDirectory, errorMessage: directoryCreateErrorMessage, onBusy: busy => { confirm.disabled = busy || items.length === 0; cancel.disabled = busy; } });
    dialog.append(title, message, facts, target.element, list, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const close = (value) => { if (target.busy) return; target.dispose(); layer.remove(); previousFocus?.focus?.(); resolve(value); };
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", () => close(target.value()));
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") close(false); });
    cancel.focus();
  });
}

function showMissingSourceConfirmation(row) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog cloudig-dialog-danger";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = translated("archiver.missingDismissTitle", state.language === "en" ? "Clear Missing Source Record" : "清除来源缺失记录");
    const message = document.createElement("p");
    message.textContent = translated("archiver.missingDismissMessage", state.language === "en"
      ? "Only the source queue record will be cleared. Generated conversation archives, user settings and resources will not be deleted."
      : "仅清除来源队列记录，不删除已经生成的对话档案、用户设置或资源");
    const facts = document.createElement("dl");
    const label = document.createElement("dt");
    label.textContent = translated("archiver.filename", state.language === "en" ? "Filename" : "文件名");
    const value = document.createElement("dd");
    value.textContent = row.filename;
    value.title = row.filename;
    facts.append(label, value);
    const choices = document.createElement("div");
    choices.className = "cloudig-dialog-choices";
    const choice = (scope, copy, checked) => {
      const label = document.createElement("label");
      label.className = "cloudig-choice";
      const input = document.createElement("input");
      input.type = "checkbox"; input.checked = checked; input.dataset.missingRecordChoice = scope;
      const text = document.createElement("span"); text.textContent = copy;
      label.append(input, text);
      return { label, input };
    };
    const current = choice("current", translated("archiver.missingDismissCurrent", state.language === "en" ? "Clear the current record" : "删除当前条目记录"), true);
    const all = choice("all", translated("archiver.missingDismissAll", state.language === "en" ? "Clear all missing-file records" : "删除所有文件缺失条目"), false);
    choices.append(current.label, message, all.label);
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = translated("reader.cancel", state.language === "en" ? "Cancel" : "取消");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = translated("archiver.clearSourceRecord", state.language === "en" ? "Clear Record" : "清除记录");
    confirm.dataset.missingRecordConfirm = "";
    const update = () => { confirm.disabled = !current.input.checked && !all.input.checked; };
    current.input.addEventListener("change", update); all.input.addEventListener("change", update);
    footer.append(cancel, confirm);
    dialog.append(title, facts, choices, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const finish = (accepted) => { layer.remove(); previousFocus?.focus?.(); resolve(accepted); };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => { if (!confirm.disabled) finish({ all_missing: all.input.checked }); });
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) finish(false); });
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); });
    cancel.focus();
  });
}

function showActionError(error) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog cloudig-dialog-danger";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = translated("reader.actionFailed", state.language === "en" ? "Action not completed" : "操作未完成");
    const message = document.createElement("p");
    message.textContent = error?.message ?? translated("reader.actionFailedMessage", state.language === "en" ? "Refresh the archive list and try again." : "请刷新档案列表后重试。");
    const footer = document.createElement("footer");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cloudig-button cloudig-button-filled";
    close.textContent = translated("reader.close", state.language === "en" ? "Close" : "关闭");
    footer.append(close);
    dialog.append(title, message, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const finish = () => { layer.remove(); resolve(); };
    close.addEventListener("click", finish);
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(); });
    close.focus();
  });
}

function showMarkdownExportResult(items, failed) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = translated("reader.exportMarkdownComplete", state.language === "en" ? "Markdown Export Complete" : "Markdown导出完成");
    const message = document.createElement("p");
    const complete = translated("reader.exportMarkdownMessage", state.language === "en" ? "The following frozen files were created in Exports:" : "已在 Exports 中生成以下冻结成果：");
    const partial = translated("reader.exportMarkdownFailed", state.language === "en" ? "Some archives could not be exported" : "部分档案未能导出");
    message.textContent = failed > 0 ? `${complete} ${partial} (${failed})。` : complete;
    const list = document.createElement("ul");
    list.className = "cloudig-dialog-list";
    list.dataset.scrollRegion = "";
    for (const item of items) {
      const row = document.createElement("li");
      const filename = document.createElement("strong");
      filename.textContent = item.filename;
      filename.title = item.filename;
      const count = document.createElement("span");
      count.textContent = state.language === "en" ? `${item.messages} messages` : `${item.messages} 条消息`;
      row.append(filename, count);
      list.append(row);
    }
    const footer = document.createElement("footer");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cloudig-button cloudig-button-outline";
    close.textContent = translated("reader.close", state.language === "en" ? "Close" : "关闭");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "cloudig-button cloudig-button-filled";
    open.textContent = translated("reader.openExports", state.language === "en" ? "Open Exports" : "打开Exports");
    footer.append(close, open);
    dialog.append(title, message, list, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const finish = (value) => { layer.remove(); previousFocus?.focus?.(); resolve(value); };
    close.addEventListener("click", () => finish(false));
    open.addEventListener("click", () => finish(true));
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); });
    close.focus();
  });
}

function showTextEntry({ title, message, label, initial = "", confirmCopy }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("h2");
    heading.textContent = title;
    const copy = document.createElement("p");
    copy.textContent = message;
    const field = document.createElement("label");
    field.className = "cloudig-dialog-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 256;
    input.value = initial;
    field.append(caption, input);
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = translated("reader.cancel", state.language === "en" ? "Cancel" : "取消");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = confirmCopy;
    footer.append(cancel, confirm);
    dialog.append(heading, copy, field, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const valid = () => {
      const value = input.value.trim();
      confirm.disabled = value.length === 0 || /[\\/:*?"<>|]/u.test(value) || value === "." || value === "..";
    };
    const close = (value) => { layer.remove(); previousFocus?.focus?.(); resolve(value); };
    input.addEventListener("input", valid);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !confirm.disabled) close(input.value.trim()); });
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", () => close(input.value.trim()));
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") close(null); });
    valid();
    input.focus();
    input.select();
  });
}

function showDirectoryChoice(rows, directories, action) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const english = state.language === "en";
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = action === "restore" ? (english ? "Restore Archives" : "恢复归档") : (english ? "Move Archives" : "移动档案");
    const message = document.createElement("p");
    message.textContent = english ? `Choose a target for ${rows.length} exact archive file(s).` : `为 ${rows.length} 份精确档案选择目标目录。`;
    const choices = document.createElement("div");
    choices.className = "cloudig-dialog-choices";
    let selected = "root";
    for (const directory of [{ capability: "root", name: english ? "Conversation root" : "对话根目录" }, ...directories]) {
      const label = document.createElement("label");
      label.className = "cloudig-choice";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `cloudig-directory-${ordinal + 1}`;
      radio.value = directory.capability;
      radio.checked = directory.capability === selected;
      radio.addEventListener("change", () => { selected = radio.value; });
      const name = document.createElement("span");
      name.textContent = directory.name;
      label.append(radio, name);
      choices.append(label);
    }
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = english ? "Cancel" : "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = english ? "Continue" : "继续";
    footer.append(cancel, confirm);
    dialog.append(title, message, choices, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const close = (value) => { layer.remove(); previousFocus?.focus?.(); resolve(value); };
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", () => close(selected));
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") close(null); });
    choices.querySelector("input")?.focus();
  });
}

function directoryCreateErrorMessage(reason, english) {
  const code = String(reason?.code ?? "");
  const message = String(reason?.message ?? "");
  if (/EEXIST|already exists?|duplicate/iu.test(`${code} ${message}`)) {
    return english ? "A directory with this name already exists." : "已经存在同名目录。";
  }
  if (/ENAMETOOLONG|too long/iu.test(`${code} ${message}`)) {
    return english ? "The directory name is too long." : "目录名称过长。";
  }
  if (/invalid|not allowed|reserved|safe windows leaf/iu.test(`${code} ${message}`)) {
    return english ? "This directory name is not allowed by Windows." : "目录名称含有 Windows 不允许的字符或格式。";
  }
  return message || (english ? "The directory could not be created." : "未能建立目录。");
}

function dialogCloseIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"></path></svg>';
}

function showDirectoryCreator(callback) {
  const previousFocus = document.activeElement;
  const english = state.language === "en";
  const layer = document.createElement("div");
  layer.className = "cloudig-dialog-layer reader-directory-create-layer";
  const dialog = document.createElement("section");
  dialog.className = "reader-directory-create-dialog";
  dialog.id = "reader-directory-create-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "reader-directory-create-title");
  const form = document.createElement("form");
  form.noValidate = true;
  const header = document.createElement("header");
  const heading = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "NEW DIRECTORY";
  const title = document.createElement("h2");
  title.id = "reader-directory-create-title";
  title.textContent = english ? "New Directory" : "新建目录";
  heading.append(eyebrow, title);
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "reader-directory-create-close";
  closeButton.innerHTML = dialogCloseIcon();
  closeButton.setAttribute("aria-label", english ? "Close new directory" : "关闭新建目录");
  header.append(heading, closeButton);
  const message = document.createElement("p");
  message.textContent = english
    ? "Create a first-level directory in Conversations. It only organizes conversations and does not change their titles or identity."
    : "在 Conversations 中建立一级目录；目录只整理会话位置，不改变会话标题或身份。";
  const field = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = english ? "Directory name" : "目录名称";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 80;
  input.autocomplete = "off";
  input.required = true;
  field.append(caption, input);
  const error = document.createElement("p");
  error.className = "reader-directory-create-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const footer = document.createElement("footer");
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "reader-directory-create-cancel";
  cancelButton.textContent = english ? "Cancel" : "取消";
  const createButton = document.createElement("button");
  createButton.type = "submit";
  createButton.className = "reader-directory-create-save";
  createButton.textContent = english ? "Create" : "建立目录";
  footer.append(cancelButton, createButton);
  form.append(header, message, field, error, footer);
  dialog.append(form);
  layer.append(dialog);
  overlayRoot.append(layer);

  let closed = false;
  const finish = (value = false) => {
    if (closed) return;
    closed = true;
    layer.remove();
    previousFocus?.focus?.();
    return value;
  };
  const showError = (value) => {
    error.textContent = String(value || (english ? "The directory could not be created." : "未能建立目录。"));
    error.hidden = false;
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      showError(english ? "Enter a directory name." : "请输入目录名称。");
      input.focus();
      return;
    }
    error.hidden = true;
    input.disabled = true;
    createButton.disabled = true;
    try {
      await callback(name);
      finish(true);
    } catch (reason) {
      input.disabled = false;
      createButton.disabled = false;
      showError(directoryCreateErrorMessage(reason, english));
      input.focus();
      input.select();
    }
  });
  closeButton.addEventListener("click", () => finish(false));
  cancelButton.addEventListener("click", () => finish(false));
  layer.addEventListener("pointerdown", (event) => { if (event.target === layer) finish(false); });
  layer.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); });
  input.focus();
}

function showDirectoryManager(directories, callbacks, initialMode = "manage") {
  const previousFocus = document.activeElement;
  const english = state.language === "en";
  const layer = document.createElement("div");
  layer.className = "cloudig-dialog-layer";
  const dialog = document.createElement("section");
  dialog.className = "reader-directory-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const card = document.createElement("form");
  card.className = "reader-directory-card";
  card.noValidate = true;
  const header = document.createElement("header");
  header.className = "reader-directory-header";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "DIRECTORY MANAGEMENT";
  const title = document.createElement("h2");
  title.textContent = english ? "Manage Directories" : "管理目录";
  heading.append(eyebrow, title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "reader-directory-close";
  close.innerHTML = dialogCloseIcon();
  close.setAttribute("aria-label", english ? "Close directory manager" : "关闭目录管理");
  header.append(heading, close);
  const message = document.createElement("p");
  message.className = "reader-directory-intro";
  message.textContent = english
    ? "Directories only organize archive locations. They do not change archive identity, title or user edits."
    : "目录只整理会话位置，不改变会话身份、标题或用户编辑。";
  const layout = document.createElement("div");
  layout.className = "reader-directory-layout";
  const listPane = document.createElement("section");
  listPane.className = "reader-directory-list-pane";
  const listHeader = document.createElement("header");
  const listTitle = document.createElement("strong");
  listTitle.append(document.createTextNode(english ? "User directories " : "用户目录 "));
  const count = document.createElement("b");
  const create = document.createElement("button");
  create.type = "button";
  create.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"></path></svg><span>${english ? "New directory" : "新建目录"}</span>`;
  listTitle.append(count);
  listHeader.append(listTitle, create);
  const list = document.createElement("div");
  list.className = "reader-directory-list";
  list.setAttribute("role", "listbox");
  list.dataset.scrollRegion = "";
  const empty = document.createElement("p");
  empty.className = "reader-directory-empty";
  empty.textContent = english ? "No directories yet." : "尚未建立目录。";
  listPane.append(listHeader, list, empty);
  const editPane = document.createElement("section");
  editPane.className = "reader-directory-edit-pane";
  const editorEmpty = document.createElement("div");
  editorEmpty.className = "reader-directory-editor-empty";
  editorEmpty.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5 13h16l5 6h17v22H5z"></path><path d="M5 19h38"></path></svg><strong>${english ? "Choose a directory" : "选择一个目录进行管理"}</strong><span>${english ? "You can also create one. Only a completely empty directory can be deleted." : "也可以新建目录；只有完全空的目录可以删除。"}</span>`;
  const editor = document.createElement("div");
  editor.className = "reader-directory-editor";
  editor.hidden = true;
  const mode = document.createElement("span");
  mode.className = "eyebrow";
  const label = document.createElement("label");
  const labelCopy = document.createElement("span");
  labelCopy.textContent = english ? "Directory name" : "目录名称";
  const input = document.createElement("input");
  input.maxLength = 80;
  input.autocomplete = "off";
  input.required = true;
  label.append(labelCopy, input);
  const facts = document.createElement("dl");
  facts.className = "reader-directory-facts";
  const filesFact = document.createElement("div");
  const filesTerm = document.createElement("dt");
  filesTerm.textContent = english ? "Conversations" : "对话数";
  const filesValue = document.createElement("dd");
  const sizeFact = document.createElement("div");
  const sizeTerm = document.createElement("dt");
  sizeTerm.textContent = english ? "Folder size" : "文件夹大小";
  const sizeValue = document.createElement("dd");
  filesFact.append(filesTerm, filesValue);
  sizeFact.append(sizeTerm, sizeValue);
  facts.append(filesFact, sizeFact);
  const error = document.createElement("p");
  error.className = "reader-directory-error";
  error.hidden = true;
  error.setAttribute("role", "alert");
  editor.append(mode, label, facts, error);
  editPane.append(editorEmpty, editor);
  layout.append(listPane, editPane);
  const footer = document.createElement("footer");
  footer.className = "reader-directory-actions-row";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "reader-directory-delete";
  remove.textContent = english ? "Delete empty directory" : "删除空目录";
  const spacer = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "reader-directory-cancel";
  cancel.textContent = english ? "Cancel" : "取消";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "reader-directory-save";
  save.textContent = english ? "Save" : "保存";
  footer.append(remove, spacer, cancel, save);
  card.append(header, message, layout, footer);
  dialog.append(card);
  layer.append(dialog);
  overlayRoot.append(layer);

  let selected = null;
  let editing = initialMode === "new" ? "create" : "none";
  const bytesLabel = (value) => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  };
  const finish = (value = false) => { layer.remove(); previousFocus?.focus?.(); return value; };
  const showEditor = () => {
    const active = editing !== "none";
    editor.hidden = !active;
    editorEmpty.hidden = active;
    remove.disabled = editing !== "edit" || (selected?.count ?? 0) !== 0;
    save.disabled = !active;
    if (!active) return;
    mode.textContent = editing === "create" ? "NEW DIRECTORY" : "EDIT DIRECTORY";
    input.value = editing === "create" ? "" : selected?.name ?? "";
    filesValue.textContent = String(editing === "create" ? 0 : selected?.count ?? 0);
    sizeValue.textContent = bytesLabel(editing === "create" ? 0 : selected?.bytes ?? 0);
    error.hidden = true;
    requestAnimationFrame(() => input.focus());
  };
  const render = () => {
    list.replaceChildren();
    count.textContent = String(directories.length);
    empty.hidden = directories.length !== 0;
    for (const directory of directories) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "reader-directory-row";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(selected?.capability === directory.capability));
      item.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5 13h16l5 6h22v24H5z"></path><path d="M5 19h43"></path></svg><span><strong></strong><small></small></span>`;
      item.querySelector("strong").textContent = directory.name;
      item.querySelector("small").textContent = english ? `${directory.count ?? 0} conversations` : `${directory.count ?? 0} 篇对话`;
      item.addEventListener("click", () => {
        selected = directory;
        editing = "edit";
        render();
        showEditor();
      });
      list.append(item);
    }
  };
  create.addEventListener("click", () => { selected = null; editing = "create"; render(); showEditor(); });
  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) { error.textContent = english ? "Enter a directory name." : "请输入目录名称。"; error.hidden = false; return; }
    const ok = editing === "create" ? await callbacks.create(name) : await callbacks.rename(selected, name);
    if (!ok) return;
    finish(true);
  });
  remove.addEventListener("click", async () => {
    if (!selected || (selected.count ?? 0) !== 0) return;
    if (!(await callbacks.remove(selected))) return;
    directories = directories.filter((entry) => entry.capability !== selected.capability);
    selected = null;
    editing = "none";
    render();
    showEditor();
  });
  close.addEventListener("click", () => finish(false));
  cancel.addEventListener("click", () => finish(false));
  layer.addEventListener("pointerdown", (event) => { if (event.target === layer) finish(false); });
  layer.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); });
  render();
  showEditor();
  if (editing === "none") close.focus();
}

function applyNames() {
  for (const node of document.querySelectorAll("[data-identity-name='user']")) {
    node.textContent = state.userName;
    node.title = state.userName;
  }
  for (const node of document.querySelectorAll("[data-identity-name='assistant']")) {
    node.textContent = state.assistantName;
    node.title = state.assistantName;
  }
  const userAvatar = state.userAvatar?.kind === "application" ? applicationAsset(state.userAvatar.asset) : state.userAvatarUrl;
  const assistantAvatar = state.assistantAvatar?.kind === "application" ? applicationAsset(state.assistantAvatar.asset) : state.assistantAvatarUrl;
  if (userAvatar) for (const node of document.querySelectorAll("[data-reader-user-avatar], .welcome-identity-user .welcome-avatar")) node.src = userAvatar;
  if (assistantAvatar) for (const node of document.querySelectorAll("[data-reader-assistant-avatar], .welcome-identity-assistant .welcome-avatar")) node.src = assistantAvatar;
  for (const node of document.querySelectorAll(".welcome-identity-name, .reader-scene-identity strong")) {
    node.dataset.nameOverflow = String(node.clientWidth > 0 && node.scrollWidth > node.clientWidth);
  }
}

function applyLocale(values = currentLocale) {
  if (!values) return;
  root.lang = state.language;
  for (const image of document.querySelectorAll("img[data-brand-english]")) {
    image.dataset.brandChinese ??= image.getAttribute("src");
    image.src = state.language === "en" ? image.dataset.brandEnglish : image.dataset.brandChinese;
    image.alt = state.language === "en" ? "Cloudig" : "采云";
  }
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const value = valueAt(values, node.dataset.i18n);
    if (typeof value === "string") node.textContent = value;
  }
  for (const node of document.querySelectorAll("[data-i18n-title]")) {
    const value = valueAt(values, node.dataset.i18nTitle);
    if (typeof value === "string") {
      node.title = value;
      node.setAttribute("aria-label", value);
    }
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    const value = valueAt(values, node.dataset.i18nPlaceholder);
    if (typeof value === "string") node.placeholder = value;
  }
  applyNames();
  if (!currentRoute.startsWith("reader/conversation/")) currentPage?.updateState?.(state);
  activeConversation?.controller.updateState?.(state);
  activeTimeCover?.updateState?.(state);
  activeTimeEditor?.updateLanguage?.(state.language);
  activeConversationInfo?.updateLanguage?.(state.language);
  activeDocument?.updateLanguage(state.language);
}

function pageSurface() {
  if (currentRoute === "welcome") return "welcome";
  if (currentRoute === "system/log") {
    const returnRoute = activeSystemLog?.returnRoute ?? "reader/cover";
    return returnRoute.startsWith("archiver") ? "archiver" : returnRoute.startsWith("reader/") ? "reader" : "welcome";
  }
  if (currentRoute.startsWith("reader/")) return "reader";
  if (currentRoute.startsWith("archiver")) return "archiver";
  // Editors are overlays on the current page, not a return to Welcome chrome.
  const underlying = app.querySelector("[data-page]")?.dataset.page;
  return ["reader", "archiver"].includes(underlying) ? underlying : "welcome";
}

function applyTheme() {
  root.dataset.theme = state.theme;
  root.dataset.themeDiscovery = state.themeSwitched ? "false" : "true";
  const surface = pageSurface();
  app.dataset.surface = surface;
  request("shell.surface", { page: surface, theme: state.theme }).catch(() => undefined);
  if (!currentRoute.startsWith("reader/conversation/")) currentPage?.updateState?.(state);
  activeConversation?.controller.updateState?.(state);
  activeTimeCover?.updateState?.(state);
  activeTimeEditor?.updateLanguage?.(state.language);
}

function resizeWelcome() {
  // Above-design growth is owned by the desktop WebView scale; this only fits smaller CSS viewports.
  if (!document.querySelector("[data-page='welcome']")) return;
  root.style.setProperty("--welcome-scale", String(Math.min(1, innerWidth / 1920, innerHeight / 1080)));
}

function preload(urls) {
  return Promise.all([...new Set(urls)].map((url) => new Promise((resolve) => {
    const preloadImage = new Image();
    preloadImage.onload = preloadImage.onerror = resolve;
    preloadImage.src = url;
  })));
}

function themeImages(theme) {
  return theme === "star-night"
    ? ["/assets/welcome/Back-Abyss-1920.png", "/assets/welcome/Back-Horizon-1920.png"]
    : ["/assets/welcome/Back-Light-start-1920.png", "/assets/welcome/Back-Light-1920.png"];
}

function preferenceState(result) {
  return {
    revision: result.revision,
    theme: result.theme,
    language: result.language,
    themeSwitched: result.theme_switched,
    userName: result.user_name,
    assistantName: result.assistant_name,
    userNameCustom: state.userNameCustom,
    assistantNameCustom: state.assistantNameCustom,
    userAvatar: state.userAvatar,
    assistantAvatar: state.assistantAvatar,
    userAvatarUrl: state.userAvatarUrl,
    assistantAvatarUrl: state.assistantAvatarUrl,
    parseOrdinary: result.parse_ordinary ?? { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false },
    parseClaude: result.parse_claude ?? { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false },
    defaultOutputDirectory: result.default_output_directory ?? "Conversations",
    workflowParser: result.workflow_parser ?? { sort: "time_desc" },
    workflowArchiver: normalizeArchiveWorkflow(result.workflow_archiver),
    workflowReader: normalizeArchiveWorkflow(result.workflow_reader),
    workflowClaude: result.workflow_claude ?? { sort: "time_desc", time_field: "updated_at" }
  };
}

async function refreshShellIdentity(model = null) {
  const value = model ?? await request("identity.query", {});
  state.userName = value.global.user.resolved_name;
  state.assistantName = value.global.assistant.resolved_name;
  state.userNameCustom = typeof value.global.user.name === "string";
  state.assistantNameCustom = typeof value.global.assistant.name === "string";
  state.userAvatar = value.global.user.resolved_avatar;
  state.assistantAvatar = value.global.assistant.resolved_avatar;
  state.userAvatarUrl = value.global.user.resolved_avatar.kind === "managed"
    ? `https://cloudig-runtime.local${(await request("identity.avatar.resolve", { avatar: value.global.user.resolved_avatar.capability })).virtual_path}`
    : null;
  state.assistantAvatarUrl = value.global.assistant.resolved_avatar.kind === "managed"
    ? `https://cloudig-runtime.local${(await request("identity.avatar.resolve", { avatar: value.global.assistant.resolved_avatar.capability })).virtual_path}`
    : null;
  applyNames();
  return value;
}

async function setOrdinaryParse(parseOrdinary, directory) {
  if (state.revision !== null) {
    state = preferenceState(await commitPreferencePatch(request, { parse_ordinary: parseOrdinary, ...(directory ? { default_output_directory: directory } : {}) }));
  } else {
    state.parseOrdinary = { ...parseOrdinary };
    if (directory) state.defaultOutputDirectory = directory;
  }
  currentPage?.updateState?.(state);
  return state.parseOrdinary;
}

async function setClaudePreferences(parseClaude, workflowClaude, directory) {
  if (state.revision !== null) {
    state = preferenceState(await commitPreferencePatch(request, {
      parse_claude: parseClaude,
      workflow_claude: workflowClaude,
      ...(directory ? { default_output_directory: directory } : {})
    }));
  } else {
    state.parseClaude = { ...parseClaude };
    state.workflowClaude = { ...workflowClaude };
    if (directory) state.defaultOutputDirectory = directory;
  }
  currentPage?.updateState?.(state);
  return { parse: state.parseClaude, workflow: state.workflowClaude };
}

async function setArchiveWorkflow(kind, workflow) {
  const property = kind === "reader" ? "workflowReader" : "workflowArchiver";
  const payload = kind === "reader" ? "workflow_reader" : "workflow_archiver";
  const normalized = normalizeArchiveWorkflow(workflow);
  if (state.revision !== null) {
    state = preferenceState(await commitPreferencePatch(request, { [payload]: normalized }));
  } else {
    state[property] = normalized;
  }
  currentPage?.updateState?.(state);
  return state[property];
}

async function setTheme(theme) {
  if (theme === state.theme) return;
  const buttons = [...document.querySelectorAll("[data-action='toggle-theme']")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await preload(currentRoute === "welcome" ? themeImages(theme)
      : currentRoute.startsWith("reader/") ? readerCoverPreload
      : currentRoute.startsWith("archiver") ? archiverPreload : []);
    if (state.revision !== null) {
      state = preferenceState(await commitPreferencePatch(request, { theme }));
    } else {
      state.theme = theme;
      state.themeSwitched = true;
    }
    applyTheme();
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function setLanguage(language) {
  if (language === state.language) return;
  const values = await locale(language);
  if (state.revision !== null) {
    state = preferenceState(await commitPreferencePatch(request, { language }));
    await refreshShellIdentity();
  } else {
    state.language = language;
    state.userName = language === "en" ? "User" : "采云用户";
    state.assistantName = language === "en" ? "AI" : "智能伙伴";
  }
  currentLocale = values;
  applyLocale();
}

function fixtureQuery(payload) {
  const source = visualReaderFixture();
  const platforms = new Set(payload.platforms ?? []);
  const directory = typeof payload.directory === "string" ? payload.directory : null;
  const search = String(payload.search ?? "").trim().normalize("NFKC").toLocaleLowerCase("und");
  let items = source.items.filter((row) => {
    if (payload.platforms !== undefined && !platforms.has(row.platform)) return false;
    if (directory && row.directory !== directory) return false;
    return search.length === 0 || String(row.title).normalize("NFKC").toLocaleLowerCase("und").includes(search)
      || String(row.filename).normalize("NFKC").toLocaleLowerCase("und").includes(search);
  });
  if (payload.sort === "title") items = items.toSorted((left, right) => String(left.title).localeCompare(String(right.title), "zh-CN"));
  else if (payload.sort === "content_desc") items = items.toReversed();
  return {
    degraded: false,
    offset: payload.offset ?? 0,
    limit: payload.limit,
    total: search.length === 0 && payload.platforms === undefined && directory === null ? source.total : items.length,
    catalog_total: source.catalog_total,
    directories: source.directories,
    items: items.slice(payload.offset ?? 0, (payload.offset ?? 0) + payload.limit)
  };
}

let unsupportedRecordsNotice = "";
async function queryArchives(payload) {
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") === "sample") return fixtureQuery(payload);
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") === "empty") {
    return { degraded: false, offset: 0, limit: payload.limit, total: 0, catalog_total: 0, directories: [], items: [] };
  }
  let result = await request("reader.archives.query", payload);
  if (result.degraded) {
    await ensureIndexes();
    const { directory, directories, ...freshQuery } = payload;
    result = await request("reader.archives.query", freshQuery);
  }
  const unsupported = (result.issues ?? []).filter(issue => issue.code === "CLOUDIG_RECORD_SCHEMA_UNSUPPORTED").map(issue => issue.path).sort();
  const signature = JSON.stringify(unsupported);
  if (unsupported.length && signature !== unsupportedRecordsNotice) {
    const english = state.language === "en";
    showForegroundNotice(english ? "Some files need a compatible Cloudig version" : "部分文件需要兼容的数据标准版本",
      (english ? `${unsupported.length} files were not opened. Please update Cloudig. Originals were preserved.\n` : `${unsupported.length} 份文件尚未打开，请更新采云或使用支持该标准的版本。原文件未改写。\n`) + unsupported.slice(0, 3).join("\n"), 0);
  }
  unsupportedRecordsNotice = signature;
  return result;
}

async function querySources(payload) {
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real") {
    return screenshotQuery.get("fixture") === "empty" ? visualArchiverEmptyFixture().sources : visualArchiverFixture().sources;
  }
  return request("archiver.sources.query", payload);
}

async function queryClaudeRecords(payload) {
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real" && screenshotQuery.get("route") === "claude") {
    const fixture = visualClaudeContainerFixture();
    const search = String(payload.search ?? "").trim().toLocaleLowerCase("und");
    const statuses = new Set(payload.statuses ?? []);
    let items = fixture.items.filter((row) => (!search || row.title.toLocaleLowerCase("und").includes(search)) && (statuses.size === 0 || statuses.has(row.status)));
    items = items.toSorted((left, right) => {
      if (payload.sort === "title") return left.title.localeCompare(right.title, "und") * (payload.direction === "asc" ? 1 : -1);
      const field = payload.time_field === "created_at" ? "created_at" : "updated_at";
      return String(left[field]).localeCompare(String(right[field])) * (payload.direction === "asc" ? 1 : -1);
    });
    return { ...fixture, visible: items.length, offset: payload.offset, items: items.slice(payload.offset, payload.offset + payload.limit) };
  }
  return request("archiver.claude.records.query", payload);
}

async function queryArchiverArchives(payload) {
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real") {
    return screenshotQuery.get("fixture") === "empty" ? visualArchiverEmptyFixture().archives : visualArchiverFixture().archives;
  }
  return queryArchives(payload);
}

async function ensureIndexes() {
  if (!indexRebuildPromise) {
    const operation = beginRequest(
      "indexes.rebuild",
      {},
      (event) => currentPage?.setProgress?.(event, [])
    );
    indexRebuildPromise = operation.promise.finally(() => {
      currentPage?.clearProgress?.();
      indexRebuildPromise = null;
    });
  }
  return indexRebuildPromise;
}

async function archiverModel() {
  const workflow = normalizeArchiveWorkflow(state.workflowArchiver);
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real") {
    return screenshotQuery.get("fixture") === "empty" ? visualArchiverEmptyFixture() : visualArchiverFixture();
  }
  let [sources, archives, library] = await Promise.all([
    querySources({ offset: 0, limit: 200, sort: "captured_desc" }),
    queryArchiverArchives({ offset: 0, limit: 200, search: "", sort: archiveQuerySort(workflow.sort), time_field: archiveQueryTimeField(workflow.time_field), archived: false }),
    request("shell.library.info", {})
  ]);
  if (archives.degraded) {
    await ensureIndexes();
    [sources, archives] = await Promise.all([
      querySources({ offset: 0, limit: 200, sort: "captured_desc" }),
      queryArchiverArchives({ offset: 0, limit: 200, search: "", sort: archiveQuerySort(workflow.sort), time_field: archiveQueryTimeField(workflow.time_field), archived: false })
    ]);
  }
  return { sources, archives, bookmarks: bookmarkPlaceholder("light"), library };
}

function displayBytes(value) {
  if (!Number.isFinite(value) || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function showLibraryMoveProgress(title) {
  const layer = document.createElement("div");
  layer.className = "cloudig-dialog-layer";
  const dialog = document.createElement("section");
  dialog.className = "cloudig-dialog cloudig-library-move-progress";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const stage = document.createElement("p");
  const progress = document.createElement("progress");
  const counter = document.createElement("small");
  const footer = document.createElement("footer");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cloudig-button cloudig-button-outline";
  cancel.textContent = translated("reader.cancel", state.language === "en" ? "Cancel" : "取消");
  footer.append(cancel);
  dialog.append(heading, stage, progress, counter, footer);
  layer.append(dialog);
  overlayRoot.append(layer);
  let cancelAction = null;
  cancel.addEventListener("click", () => { cancel.disabled = true; cancelAction?.(); });
  cancel.focus();
  return {
    update(event) {
      const phases = state.language === "en" ? {
        plan: "Reading the current Library…",
        "source-verify": "Verifying the original Library…",
        copy: "Copying the complete Library…",
        "target-verify": "Verifying the new Library byte for byte…",
        "source-final": "Confirming the original Library has not changed…",
        "cleanup-verify-target": "Verifying the current Library…",
        "cleanup-verify-source": "Verifying the old Library before cleanup…",
        cleanup: "Removing the verified old Library…"
      } : {
        plan: "正在读取整座资料库…",
        "source-verify": "正在复核原资料库…",
        copy: "正在复制整座资料库…",
        "target-verify": "正在逐字节核验新资料库…",
        "source-final": "正在确认原资料库没有变化…",
        "cleanup-verify-target": "正在复核当前资料库…",
        "cleanup-verify-source": "正在清理前复核原资料库…",
        cleanup: "正在移除已核验的原资料库…"
      };
      stage.textContent = phases[event?.phase] ?? (state.language === "en" ? "Moving the Library…" : "正在整体搬迁资料库…");
      if (Number.isFinite(event?.total_bytes) && event.total_bytes > 0) {
        progress.max = event.total_bytes;
        progress.value = event.completed_bytes ?? 0;
      } else progress.removeAttribute("value");
      counter.textContent = Number.isFinite(event?.total_files)
        ? `${displayBytes(event.completed_bytes ?? 0)} / ${displayBytes(event.total_bytes ?? 0)} · ${event.completed_files ?? 0} / ${event.total_files}`
        : "";
    },
    onCancel(action) { cancelAction = action; },
    close() { layer.remove(); }
  };
}

function showLibraryMoveConfirmation(plan) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("h2");
    heading.textContent = state.language === "en" ? "Move the Complete Library" : "整体搬迁资料库";
    const message = document.createElement("p");
    message.textContent = state.language === "en"
      ? "Cloudig will close, move the entire folder including the app and your data, verify it, and reopen at the new location. This may take a while. The estimate excludes temporary cache; the final file list is frozen after closing."
      : "确认后采云会关闭，将程序与资料一起整体搬迁，核验后在新位置重开，可能需要等待一段时间。此处估算不含临时缓存，最终清单以退出后为准。";
    const facts = document.createElement("dl");
    for (const [label, value] of [
      [state.language === "en" ? "Current" : "当前位置", plan.source],
      [state.language === "en" ? "Target" : "目标位置", plan.target],
      [state.language === "en" ? "Content" : "搬迁内容", `${plan.files} · ${displayBytes(plan.bytes)}`]
    ]) {
      const key = document.createElement("dt");
      key.textContent = label;
      const item = document.createElement("dd");
      item.textContent = value;
      item.title = value;
      facts.append(key, item);
    }
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = translated("reader.cancel", state.language === "en" ? "Cancel" : "取消");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = state.language === "en" ? "Move Library" : "开始搬迁";
    footer.append(cancel, confirm);
    dialog.append(heading, message, facts, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const finish = (accepted) => { layer.remove(); resolve(accepted); };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); });
    cancel.focus();
  });
}

async function moveCurrentLibrary() {
  const planning = showLibraryMoveProgress(state.language === "en" ? "Preparing Library Move" : "准备搬迁资料库");
  let operation = beginRequest("shell.libraryMove.plan", {}, (event) => planning.update(event));
  planning.onCancel(() => operation.cancel());
  let plan;
  try { plan = await operation.promise; }
  finally { planning.close(); }
  if (plan.cancelled || !(await showLibraryMoveConfirmation(plan))) return false;
  const moving = showLibraryMoveProgress(state.language === "en" ? "Moving the Complete Library" : "整体搬迁资料库");
  operation = beginRequest("shell.libraryMove.commit", { plan: plan.plan }, (event) => moving.update(event));
  moving.onCancel(() => operation.cancel());
  try {
    const result = await operation.promise;
    if (result.status === "restarting") return true;
    currentPage?.setLibraryLabel?.(result.display_path);
    await currentPage?.refreshAll?.();
    showForegroundNotice(
      state.language === "en" ? "Library moved" : "资料库搬迁完成",
      result.cleanup === "complete"
        ? result.display_path
        : (state.language === "en" ? "The new Library is current, but the old folder could not be fully removed." : "新资料库已成为当前位置，但原文件夹未能完全清理。")
    );
    return result.cleanup === "complete";
  } finally {
    moving.close();
  }
}

function bookmarkError(error) {
  const english = state.language === "en";
  const values = english ? {
    CLOUDIG_CHROME_OPEN: "Exit every Google Chrome window before installing, updating or removing bookmarklets.",
    CLOUDIG_CHROME_STATE_UNKNOWN: "Cloudig could not verify that Chrome is closed, so no bookmark file was changed.",
    CLOUDIG_CHROME_PROFILE_MISSING: "No Chrome bookmark profile is available. Open Chrome once, then refresh.",
    CLOUDIG_BOOKMARK_SETTINGS_INVALID: "Cloudig bookmark settings are unavailable or use an unsupported version.",
    CLOUDIG_BOOKMARK_SETTINGS_SAVE_FAILED: "Chrome bookmarks were updated, but Cloudig could not finish saving the installation settings. Retry the same operation to complete them.",
    CLOUDIG_BOOKMARK_RECOVERY_REQUIRED: "The bookmark operation failed and some files could not be restored automatically. Keep the current bookmarks and the backups in appdata/BookmarkBackups; inspect the unfinished backup before making further changes.",
    CLOUDIG_BOOKMARK_DATA_INVALID: "Chrome bookmark data failed validation. No bookmark file was changed.",
    CLOUDIG_BOOKMARK_PACKAGE_MISSING: "The packaged Cloudig bookmarklets are missing or incomplete."
  } : {
    CLOUDIG_CHROME_OPEN: "请先退出全部 Google Chrome 窗口，再安装、更新或卸载书签。",
    CLOUDIG_CHROME_STATE_UNKNOWN: "采云无法确认 Chrome 已退出，因此没有改动任何书签文件。",
    CLOUDIG_CHROME_PROFILE_MISSING: "没有找到可用的 Chrome 书签配置。请先打开一次 Chrome，再刷新。",
    CLOUDIG_BOOKMARK_SETTINGS_INVALID: "采云书签设置不可用，或来自不支持的版本。",
    CLOUDIG_BOOKMARK_SETTINGS_SAVE_FAILED: "Chrome 书签已更新，但采云未能保存完整安装记录。请重试刚才的操作，以补全记录。",
    CLOUDIG_BOOKMARK_RECOVERY_REQUIRED: "书签操作失败，部分文件未能自动恢复。请保留当前书签和 appdata/BookmarkBackups 内的备份；检查未完成备份后再操作，不要继续覆盖。",
    CLOUDIG_BOOKMARK_DATA_INVALID: "Chrome 书签数据未通过校验，没有改动任何书签文件。",
    CLOUDIG_BOOKMARK_PACKAGE_MISSING: "采云随包书签缺失或不完整。"
  };
  return new Error(values[error?.code] ?? error?.message ?? (english ? "The bookmark operation was not completed." : "书签操作未能完成。"));
}

function libraryMoveError(error) {
  const english = state.language === "en";
  const values = english ? {
    CLOUDIG_LIBRARY_MOVE_TEST_ROOT: "This is an isolated test data directory. Start from a complete portable Cloudig folder to move the app and data together.",
    CLOUDIG_LIBRARY_MOVE_TARGET_INVALID: "Choose an empty ordinary folder outside the current Cloudig Library.",
    CLOUDIG_LIBRARY_MOVE_ACCESS_DENIED: "Cloudig cannot read or write the selected location.",
    CLOUDIG_LIBRARY_MOVE_PLAN_STALE: "The Library or target changed. Choose the target again.",
    CLOUDIG_LIBRARY_MOVE_CONFLICT: "The Library changed during verification. Nothing was switched.",
    CLOUDIG_LIBRARY_BUSY: "Finish the current Cloudig operation before moving the Library.",
    CLOUDIG_LIBRARY_MOVE_ROLLBACK_FAILED: "The move failed and Cloudig could not automatically restore the running Library. Keep both folders and inspect them before changing anything."
  } : {
    CLOUDIG_LIBRARY_MOVE_TEST_ROOT: "当前是与程序分开的测试资料目录。整体搬家须从完整采云文件夹启动，不能只搬测试数据。",
    CLOUDIG_LIBRARY_MOVE_TARGET_INVALID: "请选择当前采云资料库之外的普通空文件夹。",
    CLOUDIG_LIBRARY_MOVE_ACCESS_DENIED: "采云无法读取或写入所选位置。",
    CLOUDIG_LIBRARY_MOVE_PLAN_STALE: "资料库或目标位置已经变化，请重新选择。",
    CLOUDIG_LIBRARY_MOVE_CONFLICT: "核验期间资料库发生变化，采云没有切换位置。",
    CLOUDIG_LIBRARY_BUSY: "请先完成当前采云操作，再整体搬迁资料库。",
    CLOUDIG_LIBRARY_MOVE_ROLLBACK_FAILED: "搬迁失败且采云未能自动恢复运行中的资料库。请保留两边文件夹，在检查前不要继续改动。"
  };
  return new Error(values[error?.code] ?? error?.message ?? (english ? "The Library move was not completed." : "资料库搬迁未能完成。"));
}

function showForegroundNotice(title, message, duration = 2600) {
  const layer = document.createElement("div");
  layer.className = "cloudig-notice-layer";
  const notice = document.createElement("section");
  notice.className = "cloudig-notice";
  notice.setAttribute("role", "status");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("span");
  copy.textContent = message;
  notice.append(heading, copy);
  layer.append(notice);
  overlayRoot.append(layer);
  const close = () => layer.remove();
  layer.addEventListener("pointerdown", close, { once: true });
  if (duration > 0) setTimeout(close, duration);
  return close;
}

async function bookmarkQuery(profile) {
  return request("shell.bookmarks.query", { profile });
}

function bookmarkPlaceholder(profile, error = null) {
  return {
    bookmark_set_version: "",
    requested_profile: profile,
    browser_state: error ? "unknown" : "loading",
    changelog_error: error?.message ?? "",
    target: null,
    stores: [],
    platforms: []
  };
}

async function bookmarkTargetQuery(profile, store) {
  return request("shell.bookmarks.target.query", { profile, store });
}

async function bookmarkTargetSave(profile, target) {
  const summary = await request("shell.bookmarks.target.save", { profile, ...target });
  showForegroundNotice(
    translated("archiver.bookmarkTargetSaved", state.language === "en" ? "Bookmark location saved" : "书签位置已保存"),
    summary.target?.display_path ?? ""
  );
  return summary;
}

async function bookmarkCopy(profile, platform) {
  await request("shell.bookmarks.copy", { profile, platform });
  showForegroundNotice(
    translated("archiver.bookmarkCopied", state.language === "en" ? "Bookmarklet copied" : "书签已复制"),
    state.language === "en" ? "Paste it into the URL field of a Chrome bookmark." : "可粘贴到 Chrome 书签的网址栏。"
  );
}

async function bookmarkMutation(command, profile, platforms) {
  const installed = command.endsWith("install");
  const dismissPending = showForegroundNotice(
    state.language === "en" ? "Applying bookmark change…" : "正在处理书签…",
    state.language === "en" ? "Checking Chrome and the selected bookmark folder." : "正在核对Chrome当前状态及所选书签目录。", 0);
  let result;
  try { result = await request(command, { profile, platforms }); }
  finally { dismissPending(); }
  showForegroundNotice(
    installed
      ? translated("archiver.bookmarkInstalled", state.language === "en" ? "Bookmarklets installed" : "书签安装完成")
      : translated("archiver.bookmarkRemoved", state.language === "en" ? "Bookmarklets removed" : "书签卸载完成"),
    state.language === "en"
      ? `${result.added} added · ${result.updated} updated · ${result.removed} removed\n${result.summary?.target?.display_path ?? ""}`
      : `新增 ${result.added} · 更新 ${result.updated} · 移除 ${result.removed}\n${result.summary?.target?.display_path ?? ""}`,
    9000
  );
  return result.summary;
}

async function readerModel() {
  const workflow = normalizeArchiveWorkflow(state.workflowReader);
  try {
    let model = await queryArchives({ offset: 0, limit: 50, search: "", sort: archiveQuerySort(workflow.sort), time_field: archiveQueryTimeField(workflow.time_field) });
    if (model.degraded) {
      await ensureIndexes();
      model = await queryArchives({ offset: 0, limit: 50, search: "", sort: archiveQuerySort(workflow.sort), time_field: archiveQueryTimeField(workflow.time_field) });
    }
    return model;
  } catch {
    return { degraded: true, offset: 0, limit: 50, total: 0, catalog_total: 0, directories: [], items: [] };
  }
}

// A UI page budget, not a limit on the saved or searchable conversation.
const READER_PAGE_LIMITS = Object.freeze({ messages: 40, navigation: 500, branches: 200 });
function conversationRequest(session = defaultReaderSession, pages = {}) {
  return {
    messages: { offset: pages.messages ?? 0, limit: READER_PAGE_LIMITS.messages },
    navigation: { offset: pages.navigation ?? 0, limit: READER_PAGE_LIMITS.navigation },
    branches: { offset: pages.branches ?? 0, limit: READER_PAGE_LIMITS.branches },
    session,
    summary_characters: 96
  };
}

async function runtimeJson(page) {
  const response = await fetch(`https://cloudig-runtime.local${page.virtual_path}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Conversation view page is unavailable");
  return response.json();
}

let contentSearchDialog;
async function previewSearchMessage(hit, host, signal) {
  const session = structuredClone(defaultReaderSession);
  if (hit.categories.includes("process")) session.expanded = { reasoning: true, tools: true, references: true };
  const viewRequest = conversationRequest(session); viewRequest.messages.limit = 1;
  const opened = await requestWithSignal("reader.search.open", { archive: hit.archive, message: hit.message, request: viewRequest }, signal);
  let renderer, released = false;
  const release = () => { if (released) return; released = true; renderer?.destroy(); request("reader.view.close", { view: opened.token }).catch(() => undefined); };
  signal.addEventListener("abort", release, { once: true });
  try {
    if (signal.aborted) { release(); throw signal.reason; }
    const view = await runtimeJson(opened.page); signal.throwIfAborted(); host.replaceChildren();
    renderer = globalThis.CloudigConversationRenderer.createConversationRenderer({ root: host, labels: readerRendererLabels(translate), theme: state.theme, language: state.language === "en" ? "en" : "zh",
      resolveAvatar: async (identity, childSignal) => { const result = await requestWithSignal("reader.identity.resolve", { view: opened.token, identity }, childSignal); return { url: result.kind === "application" ? applicationAsset(result.asset) : `https://cloudig-runtime.local${result.asset.virtual_path}` }; },
      resolveResource: async (resource, _purpose, childSignal) => { const result = await requestWithSignal("reader.resource.materialize", { view: opened.token, resource: resource.id }, childSignal); return { url: `https://cloudig-runtime.local${result.virtual_path}` }; },
      onOpenExternal: url => request("shell.openExternal", { url }).catch(showActionError),
      onOpenResource: resource => request("shell.saveResource", { view: opened.token, resource }).catch(showActionError)
    });
    renderer.render(view); return release;
  } catch (error) { release(); throw error; }
}

function showContentSearch(input) {
  contentSearchDialog?.close();
  contentSearchDialog = openContentSearch({ ...input, host: overlayRoot, underlay: routeHost, language: state.language,
    search: (payload, onEvent) => beginRequest("reader.search.query", payload, onEvent), preview: previewSearchMessage,
    open: async hit => {
      const row = { ...hit, capability: hit.archive, archive: hit.conversation_id };
      try {
        if (!currentRoute.startsWith("reader/")) { await preload(readerCoverPreload); await mountReader(); }
        currentPage?.selectForReading?.(row);
        await openReaderConversation(row, false, { message: hit.message, categories: hit.categories });
      } catch (error) { await showActionError(error); }
    },
    onClose: () => { contentSearchDialog = undefined; }
  });
}

function applicationAsset(asset) {
  if (asset === "Assets/Defaults/user.svg") return "/assets/welcome/OsisLogo-Cloudig-1024.png";
  if (asset === "Assets/Defaults/assistant.svg") return "/assets/welcome/OsisLogo-Simple.svg";
  const platform = /^Assets\/Platforms\/([a-z0-9-]+)\.svg$/u.exec(asset)?.[1];
  if (!platform) return "/assets/welcome/OsisLogo-Simple.svg";
  return platform === "doubao" ? "/assets/platforms/platform-doubao.png" : `/assets/platforms/platform-${platform}.svg`;
}

async function showTransition() {
  transition.hidden = false;
  transition.dataset.leaving = "false";
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function hideTransition(token) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (token !== routeOrdinal) return;
    transition.dataset.leaving = "true";
    setTimeout(() => {
      if (token !== routeOrdinal) return;
      transition.hidden = true;
      delete transition.dataset.leaving;
    }, 190);
  }));
}

function disposeActiveConversation(closeView = true) {
  if (!activeConversation) return;
  const previous = activeConversation;
  activeConversation = null;
  previous.flushPosition?.();
  previous.abortOpen?.();
  previous.controller.cleanup();
  if (closeView && previous.token) request("reader.view.close", { view: previous.token }).catch(() => undefined);
}

async function openReaderConversation(row, withTransition = false, focus) {
  closeDocument();
  if (!row?.example) exampleReturn = null;
  if (!currentPage?.element || typeof row?.capability !== "string") return;
  if (activeConversation?.opening && activeConversation.row.capability === row.capability) return;
  const branchArchive = row.archive ?? row.filename ?? row.capability;
  if (readerBranchArchive !== branchArchive) {
    delete readerSessionState.selected_leaf;
    delete readerSessionState.branch_choices;
    readerBranchArchive = branchArchive;
  }
  const mountedPage = currentPage;
  const routeToken = ++routeOrdinal;
  if (withTransition) await showTransition();
  let openedToken = null;
  const openController = new AbortController();
  let loadingConversation;
  try {
    const visual = screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") === "sample";
    let savedPosition = null;
    if (!visual && !row.example) {
      const stored = await requestWithSignal("reader.position.query", { archive: row.capability }, openController.signal);
      savedPosition = stored?.position && typeof stored.position === "object" ? stored.position : null;
      delete readerSessionState.selected_leaf;
      delete readerSessionState.branch_choices;
      if (savedPosition?.selected_leaf) readerSessionState.selected_leaf = String(savedPosition.selected_leaf);
      if (savedPosition?.branch_choices && typeof savedPosition.branch_choices === "object") readerSessionState.branch_choices = { ...savedPosition.branch_choices };
    }
    let lastPositionId = typeof savedPosition?.message_id === "string" ? savedPosition.message_id : undefined;
    let positionChain = Promise.resolve();
    const queuePosition = (messageId, nextSession) => {
      if (row.example || typeof messageId !== "string" || !messageId) return;
      lastPositionId = messageId;
      positionChain = positionChain.then(() => request("reader.position.save", {
        archive: row.capability, message_id: messageId,
        ...(nextSession?.selected_leaf ? { selected_leaf: nextSession.selected_leaf } : {}),
        ...(nextSession?.branch_choices ? { branch_choices: nextSession.branch_choices } : {})
      })).catch(() => undefined);
    };
    const flushPosition = () => { if (lastPositionId) queuePosition(lastPositionId, readerSessionState); };
    const resolveAvatar = async (reference, signal) => {
      if (signal.aborted) throw signal.reason;
      if (visual && String(reference).startsWith("Assets/")) return { url: applicationAsset(String(reference)) };
      const resolved = await requestWithSignal("reader.identity.resolve", { view: openedToken, identity: reference }, signal);
      return resolved.kind === "application"
        ? { url: applicationAsset(String(resolved.asset)) }
        : { url: `https://cloudig-runtime.local${resolved.asset.virtual_path}` };
    };
    const resolveResource = async (resource, _purpose, signal) => {
      if (signal.aborted) throw signal.reason;
      if (visual) throw new Error("Visual fixture has no embedded resource bytes");
      const resolved = await requestWithSignal("reader.resource.materialize", { view: openedToken, resource: resource.id }, signal);
      return { url: `https://cloudig-runtime.local${resolved.virtual_path}` };
    };
    const requestPage = async (session, pages) => {
      if (visual) return visualConversationFixture(state, session, screenshotQuery.get("title-case"));
      const page = await request("reader.view.page", { view: openedToken, request: conversationRequest(session, pages) });
      return runtimeJson(page);
    };
    // Publish the selected title immediately. Only the message region is busy;
    // opening an article never flashes the cover or the whole-page sunrise.
    disposeActiveConversation();
    const controller = mountReaderConversation({
      page: mountedPage.element,
      template: conversationTemplate,
      row,
      view: {},
      loading: true,
      state,
      session: readerSessionState,
      onSessionChange: (nextSession) => { readerSessionState = nextSession; },
      onPositionChange: (messageId, nextSession) => { readerSessionState = nextSession; queuePosition(messageId, nextSession); },
      translate,
      requestPage,
      onError: (error) => showActionError(error),
      resolveAvatar,
      resolveResource,
      onOpenExternal: (url) => request("shell.openExternal", { url }).catch(() => undefined),
      onOpenResource: row.example ? undefined : (resource) => request("shell.saveResource", { view: openedToken, resource }).catch((error) => showActionError(error)),
      readOnly: Boolean(row.example), onExampleReturn: () => returnExampleDemo().catch(showActionError),
      onEditIdentity: row.example ? undefined : () => openIdentityEditor(row).catch((error) => showActionError(error)),
      onEditConversation: row.example ? undefined : () => openConversationInfo(row).catch((error) => showActionError(error)),
      onExport: row.example ? undefined : (selectedLeaf, branchChoices) => chooseConversationMarkdown(row, selectedLeaf, branchChoices).catch(showActionError),
      onCopy: row.example ? undefined : (message, mode, selectedLeaf, branchChoices) => performMarkdownCopy(row, { messages: [message], content_mode: mode, include_header: false, ...(selectedLeaf ? { selected_leaf: selectedLeaf } : {}), ...(branchChoices ? { branch_choices: branchChoices } : {}) })
    });
    loadingConversation = { token: null, row, controller, opening: true, abortOpen: () => openController.abort(), flushPosition };
    activeConversation = loadingConversation;
    currentRoute = `reader/conversation/${row.capability}`;
    app.dataset.route = currentRoute;
    applyTheme();
    applyLocale();
    root.dataset.readerOpenStage = "reading";
    await preload(readerConversationPreload);
    openController.signal.throwIfAborted();
    let view;
    if (visual) view = visualConversationFixture(state, readerSessionState, screenshotQuery.get("title-case"));
    else {
      const searchSession = structuredClone(readerSessionState);
      if (focus?.categories?.includes("process")) searchSession.expanded = { reasoning: true, tools: true, references: true };
      const opened = await requestWithSignal(row.example ? 'reader.example.open' : focus ? "reader.search.open" : "reader.view.open", {
        ...(row.example ? { example: row.example, language: state.language } : { archive: row.capability }), ...(focus ? { message: focus.message } : {}), request: conversationRequest(searchSession) }, openController.signal);
      openedToken = opened.token;
      if (routeToken !== routeOrdinal || currentPage !== mountedPage || openController.signal.aborted) {
        await request("reader.view.close", { view: openedToken }); openedToken = null; return;
      }
      loadingConversation.token = openedToken;
      root.dataset.readerOpenStage = "fetching-view";
      controller.setLoading("preparing");
      view = await runtimeJson(opened.page);
      if (opened.session) readerSessionState = opened.session;
      if (opened.focus) focus = opened.focus;
    }
    if (routeToken !== routeOrdinal || currentPage !== mountedPage || openController.signal.aborted) return;
    root.dataset.readerOpenStage = "mounting";
    controller.replaceView(view, readerSessionState);
    if (focus?.anchor) controller.focusMessage(focus.anchor);
    else if (savedPosition?.message_id) await controller.focusMessageId(String(savedPosition.message_id));
    loadingConversation.opening = false;
    root.dataset.readerOpenStage = "ready";
  } catch (error) {
    if (openedToken) request("reader.view.close", { view: openedToken }).catch(() => undefined);
    if (routeToken !== routeOrdinal || currentPage !== mountedPage || openController.signal.aborted) return;
    root.dataset.readerOpenStage = "failed";
    if (loadingConversation) { loadingConversation.opening = false; loadingConversation.token = null; loadingConversation.controller.setLoading("failed"); }
    throw error;
  } finally {
    if (withTransition) hideTransition(routeToken);
  }
}

function visualInfoPreview(info, draft, language) {
  const contentTime = draft.content_time?.state === "set"
    ? { state: "set", range: structuredClone(draft.content_time.range), direction: "forward" }
    : draft.content_time?.state === "cleared"
      ? { state: "cleared" }
      : { state: "unavailable" };
  return {
    changed: JSON.stringify(draft) !== JSON.stringify(info.draft),
    anchor_sensitive: JSON.stringify(draft).includes('"kind":"now"') || JSON.stringify(draft).includes('"kind":"relative"'),
    content_time: contentTime,
    draft: structuredClone(draft),
    language
  };
}

async function refreshConversationInfoSource(returnRoute, archive) {
  if (returnRoute.startsWith("reader/conversation/")) {
    let model = await mountReader();
    let row = model.items?.find((entry) => entry.archive === archive);
    let offset = model.items?.length ?? 0;
    const pageOwner = currentPage;
    while (!row && offset < model.total) {
      model = await queryArchives({ offset, limit: 200, ...(model.snapshot ? { snapshot: model.snapshot } : {}) });
      if (currentPage !== pageOwner) return;
      row = model.items?.find(entry => entry.archive === archive);
      if (!model.items?.length) break;
      offset += model.items.length;
    }
    if (row) await openReaderConversation(row, false);
    return;
  }
  if (returnRoute === "reader/cover") { await mountReader(); return; }
  if (returnRoute.startsWith("archiver")) await currentPage?.refreshAll?.();
}

async function openIdentityEditor(row = null) {
  if (activeIdentityEditor) return;
  const screenshot = screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real";
  const model = screenshot ? visualIdentityFixture(state.language) : await request("identity.query", {});
  const conversation = row
    ? screenshot
      ? { revision: { conversation: "a".repeat(64), mark: null }, archive: "a1", title: "示例会话", platform: "kimi", names: { user: null, assistant: null }, resolved: { user: model.global.user.resolved_name, assistant: "Kimi" } }
      : await request("reader.archive.identity.query", { archive: row.capability })
    : null;
  activeIdentityEditor = mountIdentityEditor({
    host: overlayRoot,
    template: identityEditorTemplate,
    state,
    model,
    conversation,
    applicationAsset,
    resolveAvatar: async (descriptor) => {
      if (descriptor.kind === "application") return applicationAsset(descriptor.asset);
      const result = screenshot
        ? { virtual_path: "/v_0000000000000000000000000000000000000000000/assets/r_0000000000000000000000000000000000000000000.png" }
        : await request("identity.avatar.resolve", { avatar: descriptor.capability });
      return `https://cloudig-runtime.local${result.virtual_path}`;
    },
    pickAvatar: async () => {
      if (screenshot) return null;
      const picked = await request("shell.pickIdentityAvatar", {});
      if (picked.cancelled) return null;
      try {
        const preview = await request("identity.avatar.preview", { picker: picked.picker });
        return { picker: picked.picker, filename: picked.filename, bytes: picked.bytes, url: `https://cloudig-runtime.local${preview.virtual_path}` };
      } catch (error) {
        await request("shell.discardIdentityAvatar", { picker: picked.picker }).catch(() => undefined);
        throw error;
      }
    },
    discardAvatar: (picker) => screenshot ? Promise.resolve({ discarded: true }) : request("shell.discardIdentityAvatar", { picker }),
    save: async ({ globalDraft, conversationNames }) => {
      if (screenshot) return { status: "unchanged", ...model };
      const globalResult = await request("identity.commit", {
        expected_revision: model.revision, draft: globalDraft,
        ...(row && conversation && conversationNames ? { conversation: {
          archive: row.capability, expected_conversation: conversation.revision.conversation, expected_mark: conversation.revision.mark, names: conversationNames
        } } : {})
      });
      await refreshShellIdentity(globalResult);
      return { global: globalResult };
    },
    onClose: ({ saved }) => {
      activeIdentityEditor = null;
      if (!saved) return;
      applyLocale();
      if (conversation?.archive) refreshConversationInfoSource(currentRoute, conversation.archive).catch((error) => showActionError(error));
      else if (currentRoute === "reader/cover") mountReader().catch((error) => showActionError(error));
    }
  });
}

async function openConversationInfo(row) {
  if (activeConversationInfo || typeof row?.capability !== "string") return;
  const returnRoute = currentRoute, returnPage = currentPage, originOrdinal = routeOrdinal;
  await preload(conversationInfoPreload);
  const screenshot = screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real";
  const info = screenshot
    ? visualConversationInfoFixture(state.language)
    : await request("reader.archive.info.query", { archive: row.capability });
  let pickerModelPromise = null;
  const pickerModel = () => pickerModelPromise ??= (screenshot
    ? Promise.resolve(visualTimeCoverFixture(false))
    : request("time.cover.query", { return_to: "conversation-info", focus_archive: row.capability }));
  const terranPresets = (await pickerModel()).terran.items;
  if (activeConversationInfo || currentRoute !== returnRoute || currentPage !== returnPage || routeOrdinal !== originOrdinal) return;
  const editorRoute = `conversation/info/${row.capability}`;
  activeConversationInfo = mountConversationInfo({
    host: overlayRoot,
    background: routeHost,
    canClose: () => !activeTimeCover && !activeTimeEditor,
    template: conversationInfoTemplate,
    info,
    terranPresets,
    state,
    preview: (draft, language) => screenshot
      ? Promise.resolve(visualInfoPreview(info, draft, language))
      : request("reader.archive.info.preview", { archive: row.capability, draft, language }),
    commit: (payload) => screenshot
      ? Promise.resolve({ status: "unchanged", revision: info.revision })
      : commitCurrentConversationInfo(request, row.capability, payload),
    reloadTime: async () => { pickerModelPromise = null; return pickerModel(); },
    querySovereign: async ({ search, sort, offset = 0, limit = 100 }) => {
      const time = await pickerModel();
      return screenshot
        ? { items: structuredClone(time.sovereign.items.slice(offset, offset + limit)), total: time.sovereign.total }
        : request("time.sovereign.query", { route: time.route, offset, limit, search, sort });
    },
    previewSovereign: async (node, occurrences) => {
      const time = await pickerModel();
      return screenshot
        ? { endpoint: { kind: "sovereign", selection: "te_fixture", display: { timeline: { name: "星河纪元", author: "晨星" }, target: { name: "月相", kind: "periodic", count: 12 } } } }
        : request("time.endpoint.preview", { route: time.route, node, ...(occurrences ? { occurrences } : {}) });
    },
    onOpenTime: () => openTimeCover("conversation-info", row.capability).catch((error) => showActionError(error)),
    onClose: ({ updated }) => {
      activeConversationInfo = null;
      if (currentRoute !== editorRoute) return;
      currentRoute = returnRoute;
      app.dataset.route = returnRoute;
      applyTheme();
      applyLocale();
      if (updated) refreshConversationInfoSource(returnRoute, info.archive).catch((error) => showActionError(error));
    }
  });
  currentRoute = editorRoute;
  app.dataset.route = currentRoute;
  if (screenshot) {
    const interaction = screenshotQuery.get("interaction");
    if (interaction === "info-fuzzy") activeConversationInfo.element.querySelector("[data-point-band='historical'] [data-point-mode=''][value='fuzzy']").click();
    if (interaction === "parser-history") {
      activeConversationInfo.element.querySelector(".conversation-info-details").open = true;
      const history = activeConversationInfo.element.querySelector("[data-parser-history]");
      history.open = true;
      for (let attempt = 0; attempt < 80 && !history.querySelector("[data-parser-release]"); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      const current = history.querySelector("[data-parser-release]");
      if (!current) throw new Error("Bundled Parser history did not load");
      current.open = true;
    }
    if (interaction === "info-sovereign") {
      activeConversationInfo.element.querySelector("[data-conversation-axis='sovereign']").click();
      await new Promise(requestAnimationFrame);
    }
  }
}

function visualTimeChildren(model, node) {
  return Promise.resolve({
    revision: model.revision,
    parent: node,
    items: node === model.terran.root.node ? structuredClone(model.terran.items) : []
  });
}

function visualRangePreview(range) {
  return Promise.resolve({ range: structuredClone(range), summary: "", direction: "indeterminate" });
}

function visualTimeDeletePreview(row) {
  const target = { node: row.node, display: { name: row.name ?? "星河纪元", kind: row.kind ?? "timeline" } };
  return {
    plan: "td_fixture",
    impact: {
      target,
      deleted_nodes: [target],
      parents: [], children: [], internal_contains: [], counterparts: [], mappings: [], affected_references: [],
      snapshots_preserved: true
    }
  };
}

async function runTimeDelete(cover, row, screenshot) {
  const nodeRevision = row.node_revision ?? row.revision;
  if (typeof nodeRevision !== "string" && !screenshot) throw new Error(state.language === "en" ? "Refresh Content Time before deleting this node." : "请刷新内容时间后再删除此节点。");
  const preview = screenshot
    ? visualTimeDeletePreview(row)
    : await request("time.delete.preview", {
      route: cover.route,
      node: row.node,
      expected_time_revision: row.time_revision ?? cover.revision,
      expected_library_revision: row.library_revision ?? cover.library_revision,
      expected_node_revision: nodeRevision
    });
  const decision = await showTimeDeleteConfirmation(preview);
  if (!decision) return false;
  const result = screenshot
    ? { status: "updated" }
    : await request("time.delete.commit", { plan: preview.plan });
  if (result.status !== "updated") throw new Error(state.language === "en" ? "Time System changed. Refresh and review the deletion again." : "时间系统已经改变，请刷新后重新核对删除影响。");
  return true;
}

async function openTimeEditor(cover, row, action, callbacks = {}) {
  if (activeTimeEditor) return;
  await preload(timeEditorPreload);
  const screenshot = screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real";
  let model;
  if (screenshot) {
    const editor = screenshotQuery.get("editor");
    const fixtureAction = editor === "create-timeline" ? "create_timeline" : editor === "create-time" ? "create_time" : "edit";
    model = visualTimeEditorFixture(editor === "time" || editor === "create-time" ? "time" : "timeline", fixtureAction);
  } else if (action === "edit") {
    model = await request("time.editor.query", { route: cover.route, node: row.node });
    model.action = "edit";
  } else if (action === "create_timeline") {
    model = {
      action, time_revision: cover.revision, library_revision: cover.library_revision, node_revision: cover.revision,
      metadata: { kind: "timeline", name: "", author: "", standard_name: null, version: "1.0" },
      children: [], counterparts: [], mappings: [], references: [], anchor: localAnchor()
    };
  } else {
    model = {
      action: "create_time", time_revision: cover.revision, library_revision: cover.library_revision, node_revision: cover.revision,
      metadata: { kind: "single", name: "" }, children: [], counterparts: [], mappings: [], references: [], anchor: localAnchor()
    };
  }
  model.anchor ??= localAnchor();
  if (callbacks.restoreDefault && model.can_restore) model.restore_default_time = true;
  const returnRoute = currentRoute;
  currentRoute = `${action === "edit" ? "time/node" : "time/timeline"}/${row?.node ?? action}`;
  app.dataset.route = currentRoute;
  const finish = () => {
    if (!activeTimeEditor) return;
    const page = activeTimeEditor; activeTimeEditor = null; page.cleanup();
    currentRoute = returnRoute; app.dataset.route = returnRoute; applyTheme(); applyLocale();
  };
  const queryNodes = ({ search = "", sort = "edited_desc", offset = 0, limit = 100 }) => screenshot
    ? Promise.resolve({ revision: cover.revision, items: structuredClone(cover.sovereign.items.slice(offset, offset + limit)), total: cover.sovereign.items.length })
    : request("time.sovereign.query", { route: cover.route, offset, limit, search, sort });
  activeTimeEditor = mountTimeEditor({
    host: overlayRoot, template: timeEditorTemplate, model, cover, state, anchor: model.anchor,
    queryNodes,
    previewRange: (range, allowSovereign) => screenshot ? visualRangePreview(range) : request("time.range.preview", { range, allow_sovereign: allowSovereign, language: state.language }),
    previewSovereign: (node, occurrences) => screenshot
      ? Promise.resolve({ endpoint: { kind: "sovereign", selection: "te_fixture", display: { timeline: { name: "星河纪元", author: "晨星" }, target: { name: "月相", kind: "periodic", count: 12 } } } })
      : request("time.endpoint.preview", { route: cover.route, node, ...(occurrences ? { occurrences } : {}) }),
    preview: (payload) => screenshot
      ? Promise.resolve({ plan: "tp_fixture", no_change: false, can_commit: true, cancelled_references: payload.cancel_references, impact: { affected_references: [], external_links: [], invalid_selectors: [], strategies: ["in_place"] } })
      : request("time.editor.preview", { route: cover.route, ...payload }),
    commit: (payload) => screenshot ? Promise.resolve({ status: "updated", node: model.node ?? "tn_fixture" }) : request("time.editor.commit", payload),
    previewSelection: ({ touch_on_noop, ...payload }) => screenshot
      ? Promise.resolve({ copy_count: 1, updated_count: payload.selected_references.length, cancelled_count: 0, offset: payload.offset, limit: payload.limit, copies: [{ name: model.metadata.name, kind: model.metadata.kind }], references: [] })
      : request("time.editor.selection.preview", payload),
    onCreateTime: () => { finish(); openTimeEditor(cover, null, "create_time", callbacks).catch(showActionError); },
    onOpenNode: (next) => { finish(); openTimeEditor(cover, next, "edit", callbacks).catch(showActionError); },
    onDelete: (target) => runTimeDelete(cover, target, screenshot).then(async (updated) => {
      if (!updated) return;
      finish();
      await callbacks.refresh?.();
    }).catch((error) => showActionError(error)),
    onReturn: finish,
    onCommitted: async () => { finish(); await callbacks.refresh?.(); }
  });
}

async function openTimeCover(explicitReturn, focusArchive) {
  if (activeTimeCover) return;
  await preload(timeCoverPreload);
  const audit = screenshotQuery.get("screenshot") === "1";
  const screenshot = audit && screenshotQuery.get("fixture") !== "real";
  const returnTo = explicitReturn ?? (currentRoute.startsWith("archiver") ? "archiver" : currentRoute.startsWith("conversation/info/") ? "conversation-info" : "reader-cover");
  const model = screenshot
    ? visualTimeCoverFixture(screenshotQuery.get("phase") === "empty")
    : await request("time.cover.query", { return_to: returnTo, ...(focusArchive ? { focus_archive: focusArchive } : {}) });
  const returnRoute = currentRoute;
  currentRoute = `time/cover/${model.route}`;
  app.dataset.route = currentRoute;
  const close = async (route) => {
    if (!activeTimeCover) return;
    if (!screenshot) {
      const resolved = await request("time.route.resolve", { route });
      if (resolved.return_to !== returnTo) throw new Error("Content Time return route changed");
    }
    const page = activeTimeCover;
    activeTimeCover = null;
    page.cleanup();
    currentRoute = returnRoute;
    app.dataset.route = returnRoute;
    applyTheme();
    applyLocale();
    if (returnTo === "conversation-info") await activeConversationInfo?.refreshTimeContext();
  };
  const refreshAfterEdit = async () => {
    if (!activeTimeCover) return;
    const page = activeTimeCover; activeTimeCover = null; page.cleanup();
    currentRoute = returnRoute; app.dataset.route = returnRoute;
    await openTimeCover(returnTo, focusArchive);
  };
  activeTimeCover = mountTimeCover({
    host: overlayRoot,
    template: timeCoverTemplate,
    model,
    state,
    returnTo,
    children: (route, node) => screenshot ? visualTimeChildren(model, node) : request("time.nodes.children", { route, node }),
    querySovereign: (route, sort) => screenshot
      ? Promise.resolve({ revision: model.revision, total: model.sovereign.total, items: structuredClone(model.sovereign.items), route, sort })
      : request("time.sovereign.query", { route, offset: 0, limit: 500, sort, top_level: true }),
    saveOrder: async (payload) => {
      const result = screenshot
        ? { revision: model.revision + 1, library_revision: model.library_revision + 1, items: payload.nodes.map(node => model.sovereign.items.find(row => row.node === node)) }
        : await request("time.order.commit", payload);
      model.revision = result.revision; model.library_revision = result.library_revision;
      model.sovereign.items = result.items; model.sovereign.total = result.items.length;
      return result;
    },
    onReturn: (route) => close(route).catch((error) => showActionError(error)),
    onCreate: (kind) => openTimeEditor(model, null, kind === "timeline" ? "create_timeline" : "create_time", { refresh: refreshAfterEdit }).catch((error) => showActionError(error)),
    onEdit: (row) => openTimeEditor(model, row, "edit", { refresh: refreshAfterEdit }).catch((error) => showActionError(error)),
    onRestore: (row) => openTimeEditor(model, row, "edit", { refresh: refreshAfterEdit, restoreDefault: true }).catch((error) => showActionError(error)),
    onDelete: (row) => runTimeDelete(model, row, screenshot).then((updated) => updated ? refreshAfterEdit() : undefined).catch((error) => showActionError(error)),
    onError: (error) => showActionError(error)
  });
  if (audit && !timeAuditEditorOpened && screenshotQuery.get("route") === "time-editor") {
    timeAuditEditorOpened = true;
    const editor = screenshotQuery.get("editor");
    const action = editor === "create-timeline" ? "create_timeline" : editor === "create-time" ? "create_time" : "edit";
    const matches = row => editor === "time" ? row.kind !== "timeline" : row.kind === "timeline";
    const row = action === "edit" ? model.sovereign.items.find(matches) ?? model.terran.items.find(matches) ?? model.terran.root : null;
    await openTimeEditor(model, row, action, { refresh: refreshAfterEdit });
    const interaction = screenshotQuery.get("interaction");
    if (interaction === "mapping" || interaction === "relative" || interaction === "timezone-mapping") {
      overlayRoot.querySelector("[data-time-editor-add-mapping]").click();
      const start = overlayRoot.querySelector("[data-endpoint-side-section='start']");
      if (interaction === "mapping" || interaction === "timezone-mapping") overlayRoot.querySelector("[data-endpoint-side-section='end'] [data-endpoint-kind='fuzzy']").click();
      else { start.querySelector("[data-endpoint-kind='relative']").click(); overlayRoot.querySelector("[data-endpoint-side-section='start'] [data-endpoint-option='direction'][data-value='after']").click(); }
    } else if (interaction === "counterpart") {
      overlayRoot.querySelector("[data-time-editor-add-counterpart]").click();
      await new Promise(requestAnimationFrame);
      const findPick = () => screenshot ? overlayRoot.querySelector(".time-editor-node-results [data-pick-node='tn_fixture_t2']")
        : [...overlayRoot.querySelectorAll(".time-editor-node-results [data-pick-node]")].find(button => button.textContent.includes("月相"));
      const deadline = performance.now() + 5000;
      while (!findPick() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
      const pick = findPick();
      if (!pick) throw new Error("Counterpart audit could not load its periodic node");
      pick?.click();
      overlayRoot.querySelector("[name='picker-occurrences'][value='partial']")?.click();
    }
  }
}

async function returnReaderCover(withTransition = true) {
  if (activeConversation?.row.example && exampleReturn) return returnExampleDemo();
  if (!activeConversation) return;
  const routeToken = ++routeOrdinal;
  if (withTransition) await showTransition();
  disposeActiveConversation();
  currentRoute = "reader/cover";
  app.dataset.route = currentRoute;
  applyTheme();
  applyLocale();
  if (withTransition) hideTransition(routeToken);
}

function mountWelcome() {
  disposeActiveConversation();
  currentPage?.cleanup?.();
  currentPage = null;
  currentRoute = "welcome";
  app.dataset.route = currentRoute;
  routeHost.replaceChildren(welcomeBlueprint.cloneNode(true));
  applyTheme();
  applyLocale();
  resizeWelcome();
}

async function performReaderArchiveAction(operation) {
  if (!operation?.row) return false;
  if (operation.action === "edit") { await openConversationInfo(operation.row); return true; }
  if (!["move", "archive", "restore", "delete"].includes(operation.action)) return false;
  if (!(await showArchiveConfirmation(operation))) return false;
  const page = currentPage?.element;
  if (page) page.dataset.writeBusy = "true";
  try {
    if (operation.action === "move") {
      await request("reader.archive.move", {
        archive: operation.row.capability,
        ...(operation.directory && operation.directory !== "root" ? { directory: operation.directory } : {})
      });
    } else if (operation.action === "archive") {
      await request("reader.archive.archive", { archive: operation.row.capability });
    } else if (operation.action === "restore") {
      await request("reader.archive.restore", {
        archive: operation.row.capability,
        ...(operation.directory && operation.directory !== "root" ? { directory: operation.directory } : {})
      });
    } else {
      await runArchiveDeletion({ host: app, rows: [operation.row], language: state.language, recycle: row => request("shell.recycleArchive", { archive: row.capability }) });
    }
    if (activeConversation?.row?.capability === operation.row.capability) await returnReaderCover(false);
    return true;
  } catch (error) {
    await showActionError(error);
    return false;
  } finally {
    if (page) delete page.dataset.writeBusy;
  }
}

function manageArchiverDirectories(directories, initialMode = "manage") {
  showDirectoryManager([...directories.map((directory) => ({ ...directory }))], {
    async create(name) {
      try {
        await request("reader.directory.create", { name });
        await currentPage?.refreshAll?.();
        return true;
      } catch (error) {
        await showActionError(error);
        return false;
      }
    },
    async rename(directory, name) {
      try {
        await request("reader.directory.rename", { directory: directory.capability, name });
        await currentPage?.refreshAll?.();
        return true;
      } catch (error) {
        await showActionError(error);
        return false;
      }
    },
    async remove(directory) {
      try {
        await request("reader.directory.delete", { directory: directory.capability });
        await currentPage?.refreshAll?.();
        return true;
      } catch (error) {
        await showActionError(error);
        return false;
      }
    }
  }, initialMode);
}

async function chooseConversationMarkdown(row, selectedLeaf, branchChoices) {
  const branch = { ...(selectedLeaf ? { selected_leaf: selectedLeaf } : {}), ...(branchChoices ? { branch_choices: branchChoices } : {}) };
  const decision = await chooseMarkdown({ host: overlayRoot, underlay: routeHost, language: state.language,
    loadMessages: payload => request("reader.archive.markdown.messages", payload.snapshot ? payload : { archive: row.capability, ...branch, ...payload }) });
  if (!decision) return;
  const { action, ...settings } = decision;
  let selection;
  try {
    if (settings.messages?.length > MARKDOWN_SELECTION_LIMITS.chunk || new TextEncoder().encode(JSON.stringify(settings.messages ?? [])).length > MARKDOWN_SELECTION_LIMITS.webBytes) {
      let chunk = [];
      const send = async () => { const result = await request("reader.archive.markdown.select", { archive: row.capability, messages: chunk, ...(selection ? { selection } : {}) }); selection = result.selection; chunk = []; };
      for (const id of settings.messages) {
        if (chunk.length && (chunk.length >= MARKDOWN_SELECTION_LIMITS.chunk || new TextEncoder().encode(JSON.stringify([...chunk, id])).length > MARKDOWN_SELECTION_LIMITS.webBytes)) await send();
        chunk.push(id);
      }
      if (chunk.length) await send(); delete settings.messages; settings.selection = selection;
    }
    if (action === "copy") await performMarkdownCopy(row, { ...branch, ...settings });
    else await performMarkdownExport([row], selectedLeaf, branchChoices, settings);
  } finally { if (selection) await request("reader.archive.markdown.releaseSelection", { selection }).catch(() => undefined); }
}

async function performMarkdownCopy(row, settings) {
  if (activeExportOperation) return;
  activeExportOperation = true;
  const status = document.createElement("div"), copy = document.createElement("span"), cancel = document.createElement("button");
  status.className = "cloudig-markdown-feedback"; status.setAttribute("role", "status"); status.dataset.busy = "true";
  cancel.type = "button"; cancel.className = "cloudig-button cloudig-button-outline"; cancel.textContent = state.language === "en" ? "Cancel" : "取消";
  copy.textContent = state.language === "en" ? "Preparing Markdown…" : "正在准备 Markdown…"; status.append(copy, cancel); overlayRoot.append(status);
  const operation = beginRequest("shell.copyMarkdown", { archive: row.capability, ...settings }, event => {
    if (event.bytes?.total) copy.textContent = state.language === "en" ? `Preparing Markdown · ${Math.round(event.bytes.completed / event.bytes.total * 100)}%` : `正在准备 Markdown · ${Math.round(event.bytes.completed / event.bytes.total * 100)}%`;
  });
  cancel.addEventListener("click", () => operation.cancel());
  try { await operation.promise; copy.textContent = state.language === "en" ? "Markdown copied" : "已复制 Markdown"; }
  catch (error) { status.remove(); throw error; }
  finally { activeExportOperation = false; status.dataset.busy = "false"; cancel.remove(); setTimeout(() => status.remove(), 2400); }
}

async function performMarkdownExport(rows, selectedLeaf, branchChoices, settings = {}) {
  if (activeExportOperation || !Array.isArray(rows) || rows.length === 0) return false;
  activeExportOperation = true;
  const page = currentPage?.element;
  if (page) page.dataset.writeBusy = "true";
  const exported = [];
  let failed = 0;
  try {
    const filenames = rows.map((entry) => entry.filename);
    for (const row of rows) {
      const operation = beginRequest(
        "reader.archive.exportMarkdown",
        { archive: row.capability, ...(selectedLeaf ? { selected_leaf: selectedLeaf } : {}), ...(branchChoices ? { branch_choices: branchChoices } : {}), ...settings },
        (event) => currentPage?.setProgress?.(event, filenames)
      );
      try {
        exported.push(await operation.promise);
      } catch {
        failed += 1;
      }
    }
    if (exported.length === 0) {
      await showActionError(new Error(translated("reader.exportMarkdownFailed", state.language === "en" ? "The selected archives could not be exported." : "所选档案未能导出。")));
      return false;
    }
    if (await showMarkdownExportResult(exported, failed)) await request("shell.openManagedFolder", { folder: "exports" });
    return failed === 0;
  } finally {
    activeExportOperation = false;
    if (page) delete page.dataset.writeBusy;
    currentPage?.clearProgress?.();
  }
}

async function performArchiverArchiveAction(action, rows, directories) {
  if (!Array.isArray(rows) || rows.length === 0 || !["export", "move", "archive", "restore", "delete"].includes(action)) return false;
  if (action === "export") return performMarkdownExport(rows);
  let directory = null;
  let directoryName = null;
  if (action === "move" || action === "restore") {
    directory = await showDirectoryChoice(rows, directories, action);
    if (!directory) return false;
    directoryName = directory === "root"
      ? translated("reader.rootDirectory", state.language === "en" ? "Conversation root" : "对话根目录")
      : directories.find((entry) => entry.capability === directory)?.name;
  }
  if (!(await showArchiveConfirmation({ action, row: rows[0], rows, directory, directoryName }))) return false;
  const page = currentPage?.element;
  if (page) page.dataset.writeBusy = "true";
  try {
    if (action === "delete") {
      await runArchiveDeletion({ host: app, rows, language: state.language, recycle: row => request("shell.recycleArchive", { archive: row.capability }), refresh: () => currentPage?.refreshAll?.() });
      return true;
    }
    for (const row of rows) {
      if (action === "move") {
        await request("reader.archive.move", { archive: row.capability, ...(directory !== "root" ? { directory } : {}) });
      } else if (action === "archive") {
        await request("reader.archive.archive", { archive: row.capability });
      } else if (action === "restore") {
        await request("reader.archive.restore", { archive: row.capability, ...(directory !== "root" ? { directory } : {}) });
      }
    }
    await currentPage?.refreshAll?.();
    return true;
  } catch (error) {
    await showActionError(error);
    await currentPage?.refreshAll?.().catch(() => undefined);
    return false;
  } finally {
    if (page) delete page.dataset.writeBusy;
  }
}

async function performArchiverParse(rows, settings = {}) {
  if (!Array.isArray(rows) || rows.length === 0 && !settings.one_click || activeParseOperation) return false;
  // The new plan reads only metadata and resolves the complete one-click scope.
  // No parser workers or output records exist until the following confirmation.
  activeParseOperation = { cancel: () => undefined };
  try {
    const sources = rows.map((row) => row.capability);
    let selection;
    if (sources.length > 500) {
      for (let offset = 0; offset < sources.length; offset += 500) {
        const upload = beginRequest("archiver.sources.select", { sources: sources.slice(offset, offset + 500), ...(selection ? { selection } : {}) });
        activeParseOperation = upload;
        selection = (await upload.promise).selection;
      }
    }
    const previewOperation = beginRequest(
      "archiver.parse.plan",
      {
        ...(selection ? { selection } : { sources }),
        preserve_previous: settings.preserve_previous === true,
        ...(settings.one_click ? { one_click: true } : {}),
        ...(settings.directory ? { directory: settings.directory } : {})
      },
      (event) => currentPage?.setProgress?.(event, rows.map(row => row.filename))
    );
    activeParseOperation = previewOperation;
    const plan = await previewOperation.promise;
    if (plan.state !== "ready" || !plan.plan) return false;
    while ((plan.items ?? []).length < (plan.total ?? 0)) {
      const page = await request("archiver.parse.items", { plan: plan.plan, offset: plan.items.length, limit: 200 });
      if (!page.items?.length) throw new Error("Parse preview changed; reopen the selection");
      plan.items.push(...page.items);
    }
    currentPage?.clearProgress?.();
    const directories = (await queryArchives({ offset: 0, limit: 1, sort: "title" })).directories ?? [];
    const decision = await showParseConfirmation(plan.items ?? [], { ...settings, preserve_previous: plan.preserve_previous, directoryLabel: plan.directory, directories });
    if (!decision) return false;
    const plans = (await request("archiver.parse.retarget", { plans: [plan.plan], directory: decision.directory })).plans;
    const filenames = (plan.items ?? []).map(row => row.filename);
    const operation = beginRequest(
      "archiver.parse.commit",
      { plan: plans[0] },
      (event) => currentPage?.setProgress?.(event, filenames)
    );
    activeParseOperation = operation;
    await operation.promise;
    await currentPage?.refreshAll?.();
    return true;
  } catch (error) {
    currentPage?.clearProgress?.();
    await showActionError(error);
    return false;
  } finally {
    activeParseOperation = null;
    currentPage?.clearProgress?.();
  }
}

async function createParseDirectory(name) {
  await request("reader.directory.create", { name });
  await currentPage?.refreshDirectories?.();
  const model = await queryArchives({ offset: 0, limit: 1, sort: "title" });
  return model.directories ?? [];
}

function showClaudeExtractionConfirmation(rows, preview, context = {}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const layer = document.createElement("div");
    layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section");
    dialog.className = "cloudig-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("h2");
    heading.textContent = state.language === "en" ? "Confirm Conversation Parsing" : "确认会话解析";
    const message = document.createElement("p");
    message.textContent = state.language === "en"
      ? `This operation will parse or update ${rows.length} selected conversation record(s).`
      : `本次将解析或更新 ${rows.length} 条所选会话。`;
    const facts = document.createElement("dl");
    const labels = state.language === "en"
      ? [["Previous results", context.preserve_previous ? "Keep" : "Safe update"]]
      : [["旧版结果", context.preserve_previous ? "保留" : "安全更新"]];
    for (const [label, value] of labels) {
      const key = document.createElement("dt");
      key.textContent = label;
      const item = document.createElement("dd");
      item.textContent = value;
      facts.append(key, item);
    }
    const list = document.createElement("ul");
    list.className = "cloudig-dialog-list";
    list.dataset.scrollRegion = "";
    const actions = state.language === "en"
      ? {
        parse: "Parse or update",
        new: "New archive", safe_update: "Safely update the same archive", conservative_new: "Keep existing and create a new archive",
        preserve: "Preserve previous and create a new archive", unchanged: "Unchanged · zero write", excluded: "Excluded"
      }
      : {
        parse: "解析或更新",
        new: "新建档案", safe_update: "安全更新同一档案", conservative_new: "保留现有档案并新建",
        preserve: "保留旧版并新建档案", unchanged: "未变化 · 零写", excluded: "排除"
      };
    for (const [index, row] of rows.entries()) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = row.title;
      title.title = row.title;
      const action = document.createElement("span");
      action.textContent = preview[index]?.action === "unchanged" && preview[index]?.reason === "registered_source_moved"
        ? state.language === "en" ? "Archive unchanged · update source location" : "档案未变化 · 更新来源位置"
        : actions[preview[index]?.action] ?? preview[index]?.action ?? "—";
      item.dataset.action = preview[index]?.action ?? "missing";
      if (preview[index]?.reason) action.title = preview[index].reason;
      item.append(title, action);
      list.append(item);
    }
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = state.language === "en" ? "Cancel" : "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cloudig-button cloudig-button-filled";
    confirm.textContent = state.language === "en" ? "Confirm" : "确认";
    confirm.disabled = preview.length === 0;
    footer.append(cancel, confirm);
    const target = mountParseTarget({ language: state.language, directories: context.directories ?? [], initialDirectory: context.directoryLabel ?? "Conversations",
      onCreate: createParseDirectory, errorMessage: directoryCreateErrorMessage, onBusy: busy => { confirm.disabled = busy || preview.length === 0; cancel.disabled = busy; } });
    dialog.append(heading, message, facts, target.element, list, footer);
    layer.append(dialog);
    overlayRoot.append(layer);
    const finish = (value) => { if (target.busy) return; target.dispose(); layer.remove(); previousFocus?.focus?.(); resolve(value); };
    cancel.addEventListener("click", () => finish(null));
    confirm.addEventListener("click", () => finish(target.value()));
    layer.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(null); });
    cancel.focus();
  });
}

async function indexClaudeSource(row, replace = false) {
  if (!row || activeParseOperation) return false;
  try {
    const operation = beginRequest(
      "archiver.claude.index",
      { source: row.capability, ...(replace ? { rebuild: true } : {}) },
      (event) => replace ? currentPage?.setClaudeProgress?.(event, []) : currentPage?.setProgress?.(event, [row.filename])
    );
    activeParseOperation = operation;
    const indexed = await operation.promise;
    if (indexed.state === "cancelled") return false;
    if (replace) await currentPage?.replaceClaudeIndex?.(indexed);
    else {
      currentRoute = "archiver/claude";
      app.dataset.route = currentRoute;
      currentPage?.openClaude?.(indexed, row);
      applyTheme();
      applyLocale();
    }
    return true;
  } catch (error) {
    if (error?.code !== "CLOUDIG_CANCELLED") await showActionError(error);
    return false;
  } finally {
    activeParseOperation = null;
    currentPage?.clearProgress?.();
    currentPage?.clearClaudeProgress?.();
  }
}

async function extractClaudeRows(rows, directory = null, context = {}) {
  if (!Array.isArray(rows) || rows.length === 0 || activeParseOperation) return false;
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += 500) chunks.push(rows.slice(offset, offset + 500));
  try {
    const container = currentPage?.claudeContainer?.();
    if (!container) throw new Error(state.language === "en" ? "The conversation file is no longer open." : "会话文件已经关闭，请返回档案馆重新打开。");
    const preview = [];
    let plans = [], directoryLabel;
    for (const chunk of chunks) {
      const operation = beginRequest(
        "archiver.claude.extract.preview",
        {
          container,
          selectors: chunk.map((row) => row.selector),
          preserve_previous: context.preserve_previous === true,
          ...(directory ? { directory } : {})
        },
        (event) => currentPage?.setClaudeProgress?.(event, chunk)
      );
      activeParseOperation = operation;
      const result = await operation.promise;
      if (!result.plan) throw new Error(state.language === "en" ? "Conversation parsing preview expired." : "会话解析预览已经失效，请重新确认。" );
      directoryLabel ??= result.directory;
      plans.push(result.plan);
      while ((result.items ?? []).length < (result.total ?? 0)) {
        const page = await request("archiver.parse.items", { plan: result.plan, offset: result.items.length, limit: 200 });
        if (!page.items?.length) throw new Error("Parse preview changed; reopen the selection");
        result.items.push(...page.items);
      }
      preview.push(...(result.items ?? []));
    }
    currentPage?.clearClaudeProgress?.();
    const directories = (await queryArchives({ offset: 0, limit: 1, sort: "title" })).directories ?? [];
    const decision = await showClaudeExtractionConfirmation(rows, preview, { ...context, directories, directoryLabel });
    if (!decision) return false;
    plans = (await request("archiver.parse.retarget", { plans, directory: decision.directory })).plans;
    const operation = beginRequest(
      "archiver.claude.extract.commit",
      { plans },
      (event) => currentPage?.setClaudeProgress?.(event, rows)
    );
    activeParseOperation = operation;
    await operation.promise;
    await Promise.all([currentPage?.refreshClaude?.(), currentPage?.refreshAll?.()]);
    return true;
  } catch (error) {
    if (error?.code !== "CLOUDIG_CANCELLED") await showActionError(error);
    return false;
  } finally {
    activeParseOperation = null;
    currentPage?.clearClaudeProgress?.();
  }
}

async function performSourceImport(kind, platform) {
  if (activeParseOperation) return false;
  try {
    let operation = beginRequest(
      "shell.pickSource",
      { kind, ...(platform ? { platform } : {}) },
      (event) => currentPage?.setProgress?.(event, [])
    );
    activeParseOperation = operation;
    const picked = await operation.promise;
    if (picked.cancelled || !Array.isArray(picked.items) || picked.items.length === 0) return false;
    const filenames = picked.items.map((item) => item.filename);
    operation = beginRequest(
      "source.import",
      { pickers: picked.items.map((item) => item.picker) },
      (event) => currentPage?.setProgress?.(event, filenames)
    );
    activeParseOperation = operation;
    const result = await operation.promise;
    await currentPage?.refreshAll?.();
    if (result.state === "mixed") {
      const failed = (result.items ?? []).filter((item) => item.status === "failed").length;
      await showActionError(new Error(state.language === "en" ? `${failed} selected source file(s) could not be imported.` : `${failed} 个所选来源文件未能导入。`));
    }
    return true;
  } catch (error) {
    if (error?.code !== "CLOUDIG_CANCELLED") await showActionError(error);
    return false;
  } finally {
    activeParseOperation = null;
    currentPage?.clearProgress?.();
  }
}

async function dismissMissingSource(row) {
  if (!row) return false;
  const scope = await showMissingSourceConfirmation(row);
  if (!scope) return false;
  try {
    await request("archiver.source.dismissMissing", { source: row.capability, all_missing: scope.all_missing });
    await currentPage?.refreshAll?.();
    return true;
  } catch (error) {
    await showActionError(error);
    await currentPage?.refreshAll?.().catch(() => undefined);
    return false;
  }
}

async function performArchiverShellAction(action) {
  if (action === "import-html") return performSourceImport("html");
  if (action === "import-claude") return currentPage?.openJsonImport?.();
  if (action === "open-inbox") return request("shell.openManagedFolder", { folder: "inbox" });
  if (action === "open-conversations") return request("shell.openManagedFolder", { folder: "conversations" });
  if (action === "open-library") return request("shell.openManagedFolder", { folder: "library" });
  if (action === "change-library") {
    try { return await moveCurrentLibrary(); }
    catch (error) { throw libraryMoveError(error); }
  }
  return false;
}

async function openArchiveFromArchiver(row) {
  ++routeOrdinal;
  await showTransition();
  try {
    await preload(readerCoverPreload);
    await mountReader();
    await openReaderConversation(row, false);
  } finally {
    hideTransition(routeOrdinal);
  }
}

function systemLogLabels() {
  return valueAt(currentLocale, "systemLog") ?? {
    title: "系统日志", close: "关闭", empty: "当前没有系统日志", reveal: "定位文件", copyFile: "复制本文件错误",
    copy: "复制", copied: "已复制", copyFailed: "复制失败", located: "已在文件管理器中定位",
    missing: "文件不存在或已移动", revealFailed: "未能定位文件", readFailed: "未能继续读取系统日志",
    reference: "关联", sources: { exporter: "导出器", parser: "Parser", canonical: "Canonical" }
  };
}

async function copySystemLogText(value) {
  if (screenshotQuery.get("screenshot") === "1") return;
  if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
  await navigator.clipboard.writeText(value);
}

function closeSystemLog() {
  if (!activeSystemLog) return;
  const current = activeSystemLog;
  activeSystemLog = null;
  current.controller.cleanup();
  currentRoute = current.returnRoute;
  app.dataset.route = currentRoute;
  current.previousFocus?.focus?.();
  applyTheme();
}

async function openSystemLog() {
  if (activeSystemLog || !["reader/cover", "archiver"].includes(currentRoute)) return;
  const screenshot = screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("fixture") !== "real";
  const returnRoute = currentRoute;
  const previousFocus = document.activeElement;
  const model = screenshot ? visualSystemLogFixture() : await request("systemLog.list", { offset: 0, limit: 100 });
  currentRoute = "system/log";
  app.dataset.route = currentRoute;
  const controller = mountSystemLog({
    template: systemLogTemplate,
    model,
    labels: systemLogLabels(),
    copyText: copySystemLogText,
    onReveal: (file) => screenshot ? Promise.resolve({ located: true }) : request("systemLog.reveal", { file }),
    onRefresh: () => screenshot ? Promise.resolve(model) : request("systemLog.list", { offset: 0, limit: 100 }),
    onDelete: (file) => {
      if (!screenshot) return request("systemLog.delete", { file });
      model.items = model.items.filter(item => item.capability !== file); model.total = model.items.length;
      return Promise.resolve({ status: "written", removed: 1 });
    },
    onClear: () => {
      if (!screenshot) return request("systemLog.clear", {});
      model.items = []; model.total = 0; return Promise.resolve({ status: "written", removed: 2 });
    },
    onLoadMore: (offset, limit) => screenshot
      ? Promise.resolve({ offset, limit, total: model.total, items: [] })
      : request("systemLog.list", { offset, limit }),
    onClose: closeSystemLog
  });
  activeSystemLog = { controller, returnRoute, previousFocus };
  overlayRoot.append(controller.element);
  applyTheme();
  controller.focus();
}

async function mountArchiverPage() {
  closeDocument();
  disposeActiveConversation();
  const bookmarkLoad = screenshotQuery.get("screenshot") === "1" && !["bookmark-install", "navigation-performance"].includes(screenshotQuery.get("interaction"))
    ? null
    : bookmarkQuery("light").catch((error) => bookmarkPlaceholder("light", error));
  const model = await archiverModel();
  currentPage?.cleanup?.();
  currentRoute = "archiver";
  app.dataset.route = currentRoute;
  currentPage = mountArchiver({
    template: archiverTemplate,
    model,
    state,
    libraryLabel: model.library?.display_path ?? "Cloudig",
    querySources,
    queryArchives: queryArchiverArchives,
    onContentSearch: showContentSearch,
    querySourceInfo: (row, signal) => requestWithSignal("archiver.claude.index", { source: row.capability }, signal),
    onError: (error) => showActionError(error),
    queryBookmarks: bookmarkQuery,
    queryBookmarkTarget: bookmarkTargetQuery,
    onBookmarkTargetSave: bookmarkTargetSave,
    onBookmarkCopy: bookmarkCopy,
    onBookmarkInstall: (profile, platforms) => bookmarkMutation("shell.bookmarks.install", profile, platforms),
    onBookmarkRemove: (profile, platforms) => bookmarkMutation("shell.bookmarks.remove", profile, platforms),
    onBookmarkError: (error) => showActionError(bookmarkError(error)),
    onParse: performArchiverParse,
    onCreateParseDirectory: createParseDirectory,
    directoryCreateErrorMessage,
    onClaude: (row) => indexClaudeSource(row).catch(() => undefined),
    queryClaude: queryClaudeRecords,
    onClaudeExtract: extractClaudeRows,
    onClaudeRebuild: (row) => indexClaudeSource(row, true),
    onClaudePreferences: (parse, workflow, directory) => setClaudePreferences(parse, workflow, directory),
    onClaudeError: (error) => showActionError(error),
    onClaudeReturn: () => {
      currentRoute = "archiver";
      app.dataset.route = currentRoute;
      currentPage?.refreshAll?.().catch(() => undefined);
    },
    onDismissSource: (row) => dismissMissingSource(row),
    onCancelParse: () => activeParseOperation?.cancel?.(),
    onShellAction: (action) => performArchiverShellAction(action).catch((error) => showActionError(error)),
    onJsonImport: platform => platformJsonDefinitions.some(item => item.id === platform && item.available) ? performSourceImport('platform_json', platform) : false,
    onParseSettings: async (settings, directory) => {
      try {
        return await setOrdinaryParse(settings, directory);
      } catch (error) {
        await showActionError(error);
        throw error;
      }
    },
    onParserWorkflow: async (workflow) => {
      if (state.revision !== null) state = preferenceState(await commitPreferencePatch(request, { workflow_parser: workflow }));
      else state.workflowParser = workflow;
      currentPage?.updateState?.(state);
    },
    onArchiveWorkflow: async (workflow) => {
      try {
        return await setArchiveWorkflow("archiver", workflow);
      } catch (error) {
        await showActionError(error);
        throw error;
      }
    },
    onRead: (row) => openArchiveFromArchiver(row).catch(() => undefined),
    onEdit: (row) => openConversationInfo(row).catch((error) => showActionError(error)),
    onDirectoryNew: () => openDirectoryManager("new"),
    onDirectoryManage: (directories) => manageArchiverDirectories(directories),
    onArchiveAction: (action, rows, directories) => performArchiverArchiveAction(action, rows, directories)
  });
  routeHost.replaceChildren(currentPage.element);
  applyTheme();
  applyLocale();
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("interaction") === "bookmarks-expanded") currentPage.element.querySelector("[data-archiver-bookmark-expand]").click();
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("interaction") === "parse-settings") {
    const page = currentPage.element;
    const workspace = page.querySelector(".archiver-parser-workspace");
    const scene = page.querySelector(".archiver-center-scenes");
    const beforeZ = getComputedStyle(workspace).zIndex;
    const before = scene.getBoundingClientRect();
    page.querySelector("[data-archiver-parse-settings]").click();
    await new Promise(requestAnimationFrame);
    const popup = page.querySelector("[data-archiver-parse-settings-popover]");
    const after = scene.getBoundingClientRect(), bounds = popup.getBoundingClientRect();
    if (popup.hidden || popup.parentElement !== page.querySelector(".archiver-center")
      || getComputedStyle(workspace).zIndex !== beforeZ || before.y !== after.y || before.height !== after.height
      || page.scrollTop !== 0 || bounds.bottom > innerHeight || bounds.left < 0 || bounds.right > innerWidth) {
      throw new Error("Parse settings altered the underlying workspace or failed to float above it");
    }
  }
  if (screenshotQuery.get("screenshot") === "1" && screenshotQuery.get("interaction") === "archive-time-field") {
    const page = currentPage.element;
    const button = page.querySelector("button[data-archive-time-field]");
    button.click();
    await new Promise(requestAnimationFrame);
    const popup = page.querySelector(".archiver-filter-popover");
    const anchor = button.getBoundingClientRect(), bounds = popup?.getBoundingClientRect();
    if (!popup || getComputedStyle(popup).position !== "absolute" || Math.abs(bounds.top - anchor.bottom - 6) > 1
      || bounds.bottom > innerHeight || bounds.left < 0 || bounds.right > innerWidth || page.scrollTop !== 0) {
      throw new Error("Archiver time bubble is not anchored within the viewport");
    }
  }
  if (screenshotQuery.get("screenshot") === "1" && ["bookmark-profile-hover", "bookmark-version-hover"].includes(screenshotQuery.get("interaction"))) {
    if (innerWidth <= 1320) currentPage.element.querySelector("[data-archiver-bookmark-expand]").click();
    const target = screenshotQuery.get("interaction") === "bookmark-profile-hover" ? "[data-bookmark-profile='light']" : ".archiver-bookmark-row[data-status='outdated'] .archiver-bookmark-state";
    currentPage.element.querySelector(target).dispatchEvent(new PointerEvent("pointerenter"));
  }
  if (bookmarkLoad) {
    const mountedPage = currentPage;
    const applied = bookmarkLoad.then((bookmarks) => {
      if (currentPage === mountedPage && currentRoute.startsWith("archiver")) mountedPage.replaceBookmarks?.(bookmarks);
    });
    if (screenshotQuery.get("interaction") === "bookmark-install") await applied;
  }
  return model;
}

async function openDirectoryManager(action) {
  if (overlayRoot.querySelector(".reader-directory-create-dialog, .reader-directory-dialog")) return;
  if (action === "new") {
    showDirectoryCreator(async (name) => {
      await request("reader.directory.create", { name });
      await currentPage?.refreshAll?.();
    });
    return;
  }
  const model = await queryArchives({ offset: 0, limit: 1, search: "", sort: "content_desc" });
  manageArchiverDirectories(model.directories ?? [], "manage");
}

async function mountReader() {
  closeDocument();
  disposeActiveConversation();
  const model = await readerModel();
  currentPage?.cleanup?.();
  currentRoute = "reader/cover";
  app.dataset.route = currentRoute;
  currentPage = mountReaderCover({
    template: readerTemplate,
    model,
    state,
    libraryLabel: model.degraded ? "cloudig\\inbox" : (model.library_label ?? "Cloudig"),
    queryArchives,
    onContentSearch: showContentSearch,
    onWorkflowChange: (workflow) => setArchiveWorkflow("reader", workflow),
    onWorkflowError: (error) => showActionError(error),
    onOpen: (row) => openReaderConversation(row).catch((error) => showActionError(error)),
    onArchiveAction: performReaderArchiveAction,
    onDirectoryAction: (action) => openDirectoryManager(action).catch((error) => showActionError(error))
  });
  routeHost.replaceChildren(currentPage.element);
  applyTheme();
  applyLocale();
  return model;
}

async function revealRoute(route, withTransition = true) {
  if (activeConversationInfo) { await activeConversationInfo.close(); return; }
  if (route === currentRoute) return;
  if (!['welcome', 'reader/cover', 'archiver'].includes(route)) return;
  closeDocument();
  const token = ++routeOrdinal;
  if (withTransition) {
    transition.hidden = false;
    transition.dataset.leaving = "false";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  try {
    if (route === "reader/cover") {
      await Promise.all([preload(readerCoverPreload), mountReader()]);
    } else if (route === "archiver") {
      await Promise.all([preload(archiverPreload), mountArchiverPage()]);
    } else {
      await preload([...themeImages(state.theme), "/assets/welcome/OsisLogo-Main-1024.png"]);
      mountWelcome();
    }
  } catch (error) {
    if (withTransition && token === routeOrdinal) hideTransition(token);
    throw error;
  }
  if (token !== routeOrdinal) return;
  if (withTransition) {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    transition.dataset.leaving = "true";
    setTimeout(() => {
      if (token !== routeOrdinal) return;
      transition.hidden = true;
      delete transition.dataset.leaving;
    }, 190);
  }
}

function showUpdateCheck(initial) {
  // A late background discovery must not let an update discard an open edit.
  if ([...document.querySelectorAll('[aria-modal="true"]:not(.cloudig-update-dialog), dialog[open]')].some(node=>node.getClientRects().length>0)) return false;
  return openUpdateCheck({ host: overlayRoot, background: routeHost, language: state.language, initial,
    check: signal => requestWithSignal("shell.checkUpdates", {}, signal),
    prepare: (signal, onProgress) => requestWithSignal("shell.update.prepare", {}, signal, onProgress),
    install: capability => request("shell.update.install", { capability }) });
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !app.contains(button)) return;
  if (activeConversationInfo && routeHost.contains(button)) {
    event.preventDefault(); event.stopPropagation(); activeConversationInfo.close(); return;
  }
  const route = button.dataset.routeTarget;
  if (button.dataset.action === "open-docs") { revealRoute("archiver").then(() => openStandard('archive')).catch(showActionError); return; }
  if (button.dataset.action === "check-update") { showUpdateCheck(); return; }
  if (['archive', 'json', 'roadmap', 'license', 'bookmark', 'platforms'].includes(button.dataset.docTopic)) { openStandard(button.dataset.docTopic).catch(showActionError); return; }
  if (route === "time/cover") { openTimeCover().catch((error) => showActionError(error)); return; }
  if (route === "system/log") { openSystemLog().catch((error) => showActionError(error)); return; }
  if (route === "welcome" || route === "reader" || route === "archiver") revealRoute(route === "reader" ? "reader/cover" : route).catch((error) => showActionError(error));
  if (route === "reader-cover") returnReaderCover().catch((error) => showActionError(error));
  if (button.dataset.action === "toggle-theme") setTheme(state.theme === "dawn" ? "star-night" : "dawn").catch((error) => showActionError(error));
  if (button.dataset.action === "toggle-language") setLanguage(state.language === "zh-CN" ? "en" : "zh-CN").catch((error) => showActionError(error));
  if (button.dataset.action === "edit-identity" && !activeConversation?.row.example) openIdentityEditor(activeConversation?.row ?? null).catch((error) => showActionError(error));
});
addEventListener("resize", resizeWelcome, { passive: true });

async function boot() {
  root.dataset.bootState = "loading";
  root.dataset.ready = "false";
  const screenshot = screenshotQuery.get("screenshot") === "1";
  try {
    state = preferenceState(await request("library.preferences.query"));
    await refreshShellIdentity();
  } catch {
    // A missing Library keeps the complete Dawn cover and session-only controls.
  }
  if (screenshot && ["dawn", "star-night"].includes(screenshotQuery.get("theme"))) state.theme = screenshotQuery.get("theme");
  if (screenshot && ["zh-CN", "en"].includes(screenshotQuery.get("language"))) state.language = screenshotQuery.get("language");
  if (!state.userNameCustom) state.userName = state.language === "en" ? "User" : "采云用户";
  if (!state.assistantNameCustom) state.assistantName = state.language === "en" ? "AI" : "智能伙伴";
  if (screenshot && screenshotQuery.get("phase")) root.dataset.screenshotPhase = screenshotQuery.get("phase");
  currentLocale = await locale(state.language).catch(() => locale("zh-CN"));
  applyTheme();
  applyLocale();
  const requestedRoute = screenshotQuery.get("route");
  const initialRoute = requestedRoute === "reader" || requestedRoute === "reader-directory-new" || requestedRoute === "conversation" || requestedRoute === "conversation-info" || requestedRoute === "identity-conversation" || requestedRoute === "time-cover" || requestedRoute === "time-editor" || requestedRoute === "system-log" ? "reader/cover" : requestedRoute === "archiver" || requestedRoute === "claude" ? "archiver" : "welcome";
  if (initialRoute === "reader/cover") {
    await preload(readerCoverPreload);
    const model = await mountReader();
    if (requestedRoute === "reader-directory-new") await openDirectoryManager("new");
    if (requestedRoute === "conversation" && model.items[0]) await openReaderConversation(model.items[0], false);
    if (requestedRoute === "conversation-info" && model.items[0]) await openConversationInfo(model.items[0]);
    if (requestedRoute === "identity-conversation" && model.items[0]) await openIdentityEditor(model.items[0]);
    if (requestedRoute === "time-cover" || requestedRoute === "time-editor") await openTimeCover("reader-cover");
    if (requestedRoute === "system-log") await openSystemLog();
  } else if (initialRoute === "archiver") {
    await preload(archiverPreload);
    await mountArchiverPage();
    if (requestedRoute === "claude") {
      if (screenshotQuery.get("fixture") === "real") {
        const sources = await querySources({ offset: 0, limit: 200 });
        const source = sources.items.find(row => row.kind === "claude_json");
        if (!source || !await indexClaudeSource(source)) throw new Error("Real Claude audit requires an indexable Inbox container");
      } else {
        const fixture = visualClaudeContainerFixture();
        currentRoute = "archiver/claude";
        app.dataset.route = currentRoute;
        currentPage?.openClaude?.(fixture, visualArchiverFixture().sources.items[0]);
      }
    }
  } else {
    await preload([
      ...themeImages(state.theme),
      "/assets/welcome/OsisLogo-Main-1024.png",
      "/assets/welcome/Cloudig-Logo-Title-Slogan.svg",
      "/assets/welcome/OsisLogo-Cloudig-1024.png",
      "/assets/welcome/OsisLogo-Simple.svg"
    ]);
    resizeWelcome();
    if (requestedRoute === "identity-editor") await openIdentityEditor();
  }
  if (screenshot && screenshotQuery.get("interaction") === "theme-roundtrip") {
    const initialTheme = state.theme;
    const clickTheme = async (expected) => {
      const button = app.querySelector("[data-action='toggle-theme']");
      if (!button || button.disabled) throw new Error("Theme audit cannot click the actual control");
      const archiver = app.querySelector("[data-page='archiver']");
      const headerTop = archiver?.querySelector(".archiver-topbar").getBoundingClientRect().top;
      button.click();
      const deadline = performance.now() + 10000;
      while ((root.dataset.theme !== expected || button.disabled) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
      const saved = await request("library.preferences.query", {});
      if (root.dataset.theme !== expected || saved.theme !== expected || button.disabled) throw new Error("Theme roundtrip did not update both the page and Library");
      if (archiver && (archiver.querySelector(".archiver-filter-popover") || archiver.scrollTop !== 0
        || Math.abs(archiver.querySelector(".archiver-topbar").getBoundingClientRect().top - headerTop) > .5)) {
        throw new Error("Theme switch opened an unrelated time menu or shifted the Archiver page");
      }
    };
    await clickTheme(initialTheme === "dawn" ? "star-night" : "dawn");
    const latest = await request("library.preferences.query", {});
    // Deliberately advance the real Library without refreshing the UI token.
    await request("library.preferences.commit", { expected_revision: latest.revision, parse_ordinary: { ...latest.parse_ordinary, update_outdated: !latest.parse_ordinary.update_outdated } });
    await clickTheme(initialTheme);
    root.dataset.themeRoundtrip = "passed";
  }
  if (screenshot && ["parse-settings", "docs-navigation"].includes(screenshotQuery.get("interaction"))) {
    // Hit-testing must wait for the normal startup cover to leave. Otherwise
    // the audit mistakes that intentional cover for a settings-layer defect.
    hideTransition(routeOrdinal);
    const deadline = performance.now() + 2000;
    while (!transition.hidden && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!transition.hidden) throw new Error("The startup cover has not left the interaction under test");
    if (screenshotQuery.get("interaction") === "parse-settings") {
      const popup = app.querySelector("[data-archiver-parse-settings-popover]");
      const bounds = popup.getBoundingClientRect();
      if (document.elementFromPoint(bounds.left + 20, bounds.top + 20)?.closest("[data-archiver-parse-settings-popover]") !== popup) {
        throw new Error("Parse settings are obscured by the underlying page");
      }
    } else {
      const entries = [...app.querySelectorAll(".archiver-doc-card li button")];
      const visibleButterflies = () => entries.flatMap(entry => [...entry.querySelectorAll("img")]).filter(img => getComputedStyle(img).display !== "none" && Number(getComputedStyle(img).opacity) > .01);
      if (entries.length !== 6 || visibleButterflies().length) throw new Error("Document butterflies must be absent before interaction");
      for (const entry of entries) {
        const copy = entry.querySelector("span"), butterfly = entry.querySelector(`.archiver-theme-${state.theme}`);
        const bounds = entry.getBoundingClientRect(), text = copy.getBoundingClientRect(), wingStyle = getComputedStyle(butterfly);
        const wingLeft = bounds.right - parseFloat(wingStyle.right) - parseFloat(wingStyle.width);
        if (copy.scrollWidth > copy.clientWidth + 1 || text.height > bounds.height || text.right > wingLeft - 2) {
          throw new Error(`Document label/butterfly layout overlaps: ${entry.dataset.docTopic}`);
        }
      }
      // Pointer interaction is sent by the offscreen host after readiness. A
      // hidden native window cannot acquire :focus-visible without activation.
    }
  }
  root.dataset.bootState = "ready";
  root.dataset.ready = "true";
  hideTransition(routeOrdinal);
  if (!screenshot && globalThis.chrome?.webview) void checkStartupUpdate({ host: overlayRoot, language: state.language, check: () => request("shell.checkStartupUpdate", {}), open: showUpdateCheck });
}

boot().catch((error) => {
  if (screenshotQuery.get("screenshot") === "1") root.dataset.bootError = error instanceof Error ? error.message : String(error);
  root.dataset.bootState = "failed";
  root.dataset.ready = "false";
  hideTransition(routeOrdinal);
  void showActionError(error);
});
