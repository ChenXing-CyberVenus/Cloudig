import {
  defaultTreeAdapter,
  html,
  parseFragment,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterTypes
} from "parse5";

import type { AdapterManifest, AdapterParseContext, SourceAdapter } from "../../app/parser/adapter.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { inertHtmlEvidence, inertHtmlFragment, preserveNestedImage } from "./inert-html.mts";
import { GeminiRichContent } from "./gemini-rich.mts";
import { WorkResources } from "./work-resources.mts";
import { GeminiTasks } from "./gemini-task.mts";
import { HTML_IMAGE_RESOURCE } from "../../core/records/html-resources.mts";
import { htmlBlockSegments } from "./html-block-segments.mts";

type Profile = "light" | "full";
type ReadingImage = Readonly<{ messageId: string; dataUrl: string; alt?: string; width?: number; height?: number }>;
type Element = DefaultTreeAdapterTypes.Element;
type Parent = DefaultTreeAdapterTypes.ParentNode;
type Child = DefaultTreeAdapterTypes.ChildNode;

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
  const numeric = typeof value === "number" ? value : Number.NaN;
  const date = new Date(typeof value === "number" && numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

// Native hNvQHb turns bind an r_* response ID to a protobuf [seconds,nanos]
// instant. This is response evidence, not the export time and not a timestamp
// for the preceding user query. Match IDs, never DOM ordinal or prose.
function nativeResponseTimes(payload: JsonObject | undefined): Map<string, string> {
  const result = new Map<string, string>(), conflicted = new Set<string>();
  for (const raw of values(payload?.["native_turns"])) {
    if (!Array.isArray(raw) || !Array.isArray(raw[0]) || !Array.isArray(raw[4])) continue;
    const id = raw[0][1], [seconds, nanos] = raw[4];
    if (typeof id !== "string" || !/^r_[a-zA-Z0-9]+$/u.test(id) || typeof seconds !== "number" || !Number.isSafeInteger(seconds)
      || typeof nanos !== "number" || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) continue;
    const time = timestamp(seconds * 1000 + Math.floor(nanos / 1_000_000));
    if (!time || conflicted.has(id)) continue;
    if (result.has(id) && result.get(id) !== time) { result.delete(id); conflicted.add(id); }
    else result.set(id, time);
  }
  return result;
}


function isElement(node: Child): node is Element {
  return "tagName" in node;
}

class GeminiResourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();
  readonly #images = new Map<string, JsonObject>();
  readonly #imageOrder: JsonObject[] = [];
  readonly #files = new Map<string, JsonObject>();
  readonly #reading = new Map<string, Array<{ value: ReadingImage; used: boolean }>>();
  readonly #ownerImages = new Map<string, Set<string>>();
  readonly #usedImageKeys = new Map<string, Set<string>>();
  readonly #imageBlocks = new Map<string, JsonObject>();

  constructor(payload: JsonObject, reading: readonly ReadingImage[]) {
    for (const raw of values(payload["images"])) {
      const image = object(raw);
      const key = sourceText(image?.["key"]);
      if (!image || !key || this.#images.has(key)) throw new TypeError("Gemini image registry is malformed");
      this.#images.set(key, image);
      this.#imageOrder.push(image);
    }
    for (const [index, raw] of values(payload["messages"]).entries()) {
      const message = object(raw);
      if (!message) continue;
      const owner = sourceText(message["source_id"]) ?? `gemini-message-${index}`;
      const keys = new Set<string>();
      const visit = (parent: Parent): void => {
        for (const child of parent.childNodes) if (isElement(child)) {
          if (child.tagName === "osis-image") {
            const key = child.attrs.find(attr => attr.name === "data-key")?.value;
            if (key) keys.add(key);
          }
          visit(child);
        }
      };
      visit(parseFragment(sourceText(message["html"]) ?? ""));
      for (const rawAttachment of values(message["attachments"])) {
        const key = sourceText(object(rawAttachment)?.["image_key"]);
        if (key) keys.add(key);
      }
      this.#ownerImages.set(owner, keys);
      this.#usedImageKeys.set(owner, new Set());
    }
    for (const raw of values(payload["files"])) {
      const file = object(raw);
      const key = sourceText(file?.["key"]);
      if (!file || !key || this.#files.has(key)) throw new TypeError("Gemini file registry is malformed");
      this.#files.set(key, file);
    }
    for (const image of reading) {
      const list = this.#reading.get(image.messageId) ?? [];
      list.push({ value: image, used: false });
      this.#reading.set(image.messageId, list);
    }
  }

  #allocate(key: string, resource: Omit<JsonObject, "id">): string {
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...resource });
    this.#byKey.set(key, id);
    return id;
  }

  #takeReading(owner: string, meta?: JsonObject): ReadingImage | undefined {
    if (!this.#canHavePixels(meta)) return undefined;
    const entries = this.#reading.get(owner) ?? [];
    const dataUrl = sourceText(meta?.["data_url"]), metaAlt = sourceText(meta?.["alt"]);
    // Full has exact bytes; Light keeps the exporter's alt and message-local
    // order. A failed image must never consume the next successful occurrence.
    const exact = entries.find(entry => !entry.used && (dataUrl ? entry.value.dataUrl === dataUrl : metaAlt ? entry.value.alt === metaAlt : true));
    if (!exact) return undefined;
    exact.used = true;
    return exact.value;
  }

  #canHavePixels(meta?: JsonObject): boolean {
    return !/unavailable|missing|metadata_only/u.test(sourceText(meta?.["availability"]) ?? "");
  }

  #embedded(
    kind: "image" | "file",
    dataUrl: string,
    meta: JsonObject | undefined,
    occurrence: JsonObject | undefined,
    reading: ReadingImage | undefined,
    limitations: JsonObject[]
  ): string {
    const embedded = kind === "image" ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
    const declaredMime = sourceText(meta?.["mime_type"] ?? occurrence?.["mime_type"])?.toLowerCase();
    if (declaredMime && declaredMime !== embedded.mime) throw new TypeError("Gemini resource MIME metadata disagrees with embedded bytes");
    const declaredSize = nonNegativeInteger(meta?.["embedded_size"] ?? occurrence?.["bytes"]);
    if (declaredSize !== undefined && declaredSize !== embedded.byteLength) {
      throw new TypeError("Gemini resource embedded size disagrees with its bytes");
    }
    const name = sourceText(meta?.["name"] ?? occurrence?.["name"]);
    const sha256 = embedded.sha256;
    const width = nonNegativeInteger(meta?.["width"]) ?? reading?.width;
    const height = nonNegativeInteger(meta?.["height"]) ?? reading?.height;
    const id = this.#allocate(`${kind}\u0000${name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
      kind,
      availability: "embedded",
      ...(name ? { name } : {}),
      mime: embedded.mime,
      bytes: embedded.byteLength,
      sha256,
      ...(embedded.byteLength === 0 ? {} : { data_base64: embedded.dataBase64 }),
      ...(width !== undefined && height !== undefined && width > 0 && height > 0 ? { dimensions: { width, height } } : {}),
      ...(nonNegativeInteger(meta?.["source_size"]) !== undefined ? { original_bytes: nonNegativeInteger(meta?.["source_size"])! } : {})
    });
    const availability = sourceText(meta?.["availability"]);
    if (kind === "image" && (availability?.includes("fallback") || meta?.["original_verified"] === false)) {
      const index = this.values.findIndex((resource) => resource["id"] === id);
      limitations.push({
        code: "gemini_image_fallback",
        ...(index >= 0 ? { at: `/resources/${index}` } : {}),
        detail: "Gemini identified the embedded image as a fallback preview rather than verified original bytes"
      });
    }
    return id;
  }

  #metadata(kind: "image" | "file", meta?: JsonObject, occurrence?: JsonObject): string {
    const name = sourceText(meta?.["name"] ?? occurrence?.["name"]);
    const mime = sourceText(meta?.["mime_type"] ?? occurrence?.["mime_type"])?.toLowerCase();
    const bytes = nonNegativeInteger(meta?.["source_size"] ?? occurrence?.["bytes"]);
    const url = httpUrl(meta?.["source_reference"]);
    const availability = sourceText(meta?.["availability"] ?? occurrence?.["availability"]);
    return this.#allocate(canonicalizeJcs({ kind, name: name ?? "", mime: mime ?? "", bytes: bytes ?? -1, url: url ?? "" }), {
      kind,
      availability: url ? "external" : availability?.includes("unavailable") || availability?.includes("missing") ? "missing" : "metadata_only",
      ...(name ? { name } : {}),
      ...(mime ? { mime } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(url ? { url } : {})
    });
  }

  addAttachment(raw: JsonObject, owner: string, limitations: JsonObject[]): JsonObject {
    const kind = raw["kind"] === "image" ? "image" : "file";
    const key = sourceText(raw[kind === "image" ? "image_key" : "file_key"]);
    const meta = key ? (kind === "image" ? this.#images.get(key) : this.#files.get(key)) : undefined;
    if (kind === "image" && key) this.#usedImageKeys.get(owner)?.add(key);
    const reading = kind === "image" ? this.#takeReading(owner, meta) : undefined;
    const imageKey = kind === "image" && key ? `${owner}\u0000${key}` : undefined;
    const existing = imageKey ? this.#imageBlocks.get(imageKey) : undefined;
    if (existing) return { ...existing };
    const dataUrl = sourceText(meta?.["data_url"]) ?? reading?.dataUrl;
    const resource = dataUrl
      ? this.#embedded(kind, dataUrl, meta, raw, reading, limitations)
      : this.#metadata(kind, meta, raw);
    const block: JsonObject = kind === "image"
      ? { type: "image", resource, ...(reading?.alt || sourceText(meta?.["alt"]) ? { alt: reading?.alt ?? meta!["alt"]! } : {}) }
      : { type: "attachment", resource };
    if (imageKey) this.#imageBlocks.set(imageKey, block);
    return block;
  }

  addRemainingImages(owner: string, limitations: JsonObject[]): JsonObject[] {
    const entries = this.#reading.get(owner) ?? [];
    const result: JsonObject[] = [];
    for (const entry of entries) {
      if (entry.used) continue;
      entry.used = true;
      const meta = this.#imageOrder.find((candidate) => {
        const key = sourceText(candidate["key"]);
        if (!key || !this.#ownerImages.get(owner)?.has(key) || this.#usedImageKeys.get(owner)?.has(key) || !this.#canHavePixels(candidate)) return false;
        const dataUrl = sourceText(candidate["data_url"]);
        const alt = sourceText(candidate["alt"]);
        return dataUrl ? dataUrl === entry.value.dataUrl : !alt || alt === entry.value.alt;
      });
      const key = sourceText(meta?.["key"]);
      if (key) this.#usedImageKeys.get(owner)?.add(key);
      const resource = this.#embedded("image", sourceText(meta?.["data_url"]) ?? entry.value.dataUrl, meta, undefined, entry.value, limitations);
      result.push({ type: "image", resource, ...(entry.value.alt ? { alt: entry.value.alt } : {}) });
    }
    return result;
  }

  claimRichImage(owner: string, dataUrl: string): void {
    for (const entry of this.#reading.get(owner) ?? []) if (entry.value.dataUrl === dataUrl) entry.used = true;
  }
}

