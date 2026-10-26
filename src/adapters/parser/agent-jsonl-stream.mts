import { createReadStream } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { isJsonObject, type JsonObject } from "../../core/contracts/types.mts";

export type JsonlEntry = Readonly<{ value: JsonObject; start: number; end: number }>;

/** Container bytes drive progress; source positions always count decoded UTF-8 bytes.
 * Keep at most one unfinished line, not an expanded JSONL file or raw record array. */
export async function* streamAgentJsonl(file: string, options: {
  signal?: AbortSignal; end?: number; onProgress?: (bytes: number) => void;
} = {}): AsyncGenerator<JsonlEntry> {
  const source = createReadStream(file, { highWaterMark: 256 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
  const input = /\.jsonl\.zst$/iu.test(file) ? source.pipe(createZstdDecompress()) : source;
  source.on("error", error => { if (input !== source) input.destroy(error); });
  let physical = 0, position = 0, start = 0, fragments: Buffer[] = [], length = 0;
  source.on("data", chunk => { physical += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length; options.onProgress?.(physical); });
  const decode = (bytes: Buffer, end: number): JsonlEntry | undefined => {
    const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
    if (!line.trim()) return undefined;
    const value: unknown = JSON.parse(line);
    if (!isJsonObject(value)) throw new TypeError("Agent JSONL record must be an object");
    return { value, start, end };
  };
  try {
    for await (const raw of input) {
      options.signal?.throwIfAborted();
      const chunk = raw as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        if (options.end !== undefined && position === options.end) return;
        const newline = chunk.indexOf(10, offset), until = newline < 0 ? chunk.length : newline + 1;
        const piece = chunk.subarray(offset, until);
        if (options.end !== undefined && position + piece.length > options.end)
          throw new TypeError("Codex history_base 字节边界不在完整 JSONL 行末 / cutoff is not a decoded JSONL line boundary");
        fragments.push(piece); length += piece.length; position += piece.length; offset = until;
        if (newline >= 0) {
          const row = decode(Buffer.concat(fragments, length), position);
          fragments = []; length = 0;
          if (row) yield row;
          start = position;
        }
      }
    }
    if (options.end !== undefined && position !== options.end)
      throw new TypeError("Codex 分片短于 history_base 指定范围 / shard is shorter than its inherited byte range");
    if (length) { const row = decode(Buffer.concat(fragments, length), position); if (row) yield row; }
  } finally { input.destroy(); source.destroy(); }
}
