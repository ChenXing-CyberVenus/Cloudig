import { mapSequential, type AdapterManifest, type AdapterParseContext, type SourceAdapter } from "../../app/parser/adapter.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { normalizeMermaidSource, projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";
import { capturedTextPanel, restoreCapturedProcess } from "./inert-html.mts";

type Profile = "light" | "full" | "tree";
type MermaidRecord = Readonly<{ messageId: string; source: string; dataUrl: string }>;

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


class MermaidPool {
  readonly #records: Array<{ record: MermaidRecord; used: boolean }>;

  constructor(records: readonly MermaidRecord[]) {
    this.#records = records.map((record) => ({ record, used: false }));
  }

  take(owners: readonly string[], source: string): MermaidRecord | undefined {
    const normalized = normalizeMermaidSource(source);
    const found = this.#records.find((entry) => !entry.used
      && owners.includes(entry.record.messageId)
      && normalizeMermaidSource(entry.record.source) === normalized);
    if (!found) return undefined;
    found.used = true;
    return found.record;
  }

  remaining(): readonly MermaidRecord[] {
    return this.#records.filter((entry) => !entry.used).map((entry) => entry.record);
  }
}

class DeepSeekResourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();
  readonly #source = new Map<string, JsonObject>();

  constructor(payload: JsonObject) {
    for (const raw of values(payload["resources"])) {
      const resource = object(raw);
      const key = sourceText(resource?.["resource_key"] ?? resource?.["file_key"] ?? resource?.["id"]);
      if (!resource || !key || this.#source.has(key)) throw new TypeError("DeepSeek resource registry is malformed");
      this.#source.set(key, resource);
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

  add(raw: JsonObject, limitations: JsonObject[]): JsonObject {
    const key = sourceText(raw["resource_key"] ?? raw["file_key"] ?? raw["id"]);
    const source = key ? this.#source.get(key) : undefined;
    const sourceData = sourceText(source?.["data_url"]);
    const resolved: JsonObject = source ? { ...source, ...raw, ...(sourceData?.startsWith("data:") ? { data_url: sourceData } : {}) } : raw;
    const declaredMime = sourceText(resolved["mime_type"])?.toLowerCase();
    const isImage = resolved["is_image"] === true || declaredMime?.startsWith("image/") === true;
    const kind = isImage ? "image" : "file";
    const dataUrl = sourceText(resolved["data_url"]);
    let resource: string;
    if (dataUrl?.startsWith("data:")) {
      const embedded = isImage ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      if (declaredMime && declaredMime !== embedded.mime) throw new TypeError("DeepSeek resource MIME metadata disagrees with embedded bytes");
      const embeddedSize = nonNegativeInteger(resolved["embedded_size"] ?? resolved["thumbnail_size"]);
      if (embeddedSize !== undefined && embeddedSize !== embedded.byteLength) throw new TypeError("DeepSeek resource embedded size disagrees with its bytes");
      const name = sourceText(resolved["name"]);
      const sha256 = embedded.sha256;
      const width = nonNegativeInteger(resolved["width"]);
      const height = nonNegativeInteger(resolved["height"]);
      resource = this.#allocate(`${kind}\u0000${name ?? ""}\u0000${embedded.mime}\u0000${sha256}`, {
        kind,
        availability: "embedded",
        ...(name ? { name } : {}),
        mime: embedded.mime,
        bytes: embedded.byteLength,
        sha256,
        ...(embedded.byteLength === 0 ? {} : { data_base64: embedded.dataBase64 }),
        ...(width !== undefined && height !== undefined && width > 0 && height > 0 ? { dimensions: { width, height } } : {}),
        ...(nonNegativeInteger(resolved["size_bytes"] ?? resolved["source_size"]) !== undefined ? { original_bytes: nonNegativeInteger(resolved["size_bytes"] ?? resolved["source_size"])! } : {})
      });
      const availability = sourceText(resolved["availability"]);
      if (isImage && (availability?.includes("preview") || availability?.includes("thumbnail") || resolved["original_verified"] === false)) {
        const index = this.values.findIndex((entry) => entry["id"] === resource);
        limitations.push({ code: "deepseek_image_preview", ...(index >= 0 ? { at: `/resources/${index}` } : {}), detail: "DeepSeek identified the embedded image as a preview or thumbnail" });
      }
    } else {
      const name = sourceText(resolved["name"]);
      const bytes = nonNegativeInteger(resolved["size_bytes"] ?? resolved["source_size"]);
      const url = httpUrl(resolved["signed_path"] ?? resolved["source_url"]);
      const availability = sourceText(resolved["availability"]);
      resource = this.#allocate(canonicalizeJcs({ kind, name: name ?? "", mime: declaredMime ?? "", bytes: bytes ?? -1, url: url ?? "" }), {
        kind,
        availability: url ? "external" : availability?.includes("missing") || availability?.includes("unavailable") ? "missing" : "metadata_only",
        ...(name ? { name } : {}),
        ...(declaredMime ? { mime: declaredMime } : {}),
        ...(bytes !== undefined ? { bytes } : {}),
        ...(url ? { url } : {})
      });
    }
    return isImage ? { type: "image", resource } : { type: "attachment", resource };
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
      ...(embedded.byteLength === 0 ? {} : { data_base64: embedded.dataBase64 })
    });
  }
}

class DeepSeekSourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();

  add(raw: JsonObject): string | undefined {
    const url = httpUrl(raw["url"]);
    if (!url) return undefined;
    const title = sourceText(raw["title"]);
    const snippet = sourceText(raw["snippet"]);
    const site = sourceText(raw["site_name"]);
    const key = `${url}\u0000${title ?? ""}\u0000${snippet ?? ""}`;
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `s${this.values.length + 1}`;
    this.values.push({ id, kind: "web", url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(site ? { name: site } : {}) });
    this.#byKey.set(key, id);
    return id;
  }

  addAll(raw: JsonValue | undefined): ReadonlyArray<Readonly<{ id: string; url: string; label: string }>> {
    return values(raw).flatMap((value, index) => {
      const source = object(value);
      const url = httpUrl(source?.["url"]);
      const id = source ? this.add(source) : undefined;
      if (!id || !url) return [];
      return [{ id, url, label: sourceText(source?.["title"] ?? source?.["site_name"]) ?? `Source ${index + 1}` }];
    });
  }
}

function markdownLabel(value: string): string {
  return value.replace(/[\[\]\\]/gu, (character) => `\\${character}`);
}

function withReferences(text: string, sources: ReadonlyArray<Readonly<{ id: string; url: string; label: string }>>): string {
  return text.replace(/\[reference:([0-9]+)\]/gu, (whole, rawIndex) => {
    const source = sources[Number.parseInt(rawIndex, 10) - 1];
    if (!source) return whole;
    return `[${markdownLabel(source.label)}](<${source.url.replaceAll(">", "%3E")}>)`;
  });
}

function stageBlocks(
  stage: JsonObject,
  sources: DeepSeekSourcePool,
  allMessageSources: ReadonlyArray<Readonly<{ id: string; url: string; label: string }>>
): JsonObject[] {
  const type = sourceText(stage["type"]);
  const text = sourceText(stage["text"] ?? stage["content"]);
  const stageSourceInput = stage["sources"] ?? stage["results"] ?? (stage["result"] !== undefined ? [stage["result"]] : undefined);
  const stageSources = sources.addAll(stageSourceInput);
  const sourceIds = [...new Set(stageSources.map((source) => source.id))];
  const queries = values(stage["queries"]).flatMap((value) => {
    const query = sourceText(value) ?? sourceText(object(value)?.["query"]);
    return query ? [query] : [];
  });
  if (type === "THINK") {
    if (!text) return [];
    return [{ type: "reasoning", text: withReferences(text, allMessageSources), format: "markdown", ...(positiveNumber(stage["elapsed_secs"]) !== undefined ? { duration: positiveNumber(stage["elapsed_secs"])! } : {}) }];
  }
  if (type === "TOOL_SEARCH") {
    if (queries.length > 0) return queries.map((query) => ({ type: "search", query, ...(sourceIds.length > 0 ? { sources: sourceIds } : {}) }));
    return sourceIds.length > 0 ? [{ type: "search", sources: sourceIds }] : [];
  }
  if (type === "TOOL_OPEN") {
    return [{ type: "tool", kind: "activity", name: "web-open", ...(sourceText(stage["status"]) ? { status: sourceText(stage["status"])! } : {}), ...(sourceIds.length > 0 ? { output: { sources: sourceIds } } : {}) }];
  }
  return [];
}

