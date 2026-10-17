import { terranLabel, terranShortcutNames } from "/shared/time/preset-labels.js";
import { bindRecordTextInput, refreshRecordTextInputs } from "/shared/record-text-input.js";
import { formatTimeEndpoint as formatEndpoint, formatTimeRange as formatRange, timeInputError } from "/shared/time/endpoint-editor.js";
import { mountTerranPointFields } from "/shared/time/terran-point-fields.js";
import { createTimeNodePager } from "/shared/time/paged-nodes.js";
import { mountParserHistory } from "/shared/parser-history.js";
import { archiveInstantLabel } from "../../archive-workflow.js";

export async function commitCurrentConversationInfo(request, archive, payload) {
  const current = await request("reader.archive.info.query", { archive });
  if (current.revision.conversation !== payload.expected_conversation || current.revision.mark !== payload.expected_mark) {
    const error = new Error("Conversation changed while its editor was open"); error.code = "CLOUDIG_ARCHIVE_INFO_CONFLICT"; throw error;
  }
  // Only these two originals matter; unrelated preferences/Time writes do not.
  return request("reader.archive.info.commit", { archive, ...payload });
}

const platformDefinitions = Object.freeze({
  chatgpt: ["ChatGPT", "/assets/platforms/platform-chatgpt.svg"],
  claude: ["Claude", "/assets/platforms/platform-claude.svg"],
  gemini: ["Gemini", "/assets/platforms/platform-gemini.svg"],
  grok: ["Grok", "/assets/platforms/platform-grok.svg"],
  deepseek: ["DeepSeek", "/assets/platforms/platform-deepseek.svg"],
  doubao: ["豆包", "/assets/platforms/platform-doubao.png"],
  qwen: ["Qwen", "/assets/platforms/platform-qwen.svg"],
  chatglm: ["ChatGLM", "/assets/platforms/platform-chatglm.svg"],
  yuanbao: ["元宝", "/assets/platforms/platform-yuanbao.svg"],
  zai: ["Z.ai", "/assets/platforms/platform-zai.svg"],
  kimi: ["Kimi", "/assets/platforms/platform-kimi.svg"],
  mistral: ["Mistral", "/assets/platforms/platform-mistral.svg"],
  cline: ["Cline", "/assets/platforms/platform-cline.svg"],
  sillytavern: ["SillyTavern", "/assets/platforms/platform-sillytavern.svg"],
  "kimi-code": ["Kimi Code", "/assets/platforms/platform-kimi-code.svg"],
  "claude-code": ["Claude Code", "/assets/platforms/platform-claude-code.svg"],
  codex: ["Codex", "/assets/platforms/platform-codex.svg"]
});

