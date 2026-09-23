import { formatCalendar } from "/Cloudig/shared/time/core-format.js";
import { formatRecordTimeEndpoint } from "/Cloudig/shared/time/record-format.js";

const copies = Object.freeze({
  "zh-CN": {
    start: "起点", end: "终点", same: "同起点", terran: "此地时间", sovereign: "独立时间",
    exact: "精确公历", fuzzy: "模糊公历", relative: "单位年前/后", special: "其他",
    era: "纪元", year: "年", month: "月", day: "日", hour: "时", minute: "分", second: "秒", offset: "时区",
    precision: "精度", decade: "年代", century: "世纪", direction: "方向", before: "前", after: "后", unit: "单位", value: "数值",
    now: "现今", whenever: "无论何时", unknown: "不知何时", infinitePast: "无限久前", infiniteFuture: "无限久后",
    confirm: "确认时段", cancel: "取消编辑", search: "搜索时间/时间轴名字", editedDesc: "修改时间倒序", editedAsc: "修改时间顺序", title: "标题排序",
    empty: "暂无匹配的独立时间。", select: "选择", occurrence: "周期选择", first: "首序", step: "间隔", last: "尾序", addTime: "添加自定义时间",
    invalid: "时间尚未通过校验。", reversed: "起点晚于终点；采云会保留这一反向时间。"
  },
  en: {
    start: "Start", end: "End", same: "Same as start", terran: "Terran", sovereign: "Sovereign",
    exact: "Exact calendar", fuzzy: "Fuzzy calendar", relative: "Years before / after", special: "Other",
    era: "Era", year: "Year", month: "Month", day: "Day", hour: "Hour", minute: "Minute", second: "Second", offset: "Zone",
    precision: "Precision", decade: "Decade", century: "Century", direction: "Direction", before: "Before", after: "After", unit: "Unit", value: "Value",
    now: "Now", whenever: "Whenever", unknown: "Unknown", infinitePast: "Infinite past", infiniteFuture: "Infinite future",
    confirm: "Confirm range", cancel: "Cancel range", search: "Search time or timeline", editedDesc: "Edited newest", editedAsc: "Edited oldest", title: "Title",
    empty: "No matching Sovereign time.", select: "Select", occurrence: "Occurrences", first: "First", step: "Step", last: "Last", addTime: "Add custom time",
    invalid: "The time has not passed validation.", reversed: "Start is later than end. Cloudig will preserve the reversed range."
  }
});

export const timeUnits = Object.freeze(["wan", "yi", "zhao", "jing", "gai", "zi", "rang", "gou", "jian", "zheng"]);
const units = timeUnits;
const unitLabels = Object.freeze({ wan: "万", yi: "亿", zhao: "兆", jing: "京", gai: "垓", zi: "秭", rang: "穰", gou: "沟", jian: "涧", zheng: "正" });
const unitExponents = Object.freeze({ wan: "⁴", yi: "⁸", zhao: "¹²", jing: "¹⁶", gai: "²⁰", zi: "²⁴", rang: "²⁸", gou: "³²", jian: "³⁶", zheng: "⁴⁰" });

function clone(value) { return structuredClone(value); }
function text(language) { return copies[language] ?? copies["zh-CN"]; }

export function formatTimeEndpoint(endpoint, language = "zh-CN", compact = false) {
  if (!endpoint) return "—";
  if (endpoint.kind === "node") return formatRecordTimeEndpoint(endpoint, language);
  if (endpoint.kind === "sovereign") {
    const display = endpoint.display ?? endpoint.snapshot;
    if (display?.target) return formatRecordTimeEndpoint({ kind: "node", target: { occurrences: display.occurrences }, snapshot: { node: display.target, timeline: display.timeline } }, language);
    const timeline = display?.timeline?.name;
    const target = display?.target?.name;
    const occurrence = endpoint.display?.target?.kind === "periodic" ? endpoint.display.target.count : undefined;
    return [timeline, target, occurrence ? `×${occurrence}` : ""].filter(Boolean).join(" · ") || "Sovereign";
  }
  const zh = language !== "en";
  if (endpoint.kind === "calendar") {
    if (!Number.isFinite(endpoint.year)) return zh ? "未设定" : "Not set";
    return formatCalendar(endpoint, language);
  }
  if (endpoint.kind === "decade") return `${endpoint.index * 10}${compact && zh ? "年代" : "s"}${endpoint.era === "BC" ? " BC" : ""}`;
  if (endpoint.kind === "century") return zh ? compact ? `${endpoint.index}世纪${endpoint.era === "BC" ? "BC" : ""}` : `${endpoint.era === "BC" ? "公元前" : "公元"}${endpoint.index}世纪` : `${endpoint.index} century ${endpoint.era}`;
  if (endpoint.kind === "relative") return zh
    ? `${endpoint.value}${unitLabels[endpoint.unit] ?? endpoint.unit}年${endpoint.direction === "before" ? "前" : "后"}`
    : `${endpoint.value} × 10${unitExponents[endpoint.unit] ?? endpoint.unit} years ${endpoint.direction}`;
  const labels = zh
    ? { now: "现今", whenever: "无论何时", unknown: "不知何时", infinite_past: "无限久前", infinite_future: "无限久后" }
    : { now: "Now", whenever: "Whenever", unknown: "Unknown", infinite_past: "Infinite past", infinite_future: "Infinite future" };
  return labels[endpoint.kind] ?? endpoint.kind ?? "—";
}

