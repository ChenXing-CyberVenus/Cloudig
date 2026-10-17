import { createHash, randomUUID } from "node:crypto";

import { serializeV1 } from "../../schema/canonical-v1.mjs";
import { CONVERSATION_SCHEMA_V1, validateConversationV1 } from "../../schema/validate-v1.mjs";
import { validateConversation } from "../../schema/validate.mjs";

export const PARSER_V1_VERSION = "0.6.0";

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CAPTURE_BASES = new Set([
  "bookmark_metadata",
  "source_metadata",
  "filesystem_earliest_create_or_modify",
  "filesystem_modified_time",
  "unavailable"
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function utc(value, label) {
  const text = cleanString(value);
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds)) throw new TypeError(`${label} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, stableJson(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function validateLegacy(value) {
  const result = validateConversation(value);
  if (!result.valid) throw new TypeError(`Legacy conversation is invalid:\n${result.errors.join("\n")}`);
  return value;
}

function normalizeCaptureFact(value) {
  if (value === undefined || value === null) return { basis: "unavailable" };
  if (!isRecord(value) || !CAPTURE_BASES.has(value.basis)) throw new TypeError("sourceCapture has an unsupported basis");
  if (value.basis === "unavailable") {
    if (value.value !== undefined || value.field !== undefined) throw new TypeError("Unavailable sourceCapture cannot contain value or field");
    return { basis: "unavailable" };
  }
  const output = { value: utc(value.value, "sourceCapture.value"), basis: value.basis };
  const field = cleanString(value.field);
  if (field) output.field = field;
  return output;
}

export function sourceCaptureFromContract(context) {
  const capturedAt = context?.manifest?.captured_at;
  if (capturedAt !== undefined && capturedAt !== null && cleanString(String(capturedAt))) {
    return normalizeCaptureFact({
      value: capturedAt,
      basis: "bookmark_metadata",
      field: "manifest.captured_at"
    });
  }
  const exportedAt = context?.manifest?.exported_at ?? context?.payload?.exported_at;
  if (exportedAt !== undefined && exportedAt !== null && cleanString(String(exportedAt))) {
    return normalizeCaptureFact({
      value: exportedAt,
      basis: "bookmark_metadata",
      field: context?.manifest?.exported_at !== undefined ? "manifest.exported_at" : "payload.exported_at"
    });
  }
  if (context?.sourceCreatedAt) {
    return normalizeCaptureFact({
      value: context.sourceCreatedAt,
      basis: "filesystem_earliest_create_or_modify"
    });
  }
  return { basis: "unavailable" };
}

function exactRangeFromUtc(value) {
  const date = new Date(utc(value, "content-time source"));
  return {
    start: {
      kind: "terran_exact",
      era: "AD",
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      utc_offset: "Z"
    },
    is_collapsed: true,
    is_reversed: false
  };
}

function messageTimes(messages) {
  const values = messages
    .map((message) => cleanString(message?.timestamp))
    .filter(Boolean)
    .map((value) => utc(value, "message.timestamp"))
    .sort((left, right) => Date.parse(left) - Date.parse(right) || left.localeCompare(right, "en"));
  return {
    ...(values.length ? { start: values[0], end: values.at(-1) } : {}),
    timestamped_messages: values.length,
    total_messages: messages.length
  };
}

function messageSignature(message) {
  const copy = cloneJson(message);
  delete copy.id;
  delete copy.parent_id;
  return digest(copy);
}

export function addStableMessageIds(messages, conversationKey) {
  if (!SHA256.test(cleanString(conversationKey).toLowerCase())) throw new TypeError("conversationKey must be a lowercase SHA-256");
  if (!Array.isArray(messages) || !messages.length) throw new TypeError("messages must be a non-empty array");
  const used = new Set(messages.map((message) => cleanString(message?.id)).filter(Boolean));
  const occurrences = new Map();
  return messages.map((message) => {
    const copy = cloneJson(message);
    if (cleanString(copy.id)) return copy;
    const signature = messageSignature(copy);
    const occurrence = (occurrences.get(signature) || 0) + 1;
    occurrences.set(signature, occurrence);
    let salt = 0;
    let id;
    do {
      const seed = `${conversationKey}\n${signature}\n${occurrence}\n${salt}`;
      id = `msg_${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
      salt += 1;
    } while (used.has(id));
    copy.id = id;
    used.add(id);
    return copy;
  });
}

