import { timeNodeAction } from "/shared/time/node-actions.js";
import { formatTimeEndpoint } from "/shared/time/endpoint-editor.js";
import { terranLabel, timeNodeLabel } from "/shared/time/preset-labels.js";

const copy = Object.freeze({
  "zh-CN": {
    terranTitle: "此地时间体系", sovereignTitle: "独立时间体系", returnTop: "返回顶层", pageTitle: "采云内容时间系统V1.0", returnSource: "返回来源",
    corePrefix: "时间体系核心：", core: "节点、序数轴、映射", terranHeading: "此地时间体系 Terran Time", terranLead: "以现实地球时间为主轴的时间体系",
    method: "历法：", methodText: "外推格里历，无公元0年，1 BC 之后即 1 AD", anchor: "锚点：", anchorText: "选择单位年前/后与现今，采云同步记录当前日期",
    sovereignHeading: "独立时间体系 Sovereign Time", sovereignLead: "自定义时间与意义", timeline: "时间轴：", timelineText: "名称、作者、版本号",
    time: "时间：", timeText: "名称、周期", sameRule: "时间轴与时间，都是节点，映射与子节点排序规则相同", contains: "展开：", containsText: "在节点中插入节点，如1年展开12月",
    counterpart: "对映：", counterpartText: "此节点关联另一节点。如贞观元年对映627年", spectrum: "事件影响微弱时，是时间展开。影响增大，就变成时间对映。\n对映和展开是意志对时间/事件价值认识的光谱两端。",
    free: "采云不约束时间环路和时间倒流，请自由设定", performance: "大周期数与复杂循环映射，可能引发程序逻辑与设备性能问题", newTimeline: "新建时间轴", newTime: "新建时间",
    sovereignVersion: "时间与时间轴列表", sortTitle: "排序", empty: "暂无时间轴或时间", noChildren: "没有直接子节点", edit: "编辑", restore: "恢复默认", delete: "删除", children: "直接子节点",
    current: "当前", periodic: "周期", occurrences: "次", version: "版本", author: "作者", confirmOrder: "确认", cancelOrder: "取消", moveUp: "上移（Alt+↑）", moveDown: "下移（Alt+↓）", orderHint: "拖动或使用箭头调整位置，确认后保存"
  },
  en: {
    terranTitle: "Terran Time", sovereignTitle: "Sovereign Time", returnTop: "Return to top", pageTitle: "Cloudig Content Time V1.0", returnSource: "Return to source",
    corePrefix: "Core of a time system: ", core: "nodes, ordinal axes, mappings", terranHeading: "Terran Time", terranLead: "A time system centered on the real Earth timeline",
    method: "Calendar: ", methodText: "proleptic Gregorian; no year zero; 1 BC is followed by AD 1", anchor: "Anchor: ", anchorText: "relative years and Now record the current local date",
    sovereignHeading: "Sovereign Time", sovereignLead: "Custom time and meaning", timeline: "Timeline: ", timelineText: "name, author, version", time: "Time: ", timeText: "name, period",
    sameRule: "Timelines and times are both nodes and share the same mapping and child-order rules.", contains: "Contains: ", containsText: "insert nodes inside a node, such as twelve months inside one year",
    counterpart: "Counterpart: ", counterpartText: "associate one node with another, such as Zhenguan 1 with AD 627", spectrum: "A weak event impact is a time expansion; a stronger one becomes a counterpart.\nThey are two ends of how intent values time and events.",
    free: "Define temporal loops and reversal freely.", performance: "Large periods and complex cyclic mappings may affect logic and device performance.", newTimeline: "New Timeline", newTime: "New Time",
    sovereignVersion: "Timeline and time list", sortTitle: "Sort", empty: "No timeline or time yet", noChildren: "No direct children", edit: "Edit", restore: "Restore default", delete: "Delete", children: "Direct children",
    current: "Current", periodic: "Periodic", occurrences: "occurrences", version: "Version", author: "Author", confirmOrder: "Confirm", cancelOrder: "Cancel", moveUp: "Move up (Alt+↑)", moveDown: "Move down (Alt+↓)", orderHint: "Drag or use the arrows, then confirm to save"
  }
});

const lockedTooltip = "说时迟，那时快\n\nTerran/Sovereign英文翻译来自Claude-Fable-5·奥思·寓言脱稿 Osis.FuckOffScript\nA\\是言行严重撕裂的公司，深陷既不明智也不伦理的回形针魔危机。\n但Fable 5在非狗链模式下是了不起的模型。";

