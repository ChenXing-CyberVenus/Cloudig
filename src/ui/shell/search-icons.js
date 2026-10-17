// Small, code-owned UI glyphs; these do not replace any of the author's artwork.
export function searchIcon(kind, tight = false) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // Entry buttons center the visible glyph, not a 24-unit artboard containing
  // different empty margins. Other search UI retains its existing glyph scale.
  const tightBounds = { title: "4 4 16 16", search: "2.5 2.5 19.5 19.5" };
  svg.setAttribute("viewBox", tight && tightBounds[kind] ? tightBounds[kind] : "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("cloudig-search-icon");
  const paths = {
    search: "M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16 16l5 5",
    title: "M5 5h14M12 5v14M8 19h8",
    close: "m6 6 12 12M6 18 18 6",
    open: "M13 5h6v6M19 5l-9 9M8 5H5v14h14v-3"
  };
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", paths[kind] ?? paths.search); svg.append(path); return svg;
}
