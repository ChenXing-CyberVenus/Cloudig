import {
  defaultTreeAdapter,
  html,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes
} from "parse5";
import type { JsonObject } from "../../core/contracts/types.mts";
import { HTML_IMAGE_RESOURCE } from "../../core/records/html-resources.mts";

const DROP_HTML = new Set(["base", "link", "meta", "script", "style", "template"]);
const DROP_SVG = new Set(["animate", "animatemotion", "animatetransform", "discard", "set"]);
const NEUTRAL_BLOCK = new Set(["audio", "canvas", "embed", "form", "iframe", "object", "video"]);
const NEUTRAL_INLINE = new Set(["button", "input", "option", "select", "textarea"]);
const DROP_ATTRIBUTES = new Set([
  "action", "autofocus", "autoplay", "crossorigin", "formaction", "integrity", "method",
  "nonce", "ping", "poster", "sandbox", "src", "srcdoc", "srcset", "target"
]);
const UNSAFE_CSS = /(?:@import|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding\s*:)/iu;

function hasExternalCss(value: string): boolean {
  // Local SVG paint servers are geometry, not network access. Retain gradients,
  // arrowheads, clipping and filters such as url(#arrow), including quoted IDs.
  return UNSAFE_CSS.test(value) || /url\s*\(/iu.test(value.replace(/url\(\s*(?:"#[^"\r\n]+"|'#[^'\r\n]+'|#[^\s)'"\\]+)\s*\)/giu, ""));
}

type Parent = DefaultTreeAdapterTypes.ParentNode;
type Child = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

function isElement(node: Child): node is Element {
  return "tagName" in node;
}

function elements(parent: Parent): Element[] {
  return parent.childNodes.flatMap(node => isElement(node) ? [node, ...elements(node)] : []);
}

export function capturedMathIsDisplay(node: Element): boolean {
  const declared = node.attrs.find(attr => attr.name === "data-math-display")?.value;
  return declared === "true" || declared === "block" || elements(node).some(child => child.tagName === "math" && child.attrs.some(attr => attr.name === "display" && attr.value === "block"));
}

export function capturedMathHasTextFrame(node: Element): boolean {
  return elements(node).some(child => child.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).includes("osis-temml-textbox-content")));
}

export function compactCapturedMath(parent: Parent): void {
  parent.childNodes = parent.childNodes.map(child => {
    if (!isElement(child)) return child;
    if (child.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).includes("katex"))) {
      const math = elements(child).find(node => node.tagName === "math");
      if (math) { defaultTreeAdapter.detachNode(math); math.parentNode = parent; return math; }
    }
    compactCapturedMath(child); return child;
  });
}

// Only an exact, text-only saved panel can replace the vendor Markdown fallback.
// Images/diagrams stay on the Adapter's occurrence-aware resource projection.
export function capturedTextPanel(html: string | undefined, panelClass: string, directChildTag?: string, excludedDirectClasses: readonly string[] = []): string | undefined {
  if (!html) return undefined;
  const panels = elements(parseFragment(html)).filter(node => node.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).includes(panelClass)));
  if (panels.length !== 1) return undefined;
  const candidates = directChildTag ? panels[0]!.childNodes.filter((node): node is Element => isElement(node) && node.tagName === directChildTag) : panels;
  if (candidates.length !== 1) return undefined;
  const panel = candidates[0]!;
  if (excludedDirectClasses.length) panel.childNodes = panel.childNodes.filter(node => !isElement(node)
    || !node.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).some(value => excludedDirectClasses.includes(value))));
  if (elements(panel).some(node => ["img", "svg", "iframe", "video", "audio"].includes(node.tagName)
    || node.attrs.some(attr => attr.name === "class" && /(?:^|\s)(?:osis-mermaid-card|attachment|artifact)(?:\s|$)/u.test(attr.value)))) return undefined;
  compactCapturedMath(panel);
  return inertHtmlFragment(serialize(panel));
}

type CapturedPanelPart = Readonly<{ html: string } | { mermaid: string }>;

