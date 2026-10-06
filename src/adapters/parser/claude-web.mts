import type { AdapterManifest, AdapterParseContext, SourceAdapter } from "../../app/parser/adapter.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { inertHtmlFragment, inertStandaloneSvg, preserveNestedImage } from "./inert-html.mts";
import { projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";
import { mermaidCardSource, mermaidCardVisual } from "./diagram-card.mts";
import { ClaudeResourceData } from "./claude-resource-data.mts";
import { claudeInteractive, interactiveFileMime } from "./claude-interactive.mts";
import { defaultTreeAdapter, parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";

type Profile = "light" | "full" | "tree";
type ReadingImage = Readonly<{
  messageId: string;
  resourceKey?: string;
  dataUrl: string;
  alt?: string;
  width?: number;
  height?: number;
}>;
type ReadingFile = Readonly<{
  messageId: string;
  resourceKey?: string;
  dataUrl: string;
  name?: string;
}>;

const NIL_PARENT = "00000000-0000-4000-8000-000000000000";

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function values(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sourceMessageModel(message: JsonObject): string | undefined {
  // Claude's selector/conversation.model describes the current choice, not
  // historical authorship. Only a source witness for this message may name it.
  const provenance = text(message["model_provenance"]);
  return message["role"] === "assistant" && message["model_scope"] === "message" && provenance?.startsWith("conversation_api.message.")
    ? text(message["model"])
    : undefined;
}

function integer(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positive(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function timestamp(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const numeric = typeof value === "number" ? value : Number.NaN;
  const date = new Date(typeof value === "number" && numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function httpUrl(value: JsonValue | undefined): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}


function stableDuration(value: JsonObject): number | undefined {
  const declared = positive(value["seconds"]);
  if (declared !== undefined) return declared;
  const start = timestamp(value["start_timestamp"]);
  const stop = timestamp(value["stop_timestamp"]);
  if (!start || !stop) return undefined;
  const seconds = (Date.parse(stop) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function deduplicate<T>(input: readonly T[]): T[] {
  return [...new Set(input)];
}

class ClaudeSourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();

  #add(kind: "web" | "past_chat" | "file" | "other", value: JsonObject): string | undefined {
    const url = httpUrl(value["url"] ?? value["page_url"]);
    const title = text(value["title"] ?? value["name"]);
    const body = text(value["text"] ?? value["snippet"]);
    if (kind === "web" && !url) return undefined;
    if (!url && !title && !body) return undefined;
    const key = canonicalizeJcs({ kind, url: url ?? "", title: title ?? "", body: body ?? "" });
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `s${this.values.length + 1}`;
    this.values.push({
      id,
      kind,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(body ? (kind === "past_chat" ? { text: body } : { snippet: body }) : {})
    });
    this.#byKey.set(key, id);
    return id;
  }

  addWeb(value: JsonObject): string | undefined {
    if (value["is_missing"] === true) return undefined;
    return this.#add("web", value);
  }

  addCitationList(value: JsonValue | undefined): string[] {
    return deduplicate(values(value).flatMap((raw) => {
      const source = object(raw);
      const id = source ? this.addWeb(source) : undefined;
      return id ? [id] : [];
    }));
  }

  addToolContent(value: JsonValue | undefined): string[] {
    const result: string[] = [];
    for (const raw of values(value)) {
      const item = object(raw);
      if (!item) continue;
      const type = text(item["type"]);
      if (type === "knowledge") {
        const id = this.addWeb(item);
        if (id) result.push(id);
      } else if (type === "text") {
        const id = this.#add("past_chat", { text: item["text"] ?? "" });
        if (id) result.push(id);
      } else if (type === "image_gallery") {
        for (const imageRaw of values(item["images"])) {
          const image = object(imageRaw);
          const id = image ? this.#add("web", image) : undefined;
          if (id) result.push(id);
        }
      }
    }
    return deduplicate(result);
  }
}

class ClaudeToolPool {
  readonly #byVendor = new Map<string, string>();
  readonly #calls = new Map<string, JsonObject>();

  id(value: JsonValue | undefined): string | undefined {
    const vendor = text(value);
    if (!vendor) return undefined;
    const existing = this.#byVendor.get(vendor);
    if (existing) return existing;
    const id = `x${this.#byVendor.size + 1}`;
    this.#byVendor.set(vendor, id);
    return id;
  }

  remember(vendor: JsonValue | undefined, block: JsonObject): void {
    const key = text(vendor);
    if (key) this.#calls.set(key, block);
  }

  queryFor(vendor: JsonValue | undefined): string | undefined {
    const call = this.#calls.get(text(vendor) ?? "");
    const input = object(call?.["input"]);
    return text(input?.["query"] ?? input?.["search_query"]);
  }
}

class ClaudeResourcePool {
  readonly values: JsonObject[] = [];
  readonly interactive: boolean;
  readonly #data: ClaudeResourceData;
  readonly #metadata = new Map<string, JsonObject>();
  readonly #metadataByJob = new Map<string, JsonObject[]>();
  readonly #readingImages = new Map<string, ReadingImage>();
  readonly #readingFiles: Array<{ value: ReadingFile; used: boolean }> = [];
  readonly #allocated = new Map<string, string>();

  constructor(context: AdapterParseContext, profile: Profile) {
    this.interactive = !!context.record;
    this.#data = new ClaudeResourceData(context.payload, profile !== "light");
    for (const raw of values(context.payload["resources"])) {
      const original = object(raw);
      const resource = original ? this.#data.restore(original, { data_url: "data_ref" }) : undefined;
      const key = text(resource?.["key"]);
      if (!resource || !key || this.#metadata.has(key)) throw new TypeError("Claude resource registry is malformed");
      this.#metadata.set(key, resource);
      const job = text(resource["job_key"]);
      if (job) this.#metadataByJob.set(job, [...(this.#metadataByJob.get(job) ?? []), resource]);
    }
    // Mermaid cards are a separate reading channel. Their explicit resource key
    // still identifies the exact captured image; do not lose it in Light mode.
    for (const image of [...(context.reading?.images ?? []), ...(context.reading?.mermaid ?? [])]) {
      if (image.resourceKey && !this.#readingImages.has(image.resourceKey)) this.#readingImages.set(image.resourceKey, image);
    }
    this.#readingFiles.push(...(context.reading?.files ?? []).map((value) => ({ value, used: false })));
  }

  restoreReading(fragment: DefaultTreeAdapterTypes.ParentNode): void {
    this.#data.restoreReading(fragment);
  }

  #meta(media: JsonObject): JsonObject | undefined {
    const key = text(media["resource_key"]);
    if (key && this.#metadata.has(key)) return this.#metadata.get(key);
    const job = text(media["job_key"]);
    const matches = job ? this.#metadataByJob.get(job) ?? [] : [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && key) {
      return matches.find((candidate) => text(candidate["key"]) === key)
        ?? matches.find((candidate) => text(candidate["key"])?.startsWith(`${job}-variant-`));
    }
    return undefined;
  }

  #imageEvidence(meta: JsonObject): ReadingImage | undefined {
    const key = text(meta["dom_resource_key"] ?? meta["key"]);
    const image = key ? this.#readingImages.get(key) : undefined;
    return image && (!text(meta["message_id"]) || meta["message_id"] === image.messageId) ? image : undefined;
  }

  #allocate(key: string, body: Omit<JsonObject, "id">): string {
    const existing = this.#allocated.get(key);
    if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...body });
    this.#allocated.set(key, id);
    return id;
  }

  #resource(meta: JsonObject, kind: "image" | "diagram" | "file", dataUrl?: string): string {
    const key = text(meta["key"] ?? meta["id"]) ?? canonicalizeJcs(meta);
    const existing = this.#allocated.get(key);
    if (existing) return existing;
    const name = text(meta["name"]);
    const declaredMime = text(meta["mime_type"])?.toLowerCase();
    const sourceUrl = httpUrl(meta["source_url"]);
    const width = integer(meta["width"]);
    const height = integer(meta["height"]);
    if (dataUrl) {
      const embedded = kind === "file" ? embeddedBase64DataUrl(dataUrl) : embeddedImageDataUrl(dataUrl);
      if (declaredMime && declaredMime.split(";", 1)[0] !== embedded.mime) {
        throw new TypeError(`Claude resource MIME metadata ${declaredMime} disagrees with embedded ${embedded.mime} bytes`);
      }
      const sourceBytes = integer(meta["source_bytes"] ?? meta["size_bytes"]);
      return this.#allocate(key, {
        kind,
        availability: "embedded",
        ...(name ? { name } : {}),
        mime: declaredMime ?? embedded.mime,
        bytes: embedded.byteLength,
        sha256: embedded.sha256,
        ...(embedded.byteLength > 0 ? { data_base64: embedded.dataBase64 } : {}),
        ...(width && height ? { dimensions: { width, height } } : {}),
        ...(sourceUrl ? { original_url: sourceUrl } : {}),
        ...(sourceBytes !== undefined && sourceBytes !== embedded.byteLength ? { original_bytes: sourceBytes } : {})
      });
    }
    if (sourceUrl) return this.#allocate(key, {
      kind,
      availability: "external",
      ...(name ? { name } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      url: sourceUrl,
      ...(width && height ? { dimensions: { width, height } } : {})
    });
    const bytes = integer(meta["source_bytes"] ?? meta["size_bytes"]);
    if (name || declaredMime || bytes !== undefined) return this.#allocate(key, {
      kind,
      availability: "metadata_only",
      ...(name ? { name } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(bytes !== undefined ? { bytes } : {})
    });
    return this.#allocate(key, { kind, availability: "missing" });
  }

  mediaBlock(media: JsonObject): JsonObject | undefined {
    const mediaKind = text(media["kind"]);
    if (!mediaKind || mediaKind === "source-icon") return undefined;
    const meta = this.#meta(media);
    if (!meta) throw new TypeError("Claude visible media has no matching resource metadata");
    if (meta["display_eligible"] === false) return undefined;
    const evidence = this.#imageEvidence(meta);
    const dataUrl = text(meta["data_url"]) ?? evidence?.dataUrl;
    const kind = mediaKind === "diagram-svg" ? "diagram" : "image";
    const id = this.#resource(meta, kind, dataUrl);
    if (kind === "diagram") return { type: "diagram", format: "svg", rendered: id };
    return {
      type: "image",
      resource: id,
      ...(text(media["name"] ?? meta["name"]) ? { alt: text(media["name"] ?? meta["name"])! } : {}),
      purpose: mediaKind === "image-search" ? "search-result" : "inline"
    };
  }

  diagramResource(media: JsonObject): string | undefined {
    const block = this.mediaBlock(media);
    return block?.["type"] === "diagram" ? text(block["rendered"]) : undefined;
  }

  inlineImage(src: string, key: string | undefined, alt: string | undefined, media: readonly JsonObject[], kind: "image" | "diagram" = "image"): Readonly<{ block: JsonObject; media?: JsonObject }> {
    const matched = media.find(entry => {
      const meta = this.#meta(entry);
      return key ? entry["resource_key"] === key : meta?.["data_url"] === src || meta?.["source_url"] === src || (meta && this.#imageEvidence(meta)?.dataUrl === src);
    });
    const block = matched ? this.mediaBlock(matched) : undefined;
    if (block && (kind !== "diagram" || block["type"] === "diagram")) return { block, media: matched! };
    const id = this.#resource({ id: `inline-${this.values.length + 1}`, ...(alt ? { name: alt } : {}), ...(httpUrl(src) ? { source_url: src } : {}) }, kind, src.startsWith("data:image/") ? src : undefined);
    return { block: kind === "diagram" ? { type: "diagram", format: "svg", rendered: id } : { type: "image", resource: id, ...(alt ? { alt } : {}) }, ...(matched ? { media: matched } : {}) };
  }

  attachmentBlocks(attachment: JsonObject, owner: string): JsonObject[] {
    if (text(attachment["kind"]) === "image") return []; // Existing media owns image placement.
    const name = text(attachment["name"] ?? attachment["file_name"]);
    if (!name) return [];
    const blocks: JsonObject[] = [];
    const seen = new Set<string>();
    let fileIncluded = false;
    for (const raw of values(attachment["embedded_resources"])) {
      const entry = object(raw);
      const meta = entry && this.#metadata.get(text(entry["key"]) ?? "");
      if (!meta || text(meta["message_id"]) !== owner) continue;
      const dataUrl = text(meta["data_url"]);
      if (!dataUrl || seen.has(dataUrl)) continue;
      seen.add(dataUrl);
      const thumbnail = dataUrl.startsWith("data:image/");
      const resource = this.#resource({ ...meta, name }, thumbnail ? "image" : "file", dataUrl);
      if (thumbnail) blocks.push({ type: "image", resource, alt: name, purpose: "attachment-thumbnail" });
      else { blocks.push({ type: "attachment", resource, text: name }); fileIncluded = true; }
    }
    if (!fileIncluded) {
      const mime = text(attachment["mime_type"]);
      const bytes = integer(attachment["size"] ?? attachment["size_bytes"]);
      const resource = this.#resource({ id: `${owner}:attachment:${text(attachment["id"]) ?? name}`, name, ...(mime && !mime.includes("*") ? { mime_type: mime } : {}), ...(bytes !== undefined ? { size_bytes: bytes } : {}) }, "file");
      blocks.push({ type: "attachment", resource, text: name });
    }
    return blocks;
  }

  sourceFile(name: string, source: string, mime: string, owner: string): string {
    const dataUrl = `data:${mime};base64,${Buffer.from(source, "utf8").toString("base64")}`;
    return this.#resource({ id: canonicalizeJcs({ owner, name, source }), name, mime_type: mime }, "file", dataUrl);
  }

  nativeAssets(card: JsonObject, view: JsonObject, media: readonly JsonObject[], used: Set<JsonObject>, result?: JsonObject): void {
    const files = values(view["files"]).flatMap(v => object(v) ? [object(v)!] : []), images: JsonObject[] = [], seen = new Map<string, string>();
    const owned = media.filter(m => m["tool_use_id"] === card["tool_use_id"] && !!card["tool_use_id"]);
    const add = (id: string): string => {
      const known = seen.get(id); if (known) return known;
      const resource = this.values.find(r => r["id"] === id), mime = text(resource?.["mime"]) ?? "";
      const extension = ({ "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[mime] ?? "image";
      const path = `assets/image-${seen.size + 1}.${extension}`;
      seen.set(id, path); files.push({ path, resource: id }); return path;
    };
    const fragment = parseFragment(text(card["html"]) ?? ""); this.restoreReading(fragment);
    const pending: DefaultTreeAdapterTypes.ChildNode[] = [...fragment.childNodes];
    while (pending.length) {
      const node = pending.shift()!; if (!("tagName" in node) || ["pre", "code", "script", "iframe"].includes(node.tagName)) continue;
      if (node.tagName === "img") {
        const attr = (name: string) => node.attrs.find(a => a.name === name)?.value;
        const src = attr("src"), key = attr("data-resource-key");
        if (src && (src.startsWith("data:image/") || httpUrl(src))) {
          const image = this.inlineImage(src, key, attr("alt"), media);
          if (image.media) used.add(image.media);
          if (typeof image.block["resource"] === "string") images.push({ path: add(image.block["resource"]) });
        }
      } else pending.push(...node.childNodes);
    }
    // Native galleries live in the paired result, not necessarily in the
    // exporter's simplified card HTML. Preserve each source item ID so product
    // and place images stay with their owner; never guess groups by position.
    for (const raw of values(result?.["content"])) {
      const gallery = object(raw); if (gallery?.["type"] !== "image_gallery") continue;
      for (const item of values(gallery["images"])) {
        const info = object(item), url = httpUrl(info?.["thumbnail_url"]) ?? httpUrl(info?.["url"]); if (!info || !url) continue;
        const urls = new Set([url, httpUrl(info["url"])]);
        const captured = owned.find(m => urls.has(text(object(this.#meta(m)?.["candidate"])?.["url"]) ?? ""));
        const pageMatches = owned.filter(m => !!info["page_url"] && this.#meta(m)?.["source_url"] === info["page_url"]);
        const key = text((captured ?? (pageMatches.length === 1 ? pageMatches[0] : undefined))?.["resource_key"]);
        const image = this.inlineImage(url, key, text(info["title"]), owned);
        if (image.media) used.add(image.media);
        if (typeof image.block["resource"] !== "string") continue;
        const path = add(image.block["resource"]), id = text(info["id"]);
        const previous = images.find(entry => entry["path"] === path && (!entry["source_id"] || entry["source_id"] === id));
        if (previous) { if (id) previous["source_id"] = id; }
        else images.push({ path, ...(id ? { source_id: id } : {}) });
      }
    }
    // Map photos are not image_gallery entries. The paired result stores place
    // IDs and photo URLs; only exact, same-call captured media can supply bytes.
    // Unfetched photos remain in the source result, not invented file bindings.
    if (card["kind"] === "places_map") for (const raw of values(result?.["content"])) {
      const entry = object(raw); if (entry?.["type"] !== "text" || typeof entry["text"] !== "string") continue;
      let data: JsonObject | undefined; try { data = object(JSON.parse(entry["text"]) as JsonValue); } catch { continue; }
      const places = object(data?.["enriched_places"]); if (!places) continue;
      for (const [placeId, place] of Object.entries(places)) {
        const bind = (captured: JsonObject, photoUrl?: string) => {
          const image = this.mediaBlock(captured), id = text(image?.["resource"]); if (!id) return;
          used.add(captured); const path = add(id);
          const previous = images.find(item => item["path"] === path && (!item["source_id"] || item["source_id"] === placeId));
          if (previous) { previous["source_id"] = placeId; if (photoUrl) previous["source_url"] = photoUrl; }
          else images.push({ path, source_id: placeId, ...(photoUrl ? { source_url: photoUrl } : {}) });
        };
        for (const rawPhoto of values(object(place)?.["photos"])) {
          const photo = object(rawPhoto), url = httpUrl(photo?.["url"]); if (!url) continue;
          const candidates = owned.filter(m => {
            const meta = this.#meta(m); if (!meta || meta["display_eligible"] === false) return false;
            return object(meta["candidate"])?.["url"] === url || meta["source_url"] === url;
          });
          if (candidates.length === 1) bind(candidates[0]!, url);
        }
        // Light keeps WebP bytes in the reading image and only the place page
        // URL in metadata. A unique exact page URL proves the PLACE, not which
        // photo from the API list it was; do not fabricate a photo URL/author.
        const mapsUrl = httpUrl(object(place)?.["maps_url"]);
        if (mapsUrl && Object.values(places).filter(place => object(place)?.["maps_url"] === mapsUrl).length === 1) {
          for (const captured of owned) {
            const meta = this.#meta(captured);
            if (meta?.["display_eligible"] !== false && meta?.["source_url"] === mapsUrl) bind(captured);
          }
        }
      }
    }
    const icons: JsonObject[] = [];
    for (const raw of values(card["widget_icons"])) {
      const icon = object(raw), name = text(icon?.["name"]); if (!icon || !name) continue;
      const meta = this.#meta(icon) ?? this.#data.restore(icon, { data_url: "data_ref" });
      const data = text(meta["data_url"]), url = httpUrl(meta["source_url"]);
      if (!data && !url) continue;
      const id = this.#resource({ ...meta, id: text(meta["key"]) ?? `${view["source"]}:${name}`, ...(name ? { name } : {}) }, "image", data);
      icons.push({ name, path: add(id) });
    }
    if (files.length) view["files"] = files;
    if (images.length || icons.length) view["data"] = { ...object(view["data"]), ...(images.length ? { images } : {}), ...(icons.length ? { icons } : {}) };
  }

  artifactBlocks(artifact: JsonObject, owner: string): JsonObject[] {
    artifact = this.#data.restore(artifact, { file_data_url: "file_data_ref", svg_data_url: "svg_data_ref" });
    const name = text(artifact["name"]);
    const extension = text(artifact["extension"])?.toLowerCase();
    const language = text(artifact["language"]) ?? extension;
    const source = text(artifact["source"]);
    let dataUrl = text(artifact["file_data_url"]);
    if (!dataUrl) {
      const reading = this.#readingFiles.find((entry) => !entry.used
        && entry.value.messageId === owner
        && (!name || entry.value.name === name));
      if (reading) {
        reading.used = true;
        dataUrl = reading.value.dataUrl;
      }
    }
    const runnable = this.interactive && !!source && ["html", "htm", "jsx", "tsx"].includes(extension ?? "");
    if (runnable && !dataUrl) dataUrl = `data:${text(artifact["mime_type"]) ?? interactiveFileMime(name ?? `index.${extension}`)};base64,${Buffer.from(source!, "utf8").toString("base64")}`;
    const kind = extension === "svg" ? "diagram" : "file";
    const meta: JsonObject = {
      // A later message may capture a revised file under the same Artifact ID.
      // Its bytes belong to that occurrence, not the first global allocation.
      id: canonicalizeJcs({ message: owner, artifact: text(artifact["id"]) ?? name ?? "artifact" }),
      ...(name ? { name } : {}),
      ...(text(artifact["mime_type"]) ? { mime_type: text(artifact["mime_type"])! } : {}),
      ...(integer(artifact["size_bytes"]) !== undefined ? { size_bytes: integer(artifact["size_bytes"])! } : {})
    };
    const resource = this.#resource(meta, kind, dataUrl);
    const result: JsonObject[] = [];
    if (runnable) {
      const filename = name?.split(/[\\/]/u).at(-1) || `index.${extension}`;
      return [{ type: "interactive", display: "window", source: "claude.ai_artifact",
        format: extension === "jsx" || extension === "tsx" ? "react" : "html", title: text(artifact["description"]) ?? filename,
        files: [{ path: filename, resource }], entry: filename }];
    }
    if (extension === "svg" && source) result.push({ type: "diagram", format: "svg", source, rendered: resource });
    else if (source) result.push({ type: "code", code: source, ...(language ? { language } : {}), ...(name ? { filename: name } : {}) });
    result.push({ type: "attachment", resource });
    return result;
  }

}

function orderedMessages(payload: JsonObject, profile: Profile): JsonObject[] {
  const messages = values(payload["messages"]).map((raw) => {
    const message = object(raw);
    if (!message) throw new TypeError("Claude message sequence contains a non-object entry");
    return message;
  });
  const byId = new Map<string, JsonObject>();
  for (const message of messages) {
    const id = text(message["id"]);
    if (!id || byId.has(id)) throw new TypeError("Claude message identity is missing or duplicated");
    byId.set(id, message);
  }
  const topology = object(payload["tree_topology"]);
  const declared = profile === "tree" ? values(topology?.["message_order"]) : values(payload["active_message_ids"]);
  const order = declared.flatMap((value) => text(value) ? [text(value)!] : []);
  if (order.length > 0) {
    if (new Set(order).size !== order.length) throw new TypeError("Claude message order contains duplicate identities");
    const selected = order.map((id) => byId.get(id));
    if (selected.some((message) => !message)) throw new TypeError("Claude message order references a missing identity");
    if (profile === "tree" && selected.length !== messages.length) throw new TypeError("Claude Tree order does not cover the complete tree");
    return selected as JsonObject[];
  }
  return [...messages].sort((left, right) => (integer(left["index"]) ?? 0) - (integer(right["index"]) ?? 0));
}

function publicThinking(block: JsonObject, limitations: JsonObject[], at: string): JsonObject | undefined {
  const visibility = text(block["visibility"]);
  if (visibility && !visibility.startsWith("public")) return undefined;
  const body = visibility === "public_body" ? text(block["body"]) : undefined;
  const summaries = values(block["summaries"]).flatMap((value) => text(value) ? [text(value)!] : []);
  const value = body ?? (summaries.length > 0 ? summaries.join("\n\n") : undefined);
  if (!value) return undefined;
  if (block["truncated"] === true || block["cut_off"] === true) {
    limitations.push({ code: "claude-public-thinking-truncated", at, detail: "Claude marked this public thinking block as truncated" });
  }
  return {
    type: body ? "reasoning" : "reasoning_summary",
    text: value,
    format: "markdown",
    ...(body && summaries.length > 0 ? { title: summaries.join("\n") } : {}),
    ...(stableDuration(block) !== undefined ? { duration: stableDuration(block)! } : {})
  };
}

function visibleToolOutput(block: JsonObject): JsonValue | undefined {
  const parts: JsonValue[] = [];
  const message = text(block["message"]);
  if (message) parts.push(message);
  for (const raw of values(block["content"])) {
    if (typeof raw === "string") {
      if (raw.length > 0) parts.push(raw);
      continue;
    }
    const item = object(raw);
    if (!item) continue;
    if (item["type"] === "text") {
      const value = text(item["text"]);
      if (value) parts.push(value);
    } else if (item["type"] !== "knowledge" && item["type"] !== "image_gallery") {
      // Source cards are projected through the source pool. Other captured tool
      // records (e.g. tool_reference) are visible results, not disposable metadata.
      parts.push(item);
    }
  }
  const unique = [...new Map(parts.map(value => [canonicalizeJcs(value), value])).values()];
  return unique.length === 0 ? undefined : unique.length === 1 ? unique[0] : unique;
}

function mediaRecords(message: JsonObject): JsonObject[] {
  return values(message["media"]).flatMap((raw) => {
    const media = object(raw);
    return media && text(media["kind"]) !== "source-icon" ? [media] : [];
  });
}

function projectMessageContent(input: Readonly<{
  message: JsonObject;
  messageIndex: number;
  resources: ClaudeResourcePool;
  sources: ClaudeSourcePool;
  tools: ClaudeToolPool;
  artifacts: readonly JsonObject[];
  limitations: JsonObject[];
  readingHtml?: string;
  mountedHtml?: string;
}>): JsonObject[] {
  const { message, messageIndex, resources, sources, tools, limitations } = input;
  const media = mediaRecords(message);
  const usedMedia = new Set<JsonObject>();
  const diagrams = media.filter((entry) => text(entry["kind"]) === "diagram-svg" && integer(entry["before_text_index"]) === undefined);
  const beforeText = new Map<number, JsonObject[]>();
  for (const entry of media) {
    const before = integer(entry["before_text_index"]);
    if (before === undefined) continue;
    beforeText.set(before, [...(beforeText.get(before) ?? []), entry]);
  }
  const artifactsById = new Map<string, JsonObject>();
  for (const artifact of input.artifacts) {
    const id = text(artifact["id"]);
    if (id) artifactsById.set(id, artifact);
  }
  const usedArtifacts = new Set<JsonObject>();
  const elements = (node: DefaultTreeAdapterTypes.ParentNode): DefaultTreeAdapterTypes.Element[] => node.childNodes.flatMap(child => "tagName" in child ? [child, ...elements(child)] : []);
  const plain = (node: DefaultTreeAdapterTypes.ParentNode): string => node.childNodes.map(child => "value" in child ? child.value : "childNodes" in child ? plain(child) : "").join("");
  const attr = (node: DefaultTreeAdapterTypes.Element, name: string) => node.attrs.find(a => a.name === name)?.value;
  const blocks = [...values(message["blocks"])];
  const nativeViews = new Map<string, JsonObject>(), nativeKinds = new Map<string, string[]>(), nativePlaced = new Set<string>(), nativeUsed = new Set<string>();
  const allTools = [...blocks, ...values(message["cowork_page_tools"])].flatMap(raw => object(raw) ? [object(raw)!] : []);
  if (resources.interactive) for (const raw of allTools) {
    const id = text(raw["id"]), card = object(raw["native_card"]), kind = text(card?.["kind"]);
    if (raw["type"] !== "tool_use" || !id || !card || !kind || nativeViews.has(id)) continue;
    const result = allTools.find(entry => entry["type"] === "tool_result" && entry["tool_use_id"] === id);
    const view = claudeInteractive(raw, result, (name, source, mime) => resources.sourceFile(name, source, mime, `${message["id"]}:${id}`));
    if (!view) continue;
    resources.nativeAssets(card, view, media, usedMedia, result);
    nativeViews.set(id, view); nativeKinds.set(kind, [...nativeKinds.get(kind) ?? [], id]);
    // The group already owns these exact same-message source bytes. Keep the
    // original creating/publishing tools, but not a second standalone preview.
    for (const file of values(card["files"]).flatMap(f => object(f) ? [object(f)!] : [])) for (const artifact of input.artifacts) {
      if (file["source"] === artifact["source"] && (file["path"] && file["path"] === artifact["path"] || file["name"] === artifact["name"])) usedArtifacts.add(artifact);
    }
  }
  const nativeId = (node: DefaultTreeAdapterTypes.Element): string | undefined => {
    const kind = attr(node, "data-osis-native-card"); if (!kind) return;
    const id = attr(node, "data-tool-use-id"), matches = nativeKinds.get(kind);
    return id && nativeViews.has(id) ? id : matches?.length === 1 ? matches[0] : undefined;
  };
  const takeNative = (id: string): JsonObject[] => {
    const view = nativeViews.get(id); if (!view || nativeUsed.has(id)) return [];
    nativeUsed.add(id); return [view];
  };
  const inlineKeys = new Set<string>(), inlineArtifacts = new Set<string>();
  for (const raw of blocks) {
    const block = object(raw), rich = block?.["type"] === "text" ? text(block["rich_html"]) : undefined;
    if (!rich || block?.["reading_surface_visible"] === false) continue;
    for (const node of elements(parseFragment(rich))) {
      const native = nativeId(node); if (native) nativePlaced.add(native);
      const key = attr(node, "data-osis-cowork-activity-key"), artifact = attr(node, "data-osis-artifact-id");
      if (key) inlineKeys.add(key);
      if (artifact) inlineArtifacts.add(artifact);
    }
  }
  const disclosureKey = (block: JsonObject) => text(block["cowork_disclosure_key"] ?? object(block["raw"])?.["_osis_cowork_disclosure_key"]);
  const inlineThinking = new Map(blocks.flatMap(raw => {
    const block = object(raw), key = block ? disclosureKey(block) : undefined;
    return block?.["type"] === "thinking" && key && inlineKeys.has(key) ? [[key, block] as const] : [];
  }));
  const placedArtifacts = input.artifacts.flatMap(artifact => {
    const placement = object(artifact["dom_placement"]), before = integer(placement?.["before_text_index"]);
    return before === undefined || inlineArtifacts.has(String(artifact["id"])) ? []
      : [{ artifact, before, order: integer(placement?.["dom_order"]) ?? 0 }];
  }).sort((a, b) => a.order - b.order);
  const content: JsonObject[] = [];
  for (const raw of values(message["attachments"])) {
    const attachment = object(raw);
    if (attachment) content.push(...resources.attachmentBlocks(attachment, text(message["id"])!));
  }
  let textIndex = 0;
  let languageWitnesses: Map<string, Set<string>> | undefined;
  const recoverCodeLanguages = (fragment: DefaultTreeAdapterTypes.ParentNode): void => {
    const key = (node: DefaultTreeAdapterTypes.ParentNode) => plain(node).replace(/\r\n/gu, "\n").trim();
    const unlabeled = elements(fragment).filter(node => node.tagName === "pre" && !attr(node, "data-language")
      && !elements(node).some(code => /(?:^|\s)language-\S+/u.test(attr(code, "class") ?? "")));
    if (!unlabeled.length || !input.mountedHtml) return;
    if (!languageWitnesses) {
      languageWitnesses = new Map();
      for (const code of elements(parseFragment(input.mountedHtml))) {
        if (code.tagName !== "code") continue;
        const language = /(?:^|\s)language-([a-z0-9_+#.-]+)/iu.exec(attr(code, "class") ?? "")?.[1];
        if (!language || !key(code)) continue;
        const values = languageWitnesses.get(key(code)) ?? new Set<string>();
        values.add(language); languageWitnesses.set(key(code), values);
      }
    }
    for (const pre of unlabeled) {
      const found = languageWitnesses.get(key(pre));
      if (found?.size === 1) pre.attrs.push({ name: "data-language", value: [...found][0]! });
    }
  };

  const appendMedia = (entry: JsonObject): void => {
    if (usedMedia.has(entry)) return;
    const block = resources.mediaBlock(entry);
    usedMedia.add(entry);
    if (block) content.push(block);
  };
  const takeArtifact = (artifact: JsonObject): JsonObject[] => {
    if (usedArtifacts.has(artifact)) return [];
    usedArtifacts.add(artifact);
    return resources.artifactBlocks(artifact, text(message["id"])!);
  };
  const appendArtifacts = (vendorCall: JsonValue | undefined): void => {
    const artifact = artifactsById.get(text(vendorCall) ?? "");
    if (!artifact || inlineArtifacts.has(String(artifact["id"])) || placedArtifacts.some(p => p.artifact === artifact)) return;
    content.push(...takeArtifact(artifact));
  };
  const appendPlacedArtifacts = (index: number): void => {
    for (const placement of placedArtifacts) if (placement.before === index) content.push(...takeArtifact(placement.artifact));
  };
  const projectTool = (block: JsonObject): JsonObject[] => {
    const type = block["type"], call = tools.id(type === "tool_use" ? block["id"] : block["tool_use_id"]);
    if (type === "tool_use") tools.remember(block["id"], block);
    const output = type === "tool_result" ? visibleToolOutput(block) : undefined;
    const result: JsonObject[] = [{ type: "tool", kind: type === "tool_use" ? "call" : "result",
      ...(call ? { call } : {}), ...(text(block["name"]) ? { name: text(block["name"])! } : {}),
      ...(text(block["message"]) ? { title: text(block["message"])! } : {}),
      ...(type === "tool_use" && block["input"] !== undefined && block["input"] !== null ? { input: block["input"]! } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(type === "tool_result" && typeof block["is_error"] === "boolean" ? { success: !block["is_error"] } : {}),
      ...(stableDuration(block) !== undefined ? { duration: stableDuration(block)! } : {}) }];
    if (type === "tool_result") {
      const sourceIds = deduplicate([...sources.addCitationList(block["sources"]),
        ...(block["_osis_cowork_page_state_tool"] === true ? [] : sources.addToolContent(block["content"]))]);
      const query = tools.queryFor(block["tool_use_id"]);
      if (query || sourceIds.length) result.push({ type: "search", ...(query ? { query } : {}), ...(sourceIds.length ? { sources: sourceIds } : {}) });
    }
    if (type === "tool_use" && !nativePlaced.has(String(block["id"]))) result.push(...takeNative(String(block["id"])));
    return result;
  };

  const emittedInline = new Set<string>();
  let pageToolsEmitted = false;
  const appendRich = (html: string): void => {
    let marker = "CLOUDIG_CLAUDE_MEDIA_";
    while (html.includes(marker)) marker += "_";
    const projected: JsonObject[][] = [];
    const fragment = parseFragment(html);
    resources.restoreReading(fragment);
    recoverCodeLanguages(fragment);
    const rewrite = (parent: DefaultTreeAdapterTypes.ParentNode): void => {
      parent.childNodes = parent.childNodes.map(child => {
        if (!("tagName" in child)) return child;
        const native = nativeId(child);
        if (native) {
          projected.push(takeNative(native));
          const replacement = defaultTreeAdapter.createTextNode(`\uE000${marker}${projected.length - 1}\uE001`);
          replacement.parentNode = parent; return replacement;
        }
        // Exporters open their process panels to capture them. That capture
        // state is not a request to expand them in Reader; authored <details>
        // without the exporter-specific thinking class retain their own state.
        if (child.tagName === "details" && (attr(child, "class") ?? "").split(/\s+/u).includes("thinking")) {
          child.attrs = child.attrs.filter(attribute => attribute.name !== "open");
        }
        const artifactId = attr(child, "data-osis-artifact-id"), activityKey = attr(child, "data-osis-cowork-activity-key");
        const artifact = artifactId ? artifactsById.get(artifactId) : undefined;
        const thinking = activityKey ? inlineThinking.get(activityKey) : undefined;
        if (artifact || thinking) {
          const replacementBlocks: JsonObject[] = artifact ? takeArtifact(artifact) : [];
          if (thinking && activityKey && !emittedInline.has(activityKey)) {
            emittedInline.add(activityKey);
            const value = publicThinking(thinking, limitations, `/messages/${messageIndex}/content/${content.length}`);
            if (value) replacementBlocks.push(value);
            if (!pageToolsEmitted) {
              pageToolsEmitted = true;
              for (const raw of pageTools) replacementBlocks.push(...projectTool(object(raw)!));
            }
          }
          projected.push(replacementBlocks);
          const replacement = defaultTreeAdapter.createTextNode(`\uE000${marker}${projected.length - 1}\uE001`);
          replacement.parentNode = parent;
          return replacement;
        }
        if (child.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).includes("osis-mermaid-card"))) {
          const source = mermaidCardSource(child);
          const imageNode = mermaidCardVisual(child);
          if (source) {
            let rendered: JsonValue | undefined;
            if (imageNode) {
              const attr = (name: string) => imageNode.attrs.find(entry => entry.name === name)?.value;
              const svg = imageNode.tagName === "svg" ? inertStandaloneSvg(serializeOuter(imageNode)) : undefined;
              const image = resources.inlineImage(svg ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` : attr("src") ?? "", attr("data-resource-key"), attr("alt"), media, "diagram");
              if (image.media) usedMedia.add(image.media);
              rendered = image.block["rendered"];
            }
            projected.push([{ type: "diagram", format: "mermaid", source, ...(rendered ? { rendered } : {}) }]);
            const replacement = defaultTreeAdapter.createTextNode(`\uE000${marker}${projected.length - 1}\uE001`);
            replacement.parentNode = parent;
            return replacement;
          }
        }
        if (child.tagName === "img") {
          const attr = (name: string) => child.attrs.find(entry => entry.name === name)?.value;
          const image = resources.inlineImage(attr("src") ?? "", attr("data-resource-key"), attr("alt"), media);
          if (image.media) usedMedia.add(image.media);
          const nested = preserveNestedImage(parent, child, image.block);
          if (nested) { nested.parentNode = parent; return nested; }
          projected.push([image.block]);
          const replacement = defaultTreeAdapter.createTextNode(`\uE000${marker}${projected.length - 1}\uE001`);
          replacement.parentNode = parent;
          return replacement;
        }
        rewrite(child); return child;
      });
    };
    rewrite(fragment);
    const serialized = serialize(fragment);
    for (const piece of serialized.split(new RegExp(`(\\uE000${marker}[0-9]+\\uE001)`, "u"))) {
      const match = new RegExp(`^\\uE000${marker}([0-9]+)\\uE001$`, "u").exec(piece);
      if (match) content.push(...projected[Number(match[1])]!);
      else {
        const inert = inertHtmlFragment(piece);
        if (!inert) continue;
        const node = parseFragment(inert);
        // Splitting captured inline placeholders can leave empty ancestor
        // shells. They are not content and must not become a blank excerpt.
        if (plain(node).trim() || elements(node).some(n => ["hr", "br", "svg", "math", "table", "img"].includes(n.tagName))) content.push({ type: "html", html: inert });
      }
    }
  };

  // Light keeps a lossy DOM text projection in `markdown`; its saved reading
  // surface has the actual headings, formulas and code. Pair only exact owner
  // and one-for-one visible text panels, never guess across messages/branches.
  const hasClass = (node: DefaultTreeAdapterTypes.ChildNode, name: string): node is DefaultTreeAdapterTypes.Element =>
    "tagName" in node && node.attrs.some(attr => attr.name === "class" && attr.value.split(/\s+/u).includes(name));
  const capturedText = input.readingHtml ? parseFragment(input.readingHtml).childNodes.flatMap(node => {
    if (hasClass(node, "markdown")) return [serialize(node)];
    // User reading bodies have one extra bubble wrapper. Keep exact panel
    // count/ownership checks; never select nested code, tools or another turn.
    return message["role"] === "user" && hasClass(node, "user-bubble")
      ? node.childNodes.filter(child => hasClass(child, "markdown")).map(child => serialize(child as DefaultTreeAdapterTypes.Element)) : [];
  }) : [];
  const visibleText = blocks.filter(raw => object(raw)?.["type"] === "text" && object(raw)?.["reading_surface_visible"] !== false);
  const useCapturedText = capturedText.length > 0 && capturedText.length === visibleText.length;
  let visibleTextIndex = 0;
  const toolKey = (raw: JsonValue) => { const block = object(raw); return block ? `${block["type"]}:${block["id"] ?? block["tool_use_id"] ?? ""}` : ""; };
  const existingTools = new Set(blocks.filter(raw => ["tool_use", "tool_result"].includes(String(object(raw)?.["type"]))).map(toolKey));
  const pageTools = values(message["cowork_page_tools"]).filter(raw => {
    const block = object(raw);
    if (!block || !["tool_use", "tool_result"].includes(String(block["type"]))) return false;
    const key = toolKey(raw); if (existingTools.has(key)) return false;
    existingTools.add(key); return true;
  });
  const firstAnswer = blocks.findIndex(raw => object(raw)?.["type"] === "text" && object(raw)?.["reading_surface_visible"] !== false);
  if (inlineThinking.size === 0) blocks.splice(firstAnswer < 0 ? blocks.length : firstAnswer, 0, ...pageTools);
  for (const raw of blocks) {
    const block = object(raw);
    if (!block) throw new TypeError("Claude content block is not an object");
    const type = text(block["type"]);
    if (type === "text") {
      appendPlacedArtifacts(textIndex);
      for (const entry of beforeText.get(textIndex) ?? []) appendMedia(entry);
      if (block["reading_surface_visible"] === false) { textIndex += 1; continue; }
      const markdown = text(block["markdown"]);
      const rich = text(block["rich_html"]) ?? (useCapturedText ? capturedText[visibleTextIndex] : undefined);
      visibleTextIndex += 1;
      if (rich) {
        appendRich(rich);
      } else if (markdown) {
        content.push(...projectMarkdownWithDiagrams(markdown, () => {
          const entry = diagrams.find((candidate) => !usedMedia.has(candidate));
          if (!entry) return undefined;
          usedMedia.add(entry);
          return resources.diagramResource(entry);
        }));
      }
      const citationIds = sources.addCitationList(block["citations"]);
      if (citationIds.length > 0) content.push({ type: "citations", sources: citationIds });
      textIndex += 1;
    } else if (type === "thinking") {
      if (inlineThinking.has(disclosureKey(block) ?? "")) continue;
      const thinking = publicThinking(block, limitations, `/messages/${messageIndex}/content/${content.length}`);
      if (thinking) content.push(thinking);
    } else if (type === "tool_use" || type === "tool_result") {
      content.push(...projectTool(block));
      if (type === "tool_result") appendArtifacts(block["tool_use_id"]);
    } else if (type === "error" || type === "api_error") {
      content.push({ type: "unknown", kind: type, text: text(block["text"] ?? block["message"]) ?? canonicalizeJcs(block) });
    } else {
      const markdown = text(block["markdown"] ?? block["text"] ?? block["message"]);
      const html = !markdown ? inertHtmlFragment(text(block["rich_html"]) ?? "") : undefined;
      if (markdown) content.push({ type: "unknown", kind: "claude-visible-block", text: markdown });
      else if (html) content.push({ type: "html", html, label: type ?? "Claude" });
    }
  }

  appendPlacedArtifacts(textIndex);
  if (inlineThinking.size > 0 && !pageToolsEmitted) for (const raw of pageTools) content.push(...projectTool(object(raw)!));
  for (const entries of [...beforeText.entries()].sort((left, right) => left[0] - right[0])) {
    if (entries[0] >= textIndex) for (const entry of entries[1]) appendMedia(entry);
  }
  for (const entry of media) appendMedia(entry);
  for (const id of nativeViews.keys()) content.push(...takeNative(id));
  for (const artifact of input.artifacts) {
    if (usedArtifacts.has(artifact)) continue;
    const projected = takeArtifact(artifact);
    // New Cowork placeholders distinguish published cards from Write/Read
    // working records. Preserve unplaced bytes inside a process fold, not as
    // another published document at the end of the answer.
    if (inlineKeys.size > 0) {
      const resource = projected.find(block => block["type"] === "attachment")?.["resource"];
      content.push({ type: "tool", kind: "activity", title: text(artifact["path"] ?? artifact["name"]) ?? "File",
        ...(text(artifact["source"]) ? { output: artifact["source"]! } : {}),
        ...(resource ? { output_resource: resource } : {}) });
    }
    else content.push(...projected);
  }

  const activity = text(message["public_activity_summary"]);
  if (activity && !content.some((entry) => [entry["text"], entry["title"]].some((value) => value === activity))) {
    const thinking = content.filter((entry) => entry["type"] === "reasoning" || entry["type"] === "reasoning_summary");
    // A pure thinking panel's public heading belongs to that same fold. It is
    // not an additional empty tool event. Keep real/mixed tool activity separate.
    if (thinking.length === 1 && !thinking[0]!["title"] && !content.some((entry) => entry["type"] === "tool")) {
      thinking[0]!["title"] = activity;
    } else content.unshift({ type: "tool", kind: "activity", title: activity });
  }
  return content;
}

async function parseClaudeWeb(context: AdapterParseContext, profile: Profile, payloadName: string): Promise<JsonObject> {
  const limitations: JsonObject[] = [];
  const sources = new ClaudeSourcePool();
  const tools = new ClaudeToolPool();
  const resources = new ClaudeResourcePool(context, profile);
  const reading = new Map((context.reading?.fragments ?? []).map(fragment => [fragment.messageId, fragment.html]));
  const ordered = orderedMessages(context.payload, profile);
  const cowork = object(context.payload["conversation"])?.["entry_surface"] === "cowork";
  const mounted = cowork ? values(context.payload["mounted_dom_articles"]).flatMap(value => object(value) ? [object(value)!] : []) : [];
  const local = new Map<string, string>();
  for (const [index, message] of ordered.entries()) local.set(text(message["id"])!, `m${index + 1}`);
  const allArtifacts = values(context.payload["artifacts"]).flatMap((raw) => {
    const artifact = object(raw);
    return artifact ? [artifact] : [];
  });
  const artifactsByMessage = new Map<string, JsonObject[]>();
  for (const artifact of allArtifacts) {
    const owner = text(artifact["message_id"]);
    if (owner) artifactsByMessage.set(owner, [...(artifactsByMessage.get(owner) ?? []), artifact]);
  }

  const messages: JsonObject[] = [];
  const modelValues: string[] = [];
  let missingParents = 0;
  for (const [index, source] of ordered.entries()) {
    const sourceId = text(source["id"])!;
    const parentId = text(source["parent_id"]);
    const parent = profile === "tree" && parentId && parentId !== NIL_PARENT ? local.get(parentId) : undefined;
    if (profile === "tree" && parentId && parentId !== NIL_PARENT && !parent) missingParents += 1;
    const roleValue = text(source["role"]);
    const role = roleValue === "user" || roleValue === "assistant" || roleValue === "system" || roleValue === "tool"
      ? roleValue
      : "other";
    const messageModel = sourceMessageModel(source);
    const recordParent = profile === "tree" ? parentId && parentId !== NIL_PARENT ? parentId : undefined : index > 0 ? text(ordered[index - 1]!["id"]) : undefined;
    context.record?.message(index, { id: sourceId, ...(recordParent ? { parent: recordParent } : {}), role,
      ...(messageModel ? { model: messageModel } : {}) });
    // This is only a language witness, never a replacement body. Require the
    // source-declared Cowork ordinal, role and timestamp, then exact code text.
    const witness = mounted.filter(article => article["aria_posinset"] === Number(source["index"]) + 1
      && article["role"] === source["role"] && article["created_at"] === source["created_at"]);
    if (messageModel) modelValues.push(messageModel);
    messages.push({
      ...(profile === "tree" ? { id: local.get(sourceId)!, ...(parent ? { parent } : {}) } : {}),
      role,
      ...(role === "other" ? { name: roleValue ?? "Claude" } : {}),
      ...(messageModel ? { model: messageModel } : {}),
      ...(timestamp(source["created_at"]) ? { timestamp: timestamp(source["created_at"])! } : {}),
      content: projectMessageContent({
        message: source,
        messageIndex: index,
        resources,
        sources,
        tools,
        artifacts: artifactsByMessage.get(sourceId) ?? [],
        limitations,
        ...(witness.length === 1 && text(witness[0]!["outer_html"]) ? { mountedHtml: text(witness[0]!["outer_html"])! } : {}),
        ...(reading.has(sourceId) ? { readingHtml: reading.get(sourceId)! } : {})
      })
    });
    await context.onProgress?.(index + 1, ordered.length);
  }
  if (missingParents > 0) limitations.push({
    code: "claude-source-parent-omitted",
    detail: `${missingParents} Claude parent references are absent; their children remain branch roots`
  });

  const conversation = object(context.payload["conversation"]);
  const manifestSource = object(context.manifest["source"]);
  const exporter = object(context.manifest["exporter"]);
  const capturedAt = timestamp(context.manifest["exported_at"] ?? context.payload["exported_at"])
    ?? context.source.fileSystemCapturedAt;
  const messageTimes = messages.flatMap((message) => text(message["timestamp"]) ? [text(message["timestamp"])!] : []);
  const orderedMessageTimes = deduplicate(messageTimes).sort();
  const firstMessageAt = messageTimes[0];
  const currentSourceId = text(context.payload["current_leaf_message_id"]);
  const current = currentSourceId ? local.get(currentSourceId) : undefined;
  // The current selection remains in the source HTML. Do not promote it to
  // models/Front or the generic whole-conversation model fallback.
  if (currentSourceId && local.has(currentSourceId)) context.record?.current(currentSourceId);
  const models = deduplicate(modelValues);
  const sourceUrl = httpUrl(manifestSource?.["url"] ?? context.payload["source_url"]);
  const title = text(conversation?.["title"] ?? manifestSource?.["title"]);
  const locator = text(manifestSource?.["conversation_id"] ?? conversation?.["id"]);
  const exporterVersion = text(exporter?.["version"] ?? context.manifest["exporter_version"]);
  const conversationCreatedAt = timestamp(conversation?.["created_at"]);
  const conversationUpdatedAt = timestamp(conversation?.["updated_at"]);
  const uniqueLimitations = [...new Set(limitations.map((entry) => canonicalizeJcs(entry)))].map((entry) => JSON.parse(entry) as JsonObject);
  return {
    source: {
      file: context.source.file,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      format: "exporter-html",
      payload: payloadName.replaceAll("/", "."),
      profile,
      ...(exporterVersion ? { exporter: { id: "claude-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(locator ? { locator: { kind: "exporter_conversation_key", value: locator } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {}),
      ...(conversationCreatedAt ? { conversation_created_at: conversationCreatedAt } : {}),
      ...(conversationUpdatedAt ? { conversation_updated_at: conversationUpdatedAt } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "anthropic",
    platform: "claude",
    ...(title ? { title } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(orderedMessageTimes.length > 0 ? {
      message_time: {
        start: orderedMessageTimes[0]!,
        ...(orderedMessageTimes.length > 1 ? { end: orderedMessageTimes.at(-1)! } : {})
      }
    } : {}),
    ...(profile === "tree" && current ? { current_message: current } : {}),
    messages,
    ...(resources.values.length > 0 ? { resources: resources.values } : {}),
    ...(sources.values.length > 0 ? { sources: sources.values } : {}),
    ...(uniqueLimitations.length > 0 ? { limitations: uniqueLimitations } : {})
  };
}

export const CLAUDE_LIGHT_MANIFEST: AdapterManifest = {
  id: "claude-light-dom-v1",
  version: "3.0.10",
  family: "claude",
  routes: [{ format: "exporter-html", platform: "claude", payload: "osis.claude.chat-export/light-dom-v1", profile: "light" }],
  target: "cloudig/conversation/1.0.1",
  update_from: ["2.0.0", "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.0.5", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6", "3.0.7", "3.0.8", "3.0.9"].map(version => ({ adapter: "claude-light-dom-v1", version, action: "reparse_source" as const }))
};

export const CLAUDE_FULL_MANIFEST: AdapterManifest = {
  id: "claude-full-capture-v1",
  version: "3.0.9",
  family: "claude",
  routes: [{ format: "exporter-html", platform: "claude", payload: "osis.claude.chat-export/full-capture-v1", profile: "full" }],
  target: "cloudig/conversation/1.0.1",
  update_from: ["2.0.0", "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.0.5", "2.0.6", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6", "3.0.7", "3.0.8"].map(version => ({ adapter: "claude-full-capture-v1", version, action: "reparse_source" as const }))
};

export const CLAUDE_TREE_MANIFEST: AdapterManifest = {
  id: "claude-all-branches-v1",
  version: "3.0.9",
  family: "claude",
  routes: [{ format: "exporter-html", platform: "claude", payload: "osis.claude.chat-export/all-branches-v1", profile: "tree" }],
  target: "cloudig/conversation/1.0.1",
  update_from: ["2.0.0", "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.0.5", "2.0.6", "3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4", "3.0.5", "3.0.6", "3.0.7", "3.0.8"].map(version => ({ adapter: "claude-all-branches-v1", version, action: "reparse_source" as const }))
};

export const claudeLightAdapter: SourceAdapter = Object.freeze({
  manifest: CLAUDE_LIGHT_MANIFEST,
  parse: (context) => parseClaudeWeb(context, "light", "osis.claude.chat-export/light-dom-v1")
});

export const claudeFullAdapter: SourceAdapter = Object.freeze({
  manifest: CLAUDE_FULL_MANIFEST,
  readingEvidence: "none",
  parse: (context) => parseClaudeWeb(context, "full", "osis.claude.chat-export/full-capture-v1")
});

export const claudeTreeAdapter: SourceAdapter = Object.freeze({
  manifest: CLAUDE_TREE_MANIFEST,
  readingEvidence: "none",
  parse: (context) => parseClaudeWeb(context, "tree", "osis.claude.chat-export/all-branches-v1")
});
