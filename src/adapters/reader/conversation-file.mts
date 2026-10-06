import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

import {
  ContractValidationError,
  validateConversationMetadata,
  type ObservedResourceBody
} from "../../core/contracts/index.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };
import {
  decodeCanonicalBase64,
  RESOURCE_BASE64_DECODED_CHUNK_BYTES,
  writeOwnedStagingFile,
  type ByteFingerprint
} from "../storage/stream.mts";

export type EncodedChunkRange = Readonly<{
  offset: number;
  length: number;
}>;

export type IndexedResourceBody = ObservedResourceBody & Readonly<{
  chunks: readonly EncodedChunkRange[];
}>;

export type CanonicalConversationIndex = Readonly<{
  fingerprint: ByteFingerprint;
  conversation: JsonObject;
  resourceBodies: ReadonlyMap<string, IndexedResourceBody>;
}>;

type Line = Readonly<{
  offset: number;
  bytes: Buffer;
  text: string;
}>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function structureDelta(value: string): number {
  let delta = 0;
  let string = false;
  let escape = false;
  for (const character of value) {
    if (string) {
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === "\"") string = false;
      continue;
    }
    if (character === "\"") string = true;
    else if (character === "{" || character === "[") delta += 1;
    else if (character === "}" || character === "]") delta -= 1;
  }
  if (string || escape) throw new TypeError("Canonical Conversation line ends inside a JSON string");
  return delta;
}

function withoutTrailingComma(value: string): string {
  return value.endsWith(",") ? value.slice(0, -1) : value;
}

function parseJson(value: string, label: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new TypeError(`${label} is not canonical JSON`);
  }
}

class ValueCollector {
  readonly #label: string;
  readonly #lines: string[] = [];
  #depth = 0;

