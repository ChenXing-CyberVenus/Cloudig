import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";

const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length ? v : undefined;
const object = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const list = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter(isJsonObject) : [];
const structured = new Set(["translation", "recipe", "quiz", "step_card", "options_card", "comparison_card", "featured_card", "product_carousel", "itinerary", "link_preview", "message_compose", "chart", "weather", "places_map", "places_list", "ask_user_input"]);
const documentFormats: Readonly<Record<string, string>> = { docs: "document", slides: "slides", design: "design", "design-system": "design-system" };
export type InteractiveFileWriter = (name: string, source: string, mime: string) => string;
export function interactiveFileMime(name: string): string {
  if (/\.html?$/iu.test(name)) return "text/html";
  if (/\.svg$/iu.test(name)) return "image/svg+xml";
  if (/\.json$/iu.test(name)) return "application/json";
  if (/\.xml$/iu.test(name)) return "application/xml";
  if (/\.[jt]sx?$/iu.test(name)) return "text/javascript";
  if (/\.css$/iu.test(name)) return "text/css";
  if (/\.md$/iu.test(name)) return "text/markdown";
  return "text/plain";
}
const safeVirtualPath = (name: string) => !/^[\/\\]|[\\\u0000-\u001f:#?%]/u.test(name) && name.split("/").every(p => p && p !== "." && p !== "..");

/** Pure projection of source-owned native data; never evaluates source HTML/JS.
 * Original tool calls remain source facts; the Reader presents this block in
 * the answer channel, not inside a thinking/tool disclosure. */
export function claudeInteractive(block: JsonObject, result: JsonObject | undefined, write: InteractiveFileWriter): JsonObject | undefined {
  const card = object(block["native_card"]), kind = text(card["kind"]), input = object(block["input"]);
  if (!kind) return;
  const title = text(card["title"]) ?? text(input["title"] ?? input["summary_title"]);
  const common: JsonObject = { type: "interactive", source: `claude.ai_${kind === "visualize" || documentFormats[kind] ? kind : text(block["name"]) ?? kind}`, ...(title ? { title } : {}) };
  if (structured.has(kind)) {
    if (!Object.keys(input).length) return;
    return { ...common, display: "box", format: "structured", data: { input,
      ...(result?.["content"] !== undefined ? { result: result["content"]! } : {}) } };
  }
  if (kind === "visualize") {
    const code = text(input["widget_code"]); if (!code) return;
    // Full applications/externally loaded engines run only after opening a
    // Window. A saved tiny inline widget may keep its lightweight Box behavior.
    const heavy = /<script\b[^>]*(?:\bsrc\s*=|\btype\s*=\s*["']module)|\b(?:THREE\.|WebGLRenderer|AudioContext|requestAnimationFrame\s*\()/iu.test(code);
    const files: JsonObject[] = [{ path: "index.html", resource: write("index.html", code, "text/html") }];
    // Icon names and captured resources are resolved by the caller, never by
    // a network fetch or by changing the original widget source here.
    return { ...common, display: heavy ? "window" : "box", format: "html", files, entry: "index.html" };
  }
  const format = documentFormats[kind]; if (!format) return;
  const sourceFiles = list(card["files"]), seen = new Set<string>();
  // Reject an ambiguous group to the existing source/tool fallback intact,
  // rather than silently replacing same-name files or guessing an entry.
  if (!sourceFiles.length || sourceFiles.some(f => {
    const name = text(f["name"]); if (!name || typeof f["source"] !== "string" || !safeVirtualPath(name) || seen.has(name)) return true;
    seen.add(name); return false;
  })) return;
  const wanted = kind === "slides" ? /(?:^|\/)deck\.json$/u : kind === "design" ? /\.dc\.html$/u : kind === "design-system" ? /(?:^|\/)design-system\.json$/u : /\.(?:xml|md|html)$/u;
  const entries = sourceFiles.filter(f => wanted.test(String(f["name"])));
  if (entries.length !== 1) return;
  return { ...common, display: "window", format, entry: entries[0]!["name"]!, files: sourceFiles.map(f => ({
    path: f["name"]!, resource: write(String(f["name"]), String(f["source"]), interactiveFileMime(String(f["name"])))
  })) };
}
