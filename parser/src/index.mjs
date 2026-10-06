import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeConversation, serializeConversation } from "../../schema/serialize.mjs";
import { validateConversation } from "../../schema/validate.mjs";
import { inspectContract, parseContractHtml } from "./contract.mjs";
import { selectAdapter } from "./registry.mjs";
import { parserTimestamp } from "./time.mjs";
import { PARSER_VERSION_HISTORY } from "./version-history.mjs";
import { createConversationEnvelopeV1, sourceCaptureFromContract } from "./envelope-v1.mjs";

export const PARSER = Object.freeze({
  id: "ai-chat-archive/parser",
  version: PARSER_VERSION_HISTORY.current,
  output_schema: "ai-chat-archive/conversation/1.0.0",
  output_schemas: Object.freeze([
    "ai-chat-archive/conversation/1.0.0"
  ])
});
export const LEGACY_PROJECTION_PARSER_VERSION = "0.5.3";

export function parseConversationBufferLegacy(sourceBuffer, {
  sourceFile = "conversation.html",
  sourceCreatedAt = null,
  parsedAt = null,
  clock = () => new Date()
} = {}) {
  const context = parseContractHtml({ sourceBuffer, sourceFile, sourceCreatedAt });
  const adapter = selectAdapter(context);
  const projected = adapter.parse(context);
  const conversation = normalizeConversation({
    ...projected,
    parser_version: LEGACY_PROJECTION_PARSER_VERSION,
    parser_adapter: { id: adapter.id, version: adapter.version },
    parsed_at: parserTimestamp({ parsedAt, clock }),
    ...(context.exporterVersion === null ? {} : { exporter_version: context.exporterVersion })
  });
  const validation = validateConversation(conversation);
  if (!validation.valid) {
    throw new Error(`Unified conversation validation failed:\n${validation.errors.join("\n")}`);
  }
  return {
    conversation,
    serialized: serializeConversation(conversation),
    adapter: {
      id: adapter.id,
      version: adapter.version,
      profile: adapter.profile,
      provider: adapter.provider,
      platform: adapter.platform,
      payload_schema: adapter.payloadSchema
    },
    input: inspectContract(context),
    source_capture: sourceCaptureFromContract(context)
  };
}

function deterministicArchiveId(conversationKey, sourceSha256) {
  const hex = createHash("sha256").update(`cloudig-direct-archive-v1\n${conversationKey}\n${sourceSha256}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export function parseConversationBuffer(sourceBuffer, options = {}) {
  const legacy = parseConversationBufferLegacy(sourceBuffer, options);
  const archiveId = options.archiveId || deterministicArchiveId(
    legacy.conversation.conversation_key,
    legacy.conversation.source_sha256
  );
  const envelope = createConversationEnvelopeV1(legacy.conversation, {
    parserVersion: PARSER.version,
    parsedAt: options.parsedAt || legacy.conversation.parsed_at,
    sourceCapture: legacy.source_capture,
    archiveId,
    previousConversation: options.previousConversation || null,
    libraryContentTime: options.libraryContentTime || null,
    libraryOverride: options.libraryOverride || null,
    firstParsedAt: options.firstParsedAt || null
  });
  return {
    ...legacy,
    conversation: envelope.conversation,
    serialized: envelope.serialized,
    projection: envelope.projection
  };
}

export async function parseConversationFile(filePath, { parsedAt = null, clock = () => new Date() } = {}) {
  const absolute = path.resolve(filePath);
  const [sourceBuffer, information] = await Promise.all([readFile(absolute), stat(absolute)]);
  const sourceCreatedAt = (Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0
    ? information.birthtime
    : information.ctime).toISOString();
  const sourceModifiedAt = information.mtime.toISOString();
  return parseConversationBuffer(sourceBuffer, {
    sourceFile: path.basename(absolute),
    sourceCreatedAt: [sourceCreatedAt, sourceModifiedAt].sort((left, right) => Date.parse(left) - Date.parse(right))[0],
    parsedAt,
    clock
  });
}

export async function parseConversationFileLegacy(filePath, { parsedAt = null, clock = () => new Date() } = {}) {
  const absolute = path.resolve(filePath);
  const [sourceBuffer, information] = await Promise.all([readFile(absolute), stat(absolute)]);
  const sourceCreatedAt = (Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0
    ? information.birthtime
    : information.ctime).toISOString();
  const sourceModifiedAt = information.mtime.toISOString();
  return parseConversationBufferLegacy(sourceBuffer, {
    sourceFile: path.basename(absolute),
    sourceCreatedAt: [sourceCreatedAt, sourceModifiedAt].sort((left, right) => Date.parse(left) - Date.parse(right))[0],
    parsedAt,
    clock
  });
}
