import { createHash } from "node:crypto";

import { orderJson } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { projectClaudeOfficialCard } from "./claude-official-cards.mts";

function text(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized || undefined;
}

// Source bodies are not labels: indentation, blank lines and trailing spaces
// can be meaningful Markdown/code. Keep them without metadata normalization.
function bodyText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: JsonValue | undefined): string | undefined {
  const raw = text(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function nonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function mime(value: JsonValue | undefined): string | undefined {
  const raw = text(value)?.toLowerCase();
  return raw && /^[^\s/]+\/[^\s/]+$/u.test(raw) ? raw : undefined;
}

function httpUrl(value: JsonValue | undefined): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return /^[a-z]/u.test(normalized) ? normalized.slice(0, 128) : `claude-${normalized || "unknown"}`.slice(0, 128);
}

function readableJson(value: JsonValue): string {
  return JSON.stringify(orderJson(value), null, 2);
}


export function claudeRecordSelector(uuid: string): string {
  const value = uuid.trim();
  if (!value) throw new TypeError("Claude export record UUID is empty");
  return createHash("sha256").update("cloudig:claude-export-record:", "utf8").update(value, "utf8").digest("hex");
}

class SourcePool {
  readonly values: JsonObject[] = [];
  readonly #byContent = new Map<string, string>();

  add(raw: JsonObject): string | undefined {
    const details = isJsonObject(raw["details"]) ? raw["details"] : undefined;
    const url = httpUrl(details?.["url"] ?? raw["url"]);
    if (!url) return undefined;
    const title = text(details?.["title"] ?? details?.["name"] ?? raw["title"]);
    const snippet = bodyText(details?.["snippet"] ?? details?.["cited_text"] ?? raw["snippet"]);
    const key = JSON.stringify([url, title ?? null, snippet ?? null]);
    const existing = this.#byContent.get(key);
    if (existing) return existing;
    const id = `s${this.values.length + 1}`;
    this.#byContent.set(key, id);
    this.values.push({
      id,
      kind: "web",
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {})
    });
    return id;
  }
}

class ResourcePool {
  readonly values: JsonObject[] = [];
  readonly #byFileUuid = new Map<string, string>();

  addAttachment(raw: JsonObject, extractedText?: string): JsonObject {
    const id = `r${this.values.length + 1}`;
    this.values.push({
      id,
      kind: "file",
      availability: "metadata_only",
      name: text(raw["file_name"]) ?? "Unnamed Claude attachment",
      ...(mime(raw["file_type"]) ? { mime: mime(raw["file_type"])! } : {}),
      ...(nonNegativeInteger(raw["file_size"]) !== undefined ? { bytes: nonNegativeInteger(raw["file_size"])! } : {})
    });
    return { type: "attachment", resource: id, ...(extractedText ? { text: extractedText } : {}) };
  }

  addFile(raw: JsonObject): JsonObject {
    const uuid = text(raw["file_uuid"]);
    const known = uuid ? this.#byFileUuid.get(uuid) : undefined;
    if (known) return { type: "attachment", resource: known };
    const id = `r${this.values.length + 1}`;
    if (uuid) this.#byFileUuid.set(uuid, id);
    this.values.push({
      id,
      kind: "file",
      availability: "metadata_only",
      name: text(raw["file_name"]) ?? "Unnamed Claude file"
    });
    return { type: "attachment", resource: id };
  }

  addOfficial(raw: Readonly<{ id: string; name?: string; url: string; mime?: string; width?: number; height?: number }>): string {
    const existing = this.values.find(value => value["kind"] === "image" && value["url"] === raw.url);
    if (existing && typeof existing["id"] === "string") return existing["id"];
    // Card-local ids are only hints from the export. Allocate conversation-wide
    // resource ids here so two image galleries cannot point at the same rN by
    // accident when each gallery starts counting at card-image-1.
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, kind: "image", availability: "external", url: raw.url,
      ...(raw.name ? { name: raw.name } : {}), ...(raw.mime ? { mime: raw.mime } : {}),
      ...(raw.width !== undefined && raw.height !== undefined ? { dimensions: { width: raw.width, height: raw.height } } : {}) });
    return id;
  }
}

