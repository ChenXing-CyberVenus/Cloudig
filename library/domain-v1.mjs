import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { normalizeLibraryV1 } from "./v1.mjs";
import { serializeV1 } from "../schema/canonical-v1.mjs";
import { validateConversationV1 } from "../schema/validate-v1.mjs";

const require = createRequire(import.meta.url);
const time = require("../time/core.js");
const timeSystem = require("../time/system.js");

export const DOMAIN_VERSION = "1.0.0";
export const SNAPSHOT_SCHEMA = "cloudig/sovereign-time-snapshot/1.0.0";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/u;
const CONVERSATION_PATCH_KEYS = new Set([
  "conversation_name", "provider", "platform", "models", "user_name", "assistant_name"
]);

export class CloudigDomainError extends Error {
  constructor(code, path, message, details = undefined) {
    super(message);
    this.name = "CloudigDomainError";
    this.code = code;
    this.path = path;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, path, message, details) {
  throw new CloudigDomainError(code, path, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function utc(value, path = "$.now") {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be an ISO date-time with offset`);
  }
  return new Date(value).toISOString();
}

function uuid(value, path) {
  const result = String(value || "");
  if (!UUID.test(result)) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", path, `${path} must be a lowercase UUID`);
  return result;
}

function sha(value, path) {
  const result = String(value || "");
  if (!SHA256.test(result)) fail("CLOUDIG_CONVERSATION_CHANGED", path, `${path} must be a lowercase SHA-256`);
  return result;
}

function text(value, path, maximum) {
  if (typeof value !== "string") fail("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be a string`);
  const result = value.trim().normalize("NFC");
  if (!result || [...result].length > maximum) {
    fail("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must contain 1 to ${maximum} Unicode code points`);
  }
  return result;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, stableValue(value[key])]));
}

function stableText(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : stableText(value)).digest("hex");
}

function semanticKey(value) {
  return JSON.stringify(stableValue(value));
}

function canonicalAnchor(value) {
  return time.materializePresetEndpoint(
    { kind: "terran_now", anchor_policy: "materialize_on_apply" },
    value,
    "$.anchor"
  ).anchor;
}

function selectorForNode(value, node, path) {
  if (node.kind !== "time" || node.time_kind !== "periodic") {
    if (value !== undefined) fail("CLOUDIG_TIME_INVALID_PERIOD_SELECTOR", path, "Only a periodic time node accepts occurrences");
    return undefined;
  }
  return time.normalizePeriodSelector(value || { mode: "all" }, node.period_count, { path });
}

