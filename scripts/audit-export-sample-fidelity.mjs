#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { parseConversationBuffer } from "../parser/src/index.mjs";
import { extractInertJsonScript } from "../parser/src/contract.mjs";
import {
  inspectExportHtml,
  sampleCaseName
} from "./inspect-export-sample-set.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const PROJECT_TMP_ROOT = path.join(PROJECT_ROOT, "tmp");
const DEFAULT_DETAIL_PATH = path.join(PROJECT_TMP_ROOT, "export-sample-audit", "details.json");

const SUMMARY_FORMAT = "cloudig/export-sample-fidelity-summary/1.0.0";
const DETAIL_FORMAT = "cloudig/export-sample-fidelity-detail/1.0.0";
const MANIFEST_ID = "ai-chat-archive-manifest";
const DIAGNOSTICS_FORMAT = "ai-chat-archive/capture-diagnostics-v1";
const TRACKS = Object.freeze(["light", "full", "all_branches"]);
const PLATFORMS = Object.freeze([
  "chatglm",
  "chatgpt",
  "claude",
  "deepseek",
  "doubao",
  "gemini",
  "grok",
  "kimi",
  "mistral",
  "qwen",
  "yuanbao",
  "zai"
]);
const PLATFORM_SET = new Set(PLATFORMS);
const CANONICAL_SCHEMAS = Object.freeze([
  "ai-chat-archive/conversation/0.1.5",
  "ai-chat-archive/conversation/0.2.5"
]);
const CONTENT_TYPES = Object.freeze([
  "markdown",
  "text",
  "reasoning",
  "reasoning_summary",
  "status",
  "code",
  "math",
  "image",
  "attachment",
  "search",
  "citations",
  "tool",
  "diagram",
  "html",
  "unknown"
]);
const ROLE_NAMES = Object.freeze(["user", "assistant", "system", "tool"]);
const RESOURCE_KINDS = Object.freeze(["image", "attachment"]);
const RESOURCE_AVAILABILITY = Object.freeze(["embedded", "metadata_only", "missing"]);
const MIME_FAMILIES = new Set([
  "application",
  "audio",
  "font",
  "image",
  "message",
  "model",
  "multipart",
  "text",
  "video"
]);
const DEFAULT_WATERLINE_PATH = path.join(PROJECT_ROOT, "parser", "sample-waterline.json");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

function sortedCounts(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => compareText(left, right))
  );
}

function uniqueCategories(categories) {
  return [...new Set(categories)].sort(compareText);
}

function safeCode(value) {
  const text = String(value ?? "");
  return /^[a-z][a-z0-9_.-]{0,79}$/u.test(text) ? text : "unclassified";
}

function profileFromExporterVersion(version) {
  if (/-all-branches$/u.test(version)) return "all_branches";
  if (/-full$/u.test(version)) return "full";
  if (/-light$/u.test(version)) return "light";
  return "unknown";
}

function exporterVersionShapeValid(version) {
  return /^\d+\.\d+\.\d+-(?:light|full|all-branches)$/u.test(String(version));
}

function expectedSchema(track) {
  return track === "all_branches"
    ? "ai-chat-archive/conversation/0.2.5"
    : "ai-chat-archive/conversation/0.1.5";
}

function countTagOutsideScripts(source, tagName) {
  const lower = String(source).toLowerCase();
  const needle = `<${String(tagName).toLowerCase()}`;
  let count = 0;
  let cursor = 0;
  while (cursor < lower.length) {
    const scriptStart = lower.indexOf("<script", cursor);
    const segmentEnd = scriptStart < 0 ? lower.length : scriptStart;
    let tagCursor = cursor;
    while (tagCursor < segmentEnd) {
      const match = lower.indexOf(needle, tagCursor);
      if (match < 0 || match >= segmentEnd) break;
      const boundary = lower[match + needle.length] ?? "";
      if (!boundary || /[\s/>]/u.test(boundary)) count += 1;
      tagCursor = match + needle.length;
    }
    if (scriptStart < 0) break;
    const openEnd = lower.indexOf(">", scriptStart + 7);
    if (openEnd < 0) break;
    const closeStart = lower.indexOf("</script", openEnd + 1);
    if (closeStart < 0) break;
    const closeEnd = lower.indexOf(">", closeStart + 8);
    if (closeEnd < 0) break;
    cursor = closeEnd + 1;
  }
  return count;
}

