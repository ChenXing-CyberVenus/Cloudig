import { createHash } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };

export type ByteFingerprint = Readonly<{ bytes: number; sha256: string }>;
export const RESOURCE_BASE64_DECODED_CHUNK_BYTES = resourceLimits.base64_decoded_chunk_bytes;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

export async function fingerprintFile(filePath: string, signal?: AbortSignal): Promise<ByteFingerprint> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function writeOwnedStagingFile(
  source: Readable,
  targetPath: string,
  options: Readonly<{
    signal?: AbortSignal;
    onProgress?: (completedBytes: number) => void;
    /** Only disposable, reproducible cache may opt out. Durable writes remain the default. */
    durable?: boolean;
  }> = {}
): Promise<ByteFingerprint> {
  const handle = await open(targetPath, "wx", 0o600);
  const openedStat = await handle.stat({ bigint: true });
  const hash = createHash("sha256");
  let bytes = 0;
  let completed = false;
  try {
    for await (const chunk of source) {
      throwIfAborted(options.signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.byteLength) {
        throwIfAborted(options.signal);
        const result = await handle.write(buffer, offset, buffer.byteLength - offset);
        offset += result.bytesWritten;
      }
      hash.update(buffer);
      bytes += buffer.byteLength;
      options.onProgress?.(bytes);
    }
    throwIfAborted(options.signal);
    if (options.durable !== false) await handle.sync();
    completed = true;
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
    if (!completed) {
      try {
        const observed = await stat(targetPath, { bigint: true });
        if (observed.dev === openedStat.dev && observed.ino === openedStat.ino) await unlink(targetPath);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
  }
}

export async function* encodeBase64Chunks(
  source: AsyncIterable<Uint8Array>,
  decodedChunkSize: number,
  signal?: AbortSignal
): AsyncGenerator<string> {
  if (!Number.isSafeInteger(decodedChunkSize) || decodedChunkSize < 3 || decodedChunkSize % 3 !== 0) {
    throw new RangeError("decodedChunkSize must be a positive multiple of three");
  }
  let pending = Buffer.alloc(0);
  for await (const raw of source) {
    throwIfAborted(signal);
    const incoming = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    pending = pending.byteLength === 0 ? Buffer.from(incoming) : Buffer.concat([pending, incoming]);
    while (pending.byteLength >= decodedChunkSize) {
      const chunk = pending.subarray(0, decodedChunkSize);
      pending = Buffer.from(pending.subarray(decodedChunkSize));
      yield chunk.toString("base64");
    }
  }
  throwIfAborted(signal);
  if (pending.byteLength > 0) yield pending.toString("base64");
}

export function decodeCanonicalBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new TypeError("Invalid Base64 chunk alphabet or whitespace");
  }
  // The native decoder may accept junk, but exact native re-encoding below
  // rejects every such input (including whitespace, Unicode and bad pad bits).
  // Do not additionally scan multi-megabyte strings with two greedy regexes.
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new TypeError("Base64 chunk is not canonical RFC 4648");
  return decoded;
}

export async function* decodeBase64Chunks(
  chunks: AsyncIterable<string>,
  decodedChunkSize = RESOURCE_BASE64_DECODED_CHUNK_BYTES,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(decodedChunkSize) || decodedChunkSize < 3 || decodedChunkSize % 3 !== 0) {
    throw new RangeError("decodedChunkSize must be a positive multiple of three");
  }
  let previous: Buffer | undefined;
  for await (const value of chunks) {
    throwIfAborted(signal);
    const decoded = decodeCanonicalBase64(value);
    if (previous) {
      if (previous.byteLength !== decodedChunkSize || previous.byteLength % 3 !== 0) {
        throw new TypeError("Every non-final decoded chunk must use the configured multiple-of-three size");
      }
      yield previous;
    }
    previous = decoded;
  }
  throwIfAborted(signal);
  if (previous) {
    if (previous.byteLength > decodedChunkSize) throw new TypeError("Final decoded chunk exceeds configured size");
    yield previous;
  }
}

export async function verifyBase64Chunks(
  chunks: AsyncIterable<string>,
  expected: ByteFingerprint,
  decodedChunkSize: number,
  signal?: AbortSignal
): Promise<ByteFingerprint> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const decoded of decodeBase64Chunks(chunks, decodedChunkSize, signal)) {
    hash.update(decoded);
    bytes += decoded.byteLength;
  }
  const result = { bytes, sha256: hash.digest("hex") };
  if (result.bytes !== expected.bytes) throw new TypeError("Decoded Base64 byte count mismatch");
  if (result.sha256 !== expected.sha256) throw new TypeError("Decoded Base64 SHA-256 mismatch");
  return result;
}
