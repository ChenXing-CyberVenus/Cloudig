import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";

import { assertJsonValue } from "../../core/contracts/deterministic-json.mts";
import { parseRecordJson } from "../../core/records/json.mts";
import type { JsonValue } from "../../core/contracts/types.mts";
import type { ByteFingerprint } from "../storage/stream.mts";

const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

export type JsonArrayRange = Readonly<{
  index: number;
  offset: number;
  length: number;
}>;

function whitespace(byte: number): boolean {
  return ASCII_WHITESPACE.has(byte);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

export async function* streamTopLevelJsonArrayRanges(
  source: Readable,
  options: Readonly<{
    signal?: AbortSignal;
    maxItems?: number;
    onProgress?: (completedBytes: number, completedItems: number) => void;
  }> = {}
): AsyncGenerator<JsonArrayRange> {
  const maxItems = options.maxItems ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) throw new TypeError("maxItems must be a positive safe integer");
  let absoluteOffset = 0;
  let arrayStarted = false;
  let arrayClosed = false;
  let itemStarted = false;
  let itemOffset = 0;
  let lastNonWhitespaceEnd = 0;
  let nesting = 0;
  let inString = false;
  let escaped = false;
  let index = 0;
  let valueExpected = true;

  const finish = (): JsonArrayRange => {
    const length = lastNonWhitespaceEnd - itemOffset;
    if (length < 1) throw new SyntaxError(`Top-level JSON array item ${index} is empty`);
    const result = { index, offset: itemOffset, length };
    index += 1;
    itemStarted = false;
    nesting = 0;
    inString = false;
    escaped = false;
    valueExpected = false;
    return result;
  };

  throwIfAborted(options.signal);
  for await (const raw of source) {
    throwIfAborted(options.signal);
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let nextQuote = -1;
    let nextEscape = -1;
    for (let cursor = 0; cursor < chunk.byteLength; cursor += 1) {
      if ((cursor & 0xffff) === 0) throwIfAborted(options.signal);
      const byte = chunk[cursor]!;
      const currentOffset = absoluteOffset + cursor;
      if (arrayClosed) {
        if (!whitespace(byte)) throw new SyntaxError(`Unexpected data after top-level JSON array at byte ${currentOffset}`);
        continue;
      }
      if (!arrayStarted) {
        if (whitespace(byte)) continue;
        if (byte !== 0x5b) throw new SyntaxError(`Expected a top-level JSON array at byte ${currentOffset}`);
        arrayStarted = true;
        continue;
      }
      if (!itemStarted) {
        if (whitespace(byte)) continue;
        if (byte === 0x5d) {
          if (valueExpected && index > 0) throw new SyntaxError(`Top-level JSON array has a trailing comma at byte ${currentOffset}`);
          arrayClosed = true;
          continue;
        }
        if (byte === 0x2c) {
          if (valueExpected) throw new SyntaxError(`Unexpected comma in top-level JSON array at byte ${currentOffset}`);
          valueExpected = true;
          continue;
        }
        if (!valueExpected) throw new SyntaxError(`Expected a comma in top-level JSON array at byte ${currentOffset}`);
        if (index >= maxItems) throw new RangeError(`Top-level JSON array exceeds the configured item count before item ${index}`);
        itemStarted = true;
        itemOffset = currentOffset;
        lastNonWhitespaceEnd = currentOffset + 1;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
          lastNonWhitespaceEnd = currentOffset + 1;
          continue;
        }
        // Most export bytes are text/base64 inside strings. Native byte search
        // skips those spans; cached delimiters avoid repeatedly searching the
        // same long suffix when quotes and escapes have different densities.
        if (nextQuote < cursor) { const found = chunk.indexOf(0x22, cursor); nextQuote = found < 0 ? chunk.length : found; }
        if (nextEscape < cursor) { const found = chunk.indexOf(0x5c, cursor); nextEscape = found < 0 ? chunk.length : found; }
        cursor = Math.min(nextQuote, nextEscape);
        if (cursor === chunk.length) {
          lastNonWhitespaceEnd = absoluteOffset + cursor;
          break;
        }
        if (chunk[cursor] === 0x5c) escaped = true;
        else inString = false;
        lastNonWhitespaceEnd = absoluteOffset + cursor + 1;
        continue;
      }
      if (byte === 0x22) {
        inString = true;
        lastNonWhitespaceEnd = currentOffset + 1;
        continue;
      }
      if (byte === 0x7b || byte === 0x5b) {
        nesting += 1;
        lastNonWhitespaceEnd = currentOffset + 1;
        continue;
      }
      if (byte === 0x7d) {
        if (nesting < 1) throw new SyntaxError(`Unexpected object close at byte ${currentOffset}`);
        nesting -= 1;
        lastNonWhitespaceEnd = currentOffset + 1;
        continue;
      }
      if (byte === 0x5d) {
        if (nesting > 0) {
          nesting -= 1;
          lastNonWhitespaceEnd = currentOffset + 1;
          continue;
        }
        const completed = finish();
        yield completed;
        arrayClosed = true;
        continue;
      }
      if (byte === 0x2c && nesting === 0) {
        const completed = finish();
        valueExpected = true;
        yield completed;
        continue;
      }
      if (!whitespace(byte)) lastNonWhitespaceEnd = currentOffset + 1;
    }
    absoluteOffset += chunk.byteLength;
    options.onProgress?.(absoluteOffset, index);
  }
  throwIfAborted(options.signal);
  if (!arrayStarted) throw new SyntaxError("JSON input ended before a top-level array began");
  if (itemStarted) throw new SyntaxError(`JSON input ended inside top-level array item ${index}`);
  if (!arrayClosed) throw new SyntaxError("JSON input ended before the top-level array closed");
}

export async function readJsonRange(
  filePath: string,
  range: Pick<JsonArrayRange, "offset" | "length">,
  options: Readonly<{
    signal?: AbortSignal;
    onProgress?: (completedBytes: number) => void;
  }> = {}
): Promise<Readonly<{ bytes: Buffer; fingerprint: ByteFingerprint }>> {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 1) {
    throw new TypeError("JSON range offset and length must be positive safe integers");
  }
  const handle = await open(filePath, "r");
  const bytes = Buffer.allocUnsafe(range.length);
  const hash = createHash("sha256");
  let completed = 0;
  try {
    while (completed < bytes.byteLength) {
      throwIfAborted(options.signal);
      const result = await handle.read(bytes, completed, bytes.byteLength - completed, range.offset + completed);
      if (result.bytesRead < 1) throw new RangeError("JSON range ended before the indexed value was complete");
      hash.update(bytes.subarray(completed, completed + result.bytesRead));
      completed += result.bytesRead;
      options.onProgress?.(completed);
    }
    throwIfAborted(options.signal);
    return { bytes, fingerprint: { bytes: completed, sha256: hash.digest("hex") } };
  } finally {
    await handle.close();
  }
}

export async function parseJsonRange(
  filePath: string,
  range: JsonArrayRange,
  options: Readonly<{ signal?: AbortSignal; onProgress?: (completedBytes: number) => void }> = {}
): Promise<Readonly<{ value: JsonValue; fingerprint: ByteFingerprint }>> {
  const read = await readJsonRange(filePath, range, options);
  let value: unknown;
  try {
    value = parseRecordJson(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
  } catch (error) {
    throw new SyntaxError(`Invalid JSON in top-level array item ${range.index} at byte ${range.offset}`, { cause: error });
  }
  assertJsonValue(value);
  return { value, fingerprint: read.fingerprint };
}