function normalizeEffective(value, label) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || (value.source !== undefined && value.source !== "user")) {
    throw new TypeError(`${label} must be a user set/cleared content-time value`);
  }
  const { source: _ignoredSource, ...fields } = value;
  const source = { source: "user", ...fields };
  if (source.source !== "user" || !["set", "cleared"].includes(source.state)) {
    throw new TypeError(`${label} must be a user set/cleared content-time value`);
  }
  return cloneJson(source);
}

function effectiveContentTime(previousConversation, libraryContentTime) {
  const previous = previousConversation?.content_time?.effective?.source === "user"
    ? normalizeEffective(previousConversation.content_time.effective, "previous effective content time")
    : null;
  const library = normalizeEffective(libraryContentTime, "Library content time");
  if (previous && library && (previous.edit_id !== library.edit_id || previous.state !== library.state)) {
    throw new Error("CLOUDIG_CONTENT_TIME_EDIT_CONFLICT: conversation and Library user content time disagree");
  }
  return library || previous || { source: "parser" };
}

function firstParsedFact(previousConversation, firstParsedAt, parsedAt) {
  if (previousConversation?.lifecycle?.first_parsed_at) return cloneJson(previousConversation.lifecycle.first_parsed_at);
  if (firstParsedAt !== undefined && firstParsedAt !== null) {
    if (!isRecord(firstParsedAt) || !cleanString(firstParsedAt.basis)) throw new TypeError("firstParsedAt must be an evidence fact");
    return {
      ...(firstParsedAt.value === undefined ? {} : { value: utc(firstParsedAt.value, "firstParsedAt.value") }),
      basis: firstParsedAt.basis
    };
  }
  return { value: parsedAt, basis: "parser_creation" };
}

function archiveIdentity(previousConversation, archiveId, createArchiveId) {
  const previousId = cleanString(previousConversation?.identity?.archive_id).toLowerCase();
  const chosen = previousId || cleanString(archiveId || createArchiveId()).toLowerCase();
  if (!UUID.test(chosen)) throw new TypeError("archiveId must be a UUID");
  return chosen;
}

function parserDefault(messageTime, capturedAt, parsedAt) {
  if (messageTime.start) {
    return {
      edited_at: parsedAt,
      derivation: "message_start",
      range: exactRangeFromUtc(messageTime.start)
    };
  }
  if (capturedAt.value) {
    return {
      edited_at: parsedAt,
      derivation: "source_capture_fallback",
      range: exactRangeFromUtc(capturedAt.value)
    };
  }
  return { edited_at: parsedAt, derivation: "unavailable" };
}

export function legacyContentProjection(value) {
  return {
    messages: cloneJson(value.messages),
    ...(Array.isArray(value.resources) ? { resources: cloneJson(value.resources) } : {}),
    ...(Array.isArray(value.sources) ? { sources: cloneJson(value.sources) } : {}),
    ...(Array.isArray(value.warnings) ? { warnings: cloneJson(value.warnings) } : {})
  };
}

export function v1ContentProjection(value, legacyTemplate = null) {
  const projected = legacyContentProjection(value);
  if (legacyTemplate) {
    projected.messages = projected.messages.map((message, index) => {
      if (legacyTemplate.messages?.[index]?.id !== undefined) return message;
      const copy = cloneJson(message);
      delete copy.id;
      return copy;
    });
  }
  return projected;
}

export function contentProjectionDigest(value, legacyTemplate = null) {
  return digest(legacyTemplate ? v1ContentProjection(value, legacyTemplate) : legacyContentProjection(value));
}

