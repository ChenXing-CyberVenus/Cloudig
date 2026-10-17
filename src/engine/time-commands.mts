import { randomBytes } from "node:crypto";

import {
  commitTimeDeletePlan,
  commitTimeEditPlan,
  commitTimeDisplayOrder,
  prepareTimeDeletePlan,
  prepareTimeEditPlan,
  queryTimeEditorContext,
  type TimeDeletePlan,
  type TimeEditPlan,
  type TimeNodeDraft,
  type TimeNodeMetadata
} from "../adapters/library-data/time-state.mts";
import { readCurrentAuthorityPair } from "../adapters/storage/recovery-point.mts";
import terranPreset from "../core/contracts/machine/terran-preset.json" with { type: "json" };
import { validateTimeValue } from "../core/contracts/index.mts";
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { buildSovereignSnapshot, formatRange, normalizeRange, orderedTimeVariants, rangeDirection } from "../core/time/index.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";
import { engineTransactionId } from "./transaction.mts";

const ROUTE_CAPABILITY = /^tr_[A-Za-z0-9_-]{43}$/u;
const NODE_CAPABILITY = /^tn_[A-Za-z0-9_-]{43}$/u;
const ARCHIVE_CAPABILITY = /^a_[A-Za-z0-9_-]{43}$/u;
const PLAN_CAPABILITY = /^tp_[A-Za-z0-9_-]{43}$/u;
const DELETE_PLAN_CAPABILITY = /^td_[A-Za-z0-9_-]{43}$/u;
const REFERENCE_CAPABILITY = /^ta_[A-Za-z0-9_-]{43}$/u;
const ENDPOINT_CAPABILITY = /^te_[A-Za-z0-9_-]{43}$/u;

type ReturnTarget = "reader-cover" | "archiver" | "conversation-info";
type RouteState = Readonly<{ returnTo: ReturnTarget; focusArchive?: string }>;
type NodeKind = "preset" | "variant" | "time";
type NodeState = Readonly<{ kind: NodeKind; id: string; revision: number }>;

export type TimeEngineCommandsOptions = Readonly<{
  libraryRoot: string;
  routeToken?: () => string;
  nodeToken?: () => string;
  planToken?: () => string;
  deletePlanToken?: () => string;
  referenceToken?: () => string;
  endpointToken?: () => string;
  transaction?: () => string;
  clock?: () => string;
  anchor?: () => Readonly<{ date: string; offset: string }>;
}>;

function fail(message: string): never {
  throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", message);
}

function exactObject(value: JsonValue | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!isJsonObject(value)) fail("Command payload object is invalid");
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail("Command payload fields are invalid");
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  return value;
}