export function formatTimeRange(range, language = "zh-CN", compact = false) {
  return range?.end === undefined
    ? formatTimeEndpoint(range?.start, language, compact)
    : `${formatTimeEndpoint(range.start, language, compact)} — ${formatTimeEndpoint(range.end, language, compact)}`;
}

function endpointMode(endpoint) {
  if (endpoint?.kind === "relative") return "relative";
  if (["now", "whenever", "unknown", "infinite_past", "infinite_future"].includes(endpoint?.kind)) return "special";
  if (["decade", "century"].includes(endpoint?.kind) || (endpoint?.kind === "calendar" && endpoint.day === undefined)) return "fuzzy";
  return "exact";
}

function calendarPrecision(endpoint) {
  return ["decade", "century"].includes(endpoint?.kind) ? endpoint.kind : endpoint?.month === undefined ? "year" : "month";
}

export function inputField(name, value, label, attributes = {}) {
  const input = document.createElement("input");
  input.dataset.endpointField = name;
  input.value = value ?? "";
  input.type = attributes.type ?? "text";
  input.setAttribute("aria-label", label);
  input.placeholder = attributes.placeholder ?? "____";
  input.autocomplete = "off";
  for (const [key, item] of Object.entries(attributes)) if (key !== "type" && key !== "placeholder") input.setAttribute(key, String(item));
  return input;
}

export function timeZoneSelect(value, language) {
  const select = document.createElement("select");
  select.dataset.endpointField = "offset";
  select.dataset.scrollPicker = "";
  select.className = "cloudig-endpoint-zone";
  select.setAttribute("aria-label", text(language).offset);
  select.title = language === "en" ? "No zone means floating time; your computer's zone is not added." : "不设时区即浮动时间，不会自动套用电脑时区。";
  const option = (key, label) => { const item = document.createElement("option"); item.value = key; item.textContent = label; select.append(item); };
  option("", language === "en" ? "No zone" : "不设时区");
  const zones = new Set();
  for (let minute = -840; minute <= 840; minute += 15) {
    const key = minute === 0 ? "Z" : `${minute < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minute) / 60)).padStart(2, "0")}:${String(Math.abs(minute) % 60).padStart(2, "0")}`;
    zones.add(key);
    option(key, `UTC${key === "Z" ? "+00:00" : key}`);
  }
  // Preserve a previously stored legal minute offset without enabling free typing.
  if (value && !zones.has(value) && /^[+-](?:0\d|1[0-3]):[0-5]\d$/.test(value)) option(value, `UTC${value}`);
  select.value = value === "+00:00" || value === "-00:00" ? "Z" : value ?? "";
  return select;
}

export function tag(label, group, value, selected) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cloudig-endpoint-tag";
  button.dataset.endpointOption = group;
  button.dataset.value = value;
  button.textContent = label;
  button.setAttribute("aria-pressed", String(selected));
  return button;
}

export function timeUnitLabel(unit, language) { return language === "en" ? "10" + unitExponents[unit] : unitLabels[unit]; }

