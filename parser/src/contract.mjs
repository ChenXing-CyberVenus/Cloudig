import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAttributes, parseHtml } from "./html.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = path.resolve(MODULE_DIR, "../source-families.json");
const MANIFEST_ID = "ai-chat-archive-manifest";

export const PARSER_CORE = Object.freeze({
  id: "ai-chat-archive/parser-core",
  version: "0.2.0",
  manifest_schema: "ai-chat-archive/manifest-v1"
});

const SOURCE_REGISTRY_SCHEMA = "ai-chat-archive/parser-sources/0.2.0";
const SOURCE_PROFILES = new Set(["light", "full", "all_branches"]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function scriptRanges(html) {
  const source = String(html ?? "");
  const result = [];
  const openingPattern = /<script\b([^>]*)>/giu;
  const closingPattern = /<\/script\s*>/giu;
  let cursor = 0;
  while (cursor < source.length) {
    openingPattern.lastIndex = cursor;
    const match = openingPattern.exec(source);
    if (!match) break;
    const openEnd = openingPattern.lastIndex;
    closingPattern.lastIndex = openEnd;
    const close = closingPattern.exec(source);
    const closeStart = close?.index ?? -1;
    const end = close ? closingPattern.lastIndex : source.length;
    result.push({
      start: match.index,
      openEnd,
      contentStart: openEnd,
      contentEnd: closeStart < 0 ? source.length : closeStart,
      end,
      attrs: parseAttributes(match[1])
    });
    cursor = Math.max(end, openEnd);
  }
  return result;
}

export function extractInertJsonScript(html, id) {
  const script = scriptRanges(html).find((candidate) => candidate.attrs.id === String(id));
  if (!script) throw new Error(`Missing inert JSON script #${id}`);
  if (String(script.attrs.type ?? "").toLowerCase() !== "application/json") {
    throw new Error(`Script #${id} must use type=application/json`);
  }
  if (script.contentEnd >= String(html).length) {
    throw new Error(`Script #${id} is missing a closing tag`);
  }
  const text = String(html).slice(script.contentStart, script.contentEnd);
  let value;
  try {
    value = objectValue(JSON.parse(text.replace(/^\uFEFF/u, "").trim()), `Script #${id}`);
  } catch (error) {
    throw new Error(`Script #${id} is not valid JSON: ${error.message}`);
  }
  return { ...script, id: String(id), text, value };
}

function maskScriptBodies(html) {
  const characters = String(html).split("");
  for (const script of scriptRanges(html)) {
    for (let index = script.contentStart; index < script.contentEnd; index += 1) {
      if (characters[index] !== "\r" && characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

export function loadSourceRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  return validateSourceRegistry(JSON.parse(readFileSync(registryPath, "utf8")), registryPath);
}

export function validateSourceRegistry(value, registryPath = "<memory>") {
  const registry = objectValue(value, "Source registry");
  if (registry.schema !== SOURCE_REGISTRY_SCHEMA) {
    throw new Error(`Unsupported source registry: ${registry.schema ?? "<missing>"}`);
  }
  if (registry.manifest_schema !== PARSER_CORE.manifest_schema) {
    throw new Error(`Registry manifest mismatch: ${registry.manifest_schema ?? "<missing>"}`);
  }
  if (!Array.isArray(registry.sources) || !registry.sources.length) {
    throw new Error("Source registry must contain sources");
  }
  const ids = new Set();
  const schemas = new Set();
  const routes = new Set();
  const platformSources = new Map();
  for (const source of registry.sources) {
    for (const field of ["id", "profile", "provider", "platform", "payload_id", "payload_schema"]) {
      if (typeof source?.[field] !== "string" || !source[field]) {
        throw new Error(`Source registry entry is missing ${field}`);
      }
    }
    if (!SOURCE_PROFILES.has(source.profile)) {
      throw new Error(`Unsupported source profile: ${source.profile}`);
    }
    if (source.fallback !== undefined && source.fallback !== true && source.fallback !== false) {
      throw new Error(`Source registry fallback must be boolean: ${source.id}`);
    }
    if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    if (schemas.has(source.payload_schema)) throw new Error(`Duplicate payload schema: ${source.payload_schema}`);
    const route = `${source.platform}\u0000${source.payload_schema}`;
    if (routes.has(route)) {
      throw new Error(`Duplicate source route: platform=${source.platform} payload=${source.payload_schema}`);
    }
    ids.add(source.id);
    schemas.add(source.payload_schema);
    routes.add(route);
    const entries = platformSources.get(source.platform) ?? [];
    entries.push(source);
    platformSources.set(source.platform, entries);
  }
  for (const [platform, entries] of platformSources) {
    const fallbacks = entries.filter((source) => source.fallback === true);
    if (fallbacks.length !== 1) {
      throw new Error(`platform=${platform} must declare exactly one fallback source; got ${fallbacks.length}`);
    }
    if (new Set(entries.map((source) => source.provider)).size !== 1) {
      throw new Error(`platform=${platform} must use one provider across all source families`);
    }
  }
  return { path: registryPath, ...registry };
}

function uniqueSource(sources, predicate, label) {
  const matches = sources.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`${label} must match exactly one source family; got ${matches.length}`);
  }
  return matches[0];
}

function topLevelMessageNodes(dom) {
  const candidates = dom.nodes.filter((node) =>
    node.attrs["data-message-id"] || node.attrs["data-source-id"]
  );
  return candidates.filter((node) => {
    const id = String(node.attrs["data-message-id"] ?? node.attrs["data-source-id"]);
    let parent = node.parent;
    while (parent && parent.tag !== "#document") {
      const parentId = parent.attrs?.["data-message-id"] ?? parent.attrs?.["data-source-id"];
      if (String(parentId ?? "") === id) return false;
      parent = parent.parent;
    }
    return true;
  });
}

function groupNodes(nodes) {
  const result = new Map();
  for (const node of nodes) {
    const id = String(node.attrs["data-message-id"] ?? node.attrs["data-source-id"]);
    const existing = result.get(id) ?? [];
    existing.push(node);
    result.set(id, existing);
  }
  return result;
}

function manifestSchema(manifest) {
  return String(manifest.format ?? manifest.schema ?? "");
}

export function manifestExporterVersion(manifest) {
  const value = manifest?.exporter_version ?? manifest?.exporter?.version;
  return typeof value === "string" && value.trim().length ? value : null;
}

function manifestPayloadId(manifest) {
  const value = manifest.payload?.element_id ?? manifest.payload?.script_id;
  return typeof value === "string" && value ? value : null;
}

function payloadObjectSchema(payload) {
  const value = payload.format ?? payload.schema;
  return typeof value === "string" && value ? value : null;
}

function manifestPayloadSchema(manifest) {
  const value = manifest.payload?.format ?? manifest.payload?.schema;
  return typeof value === "string" && value ? value : null;
}

function platformFallback(sources, platform) {
  return uniqueSource(
    sources,
    (source) => source.fallback === true,
    `platform=${platform} fallback`
  );
}

export function parseContractHtml({ sourceBuffer, sourceFile, sourceCreatedAt = null, registryPath = DEFAULT_REGISTRY_PATH }) {
  if (!Buffer.isBuffer(sourceBuffer)) throw new TypeError("sourceBuffer must be a Buffer");
  if (!sourceBuffer.length) throw new Error("Source HTML is empty");
  const basename = path.basename(String(sourceFile ?? "conversation.html"));
  if (!basename || basename === "." || basename === path.sep) throw new Error("sourceFile must have a basename");
  const html = sourceBuffer.toString("utf8").replace(/^\uFEFF/u, "");
  const manifestScript = extractInertJsonScript(html, MANIFEST_ID);
  const manifest = manifestScript.value;
  const actualManifestSchema = manifestSchema(manifest);
  if (actualManifestSchema !== PARSER_CORE.manifest_schema) {
    throw new Error(`Unsupported manifest: ${actualManifestSchema || "<missing>"}`);
  }
  const exporterVersion = manifestExporterVersion(manifest);
  const platform = String(manifest.platform ?? "");
  if (!platform) throw new Error("Manifest is missing platform");

  const registry = loadSourceRegistry(registryPath);
  const platformSources = registry.sources.filter((candidate) => candidate.platform === platform);
  if (!platformSources.length) {
    throw new Error(`platform=${platform} must match at least one source family`);
  }
  const fallbackSource = platformFallback(platformSources, platform);
  const actualPayloadId = manifestPayloadId(manifest)
    ?? fallbackSource.payload_id;
  const payloadScript = extractInertJsonScript(html, actualPayloadId);
  const payload = payloadScript.value;
  const objectPayloadSchema = payloadObjectSchema(payload);
  const descriptorPayloadSchema = manifestPayloadSchema(manifest);
  if (
    objectPayloadSchema
    && descriptorPayloadSchema
    && objectPayloadSchema !== descriptorPayloadSchema
  ) {
    throw new Error(
      `Payload schema mismatch: ${objectPayloadSchema} != ${descriptorPayloadSchema}`
    );
  }
  const actualPayloadSchema = objectPayloadSchema
    ?? descriptorPayloadSchema
    ?? fallbackSource.payload_schema;
  const source = uniqueSource(
    platformSources,
    (candidate) => candidate.payload_schema === actualPayloadSchema,
    `platform=${platform} payload=${actualPayloadSchema}`
  );
  if (actualPayloadId !== source.payload_id) {
    throw new Error(`Payload script id mismatch: ${actualPayloadId} != ${source.payload_id}`);
  }
  if (payload.platform && String(payload.platform) !== platform) {
    throw new Error(`Payload platform mismatch: ${payload.platform} != ${platform}`);
  }

  const maskedHtml = maskScriptBodies(html);
  const dom = parseHtml(maskedHtml);
  const messageNodes = topLevelMessageNodes(dom);
  return {
    sourceBuffer,
    sourceFile: basename,
    sourceSha256: sha256(sourceBuffer),
    sourceSizeBytes: sourceBuffer.length,
    sourceCreatedAt,
    html,
    maskedHtml,
    manifest,
    manifestScript,
    manifestSchema: actualManifestSchema,
    exporterVersion,
    payload,
    payloadScript,
    payloadId: actualPayloadId,
    payloadSchema: actualPayloadSchema,
    platform,
    source,
    registryPath: registry.path,
    dom,
    messageNodes,
    messageNodesById: groupNodes(messageNodes)
  };
}

export function inspectContract(context) {
  const sequence = Array.isArray(context.payload.items)
    ? context.payload.items
    : Array.isArray(context.payload.messages)
      ? context.payload.messages
      : [];
  return {
    source_id: context.source.id,
    profile: context.source.profile,
    provider: context.source.provider,
    platform: context.platform,
    manifest_schema: context.manifestSchema,
    payload_schema: context.payloadSchema,
    payload_id: context.payloadId,
    sequence_items: sequence.length,
    dom_message_fragments: context.messageNodes.length,
    dom_message_ids: context.messageNodesById.size
  };
}
