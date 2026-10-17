import { setImmediate } from "node:timers/promises";
import type { JsonObject, ValidationIssue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";
import { validateRecord, inspectTimeLinks } from "./index.mts";
import { selectorIntersects } from "../time/selectors.mts";
import { projectTerranEndpoint, compareTerranProjection } from "../time/terran.mts";

export const RECORD_TIME_GRAPH_LIMITS = Object.freeze({ states: 100_000, yieldEvery: 512 });
type Selection = JsonObject | undefined;
type Edge = { to: string; fromSelection: Selection; toSelection: Selection };
type Budget = Readonly<{ signal?: AbortSignal; states?: number; charge?: () => void }>;
export type TimeTarget = Readonly<{ node: string; timeline?: string; occurrences?: JsonObject }>;
const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
const array = (v: unknown): JsonObject[] => Array.isArray(v) ? v as JsonObject[] : [];
const selectionKey = (value: Selection): string => value?.["all"] === true ? "all" : value ? `${value["first"]}:${value["step"]}:${value["last"]}` : "single";

function selectionOverlap(node: JsonObject, a: Selection, b: Selection): boolean {
  if (node["kind"] !== "periodic") return true;
  if (!a || !b) throw new TypeError("Periodic selection is missing");
  // Only reuse the exact BigInt intersection algorithm. Its old mode syntax
  // stays inside this call and is never serialized in a new record.
  const legacy = (value: JsonObject): JsonObject => value["all"] === true ? { mode: "all" } : { mode: "progression", ...value };
  return selectorIntersects(legacy(a), legacy(b), Number(node["count"]));
}
function validSelection(node: JsonObject, selection: Selection, mark = false): void {
  if (node["kind"] !== "periodic") { if (selection) throw new TypeError("Nonperiodic nodes have no occurrences"); return; }
  if (!selection) throw new TypeError("Periodic node needs an occurrence selection");
  if (!mark && selection["all"] === true) return;
  const first = selection["first"], step = selection["step"], last = selection["last"];
  if (Object.keys(selection).length !== 3 || typeof first !== "number" || typeof step !== "number" || typeof last !== "number" || ![first, step, last].every(Number.isSafeInteger) || first < 1 || step < 1 || last < first || last > Number(node["count"]) || (last - first) % step) throw new TypeError("Occurrence selection is out of bounds");
}
function limit(options: Budget): number {
  const value = options.states ?? RECORD_TIME_GRAPH_LIMITS.states;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Time traversal budget must be positive"); return value;
}
async function checkpoint(visited: number, options: Budget) { options.signal?.throwIfAborted(); options.charge?.(); if (visited % RECORD_TIME_GRAPH_LIMITS.yieldEvery === 0) { await setImmediate(); options.signal?.throwIfAborted(); } }

/** Independent node graph. Contains order, counterpart equality and Terran values remain separate. */
export class RecordTimeGraph {
  readonly nodes: ReadonlyMap<string, JsonObject>;
  readonly issues: readonly ValidationIssue[];
  readonly #edges = new Map<string, Edge[]>();
  constructor(nodes: readonly JsonObject[], options: Readonly<{ previewInvalidLinks?: boolean }> = {}) {
    const map = new Map<string, JsonObject>();
    for (const raw of nodes) {
      const valid = validateRecord("contentTime", raw); if (!valid.ok) throw new TypeError(`Invalid time node: ${JSON.stringify(valid.issues)}`);
      const id = String(raw["node_id"]); if (map.has(id)) throw new TypeError("Duplicate time node UUID"); map.set(id, structuredClone(raw));
    }
    this.nodes = map; this.issues = inspectTimeLinks([...map.values()]);
    const invalid = this.issues.filter(issue => issue.code !== "CLOUDIG_REFERENCE_MISSING"); if (invalid.length && !options.previewInvalidLinks) throw new TypeError(`Invalid time relations: ${JSON.stringify(invalid)}`);
    const add = (from: string, edge: Edge) => { const values = this.#edges.get(from) ?? []; values.push(edge); this.#edges.set(from, values); };
    for (const [id, node] of map) for (const relation of array(node["counterparts"])) {
      const target = object(relation["target"]), to = String(target["node"]);
      add(id, { to, fromSelection: relation["occurrences"] as Selection, toSelection: target["occurrences"] as Selection });
      add(to, { to: id, fromSelection: target["occurrences"] as Selection, toSelection: relation["occurrences"] as Selection });
    }
  }
  ordered(order: readonly string[]): string[] {
    const explicit = [...new Set(order)].filter(id => this.nodes.has(id)), chosen = new Set(explicit);
    const other = [...this.nodes.keys()].filter(id => !chosen.has(id));
    other.sort((a, b) => Date.parse(String(this.nodes.get(b)!["edited_at"])) - Date.parse(String(this.nodes.get(a)!["edited_at"])) || a.localeCompare(b, "en"));
    return [...explicit, ...other];
  }
  roots(order: readonly string[]): string[] {
    const children = new Set([...this.nodes.values()].flatMap(n => array(n["contains"]).map(r => String(r["node"])))), explicit = new Set(order);
    return this.ordered(order).filter(id => explicit.has(id) || !children.has(id));
  }
  directCounterparts(id: string): readonly Readonly<{ node: string; occurrences?: JsonObject; sourceOccurrences?: JsonObject }>[] {
    return (this.#edges.get(id) ?? []).map(e => ({ node: e.to, ...(e.toSelection ? { occurrences: structuredClone(e.toSelection) } : {}), ...(e.fromSelection ? { sourceOccurrences: structuredClone(e.fromSelection) } : {}) }));
  }
  async path(root: string, target: string, options: Budget = {}): Promise<Readonly<{ status: "found" | "missing" | "unreachable" | "budget_exceeded"; path?: number[]; includedCount?: number; visited: number }>> {
    if (!this.nodes.has(root) || !this.nodes.has(target)) return { status: "missing", visited: 0 };
    type Trail = { ordinal: number; parent?: Trail; count?: number };
    const seen = new Set<string>(), stack: { id: string; trail?: Trail }[] = [{ id: root }], maximum = limit(options); let visited = 0;
    while (stack.length) {
      const current = stack.pop()!; if (seen.has(current.id)) continue;
      if (visited >= maximum) return { status: "budget_exceeded", visited }; await checkpoint(++visited, options); seen.add(current.id);
      if (current.id === target) { const found: number[] = []; for (let trail = current.trail; trail; trail = trail.parent) found.push(trail.ordinal); return { status: "found", path: found.reverse(), ...(current.trail?.count === undefined ? {} : { includedCount: current.trail.count }), visited }; }
      const node = this.nodes.get(current.id); if (!node) continue;
      const children = array(node["contains"]);
      for (let i = children.length - 1; i >= 0; i--) stack.push({ id: String(children[i]!["node"]), trail: { ordinal: i + 1, ...(current.trail ? { parent: current.trail } : {}), ...(typeof children[i]!["count"] === "number" ? { count: children[i]!["count"] as number } : {}) } });
    }
    return { status: "unreachable", visited };
  }
  async mappedRanges(target: TimeTarget, options: Budget = {}): Promise<Readonly<{ status: "complete" | "missing" | "budget_exceeded"; ranges: readonly JsonObject[]; visited: number }>> {
    const first = this.nodes.get(target.node); if (!first) return { status: "missing", ranges: [], visited: 0 }; validSelection(first, target.occurrences, true);
    const seen = new Set<string>(), ranges = new Map<string, JsonObject>(), stack: { id: string; selection: Selection }[] = [{ id: target.node, selection: target.occurrences }];
    const maximum = limit(options); let visited = 0, missing = false;
    while (stack.length) {
      const current = stack.pop()!, key = `${current.id}:${selectionKey(current.selection)}`; if (seen.has(key)) continue;
      if (visited >= maximum) return { status: "budget_exceeded", ranges: [], visited }; await checkpoint(++visited, options); seen.add(key);
      const node = this.nodes.get(current.id); if (!node) { missing = true; continue; }
      validSelection(node, current.selection);
      for (const relation of array(node["terran_mappings"])) if (selectionOverlap(node, current.selection, relation["occurrences"] as Selection)) {
        const range = object(relation["range"]); ranges.set(JSON.stringify(range), structuredClone(range));
      }
      for (const edge of this.#edges.get(current.id) ?? []) if (selectionOverlap(node, current.selection, edge.fromSelection)) stack.push({ id: edge.to, selection: edge.toSelection });
    }
    return { status: missing ? "missing" : "complete", ranges: missing ? [] : [...ranges.values()], visited };
  }
  async snapshot(target: TimeTarget, options: Budget = {}): Promise<JsonObject> {
    const node = this.nodes.get(target.node); if (!node) throw new TypeError("Selected time node is missing"); validSelection(node, target.occurrences, true);
    const facts: JsonObject = { kind: node["kind"]!, name: node["name"]! };
    for (const field of ["count", "prefix", "unit"]) if (node[field] !== undefined) facts[field] = node[field]!;
    const snapshot: JsonObject = { node: facts };
    if (target.timeline) {
      const timeline = this.nodes.get(target.timeline); if (timeline?.["kind"] !== "timeline") throw new TypeError("Reference timeline is missing or is not a timeline");
      const found = await this.path(target.timeline, target.node, options); if (found.status !== "found") throw new TypeError(`Selected time is not reachable in its reference timeline: ${found.status}`);
      if (found.includedCount !== undefined && Number(target.occurrences?.["last"]) > found.includedCount) throw new TypeError("Selected occurrence is outside the timeline's included prefix");
      const info: JsonObject = { name: timeline["name"]!, author: timeline["author"]! };
      for (const field of ["standard_name", "version"]) if (timeline[field] !== undefined) info[field] = timeline[field]!;
      snapshot["timeline"] = info; snapshot["path"] = found.path!;
    }
    const mapped = await this.mappedRanges(target, options);
    if (mapped.status !== "complete") throw new TypeError(`Time mapping is incomplete: ${mapped.status}`);
    let earliest: JsonObject | undefined, independent: JsonObject | undefined;
    for (const range of mapped.ranges) {
      const value = projectTerranEndpoint(range["start"]!);
      if (value.domain !== "terran_ordered") { independent ??= range; continue; }
      if (!earliest || compareTerranProjection(value, projectTerranEndpoint(earliest["start"]!)) === -1) earliest = range;
    }
    if (earliest ?? independent) snapshot["sort"] = (earliest ?? independent)!;
    return { kind: "node", target: { ...target }, snapshot };
  }
}
