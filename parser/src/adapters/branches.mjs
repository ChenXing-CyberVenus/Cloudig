import { sha256 } from "../contract.mjs";
import {
  addGenericMessage,
  chatGptDomNode,
  CONVERSATION_SCHEMA_BRANCHES,
  ConversationBuilder,
  importExporterWarnings,
  messageIdentity
} from "./common.mjs";
import { parseChatGptWithDescriptor, projectChatGptItemContent } from "./chatgpt.mjs";
import { claudeMessageContent } from "./claude-web.mjs";
import { parseHtml } from "../html.mjs";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestamp(value) {
  const source = text(value);
  if (!source) return null;
  const date = new Date(source);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function privateId(platform, namespace, value) {
  return sha256(Buffer.from(`${platform}\u0000${namespace}\u0000${String(value)}`, "utf8"));
}

function turnId(platform, value) {
  return `turn_${privateId(platform, "turn", value).slice(0, 24)}`;
}

function applyConversationFacts(context, builder) {
  if (context.platform === "claude") {
    const createdAt = timestamp(context.payload?.conversation?.created_at);
    const updatedAt = timestamp(context.payload?.conversation?.updated_at);
    if (createdAt) builder.document.created_at = createdAt;
    if (updatedAt) builder.document.updated_at = updatedAt;
  }
}

function currentLastOrder(records, currentKey, platform) {
  if (!records.length) throw new Error(`${platform} branch payload contains no messages`);
  const byKey = new Map();
  for (const record of records) {
    if (!record.key) throw new Error(`${platform} branch message is missing a stable source key`);
    if (byKey.has(record.key)) throw new Error(`${platform} branch message key is duplicated`);
    byKey.set(record.key, record);
  }
  const current = byKey.get(currentKey);
  if (!current) throw new Error(`${platform} current leaf is missing from the branch message set`);

  const children = new Map(records.map((record) => [record.key, []]));
  const roots = [];
  for (const record of records) {
    if (record.parentKey && byKey.has(record.parentKey)) {
      children.get(record.parentKey).push(record);
    } else {
      roots.push(record);
    }
  }
  if (children.get(currentKey).length) {
    throw new Error(`${platform} current leaf points to a non-leaf branch node`);
  }

  for (const record of records) {
    const visited = new Set();
    let cursor = record;
    while (cursor?.parentKey && byKey.has(cursor.parentKey)) {
      if (visited.has(cursor.key)) throw new Error(`${platform} branch graph contains a cycle`);
      visited.add(cursor.key);
      cursor = byKey.get(cursor.parentKey);
    }
  }

  const currentPath = new Set();
  let cursor = current;
  while (cursor) {
    currentPath.add(cursor.key);
    cursor = cursor.parentKey ? byKey.get(cursor.parentKey) : null;
  }
  const siblingOrder = (items) => [
    ...items.filter((record) => !currentPath.has(record.key)),
    ...items.filter((record) => currentPath.has(record.key))
  ].sort((left, right) => {
    const leftCurrent = currentPath.has(left.key);
    const rightCurrent = currentPath.has(right.key);
    if (leftCurrent !== rightCurrent) return leftCurrent ? 1 : -1;
    return left.index - right.index;
  });

  const ordered = [];
  const stack = siblingOrder(roots).reverse();
  while (stack.length) {
    const record = stack.pop();
    ordered.push(record);
    const next = siblingOrder(children.get(record.key)).reverse();
    stack.push(...next);
  }
  if (ordered.length !== records.length) {
    throw new Error(`${platform} branch graph could not be ordered without loss`);
  }
  if (ordered.at(-1)?.key !== currentKey) {
    throw new Error(`${platform} current leaf was not stabilized as the final canonical message`);
  }
  return { ordered, byKey };
}

function genericSourceKey(platform, message) {
  if (platform === "mistral") {
    return text(message?.key)
      ?? (message?.id !== undefined && message?.version !== undefined
        ? `${message.id}::${message.version}`
        : null);
  }
  return text(messageIdentity(message));
}

function genericParentKey(platform, message) {
  if (platform === "mistral") {
    if (message?.parent_id === null || message?.parent_id === undefined) return null;
    return `${message.parent_id}::${message.parent_version}`;
  }
  if (platform === "grok") return text(message?.parent_response_id);
  return text(message?.parent_id);
}

function genericBranchMessages(context) {
  if (context.platform === "deepseek") return Array.isArray(context.payload?.items) ? context.payload.items : [];
  if (context.platform === "grok") return Array.isArray(context.payload?.nodes) ? context.payload.nodes : [];
  return Array.isArray(context.payload?.messages) ? context.payload.messages : [];
}

function genericCurrentLeaf(context) {
  if (context.platform === "deepseek") return text(context.payload?.active_leaf_id);
  if (context.platform === "grok") return text(context.payload?.current_path_response_ids?.at(-1));
  if (context.platform === "kimi") return text(context.payload?.active_path_message_ids?.at(-1));
  if (context.platform === "mistral") return text(context.payload?.current_leaf_message_key);
  return text(context.payload?.current_leaf_message_id);
}

function parseGenericBranches(context, descriptor) {
  const builder = new ConversationBuilder(context, descriptor);
  applyConversationFacts(context, builder);
  const source = genericBranchMessages(context);
  const records = source.map((message, index) => ({
    key: genericSourceKey(context.platform, message),
    parentKey: genericParentKey(context.platform, message),
    message,
    index
  }));
  const currentKey = genericCurrentLeaf(context);
  const { ordered, byKey } = currentLastOrder(records, currentKey, context.platform);

  for (const [canonicalIndex, record] of ordered.entries()) {
    const id = privateId(context.platform, "message", record.key);
    const parentId = record.parentKey
      ? privateId(context.platform, "message", record.parentKey)
      : null;
    if (context.platform === "claude") {
      const role = record.message?.role === "user" ? "user" : "assistant";
      builder.addMessage({
        id,
        parentId,
        turnId: turnId(context.platform, record.key),
        role,
        model: context.payload?.conversation?.model,
        timestamp: record.message?.created_at,
        content: claudeMessageContent(
          context,
          builder,
          record.message,
          canonicalIndex
        )
      });
    } else {
      addGenericMessage(context, builder, record.message, canonicalIndex, {
        id,
        parentId,
        turnId: turnId(context.platform, record.key)
      });
    }
    if (record.parentKey && !byKey.has(record.parentKey)) {
      builder.warn(
        "orphan_parent_missing",
        "来源树引用了未包含的祖先；已保留脱敏父关系。",
        canonicalIndex
      );
    }
  }
  importExporterWarnings(context, builder);
  return builder.finalize();
}

function chatGptTurnRecords(payload) {
  return Object.entries(payload?.turns ?? {}).map(([key, turn], index) => ({
    key: text(turn?.id) ?? key,
    sourceKey: key,
    parentKey: text(turn?.parent),
    turn,
    index
  }));
}

function chatGptTurnItems(payload, record) {
  const result = [];
  for (const nodeId of Array.isArray(record.turn?.node_ids) ? record.turn.node_ids : []) {
    const items = Array.isArray(payload?.items_by_node?.[nodeId])
      ? payload.items_by_node[nodeId]
      : [];
    items.forEach((item, itemIndex) => result.push({ item, nodeId, itemIndex }));
  }
  return result;
}

function fragmentMessageNodes(dom) {
  const candidates = dom.nodes.filter((node) =>
    node.attrs["data-message-id"] || node.attrs["data-source-id"]
  );
  return candidates.filter((node) => {
    const id = String(node.attrs["data-message-id"] ?? node.attrs["data-source-id"]);
    for (let parent = node.parent; parent && parent.tag !== "#document"; parent = parent.parent) {
      const parentId = parent.attrs?.["data-message-id"] ?? parent.attrs?.["data-source-id"];
      if (String(parentId ?? "") === id) return false;
    }
    return true;
  });
}

function contextWithRenderedTurn(context, record) {
  const fragment = context.payload?.rendered_turns?.[record.sourceKey]
    ?? context.payload?.rendered_turns?.[record.key];
  if (typeof fragment !== "string" || !fragment.trim()) return context;
  const dom = parseHtml(fragment);
  const messageNodes = fragmentMessageNodes(dom);
  const messageNodesById = new Map();
  for (const node of messageNodes) {
    const id = String(node.attrs["data-message-id"] ?? node.attrs["data-source-id"]);
    const nodes = messageNodesById.get(id) ?? [];
    nodes.push(node);
    messageNodesById.set(id, nodes);
  }
  return {
    ...context,
    html: fragment,
    maskedHtml: fragment,
    dom,
    messageNodes,
    messageNodesById
  };
}

function parseChatGptBranches(context, descriptor) {
  if (context.payload?.entry_surface === "scheduled_task") {
    return parseChatGptWithDescriptor(context, descriptor);
  }
  const builder = new ConversationBuilder(context, descriptor);
  applyConversationFacts(context, builder);
  const records = chatGptTurnRecords(context.payload);
  const currentKey = text(context.payload?.current_turn);
  const { ordered, byKey } = currentLastOrder(records, currentKey, context.platform);
  const turnTail = new Map();
  let canonicalIndex = 0;

  for (const record of ordered) {
    const items = chatGptTurnItems(context.payload, record);
    if (!items.length) throw new Error("ChatGPT visible turn contains no export items");
    const renderedContext = contextWithRenderedTurn(context, record);
    const occurrences = new Map();
    const groupedTurnId = turnId(context.platform, record.key);
    let previousId = record.parentKey
      ? turnTail.get(record.parentKey)
        ?? privateId(context.platform, "missing-turn-tail", record.parentKey)
      : null;
    for (const entry of items) {
      const itemIdentity = String(entry.item?.message_id ?? entry.item?.node_id ?? entry.nodeId);
      const occurrence = occurrences.get(itemIdentity) ?? 0;
      occurrences.set(itemIdentity, occurrence + 1);
      const node = chatGptDomNode(renderedContext, itemIdentity, occurrence);
      const projected = projectChatGptItemContent(
        renderedContext,
        builder,
        entry.item,
        canonicalIndex,
        node
      );
      const id = privateId(
        context.platform,
        "message",
        `${record.key}\u0000${entry.nodeId}\u0000${entry.itemIndex}`
      );
      if (!node) {
        builder.warn(
          "dom_fragment_missing",
          "ChatGPT 分支 item 没有对应静态 DOM 片段。",
          canonicalIndex
        );
      }
      builder.addMessage({
        id,
        parentId: previousId,
        turnId: groupedTurnId,
        role: projected.role,
        name: projected.name,
        model: entry.item?.model,
        timestamp: entry.item?.created_at,
        content: projected.content
      });
      previousId = id;
      canonicalIndex += 1;
    }
    turnTail.set(record.key, previousId);
    if (record.parentKey && !byKey.has(record.parentKey)) {
      builder.warn(
        "orphan_parent_missing",
        "来源树引用了未包含的祖先；已保留脱敏父关系。",
        canonicalIndex - 1
      );
    }
  }
  importExporterWarnings(context, builder);
  return builder.finalize();
}

function genericDescriptor(definition) {
  const adapter = {
    ...definition,
    profile: "all_branches",
    outputSchema: CONVERSATION_SCHEMA_BRANCHES,
    parse(context) {
      return parseGenericBranches(context, adapter);
    }
  };
  return Object.freeze(adapter);
}

export const chatgptBranchesAdapter = Object.freeze({
  id: "chatgpt-all-branches-v1",
  profile: "all_branches",
  provider: "openai",
  platform: "chatgpt",
  payloadSchema: "osis.chatgpt.chat-export/all-branches-v1",
  outputSchema: CONVERSATION_SCHEMA_BRANCHES,
  parse(context) {
    return parseChatGptBranches(context, chatgptBranchesAdapter);
  }
});

export const deepseekBranchesAdapter = genericDescriptor({
  id: "deepseek-all-branches-v1",
  provider: "deepseek",
  platform: "deepseek",
  payloadSchema: "osis.deepseek.chat-export/all-branches-v1"
});

export const grokBranchesAdapter = genericDescriptor({
  id: "grok-all-branches-v1",
  provider: "xai",
  platform: "grok",
  payloadSchema: "osis.grok.chat-export/all-branches-v1"
});

export const kimiBranchesAdapter = genericDescriptor({
  id: "kimi-all-branches-v1",
  provider: "moonshot",
  platform: "kimi",
  defaultModel: "Kimi",
  payloadSchema: "osis.kimi.chat-export/all-branches-v1"
});

export const qwenBranchesAdapter = genericDescriptor({
  id: "qwen-all-branches-v1",
  provider: "alibaba",
  platform: "qwen",
  payloadSchema: "osis.qwen.chat-export/all-branches-v1"
});

export const zaiBranchesAdapter = genericDescriptor({
  id: "zai-all-branches-v1",
  provider: "zhipu",
  platform: "zai",
  payloadSchema: "osis.zai.chat-export/all-branches-v1"
});

export const mistralBranchesAdapter = genericDescriptor({
  id: "mistral-all-branches-v1",
  provider: "mistral",
  platform: "mistral",
  payloadSchema: "osis.mistral.chat-export/all-branches-v1"
});

export const claudeBranchesAdapter = genericDescriptor({
  id: "claude-all-branches-v1",
  provider: "anthropic",
  platform: "claude",
  payloadSchema: "osis.claude.chat-export/all-branches-v1"
});

export const BRANCH_ADAPTERS = Object.freeze([
  chatgptBranchesAdapter,
  deepseekBranchesAdapter,
  grokBranchesAdapter,
  kimiBranchesAdapter,
  qwenBranchesAdapter,
  zaiBranchesAdapter,
  mistralBranchesAdapter,
  claudeBranchesAdapter
]);
