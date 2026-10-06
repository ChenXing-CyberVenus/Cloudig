import MarkdownIt from "markdown-it";
import type { InteractivePackage } from "./interactive-protocol.mts";

const escape = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(object) : [];
const markdown = new MarkdownIt({ html: false, breaks: false, typographer: false });
function source(input: InteractivePackage, path: string): string {
  const file = input.files.find(f => f.path === path); if (!file) throw new Error(`Saved work file is missing: ${path}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}
function shell(input: InteractivePackage, body: string, extra = "", script = ""): string {
  const dark = input.theme === "star-night";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:${dark ? "dark" : "light"};--paper:${dark ? "#25252e" : "#f4e9de"};--ink:${dark ? "#e2e1e1" : "#2d2d2d"};--muted:${dark ? "#b8b4c0" : "#66605e"};--edge:${dark ? "#71657e" : "#bca496"};--accent:${dark ? "#ffa92e" : "#a52525"}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.7 system-ui,sans-serif}main.document{max-width:960px;margin:0 auto;padding:32px 40px}h1,h2,h3{line-height:1.4}p{white-space:pre-wrap}table{border-collapse:collapse;width:100%}td,th{padding:10px 14px;border:1px solid var(--edge);text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{color:var(--accent);background:transparent;border:2px solid currentColor;border-radius:8px;padding:6px 12px;font:700 14px/1.4 system-ui;cursor:pointer}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.pending{border-left:3px solid var(--edge);padding:12px 16px;color:var(--muted)}.swatch{display:inline-block;width:48px;height:32px;border:1px solid var(--edge);border-radius:6px;vertical-align:middle;margin-right:12px}[hidden]{display:none!important}${extra}</style></head><body>${body}${script ? `<script>${script.replaceAll("</script", "<\\/script")}</script>` : ""}</body></html>`;
}

function xmlDocument(raw: string, document: Document, english: boolean): string {
  const xml = new document.defaultView!.DOMParser().parseFromString(raw, "application/xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "doc") throw new Error("The saved document is not valid Docs XML");
  const render = (node: Node): string => {
    if (node.nodeType === 3) return escape(node.textContent);
    if (node.nodeType !== 1) return "";
    const e = node as Element, children = () => [...e.childNodes].map(render).join("");
    if (e.localName === "doc") return children();
    if (e.localName === "text") {
      let text = children(); for (const [attr, tag] of [["bold", "strong"], ["italic", "em"], ["code", "code"]]) if (e.getAttribute(attr!) === "true") text = `<${tag}>${text}</${tag}>`; return text;
    }
    if (e.localName === "paragraph") { const h = e.getAttribute("heading"), tag = h && /^[1-6]$/u.test(h) ? `h${h}` : "p"; return `<${tag}>${children()}</${tag}>`; }
    if (e.localName === "date") return `<time>${escape(e.getAttribute("value"))}</time>`;
    if (e.localName === "mention") return `<span>${escape(e.getAttribute("name"))}</span>`;
    if (e.localName === "pending") return `<aside class="pending"><strong>${english ? "Pending in the saved document" : "原文中的待完成段落"}</strong><p>${escape(e.getAttribute("intent"))}</p></aside>`;
    if (e.localName === "break") return "<br>";
    if (["strong", "em", "code", "ul", "ol", "li", "table", "tr", "td", "th", "blockquote"].includes(e.localName)) return `<${e.localName}>${children()}</${e.localName}>`;
    return `<pre>${escape(e.outerHTML)}</pre>`; // Unknown authored nodes remain visible, not silently erased.
  };
  return render(xml.documentElement);
}

/** Serialized into the isolated running surface, never evaluated by Parser. */
function slideControls(): void {
  const viewport = document.querySelector<HTMLElement>(".slide-viewport")!, slides = [...document.querySelectorAll<HTMLElement>(".saved-slide")];
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-slide]")], count = document.querySelector(".slide-count")!, notes = document.querySelector<HTMLElement>(".slide-notes")!;
  let current = 0;
  const fit = () => { const slide = slides[current]!; slide.style.transform = `scale(${Math.min(viewport.clientWidth / 1920, viewport.clientHeight / 1080)})`; };
  const select = (index: number) => {
    current = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach((slide, i) => { slide.hidden = i !== current; }); tabs.forEach((tab, i) => tab.setAttribute("aria-current", String(i === current)));
    count.textContent = `${current + 1} / ${slides.length}`; notes.textContent = slides[current]!.dataset["notes"] ?? "";
    (document.querySelector("[data-previous]") as HTMLButtonElement).disabled = current === 0;
    (document.querySelector("[data-next]") as HTMLButtonElement).disabled = current === slides.length - 1; fit();
  };
  tabs.forEach((tab, i) => tab.addEventListener("click", () => select(i)));
  document.querySelector("[data-previous]")!.addEventListener("click", () => select(current - 1)); document.querySelector("[data-next]")!.addEventListener("click", () => select(current + 1));
  document.querySelector("[data-toggle-notes]")!.addEventListener("click", event => { notes.hidden = !notes.hidden; (event.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!notes.hidden)); fit(); });
  const resize = new ResizeObserver(fit); resize.observe(viewport); window.addEventListener("pagehide", () => resize.disconnect(), { once: true }); select(0);
}