class GeminiSourcePool {
  readonly values: JsonObject[] = [];
  readonly #byUrl = new Map<string, string[]>();

  constructor(payload: JsonObject) {
    const seen = new Set<string>();
    for (const raw of values(payload["sources"])) {
      const source = object(raw);
      const url = httpUrl(source?.["url"]);
      if (!source || !url) continue;
      const title = sourceText(source["label"] ?? source["title"]);
      const snippet = sourceText(source["snippet"]), body = sourceText(source["text"]);
      const value: JsonObject = { kind: "web", url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(body ? { text: body } : {}) };
      const key = canonicalizeJcs(value); if (seen.has(key)) continue; seen.add(key);
      const id = `s${this.values.length + 1}`;
      this.values.push({ id, ...value });
      this.#byUrl.set(url, [...(this.#byUrl.get(url) ?? []), id]);
    }
  }

  forLinks(links: readonly string[]): string[] {
    return [...new Set(links.flatMap((url) => this.#byUrl.get(url) ?? []))];
  }

  addDocument(source: JsonObject): string {
    const id = `s${this.values.length + 1}`;
    this.values.push({ id, kind: "file", ...(sourceText(source["title"]) ? { title: source["title"]! } : {}),
      ...(sourceText(source["filename"]) ? { name: source["filename"]! } : {}), ...(sourceText(source["mime"]) ? { text: source["mime"]! } : {}) });
    return id;
  }
}

function hasAttachmentClass(element: Element): boolean {
  const classes = element.attrs.find((attribute) => attribute.name === "class")?.value.split(/\s+/u) ?? [];
  return classes.includes("attachment");
}

function replaceAttachmentCards(parent: Parent, markers: readonly string[], attachments: readonly JsonObject[], used: { count: number }): void {
  const next: Child[] = [];
  for (const child of parent.childNodes) {
    if (isElement(child) && hasAttachmentClass(child) && used.count < markers.length) {
      const index = used.count++;
      next.push(preserveNestedImage(parent, child, attachments[index]!) ?? defaultTreeAdapter.createTextNode(markers[index]!));
      continue;
    }
    if (isElement(child)) replaceAttachmentCards(child, markers, attachments, used);
    next.push(child);
  }
  parent.childNodes = next;
  for (const child of next) child.parentNode = parent;
}

function projectBody(
  rawHtml: string | undefined,
  fallbackText: string | undefined,
  attachments: readonly JsonObject[],
  limitations: JsonObject[],
  imageAt: (key: string) => JsonObject,
  attachmentImageKeys: readonly (string | undefined)[],
  rich?: Readonly<{ projector: GeminiRichContent; owner: string }>
): Readonly<{ blocks: JsonObject[]; links: readonly string[] }> {
  if (!rawHtml) {
    return {
      blocks: [...(fallbackText ? [{ type: "text", text: fallbackText }] : []), ...attachments],
      links: []
    };
  }
  const markers = attachments.map((_, index) => `\uE000CLOUDIG_ATTACHMENT_${index}\uE001`);
  if (markers.some((marker) => rawHtml.includes(marker))) throw new TypeError("Gemini HTML collides with the internal attachment marker");
  const fragment = parseFragment(rawHtml);
  const placedImageKeys = new Set<string>();
  const placeImages = (parent: Parent): void => {
    for (const child of [...parent.childNodes]) if (isElement(child)) {
      const key = child.tagName === "osis-image" ? child.attrs.find(a => a.name === "data-key")?.value : undefined;
      if (key) {
        placedImageKeys.add(key);
        const block = imageAt(key), replacement = defaultTreeAdapter.createElement("img", html.NS.HTML,
          [{ name: HTML_IMAGE_RESOURCE, value: String(block["resource"]) }, { name: "alt", value: String(block["alt"] ?? "") }]);
        defaultTreeAdapter.insertBefore(parent, replacement, child); defaultTreeAdapter.detachNode(child);
      } else placeImages(child);
    }
  };
  const richBlocks: JsonObject[] = [];
  if (rich) {
    const replace = (parent: Parent): void => {
      for (const child of [...parent.childNodes]) if (isElement(child)) {
        const blocks = rich.projector.node(child, rich.owner);
        if (blocks) {
          const markers = blocks.map(block => { const index = richBlocks.length; richBlocks.push(block); return `\uE000CLOUDIG_GEMINI_RICH_${index}\uE001`; }).join("");
          defaultTreeAdapter.insertBefore(parent, defaultTreeAdapter.createTextNode(markers), child); defaultTreeAdapter.detachNode(child);
        } else replace(child);
      }
    }; replace(fragment);
  }
  placeImages(fragment);
  const used = { count: 0 };
  replaceAttachmentCards(fragment, markers, attachments, used);
  const slots = new Map(markers.map((marker, index) => [marker, attachments[index]!]));
  richBlocks.forEach((block, index) => slots.set(`\uE000CLOUDIG_GEMINI_RICH_${index}\uE001`, block));
  const split = htmlBlockSegments(fragment, slots);
  const blocks: JsonObject[] = [];
  const links: string[] = [];
  for (const part of split) {
    if (typeof part !== "string") { blocks.push(part); continue; }
    const evidence = inertHtmlEvidence(part);
    if (evidence.html) blocks.push({ type: "html", html: evidence.html });
    for (const link of evidence.links) if (!links.includes(link)) links.push(link);
  }
  let unplacedAttachments = 0;
  for (let index = used.count; index < attachments.length; index += 1) {
    const key = attachmentImageKeys[index];
    if (key && placedImageKeys.has(key)) continue;
    blocks.push(attachments[index]!); unplacedAttachments++;
  }
  if (unplacedAttachments > 0) {
    limitations.push({ code: "gemini_attachment_alignment", detail: "Gemini attachment metadata and visible attachment cards did not align one-to-one" });
  }
  if (blocks.length === 0 && fallbackText) blocks.push({ type: "text", text: fallbackText });
  return { blocks, links };
}

// Recent exports carry the same public thought in thoughts[] and the visible
// HTML shell. Remove only an exact, once-accounted-for presentation duplicate;
// unrelated details and divergent content are never guessed away.
function withoutRepresentedThinking(html: string | undefined, represented: readonly string[]): string | undefined {
  if (!html || represented.length === 0) return html;
  const remaining = [...represented];
  const fragment = parseFragment(html);
  const hasClass = (node: Element, value: string): boolean => node.attrs.some((attr) => attr.name === "class" && attr.value.split(/\s+/u).includes(value));
  const findBody = (node: Parent): Element | undefined => {
    for (const child of node.childNodes) if (isElement(child)) {
      if (hasClass(child, "thinking-body")) return child;
      const nested = findBody(child);
      if (nested) return nested;
    }
    return undefined;
  };
  const visit = (node: Parent): void => {
    for (const child of [...node.childNodes]) {
      if (!isElement(child)) continue;
      if (child.tagName === "details" && hasClass(child, "thinking")) {
        const body = findBody(child);
        const innerMatch = body ? remaining.indexOf((inertHtmlFragment(serialize(body)) ?? "").trim()) : -1;
        const match = innerMatch >= 0 ? innerMatch : remaining.indexOf((inertHtmlFragment(serializeOuter(child)) ?? "").trim());
        if (match >= 0) { remaining.splice(match, 1); defaultTreeAdapter.detachNode(child); continue; }
      }
      visit(child);
    }
  };
  visit(fragment);
  return serialize(fragment);
}

async function parseGemini(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const responseTimes = nativeResponseTimes(context.extensions?.geminiRichContent);
  const resources = new GeminiResourcePool(context.payload, context.reading?.images ?? []);
  const sources = new GeminiSourcePool(context.payload);
  const rich = context.record && context.extensions?.geminiRichContent ? new GeminiRichContent(context.extensions.geminiRichContent, new WorkResources(resources.values), (owner, url) => resources.claimRichImage(owner, url), source => sources.addDocument(source)) : undefined;
  const tasks = context.record && context.extensions?.geminiRichContent ? new GeminiTasks(context.extensions.geminiRichContent, context.record) : undefined;
  const limitations: JsonObject[] = [];
  const messages: JsonObject[] = [];
  const rawMessages = values(context.payload["messages"]);
  for (const [index, raw] of rawMessages.entries()) {
    const message = object(raw);
    if (!message) throw new TypeError("Gemini message sequence contains a non-object entry");
    const owner = sourceText(message["source_id"]) ?? `gemini-message-${index}`;
    const content: JsonObject[] = [];
    const representedThoughts: string[] = [];
    const taskProcess = tasks?.process(owner);
    for (const rawThought of values(message["thoughts"])) {
      const thought = object(rawThought);
      if (!thought) throw new TypeError("Gemini public thought is not an object");
      const html = inertHtmlFragment(sourceText(thought["html"]) ?? "");
      if (html) representedThoughts.push(html.trim());
      const title = sourceText(thought["label"]);
      if (!taskProcess && (html || title)) content.push({
        type: "reasoning",
        ...(html ? { text: html, format: "html" } : {}),
        ...(title ? { title } : {})
      });
    }
    if (taskProcess) content.push(taskProcess);
    const attachmentBlocks = values(message["attachments"]).map((value) => {
      const attachment = object(value);
      if (!attachment) throw new TypeError("Gemini attachment occurrence is not an object");
      return resources.addAttachment(attachment, owner, limitations);
    });
    const body = projectBody(withoutRepresentedThinking(sourceText(message["html"]), representedThoughts), sourceText(message["text"]), attachmentBlocks, limitations,
      key => resources.addAttachment({ kind: "image", image_key: key }, owner, limitations),
      values(message["attachments"]).map(value => sourceText(object(value)?.["image_key"])), rich ? { projector: rich, owner } : undefined);
    content.push(...body.blocks);
    if (rich) content.push(...rich.remaining(owner));
    content.push(...resources.addRemainingImages(owner, limitations));
    const citations = sources.forLinks(body.links);
    if (citations.length > 0) content.push({ type: "citations", sources: citations });
    const role = message["role"] === "user" ? "user" : message["role"] === "assistant" ? "assistant" : "other";
    const time = timestamp(message["timestamp"]) ?? (role === "assistant" ? responseTimes.get(owner) : undefined);
    const recordParent = index > 0 ? sourceText(object(rawMessages[index - 1])?.["source_id"]) ?? `gemini-message-${index - 1}` : undefined;
    const model = role === "assistant" ? sourceText(message["model"]) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role, ...(model ? { model } : {}) });
    messages.push({
      role,
      ...(role === "other" ? { name: sourceText(message["role"]) ?? "Gemini" } : {}),
      ...(model ? { model } : {}),
      ...(time ? { timestamp: time } : {}),
      content
    });
    await context.onProgress?.(index + 1, rawMessages.length);
  }

  const capturedAt = timestamp(context.manifest["exported_at"] ?? context.manifest["captured_at"])
    ?? timestamp(context.payload["exported_at"])
    ?? context.source.fileSystemCapturedAt;
  const sourceObject = object(context.manifest["source"]);
  const sourceUrl = httpUrl(sourceObject?.["url"] ?? context.payload["source_url"]);
  const title = sourceText(context.payload["title"] ?? sourceObject?.["title"]);
  const exporter = object(context.manifest["exporter"]);
  const exporterVersion = sourceText(exporter?.["version"] ?? context.manifest["exporter_version"]);
  const draft: JsonObject = {
    source: {
      file: context.source.file,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      format: "exporter-html",
      payload: payloadName.replaceAll("/", "."),
      profile,
      ...(exporterVersion ? { exporter: { id: "gemini-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "google",
    platform: "gemini",
    ...(title ? { title } : {}),
    ...(messages.some(m => m["model"]) ? { models: [...new Set(messages.flatMap(m => typeof m["model"] === "string" ? [m["model"]] : []))] } : {}),
    messages,
    ...(resources.values.length > 0 ? { resources: resources.values } : {}),
    ...(sources.values.length > 0 ? { sources: sources.values } : {}),
    ...(limitations.length > 0 ? { limitations: [...new Set(limitations.map((entry) => canonicalizeJcs(entry)))].map((entry) => JSON.parse(entry) as JsonObject) } : {})
  };
  return draft;
}

export const GEMINI_LIGHT_MANIFEST: AdapterManifest = {
  id: "gemini-light-dom-v2",
  version: "3.0.11",
  family: "gemini",
  routes: [{ format: "exporter-html", platform: "gemini", payload: "osis.gemini.chat-export/light-dom-v2", profile: "light" }],
  target: "cloudig/conversation/1.0.2",
  update_from: ["1.1.0", "2.0.0", "2.0.1", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6", "3.0.7", "3.0.8", "3.0.9", "3.0.10"].map(version => ({ adapter: "gemini-light-dom-v2", version, action: "reparse_source" as const }))
};

export const GEMINI_FULL_MANIFEST: AdapterManifest = {
  id: "gemini-full-v1",
  version: "3.0.11",
  family: "gemini",
  routes: [{ format: "exporter-html", platform: "gemini", payload: "osis.gemini.chat-export/full-v1", profile: "full" }],
  target: "cloudig/conversation/1.0.2",
  update_from: ["1.1.0", "2.0.0", "2.0.1", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6", "3.0.7", "3.0.8", "3.0.9", "3.0.10"].map(version => ({ adapter: "gemini-full-v1", version, action: "reparse_source" as const }))
};

export const geminiLightAdapter: SourceAdapter = Object.freeze({
  manifest: GEMINI_LIGHT_MANIFEST,
  parse: (context) => parseGemini(context, "light", "osis.gemini.chat-export/light-dom-v2")
});

export const geminiFullAdapter: SourceAdapter = Object.freeze({
  manifest: GEMINI_FULL_MANIFEST,
  parse: (context) => parseGemini(context, "full", "osis.gemini.chat-export/full-v1")
});
