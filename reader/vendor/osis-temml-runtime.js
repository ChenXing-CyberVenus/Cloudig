/* AIChatArchive build-time runtime: render exact TeX to offline MathML and repair outer framed formulas. */
var osisTemmlVendorVersion = "0.13.3";
var osisTemmlCss = ".osis-temml{max-width:100%;font-family:math,\"STIX Two Math\",\"Cambria Math\",serif}.osis-temml-inline{display:inline-flex;margin:0 .12em;vertical-align:-.08em}.osis-temml-display{display:block;max-width:100%;overflow:auto hidden;margin:14px 0;text-align:center}.osis-temml math{font-size:1.08em}.osis-temml-display>math{margin:auto}.osis-temml-frame{display:inline-block;max-width:100%;padding:var(--osis-frame-padding,.18em .34em);border:var(--osis-frame-border,.065em solid currentColor);border-radius:.04em}.osis-temml-frame>math{display:inline-block;margin:0}.osis-temml-frame-color{background:var(--osis-frame-color,transparent)}.osis-temml-textbox-content{display:block;max-width:100%;font-family:ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;line-height:1.65;text-align:left;white-space:normal;overflow-wrap:anywhere}.osis-temml-textbox-content.osis-centered{text-align:center}.osis-temml-textbox-content code{font:.9em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.osis-temml-vspace{display:block;height:.5em}.osis-temml-small{font-size:.82em;color:inherit}.osis-menclose{display:inline-block;padding:.03em .09em}.osis-menclose-top{border-top:.065em solid currentColor}.osis-menclose-bottom{border-bottom:.065em solid currentColor}.osis-menclose-left{border-left:.065em solid currentColor}.osis-menclose-right{border-right:.065em solid currentColor}.osis-menclose-box{border:.065em solid currentColor}.osis-menclose-strike{text-decoration:line-through}";
osisTemmlCss += ".osis-temml-frame{overflow-wrap:anywhere}.osis-temml-tagged{display:grid;width:100%;max-width:100%;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:.8em}.osis-temml-tagged-body{min-width:0;max-width:100%;justify-self:center}.osis-temml-tag{justify-self:end;white-space:nowrap;font-size:.92em}@media(max-width:640px){.osis-temml-tagged{grid-template-columns:1fr;gap:.35em}.osis-temml-tag{justify-self:end}}";

function osisTemmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function osisTemmlStripDelimiters(value) {
  let source = String(value || "").trim();
  for (const [open, close] of [["\\[", "\\]"], ["\\(", "\\)"], ["$$", "$$"]]) {
    if (source.startsWith(open) && source.endsWith(close)) {
      source = source.slice(open.length, -close.length).trim();
      break;
    }
  }
  return source;
}

