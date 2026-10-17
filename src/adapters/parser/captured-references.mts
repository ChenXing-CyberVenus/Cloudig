import { parseFragment, type DefaultTreeAdapterTypes as Tree } from "parse5";
import type { JsonObject } from "../../core/contracts/types.mts";

const attr = (node: Tree.Element, key: string): string | undefined => node.attrs.find(a => a.name === key)?.value;
const hasClass = (node: Tree.Node, name: string): boolean => "tagName" in node && (attr(node, "class") ?? "").split(/\s+/u).includes(name);
const text = (node: Tree.Node): string => "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
const elements = (node: Tree.Node): Tree.Element[] => [ ...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(elements) : []) ];

/** Only named exporter reference slots are evidence, never arbitrary body links. */
export function capturedReferences(html: string, kind: "kimi-search" | "grok-image"): JsonObject[] {
  const nodes = elements(parseFragment(html));
  return nodes.flatMap(link => {
    if (link.tagName !== "a") return [];
    if (kind === "kimi-search" ? !hasClass(link, "osis-search-result-title") : !link.parentNode || !hasClass(link.parentNode, "image-source-link")) return [];
    const url = attr(link, "href");
    if (!url || !/^https?:\/\//iu.test(url)) return [];
    const title = text(link).trim(), siblings = link.parentNode ? elements(link.parentNode) : [];
    const meta = siblings.find(n => hasClass(n, "osis-search-result-meta"));
    const snippet = kind === "kimi-search" ? siblings.find(n => n.tagName === "p") : undefined;
    return [{ url, ...(title ? { title } : {}), ...(meta ? { hostname: text(meta).trim() } : {}), ...(snippet ? { snippet: text(snippet).trim() } : {}) }];
  });
}
