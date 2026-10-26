import {
  defaultTreeAdapter,
  parseFragment,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterTypes
} from "parse5";

import { mapSequential, type AdapterManifest, type AdapterParseContext, type SourceAdapter } from "../../app/parser/adapter.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { capturedMathIsDisplay, inertHtmlEvidence, inertHtmlFragment, inertStandaloneSvg, preserveNestedImage, preserveNestedMath, restoreCapturedProcess } from "./inert-html.mts";
import { normalizeMermaidSource } from "./markdown-diagrams.mts";
import { capturedReferences } from "./captured-references.mts";
import { KimiRichContent } from "./kimi-rich.mts";
import { WorkResources } from "./work-resources.mts";

type Profile = "light" | "full" | "tree";
type Parent = DefaultTreeAdapterTypes.ParentNode;
type Child = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function values(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function sourceText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function httpUrl(value: JsonValue | undefined): string | undefined {
  const text = sourceText(value);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}

function mimeType(value: JsonValue | undefined): string | undefined {
  const text = sourceText(value)?.split(";", 1)[0]?.trim().toLowerCase();
  return text && /^[^\s/]+\/[^\s/]+$/u.test(text) ? text : undefined;
}

function timestamp(value: JsonValue | undefined): string | undefined {
  if (isJsonObject(value)) {
    const seconds = value["seconds"];
    const nanos = value["nanos"];
    if ((typeof seconds === "string" || typeof seconds === "number") && typeof nanos === "number" && Number.isSafeInteger(nanos)) {
      try {
        const milliseconds = Number(BigInt(String(seconds)) * 1000n + BigInt(Math.trunc(nanos / 1_000_000)));
        const date = new Date(milliseconds);
        return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
      } catch {
        return undefined;
      }
    }
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(typeof value === "number" && value > 0 && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}


function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isElement(node: Child): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name.toLowerCase() === name)?.value;
}

function classes(element: Element): Set<string> {
  return new Set((attribute(element, "class") ?? "").split(/\s+/u).filter(Boolean));
}

function hasClass(element: Element, name: string): boolean {
  return classes(element).has(name);
}

function descendants(parent: Parent): Element[] {
  const result: Element[] = [];
  const visit = (node: Parent): void => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      result.push(child);
      visit(child);
    }
  };
  visit(parent);
  return result;
}

function textContent(parent: Parent): string {
  const result: string[] = [];
  const visit = (node: Parent): void => {
    for (const child of node.childNodes) {
      if (isElement(child)) visit(child);
      else if (child.nodeName === "#text" && "value" in child) result.push(child.value);
    }
  };
  visit(parent);
  return result.join("");
}

function firstDataUrl(parent: Parent): string | undefined {
  for (const element of descendants(parent)) {
    const value = element.tagName.toLowerCase() === "img"
      ? attribute(element, "src")
      : element.tagName.toLowerCase() === "a"
        ? attribute(element, "href")
        : undefined;
    if (value?.startsWith("data:")) return value;
  }
  return undefined;
}

function marker(index: number): string {
  return `\uE000CLOUDIG_KIMI_BLOCK_${index}\uE001`;
}

class KimiResourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();

  #allocate(key: string, resource: Omit<JsonObject, "id">): string {
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...resource });
    this.#byKey.set(key, id);
    return id;
  }

  addAttachment(raw: JsonObject, dataUrl: string | undefined, limitations: JsonObject[]): JsonObject {
    const isImage = sourceText(raw["kind"])?.toLowerCase() === "image";
    const kind = isImage ? "image" : "file";
    const name = sourceText(raw["name"]);
    const declaredMime = mimeType(raw["mime_type"]);
    const originalBytes = nonNegativeInteger(raw["size"] ?? raw["bytes"]);
    if (dataUrl?.startsWith("data:")) {
      const embedded = isImage ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      const sha256 = embedded.sha256;
      const resource = this.#allocate(`${kind}\u0000${name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
        kind,
        availability: "embedded",
        ...(name ? { name } : {}),
        mime: embedded.mime,
        ...(declaredMime && declaredMime !== embedded.mime ? { original_mime: declaredMime } : {}),
        bytes: embedded.byteLength,
        sha256,
        ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
        ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
      });
      return isImage ? { type: "image", resource } : { type: "attachment", resource };
    }
    const status = sourceText(raw["status"])?.toLowerCase() ?? "";
    const availability = status.includes("missing") || status.includes("failed") ? "missing" : "metadata_only";
    const resource = this.#allocate(canonicalizeJcs({ kind, name: name ?? "", mime: declaredMime ?? "", originalBytes: originalBytes ?? -1, availability }), {
      kind,
      availability,
      ...(name ? { name } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
    });
    if (availability === "missing") {
      const at = this.values.findIndex((entry) => entry["id"] === resource);
      limitations.push({ code: "kimi_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
    }
    return isImage ? { type: "image", resource } : { type: "attachment", resource };
  }

  addImage(dataUrl: string, alt?: string, width?: number, height?: number): JsonObject {
    const embedded = embeddedImageDataUrl(dataUrl);
    const sha256 = embedded.sha256;
    const resource = this.#allocate(`image\u0000${alt ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
      kind: "image",
      availability: "embedded",
      ...(alt ? { name: alt } : {}),
      mime: embedded.mime,
      bytes: embedded.byteLength,
      sha256,
      ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
      ...(width && height ? { dimensions: { width, height } } : {})
    });
    return { type: "image", resource, ...(alt ? { alt } : {}) };
  }

  addDiagram(dataUrl: string): string {
    const embedded = embeddedImageDataUrl(dataUrl);
    const sha256 = embedded.sha256;
    return this.#allocate(`diagram\u0000${embedded.mime}\u0000${sha256}`, {
      kind: "diagram",
      availability: "embedded",
      mime: embedded.mime,
      bytes: embedded.byteLength,
      sha256,
      ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {})
    });
  }
}

class KimiSourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string[]>();

  add(raw: JsonObject): string | undefined {
    const url = httpUrl(raw["url"]);
    if (!url) return undefined;
    const title = sourceText(raw["title"]);
    const hostname = sourceText(raw["site_name"]) ?? sourceText(raw["hostname"]);
    const snippet = sourceText(raw["snippet"]);
    const key = `${url}\u0000${title ?? ""}`;
    const candidates = this.#byKey.get(key) ?? [];
    const entry = candidates.map(id => this.values.find(value => value["id"] === id)!).find(value =>
      !snippet || !value["snippet"] || value["snippet"] === snippet);
    if (entry) {
      if (snippet && !entry["snippet"]) entry["snippet"] = snippet;
      if (hostname && !entry["name"]) entry["name"] = hostname;
      return String(entry["id"]);
    }
    const id = `s${this.values.length + 1}`;
    this.values.push({ id, kind: "web", url, ...(title ? { title } : {}), ...(hostname ? { name: hostname } : {}), ...(snippet ? { snippet } : {}) });
    this.#byKey.set(key, [...candidates, id]);
    return id;
  }

  addAll(raw: JsonValue | undefined): string[] {
    return unique(values(raw).flatMap((value) => {
      const source = object(value);
      const id = source ? this.add(source) : undefined;
      return id ? [id] : [];
    }));
  }
}

type DiagramEntry = { value: JsonObject; used: boolean; rendered?: string };
type DiagramEvidence = Readonly<{ value: JsonObject; rendered?: string }>;

class KimiDiagramPool {
  readonly #entries: DiagramEntry[];

  constructor(raw: JsonValue | undefined) {
    this.#entries = values(raw).map((value) => {
      const item = object(value);
      if (!item) throw new TypeError("Kimi diagram record is not an object");
      return { value: item, used: false };
    });
  }

  observeHtml(html: string): void {
    const fragment = parseFragment(html);
    for (const element of descendants(fragment)) {
      if (hasClass(element, "osis-mermaid-card")) {
        const source = descendants(element)
          .filter((candidate) => candidate.tagName.toLowerCase() === "code" && hasClass(candidate, "language-mermaid"))
          .map((candidate) => textContent(candidate))
          .find((value) => value.length > 0);
        const normalized = source ? normalizeMermaidSource(source) : undefined;
        const entry = this.#entries.find((candidate) => sourceText(candidate.value["kind"]) === "mermaid"
          && (!normalized || normalizeMermaidSource(sourceText(candidate.value["source"]) ?? "") === normalized));
        const rendered = svgDataUrl(element);
        if (entry && rendered && !entry.rendered) entry.rendered = rendered;
      } else if (element.tagName.toLowerCase() === "svg" && (hasClass(element, "markmap-svg") || attribute(element, "data-osis-static-diagram") !== undefined)) {
        const entry = this.#entries.find((candidate) => sourceText(candidate.value["kind"]) === "markmap" && !candidate.rendered);
        const rendered = svgDataUrl(element);
        if (entry && rendered) entry.rendered = rendered;
      }
    }
  }

  take(kind: string, source?: string): DiagramEvidence | undefined {
    const normalized = source ? normalizeMermaidSource(source) : undefined;
    const exact = this.#entries.find((entry) => !entry.used
      && sourceText(entry.value["kind"]) === kind
      && (!normalized || normalizeMermaidSource(sourceText(entry.value["source"]) ?? "") === normalized));
    if (!exact) return undefined;
    exact.used = true;
    return { value: exact.value, ...(exact.rendered ? { rendered: exact.rendered } : {}) };
  }

  remaining(): DiagramEvidence[] {
    const result: DiagramEvidence[] = [];
    for (const entry of this.#entries) {
      if (entry.used) continue;
      entry.used = true;
      result.push({ value: entry.value, ...(entry.rendered ? { rendered: entry.rendered } : {}) });
    }
    return result;
  }
}

type MarkdownLine = Readonly<{ body: string; eol: string; raw: string }>;

function markdownLines(value: string): MarkdownLine[] {
  const result: MarkdownLine[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    let end = cursor;
    while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end += 1;
    const eol = end < value.length ? value[end] === "\r" && value[end + 1] === "\n" ? "\r\n" : value[end]! : "";
    const body = value.slice(cursor, end);
    result.push({ body, eol, raw: `${body}${eol}` });
    cursor = end + eol.length;
  }
  return result;
}

function fence(line: string): Readonly<{ character: string; length: number; info: string }> | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/u.exec(line);
  return match ? { character: match[1]![0]!, length: match[1]!.length, info: match[2]!.trim().toLowerCase() } : undefined;
}

function closes(line: string, opening: Readonly<{ character: string; length: number }>): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
  return Boolean(match && match[1]![0] === opening.character && match[1]!.length >= opening.length);
}