  constructor(first: string, label: string) {
    this.#label = label;
    this.#lines.push(first);
    this.#depth = structureDelta(first);
    if (this.#depth < 0) throw new TypeError(`${label} closes before it opens`);
  }

  get complete(): boolean {
    return this.#depth === 0;
  }

  accept(line: string): void {
    if (this.complete) throw new TypeError(`${this.#label} received bytes after completion`);
    this.#lines.push(line);
    this.#depth += structureDelta(line);
    if (this.#depth < 0) throw new TypeError(`${this.#label} closes before it opens`);
  }

  value(): JsonValue {
    if (!this.complete) throw new TypeError(`${this.#label} is incomplete`);
    const lines = [...this.#lines];
    lines[lines.length - 1] = withoutTrailingComma(lines.at(-1)!);
    return parseJson(lines.join("\n"), this.#label);
  }
}

class ResourceBodyCollector {
  readonly hash = createHash("sha256");
  readonly chunks: EncodedChunkRange[] = [];
  bytes = 0;
  #previousLength: number | undefined;

  accept(line: Line, encoded: string): void {
    const decoded = decodeCanonicalBase64(encoded);
    if (this.#previousLength !== undefined && this.#previousLength !== RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
      throw new TypeError("Canonical Conversation has a non-final resource chunk of the wrong size");
    }
    if (decoded.byteLength > RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
      throw new TypeError("Canonical Conversation has an oversized resource chunk");
    }
    const quote = line.bytes.indexOf(0x22);
    if (quote < 0 || quote + 1 + encoded.length > line.bytes.byteLength) {
      throw new TypeError("Canonical Conversation resource chunk range is invalid");
    }
    this.chunks.push({ offset: line.offset + quote + 1, length: encoded.length });
    this.hash.update(decoded);
    this.bytes += decoded.byteLength;
    this.#previousLength = decoded.byteLength;
  }

  finish(): IndexedResourceBody {
    if (this.chunks.length === 0) throw new TypeError("Canonical Conversation contains an empty data_base64 array");
    return { bytes: this.bytes, sha256: this.hash.digest("hex"), chunks: this.chunks };
  }
}

class CanonicalConversationParser {
  readonly root: JsonObject = {};
  readonly resourceBodies = new Map<string, IndexedResourceBody>();
  #started = false;
  #ended = false;
  #rootCollector: { key: string; collector: ValueCollector } | undefined;
  #section: "messages" | "resources" | "sources" | "limitations" | undefined;
  #itemCollector: ValueCollector | undefined;
  #resource: JsonObject | undefined;
  #resourceProperty: { key: string; collector: ValueCollector } | undefined;
  #resourceBody: ResourceBodyCollector | undefined;
  #inResourceBody = false;

  #setRoot(key: string, value: JsonValue): void {
    if (Object.hasOwn(this.root, key)) throw new TypeError(`Canonical Conversation repeats root field ${key}`);
    this.root[key] = value;
  }

  #finishRootCollector(): void {
    if (!this.#rootCollector?.collector.complete) return;
    this.#setRoot(this.#rootCollector.key, this.#rootCollector.collector.value());
    this.#rootCollector = undefined;
  }

  #finishItem(): void {
    if (!this.#section || !this.#itemCollector?.complete) return;
    const value = this.#itemCollector.value();
    if (!isJsonObject(value)) throw new TypeError(`Canonical Conversation ${this.#section} item is not an object`);
    const target = this.root[this.#section];
    if (!Array.isArray(target)) throw new TypeError(`Canonical Conversation ${this.#section} section is not an array`);
    target.push(value);
    this.#itemCollector = undefined;
  }

  #finishResourceProperty(): void {
    if (!this.#resource || !this.#resourceProperty?.collector.complete) return;
    if (Object.hasOwn(this.#resource, this.#resourceProperty.key)) {
      throw new TypeError(`Canonical Conversation resource repeats field ${this.#resourceProperty.key}`);
    }
    this.#resource[this.#resourceProperty.key] = this.#resourceProperty.collector.value();
    this.#resourceProperty = undefined;
  }

  #finishResource(): void {
    if (!this.#resource) throw new TypeError("Canonical Conversation closed a resource that was never opened");
    const resources = this.root["resources"];
    if (!Array.isArray(resources)) throw new TypeError("Canonical Conversation resources section is not an array");
    if (this.#resourceBody) {
      const id = this.#resource["id"];
      if (typeof id !== "string" || this.resourceBodies.has(id)) {
        throw new TypeError("Canonical Conversation resource body has a missing or duplicate ID");
      }
      this.resourceBodies.set(id, this.#resourceBody.finish());
    }
    resources.push(this.#resource);
    this.#resource = undefined;
    this.#resourceBody = undefined;
  }

  #acceptResource(line: Line): void {
    if (this.#inResourceBody) {
      if (/^      \](?:,)?$/u.test(line.text)) {
        this.#inResourceBody = false;
        return;
      }
      const match = /^        "([A-Za-z0-9+/]*={0,2})"(?:,)?$/u.exec(line.text);
      if (!match) throw new TypeError("Canonical Conversation resource body is not in writer form");
      const collector = this.#resourceBody;
      if (!collector) throw new TypeError("Canonical Conversation resource body collector is missing");
      collector.accept(line, match[1]!);
      return;
    }
    if (this.#resourceProperty) {
      this.#resourceProperty.collector.accept(line.text);
      this.#finishResourceProperty();
      return;
    }
    if (/^    \}(?:,)?$/u.test(line.text)) {
      this.#finishResource();
      return;
    }
    const property = /^      "([^"]+)": (.+)$/u.exec(line.text);
    if (!property || !this.#resource) throw new TypeError("Canonical Conversation resource line is not in writer form");
    const key = property[1]!;
    const source = property[2]!;
    if (key === "data_base64") {
      if (source !== "[") throw new TypeError("Canonical Conversation data_base64 is not a canonical array");
      if (this.#resourceBody) throw new TypeError("Canonical Conversation resource repeats data_base64");
      this.#resourceBody = new ResourceBodyCollector();
      this.#inResourceBody = true;
      return;
    }
    this.#resourceProperty = { key, collector: new ValueCollector(source, `Resource field ${key}`) };
    this.#finishResourceProperty();
  }

  #acceptSection(line: Line): void {
    if (!this.#section) throw new TypeError("Canonical Conversation has no active section");
    if (this.#section === "resources" && this.#resource) {
      this.#acceptResource(line);
      return;
    }
    if (this.#itemCollector) {
      this.#itemCollector.accept(line.text);
      this.#finishItem();
      return;
    }
    if (/^  \](?:,)?$/u.test(line.text)) {
      this.#section = undefined;
      return;
    }
    if (line.text !== "    {") throw new TypeError(`Canonical Conversation ${this.#section} item is not in writer form`);
    if (this.#section === "resources") this.#resource = {};
    else {
      this.#itemCollector = new ValueCollector("{", `${this.#section} item`);
    }
  }

  accept(line: Line): void {
    if (!this.#started) {
      if (line.offset !== 0 || line.text !== "{") throw new TypeError("Conversation is not canonical UTF-8 JSON");
      this.#started = true;
      return;
    }
    if (this.#ended) throw new TypeError("Canonical Conversation has bytes after the root object");
    if (this.#rootCollector) {
      this.#rootCollector.collector.accept(line.text);
      this.#finishRootCollector();
      return;
    }
    if (this.#section) {
      this.#acceptSection(line);
      return;
    }
    if (line.text === "}") {
      this.#ended = true;
      return;
    }
    const property = /^  "([^"]+)": (.+)$/u.exec(line.text);
    if (!property) throw new TypeError("Canonical Conversation root field is not in writer form");
    const key = property[1]!;
    const source = property[2]!;
    if (["messages", "resources", "sources", "limitations"].includes(key) && source === "[") {
      this.#setRoot(key, []);
      this.#section = key as "messages" | "resources" | "sources" | "limitations";
      return;
    }
    this.#rootCollector = { key, collector: new ValueCollector(source, `Root field ${key}`) };
    this.#finishRootCollector();
  }

  finish(): void {
    if (!this.#started || !this.#ended || this.#rootCollector || this.#section || this.#itemCollector || this.#resource || this.#resourceProperty || this.#resourceBody || this.#inResourceBody) {
      throw new TypeError("Canonical Conversation ended before its root object was complete");
    }
  }
}

async function scanHandle(input: Readonly<{
  handle: FileHandle;
  total: number;
  maxLineBytes: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}>): Promise<CanonicalConversationIndex> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const parser = new CanonicalConversationParser();
  let pending = Buffer.alloc(0);
  let pendingOffset = 0;
  let bytes = 0;
  for await (const raw of input.handle.createReadStream({ start: 0, autoClose: false })) {
    throwIfAborted(input.signal);
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(chunk);
    bytes += chunk.byteLength;
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const lineBytes = Buffer.from(pending.subarray(0, newline));
      if (lineBytes.byteLength > input.maxLineBytes) throw new RangeError("Canonical Conversation line exceeds the configured limit");
      parser.accept({ offset: pendingOffset, bytes: lineBytes, text: decoder.decode(lineBytes) });
      pending = pending.subarray(newline + 1);
      pendingOffset += newline + 1;
    }
    if (pending.byteLength > input.maxLineBytes) throw new RangeError("Canonical Conversation line exceeds the configured limit");
    input.onProgress?.(bytes, input.total);
  }
  if (pending.byteLength !== 0) throw new TypeError("Canonical Conversation must end with one LF newline");
  if (bytes !== input.total) throw new TypeError("Canonical Conversation byte count changed during scanning");
  parser.finish();
  const observed = new Map<string, ObservedResourceBody>();
  for (const [id, body] of parser.resourceBodies) observed.set(id, { bytes: body.bytes, sha256: body.sha256 });
  const validation = validateConversationMetadata(parser.root, observed);
  if (!validation.ok) throw new ContractValidationError("Streaming Conversation failed contract validation", validation.issues);
  return {
    fingerprint: { bytes, sha256: hash.digest("hex") },
    conversation: validation.value,
    resourceBodies: parser.resourceBodies
  };
}

export class CanonicalConversationFile {
  readonly index: CanonicalConversationIndex;
  readonly #handle: FileHandle;
  readonly #opened: Readonly<{ size: bigint; mtimeNs: bigint }>;
  #closed = false;

