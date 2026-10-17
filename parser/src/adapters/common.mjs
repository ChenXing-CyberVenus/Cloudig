import path from "node:path";

import { sha256 } from "../contract.mjs";
import {
  classText,
  descendants,
  hasClass,
  htmlFragmentToMarkdown,
  htmlFragmentToText,
  innerHtml,
  outerHtml,
  parseAttributes,
  sanitizeRichTextFragment,
  sanitizeStaticMathFragment,
  sanitizeSvgFragment
} from "../html.mjs";

export const CONVERSATION_SCHEMA = "ai-chat-archive/conversation/0.1.5";
export const CONVERSATION_SCHEMA_BRANCHES = "ai-chat-archive/conversation/0.2.5";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function finitePositive(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeHttpUrl(value) {
  const raw = nonEmpty(value);
  if (!raw || !/^https?:\/\//iu.test(raw)) return null;
  try {
    new URL(raw);
    return raw;
  } catch {
    return null;
  }
}

function timestampValue(value) {
  if (value === null || value === undefined || value === "") return null;
  let date;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(Math.abs(value) >= 1e11 ? value : value * 1000);
  } else {
    date = new Date(String(value));
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstValue(...values) {
  for (const value of values) {
    const result = nonEmpty(value);
    if (result) return result;
  }
  return null;
}

function titleValue(context) {
  return firstValue(
    context.payload.title,
    context.payload.conversation?.title,
    context.payload.chat?.user_title,
    context.payload.chat?.title,
    context.manifest.title,
    path.basename(context.sourceFile, path.extname(context.sourceFile))
  );
}

function normalizedRole(value) {
  const role = String(value ?? "").toLowerCase();
  if (["user", "assistant", "system", "developer", "tool"].includes(role)) return role;
  return "other";
}

function stableFingerprint(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableFingerprint(value[key])}`).join(",")}}`;
}

function uniqueConversationLocator(values, label) {
  const candidates = [...new Set(values.map(nonEmpty).filter(Boolean))];
  if (candidates.length > 1) {
    throw new Error(`${label} exposes conflicting conversation locators`);
  }
  return candidates[0] ?? null;
}

export function conversationLocator(context) {
  const manifestLocator = uniqueConversationLocator([
    context.manifest?.conversation_id,
    context.manifest?.source?.conversation_id
  ], "Manifest");
  const payloadLocator = uniqueConversationLocator([
    context.payload?.conversation_id,
    context.payload?.session_id,
    context.payload?.chat?.id,
    context.payload?.conversation?.id
  ], "Payload");
  if (manifestLocator && payloadLocator && manifestLocator !== payloadLocator) {
    throw new Error("Manifest and payload conversation locators do not match");
  }
  return manifestLocator ?? payloadLocator;
}

export function privateConversationKey(platform, locator) {
  return sha256(Buffer.from(`${platform}\u0000conversation\u0000${locator}`, "utf8"));
}

function isNonMaterialExporterNotice(value) {
  const text = nonEmpty(value);
  if (!text) return false;
  if (/^\d+ 个非图片附件按 A-Light 策略仅保留(?:页面可见)?元数据。?$/u.test(text)) return true;
  if (/^KaTeX 字体 .+ 未能内嵌：Failed to fetch(?: \([^)]+\))?$/u.test(text)) return true;
  if (/^公式排版扫描经过 \d+ 段后未确认触顶稳定$/u.test(text)) return true;
  return text.startsWith("Gemini 原始 TeX 的 array 列格式包含无效 \\|")
    && text.endsWith("原文仍保存在 data-tex。");
}

function slugCode(value) {
  const result = String(value ?? "warning")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "");
  return result && /^[a-z0-9]/u.test(result) ? result : `warning_${result || "unknown"}`;
}

function dataUrlFrom(record) {
  const candidates = [
    record?.data_url,
    record?.dataUrl,
    record?.src,
    record?.archived?.data_url,
    record?.archived?.dataUrl,
    record?.archived?.src,
    record?.pre_encoded?.data_url,
    record?.pre_encoded?.dataUrl,
    typeof record?.resource_locator === "string" ? record.resource_locator : null,
    record?.resource_locator?.scheme === "data_url" ? record.resource_locator?.value : null
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.startsWith("data:")) ?? null;
}

function decodeImageDataUrl(value) {
  const source = String(value ?? "");
  if (!source.toLowerCase().startsWith("data:image/")) return null;
  const comma = source.indexOf(",");
  if (comma < 0) return null;
  const metadata = source.slice(5, comma);
  const metadataLower = metadata.toLowerCase();
  const metadataParts = metadataLower.split(";");
  if (metadataParts.length < 2 || metadataParts.at(-1) !== "base64") return null;
  const mimeType = metadataParts[0];
  if (metadataParts.slice(1, -1).some((parameter) => !parameter || !parameter.includes("="))) {
    return null;
  }
  if (!/^image\/[a-z0-9.+-]+$/u.test(mimeType)) return null;
  const encoded = source.slice(comma + 1);
  if (!encoded) return null;
  let segmentStart = 0;
  let segments = null;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    const isBase64 =
      (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47
      || code === 61;
    if (isBase64) continue;
    if (!/\s/u.test(encoded[index])) return null;
    segments ??= [];
    if (index > segmentStart) segments.push(encoded.slice(segmentStart, index));
    segmentStart = index + 1;
  }
  if (segments && segmentStart < encoded.length) segments.push(encoded.slice(segmentStart));
  const compact = segments ? segments.join("") : encoded;
  if (!compact) return null;
  try {
    const bytes = Buffer.from(compact, "base64");
    if (!bytes.length) return null;
    const canonical = bytes.toString("base64");
    return {
      mimeType,
      bytes,
      dataUrl: `data:${mimeType};base64,${canonical}`
    };
  } catch {
    return null;
  }
}

function locatorUrl(locator) {
  if (typeof locator === "string") return safeHttpUrl(locator);
  const direct = safeHttpUrl(locator?.value);
  if (direct) return direct;
  const origin = safeHttpUrl(locator?.origin);
  if (!origin || typeof locator?.path !== "string") return null;
  try {
    return new URL(locator.path, origin).href;
  } catch {
    return null;
  }
}

function urlFromRecord(record) {
  for (const candidate of [
    record?.url,
    record?.href,
    record?.source_reference,
    locatorUrl(record?.resource_locator)
  ]) {
    const url = safeHttpUrl(candidate);
    if (url) return url;
  }
  return null;
}

function mimeFromRecord(record, decoded) {
  if (decoded?.mimeType) return decoded.mimeType;
  for (const candidate of [
    record?.mime_type,
    record?.mime,
    record?.archived?.mime,
    record?.archived_mime,
    record?.original?.mime,
    record?.declared_mime,
    record?.pre_encoded?.mime_type,
    record?.raw?.mime_type,
    record?.type
  ]) {
    const value = nonEmpty(candidate)?.toLowerCase();
    if (value && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)) return value;
  }
  return null;
}

function imageRecord(record, mimeType) {
  const kind = String(record?.kind ?? "").toLowerCase();
  return Boolean(record?.is_image)
    || Boolean(mimeType?.startsWith("image/"))
    || /(?:image|photo|picture|diagram|mermaid|markmap)/u.test(kind);
}

