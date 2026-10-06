import { createRequire } from "node:module";

import { normalizeLibraryV1, serializeLibraryV1 } from "./v1.mjs";

const require = createRequire(import.meta.url);
const legacy = require("./core.js");

export const V1_VERSION = "1.0.0";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isLibraryV1(value) {
  return value?.format === "cloudig/library" && value?.version === V1_VERSION;
}

export function normalizeLibraryDocument(value) {
  return isLibraryV1(value) ? normalizeLibraryV1(value) : legacy.normalizeLibrary(value);
}

export function serializeLibraryDocument(value) {
  return isLibraryV1(value) ? serializeLibraryV1(value) : legacy.serializeLibrary(value);
}

export function conversationOverride(value, conversationKey) {
  const library = normalizeLibraryDocument(value);
  const key = String(conversationKey || "").toLowerCase();
  return clone(library.conversation_overrides?.[key] || null);
}

export function applyConversationOverlay(documentValue, libraryValue) {
  const library = normalizeLibraryDocument(libraryValue);
  if (!isLibraryV1(library)) return legacy.applyConversationOverlay(documentValue, library);
  const document = clone(documentValue);
  const key = String(document?.identity?.conversation_key || document?.conversation_key || "").toLowerCase();
  const override = library.conversation_overrides?.[key];
  if (!override) return document;
  if (override.conversation_name) document.title = override.conversation_name;
  if (override.provider) document.provider = override.provider;
  if (override.platform) document.platform = override.platform;
  if (override.models) document.models = clone(override.models);
  if (override.user_name) document.user_name = override.user_name;
  if (override.assistant_name) document.assistant_name = override.assistant_name;
  if (document?.schema !== "ai-chat-archive/conversation/1.0.0" && Object.hasOwn(override, "content_time")) {
    document.content_time = override.content_time.state === "set" ? clone(override.content_time.range) : "";
  }
  return document;
}

export function assertLegacyWritable(value) {
  const library = normalizeLibraryDocument(value);
  if (isLibraryV1(library)) {
    const error = new Error("Library 1.0 must be changed through Cloudig domain commands, not whole-document library.save");
    error.code = "CLOUDIG_V1_DOMAIN_COMMAND_REQUIRED";
    throw error;
  }
  return library;
}
