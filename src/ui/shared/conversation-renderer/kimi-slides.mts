import { load, JSON_SCHEMA } from "js-yaml";
import createDOMPurify from "dompurify";
import { createMarkdownRenderer } from "./content-runtime.mts";
import type { InteractivePackage } from "./interactive-protocol.mts";
import type { SavedSlide } from "./native-slides.mts";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === "string" ? v : "";
const esc = (v: unknown): string => String(v ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const num = (v: unknown, fallback = 0): number => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const yaml = (source: unknown): Record<string, unknown> => obj(load(str(source), { schema: JSON_SCHEMA }));
const markdown = createMarkdownRenderer({ localResources: true });

/** A PPTD is a native coordinate document. Its source, pages and fonts remain
 * unmodified. This read view interprets drawing/text semantics, never JS. */
export function kimiSlides(input: InteractivePackage, document: Document): { slides: SavedSlide[]; css: string } {
  const presentation = obj(input.data?.["presentation"]), deck = yaml(presentation["pptdContent"]), theme = obj(deck["theme"]);
  const colors = obj(theme["colors"]), textStyles = obj(theme["textStyles"]), size = arr(deck["size"]), base = str(presentation["base"]);
  const width = num(size[0], 960), height = num(size[1], 540);
  if (width <= 0 || height <= 0) throw new TypeError("Invalid PPTD canvas size");
  const color = (value: unknown, fallback = "transparent"): string => {
    const s = str(value), v = s.startsWith("$") ? str(colors[s.slice(1)]) : s;
    return /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d.,% /+-]+\))$/iu.test(v) ? v : fallback;
  };
  const fill = (value: unknown): string => { const f = obj(value); return color(f["color"] ?? value); };
  const border = (value: unknown): string => { const b = obj(value); return `${num(b["width"], 1)}px ${["dashed", "dotted"].includes(str(b["style"])) ? b["style"] : "solid"} ${color(b["color"] , "currentColor")}`; };
  const style = (raw: unknown): Record<string, unknown> => { const s = obj(raw), ref = str(s["style"]); return { ...obj(textStyles[ref.replace(/^\$/u, "")]), ...s }; };
  const textCss = (raw: unknown): string => {
    const s = style(raw), align = arr(s["align"]), horizontal = ["left", "center", "right", "justify"].includes(str(align[0])) ? str(align[0]) : "left";
    return `font-family:${esc(JSON.stringify(str(s["fontFamily"]) || "sans-serif"))};font-size:${num(s["fontSize"], 16)}px;font-weight:${s["bold"] ? 700 : 400};font-style:${s["italic"] ? "italic" : "normal"};color:${color(s["color"], "#191817")};line-height:${num(s["lineHeight"], 1.2)};letter-spacing:${num(s["letterSpacing"])}px;text-align:${horizontal};white-space:${s["wrap"] === false ? "nowrap" : "normal"};`;
  };
  const purifier = createDOMPurify(document.defaultView!);
  const rich = (value: unknown): string => {
    const clean = purifier.sanitize(str(value).replace(/\n$/u, ""), { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "script", "iframe", "form"], FORBID_ATTR: ["style"] });
    // PPTD text is safe rich HTML with math in its text nodes, not Markdown
    // containing literal HTML tags. Preserve its strong/p/a structure; render
    // math after sanitizing so KaTeX positioning styles remain intact.
    const root = document.createElement("div"); root.innerHTML = clean;
    const walker = document.createTreeWalker(root, 4), nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    for (const node of nodes) {
      if (node.parentElement?.closest("code,pre")) continue;
      if (!node.data.trim() && node.parentElement?.childElementCount) { node.remove(); continue; }
      const template = document.createElement("template"); template.innerHTML = markdown.renderInline(node.data, { preserveLineBreaks: true }); node.replaceWith(template.content);
    }
    return root.innerHTML;
  };
  const render = (raw: unknown): string => {
    const e = obj(raw), bounds = arr(e["bounds"]), [x, y, w, h] = bounds.map(v => num(v));
    if (bounds.length !== 4 || w! < 0 || h! < 0) throw new TypeError("Invalid PPTD element bounds");
    const position = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;${typeof e["rotation"] === "number" ? `transform:rotate(${e["rotation"]}deg);` : ""}`;
    const content = style(e["content"]), type = str(e["elementType"]);
    if (type === "text") {
      const vertical = arr(content["align"])[1], justify = vertical === "middle" ? "center" : vertical === "bottom" ? "flex-end" : "flex-start";
      return `<div class="kimi-slide-text" style="${position}${textCss(content)}display:flex;flex-direction:column;justify-content:${justify}"><div class="kimi-text-flow">${rich(content["text"])}</div></div>`;
    }
    if (type === "image") {
      const src = str(e["src"]), path = input.files.some(f => f.path === base + src) ? base + src : src;
      return `<img alt="${esc(e["alt"])}" src="${esc(path)}" style="${position}object-fit:${obj(e["fit"])["mode"] === "cover" ? "cover" : "contain"}">`;
    }
    if (type === "shape") return `<div style="${position}background:${fill(e["fill"])};${e["border"] ? `border:${border(e["border"])};` : ""}border-radius:${["ellipse", "circle", "oval"].includes(str(e["shapeName"])) ? "50%" : `${num(e["radius"])}px`}"></div>`;
    if (type === "line") {
      const view = arr(e["viewBox"]), b = obj(e["border"]), points = str(e["points"]);
      if (!/^[\d., eE+-]+$/u.test(points)) throw new TypeError("Invalid PPTD line coordinates");
      return `<svg xmlns="http://www.w3.org/2000/svg" style="${position}overflow:visible" viewBox="0 0 ${num(view[0], w)} ${num(view[1], h)}"><polyline points="${esc(points)}" fill="none" stroke="${color(b["color"], "currentColor")}" stroke-width="${num(b["width"], 1)}"/></svg>`;
    }
    if (type === "table") {
      const rows = arr(e["rows"]), styles = obj(e["style"]), cw = arr(e["columnWidths"]), rh = arr(e["rowHeights"]);
      return `<table style="${position}border-collapse:collapse;table-layout:fixed;margin:0"><colgroup>${cw.map(v => `<col style="width:${num(v) * 100}%">`).join("")}</colgroup>${rows.map((row, r) => `<tr style="height:${num(rh[r], 1 / rows.length) * 100}%">${arr(row).map((cell, c) => {
        const s = { ...obj(styles["cellStyle"]), ...(r === 0 ? obj(styles["firstRowStyle"]) : {}), ...(c === 0 ? obj(styles["firstColumnStyle"]) : {}), ...obj(cell) };
        const borders = arr(s["border"]), borderCss = borders.map((b, i) => b ? `border-${["top", "right", "bottom", "left"][i]}:${border(b)};` : "").join("");
        return `<td style="${textCss(s)}padding:4px 6px;border:0;${borderCss}background:${fill(s["fill"])};vertical-align:${arr(s["align"])[1] === "middle" ? "middle" : "top"}">${rich(s["text"])}</td>`;
      }).join("")}</tr>`).join("")}</table>`;
    }
    // Unknown authored content stays readable; it is not silently discarded.
    return `<pre style="${position}overflow:auto">${esc(JSON.stringify(e, null, 2))}</pre>`;
  };
  const pages = new Map(arr(presentation["pages"]).map(v => { const p = obj(v); return [str(p["path"]), p] as const; }));
  const slides = arr(deck["pages"]).map((id, index) => {
    const p = pages.get(str(id)); if (!p) throw new TypeError("PPTD page reference is missing");
    const page = yaml(p["content"]);
    return { name: String(index + 1), width, height, notes: str(page["notes"]), body: `<section class="kimi-slide" data-cloudig-filebase="__cloudig_root__.html" style="position:relative;background:${fill(page["background"])}">${arr(page["elements"]).map(render).join("")}</section>` };
  });
  if (!slides.length) throw new TypeError("PPTD has no pages");
  const faces = arr(deck["customFonts"]).map(raw => {
    const f = obj(raw), source = str(f["src"]); let basename = "";
    try { basename = decodeURIComponent(new URL(source).pathname.split("/").at(-1)!); } catch { basename = source.split("/").at(-1) ?? ""; }
    const match = input.files.filter(file => file.path.split("/").at(-1) === basename && /font|sfnt/u.test(file.mime));
    return match.length === 1 ? `@font-face{font-family:${JSON.stringify(str(f["family"]))};src:url(${JSON.stringify(match[0]!.path)});font-display:block}` : "";
  }).join("");
  return { slides, css: `${faces}.kimi-slide p{margin:0;white-space:inherit}.kimi-slide .katex{font-size:1em}.kimi-slide table p{line-height:inherit}` };
}