function resourcePurpose(record, fallback = "inline") {
  const combined = [
    record?.purpose,
    record?.kind,
    record?.origin,
    record?.retrieval_route,
    record?.capture_route
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");
  if (/(?:diagram|mermaid|markmap|chart|canvas)/u.test(combined)) return "diagram";
  if (/(?:search|source|reference)/u.test(combined)) return "search";
  if (/(?:inline)/u.test(combined)) return "inline";
  if (/(?:generated|generation|assistant_asset|output)/u.test(combined)) return "generated";
  if (/(?:upload|user|attachment|file)/u.test(combined)) return "uploaded";
  return fallback;
}

function resourceName(record, kind) {
  return firstValue(
    record?.name,
    record?.filename,
    record?.file_name,
    record?.raw_file?.file_name,
    record?.alt,
    record?.title,
    kind === "image" ? "图片" : "附件"
  );
}

function resourceStatusMissing(record) {
  return /(?:missing|failed|error|unavailable|omitted)/iu.test(
    String(record?.availability ?? record?.status ?? record?.error ?? "")
  );
}

function sourceUrl(record) {
  if (typeof record === "string") return safeHttpUrl(record);
  return safeHttpUrl(record?.url ?? record?.href ?? record?.source_reference);
}

function markdownLinkDestination(value) {
  try {
    return encodeURI(String(value ?? "")).replaceAll("(", "%28").replaceAll(")", "%29");
  } catch {
    return String(value ?? "").replaceAll("(", "%28").replaceAll(")", "%29");
  }
}

function sourceTitle(record, url) {
  return typeof record === "string"
    ? null
    : firstValue(record?.title, record?.name, record?.hostname, record?.domain, url);
}

export class ConversationBuilder {
  constructor(context, descriptor) {
    this.context = context;
    this.descriptor = descriptor;
    this.models = new Set();
    this.resources = [];
    this.resourcesById = new Map();
    this.sources = [];
    this.sourcesByUrl = new Map();
    this.warnings = [];
    this.warningKeys = new Set();
    this.turnSequence = 0;
    const locator = conversationLocator(context);
    this.document = {
      schema: descriptor.outputSchema ?? CONVERSATION_SCHEMA,
      conversation_key: locator
        ? privateConversationKey(descriptor.platform, locator)
        : context.sourceSha256,
      source_file: context.sourceFile,
      source_sha256: context.sourceSha256,
      source_size_bytes: context.sourceSizeBytes,
      title: titleValue(context),
      provider: descriptor.provider,
      platform: descriptor.platform,
      messages: []
    };
    const sourceUrlValue = safeHttpUrl(context.payload.source_url ?? context.manifest.source_url);
    const exportedAt = timestampValue(context.payload.exported_at ?? context.manifest.exported_at);
    if (sourceUrlValue) this.document.source_url = sourceUrlValue;
    if (exportedAt) this.document.exported_at = exportedAt;
  }

  addModel(value) {
    const model = nonEmpty(value);
    if (model) this.models.add(model);
  }

  warn(code, message = null, messageIndex = null, resourceId = null) {
    const warning = { code: slugCode(code) };
    const text = nonEmpty(message);
    if (text) warning.message = text;
    if (Number.isInteger(messageIndex) && messageIndex >= 0) warning.message_index = messageIndex;
    if (resourceId) warning.resource_id = resourceId;
    const key = stableFingerprint(warning);
    if (this.warningKeys.has(key)) return;
    this.warningKeys.add(key);
    this.warnings.push(warning);
  }

  addSource(record, messageIndex = null) {
    const url = sourceUrl(record);
    if (!url) {
      if (record && typeof record === "object" && Object.keys(record).length) {
        this.warn("source_url_missing", "来源记录没有可用的 HTTP(S) 地址。", messageIndex);
      }
      return null;
    }
    const existing = this.sourcesByUrl.get(url);
    if (existing) return existing.id;
    const source = {
      id: `source_${sha256(Buffer.from(url, "utf8")).slice(0, 24)}`,
      url
    };
    const title = sourceTitle(record, url);
    const siteName = typeof record === "string"
      ? null
      : firstValue(record?.site_name, record?.hostname, record?.domain);
    const snippet = typeof record === "string"
      ? null
      : firstValue(record?.snippet, record?.summary, record?.description);
    if (title && title !== url) source.title = title;
    if (siteName) source.site_name = siteName;
    if (snippet) source.snippet = snippet;
    this.sourcesByUrl.set(url, source);
    this.sources.push(source);
    return source.id;
  }

  addSources(records, messageIndex = null) {
    const ids = [];
    for (const record of Array.isArray(records) ? records : []) {
      const id = this.addSource(record, messageIndex);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  addResource(record, { purpose = "inline", role = null } = {}) {
    const input = record && typeof record === "object" ? record : {};
    const decoded = decodeImageDataUrl(dataUrlFrom(input));
    const mimeType = mimeFromRecord(input, decoded);
    const kind = imageRecord(input, mimeType) ? "image" : "attachment";
    const name = resourceName(input, kind);
    let resource;
    if (decoded) {
      const hash = sha256(decoded.bytes);
      const id = `image_${hash}`;
      resource = this.resourcesById.get(id);
      if (!resource) {
        resource = {
          id,
          kind: "image",
          availability: "embedded",
          name,
          mime_type: decoded.mimeType,
          size_bytes: decoded.bytes.length,
          sha256: hash,
          data_url: decoded.dataUrl
        };
        const originalSize = positiveInteger(
          input?.original_size_bytes
          ?? input?.original?.bytes
          ?? input?.source_size
          ?? input?.size_bytes
          ?? input?.size
        );
        const width = positiveInteger(input?.width ?? input?.archived?.width);
        const height = positiveInteger(input?.height ?? input?.archived?.height);
        const originalWidth = positiveInteger(input?.original_width ?? input?.original?.width);
        const originalHeight = positiveInteger(input?.original_height ?? input?.original?.height);
        if (originalSize && originalSize !== decoded.bytes.length) resource.original_size_bytes = originalSize;
        if (width) resource.width = width;
        if (height) resource.height = height;
        if (originalWidth) resource.original_width = originalWidth;
        if (originalHeight) resource.original_height = originalHeight;
        this.resourcesById.set(id, resource);
        this.resources.push(resource);
      } else if ((!resource.name || resource.name === "图片") && name) {
        resource.name = name;
      }
    } else {
      const url = urlFromRecord(input);
      const availability = resourceStatusMissing(input) && !url ? "missing" : "metadata_only";
      const fingerprint = stableFingerprint({
        kind,
        name,
        mimeType,
        url,
        locator: input?.resource_locator ?? null,
        sourceId: input?.id ?? input?.identifier ?? null
      });
      const id = `resource_${sha256(Buffer.from(fingerprint, "utf8")).slice(0, 32)}`;
      resource = this.resourcesById.get(id);
      if (!resource) {
        resource = { id, kind, availability, name };
        if (mimeType) resource.mime_type = mimeType;
        const size = positiveInteger(
          input?.size_bytes
          ?? input?.size
          ?? input?.source_size
          ?? input?.embedded_size
          ?? input?.archived_bytes
          ?? input?.original?.bytes
        );
        const width = positiveInteger(input?.width ?? input?.archived?.width);
        const height = positiveInteger(input?.height ?? input?.archived?.height);
        const originalWidth = positiveInteger(input?.original_width ?? input?.original?.width);
        const originalHeight = positiveInteger(input?.original_height ?? input?.original?.height);
        if (size) resource.size_bytes = size;
        if (url && availability === "metadata_only") resource.url = url;
        if (width) resource.width = width;
        if (height) resource.height = height;
        if (originalWidth) resource.original_width = originalWidth;
        if (originalHeight) resource.original_height = originalHeight;
        this.resourcesById.set(id, resource);
        this.resources.push(resource);
      }
    }
    const inferredFallback = role === "user" ? "uploaded" : purpose;
    return {
      resource,
      block: resource.kind === "image"
        ? {
          type: "image",
          resource_id: resource.id,
          purpose: resourcePurpose(input, inferredFallback),
          ...(name ? { alt: name } : {})
        }
        : { type: "attachment", resource_id: resource.id }
    };
  }

  addMessage({
    id = null,
    parentId = null,
    role,
    model = null,
    timestamp = null,
    name = null,
    turnId = null,
    content
  }) {
    const normalizedTurnId = nonEmpty(turnId) || `turn_${String(++this.turnSequence).padStart(6, "0")}`;
    const message = {
      ...(nonEmpty(id) ? { id: nonEmpty(id) } : {}),
      ...(nonEmpty(parentId) ? { parent_id: nonEmpty(parentId) } : {}),
      turn_id: normalizedTurnId.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "_"),
      role: normalizedRole(role),
      content: Array.isArray(content) ? content.filter(Boolean) : []
    };
    const modelValue = nonEmpty(model);
    const nameValue = nonEmpty(name);
    const timestampNormalized = timestampValue(timestamp);
    if (modelValue) {
      message.model = modelValue;
      this.addModel(modelValue);
    }
    if (nameValue) message.name = nameValue;
    if (timestampNormalized) message.timestamp = timestampNormalized;
    if (!message.content.length) {
      message.content.push({ type: "unknown", label: "空的可见消息" });
      this.warn("message_content_empty", "消息没有取得可显示内容。", this.document.messages.length);
    }
    this.document.messages.push(message);
    return message;
  }

  finalize() {
    const contentTime = timestampValue(this.document.messages[0]?.timestamp)
      || timestampValue(this.context.sourceCreatedAt);
    if (!contentTime) {
      throw new Error("Cannot determine content_time: first message has no timestamp and original file creation time is unavailable");
    }
    this.document.content_time = contentTime;
    if (!this.models.size) this.addModel(this.descriptor.defaultModel);
    if (this.models.size) this.document.models = [...this.models];
    if (this.resources.length) this.document.resources = this.resources;
    if (this.sources.length) this.document.sources = this.sources;
    if (this.warnings.length) this.document.warnings = this.warnings;
    return this.document;
  }
}

export function messageIdentity(message) {
  return String(
    message?.message_id
    ?? message?.id
    ?? message?.response_id
    ?? message?.key
    ?? message?.source_id
    ?? ""
  );
}

function messageKey(message) {
  const id = messageIdentity(message);
  return message?.version === null || message?.version === undefined ? id : `${id}@${message.version}`;
}

export function orderedMessages(context) {
  const messages = context.platform === "deepseek"
    ? (Array.isArray(context.payload.items) ? context.payload.items : [])
    : (Array.isArray(context.payload.messages) ? context.payload.messages : []);
  const order = context.payload.message_order
    ?? (context.platform === "deepseek" ? context.payload.active_message_ids : null);
  if (!Array.isArray(order) || !order.length) {
    return [...messages].sort((left, right) => {
      const a = Number(left?.ordinal);
      const b = Number(right?.ordinal);
      return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
    });
  }
  const byKey = new Map(messages.map((message) => [messageKey(message), message]));
  const byId = new Map(messages.map((message) => [messageIdentity(message), message]));
  const result = [];
  for (const entry of order) {
    const id = String(entry?.id ?? entry);
    const key = entry && typeof entry === "object" ? `${entry.id}@${entry.version}` : id;
    const message = byKey.get(key) ?? byId.get(id);
    if (!message) throw new Error(`message_order references a missing message: ${key}`);
    result.push(message);
  }
  if (result.length !== messages.length) {
    throw new Error(`message_order count mismatch: ${result.length} != ${messages.length}`);
  }
  return result;
}

export function selectMessageNode(context, message) {
  const identity = messageIdentity(message);
  const nodes = context.messageNodesById.get(identity)
    ?? (context.platform === "grok"
      ? context.messageNodesById.get(`response-${identity}`)
      : null)
    ?? [];
  if (message?.version === null || message?.version === undefined) return nodes[0] ?? null;
  return nodes.find((node) => String(node.attrs?.["data-message-version"] ?? "") === String(message.version))
    ?? nodes[0]
    ?? null;
}

function firstClass(node, className) {
  if (!node) return null;
  if (hasClass(node, className)) return node;
  return descendants(node).find((candidate) => hasClass(candidate, className)) ?? null;
}

function ancestorHasClass(node, className) {
  for (let current = node?.parent; current; current = current.parent) {
    if (hasClass(current, className)) return true;
  }
  return false;
}

function auxiliaryChild(node) {
  if (node.tag === "details") return true;
  return /(?:^|\s)(?:assistant-model|public-processes|sources?|source-list|citations?|attachments?|osis-turn-meta)(?:\s|$)/iu
    .test(String(node.attrs?.class ?? ""));
}

function stripImageTags(value) {
  return String(value ?? "").replace(/<img\b[^>]*>/giu, "");
}

function innerHtmlWithoutNodes(context, target, excludedNodes) {
  const start = target?.openEnd ?? 0;
  const end = target?.closeStart ?? target?.end ?? start;
  const ranges = [...new Set(excludedNodes ?? [])]
    .map((node) => ({
      start: Math.max(start, node?.start ?? start),
      end: Math.min(end, node?.end ?? node?.closeStart ?? node?.openEnd ?? end)
    }))
    .filter((range) => range.start >= start && range.end > range.start && range.start < end)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  let cursor = start;
  let result = "";
  for (const range of ranges) {
    if (range.start < cursor) continue;
    result += context.html.slice(cursor, range.start);
    cursor = range.end;
  }
  result += context.html.slice(cursor, end);
  return result;
}

function nodeText(context, node) {
  return context.dom?.textOf?.(node) ?? htmlFragmentToText(outerHtml(context, node));
}

function actualGeminiExecutionPanels(context, target) {
  if (!target) return [];
  const languagePreCount = (node) => descendants(node)
    .filter((candidate) => candidate.tag === "pre" && candidate.attrs?.["data-language"])
    .length;
  return descendants(target).filter((candidate) => {
    if (candidate.tag !== "div" || languagePreCount(candidate) !== 2) return false;
    const parentCount = candidate.parent && candidate.parent !== target
      ? languagePreCount(candidate.parent)
      : 0;
    return parentCount !== 2 && /(?:^|\s)(?:代码输出|code output)(?:\s|$)/iu.test(nodeText(context, candidate));
  });
}

function yuanbaoMirrorBranches(context, target) {
  if (!target || !hasClass(target, "osis-user-plain")) return [];
  const nonEmptyChildren = (target.children ?? []).filter((child) => nodeText(context, child).trim());
  if (nonEmptyChildren.length !== 2) return [];
  const [primary, mirror] = nonEmptyChildren;
  const normalized = (node) => nodeText(context, node).replace(/\s+/gu, " ").trim();
  if (!normalized(primary) || normalized(primary) !== normalized(mirror)) return [];
  const semanticTags = new Set(["p", "ul", "ol", "pre", "table", "blockquote", "a", "img"]);
  if ([primary, mirror].some((branch) =>
    descendants(branch).some((node) => semanticTags.has(node.tag)))) return [];
  const hasEmptyMirrorPlaceholder = descendants(mirror).some((node) =>
    node.tag === "div" && !nodeText(context, node).trim());
  return hasEmptyMirrorPlaceholder ? [mirror] : [];
}

function yuanbaoControlNodes(context, target) {
  const labels = new Set(["展开", "收起"]);
  return descendants(target).filter((node) => {
    if (node.tag !== "div") return false;
    const value = nodeText(context, node).trim();
    if (!labels.has(value)) return false;
    return nodeText(context, node.parent).trim() !== value;
  });
}

function mainTargetNode(node, platform) {
  if (!node) return null;
  let target = null;
  const classPriority = platform === "kimi"
    ? ["markdown-container", "user-content", "message-content"]
    : platform === "yuanbao" || platform === "mistral"
      ? ["osis-rich"]
      : platform === "gemini" || platform === "grok"
        ? ["user-bubble", "assistant-content"]
        : ["message-content", "answer", "user-bubble", "assistant-content", "osis-rich"];
  for (const className of classPriority) {
    target = firstClass(node, className);
    if (target) break;
  }
  if (!target) target = node;
  return target;
}

function mainExcludedNodes(context, target, platform) {
  const excluded = [];
  excluded.push(...descendants(target).filter((candidate) => hasClass(candidate, "osis-sources")));
  if (["assistant-content", "osis-message"].some((name) => hasClass(target, name))) {
    excluded.push(...(target.children ?? []).filter(auxiliaryChild));
  }
  if (platform === "gemini") {
    excluded.push(
      ...descendants(target).filter((candidate) => hasClass(candidate, "attachment")),
      ...actualGeminiExecutionPanels(context, target)
    );
  } else if (platform === "grok") {
    excluded.push(...descendants(target).filter((candidate) => hasClass(candidate, "ui-chip")));
  } else if (platform === "doubao") {
    excluded.push(...descendants(target).filter((candidate) => hasClass(candidate, "osis-expanded-attachments")));
  } else if (platform === "yuanbao") {
    excluded.push(
      ...yuanbaoMirrorBranches(context, target),
      ...yuanbaoControlNodes(context, target)
    );
  }
  return [...new Set(excluded)];
}

export function domMainMarkdown(context, node, platform = context.platform) {
  if (!node) return "";
  const target = mainTargetNode(node, platform);
  const excluded = mainExcludedNodes(context, target, platform);
  const fragment = innerHtmlWithoutNodes(context, target, excluded);
  return htmlFragmentToMarkdown(stripImageTags(fragment));
}

export function markdownFromHtml(value) {
  return htmlFragmentToMarkdown(stripImageTags(String(value ?? "")));
}

export function sourceString(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "content", "markdown", "body", "value", "result", "summary"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
}

function durationLike(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /(?:thought|reason|think|思考|推理|推演|持续|\d+(?:\.\d+)?\s*[smh秒分])/iu.test(text);
}

function durationSeconds(value, milliseconds = false) {
  const number = finitePositive(value);
  return number === null ? null : milliseconds ? number / 1000 : number;
}

function durationFromThoughtLabel(value) {
  const label = nonEmpty(value);
  if (!label) return null;
  const match = /(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)(?:\b|[）)]|$)/iu.exec(label);
  return match ? finitePositive(match[1]) : null;
}

function genericThoughtLabel(value) {
  const label = nonEmpty(value);
  if (!label) return null;
  if (/^(?:公开)?(?:思考|推理)(?:过程)?$/u.test(label)) return null;
  if (/^已完成思考(?:，参考\s*\d+\s*篇资料)?$/u.test(label)) return null;
  if (/^(?:思考了|思考用时|已深度思考\s*[（(]\s*用时)\s*\d+(?:\.\d+)?\s*(?:秒|s(?:ec(?:ond)?s?)?)\s*[）)]?$/iu.test(label)) return null;
  if (/^thought(?:\s+for\s+\d+(?:\.\d+)?s?)?$/iu.test(label)) return null;
  return label;
}

function richBlock(type, { title = null, body = null, html = null, duration = null, effort = null } = {}) {
  const blockValue = { type };
  const titleValue = nonEmpty(title);
  const bodyValue = nonEmpty(body);
  const htmlValue = nonEmpty(html);
  const effortValue = nonEmpty(effort);
  if (titleValue) blockValue.title = titleValue;
  if (bodyValue) blockValue.markdown = bodyValue;
  if (htmlValue) blockValue.html = htmlValue;
  const seconds = finitePositive(duration);
  if (seconds !== null) blockValue.duration_seconds = seconds;
  if (effortValue) blockValue.effort = effortValue;
  return titleValue || bodyValue || htmlValue ? blockValue : null;
}

function addThought(content, {
  title = null,
  body = null,
  duration = null,
  effort = null,
  bodyType = "reasoning"
} = {}) {
  const label = nonEmpty(title);
  const reasoningBody = nonEmpty(body);
  const resolvedDuration = finitePositive(duration) ?? durationFromThoughtLabel(label);
  if (reasoningBody) {
    content.push(richBlock(bodyType, {
      title: genericThoughtLabel(label),
      body: reasoningBody,
      duration: resolvedDuration,
      effort
    }));
    return;
  }
  if (label) {
    const isStatus = durationLike(label);
    content.push(richBlock(isStatus ? "status" : "reasoning_summary", {
      title: isStatus ? genericThoughtLabel(label) ?? "思考" : label,
      duration: resolvedDuration,
      effort
    }));
  }
}

function kimiProcessSequence(context, message, node) {
  const processes = Array.isArray(message?.public_processes) ? message.public_processes : [];
  if (!node) return processes;
  const used = new Set();
  const result = [];
  const take = (kind) => {
    const index = processes.findIndex((process, candidateIndex) =>
      !used.has(candidateIndex)
      && String(process?.kind ?? "").toLowerCase().includes(kind));
    if (index < 0) return null;
    used.add(index);
    return processes[index];
  };
  const blockItems = descendants(node).filter((candidate) =>
    hasClass(candidate, "block-item")
    && !hasClass(candidate.parent, "block-item"));
  for (const item of blockItems) {
    if (descendants(item).some((candidate) => hasClass(candidate, "osis-thinking"))) {
      const process = take("thinking");
      if (process) result.push({ ...process, __cloudig_dom_process_node: item });
      continue;
    }
    if (descendants(item).some((candidate) => hasClass(candidate, "osis-search"))) {
      const process = take("search");
      if (process) result.push(process);
      continue;
    }
    const memory = descendants(item).find((candidate) => hasClass(candidate, "memory-block"));
    if (!memory) continue;
    const titleNode = descendants(memory).find((candidate) =>
      hasClass(candidate, "toolcall-title-name-text"));
    const title = nonEmpty(nodeText(context, titleNode ?? memory));
    if (title) result.push({ __cloudig_dom_tool: true, title });
  }
  processes.forEach((process, index) => {
    if (!used.has(index)) result.push(process);
  });
  return result;
}

function kimiReasoningHtmlFallback(context, process) {
  const item = process?.__cloudig_dom_process_node;
  if (!item) return null;
  const body = descendants(item).find((candidate) => hasClass(candidate, "osis-process-content"));
  if (!body) return null;
  const formulaRoots = descendants(body).filter((candidate) =>
    (hasClass(candidate, "katex-wrapper") || hasClass(candidate, "osis-katex-shell"))
    && !ancestorHasClass(candidate, "katex-wrapper")
    && !ancestorHasClass(candidate, "osis-katex-shell"));
  const missing = formulaRoots.filter((formula) =>
    !nonEmpty(formula.attrs?.["data-tex"])
    && !descendants(formula).some((candidate) => nonEmpty(candidate.attrs?.["data-tex"])));
  if (!missing.length) return null;
  const html = sanitizeRichTextFragment(innerHtml(context, body));
  return nonEmpty(html) ? { html, count: missing.length } : null;
}

export function addPlatformThoughts(context, message, content, node = null, builder = null, messageIndex = null) {
  const effort = message?.reasoning_effort ?? context.payload.reasoning_effort ?? null;
  if (context.platform === "kimi") {
    let missingStaticMath = 0;
    for (const process of kimiProcessSequence(context, message, node)) {
      if (process?.__cloudig_dom_tool) {
        content.push({
          type: "tool",
          kind: "activity",
          title: process.title
        });
        continue;
      }
      const title = process?.title ?? process?.label ?? process?.raw;
      const body = process?.content ?? process?.body_text ?? process?.text;
      const duration = process?.duration_seconds
        ?? process?.seconds
        ?? durationSeconds(process?.duration_ms, true);
      const kind = String(process?.kind ?? "").trim().toLowerCase();
      if (kind.includes("tool")) {
        const block = { type: "tool", kind: "activity" };
        const name = firstValue(process?.name, process?.tool_name, process?.tool_type);
        const status = firstValue(process?.status);
        if (name) block.name = name;
        if (nonEmpty(title)) block.title = nonEmpty(title);
        if (nonEmpty(body)) block.markdown = nonEmpty(body);
        if (status) block.status = status;
        const seconds = finitePositive(duration);
        if (seconds !== null) block.duration_seconds = seconds;
        if (typeof process?.success === "boolean") block.success = process.success;
        if (block.name || block.title || block.markdown) content.push(block);
        continue;
      }
      if (kind.includes("search")) {
        const query = firstValue(process?.query, title, body);
        if (query) {
          const block = { type: "search", query };
          const seconds = finitePositive(duration);
          if (seconds !== null) block.duration_seconds = seconds;
          content.push(block);
        }
        continue;
      }
      const block = richBlock(nonEmpty(body) ? "reasoning" : durationLike(title) ? "status" : "reasoning_summary", {
        title,
        body,
        duration,
        effort: process?.effort ?? effort
      });
      if (block) {
        const fallback = block.type === "reasoning"
          ? kimiReasoningHtmlFallback(context, process)
          : null;
        if (fallback) {
          delete block.markdown;
          block.html = fallback.html;
          missingStaticMath += fallback.count;
        }
        content.push(block);
      }
    }
    if (missingStaticMath && builder) {
      builder.warn(
        "math_source_missing",
        `${missingStaticMath} 个思考公式只有静态 KaTeX 排版，没有可恢复的原始 TeX；已保留离线静态排版。`,
        messageIndex
      );
    }
    return;
  }
  if (context.platform === "deepseek") {
    const thoughts = (Array.isArray(message?.thoughts) ? message.thoughts : [])
      .map(sourceString)
      .filter(nonEmpty);
    for (const [index, thought] of thoughts.entries()) {
      addThought(content, {
        body: thought,
        duration: index === 0 ? message?.thinking_seconds : null,
        effort
      });
    }
    return;
  }
  if (context.platform === "gemini" || context.platform === "grok") {
    for (const thought of Array.isArray(message?.thoughts) ? message.thoughts : []) {
      addThought(content, {
        title: thought?.label ?? thought?.title,
        body: thought?.text
          ?? thought?.content
          ?? (thought?.html ? markdownFromHtml(thought.html) : null),
        duration: thought?.seconds ?? thought?.duration_seconds,
        effort
      });
    }
    return;
  }
  if (context.platform === "doubao") {
    addThought(content, {
      title: message?.public_thought_label,
      body: message?.public_thought_text,
      effort
    });
    return;
  }
  if (context.platform === "yuanbao") {
    const reasoningLabel = message?.public_reasoning_label;
    const sourceHtml = nonEmpty(message?.public_reasoning_html);
    const hasStaticMath = sourceHtml && /\bosis-katex-shell\b/u.test(sourceHtml);
    if (hasStaticMath) {
      const html = nonEmpty(sanitizeRichTextFragment(sourceHtml));
      const block = richBlock("reasoning", {
        title: genericThoughtLabel(reasoningLabel),
        html,
        duration: durationFromThoughtLabel(reasoningLabel),
        effort
      });
      if (block) content.push(block);
    } else {
      addThought(content, {
        title: reasoningLabel,
        body: sourceHtml
          ? markdownFromHtml(sourceHtml)
          : message?.public_reasoning_text,
        effort
      });
    }
    return;
  }
  if (context.platform === "mistral") {
    const thoughtsByBody = new Map();
    const addMistralThought = ({ title = null, body = null, duration = null } = {}) => {
      const bodyValue = nonEmpty(body);
      if (!bodyValue || /^\$[a-z0-9]+$/iu.test(bodyValue)) return;
      const fingerprint = bodyValue.replace(/\s+/gu, " ");
      const durationValue = finitePositive(duration) ?? durationFromThoughtLabel(title);
      const existing = thoughtsByBody.get(fingerprint);
      if (existing) {
        if ((durationValue ?? 0) > (existing.duration ?? 0)) existing.duration = durationValue;
        if (!existing.title) existing.title = genericThoughtLabel(title);
        return;
      }
      thoughtsByBody.set(fingerprint, {
        title: genericThoughtLabel(title),
        body: bodyValue,
        duration: durationValue
      });
    };
    for (const thought of Array.isArray(message?.public_thoughts) ? message.public_thoughts : []) {
      addMistralThought({
        title: thought?.label ?? thought?.raw,
        body: thought?.body_text,
        duration: thought?.seconds
      });
    }
    if (!thoughtsByBody.size) {
      for (const segment of Array.isArray(message?.reasoning_segments) ? message.reasoning_segments : []) {
        addMistralThought({
          body: segment?.body_text,
          duration: durationSeconds(segment?.duration_ms, true)
        });
      }
    }
    for (const thought of thoughtsByBody.values()) {
      const block = richBlock("reasoning", { ...thought, effort });
      if (block) content.push(block);
    }
    return;
  }
  for (const process of Array.isArray(message?.public_processes) ? message.public_processes : []) {
    const body = normalizeThoughtReferences(
      context,
      builder,
      message,
      process?.content ?? process?.body_text ?? process?.text,
      messageIndex
    );
    addThought(content, {
      title: process?.title ?? process?.label ?? process?.raw,
      body,
      duration: process?.duration_seconds
        ?? process?.seconds
        ?? durationSeconds(process?.duration_ms, true),
      effort: process?.effort ?? effort,
      bodyType: String(process?.kind ?? "").toLowerCase().includes("summary")
        ? "reasoning_summary"
        : "reasoning"
    });
  }
}

export function mainMarkdownForMessage(context, message, node) {
  if (context.platform === "deepseek") {
    return (Array.isArray(message?.main) ? message.main : []).map(sourceString).filter(Boolean).join("\n\n");
  }
  if (["qwen", "chatglm", "zai"].includes(context.platform)) {
    return typeof message?.content_markdown === "string"
      ? message.content_markdown
      : domMainMarkdown(context, node);
  }
  if (context.platform === "gemini") {
    return domMainMarkdown(context, node) || markdownFromHtml(message?.html) || String(message?.text ?? "");
  }
  if (context.platform === "grok") {
    return domMainMarkdown(context, node)
      || String(message?.raw_message ?? message?.text ?? "");
  }
  return domMainMarkdown(context, node);
}

function mistralVisibleContentBlocks(context, builder, payloadMessage, node, role, messageIndex) {
  if (context.platform !== "mistral" || !node) return [];
  const message = firstClass(node, "osis-message") ?? node;
  const publicThoughts = (message.children ?? []).filter((child) => hasClass(child, "osis-public-thinking"));
  const lastPublicThought = publicThoughts.at(-1) ?? null;
  const richChildren = (message.children ?? []).filter((child) => hasClass(child, "osis-rich"));
  const richAfterThought = lastPublicThought
    ? richChildren.filter((child) => child.start >= (lastPublicThought.end ?? lastPublicThought.openEnd))
    : richChildren;
  const visibleRichChildren = new Set(richAfterThought.length ? richAfterThought : richChildren);
  const resources = prepareMessageResources(context, builder, payloadMessage, node, role, messageIndex);
  const diagrams = domDiagramRecords(context, node);
  const records = [
    ...resources.map((record) => ({ ...record, kind: "resource" })),
    ...diagrams.map((record) => ({ ...record, kind: "diagram" }))
  ];
  const placed = new Set();
  const entries = [];
  for (const child of message.children ?? []) {
    if (hasClass(child, "osis-rich")) {
      if (!visibleRichChildren.has(child)) continue;
      const inside = records
        .filter((record) => nodeInsideTarget(record.node, child))
        .sort((left, right) => left.node.start - right.node.start);
      const components = inside.map((record, index) => ({
        node: record.node,
        block: record.block,
        token: `CLOUDIGMISTRALBLOCK${messageIndex}X${index}Z`
      }));
      const replacements = components.map((component) => ({
        node: component.node,
        replacement: component.token,
        priority: 2
      }));
      const componentNodes = new Set(components.map((component) => component.node));
      for (const image of descendants(child).filter((candidate) => candidate.tag === "img")) {
        if (!componentNodes.has(image)) replacements.push({ node: image, replacement: "", priority: 0 });
      }
      const markdown = htmlFragmentToMarkdown(fragmentWithReplacements(context, child, replacements));
      const projected = splitProjectedMarkdown(markdown, components);
      if (projected.length) entries.push({ start: child.start, blocks: projected });
      inside.forEach((record) => placed.add(record));
      continue;
    }
    if (!hasClass(child, "osis-artifact")) continue;
    const titleNode = (child.children ?? []).find((candidate) => /^h[1-6]$/u.test(candidate.tag));
    const html = innerHtmlWithoutNodes(context, child, titleNode ? [titleNode] : []);
    if (!nonEmpty(html)) continue;
    const block = { type: "diagram", format: "canvas", html };
    const title = titleNode ? nonEmpty(nodeText(context, titleNode)) : null;
    if (title) block.title = title;
    entries.push({ start: child.start, blocks: [block] });
  }
  for (const record of records) {
    if (placed.has(record)) continue;
    entries.push({
      start: record.node?.start ?? Number.POSITIVE_INFINITY,
      blocks: [record.block]
    });
  }
  entries.sort((left, right) => left.start - right.start);
  const blocks = entries.flatMap((entry) => entry.blocks);
  if (!diagrams.length) blocks.push(...payloadDiagrams(payloadMessage));
  return blocks;
}

function texDelimited(tex, display) {
  const value = String(tex ?? "").trim();
  if (!value) return "";
  if ((value.startsWith("\\(") && value.endsWith("\\)"))
    || (value.startsWith("\\[") && value.endsWith("\\]"))
    || (value.startsWith("$$") && value.endsWith("$$"))) return value;
  return display ? `\\[\n${value}\n\\]` : `\\(${value}\\)`;
}

export function restorePayloadMath(markdown, message) {
  let result = String(markdown ?? "").replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "");
  const unmatched = [];
  for (const formula of Array.isArray(message?.math?.formulas) ? message.math.formulas : []) {
    const tex = nonEmpty(formula?.tex);
    if (!tex) continue;
    const delimited = texDelimited(tex, Boolean(formula.display));
    if (result.includes(delimited) || result.includes(tex)) continue;
    const rendered = nonEmpty(
      String(formula?.rendered_text ?? "").replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    );
    if (rendered && result.includes(rendered)) {
      result = result.replace(rendered, delimited);
    } else {
      unmatched.push({ type: "math", tex, ...(formula.display ? { display: true } : {}) });
    }
  }
  return { markdown: result, unmatched };
}

