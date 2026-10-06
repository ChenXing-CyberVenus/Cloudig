import type { JsonObject } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";
import { canonicalizeJcs } from "../contracts/deterministic-json.mts";
import { validateRecord } from "./index.mts";
import { uuidV7 } from "./ids.mts";
import { RecordTimeGraph, RECORD_TIME_GRAPH_LIMITS, type TimeTarget } from "./time-graph.mts";
import { assertBuiltinTimeRules } from "./time-presets.mts";
import { normalizeRange } from "../time/range.mts";

const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
const array = (v: unknown): JsonObject[] => Array.isArray(v) ? v as JsonObject[] : [];
const equal = (a: JsonObject, b: JsonObject) => canonicalizeJcs(a) === canonicalizeJcs(b);
const endpoints = (mark: JsonObject): [string, JsonObject][] => Object.entries(object(object(mark["content_time"])["range"])).filter(([, v]) => isJsonObject(v) && v["kind"] === "node") as [string, JsonObject][];
export type RecordTimeEdit = Readonly<{ nodes: readonly JsonObject[]; marks: readonly JsonObject[]; affected: readonly string[]; copies: ReadonlyMap<string, string>; unchanged: boolean }>;
export class RecordTimeComputationLimit extends Error { constructor() { super("Time impact calculation exceeded its operation budget; no records were changed"); this.name = "RecordTimeComputationLimit"; } }
export function assertDistinctTerranMappings(value: JsonObject): void {
  const ranges = array(value["terran_mappings"]).map(row => canonicalizeJcs(normalizeRange(object(row["range"]))));
  if (new Set(ranges).size !== ranges.length) throw new TypeError("The same Terran start/end range is already mapped");
}

function patched(node: JsonObject, patch: JsonObject, timestamp: string): JsonObject {
  const value = structuredClone(node);
  for (const [key, v] of Object.entries(patch)) {
    if (["schema", "node_id", "created_at", "edited_at", "forked_from"].includes(key)) throw new TypeError(`Time edit cannot replace ${key}`);
    if (v === null) delete value[key]; else value[key] = structuredClone(v);
  }
  if (equal(value, node)) return value;
  assertBuiltinTimeRules(value);
  if (Object.hasOwn(patch, "terran_mappings")) assertDistinctTerranMappings(value);
  value["edited_at"] = timestamp;
  const valid = validateRecord("contentTime", value); if (!valid.ok) throw new TypeError(`Edited time is invalid: ${JSON.stringify(valid.issues)}`); return value;
}

