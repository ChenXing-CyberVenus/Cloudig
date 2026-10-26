import { defaultTreeAdapter, type DefaultTreeAdapterTypes as Tree } from "parse5";

const elements = (parent: Tree.ParentNode): Tree.Element[] => parent.childNodes.filter((node): node is Tree.Element => "tagName" in node);
const attr = (node: Tree.Element, name: string): string | undefined => node.attrs.find(a => a.name === name)?.value;
const hasClass = (node: Tree.Element, name: string): boolean => (attr(node, "class") ?? "").split(/\s+/u).includes(name);
const only = <T,>(items: T[]): T | undefined => items.length === 1 ? items[0] : undefined;
const sections = (table: Tree.Element, tag: string): Tree.Element[] => elements(table).filter(n => n.tagName === tag);
const rows = (section: Tree.Element): Tree.Element[] => elements(section).filter(n => n.tagName === "tr");
const width = (sections: Tree.Element[]): number => sections.flatMap(rows).reduce((max, row) => Math.max(max,
  elements(row).filter(n => n.tagName === "th" || n.tagName === "td").reduce((sum, cell) => {
    const span = Number(attr(cell, "colspan") ?? 1);
    return sum + (Number.isSafeInteger(span) && span > 0 ? span : 1);
  }, 0)), 0);

/** Kimi's legacy presentation tables share a column grid only on the live site.
 * Normalize the captured structure once, in both Parser and read-only Reader.
 * Unknown shapes are retained; this never runs inside a work's source string.
 */
export function normalizeCapturedTables(root: Tree.ParentNode): void {
  const visit = (parent: Tree.ParentNode): void => {
    for (const wrapper of elements(parent)) {
      if (hasClass(wrapper, "markdown-table")) merge(wrapper);
      visit(wrapper);
    }
  };
  visit(root);
}

function merge(wrapper: Tree.Element): void {
  const headerShell = only(elements(wrapper).filter(n => hasClass(n, "table-header")));
  const bodyShell = only(elements(wrapper).filter(n => hasClass(n, "table-container")));
  if (!headerShell || !bodyShell) return;
  const header = only(elements(headerShell).filter(n => n.tagName === "table" && hasClass(n, "header-table")));
  const body = only(elements(bodyShell).filter(n => n.tagName === "table" && hasClass(n, "body-table")));
  if (!header || !body || headerShell.childNodes.some(n => n !== header && ("tagName" in n || (n.nodeName === "#text" && "value" in n && n.value.trim())))) return;
  const head = only(sections(header, "thead")), bodies = sections(body, "tbody");
  if (!head || rows(head).length === 0 || bodies.length === 0 || sections(body, "thead").length
    || elements(header).some(n => n.tagName !== "thead" && n.tagName !== "colgroup")
    || width([head]) === 0 || width([head]) !== width(bodies)) return;

  const removeButtons = (parent: Tree.ParentNode): void => {
    for (const child of elements(parent)) {
      if (hasClass(child, "table-buttons")) defaultTreeAdapter.detachNode(child);
      else removeButtons(child);
    }
  };
  removeButtons(head);
  defaultTreeAdapter.detachNode(head);
  defaultTreeAdapter.insertBefore(body, head, bodies[0]!);
  body.attrs = body.attrs.filter(a => a.name !== "role");
  const classes = body.attrs.find(a => a.name === "class");
  if (classes) classes.value = classes.value.split(/\s+/u).filter(c => c !== "body-table" && c !== "has-col-widths").join(" ");
  const label = attr(wrapper, "aria-label");
  if (label !== undefined) {
    body.attrs = body.attrs.filter(a => a.name !== "aria-label");
    body.attrs.push({ name: "aria-label", value: label });
  }
  wrapper.attrs = wrapper.attrs.filter(a => a.name !== "role");
  defaultTreeAdapter.detachNode(headerShell);
}
