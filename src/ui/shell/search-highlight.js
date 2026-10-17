// Search uses NFKC + case folding. Keep a map back to original graphemes so
// compatibility characters and combining marks are highlighted without rewriting text.
const normalize = value => value.normalize("NFKC").toLocaleLowerCase("und");
const segments = new Intl.Segmenter("und", { granularity: "grapheme" });
export const SEARCH_HIGHLIGHT_LIMIT = 1000; // decoration only; never limits search or message content
export function searchMatchRanges(text, query, limit = SEARCH_HIGHLIGHT_LIMIT) {
  const needle = normalize(query); if (!needle) return [];
  let folded = ""; const positions = [];
  for (const { segment, index } of segments.segment(text)) {
    const value = normalize(segment); folded += value;
    for (let i = 0; i < value.length; i++) positions.push([index, index + segment.length]);
  }
  const matches = [];
  for (let at = folded.indexOf(needle); at !== -1 && matches.length < limit; at = folded.indexOf(needle, at + needle.length)) {
    const start = positions[at][0], end = positions[at + needle.length - 1][1], previous = matches.at(-1);
    if (previous && previous[1] >= start) previous[1] = Math.max(previous[1], end); else matches.push([start, end]);
  }
  return matches;
}

export function appendHighlightedText(node, text, query) {
  const doc = node.ownerDocument; let cursor = 0;
  for (const [start, end] of searchMatchRanges(text, query)) {
    node.append(doc.createTextNode(text.slice(cursor, start)));
    const mark = doc.createElement("mark"); mark.className = "cloudig-search-match"; mark.textContent = text.slice(start, end); node.append(mark); cursor = end;
  }
  node.append(doc.createTextNode(text.slice(cursor)));
}

/** CSS ranges decorate rich text without changing its Markdown/links/code/math DOM. */
export function highlightSearchPreview(root, query) {
  const doc = root.ownerDocument, win = doc.defaultView;
  if (!win.CSS?.highlights || !win.Highlight) return () => {};
  const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT), groups = new Map();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('button,script,style,textarea,svg,math,.katex,[hidden],iframe')) continue;
    const block = parent.closest("p,li,pre,td,th,h1,h2,h3,h4,h5,h6,summary,blockquote,div") ?? root;
    if (!groups.has(block)) groups.set(block, []); groups.get(block).push(node);
  }
  const ranges = [];
  for (const nodes of groups.values()) {
    const text = nodes.map(node => node.data).join("");
    for (const [start, end] of searchMatchRanges(text, query, SEARCH_HIGHLIGHT_LIMIT - ranges.length)) {
      const range = doc.createRange(); let offset = 0;
      for (const node of nodes) {
        const after = offset + node.length;
        if (start >= offset && start < after) range.setStart(node, start - offset);
        if (end > offset && end <= after) { range.setEnd(node, end - offset); break; }
        offset = after;
      }
      ranges.push(range);
    }
    if (ranges.length >= SEARCH_HIGHLIGHT_LIMIT) break;
  }
  const highlight = new win.Highlight(...ranges), name = "cloudig-search-hit";
  win.CSS.highlights.set(name, highlight);
  return () => { if (win.CSS.highlights.get(name) === highlight) win.CSS.highlights.delete(name); };
}