function projectMarkdown(
  text: string,
  owners: readonly string[],
  messageSources: ReadonlyArray<Readonly<{ id: string; url: string; label: string }>>,
  mermaid: MermaidPool,
  resources: DeepSeekResourcePool
): JsonObject[] {
  return projectMarkdownWithDiagrams(withReferences(text, messageSources), (source) => {
    const evidence = mermaid.take(owners, source);
    return evidence ? resources.addDiagram(evidence.dataUrl) : undefined;
  });
}

function projectMessage(
  item: JsonObject,
  resources: DeepSeekResourcePool,
  sources: DeepSeekSourcePool,
  mermaid: MermaidPool,
  limitations: JsonObject[],
  captured?: string
): JsonObject[] {
  const owners = [sourceText(item["message_id"])].filter((value): value is string => value !== undefined);
  const messageSources = sources.addAll(item["sources"]);
  const attachments = values(item["attachments"]).map((value) => {
    const attachment = object(value);
    if (!attachment) throw new TypeError("DeepSeek attachment occurrence is not an object");
    return resources.add(attachment, limitations);
  });
  const rawFragments = values(item["raw_fragments"]);
  const bodyCount = rawFragments.length > 0 ? rawFragments.filter(raw => ["REQUEST", "RESPONSE"].includes(String(object(raw)?.["type"]))).length : values(item["main"]).length;
  const capturedBody = bodyCount === 1 ? captured : undefined;
  const content: JsonObject[] = [];
  let attachmentsUsed = 0;
  if (rawFragments.length > 0) {
    for (const raw of rawFragments) {
      const fragment = object(raw);
      if (!fragment) throw new TypeError("DeepSeek raw fragment is not an object");
      const type = sourceText(fragment["type"]);
      if (type === "FILE") {
        // The exporter flattens each FILE.files group into attachments in this
        // same order. Replaying the whole array for every FILE duplicates files
        // and moves later groups ahead of intervening message content.
        const count = Array.isArray(fragment["files"])
          ? fragment["files"].filter(isJsonObject).length
          : attachments.length - attachmentsUsed;
        content.push(...attachments.slice(attachmentsUsed, attachmentsUsed + count));
        attachmentsUsed = Math.min(attachments.length, attachmentsUsed + count);
      } else if (type === "THINK" || type === "TOOL_SEARCH" || type === "TOOL_OPEN") {
        content.push(...stageBlocks(fragment, sources, messageSources));
      } else if (type === "REQUEST" || type === "RESPONSE") {
        const text = sourceText(fragment["content"]);
        if (capturedBody) content.push({ type: "html", html: capturedBody });
        else if (text) content.push(...projectMarkdown(text, owners, messageSources, mermaid, resources));
      } else if (type === "TIP") {
        const text = sourceText(fragment["content"]);
        if (text && fragment["hide_on_wip"] !== true) content.push({ type: "status", text });
      } else {
        const text = sourceText(fragment["content"]);
        if (text) content.push({ type: "unknown", kind: `deepseek-${(type ?? "fragment").toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`, text });
      }
    }
  } else {
    if (item["role"] === "user") {
      content.push(...attachments);
      attachmentsUsed = attachments.length;
    }
    const stages = values(item["reasoning_stages"]);
    if (stages.length > 0) {
      for (const value of stages) {
        const stage = object(value);
        if (!stage) throw new TypeError("DeepSeek reasoning stage is not an object");
        content.push(...stageBlocks(stage, sources, messageSources));
      }
    } else {
      for (const thought of values(item["thoughts"])) {
        const text = sourceText(thought);
        if (text) content.push({ type: "reasoning", text: withReferences(text, messageSources), format: "markdown" });
      }
    }
    for (const main of values(item["main"])) {
      const text = sourceText(main);
      if (capturedBody) content.push({ type: "html", html: capturedBody });
      else if (text) content.push(...projectMarkdown(text, owners, messageSources, mermaid, resources));
    }
  }
  content.push(...attachments.slice(attachmentsUsed));
  const sourceIds = [...new Set(messageSources.map((source) => source.id))];
  if (sourceIds.length > 0) content.push({ type: "citations", sources: sourceIds });
  return content;
}

