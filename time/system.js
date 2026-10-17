(function initCloudigTimeSystem(root, factory) {
  "use strict";
  const time = typeof module === "object" && module?.exports ? require("./core.js") : root.CloudigTimeCore;
  const preset = typeof module === "object" && module?.exports ? require("./presets/terran-cloudig-1.0.0.json") : root.CloudigTerranPreset;
  const api = factory(time, preset);
  root.CloudigTimeSystem = api;
  if (typeof module === "object" && module?.exports) module.exports = api;
}(typeof globalThis === "object" ? globalThis : this, function createCloudigTimeSystem(time, preset) {
  "use strict";

  const FORMAT = "cloudig/content-time-system";
  const VERSION = "1.0.0";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const NODE_BY_ID = new Map(preset.nodes.map((node) => [node.node_id, Object.freeze(structuredClone(node))]));
  const TEMPLATE_NEEDS_ANCHOR = new Set(preset.nodes.filter((node) => JSON.stringify(node.default_range_template).includes("materialize_on_apply")).map((node) => node.node_id));

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    return structuredClone(value);
  }

  function fail(path, message) {
    const error = new TypeError(`${path}: ${message}`);
    error.path = path;
    throw error;
  }

  function exactKeys(value, allowed, path) {
    if (!isRecord(value)) fail(path, "must be an object");
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }

  function canonicalAnchor(value, path) {
    try {
      return time.materializePresetEndpoint({ kind: "terran_now", anchor_policy: "materialize_on_apply" }, value, path).anchor;
    } catch (error) {
      if (error?.path) fail(error.path, error.message);
      throw error;
    }
  }

  function assertPresetNode(nodeId, path, { editable = false } = {}) {
    if (typeof nodeId !== "string" || !UUID.test(nodeId) || !NODE_BY_ID.has(nodeId)) fail(path, "must reference one built-in Terran node");
    const node = NODE_BY_ID.get(nodeId);
    if (editable && !node.range_editable) fail(path, "the built-in special node does not accept a concrete range");
    return node;
  }

  function normalizePresetRange(value, path) {
    const result = time.validateRange(value, { require_flags: true });
    if (!result.valid) {
      const issue = result.errors[0];
      fail(`${path}${issue.path.slice(1)}`, issue.message);
    }
    for (const endpoint of [result.value.start, result.value.end].filter(Boolean)) {
      if (endpoint.kind === "sovereign") fail(path, "Terran preset overrides cannot reference Sovereign time");
    }
    return result.value;
  }

  function emptySovereign() {
    return {
      lineages: {},
      nodes: {},
      containment_links: {},
      counterpart_links: {},
      terran_mappings: {},
      conversation_bindings: {},
      display_order: { mode: "last_edited_desc" }
    };
  }

  function createContentTimeSystem(valueAnchor) {
    return {
      format: FORMAT,
      version: VERSION,
      revision: 1,
      terran: {
        preset_version: preset.version,
        default_anchor: canonicalAnchor(valueAnchor, "$.terran.default_anchor"),
        preset_anchor_overrides: {},
        preset_overrides: {}
      },
      sovereign: emptySovereign()
    };
  }

  function normalizeContentTimeSystem(value) {
    exactKeys(value, new Set(["format", "version", "revision", "terran", "sovereign"]), "$");
    if (value.format !== FORMAT) fail("$.format", `must equal ${FORMAT}`);
    if (value.version !== VERSION) fail("$.version", `must equal ${VERSION}`);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) fail("$.revision", "must be a positive safe integer");
    exactKeys(value.terran, new Set(["preset_version", "default_anchor", "preset_anchor_overrides", "preset_overrides"]), "$.terran");
    if (value.terran.preset_version !== preset.version) fail("$.terran.preset_version", `must equal ${preset.version}`);
    const defaultAnchor = canonicalAnchor(value.terran.default_anchor, "$.terran.default_anchor");
    exactKeys(value.terran.preset_anchor_overrides, new Set(Object.keys(value.terran.preset_anchor_overrides || {})), "$.terran.preset_anchor_overrides");
    const anchorOverrides = {};
    for (const nodeId of Object.keys(value.terran.preset_anchor_overrides).sort((left, right) => left.localeCompare(right, "en"))) {
      assertPresetNode(nodeId, `$.terran.preset_anchor_overrides.${nodeId}`);
      if (!TEMPLATE_NEEDS_ANCHOR.has(nodeId)) fail(`$.terran.preset_anchor_overrides.${nodeId}`, "node default does not use an anchor");
      anchorOverrides[nodeId] = canonicalAnchor(value.terran.preset_anchor_overrides[nodeId], `$.terran.preset_anchor_overrides.${nodeId}`);
    }
    exactKeys(value.terran.preset_overrides, new Set(Object.keys(value.terran.preset_overrides || {})), "$.terran.preset_overrides");
    const rangeOverrides = {};
    for (const nodeId of Object.keys(value.terran.preset_overrides).sort((left, right) => left.localeCompare(right, "en"))) {
      assertPresetNode(nodeId, `$.terran.preset_overrides.${nodeId}`, { editable: true });
      rangeOverrides[nodeId] = normalizePresetRange(value.terran.preset_overrides[nodeId], `$.terran.preset_overrides.${nodeId}`);
    }
    exactKeys(value.sovereign, new Set(["lineages", "nodes", "containment_links", "counterpart_links", "terran_mappings", "conversation_bindings", "display_order"]), "$.sovereign");
    for (const key of ["lineages", "nodes", "containment_links", "counterpart_links", "terran_mappings", "conversation_bindings"]) {
      if (!isRecord(value.sovereign[key])) fail(`$.sovereign.${key}`, "must be an object map");
    }
    if (!isRecord(value.sovereign.display_order) || !["last_edited_desc", "manual"].includes(value.sovereign.display_order.mode)) fail("$.sovereign.display_order", "must declare a supported display mode");
    return {
      format: FORMAT,
      version: VERSION,
      revision: value.revision,
      terran: {
        preset_version: preset.version,
        default_anchor: defaultAnchor,
        preset_anchor_overrides: anchorOverrides,
        preset_overrides: rangeOverrides
      },
      sovereign: clone(value.sovereign)
    };
  }

  function resolvePresetRange(value, nodeId) {
    const system = normalizeContentTimeSystem(value);
    const node = assertPresetNode(nodeId, "$.node_id");
    if (Object.hasOwn(system.terran.preset_overrides, nodeId)) return clone(system.terran.preset_overrides[nodeId]);
    const valueAnchor = system.terran.preset_anchor_overrides[nodeId] || system.terran.default_anchor;
    return time.materializePresetRange(node.default_range_template, valueAnchor);
  }

  function setPresetRange(value, nodeId, range) {
    const system = normalizeContentTimeSystem(value);
    assertPresetNode(nodeId, "$.node_id", { editable: true });
    system.terran.preset_overrides[nodeId] = normalizePresetRange(range, "$.range");
    delete system.terran.preset_anchor_overrides[nodeId];
    system.revision += 1;
    return normalizeContentTimeSystem(system);
  }

  function restorePresetRange(value, nodeId, valueAnchor) {
    const system = normalizeContentTimeSystem(value);
    assertPresetNode(nodeId, "$.node_id", { editable: true });
    delete system.terran.preset_overrides[nodeId];
    if (TEMPLATE_NEEDS_ANCHOR.has(nodeId)) system.terran.preset_anchor_overrides[nodeId] = canonicalAnchor(valueAnchor, `$.terran.preset_anchor_overrides.${nodeId}`);
    else delete system.terran.preset_anchor_overrides[nodeId];
    system.revision += 1;
    return normalizeContentTimeSystem(system);
  }

  return Object.freeze({
    FORMAT,
    VERSION,
    PRESET_VERSION: preset.version,
    PRESET_TIMELINE_ID: preset.timeline.timeline_id,
    createContentTimeSystem,
    normalizeContentTimeSystem,
    resolvePresetRange,
    setPresetRange,
    restorePresetRange
  });
}));
