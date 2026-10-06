import { createHash, randomBytes } from "node:crypto";
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { validateRecord, validateRecordRange } from "../core/records/index.mts";
import { RecordSchemaError } from "../core/records/errors.mts";
import { builtinTimeIds, builtinTimeNode } from "../core/records/time-presets.mts";
import { uuidV7 } from "../core/records/ids.mts";
import { canonicalizeJcs } from "../core/contracts/deterministic-json.mts";
import { RecordTimeGraph } from "../core/records/time-graph.mts";
import presets from "../core/records/time-presets.json" with { type: "json" };
import { formatRecordTimeRange, recordTimeRangeDirection } from "../core/records/time-display.mts";
import { normalizeRange } from "../core/time/range.mts";
import { loadRecordTimes, reorderRecordTimes, createRecordTime, prepareRecordTimeEditorSave, commitRecordTimeSave, prepareRecordTimeDelete, commitRecordTimeDelete, type RecordTimeSavePlan, type RecordTimeDeletePlan, type RecordTimeCatalog, type TimeStoredRecord } from "../adapters/library-data/record-time.mts";
import { readRecordCatalog, type RecordCatalog } from "../adapters/library-data/record-catalog.mts";
import { readStoredRecord, withRecordSnapshot, RecordStoreConflict } from "../adapters/storage/record-store.mts";
import { localRecordAnchor } from "./record-library-commands.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";

