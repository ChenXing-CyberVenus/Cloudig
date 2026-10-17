import { sanitizeRichTextFragment } from "../html.mjs";
import {
  ConversationBuilder,
  importExporterWarnings,
  prepareMessageResources,
  selectMessageNode
} from "./common.mjs";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function stableJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return text(value);
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input).sort().map((key) => [key, normalize(input[key])])
    );
  };
  return JSON.stringify(normalize(value), null, 2);
}

function fencedJson(value) {
  const body = stableJson(value);
  return body ? `\`\`\`json\n${body}\n\`\`\`` : null;
}

function blockSources(builder, records, label, messageIndex) {
  const sourceIds = builder.addSources(records, messageIndex);
  return sourceIds.length ? { type: "citations", source_ids: sourceIds, ...(label ? { label } : {}) } : null;
}

function thinkingBlock(block) {
  const duration = positive(block?.seconds);
  const summaries = (Array.isArray(block?.summaries) ? block.summaries : [])
    .map(text)
    .filter(Boolean);
  const body = text(block?.body);
  if (summaries.length) {
    return {
      type: "reasoning_summary",
      markdown: summaries.join("\n\n"),
      ...(duration ? { duration_seconds: duration } : {})
    };
  }
  if (body) {
    return {
      type: "reasoning",
      markdown: body,
      ...(duration ? { duration_seconds: duration } : {})
    };
  }
  return duration ? { type: "status", title: "思考", duration_seconds: duration } : null;
}

function textBlocks(builder, block, messageIndex) {
  const content = [];
  const markdown = text(block?.markdown);
  const rich = text(block?.rich_html);
  if (markdown) content.push({ type: "markdown", text: markdown });
  else if (rich) {
    const html = sanitizeRichTextFragment(rich);
    if (html) content.push({ type: "html", html });
  }
  const citations = blockSources(builder, block?.citations, "参考", messageIndex);
  if (citations) content.push(citations);
  return content;
}

function toolUseBlocks(block) {
  const name = text(block?.name);
  const summary = text(block?.message);
  const input = fencedJson(block?.input);
  const body = [summary, input].filter(Boolean).join("\n\n");
  return [{
    type: "tool",
    kind: "call",
    ...(name ? { name } : {}),
    ...(body ? { markdown: body } : { title: "工具调用" })
  }];
}

function toolResultText(block) {
  const parts = [];
  const message = text(block?.message);
  if (message) parts.push(message);
  for (const item of Array.isArray(block?.content) ? block.content : []) {
    if (typeof item === "string") {
      const value = text(item);
      if (value) parts.push(value);
      continue;
    }
    const value = text(item?.text);
    if (value) {
      parts.push(value);
      continue;
    }
    const name = text(item?.name);
    if (name) parts.push(`文件：${name}`);
  }
  return parts.join("\n\n");
}

function toolResultBlocks(builder, block, messageIndex) {
  const name = text(block?.name);
  const body = toolResultText(block);
  const content = [{
    type: "tool",
    kind: "result",
    ...(name ? { name } : {}),
    ...(body ? { markdown: body } : { title: "工具结果" }),
    ...(typeof block?.is_error === "boolean" ? { success: !block.is_error } : {})
  }];
  const citations = blockSources(builder, block?.sources, "搜索结果", messageIndex);
  if (citations) content.push(citations);
  return content;
}

function artifactBlocks(context, message) {
  const messageId = String(message?.id ?? "");
  return (Array.isArray(context.payload?.artifacts) ? context.payload.artifacts : [])
    .filter((artifact) => String(artifact?.message_id ?? "") === messageId)
    .map((artifact) => {
      const source = text(artifact?.source);
      if (!source) return null;
      const extension = text(artifact?.extension)?.toLowerCase();
      const preview = text(artifact?.preview_kind)?.toLowerCase();
      const format = extension === "svg"
        ? "svg"
        : extension === "html" || preview === "html"
          ? "html"
          : "other";
      return {
        type: "diagram",
        format,
        source,
        ...(text(artifact?.name) ? { title: text(artifact.name) } : {})
      };
    })
    .filter(Boolean);
}

