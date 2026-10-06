import type { JsonObject, JsonValue } from "../../../core/contracts/types.mts";
import { boxText as str, boxObject as obj, boxList as list, boxStrings as strings, boxElement as el, boxLabel as tr,
  boxButton as button, boxParagraph as p, boxHeading as heading, boxPager as pager, boxImages, type BoxContext } from "./box-controls.mts";

// Observed native chart palette. The saved series' own explicit colour wins.
const chartPalette = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"] as const;
const numeric = (value: JsonValue | undefined): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const shown = (value: JsonValue | undefined): string => numeric(value) === undefined ? "—" : String(value);

export function chartBox(ctx: BoxContext, input: JsonObject): HTMLElement {
  if (input["style"] === "scatter") return scatterChart(ctx, input);
  const root = el(ctx, "section", "cloudig-box cloudig-box-chart"), series = list(input["series"]), xAxis = obj(input["x_axis"]), yAxis = obj(input["y_axis"]);
  const labels = Array.isArray(xAxis["data"]) ? xAxis["data"].map(str) : [];
  const values = series.map(s => Array.isArray(s["values"]) ? s["values"] as JsonValue[] : []);
  const title = str(input["title"]), toolbar = el(ctx, "div", "cloudig-box-toolbar"), modes = el(ctx, "div", "cloudig-box-tabs");
  const chart = el(ctx, "div"), table = el(ctx, "div", "cloudig-box-data-table"); table.dataset["scrollRegion"] = ""; table.hidden = true;
  const setMode = (tabular: boolean) => { chart.hidden = tabular; table.hidden = !tabular; chartButton.setAttribute("aria-pressed", String(!tabular)); tableButton.setAttribute("aria-pressed", String(tabular)); };
  const chartButton = button(ctx, tr(ctx, "图表", "Chart"), () => setMode(false)), tableButton = button(ctx, tr(ctx, "表格", "Table"), () => setMode(true));
  modes.append(chartButton, tableButton); toolbar.append(heading(ctx, title), modes); root.append(toolbar, p(ctx, [str(yAxis["title"]), str(xAxis["title"])].filter(Boolean).join(" · "), true), chart, table); setMode(false);
  const grid = el(ctx, "table"), head = el(ctx, "thead"), row = el(ctx, "tr"), body = el(ctx, "tbody");
  for (const label of [str(xAxis["title"]), ...series.map(s => str(s["name"]))]) row.append(el(ctx, "th", "", label)); head.append(row);
  for (const [i, label] of labels.entries()) { const r = el(ctx, "tr"); r.append(el(ctx, "th", "", label)); for (const v of values) r.append(el(ctx, "td", "", shown(v[i]))); body.append(r); }
  grid.append(head, body); table.append(grid);
  const all = values.flatMap(v => v.flatMap(n => numeric(n) === undefined ? [] : [n as number]));
  if (!labels.length || !all.length || !["line", "bar"].includes(str(input["style"]) || "line")) { setMode(true); chartButton.disabled = true; return root; }
  const minimum = Math.min(0, ...all), maximum = Math.max(0, ...all), rawStep = (maximum - minimum || 1) / 6;
  const power = 10 ** Math.floor(Math.log10(rawStep)), step = ([1, 2, 5, 10].find(n => n * power >= rawStep) ?? 10) * power;
  const lo = Math.floor(minimum / step) * step, hi = Math.ceil((maximum || 1) / step) * step;
  const left = 44, right = 690, top = 16, bottom = 218, height = 252;
  const x = (i: number) => input["style"] === "bar" ? left + (i + .5) * (right - left) / labels.length : labels.length === 1 ? (left + right) / 2 : left + i * (right - left) / (labels.length - 1);
  const y = (n: number) => bottom - (n - lo) / (hi - lo) * (bottom - top);
  const svgNode = (tag: string, attributes: Record<string, string | number>, text?: string): SVGElement => { const n = ctx.document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attributes)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; };
  const svg = svgNode("svg", { viewBox: `0 0 704 ${height}`, role: "img", "aria-label": title, tabindex: 0, class: "cloudig-box-chart-svg" });
  for (let n = lo; n <= hi + step / 2; n += step) { const pos = y(n); svg.append(svgNode("line", { x1: left, x2: right, y1: pos, y2: pos, class: "cloudig-box-chart-grid" }), svgNode("text", { x: left - 8, y: pos + 4, "text-anchor": "end" }, String(Number(n.toPrecision(10))))); }
  for (const [i, label] of labels.entries()) svg.append(svgNode("text", { x: x(i), y: bottom + 20, "text-anchor": "middle" }, label));
  const legend = el(ctx, "div", "cloudig-box-chart-legend");
  for (const [s, numbers] of values.entries()) {
    const explicit = str(series[s]?.["color"]), color = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.test(explicit) ? explicit : chartPalette[s % chartPalette.length]!;
    let path = "", connected = false;
    for (const [i, number] of numbers.slice(0, labels.length).entries()) {
      const v = numeric(number); if (v === undefined) { connected = false; continue; }
      path += `${connected ? "L" : "M"}${x(i)},${y(v)} `; connected = true;
      if (input["style"] === "bar") {
        const slot = (right - left) / Math.max(1, labels.length), width = slot * .72 / Math.max(1, series.length);
        svg.append(svgNode("rect", { x: left + slot * i + slot * .14 + width * s, y: Math.min(y(0), y(v)), width, height: Math.abs(y(v) - y(0)), fill: color }));
      } else svg.append(svgNode("circle", { cx: x(i), cy: y(v), r: 3.4, fill: color, class: "cloudig-box-chart-point" }));
    }
    if (input["style"] !== "bar") svg.append(svgNode("path", { d: path, fill: "none", stroke: color, "stroke-width": 2 }));
    const key = el(ctx, "span"); key.style.setProperty("--series-color", color); key.append(el(ctx, "i"), ctx.document.createTextNode(str(series[s]?.["name"]))); legend.append(key);
  }
  const selection = el(ctx, "p", "cloudig-box-chart-selection"); selection.setAttribute("aria-live", "polite"); selection.hidden = true; let selected = 0;
  const select = (i: number) => { if (ctx.signal.aborted) return; selected = Math.max(0, Math.min(labels.length - 1, i)); selection.hidden = false; selection.textContent = `${labels[selected]} · ${series.map((s, j) => `${str(s["name"])} ${shown(values[j]?.[selected])}`).join(" · ")}`; };
  svg.addEventListener("pointermove", event => { const r = svg.getBoundingClientRect(); select(Math.round((((event as PointerEvent).clientX - r.left) / r.width * 704 - left) / (right - left) * (labels.length - 1))); });
  svg.addEventListener("keydown", event => { const key = (event as KeyboardEvent).key; if (key === "ArrowRight" || key === "ArrowLeft") { event.preventDefault(); select(selected + (key === "ArrowRight" ? 1 : -1)); } });
  chart.append(svg, legend, selection); return root;
}

