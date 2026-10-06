import type { Readable } from "node:stream";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { parseRecordJson } from "../../core/records/json.mts";

type Frame = { value: JsonObject | JsonValue[]; array: boolean; retain: boolean; state: "first" | "key" | "colon" | "value" | "after"; path: (string | number)[]; position: number; key?: string; keys?: Set<string> };

export type JsonStringSink = Readonly<{
  raw(fragment: string): void;
  end(span: Readonly<{ offset: number; length: number }>): void;
}>;
export type JsonStreamHooks = Readonly<{
  string(path: readonly (string | number)[], offset: number): JsonStringSink | undefined;
  /** Metadata probes may retain only these root keys, without materializing message/resource bodies. */
  rootKeys?: readonly string[];
  afterChunk?(): void | Promise<void>;
}>;

// The result still owns its JSON values, but the input is never also held as one
// complete UTF-8 Buffer and UTF-16 document. Scratch space is one input chunk and
// one scalar token. File reads give cancellation a checkpoint between chunks.
export async function parseStreamingJson(source: Readable, signal?: AbortSignal, hooks?: JsonStreamHooks): Promise<JsonValue> {
  // Preserve BOM in decoded input so all byte spans include its three bytes.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const stack: Frame[] = [];
  let result: JsonValue | undefined;
  let complete = false;
  let mode: "string" | "atom" | undefined;
  let escaped = false;
  let parts: string[] = [];
  let byteOffset = 0, stringOffset = 0;
  let sink: JsonStringSink | undefined;
  const discardString: JsonStringSink = { raw() {}, end() {} };
  const retainPath = (path: readonly (string | number)[]) => !hooks?.rootKeys || path.length === 0 || hooks.rootKeys.includes(String(path[0]));
  const invalid = (): never => { throw new SyntaxError("Invalid streamed JSON structure"); };
  const expectingValue = () => {
    const frame = stack.at(-1);
    return frame ? frame.state === "value" || (frame.array && frame.state === "first") : !complete;
  };
  const nextPath = (): (string | number)[] => {
    const frame = stack.at(-1); return frame ? [...frame.path, frame.array ? frame.position : frame.key!] : [];
  };
  const value = (entry: JsonValue, skip = false) => {
    if (!expectingValue()) invalid();
    const frame = stack.at(-1);
    if (!frame) { result = entry; complete = true; return; }
    if (frame.array) { if (frame.retain && !skip) (frame.value as JsonValue[]).push(entry); frame.position++; }
    else if (frame.retain && retainPath(nextPath())) Object.defineProperty(frame.value, frame.key!, { value: entry, writable: true, enumerable: true, configurable: true });
    frame.state = "after";
    delete frame.key;
  };
  const scalar = (literal: string, string: boolean) => {
    const entry: JsonValue = string ? JSON.parse(literal) : parseRecordJson(literal);
    if (typeof entry === "string" && !entry.isWellFormed()) throw new SyntaxError("Invalid Unicode in streamed JSON");
    const frame = stack.at(-1);
    if (string && frame && !frame.array && (frame.state === "first" || frame.state === "key")) {
      if (frame.keys!.has(entry as string)) throw new SyntaxError("Duplicate object key in streamed JSON");
      frame.keys!.add(entry as string); frame.key = entry as string; frame.state = "colon";
    } else value(entry);
  };
  const punctuation = (character: string) => {
    const frame = stack.at(-1);
    if (character === "{" || character === "[") {
      if (!expectingValue()) invalid();
      if (stack.length >= 512) throw new RangeError("JSON nesting exceeds the supported depth");
      stack.push({ value: character === "[" ? [] : {}, array: character === "[", retain: retainPath(nextPath()), state: "first", path: nextPath(), position: 0, ...(character === "{" ? { keys: new Set<string>() } : {}) });
    } else if (character === "}" || character === "]") {
      if (!frame || frame.array !== (character === "]") || !["first", "after"].includes(frame.state)) invalid();
      stack.pop(); value(frame!.value);
    } else if (character === ":") {
      if (!frame || frame.array || frame.state !== "colon") invalid();
      frame!.state = "value";
    } else {
      if (!frame || frame.state !== "after") invalid();
      frame!.state = frame!.array ? "value" : "key";
    }
  };
  const consume = (chunk: string) => {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index]!;
      const here = byteOffset, code = chunk.charCodeAt(index);
      byteOffset += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : code >= 0xdc00 && code <= 0xdfff ? 0 : 3;
      if (here === 0 && code === 0xfeff) continue;
      if (mode === "string") {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') {
          if (sink) { sink.raw(chunk.slice(start, index)); sink.end({ offset: stringOffset, length: byteOffset - stringOffset }); sink = undefined; value(null, true); }
          else { parts.push(chunk.slice(start, index + 1)); scalar(parts.join(""), true); parts = []; }
          mode = undefined;
        }
        continue;
      }
      if (mode === "atom") {
        if (!/[\s{}\[\],:]/u.test(character)) continue;
        parts.push(chunk.slice(start, index)); scalar(parts.join(""), false); parts = []; mode = undefined;
      }
      if (/[ \t\r\n]/u.test(character)) continue;
      if ("{}[],:".includes(character)) { punctuation(character); continue; }
      start = index;
      mode = character === '"' ? "string" : "atom";
      if (mode === "string" && expectingValue()) { stringOffset = here; sink = retainPath(nextPath()) ? hooks?.string(nextPath(), here) : discardString; if (sink) start++; }
    }
    if (mode) { if (sink) sink.raw(chunk.slice(start)); else parts.push(chunk.slice(start)); }
  };
  for await (const raw of source) {
    signal?.throwIfAborted();
    consume(decoder.decode(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), { stream: true }));
    await hooks?.afterChunk?.();
  }
  consume(decoder.decode());
  await hooks?.afterChunk?.();
  signal?.throwIfAborted();
  if (mode === "atom") scalar(parts.join(""), false);
  else if (mode === "string") invalid();
  if (stack.length || !complete) invalid();
  return result!;
}
