import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Readable, PassThrough } from "node:stream";
import { once } from "node:events";
import type { JsonObject } from "../../core/contracts/types.mts";
import { validateConversationRecordMetadata, type ObservedRecordResource } from "../../core/records/index.mts";
import { parseStreamingJson, type JsonStringSink } from "../parser/json-object-stream.mts";
import { writeOwnedStagingFile } from "../storage/stream.mts";
import { recordSchemaIssue } from "../../core/records/schema-registry.mts";
import { recordValidationError } from "../../core/records/errors.mts";

export const RECORD_READING_LIMITS = Object.freeze({ inputChunkBytes: 65_536 });
export type RecordResourceBody = ObservedRecordResource & Readonly<{ encoded: Readonly<{ offset: number; length: number; segments: number }> }>;
type Accumulator = { digest: ReturnType<typeof createHash>; bytes: number; offset: number; end: number; segments: number };

/** One independently padded Base64 JSON string. Never accumulates its whole value. */
function base64String(write: (bytes: Buffer) => void, end: JsonStringSink["end"]): JsonStringSink {
  let pending = "", encodedLength = 0, escape = false, unicode: string | undefined;
  const decoded = (text: string): void => {
    if (/[^A-Za-z0-9+/=]/u.test(text)) throw new TypeError("Invalid Base64 character");
    encodedLength += text.length; pending += text;
    const padding = pending.indexOf("="), available = padding < 0 ? pending.length : padding;
    const length = Math.floor(available / 4) * 4;
    if (length) {
      const piece = pending.slice(0, length), bytes = Buffer.from(piece, "base64");
      if (bytes.toString("base64") !== piece) throw new TypeError("Noncanonical Base64");
      write(bytes); pending = pending.slice(length);
    }
    if (pending.length > 4) throw new TypeError("Base64 data follows segment padding");
  };
  return {
    raw(fragment) {
      if (!escape && unicode === undefined && !/[\\\u0000-\u001f]/u.test(fragment)) { decoded(fragment); return; }
      let output = "";
      for (const char of fragment) {
        if (unicode !== undefined) {
          if (!/[0-9a-f]/iu.test(char)) throw new SyntaxError("Invalid JSON Unicode escape");
          unicode += char;
          if (unicode.length === 4) { output += String.fromCharCode(Number.parseInt(unicode, 16)); unicode = undefined; }
        } else if (escape) {
          escape = false;
          if (char === "u") unicode = "";
          else if ('"\\/'.includes(char)) output += char;
          else if ("bfnrt".includes(char)) throw new TypeError("Whitespace escapes are not Base64 data");
          else throw new SyntaxError("Invalid JSON string escape");
        } else if (char === "\\") escape = true;
        else { if (char.charCodeAt(0) < 32) throw new SyntaxError("Unescaped JSON control character"); output += char; }
      }
      decoded(output);
    },
    end(span) {
      if (escape || unicode !== undefined || !encodedLength || encodedLength % 4 !== 0) throw new TypeError("Incomplete Base64 JSON segment");
      if (pending) {
        const bytes = Buffer.from(pending, "base64");
        if (bytes.toString("base64") !== pending) throw new TypeError("Invalid or noncanonical Base64 padding");
        write(bytes); pending = "";
      }
      end(span);
    }
  };
}