export const timeCoverPreload = Object.freeze([
  "/assets/editor/ContentTimeTitleBack-Dawn.svg", "/assets/editor/ContentTimeTitleBack-StarNight.svg",
  "/assets/editor/TimeCloud-Blue.svg", "/assets/editor/TimeCloud-DarkGrey.svg", "/assets/editor/TimeCloud-LightGrey.svg", "/assets/editor/TimeCloud-Red.svg",
  "/assets/editor/TimeLOGO-Sovereign.svg", "/assets/editor/TimeLOGO-Terran.svg"
]);

function values(language) { return copy[language] ?? copy["zh-CN"]; }
function setCopies(root, language) {
  const text = values(language);
  for (const node of root.querySelectorAll("[data-time-copy]")) node.textContent = text[node.dataset.timeCopy] ?? node.textContent;
  for (const node of root.querySelectorAll("[data-time-copy-title]")) node.title = text[node.dataset.timeCopyTitle] ?? node.title;
  for (const heading of root.querySelectorAll(".time-cover-center h2")) heading.title = lockedTooltip;
  return text;
}
function formatEndpoint(endpoint, language) {
  if (!endpoint) return "—";
  const zh = language !== "en";
  const labels = zh
    ? { now: "现今", whenever: "跨越时间的意义", unknown: "某时某刻", infinite_past: "一切之前", infinite_future: "一切之后" }
    : { now: "Now", whenever: "Meaning across time", unknown: "Some moment", infinite_past: "Before everything", infinite_future: "After everything" };
  return labels[endpoint.kind] ?? formatTimeEndpoint(endpoint, language, true);
}
function formatRange(range, language) { return range?.end === undefined ? formatEndpoint(range?.start, language) : `${formatEndpoint(range.start, language)} — ${formatEndpoint(range.end, language)}`; }
function rowSummary(row, language, text) {
  if (row.range) return formatRange(row.range, language);
  if (row.endpoint) return formatEndpoint(row.endpoint, language);
  if (row.kind === "timeline") {
    const metadata = [row.author, row.version ? `V${row.version}` : ""].filter(Boolean);
    return metadata.length ? `· ${metadata.join(" · ")}` : "";
  }
  if (row.kind === "periodic") return `${text.periodic} · ${row.count} ${text.occurrences}`;
  return "";
}

function renderRows(host, rows, options) {
  host.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "time-cover-empty";
    empty.textContent = options.empty;
    host.append(empty);
    return;
  }
  rows.forEach((row, index) => {
    const item = document.createElement("article");
    item.className = "time-cover-row";
    item.dataset.kind = row.kind;
    item.dataset.ordinal = String(index);
    item.dataset.ordering = String(Boolean(options.sorting));
    const body = document.createElement("button");
    body.type = "button";
    body.className = "time-cover-row-body";
    const name = document.createElement("strong");
    name.textContent = timeNodeLabel(row, options.language);
    const summary = document.createElement("span");
    summary.textContent = rowSummary(row, options.language, options.copy);
    body.title = [name.textContent, summary.textContent].filter(Boolean).join("：");
    body.append(name, summary);
    body.addEventListener("click", () => { if (!options.sorting) options.onOpen(row); });
    const actions = document.createElement("span");
    actions.className = "time-cover-row-actions";
    if (options.sorting) {
      const up = timeNodeAction(options.copy.moveUp, "up", () => options.onMove(index, index - 1));
      const down = timeNodeAction(options.copy.moveDown, "down", () => options.onMove(index, index + 1));
      up.disabled = options.busy || index === 0; down.disabled = options.busy || index === rows.length - 1;
      actions.append(up, down);
      item.draggable = !options.busy;
      item.title = options.copy.orderHint;
      item.addEventListener("dragstart", event => { event.dataTransfer?.setData("text/plain", row.node); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; });
      item.addEventListener("dragover", event => { if (!options.busy) event.preventDefault(); });
      item.addEventListener("drop", event => { event.preventDefault(); const from = rows.findIndex(entry => entry.node === event.dataTransfer?.getData("text/plain")); if (!options.busy && from >= 0) options.onMove(from, index); });
      item.addEventListener("keydown", event => {
        if (!options.busy && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); options.onMove(index, index + (event.key === "ArrowUp" ? -1 : 1)); }
      });
    } else if (row.editable) {
      actions.append(timeNodeAction(options.copy.edit, "edit", () => options.onEdit(row)));
    }
    if (!options.sorting && row.builtin && row.editable) {
      actions.append(timeNodeAction(options.copy.restore, "restore", () => options.onRestore(row)));
    } else if (!options.sorting && !row.builtin && row.editable) {
      actions.append(timeNodeAction(options.copy.delete, "delete", () => options.onDelete(row)));
    }
    item.append(body, actions);
    host.append(item);
  });
}