export function timeInputError(error, language = "zh-CN") {
  const zh = language !== "en";
  if (error?.code === "CLOUDIG_TIME_EDITOR_INVALID") return zh ? "时间设置未能保存，请检查节点名称、周期数、直接关系和时间范围。" : "Time settings were not saved. Check the node name, period count, direct relations and time range.";
  if (error?.code === "CLOUDIG_TIME_RECOVERY_REQUIRED") return zh ? "时间保存中断，需要恢复。请重新打开采云并按恢复提示处理，不要反复提交。" : "Time saving was interrupted and needs recovery. Reopen Cloudig and follow the recovery prompt before submitting again.";
  if (error?.code === "CLOUDIG_TIME_RANGE_INVALID") {
    return error.message?.includes("CLOUDIG_TIME_INVALID_CALENDAR_DATE")
      ? (zh ? "这个日期不存在，请检查月份天数和闰年。内容时间尚未保存。" : "This calendar date does not exist. Check the month and leap year. Nothing was saved.")
      : (zh ? "时间格式无效，请检查年份、日期、时分秒及所选时区。内容时间尚未保存。" : "Invalid time. Check the year, date, clock fields and selected UTC offset. Nothing was saved.");
  }
  if (error?.code === "CLOUDIG_COMMAND_FAILED" || /^command failed$/i.test(error?.message ?? "")) return zh ? "时间处理未完成，内容尚未保存。请重新打开编辑界面后重试。" : "The time operation could not finish. Nothing was saved. Reopen the editor and try again.";
  return error?.message || text(language).invalid;
}

// Required-field feedback belongs to confirmation, not every keystroke.
// The backend remains authoritative for the calendar, ranges and persistence.
export function validatePointDraft(endpoint, precision, language = "zh-CN") {
  const zh = language !== "en";
  const reject = (chinese, english) => { throw new Error(zh ? chinese : english); };
  const integer = (value, lower, upper) => Number.isInteger(value) && value >= lower && value <= upper;
  if (["decade", "century"].includes(endpoint.kind)) {
    const upper = endpoint.era === "BC" ? (endpoint.kind === "decade" ? 999 : 99) : (endpoint.kind === "decade" ? 9999999 : 999999);
    if (!integer(endpoint.index, 1, upper)) reject(`请输入1至${upper}的${endpoint.kind === "decade" ? "年代" : "世纪"}序号。`, `Enter a ${endpoint.kind} index from 1 to ${upper}.`);
  } else if (endpoint.kind === "calendar") {
    const upper = endpoint.era === "BC" ? 9999 : 99999999;
    if (!integer(endpoint.year, 1, upper)) reject(`年份须为1至${upper}的整数，没有公元0年。`, `Year must be an integer from 1 to ${upper}; there is no year zero.`);
    if ((precision === "exact" || precision === "month" || endpoint.month !== undefined) && !integer(endpoint.month, 1, 12)) reject("请选择或填写1至12月。", "Enter a month from 1 to 12.");
    if ((precision === "exact" || endpoint.day !== undefined) && !integer(endpoint.day, 1, 31)) reject("精确公历须填写日期，范围为1至31日。", "An exact calendar date requires a day from 1 to 31.");
    if (endpoint.hour !== undefined && !integer(endpoint.hour, 0, 23)) reject("小时须为0至23的整数。", "Hour must be an integer from 0 to 23.");
    if (endpoint.minute !== undefined && (endpoint.hour === undefined || !integer(endpoint.minute, 0, 59))) reject("填写分钟前须填写小时；分钟范围为0至59。", "Enter an hour before minutes; minutes must be from 0 to 59.");
    if (endpoint.second !== undefined && (endpoint.minute === undefined || !integer(endpoint.second, 0, 59))) reject("填写秒前须填写时、分；秒范围为0至59。", "Enter hours and minutes before seconds; seconds must be from 0 to 59.");
    if (endpoint.offset && endpoint.hour === undefined) reject("选择时区时请同时填写小时；只有日期可选择“不设时区”。", "Enter an hour when selecting a UTC offset. A date alone can use No zone.");
  } else if (endpoint.kind === "relative") {
    if (!/^(?:0|[1-9]\d{0,3})(?:\.\d)?$/.test(endpoint.value ?? "") || Number(endpoint.value) <= 0 || Number(endpoint.value) > 9999) reject("单位年前/后的数值须大于0且不超过9999，最多一位小数。", "Years before/after must be greater than 0 and at most 9999, with at most one decimal place.");
  }
}