function normalizeNodeRef(value, nodes, path) {
  if (!isRecord(value)) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", path, `${path} must be a node reference`);
  for (const key of Object.keys(value)) {
    if (!new Set(["node_id", "occurrences"]).has(key)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.${key}`, "Unknown node reference field");
  }
  const nodeId = uuid(value.node_id, `${path}.node_id`);
  const node = nodes[nodeId];
  if (!node) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `${path}.node_id`, `Referenced node does not exist: ${nodeId}`);
  const occurrences = selectorForNode(value.occurrences, node, `${path}.occurrences`);
  return { node_id: nodeId, ...(occurrences ? { occurrences } : {}) };
}

function normalizedNodeRefKey(value, nodes) {
  const result = normalizeNodeRef(value, nodes, "$.node_ref");
  const node = nodes[result.node_id];
  return semanticKey({
    node_id: result.node_id,
    ...(node.kind === "time" && node.time_kind === "periodic"
      ? { occurrences: result.occurrences || { mode: "all" } }
      : {})
  });
}

function timelineForNode(nodes, nodeId, path = "$.node_id") {
  const node = nodes[nodeId];
  if (!node) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", path, `Referenced node does not exist: ${nodeId}`);
  const timelineId = node.kind === "timeline" ? nodeId : node.owner_timeline_id;
  const timeline = nodes[timelineId];
  if (!timeline || timeline.kind !== "timeline") {
    fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", path, `Node owner timeline does not exist: ${timelineId}`);
  }
  return { timelineId, timeline };
}

function normalizeVersion(value, path) {
  if (!isRecord(value) || !Number.isSafeInteger(value.major) || !Number.isSafeInteger(value.minor)
    || value.major < 0 || value.major > time.LIMITS.sovereign.display_version_major_max
    || value.minor < 0 || value.minor > time.LIMITS.sovereign.display_version_minor_max
    || Object.keys(value).some((key) => !new Set(["major", "minor"]).has(key))) {
    fail("CLOUDIG_TIME_INVALID_ENDPOINT", path, "Display version is outside the V1 limits");
  }
  return { major: value.major, minor: value.minor };
}

function normalizeTimeSystemSemantics(value) {
  const system = timeSystem.normalizeContentTimeSystem(value);
  const sovereign = system.sovereign;
  const limits = time.LIMITS.sovereign;
  const nodeIds = Object.keys(sovereign.nodes);
  const physicalLinks = Object.keys(sovereign.containment_links).length
    + Object.keys(sovereign.counterpart_links).length
    + Object.keys(sovereign.terran_mappings).length
    + Object.keys(sovereign.conversation_bindings).length;
  if (nodeIds.length > limits.physical_nodes_max || physicalLinks > limits.physical_links_max) {
    fail("CLOUDIG_TIME_GRAPH_LIMIT", "$.sovereign", "Sovereign graph exceeds the configured V1 physical limit", {
      nodes: nodeIds.length,
      links: physicalLinks,
      limits_version: time.LIMITS.version
    });
  }

  const lineages = {};
  for (const lineageId of Object.keys(sovereign.lineages).sort((a, b) => a.localeCompare(b, "en"))) {
    uuid(lineageId, `$.sovereign.lineages.${lineageId}`);
    const raw = sovereign.lineages[lineageId];
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "next_variant_no")
      || !Number.isSafeInteger(raw.next_variant_no) || raw.next_variant_no < 2
      || raw.next_variant_no > limits.timeline_variants_max + 1) {
      fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.lineages.${lineageId}`, "Lineage next_variant_no is invalid");
    }
    lineages[lineageId] = { next_variant_no: raw.next_variant_no };
  }

  const nodes = {};
  for (const nodeId of nodeIds.sort((a, b) => a.localeCompare(b, "en"))) {
    uuid(nodeId, `$.sovereign.nodes.${nodeId}`);
    const raw = sovereign.nodes[nodeId];
    if (!isRecord(raw)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}`, "Node must be an object");
    if (raw.kind === "timeline") {
      const allowed = new Set(["kind", "lineage_id", "variant_no", "document_revision", "name", "author", "standard_name", "display_version", "created_at", "edited_at"]);
      if (Object.keys(raw).some((key) => !allowed.has(key))) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}`, "Timeline contains an unknown field");
      const lineageId = uuid(raw.lineage_id, `$.sovereign.nodes.${nodeId}.lineage_id`);
      if (!lineages[lineageId]) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `$.sovereign.nodes.${nodeId}.lineage_id`, "Timeline lineage does not exist");
      if (!Number.isSafeInteger(raw.variant_no) || raw.variant_no < 1 || raw.variant_no > limits.timeline_variants_max) fail("CLOUDIG_TIME_GRAPH_LIMIT", `$.sovereign.nodes.${nodeId}.variant_no`, "Timeline variant number is outside the V1 limit");
      if (!Number.isSafeInteger(raw.document_revision) || raw.document_revision < 1) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}.document_revision`, "Timeline document_revision must be positive");
      nodes[nodeId] = {
        kind: "timeline",
        lineage_id: lineageId,
        variant_no: raw.variant_no,
        document_revision: raw.document_revision,
        name: text(raw.name, `$.sovereign.nodes.${nodeId}.name`, limits.timeline_name_codepoints),
        author: text(raw.author, `$.sovereign.nodes.${nodeId}.author`, limits.author_name_codepoints),
        standard_name: text(raw.standard_name, `$.sovereign.nodes.${nodeId}.standard_name`, limits.standard_name_codepoints),
        display_version: normalizeVersion(raw.display_version, `$.sovereign.nodes.${nodeId}.display_version`),
        created_at: utc(raw.created_at, `$.sovereign.nodes.${nodeId}.created_at`),
        edited_at: utc(raw.edited_at, `$.sovereign.nodes.${nodeId}.edited_at`)
      };
    } else if (raw.kind === "time") {
      const allowed = new Set(["kind", "owner_timeline_id", "time_kind", "name", "prefix", "unit_name", "period_count", "empty_occurrence_display", "created_at", "edited_at"]);
      if (Object.keys(raw).some((key) => !allowed.has(key))) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}`, "Time node contains an unknown field");
      if (!new Set(["single", "periodic"]).has(raw.time_kind)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}.time_kind`, "Time node kind is invalid");
      const result = {
        kind: "time",
        owner_timeline_id: uuid(raw.owner_timeline_id, `$.sovereign.nodes.${nodeId}.owner_timeline_id`),
        time_kind: raw.time_kind,
        name: text(raw.name, `$.sovereign.nodes.${nodeId}.name`, limits.time_name_codepoints),
        created_at: utc(raw.created_at, `$.sovereign.nodes.${nodeId}.created_at`),
        edited_at: utc(raw.edited_at, `$.sovereign.nodes.${nodeId}.edited_at`)
      };
      if (raw.time_kind === "periodic") {
        if (!Number.isSafeInteger(raw.period_count) || raw.period_count < 1 || raw.period_count > limits.period_count_max) fail("CLOUDIG_TIME_GRAPH_LIMIT", `$.sovereign.nodes.${nodeId}.period_count`, "Period count is outside the V1 limit");
        result.period_count = raw.period_count;
        if (raw.prefix !== undefined) result.prefix = text(raw.prefix, `$.sovereign.nodes.${nodeId}.prefix`, limits.prefix_codepoints);
        if (raw.unit_name !== undefined) result.unit_name = text(raw.unit_name, `$.sovereign.nodes.${nodeId}.unit_name`, limits.unit_name_codepoints);
        if (raw.empty_occurrence_display !== undefined) {
          if (!new Set(["collapse_unmapped", "expand_all_empty"]).has(raw.empty_occurrence_display)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}.empty_occurrence_display`, "Unsupported empty occurrence display mode");
          if (raw.empty_occurrence_display === "expand_all_empty" && raw.period_count > limits.empty_period_expand_max) fail("CLOUDIG_TIME_GRAPH_LIMIT", `$.sovereign.nodes.${nodeId}.empty_occurrence_display`, "The complete empty occurrence list exceeds the V1 expansion limit");
          result.empty_occurrence_display = raw.empty_occurrence_display;
        }
      } else if (["period_count", "prefix", "unit_name", "empty_occurrence_display"].some((key) => Object.hasOwn(raw, key))) {
        fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}`, "Single time node cannot contain periodic fields");
      }
      nodes[nodeId] = result;
    } else fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}.kind`, "Node kind must be timeline or time");
  }

  const lineageVariants = new Map();
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.kind === "time") timelineForNode(nodes, node.owner_timeline_id, `$.sovereign.nodes.${nodeId}.owner_timeline_id`);
    else {
      const key = `${node.lineage_id}:${node.variant_no}`;
      if (lineageVariants.has(key)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.nodes.${nodeId}.variant_no`, "Timeline variant number is duplicated within its lineage");
      lineageVariants.set(key, nodeId);
      if (lineages[node.lineage_id].next_variant_no <= node.variant_no) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.lineages.${node.lineage_id}.next_variant_no`, "Lineage watermark must stay above every existing variant");
    }
  }

  const containment_links = {};
  const ordinals = new Map();
  for (const linkId of Object.keys(sovereign.containment_links).sort((a, b) => a.localeCompare(b, "en"))) {
    uuid(linkId, `$.sovereign.containment_links.${linkId}`);
    const raw = sovereign.containment_links[linkId];
    if (!isRecord(raw) || Object.keys(raw).some((key) => !new Set(["parent_node_id", "child", "ordinal", "created_at", "edited_at"]).has(key))) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.containment_links.${linkId}`, "Containment link is invalid");
    const parent = uuid(raw.parent_node_id, `$.sovereign.containment_links.${linkId}.parent_node_id`);
    if (!nodes[parent]) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `$.sovereign.containment_links.${linkId}.parent_node_id`, "Containment parent does not exist");
    const child = normalizeNodeRef(raw.child, nodes, `$.sovereign.containment_links.${linkId}.child`);
    if (!Number.isSafeInteger(raw.ordinal) || raw.ordinal < 1) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.containment_links.${linkId}.ordinal`, "Containment ordinal must be positive");
    if (!ordinals.has(parent)) ordinals.set(parent, []);
    ordinals.get(parent).push(raw.ordinal);
    containment_links[linkId] = { parent_node_id: parent, child, ordinal: raw.ordinal, created_at: utc(raw.created_at), edited_at: utc(raw.edited_at) };
  }
  for (const [parent, values] of ordinals) {
    const sorted = [...values].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length || sorted.some((value, index) => value !== index + 1)) {
      fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.containment_links`, `Containment ordinals below ${parent} must be unique and gapless`);
    }
  }

  const counterpart_links = {};
  const counterpartKeys = new Set();
  for (const linkId of Object.keys(sovereign.counterpart_links).sort((a, b) => a.localeCompare(b, "en"))) {
    uuid(linkId, `$.sovereign.counterpart_links.${linkId}`);
    const raw = sovereign.counterpart_links[linkId];
    if (!isRecord(raw) || Object.keys(raw).some((key) => !new Set(["left", "right", "created_at", "edited_at"]).has(key))) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.counterpart_links.${linkId}`, "Counterpart link is invalid");
    let left = normalizeNodeRef(raw.left, nodes, `$.sovereign.counterpart_links.${linkId}.left`);
    let right = normalizeNodeRef(raw.right, nodes, `$.sovereign.counterpart_links.${linkId}.right`);
    if (normalizedNodeRefKey(left, nodes).localeCompare(normalizedNodeRefKey(right, nodes), "en") > 0) [left, right] = [right, left];
    const key = `${normalizedNodeRefKey(left, nodes)}|${normalizedNodeRefKey(right, nodes)}`;
    if (counterpartKeys.has(key)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.counterpart_links.${linkId}`, "Equivalent counterpart link already exists");
    counterpartKeys.add(key);
    counterpart_links[linkId] = { left, right, created_at: utc(raw.created_at), edited_at: utc(raw.edited_at) };
  }

  const terran_mappings = {};
  const mappingKeys = new Set();
  for (const mappingId of Object.keys(sovereign.terran_mappings).sort((a, b) => a.localeCompare(b, "en"))) {
    uuid(mappingId, `$.sovereign.terran_mappings.${mappingId}`);
    const raw = sovereign.terran_mappings[mappingId];
    if (!isRecord(raw) || Object.keys(raw).some((key) => !new Set(["node_ref", "range", "edited_at"]).has(key))) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.terran_mappings.${mappingId}`, "Terran mapping is invalid");
    const node_ref = normalizeNodeRef(raw.node_ref, nodes, `$.sovereign.terran_mappings.${mappingId}.node_ref`);
    const result = time.validateRange(raw.range, { require_flags: true });
    if (!result.valid || [result.value?.start, result.value?.end].filter(Boolean).some((endpoint) => endpoint.kind === "sovereign")) {
      const issue = result.errors?.[0];
      fail(issue?.code || "CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.terran_mappings.${mappingId}.range${issue?.path?.slice(1) || ""}`, issue?.message || "Terran mapping cannot contain Sovereign endpoints");
    }
    const key = `${normalizedNodeRefKey(node_ref, nodes)}|${semanticKey(result.value)}`;
    if (mappingKeys.has(key)) fail("CLOUDIG_TIME_DUPLICATE_MAPPING", `$.sovereign.terran_mappings.${mappingId}`, "Equivalent direct Terran mapping already exists");
    mappingKeys.add(key);
    terran_mappings[mappingId] = { node_ref, range: result.value, edited_at: utc(raw.edited_at) };
  }

  const conversation_bindings = {};
  for (const bindingId of Object.keys(sovereign.conversation_bindings).sort((a, b) => a.localeCompare(b, "en"))) {
    uuid(bindingId, `$.sovereign.conversation_bindings.${bindingId}`);
    const raw = sovereign.conversation_bindings[bindingId];
    if (!isRecord(raw) || Object.keys(raw).some((key) => !new Set(["conversation_key", "node_ref", "created_at", "edited_at"]).has(key))) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.sovereign.conversation_bindings.${bindingId}`, "Conversation binding is invalid");
    conversation_bindings[bindingId] = {
      conversation_key: sha(raw.conversation_key, `$.sovereign.conversation_bindings.${bindingId}.conversation_key`),
      node_ref: normalizeNodeRef(raw.node_ref, nodes, `$.sovereign.conversation_bindings.${bindingId}.node_ref`),
      created_at: utc(raw.created_at),
      edited_at: utc(raw.edited_at)
    };
  }

  let display_order;
  if (sovereign.display_order?.mode === "last_edited_desc") display_order = { mode: "last_edited_desc" };
  else if (sovereign.display_order?.mode === "manual" && Array.isArray(sovereign.display_order.timeline_ids)) {
    const timeline_ids = sovereign.display_order.timeline_ids.map((id, index) => {
      const nodeId = uuid(id, `$.sovereign.display_order.timeline_ids[${index}]`);
      if (nodes[nodeId]?.kind !== "timeline") fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `$.sovereign.display_order.timeline_ids[${index}]`, "Manual display order must contain timeline IDs");
      return nodeId;
    });
    if (new Set(timeline_ids).size !== timeline_ids.length) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.sovereign.display_order.timeline_ids", "Manual display order contains duplicates");
    display_order = { mode: "manual", timeline_ids };
  } else fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.sovereign.display_order", "Unsupported Sovereign display order");

  return {
    ...system,
    sovereign: { lineages, nodes, containment_links, counterpart_links, terran_mappings, conversation_bindings, display_order }
  };
}

export function validateTimeSystemSemantics(value) {
  try {
    return { valid: true, value: normalizeTimeSystemSemantics(value), errors: [] };
  } catch (error) {
    if (!(error instanceof CloudigDomainError) && !error?.path) throw error;
    return {
      valid: false,
      errors: [{
        code: String(error.code || "CLOUDIG_TIME_INVALID_ENDPOINT"),
        path: String(error.path || "$"),
        message: String(error.message || error),
        ...(error.details === undefined ? {} : { details: clone(error.details) })
      }]
    };
  }
}

export function assertLibraryDomainV1(value) {
  const library = normalizeLibraryV1(value);
  const validation = validateTimeSystemSemantics(library.content_time_system);
  if (!validation.valid) {
    const issue = validation.errors[0];
    fail(issue.code, `$.content_time_system${issue.path.slice(1)}`, issue.message, issue.details);
  }
  const normalized = { ...library, content_time_system: validation.value };
  const referencedBindings = new Set();
  for (const [conversationKey, override] of Object.entries(normalized.conversation_overrides || {})) {
    if (override.content_time?.state !== "set") continue;
    for (const bindingId of bindingIdsInRange(override.content_time.range)) {
      const binding = normalized.content_time_system.sovereign.conversation_bindings[bindingId];
      if (!binding || binding.conversation_key !== conversationKey) {
        fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `$.conversation_overrides.${conversationKey}.content_time.range`, "Sovereign endpoint must reference a binding owned by the same conversation");
      }
      referencedBindings.add(bindingId);
    }
  }
  for (const [bindingId, binding] of Object.entries(normalized.content_time_system.sovereign.conversation_bindings)) {
    if (!referencedBindings.has(bindingId)) {
      fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `$.content_time_system.sovereign.conversation_bindings.${bindingId}`, `Conversation binding is orphaned from ${binding.conversation_key}`);
    }
  }
  return normalized;
}

function materializeDraftEndpoint(value, anchor, { refresh = false } = {}) {
  if (!isRecord(value)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.range", "Content-time endpoint draft must be an object");
  if (value.kind === "sovereign_selection") return clone(value);
  if (value.kind === "terran_now") {
    const next = { kind: value.kind, anchor: refresh || !value.anchor ? canonicalAnchor(anchor) : value.anchor };
    return time.normalizeEndpoint(next);
  }
  if (value.kind === "terran_relative") {
    const next = { ...value, anchor: refresh || !value.anchor ? canonicalAnchor(anchor) : value.anchor };
    return time.normalizeEndpoint(next);
  }
  return time.normalizeEndpoint(value);
}

function materializeTerranDraftRange(value, anchor, options = {}) {
  if (!isRecord(value) || !value.start) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.range", "Content-time range draft requires start");
  const start = materializeDraftEndpoint(value.start, anchor, options);
  const end = value.end ? materializeDraftEndpoint(value.end, anchor, options) : undefined;
  if ([start, end].filter(Boolean).some((endpoint) => endpoint.kind === "sovereign_selection")) return { start, ...(end ? { end } : {}) };
  return time.normalizeRange({ start, ...(end ? { end } : {}) });
}

export function previewContentTimeRange({ range, anchor, locale = "zh-CN", context = {} }) {
  try {
    const normalized = materializeTerranDraftRange(range, anchor, { refresh: false });
    if ([normalized.start, normalized.end].filter(Boolean).some((endpoint) => endpoint.kind === "sovereign_selection")) {
      return {
        valid: false,
        errors: [{ code: "CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", path: "$.range", message: "Sovereign draft preview requires a Library graph context" }],
        limits_version: time.LIMITS.version
      };
    }
    return {
      valid: true,
      normalized_range: normalized,
      label: time.formatRange(normalized, { locale, context }),
      warnings: normalized.is_reversed ? ["CLOUDIG_TIME_REVERSED"] : [],
      sort_descriptor: time.sortDescriptorForRange(normalized, context),
      limits_version: time.LIMITS.version
    };
  } catch (error) {
    return {
      valid: false,
      errors: [{ code: String(error.code || "CLOUDIG_TIME_INVALID_ENDPOINT"), path: String(error.path || "$.range"), message: String(error.message || error) }],
      limits_version: time.LIMITS.version
    };
  }
}

function directMappingMatches(mapping, binding, nodes) {
  if (mapping.node_ref.node_id !== binding.node_ref.node_id) return false;
  const node = nodes[binding.node_ref.node_id];
  if (node.kind !== "time" || node.time_kind !== "periodic") return true;
  return time.selectorIntersects(
    mapping.node_ref.occurrences || { mode: "all" },
    binding.node_ref.occurrences || { mode: "all" },
    node.period_count
  );
}

function nodeStub(nodeId, nodes) {
  const node = nodes[nodeId];
  if (!node) return null;
  const { timeline } = timelineForNode(nodes, nodeId);
  return {
    node_id: nodeId,
    name: node.name,
    ...(nodeId === timelineForNode(nodes, nodeId).timelineId ? {} : { timeline_name: timeline.name })
  };
}

export function buildSovereignSnapshot(value, bindingId, capturedAt) {
  const system = normalizeTimeSystemSemantics(value);
  const binding_id = uuid(bindingId, "$.binding_id");
  const binding = system.sovereign.conversation_bindings[binding_id];
  if (!binding) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.binding_id", "Conversation binding does not exist");
  const nodes = system.sovereign.nodes;
  const node = nodes[binding.node_ref.node_id];
  const { timelineId, timeline } = timelineForNode(nodes, binding.node_ref.node_id);
  const pathResult = time.canonicalSovereignPath({
    root_node_id: timelineId,
    target_node_id: binding.node_ref.node_id,
    containment_links: Object.entries(system.sovereign.containment_links).map(([link_id, link]) => ({ link_id, ...link }))
  });
  const directMappings = Object.entries(system.sovereign.terran_mappings)
    .filter(([, mapping]) => directMappingMatches(mapping, binding, nodes))
    .map(([mapping_id, mapping]) => ({ mapping_id, range: clone(mapping.range) }))
    .sort((left, right) => left.mapping_id.localeCompare(right.mapping_id, "en"));
  const neighbors = [];
  for (const link of Object.values(system.sovereign.containment_links)) {
    if (link.parent_node_id === binding.node_ref.node_id) {
      const stub = nodeStub(link.child.node_id, nodes);
      if (stub) neighbors.push({ relation: "child", ...stub });
    }
    if (link.child.node_id === binding.node_ref.node_id) {
      const stub = nodeStub(link.parent_node_id, nodes);
      if (stub) neighbors.push({ relation: "parent", ...stub });
    }
  }
  for (const link of Object.values(system.sovereign.counterpart_links)) {
    const other = link.left.node_id === binding.node_ref.node_id ? link.right.node_id
      : link.right.node_id === binding.node_ref.node_id ? link.left.node_id : "";
    const stub = nodeStub(other, nodes);
    if (stub) neighbors.push({ relation: "counterpart", ...stub });
  }
  const direct_neighbors = [...new Map(neighbors
    .sort((left, right) => left.relation.localeCompare(right.relation, "en") || left.node_id.localeCompare(right.node_id, "en"))
    .map((entry) => [`${entry.relation}:${entry.node_id}`, entry])).values()];
  const payload = {
    timeline: {
      node_id: timelineId,
      lineage_id: timeline.lineage_id,
      variant_no: timeline.variant_no,
      document_revision: timeline.document_revision,
      name: timeline.name,
      author: timeline.author,
      standard_name: timeline.standard_name,
      display_version: clone(timeline.display_version)
    },
    node: node.kind === "timeline"
      ? { node_id: binding.node_ref.node_id, kind: "timeline", name: node.name }
      : {
          node_id: binding.node_ref.node_id,
          kind: "time",
          time_kind: node.time_kind,
          name: node.name,
          ...(node.time_kind === "periodic" ? { period_count: node.period_count } : {})
        },
    ...(binding.node_ref.occurrences ? { occurrences: clone(binding.node_ref.occurrences) } : {}),
    ordinal_path: pathResult.found ? pathResult.path : [],
    direct_terran_mappings: directMappings,
    direct_neighbors
  };
  return {
    schema: SNAPSHOT_SCHEMA,
    captured_at: utc(capturedAt, "$.captured_at"),
    payload,
    sha256: digest(payload)
  };
}

function applyConversationPatch(value, patch) {
  if (patch === undefined) return {};
  if (!isRecord(patch)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.patch", "Conversation patch must be an object");
  for (const key of Object.keys(patch)) {
    if (!CONVERSATION_PATCH_KEYS.has(key)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.patch.${key}`, "Unknown conversation metadata field");
  }
  const result = {};
  if (patch.conversation_name !== undefined) result.conversation_name = text(patch.conversation_name, "$.patch.conversation_name", 500);
  for (const key of ["provider", "platform"]) {
    if (patch[key] !== undefined) {
      const normalized = text(patch[key], `$.patch.${key}`, 100).toLowerCase();
      if (!SLUG.test(normalized)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.patch.${key}`, "Provider/platform must be a stable slug");
      result[key] = normalized;
    }
  }
  if (patch.models !== undefined) {
    if (!Array.isArray(patch.models) || !patch.models.length) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.patch.models", "Models must be a non-empty array");
    result.models = [...new Set(patch.models.map((item, index) => text(item, `$.patch.models[${index}]`, 500)))];
  }
  for (const key of ["user_name", "assistant_name"]) if (patch[key] !== undefined) result[key] = text(patch[key], `$.patch.${key}`, 100);
  return result;
}

function currentOverride(library, conversationKey) {
  return clone(library.conversation_overrides?.[conversationKey] || {});
}

function assertSnapshotConsistency(libraryOverride, conversation) {
  const libraryTime = libraryOverride.content_time;
  const conversationTime = conversation.content_time?.effective;
  const libraryUser = Boolean(libraryTime);
  const conversationUser = conversationTime?.source === "user";
  if (libraryUser !== conversationUser || (libraryUser && libraryTime.edit_id !== conversationTime.edit_id)) {
    fail("CLOUDIG_TIME_SNAPSHOT_CONFLICT", "$.content_time", "Library and conversation user snapshots do not share the same edit_id", {
      library_edit_id: libraryTime?.edit_id || "",
      conversation_edit_id: conversationTime?.edit_id || ""
    });
  }
}

function bindingIdsInRange(range) {
  return [...new Set([range?.start, range?.end].filter((endpoint) => endpoint?.kind === "sovereign").map((endpoint) => endpoint.binding_id))];
}

function materializeSovereignSelections(system, conversationKey, range, editedAt, idFactory) {
  let changed = false;
  const endpoint = (value) => {
    if (value.kind !== "sovereign_selection") return value;
    if (!isRecord(value.node_ref)) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.content_time.range", "Sovereign selection requires node_ref");
    const nodeRef = normalizeNodeRef(value.node_ref, system.sovereign.nodes, "$.content_time.range.node_ref");
    const key = normalizedNodeRefKey(nodeRef, system.sovereign.nodes);
    const existing = Object.entries(system.sovereign.conversation_bindings).find(([, binding]) =>
      binding.conversation_key === conversationKey && normalizedNodeRefKey(binding.node_ref, system.sovereign.nodes) === key);
    if (existing) return { kind: "sovereign", binding_id: existing[0] };
    const bindingId = uuid(String(idFactory()).toLowerCase(), "$.content_time.binding_id");
    if (system.sovereign.conversation_bindings[bindingId]) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.content_time.binding_id", "Generated binding ID already exists");
    system.sovereign.conversation_bindings[bindingId] = {
      conversation_key: conversationKey,
      node_ref: nodeRef,
      created_at: editedAt,
      edited_at: editedAt
    };
    changed = true;
    return { kind: "sovereign", binding_id: bindingId };
  };
  const start = endpoint(range.start);
  const end = range.end ? endpoint(range.end) : undefined;
  return { range: time.normalizeRange({ start, ...(end ? { end } : {}) }), changed };
}

function materializeConversationRange(library, range, capturedAt) {
  const endpoints = [range.start, range.end].filter(Boolean).map((endpoint) => {
    if (endpoint.kind !== "sovereign") return clone(endpoint);
    return { kind: "sovereign", binding_id: endpoint.binding_id, snapshot: buildSovereignSnapshot(library.content_time_system, endpoint.binding_id, capturedAt) };
  });
  return time.normalizeRange({ start: endpoints[0], ...(endpoints[1] ? { end: endpoints[1] } : {}) });
}

export function effectiveContentTimeFromLibrary(libraryValue, conversationKeyValue, capturedAt) {
  const library = assertLibraryDomainV1(libraryValue);
  const conversationKey = sha(String(conversationKeyValue || "").toLowerCase(), "$.conversation_key");
  const override = library.conversation_overrides?.[conversationKey]?.content_time;
  if (!override) return { source: "parser" };
  if (override.state === "cleared") {
    return {
      source: "user",
      state: "cleared",
      edit_id: override.edit_id,
      edited_at: override.edited_at
    };
  }
  return {
    source: "user",
    state: "set",
    edit_id: override.edit_id,
    edited_at: override.edited_at,
    range: materializeConversationRange(library, override.range, capturedAt)
  };
}

export function materializeConversationEffectiveSnapshot(libraryValue, conversationValue, capturedAt) {
  const library = assertLibraryDomainV1(libraryValue);
  const conversation = normalizedConversation(conversationValue);
  const key = conversation.identity.conversation_key;
  const override = library.conversation_overrides?.[key]?.content_time;
  assertSnapshotConsistency(library.conversation_overrides?.[key] || {}, conversation);
  if (!override || override.state !== "set") return conversation;
  const next = clone(conversation);
  next.content_time.effective = {
    source: "user",
    state: "set",
    edit_id: override.edit_id,
    edited_at: override.edited_at,
    range: materializeConversationRange(library, override.range, capturedAt)
  };
  next.lifecycle.cloudig_edited_at = utc(capturedAt);
  return normalizedConversation(next);
}

function normalizedConversation(value) {
  const validation = validateConversationV1(value);
  if (!validation.valid) {
    const issue = validation.errors[0];
    fail(issue.code || "CLOUDIG_CONVERSATION_CHANGED", issue.path, issue.message, issue.details);
  }
  return clone(value);
}

function sameJson(left, right) {
  return semanticKey(left) === semanticKey(right);
}

export function planConversationMetadataCommit({
  library: libraryValue,
  conversation: conversationValue,
  patch = {},
  content_time = { action: "preserve" },
  anchor_action = "preserve",
  now,
  anchor,
  touch = false,
  request_id,
  id_factory = randomUUID
}) {
  const library = assertLibraryDomainV1(libraryValue);
  const conversation = normalizedConversation(conversationValue);
  const conversationKey = conversation.identity.conversation_key;
  const archiveId = conversation.identity.archive_id;
  uuid(request_id, "$.request_id");
  if (!new Set(["preserve", "refresh"]).has(anchor_action)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.anchor_action", "anchor_action must be preserve or refresh");
  const committedAt = utc(now);
  const commitAnchor = canonicalAnchor(anchor);
  const normalizedPatch = applyConversationPatch(conversation, patch);
  const existingOverride = currentOverride(library, conversationKey);
  assertSnapshotConsistency(existingOverride, conversation);
  if (!isRecord(content_time) || !new Set(["preserve", "set", "clear"]).has(content_time.action)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.content_time.action", "Content-time action must be preserve, set or clear");

  const nextOverride = { ...existingOverride, ...normalizedPatch };
  let nextRange = null;
  let nextState = existingOverride.content_time?.state || "parser";
  let newTimeFact = false;
  const nextSystem = clone(library.content_time_system);
  let systemChanged = false;
  if (content_time.action === "set") {
    const rawDraft = materializeTerranDraftRange(content_time.range, commitAnchor, { refresh: true });
    const selection = materializeSovereignSelections(nextSystem, conversationKey, rawDraft, committedAt, id_factory);
    const draft = selection.range;
    systemChanged = selection.changed;
    for (const bindingId of bindingIdsInRange(draft)) {
      const binding = nextSystem.sovereign.conversation_bindings[bindingId];
      if (!binding || binding.conversation_key !== conversationKey) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.content_time.range", "Sovereign binding does not belong to this conversation");
    }
    const currentRange = existingOverride.content_time?.state === "set" ? existingOverride.content_time.range : null;
    const semanticallySame = currentRange && time.semanticRangeEqual(currentRange, draft);
    if (!(semanticallySame && anchor_action === "preserve")) {
      nextRange = anchor_action === "preserve" && semanticallySame ? currentRange : draft;
      nextState = "set";
      newTimeFact = true;
    }
  } else if (content_time.action === "clear") {
    if (existingOverride.content_time?.state !== "cleared") {
      nextState = "cleared";
      newTimeFact = true;
    }
  } else if (anchor_action === "refresh" && existingOverride.content_time?.state === "set") {
    nextRange = materializeTerranDraftRange(existingOverride.content_time.range, commitAnchor, { refresh: true });
    nextState = "set";
    newTimeFact = true;
  }

  if (newTimeFact) {
    const edit_id = uuid(String(id_factory()).toLowerCase(), "$.edit_id");
    nextOverride.content_time = nextState === "cleared"
      ? { edit_id, edited_at: committedAt, state: "cleared" }
      : { edit_id, edited_at: committedAt, state: "set", range: nextRange };
  }

  const nextLibrary = clone(library);
  if (newTimeFact) {
    const retained = nextState === "set" ? new Set(bindingIdsInRange(nextRange)) : new Set();
    for (const bindingId of bindingIdsInRange(existingOverride.content_time?.range)) {
      if (!retained.has(bindingId) && nextSystem.sovereign.conversation_bindings[bindingId]?.conversation_key === conversationKey) {
        delete nextSystem.sovereign.conversation_bindings[bindingId];
        systemChanged = true;
      }
    }
  }
  if (systemChanged) nextSystem.revision += 1;
  nextLibrary.content_time_system = nextSystem;
  const overrides = { ...(nextLibrary.conversation_overrides || {}) };
  if (Object.keys(nextOverride).length) overrides[conversationKey] = nextOverride;
  else delete overrides[conversationKey];
  if (Object.keys(overrides).length) nextLibrary.conversation_overrides = overrides;
  else delete nextLibrary.conversation_overrides;

  const nextConversation = clone(conversation);
  if (nextOverride.conversation_name) nextConversation.title = nextOverride.conversation_name;
  if (nextOverride.provider) nextConversation.provider = nextOverride.provider;
  if (nextOverride.platform) nextConversation.platform = nextOverride.platform;
  if (nextOverride.models) nextConversation.models = clone(nextOverride.models);
  if (newTimeFact && nextOverride.content_time) {
    nextConversation.content_time.effective = nextOverride.content_time.state === "cleared"
      ? { source: "user", state: "cleared", edit_id: nextOverride.content_time.edit_id, edited_at: nextOverride.content_time.edited_at }
      : {
          source: "user",
          state: "set",
          edit_id: nextOverride.content_time.edit_id,
          edited_at: nextOverride.content_time.edited_at,
          range: materializeConversationRange(nextLibrary, nextOverride.content_time.range, committedAt)
        };
  }

  const changed = touch === true || !sameJson(library, nextLibrary) || !sameJson(conversation, nextConversation);
  if (!changed) {
    const libraryText = serializeV1(library);
    const conversationText = serializeV1(conversation);
    return {
      status: "unchanged",
      request_id,
      conversation_key: conversationKey,
      archive_id: archiveId,
      library,
      conversation,
      library_sha256: digest(libraryText),
      conversation_sha256: digest(conversationText),
      warnings: []
    };
  }
  nextLibrary.edited_at = committedAt;
  nextConversation.lifecycle.cloudig_edited_at = committedAt;
  const normalizedLibrary = assertLibraryDomainV1(nextLibrary);
  const normalizedNextConversation = normalizedConversation(nextConversation);
  const libraryText = serializeV1(normalizedLibrary);
  const conversationText = serializeV1(normalizedNextConversation);
  return {
    status: "planned",
    request_id,
    conversation_key: conversationKey,
    archive_id: archiveId,
    library: normalizedLibrary,
    conversation: normalizedNextConversation,
    library_text: libraryText,
    conversation_text: conversationText,
    library_sha256: digest(libraryText),
    conversation_sha256: digest(conversationText),
    warnings: normalizedNextConversation.content_time.effective.range?.is_reversed ? ["CLOUDIG_TIME_REVERSED"] : []
  };
}

function applySparseObjectPatch(current, patch, path) {
  if (patch === null) return undefined;
  if (!isRecord(patch)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be an object or null`);
  const result = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isRecord(value) && isRecord(result[key])) result[key] = applySparseObjectPatch(result[key], value, `${path}.${key}`);
    else result[key] = clone(value);
  }
  return Object.keys(result).length ? result : undefined;
}

