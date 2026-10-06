import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import { assertJsonValue } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { adapterBundleSnapshot, fallbackPayloadId, findSourceAdapter } from "../../app/parser/registry.mts";
import type { SourceAdapter } from "../../app/parser/adapter.mts";
import type { ByteFingerprint } from "../storage/stream.mts";
import { extractStaticReadingEvidence } from "./reading-evidence.mts";
import { parseStreamingJson } from "./json-object-stream.mts";
import { parseRecordJson } from "../../core/records/json.mts";
import { exporterCapture, type CapturedSourceTime } from "../../core/records/source-time.mts";

const SCRIPT_OPEN = Buffer.from("<script", "ascii");
const SCRIPT_CLOSE = Buffer.from("</script>", "ascii");
const MAX_TAG_BYTES = 16 * 1024;
const DEFAULT_JSON_SCRIPT_MEMORY_THRESHOLD_BYTES = 64 * 1024 * 1024;

type JsonScriptBody = Readonly<
  | { kind: "memory"; bytes: Buffer }
  | { kind: "spool"; path: string; bytes: number }
  | { kind: "range"; start: number; bytes: number }
>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function attributes(startTag: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  const text = startTag.toString("utf8");
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of text.matchAll(pattern)) result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
  return result;
}

async function hashReadable(
  source: Readable,
  total: number,
  phase: "fingerprint" | "extract",
  onProgress?: (phase: "fingerprint" | "extract", completed: number, total: number) => void,
  signal?: AbortSignal
): Promise<ByteFingerprint> {
  const hash = createHash("sha256");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  for await (const raw of source) {
    throwIfAborted(signal);
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    utf8.decode(chunk, { stream: true });
    hash.update(chunk);
    bytes += chunk.byteLength;
    onProgress?.(phase, bytes, total);
  }
  utf8.decode();
  return { bytes, sha256: hash.digest("hex") };
}