const copy = Object.freeze({
  "zh-CN": {
    titleLabel: "会话名称", addModelLabel: "添加模型", editedAt: "最后编辑时间", firstParsed: "首次解析时间",
    messageTime: "会话消息时间", sourceFile: "原文件", capturedAt: "原文件采集时间", jsonFile: "当前JSON文件",
    details: "解析详情", nameRuleTitle: "文件名与标题相互独立", nameRule: "修改会话名称不会修改JSON文件名；修改JSON文件名也不会修改会话名称。",
    contentTime: "内容时间", clear: "清空", editTimeline: "编辑时间轴", presets: "预设时间",
    terran: "此地时间：以现实地球时间为主轴", sovereign: "独立时间：自定义时间与意义", sameStart: "同起点",
    exactCalendar: "精确公历时间", fuzzyCalendar: "模糊公历时间", relative: "单位年前/后", special: "特殊时间",
    sovereignSearch: "搜索自定义时间名称", sovereignEmpty: "暂无可选自定义时间。可先进入内容时间轴创建。", addCustomTime: "添加自定义时间", editedDesc: "修改时间倒序", editedAsc: "修改时间顺序", titleSort: "标题排序", select: "选择", first: "首序", step: "间隔", last: "尾序",
    confirmTime: "确认时间", save: "保存", cancel: "取消", start: "起点", end: "终点", editStart: "编辑起点", editEnd: "编辑终点",
    emptySummary: "内容覆盖的时间\n编辑后点击确认时间保存", clearedSummary: "内容时间已明确清空", unavailableSummary: "没有可用的解析内容时间",
    parserDefault: "解析所得内容时间", userSet: "用户设定内容时间", removeModel: "删除模型", duplicateModel: "模型标签已经存在。",
    invalidTime: "时间尚未通过校验。", confirmPending: "内容时间尚未确认。请先点击“确认时间”，检查后再保存会话。", reversedTime: "起点晚于终点；采云保留这一反向时间。", noChangeTitle: "内容未被更改",
    noChangeMessage: "是否更新最后编辑时间戳？这将改变“现今”“单位年前/后”的时间锚点。", update: "更新", noWrite: "否，零写返回",
    discardTitle: "放弃尚未保存的修改？", discardMessage: "当前页面草稿尚未写入资料库。", discard: "放弃修改", stay: "继续编辑",
    saving: "正在保存…", saveConflict: "会话信息已在别处改变，请关闭后重新打开。", add: "添加", calendar: "公历", fuzzy: "模糊",
    era: "纪元", year: "年", month: "月", day: "日", hour: "时", minute: "分", offset: "时区", direction: "方向", before: "前", after: "后",
    unit: "单位", value: "数值", fuzzyKind: "精度", decade: "年代", century: "世纪", whenever: "无论何时", unknown: "不知何时",
    infinitePast: "无限久前", infiniteFuture: "无限久后", now: "现今", parserBasis: "Parser 首次创建", unavailable: "不可得"
  },
  en: {
    titleLabel: "Conversation Name", addModelLabel: "Add model", editedAt: "Last Cloudig edit", firstParsed: "First parsed",
    messageTime: "Message range", sourceFile: "Source file", capturedAt: "Source captured", jsonFile: "Current JSON file",
    details: "Parser details", nameRuleTitle: "Filename and title are independent", nameRule: "Changing the conversation name does not rename the JSON file, and renaming the JSON file does not change the conversation name.",
    contentTime: "Content Time", clear: "Clear", editTimeline: "Edit timeline", presets: "Presets",
    terran: "Terran Time: the real Earth timeline", sovereign: "Sovereign Time: custom time and meaning", sameStart: "Same as start",
    exactCalendar: "Exact calendar", fuzzyCalendar: "Fuzzy calendar", relative: "Years before / after", special: "Special time",
    sovereignSearch: "Search custom time", sovereignEmpty: "No custom time is available yet. Create one in Content Time first.", addCustomTime: "Add custom time", editedDesc: "Edited newest", editedAsc: "Edited oldest", titleSort: "Title", select: "Select", first: "First", step: "Step", last: "Last",
    confirmTime: "Confirm Time", save: "Save", cancel: "Cancel", start: "Start", end: "End", editStart: "Edit start", editEnd: "Edit end",
    emptySummary: "Time covered by the content\nEdit, then Confirm Time to save", clearedSummary: "Content time is explicitly cleared", unavailableSummary: "No parser content time is available",
    parserDefault: "Parser-derived content time", userSet: "User-set content time", removeModel: "Remove model", duplicateModel: "That model tag already exists.",
    invalidTime: "The time has not passed validation.", confirmPending: "Content Time is not confirmed yet. Click Confirm Time, check it, then save the conversation.", reversedTime: "Start is later than end. Cloudig will preserve this reversed range.", noChangeTitle: "Nothing changed",
    noChangeMessage: "Update the last-edited timestamp? This also refreshes the anchor used by Now and relative time.", update: "Update", noWrite: "No, return without writing",
    discardTitle: "Discard unsaved changes?", discardMessage: "The current draft has not been written to the Library.", discard: "Discard", stay: "Keep editing",
    saving: "Saving…", saveConflict: "Conversation information changed elsewhere. Close and reopen the editor.", add: "Add", calendar: "Calendar", fuzzy: "Fuzzy",
    era: "Era", year: "Year", month: "Month", day: "Day", hour: "Hour", minute: "Minute", offset: "Zone", direction: "Direction", before: "Before", after: "After",
    unit: "Unit", value: "Value", fuzzyKind: "Precision", decade: "Decade", century: "Century", whenever: "Whenever", unknown: "Unknown",
    infinitePast: "Infinite past", infiniteFuture: "Infinite future", now: "Now", parserBasis: "Created by Parser", unavailable: "Unavailable"
  }
});

export const conversationInfoPreload = Object.freeze([
  "/assets/editor/EditorBack-Tao.svg",
  "/assets/editor/EditorBack-Drawer.svg"
]);