function orderedTreeItems(items: readonly JsonObject[], limitations: JsonObject[]): JsonObject[] {
  const byId = new Map<string, JsonObject>();
  const order = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const id = sourceText(item["message_id"]);
    if (!id || byId.has(id)) throw new TypeError("DeepSeek Tree message identity is missing or duplicated");
    byId.set(id, item);
    order.set(id, index);
  }
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const item of items) {
    const id = sourceText(item["message_id"])!;
    const parent = sourceText(item["parent_id"]);
    if (!parent || !byId.has(parent)) {
      roots.push(id);
      if (parent) limitations.push({ code: "source_parent_omitted", detail: "A DeepSeek Tree message referenced a parent omitted by the source payload" });
    } else {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
  }
  for (const list of children.values()) list.sort((left, right) => order.get(left)! - order.get(right)!);
  roots.sort((left, right) => order.get(left)! - order.get(right)!);
  const result: JsonObject[] = [];
  const state = new Set<string>();
  const visit = (id: string): void => {
    if (state.has(id)) throw new TypeError("DeepSeek Tree contains a cycle or duplicate traversal");
    state.add(id);
    result.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  if (result.length !== items.length) throw new TypeError("DeepSeek Tree has no complete parent-first traversal");
  return result;
}

async function parseDeepSeek(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const resources = new DeepSeekResourcePool(context.payload);
  const sources = new DeepSeekSourcePool();
  const mermaid = new MermaidPool(context.reading?.mermaid ?? []);
  const reading = new Map((context.reading?.fragments ?? []).map(fragment => [fragment.messageId, fragment.html]));
  const limitations: JsonObject[] = [];
  const rawItems = values(context.payload["items"]).map((value) => {
    const item = object(value);
    if (!item) throw new TypeError("DeepSeek message sequence contains a non-object entry");
    return item;
  });
  const items = profile === "tree" ? orderedTreeItems(rawItems, limitations) : rawItems;
  const ids = new Map(items.flatMap((item, index) => sourceText(item["message_id"]) ? [[sourceText(item["message_id"])!, `m${index + 1}`] as const] : []));
  const contentByOwner = new Map<string, JsonObject[]>();
  const models: string[] = [];
  const messages = await mapSequential(items, async (item, index) => {
    const sourceId = sourceText(item["message_id"]);
    const captured = capturedTextPanel(sourceId ? reading.get(sourceId) : undefined, item["role"] === "user" ? "user-bubble" : "answer");
    const content = restoreCapturedProcess(projectMessage(item, resources, sources, mermaid, limitations, captured), sourceId ? reading.get(sourceId) ?? "" : "", "thinking");
    if (sourceId) contentByOwner.set(sourceId, content);
    const model = sourceText(item["model"]);
    if (model && !models.includes(model)) models.push(model);
    const role = item["role"] === "user" ? "user" : item["role"] === "assistant" ? "assistant" : "other";
    const parent = profile === "tree" && sourceText(item["parent_id"]) ? ids.get(sourceText(item["parent_id"])!) : undefined;
    const recordParent = profile === "tree" ? sourceText(item["parent_id"]) : index > 0 ? sourceText(items[index - 1]!["message_id"]) ?? `m${index}` : undefined;
    context.record?.message(index, { id: sourceId ?? `m${index + 1}`, ...(recordParent ? { parent: recordParent } : {}), role, ...(model ? { model } : {}) });
    await context.onProgress?.(index + 1, items.length);
    return {
      ...(profile === "tree" ? { id: `m${index + 1}`, ...(parent ? { parent } : {}) } : {}),
      role,
      ...(role === "other" ? { name: sourceText(item["role"]) ?? "DeepSeek" } : {}),
      ...(model ? { model } : {}),
      ...(timestamp(item["inserted_at"]) ? { timestamp: timestamp(item["inserted_at"])! } : {}),
      content
    };
  });
  let orphaned = 0;
  for (const record of mermaid.remaining()) {
    const content = contentByOwner.get(record.messageId);
    if (content) content.push({ type: "diagram", format: "mermaid", rendered: resources.addDiagram(record.dataUrl) });
    else orphaned += 1;
  }
  if (orphaned > 0) limitations.push({ code: "deepseek_unowned_mermaid_preview", detail: `${orphaned} Mermaid preview(s) lacked a message owner` });
  const messageTimes = messages.flatMap((message) => typeof message.timestamp === "string" ? [message.timestamp] : []).sort();
  const capturedAt = timestamp(context.manifest["captured_at"] ?? context.manifest["exported_at"])
    ?? timestamp(context.payload["exported_at"])
    ?? context.source.fileSystemCapturedAt;
  const sourceUrl = httpUrl(context.manifest["source_url"] ?? context.payload["source_url"]);
  const title = sourceText(context.payload["title"] ?? context.manifest["title"]);
  const exporterVersion = sourceText(context.manifest["exporter_version"] ?? context.payload["exporter_version"]);
  const currentRaw = profile === "tree" ? sourceText(context.payload["active_leaf_id"]) : undefined;
  const currentMessage = currentRaw ? ids.get(currentRaw) : undefined;
  return {
    source: {
      file: context.source.file,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      format: "exporter-html",
      payload: payloadName.replaceAll("/", "."),
      profile,
      ...(exporterVersion ? { exporter: { id: "deepseek-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "deepseek",
    platform: "deepseek",
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
    version: "3.0.4",
    family: "deepseek",
    routes: [{ format: "exporter-html", platform: "deepseek", payload, profile }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "3.0.0", "3.0.1", "3.0.2", "3.0.3"].map(version => ({ adapter: id, version, action: "reparse_source" as const }))
  };
}

export const DEEPSEEK_LIGHT_MANIFEST = manifest("deepseek-light-messages-v2", "osis.deepseek.chat-export/light-messages-v2", "light");
export const DEEPSEEK_FULL_MANIFEST = manifest("deepseek-full-v1", "osis.deepseek.chat-export/full-v1", "full");
export const DEEPSEEK_TREE_MANIFEST = manifest("deepseek-all-branches-v1", "osis.deepseek.chat-export/all-branches-v1", "tree");

export const deepSeekLightAdapter: SourceAdapter = Object.freeze({ manifest: DEEPSEEK_LIGHT_MANIFEST, parse: (context) => parseDeepSeek(context, "light", "osis.deepseek.chat-export/light-messages-v2") });
export const deepSeekFullAdapter: SourceAdapter = Object.freeze({ manifest: DEEPSEEK_FULL_MANIFEST, parse: (context) => parseDeepSeek(context, "full", "osis.deepseek.chat-export/full-v1") });
export const deepSeekTreeAdapter: SourceAdapter = Object.freeze({ manifest: DEEPSEEK_TREE_MANIFEST, parse: (context) => parseDeepSeek(context, "tree", "osis.deepseek.chat-export/all-branches-v1") });
