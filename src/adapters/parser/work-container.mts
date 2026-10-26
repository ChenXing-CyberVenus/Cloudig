import { parse, type DefaultTreeAdapterTypes } from "parse5";

export const WORK_CONTAINER_LIMITS = Object.freeze({ inlineHeight: 640, inlineWidth: 960 });
type Role = "inline" | "component" | "workspace" | "unknown";
/** Presentation evidence only. Frameworks, scripts, animation and resource
 * bytes say nothing about whether a work belongs inside a paragraph stream.
 * This deterministic decision never depends on the user's current monitor. */
export function workContainer(input: { role: Role; source?: string; previewHeight?: unknown }): "box" | "window" {
  if (input.role === "workspace") return "window";
  if (input.role === "inline") return "box";
  const source = input.source ?? "", document = parse(source);
  const roots: DefaultTreeAdapterTypes.Element[] = [], styles: string[] = [];
  const walk = (node: DefaultTreeAdapterTypes.Node, depth = 0): void => {
    if (!("tagName" in node)) { if ("childNodes" in node) node.childNodes.forEach(n => walk(n, depth)); return; }
    if (node.tagName === "style") styles.push(node.childNodes.filter(n => "value" in n).map(n => (n as DefaultTreeAdapterTypes.TextNode).value).join(""));
    if (node.tagName === "body") depth = 1;
    if (depth > 0 && depth <= 3 && !["script", "style", "link"].includes(node.tagName)) roots.push(node);
    node.childNodes.forEach(n => walk(n, depth ? depth + 1 : 0));
  }; walk(document);
  const selectors = new Set(roots.flatMap(n => [n.tagName, ...n.attrs.flatMap(a => a.name === "id" ? [`#${a.value}`] : a.name === "class" ? a.value.split(/\s+/u).map(c => `.${c}`) : [])]));
  const declarations = roots.flatMap(n => n.attrs.filter(a => a.name === "style").map(a => a.value));
  for (const style of styles) for (const match of style.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    // Only a direct selector for the outer layout is a dimension witness.
    // A tall icon, code sample string or inner plot is not a full-page request.
    if (match[1]!.split(",").some(s => selectors.has(s.trim()))) declarations.push(match[2]!);
  }
  let compact = false;
  for (const declaration of declarations) {
    for (const match of declaration.matchAll(/(?:^|;)\s*(height|min-height|width|min-width)\s*:\s*([^;]+)/giu)) {
      const property = match[1]!.toLowerCase(), value = match[2]!.trim();
      if (property.includes("height") && /\b(?:[8-9]\d|100)(?:d|s|l)?vh\b/iu.test(value)) return "window";
      const pixel = /^(\d+(?:\.\d+)?)px(?:\s*!important)?$/iu.exec(value);
      if (pixel) {
        const n = Number(pixel[1]);
        if (n > (property.includes("height") ? WORK_CONTAINER_LIMITS.inlineHeight : WORK_CONTAINER_LIMITS.inlineWidth)) return "window";
        if (property === "height" && n > 0) compact = true;
      }
    }
  }
  const height = input.previewHeight;
  if (typeof height === "number" && Number.isFinite(height) && height > 0) {
    if (height > WORK_CONTAINER_LIMITS.inlineHeight) return "window";
    compact = true;
  }
  return input.role === "component" || compact ? "box" : "window";
}