function object(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function localAnchor(): Readonly<{ date: string; offset: string }> {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const minutes = -now.getTimezoneOffset();
  if (minutes === 0) return { date, offset: "Z" };
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return { date, offset: `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}` };
}

function boundedArray(value: JsonValue | undefined, label: string, maximum = 10_000): JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} is invalid`);
  return value;
}

function nullableString(value: JsonValue | undefined, label: string): string | null {
  if (value !== null && typeof value !== "string") fail(`${label} is invalid`);
  return value;
}

function presetNodes(): JsonObject[] {
  return terranPreset.nodes as JsonObject[];
}

function nodeKey(value: NodeState): string {
  return `${value.kind}:${value.id}:${value.revision}`;
}

export class TimeEngineCommands {
  readonly #libraryRoot: string;
  readonly #routeToken: () => string;
  readonly #nodeToken: () => string;
  readonly #planToken: () => string;
  readonly #deletePlanToken: () => string;
  readonly #referenceToken: () => string;
  readonly #endpointToken: () => string;
  readonly #transaction: () => string;
  readonly #clock: () => string;
  readonly #anchor: () => Readonly<{ date: string; offset: string }>;
  #routes = new Map<string, RouteState>();
  #nodes = new Map<string, NodeState>();
  #nodeKeys = new Map<string, string>();
  #plans = new Map<string, TimeEditPlan>();
  #deletePlans = new Map<string, TimeDeletePlan>();
  #references = new Map<string, string>();
  #referenceKeys = new Map<string, string>();
  #endpoints = new Map<string, Readonly<{ revision: number; endpoint: JsonObject }>>();

  constructor(options: TimeEngineCommandsOptions) {
    this.#libraryRoot = options.libraryRoot;
    this.#routeToken = options.routeToken ?? (() => `tr_${randomBytes(32).toString("base64url")}`);
    this.#nodeToken = options.nodeToken ?? (() => `tn_${randomBytes(32).toString("base64url")}`);
    this.#planToken = options.planToken ?? (() => `tp_${randomBytes(32).toString("base64url")}`);
    this.#deletePlanToken = options.deletePlanToken ?? (() => `td_${randomBytes(32).toString("base64url")}`);
    this.#referenceToken = options.referenceToken ?? (() => `ta_${randomBytes(32).toString("base64url")}`);
    this.#endpointToken = options.endpointToken ?? (() => `te_${randomBytes(32).toString("base64url")}`);
    this.#transaction = options.transaction ?? engineTransactionId;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#anchor = options.anchor ?? localAnchor;
  }

  #route(value: JsonValue | undefined): RouteState {
    if (typeof value !== "string" || !ROUTE_CAPABILITY.test(value)) fail("Time route capability is invalid");
    const route = this.#routes.get(value);
    if (!route) throw new EngineCommandError("CLOUDIG_TIME_ROUTE_STALE", "Time route is stale; reopen Content Time");
    return route;
  }

  #node(value: JsonValue | undefined): NodeState {
    if (typeof value !== "string" || !NODE_CAPABILITY.test(value)) fail("Time node capability is invalid");
    const node = this.#nodes.get(value);
    if (!node) throw new EngineCommandError("CLOUDIG_TIME_NODE_STALE", "Time node is stale; refresh Content Time");
    return node;
  }

  #plan(value: JsonValue | undefined): TimeEditPlan {
    if (typeof value !== "string" || !PLAN_CAPABILITY.test(value)) fail("Time edit plan capability is invalid");
    const plan = this.#plans.get(value);
    if (!plan) throw new EngineCommandError("CLOUDIG_TIME_PLAN_STALE", "Time edit plan is stale; preview again");
    return plan;
  }

  #deletePlan(value: JsonValue | undefined): TimeDeletePlan {
    if (typeof value !== "string" || !DELETE_PLAN_CAPABILITY.test(value)) fail("Time delete plan capability is invalid");
    const plan = this.#deletePlans.get(value);
    if (!plan) throw new EngineCommandError("CLOUDIG_TIME_DELETE_PLAN_STALE", "Time delete plan is stale; preview again");
    return plan;
  }

  #reference(value: JsonValue | undefined): string {
    if (typeof value !== "string" || !REFERENCE_CAPABILITY.test(value)) fail("Time archive-reference capability is invalid");
    const archive = this.#references.get(value);
    if (!archive) throw new EngineCommandError("CLOUDIG_TIME_REFERENCE_STALE", "Time archive reference is stale; preview again");
    return archive;
  }

  #endpoint(value: JsonValue | undefined): Readonly<{ revision: number; endpoint: JsonObject }> {
    if (typeof value !== "string" || !ENDPOINT_CAPABILITY.test(value)) fail("Time endpoint capability is invalid");
    const endpoint = this.#endpoints.get(value);
    if (!endpoint) throw new EngineCommandError("CLOUDIG_TIME_ENDPOINT_STALE", "Time endpoint selection is stale; select it again");
    return endpoint;
  }

  #referenceTokenFor(archive: string): string {
    let token = this.#referenceKeys.get(archive);
    if (!token) {
      token = this.#referenceToken();
      if (!REFERENCE_CAPABILITY.test(token)) throw new TypeError("Time reference token factory returned an invalid capability");
      this.#referenceKeys.set(archive, token);
      this.#references.set(token, archive);
    }
    return token;
  }

  #tokenForId(id: string): string {
    for (const [token, state] of this.#nodes) if (state.id === id) return token;
    throw new TypeError("Time node has no current capability");
  }

  #projectNodeReference(value: Readonly<{ node: string; occurrences?: JsonObject; display?: Readonly<{ name: string; kind: string; count?: number }> }>): JsonObject {
    return {
      node: this.#tokenForId(value.node),
      ...(value.occurrences ? { occurrences: structuredClone(value.occurrences) } : {}),
      ...(value.display ? { display: { ...value.display } } : {})
    };
  }

  #parseNodeReference(value: JsonValue | undefined, label: string): Readonly<{ node: string; occurrences?: JsonObject }> {
    const reference = exactObject(value, ["node"], ["occurrences", "display"]);
    const state = this.#node(reference["node"]);
    if (reference["occurrences"] !== undefined && !isJsonObject(reference["occurrences"])) fail(`${label} occurrences are invalid`);
    return {
      node: state.id,
      ...(isJsonObject(reference["occurrences"]) ? { occurrences: structuredClone(reference["occurrences"]) } : {})
    };
  }

  #projectMetadata(value: TimeNodeMetadata): JsonObject {
    if (value.kind === "preset") return { kind: "preset", range: value.range === null ? null : structuredClone(value.range) };
    if (value.kind === "timeline") return {
      kind: "timeline",
      name: value.name,
      author: value.author,
      standard_name: value.standardName,
      version: value.version
    };
    if (value.kind === "single") return { kind: "single", name: value.name };
    return {
      kind: "periodic",
      name: value.name,
      count: value.count,
      prefix: value.prefix,
      unit: value.unit,
      display_empty: value.displayEmpty
    };
  }

  #parseMetadata(value: JsonValue | undefined): TimeNodeMetadata {
    if (!isJsonObject(value) || typeof value["kind"] !== "string") fail("Time editor metadata is invalid");
    if (value["kind"] === "preset") {
      exactObject(value, ["kind", "range"]);
      if (value["range"] !== null && !isJsonObject(value["range"])) fail("Terran preset range is invalid");
      return { kind: "preset", range: value["range"] === null ? null : structuredClone(value["range"] as JsonObject) };
    }
    if (value["kind"] === "timeline") {
      exactObject(value, ["kind", "name", "author", "standard_name", "version"]);
      if (typeof value["name"] !== "string" || typeof value["author"] !== "string") fail("Timeline metadata is invalid");
      return {
        kind: "timeline",
        name: value["name"],
        author: value["author"],
        standardName: nullableString(value["standard_name"], "Timeline standard name"),
        version: nullableString(value["version"], "Timeline version")
      };
    }
    if (value["kind"] === "single") {
      exactObject(value, ["kind", "name"]);
      if (typeof value["name"] !== "string") fail("Single time metadata is invalid");
      return { kind: "single", name: value["name"] };
    }
    if (value["kind"] === "periodic") {
      exactObject(value, ["kind", "name", "count", "prefix", "unit", "display_empty"]);
      if (typeof value["name"] !== "string" || typeof value["display_empty"] !== "boolean") fail("Periodic time metadata is invalid");
      return {
        kind: "periodic",
        name: value["name"],
        count: integer(value["count"], "Periodic count"),
        prefix: nullableString(value["prefix"], "Periodic prefix"),
        unit: nullableString(value["unit"], "Periodic unit"),
        displayEmpty: value["display_empty"]
      };
    }
    fail("Time editor metadata kind is invalid");
  }

  #parseDraft(value: JsonValue | undefined): TimeNodeDraft {
    const draft = exactObject(value, ["metadata", "children", "counterparts", "mappings"]);
    const children = boundedArray(draft["children"], "Time children").map((entry) => this.#parseNodeReference(entry, "Time child"));
    const counterparts = boundedArray(draft["counterparts"], "Time counterparts").map((entry) => {
      const counterpart = exactObject(entry, ["target"], ["self_occurrences"]);
      if (counterpart["self_occurrences"] !== undefined && !isJsonObject(counterpart["self_occurrences"])) fail("Time counterpart selector is invalid");
      return {
        target: this.#parseNodeReference(counterpart["target"], "Time counterpart target"),
        ...(isJsonObject(counterpart["self_occurrences"]) ? { selfOccurrences: structuredClone(counterpart["self_occurrences"]) } : {})
      };
    });
    const mappings = boundedArray(draft["mappings"], "Time mappings").map((entry) => {
      const mapping = exactObject(entry, ["range"], ["occurrences"]);
      if (!isJsonObject(mapping["range"])) fail("Time mapping range is invalid");
      if (mapping["occurrences"] !== undefined && !isJsonObject(mapping["occurrences"])) fail("Time mapping selector is invalid");
      return {
        ...(isJsonObject(mapping["occurrences"]) ? { occurrences: structuredClone(mapping["occurrences"]) } : {}),
        range: structuredClone(mapping["range"] as JsonObject)
      };
    });
    return { metadata: this.#parseMetadata(draft["metadata"]), children, counterparts, mappings };
  }

  #projectContext(value: Awaited<ReturnType<typeof queryTimeEditorContext>>): JsonObject {
    return {
      time_revision: value.timeRevision,
      library_revision: value.libraryRevision,
      node_revision: value.nodeRevision,
      node: this.#tokenForId(value.node),
      ...(value.ownerVariant ? { owner: this.#tokenForId(value.ownerVariant) } : {}),
      metadata: this.#projectMetadata(value.metadata),
      ...(value.createdAt ? { created_at: value.createdAt } : {}),
      edited_at: value.editedAt,
      ...(value.variantNumber !== undefined ? { variant_number: value.variantNumber } : {}),
      children: value.children.map((entry) => this.#projectNodeReference(entry)),
      counterparts: value.counterparts.map((entry) => ({
        target: this.#projectNodeReference(entry.target),
        ...(entry.selfOccurrences ? { self_occurrences: structuredClone(entry.selfOccurrences) } : {})
      })),
      mappings: value.mappings.map((entry) => ({
        ...(entry.occurrences ? { occurrences: structuredClone(entry.occurrences) } : {}),
        range: structuredClone(entry.range)
      })),
      references: value.references.map((entry) => ({
        reference: this.#referenceTokenFor(entry.archive),
        title: entry.title,
        endpoints: entry.endpoints.map((endpoint) => endpoint.side)
      }))
    };
  }

  #projectImpact(plan: TimeEditPlan): JsonObject {
    return {
      affected_references: plan.impact.affectedArchives.map((entry) => ({
        reference: this.#referenceTokenFor(entry.archive),
        title: entry.title,
        endpoints: entry.endpoints
      })),
      external_links: plan.impact.externalLinks.map((entry) => ({
        kind: entry.kind,
        external_node: this.#tokenForId(entry.externalNode),
        owned_node: this.#tokenForId(entry.ownedNode)
      })),
      invalid_selectors: plan.impact.invalidSelectors.map((entry) => ({
        kind: entry.kind,
        node: this.#tokenForId(entry.node),
        new_count: entry.newCount
      })),
      strategies: [...plan.impact.strategies]
    };
  }

  #projectDeleteNode(plan: TimeDeletePlan, id: string): JsonObject {
    return { node: this.#tokenForId(id), display: { ...plan.displays[id]! } };
  }

  #projectDeleteImpact(plan: TimeDeletePlan): JsonObject {
    const link = (entry: Readonly<{ parent: string; child: string; occurrences?: JsonObject }>): JsonObject => ({
      parent: this.#projectDeleteNode(plan, entry.parent),
      child: this.#projectDeleteNode(plan, entry.child),
      ...(entry.occurrences ? { occurrences: structuredClone(entry.occurrences) } : {})
    });
    const reference = (value: JsonObject): JsonObject => {
      const id = value["node"];
      if (typeof id !== "string") throw new TypeError("Time delete relation lost its node");
      return {
        ...this.#projectDeleteNode(plan, id),
        ...(isJsonObject(value["occurrences"]) ? { occurrences: structuredClone(value["occurrences"]) } : {})
      };
    };
    return {
      target: this.#projectDeleteNode(plan, plan.node),
      deleted_nodes: plan.impact.deletedNodes.map((id) => this.#projectDeleteNode(plan, id)),
      parents: plan.impact.parents.map(link),
      children: plan.impact.children.map(link),
      internal_contains: plan.impact.internalContains.map(link),
      counterparts: plan.impact.counterparts.map((entry) => ({ left: reference(entry.left), right: reference(entry.right) })),
      mappings: plan.impact.mappings.map((entry) => ({ target: reference(entry.target), range: structuredClone(entry.range) })),
      affected_references: plan.impact.affectedArchives.map((entry) => ({
        reference: this.#referenceTokenFor(entry.archive),
        title: entry.title,
        endpoints: entry.endpoints.map((endpoint) => endpoint.side)
      })),
      current_variant: plan.impact.currentVariant,
      replacement_required: plan.impact.currentVariant && plan.impact.replacementVariants.length > 0,
      replacement_variants: plan.impact.replacementVariants.map((id) => this.#projectDeleteNode(plan, id)),
      clear_references_required: plan.impact.affectedArchives.length > 0
    };
  }

  #refreshNodes(time: JsonObject): void {
    const nextNodes = new Map<string, NodeState>();
    const nextKeys = new Map<string, string>();
    const register = (state: NodeState) => {
      const key = nodeKey(state);
      let token = this.#nodeKeys.get(key);
      if (!token) {
        token = this.#nodeToken();
        if (!NODE_CAPABILITY.test(token)) throw new TypeError("Time node token factory returned an invalid capability");
      }
      nextKeys.set(key, token);
      nextNodes.set(token, state);
    };
    for (const raw of presetNodes()) register({ kind: "preset", id: String(raw["id"]), revision: time["revision"] as number });
    for (const [id, raw] of Object.entries(object(time["variants"]))) {
      if (isJsonObject(raw) && typeof raw["revision"] === "number") register({ kind: "variant", id, revision: raw["revision"] });
    }
    for (const [id, raw] of Object.entries(object(time["times"]))) {
      if (isJsonObject(raw)) register({ kind: "time", id, revision: time["revision"] as number });
    }
    this.#nodes = nextNodes;
    this.#nodeKeys = nextKeys;
  }

  #token(kind: NodeKind, id: string, revision: number): string {
    const token = this.#nodeKeys.get(nodeKey({ kind, id, revision }));
    if (!token) throw new TypeError(`Time node ${kind}:${id} has no capability`);
    return token;
  }

  #presetRow(time: JsonObject, raw: JsonObject): JsonObject {
    const id = String(raw["id"]);
    const values = object(time["terran_values"]);
    const range = isJsonObject(values[id]) ? values[id] : isJsonObject(raw["range"]) ? raw["range"] : undefined;
    return {
      node: this.#token("preset", id, time["revision"] as number),
      kind: raw["kind"]!,
      name: raw["name"]!,
      ...(range ? { range: structuredClone(range) } : {}),
      ...(isJsonObject(raw["endpoint"]) ? { endpoint: structuredClone(raw["endpoint"]!) } : {}),
      builtin: true,
      editable: raw["kind"] === "range"
    };
  }

  #variantRow(time: JsonObject, id: string, raw: JsonObject): JsonObject {
    const lineages = object(time["lineages"]);
    const lineage = typeof raw["lineage"] === "string" ? object(lineages[raw["lineage"]]) : {};
    const times = object(time["times"]);
    const contains = object(time["contains"]);
    const owned = Object.values(times).filter((entry) => isJsonObject(entry) && entry["owner"] === id).length;
    const children = Array.isArray(contains[id]) ? contains[id].length : 0;
    return {
      node: this.#token("variant", id, raw["revision"] as number),
      kind: "timeline",
      name: raw["name"]!,
      author: raw["author"]!,
      number: raw["number"]!,
      revision: raw["revision"]!,
      ...(typeof raw["standard_name"] === "string" ? { standard_name: raw["standard_name"] } : {}),
      ...(typeof raw["version"] === "string" ? { version: raw["version"] } : {}),
      created_at: raw["created_at"]!,
      edited_at: raw["edited_at"]!,
      current: lineage["current"] === id,
      children: Math.max(owned, children),
      builtin: false,
      editable: true
    };
  }

  #timeRow(time: JsonObject, id: string, raw: JsonObject): JsonObject {
    const variants = object(time["variants"]);
    const owner = typeof raw["owner"] === "string" && isJsonObject(variants[raw["owner"]])
      ? variants[raw["owner"]] as JsonObject
      : undefined;
    return {
      node: this.#token("time", id, time["revision"] as number),
      kind: raw["kind"]!,
      name: raw["name"]!,
      ...(owner ? {
        owner: {
          node: this.#token("variant", raw["owner"] as string, owner["revision"] as number),
          name: owner["name"]!
        },
        revision: owner["revision"]!
      } : {}),
      ...(typeof raw["count"] === "number" ? { count: raw["count"] } : {}),
      ...(typeof raw["prefix"] === "string" ? { prefix: raw["prefix"] } : {}),
      ...(typeof raw["unit"] === "string" ? { unit: raw["unit"] } : {}),
      created_at: raw["created_at"]!,
      edited_at: raw["edited_at"]!,
      builtin: false,
      editable: true
    };
  }

  #orderedVariants(time: JsonObject): JsonObject[] {
    const variants = object(time["variants"]);
    return orderedTimeVariants(time).map((id) => this.#variantRow(time, id, variants[id] as JsonObject));
  }

  async #authority(): Promise<Readonly<{ library: JsonObject; time: JsonObject }>> {
    const pair = await readCurrentAuthorityPair(this.#libraryRoot);
    this.#refreshNodes(pair.time);
    return { library: pair.library, time: pair.time };
  }

  #endpointDisplay(endpoint: JsonObject): JsonObject {
    const snapshot = object(endpoint["snapshot"]);
    const timeline = object(snapshot["timeline"]);
    const target = object(snapshot["target"]);
    const display: JsonObject = {
      timeline: {
        name: timeline["name"] ?? "",
        author: timeline["author"] ?? "",
        ...(timeline["number"] !== undefined ? { number: timeline["number"]! } : {}),
        ...(timeline["version"] !== undefined ? { version: timeline["version"]! } : {}),
        ...(timeline["standard_name"] !== undefined ? { standard_name: timeline["standard_name"]! } : {})
      },
      target: {
        kind: target["kind"] ?? "single",
        name: target["name"] ?? "",
        ...(target["count"] !== undefined ? { count: target["count"]! } : {}),
        ...(target["prefix"] !== undefined ? { prefix: target["prefix"]! } : {}),
        ...(target["unit"] !== undefined ? { unit: target["unit"]! } : {})
      }
    };
    if (Array.isArray(snapshot["path"])) display["path"] = structuredClone(snapshot["path"]);
    if (isJsonObject(snapshot["sort"])) display["sort"] = structuredClone(snapshot["sort"]);
    return display;
  }

  #registerEndpoint(endpoint: JsonObject, revision: number): JsonObject {
    const token = this.#endpointToken();
    if (!ENDPOINT_CAPABILITY.test(token)) throw new TypeError("Time endpoint token factory returned an invalid capability");
    this.#endpoints.set(token, { revision, endpoint: structuredClone(endpoint) });
    return { kind: "sovereign", selection: token, display: this.#endpointDisplay(endpoint) };
  }

  async projectDraftRange(value: JsonObject): Promise<JsonObject> {
    const range = exactObject(value, ["start"], ["end"]);
    const { time } = await this.#authority();
    const project = (raw: JsonValue | undefined): JsonValue => {
      if (!isJsonObject(raw) || raw["kind"] !== "sovereign") return structuredClone(raw!);
      if (!isJsonObject(raw["target"]) || !isJsonObject(raw["snapshot"])) throw new TypeError("Stored Sovereign endpoint is invalid");
      return this.#registerEndpoint(raw, time["revision"] as number);
    };
    return {
      start: project(range["start"]),
      ...(range["end"] !== undefined ? { end: project(range["end"]) } : {})
    };
  }

  async resolveDraftRange(value: JsonObject): Promise<JsonObject> {
    const range = exactObject(value, ["start"], ["end"]);
    const { time } = await this.#authority();
    const resolve = (raw: JsonValue | undefined): JsonValue => {
      if (!isJsonObject(raw) || raw["kind"] !== "sovereign") return structuredClone(raw!);
      const boundary = exactObject(raw, ["kind", "selection"], ["display"]);
      const selected = this.#endpoint(boundary["selection"]);
      if (selected.revision !== time["revision"]) throw new EngineCommandError("CLOUDIG_TIME_ENDPOINT_STALE", "Time authority changed; select the Sovereign endpoint again");
      return structuredClone(selected.endpoint);
    };
    return {
      start: resolve(range["start"]),
      ...(range["end"] !== undefined ? { end: resolve(range["end"]) } : {})
    };
  }

  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      "time.cover.query": async (payload) => {
        exactObject(payload, ["return_to"], ["focus_archive"]);
        const returnTo = payload["return_to"];
        if (returnTo !== "reader-cover" && returnTo !== "archiver" && returnTo !== "conversation-info") fail("Time return target is invalid");
        const focusArchive = payload["focus_archive"];
        if (focusArchive !== undefined && (typeof focusArchive !== "string" || !ARCHIVE_CAPABILITY.test(focusArchive))) fail("Time focus archive is invalid");
        const { library, time } = await this.#authority();
        const route = this.#routeToken();
        if (!ROUTE_CAPABILITY.test(route)) throw new TypeError("Time route token factory returned an invalid capability");
        this.#routes.set(route, { returnTo, ...(typeof focusArchive === "string" ? { focusArchive } : {}) });
        const builtins = presetNodes();
        return {
          route,
          revision: time["revision"]!,
          library_revision: library["revision"]!,
          edited_at: time["edited_at"]!,
          terran: {
            name: terranPreset.standard_name,
            version: terranPreset.version,
            root: this.#presetRow(time, builtins[0]!),
            items: builtins.slice(1).map((entry) => this.#presetRow(time, entry))
          },
          sovereign: {
            items: this.#orderedVariants(time),
            total: Object.keys(object(time["variants"])).length
          }
        };
      },
      "time.route.resolve": async (payload) => {
        exactObject(payload, ["route"]);
        const route = this.#route(payload["route"]);
        return { return_to: route.returnTo, ...(route.focusArchive ? { focus_archive: route.focusArchive } : {}) };
      },
      "time.order.commit": async (payload) => {
        exactObject(payload, ["route", "expected_time_revision", "expected_library_revision", "nodes"]);
        this.#route(payload["route"]);
        const expectedTimeRevision = integer(payload["expected_time_revision"], "Expected Time revision");
        const expectedLibraryRevision = integer(payload["expected_library_revision"], "Expected Library revision");
        const current = await this.#authority();
        if (current.time["revision"] !== expectedTimeRevision || current.library["revision"] !== expectedLibraryRevision) throw new EngineCommandError("CLOUDIG_TIME_ORDER_STALE", "The time list changed; cancel sorting and reopen it");
        const order = boundedArray(payload["nodes"], "Timeline order").map(token => {
          const node = this.#node(token);
          if (node.kind !== "variant") fail("Only top-level timelines can be reordered");
          return node.id;
        });
        const result = await commitTimeDisplayOrder({ libraryRoot: this.#libraryRoot, expectedTimeRevision, expectedLibraryRevision, order, timestamp: this.#clock(), transaction: this.#transaction(), recoveryTransaction: this.#transaction() });
        if (result.status === "conflict") throw new EngineCommandError("CLOUDIG_TIME_ORDER_STALE", "The time list changed before sorting was saved");
        const { time, library } = await this.#authority();
        return { status: result.status, revision: time["revision"]!, library_revision: library["revision"]!, items: this.#orderedVariants(time) };
      },
      "time.nodes.children": async (payload) => {
        exactObject(payload, ["route", "node"]);
        this.#route(payload["route"]);
        const { time } = await this.#authority();
        const selected = this.#node(payload["node"]);
        const contains = object(time["contains"]);
        const rawChildren: JsonObject[] = selected.kind === "preset" && selected.id === "p1"
          ? presetNodes().slice(1).map((entry): JsonObject => ({ node: entry["id"]! }))
          : Array.isArray(contains[selected.id]) ? contains[selected.id] as JsonObject[] : [];
        const variants = object(time["variants"]);
        const times = object(time["times"]);
        const presets = new Map(presetNodes().map((entry) => [String(entry["id"]), entry]));
        const items = rawChildren.flatMap((reference): JsonObject[] => {
          const id = typeof reference["node"] === "string" ? reference["node"] : "";
          const preset = presets.get(id);
          if (preset) return [{ ...this.#presetRow(time, preset), ...(reference["occurrences"] ? { occurrences: structuredClone(reference["occurrences"]!) } : {}) }];
          const variant = variants[id];
          if (isJsonObject(variant)) return [{ ...this.#variantRow(time, id, variant), ...(reference["occurrences"] ? { occurrences: structuredClone(reference["occurrences"]!) } : {}) }];
          const timeNode = times[id];
          if (isJsonObject(timeNode)) return [{ ...this.#timeRow(time, id, timeNode), ...(reference["occurrences"] ? { occurrences: structuredClone(reference["occurrences"]!) } : {}) }];
          return [];
        });
        return { revision: time["revision"]!, parent: payload["node"]!, items };
      },
      "time.sovereign.query": async (payload) => {
        exactObject(payload, ["route", "offset", "limit"], ["search", "sort"]);
        this.#route(payload["route"]);
        const offset = integer(payload["offset"], "Sovereign query offset");
        const limit = integer(payload["limit"], "Sovereign query limit");
        if (offset < 0 || limit < 1 || limit > 500) fail("Sovereign query bounds are invalid");
        const search = payload["search"];
        if (search !== undefined && typeof search !== "string") fail("Sovereign search is invalid");
        const sort = payload["sort"] ?? "edited_desc";
        if (!["edited_desc", "edited_asc", "title"].includes(String(sort))) fail("Sovereign sort is invalid");
        const { time } = await this.#authority();
        const variants = object(time["variants"]);
        const times = object(time["times"]);
        const all: JsonObject[] = [
          ...Object.entries(variants).flatMap(([id, raw]) => isJsonObject(raw) ? [this.#variantRow(time, id, raw)] : []),
          ...Object.entries(times).flatMap(([id, raw]) => isJsonObject(raw) ? [this.#timeRow(time, id, raw)] : [])
        ];
        const needle = typeof search === "string" ? search.trim().normalize("NFKC").toLocaleLowerCase("und") : "";
        const filtered = needle ? all.filter((entry) => String(entry["name"]).normalize("NFKC").toLocaleLowerCase("und").includes(needle)) : all;
        filtered.sort((left, right) => sort === "title"
          ? String(left["name"]).localeCompare(String(right["name"]), "und")
          : sort === "edited_asc"
            ? String(left["edited_at"]).localeCompare(String(right["edited_at"]), "en")
            : String(right["edited_at"]).localeCompare(String(left["edited_at"]), "en"));
        return { revision: time["revision"]!, offset, limit, total: filtered.length, items: filtered.slice(offset, offset + limit) };
      },
      "time.endpoint.preview": async (payload) => {
        exactObject(payload, ["route", "node"], ["occurrences"]);
        this.#route(payload["route"]);
        const { time } = await this.#authority();
        const selected = this.#node(payload["node"]);
        if (selected.kind === "preset") fail("Terran presets cannot become Sovereign endpoints");
        if (payload["occurrences"] !== undefined && !isJsonObject(payload["occurrences"])) fail("Sovereign endpoint selector is invalid");
        const target: JsonObject = {
          node: selected.id,
          ...(isJsonObject(payload["occurrences"]) ? { occurrences: structuredClone(payload["occurrences"]) } : {})
        };
        const snapshot = buildSovereignSnapshot(time, target, 100_000);
        if (snapshot.status !== "ok") throw new EngineCommandError("CLOUDIG_TIME_ENDPOINT_INVALID", `Sovereign endpoint cannot be selected: ${snapshot.status}`);
        const endpoint: JsonObject = { kind: "sovereign", target, snapshot: snapshot.snapshot };
        const validation = validateTimeValue({ start: endpoint });
        if (!validation.ok) throw new EngineCommandError("CLOUDIG_TIME_ENDPOINT_INVALID", `Sovereign endpoint selector is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
        return {
          revision: time["revision"]!,
          node: payload["node"]!,
          endpoint: this.#registerEndpoint(endpoint, time["revision"] as number)
        };
      },
      "time.range.preview": async (payload) => {
        exactObject(payload, ["range", "allow_sovereign"], ["language"]);
        if (!isJsonObject(payload["range"]) || typeof payload["allow_sovereign"] !== "boolean") fail("Time range preview payload is invalid");
        const language = payload["language"] === "en" ? "en" : "zh-CN";
        const resolved = normalizeRange(await this.resolveDraftRange(payload["range"]));
        const validation = validateTimeValue(resolved);
        if (!validation.ok) throw new EngineCommandError("CLOUDIG_TIME_RANGE_INVALID", `Time range is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
        if (!payload["allow_sovereign"] && [resolved["start"], resolved["end"]].some((entry) => isJsonObject(entry) && entry["kind"] === "sovereign")) {
          throw new EngineCommandError("CLOUDIG_TIME_RANGE_INVALID", "Terran mappings cannot contain Sovereign endpoints");
        }
        return {
          range: await this.projectDraftRange(resolved),
          summary: formatRange(resolved, language),
          direction: rangeDirection(resolved)
        };
      },
      "time.editor.query": async (payload) => {
        exactObject(payload, ["route", "node"]);
        this.#route(payload["route"]);
        await this.#authority();
        const selected = this.#node(payload["node"]);
        const context = await queryTimeEditorContext(this.#libraryRoot, selected.id);
        const current = await this.#authority();
        if (context.timeRevision !== current.time["revision"]) throw new EngineCommandError("CLOUDIG_TIME_NODE_STALE", "Time authority changed while opening the editor");
        return this.#projectContext(context);
      },
      "time.editor.preview": async (payload) => {
        exactObject(payload, ["route", "action", "expected_time_revision", "expected_library_revision", "expected_node_revision", "draft"], ["node", "owner", "cancel_references"]);
        this.#route(payload["route"]);
        await this.#authority();
        const action = payload["action"];
        if (action !== "edit" && action !== "create_timeline" && action !== "create_time") fail("Time edit action is invalid");
        const node = payload["node"] === undefined ? undefined : this.#node(payload["node"]).id;
        const owner = payload["owner"] === undefined ? undefined : this.#node(payload["owner"]).id;
        if (action === "edit" && (!node || owner)) fail("Time edit requires only a node capability");
        if (action === "create_timeline" && (node || owner)) fail("New timeline cannot carry an existing node");
        if (action === "create_time" && (node || !owner || !owner.startsWith("v"))) fail("New time requires only a timeline owner");
        const plan = await prepareTimeEditPlan({
          libraryRoot: this.#libraryRoot,
          action,
          ...(node ? { node } : {}),
          ...(owner ? { ownerVariant: owner } : {}),
          expectedTimeRevision: integer(payload["expected_time_revision"], "Expected Time revision"),
          expectedLibraryRevision: integer(payload["expected_library_revision"], "Expected Library revision"),
          expectedNodeRevision: integer(payload["expected_node_revision"], "Expected node revision"),
          draft: this.#parseDraft(payload["draft"]),
          cancelArchives: new Set(payload["cancel_references"] === undefined
            ? []
            : boundedArray(payload["cancel_references"], "Cancelled time references", 100_000).map((entry) => this.#reference(entry)))
        });
        const token = this.#planToken();
        if (!PLAN_CAPABILITY.test(token)) throw new TypeError("Time plan token factory returned an invalid capability");
        this.#plans.set(token, plan);
        return {
          plan: token,
          no_change: plan.noChange,
          can_commit: plan.canCommit,
          cancelled_references: [...plan.cancelArchives].map((archive) => this.#referenceTokenFor(archive)),
          impact: this.#projectImpact(plan)
        };
      },
      "time.editor.commit": async (payload) => {
        exactObject(payload, ["plan", "strategy", "selected_references", "touch_on_noop"]);
        const plan = this.#plan(payload["plan"]);
        const strategy = payload["strategy"];
        if (strategy !== "in_place" && strategy !== "all_references" && strategy !== "selected_references" && strategy !== "future_only") fail("Time edit strategy is invalid");
        if (typeof payload["touch_on_noop"] !== "boolean") fail("Time no-op choice is invalid");
        const selected = new Set(boundedArray(payload["selected_references"], "Selected time references", 100_000).map((entry) => this.#reference(entry)));
        const result = await commitTimeEditPlan({
          libraryRoot: this.#libraryRoot,
          plan,
          strategy,
          selectedArchives: selected,
          touchOnNoop: payload["touch_on_noop"],
          anchor: this.#anchor(),
          timestamp: this.#clock(),
          transaction: this.#transaction(),
          recoveryTransaction: this.#transaction()
        });
        if (result.status !== "updated") return result;
        this.#plans.clear();
        this.#references.clear();
        this.#referenceKeys.clear();
        this.#endpoints.clear();
        await this.#authority();
        return {
          status: "updated",
          time_revision: result.timeRevision,
          library_revision: result.libraryRevision,
          node: this.#tokenForId(result.node),
          ...(result.ownerVariant ? { owner: this.#tokenForId(result.ownerVariant) } : {}),
          edited_at: result.editedAt
        };
      },
      "time.delete.preview": async (payload) => {
        exactObject(payload, ["route", "node", "expected_time_revision", "expected_library_revision", "expected_node_revision"]);
        this.#route(payload["route"]);
        await this.#authority();
        const selected = this.#node(payload["node"]);
        if (selected.kind === "preset") fail("Built-in Terran presets cannot be deleted");
        const plan = await prepareTimeDeletePlan({
          libraryRoot: this.#libraryRoot,
          node: selected.id,
          expectedTimeRevision: integer(payload["expected_time_revision"], "Expected Time revision"),
          expectedLibraryRevision: integer(payload["expected_library_revision"], "Expected Library revision"),
          expectedNodeRevision: integer(payload["expected_node_revision"], "Expected node revision")
        });
        const token = this.#deletePlanToken();
        if (!DELETE_PLAN_CAPABILITY.test(token)) throw new TypeError("Time delete plan token factory returned an invalid capability");
        this.#deletePlans.set(token, plan);
        return { plan: token, impact: this.#projectDeleteImpact(plan) };
      },
      "time.delete.commit": async (payload) => {
        exactObject(payload, ["plan", "replacement", "clear_references"]);
        const plan = this.#deletePlan(payload["plan"]);
        if (payload["replacement"] !== null && typeof payload["replacement"] !== "string") fail("Time delete replacement is invalid");
        if (typeof payload["clear_references"] !== "boolean") fail("Time delete reference choice is invalid");
        const replacement = payload["replacement"] === null ? undefined : this.#node(payload["replacement"]).id;
        const result = await commitTimeDeletePlan({
          libraryRoot: this.#libraryRoot,
          plan,
          ...(replacement ? { replacementVariant: replacement } : {}),
          clearReferences: payload["clear_references"],
          timestamp: this.#clock(),
          transaction: this.#transaction(),
          recoveryTransaction: this.#transaction()
        });
        if (result.status !== "updated") return result;
        this.#plans.clear();
        this.#deletePlans.clear();
        this.#references.clear();
        this.#referenceKeys.clear();
        this.#endpoints.clear();
        await this.#authority();
        return {
          status: "updated",
          time_revision: result.timeRevision,
          library_revision: result.libraryRevision,
          deleted_count: result.deletedNodes.length,
          edited_at: result.editedAt
        };
      }
    };
  }

  close(): void {
    this.#routes.clear();
    this.#nodes.clear();
    this.#nodeKeys.clear();
    this.#plans.clear();
    this.#deletePlans.clear();
    this.#references.clear();
    this.#referenceKeys.clear();
    this.#endpoints.clear();
  }
}