function roleFromNode(node) {
  const classes = String(node?.attrs?.class ?? "");
  if (/(?:^|\s)user(?:\s|$)/u.test(classes)) return "user";
  if (/(?:^|\s)assistant(?:\s|$)/u.test(classes)) return "assistant";
  return null;
}

function domImageRecords(context, node, role, { excludeMermaidCards = false } = {}) {
  if (!node) return [];
  const records = [];
  for (const image of descendants(node).filter((candidate) => candidate.tag === "img")) {
    if (excludeMermaidCards && ancestorHasClass(image, "osis-mermaid-card")) continue;
    const src = String(image.attrs?.src ?? "");
    if (!/^data:image\//iu.test(src)) continue;
    const attributes = image.attrs ?? {};
    records.push({
      data_url: src,
      name: firstValue(attributes.alt, attributes.title, "图片"),
      width: positiveInteger(attributes.width),
      height: positiveInteger(attributes.height),
      kind: resourcePurpose({ kind: classText(image) }, role === "user" ? "uploaded" : "inline")
    });
  }
  return records;
}

function resourceLocatorIdentity(record) {
  const key = firstValue(
    record?.preferred_resource_key,
    record?.resource_key,
    record?.resource_id,
    record?.file_key,
    record?.image_key,
    record?.attachment_id,
    record?.job_key,
    record?.key,
    record?.id
  );
  if (key) return `key:${key}`;
  const url = urlFromRecord(record);
  if (url) return `url:${url}`;
  const locator = record?.resource_locator;
  if (typeof locator === "string" && locator.trim()) return `locator:${locator.trim()}`;
  if (locator && typeof locator === "object" && Object.keys(locator).length) {
    return `locator:${stableFingerprint(locator)}`;
  }
  return null;
}

function resourceReferenceKeys(record) {
  return [
    record?.preferred_resource_key,
    record?.resource_key,
    record?.resource_id,
    record?.file_key,
    record?.image_key,
    record?.attachment_id,
    record?.job_key,
    record?.key,
    record?.id
  ].map((value) => nonEmpty(value)).filter(Boolean);
}

function resourceCollectionRecords(collection) {
  if (Array.isArray(collection)) return collection;
  if (!collection || typeof collection !== "object") return [];
  return Object.entries(collection).map(([key, record]) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    return {
      ...record,
      ...(resourceReferenceKeys(record).length ? {} : { id: key })
    };
  }).filter(Boolean);
}

