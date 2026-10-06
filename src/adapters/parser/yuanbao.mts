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
import { capturedMathHasTextFrame, capturedMathIsDisplay, inertHtmlEvidence, inertHtmlFragment, inertStandaloneSvg, preserveNestedImage } from "./inert-html.mts";
import { normalizeMermaidSource } from "./markdown-diagrams.mts";

type Profile = "light" | "full";
type Parent = DefaultTreeAdapterTypes.ParentNode;
type Child = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ReadingImage = NonNullable<AdapterParseContext["reading"]>["images"][number];
type ReadingFile = NonNullable<AdapterParseContext["reading"]>["files"][number];

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

function positiveInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function mimeType(value: JsonValue | undefined): string | undefined {
  const text = sourceText(value)?.split(";", 1)[0]?.trim().toLowerCase();
  return text && /^[^\s/]+\/[^\s/]+$/u.test(text) ? text : undefined;
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

function timestamp(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(typeof value === "number" && value > 0 && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}


function unique(input: readonly string[]): string[] {
  return [...new Set(input)];
}

function normalizedName(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en-US");
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

function svgDataUrl(element: Element): string | undefined {
  const image = descendants(element).find((candidate) => candidate.tagName.toLowerCase() === "img" && attribute(candidate, "src")?.startsWith("data:image/"));
  if (image) return attribute(image, "src");
  const svg = element.tagName.toLowerCase() === "svg"
    ? element
    : descendants(element).find((candidate) => candidate.tagName.toLowerCase() === "svg");
  if (!svg) return undefined;
  const inert = inertStandaloneSvg(serializeOuter(svg));
  return inert ? `data:image/svg+xml;utf8,${encodeURIComponent(inert)}` : undefined;
}

function marker(index: number): string {
  return `\uE000CLOUDIG_YUANBAO_BLOCK_${index}\uE001`;
}

class YuanbaoResourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();
  readonly #images: Array<{ value: ReadingImage; used: boolean }>;
  readonly #files: Array<{ value: ReadingFile; used: boolean }>;

  constructor(reading: NonNullable<AdapterParseContext["reading"]> | undefined) {
    this.#images = (reading?.images ?? []).map((value) => ({ value, used: false }));
    this.#files = (reading?.files ?? []).map((value) => ({ value, used: false }));
  }

  #allocate(key: string, resource: Omit<JsonObject, "id">): string {
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...resource });
    this.#byKey.set(key, id);
    return id;
  }

  #takeFile(owner: string, name?: string, requireExact = false): ReadingFile | undefined {
    const candidates = this.#files.filter((entry) => !entry.used && entry.value.messageId === owner
      && (!normalizedName(name) || !normalizedName(entry.value.name) || normalizedName(entry.value.name) === normalizedName(name)));
    const exact = normalizedName(name)
      ? candidates.filter((entry) => normalizedName(entry.value.name) === normalizedName(name))
      : [];
    const selected = exact.length === 1 ? exact[0] : !requireExact && candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) return undefined;
    selected.used = true;
    return selected.value;
  }

  #takeImage(owner: string, name?: string): ReadingImage | undefined {
    const candidates = this.#images.filter((entry) => !entry.used && entry.value.messageId === owner);
    const exact = normalizedName(name)
      ? candidates.filter((entry) => normalizedName(entry.value.alt) === normalizedName(name))
      : [];
    const selected = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) return undefined;
    selected.used = true;
    return selected.value;
  }

  addAttachment(raw: JsonObject, owner: string, limitations: JsonObject[]): JsonObject {
    const isImage = sourceText(raw["kind"] ?? raw["type"])?.toLowerCase() === "image";
    const kind = isImage ? "image" : "file";
    const name = sourceText(raw["name"]);
    const declaredMime = mimeType(raw["mime"]);
    const originalBytes = nonNegativeInteger(raw["size"]);
    const readingFile = this.#takeFile(owner, name, isImage);
    const readingImage = !readingFile && isImage ? this.#takeImage(owner, name) : undefined;
    const dataUrl = readingFile?.dataUrl ?? readingImage?.dataUrl;
    if (dataUrl) {
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
        ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {}),
        ...(readingImage?.width && readingImage.height ? { dimensions: { width: readingImage.width, height: readingImage.height } } : {})
      });
      return isImage ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
    }
    const status = sourceText(raw["status"])?.toLowerCase() ?? "";
    const availability = status.includes("unavailable") || status.includes("missing") || status.includes("failed") || Boolean(sourceText(raw["error"])) ? "missing" : "metadata_only";
    const resource = this.#allocate(canonicalizeJcs({ kind, name: name ?? "", mime: declaredMime ?? "", originalBytes: originalBytes ?? -1, availability }), {
      kind,
      availability,
      ...(name ? { name } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
    });
    if (availability === "missing") {
      const at = this.values.findIndex((entry) => entry["id"] === resource);
      limitations.push({ code: "yuanbao_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
    }
    return isImage ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
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

class YuanbaoDiagramPool {
  readonly #entries: Array<{ value: JsonObject; rendered?: string; used: boolean }>;

  constructor(raw: JsonValue | undefined) {
    this.#entries = values(raw).map((value) => {
      const diagram = object(value);
      if (!diagram) throw new TypeError("Yuanbao diagram record is not an object");
      return { value: diagram, used: false };
    });
  }

  observeHtml(html: string): void {
    const fragment = parseFragment(html);
    for (const card of descendants(fragment).filter((element) => hasClass(element, "osis-mermaid-card"))) {
      const source = descendants(card)
        .filter((element) => element.tagName.toLowerCase() === "code")
        .map((element) => textContent(element))
        .find((value) => value.length > 0);
      const rendered = svgDataUrl(card);
      const normalized = source ? normalizeMermaidSource(source) : undefined;
      const exact = this.#entries.find((entry) => !entry.rendered && (!normalized || normalizeMermaidSource(sourceText(entry.value["source"]) ?? "") === normalized));
      if (exact && rendered) exact.rendered = rendered;
    }
  }

  take(source?: string): Readonly<{ value: JsonObject; rendered?: string }> | undefined {
    const normalized = source ? normalizeMermaidSource(source) : undefined;
    const exact = this.#entries.find((entry) => !entry.used && (!normalized || normalizeMermaidSource(sourceText(entry.value["source"]) ?? "") === normalized));
    if (!exact) return undefined;
    exact.used = true;
    return { value: exact.value, ...(exact.rendered ? { rendered: exact.rendered } : {}) };
  }

  remaining(): ReadonlyArray<Readonly<{ value: JsonObject; rendered?: string }>> {
    const output: Array<Readonly<{ value: JsonObject; rendered?: string }>> = [];
    for (const entry of this.#entries) {
      if (entry.used) continue;
      entry.used = true;
      output.push({ value: entry.value, ...(entry.rendered ? { rendered: entry.rendered } : {}) });
    }
    return output;
  }
}