async function collectJsonScripts(
  source: Readable,
  input: Readonly<{
    total: number;
    memoryThresholdBytes: number;
    spoolRoot: string;
    onlyScriptId?: string;
    maximumCapturedBytes?: number;
    rangesOnly?: boolean;
    onProgress?: (phase: "fingerprint" | "extract", completed: number, total: number) => void;
    signal?: AbortSignal;
  }>
): Promise<Readonly<{ scripts: ReadonlyMap<string, JsonScriptBody>; fingerprint: ByteFingerprint }>> {
  const scripts = new Map<string, JsonScriptBody>();
  const hash = createHash("sha256");
  let bytes = 0;
  let pending = Buffer.alloc(0);
  let state: "outside" | "tag" | "capture" | "skip" = "outside";
  let captureId: string | undefined;
  let captured: Buffer[] = [];
  let capturedBytes = 0;
  let captureHandle: FileHandle | undefined;
  let capturePath: string | undefined;
  let captureOrdinal = 0;
  let captureStart = 0;

  const writeAll = async (handle: FileHandle, value: Buffer): Promise<void> => {
    let offset = 0;
    while (offset < value.byteLength) {
      const result = await handle.write(value, offset, value.byteLength - offset, null);
      if (result.bytesWritten < 1) throw new TypeError("Parser JSON spool write made no progress");
      offset += result.bytesWritten;
    }
  };

  const appendCaptured = async (value: Buffer): Promise<void> => {
    if (value.byteLength === 0) return;
    capturedBytes += value.byteLength;
    if (input.rangesOnly) return;
    if (input.maximumCapturedBytes !== undefined && capturedBytes > input.maximumCapturedBytes) throw new RangeError("Manifest exceeds the bounded display probe");
    if (!captureHandle && capturedBytes > input.memoryThresholdBytes) {
      if (!input.spoolRoot) throw new TypeError("Parser requires an explicit temporary root for large JSON data");
      capturePath = path.join(input.spoolRoot, `${String(captureOrdinal).padStart(4, "0")}.json`);
      captureOrdinal += 1;
      captureHandle = await open(capturePath, "wx");
      for (const chunk of captured) await writeAll(captureHandle, chunk);
      captured = [];
    }
    if (captureHandle) await writeAll(captureHandle, value);
    else captured.push(Buffer.from(value));
  };

  const finishCapture = async (): Promise<JsonScriptBody> => {
    if (input.rangesOnly) return { kind: "range", start: captureStart, bytes: capturedBytes };
    if (captureHandle) {
      await captureHandle.sync();
      await captureHandle.close();
      captureHandle = undefined;
      if (!capturePath) throw new TypeError("Parser JSON spool path is missing");
      return { kind: "spool", path: capturePath, bytes: capturedBytes };
    }
    return { kind: "memory", bytes: Buffer.concat(captured, capturedBytes) };
  };

  const processPending = async (): Promise<void> => {
    while (true) {
      if (state === "outside") {
        const index = pending.indexOf(SCRIPT_OPEN);
        if (index < 0) {
          pending = pending.subarray(Math.max(0, pending.byteLength - (SCRIPT_OPEN.byteLength - 1)));
          return;
        }
        pending = pending.subarray(index);
        state = "tag";
      }
      if (state === "tag") {
        const end = pending.indexOf(0x3e);
        if (end < 0) {
          if (pending.byteLength > MAX_TAG_BYTES) throw new TypeError("HTML script start tag exceeds the bounded limit");
          return;
        }
        const attrs = attributes(pending.subarray(0, end + 1));
        captureId = attrs["type"]?.toLowerCase() === "application/json" ? attrs["id"] : undefined;
        if (input.onlyScriptId && captureId !== input.onlyScriptId) captureId = undefined;
        state = captureId ? "capture" : "skip";
        captured = [];
        capturedBytes = 0;
        captureStart = bytes - pending.byteLength + end + 1;
        pending = pending.subarray(end + 1);
      }
      if (state === "capture" || state === "skip") {
        const end = pending.indexOf(SCRIPT_CLOSE);
        if (end < 0) {
          const safe = Math.max(0, pending.byteLength - (SCRIPT_CLOSE.byteLength - 1));
          if (state === "capture") await appendCaptured(pending.subarray(0, safe));
          pending = pending.subarray(safe);
          return;
        }
        if (state === "capture") {
          await appendCaptured(pending.subarray(0, end));
          if (!captureId || scripts.has(captureId)) throw new TypeError("HTML contains a duplicate JSON script id");
          scripts.set(captureId, await finishCapture());
          if (input.onlyScriptId) return;
        }
        pending = pending.subarray(end + SCRIPT_CLOSE.byteLength);
        state = "outside";
        captureId = undefined;
        captured = [];
        capturedBytes = 0;
        capturePath = undefined;
      }
    }
  };

  try {
    for await (const raw of source) {
      throwIfAborted(input.signal);
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      hash.update(chunk);
      bytes += chunk.byteLength;
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      await processPending();
      input.onProgress?.("extract", bytes, input.total);
      if (input.onlyScriptId && scripts.has(input.onlyScriptId)) return { scripts, fingerprint: { bytes, sha256: hash.digest("hex") } };
    }
    await processPending();
    if (state !== "outside") throw new TypeError("HTML ended inside a script element");
    return { scripts, fingerprint: { bytes, sha256: hash.digest("hex") } };
  } catch (error) {
    if (captureHandle) await captureHandle.close().catch(() => undefined);
    throw error;
  }
}