function topLevelResourceRecords(context) {
  return [
    ...resourceCollectionRecords(context.payload?.resources),
    ...resourceCollectionRecords(context.payload?.files),
    ...resourceCollectionRecords(context.payload?.images)
  ].filter((record) => record && typeof record === "object" && !Array.isArray(record));
}

function topLevelResourceForRecord(context, record) {
  const keys = new Set(resourceReferenceKeys(record));
  if (!keys.size) return record;
  const match = topLevelResourceRecords(context).find((candidate) =>
    resourceReferenceKeys(candidate).some((key) => keys.has(key))
  );
  return match ? mergeResourceMetadata(record, match) : record;
}

function topLevelResourcesForMessage(context, message) {
  const resources = topLevelResourceRecords(context);
  if (!resources.length) return [];
  const byKey = new Map();
  for (const resource of resources) {
    for (const key of resourceReferenceKeys(resource)) {
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, resource);
    }
  }
  const result = [];
  const seen = new Set();
  const referencedRecords = [
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
    ...(Array.isArray(message?.media) ? message.media : []),
    ...(Array.isArray(message?.parts) ? message.parts : [])
      .filter((record) => ["img", "image", "attachment"].includes(
        String(record?.type ?? "").toLowerCase()
      ))
  ];
  for (const record of referencedRecords) {
    for (const key of resourceReferenceKeys(record)) {
      const resource = byKey.get(key);
      if (!resource || seen.has(resource)) continue;
      seen.add(resource);
      result.push({ record: mergeResourceMetadata(record, resource), source: "payload-resource" });
      break;
    }
  }
  const identity = messageIdentity(message);
  const messageIdentities = new Set([
    identity,
    identity && message?.version !== null && message?.version !== undefined
      ? `${identity}::${message.version}`
      : null
  ].filter(Boolean));
  if (messageIdentities.size) {
    for (const resource of resources) {
      const identities = [
        resource?.message_id,
        ...(Array.isArray(resource?.message_ids) ? resource.message_ids : []),
        ...(Array.isArray(resource?.message_keys) ? resource.message_keys : [])
      ].map((value) => String(value ?? "")).filter(Boolean);
      if (!identities.some((value) => messageIdentities.has(value)) || seen.has(resource)) continue;
      seen.add(resource);
      result.push({ record: resource, source: "payload-resource" });
    }
  }
  return result;
}

function mergeResourceMetadata(primary, secondary) {
  const merged = { ...(primary ?? {}) };
  for (const [key, value] of Object.entries(secondary ?? {})) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  const name = firstValue(primary?.name, primary?.filename, secondary?.name, secondary?.filename);
  if (name) merged.name = name;
  if (primary?.original || secondary?.original) {
    merged.original = { ...(primary?.original ?? {}), ...(secondary?.original ?? {}) };
  }
  if (primary?.archived || secondary?.archived) {
    merged.archived = { ...(primary?.archived ?? {}), ...(secondary?.archived ?? {}) };
  }
  return merged;
}

