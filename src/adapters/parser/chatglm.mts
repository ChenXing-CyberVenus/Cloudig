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
import { mermaidCardSource } from "./diagram-card.mts";

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

function finiteNonNegative(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
  return `\uE000CLOUDIG_CHATGLM_BLOCK_${index}\uE001`;
}

function normalizedName(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en-US");
}

class ChatGlmResourcePool {
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
    const isImage = sourceText(raw["kind"])?.toLowerCase() === "image";
    const kind = isImage ? "image" : "file";
    const name = sourceText(raw["name"]);
    const declaredMime = mimeType(raw["mime"]);
    const originalBytes = nonNegativeInteger(raw["size"]);
    const file = this.#takeFile(owner, name, isImage);
    const readingImage = !file && isImage ? this.#takeImage(owner, name) : undefined;
    const dataUrl = file?.dataUrl ?? readingImage?.dataUrl;
    if (dataUrl) {
      const embedded = isImage ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      const sha256 = embedded.sha256;
      const width = nonNegativeInteger(raw["width"]) ?? readingImage?.width;
      const height = nonNegativeInteger(raw["height"]) ?? readingImage?.height;
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
        ...(width && height ? { dimensions: { width, height } } : {})
      });
      return isImage ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
    }
    const status = sourceText(raw["status"])?.toLowerCase() ?? "";
    const availability = status.includes("missing") || status.includes("failed") || Boolean(sourceText(raw["error"])) ? "missing" : "metadata_only";
    const resource = this.#allocate(canonicalizeJcs({ kind, name: name ?? "", mime: declaredMime ?? "", originalBytes: originalBytes ?? -1, availability }), {
      kind,
      availability,
      ...(name ? { name } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
    });
    if (availability === "missing") {
      const at = this.values.findIndex((entry) => entry["id"] === resource);
      limitations.push({ code: "chatglm_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
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

class ChatGlmSourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();

  addAll(raw: JsonValue | undefined): string[] {
    return unique(values(raw).flatMap((value) => {
      const source = object(value);
      const url = httpUrl(source?.["url"]);
      if (!source || !url) return [];
      const title = sourceText(source["title"]);
      const snippet = sourceText(source["snippet"]);
      const hostname = sourceText(source["hostname"]);
      const key = `${url}\u0000${title ?? ""}\u0000${snippet ?? ""}`;
      const existing = this.#byKey.get(key);
      if (existing) return [existing];
      const id = `s${this.values.length + 1}`;
      this.values.push({ id, kind: "web", url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(hostname ? { name: hostname } : {}) });
      this.#byKey.set(key, id);
      return [id];
    }));
  }
}

function orderedMessages(payload: JsonObject, limitations: JsonObject[]): JsonObject[] {
  const input = values(payload["messages"]).map((raw) => {
    const message = object(raw);
    if (!message) throw new TypeError("ChatGLM message sequence contains a non-object entry");
    return message;
  });
  const byId = new Map<string, JsonObject>();
  for (const message of input) {
    const id = sourceText(message["id"]);
    if (!id || byId.has(id)) throw new TypeError("ChatGLM message identity is missing or duplicated");
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
  if (missing > 0 || unordered.length > 0) {
    limitations.push({ code: "chatglm_message_order_incomplete", detail: `${missing} ordered ID(s) missing; ${unordered.length} message(s) unordered` });
  }
  return result;
}

function processBlocks(message: JsonObject): JsonObject[] {
  const result: JsonObject[] = [];
  for (const raw of values(message["public_processes"])) {
    const process = object(raw);
    if (!process) throw new TypeError("ChatGLM public process is not an object");
    const text = sourceText(process["content"]);
    const title = sourceText(process["title"]);
    const status = sourceText(process["status"]);
    if (text || title) result.push({ type: "reasoning", ...(text ? { text, format: "markdown" } : {}), ...(title ? { title } : {}) });
    else if (status) result.push({ type: "status", text: status });
  }
  for (const raw of values(message["tool_events"])) {
    const event = object(raw);
    if (!event) throw new TypeError("ChatGLM tool event is not an object");
    const name = sourceText(event["name"]);
    const title = sourceText(event["label"]);
    const status = sourceText(event["status"]);
    if (name || title || status) result.push({ type: "tool", kind: "activity", ...(name ? { name } : {}), ...(title ? { title } : {}), ...(status ? { status } : {}) });
  }
  const duration = finiteNonNegative(message["search_duration_seconds"]);
  let first = true;
  for (const raw of values(message["search_queries"])) {
    const query = sourceText(raw);
    if (!query) continue;
    result.push({ type: "search", query, ...(first && duration !== undefined ? { duration } : {}) });
    first = false;
  }
  return result;
}

function projectFragment(input: Readonly<{
  html: string;
  owner: string;
  attachments: readonly JsonObject[];
  resources: ChatGlmResourcePool;
  limitations: JsonObject[];
}>): Readonly<{ blocks: JsonObject[]; diagrams: number }> {
  const fragment = parseFragment(input.html);
  const blocks: JsonObject[] = [];
  const usedAttachments = new Set<number>();
  let diagrams = 0;
  const addBlock = (block: JsonObject): string => {
    const index = blocks.length;
    blocks.push(block);
    return marker(index);
  };
  const findAttachment = (kind: "image" | "file", name?: string): number | undefined => {
    const exact = normalizedName(name)
      ? input.attachments.findIndex((attachment, index) => !usedAttachments.has(index)
        && sourceText(attachment["kind"]) === kind
        && normalizedName(sourceText(attachment["name"])) === normalizedName(name))
      : -1;
    if (exact >= 0) return exact;
    const sameKind = input.attachments.findIndex((attachment, index) => !usedAttachments.has(index) && sourceText(attachment["kind"]) === kind);
    return sameKind >= 0 ? sameKind : undefined;
  };
  const attachmentMarkers = (container: Element): string => {
    const output: string[] = [];
    for (const item of descendants(container).filter((element) => hasClass(element, "osis-attachment"))) {
      const strong = descendants(item).find((element) => element.tagName.toLowerCase() === "strong");
      const name = strong ? textContent(strong).trim() : undefined;
      const imageByName = input.attachments.findIndex((attachment, index) => !usedAttachments.has(index)
        && sourceText(attachment["kind"]) === "image"
        && normalizedName(sourceText(attachment["name"])) === normalizedName(name));
      const index = imageByName >= 0 ? imageByName : findAttachment("file", name);
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
      if (["osis-thinking", "osis-search-state", "osis-sources", "osis-tool-state"].some((name) => hasClass(child, name))) continue;
      if (hasClass(child, "assistant-model") && "tagName" in parent && hasClass(parent as Element, "message-shell")) continue;
      if (hasClass(child, "attachments")) {
        const markers = attachmentMarkers(child);
        if (markers) next.push(defaultTreeAdapter.createTextNode(markers));
        continue;
      }
      const tex = attribute(child, "data-tex");
      if (hasClass(child, "osis-math") && tex) {
        const nested = preserveNestedMath(parent, child, tex, capturedMathIsDisplay(child));
        if (nested) { next.push(nested); continue; }
        next.push(defaultTreeAdapter.createTextNode(addBlock({ type: "math", tex, ...(capturedMathIsDisplay(child) ? { display: true } : {}) })));
        continue;
      }
      if (hasClass(child, "osis-mermaid-card")) {
        const source = mermaidCardSource(child);
        const rendered = svgDataUrl(child);
        if (source || rendered) {
          next.push(defaultTreeAdapter.createTextNode(addBlock({
            type: "diagram",
            format: "mermaid",
            ...(source ? { source } : {}),
            ...(rendered ? { rendered: input.resources.addDiagram(rendered) } : {})
          })));
          diagrams += 1;
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
  for (const part of serialized.split(/(\uE000CLOUDIG_CHATGLM_BLOCK_[0-9]+\uE001)/u)) {
    const match = /^\uE000CLOUDIG_CHATGLM_BLOCK_([0-9]+)\uE001$/u.exec(part);
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
  return { blocks: [...unplaced, ...projected], diagrams };
}

async function parseChatGlm(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new ChatGlmResourcePool(context.reading);
  const sources = new ChatGlmSourcePool();
  const fragments = new Map<string, string[]>();
  for (const fragment of context.reading?.fragments ?? []) {
    const list = fragments.get(fragment.messageId) ?? [];
    list.push(fragment.html);
    fragments.set(fragment.messageId, list);
  }
  const input = orderedMessages(context.payload, limitations);
  const models: string[] = [];
  const messageTimes: string[] = [];
  const messages = await mapSequential(input, async (message, index) => {
    const owner = sourceText(message["id"])!;
    const attachments = values(message["attachments"]).map((raw) => {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("ChatGLM attachment occurrence is not an object");
      return attachment;
    });
    const projected = (fragments.get(owner) ?? []).map((html) => projectFragment({ html, owner, attachments, resources, limitations }));
    const body = projected.flatMap((entry) => entry.blocks);
    const expectedDiagrams = values(message["media"]).filter((raw) => object(raw)?.["kind"] === "diagram").length;
    const actualDiagrams = projected.reduce((total, entry) => total + entry.diagrams, 0);
    if (actualDiagrams < expectedDiagrams) {
      limitations.push({ code: "chatglm_diagram_unresolved", detail: `${expectedDiagrams - actualDiagrams} owned diagram(s) lacked a complete static card` });
    }
    if (body.length === 0) {
      const markdown = sourceText(message["content_markdown"]);
      if (markdown) body.push({ type: "markdown", text: markdown });
    }
    const sourceIds = sources.addAll(message["sources"]);
    const content = [
      ...restoreCapturedProcess(processBlocks(message), (fragments.get(owner) ?? []).join("")),
      ...body,
      ...(sourceIds.length > 0 ? [{ type: "citations", sources: sourceIds }] : [])
    ];
    const model = sourceText(message["model"]);
    if (model && !models.includes(model)) models.push(model);
    const time = timestamp(message["timestamp"]);
    if (time) messageTimes.push(time);
    const role = message["role"] === "user" ? "user" : message["role"] === "assistant" ? "assistant" : message["role"] === "system" ? "system" : "other";
    const recordParent = index > 0 ? sourceText(input[index - 1]!["id"]) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role, ...(model ? { model } : {}) });
    await context.onProgress?.(index + 1, input.length);
    return {
      role,
      ...(role === "other" ? { name: sourceText(message["role"]) ?? "ChatGLM" } : {}),
      ...(model ? { model } : {}),
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
  return {
    source: {
      file: context.source.file,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      format: "exporter-html",
      payload: payloadName.replaceAll("/", "."),
      profile,
      ...(exporterVersion ? { exporter: { id: "chatglm-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "zhipu",
    platform: "chatglm",
    ...(title ? { title } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(messageTimes.length > 0 ? { message_time: { start: messageTimes[0]!, ...(messageTimes.at(-1) !== messageTimes[0] ? { end: messageTimes.at(-1)! } : {}) } } : {}),
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
    family: "chatglm",
    routes: [{ format: "exporter-html", platform: "chatglm", payload, profile }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "2.0.3", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const CHATGLM_LIGHT_MANIFEST = manifest("chatglm-light-messages-v2", "osis.chatglm.chat-export/light-messages-v2", "light");
export const CHATGLM_FULL_MANIFEST = manifest("chatglm-full-v1", "osis.chatglm.chat-export/full-v1", "full");

export const chatGlmLightAdapter: SourceAdapter = Object.freeze({ manifest: CHATGLM_LIGHT_MANIFEST, parse: (context) => parseChatGlm(context, "light", "osis.chatglm.chat-export/light-messages-v2") });
export const chatGlmFullAdapter: SourceAdapter = Object.freeze({ manifest: CHATGLM_FULL_MANIFEST, parse: (context) => parseChatGlm(context, "full", "osis.chatglm.chat-export/full-v1") });
