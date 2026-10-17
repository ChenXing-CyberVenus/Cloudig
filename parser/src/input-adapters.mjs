import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseConversationBufferLegacy } from "./index.mjs";
import { claudeExportAdapterDefinition } from "./claude-json-adapter.mjs";
import { parseAttributes } from "./html.mjs";
import { isSemanticVersion } from "./semver.mjs";

const ADAPTER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export const DEFAULT_PROBE_LIMITS = Object.freeze({
  headBytes: 256 * 1024,
  tailBytes: 1024 * 1024,
  sequentialBytes: 256 * 1024 * 1024
});

export const DEFAULT_PARSE_LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024 * 1024,
  maxBufferedInputBytes: 256 * 1024 * 1024
});

function normalizedExtension(value) {
  const extension = String(value || "").trim().toLowerCase();
  if (!extension.startsWith(".") || extension.includes("/") || extension.includes("\\")) {
    throw new TypeError(`Invalid input-adapter extension: ${value}`);
  }
  return extension;
}

export function defineInputAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) throw new TypeError("Input adapter must be an object");
  if (!ADAPTER_ID.test(String(adapter.id || ""))) throw new TypeError(`Invalid input adapter id: ${adapter?.id}`);
  if (!isSemanticVersion(String(adapter.version || ""))) throw new TypeError(`Invalid input adapter version: ${adapter?.version}`);
  if (!Array.isArray(adapter.extensions) || !adapter.extensions.length) throw new TypeError(`Input adapter ${adapter.id} needs extensions`);
  if (typeof adapter.probe !== "function" || typeof adapter.parse !== "function") {
    throw new TypeError(`Input adapter ${adapter.id} needs probe() and parse()`);
  }
  return Object.freeze({
    ...adapter,
    extensions: Object.freeze([...new Set(adapter.extensions.map(normalizedExtension))]),
    capabilities: Object.freeze({ ...(adapter.capabilities || {}) })
  });
}

export async function createFileInput(filePath, { relativePath = path.basename(filePath), information = null } = {}) {
  const absolutePath = path.resolve(filePath);
  const fileInformation = information || await stat(absolutePath);
  if (!fileInformation.isFile()) throw new TypeError(`Input is not a regular file: ${path.basename(absolutePath)}`);
  const size = fileInformation.size;
  const modifiedAt = fileInformation.mtime.toISOString();
  const createdAt = (Number.isFinite(fileInformation.birthtimeMs) && fileInformation.birthtimeMs > 0
    ? fileInformation.birthtime
    : fileInformation.ctime).toISOString();
  const earliestCreatedOrModifiedAt = [createdAt, modifiedAt]
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];

  async function readSlice(position, length) {
    if (length <= 0 || size <= 0) return Buffer.alloc(0);
    const handle = await open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  return Object.freeze({
    name: path.basename(absolutePath),
    relativePath: String(relativePath).replaceAll("\\", "/"),
    size,
    modifiedAt,
    createdAt,
    earliestCreatedOrModifiedAt,
    extension: path.extname(absolutePath).toLowerCase(),
    readHead(maxBytes = DEFAULT_PROBE_LIMITS.headBytes) {
      return readSlice(0, Math.max(0, Math.min(Number(maxBytes) || 0, size)));
    },
    readTail(maxBytes = DEFAULT_PROBE_LIMITS.tailBytes) {
      const length = Math.max(0, Math.min(Number(maxBytes) || 0, size));
      return readSlice(Math.max(0, size - length), length);
    },
    async readAll({ maxBytes = DEFAULT_PARSE_LIMITS.maxInputBytes } = {}) {
      if (size > maxBytes) throw new Error(`Input exceeds the ${maxBytes} byte parser safety limit`);
      return readFile(absolutePath);
    },
    openStream(options = {}) {
      return createReadStream(absolutePath, options);
    }
  });
}

export function adapterAcceptsFileName(adapter, fileName) {
  const lower = String(fileName || "").toLowerCase();
  return adapter.extensions.some((extension) => lower.endsWith(extension));
}

function normalizeProbeResult(adapter, value) {
  const result = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const matched = result.matched === true;
  const confidence = Number(result.confidence ?? (matched ? 1 : 0));
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError(`Input adapter ${adapter.id} returned an invalid confidence`);
  }
  return Object.freeze({
    matched,
    confidence,
    format: String(result.format || adapter.id),
    provider: String(result.provider || ""),
    platform: String(result.platform || ""),
    reason: String(result.reason || ""),
    capabilities: adapter.capabilities
  });
}

const MANIFEST_NODE_TOKENS = Object.freeze([
  Buffer.from('id="ai-chat-archive-manifest"', "ascii"),
  Buffer.from("id='ai-chat-archive-manifest'", "ascii")
]);
const MANIFEST_SCHEMA_TOKEN = Buffer.from("ai-chat-archive/manifest-v1", "ascii");
const MAX_MANIFEST_METADATA_BYTES = 256 * 1024;
const MANIFEST_SCAN_CARRY_BYTES = Math.max(
  MANIFEST_SCHEMA_TOKEN.length,
  ...MANIFEST_NODE_TOKENS.map((token) => token.length)
) - 1;

function inspectManifestBytes(bytes, state = { node: false, schema: false }) {
  if (!state.node) state.node = MANIFEST_NODE_TOKENS.some((token) => bytes.indexOf(token) >= 0);
  if (!state.schema) state.schema = bytes.indexOf(MANIFEST_SCHEMA_TOKEN) >= 0;
  return state;
}