/** Pure preview. Runtime fingerprints and commit authority stay in the storage adapter. */
export async function planRecordTimeEdit(input: Readonly<{
  nodes: readonly JsonObject[]; marks: readonly JsonObject[]; node: string; patch: JsonObject; timestamp: string;
  synchronize: "all" | ReadonlySet<string>; signal?: AbortSignal; states?: number; relatedPatches?: ReadonlyMap<string, JsonObject>; forceEditedAt?: boolean;
}>): Promise<RecordTimeEdit> {
  input.signal?.throwIfAborted();
  const maximum = input.states ?? RECORD_TIME_GRAPH_LIMITS.states; if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError("Time operation budget must be positive");
  let work = 0; const charge = () => { if (++work > maximum) throw new RecordTimeComputationLimit(); };
  const before = new RecordTimeGraph(input.nodes), old = before.nodes.get(input.node); if (!old) throw new TypeError("Edited time node is missing");
  let next = patched(old, input.patch, input.timestamp);
  if (input.forceEditedAt) next = { ...next, edited_at: input.timestamp };
  const replacements = new Map<string, JsonObject>();
  for (const [id, patch] of input.relatedPatches ?? []) {
    if (id === input.node) throw new TypeError("Primary edit must not be repeated as a related edit");
    const source = before.nodes.get(id); if (!source) throw new TypeError("Related time record is missing"); const changed = patched(source, patch, input.timestamp);
    if (!equal(source, changed)) replacements.set(id, changed);
  }
  if (equal(old, next) && !replacements.size) return { nodes: [], marks: [], affected: [], copies: new Map(), unchanged: true };
  if (equal(old, next)) next = { ...next, edited_at: input.timestamp };
  replacements.set(input.node, next);
  for (const [id, value] of replacements) {
    const prior = before.nodes.get(id)!;
    for (const field of ["contains", "counterparts"]) {
      const oldLinks = new Set(array(prior[field]).map(link => canonicalizeJcs(link)));
      for (const link of array(value[field])) {
        const target = String(field === "contains" ? link["node"] : object(link["target"])["node"]);
        if (!before.nodes.has(target) && !oldLinks.has(canonicalizeJcs(link))) throw new TypeError("New time relationship points to a missing node");
      }
    }
  }
  // A temporary edited graph may expose existing selections that no longer fit.
  // It is never saved; every actual output graph below is strictly validated.
  const preview = new RecordTimeGraph([...before.nodes.values()].map(n => replacements.get(String(n["node_id"])) ?? n), { previewInvalidLinks: true });
  const affected = new Map<string, { mark: JsonObject; fields: Set<string> }>(), priorMemo = new Map<string, Promise<JsonObject | string>>(), nextMemo = new Map<string, Promise<JsonObject | string>>();
  const snapshot = (graph: RecordTimeGraph, memo: Map<string, Promise<JsonObject | string>>, target: JsonObject) => {
    const key = canonicalizeJcs(target); let result = memo.get(key);
    if (!result) { result = graph.snapshot(target as TimeTarget, { charge, ...(input.signal ? { signal: input.signal } : {}) }).catch(e => { if (e instanceof RecordTimeComputationLimit || input.signal?.aborted || e instanceof Error && e.name === "AbortError") throw e; return e instanceof Error ? e.message : String(e); }); memo.set(key, result); }
    return result;
  };
  for (const mark of input.marks) {
    const valid = validateRecord("mark", mark); if (!valid.ok) throw new TypeError("Cannot plan time synchronization against an invalid Mark");
    input.signal?.throwIfAborted();
    for (const [field, endpoint] of endpoints(mark)) {
      const target = object(endpoint["target"]), a = await snapshot(before, priorMemo, target), b = await snapshot(preview, nextMemo, target);
      if (typeof a === "string" && typeof b === "string" ? a !== b || target["node"] === input.node || target["timeline"] === input.node : typeof a !== typeof b || !equal(a as JsonObject, b as JsonObject)) {
        const id = String(mark["mark_id"]), row = affected.get(id) ?? { mark, fields: new Set<string>() }; row.fields.add(field); affected.set(id, row);
      }
    }
  }
  const selected = input.synchronize === "all" ? new Set(affected.keys()) : input.synchronize;
  if ([...selected].some(id => !affected.has(id))) throw new TypeError("Selected Mark is not affected by this time edit");
  const changes: JsonObject[] = [], copies = new Map<string, string>();
  if (input.synchronize === "all") { new RecordTimeGraph([...preview.nodes.values()]); changes.push(...replacements.values()); }
  else {
    const roots = new Set([input.node]);
    for (const id of selected) {
      const row = affected.get(id)!;
      for (const [field, endpoint] of endpoints(row.mark)) if (row.fields.has(field)) {
        const target = object(endpoint["target"]); roots.add(String(target["node"])); if (typeof target["timeline"] === "string") roots.add(target["timeline"]);
      }
    }
    const queue = [...roots];
    while (queue.length) {
      input.signal?.throwIfAborted(); const id = queue.pop()!; if (copies.has(id)) continue; charge();
      const value = replacements.get(id) ?? before.nodes.get(id); if (!value) throw new TypeError("Copied time reference is missing");
      copies.set(id, uuidV7(Date.parse(input.timestamp))); for (const link of array(value["contains"])) queue.push(String(link["node"]));
    }
    for (const [id, newId] of copies) {
      const value = structuredClone(replacements.get(id) ?? before.nodes.get(id)!);
      value["node_id"] = newId; value["forked_from"] = id; value["edited_at"] = input.timestamp;
      if (value["kind"] === "timeline") value["created_at"] = input.timestamp;
      for (const link of array(value["contains"])) if (copies.has(String(link["node"]))) link["node"] = copies.get(String(link["node"]))!;
      for (const link of array(value["counterparts"])) { const target = object(link["target"]); if (copies.has(String(target["node"]))) target["node"] = copies.get(String(target["node"]))!; }
      // An external record may store the original undirected relation. Put its
      // copied reverse fact on the new endpoint, leaving that record untouched.
      for (const external of preview.nodes.values()) if (!copies.has(String(external["node_id"]))) for (const relation of array(external["counterparts"])) {
        const target = object(relation["target"]); if (target["node"] !== id) continue;
        const reverse: JsonObject = { target: { node: external["node_id"]!, ...(relation["occurrences"] ? { occurrences: structuredClone(relation["occurrences"]) } : {}) }, ...(target["occurrences"] ? { occurrences: structuredClone(target["occurrences"]) } : {}) };
        value["counterparts"] = [...array(value["counterparts"]), reverse];
      }
      changes.push(value);
    }
  }
  const finalNodes = new Map(before.nodes); for (const n of changes) finalNodes.set(String(n["node_id"]), n);
  const finalGraph = new RecordTimeGraph([...finalNodes.values()]), marks: JsonObject[] = [], finalMemo = new Map<string, Promise<JsonObject | string>>();
  for (const id of selected) {
    const row = affected.get(id)!, mark = structuredClone(row.mark), range = object(object(mark["content_time"])["range"]);
    for (const [field, endpoint] of endpoints(mark)) {
      if (!copies.size && !row.fields.has(field)) continue;
      const target = { ...object(endpoint["target"]) };
      if (copies.size && !copies.has(String(target["node"])) && !copies.has(String(target["timeline"]))) continue;
      if (copies.has(String(target["node"]))) target["node"] = copies.get(String(target["node"]))!;
      if (copies.has(String(target["timeline"]))) target["timeline"] = copies.get(String(target["timeline"]))!;
      const value = await snapshot(finalGraph, finalMemo, target); if (typeof value === "string") throw new TypeError(`Mark ${id} needs a new valid time selection: ${value}`);
      range[field] = value;
    }
    if (range["end"] && equal(object(range["start"]), object(range["end"]))) delete range["end"];
    mark["edited_at"] = input.timestamp;
    const valid = validateRecord("mark", mark); if (!valid.ok) throw new TypeError("Synchronized Mark is invalid"); marks.push(mark);
  }
  return { nodes: changes, marks, affected: [...affected.keys()], copies, unchanged: false };
}