/** Scatter data has independent numeric coordinates, not category labels/values. */
function scatterChart(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-chart"), series = list(input["series"]);
  const xAxis = obj(input["x_axis"]), yAxis = obj(input["y_axis"]), title = str(input["title"]);
  const chart = el(ctx, "div"), table = el(ctx, "div", "cloudig-box-data-table"); table.dataset["scrollRegion"] = "";
  const chartButton = button(ctx, tr(ctx, "图表", "Chart"), () => mode(false)), tableButton = button(ctx, tr(ctx, "表格", "Table"), () => mode(true));
  const mode = (tabular: boolean) => { chart.hidden = tabular; table.hidden = !tabular; chartButton.setAttribute("aria-pressed", String(!tabular)); tableButton.setAttribute("aria-pressed", String(tabular)); };
  const toolbar = el(ctx, "div", "cloudig-box-toolbar"), tabs = el(ctx, "div", "cloudig-box-tabs"); tabs.append(chartButton, tableButton);
  toolbar.append(heading(ctx, title), tabs); root.append(toolbar, chart, table); mode(false);
  const grid = el(ctx, "table"), head = el(ctx, "thead"), row = el(ctx, "tr"), body = el(ctx, "tbody");
  for (const label of [tr(ctx, "系列", "Series"), str(xAxis["title"]) || "X", str(yAxis["title"]) || "Y"]) row.append(el(ctx, "th", "", label)); head.append(row);
  const points: { x: number; y: number; series: number; name: string }[] = [];
  series.forEach((s, index) => { for (const point of list(s["points"])) {
    const r = el(ctx, "tr"); for (const value of [str(s["name"]), shown(point["x"]), shown(point["y"])]) r.append(el(ctx, "td", "", value)); body.append(r);
    const x = numeric(point["x"]), y = numeric(point["y"]); if (x !== undefined && y !== undefined) points.push({ x, y, series: index, name: str(s["name"]) });
  } }); grid.append(head, body); table.append(grid);
  if (!points.length) { mode(true); chartButton.disabled = true; return root; }
  const extent = (axis: JsonObject, values: number[]) => {
    let lo = numeric(axis["min"]) ?? Math.min(0, ...values), hi = numeric(axis["max"]) ?? Math.max(0, ...values);
    if (hi <= lo) { lo = Math.min(lo, ...values); hi = Math.max(hi, ...values); if (hi <= lo) hi = lo + 1; }
    const raw = (hi - lo) / 5, power = 10 ** Math.floor(Math.log10(raw));
    const step = ([1, 2, 5, 10].find(n => n * power >= raw) ?? 10) * power;
    return { lo: numeric(axis["min"]) ?? Math.floor(lo / step) * step, hi: numeric(axis["max"]) ?? Math.ceil(hi / step) * step, step };
  };
  const horizontal = extent(xAxis, points.map(p => p.x)), vertical = extent(yAxis, points.map(p => p.y));
  const left = 64, right = 686, top = 18, bottom = 224, width = 704, height = 280;
  const x = (v: number) => left + (v - horizontal.lo) / (horizontal.hi - horizontal.lo) * (right - left);
  const y = (v: number) => bottom - (v - vertical.lo) / (vertical.hi - vertical.lo) * (bottom - top);
  const svgNode = (tag: string, attributes: Record<string, string | number>, text?: string) => { const node = ctx.document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title, tabindex: 0, class: "cloudig-box-chart-svg" });
  const ticks = (axis: ReturnType<typeof extent>) => { const values = [axis.lo]; for (let v = Math.ceil(axis.lo / axis.step) * axis.step; v < axis.hi; v += axis.step) if (v > axis.lo) values.push(v); values.push(axis.hi); return values; };
  for (const n of ticks(vertical)) svg.append(svgNode("line", { x1: left, x2: right, y1: y(n), y2: y(n), class: "cloudig-box-chart-grid" }), svgNode("text", { x: left - 8, y: y(n) + 4, "text-anchor": "end" }, String(Number(n.toPrecision(10)))));
  for (const n of ticks(horizontal)) svg.append(svgNode("line", { x1: x(n), x2: x(n), y1: top, y2: bottom, class: "cloudig-box-chart-grid" }), svgNode("text", { x: x(n), y: bottom + 20, "text-anchor": "middle" }, String(Number(n.toPrecision(10)))));
  svg.append(svgNode("text", { x: (left + right) / 2, y: height - 7, "text-anchor": "middle" }, str(xAxis["title"])), svgNode("text", { transform: `translate(16 ${(top + bottom) / 2}) rotate(-90)`, "text-anchor": "middle" }, str(yAxis["title"])));
  const color = (index: number) => /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.test(str(series[index]?.["color"])) ? str(series[index]?.["color"]) : chartPalette[index % chartPalette.length]!;
  for (const point of points) { if (point.x < horizontal.lo || point.x > horizontal.hi || point.y < vertical.lo || point.y > vertical.hi) continue;
    const dot = svgNode("circle", { cx: x(point.x), cy: y(point.y), r: 4.5, fill: color(point.series), class: "cloudig-box-chart-point" }); dot.append(svgNode("title", {}, `${point.name} · ${point.x}, ${point.y}`)); svg.append(dot);
  }
  const legend = el(ctx, "div", "cloudig-box-chart-legend"); series.forEach((s, index) => { const key = el(ctx, "span"); key.style.setProperty("--series-color", color(index)); key.append(el(ctx, "i"), ctx.document.createTextNode(str(s["name"]))); legend.append(key); });
  const selection = el(ctx, "p", "cloudig-box-chart-selection"); selection.setAttribute("aria-live", "polite"); selection.hidden = true; let selected = 0;
  const select = (index: number) => { if (ctx.signal.aborted) return; selected = Math.max(0, Math.min(points.length - 1, index)); const point = points[selected]!; selection.hidden = false; selection.textContent = `${point.name} · ${str(xAxis["title"]) || "X"} ${point.x} · ${str(yAxis["title"]) || "Y"} ${point.y}`; };
  svg.addEventListener("pointermove", event => { const r = svg.getBoundingClientRect(); if (!r.width || !r.height) return; const px = ((event as PointerEvent).clientX - r.left) / r.width * width, py = ((event as PointerEvent).clientY - r.top) / r.height * height; let closest = 0, distance = Infinity; points.forEach((point, i) => { const d = (x(point.x) - px) ** 2 + (y(point.y) - py) ** 2; if (d < distance) { closest = i; distance = d; } }); select(closest); });
  svg.addEventListener("keydown", event => { const key = (event as KeyboardEvent).key; if (key === "ArrowRight" || key === "ArrowLeft") { event.preventDefault(); select(selected + (key === "ArrowRight" ? 1 : -1)); } });
  chart.append(svg, legend, selection); return root;
}

