import type { JsonObject } from "../../core/contracts/types.mts";

type MarkdownLine = Readonly<{ body: string; eol: string; raw: string }>;

export function normalizeMermaidSource(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]{2,}/gu, " "))
    .join("\n")
    .trim();
}

function markdownLines(value: string): MarkdownLine[] {
  const result: MarkdownLine[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    let end = cursor;
    while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end += 1;
    let eol = "";
    if (end < value.length) eol = value[end] === "\r" && value[end + 1] === "\n" ? "\r\n" : value[end]!;
    const body = value.slice(cursor, end);
    result.push({ body, eol, raw: `${body}${eol}` });
    cursor = end + eol.length;
  }
  return result;
}

function fenceMarker(line: string): Readonly<{ character: string; length: number; info: string }> | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/u.exec(line);
  return match ? { character: match[1]![0]!, length: match[1]!.length, info: match[2]!.trim() } : undefined;
}

function closesFence(line: string, fence: Readonly<{ character: string; length: number }>): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
  return Boolean(match && match[1]![0] === fence.character && match[1]!.length >= fence.length);
}

function stripOneTerminalEol(value: string): string {
  return value.replace(/(?:\r\n|\r|\n)$/u, "");
}

export function projectMarkdownWithDiagrams(
  value: string,
  resolveMermaid?: (source: string) => string | undefined
): JsonObject[] {
  const lines = markdownLines(value);
  const result: JsonObject[] = [];
  const markdown: string[] = [];
  let outerFence: Readonly<{ character: string; length: number; info: string }> | undefined;
  const flush = (): void => {
    const text = markdown.join("");
    markdown.length = 0;
    if (text.trim().length > 0) result.push({ type: "markdown", text });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (outerFence) {
      markdown.push(line.raw);
      if (closesFence(line.body, outerFence)) outerFence = undefined;
      continue;
    }
    const opening = fenceMarker(line.body);
    if (opening) {
      if (/^mermaid(?:\s|$)/iu.test(opening.info)) {
        let closing = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          if (closesFence(lines[cursor]!.body, opening)) {
            closing = cursor;
            break;
          }
        }
        if (closing >= 0) {
          flush();
          const source = stripOneTerminalEol(lines.slice(index + 1, closing).map((entry) => entry.raw).join(""));
          const rendered = resolveMermaid?.(source);
          result.push({ type: "diagram", format: "mermaid", source, ...(rendered ? { rendered } : {}) });
          index = closing;
          continue;
        }
      }
      outerFence = opening;
      markdown.push(line.raw);
      continue;
    }
    if (!/^ {0,3}:::writing(?:\{[^\r\n]*\})?[ \t]*$/u.test(line.body)) {
      markdown.push(line.raw);
      continue;
    }
    let innerFence: Readonly<{ character: string; length: number; info: string }> | undefined;
    let closing = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!;
      if (innerFence) {
        if (closesFence(candidate.body, innerFence)) innerFence = undefined;
        continue;
      }
      const nested = fenceMarker(candidate.body);
      if (nested) {
        innerFence = nested;
        continue;
      }
      if (/^ {0,3}:::[ \t]*$/u.test(candidate.body)) {
        closing = cursor;
        break;
      }
    }
    if (closing < 0) {
      markdown.push(line.raw);
      continue;
    }
    flush();
    const source = stripOneTerminalEol(lines.slice(index + 1, closing).map((entry) => entry.raw).join(""));
    if (source.trim().length > 0) result.push({ type: "diagram", format: "writing-block", source });
    index = closing;
  }
  flush();
  return result;
}
