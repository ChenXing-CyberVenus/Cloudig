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
import { capturedMathIsDisplay, inertHtmlEvidence, inertHtmlFragment, inertStandaloneSvg, preserveNestedImage, preserveNestedMath } from "./inert-html.mts";
import { normalizeMermaidSource } from "./markdown-diagrams.mts";

type Profile = "light" | "full" | "tree";
type Parent = DefaultTreeAdapterTypes.ParentNode;
type Child = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ReadingImage = NonNullable<AdapterParseContext["reading"]>["images"][number];
type ReadingFile = NonNullable<AdapterParseContext["reading"]>["files"][number];
type MermaidReading = NonNullable<AdapterParseContext["reading"]>["mermaid"][number];

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function values(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function sourceText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNonNegative(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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


function unique(input: readonly string[]): string[] {
  return [...new Set(input)];
}

function normalizedName(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en-US");
}

function versionText(value: JsonValue | undefined): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return sourceText(value) ?? "0";
}

function sourceIdentity(id: string, version: string): string {
  return `${id}::${version}`;
}

function messageIdentity(message: JsonObject): string {
  const key = sourceText(message["key"]);
  if (key) return key;
  const id = sourceText(message["id"]);
  if (!id) throw new TypeError("Mistral message identity is missing");
  return sourceIdentity(id, versionText(message["version"]));
}

function isElement(node: Child | Parent): node is Element {
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
  return `\uE000CLOUDIG_MISTRAL_BLOCK_${index}\uE001`;
}

function readingIdentity(value: Readonly<{ messageId: string; messageVersion?: string }>): string {
  return sourceIdentity(value.messageId, value.messageVersion ?? "0");
}

class MistralResourcePool {
  readonly values: JsonObject[] = [];
  readonly #central = new Map<string, JsonObject>();
  readonly #byKey = new Map<string, string>();
  readonly #images: Array<{ value: ReadingImage; used: boolean }>;
  readonly #files: Array<{ value: ReadingFile; used: boolean }>;
  readonly #usedCentralImages = new Set<string>();

  constructor(payload: JsonObject, reading: NonNullable<AdapterParseContext["reading"]> | undefined) {
    for (const raw of values(payload["resources"])) {
      const resource = object(raw);
      const key = sourceText(resource?.["key"]);
      if (!resource || !key || this.#central.has(key)) throw new TypeError("Mistral resource registry is malformed");
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

  #embedded(raw: JsonObject, kind: "image" | "file", name?: string, originalBytes?: number): string {
    const dataUrl = sourceText(raw["data_url"]);
    if (!dataUrl) throw new TypeError("Mistral embedded resource has no data URL");
    const embedded = kind === "image" ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
    const metadata = object(raw["raw"]);
    const declaredBytes = nonNegativeInteger(metadata?.["bytes"]);
    if (declaredBytes !== undefined && declaredBytes !== embedded.byteLength) throw new TypeError("Mistral resource byte count disagrees with embedded bytes");
    const declaredMime = mimeType(raw["declared_mime"] ?? metadata?.["mime_type"] ?? metadata?.["response_mime_type"]);
    const sha256 = embedded.sha256;
    return this.#allocate(`${kind}\u0000${kind === "image" ? "" : name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
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

  #takeReading<T extends ReadingImage | ReadingFile>(entries: Array<{ value: T; used: boolean }>, owner: string, name?: string): T | undefined {
    const label = (entry: T): string | undefined => "alt" in entry ? entry.alt : "name" in entry ? entry.name : undefined;
    const candidates = entries.filter((entry) => !entry.used && readingIdentity(entry.value) === owner
      && (!normalizedName(name) || !normalizedName(label(entry.value)) || normalizedName(label(entry.value)) === normalizedName(name)));
    const exact = normalizedName(name)
      ? candidates.filter((entry) => normalizedName("alt" in entry.value ? entry.value.alt : "name" in entry.value ? entry.value.name : undefined) === normalizedName(name))
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
    const resourceKey = sourceText(raw["resource_key"]);
    const central = resourceKey ? this.#central.get(resourceKey) : undefined;
    const originalBytes = nonNegativeInteger(raw["size"] ?? raw["archived_bytes"]);
    if (central) {
      const owners = values(central["message_keys"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []);
      if (owners.length > 0 && !owners.includes(owner)) throw new TypeError("Mistral resource owner disagrees with its message occurrence");
      const resource = this.#embedded(central, kind, name ?? sourceText(central["name"]), originalBytes);
      if (isImage) this.#usedCentralImages.add(`${resourceKey}\u0000${owner}`);
      return isImage ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
    }
    const readingFile = isImage ? undefined : this.#takeReading(this.#files, owner, name);
    const readingImage = isImage ? this.#takeReading(this.#images, owner, name) : undefined;
    const dataUrl = readingFile?.dataUrl ?? readingImage?.dataUrl;
    if (dataUrl) {
      const embedded = isImage ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      const sha256 = embedded.sha256;
      const declaredMime = mimeType(raw["mime"] ?? raw["archived_mime"]);
      const resource = this.#allocate(`${kind}\u0000${kind === "image" ? "" : name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
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
      limitations.push({ code: "mistral_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
    }
    return isImage ? { type: "image", resource, ...(name ? { alt: name } : {}) } : { type: "attachment", resource };
  }

  addDomImage(owner: string, dataUrl: string | undefined, alt: string | undefined, width: number | undefined, height: number | undefined): JsonObject | undefined {
    if (dataUrl?.startsWith("data:image/")) {
      const embedded = embeddedImageDataUrl(dataUrl);
      const sha256 = embedded.sha256;
      const resource = this.#allocate(`image\u0000\u0000${embedded.mime}\u0000${sha256}`, {
        kind: "image", availability: "embedded", ...(alt ? { name: alt } : {}), mime: embedded.mime,
        bytes: embedded.byteLength, sha256,
        ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
        ...(width && height ? { dimensions: { width, height } } : {})
      });
      return { type: "image", resource, ...(alt ? { alt } : {}) };
    }
    const candidates = [...this.#central.entries()].filter(([key, resource]) => {
      if (sourceText(resource["kind"]) !== "image") return false;
      if (this.#usedCentralImages.has(`${key}\u0000${owner}`)) return false;
      return values(resource["message_keys"]).some((value) => sourceText(value) === owner);
    });
    const named = normalizedName(alt)
      ? candidates.filter(([, resource]) => normalizedName(sourceText(resource["name"])) === normalizedName(alt))
      : [];
    const selected = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) return undefined;
    this.#usedCentralImages.add(`${selected[0]}\u0000${owner}`);
    const resource = this.#embedded(selected[1], "image", alt ?? sourceText(selected[1]["name"]));
    return { type: "image", resource, ...(alt ? { alt } : {}) };
  }

  addDiagram(dataUrl: string): string {
    const embedded = embeddedImageDataUrl(dataUrl);
    const sha256 = embedded.sha256;
    return this.#allocate(`diagram\u0000${embedded.mime}\u0000${sha256}`, {
      kind: "diagram", availability: "embedded", mime: embedded.mime, bytes: embedded.byteLength, sha256,
      ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {})
    });
  }
}

