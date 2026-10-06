import { createHash } from "node:crypto";

import { parseJsonArrayItem, streamTopLevelJsonArray } from "./json-array-stream.mjs";
import { LEGACY_PROJECTION_PARSER_VERSION } from "./index.mjs";
import { parserTimestamp } from "./time.mjs";
import { parserAdapterRecord, parserAdapterVersion } from "./version-history.mjs";

export const CLAUDE_EXPORT_FORMAT = "anthropic/claude-conversations-export";
export const CLAUDE_EXPORT_ADAPTER_ID = "anthropic-claude-export-json";
export const CLAUDE_EXPORT_ADAPTER_VERSION = parserAdapterVersion(CLAUDE_EXPORT_ADAPTER_ID);
export const CLAUDE_CONVERSATION_SCHEMA = "ai-chat-archive/conversation/0.2.5";

function cleanString(value) {
  return typeof value === "string" ? value.replace(/\r\n?/gu, "\n").trim() : "";
}

function stableHash(namespace, value) {
  return createHash("sha256").update(`cloudig:${namespace}:`).update(String(value ?? "")).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function structuredText(value) {
  if (typeof value === "string") return cleanString(value);
  if (value === undefined) return "";
  try {
    return JSON.stringify(stableValue(value), null, 2);
  } catch {
    return cleanString(String(value));
  }
}

function isoTime(value) {
  const text = cleanString(value);
  if (!text || !Number.isFinite(Date.parse(text))) return "";
  return new Date(text).toISOString();
}

function durationSeconds(start, stop) {
  const first = Date.parse(cleanString(start));
  const last = Date.parse(cleanString(stop));
  const seconds = (last - first) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Number(seconds.toFixed(3)) : undefined;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function mimeType(value) {
  const text = cleanString(value).toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(text) ? text : "";
}

function firstNamedString(value, names) {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key.toLowerCase()) && typeof child === "string" && cleanString(child)) return cleanString(child);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = firstNamedString(child, names);
      if (found) return found;
    }
  }
  return "";
}

function firstHttpUrl(value) {
  if (typeof value === "string" && /^https?:\/\//iu.test(value.trim())) {
    try { return new URL(value.trim()).href; } catch { return ""; }
  }
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)(?:url|uri|link)(?:_|$)/iu.test(key)) {
      const found = firstHttpUrl(child);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = firstHttpUrl(child);
    if (found) return found;
  }
  return "";
}

function looksLikeClaudeConversation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.uuid !== "string" || typeof value.name !== "string" || !Array.isArray(value.chat_messages)) return false;
  const message = value.chat_messages.find((candidate) => candidate && typeof candidate === "object");
  return !message || (typeof message.uuid === "string"
    && typeof message.sender === "string"
    && Object.prototype.hasOwnProperty.call(message, "parent_message_uuid")
    && Array.isArray(message.content));
}

function topology(chatMessages) {
  const identifiers = new Set(chatMessages.map((message) => cleanString(message?.uuid)).filter(Boolean));
  const childCounts = new Map();
  let orphanParents = 0;
  for (const message of chatMessages) {
    const parent = cleanString(message?.parent_message_uuid);
    if (!parent || !identifiers.has(parent)) {
      if (parent) orphanParents += 1;
      continue;
    }
    childCounts.set(parent, (childCounts.get(parent) || 0) + 1);
  }
  const forkPoints = [...childCounts.values()].filter((count) => count > 1).length;
  const leaves = [...identifiers].filter((identifier) => !childCounts.has(identifier)).length;
  return { forkPoints, leaves, orphanParents };
}

export function claudeConversationKey(uuid) {
  const value = cleanString(uuid);
  if (!value) throw new TypeError("Claude conversation UUID is missing");
  return stableHash("claude-conversation", value);
}

// Compatibility export for old callers only. New persisted data uses conversation_key.
export const claudeConversationId = claudeConversationKey;