  constructor(handle: FileHandle, index: CanonicalConversationIndex, opened: Readonly<{ size: bigint; mtimeNs: bigint }>) {
    this.#handle = handle;
    this.index = index;
    this.#opened = opened;
  }

  async assertStable(): Promise<void> {
    if (this.#closed) throw new TypeError("Conversation file handle is closed");
    const current = await this.#handle.stat({ bigint: true });
    if (current.size !== this.#opened.size || current.mtimeNs !== this.#opened.mtimeNs) {
      throw new TypeError("Conversation file changed while its view was open");
    }
  }

  async materializeResource(input: Readonly<{
    resource: string;
    stagingPath: string;
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
  }>): Promise<ByteFingerprint> {
    await this.assertStable();
    const body = this.index.resourceBodies.get(input.resource);
    if (!body) throw new TypeError(`Conversation has no indexed body for ${input.resource}`);
    const indexedBody: IndexedResourceBody = body;
    const handle = this.#handle;
    async function* decoded(): AsyncGenerator<Buffer> {
      const hash = createHash("sha256");
      let bytesRead = 0;
      for (const [index, range] of indexedBody.chunks.entries()) {
        throwIfAborted(input.signal);
        const bytes = Buffer.allocUnsafe(range.length);
        let completed = 0;
        while (completed < range.length) {
          const result = await handle.read(bytes, completed, range.length - completed, range.offset + completed);
          if (result.bytesRead < 1) throw new TypeError("Conversation resource range ended early");
          completed += result.bytesRead;
        }
        const encoded = bytes.toString("ascii");
        const value = decodeCanonicalBase64(encoded);
        if (index + 1 < indexedBody.chunks.length && value.byteLength !== RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
          throw new TypeError("Conversation resource non-final chunk size changed");
        }
        if (index + 1 === indexedBody.chunks.length && value.byteLength > RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
          throw new TypeError("Conversation resource final chunk size changed");
        }
        hash.update(value);
        bytesRead += value.byteLength;
        yield value;
      }
      if (bytesRead !== indexedBody.bytes || hash.digest("hex") !== indexedBody.sha256) {
        throw new TypeError("Conversation resource ranges changed after indexing");
      }
    }
    const result = await writeOwnedStagingFile(Readable.from(decoded()), input.stagingPath, {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: (completed) => input.onProgress?.(completed, indexedBody.bytes) } : {})
    });
    if (result.bytes !== indexedBody.bytes || result.sha256 !== indexedBody.sha256) {
      throw new TypeError("Materialized Conversation resource disagrees with its indexed fingerprint");
    }
    await this.assertStable();
    return result;
  }