export function weatherBox(ctx: BoxContext, input: JsonObject, result: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-weather"), current = obj(result["current"]), daily = list(result["daily"]);
  const header = el(ctx, "header", "cloudig-box-weather-current"), place = el(ctx, "div"), condition = el(ctx, "div");
  place.append(p(ctx, str(input["location_name"]) || [str(result["location"]), str(result["country"])].filter(Boolean).join(", ")), el(ctx, "strong", "cloudig-box-temperature", `${shown(current["temperature"])}°`));
  condition.append(p(ctx, str(current["condition_text"]) || str(current["condition"])), p(ctx, tr(ctx, "来源中的天气记录", "Saved weather record"), true)); header.append(place, condition); root.append(header);
  const days = el(ctx, "div", "cloudig-box-weather-days"), details = p(ctx, "", true); days.dataset["scrollRegion"] = ""; details.hidden = true;
  for (const day of daily) {
    const label = str(day["day_of_week"]) || str(day["date"]), b = button(ctx, "", () => { details.hidden = false; details.textContent = `${str(day["date"])} · ${tr(ctx, "最高", "High")} ${shown(day["high"])}° · ${tr(ctx, "最低", "Low")} ${shown(day["low"])}° · ${tr(ctx, "降水", "Precipitation")} ${shown(day["precipitation_chance"])}%`; }, "cloudig-box-weather-day");
    b.title = str(day["date"]); b.setAttribute("aria-label", `${label} ${str(day["date"])}`);
    b.append(el(ctx, "span", "cloudig-box-muted", label.slice(0, 3)), el(ctx, "strong", "", `${numeric(day["high"]) === undefined ? "—" : Math.round(day["high"] as number)}°`), el(ctx, "span", "cloudig-box-muted", `${shown(day["precipitation_chance"])}%`)); days.append(b);
  }
  root.append(days, details); return root;
}

