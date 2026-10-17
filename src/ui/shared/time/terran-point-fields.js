import { appendCalendarFields, inputField, readCalendarFields, tag, timeUnitLabel, timeUnits, validatePointDraft } from "./endpoint-editor.js";

// Conversation Info's three visible eras share the calendar fields used by mappings.
export function mountTerranPointFields(options) {
  const abort = new AbortController();
  const language = options.language === "en" ? "en" : "zh-CN";
  const zh = language !== "en";
  const text = zh
    ? { historical: "大爆炸至公元9999年", future: "公元9999年后", ancient: "大爆炸前", exact: "精确公历时间", fuzzy: "模糊公历时间", before: "亿万年前", after: "单位年后", now: "现今", special: "特殊时间", infinite_past: "无限久前", infinite_future: "无限久后", unknown: "不知何时", whenever: "无论何时" }
    : { historical: "Big Bang to AD 9999", future: "After AD 9999", ancient: "Before Big Bang", exact: "Exact calendar", fuzzy: "Fuzzy calendar", before: "Years ago", after: "Years ahead", now: "Now", special: "Special time", infinite_past: "Infinite past", infinite_future: "Infinite future", unknown: "Unknown", whenever: "Whenever" };
  const relative = direction => ({ kind: "relative", direction, unit: "wan", value: "", anchor: structuredClone(options.anchor) });
  const bands = {
    historical: { mode: "exact", precision: null, endpoint: { kind: "calendar", era: "AD" } },
    future: { mode: "relative", precision: null, endpoint: relative("after") },
    ancient: { mode: "relative", endpoint: { ...relative("before"), unit: "yi" } }
  };
  let selected = "historical", special = null;
  const initial = options.endpoint;
  if (initial && ["now", "infinite_past", "infinite_future", "unknown", "whenever"].includes(initial.kind)) {
    if (initial.kind === "now") { bands.historical.mode = "now"; bands.historical.endpoint = structuredClone(initial); }
    else { selected = "special"; special = initial.kind; }
  } else if (initial && initial.kind !== "sovereign") {
    if (initial.kind === "relative") selected = initial.direction === "after" ? "future" : initial.unit === "yi" && Number(initial.value) > 138 ? "ancient" : "historical";
    else if (initial.era === "AD" && (initial.year ?? initial.index * (initial.kind === "decade" ? 10 : 100)) > 9999) selected = "future";
    const band = bands[selected]; band.endpoint = structuredClone(initial);
    band.mode = initial.kind === "relative" ? "relative" : ["decade", "century"].includes(initial.kind) || initial.year !== undefined && initial.day === undefined ? "fuzzy" : "exact";
    band.precision = ["decade", "century"].includes(initial.kind) ? initial.kind : initial.month === undefined ? "year" : "month";
  }
  const root = document.createElement("div"); root.className = "cloudig-endpoint-editor cloudig-point-editor"; root.dataset.terranPointFields = "";
  options.host.replaceChildren(root);

  const sync = id => {
    const band = bands[id], host = root.querySelector(`[data-point-band="${id}"]`);
    if (!host) return;
    if (band.mode === "exact" || band.mode === "fuzzy" && band.precision) band.endpoint = readCalendarFields(host, band.endpoint, band.mode === "exact" ? "exact" : band.precision);
    else if (band.mode === "relative") {
      const value = host.querySelector("[data-endpoint-field='value']")?.value ?? "";
      band.endpoint = { ...band.endpoint, value, kind: "relative", direction: id === "future" ? "after" : "before",
        anchor: structuredClone(value === band.endpoint.value ? band.endpoint.anchor ?? options.anchor : options.anchor) };
    }
  };
  const read = (validate = false) => {
    if (selected === "special") return { kind: special };
    sync(selected);
    const band = bands[selected];
    if (band.mode === "fuzzy" && !band.precision) throw new Error(zh ? "请先选择模糊公历的世纪、年代、年份或年月。" : "Choose a fuzzy-calendar precision first.");
    if (validate && band.mode !== "now") validatePointDraft(band.endpoint, band.mode === "exact" ? "exact" : band.precision, language);
    return band.mode === "now" ? { kind: "now", anchor: structuredClone(band.endpoint.anchor ?? options.anchor) } : structuredClone(band.endpoint);
  };
  const changed = () => { options.onChange?.(); updateSelections(); };
  const updateSelections = () => {
    root.dataset.selectedBand = selected;
    for (const input of root.querySelectorAll("[data-point-mode]")) input.checked = input.closest("[data-point-band]").dataset.pointBand === selected && input.value === bands[selected]?.mode;
    for (const button of root.querySelectorAll("[data-point-special]")) button.setAttribute("aria-pressed", String(selected === "special" && special === button.dataset.pointSpecial));
    for (const button of root.querySelectorAll("[data-endpoint-option='unit']")) {
      const id = button.closest("[data-point-band]").dataset.pointBand;
      button.setAttribute("aria-pressed", String(selected === id && bands[id].endpoint.unit === button.dataset.value));
    }
  };
  const choices = (header, id) => {
    for (const mode of ["exact", "fuzzy", "relative", ...(id === "historical" ? ["now"] : [])]) {
      const choice = document.createElement("label"); choice.className = "cloudig-choice";
      const input = document.createElement("input"); input.type = "radio"; input.name = "conversation-point-mode"; input.value = mode; input.dataset.pointMode = "";
      const caption = document.createElement("span"); caption.textContent = mode === "relative" ? text[id === "future" ? "after" : "before"] : text[mode];
      choice.append(input, caption); header.append(choice);
    }
  };
  const render = () => {
    root.replaceChildren();
    for (const id of ["historical", "future"]) {
      const band = bands[id], section = document.createElement("section"); section.dataset.pointBand = id;
      const header = document.createElement("header"); const label = document.createElement("span"); label.textContent = text[id]; header.append(label); choices(header, id);
      const fields = document.createElement("div"); fields.className = "cloudig-point-band-fields";
      if (["exact", "fuzzy"].includes(band.mode)) {
        appendCalendarFields(fields, band.endpoint, band.mode === "exact" ? "exact" : band.precision, language);
        const year = fields.querySelector("[data-endpoint-field='year']"); if (year) year.maxLength = id === "historical" ? 4 : 8;
        if (id === "future") fields.querySelector("[data-endpoint-option='era'][data-value='BC']").hidden = true;
      } else if (band.mode === "relative") {
        const row = document.createElement("div"); row.className = "cloudig-endpoint-relative-row";
        row.append(inputField("value", band.endpoint.value, text[id === "future" ? "after" : "before"], { inputmode: "decimal", maxlength: 6 }));
        const units = document.createElement("div"); units.className = "cloudig-endpoint-units";
        for (const unit of id === "future" ? timeUnits : ["wan", "yi"]) units.append(tag(timeUnitLabel(unit, language), "unit", unit, band.endpoint.unit === unit));
        row.append(units, document.createTextNode(zh ? id === "future" ? "年后" : "年前" : id === "future" ? "years ahead" : "years ago")); fields.append(row);
      }
      section.append(header, fields); root.append(section);
    }
    const ancient = document.createElement("section"); ancient.className = "cloudig-point-ancient"; ancient.dataset.pointBand = "ancient";
    const title = document.createElement("span"); title.textContent = text.ancient;
    const input = inputField("value", bands.ancient.endpoint.value, text.ancient, { inputmode: "decimal", maxlength: 6 });
    const unit = tag(zh ? "亿年前" : "×10⁸ ago", "unit", "yi", selected === "ancient");
    ancient.append(title, input, unit); const specialTitle = document.createElement("span"); specialTitle.textContent = text.special; ancient.append(specialTitle);
    for (const kind of ["infinite_past", "infinite_future", "unknown", "whenever"]) { const button = tag(text[kind], "special", kind, selected === "special" && special === kind); button.dataset.pointSpecial = kind; ancient.append(button); }
    root.append(ancient); updateSelections();
  };
  root.addEventListener("input", event => {
    if (!event.target.matches("[data-endpoint-field]")) return;
    selected = event.target.closest("[data-point-band]").dataset.pointBand; sync(selected); changed();
  }, { signal: abort.signal });
  root.addEventListener("change", event => {
    if (!event.target.matches("[data-point-mode]")) return;
    const id = event.target.closest("[data-point-band]").dataset.pointBand; sync(id); selected = id;
    const band = bands[id], mode = event.target.value; band.mode = mode; band.precision = null;
    if (mode === "relative" && band.endpoint.kind !== "relative") band.endpoint = relative(id === "future" ? "after" : "before");
    else if (mode === "now" && band.endpoint.kind !== "now") band.endpoint = { kind: "now", anchor: structuredClone(options.anchor) };
    else if (["exact", "fuzzy"].includes(mode) && band.endpoint.kind !== "calendar") band.endpoint = { kind: "calendar", era: "AD" };
    render(); changed();
  }, { signal: abort.signal });
  root.addEventListener("click", event => {
    const button = event.target.closest("[data-endpoint-option]"); if (!button) return;
    if (button.dataset.pointSpecial) { selected = "special"; special = button.dataset.pointSpecial; changed(); return; }
    const id = button.closest("[data-point-band]").dataset.pointBand; sync(id); selected = id;
    const band = bands[id], group = button.dataset.endpointOption, value = button.dataset.value;
    if (group === "precision") band.precision = value;
    else if (group === "precision-menu") band.precision = null;
    else if (group === "era" || group === "unit") band.endpoint = { ...band.endpoint, [group]: value,
      ...(group === "unit" && band.endpoint.unit !== value ? { anchor: structuredClone(options.anchor) } : {}) };
    render(); changed();
  }, { signal: abort.signal });
  render();
  return { read,
    snapshot() {
      // Keep even incomplete text through a locale redraw; validation is still explicit.
      const fields = [...root.querySelectorAll("[data-endpoint-field]")].map(input => ({ band: input.closest("[data-point-band]").dataset.pointBand, field: input.dataset.endpointField, value: input.value }));
      return structuredClone({ bands, selected, special, fields });
    },
    restore(snapshot) {
      for (const id of Object.keys(bands)) bands[id] = structuredClone(snapshot.bands[id]);
      selected = snapshot.selected; special = snapshot.special; render();
      for (const { band, field, value } of snapshot.fields) { const input = root.querySelector(`[data-point-band='${band}'] [data-endpoint-field='${field}']`); if (input) input.value = value; }
    },
    cleanup() { abort.abort(); root.remove(); } };
}
