import { html, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { JsonObject } from "../contracts/types.mts";

/** Existing HTML content, not a URL scheme or an additional record field. */
export const HTML_IMAGE_RESOURCE = "data-cloudig-resource";
export type HtmlResourceImage = Readonly<{
  id: string; alt: string; title?: string;
  start: number; end: number; attributeStart: number; attributeEnd: number;
}>;

export function blockHtml(value: JsonObject): string | undefined {
  if (typeof value["html"] === "string") return value["html"];
  return value["format"] === "html" && typeof value["text"] === "string" ? value["text"] : undefined;
}

/** Parse only actual HTML image attributes, never comments or escaped code. */
export function htmlResourceImages(source: string): HtmlResourceImage[] {
  if (!/data-cloudig-resource/iu.test(source)) return [];
  const result: HtmlResourceImage[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [parseFragment(source, { sourceCodeLocationInfo: true })];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === "img" && node.namespaceURI === html.NS.HTML) {
      const id = node.attrs.find(attribute => attribute.name === HTML_IMAGE_RESOURCE)?.value;
      const location = node.sourceCodeLocation, attribute = location?.attrs?.[HTML_IMAGE_RESOURCE];
      if (id !== undefined && location && attribute) {
        const title = node.attrs.find(attribute => attribute.name === "title")?.value;
        result.push({ id, alt: node.attrs.find(attribute => attribute.name === "alt")?.value ?? "", ...(title === undefined ? {} : { title }),
          start: location.startOffset, end: location.endOffset, attributeStart: attribute.startOffset, attributeEnd: attribute.endOffset });
      }
    }
    if ("childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
  }
  // HTML foster-parenting may move malformed table children in the parsed tree.
  // Offsets still describe the original string used by streaming export.
  return result.sort((a, b) => a.start - b.start);
}
