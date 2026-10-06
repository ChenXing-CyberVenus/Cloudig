import { mapSequential, type AdapterManifest, type AdapterParseContext, type SourceAdapter } from "../../app/parser/adapter.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { capturedPanelWithMermaid, capturedTextPanel, inertHtmlEvidence, restoreCapturedProcess } from "./inert-html.mts";
import { normalizeMermaidSource, projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";
import { capturedReferences } from "./captured-references.mts";

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

function positiveNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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


function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function responseId(value: string): string {
  return value.replace(/^response-/u, "");
}

function sameOwner(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && responseId(left) === responseId(right));
}

function normalizedLabel(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en-US");
}

function imageLike(value: JsonObject): boolean {
  const mime = sourceText(value["mime_type"] ?? value["mime"])?.toLowerCase();
  const kind = sourceText(value["kind"])?.toLowerCase();
  return value["is_image"] === true || mime?.startsWith("image/") === true || kind?.includes("image") === true;
}

function resourceKey(value: JsonObject): string | undefined {
  return sourceText(value["resource_key"] ?? value["key"] ?? value["id"]);
}

function sourceReference(value: JsonObject): string | undefined {
  return sourceText(value["source_reference"] ?? value["resolved_source_reference"] ?? value["source"]);
}

class MermaidPool {
  readonly #records: Array<{ record: MermaidRecord; used: boolean }>;

  constructor(records: readonly MermaidRecord[]) {
    this.#records = records.map((record) => ({ record, used: false }));
  }

  take(owners: readonly string[], source: string): MermaidRecord | undefined {
    const normalized = normalizeMermaidSource(source);
    const found = this.#records.find((entry) => !entry.used
      && owners.some((owner) => sameOwner(owner, entry.record.messageId))
      && normalizeMermaidSource(entry.record.source) === normalized);
    if (!found) return undefined;
    found.used = true;
    return found.record;
  }

  takeRemaining(owners: readonly string[]): MermaidRecord[] {
    const result: MermaidRecord[] = [];
    for (const entry of this.#records) {
      if (entry.used || !owners.some((owner) => sameOwner(owner, entry.record.messageId))) continue;
      entry.used = true;
      result.push(entry.record);
    }
    return result;
  }

  remaining(): MermaidRecord[] {
    return this.#records.filter((entry) => !entry.used).map((entry) => entry.record);
  }
}

class GrokResourcePool {
  readonly values: JsonObject[] = [];
  readonly #raw: Array<{ value: JsonObject; used: boolean }>;
  readonly #reading: Array<{ value: ReadingImage; used: boolean }>;
  readonly #byResource = new Map<string, string>();

