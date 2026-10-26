import { createMarkdownRenderer } from "./content-runtime.mts";
import type { InteractivePackage } from "./interactive-protocol.mts";
import { savedSpreadsheet } from "./saved-spreadsheet.mts";
import { nativeSlides, type SavedSlide } from "./native-slides.mts";
import { savedResearch } from "./saved-research.mts";
import { isBinaryPreview, isMediaPreview, previewKind, previewTarget } from "./file-preview-policy.mts";
import createDOMPurify from "dompurify";
import { savedMistralSlides } from "./mistral-slides.mts";
import { kimiSlides } from "./kimi-slides.mts";

const escape = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(object) : [];
const markdown = createMarkdownRenderer({ localResources: true });
function source(input: InteractivePackage, path: string): string {
  const file = input.files.find(f => f.path === path); if (!file) throw new Error(`Saved work file is missing: ${path}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}
function shell(input: InteractivePackage, body: string, extra = "", script = ""): string {
  return `<!doctype html><html lang="${input.language === "en" ? "en" : "zh"}" data-cloudig-theme="${input.theme}"><head><meta charset="utf-8"><style>
:root{color-scheme:light;--paper:#f4e9de;--ink:#2d2d2d;--muted:#66605e;--edge:#bca496;--accent:#a52525;--keyword:#752b75;--string:#5a7035;--number:#a04d22}
:root[data-cloudig-theme="star-night"]{color-scheme:dark;--paper:#25252e;--ink:#e2e1e1;--muted:#b8b4c0;--edge:#71657e;--accent:#ffa92e;--keyword:#dbb2ef;--string:#c8d8a6;--number:#ffca83}
.office-presentation{height:100%;overflow:hidden}.office-presentation .office-deck{margin-inline:auto}
main.document pre[data-language]::before{content:attr(data-language);display:block;margin:-18px -20px 16px;padding:7px 20px;border-bottom:1px solid var(--edge);font:600 13px/1.5 system-ui;color:var(--muted)}
main.document pre{position:relative;padding:18px 20px;margin:20px 0;border:1px solid var(--edge);border-radius:8px;background:color-mix(in srgb,var(--ink) 5%,var(--paper));line-height:1.6;white-space:pre;overflow:auto}main.document code{font-family:Consolas,monospace;font-size:.9em}main.document :not(pre)>code{background:color-mix(in srgb,var(--ink) 7%,transparent);border-radius:4px;padding:2px 5px}main.document a{color:var(--accent)}main.document :is(h1,h2,h3){margin:1.6em 0 .6em}main.document :is(p,ul,ol){margin:.9em 0}.footnotes{font-size:14px;color:var(--muted)}.footnote-ref a{text-decoration:none}.footnotes-sep{border:0;border-top:1px solid var(--edge);margin-top:32px}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--keyword)}.hljs-string,.hljs-attr{color:var(--string)}.hljs-number,.hljs-title{color:var(--number)}.hljs-comment{color:var(--muted)}.saved-diagram{margin:24px 0;padding:16px;border:1px solid var(--edge);border-radius:8px}.saved-diagram>button{display:block;margin-left:auto}.saved-diagram svg{display:block;margin:12px auto;max-width:100%;height:auto}
blockquote{border-left:3px solid var(--edge);margin:1em 0;padding:12px 16px;color:var(--muted)}:is(blockquote,.pending)>:first-child{margin-top:0}:is(blockquote,.pending)>:last-child{margin-bottom:0}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.7 system-ui,sans-serif}main.document{max-width:960px;margin:0 auto;padding:32px 40px}h1,h2,h3{line-height:1.4}p{white-space:pre-wrap}table{border-collapse:collapse;width:100%}td,th{padding:10px 14px;border:1px solid var(--edge);text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{color:var(--accent);background:transparent;border:2px solid currentColor;border-radius:8px;padding:6px 12px;font:700 14px/1.4 system-ui;cursor:pointer}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.pending{border-left:3px solid var(--edge);padding:12px 16px;color:var(--muted)}.swatch{display:inline-block;width:48px;height:32px;border:1px solid var(--edge);border-radius:6px;vertical-align:middle;margin-right:12px}[hidden]{display:none!important}${extra}</style></head><body>${body}${script ? `<script>${script.replaceAll("</script", "<\\/script")}</script>` : ""}</body></html>`;
}

function xmlDocument(raw: string, document: Document, english: boolean): string {
  const xml = new document.defaultView!.DOMParser().parseFromString(raw, "application/xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "doc") throw new Error("The saved document is not valid Docs XML");
  const render = (node: Node): string => {
    // Pretty-print whitespace between XML elements is not authored prose.
    // Whitespace inside <text>/<code> remains exact, including intentional lines.
    if (node.nodeType === 3) return node.textContent?.trim() || ["text", "code", "pre"].includes(node.parentElement?.localName ?? "") ? escape(node.textContent) : "";
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
  const rendered = render(xml.documentElement);
  // A valid exported Docs node can contain only an empty paragraph. Show an
  // honest empty document, not a visually blank work that resembles loading.
  if (!xml.documentElement.textContent?.trim() && [...xml.documentElement.querySelectorAll("*")].every(e => ["paragraph", "text", "break"].includes(e.localName)))
    return `<p class="saved-document-empty">${english ? "This saved document has no body text. You can still view its source." : "这份保存的文档没有正文，仍可查看源码。"}</p>`;
  return rendered;
}

/** Serialized into the isolated running surface, never evaluated by Parser. */
function slideControls(): void {
  const viewport = document.querySelector<HTMLElement>(".slide-viewport")!, slides = [...document.querySelectorAll<HTMLElement>(".saved-slide")];
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-slide]")], count = document.querySelector(".slide-count")!, notes = document.querySelector<HTMLElement>(".slide-notes")!;
  let current = 0;
  const fit = () => { const slide = slides[current]!; slide.style.transform = `scale(${Math.min(viewport.clientWidth / Number(slide.dataset["width"]), viewport.clientHeight / Number(slide.dataset["height"]))})`; };
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
  if (input.source === "www.doubao.com_slides") return slidesShell(input, nativeSlides(input, source(input,input.entry), document));
  const deck = object(JSON.parse(source(input, input.entry))), order = deck["order"];
  if (!Array.isArray(order) || !order.length || order.some(id => typeof id !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(id))) throw new Error("The saved slide order is missing or invalid");
  const prefix = input.entry.slice(0, input.entry.lastIndexOf("/") + 1), parser = new document.defaultView!.DOMParser();
  const slides = order.map(id => {
    // Saved groups exist in both native directory and flat-download layouts.
    // Require one exact declared file, never a basename search across the work.
    const candidates = [`${prefix}slides/${id}.html`, `${prefix}${id}.html`].filter(path => input.files.some(file => file.path === path));
    if (candidates.length !== 1) throw new Error(candidates.length ? `Saved slide path is ambiguous: ${id}` : `Saved work file is missing: ${prefix}slides/${id}.html`);
    const path = candidates[0]!, parsed = parser.parseFromString(source(input, path), "text/html");
    if (parsed.querySelector("script")) throw new Error("This saved slide requires an unsupported slide script");
    const notes = [...parsed.querySelectorAll("aside")].map(n => n.textContent ?? "").join("\n"); parsed.querySelectorAll("aside").forEach(n => n.remove());
    return {name:String(id),width:1920,height:1080,notes,body:`<div data-cloudig-filebase="${escape(path)}">${parsed.head.innerHTML}${parsed.body.innerHTML}</div>`};
  });
  const faces = Object.values(object(deck["faces"])).map(object).filter(f => typeof f["href"] === "string").map(f => `<link rel="stylesheet" href="${escape(f["href"])}">`).join("");
  return slidesShell(input,slides,faces);
}

function slidesShell(input: InteractivePackage, slides: readonly SavedSlide[], faces=""): string {
  const english=input.language==="en";
  // Native slide themes may style every footer/nav. Our reader controls are
  // outside the authored canvas and must not inherit slide positioning.
  if(input.data?.["presentation"])faces+=`<style>.slide-reader>nav,.slide-reader>footer{all:revert;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:12px 20px;overflow:auto;position:relative;width:auto;height:auto;margin:0;color:var(--ink);background:var(--paper);font:16px/1.5 system-ui,sans-serif}.slide-reader>nav button,.slide-reader>footer button{position:static;flex:none;color:var(--accent);height:auto;line-height:1.4}.slide-reader>footer .slide-count{color:var(--ink)}</style>`;
  return shell(input, `${faces}<div class="slide-reader"><nav>${slides.map((slide,i) => `<button data-slide>${i+1}${slide.name===String(i+1)?"":` · ${escape(slide.name)}`}</button>`).join("")}</nav><div class="slide-viewport">${slides.map(slide=>`<article class="saved-slide" data-width="${slide.width}" data-height="${slide.height}" data-notes="${escape(slide.notes)}" style="width:${slide.width}px;height:${slide.height}px">${slide.body}</article>`).join("")}</div><footer><button data-previous>${english ? "Previous" : "上一页"}</button><span class="slide-count"></span><button data-next>${english ? "Next" : "下一页"}</button><button data-toggle-notes aria-expanded="false">${english ? "Notes" : "讲稿"}</button></footer><pre class="slide-notes" hidden></pre></div>`,
    `html,body{height:100%;overflow:hidden}.slide-reader{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto auto}.slide-reader>nav,.slide-reader>footer{display:flex;align-items:center;gap:12px;padding:12px 20px;overflow:auto}.slide-viewport{min-height:0;position:relative;overflow:hidden}.saved-slide{position:absolute;left:50%;top:50%;transform-origin:center;translate:-50% -50%;overflow:hidden}.saved-slide>section,.saved-slide>div,.saved-slide>div>section{width:100%;height:100%}.saved-slide h1,.saved-slide h2,.saved-slide h3,.saved-slide p{margin:0}.slide-notes{max-height:25vh;padding:12px 20px;overflow:auto;margin:0}.slide-reader button[aria-current="true"]{background:var(--accent);color:var(--paper)}button:disabled{opacity:.4;cursor:default}`, `(${slideControls.toString()})();`);
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
  if (input.source === "kimi.com_pptd" && input.format === "slides") {
    const deck = kimiSlides(input, document);
    return slidesShell(input, deck.slides, `<style data-cloudig-filebase="__cloudig_root__.html">${deck.css.replace(/<\/style/giu, "<\\/style")}</style>`);
  }
  if (input.source === "chat.mistral.ai_slides" && input.format === "slides" && input.data?.["presentation"]) {
    const deck=savedMistralSlides(input,document);
    return slidesShell(input,deck.slides,`<style>${deck.css.replace(/<\/style/giu,"<\\/style")}</style>`);
  }
  const preview = previewTarget(input);
  if (isBinaryPreview(preview)) return shell(input, '<main id="cloudig-file-preview"></main>',
    `html,body{height:100%}#cloudig-file-preview{min-height:100%;padding:20px}.office-docx-wrapper{background:transparent!important;padding:0!important}.office-docx-wrapper>section{margin:16px auto!important}.office-status{text-align:center}.office-toolbar{display:flex;justify-content:center;align-items:center;gap:16px;margin:12px}.office-canvas{display:block;max-width:100%;height:auto;margin:auto;background:white}.office-deck{width:100%}.saved-sheet{margin:0 0 20px}.saved-sheet summary{font-weight:700;cursor:pointer;padding:12px 0}.saved-sheet-scroll{max-width:100%;overflow:auto}.saved-sheet th[scope=row]{font-size:12px;padding:0;text-align:center;background:#eee;color:#555}`);
  if (input.preview && preview) {
    const kind=previewKind(preview.path,preview.mime);
    if (isMediaPreview(preview)) return shell(input, `<main class="document saved-media"><${kind} controls preload="metadata" src="${escape(preview.path)}"></${kind}></main>`, `${kind==="audio"?"html,body{height:auto}main.saved-media{min-height:260px}":"html,body{height:100%}main.saved-media{min-height:100%}"}main.saved-media{display:flex;align-items:center;justify-content:center;width:100%;padding:24px 32px}.saved-media :is(audio,video){width:100%;max-height:calc(100dvh - 48px)}`);
    if (["png","jpg","jpeg","webp","gif","svg"].includes(kind??"")) return shell(input,`<main class="document"><img alt="" src="${escape(preview.path)}" style="max-width:100%;height:auto"></main>`);
    // An HTML attachment is a document, not executable work. Preserve its
    // layout in the isolated reading window, remove active author content;
    // the original downloadable bytes remain untouched.
    if (kind === "html" || kind === "htm") return createDOMPurify(document.defaultView!).sanitize(raw, {
      WHOLE_DOCUMENT: true, USE_PROFILES: { html: true, svg: true, svgFilters: true },
      FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form"], FORBID_ATTR: ["srcdoc"]
    });
    return shell(input,`<main class="document">${kind==="md"?markdown.render(raw):`<pre>${escape(raw)}</pre>`}</main>`);
  }
  if (input.source === "gemini.google.com_research") {
    const research=savedResearch(input,raw,document);
    if(research!==undefined)return shell(input,`<main class="document">${research}</main>`,`.research-visual{margin:28px 0}.research-visual button{display:block;width:100%;padding:0;overflow:hidden}.research-visual img{display:block;width:auto;max-width:100%;height:auto;margin-inline:auto}.research-visual button>span{display:block;padding:12px}.research-visual figcaption{margin-top:8px;color:var(--muted)}.research-sources li{margin:16px 0}.research-url{overflow-wrap:anywhere;font-size:14px;color:var(--muted)}.research-process summary{cursor:pointer;padding:10px 0}.research-process>details{margin-left:20px}sup a{color:var(--accent);text-decoration:none}sup{margin-inline:3px}`);
  }
  if (input.source === "www.doubao.com_slides") return slidesDocument(input, document);
  if (input.source === "www.doubao.com_spreadsheet") return shell(input, `<main class="document">${savedSpreadsheet(raw, document)}</main>`,
    `main.document{max-width:none}.saved-sheet{margin:0 0 20px}.saved-sheet summary{font-weight:700;cursor:pointer;padding:12px 0}.saved-sheet-scroll{max-width:100%;overflow:auto}.saved-sheet table{table-layout:fixed;width:max(100%,calc(3em + var(--sheet-columns)*12em))}.saved-sheet .sheet-row-number{width:3em}.saved-sheet td{white-space:pre-wrap;overflow-wrap:anywhere}.saved-sheet th[scope=row]{color:var(--muted);font-size:13px}.saved-sheet .sheet-gap{min-width:0}`);
  if (/^chat\.mistral\.ai_(?:slides|spreadsheet)$/u.test(input.source ?? "") && /\.html?$/iu.test(input.entry)) {
    // The captured preview is a readable slide/sheet outline, not a full
    // Office layout. Keep its content, expose the first page, and scroll wide
    // sheets locally instead of compressing columns into single letters.
    const parsed=new document.defaultView!.DOMParser().parseFromString(raw,"text/html");
    parsed.querySelector("details.osis-work-slide,details.osis-work-sheet")?.setAttribute("open", "");
    for(const table of parsed.querySelectorAll("table")) {const scroll=parsed.createElement("div");scroll.className="saved-sheet-scroll";table.before(scroll);scroll.append(table);}
    return shell(input,`<main class="document saved-office-preview">${parsed.body.innerHTML}</main>`,
      `.saved-office-preview details{margin:0 0 18px;border:1px solid var(--edge);border-radius:8px;overflow:hidden}.saved-office-preview summary{cursor:pointer;padding:12px 18px;font-weight:700;background:color-mix(in srgb,var(--accent) 7%,transparent)}.saved-office-preview .osis-rich{padding:10px 24px 24px}.saved-office-preview .saved-sheet-scroll{max-width:100%;overflow:auto}.saved-office-preview table{width:max-content;min-width:100%}.saved-office-preview td,.saved-office-preview th{min-width:7em;max-width:34em;white-space:normal;overflow-wrap:normal}`);
  }
  if (input.format === "slides") return slidesDocument(input, document);
  if (input.format === "design-system") return designSystemDocument(input);
  if (input.format !== "document") return raw;
  if (/\.html?$/iu.test(input.entry)) return /<html(?:\s|>)/iu.test(raw) ? raw : shell(input, `<main class="document" data-cloudig-read-view>${raw}</main>`);
  const body = /\.xml$/iu.test(input.entry) ? xmlDocument(raw, document, input.language === "en") : markdown.render(raw);
  return shell(input, `<main class="document">${body}</main>`);
}
