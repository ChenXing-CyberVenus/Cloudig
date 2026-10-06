import { createHash } from "node:crypto";
import type { JsonValue } from "../contracts/types.mts";
import { validateRecord, type RecordKind } from "./index.mts";
import { CLOUDIG_STANDARD } from "./schema-registry.mts";

export const RECORD_ENCODING_LIMITS = Object.freeze({ textChunkCharacters: 65_536 });
type Frame = { value: JsonValue; depth: number; index?: number; keys?: string[] };

function* quoted(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + RECORD_ENCODING_LIMITS.textChunkCharacters);
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end;
  }
  yield '"';
}

function* fragments(value: JsonValue): Generator<string> {
  const stack: Frame[] = [{ value, depth: 0 }];
  while (stack.length) {
    const frame = stack.at(-1)!, v = frame.value;
    if (v === null || typeof v !== "object") {
      if (typeof v === "string") yield* quoted(v);
      else { const encoded = JSON.stringify(v); if (encoded === undefined) throw new TypeError("Cannot encode a non-JSON root or value"); yield encoded; }
      stack.pop(); continue;
    }
    const array = Array.isArray(v);
    if (frame.index === undefined) {
      // Runtime projections use ordinary optional object fields. Match JSON.stringify:
      // omit undefined object properties and encode absent array positions as null.
      frame.index = 0; if (!array) frame.keys = Object.keys(v).filter(key => (v as Record<string, JsonValue | undefined>)[key] !== undefined);
      yield array ? "[" : "{";
    }
    const length = array ? v.length : frame.keys!.length;
    if (frame.index === length) {
      if (length) yield `\n${"  ".repeat(frame.depth)}`;
      yield array ? "]" : "}"; stack.pop(); continue;
    }
    yield `${frame.index ? "," : ""}\n${"  ".repeat(frame.depth + 1)}`;
    const key = array ? frame.index : frame.keys![frame.index]!;
    if (!array) { yield* quoted(String(key)); yield ": "; }
    frame.index++;
    const child = (v as Record<string | number, JsonValue | undefined>)[key];
    stack.push({ value: child === undefined && array ? null : child!, depth: frame.depth + 1 });
  }
  yield "\n";
}

/** Same bytes as JSON.stringify(value, null, 2) + LF, without a whole document copy. */
export function* recordJsonChunks(value: JsonValue): Generator<string> {
  let parts: string[] = [], length = 0;
  for (const part of fragments(value)) {
    if (length && length + part.length > RECORD_ENCODING_LIMITS.textChunkCharacters) { yield parts.join(""); parts = []; length = 0; }
    // Escaping a 64K source string may produce a larger chunk, but remains
    // bounded by six times that input size, never by the whole document.
    if (part.length >= RECORD_ENCODING_LIMITS.textChunkCharacters) yield part;
    else { parts.push(part); length += part.length; }
  }
  if (parts.length) yield parts.join("");
}

export function prepareRecordEncoding(kind: RecordKind, value: unknown): Readonly<{
  fingerprint: Readonly<{ bytes: number; sha256: string }>; chunks(): Generator<string>;
}> {
  const valid = validateRecord(kind, value);
  if (!valid.ok) throw new TypeError(valid.issues.map(i => `${i.path}: ${i.message}`).join("; "));
  const output = kind === "library" ? { cloudig_standard: CLOUDIG_STANDARD, ...valid.value } : valid.value;
  const digest = createHash("sha256"); let bytes = 0;
  for (const chunk of recordJsonChunks(output)) { digest.update(chunk, "utf8"); bytes += Buffer.byteLength(chunk); }
  return { fingerprint: { bytes, sha256: digest.digest("hex") }, chunks: () => recordJsonChunks(output) };
}