function classifyInspectionError(error) {
  const message = String(error?.message ?? "");
  const rules = [
    [/exactly one #ai-chat-archive-manifest|unsupported manifest/iu, "manifest_contract_invalid"],
    [/unclosed script|not valid object JSON/iu, "inert_json_invalid"],
    [/manifest payload id must match exactly one|exactly one recognizable export payload/iu, "payload_cardinality_invalid"],
    [/manifest payload schema does not match/iu, "payload_schema_mismatch"],
    [/payload schema platform does not match|payload platform does not match/iu, "payload_platform_mismatch"],
    [/unsupported payload schema/iu, "payload_schema_invalid"],
    [/profile markers disagree/iu, "track_marker_mismatch"]
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? "html_contract_rejected";
}

function classifyParserError(error) {
  const message = String(error?.message ?? "");
  if (/Unified conversation validation failed/iu.test(message)) return "canonical_schema_invalid";
  if (/source family|payload|manifest|adapter|platform=/iu.test(message)) return "parser_route_rejected";
  if (/branch graph|current leaf|parent|cycle|message key/iu.test(message)) return "branch_projection_invalid";
  return "parser_failed";
}

function warningCounts(conversation) {
  const result = {};
  for (const warning of conversation.warnings ?? []) {
    increment(result, safeCode(warning?.code));
  }
  return sortedCounts(result);
}

function structureSnapshot(conversation) {
  const roles = emptyCounts(ROLE_NAMES);
  const contentTypes = emptyCounts(CONTENT_TYPES);
  const resourceKinds = emptyCounts(RESOURCE_KINDS);
  const resourceAvailability = emptyCounts(RESOURCE_AVAILABILITY);
  const mimeFamilies = {};
  const resourceUsage = new Map();
  const turns = new Set();
  let contentBlocks = 0;
  let resourceReferences = 0;

  for (const message of conversation.messages ?? []) {
    increment(roles, ROLE_NAMES.includes(message.role) ? message.role : "other");
    if (message.turn_id) turns.add(message.turn_id);
    for (const block of message.content ?? []) {
      contentBlocks += 1;
      increment(contentTypes, CONTENT_TYPES.includes(block.type) ? block.type : "other");
      if (block.resource_id) {
        resourceReferences += 1;
        const usages = resourceUsage.get(block.resource_id) ?? [];
        usages.push({ type: block.type, purpose: block.purpose ?? null });
        resourceUsage.set(block.resource_id, usages);
      }
    }
  }

  let embeddedWebpImages = 0;
  let embeddedOtherImages = 0;
  let embeddedOtherPlainImages = 0;
  let embeddedAttachments = 0;
  for (const resource of conversation.resources ?? []) {
    increment(resourceKinds, RESOURCE_KINDS.includes(resource.kind) ? resource.kind : "other");
    increment(
      resourceAvailability,
      RESOURCE_AVAILABILITY.includes(resource.availability) ? resource.availability : "other"
    );
    const rawMimeFamily = typeof resource.mime_type === "string"
      ? resource.mime_type.split("/", 1)[0].toLowerCase()
      : "unspecified";
    const mimeFamily = rawMimeFamily === "unspecified" || MIME_FAMILIES.has(rawMimeFamily)
      ? rawMimeFamily
      : "other";
    increment(mimeFamilies, mimeFamily);
    if (resource.availability === "embedded" && resource.kind === "attachment") {
      embeddedAttachments += 1;
    }
    if (resource.availability === "embedded" && resource.kind === "image") {
      if (resource.mime_type === "image/webp") embeddedWebpImages += 1;
      else {
        embeddedOtherImages += 1;
        const usages = resourceUsage.get(resource.id) ?? [];
        if (usages.some((usage) => usage.type === "image" && usage.purpose !== "diagram")) {
          embeddedOtherPlainImages += 1;
        }
      }
    }
  }

  return {
    message_count: conversation.messages?.length ?? 0,
    turn_count: turns.size,
    role_counts: sortedCounts(roles),
    content_block_count: contentBlocks,
    content_type_counts: sortedCounts(contentTypes),
    attachment_block_count: contentTypes.attachment,
    image_block_count: contentTypes.image,
    formula_block_count: contentTypes.math,
    search_block_count: contentTypes.search,
    citation_block_count: contentTypes.citations,
    resource_reference_count: resourceReferences,
    resource_count: conversation.resources?.length ?? 0,
    resource_kind_counts: sortedCounts(resourceKinds),
    resource_availability_counts: sortedCounts(resourceAvailability),
    resource_mime_family_counts: sortedCounts(mimeFamilies),
    embedded_webp_image_count: embeddedWebpImages,
    embedded_other_image_count: embeddedOtherImages,
    embedded_other_plain_image_count: embeddedOtherPlainImages,
    embedded_attachment_count: embeddedAttachments,
    source_reference_count: conversation.sources?.length ?? 0,
    parser_warning_counts: warningCounts(conversation)
  };
}

function branchSnapshot(conversation) {
  const anomalies = [];
  const indexById = new Map();
  const duplicateIds = new Set();
  let missingIds = 0;
  for (const [index, message] of (conversation.messages ?? []).entries()) {
    if (!message.id) {
      missingIds += 1;
      continue;
    }
    if (indexById.has(message.id)) duplicateIds.add(message.id);
    else indexById.set(message.id, index);
  }
  if (missingIds) anomalies.push("branch_message_id_missing");
  if (duplicateIds.size) anomalies.push("branch_message_id_duplicate");

  const parentIds = new Set();
  let internalParents = 0;
  let externalParents = 0;
  let parentAfterChild = 0;
  for (const [index, message] of (conversation.messages ?? []).entries()) {
    if (!message.parent_id) continue;
    const parentIndex = indexById.get(message.parent_id);
    if (parentIndex === undefined) {
      externalParents += 1;
      continue;
    }
    internalParents += 1;
    parentIds.add(message.parent_id);
    if (parentIndex >= index) parentAfterChild += 1;
  }
  if (parentAfterChild) anomalies.push("branch_parent_order_invalid");

  let cycles = 0;
  for (const message of conversation.messages ?? []) {
    const visited = new Set();
    let cursor = message;
    while (cursor?.parent_id && indexById.has(cursor.parent_id)) {
      if (!cursor.id || visited.has(cursor.id)) {
        cycles += 1;
        break;
      }
      visited.add(cursor.id);
      cursor = conversation.messages[indexById.get(cursor.parent_id)];
    }
  }
  if (cycles) anomalies.push("branch_cycle_detected");

  const leaves = (conversation.messages ?? []).filter((message) => message.id && !parentIds.has(message.id));
  const finalMessage = conversation.messages?.at(-1) ?? null;
  const finalIsLeaf = Boolean(finalMessage?.id && !parentIds.has(finalMessage.id));
  if (!finalIsLeaf) anomalies.push("branch_final_message_not_leaf");

  const activePath = [];
  const activeVisited = new Set();
  let cursor = finalMessage;
  while (cursor) {
    if (!cursor.id || activeVisited.has(cursor.id)) {
      if (cursor) anomalies.push("branch_active_path_invalid");
      break;
    }
    activeVisited.add(cursor.id);
    activePath.push(cursor);
    const parentIndex = cursor.parent_id ? indexById.get(cursor.parent_id) : undefined;
    cursor = parentIndex === undefined ? null : conversation.messages[parentIndex];
  }
  activePath.reverse();

  return {
    safe: {
      message_count: conversation.messages?.length ?? 0,
      internal_parent_count: internalParents,
      external_parent_count: externalParents,
      leaf_count: leaves.length,
      active_path_message_count: activePath.length,
      final_message_is_leaf: finalIsLeaf,
      anomaly_categories: uniqueCategories(anomalies)
    },
    activePath,
    anomalies
  };
}

function diagnosticsSnapshot(manifest) {
  const diagnostics = manifest?.capture_diagnostics;
  const entries = Array.isArray(diagnostics?.entries) ? diagnostics.entries : [];
  const valid = Boolean(
    diagnostics
    && typeof diagnostics === "object"
    && !Array.isArray(diagnostics)
    && diagnostics.format === DIAGNOSTICS_FORMAT
    && Array.isArray(diagnostics.entries)
    && entries.every((entry) => entry && typeof entry === "object" && entry.user_visible === false)
  );
  return {
    valid,
    entry_count: entries.length,
    image_summary_present: Boolean(manifest?.image_summary),
    resource_summary_present: Boolean(manifest?.resource_summary),
    raw_scope_present: Boolean(manifest?.raw_scope),
    branch_capture_present: Boolean(manifest?.branch || manifest?.branch_navigation)
  };
}

function emptyStructure() {
  return {
    message_count: 0,
    turn_count: 0,
    role_counts: {},
    content_block_count: 0,
    content_type_counts: {},
    attachment_block_count: 0,
    image_block_count: 0,
    formula_block_count: 0,
    search_block_count: 0,
    citation_block_count: 0,
    resource_reference_count: 0,
    resource_count: 0,
    resource_kind_counts: {},
    resource_availability_counts: {},
    resource_mime_family_counts: {},
    embedded_webp_image_count: 0,
    embedded_other_image_count: 0,
    embedded_other_plain_image_count: 0,
    embedded_attachment_count: 0,
    source_reference_count: 0,
    parser_warning_counts: {}
  };
}

function sourceCreatedAt(filePath) {
  const information = statSync(filePath);
  const value = Number.isFinite(information.birthtimeMs) && information.birthtimeMs > 0
    ? information.birthtime
    : information.ctime;
  return value.toISOString();
}

function auditSample(filePath, fileName, caseId, sampleId) {
  let requestedTrack = null;
  const anomalies = [];
  const safe = {
    case_id: caseId,
    sample_id: sampleId,
    requested_track: requestedTrack,
    platform: null,
    html_contract: {
      recognized: false,
      doctype_present: false,
      utf8_decodable: false,
      utf8_charset_present: false,
      utf8_bom: false,
      manifest_shape: null,
      payload_descriptor_present: false,
      capture_diagnostics_valid: false,
      capture_diagnostic_entry_count: 0,
      image_summary_present: false,
      resource_summary_present: false,
      raw_scope_present: false,
      branch_capture_present: false,
      static_math_element_count: 0
    },
    exporter: {
      version_present: false,
      version_shape_valid: false,
      declared_track: null,
      requested_track_matches: false
    },
    routing: {
      effective_track: null,
      declared_track_matches: false,
      requested_track_matches: false
    },
    parse: {
      succeeded: false,
      schema: null,
      schema_valid: false,
      platform_preserved: false,
      parser_version_present: false,
      exporter_version_preserved: false
    },
    structure: emptyStructure(),
    branch: null,
    anomaly_categories: []
  };

  let source;
  try {
    source = readFileSync(filePath);
  } catch (_error) {
    anomalies.push("html_read_failed");
    safe.anomaly_categories = uniqueCategories(anomalies);
    return { safe, internal: null, source_size_bytes: 0 };
  }

  let html;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(source).replace(/^\uFEFF/u, "");
    safe.html_contract.utf8_decodable = true;
  } catch (_error) {
    html = source.toString("utf8").replace(/^\uFEFF/u, "");
    anomalies.push("html_utf8_invalid");
  }
  safe.html_contract.utf8_bom = source.length >= 3
    && source[0] === 0xef
    && source[1] === 0xbb
    && source[2] === 0xbf;
  safe.html_contract.doctype_present = /^\s*<!doctype\s+html\b/iu.test(html);
  safe.html_contract.utf8_charset_present = /<meta\b[^>]*\bcharset\s*=\s*["']?utf-8\b/iu.test(html);
  safe.html_contract.static_math_element_count = countTagOutsideScripts(html, "math");
  if (!safe.html_contract.doctype_present) anomalies.push("html_doctype_missing");
  if (!safe.html_contract.utf8_charset_present) anomalies.push("html_utf8_charset_missing");

  let inspection;
  try {
    inspection = inspectExportHtml(filePath);
    safe.html_contract.recognized = true;
    const inspectedPlatform = String(inspection.platform ?? "").trim().toLowerCase();
    safe.platform = PLATFORM_SET.has(inspectedPlatform) ? inspectedPlatform : null;
    if (!safe.platform) anomalies.push("platform_unregistered");
    safe.html_contract.manifest_shape = inspection.manifest_shape;
    safe.html_contract.payload_descriptor_present = inspection.payload_descriptor;
    safe.exporter.version_present = Boolean(inspection.exporter_version);
    safe.exporter.version_shape_valid = exporterVersionShapeValid(inspection.exporter_version);
    safe.exporter.declared_track = profileFromExporterVersion(inspection.exporter_version);
    requestedTrack = inspection.profile;
    safe.requested_track = requestedTrack;
    safe.exporter.requested_track_matches = safe.exporter.declared_track === requestedTrack;
    if (!safe.exporter.version_present) anomalies.push("exporter_version_missing");
    else if (!safe.exporter.version_shape_valid) anomalies.push("exporter_version_shape_invalid");
    if (!safe.exporter.requested_track_matches) anomalies.push("track_marker_mismatch");

    const manifest = extractInertJsonScript(html, MANIFEST_ID).value;
    const diagnostics = diagnosticsSnapshot(manifest);
    safe.html_contract.capture_diagnostics_valid = diagnostics.valid;
    safe.html_contract.capture_diagnostic_entry_count = diagnostics.entry_count;
    safe.html_contract.image_summary_present = diagnostics.image_summary_present;
    safe.html_contract.resource_summary_present = diagnostics.resource_summary_present;
    safe.html_contract.raw_scope_present = diagnostics.raw_scope_present;
    safe.html_contract.branch_capture_present = diagnostics.branch_capture_present;
    if (!diagnostics.valid) anomalies.push("capture_diagnostics_invalid");
  } catch (error) {
    anomalies.push(classifyInspectionError(error));
  }

  let internal = null;
  if (safe.html_contract.recognized) {
    try {
      const parsed = parseConversationBuffer(source, {
        sourceFile: fileName,
        sourceCreatedAt: sourceCreatedAt(filePath)
      });
      safe.parse.succeeded = true;
      const parsedSchema = String(parsed.conversation.schema ?? "");
      safe.parse.schema = CANONICAL_SCHEMAS.includes(parsedSchema) ? parsedSchema : "unknown";
      safe.parse.schema_valid = parsedSchema === expectedSchema(requestedTrack);
      safe.parse.platform_preserved = Boolean(
        safe.platform && parsed.conversation.platform === safe.platform
      );
      safe.parse.parser_version_present = Boolean(parsed.conversation.parser_version);
      safe.parse.exporter_version_preserved = (
        parsed.conversation.exporter_version === inspection.exporter_version
      );
      const effectiveTrack = TRACKS.includes(parsed.adapter.profile)
        ? parsed.adapter.profile
        : "unknown";
      safe.routing.effective_track = effectiveTrack;
      safe.routing.declared_track_matches = effectiveTrack === safe.exporter.declared_track;
      safe.routing.requested_track_matches = effectiveTrack === requestedTrack;
      safe.structure = structureSnapshot(parsed.conversation);

      if (!safe.parse.schema_valid) anomalies.push("canonical_schema_track_mismatch");
      if (!safe.parse.platform_preserved) anomalies.push("parser_platform_mismatch");
      if (!safe.parse.parser_version_present) anomalies.push("parser_version_missing");
      if (!safe.parse.exporter_version_preserved) anomalies.push("exporter_version_not_preserved");
      if (!safe.routing.declared_track_matches || !safe.routing.requested_track_matches) {
        anomalies.push("effective_track_mismatch");
      }
      if (safe.structure.embedded_attachment_count > 0) {
        anomalies.push("embedded_attachment_policy_invalid");
      }
      let branch = null;
      if (requestedTrack === "all_branches") {
        branch = branchSnapshot(parsed.conversation);
        safe.branch = branch.safe;
        anomalies.push(...branch.anomalies);
      }
      internal = {
        conversation: parsed.conversation,
        structure: safe.structure,
        branch,
        requestedTrack,
        staticMathElementCount: safe.html_contract.static_math_element_count
      };
    } catch (error) {
      anomalies.push(classifyParserError(error));
    }
  }

  safe.anomaly_categories = uniqueCategories(anomalies);
  return { safe, internal, source_size_bytes: source.length };
}

function messageEnvelope(message) {
  return {
    turn_id: message.turn_id ?? null,
    role: message.role,
    timestamp: message.timestamp ?? null
  };
}

function contentCountDelta(left, right) {
  const result = {};
  for (const type of CONTENT_TYPES) {
    const delta = (right[type] ?? 0) - (left[type] ?? 0);
    if (delta !== 0) result[type] = delta;
  }
  return result;
}

function missingContentTypes(left, right) {
  return CONTENT_TYPES.filter((type) => (left[type] ?? 0) > 0 && (right[type] ?? 0) === 0);
}

function compareLightAndFull(light, full) {
  const anomalies = [];
  const lightMessages = light.conversation.messages.map(messageEnvelope);
  const fullMessages = full.conversation.messages.map(messageEnvelope);
  const matched = new Set();
  let cursor = 0;
  for (const expected of lightMessages) {
    const serialized = JSON.stringify(expected);
    while (cursor < fullMessages.length && JSON.stringify(fullMessages[cursor]) !== serialized) cursor += 1;
    if (cursor >= fullMessages.length) {
      anomalies.push("full_message_envelope_regression");
      break;
    }
    matched.add(cursor);
    cursor += 1;
  }
  const extraMessages = full.conversation.messages.filter((_message, index) => !matched.has(index));
  if (extraMessages.some((message) => message.role !== "tool")) {
    anomalies.push("full_non_tool_message_inserted");
  }
  const lightNonTool = light.conversation.messages
    .filter((message) => message.role !== "tool")
    .map(messageEnvelope);
  const fullNonTool = full.conversation.messages
    .filter((message) => message.role !== "tool")
    .map(messageEnvelope);
  if (JSON.stringify(lightNonTool) !== JSON.stringify(fullNonTool)) {
    anomalies.push("full_user_assistant_sequence_changed");
  }
  if (light.conversation.conversation_key !== full.conversation.conversation_key) {
    anomalies.push("cross_track_identity_mismatch");
  }
  const lightEmbedded = light.structure.resource_availability_counts.embedded ?? 0;
  const fullEmbedded = full.structure.resource_availability_counts.embedded ?? 0;
  if (fullEmbedded < lightEmbedded) anomalies.push("full_embedded_resource_regression");
  const missingTypes = missingContentTypes(
    light.structure.content_type_counts,
    full.structure.content_type_counts
  );
  if (missingTypes.length) anomalies.push("full_content_type_missing");

  return {
    safe: {
      checked: true,
      passed: anomalies.length === 0,
      light_message_count: light.structure.message_count,
      full_message_count: full.structure.message_count,
      full_only_tool_message_count: extraMessages.filter((message) => message.role === "tool").length,
      content_type_count_delta: contentCountDelta(
        light.structure.content_type_counts,
        full.structure.content_type_counts
      ),
      missing_content_types: missingTypes,
      light_embedded_resource_count: lightEmbedded,
      full_embedded_resource_count: fullEmbedded,
      light_static_math_element_count: light.staticMathElementCount,
      full_static_math_element_count: full.staticMathElementCount,
      anomaly_categories: uniqueCategories(anomalies)
    },
    anomalies
  };
}

function activePathStructure(messages) {
  const conversation = { messages, resources: [], sources: [], warnings: [] };
  return structureSnapshot(conversation);
}

function compareBranchesAndFull(branches, full) {
  const anomalies = [];
  const activePath = branches.branch?.activePath ?? [];
  const activeStructure = activePathStructure(activePath);
  const fullRoles = full.conversation.messages.map((message) => message.role);
  const activeRoles = activePath.map((message) => message.role);
  if (activePath.length !== full.conversation.messages.length) {
    anomalies.push("branch_active_path_length_mismatch");
  }
  if (JSON.stringify(activeRoles) !== JSON.stringify(fullRoles)) {
    anomalies.push("branch_active_path_role_mismatch");
  }
  if (branches.conversation.conversation_key !== full.conversation.conversation_key) {
    anomalies.push("cross_track_identity_mismatch");
  }
  const missingTypes = missingContentTypes(
    full.structure.content_type_counts,
    activeStructure.content_type_counts
  );
  if (missingTypes.length) anomalies.push("branch_active_path_content_type_missing");
  const branchEmbedded = branches.structure.resource_availability_counts.embedded ?? 0;
  const fullEmbedded = full.structure.resource_availability_counts.embedded ?? 0;
  if (branchEmbedded < fullEmbedded) anomalies.push("branch_resource_capability_regression");

  return {
    safe: {
      checked: true,
      passed: anomalies.length === 0,
      full_message_count: full.structure.message_count,
      active_path_message_count: activePath.length,
      branch_message_count: branches.structure.message_count,
      branch_leaf_count: branches.branch?.safe.leaf_count ?? 0,
      active_path_content_type_count_delta: contentCountDelta(
        full.structure.content_type_counts,
        activeStructure.content_type_counts
      ),
      missing_active_path_content_types: missingTypes,
      full_embedded_resource_count: fullEmbedded,
      branch_embedded_resource_count: branchEmbedded,
      full_static_math_element_count: full.staticMathElementCount,
      branch_static_math_element_count: branches.staticMathElementCount,
      anomaly_categories: uniqueCategories(anomalies)
    },
    anomalies
  };
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) increment(target, key, value);
}

function coverageSnapshot(samples, cases) {
  const platformSet = new Set(samples.map((sample) => sample.platform).filter(Boolean));
  const tracks = {};
  for (const track of TRACKS) {
    const trackSamples = samples.filter((sample) => sample.requested_track === track);
    tracks[track] = {
      samples: trackSamples.length,
      cases: new Set(trackSamples.map((sample) => sample.case_id)).size,
      platforms: new Set(trackSamples.map((sample) => sample.platform).filter(Boolean)).size,
      recognized_html: trackSamples.filter((sample) => sample.html_contract.recognized).length,
      exporter_versions_valid: trackSamples.filter((sample) => sample.exporter.version_shape_valid).length,
      effective_track_matches: trackSamples.filter((sample) => sample.routing.requested_track_matches).length,
      parsed: trackSamples.filter((sample) => sample.parse.succeeded).length,
      schema_valid: trackSamples.filter((sample) => sample.parse.schema_valid).length
    };
  }
  return { cases: cases.length, platforms: platformSet.size, tracks };
}

function expectedCoverageAnomalies(actual, enabled, waterlinePath = DEFAULT_WATERLINE_PATH) {
  if (!enabled) return [];
  const waterline = JSON.parse(readFileSync(waterlinePath, "utf8"));
  if (waterline?.format !== "cloudig/parser-sample-waterline") {
    return ["sample_waterline_invalid"];
  }
  const expected = waterline.summary ?? {};
  const anomalies = [];
  for (const [actualValue, expectedValue] of [
    [actual.html_files, expected.files],
    [actual.cases, expected.cases],
    [actual.platforms, expected.platforms]
  ]) {
    if (actualValue !== expectedValue) anomalies.push("expected_coverage_mismatch");
  }
  for (const track of TRACKS) {
    if (actual.tracks[track].samples !== expected.profile_counts?.[track]) {
      anomalies.push("expected_coverage_mismatch");
    }
  }
  return anomalies;
}

function buildSummary(
  samples,
  cases,
  comparisons,
  totalBytes,
  globalAnomalies,
  networkRequests,
  expectCanonical
) {
  const coverage = coverageSnapshot(samples, cases);
  const anomalies = [...globalAnomalies];
  for (const sample of samples) anomalies.push(...sample.anomaly_categories);
  for (const record of cases) anomalies.push(...record.anomaly_categories);
  const anomalyCounts = {};
  for (const category of anomalies) increment(anomalyCounts, category);

  const contentByTrack = {};
  const resourcesByTrack = {};
  const warningCountsByTrack = {};
  for (const track of TRACKS) {
    const contentCounts = {};
    const resourceKinds = {};
    const resourceAvailability = {};
    const warnings = {};
    let messages = 0;
    let contentBlocks = 0;
    let resources = 0;
    let sources = 0;
    let staticMathElements = 0;
    let embeddedWebpImages = 0;
    let embeddedOtherImages = 0;
    let embeddedOtherPlainImages = 0;
    for (const sample of samples.filter((candidate) => candidate.requested_track === track)) {
      messages += sample.structure.message_count;
      contentBlocks += sample.structure.content_block_count;
      resources += sample.structure.resource_count;
      sources += sample.structure.source_reference_count;
      staticMathElements += sample.html_contract.static_math_element_count;
      embeddedWebpImages += sample.structure.embedded_webp_image_count;
      embeddedOtherImages += sample.structure.embedded_other_image_count;
      embeddedOtherPlainImages += sample.structure.embedded_other_plain_image_count;
      mergeCounts(contentCounts, sample.structure.content_type_counts);
      mergeCounts(resourceKinds, sample.structure.resource_kind_counts);
      mergeCounts(resourceAvailability, sample.structure.resource_availability_counts);
      mergeCounts(warnings, sample.structure.parser_warning_counts);
    }
    contentByTrack[track] = {
      message_count: messages,
      content_block_count: contentBlocks,
      content_type_counts: sortedCounts(contentCounts),
      attachment_block_count: contentCounts.attachment ?? 0,
      formula_block_count: contentCounts.math ?? 0,
      search_block_count: contentCounts.search ?? 0,
      citation_block_count: contentCounts.citations ?? 0,
      static_math_element_count: staticMathElements
    };
    resourcesByTrack[track] = {
      resource_count: resources,
      resource_kind_counts: sortedCounts(resourceKinds),
      resource_availability_counts: sortedCounts(resourceAvailability),
      embedded_webp_image_count: embeddedWebpImages,
      embedded_other_image_count: embeddedOtherImages,
      embedded_other_plain_image_count: embeddedOtherPlainImages,
      source_reference_count: sources
    };
    warningCountsByTrack[track] = sortedCounts(warnings);
  }

  const schemas = {};
  for (const sample of samples.filter((candidate) => candidate.parse.succeeded)) {
    const key = sample.parse.schema === "ai-chat-archive/conversation/0.2.5"
      ? "branches_0_2_5"
      : sample.parse.schema === "ai-chat-archive/conversation/0.1.5"
        ? "flat_0_1_5"
        : "other";
    increment(schemas, key);
  }

  const branchSamples = samples.filter((sample) => sample.branch);
  const branchStructure = {
    samples: branchSamples.length,
    message_count: branchSamples.reduce((sum, sample) => sum + sample.branch.message_count, 0),
    internal_parent_count: branchSamples.reduce(
      (sum, sample) => sum + sample.branch.internal_parent_count,
      0
    ),
    external_parent_count: branchSamples.reduce(
      (sum, sample) => sum + sample.branch.external_parent_count,
      0
    ),
    leaf_count: branchSamples.reduce((sum, sample) => sum + sample.branch.leaf_count, 0),
    active_path_message_count: branchSamples.reduce(
      (sum, sample) => sum + sample.branch.active_path_message_count,
      0
    ),
    final_message_is_leaf: branchSamples.filter((sample) => sample.branch.final_message_is_leaf).length
  };

  return {
    format: SUMMARY_FORMAT,
    ok: anomalies.length === 0,
    gate: expectCanonical ? "parser_sample_waterline" : "structural",
    totals: {
      html_files: samples.length,
      cases: coverage.cases,
      platforms: coverage.platforms,
      total_bytes: totalBytes
    },
    track_coverage: coverage.tracks,
    html_recognition: {
      recognized: samples.filter((sample) => sample.html_contract.recognized).length,
      doctype_present: samples.filter((sample) => sample.html_contract.doctype_present).length,
      utf8_decodable: samples.filter((sample) => sample.html_contract.utf8_decodable).length,
      utf8_charset_present: samples.filter((sample) => sample.html_contract.utf8_charset_present).length,
      capture_diagnostics_valid: samples.filter(
        (sample) => sample.html_contract.capture_diagnostics_valid
      ).length
    },
    parser: {
      succeeded: samples.filter((sample) => sample.parse.succeeded).length,
      failed: samples.filter((sample) => !sample.parse.succeeded).length,
      schema_counts: sortedCounts(schemas),
      external_request_attempts: networkRequests
    },
    content_structure: contentByTrack,
    resource_policy: resourcesByTrack,
    branch_structure: branchStructure,
    fidelity_comparisons: {
      light_full_checked: comparisons.filter((record) => record.light_full?.checked).length,
      light_full_passed: comparisons.filter((record) => record.light_full?.passed).length,
      branches_full_checked: comparisons.filter((record) => record.branches_full?.checked).length,
      branches_full_passed: comparisons.filter((record) => record.branches_full?.passed).length
    },
    observations: {
      parser_warning_counts_by_track: warningCountsByTrack
    },
    anomalies: {
      total: anomalies.length,
      categories: sortedCounts(anomalyCounts)
    }
  };
}

const FORBIDDEN_DETAIL_KEYS = new Set([
  "file_name",
  "case_name",
  "source_root",
  "source_path",
  "source_file",
  "output_path",
  "detail_path",
  "checked_against",
  "title",
  "source_url",
  "conversation_id",
  "message_id",
  "parent_id",
  "turn_id",
  "sha256",
  "hash",
  "data_url",
  "body"
]);

export function assertPrivacySafeReport(report, privateValues = []) {
  const privateStrings = privateValues
    .map((value) => String(value ?? ""))
    .filter(Boolean);
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_DETAIL_KEYS.has(key)) {
          throw new Error("Audit detail contains a forbidden private field");
        }
        visit(child);
      }
      return;
    }
    if (typeof value !== "string") return;
    if (/[A-Za-z]:[\\/]|^\\\\|^\/(?!\/)/u.test(value)) {
      throw new Error("Audit detail contains an absolute path");
    }
    if (/https?:\/\/|data:image\//iu.test(value)) {
      throw new Error("Audit detail contains a URL or media payload");
    }
    if (/\b[a-f0-9]{64}\b/iu.test(value)) {
      throw new Error("Audit detail contains a private hash-like value");
    }
    if (privateStrings.some((candidate) => value.includes(candidate))) {
      throw new Error("Audit detail contains an input identifier");
    }
  }
  visit(report);
  return true;
}