function slidesDocument(input: InteractivePackage, document: Document): string {
  const deck = object(JSON.parse(source(input, input.entry))), order = deck["order"];
  if (!Array.isArray(order) || !order.length || order.some(id => typeof id !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(id))) throw new Error("The saved slide order is missing or invalid");
  const prefix = input.entry.slice(0, input.entry.lastIndexOf("/") + 1), parser = new document.defaultView!.DOMParser();
  const slides = order.map(id => {
    const path = `${prefix}slides/${id}.html`, parsed = parser.parseFromString(source(input, path), "text/html");
    if (parsed.querySelector("script")) throw new Error("This saved slide requires an unsupported slide script");
    const notes = [...parsed.querySelectorAll("aside")].map(n => n.textContent ?? "").join("\n"); parsed.querySelectorAll("aside").forEach(n => n.remove());
    return `<article class="saved-slide" data-cloudig-filebase="${escape(path)}" data-notes="${escape(notes)}">${parsed.head.innerHTML}${parsed.body.innerHTML}</article>`;
  });
  const english = input.language === "en", faces = Object.values(object(deck["faces"])).map(object).filter(f => typeof f["href"] === "string").map(f => `<link rel="stylesheet" href="${escape(f["href"])}">`).join("");
  return shell(input, `${faces}<div class="slide-reader"><nav>${order.map((id,i) => `<button data-slide>${i+1} · ${escape(id)}</button>`).join("")}</nav><div class="slide-viewport">${slides.join("")}</div><footer><button data-previous>${english ? "Previous" : "上一页"}</button><span class="slide-count"></span><button data-next>${english ? "Next" : "下一页"}</button><button data-toggle-notes aria-expanded="false">${english ? "Notes" : "讲稿"}</button></footer><pre class="slide-notes" hidden></pre></div>`,
    `html,body{height:100%;overflow:hidden}.slide-reader{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto auto}.slide-reader>nav,.slide-reader>footer{display:flex;align-items:center;gap:12px;padding:12px 20px;overflow:auto}.slide-viewport{min-height:0;position:relative;overflow:hidden}.saved-slide{position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:center;translate:-50% -50%;overflow:hidden}.saved-slide>section{width:100%;height:100%}.saved-slide h1,.saved-slide h2,.saved-slide h3,.saved-slide p{margin:0}.slide-notes{max-height:25vh;padding:12px 20px;overflow:auto;margin:0}.slide-reader button[aria-current="true"]{background:var(--accent);color:var(--paper)}button:disabled{opacity:.4;cursor:default}`, `(${slideControls.toString()})();`);
}

function designSystemDocument(input: InteractivePackage): string {
  const system = object(JSON.parse(source(input, input.entry))), prefix = input.entry.slice(0, input.entry.lastIndexOf("/") + 1);
  const tokens = object(JSON.parse(source(input, `${prefix}tokens.json`))), colors = object(tokens["color"]), themes = rows(colors["themes"]), english = input.language === "en";
  const colorRows = rows(colors["tokens"]).map(token => `<tr><th>${escape(token["name"])}</th>${themes.map(theme => {
    const value = object(token["value"])[String(theme["id"])];
    // Only CSS colors reach a style attribute; arbitrary source strings stay text.
    const color = typeof value === "string" && /^(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\([\d.% ,+-]+\))$/iu.test(value) ? value : "transparent";
    return `<td><span class="swatch" style="background:${escape(color)}"></span><code>${escape(value)}</code></td>`;
  }).join("")}<td>${escape(token["usage"])}</td></tr>`).join("");
  const types = object(tokens["type"]), families = object(types["families"]);
  const typeRows = rows(types["groups"]).flatMap(group => rows(group["styles"]).map(style => `<tr><td>${escape(group["name"])}/${escape(style["name"])}</td><td>${escape(families[String(group["family"])])}</td><td>${escape(style["fontSize"])}</td><td>${escape(style["lineHeight"])}</td><td>${escape(style["fontWeight"])}</td></tr>`)).join("");
  const measures = ["spacing", "radius"].map(key => `<h2>${english ? key : key === "spacing" ? "间距" : "圆角"}</h2><table>${rows(object(tokens[key])["tokens"]).map(token => `<tr><th>${escape(token["name"])}</th><td>${escape(token["value"])}</td><td>${escape(token["usage"])}</td></tr>`).join("")}</table>`).join("");
  const readme = object(system["docs"])["readme"], intro = typeof readme === "string" ? markdown.render(source(input, readme)) : `<h1>${escape(system["title"])}</h1>`;
  return shell(input, `<main class="document">${intro}<h2>${english ? "Colors" : "颜色"}</h2><table><thead><tr><th>${english ? "Name" : "名称"}</th>${themes.map(t => `<th>${escape(t["name"])}</th>`).join("")}<th>${english ? "Usage" : "用途"}</th></tr></thead><tbody>${colorRows}</tbody></table><h2>${english ? "Typography" : "文字"}</h2><table><thead><tr>${(english ? ["Style","Family","Size","Line height","Weight"] : ["样式","字体","字号","行高","字重"]).map(t => `<th>${t}</th>`).join("")}</tr></thead><tbody>${typeRows}</tbody></table>${measures}</main>`);
}

/** Format-specific read views. Original resources and their bytes stay intact. */
export function savedWorkDocument(input: InteractivePackage, document: Document, raw: string): string {
  if (input.format === "slides") return slidesDocument(input, document);
  if (input.format === "design-system") return designSystemDocument(input);
  if (input.format !== "document") return raw;
  if (/\.html?$/iu.test(input.entry)) return raw;
  const body = /\.xml$/iu.test(input.entry) ? xmlDocument(raw, document, input.language === "en") : markdown.render(raw);
  return shell(input, `<main class="document">${body}</main>`);
}
