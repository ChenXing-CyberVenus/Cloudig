import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { assertJsonValue, orderedJsonKeys } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { resolveManagedPath } from "./path.mts";
import {
  decodeBase64Chunks,
  decodeCanonicalBase64,
  encodeBase64Chunks,
  fingerprintFile,
  RESOURCE_BASE64_DECODED_CHUNK_BYTES,
  writeOwnedStagingFile,
  type ByteFingerprint
} from "./stream.mts";

export type DetachedResourceBody = Readonly<{
  resource: string;
  expected: ByteFingerprint;
  chunks: string[];
  path: string;
}>;

export type ResourceSpool = Readonly<{
  resource: string;
  path: string;
  absolutePath: string;
  fingerprint: ByteFingerprint;
}>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function fingerprint(value: JsonObject, label: string): ByteFingerprint {
  const bytes = value["bytes"];
  const sha256 = value["sha256"];
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || typeof sha256 !== "string") {
    throw new TypeError(`${label} has no valid embedded resource fingerprint`);
  }
  return { bytes: bytes as number, sha256 };
}

export function detachConversationResourceBodies(
  conversation: JsonObject,
  transaction: string,
  inlineBudgetBytes = 0
): Readonly<{ bodies: DetachedResourceBody[]; journalRows: JsonObject[] }> {
  const resources = conversation["resources"];
  if (!Array.isArray(resources)) return { bodies: [], journalRows: [] };
  const bodies: DetachedResourceBody[] = [];
  const journalRows: JsonObject[] = [];
  for (const [index, raw] of resources.entries()) {
    if (!isJsonObject(raw) || raw["availability"] !== "embedded") continue;
    const expected = fingerprint(raw, `Embedded resource ${index}`);
    if (expected.bytes === 0) {
      if (raw["data_base64"] !== undefined) throw new TypeError("Zero-byte embedded resource must omit data_base64");
      continue;
    }
    const encoded = raw["data_base64"];
    if (!Array.isArray(encoded) || encoded.length === 0 || encoded.some((entry) => typeof entry !== "string")) {
      throw new TypeError("Non-empty embedded resource must carry Base64 chunks before detachment");
    }
    const resource = raw["id"];
    if (typeof resource !== "string") throw new TypeError("Embedded resource has no ID");
    // Small, already validated canonical chunks can be streamed directly into
    // the final JSON. They are still re-decoded/hashed from that staged file.
    // Only larger bodies need a separately flushed decoded disk spool.
    if (expected.bytes <= 512 * 1024 && expected.bytes <= inlineBudgetBytes) {
      inlineBudgetBytes -= expected.bytes;
      continue;
    }
    const relativePath = `Data/Transactions/${transaction}/resources/${String(index).padStart(6, "0")}.bin`;
    const chunks = encoded as string[];
    delete raw["data_base64"];
    bodies.push({ resource, expected, chunks, path: relativePath });
    journalRows.push({
      resource,
      path: relativePath,
      status: "planned",
      expected: { ...expected }
    });
  }
  return { bodies, journalRows };
}

async function* stringChunks(chunks: readonly string[], signal?: AbortSignal): AsyncGenerator<string> {
  for (const chunk of chunks) {
    throwIfAborted(signal);
    yield chunk;
  }
}

export async function spoolDetachedResourceBodies(input: Readonly<{
  libraryRoot: string;
  bodies: readonly DetachedResourceBody[];
  journal: JsonObject;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}>): Promise<Readonly<{ journal: JsonObject; spools: ReadonlyMap<string, ResourceSpool> }>> {
  const journal = structuredClone(input.journal);
  const rows = journal["spools"];
  if (!Array.isArray(rows) || rows.length !== input.bodies.length) {
    throw new TypeError("Resource spool journal rows do not match detached bodies");
  }
  const total = input.bodies.reduce((sum, body) => sum + body.expected.bytes, 0);
  let before = 0;
  const result = new Map<string, ResourceSpool>();
  if (input.bodies.length > 0) {
    const directory = await resolveManagedPath(input.libraryRoot, `Data/Transactions/${String(journal["transaction"])}/resources`);
    await mkdir(directory, { recursive: true });
  }
  for (const [index, body] of input.bodies.entries()) {
    throwIfAborted(input.signal);
    const row = rows[index];
    if (!isJsonObject(row) || row["resource"] !== body.resource || row["path"] !== body.path) {
      throw new TypeError("Resource spool journal order changed");
    }
    const absolutePath = await resolveManagedPath(input.libraryRoot, body.path);
    const decoded = decodeBase64Chunks(
      stringChunks(body.chunks, input.signal),
      RESOURCE_BASE64_DECODED_CHUNK_BYTES,
      input.signal
    );
    const observed = await writeOwnedStagingFile(Readable.from(decoded), absolutePath, {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: (completed) => input.onProgress?.(before + completed, total) } : {})
    });
    if (observed.bytes !== body.expected.bytes || observed.sha256 !== body.expected.sha256) {
      throw new TypeError(`Embedded resource ${body.resource} disagrees with its declared bytes or SHA-256`);
    }
    row["status"] = "written";
    row["observed"] = { ...observed };
    result.set(body.resource, { resource: body.resource, path: body.path, absolutePath, fingerprint: observed });
    before += observed.bytes;
    body.chunks.length = 0;
  }
  return { journal, spools: result };
}

