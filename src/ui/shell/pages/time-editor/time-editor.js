import { formatTimeRange, mountEndpointEditor, timeInputError } from "/shared/time/endpoint-editor.js";
import { timeNodeAction } from "/shared/time/node-actions.js";
import { terranLabel, terranShortcutNames, timeNodeLabel } from "/shared/time/preset-labels.js";
import { createTimeNodePager } from "/shared/time/paged-nodes.js";
import { bindRecordTextInput, refreshRecordTextInputs } from "/shared/record-text-input.js";

const copies = Object.freeze({
  "zh-CN": {
    terranTitle: "此地时间体系", sovereignTitle: "独立时间体系", returnTop: "返回顶层", returnEditor: "返回内容时间", sovereignVersion: "时间与时间轴列表",
    editTimeline: "编辑时间轴", editTime: "编辑时间", newTimeline: "新建时间轴", newTime: "新建时间", timelineName: "时间轴名字", author: "作者", standardName: "标准名称", version: "版本 V___.___",
    timeName: "时间名字", single: "单独时间", periodic: "周期时间", prefix: "前缀", count: "周期数", unit: "单位", displayEmpty: "展开全部空周期（仅周期数20以下）",
    references: "引用此时间的对话", cancelAll: "取消全部引用", cancelReference: "取消引用", restoreReference: "保留引用", noReferences: "没有当前对话引用。",
    mappings: "映射此地时间", addMapping: "添加此地时间映射", noMappings: "没有直接此地时间映射。", edit: "编辑", remove: "删除",
    counterparts: "对映的时间与时间轴", addCounterpart: "添加对映时间与时间轴", noCounterparts: "没有直接对映。",
    children: "包含时间与子时间轴", addChild: "添加包含时间与子时间轴", noChildren: "没有直接子节点。", moveUp: "上移", moveDown: "下移",
    save: "保存", cancel: "取消", delete: "删除", confirm: "确认", impactTitle: "确认时间系统修改", allReferences: "同步全部引用", selectedReferences: "建立独立副本，只同步选中引用", futureOnly: "保留原节点，另建独立副本",
    invalidSelectors: "周期变化会使现有选择失效，当前不能保存。", externalLinks: "存在跨时间轴的直接关系。", noChange: "内容没有变化。是否只更新时间戳与时间锚点？", update: "更新", noWrite: "否，零写返回",
    discardTitle: "放弃尚未保存的修改？", discard: "放弃修改", stay: "继续编辑", saving: "正在保存…", saved: "已保存", conflict: "时间系统已经改变，请刷新后重试。",
    searchNode: "搜索时间/时间轴", addSelected: "添加选中节点", selectNode: "选择一个节点", presetRange: "此地时间范围", restoreDefault: "恢复默认", currentRange: "当前范围"
  },
  en: {
    terranTitle: "Terran Time", sovereignTitle: "Sovereign Time", returnTop: "Return to top", returnEditor: "Return to Content Time", sovereignVersion: "Timeline and time list",
    editTimeline: "Edit Timeline", editTime: "Edit Time", newTimeline: "New Timeline", newTime: "New Time", timelineName: "Timeline name", author: "Author", standardName: "Standard name", version: "Version V___.___",
    timeName: "Time name", single: "Single", periodic: "Periodic", prefix: "Prefix", count: "Count", unit: "Unit", displayEmpty: "Expand empty occurrences (count 20 or less)",
    references: "Referencing conversations", cancelAll: "Cancel all references", cancelReference: "Cancel reference", restoreReference: "Keep reference", noReferences: "No current conversation references.",
    mappings: "Terran mappings", addMapping: "Add Terran mapping", noMappings: "No direct Terran mapping.", edit: "Edit", remove: "Remove",
    counterparts: "Counterpart times and timelines", addCounterpart: "Add counterpart", noCounterparts: "No direct counterpart.",
    children: "Contained times and child timelines", addChild: "Add child", noChildren: "No direct child.", moveUp: "Move up", moveDown: "Move down",
    save: "Save", cancel: "Cancel", delete: "Delete", confirm: "Confirm", impactTitle: "Confirm Time System change", allReferences: "Sync all references", selectedReferences: "Create an independent copy and sync selected references", futureOnly: "Keep the original and create an independent copy",
    invalidSelectors: "The period change invalidates an existing selector and cannot be saved yet.", externalLinks: "Direct links cross this timeline.", noChange: "Nothing changed. Update only the edited timestamp and time anchors?", update: "Update", noWrite: "No, return without writing",
    discardTitle: "Discard unsaved changes?", discard: "Discard", stay: "Keep editing", saving: "Saving…", saved: "Saved", conflict: "The Time System changed. Refresh and try again.",
    searchNode: "Search time or timeline", addSelected: "Add selected node", selectNode: "Select a node", presetRange: "Terran range", restoreDefault: "Restore default", currentRange: "Current range"
  }
});

export const timeEditorPreload = Object.freeze([
  "/assets/editor/ContentTimeTitleBack-Dawn.svg", "/assets/editor/ContentTimeTitleBack-StarNight.svg",
  "/assets/editor/TimeLOGO-Terran.svg", "/assets/editor/TimeLOGO-Sovereign.svg"
]);

function clone(value) { return structuredClone(value); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function copy(language) { return copies[language] ?? copies["zh-CN"]; }

function setCopies(root, language) {
  const values = copy(language);
  for (const node of root.querySelectorAll("[data-time-editor-copy]")) node.textContent = values[node.dataset.timeEditorCopy] ?? node.textContent;
  return values;
}

function field(label, value, options = {}) {
  const wrapper = document.createElement("label");
  wrapper.className = "time-editor-field";
  wrapper.dataset.field = options.name;
  const span = document.createElement("span"); span.textContent = label;
  const input = document.createElement("input");
  input.name = options.name;
  input.type = options.type ?? "text";
  input.value = value ?? "";
  input.placeholder = label;
  if (options.required) input.required = true;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.pattern) input.pattern = options.pattern;
  if (["name", "author", "standard_name", "prefix", "unit"].includes(options.name)) bindRecordTextInput(input);
  wrapper.append(span, input);
  return wrapper;
}

