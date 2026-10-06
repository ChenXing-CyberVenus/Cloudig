import MarkdownIt from "markdown-it";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";
import { DEFAULT_SEARCH_CATEGORIES, SEARCH_CATEGORIES, messageContentCategory, type SearchCategory } from "./content-selection.mts";

export const FULL_TEXT_LIMITS = Object.freeze({ queryCharacters: 256, excerptCharacters: 220, excerptBefore: 70, yieldEveryMessages: 64, progressIntervalMs: 100, page: 30, resultRows: 50_000, retainedSnapshots: 2, issueDetails: 16 });
export type MessageSearchHit = Readonly<{ message: string; index: number; categories: readonly SearchCategory[]; excerpt: string }>;
const markdown = new MarkdownIt({ html: true, linkify: false });
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("und");
const lines = (value: string) => value.replace(/\r\n?/gu, "\n");
const BLOCK_ELEMENTS = new Set(["p", "div", "section", "article", "li", "ul", "ol", "tr", "td", "th", "br", "hr", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);
const HIDDEN_ELEMENTS = new Set(["script", "style", "template", "noscript"]);

/** Inert text extraction: no DOM execution, remote loads, or resource-base64 scanning. */
export function searchableHtmlText(source: string): string {
  const output: string[] = [];
  type Node = DefaultTreeAdapterTypes.ChildNode;
  const visit = (node: Node): void => {
    if ("value" in node) { output.push(node.value); return; }
    if (!("tagName" in node)) return;
    if (HIDDEN_ELEMENTS.has(node.tagName) || node.attrs.some(a => a.name === "hidden" || a.name === "aria-hidden" && a.value === "true")) return;
    if (BLOCK_ELEMENTS.has(node.tagName)) output.push("\n");
    if (node.tagName === "br" || node.tagName === "hr") return;
    if (node.tagName === "img") output.push(node.attrs.find(a => a.name === "alt")?.value ?? "");
    for (const child of node.childNodes) visit(child);
    if (BLOCK_ELEMENTS.has(node.tagName)) output.push("\n");
  };
  for (const node of parseFragment(source).childNodes) visit(node);
  return output.join("").replace(/[\t ]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

function dataText(value: JsonValue | undefined): string {
  if (typeof value === "string") return /^data:[^,]*;base64,/iu.test(value) ? "" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(dataText).filter(Boolean).join("\n");
  if (!isJsonObject(value)) return "";
  return Object.entries(value).filter(([key]) => !["data_base64", "sha256", "source_id", "resource", "parent"].includes(key))
    .map(([, child]) => dataText(child)).filter(Boolean).join("\n");
}

function blockText(block: JsonObject, resources: ReadonlyMap<string, JsonObject>, references: ReadonlyMap<string, JsonObject>): string {
  const text = (key: string) => typeof block[key] === "string" ? String(block[key]) : "";
  const raw = text("text"), type = text("type"), format = text("format");
  const body = type === "html" ? searchableHtmlText(text("html"))
    : type === "markdown" || format === "markdown" ? searchableHtmlText(markdown.render(raw))
      : format === "html" ? searchableHtmlText(raw) : raw;
  const parts = [text("title"), body, text("code"), text("tex"), text("alt"), text("caption"), text("query")];
  if (type !== "html" && text("html")) parts.push(searchableHtmlText(text("html")));
  if (type === "math" && text("mathml")) parts.push(searchableHtmlText(text("mathml")));
  if (type === "tool") parts.push(text("name"), dataText(block["input"]), dataText(block["output"]));
  if (type === "interactive") parts.push(dataText(block["data"]));
  if (type === "diagram") parts.push(text("source"));
  if (type === "image" || type === "attachment") { const resource = resources.get(text("resource")); if (typeof resource?.["name"] === "string") parts.push(resource["name"]); }
  const refs = block["references"] ?? block["sources"];
  for (const id of Array.isArray(refs) ? refs : []) {
    const reference = references.get(String(id)); if (!reference) continue;
    for (const key of ["title", "name", "snippet", "text", "url"]) if (typeof reference[key] === "string") parts.push(reference[key]);
  }
  return lines(parts.filter(Boolean).join("\n"));
}

function excerpt(value: string, normalizedOffset: number): string {
  // Map a normalized match back to the original text without keeping a second
  // per-character position index for every message in a large Library.
  let low = 0, high = value.length;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (normalize(value.slice(0, mid)).length < normalizedOffset) low = mid + 1; else high = mid; }
  let start = Math.max(0, low - FULL_TEXT_LIMITS.excerptBefore), end = Math.min(value.length, start + FULL_TEXT_LIMITS.excerptCharacters);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start]!)) start--;
  if (end < value.length && /[\uDC00-\uDFFF]/u.test(value[end]!)) end++;
  return `${start ? "…" : ""}${value.slice(start, end).trim()}${end < value.length ? "…" : ""}`;
}

