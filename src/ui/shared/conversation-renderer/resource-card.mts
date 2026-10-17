/** Shared visual identity for saved files and work entry points. No source reads. */
export function resourceKind(name: string, mime = ""): string {
  const extension = name.split(/[?#]/u)[0]!.split(".").pop()?.toLowerCase() ?? "";
  if (mime === "application/pdf" || extension === "pdf") return "PDF";
  if (/^(csv|xlsx?|ods)$/u.test(extension)) return extension.toUpperCase();
  if (/^(docx?|odt|rtf|md|txt)$/u.test(extension)) return extension.toUpperCase();
  if (/^(pptx?|odp)$/u.test(extension)) return extension.toUpperCase();
  if (/^(html?|jsx|tsx|js|ts|json|xml|py|css|svg)$/u.test(extension)) return extension.toUpperCase();
  if (/^(zip|7z|rar|tar|gz)$/u.test(extension)) return extension.toUpperCase();
  if (mime.startsWith("image/")) return extension.length < 6 ? extension.toUpperCase() : "IMG";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (mime.startsWith("video/")) return "VIDEO";
  return extension && extension.length <= 5 && /^[a-z0-9]+$/u.test(extension) ? extension.toUpperCase() : "FILE";
}
export function resourceSize(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
export function resourceIcon(document: Document, kind: string): SVGElement {
  const make = (tag: string, attributes: Record<string, string>) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) n.setAttribute(key, value); return n; };
  const svg = make("svg", { viewBox: "0 0 48 56", class: "cloudig-file-icon", "aria-hidden": "true" });
  svg.append(make("path", { d: "M9 3h21l11 11v35a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z", class: "cloudig-file-paper" }));
  svg.append(make("path", { d: "M30 3v9a3 3 0 0 0 3 3h8", class: "cloudig-file-fold" }));
  const mark = /HTML?|JSX|TSX|JS|TS|CSS|PY|JSON|XML|SVG/u.test(kind) ? "M17 23l-6 5 6 5m14-10 6 5-6 5m-5-12-4 15" : /CSV|XLS|ODS/u.test(kind) ? "M12 22h24v14H12Zm0 7h24m-16-7v14m8-14v14" : "M13 23h19m-19 6h22m-22 6h15";
  svg.append(make("path", { d: mark, class: "cloudig-file-mark" }));
  const label = make("text", { x: "24", y: "46", "text-anchor": "middle" }); label.textContent = kind; svg.append(label); return svg;
}
export function resourceActionIcon(document: Document, action: "save" | "open" | "source"): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", action === "save" ? "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" : action === "source" ? "m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18" : "M8 4h12v12M20 4 8 16M15 20H4V9"); svg.append(path); return svg;
}
