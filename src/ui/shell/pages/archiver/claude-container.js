import { archiveDateLabel } from "../../archive-workflow.js";
import { mountParseTarget } from "../../parse-target.js";
import { presentPlatformJson, restorePlatformJson } from "./platform-json-presentation.js";

const queryPageSize = 200;
const commitBatchSize = 500;

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function date(value, language) {
  return typeof value === "string" ? archiveDateLabel(value) : language === "en" ? "Unknown" : "未知";
}

function copy(language) {
  return language === "en" ? {
    title: "Claude Conversation File Parser",
    search: "Search titles",
    all: "All",
    ready: "Pending",
    parsed: "Complete",
    failed: "Failed",
    selected: "Selected",
    selectAll: "All",
    cancelAll: "Cancel",
    messages: "Messages",
    branches: "Branches",
    created: "Created",
    updated: "Updated",
    status: "Status",
    action: "Action",
    single: "Single line",
    parse: "Parse",
    parsedAction: "Parse again",
    retry: "Retry",
    unsupported: "Unsupported in this Parser version",
    update: "Parser update",
    settings: "One-click Parse Settings",
    oneClick: "One-click Parse",
    rebuild: "Rebuild Index",
    back: "Return to Archiver",
    timeTitle: "Time Type",
    sortTitle: "Sort Order",
    newest: "Time descending",
    oldest: "Time ascending",
    titleSort: "Title order",
    save: "Save Settings",
    cancel: "Cancel",
    directory: "Archive directory",
    root: "Conversation root (default)",
    parseUnparsed: "Parse all unparsed records",
    parseSelected: "Parse or update selected records",
    updateOutdated: "Update all records from an older Parser",
    preserve: "Keep previous parse results"
  } : {
    title: "Claude会话文件解析",
    search: "搜索标题",
    all: "全部",
    ready: "待解析",
    parsed: "已完成",
    failed: "失败",
    selected: "已选",
    selectAll: "全选",
    cancelAll: "取消",
    messages: "消息数",
    branches: "分支数",
    created: "创建时间",
    updated: "更新时间",
    status: "状态",
    action: "操作",
    single: "单线",
    parse: "解析",
    parsedAction: "重新解析",
    retry: "重新解析",
    unsupported: "当前Parser版本不支持",
    update: "解析器更新",
    settings: "一键解析设置",
    oneClick: "一键解析",
    rebuild: "重建索引",
    back: "返回档案馆",
    timeTitle: "时间类型",
    sortTitle: "排序方式",
    newest: "时间倒序",
    oldest: "时间顺序",
    titleSort: "标题排序",
    save: "保存设置",
    cancel: "取消",
    directory: "档案区目录",
    root: "对话根目录（默认）",
    parseUnparsed: "解析所有未解析文件",
    parseSelected: "解析或更新选中文件",
    updateOutdated: "更新所有旧版解析文件",
    preserve: "保留旧版解析结果"
  };
}

function statusQuery(filter) {
  if (filter === "ready") return ["ready"];
  if (filter === "parsed" || filter === "update") return [filter];
  if (filter === "failed") return ["failed", "unsupported"];
  return [];
}

function statusClass(value) {
  return ["ready", "parsed", "update", "failed", "unsupported"].includes(value) ? value : "ready";
}

function rowButton(row, language) {
  const text = copy(language);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "archiver-claude-row-action";
  button.dataset.claudeExtract = row.selector;
  button.dataset.status = statusClass(row.status);
  button.textContent = "▶";
  button.title = row.status === "parsed" ? text.parsedAction
    : row.status === "failed" ? text.retry
      : row.status === "unsupported" ? text.unsupported
        : row.status === "update" ? text.update
          : text.parse;
  button.disabled = row.status === "unsupported";
  return button;
}

export const claudeContainerPreload = [
  "/assets/archiver/TitleDec-Explosion.svg",
  "/assets/archiver/TitleDec-Garden.svg",
  "/assets/archiver/TitleDec-Pompeii.svg",
  "/assets/archiver/TitleDec-Homeland.svg"
];

