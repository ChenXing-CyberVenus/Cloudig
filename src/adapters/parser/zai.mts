import {
  parseFragment,
  serializeOuter,
  type DefaultTreeAdapterTypes
} from "parse5";

import { mapSequential, type AdapterManifest, type AdapterParseContext, type SourceAdapter } from "../../app/parser/adapter.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { capturedTextPanel, inertHtmlFragment, inertStandaloneSvg, restoreCapturedProcess } from "./inert-html.mts";
import { normalizeMermaidSource, projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";

type Profile = "light" | "full" | "tree";
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
    : descendants(element).find((candidate) => candidate.tagName.toLowerCase() === "svg" && (hasClass(candidate, "osis-mermaid-svg") || attribute(candidate, "data-osis-static-diagram") !== undefined));
  if (!svg) return undefined;
  const inert = inertStandaloneSvg(serializeOuter(svg));
  return inert ? `data:image/svg+xml;utf8,${encodeURIComponent(inert)}` : undefined;
}

class ZaiResourcePool {
  readonly values: JsonObject[] = [];
  readonly #central = new Map<string, JsonObject>();
  readonly #byKey = new Map<string, string>();
  readonly #images: Array<{ value: ReadingImage; used: boolean }>;
  readonly #files: Array<{ value: ReadingFile; used: boolean }>;

  constructor(payload: JsonObject, reading: NonNullable<AdapterParseContext["reading"]> | undefined) {
    for (const raw of values(payload["resources"])) {
      const resource = object(raw);
      const key = sourceText(resource?.["key"]);
      if (!resource || !key || this.#central.has(key)) throw new TypeError("Z.ai resource registry is malformed");
      this.#central.set(key, resource);
    }
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

  #takeFile(owner: string, name?: string): ReadingFile | undefined {
    const candidates = this.#files.filter((entry) => !entry.used && entry.value.messageId === owner
      && (!normalizedName(name) || !normalizedName(entry.value.name) || normalizedName(entry.value.name) === normalizedName(name)));
    const exact = normalizedName(name)
      ? candidates.filter((entry) => normalizedName(entry.value.name) === normalizedName(name))
      : [];
    const selected = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
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

  #embedded(raw: JsonObject, kind: "image" | "file", name?: string, originalBytes?: number): string {
    const dataUrl = sourceText(raw["data_url"]);
    if (!dataUrl) throw new TypeError("Z.ai embedded resource has no data URL");
    const embedded = kind === "image" ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
    const metadata = object(raw["raw"]);
    const declaredMime = mimeType(raw["declared_mime"] ?? metadata?.["mime_type"]);
    const declaredBytes = nonNegativeInteger(metadata?.["bytes"]);
    if (declaredBytes !== undefined && declaredBytes !== embedded.byteLength) {
      throw new TypeError("Z.ai resource byte count disagrees with embedded bytes");
    }
    const sha256 = embedded.sha256;
    return this.#allocate(`${kind}\u0000${name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
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
  }