async function parseObject(body: JsonScriptBody | undefined, label: string, signal?: AbortSignal): Promise<JsonObject> {
  if (!body) throw new TypeError(`${label} JSON script is missing`);
  if (body.kind === "range") throw new TypeError("A byte-range probe is not a decoded payload");
  signal?.throwIfAborted();
  const value: unknown = body.kind === "memory"
    ? parseRecordJson(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes))
    : await parseStreamingJson(createReadStream(body.path, { highWaterMark: 64 * 1024 }), signal);
  assertJsonValue(value);
  if (!isJsonObject(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type ExporterEnvelope = Readonly<{
  manifest: JsonObject;
  payload: JsonObject;
  adapter: SourceAdapter;
  fingerprint: ByteFingerprint;
  reading: Readonly<{
    mermaid: readonly Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; source: string; dataUrl: string }>[];
    images: readonly Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; dataUrl: string; alt?: string; width?: number; height?: number }>[];
    files: readonly Readonly<{ messageId: string; messageVersion?: string; resourceKey?: string; dataUrl: string; name?: string }>[];
    fragments: readonly Readonly<{ messageId: string; messageVersion?: string; html: string }>[];
  }>;
}>;

// List decoration only: read the declared platform without decoding a vendor
// payload, extracting a conversation or writing a cache/sidecar. Parse remains
// the authority for format support and validates the payload independently.
export async function probeExporterRoute(filePath: string): Promise<JsonObject | undefined> {
  const manifest = await probeExporterManifest(filePath);
  if (!manifest) return undefined;
  const platform = nonEmptyString(manifest["platform"]);
  if (!platform || !adapterBundleSnapshot().adapters.some(adapter => adapter.routes.some(route => route.platform === platform))) return undefined;
  const exporter = isJsonObject(manifest["exporter"]) ? manifest["exporter"] : undefined;
  const version = nonEmptyString(manifest["exporter_version"] ?? exporter?.["version"]);
  return { format: "exporter-html", platform, ...(version ? { exporter_version: version } : {}) };
}

/** Declared header only. This does not parse a conversation or prove payload support. */
export async function probeExporterManifest(filePath: string): Promise<JsonObject | undefined> {
  const id = "ai-chat-archive-manifest";
  const extracted = await collectJsonScripts(createReadStream(filePath, { highWaterMark: 1024 * 1024 }), {
    total: 0, memoryThresholdBytes: 1024 * 1024, maximumCapturedBytes: 1024 * 1024,
    spoolRoot: path.dirname(filePath), onlyScriptId: id
  });
  if (!extracted.scripts.has(id)) return undefined;
  const manifest = await parseObject(extracted.scripts.get(id), "Manifest");
  if ((manifest["format"] ?? manifest["schema"]) !== "ai-chat-archive/manifest-v1") return undefined;
  return manifest;
}

/** Fast manifest path; only legacy/malformed-date headers need a streaming payload metadata probe. */
export async function probeExporterCapture(filePath: string, manifest: JsonObject): Promise<CapturedSourceTime | undefined> {
  const declared = exporterCapture(manifest);
  if (declared) return declared;
  const descriptor = isJsonObject(manifest["payload"]) ? manifest["payload"] : undefined;
  const id = nonEmptyString(descriptor?.["element_id"]) ?? nonEmptyString(descriptor?.["script_id"])
    ?? fallbackPayloadId(String(manifest["platform"]));
  if (!id) return undefined;
  const extracted = await collectJsonScripts(createReadStream(filePath, { highWaterMark: 1024 * 1024 }), {
    total: 0, memoryThresholdBytes: 0, spoolRoot: "", onlyScriptId: id, rangesOnly: true
  });
  const body = extracted.scripts.get(id);
  if (!body || body.kind !== "range" || body.bytes === 0) return undefined;
  const payload = await parseStreamingJson(createReadStream(filePath, { start: body.start, end: body.start + body.bytes - 1 }), undefined,
    { rootKeys: ["captured_at", "exported_at"], string() { return undefined; } });
  return isJsonObject(payload) ? exporterCapture(manifest, payload) : undefined;
}