export function commitLibraryPreferences(libraryValue, patch, { now } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  if (!isRecord(patch)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.patch", "Library preference patch must be an object");
  const allowed = new Set(["user", "assistant", "project", "preferences", "workflow_preferences", "platform_overrides"]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", `$.patch.${key}`, "Unsupported Library preference section");
  const next = clone(library);
  for (const [key, value] of Object.entries(patch)) {
    const merged = applySparseObjectPatch(next[key], value, `$.patch.${key}`);
    if (merged === undefined) delete next[key];
    else next[key] = merged;
  }
  if (sameJson(next, library)) return { status: "unchanged", library };
  next.edited_at = utc(now);
  return { status: "planned", library: assertLibraryDomainV1(next) };
}

function touchTimeline(system, nodeIds, editedAt) {
  const touched = new Set();
  for (const nodeId of nodeIds) touched.add(timelineForNode(system.sovereign.nodes, nodeId).timelineId);
  for (const timelineId of touched) {
    const timeline = system.sovereign.nodes[timelineId];
    timeline.document_revision += 1;
    timeline.edited_at = editedAt;
  }
  system.revision += 1;
  return system;
}

function assertExpectedTimelineRevisions(system, nodeIds, command) {
  const timelineIds = [...new Set(nodeIds.map((nodeId) => timelineForNode(system.sovereign.nodes, nodeId).timelineId))];
  const supplied = isRecord(command?.expected_document_revisions) ? command.expected_document_revisions : {};
  for (const timelineId of timelineIds) {
    const actual = system.sovereign.nodes[timelineId].document_revision;
    const expected = Object.hasOwn(supplied, timelineId)
      ? Number(supplied[timelineId])
      : timelineIds.length === 1 ? Number(command?.expected_document_revision) : Number.NaN;
    if (!Number.isSafeInteger(expected) || expected !== actual) {
      fail("CLOUDIG_TIME_PLAN_STALE", `$.expected_document_revisions.${timelineId}`, "Timeline document revision changed or was not supplied", { expected, actual });
    }
  }
}

function referencedTimelineBindings(system, nodeIds) {
  const timelineIds = new Set(nodeIds.map((nodeId) => timelineForNode(system.sovereign.nodes, nodeId).timelineId));
  return Object.entries(system.sovereign.conversation_bindings)
    .filter(([, binding]) => timelineIds.has(timelineForNode(system.sovereign.nodes, binding.node_ref.node_id).timelineId))
    .map(([binding_id, binding]) => ({ binding_id, conversation_key: binding.conversation_key, node_id: binding.node_ref.node_id }))
    .sort((left, right) => left.binding_id.localeCompare(right.binding_id, "en"));
}

function assertNoReferencedTimelines(system, nodeIds, allowReferenced) {
  if (allowReferenced) return;
  const references = referencedTimelineBindings(system, nodeIds);
  if (references.length) fail("CLOUDIG_TIME_TIMELINE_REFERENCED", "$.sync_mode", "Referenced timeline changes require time.timeline.plan/commit", { references });
}

function updatedLibraryWithSystem(libraryValue, nextSystem, editedAt) {
  const library = assertLibraryDomainV1(libraryValue);
  library.content_time_system = normalizeTimeSystemSemantics(nextSystem);
  library.edited_at = editedAt;
  return assertLibraryDomainV1(library);
}

export function commitTimeNode(libraryValue, command, { now, id_factory = randomUUID, allow_referenced = false } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const system = clone(library.content_time_system);
  const editedAt = utc(now);
  const action = String(command?.action || "");
  if (!new Set(["create", "update"]).has(action)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.action", "Node action must be create or update");
  const nodeId = action === "create" ? uuid(String(id_factory()).toLowerCase(), "$.node_id") : uuid(command.node_id, "$.node_id");
  if (action === "create" && system.sovereign.nodes[nodeId]) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.node_id", "Generated node ID already exists");
  if (action === "update" && !system.sovereign.nodes[nodeId]) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.node_id", "Node does not exist");
  const input = isRecord(command.node) ? clone(command.node) : fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.node", "Node payload must be an object");
  if (action === "create" && input.kind === "timeline") {
    const lineageId = uuid(String(command.lineage_id || id_factory()).toLowerCase(), "$.lineage_id");
    if (system.sovereign.lineages[lineageId]) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.lineage_id", "Lineage already exists");
    system.sovereign.lineages[lineageId] = { next_variant_no: 2 };
    system.sovereign.nodes[nodeId] = {
      kind: "timeline", lineage_id: lineageId, variant_no: 1, document_revision: 1,
      name: input.name, author: input.author, standard_name: input.standard_name,
      display_version: input.display_version, created_at: editedAt, edited_at: editedAt
    };
    system.revision += 1;
  } else if (action === "create" && input.kind === "time") {
    assertExpectedTimelineRevisions(system, [input.owner_timeline_id], command);
    assertNoReferencedTimelines(system, [input.owner_timeline_id], allow_referenced);
    system.sovereign.nodes[nodeId] = {
      kind: "time", owner_timeline_id: input.owner_timeline_id, time_kind: input.time_kind,
      name: input.name,
      ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
      ...(input.unit_name !== undefined ? { unit_name: input.unit_name } : {}),
      ...(input.period_count !== undefined ? { period_count: input.period_count } : {}),
      ...(input.empty_occurrence_display !== undefined ? { empty_occurrence_display: input.empty_occurrence_display } : {}),
      created_at: editedAt, edited_at: editedAt
    };
    touchTimeline(system, [input.owner_timeline_id], editedAt);
  } else if (action === "update") {
    const current = system.sovereign.nodes[nodeId];
    const { timeline } = timelineForNode(system.sovereign.nodes, nodeId);
    if (Number(command.expected_document_revision) !== timeline.document_revision) fail("CLOUDIG_TIME_PLAN_STALE", "$.expected_document_revision", "Timeline document revision changed");
    assertNoReferencedTimelines(system, [nodeId], allow_referenced);
    const immutable = current.kind === "timeline"
      ? ["kind", "lineage_id", "variant_no", "document_revision", "created_at"]
      : ["kind", "owner_timeline_id", "created_at"];
    if (immutable.some((key) => Object.hasOwn(input, key) && !sameJson(input[key], current[key]))) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.node", "Node update attempted to change immutable identity");
    system.sovereign.nodes[nodeId] = { ...current, ...input, ...Object.fromEntries(immutable.map((key) => [key, current[key]])), edited_at: editedAt };
    touchTimeline(system, [nodeId], editedAt);
  } else fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.node.kind", "Node kind must be timeline or time");
  return { node_id: nodeId, library: updatedLibraryWithSystem(library, system, editedAt) };
}

export function commitContainment(libraryValue, command, { now, id_factory = randomUUID, allow_referenced = false } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const system = clone(library.content_time_system);
  const links = system.sovereign.containment_links;
  const editedAt = utc(now);
  const action = String(command?.action || "");
  if (!new Set(["add", "update", "remove"]).has(action)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.action", "Containment action is invalid");
  const linkId = action === "add" ? uuid(String(id_factory()).toLowerCase(), "$.link_id") : uuid(command.link_id, "$.link_id");
  const current = links[linkId];
  if (action !== "add" && !current) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.link_id", "Containment link does not exist");
  const oldParent = current?.parent_node_id || "";
  const parent = action === "remove" ? current.parent_node_id : uuid(command.parent_node_id, "$.parent_node_id");
  const preMutationNodes = [parent, ...(oldParent && oldParent !== parent ? [oldParent] : []), ...(current ? [current.child.node_id] : []), ...(command.child?.node_id ? [command.child.node_id] : [])];
  assertExpectedTimelineRevisions(system, preMutationNodes, command);
  assertNoReferencedTimelines(system, preMutationNodes, allow_referenced);
  const siblingIds = Object.entries(links).filter(([id, link]) => id !== linkId && link.parent_node_id === parent)
    .sort((left, right) => left[1].ordinal - right[1].ordinal || left[0].localeCompare(right[0], "en"));
  if (action === "remove") delete links[linkId];
  else {
    const ordinal = Math.min(Math.max(Number(command.ordinal) || siblingIds.length + 1, 1), siblingIds.length + 1);
    const child = normalizeNodeRef(command.child, system.sovereign.nodes, "$.child");
    links[linkId] = { parent_node_id: parent, child, ordinal, created_at: current?.created_at || editedAt, edited_at: editedAt };
    siblingIds.splice(ordinal - 1, 0, [linkId, links[linkId]]);
  }
  for (const parentId of new Set([parent, oldParent].filter(Boolean))) {
    const ordered = Object.entries(links).filter(([, link]) => link.parent_node_id === parentId)
      .sort((left, right) => left[1].ordinal - right[1].ordinal || left[0].localeCompare(right[0], "en"));
    ordered.forEach(([id], index) => { links[id].ordinal = index + 1; if (id !== linkId) links[id].edited_at = editedAt; });
  }
  const touched = [parent, ...(current ? [current.child.node_id] : []), ...(links[linkId] ? [links[linkId].child.node_id] : [])];
  touchTimeline(system, touched, editedAt);
  return { link_id: linkId, library: updatedLibraryWithSystem(library, system, editedAt) };
}

export function commitCounterpart(libraryValue, command, { now, id_factory = randomUUID, allow_referenced = false } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const system = clone(library.content_time_system);
  const editedAt = utc(now);
  const action = String(command?.action || "");
  if (!new Set(["add", "update", "remove"]).has(action)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.action", "Counterpart action is invalid");
  const linkId = action === "add" ? uuid(String(id_factory()).toLowerCase(), "$.link_id") : uuid(command.link_id, "$.link_id");
  const current = system.sovereign.counterpart_links[linkId];
  if (action !== "add" && !current) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.link_id", "Counterpart link does not exist");
  const preMutationRefs = current ? [current.left.node_id, current.right.node_id] : [command.left?.node_id, command.right?.node_id].filter(Boolean);
  assertExpectedTimelineRevisions(system, preMutationRefs, command);
  assertNoReferencedTimelines(system, preMutationRefs, allow_referenced);
  if (action === "remove") delete system.sovereign.counterpart_links[linkId];
  else system.sovereign.counterpart_links[linkId] = {
    left: normalizeNodeRef(command.left, system.sovereign.nodes, "$.left"),
    right: normalizeNodeRef(command.right, system.sovereign.nodes, "$.right"),
    created_at: current?.created_at || editedAt,
    edited_at: editedAt
  };
  const refs = current ? [current.left.node_id, current.right.node_id] : [];
  if (system.sovereign.counterpart_links[linkId]) refs.push(system.sovereign.counterpart_links[linkId].left.node_id, system.sovereign.counterpart_links[linkId].right.node_id);
  touchTimeline(system, refs, editedAt);
  return { link_id: linkId, library: updatedLibraryWithSystem(library, system, editedAt) };
}

function refreshRangeAnchors(range, anchor) {
  return materializeTerranDraftRange(range, anchor, { refresh: true });
}

export function commitTerranMapping(libraryValue, command, { now, anchor, id_factory = randomUUID, allow_referenced = false } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const system = clone(library.content_time_system);
  const editedAt = utc(now);
  const action = String(command?.action || "");
  if (!new Set(["add", "update", "remove"]).has(action)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.action", "Terran mapping action is invalid");
  const mappingId = action === "add" ? uuid(String(id_factory()).toLowerCase(), "$.mapping_id") : uuid(command.mapping_id, "$.mapping_id");
  const current = system.sovereign.terran_mappings[mappingId];
  if (action !== "add" && !current) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.mapping_id", "Terran mapping does not exist");
  assertExpectedTimelineRevisions(system, [current?.node_ref?.node_id || command.node_ref?.node_id].filter(Boolean), command);
  assertNoReferencedTimelines(system, [current?.node_ref?.node_id || command.node_ref?.node_id].filter(Boolean), allow_referenced);
  if (action === "remove") delete system.sovereign.terran_mappings[mappingId];
  else system.sovereign.terran_mappings[mappingId] = {
    node_ref: normalizeNodeRef(command.node_ref, system.sovereign.nodes, "$.node_ref"),
    range: refreshRangeAnchors(command.range, canonicalAnchor(anchor)),
    edited_at: editedAt
  };
  const refs = current ? [current.node_ref.node_id] : [];
  if (system.sovereign.terran_mappings[mappingId]) refs.push(system.sovereign.terran_mappings[mappingId].node_ref.node_id);
  touchTimeline(system, refs, editedAt);
  return { mapping_id: mappingId, library: updatedLibraryWithSystem(library, system, editedAt) };
}

export function commitTerranPreset(libraryValue, command, { now, anchor } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const editedAt = utc(now);
  const action = String(command?.action || "");
  const expectedRevision = Number(command?.expected_time_system_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== library.content_time_system.revision) {
    fail("CLOUDIG_TIME_PLAN_STALE", "$.expected_time_system_revision", "Content-time system revision changed");
  }
  let system;
  if (action === "set") system = timeSystem.setPresetRange(library.content_time_system, command.node_id, refreshRangeAnchors(command.range, anchor));
  else if (action === "restore") system = timeSystem.restorePresetRange(library.content_time_system, command.node_id, canonicalAnchor(anchor));
  else fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.action", "Terran preset action must be set or restore");
  return { node_id: command.node_id, library: updatedLibraryWithSystem(library, system, editedAt) };
}

export function commitSovereignDisplayOrder(libraryValue, command, { now } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const expectedRevision = Number(command?.expected_time_system_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== library.content_time_system.revision) {
    fail("CLOUDIG_TIME_PLAN_STALE", "$.expected_time_system_revision", "Content-time system revision changed");
  }
  const action = String(command?.action || "");
  const system = clone(library.content_time_system);
  if (action === "restore") system.sovereign.display_order = { mode: "last_edited_desc" };
  else if (action === "set") {
    if (!Array.isArray(command.timeline_ids)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.timeline_ids", "Manual timeline order must be an array");
    const allTimelineIds = Object.entries(system.sovereign.nodes)
      .filter(([, node]) => node.kind === "timeline")
      .map(([nodeId]) => nodeId)
      .sort((left, right) => left.localeCompare(right, "en"));
    const timelineIds = command.timeline_ids.map((id, index) => {
      const nodeId = uuid(id, `$.timeline_ids[${index}]`);
      if (system.sovereign.nodes[nodeId]?.kind !== "timeline") fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `$.timeline_ids[${index}]`, "Manual order can contain only timeline nodes");
      return nodeId;
    });
    if (new Set(timelineIds).size !== timelineIds.length
      || timelineIds.length !== allTimelineIds.length
      || timelineIds.some((id) => !allTimelineIds.includes(id))) {
      fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.timeline_ids", "Manual order must contain every timeline exactly once");
    }
    system.sovereign.display_order = { mode: "manual", timeline_ids: timelineIds };
  } else fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.action", "Display-order action must be set or restore");
  system.revision += 1;
  return { display_order: clone(system.sovereign.display_order), library: updatedLibraryWithSystem(library, system, utc(now)) };
}

function referencesForNode(system, nodeId) {
  const references = [];
  for (const [link_id, link] of Object.entries(system.sovereign.containment_links)) {
    if (link.parent_node_id === nodeId || link.child.node_id === nodeId) references.push({ kind: "containment", id: link_id });
  }
  for (const [link_id, link] of Object.entries(system.sovereign.counterpart_links)) {
    if (link.left.node_id === nodeId || link.right.node_id === nodeId) references.push({ kind: "counterpart", id: link_id });
  }
  for (const [mapping_id, mapping] of Object.entries(system.sovereign.terran_mappings)) if (mapping.node_ref.node_id === nodeId) references.push({ kind: "terran_mapping", id: mapping_id });
  for (const [binding_id, binding] of Object.entries(system.sovereign.conversation_bindings)) if (binding.node_ref.node_id === nodeId) references.push({ kind: "conversation_binding", id: binding_id, conversation_key: binding.conversation_key });
  for (const [owned_node_id, node] of Object.entries(system.sovereign.nodes)) if (node.kind === "time" && node.owner_timeline_id === nodeId) references.push({ kind: "owned_node", id: owned_node_id });
  return references.sort((left, right) => left.kind.localeCompare(right.kind, "en") || left.id.localeCompare(right.id, "en"));
}

export function planNodeDeletion(libraryValue, { node_id, expected_document_revision }) {
  const library = assertLibraryDomainV1(libraryValue);
  const system = library.content_time_system;
  const nodeId = uuid(node_id, "$.node_id");
  const node = system.sovereign.nodes[nodeId];
  if (!node) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.node_id", "Node does not exist");
  const { timeline } = timelineForNode(system.sovereign.nodes, nodeId);
  if (Number(expected_document_revision) !== timeline.document_revision) fail("CLOUDIG_TIME_PLAN_STALE", "$.expected_document_revision", "Timeline document revision changed");
  const references = referencesForNode(system, nodeId);
  const body = {
    operation: "node_delete",
    node_id: nodeId,
    expected_document_revision: timeline.document_revision,
    source_time_system_revision: system.revision,
    references
  };
  return { plan_id: digest(body), ...body };
}

export function commitNodeDeletion(libraryValue, { plan_id, node_id, expected_document_revision }, { now } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const currentPlan = planNodeDeletion(library, { node_id, expected_document_revision });
  assertFreshPlan(plan_id, currentPlan);
  if (currentPlan.references.length) {
    fail("CLOUDIG_TIME_TIMELINE_REFERENCED", "$.node_id", "Node still has explicit relationships or conversation references", { references: currentPlan.references });
  }
  const editedAt = utc(now);
  const system = clone(library.content_time_system);
  const node = system.sovereign.nodes[currentPlan.node_id];
  delete system.sovereign.nodes[currentPlan.node_id];
  if (system.sovereign.display_order.mode === "manual") {
    system.sovereign.display_order.timeline_ids = system.sovereign.display_order.timeline_ids.filter((id) => id !== currentPlan.node_id);
  }
  if (node.kind === "time") touchTimeline(system, [node.owner_timeline_id], editedAt);
  else system.revision += 1;
  return { node_id: currentPlan.node_id, library: updatedLibraryWithSystem(library, system, editedAt) };
}

export function planReferenceRemoval(libraryValue, { binding_ids }) {
  const library = assertLibraryDomainV1(libraryValue);
  if (!Array.isArray(binding_ids) || !binding_ids.length) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.binding_ids", "Reference-removal plan requires at least one binding ID");
  const bindings = [...new Set(binding_ids.map((id, index) => uuid(id, `$.binding_ids[${index}]`)))].sort();
  const affected = bindings.map((binding_id) => {
    const binding = library.content_time_system.sovereign.conversation_bindings[binding_id];
    if (!binding) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", `$.binding_ids.${binding_id}`, "Conversation binding no longer exists");
    return { binding_id, conversation_key: binding.conversation_key, node_id: binding.node_ref.node_id };
  });
  const body = {
    operation: "reference_remove",
    source_time_system_revision: library.content_time_system.revision,
    bindings: affected
  };
  return { plan_id: digest(body), ...body };
}

function deterministicUuid(seed, index) {
  const bytes = Buffer.from(createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function cloneTimelineVariant(libraryValue, timelineId, { now, seed }) {
  const library = assertLibraryDomainV1(libraryValue);
  const editedAt = utc(now);
  const system = clone(library.content_time_system);
  const sourceTimeline = system.sovereign.nodes[timelineId];
  if (!sourceTimeline || sourceTimeline.kind !== "timeline") fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.timeline_id", "Timeline variant does not exist");
  const lineage = system.sovereign.lineages[sourceTimeline.lineage_id];
  const variantNo = lineage.next_variant_no;
  if (variantNo > time.LIMITS.sovereign.timeline_variants_max) fail("CLOUDIG_TIME_GRAPH_LIMIT", "$.timeline_id", "Timeline lineage reached the V1 variant limit");
  let allocation = 0;
  const nextId = () => deterministicUuid(seed, allocation++);
  const internalIds = Object.keys(system.sovereign.nodes)
    .filter((nodeId) => nodeId === timelineId || system.sovereign.nodes[nodeId].owner_timeline_id === timelineId)
    .sort((left, right) => left.localeCompare(right, "en"));
  const nodeIds = Object.fromEntries(internalIds.map((nodeId) => [nodeId, nextId()]));
  const newTimelineId = nodeIds[timelineId];
  for (const nodeId of internalIds) {
    const source = system.sovereign.nodes[nodeId];
    const targetId = nodeIds[nodeId];
    if (source.kind === "timeline") {
      system.sovereign.nodes[targetId] = {
        ...clone(source),
        variant_no: variantNo,
        document_revision: 1,
        created_at: editedAt,
        edited_at: editedAt
      };
    } else {
      system.sovereign.nodes[targetId] = {
        ...clone(source),
        owner_timeline_id: newTimelineId,
        created_at: editedAt,
        edited_at: editedAt
      };
    }
  }
  const remapRef = (reference) => ({
    ...clone(reference),
    node_id: nodeIds[reference.node_id] || reference.node_id
  });
  const relationIds = { containment: {}, counterpart: {}, mapping: {} };
  for (const [linkId, link] of Object.entries(system.sovereign.containment_links)) {
    if (!nodeIds[link.parent_node_id] && !nodeIds[link.child.node_id]) continue;
    const targetId = nextId();
    relationIds.containment[linkId] = targetId;
    system.sovereign.containment_links[targetId] = {
      parent_node_id: nodeIds[link.parent_node_id] || link.parent_node_id,
      child: remapRef(link.child),
      ordinal: link.ordinal,
      created_at: editedAt,
      edited_at: editedAt
    };
  }
  for (const [linkId, link] of Object.entries(system.sovereign.counterpart_links)) {
    if (!nodeIds[link.left.node_id] && !nodeIds[link.right.node_id]) continue;
    const targetId = nextId();
    relationIds.counterpart[linkId] = targetId;
    system.sovereign.counterpart_links[targetId] = {
      left: remapRef(link.left),
      right: remapRef(link.right),
      created_at: editedAt,
      edited_at: editedAt
    };
  }
  for (const [mappingId, mapping] of Object.entries(system.sovereign.terran_mappings)) {
    if (!nodeIds[mapping.node_ref.node_id]) continue;
    const targetId = nextId();
    relationIds.mapping[mappingId] = targetId;
    system.sovereign.terran_mappings[targetId] = {
      node_ref: remapRef(mapping.node_ref),
      range: clone(mapping.range),
      edited_at: editedAt
    };
  }
  lineage.next_variant_no += 1;
  if (system.sovereign.display_order.mode === "manual") {
    const index = system.sovereign.display_order.timeline_ids.indexOf(timelineId);
    system.sovereign.display_order.timeline_ids.splice(index < 0 ? system.sovereign.display_order.timeline_ids.length : index + 1, 0, newTimelineId);
  }
  system.revision += 1;
  const nextLibrary = clone(library);
  nextLibrary.content_time_system = system;
  nextLibrary.edited_at = editedAt;
  return {
    library: assertLibraryDomainV1(nextLibrary),
    source_timeline_id: timelineId,
    timeline_id: newTimelineId,
    lineage_id: sourceTimeline.lineage_id,
    variant_no: variantNo,
    node_ids: nodeIds,
    relation_ids: relationIds
  };
}

function rewriteMutationForVariant(mutation, cloneResult) {
  const rewritten = clone(mutation);
  const maps = [cloneResult.node_ids, cloneResult.relation_ids.containment, cloneResult.relation_ids.counterpart, cloneResult.relation_ids.mapping];
  const replace = (value) => {
    if (Array.isArray(value)) return value.map(replace);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    if (typeof value !== "string") return value;
    for (const map of maps) if (map[value]) return map[value];
    return value;
  };
  return replace(rewritten);
}

function mutationNodeIds(mutation) {
  const result = [];
  const visit = (value, key = "") => {
    if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (isRecord(value)) for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    else if (typeof value === "string" && (key === "node_id" || key.endsWith("_node_id") || key === "owner_timeline_id")) result.push(value);
  };
  visit(mutation);
  return [...new Set(result)];
}

function applyTimelineMutation(library, mutation, context) {
  if (!isRecord(mutation) || !new Set(["node", "containment", "counterpart", "terran_mapping"]).has(mutation.type)) {
    fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.mutation.type", "Timeline mutation type is invalid");
  }
  const command = clone(mutation.command || {});
  const nodes = library.content_time_system.sovereign.nodes;
  const touched = mutationNodeIds(command).filter((nodeId) => nodes[nodeId]);
  const revisions = {};
  for (const nodeId of touched) {
    const { timelineId, timeline } = timelineForNode(nodes, nodeId);
    revisions[timelineId] = timeline.document_revision;
  }
  command.expected_document_revisions = revisions;
  if (Object.keys(revisions).length === 1) command.expected_document_revision = Object.values(revisions)[0];
  const options = { ...context, allow_referenced: true };
  if (mutation.type === "node") return commitTimeNode(library, command, options);
  if (mutation.type === "containment") return commitContainment(library, command, options);
  if (mutation.type === "counterpart") return commitCounterpart(library, command, options);
  return commitTerranMapping(library, command, options);
}

function snapshotDigestMap(system) {
  const result = new Map();
  const capturedAt = "2000-01-01T00:00:00.000Z";
  for (const bindingId of Object.keys(system.sovereign.conversation_bindings).sort()) {
    result.set(bindingId, buildSovereignSnapshot(system, bindingId, capturedAt).sha256);
  }
  return result;
}

export function planTimelineMutation(libraryValue, command, { now, anchor, request_id } = {}) {
  const library = assertLibraryDomainV1(libraryValue);
  const timelineId = uuid(command?.timeline_id, "$.timeline_id");
  const timeline = library.content_time_system.sovereign.nodes[timelineId];
  if (!timeline || timeline.kind !== "timeline") fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.timeline_id", "Timeline variant does not exist");
  if (Number(command.expected_document_revision) !== timeline.document_revision) fail("CLOUDIG_TIME_PLAN_STALE", "$.expected_document_revision", "Timeline document revision changed");
  const syncMode = String(command.sync_mode || "");
  if (!new Set(["all_references", "selected_references", "future_only"]).has(syncMode)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.sync_mode", "Timeline sync mode is invalid");
  const sourceReferences = referencedTimelineBindings(library.content_time_system, [timelineId]);
  const sourceConversationKeys = [...new Set(sourceReferences.map((entry) => entry.conversation_key))].sort();
  const selected = [...new Set((command.selected_conversation_keys || []).map((key, index) => sha(key, `$.selected_conversation_keys[${index}]`)))].sort();
  if (selected.some((key) => !sourceConversationKeys.includes(key))) fail("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.selected_conversation_keys", "Selected conversation does not reference this timeline variant");
  if (syncMode === "selected_references" && (!selected.length || selected.length === sourceConversationKeys.length)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.selected_conversation_keys", "Partial sync requires a non-empty strict subset; use all_references for the complete set");
  if (syncMode !== "selected_references" && selected.length) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.selected_conversation_keys", "Selected conversations are allowed only for selected_references");
  const oldDigests = snapshotDigestMap(library.content_time_system);
  const seed = `${request_id || "timeline-plan"}:${digest(serializeV1(library))}:${semanticKey(command.mutation)}`;
  let mutationAllocation = 100000;
  const mutationIdFactory = () => deterministicUuid(seed, mutationAllocation++);
  let nextLibrary;
  let variantAction;
  let targetTimelineId = timelineId;
  let cloneResult = null;
  if (!sourceReferences.length || syncMode === "all_references") {
    const mutation = applyTimelineMutation(library, command.mutation, { now, anchor, id_factory: mutationIdFactory });
    nextLibrary = mutation.library;
    variantAction = "in_place";
  } else {
    cloneResult = cloneTimelineVariant(library, timelineId, { now, seed });
    targetTimelineId = cloneResult.timeline_id;
    const rewritten = rewriteMutationForVariant(command.mutation, cloneResult);
    const mutation = applyTimelineMutation(cloneResult.library, rewritten, { now, anchor, id_factory: mutationIdFactory });
    nextLibrary = mutation.library;
    variantAction = "fork";
    const migrate = syncMode === "selected_references" ? new Set(selected) : new Set();
    for (const binding of Object.values(nextLibrary.content_time_system.sovereign.conversation_bindings)) {
      if (migrate.has(binding.conversation_key) && cloneResult.node_ids[binding.node_ref.node_id]) {
        binding.node_ref.node_id = cloneResult.node_ids[binding.node_ref.node_id];
        binding.edited_at = utc(now);
      }
    }
  }
  nextLibrary = clone(nextLibrary);
  nextLibrary.content_time_system.revision = library.content_time_system.revision + 1;
  if (variantAction === "fork") nextLibrary.content_time_system.sovereign.nodes[targetTimelineId].document_revision = 1;
  nextLibrary.edited_at = utc(now);
  nextLibrary = assertLibraryDomainV1(nextLibrary);
  const newDigests = snapshotDigestMap(nextLibrary.content_time_system);
  const affectedBindings = [...new Set([...oldDigests.keys(), ...newDigests.keys()])]
    .filter((bindingId) => oldDigests.get(bindingId) !== newDigests.get(bindingId))
    .sort();
  const affectedConversations = [...new Set(affectedBindings.map((bindingId) => nextLibrary.content_time_system.sovereign.conversation_bindings[bindingId]?.conversation_key).filter(Boolean))].sort();
  const publicPlan = {
    operation: "timeline_sync",
    sync_mode: syncMode,
    variant_action: variantAction,
    source_timeline_id: timelineId,
    target_timeline_id: targetTimelineId,
    source_document_revision: timeline.document_revision,
    source_time_system_revision: library.content_time_system.revision,
    mutation_sha256: digest(stableText(command.mutation)),
    affected_binding_ids: affectedBindings,
    affected_conversation_keys: affectedConversations,
    ...(cloneResult ? { lineage_id: cloneResult.lineage_id, variant_no: cloneResult.variant_no } : {})
  };
  return {
    plan_id: digest(publicPlan),
    ...publicPlan,
    library: nextLibrary
  };
}

export function createOperationPlan(value) {
  if (!isRecord(value)) fail("CLOUDIG_TIME_INVALID_ENDPOINT", "$.plan", "Operation plan must be an object");
  const body = clone(value);
  delete body.plan_id;
  return { plan_id: digest(body), ...stableValue(body) };
}

export function assertFreshPlan(expectedPlanId, currentPlan) {
  const expected = sha(expectedPlanId, "$.plan_id");
  const planned = createOperationPlan(currentPlan);
  if (planned.plan_id !== expected) fail("CLOUDIG_TIME_PLAN_STALE", "$.plan_id", "The confirmed operation plan is stale", { expected, current: planned.plan_id });
  return planned;
}

export function digestCanonicalDocument(value) {
  return digest(serializeV1(value));
}