function button(copyText, action, className = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = copyText;
  node.dataset.timeEditorAction = action;
  node.className = className;
  return node;
}

function versionField(value, language) {
  const hint = language === "en" ? "Version: major.minor, each from 0 to 999; for example 1.0" : "版本格式：主版本.次版本，每段0—999，例如1.0";
  const wrapper = field(language === "en" ? "Version" : "版本", value, { name: "version", pattern: "(?:0|[1-9][0-9]{0,2})\\.(?:0|[1-9][0-9]{0,2})" });
  const input = wrapper.querySelector("input");
  const frame = document.createElement("div"); frame.className = "time-editor-version";
  const prefix = document.createElement("span"); prefix.textContent = "V"; prefix.setAttribute("aria-hidden", "true");
  input.placeholder = "1.0"; input.maxLength = 7; input.inputMode = "decimal"; input.title = hint;
  const validate = () => input.setCustomValidity(input.value && !/^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/u.test(input.value) ? hint : "");
  input.addEventListener("beforeinput", (event) => {
    if (!event.data || event.isComposing || !event.inputType.startsWith("insert")) return;
    const next = input.value.slice(0, input.selectionStart ?? input.value.length) + event.data + input.value.slice(input.selectionEnd ?? input.value.length);
    if (!/^\d{0,3}(?:\.\d{0,3})?$/u.test(next)) event.preventDefault();
  });
  input.addEventListener("input", validate); validate();
  frame.append(prefix, input); wrapper.append(frame);
  return wrapper;
}

function displaySummary(row, language) {
  const endpoint = row.endpoint ?? (!row.range?.end ? row.range?.start : undefined);
  const description = ({ "zh-CN": { whenever: "跨越时间的意义", unknown: "某时某刻", infinite_past: "一切之前", infinite_future: "一切之后" }, en: { whenever: "Meaning across time", unknown: "Some moment", infinite_past: "Before everything", infinite_future: "After everything" } }[language] ?? {})[endpoint?.kind];
  if (description) return description;
  if (row.range) return formatTimeRange(row.range, language, true);
  if (row.kind === "timeline") { const metadata = [row.author, row.version ? `V${row.version}` : ""].filter(Boolean); return metadata.length ? `· ${metadata.join(" · ")}` : ""; }
  if (row.kind === "periodic") return `${row.count} × ${row.unit ?? ""}`;
  return "";
}

function occurrenceSummary(value, language) {
  if (!value) return "";
  return value.all ? (language === "en" ? "all occurrences" : "全部周期")
    : language === "en" ? `first ${value.first}, step ${value.step}, last ${value.last}` : `首序${value.first} · 间隔${value.step} · 尾序${value.last}`;
}

function sourceOccurrences(host, count, name, initial, language, signal) {
  host.className = "time-editor-node-picker"; host.dataset.sourceOccurrences = "";
  const row = document.createElement("div"); row.className = "time-editor-periodic-selection";
  const caption = document.createElement("span"); caption.textContent = language === "en" ? `This node: ${name} · ${count} occurrences` : `本节点：${name} · 周期数 ${count}`;
  const inputs = document.createElement("div"); inputs.className = "time-editor-periodic-inputs"; inputs.hidden = !initial || initial.all === true;
  row.append(caption);
  for (const [mode, label] of [["all", language === "en" ? "All occurrences" : "映射全部周期"], ["partial", language === "en" ? "Some occurrences" : "映射部分周期"]]) {
    const choice = document.createElement("label"); choice.className = "cloudig-choice";
    const radio = document.createElement("input"); radio.type = "radio"; radio.name = "source-occurrences"; radio.value = mode; radio.checked = (mode === "all") === inputs.hidden;
    const text = document.createElement("span"); text.textContent = label; choice.append(radio, text); row.append(choice);
    radio.addEventListener("change", () => { inputs.hidden = mode === "all"; }, { signal });
  }
  for (const [key, label] of [["first", language === "en" ? "First" : "首序"], ["step", language === "en" ? "Step" : "间隔"], ["last", language === "en" ? "Last" : "尾序"]]) inputs.append(field(label, initial?.[key] ?? "", { name: `source-${key}`, type: "number", min: 1, max: count }));
  row.append(inputs); host.append(row);
  return { read() {
    if (host.querySelector("[value='all']").checked) return { all: true };
    const read = key => Number(host.querySelector(`[name='source-${key}']`).value), first = read("first"), step = read("step"), last = read("last");
    if (![first, step, last].every(Number.isSafeInteger) || first < 1 || step < 1 || last < first || last > count || (last - first) % step !== 0) throw new Error(language === "en" ? "The source occurrence range must stay inside this node and end on a whole step." : "本节点的首序、间隔、尾序须为正整数，尾序须整步到达且不得超出周期数。");
    return { first, step, last };
  } };
}

function renderBank(host, rows, language, onOpen, onDelete) {
  host.replaceChildren();
  for (const row of rows) {
    const item = document.createElement("article");
    item.className = "time-editor-bank-row";
    const body = document.createElement("button");
    body.type = "button";
    body.className = "time-editor-bank-row-body";
    const name = document.createElement("strong"); name.textContent = timeNodeLabel(row, language);
    const summary = document.createElement("span"); summary.textContent = displaySummary(row, language);
    body.title = [name.textContent, summary.textContent].filter(Boolean).join("：");
    body.append(name, summary);
    body.addEventListener("click", () => onOpen(row));
    item.append(body);
    if (onDelete && row.builtin !== true) {
      const remove = timeNodeAction(language === "en" ? "Delete" : "删除", "delete", () => onDelete(row));
      remove.className = "time-editor-bank-delete";
      item.append(remove);
    }
    host.append(item);
  }
}

