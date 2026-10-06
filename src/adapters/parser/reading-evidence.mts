import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import type { ByteFingerprint } from "../storage/stream.mts";
import { inertStandaloneSvg } from "./inert-html.mts";

const CARD_CLASS = "osis-mermaid-card";
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function parseAttributes(startTag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of startTag.matchAll(pattern)) result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
  return result;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\"",
    nbsp: " "
  };
  return value.replace(/&(?:#([0-9]+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/giu, (whole, decimal, hexadecimal, name) => {
    if (decimal) {
      const point = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    if (hexadecimal) {
      const point = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return named[String(name).toLowerCase()] ?? whole;
  });
}

function firstTag(card: string, name: string): string | undefined {
  const start = card.indexOf(`<${name}`);
  if (start < 0) return undefined;
  let quote: string | undefined;
  for (let index = start; index < card.length; index += 1) {
    const character = card[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return card.slice(start, index + 1);
    }
  }
  return undefined;
}

function startTagEnd(value: string, state: { quote?: string }): number | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (state.quote) {
      if (character === state.quote) delete state.quote;
    } else if (character === "\"" || character === "'") {
      state.quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return undefined;
}

function parseCard(card: string, messageId: string | undefined, messageVersion?: string): Readonly<{
  messageId: string;
  messageVersion?: string;
  resourceKey?: string;
  source: string;
  dataUrl: string;
}> | undefined {
  if (!messageId) return undefined;
  const imageTag = firstTag(card, "img");
  const image = imageTag ? parseAttributes(imageTag) : {};
  const codeMatch = /<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/iu.exec(card);
  const source = codeMatch ? decodeHtmlEntities(codeMatch[1]!.replace(/<[^>]+>/gu, "")) : undefined;
  const inlineSvg = /<svg(?:\s[^>]*)?>[\s\S]*?<\/svg>/iu.exec(card)?.[0];
  const inertSvg = inlineSvg ? inertStandaloneSvg(inlineSvg) : undefined;
  const dataUrl = image["src"]
    ? decodeHtmlEntities(image["src"])
    : inertSvg
      ? `data:image/svg+xml;utf8,${encodeURIComponent(inertSvg)}`
      : undefined;
  return source && dataUrl?.startsWith("data:image/") ? { messageId, ...(messageVersion ? { messageVersion } : {}),
    ...(image["data-resource-key"] ? { resourceKey: decodeHtmlEntities(image["data-resource-key"]) } : {}), source, dataUrl } : undefined;
}

export function extractMermaidCardsFromFragment(
  fragment: string,
  messageId: string,
  messageVersion?: string
): readonly Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; source: string; dataUrl: string }>[] {
  const records: Array<Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; source: string; dataUrl: string }>> = [];
  let cursor = 0;
  while (cursor < fragment.length) {
    const start = fragment.indexOf("<section", cursor);
    if (start < 0) break;
    const tag = firstTag(fragment.slice(start), "section");
    if (!tag) break;
    const attrs = parseAttributes(tag);
    const classes = new Set((attrs["class"] ?? "").split(/\s+/u).filter(Boolean));
    if (!classes.has(CARD_CLASS)) {
      cursor = start + tag.length;
      continue;
    }
    const close = fragment.indexOf("</section>", start + tag.length);
    if (close < 0) throw new TypeError("Rendered turn ended inside a Mermaid reading card");
    const card = fragment.slice(start, close + "</section>".length);
    const record = parseCard(card, messageId, messageVersion);
    if (record) records.push(record);
    cursor = close + "</section>".length;
  }
  return records;
}

