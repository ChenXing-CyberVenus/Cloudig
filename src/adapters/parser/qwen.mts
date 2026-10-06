import { mapSequential, type AdapterManifest, type AdapterParseContext, type SourceAdapter } from "../../app/parser/adapter.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { capturedPanelWithMermaid, capturedTextPanel, inertHtmlEvidence, restoreCapturedProcess } from "./inert-html.mts";
import { normalizeMermaidSource, projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";

type Profile = "light" | "full" | "tree";
type ReadingImage = NonNullable<AdapterParseContext["reading"]>["images"][number];
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


function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameOwner(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left === right);
}

class QwenResourcePool {
  readonly values: JsonObject[] = [];
  readonly #raw = new Map<string, JsonObject>();
  readonly #reading: Array<{ value: ReadingImage; used: boolean }>;
  readonly #byKey = new Map<string, string>();

  constructor(payload: JsonObject, reading: readonly ReadingImage[]) {
    for (const raw of values(payload["resources"])) {
      const resource = object(raw);
      const id = sourceText(resource?.["id"]);
      if (!resource || !id || this.#raw.has(id)) throw new TypeError("Qwen resource registry is malformed");
      this.#raw.set(id, resource);
    }
    this.#reading = reading.map((value) => ({ value, used: false }));
  }

  #allocate(key: string, resource: Omit<JsonObject, "id">): string {
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...resource });
    this.#byKey.set(key, id);
    return id;
  }

  #embedded(raw: JsonObject, kind: "image" | "file" | "diagram", name?: string): string {
    const dataUrl = sourceText(raw["data_url"]);
    if (!dataUrl) throw new TypeError("Qwen embedded resource has no data URL");
    const embedded = kind === "file" ? embeddedBase64DataUrl(dataUrl) : embeddedImageDataUrl(dataUrl);
    const declaredMime = mimeType(raw["mime"]);
    if (declaredMime && declaredMime !== embedded.mime) throw new TypeError("Qwen resource MIME metadata disagrees with embedded bytes");
    const declaredBytes = nonNegativeInteger(raw["bytes"]);
    if (declaredBytes !== undefined && declaredBytes !== embedded.byteLength) {
      throw new TypeError("Qwen resource byte count disagrees with embedded bytes");
    }
    const sha256 = embedded.sha256;
    const width = nonNegativeInteger(raw["width"]);
    const height = nonNegativeInteger(raw["height"]);
    return this.#allocate(`${kind}\u0000${name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
      kind,
      availability: "embedded",
      ...(name ? { name } : {}),
      mime: embedded.mime,
      bytes: embedded.byteLength,
      sha256,
      ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
      ...(width && height ? { dimensions: { width, height } } : {})
    });
  }

  #takeReading(owner: string, name?: string): ReadingImage | undefined {
    const candidates = this.#reading.filter((entry) => !entry.used && sameOwner(entry.value.messageId, owner));
    const normalized = (name ?? "").trim().toLocaleLowerCase("en-US");
    const named = normalized ? candidates.filter((entry) => (entry.value.alt ?? "").trim().toLocaleLowerCase("en-US") === normalized) : [];
    const selected = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) return undefined;
    selected.used = true;
    return selected.value;
  }

  addOccurrence(raw: JsonObject, owner: string, kind: "image" | "file" | "diagram", limitations: JsonObject[]): JsonObject {
    const name = sourceText(raw["name"]);
    const resourceId = sourceText(raw["resource_id"]);
    const central = resourceId ? this.#raw.get(resourceId) : undefined;
    if (central) {
      const resource = this.#embedded(central, kind, name ?? sourceText(central["name"]));
      return kind === "file" ? { type: "attachment", resource } : kind === "image" ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "diagram", format: "mermaid", rendered: resource };
    }
    if (kind === "image") {
      const reading = this.#takeReading(owner, name);
      if (reading) {
        const embedded = embeddedImageDataUrl(reading.dataUrl);
        const sha256 = embedded.sha256;
        const resource = this.#allocate(`image\u0000${name ?? reading.alt ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
          kind: "image",
          availability: "embedded",
          ...(name ?? reading.alt ? { name: name ?? reading.alt! } : {}),
          mime: embedded.mime,
          bytes: embedded.byteLength,
          sha256,
          ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
          ...(reading.width && reading.height ? { dimensions: { width: reading.width, height: reading.height } } : {})
        });
        return { type: "image", resource, ...(name ?? reading.alt ? { alt: name ?? reading.alt! } : {}) };
      }
    }
    const status = sourceText(raw["status"])?.toLowerCase() ?? "";
    const availability = status.includes("unavailable") || status.includes("missing") || Boolean(sourceText(raw["error"])) ? "missing" : "metadata_only";
    const mime = mimeType(raw["mime"]);
    const bytes = nonNegativeInteger(raw["size"]);
    const canonicalKind = kind === "diagram" ? "diagram" : kind;
    const resource = this.#allocate(canonicalizeJcs({ kind: canonicalKind, name: name ?? "", mime: mime ?? "", bytes: bytes ?? -1, availability }), {
      kind: canonicalKind,
      availability,
      ...(name ? { name } : {}),
      ...(mime ? { mime } : {}),
      ...(bytes !== undefined ? { original_bytes: bytes } : {})
    });
    if (availability === "missing") {
      const at = this.values.findIndex((entry) => entry["id"] === resource);
      limitations.push({ code: "qwen_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
    }
    return kind === "file" ? { type: "attachment", resource } : kind === "image" ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "diagram", format: "mermaid", rendered: resource };
  }

  remainingImages(owner: string): JsonObject[] {
    const result: JsonObject[] = [];
    for (const entry of this.#reading) {
      if (entry.used || !sameOwner(entry.value.messageId, owner)) continue;
      entry.used = true;
      const embedded = embeddedImageDataUrl(entry.value.dataUrl);
      const sha256 = embedded.sha256;
      const resource = this.#allocate(`image\u0000${entry.value.alt ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
        kind: "image",
        availability: "embedded",
        ...(entry.value.alt ? { name: entry.value.alt } : {}),
        mime: embedded.mime,
        bytes: embedded.byteLength,
        sha256,
        ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
        ...(entry.value.width && entry.value.height ? { dimensions: { width: entry.value.width, height: entry.value.height } } : {})
      });
      result.push({ type: "image", resource, ...(entry.value.alt ? { alt: entry.value.alt } : {}) });
    }
    return result;
  }

  addReadingDiagram(dataUrl: string): string {
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

class QwenMermaidPool {
  readonly #reading: Array<{ value: MermaidRecord; used: boolean }>;
  readonly #media: Array<{ value: JsonObject; used: boolean }>;
  readonly #resources: QwenResourcePool;
  readonly #limitations: JsonObject[];

  constructor(message: JsonObject, reading: readonly MermaidRecord[], resources: QwenResourcePool, limitations: JsonObject[]) {
    const owner = sourceText(message["id"]);
    this.#reading = reading.filter((record) => sameOwner(record.messageId, owner)).map((value) => ({ value, used: false }));
    this.#media = values(message["media"]).flatMap((raw) => {
      const item = object(raw);
      return item && item["kind"] === "diagram" ? [{ value: item, used: false }] : [];
    });
    this.#resources = resources;
    this.#limitations = limitations;
  }

  take(owner: string, source: string): string | undefined {
    const normalized = normalizeMermaidSource(source);
    const reading = this.#reading.find((entry) => !entry.used && normalizeMermaidSource(entry.value.source) === normalized);
    const media = this.#media.find((entry) => !entry.used);
    if (media && sourceText(media.value["resource_id"])) {
      media.used = true;
      const block = this.#resources.addOccurrence(media.value, owner, "diagram", this.#limitations);
      return sourceText(block["rendered"]);
    }
    if (!reading) return undefined;
    reading.used = true;
    if (media) media.used = true;
    return this.#resources.addReadingDiagram(reading.value.dataUrl);
  }

  unplaced(owner: string): JsonObject[] {
    const result: JsonObject[] = [];
    for (const entry of this.#media) {
      if (entry.used) continue;
      entry.used = true;
      if (sourceText(entry.value["resource_id"])) {
        result.push(this.#resources.addOccurrence(entry.value, owner, "diagram", this.#limitations));
        continue;
      }
      const reading = this.#reading.find((candidate) => !candidate.used);
      if (!reading) continue;
      reading.used = true;
      result.push({
        type: "diagram",
        format: "mermaid",
        source: reading.value.source,
        rendered: this.#resources.addReadingDiagram(reading.value.dataUrl)
      });
    }
    for (const reading of this.#reading) {
      if (reading.used) continue;
      reading.used = true;
      result.push({
        type: "diagram",
        format: "mermaid",
        source: reading.value.source,
        rendered: this.#resources.addReadingDiagram(reading.value.dataUrl)
      });
    }
    return result;
  }
}