function geminiMessageImageRecords(context, message, role) {
  if (context.platform !== "gemini" || typeof message?.html !== "string") return [];
  const keys = [...message.html.matchAll(/<osis-image\b[^>]*\bdata-key=(?:"([^"]+)"|'([^']+)')[^>]*>/giu)]
    .map((match) => match[1] ?? match[2])
    .filter(Boolean);
  const records = [];
  for (const key of [...new Set(keys)]) {
    const record = (context.payload.images ?? []).find((candidate) => String(candidate?.key ?? "") === key);
    if (!record) continue;
    records.push({
      ...record,
      image_key: key,
      kind: role === "user"
        ? "attachment-image"
        : "generated-image"
    });
  }
  return records;
}

function normalizedResourceName(record) {
  return resourceName(record, "image")
    ?.toLowerCase()
    .replace(/\s+/gu, " ")
    .trim() ?? "";
}

function imageCandidateMetrics(record) {
  const decoded = decodeImageDataUrl(dataUrlFrom(record ?? {}));
  const hashes = [
    decoded ? sha256(decoded.bytes) : null,
    record?.sha256,
    record?.archived?.sha256,
    record?.original?.sha256,
    record?.source_sha256
  ].map((value) => nonEmpty(value)?.toLowerCase()).filter(Boolean);
  return {
    decoded,
    hashes: [...new Set(hashes)],
    bytes: decoded?.bytes.length
      ?? positiveInteger(record?.archived?.bytes)
      ?? positiveInteger(record?.thumbnail_size)
      ?? positiveInteger(record?.size_bytes)
      ?? positiveInteger(record?.size)
      ?? positiveInteger(record?.bytes),
    originalBytes: positiveInteger(record?.original_size_bytes)
      ?? positiveInteger(record?.original?.size_bytes)
      ?? positiveInteger(record?.original?.bytes)
      ?? positiveInteger(record?.source_size_bytes)
      ?? positiveInteger(record?.source_size),
    width: positiveInteger(record?.width)
      ?? positiveInteger(record?.archived?.width)
      ?? positiveInteger(record?.displayed_width),
    originalWidth: positiveInteger(record?.original_width)
      ?? positiveInteger(record?.original?.width)
      ?? positiveInteger(record?.source_width),
    height: positiveInteger(record?.height)
      ?? positiveInteger(record?.archived?.height)
      ?? positiveInteger(record?.displayed_height),
    originalHeight: positiveInteger(record?.original_height)
      ?? positiveInteger(record?.original?.height)
      ?? positiveInteger(record?.source_height),
    mime: decoded?.mimeType
      ?? nonEmpty(record?.archived?.mime)?.toLowerCase()
      ?? mimeFromRecord(record ?? {}, decoded),
    name: normalizedResourceName(record)
  };
}

function pairedImageDimension(left, right, dimension, originalDimension) {
  return Boolean(
    left[dimension]
    && right[dimension]
    && (
      left[dimension] === right[dimension]
      || left[dimension] === right[originalDimension]
      || right[dimension] === left[originalDimension]
      || (
        left[originalDimension]
        && right[originalDimension]
        && left[originalDimension] === right[originalDimension]
      )
    )
  );
}

function imagePairHasStrongEvidence(metadata, embedded) {
  const left = imageCandidateMetrics(metadata);
  const right = imageCandidateMetrics(embedded);
  const leftLocator = resourceLocatorIdentity(metadata);
  const rightLocator = resourceLocatorIdentity(embedded);
  if (leftLocator && rightLocator && leftLocator === rightLocator) return true;
  if (left.hashes.some((hash) => right.hashes.includes(hash))) return true;

  const byteLineage = Boolean(
    (left.bytes && left.bytes === right.originalBytes)
    || (right.bytes && right.bytes === left.originalBytes)
    || (
      left.originalBytes
      && right.originalBytes
      && left.originalBytes === right.originalBytes
    )
  );
  if (byteLineage) return true;

  const sameDimensions = pairedImageDimension(left, right, "width", "originalWidth")
    && pairedImageDimension(left, right, "height", "originalHeight");
  const sameName = Boolean(left.name && right.name && left.name === right.name);
  const compatibleMime = !left.mime || !right.mime || left.mime === right.mime;
  const exactArchivedBytes = Boolean(
    left.bytes
    && right.bytes
    && left.bytes === right.bytes
    && !(left.decoded && right.decoded)
  );
  return sameDimensions && compatibleMime && (sameName || exactArchivedBytes);
}

function imagePairScore(metadata, embedded) {
  const left = imageCandidateMetrics(metadata);
  const right = imageCandidateMetrics(embedded);
  let score = 0;
  if (left.bytes && right.bytes) {
    if (left.bytes === right.bytes) {
      score += 100;
    } else if (
      left.bytes === right.originalBytes
      || right.bytes === left.originalBytes
      || (left.originalBytes && left.originalBytes === right.originalBytes)
    ) {
      score += 92;
    }
  }
  if (left.width && right.width) {
    if (left.width === right.width) {
      score += 12;
    } else if (
      left.width === right.originalWidth
      || right.width === left.originalWidth
      || (left.originalWidth && left.originalWidth === right.originalWidth)
    ) {
      score += 10;
    }
  }
  if (left.height && right.height) {
    if (left.height === right.height) {
      score += 12;
    } else if (
      left.height === right.originalHeight
      || right.height === left.originalHeight
      || (left.originalHeight && left.originalHeight === right.originalHeight)
    ) {
      score += 10;
    }
  }
  if (left.mime && right.mime) {
    if (left.mime === right.mime) score += 8;
  }
  if (left.name && right.name && left.name === right.name) score += 24;
  return score;
}

function combineMetadataWithEmbedded(metadata, embedded) {
  const combined = mergeResourceMetadata(metadata, embedded);
  const name = firstValue(metadata?.name, metadata?.filename, embedded?.name, embedded?.alt);
  if (name) combined.name = name;
  if (metadata?.kind) combined.kind = metadata.kind;
  combined.data_url = dataUrlFrom(embedded);
  return combined;
}

function manifestMessageImageRecords(context, message, role) {
  const identity = messageIdentity(message);
  if (!identity) return [];
  return (Array.isArray(context.manifest?.artifacts) ? context.manifest.artifacts : [])
    .filter((artifact) =>
      String(artifact?.kind ?? "").toLowerCase() === "image"
      && String(artifact?.message_id ?? artifact?.source_id ?? "") === identity)
    .map((artifact) => {
      const semantic = [
        artifact?.image_kind,
        artifact?.purpose,
        artifact?.source,
        artifact?.resource_locator?.path
      ].map((value) => String(value ?? "").toLowerCase()).join(" ");
      const purpose = /(?:generated|rc_gen_image|text2img)/u.test(semantic)
        ? "generated"
        : /(?:search|source-card|reference)/u.test(semantic)
          ? "search"
          : /(?:uploaded|upload|user)/u.test(semantic) || role === "user"
            ? "uploaded"
            : "inline";
      return {
        ...artifact,
        kind: `${purpose}-image`,
        purpose,
        size_bytes: positiveInteger(artifact?.bytes),
        original_width: positiveInteger(artifact?.source_width),
        original_height: positiveInteger(artifact?.source_height)
      };
    });
}

function resolvedMessageResourceRecords(context, builder, message, node, role, messageIndex) {
  const resolvedTopLevel = topLevelResourcesForMessage(context, message);
  const topLevelKeys = new Set(
    resolvedTopLevel.flatMap((candidate) => resourceReferenceKeys(candidate.record))
  );
  const raw = [
    ...(Array.isArray(message?.attachments) ? message.attachments : [])
      .filter((record) => !resourceReferenceKeys(record).some((key) => topLevelKeys.has(key)))
      .map((record) => ({
        record,
        source: "attachment"
      })),
    ...(Array.isArray(message?.media) ? message.media : [])
      .filter((record) => !resourceReferenceKeys(record).some((key) => topLevelKeys.has(key)))
      .map((record) => ({
        record,
        source: "media"
      })),
    ...resolvedTopLevel,
    ...geminiMessageImageRecords(context, message, role).map((record) => ({
      record,
      source: "platform-image"
    }))
  ];
  const hasImageMetadata = raw.some((candidate) => {
    const decoded = decodeImageDataUrl(dataUrlFrom(candidate.record));
    return imageRecord(candidate.record, mimeFromRecord(candidate.record, decoded));
  });
  if (!hasImageMetadata) {
    raw.push(...manifestMessageImageRecords(context, message, role).map((record) => ({
      record,
      source: "manifest-image"
    })));
  }
  let metadata = [];
  const byLocator = new Map();
  for (const candidate of raw) {
    const locator = resourceLocatorIdentity(candidate.record);
    const existing = locator ? byLocator.get(locator) : null;
    if (existing) {
      existing.record = mergeResourceMetadata(existing.record, candidate.record);
      existing.sources.add(candidate.source);
      continue;
    }
    const value = {
      record: { ...candidate.record },
      sources: new Set([candidate.source]),
      order: metadata.length
    };
    metadata.push(value);
    if (locator) byLocator.set(locator, value);
  }

  // Some exporters describe one image twice inside the payload: a metadata
  // attachment (original filename, size and URL) plus an embedded/compressed
  // image record. Coalesce that pair before matching the visible DOM image so
  // the JSON keeps one faithful image resource instead of a metadata-only
  // shadow beside its thumbnail.
  const consumedPayloadImages = new Set();
  for (const candidate of metadata) {
    if (
      dataUrlFrom(candidate.record)
      || consumedPayloadImages.has(candidate)
      || !candidate.sources.has("attachment")
    ) continue;
    const decoded = decodeImageDataUrl(dataUrlFrom(candidate.record));
    if (!imageRecord(candidate.record, mimeFromRecord(candidate.record, decoded))) continue;
    const ranked = metadata
      .filter((entry) =>
        entry !== candidate
        && !consumedPayloadImages.has(entry)
        && (
          Boolean(dataUrlFrom(entry.record))
          || entry.sources.has("media")
          || entry.sources.has("platform-image")
          || entry.sources.has("manifest-image")
          || Boolean(entry.record?.archived)
        ))
      .map((entry) => ({ entry, score: imagePairScore(candidate.record, entry.record) }))
      .filter((entry) =>
        entry.score >= 24
        && imagePairHasStrongEvidence(candidate.record, entry.entry.record))
      .sort((left, right) => right.score - left.score || left.entry.order - right.entry.order);
    if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score)) continue;
    candidate.record = combineMetadataWithEmbedded(candidate.record, ranked[0].entry.record);
    for (const source of ranked[0].entry.sources) candidate.sources.add(source);
    consumedPayloadImages.add(ranked[0].entry);
  }
  if (consumedPayloadImages.size) {
    metadata = metadata.filter((candidate) => !consumedPayloadImages.has(candidate));
  }

  const embedded = domImageRecords(context, node, role).map((record, index) => ({
    record,
    index,
    used: false
  }));
  const imageMetadata = metadata.filter((candidate) => {
    const decoded = decodeImageDataUrl(dataUrlFrom(candidate.record));
    return imageRecord(candidate.record, mimeFromRecord(candidate.record, decoded));
  });
  const pairs = new Map();

  for (const candidate of imageMetadata) {
    const ranked = embedded
      .filter((entry) => !entry.used)
      .map((entry) => ({ entry, score: imagePairScore(candidate.record, entry.record) }))
      .filter((entry) =>
        entry.score >= 24
        && imagePairHasStrongEvidence(candidate.record, entry.entry.record))
      .sort((left, right) => right.score - left.score || left.entry.index - right.entry.index);
    if (!ranked.length) continue;
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) continue;
    ranked[0].entry.used = true;
    pairs.set(candidate, ranked[0].entry);
  }

  const unmatchedMetadata = imageMetadata.filter((candidate) => !pairs.has(candidate));
  const unmatchedEmbedded = embedded.filter((entry) => !entry.used);
  const uniqueUserUploadPair = (metadataCandidate, embeddedCandidate) => {
    if (role !== "user") return false;
    const left = imageCandidateMetrics(metadataCandidate.record);
    const right = imageCandidateMetrics(embeddedCandidate.record);
    return Boolean(
      left.name
      && left.name === right.name
      && (!left.mime || !right.mime || left.mime === right.mime)
    );
  };
  const advertisedEmbedded = (candidate) => {
    const status = String(
      candidate.record?.availability
      ?? candidate.record?.status
      ?? ""
    );
    return Boolean(
      candidate.record?.archived
      || candidate.record?.image_key
      || candidate.record?.key
      || /(?:embedded|thumbnail)/iu.test(status)
    );
  };
  if (unmatchedMetadata.length === 1
    && unmatchedEmbedded.length === 1
    && (
      advertisedEmbedded(unmatchedMetadata[0])
      || uniqueUserUploadPair(unmatchedMetadata[0], unmatchedEmbedded[0])
    )) {
    unmatchedEmbedded[0].used = true;
    pairs.set(unmatchedMetadata[0], unmatchedEmbedded[0]);
  } else if (unmatchedMetadata.length > 1
    && unmatchedMetadata.length === unmatchedEmbedded.length
    && unmatchedMetadata.every(advertisedEmbedded)) {
    builder.warn(
      "image_candidate_ambiguous",
      `同一消息有 ${unmatchedMetadata.length} 个已声明内嵌图片无法与静态 DOM 唯一配对，已保守保留。`,
      messageIndex
    );
  }

  const result = [];
  for (const candidate of metadata.sort((left, right) => left.order - right.order)) {
    const pair = pairs.get(candidate);
    const record = pair
      ? combineMetadataWithEmbedded(candidate.record, pair.record)
      : candidate.record;
    result.push({
      record,
      purpose: resourcePurpose(
        record,
        role === "user"
          ? "uploaded"
          : candidate.sources.has("media") || candidate.sources.has("platform-image")
            ? "generated"
            : "inline"
      )
    });
  }
  for (const entry of embedded.filter((candidate) => !candidate.used)) {
    result.push({ record: entry.record, purpose: role === "user" ? "uploaded" : "inline" });
  }
  return result;
}