export function claudeExportSourceKey(conversation, fallbackSha256 = "") {
  const accountIdentity = cleanString(conversation?.account?.uuid);
  if (accountIdentity) return stableHash("claude-export-source", accountIdentity);
  const fallback = cleanString(fallbackSha256).toLowerCase();
  if (/^[0-9a-f]{64}$/u.test(fallback)) return fallback;
  throw new TypeError("Claude export source identity is unavailable");
}

export function claudeMessageId(uuid) {
  const value = cleanString(uuid);
  if (!value) return "";
  return stableHash("claude-message", value);
}

export function buildClaudeIndexRecord(conversation, item) {
  if (!looksLikeClaudeConversation(conversation)) throw new TypeError(`Claude export item ${item.index} has an invalid conversation shape`);
  const graph = topology(conversation.chat_messages);
  return {
    conversation_key: claudeConversationKey(conversation.uuid),
    offset: item.offset,
    length: item.length,
    item_sha256: createHash("sha256").update(item.raw).digest("hex"),
    title: cleanString(conversation.name) || "Claude conversation",
    created_at: isoTime(conversation.created_at) || undefined,
    updated_at: isoTime(conversation.updated_at) || undefined,
    messages: conversation.chat_messages.length,
    branches: graph.leaves || undefined,
    fork_points: graph.forkPoints || undefined,
    orphan_parents: graph.orphanParents || undefined
  };
}

function addSourceFromCitation(citation, sources, sourceIds) {
  const details = citation?.details;
  const url = firstHttpUrl(details);
  if (!url) return;
  const id = `s:${stableHash("claude-source", url)}`;
  if (!sources.has(id)) {
    const title = firstNamedString(details, new Set(["title", "name", "page_title"]));
    const siteName = firstNamedString(details, new Set(["site_name", "site", "domain"]));
    const snippet = firstNamedString(details, new Set(["snippet", "cited_text", "quote"]));
    sources.set(id, {
      id,
      url,
      title: title || undefined,
      site_name: siteName || undefined,
      snippet: snippet || undefined
    });
  }
  sourceIds.push(id);
}

function addTextBlock(block, content, sources) {
  const text = cleanString(block.text);
  if (text) content.push({ type: "markdown", text });
  const sourceIds = [];
  for (const citation of Array.isArray(block.citations) ? block.citations : []) addSourceFromCitation(citation, sources, sourceIds);
  const unique = [...new Set(sourceIds)];
  if (unique.length) content.push({ type: "citations", source_ids: unique, label: "Claude citations" });
}

function addThinkingBlocks(block, content) {
  const thinking = cleanString(block.thinking);
  const duration = durationSeconds(block.start_timestamp, block.stop_timestamp);
  if (thinking) content.push({
    type: "reasoning",
    text: thinking,
    duration_seconds: duration
  });
  for (const summary of Array.isArray(block.summaries) ? block.summaries : []) {
    const text = typeof summary === "string"
      ? cleanString(summary)
      : firstNamedString(summary, new Set(["summary", "text", "content"]));
    if (text) content.push({ type: "reasoning_summary", text });
  }
}

function callIdentity(value) {
  const text = cleanString(value);
  return text ? `c:${stableHash("claude-tool-call", text)}` : undefined;
}

function addToolBlock(block, content) {
  const name = cleanString(block.name) || cleanString(block.integration_name) || "Claude tool";
  const body = block.type === "tool_use" ? structuredText(block.input) : structuredText(block.content);
  content.push({
    type: "tool",
    kind: block.type === "tool_use" ? "call" : "result",
    call_id: callIdentity(block.id || block.tool_use_id),
    name,
    text: body || cleanString(block.message) || undefined,
    success: block.type === "tool_result" ? block.is_error !== true : undefined
  });
}

