import { isJsonObject, type JsonObject } from "../../core/contracts/types.mts";

export type ContentMode = "body" | "with_process";
export type ContentCategory = "content" | "reasoning" | "tool" | "references";
export type SearchCategory = "user" | "assistant" | "process";
export const SEARCH_CATEGORIES = Object.freeze(["user", "assistant", "process"] as const);
export const DEFAULT_SEARCH_CATEGORIES: readonly SearchCategory[] = Object.freeze(["user", "assistant"]);

/** The same boundary for navigation, search and export. An assistant message can contain both. */
export function blockCategory(block: JsonObject): ContentCategory {
  if (isJsonObject(block["party"]) && block["party"]["role"] === "system") return "reasoning";
  if (["reasoning", "reasoning_summary", "status"].includes(String(block["type"]))) return "reasoning";
  if (block["type"] === "tool") return "tool";
  if (["search", "citations"].includes(String(block["type"]))) return "references";
  return "content";
}

export function messageContentCategory(role: unknown, block: JsonObject): SearchCategory {
  if (blockCategory(block) !== "content" || role !== "user" && role !== "assistant") return "process";
  return role;
}

/** Copy only the filtered containers; never rewrite the source or flatten process children into body. */
export function bodyBlocks(blocks: readonly JsonObject[]): JsonObject[] {
  return blocks.filter(block => blockCategory(block) === "content").map(block => Array.isArray(block["content"])
    ? { ...block, content: bodyBlocks(block["content"].filter(isJsonObject)) }
    : block);
}

export function selectedMessageBlocks(message: JsonObject, mode: ContentMode): JsonObject[] {
  const blocks = Array.isArray(message["content"]) ? message["content"].filter(isJsonObject) : [];
  if (mode === "with_process") return blocks;
  return message["role"] === "user" || message["role"] === "assistant" ? bodyBlocks(blocks) : [];
}