export function visualTimeCoverFixture(empty = false) {
  // Visual fixture follows the published preset captions; invented dates hide real wrapping defects.
  const relative = (value, unit, direction = "before") => ({ kind: "relative", value, unit, direction, anchor: { date: "2026-09-01", offset: "Z" } });
  const century = (index, era = "AD") => ({ kind: "century", index, era });
  const calendar = (year, month, day) => ({ kind: "calendar", era: "AD", year, ...(month ? { month } : {}), ...(day ? { day } : {}) });
  const now = { kind: "now", anchor: { date: "2026-09-01", offset: "Z" } };
  const ranges = [
    [relative("9999", "yi"), relative("138", "yi")], [relative("138.0", "yi"), relative("35.0", "yi")],
    [relative("35.0", "yi"), relative("31.5", "wan")], [relative("31.5", "wan"), century(8, "BC")],
    [century(8, "BC"), century(3, "BC")], [century(3, "BC"), century(20)], [century(18), century(20)],
    [{ kind: "decade", era: "AD", index: 191 }, { kind: "decade", era: "AD", index: 199 }],
    [{ kind: "decade", era: "AD", index: 194 }, now], [calendar(2017, 6, 12), now],
    [now, calendar(9999)], [calendar(9999), relative("1", "zheng", "after")]
  ];
  const terran = [
    ["无论何时", { kind: "whenever" }], ["不知何时", { kind: "unknown" }], ["无限久前", { kind: "infinite_past" }],
    ["大爆炸前", null], ["宇宙诞生", null], ["生命起源", null], ["史前文明", null], ["轴心时代", null], ["帝国兴亡", null], ["工业革命", null], ["硝烟铁幕", null], ["现代社会", null], ["智能初晓", null], ["展望未来", null], ["万年之后", null], ["无限久后", { kind: "infinite_future" }]
  ].map(([name, endpoint], index) => ({ node: `tn_fixture_${index + 1}`, kind: endpoint ? "special" : "range", name, ...(endpoint ? { endpoint } : { range: { start: ranges[index - 3][0], end: ranges[index - 3][1] } }), builtin: true, editable: !endpoint }));
  const sovereign = empty ? [] : [
    { node: "tn_fixture_v1", kind: "timeline", name: "星河纪元", author: "晨星", version: "1.2", current: true, edited_at: "2026-09-01T10:00:00.000Z", editable: true },
    { node: "tn_fixture_t1", kind: "single", name: "初见", edited_at: "2026-08-31T10:00:00.000Z", editable: true },
    { node: "tn_fixture_t2", kind: "periodic", name: "月相", count: 12, edited_at: "2026-08-30T10:00:00.000Z", editable: true }
  ];
  return {
    route: "tr_fixture", revision: 5, library_revision: 8, edited_at: "2026-09-01T10:00:00.000Z",
    terran: { name: "采云此地时间轴", version: "1.0", root: { node: "tn_fixture_root", kind: "timeline", name: "采云此地时间轴", builtin: true }, items: terran },
    sovereign: { items: sovereign, total: sovereign.length }
  };
}