  addOccurrence(raw: JsonObject, owner: string, kind: "image" | "file", limitations: JsonObject[]): JsonObject {
    const name = sourceText(raw["name"]);
    const resourceKey = sourceText(raw["resource_key"]);
    const central = resourceKey ? this.#central.get(resourceKey) : undefined;
    const originalBytes = nonNegativeInteger(raw["size"] ?? raw["archived_bytes"]);
    if (central) {
      const owners = values(central["message_ids"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []);
      if (owners.length > 0 && !owners.includes(owner)) throw new TypeError("Z.ai resource owner disagrees with its message occurrence");
      const resource = this.#embedded(central, kind, name ?? sourceText(central["name"]), originalBytes);
      return kind === "image" ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
    }
    const readingFile = this.#takeFile(owner, name);
    const readingImage = !readingFile && kind === "image" ? this.#takeImage(owner, name) : undefined;
    const dataUrl = readingFile?.dataUrl ?? readingImage?.dataUrl;
    if (dataUrl) {
      const embedded = kind === "image" ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      const sha256 = embedded.sha256;
      const declaredMime = mimeType(raw["mime"] ?? raw["archived_mime"]);
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
      return kind === "image" ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
    }
    const status = sourceText(raw["status"])?.toLowerCase() ?? "";
    const availability = status.includes("missing") || status.includes("failed") ? "missing" : "metadata_only";
    const declaredMime = mimeType(raw["mime"] ?? raw["archived_mime"]);
    const resource = this.#allocate(canonicalizeJcs({ kind, name: name ?? "", mime: declaredMime ?? "", originalBytes: originalBytes ?? -1, availability }), {
      kind,
      availability,
      ...(name ? { name } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
    });
    if (availability === "missing") {
      const at = this.values.findIndex((entry) => entry["id"] === resource);
      limitations.push({ code: "zai_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
    }
    return kind === "image" ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
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

class ZaiDiagramPool {
  readonly #entries: Array<{ source?: string; rendered?: string; used: boolean }> = [];

  observeHtml(html: string): void {
    const fragment = parseFragment(html);
    for (const card of descendants(fragment).filter((element) => hasClass(element, "osis-mermaid-card"))) {
      const source = descendants(card)
        .filter((element) => element.tagName.toLowerCase() === "code")
        .map((element) => textContent(element))
        .find((value) => value.length > 0);
      const rendered = svgDataUrl(card);
      if (source || rendered) this.#entries.push({ ...(source ? { source } : {}), ...(rendered ? { rendered } : {}), used: false });
    }
  }

  take(source: string): Readonly<{ source?: string; rendered?: string }> | undefined {
    const normalized = normalizeMermaidSource(source);
    const exact = this.#entries.find((entry) => !entry.used && entry.source && normalizeMermaidSource(entry.source) === normalized);
    if (!exact) return undefined;
    exact.used = true;
    return { ...(exact.source ? { source: exact.source } : {}), ...(exact.rendered ? { rendered: exact.rendered } : {}) };
  }

  remaining(): ReadonlyArray<Readonly<{ source?: string; rendered?: string }>> {
    const output: Array<Readonly<{ source?: string; rendered?: string }>> = [];
    for (const entry of this.#entries) {
      if (entry.used) continue;
      entry.used = true;
      output.push({ ...(entry.source ? { source: entry.source } : {}), ...(entry.rendered ? { rendered: entry.rendered } : {}) });
    }
    return output;
  }
}

class ZaiSourcePool {
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
    if (!message) throw new TypeError("Z.ai message sequence contains a non-object entry");
    return message;
  });
  const byId = new Map<string, JsonObject>();
  const order = new Map<string, number>();
  const sourceOrder = values(payload["message_order"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []);
  for (const [index, id] of sourceOrder.entries()) if (!order.has(id)) order.set(id, index);
  for (const [index, message] of input.entries()) {
    const id = sourceText(message["id"]);
    if (!id || byId.has(id)) throw new TypeError("Z.ai message identity is missing or duplicated");
    byId.set(id, message);
    if (!order.has(id)) order.set(id, sourceOrder.length + index);
  }
  if (profile !== "tree") {
    const result: JsonObject[] = [];
    const seen = new Set<string>();
    for (const id of sourceOrder) {
      if (seen.has(id)) continue;
      seen.add(id);
      const message = byId.get(id);
      if (message) result.push(message);
    }
    const unordered = input.filter((message) => !seen.has(sourceText(message["id"])!));
    result.push(...unordered);
    if (unordered.length > 0) limitations.push({ code: "zai_message_unordered", detail: `${unordered.length} message record(s) were absent from message_order` });
    return result;
  }
  const roots: string[] = [];
  const children = new Map<string, string[]>();
  for (const message of input) {
    const id = sourceText(message["id"])!;
    const parent = sourceText(message["parent_id"]);
    if (!parent || !byId.has(parent)) {
      roots.push(id);
      if (parent) limitations.push({ code: "source_parent_omitted", detail: "A Z.ai Tree message referenced a parent omitted by the source payload" });
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
    if (active.has(id)) throw new TypeError("Z.ai Tree contains a cycle");
    if (visited.has(id)) return;
    active.add(id);
    visited.add(id);
    result.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) visit(child);
    active.delete(id);
  };
  for (const root of roots) visit(root);
  if (result.length !== input.length) throw new TypeError("Z.ai Tree has no complete parent-first traversal");
  return result;
}

function processBlocks(message: JsonObject, effort?: string): JsonObject[] {
  const result: JsonObject[] = [];
  for (const raw of values(message["public_processes"])) {
    const process = object(raw);
    if (!process) throw new TypeError("Z.ai public process is not an object");
    const text = sourceText(process["content"]);
    const title = sourceText(process["title"]);
    const duration = finiteNonNegative(process["duration_seconds"]);
    if (text || title) result.push({
      type: "reasoning",
      ...(text ? { text, format: "markdown" } : {}),
      ...(title ? { title } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(effort ? { effort } : {})
    });
  }
  for (const raw of values(message["search_queries"])) {
    const query = sourceText(raw);
    if (query) result.push({ type: "search", query });
  }
  return result;
}

type MarkdownImage = Readonly<{ start: number; end: number; alt: string }>;

function markdownImages(value: string): MarkdownImage[] {
  return [...value.matchAll(/!\[([^\]\r\n]*)\]\([^)\r\n]+\)/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    alt: match[1] ?? ""
  }));
}

function projectBody(input: Readonly<{
  markdown: string;
  owner: string;
  media: readonly JsonObject[];
  diagrams: ZaiDiagramPool;
  resources: ZaiResourcePool;
  limitations: JsonObject[];
}>): JsonObject[] {
  const inline = input.media.filter((media) => sourceText(media["kind"]) === "inline-image");
  const matches = markdownImages(input.markdown);
  const assignments = new Map<number, number>();
  const usedMedia = new Set<number>();
  for (const [matchIndex, match] of matches.entries()) {
    const exact = inline.findIndex((media, index) => !usedMedia.has(index) && normalizedName(sourceText(media["name"])) === normalizedName(match.alt));
    const selected = exact >= 0 ? exact : inline.length === 1 && matches.length === 1 ? 0 : -1;
    if (selected >= 0 && !usedMedia.has(selected)) {
      assignments.set(matchIndex, selected);
      usedMedia.add(selected);
    }
  }
  const result: JsonObject[] = [];
  const projectMarkdown = (markdown: string): void => {
    result.push(...projectMarkdownWithDiagrams(markdown, (source) => {
      const record = input.diagrams.take(source);
      return record?.rendered ? input.resources.addDiagram(record.rendered) : undefined;
    }));
  };
  let cursor = 0;
  for (const [matchIndex, match] of matches.entries()) {
    const mediaIndex = assignments.get(matchIndex);
    if (mediaIndex === undefined) continue;
    projectMarkdown(input.markdown.slice(cursor, match.start));
    result.push(input.resources.addOccurrence(inline[mediaIndex]!, input.owner, "image", input.limitations));
    cursor = match.end;
  }
  projectMarkdown(input.markdown.slice(cursor));
  for (const [index, media] of inline.entries()) {
    if (usedMedia.has(index)) continue;
    result.push(input.resources.addOccurrence(media, input.owner, "image", input.limitations));
    if (matches.length > 0) input.limitations.push({ code: "zai_inline_image_unaligned", detail: "An owned inline image could not be paired to one exact Markdown occurrence" });
  }
  for (const record of input.diagrams.remaining()) {
    if (!record.source && !record.rendered) continue;
    result.push({
      type: "diagram",
      format: "mermaid",
      ...(record.source ? { source: record.source } : {}),
      ...(record.rendered ? { rendered: input.resources.addDiagram(record.rendered) } : {})
    });
  }
  return result;
}

async function parseZai(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new ZaiResourcePool(context.payload, context.reading);
  const sources = new ZaiSourcePool();
  const fragments = new Map<string, string[]>();
  for (const fragment of context.reading?.fragments ?? []) {
    const list = fragments.get(fragment.messageId) ?? [];
    list.push(fragment.html);
    fragments.set(fragment.messageId, list);
  }
  const input = orderedItems(context.payload, profile, limitations);
  const localIds = new Map(input.map((item, index) => [sourceText(item["id"])!, `m${index + 1}`]));
  const effort = sourceText(context.payload["reasoning_effort"]);
  const models: string[] = [];
  const messageTimes: string[] = [];
  const messages = await mapSequential(input, async (message, index) => {
    const owner = sourceText(message["id"])!;
    const diagrams = new ZaiDiagramPool();
    for (const html of fragments.get(owner) ?? []) diagrams.observeHtml(html);
    const attachments = values(message["attachments"]).map((raw) => {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("Z.ai attachment occurrence is not an object");
      return attachment;
    });
    const media = values(message["media"]).map((raw) => {
      const item = object(raw);
      if (!item) throw new TypeError("Z.ai media occurrence is not an object");
      return item;
    });
    const usedResourceKeys = new Set<string>();
    const usedImageNames = new Set<string>();
    const attachmentBlocks = attachments.map((attachment) => {
      const resourceKey = sourceText(attachment["resource_key"]);
      if (resourceKey) usedResourceKeys.add(resourceKey);
      if (sourceText(attachment["kind"]) === "image") {
        const name = sourceText(attachment["name"]);
        if (name) usedImageNames.add(normalizedName(name));
      }
      return resources.addOccurrence(attachment, owner, sourceText(attachment["kind"]) === "image" ? "image" : "file", limitations);
    });
    const uniqueMedia = media.filter((item) => {
      const resourceKey = sourceText(item["resource_key"]);
      if (resourceKey && usedResourceKeys.has(resourceKey)) return false;
      const name = sourceText(item["name"]);
      if (sourceText(item["kind"]) === "attachment-image" && name && usedImageNames.has(normalizedName(name))) return false;
      if (resourceKey) usedResourceKeys.add(resourceKey);
      return true;
    });
    const markdown = sourceText(message["content_markdown"]);
    const captured = uniqueMedia.length === 0 && !(message["role"] === "user" && markdown)
      ? capturedTextPanel((fragments.get(owner) ?? []).join(""), "message-content") : undefined;
    const body = captured ? [{ type: "html", html: captured }] : markdown
      ? projectBody({ markdown, owner, media: uniqueMedia, diagrams, resources, limitations })
      : uniqueMedia.map((item) => resources.addOccurrence(item, owner, "image", limitations));
    const sourceIds = sources.addAll(message["sources"]);
    const content = [
      ...restoreCapturedProcess(processBlocks(message, effort), (fragments.get(owner) ?? []).join("")),
      ...attachmentBlocks,
      ...body,
      ...(sourceIds.length > 0 ? [{ type: "citations", sources: sourceIds }] : [])
    ];
    const model = sourceText(message["model"]);
    if (model && !models.includes(model)) models.push(model);
    const time = timestamp(message["timestamp"]);
    if (time) messageTimes.push(time);
    const role = message["role"] === "user" ? "user" : message["role"] === "assistant" ? "assistant" : message["role"] === "system" ? "system" : "other";
    const parentRaw = sourceText(message["parent_id"]);
    const parent = profile === "tree" && parentRaw ? localIds.get(parentRaw) : undefined;
    const recordParent = profile === "tree" ? parentRaw : index > 0 ? sourceText(input[index - 1]!["id"]) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role, ...(model ? { model } : {}) });
    await context.onProgress?.(index + 1, input.length);
    return {
      ...(profile === "tree" ? { id: `m${index + 1}`, ...(parent ? { parent } : {}) } : {}),
      role,
      ...(role === "other" ? { name: sourceText(message["role"]) ?? "Z.ai" } : {}),
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
      ...(exporterVersion ? { exporter: { id: "zai-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "zhipu",
    platform: "zai",
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
    version: "3.0.5",
    family: "zai",
    routes: [{ format: "exporter-html", platform: "zai", payload, profile }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const ZAI_LIGHT_MANIFEST = manifest("zai-light-messages-v2", "osis.zai.chat-export/light-messages-v2", "light");
export const ZAI_FULL_MANIFEST = manifest("zai-full-v1", "osis.zai.chat-export/full-v1", "full");
export const ZAI_TREE_MANIFEST = manifest("zai-all-branches-v1", "osis.zai.chat-export/all-branches-v1", "tree");

export const zaiLightAdapter: SourceAdapter = Object.freeze({ manifest: ZAI_LIGHT_MANIFEST, parse: (context) => parseZai(context, "light", "osis.zai.chat-export/light-messages-v2") });
export const zaiFullAdapter: SourceAdapter = Object.freeze({ manifest: ZAI_FULL_MANIFEST, parse: (context) => parseZai(context, "full", "osis.zai.chat-export/full-v1") });
export const zaiTreeAdapter: SourceAdapter = Object.freeze({ manifest: ZAI_TREE_MANIFEST, parse: (context) => parseZai(context, "tree", "osis.zai.chat-export/all-branches-v1") });
