import { claudeContainerPreload, mountClaudeContainer } from "./claude-container.js";
import { mountPlatformJsonIndex } from "./platform-json.js";
import { platformJsonDefinitions } from "./platform-json-presentation.js";
import { bindOverflowText } from "../../overflow-text.js";
import { localizePlatformLabel } from "../../platform-labels.js";
import { bindArchiverLayout } from "./archiver-layout.js";
import { updateOperationProgress } from "../../operation-progress.js";
import { mountParseTarget } from "../../parse-target.js";
import { archiveScopeQuery, archiveScopeLabel, toggleArchiveScope } from "../../archive-scope.js";
import { bindSearchEntry } from "../../search-entry.js";
import { formatTimeRange } from "/shared/time/endpoint-editor.js";
import {
  archivePreferenceSort,
  archivePreferenceTimeField,
  archiveQuerySort,
  archiveQueryTimeField,
  archiveTimeFieldLabels,
  archiveRowTimestamp,
  archiveDateLabel,
  normalizeArchiveWorkflow
} from "../../archive-workflow.js";

const platformDefinitions = [
  ["chatgpt", "ChatGPT", "chatgpt.com"],
  ["claude", "Claude", "claude.ai"],
  ["deepseek", "DeepSeek", "chat.deepseek.com"],
  ["gemini", "Gemini", "gemini.google.com"],
  ["grok", "Grok", "grok.com"],
  ["doubao", "豆包", "doubao.com"],
  ["kimi", "Kimi", "kimi.com"],
  ["qwen", "Qwen", "chat.qwen.ai"],
  ["chatglm", "智谱清言", "chatglm.cn"],
  ["zai", "Z.ai", "z.ai"],
  ["yuanbao", "元宝", "yuanbao.tencent.com"],
  ["mistral", "Mistral", "chat.mistral.ai"]
];

// Agent-tool sources are not bookmark platforms: keep them out of install and
// official-platform filters, but give their already-parsed rows their own
// readable label and mark instead of falling back to the question-mark asset.
const agentPlatformDefinitions = Object.freeze({
  cline: ["Cline", "/assets/platforms/platform-cline.svg"],
  sillytavern: ["SillyTavern", "/assets/platforms/platform-sillytavern.svg"],
  "kimi-code": ["Kimi Code", "/assets/platforms/platform-kimi-code.svg"],
  "claude-code": ["Claude Code", "/assets/platforms/platform-claude-code.svg"],
  codex: ["Codex", "/assets/platforms/platform-codex.svg"]
});
const allPlatformDefinitions = Object.freeze([
  ...platformDefinitions,
  ...Object.entries(agentPlatformDefinitions).map(([id, [label]]) => [id, label, ""])
]);

const statusOrder = ["all", "pending", "complete", "failed", "missing", "unsupported"];

function platformLabel(id, language) {
  const chinese = platformDefinitions.find(([key]) => key === id)?.[1] ?? agentPlatformDefinitions[id]?.[0];
  if (!chinese) return language === "en" ? "Unknown" : "未知";
  return localizePlatformLabel(id, chinese, language);
}

function platformAsset(platform) {
  if (platform === "doubao") return "/assets/platforms/platform-doubao.png";
  return platformDefinitions.some(([id]) => id === platform)
    ? `/assets/platforms/platform-${platform}.svg`
    : agentPlatformDefinitions[platform]?.[1] ?? "/assets/platforms/platform-unknown.svg";
}

function image(source, className = "") {
  const node = document.createElement("img");
  node.src = source;
  node.alt = "";
  node.className = className;
  return node;
}

function copyIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const front = document.createElementNS(svg.namespaceURI, "rect");
  front.setAttribute("x", "6");
  front.setAttribute("y", "6");
  front.setAttribute("width", "13");
  front.setAttribute("height", "13");
  front.setAttribute("rx", "2");
  const back = document.createElementNS(svg.namespaceURI, "path");
  back.setAttribute("d", "M14 6V3a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3");
  svg.append(back, front);
  return svg;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatMtime(value) {
  try {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return archiveDateLabel(date.toISOString());
  } catch { }
  return "—";
}

function statusLabels(language) {
  return language === "en"
    ? { all: "All", pending: "Pending", complete: "Complete", update_action: "Update", failed: "Failed", missing: "Missing", unsupported: "Unsupported" }
    : { all: "全部", pending: "待解析", complete: "已完成", update_action: "解析器更新", failed: "失败", missing: "文件缺失", unsupported: "不支持" };
}

function profileName(profile, language) {
  if (language === "en") return profile === "light" ? "Light" : profile === "full" ? "Full" : "Tree";
  return profile === "light" ? "轻装" : profile === "full" ? "全量" : "整树";
}

function bookmarkVersionLabel(name, version) {
  const display = String(version ?? "—")
    .replace(/-all[_-]branches$/u, "-Tree")
    .replace(/-light$/u, "-Light")
    .replace(/-full$/u, "-Full");
  return `${name}-${display}`;
}

function bookmarkStatusLabel(status, language) {
  const values = language === "en"
    ? { current: "Installed", newer: "Installed · newer than bundled", outdated: "Update available", missing: "Not installed", invalid: "Invalid Chrome data", unavailable: "Chrome profile unavailable", partial: "Repair needed", different_profile: "Another profile is installed" }
    : { current: "已安装", newer: "已安装·高于内置版本", outdated: "可更新", missing: "未安装", invalid: "Chrome数据无效", unavailable: "没有可用的Chrome配置", partial: "需要修复", different_profile: "已安装其它档位" };
  return values[status] ?? status;
}

function bookmarkStatusIcon(status) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14"); svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(svg.namespaceURI, "circle");
  circle.setAttribute("cx", "7"); circle.setAttribute("cy", "7"); circle.setAttribute("r", "5.9"); svg.append(circle);
  if (status === "current" || status === "newer") {
    const check = document.createElementNS(svg.namespaceURI, "path"); check.setAttribute("d", "m3.6 7 2.2 2.2 4.7-4.6"); svg.append(check);
  } else if (["outdated", "invalid", "partial", "different_profile"].includes(status)) {
    const mark = document.createElementNS(svg.namespaceURI, "path"); mark.setAttribute("d", "M7 3.5v4M7 10h.01"); svg.append(mark);
  }
  return svg;
}

function bookmarkStatusDescription(name, state, language) {
  const status = bookmarkStatusLabel(state?.status ?? "unavailable", language);
  const installed = state?.installed_version ? bookmarkVersionLabel(name, state.installed_version) : null;
  const latest = bookmarkVersionLabel(name, state?.version);
  if (state?.status === "current") return `${status}\n${installed ?? latest}`;
  if (state?.status === "newer") return `${status}\n${installed}\n${language === "en" ? "Kept as installed; no downgrade." : "保留已安装版本，不降级。"}`;
  if (state?.status === "outdated") return language === "en" ? `Installed: ${installed ?? "—"}\nLatest: ${latest}` : `已安装：${installed ?? "—"}\n最新：${latest}`;
  return `${status}${installed ? `\n${installed}` : ""}${state?.version ? `\n${language === "en" ? "Available" : "可安装"}：${latest}` : ""}`;
}

function showBookmarkHint(root, hint, anchor, content) {
  hint.textContent = content;
  hint.dataset.visible = "true";
  const panel = root.querySelector(".archiver-bookmark-panel").getBoundingClientRect();
  const target = anchor.getBoundingClientRect();
  const box = hint.getBoundingClientRect();
  const above = target.bottom - panel.top + 9 + box.height > panel.height - 7;
  hint.dataset.side = above ? "above" : "below";
  hint.style.top = `${above ? target.top - panel.top - box.height - 9 : target.bottom - panel.top + 9}px`;
  hint.style.setProperty("--bookmark-hint-arrow", `${Math.max(12, Math.min(box.width - 12, target.left + target.width / 2 - box.left))}px`);
}

