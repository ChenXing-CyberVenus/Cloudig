import { defaultTreeAdapter as tree, serialize, type DefaultTreeAdapterTypes as T } from "parse5";
import type { JsonObject } from "../../core/contracts/types.mts";

/** Split typed block slots without slicing serialized opening/closing tags.
 * Reopen only the actual ancestors of retained content in each HTML segment. */
export function htmlBlockSegments(root: T.DocumentFragment, slots: ReadonlyMap<string, JsonObject>): Array<string | JsonObject> {
  const result: Array<string | JsonObject> = [], ancestors: T.Element[] = [];
  let fragment = tree.createDocumentFragment(), copies = new Map<T.Element, T.Element>(), meaningful = false;
  const shallow = (n: T.Element) => tree.createElement(n.tagName, n.namespaceURI, n.attrs.map(a => ({ ...a })));
  const clone = (n: T.ChildNode): T.ChildNode => {
    if (n.nodeName === "#text") return tree.createTextNode((n as T.TextNode).value);
    if (!("tagName" in n)) return tree.createCommentNode("data" in n ? n.data : "");
    const c = shallow(n); for (const child of n.childNodes) tree.appendChild(c, clone(child)); return c;
  };
  const append = (n: T.ChildNode) => {
    let parent: T.ParentNode = fragment;
    for (const a of ancestors) { let c = copies.get(a); if (!c) { c = shallow(a); copies.set(a, c); tree.appendChild(parent, c); } parent = c; }
    tree.appendChild(parent, clone(n));
    meaningful ||= n.nodeName !== "#text" || !!(n as T.TextNode).value.trim();
  };
  const flush = () => { if (meaningful) result.push(serialize(fragment)); fragment = tree.createDocumentFragment(); copies = new Map(); meaningful = false; };
  const pattern = /(\uE000CLOUDIG_(?:ATTACHMENT|GEMINI_RICH)_[0-9]+\uE001)/u;
  const hasSlot = (n: T.ChildNode): boolean => "value" in n ? n.value.split(pattern).some(s => slots.has(s)) : "childNodes" in n && n.childNodes.some(hasSlot);
  const visit = (n: T.ChildNode) => {
    if (!hasSlot(n)) { append(n); return; }
    if ("value" in n) for (const part of n.value.split(pattern)) { const block = slots.get(part); if (block) { flush(); result.push(block); } else if (part) append(tree.createTextNode(part)); }
    else if ("tagName" in n) { ancestors.push(n); for (const child of n.childNodes) visit(child); ancestors.pop(); }
  };
  for (const child of root.childNodes) visit(child); flush(); return result;
}