function projectProcessMarkdown(
  value: string,
  diagrams: KimiDiagramPool,
  resources: KimiResourcePool,
  mode: "reasoning" | "markdown",
  title?: string
): JsonObject[] {
  const lines = markdownLines(value);
  const result: JsonObject[] = [];
  const text: string[] = [];
  let titled = false;
  const flush = (): void => {
    const body = text.join("");
    text.length = 0;
    if (body.trim().length === 0) return;
    result.push(mode === "reasoning"
      ? { type: "reasoning", text: body, format: "markdown", ...(!titled && title ? { title } : {}) }
      : { type: "markdown", text: body });
    titled = true;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const opening = fence(lines[index]!.body);
    if (!opening || !["mermaid", "markmap", "mindmap"].includes(opening.info)) {
      text.push(lines[index]!.raw);
      continue;
    }
    let end = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (closes(lines[cursor]!.body, opening)) {
        end = cursor;
        break;
      }
    }
    if (end < 0) {
      text.push(lines[index]!.raw);
      continue;
    }
    flush();
    const source = lines.slice(index + 1, end).map((entry) => entry.raw).join("").replace(/(?:\r\n|\r|\n)$/u, "");
    const format = opening.info === "mindmap" ? "markmap" : opening.info;
    const record = diagrams.take(format, source);
    result.push({
      type: "diagram",
      format,
      source: sourceText(record?.value["source"]) ?? source,
      ...(record?.rendered ? { rendered: resources.addDiagram(record.rendered) } : {})
    });
    index = end;
  }
  flush();
  return result;
}

function publicProcessBlocks(
  message: JsonObject,
  diagrams: KimiDiagramPool,
  resources: KimiResourcePool
): JsonObject[] {
  const result: JsonObject[] = [];
  for (const raw of values(message["public_processes"])) {
    const process = object(raw);
    if (!process) throw new TypeError("Kimi public process is not an object");
    const kind = sourceText(process["kind"]);
    const title = sourceText(process["title"]);
    const content = sourceText(process["content"]);
    if (kind === "thinking") {
      if (content) result.push(...projectProcessMarkdown(content, diagrams, resources, "reasoning", title));
      else if (title) result.push({ type: "reasoning", title });
    } else if (kind === "search") {
      result.push({ type: "tool", kind: "activity", name: "web-search", ...(title ? { title } : {}) });
    } else if (kind === "tool") {
      result.push({ type: "tool", kind: "activity", ...(title ? { title } : {}), ...(content ? { output: { text: content } } : {}) });
    } else if (content || title) {
      result.push({ type: "unknown", kind: `kimi-${kind ?? "process"}`, text: content ?? title! });
    }
  }
  return result;
}