class ToolPool {
  readonly #ids = new Map<string, string>();
  readonly #calls = new Map<string, JsonObject>();

  id(raw: JsonValue | undefined): string | undefined {
    const source = text(raw);
    if (!source) return undefined;
    const existing = this.#ids.get(source);
    if (existing) return existing;
    const id = `x${this.#ids.size + 1}`;
    this.#ids.set(source, id);
    return id;
  }

  remember(raw: JsonObject, call: string | undefined): void { if (call) this.#calls.set(call, raw); }
  call(value: JsonValue | undefined): JsonObject | undefined { const key = text(value); return key ? this.#calls.get(key) : undefined; }
}

function duration(raw: JsonObject): number | undefined {
  const start = timestamp(raw["start_timestamp"]);
  const end = timestamp(raw["stop_timestamp"]);
  if (!start || !end) return undefined;
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Number(seconds.toFixed(3)) : undefined;
}

function textContent(raw: JsonObject, sources: SourcePool): JsonObject[] {
  const result: JsonObject[] = [];
  const body = bodyText(raw["text"]);
  if (body) result.push({ type: "markdown", text: body });
  const sourceIds = Array.isArray(raw["citations"])
    ? raw["citations"].flatMap((citation) => {
      const id = isJsonObject(citation) ? sources.add(citation) : undefined;
      return id ? [id] : [];
    })
    : [];
  const unique = [...new Set(sourceIds)];
  if (unique.length > 0) result.push({ type: "citations", sources: unique, label: "Claude citations" });
  return result;
}

function thinkingContent(raw: JsonObject): JsonObject[] {
  if (raw["hidden"] === true) return [];
  const result: JsonObject[] = [];
  const thinking = raw["thinking_hidden"] === true ? undefined : bodyText(raw["thinking"]);
  const elapsed = duration(raw);
  if (thinking) result.push({
    type: "reasoning",
    text: thinking,
    format: "markdown",
    ...(elapsed !== undefined ? { duration: elapsed } : {})
  });
  if (Array.isArray(raw["summaries"])) {
    for (const summary of raw["summaries"]) {
      const value = typeof summary === "string"
        ? bodyText(summary)
        : isJsonObject(summary)
          ? bodyText(summary["summary"] ?? summary["text"] ?? summary["content"])
          : undefined;
      if (value) result.push({ type: "reasoning_summary", text: value, format: "text" });
    }
  }
  return result;
}

function toolContent(raw: JsonObject, tools: ToolPool, resources: ResourcePool): JsonObject[] {
  if (raw["hidden_in_chat"] === true) return [];
  const type = text(raw["type"]);
  const call = tools.id(type === "tool_use" ? raw["id"] : raw["tool_use_id"]);
  const name = text(raw["name"] ?? raw["integration_name"]) ?? "Claude tool";
  if (type === "tool_use") {
    tools.remember(raw, call);
    const tool: JsonObject = {
    type: "tool",
    kind: "call",
    ...(call ? { call } : {}),
    name,
    ...(raw["input"] !== undefined ? { input: raw["input"]! } : {}),
    ...(text(raw["message"]) ? { title: text(raw["message"])! } : {}),
    ...(duration(raw) !== undefined ? { duration: duration(raw)! } : {})
    };
    return [tool, ...projectOfficialCards(raw, raw, undefined, resources)];
  }
  if (type !== "tool_result") return [];
  const outputParts: JsonObject = {};
  for (const key of ["content", "structured_content", "meta", "display_content"] as const) {
    if (raw[key] !== undefined) outputParts[key] = raw[key]!;
  }
  const outputKeys = Object.keys(outputParts);
  const output = outputKeys.length === 0 ? undefined : outputKeys.length === 1 ? outputParts[outputKeys[0]!]! : outputParts;
  const tool: JsonObject = {
    type: "tool",
    kind: "result",
    ...(call ? { call } : {}),
    name,
    ...(output !== undefined ? { output } : {}),
    success: raw["is_error"] !== true,
    ...(text(raw["message"]) ? { title: text(raw["message"])! } : {}),
    ...(duration(raw) !== undefined ? { duration: duration(raw)! } : {})
  };
  return [tool, ...projectOfficialCards(raw, tools.call(raw["tool_use_id"]), output, resources)];
}

const officialCardTypes = new Set(["single_select", "table", "code_block", "json_block", "rich_link", "rich_content", "image_gallery", "local_resource"]);

function officialDisplays(raw: JsonObject): JsonObject[] {
  const displays: JsonObject[] = [];
  const add = (value: JsonValue | undefined) => {
    if (isJsonObject(value)) {
      const type = text(value["type"]);
      if (type && officialCardTypes.has(type) && !displays.some(existing => JSON.stringify(existing) === JSON.stringify(value))) displays.push(value);
    } else if (Array.isArray(value)) for (const item of value) add(item);
  };
  add(raw["display_content"]);
  // Account exports put some native Cards directly in the tool result's
  // content array, unlike the bookmark payload's display_content envelope.
  // Project only known Card discriminators; ordinary text/tool payloads remain
  // in the original folded tool block and are never duplicated as Cards.
  if (Array.isArray(raw["content"])) for (const item of raw["content"]) add(item);
  return displays;
}

function projectOfficialCards(raw: JsonObject, call: JsonObject | undefined, result: JsonValue | undefined, resources: ResourcePool): JsonObject[] {
  return officialDisplays(raw).flatMap(display => {
    const card = projectClaudeOfficialCard(display, call, result);
    return card ? [remapOfficialCardResources(card.block, card.resources, resources)] : [];
  });
}

function remapOfficialCardResources(block: JsonObject, resources: readonly { id: string; name?: string; url: string; mime?: string; width?: number; height?: number }[], pool: ResourcePool): JsonObject {
  if (resources.length === 0) return block;
  const ids = new Map(resources.map(resource => [resource.id, pool.addOfficial(resource)]));
  const files = Array.isArray(block["files"])
    ? block["files"].filter(isJsonObject).map(file => {
      const reference = text(file["resource"]);
      return reference && ids.has(reference) ? { ...file, resource: ids.get(reference)! } : file;
    })
    : undefined;
  return files ? { ...block, files } : block;
}

function otherContent(raw: JsonObject): JsonObject | undefined {
  const type = text(raw["type"]) ?? "unknown";
  // Official exports include model-input context next to the human's text.
  // Preserve the prompt, not its JSON transport envelope, as a folded process.
  if (type === "injected_prompt_block" && bodyText(raw["prompt"])) {
    const source = text(raw["injection_source"]);
    const titles: Readonly<Record<string, string>> = {
      memory_block_head: "Claude memory snapshot",
      melange_tombstone: "Claude memory update",
      date_note: "Claude date context"
    };
    return { type: "status", title: (source && titles[source]) || `Claude platform context${source ? ` · ${source}` : ""}`,
      text: bodyText(raw["prompt"])!, format: "text" };
  }
  // An error in an official conversation is source content, not a Cloudig
  // diagnostic. Keep it through the normal unknown-content fallback.
  if (type === "flag") {
    // The discriminator proves platform authorship; a new flag value does not
    // need a new parser. Keep every accompanying field, not just the flag code.
    const { type: _type, start_timestamp: _start, stop_timestamp: _stop, ...details } = raw;
    return { type: "status", title: "Claude platform flag", text: readableJson(details), format: "text" };
  }
  if (type === "token_budget") {
    return raw["remaining"] === undefined || raw["remaining"] === null
      ? undefined
      : { type: "status", title: "Claude token budget", text: String(raw["remaining"]) };
  }
  const body = bodyText(raw["text"]) ?? readableJson(raw);
  return body ? { type: "unknown", kind: slug(type), text: body } : undefined;
}

/** Claude's flattened text substitutes this fence for structured process blocks. */
function onlyUnsupportedPlaceholders(value: string): boolean {
  // Consume one fixed fence at a time: a repeated whitespace-bearing group can
  // backtrack exponentially when many placeholders end in real prose.
  const fence = /\s*```\r?\nThis block is not supported on your current device yet\.\r?\n```\s*/uy;
  let end = 0;
  while (end < value.length) {
    if (!fence.exec(value)) return false;
    end = fence.lastIndex;
  }
  return end > 0;
}

/** Source inventory only; do not confuse empty exported slots with parse failures. */
export function claudeMessageIsEmpty(raw: JsonObject): boolean {
  return !bodyText(raw["text"])
    && !["content", "attachments", "files"].some(key => Array.isArray(raw[key]) && raw[key].length > 0);
}

function parentFirst(rawMessages: JsonValue[], limitations: JsonObject[]): Readonly<{
  ordered: JsonObject[];
  localIds: ReadonlyMap<JsonObject, string>;
  sourceIds: ReadonlyMap<string, JsonObject>;
}> {
  if (rawMessages.some((entry) => !isJsonObject(entry))) throw new TypeError("Claude export record contains a non-object message");
  const messages = rawMessages.filter((entry): entry is JsonObject => isJsonObject(entry));
  const byId = new Map<string, JsonObject>();
  for (const message of messages) {
    const id = text(message["uuid"]);
    if (!id) continue;
    if (byId.has(id)) throw new TypeError("Claude export record contains a duplicate message UUID");
    byId.set(id, message);
  }
  const children = new Map<JsonObject, JsonObject[]>();
  const roots: JsonObject[] = [];
  let missingParents = 0;
  for (const message of messages) {
    const parent = text(message["parent_message_uuid"]);
    const parentMessage = parent ? byId.get(parent) : undefined;
    if (!parentMessage) {
      roots.push(message);
      if (parent) missingParents += 1;
    } else {
      const values = children.get(parentMessage) ?? [];
      values.push(message);
      children.set(parentMessage, values);
    }
  }
  if (missingParents > 0) limitations.push({
    code: "source_parent_omitted",
    detail: `${missingParents} Claude message parent references are absent; their children remain branch roots`
  });
  const ordered: JsonObject[] = [];
  const visiting = new Set<JsonObject>();
  const done = new Set<JsonObject>();
  const visit = (message: JsonObject): void => {
    if (done.has(message)) return;
    if (visiting.has(message)) throw new TypeError("Claude export record contains a message cycle");
    visiting.add(message);
    ordered.push(message);
    for (const child of children.get(message) ?? []) visit(child);
    visiting.delete(message);
    done.add(message);
  };
  for (const root of roots) visit(root);
  if (ordered.length !== messages.length) throw new TypeError("Claude export record has no complete parent-first traversal");
  return {
    ordered,
    localIds: new Map(ordered.map((message, index) => [message, `m${index + 1}`])),
    sourceIds: byId
  };
}

export function claudeRecordToDraft(input: Readonly<{
  record: JsonObject;
  selector: string;
  source: Readonly<{
    file: string;
    bytes: number;
    sha256: string;
    capturedAt?: string;
  }>;
  onProgress?: (completed: number, total: number) => void;
  onSourceMessage?: (message: JsonObject, index: number) => void;
  onSystemContent?: (block: JsonObject) => void;
}>): JsonObject {
  if (typeof input.record["uuid"] !== "string" || !Array.isArray(input.record["chat_messages"])) {
    throw new TypeError("Selected Claude export record has no supported uuid/chat_messages shape");
  }
  const limitations: JsonObject[] = [];
  const sourcePool = new SourcePool();
  const resourcePool = new ResourcePool();
  const tools = new ToolPool();
  const topology = parentFirst(input.record["chat_messages"], limitations);
  const messages: JsonObject[] = [];
  const models: string[] = [];
  let emptyMessages = 0;
  for (const [index, raw] of topology.ordered.entries()) {
    input.onSourceMessage?.(raw, index);
    const content: JsonObject[] = [];
    let sawText = false;
    if (Array.isArray(raw["content"])) {
      for (const block of raw["content"]) {
        if (!isJsonObject(block)) continue;
        const type = text(block["type"]);
        if (type === "text") {
          sawText = true;
          content.push(...textContent(block, sourcePool));
        } else if (type === "thinking") {
          content.push(...thinkingContent(block));
        } else if (type === "tool_use" || type === "tool_result") {
          content.push(...toolContent(block, tools, resourcePool));
        } else {
          const other = otherContent(block);
          if (other) {
            content.push(other);
            if (type && ["injected_prompt_block", "flag", "token_budget"].includes(type)) input.onSystemContent?.(other);
          }
        }
      }
    }
    const fallbackText = bodyText(raw["text"]);
    // Only suppress the generated summary when the actual non-text parts have
    // been retained. Literal user/text blocks, mixed prose and text-only exports
    // remain untouched, including an author quoting this same sentence.
    const coveredPlaceholder = raw["sender"] === "assistant" && content.length > 0
      && fallbackText !== undefined && onlyUnsupportedPlaceholders(fallbackText);
    if (!sawText && fallbackText && !coveredPlaceholder) content.unshift({ type: "markdown", text: fallbackText });
    if (Array.isArray(raw["attachments"])) {
      for (const attachment of raw["attachments"]) {
        if (isJsonObject(attachment)) content.push(resourcePool.addAttachment(attachment, bodyText(attachment["extracted_content"])));
      }
    }
    if (Array.isArray(raw["files"])) {
      for (const file of raw["files"]) if (isJsonObject(file)) content.push(resourcePool.addFile(file));
    }
    if (content.length === 0) emptyMessages += 1;
    const sourceParent = text(raw["parent_message_uuid"]);
    const parentMessage = sourceParent ? topology.sourceIds.get(sourceParent) : undefined;
    const model = text(raw["model"] ?? raw["model_name"] ?? raw["model_slug"]);
    if (model && !models.includes(model)) models.push(model);
    const sender = text(raw["sender"]);
    const role = sender === "human" ? "user" : sender === "assistant" ? "assistant" : "other";
    messages.push({
      id: topology.localIds.get(raw)!,
      ...(parentMessage && topology.localIds.has(parentMessage) ? { parent: topology.localIds.get(parentMessage)! } : {}),
      role,
      ...(role === "other" ? { name: sender ?? "Claude" } : {}),
      ...(model ? { model } : {}),
      ...(timestamp(raw["created_at"]) ? { timestamp: timestamp(raw["created_at"])! } : {}),
      content
    });
    input.onProgress?.(index + 1, topology.ordered.length);
  }
  if (emptyMessages > 0) limitations.push({
    code: "source_message_empty",
    detail: `${emptyMessages} Claude messages contain no visible exported body; their positions and branch links remain`
  });
  const messageTimes = messages.flatMap((message) => typeof message["timestamp"] === "string" ? [message["timestamp"] as string] : []).sort();
  const createdAt = timestamp(input.record["created_at"]);
  const updatedAt = timestamp(input.record["updated_at"]);
  return {
    source: {
      file: input.source.file,
      sha256: input.source.sha256,
      bytes: input.source.bytes,
      format: "json-container",
      payload: "anthropic.claude-conversations-export",
      profile: "container",
      locator: { kind: "account_export_record", value: input.selector },
      ...(input.source.capturedAt ? { captured_at: { value: input.source.capturedAt, basis: "file_system_earliest" } } : {}),
      ...(createdAt ? { conversation_created_at: createdAt } : {}),
      ...(updatedAt ? { conversation_updated_at: updatedAt } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "anthropic",
    platform: "claude",
    ...(text(input.record["name"]) ? { title: text(input.record["name"])! } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(messageTimes.length > 0 ? { message_time: { start: messageTimes[0]!, ...(messageTimes.at(-1) !== messageTimes[0] ? { end: messageTimes.at(-1)! } : {}) } } : {}),
    messages,
    ...(resourcePool.values.length > 0 ? { resources: resourcePool.values } : {}),
    ...(sourcePool.values.length > 0 ? { sources: sourcePool.values } : {}),
    ...(limitations.length > 0 ? { limitations } : {})
  };
}