export function visualTimeEditorFixture(kind = "timeline", action = "edit") {
  const node = kind === "timeline" ? "tn_fixture_v1" : "tn_fixture_t1";
  if (action === "create_timeline") {
    return {
      action, time_revision: 5, library_revision: 8, node_revision: 5,
      metadata: { kind: "timeline", name: "", author: "", standard_name: null, version: "1.0" },
      children: [], counterparts: [], mappings: [], references: []
    };
  }
  if (action === "create_time") {
    return {
      action, time_revision: 5, library_revision: 8, node_revision: 2,
      metadata: { kind: "single", name: "" }, children: [], counterparts: [], mappings: [], references: []
    };
  }
  return {
    action: "edit", time_revision: 5, library_revision: 8, node_revision: 2, node,
    metadata: kind === "timeline"
      ? { kind: "timeline", name: "星河纪元", author: "晨星", standard_name: null, version: "1.2" }
      : { kind: "periodic", name: "月相", count: 12, prefix: "第", unit: "月", display_empty: true },
    created_at: "2026-08-30T10:00:00.000Z", edited_at: "2026-09-01T12:00:00.000Z",
    children: kind === "timeline" ? [{ node: "tn_fixture_t1", display: { name: "初见", kind: "single" } }, { node: "tn_fixture_t2", count: 12, display: { name: "月相", kind: "periodic", count: 12 } }] : [],
    counterparts: kind === "timeline" ? [] : [{ target: { node: "tn_fixture_v1", display: { name: "星河纪元", kind: "timeline" } } }],
    mappings: [{ range: { start: { kind: "calendar", era: "AD", year: 2024, month: 11, day: 4 }, end: { kind: "calendar", era: "AD", year: 2026, month: 8, day: 23 } } }],
    references: [{ reference: "ta_fixture_1", title: "会话名字1", endpoints: ["start"] }]
  };
}