function manifestMetadataFromBytes(bytes) {
  const source = bytes.toString("utf8");
  const lower = source.toLowerCase();
  const openingPattern = /<script\b([^>]*)>/giu;
  let match;
  while ((match = openingPattern.exec(source))) {
    const attributes = parseAttributes(match[1]);
    if (attributes.id !== "ai-chat-archive-manifest") continue;
    if (String(attributes.type || "").toLowerCase() !== "application/json") return null;
    const closeStart = lower.indexOf("</script", openingPattern.lastIndex);
    if (closeStart < 0 || closeStart - openingPattern.lastIndex > MAX_MANIFEST_METADATA_BYTES) return null;
    const closeEnd = lower.indexOf(">", closeStart);
    if (closeEnd < 0) return null;
    try {
      const manifest = JSON.parse(source.slice(openingPattern.lastIndex, closeStart).replace(/^\uFEFF/u, "").trim());
      const schema = String(manifest?.format ?? manifest?.schema ?? "");
      const platform = String(manifest?.platform ?? "");
      return schema === "ai-chat-archive/manifest-v1" && platform ? { schema, platform } : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function scanManifestMetadataSequentially(input, maximumBytes) {
  const limit = Math.max(0, Math.min(Number(maximumBytes) || 0, input.size));
  if (!limit) return null;
  let scanned = 0;
  let carry = Buffer.alloc(0);
  const carryBytes = MAX_MANIFEST_METADATA_BYTES + 4096;
  for await (const rawChunk of input.openStream({ start: 0, end: limit - 1, highWaterMark: 64 * 1024 })) {
    if (scanned >= limit) break;
    const chunk = rawChunk.subarray(0, Math.min(rawChunk.length, limit - scanned));
    scanned += chunk.length;
    const sample = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const metadata = manifestMetadataFromBytes(sample);
    if (metadata) return metadata;
    carry = sample.subarray(Math.max(0, sample.length - carryBytes));
  }
  return null;
}

async function scanManifestSequentially(input, maximumBytes) {
  const limit = Math.max(0, Math.min(Number(maximumBytes) || 0, input.size));
  const state = { node: false, schema: false };
  if (!limit) return state;
  let scanned = 0;
  let carry = Buffer.alloc(0);
  for await (const rawChunk of input.openStream({ start: 0, end: limit - 1, highWaterMark: 64 * 1024 })) {
    if (scanned >= limit) break;
    const chunk = rawChunk.subarray(0, Math.min(rawChunk.length, limit - scanned));
    scanned += chunk.length;
    const sample = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    inspectManifestBytes(sample, state);
    if (state.node && state.schema) break;
    carry = sample.subarray(Math.max(0, sample.length - MANIFEST_SCAN_CARRY_BYTES));
  }
  return state;
}

export async function probeInputAdapters(input, adapters, limits = DEFAULT_PROBE_LIMITS) {
  const results = [];
  for (const adapter of adapters) {
    if (!adapterAcceptsFileName(adapter, input.name)) continue;
    const result = normalizeProbeResult(adapter, await adapter.probe(input, limits));
    results.push({ adapter, result });
  }
  const matches = results.filter(({ result }) => result.matched).sort((left, right) => right.result.confidence - left.result.confidence);
  if (!matches.length) return Object.freeze({ adapter: null, probe: null, attempts: results });
  if (matches.length > 1 && matches[0].result.confidence === matches[1].result.confidence) {
    throw new Error(`Input format is ambiguous between ${matches[0].adapter.id} and ${matches[1].adapter.id}`);
  }
  return Object.freeze({ adapter: matches[0].adapter, probe: matches[0].result, attempts: results });
}

export const htmlArchiveInputAdapter = defineInputAdapter({
  id: "ai-chat-archive-html",
  version: "0.1.1",
  extensions: [".html", ".htm"],
  capabilities: {
    one_to_many: false,
    streaming: false,
    seek_required: false,
    attachments: "metadata_only"
  },
  async probe(input, limits) {
    const [head, tail] = await Promise.all([
      input.readHead(limits.headBytes),
      input.readTail(limits.tailBytes)
    ]);
    const fastState = inspectManifestBytes(head);
    inspectManifestBytes(tail, fastState);
    const state = fastState.node && fastState.schema
      ? fastState
      : await scanManifestSequentially(input, limits.sequentialBytes ?? DEFAULT_PROBE_LIMITS.sequentialBytes);
    const metadata = manifestMetadataFromBytes(head)
      || manifestMetadataFromBytes(tail)
      || (state.node && state.schema
        ? await scanManifestMetadataSequentially(input, limits.sequentialBytes ?? DEFAULT_PROBE_LIMITS.sequentialBytes)
        : null);
    return state.node && state.schema
      ? { matched: true, confidence: 1, format: "ai-chat-archive/manifest-v1", platform: metadata?.platform || "" }
      : { matched: false, confidence: 0, reason: "HTML does not expose the current Cloudig exporter manifest inside the bounded sequential probe" };
  },
  async *parse(input, context) {
    const sourceBuffer = await input.readAll({ maxBytes: context.limits.maxBufferedInputBytes });
    const result = parseConversationBufferLegacy(sourceBuffer, {
      sourceFile: input.name,
      sourceCreatedAt: context.sourceCreatedAt || input.createdAt,
      parsedAt: context.parsedAt
    });
    yield {
      type: "conversation",
      conversation: result.conversation,
      source_adapter: result.adapter,
      source_capture: result.source_capture
    };
    yield {
      type: "summary",
      conversations: 1,
      source_adapter: result.adapter
    };
  }
});

export const claudeExportInputAdapter = defineInputAdapter(claudeExportAdapterDefinition);

export const DEFAULT_INPUT_ADAPTERS = Object.freeze([htmlArchiveInputAdapter, claudeExportInputAdapter]);
