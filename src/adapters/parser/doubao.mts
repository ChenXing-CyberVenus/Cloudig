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
import { inertHtmlEvidence, preserveNestedImage } from "./inert-html.mts";
import { normalizeMermaidSource, projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";
import { extractMermaidCardsFromFragment } from "./reading-evidence.mts";

type Profile = "light" | "full";
type Parent = DefaultTreeAdapterTypes.ParentNode;
type Child = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type MermaidRecord = NonNullable<AdapterParseContext["reading"]>["mermaid"][number];

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

function timestamp(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(typeof value === "number" && value > 0 && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
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
  return `\uE000CLOUDIG_DOUBAO_BLOCK_${index}\uE001`;
}

class MermaidPool {
  readonly #records: Array<{ value: MermaidRecord; used: boolean }>;

  constructor(records: readonly MermaidRecord[]) {
    this.#records = records.map((value) => ({ value, used: false }));
  }

  take(owner: string, source: string): MermaidRecord | undefined {
    const normalized = normalizeMermaidSource(source);
    const found = this.#records.find((entry) => !entry.used
      && entry.value.messageId === owner
      && normalizeMermaidSource(entry.value.source) === normalized);
    if (!found) return undefined;
    found.used = true;
    return found.value;
  }

  remainingFor(owner: string): MermaidRecord[] {
    const result: MermaidRecord[] = [];
    for (const entry of this.#records) {
      if (entry.used || entry.value.messageId !== owner) continue;
      entry.used = true;
      result.push(entry.value);
    }
    return result;
  }

  remaining(): MermaidRecord[] {
    return this.#records.filter((entry) => !entry.used).map((entry) => entry.value);
  }
}

class DoubaoResourcePool {
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
    const originalBytes = nonNegativeInteger(raw["size"]);
    if (dataUrl?.startsWith("data:")) {
      const embedded = isImage ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      const sha256 = embedded.sha256;
      const resource = this.#allocate(`${kind}\u0000${name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
        kind,
        availability: "embedded",
        ...(name ? { name } : {}),
        mime: embedded.mime,
        bytes: embedded.byteLength,
        sha256,
        ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
        ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
      });
      return isImage ? { type: "image", resource } : { type: "attachment", resource };
    }
    const status = sourceText(raw["status"])?.toLowerCase() ?? "";
    const availability = status.includes("missing") || status.includes("failed") ? "missing" : "metadata_only";
    const resource = this.#allocate(canonicalizeJcs({ kind, name: name ?? "", originalBytes: originalBytes ?? -1, availability }), {
      kind,
      availability,
      ...(name ? { name } : {}),
      ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
    });
    if (availability === "missing") {
      const at = this.values.findIndex((entry) => entry["id"] === resource);
      limitations.push({ code: "doubao_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
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

function orderedMessages(payload: JsonObject, limitations: JsonObject[]): JsonObject[] {
  const input = values(payload["messages"]).map((raw) => {
    const message = object(raw);
    if (!message) throw new TypeError("Doubao message sequence contains a non-object entry");
    return message;
  });
  const byId = new Map<string, JsonObject>();
  for (const message of input) {
    const id = sourceText(message["id"]);
    if (!id || byId.has(id)) throw new TypeError("Doubao message identity is missing or duplicated");
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
  if (missing > 0) limitations.push({ code: "doubao_message_order_missing", detail: `${missing} ordered message id(s) lacked payload records` });
  if (unordered.length > 0) limitations.push({ code: "doubao_message_unordered", detail: `${unordered.length} message record(s) were absent from message_order` });
  return result;
}

function thoughtBlocks(
  message: JsonObject,
  owner: string,
  mermaid: MermaidPool,
  resources: DoubaoResourcePool
): JsonObject[] {
  if (message["public_thought_body_available"] !== true) {
    const label = sourceText(message["public_thought_label"]);
    return label ? [{ type: "reasoning", title: label }] : [];
  }
  const text = sourceText(message["public_thought_text"]);
  const title = sourceText(message["public_thought_label"]);
  if (!text) return title ? [{ type: "reasoning", title }] : [];
  let titled = false;
  return projectMarkdownWithDiagrams(text, (source) => {
    const record = mermaid.take(owner, source);
    return record ? resources.addDiagram(record.dataUrl) : undefined;
  }).map((block) => {
    if (block["type"] !== "markdown") return block;
    const result: JsonObject = {
      type: "reasoning",
      text: block["text"]!,
      format: "markdown",
      ...(!titled && title ? { title } : {})
    };
    titled = true;
    return result;
  });
}

function projectFragment(input: Readonly<{
  html: string;
  owner: string;
  attachments: readonly JsonObject[];
  mermaid: MermaidPool;
  resources: DoubaoResourcePool;
  limitations: JsonObject[];
}>): JsonObject[] {
  const fragment = parseFragment(input.html);
  const blocks: JsonObject[] = [];
  const usedAttachments = new Set<number>();
  const byIdentifier = new Map(input.attachments.flatMap((attachment, index) => {
    const id = sourceText(attachment["identifier"]);
    return id ? [[id, index] as const] : [];
  }));
  const addBlock = (block: JsonObject): string => {
    const index = blocks.length;
    blocks.push(block);
    return marker(index);
  };
  const attachmentIndex = (item: Element): number | undefined => {
    const identifier = attribute(item, "data-osis-attachment-identifier");
    const exact = identifier ? byIdentifier.get(identifier) : undefined;
    if (exact !== undefined && !usedAttachments.has(exact)) return exact;
    return input.attachments.findIndex((_, index) => !usedAttachments.has(index));
  };
  const attachmentMarkers = (container: Element): string => {
    const result: string[] = [];
    for (const item of descendants(container).filter((element) => hasClass(element, "osis-attachment-item"))) {
      const index = attachmentIndex(item);
      if (index === undefined || index < 0) continue;
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
      if (hasClass(child, "osis-thinking")) continue;
      if (hasClass(child, "osis-expanded-attachments")) {
        const markers = attachmentMarkers(child);
        if (markers) next.push(defaultTreeAdapter.createTextNode(markers));
        continue;
      }
      if (hasClass(child, "osis-mermaid-card")) {
        const record = extractMermaidCardsFromFragment(serializeOuter(child), input.owner)[0];
        if (record) {
          const evidence = input.mermaid.take(input.owner, record.source) ?? record;
          next.push(defaultTreeAdapter.createTextNode(addBlock({
            type: "diagram",
            format: "mermaid",
            source: record.source,
            rendered: input.resources.addDiagram(evidence.dataUrl)
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
  const rich = descendants(fragment).find((element) => hasClass(element, "rich-content"));
  const serialized = serialize(rich ?? fragment);
  const projected: JsonObject[] = [];
  for (const part of serialized.split(/(\uE000CLOUDIG_DOUBAO_BLOCK_[0-9]+\uE001)/u)) {
    const match = /^\uE000CLOUDIG_DOUBAO_BLOCK_([0-9]+)\uE001$/u.exec(part);
    if (match) {
      const block = blocks[Number.parseInt(match[1]!, 10)];
      if (block) projected.push(block);
      continue;
    }
    const evidence = inertHtmlEvidence(part);
    if (evidence.html) projected.push({ type: "html", html: evidence.html });
  }
  const unplaced = input.attachments.flatMap((attachment, index) => (
    usedAttachments.has(index) ? [] : [input.resources.addAttachment(attachment, undefined, input.limitations)]
  ));
  return [...unplaced, ...projected];
}

async function parseDoubao(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new DoubaoResourcePool();
  const mermaid = new MermaidPool(context.reading?.mermaid ?? []);
  const fragments = new Map<string, string[]>();
  for (const fragment of context.reading?.fragments ?? []) {
    const list = fragments.get(fragment.messageId) ?? [];
    list.push(fragment.html);
    fragments.set(fragment.messageId, list);
  }
  const rawMessages = orderedMessages(context.payload, limitations);
  const messages = await mapSequential(rawMessages, async (message, index) => {
    const owner = sourceText(message["id"])!;
    const attachments = values(message["attachments"]).map((raw) => {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("Doubao attachment occurrence is not an object");
      return attachment;
    });
    const publicThought = message["role"] === "assistant" ? thoughtBlocks(message, owner, mermaid, resources) : [];
    const htmlFragments = fragments.get(owner) ?? [];
    const body = htmlFragments.flatMap((html) => projectFragment({ html, owner, attachments, mermaid, resources, limitations }));
    if (htmlFragments.length === 0) {
      limitations.push({ code: "doubao_reading_fragment_missing", at: `/messages/${index}`, detail: "The source payload had a message but no owned rich reading fragment" });
    }
    for (const record of mermaid.remainingFor(owner)) {
      body.push({ type: "diagram", format: "mermaid", source: record.source, rendered: resources.addDiagram(record.dataUrl) });
    }
    const role = message["role"] === "user" ? "user" : message["role"] === "assistant" ? "assistant" : "other";
    const recordParent = index > 0 ? sourceText(rawMessages[index - 1]!["id"]) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role });
    await context.onProgress?.(index + 1, rawMessages.length);
    return {
      role,
      ...(role === "other" ? { name: sourceText(message["role"]) ?? "豆包" } : {}),
      content: [...publicThought, ...body]
    };
  });
  const orphanedMermaid = mermaid.remaining();
  if (orphanedMermaid.length > 0) {
    limitations.push({ code: "doubao_unowned_mermaid_preview", detail: `${orphanedMermaid.length} Mermaid preview(s) lacked a message owner` });
  }
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
      ...(exporterVersion ? { exporter: { id: "doubao-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "bytedance",
    platform: "doubao",
    ...(title ? { title } : {}),
    messages,
    ...(resources.values.length > 0 ? { resources: resources.values } : {}),
    ...(limitations.length > 0 ? { limitations: [...new Set(limitations.map((entry) => canonicalizeJcs(entry)))].map((entry) => JSON.parse(entry) as JsonObject) } : {})
  };
}

function manifest(id: string, payload: string, profile: Profile): AdapterManifest {
  return {
    id,
    version: "3.0.4",
    family: "doubao",
    routes: [{ format: "exporter-html", platform: "doubao", payload, profile }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "3.0.0", "3.0.1", "3.0.2", "3.0.3"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const DOUBAO_LIGHT_MANIFEST = manifest("doubao-light-dom-v2", "osis.doubao.chat-export/light-dom-v2", "light");
export const DOUBAO_FULL_MANIFEST = manifest("doubao-full-dom-v1", "osis.doubao.chat-export/full-dom-v1", "full");

export const doubaoLightAdapter: SourceAdapter = Object.freeze({ manifest: DOUBAO_LIGHT_MANIFEST, parse: (context) => parseDoubao(context, "light", "osis.doubao.chat-export/light-dom-v2") });
export const doubaoFullAdapter: SourceAdapter = Object.freeze({ manifest: DOUBAO_FULL_MANIFEST, parse: (context) => parseDoubao(context, "full", "osis.doubao.chat-export/full-dom-v1") });