export function readCalendarFields(host, endpoint, precision = "exact") {
  const field = name => host.querySelector(`[data-endpoint-field="${name}"]`)?.value ?? "";
  const number = name => field(name) === "" ? undefined : Number(field(name));
  const era = endpoint.era ?? "AD";
  if (["decade", "century"].includes(precision)) return { kind: precision, era, index: number("year") };
  const result = { kind: "calendar", era, ...(number("year") === undefined ? {} : { year: number("year") }) };
  for (const name of precision === "exact" ? ["month", "day", "hour", "minute", "second"] : precision === "month" ? ["month"] : []) if (field(name) !== "") result[name] = number(name);
  if (precision === "exact" && field("offset")) result.offset = field("offset");
  return result;
}

export function appendCalendarFields(host, endpoint, precision, language) {
  const values = text(language), fuzzy = precision !== "exact";
  const row = document.createElement("div"); row.className = "cloudig-endpoint-calendar-row";
  const frame = document.createElement("div"); frame.className = "cloudig-endpoint-input-frame";
  const precisionLabel = key => language === "en" ? values[key] : ({ century: "公历世纪", decade: "公历年代", year: "公历年份", month: "公历年月" })[key];
  if (fuzzy && !precision) {
    frame.classList.add("cloudig-endpoint-precision-menu");
    for (const key of ["century", "decade", "year", "month"]) frame.append(tag(precisionLabel(key), "precision", key, false));
  } else {
    if (fuzzy) { const choose = tag(precisionLabel(precision) + " ▾", "precision-menu", "", false); choose.classList.add("cloudig-endpoint-precision-change"); frame.append(choose); }
    const date = document.createElement("span"); date.className = "cloudig-endpoint-date-fields";
    date.append(inputField("year", endpoint.index ?? endpoint.year, values.year, { inputmode: "numeric", maxlength: endpoint.era === "BC" ? 4 : 8, placeholder: "________" }));
    const add = (name, suffix) => date.append(inputField(name, endpoint[name], values[name], { inputmode: "numeric", maxlength: 2, placeholder: "__" }), document.createTextNode(suffix));
    if (fuzzy && ["decade", "century"].includes(precision)) date.append(document.createTextNode(precision === "decade" ? (language === "en" ? "0s" : "0年代") : values.century));
    else {
      date.append(document.createTextNode(language === "en" ? " / " : "年 / "));
      if (!fuzzy || precision === "month") add("month", language === "en" ? "" : "月");
      if (!fuzzy) { date.append(document.createTextNode(" / ")); add("day", language === "en" ? "" : "日"); }
    }
    frame.append(date);
    if (!fuzzy) {
      const clock = document.createElement("span"); clock.className = "cloudig-endpoint-clock-fields";
      for (const name of ["hour", "minute", "second"]) { if (name !== "hour") clock.append(document.createTextNode(":")); clock.append(inputField(name, endpoint[name], values[name], { inputmode: "numeric", maxlength: 2, placeholder: "__" })); }
      frame.append(clock, timeZoneSelect(endpoint.offset, language));
    }
  }
  row.append(frame, tag("AD", "era", "AD", endpoint.era !== "BC"), tag("BC", "era", "BC", endpoint.era === "BC")); host.append(row);
}