export function visualClaudeContainerFixture() {
  const items = Array.from({ length: 28 }, (_, index) => ({
    selector: String(index + 1).padStart(64, "a"),
    ordinal: index + 1,
    title: `奥思·${["归舟听雨", "灯火同辉", "星河不灭", "落花成诗"][index % 4]} Osis.Sample${index + 1}（Claude-Opus-4.6）`,
    messages: 6 + index * 17,
    branches: index % 8 === 0 ? 1 : 3 + index * 2,
    created_at: new Date(Date.UTC(2026, 4, 26 + index)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 5, 2 + index)).toISOString(),
    status: index === 2 ? "failed" : index === 13 ? "update" : index < 5 ? "ready" : "parsed"
  }));
  return {
    container: `c_${"c".repeat(43)}`,
    source: { filename: "conversations.json", bytes: 651 * 1024 * 1024, captured_at: "2026-06-30T08:00:00.000Z" },
    built_at: "2026-08-11T12:00:00.000Z",
    total: 348,
    visible: 348,
    offset: 0,
    statuses: { ready: 334, parsed: 12, update: 1, failed: 1, unsupported: 0 },
    items
  };
}

export function mountClaudeContainer(options) {
  const root = options.root;
  const host = root.querySelector("[data-archiver-claude-view]");
  const controller = new AbortController();
  let language = options.state.language;
  let container = options.index.container;
  let source = options.index.source;
  let builtAt = options.index.built_at;
  let model = null;
  let items = [];
  let known = new Map();
  let selection = new Set();
  let filter = "all";
  let search = "";
  let busy = false;
  let parse = { ...(options.state.parseClaude ?? { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false }) };
  let workflow = { ...(options.state.workflowClaude ?? { sort: "time_desc", time_field: "updated_at" }) };
  let targetDirectory = (options.directories ?? []).find(d => `Conversations/${d.name}` === options.state.defaultOutputDirectory)?.capability ?? null;
  let activeChoice = null;
  const directoryLabel = () => targetDirectory
    ? options.directories?.find((item) => item.capability === targetDirectory)?.name ?? copy(language).root
    : copy(language).root;

  const queryPayload = (offset = 0, limit = queryPageSize, statuses = statusQuery(filter)) => ({
    container,
    offset,
    limit,
    search,
    ...(statuses.length > 0 ? { statuses } : {}),
    time_field: workflow.time_field,
    sort: workflow.sort === "title" ? "title" : "time",
    direction: workflow.sort === "time_asc" ? "asc" : "desc"
  });

  const closeChoice = () => {
    activeChoice?.remove();
    activeChoice = null;
  };

  const renderMetadata = () => {
    host.querySelector("[data-claude-title]").textContent = copy(language).title;
    presentPlatformJson(host, options.presentation, language);
    host.querySelector("[data-claude-source-name]").textContent = source.filename ?? "conversations.json";
    host.querySelector("[data-claude-source-bytes]").textContent = formatBytes(source.bytes);
    host.querySelector("[data-claude-source-captured]").textContent = date(source.captured_at, language);
    host.querySelector("[data-claude-indexed-at]").textContent = date(builtAt, language);
  };

  const renderStatuses = () => {
    const text = copy(language);
    const statuses = model?.statuses ?? {};
    const values = {
      all: Object.values(statuses).reduce((sum, value) => sum + Number(value ?? 0), 0),
      ready: Number(statuses.ready ?? 0),
      parsed: Number(statuses.parsed ?? 0),
      update: Number(statuses.update ?? 0),
      failed: Number(statuses.failed ?? 0) + Number(statuses.unsupported ?? 0)
    };
    host.querySelector('[data-claude-status="all"]').parentElement.setAttribute("aria-label", language === "en" ? "Parse status" : "解析记录状态");
    for (const button of host.querySelectorAll("[data-claude-status]")) {
      const value = button.dataset.claudeStatus;
      button.textContent = `${text[value]} ${values[value]}`;
      button.dataset.selected = String(filter === value);
      button.setAttribute("aria-pressed", String(filter === value));
    }
  };

  const renderRows = () => {
    const text = copy(language);
    const rows = host.querySelector("[data-claude-records]");
    rows.replaceChildren();
    for (const row of items) {
      const article = document.createElement("article");
      article.className = "archiver-claude-row";
      article.dataset.claudeRow = row.selector;
      article.tabIndex = 0;
      article.dataset.selected = String(selection.has(row.selector));
      article.dataset.status = statusClass(row.status);
      article.dataset.sourceEmpty = String(Number(row.messages) === Number(row.empty_messages));
      const select = document.createElement("button");
      select.type = "button";
      select.className = "archiver-claude-select";
      select.dataset.claudeSelect = row.selector;
      select.setAttribute("aria-pressed", String(selection.has(row.selector)));
      select.setAttribute("aria-label", row.title);
      for (const [theme, color] of [["dawn", "Red"], ["star-night", "Purple"]]) {
        const pin = document.createElement("img"); pin.className = `archiver-theme-${theme}`;
        pin.src = `/assets/reader/Pushpin-${color}.svg`; pin.alt = ""; select.append(pin);
      }
      const title = document.createElement("span");
      title.className = "archiver-claude-row-title";
      title.dataset.overflowText = "";
      title.textContent = row.title;
      title.title = row.title;
      const messages = document.createElement("span");
      messages.textContent = String(row.messages ?? 0);
      const branches = document.createElement("span");
      branches.textContent = Number(row.branches) <= 1 ? text.single : String(row.branches);
      const timestamp = document.createElement("span");
      timestamp.textContent = date(row[workflow.time_field], language);
      const status = document.createElement("span");
      status.className = "archiver-claude-row-status";
      status.dataset.status = statusClass(row.status);
      status.textContent = row.status === "ready" ? text.ready
        : row.status === "parsed" ? text.parsed
          : row.status === "update" ? text.update
            : row.status === "unsupported" ? text.unsupported
              : text.failed;
      if (row.error) status.title = row.error;
      if (Number(row.messages) === 0 || Number(row.empty_messages) === Number(row.messages)) {
        const note = document.createElement("small"); note.className = "archiver-claude-empty-note";
        note.textContent = language === "en" ? "Empty source" : "原导出无正文";
        note.title = language === "en" ? "The source export contains no message content; IDs and branches are preserved." : "原导出未包含消息内容，编号与分支仍保留。";
        messages.title = note.title; status.append(note);
      }
      article.append(select, title, messages, branches, timestamp, status, rowButton(row, language));
      rows.append(article);
    }
  };

  const render = () => {
    const text = copy(language);
    renderMetadata();
    renderStatuses();
    renderRows();
    const records = host.querySelector("[data-claude-records]");
    const visibleRows = Math.min(items.length, Math.max(1, Math.floor(records.clientHeight / 45)));
    host.querySelector("[data-claude-visible]").textContent = `${visibleRows}/${model?.total ?? options.index.records ?? 0}`;
    host.querySelector("[data-claude-selection]").textContent = `${text.selected} ${selection.size}`;
    host.querySelector("[data-claude-search]").placeholder = text.search;
    host.querySelector("[data-claude-time]").title = text.timeTitle;
    host.querySelector("[data-claude-time-heading]").textContent = workflow.time_field === "created_at" ? text.created : text.updated;
    host.querySelector("[data-claude-sort]").title = text.sortTitle;
    host.querySelector("[data-claude-settings]").title = text.settings;
    host.querySelector("[data-claude-one-click]").textContent = text.oneClick;
    host.querySelector("[data-claude-rebuild]").textContent = text.rebuild;
    host.querySelector("[data-claude-return]").textContent = options.returnLabel?.(language) ?? text.back;
    const allLoadedSelected = items.length > 0 && items.every((row) => selection.has(row.selector));
    for (const selectAll of host.querySelectorAll("[data-claude-select-all]")) {
      selectAll.textContent = allLoadedSelected && selection.size === Number(model?.visible ?? 0) ? text.cancelAll : text.selectAll;
      selectAll.setAttribute("aria-pressed", String(allLoadedSelected && selection.size === Number(model?.visible ?? 0)));
    }
    for (const button of host.querySelectorAll("button, input, select")) button.disabled = busy || button.dataset.status === "unsupported";
  };

  const refresh = async () => {
    model = await options.query(queryPayload());
    source = model.source ?? source;
    builtAt = model.built_at ?? builtAt;
    items = [...(model.items ?? [])];
    known = new Map(items.map((row) => [row.selector, row]));
    selection = new Set([...selection].filter((selector) => known.has(selector)));
    render();
  };

  const loadMore = async () => {
    if (busy || !model || items.length >= model.visible) return;
    busy = true;
    try {
      const next = await options.query(model.snapshot ? { container, snapshot: model.snapshot, offset: items.length, limit: 200 } : queryPayload(items.length));
      const visible = new Set(items.map(row => row.selector));
      for (const row of next.items ?? []) { if (!visible.has(row.selector)) items.push(row); known.set(row.selector, row); }
      render();
    } finally {
      busy = false;
      render();
    }
  };

  const allRows = async (statuses = statusQuery(filter), wholeContainer = false) => {
    const values = [];
    let offset = 0;
    let snapshot;
    while (true) {
      const page = await options.query(snapshot ? { container, snapshot, offset, limit: 200 } : { ...queryPayload(offset, 200, statuses), ...(wholeContainer ? { search: "" } : {}) });
      snapshot = page.snapshot;
      values.push(...(page.items ?? []));
      if (values.length >= page.visible || (page.items ?? []).length === 0) break;
      offset += page.items.length;
    }
    return values;
  };

  const openChoice = (anchor, title, values, selected, onSelect) => {
    closeChoice();
    const panel = document.createElement("section");
    panel.className = "archiver-claude-choice";
    panel.innerHTML = `<strong></strong><div></div>`;
    panel.querySelector("strong").textContent = title;
    const body = panel.querySelector("div");
    for (const value of values) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = value.label;
      button.dataset.selected = String(value.value === selected);
      button.addEventListener("click", () => { closeChoice(); Promise.resolve(onSelect(value.value)).catch(options.onError); });
      body.append(button);
    }
    host.append(panel);
    const anchorRect = anchor.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    panel.style.left = `${Math.max(16, Math.min(hostRect.width - 236, anchorRect.left - hostRect.left))}px`;
    panel.style.top = `${anchorRect.bottom - hostRect.top + 6}px`;
    activeChoice = panel;
  };

  const settingsPanel = host.querySelector("[data-claude-settings-popover]");
  let settingsTarget = null;
  const positionSettings = () => {
    if (settingsPanel.hidden) return;
    const frame = host.getBoundingClientRect();
    const anchor = host.querySelector("[data-claude-settings]").getBoundingClientRect();
    const top = anchor.bottom - frame.top + 10;
    settingsPanel.style.top = `${top}px`;
    settingsPanel.style.maxHeight = `${Math.max(120, frame.height - top - 16)}px`;
  };
  root.ownerDocument.defaultView.addEventListener("resize", positionSettings, { signal: controller.signal });
  const syncSettings = () => {
    const text = copy(language);
    settingsPanel.querySelector("h2").textContent = text.settings;
    const directory = settingsPanel.querySelector("[data-claude-directory]");
    const previous = directory.closest(".cloudig-parse-target") ?? directory.parentElement;
    const selected = options.directories?.find(d => d.capability === targetDirectory);
    settingsTarget?.dispose();
    settingsTarget = mountParseTarget({ language, mode: "settings", selectElement: directory, id: "claude-settings-directory",
      directories: options.directories ?? [], initialDirectory: selected ? `Conversations/${selected.name}` : "Conversations",
      onCreate: async name => { const fresh = await options.createDirectory(name); options.directories = fresh; return fresh; },
      errorMessage: options.directoryCreateErrorMessage,
      onBusy: busy => { for (const button of settingsPanel.querySelectorAll("footer button")) button.disabled = busy; } });
    previous.replaceWith(settingsTarget.element);
    for (const input of settingsPanel.querySelectorAll("[data-claude-setting]")) input.checked = Boolean(parse[input.dataset.claudeSetting]);
    for (const [selector, value] of [["[data-claude-setting-unparsed]", text.parseUnparsed], ["[data-claude-setting-selected]", text.parseSelected], ["[data-claude-setting-outdated]", text.updateOutdated], ["[data-claude-setting-preserve]", text.preserve]]) settingsPanel.querySelector(selector).textContent = value;
    settingsPanel.querySelector("[data-claude-settings-save]").textContent = text.save;
    settingsPanel.querySelector("[data-claude-settings-cancel]").textContent = text.cancel;
  };

  const handleClick = async (event) => {
    if (busy || settingsTarget?.busy) return;
    const select = event.target.closest("[data-claude-select]");
    const row = event.target.closest("[data-claude-row]");
    if (select || row && !event.target.closest("button, a, input, select")) {
      const selector = select?.dataset.claudeSelect ?? row.dataset.claudeRow;
      selection.has(selector) ? selection.delete(selector) : selection.add(selector);
      render();
      return;
    }
    const status = event.target.closest("[data-claude-status]");
    if (status) { filter = status.dataset.claudeStatus; selection.clear(); await refresh(); return; }
    if (event.target.closest("[data-claude-select-all]")) {
      if (selection.size === Number(model?.visible ?? 0) && selection.size > 0) selection.clear();
      else {
        const rows = await allRows();
        for (const row of rows) { selection.add(row.selector); known.set(row.selector, row); }
      }
      render();
      return;
    }
    const extract = event.target.closest("[data-claude-extract]");
    if (extract) { const row = known.get(extract.dataset.claudeExtract); if (row) await options.extract([row], targetDirectory, { directory: directoryLabel(), preserve_previous: parse.preserve_previous }); return; }
    if (event.target.closest("[data-claude-one-click]")) {
      const selectedRows = [...selection].map((selector) => known.get(selector)).filter(Boolean);
      const unparsed = parse.parse_unparsed ? await allRows(["ready"], true) : [];
      const outdated = parse.update_outdated ? await allRows(["update"], true) : [];
      const rows = [...new Map([...(parse.parse_selected ? selectedRows : []), ...unparsed, ...outdated].map((row) => [row.selector, row])).values()];
      if (rows.length > 0) await options.extract(rows, targetDirectory, { directory: directoryLabel(), preserve_previous: parse.preserve_previous });
      return;
    }
    if (event.target.closest("[data-claude-settings]")) { syncSettings(); settingsPanel.hidden = false; positionSettings(); return; }
    if (event.target.closest("[data-claude-settings-cancel]")) { settingsPanel.hidden = true; return; }
    if (event.target.closest("[data-claude-settings-save]")) {
      const next = { ...parse };
      for (const input of settingsPanel.querySelectorAll("[data-claude-setting]")) next[input.dataset.claudeSetting] = input.checked;
      const selected = settingsPanel.querySelector("[data-claude-directory]").value;
      const directory = selected === "root" ? "Conversations" : `Conversations/${options.directories.find(d => d.capability === selected).name}`;
      const stored = await options.savePreferences(next, workflow, directory);
      targetDirectory = selected === "root" ? null : selected;
      parse = { ...(stored?.parse ?? next) };
      workflow = { ...(stored?.workflow ?? workflow) };
      settingsPanel.hidden = true;
      render();
      return;
    }
    const text = copy(language);
    const time = event.target.closest("[data-claude-time]");
    if (time) {
      openChoice(time, text.timeTitle, [{ value: "updated_at", label: text.updated }, { value: "created_at", label: text.created }], workflow.time_field, async (value) => {
        workflow.time_field = value;
        await options.savePreferences(parse, workflow);
        selection.clear();
        await refresh();
      });
      return;
    }
    const sort = event.target.closest("[data-claude-sort]");
    if (sort) {
      openChoice(sort, text.sortTitle, [{ value: "time_desc", label: text.newest }, { value: "time_asc", label: text.oldest }, { value: "title", label: text.titleSort }], workflow.sort, async (value) => {
        workflow.sort = value;
        await options.savePreferences(parse, workflow);
        selection.clear();
        await refresh();
      });
      return;
    }
    if (event.target.closest("[data-claude-rebuild]")) await options.rebuild();
    if (event.target.closest("[data-claude-return]")) options.returnToArchiver();
  };
  host.addEventListener("click", (event) => { handleClick(event).catch(options.onError); }, { signal: controller.signal });
  host.addEventListener("keydown", event => {
    if (!["Enter", " "].includes(event.key) || !event.target.matches("[data-claude-row]")) return;
    event.preventDefault(); event.target.click();
  }, { signal: controller.signal });

  host.querySelector("[data-claude-search]").addEventListener("change", (event) => {
    search = event.target.value.trim();
    selection.clear();
    refresh().catch(options.onError);
  }, { signal: controller.signal });
  host.querySelector("[data-claude-records]").addEventListener("scroll", (event) => {
    if (event.target.scrollTop + event.target.clientHeight >= event.target.scrollHeight - 120) loadMore().catch(() => undefined);
  }, { signal: controller.signal, passive: true });
  host.querySelector("[data-claude-progress-cancel]").addEventListener("click", () => options.cancel?.(), { signal: controller.signal });
  host.addEventListener("pointerdown", (event) => {
    if (activeChoice && !event.target.closest(".archiver-claude-choice") && !event.target.closest("[data-claude-time], [data-claude-sort]")) closeChoice();
    if (!settingsTarget?.busy && !settingsPanel.hidden && !event.target.closest("[data-claude-settings-popover], [data-claude-settings]")) settingsPanel.hidden = true;
  }, { signal: controller.signal });

  renderMetadata();
  refresh().catch(options.onError);
  return {
    container() { return container; },
    setProgress(event, operationRows = []) {
      const region = host.querySelector("[data-claude-progress]");
      region.hidden = false;
      host.querySelector("[data-claude-progress-stage]").textContent = event.phase ?? "extract";
      const index = event.file?.index;
      host.querySelector("[data-claude-progress-record]").textContent = Number.isInteger(index) ? operationRows[index - 1]?.title ?? "" : "";
      const amount = event.bytes ?? event.items ?? event.file;
      const bar = host.querySelector("[data-claude-progress-bar]");
      if (Number.isFinite(amount?.total) && amount.total > 0) { bar.max = amount.total; bar.value = amount.completed ?? 0; }
      else bar.removeAttribute("value");
      host.querySelector("[data-claude-progress-counter]").textContent = Number.isFinite(amount?.total) ? `${amount.completed ?? 0} / ${amount.total}` : "";
    },
    clearProgress() { host.querySelector("[data-claude-progress]").hidden = true; },
    async refresh() { await refresh(); },
    replaceIndex(next) { container = next.container; source = next.source; builtAt = next.built_at; selection.clear(); return refresh(); },
    updateState(next) {
      closeChoice();
      settingsPanel.hidden = true;
      language = next.language;
      parse = { ...(next.parseClaude ?? parse) };
      workflow = { ...(next.workflowClaude ?? workflow) };
      targetDirectory = (options.directories ?? []).find(d => `Conversations/${d.name}` === next.defaultOutputDirectory)?.capability ?? null;
      render();
    },
    cleanup() { settingsTarget?.dispose(); closeChoice(); restorePlatformJson(host); controller.abort(); }
  };
}
