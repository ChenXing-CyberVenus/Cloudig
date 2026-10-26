import { workContainer } from "./work-container.mts";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { parse as parseJavaScript } from "acorn";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";

type Element = DefaultTreeAdapterTypes.Element;
/** A code fence is not an explicit platform Artifact. Only promote a whole
 * document when its ordinary inline scripts are syntactically runnable. Keep
 * incomplete examples byte-for-byte as code, rather than inventing the omitted
 * program. JSX/data/import-map scripts belong to their own declared loader. */
function brokenInlineScript(source: string): boolean {
  const pending: DefaultTreeAdapterTypes.Node[] = [parseFragment(source)];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === "script" && !node.attrs.some(a => a.name === "src")) {
      const type = node.attrs.find(a => a.name === "type")?.value.trim().toLowerCase() ?? "";
      if (["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"].includes(type)) {
        const code = node.childNodes.filter(n => "value" in n).map(n => (n as DefaultTreeAdapterTypes.TextNode).value).join("");
        try { parseJavaScript(code, { ecmaVersion: "latest", sourceType: type === "module" ? "module" : "script" }); }
        catch { return true; }
      }
    }
    if ("childNodes" in node) pending.push(...node.childNodes);
  }
  return false;
}
function htmlTitle(source: string): string | undefined {
  const visit = (node: DefaultTreeAdapterTypes.ParentNode): string | undefined => {
    for (const child of node.childNodes) if ("tagName" in child) {
      if (child.tagName === "title") return child.childNodes.filter(n => "value" in n).map(n => (n as DefaultTreeAdapterTypes.TextNode).value).join("").trim() || undefined;
      const title = visit(child as Element); if (title) return title;
    }
    return undefined;
  };
  return visit(parseFragment(source));
}

/** Only source-identified fences become works. Ordinary code snippets, the same
 * string in another message, and renderer preview text cannot claim a work. */
export function deepSeekCodeProjector(item: JsonObject, write: (name: string, source: string, mime: string) => string): Readonly<{
  has(kind: "RESPONSE" | "THINK"): boolean;
  project(blocks: JsonObject[]): JsonObject[];
}> {
  const records = (Array.isArray(item["code_artifacts"]) ? item["code_artifacts"].filter(isJsonObject) : []).map(raw => ({ raw, used: false }));
  const ids = new Set<string>();
  for (const { raw } of records) {
    if (typeof raw["id"] !== "string" || ids.has(raw["id"]) || raw["message_id"] !== item["message_id"] || raw["provenance"] !== "message_code_fence" || typeof raw["source"] !== "string") throw new TypeError("DeepSeek code artifact has ambiguous source ownership");
    ids.add(raw["id"]);
  }
  const has = (kind: "RESPONSE" | "THINK"): boolean => records.some(({ raw }) => raw["fragment_type"] === kind);
  const resolve = (kind: "RESPONSE" | "THINK", source: string, language: string): JsonObject | undefined => {
    const entry = records.find(({ raw, used }) => !used && raw["fragment_type"] === kind && raw["source"] === source && String(raw["language"]).toLowerCase() === language.toLowerCase());
    if (!entry) return;
    entry.used = true;
    // Script-only examples and abbreviated fragments remain ordinary code.
    // Complete documents and standalone SVG have an actual display surface.
    const svg = /^\s*<svg\b[\s\S]*<\/svg>\s*$/iu.test(source);
    const document = /<html\b/iu.test(source) && /<\/html>\s*$/iu.test(source);
    if (!svg && (!document || brokenInlineScript(source))) return;
    const name = typeof entry.raw["filename"] === "string" ? entry.raw["filename"] : svg ? "image.svg" : "index.html";
    const file = svg ? "image.svg" : "index.html";
    return { type: workContainer({role:svg ? "inline" : "unknown",source}), source: "chat.deepseek.com_code", format: svg ? "svg" : "html",
      title: htmlTitle(source) ?? name, files: [{ path: file, resource: write(name, source, svg ? "image/svg+xml" : "text/html") }], entry: file };
  };
  const project = (blocks: JsonObject[]): JsonObject[] => blocks.flatMap(block => {
    if (block["type"] === "markdown" && typeof block["text"] === "string") return projectMarkdownWithDiagrams(block["text"], undefined, (source, language) => resolve("RESPONSE", source, language));
    if (block["type"] !== "reasoning" || block["format"] !== "markdown" || typeof block["text"] !== "string" || !has("THINK")) return [block];
    const content = projectMarkdownWithDiagrams(block["text"], undefined, (source, language) => resolve("THINK", source, language));
    if (!content.some(b => b["type"] === "box" || b["type"] === "window")) return [block];
    const { text: _text, format: _format, ...rest } = block;
    return [{ ...rest, content }];
  });
  return { has, project };
}
