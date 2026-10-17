import { open } from "node:fs/promises";

const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

function isWhitespace(byte) {
  return ASCII_WHITESPACE.has(byte);
}

function trimTrailingWhitespace(buffer) {
  let end = buffer.length;
  while (end > 0 && isWhitespace(buffer[end - 1])) end -= 1;
  return end === buffer.length ? buffer : buffer.subarray(0, end);
}

function asBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function throwIfAborted(signal, operation) {
  if (!signal?.aborted) return;
  const error = new Error(`${operation} was cancelled`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

/**
 * Stream the direct children of a top-level JSON array without buffering the
 * complete container. Delimiters are inspected as bytes, so UTF-8 characters
 * may cross input chunks safely. Each yielded offset and length identifies the
 * exact JSON value inside the original file.
 */
export async function* streamTopLevelJsonArray(source, options = {}) {
  const maxItemBytes = Number(options.maxItemBytes ?? 512 * 1024 * 1024);
  const maxItems = Number(options.maxItems ?? Number.MAX_SAFE_INTEGER);
  const signal = options.signal || null;
  if (!Number.isSafeInteger(maxItemBytes) || maxItemBytes < 1) {
    throw new TypeError("maxItemBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new TypeError("maxItems must be a positive safe integer");
  }

  let absoluteOffset = 0;
  let arrayStarted = false;
  let arrayClosed = false;
  let itemStarted = false;
  let itemOffset = 0;
  let itemBytes = 0;
  let segments = [];
  let nesting = 0;
  let inString = false;
  let escaped = false;
  let index = 0;
  let valueExpected = true;

  function append(buffer, start, end) {
    if (end <= start) return;
    const slice = buffer.subarray(start, end);
    itemBytes += slice.length;
    if (itemBytes > maxItemBytes) {
      throw new RangeError(`Top-level JSON array item ${index} exceeds ${maxItemBytes} bytes`);
    }
    segments.push(slice);
  }

  function finishItem() {
    const raw = trimTrailingWhitespace(Buffer.concat(segments, itemBytes));
    if (raw.length === 0) throw new SyntaxError(`Top-level JSON array item ${index} is empty`);
    const result = Object.freeze({ index, offset: itemOffset, length: raw.length, raw });
    index += 1;
    itemStarted = false;
    itemBytes = 0;
    segments = [];
    nesting = 0;
    inString = false;
    escaped = false;
    valueExpected = false;
    return result;
  }

  throwIfAborted(signal, "JSON array scan");
  for await (const chunkValue of source) {
    throwIfAborted(signal, "JSON array scan");
    const chunk = asBuffer(chunkValue);
    let segmentStart = itemStarted ? 0 : -1;

    for (let cursor = 0; cursor < chunk.length; cursor += 1) {
      if ((cursor & 0xffff) === 0) throwIfAborted(signal, "JSON array scan");
      const byte = chunk[cursor];
      const currentOffset = absoluteOffset + cursor;

      if (arrayClosed) {
        if (!isWhitespace(byte)) throw new SyntaxError(`Unexpected data after top-level JSON array at byte ${currentOffset}`);
        continue;
      }

      if (!arrayStarted) {
        if (isWhitespace(byte)) continue;
        if (byte !== 0x5b) throw new SyntaxError(`Expected a top-level JSON array at byte ${currentOffset}`);
        arrayStarted = true;
        valueExpected = true;
        continue;
      }

      if (!itemStarted) {
        if (isWhitespace(byte)) continue;
        if (byte === 0x5d) {
          if (!valueExpected && index === 0) throw new SyntaxError("Invalid empty JSON array state");
          if (valueExpected && index > 0) {
            throw new SyntaxError(`Top-level JSON array has a trailing comma at byte ${currentOffset}`);
          }
          arrayClosed = true;
          continue;
        }
        if (byte === 0x2c) {
          if (valueExpected) throw new SyntaxError(`Unexpected comma in top-level JSON array at byte ${currentOffset}`);
          valueExpected = true;
          continue;
        }
        if (!valueExpected) throw new SyntaxError(`Expected a comma in top-level JSON array at byte ${currentOffset}`);
        if (index >= maxItems) {
          const error = new RangeError(`Top-level JSON array exceeds the ${maxItems}-item limit before item ${index}`);
          error.code = "JSON_ARRAY_MAX_ITEMS";
          throw error;
        }
        itemStarted = true;
        itemOffset = currentOffset;
        itemBytes = 0;
        segments = [];
        nesting = 0;
        inString = false;
        escaped = false;
        segmentStart = cursor;
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
        continue;
      }

      if (byte === 0x22) {
        inString = true;
        continue;
      }
      if (byte === 0x7b || byte === 0x5b) {
        nesting += 1;
        continue;
      }
      if (byte === 0x7d) {
        if (nesting < 1) throw new SyntaxError(`Unexpected object close at byte ${currentOffset}`);
        nesting -= 1;
        continue;
      }
      if (byte === 0x5d) {
        if (nesting > 0) {
          nesting -= 1;
          continue;
        }
        append(chunk, segmentStart, cursor);
        segmentStart = -1;
        const completed = finishItem();
        yield completed;
        arrayClosed = true;
        continue;
      }
      if (byte === 0x2c && nesting === 0) {
        append(chunk, segmentStart, cursor);
        segmentStart = -1;
        const completed = finishItem();
        valueExpected = true;
        yield completed;
        continue;
      }
    }

    if (itemStarted && segmentStart >= 0) append(chunk, segmentStart, chunk.length);
    absoluteOffset += chunk.length;
    throwIfAborted(signal, "JSON array scan");
  }

  if (!arrayStarted) throw new SyntaxError("JSON input ended before a top-level array began");
  if (itemStarted) throw new SyntaxError(`JSON input ended inside top-level array item ${index}`);
  if (!arrayClosed) throw new SyntaxError("JSON input ended before the top-level array closed");
}

export function parseJsonArrayItem(item) {
  if (!item || !Buffer.isBuffer(item.raw)) throw new TypeError("A streamed JSON array item is required");
  try {
    return JSON.parse(item.raw.toString("utf8"));
  } catch (error) {
    throw new SyntaxError(`Invalid JSON in top-level array item ${item.index} at byte ${item.offset}: ${error.message}`, { cause: error });
  }
}

export async function readJsonSlice(filePath, offset, length, options = {}) {
  const maxBytes = Number(options.maxBytes ?? 512 * 1024 * 1024);
  const signal = options.signal || null;
  const onProgress = options.onProgress;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) {
    throw new TypeError("JSON slice offset and length must be positive safe integers");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || length > maxBytes) {
    throw new RangeError(`JSON slice exceeds the ${maxBytes}-byte limit`);
  }
  throwIfAborted(signal, "JSON slice read");
  const handle = await open(filePath, "r");
  try {
    throwIfAborted(signal, "JSON slice read");
    const buffer = Buffer.allocUnsafe(length);
    let consumed = 0;
    while (consumed < length) {
      throwIfAborted(signal, "JSON slice read");
      const result = await handle.read(buffer, consumed, length - consumed, offset + consumed);
      if (result.bytesRead === 0) throw new RangeError("JSON slice ended before the indexed value was complete");
      consumed += result.bytesRead;
      if (typeof onProgress === "function") await onProgress(consumed);
      throwIfAborted(signal, "JSON slice read");
    }
    return buffer;
  } finally {
    await handle.close();
  }
}
