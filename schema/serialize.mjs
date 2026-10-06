import { validateConversation } from "./validate.mjs";

const ROOT_ORDER = [
  "schema",
  "parser_version",
  "parser_adapter",
  "parsed_at",
  "exporter_version",
  "conversation_key",
  "conversation_id",
  "source_file",
  "source_sha256",
  "source_size_bytes",
  "source_url",
  "exported_at",
  "content_time",
  "created_at",
  "updated_at",
  "title",
  "provider",
  "platform",
  "models",
  "messages",
  "resources",
  "sources",
  "warnings"
];

const MESSAGE_ORDER = ["id", "parent_id", "turn_id", "role", "name", "model", "timestamp", "content"];
const BLOCK_ORDERS = {
  markdown: ["type", "text"],
  text: ["type", "text"],
  reasoning: ["type", "title", "text", "markdown", "html", "duration_seconds", "effort"],
  reasoning_summary: ["type", "title", "text", "markdown", "html", "duration_seconds", "effort"],
  status: ["type", "title", "text", "markdown", "html", "duration_seconds", "effort"],
  code: ["type", "code", "language", "filename"],
  math: ["type", "tex", "mathml", "display"],
  image: ["type", "resource_id", "purpose", "alt", "caption"],
  attachment: ["type", "resource_id", "text"],
  search: ["type", "query", "source_ids", "status", "duration_seconds"],
  citations: ["type", "source_ids", "label"],
  tool: ["type", "kind", "call_id", "name", "title", "text", "markdown", "html", "status", "success"],
  diagram: ["type", "format", "title", "source", "svg", "html", "resource_id"],
  html: ["type", "label", "html"],
  unknown: ["type", "label", "text", "html"]
};
const RESOURCE_ORDER = [
  "id",
  "kind",
  "availability",
  "name",
  "mime_type",
  "size_bytes",
  "original_size_bytes",
  "sha256",
  "data_url",
  "url",
  "width",
  "height",
  "original_width",
  "original_height"
];
const SOURCE_ORDER = ["id", "url", "title", "site_name", "snippet"];
const WARNING_ORDER = ["code", "message", "message_index", "resource_id"];

function orderFor(pathName, value) {
  if (pathName === "$") return ROOT_ORDER;
  if (/\.messages\[\d+\]$/.test(pathName)) return MESSAGE_ORDER;
  if (/\.content\[\d+\]$/.test(pathName)) return BLOCK_ORDERS[value?.type] ?? ["type"];
  if (/\.resources\[\d+\]$/.test(pathName)) return RESOURCE_ORDER;
  if (/\.sources\[\d+\]$/.test(pathName)) return SOURCE_ORDER;
  if (/\.warnings\[\d+\]$/.test(pathName)) return WARNING_ORDER;
  return [];
}

function sortEntries(entries, order) {
  const rank = new Map(order.map((key, index) => [key, index]));
  return entries.sort(([left], [right]) => {
    const leftRank = rank.has(left) ? rank.get(left) : Number.MAX_SAFE_INTEGER;
    const rightRank = rank.has(right) ? rank.get(right) : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right, "en");
  });
}

function compactValue(value, pathName, keyName = "") {
  if (value === null || value === undefined || value === "") return undefined;
  if (keyName === "display" && value === false) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((item, index) => compactValue(item, `${pathName}[${index}]`))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    const entries = [];
    for (const [key, child] of Object.entries(value)) {
      const compacted = compactValue(child, `${pathName}.${key}`, key);
      if (compacted !== undefined) entries.push([key, compacted]);
    }
    if (entries.length === 0) return undefined;
    return Object.fromEntries(sortEntries(entries, orderFor(pathName, value)));
  }
  return value;
}

export function normalizeConversation(value) {
  const normalized = compactValue(value, "$", "");
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError("Conversation must normalize to an object");
  }
  return normalized;
}

export function serializeConversation(value) {
  const normalized = normalizeConversation(value);
  const result = validateConversation(normalized);
  if (!result.valid) {
    throw new TypeError(`Conversation validation failed:\n${result.errors.join("\n")}`);
  }
  return `${JSON.stringify(normalized, null, 2)}\n`;
}