export function auditExportSampleSet(directoryPath, { expectCanonical = false } = {}) {
  const sourceRoot = path.resolve(directoryPath);
  const names = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.html$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareText);

  const groups = new Map();
  for (const name of names) {
    const caseName = sampleCaseName(name);
    const group = groups.get(caseName) ?? [];
    group.push({ name });
    groups.set(caseName, group);
  }

  const samples = [];
  const cases = [];
  const comparisons = [];
  const globalAnomalies = [];
  let totalBytes = 0;
  let networkRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (..._arguments) => {
    networkRequests += 1;
    throw new Error("Network access is disabled during export sample audit");
  };

  try {
    let caseIndex = 0;
    for (const [, entries] of [...groups].sort(([left], [right]) => compareText(left, right))) {
      caseIndex += 1;
      const caseId = `case-${String(caseIndex).padStart(2, "0")}`;
      const profileCounts = emptyCounts(TRACKS);
      const caseAnomalies = [];

      const internals = {};
      let entryIndex = 0;
      for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
        entryIndex += 1;
        const sampleId = `${caseId}-sample-${String(entryIndex).padStart(2, "0")}`;
        const audited = auditSample(
          path.join(sourceRoot, entry.name),
          entry.name,
          caseId,
          sampleId
        );
        samples.push(audited.safe);
        totalBytes += audited.source_size_bytes;
        const track = audited.internal?.requestedTrack ?? audited.safe.exporter.declared_track;
        if (TRACKS.includes(track)) {
          increment(profileCounts, track);
          if (!internals[track] && audited.internal) internals[track] = audited.internal;
        } else {
          caseAnomalies.push("case_track_coverage_invalid");
        }
      }
      if (TRACKS.some((track) => profileCounts[track] > 1)) {
        caseAnomalies.push("case_track_coverage_invalid");
      }

      const platforms = new Set(
        samples
          .filter((sample) => sample.case_id === caseId)
          .map((sample) => sample.platform)
          .filter(Boolean)
      );
      if (platforms.size > 1) caseAnomalies.push("case_platform_mismatch");

      let lightFull = null;
      let branchesFull = null;
      if (internals.light && internals.full) {
        const compared = compareLightAndFull(internals.light, internals.full);
        lightFull = compared.safe;
        caseAnomalies.push(...compared.anomalies);
      }
      if (internals.all_branches && internals.full) {
        const compared = compareBranchesAndFull(internals.all_branches, internals.full);
        branchesFull = compared.safe;
        caseAnomalies.push(...compared.anomalies);
      }

      const safeCase = {
        case_id: caseId,
        sample_counts_by_track: Object.fromEntries(
          TRACKS.map((track) => [track, profileCounts[track] ?? 0])
        ),
        platform_count: platforms.size,
        light_full: lightFull,
        branches_full: branchesFull,
        anomaly_categories: uniqueCategories(caseAnomalies)
      };
      cases.push(safeCase);
      comparisons.push(safeCase);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (!names.length) globalAnomalies.push("input_no_html");
  if (networkRequests) globalAnomalies.push("network_request_attempted");
  const coverage = coverageSnapshot(samples, cases);
  globalAnomalies.push(...expectedCoverageAnomalies({
    html_files: samples.length,
    cases: coverage.cases,
    platforms: coverage.platforms,
    tracks: coverage.tracks
  }, expectCanonical));

  const summary = buildSummary(
    samples,
    cases,
    comparisons,
    totalBytes,
    globalAnomalies,
    networkRequests,
    expectCanonical
  );
  const detail = {
    format: DETAIL_FORMAT,
    privacy_contract: {
      input_paths_included: false,
      file_names_included: false,
      titles_or_body_included: false,
      urls_or_private_ids_included: false,
      media_content_included: false,
      private_hash_list_included: false
    },
    summary,
    samples,
    cases
  };
  assertPrivacySafeReport(detail, [sourceRoot, ...names]);
  return { summary, detail };
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function writeAuditDetail(detail, outputPath = DEFAULT_DETAIL_PATH) {
  const absolute = path.resolve(PROJECT_ROOT, outputPath);
  if (!isWithin(PROJECT_TMP_ROOT, absolute)) {
    throw new Error("Detailed audit output must stay inside the project tmp directory");
  }
  assertPrivacySafeReport(detail);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(detail, null, 2)}\n`, "utf8");
  return absolute;
}

function parseCliArgs(argv) {
  const args = [...argv];
  if (!args.length || args[0] === "--help" || args[0] === "-h") return { help: true };
  const directory = args.shift();
  let expectCanonical = false;
  let detailOutput = DEFAULT_DETAIL_PATH;
  while (args.length) {
    const option = args.shift();
    if (option === "--expect-canonical" && !expectCanonical) {
      expectCanonical = true;
    } else if (option === "--detail-output" && args.length) {
      detailOutput = args.shift();
    } else {
      throw new Error("Invalid command line");
    }
  }
  return { help: false, directory, expectCanonical, detailOutput };
}

function fatalSummary(category) {
  return {
    format: SUMMARY_FORMAT,
    ok: false,
    gate: "structural",
    totals: { html_files: 0, cases: 0, platforms: 0, total_bytes: 0 },
    track_coverage: Object.fromEntries(TRACKS.map((track) => [track, {
      samples: 0,
      cases: 0,
      platforms: 0,
      recognized_html: 0,
      exporter_versions_valid: 0,
      effective_track_matches: 0,
      parsed: 0,
      schema_valid: 0
    }])),
    anomalies: { total: 1, categories: { [category]: 1 } }
  };
}

function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: node scripts/audit-export-sample-fidelity.mjs <folder> "
        + "[--expect-canonical] [--detail-output <tmp-json>]\n"
      );
      return;
    }
    const result = auditExportSampleSet(options.directory, {
      expectCanonical: options.expectCanonical
    });
    writeAuditDetail(result.detail, options.detailOutput);
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
    if (!result.summary.ok) process.exitCode = 1;
  } catch (error) {
    const category = /Detailed audit output must stay/iu.test(String(error?.message ?? ""))
      ? "detail_output_boundary_invalid"
      : /Invalid command line/iu.test(String(error?.message ?? ""))
        ? "cli_usage_invalid"
        : "audit_execution_failed";
    process.stdout.write(`${JSON.stringify(fatalSummary(category), null, 2)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