export function mountTimeEditor(options) {
  const fragment = options.template.content.cloneNode(true);
  const layer = fragment.querySelector("[data-time-editor-layer]");
  const dialog = layer.querySelector("[data-time-editor-dialog]");
  const controller = new AbortController();
  let language = options.state.language === "en" ? "en" : "zh-CN";
  let values = setCopies(layer, language);
  let model = clone(options.model);
  let draft = {
    metadata: clone(model.metadata),
    children: clone(model.children ?? []),
    counterparts: clone(model.counterparts ?? []),
    mappings: clone(model.mappings ?? [])
  };
  if (model.restore_default_time) draft.restore_default_time = true;
  const initial = clone(draft);
  const cancelledReferences = new Set();
  let activeInline = null;
  let busy = false;
  let childOrderBefore = null;
  let sovereignSort = "edited_desc";
  let requestOpenNode = (row) => options.onOpenNode?.(row);
  let requestDeleteNode = (row) => options.onDelete?.(row);

  const status = layer.querySelector("[data-time-editor-status]");
  const body = layer.querySelector("[data-time-editor-body]");
  const inline = layer.querySelector("[data-time-editor-inline]");
  const metadataHost = layer.querySelector("[data-time-editor-metadata]");
  const dirty = () => !equal(draft, initial) || cancelledReferences.size > 0;
  const priorDisabled = new Map();
  const setBusy = (value) => { busy = value; dialog.dataset.busy = String(value); for (const node of dialog.querySelectorAll("button, input, select")) { if (value) { if (!priorDisabled.has(node)) priorDisabled.set(node, node.disabled); node.disabled = true; } else node.disabled = priorDisabled.get(node) ?? false; } if (!value) priorDisabled.clear(); };

  const renderTerranVersion = () => { layer.querySelector("[data-time-editor-terran-version]").textContent = `${terranLabel(options.cover.terran.name, language)} V${options.cover.terran.version}`; };
  renderTerranVersion();
  let sovereignRows = options.cover.sovereign.items;
  const renderTerranBank = () => renderBank(layer.querySelector("[data-time-editor-terran-list]"), options.cover.terran.items, language, (row) => requestOpenNode(row));
  const renderSovereignBank = (rows) => {
    sovereignRows = rows;
    renderBank(layer.querySelector("[data-time-editor-sovereign-list]"), rows, language, (row) => requestOpenNode(row), (row) => requestDeleteNode(row));
  };
  renderTerranBank();
  renderSovereignBank(sovereignRows);
  const bankPager = options.queryNodes ? createTimeNodePager({ host: layer.querySelector("[data-time-editor-sovereign-list]"), query: options.queryNodes, render: renderSovereignBank, onError: error => { status.textContent = error.message; }, signal: controller.signal }) : null;
  bankPager?.refresh({ search: "", sort: sovereignSort });

  const closeInline = () => { activeInline?.cleanup?.(); activeInline = null; inline.hidden = true; inline.replaceChildren(); };

  const renderMetadata = () => {
    metadataHost.replaceChildren();
    const title = layer.querySelector("[data-time-editor-title]");
    if (model.action === "create_timeline") title.textContent = values.newTimeline;
    else if (model.action === "create_time") title.textContent = values.newTime;
    else title.textContent = draft.metadata.kind === "timeline" ? values.editTimeline : values.editTime;
    layer.querySelector("[data-time-editor-save]").textContent = language === "en" ? `Save ${draft.metadata.kind === "timeline" ? "Timeline" : "Time"}` : `保存${draft.metadata.kind === "timeline" ? "时间轴" : "时间"}`;
    const grid = document.createElement("div"); grid.className = "time-editor-field-grid"; grid.dataset.kind = draft.metadata.kind;
    if (draft.metadata.kind === "timeline") {
      grid.append(
        field(values.timelineName, draft.metadata.name, { name: "name", required: true }),
        field(values.author, draft.metadata.author, { name: "author", required: true }),
        versionField(draft.metadata.version, language)
      );
      if (draft.metadata.standard_name) grid.append(field(values.standardName, draft.metadata.standard_name, { name: "standard_name" }));
    } else {
      const kinds = document.createElement("div"); kinds.className = "time-editor-kind-choice";
      const kindLabel = document.createElement("span"); kindLabel.textContent = language === "en" ? "Time type" : "时间类型"; kinds.append(kindLabel);
      for (const [kind, label] of [["single", values.single], ["periodic", values.periodic]]) {
        const choice = button(label, `kind-${kind}`); choice.setAttribute("aria-pressed", String(draft.metadata.kind === kind)); kinds.append(choice);
      }
      if (!model.builtin) metadataHost.append(kinds);
      grid.append(field(values.timeName, draft.metadata.name, { name: "name", required: true }));
      if (draft.metadata.kind === "periodic") {
        grid.append(
          field(values.prefix, draft.metadata.prefix, { name: "prefix" }),
          field(values.count, draft.metadata.count, { name: "count", type: "number", required: true, min: 1, max: 99999999 }),
          field(values.unit, draft.metadata.unit, { name: "unit" })
        );
        for (const expanded of [false, true]) {
          const display = document.createElement("label"); display.className = "time-editor-checkbox cloudig-choice";
          const radio = document.createElement("input"); radio.type = "radio"; radio.name = "display_empty"; radio.value = String(expanded); radio.checked = (draft.metadata.display_empty === true) === expanded; radio.disabled = expanded && draft.metadata.count > 20;
          const displayCopy = document.createElement("span"); displayCopy.textContent = expanded ? values.displayEmpty : language === "en" ? "Fold occurrences without mappings" : "折叠没有被单独时间与时间轴映射的周期";
          display.append(radio, displayCopy); grid.append(display);
        }
      }
    }
    metadataHost.append(grid);
    if (model.can_restore) { const restore = button(values.restoreDefault, "restore-preset"); restore.setAttribute("aria-pressed", String(draft.restore_default_time === true)); metadataHost.append(restore); }
  };

  const readMetadata = () => {
    const read = (name) => metadataHost.querySelector(`[name='${name}']`)?.value ?? "";
    if (draft.metadata.kind === "timeline") {
      const standardInput = metadataHost.querySelector("[name='standard_name']");
      draft.metadata = { kind: "timeline", name: read("name"), author: read("author"), standard_name: standardInput ? standardInput.value || null : draft.metadata.standard_name ?? null, version: read("version") || null };
    } else if (draft.metadata.kind === "periodic") {
      draft.metadata = { kind: "periodic", name: read("name"), count: Number(read("count")), prefix: read("prefix") || null, unit: read("unit") || null, display_empty: metadataHost.querySelector("[name='display_empty']:checked")?.value === "true" };
    } else draft.metadata = { kind: "single", name: read("name") };
  };

  const listEmpty = (host, message) => { const empty = document.createElement("p"); empty.className = "time-editor-empty"; empty.textContent = message; host.append(empty); };
  const renderReferences = () => {
    const host = layer.querySelector("[data-time-editor-references]"); host.replaceChildren();
    if (!(model.references?.length)) { listEmpty(host, values.noReferences); return; }
    for (const reference of model.references) {
      const row = document.createElement("div"); row.className = "time-editor-list-row"; row.dataset.cancelled = String(cancelledReferences.has(reference.reference));
      const title = document.createElement("strong"); title.textContent = reference.title;
      const action = button(cancelledReferences.has(reference.reference) ? values.restoreReference : values.cancelReference, "toggle-reference"); action.dataset.reference = reference.reference;
      row.append(title, action); host.append(row);
    }
  };
  const renderMappings = () => {
    const host = layer.querySelector("[data-time-editor-mappings]"); host.replaceChildren();
    if (!draft.mappings.length) { listEmpty(host, values.noMappings); return; }
    draft.mappings.forEach((mapping, index) => {
      const row = document.createElement("div"); row.className = "time-editor-mapping-pill";
      const title = document.createElement("strong"); title.textContent = [mapping.occurrences ? occurrenceSummary(mapping.occurrences, language) : "", formatTimeRange(mapping.range, language)].filter(Boolean).join(" → ");
      title.title = title.textContent;
      const actions = document.createElement("span"); actions.className = "time-editor-pill-actions";
      const edit = timeNodeAction(values.edit, "edit"); edit.dataset.timeEditorAction = `edit-mapping:${index}`;
      const remove = timeNodeAction(values.remove, "delete"); remove.dataset.timeEditorAction = `remove-mapping:${index}`;
      actions.append(edit, remove); row.append(title, actions); host.append(row);
    });
  };
  const renderRelations = (kind) => {
    const valuesList = kind === "counterpart" ? draft.counterparts : draft.children;
    const host = layer.querySelector(kind === "counterpart" ? "[data-time-editor-counterparts]" : "[data-time-editor-children]"); host.replaceChildren();
    if (kind === "child") {
      layer.querySelector("[data-time-editor-sort-children]").hidden = !!childOrderBefore || valuesList.length < 2;
      layer.querySelector("[data-time-editor-sort-children]").textContent = language === "en" ? "Sort" : "排序";
      layer.querySelector("[data-time-editor-order-confirm]").hidden = !childOrderBefore;
      layer.querySelector("[data-time-editor-order-cancel]").hidden = !childOrderBefore;
    }
    if (!valuesList.length) { listEmpty(host, kind === "counterpart" ? values.noCounterparts : values.noChildren); return; }
    valuesList.forEach((entry, index) => {
      const target = kind === "counterpart" ? entry.target : entry;
      const row = document.createElement("div"); row.className = kind === "child" ? "time-editor-child-row" : "time-editor-node-pill";
      const pill = kind === "child" ? document.createElement("div") : row; if (kind === "child") pill.className = "time-editor-node-pill";
      const title = document.createElement("strong"); title.textContent = [kind === "counterpart" && entry.self_occurrences ? occurrenceSummary(entry.self_occurrences, language) : "", [target.display?.name ?? values.selectNode, target.occurrences ? occurrenceSummary(target.occurrences, language) : ""].filter(Boolean).join(" · ")].filter(Boolean).join(" → ");
      title.title = title.textContent;
      const remove = timeNodeAction(values.remove, "delete"); remove.dataset.timeEditorAction = `remove-${kind}:${index}`; remove.className = "time-editor-pill-remove";
      pill.append(title, remove);
      if (kind === "child") {
        const ordinal = document.createElement("span"); ordinal.className = "time-editor-child-ordinal"; ordinal.textContent = String(index + 1).padStart(4, "0");
        row.append(ordinal, pill);
        if (childOrderBefore) {
          const arrows = document.createElement("span"); arrows.className = "time-editor-order-arrows";
          for (const [direction, glyph, label, disabled] of [["up", "↑", values.moveUp, index === 0], ["down", "↓", values.moveDown, index === valuesList.length - 1]]) {
            const move = button(glyph, `move-child-${direction}:${index}`); move.title = label; move.setAttribute("aria-label", label); move.disabled = disabled; arrows.append(move);
          }
          row.append(arrows);
        }
      }
      host.append(row);
    });
  };
  const renderAll = () => { renderMetadata(); renderReferences(); renderMappings(); renderRelations("counterpart"); renderRelations("child"); };

  const openRangeEditor = (index) => {
    readMetadata();
    closeInline(); inline.hidden = false;
    layer.querySelector("[data-time-editor-mappings]").after(inline);
    const initialRange = index === undefined ? undefined : draft.mappings[index].range;
    let sourceSelection;
    activeInline = mountEndpointEditor({
      host: inline, language, anchor: options.anchor, initialRange,
      previewRange: (range) => options.previewRange(range, false),
      onCancel: closeInline,
      onConfirm: (range) => {
        const occurrences = sourceSelection?.read();
        if (draft.mappings.some((mapping, itemIndex) => itemIndex !== index && equal(mapping.range, range))) throw new Error(language === "en" ? "This range is already mapped." : "此时段已经映射，请勿重复添加。");
        delete draft.restore_default_time;
        if (index === undefined) draft.mappings.unshift({ range, ...(occurrences ? { occurrences } : {}) });
        else { const [previous] = draft.mappings.splice(index, 1); draft.mappings.unshift({ ...previous, range, ...(occurrences ? { occurrences } : {}) }); }
        closeInline(); renderAll();
      }
    });
    if (draft.metadata.kind === "periodic") { const host = document.createElement("section"); inline.querySelector("[data-endpoint-editor]").prepend(host); sourceSelection = sourceOccurrences(host, draft.metadata.count, draft.metadata.name, index === undefined ? undefined : draft.mappings[index].occurrences, language, controller.signal); }
    inline.scrollIntoView({ block: "nearest" });
  };

  const openNodePicker = async (kind) => {
    readMetadata();
    closeInline(); inline.hidden = false;
    layer.querySelector(kind === "counterpart" ? "[data-time-editor-counterparts]" : "[data-time-editor-children]").after(inline);
    const section = document.createElement("section"); section.className = "time-editor-node-picker";
    const search = document.createElement("input"); search.type = "search"; search.placeholder = values.searchNode;
    const presets = document.createElement("div"); presets.className = "time-editor-preset-tags";
    const selection = document.createElement("div"); selection.className = "time-editor-node-selection"; selection.hidden = true;
    const selectionName = document.createElement("span"); selectionName.className = "time-editor-selected-name";
    const confirm = button(language === "en" ? kind === "child" ? "Confirm child" : "Confirm counterpart" : kind === "child" ? "确认包含" : "确认对映", "confirm-node", "cloudig-button cloudig-button-filled");
    const periodic = document.createElement("div"); periodic.className = "time-editor-periodic-selection"; periodic.hidden = true;
    const list = document.createElement("div"); list.className = "time-editor-node-results"; list.dataset.scrollRegion = "";
    const error = document.createElement("p"); error.className = "time-editor-picker-error"; error.hidden = true; error.setAttribute("role", "alert");
    const cancel = button(values.cancel, "cancel-node", "time-editor-picker-cancel");
    selection.append(selectionName, confirm);
    section.append(search, presets, selection, periodic, error, list, cancel); inline.append(section);
    let sourceSelection;
    if (kind === "counterpart" && draft.metadata.kind === "periodic") { const host = document.createElement("section"); periodic.after(host); sourceSelection = sourceOccurrences(host, draft.metadata.count, draft.metadata.name, undefined, language, controller.signal); }
    let selected = null, disposed = false;
    const occurrenceValues = () => {
      if (selected?.kind !== "periodic") return undefined;
      const read = name => Number(periodic.querySelector('[name="' + name + '"]')?.value);
      if (kind === "child") {
        const count = read("prefix-count");
        if (!Number.isSafeInteger(count) || count < 1 || count > selected.count) throw new Error(language === "en" ? "The contained count must be between 1 and the period count." : "包含周期数必须为 1 至该节点周期数之间的整数。");
        return { count };
      }
      if (periodic.querySelector("[value='all']")?.checked) return { all: true };
      const first = read("first"), step = read("step"), last = read("last");
      if (![first, step, last].every(Number.isSafeInteger) || first < 1 || step < 1 || last < first || last > selected.count || (last - first) % step !== 0) throw new Error(language === "en" ? "Use positive integers; the last occurrence must be reached from the first in whole steps and stay within the period." : "首序、间隔、尾序须为正整数；尾序须由首序按间隔整步到达，且不得超出周期数。");
      return { first, step, last };
    };
    const choose = row => {
      selected = row; selection.hidden = false; error.hidden = true;
      selectionName.textContent = (language === "en" ? "Selected: " : "已选") + row.name; selectionName.title = selectionName.textContent;
      for (const node of section.querySelectorAll("[data-pick-node]")) node.setAttribute("aria-pressed", String(node.dataset.pickNode === row.node));
      periodic.replaceChildren(); periodic.hidden = row.kind !== "periodic";
      if (row.kind !== "periodic") return;
      const count = document.createElement("span"); count.textContent = (language === "en" ? "Target period count: " : "目标周期数：") + row.count; periodic.append(count);
      if (kind === "child") { periodic.append(field(language === "en" ? "Contained count" : "包含周期数", "", { name: "prefix-count", type: "number", min: 1, max: row.count, required: true })); return; }
      const inputs = document.createElement("div"); inputs.className = "time-editor-periodic-inputs"; inputs.hidden = true;
      for (const [mode, label] of [["all", language === "en" ? "All occurrences" : "映射全部周期"], ["partial", language === "en" ? "Some occurrences" : "映射部分周期"]]) {
        const choice = document.createElement("label"); choice.className = "cloudig-choice";
        const radio = document.createElement("input"); radio.type = "radio"; radio.name = "picker-occurrences"; radio.value = mode; radio.checked = mode === "all";
        const caption = document.createElement("span"); caption.textContent = label; choice.append(radio, caption);
        radio.addEventListener("change", () => { inputs.hidden = mode === "all"; error.hidden = true; }, { signal: controller.signal }); periodic.append(choice);
      }
      for (const [name, label] of [["first", language === "en" ? "First" : "首序"], ["step", language === "en" ? "Step" : "间隔"], ["last", language === "en" ? "Last" : "尾序"]]) inputs.append(field(label, "", { name, type: "number", min: 1, max: row.count, required: true }));
      periodic.append(inputs);
    };
    for (const row of options.cover.terran.items.filter(entry => entry.shortcut ?? terranShortcutNames.includes(entry.name))) {
      const preset = button(terranLabel(row.name, language), "preset-node"); preset.dataset.pickNode = row.node;
      preset.addEventListener("click", () => choose(row), { signal: controller.signal }); presets.append(preset);
    }
    const pager = createTimeNodePager({ host: list, query: options.queryNodes, signal: controller.signal, onError: problem => { error.hidden = false; error.textContent = problem.message; }, render: rows => {
      if (disposed) return;
      list.replaceChildren();
      const term = search.value.trim().toLocaleLowerCase();
      const terranRows = options.cover.terran.items.filter(row => [row.name, timeNodeLabel(row, language)].some(name => name.toLocaleLowerCase().includes(term)));
      for (const row of [...terranRows, ...rows]) {
        const choice = document.createElement("button"); choice.type = "button"; choice.dataset.pickNode = row.node;
        const name = document.createElement("span"); name.textContent = timeNodeLabel(row, language);
        const summary = document.createElement("small"); summary.textContent = displaySummary(row, language);
        choice.append(name, summary); choice.setAttribute("aria-pressed", String(selected?.node === row.node));
        choice.addEventListener("click", () => choose(row), { signal: controller.signal }); list.append(choice);
      }
    } });
    const query = () => pager.refresh({ search: search.value, sort: "edited_desc" });
    activeInline = { cleanup() { disposed = true; pager.dispose(); } };
    search.addEventListener("input", query, { signal: controller.signal });
    cancel.addEventListener("click", closeInline, { signal: controller.signal });
    confirm.addEventListener("click", () => {
      if (!selected) return;
      try {
        const occurrences = occurrenceValues();
        const display = { name: selected.name, kind: selected.kind, ...(selected.count ? { count: selected.count } : {}) };
        const target = { node: selected.node, ...(occurrences ? kind === "child" ? { count: occurrences.count } : { occurrences } : {}), display };
        if (kind === "counterpart") { const own = sourceSelection?.read(); draft.counterparts.unshift({ target, ...(own ? { self_occurrences: own } : {}) }); }
        else draft.children.unshift(target);
        closeInline(); renderAll();
      } catch (problem) { error.hidden = false; error.textContent = problem.message; }
    }, { signal: controller.signal });
    await query();
    if (!disposed) inline.scrollIntoView({ block: "start" });
  };

  const choiceDialog = (title, build, confirmCopy = values.confirm) => new Promise((resolve) => {
    const modal = layer.querySelector("[data-time-editor-impact]"); const content = modal.querySelector("[data-time-editor-impact-body]");
    modal.querySelector("h2").textContent = title; content.replaceChildren(); build(content);
    modal.hidden = false; const yes = modal.querySelector("[data-time-impact-confirm]"); const no = modal.querySelector("[data-time-impact-cancel]"); yes.textContent = confirmCopy;
    // The form is intentionally locked while previewing/committing, but the
    // decision dialog belongs to that operation and must remain actionable.
    yes.disabled = false; no.disabled = false;
    const finish = (value) => { modal.hidden = true; yes.onclick = null; no.onclick = null; resolve(value); };
    yes.onclick = () => finish(true); no.onclick = () => finish(false); yes.focus();
  });

  const confirmDiscard = async () => {
    readMetadata();
    if (!dirty()) return true;
    return choiceDialog(values.discardTitle, (host) => {
      const p = document.createElement("p");
      p.textContent = values.discardTitle;
      host.append(p);
    }, values.discard);
  };
  requestOpenNode = async (row) => {
    if (busy || !(await confirmDiscard())) return;
    options.onOpenNode?.(row);
  };
  requestDeleteNode = (row) => { if (!busy) options.onDelete?.(row); };

  const commitWithScope = async (payload) => {
    if (["selected_references", "future_only"].includes(payload.strategy)) {
      const preview = await options.previewSelection({ ...payload, offset: 0, limit: 100 });
      if (preview.copy_count) {
        const confirmed = await choiceDialog(language === "en" ? "Confirm independent copies" : "确认独立副本范围", host => {
          const summary = document.createElement("p"); summary.textContent = language === "en"
            ? `Create ${preview.copy_count} independent nodes; update ${preview.updated_count} conversations; cancel ${preview.cancelled_count} references. Original nodes and unselected snapshots stay unchanged.`
            : `新建 ${preview.copy_count} 个独立节点；更新 ${preview.updated_count} 篇对话；取消 ${preview.cancelled_count} 篇引用。原节点和未选中的快照保持不变。`;
          const copies = document.createElement("ul"), references = document.createElement("ul"), more = button(language === "en" ? "Show more" : "显示更多", "scope-more", "cloudig-button cloudig-button-outline");
          let offset = 0;
          const append = page => {
            for (const value of page.copies) { const row = document.createElement("li"); row.textContent = value.name; copies.append(row); }
            for (const value of page.references) { const row = document.createElement("li"); row.textContent = value.title; references.append(row); }
            offset = page.offset + page.limit; more.hidden = offset >= Math.max(preview.copy_count, preview.updated_count);
          };
          more.addEventListener("click", async () => { more.disabled = true; try { const page = await options.previewSelection({ ...payload, offset, limit: 100 }); if (!controller.signal.aborted && more.isConnected) append(page); } catch (error) { status.textContent = timeInputError(error, language); } finally { more.disabled = false; } }, { signal: controller.signal });
          const copyTitle = document.createElement("strong"), referenceTitle = document.createElement("strong"); copyTitle.textContent = language === "en" ? "New nodes" : "新建节点"; referenceTitle.textContent = language === "en" ? "Updated conversations" : "更新的对话";
          host.append(summary, copyTitle, copies, ...(preview.updated_count ? [referenceTitle, references] : []), more); append(preview);
        }, values.save);
        if (!confirmed) return;
      }
    }
    return options.commit(payload);
  };

  const commitPreview = async (preview) => {
    if (!preview.can_commit) { status.textContent = values.invalidSelectors; return; }
    if (preview.no_change) {
      const touch = await choiceDialog(values.noChange, (host) => { const p = document.createElement("p"); p.textContent = values.noChange; host.append(p); }, values.update);
      if (!touch) { options.onReturn?.(); return; }
      const refreshed = await options.preview({ ...previewPayload(), refresh_anchors: true });
      if (refreshed.no_change) { options.onReturn?.(); return; }
      return commitPreview(refreshed);
    }
    const strategies = preview.impact.strategies;
    if (strategies.length === 1) return commitWithScope({ plan: preview.plan, strategy: strategies[0], selected_references: [], touch_on_noop: false });
    let strategy = strategies.includes("all_references") ? "all_references" : strategies[0];
    const selected = new Set();
    const confirmed = await choiceDialog(values.impactTitle, (host) => {
      if (preview.impact.external_links.length) { const p = document.createElement("p"); p.textContent = values.externalLinks; host.append(p); }
      for (const [value, label] of [["in_place", language === "en" ? "Save in place" : "原位保存"], ["all_references", values.allReferences], ["selected_references", values.selectedReferences], ["future_only", values.futureOnly]].filter(([value]) => strategies.includes(value))) {
        const line = document.createElement("label"); line.className = "cloudig-choice"; const radio = document.createElement("input"); radio.type = "radio"; radio.name = "strategy"; radio.value = value; radio.checked = value === strategy; radio.onchange = () => { strategy = value; }; const copy = document.createElement("span"); copy.textContent = label; line.append(radio, copy); host.append(line);
      }
      for (const reference of preview.impact.affected_references) {
        const line = document.createElement("label"); line.className = "cloudig-choice"; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.onchange = () => checkbox.checked ? selected.add(reference.reference) : selected.delete(reference.reference); const copy = document.createElement("span"); copy.textContent = reference.title; line.append(checkbox, copy); host.append(line);
      }
    });
    if (!confirmed) return;
    if (strategy === "selected_references" && selected.size === 0) { status.textContent = values.selectNode; return; }
    return commitWithScope({ plan: preview.plan, strategy, selected_references: strategy === "selected_references" ? [...selected] : [], touch_on_noop: false });
  };

  metadataHost.addEventListener("click", (event) => {
    const action = event.target.closest("[data-time-editor-action]")?.dataset.timeEditorAction;
    if (!action) return;
    if (action === "restore-preset") { readMetadata(); draft.restore_default_time = true; renderMetadata(); }
    else if (action.startsWith("kind-")) {
      readMetadata(); const kind = action.slice(5); draft.metadata = kind === "periodic" ? { kind, name: draft.metadata.name, count: 1, prefix: null, unit: null, display_empty: false } : { kind, name: draft.metadata.name }; renderMetadata();
    }
  }, { signal: controller.signal });
  metadataHost.addEventListener("input", (event) => {
    if (event.target.name !== "count") return;
    const expand = metadataHost.querySelector("[name='display_empty'][value='true']");
    if (!expand) return;
    expand.disabled = Number(event.target.value) > 20;
    if (expand.disabled && expand.checked) metadataHost.querySelector("[name='display_empty'][value='false']").checked = true;
  }, { signal: controller.signal });
  layer.querySelector("[data-time-editor-sort-children]").addEventListener("click", () => { childOrderBefore = clone(draft.children); renderRelations("child"); }, { signal: controller.signal });
  layer.querySelector("[data-time-editor-order-confirm]").addEventListener("click", () => { childOrderBefore = null; renderRelations("child"); }, { signal: controller.signal });
  layer.querySelector("[data-time-editor-order-cancel]").addEventListener("click", () => { if (childOrderBefore) draft.children = childOrderBefore; childOrderBefore = null; renderRelations("child"); }, { signal: controller.signal });
  const cancelReferences = async (references) => {
    const pending = references.filter(reference => !cancelledReferences.has(reference.reference));
    if (!pending.length) return;
    const accepted = await choiceDialog(values.cancelReference, host => {
      const message = document.createElement("p"); message.textContent = language === "en" ? "The content time of these conversations will be cleared when you save. Continue?" : "保存后，下列对话的内容时间将被清空。是否确认取消引用？"; host.append(message);
      for (const reference of pending) { const title = document.createElement("p"); title.textContent = reference.title; host.append(title); }
    });
    if (accepted) { for (const reference of pending) cancelledReferences.add(reference.reference); renderReferences(); }
  };
  layer.querySelector("[data-time-editor-cancel-all]").addEventListener("click", () => cancelReferences(model.references ?? []), { signal: controller.signal });
  layer.querySelector("[data-time-editor-references]").addEventListener("click", (event) => {
    const action = event.target.closest("[data-reference]"); if (!action) return;
    const value = action.dataset.reference;
    if (cancelledReferences.has(value)) { cancelledReferences.delete(value); renderReferences(); }
    else cancelReferences((model.references ?? []).filter(reference => reference.reference === value));
  }, { signal: controller.signal });
  layer.querySelector("[data-time-editor-add-mapping]").addEventListener("click", () => openRangeEditor(), { signal: controller.signal });
  layer.querySelector("[data-time-editor-add-counterpart]").addEventListener("click", () => openNodePicker("counterpart").catch((error) => { status.textContent = error?.message ?? String(error); }), { signal: controller.signal });
  layer.querySelector("[data-time-editor-add-child]").addEventListener("click", () => openNodePicker("child").catch((error) => { status.textContent = error?.message ?? String(error); }), { signal: controller.signal });
  body.addEventListener("click", (event) => {
    const action = event.target.closest("[data-time-editor-action]")?.dataset.timeEditorAction;
    if (!action) return;
    const [verb, rawIndex] = action.split(":"); const index = Number(rawIndex);
    if (verb === "edit-mapping") openRangeEditor(index);
    else if (verb === "remove-mapping") { draft.mappings.splice(index, 1); renderMappings(); }
    else if (verb === "remove-counterpart") { draft.counterparts.splice(index, 1); renderRelations("counterpart"); }
    else if (verb === "remove-child") { draft.children.splice(index, 1); renderRelations("child"); }
    else if (verb === "move-child-up" && index > 0) { [draft.children[index - 1], draft.children[index]] = [draft.children[index], draft.children[index - 1]]; renderRelations("child"); }
    else if (verb === "move-child-down" && index < draft.children.length - 1) { [draft.children[index + 1], draft.children[index]] = [draft.children[index], draft.children[index + 1]]; renderRelations("child"); }
  }, { signal: controller.signal });

  layer.querySelector("[data-time-editor-sort]").addEventListener("click", () => { sovereignSort = sovereignSort === "edited_desc" ? "edited_asc" : sovereignSort === "edited_asc" ? "title" : "edited_desc"; bankPager?.refresh({ search: "", sort: sovereignSort }); }, { signal: controller.signal });
  const requestClose = async () => {
    if (busy) return;
    if (await confirmDiscard()) options.onReturn?.();
  };
  const previewPayload = () => ({ action: model.action, ...(model.action === "edit" ? { node: model.node } : {}),
    expected_time_revision: model.time_revision, expected_library_revision: model.library_revision, expected_node_revision: model.node_revision, cancel_references: [...cancelledReferences], draft });
  for (const node of layer.querySelectorAll("[data-time-editor-cover]")) node.addEventListener("click", requestClose, { signal: controller.signal });
  layer.querySelector("[data-time-editor-return]").addEventListener("click", requestClose, { signal: controller.signal });
  layer.querySelector("[data-time-editor-cancel]").addEventListener("click", requestClose, { signal: controller.signal });
  dialog.addEventListener("submit", async (event) => {
    event.preventDefault(); if (busy) return;
    closeInline(); readMetadata();
    refreshRecordTextInputs(dialog);
    if (!dialog.reportValidity()) return;
    setBusy(true); status.textContent = values.saving;
    try {
      const preview = await options.preview(previewPayload());
      const result = await commitPreview(preview);
      if (!result) { setBusy(false); return; }
      status.textContent = values.saved; options.onCommitted?.(result);
    } catch (error) { status.textContent = error?.code?.includes("STALE") || error?.code?.includes("CONFLICT") ? values.conflict : timeInputError(error, language); setBusy(false); }
  }, { signal: controller.signal });
  layer.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); requestClose(); } }, { signal: controller.signal });

  renderAll();
  options.host.append(layer);
  requestAnimationFrame(() => { if (!activeInline) metadataHost.querySelector("input")?.focus(); });
  return {
    element: layer,
    cleanup() { controller.abort(); closeInline(); layer.remove(); },
    updateLanguage(next) {
      readMetadata();
      language = next === "en" ? "en" : "zh-CN";
      values = setCopies(layer, language);
      renderTerranVersion();
      activeInline?.updateLanguage?.(language);
      renderTerranBank();
      renderSovereignBank(sovereignRows);
      renderAll();
    }
  };
}