function diagramFormat(node) {
  const classes = classText(node).toLowerCase();
  if (classes.includes("markmap")) return "markmap";
  if (classes.includes("mermaid") || classes.includes("classdiagram") || classes.includes("flowchart")) return "mermaid";
  if (classes.includes("canvas")) return "canvas";
  if (classes.includes("writing")) return "writing_block";
  return "svg";
}

function diagramSvgNode(context, node) {
  const ancestry = classText(node).toLowerCase();
  if (/(?:katex|temml|math|formula|equation)/u.test(ancestry)) return false;
  const raw = outerHtml(context, node);
  const explicitlyDiagram = /(?:mermaid|markmap|diagram|chart|flowchart|classdiagram|canvas|writing)/iu.test(ancestry);
  if (explicitlyDiagram) return true;
  return /<(?:text|foreignobject)\b/iu.test(raw)
    && Boolean(nonEmpty(htmlFragmentToText(raw, { skipTags: ["script", "style"] })));
}

function domDiagramRecords(context, node) {
  if (!node) return [];
  const result = [];
  const seen = new Set();
  for (const svg of descendants(node).filter((candidate) => candidate.tag === "svg")) {
    if (
      context.platform === "mistral"
      && ancestorHasClass(svg, "osis-artifact")
    ) {
      continue;
    }
    if (!diagramSvgNode(context, svg)) continue;
    const sanitized = sanitizeSvgFragment(outerHtml(context, svg));
    if (!sanitized) continue;
    const hash = sha256(Buffer.from(sanitized, "utf8"));
    if (seen.has(hash)) continue;
    seen.add(hash);
    result.push({
      node: svg,
      block: { type: "diagram", format: diagramFormat(svg), svg: sanitized }
    });
  }
  return result;
}