function clone(value) { return structuredClone(value); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function iso(value) { return archiveInstantLabel(value); }
function anchorEndpoint(endpoint, anchor) {
  const value = clone(endpoint);
  if (value?.kind === "relative" || value?.kind === "now") value.anchor = clone(anchor);
  return value;
}
function defaultEndpoint() { return { kind: "calendar", era: "AD" }; }

function platformNode(platform) {
  const [label, source] = platformDefinitions[platform] ?? [platform || "AI", "/assets/welcome/OsisLogo-Simple.svg"];
  const image = document.createElement("img");
  image.src = source;
  image.alt = label;
  return image;
}

function setCopies(root, language) {
  const values = copy[language] ?? copy["zh-CN"];
  for (const node of root.querySelectorAll("[data-conversation-copy]")) node.textContent = values[node.dataset.conversationCopy] ?? node.textContent;
  for (const node of root.querySelectorAll("[data-conversation-copy-placeholder]")) node.placeholder = values[node.dataset.conversationCopyPlaceholder] ?? node.placeholder;
  return values;
}

function focusable(root) {
  return [...root.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), details > summary, [tabindex]:not([tabindex='-1'])")].filter((node) => node.offsetParent !== null);
}

function showChoice(layer, values, title, message, primary, secondary) {
  const dialog = layer.querySelector("[data-conversation-info-confirm]");
  const editor = layer.querySelector("[data-conversation-info-dialog]");
  const wasInert = editor.inert;
  editor.inert = true;
  dialog.hidden = false;
  dialog.querySelector("[data-conversation-confirm-title]").textContent = title;
  dialog.querySelector("[data-conversation-confirm-message]").textContent = message;
  const primaryButton = dialog.querySelector("[data-conversation-confirm-primary]");
  const secondaryButton = dialog.querySelector("[data-conversation-confirm-secondary]");
  primaryButton.textContent = primary;
  secondaryButton.textContent = secondary;
  // Save locks the editor underneath; the no-change decision remains the
  // only actionable surface and must not inherit that disabled state.
  primaryButton.disabled = false;
  secondaryButton.disabled = false;
  return new Promise((resolve) => {
    const finish = (value) => { dialog.hidden = true; editor.inert = wasInert; primaryButton.onclick = null; secondaryButton.onclick = null; resolve(value); };
    primaryButton.onclick = () => finish(true);
    secondaryButton.onclick = () => finish(false);
    primaryButton.focus();
  });
}

function normalDraft(info) { return clone(info.draft); }

export function visualConversationInfoFixture(language = "zh-CN") {
  const anchor = { date: "2026-09-01", offset: "+08:00" };
  return {
    revision: { conversation: "c".repeat(64), mark: "m".repeat(64) }, archive: "019f7bde-5800-7000-8000-000000000001",
    effective: {
      conversation_name: "2026-07-14 GPT-5.6-Sol·奥思·绯缎缠骨 Osis.CrimsonSilkBind",
      models: ["GPT-5.6-Sol"],
      content_time: { state: "set", range: { start: { kind: "calendar", era: "AD", year: 1990, month: 6, day: 22, hour: 14, minute: 0, offset: "+08:00" }, end: { kind: "calendar", era: "AD", year: 2024, month: 11 } } }
    },
    draft: {
      conversation_name: { state: "set", value: "2026-07-14 GPT-5.6-Sol·奥思·绯缎缠骨 Osis.CrimsonSilkBind" },
      models: { state: "inherit" },
      content_time: { state: "set", range: { start: { kind: "calendar", era: "AD", year: 1990, month: 6, day: 22, hour: 14, minute: 0, offset: "+08:00" }, end: { kind: "calendar", era: "AD", year: 2024, month: 11 } } }
    },
    source: {
      platform: "chatgpt", title: "Source conversation title", models: ["GPT-5.6-Sol"], filename: "2026-07-14-export.html",
      captured_at: "2026-07-14T12:00:00.000Z", captured_from: "bookmark:captured_at"
    },
    file: { filename: "2026-07-14-GPT-5.6-Sol.json" },
    facts: {
      cloudig_edited_at: "2026-07-14T12:10:00.000Z", first_parsed_at: "2026-07-14T12:05:00.000Z", last_parsed_at: "2026-07-14T12:05:00.000Z",
      message_time: { start: "2026-07-14T00:00:00.000Z", end: "2026-07-16T12:00:00.000Z" }, parser: { version: "1.0.0", adapter: { id: "chatgpt-light", version: "1.0.0" } }
    },
    anchor, language
  };
}

export function mountConversationInfo(options) {
  const fragment = options.template.content.cloneNode(true);
  const layer = fragment.querySelector("[data-conversation-info-layer]");
  const dialog = layer.querySelector("[data-conversation-info-dialog]");
  const controller = new AbortController();
  let info = clone(options.info);
  let language = options.state.language === "en" ? "en" : "zh-CN";
  let values = setCopies(layer, language);
  mountParserHistory(layer.querySelector("[data-parser-history]"), language, controller.signal);
  let draft = normalDraft(info);
  const initialDraft = clone(draft);
  const sourceTitle = info.source.title ?? info.file.filename.replace(/\.json$/iu, "");
  let models = [...info.effective.models];
  let range = info.effective.content_time?.range ? clone(info.effective.content_time.range) : { start: defaultEndpoint(info.anchor) };
  let workingStart = clone(range.start);
  let workingEnd = range.end === undefined ? undefined : clone(range.end);
  let editing = "start";
  let timeAxis = workingStart.kind === "sovereign" ? "sovereign" : "terran";
  let pointFields = null;
  let terranPresets = options.terranPresets ?? [];
  let pointRevision = 0;
  let pointDirty = false;
  let timePreviewing = false;
  let updated = false;
  let busy = false;
  let closed = false;
  let closePending = null;
  const previousFocus = document.activeElement;
  const backgroundWasInert = options.background?.inert === true;

  const nameInput = layer.querySelector("[data-conversation-name]");
  bindRecordTextInput(nameInput, "title");
  bindRecordTextInput(layer.querySelector("[data-conversation-model-input]"));
  nameInput.required = false; // An empty title explicitly restores the source title.
  nameInput.placeholder = sourceTitle;
  const modelHost = layer.querySelector("[data-conversation-models]");
  const fields = layer.querySelector("[data-conversation-time-fields]");
  const display = layer.querySelector("[data-conversation-time-display]");
  const warning = layer.querySelector("[data-conversation-time-warning]");
  const touchPoint = (changed = true) => { pointRevision++; if (changed) pointDirty = true; warning.hidden = true; };
  const sovereignSearch = layer.querySelector("[data-conversation-sovereign-search]");
  const sovereignSort = layer.querySelector("[data-conversation-sovereign-sort]");
  const sovereignResults = layer.querySelector("[data-conversation-sovereign-results]");
  const sovereignOccurrences = layer.querySelector("[data-conversation-sovereign-occurrences]");
  let selectedSovereign = null;
  const renderSovereignSort = () => {
    const modes = { edited_desc: ["Time-Tea", values.editedDesc], edited_asc: ["Time-Clock", values.editedAsc], title: ["Name-Flower", values.titleSort] };
    const [icon, label] = modes[sovereignSort.value];
    sovereignSort.querySelector("img").src = `/assets/reader/Button-${icon}.svg`;
    sovereignSort.title = label; sovereignSort.setAttribute("aria-label", label);
  };

  const effectiveRange = () => draft.content_time.state === "set" ? draft.content_time.range : undefined;
  const dirty = () => !equal(draft, initialDraft) || pointDirty;
  const setBusy = (value) => { busy = value; dialog.dataset.busy = String(value); for (const node of dialog.querySelectorAll("button, input, select")) node.disabled = value; };

  const renderModels = () => {
    modelHost.replaceChildren();
    for (const model of models) {
      const chip = document.createElement("span");
      chip.className = "conversation-info-model-tag";
      chip.append(document.createTextNode(model));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = values.removeModel;
      remove.addEventListener("click", () => {
        models = models.filter((entry) => entry !== model);
        draft.models = { state: "set", values: [...models] };
        renderModels();
      }, { signal: controller.signal });
      chip.append(remove);
      modelHost.append(chip);
    }
  };

  const renderSummary = () => {
    display.replaceChildren();
    const state = draft.content_time.state;
    if (state === "cleared") display.textContent = values.clearedSummary;
    else {
      const current = effectiveRange();
      if (!current) {
        const label = document.createElement("span"); label.textContent = language === "en" ? "Time covered by the content" : "内容覆盖的时间";
        const hint = document.createElement("span"); hint.append(document.createTextNode(language === "en" ? "Edit, then " : "编辑后点击"));
        const confirm = document.createElement("b"); confirm.textContent = values.confirmTime; hint.append(confirm, document.createTextNode(language === "en" ? " to save" : "保存"));
        display.append(label, hint);
      }
      else {
        const output = document.createElement("strong");
        const start = document.createElement("span"); start.textContent = formatEndpoint(current.start, language); output.append(start);
        if (current.end !== undefined) {
          const separator = document.createElement("span"); separator.textContent = "—";
          const end = document.createElement("span"); end.textContent = formatEndpoint(current.end, language);
          output.append(separator, end);
        }
        display.append(output);
      }
    }
    display.dataset.state = state;
  };

  const currentEndpoint = () => editing === "start" ? workingStart : workingEnd ?? clone(workingStart);
  const renderEditor = () => {
    layer.querySelector("[data-conversation-endpoint-label]").textContent = editing === "start" ? values.start : values.end;
    layer.querySelector("[data-conversation-other-label]").textContent = editing === "start" ? values.end : values.start;
    layer.querySelector(".conversation-info-other-endpoint").dataset.endpoint = editing === "start" ? "end" : "start";
    const editOther = layer.querySelector("[data-conversation-edit-other]");
    editOther.textContent = `${editing === "start" ? values.editEnd : values.editStart}：${formatEndpoint(editing === "start" ? workingEnd ?? workingStart : workingStart, language)}`;
    editOther.title = editOther.textContent;
    const sameStart = layer.querySelector("[data-conversation-same-start]");
    sameStart.hidden = editing !== "end";
    sameStart.setAttribute("aria-pressed", String(editing === "end" && workingEnd === undefined));
    const otherSame = layer.querySelector("[data-conversation-other-same]");
    otherSame.hidden = editing !== "start";
    otherSame.setAttribute("aria-pressed", String(workingEnd === undefined));
    for (const button of layer.querySelectorAll("[data-conversation-axis]")) button.setAttribute("aria-pressed", String(button.dataset.conversationAxis === timeAxis));
    layer.querySelector("[data-conversation-terran-editor]").hidden = timeAxis !== "terran";
    layer.querySelector("[data-conversation-sovereign-editor]").hidden = timeAxis !== "sovereign";
    pointFields?.cleanup(); pointFields = null;
    if (timeAxis === "terran") pointFields = mountTerranPointFields({ host: fields, endpoint: currentEndpoint(), anchor: info.anchor, language,
      onChange: () => { if (editing === "end" && workingEnd === undefined) workingEnd = clone(workingStart); touchPoint(); } });
  };

  const renderSovereignOccurrences = () => {
    sovereignOccurrences.replaceChildren();
    if (!selectedSovereign || selectedSovereign.kind !== "periodic") { sovereignOccurrences.hidden = true; return; }
    sovereignOccurrences.hidden = false;
    const count = document.createElement("span"); count.className = "conversation-info-period-count"; count.textContent = `${language === "en" ? "Period count: " : "周期数："}${selectedSovereign.count}`; sovereignOccurrences.append(count);
    for (const [name, label] of [["first", values.first], ["step", values.step], ["last", values.last]]) {
      const field = document.createElement("label"); const span = document.createElement("span"); span.textContent = label;
      const input = document.createElement("input"); input.type = "number"; input.min = "1"; input.max = String(selectedSovereign.count); input.placeholder = label; input.required = true; input.dataset.sovereignOccurrence = name;
      field.append(span, input); sovereignOccurrences.append(field);
    }
    const confirm = document.createElement("button"); confirm.type = "button"; confirm.textContent = values.select; confirm.dataset.sovereignConfirm = ""; sovereignOccurrences.append(confirm);
  };

  const chooseSovereign = async (row) => {
    touchPoint(); const revision = pointRevision;
    selectedSovereign = row;
    for (const button of sovereignResults.querySelectorAll("[data-time-node]")) button.setAttribute("aria-pressed", String(button.dataset.timeNode === row.node));
    renderSovereignOccurrences();
    if (row.kind === "periodic") return;
    const result = await options.previewSovereign(row.node);
    if (controller.signal.aborted || revision !== pointRevision) return;
    if (editing === "start") workingStart = clone(result.endpoint); else workingEnd = clone(result.endpoint);
    timeAxis = "sovereign";
    renderEditor(); warning.hidden = true;
  };

  const sovereignPager = options.querySovereign ? createTimeNodePager({ host: sovereignResults, query: options.querySovereign, signal: controller.signal,
    onError: error => { warning.hidden = false; warning.textContent = error.message; }, render: rows => {
    sovereignResults.replaceChildren();
    if (!rows.length) { const empty = document.createElement("p"); empty.textContent = values.sovereignEmpty; sovereignResults.append(empty); return; }
    for (const row of rows) {
      const button = document.createElement("button"); button.type = "button";
      button.dataset.timeNode = row.node; button.setAttribute("aria-pressed", String(selectedSovereign?.node === row.node));
      const name = document.createElement("strong"); name.textContent = row.name;
      const summary = document.createElement("span"); summary.textContent = row.kind === "timeline" ? [row.author, row.version].filter(Boolean).join(" · ") : row.kind === "periodic" ? `${row.count} × ${row.unit ?? ""}` : "";
      button.append(name, summary); button.addEventListener("click", () => chooseSovereign(row).catch((error) => { warning.hidden = false; warning.textContent = error?.message || values.invalidTime; }), { signal: controller.signal }); sovereignResults.append(button);
    }
  } }) : null;
  const querySovereign = () => sovereignPager?.refresh({ search: sovereignSearch.value, sort: sovereignSort.value }) ?? Promise.resolve();

  const applyFields = (validate = false) => {
    if (timeAxis === "sovereign") return;
    if (editing === "end" && workingEnd === undefined) return;
    const endpoint = pointFields.read(validate);
    if (editing === "start") workingStart = endpoint;
    else workingEnd = endpoint;
  };

  const setFact = (name, value, full = value) => { const field = layer.querySelector(`[data-conversation-fact="${name}"]`); field.textContent = value; field.title = full; };
  const platform = info.source.platform;
  const [platformLabel] = platformDefinitions[platform] ?? [platform];
  const platformIcon = layer.querySelector("[data-conversation-platform-icon]");
  platformIcon.dataset.platform = platform;
  platformIcon.append(platformNode(platform));
  layer.querySelector("[data-conversation-platform]").textContent = platformLabel;
  nameInput.value = info.effective.conversation_name;
  setFact("edited_at", iso(info.facts.cloudig_edited_at).slice(0, 10), iso(info.facts.cloudig_edited_at));
  const firstParsed = info.facts.first_parsed_at;
  setFact("first_parsed", iso(firstParsed).slice(0, 10), `${iso(firstParsed)} · ${values.parserBasis}`);
  if (info.facts.message_time) setFact("message_time", `${iso(info.facts.message_time.start).slice(0, 16)} — ${iso(info.facts.message_time.end ?? info.facts.message_time.start).slice(0, 16)}`, `${iso(info.facts.message_time.start)} — ${iso(info.facts.message_time.end ?? info.facts.message_time.start)}`);
  else layer.querySelector("[data-conversation-message-time]").hidden = true;
  setFact("source_file", info.source.filename);
  if (info.source.captured_at) setFact("captured_at", iso(info.source.captured_at).slice(0, 10), `${iso(info.source.captured_at)} · ${info.source.captured_from}`);
  else layer.querySelector("[data-conversation-captured]").hidden = true;
  setFact("json_file", info.file.filename);
  setFact("parser", `Parser ${info.facts.parser.version} · ${info.facts.parser.adapter.id} ${info.facts.parser.adapter.version} · ${iso(info.facts.last_parsed_at)}`);

  const renderPresets = () => {
  const host = layer.querySelector("[data-conversation-presets]"); host.replaceChildren();
  for (const preset of terranPresets.filter(row => row.shortcut ?? terranShortcutNames.includes(row.name))) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = terranLabel(preset.name, language);
    button.dataset.preset = preset.node;
    button.addEventListener("click", async () => {
      touchPoint(); const revision = pointRevision;
      try {
        const result = await options.previewSovereign(preset.node);
        if (controller.signal.aborted || revision !== pointRevision) return;
        range = { start: clone(result.endpoint) };
        workingStart = clone(range.start); workingEnd = undefined; selectedSovereign = preset;
        timeAxis = "sovereign";
        draft.content_time = { state: "set", range: clone(range) }; pointDirty = false;
        for (const choice of host.querySelectorAll("button")) choice.setAttribute("aria-pressed", String(choice === button));
        renderSummary(); renderEditor(); warning.hidden = true;
      } catch (error) { warning.hidden = false; warning.textContent = error?.message || values.invalidTime; }
    }, { signal: controller.signal });
    host.append(button);
  }
  };
  renderPresets();

  nameInput.addEventListener("input", () => {
    draft.conversation_name = !nameInput.value.trim() || nameInput.value === sourceTitle ? { state: "inherit" } : { state: "set", value: nameInput.value };
  }, { signal: controller.signal });
  layer.querySelector("[data-conversation-model-open]").addEventListener("click", () => {
    layer.querySelector(".conversation-info-add-model").dataset.editing = "true";
    layer.querySelector("[data-conversation-model-input]").focus();
  }, { signal: controller.signal });
  layer.querySelector("[data-conversation-model-add]").addEventListener("click", () => {
    const input = layer.querySelector("[data-conversation-model-input]");
    refreshRecordTextInputs(layer);
    if (!input.reportValidity()) return;
    const model = input.value.trim();
    if (!model) return;
    if (models.includes(model)) { warning.hidden = false; warning.textContent = values.duplicateModel; return; }
    models.push(model);
    input.value = "";
    delete layer.querySelector(".conversation-info-add-model").dataset.editing;
    draft.models = { state: "set", values: [...models] };
    warning.hidden = true;
    renderModels();
  }, { signal: controller.signal });
  layer.querySelector("[data-conversation-model-input]").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); layer.querySelector("[data-conversation-model-add]").click(); } }, { signal: controller.signal });

  for (const button of layer.querySelectorAll("[data-conversation-axis]")) button.addEventListener("click", () => {
    try { applyFields(); } catch { /* Unconfirmed input remains local. */ }
    touchPoint();
    const sovereign = button.dataset.conversationAxis === "sovereign";
    timeAxis = sovereign ? "sovereign" : "terran";
    if (!sovereign && currentEndpoint().kind === "sovereign") {
      if (editing === "start") workingStart = defaultEndpoint(info.anchor); else workingEnd = defaultEndpoint(info.anchor);
    }
    renderEditor();
    if (sovereign) querySovereign().catch((error) => { warning.hidden = false; warning.textContent = error?.message || values.invalidTime; });
  }, { signal: controller.signal });
  let sovereignTimer = 0;
  sovereignSearch.addEventListener("input", () => { clearTimeout(sovereignTimer); sovereignTimer = setTimeout(() => querySovereign().catch(() => undefined), 140); }, { signal: controller.signal });
  sovereignSort.addEventListener("click", () => {
    const modes = ["edited_desc", "edited_asc", "title"]; sovereignSort.value = modes[(modes.indexOf(sovereignSort.value) + 1) % modes.length]; renderSovereignSort();
    querySovereign().catch(() => undefined);
  }, { signal: controller.signal });
  sovereignOccurrences.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-sovereign-confirm]") || !selectedSovereign) return;
    const number = (name) => Number(sovereignOccurrences.querySelector(`[data-sovereign-occurrence='${name}']`)?.value);
    try {
      touchPoint(); const revision = pointRevision;
      const result = await options.previewSovereign(selectedSovereign.node, { first: number("first"), step: number("step"), last: number("last") });
      if (controller.signal.aborted || revision !== pointRevision) return;
      if (editing === "start") workingStart = clone(result.endpoint); else workingEnd = clone(result.endpoint);
      timeAxis = "sovereign";
      renderEditor(); warning.hidden = true;
    } catch (error) { warning.hidden = false; warning.textContent = error?.message || values.invalidTime; }
  }, { signal: controller.signal });
  layer.querySelector("[data-conversation-edit-other]").addEventListener("click", () => {
    try { applyFields(); } catch { /* Preserve the last valid endpoint while flipping. */ }
    touchPoint(false);
    editing = editing === "start" ? "end" : "start";
    const endpoint = currentEndpoint();
    timeAxis = endpoint.kind === "sovereign" ? "sovereign" : "terran";
    renderEditor();
  }, { signal: controller.signal });
  for (const button of [layer.querySelector("[data-conversation-same-start]"), layer.querySelector("[data-conversation-other-same]")]) button.addEventListener("click", () => { touchPoint(); workingEnd = undefined; renderEditor(); }, { signal: controller.signal });

  layer.querySelector("[data-conversation-time-confirm]").addEventListener("click", async () => {
    if (timePreviewing) return;
    warning.hidden = true;
    const revision = pointRevision;
    const confirmButton = layer.querySelector("[data-conversation-time-confirm]");
    timePreviewing = true; confirmButton.disabled = true;
    try {
      applyFields(true);
      const candidate = { start: clone(workingStart), ...(workingEnd === undefined ? {} : { end: clone(workingEnd) }) };
      const candidateDraft = clone(draft);
      candidateDraft.content_time = { state: "set", range: candidate };
      const result = await options.preview(candidateDraft, language);
      if (controller.signal.aborted || revision !== pointRevision) return;
      draft.content_time = clone(result.draft.content_time);
      pointDirty = false;
      range = clone(result.content_time.range);
      workingStart = clone(range.start);
      workingEnd = range.end === undefined ? undefined : clone(range.end);
      if (result.content_time.direction === "reversed") { warning.hidden = false; warning.textContent = values.reversedTime; }
      renderSummary();
      renderEditor();
    } catch (error) {
      if (!controller.signal.aborted && revision === pointRevision) { warning.hidden = false; warning.textContent = timeInputError(error, language); }
    } finally { timePreviewing = false; confirmButton.disabled = false; }
  }, { signal: controller.signal });
  layer.querySelector("[data-conversation-time-clear]").addEventListener("click", () => { touchPoint(); pointDirty = false; draft.content_time = { state: "cleared" }; renderSummary(); }, { signal: controller.signal });
  for (const button of layer.querySelectorAll("[data-conversation-time-open]")) button.addEventListener("click", () => options.onOpenTime?.(), { signal: controller.signal });

  const close = () => {
    if (closed) return;
    closed = true; controller.abort(); pointFields?.cleanup(); clearTimeout(sovereignTimer);
    if (options.background) options.background.inert = backgroundWasInert;
    layer.remove(); options.onClose?.({ updated });
    if (previousFocus?.isConnected && !previousFocus.closest?.("[inert]")) previousFocus.focus?.({ preventScroll: true });
  };
  const requestClose = () => {
    if (closed || busy || options.canClose?.() === false) return Promise.resolve(false);
    if (closePending) return closePending;
    closePending = (async () => {
      if (!dirty() || await showChoice(layer, values, values.discardTitle, values.discardMessage, values.discard, values.stay)) { close(); return true; }
      return false;
    })().finally(() => { closePending = null; });
    return closePending;
  };
  layer.querySelector("[data-conversation-info-cancel]").addEventListener("click", requestClose, { signal: controller.signal });
  dialog.addEventListener("submit", async (event) => {
    event.preventDefault();
    refreshRecordTextInputs(layer);
    if (busy || !nameInput.reportValidity()) return;
    if (pointDirty || timePreviewing) { warning.hidden = false; warning.textContent = values.confirmPending; warning.scrollIntoView({ block: "nearest" }); return; }
    setBusy(true);
    try {
      const preview = await options.preview(draft, language);
      let touch = false;
      if (!preview.changed) {
        if (preview.can_touch === false) { close(); return; }
        touch = await showChoice(layer, values, values.noChangeTitle, values.noChangeMessage, values.update, values.noWrite);
        if (!touch) { close(); return; }
      }
      const result = await options.commit({
        expected_conversation: info.revision.conversation,
        expected_mark: info.revision.mark,
        draft,
        touch_on_noop: touch
      });
      updated = result.status === "updated";
      close();
    } catch (error) {
      warning.hidden = false;
      warning.textContent = error?.code === "CLOUDIG_ARCHIVE_INFO_CONFLICT" ? values.saveConflict : timeInputError(error, language);
      setBusy(false);
    }
  }, { signal: controller.signal });
  // Consume the completed click before removing the backdrop. Closing on
  // pointerdown can expose the control underneath to the rest of that gesture.
  layer.addEventListener("click", (event) => {
    if (event.target !== layer) return;
    event.preventDefault(); event.stopPropagation(); requestClose();
  }, { signal: controller.signal });
  layer.addEventListener("keydown", (event) => {
    const confirmation = layer.querySelector("[data-conversation-info-confirm]");
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!confirmation.hidden) confirmation.querySelector("[data-conversation-confirm-secondary]").click(); else requestClose(); return; }
    if (event.key !== "Tab") return;
    const nodes = focusable(confirmation.hidden ? dialog : confirmation);
    if (nodes.length === 0) return;
    const first = nodes[0]; const last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, { signal: controller.signal });

  renderModels();
  renderSovereignSort();
  renderSummary();
  renderEditor();
  options.host.append(layer);
  if (options.background) options.background.inert = true;
  requestAnimationFrame(() => { if (!closed) nameInput.focus(); });
  return { element: layer, close: requestClose, cleanup: close,
    async refreshTimeContext() {
      const model = await options.reloadTime?.();
      if (controller.signal.aborted || !model) return;
      terranPresets = model.terran.items; renderPresets();
      if (timeAxis === "sovereign") await querySovereign();
    },
    updateLanguage(next) {
      if (next === language) return;
      const pointSnapshot = pointFields?.snapshot();
      try { applyFields(); } catch { /* Preserve the last confirmed point if the new input is incomplete. */ }
      language = next === "en" ? "en" : "zh-CN"; values = setCopies(layer, language); touchPoint(false);
      renderSovereignSort();
      renderModels(); renderPresets(); renderSummary(); renderEditor();
      if (pointSnapshot) pointFields?.restore(pointSnapshot);
      if (timeAxis === "sovereign") querySovereign().catch(error => { warning.hidden = false; warning.textContent = error.message; });
    }
  };
}