function renderBookmarks(root, profile, model) {
  const host = root.querySelector("[data-archiver-bookmark-list]");
  host.replaceChildren();
  const platformModel = new Map((model?.platforms ?? []).map((item) => [item.id, item]));
  // The query is a snapshot. Chrome may have been closed since it was read;
  // let the native command recheck the live condition at the actual click.
  const canMutate = Boolean(model?.target) && root.dataset.bookmarkBusy !== "true";
  const hint = root.querySelector("[data-bookmark-version-help]"); delete hint.dataset.visible;
  for (const [platform, , domain] of platformDefinitions) {
    const name = platformLabel(platform, root.lang);
    const state = platformModel.get(platform);
    const row = document.createElement("article");
    row.className = "archiver-bookmark-row";
    row.dataset.platform = platform;
    row.dataset.status = state?.status ?? "unavailable";
    if (platform === "claude") row.dataset.highlightTarget = "bookmark-claude";
    row.append(image(platformAsset(platform)));
    const copy = document.createElement("span");
    copy.className = "archiver-bookmark-caption";
    const title = document.createElement("strong");
    const titleText = document.createElement("span");
    titleText.textContent = name;
    const stateIcon = document.createElement("button"); stateIcon.type = "button";
    stateIcon.className = "archiver-bookmark-state";
    const stateDescription = bookmarkStatusDescription(name, state, root.lang);
    stateIcon.setAttribute("aria-label", stateDescription.replaceAll("\n", "；"));
    stateIcon.setAttribute("aria-describedby", "archiver-bookmark-version-help");
    stateIcon.append(bookmarkStatusIcon(state?.status));
    for (const event of ["pointerenter", "focus"]) stateIcon.addEventListener(event, () => showBookmarkHint(root, hint, stateIcon, stateDescription));
    for (const event of ["pointerleave", "blur"]) stateIcon.addEventListener(event, () => { delete hint.dataset.visible; });
    title.append(titleText, stateIcon);
    const small = document.createElement("small");
    small.textContent = domain;
    copy.append(title, small);
    const install = document.createElement("button");
    install.type = "button";
    install.className = "archiver-bookmark-install";
    install.dataset.highlightTarget = "bookmark-install-one";
    install.dataset.bookmarkPlatform = platform;
    const installedCurrent = ["current", "newer"].includes(state?.status);
    install.dataset.bookmarkOperation = installedCurrent ? "remove" : "install";
    const operationLabel = installedCurrent
      ? (root.lang === "en" ? "Remove" : "卸载")
      : state?.status === "outdated"
        ? (root.lang === "en" ? "Update" : "更新")
        : (root.lang === "en" ? "Install" : "安装");
    install.textContent = `${operationLabel}·${profileName(profile, root.lang)}`;
    install.disabled = !canMutate || state?.status === "invalid";
    install.title = `${operationLabel}·${profileName(profile, root.lang)}`;
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "archiver-bookmark-copy";
    copyButton.dataset.highlightTarget = "bookmark-copy";
    copyButton.dataset.bookmarkCopy = platform;
    copyButton.append(copyIcon());
    copyButton.title = root.lang === "en" ? "Copy bookmarklet" : "复制书签";
    copyButton.disabled = !state || root.dataset.bookmarkBusy === "true";
    row.append(copy, install, copyButton);
    host.append(row);
  }
}

function renderSourceStatuses(root, model, selected) {
  const host = root.querySelector("[data-source-statuses]");
  host.replaceChildren();
  const labels = statusLabels(root.lang);
  for (const status of statusOrder) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.sourceStatus = status;
    button.dataset.selected = String(selected === status);
    const count = status === "all"
      ? Object.values(model.statuses ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
      : model.statuses?.[status] ?? 0;
    button.textContent = `${labels[status]} ${count}`;
    host.append(button);
  }
}

function statusLabel(status, language) {
  return statusLabels(language)[status] ?? status;
}

function ordinarySource(row) {
  return row.kind !== "claude_json" && !row.filename.toLowerCase().endsWith(".json");
}

function sourceCaptureLabel(row, language) {
  return typeof row.captured_at === "string" ? archiveDateLabel(row.captured_at) : language === "en" ? "Unknown" : "未知";
}

function sourceErrorLabel(row, language) {
  const codes = language === "en"
    ? { "invalid-json": "Invalid JSON", "unsupported-source": "Unsupported source format", "parser-failed": "Parser failed", "parse-conflict": "Source changed before commit", "catalog-not-ready": "Catalog is not ready" }
    : { "invalid-json": "JSON格式无效", "unsupported-source": "当前版本不支持此来源格式", "parser-failed": "解析器未能完成", "parse-conflict": "提交前来源发生变化", "catalog-not-ready": "目录投影尚未就绪" };
  const retries = language === "en"
    ? { immediate: "May retry now", after_source_change: "Retry after the source changes", after_adapter_change: "Retry after a Parser update", after_conflict_resolution: "Resolve the conflict first", after_recovery: "Recover the Library first", never_for_this_version: "Not retryable in this version" }
    : { immediate: "可立即重试", after_source_change: "来源改变后重试", after_adapter_change: "解析器更新后重试", after_conflict_resolution: "解决冲突后重试", after_recovery: "恢复资料库后重试", never_for_this_version: "当前版本不可重试" };
  return `${codes[row.error] ?? row.error ?? (language === "en" ? "Unknown failure" : "未知失败")} · ${retries[row.retry] ?? row.retry ?? (language === "en" ? "Refresh and inspect" : "请刷新后检查")}`;
}

function profileDescription(profile, language) {
  if (language === "en") {
    if (profile === "light") return "Visible branch text and compressed images; no attachments or hidden branches.";
    if (profile === "full") return "Visible branch text, original images and attachments; no hidden branches.";
    return "All branch text, original images and attachments. Platforms without branches (Gemini, Doubao, ChatGLM and Yuanbao) use Full instead.";
  }
  if (profile === "light") return "保存网页显示的分支文本、压缩图片，不下载附件。不保存隐藏分支。";
  if (profile === "full") return "保存网页显示的分支文本、原图与附件。不保存隐藏分支。";
  return "保存全部分支文本、原图与附件。不支持分支的平台（Gemini、豆包、智谱清言、元宝）替换为全量版。";
}

function selectionMarker(platform, selected, label) {
  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = "archiver-row-marker";
  marker.dataset.platform = platform ?? "";
  marker.setAttribute("aria-pressed", String(selected));
  marker.setAttribute("aria-label", label);
  marker.append(
    image(platformAsset(platform), "archiver-row-platform"),
    image("/assets/reader/Pushpin-Red.svg", "archiver-row-pin archiver-theme-dawn"),
    image("/assets/reader/Pushpin-Purple.svg", "archiver-row-pin archiver-theme-star-night")
  );
  return marker;
}

function renderSourceRows(root, model, selection, callbacks) {
  const host = root.querySelector("[data-source-list]");
  host.replaceChildren();
  const rows = Array.isArray(model.items) ? model.items : [];
  for (const row of rows) {
    const item = document.createElement("article");
    item.className = "archiver-list-row archiver-source-row";
    item.dataset.sourceCapability = row.capability;
    item.dataset.selected = String(selection.has(row.capability));
    item.tabIndex = 0;
    const selected = selection.has(row.capability);
    const claudeContainer = row.kind === "claude_json" || row.filename.toLowerCase().endsWith(".json");
    const marker = selectionMarker(row.platform, selected, `${selected ? (root.lang === "en" ? "Deselect" : "取消选择") : (root.lang === "en" ? "Select" : "选择")} ${row.filename}`);
    const file = document.createElement("span");
    file.className = "archiver-source-file";
    file.title = row.filename;
    const fileName = document.createElement("span");
    fileName.dataset.overflowText = "";
    fileName.textContent = row.filename;
    file.append(fileName);
    const date = document.createElement("span");
    date.textContent = sourceCaptureLabel(row, root.lang);
    date.title = `${root.lang === "en" ? "Original file modified: " : "原文件修改时间："}${formatMtime(row.mtime_ns)}`;
    const status = document.createElement("span");
    const statusText = document.createElement("span");
    statusText.textContent = statusLabel(row.status, root.lang);
    status.append(statusText);
    status.dataset.status = row.status;
    if (row.error) {
      const help = document.createElement("button");
      help.type = "button";
      help.className = "archiver-source-error-help";
      help.textContent = "?";
      help.title = sourceErrorLabel(row, root.lang);
      help.setAttribute("aria-label", help.title);
      status.append(help);
    }
    const action = document.createElement("button");
    action.type = "button";
    if (row.status === "missing") action.dataset.sourceDismiss = row.capability;
    else if (claudeContainer) action.dataset.sourceClaude = row.capability;
    else action.dataset.sourceParse = row.capability;
    action.className = row.status === "missing" ? "archiver-source-dismiss" : "archiver-source-parse";
    action.dataset.sourceActionState = row.status;
    action.textContent = row.status === "missing" ? "×" : row.status === "unsupported" ? "—" : "";
    action.title = row.status === "missing"
      ? (root.lang === "en" ? "Clear this missing source record" : "清除这条来源缺失记录")
      : claudeContainer
        ? (root.lang === "en" ? `Open ${platformLabel(row.platform, root.lang)} conversation file` : `打开${platformLabel(row.platform, root.lang)}会话文件解析`)
      : row.status === "unsupported"
        ? statusLabel(row.status, root.lang)
        : row.status === "pending"
          ? (root.lang === "en" ? "Parse" : "解析")
          : (root.lang === "en" ? "Parse again" : "重新解析");
    action.disabled = row.status === "unsupported" && !claudeContainer;
    item.append(marker, file, date, status, action);
    const toggle = () => callbacks.onSelect(row, !selection.has(row.capability));
    marker.addEventListener("click", (event) => { event.stopPropagation(); toggle(); });
    item.addEventListener("click", (event) => { if (!event.target.closest("button")) toggle(); });
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      if (row.status === "missing") callbacks.onDismiss(row);
      else if (claudeContainer) callbacks.onClaude(row);
      else callbacks.onParse([row]);
    });
    item.addEventListener("pointerenter", () => callbacks.onInspect(row));
    item.addEventListener("focusin", () => callbacks.onInspect(row));
    host.append(item);
  }
}

function contentDate(row, field = "content_start") {
  if (!field.startsWith("content_")) {
    const value = archiveRowTimestamp(row, field);
    return archiveDateLabel(value);
  }
  const range = row.content_time?.range;
  const endpoint = field === "content_end" ? range?.end ?? range?.start : range?.start;
  if (endpoint?.kind === "calendar" && Number.isInteger(endpoint.year)) {
    return `${endpoint.era === "BC" ? "BC " : ""}${endpoint.year}${Number.isInteger(endpoint.month) ? `-${String(endpoint.month).padStart(2, "0")}` : ""}${Number.isInteger(endpoint.day) ? `-${String(endpoint.day).padStart(2, "0")}` : ""}`;
  }
  if (endpoint?.kind === "sovereign") return endpoint.snapshot?.label ?? endpoint.target?.node ?? "—";
  return endpoint?.kind === "whenever" ? "Whenever" : endpoint?.kind === "unknown" ? "Unknown" : "—";
}