function addSpecialBlock(block, content, unknownTypes) {
  if (block.type === "voice_note") {
    content.push({
      type: "unknown",
      label: cleanString(block.title) || "Claude voice note",
      text: cleanString(block.text) || undefined
    });
    return;
  }
  if (block.type === "flag") {
    const body = cleanString(block.flag) || structuredText(block.helpline);
    if (body) content.push({ type: "status", title: "Claude safety flag", text: body });
    return;
  }
  if (block.type === "token_budget") {
    if (block.remaining !== null && block.remaining !== undefined) {
      content.push({ type: "status", title: "Claude token budget", text: String(block.remaining) });
    }
    return;
  }
  unknownTypes.add(cleanString(block.type) || "unknown");
  content.push({
    type: "unknown",
    label: `Claude ${cleanString(block.type) || "content"}`,
    text: structuredText(block)
  });
}

function addMessageResources(conversationUuid, message, messageIndex, content, resources) {
  for (const [index, attachment] of (Array.isArray(message.attachments) ? message.attachments : []).entries()) {
    if (!attachment || typeof attachment !== "object") continue;
    const id = `r:${stableHash("claude-attachment", `${conversationUuid}:${message.uuid || messageIndex}:${index}`)}`;
    resources.push({
      id,
      kind: "attachment",
      availability: "metadata_only",
      name: cleanString(attachment.file_name) || undefined,
      mime_type: mimeType(attachment.file_type) || undefined,
      size_bytes: positiveInteger(attachment.file_size)
    });
    content.push({
      type: "attachment",
      resource_id: id,
      text: cleanString(attachment.extracted_content) || undefined
    });
  }
  for (const [index, file] of (Array.isArray(message.files) ? message.files : []).entries()) {
    if (!file || typeof file !== "object") continue;
    const fileIdentity = cleanString(file.file_uuid) || `${message.uuid || messageIndex}:${index}`;
    const id = `r:${stableHash("claude-file", fileIdentity)}`;
    if (resources.some((resource) => resource.id === id)) continue;
    resources.push({
      id,
      kind: "attachment",
      availability: "metadata_only",
      name: cleanString(file.file_name) || undefined
    });
    content.push({ type: "attachment", resource_id: id });
  }
}

function convertMessage(conversationUuid, message, messageIndex, state) {
  const content = [];
  let hasTextBlock = false;
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      hasTextBlock = true;
      addTextBlock(block, content, state.sources);
    } else if (block.type === "thinking") addThinkingBlocks(block, content);
    else if (block.type === "tool_use" || block.type === "tool_result") addToolBlock(block, content);
    else addSpecialBlock(block, content, state.unknownTypes);
  }
  if (!hasTextBlock && cleanString(message.text)) content.unshift({ type: "markdown", text: cleanString(message.text) });
  addMessageResources(conversationUuid, message, messageIndex, content, state.resources);
  if (!content.length) {
    state.emptyMessages += 1;
    content.push({ type: "status", title: "Claude message", text: "No visible content was included in the export." });
  }
  const id = claudeMessageId(message.uuid) || stableHash("claude-message-position", `${conversationUuid}:${messageIndex}`);
  const parentId = claudeMessageId(message.parent_message_uuid);
  return {
    id,
    parent_id: parentId || undefined,
    turn_id: `turn_${id.slice(0, 32)}`,
    role: message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : "other",
    timestamp: isoTime(message.created_at) || undefined,
    content
  };
}

