// Mechanical module copy of bookmarklets/vendor/osis-math-delimiters.js.
// The parity test requires an exact body match; never maintain separate rules here.
/* Single-dollar boundaries follow Pandoc tex_math_dollars; rendering stays with each exporter. */
function osisInlineDollarRanges(value) {
  const text = String(value ?? "");
  const ranges = [];
  if (!text.includes("$")) return ranges;
  const escaped = (index) => {
    let count = 0;
    while (index > 0 && text[--index] === "\\") count++;
    return count % 2 === 1;
  };
  for (let start = 0; start < text.length;) {
    if (text[start] === "\\" && !escaped(start) && /[([]/.test(text[start + 1] || "")) {
      const close = text[start + 1] === "(" ? "\\)" : "\\]";
      const end = text.indexOf(close, start + 2);
      if (end >= 0) { start = end + 2; continue; }
    }
    if (text[start] === "(" && text[start - 1] === "]" && !escaped(start)) {
      let end = start + 1, depth = 1;
      for (; end < text.length && depth; end++) {
        if (escaped(end)) continue;
        if (text[end] === "(") depth++;
        else if (text[end] === ")") depth--;
      }
      if (!depth) { start = end; continue; }
    }
    if (text[start] === "`" && !escaped(start)) {
      let width = 1;
      while (text[start + width] === "`") width++;
      const end = text.indexOf("`".repeat(width), start + width);
      start = end >= 0 ? end + width : start + width;
      continue;
    }
    if (text[start] !== "$" || escaped(start)) { start++; continue; }
    if (text[start + 1] === "$") {
      const end = text.indexOf("$$", start + 2);
      start = end >= 0 ? end + 2 : start + 2;
      continue;
    }
    if (!text[start + 1] || /\s/.test(text[start + 1])) { start++; continue; }
    let end = text.indexOf("$", start + 1);
    while (end >= 0 && escaped(end)) end = text.indexOf("$", end + 1);
    if (end < 0) break;
    const tex = text.slice(start + 1, end);
    if (tex && !/[\r\n\u0000`]/.test(tex) && !/\s/.test(text[end - 1])
      && !/[\d$]/.test(text[end + 1] || "") && text[end - 1] !== "$") {
      ranges.push({ start, end: end + 1, tex });
      start = end + 1;
    } else start++;
  }
  return ranges;
}

function osisReplaceInlineDollarMath(value, render) {
  const text = String(value ?? "");
  const parts = [];
  let cursor = 0;
  for (const range of osisInlineDollarRanges(text)) {
    parts.push(text.slice(cursor, range.start), render(range.tex, text.slice(range.start, range.end)));
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

export { osisInlineDollarRanges, osisReplaceInlineDollarMath };
