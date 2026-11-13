import { inertStandaloneSvg } from "../../../adapters/parser/inert-html.mts";
const originals = new WeakMap<HTMLImageElement, { svg: SVGSVGElement; inheritsColor: boolean }>();

export function updateCapturedSvgTheme(root: HTMLElement, theme: string): void {
  for (const image of root.querySelectorAll<HTMLImageElement>("img.cloudig-captured-svg")) {
    const item = originals.get(image); if (!item) continue;
    item.svg.style.colorScheme = theme === "star-night" ? "dark" : "light";
    const host = image.closest(".cloudig-conversation-renderer") ?? root.ownerDocument.querySelector(".cloudig-conversation-renderer");
    if (item.inheritsColor && host) item.svg.style.color = root.ownerDocument.defaultView!.getComputedStyle(host).color;
    const source = inertStandaloneSvg(item.svg.outerHTML);
    if (source) image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  }
}

/** Static source graphics own their styles, IDs and paint servers. Replay as
 * SVG images so the shell CSP doesn't discard style elements, and a graphic's
 * selectors cannot restyle the conversation or collide with a second graphic. */
export function hydrateCapturedSvg(root: HTMLElement, theme = root.ownerDocument.documentElement.dataset["theme"] ?? "dawn"): void {
  const document = root.ownerDocument;
  for (const svg of root.querySelectorAll<SVGSVGElement>("svg")) {
    if (svg.parentElement?.closest("svg")) continue;
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const inheritsColor = !copy.style.color;
    const dark = theme === "star-night";
    copy.style.colorScheme = dark ? "dark" : "light";
    const host = document.querySelector(".cloudig-conversation-renderer");
    if (!copy.style.color && host) copy.style.color = document.defaultView!.getComputedStyle(host).color;
    const view = copy.getAttribute("viewBox")?.trim().split(/[\s,]+/u).map(Number);
    const natural = view?.length === 4 && view.every(Number.isFinite) && view[2]! > 0 && view[3]! > 0 ? view : undefined;
    if (natural) {
      if (!/^\d+(?:\.\d+)?(?:px)?$/u.test(copy.getAttribute("width") ?? "")) copy.setAttribute("width", String(natural[2]));
      if (!/^\d+(?:\.\d+)?(?:px)?$/u.test(copy.getAttribute("height") ?? "")) copy.setAttribute("height", String(natural[3]));
    }
    const source = inertStandaloneSvg(copy.outerHTML); if (!source) continue;
    const image = document.createElement("img"); image.className = "cloudig-captured-svg";
    image.alt = svg.getAttribute("aria-label") ?? svg.querySelector(":scope > title")?.textContent ?? "";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    for (const attribute of ["width", "height"] as const) {
      const size = copy.getAttribute(attribute); if (size && /^\d+(?:\.\d+)?(?:px)?$/u.test(size)) image.setAttribute(attribute, size.replace(/px$/u, ""));
    }
    // Retain explicit inline size, but never stretch a small icon to page width.
    image.style.maxWidth = "100%"; image.style.height = "auto";
    if (svg.style.width) image.style.width = svg.style.width;
    image.style.verticalAlign = "middle";
    originals.set(image, { svg: copy, inheritsColor });
    svg.replaceWith(image);
  }
}