export function claudeMessageContent(context, builder, message, messageIndex) {
  const content = [];
  for (const block of Array.isArray(message?.blocks) ? message.blocks : []) {
    if (block?.type === "text") content.push(...textBlocks(builder, block, messageIndex));
    else if (block?.type === "thinking") content.push(thinkingBlock(block));
    else if (block?.type === "tool_use") content.push(...toolUseBlocks(block));
    else if (block?.type === "tool_result") content.push(...toolResultBlocks(builder, block, messageIndex));
    else {
      const body = text(block?.markdown) ?? text(block?.text) ?? text(block?.message);
      content.push({
        type: "unknown",
        label: `Claude 可见组件：${text(block?.type) ?? "unknown"}`,
        ...(body ? { text: body } : {})
      });
    }
  }
  const role = message?.role === "user" ? "user" : "assistant";
  const node = selectMessageNode(context, message);
  const seenResources = new Set(content.map((block) => block?.resource_id).filter(Boolean));
  for (const prepared of prepareMessageResources(
    context,
    builder,
    message,
    node,
    role,
    messageIndex
  )) {
    if (seenResources.has(prepared.resource.id)) continue;
    seenResources.add(prepared.resource.id);
    content.push(prepared.block);
  }
  content.push(...artifactBlocks(context, message));
  const activity = text(message?.public_activity_summary);
  if (activity && !content.some((block) =>
    block.type === "tool" && [block.title, block.text, block.markdown].some((value) => value?.includes(activity)))) {
    content.push({ type: "tool", kind: "activity", title: activity });
  }
  return content.filter(Boolean);
}

function activeMessages(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const order = Array.isArray(payload?.active_message_ids) ? payload.active_message_ids.map(String) : [];
  if (!order.length) return [...messages].sort((left, right) => Number(left?.index) - Number(right?.index));
  const byId = new Map(messages.map((message) => [String(message?.id ?? ""), message]));
  const selected = order.map((id) => byId.get(id)).filter(Boolean);
  return selected.length === order.length ? selected : messages;
}

export function parseClaudeWebFlat(context, descriptor) {
  const builder = new ConversationBuilder(context, descriptor);
  const messages = activeMessages(context.payload);
  let exchange = 0;
  for (const [index, message] of messages.entries()) {
    const role = message?.role === "user" ? "user" : "assistant";
    if (role === "user" || exchange === 0) exchange += 1;
    const turnId = `turn_${String(exchange).padStart(6, "0")}_${role}`;
    builder.addMessage({
      role,
      model: context.payload?.conversation?.model,
      timestamp: message?.created_at,
      turnId,
      content: claudeMessageContent(context, builder, message, index)
    });
  }
  if (context.messageNodes.length !== messages.length) {
    builder.warn(
      "dom_message_count_mismatch",
      `机器顺序为 ${messages.length} 项，静态 DOM 为 ${context.messageNodes.length} 个消息片段。`
    );
  }
  importExporterWarnings(context, builder);
  return builder.finalize();
}

export const claudeWebLightAdapter = Object.freeze({
  id: "claude-light-dom-v1",
  profile: "light",
  provider: "anthropic",
  platform: "claude",
  payloadSchema: "osis.claude.chat-export/light-dom-v1",
  parse(context) {
    return parseClaudeWebFlat(context, claudeWebLightAdapter);
  }
});

export const claudeWebFullAdapter = Object.freeze({
  id: "claude-full-capture-v1",
  profile: "full",
  provider: "anthropic",
  platform: "claude",
  payloadSchema: "osis.claude.chat-export/full-capture-v1",
  parse(context) {
    return parseClaudeWebFlat(context, claudeWebFullAdapter);
  }
});