// This editor only maps Terran ranges. Sovereign node selection belongs to the
// separately designed counterpart/child picker, not a second tab in this form.
export function mountEndpointEditor(options) {
  const controller = new AbortController();
  let language = options.language === "en" ? "en" : "zh-CN";
  let values = text(language);
  const blank = () => ({ kind: "calendar", era: "AD" });
  let working = clone(options.initialRange ?? { start: blank() });
  let same = working.end === undefined;
  const modes = { start: options.initialRange ? endpointMode(working.start) : "exact", end: same ? "special" : endpointMode(working.end) };
  const precisions = { start: modes.start === "fuzzy" ? calendarPrecision(working.start) : null, end: modes.end === "fuzzy" ? calendarPrecision(working.end) : null };
  let confirmed = null;
  let editRevision = 0;
  let previewing = false;
  options.host.innerHTML = '<section class="cloudig-endpoint-editor" data-endpoint-editor><div data-endpoint-sections></div><p class="cloudig-endpoint-preview" data-endpoint-preview aria-live="polite"></p><footer><button type="button" class="cloudig-button cloudig-button-outline" data-endpoint-confirm></button><button type="button" class="cloudig-button cloudig-button-filled" data-endpoint-save disabled></button><button type="button" class="cloudig-endpoint-cancel" data-endpoint-cancel></button></footer></section>';
  const root = options.host.querySelector("[data-endpoint-editor]");
  const sections = root.querySelector("[data-endpoint-sections]");
  const info = root.querySelector("[data-endpoint-preview]");
  const confirmButton = root.querySelector("[data-endpoint-confirm]");
  const saveButton = root.querySelector("[data-endpoint-save]");
  const current = (side) => side === "start" ? working.start : working.end ?? { kind: "same" };
  const put = (side, endpoint) => { if (side === "start") working.start = endpoint; else { same = endpoint.kind === "same"; if (same) delete working.end; else working.end = endpoint; } };
  const hint = () => {
    info.dataset.state = "draft";
    info.textContent = language === "en" ? "Confirm, check, then save. Current range: not confirmed." : "点击确认，检查无误后保存。当前时段：未设置。";
  };
  const invalidate = () => { editRevision++; confirmed = null; saveButton.disabled = true; hint(); };
  const showError = (error) => { info.dataset.state = "error"; info.textContent = timeInputError(error, language); };
  const fieldValue = (host, name) => host.querySelector('[data-endpoint-field="' + name + '"]')?.value ?? "";

  function sync(side) {
    const fields = sections.querySelector('[data-endpoint-side-section="' + side + '"] [data-endpoint-fields]');
    if (!fields) return;
    const previous = current(side), mode = modes[side];
    if (mode === "exact" || (mode === "fuzzy" && precisions[side])) put(side, readCalendarFields(fields, previous, mode === "exact" ? "exact" : precisions[side]));
    else if (mode === "relative") {
      const value = fieldValue(fields, "value");
      put(side, { kind: "relative", direction: previous.direction ?? "before", unit: previous.unit ?? "wan", value,
        anchor: clone(value === previous.value ? previous.anchor ?? options.anchor : options.anchor) });
    }
  }

  function calendarFields(host, side) {
    appendCalendarFields(host, current(side), modes[side] === "fuzzy" ? precisions[side] : "exact", language);
  }

  function renderSide(side) {
    const section = document.createElement("section"); section.className = "cloudig-endpoint-section"; section.dataset.endpointSideSection = side;
    const header = document.createElement("header");
    const label = document.createElement("span"); label.textContent = values[side]; header.append(label);
    for (const mode of ["exact", "fuzzy", "relative", "special"]) {
      const choice = document.createElement("label"); choice.className = "cloudig-choice";
      const radio = document.createElement("input"); radio.type = "radio"; radio.name = "endpoint-mode-" + side; radio.value = mode; radio.dataset.endpointKind = mode; radio.checked = modes[side] === mode;
      const caption = document.createElement("span"); caption.textContent = values[mode]; choice.append(radio, caption); header.append(choice);
    }
    const fields = document.createElement("div"); fields.dataset.endpointFields = ""; fields.className = "cloudig-endpoint-fields";
    if (modes[side] === "exact" || modes[side] === "fuzzy") calendarFields(fields, side);
    else if (modes[side] === "relative") {
      const endpoint = current(side), direction = endpoint.direction ?? "before", selectedUnit = endpoint.unit ?? "wan";
      const row = document.createElement("div"); row.className = "cloudig-endpoint-relative-row";
      const value = inputField("value", endpoint.value, values.value, { inputmode: "decimal", maxlength: 6, placeholder: "____" });
      const group = document.createElement("div"); group.className = "cloudig-endpoint-units";
      for (const unit of direction === "before" ? ["wan", "yi"] : units) group.append(tag(language === "en" ? "10" + unitExponents[unit] : unitLabels[unit], "unit", unit, selectedUnit === unit));
      row.append(value, group, document.createTextNode(language === "en" ? "years" : "年"), tag(values.before, "direction", "before", direction === "before"), tag(values.after, "direction", "after", direction === "after"));
      fields.append(row);
    } else {
      const endpoint = current(side);
      fields.classList.add("cloudig-endpoint-specials");
      const options = [...(side === "end" ? [["same", values.same]] : []), ["now", values.now], ["whenever", values.whenever], ["unknown", values.unknown], ["infinite_past", values.infinitePast], ["infinite_future", values.infiniteFuture]];
      for (const [kind, title] of options) fields.append(tag(title, "special", kind, endpoint.kind === kind));
    }
    section.append(header, fields); return section;
  }

  function render() {
    sections.replaceChildren(renderSide("start"), renderSide("end"));
    confirmButton.textContent = values.confirm;
    saveButton.textContent = language === "en" ? "Save range" : "保存时段";
    root.querySelector("[data-endpoint-cancel]").textContent = values.cancel;
  }

  sections.addEventListener("input", event => {
    if (!event.target.matches("[data-endpoint-field]")) return;
    invalidate();
  }, { signal: controller.signal });
  sections.addEventListener("change", event => {
    const input = event.target.closest("[data-endpoint-kind]");
    if (!input) return;
    const side = input.closest("[data-endpoint-side-section]").dataset.endpointSideSection;
    sync("start"); sync("end"); modes[side] = input.value; precisions[side] = null;
    const previous = current(side);
    if (input.value === "exact" || input.value === "fuzzy") put(side, previous.kind === "calendar" ? previous : blank());
    if (input.value === "relative") put(side, previous.kind === "relative" ? previous : { kind: "relative", direction: "before", unit: "wan", value: "", anchor: clone(options.anchor) });
    if (input.value === "special") put(side, side === "end" ? { kind: "same" } : { kind: "now", anchor: clone(options.anchor) });
    invalidate(); render();
  }, { signal: controller.signal });
  sections.addEventListener("click", event => {
    const button = event.target.closest("[data-endpoint-option]");
    if (!button) return;
    const side = button.closest("[data-endpoint-side-section]").dataset.endpointSideSection;
    sync("start"); sync("end");
    const group = button.dataset.endpointOption, value = button.dataset.value, endpoint = current(side);
    if (group === "precision") precisions[side] = value;
    else if (group === "precision-menu") precisions[side] = null;
    else if (group === "special") put(side, { kind: value, ...(["now"].includes(value) ? { anchor: clone(options.anchor) } : {}) });
    else if (group === "era" || group === "unit") put(side, { ...endpoint, [group]: value,
      ...(group === "unit" && endpoint.unit !== value ? { anchor: clone(options.anchor) } : {}) });
    else if (group === "direction") put(side, { ...endpoint, direction: value, unit: value === "before" && !["wan", "yi"].includes(endpoint.unit) ? "wan" : endpoint.unit,
      ...(endpoint.direction !== value ? { anchor: clone(options.anchor) } : {}) });
    invalidate(); render();
  }, { signal: controller.signal });
  confirmButton.addEventListener("click", async () => {
    if (previewing) return;
    sync("start"); sync("end");
    if (["start", "end"].some(side => modes[side] === "fuzzy" && !precisions[side])) { showError({ message: language === "en" ? "Choose a fuzzy-calendar precision first." : "请先选择模糊公历的世纪、年代、年份或年月。" }); return; }
    const revision = editRevision;
    previewing = true; confirmButton.disabled = true;
    try {
      validatePointDraft(working.start, modes.start === "exact" ? "exact" : precisions.start, language);
      if (!same) validatePointDraft(working.end, modes.end === "exact" ? "exact" : precisions.end, language);
      const result = await options.previewRange(clone(working));
      if (controller.signal.aborted || revision !== editRevision) return;
      working = clone(result.range); same = working.end === undefined; confirmed = clone(result);
      info.dataset.state = result.direction === "reversed" ? "warning" : "confirmed";
      info.textContent = formatTimeRange(working, language) + (result.direction === "reversed" ? "\n" + values.reversed : "");
      saveButton.disabled = false;
    } catch (error) { if (!controller.signal.aborted && revision === editRevision) showError(error); }
    finally { previewing = false; confirmButton.disabled = false; }
  }, { signal: controller.signal });
  saveButton.addEventListener("click", async () => {
    if (!confirmed) return;
    try { await options.onConfirm?.(clone(confirmed.range), clone(confirmed)); }
    catch (error) { showError(error); }
  }, { signal: controller.signal });
  root.querySelector("[data-endpoint-cancel]").addEventListener("click", () => options.onCancel?.(), { signal: controller.signal });
  render(); hint();
  return {
    element: root,
    getRange: () => clone(confirmed?.range ?? options.initialRange ?? null),
    setRange(next) {
      working = clone(next); same = working.end === undefined;
      for (const side of ["start", "end"]) { modes[side] = side === "end" && same ? "special" : endpointMode(current(side)); precisions[side] = modes[side] === "fuzzy" ? calendarPrecision(current(side)) : null; }
      invalidate(); render();
    },
    updateLanguage(next) { sync("start"); sync("end"); language = next === "en" ? "en" : "zh-CN"; values = text(language); render(); if (confirmed) info.textContent = formatTimeRange(confirmed.range, language); else hint(); },
    cleanup() { controller.abort(); options.host.replaceChildren(); }
  };
}