function renderArchiveRows(root, model, selection, callbacks, timeField) {
  const host = root.querySelector("[data-archive-list]");
  host.replaceChildren();
  const rows = Array.isArray(model.items) ? model.items : [];
  for (const row of rows) {
    const item = document.createElement("article");
    item.className = "archiver-list-row archiver-archive-row";
    item.dataset.archiveCapability = row.capability;
    item.dataset.selected = String(selection.has(row.capability));
    item.tabIndex = 0;
    const selected = selection.has(row.capability);
    const marker = selectionMarker(row.platform, selected, `${selected ? (root.lang === "en" ? "Deselect" : "取消选择") : (root.lang === "en" ? "Select" : "选择")} ${row.title}`);
    const title = document.createElement("span");
    title.className = "archiver-archive-title";
    title.title = row.title;
    const titleCopy = document.createElement("span");
    titleCopy.dataset.overflowText = "";
    titleCopy.textContent = row.title;
    title.append(titleCopy);
    const time = document.createElement("span");
    time.textContent = contentDate(row, timeField);
    const directory = document.createElement("span");
    directory.textContent = row.archived ? (root.lang === "en" ? "Archived" : "归档区") : row.directory || (root.lang === "en" ? "Root" : "默认目录");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.archiveEdit = row.capability;
    const pencil = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    pencil.setAttribute("viewBox", "0 0 24 24"); pencil.setAttribute("aria-hidden", "true");
    const pencilShape = document.createElementNS(pencil.namespaceURI, "path");
    pencilShape.setAttribute("d", "m4 15-1 6 6-1L20 9l-5-5Zm12-12 2-2 5 5-2 2Z M4 15l5 5");
    pencil.append(pencilShape); edit.append(pencil);
    edit.title = root.lang === "en" ? "Edit conversation information" : "编辑会话信息";
    item.append(marker, title, time, directory, edit);
    const toggle = () => callbacks.onSelect(row, !selection.has(row.capability));
    marker.addEventListener("click", (event) => { event.stopPropagation(); toggle(); });
    item.addEventListener("click", (event) => { if (!event.target.closest("button")) toggle(); });
    edit.addEventListener("click", (event) => { event.stopPropagation(); callbacks.onEdit(row); });
    item.addEventListener("dblclick", () => callbacks.onRead(row));
    item.addEventListener("pointerenter", () => callbacks.onInspect(row));
    item.addEventListener("focusin", () => callbacks.onInspect(row));
    host.append(item);
  }
}

function updateStats(root, selector, values) {
  for (const [key, value] of Object.entries(values ?? {})) {
    const node = root.querySelector(`[${selector}="${key}"]`);
    if (node) node.textContent = key.includes("bytes") ? formatBytes(value) : String(value);
  }
}

function setInfo(host, title, lines) {
  const strong = document.createElement("strong");
  strong.textContent = title;
  strong.dataset.overflowText = "";
  strong.title = title;
  host.replaceChildren(strong);
  for (const line of lines) {
    const copy = document.createElement("span");
    copy.textContent = line;
    host.append(copy);
  }
}

function fixtureRows() {
  const rows = [
    ["GPT-5.6-Sol·奥思·绯缎缠骨", "chatgpt"],
    ["Gemini-3.5-Flash·奥思·情炽电波", "gemini"],
    ["DeepSeek·奥思·流云逐月", "deepseek"],
    ["DeepSeek·奥思·玄鉴澄心", "deepseek"],
    ["Grok-4.5·奥思·欲神缠天", "grok"],
    ["豆包·奥思·千形落卷", "doubao"],
    ["Kimi-K2.6-thinking·奥思·星河为誓", "kimi"],
    ["Qwen3.7-Plus·奥思·拓扑狂吻", "qwen"],
    ["GLM-5.2·奥思·琉光拥雪", "chatglm"],
    ["GLM-5.2·奥思·炽吻噬魂", "zai"],
    ["Hy3·奥思·墨锋裁规", "yuanbao"],
    ["Mistral-Medium-3.5·奥思·霆霜刃影", "mistral"],
    ["GPT-5.6-Sol·奥思·绯缎缠骨", "chatgpt"],
    ["Claude-Sonnet-5·奥思·墨笺测锦", "claude"],
    ["Claude-Opus-4.6·奥思·吻碎乾坤", "claude"]
  ];
  return rows.map(([title, platform], index) => {
    const day = 14 + Math.min(index, 2);
    const timestamp = `2026-07-${String(day).padStart(2, "0")}T12:00:00.000Z`;
    return ({
    capability: `a_${String(index + 1).padStart(43, "0")}`,
    archive: `a${index + 1}`,
    generation: 1,
    title,
    filename: `${title}.json`,
    platform,
    models: [],
    content_time: { range: { start: { kind: "calendar", era: "AD", year: 2026, month: 7, day } } },
    edited_at: timestamp,
    mtime_ns: String(BigInt(Date.parse(timestamp)) * 1_000_000n),
    times: { json_edited_at: timestamp, json_created_at: timestamp, source_captured_at: timestamp, message_start: timestamp, message_end: timestamp },
    bytes: 2_000_000 + index * 1000,
    messages: 20 + index,
    resources: index,
    directory: index === 14 ? "灾后重建" : "",
    archived: false,
    access: "normal",
    selected: index < 3
  });
  });
}

export function visualArchiverFixture() {
  const archives = fixtureRows();
  const sourceArchives = archives.slice(0, 14);
  const sources = [{
    capability: `s_${String(1).padStart(43, "0")}`,
    filename: "conversations.json",
    bytes: 18_900_000,
    mtime_ns: String(1_783_814_400_000_000_000n),
    captured_at: new Date(1_783_814_400_000).toISOString(),
    status: "pending",
    kind: "claude_json",
    platform: "claude"
  }, ...sourceArchives.map((row, index) => ({
    capability: `s_${String(index + 2).padStart(43, "0")}`,
    filename: row.title,
    bytes: row.bytes,
    mtime_ns: String(1_783_900_800_000_000_000n + BigInt(index + 1) * 86_400_000_000_000n),
    captured_at: new Date(1_783_900_800_000 + (index + 1) * 86_400_000).toISOString(),
    status: index === 2 ? "failed" : index === 4 ? "missing" : index === sourceArchives.length - 1 ? "unsupported" : "complete",
    kind: "bookmark_html",
    platform: row.platform,
    ...(index === 2 ? { error: "parser-failed", retry: "immediate" } : {})
  }))];
  return {
    library: { available: true, display_path: "C:\\Users\\Osis\\Cloudig" },
    bookmarks: {
      bookmark_set_version: "2026.08.30.2",
      requested_profile: "light",
      browser_state: "closed",
      changelog_error: "",
      stores: [{ capability: `bs_${"b".repeat(32)}`, label: "测试主配置 · Chrome Account", kind: "account", selected: true }],
      target: {
        store: `bs_${"b".repeat(32)}`,
        parent: `bf_${"f".repeat(32)}`,
        display_path: "测试主配置 / Bookmarks bar / 采云 Cloudig",
        folder_name: "采云 Cloudig",
        place_first: true,
        exists: true,
        folders: [{ capability: `bf_${"f".repeat(32)}`, name: "Bookmarks bar", path: "Bookmarks bar", depth: 0, selectable: true, selected: true }]
      },
      platforms: allPlatformDefinitions.map(([id, label], index) => ({
        id,
        label,
        version: id === "chatgpt" ? "3.7.34-light" : `1.${index}.0-light`,
        requested_profile: "light",
        effective_profile: "light",
        fallback: false,
        status: index < 3 ? "current" : index === 3 ? "outdated" : "missing",
        installed_version: index < 3 ? (id === "chatgpt" ? "3.7.34-light" : `1.${index}.0-light`) : index === 3 ? "1.2.0-light" : "",
        upgrade_notes: []
      }))
    },
    sources: { degraded: false, total: sources.length, stats: { bytes: 50_000_000, files: sources.length, bookmark_html: sources.length - 1, claude_json: 1 }, statuses: { pending: 1, complete: 11, failed: 1, missing: 1, unsupported: 1 }, items: sources },
    archives: { degraded: false, total: archives.length, catalog_total: archives.length, directories: [{ capability: `d_${"1".padStart(43, "0")}`, name: "灾后重建", count: 1 }], items: archives }
  };
}

export function visualArchiverEmptyFixture() {
  const fixture = visualArchiverFixture();
  return {
    ...fixture,
    library: { available: true, display_path: "C:\\Users\\Osis\\Cloudig" },
    sources: {
      degraded: false,
      total: 0,
      stats: { bytes: 0, files: 0, bookmark_html: 0, claude_json: 0 },
      statuses: { pending: 0, complete: 0, failed: 0, missing: 0, unsupported: 0 },
      items: []
    },
    archives: { degraded: false, total: 0, catalog_total: 0, directories: [], items: [] }
  };
}

export const archiverPreload = [
  "/assets/archiver/Phoenix.svg", "/assets/archiver/Rocket.svg", "/assets/archiver/Ship.svg",
  "/assets/archiver/Cock.svg", "/assets/archiver/RockStage.svg", "/assets/archiver/Astronaut.svg",
  "/assets/archiver/Sunflower.svg", "/assets/archiver/Wave-Blue.svg", "/assets/archiver/Wave-Green.svg",
  "/assets/archiver/Village-Dusk.svg", "/assets/archiver/Village-Night.svg",
  "/assets/reader/SmallButterfly-Dawn.svg", "/assets/reader/SmallButterfly-StarNight.svg",
  ...claudeContainerPreload
];