  constructor(payload: JsonObject, reading: readonly ReadingImage[]) {
    const rawValues = values(payload["resources"]).length > 0 ? values(payload["resources"]) : values(payload["images"]);
    this.#raw = rawValues.map((value) => {
      const item = object(value);
      if (!item) throw new TypeError("Grok resource registry contains a non-object entry");
      return { value: item, used: false };
    });
    this.#reading = reading.map((value) => ({ value, used: false }));
  }

  #allocate(key: string, resource: Omit<JsonObject, "id">): string {
    const existing = this.#byResource.get(key);
    if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...resource });
    this.#byResource.set(key, id);
    return id;
  }

  #resolveRaw(occurrence: JsonObject): { value: JsonObject; used: boolean } | undefined {
    const key = resourceKey(occurrence);
    if (key) {
      const exact = this.#raw.find((entry) => resourceKey(entry.value) === key);
      if (exact) return exact;
    }
    const reference = sourceReference(occurrence);
    if (reference) {
      const exact = this.#raw.find((entry) => sourceReference(entry.value) === reference);
      if (exact) return exact;
    }
    return undefined;
  }

  #readingScore(image: ReadingImage, raw: JsonObject): number {
    const key = resourceKey(raw);
    if (key && image.resourceKey) return key === image.resourceKey ? 200 : -1;
    let score = 0;
    const dataUrl = sourceText(raw["data_url"]);
    if (dataUrl) return dataUrl === image.dataUrl ? 100 : -1;
    const label = normalizedLabel(sourceText(raw["alt"] ?? raw["name"]));
    if (label && image.alt && label !== normalizedLabel(image.alt)) return -1;
    if (label && label === normalizedLabel(image.alt)) score += 20;
    const width = nonNegativeInteger(raw["width"] ?? raw["displayed_width"]);
    const height = nonNegativeInteger(raw["height"] ?? raw["displayed_height"]);
    if (width && height && width === image.width && height === image.height) score += 10;
    return score;
  }

  #takeReading(owner: string, raw?: JsonObject): ReadingImage | undefined {
    if (raw && /missing|unavailable|failed|omitted/iu.test(sourceText(raw["availability"]) ?? "")) return undefined;
    const candidates = this.#reading.filter((entry) => !entry.used && sameOwner(owner, entry.value.messageId)
      && (!raw || this.#readingScore(entry.value, raw) >= 0));
    if (candidates.length === 0) return undefined;
    if (raw) {
      const ranked = candidates
        .map((entry) => ({ entry, score: this.#readingScore(entry.value, raw) }))
        .sort((left, right) => right.score - left.score);
      if (ranked[0]!.score > 0 && (ranked.length === 1 || ranked[0]!.score > ranked[1]!.score)) {
        ranked[0]!.entry.used = true;
        return ranked[0]!.entry.value;
      }
    }
    if (candidates.length === 1) {
      candidates[0]!.used = true;
      return candidates[0]!.value;
    }
    return undefined;
  }

  #rawForReading(image: ReadingImage): { value: JsonObject; used: boolean } | undefined {
    const candidates = this.#raw
      .filter((entry) => !entry.used && imageLike(entry.value))
      .filter((entry) => {
        const owner = sourceText(entry.value["source_response_id"]);
        return !owner || sameOwner(owner, image.messageId);
      })
      .map((entry) => ({ entry, score: this.#readingScore(image, entry.value) }))
      .sort((left, right) => right.score - left.score);
    if (candidates.length === 0 || candidates[0]!.score <= 0) return undefined;
    if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return undefined;
    return candidates[0]!.entry;
  }

  #create(raw: JsonObject, limitations: JsonObject[]): string {
    const isImage = imageLike(raw);
    const rawKind = sourceText(raw["kind"])?.toLowerCase();
    const kind = isImage ? "image" : rawKind === "audio" ? "audio" : rawKind === "video" ? "video" : "file";
    const name = sourceText(raw["name"] ?? raw["alt"]);
    const declaredMime = sourceText(raw["mime_type"] ?? raw["mime"])?.toLowerCase();
    const originalMime = sourceText(raw["original_mime"])?.toLowerCase();
    const dataUrl = sourceText(raw["data_url"]);
    if (dataUrl?.startsWith("data:")) {
      const embedded = isImage ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      if (declaredMime && declaredMime !== embedded.mime) throw new TypeError("Grok resource MIME metadata disagrees with embedded bytes");
      const embeddedSize = nonNegativeInteger(raw["embedded_size"] ?? raw["thumbnail_size"]);
      if (embeddedSize !== undefined && embeddedSize !== embedded.byteLength) {
        throw new TypeError("Grok resource embedded size disagrees with its bytes");
      }
      const sha256 = embedded.sha256;
      const declaredHash = sourceText(raw["sha256"])?.toLowerCase();
      if (declaredHash && declaredHash !== sha256) throw new TypeError("Grok resource hash disagrees with embedded bytes");
      const width = nonNegativeInteger(raw["width"] ?? raw["displayed_width"]);
      const height = nonNegativeInteger(raw["height"] ?? raw["displayed_height"]);
      const originalBytes = nonNegativeInteger(raw["source_size"]);
      return this.#allocate(`${kind}\u0000${name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
        kind,
        availability: "embedded",
        ...(name ? { name } : {}),
        mime: embedded.mime,
        ...(originalMime && originalMime !== embedded.mime ? { original_mime: originalMime } : {}),
        bytes: embedded.byteLength,
        sha256,
        ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
        ...(width && height ? { dimensions: { width, height } } : {}),
        ...(originalBytes !== undefined ? { original_bytes: originalBytes } : {})
      });
    }
    const url = httpUrl(raw["resolved_source_reference"] ?? raw["source_reference"] ?? raw["source"]);
    const bytes = nonNegativeInteger(raw["source_size"] ?? raw["bytes"]);
    const unavailable = Boolean(sourceText(raw["error"]))
      || /(?:missing|unavailable|failed|omitted)/iu.test(sourceText(raw["availability"]) ?? "");
    const availability = url ? "external" : unavailable ? "missing" : "metadata_only";
    const id = this.#allocate(canonicalizeJcs({ kind, name: name ?? "", mime: declaredMime ?? "", bytes: bytes ?? -1, url: url ?? "", availability }), {
      kind,
      availability,
      ...(name ? { name } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(url ? { url } : {})
    });
    if (availability === "missing") {
      const at = this.values.findIndex((entry) => entry["id"] === id);
      limitations.push({ code: "grok_resource_unavailable", ...(at >= 0 ? { at: `/resources/${at}` } : {}) });
    }
    return id;
  }

  addOccurrence(raw: JsonObject, owner: string, limitations: JsonObject[]): JsonObject {
    const central = this.#resolveRaw(raw);
    const merged: JsonObject = central ? { ...central.value, ...raw } : { ...raw };
    if (central) {
      central.used = true;
      const centralData = sourceText(central.value["data_url"]);
      if (centralData) {
        const occurrenceMime = sourceText(raw["mime_type"] ?? raw["mime"])?.toLowerCase();
        const centralMime = sourceText(central.value["mime_type"] ?? central.value["mime"])?.toLowerCase();
        merged["data_url"] = centralData;
        if (occurrenceMime && centralMime && occurrenceMime !== centralMime) merged["original_mime"] = occurrenceMime;
        if (centralMime) merged["mime_type"] = centralMime;
      }
    }
    if (imageLike(merged)) {
      const reading = this.#takeReading(owner, merged);
      if (reading) {
        merged["data_url"] = reading.dataUrl;
        if (!merged["alt"] && reading.alt) merged["alt"] = reading.alt;
        if (!merged["width"] && reading.width) merged["width"] = reading.width;
        if (!merged["height"] && reading.height) merged["height"] = reading.height;
      }
    }
    const resource = this.#create(merged, limitations);
    return imageLike(merged) ? { type: "image", resource } : { type: "attachment", resource };
  }

  addRemainingImages(owner: string, limitations: JsonObject[]): JsonObject[] {
    const result: JsonObject[] = [];
    for (const reading of this.#reading) {
      if (reading.used || !sameOwner(owner, reading.value.messageId)) continue;
      reading.used = true;
      const central = this.#rawForReading(reading.value);
      if (central) central.used = true;
      const merged: JsonObject = {
        ...(central?.value ?? {}),
        data_url: reading.value.dataUrl,
        ...(reading.value.alt ? { alt: reading.value.alt } : {}),
        ...(reading.value.width ? { width: reading.value.width } : {}),
        ...(reading.value.height ? { height: reading.value.height } : {}),
        is_image: true
      };
      result.push({ type: "image", resource: this.#create(merged, limitations), ...(reading.value.alt ? { alt: reading.value.alt } : {}) });
    }
    return result;
  }

  addUnclaimedForOwner(owner: string, limitations: JsonObject[]): JsonObject[] {
    const result: JsonObject[] = [];
    for (const entry of this.#raw) {
      if (entry.used || !sameOwner(sourceText(entry.value["source_response_id"]), owner)) continue;
      entry.used = true;
      const resource = this.#create(entry.value, limitations);
      result.push(imageLike(entry.value) ? { type: "image", resource } : { type: "attachment", resource });
    }
    return result;
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

  unownedCount(): number {
    return this.#raw.filter((entry) => !entry.used).length + this.#reading.filter((entry) => !entry.used).length;
  }
}

class GrokSourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();

  add(raw: JsonObject): string | undefined {
    let url = httpUrl(raw["url"] ?? raw["link"] ?? raw["href"]);
    if (!url) {
      const username = sourceText(raw["username"]);
      const postId = sourceText(raw["postId"] ?? raw["post_id"]);
      if (username && postId) url = `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(postId)}`;
    }
    if (!url) return undefined;
    const title = sourceText(raw["title"] ?? raw["name"] ?? raw["text"]);
    const snippet = sourceText(raw["snippet"] ?? raw["description"]);
    const hostname = sourceText(raw["hostname"]);
    const key = `${url}\u0000${title ?? ""}\u0000${snippet ?? ""}`;
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `s${this.values.length + 1}`;
    this.values.push({ id, kind: "web", url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(hostname ? { name: hostname } : {}) });
    this.#byKey.set(key, id);
    return id;
  }

  addAll(raw: JsonValue | undefined): string[] {
    return unique(values(raw).flatMap((value) => {
      const item = object(value);
      const id = item ? this.add(item) : undefined;
      return id ? [id] : [];
    }));
  }

  addStepResults(step: JsonObject): string[] {
    const ids: string[] = [];
    for (const field of ["webSearchResults", "ragResults", "connectorSearchResults", "collectionSearchResults", "xposts"] as const) {
      ids.push(...this.addAll(step[field]));
    }
    return unique(ids);
  }
}

function toolField(value: JsonObject): string | undefined {
  return Object.keys(value).find((key) => key !== "toolUsageCardId");
}

function toolCallIds(steps: readonly JsonObject[], allocate: () => string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const step of steps) {
    for (const raw of values(step["toolUsageCards"])) {
      const card = object(raw);
      const vendor = sourceText(card?.["toolUsageCardId"]);
      if (vendor && !ids.has(vendor)) ids.set(vendor, allocate());
    }
  }
  return ids;
}

function resultCallIds(steps: readonly JsonObject[]): Set<string> {
  const result = new Set<string>();
  for (const step of steps) {
    for (const raw of values(step["toolUsageResults"])) {
      const item = object(raw);
      const vendor = sourceText(item?.["toolUsageCardId"]);
      if (vendor) result.add(vendor);
    }
  }
  return result;
}

function queryFromValue(value: JsonValue | undefined, depth = 0): string | undefined {
  if (depth > 6 || value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const query = queryFromValue(item, depth + 1);
      if (query) return query;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  const direct = sourceText(value["query"] ?? value["searchQuery"] ?? value["search_query"]);
  if (direct) return direct;
  for (const item of Object.values(value)) {
    const query = queryFromValue(item, depth + 1);
    if (query) return query;
  }
  return undefined;
}

function readableStepValue(value: JsonValue | undefined, depth = 0): string | undefined {
  if (depth > 8 || value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.flatMap((item) => {
      const part = readableStepValue(item, depth + 1);
      return part ? [part] : [];
    }).join("\n");
    return text.length > 0 ? text : undefined;
  }
  for (const key of ["text", "content", "title", "name", "query", "description", "label"] as const) {
    const preferred = readableStepValue(value[key], depth + 1);
    if (preferred) return preferred;
  }
  const text = JSON.stringify(value, null, 2);
  return text.length > 0 ? text : undefined;
}

function thoughtMetadata(message: JsonObject): Readonly<{ title?: string; duration?: number }> {
  for (const raw of values(message["thoughts"])) {
    const thought = object(raw);
    if (!thought || thought["body_available"] !== true) continue;
    const title = sourceText(thought["label"]);
    const duration = positiveNumber(thought["duration_seconds"]);
    return { ...(title ? { title } : {}), ...(duration !== undefined ? { duration } : {}) };
  }
  return {};
}

function aggregateThoughtBlocks(message: JsonObject): JsonObject[] {
  return values(message["thoughts"]).flatMap((raw) => {
    const thought = object(raw);
    if (!thought || thought["body_available"] !== true) return [];
    const text = sourceText(thought["text"]);
    const title = sourceText(thought["label"]);
    const duration = positiveNumber(thought["duration_seconds"]);
    return text || title ? [{
      type: "reasoning",
      ...(text ? { text, format: "markdown" } : {}),
      ...(title ? { title } : {}),
      ...(duration !== undefined ? { duration } : {})
    }] : [];
  });
}

function apiStepBlocks(response: JsonObject, message: JsonObject, sources: GrokSourcePool, allocateCall: () => string): JsonObject[] {
  const steps = values(response["steps"]).map((raw) => {
    const step = object(raw);
    if (!step) throw new TypeError("Grok response step is not an object");
    return step;
  });
  if (steps.length === 0) return aggregateThoughtBlocks(message);
  const calls = toolCallIds(steps, allocateCall);
  const linked = resultCallIds(steps);
  const thought = thoughtMetadata(message);
  const result: JsonObject[] = [];
  let firstReasoning = true;
  for (const step of steps) {
    const text = readableStepValue(step["text"]);
    const consumed = new Set<JsonValue>();
    const reasoning = (text: string | undefined) => { if (text?.trim()) {
      result.push({
        type: "reasoning",
        text: text.trim(),
        format: "markdown",
        ...(firstReasoning && thought.title ? { title: thought.title } : {}),
        ...(firstReasoning && thought.duration !== undefined ? { duration: thought.duration } : {})
      });
      firstReasoning = false;
    } };
    // This exact wrapper is source step metadata, not arbitrary answer HTML.
    // Preserve each public tool card in place, with its original argument text
    // and complete matching API records. Never pair tools across step/message.
    let offset = 0;
    if (text) for (const match of text.matchAll(/<xai:tool_usage_card>([\s\S]*?)<\/xai:tool_usage_card>/giu)) {
      reasoning(text.slice(offset, match.index));
      const xml = match[1]!;
      const field = (name: string): string => new RegExp(`<xai:${name}>([\\s\\S]*?)</xai:${name}>`, "iu").exec(xml)?.[1]?.trim() ?? "";
      const id = field("tool_usage_card_id"), name = field("tool_name"), rawArgs = field("tool_args");
      if (id && !calls.has(id)) calls.set(id, allocateCall());
      const args = rawArgs.startsWith("<![CDATA[") && rawArgs.endsWith("]]>") ? rawArgs.slice(9, -3) : rawArgs;
      const records = [...values(step["toolUsageResults"]), ...values(step["toolUsageCards"])].filter(raw => id && object(raw)?.["toolUsageCardId"] === id);
      records.forEach(raw => consumed.add(raw));
      const remainder = xml.replace(/<xai:(tool_usage_card_id|tool_name|tool_args)>[\s\S]*?<\/xai:\1>/giu, "").trim();
      result.push({ type: "tool", kind: "activity", ...(id ? { call: calls.get(id)! } : {}), ...(name ? { name } : {}),
        ...(remainder ? { input: { arguments: args, source_xml: xml } } : args ? { input: args } : {}),
        ...(records.length ? { output: records } : {}) });
      offset = match.index! + match[0].length;
    }
    reasoning(text?.slice(offset));
    for (const raw of values(step["toolUsageResults"])) {
      if (consumed.has(raw)) continue;
      const item = object(raw);
      if (!item) throw new TypeError("Grok tool result is not an object");
      const vendor = sourceText(item["toolUsageCardId"]);
      const name = toolField(item);
      const output = name ? item[name] : undefined;
      result.push({
        type: "tool",
        kind: "result",
        ...(vendor && calls.has(vendor) ? { call: calls.get(vendor)! } : {}),
        ...(name ? { name } : {}),
        ...(output !== undefined ? { output } : {})
      });
    }
    for (const raw of values(step["toolUsageCards"])) {
      if (consumed.has(raw)) continue;
      const card = object(raw);
      if (!card) throw new TypeError("Grok tool card is not an object");
      const vendor = sourceText(card["toolUsageCardId"]);
      const name = toolField(card);
      const input = name ? card[name] : undefined;
      result.push({
        type: "tool",
        kind: "call",
        ...(vendor && linked.has(vendor) && calls.has(vendor) ? { call: calls.get(vendor)! } : {}),
        ...(name ? { name } : {}),
        ...(input !== undefined ? { input } : {})
      });
    }
    const stepSources = sources.addStepResults(step);
    if (stepSources.length > 0) {
      const query = values(step["toolUsageCards"]).map((raw) => queryFromValue(raw)).find((value) => value !== undefined);
      result.push({ type: "search", ...(query ? { query } : {}), sources: stepSources });
    }
  }
  return result.length > 0 ? result : aggregateThoughtBlocks(message);
}

function projectBody(
  message: JsonObject,
  owners: readonly string[],
  mermaid: MermaidPool,
  resources: GrokResourcePool,
  captured?: readonly JsonObject[]
): Readonly<{ blocks: JsonObject[]; links: readonly string[] }> {
  if (captured) return { blocks: [...captured], links: captured.flatMap(block => typeof block["html"] === "string" ? inertHtmlEvidence(block["html"]).links : []) };
  const raw = sourceText(message["raw_message"]) ?? sourceText(message["text"]);
  if (!raw) return { blocks: [], links: [] };
  const vendorMarkdown = /^\s*<grok:render\b/iu.test(raw);
  if (/^\s*</u.test(raw) && !vendorMarkdown) {
    const evidence = inertHtmlEvidence(raw);
    return { blocks: evidence.html ? [{ type: "html", html: evidence.html }] : [{ type: "text", text: raw }], links: evidence.links };
  }
  // Leading image API commands are not an HTML document. Their pictures
  // already travel through the occurrence-aware pool; the rest is Markdown.
  // Remove only known leading commands, never examples inside code fences.
  let markdown = raw;
  if (vendorMarkdown) {
    for (;;) {
      const prefix = /^\s*<grok:render\b([^>]*)>[\s\S]*?<\/grok:render>\s*/iu.exec(markdown);
      if (!prefix || !/\bcard_type=["']image_card["']/iu.test(prefix[1]!) || !/\btype=["']render_searched_image["']/iu.test(prefix[1]!)) break;
      markdown = markdown.slice(prefix[0].length);
    }
  }
  return {
    blocks: projectMarkdownWithDiagrams(markdown, (source) => {
      const evidence = mermaid.take(owners, source);
      return evidence ? resources.addDiagram(evidence.dataUrl) : undefined;
    }),
    links: []
  };
}

function responseMap(payload: JsonObject): ReadonlyMap<string, JsonObject> {
  const rawApi = object(payload["raw_api"]);
  const result = new Map<string, JsonObject>();
  for (const raw of values(rawApi?.["responses"])) {
    const response = object(raw);
    const id = sourceText(response?.["responseId"]);
    if (!response || !id || result.has(id)) throw new TypeError("Grok raw response identity is missing or duplicated");
    result.set(id, response);
  }
  return result;
}

function orderedTreeItems(items: readonly JsonObject[], limitations: JsonObject[]): JsonObject[] {
  const byId = new Map<string, JsonObject>();
  const sourceOrder = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const id = sourceText(item["response_id"]);
    if (!id || byId.has(id)) throw new TypeError("Grok Tree response identity is missing or duplicated");
    byId.set(id, item);
    sourceOrder.set(id, index);
  }
  const roots: string[] = [];
  const children = new Map<string, string[]>();
  for (const item of items) {
    const id = sourceText(item["response_id"])!;
    const parent = sourceText(item["parent_response_id"]);
    if (!parent || !byId.has(parent)) {
      roots.push(id);
      if (parent) limitations.push({ code: "source_parent_omitted", detail: "A Grok Tree response referenced a parent omitted by the source payload" });
    } else {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
  }
  for (const list of children.values()) list.sort((left, right) => sourceOrder.get(left)! - sourceOrder.get(right)!);
  roots.sort((left, right) => sourceOrder.get(left)! - sourceOrder.get(right)!);
  const result: JsonObject[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new TypeError("Grok Tree contains a cycle");
    if (visited.has(id)) return;
    active.add(id);
    visited.add(id);
    result.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) visit(child);
    active.delete(id);
  };
  for (const root of roots) visit(root);
  if (result.length !== items.length) throw new TypeError("Grok Tree has no complete parent-first traversal");
  return result;
}

async function parseGrok(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const resources = new GrokResourcePool(context.payload, context.reading?.images ?? []);
  const sources = new GrokSourcePool();
  const mermaid = new MermaidPool(context.reading?.mermaid ?? []);
  const reading = new Map((context.reading?.fragments ?? []).map(fragment => [fragment.messageId, fragment.html]));
  const responses = responseMap(context.payload);
  const rawItems = values(profile === "tree" ? context.payload["nodes"] : context.payload["messages"]).map((raw) => {
    const item = object(raw);
    if (!item) throw new TypeError("Grok message sequence contains a non-object entry");
    return item;
  });
  const items = profile === "tree" ? orderedTreeItems(rawItems, limitations) : rawItems;
  const localIds = new Map(items.flatMap((item, index) => {
    const id = sourceText(item["response_id"]);
    return id ? [[id, `m${index + 1}`] as const] : [];
  }));
  const models: string[] = [];
  // Vendor pairing is message-local, but the resulting call IDs live in one
  // Conversation. Restarting x1 in every message changes later tool identities.
  let callSequence = 0;
  const allocateCall = () => `x${++callSequence}`;
  const messages = await mapSequential(items, async (item, index) => {
    const sourceId = sourceText(item["source_id"]);
    const rawResponseId = sourceText(item["response_id"]) ?? (sourceId ? responseId(sourceId) : undefined);
    const owners = unique([sourceId, rawResponseId].filter((value): value is string => value !== undefined));
    const owner = sourceId ?? (rawResponseId ? `response-${rawResponseId}` : `grok-message-${index}`);
    const response = rawResponseId ? responses.get(rawResponseId) : undefined;
    const messageSourceIds = sources.addAll(item["sources"]);
    const rawProcess = item["role"] === "assistant"
      ? response
        ? apiStepBlocks(response, item, sources, allocateCall)
        : values(item["thoughts"]).some((value) => object(value)?.["tags"] !== undefined)
          ? apiStepBlocks({ steps: item["thoughts"]! }, item, sources, allocateCall)
          : aggregateThoughtBlocks(item)
      : [];
    const process = restoreCapturedProcess(rawProcess, reading.get(owner) ?? "", "thinking");
    const attachments = values(item["attachments"]).map((raw) => {
      const attachment = object(raw);
      if (!attachment) throw new TypeError("Grok attachment occurrence is not an object");
      return resources.addOccurrence(attachment, owner, limitations);
    });
    const panelClass = item["role"] === "user" ? "user-bubble" : "assistant-content";
    const excluded = item["role"] === "user" ? [] : ["thinking", "answer-sources", "assistant-model"];
    const textPanel = capturedTextPanel(reading.get(owner), panelClass, undefined, excluded);
    const captured: readonly JsonObject[] | undefined = textPanel ? [{ type: "html", html: textPanel }]
      : capturedPanelWithMermaid(reading.get(owner), panelClass, excluded)?.map(part => {
        if ("html" in part) return { type: "html", html: part.html };
        const record = mermaid.take(owners, part.mermaid);
        return { type: "diagram", format: "mermaid", source: part.mermaid, ...(record ? { rendered: resources.addDiagram(record.dataUrl) } : {}) };
      });
    const body = projectBody(item, owners, mermaid, resources, captured);
    messageSourceIds.push(...sources.addAll(capturedReferences(reading.get(owner) ?? "", "grok-image").filter(source => !body.links.includes(String(source["url"])))));
    const remainingImages = resources.addRemainingImages(owner, limitations);
    const unclaimed = resources.addUnclaimedForOwner(owner, limitations);
    const content = item["role"] === "user"
      ? [...attachments, ...remainingImages, ...unclaimed, ...body.blocks]
      : [...process, ...body.blocks, ...attachments, ...remainingImages, ...unclaimed];
    for (const record of mermaid.takeRemaining(owners)) {
      content.push({ type: "diagram", format: "mermaid", rendered: resources.addDiagram(record.dataUrl) });
    }
    const allSourceIds = unique([
      ...messageSourceIds,
      ...content.flatMap((block) => Array.isArray(block["sources"]) ? block["sources"].filter((value): value is string => typeof value === "string") : [])
    ]);
    if (allSourceIds.length > 0) content.push({ type: "citations", sources: allSourceIds });
    const model = sourceText(item["model"] ?? response?.["model"]);
    if (model && !models.includes(model)) models.push(model);
    const role = item["role"] === "user" ? "user" : item["role"] === "assistant" ? "assistant" : "other";
    const parentRaw = sourceText(item["parent_response_id"]);
    const parent = profile === "tree" && parentRaw ? localIds.get(parentRaw) : undefined;
    const recordId = rawResponseId ?? owner;
    const previous = index > 0 ? items[index - 1]! : undefined;
    const previousId = sourceText(previous?.["response_id"]) ?? (sourceText(previous?.["source_id"]) ? responseId(sourceText(previous?.["source_id"])!) ?? sourceText(previous?.["source_id"]) : undefined) ?? `grok-message-${index - 1}`;
    const recordParent = profile === "tree" ? parentRaw : index > 0 ? previousId : undefined;
    context.record?.message(index, { id: recordId, ...(recordParent ? { parent: recordParent } : {}), role, ...(model ? { model } : {}) });
    const message: JsonObject = {
      ...(profile === "tree" ? { id: `m${index + 1}`, ...(parent ? { parent } : {}) } : {}),
      role,
      ...(role === "other" ? { name: sourceText(item["role"]) ?? "Grok" } : {}),
      ...(model ? { model } : {}),
      ...(timestamp(item["create_time"] ?? response?.["createTime"]) ? { timestamp: timestamp(item["create_time"] ?? response?.["createTime"])! } : {}),
      content
    };
    await context.onProgress?.(index + 1, items.length);
    return message;
  });
  const orphanedMermaid = mermaid.remaining();
  if (orphanedMermaid.length > 0) {
    limitations.push({ code: "grok_unowned_mermaid_preview", detail: `${orphanedMermaid.length} Mermaid preview(s) lacked a message owner` });
  }
  const unownedResources = resources.unownedCount();
  if (unownedResources > 0) {
    limitations.push({ code: "grok_unowned_resource", detail: `${unownedResources} captured resource record(s) lacked a provable message position` });
  }
  const artifacts = values(context.payload["artifacts"]);
  if (artifacts.length > 0) {
    limitations.push({ code: "grok_unowned_artifact_metadata", detail: `${artifacts.length} artifact record(s) lacked a provable message owner` });
  }
  const unknown = values(context.payload["unknown_visible_components"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []);
  if (unknown.length > 0) {
    limitations.push({ code: "grok_unknown_visible_component", detail: unique(unknown).slice(0, 16).join(", ") });
  }
  const messageTimes = messages.flatMap((message) => typeof message["timestamp"] === "string" ? [message["timestamp"] as string] : []).sort();
  const capturedAt = timestamp(context.manifest["captured_at"] ?? context.manifest["exported_at"])
    ?? timestamp(context.payload["exported_at"])
    ?? context.source.fileSystemCapturedAt;
  const sourceUrl = httpUrl(context.manifest["source_url"] ?? context.payload["source_url"]);
  const title = sourceText(context.payload["title"] ?? context.manifest["title"]);
  const exporterObject = object(context.manifest["exporter"]);
  const exporterVersion = sourceText(context.manifest["exporter_version"] ?? exporterObject?.["version"] ?? context.payload["exporter_version"]);
  const conversationKey = sourceText(context.manifest["conversation_id"] ?? context.payload["conversation_id"]);
  const currentRaw = profile === "tree"
    ? values(context.payload["current_path_response_ids"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []).at(-1)
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
      ...(exporterVersion ? { exporter: { id: "grok-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "xai",
    platform: "grok",
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
    version: "3.0.7",
    family: "grok",
    routes: [{ format: "exporter-html", platform: "grok", payload, profile }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "2.0.3", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const GROK_LIGHT_MANIFEST = manifest("grok-light-dom-v2", "osis.grok.chat-export/light-dom-v2", "light");
export const GROK_FULL_MANIFEST = manifest("grok-full-v1", "osis.grok.chat-export/full-v1", "full");
export const GROK_TREE_MANIFEST = manifest("grok-all-branches-v1", "osis.grok.chat-export/all-branches-v1", "tree");

export const grokLightAdapter: SourceAdapter = Object.freeze({ manifest: GROK_LIGHT_MANIFEST, parse: (context) => parseGrok(context, "light", "osis.grok.chat-export/light-dom-v2") });
export const grokFullAdapter: SourceAdapter = Object.freeze({ manifest: GROK_FULL_MANIFEST, parse: (context) => parseGrok(context, "full", "osis.grok.chat-export/full-v1") });
export const grokTreeAdapter: SourceAdapter = Object.freeze({ manifest: GROK_TREE_MANIFEST, parse: (context) => parseGrok(context, "tree", "osis.grok.chat-export/all-branches-v1") });