  async *encodedResourceChunks(input: Readonly<{
    resource: string;
    signal?: AbortSignal;
  }>): AsyncGenerator<Buffer> {
    await this.assertStable();
    const body = this.index.resourceBodies.get(input.resource);
    if (!body) throw new TypeError(`Conversation has no indexed body for ${input.resource}`);
    const hash = createHash("sha256");
    let decodedBytes = 0;
    for (const [index, range] of body.chunks.entries()) {
      throwIfAborted(input.signal);
      const encoded = Buffer.allocUnsafe(range.length);
      let completed = 0;
      while (completed < range.length) {
        const result = await this.#handle.read(encoded, completed, range.length - completed, range.offset + completed);
        if (result.bytesRead < 1) throw new TypeError("Conversation resource range ended early");
        completed += result.bytesRead;
      }
      const decoded = decodeCanonicalBase64(encoded.toString("ascii"));
      if (index + 1 < body.chunks.length && decoded.byteLength !== RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
        throw new TypeError("Conversation resource non-final chunk size changed");
      }
      if (index + 1 === body.chunks.length && decoded.byteLength > RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
        throw new TypeError("Conversation resource final chunk size changed");
      }
      hash.update(decoded);
      decodedBytes += decoded.byteLength;
      yield encoded;
    }
    if (decodedBytes !== body.bytes || hash.digest("hex") !== body.sha256) {
      throw new TypeError("Conversation resource ranges changed during Markdown export");
    }
    await this.assertStable();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

export async function openCanonicalConversationFile(input: Readonly<{
  filePath: string;
  maxLineBytes?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}>): Promise<CanonicalConversationFile> {
  const handle = await open(input.filePath, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    const total = Number(opened.size);
    if (!Number.isSafeInteger(total) || total < 1) throw new RangeError("Conversation byte size is outside the I-JSON range");
    const maxLineBytes = input.maxLineBytes ?? resourceLimits.canonical_json_line_max_bytes;
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError("Canonical line limit must be a positive safe integer");
    const index = await scanHandle({
      handle,
      total,
      maxLineBytes,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
    });
    const after = await handle.stat({ bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
      throw new TypeError("Conversation changed while its canonical index was built");
    }
    return new CanonicalConversationFile(handle, index, { size: opened.size, mtimeNs: opened.mtimeNs });
  } catch (error) {
    await handle.close();
    throw error;
  }
}