export async function inspectRecordConversation(filePath: string, signal?: AbortSignal) {
  const handle = await open(filePath, "r"), digest = createHash("sha256"); let bytes = 0;
  const resources = new Map<number, Accumulator>();
  try {
    const before = await handle.stat({ bigint: true });
    async function* chunks() {
      for await (const raw of handle.createReadStream({ autoClose: false, highWaterMark: RECORD_READING_LIMITS.inputChunkBytes })) {
        signal?.throwIfAborted(); const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); digest.update(buffer); bytes += buffer.length; yield buffer;
      }
    }
    const value = await parseStreamingJson(Readable.from(chunks()), signal, { string(at) {
      if (at.length !== 4 || at[0] !== "resources" || typeof at[1] !== "number" || at[2] !== "data_base64" || typeof at[3] !== "number") return undefined;
      let resource = resources.get(at[1]);
      if (!resource) { resource = { digest: createHash("sha256"), bytes: 0, offset: -1, end: -1, segments: 0 }; resources.set(at[1], resource); }
      if (at[3] !== resource.segments) throw new TypeError("Resource body array contains a non-string member");
      const current = resource;
      return base64String(data => { current.digest.update(data); current.bytes += data.length; }, span => {
        if (current.offset < 0) current.offset = span.offset; current.end = span.offset + span.length; current.segments++;
      });
    } });
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes) !== after.size) throw new TypeError("Conversation changed while reading");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Conversation must be an object");
    const incompatible = recordSchemaIssue("conversation", value); if (incompatible) throw recordValidationError([incompatible]);
    const resourceBodies = new Map<string, RecordResourceBody>();
    for (const [index, raw] of ((value["resources"] ?? []) as JsonObject[]).entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid resource record");
      if (Object.hasOwn(raw, "data_base64")) {
        if (raw["availability"] !== "embedded" || !Array.isArray(raw["data_base64"]) || raw["data_base64"].length) throw new TypeError("Invalid resource body structure");
        delete raw["data_base64"];
      }
      const observed = resources.get(index);
      if (observed) resourceBodies.set(String(raw["id"]), { bytes: observed.bytes, sha256: observed.digest.digest("hex"), encoded: { offset: observed.offset, length: observed.end - observed.offset, segments: observed.segments } });
      else if (raw["availability"] === "embedded" && raw["bytes"] === 0) resourceBodies.set(String(raw["id"]), { bytes: 0, sha256: createHash("sha256").digest("hex"), encoded: { offset: 0, length: 0, segments: 0 } });
    }
    const valid = validateConversationRecordMetadata(value, resourceBodies);
    if (!valid.ok) throw recordValidationError(valid.issues);
    return { conversation: valid.value, resourceBodies, fingerprint: { bytes, sha256: digest.digest("hex") } };
  } finally { await handle.close(); }
}

/** A bounded, backpressured decoder shared by resource files and Markdown. */
export async function* streamRecordResource(sourcePath: string, body: RecordResourceBody, signal?: AbortSignal): AsyncGenerator<Buffer> {
  signal?.throwIfAborted();
  const empty = body.bytes === 0 && body.encoded.length === 0 && body.encoded.segments === 0 && body.sha256 === createHash("sha256").digest("hex");
  if (![body.encoded.offset, body.encoded.length, body.encoded.segments, body.bytes].every(Number.isSafeInteger) || body.encoded.offset < 0 || !empty && (body.encoded.length < 1 || body.encoded.segments < 1) || body.bytes < 0) throw new TypeError("Invalid resource byte span");
  const source = await open(sourcePath, "r");
  if (empty) { await source.close(); return; }
  const stopped = new AbortController(), activeSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
  const output = new PassThrough({ highWaterMark: RECORD_READING_LIMITS.inputChunkBytes });
  const digest = createHash("sha256"); let bytes = 0, segments = 0;
  const buffers: Buffer[] = [];
  const parsing = (async () => { try {
    async function* encoded() {
      yield Buffer.from("[");
      yield* source.createReadStream({ start: body.encoded.offset, end: body.encoded.offset + body.encoded.length - 1, autoClose: false, highWaterMark: RECORD_READING_LIMITS.inputChunkBytes });
      yield Buffer.from("]");
    }
    const value = await parseStreamingJson(Readable.from(encoded()), activeSignal, {
      string(at) { if (at.length !== 1 || typeof at[0] !== "number") return undefined; return base64String(data => { buffers.push(data); digest.update(data); bytes += data.length; }, () => { segments++; }); },
      async afterChunk() {
        for (const buffer of buffers.splice(0)) { activeSignal.throwIfAborted(); if (!output.write(buffer)) await once(output, "drain", { signal: activeSignal }); }
      }
    });
    if (!Array.isArray(value) || value.length || segments !== body.encoded.segments || bytes !== body.bytes || digest.digest("hex") !== body.sha256) throw new TypeError("Resource changed or did not match its recorded bytes");
    activeSignal.throwIfAborted(); output.end();
  } catch (error) { if (!output.destroyed) output.destroy(error instanceof Error ? error : new Error(String(error))); }
    finally { await source.close(); }
  })();
  try { for await (const chunk of output) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); }
  finally { stopped.abort(); output.destroy(); await parsing; }
}

/** Materialize only a selected resource into an exclusively-created cache file. */
export async function materializeRecordResource(sourcePath: string, body: RecordResourceBody, targetPath: string, signal?: AbortSignal): Promise<void> {
  await writeOwnedStagingFile(Readable.from(streamRecordResource(sourcePath, body, signal)), targetPath, signal ? { signal } : {});
}
