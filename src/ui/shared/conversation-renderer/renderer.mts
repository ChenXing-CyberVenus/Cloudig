import type { JsonObject, JsonValue } from "../../../core/contracts/types.mts";
import { isJsonObject } from "../../../core/contracts/types.mts";
import { inertHtmlFragment } from "../../../adapters/parser/inert-html.mts";
import { HTML_IMAGE_RESOURCE } from "../../../core/records/html-resources.mts";
import { renderStructuredBox } from "./structured-box.mts";
import { renderSavedDil } from "./chatgpt-dil.mts";
import { isSummaryView, sameSummarySpeaker } from "../../../app/reader/summary-sequence.mts";
import { openInteractiveWindow } from "./interactive-window.mts";
import { loadInteractiveDependencies } from "./interactive-dependencies.mts";
import { mapInteractiveAssets, readInteractiveAsset } from "./interactive-assets.mts";
import { resourceActionIcon, resourceIcon, resourceKind, resourceSize } from "./resource-card.mts";
import type { InteractiveFile, InteractiveFormat } from "./interactive-protocol.mts";
import {
  createOfflineContentRuntime,
  type OfflineContentRuntime,
  type RendererTheme
} from "./content-runtime.mts";

const CLAUDE_CONTEXT_TITLES: Readonly<Record<string, string>> = {
  "Claude memory snapshot": "Claude 平台上下文 · 记忆快照",
  "Claude memory update": "Claude 平台上下文 · 记忆更新",
  "Claude date context": "Claude 平台上下文 · 日期提示",
  "Claude platform context": "Claude 平台上下文",
  "Claude platform flag": "Claude 平台标记",
  "Claude token budget": "Claude 上下文额度"
};
function isClaudeContext(value: JsonObject): boolean {
  const title = typeof value["title"] === "string" ? value["title"] : "";
  return value["type"] === "status" && (Object.hasOwn(CLAUDE_CONTEXT_TITLES, title) || title.startsWith("Claude platform context · "));
}

export type RendererLabels = Readonly<{
  reasoning: string;
  reasoningContent?: string;
  reasoningSummary?: string;
  processGroup?: string;
  toolCall: string;
  toolResult: string;
  toolActivity: string;
  references: string;
  search: string;
  diagram: string;
  source: string;
  loadingResource: string;
  unavailableResource: string;
  failedResource: string;
  openAttachment: string;
  externalResource: string;
  systemParty: string;
  toolParty: string;
  otherParty: string;
  schedule?: Readonly<{ enabled: string; disabled: string; timezone: string; lastRun: string; nextRun: string; settings: string; allTasks: string; conversation: string; prompt?: string; notifications?: string; on?: string; off?: string }>;
}>;

export type ResolvedResourceUrl = Readonly<{
  url: string;
  release?: () => void;
}>;

export type ConversationRendererOptions = Readonly<{
  root: HTMLElement;
  labels: RendererLabels;
  theme: RendererTheme;
  language?: "zh" | "en";
  runtime?: OfflineContentRuntime;
  resolveResource?: (
    resource: JsonObject,
    purpose: "image" | "diagram" | "interactive",
    signal: AbortSignal
  ) => Promise<ResolvedResourceUrl>;
  resolveAvatar?: (reference: string, signal: AbortSignal) => Promise<ResolvedResourceUrl>;
  workRuntime?: Readonly<{ frameUrl: string; dependencies: string }>;
  onOpenExternal?: (url: string) => void;
  onOpenResource?: (resource: string) => void;
  onEditIdentity?: (role: string) => void;
  formatDuration?: (seconds: number) => string;
  formatTimestamp?: (timestamp: string) => string;
}>;

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  value?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (className && /(?:^|\s)cloudig-(?:code|tool-data|diagram-source|diagram-fallback|math)(?:\s|$)/u.test(className)) {
    node.dataset["scrollRegion"] = "";
  }
  if (value !== undefined) node.textContent = value;
  return node;
}

