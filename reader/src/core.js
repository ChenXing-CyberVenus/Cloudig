(function initOsisReaderCore(root, factory) {
  "use strict";
  const timeCore = typeof module === "object" && module?.exports
    ? require("../../time/core.js")
    : root.CloudigTimeCore;
  const api = factory(timeCore);
  root.OsisReaderCore = api;
  if (typeof module === "object" && module?.exports) module.exports = api;
}(typeof globalThis === "object" ? globalThis : this, function createOsisReaderCore(timeCore) {
  "use strict";

  if (!timeCore || timeCore.VERSION !== "1.0.0") throw new Error("Reader requires CloudigTimeCore 1.0.0");
  const READER_VERSION = "0.7.0";
  const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
  function isSemanticVersion(value) {
    return typeof value === "string" && value === value.trim() && SEMANTIC_VERSION.test(value);
  }
  if (!isSemanticVersion(READER_VERSION)) throw new Error("Reader 版本必须是完整 SemVer。");
  const ADAPTER_VERSIONED_SCHEMA = "ai-chat-archive/conversation/0.1.4";
  const SCHEMA = "ai-chat-archive/conversation/0.1.5";
  const ADAPTER_VERSIONED_BRANCH_SCHEMA = "ai-chat-archive/conversation/0.2.4";
  const CURRENT_BRANCH_SCHEMA = "ai-chat-archive/conversation/0.2.5";
  const V1_SCHEMA = "ai-chat-archive/conversation/1.0.0";
  const SCHEMAS = new Set([
    "ai-chat-archive/conversation/0.1.0",
    "ai-chat-archive/conversation/0.1.1",
    "ai-chat-archive/conversation/0.1.2",
    "ai-chat-archive/conversation/0.1.3",
    ADAPTER_VERSIONED_SCHEMA,
    SCHEMA,
    "ai-chat-archive/conversation/0.2.0",
    "ai-chat-archive/conversation/0.2.1",
    "ai-chat-archive/conversation/0.2.2",
    "ai-chat-archive/conversation/0.2.3",
    ADAPTER_VERSIONED_BRANCH_SCHEMA,
    CURRENT_BRANCH_SCHEMA,
    V1_SCHEMA
  ]);
  const CURRENT_SCHEMAS = new Set([
    "ai-chat-archive/conversation/0.1.1",
    "ai-chat-archive/conversation/0.1.2",
    "ai-chat-archive/conversation/0.1.3",
    ADAPTER_VERSIONED_SCHEMA,
    SCHEMA,
    "ai-chat-archive/conversation/0.2.1",
    "ai-chat-archive/conversation/0.2.2",
    "ai-chat-archive/conversation/0.2.3",
    ADAPTER_VERSIONED_BRANCH_SCHEMA,
    CURRENT_BRANCH_SCHEMA
  ]);
  const KEYED_SCHEMAS = new Set([
    "ai-chat-archive/conversation/0.1.2",
    "ai-chat-archive/conversation/0.1.3",
    ADAPTER_VERSIONED_SCHEMA,
    SCHEMA,
    "ai-chat-archive/conversation/0.2.2",
    "ai-chat-archive/conversation/0.2.3",
    ADAPTER_VERSIONED_BRANCH_SCHEMA,
    CURRENT_BRANCH_SCHEMA
  ]);
  const VERSIONED_SCHEMAS = new Set([
    "ai-chat-archive/conversation/0.1.3",
    ADAPTER_VERSIONED_SCHEMA,
    SCHEMA,
    "ai-chat-archive/conversation/0.2.3",
    ADAPTER_VERSIONED_BRANCH_SCHEMA,
    CURRENT_BRANCH_SCHEMA
  ]);
  const ADAPTER_VERSIONED_SCHEMAS = new Set([
    ADAPTER_VERSIONED_SCHEMA,
    SCHEMA,
    ADAPTER_VERSIONED_BRANCH_SCHEMA,
    CURRENT_BRANCH_SCHEMA
  ]);
  const PARSED_AT_SCHEMAS = new Set([SCHEMA, CURRENT_BRANCH_SCHEMA]);
  const BRANCH_GRAPH_SCHEMAS = new Set([ADAPTER_VERSIONED_BRANCH_SCHEMA, CURRENT_BRANCH_SCHEMA, V1_SCHEMA]);
  const ROLES = new Set(["user", "assistant", "system", "developer", "tool", "other"]);
  const MESSAGE_ID = /^[a-z0-9][a-z0-9._:-]*$/u;
  const CONTENT_TYPES = new Set([
    "markdown", "text", "reasoning", "reasoning_summary", "status", "code", "math",
    "image", "attachment", "search", "citations", "tool", "diagram", "html", "unknown"
  ]);
  const ROLE_LABELS = Object.freeze({
    user: "用户", assistant: "AI", system: "系统", developer: "开发者", tool: "工具", other: "其他"
  });
  const BLOCK_LABELS = Object.freeze({
    markdown: "正文", text: "文本", reasoning: "思考", reasoning_summary: "思考摘要",
    status: "状态", code: "代码", math: "公式", image: "图片", attachment: "附件",
    search: "搜索", citations: "引用", tool: "工具", diagram: "图表", html: "富文本", unknown: "未知组件"
  });

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
  }

  function conversationCompatibility(document) {
    const rawSchema = typeof document?.schema === "string" ? document.schema : "";
    const schema = cleanString(rawSchema);
    const generation = rawSchema === V1_SCHEMA && isRecord(document?.generation) ? document.generation : document;
    const parserVersion = cleanString(generation?.parser_version);
    const parserAdapter = isRecord(generation?.parser_adapter)
      ? Object.freeze({ id: cleanString(generation.parser_adapter.id), version: cleanString(generation.parser_adapter.version) })
      : null;
    return Object.freeze({
      supported: SCHEMAS.has(rawSchema),
      schema,
      parser_version: parserVersion,
      parser_adapter: parserAdapter,
      reader_version: READER_VERSION
    });
  }

  function validDateTime(value) {
    return typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      && Number.isFinite(Date.parse(value));
  }

  function validateV1Envelope(document, errors) {
    const allowed = new Set(["schema", "identity", "generation", "lifecycle", "source", "message_time", "content_time", "title", "provider", "platform", "models", "messages", "resources", "sources", "warnings"]);
    for (const key of Object.keys(document)) if (!allowed.has(key)) errors.push(`V1 根节点不接受字段：${key}`);
    if (!isRecord(document.identity)
      || !/^[0-9a-f]{64}$/u.test(cleanString(document.identity.conversation_key))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(cleanString(document.identity.archive_id))) {
      errors.push("V1 identity 必须包含 conversation_key 与 archive_id。");
    }
    if (!isRecord(document.generation)
      || !isSemanticVersion(document.generation.parser_version)
      || !isRecord(document.generation.parser_adapter)
      || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(cleanString(document.generation.parser_adapter.id))
      || !isSemanticVersion(document.generation.parser_adapter.version)) {
      errors.push("V1 generation 必须包含 Parser 与适配器 SemVer 水位。");
    }
    if (document.generation?.exporter_version !== undefined && !cleanString(document.generation.exporter_version)) errors.push("V1 exporter_version 不能为空。");
    if (!isRecord(document.lifecycle)
      || !isRecord(document.lifecycle.first_parsed_at)
      || !validDateTime(document.lifecycle.last_parsed_at)
      || !validDateTime(document.lifecycle.cloudig_edited_at)) {
      errors.push("V1 lifecycle 缺失或时间无效。");
    }
    const firstBasis = cleanString(document.lifecycle?.first_parsed_at?.basis);
    if (!["parser_creation", "legacy_output_birthtime_estimate", "legacy_last_parse_upper_bound", "unavailable"].includes(firstBasis)) errors.push("V1 first_parsed_at.basis 无效。");
    if (firstBasis === "unavailable" && document.lifecycle?.first_parsed_at?.value !== undefined) errors.push("V1 不可在 unavailable 首次解析依据中伪造时间。");
    if (firstBasis && firstBasis !== "unavailable" && !validDateTime(document.lifecycle?.first_parsed_at?.value)) errors.push("V1 首次解析依据缺少有效时间。");
    if (!isRecord(document.source)
      || !isRecord(document.source.file)
      || !cleanString(document.source.file.name)
      || !/^[0-9a-f]{64}$/u.test(cleanString(document.source.file.sha256))
      || !Number.isSafeInteger(document.source.file.size_bytes)
      || document.source.file.size_bytes < 1
      || !isRecord(document.source.captured_at)) {
      errors.push("V1 source 必须包含原文件事实与采集依据。");
    }
    const captureBasis = cleanString(document.source?.captured_at?.basis);
    if (!["bookmark_metadata", "source_metadata", "filesystem_earliest_create_or_modify", "filesystem_modified_time", "unavailable"].includes(captureBasis)) errors.push("V1 source.captured_at.basis 无效。");
    if (captureBasis === "unavailable" && document.source?.captured_at?.value !== undefined) errors.push("V1 不可在 unavailable 采集依据中伪造时间。");
    if (captureBasis && captureBasis !== "unavailable" && !validDateTime(document.source?.captured_at?.value)) errors.push("V1 采集依据缺少有效时间。");
    const messages = Array.isArray(document.messages) ? document.messages : [];
    if (messages.length === 0) errors.push("V1 messages 必须是非空数组。");
    const validMessageTimes = messages.map((message) => message?.timestamp)
      .filter(validDateTime)
      .map((value) => new Date(value).toISOString())
      .sort();
    if (!isRecord(document.message_time)
      || document.message_time.total_messages !== messages.length
      || document.message_time.timestamped_messages !== validMessageTimes.length
      || (validMessageTimes.length > 0 && (document.message_time.start !== validMessageTimes[0] || document.message_time.end !== validMessageTimes.at(-1)))
      || (validMessageTimes.length === 0 && (document.message_time.start !== undefined || document.message_time.end !== undefined))) {
      errors.push("V1 message_time 必须精确投影消息时间计数与起止。");
    }
    const parserDefault = document.content_time?.parser_default;
    const effective = document.content_time?.effective;
    if (!isRecord(document.content_time) || !isRecord(parserDefault) || !isRecord(effective)) errors.push("V1 content_time 必须包含 parser_default 与 effective。");
    if (isRecord(parserDefault)) {
      if (!validDateTime(parserDefault.edited_at) || !["message_start", "source_capture_fallback", "unavailable"].includes(parserDefault.derivation)) errors.push("V1 parser_default 派生依据或编辑时间无效。");
      if (parserDefault.derivation === "unavailable" && parserDefault.range !== undefined) errors.push("V1 unavailable parser_default 不得包含 range。");
      if (parserDefault.derivation !== "unavailable") {
        const result = timeCore.validateRange(parserDefault.range, { require_flags: true });
        if (!result.valid || !result.value.is_collapsed || result.value.start.kind === "sovereign") errors.push("V1 parser_default 必须是有效的单点 Terran range。");
      }
    }
    if (isRecord(effective)) {
      if (effective.source === "parser") {
        if (Object.keys(effective).some((key) => key !== "source")) errors.push("V1 Parser effective 必须保持稀疏。");
      } else if (effective.source === "user") {
        if (!["set", "cleared"].includes(effective.state) || !validDateTime(effective.edited_at) || !/^[0-9a-f-]{36}$/u.test(cleanString(effective.edit_id))) errors.push("V1 user effective 缺少有效编辑态。");
        if (effective.state === "set" && !timeCore.validateRange(effective.range, { require_flags: true }).valid) errors.push("V1 user set range 无效。");
        if (effective.state === "cleared" && effective.range !== undefined) errors.push("V1 user cleared 不得包含 range。");
      } else errors.push("V1 effective.source 必须是 parser 或 user。");
    }
  }

  function validateConversation(document) {
    const errors = [];
    if (!isRecord(document)) return ["根节点必须是 JSON 对象。"];
    if (!SCHEMAS.has(document.schema)) errors.push(`不支持的 schema：${cleanString(document.schema) || "（缺失）"}`);
    if (document.schema === V1_SCHEMA) {
      validateV1Envelope(document, errors);
    } else {
      if (document.conversation_key !== undefined && !/^[0-9a-f]{64}$/u.test(cleanString(document.conversation_key))) errors.push("conversation_key 必须是 64 位小写十六进制脱敏身份。");
      if (document.conversation_id !== undefined && !/^[0-9a-f]{64}$/u.test(cleanString(document.conversation_id))) errors.push("conversation_id 必须是 64 位小写十六进制脱敏身份。");
      if (KEYED_SCHEMAS.has(document.schema) && !/^[0-9a-f]{64}$/u.test(cleanString(document.conversation_key))) errors.push("当前 schema 必须提供 conversation_key。");
      if (document.conversation_key !== undefined && document.conversation_id !== undefined) errors.push("conversation_key 与旧 conversation_id 不能同时存在。");
      if (document.parser_version !== undefined && !isSemanticVersion(document.parser_version)) errors.push("parser_version 必须是完整 SemVer。");
      if (VERSIONED_SCHEMAS.has(document.schema) && !isSemanticVersion(document.parser_version)) errors.push("当前 schema 必须提供完整 SemVer parser_version。");
      if (document.parser_adapter !== undefined) {
        if (!isRecord(document.parser_adapter)
          || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(cleanString(document.parser_adapter.id))
          || !isSemanticVersion(document.parser_adapter.version)) {
          errors.push("parser_adapter 必须包含有效适配器 ID 与完整 SemVer 版本。");
        }
      }
      if (ADAPTER_VERSIONED_SCHEMAS.has(document.schema) && document.parser_adapter === undefined) errors.push("当前 schema 必须提供 parser_adapter。");
      if (PARSED_AT_SCHEMAS.has(document.schema)
        && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(cleanString(document.parsed_at))
          || !Number.isFinite(Date.parse(document.parsed_at)))) {
        errors.push("当前 schema 必须提供带时区的 parsed_at。");
      }
      if (!PARSED_AT_SCHEMAS.has(document.schema) && document.parsed_at !== undefined) errors.push("旧 schema 不接受 parsed_at。");
      if (document.exporter_version !== undefined
        && (typeof document.exporter_version !== "string" || !document.exporter_version.trim())) errors.push("exporter_version 不能为空。");
      if (!cleanString(document.source_file)) errors.push("source_file 缺失或为空。");
      if (!/^[0-9a-f]{64}$/u.test(cleanString(document.source_sha256))) errors.push("source_sha256 必须是 64 位小写十六进制。");
      if (!Number.isSafeInteger(document.source_size_bytes) || document.source_size_bytes < 0) errors.push("source_size_bytes 必须是非负安全整数。");
      if (CURRENT_SCHEMAS.has(document.schema) && !Number.isFinite(Date.parse(cleanString(document.content_time)))) errors.push("content_time 缺失或不是带时区的日期时间。");
    }
    if (!cleanString(document.title)) errors.push("title 缺失或为空。");
    if (!cleanString(document.provider)) errors.push("provider 缺失或为空。");
    if (!cleanString(document.platform)) errors.push("platform 缺失或为空。");
    if (!Array.isArray(document.messages)) errors.push("messages 必须是数组。");

    const resourceIds = new Set();
    for (const [index, resource] of (Array.isArray(document.resources) ? document.resources : []).entries()) {
      if (!isRecord(resource)) {
        errors.push(`resources[${index}] 必须是对象。`);
        continue;
      }
      const id = cleanString(resource.id);
      if (!id) errors.push(`resources[${index}].id 缺失。`);
      else if (resourceIds.has(id)) errors.push(`资源 id 重复：${id}`);
      else resourceIds.add(id);
      if (!new Set(["image", "attachment"]).has(resource.kind)) errors.push(`resources[${index}].kind 无效。`);
      if (!new Set(["embedded", "metadata_only", "missing"]).has(resource.availability)) errors.push(`resources[${index}].availability 无效。`);
      if (resource.availability === "embedded" && !cleanString(resource.data_url)) errors.push(`内嵌资源 ${id || index} 缺少 data_url。`);
    }

    const sourceIds = new Set();
    for (const [index, source] of (Array.isArray(document.sources) ? document.sources : []).entries()) {
      if (!isRecord(source)) {
        errors.push(`sources[${index}] 必须是对象。`);
        continue;
      }
      const id = cleanString(source.id);
      if (!id) errors.push(`sources[${index}].id 缺失。`);
      else if (sourceIds.has(id)) errors.push(`来源 id 重复：${id}`);
      else sourceIds.add(id);
      if (!cleanString(source.url)) errors.push(`sources[${index}].url 缺失。`);
    }

    const messages = Array.isArray(document.messages) ? document.messages : [];
    const currentBranchIds = new Map();
    for (const [messageIndex, message] of messages.entries()) {
      if (!isRecord(message)) {
        errors.push(`messages[${messageIndex}] 必须是对象。`);
        continue;
      }
      if (BRANCH_GRAPH_SCHEMAS.has(document.schema)) {
        const id = cleanString(message.id);
        if (!MESSAGE_ID.test(id)) errors.push(`messages[${messageIndex}].id 缺失或无效。`);
        else if (currentBranchIds.has(id)) errors.push(`消息 id 重复：${id}`);
        else currentBranchIds.set(id, messageIndex);
      }
      if (!ROLES.has(message.role)) errors.push(`messages[${messageIndex}].role 无效。`);
      if (message.parent_id !== undefined && !MESSAGE_ID.test(cleanString(message.parent_id))) errors.push(`messages[${messageIndex}].parent_id 无效。`);
      if ((CURRENT_SCHEMAS.has(document.schema) || document.schema === V1_SCHEMA) && !MESSAGE_ID.test(cleanString(message.turn_id))) errors.push(`messages[${messageIndex}].turn_id 缺失或无效。`);
      if (!Array.isArray(message.content)) {
        errors.push(`messages[${messageIndex}].content 必须是数组。`);
        continue;
      }
      for (const [blockIndex, block] of message.content.entries()) {
        if (!isRecord(block) || !CONTENT_TYPES.has(block.type)) {
          errors.push(`messages[${messageIndex}].content[${blockIndex}] 类型无效。`);
          continue;
        }
        if (["image", "attachment"].includes(block.type) && !resourceIds.has(block.resource_id)) {
          errors.push(`消息引用了不存在的资源：${cleanString(block.resource_id) || "（缺失）"}`);
        }
        if (["search", "citations"].includes(block.type)) {
          for (const sourceId of (Array.isArray(block.source_ids) ? block.source_ids : [])) {
            if (!sourceIds.has(sourceId)) errors.push(`消息引用了不存在的来源：${sourceId}`);
          }
        }
      }
    }
    if (BRANCH_GRAPH_SCHEMAS.has(document.schema) && messages.length > 0) {
      const parentsWithChildren = new Set();
      for (const [childIndex, message] of messages.entries()) {
        if (!isRecord(message) || typeof message.parent_id !== "string") continue;
        const parentIndex = currentBranchIds.get(message.parent_id);
        if (parentIndex === undefined) continue;
        parentsWithChildren.add(message.parent_id);
        if (parentIndex >= childIndex) errors.push(`messages[${childIndex}].parent_id 指向的已收录父消息必须排在子消息之前。`);
      }

      const resolvedIds = new Set();
      for (const [startIndex, startMessage] of messages.entries()) {
        const startId = cleanString(startMessage?.id);
        if (!currentBranchIds.has(startId)) continue;
        if (resolvedIds.has(startId)) continue;
        const path = [];
        const positionById = new Map();
        let currentId = startId;
        while (currentBranchIds.has(currentId) && !resolvedIds.has(currentId)) {
          if (positionById.has(currentId)) {
            errors.push(`messages[${startIndex}] 所在的会话分支存在环：${currentId}`);
            break;
          }
          positionById.set(currentId, path.length);
          path.push(currentId);
          const currentMessage = messages[currentBranchIds.get(currentId)];
          currentId = typeof currentMessage?.parent_id === "string" ? currentMessage.parent_id : "";
        }
        for (const id of path) resolvedIds.add(id);
      }

      const finalMessage = messages.at(-1);
      const finalId = cleanString(finalMessage?.id);
      if (finalId && parentsWithChildren.has(finalId)) errors.push(`messages[${messages.length - 1}].id 必须是叶节点。`);
    }
    return errors.slice(0, 100);
  }

  function assertConversation(document) {
    const errors = validateConversation(document);
    if (errors.length) {
      const error = new Error(errors.join("\n"));
      error.name = "ConversationValidationError";
      error.validationErrors = errors;
      throw error;
    }
    return document;
  }

  function collectBlockText(block) {
    if (!isRecord(block)) return "";
    const fields = [
      block.type, block.title, block.label, block.text, block.markdown, block.html, block.code,
      block.language, block.filename, block.tex, block.query, block.name, block.status, block.format,
      block.source, block.alt, block.caption, block.kind
    ];
    return fields.filter((value) => typeof value === "string").join("\n");
  }

  function collectMessageText(message) {
    return [message?.role, message?.name, message?.model, ...(message?.content || []).map(collectBlockText)]
      .filter((value) => typeof value === "string")
      .join("\n");
  }

  function legacyGroupRole(message) {
    return message?.role === "user" ? "user"
      : ["assistant", "tool"].includes(message?.role) ? "assistant"
        : message?.role || "other";
  }

  function groupMessages(messages) {
    const groups = [];
    for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
      const explicitId = cleanString(message?.turn_id);
      const role = legacyGroupRole(message);
      let group = groups.at(-1);
      const canJoinExplicit = explicitId && group?.id === explicitId;
      const canJoinUnlinkedLegacy = !message?.id && !message?.parent_id
        && group?.messages?.every((item) => !item?.id && !item?.parent_id);
      const canJoinLegacy = !explicitId && group?.legacy === true
        && canJoinUnlinkedLegacy
        && role === "assistant" && group.role === "assistant";
      if (!canJoinExplicit && !canJoinLegacy) {
        group = {
          id: explicitId || `legacy_turn_${String(groups.length + 1).padStart(6, "0")}`,
          role,
          legacy: !explicitId,
          first_index: index,
          indexes: [],
          messages: []
        };
        groups.push(group);
      }
      group.messages.push(message);
      group.indexes.push(index);
      if (role === "assistant") group.role = "assistant";
    }
    return groups.map((group) => ({
      id: group.id,
      role: group.role,
      first_index: group.first_index,
      indexes: group.indexes,
      messages: group.messages
    }));
  }

  function reasoningStatusTitleRepeatsDuration(value) {
    const title = cleanString(value);
    return /^思考了\s*(?:(?:\d+(?:\.\d+)?)\s*(?:ms|s|m|h)\s*)+$/iu.test(title)
      || /^思考(?:了|用时)\s*[零〇一二两三四五六七八九十百千半几\d.]+\s*(?:毫秒|秒|分钟|分|小时)$/u.test(title)
      || /^(?:worked|thought|thinking)\s+for\s*(?:(?:\d+(?:\.\d+)?)\s*(?:ms|s|m|h)\s*)+$/iu.test(title);
  }

  function presentationBlock(block) {
    if (!isRecord(block) || block.type !== "status" || !(Number(block.duration_seconds) > 0)) return block;
    if (!reasoningStatusTitleRepeatsDuration(block.title)) return block;
    return { ...block, title: "思考" };
  }

  function adjacentLegacyBioResult(messages, index) {
    const next = messages[index + 1];
    if (next?.role !== "tool") return null;
    return (Array.isArray(next.content) ? next.content : []).find((block) =>
      block?.type === "tool"
      && cleanString(block?.name).toLowerCase() === "bio"
      && (!cleanString(block?.kind) || cleanString(block.kind).toLowerCase() === "result")) || null;
  }

  function presentationMessages(group, platform = "") {
    const messages = Array.isArray(group?.messages) ? group.messages : [];
    return messages.map((message, messageIndex) => {
      const content = Array.isArray(message?.content) ? message.content : [];
      const bioResult = String(platform).toLowerCase() === "chatgpt"
        && message?.role === "assistant"
        && content.length === 1
        && content[0]?.type === "code"
        && cleanString(content[0]?.language).toLowerCase() === "unknown"
        ? adjacentLegacyBioResult(messages, messageIndex)
        : null;
      const projected = content.map((block) => {
        if (bioResult && block === content[0]) {
          return {
            type: "tool",
            kind: "call",
            name: "bio",
            markdown: markdownFence(block.code || "", "")
          };
        }
        return presentationBlock(block);
      });
      return projected.some((block, index) => block !== content[index])
        ? { ...message, content: projected }
        : message;
    });
  }

  function collectGroupText(group) {
    return (group?.messages || []).map(collectMessageText).join("\n");
  }

  function conversationText(document) {
    const resources = (document.resources || []).flatMap((item) => [item.name, item.mime_type, item.url]);
    const sources = (document.sources || []).flatMap((item) => [item.title, item.site_name, item.snippet, item.url]);
    return [
      document.title, document.provider, document.platform, ...(document.models || []),
      ...resources, ...sources, ...(document.messages || []).map(collectMessageText)
    ].filter((value) => typeof value === "string").join("\n");
  }

  function conversationIdentity(document) {
    return cleanString(document?.schema === V1_SCHEMA
      ? document?.identity?.conversation_key || document?.conversation_key
      : document?.conversation_key || document?.conversation_id || document?.source_sha256);
  }

  function v1EffectiveContentTime(document) {
    if (document?.schema !== V1_SCHEMA || !isRecord(document?.content_time)) return undefined;
    const effective = document.content_time.effective;
    if (effective?.source === "user") return effective.state === "set" ? effective.range : null;
    return document.content_time.parser_default?.range || null;
  }

  function presentationDocument(document) {
    if (document?.schema !== V1_SCHEMA) return document;
    const effective = document.content_time?.effective;
    return {
      schema: V1_SCHEMA,
      parser_version: cleanString(document.generation?.parser_version),
      parser_adapter: isRecord(document.generation?.parser_adapter) ? { ...document.generation.parser_adapter } : undefined,
      exporter_version: cleanString(document.generation?.exporter_version) || undefined,
      parsed_at: cleanString(document.lifecycle?.last_parsed_at) || undefined,
      first_parsed_at: isRecord(document.lifecycle?.first_parsed_at) ? { ...document.lifecycle.first_parsed_at } : undefined,
      cloudig_edited_at: cleanString(document.lifecycle?.cloudig_edited_at) || undefined,
      conversation_key: cleanString(document.identity?.conversation_key),
      archive_id: cleanString(document.identity?.archive_id),
      source_file: cleanString(document.source?.file?.name),
      source_sha256: cleanString(document.source?.file?.sha256),
      source_size_bytes: Number(document.source?.file?.size_bytes) || 0,
      source_url: cleanString(document.source?.url) || undefined,
      source_captured_at: isRecord(document.source?.captured_at) ? { ...document.source.captured_at } : undefined,
      source_created_at: cleanString(document.source?.captured_at?.value) || undefined,
      created_at: cleanString(document.source?.conversation_created_at) || undefined,
      updated_at: cleanString(document.source?.conversation_updated_at) || undefined,
      message_time: isRecord(document.message_time) ? { ...document.message_time } : undefined,
      parser_content_time: document.content_time?.parser_default?.range || undefined,
      content_time: v1EffectiveContentTime(document) || "",
      content_time_source: cleanString(effective?.source) || "parser",
      content_time_state: cleanString(effective?.state) || undefined,
      content_time_edit_id: cleanString(effective?.edit_id) || undefined,
      content_time_edited_at: cleanString(effective?.edited_at || document.content_time?.parser_default?.edited_at) || undefined,
      title: document.title,
      provider: document.provider,
      platform: document.platform,
      models: Array.isArray(document.models) ? [...document.models] : undefined,
      messages: document.messages,
      resources: document.resources,
      sources: document.sources,
      warnings: document.warnings
    };
  }

  function makeProjectedEntry(document, fileName = "conversation.json", sourceDocument = document) {
    return {
      id: conversationIdentity(document),
      fileName,
      document,
      sourceDocument,
      searchText: normalizeText(conversationText(document))
    };
  }

  function makeEntry(document, fileName = "conversation.json") {
    assertConversation(document);
    const projected = presentationDocument(document);
    return makeProjectedEntry(projected, fileName, document);
  }

  function matchesEntry(entry, query) {
    const needle = normalizeText(query);
    return !needle || entry.searchText.includes(needle);
  }

  function messageMatches(message, query) {
    const needle = normalizeText(query);
    return !needle || normalizeText(collectMessageText(message)).includes(needle);
  }

  function sortedEntries(entries, mode = "oldest") {
    const copy = [...entries];
    const descriptor = (entry) => contentTimeSortDescriptor(effectiveContentTime(entry.document)) || { domain: "unset_or_invalid", stable_tie: [entry.id || entry.fileName || ""] };
    if (mode === "oldest") copy.sort((a, b) => timeCore.compareSortDescriptors(descriptor(a), descriptor(b), "ascending") || a.document.title.localeCompare(b.document.title, "zh-CN") || String(a.id).localeCompare(String(b.id), "en"));
    else if (mode === "title") copy.sort((a, b) => a.document.title.localeCompare(b.document.title, "zh-CN"));
    else copy.sort((a, b) => timeCore.compareSortDescriptors(descriptor(a), descriptor(b), "descending") || a.document.title.localeCompare(b.document.title, "zh-CN") || String(a.id).localeCompare(String(b.id), "en"));
    return copy;
  }

  function effectiveContentTime(document) {
    if (document?.schema === V1_SCHEMA && isRecord(document?.identity)) return v1EffectiveContentTime(document);
    if (isRecord(document?.content_time) && isRecord(document.content_time.start)) return document.content_time;
    return cleanString(document?.content_time || document?.created_at || document?.exported_at);
  }

  function legacyEndpointToV1(endpoint) {
    if (!isRecord(endpoint)) return null;
    if (typeof endpoint.kind === "string") return endpoint;
    const era = endpoint.era === "BC" ? "BC" : "AD";
    if (endpoint.type === "unknown") return { kind: "unknown" };
    if (endpoint.type === "decade" && Number.isInteger(endpoint.year) && endpoint.year > 0 && endpoint.year % 10 === 0) return { kind: "terran_decade", era, index: endpoint.year / 10 };
    if (endpoint.type === "year" && Number.isInteger(endpoint.year)) return { kind: "terran_year_month", era, year: endpoint.year };
    if (endpoint.type === "month" && Number.isInteger(endpoint.year) && Number.isInteger(endpoint.month)) return { kind: "terran_year_month", era, year: endpoint.year, month: endpoint.month };
    if (endpoint.type === "exact") {
      const result = { kind: "terran_exact", era, year: endpoint.year, month: endpoint.month, day: endpoint.day };
      if (Number.isInteger(endpoint.hour) && Number.isInteger(endpoint.minute)) {
        result.hour = endpoint.hour;
        result.minute = endpoint.minute;
      }
      if (cleanString(endpoint.timezone)) result.utc_offset = endpoint.timezone;
      return result;
    }
    return null;
  }

  function contentTimeRange(value) {
    try {
      if (typeof value === "string") {
        if (!Number.isFinite(Date.parse(value))) return null;
        const date = new Date(value);
        return timeCore.normalizeRange({ start: {
          kind: "terran_exact", era: "AD", year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
          hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), utc_offset: "Z"
        } });
      }
      if (!isRecord(value) || !isRecord(value.start)) return null;
      if (typeof value.start.kind === "string") return timeCore.normalizeRange(value);
      const start = legacyEndpointToV1(value.start);
      const end = legacyEndpointToV1(value.end);
      return start ? timeCore.normalizeRange({ start, ...(end ? { end } : {}) }) : null;
    } catch {
      return null;
    }
  }

  function snapshotSelectorBounds(endpoint) {
    const selector = endpoint?.snapshot?.payload?.occurrences;
    if (!isRecord(selector)) return { first: 1, last: 1 };
    if (selector.mode === "progression") return { first: Number(selector.first) || 1, last: Number(selector.last) || Number(selector.first) || 1 };
    if (selector.mode === "all") {
      const count = Number(endpoint?.snapshot?.payload?.node?.period_count) || 1;
      return { first: 1, last: count };
    }
    return { first: 1, last: 1 };
  }

  function snapshotTimeContext() {
    return {
      directTerranMappings(endpoint) {
        return Array.isArray(endpoint?.snapshot?.payload?.direct_terran_mappings)
          ? endpoint.snapshot.payload.direct_terran_mappings
          : [];
      },
      sovereignOrder(endpoint) {
        const payload = endpoint?.snapshot?.payload;
        const bounds = snapshotSelectorBounds(endpoint);
        return {
          timeline_order: Number.MAX_SAFE_INTEGER,
          ordinal_path: Array.isArray(payload?.ordinal_path) ? payload.ordinal_path : [],
          occurrence_first: bounds.first,
          occurrence_last: bounds.last,
          edited_at: cleanString(endpoint?.snapshot?.captured_at),
          node_id: cleanString(payload?.node?.node_id) || endpoint?.binding_id
        };
      },
      sovereignPosition(endpoint) {
        const payload = endpoint?.snapshot?.payload;
        const path = Array.isArray(payload?.ordinal_path) ? payload.ordinal_path : null;
        if (!path) return null;
        return {
          variant_key: `${cleanString(payload?.timeline?.lineage_id)}#${Number(payload?.timeline?.variant_no) || 1}`,
          path,
          lower_path: path,
          upper_path: path
        };
      }
    };
  }

  function contentTimeSortDescriptor(value) {
    const range = contentTimeRange(value);
    return range ? timeCore.sortDescriptorForRange(range, snapshotTimeContext()) : null;
  }

  function compareContentTimeDescriptors(left, right, direction = "ascending") {
    const leftDescriptor = left || { domain: "unset_or_invalid", stable_tie: [] };
    const rightDescriptor = right || { domain: "unset_or_invalid", stable_tie: [] };
    return timeCore.compareSortDescriptors(leftDescriptor, rightDescriptor, direction);
  }

  function contentTimeSortKey(value) {
    if (typeof value === "string") {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    if (!isRecord(value) || !isRecord(value.start) || value.start.type === "unknown") return null;
    const endpoint = value.start;
    const year = Number(endpoint.year);
    if (!Number.isInteger(year)) return null;
    const signedYear = endpoint.era === "BC" ? -year : year;
    const month = ["month", "exact"].includes(endpoint.type) ? Number(endpoint.month) || 1 : 1;
    const day = endpoint.type === "exact" ? Number(endpoint.day) || 1 : 1;
    const hour = endpoint.type === "exact" ? Number(endpoint.hour) || 0 : 0;
    const minute = endpoint.type === "exact" ? Number(endpoint.minute) || 0 : 0;
    let key = ((((signedYear * 13) + month) * 32 + day) * 24 + hour) * 60 + minute;
    const timezone = cleanString(endpoint.timezone);
    if (timezone && timezone !== "Z") {
      const match = timezone.match(/^([+-])(\d{2}):(\d{2})$/u);
      if (match) key -= (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]));
    }
    return key;
  }

  function resourceMap(document) {
    return new Map((document.resources || []).map((resource) => [resource.id, resource]));
  }

  function sourceMap(document) {
    return new Map((document.sources || []).map((source) => [source.id, source]));
  }

  function safeExternalUrl(value) {
    try {
      const parsed = new URL(String(value));
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function safeEmbeddedImage(resource) {
    if (!resource || resource.availability !== "embedded") return "";
    const dataUrl = cleanString(resource.data_url);
    return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/iu.test(dataUrl) ? dataUrl.replace(/\s+/gu, "") : "";
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "";
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value;
    let unit = -1;
    do {
      size /= 1024;
      unit += 1;
    } while (size >= 1024 && unit < units.length - 1);
    return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
  }

  function formatDuration(value) {
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value < 0.001) return "<1 ms";
    if (value < 1) return `${Math.round(value * 1000)} ms`;
    if (value < 60) return `${Number(value.toFixed(2))} 秒`;
    return `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒`;
  }

  function documentStats(document) {
    const blocks = Object.create(null);
    for (const message of document.messages || []) {
      for (const block of message.content || []) blocks[block.type] = (blocks[block.type] || 0) + 1;
    }
    return {
      messages: groupMessages(document.messages).length,
      raw_messages: document.messages?.length || 0,
      resources: document.resources?.length || 0,
      sources: document.sources?.length || 0,
      warnings: document.warnings?.length || 0,
      blocks
    };
  }

  function markdownFence(value, language = "") {
    const source = String(value ?? "");
    const longest = Math.max(0, ...[...source.matchAll(/`+/gu)].map((match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}${cleanString(language)}\n${source.replace(/\s+$/u, "")}\n${fence}`;
  }

  function markdownLabel(value) {
    return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]").replace(/\s+/gu, " ").trim();
  }

  function markdownQuote(value) {
    return String(value ?? "").replace(/\s+$/u, "").split("\n").map((line) => `> ${line}`).join("\n");
  }

  function markdownLink(label, url) {
    const safe = safeExternalUrl(url);
    return safe ? `[${markdownLabel(label) || safe}](${safe.replaceAll(")", "%29")})` : markdownLabel(label || url);
  }

  function markdownSources(sourceIds, sources) {
    const lines = [];
    for (const [index, id] of (Array.isArray(sourceIds) ? sourceIds : []).entries()) {
      const source = sources.get(id);
      const label = source?.title || source?.site_name || id;
      const site = source?.site_name && source.site_name !== label ? ` · ${source.site_name}` : "";
      lines.push(`${index + 1}. ${markdownLink(label, source?.url)}${site}`);
      if (source?.snippet) lines.push(`   ${String(source.snippet).replace(/\s+/gu, " ").trim()}`);
    }
    return lines.join("\n");
  }

  function markdownResource(block, resources, { image = false } = {}) {
    const resource = resources.get(block.resource_id);
    const label = block.alt || block.caption || resource?.name || block.resource_id || (image ? "图片" : "附件");
    const metadata = [resource?.mime_type, formatBytes(resource?.size_bytes), resource?.availability].filter(Boolean).join(" · ");
    const embedded = image ? safeEmbeddedImage(resource) : "";
    if (embedded) return `![${markdownLabel(label)}](${embedded})${metadata ? `\n\n_${metadata}_` : ""}`;
    const link = markdownLink(label, resource?.url);
    return `${image ? "外部图片" : "附件"}：${link || markdownLabel(label)}${metadata ? ` · ${metadata}` : ""}`;
  }

  function blockMarkdown(block, context) {
    const body = block.markdown || block.text || "";
    if (block.type === "markdown") return String(block.text || "");
    if (block.type === "text") return String(block.text || "");
    if (["reasoning", "reasoning_summary"].includes(block.type)) {
      const meta = [block.title || BLOCK_LABELS[block.type], formatDuration(block.duration_seconds), block.effort].filter(Boolean).join(" · ");
      const content = body || (block.html ? markdownFence(block.html, "html") : "（没有公开正文）");
      return markdownQuote(`**${meta}**\n\n${content}`);
    }
    if (block.type === "status") {
      const meta = [block.title || BLOCK_LABELS.status, block.text, block.status, formatDuration(block.duration_seconds), block.effort].filter(Boolean).join(" · ");
      const extra = block.markdown ? `\n\n${block.markdown}` : block.html ? `\n\n${markdownFence(block.html, "html")}` : "";
      return markdownQuote(`**${meta}**${extra}`);
    }
    if (block.type === "code") return markdownFence(block.code, block.language || "");
    if (block.type === "math") return block.tex
      ? (block.display === false ? `$${block.tex}$` : `$$\n${block.tex}\n$$`)
      : markdownFence(block.mathml || "", "mathml");
    if (block.type === "image") return markdownResource(block, context.resources, { image: true });
    if (block.type === "attachment") {
      const resource = markdownResource(block, context.resources);
      return block.text ? `${resource}\n\n${markdownFence(block.text, "text")}` : resource;
    }
    if (["search", "citations"].includes(block.type)) {
      const label = block.type === "search" ? `网络搜索${block.query ? `：${block.query}` : ""}` : (block.label || "引用来源");
      const meta = [block.status, formatDuration(block.duration_seconds)].filter(Boolean).join(" · ");
      const sources = markdownSources(block.source_ids, context.sources);
      return [`### ${label}`, meta ? `_${meta}_` : "", body, sources].filter(Boolean).join("\n\n");
    }
    if (block.type === "tool") {
      const label = block.title || block.name || block.kind || "工具活动";
      const meta = [block.call_id ? `ID ${block.call_id.slice(-10)}` : "", block.status, block.success === true ? "成功" : block.success === false ? "失败" : "", formatDuration(block.duration_seconds)].filter(Boolean).join(" · ");
      const content = body || (block.html ? markdownFence(block.html, "html") : "");
      return markdownQuote(`**工具 · ${label}${meta ? ` · ${meta}` : ""}**${content ? `\n\n${content}` : ""}`);
    }
    if (block.type === "diagram") {
      if (block.format === "writing_block" && block.source) {
        return `${markdownQuote("**成品文本 · document**")}\n\n${block.source}`;
      }
      if (block.source) return `${block.title ? `**${block.title}**\n\n` : ""}${markdownFence(block.source, block.format || "text")}`;
      if (block.svg) return `${block.title ? `**${block.title}**\n\n` : ""}${markdownFence(block.svg, "svg")}`;
      if (block.html) return `${block.title ? `**${block.title}**\n\n` : ""}${markdownFence(block.html, "html")}`;
      if (block.resource_id) return markdownResource(block, context.resources, { image: true });
      return `图表：${block.title || block.format || "未命名"}`;
    }
    if (block.type === "html") return `${block.label ? `**${block.label}**\n\n` : ""}${markdownFence(block.html || "", "html")}`;
    return markdownQuote(`**${block.label || "未知组件"}**${body ? `\n\n${body}` : ""}${block.html ? `\n\n${markdownFence(block.html, "html")}` : ""}`);
  }

  function documentToMarkdown(document, options = {}) {
    assertConversation(document);
    const resources = resourceMap(document);
    const sources = sourceMap(document);
    const roleNames = {
      ...ROLE_LABELS,
      user: cleanString(options.userName) || ROLE_LABELS.user,
      assistant: cleanString(options.assistantName) || ROLE_LABELS.assistant
    };
    const output = [`# ${String(document.title).replace(/\s+/gu, " ").trim()}`];
    const metadata = [
      ["平台", `${document.provider} / ${document.platform}`],
      ["模型", (document.models || []).join(" / ")],
      ["内容时间", contentTimeLabel(effectiveContentTime(document))],
      ["导出时间", document.exported_at],
      ["创建时间", document.created_at],
      ["更新时间", document.updated_at],
      ["原文件", document.source_file]
    ];
    for (const [label, value] of metadata) if (value) output.push(`- ${label}：${value}`);
    output.push("---");
    for (const group of groupMessages(document.messages)) {
      const messages = presentationMessages(group, document.platform);
      const role = roleNames[group.role] || group.role;
      output.push(`## ${role}`);
      const messageMeta = [...new Set(messages.flatMap((message) => [message.name, message.model, message.timestamp]).filter(Boolean))].join(" · ");
      if (messageMeta) output.push(`_${messageMeta}_`);
      for (const message of messages) {
        for (const block of message.content || []) {
          const markdown = blockMarkdown(block, { resources, sources });
          if (markdown) output.push(markdown.replace(/\s+$/u, ""));
        }
      }
    }
    if (document.warnings?.length) {
      output.push("## 档案完整性提示");
      for (const warning of document.warnings) {
        const context = [warning.message_index !== undefined ? `消息 ${warning.message_index + 1}` : "", warning.resource_id].filter(Boolean).join(" · ");
        output.push(`- ${warning.message || warning.code}${context ? ` · ${context}` : ""}`);
      }
    }
    return `${output.join("\n\n").trimEnd()}\n`;
  }

  function markdownFileName(document) {
    const identity = conversationIdentity(document).slice(0, 10) || "conversation";
    const stem = String(document?.title || "conversation")
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
      .replace(/\s+/gu, " ")
      .replace(/[. ]+$/gu, "")
      .trim()
      .slice(0, 100) || "conversation";
    return `${stem}-${identity}.md`;
  }

  function windowsSafeStem(value) {
    const raw = String(value ?? "")
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
      .replace(/[. ]+$/gu, "")
      .trim();
    return Array.from(raw || "conversation").slice(0, 120).join("");
  }

  function jsonFileStem(fileName) {
    const basename = String(fileName ?? "").replaceAll("\\", "/").split("/").at(-1) || "";
    return windowsSafeStem(basename.replace(/\.json$/iu, ""));
  }

  function conversationNameMatchesFile(conversationName, fileName) {
    return windowsSafeStem(conversationName) === jsonFileStem(fileName);
  }

  function contentTimeEndpointLabel(endpoint, language = "zh-CN") {
    if (typeof endpoint?.kind === "string") {
      try { return timeCore.formatEndpoint(endpoint, { locale: language === "en" ? "en" : "zh-CN" }); } catch { return ""; }
    }
    if (!endpoint || endpoint.type === "unknown") return language === "en" ? "Unknown time" : "时间未知";
    const bc = endpoint.era === "BC";
    const eraPrefix = bc && language !== "en" ? "公元前" : "";
    const eraSuffix = bc && language === "en" ? " BC" : "";
    if (endpoint.type === "decade") return language === "en" ? `${endpoint.year}s${eraSuffix}` : `${eraPrefix}${endpoint.year}年代`;
    if (endpoint.type === "year") return language === "en" ? `${endpoint.year}${eraSuffix}` : `${eraPrefix}${endpoint.year}年`;
    if (endpoint.type === "month") return language === "en"
      ? `${String(endpoint.year).padStart(4, "0")}-${String(endpoint.month).padStart(2, "0")}${eraSuffix}`
      : `${eraPrefix}${endpoint.year}年${endpoint.month}月`;
    const date = language === "en"
      ? `${String(endpoint.year).padStart(4, "0")}-${String(endpoint.month).padStart(2, "0")}-${String(endpoint.day).padStart(2, "0")}${eraSuffix}`
      : `${eraPrefix}${endpoint.year}年${endpoint.month}月${endpoint.day}日`;
    if (endpoint.hour === undefined || endpoint.minute === undefined) return date;
    const clock = `${String(endpoint.hour).padStart(2, "0")}:${String(endpoint.minute).padStart(2, "0")}`;
    const timezone = endpoint.timezone ? ` UTC${endpoint.timezone === "Z" ? "" : endpoint.timezone}` : "";
    return `${date} ${clock}${timezone}`;
  }

  function contentTimeLabel(value, language = "zh-CN") {
    if (typeof value === "string") return cleanString(value);
    if (!isRecord(value) || !isRecord(value.start)) return "";
    if (typeof value.start.kind === "string") {
      try { return timeCore.formatRange(value, { locale: language === "en" ? "en" : "zh-CN" }); } catch { return ""; }
    }
    const start = contentTimeEndpointLabel(value.start, language);
    return isRecord(value.end) ? `${start} — ${contentTimeEndpointLabel(value.end, language)}` : start;
  }

  return Object.freeze({
    READER_VERSION, SCHEMA, V1_SCHEMA, SCHEMAS, CONTENT_TYPES, ROLE_LABELS, BLOCK_LABELS,
    isRecord, cleanString, normalizeText, isSemanticVersion, conversationCompatibility, validateConversation, assertConversation,
    collectBlockText, collectMessageText, collectGroupText, groupMessages, presentationMessages, conversationText, conversationIdentity,
    presentationDocument, makeEntry, makeProjectedEntry, matchesEntry,
    messageMatches, sortedEntries, resourceMap, sourceMap, safeExternalUrl,
    safeEmbeddedImage, formatBytes, formatDuration, effectiveContentTime, contentTimeRange, contentTimeSortDescriptor, compareContentTimeDescriptors, contentTimeSortKey, contentTimeLabel, documentStats,
    documentToMarkdown, markdownFileName, windowsSafeStem, jsonFileStem, conversationNameMatchesFile
  });
}));