function toolOutput(value: JsonObject): JsonObject | undefined {
  const result: JsonObject = {};
  for (const key of ["source", "contents", "status", "meta", "action", "loadType", "contentCount", "errorCode"] as const) {
    if (value[key] !== undefined) result[key] = value[key]!;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function apiProcessBlocks(
  message: JsonObject,
  diagrams: KimiDiagramPool,
  resources: KimiResourcePool
): JsonObject[] {
  const api = object(message["api"]);
  if (!api) return publicProcessBlocks(message, diagrams, resources);
  const result: JsonObject[] = [];
  for (const raw of values(api["blocks"])) {
    const block = object(raw);
    const value = object(block?.["value"]);
    const type = sourceText(block?.["type"]);
    if (!block || !value) continue;
    if (type === "think") {
      const content = sourceText(value["content"]);
      const title = sourceText(value["summary"]);
      if (content) result.push(...projectProcessMarkdown(content, diagrams, resources, "reasoning", title));
      else if (title) result.push({ type: "reasoning", title });
    } else if (type === "tool") {
      const name = sourceText(value["name"]);
      const input = value["args"];
      const output = toolOutput(value);
      result.push({
        type: "tool",
        kind: "activity",
        ...(name ? { name } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(output ? { output } : {}),
        ...(typeof value["isError"] === "boolean" ? { success: !value["isError"] } : {})
      });
    }
  }
  return result.length > 0 ? result : publicProcessBlocks(message, diagrams, resources);
}

function svgDataUrl(element: Element): string | undefined {
  const svg = element.tagName.toLowerCase() === "svg"
    ? element
    : descendants(element).find((candidate) => candidate.tagName.toLowerCase() === "svg");
  if (!svg) return undefined;
  // The saved Kimi HTML applies these rules in its document stylesheet, outside
  // the SVG. Freeze those exact reading rules into the standalone image: the
  // browser's default <p> margins otherwise push edge labels outside their box.
  for (const foreign of descendants(svg).filter(node => node.tagName === "foreignObject")) {
    const style = foreign.attrs.find(item => item.name === "style");
    if (style) style.value += "; overflow: visible";
    else foreign.attrs.push({ name: "style", value: "overflow: visible" });
    for (const paragraph of descendants(foreign).filter(node => node.tagName === "p")) {
      const margin = paragraph.attrs.find(item => item.name === "style");
      if (margin) margin.value += "; margin: 0 !important";
      else paragraph.attrs.push({ name: "style", value: "margin: 0 !important" });
    }
  }
  const inert = inertStandaloneSvg(serializeOuter(svg));
  return inert ? `data:image/svg+xml;utf8,${encodeURIComponent(inert)}` : undefined;
}

function projectFragment(input: Readonly<{
  html: string;
  attachments: readonly JsonObject[];
  diagrams: KimiDiagramPool;
  resources: KimiResourcePool;
  limitations: JsonObject[];
  work?: KimiRichContent;
  owner?: string;
  nativeToolIds?: ReadonlySet<string>;
  finalize?: boolean;
  usedAttachments?: Set<number>;
  process?: (node: Element) => JsonObject[] | undefined;
}>): JsonObject[] {
  const fragment = parseFragment(input.html);
  const blocks: JsonObject[] = [];
  const usedAttachments = input.usedAttachments ?? new Set<number>();
  const addBlock = (block: JsonObject): string => {
    const index = blocks.length;
    blocks.push(block);
    return marker(index);
  };
  const attachmentIndex = (item: Element, kind: "image" | "file"): number | undefined => {
    const key = attribute(item, "data-resource-key");
    if (key) {
      const exact = input.attachments.findIndex((attachment, index) => !usedAttachments.has(index)
        && (sourceText(attachment["file_id"]) === key || sourceText(attachment["resource_locator"]) === key));
      if (exact >= 0) return exact;
    }
    const sameKind = input.attachments.findIndex((attachment, index) => !usedAttachments.has(index)
      && (sourceText(attachment["kind"]) === kind));
    if (sameKind >= 0) return sameKind;
    const any = input.attachments.findIndex((_, index) => !usedAttachments.has(index));
    return any >= 0 ? any : undefined;
  };
  const attachmentMarkers = (container: Element): string => {
    const items = descendants(container).filter((element) => hasClass(element, "osis-attachment") || hasClass(element, "attachment-list-image"));
    const result: string[] = [];
    for (const item of items) {
      const index = attachmentIndex(item, hasClass(item, "attachment-list-image") ? "image" : "file");
      if (index === undefined) continue;
      usedAttachments.add(index);
      result.push(addBlock(input.resources.addAttachment(input.attachments[index]!, firstDataUrl(item), input.limitations)));
    }
    return result.join("");
  };
  const rewrite = (parent: Parent): void => {
    const next: Child[] = [];
    for (const child of parent.childNodes) {
      if (!isElement(child)) {
        next.push(child);
        continue;
      }
      if (hasClass(child, "osis-sources") || attribute(child, "data-osis-source-list") !== undefined) continue;
      const process = input.process?.(child);
      if (process) { next.push(defaultTreeAdapter.createTextNode(process.map(addBlock).join(""))); continue; }
      // These are the reading projections of this message's captured process
      // records. Their API/public_processes representation is emitted above;
      // retaining the DOM summary would repeat it as ordinary answer text.
      if (hasClass(child, "osis-thinking") || hasClass(child, "osis-search") || hasClass(child, "osis-tool") || hasClass(child, "memory-block")) continue;
      if (hasClass(child, "plugin-toolcall")) {
        const controls = descendants(child).map(n => attribute(n, "aria-controls")).find(id => id?.startsWith("plugin-toolcall-detail-"));
        const id = controls?.slice("plugin-toolcall-detail-".length);
        if (!id || !input.nativeToolIds?.has(id)) {
          const entry = descendants(child).find(n => hasClass(n, "plugin-toolcall-entry"));
          const title = textContent(entry ?? child).replace(/\s+/gu, " ").trim();
          if (title) next.push(defaultTreeAdapter.createTextNode(addBlock({ type: "tool", kind: "activity", title })));
        }
        continue;
      }
      const work = input.work?.node(child, input.owner ?? "");
      if (work) { next.push(defaultTreeAdapter.createTextNode(work.map(addBlock).join(""))); continue; }
      if (hasClass(child, "attachment-list")) {
        const markers = attachmentMarkers(child);
        if (markers) next.push(defaultTreeAdapter.createTextNode(markers));
        continue;
      }
      const tex = attribute(child, "data-tex");
      if (hasClass(child, "osis-math") && tex) {
        const nested = preserveNestedMath(parent, child, tex, capturedMathIsDisplay(child));
        if (nested) { next.push(nested); continue; }
        next.push(defaultTreeAdapter.createTextNode(addBlock({
          type: "math",
          tex,
          ...(capturedMathIsDisplay(child) ? { display: true } : {})
        })));
        continue;
      }
      if (hasClass(child, "osis-mermaid-card")) {
        const source = descendants(child)
          .filter((element) => element.tagName.toLowerCase() === "code" && hasClass(element, "language-mermaid"))
          .map((element) => textContent(element))
          .find((value) => value.length > 0);
        const record = input.diagrams.take("mermaid", source);
        const canonicalSource = sourceText(record?.value["source"]) ?? source;
        const rendered = record?.rendered ?? svgDataUrl(child);
        if (canonicalSource || rendered) {
          next.push(defaultTreeAdapter.createTextNode(addBlock({
            type: "diagram",
            format: "mermaid",
            ...(canonicalSource ? { source: canonicalSource } : {}),
            ...(rendered ? { rendered: input.resources.addDiagram(rendered) } : {})
          })));
        }
        continue;
      }
      if (child.tagName.toLowerCase() === "svg" && (hasClass(child, "markmap-svg") || attribute(child, "data-osis-static-diagram") !== undefined)) {
        const record = input.diagrams.take("markmap");
        const source = sourceText(record?.value["source"]);
        const rendered = record?.rendered ?? svgDataUrl(child);
        if (source || rendered) {
          next.push(defaultTreeAdapter.createTextNode(addBlock({
            type: "diagram",
            format: "markmap",
            ...(source ? { source } : {}),
            ...(rendered ? { rendered: input.resources.addDiagram(rendered) } : {})
          })));
        }
        continue;
      }
      if (child.tagName.toLowerCase() === "img") {
        const dataUrl = attribute(child, "src");
        if (dataUrl?.startsWith("data:image/")) {
          const width = Number.parseInt(attribute(child, "width") ?? "", 10);
          const height = Number.parseInt(attribute(child, "height") ?? "", 10);
          const image = input.resources.addImage(
            dataUrl,
            attribute(child, "alt"),
            Number.isSafeInteger(width) && width > 0 ? width : undefined,
            Number.isSafeInteger(height) && height > 0 ? height : undefined
          );
          const icon = hasClass(child, "plugin-node-icon") || hasClass(child, "toolcall-title-name-icon") || ("tagName" in parent && (hasClass(parent, "plugin-node") || hasClass(parent, "plugin-node-icon")));
          if (icon) {
            const inline = defaultTreeAdapter.createElement("img", child.namespaceURI, [{ name: "data-cloudig-resource", value: String(image["resource"]) }, { name: "alt", value: attribute(child, "alt") ?? "" }, { name: "width", value: "20" }, { name: "height", value: "20" }, { name: "style", value: "display:inline-block;width:20px;height:20px;margin:0 4px 0 0;vertical-align:middle;object-fit:contain;border-radius:4px" }]);
            next.push(inline);
          } else next.push(preserveNestedImage(parent, child, image) ?? defaultTreeAdapter.createTextNode(addBlock(image)));
          continue;
        }
      }
      rewrite(child);
      next.push(child);
    }
    parent.childNodes = next;
    for (const child of next) child.parentNode = parent;
  };
  rewrite(fragment);
  const rich = descendants(fragment).find((element) => hasClass(element, "rich-content"));
  // Old captures place owned processes/files beside (and sometimes between)
  // rich bodies. Selecting only the first body silently drops their markers
  // after they have already been consumed. Keep those slots in source order,
  // without admitting unrelated outer chrome as answer prose.
  const readingSlots = (parent: Parent): string => parent.childNodes.map(child => {
    if (isElement(child)) return hasClass(child, "rich-content") ? serialize(child) : readingSlots(child);
    return "value" in child ? [...child.value.matchAll(/\uE000CLOUDIG_KIMI_BLOCK_[0-9]+\uE001/gu)].map(m=>m[0]).join("") : "";
  }).join("");
  const serialized = rich ? readingSlots(fragment) : serialize(fragment);
  const projected: JsonObject[] = [];
  for (const part of serialized.split(/(\uE000CLOUDIG_KIMI_BLOCK_[0-9]+\uE001)/u)) {
    const match = /^\uE000CLOUDIG_KIMI_BLOCK_([0-9]+)\uE001$/u.exec(part);
    if (match) {
      const block = blocks[Number.parseInt(match[1]!, 10)];
      if (block) projected.push(block);
      continue;
    }
    const evidence = inertHtmlEvidence(part);
    if (evidence.html && (textContent(parseFragment(evidence.html)).trim() || /<(?:img|svg|math|hr|br)\b/iu.test(evidence.html))) projected.push({ type: "html", html: evidence.html });
  }
  if (input.finalize === false) return projected;
  const unplaced = input.attachments.flatMap((attachment, index) => (
    usedAttachments.has(index) ? [] : [input.resources.addAttachment(attachment, undefined, input.limitations)]
  ));
  for (const record of input.diagrams.remaining()) {
    const kind = sourceText(record.value["kind"]) ?? "diagram";
    const source = sourceText(record.value["source"]);
    if (source || record.rendered) projected.push({
      type: "diagram",
      format: kind,
      ...(source ? { source } : {}),
      ...(record.rendered ? { rendered: input.resources.addDiagram(record.rendered) } : {})
    });
  }
  return [...unplaced, ...projected];
}

function orderedKimiContent(input: Parameters<typeof projectFragment>[0], message: JsonObject, htmls: readonly string[], sources: KimiSourcePool): JsonObject[] {
  const reading = htmls.join(""), dom = parseFragment(reading), usedAttachments = new Set<number>();
  const base = { ...input, usedAttachments, finalize: false };
  const native = values(object(message["api"])?.["blocks"]).filter(isJsonObject);
  const texts: Element[] = [], thoughts: Element[] = [];
  const visit = (node: Parent, inProcess = false): void => {
    for (const child of node.childNodes) if (isElement(child)) {
      if (hasClass(child, "osis-thinking")) { thoughts.push(child); continue; }
      const process = inProcess || hasClass(child, "toolcall-flow__item");
      if (hasClass(child, "markdown-container") && !process) { texts.push(child); continue; }
      visit(child, process);
    }
  };
  visit(dom);
  const nativeTexts = native.filter(b => b["type"] === "text");
  // Message identity + ordered native slots + a content witness establish the
  // projection. This never pairs unrelated messages by equal text.
  const witness = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("en-US");
  const paired = nativeTexts.length === texts.length && nativeTexts.every((b, i) => {
    const a = witness(String(object(b["value"])?.["content"] ?? "")), c = witness(textContent(texts[i]!));
    return !a || !c || a.includes(c.slice(0, 48)) || c.includes(a.slice(0, 48));
  });
  const firstText = native.findIndex(b => b["type"] === "text");
  if (!texts.length && firstText >= 0 && native.every((b, i) => !["think", "tool"].includes(String(b["type"])) || i < firstText)) {
    // Legacy exports have one aggregate rich body, not native text wrappers.
    // A formally leading process sequence can still retain its full payload.
    const process = restoreCapturedProcess(apiProcessBlocks(message, input.diagrams, input.resources), reading);
    return [...process, ...projectFragment({ ...base, html:reading, finalize:true })];
  }
  if (native.length && (texts.length > 0 && paired || !reading.trim())) {
    const result: JsonObject[] = []; let t = 0, thought = 0;
    for (const block of native) {
      if (block["type"] === "text") {
        const node = texts[t++], raw = sourceText(object(block["value"])?.["content"]);
        result.push(...(node ? projectFragment({ ...base, html: serializeOuter(node) }) : raw ? projectProcessMarkdown(raw, input.diagrams, input.resources, "markdown") : []));
      } else if (block["type"] === "think" || block["type"] === "tool") {
        let process = apiProcessBlocks({ api: { blocks: [block] } }, input.diagrams, input.resources);
        const panel = block["type"] === "think" ? thoughts[thought++] : undefined;
        if (panel) process = restoreCapturedProcess(process, serializeOuter(panel));
        result.push(...process);
      }
      result.push(...(input.work?.atBlock(input.owner ?? "", String(block["id"] ?? "")) ?? []));
    }
    for (const node of descendants(dom).filter(n => hasClass(n, "osis-kimi-file-catalog"))) result.push(...(input.work?.node(node, input.owner ?? "") ?? []));
    result.push(...projectFragment({ ...base, html: "", finalize: true }));
    return result;
  }
  // Light and older DOM captures: process panels retain their exact location.
  const publicThoughts = values(message["public_processes"]).filter(isJsonObject).filter(p => p["kind"] === "thinking");
  const nativeTools = new Map(native.filter(b => b["type"] === "tool" && b["id"] !== undefined).map(b => [String(b["id"]), b])); let thought = 0, observed = 0;
  const process = (node: Element): JsonObject[] | undefined => {
    if (hasClass(node, "osis-thinking")) {
      observed++;
      const raw = publicThoughts[thought++];
      if (raw) return restoreCapturedProcess(publicProcessBlocks({ public_processes: [raw] }, input.diagrams, input.resources), serializeOuter(node));
      const title = sourceText(textContent(node.childNodes.find(n => isElement(n) && n.tagName === "summary") as Parent ?? node).replace(/^思考\s*[·:：]?\s*/u, "")) ?? "思考";
      const children = node.childNodes.filter(n => !isElement(n) || n.tagName !== "summary");
      const body = children.map(n => isElement(n) ? serializeOuter(n) : "value" in n ? n.value : "").join("");
      const content = projectFragment({ ...base, html: body });
      return [{ type: "reasoning", title, ...(content.length ? { content } : {}) }];
    }
    const known = hasClass(node, "osis-tool") || hasClass(node, "osis-search") || hasClass(node, "plugin-toolcall");
    const flow = hasClass(node, "toolcall-flow__item");
    if (!known && !flow) return;
    if (flow && descendants(node).some(n => hasClass(n, "osis-thinking") || hasClass(n, "osis-tool") || hasClass(n, "osis-search") || hasClass(n, "plugin-toolcall") || attribute(n, "data-kimi-work"))) return;
    observed++;
    const nestedWorks = descendants(node).filter(n => attribute(n, "data-kimi-work")).flatMap(n => input.work?.node(n, input.owner ?? "") ?? []);
    const heading = descendants(node).find(n => n.tagName === "summary" || hasClass(n, "toolcall-title-container"));
    const title = (textContent(heading ?? node).replace(/\s+/gu, " ").trim().replace(/^工具\s*[·:：]?\s*/u, "")) || "工具";
    const controls = descendants(node).map(n => attribute(n, "aria-controls")).find(id => id?.startsWith("plugin-toolcall-detail-"));
    const blockId = attribute(node, "data-block-id") ?? controls?.slice("plugin-toolcall-detail-".length);
    const raw = blockId ? nativeTools.get(blockId) : undefined;
    if (raw) return [...apiProcessBlocks({ api: { blocks: [raw] } }, input.diagrams, input.resources), ...nestedWorks];
    const refs = sources.addAll(capturedReferences(serializeOuter(node), "kimi-search"));
    const full = textContent(node).trim();
    return [{ type: "tool", kind: "activity", title, ...(refs.length ? { output: { sources: refs } } : full && full !== title ? { output: { text: full } } : {}) }, ...nestedWorks];
  };
  const result = projectFragment({ ...base, html: reading, process, finalize: true });
  // Old captures can omit process panels entirely, while retaining their
  // payload as a leading group. Keep that documented legacy fallback only.
  return observed ? result : [...apiProcessBlocks(message, input.diagrams, input.resources), ...result];
}

function capturedKimiSources(reading: string): JsonObject[] {
  return descendants(parseFragment(reading)).filter(n => hasClass(n, "osis-sources")).flatMap(section => descendants(section).filter(n => n.tagName === "a").flatMap(link => {
    const url = httpUrl(attribute(link, "href")); if (!url) return [];
    const meta = link.parentNode ? descendants(link.parentNode).find(n => hasClass(n, "osis-source-meta")) : undefined;
    return [{ url, title: textContent(link).trim(), ...(meta ? { site_name: textContent(meta).trim() } : {}) }];
  }));
}

function linearMessages(payload: JsonObject, limitations: JsonObject[]): JsonObject[] {
  const input = values(payload["messages"]).map((raw) => {
    const message = object(raw);
    if (!message) throw new TypeError("Kimi message sequence contains a non-object entry");
    return message;
  });
  const byId = new Map<string, JsonObject>();
  for (const message of input) {
    const id = sourceText(message["id"]);
    if (!id || byId.has(id)) throw new TypeError("Kimi message identity is missing or duplicated");
    byId.set(id, message);
  }
  const result: JsonObject[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (const raw of values(payload["message_order"])) {
    const id = sourceText(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const message = byId.get(id);
    if (message) result.push(message);
    else missing += 1;
  }
  const unordered = input.filter((message) => !seen.has(sourceText(message["id"])!));
  result.push(...unordered);
  if (missing > 0) limitations.push({ code: "kimi_message_order_missing", detail: `${missing} ordered message id(s) lacked payload records` });
  if (unordered.length > 0) limitations.push({ code: "kimi_message_unordered", detail: `${unordered.length} message record(s) were absent from message_order` });
  return result;
}

function treeMessages(payload: JsonObject, limitations: JsonObject[]): JsonObject[] {
  const tree = object(payload["tree"]);
  const nodes = values(tree?.["nodes"]).map((raw) => {
    const node = object(raw);
    if (!node) throw new TypeError("Kimi Tree contains a non-object node");
    return node;
  });
  const messages = new Map(linearMessages(payload, limitations).map((message) => [sourceText(message["id"])!, message]));
  const byId = new Map<string, JsonObject>();
  const order = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    const id = sourceText(node["id"]);
    if (!id || byId.has(id)) throw new TypeError("Kimi Tree node identity is missing or duplicated");
    byId.set(id, node);
    order.set(id, index);
  }
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    const id = sourceText(node["id"])!;
    const parent = sourceText(node["parent_id"]);
    if (!parent || !byId.has(parent)) {
      roots.push(id);
      if (parent) limitations.push({ code: "source_parent_omitted", detail: "A Kimi Tree node referenced a parent omitted by the source payload" });
    } else {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
  }
  for (const list of children.values()) list.sort((left, right) => order.get(left)! - order.get(right)!);
  roots.sort((left, right) => order.get(left)! - order.get(right)!);
  const result: JsonObject[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new TypeError("Kimi Tree contains a cycle");
    if (visited.has(id)) return;
    active.add(id);
    visited.add(id);
    const node = byId.get(id)!;
    const message = messages.get(id);
    result.push(message ? { ...message, parent_id: node["parent_id"] ?? "" } : {
      id,
      role: sourceText(node["role"]) ?? "other",
      parent_id: node["parent_id"] ?? "",
      public_processes: [],
      sources: [],
      attachments: [],
      diagrams: []
    });
    for (const child of children.get(id) ?? []) visit(child);
    active.delete(id);
  };
  for (const root of roots) visit(root);
  if (visited.size !== byId.size) throw new TypeError("Kimi Tree has no complete parent-first traversal");
  for (const message of messages.values()) {
    const id = sourceText(message["id"])!;
    if (visited.has(id)) continue;
    limitations.push({ code: "kimi_message_outside_tree", detail: "A Kimi message record was absent from the source tree" });
    result.push(message);
  }
  return result;
}

async function parseKimi(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new KimiResourcePool();
  const work = context.extensions?.kimiRichContent ? new KimiRichContent(context.extensions.kimiRichContent, new WorkResources(resources.values)) : undefined;
  const sources = new KimiSourcePool();
  const fragments = new Map<string, string[]>();
  for (const fragment of context.reading?.fragments ?? []) {
    const list = fragments.get(fragment.messageId) ?? [];
    list.push(fragment.html);
    fragments.set(fragment.messageId, list);
  }
  const rawMessages = profile === "tree" ? treeMessages(context.payload, limitations) : linearMessages(context.payload, limitations);
  work?.validateOwners(new Set(rawMessages.map(m => sourceText(m["id"])!)));
  const localIds = new Map(rawMessages.flatMap((message, index) => {
    const id = sourceText(message["id"]);
    return id ? [[id, `m${index + 1}`] as const] : [];
  }));
  const messageTimes: string[] = [];
  // chat.model / lastRequest.options.model describe the conversation's last
  // selection, not the authors of its historical messages. Keep that evidence
  // in the original HTML; absent message-scoped evidence uses the Kimi Front.
  const messages = await mapSequential(rawMessages, async (message, index) => {
    const owner = sourceText(message["id"])!;
    const diagrams = new KimiDiagramPool(message["diagrams"]);
    const attachments = values(message["attachments"]).map((raw) => {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("Kimi attachment occurrence is not an object");
      return attachment;
    });
    const htmlFragments = fragments.get(owner) ?? [];
    for (const html of htmlFragments) diagrams.observeHtml(html);
    const nativeToolIds = new Set(values(object(message["api"])?.["blocks"]).flatMap(raw => {
      const block = object(raw), id = sourceText(block?.["id"]); return block?.["type"] === "tool" && id ? [id] : [];
    }));
    const projection = { html: htmlFragments.join(""), attachments, diagrams, resources, limitations, nativeToolIds, owner, ...(work ? { work } : {}) };
    const body = message["role"] === "assistant" ? orderedKimiContent(projection, message, htmlFragments, sources) : projectFragment(projection);
    const topologyOnly = profile === "tree" && !object(message["api"]) && htmlFragments.length === 0;
    if (htmlFragments.length === 0 && !topologyOnly && body.length === 0) {
      const api = object(message["api"]);
      const text = values(api?.["blocks"]).flatMap((raw) => {
        const block = object(raw);
        const value = object(block?.["value"]);
        return block?.["type"] === "text" && sourceText(value?.["content"]) ? [sourceText(value?.["content"])!] : [];
      });
      if (text.length > 0) body.push(...text.flatMap((value) => projectProcessMarkdown(value, diagrams, resources, "markdown")));
      else limitations.push({ code: "kimi_reading_fragment_missing", at: `/messages/${index}`, detail: "The source payload had a message but no owned rich reading fragment" });
    }
    const ownSources = values(message["sources"]);
    const sourceIds = sources.addAll(ownSources.length ? ownSources : capturedKimiSources(htmlFragments.join("")));
    const content = [...body, ...(work?.remaining(owner) ?? [])];
    if (sourceIds.length > 0) content.push({ type: "citations", sources: sourceIds });
    const api = object(message["api"]);
    const time = timestamp(api?.["create_time"]);
    if (time) messageTimes.push(time);
    const role = message["role"] === "user" ? "user" : message["role"] === "assistant" ? "assistant" : message["role"] === "system" ? "system" : "other";
    const parentRaw = sourceText(message["parent_id"]);
    const parent = profile === "tree" && parentRaw ? localIds.get(parentRaw) : undefined;
    const recordParent = profile === "tree" ? parentRaw : index > 0 ? sourceText(rawMessages[index - 1]!["id"]) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role });
    await context.onProgress?.(index + 1, rawMessages.length);
    return {
      ...(profile === "tree" ? { id: `m${index + 1}`, ...(parent ? { parent } : {}) } : {}),
      role,
      ...(role === "other" ? { name: sourceText(message["role"]) ?? "Kimi" } : {}),
      ...(time ? { timestamp: time } : {}),
      content
    };
  });
  messageTimes.sort();
  const manifestSource = object(context.manifest["source"]);
  const exporter = object(context.manifest["exporter"]);
  const capturedAt = timestamp(context.manifest["exported_at"] ?? context.manifest["captured_at"])
    ?? context.source.fileSystemCapturedAt;
  const sourceUrl = httpUrl(manifestSource?.["url"]);
  const title = sourceText(manifestSource?.["title"]);
  const conversationKey = sourceText(manifestSource?.["conversation_id"]);
  const exporterVersion = sourceText(exporter?.["version"] ?? context.manifest["exporter_version"] ?? context.payload["version"]);
  const currentRaw = profile === "tree"
    ? values(context.payload["active_path_message_ids"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []).at(-1)
    : undefined;
  const currentMessage = currentRaw ? localIds.get(currentRaw) : undefined;
  return {
    source: {
      file: context.source.file,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      format: "exporter-html",
      payload: payloadName.replaceAll("/", "."),
      profile,
      ...(exporterVersion ? { exporter: { id: "kimi-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "moonshot-ai",
    platform: "kimi",
    ...(title ? { title } : {}),
    ...(messageTimes.length > 0 ? { message_time: { start: messageTimes[0]!, ...(messageTimes.at(-1) !== messageTimes[0] ? { end: messageTimes.at(-1)! } : {}) } } : {}),
    ...(currentMessage ? { current_message: currentMessage } : {}),
    messages,
    ...(resources.values.length > 0 ? { resources: resources.values } : {}),
    ...(sources.values.length > 0 ? { sources: sources.values } : {}),
    ...(limitations.length > 0 ? { limitations: [...new Set(limitations.map((entry) => canonicalizeJcs(entry)))].map((entry) => JSON.parse(entry) as JsonObject) } : {})
  };
}

function manifest(id: string, payload: string, profile: Profile): AdapterManifest {
  return {
    id,
    version: "3.0.11",
    family: "kimi",
    routes: [{ format: "exporter-html", platform: "kimi", payload, profile }],
    target: "cloudig/conversation/1.0.2",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "2.0.3", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6", "3.0.7", "3.0.8", "3.0.9", "3.0.10"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const KIMI_LIGHT_MANIFEST = manifest("kimi-light-dom-v2", "osis.kimi.chat-export/light-dom-v2", "light");
export const KIMI_FULL_MANIFEST = manifest("kimi-full-dom-v1", "osis.kimi.chat-export/full-dom-v1", "full");
export const KIMI_TREE_MANIFEST = manifest("kimi-all-branches-v1", "osis.kimi.chat-export/all-branches-v1", "tree");

export const kimiLightAdapter: SourceAdapter = Object.freeze({ manifest: KIMI_LIGHT_MANIFEST, parse: (context) => parseKimi(context, "light", "osis.kimi.chat-export/light-dom-v2") });
export const kimiFullAdapter: SourceAdapter = Object.freeze({ manifest: KIMI_FULL_MANIFEST, parse: (context) => parseKimi(context, "full", "osis.kimi.chat-export/full-dom-v1") });
export const kimiTreeAdapter: SourceAdapter = Object.freeze({ manifest: KIMI_TREE_MANIFEST, parse: (context) => parseKimi(context, "tree", "osis.kimi.chat-export/all-branches-v1") });
