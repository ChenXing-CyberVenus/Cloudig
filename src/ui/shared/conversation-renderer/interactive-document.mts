import { interactiveClient } from "./interactive-client.mts";
import { interactiveReactDocument } from "./interactive-react-document.mts";
import { visualizeStyle } from "./visualize-style.mts";
import { savedWorkDocument } from "./saved-work-documents.mts";
import { prepareDesignPreview } from "./design-preview.mts";
import { INTERACTIVE_LIMITS, type InteractivePackage } from "./interactive-protocol.mts";
import { interactiveScrollFallback } from "./interactive-scroll.mts";

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
  const css = (text: string, filename: string) => text.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gu, (raw, _q: string, value: string) => {
    const target = lookup(value, filename); return target ? `url("${target}")` : raw;
  });
  for (const file of input.files.filter(f => f.mime === "text/css")) {
    const url = createUrl(css(new TextDecoder().decode(file.bytes), file.path), "text/css"); urls.set(new URL(file.path, base).href, url);
    for (const alias of file.aliases ?? []) urls.set(alias, url);
  }
  const original = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
  const parser = new document.defaultView!.DOMParser(), parsed = parser.parseFromString(input.format === "react" ? interactiveReactDocument(original, entry.path) : savedWorkDocument(input, document, original), "text/html");
  if (input.format === "design") prepareDesignPreview(parsed);
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
    const style = parsed.createElement("style"); style.textContent = visualizeStyle(input.theme === "star-night"); parsed.head.prepend(style);
    for (const icon of input.icons ?? []) {
      const url = lookup(icon.path, entry.path); if (!url) continue;
      // Icons may be created later by an authored oninput/React handler.
      // A stylesheet, unlike an initialization-only DOM scan, covers them too.
      if (/^[a-zA-Z0-9_-]+$/u.test(icon.name)) style.textContent += `\n.ti:is(.${icon.name},.ti-${icon.name}){mask-image:url(${JSON.stringify(url)})}`;
      for (const node of parsed.querySelectorAll(".ti")) if (node.classList.contains(icon.name) || node.classList.contains(`ti-${icon.name}`)) (node as HTMLElement).style.maskImage = `url("${url}")`;
    }
  }
  if (input.fontCss) { const style = parsed.createElement("style"); style.textContent = css(input.fontCss, entry.path); parsed.head.prepend(style); }
  const generatedReadView = ["document", "slides", "design-system"].includes(input.format ?? "") && !/\.html?$/iu.test(input.entry);
  if (generatedReadView) {
    parsed.documentElement.style.height = "100%"; parsed.body.style.height = "100%"; parsed.body.style.overflow = "hidden";
    const main = parsed.querySelector<HTMLElement>("main.document"); if (main) { main.style.height = "100%"; main.style.overflow = "auto"; }
    for (const node of parsed.querySelectorAll<HTMLElement>("main.document,.slide-notes,.slide-reader>nav")) node.dataset["scrollRegion"] = "";
  }
  if (input.scrollCss) { const style = parsed.createElement("style"); style.dataset["cloudigScrollFallback"] = ""; style.textContent = interactiveScrollFallback(input.scrollCss); parsed.head.prepend(style); }
  if (!parsed.documentElement.hasAttribute("data-theme") && /\[data-theme\s*=\s*["']dark["']\]/u.test(parsed.documentElement.outerHTML)) parsed.documentElement.dataset["theme"] = input.theme === "star-night" ? "dark" : "light";
  const prelude = parsed.createElement("script");
  const config = JSON.stringify({ token: input.token, state: input.state, stateLimit: INTERACTIVE_LIMITS.statePerWorkBytes, errorLimit: INTERACTIVE_LIMITS.errorMessageCharacters, theme: input.theme, scrollRegions: Boolean(input.scrollCss) }).replaceAll("<", "\\u003c");
  prelude.textContent = `(${interactiveClient.toString()})(${config});`;
  parsed.head.prepend(prelude);
  return "<!doctype html>\n" + parsed.documentElement.outerHTML;
}