export async function extractStaticReadingEvidence(
  source: Readable,
  signal?: AbortSignal
): Promise<Readonly<{
  mermaid: readonly Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; source: string; dataUrl: string }>[];
  images: readonly Readonly<{
    messageId: string;
    messageVersion?: string;
    resourceKey?: string;
    dataUrl: string;
    alt?: string;
    width?: number;
    height?: number;
  }>[];
  files: readonly Readonly<{
    messageId: string;
    messageVersion?: string;
    resourceKey?: string;
    dataUrl: string;
    name?: string;
  }>[];
  fragments: readonly Readonly<{
    messageId: string;
    messageVersion?: string;
    html: string;
  }>[];
  fingerprint: ByteFingerprint;
}>> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const records: Array<Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; source: string; dataUrl: string }>> = [];
  const images: Array<Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; dataUrl: string; alt?: string; width?: number; height?: number }>> = [];
  const files: Array<Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; dataUrl: string; name?: string }>> = [];
  const fragments: Array<Readonly<{ messageId: string; messageVersion?: string; html: string }>> = [];
  let bytes = 0;
  let buffer = "";
  const tagState: { quote?: string } = {};
  let partialTag: string[] = [];
  let currentMessageId: string | undefined;
  let currentMessageVersion: string | undefined;
  const ownerStack: Array<{ tag: string; previousId?: string; previousVersion?: string }> = [];
  let captured = "";
  let capturing = false;
  let skipTag: "script" | "style" | undefined;
  let retainSvgStyle = false;
  let messageCapture: { messageId: string; messageVersion?: string; rootTag: string; depth: number; chunks: string[] } | undefined;

  const appendMessage = (value: string): void => {
    if (!messageCapture || value.length === 0) return;
    // Full resources and source text have no artificial per-tag/message cap.
    // Keep streaming pieces until this owned message is complete; worker
    // admission controls concurrency without discarding legitimate content.
    messageCapture.chunks.push(value);
  };

  const finishMessage = (): void => {
    if (!messageCapture) return;
    fragments.push({ messageId: messageCapture.messageId, ...(messageCapture.messageVersion ? { messageVersion: messageCapture.messageVersion } : {}), html: messageCapture.chunks.join("") });
    messageCapture = undefined;
  };

  const process = (final = false): void => {
    while (true) {
      if (skipTag) {
        const marker = `</${skipTag}>`;
        const close = buffer.toLowerCase().indexOf(marker);
        if (close < 0) {
          const retain = final ? 0 : marker.length - 1;
          if (retainSvgStyle) appendMessage(buffer.slice(0, Math.max(0, buffer.length - retain)));
          buffer = buffer.slice(Math.max(0, buffer.length - retain));
          return;
        }
        if (retainSvgStyle) appendMessage(buffer.slice(0, close + marker.length));
        buffer = buffer.slice(close + marker.length);
        skipTag = undefined;
        retainSvgStyle = false;
        continue;
      }
      if (capturing) {
        const close = buffer.indexOf("</section>");
        if (close < 0) {
          const retain = final ? 0 : "</section>".length - 1;
          const safe = Math.max(0, buffer.length - retain);
          const piece = buffer.slice(0, safe);
          captured += piece;
          appendMessage(piece);
          buffer = buffer.slice(safe);
          return;
        }
        const piece = buffer.slice(0, close + "</section>".length);
        captured += piece;
        appendMessage(piece);
        if (messageCapture) messageCapture.depth -= 1;
        const record = parseCard(captured, currentMessageId, currentMessageVersion);
        if (record) records.push(record);
        buffer = buffer.slice(close + "</section>".length);
        captured = "";
        capturing = false;
        continue;
      }

      const start = partialTag.length ? 0 : buffer.indexOf("<");
      if (start < 0) {
        const safe = final ? buffer.length : Math.max(0, buffer.length - 1);
        appendMessage(buffer.slice(0, safe));
        buffer = final ? "" : buffer.slice(safe);
        return;
      }
      appendMessage(buffer.slice(0, start));
      buffer = buffer.slice(start);
      if (!partialTag.length && buffer.startsWith("<!--")) {
        const close = buffer.indexOf("-->");
        if (close < 0) return;
        buffer = buffer.slice(close + 3);
        continue;
      }
      const end = startTagEnd(buffer, tagState);
      if (end === undefined) {
        // Data-URL attributes can span megabytes. Keep their chunks and quote
        // state, scanning each character once instead of rescanning/copying the
        // whole growing tag after every 64 KiB read (quadratic on Full exports).
        if (final) throw new TypeError("HTML ended inside a start tag");
        partialTag.push(buffer);
        buffer = "";
        return;
      }
      const tag = partialTag.length ? [...partialTag, buffer.slice(0, end + 1)].join("") : buffer.slice(0, end + 1);
      partialTag = [];
      buffer = buffer.slice(end + 1);
      const closing = /^<\s*\/\s*([a-z0-9:-]+)/iu.exec(tag);
      if (closing) {
        const name = closing[1]!.toLowerCase();
        if (messageCapture) {
          if (name === messageCapture.rootTag && messageCapture.depth === 1) finishMessage();
          else {
            appendMessage(tag);
            messageCapture.depth = Math.max(1, messageCapture.depth - 1);
          }
        }
        for (let index = ownerStack.length - 1; index >= 0; index -= 1) {
          if (ownerStack[index]!.tag !== name) continue;
          const entry = ownerStack[index]!;
          ownerStack.length = index;
          currentMessageId = entry.previousId;
          currentMessageVersion = entry.previousVersion;
          break;
        }
        continue;
      }
      const opening = /^<\s*([a-z0-9:-]+)/iu.exec(tag);
      if (!opening) continue;
      const name = opening[1]!.toLowerCase();
      const attrs = parseAttributes(tag);
      const owner = attrs["data-message-id"] ?? attrs["data-source-id"];
      const ownerVersion = attrs["data-message-version"];
      const previousId = currentMessageId;
      const previousVersion = currentMessageVersion;
      if (owner) {
        currentMessageId = decodeHtmlEntities(owner);
        currentMessageVersion = ownerVersion ? decodeHtmlEntities(ownerVersion) : undefined;
      }
      if (name === "script" || name === "style") {
        skipTag = name;
        // SVG styles are the figure's paint/label metrics, not page chrome.
        // Div-based cards were previously stripped here before the Adapter
        // ever saw them, while section cards happened to retain their styles.
        retainSvgStyle = name === "style" && Boolean(messageCapture) && ownerStack.some(entry => entry.tag === "svg");
        if (retainSvgStyle) appendMessage(tag);
        continue;
      }
      const isVoid = VOID_TAGS.has(name) || /\/\s*>$/u.test(tag);
      if (name === "article" && owner && !messageCapture) {
        messageCapture = {
          messageId: decodeHtmlEntities(owner),
          ...(ownerVersion ? { messageVersion: decodeHtmlEntities(ownerVersion) } : {}),
          rootTag: name,
          depth: 1,
          chunks: []
        };
      } else if (messageCapture) {
        appendMessage(tag);
        if (!isVoid) messageCapture.depth += 1;
      }
      const classes = new Set((attrs["class"] ?? "").split(/\s+/u).filter(Boolean));
      if (name === "section" && classes.has(CARD_CLASS)) {
        captured = tag;
        capturing = true;
        continue;
      }
      if (name === "img" && currentMessageId) {
        const dataUrl = attrs["src"] ? decodeHtmlEntities(attrs["src"]) : undefined;
        if (dataUrl?.startsWith("data:image/")) {
          const width = Number.parseInt(attrs["width"] ?? "", 10);
          const height = Number.parseInt(attrs["height"] ?? "", 10);
          images.push({
            messageId: currentMessageId,
            ...(currentMessageVersion ? { messageVersion: currentMessageVersion } : {}),
            ...(attrs["data-resource-key"] ? { resourceKey: decodeHtmlEntities(attrs["data-resource-key"]) } : {}),
            dataUrl,
            ...(attrs["alt"] ? { alt: decodeHtmlEntities(attrs["alt"]) } : {}),
            ...(Number.isSafeInteger(width) && width > 0 ? { width } : {}),
            ...(Number.isSafeInteger(height) && height > 0 ? { height } : {})
          });
        }
      }
      if (name === "a" && currentMessageId) {
        const dataUrl = attrs["href"] ? decodeHtmlEntities(attrs["href"]) : undefined;
        if (dataUrl?.startsWith("data:") && /;base64,/iu.test(dataUrl)) {
          files.push({
            messageId: currentMessageId,
            ...(currentMessageVersion ? { messageVersion: currentMessageVersion } : {}),
            ...(attrs["data-resource-key"] ? { resourceKey: decodeHtmlEntities(attrs["data-resource-key"]) } : {}),
            dataUrl,
            ...(attrs["download"] ? { name: decodeHtmlEntities(attrs["download"]) } : {})
          });
        }
      }
      if (!isVoid) ownerStack.push({ tag: name, ...(previousId ? { previousId } : {}), ...(previousVersion ? { previousVersion } : {}) });
    }
  };

  for await (const raw of source) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(chunk);
    bytes += chunk.byteLength;
    buffer += decoder.decode(chunk, { stream: true });
    process();
  }
  buffer += decoder.decode();
  process(true);
  if (capturing) throw new TypeError("HTML ended inside a Mermaid reading card");
  if (skipTag) throw new TypeError(`HTML ended inside a ${skipTag} element`);
  if (messageCapture) throw new TypeError("HTML ended inside a message reading fragment");
  return { mermaid: records, images, files, fragments, fingerprint: { bytes, sha256: hash.digest("hex") } };
}