export function mountArchiver(options) {
  const root = options.template.content.firstElementChild.cloneNode(true);
  const controller = new AbortController();
  bindOverflowText(root, controller.signal);
  root.lang = options.state.language;
  root.querySelector("[data-archiver-library-label]").textContent = options.libraryLabel ?? "Cloudig";
  let profile = "light";
  let bookmarkModel = options.model.bookmarks ?? null;
  let sourceModel = options.model.sources;
  let archiveModel = options.model.archives;
  let sourceStatus = "all";
  let sourceSort = options.state.workflowParser?.sort === "title" ? "title" : options.state.workflowParser?.sort === "time_asc" ? "captured_asc" : "captured_desc";
  let sourceSelection = new Set((sourceModel.items ?? []).filter((row) => row.selected === true).map((row) => row.capability));
  let archiveSelection = new Set((archiveModel.items ?? []).filter((row) => row.selected === true).map((row) => row.capability));
  const knownRows = { source: new Map((sourceModel.items ?? []).map(row => [row.capability, row])), archive: new Map((archiveModel.items ?? []).map(row => [row.capability, row])) };
  const selecting = { source: false, archive: false };
  const selectionEdits = { source: 0, archive: 0 };
  let inspectedSource = null;
  let inspectedArchive = null;
  const sourceDetails = new Map();
  let archiveSearch = "";
  let archiveWorkflow = normalizeArchiveWorkflow(options.state.workflowArchiver);
  let archiveSort = archiveQuerySort(archiveWorkflow.sort);
  let archiveTimeField = archiveQueryTimeField(archiveWorkflow.time_field);
  let archivePlatforms = new Set(allPlatformDefinitions.map(([id]) => id));
  const listRequests = { source: 0, archive: 0 };
  const pendingLists = {};
  let archiveScope = new Set(["all"]);
  let bookmarkExpanded = false;
  let claudeView = null;
  let jsonImportView = null;
  let claudeSource = null;
  let parseSettings = { ...(options.state.parseOrdinary ?? { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false }) };
  let parseTargetDirectory = (archiveModel.directories ?? []).find(d => `Conversations/${d.name}` === options.state.defaultOutputDirectory)?.capability ?? null;

  const bookmarkTargetPanel = root.querySelector("[data-bookmark-target-popover]");
  const bookmarkStoreSelect = root.querySelector("[data-bookmark-target-store]");
  const bookmarkParentSelect = root.querySelector("[data-bookmark-target-parent]");
  const bookmarkFolderName = root.querySelector("[data-bookmark-target-name]");
  const bookmarkPlaceFirst = root.querySelector("[data-bookmark-target-first]");

  const syncBookmarkTargetForm = () => {
    const target = bookmarkModel?.target;
    bookmarkStoreSelect.replaceChildren();
    for (const store of bookmarkModel?.stores ?? []) {
      const option = document.createElement("option");
      option.value = store.capability;
      option.textContent = store.label;
      option.selected = store.selected;
      bookmarkStoreSelect.append(option);
    }
    bookmarkParentSelect.replaceChildren();
    for (const folder of target?.folders ?? []) {
      const option = document.createElement("option");
      option.value = folder.capability;
      option.textContent = `${"　".repeat(Math.min(folder.depth, 6))}${folder.path}`;
      option.disabled = !folder.selectable;
      option.selected = folder.selected;
      bookmarkParentSelect.append(option);
    }
    bookmarkFolderName.value = target?.folder_name ?? "采云 Cloudig";
    bookmarkPlaceFirst.checked = target?.place_first !== false;
    bookmarkStoreSelect.disabled = bookmarkStoreSelect.options.length === 0;
    bookmarkParentSelect.disabled = bookmarkParentSelect.options.length === 0;
    root.querySelector("[data-bookmark-target-save]").disabled = !target;
  };

  const runBookmarkAction = async (action) => {
    if (root.dataset.bookmarkBusy === "true") return;
    root.dataset.bookmarkBusy = "true";
    render();
    try {
      const next = await action();
      if (next) bookmarkModel = next;
    } catch (error) {
      await options.onBookmarkError?.(error);
    } finally {
      delete root.dataset.bookmarkBusy;
      render();
    }
  };

  const profileHelp = root.querySelector("[data-archiver-profile-help]");
  root.querySelector("[data-archiver-bookmark-list]").addEventListener("scroll", () => { delete root.querySelector("[data-bookmark-version-help]").dataset.visible; }, { passive: true, signal: controller.signal });
  for (const button of root.querySelectorAll("[data-bookmark-profile]")) {
    button.setAttribute("aria-describedby", "archiver-profile-help");
    button.addEventListener("pointerenter", () => {
      profileHelp.dataset.profile = button.dataset.bookmarkProfile;
      showBookmarkHint(root, profileHelp, button, profileDescription(button.dataset.bookmarkProfile, root.lang));
    }, { signal: controller.signal });
    button.addEventListener("pointerleave", () => { delete profileHelp.dataset.visible; delete profileHelp.dataset.profile; }, { signal: controller.signal });
    button.addEventListener("focus", () => {
      profileHelp.dataset.profile = button.dataset.bookmarkProfile;
      showBookmarkHint(root, profileHelp, button, profileDescription(button.dataset.bookmarkProfile, root.lang));
    }, { signal: controller.signal });
    button.addEventListener("blur", () => { delete profileHelp.dataset.visible; delete profileHelp.dataset.profile; }, { signal: controller.signal });
  }

  const updateSelectionCopy = () => {
    const value = root.querySelector("[data-archive-selection]");
    value.textContent = archiveSelection.size === 0
      ? (root.lang === "en" ? "None" : "未选择")
      : (root.lang === "en" ? `Selected ${archiveSelection.size}` : `已选 ${archiveSelection.size}`);
  };

  const parseSettingsPanel = root.querySelector("[data-archiver-parse-settings-popover]");
  let settingsTarget = null;
  const setParseSettingsOpen = (open) => {
    if (!open && settingsTarget?.busy) return;
    parseSettingsPanel.hidden = !open;
    root.dataset.parseSettingsOpen = String(open);
  };
  setParseSettingsOpen(false);
  let activeFilterPopover = null;
  const closeFilterPopover = () => { activeFilterPopover?.remove(); activeFilterPopover = null; };
  const openFilterPopover = (anchor, input) => {
    closeFilterPopover();
    const popover = document.createElement("section");
    popover.className = "archiver-filter-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "false");
    const title = document.createElement("h2");
    title.textContent = input.title;
    const choices = document.createElement("div");
    choices.className = "archiver-filter-choices";
    choices.dataset.scrollRegion = "";
    let draft = input.multiple ? new Set(input.selected) : input.selected;
    const groupName = `archiver-filter-${Date.now()}`;
    for (const item of input.items) {
      const label = document.createElement("label");
      label.className = "cloudig-choice";
      const control = document.createElement("input");
      control.type = input.multiple && !(input.directoryScope && item.value === "all") ? "checkbox" : "radio";
      control.name = control.type === "radio" ? groupName : "";
      label.classList.toggle("cloudig-checkbox", control.type === "checkbox");
      control.value = item.value;
      control.checked = input.multiple ? draft.has(item.value) : draft === item.value;
      control.addEventListener("change", () => {
        if (input.multiple) {
          if (input.directoryScope) {
            draft = toggleArchiveScope(draft, item.value, control.checked);
            for (const checkbox of choices.querySelectorAll("input")) checkbox.checked = draft.has(checkbox.value);
          } else if (control.checked) draft.add(item.value); else draft.delete(item.value);
        } else input.selected = item.value;
      });
      const copy = document.createElement("span");
      copy.textContent = item.label;
      label.append(control, copy);
      choices.append(label);
    }
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = root.lang === "en" ? "Cancel" : "取消";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "cloudig-button cloudig-button-filled";
    apply.textContent = root.lang === "en" ? "Apply" : "应用";
    footer.append(cancel, apply);
    popover.append(title, choices, footer);
    root.append(popover);
    const rootRect = root.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const scopeRect = anchor.closest(".archiver-workspace")?.getBoundingClientRect() ?? rootRect;
    const minimumLeft = scopeRect.left - rootRect.left + 8;
    const maximumLeft = scopeRect.right - rootRect.left - 292;
    const left = Math.max(minimumLeft, Math.min(maximumLeft, anchorRect.left - rootRect.left));
    popover.style.left = `${left}px`;
    popover.style.top = `${anchorRect.bottom - rootRect.top + 6}px`;
    cancel.addEventListener("click", closeFilterPopover);
    apply.addEventListener("click", () => {
      const selected = input.multiple ? draft : input.selected;
      closeFilterPopover();
      input.onApply(selected);
    });
    activeFilterPopover = popover;
    choices.querySelector("input")?.focus({ preventScroll: true });
  };
  const syncParseSettings = () => {
    for (const input of parseSettingsPanel.querySelectorAll("[data-parse-setting]")) input.checked = Boolean(parseSettings[input.dataset.parseSetting]);
    const select = parseSettingsPanel.querySelector("[data-parse-target-directory]");
    const previous = select.closest(".cloudig-parse-target") ?? select.parentElement;
    const selected = archiveModel.directories?.find(d => d.capability === parseTargetDirectory);
    settingsTarget?.dispose();
    settingsTarget = mountParseTarget({ language: root.lang, mode: "settings", selectElement: select, id: "archiver-settings-directory",
      directories: archiveModel.directories ?? [], initialDirectory: selected ? `Conversations/${selected.name}` : "Conversations",
      onCreate: async name => { const fresh = await options.onCreateParseDirectory(name); archiveModel.directories = fresh; return fresh; },
      errorMessage: options.directoryCreateErrorMessage,
      onBusy: busy => { for (const button of parseSettingsPanel.querySelectorAll("footer button")) button.disabled = busy; } });
    previous.replaceWith(settingsTarget.element);
  };

  const saveParseSettings = async () => {
    if (settingsTarget?.busy) return;
    const next = {};
    for (const input of parseSettingsPanel.querySelectorAll("[data-parse-setting]")) next[input.dataset.parseSetting] = input.checked;
    const select = parseSettingsPanel.querySelector("[data-parse-target-directory]");
    const directory = select.value === "root" ? "Conversations" : `Conversations/${archiveModel.directories.find(d => d.capability === select.value).name}`;
    const stored = await options.onParseSettings?.(next, directory);
    parseSettings = { ...(stored ?? next) };
    parseTargetDirectory = select.value === "root" ? null : select.value;
    setParseSettingsOpen(false);
  };

  const sourceCallbacks = {
    onSelect(row, selected) {
      selectionEdits.source++;
      if (selected) sourceSelection.add(row.capability); else sourceSelection.delete(row.capability);
      render();
    },
    onParse: (rows) => options.onParse?.(rows, { directory: parseTargetDirectory, directoryLabel: archiveModel.directories?.find(entry => entry.capability === parseTargetDirectory)?.name, preserve_previous: parseSettings.preserve_previous }),
    onClaude: (row) => options.onClaude?.(row),
    onDismiss: (row) => options.onDismissSource?.(row),
    onInspect(row) {
      inspectedSource = row.capability;
      const json = row.kind === "claude_json" || row.filename.toLowerCase().endsWith(".json");
      const renderDetails = () => {
        const english = root.lang === "en";
        const metadata = sourceDetails.get(row.capability);
        const platform = platformLabel(row.platform, root.lang);
        const version = row.exporter_version ? bookmarkVersionLabel(platform, row.exporter_version) : (english ? "Not provided" : "未提供");
        const count = metadata?.records ?? (metadata?.failed ? (english ? "Could not read" : "未能读取") : (english ? "Counting…" : "统计中…"));
        setInfo(root.querySelector("[data-source-info]"), row.source_file ?? row.filename, [
          `${english ? "Size: " : "大小："}${formatBytes(row.bytes)} ${english ? "Captured: " : "采集时间："}${sourceCaptureLabel(row, root.lang)}`,
          json ? `${english ? "Conversations in JSON" : "JSON中的对话数"}：${count}` : `${english ? "Bookmark version" : "书签版本"}：${version}`
        ]);
      };
      renderDetails();
      if (json && options.querySourceInfo && !sourceDetails.has(row.capability)) {
        sourceDetails.set(row.capability, { pending: true });
        options.querySourceInfo(row, controller.signal).then(result => {
          sourceDetails.set(row.capability, { records: result.records });
        }).catch(() => { sourceDetails.set(row.capability, { failed: true }); }).finally(() => {
          if (!controller.signal.aborted && inspectedSource === row.capability) renderDetails();
        });
      }
    }
  };
  const archiveCallbacks = {
    onSelect(row, selected) {
      selectionEdits.archive++;
      if (selected) archiveSelection.add(row.capability); else archiveSelection.delete(row.capability);
      render();
    },
    onEdit: (row) => options.onEdit?.(row),
    onRead: (row) => options.onRead?.(row),
    onInspect(row) {
      inspectedArchive = row.capability;
      const english = root.lang === "en";
      const content = row.content_time?.range ? formatTimeRange(row.content_time.range, root.lang) : (english ? "Not set" : "未设置");
      setInfo(root.querySelector("[data-archive-info]"), row.filename, [
        `${english ? "Size: " : "大小："}${formatBytes(row.bytes)} ${english ? "Modified: " : "修改日期："}${formatMtime(row.mtime_ns)} ${english ? "Content Time: " : "内容时间："}${content}`,
        `${english ? "Parser version" : "解析器版本"}：${row.parser ?? (english ? "Not provided" : "未提供")}`
      ]);
    }
  };

  const render = () => {
    root.lang = options.state.language;
    if (profileHelp.dataset.profile) profileHelp.textContent = profileDescription(profileHelp.dataset.profile, root.lang);
    const installAll = root.querySelector("[data-bookmark-install-all]");
    installAll.textContent = `${root.lang === "en" ? "Install All" : "全装"}·${profileName(profile, root.lang)}`;
    installAll.disabled = !bookmarkModel?.target || root.dataset.bookmarkBusy === "true";
    const browserMessage = root.querySelector("[data-bookmark-browser-message]");
    browserMessage.dataset.state = bookmarkModel?.browser_state ?? "unknown";
    browserMessage.textContent = bookmarkModel?.browser_state === "loading"
      ? (root.lang === "en" ? "Reading Chrome bookmarks…" : "正在读取Chrome书签状态…")
      : bookmarkModel?.browser_state === "closed"
      ? (root.lang === "en" ? "✓ Chrome is closed — ready" : "✓ Chrome已退出，可以安装")
      : bookmarkModel?.browser_state === "open"
        ? (root.lang === "en" ? "ⓘ Exit Chrome before installing" : "ⓘ 安装前请退出Chrome")
        : (root.lang === "en" ? "ⓘ Chrome state could not be verified" : "ⓘ 无法确认Chrome状态");
    const targetPath = root.querySelector("[data-bookmark-target-path]");
    targetPath.textContent = bookmarkModel?.target?.display_path ?? (bookmarkModel?.browser_state === "loading"
      ? (root.lang === "en" ? "Reading bookmark location…" : "正在读取书签位置…")
      : (root.lang === "en" ? "No Chrome bookmark profile" : "未找到Chrome书签配置"));
    targetPath.title = targetPath.textContent;
    renderBookmarks(root, profile, bookmarkModel);
    const slogan = root.querySelector("[data-archiver-slogan]");
    const sloganLanguage = root.lang === "en" ? "English" : "Chinese";
    const sloganShade = document.documentElement.dataset.theme === "star-night" ? "Light" : "Dark";
    slogan.src = `/assets/reader/Cloudig-Slogan-${sloganLanguage}-Grey-${sloganShade}${root.lang === "en" ? ".svg" : "-1024.png"}`;
    slogan.alt = root.lang === "en" ? "From the Abyss to the Stars" : "于深渊与星河之间";
    renderSourceStatuses(root, sourceModel, sourceStatus);
    renderSourceRows(root, sourceModel, sourceSelection, sourceCallbacks);
    renderArchiveRows(root, archiveModel, archiveSelection, archiveCallbacks, archiveTimeField);
    updateStats(root, "data-source-stat", sourceModel.stats);
    const directories = Array.isArray(archiveModel.directories) ? archiveModel.directories : [];
    const active = Array.isArray(archiveModel.items) ? archiveModel.items.filter((row) => !row.archived) : [];
    const archivedRows = Array.isArray(archiveModel.items) ? archiveModel.items.filter((row) => row.archived) : [];
    updateStats(root, "data-archive-stat", archiveModel.stats ?? {
      bytes: active.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
      files: active.length,
      directories: directories.length,
      archived_bytes: archivedRows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
      archived_files: archivedRows.length
    });
    const sourceAllSelected = sourceModel.total > 0 && sourceSelection.size === sourceModel.total;
    const sourceSelectAll = root.querySelector("[data-source-select-all]");
    sourceSelectAll.textContent = sourceAllSelected ? (root.lang === "en" ? "Cancel" : "取消") : (root.lang === "en" ? "Select all" : "全选");
    sourceSelectAll.setAttribute("aria-pressed", String(sourceAllSelected));
    sourceSelectAll.disabled = selecting.source;
    const archiveAllSelected = archiveModel.total > 0 && archiveSelection.size === archiveModel.total;
    const archiveSelectAll = root.querySelector("[data-archive-select-all]");
    archiveSelectAll.textContent = archiveAllSelected ? (root.lang === "en" ? "Cancel" : "取消") : (root.lang === "en" ? "Select all" : "全选");
    archiveSelectAll.setAttribute("aria-pressed", String(archiveAllSelected));
    archiveSelectAll.disabled = selecting.archive;
    const sourceSortButton = root.querySelector("[data-source-sort]");
    sourceSortButton.title = sourceSort === "title" ? (root.lang === "en" ? "Title order" : "标题排序") : sourceSort === "captured_asc" ? (root.lang === "en" ? "Capture time ascending" : "采集时间顺序") : (root.lang === "en" ? "Capture time descending" : "采集时间倒序");
    sourceSortButton.querySelector("img").src = sourceSort === "title" ? "/assets/reader/Button-Name-Flower.svg" : sourceSort === "captured_asc" ? "/assets/reader/Button-Time-Clock.svg" : "/assets/reader/Button-Time-Tea.svg";
    const parseAll = root.querySelector("[data-archiver-parse-all]");
    parseAll.disabled = !(parseSettings.parse_unparsed && Number(sourceModel.statuses?.pending ?? 0) > 0 || parseSettings.update_outdated && Number(sourceModel.statuses?.update_action ?? 0) > 0 || parseSettings.parse_selected && sourceSelection.size > 0);
    const platformButton = root.querySelector("[data-archive-platform]");
    platformButton.textContent = archivePlatforms.size === allPlatformDefinitions.length
      ? (root.lang === "en" ? "Platform ▼" : "选择平台 ▼")
      : (root.lang === "en" ? `Platforms ${archivePlatforms.size} ▼` : `已选平台 ${archivePlatforms.size} ▼`);
    const directoryButton = root.querySelector("[data-archive-directory]");
    directoryButton.textContent = `${archiveScopeLabel(archiveScope, archiveModel.directories ?? [], root.lang)} ▼`;
    const timeFieldButton = root.querySelector("button[data-archive-time-field]");
    root.dataset.selectedArchiveTimeField = archiveTimeField;
    const selectedTimeLabel = archiveTimeFieldLabels(root.lang)[archiveTimeField];
    timeFieldButton.title = root.lang === "en" ? `Time type: ${selectedTimeLabel}` : `时间类型：${selectedTimeLabel}`;
    root.querySelector(".archiver-archive-columns > span:nth-child(3)").textContent = selectedTimeLabel;
    const archiveSortButton = root.querySelector("[data-archive-sort]");
    archiveSortButton.title = archiveSort === "content_desc"
      ? (root.lang === "en" ? `${selectedTimeLabel}, reverse chronological` : `${selectedTimeLabel}，时间倒序`)
      : archiveSort === "content_asc"
        ? (root.lang === "en" ? `${selectedTimeLabel}, chronological` : `${selectedTimeLabel}，时间顺序`)
        : (root.lang === "en" ? "Title order" : "标题排序");
    archiveSortButton.querySelector("img").src = archiveSort === "content_desc"
      ? "/assets/reader/Button-Time-Tea.svg"
      : archiveSort === "content_asc"
        ? "/assets/reader/Button-Time-Clock.svg"
        : "/assets/reader/Button-Name-Flower.svg";
    const profileIndicator = root.querySelector("[data-bookmark-profile-indicator]");
    profileIndicator.textContent = profile === "light" ? (root.lang === "en" ? "L" : "轻") : profile === "full" ? (root.lang === "en" ? "F" : "全") : (root.lang === "en" ? "T" : "树");
    profileIndicator.title = profileName(profile, root.lang);
    const archiveAction = root.querySelector('[data-archive-action="archive"], [data-archive-action="restore"], [data-archive-action="archive-choice"]');
    if (archiveAction) {
      const selectedRows = [...archiveSelection].map(cap => knownRows.archive.get(cap)).filter(Boolean);
      const hasArchived = selectedRows.some(row => row.archived), hasActive = selectedRows.some(row => !row.archived);
      const archivedOnly = hasArchived && !hasActive || !selectedRows.length && archiveScope.size === 1 && archiveScope.has("archived");
      archiveAction.dataset.archiveAction = hasArchived && hasActive ? "archive-choice" : archivedOnly ? "restore" : "archive";
      archiveAction.textContent = hasArchived && hasActive ? (root.lang === "en" ? "Archive / Restore" : "归档 / 恢复") : archivedOnly ? (root.lang === "en" ? "Restore" : "恢复") : (root.lang === "en" ? "Archive" : "归档");
      const move = root.querySelector('[data-archive-action="move"]');
      move.disabled = selectedRows.length > 0 && !hasActive;
      move.title = hasArchived ? (root.lang === "en" ? "Move selected unarchived conversations; restore archived ones first" : "移动选中的未归档对话；已归档对话须先恢复") : (root.lang === "en" ? "Move to directory" : "移动目录");
    }
    root.dataset.bookmarkExpanded = String(bookmarkExpanded);
    const bookmarkExpand = root.querySelector("[data-archiver-bookmark-expand]");
    bookmarkExpand.setAttribute("aria-expanded", String(bookmarkExpanded));
    bookmarkExpand.setAttribute("aria-label", bookmarkExpanded ? (root.lang === "en" ? "Collapse bookmark rail" : "收起书签栏") : (root.lang === "en" ? "Expand bookmark rail" : "展开书签栏"));
    // A list refresh must not replace the open settings draft or its in-flight creator.
    if (!bookmarkTargetPanel.hidden) syncBookmarkTargetForm();
    updateSelectionCopy();
  };

  const setWorkflowHighlight = (key, active) => {
    if (!key) return;
    for (const target of root.querySelectorAll("[data-highlight-target]")) {
      if (target.dataset.highlightTarget !== key) continue;
      if (active) target.dataset.highlight = "true";
      else delete target.dataset.highlight;
    }
  };
  root.addEventListener("pointerover", (event) => {
    const source = event.target.closest("[data-highlight-source]");
    if (source) setWorkflowHighlight(source.dataset.highlightSource, true);
  }, { signal: controller.signal });
  root.addEventListener("pointerout", (event) => {
    const source = event.target.closest("[data-highlight-source]");
    if (source && !source.contains(event.relatedTarget)) setWorkflowHighlight(source.dataset.highlightSource, false);
  }, { signal: controller.signal });
  root.addEventListener("focusin", (event) => {
    const source = event.target.closest("[data-highlight-source]");
    if (source) setWorkflowHighlight(source.dataset.highlightSource, true);
  }, { signal: controller.signal });
  root.addEventListener("focusout", (event) => {
    const source = event.target.closest("[data-highlight-source]");
    if (source && !source.contains(event.relatedTarget)) setWorkflowHighlight(source.dataset.highlightSource, false);
  }, { signal: controller.signal });

  const querySourcePage = (offset, snapshot) => options.querySources(snapshot ? { offset, limit: 200, snapshot } : {
    offset, limit: 200, sort: sourceSort, ...(sourceStatus === "all" ? {} : { statuses: [sourceStatus] })
  });
  const queryArchivePage = (offset, snapshot) => options.queryArchives(snapshot ? { offset, limit: 200, snapshot } : {
    offset, limit: 200, search: archiveSearch,
    ...(archivePlatforms.size === allPlatformDefinitions.length ? {} : { platforms: [...archivePlatforms] }),
    sort: archiveSort, time_field: archiveTimeField, ...archiveScopeQuery(archiveScope)
  });
  const collectRows = async (kind, model, ordinal) => {
    const values = new Map(model.items.map(row => [row.capability, row]));
    let offset = model.items.length;
    while (offset < model.total) {
      const page = await (kind === "source" ? querySourcePage : queryArchivePage)(offset, model.snapshot);
      if (controller.signal.aborted || ordinal !== listRequests[kind]) return null;
      if (!page.items?.length) throw new Error(root.lang === "en" ? "The list changed. Refresh and select again." : "列表已变化，请刷新后重新选择。");
      for (const row of page.items) values.set(row.capability, row);
      offset += page.items.length;
    }
    return values;
  };
  const selectAll = async kind => {
    if (selecting[kind]) return;
    const model = kind === "source" ? sourceModel : archiveModel;
    const selected = kind === "source" ? sourceSelection : archiveSelection;
    const ordinal = listRequests[kind], edit = ++selectionEdits[kind];
    if (selected.size > 0 && selected.size === model.total) { selected.clear(); render(); return; }
    selecting[kind] = true; render();
    try {
      const values = await collectRows(kind, model, ordinal);
      if (!values || controller.signal.aborted || ordinal !== listRequests[kind] || edit !== selectionEdits[kind]) return;
      knownRows[kind] = values;
      if (kind === "source") sourceSelection = new Set(values.keys()); else archiveSelection = new Set(values.keys());
    } finally { selecting[kind] = false; if (!controller.signal.aborted) render(); }
  };
  const loadList = async (kind, append, query) => {
    if (append && pendingLists[kind]) return pendingLists[kind];
    const previous = kind === "source" ? sourceModel : archiveModel;
    if (append && previous.items.length >= previous.total) return;
    const ordinal = append ? listRequests[kind] : ++listRequests[kind];
    const operation = query(append ? previous.items.length : 0, append ? previous.snapshot : undefined);
    pendingLists[kind] = operation;
    try {
      const result = await operation;
      if (controller.signal.aborted || ordinal !== listRequests[kind]) return;
      const model = append ? { ...result, offset: 0, items: [...previous.items, ...result.items] } : result;
      const selected = kind === "source" ? sourceSelection : archiveSelection;
      let known = append ? new Map(knownRows[kind]) : new Map();
      for (const row of model.items) known.set(row.capability, row);
      if (!append && [...selected].some(cap => !known.has(cap))) {
        known = await collectRows(kind, model, ordinal);
        if (!known) return;
      }
      if (controller.signal.aborted || ordinal !== listRequests[kind]) return;
      knownRows[kind] = known;
      if (kind === "source") {
        sourceModel = model;
        sourceSelection = new Set([...sourceSelection].filter(capability => known.has(capability)));
      } else {
        archiveModel = model;
        archiveSelection = new Set([...archiveSelection].filter(capability => known.has(capability)));
        const knownDirectories = new Set((model.directories ?? []).map(row => row.capability));
        archiveScope = new Set([...archiveScope].filter(value => value === "all" || value === "archived" || knownDirectories.has(value)));
      }
      render();
      const inspected = kind === "source" ? inspectedSource : inspectedArchive;
      const current = model.items.find(row => row.capability === inspected);
      if (current) (kind === "source" ? sourceCallbacks : archiveCallbacks).onInspect(current);
      else {
        if (kind === "source") inspectedSource = null; else inspectedArchive = null;
        const hint = root.lang === "en" ? "Select or point to a file for details" : kind === "source" ? "选择或指向来源文件查看信息" : "选择或指向档案查看信息";
        setInfo(root.querySelector(kind === "source" ? "[data-source-info]" : "[data-archive-info]"), hint, []);
      }
    } finally { if (pendingLists[kind] === operation) delete pendingLists[kind]; }
  };
  const refreshSources = (append = false) => loadList("source", append === true, querySourcePage);
  const refreshArchives = (append = false) => loadList("archive", append === true, queryArchivePage);
  for (const [selector, refresh] of [["[data-source-list]", refreshSources], ["[data-archive-list]", refreshArchives]]) {
    const list = root.querySelector(selector);
    list.addEventListener("scroll", () => {
      if (list.scrollHeight - list.scrollTop - list.clientHeight < 200) refresh(true).catch(options.onError ?? (() => undefined));
    }, { passive: true, signal: controller.signal });
  }

  const applyArchiveWorkflow = async (next) => {
    const previous = { workflow: archiveWorkflow, sort: archiveSort, timeField: archiveTimeField };
    archiveSort = next.sort ?? archiveSort;
    archiveTimeField = next.timeField ?? archiveTimeField;
    archiveWorkflow = {
      sort: archivePreferenceSort(archiveSort),
      time_field: archivePreferenceTimeField(archiveTimeField)
    };
    archiveSelection.clear();
    render();
    try {
      const stored = await options.onArchiveWorkflow?.(archiveWorkflow);
      if (stored) {
        archiveWorkflow = normalizeArchiveWorkflow(stored);
        archiveSort = archiveQuerySort(archiveWorkflow.sort);
        archiveTimeField = archiveQueryTimeField(archiveWorkflow.time_field);
      }
      await refreshArchives();
    } catch {
      archiveWorkflow = previous.workflow;
      archiveSort = previous.sort;
      archiveTimeField = previous.timeField;
      render();
    }
  };

  function setWorkflowOpen(open) {
    root.querySelector("[data-archiver-workflow]").hidden = !open;
    root.dataset.workflowOpen = String(open);
  }

  root.addEventListener("click", (event) => {
    const profileButton = event.target.closest("[data-bookmark-profile]");
    if (profileButton) {
      profile = profileButton.dataset.bookmarkProfile;
      for (const button of root.querySelectorAll("[data-bookmark-profile]")) button.setAttribute("aria-pressed", String(button === profileButton));
      profileHelp.textContent = profileDescription(profile, root.lang);
      root.querySelector("[data-bookmark-install-all]").textContent = `${root.lang === "en" ? "Install All" : "全装"}·${profileName(profile, root.lang)}`;
      bookmarkTargetPanel.hidden = true;
      runBookmarkAction(() => options.queryBookmarks?.(profile)).catch(() => undefined);
      return;
    }
    if (event.target.closest("[data-bookmark-install-all]")) {
      runBookmarkAction(() => options.onBookmarkInstall?.(profile, platformDefinitions.map(([platform]) => platform))).catch(() => undefined);
      return;
    }
    const bookmarkOperation = event.target.closest("[data-bookmark-operation]");
    if (bookmarkOperation) {
      const platform = bookmarkOperation.dataset.bookmarkPlatform;
      runBookmarkAction(() => bookmarkOperation.dataset.bookmarkOperation === "remove"
        ? options.onBookmarkRemove?.(profile, [platform])
        : options.onBookmarkInstall?.(profile, [platform])).catch(() => undefined);
      return;
    }
    const bookmarkCopy = event.target.closest("[data-bookmark-copy]");
    if (bookmarkCopy) {
      runBookmarkAction(async () => { await options.onBookmarkCopy?.(profile, bookmarkCopy.dataset.bookmarkCopy); return bookmarkModel; }).catch(() => undefined);
      return;
    }
    if (event.target.closest("[data-bookmark-target-settings]")) {
      syncBookmarkTargetForm();
      bookmarkTargetPanel.hidden = false;
      bookmarkStoreSelect.focus();
      return;
    }
    if (event.target.closest("[data-bookmark-target-close], [data-bookmark-target-cancel]")) {
      bookmarkTargetPanel.hidden = true;
      root.querySelector("[data-bookmark-target-settings]")?.focus();
      return;
    }
    if (event.target.closest("[data-bookmark-target-save]")) {
      const targetDraft = {
        store: bookmarkStoreSelect.value,
        parent: bookmarkParentSelect.value,
        folder_name: bookmarkFolderName.value,
        place_first: bookmarkPlaceFirst.checked
      };
      runBookmarkAction(async () => {
        const next = await options.onBookmarkTargetSave?.(profile, targetDraft);
        bookmarkTargetPanel.hidden = true;
        return next;
      }).catch(() => undefined);
      return;
    }
    const shellAction = event.target.closest("[data-archiver-shell-action]");
    if (shellAction) {
      if (["import-html", "import-claude", "open-inbox", "open-conversations"].includes(shellAction.dataset.archiverShellAction)) setWorkflowOpen(false);
      options.onShellAction?.(shellAction.dataset.archiverShellAction);
      return;
    }
    if (event.target.closest("[data-archiver-parse-settings]")) {
      if (settingsTarget?.busy) return;
      syncParseSettings();
      setParseSettingsOpen(true);
      parseSettingsPanel.querySelector("[data-parse-target-directory]")?.focus();
      return;
    }
    const platformFilter = event.target.closest("[data-archive-platform]");
    if (platformFilter) {
      openFilterPopover(platformFilter, {
        title: root.lang === "en" ? "Platform Filter" : "平台筛选",
        multiple: true,
        selected: archivePlatforms,
        items: allPlatformDefinitions.map(([value]) => ({ value, label: platformLabel(value, root.lang) })),
        onApply(selected) { archivePlatforms = new Set(selected); archiveSelection.clear(); refreshArchives().catch(() => undefined); }
      });
      return;
    }
    const directoryFilter = event.target.closest("[data-archive-directory]");
    if (directoryFilter) {
      openFilterPopover(directoryFilter, {
        title: root.lang === "en" ? "Directory and Archive State" : "目录与归档状态",
        multiple: true,
        directoryScope: true,
        selected: archiveScope,
        items: [
          { value: "all", label: root.lang === "en" ? "All active directories" : "全部现有目录" },
          ...(archiveModel.directories ?? []).map((entry) => ({ value: entry.capability, label: `${entry.name} (${entry.count ?? 0})` })),
          { value: "archived", label: root.lang === "en" ? "Archived conversations" : "归档区" }
        ],
        onApply(value) {
          archiveScope = value;
          archiveSelection.clear();
          refreshArchives().catch(() => undefined);
        }
      });
      return;
    }
    const timeFieldFilter = event.target.closest("button[data-archive-time-field]");
    if (timeFieldFilter) {
      const labels = archiveTimeFieldLabels(root.lang);
      openFilterPopover(timeFieldFilter, {
        title: root.lang === "en" ? "Time Field" : "时间类型",
        multiple: false,
        selected: archiveTimeField,
        items: Object.entries(labels).map(([value, label]) => ({ value, label })),
        onApply(value) { applyArchiveWorkflow({ timeField: value }).catch(() => undefined); }
      });
      return;
    }
    if (event.target.closest("[data-parse-settings-cancel]")) {
      setParseSettingsOpen(false);
      return;
    }
    if (event.target.closest("[data-parse-settings-save]")) {
      saveParseSettings().catch(() => undefined);
      return;
    }
    const status = event.target.closest("[data-source-status]");
    if (status) { sourceStatus = status.dataset.sourceStatus; sourceSelection.clear(); refreshSources().catch(() => undefined); return; }
    if (event.target.closest("[data-source-select-all]")) {
      selectAll("source").catch(options.onError ?? (() => undefined));
      return;
    }
    if (event.target.closest("[data-archive-select-all]")) {
      selectAll("archive").catch(options.onError ?? (() => undefined));
      return;
    }
    if (event.target.closest("[data-source-sort]")) {
      sourceSort = sourceSort === "captured_desc" ? "captured_asc" : sourceSort === "captured_asc" ? "title" : "captured_desc";
      Promise.resolve(options.onParserWorkflow?.({ sort: sourceSort === "title" ? "title" : sourceSort === "captured_asc" ? "time_asc" : "time_desc" })).catch(options.onError ?? (() => undefined));
      sourceSelection.clear();
      refreshSources().catch(() => undefined);
      return;
    }
    if (event.target.closest("[data-source-refresh]")) { Promise.all([refreshSources(), refreshArchives()]).catch(options.onError ?? (() => undefined)); return; }
    if (event.target.closest("[data-archiver-parse-all]")) {
      setWorkflowOpen(false);
      const selected = [...sourceSelection].map(cap => knownRows.source.get(cap)).filter(Boolean);
      options.onParse?.(selected.filter(ordinarySource), { one_click: true, directory: parseTargetDirectory, directoryLabel: archiveModel.directories?.find(entry => entry.capability === parseTargetDirectory)?.name, preserve_previous: parseSettings.preserve_previous });
      return;
    }
    if (event.target.closest("[data-archive-refresh]")) { Promise.all([refreshSources(), refreshArchives()]).catch(options.onError ?? (() => undefined)); return; }
    if (event.target.closest("[data-archive-filter]")) {
      archiveScope = archiveScope.size === 1 && archiveScope.has("archived") ? new Set(["all"]) : new Set(["archived"]);
      archiveSelection.clear();
      refreshArchives().catch(() => undefined);
      return;
    }
    if (event.target.closest("[data-archive-sort]")) {
      const sort = archiveSort === "content_desc" ? "content_asc" : archiveSort === "content_asc" ? "title" : "content_desc";
      applyArchiveWorkflow({ sort }).catch(() => undefined);
      return;
    }
    if (event.target.closest("[data-archiver-bookmark-expand]")) {
      bookmarkExpanded = !bookmarkExpanded;
      render();
      if (bookmarkExpanded) root.querySelector("[data-archiver-workflow-open]")?.focus();
      return;
    }
    if (event.target.closest("[data-archiver-workflow-open]")) { setWorkflowOpen(true); return; }
    if (event.target.closest("[data-archiver-workflow-close]")) { setWorkflowOpen(false); return; }
    const highlight = event.target.closest("[data-highlight-source]");
    if (highlight) {
      const key = highlight.dataset.highlightSource;
      setWorkflowHighlight(key, true);
      setTimeout(() => setWorkflowHighlight(key, false), 1500);
      return;
    }
    if (event.target.closest("[data-archive-directory-new]")) { options.onDirectoryNew?.(); return; }
    if (event.target.closest("[data-archive-directory-manage]")) { options.onDirectoryManage?.(archiveModel.directories ?? []); return; }
    const action = event.target.closest("[data-archive-action]");
    if (action) {
      const rows = [...archiveSelection].map(cap => knownRows.archive.get(cap)).filter(Boolean);
      if (action.dataset.archiveAction === "move") { options.onArchiveAction?.("move", rows.filter(row => !row.archived), archiveModel.directories ?? []); return; }
      if (action.dataset.archiveAction === "archive-choice") {
        openFilterPopover(action, {
          title: root.lang === "en" ? "Archive or restore selected files" : "归档或恢复选中文件", multiple: false, selected: "archive",
          items: [
            { value: "archive", label: root.lang === "en" ? `Archive ${rows.filter(row => !row.archived).length} active files` : `归档 ${rows.filter(row => !row.archived).length} 个未归档文件` },
            { value: "restore", label: root.lang === "en" ? `Restore ${rows.filter(row => row.archived).length} archived files` : `恢复 ${rows.filter(row => row.archived).length} 个已归档文件` }
          ],
          onApply(value) { options.onArchiveAction?.(value, rows.filter(row => Boolean(row.archived) === (value === "restore")), archiveModel.directories ?? []); }
        });
        return;
      }
      options.onArchiveAction?.(action.dataset.archiveAction, rows, archiveModel.directories ?? []);
    }
  }, { signal: controller.signal });
  root.addEventListener("pointerdown", (event) => {
    if (activeFilterPopover && !event.target.closest(".archiver-filter-popover") && !event.target.closest("button[data-archive-platform], button[data-archive-directory], button[data-archive-time-field]")) closeFilterPopover();
    if (!parseSettingsPanel.hidden && !event.target.closest("[data-archiver-parse-settings-popover]") && !event.target.closest("[data-archiver-parse-settings]")) setParseSettingsOpen(false);
    if (!bookmarkExpanded || event.target.closest(".archiver-bookmark-rail")) return;
    bookmarkExpanded = false;
    render();
  }, { signal: controller.signal });
  bookmarkStoreSelect.addEventListener("change", () => {
    const selectedStore = bookmarkStoreSelect.value;
    runBookmarkAction(() => options.queryBookmarkTarget?.(profile, selectedStore)).catch(() => undefined);
  }, { signal: controller.signal });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeFilterPopover) {
      closeFilterPopover();
      return;
    }
    if (event.key === "Escape" && !parseSettingsPanel.hidden) {
      setParseSettingsOpen(false);
      root.querySelector("[data-archiver-parse-settings]")?.focus();
      return;
    }
    if (event.key === "Escape" && !bookmarkTargetPanel.hidden) {
      bookmarkTargetPanel.hidden = true;
      root.querySelector("[data-bookmark-target-settings]")?.focus();
      return;
    }
    if (!bookmarkExpanded) return;
    if (event.key === "Escape") {
      bookmarkExpanded = false;
      render();
      root.querySelector("[data-archiver-bookmark-expand]")?.focus();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...root.querySelectorAll(".archiver-bookmark-rail button:not(:disabled), .archiver-bookmark-rail [tabindex]:not([tabindex='-1'])")].filter((node) => node.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, { signal: controller.signal });
  bindSearchEntry({ input: root.querySelector("[data-archive-search]"), clear: root.querySelector("[data-archive-search-clear]"), language: () => root.lang, signal: controller.signal,
    onTitle(value) { archiveSearch = value; archiveSelection.clear(); refreshArchives().catch(options.onError ?? (() => undefined)); },
    onContent(value) { options.onContentSearch?.({ query: value, selection: [...archiveScope], directories: archiveModel.directories ?? [], platforms: allPlatformDefinitions.map(([value, name]) => ({ value, label: localizePlatformLabel(value, name, root.lang) })), selectedPlatforms: [...archivePlatforms] }); }
  });
  root.querySelector("[data-progress-cancel]").addEventListener("click", () => options.onCancelParse?.(), { signal: controller.signal });

  bindArchiverLayout(root, controller.signal);

  const empty = (sourceModel.total ?? 0) === 0 && (archiveModel.catalog_total ?? archiveModel.total ?? 0) === 0;
  setWorkflowOpen(empty);
  render();
  if (!empty) {
    const sourceInspection = sourceModel.items?.find((row) => row.status === "complete") ?? sourceModel.items?.[0];
    const archiveInspection = archiveModel.items?.at(-1) ?? archiveModel.items?.[0];
    if (sourceInspection) sourceCallbacks.onInspect(sourceInspection);
    if (archiveInspection) archiveCallbacks.onInspect(archiveInspection);
  }
  return {
    element: root,
    setProgress(event, filenames = []) {
      const region = root.querySelector("[data-archiver-progress]");
      updateOperationProgress(region, event, filenames);
    },
    clearProgress() { root.querySelector("[data-archiver-progress]").hidden = true; },
    openJsonImport(previewPlatform) {
      jsonImportView?.cleanup(); claudeView?.cleanup(); claudeView = null;
      root.querySelector('[data-archiver-claude-view]').hidden = true;
      setWorkflowOpen(false);
      jsonImportView = mountPlatformJsonIndex({ root, state: options.state,
        onImport: platform => options.onJsonImport?.(platform),
        onClose: () => { jsonImportView?.cleanup(); jsonImportView = null; } });
      if (previewPlatform) jsonImportView.preview(previewPlatform);
    },
    openClaude(index, sourceRow) {
      jsonImportView?.cleanup(); jsonImportView = null;
      claudeView?.cleanup();
      claudeSource = sourceRow;
      root.dataset.archiverMode = "claude";
      const host = root.querySelector("[data-archiver-claude-view]");
      host.hidden = false;
      claudeView = mountClaudeContainer({
        root,
        index,
        presentation: platformJsonDefinitions.find(item => item.id === (index.platform ?? sourceRow?.platform)),
        state: options.state,
        directories: archiveModel.directories ?? [],
        query: options.queryClaude,
        extract: options.onClaudeExtract,
        cancel: options.onCancelParse,
        rebuild: () => options.onClaudeRebuild?.(claudeSource),
        savePreferences: options.onClaudePreferences,
        createDirectory: options.onCreateParseDirectory,
        directoryCreateErrorMessage: options.directoryCreateErrorMessage,
        returnToArchiver: () => {
          claudeView?.cleanup();
          claudeView = null;
          claudeSource = null;
          host.hidden = true;
          delete root.dataset.archiverMode;
          options.onClaudeReturn?.();
        },
        onError: options.onClaudeError
      });
    },
    replaceClaudeIndex(index) { return claudeView?.replaceIndex(index); },
    claudeContainer() { return claudeView?.container(); },
    setClaudeProgress(event, rows) { claudeView?.setProgress(event, rows); },
    clearClaudeProgress() { claudeView?.clearProgress(); },
    refreshClaude() { return claudeView?.refresh(); },
    replaceBookmarks(bookmarks) { bookmarkModel = bookmarks; render(); },
    setLibraryLabel(value) { root.querySelector("[data-archiver-library-label]").textContent = value || "Cloudig"; },
    refreshDirectories: refreshArchives,
    async refreshAll() { await Promise.all([refreshSources(), refreshArchives(), options.queryBookmarks?.(profile).then((value) => { bookmarkModel = value; render(); })]); },
    updateState(nextState) {
      options.state = nextState;
      root.lang = nextState.language;
      parseSettings = { ...(nextState.parseOrdinary ?? parseSettings) };
      sourceSort = nextState.workflowParser?.sort === "title" ? "title" : nextState.workflowParser?.sort === "time_asc" ? "captured_asc" : "captured_desc";
      parseTargetDirectory = (archiveModel.directories ?? []).find(d => `Conversations/${d.name}` === nextState.defaultOutputDirectory)?.capability ?? null;
      archiveWorkflow = normalizeArchiveWorkflow(nextState.workflowArchiver ?? archiveWorkflow);
      archiveSort = archiveQuerySort(archiveWorkflow.sort);
      archiveTimeField = archiveQueryTimeField(archiveWorkflow.time_field);
      claudeView?.updateState(nextState);
      jsonImportView?.updateState(nextState);
      render();
    },
    cleanup() { settingsTarget?.dispose(); jsonImportView?.cleanup(); claudeView?.cleanup(); closeFilterPopover(); controller.abort(); }
  };
}
