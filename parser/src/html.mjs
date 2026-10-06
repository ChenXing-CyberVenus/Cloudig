const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr"
]);

const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
  "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul"
]);

const NAMED_ENTITIES = new Map([
  ["amp", "&"], ["apos", "'"], ["gt", ">"], ["lt", "<"], ["quot", "\""],
  ["nbsp", " "], ["ensp", " "], ["emsp", " "], ["thinsp", " "],
  ["hellip", "…"], ["mdash", "—"], ["ndash", "–"], ["laquo", "«"],
  ["raquo", "»"], ["copy", "©"], ["reg", "®"], ["trade", "™"],
  ["times", "×"], ["divide", "÷"], ["middot", "·"], ["minus", "−"]
]);

export function decodeHtmlEntities(value) {
  return String(value ?? "").replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/giu,
    (whole, decimal, hexadecimal, named) => {
      if (decimal) {
        const codePoint = Number.parseInt(decimal, 10);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : whole;
      }
      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : whole;
      }
      return NAMED_ENTITIES.get(String(named).toLowerCase()) ?? whole;
    }
  );
}

export function parseAttributes(raw) {
  const result = {};
  const source = String(raw ?? "");
  let cursor = 0;
  while (cursor < source.length) {
    while (
      cursor < source.length
      && (/\s/u.test(source[cursor]) || source[cursor] === "/" || source[cursor] === ">")
    ) {
      cursor += 1;
    }
    if (cursor >= source.length) break;
    if (source[cursor] === "=") {
      cursor += 1;
      continue;
    }

    const nameStart = cursor;
    while (
      cursor < source.length
      && !/\s/u.test(source[cursor])
      && source[cursor] !== "="
      && source[cursor] !== "/"
      && source[cursor] !== ">"
    ) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;

    let value = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
      const quote = source[cursor] === "\"" || source[cursor] === "'" ? source[cursor] : null;
      if (quote) {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) cursor += 1;
        value = source.slice(valueStart, cursor);
        if (source[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (
          cursor < source.length
          && !/\s/u.test(source[cursor])
          && !["\"", "'", "=", "<", ">", "`"].includes(source[cursor])
        ) {
          cursor += 1;
        }
        value = source.slice(valueStart, cursor);
      }
    }
    result[name] = decodeHtmlEntities(value);
  }
  return result;
}

export function scanHtmlTags(html) {
  const source = String(html ?? "");
  const tags = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const close = source.indexOf("-->", start + 4);
      const end = close < 0 ? source.length : close + 3;
      tags.push({ start, end, raw: source.slice(start, end), comment: true });
      cursor = Math.max(end, start + 1);
      continue;
    }
    const lead = source[start + 1] ?? "";
    if (!/[a-z!/?]/iu.test(lead)) {
      cursor = start + 1;
      continue;
    }
    let quote = null;
    let end = start + 1;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        end += 1;
        break;
      }
    }
    tags.push({ start, end, raw: source.slice(start, end), comment: false });
    cursor = Math.max(end, start + 1);
  }
  return tags;
}

function openingTag(raw) {
  const source = String(raw ?? "");
  if (source[0] !== "<" || source.at(-1) !== ">") return null;
  let cursor = 1;
  while (cursor < source.length - 1 && /\s/u.test(source[cursor])) cursor += 1;
  const nameStart = cursor;
  while (cursor < source.length - 1 && /[A-Za-z0-9_:-]/u.test(source[cursor])) cursor += 1;
  if (cursor === nameStart) return null;
  const tag = source.slice(nameStart, cursor).toLowerCase();
  let contentEnd = source.length - 1;
  while (contentEnd > cursor && /\s/u.test(source[contentEnd - 1])) contentEnd -= 1;
  let selfClosing = false;
  if (contentEnd > cursor && source[contentEnd - 1] === "/") {
    selfClosing = true;
    contentEnd -= 1;
  }
  return {
    tag,
    attributes: source.slice(cursor, contentEnd),
    selfClosing
  };
}

export function parseHtml(html) {
  const source = String(html ?? "");
  const root = {
    tag: "#document", attrs: {}, start: 0, openEnd: 0, closeStart: source.length,
    end: source.length, parent: null, children: []
  };
  const nodes = [];
  const stack = [root];
  for (const token of scanHtmlTags(source)) {
    if (token.comment || /^<!/u.test(token.raw)) continue;
    const closing = /^<\/\s*([\w:-]+)/u.exec(token.raw);
    if (closing) {
      const tag = closing[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag !== tag) continue;
        stack[index].closeStart = token.start;
        stack[index].end = token.end;
        stack.length = index;
        break;
      }
      continue;
    }
    const opening = openingTag(token.raw);
    if (!opening) continue;
    const parent = stack.at(-1);
    const node = {
      tag: opening.tag,
      attrs: parseAttributes(opening.attributes),
      start: token.start,
      openEnd: token.end,
      closeStart: null,
      end: null,
      parent,
      children: []
    };
    parent.children.push(node);
    nodes.push(node);
    if (VOID_ELEMENTS.has(node.tag) || opening.selfClosing) {
      node.closeStart = token.end;
      node.end = token.end;
    } else {
      stack.push(node);
    }
  }
  for (const node of stack) {
    if (node.end !== null) continue;
    node.closeStart = source.length;
    node.end = source.length;
  }
  const textCache = new WeakMap();
  const textOf = (node, options = {}) => {
    if (!Object.keys(options).length && textCache.has(node)) return textCache.get(node);
    const value = htmlFragmentToText(innerHtml({ html: source }, node), options);
    if (!Object.keys(options).length) textCache.set(node, value);
    return value;
  };
  return { html: source, root, nodes, textOf };
}

export function descendants(node) {
  const result = [];
  const stack = [...(node?.children ?? [])].reverse();
  while (stack.length) {
    const current = stack.pop();
    result.push(current);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      stack.push(current.children[index]);
    }
  }
  return result;
}

export function hasClass(node, token) {
  return String(node?.attrs?.class ?? "").split(/\s+/u).includes(token);
}

export function classText(node) {
  const values = [];
  let current = node;
  while (current && current.tag !== "#document") {
    const value = String(current.attrs?.class ?? "").trim();
    if (value) values.push(value);
    current = current.parent;
  }
  return values.join(" ");
}