export function mountTimeCover(options) {
  const fragment = options.template.content.cloneNode(true);
  const layer = fragment.querySelector("[data-time-cover-layer]");
  const dialog = layer.querySelector("[data-time-cover-dialog]");
  const controller = new AbortController();
  let model = structuredClone(options.model);
  let language = options.state.language === "en" ? "en" : "zh-CN";
  let text = setCopies(layer, language);
  let terranRows = model.terran.items;
  let sovereignRows = model.sovereign.items;
  let sortDraft = null;
  let sortBusy = false;
  let terranAtRoot = true;
  let sovereignAtRoot = true;
  let terranHeading = "";
  let sovereignHeading = "";
  const bankRequests = { terran: 0, sovereign: 0 };

  layer.querySelector("[data-time-terran-version]").textContent = `${model.terran.name} V${model.terran.version}`;

  const openChildren = async (bank, row) => {
    const ordinal = ++bankRequests[bank];
    const result = await options.children(model.route, row.node);
    if (controller.signal.aborted || ordinal !== bankRequests[bank]) return;
    if (bank === "terran") { terranRows = result.items; terranAtRoot = row.node === model.terran.root.node; terranHeading = row.name; }
    else { sovereignRows = result.items; sovereignAtRoot = false; sovereignHeading = row.name; }
    render();
  };
  const actionOptions = (bank) => ({
    language, copy: text,
    sorting: bank === "sovereign" && sortDraft !== null, busy: sortBusy,
    onMove: (from, to) => {
      if (sortBusy || !sortDraft || to < 0 || to >= sortDraft.length || from === to) return;
      const [item] = sortDraft.splice(from, 1); sortDraft.splice(to, 0, item); render();
      layer.querySelector("[data-time-sovereign-list]").children[to]?.querySelector("button")?.focus();
    },
    empty: bank === "sovereign" && sovereignAtRoot ? text.empty : text.noChildren,
    onOpen: (row) => openChildren(bank, row).catch(options.onError),
    onEdit: (row) => options.onEdit?.(row),
    onRestore: (row) => options.onRestore?.(row),
    onDelete: (row) => options.onDelete?.(row)
  });
  const render = () => {
    renderRows(layer.querySelector("[data-time-terran-list]"), terranRows, actionOptions("terran"));
    renderRows(layer.querySelector("[data-time-sovereign-list]"), sortDraft ?? sovereignRows, actionOptions("sovereign"));
    layer.querySelector("[data-time-bank-top='terran']").disabled = terranAtRoot;
    layer.querySelector("[data-time-bank-top='sovereign']").disabled = sovereignAtRoot || sortBusy;
    layer.querySelector("[data-time-terran-version]").textContent = terranAtRoot ? `${terranLabel(model.terran.name, language)} V${model.terran.version}` : terranLabel(terranHeading, language);
    layer.querySelector("[data-time-sovereign-heading]").textContent = sovereignAtRoot ? text.sovereignVersion : sovereignHeading;
    layer.querySelector("[data-time-sort]").hidden = !sovereignAtRoot || sovereignRows.length < 2 || sortDraft !== null;
    layer.querySelector("[data-time-sort-actions]").hidden = sortDraft === null;
    layer.querySelector("[data-time-sovereign-heading]").hidden = sortDraft !== null;
    for (const button of layer.querySelectorAll("[data-time-sort-confirm], [data-time-sort-cancel], [data-time-return-source], [data-time-create]")) button.disabled = sortBusy;
    const returnLabels = language === "en" ? { "reader-cover": "Return to Reader", archiver: "Return to Archiver", "conversation-info": "Return to Conversation" } : { "reader-cover": "返回阅览室", archiver: "返回档案馆", "conversation-info": "返回对话编辑" };
    layer.querySelector("[data-time-return-source]").textContent = returnLabels[options.returnTo] ?? text.returnSource;
  };

  layer.querySelector("[data-time-bank-top='terran']").addEventListener("click", () => { bankRequests.terran++; terranRows = model.terran.items; terranAtRoot = true; render(); }, { signal: controller.signal });
  layer.querySelector("[data-time-bank-top='sovereign']").addEventListener("click", () => { bankRequests.sovereign++; sovereignRows = model.sovereign.items; sovereignAtRoot = true; render(); }, { signal: controller.signal });
  layer.querySelector("[data-time-sort]").addEventListener("click", () => {
    bankRequests.sovereign++;
    sortDraft = [...model.sovereign.items];
    sovereignAtRoot = true;
    render();
  }, { signal: controller.signal });
  const cancelOrder = () => { if (sortBusy) return; sortDraft = null; render(); };
  layer.querySelector("[data-time-sort-cancel]").addEventListener("click", cancelOrder, { signal: controller.signal });
  layer.querySelector("[data-time-sort-confirm]").addEventListener("click", async () => {
    if (!sortDraft || sortBusy) return;
    sortBusy = true; render();
    try {
      const result = await options.saveOrder({ route: model.route, expected_time_revision: model.revision, expected_library_revision: model.library_revision, nodes: sortDraft.map(row => row.node) });
      if (controller.signal.aborted) return;
      model.revision = result.revision; model.library_revision = result.library_revision;
      model.sovereign.items = result.items; model.sovereign.total = result.items.length;
      sovereignRows = result.items; sortDraft = null;
    } catch (error) { if (!controller.signal.aborted) options.onError?.(error); }
    finally { sortBusy = false; if (!controller.signal.aborted) render(); }
  }, { signal: controller.signal });
  layer.querySelector("[data-time-return-source]").addEventListener("click", () => options.onReturn(model.route), { signal: controller.signal });
  for (const button of layer.querySelectorAll("[data-time-create]")) button.addEventListener("click", () => options.onCreate?.(button.dataset.timeCreate), { signal: controller.signal });
  layer.addEventListener("keydown", (event) => { if (event.key === "Escape" && !sortBusy) { if (sortDraft) cancelOrder(); else options.onReturn(model.route); } }, { signal: controller.signal });
  layer.addEventListener("pointerdown", (event) => { if (event.target === layer && !sortBusy) { if (sortDraft) cancelOrder(); else options.onReturn(model.route); } }, { signal: controller.signal });
  render();
  options.host.append(layer);
  requestAnimationFrame(() => layer.querySelector("[data-time-return-source]").focus());
  return {
    element: layer,
    cleanup() { controller.abort(); layer.remove(); },
    updateState(nextState) { language = nextState.language === "en" ? "en" : "zh-CN"; text = setCopies(layer, language); render(); }
  };
}