function jsonText(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function toolData(document: Document, value: string): HTMLElement {
  const node = element(document, "pre", "cloudig-tool-data");
  let cursor = 0;
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`\\]+/gu)) {
    const url = match[0].replace(/[.,;:)\]}]+$/u, "");
    node.append(document.createTextNode(value.slice(cursor, match.index)));
    const link = element(document, "a", "cloudig-source-link", url);
    link.href = url; link.dataset["cloudigExternal"] = "true"; link.rel = "noopener noreferrer";
    node.append(link); cursor = match.index + url.length;
  }
  node.append(document.createTextNode(value.slice(cursor)));
  return node;
}

function rich(document: Document, html: string, className = "cloudig-rich", generated = false, preserveUserLines = false): HTMLElement {
  const node = element(document, "div", className);
  // Bundled KaTeX computes layout values, not a pre-enumerable static stylesheet.
  // Apply only renderer-generated declarations through CSSOM; untrusted inert
  // archive HTML never gets this capability and the shell CSP remains unchanged.
  node.innerHTML = generated ? html.replace(/\sstyle="([^"]*)"/gu, ' data-cloudig-layout="$1"')
    : inertHtmlFragment(html, { preserveEmbeddedImages: true, preserveUserLines }) ?? "";
  if (generated) for (const styled of node.querySelectorAll<HTMLElement>("[data-cloudig-layout]")) {
    styled.style.cssText = styled.getAttribute("data-cloudig-layout") ?? "";
    styled.removeAttribute("data-cloudig-layout");
  }
  if (!generated) for (const styled of node.querySelectorAll<HTMLElement>("[style]")) {
    // Captured MathML and SVG are part of the original rendered formula/chart,
    // not page chrome.  Their inline color, fill, spacing and font declarations
    // must survive the inert replay just like ordinary XHTML cards.  The old
    // XHTML-only gate silently dropped GLM's colored MathML and made the
    // formula appear as a flat/garbled fallback in the Reader.
    if (!["http://www.w3.org/1999/xhtml", "http://www.w3.org/1998/Math/MathML", "http://www.w3.org/2000/svg"].includes(styled.namespaceURI ?? "")) continue;
    // Captured cards/table cells carry meaningful static paint and spacing.
    // The shell CSP rejects inline attributes, so apply these through CSSOM;
    // page positioning and resource-loading declarations are not replayed.
    const declarations = document.createElement("span").style;
    declarations.cssText = styled.getAttribute("style") ?? "";
    styled.removeAttribute("style");
    const capturedMath = Boolean(styled.closest(".katex, .osis-katex-shell"));
    const capturedTemmlFrame = Boolean(styled.closest(".osis-temml-frame"));
    for (const property of Array.from(declarations)) {
      // Legacy KaTeX captures put the fraction/matrix layout in inline
      // geometry (height/top/width), while ordinary captured HTML must not
      // regain page-positioning power. Keep the extra properties scoped to
      // the static KaTeX subtree and accept only numeric geometry plus the
      // two harmless positioning modes used by KaTeX itself.
      const safeMathGeometry = /^(?:height|width|min-height|min-width|max-height|max-width|top|right|bottom|left|position)$/u.test(property);
      const safeTemmlFrameVariable = /^(?:--osis-frame-(?:color|border|padding))$/u.test(property);
      if (!/^(?:color|background(?:-(?:color|image|repeat|position(?:-x|-y)?|size|origin|clip|attachment))?|(?:padding|margin)(?:-(?:top|right|bottom|left))?|border(?:-(?:color|style|width|radius|collapse|spacing|(?:top|right|bottom|left)(?:-(?:color|style|width))?|(?:top|bottom)-(?:left|right)-radius))?|text-align|vertical-align|font(?:-size|-weight|-style|-family)?|line-height|white-space)$/u.test(property)
        && !(capturedMath && safeMathGeometry)
        && !(capturedTemmlFrame && safeTemmlFrameVariable)) continue;
      const value = declarations.getPropertyValue(property);
      if (/(?:url\s*\(|expression\s*\(|@import|javascript:)/iu.test(value)) continue;
      if (capturedMath && safeMathGeometry && property === "position" && !/^(?:static|relative)$/iu.test(value.trim())) continue;
      if (capturedMath && safeMathGeometry && property !== "position" && !/^(?:auto|none|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|ex|ch|%|pt|pc|cm|mm|in|vh|vw|vmin|vmax)?)$/iu.test(value.trim())) continue;
      if (capturedTemmlFrame && safeTemmlFrameVariable && !/^[#(),.%\w\s+\-]+$/u.test(value.trim())) continue;
      const target = styled as unknown as { style?: CSSStyleDeclaration };
      if (target.style) target.style.setProperty(property, value);
      else styled.setAttribute("style", `${property}: ${value};`);
    }
  }
  // Keep the table formatting context intact: the wrapper owns overflow, not
  // a display:block table. Reuse captured table-only wrappers, including old
  // archives whose exporter stripped the wrapper's original class name.
  for (const table of node.querySelectorAll<HTMLTableElement>("table")) {
    if (table.namespaceURI !== "http://www.w3.org/1999/xhtml" || table.closest("svg")) continue;
    let wrapper = table.parentElement!;
    const tableOnly = wrapper !== node && wrapper.localName === "div"
      && Array.from(wrapper.childNodes).every(child => child === table || (child.nodeType === 3 && !child.textContent?.trim()));
    if (!tableOnly) {
      wrapper = element(document, "div", "cloudig-table-scroll");
      table.before(wrapper);
      wrapper.append(table);
    }
    wrapper.classList.add("cloudig-table-scroll");
    wrapper.dataset["scrollRegion"] = "";
    table.removeAttribute("data-scroll-region");
  }
  for (const pre of node.querySelectorAll<HTMLElement>("pre")) pre.dataset["scrollRegion"] = "";
  for (const pre of node.querySelectorAll("pre")) {
    pre.classList.add("cloudig-code");
    const code = pre.querySelector("code");
    const language = pre.dataset["language"] ?? code?.getAttribute("data-language") ?? /(?:^|\s)language-([^\s]+)/u.exec(code?.className ?? "")?.[1];
    if (language) pre.dataset["language"] = language;
  }
  // Exporters keep this explicit language caption beside (sometimes above a
  // wrapper around) the pre. Reader already paints that same language in its
  // own code header. Remove only the proven duplicate, not adjacent prose.
  for (const caption of node.querySelectorAll<HTMLElement>(".osis-code-language")) {
    if (caption.childElementCount) continue;
    const next = caption.nextElementSibling;
    const codes = next?.matches("pre") ? [next as HTMLElement] : Array.from(next?.querySelectorAll<HTMLElement>("pre") ?? []);
    if (codes.length !== 1) continue;
    const language = codes[0]!.dataset["language"];
    if (language && caption.textContent?.trim().toLowerCase() === language.trim().toLowerCase()) caption.remove();
  }
  return node;
}

function sourceList(document: Document, sources: readonly JsonObject[]): HTMLElement {
  const list = element(document, "ol", "cloudig-source-list");
  for (const source of sources) {
    const item = element(document, "li", "cloudig-source-item");
    const title = text(source["title"] ?? source["name"]) ?? text(source["url"]) ?? text(source["text"]) ?? String(source["kind"]);
    const url = text(source["url"]);
    if (url) {
      const link = element(document, "a", "cloudig-source-link", title);
      link.href = url;
      link.dataset["cloudigExternal"] = "true";
      link.rel = "noopener noreferrer";
      item.append(link);
    } else item.append(element(document, "span", "cloudig-source-title", title));
    const snippet = text(source["snippet"] ?? source["text"]);
    if (snippet) item.append(element(document, "p", "cloudig-source-snippet", snippet));
    list.append(item);
  }
  return list;
}

function details(
  document: Document,
  className: string,
  label: string,
  collapsed: boolean
): Readonly<{ root: HTMLDetailsElement; body: HTMLElement }> {
  const root = element(document, "details", className);
  root.open = !collapsed;
  const summary = element(document, "summary", "cloudig-fold-title");
  summary.append(element(document, "span", "cloudig-fold-label", label));
  root.append(summary);
  const body = element(document, "div", "cloudig-fold-body");
  root.append(body);
  return { root, body };
}

function resourceMap(block: JsonObject): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const raw of Array.isArray(block["resources"]) ? block["resources"] : []) {
    if (isJsonObject(raw) && typeof raw["id"] === "string") result.set(raw["id"], raw);
  }
  return result;
}

function sourceViews(block: JsonObject): JsonObject[] {
  return Array.isArray(block["sources"])
    ? block["sources"].filter((value): value is JsonObject => isJsonObject(value))
    : [];
}

export class ConversationRenderer {
  readonly #root: HTMLElement;
  readonly #labels: RendererLabels;
  readonly #runtime: OfflineContentRuntime;
  readonly #options: ConversationRendererOptions;
  #theme: RendererTheme;
  #generation = 0;
  #abort = new AbortController();
  #releases: Array<() => void> = [];
  #avatars = new Map<string, Promise<ResolvedResourceUrl>>();
  #view: JsonObject | undefined;
  #deferred = new Set<() => void>();
  #summaryTail: { key: string; group: ReturnType<typeof details>; count: number } | undefined;

  constructor(options: ConversationRendererOptions) {
    this.#root = options.root;
    this.#labels = options.labels;
    this.#theme = options.theme;
    this.#runtime = options.runtime ?? createOfflineContentRuntime();
    this.#options = options;
    this.#root.addEventListener("click", this.#handleClick);
  }

  #handleClick = (event: Event): void => {
    const view = this.#root.ownerDocument.defaultView;
    const target = view && event.target instanceof view.Element ? event.target : undefined;
    const link = target?.closest<HTMLAnchorElement>("a[data-cloudig-external='true']");
    if (!link) return;
    event.preventDefault();
    try {
      const parsed = new URL(link.href);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") this.#options.onOpenExternal?.(parsed.href);
    } catch {
      // Invalid links never leave the renderer.
    }
  };

  #release(): void {
    this.#summaryTail = undefined;
    this.#deferred.clear();
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#avatars.clear();
    for (const release of this.#releases.splice(0)) release();
  }

  #resolveAvatar(reference: string): Promise<ResolvedResourceUrl> {
    const existing = this.#avatars.get(reference);
    if (existing) return existing;
    const generation = this.#generation, signal = this.#abort.signal;
    const task = this.#options.resolveAvatar!(reference, signal).then((resolved) => {
      if (generation !== this.#generation || signal.aborted) {
        resolved.release?.();
        throw new DOMException("Avatar view was replaced", "AbortError");
      }
      if (resolved.release) this.#releases.push(resolved.release);
      return resolved;
    }).catch((error: unknown) => {
      if (this.#avatars.get(reference) === task) this.#avatars.delete(reference);
      throw error;
    });
    this.#avatars.set(reference, task);
    return task;
  }

  #appendProcessIdentity(group: HTMLDetailsElement, messages: JsonObject[], generation: number, axisHost: HTMLElement): void {
    const summary = group.querySelector<HTMLElement>(":scope > summary");
    if (!summary) return;
    const allParties = messages.map(message => isJsonObject(message["party"]) ? message["party"] : {});
    const parties = allParties.filter(party => text(party["role"]) !== "tool");
    const party = parties.find(value => value["role"] === "assistant") ?? parties[0] ?? allParties[0];
    if (!party) return;
    const axisIdentity = element(this.#root.ownerDocument, "span", "cloudig-process-group-axis-avatar");
    axisHost.prepend(axisIdentity);
    const identity = element(this.#root.ownerDocument, "span", "cloudig-process-group-identity");
    identity.dataset["role"] = text(party["role"]) ?? "process";
    const avatarReference = text(party["avatar"]);
    if (avatarReference && this.#options.resolveAvatar) {
      const avatarHost = element(this.#root.ownerDocument, "span", "cloudig-process-group-avatar");
      axisIdentity.append(avatarHost);
      void this.#resolveAvatar(avatarReference).then(resolved => {
        if (generation !== this.#generation || this.#abort.signal.aborted) { resolved.release?.(); return; }
        const image = element(this.#root.ownerDocument, "img"); image.alt = ""; image.src = resolved.url; avatarHost.replaceChildren(image);
      }).catch(() => undefined);
    } else if (party["role"] === "system") {
      const avatarHost = element(this.#root.ownerDocument, "span", "cloudig-process-group-avatar cloudig-system-avatar");
      const image = element(this.#root.ownerDocument, "img"); image.src = "/assets/identity/System-Avatar.svg"; image.alt = ""; avatarHost.append(image); axisIdentity.append(avatarHost);
    }
    const name = text(party["name"]) ?? (party["role"] === "system" ? this.#labels.systemParty : party["role"] === "assistant" ? this.#labels.otherParty : this.#labels.toolParty);
    identity.append(element(this.#root.ownerDocument, "span", "cloudig-process-group-name", name));
    summary.prepend(identity);
    const agentOutput = messages.flatMap(message => Array.isArray(message["blocks"]) ? message["blocks"].filter(isJsonObject) : [])
      .map(block => isJsonObject(block["value"]) ? block["value"] : {})
      .find(value => ["Agent delegation", "Agent question"].includes(String(value["title"] ?? "")));
    const rawPreview = text(agentOutput?.["output"]);
    if (rawPreview) {
      const tagged = /<input>([\s\S]*?)<\/input>/u.exec(rawPreview)?.[1] ?? rawPreview;
      const preview = tagged.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
      if (preview) summary.append(element(this.#root.ownerDocument, "span", "cloudig-process-group-preview", preview.length > 112 ? `${preview.slice(0, 111)}…` : preview));
    }
  }

  setTheme(theme: RendererTheme): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#root.dataset["theme"] = theme;
    if (this.#view) this.render(this.#view);
  }

  async #resolvedImage(
    host: HTMLElement,
    resource: JsonObject,
    purpose: "image" | "diagram",
    alt: string,
    generation: number,
    fallback?: () => Promise<void>,
    attributes?: Readonly<Record<string, string>>
  ): Promise<void> {
    if (resource["availability"] === "external") {
      const url = text(resource["url"]);
      host.replaceChildren();
      if (url) {
        const link = element(host.ownerDocument, "a", "cloudig-external-resource", alt || text(resource["name"]) || this.#labels.externalResource);
        link.href = url;
        link.dataset["cloudigExternal"] = "true";
        host.append(link);
      } else this.#resourceMetadata(host, alt || text(resource["name"]) || "");
      return;
    }
    if (resource["availability"] !== "embedded" || !this.#options.resolveResource) {
      if (fallback) await fallback();
      else {
        this.#resourceMetadata(host, alt || text(resource["name"]) || "");
      }
      return;
    }
    host.replaceChildren(element(host.ownerDocument, "span", "cloudig-resource-state", this.#labels.loadingResource));
    try {
      const resolved = await this.#options.resolveResource(resource, purpose, this.#abort.signal);
      if (generation !== this.#generation || this.#abort.signal.aborted) {
        resolved.release?.();
        return;
      }
      if (resolved.release) this.#releases.push(resolved.release);
      const image = element(host.ownerDocument, "img", "cloudig-resource-image");
      image.alt = alt;
      for (const key of ["title", "width", "height"]) if (attributes?.[key] !== undefined) image.setAttribute(key, attributes[key]!);
      image.addEventListener("error", () => {
        if (generation !== this.#generation || this.#abort.signal.aborted) return;
        if (fallback) void fallback();
        else this.#resourceMetadata(host, alt || text(resource["name"]) || "", true);
      }, { once: true });
      image.src = resolved.url;
      image.loading = "lazy";
      host.replaceChildren(image);
    } catch {
      if (generation !== this.#generation || this.#abort.signal.aborted) return;
      if (fallback) await fallback();
      else this.#resourceMetadata(host, alt || text(resource["name"]) || "", true);
    }
  }

  #resourceMetadata(host: HTMLElement, description: string, failed = false): void {
    host.replaceChildren(element(host.ownerDocument, "span", "cloudig-resource-metadata", description));
    host.hidden = !description;
    // Retain a non-reading diagnostic marker so audits still detect genuine
    // runtime failures; never turn an application error into conversation text.
    if (failed) host.dataset["cloudigResourceError"] = "true";
  }

  #renderText(value: JsonObject, preserveLineBreaks = false, resources: ReadonlyMap<string, JsonObject> = new Map()): HTMLElement {
    const document = this.#root.ownerDocument;
    const type = text(value["type"]);
    if (type === "markdown") return rich(document, this.#runtime.renderMarkdown(text(value["text"]) ?? "", preserveLineBreaks), "cloudig-rich", true);
    if (type === "text") return element(document, "p", "cloudig-text", text(value["text"]) ?? "");
    if (type === "code") {
      const pre = element(document, "pre", "cloudig-code");
      const code = element(document, "code", text(value["language"]) ? `language-${text(value["language"])}` : undefined, text(value["code"]) ?? "");
      if (this.#runtime.highlightCode) code.innerHTML = this.#runtime.highlightCode(text(value["code"]) ?? "", text(value["language"]));
      if (text(value["filename"])) pre.dataset["filename"] = text(value["filename"])!;
      if (text(value["language"])) pre.dataset["language"] = text(value["language"])!;
      pre.append(code);
      return pre;
    }
    if (type === "math") {
      const tex = text(value["tex"]);
      return tex
        ? rich(document, this.#runtime.renderMath(tex, value["display"] === true), "cloudig-math", true)
        : rich(document, text(value["mathml"]) ?? "", "cloudig-math cloudig-inert-html");
    }
    if (type === "html") {
      const node = rich(document, text(value["html"]) ?? "", "cloudig-rich cloudig-inert-html", false, preserveLineBreaks);
      for (const slot of node.querySelectorAll<HTMLImageElement>(`img[${HTML_IMAGE_RESOURCE}]`)) {
        const resource = resources.get(slot.getAttribute(HTML_IMAGE_RESOURCE) ?? "");
        const host = element(document, "span", "cloudig-inline-resource");
        const alt = slot.getAttribute("alt") ?? text(resource?.["name"]) ?? "";
        const attributes = Object.fromEntries(["title", "width", "height"].flatMap(key => slot.hasAttribute(key) ? [[key, slot.getAttribute(key)!]] : []));
        slot.replaceWith(host);
        if (resource) void this.#resolvedImage(host, resource, resource["kind"] === "diagram" ? "diagram" : "image", alt, this.#generation, undefined, attributes);
        else this.#resourceMetadata(host, alt);
      }
      // Exported KaTeX already carries its TeX in MathML. Re-render that semantic
      // input with the bundled runtime, rather than granting raw HTML inline CSS.
      for (const math of node.querySelectorAll(".katex")) {
        const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
        if (!annotation?.textContent || !node.contains(math)) continue;
        const display = math.closest(".katex-display");
        const target = display && node.contains(display) ? display : math;
        const rendered = rich(document, this.#runtime.renderMath(annotation.textContent, target === display), "cloudig-math", true);
        if (target.id && rendered.firstElementChild) rendered.firstElementChild.id = target.id;
        target.replaceWith(...rendered.childNodes);
      }
      for (const slot of node.querySelectorAll("[data-cloudig-math]")) {
        const rendered = rich(document, this.#runtime.renderMath(slot.textContent ?? "", slot.getAttribute("data-cloudig-math") === "display"), "cloudig-math", true);
        slot.replaceWith(...rendered.childNodes);
      }
      if (this.#runtime.highlightCode) for (const code of node.querySelectorAll("pre > code")) {
        const language = code.parentElement?.getAttribute("data-language") ?? code.getAttribute("data-language") ?? /(?:^|\s)language-([^\s]+)/u.exec(code.className)?.[1];
        if (language) code.innerHTML = this.#runtime.highlightCode(code.textContent ?? "", language);
      }
      return node;
    }
    return element(document, "p", "cloudig-text", text(value["text"]) ?? "");
  }

  #defer(folded: Readonly<{ root: HTMLDetailsElement; body: HTMLElement }>, build: () => void): void {
    const generation = this.#generation;
    let filled = false;
    const fill = () => {
      if (filled) return;
      if (generation !== this.#generation) { this.#deferred.delete(fill); return; }
      filled = true; this.#deferred.delete(fill); build();
    };
    this.#deferred.add(fill);
    folded.root.addEventListener("toggle", () => { if (folded.root.open) fill(); });
    if (folded.root.open) fill();
  }

  /** Explicit search needs the complete text, but opening an article does not. */
  materializeDeferred(): void { while (this.#deferred.size) for (const fill of [...this.#deferred]) fill(); }

  #summaryEntry(block: JsonObject, owner: ReturnType<typeof details>): HTMLElement {
    const document = this.#root.ownerDocument, value = isJsonObject(block["value"]) ? block["value"] : {};
    const entry = element(document, "section", "cloudig-summary-entry");
    this.#defer(owner, () => {
      const rendered = this.#renderProcess({ ...block, collapsed: false }, value);
      const body = rendered.querySelector<HTMLElement>(":scope > .cloudig-fold-body");
      if (!body) { entry.append(...rendered.childNodes); return; }
      if (text(value["title"]) || number(value["duration"]) !== undefined) {
        entry.append(element(document, "div", "cloudig-process-label", rendered.querySelector(":scope > summary")?.textContent ?? ""));
      }
      entry.append(body);
    });
    return entry;
  }

  #summarySequence(blocks: JsonObject[]): HTMLElement {
    const group = details(this.#root.ownerDocument, "cloudig-process cloudig-reasoning cloudig-summary-sequence",
      `${this.#labels.reasoningSummary ?? this.#labels.reasoning} · ${blocks.length}`, blocks.every(block => block["collapsed"] === true));
    group.root.dataset["summaryCount"] = String(blocks.length);
    for (const [index, block] of blocks.entries()) {
      const entry = this.#summaryEntry(block, group);
      // The first source anchor is assigned to the disclosure itself by the
      // caller; subsequent anchors still target their own exact summary.
      if (index && text(block["anchor"])) entry.id = String(block["anchor"]);
      entry.dataset["category"] = "reasoning"; group.body.append(entry);
    }
    return group.root;
  }

  #renderProcess(block: JsonObject, value: JsonObject): HTMLElement {
    const document = this.#root.ownerDocument;
    const category = text(block["category"]);
    if (category === "reasoning") {
      const raw = text(value["text"]), format = text(value["format"]);
      const nestedBlocks = Array.isArray(block["blocks"]) ? block["blocks"].filter(isJsonObject) : [];
      const hasBody = nestedBlocks.length > 0 || Boolean(raw && (format !== "html"
        ? raw.replace(/[\s\u200b\ufeff]/gu, "")
        : raw.replace(/<[^>]*>|&(?:nbsp|#160|#xa0);|[\s\u200b\ufeff]/giu, "") || /<(?:img|svg|math)\b/iu.test(raw)));
      const summary = value["type"] === "reasoning_summary";
      const sourceTitle = text(value["title"]);
      const translatedTitle = value["type"] === "status" && this.#options.language !== "en" && sourceTitle ? CLAUDE_CONTEXT_TITLES[sourceTitle] : undefined;
      const title = translatedTitle ?? sourceTitle ?? (isJsonObject(value["party"]) && value["party"]["role"] === "system" ? this.#labels.systemParty : undefined)
        ?? (summary ? this.#labels.reasoningSummary : hasBody ? this.#labels.reasoningContent : undefined) ?? this.#labels.reasoning;
      const duration = number(value["duration"]);
      const titleHasDuration = /^(?:thought|thinking|reasoned)\s+(?:for\s+)?(?:\d+(?:\.\d+)?\s*(?:ms|s|sec(?:onds)?|m|min(?:utes)?|h|hours?)\s*)+$/iu.test(title)
        || /^思考(?:了|用时)?\s*(?:\d+(?:\.\d+)?\s*(?:毫秒|秒|分钟|小时)\s*)+$/u.test(title);
      const label = duration === undefined || !this.#options.formatDuration || titleHasDuration
        ? title
        : `${title} · ${this.#options.formatDuration(duration)}`;
      if (!hasBody) {
        const status = element(document, "div", "cloudig-process cloudig-reasoning cloudig-process-static");
        status.append(element(document, "span", "cloudig-process-label", label));
        return status;
      }
      const folded = details(document, `cloudig-process cloudig-reasoning${summary ? " cloudig-reasoning-summary" : ""}`, label, block["collapsed"] === true);
      const platformContext = isClaudeContext(value);
      if (platformContext) folded.root.classList.add("cloudig-platform-context");
      this.#defer(folded, () => {
        // Trim transport-padding blank lines only in presentation. Stored text
        // and internal line breaks are unchanged.
        const plain = platformContext ? raw?.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/gu, "") : raw;
        const body = !raw ? element(document, "div", "cloudig-rich") : format === "markdown"
          ? rich(document, this.#runtime.renderMarkdown(raw!, true), "cloudig-rich", true)
          : format === "html" ? this.#renderText({ type: "html", html: raw! }, false, resourceMap(block)) : element(document, "p", "cloudig-text", plain!);
        // Captured public processes may contain several native disclosure levels.
        // Keep their tree and rich labels, but use the same themed controls as
        // the outer process. Nested groups are not new message-axis markers.
        for (const nested of body.querySelectorAll("details")) {
          const heading = nested.querySelector(":scope > summary");
          if (!heading) continue;
          nested.classList.add("cloudig-nested-process");
          heading.classList.add("cloudig-fold-title");
          const label = element(document, "span", "cloudig-fold-label");
          label.append(...heading.childNodes);
          heading.replaceChildren(label);
          if (block["collapsed"] === false) nested.open = true;
        }
        for (let index = 0; index < nestedBlocks.length; index++) {
          const nested = nestedBlocks[index]!;
          let end = index + 1;
          if (isSummaryView(nested)) while (end < nestedBlocks.length && isSummaryView(nestedBlocks[end]!) && sameSummarySpeaker(nested["value"] as JsonObject, nestedBlocks[end]!["value"] as JsonObject)) end++;
          const child = end > index + 1 ? this.#summarySequence(nestedBlocks.slice(index, end).map(b => ({ ...b, collapsed: false }))) : this.#renderBlock(nested, this.#generation, index + 1);
          index = end - 1;
          if (child.classList.contains("cloudig-process")) {
            child.classList.remove("cloudig-process");
            child.classList.add("cloudig-nested-process");
          }
          body.append(child);
        }
        folded.body.append(body);
      });
      return folded.root;
    }
    const kind = text(value["kind"]);
    const fallback = kind === "call" ? this.#labels.toolCall : kind === "result" ? this.#labels.toolResult : this.#labels.toolActivity;
    const label = text(value["title"] ?? value["name"] ?? value["status"]) ?? fallback;
    if (value["name"] === "schedule" && isJsonObject(value["input"])) {
      const card = element(document, "section", "cloudig-schedule");
      const heading = element(document, "header", "cloudig-schedule-header");
      heading.append(element(document, "span", "cloudig-schedule-icon", "◷"), element(document, "h2", undefined, label));
      card.append(heading);
      if (this.#renderSchedule(card, value["input"])) return card;
    }
    const folded = details(document, `cloudig-process cloudig-tool cloudig-tool-${kind ?? "activity"}`, label, block["collapsed"] === true);
    this.#defer(folded, () => {
      const input = jsonText(value["input"]);
      if (input) folded.body.append(toolData(document, input));
      // A captured result may contain several text/resource/reference parts.
      // Keep their sequence, but do not turn real newlines into JSON escapes.
      const output = value["output"];
      const sources = sourceViews(block);
      const onlySourceIds = isJsonObject(output) && Object.keys(output).length === 1 && Array.isArray(output["sources"]) && output["sources"].every(id => sources.some(source => source["id"] === id));
      const parts = onlySourceIds ? [] : Array.isArray(output) && output.length ? output : [output];
      for (const part of parts) { const rendered = jsonText(part); if (rendered) folded.body.append(toolData(document, rendered)); }
      if (sources.length) folded.body.append(sourceList(document, sources));
      for (const key of ["input_resource", "output_resource"]) if (text(value[key])) folded.body.append(this.#renderAttachment(block, { resource: value[key]! }));
    });
    return folded.root;
  }

  #renderSchedule(host: HTMLElement, input: JsonObject): boolean {
    const tasks = input["kind"] === "task-list" && Array.isArray(input["tasks"])
      ? input["tasks"].filter(isJsonObject) : input["kind"] === "scheduled-task" ? [input] : [];
    if (!tasks.length) return false;
    const document = host.ownerDocument;
    const labels = this.#labels.schedule ?? { enabled: "采集时已启用", disabled: "采集时已停用", timezone: "时区", lastRun: "上次执行", nextRun: "下次执行", settings: "原始设置", allTasks: "查看所有任务", conversation: "原会话" };
    const link = (parent: HTMLElement, url: JsonValue | undefined, label: string, className: string): void => {
      if (typeof url !== "string") return;
      try { if (!["http:", "https:"].includes(new URL(url).protocol)) return; } catch { return; }
      const anchor = element(document, "a", `cloudig-source-link ${className}`, label);
      anchor.href = url; anchor.dataset["cloudigExternal"] = "true"; anchor.rel = "noopener noreferrer";
      parent.append(anchor);
    };
    for (const task of tasks) {
      const card = details(document, "cloudig-schedule-task", text(task["title"]) ?? this.#labels.toolActivity, true);
      const schedule = text(task["schedule"]);
      if (schedule) card.root.querySelector("summary")!.append(element(document, "small", "cloudig-schedule-summary", schedule));
      this.#defer(card, () => {
      if (typeof task["enabled"] === "boolean") card.body.append(element(document, "p", "cloudig-schedule-state", task["enabled"] ? labels.enabled : labels.disabled));
      const metadata = element(document, "dl", "cloudig-schedule-meta");
      for (const [field, label] of [["timezone", labels.timezone], ["last_run_at", labels.lastRun], ["next_run_at", labels.nextRun]] as const) {
        const value = text(task[field]);
        if (!value) continue;
        metadata.append(element(document, "dt", undefined, label), element(document, "dd", undefined, field === "timezone" ? value : this.#options.formatTimestamp?.(value) ?? value));
      }
      if (typeof task["notifications_enabled"] === "boolean") metadata.append(element(document, "dt", undefined, labels.notifications ?? "通知"), element(document, "dd", undefined, task["notifications_enabled"] ? labels.on ?? "开启" : labels.off ?? "关闭"));
      if (metadata.childElementCount) card.body.append(metadata);
      const prompt = text(task["prompt"]);
      if (prompt) card.body.append(element(document, "h4", "cloudig-schedule-prompt-label", labels.prompt ?? "任务指令"), rich(document, this.#runtime.renderMarkdown(prompt, true), "cloudig-rich cloudig-schedule-prompt", true));
      link(card.body, task["conversation_url"], labels.conversation, "cloudig-schedule-conversation");
      if (isJsonObject(task["source_task"])) {
        const original = details(document, "cloudig-schedule-settings", labels.settings, true);
        this.#defer(original, () => original.body.append(toolData(document, JSON.stringify(task["source_task"], null, 2))));
        card.body.append(original.root);
      }
      });
      host.append(card.root);
    }
    link(host, input["all_tasks_url"], labels.allTasks, "cloudig-schedule-all");
    return true;
  }

  #renderReferences(block: JsonObject, value: JsonObject): HTMLElement {
    const document = this.#root.ownerDocument;
    const type = text(value["type"]);
    const label = text(value["label"])
      ?? (type === "search" ? text(value["query"] ?? value["status"]) ?? this.#labels.search : this.#labels.references);
    const folded = details(document, "cloudig-references", label, block["collapsed"] === true);
    this.#defer(folded, () => { const sources = sourceViews(block); if (sources.length > 0) folded.body.append(sourceList(document, sources)); });
    return folded.root;
  }

  #renderImage(block: JsonObject, value: JsonObject, generation: number): HTMLElement {
    const document = this.#root.ownerDocument;
    const host = element(document, "figure", "cloudig-media cloudig-image");
    if (value["purpose"] === "attachment-thumbnail") host.classList.add("cloudig-attachment-thumbnail");
    const viewport = element(document, "div", "cloudig-media-viewport");
    host.append(viewport);
    const id = text(value["resource"]);
    const resource = id ? resourceMap(block).get(id) : undefined;
    const alt = text(value["alt"] ?? value["caption"] ?? resource?.["name"]) ?? "";
    if (resource) void this.#resolvedImage(viewport, resource, "image", alt, generation);
    else this.#resourceMetadata(viewport, alt);
    const original = isJsonObject(resource?.["original"]) ? resource["original"] : {};
    const sourceUrl = value["purpose"] === "search-result" ? text(original["url"] ?? resource?.["original_url"]) : undefined;
    if (sourceUrl && /^https?:\/\//iu.test(sourceUrl)) {
      const caption = element(document, "figcaption"), link = element(document, "a", "cloudig-source-link", text(value["caption"]) ?? alt ?? sourceUrl);
      link.href = sourceUrl; link.dataset["cloudigExternal"] = "true"; link.rel = "noopener noreferrer"; caption.append(link); host.append(caption);
    } else if (text(value["caption"])) host.append(element(document, "figcaption", undefined, text(value["caption"])!));
    return host;
  }

  #renderAttachment(block: JsonObject, value: JsonObject): HTMLElement {
    const document = this.#root.ownerDocument;
    const id = text(value["resource"]);
    const resource = id ? resourceMap(block).get(id) : undefined;
    const card = element(document, "div", "cloudig-attachment");
    const name = text(resource?.["name"]) ?? text(value["name"]) ?? "", kind = resourceKind(name, text(resource?.["mime"]) ?? "");
    const info = element(document, "div", "cloudig-file-info"), label = element(document, "span", "cloudig-attachment-name", name);
    label.title = name; info.append(label, element(document, "span", "cloudig-file-meta", [kind, resourceSize(resource?.["bytes"])].filter(Boolean).join(" · ")));
    card.append(resourceIcon(document, kind), info);
    if (id && resource?.["availability"] === "embedded") {
      const button = element(document, "button", "cloudig-attachment-open");
      button.title = this.#labels.openAttachment; button.setAttribute("aria-label", `${this.#labels.openAttachment} · ${name}`); button.append(resourceActionIcon(document, "save"));
      button.type = "button";
      // Read-only example hosts deliberately supply no save capability.
      button.disabled = !this.#options.onOpenResource;
      button.addEventListener("click", () => this.#options.onOpenResource?.(id));
      card.append(button);
    } else if (text(resource?.["url"])) {
      const button = element(document, "button", "cloudig-attachment-open");
      button.title = this.#labels.externalResource; button.setAttribute("aria-label", `${this.#labels.externalResource} · ${name}`); button.append(resourceActionIcon(document, "open"));
      button.type = "button";
      button.addEventListener("click", () => this.#options.onOpenExternal?.(String(resource!["url"])));
      card.append(button);
    }
    return card;
  }

  #renderDiagram(block: JsonObject, value: JsonObject, generation: number, ordinal: number): HTMLElement {
    const document = this.#root.ownerDocument;
    const card = element(document, "section", "cloudig-diagram");
    const display = element(document, "div", "cloudig-diagram-display");
    const source = text(value["source"]);
    const format = text(value["format"]) ?? "diagram";
    const writing = format === "writing-block";
    if (writing) card.classList.add("cloudig-writing");
    card.dataset["diagramFormat"] = format;
    display.dataset["scrollRegion"] = "";
    const renderedId = text(value["rendered"]);
    const rendered = renderedId ? resourceMap(block).get(renderedId) : undefined;
    const sourcePanel = source ? element(document, "pre", "cloudig-diagram-source") : undefined;
    if (sourcePanel) {
      sourcePanel.hidden = true;
      sourcePanel.append(element(document, "code", `language-${format}`, source));
    }
    const renderSource = async (): Promise<void> => {
      const html = text(value["html"]);
      if (html) {
        display.replaceChildren(this.#renderText({ type: "html", html }, false, resourceMap(block)));
        return;
      }
      if (!source) {
        this.#resourceMetadata(display, "");
        return;
      }
      if (writing) {
        display.replaceChildren(rich(document, this.#runtime.renderMarkdown(source), "cloudig-rich", true));
      } else if (format === "mermaid") {
        try {
          const svg = await this.#runtime.renderMermaid(source, `cloudig-mermaid-${generation}-${ordinal}`, this.#theme);
          if (generation === this.#generation) {
            display.dataset["renderer"] = "local";
            // Mermaid's generated <style> is part of the graphic. Inserting it
            // as page HTML under style-src 'self' silently painted black nodes
            // and filled paths. An SVG image retains its own static stylesheet
            // without granting captured content page-CSS or script authority.
            const image = element(document, "img", "cloudig-resource-image cloudig-mermaid-image");
            image.alt = this.#labels.diagram;
            const xml = new document.defaultView!.DOMParser().parseFromString(svg, "image/svg+xml");
            const graphic = xml.documentElement;
            const viewBox = graphic.getAttribute("viewBox")?.trim().split(/[\s,]+/u).map(Number);
            if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0) {
              // Percentage-only SVGs otherwise acquire a 300px replaced-image
              // default and unreadably shrink long charts. Fit width via CSS,
              // keep the native aspect ratio and let the viewport scroll.
              graphic.setAttribute("width", String(viewBox[2]));
              graphic.setAttribute("height", String(viewBox[3]));
            }
            const standalone = new document.defaultView!.XMLSerializer().serializeToString(xml);
            image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standalone)}`;
            display.replaceChildren(image);
          }
        } catch {
          if (generation === this.#generation) display.replaceChildren(element(document, "pre", "cloudig-diagram-fallback", source));
        }
      } else display.replaceChildren(element(document, "pre", "cloudig-diagram-fallback", source));
    };
    // A captured HTML/SVG rendering is authoritative.  If materialization
    // fails, keep the source/diagnostic state instead of silently replacing the
    // platform's picture with a newly generated Mermaid chart.  Local Mermaid
    // is only a fallback when the source had no captured rendering at all.
    if (rendered) void this.#resolvedImage(display, rendered, "diagram", this.#labels.diagram, generation);
    else void renderSource();
    if (sourcePanel) {
      const tabs = element(document, "div", "cloudig-diagram-tabs");
      const imageButton = element(document, "button", "cloudig-diagram-tab is-active", writing ? (/^(?:Diagram|Chart)$/u.test(this.#labels.diagram) ? "Document" : "成品文本") : this.#labels.diagram);
      const sourceButton = element(document, "button", "cloudig-diagram-tab", this.#labels.source);
      imageButton.type = sourceButton.type = "button";
      imageButton.dataset["diagramView"] = "diagram";
      sourceButton.dataset["diagramView"] = "source";
      imageButton.setAttribute("aria-pressed", "true");
      sourceButton.setAttribute("aria-pressed", "false");
      imageButton.addEventListener("click", () => {
        display.hidden = false;
        sourcePanel.hidden = true;
        imageButton.classList.add("is-active");
        sourceButton.classList.remove("is-active");
        imageButton.setAttribute("aria-pressed", "true");
        sourceButton.setAttribute("aria-pressed", "false");
      });
      sourceButton.addEventListener("click", () => {
        display.hidden = true;
        sourcePanel.hidden = false;
        sourceButton.classList.add("is-active");
        imageButton.classList.remove("is-active");
        imageButton.setAttribute("aria-pressed", "false");
        sourceButton.setAttribute("aria-pressed", "true");
      });
      tabs.append(imageButton, sourceButton);
      card.append(tabs);
    }
    const controls = card.querySelector(".cloudig-diagram-tabs") ?? element(document, "div", "cloudig-diagram-tabs");
    if (!controls.parentNode) card.append(controls);
    let zoom = 1;
    let initialWidth = 0;
    if (!writing) for (const [symbol, factor] of [["−", 1 / 1.5], ["＋", 1.5]] as const) {
      const button = element(document, "button", "cloudig-diagram-tab cloudig-diagram-zoom", symbol);
      button.type = "button";
      const english = this.#labels.diagram === "Diagram" || this.#labels.diagram === "Chart";
      button.title = factor > 1 ? (english ? "Zoom in" : "放大图表") : (english ? "Zoom out" : "缩小图表");
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => {
        if (display.hidden) return;
        const graphic = display.querySelector<HTMLElement>("img, svg");
        if (!graphic) return;
        if (zoom === 1) initialWidth = graphic.getBoundingClientRect().width;
        zoom = Math.max(1, Math.min(20, zoom * factor));
        graphic.style.width = zoom === 1 ? "" : `${initialWidth * zoom}px`;
        graphic.style.maxWidth = zoom === 1 ? "" : "none";
        graphic.style.maxHeight = zoom === 1 ? "" : "none";
        graphic.style.flexShrink = "0";
      });
      controls.append(button);
    }
    if (!controls.childNodes.length) controls.remove();
    card.append(display);
    if (sourcePanel) card.append(sourcePanel);
    return card;
  }

  #renderBlock(block: JsonObject, generation: number, ordinal: number, preserveLineBreaks = false): HTMLElement {
    const value = isJsonObject(block["value"]) ? block["value"] : {};
    const type = text(value["type"]);
    const category = text(block["category"]);
    const savedCard = renderSavedDil(this.#root.ownerDocument, value, this.#options.language ?? (this.#root.ownerDocument.documentElement.lang.startsWith("en") ? "en" : "zh"));
    if (savedCard) return savedCard;
    if (category === "reasoning" || category === "tool") return this.#renderProcess(block, value);
    if (category === "references") return this.#renderReferences(block, value);
    if (["markdown", "text", "code", "math", "html"].includes(type ?? "")) return this.#renderText(value, preserveLineBreaks, resourceMap(block));
    if (type === "image") return this.#renderImage(block, value, generation);
    if (type === "attachment") return this.#renderAttachment(block, value);
    if (type === "diagram") return this.#renderDiagram(block, value, generation, ordinal);
    if (type === "interactive" && value["format"] === "structured") {
      const files = Array.isArray(value["files"]) ? value["files"].filter(isJsonObject) : [];
      const resources = resourceMap(block);
      return renderStructuredBox({ document: this.#root.ownerDocument, language: this.#options.language ?? (this.#root.ownerDocument.documentElement.lang.startsWith("en") ? "en" : "zh"), signal: this.#abort.signal,
        ...(this.#options.workRuntime ? { mapFrameUrl: new URL('map-frame.html', this.#options.workRuntime.frameUrl).href, mapSameOrigin: true } : {}),
        image: (path, alt) => {
          const host = element(this.#root.ownerDocument, "div", "cloudig-box-image");
          const file = files.find(f => f["path"] === path), resource = resources.get(String(file?.["resource"]));
          if (resource) void this.#resolvedImage(host, resource, "image", alt, generation);
          else this.#resourceMetadata(host, alt);
          return host;
        }, onOpenExternal: url => this.#options.onOpenExternal?.(url)
      }, value);
    }
    if (type === "unknown") {
      const node = element(this.#root.ownerDocument, "div", "cloudig-unknown");
      if (text(value["resource"])) node.append(this.#renderAttachment(block, value));
      if (text(value["text"])) node.append(element(this.#root.ownerDocument, "p", "cloudig-text", text(value["text"])!));
      if (text(value["html"])) node.append(this.#renderText({ type: "html", html: value["html"]! }, false, resourceMap(block)));
      return node;
    }
    if (type === "interactive") {
      const document = this.#root.ownerDocument, entry = text(value["entry"]), title = text(value["title"]) ?? entry ?? String(value["source"]);
      const host = element(document, "section", "cloudig-box cloudig-window-entry");
      const files = Array.isArray(value["files"]) ? value["files"].filter(isJsonObject) : [], resources = resourceMap(block);
      const language = this.#options.language ?? (document.documentElement.lang.startsWith("en") ? "en" : "zh");
      const workFormat = String(value["format"]) as InteractiveFormat;
      const inline = value["display"] === "box" && value["format"] === "html";
      const data = isJsonObject(value["data"]) ? value["data"] : {};
      const icons = Array.isArray(data["icons"]) ? data["icons"].filter(isJsonObject).flatMap(icon => typeof icon["name"] === "string" && typeof icon["path"] === "string" ? [{ name: icon["name"], path: icon["path"] }] : []) : [];
      if (!inline) {
        const summary = element(document, "div", "cloudig-work-summary"), info = element(document, "div", "cloudig-file-info");
        info.append(element(document, "h3", "cloudig-box-heading cloudig-work-title", entry ?? title));
        if (entry && title !== entry) info.append(element(document, "p", "cloudig-work-description", title));
        info.append(element(document, "span", "cloudig-file-meta", [workFormat.toUpperCase(), files.length > 1 ? `${files.length} ${language === "en" ? "files" : "个文件"}` : ""].filter(Boolean).join(" · ")));
        summary.append(resourceIcon(document, resourceKind(entry ?? "", "")), info); host.append(summary);
      }
      if (entry && ["html", "react", "svg", "document", "slides", "design", "design-system"].includes(workFormat)) {
        const launch = () => {
          if (generation !== this.#generation || this.#abort.signal.aborted) return;
          let release: (() => void) | undefined;
          const instance = openInteractiveWindow({ document, title, entry, format: workFormat, theme: this.#theme, language, signal: this.#abort.signal,
            ...(this.#options.workRuntime ? { frameUrl: this.#options.workRuntime.frameUrl, opaqueOrigin: true } : {}),
            source: String(value["source"]), icons, ...(inline ? { inlineParent: host } : {}),
            onClose: () => { if (release) { const at = this.#releases.indexOf(release); if (at >= 0) this.#releases.splice(at, 1); } },
            stateKey: JSON.stringify([this.#view?.["conversation_id"] ?? this.#view?.["archive"], block["anchor"], value["source"], files.map(f => [f["path"], resources.get(String(f["resource"]))?.["sha256"] ?? f["resource"]])]),
            readFiles: async signal => {
              const output = await mapInteractiveAssets(files, signal, async (file): Promise<InteractiveFile | undefined> => {
                const resource = resources.get(String(file["resource"]));
                if (!resource || resource["availability"] !== "embedded" || !this.#options.resolveResource) {
                  if (file["path"] === entry) throw new Error(language === "en" ? "This saved file does not contain the work's entry." : "这份档案未包含作品入口文件。");
                  return undefined;
                }
                const read = async () => {
                  const resolved = await this.#options.resolveResource!(resource, "interactive", signal);
                  try { const response = await fetch(resolved.url, { signal }); if (!response.ok) throw new Error(language === "en" ? "Could not read the saved work file." : "无法读取已保存的作品文件。"); return await response.arrayBuffer(); }
                  finally { resolved.release?.(); }
                };
                const hash = text(resource["sha256"]);
                const bytes = hash && /^[a-f0-9]{64}$/iu.test(hash) ? await readInteractiveAsset(`resource:${hash.toLowerCase()}`, signal, read) : await read();
                const original = isJsonObject(resource["original"]) ? resource["original"] : {};
                const url = text(original["url"] ?? resource["original_url"]);
                return { path: String(file["path"]), mime: text(resource["mime"]) ?? "application/octet-stream", bytes, ...(url ? { aliases: [url] } : {}) };
              }); return output.filter((file): file is InteractiveFile => file !== undefined);
            },
            dependencies: (files, signal) => loadInteractiveDependencies(files, signal, this.#options.workRuntime?.dependencies ?? new URL("/runtime/dependencies/", document.baseURI).href, workFormat)
          }); release = instance.close; this.#releases.push(release);
        };
        if (inline) launch();
        else {
          const open = element(document, "button", "cloudig-box-button cloudig-box-primary cloudig-work-open", language === "en" ? "Open" : "打开"); open.type = "button";
          open.addEventListener("click", launch); host.append(open);
        }
      }
      // Inline glyph/source files are implementation inputs, not extra cards.
      // They remain available without filling the conversation with icon rows.
      const attachments = element(document, "details", "cloudig-box-files");
      attachments.append(element(document, "summary", "", `${language === "en" ? "Files" : "文件"} (${files.length})`));
      for (const file of files) attachments.append(this.#renderAttachment(block, { resource: file["resource"]!, name: file["path"]! }));
      if (files.length) host.append(attachments);
      return host;
    }
    return element(this.#root.ownerDocument, "div", "cloudig-unknown");
  }

  #renderMessage(message: JsonObject, generation: number, summaryOwner?: ReturnType<typeof details>): HTMLElement {
    const document = this.#root.ownerDocument;
    const party = isJsonObject(message["party"]) ? message["party"] : {};
    const role = text(party["role"]) ?? "other";
    const blocks = Array.isArray(message["blocks"]) ? message["blocks"].filter(isJsonObject) : [];
    const systemParty = (block: JsonObject): JsonObject | undefined => {
      const value = isJsonObject(block["value"]) ? block["value"] : {};
      return isJsonObject(value["party"]) && value["party"]["role"] === "system" ? value["party"] : undefined;
    };
    if (role !== "system" && blocks.some(systemParty)) {
      // One canonical message/branch anchor, several independent visual nodes.
      // Never wrap a platform message in the user's speech bubble or change
      // stored message IDs to achieve a reading layout.
      const envelope = element(document, "section", "cloudig-message-envelope");
      const anchor = text(message["anchor"]) ?? `message-${String(message["source_index"])}`;
      envelope.id = anchor;
      envelope.dataset["role"] = role;
      let run: JsonObject[] = [], runParty = party, part = 0;
      const flush = () => {
        if (!run.length) return;
        const segment: JsonObject = { ...message, anchor: `${anchor}-part-${++part}`, party: runParty, blocks: run };
        if (runParty["role"] === "system") { delete segment["model"]; delete segment["timestamp"]; }
        envelope.append(this.#renderMessage(segment, generation)); run = [];
      };
      for (const [index, block] of blocks.entries()) {
        const nextParty = systemParty(block) ?? party;
        if (nextParty["role"] !== runParty["role"] || nextParty["name"] !== runParty["name"]) flush();
        runParty = nextParty;
        run.push({ ...block, anchor: text(block["anchor"]) ?? `${anchor}-process-${index + 1}` });
      }
      flush(); return envelope;
    }
    const article = element(document, "article", `cloudig-message cloudig-message-${role}`);
    const continuation = role === 'assistant' && message['assistant_continuation'] === true;
    const processContinuation = message['process_continuation'] === true;
    if (continuation) article.dataset['assistantContinuation'] = 'true';
    if (processContinuation) article.dataset['processContinuation'] = 'true';
    article.id = text(message["anchor"]) ?? `message-${String(message["source_index"])}`;
    article.dataset["role"] = role;
    const header = element(document, "header", "cloudig-message-header");
    const identity = element(document, "button", "cloudig-message-identity");
    identity.type = "button";
    if (role === "system") { identity.disabled = true; identity.title = text(party["name"]) ?? this.#labels.systemParty; }
    else identity.addEventListener("click", () => this.#options.onEditIdentity?.(role));
    const avatarReference = text(party["avatar"]);
    if (role === "system" && !avatarReference) {
      const avatarHost = element(document, "span", "cloudig-avatar cloudig-system-avatar");
      const image = element(document, "img"); image.src = "/assets/identity/System-Avatar.svg"; image.alt = "";
      avatarHost.append(image); identity.append(avatarHost);
    }
    if (!continuation && avatarReference && this.#options.resolveAvatar) {
      const avatarHost = element(document, "span", "cloudig-avatar");
      if (party["avatar_variant"] === "agent-instance") avatarHost.classList.add("cloudig-agent-avatar");
      identity.append(avatarHost);
      void this.#resolveAvatar(avatarReference).then((resolved) => {
        if (generation !== this.#generation || this.#abort.signal.aborted) {
          return;
        }
        const image = element(document, "img");
        image.alt = "";
        image.src = resolved.url;
        avatarHost.replaceChildren(image);
      }).catch(() => undefined);
    }
    const fallbackName = role === "system"
      ? this.#labels.systemParty
      : role === "tool"
        ? this.#labels.toolParty
        : this.#labels.otherParty;
    identity.append(element(document, "span", "cloudig-message-name", role === "system" ? fallbackName : text(party["name"]) ?? fallbackName));
    if (!continuation && !processContinuation) header.append(identity);
    const meta = element(document, "div", "cloudig-message-meta");
    if (text(message["model"])) meta.append(element(document, "span", "cloudig-model-tag", text(message["model"])!));
    if (text(message["timestamp"])) {
      const rawTimestamp = text(message["timestamp"])!;
      const timestamp = element(
        document,
        "time",
        "cloudig-message-time",
        this.#options.formatTimestamp?.(rawTimestamp) ?? rawTimestamp
      );
      timestamp.dateTime = rawTimestamp;
      meta.append(timestamp);
    }
    if (!processContinuation && meta.childElementCount > 0) header.append(meta);
    if (header.childElementCount > 0) article.append(header);
    const body = element(document, "div", "cloudig-message-content");
    let processRun: Array<{ node: HTMLElement; block: JsonObject }> = [];
    const flushProcess = () => {
      if (!processRun.length) return;
      if (processRun.length > 1 && processRun.some(item => item.node.tagName === "DETAILS")) {
        const contextOnly = processRun.every(item => isJsonObject(item.block["value"]) && isClaudeContext(item.block["value"]));
        const groupTitle = contextOnly ? (this.#options.language === "en" ? "Claude platform context" : "Claude 平台上下文") : this.#labels.processGroup ?? this.#labels.toolActivity;
        const count = processRun.reduce((total, item) => total + Number(item.node.dataset["summaryCount"] ?? 1), 0);
        const group = details(document, `cloudig-process-group${contextOnly ? " cloudig-platform-context-group" : ""}`, `${groupTitle} · ${count}`, processRun.every(item => item.block["collapsed"] === true));
        group.body.append(...processRun.map(item => item.node)); body.append(group.root);
        this.#defer(group, () => { for (const sequence of group.body.querySelectorAll<HTMLDetailsElement>(".cloudig-summary-sequence")) sequence.open = true; });
      } else body.append(...processRun.map(item => item.node));
      processRun = [];
    };
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const value = isJsonObject(block["value"]) ? block["value"] : {};
      if (summaryOwner && isSummaryView(block)) {
        const entry = this.#summaryEntry(block, summaryOwner); entry.id = text(block["anchor"]) ?? `${article.id}-process-${index + 1}`;
        entry.dataset["category"] = "reasoning"; body.append(entry); continue;
      }
      if (isSummaryView(block)) {
        let end = index + 1;
        while (end < blocks.length && isSummaryView(blocks[end]!) && sameSummarySpeaker(value, blocks[end]!["value"] as JsonObject)) end++;
        if (end > index + 1) {
          const sequence = this.#summarySequence(blocks.slice(index, end));
          sequence.id = text(block["anchor"]) ?? `${article.id}-process-${index + 1}`; sequence.dataset["category"] = "reasoning";
          processRun.push({ node: sequence, block }); index = end - 1; continue;
        }
      }
      const next = blocks[index + 1];
      const nextValue = next && isJsonObject(next["value"]) ? next["value"] : undefined;
      const imageName = text(value["alt"]) ?? resourceMap(block).get(String(value["resource"]))?.["name"];
      const attachmentName = next && nextValue ? resourceMap(next).get(String(nextValue["resource"]))?.["name"] : undefined;
      if (value["type"] === "image" && value["purpose"] === "attachment-thumbnail"
        && nextValue?.["type"] === "attachment" && imageName && imageName === attachmentName) {
        const card = this.#renderAttachment(next!, nextValue);
        flushProcess();
        card.querySelector(".cloudig-file-icon")?.replaceWith(this.#renderImage(block, value, generation));
        card.dataset["category"] = "content";
        body.append(card);
        index += 1;
        continue;
      }
      const rendered = this.#renderBlock(block, generation, index + 1, role === "user");
      const category = text(block["category"]) ?? "content";
      rendered.dataset["category"] = category;
      if (category !== "content") rendered.id = text(block["anchor"]) ?? `${article.id}-process-${index + 1}`;
      if (["reasoning", "tool", "references"].includes(category) && !rendered.classList.contains("cloudig-schedule")) processRun.push({ node: rendered, block });
      else { flushProcess(); body.append(rendered); }
    }
    flushProcess();
    article.append(body);
    return article;
  }

  #appendMessages(list: Element, messages: JsonObject[], generation: number): void {
    const processCategories = new Set(["reasoning", "reasoning_summary", "tool", "references", "status", "search", "citations"]);
    const processOnly = (message: JsonObject): boolean => {
      if (Array.isArray(message["branch_controls"]) && message["branch_controls"].length) return false;
      const party = isJsonObject(message["party"]) ? message["party"] : {};
      const role = text(party["role"]);
      const blocks = Array.isArray(message["blocks"]) ? message["blocks"].filter(isJsonObject) : [];
      if (!blocks.length) return false;
      // System and tool records are transport/process material by definition;
      // even a lone record must be folded so it cannot become a full-height
      // article between two authored turns.
      if (role === "system" || role === "tool") return true;
      if (role !== "assistant" || text(message["summary_sequence"])) return false;
      const categories = blocks.map(block => {
        const value = isJsonObject(block["value"]) ? block["value"] : {};
        return text(block["category"]) ?? text(value["type"]);
      });
      return categories.length > 0
        && categories.some(category => processCategories.has(String(category)))
        && categories.every(category => processCategories.has(String(category)));
    };
    for (let index = 0; index < messages.length; index += 1) {
      const sourceMessage = messages[index]!;
      if (processOnly(sourceMessage)) {
        let end = index + 1;
        while (end < messages.length && processOnly(messages[end]!)) end += 1;
        if (end > index) {
          this.#summaryTail = undefined;
          const processMessages = messages.slice(index, end);
          const expanded = processMessages.some(source => (Array.isArray(source["blocks"]) ? source["blocks"].filter(isJsonObject) : []).some(block => block["collapsed"] === false));
          const group = details(this.#root.ownerDocument, "cloudig-process cloudig-process-group cloudig-tool-message-group", `${this.#labels.processGroup ?? this.#labels.toolActivity} · ${end - index}`, !expanded);
          const axisRow = element(this.#root.ownerDocument, "section", "cloudig-process-axis-row");
          this.#appendProcessIdentity(group.root, processMessages, generation, axisRow);
          for (let offset = index; offset < end; offset += 1) {
            const source = messages[offset]!;
            // The group heading is the only visible identity for process
            // material. Do not repeat an avatar/header for the first item
            // either; that was the reason Codex tool runs still filled the
            // screen after the old multi-item-only fold.
            const message = { ...source, assistant_continuation: false, process_continuation: true };
            group.body.append(this.#renderMessage(message, generation));
          }
          axisRow.append(group.root);
          list.append(axisRow);
          index = end - 1;
          continue;
        }
      }
      // Search previews and offset opens may start in the middle of a run.
      // Keep a heading when its preceding process is outside this rendered list.
      const message = sourceMessage['assistant_continuation'] === true && !list.childElementCount
        ? { ...sourceMessage, assistant_continuation: false } : sourceMessage;
      const key = text(message["summary_sequence"]), blocks = Array.isArray(message["blocks"]) ? message["blocks"].filter(isJsonObject) : [];
      if (!key || !blocks.length || !blocks.every(isSummaryView) || Array.isArray(message["branch_controls"])) {
        this.#summaryTail = undefined; list.append(this.#renderMessage(message, generation)); continue;
      }
      if (this.#summaryTail?.key !== key) {
        const wrapper = element(this.#root.ownerDocument, "section", "cloudig-summary-messages");
        const group = details(this.#root.ownerDocument, "cloudig-process cloudig-reasoning cloudig-summary-sequence cloudig-summary-message-fold", "", blocks.every(b => b["collapsed"] === true));
        const article = this.#renderMessage(message, generation, group); article.classList.add("cloudig-summary-message");
        const header = article.querySelector(":scope > .cloudig-message-header"); if (header) wrapper.append(header);
        group.body.append(article); wrapper.append(group.root); list.append(wrapper);
        this.#summaryTail = { key, group, count: blocks.length };
      } else {
        const article = this.#renderMessage(message, generation, this.#summaryTail.group); article.classList.add("cloudig-summary-message");
        this.#summaryTail.group.body.append(article); this.#summaryTail.count += blocks.length;
      }
      this.#summaryTail.group.root.querySelector(":scope > summary > .cloudig-fold-label")!.textContent = `${this.#labels.reasoningSummary ?? this.#labels.reasoning} · ${this.#summaryTail.count}`;
    }
  }

  render(view: JsonObject): void {
    this.#release();
    this.#generation += 1;
    const generation = this.#generation;
    this.#root.classList.add("cloudig-conversation-renderer");
    this.#root.dataset["theme"] = this.#theme;
    this.#view = view;
    const list = element(this.#root.ownerDocument, "div", "cloudig-message-list");
    const messages = Array.isArray(view["messages"]) ? view["messages"].filter((entry): entry is JsonObject => isJsonObject(entry)) : [];
    this.#appendMessages(list, messages, generation);
    this.#root.replaceChildren(list);
    const images = Array.isArray(view['conversation_images']) ? view['conversation_images'].filter(isJsonObject) : [];
    if (images.length) {
      const en = this.#options.language === 'en';
      const gallery = details(this.#root.ownerDocument, 'cloudig-conversation-images', `${en ? 'Conversation images' : '会话附图'} · ${images.length}`, true);
      this.#defer(gallery, () => {
        gallery.body.append(element(this.#root.ownerDocument, 'p', 'cloudig-conversation-images-note', en
          ? 'Images saved with this conversation without an available message location.' : '随本篇保存、但无法定位到原消息的图片。'));
        const grid = element(this.#root.ownerDocument, 'div', 'cloudig-conversation-images-grid');
        for (const resource of images) grid.append(this.#renderImage({ resources: [resource] }, { resource: resource['id']!, ...(text(resource['name']) ? { caption: resource['name']! } : {}) }, generation));
        gallery.body.append(grid);
      });
      this.#root.prepend(gallery.root);
    }
  }

  append(view: JsonObject): void {
    if (!this.#view) { this.render(view); return; }
    const messages = Array.isArray(view["messages"]) ? view["messages"].filter((entry): entry is JsonObject => isJsonObject(entry)) : [];
    const list = this.#root.querySelector(".cloudig-message-list")!;
    this.#appendMessages(list, messages, this.#generation);
    this.#view = { ...this.#view, messages: [...this.#view["messages"] as JsonValue[], ...messages] };
  }

  destroy(): void {
    this.#generation += 1;
    this.#release();
    if (!this.#options.runtime) this.#runtime.dispose?.();
    this.#root.removeEventListener("click", this.#handleClick);
    this.#view = undefined;
    this.#root.replaceChildren();
  }
}

export function createConversationRenderer(options: ConversationRendererOptions): ConversationRenderer {
  return new ConversationRenderer(options);
}