export function nearestAncestor(node, predicate, stopNode = null) {
  let current = node?.parent;
  while (current && current !== stopNode) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

export function innerHtml(context, node) {
  if (!node) return "";
  return context.html.slice(node.openEnd, node.closeStart ?? node.end ?? node.openEnd);
}

export function outerHtml(context, node) {
  if (!node) return "";
  return context.html.slice(node.start, node.end ?? node.closeStart ?? node.openEnd);
}

function attributesPreserveWhitespace(attributes = {}) {
  const className = String(attributes.class ?? "");
  const style = String(attributes.style ?? "");
  return /(?:^|\s)whitespace-(?:pre(?:-wrap|-line)?|break-spaces)(?:\s|$)/u.test(className)
    || /(?:^|;)\s*white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)\b/iu.test(style);
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/gu, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function htmlFragmentToText(fragment, options = {}) {
  const skipTags = new Set(options.skipTags ?? ["script", "style", "svg"]);
  const tokens = scanHtmlTags(fragment);
  const chunks = [];
  let cursor = 0;
  let skipDepth = 0;
  let preserveDepth = options.preserveWhitespace ? 1 : 0;
  const open = [];
  const append = (raw) => {
    if (!raw || skipDepth) return;
    const decoded = decodeHtmlEntities(raw).replace(/\r\n?/gu, "\n");
    chunks.push(preserveDepth ? decoded : decoded.replace(/\s+/gu, " "));
  };
  for (const token of tokens) {
    append(String(fragment).slice(cursor, token.start));
    cursor = token.end;
    if (token.comment) continue;
    const closing = /^<\/\s*([\w:-]+)/u.exec(token.raw);
    if (closing) {
      const tag = closing[1].toLowerCase();
      if (skipDepth) {
        if (skipTags.has(tag)) skipDepth -= 1;
        continue;
      }
      const index = open.findLastIndex((entry) => entry.tag === tag);
      if (index >= 0) {
        for (let cursorIndex = open.length - 1; cursorIndex >= index; cursorIndex -= 1) {
          if (open[cursorIndex].preserve) preserveDepth -= 1;
        }
        open.length = index;
      }
      if (BLOCK_ELEMENTS.has(tag)) chunks.push("\n");
      continue;
    }
    const opening = /^<\s*([\w:-]+)([\s\S]*?)\/?\s*>$/u.exec(token.raw);
    if (!opening) continue;
    const tag = opening[1].toLowerCase();
    if (skipTags.has(tag)) {
      skipDepth += 1;
      continue;
    }
    if (skipDepth) continue;
    if (!VOID_ELEMENTS.has(tag) && !/\/\s*>$/u.test(token.raw)) {
      const preserve = tag === "pre" || attributesPreserveWhitespace(parseAttributes(opening[2]));
      open.push({ tag, preserve });
      if (preserve) preserveDepth += 1;
    }
    if (tag === "br" || tag === "hr") chunks.push("\n");
    else if (BLOCK_ELEMENTS.has(tag)) chunks.push("\n");
  }
  append(String(fragment).slice(cursor));
  return normalizeText(chunks.join(""));
}

function trimBlock(value) {
  return String(value ?? "").replace(/^[ \t]*\n+/u, "").replace(/\n+[ \t]*$/u, "").trim();
}

function block(value) {
  const body = trimBlock(value);
  return body ? `\n\n${body}\n\n` : "";
}

function normalizeMarkdown(value) {
  return String(value ?? "")
    .replace(/\u00a0/gu, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/^[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function rawTextWithoutTags(raw, preserveWhitespace) {
  const chunks = [];
  let cursor = 0;
  for (const tag of scanHtmlTags(raw)) {
    chunks.push(String(raw).slice(cursor, tag.start));
    cursor = tag.end;
  }
  chunks.push(String(raw).slice(cursor));
  const decoded = decodeHtmlEntities(chunks.join(""))
    .replace(/\u00a0/gu, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/gu, "")
    .replace(/\r\n?/gu, "\n");
  return preserveWhitespace ? decoded : decoded.replace(/\s+/gu, " ");
}

function codeFence(text, minimum = 1) {
  const longest = [...String(text ?? "").matchAll(/`+/gu)]
    .reduce((maximum, match) => Math.max(maximum, match[0].length), 0);
  return "`".repeat(Math.max(minimum, longest + 1));
}

function markdownLink(value) {
  try {
    return encodeURI(String(value ?? "")).replaceAll("(", "%28").replaceAll(")", "%29");
  } catch {
    return String(value ?? "").replaceAll("(", "%28").replaceAll(")", "%29");
  }
}

export function htmlFragmentToMarkdown(fragment, options = {}) {
  const document = parseHtml(String(fragment ?? ""));
  const source = document.html;
  const skipTags = new Set(options.skipTags ?? ["script", "style", "svg"]);

  const contextFor = (node, context) => ({
    ...context,
    preserveWhitespace: Boolean(context.preserveWhitespace) || attributesPreserveWhitespace(node.attrs)
  });

  const normalizedCodeLanguage = (value) => {
    const language = String(value ?? "").trim().toLowerCase();
    return language && /^[a-z0-9_+#.-]+$/u.test(language) ? language : "";
  };

  const codeLanguage = (node) => {
    const code = node.tag === "code"
      ? node
      : descendants(node).find((candidate) => candidate.tag === "code") ?? node;
    for (const candidate of [node, code]) {
      const explicit = normalizedCodeLanguage(candidate.attrs?.["data-language"]);
      if (explicit) return explicit;
      const classLanguage = /(?:^|\s)(?:language-|lang-)([a-z0-9_+#.-]+)/iu
        .exec(String(candidate.attrs?.class ?? ""))?.[1];
      const normalized = normalizedCodeLanguage(classLanguage);
      if (normalized) return normalized;
    }
    return "";
  };

  const knownCodeLanguageLabel = (node, language) => {
    const classes = String(node?.attrs?.class ?? "");
    if (/(?:^|\s)(?:code-language|code-language-label|code-block-language|language-label)(?:\s|$)/iu
      .test(classes)) return true;
    if (node?.tag !== "div") return false;
    const children = node.children ?? [];
    const label = children.find((candidate) => candidate.tag === "span");
    const emptyControl = children.some((candidate) =>
      candidate.tag === "div"
      && !htmlFragmentToText(source.slice(
        candidate.openEnd,
        candidate.closeStart ?? candidate.end
      ), {
        skipTags: [...skipTags],
        preserveWhitespace: false
      }).trim());
    if (!label || !emptyControl) return false;
    const labelText = htmlFragmentToText(source.slice(
      label.openEnd,
      label.closeStart ?? label.end
    ), {
      skipTags: [...skipTags],
      preserveWhitespace: false
    }).trim();
    return normalizedCodeLanguage(labelText) === language;
  };

  const duplicateCodeLanguageLabel = (child, next) => {
    if (!["div", "span"].includes(child?.tag) || next?.tag !== "pre") return false;
    const language = codeLanguage(next);
    if (!language || !knownCodeLanguageLabel(child, language)) return false;
    const between = rawTextWithoutTags(
      source.slice(child.end ?? child.closeStart ?? child.openEnd, next.start),
      false
    ).trim();
    if (between) return false;
    const label = htmlFragmentToText(source.slice(child.openEnd, child.closeStart ?? child.end), {
      skipTags: [...skipTags],
      preserveWhitespace: false
    }).trim();
    return normalizedCodeLanguage(label) === language;
  };

  const serializeChildren = (node, context, excludedChildren = null) => {
    const start = node.tag === "#document" ? 0 : node.openEnd;
    const end = node.tag === "#document" ? source.length : (node.closeStart ?? node.end ?? source.length);
    let cursor = start;
    let result = "";
    const children = node.children ?? [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.start < cursor || child.start > end) continue;
      result += rawTextWithoutTags(source.slice(cursor, child.start), context.preserveWhitespace);
      if (excludedChildren?.has(child)) {
        cursor = Math.min(child.end ?? child.closeStart ?? child.openEnd, end);
        continue;
      }
      if (duplicateCodeLanguageLabel(child, children[index + 1])) {
        cursor = Math.min(child.end ?? child.closeStart ?? child.openEnd, end);
        continue;
      }
      result += serializeElement(child, context);
      cursor = Math.min(child.end ?? child.closeStart ?? child.openEnd, end);
    }
    result += rawTextWithoutTags(source.slice(cursor, end), context.preserveWhitespace);
    return result;
  };

  const serializePre = (node) => {
    const code = descendants(node).find((candidate) => candidate.tag === "code") ?? node;
    const text = htmlFragmentToText(source.slice(code.openEnd, code.closeStart ?? code.end), {
      skipTags: [...skipTags],
      preserveWhitespace: true
    }).replace(/^\n/u, "").replace(/\n$/u, "");
    const fence = codeFence(text, 3);
    return block(`${fence}${codeLanguage(node)}\n${text}\n${fence}`);
  };

  const serializeList = (node, context) => {
    const ordered = node.tag === "ol";
    const items = (node.children ?? []).filter((child) => child.tag === "li");
    if (!items.length) return block(serializeChildren(node, contextFor(node, context)));
    let ordinal = Number.parseInt(String(node.attrs?.start ?? "1"), 10);
    if (!Number.isFinite(ordinal)) ordinal = 1;
    const lines = [];
    for (const item of items) {
      const markerNodes = (item.children ?? [])
        .filter((child) => hasClass(child, "osis-list-marker"));
      const markerNode = markerNodes[0];
      const visibleMarker = markerNode
        ? htmlFragmentToText(source.slice(
          markerNode.openEnd,
          markerNode.closeStart ?? markerNode.end
        ), {
          skipTags: [...skipTags],
          preserveWhitespace: false
        }).trim()
        : "";
      const visibleOrdinal = /^(\d+)[.)]?$/u.exec(visibleMarker)?.[1];
      const explicit = Number.parseInt(String(item.attrs?.value ?? ""), 10);
      if (ordered && visibleOrdinal !== undefined) ordinal = Number.parseInt(visibleOrdinal, 10);
      else if (ordered && Number.isFinite(explicit)) ordinal = explicit;
      const marker = ordered ? `${ordinal}. ` : "- ";
      const body = trimBlock(serializeChildren(
        item,
        contextFor(item, context),
        new Set(markerNodes)
      ));
      const itemLines = body.split("\n");
      lines.push(`${marker}${itemLines.shift() ?? ""}`.trimEnd());
      const continuation = " ".repeat(marker.length);
      for (const line of itemLines) lines.push(line ? `${continuation}${line}` : "");
      if (ordered) ordinal += 1;
    }
    return block(lines.join("\n"));
  };

  const serializeTable = (node, context) => {
    const rows = descendants(node).filter((candidate) => {
      if (candidate.tag !== "tr") return false;
      let ancestor = candidate.parent;
      while (ancestor && ancestor !== node && ancestor.tag !== "table") ancestor = ancestor.parent;
      return ancestor === node;
    });
    const cells = rows.map((row) => (row.children ?? [])
      .filter((cell) => cell.tag === "th" || cell.tag === "td")
      .map((cell) => normalizeMarkdown(serializeChildren(cell, contextFor(cell, context)))
        .replaceAll("|", "\\|").replaceAll("\n", "<br>")));
    const width = cells.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    if (!cells.length || !width) return block(serializeChildren(node, contextFor(node, context)));
    const padded = cells.map((row) => [...row, ...Array(width - row.length).fill("")]);
    return block([
      `| ${padded[0].join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`)
    ].join("\n"));
  };

  const serializeElement = (node, context) => {
    if (skipTags.has(node.tag)) return "";
    const nested = contextFor(node, context);
    const explicitTex = String(node.attrs?.["data-tex"] ?? "").trim();
    const annotation = (node.tag === "math" || /(?:^|\s)katex(?:\s|$)/u.test(String(node.attrs?.class ?? "")))
      ? descendants(node).find((candidate) => candidate.tag === "annotation"
        && /(?:application|text)\/x-tex/iu.test(String(candidate.attrs?.encoding ?? "")))
      : null;
    const annotationTex = annotation
      ? htmlFragmentToText(source.slice(annotation.openEnd, annotation.closeStart ?? annotation.end), {
        skipTags: [...skipTags], preserveWhitespace: true
      }).trim()
      : "";
    const tex = explicitTex || annotationTex;
    if (tex) {
      const display = ["block", "true", "display"].includes(
        String(node.attrs?.["data-math-display"] ?? node.attrs?.display ?? "").toLowerCase()
      );
      return display ? block(`\\[\n${tex}\n\\]`) : `\\(${tex}\\)`;
    }
    if (node.tag === "br") return "\n";
    if (node.tag === "hr") return block("---");
    if (node.tag === "pre") return serializePre(node);
    if (node.tag === "code" || node.tag === "kbd") {
      const text = htmlFragmentToText(source.slice(node.openEnd, node.closeStart ?? node.end), {
        skipTags: [...skipTags], preserveWhitespace: true
      });
      if (!text) return "";
      const fence = codeFence(text);
      const padding = /^\s|\s$/u.test(text) || text.startsWith("`") || text.endsWith("`") ? " " : "";
      return `${fence}${padding}${text}${padding}${fence}`;
    }
    if (node.tag === "ol" || node.tag === "ul") return serializeList(node, nested);
    if (node.tag === "table") return serializeTable(node, nested);
    if (node.tag === "input" && String(node.attrs?.type).toLowerCase() === "checkbox") {
      return Object.hasOwn(node.attrs, "checked") ? "[x] " : "[ ] ";
    }

    const content = serializeChildren(node, nested);
    const inline = trimBlock(content);
    if (node.tag === "strong" || node.tag === "b") return inline ? `**${inline}**` : "";
    if (node.tag === "em" || node.tag === "i") return inline ? `*${inline}*` : "";
    if (["del", "s", "strike"].includes(node.tag)) return inline ? `~~${inline}~~` : "";
    if (node.tag === "sup" || node.tag === "sub" || node.tag === "mark" || node.tag === "u") {
      return inline ? `<${node.tag}>${inline}</${node.tag}>` : "";
    }
    if (node.tag === "a") {
      const href = String(node.attrs?.href ?? "").trim();
      if (!href) return inline;
      return `[${inline || href}](${markdownLink(href)})`;
    }
    if (node.tag === "img") {
      const alt = String(node.attrs?.alt ?? "").trim();
      const src = String(node.attrs?.src ?? "").trim();
      return src ? `![${alt}](${markdownLink(src)})` : alt;
    }
    if (/^h[1-6]$/u.test(node.tag)) return inline ? block(`${"#".repeat(Number(node.tag[1]))} ${inline}`) : "";
    if (node.tag === "blockquote") {
      return block(normalizeMarkdown(content).split("\n").map((line) => line ? `> ${line}` : ">").join("\n"));
    }
    if (node.tag === "summary" || node.tag === "dt") return inline ? block(`**${inline}**`) : "";
    if (node.tag === "li") return block(`- ${inline}`);
    if (BLOCK_ELEMENTS.has(node.tag)) return block(content);
    return content;
  };

  return normalizeMarkdown(serializeChildren(document.root, {
    preserveWhitespace: Boolean(options.preserveWhitespace)
  }));
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeClassTokens(value, maximum = 128) {
  const result = [];
  const seen = new Set();
  for (const token of String(value ?? "").split(/\s+/u)) {
    if (!token || token.length > 128 || /[\u0000-\u001f"'<>=`]/u.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
    if (result.length >= maximum) break;
  }
  return result;
}

const SAFE_SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textpath", "defs", "marker", "clippath", "mask", "pattern",
  "lineargradient", "radialgradient", "mesh", "meshgradient", "meshrow", "meshpatch",
  "solidcolor", "hatch", "hatchpath", "stop", "title", "desc", "metadata", "switch",
  "view", "foreignobject", "use", "symbol", "image",
  "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix",
  "fecomponenttransfer", "fefunca", "fefuncr", "fefuncg", "fefuncb", "femerge",
  "femergenode", "feflood", "fecomposite", "fedropshadow", "femorphology",
  "feturbulence", "fedisplacementmap", "feimage", "fediffuselighting",
  "fespecularlighting", "fedistantlight", "fepointlight", "fespotlight", "fetile",
  "feconvolvematrix",
  "div", "p", "span", "strong", "em", "b", "i", "br", "section", "article",
  "header", "footer", "ul", "ol", "li", "table", "thead", "tbody", "tfoot",
  "tr", "th", "td", "pre", "code", "blockquote", "h1", "h2", "h3", "h4",
  "h5", "h6"
]);

const SVG_TAG_CASE = new Map([
  ["clippath", "clipPath"], ["foreignobject", "foreignObject"],
  ["lineargradient", "linearGradient"], ["radialgradient", "radialGradient"],
  ["textpath", "textPath"], ["meshgradient", "meshGradient"], ["meshrow", "meshRow"],
  ["meshpatch", "meshPatch"], ["solidcolor", "solidColor"], ["hatchpath", "hatchPath"],
  ["fegaussianblur", "feGaussianBlur"], ["feoffset", "feOffset"], ["feblend", "feBlend"],
  ["fecolormatrix", "feColorMatrix"], ["fecomponenttransfer", "feComponentTransfer"],
  ["fefunca", "feFuncA"], ["fefuncr", "feFuncR"], ["fefuncg", "feFuncG"],
  ["fefuncb", "feFuncB"], ["femerge", "feMerge"], ["femergenode", "feMergeNode"],
  ["feflood", "feFlood"], ["fecomposite", "feComposite"], ["fedropshadow", "feDropShadow"],
  ["femorphology", "feMorphology"], ["feturbulence", "feTurbulence"],
  ["fedisplacementmap", "feDisplacementMap"], ["feimage", "feImage"],
  ["fediffuselighting", "feDiffuseLighting"], ["fespecularlighting", "feSpecularLighting"],
  ["fedistantlight", "feDistantLight"], ["fepointlight", "fePointLight"],
  ["fespotlight", "feSpotLight"], ["fetile", "feTile"],
  ["feconvolvematrix", "feConvolveMatrix"]
]);

const SVG_ATTRIBUTE_CASE = new Map([
  ["viewbox", "viewBox"], ["preserveaspectratio", "preserveAspectRatio"],
  ["gradientunits", "gradientUnits"], ["gradienttransform", "gradientTransform"],
  ["markerwidth", "markerWidth"], ["markerheight", "markerHeight"],
  ["markerunits", "markerUnits"], ["refx", "refX"], ["refy", "refY"],
  ["textlength", "textLength"], ["lengthadjust", "lengthAdjust"],
  ["clippathunits", "clipPathUnits"], ["patternunits", "patternUnits"],
  ["patterncontentunits", "patternContentUnits"], ["filterunits", "filterUnits"],
  ["primitiveunits", "primitiveUnits"], ["stddeviation", "stdDeviation"],
  ["basefrequency", "baseFrequency"], ["numoctaves", "numOctaves"],
  ["stitchtiles", "stitchTiles"], ["edgemode", "edgeMode"],
  ["kernelmatrix", "kernelMatrix"], ["kernelunitlength", "kernelUnitLength"],
  ["targetx", "targetX"], ["targety", "targetY"], ["surfacescale", "surfaceScale"],
  ["diffuseconstant", "diffuseConstant"], ["specularconstant", "specularConstant"],
  ["specularexponent", "specularExponent"], ["limitingconeangle", "limitingConeAngle"],
  ["pointsatx", "pointsAtX"], ["pointsaty", "pointsAtY"], ["pointsatz", "pointsAtZ"],
  ["preservealpha", "preserveAlpha"], ["tablevalues", "tableValues"],
  ["startoffset", "startOffset"], ["pathlength", "pathLength"],
  ["spreadmethod", "spreadMethod"]
]);
const STATIC_KATEX_STYLE_PROPERTIES = new Set([
  "height", "margin-right", "top", "vertical-align", "margin-left", "position",
  "padding-left", "min-width", "width", "border-right-width", "border-top-width",
  "bottom", "color", "border-bottom-width", "border-style", "border-width"
]);
const STATIC_KATEX_SVG_TAGS = new Set(["svg", "path"]);
const STATIC_KATEX_SVG_ATTRS = Object.freeze({
  svg: new Set(["xmlns", "width", "height", "viewbox", "preserveaspectratio"]),
  path: new Set(["d", "fill", "fill-rule"])
});
const STATIC_KATEX_SVG_NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const STATIC_KATEX_VIEWBOX = new RegExp(
  `^${STATIC_KATEX_SVG_NUMBER}(?:[\\s,]+${STATIC_KATEX_SVG_NUMBER}){3}$`,
  "u"
);
const STATIC_KATEX_PATH_DATA = /^[\s,.\d+\-MmZzLlHhVvCcSsQqTtAaEe]+$/u;

function sanitizeStaticKatexStyle(value) {
  const declarations = [];
  for (const raw of String(value ?? "").split(";")) {
    const separator = raw.indexOf(":");
    if (separator < 1) continue;
    const property = raw.slice(0, separator).trim().toLowerCase();
    const styleValue = raw.slice(separator + 1).trim();
    if (!STATIC_KATEX_STYLE_PROPERTIES.has(property)) continue;
    if (!/^(?:-?\d*\.?\d+(?:em|px|%)?|relative|currentColor|red|green|solid)$/u.test(styleValue)) continue;
    declarations.push(`${property}:${styleValue}`);
  }
  return declarations.join(";");
}

function sanitizeStaticKatexSvgAttribute(tag, name, value) {
  const lowerName = String(name ?? "").toLowerCase();
  const raw = String(value ?? "").trim();
  if (!STATIC_KATEX_SVG_ATTRS[tag]?.has(lowerName) || !raw) return null;
  if (lowerName === "xmlns") {
    return raw === "http://www.w3.org/2000/svg" ? ["xmlns", raw] : null;
  }
  if (lowerName === "width" || lowerName === "height") {
    return new RegExp(`^${STATIC_KATEX_SVG_NUMBER}(?:em|ex|px|%)?$`, "u").test(raw)
      ? [lowerName, raw]
      : null;
  }
  if (lowerName === "viewbox") {
    return STATIC_KATEX_VIEWBOX.test(raw) ? ["viewBox", raw] : null;
  }
  if (lowerName === "preserveaspectratio") {
    return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/u.test(raw)
      ? ["preserveAspectRatio", raw]
      : null;
  }
  if (lowerName === "d") {
    return STATIC_KATEX_PATH_DATA.test(raw) ? ["d", raw] : null;
  }
  if (lowerName === "fill") {
    return /^(?:currentColor|none|#[0-9a-f]{3,8})$/iu.test(raw) ? ["fill", raw] : null;
  }
  if (lowerName === "fill-rule") {
    return /^(?:evenodd|nonzero)$/u.test(raw) ? ["fill-rule", raw] : null;
  }
  return null;
}

/**
 * Keeps only the inert span/div snapshot and the minimal SVG/path geometry
 * emitted for a KaTeX formula whose original TeX is unavailable. Reader
 * sanitizes the same narrow vocabulary again before displaying it.
 */
export function sanitizeStaticMathFragment(fragment) {
  const document = parseHtml(String(fragment ?? ""));
  const source = document.html;
  const root = document.nodes.find((node) =>
    hasClass(node, "osis-katex-shell") || hasClass(node, "katex-wrapper"));
  if (!root) return "";
  const display = hasClass(root, "osis-math-display")
    || hasClass(root, "math-display")
    || descendants(root).some((candidate) =>
      ["block", "true", "display"].includes(String(candidate.attrs?.["data-math-display"] ?? "").toLowerCase()));
  const serializeText = (value) => escapeHtml(decodeHtmlEntities(value));
  const serializeStaticSvgNode = (node) => {
    if (!STATIC_KATEX_SVG_TAGS.has(node.tag)) return "";
    const attributes = [];
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      const safe = sanitizeStaticKatexSvgAttribute(node.tag, name, value);
      if (safe) attributes.push(`${safe[0]}="${escapeHtml(safe[1])}"`);
    }
    if (node.tag === "path" && !attributes.some((attribute) => attribute.startsWith("d="))) return "";
    attributes.sort((left, right) => left.localeCompare(right, "en"));
    const open = `<${node.tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
    if (node.tag === "path") return `${open}</path>`;
    const children = (node.children ?? []).map(serializeStaticSvgNode).join("");
    return `${open}${children}</svg>`;
  };
  const serializeChildren = (node) => {
    const end = node.closeStart ?? node.end ?? node.openEnd;
    let cursor = node.openEnd;
    let result = "";
    for (const child of node.children ?? []) {
      if (child.start < cursor || child.start > end) continue;
      result += serializeText(source.slice(cursor, child.start));
      result += serializeNode(child);
      cursor = Math.min(child.end ?? child.closeStart ?? child.openEnd, end);
    }
    result += serializeText(source.slice(cursor, end));
    return result;
  };
  const serializeNode = (node) => {
    if (node.tag === "svg") return serializeStaticSvgNode(node);
    if (!["span", "div", "br"].includes(node.tag)) return serializeChildren(node);
    const attributes = [];
    const classes = sanitizeClassTokens(node.attrs?.class);
    if (node === root && !classes.includes("osis-katex-shell")) classes.unshift("osis-katex-shell");
    if (node === root) {
      const displayClass = display ? "osis-math-display" : "osis-math-inline";
      if (!classes.includes(displayClass)) classes.push(displayClass);
    }
    if (classes.length) attributes.push(`class="${escapeHtml(classes.join(" "))}"`);
    const style = sanitizeStaticKatexStyle(node.attrs?.style);
    if (style) attributes.push(`style="${escapeHtml(style)}"`);
    for (const name of ["aria-hidden", "aria-label", "role"]) {
      const value = String(node.attrs?.[name] ?? "").trim();
      if (value) attributes.push(`${name}="${escapeHtml(value)}"`);
    }
    attributes.sort((left, right) => left.localeCompare(right, "en"));
    const open = `<${node.tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
    return node.tag === "br" ? open : `${open}${serializeChildren(node)}</${node.tag}>`;
  };
  return serializeNode(root);
}

const SAFE_RICH_HTML_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote",
  "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details",
  "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "kbd", "li", "main", "mark",
  "nav", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section",
  "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr"
]);

const REMOVED_RICH_HTML_TAGS = new Set([
  "base", "link", "meta", "script", "style", "template"
]);

const INERT_RICH_HTML_TAGS = new Map([
  ["form", "div"], ["button", "span"], ["input", "span"], ["select", "span"],
  ["option", "span"], ["optgroup", "span"], ["textarea", "span"], ["label", "span"],
  ["fieldset", "div"], ["legend", "span"], ["datalist", "span"], ["output", "span"],
  ["meter", "span"], ["progress", "span"], ["iframe", "div"], ["frame", "div"],
  ["frameset", "div"], ["object", "div"], ["embed", "span"], ["applet", "div"],
  ["portal", "div"], ["audio", "div"], ["video", "div"], ["canvas", "div"],
  ["picture", "div"], ["img", "span"], ["source", "span"], ["track", "span"],
  ["map", "div"], ["area", "span"], ["dialog", "div"], ["marquee", "div"],
  ["blink", "span"], ["keygen", "span"]
]);

const RICH_STYLE_PROPERTIES = new Set([
  "align-items", "background-color", "border", "border-bottom", "border-bottom-color",
  "border-bottom-style", "border-bottom-width", "border-collapse", "border-color",
  "border-left", "border-left-color", "border-left-style", "border-left-width",
  "border-radius", "border-right", "border-right-color", "border-right-style",
  "border-right-width", "border-spacing", "border-style", "border-top",
  "border-top-color", "border-top-style", "border-top-width", "border-width",
  "box-sizing", "color", "display", "font-family", "font-size", "font-style", "font-variant",
  "font-weight", "height", "justify-content", "letter-spacing", "line-height", "list-style-position",
  "list-style-type", "margin", "margin-bottom", "margin-left", "margin-right",
  "margin-top", "max-height", "max-width", "min-height", "min-width", "padding",
  "padding-bottom", "padding-left", "padding-right", "padding-top", "tab-size",
  "text-align", "text-decoration", "text-indent", "text-transform", "vertical-align",
  "white-space", "width", "word-break", "word-spacing", "word-wrap", "overflow-wrap"
]);

const RICH_TEXT_EVIDENCE_ATTRIBUTES = [
  "value", "placeholder", "aria-label", "title", "alt", "label", "type",
  "min", "max", "low", "high", "optimum"
];
const RICH_URL_EVIDENCE_ATTRIBUTES = [
  "href", "src", "srcset", "poster", "data", "action", "formaction", "cite",
  "longdesc"
];
const RICH_BOOLEAN_EVIDENCE_ATTRIBUTES = [
  "checked", "selected", "disabled", "readonly", "multiple", "required"
];

function sanitizeRichStyle(value) {
  const declarations = [];
  for (const rawDeclaration of String(value ?? "").split(";")) {
    const separator = rawDeclaration.indexOf(":");
    if (separator < 1) continue;
    const property = rawDeclaration.slice(0, separator).trim().toLowerCase();
    const styleValue = rawDeclaration.slice(separator + 1).trim();
    if (!RICH_STYLE_PROPERTIES.has(property) || !styleValue || styleValue.length > 256) continue;
    if (/[\u0000-\u001f<>]/u.test(styleValue)) continue;
    if (/(?:url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding)/iu.test(styleValue)) continue;
    declarations.push(`${property}:${styleValue}`);
  }
  return declarations.join(";");
}

function safeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

function safeInertUrlEvidence(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) return "";
  if (/(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/iu.test(raw)) return "";
  return raw;
}

function richSourceAttributes(node) {
  const attributes = [];
  const sourceClasses = sanitizeClassTokens(node.attrs?.class).join(" ");
  if (sourceClasses) {
    attributes.push(`data-cloudig-source-class="${escapeHtml(sourceClasses)}"`);
  }
  const style = sanitizeRichStyle(node.attrs?.style);
  if (style) attributes.push(`style="${escapeHtml(style)}"`);
  const title = String(node.attrs?.title ?? "").trim();
  if (title) attributes.push(`title="${escapeHtml(title)}"`);
  const ariaLabel = String(node.attrs?.["aria-label"] ?? "").trim();
  if (ariaLabel) attributes.push(`aria-label="${escapeHtml(ariaLabel)}"`);
  const role = String(node.attrs?.role ?? "").trim();
  if (/^[a-z][a-z0-9_-]{0,63}$/iu.test(role)) attributes.push(`role="${role.toLowerCase()}"`);
  const language = String(node.attrs?.lang ?? "").trim();
  if (/^[a-z0-9-]{1,35}$/iu.test(language)) attributes.push(`lang="${language}"`);
  const direction = String(node.attrs?.dir ?? "").trim().toLowerCase();
  if (["auto", "ltr", "rtl"].includes(direction)) attributes.push(`dir="${direction}"`);
  return attributes;
}

function serializeRichEvidence(node) {
  const evidence = [];
  for (const name of RICH_TEXT_EVIDENCE_ATTRIBUTES) {
    const value = String(node.attrs?.[name] ?? "").trim();
    if (!value) continue;
    evidence.push(
      `<span class="cloudig-inert-evidence" data-cloudig-attribute="${name}">`
      + `[${name}: ${escapeHtml(value)}]</span>`
    );
  }
  for (const name of RICH_URL_EVIDENCE_ATTRIBUTES) {
    const value = safeInertUrlEvidence(node.attrs?.[name]);
    if (!value) continue;
    evidence.push(
      `<span class="cloudig-inert-evidence" data-cloudig-attribute="${name}">`
      + `[${name}: ${escapeHtml(value)}]</span>`
    );
  }
  for (const name of RICH_BOOLEAN_EVIDENCE_ATTRIBUTES) {
    if (!Object.hasOwn(node.attrs ?? {}, name)) continue;
    evidence.push(
      `<span class="cloudig-inert-evidence" data-cloudig-attribute="${name}">`
      + `[${name}]</span>`
    );
  }
  return evidence.join(" ");
}

function richNeutralTag(node) {
  if (INERT_RICH_HTML_TAGS.has(node.tag)) return INERT_RICH_HTML_TAGS.get(node.tag);
  if (BLOCK_ELEMENTS.has(node.tag) || node.tag.includes("-")) return "div";
  if ((node.children ?? []).some((child) => BLOCK_ELEMENTS.has(child.tag))) return "div";
  return "span";
}

/**
 * Keeps readable, inert rich text while preserving KaTeX snapshots that have
 * no recoverable TeX source. This is used only as a reasoning-body fallback;
 * active behavior is neutralized, while its visible labels, attribute evidence,
 * descendants and unknown component boundaries remain in the unified JSON.
 */
export function sanitizeRichTextFragment(fragment) {
  const document = parseHtml(String(fragment ?? ""));
  const source = document.html;
  const serializeText = (value) => escapeHtml(decodeHtmlEntities(value));
  const serializeChildren = (node) => {
    const end = node.closeStart ?? node.end ?? node.openEnd;
    let cursor = node.openEnd;
    let result = "";
    for (const child of node.children ?? []) {
      if (child.start < cursor || child.start > end) continue;
      result += serializeText(source.slice(cursor, child.start));
      result += serializeNode(child);
      cursor = Math.min(child.end ?? child.closeStart ?? child.openEnd, end);
    }
    result += serializeText(source.slice(cursor, end));
    return result;
  };
  const serializeNeutralNode = (node, behavior) => {
    const tag = richNeutralTag(node);
    const attributes = [
      `class="${behavior ? "cloudig-inert-element" : "cloudig-unknown-element"}"`,
      `data-cloudig-original-tag="${escapeHtml(node.tag)}"`,
      ...richSourceAttributes(node).filter((attribute) =>
        !attribute.startsWith("title=") && !attribute.startsWith("aria-label="))
    ];
    attributes.sort((left, right) => left.localeCompare(right, "en"));
    const evidence = serializeRichEvidence(node);
    const children = serializeChildren(node);
    const content = evidence && children ? `${evidence} ${children}` : evidence || children;
    return `<${tag} ${attributes.join(" ")}>${content}</${tag}>`;
  };
  const serializeNode = (node) => {
    if (REMOVED_RICH_HTML_TAGS.has(node.tag)) return "";
    if (hasClass(node, "osis-katex-shell") || hasClass(node, "katex-wrapper")) {
      return sanitizeStaticMathFragment(source.slice(node.start, node.end ?? node.openEnd));
    }
    if (node.tag === "svg") {
      return sanitizeSvgFragment(source.slice(node.start, node.end ?? node.openEnd));
    }
    if (INERT_RICH_HTML_TAGS.has(node.tag)) return serializeNeutralNode(node, true);
    if (!SAFE_RICH_HTML_TAGS.has(node.tag)) return serializeNeutralNode(node, false);
    const attributes = richSourceAttributes(node);
    if (node.tag === "a" && /^https?:\/\//iu.test(String(node.attrs?.href ?? ""))) {
      const href = safeHttpUrl(node.attrs.href);
      if (href) attributes.push(`href="${escapeHtml(href)}"`);
    }
    if (node.tag === "ol" && /^[1-9]\d{0,5}$/u.test(String(node.attrs?.start ?? ""))) {
      attributes.push(`start="${node.attrs.start}"`);
    }
    if (node.tag === "li" && /^-?\d{1,6}$/u.test(String(node.attrs?.value ?? ""))) {
      attributes.push(`value="${node.attrs.value}"`);
    }
    if (["td", "th"].includes(node.tag)) {
      for (const name of ["rowspan", "colspan"]) {
        if (/^[1-9]\d{0,2}$/u.test(String(node.attrs?.[name] ?? ""))) {
          attributes.push(`${name}="${node.attrs[name]}"`);
        }
      }
    }
    if (node.tag === "col" && /^[1-9]\d{0,2}$/u.test(String(node.attrs?.span ?? ""))) {
      attributes.push(`span="${node.attrs.span}"`);
    }
    if (node.tag === "time") {
      const datetime = String(node.attrs?.datetime ?? "").trim();
      if (datetime && datetime.length <= 128 && !/[\u0000-\u001f"'<>]/u.test(datetime)) {
        attributes.push(`datetime="${escapeHtml(datetime)}"`);
      }
    }
    attributes.sort((left, right) => left.localeCompare(right, "en"));
    const open = `<${node.tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
    return VOID_ELEMENTS.has(node.tag) ? open : `${open}${serializeChildren(node)}</${node.tag}>`;
  };
  return serializeChildren(document.root);
}

const REMOVED_SVG_TAGS = new Set([
  "base", "link", "meta", "script", "style", "template"
]);
const ACTIVE_SVG_TAGS = new Set([
  "a", "animate", "animatecolor", "animatemotion", "animatetransform", "discard",
  "mpath", "set"
]);
const FORBIDDEN_SVG_ATTRIBUTES = new Set([
  "action", "allow", "allowfullscreen", "autofocus", "begin", "contenteditable",
  "download", "draggable", "dur", "end", "form", "formaction", "ping",
  "externalresourcesrequired", "repeatcount", "repeatdur", "requiredextensions",
  "requiredfeatures", "src", "srcdoc", "tabindex", "target", "xml:base"
]);
const SVG_STYLE_PROPERTIES = new Set([
  "alignment-baseline", "aspect-ratio", "baseline-shift", "clip-path", "clip-rule", "color",
  "color-interpolation", "color-interpolation-filters", "direction", "dominant-baseline",
  "fill", "fill-opacity", "fill-rule", "filter", "flood-color", "flood-opacity",
  "font-family", "font-size", "font-stretch", "font-style", "font-variant",
  "font-weight", "glyph-orientation-horizontal", "glyph-orientation-vertical",
  "letter-spacing", "lighting-color", "marker", "marker-end", "marker-mid", "marker-start",
  "mask", "opacity", "overflow", "paint-order", "shape-rendering", "stop-color",
  "stop-opacity", "stroke", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width",
  "text-anchor", "text-decoration", "text-rendering", "transform", "transform-origin",
  "unicode-bidi", "vector-effect", "vertical-align", "visibility", "white-space",
  "word-spacing", "writing-mode", "box-sizing", "display", "height", "max-height",
  "max-width", "min-height", "min-width", "width"
]);

function hasOnlyLocalSvgUrls(value) {
  const remainder = String(value ?? "").replace(
    /url\s*\(\s*(?:"#[^"]+"|'#[^']+'|#[^)"'\s]+)\s*\)/giu,
    ""
  );
  return !/url\s*\(/iu.test(remainder);
}

function sanitizeSvgStyle(value) {
  const declarations = [];
  for (const rawDeclaration of String(value ?? "").split(";")) {
    const separator = rawDeclaration.indexOf(":");
    if (separator < 1) continue;
    const property = rawDeclaration.slice(0, separator).trim().toLowerCase();
    const styleValue = rawDeclaration.slice(separator + 1).trim();
    if (!SVG_STYLE_PROPERTIES.has(property) || !styleValue || styleValue.length > 512) continue;
    if (/[\u0000-\u001f<>]/u.test(styleValue)) continue;
    if (/(?:javascript\s*:|vbscript\s*:|expression\s*\(|@import|behavior\s*:|-moz-binding)/iu.test(styleValue)) {
      continue;
    }
    if (!hasOnlyLocalSvgUrls(styleValue)) continue;
    declarations.push(`${property}:${styleValue}`);
  }
  return declarations.join(";");
}

function safeSvgAttribute(tag, name, value) {
  const lowerName = String(name).toLowerCase();
  const raw = String(value ?? "").trim();
  if (!raw || lowerName.startsWith("on")) return null;
  if (lowerName.startsWith("data-")) {
    if (!/^data-[a-z0-9_.:-]{1,123}$/u.test(lowerName) || raw.length > 8192) return null;
    if (/[\u0000-\u001f\u007f<>]/u.test(raw)) return null;
    return [lowerName, raw];
  }
  if (FORBIDDEN_SVG_ATTRIBUTES.has(lowerName)) return null;
  if (["href", "xlink:href"].includes(lowerName)) {
    if (/^#[^\s"'<>]+$/u.test(raw)) {
      return [lowerName, raw];
    }
    if (
      ["image", "feimage"].includes(tag)
      && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/iu.test(raw)
    ) {
      return [lowerName, raw];
    }
    return null;
  }
  if (lowerName === "style") {
    const style = sanitizeSvgStyle(raw);
    return style ? ["style", style] : null;
  }
  if (/(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/iu.test(raw)) return null;
  if (lowerName === "class") {
    const classes = sanitizeClassTokens(raw).join(" ");
    return classes ? ["class", classes] : null;
  }
  if (!hasOnlyLocalSvgUrls(raw)) return null;
  return [SVG_ATTRIBUTE_CASE.get(lowerName) ?? lowerName, raw];
}

function inertSvgUrlEvidence(node) {
  const raw = String(node?.attrs?.href ?? node?.attrs?.["xlink:href"] ?? "").trim();
  if (!/^(?:https?:)?\/\//iu.test(raw)) return "";
  return safeInertUrlEvidence(raw);
}

/**
 * Produces a deterministic, script-free SVG/foreignObject snapshot. The
 * exporter already emits static SVG, but Parser output still treats it as
 * untrusted input and strips active/external capabilities a second time.
 */
export function sanitizeSvgFragment(fragment) {
  const document = parseHtml(String(fragment ?? ""));
  const source = document.html;
  const svg = document.nodes.find((node) => node.tag === "svg");
  if (!svg) return "";

  const serializeText = (value) => escapeHtml(decodeHtmlEntities(value));
  const insideForeignObject = (node) => {
    let current = node.parent;
    while (current && current !== svg.parent) {
      if (current.tag === "foreignobject") return true;
      current = current.parent;
    }
    return false;
  };
  const serializeChildren = (node) => {
    const end = node.closeStart ?? node.end ?? node.openEnd;
    let cursor = node.openEnd;
    let result = "";
    for (const child of node.children ?? []) {
      if (child.start < cursor || child.start > end) continue;
      result += serializeText(source.slice(cursor, child.start));
      result += serializeNode(child);
      cursor = Math.min(child.end ?? child.closeStart ?? child.openEnd, end);
    }
    result += serializeText(source.slice(cursor, end));
    return result;
  };
  const serializeNeutralNode = (node, behavior) => {
    const htmlContext = insideForeignObject(node);
    const outputTag = htmlContext ? richNeutralTag(node) : "g";
    const attributes = [
      `class="${behavior ? "cloudig-inert-element" : "cloudig-unknown-element"}"`,
      `data-cloudig-original-tag="${escapeHtml(node.tag)}"`
    ];
    if (htmlContext) {
      attributes.push(...richSourceAttributes(node).filter((attribute) =>
        !attribute.startsWith("title=") && !attribute.startsWith("aria-label=")));
    } else {
      for (const [name, value] of Object.entries(node.attrs ?? {})) {
        const safe = safeSvgAttribute(node.tag, name, value);
        if (safe) attributes.push(`${safe[0]}="${escapeHtml(safe[1])}"`);
      }
      const sourceHref = inertSvgUrlEvidence(node);
      if (sourceHref) {
        attributes.push(`data-cloudig-source-href="${escapeHtml(sourceHref)}"`);
      }
    }
    attributes.sort((left, right) => left.localeCompare(right, "en"));
    const evidence = htmlContext ? serializeRichEvidence(node) : "";
    const children = serializeChildren(node);
    const content = evidence && children ? `${evidence} ${children}` : evidence || children;
    return `<${outputTag} ${attributes.join(" ")}>${content}</${outputTag}>`;
  };
  const serializeNode = (node) => {
    if (REMOVED_SVG_TAGS.has(node.tag)) return "";
    if (
      ACTIVE_SVG_TAGS.has(node.tag)
      || (insideForeignObject(node) && INERT_RICH_HTML_TAGS.has(node.tag))
    ) {
      return serializeNeutralNode(node, true);
    }
    if (!SAFE_SVG_TAGS.has(node.tag)) return serializeNeutralNode(node, false);
    if (insideForeignObject(node) && SAFE_RICH_HTML_TAGS.has(node.tag)) {
      const attributes = richSourceAttributes(node);
      if (node.tag === "a" && /^https?:\/\//iu.test(String(node.attrs?.href ?? ""))) {
        const href = safeHttpUrl(node.attrs.href);
        if (href) attributes.push(`href="${escapeHtml(href)}"`);
      }
      if (node.tag === "ol" && /^[1-9]\d{0,5}$/u.test(String(node.attrs?.start ?? ""))) {
        attributes.push(`start="${node.attrs.start}"`);
      }
      if (node.tag === "li" && /^-?\d{1,6}$/u.test(String(node.attrs?.value ?? ""))) {
        attributes.push(`value="${node.attrs.value}"`);
      }
      if (["td", "th"].includes(node.tag)) {
        for (const name of ["rowspan", "colspan"]) {
          if (/^[1-9]\d{0,2}$/u.test(String(node.attrs?.[name] ?? ""))) {
            attributes.push(`${name}="${node.attrs[name]}"`);
          }
        }
      }
      attributes.sort((left, right) => left.localeCompare(right, "en"));
      const open = `<${node.tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
      return VOID_ELEMENTS.has(node.tag) ? open : `${open}${serializeChildren(node)}</${node.tag}>`;
    }
    const attributes = [];
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      const safe = safeSvgAttribute(node.tag, name, value);
      if (!safe) continue;
      attributes.push(`${safe[0]}="${escapeHtml(safe[1])}"`);
    }
    const sourceHref = inertSvgUrlEvidence(node);
    if (sourceHref) {
      attributes.push(`data-cloudig-source-href="${escapeHtml(sourceHref)}"`);
    }
    attributes.sort((left, right) => left.localeCompare(right, "en"));
    const tag = SVG_TAG_CASE.get(node.tag) ?? node.tag;
    const open = `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
    if (VOID_ELEMENTS.has(node.tag)) return open;
    return `${open}${serializeChildren(node)}</${tag}>`;
  };
  return serializeNode(svg);
}