async function* encodeJsonValue(
  value: JsonValue,
  depth: number,
  spools: ReadonlyMap<string, ResourceSpool>,
  used: Set<string>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  throwIfAborted(signal);
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    yield JSON.stringify(value);
    return;
  }
  const indentation = "  ".repeat(depth);
  const childIndentation = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      yield "[]";
      return;
    }
    yield "[\n";
    for (const [index, entry] of value.entries()) {
      yield childIndentation;
      yield* encodeJsonValue(entry, depth + 1, spools, used, signal);
      yield index + 1 === value.length ? "\n" : ",\n";
    }
    yield `${indentation}]`;
    return;
  }

  const resource = typeof value["id"] === "string" && value["availability"] === "embedded"
    ? spools.get(value["id"] as string)
    : undefined;
  const keyed: JsonObject = resource ? { ...value, data_base64: [] } : value;
  const keys = orderedJsonKeys(keyed);
  if (keys.length === 0) {
    yield "{}";
    return;
  }
  yield "{\n";
  for (const [index, key] of keys.entries()) {
    yield `${childIndentation}${JSON.stringify(key)}: `;
    if (key === "data_base64" && resource) {
      if (used.has(resource.resource)) throw new TypeError(`Resource spool ${resource.resource} was requested more than once`);
      used.add(resource.resource);
      let chunkIndex = 0;
      yield "[\n";
      for await (const chunk of encodeBase64Chunks(
        createReadStream(resource.absolutePath),
        RESOURCE_BASE64_DECODED_CHUNK_BYTES,
        signal
      )) {
        if (chunkIndex > 0) yield ",\n";
        yield `${"  ".repeat(depth + 2)}${JSON.stringify(chunk)}`;
        chunkIndex += 1;
      }
      if (chunkIndex === 0) throw new TypeError(`Non-empty resource spool ${resource.resource} produced no Base64 chunks`);
      yield `\n${childIndentation}]`;
    } else {
      yield* encodeJsonValue(value[key]!, depth + 1, spools, used, signal);
    }
    yield index + 1 === keys.length ? "\n" : ",\n";
  }
  yield `${indentation}}`;
}

export function streamCanonicalConversation(
  conversation: JsonObject,
  spools: ReadonlyMap<string, ResourceSpool>,
  signal?: AbortSignal
): Readable {
  assertJsonValue(conversation);
  async function* output(): AsyncGenerator<string> {
    const used = new Set<string>();
    // The canonical encoder emits punctuation and individual fields. Sending
    // every token to FileHandle.write turned one small JSON into thousands of
    // filesystem calls. Coalesce only transport chunks; canonical bytes and
    // resource verification are unchanged, and no full document is buffered.
    let pending: string[] = [];
    let characters = 0;
    for await (const chunk of encodeJsonValue(conversation, 0, spools, used, signal)) {
      pending.push(chunk);
      characters += chunk.length;
      if (characters >= 64 * 1024) {
        yield pending.join("");
        pending = [];
        characters = 0;
      }
    }
    if (characters) yield pending.join("");
    yield "\n";
    if (used.size !== spools.size) throw new TypeError("Not every resource spool was written to the Conversation");
  }
  return Readable.from(output());
}

type ScanResource = {
  id?: string;
  bytes?: number;
  sha256?: string;
  sawData: boolean;
  previous?: Buffer;
  decodedBytes: number;
  hash: ReturnType<typeof createHash>;
};