/** Validated record or transient Reader input; visits all nodes, never the displayed path. */
export function* scanConversationMessages(conversation: JsonObject, input: Readonly<{ query: string; categories?: readonly SearchCategory[]; signal?: AbortSignal }>): Generator<MessageSearchHit | undefined> {
  const needle = normalize(input.query.trim()), categories = input.categories ?? DEFAULT_SEARCH_CATEGORIES;
  if (!needle || [...input.query].length > FULL_TEXT_LIMITS.queryCharacters) throw new TypeError("Search text is empty or too long");
  if (categories.some(c => !SEARCH_CATEGORIES.includes(c)) || new Set(categories).size !== categories.length) throw new TypeError("Invalid search categories");
  const wanted = new Set(categories);
  if (!wanted.size) return;
  const roles = new Map((Array.isArray(conversation["identity"]) ? conversation["identity"].filter(isJsonObject) : []).map(f => [String(f["source_id"]), f["role"]]));
  const table = (value: JsonValue | undefined) => new Map((Array.isArray(value) ? value.filter(isJsonObject) : []).map(v => [String(v["id"]), v]));
  const resources = table(conversation["resources"]), references = table(conversation["references"] ?? conversation["sources"]);
  const tree = conversation["messages"], messages = Array.isArray(tree) ? tree : isJsonObject(tree) && Array.isArray(tree["items"]) ? tree["items"] : [];
  for (const [index, message] of messages.entries()) {
    input.signal?.throwIfAborted(); if (!isJsonObject(message)) continue;
    const texts = new Map<SearchCategory, string[]>();
    const visit = (block: JsonObject, inheritedRole: unknown, process: boolean): void => {
      const role = typeof block["speaker"] === "string" ? roles.get(block["speaker"]) ?? inheritedRole : inheritedRole;
      const category = process ? "process" : messageContentCategory(role, block);
      if (wanted.has(category)) { const text = blockText(block, resources, references); if (text) { const list = texts.get(category) ?? []; list.push(text); texts.set(category, list); } }
      if (Array.isArray(block["content"])) for (const child of block["content"]) if (isJsonObject(child)) visit(child, role, category === "process");
    };
    const role = message["role"] ?? roles.get(String(message["speaker"]));
    for (const block of Array.isArray(message["content"]) ? message["content"] : []) if (isJsonObject(block)) visit(block, role, false);
    const found: SearchCategory[] = []; let preview = "";
    for (const [category, pieces] of texts) { const body = pieces.join("\n"), position = normalize(body).indexOf(needle); if (position < 0) continue; found.push(category); if (!preview) preview = excerpt(body, position); }
    yield found.length ? { message: String(message["id"]), index, categories: found, excerpt: preview } : undefined;
  }
}

export function* searchConversationMessages(conversation: JsonObject, input: Parameters<typeof scanConversationMessages>[1]): Generator<MessageSearchHit> {
  for (const hit of scanConversationMessages(conversation, input)) if (hit) yield hit;
}
