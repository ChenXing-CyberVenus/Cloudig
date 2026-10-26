import { interactiveClient } from "./interactive-client.mts";
import { interactiveReactDocument, interactiveProjectDocument } from "./interactive-react-document.mts";
import { visualizeStyle } from "./visualize-style.mts";
import { savedWorkDocument } from "./saved-work-documents.mts";
import { prepareDesignPreview } from "./design-preview.mts";
import { INTERACTIVE_LIMITS, type InteractivePackage } from "./interactive-protocol.mts";
import { interactiveScrollFallback } from "./interactive-scroll.mts";
import { installWorkLocalFiles } from "./interactive-local-files.mts";
import { isBinaryPreview, isMediaPreview, previewTarget } from "./file-preview-policy.mts";

/** Native Canvas sources may wrap the entire document in one Markdown fence.
 * Strip only that transport wrapper in the running copy; source/download bytes
 * retain it, and ordinary prose containing a fence is not an HTML program. */
export function unwrapWorkDocument(source: string): string {
  const lines = source.split(/\r\n|\n|\r/u);
  const first = /^\s*(`{3,}|~{3,})(?:html|svg)\s*$/iu.exec(lines[0] ?? "");
  if (!first) return source;
  let end = lines.length - 1; while (end > 0 && !lines[end]!.trim()) end--;
  const close = lines[end]!.trim();
  if (close.length < first[1]!.length || [...close].some(c => c !== first[1]![0])) return source;
  const body = lines.slice(1, end).join("\n");
  return /^\s*(?:<!doctype html>|<html\b|<svg\b)/iu.test(body) ? body : source;
}

/** Compile a running COPY. The original source/resources are never modified. */
export function prepareInteractiveHtml(input: InteractivePackage, document: Document, createUrl: (bytes: ArrayBuffer | string, mime: string) => string): string {
  const entry = input.files.find(file => file.path === input.entry); if (!entry) throw new TypeError("The saved work has no entry file");
  const urls = new Map<string, string>(), base = "https://cloudig-file.invalid/";
  for (const file of input.files) {
    if (urls.has(new URL(file.path, base).href)) throw new TypeError(`Duplicate work path: ${file.path}`);
    const url = createUrl(file.bytes, file.mime); urls.set(new URL(file.path, base).href, url);
    for (const alias of file.aliases ?? []) urls.set(alias, url);
  }
  const lookup = (value: string, filename: string): string | undefined => urls.get(value) ?? urls.get(new URL(value, new URL(filename, base)).href);
  const localFontSheet = (url: string) => new URL(url.replaceAll("&amp;", "&")).searchParams.getAll("family").flatMap(f => f.split("|")).every(f => input.fontCss?.includes(`font-family:${JSON.stringify(f.split(":", 1)[0])}`));
  const css = (text: string, filename: string) => text.replace(/@import\s+url\(\s*(["'])(https:\/\/fonts\.googleapis\.com\/[^"']+)\1\s*\)\s*;/gu,
    (raw, _quote: string, url: string) => localFontSheet(url) ? "" : raw).replace(/url\(\s*(["']?)(.*?)\1\s*\)/gu, (raw, _q: string, value: string) => {
    const target = lookup(value, filename); return target ? `url("${target}")` : raw;
  });
  for (const file of input.files.filter(f => f.mime === "text/css")) {
    const url = createUrl(css(new TextDecoder().decode(file.bytes), file.path), "text/css"); urls.set(new URL(file.path, base).href, url);
    for (const alias of file.aliases ?? []) urls.set(alias, url);
  }
  const preview = previewTarget(input);
  const original = isBinaryPreview(preview) || isMediaPreview(preview) || preview?.mime.startsWith("image/") ? "" : new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
  const project = input.format === "react" && !!input.data?.["project"];
  const parser = new document.defaultView!.DOMParser(), parsed = parser.parseFromString(input.format === "react" ? project ? interactiveProjectDocument(input.files.filter(f => !f.path.startsWith("__cloudig_")).map(f => ({ path:f.path, url:lookup(f.path,"index.html")!, ...(/\.[cm]?[jt]sx?$|\.json$/iu.test(f.path) ? {source:new TextDecoder("utf-8",{fatal:true}).decode(f.bytes)} : {}) })), entry.path, input.language === "en") : interactiveReactDocument(original, entry.path) : savedWorkDocument(input, document, input.format === "html" || input.format === "svg" ? unwrapWorkDocument(original) : original), "text/html");
  // Independent HTML has the browser's light canvas unless its author opts
  // into a theme. Forcing dark on a transparent fragment with fixed #333 ink
  // destroys its contrast. Platform theme contracts and generated read views
  // can follow Cloudig; authored CSS always outranks this fallback layer.
  const themeAware = input.source === "claude.ai_visualize" || input.source === "kimi.com_widget" || input.format === "svg" ||
    [...parsed.querySelectorAll("style")].some(style => /color-scheme\s*:|prefers-color-scheme|\[data-theme\s*=/iu.test(style.textContent ?? ""));
  const scheme=parsed.createElement("style");scheme.dataset["cloudigCanvasScheme"]="";
  scheme.textContent=`@layer cloudig-work-defaults { :root { color-scheme: light; } ${themeAware?':root[data-cloudig-theme="star-night"]{color-scheme:dark}':""} }`;
  parsed.head.prepend(scheme);
  if(isMediaPreview(preview)){
    const mediaCss=input.files.find(file=>file.aliases?.includes("cloudig-runtime:media-controls-css"));
    if(mediaCss){const style=parsed.createElement("style");style.dataset["cloudigMediaControls"]="";style.textContent=new TextDecoder().decode(mediaCss.bytes);parsed.head.append(style);}
  }
  if (input.format === "design") prepareDesignPreview(parsed);
  if (isBinaryPreview(preview)) {
    const script = parsed.createElement("script"); script.src = "cloudig-runtime:file-preview"; parsed.head.append(script);
  }
  if (input.preview && parsed.querySelector("pre > code.language-mermaid")) {
    const script = parsed.createElement("script"); script.src = "cloudig-runtime:document-preview"; parsed.head.append(script);
  }
  for (const map of parsed.querySelectorAll('script[type="importmap"]')) {
    const value = JSON.parse(map.textContent ?? "{}");
    const rewrite = (items: unknown) => {
      if (!items || typeof items !== "object" || Array.isArray(items)) return;
      for (const [name, target] of Object.entries(items)) if (typeof target === "string") {
        const found = lookup(target, entry.path); if (found) (items as Record<string, string>)[name] = found;
      }
    };
    rewrite(value.imports); for (const items of Object.values(value.scopes ?? {})) rewrite(items);
    map.textContent = JSON.stringify(value).replaceAll("<", "\\u003c");
  }
  for (const node of parsed.querySelectorAll('base,meta[http-equiv],link[rel="preconnect"],link[rel="dns-prefetch"]')) node.remove();
  for (const node of parsed.querySelectorAll("[src],[href],[poster]")) {
    for (const attr of ["src", "href", "poster"]) {
      const raw = node.getAttribute(attr); if (!raw || raw.startsWith("#") || raw.startsWith("data:")) continue;
      const filename = node.closest("[data-cloudig-filebase]")?.getAttribute("data-cloudig-filebase") ?? entry.path;
      const target = lookup(raw, filename);
      if (target) node.setAttribute(attr, target);
      else if (node.localName === "link" && raw.startsWith("https://fonts.googleapis.com/")) {
        const families = new URL(raw).searchParams.getAll("family").map(f => f.split(":", 1)[0]!);
        if (!families.length || families.some(f => !input.fontCss?.includes(`font-family:${JSON.stringify(f)}`))) throw new TypeError(`Font stylesheet is not bundled: ${raw}`);
        node.remove();
      }
      else if (node.localName === "script" || node.localName === "link" && node.getAttribute("rel") === "stylesheet") throw new TypeError(`Dependency is not bundled: ${raw}`);
    }
  }
  for (const style of parsed.querySelectorAll("style")) style.textContent = css(style.textContent ?? "", style.closest("[data-cloudig-filebase]")?.getAttribute("data-cloudig-filebase") ?? entry.path);
  for (const node of parsed.querySelectorAll("[style]")) node.setAttribute("style", css(node.getAttribute("style")!, node.closest("[data-cloudig-filebase]")?.getAttribute("data-cloudig-filebase") ?? entry.path));
  if (input.source === "claude.ai_visualize") {
    for (const theme of ["dawn", "star-night"] as const) {
    const style = parsed.createElement("style"); style.dataset["cloudigThemeStyle"] = theme; style.media = theme === input.theme ? "all" : "not all"; style.textContent = visualizeStyle(theme === "star-night"); parsed.head.prepend(style);
    for (const icon of input.icons ?? []) {
      const url = lookup(icon.path, entry.path); if (!url) continue;
      // Icons may be created later by an authored oninput/React handler.
      // A stylesheet, unlike an initialization-only DOM scan, covers them too.
      if (/^[a-zA-Z0-9_-]+$/u.test(icon.name)) style.textContent += `\n.ti:is(.${icon.name},.ti-${icon.name}){mask-image:url(${JSON.stringify(url)})}`;
      for (const node of parsed.querySelectorAll(".ti")) if (node.classList.contains(icon.name) || node.classList.contains(`ti-${icon.name}`)) (node as HTMLElement).style.maskImage = `url("${url}")`;
    }
  }
  }
  if (input.source === "kimi.com_widget") {
    for (const theme of ["dawn", "star-night"] as const) {
    const defaults = parsed.createElement("style"), captured = input.data?.["host_style"];
    const variables: Record<string, string> = {};
    if (captured && typeof captured === "object" && !Array.isArray(captured)) for (const [name, value] of Object.entries(captured)) {
      if (/^--kimi-[a-z\d-]+$/u.test(name) && typeof value === "string" && !/[;{}<>]/u.test(value)) variables[name] = value;
    }
    if (theme === "star-night") Object.assign(variables, { "--kimi-color-text-primary": "#e2e1e1", "--kimi-color-text-secondary": "#c9c1d0", "--kimi-color-text-tertiary": "#b0a6ba", "--kimi-color-text-quaternary": "#93879f", "--kimi-color-surface": "#292631", "--kimi-color-surface-muted": "#ffffff0b", "--kimi-color-border": "#b5a5c34d" });
    else Object.assign(variables, { "--kimi-color-surface": "#f4e9de", "--kimi-color-surface-muted": "#5b392308", "--kimi-color-border": "#8a665a40" });
    defaults.textContent = `@layer cloudig-work-defaults{:root{${Object.entries(variables).map(([k, v]) => `${k}:${v}`).join(";")}}@layer cloudig-work-defaults{body{color:var(--kimi-color-text-primary);font:16px/1.5 var(--kimi-font-sans);margin:12px}*{box-sizing:border-box}button,input,select,textarea{font:inherit;color:var(--kimi-color-text-primary);accent-color:${theme === "star-night" ? "#a38bcd" : "#aa2427"}}button,select,textarea,input:not([type=range]):not([type=checkbox]):not([type=radio]){background:var(--kimi-color-surface);border:1px solid var(--kimi-color-border);border-radius:8px;padding:6px 10px}button{cursor:pointer}button:hover{background:var(--kimi-color-surface-muted)}}`;
    defaults.dataset["cloudigThemeStyle"]=theme; defaults.media=theme===input.theme?"all":"not all";
    parsed.head.prepend(defaults);
    }
  }
  if (input.fontCss) { const style = parsed.createElement("style"); style.textContent = css(input.fontCss, entry.path); parsed.head.prepend(style); }
  const generatedReadView = ["document", "slides", "design-system"].includes(input.format ?? "") && (!/\.html?$/iu.test(input.entry) || !!parsed.querySelector("[data-cloudig-read-view]"));
  if (generatedReadView) {
    for (const code of parsed.querySelectorAll("pre > code")) {
      const language = /(?:^|\s)language-([\w+-]+)/u.exec(code.className)?.[1];
      if (language) code.parentElement!.setAttribute("data-language", language);
    }
    const math = input.files.find(file => file.aliases?.includes("cloudig-runtime:document-math"));
    if (math && parsed.querySelector(".katex")) {
      const style = parsed.createElement("style"); style.dataset["cloudigDocumentMath"] = "";
      style.textContent = new TextDecoder().decode(math.bytes); parsed.head.append(style);
    }
    const typography = parsed.createElement("style"); typography.dataset["cloudigDocumentTypography"] = "";
    typography.textContent = `main.document{overflow-wrap:anywhere}main.document> :first-child{margin-top:0}blockquote{margin:1.2em 0;padding:.55em 1em;border-left:3px solid var(--accent);color:var(--muted)}blockquote>:first-child{margin-top:0}blockquote>:last-child{margin-bottom:0}blockquote>p{white-space:normal}main.document .katex-display{display:block;margin:1em 0;text-align:center;overflow-x:auto;overflow-y:hidden;padding:.3em 0}main.document .katex{white-space:normal}.cloudig-task-check{accent-color:var(--accent)}`;
    parsed.head.append(typography);
    // Documents and tables have natural flow height. Forcing 100% here made
    // the common size reporter treat even a short note as a full-screen scene.
    // Slides declare their own viewport layout; do not override either kind.
    for (const node of parsed.querySelectorAll<HTMLElement>("main.document,.slide-notes,.slide-reader>nav")) node.dataset["scrollRegion"] = "";
  }
  if (input.scrollCss) { const style = parsed.createElement("style"); style.dataset["cloudigScrollFallback"] = ""; style.textContent = interactiveScrollFallback(input.scrollCss); parsed.head.prepend(style); }
  if (!parsed.documentElement.hasAttribute("data-theme") && /\[data-theme\s*=\s*["']dark["']\]/u.test(parsed.documentElement.outerHTML)) { parsed.documentElement.dataset["cloudigManagedTheme"] = ""; parsed.documentElement.dataset["theme"] = input.theme === "star-night" ? "dark" : "light"; }
  const prelude = parsed.createElement("script");
  const config = JSON.stringify({ token: input.token, state: input.state, stateLimit: INTERACTIVE_LIMITS.statePerWorkBytes, errorLimit: INTERACTIVE_LIMITS.errorMessageCharacters, theme: input.theme, scrollRegions: Boolean(input.scrollCss), ...(input.documents?{documents:input.documents}:{}), ...(input.bindings ? { bindings: input.bindings } : {}) }).replaceAll("<", "\\u003c");
  prelude.textContent = `(${interactiveClient.toString()})(${config});`;
  parsed.head.prepend(prelude);
  const local = parsed.createElement("script");
  const mapping = JSON.stringify([...urls]).replaceAll("<", "\\u003c");
  const python = [...urls.keys()].find(url => /^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v[\d.]+\/full\/pyodide\.js$/u.test(url));
  local.textContent = `(${installWorkLocalFiles.toString()})(${mapping},${JSON.stringify(python?.slice(0, -"pyodide.js".length)) ?? "undefined"});`;
  parsed.head.prepend(local);
  // Native import() is handled by the module loader, not window.fetch. An
  // import map preserves exact captured/public aliases for dynamic imports.
  const imports = parsed.createElement("script"); imports.type = "importmap";
  imports.textContent = JSON.stringify({ imports: Object.fromEntries(urls) }).replaceAll("<", "\\u003c");
  parsed.head.prepend(imports);
  return "<!doctype html>\n" + parsed.documentElement.outerHTML;
}