function consumeScannedChunk(resource: ScanResource, chunk: string): void {
  const decoded = decodeCanonicalBase64(chunk);
  if (resource.previous) {
    if (resource.previous.byteLength !== RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
      throw new TypeError("Staged Conversation has a non-final Base64 chunk of the wrong size");
    }
    resource.hash.update(resource.previous);
    resource.decodedBytes += resource.previous.byteLength;
  }
  resource.previous = decoded;
}

function finishScannedResource(resource: ScanResource, expected: ReadonlyMap<string, { fingerprint: ByteFingerprint }>, seen: Set<string>): void {
  if (resource.previous) {
    if (resource.previous.byteLength > RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
      throw new TypeError("Staged Conversation has an oversized final Base64 chunk");
    }
    resource.hash.update(resource.previous);
    resource.decodedBytes += resource.previous.byteLength;
  }
  if (!resource.id || !resource.sawData) return;
  const spool = expected.get(resource.id);
  if (!spool || seen.has(resource.id)) throw new TypeError("Staged Conversation contains an unexpected or duplicate resource body");
  const digest = resource.hash.digest("hex");
  if (
    resource.bytes !== spool.fingerprint.bytes
    || resource.sha256 !== spool.fingerprint.sha256
    || resource.decodedBytes !== spool.fingerprint.bytes
    || digest !== spool.fingerprint.sha256
  ) throw new TypeError(`Staged Conversation resource ${resource.id} failed bytes/SHA verification`);
  seen.add(resource.id);
}

export async function verifyStagedConversationResources(
  filePath: string,
  expected: ReadonlyMap<string, { fingerprint: ByteFingerprint }>,
  signal?: AbortSignal
): Promise<void> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let inResources = false;
  let inData = false;
  let current: ScanResource | undefined;
  const seen = new Set<string>();
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      if (!inResources) {
        if (line === "  \"resources\": [") inResources = true;
        continue;
      }
      if (!current) {
        if (line === "    {") {
          current = { sawData: false, decodedBytes: 0, hash: createHash("sha256") };
          continue;
        }
        if (/^  \](?:,)?$/u.test(line)) break;
        continue;
      }
      if (inData) {
        if (/^      \](?:,)?$/u.test(line)) {
          inData = false;
          continue;
        }
        const end = line.endsWith('\",') ? 2 : line.endsWith('\"') ? 1 : 0;
        if (!line.startsWith('        \"') || end === 0) throw new TypeError("Staged Conversation resource Base64 is not in canonical writer form");
        consumeScannedChunk(current, line.slice(9, -end));
        continue;
      }
      if (line === "      \"data_base64\": [") {
        current.sawData = true;
        inData = true;
        continue;
      }
      const property = /^      "(id|bytes|sha256)": (.+?)(?:,)?$/u.exec(line);
      if (property) {
        const value: unknown = JSON.parse(property[2]!);
        if (property[1] === "id" && typeof value === "string") current.id = value;
        if (property[1] === "bytes" && typeof value === "number") current.bytes = value;
        if (property[1] === "sha256" && typeof value === "string") current.sha256 = value;
        continue;
      }
      if (/^    \}(?:,)?$/u.test(line)) {
        finishScannedResource(current, expected, seen);
        current = undefined;
      }
    }
  } finally {
    lines.close();
    if (!input.closed) {
      input.destroy();
      await new Promise<void>((resolve) => input.once("close", resolve));
    }
  }
  if (inData || current) throw new TypeError("Staged Conversation ended inside a resource body");
  if (seen.size !== expected.size) throw new TypeError("Staged Conversation omitted one or more resource bodies");
}

export async function deleteVerifiedResourceSpools(
  libraryRoot: string,
  journalInput: JsonObject,
  spools: ReadonlyMap<string, ResourceSpool>
): Promise<JsonObject> {
  const journal = structuredClone(journalInput);
  const rows = journal["spools"];
  if (!Array.isArray(rows)) throw new TypeError("Journal has no resource spool rows");
  for (const raw of rows) {
    if (!isJsonObject(raw) || typeof raw["resource"] !== "string" || typeof raw["path"] !== "string") continue;
    const spool = spools.get(raw["resource"]);
    if (!spool || spool.path !== raw["path"]) throw new TypeError("Journal resource spool identity changed");
    const observed = await fingerprintFile(spool.absolutePath);
    if (observed.bytes !== spool.fingerprint.bytes || observed.sha256 !== spool.fingerprint.sha256) {
      raw["status"] = "conflict";
      throw new TypeError("Resource spool changed after staged Conversation verification");
    }
    await unlink(spool.absolutePath);
    raw["status"] = "cleaned";
  }
  return journal;
}