class QwenSourcePool {
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

function orderedItems(payload: JsonObject, profile: Profile, limitations: JsonObject[]): JsonObject[] {
  const input = values(payload["messages"]).map((raw) => {
    const message = object(raw);
    if (!message) throw new TypeError("Qwen message sequence contains a non-object entry");
    return message;
  });
  const byId = new Map<string, JsonObject>();
  const order = new Map<string, number>();
  for (const [index, message] of input.entries()) {
    const id = sourceText(message["id"]);
    if (!id || byId.has(id)) throw new TypeError("Qwen message identity is missing or duplicated");
    byId.set(id, message);
    order.set(id, index);
  }
  if (profile !== "tree") {
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
    if (unordered.length > 0) limitations.push({ code: "qwen_message_unordered", detail: `${unordered.length} message record(s) were absent from message_order` });
    return result;
  }
  const roots: string[] = [];
  const children = new Map<string, string[]>();
  for (const message of input) {
    const id = sourceText(message["id"])!;
    const parent = sourceText(message["parent_id"]);
    if (!parent || !byId.has(parent)) {
      roots.push(id);
      if (parent) limitations.push({ code: "source_parent_omitted", detail: "A Qwen Tree message referenced a parent omitted by the source payload" });
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
    if (active.has(id)) throw new TypeError("Qwen Tree contains a cycle");
    if (visited.has(id)) return;
    active.add(id);
    visited.add(id);
    result.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) visit(child);
    active.delete(id);
  };
  for (const root of roots) visit(root);
  if (result.length !== input.length) throw new TypeError("Qwen Tree has no complete parent-first traversal");
  return result;
}

function processBlocks(message: JsonObject): JsonObject[] {
  const result: JsonObject[] = [];
  for (const raw of values(message["public_processes"])) {
    const process = object(raw);
    if (!process) throw new TypeError("Qwen public process is not an object");
    const text = sourceText(process["content"]);
    const title = sourceText(process["title"]);
    const status = sourceText(process["status"]);
    if (text || title) result.push({ type: "reasoning_summary", ...(text ? { text, format: "markdown" } : {}), ...(title ? { title } : {}) });
    else if (status) result.push({ type: "status", text: status });
  }
  for (const raw of values(message["search_queries"])) {
    const query = sourceText(raw);
    if (query) result.push({ type: "search", query });
  }
  return result;
}

async function parseQwen(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new QwenResourcePool(context.payload, context.reading?.images ?? []);
  const sources = new QwenSourcePool();
  const fragments = new Map<string, string[]>();
  for (const fragment of context.reading?.fragments ?? []) {
    const list = fragments.get(fragment.messageId) ?? [];
    list.push(fragment.html);
    fragments.set(fragment.messageId, list);
  }
  const items = orderedItems(context.payload, profile, limitations);
  const localIds = new Map(items.map((item, index) => [sourceText(item["id"])!, `m${index + 1}`]));
  const models: string[] = [];
  const messageTimes: string[] = [];
  const messages = await mapSequential(items, async (item, index) => {
    const owner = sourceText(item["id"])!;
    const content: JsonObject[] = restoreCapturedProcess(processBlocks(item), (fragments.get(owner) ?? []).join(""));
    const usedResources = new Set<string>();
    const usedAttachmentImages = new Set<string>();
    for (const raw of values(item["attachments"])) {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("Qwen attachment occurrence is not an object");
      const resourceId = sourceText(attachment["resource_id"]);
      if (resourceId) usedResources.add(resourceId);
      if (attachment["kind"] === "image") {
        const name = sourceText(attachment["name"]);
        if (name) usedAttachmentImages.add(name.trim().toLocaleLowerCase("en-US"));
      }
      content.push(resources.addOccurrence(attachment, owner, attachment["kind"] === "image" ? "image" : "file", limitations));
    }
    const mermaid = new QwenMermaidPool(item, context.reading?.mermaid ?? [], resources, limitations);
    const markdown = sourceText(item["content_markdown"]);
    const reading = (fragments.get(owner) ?? []).join("");
    const captured = capturedTextPanel(reading, "message-content");
    const mixed = !captured ? capturedPanelWithMermaid(reading, "message-content") : undefined;
    if (captured) content.push({ type: "html", html: captured });
    else if (mixed) for (const part of mixed) {
      if ("html" in part) content.push({ type: "html", html: part.html });
      else {
        const rendered = mermaid.take(owner, part.mermaid);
        content.push({ type: "diagram", format: "mermaid", source: part.mermaid, ...(rendered ? { rendered } : {}) });
      }
    }
    else if (markdown) content.push(...projectMarkdownWithDiagrams(markdown, (source) => mermaid.take(owner, source)));
    for (const raw of values(item["media"])) {
      const media = object(raw);
      if (!media || media["kind"] === "diagram") continue;
      const resourceId = sourceText(media["resource_id"]);
      if (resourceId && usedResources.has(resourceId)) continue;
      const mediaName = sourceText(media["name"]);
      if (media["kind"] === "attachment-image" && mediaName && usedAttachmentImages.has(mediaName.trim().toLocaleLowerCase("en-US"))) continue;
      if (resourceId) usedResources.add(resourceId);
      content.push(resources.addOccurrence(media, owner, "image", limitations));
    }
    content.push(...mermaid.unplaced(owner));
    content.push(...resources.remainingImages(owner));
    if (!markdown && content.length === 0) {
      for (const html of fragments.get(owner) ?? []) {
        const evidence = inertHtmlEvidence(html);
        if (evidence.html) content.push({ type: "html", html: evidence.html });
      }
    }
    const sourceIds = sources.addAll(item["sources"]);
    if (sourceIds.length > 0) content.push({ type: "citations", sources: sourceIds });
    const model = sourceText(item["model"]);
    if (model && !models.includes(model)) models.push(model);
    const time = timestamp(item["timestamp"]);
    if (time) messageTimes.push(time);
    const role = item["role"] === "user" ? "user" : item["role"] === "assistant" ? "assistant" : item["role"] === "system" ? "system" : "other";
    const parentRaw = sourceText(item["parent_id"]);
    const parent = profile === "tree" && parentRaw ? localIds.get(parentRaw) : undefined;
    const recordParent = profile === "tree" ? parentRaw : index > 0 ? sourceText(items[index - 1]!["id"]) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role, ...(model ? { model } : {}) });
    await context.onProgress?.(index + 1, items.length);
    return {
      ...(profile === "tree" ? { id: `m${index + 1}`, ...(parent ? { parent } : {}) } : {}),
      role,
      ...(role === "other" ? { name: sourceText(item["role"]) ?? "Qwen" } : {}),
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
  const currentRaw = profile === "tree"
    ? sourceText(context.payload["current_leaf_message_id"])
      ?? values(context.payload["active_message_ids"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []).at(-1)
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
      ...(exporterVersion ? { exporter: { id: "qwen-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "alibaba",
    platform: "qwen",
    ...(title ? { title } : {}),
    ...(models.length > 0 ? { models } : {}),
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
    version: "3.0.3",
    family: "qwen",
    routes: [{ format: "exporter-html", platform: "qwen", payload, profile }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "3.0.0", "3.0.1", "3.0.2"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const QWEN_LIGHT_MANIFEST = manifest("qwen-light-messages-v2", "osis.qwen.chat-export/light-messages-v2", "light");
export const QWEN_FULL_MANIFEST = manifest("qwen-full-v1", "osis.qwen.chat-export/full-v1", "full");
export const QWEN_TREE_MANIFEST = manifest("qwen-all-branches-v1", "osis.qwen.chat-export/all-branches-v1", "tree");

export const qwenLightAdapter: SourceAdapter = Object.freeze({ manifest: QWEN_LIGHT_MANIFEST, parse: (context) => parseQwen(context, "light", "osis.qwen.chat-export/light-messages-v2") });
export const qwenFullAdapter: SourceAdapter = Object.freeze({ manifest: QWEN_FULL_MANIFEST, parse: (context) => parseQwen(context, "full", "osis.qwen.chat-export/full-v1") });
export const qwenTreeAdapter: SourceAdapter = Object.freeze({ manifest: QWEN_TREE_MANIFEST, parse: (context) => parseQwen(context, "tree", "osis.qwen.chat-export/all-branches-v1") });
