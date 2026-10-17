import { serializeOuter, type DefaultTreeAdapterTypes as Tree } from "parse5";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { NATIVE_LAYOUT_TAGS, nativeLayoutStyle } from "../../core/records/native-layout.mts";
import { inertStandaloneSvg } from "./inert-html.mts";

const attr = (node: Tree.Element, name: string) => node.attrs.find(a => a.name === name)?.value;
export const isChatGptNative = (node: Tree.Element): boolean => !!attr(node, "data-osis-native-component");

/** Consume the saved native layout, not JSX/onclick code. The only action is
 * a literal copy value already identified by the exporter. SVGs become normal
 * Conversation resources; no remote libraries or application runtime needed. */
export function chatGptNative(node: Tree.Element, image: (svg: string) => string): JsonObject {
  const files: JsonObject[] = [];
  function project(child: Tree.ChildNode): JsonValue[] {
    if ("value" in child) return [child.value];
    if (!("tagName" in child) || ["script", "style", "template", "iframe", "object", "embed"].includes(child.tagName)) return [];
    if (child.tagName === "svg") {
      const svg = inertStandaloneSvg(serializeOuter(child)); if (!svg) return [];
      const path = `icons/${files.length + 1}.svg`; files.push({ path, resource: image(svg) });
      const colors = [...svg.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/giu)];
      // Captured semantic icons carry computed light-theme neutral paint.
      // Keep coloured artwork intact; neutral currentColor glyphs use the
      // local text colour through their original alpha mask in either theme.
      const neutral = /currentColor/iu.test(svg) && colors.every(c => c[1] === c[2] && c[2] === c[3])
        && !/#[0-9a-f]{3,8}\b/iu.test(svg);
      return [{ tag: "icon", path, ...(neutral ? { tone: "current" } : {}) }];
    }
    const tag = NATIVE_LAYOUT_TAGS.has(child.tagName) ? child.tagName : "span";
    const style: JsonObject = {};
    for (const declaration of (attr(child, "style") ?? "").split(";")) {
      const colon = declaration.indexOf(":"); if (colon < 0) continue;
      const key = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim();
      if (nativeLayoutStyle(key, value)) style[key] = value;
    }
    const copy = attr(child, "data-osis-copy"), href = attr(child, "href"), label = attr(child, "aria-label"), component = attr(child, "data-osis-native-component");
    return [{ tag, ...(component ? { component } : {}), ...(label ? { label } : {}),
      ...(Object.keys(style).length ? { style } : {}), ...(tag === "button" && copy !== undefined ? { copy } : {}),
      ...(tag === "a" && /^https?:\/\//iu.test(href ?? "") ? { href: href! } : {}), children: child.childNodes.flatMap(project) }];
  }
  const layout = project(node);
  return { type: "interactive", source: "chatgpt.com_genui", display: "box", format: "structured", data: { layout }, ...(files.length ? { files } : {}) };
}