function svgFromDataUrl(value) {
  const source = String(value ?? "");
  const comma = source.indexOf(",");
  if (comma < 0 || !/^data:image\/svg\+xml(?:;[^,]*)?,/iu.test(source)) return null;
  const metadata = source.slice(5, comma).toLowerCase().split(";");
  const encoded = source.slice(comma + 1);
  if (!encoded) return null;
  try {
    const svg = metadata.includes("base64")
      ? Buffer.from(encoded.replace(/\s+/gu, ""), "base64").toString("utf8")
      : decodeURIComponent(encoded);
    return sanitizeSvgFragment(svg.replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

function mermaidCardSource(context, card) {
  const sourcePanel = descendants(card).find((candidate) =>
    candidate.attrs?.["data-osis-mermaid-panel"] === "source");
  if (!sourcePanel) return null;
  const code = descendants(sourcePanel).find((candidate) => candidate.tag === "code") ?? sourcePanel;
  return nonEmpty(htmlFragmentToText(innerHtml(context, code), { preserveWhitespace: true }));
}

export function chatGptMermaidRecords(context, builder, node, role) {
  if (!node) return [];
  const records = [];
  for (const card of descendants(node).filter((candidate) => hasClass(candidate, "osis-mermaid-card"))) {
    const source = mermaidCardSource(context, card);
    if (!source) continue;
    const diagramPanel = descendants(card).find((candidate) =>
      candidate.attrs?.["data-osis-mermaid-panel"] === "diagram");
    const inlineSvg = diagramPanel
      ? descendants(diagramPanel).find((candidate) => candidate.tag === "svg")
      : null;
    const image = diagramPanel
      ? descendants(diagramPanel).find((candidate) => candidate.tag === "img")
      : null;
    const sanitized = inlineSvg
      ? sanitizeSvgFragment(outerHtml(context, inlineSvg))
      : svgFromDataUrl(image?.attrs?.src);
    if (sanitized) {
      records.push({
        source,
        block: { type: "diagram", format: "mermaid", svg: sanitized }
      });
      continue;
    }
    if (!image || /^data:image\/svg\+xml(?:;|,)/iu.test(String(image.attrs?.src ?? ""))) {
      records.push({ source, block: null });
      continue;
    }
    const resourceKey = nonEmpty(image.attrs?.["data-osis-resource-id"]);
    if (!resourceKey && !nonEmpty(image.attrs?.src)) {
      records.push({ source, block: null });
      continue;
    }
    const record = topLevelResourceForRecord(context, {
      ...(resourceKey ? { id: resourceKey } : {}),
      ...(nonEmpty(image.attrs?.src) ? { data_url: image.attrs.src } : {}),
      name: firstValue(image.attrs?.alt, image.attrs?.title, "Mermaid 图示"),
      kind: "diagram"
    });
    const added = builder.addResource(record, { purpose: "diagram", role });
    records.push({
      source,
      block: { type: "diagram", format: "mermaid", resource_id: added.resource.id }
    });
  }
  return records;
}

function staticMathRecords(context, builder, node, messageIndex) {
  if (!node) return [];
  const shells = descendants(node).filter((candidate) =>
    hasClass(candidate, "osis-katex-shell")
    && !ancestorHasClass(candidate, "osis-katex-shell")
    && !ancestorHasClass(candidate, "osis-thinking"));
  const result = [];
  for (const shell of shells) {
    const hasSource = nonEmpty(shell.attrs?.["data-tex"])
      || descendants(shell).some((candidate) =>
        nonEmpty(candidate.attrs?.["data-tex"])
        || (
          candidate.tag === "annotation"
          && /(?:application|text)\/x-tex/iu.test(String(candidate.attrs?.encoding ?? ""))
        ));
    if (hasSource) continue;
    const html = sanitizeStaticMathFragment(outerHtml(context, shell));
    if (!html) continue;
    const display = hasClass(shell, "osis-math-display")
      || ["block", "true", "display"].includes(String(shell.attrs?.["data-math-display"] ?? "").toLowerCase());
    result.push({
      node: shell,
      block: {
        type: "html",
        label: display ? "cloudig-static-katex-display" : "cloudig-static-katex-inline",
        html
      }
    });
  }
  if (result.length) {
    builder.warn(
      "math_source_missing",
      `${result.length} 个公式只有静态 KaTeX 排版，没有可恢复的原始 TeX；已保留离线静态排版。`,
      messageIndex
    );
  }
  return result;
}

function payloadDiagrams(message) {
  const result = [];
  for (const record of Array.isArray(message?.diagrams) ? message.diagrams : []) {
    const source = nonEmpty(record?.source);
    if (!source) continue;
    const kind = String(record?.kind ?? "").toLowerCase();
    const format = kind.includes("markmap") ? "markmap" : kind.includes("mermaid") ? "mermaid" : "other";
    result.push({ type: "diagram", format, source });
  }
  return result;
}

function queryText(value) {
  if (typeof value === "string") return nonEmpty(value);
  return firstValue(value?.query, value?.q, value?.text, value?.title);
}

function doubaoVisibleSources(context, message, node) {
  if (context.platform !== "doubao" || !node) return [];
  const label = nonEmpty(message?.public_thought_label);
  if (!label || !/参考\s*\d+\s*篇资料/u.test(label)) return [];
  const target = mainTargetNode(node, context.platform);
  const records = [];
  const seen = new Set();
  for (const anchor of descendants(target).filter((candidate) => candidate.tag === "a")) {
    const url = safeHttpUrl(anchor.attrs?.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    records.push({
      url,
      title: nonEmpty(nodeText(context, anchor)) ?? undefined
    });
  }
  return records;
}

function sourcesForMessage(context, message, node = null) {
  if (context.platform === "yuanbao") {
    const indices = [...new Set([...(message?.source_indices ?? []), ...(message?.reference_indices ?? [])].map(String))];
    return indices.map((index) => (context.payload.sources ?? []).find((source) => String(source?.index) === index)).filter(Boolean);
  }
  if (context.platform === "doubao") return doubaoVisibleSources(context, message, node);
  if (context.platform === "mistral") return message?.references ?? [];
  if (context.platform === "grok") {
    const thoughtText = (Array.isArray(message?.thoughts) ? message.thoughts : [])
      .flatMap((thought) => [thought?.label, thought?.title, thought?.text, thought?.content])
      .filter(Boolean)
      .join("\n");
    const searched = /已搜索\s*(?:网络|图像|𝕏)/u.test(thoughtText)
      || /\b(?:searched|searching)\s+(?:the\s+)?(?:web|images?|x)\b/iu.test(thoughtText);
    return searched ? message?.sources ?? [] : [];
  }
  return message?.sources ?? [];
}

function replaceMarkdownOutsideCode(markdown, replaceText) {
  const lines = String(markdown ?? "").split("\n");
  let fence = null;
  const transformInline = (line) => {
    let result = "";
    let cursor = 0;
    let delimiter = 0;
    const runs = [...line.matchAll(/`+/gu)];
    for (const run of runs) {
      const start = run.index ?? 0;
      if (start < cursor) continue;
      const width = run[0].length;
      if (!delimiter) {
        result += replaceText(line.slice(cursor, start));
        result += run[0];
        delimiter = width;
      } else {
        result += line.slice(cursor, start);
        result += run[0];
        if (width === delimiter) delimiter = 0;
      }
      cursor = start + width;
    }
    result += delimiter ? line.slice(cursor) : replaceText(line.slice(cursor));
    return result;
  };
  return lines.map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
    if (fence) {
      if (marker?.[0] === fence.character && marker.length >= fence.length) fence = null;
      return line;
    }
    if (marker) {
      fence = { character: marker[0], length: marker.length };
      return line;
    }
    return transformInline(line);
  }).join("\n");
}

function normalizeDeepSeekReferences(context, builder, message, markdown, messageIndex) {
  if (context.platform !== "deepseek" || !nonEmpty(markdown)) return markdown;
  const sources = Array.isArray(message?.sources) ? message.sources : [];
  const unresolved = new Set();
  const normalized = replaceMarkdownOutsideCode(markdown, (text) =>
    text.replace(/\[reference:(\d+)\]/giu, (_token, rawIndex) => {
    const sourceIndex = Number(rawIndex);
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
      unresolved.add(rawIndex);
      return `〔未解析引用 ${rawIndex}〕`;
    }
    const displayIndex = sourceIndex + 1;
    const url = sourceUrl(sources[sourceIndex]);
    if (!url) {
      unresolved.add(String(displayIndex));
      return `〔未解析引用 ${displayIndex}〕`;
    }
    return `[${displayIndex}](${markdownLinkDestination(url)})`;
    }));
  if (unresolved.size) {
    builder.warn(
      "deepseek_reference_unresolved",
      `正文引用 ${[...unresolved].join("、")} 没有对应来源地址，已保留为未解析引用。`,
      messageIndex
    );
  }
  return normalized;
}

function normalizePlatformReferences(context, builder, message, markdown, messageIndex, {
  scopeLabel = "正文",
  warningCode = `${context.platform}_reference_unresolved`
} = {}) {
  if (!["qwen", "zai", "chatglm"].includes(context.platform) || !nonEmpty(markdown)) return markdown;
  const sources = Array.isArray(message?.sources) ? message.sources : [];
  const unresolved = new Set();
  const unresolvedReference = (reference, originalToken) => {
    unresolved.add(reference);
    return originalToken;
  };
  const sourceForInternalId = (internalId, index) => {
    const exact = sources.find((source) => String(source?.id ?? "") === internalId) ?? null;
    if (exact || context.platform === "chatglm") return exact;
    const positional = sources[index] ?? null;
    return positional && !nonEmpty(positional?.id) ? positional : null;
  };
  const normalized = replaceMarkdownOutsideCode(markdown, (text) => {
    if (context.platform === "qwen") {
      return text.replace(/\[\[(\d+)\]\]/gu, (token, rawIndex) => {
        const displayIndex = Number(rawIndex);
        const source = Number.isSafeInteger(displayIndex) && displayIndex > 0
          ? sources[displayIndex - 1]
          : null;
        const url = sourceUrl(source);
        if (!url) return unresolvedReference(rawIndex, token);
        return `[${displayIndex}](${markdownLinkDestination(url)})`;
      });
    }
    return text.replace(/【(turn\d+search(\d+))】/giu, (token, internalId, rawIndex) => {
      const sourceIndex = Number(rawIndex);
      const source = Number.isSafeInteger(sourceIndex) && sourceIndex >= 0
        ? sourceForInternalId(internalId, sourceIndex)
        : null;
      const url = sourceUrl(source);
      if (!url) return unresolvedReference(internalId, token);
      return `[${sourceIndex + 1}](${markdownLinkDestination(url)})`;
    });
  });
  if (unresolved.size && builder) {
    builder.warn(
      warningCode,
      `${scopeLabel}引用 ${[...unresolved].join("、")} 没有对应来源地址，已保留原始引用标记。`,
      messageIndex
    );
  }
  return normalized;
}

function normalizeThoughtReferences(context, builder, message, markdown, messageIndex) {
  if (!["zai", "chatglm"].includes(context.platform)) return markdown;
  return normalizePlatformReferences(context, builder, message, markdown, messageIndex, {
    scopeLabel: "思考",
    warningCode: `${context.platform}_reasoning_reference_unresolved`
  });
}

function normalizeMessageReferences(context, builder, message, markdown, messageIndex) {
  return normalizePlatformReferences(
    context,
    builder,
    message,
    normalizeDeepSeekReferences(context, builder, message, markdown, messageIndex),
    messageIndex
  );
}

function searchQueries(message) {
  const queryRecords = message?.search_queries ?? message?.queries ?? [];
  return [...new Set(
    (Array.isArray(queryRecords) ? queryRecords : [queryRecords])
      .map(queryText)
      .filter(Boolean)
  )];
}

function addSearchQueryBlocks(message, content) {
  searchQueries(message).forEach((query, index) => {
    const block = { type: "search", query };
    const duration = finitePositive(message?.search_duration_seconds);
    if (index === 0 && duration !== null) block.duration_seconds = duration;
    content.push(block);
  });
}

function addCitationBlocks(context, builder, message, content, messageIndex, node = null) {
  const sources = sourcesForMessage(context, message, node);
  const sourceIds = builder.addSources(sources, messageIndex);
  if (sourceIds.length) {
    content.push({ type: "citations", source_ids: sourceIds });
  }
  if (context.platform === "doubao") {
    const advertised = /参考\s*(\d+)\s*篇资料/u.exec(String(message?.public_thought_label ?? ""))?.[1];
    const advertisedCount = Number(advertised);
    if (Number.isSafeInteger(advertisedCount) && advertisedCount > sourceIds.length) {
      builder.warn(
        "doubao_source_count_mismatch",
        `页面标示参考 ${advertisedCount} 篇资料，但只暴露了 ${sourceIds.length} 个可验证链接；未补造缺失来源。`,
        messageIndex
      );
    }
  }
}

function addToolBlocks(message, content, { suppressSearch = false } = {}) {
  for (const record of [
    ...(Array.isArray(message?.tool_events) ? message.tool_events : []),
    ...(Array.isArray(message?.tools) ? message.tools : [])
  ]) {
    const block = { type: "tool", kind: "activity" };
    const name = firstValue(record?.name, record?.tool_type, record?.integration);
    const title = firstValue(record?.label, record?.title);
    if (
      suppressSearch
      && /(?:search|搜索)/iu.test(`${name ?? ""} ${title ?? ""}`)
    ) {
      continue;
    }
    const body = firstValue(record?.text, record?.content, record?.summary, record?.result);
    const status = firstValue(record?.status);
    if (name) block.name = name;
    if (title) block.title = title;
    if (body) block.markdown = body;
    if (status) block.status = status;
    if (typeof record?.success === "boolean") block.success = record.success;
    else if (typeof record?.done === "boolean") block.success = record.done;
    if (block.name || block.title || block.markdown) content.push(block);
  }
}

function addYuanbaoFileWarning(context, message, content) {
  if (context.platform !== "yuanbao") return;
  const text = nonEmpty(message?.file_warning);
  if (!text) return;
  content.push({
    type: "status",
    title: "文件读取提示",
    text
  });
}

function markdownFence(value, language = "") {
  const body = String(value ?? "");
  const longest = [...body.matchAll(/`+/gu)]
    .reduce((maximum, match) => Math.max(maximum, match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${nonEmpty(language) ?? ""}\n${body}\n${fence}`;
}

function addGeminiDomTools(context, node, content) {
  if (context.platform !== "gemini" || !node) return;
  const target = descendants(node).find((candidate) => hasClass(candidate, "assistant-content"));
  for (const panel of actualGeminiExecutionPanels(context, target)) {
    const pre = descendants(panel)
      .filter((candidate) => candidate.tag === "pre" && candidate.attrs?.["data-language"]);
    if (pre.length !== 2) continue;
    const language = nonEmpty(pre[0].attrs?.["data-language"]) ?? "text";
    const code = htmlFragmentToText(innerHtml(context, pre[0]), { preserveWhitespace: true });
    const output = htmlFragmentToText(innerHtml(context, pre[1]), { preserveWhitespace: true });
    const markdown = [
      markdownFence(code, language.toLowerCase()),
      "**代码输出**",
      markdownFence(output, "text")
    ].join("\n\n");
    content.push({
      type: "tool",
      kind: "activity",
      name: language,
      title: "代码执行",
      markdown,
      success: !/(?:traceback|(?:^|\s)error(?::|\s|$))/iu.test(output)
    });
  }
}

function addResourceRecords(builder, records, content, seenResources, options) {
  for (const record of Array.isArray(records) ? records : []) {
    const added = builder.addResource(record, options);
    if (seenResources.has(added.resource.id)) continue;
    seenResources.add(added.resource.id);
    content.push(added.block);
  }
}

const ATTACHMENT_CARD_CLASSES = new Set([
  "attachment",
  "osis-attachment",
  "osis-attachment-item",
  "asset-placeholder",
  "file-card"
]);

function isAttachmentCardNode(node) {
  const classes = String(node?.attrs?.class ?? "").split(/\s+/u).filter(Boolean);
  return classes.some((className) => ATTACHMENT_CARD_CLASSES.has(className));
}

function nearestAttachmentCard(node, boundary) {
  for (let current = node?.parent; current && current !== boundary; current = current.parent) {
    if (isAttachmentCardNode(current)) return current;
  }
  return null;
}

function nearestMediaCard(node, boundary) {
  for (let current = node?.parent; current && current !== boundary; current = current.parent) {
    if (
      hasClass(current, "osis-media")
      || hasClass(current, "image-card")
      || hasClass(current, "osis-image")
      || current.tag === "figure"
    ) return current;
  }
  return null;
}

function nearestSearchCard(node, boundary) {
  for (let current = node?.parent; current && current !== boundary; current = current.parent) {
    if (
      current.tag === "a"
      && (
        hasClass(current, "pua-ref-article-single")
        || hasClass(current, "search-source-card")
        || hasClass(current, "source-card")
      )
    ) return current;
  }
  return null;
}

function resourceNodeForRecord(context, messageNode, prepared, usedNodes) {
  if (!messageNode) return null;
  const all = descendants(messageNode);
  if (prepared.resource.kind === "image") {
    const image = all.find((candidate) => {
      if (candidate.tag !== "img" || usedNodes.has(candidate)) return false;
      const decoded = decodeImageDataUrl(candidate.attrs?.src);
      return decoded && `image_${sha256(decoded.bytes)}` === prepared.resource.id;
    });
    if (image) {
      const searchCard = prepared.block.purpose === "search"
        ? nearestSearchCard(image, messageNode)
        : null;
      const media = nearestMediaCard(image, messageNode);
      const card = prepared.block.purpose === "uploaded"
        ? nearestAttachmentCard(image, messageNode)
        : null;
      const selected = searchCard && !usedNodes.has(searchCard)
        ? searchCard
        : card && !usedNodes.has(card)
          ? card
          : media && !usedNodes.has(media)
            ? media
          : image;
      usedNodes.add(selected);
      return selected;
    }
  }
  const name = nonEmpty(prepared.resource.name);
  if (!name) return null;
  const card = all
    .filter((candidate) => isAttachmentCardNode(candidate) && !usedNodes.has(candidate))
    .filter((candidate) => nodeText(context, candidate).includes(name))
    .sort((left, right) =>
      ((left.end ?? left.openEnd) - left.start) - ((right.end ?? right.openEnd) - right.start))[0];
  if (card) usedNodes.add(card);
  return card ?? null;
}

function searchCardCompanionBlock(context, node) {
  if (!node || node.tag !== "a") return null;
  const url = safeHttpUrl(node.attrs?.href);
  if (!url) return null;
  const titleNode = descendants(node).find((candidate) =>
    hasClass(candidate, "pua-ref-article-single__title")
    || hasClass(candidate, "source-card-title"));
  const siteNode = descendants(node).find((candidate) =>
    hasClass(candidate, "pua-ref-article-single__site")
    || hasClass(candidate, "source-card-site"));
  const title = nonEmpty(nodeText(context, titleNode));
  const site = nonEmpty(nodeText(context, siteNode));
  const label = [site, title].filter(Boolean).join(" · ") || url;
  return {
    type: "markdown",
    text: `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${markdownLinkDestination(url)})`
  };
}

function projectedResourceBlocks(context, record) {
  if (record.block?.purpose !== "search") return record.block;
  const companion = searchCardCompanionBlock(context, record.node);
  return companion ? [record.block, companion] : record.block;
}

export function prepareMessageResources(context, builder, message, node, role, messageIndex) {
  const result = [];
  const seen = new Set();
  for (const candidate of resolvedMessageResourceRecords(context, builder, message, node, role, messageIndex)) {
    const added = builder.addResource(candidate.record, {
      role,
      purpose: candidate.purpose
    });
    if (seen.has(added.resource.id)) continue;
    seen.add(added.resource.id);
    result.push({ ...added, node: null });
  }
  const usedNodes = new Set();
  for (const prepared of result) {
    prepared.node = resourceNodeForRecord(context, node, prepared, usedNodes);
  }
  return result;
}

function nodeInsideTarget(node, target) {
  const start = target?.openEnd ?? 0;
  const end = target?.closeStart ?? target?.end ?? start;
  const nodeEnd = node?.end ?? node?.closeStart ?? node?.openEnd ?? 0;
  return Boolean(node && node.start >= start && nodeEnd <= end);
}

function fragmentWithReplacements(context, target, replacements) {
  const start = target?.openEnd ?? 0;
  const end = target?.closeStart ?? target?.end ?? start;
  const ranges = replacements
    .map((record) => ({
      start: Math.max(start, record.node?.start ?? start),
      end: Math.min(end, record.node?.end ?? record.node?.closeStart ?? record.node?.openEnd ?? end),
      replacement: record.replacement ?? "",
      priority: record.priority ?? 0
    }))
    .filter((range) => range.start >= start && range.end > range.start && range.start < end)
    .sort((left, right) =>
      left.start - right.start || right.priority - left.priority || right.end - left.end);
  let cursor = start;
  let result = "";
  for (const range of ranges) {
    if (range.start < cursor) continue;
    result += context.html.slice(cursor, range.start);
    result += range.replacement;
    cursor = range.end;
  }
  result += context.html.slice(cursor, end);
  return result;
}

function splitProjectedMarkdown(markdown, components) {
  if (!components.length) {
    return nonEmpty(markdown) ? [{ type: "markdown", text: nonEmpty(markdown) }] : [];
  }
  const byToken = new Map(components.map((component) => [component.token, component.block]));
  const expression = new RegExp(`(${components.map((component) => component.token).join("|")})`, "gu");
  const blocks = [];
  for (const part of String(markdown ?? "").split(expression)) {
    if (!part) continue;
    const component = byToken.get(part);
    if (component) {
      blocks.push(...(Array.isArray(component) ? component : [component]));
      continue;
    }
    const text = nonEmpty(part);
    if (text) blocks.push({ type: "markdown", text });
  }
  return blocks;
}

function projectGenericVisibleContent(context, builder, message, node, role, messageIndex) {
  const resources = prepareMessageResources(context, builder, message, node, role, messageIndex);
  const diagrams = domDiagramRecords(context, node);
  const staticMath = staticMathRecords(context, builder, node, messageIndex);
  const target = mainTargetNode(node, context.platform);
  if (!node || !target) {
    const main = mainMarkdownForMessage(context, message, node);
    const referenced = normalizeMessageReferences(context, builder, message, main, messageIndex);
    const restored = context.platform === "kimi"
      ? restorePayloadMath(referenced, message)
      : { markdown: referenced, unmatched: [] };
    return [
      ...(nonEmpty(restored.markdown) ? [{ type: "markdown", text: nonEmpty(restored.markdown) }] : []),
      ...restored.unmatched,
      ...resources.map((record) => record.block),
      ...staticMath.map((record) => record.block),
      ...(diagrams.length ? diagrams.map((record) => record.block) : payloadDiagrams(message))
    ];
  }

  const records = [
    ...resources.map((record) => ({
      ...record,
      kind: "resource",
      block: projectedResourceBlocks(context, record)
    })),
    ...staticMath.map((record) => ({ ...record, kind: "static-math" })),
    ...diagrams.map((record) => ({ ...record, kind: "diagram" }))
  ];
  const inside = records
    .filter((record) => nodeInsideTarget(record.node, target))
    .sort((left, right) => left.node.start - right.node.start);
  const components = inside.map((record, index) => ({
    node: record.node,
    block: record.block,
    token: `CLOUDIGBLOCKTOKEN${messageIndex}X${index}Z`
  }));
  const componentNodes = new Set(components.map((component) => component.node));
  const replacements = components.map((component) => ({
    node: component.node,
    replacement: component.token,
    priority: 2
  }));
  for (const excluded of mainExcludedNodes(context, target, context.platform)) {
    const containsComponent = components.some((component) =>
      component.node.start >= excluded.start
      && (component.node.end ?? component.node.openEnd) <= (excluded.end ?? excluded.openEnd));
    if (!componentNodes.has(excluded) && !containsComponent) {
      replacements.push({ node: excluded, replacement: "", priority: 1 });
    }
  }
  for (const card of descendants(target).filter(isAttachmentCardNode)) {
    const containsComponent = components.some((component) =>
      component.node.start >= card.start
      && (component.node.end ?? component.node.openEnd) <= (card.end ?? card.openEnd));
    if (!componentNodes.has(card) && !containsComponent) {
      replacements.push({ node: card, replacement: "", priority: 1 });
    }
  }
  for (const image of descendants(target).filter((candidate) => candidate.tag === "img")) {
    if (!componentNodes.has(image)) replacements.push({ node: image, replacement: "", priority: 0 });
  }
  let projected = htmlFragmentToMarkdown(fragmentWithReplacements(context, target, replacements));
  if (
    context.platform === "qwen"
    && Array.isArray(message?.sources)
    && message.sources.length
    && components.length === 0
    && nonEmpty(message?.content_markdown)
  ) {
    projected = message.content_markdown;
  }
  projected = normalizeMessageReferences(context, builder, message, projected, messageIndex);
  const restored = context.platform === "kimi"
    ? restorePayloadMath(projected, message)
    : { markdown: projected, unmatched: [] };
  const mainBlocks = splitProjectedMarkdown(restored.markdown, components);
  const beforeRecords = records
    .filter((record) => record.node && !componentNodes.has(record.node) && (record.node.end ?? 0) <= target.start)
    .sort((left, right) => left.node.start - right.node.start);
  const beforeRecordSet = new Set(beforeRecords);
  const before = beforeRecords
    .flatMap((record) => Array.isArray(record.block) ? record.block : [record.block]);
  const after = records
    .filter((record) => !componentNodes.has(record.node) && !beforeRecordSet.has(record))
    .sort((left, right) => {
      if (!left.node && !right.node) return 0;
      if (!left.node) return 1;
      if (!right.node) return -1;
      return left.node.start - right.node.start;
    })
    .flatMap((record) => Array.isArray(record.block) ? record.block : [record.block]);
  if (!diagrams.length) after.push(...payloadDiagrams(message));
  return [...before, ...mainBlocks, ...restored.unmatched, ...after];
}

export function addGenericMessage(context, builder, message, index, relation = {}) {
  const role = normalizedRole(message?.role);
  const node = selectMessageNode(context, message);
  const content = [];
  addPlatformThoughts(context, message, content, node, builder, index);
  addGeminiDomTools(context, node, content);
  addSearchQueryBlocks(message, content);
  if (context.platform !== "mistral") {
    addToolBlocks(message, content, { suppressSearch: searchQueries(message).length > 0 });
  }

  if (context.platform === "mistral") {
    addToolBlocks(message, content);
    const visible = mistralVisibleContentBlocks(context, builder, message, node, role, index);
    if (visible.length) content.push(...visible);
    else {
      const main = mainMarkdownForMessage(context, message, node);
      if (nonEmpty(main)) content.push({ type: "markdown", text: main });
    }
  } else {
    content.push(...projectGenericVisibleContent(context, builder, message, node, role, index));
  }
  addYuanbaoFileWarning(context, message, content);
  addCitationBlocks(context, builder, message, content, index, node);

  if (!node) {
    builder.warn("dom_message_missing", "机器顺序中的消息没有对应静态阅读 DOM。", index);
  } else {
    const domRole = roleFromNode(node);
    if (domRole && domRole !== role) {
      builder.warn("role_alignment_conflict", `payload 角色 ${role} 与静态 DOM 角色 ${domRole} 不一致。`, index);
    }
  }
  const model = firstValue(message?.model);
  builder.addMessage({
    id: relation.id,
    parentId: relation.parentId,
    turnId: relation.turnId,
    role,
    model,
    timestamp: message?.inserted_at ?? message?.timestamp ?? message?.created_at,
    content
  });
}

export function importExporterWarnings(context, builder) {
  for (const warning of Array.isArray(context.payload.warnings) ? context.payload.warnings : []) {
    const message = typeof warning === "string" ? warning : stableFingerprint(warning);
    // Exporter diagnostics are broader than the unified JSON warning contract.
    // Expected A-Light policy, source-page font fetches, bounded layout probes and
    // successful lossless normalization remain in the source HTML but are not
    // content-loss warnings for the JSON-only Reader.
    if (!isNonMaterialExporterNotice(message)) builder.warn("exporter_warning", message);
  }
  const unknown = context.payload.unknown_visible_components;
  if (Array.isArray(unknown) && unknown.length) {
    builder.warn("unknown_visible_components", `导出器记录了 ${unknown.length} 个未分类可见组件。`);
  }
}

export function finalizeGenericConversation(context, descriptor) {
  const builder = new ConversationBuilder(context, descriptor);
  const messages = orderedMessages(context);
  messages.forEach((message, index) => addGenericMessage(context, builder, message, index));
  if (context.messageNodes.length !== messages.length) {
    builder.warn(
      "dom_message_count_mismatch",
      `机器顺序为 ${messages.length} 项，静态 DOM 为 ${context.messageNodes.length} 个消息片段。`
    );
  }
  importExporterWarnings(context, builder);
  return builder.finalize();
}

export function chatGptDomNode(context, id, occurrence) {
  return (context.messageNodesById.get(String(id)) ?? [])[occurrence] ?? null;
}

export function chatGptItemSourceRecords(item) {
  return Array.isArray(item?.sources) ? item.sources : [];
}

export function addChatGptResources(context, builder, item, node, content, role) {
  const seen = new Set(content.map((block) => block?.resource_id).filter(Boolean));
  // Ordered item parts are projected in projectChatGptItemContent. Re-adding them
  // here would duplicate the same attachment after its surrounding text.
  // Mermaid previews are paired with their exact source and inserted in-place by
  // the ChatGPT projector; treating them as ordinary images would duplicate and
  // move them to the end of the answer.
  addResourceRecords(builder, domImageRecords(context, node, role, {
    excludeMermaidCards: true
  }), content, seen, {
    role,
    purpose: item?.kind === "assistant_asset" ? "generated" : role === "user" ? "uploaded" : "inline"
  });
}

export function chatGptPartResource(context, builder, item, part, role) {
  if (!["img", "image", "attachment"].includes(String(part?.type ?? "").toLowerCase())) return null;
  const explicitPurpose = item?.kind === "assistant_asset"
    ? "generated"
    : role === "user"
      ? "uploaded"
      : null;
  const record = topLevelResourceForRecord(context, part);
  return builder.addResource(explicitPurpose ? { ...record, purpose: explicitPurpose } : record, {
    role,
    purpose: explicitPurpose ?? "inline"
  }).block;
}

export function addChatGptSources(builder, item, content, messageIndex) {
  const ids = builder.addSources(chatGptItemSourceRecords(item), messageIndex);
  if (ids.length) content.push({ type: "citations", source_ids: ids });
}

export function chatGptPartText(value) {
  if (value?.type === "img" || value?.type === "image" || value?.type === "attachment") return null;
  return nonEmpty(
    sourceString(value).replaceAll("\uE000OSIS_MEMORY_SOURCE_PENDING\uE001", "")
  );
}