// A diagram does not invalidate the rich text surrounding it. Partition only
// layout wrappers, never a list/table/paragraph: each HTML part remains a whole
// tree and the Adapter still resolves the diagram by owner and exact source.
export function capturedPanelWithMermaid(input: string | undefined, panelClass: string, excludedDirectClasses: readonly string[] = []): readonly CapturedPanelPart[] | undefined {
  if (!input) return undefined;
  const hasClass = (node: Element, value: string): boolean => node.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).includes(value));
  const panels = elements(parseFragment(input)).filter(node => hasClass(node, panelClass));
  if (panels.length !== 1) return undefined;
  const panel = panels[0]!;
  panel.childNodes = panel.childNodes.filter(node => !isElement(node) || !excludedDirectClasses.some(value => hasClass(node, value)));
  compactCapturedMath(panel);
  const cards = new Map<Element, string>();
  const wrappers = new Set<Parent>();
  const plain = (node: Parent): string => node.childNodes.map(child => "value" in child ? child.value : "childNodes" in child ? plain(child) : "").join("");
  const inspect = (parent: Parent): boolean => {
    for (const child of parent.childNodes) {
      if (!isElement(child)) continue;
      if (hasClass(child, "osis-mermaid-card")) {
        const codes = elements(child).filter(node => node.tagName === "code" && (hasClass(node, "language-mermaid")
          || (node.parentNode && "attrs" in node.parentNode && node.parentNode.attrs.some(attr => attr.name === "data-osis-mermaid-panel" && attr.value === "source"))));
        if (codes.length !== 1 || !plain(codes[0]!).trim()) return false;
        cards.set(child, plain(codes[0]!).trim());
        let ancestor: Parent | null = child.parentNode;
        while (ancestor && ancestor !== panel) {
          if (!("tagName" in ancestor) || !["div", "section", "article"].includes(ancestor.tagName)) return false;
          wrappers.add(ancestor);
          ancestor = ancestor.parentNode;
        }
      } else {
        if (["img", "svg", "iframe", "video", "audio"].includes(child.tagName)
          || ["attachment", "artifact"].some(value => hasClass(child, value))) return false;
        if (!inspect(child)) return false;
      }
    }
    return true;
  };
  if (!inspect(panel) || !cards.size) return undefined;
  type Part = { nodes: Child[] } | { mermaid: string };
  const split = (parent: Parent): Part[] => {
    const result: Part[] = [];
    let nodes: Child[] = [];
    const flush = (): void => { if (nodes.length) result.push({ nodes }); nodes = []; };
    for (const child of parent.childNodes) {
      const source = isElement(child) ? cards.get(child) : undefined;
      if (source) { flush(); result.push({ mermaid: source }); continue; }
      if (!isElement(child) || !wrappers.has(child)) { nodes.push(child); continue; }
      let continued = false;
      for (const part of split(child)) {
        if ("mermaid" in part) { flush(); result.push(part); continue; }
        const wrapper = defaultTreeAdapter.createElement(child.tagName, child.namespaceURI, child.attrs.filter(attr => !continued || attr.name !== "id").map(attr => ({ ...attr })));
        for (const node of part.nodes) defaultTreeAdapter.appendChild(wrapper, node);
        nodes.push(wrapper);
        continued = true;
      }
    }
    flush();
    return result;
  };
  return split(panel).flatMap<CapturedPanelPart>(part => {
    if ("mermaid" in part) return [part];
    const fragment = defaultTreeAdapter.createDocumentFragment();
    for (const node of part.nodes) defaultTreeAdapter.appendChild(fragment, node);
    const html = inertHtmlFragment(serialize(fragment));
    return html ? [{ html }] : [];
  });
}

export function restoreCapturedProcess(blocks: readonly JsonObject[], reading: string, panelClass = "osis-thinking"): JsonObject[] {
  const thoughts = blocks.filter(block => block["type"] === "reasoning" || block["type"] === "reasoning_summary");
  const panels = elements(parseFragment(reading)).filter(node => node.tagName === "details" && node.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).includes(panelClass)));
  if (!thoughts.length || panels.length !== thoughts.length) return [...blocks];
  let index = 0;
  return blocks.map(block => {
    if (block["type"] !== "reasoning" && block["type"] !== "reasoning_summary") return block;
    const panel = panels[index++]!;
    if (elements(panel).some(node => ["img", "svg"].includes(node.tagName))) return block;
    panel.childNodes = panel.childNodes.filter(node => !isElement(node) || node.tagName !== "summary");
    // The owner and ordinal establish identity; this content witness prevents a
    // contradictory/stale DOM panel from replacing different semantic content.
    // List markers and Markdown punctuation are presentation, not the witness.
    const plain = (node: Parent): string => node.childNodes.map(child => "value" in child ? child.value : "childNodes" in child ? plain(child) : "").join("");
    const normalize = (value: string): string => value.replace(/[^\p{L}]/gu, "").toLocaleLowerCase("en-US");
    const expected = normalize(String(block["text"] ?? "")), observed = normalize(plain(panel));
    if (expected && observed && !expected.includes(observed.slice(0, 48)) && !observed.includes(expected.slice(0, 48))) return block;
    compactCapturedMath(panel);
    const html = inertHtmlFragment(serialize(panel));
    return html ? { ...block, text: html, format: "html" } : block;
  });
}