export async function readExporterEnvelope(input: Readonly<{
  filePath: string;
  temporaryRoot?: string;
  jsonScriptMemoryThresholdBytes?: number;
  onProgress?: (phase: "fingerprint" | "extract", completed: number, total: number) => void;
  signal?: AbortSignal;
}>): Promise<ExporterEnvelope> {
  const handle = await open(input.filePath, "r");
  let spoolRoot: string | undefined;
  try {
    if (input.temporaryRoot) {
      if (!path.isAbsolute(input.temporaryRoot)) throw new TypeError("Parser temporary root must be absolute");
      await mkdir(input.temporaryRoot, { recursive: true });
      spoolRoot = await mkdtemp(path.join(input.temporaryRoot, "html-"));
    }
    const info = await handle.stat({ bigint: true });
    const total = Number(info.size);
    if (!Number.isSafeInteger(total) || total < 1) throw new RangeError("Exporter HTML byte size is outside the I-JSON range");
    const memoryThresholdBytes = input.jsonScriptMemoryThresholdBytes ?? (spoolRoot ? DEFAULT_JSON_SCRIPT_MEMORY_THRESHOLD_BYTES : Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(memoryThresholdBytes) || memoryThresholdBytes < 1) {
      throw new RangeError("JSON script memory threshold must be a positive safe integer");
    }
    const fingerprint = await hashReadable(
      handle.createReadStream({ start: 0, autoClose: false }),
      total,
      "fingerprint",
      input.onProgress,
      input.signal
    );
    const extracted = await collectJsonScripts(handle.createReadStream({ start: 0, autoClose: false }), {
      total,
      memoryThresholdBytes,
      spoolRoot: spoolRoot ?? "",
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (fingerprint.bytes !== extracted.fingerprint.bytes || fingerprint.sha256 !== extracted.fingerprint.sha256) {
      throw new TypeError("Exporter HTML changed between fingerprint and extraction");
    }
    const manifest = await parseObject(extracted.scripts.get("ai-chat-archive-manifest"), "Manifest", input.signal);
    if ((manifest["format"] ?? manifest["schema"]) !== "ai-chat-archive/manifest-v1") {
      throw new TypeError("Unsupported Exporter HTML manifest");
    }
    const platform = nonEmptyString(manifest["platform"]);
    if (!platform) throw new TypeError("Exporter HTML manifest has no platform");
    const descriptor = isJsonObject(manifest["payload"]) ? manifest["payload"] : undefined;
    const payloadId = nonEmptyString(descriptor?.["element_id"])
      ?? nonEmptyString(descriptor?.["script_id"])
      ?? fallbackPayloadId(platform);
    if (!payloadId) throw new TypeError("Exporter HTML has no registered payload script id");
    const payload = await parseObject(extracted.scripts.get(payloadId), "Vendor payload", input.signal);
    const payloadSchema = nonEmptyString(payload["format"])
      ?? nonEmptyString(payload["schema"])
      ?? nonEmptyString(descriptor?.["format"])
      ?? nonEmptyString(descriptor?.["schema"]);
    if (!payloadSchema) throw new TypeError("Exporter HTML has no payload schema");
    if (payload["platform"] !== undefined && payload["platform"] !== platform) {
      throw new TypeError("Manifest and payload platform disagree");
    }
    const adapter = findSourceAdapter({ format: "exporter-html", platform, payload: payloadSchema });
    if (!adapter) throw new TypeError(`No Adapter route for ${platform} / ${payloadSchema}`);
    const reading = adapter.readingEvidence === "none"
      ? { mermaid: [], images: [], files: [], fragments: [], fingerprint }
      : await extractStaticReadingEvidence(
        handle.createReadStream({ start: 0, autoClose: false }),
        input.signal
      );
    if (fingerprint.bytes !== reading.fingerprint.bytes || fingerprint.sha256 !== reading.fingerprint.sha256) {
      throw new TypeError("Exporter HTML changed between extraction and static reading evidence");
    }
    return {
      manifest,
      payload,
      adapter,
      fingerprint,
      reading: {
        mermaid: reading.mermaid,
        images: reading.images,
        files: reading.files,
        fragments: reading.fragments
      }
    };
  } finally {
    await handle.close();
    if (spoolRoot) await rm(spoolRoot, { recursive: true, force: true });
  }
}
