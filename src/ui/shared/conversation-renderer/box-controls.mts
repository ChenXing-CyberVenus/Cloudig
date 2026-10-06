import type { JsonObject, JsonValue } from "../../../core/contracts/types.mts";
import { isJsonObject } from "../../../core/contracts/types.mts";

export const boxText = (value: JsonValue | undefined): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
export const boxObject = (value: JsonValue | undefined): JsonObject => isJsonObject(value) ? value : {};
export const boxList = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];
export const boxStrings = (value: JsonValue | undefined): string[] => Array.isArray(value) ? value.flatMap(v => typeof v === "string" ? [v] : []) : [];
export type BoxContext = Readonly<{
  document: Document;
  language: "zh" | "en";
  signal: AbortSignal;
  image: (path: string, alt: string) => HTMLElement;
  /** Optional dedicated-origin harness URL; never read from saved card data. */
  mapFrameUrl?: string;
  /** Only the public site's built-in map UI, never an authored work. */
  mapSameOrigin?: boolean;
  onOpenExternal?: (url: string) => void;
}>;
export const boxLabel = (ctx: BoxContext, zh: string, en: string): string => ctx.language === "en" ? en : zh;

export function boxElement<K extends keyof HTMLElementTagNameMap>(ctx: BoxContext, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = ctx.document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function boxButton(ctx: BoxContext, label: string, action: () => void, className = "cloudig-box-button"): HTMLButtonElement {
  const button = boxElement(ctx, "button", className, label); button.type = "button";
  // A removed/replaced reader cannot run old actions or start a new timer.
  button.addEventListener("click", () => { if (!ctx.signal.aborted) action(); });
  return button;
}
export function boxParagraph(ctx: BoxContext, text: string, muted = false): HTMLElement {
  return boxElement(ctx, "p", muted ? "cloudig-box-muted" : "cloudig-box-text", text);
}
export function boxHeading(ctx: BoxContext, title: string): HTMLElement { return boxElement(ctx, "h3", "cloudig-box-heading", title); }
export function boxTabs(ctx: BoxContext, labels: readonly string[], current: number, select: (index: number) => void): HTMLElement {
  const tabs = boxElement(ctx, "div", "cloudig-box-tabs"); tabs.setAttribute("role", "group");
  for (const [index, label] of labels.entries()) {
    const tab = boxButton(ctx, label, () => select(index)); tab.setAttribute("aria-pressed", String(index === current)); tabs.append(tab);
  }
  return tabs;
}
export function boxPager(ctx: BoxContext, length: number, current: number, change: (index: number) => void, nextEnabled = true): HTMLElement {
  const footer = boxElement(ctx, "div", "cloudig-box-pager");
  const previous = boxButton(ctx, boxLabel(ctx, "上一项", "Previous"), () => change(current - 1)); previous.disabled = current === 0;
  const next = boxButton(ctx, boxLabel(ctx, "下一项", "Next"), () => change(current + 1)); next.disabled = current >= length - 1 || !nextEnabled;
  const count = boxElement(ctx, "span", "cloudig-box-muted", `${current + 1} / ${length}`); count.setAttribute("aria-live", "polite");
  footer.append(previous, count, next); return footer;
}
export function boxNumberPager(ctx: BoxContext, length: number, current: number, change: (index: number) => void, nextEnabled = true): HTMLElement {
  const footer = boxElement(ctx, "div", "cloudig-box-pager"), numbers = boxElement(ctx, "div", "cloudig-box-page-numbers");
  for (let n = 0; n < length; n++) {
    const page = boxButton(ctx, String(n + 1), () => change(n), "cloudig-box-page-number");
    page.setAttribute("aria-label", `${boxLabel(ctx, "第", "Page ")}${n + 1}${boxLabel(ctx, "项", "")}`);
    page.setAttribute("aria-current", n === current ? "step" : "false"); numbers.append(page);
  }
  const next = boxButton(ctx, boxLabel(ctx, "下一项", "Next"), () => change(current + 1), "cloudig-box-button cloudig-box-primary"); next.disabled = current >= length - 1 || !nextEnabled;
  footer.append(numbers, next); return footer;
}
export function boxLink(ctx: BoxContext, title: string, url: string): HTMLElement {
  if (!/^https?:\/\//iu.test(url)) return boxElement(ctx, "span", "", title);
  const a = boxElement(ctx, "a", "cloudig-source-link", title); a.href = url; a.rel = "noopener noreferrer"; a.dataset["cloudigExternal"] = "true"; return a;
}
export function boxCopy(ctx: BoxContext, value: () => string): HTMLButtonElement {
  const button = boxButton(ctx, boxLabel(ctx, "复制", "Copy"), () => {
    const clipboard = ctx.document.defaultView?.navigator.clipboard;
    if (!clipboard?.writeText) { button.textContent = boxLabel(ctx, "请选中文字复制", "Select text to copy"); return; }
    void clipboard.writeText(value()).then(() => {
      if (!ctx.signal.aborted) button.textContent = boxLabel(ctx, "已复制", "Copied");
    }).catch(() => { if (!ctx.signal.aborted) button.textContent = boxLabel(ctx, "请选中文字复制", "Select text to copy"); });
  });
  return button;
}
export function boxImages(ctx: BoxContext, paths: readonly string[], title: string): HTMLElement | undefined {
  const available = paths.filter(path => path.length > 0);
  if (!available.length) return;
  const gallery = boxElement(ctx, "div", "cloudig-box-images"), stage = boxElement(ctx, "div", "cloudig-gallery-stage");
  gallery.dataset["imageCount"] = String(available.length); gallery.append(stage);
  const pageSize = 3, pages = Math.ceil(available.length / pageSize);
  const loaded = new Map<number, HTMLElement>(); let current = 0;
  const counter = boxElement(ctx, "span", "cloudig-gallery-count"); counter.setAttribute("aria-live", "polite");
  const previous = boxButton(ctx, "‹", () => show(current - 1), "cloudig-gallery-arrow"), next = boxButton(ctx, "›", () => show(current + 1), "cloudig-gallery-arrow");
  previous.setAttribute("aria-label", boxLabel(ctx, "上一页图片", "Previous images")); next.setAttribute("aria-label", boxLabel(ctx, "下一页图片", "Next images"));
  function show(page: number): void {
    if (ctx.signal.aborted || page < 0 || page >= pages) return;
    current = page;
    const first = page * pageSize, end = Math.min(first + pageSize, available.length), images: HTMLElement[] = [];
    for (let index = first; index < end; index++) {
      let image = loaded.get(index);
      if (!image) { image = ctx.image(available[index]!, title); loaded.set(index, image); }
      images.push(image);
    }
    stage.dataset["visibleCount"] = String(images.length);
    stage.replaceChildren(...images); counter.textContent = `${first + 1}${end > first + 1 ? `–${end}` : ""} / ${available.length}`;
    previous.disabled = page === 0; next.disabled = page === pages - 1;
  }
  if (pages > 1) {
    const controls = boxElement(ctx, "div", "cloudig-gallery-controls"); controls.append(previous, counter, next); gallery.append(controls);
    gallery.tabIndex = 0; gallery.setAttribute("aria-label", title || boxLabel(ctx,"图片","Images"));
    gallery.addEventListener("keydown", event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); show(current + (event.key === "ArrowLeft" ? -1 : 1)); } });
  }
  show(0);
  return gallery;
}