function insideRichContainer(parent: Parent): boolean {
  const containers = new Set(["p", "li", "td", "th", "blockquote", "caption", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6"]);
  let ancestor: Parent | null = parent;
  let nested = false;
  while (ancestor && "tagName" in ancestor) {
    if (containers.has(ancestor.tagName.toLowerCase())) { nested = true; break; }
    ancestor = ancestor.parentNode;
  }
  return nested;
}

export function preserveNestedImage(parent: Parent, original: Element, block: JsonObject): Child | undefined {
  if (block["type"] !== "image" || typeof block["resource"] !== "string" || !insideRichContainer(parent)) return undefined;
  const attrs = original.attrs.filter(attr => !["src", "srcset", HTML_IMAGE_RESOURCE, "alt"].includes(attr.name)).map(attr => ({ ...attr }));
  attrs.push({ name: HTML_IMAGE_RESOURCE, value: block["resource"] });
  const alt = typeof block["alt"] === "string" ? block["alt"] : original.attrs.find(attr => attr.name === "alt")?.value;
  if (alt !== undefined) attrs.push({ name: "alt", value: alt });
  return defaultTreeAdapter.createElement("img", html.NS.HTML, attrs);
}

export function preserveNestedMath(parent: Parent, original: Element, tex: string, display: boolean): Child | undefined {
  if (capturedMathHasTextFrame(original)) return original;
  if (!insideRichContainer(parent)) return undefined;
  const findMath = (node: Parent): Element | undefined => {
    for (const child of node.childNodes) if (isElement(child)) {
      if (child.tagName.toLowerCase() === "math") return child;
      const found = findMath(child);
      if (found) return found;
    }
    return undefined;
  };
  const math = findMath(original);
  if (math) {
    defaultTreeAdapter.detachNode(math);
    if (display && !math.attrs.some(attribute => attribute.name === "display")) math.attrs.push({ name: "display", value: "block" });
    return math;
  }
  // A tiny inert TeX slot preserves the containing list/table/paragraph; splitting
  // the surrounding HTML into separately parsed chunks would silently close it.
  const marker = defaultTreeAdapter.createElement("span", html.NS.HTML, [{ name: "data-cloudig-math", value: display ? "display" : "inline" }]);
  defaultTreeAdapter.insertText(marker, tex);
  return marker;
}

function safeClickUrl(value: string): boolean {
  if (value.startsWith("#")) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function safeStyle(value: string): string | undefined {
  const declarations = value.split(";").map((entry) => entry.trim()).filter(Boolean);
  const kept = declarations.filter((entry) => (
    !hasExternalCss(entry)
    && !/^\s*(?:animation|transition|behavior|-moz-binding)\s*:/iu.test(entry)
  ));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function neutralize(element: Element, block: boolean): void {
  const original = element.tagName.toLowerCase();
  const type = element.attrs.find(attribute => attribute.name === "type")?.value.toLowerCase();
  const checked = element.attrs.some(attribute => attribute.name === "checked");
  // Authored task-list state is content, not an interactive form capability.
  const visible = original === "input" && type === "checkbox" ? (checked ? "☑" : "☐")
    : original === "input" && type === "radio" ? (checked ? "◉" : "○")
    : element.attrs.find((attribute) => attribute.name === "value" || attribute.name === "placeholder" || attribute.name === "title")?.value;
  element.tagName = block ? "div" : "span";
  element.nodeName = element.tagName;
  element.namespaceURI = html.NS.HTML;
  element.attrs = [{ name: "data-cloudig-inert", value: original }];
  if (visible && element.childNodes.length === 0) defaultTreeAdapter.insertText(element, visible);
}

type InertHtmlOptions = Readonly<{ preserveEmbeddedImages?: boolean; preserveUserLines?: boolean }>;

// A reading/export projection, never the Parser's default stored HTML. User
// text keeps its authored lines regardless of the originating platform's CSS.
// Block-layout whitespace is not a line of text; code/math retain their own grammar.
const LINE_BLOCKS = new Set(["address", "article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
const TEXT_FLOWS = new Set(["p", "li", "td", "th", "caption", "dt", "dd", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6"]);
const VERBATIM_ELEMENTS = new Set(["pre", "code", "kbd", "samp", "textarea", "script", "style"]);

function preserveUserTextLines(parent: Parent): void {
  if ("tagName" in parent && (parent.namespaceURI !== html.NS.HTML || VERBATIM_ELEMENTS.has(parent.tagName)
    || parent.attrs.some(attr => attr.name === "class" && /(?:^|\s)(?:katex(?:-display)?|temml|cloudig-math)(?:\s|$)/u.test(attr.value))
    || parent.attrs.some(attr => attr.name === "style" && /(?:^|;)\s*white-space\s*:\s*(?:normal|nowrap|pre(?:-wrap|-line)?|break-spaces)\s*(?:!important)?\s*(?:;|$)/iu.test(attr.value)))) return;
  const original = parent.childNodes;
  const isBlock = (node: Child | undefined): boolean => !!node && isElement(node) && LINE_BLOCKS.has(node.tagName);
  const textFlow = "tagName" in parent && TEXT_FLOWS.has(parent.tagName) && !original.some(isBlock);
  const result: Child[] = [];
  for (let index = 0; index < original.length; index++) {
    const child = original[index]!;
    if (isElement(child)) { preserveUserTextLines(child); result.push(child); continue; }
    if (child.nodeName !== "#text") { result.push(child); continue; }
    const previous = original[index - 1], next = original[index + 1];
    const inlineGap = previous && next && !isBlock(previous) && !isBlock(next);
    if (!child.value.trim() && !textFlow && !inlineGap) { result.push(child); continue; }
    let value = child.value;
    // A serializer's newline after an existing hard break is not another break.
    if (previous && isElement(previous) && previous.tagName === "br") value = value.replace(/^\n/u, "");
    // Formatting around child blocks already has a block boundary.
    if (isBlock(previous)) value = value.replace(/^[\t \n]*\n[\t ]*/u, "");
    if (isBlock(next)) value = value.replace(/[\t ]*\n[\t \n]*$/u, "");
    const parts = value.split("\n");
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      if (partIndex) result.push(defaultTreeAdapter.createElement("br", html.NS.HTML, []));
      const part = parts[partIndex]!;
      if (!part) continue;
      const textNode = defaultTreeAdapter.createTextNode(part);
      if (/\t| {2}|^ | $/u.test(part)) {
        const span = defaultTreeAdapter.createElement("span", html.NS.HTML, [{ name: "style", value: "white-space:pre-wrap" }]);
        defaultTreeAdapter.appendChild(span, textNode); result.push(span);
      } else result.push(textNode);
    }
  }
  parent.childNodes = result;
  for (const child of result) child.parentNode = parent;
}

function embeddedImage(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+[;,]/iu.test(value);
}

function sanitizeAttributes(element: Element, options: InertHtmlOptions): void {
  const tag = element.tagName.toLowerCase();
  element.attrs = element.attrs.flatMap((attribute) => {
    const name = attribute.name.toLowerCase();
    if (tag === "img" && name === "src" && element.attrs.some(attr => attr.name === HTML_IMAGE_RESOURCE)) return [];
    if (options.preserveEmbeddedImages && embeddedImage(attribute.value)
      && ((tag === "img" && name === "src") || (tag === "image" && name === "href"))) return [attribute];
    if (name.startsWith("on") || DROP_ATTRIBUTES.has(name)) return [];
    if (name === "href") {
      if (tag === "a" && safeClickUrl(attribute.value)) return [{ ...attribute, value: attribute.value }];
      if (tag === "use" && attribute.value.startsWith("#")) return [{ ...attribute, value: attribute.value }];
      return [];
    }
    if (name === "style") {
      const value = safeStyle(attribute.value);
      return value ? [{ ...attribute, value }] : [];
    }
    return [attribute];
  });
}

function safeSvgStyle(element: Element): boolean {
  if (element.tagName.toLowerCase() !== "style" || element.namespaceURI !== html.NS.SVG) return false;
  const text = element.childNodes.map((node) => "value" in node ? node.value : "").join("");
  return text.length > 0 && !hasExternalCss(text);
}

function sanitizeChildren(parent: Parent, options: InertHtmlOptions = {}): void {
  const kept: Child[] = [];
  for (const child of parent.childNodes) {
    if (!isElement(child)) {
      if (child.nodeName === "#text") kept.push(child);
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (tag === "script"
      || (child.namespaceURI === html.NS.SVG && (DROP_SVG.has(tag) || (tag === "style" && !safeSvgStyle(child))))
      || (child.namespaceURI === html.NS.HTML && DROP_HTML.has(tag))) {
      continue;
    }
    if (NEUTRAL_BLOCK.has(tag)) neutralize(child, true);
    else if (NEUTRAL_INLINE.has(tag)) neutralize(child, false);
    // Parser extracts images into resource blocks. Reader also accepts legal
    // external Conversation JSON: preserve its self-contained images, but never
    // autoload a remote image or produce a broken-image placeholder for one.
    if (options.preserveEmbeddedImages && tag === "img"
      && !child.attrs.some(attribute => attribute.name === HTML_IMAGE_RESOURCE)
      && !child.attrs.some(attribute => attribute.name === "src" && embeddedImage(attribute.value))) {
      const alt = child.attrs.find(attribute => attribute.name === "alt")?.value;
      neutralize(child, false);
      if (alt && child.childNodes.length === 0) defaultTreeAdapter.insertText(child, alt);
    }
    sanitizeAttributes(child, options);
    sanitizeChildren(child, options);
    kept.push(child);
  }
  parent.childNodes = kept;
  for (const child of kept) child.parentNode = parent;
}

function collectLinks(parent: Parent, links: string[]): void {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName.toLowerCase() === "a") {
      const href = child.attrs.find((attribute) => attribute.name.toLowerCase() === "href")?.value;
      if (href && !links.includes(href)) links.push(href);
    }
    collectLinks(child, links);
  }
}

export function inertHtmlEvidence(value: string, options: InertHtmlOptions = {}): Readonly<{ html?: string; links: readonly string[] }> {
  if (value.length === 0) return { links: [] };
  const fragment = parseFragment(value);
  sanitizeChildren(fragment, options);
  if (options.preserveUserLines) preserveUserTextLines(fragment);
  const links: string[] = [];
  collectLinks(fragment, links);
  const result = serialize(fragment).trim();
  return { ...(result.length > 0 ? { html: result } : {}), links };
}

export function inertHtmlFragment(value: string, options: InertHtmlOptions = {}): string | undefined {
  return inertHtmlEvidence(value, options).html;
}

export function inertStandaloneSvg(value: string): string | undefined {
  const fragment = parseFragment(value);
  sanitizeChildren(fragment);
  const svg = fragment.childNodes.find((node): node is Element => isElement(node) && node.tagName === "svg");
  if (!svg) return undefined;
  // Inline HTML provides namespace context implicitly. An image/svg+xml file
  // does not: declare both SVG and foreignObject XHTML at namespace boundaries.
  const declare = (node: Element, inherited: string | undefined): void => {
    if (node.namespaceURI !== inherited) {
      const attr = node.attrs.find(attribute => attribute.name === "xmlns");
      if (attr) attr.value = node.namespaceURI;
      else node.attrs.push({ name: "xmlns", value: node.namespaceURI });
    }
    for (const child of node.childNodes) if (isElement(child)) declare(child, node.namespaceURI);
  };
  declare(svg, undefined);
  if (!svg.attrs.some(attribute => attribute.name === "xmlns:xlink" || attribute.prefix === "xmlns" && attribute.name === "xlink")) svg.attrs.push({ name: "xmlns:xlink", value: html.NS.XLINK });
  const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const xml = (node: Child): string => {
    if (!isElement(node)) return node.nodeName === "#text" ? escape(node.value) : "";
    const attrs = node.attrs.map(attribute => ` ${attribute.prefix ? `${attribute.prefix}:` : ""}${attribute.name}="${escape(attribute.value)}"`).join("");
    // HTML's <br> void serialization is invalid in an XML SVG image. Empty
    // elements are self-closing here, including XHTML inside foreignObject.
    return node.childNodes.length === 0 ? `<${node.tagName}${attrs}/>` : `<${node.tagName}${attrs}>${node.childNodes.map(xml).join("")}</${node.tagName}>`;
  };
  return xml(svg);
}