export function convertClaudeConversation(conversation, context) {
  if (!looksLikeClaudeConversation(conversation)) throw new TypeError("Selected Claude export record is not a supported conversation");
  const state = {
    resources: [],
    sources: new Map(),
    unknownTypes: new Set(),
    emptyMessages: 0
  };
  const messages = conversation.chat_messages.map((message, index) => convertMessage(conversation.uuid, message, index, state));
  if (!messages.length) {
    state.emptyMessages += 1;
    messages.push({
      id: stableHash("claude-empty-conversation", conversation.uuid),
      turn_id: `turn_${stableHash("claude-empty-turn", conversation.uuid).slice(0, 32)}`,
      role: "other",
      content: [{ type: "status", title: "Empty Claude conversation", text: "This exported conversation contains no messages." }]
    });
  }
  const messageIds = new Set(messages.map((message) => message.id));
  const orphanParents = messages.filter((message) => message.parent_id && !messageIds.has(message.parent_id)).length;
  const warnings = [];
  if (orphanParents) warnings.push({
    code: "claude_orphan_parent",
    message: `${orphanParents} message parent references are absent from this export; their child messages are kept as branch roots.`
  });
  if (state.emptyMessages) warnings.push({
    code: "claude_empty_message",
    message: `${state.emptyMessages} exported messages had no visible body; their positions and branch links were retained.`
  });
  if (state.unknownTypes.size) warnings.push({
    code: "claude_unknown_content",
    message: `Preserved unrecognized Claude content types: ${[...state.unknownTypes].sort().join(", ")}.`
  });

  return {
    schema: CLAUDE_CONVERSATION_SCHEMA,
    parser_version: LEGACY_PROJECTION_PARSER_VERSION,
    parser_adapter: parserAdapterRecord(CLAUDE_EXPORT_ADAPTER_ID),
    parsed_at: parserTimestamp({ parsedAt: context.parsedAt, clock: context.clock }),
    conversation_key: claudeConversationKey(conversation.uuid),
    source_file: context.sourceFile,
    source_sha256: context.sourceSha256,
    source_size_bytes: context.sourceSizeBytes,
    content_time: isoTime(messages[0]?.timestamp) || isoTime(context.sourceCreatedAt) || (() => {
      throw new Error("Cannot determine Claude content_time: first message and original file creation time are unavailable");
    })(),
    created_at: isoTime(conversation.created_at) || undefined,
    updated_at: isoTime(conversation.updated_at) || undefined,
    title: cleanString(conversation.name) || "Claude conversation",
    provider: "anthropic",
    platform: "claude",
    messages,
    resources: state.resources.length ? state.resources : undefined,
    sources: state.sources.size ? [...state.sources.values()] : undefined,
    warnings: warnings.length ? warnings : undefined
  };
}

export const claudeExportAdapterDefinition = Object.freeze({
  id: CLAUDE_EXPORT_ADAPTER_ID,
  version: CLAUDE_EXPORT_ADAPTER_VERSION,
  extensions: [".json"],
  capabilities: {
    one_to_many: true,
    streaming: true,
    seek_required: true,
    selectable: true,
    branches: "parent_tree",
    attachments: "metadata_and_extracted_text"
  },
  async probe(input, limits) {
    const maximum = Math.max(1, Math.min(input.size, Number(limits.sequentialBytes) || 256 * 1024 * 1024));
    const maxItemBytes = Math.max(1, Math.min(
      maximum,
      Number(limits.maxItemBytes) || maximum
    ));
    try {
      const stream = input.openStream({ start: 0, end: maximum - 1, highWaterMark: 256 * 1024 });
      for await (const item of streamTopLevelJsonArray(stream, { maxItemBytes, maxItems: 1 })) {
        const first = parseJsonArrayItem(item);
        return looksLikeClaudeConversation(first)
          ? { matched: true, confidence: 1, format: CLAUDE_EXPORT_FORMAT, provider: "anthropic", platform: "claude" }
          : { matched: false, confidence: 0, reason: "JSON array does not contain Claude export conversations" };
      }
      return { matched: false, confidence: 0, reason: "Claude export JSON array is empty" };
    } catch (error) {
      if (error instanceof RangeError && /exceeds \d+ bytes/u.test(String(error.message))) {
        return {
          matched: false,
          confidence: 0,
          reason: `Claude export first item exceeds the ${maxItemBytes}-byte item limit`
        };
      }
      return { matched: false, confidence: 0, reason: "JSON does not expose a complete Claude conversation inside the bounded probe" };
    }
  },
  async *parse() {
    throw new Error("Claude account exports require indexing and explicit conversation selection in Cloudig Manager");
  }
});