export function placesListBox(ctx: BoxContext, input: JsonObject, images: readonly JsonObject[]): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-places"), entries = list(input["places"]); let one = false, page = 0;
  const cards = entries.map((place, i) => {
    const card = el(ctx, "section", "cloudig-box-product"), name = str(place["name"]);
    const gallery = boxImages(ctx, images.filter(image => str(image["source_id"]).startsWith(`place_${i}_`)).map(image => str(image["path"])), name);
    if (gallery) { gallery.classList.add("cloudig-box-mosaic"); card.append(gallery); }
    card.append(heading(ctx, name), p(ctx, str(place["description"])));
    const tips = el(ctx, "ul", "cloudig-box-place-tips"); for (const tip of strings(place["tips"])) tips.append(el(ctx, "li", "", tip)); card.append(tips); return card;
  });
  const unassigned = boxImages(ctx, images.filter(image => !entries.some((_, i) => str(image["source_id"]).startsWith(`place_${i}_`))).map(image => str(image["path"])), str(input["summary"]));
  const paint = () => { root.replaceChildren(); root.setAttribute("aria-label", str(input["summary"])); const grid = el(ctx, "div", "cloudig-box-product-grid"); grid.append(...(one ? cards.slice(page, page + 1) : cards)); root.append(grid);
    if (unassigned) root.append(unassigned);
    if (one) root.append(pager(ctx, cards.length, page, n => { page = n; paint(); }));
    if (cards.length > 1) root.append(button(ctx, one ? tr(ctx, "查看全部", "View all") : tr(ctx, "逐个查看", "View one by one"), () => { one = !one; paint(); }));
  }; paint(); return root;
}
