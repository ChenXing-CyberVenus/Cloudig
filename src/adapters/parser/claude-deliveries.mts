import { parseFragment, serialize, type DefaultTreeAdapterTypes as Tree } from "parse5";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";

const attr = (node: Tree.Element, name: string) => node.attrs.find(a => a.name === name)?.value;
const has = (node: Tree.Element, name: string) => (attr(node, "class") ?? "").split(/\s+/u).includes(name);
const text = (node: Tree.ParentNode): string => node.childNodes.map(n => "value" in n ? n.value : "childNodes" in n ? text(n) : "").join("");
const elements = (node: Tree.ParentNode): Tree.Element[] => node.childNodes.flatMap(n => "tagName" in n && !["pre", "code", "script", "template"].includes(n.tagName) ? [n, ...elements(n)] : []);
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];

/** The exporter serializes DOM card descriptors without their files. Its exact
 * message-owned reading surface still contains those files. Bind the two
 * channels only when their complete ordered card sequences agree, including
 * each descriptor's title/type. Never search other messages or match a global
 * filename/title. Synthetic aliases absent from the raw markers are not cards.
 */
export function claudeDeliveries(message: JsonObject, readingHtml: string | undefined,
  restore: (tree: Tree.ParentNode) => void): Readonly<{ cards: ReadonlyMap<string, JsonObject>; readingHtml?: string }> {
  const result = new Map<string, JsonObject>();
  if (!readingHtml) return { cards: result };
  const descriptors = new Map<string, JsonObject>();
  for (const tool of [...objects(message["blocks"]), ...objects(message["cowork_page_tools"])]) {
    if (typeof tool["id"] === "string" && isJsonObject(tool["native_card"])) descriptors.set(tool["id"], tool["native_card"]);
  }
  for (const card of objects(message["dom_native_cards"])) if (typeof card["id"] === "string") descriptors.set(card["id"], card);
  const ids = objects(message["blocks"]).filter(b => b["type"] === "text" && b["reading_surface_visible"] !== false)
    .flatMap(b => typeof b["rich_html"] === "string" ? elements(parseFragment(b["rich_html"])).flatMap(n => attr(n, "data-osis-native-card-id") ?? []) : []);
  const tree = parseFragment(readingHtml); restore(tree);
  const cards = elements(tree).filter(n => attr(n, "data-osis-native-card"));
  // Light deliberately omits rich_html. In that channel the captured card is
  // itself the placement witness; parser-local IDs never become source IDs.
  const light = !objects(message["blocks"]).some(b => b["type"] === "text" && typeof b["rich_html"] === "string");
  if (!light && (!ids.length || cards.length !== ids.length || new Set(ids).size !== ids.length)) return { cards: result };
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!, id = light ? `reading-card:${i}` : ids[i]!;
    const descriptor = light ? undefined : descriptors.get(id);
    if (!light && !descriptor) return { cards: new Map() };
    const kind = attr(card, "data-osis-native-card"), header = card.childNodes.find(n => "tagName" in n && n.tagName === "header");
    if (descriptor && descriptor["kind"] !== "published-artifact" && descriptor["kind"] !== kind) return { cards: new Map() };
    if (typeof descriptor?.["title"] === "string" && descriptor["title"] && (!header || !text(header as Tree.Element).startsWith(`${descriptor["title"]} ·`))) return { cards: new Map() };
    if (!has(card, "native-published-artifact")) continue;
    const files: JsonObject[] = [];
    for (const entry of elements(card).filter(n => has(n, "native-file-entry"))) {
      const head = elements(entry).find(n => has(n, "native-file-head"));
      const name = head?.childNodes.find(n => "tagName" in n && n.tagName === "span");
      const link = head && elements(head).find(n => n.tagName === "a" && attr(n, "download") !== undefined);
      const data = link && attr(link, "href");
      if (!name || !data?.startsWith("data:")) { files.length = 0; break; }
      files.push({ name: text(name as Tree.Element), data_url: data });
    }
    if (files.length) {
      result.set(id, { ...(descriptor ?? { title: header ? text(header as Tree.Element).replace(/ ·[^·]*$/u, "") : "" }), kind: kind!, files });
      card.attrs.push({ name: "data-osis-native-card-id", value: id });
    }
  }
  return { cards: result, readingHtml: serialize(tree) };
}