function osisTemmlBalancedGroup(source, start) {
  if (source[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (!depth) return { body: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function osisTemmlBalancedBracket(source, start) {
  if (source[start] !== "[") return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "[") depth += 1;
    if (source[index] === "]") {
      depth -= 1;
      if (!depth) return { body: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function osisTemmlOuterFrame(value) {
  const source = String(value || "").trim();
  for (const macro of ["\\boxed", "\\fbox"]) {
    if (!source.startsWith(macro)) continue;
    const group = osisTemmlBalancedGroup(source, macro.length);
    if (group && !source.slice(group.end).trim()) return { kind: macro.slice(1), body: group.body, color: "" };
  }
  if (source.startsWith("\\colorbox")) {
    const color = osisTemmlBalancedGroup(source, "\\colorbox".length);
    const body = color && osisTemmlBalancedGroup(source, color.end);
    if (color && body && !source.slice(body.end).trim()) return { kind: "colorbox", body: body.body, color: color.body.trim() };
  }
  if (source.startsWith("\\fcolorbox")) {
    const border = osisTemmlBalancedGroup(source, "\\fcolorbox".length);
    const background = border && osisTemmlBalancedGroup(source, border.end);
    const body = background && osisTemmlBalancedGroup(source, background.end);
    if (border && background && body && !source.slice(body.end).trim()) {
      return { kind: "fcolorbox", body: body.body, color: background.body.trim(), borderColor: border.body.trim() };
    }
  }
  if (source.startsWith("\\bbox")) {
    const options = osisTemmlBalancedBracket(source, "\\bbox".length);
    const body = osisTemmlBalancedGroup(source, options?.end || "\\bbox".length);
    if (body && !source.slice(body.end).trim()) return { kind: "bbox", body: body.body, color: options?.body?.trim() || "" };
  }
  return null;
}

function osisTemmlFrameChain(value) {
  const frames = [];
  let body = String(value || "").trim();
  for (let depth = 0; depth < 8; depth += 1) {
    const frame = osisTemmlOuterFrame(body);
    if (!frame) break;
    frames.push(frame);
    body = String(frame.body || "").trim();
  }
  return { frames, body };
}

function osisTemmlTrailingTag(value) {
  const source = String(value || "").trim();
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\") {
      if (!depth && source.startsWith("\\tag", index) && !/[A-Za-z]/.test(source[index + 4] || "")) {
        let cursor = index + 4;
        const starred = source[cursor] === "*";
        if (starred) cursor += 1;
        while (/\s/.test(source[cursor] || "")) cursor += 1;
        const group = osisTemmlBalancedGroup(source, cursor);
        if (group && !source.slice(group.end).trim()) {
          return { body: source.slice(0, index).trim(), label: group.body, starred };
        }
      }
      index += 1;
      continue;
    }
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth = Math.max(0, depth - 1);
  }
  return null;
}

function osisTemmlSafeColor(value) {
  const color = String(value || "").trim();
  return /^(?:[a-z]{3,20}|#[0-9a-f]{3,8})$/i.test(color) ? color : "";
}

function osisTemmlXColor(value) {
  const source = String(value || "").trim();
  const direct = osisTemmlSafeColor(source);
  if (direct && !source.includes("!")) return direct;
  const match = source.match(/^(black|white|gray|grey|red|green|blue|yellow|orange|purple)!(\d{1,3})$/i);
  if (!match) return "";
  const palette = {
    black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128],
    red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
    orange: [255, 165, 0], purple: [128, 0, 128]
  };
  const ratio = Math.max(0, Math.min(100, Number(match[2]))) / 100;
  const rgb = palette[match[1].toLowerCase()].map((channel) => Math.round(255 + (channel - 255) * ratio));
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function osisTemmlBboxStyle(value) {
  const source = String(value || "").trim();
  const parts = source.split(",").map((part) => part.trim()).filter(Boolean);
  let background = "";
  let border = "0";
  let padding = ".18em .34em";
  for (const part of parts) {
    const color = osisTemmlSafeColor(part.replace(/^background(?:-color)?\s*:\s*/i, ""));
    if (color && (!part.includes(":") || /^background(?:-color)?\s*:/i.test(part))) {
      background = color;
      continue;
    }
    const borderMatch = part.match(/^border\s*:\s*(\d+(?:\.\d+)?(?:px|em|rem))\s+(solid|dashed|dotted|double)\s+([a-z]{3,20}|#[0-9a-f]{3,8})$/i);
    if (borderMatch && osisTemmlSafeColor(borderMatch[3])) {
      border = `${borderMatch[1]} ${borderMatch[2].toLowerCase()} ${borderMatch[3]}`;
      continue;
    }
    const paddingMatch = part.match(/^(?:padding\s*:\s*)?(\d+(?:\.\d+)?(?:px|em|rem))$/i);
    if (paddingMatch) padding = paddingMatch[1];
  }
  return { background, border, padding };
}

function osisTemmlRepairUnicodeControlSymbols(value) {
  // A few chat renderers serialize literal Unicode glyphs as if they were TeX
  // control symbols (for example `\\☁`).  TeX control words are ASCII; keep
  // the glyph and remove only that impossible leading backslash.
  return String(value || "").replace(/\\([^\x00-\x7f])/gu, "$1");
}

function osisTemmlRepairMenclose(markup) {
  let output = String(markup || "");
  const innermost = /<menclose\b([^>]*)>((?:(?!<menclose\b)[\s\S])*?)<\/menclose>/gi;
  for (let pass = 0; pass < 12 && /<menclose\b/i.test(output); pass += 1) {
    output = output.replace(innermost, (_whole, attributes, inner) => {
      const notation = String(attributes.match(/\bnotation=(?:"([^"]*)"|'([^']*)')/i)?.[1]
        || attributes.match(/\bnotation=(?:"([^"]*)"|'([^']*)')/i)?.[2]
        || "longdiv").toLowerCase();
      const sourceClass = String(attributes.match(/\bclass=(?:"([^"]*)"|'([^']*)')/i)?.[1]
        || attributes.match(/\bclass=(?:"([^"]*)"|'([^']*)')/i)?.[2]
        || "").trim();
      const tokens = notation.split(/\s+/).filter(Boolean);
      const classes = ["osis-menclose", sourceClass];
      if (tokens.some((token) => ["top", "longdiv", "actuarial", "roundedbox", "circle", "box"].includes(token))) classes.push("osis-menclose-top");
      if (tokens.some((token) => ["bottom", "roundedbox", "circle", "box"].includes(token))) classes.push("osis-menclose-bottom");
      if (tokens.some((token) => ["left", "actuarial", "roundedbox", "circle", "box"].includes(token))) classes.push("osis-menclose-left");
      if (tokens.some((token) => ["right", "longdiv", "roundedbox", "circle", "box"].includes(token))) classes.push("osis-menclose-right");
      if (tokens.some((token) => ["box", "roundedbox", "circle"].includes(token))) classes.push("osis-menclose-box");
      if (tokens.some((token) => token.includes("strike"))) classes.push("osis-menclose-strike");
      return `<mrow class="${osisTemmlEscape(classes.filter(Boolean).join(" "))}" data-osis-menclose="${osisTemmlEscape(notation)}">${inner}</mrow>`;
    });
  }
  return output;
}

function osisTemmlUnwrapTextContainer(value, frameKind = "") {
  const source = String(value || "").trim();
  if (source.startsWith("\\begin{minipage}")) {
    const width = osisTemmlBalancedGroup(source, "\\begin{minipage}".length);
    const suffix = "\\end{minipage}";
    if (width && source.endsWith(suffix)) return { body: source.slice(width.end, -suffix.length).trim(), centered: /\\centering\b/.test(source) };
  }
  if (source.startsWith("\\parbox")) {
    const width = osisTemmlBalancedGroup(source, "\\parbox".length);
    const body = width && osisTemmlBalancedGroup(source, width.end);
    if (width && body && !source.slice(body.end).trim()) return { body: body.body.trim(), centered: /\\centering\b/.test(body.body) };
  }
  if (frameKind === "fcolorbox" && /^\\text(?:bf|it|tt)?\s*\{/.test(source)) return { body: source, centered: false };
  return null;
}

function osisTemmlPureTextFrame(value) {
  const source = String(value || "").trim();
  let index = 0;
  let textGroups = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === "\\" && source[index + 1] === "\\") {
      index += 2;
      while (/\s/.test(source[index] || "")) index += 1;
      if (source[index] === "[") index = osisTemmlBalancedBracket(source, index)?.end || index;
      continue;
    }
    const macroMatch = source.slice(index).match(/^\\(textbf|textit|emph|texttt|text|vspace|centering|raggedright|raggedleft|quad|qquad)\b/);
    if (!macroMatch) return null;
    const macro = macroMatch[1];
    index += macroMatch[0].length;
    if (["centering", "raggedright", "raggedleft", "quad", "qquad"].includes(macro)) continue;
    while (/\s/.test(source[index] || "")) index += 1;
    const group = osisTemmlBalancedGroup(source, index);
    if (!group) return null;
    index = group.end;
    if (["textbf", "textit", "emph", "texttt", "text"].includes(macro)) textGroups += 1;
  }
  return textGroups ? { body: source, centered: true } : null;
}

function osisTemmlTextMarkup(value) {
  const source = String(value || "").replace(/\r\n?/g, "\n");
  const scriptsize = source.indexOf("\\scriptsize");
  if (scriptsize >= 0) {
    const before = osisTemmlTextMarkup(source.slice(0, scriptsize));
    const after = osisTemmlTextMarkup(source.slice(scriptsize + "\\scriptsize".length));
    return `${before}<small class="osis-temml-small">${after}</small>`;
  }
  let output = "";
  for (let index = 0; index < source.length;) {
    if (source[index] === "\\" && source[index + 1] === "\\") {
      index += 2;
      if (source[index] === "[") index = osisTemmlBalancedBracket(source, index)?.end || index;
      output += "<br>";
      continue;
    }
    if (source[index] === "\\") {
      const macroMatch = source.slice(index).match(/^\\(textbf|textit|emph|texttt|text|vspace|centering|raggedright|raggedleft|quad|qquad)\b/);
      if (macroMatch) {
        const macro = macroMatch[1];
        index += macroMatch[0].length;
        if (["centering", "raggedright", "raggedleft"].includes(macro)) continue;
        if (["quad", "qquad"].includes(macro)) {
          output += macro === "qquad" ? "&emsp;&emsp;" : "&emsp;";
          continue;
        }
        const group = osisTemmlBalancedGroup(source, index);
        if (group) {
          index = group.end;
          if (macro === "vspace") output += '<span class="osis-temml-vspace"></span>';
          else {
            const inner = osisTemmlTextMarkup(group.body);
            output += macro === "textbf" ? `<strong>${inner}</strong>`
              : ["textit", "emph"].includes(macro) ? `<em>${inner}</em>`
                : macro === "texttt" ? `<code>${inner}</code>` : inner;
          }
          continue;
        }
      }
      if (/[%#_&{}$]/.test(source[index + 1] || "")) {
        output += osisTemmlEscape(source[index + 1]);
        index += 2;
        continue;
      }
    }
    if (source[index] === "`" && source.indexOf("`", index + 1) > index) {
      const end = source.indexOf("`", index + 1);
      output += `<code>${osisTemmlEscape(source.slice(index + 1, end))}</code>`;
      index = end + 1;
      continue;
    }
    if (source[index] === "\n") {
      output += "<br>";
      index += 1;
      continue;
    }
    output += osisTemmlEscape(source[index]);
    index += 1;
  }
  return output.replace(/(?:<br>\s*){3,}/g, "<br><br>");
}

function osisRenderTemmlHtml(value, display = false, options = {}) {
  const original = osisTemmlStripDelimiters(value);
  if (!original) return "";
  const platformNormalized = typeof options.normalize === "function" ? String(options.normalize(original) || original) : original;
  const normalized = osisTemmlRepairUnicodeControlSymbols(platformNormalized);
  const trailingTag = options.repairTaggedFrames ? osisTemmlTrailingTag(normalized) : null;
  const taggedBody = trailingTag?.body || normalized;
  const firstFrame = osisTemmlOuterFrame(taggedBody);
  const frameChain = options.repairNestedFrames
    ? osisTemmlFrameChain(taggedBody)
    : { frames: firstFrame ? [firstFrame] : [], body: firstFrame?.body || taggedBody };
  const frames = frameChain.frames;
  const renderSource = frames.length ? frameChain.body : (trailingTag?.body || normalized);
  const innermostFrame = frames.at(-1);
  const textContainer = frames.length
    ? osisTemmlUnwrapTextContainer(renderSource, innermostFrame.kind)
      || (options.repairTextFrames ? osisTemmlPureTextFrame(renderSource) : null)
    : null;
  const mathml = textContainer ? `<span class="osis-temml-textbox-content${textContainer.centered ? " osis-centered" : ""}">${osisTemmlTextMarkup(textContainer.body)}</span>`
    : osisTemmlRepairMenclose(temml.renderToString(renderSource, {
      displayMode: Boolean(display),
      annotate: true,
      xml: true,
      trust: false,
      strict: false,
      throwOnError: true,
      maxExpand: 1_000,
      maxSize: [30, 72]
    }));
  const tag = display ? "div" : "span";
  const classes = display ? "osis-math osis-temml osis-temml-display" : "osis-math osis-temml osis-temml-inline";
  let body = mathml;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    const bbox = frame.kind === "bbox" ? osisTemmlBboxStyle(frame.color) : null;
    const safeColor = bbox?.background || (frame.kind === "fcolorbox" ? osisTemmlXColor(frame.color) : frame.kind === "colorbox" ? osisTemmlSafeColor(frame.color) : "");
    const borderColor = frame.kind === "fcolorbox" ? osisTemmlXColor(frame.borderColor) : "";
    const frameClass = safeColor ? "osis-temml-frame osis-temml-frame-color" : "osis-temml-frame";
    const styles = [];
    if (safeColor) styles.push(`--osis-frame-color:${safeColor}`);
    if (borderColor) styles.push(`--osis-frame-border:1px solid ${borderColor}`);
    if (bbox) styles.push(`--osis-frame-border:${bbox.border}`, `--osis-frame-padding:${bbox.padding}`);
    const style = styles.length ? ` style="${osisTemmlEscape(styles.join(";"))}"` : "";
    body = `<span class="${frameClass}" data-frame-kind="${osisTemmlEscape(frame.kind)}"${style}>${body}</span>`;
  }
  if (trailingTag) {
    const tagBody = osisTemmlTextMarkup(trailingTag.label);
    const label = trailingTag.starred ? tagBody : `(${tagBody})`;
    body = `<span class="osis-temml-tagged" data-osis-tag-starred="${trailingTag.starred ? "1" : "0"}"><span class="osis-temml-tagged-body">${body}</span><span class="osis-temml-tag">${label}</span></span>`;
  }
  const renderedSource = normalized !== original ? ` data-render-tex="${osisTemmlEscape(normalized)}"` : "";
  return `<${tag} class="${classes}" data-tex="${osisTemmlEscape(original)}"${renderedSource} data-math-display="${display ? "block" : "inline"}" role="math" aria-label="数学公式：${osisTemmlEscape(original)}">${body}</${tag}>`;
}

function osisCreateTemmlArchiveNode(value, display = false, options = {}) {
  const template = document.createElement("template");
  template.innerHTML = osisRenderTemmlHtml(value, display, options);
  return template.content.firstElementChild;
}