export const RECORD_TIME_ENGINE_LIMITS = Object.freeze({ nodes: 8192, routes: 32, endpoints: 256, references: 100000, plans: 4, queryPage: 500, fields: 10000 });
const object = (value: JsonValue | undefined): JsonObject => isJsonObject(value) ? value : {};
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const rootId = presets.nodes[0]!.node_id;
const shortcutIds = new Set(presets.nodes.filter(n => ["宇宙诞生", "生命起源", "史前文明", "轴心时代", "帝国兴亡", "工业革命", "硝烟铁幕", "现代社会", "智能初晓"].includes(n.name)).map(n => n.node_id));
type Route = { returnTo: string; focus?: string };
type Node = { id: string; hash: string; axis?: string };
type Endpoint = { value: JsonObject; graph?: string };
type Snapshot = { times: RecordTimeCatalog; library: JsonObject; libraryHash: string; revision: string };
type Reference = { id: string; hash: string };
type Draft = { fields: JsonObject; counterparts: JsonObject[] };
type EditPreview = { node?: string; draft: JsonObject; cancel: Set<string>; baseline?: RecordTimeSavePlan; force: boolean; choice?: { key: string; prepared: RecordTimeSavePlan } };
const array = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value as JsonObject[] : [];
function bounded(value: JsonValue | undefined): JsonValue[] { if (!Array.isArray(value) || value.length > RECORD_TIME_ENGINE_LIMITS.fields) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid time editor list"); return value; }
function refreshRangeAnchors(range: JsonObject, anchor: Readonly<{ date: string; offset: string }>): JsonObject { const value = structuredClone(range); for (const endpoint of Object.values(value)) if (isJsonObject(endpoint) && ["now", "relative"].includes(String(endpoint["kind"]))) endpoint["anchor"] = { ...anchor }; return value; }
function planWitness(plan: RecordTimeSavePlan): string {
  const hashes = [...plan.reads, ...plan.changes].filter(r => r.expected !== null && r.path !== "ContentTimes/order.json").map(r => [r.path, r.expected]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en"));
  return JSON.stringify([plan.inventory, hashes]);
}
const choiceKey = (strategy: string, references: readonly Reference[]) => JSON.stringify([strategy, references.map(r => [r.id, r.hash]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en"))]);

function exact(value: JsonValue | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!isJsonObject(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid time command fields"); return value;
}
function remember<T>(map: Map<string, T>, prefix: string, value: T, maximum: number): string {
  const id = token(prefix); while (map.size >= maximum) map.delete(map.keys().next().value!); map.set(id, value); return id;
}
function known<T>(map: ReadonlyMap<string, T>, value: JsonValue | undefined, kind: string): T {
  const result = typeof value === "string" ? map.get(value) : undefined;
  if (!result) throw new EngineCommandError(`CLOUDIG_TIME_${kind.toUpperCase()}_STALE`, `Time ${kind} is stale; reopen the page`); return result;
}

/** New independent-node query boundary. Existing page concepts are views, not a serialized legacy graph. */
export class RecordTimeEngineCommands {
  readonly #root: string;
  readonly #routes = new Map<string, Route>();
  readonly #nodes = new Map<string, Node>();
  readonly #endpoints = new Map<string, Endpoint>();
  readonly #references = new Map<string, Reference>();
  readonly #plans = new Map<string, EditPreview>();
  readonly #deletes = new Map<string, RecordTimeDeletePlan>();
  constructor(input: Readonly<{ libraryRoot: string }>) { this.#root = input.libraryRoot; }
  async #snapshot(): Promise<Snapshot> {
    return withRecordSnapshot(this.#root, async () => {
      const times = await loadRecordTimes(this.#root), library = await readStoredRecord(this.#root, "library", "CloudigLibrary.json");
      const revision = createHash("sha256").update(times.order.sha256);
      for (const n of [...times.nodes].sort((a, b) => a.path.localeCompare(b.path, "en"))) revision.update(n.path).update(n.sha256);
      return { times, library: library.value, libraryHash: library.sha256, revision: revision.digest("hex") };
    });
  }
  #node(value: JsonValue | undefined, current: Snapshot, allowMissing = false): Node {
    const selected = known(this.#nodes, value, "node"), record = current.times.nodes.find(n => n.value["node_id"] === selected.id);
    if (!record && allowMissing && selected.hash === "missing") return selected;
    if (!record || record.sha256 !== selected.hash) throw new EngineCommandError("CLOUDIG_TIME_NODE_STALE", "Time node changed; refresh before continuing"); return selected;
  }
  #nodeToken(record: TimeStoredRecord, axis?: string): string {
    const id = String(record.value["node_id"]);
    for (const [key, known] of this.#nodes) if (known.id === id && known.hash === record.sha256 && known.axis === axis) return key;
    return remember(this.#nodes, "tn", { id, hash: record.sha256, ...(axis ? { axis } : {}) }, RECORD_TIME_ENGINE_LIMITS.nodes);
  }
  #row(record: TimeStoredRecord, axis?: string): JsonObject {
    const value = record.value, result: JsonObject = { node: this.#nodeToken(record, axis), kind: value["kind"]!, name: value["name"]!, revision: record.sha256,
      edited_at: value["edited_at"]!, builtin: builtinTimeIds.has(String(value["node_id"])), shortcut: shortcutIds.has(String(value["node_id"])), editable: true, children: (value["contains"] as JsonObject[] | undefined)?.length ?? 0 };
    for (const key of ["author", "standard_name", "version", "created_at", "count", "prefix", "unit", "display_empty"]) if (value[key] !== undefined) result[key] = value[key]!;
    const mappings = value["terran_mappings"] as JsonObject[] | undefined;
    if (result["builtin"] && mappings?.[0]?.["range"]) result["range"] = structuredClone(mappings[0]["range"]!);
    return result;
  }
  #roots(current: Snapshot): JsonObject[] {
    const byId = new Map(current.times.nodes.map(n => [String(n.value["node_id"]), n]));
    return current.times.graph.roots(current.times.order.value["nodes"] as string[]).filter(id => !builtinTimeIds.has(id)).map(id => this.#row(byId.get(id)!));
  }
  #register(value: JsonObject, graph?: string): JsonObject {
    const snapshot = object(value["snapshot"]), selection = remember(this.#endpoints, "te", { value: structuredClone(value), ...(graph ? { graph } : {}) }, RECORD_TIME_ENGINE_LIMITS.endpoints);
    const target = object(value["target"]);
    return { kind: "sovereign", selection, display: { target: structuredClone(snapshot["node"]!), ...(target["occurrences"] ? { occurrences: structuredClone(target["occurrences"]!) } : {}), ...(snapshot["timeline"] ? { timeline: structuredClone(snapshot["timeline"]!) } : {}), ...(snapshot["path"] ? { path: structuredClone(snapshot["path"]!) } : {}), ...(snapshot["sort"] ? { sort: structuredClone(snapshot["sort"]!) } : {}) } };
  }
  #reference(mark: { value: JsonObject; sha256: string }): string {
    for (const [key, reference] of this.#references) if (reference.id === mark.value["mark_id"] && reference.hash === mark.sha256) return key;
    return remember(this.#references, "ta", { id: String(mark.value["mark_id"]), hash: mark.sha256 }, RECORD_TIME_ENGINE_LIMITS.references);
  }
  #referenceRows(catalog: RecordCatalog, ids: ReadonlySet<string>): JsonObject[] {
    return catalog.marks.filter(mark => ids.has(String(mark.value["mark_id"]))).map(mark => {
      const source = catalog.conversations.find(c => c.header["conversation_id"] === mark.value["target"]), title = object(source?.header["title"]);
      return { reference: this.#reference(mark), title: mark.value["conversation_title"] ?? title["filename"] ?? title["original"] ?? String(mark.value["target"]), endpoints: Object.keys(object(object(mark.value["content_time"])["range"])) };
    });
  }
  async #catalog(): Promise<RecordCatalog> { return withRecordSnapshot(this.#root, () => readRecordCatalog(this.#root)); }
  #referenceObject(current: Snapshot, id: string, occurrences?: JsonValue, count?: JsonValue): JsonObject {
    const record = current.times.nodes.find(n => n.value["node_id"] === id);
    if (!record) return { node: remember(this.#nodes, "tn", { id, hash: "missing" }, RECORD_TIME_ENGINE_LIMITS.nodes), display: { name: (current.library["settings"] as JsonObject)["language"] === "en" ? "Missing node" : "已缺失的节点", kind: "missing" }, ...(occurrences ? { occurrences: structuredClone(occurrences) } : {}), ...(count !== undefined ? { count } : {}) };
    const row = this.#row(record);
    return { node: row["node"]!, display: { name: row["name"]!, kind: row["kind"]!, ...(row["count"] ? { count: row["count"]! } : {}) }, ...(occurrences ? { occurrences: structuredClone(occurrences) } : {}), ...(count !== undefined ? { count } : {}) };
  }
  #parseDraft(raw: JsonObject, current: Snapshot, existing: JsonObject | undefined, timestamp: string, refreshAnchors = false): Draft {
    const draft = exact(raw, ["metadata", "children", "counterparts", "mappings"], ["restore_default_time"]), metadata = object(draft["metadata"]), kind = metadata["kind"];
    if (!["timeline", "single", "periodic"].includes(String(kind))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid time node kind");
    exact(metadata, kind === "timeline" ? ["kind", "name", "author", "standard_name", "version"] : kind === "periodic" ? ["kind", "name", "count", "prefix", "unit", "display_empty"] : ["kind", "name"]);
    const fields = structuredClone(metadata);
    // Remove no-longer-applicable optional period fields without inventing a new timeline identity.
    if (existing?.["kind"] === "periodic" && kind !== "periodic") for (const key of ["count", "prefix", "unit", "display_empty"]) fields[key] = null;
    const nodeRef = (raw: JsonValue, allowed: readonly string[]) => { const ref = exact(raw, ["node"], [...allowed, "display"]); return { ref, id: this.#node(ref["node"], current, Boolean(existing)).id }; };
    const children = bounded(draft["children"]).map(raw => { const { ref, id } = nodeRef(raw, ["count"]); return { node: id, ...(ref["count"] !== undefined ? { count: ref["count"]! } : {}) }; });
    if (children.length || existing?.["contains"] !== undefined) fields["contains"] = children;
    const counterparts = bounded(draft["counterparts"]).map(raw => {
      const relation = exact(raw, ["target"], ["self_occurrences"]), { ref, id } = nodeRef(relation["target"]!, ["occurrences"]);
      return { target: { node: id, ...(ref["occurrences"] ? { occurrences: structuredClone(ref["occurrences"]!) } : {}) }, ...(kind === "periodic" ? { occurrences: relation["self_occurrences"] ?? { all: true } } : relation["self_occurrences"] ? { occurrences: relation["self_occurrences"] } : {}) };
    });
    const prior = array(existing?.["terran_mappings"]), anchor = localRecordAnchor();
    const mappings = bounded(draft["mappings"]).map(raw => {
      const entry = exact(raw, ["range"], ["occurrences"]); if (!isJsonObject(entry["range"])) throw new EngineCommandError("CLOUDIG_TIME_RANGE_INVALID", "Invalid mapping range");
      const normalized: JsonObject = { range: normalizeRange(entry["range"]), ...(kind === "periodic" ? { occurrences: entry["occurrences"] ?? { all: true } } : entry["occurrences"] ? { occurrences: entry["occurrences"] } : {}) };
      const old = prior.find(p => canonicalizeJcs({ range: p["range"]!, ...(p["occurrences"] ? { occurrences: p["occurrences"] } : {}) }) === canonicalizeJcs(normalized));
      if (old && !refreshAnchors) return structuredClone(old);
      const range = refreshRangeAnchors(normalized["range"] as JsonObject, anchor);
      if (old && canonicalizeJcs(range) === canonicalizeJcs(old["range"]!)) return structuredClone(old);
      return { ...normalized, range, edited_at: timestamp };
    });
    if (draft["restore_default_time"] !== undefined && typeof draft["restore_default_time"] !== "boolean") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid default time choice");
    if (draft["restore_default_time"]) {
      if (!existing) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Only an existing built-in time can be restored");
      const value = builtinTimeNode(String(existing["node_id"]), { timestamp, anchor }); if (!value["terran_mappings"]) throw new TypeError("This built-in axis has no numeric default"); fields["terran_mappings"] = value["terran_mappings"]!;
    } else if (mappings.length || existing?.["terran_mappings"] !== undefined) fields["terran_mappings"] = mappings;
    return { fields, counterparts };
  }
  #validateCreation(parsed: Draft, current: Snapshot, timestamp: string): void {
    const fields: JsonObject = Object.fromEntries(Object.entries(parsed.fields).filter(([, value]) => value !== null));
    const value = { ...fields, schema: "cloudig/content-time/1.0.0", node_id: uuidV7(), edited_at: timestamp, ...(fields["kind"] === "timeline" ? { created_at: timestamp } : {}), ...(parsed.counterparts.length ? { counterparts: parsed.counterparts } : {}) };
    const valid = validateRecord("contentTime", value); if (!valid.ok) throw new TypeError(`Invalid time fields: ${valid.issues.map(i => i.path).join(",")}`);
    const graph = new RecordTimeGraph([...current.times.graph.nodes.values(), value]); if (graph.issues.some(i => i.path.startsWith(`/${value.node_id}/`))) throw new TypeError("New time relationships point to missing nodes");
  }
  #chosen(payload: JsonObject): { strategy: string; chosen: Reference[] } {
    const strategy = String(payload["strategy"]), chosen = bounded(payload["selected_references"]).map(r => known(this.#references, r, "reference"));
    if (!["in_place", "all_references", "selected_references", "future_only"].includes(strategy) || new Set(chosen.map(r => r.id)).size !== chosen.length || strategy !== "selected_references" && chosen.length) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid synchronization selection");
    return { strategy, chosen };
  }
  async #prepareChoice(plan: EditPreview, strategy: string, chosen: readonly Reference[], signal: AbortSignal): Promise<RecordTimeSavePlan> {
    if (!plan.node || !plan.baseline) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "A new node has no old references");
    if (strategy === "in_place" && plan.baseline.result.affected.length) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Choose how existing references are synchronized");
    const current = await this.#snapshot(), timestamp = new Date().toISOString(), parsed = this.#parseDraft(plan.draft, current, current.times.graph.nodes.get(plan.node), timestamp, plan.force);
    const synchronize = strategy === "all_references" || strategy === "in_place" ? "all" as const : strategy === "selected_references" ? new Set(chosen.map(r => r.id)) : new Set<string>();
    const prepared = await prepareRecordTimeEditorSave(this.#root, { node: plan.node, patch: parsed.fields, counterparts: parsed.counterparts, timestamp, synchronize, cancelMarks: plan.cancel, forceEditedAt: plan.force, signal });
    if (planWitness(prepared) !== planWitness(plan.baseline)) throw new EngineCommandError("CLOUDIG_TIME_PLAN_STALE", "Time or Mark files changed after preview; review the new impact");
    for (const ref of chosen) if (![...prepared.reads, ...prepared.changes].some(r => r.path === `Marks/${ref.id}.json` && r.expected === ref.hash)) throw new EngineCommandError("CLOUDIG_TIME_REFERENCE_STALE", "Selected reference changed");
    return prepared;
  }
  async projectDraftRange(value: JsonObject): Promise<JsonObject> {
    const valid = validateRecordRange(value); if (!valid.ok) throw new TypeError("Stored content time range is invalid");
    const result = structuredClone(value);
    for (const key of ["start", "end"]) if (isJsonObject(result[key]) && result[key]["kind"] === "node") result[key] = this.#register(result[key]);
    return result;
  }
  async resolveDraftRange(value: JsonObject): Promise<JsonObject> {
    exact(value, ["start"], ["end"]); const result = structuredClone(value); let current: Snapshot | undefined;
    if (Object.values(result).some(v => isJsonObject(v) && v["kind"] === "node")) throw new EngineCommandError("CLOUDIG_TIME_ENDPOINT_STALE", "Select a node through the current time picker");
    for (const key of ["start", "end"]) if (isJsonObject(result[key]) && result[key]["kind"] === "sovereign") {
      const entry = exact(result[key], ["kind", "selection"], ["display"]), endpoint = known(this.#endpoints, entry["selection"], "endpoint");
      if (endpoint.graph) { current ??= await this.#snapshot(); if (current.revision !== endpoint.graph) throw new EngineCommandError("CLOUDIG_TIME_ENDPOINT_STALE", "Time mapping changed; select the endpoint again"); }
      result[key] = structuredClone(endpoint.value);
    }
    const normalized = normalizeRange(result), valid = validateRecordRange(normalized);
    if (!valid.ok) throw new EngineCommandError("CLOUDIG_TIME_RANGE_INVALID", `Invalid time range: ${valid.issues.map(i => i.code).join(",")}`); return normalized;
  }
  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    const handlers: Record<string, EngineCommandHandler> = {
      "time.editor.query": async payload => {
        exact(payload, ["route", "node"]); known(this.#routes, payload["route"], "route"); const current = await this.#snapshot(), selected = this.#node(payload["node"], current), value = current.times.graph.nodes.get(selected.id)!;
        const metadata: JsonObject = { kind: value["kind"]!, name: value["name"]! };
        if (value["kind"] === "timeline") Object.assign(metadata, { author: value["author"], standard_name: value["standard_name"] ?? null, version: value["version"] ?? null });
        if (value["kind"] === "periodic") Object.assign(metadata, { count: value["count"], prefix: value["prefix"] ?? null, unit: value["unit"] ?? null, display_empty: value["display_empty"] ?? false });
        const catalog = await this.#catalog(), referencing = new Set(catalog.marks.filter(m => Object.values(object(object(m.value["content_time"])["range"])).some(e => isJsonObject(e) && e["kind"] === "node" && [object(e["target"])["node"], object(e["target"])["timeline"]].includes(selected.id))).map(m => String(m.value["mark_id"])));
        return { node: payload["node"]!, time_revision: current.revision, library_revision: current.libraryHash, node_revision: selected.hash, metadata, edited_at: value["edited_at"]!, anchor: { ...localRecordAnchor() },
          ...(value["created_at"] ? { created_at: value["created_at"]! } : {}), builtin: builtinTimeIds.has(selected.id), can_restore: builtinTimeIds.has(selected.id) && value["kind"] !== "timeline",
          children: array(value["contains"]).map(c => this.#referenceObject(current, String(c["node"]), undefined, c["count"])),
          counterparts: current.times.graph.directCounterparts(selected.id).map(c => ({ target: this.#referenceObject(current, c.node, c.occurrences), ...(c.sourceOccurrences ? { self_occurrences: c.sourceOccurrences } : {}) })),
          mappings: array(value["terran_mappings"]).map(m => ({ range: structuredClone(m["range"]!), ...(m["occurrences"] ? { occurrences: m["occurrences"]! } : {}) })), references: this.#referenceRows(catalog, referencing) };
      },
      "time.editor.preview": async (payload, context) => {
        exact(payload, ["route", "action", "draft"], ["node", "expected_time_revision", "expected_library_revision", "expected_node_revision", "cancel_references", "refresh_anchors"]); known(this.#routes, payload["route"], "route");
        const action = String(payload["action"]); if (!["edit", "create_timeline", "create_time"].includes(action) || !isJsonObject(payload["draft"]) || payload["refresh_anchors"] !== undefined && typeof payload["refresh_anchors"] !== "boolean") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid time editor action");
        if ((action === "edit") !== (payload["node"] !== undefined)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "An edit requires one existing node; creation does not");
        const current = await this.#snapshot(), selected = action === "edit" ? this.#node(payload["node"], current) : undefined;
        if (selected && payload["expected_node_revision"] !== undefined && payload["expected_node_revision"] !== selected.hash) throw new EngineCommandError("CLOUDIG_TIME_NODE_STALE", "The edited node changed");
        const timestamp = new Date().toISOString(), existing = selected ? current.times.graph.nodes.get(selected.id) : undefined, parsed = this.#parseDraft(payload["draft"], current, existing, timestamp, payload["refresh_anchors"] === true);
        if (action === "create_timeline" && parsed.fields["kind"] !== "timeline" || action === "create_time" && parsed.fields["kind"] === "timeline") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Creation action and node kind disagree");
        const catalog = await this.#catalog(), cancelled = bounded(payload["cancel_references"] ?? []).map(r => known(this.#references, r, "reference"));
        if (cancelled.some(r => catalog.marks.find(m => m.value["mark_id"] === r.id)?.sha256 !== r.hash)) throw new EngineCommandError("CLOUDIG_TIME_REFERENCE_STALE", "A selected reference changed; reopen the editor");
        const cancel = new Set(cancelled.map(r => r.id)); if (cancel.size !== cancelled.length || !selected && cancel.size) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid cancelled references");
        let baseline: RecordTimeSavePlan | undefined;
        if (selected) {
          const input = { node: selected.id, patch: parsed.fields, counterparts: parsed.counterparts, timestamp, cancelMarks: cancel, forceEditedAt: payload["refresh_anchors"] === true, signal: context.signal };
          try { baseline = await prepareRecordTimeEditorSave(this.#root, { ...input, synchronize: "all" }); }
          catch (error) { if (!(error instanceof TypeError) || context.signal.aborted) throw error; baseline = await prepareRecordTimeEditorSave(this.#root, { ...input, synchronize: new Set() }); }
        }
        else this.#validateCreation(parsed, current, timestamp);
        if (baseline) {
          const proof = new Map([...baseline.reads, ...baseline.changes].map(r => [r.path, r.expected]));
          if (current.times.nodes.some(n => proof.get(n.path) !== n.sha256) || cancelled.some(r => proof.get(`Marks/${r.id}.json`) !== r.hash)) throw new EngineCommandError("CLOUDIG_TIME_PLAN_STALE", "Time or references changed during preview");
        }
        const preview: EditPreview = { ...(selected ? { node: selected.id } : {}), draft: structuredClone(payload["draft"]), cancel, ...(baseline ? { baseline } : {}), force: payload["refresh_anchors"] === true };
        const plan = remember(this.#plans, "tp", preview, RECORD_TIME_ENGINE_LIMITS.plans), affected = new Set(baseline?.result.affected ?? []);
        return { plan, no_change: baseline?.result.unchanged ?? false, can_commit: true, cancelled_references: cancelled.map(r => this.#reference(catalog.marks.find(m => m.value["mark_id"] === r.id)!)),
          impact: { affected_references: this.#referenceRows(catalog, affected), external_links: [], invalid_selectors: [], strategies: affected.size ? ["all_references", "selected_references", "future_only"] : baseline?.result.nodes.length && !preview.force ? ["in_place", "future_only"] : ["in_place"] } };
      },
      "time.editor.selection.preview": async (payload, context) => {
        exact(payload, ["plan", "strategy", "selected_references"], ["offset", "limit"]);
        const plan = known(this.#plans, payload["plan"], "plan"), { strategy, chosen } = this.#chosen(payload), key = choiceKey(strategy, chosen);
        const offset = payload["offset"] ?? 0, limit = payload["limit"] ?? RECORD_TIME_ENGINE_LIMITS.queryPage;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > RECORD_TIME_ENGINE_LIMITS.queryPage) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid change preview page");
        if (!plan.choice || plan.choice.key !== key) plan.choice = { key, prepared: await this.#prepareChoice(plan, strategy, chosen, context.signal) };
        const prepared = plan.choice.prepared, copyIds = new Set(prepared.result.copies.values()), copies = prepared.result.nodes.filter(n => copyIds.has(String(n["node_id"])));
        const catalog = await this.#catalog(), references = this.#referenceRows(catalog, new Set(prepared.result.marks.map(m => String(m["mark_id"]))));
        return { plan: payload["plan"]!, copy_count: copies.length, updated_count: references.length, cancelled_count: plan.cancel.size, offset, limit,
          copies: copies.slice(offset, offset + limit).map(n => ({ name: n["name"]!, kind: n["kind"]! })), references: references.slice(offset, offset + limit).map(r => ({ title: r["title"]! })) };
      },
      "time.editor.commit": async (payload, context) => {
        exact(payload, ["plan", "strategy", "selected_references"], ["touch_on_noop"]); const plan = known(this.#plans, payload["plan"], "plan"), strategy = payload["strategy"];
        if (!["in_place", "all_references", "selected_references", "future_only"].includes(String(strategy)) || payload["touch_on_noop"] !== undefined && payload["touch_on_noop"] !== false) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Preview an explicit anchor/timestamp update before committing it");
        const { chosen } = this.#chosen(payload);
        let node: string, warnings: readonly string[] = [];
        if (!plan.node) {
          if (strategy !== "in_place") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "A new independent node has no existing references to synchronize");
          const committedAt = new Date().toISOString(), commitSnapshot = await this.#snapshot(), parsed = this.#parseDraft(plan.draft, commitSnapshot, undefined, committedAt);
          this.#validateCreation(parsed, commitSnapshot, committedAt);
          const fields: JsonObject = { ...Object.fromEntries(Object.entries(parsed.fields).filter(([, v]) => v !== null)), ...(parsed.counterparts.length ? { counterparts: parsed.counterparts } : {}) };
          context.signal.throwIfAborted(); const result = await createRecordTime(this.#root, { fields, timestamp: committedAt, signal: context.signal }); node = String(result.node["node_id"]); warnings = result.maintenanceWarnings;
        } else {
          const prepared = await this.#prepareChoice(plan, String(strategy), chosen, context.signal);
          if (prepared.result.copies.size && (!plan.choice || plan.choice.key !== choiceKey(String(strategy), chosen) || JSON.stringify([...plan.choice.prepared.result.copies.keys()].sort()) !== JSON.stringify([...prepared.result.copies.keys()].sort()))) throw new EngineCommandError("CLOUDIG_TIME_PLAN_STALE", "Review the actual independent-copy scope before saving");
          const saved = await commitRecordTimeSave(this.#root, prepared, context.signal); warnings = saved?.maintenanceWarnings ?? []; node = prepared.result.copies.get(plan.node) ?? plan.node;
        }
        this.#plans.clear(); const current = await this.#snapshot(), value = current.times.nodes.find(n => n.value["node_id"] === node)!;
        return { status: "updated", node: this.#nodeToken(value), time_revision: current.revision, library_revision: current.libraryHash, edited_at: value.value["edited_at"]!, ...(warnings.length ? { maintenance_warnings: [...warnings] } : {}) };
      },
      "time.delete.preview": async (payload, context) => {
        exact(payload, ["route", "node"], ["expected_time_revision", "expected_library_revision", "expected_node_revision"]); known(this.#routes, payload["route"], "route");
        const current = await this.#snapshot(), selected = this.#node(payload["node"], current);
        if (payload["expected_node_revision"] !== undefined && payload["expected_node_revision"] !== selected.hash) throw new EngineCommandError("CLOUDIG_TIME_NODE_STALE", "The selected node changed");
        const plan = await prepareRecordTimeDelete(this.#root, { nodes: [selected.id], links: "remove", timestamp: new Date().toISOString(), signal: context.signal });
        const proof = new Map([...plan.reads, ...plan.changes].map(r => [r.path, r.expected]));
        if (current.times.nodes.some(n => proof.get(n.path) !== n.sha256)) throw new EngineCommandError("CLOUDIG_TIME_PLAN_STALE", "Time relationships changed while preparing deletion");
        const catalog = await this.#catalog(), value = current.times.graph.nodes.get(selected.id)!, display = (id: string): JsonObject => ({ display: { name: current.times.graph.nodes.get(id)?.["name"] ?? id } });
        return { plan: remember(this.#deletes, "td", plan, RECORD_TIME_ENGINE_LIMITS.plans), impact: { target: display(selected.id), deleted_nodes: [display(selected.id)],
          parents: current.times.nodes.flatMap(n => array(n.value["contains"]).filter(c => c["node"] === selected.id).map(() => ({ parent: display(String(n.value["node_id"])), child: display(selected.id) }))),
          children: array(value["contains"]).map(c => ({ parent: display(selected.id), child: display(String(c["node"])) })), internal_contains: [],
          counterparts: current.times.graph.directCounterparts(selected.id).map(c => ({ left: display(selected.id), right: display(c.node) })), mappings: array(value["terran_mappings"]).map(m => ({ target: display(selected.id), range: m["range"]! })),
          affected_references: this.#referenceRows(catalog, new Set(plan.retainedMarks)), snapshots_preserved: true } };
      },
      "time.delete.commit": async (payload, context) => {
        exact(payload, ["plan"]); const plan = known(this.#deletes, payload["plan"], "delete_plan");
        const result = await commitRecordTimeDelete(this.#root, plan, context.signal); this.#deletes.clear(); this.#plans.clear(); const current = await this.#snapshot();
        return { status: "updated", deleted_count: plan.nodes.length, time_revision: current.revision, library_revision: current.libraryHash, ...(result?.maintenanceWarnings.length ? { maintenance_warnings: [...result.maintenanceWarnings] } : {}) };
      },
      "time.cover.query": async payload => {
        exact(payload, ["return_to"], ["focus_archive"]);
        if (!["reader-cover", "archiver", "conversation-info"].includes(String(payload["return_to"])) || payload["focus_archive"] !== undefined && (typeof payload["focus_archive"] !== "string" || !/^a_[A-Za-z0-9_-]{43}$/u.test(payload["focus_archive"]))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid time return route");
        const current = await this.#snapshot(), route = remember(this.#routes, "tr", { returnTo: String(payload["return_to"]), ...(typeof payload["focus_archive"] === "string" ? { focus: payload["focus_archive"] } : {}) }, RECORD_TIME_ENGINE_LIMITS.routes);
        const root = current.times.nodes.find(n => n.value["node_id"] === rootId); if (!root) throw new EngineCommandError("CLOUDIG_TIME_NODE_STALE", "The built-in Terran timeline is missing");
        const byId = new Map(current.times.nodes.map(n => [String(n.value["node_id"]), n])), items = this.#roots(current);
        return { route, revision: current.revision, library_revision: current.libraryHash, edited_at: current.times.order.value["edited_at"]!, issues: current.times.issues.map(i => ({ ...i })),
          terran: { name: root.value["name"]!, version: root.value["version"] ?? "1.0", root: this.#row(root), items: presets.nodes.slice(1).flatMap(n => byId.has(n.node_id) ? [this.#row(byId.get(n.node_id)!, rootId)] : []) }, sovereign: { items, total: items.length } };
      },
      "time.route.resolve": async payload => { exact(payload, ["route"]); const route = known(this.#routes, payload["route"], "route"); return { return_to: route.returnTo, ...(route.focus ? { focus_archive: route.focus } : {}) }; },
      "time.nodes.children": async payload => {
        exact(payload, ["route", "node"]); known(this.#routes, payload["route"], "route"); const current = await this.#snapshot(), selected = this.#node(payload["node"], current), parent = current.times.graph.nodes.get(selected.id)!;
        const axis = selected.axis ?? (parent["kind"] === "timeline" ? selected.id : undefined), byId = new Map(current.times.nodes.map(n => [String(n.value["node_id"]), n]));
        const items = (parent["contains"] as JsonObject[] ?? []).flatMap(link => {
          const child = byId.get(String(link["node"])); return child ? [{ ...this.#row(child, axis), ...(link["count"] !== undefined ? { included_count: link["count"]! } : {}) }] : [];
        });
        return { revision: current.revision, parent: payload["node"]!, items };
      },
      "time.sovereign.query": async payload => {
        exact(payload, ["route", "offset", "limit"], ["search", "sort", "top_level"]); known(this.#routes, payload["route"], "route");
        const offset = payload["offset"], limit = payload["limit"], search = payload["search"] ?? "", sort = payload["sort"] ?? "edited_desc";
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > RECORD_TIME_ENGINE_LIMITS.queryPage || typeof search !== "string" || !["edited_desc", "edited_asc", "title"].includes(String(sort)) || payload["top_level"] !== undefined && typeof payload["top_level"] !== "boolean") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid time query bounds");
        const current = await this.#snapshot(), needle = search.normalize("NFKC").toLocaleLowerCase("und");
        const roots = payload["top_level"] ? new Set(current.times.graph.roots(current.times.order.value["nodes"] as string[])) : undefined;
        const all = current.times.nodes.filter(n => !builtinTimeIds.has(String(n.value["node_id"])) && (!roots || roots.has(String(n.value["node_id"]))) && String(n.value["name"]).normalize("NFKC").toLocaleLowerCase("und").includes(needle));
        all.sort((a, b) => sort === "title" ? String(a.value["name"]).localeCompare(String(b.value["name"]), "und") : (Date.parse(String(a.value["edited_at"])) - Date.parse(String(b.value["edited_at"]))) * (sort === "edited_asc" ? 1 : -1) || a.path.localeCompare(b.path, "en"));
        return { revision: current.revision, offset, limit, total: all.length, items: all.slice(offset, offset + limit).map(n => this.#row(n)) };
      },
      "time.order.commit": async payload => {
        exact(payload, ["route", "expected_time_revision", "expected_library_revision", "nodes"]); known(this.#routes, payload["route"], "route");
        const current = await this.#snapshot(); if (current.revision !== payload["expected_time_revision"] || current.libraryHash !== payload["expected_library_revision"]) throw new EngineCommandError("CLOUDIG_TIME_ORDER_STALE", "Time list changed; refresh before sorting");
        if (!Array.isArray(payload["nodes"])) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Time order needs a node list");
        const ids = payload["nodes"].map(n => this.#node(n, current).id), currentIds = this.#roots(current).map(r => this.#node(r["node"], current).id);
        if (new Set(ids).size !== ids.length || ids.length !== currentIds.length || ids.some(id => !currentIds.includes(id))) throw new EngineCommandError("CLOUDIG_TIME_ORDER_STALE", "Time ordering must preserve every displayed top-level node");
        const before = current.times.order.value["nodes"] as string[], first = before.findIndex(id => !builtinTimeIds.has(id)), fixed = before.filter(id => builtinTimeIds.has(id)), order = [...fixed]; order.splice(first < 0 ? order.length : Math.min(first, order.length), 0, ...ids);
        await reorderRecordTimes(this.#root, { nodes: order, expected: current.times.order.sha256, timestamp: new Date().toISOString() });
        const after = await this.#snapshot(); return { status: "updated", revision: after.revision, library_revision: after.libraryHash, items: this.#roots(after) };
      },
      "time.endpoint.preview": async (payload, context) => {
        exact(payload, ["route", "node"], ["occurrences"]); known(this.#routes, payload["route"], "route"); const current = await this.#snapshot(), selected = this.#node(payload["node"], current);
        if (payload["occurrences"] !== undefined && !isJsonObject(payload["occurrences"])) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid occurrence selection");
        const endpoint = await current.times.graph.snapshot({ node: selected.id, ...(selected.axis ? { timeline: selected.axis } : {}), ...(isJsonObject(payload["occurrences"]) ? { occurrences: payload["occurrences"] } : {}) }, { signal: context.signal });
        return { revision: current.revision, node: payload["node"]!, endpoint: this.#register(endpoint, current.revision) };
      },
      "time.range.preview": async payload => {
        exact(payload, ["range", "allow_sovereign"], ["language"]);
        if (!isJsonObject(payload["range"]) || typeof payload["allow_sovereign"] !== "boolean" || payload["language"] !== undefined && !["zh-CN", "en"].includes(String(payload["language"]))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid time range preview");
        const range = await this.resolveDraftRange(payload["range"]);
        if (!payload["allow_sovereign"] && Object.values(range).some(e => isJsonObject(e) && e["kind"] === "node")) throw new EngineCommandError("CLOUDIG_TIME_RANGE_INVALID", "Terran mappings only contain direct Terran values");
        return { range: await this.projectDraftRange(range), summary: formatRecordTimeRange(range, payload["language"] === "en" ? "en" : "zh-CN"), direction: recordTimeRangeDirection(range) };
      }
    };
    return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (...args: Parameters<EngineCommandHandler>) => {
      try { return await handler(...args); } catch (error) {
        if (error instanceof EngineCommandError || error instanceof RecordSchemaError || error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof RecordStoreConflict) throw new EngineCommandError(error.operationId ? "CLOUDIG_TIME_RECOVERY_REQUIRED" : "CLOUDIG_TIME_PLAN_STALE", error.message);
        if (error instanceof TypeError) throw new EngineCommandError("CLOUDIG_TIME_EDITOR_INVALID", error.message);
        throw error;
      }
    }]));
  }
  close(): void { this.#routes.clear(); this.#nodes.clear(); this.#endpoints.clear(); this.#references.clear(); this.#plans.clear(); this.#deletes.clear(); }
}
