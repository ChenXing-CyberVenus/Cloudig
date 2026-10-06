import type { DefaultTreeAdapterTypes } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.ChildNode;

function descendants(node: Element): Element[] {
  return node.childNodes.flatMap(child => "tagName" in child ? [child, ...descendants(child)] : []);
}

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find(item => item.name === name)?.value;
}

function textContent(node: Node): string {
  return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}

// The exporter contract identifies the source panel; a language-* class is
// merely one spelling. Read exact decoded text, never rebuild Mermaid from SVG.
export function mermaidCardSource(card: Element): string | undefined {
  const nodes = descendants(card);
  const panel = nodes.find(node => attribute(node, "data-osis-mermaid-panel") === "source");
  const code = panel
    ? descendants(panel).find(node => node.tagName === "code") ?? panel
    : nodes.find(node => node.tagName === "code" && (
      (attribute(node, "class") ?? "").split(/\s+/u).includes("language-mermaid")
      || attribute(node, "data-language") === "mermaid"
      || (node.parentNode && "tagName" in node.parentNode && attribute(node.parentNode, "data-language") === "mermaid")
    ));
  const source = code ? textContent(code) : undefined;
  return source?.trim() ? source : undefined;
}

export function mermaidCardVisual(card: Element): Element | undefined {
  const panel = descendants(card).find(node => attribute(node, "data-osis-mermaid-panel") === "diagram") ?? card;
  return descendants(panel).find(node => node.tagName === "img" || node.tagName === "svg");
}