class YuanbaoSourcePool {
  readonly values: JsonObject[] = [];
  readonly #global = new Map<number, string>();
  readonly #local = new Map<string, Map<number, string>>();

  constructor(raw: JsonValue | undefined) {
    for (const value of values(raw)) {
      const source = object(value);
      const index = positiveInteger(source?.["index"]);
      const localIndex = positiveInteger(source?.["local_index"]);
      const owner = sourceText(source?.["message_id"]);
      const url = httpUrl(source?.["url"]);
      if (!source || !index || !url) continue;
      const id = `s${this.values.length + 1}`;
      const title = sourceText(source["title"]);
      const snippet = sourceText(source["summary"]);
      const name = sourceText(source["source"]);
      this.values.push({ id, kind: "web", url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(name ? { name } : {}) });
      this.#global.set(index, id);
      if (owner && localIndex) {
        const ownerMap = this.#local.get(owner) ?? new Map<number, string>();
        ownerMap.set(localIndex, id);
        this.#local.set(owner, ownerMap);
      }
    }
  }

  forMessage(message: JsonObject): string[] {
    const owner = sourceText(message["id"]);
    const local = owner ? this.#local.get(owner) : undefined;
    const localOrder = values(message["local_reference_indices"]).flatMap((value) => positiveInteger(value) ? [positiveInteger(value)!] : []);
    const localIds = localOrder.flatMap((index) => local?.get(index) ? [local.get(index)!] : []);
    if (localIds.length > 0) return unique(localIds);
    const globalOrder = values(message["reference_indices"] ?? message["source_indices"]).flatMap((value) => positiveInteger(value) ? [positiveInteger(value)!] : []);
    return unique(globalOrder.flatMap((index) => this.#global.get(index) ? [this.#global.get(index)!] : []));
  }
}

function orderedMessages(payload: JsonObject, limitations: JsonObject[]): JsonObject[] {
  const input = values(payload["messages"]).map((raw) => {
    const message = object(raw);
    if (!message) throw new TypeError("Yuanbao message sequence contains a non-object entry");
    return message;
  });
  const byId = new Map<string, JsonObject>();
  for (const message of input) {
    const id = sourceText(message["id"]);
    if (!id || byId.has(id)) throw new TypeError("Yuanbao message identity is missing or duplicated");
    byId.set(id, message);
  }
  const result: JsonObject[] = [];
  const seen = new Set<string>();
  for (const raw of values(payload["message_order"])) {
    const id = sourceText(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const message = byId.get(id);
    if (message) result.push(message);
  }
  const unordered = input.filter((message) => !seen.has(sourceText(message["id"])!));
  result.push(...unordered);
  if (unordered.length > 0) limitations.push({ code: "yuanbao_message_unordered", detail: `${unordered.length} message record(s) were absent from message_order` });
  return result;
}

function reasoningBlock(message: JsonObject): JsonObject[] {
  const title = sourceText(message["public_reasoning_label"]);
  const html = sourceText(message["public_reasoning_html"]);
  const text = sourceText(message["public_reasoning_text"]);
  if (html) {
    const inert = inertHtmlEvidence(html).html;
    if (inert) return [{ type: "reasoning", text: inert, format: "html", ...(title ? { title } : {}) }];
  }
  return text || title ? [{ type: "reasoning", ...(text ? { text, format: "text" } : {}), ...(title ? { title } : {}) }] : [];
}

function projectFragment(input: Readonly<{
  html: string;
  owner: string;
  attachments: readonly JsonObject[];
  diagrams: YuanbaoDiagramPool;
  resources: YuanbaoResourcePool;
  limitations: JsonObject[];
}>): Readonly<{ blocks: JsonObject[]; missingMath: number }> {
  const fragment = parseFragment(input.html);
  const missingMath = descendants(fragment).filter((element) => hasClass(element, "osis-math") && !sourceText(attribute(element, "data-tex"))).length;
  const blocks: JsonObject[] = [];
  const usedAttachments = new Set<number>();
  const addBlock = (block: JsonObject): string => {
    const index = blocks.length;
    blocks.push(block);
    return marker(index);
  };
  const findAttachment = (kind: "image" | "file", name?: string): number | undefined => {
    const exact = normalizedName(name)
      ? input.attachments.findIndex((attachment, index) => !usedAttachments.has(index)
        && sourceText(attachment["kind"] ?? attachment["type"]) === kind
        && normalizedName(sourceText(attachment["name"])) === normalizedName(name))
      : -1;
    if (exact >= 0) return exact;
    const sameKind = input.attachments.findIndex((attachment, index) => !usedAttachments.has(index) && sourceText(attachment["kind"] ?? attachment["type"]) === kind);
    return sameKind >= 0 ? sameKind : undefined;
  };
  const attachmentMarkers = (container: Element): string => {
    const output: string[] = [];
    for (const item of descendants(container).filter((element) => hasClass(element, "osis-attachment"))) {
      const nameNode = descendants(item).find((element) => hasClass(element, "osis-file-name") || element.tagName.toLowerCase() === "strong");
      const name = nameNode ? textContent(nameNode).trim() : undefined;
      const index = findAttachment("file", name) ?? findAttachment("image", name);
      if (index === undefined) continue;
      usedAttachments.add(index);
      output.push(addBlock(input.resources.addAttachment(input.attachments[index]!, input.owner, input.limitations)));
    }
    return output.join("");
  };
  const rewrite = (parent: Parent): void => {
    const next: Child[] = [];
    for (const child of parent.childNodes) {
      if (!isElement(child)) {
        next.push(child);
        continue;
      }
      if (hasClass(child, "osis-thinking") || hasClass(child, "osis-sources") || hasClass(child, "agent-chat__conv--human__expand-toggle")) continue;
      if (hasClass(child, "assistant-model") && "tagName" in parent && hasClass(parent as Element, "osis-message")) continue;
      if (hasClass(child, "osis-attachments")) {
        const markers = attachmentMarkers(child);
        if (markers) next.push(defaultTreeAdapter.createTextNode(markers));
        continue;
      }
      const tex = attribute(child, "data-tex");
      if (hasClass(child, "osis-math") && tex) {
        if (capturedMathHasTextFrame(child)) { next.push(child); continue; }
        next.push(defaultTreeAdapter.createTextNode(addBlock({ type: "math", tex, ...(capturedMathIsDisplay(child) ? { display: true } : {}) })));
        continue;
      }
      if (hasClass(child, "osis-mermaid-card")) {
        const source = descendants(child)
          .filter((element) => element.tagName.toLowerCase() === "code")
          .map((element) => textContent(element))
          .find((value) => value.length > 0);
        const record = input.diagrams.take(source);
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
      if (child.tagName.toLowerCase() === "img") {
        const imageAttachment = findAttachment("image", attribute(child, "alt"));
        if (imageAttachment !== undefined) {
          usedAttachments.add(imageAttachment);
          const image = input.resources.addAttachment(input.attachments[imageAttachment]!, input.owner, input.limitations);
          next.push(preserveNestedImage(parent, child, image) ?? defaultTreeAdapter.createTextNode(addBlock(image)));
          continue;
        }
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
          next.push(preserveNestedImage(parent, child, image) ?? defaultTreeAdapter.createTextNode(addBlock(image)));
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
  const serialized = serialize(fragment);
  const projected: JsonObject[] = [];
  for (const part of serialized.split(/(\uE000CLOUDIG_YUANBAO_BLOCK_[0-9]+\uE001)/u)) {
    const match = /^\uE000CLOUDIG_YUANBAO_BLOCK_([0-9]+)\uE001$/u.exec(part);
    if (match) {
      const block = blocks[Number.parseInt(match[1]!, 10)];
      if (block) projected.push(block);
      continue;
    }
    const evidence = inertHtmlEvidence(part);
    if (evidence.html) projected.push({ type: "html", html: evidence.html });
  }
  const unplaced = input.attachments.flatMap((attachment, index) => (
    usedAttachments.has(index) ? [] : [input.resources.addAttachment(attachment, input.owner, input.limitations)]
  ));
  for (const record of input.diagrams.remaining()) {
    const source = sourceText(record.value["source"]);
    if (source || record.rendered) projected.push({
      type: "diagram",
      format: "mermaid",
      ...(source ? { source } : {}),
      ...(record.rendered ? { rendered: input.resources.addDiagram(record.rendered) } : {})
    });
  }
  return { blocks: [...unplaced, ...projected], missingMath };
}

async function parseYuanbao(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new YuanbaoResourcePool(context.reading);
  const sources = new YuanbaoSourcePool(context.payload["sources"]);
  const fragments = new Map<string, string[]>();
  for (const fragment of context.reading?.fragments ?? []) {
    const list = fragments.get(fragment.messageId) ?? [];
    list.push(fragment.html);
    fragments.set(fragment.messageId, list);
  }
  const input = orderedMessages(context.payload, limitations);
  let missingMath = 0;
  const messages = await mapSequential(input, async (message, index) => {
    const owner = sourceText(message["id"])!;
    const attachments = values(message["attachments"]).map((raw) => {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("Yuanbao attachment occurrence is not an object");
      return attachment;
    });
    const diagrams = new YuanbaoDiagramPool(message["diagrams"]);
    for (const html of fragments.get(owner) ?? []) diagrams.observeHtml(html);
    const projected = (fragments.get(owner) ?? []).map((html) => projectFragment({ html, owner, attachments, diagrams, resources, limitations }));
    const body = projected.flatMap((entry) => entry.blocks);
    missingMath += projected.reduce((total, entry) => total + entry.missingMath, 0);
    const sourceIds = sources.forMessage(message);
    const searchEvents = positiveInteger(message["search_events"]);
    const fileWarning = sourceText(message["file_warning"]);
    const content = [
      ...reasoningBlock(message),
      ...(fileWarning ? [{ type: "status", text: fileWarning }] : []),
      ...(searchEvents && sourceIds.length > 0 ? [{ type: "search", sources: sourceIds }] : []),
      ...body,
      ...(sourceIds.length > 0 ? [{ type: "citations", sources: sourceIds }] : [])
    ];
    const role = message["role"] === "user" ? "user" : message["role"] === "assistant" ? "assistant" : message["role"] === "system" ? "system" : "other";
    const recordParent = index > 0 ? sourceText(input[index - 1]!["id"]) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role });
    await context.onProgress?.(index + 1, input.length);
    return { role, ...(role === "other" ? { name: sourceText(message["role"]) ?? "Yuanbao" } : {}), content };
  });
  if (missingMath > 0) limitations.push({ code: "math_source_missing", detail: `${missingMath} visible Yuanbao math node(s) retain static rendering because source TeX was unavailable` });
  const manifestSource = object(context.manifest["source"]);
  const exporter = object(context.manifest["exporter"]);
  const capturedAt = timestamp(context.manifest["exported_at"] ?? context.manifest["captured_at"])
    ?? context.source.fileSystemCapturedAt;
  const sourceUrl = httpUrl(manifestSource?.["url"]);
  const title = sourceText(manifestSource?.["title"]);
  const conversationKey = sourceText(manifestSource?.["conversation_id"]);
  const exporterVersion = sourceText(exporter?.["version"] ?? context.manifest["exporter_version"] ?? context.payload["version"]);
  return {
    source: {
      file: context.source.file,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      format: "exporter-html",
      payload: payloadName.replaceAll("/", "."),
      profile,
      ...(exporterVersion ? { exporter: { id: "yuanbao-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "tencent",
    platform: "yuanbao",
    ...(title ? { title } : {}),
    messages,
    ...(resources.values.length > 0 ? { resources: resources.values } : {}),
    ...(sources.values.length > 0 ? { sources: sources.values } : {}),
    ...(limitations.length > 0 ? { limitations: [...new Set(limitations.map((entry) => canonicalizeJcs(entry)))].map((entry) => JSON.parse(entry) as JsonObject) } : {})
  };
}

function manifest(id: string, payload: string, profile: Profile): AdapterManifest {
  return {
    id,
    version: "3.0.6",
    family: "yuanbao",
    routes: [{ format: "exporter-html", platform: "yuanbao", payload, profile }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const YUANBAO_LIGHT_MANIFEST = manifest("yuanbao-light-dom-v2", "osis.yuanbao.chat-export/light-dom-v2", "light");
export const YUANBAO_FULL_MANIFEST = manifest("yuanbao-full-dom-v1", "osis.yuanbao.chat-export/full-dom-v1", "full");

export const yuanbaoLightAdapter: SourceAdapter = Object.freeze({ manifest: YUANBAO_LIGHT_MANIFEST, parse: (context) => parseYuanbao(context, "light", "osis.yuanbao.chat-export/light-dom-v2") });
export const yuanbaoFullAdapter: SourceAdapter = Object.freeze({ manifest: YUANBAO_FULL_MANIFEST, parse: (context) => parseYuanbao(context, "full", "osis.yuanbao.chat-export/full-dom-v1") });