class MistralDiagramPool {
  readonly #entries: Array<{ value: JsonObject; rendered?: string; used: boolean }>;

  constructor(raw: JsonValue | undefined, reading: readonly MermaidReading[], owner: string) {
    this.#entries = values(raw).map((value) => {
      const diagram = object(value);
      if (!diagram) throw new TypeError("Mistral diagram source is not an object");
      return { value: diagram, used: false };
    });
    for (const record of reading.filter((entry) => readingIdentity(entry) === owner)) {
      const normalized = normalizeMermaidSource(record.source);
      const exact = this.#entries.find((entry) => !entry.rendered && normalizeMermaidSource(sourceText(entry.value["source"]) ?? "") === normalized);
      if (exact) exact.rendered = record.dataUrl;
      else this.#entries.push({ value: { kind: "mermaid", source: record.source }, rendered: record.dataUrl, used: false });
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

class MistralSourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string[]>();

  add(raw: JsonObject): string | undefined {
    const url = httpUrl(raw["url"]);
    if (!url) return undefined;
    const title = sourceText(raw["title"]);
    const snippet = sourceText(raw["description"] ?? raw["snippet"]);
    const name = sourceText(raw["source"]);
    const key = `${url}\u0000${title ?? ""}`;
    const candidates = this.#byKey.get(key) ?? [];
    const record = candidates.map(id => this.values.find(entry => entry["id"] === id)!).find(entry =>
      !snippet || !entry["snippet"] || entry["snippet"] === snippet);
    if (record) {
      if (!record["snippet"] && snippet) record["snippet"] = snippet;
      if (!record["name"] && name) record["name"] = name;
      return String(record["id"]);
    }
    const id = `s${this.values.length + 1}`;
    this.values.push({ id, kind: "web", url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(name ? { name } : {}) });
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

function orderRecord(value: JsonValue): Readonly<{ id: string; version: string; key: string }> | undefined {
  const record = object(value);
  const id = sourceText(record?.["id"]);
  if (!record || !id) return undefined;
  const version = versionText(record["version"]);
  return { id, version, key: sourceText(record["key"]) ?? sourceIdentity(id, version) };
}

function orderedItems(payload: JsonObject, profile: Profile, limitations: JsonObject[]): JsonObject[] {
  const input = values(payload["messages"]).map((raw) => {
    const message = object(raw);
    if (!message) throw new TypeError("Mistral message sequence contains a non-object entry");
    return message;
  });
  const byKey = new Map<string, JsonObject>();
  const order = new Map<string, number>();
  const sourceOrder = values(payload["message_order"]).flatMap((value) => orderRecord(value) ? [orderRecord(value)!] : []);
  for (const [index, record] of sourceOrder.entries()) if (!order.has(record.key)) order.set(record.key, index);
  for (const [index, message] of input.entries()) {
    const key = messageIdentity(message);
    if (byKey.has(key)) throw new TypeError("Mistral id+version identity is duplicated");
    byKey.set(key, message);
    if (!order.has(key)) order.set(key, sourceOrder.length + index);
  }
  if (profile !== "tree") {
    const result: JsonObject[] = [];
    const seen = new Set<string>();
    for (const record of sourceOrder) {
      if (seen.has(record.key)) continue;
      seen.add(record.key);
      const message = byKey.get(record.key);
      if (message) result.push(message);
    }
    const unordered = input.filter((message) => !seen.has(messageIdentity(message)));
    result.push(...unordered);
    if (unordered.length > 0) limitations.push({ code: "mistral_message_unordered", detail: `${unordered.length} id+version message(s) were absent from message_order` });
    return result;
  }
  const roots: string[] = [];
  const children = new Map<string, string[]>();
  for (const message of input) {
    const key = messageIdentity(message);
    const parentId = sourceText(message["parent_id"]);
    const parentKey = parentId ? sourceIdentity(parentId, versionText(message["parent_version"])) : undefined;
    if (!parentKey || !byKey.has(parentKey)) {
      roots.push(key);
      if (parentKey) limitations.push({ code: "source_parent_omitted", detail: "A Mistral id+version node referenced a parent omitted by the source payload" });
    } else {
      const list = children.get(parentKey) ?? [];
      list.push(key);
      children.set(parentKey, list);
    }
  }
  for (const list of children.values()) list.sort((left, right) => order.get(left)! - order.get(right)!);
  roots.sort((left, right) => order.get(left)! - order.get(right)!);
  const result: JsonObject[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (key: string): void => {
    if (active.has(key)) throw new TypeError("Mistral id+version tree contains a cycle");
    if (visited.has(key)) return;
    active.add(key);
    visited.add(key);
    result.push(byKey.get(key)!);
    for (const child of children.get(key) ?? []) visit(child);
    active.delete(key);
  };
  for (const root of roots) visit(root);
  if (result.length !== input.length) throw new TypeError("Mistral Tree has no complete parent-first traversal");
  return result;
}

function toolBlock(tool: JsonObject, sources: MistralSourcePool): JsonObject {
  const name = sourceText(tool["name"]);
  const query = sourceText(tool["query"]);
  const argumentsText = sourceText(tool["arguments_text"]);
  const sourceIds = sources.addAll(tool["results"]);
  const output = sourceIds.length > 0 ? { sources: sourceIds } : undefined;
  return {
    type: "tool",
    kind: "activity",
    ...(name ? { name } : {}),
    ...(argumentsText ?? query ? { input: argumentsText ?? query! } : {}),
    ...(output ? { output } : {}),
    ...(typeof tool["success"] === "boolean" ? { success: tool["success"] } : {}),
    ...(typeof tool["done"] === "boolean" ? { status: tool["done"] ? "completed" : "incomplete" } : {})
  };
}

function processBlocks(message: JsonObject, sources: MistralSourcePool, reading: readonly string[] = []): JsonObject[] {
  const thoughts = values(message["public_thoughts"]).map((raw) => {
    const thought = object(raw);
    if (!thought) throw new TypeError("Mistral public thought is not an object");
    return thought;
  });
  const tools = values(message["tools"]).map((raw) => {
    const tool = object(raw);
    if (!tool) throw new TypeError("Mistral tool record is not an object");
    return { value: tool, used: false };
  });
  const result: JsonObject[] = [];
  const captured = reading.flatMap(html => descendants(parseFragment(html)).filter(node => hasClass(node, "osis-public-thinking")).map(node => inertHtmlFragment(node.childNodes.filter(child => !(isElement(child) && child.tagName === "summary")).map(child => serializeOuter(child)).join(""))));
  const appendTools = (after: number): void => {
    for (const tool of tools) {
      if (tool.used || nonNegativeInteger(tool.value["after_reasoning_index"]) !== after) continue;
      tool.used = true;
      result.push(toolBlock(tool.value, sources));
    }
  };
  const appendThought = (thought: JsonObject, rich?: string): void => {
    const text = sourceText(thought["body_text"]);
    const title = sourceText(thought["label"]);
    const duration = finiteNonNegative(thought["seconds"]);
    if (text || rich || title) result.push({ type: "reasoning", ...(rich ? { text: rich, format: "html" } : text ? { text, format: "markdown" } : {}), ...(title ? { title } : {}), ...(duration !== undefined ? { duration } : {}) });
  };
  const appendPublic = (index: number): void => appendThought(thoughts[index]!, captured.length === thoughts.length ? captured[index] : undefined);
  const segments = values(message["reasoning_segments"]).flatMap(raw => object(raw) ? [object(raw)!] : []);
  appendTools(0);
  if (segments.length === 0) {
    thoughts.forEach((_thought, index) => { appendPublic(index); appendTools(index + 1); });
  } else {
    // API segments and tool.after_reasoning_index share one ordered timeline.
    // A DOM Thought may cover only the pre-tool segment; do not discard the
    // following API body or borrow the first panel for it. Exact text matches
    // reuse that occurrence's rich HTML; unmatched public panels also survive.
    const key = (value: JsonValue | undefined): string => (sourceText(value) ?? "").replace(/\r\n?/gu, "\n").trim();
    let publicIndex = 0;
    for (const [index, segment] of segments.entries()) {
      const body = key(segment["body_text"]);
      const match = body ? thoughts.findIndex((thought, at) => at >= publicIndex && key(thought["body_text"]) === body) : -1;
      if (match >= 0) {
        while (publicIndex <= match) appendPublic(publicIndex++);
      } else if (body) {
        const milliseconds = finiteNonNegative(segment["duration_ms"]);
        appendThought({ body_text: segment["body_text"]!, ...(milliseconds !== undefined ? { seconds: milliseconds / 1000 } : {}) });
      } else if (thoughts[publicIndex]?.["raw"] === "Thought" && key(thoughts[publicIndex]?.["body_text"]) === "■\nThinking") {
        // This exact platform loading shell is confirmed empty by its API
        // segment. Keep the status, not a clickable fake reasoning body.
        appendThought({ label: thoughts[publicIndex++]!["label"] ?? "Thought" });
      }
      appendTools(index + 1);
    }
    while (publicIndex < thoughts.length) appendPublic(publicIndex++);
  }
  for (const tool of tools) if (!tool.used) result.push(toolBlock(tool.value, sources));
  return result;
}

function projectFragment(input: Readonly<{
  html: string;
  owner: string;
  attachments: readonly JsonObject[];
  diagrams: MistralDiagramPool;
  resources: MistralResourcePool;
  limitations: JsonObject[];
}>): JsonObject[] {
  const fragment = parseFragment(input.html);
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
      // Exporter chrome is already represented by the message's identity and
      // timestamp. Only remove its exact outer slots, never a user's nested
      // time element or an identically named class inside the rich body.
      if (parent === fragment && hasClass(child, "osis-turn-meta")) continue;
      if (isElement(parent) && hasClass(parent, "osis-message") && hasClass(child, "assistant-model")) continue;
      if (hasClass(child, "osis-public-thinking") || hasClass(child, "osis-tool-section") || hasClass(child, "osis-tool-card") || hasClass(child, "osis-sources")) continue;
      if (hasClass(child, "osis-attachments")) {
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
        const source = descendants(child).filter((element) => element.tagName.toLowerCase() === "code").map((element) => textContent(element)).find((value) => value.length > 0);
        const record = input.diagrams.take(source);
        const canonicalSource = sourceText(record?.value["source"]) ?? source;
        const format = sourceText(record?.value["kind"]) ?? "mermaid";
        const rendered = record?.rendered ?? svgDataUrl(child);
        if (canonicalSource || rendered) next.push(defaultTreeAdapter.createTextNode(addBlock({
          type: "diagram", format, ...(canonicalSource ? { source: canonicalSource } : {}), ...(rendered ? { rendered: input.resources.addDiagram(rendered) } : {})
        })));
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
        const width = Number.parseInt(attribute(child, "width") ?? "", 10);
        const height = Number.parseInt(attribute(child, "height") ?? "", 10);
        const image = input.resources.addDomImage(
          input.owner,
          attribute(child, "src"),
          attribute(child, "alt"),
          Number.isSafeInteger(width) && width > 0 ? width : undefined,
          Number.isSafeInteger(height) && height > 0 ? height : undefined
        );
        if (image) {
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
  for (const part of serialized.split(/(\uE000CLOUDIG_MISTRAL_BLOCK_[0-9]+\uE001)/u)) {
    const match = /^\uE000CLOUDIG_MISTRAL_BLOCK_([0-9]+)\uE001$/u.exec(part);
    if (match) {
      const block = blocks[Number.parseInt(match[1]!, 10)];
      if (block) projected.push(block);
      continue;
    }
    const evidence = inertHtmlEvidence(part);
    if (evidence.html) projected.push({ type: "html", html: evidence.html });
  }
  const unplaced = input.attachments.flatMap((attachment, index) => usedAttachments.has(index) ? [] : [input.resources.addAttachment(attachment, input.owner, input.limitations)]);
  for (const record of input.diagrams.remaining()) {
    const source = sourceText(record.value["source"]);
    const format = sourceText(record.value["kind"]) ?? "diagram";
    let rendered = record.rendered;
    if (!rendered && format === "svg" && source?.trimStart().startsWith("<svg")) {
      const inert = inertStandaloneSvg(source);
      if (inert) rendered = `data:image/svg+xml;utf8,${encodeURIComponent(inert)}`;
    }
    if (source || rendered) projected.push({ type: "diagram", format, ...(source ? { source } : {}), ...(rendered ? { rendered: input.resources.addDiagram(rendered) } : {}) });
  }
  return [...unplaced, ...projected];
}

async function parseMistral(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new MistralResourcePool(context.payload, context.reading);
  const sources = new MistralSourcePool();
  const fragments = new Map<string, string[]>();
  for (const fragment of context.reading?.fragments ?? []) {
    const key = readingIdentity(fragment);
    const list = fragments.get(key) ?? [];
    list.push(fragment.html);
    fragments.set(key, list);
  }
  const input = orderedItems(context.payload, profile, limitations);
  const localIds = new Map(input.map((message, index) => [messageIdentity(message), `m${index + 1}`]));
  const models: string[] = [];
  const messageTimes: string[] = [];
  const messages = await mapSequential(input, async (message, index) => {
    const owner = messageIdentity(message);
    const attachments = values(message["attachments"]).map((raw) => {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("Mistral attachment occurrence is not an object");
      return attachment;
    });
    const diagrams = new MistralDiagramPool(message["diagram_sources"], context.reading?.mermaid ?? [], owner);
    const body = (fragments.get(owner) ?? []).flatMap((html) => projectFragment({ html, owner, attachments, diagrams, resources, limitations }));
    if (body.length === 0) {
      const markdown = sourceText(message["content_markdown"]);
      if (markdown) body.push({ type: "markdown", text: markdown });
    }
    const referenceIds = sources.addAll(message["references"]);
    const content = [...processBlocks(message, sources, fragments.get(owner)), ...body, ...(referenceIds.length > 0 ? [{ type: "citations", sources: referenceIds }] : [])];
    const model = sourceText(message["model"]);
    if (model && !models.includes(model)) models.push(model);
    const time = timestamp(message["created_at"]);
    if (time) messageTimes.push(time);
    const role = message["role"] === "user" ? "user" : message["role"] === "assistant" ? "assistant" : message["role"] === "system" ? "system" : "other";
    const parentId = sourceText(message["parent_id"]);
    const parentKey = parentId ? sourceIdentity(parentId, versionText(message["parent_version"])) : undefined;
    const parent = profile === "tree" && parentKey ? localIds.get(parentKey) : undefined;
    const recordParent = profile === "tree" ? parentKey : index > 0 ? messageIdentity(input[index - 1]!) : undefined;
    context.record?.message(index, { id: owner, ...(recordParent ? { parent: recordParent } : {}), role, ...(model ? { model } : {}) });
    await context.onProgress?.(index + 1, input.length);
    return {
      ...(profile === "tree" ? { id: `m${index + 1}`, ...(parent ? { parent } : {}) } : {}),
      role,
      ...(role === "other" ? { name: sourceText(message["role"]) ?? "Mistral" } : {}),
      ...(model ? { model } : {}),
      ...(time ? { timestamp: time } : {}),
      content
    };
  });
  messageTimes.sort();
  const manifestSource = object(context.manifest["source"]);
  const exporter = object(context.manifest["exporter"]);
  const capturedAt = timestamp(context.manifest["exported_at"] ?? context.manifest["captured_at"]) ?? context.source.fileSystemCapturedAt;
  const sourceUrl = httpUrl(manifestSource?.["url"]);
  const title = sourceText(manifestSource?.["title"]);
  const conversationKey = sourceText(manifestSource?.["conversation_id"]);
  const exporterVersion = sourceText(exporter?.["version"] ?? context.manifest["exporter_version"] ?? context.payload["version"]);
  const currentRaw = profile === "tree"
    ? sourceText(context.payload["current_leaf_message_key"])
      ?? values(context.payload["active_message_keys"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []).at(-1)
    : undefined;
  const currentMessage = currentRaw ? localIds.get(currentRaw) : undefined;
  return {
    source: {
      file: context.source.file, sha256: context.source.sha256, bytes: context.source.bytes, format: "exporter-html",
      payload: payloadName.replaceAll("/", "."), profile,
      ...(exporterVersion ? { exporter: { id: "mistral-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "mistral", platform: "mistral", ...(title ? { title } : {}), ...(models.length > 0 ? { models } : {}),
    ...(messageTimes.length > 0 ? { message_time: { start: messageTimes[0]!, ...(messageTimes.at(-1) !== messageTimes[0] ? { end: messageTimes.at(-1)! } : {}) } } : {}),
    ...(currentMessage ? { current_message: currentMessage } : {}), messages,
    ...(resources.values.length > 0 ? { resources: resources.values } : {}),
    ...(sources.values.length > 0 ? { sources: sources.values } : {}),
    ...(limitations.length > 0 ? { limitations: [...new Set(limitations.map((entry) => canonicalizeJcs(entry)))].map((entry) => JSON.parse(entry) as JsonObject) } : {})
  };
}

function manifest(id: string, payload: string, profile: Profile): AdapterManifest {
  return { id, version: "3.0.6", family: "mistral", routes: [{ format: "exporter-html", platform: "mistral", payload, profile }], target: "cloudig/conversation/1.0.0", update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5"].map(version => ({ adapter: id, version, action: "reparse_source" as const })) };
}

export const MISTRAL_LIGHT_MANIFEST = manifest("mistral-light-dom-rsc-v2", "osis.mistral.chat-export/light-dom-rsc-v2", "light");
export const MISTRAL_FULL_MANIFEST = manifest("mistral-full-v1", "osis.mistral.chat-export/full-v1", "full");
export const MISTRAL_TREE_MANIFEST = manifest("mistral-all-branches-v1", "osis.mistral.chat-export/all-branches-v1", "tree");

export const mistralLightAdapter: SourceAdapter = Object.freeze({ manifest: MISTRAL_LIGHT_MANIFEST, parse: (context) => parseMistral(context, "light", "osis.mistral.chat-export/light-dom-rsc-v2") });
export const mistralFullAdapter: SourceAdapter = Object.freeze({ manifest: MISTRAL_FULL_MANIFEST, parse: (context) => parseMistral(context, "full", "osis.mistral.chat-export/full-v1") });
export const mistralTreeAdapter: SourceAdapter = Object.freeze({ manifest: MISTRAL_TREE_MANIFEST, parse: (context) => parseMistral(context, "tree", "osis.mistral.chat-export/all-branches-v1") });
