import type { JsonObject, JsonValue } from "../../../core/contracts/types.mts";
import { isJsonObject } from "../../../core/contracts/types.mts";
import { NATIVE_LAYOUT_TAGS, nativeLayoutStyle } from "../../../core/records/native-layout.mts";
import { boxCopy, boxElement, boxLink, type BoxContext } from "./box-controls.mts";

function neutralSurface(node: HTMLElement): void {
  if (node.style.color) return; // Explicit author foreground always wins.
  const paint = node.style.backgroundColor.trim().toLowerCase();
  const channels = paint === "white" ? [255,255,255] : paint === "black" ? [0,0,0]
    : /^rgba?\(/u.test(paint) ? paint.match(/[\d.]+/gu)?.map(Number) : undefined;
  if (!channels || channels.length < 3 || (channels.length > 3 && channels[3]! < .8)) return;
  const [r,g,b] = channels;
  // Only fixed neutral paper needs a text-theme boundary. Semantic var()
  // surfaces inherit Cloudig's theme; original coloured artwork stays intact.
  if (Math.max(r!,g!,b!) - Math.min(r!,g!,b!) > 10) return;
  const linear = (v: number) => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4;
  const luminance = (a: readonly number[]) => .2126 * linear(a[0]!) + .7152 * linear(a[1]!) + .0722 * linear(a[2]!);
  const surface = luminance([r!,g!,b!]), darkInk = luminance([41,36,38]), lightInk = luminance([231,226,227]);
  const contrast = (ink: number) => (Math.max(surface,ink)+.05)/(Math.min(surface,ink)+.05);
  const light = contrast(darkInk) >= contrast(lightInk);
  node.style.color = light ? "#292426" : "#e7e2e3";
  node.style.setProperty("--muted", light ? "#786d70" : "#aaa1a4");
  node.style.setProperty("--faint", light ? "#786d70" : "#aaa1a4");
  node.style.setProperty("--text", light ? "#292426" : "#e7e2e3");
}

export function nativeLayoutBox(ctx: BoxContext, data: JsonObject): HTMLElement {
  const root = boxElement(ctx, "section", "cloudig-box cloudig-native-layout");
  function append(parent: HTMLElement, values: JsonValue | undefined): void {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value === "string") { parent.append(ctx.document.createTextNode(value)); continue; }
      if (!isJsonObject(value)) continue;
      const raw = value["tag"], tag = typeof raw === "string" && NATIVE_LAYOUT_TAGS.has(raw) ? raw : "span";
      let node: HTMLElement;
      if (raw === "icon" && typeof value["path"] === "string") {
        node = ctx.image(value["path"], "", value["tone"] === "current" ? "current" : undefined); node.classList.add("cloudig-native-icon-image"); parent.append(node); continue;
      }
      if (tag === "button" && typeof value["copy"] === "string") {
        node = boxCopy(ctx, () => String(value["copy"])); node.replaceChildren(); node.classList.add("cloudig-native-copy");
      } else if (tag === "a" && typeof value["href"] === "string") node = boxLink(ctx, "", value["href"]);
      else node = ctx.document.createElement(tag === "button" || tag === "a" ? "span" : tag);
      if (typeof value["component"] === "string") node.dataset["nativeComponent"] = value["component"];
      if (typeof value["label"] === "string") node.setAttribute("aria-label", value["label"]);
      if (isJsonObject(value["style"])) for (const [property, v] of Object.entries(value["style"])) {
        if (typeof v === "string" && nativeLayoutStyle(property, v)) node.style.setProperty(property, v);
      }
      neutralSurface(node);
      append(node, value["children"]); parent.append(node);
    }
  }
  append(root, data["layout"]); return root;
}