export function createConversationEnvelopeV1(legacyConversation, {
  parserVersion = PARSER_V1_VERSION,
  parsedAt,
  cloudigEditedAt = null,
  sourceCapture,
  archiveId = null,
  createArchiveId = randomUUID,
  previousConversation = null,
  libraryContentTime = null,
  libraryOverride = null,
  firstParsedAt = null
} = {}) {
  const legacy = validateLegacy(cloneJson(legacyConversation));
  const now = utc(parsedAt ?? legacy.parsed_at, "parsedAt");
  const editedAt = cloudigEditedAt === null ? now : utc(cloudigEditedAt, "cloudigEditedAt");
  if (previousConversation !== null) {
    const previousResult = validateConversationV1(previousConversation);
    if (!previousResult.valid) throw new TypeError(`Previous V1 conversation is invalid:\n${previousResult.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
    if (previousConversation.identity.conversation_key !== legacy.conversation_key) {
      throw new Error("CLOUDIG_CONVERSATION_IDENTITY_CONFLICT: previous V1 conversation belongs to another conversation_key");
    }
  }
  const capturedAt = normalizeCaptureFact(sourceCapture ?? (
    legacy.exported_at
      ? { value: legacy.exported_at, basis: "bookmark_metadata", field: "legacy.exported_at" }
      : null
  ));
  const messages = addStableMessageIds(legacy.messages, legacy.conversation_key);
  const messageTime = messageTimes(messages);
  const override = isRecord(libraryOverride) ? libraryOverride : {};
  const conversation = {
    schema: CONVERSATION_SCHEMA_V1,
    identity: {
      conversation_key: legacy.conversation_key,
      archive_id: archiveIdentity(previousConversation, archiveId, createArchiveId)
    },
    generation: {
      parser_version: parserVersion,
      parser_adapter: cloneJson(legacy.parser_adapter),
      ...(legacy.exporter_version ? { exporter_version: legacy.exporter_version } : {})
    },
    lifecycle: {
      first_parsed_at: firstParsedFact(previousConversation, firstParsedAt, now),
      last_parsed_at: now,
      cloudig_edited_at: editedAt
    },
    source: {
      file: {
        name: legacy.source_file,
        sha256: legacy.source_sha256,
        size_bytes: legacy.source_size_bytes
      },
      ...(legacy.source_url ? { url: legacy.source_url } : {}),
      captured_at: capturedAt,
      ...(legacy.created_at ? { conversation_created_at: utc(legacy.created_at, "created_at") } : {}),
      ...(legacy.updated_at ? { conversation_updated_at: utc(legacy.updated_at, "updated_at") } : {})
    },
    message_time: messageTime,
    content_time: {
      parser_default: parserDefault(messageTime, capturedAt, now),
      effective: effectiveContentTime(previousConversation, libraryContentTime)
    },
    title: cleanString(override.conversation_name) || legacy.title,
    provider: cleanString(override.provider) || legacy.provider,
    platform: cleanString(override.platform) || legacy.platform,
    ...(Array.isArray(override.models) && override.models.length
      ? { models: cloneJson(override.models) }
      : Array.isArray(legacy.models) ? { models: cloneJson(legacy.models) } : {}),
    messages,
    ...(Array.isArray(legacy.resources) ? { resources: cloneJson(legacy.resources) } : {}),
    ...(Array.isArray(legacy.sources) ? { sources: cloneJson(legacy.sources) } : {}),
    ...(Array.isArray(legacy.warnings) ? { warnings: cloneJson(legacy.warnings) } : {})
  };
  const validation = validateConversationV1(conversation);
  if (!validation.valid) {
    throw new TypeError(`V1 conversation validation failed:\n${validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
  }
  const legacyDigest = digest(legacyContentProjection(legacy));
  const v1Digest = digest(v1ContentProjection(conversation, legacy));
  if (legacyDigest !== v1Digest) throw new Error("CLOUDIG_MIGRATION_CONTENT_DRIFT: V1 envelope changed conversation content");
  return {
    conversation,
    serialized: serializeV1(conversation),
    projection: { legacy_sha256: legacyDigest, v1_sha256: v1Digest, equal: true }
  };
}
