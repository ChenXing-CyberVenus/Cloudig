import { readdir } from "node:fs/promises";
import type { JsonObject } from "../../core/contracts/types.mts";
import { uuidV7 } from "../../core/records/ids.mts";
import { RecordTimeGraph, RECORD_TIME_GRAPH_LIMITS, type TimeTarget } from "../../core/records/time-graph.mts";
import { validateRecord } from "../../core/records/index.mts";
import { RecordSchemaError } from "../../core/records/errors.mts";
import { planRecordTimeEdit, RecordTimeComputationLimit, assertDistinctTerranMappings, type RecordTimeEdit } from "../../core/records/time-edit.mts";
import { builtinTimeIds, builtinTimeNode } from "../../core/records/time-presets.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import { commitRecords, readStoredRecord, resolveRecordPath, withRecordSnapshot, type RecordChange, type RecordReadGuard } from "../storage/record-store.mts";

export type TimeStoredRecord = Readonly<{ path: string; value: JsonObject; sha256: string }>;
export type RecordTimeCatalog = Readonly<{ nodes: readonly TimeStoredRecord[]; order: TimeStoredRecord; graph: RecordTimeGraph; issues: readonly { path: string; message: string }[] }>;

/** Caller holds the Library snapshot lock. Unsupported versions cannot form a partial editable graph. */
export async function loadRecordTimes(root: string): Promise<RecordTimeCatalog> {
  const nodes: TimeStoredRecord[] = [], issues: { path: string; message: string }[] = [];
  for (const entry of await readdir(await resolveRecordPath(root, "ContentTimes"), { withFileTypes: true })) {
    if (entry.name === "order.json") continue;
    const file = `ContentTimes/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink()) { issues.push({ path: file, message: "ContentTime must be an independent ordinary file" }); continue; }
    if (!entry.name.endsWith(".json")) continue;
    try { nodes.push({ path: file, ...await readStoredRecord(root, "contentTime", file) }); }
    catch (e) {
      if (e instanceof RecordSchemaError) throw new RecordSchemaError(`${e.message}\n${file}`, { cause: e });
      issues.push({ path: file, message: e instanceof Error ? e.message : String(e) });
    }
  }
  const order = { path: "ContentTimes/order.json", ...await readStoredRecord(root, "contentTimeOrder", "ContentTimes/order.json") };
  const graph = new RecordTimeGraph(nodes.map(n => n.value));
  for (const issue of graph.issues) issues.push({ path: issue.path, message: issue.message });
  return { nodes, order, graph, issues };
}
export const readRecordTimes = (root: string): Promise<RecordTimeCatalog> => withRecordSnapshot(root, () => loadRecordTimes(root));

export async function createRecordTime(root: string, input: Readonly<{ fields: JsonObject; timestamp: string; parent?: string; includedCount?: number; signal?: AbortSignal }>): Promise<Readonly<{ node: JsonObject; path: string; maintenanceWarnings: readonly string[] }>> {
  for (const key of ["schema", "node_id", "created_at", "edited_at", "forked_from"]) if (Object.hasOwn(input.fields, key)) throw new TypeError(`Creation does not accept ${key}`);
  const value: JsonObject = { ...input.fields, schema: "cloudig/content-time/1.0.0", node_id: uuidV7(Date.parse(input.timestamp)), edited_at: input.timestamp,
    ...(input.fields["kind"] === "timeline" ? { created_at: input.timestamp } : {}) };
  const valid = validateRecord("contentTime", value); if (!valid.ok) throw new TypeError(`Time fields are invalid: ${JSON.stringify(valid.issues)}`);
  assertDistinctTerranMappings(value);
  const relative = `ContentTimes/${value["node_id"]}.json`;
  const prepared = await withRecordSnapshot(root, async () => {
    const catalog = await loadRecordTimes(root), values = new Map(catalog.nodes.map(n => [String(n.value["node_id"]), n.value]));
    const changes: RecordChange[] = [{ action: "write", path: relative, kind: "contentTime", value, expected: null }];
    const guards: RecordReadGuard[] = [];
    values.set(String(value["node_id"]), value);
    if (input.parent) {
      const parent = catalog.nodes.find(n => n.value["node_id"] === input.parent); if (!parent) throw new TypeError("Parent time node is missing");
      if (value["kind"] !== "periodic" && input.includedCount !== undefined) throw new TypeError("Only a periodic child has an included count");
      const updated = { ...parent.value, edited_at: input.timestamp, contains: [...(parent.value["contains"] as JsonObject[] ?? []), { node: value["node_id"]!, ...(value["kind"] === "periodic" ? { count: input.includedCount ?? value["count"]! } : {}) }] };
      changes.push({ action: "write", kind: "contentTime", path: parent.path, value: updated, expected: parent.sha256 }); values.set(input.parent, updated);
    } else {
      if (input.includedCount !== undefined) throw new TypeError("Included count needs a parent");
      changes.push({ action: "write", kind: "contentTimeOrder", path: catalog.order.path, expected: catalog.order.sha256,
        value: { ...catalog.order.value, nodes: [value["node_id"]!, ...(catalog.order.value["nodes"] as string[])], edited_at: input.timestamp } });
    }
    const graph = new RecordTimeGraph([...values.values()]);
    if (graph.issues.some(i => i.path.startsWith(`/${value["node_id"]}/`))) throw new TypeError("New time relationships cannot point to missing nodes");
    // Only direct referenced-node facts affect this creation. Do not make an
    // unrelated node edit invalidate every operation in the whole Library.
    const refs = new Set<string>();
    for (const link of value["contains"] as JsonObject[] ?? []) refs.add(String(link["node"]));
    for (const link of value["counterparts"] as JsonObject[] ?? []) refs.add(String((link["target"] as JsonObject)["node"]));
    for (const target of refs) { const ref = catalog.nodes.find(n => n.value["node_id"] === target); if (ref && ref.value["node_id"] !== input.parent) guards.push({ path: ref.path, expected: ref.sha256 }); }
    return { changes, guards };
  });
  const saved = await commitRecords(root, prepared.changes, { reads: prepared.guards, ...(input.signal ? { signal: input.signal } : {}) });
  return { node: value, path: relative, maintenanceWarnings: saved?.maintenanceWarnings ?? [] };
}

export async function reorderRecordTimes(root: string, input: Readonly<{ nodes: readonly string[]; expected: string; timestamp: string }>): Promise<void> {
  const prepared = await withRecordSnapshot(root, async () => {
    const catalog = await loadRecordTimes(root);
    if (catalog.order.sha256 !== input.expected) throw new TypeError("Time display order changed; refresh it");
    if (new Set(input.nodes).size !== input.nodes.length || input.nodes.some(id => !catalog.graph.nodes.has(id))) throw new TypeError("Display order has duplicate or missing nodes");
    if (JSON.stringify(catalog.order.value["nodes"]) === JSON.stringify(input.nodes)) return null;
    return { value: { ...catalog.order.value, nodes: [...input.nodes], edited_at: input.timestamp }, guards: catalog.nodes.filter(n => input.nodes.includes(String(n.value["node_id"]))).map(n => ({ path: n.path, expected: n.sha256 })) };
  });
  if (prepared) await commitRecords(root, [{ action: "write", path: "ContentTimes/order.json", kind: "contentTimeOrder", value: prepared.value, expected: input.expected }], { reads: prepared.guards });
}

export type RecordTimeSavePlan = Readonly<{ result: RecordTimeEdit; changes: readonly RecordChange[]; reads: readonly RecordReadGuard[]; inventory: readonly string[] }>;
async function timeMarkInventory(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const area of ["ContentTimes", "Marks"]) for (const entry of await readdir(await resolveRecordPath(root, area), { withFileTypes: true })) {
    if (entry.name.endsWith(".json") && !(area === "ContentTimes" && entry.name === "order.json")) found.push(`${area}/${entry.name}`);
  }
  return found.sort();
}

export async function prepareRecordTimeSave(root: string, input: Readonly<{ node: string; patch: JsonObject; timestamp: string; synchronize: "all" | ReadonlySet<string>; signal?: AbortSignal; relatedPatches?: ReadonlyMap<string, JsonObject>; forceEditedAt?: boolean; cancelMarks?: ReadonlySet<string> }>): Promise<RecordTimeSavePlan> {
  const loaded = await withRecordSnapshot(root, async () => {
    const catalog = await loadRecordTimes(root), inventory = await timeMarkInventory(root), marks: TimeStoredRecord[] = [];
    for (const file of inventory.filter(p => p.startsWith("Marks/"))) {
      try { marks.push({ path: file, ...await readStoredRecord(root, "mark", file) }); }
      catch (e) { if (input.synchronize === "all" || input.synchronize.has(file.slice("Marks/".length, -".json".length))) throw new TypeError(`Cannot synchronize an unreadable Mark: ${file}`, { cause: e }); }
    }
    return { catalog, marks, inventory };
  });
  const cancelled = loaded.marks.filter(m => input.cancelMarks?.has(String(m.value["mark_id"])));
  if (cancelled.length !== (input.cancelMarks?.size ?? 0)) throw new TypeError("A cancelled time reference is missing or unreadable");
  for (const mark of cancelled) {
    const time = mark.value["content_time"] as JsonObject | undefined, range = time?.["range"] as JsonObject | undefined;
    if (!Object.values(range ?? {}).some(e => e && typeof e === "object" && !Array.isArray(e) && e["kind"] === "node" && ((e["target"] as JsonObject)["node"] === input.node || (e["target"] as JsonObject)["timeline"] === input.node))) throw new TypeError("Cancelled Mark no longer references the edited node");
  }
  const computed = await planRecordTimeEdit({ ...input, nodes: loaded.catalog.nodes.map(n => n.value), marks: loaded.marks.filter(m => !input.cancelMarks?.has(String(m.value["mark_id"]))).map(m => m.value) });
  const result = cancelled.length ? { ...computed, unchanged: false } : computed;
  const changes: RecordChange[] = [
    ...result.nodes.map(value => ({ action: "write" as const, path: `ContentTimes/${value["node_id"]}.json`, kind: "contentTime" as const, value, expected: loaded.catalog.nodes.find(n => n.value["node_id"] === value["node_id"])?.sha256 ?? null })),
    ...result.marks.map(value => ({ action: "write" as const, path: `Marks/${value["mark_id"]}.json`, kind: "mark" as const, value, expected: loaded.marks.find(m => m.value["mark_id"] === value["mark_id"])!.sha256 }))
  ];
  for (const mark of cancelled) {
    const value = { ...mark.value }; delete value["content_time"];
    if (["conversation_title", "models", "names"].some(key => Object.hasOwn(value, key))) { value["edited_at"] = input.timestamp; changes.push({ action: "write", kind: "mark", path: mark.path, value, expected: mark.sha256 }); }
    else changes.push({ action: "delete", path: mark.path, expected: mark.sha256 });
  }
  if (result.copies.size) {
    const copiedRoots = loaded.catalog.graph.roots(loaded.catalog.order.value["nodes"] as string[]).filter(id => result.copies.has(id)).map(id => result.copies.get(id)!);
    if (!copiedRoots.length) copiedRoots.push(result.copies.get(input.node)!);
    changes.push({ action: "write", kind: "contentTimeOrder", path: loaded.catalog.order.path, expected: loaded.catalog.order.sha256,
      value: { ...loaded.catalog.order.value, edited_at: input.timestamp, nodes: [...copiedRoots, ...(loaded.catalog.order.value["nodes"] as string[])] } });
  }
  const changed = new Set(changes.map(c => c.path));
  const reads = [...loaded.catalog.nodes, ...loaded.marks].filter(r => !changed.has(r.path)).map(r => ({ path: r.path, expected: r.sha256 }));
  return { result, changes, reads, inventory: loaded.inventory };
}

/** The editor shows both directions; save keeps unchanged facts at their existing storage side. */
export async function prepareRecordTimeEditorSave(root: string, input: Readonly<{ node: string; patch: JsonObject; counterparts: readonly JsonObject[]; timestamp: string; synchronize: "all" | ReadonlySet<string>; signal?: AbortSignal; forceEditedAt?: boolean; cancelMarks?: ReadonlySet<string> }>): Promise<RecordTimeSavePlan> {
  if (Object.hasOwn(input.patch, "counterparts")) throw new TypeError("Counterparts are supplied separately from basic fields");
  const catalog = await readRecordTimes(root), primary = catalog.nodes.find(n => n.value["node_id"] === input.node); if (!primary) throw new TypeError("Edited node is missing");
  const desired = new Map(input.counterparts.map(r => [canonicalizeJcs(r), structuredClone(r)])); if (desired.size !== input.counterparts.length) throw new TypeError("Duplicate counterpart selection");
  const own: JsonObject[] = [], relatedPatches = new Map<string, JsonObject>();
  for (const record of catalog.nodes) {
    const links = record.value["counterparts"] as JsonObject[] ?? [], retained: JsonObject[] = [];
    for (const relation of links) {
      const target = relation["target"] as JsonObject, owner = String(record.value["node_id"]);
      if (owner !== input.node && target["node"] !== input.node) { retained.push(relation); continue; }
      const visible = owner === input.node ? relation : { target: { node: owner, ...(relation["occurrences"] ? { occurrences: relation["occurrences"] } : {}) }, ...(target["occurrences"] ? { occurrences: target["occurrences"] } : {}) };
      const key = canonicalizeJcs(visible);
      if (desired.has(key)) { if (owner === input.node) own.push(relation); else retained.push(relation); desired.delete(key); }
    }
    if (record.value["node_id"] !== input.node && retained.length !== links.length) relatedPatches.set(String(record.value["node_id"]), { counterparts: retained });
  }
  own.push(...desired.values());
  const patch: JsonObject = { ...input.patch, ...(own.length || primary.value["counterparts"] !== undefined ? { counterparts: own } : {}) };
  const plan = await prepareRecordTimeSave(root, { ...input, patch, relatedPatches });
  // The relation view and the full impact plan must observe the same Time bytes.
  const readHashes = new Map([...plan.reads.map(r => [r.path, r.expected] as const), ...plan.changes.map(c => [c.path, c.expected] as const)]);
  if (catalog.nodes.some(n => readHashes.get(n.path) !== n.sha256)) throw new TypeError("Counterpart records changed while preparing the edit");
  return plan;
}

export async function commitRecordTimeSave(root: string, plan: RecordTimeSavePlan, signal?: AbortSignal): Promise<Readonly<{ operationId: string; maintenanceWarnings: readonly string[] }> | null> {
  if (plan.result.unchanged) return null;
  return commitRecords(root, plan.changes, { reads: plan.reads, ...(signal ? { signal } : {}),
    preflight: async () => { if (JSON.stringify(await timeMarkInventory(root)) !== JSON.stringify(plan.inventory)) throw new TypeError("Time nodes or Marks changed after the impact preview; refresh it"); } });
}

export async function prepareRecordTimeRestore(root: string, input: Readonly<{ node: string; timestamp: string; anchor: Readonly<{ date: string; offset: string }>; synchronize: "all" | ReadonlySet<string>; signal?: AbortSignal }>): Promise<RecordTimeSavePlan> {
  const defaults = builtinTimeNode(input.node, input); if (!defaults["terran_mappings"]) throw new TypeError("This builtin axis has no numeric time range to reset");
  // Restore the time range, not a user-edited label or unrelated relationships.
  return prepareRecordTimeSave(root, { ...input, patch: { terran_mappings: defaults["terran_mappings"] } });
}

export type RecordTimeDeletePlan = Readonly<{ changes: readonly RecordChange[]; reads: readonly RecordReadGuard[]; inventory: readonly string[]; nodes: readonly { id: string; name: string }[]; linkedNodes: readonly string[]; retainedMarks: readonly string[]; links: "preserve" | "remove" }>;
/** Explicit deletion preview: no implicit descendant deletion, no deletion of Mark snapshots. */
export async function prepareRecordTimeDelete(root: string, input: Readonly<{ nodes: readonly string[]; links: "preserve" | "remove"; timestamp: string; signal?: AbortSignal }>): Promise<RecordTimeDeletePlan> {
  if (!input.nodes.length || new Set(input.nodes).size !== input.nodes.length || input.nodes.some(id => builtinTimeIds.has(id))) throw new TypeError("Select distinct custom time nodes; builtins cannot be deleted");
  if (!["preserve", "remove"].includes(input.links)) throw new TypeError("Choose how direct relationships are handled");
  return withRecordSnapshot(root, async () => {
    const catalog = await loadRecordTimes(root), selected = new Set(input.nodes), inventory = await timeMarkInventory(root), nodes = input.nodes.map(id => {
      const record = catalog.nodes.find(n => n.value["node_id"] === id); if (!record) throw new TypeError("Selected time node is missing"); return record;
    });
    const changes: RecordChange[] = nodes.map(n => ({ action: "delete", path: n.path, expected: n.sha256 })), linkedNodes: string[] = [], retainedMarks: string[] = [];
    for (const record of catalog.nodes) if (!selected.has(String(record.value["node_id"]))) {
      const value = structuredClone(record.value); let linked = false;
      for (const field of ["contains", "counterparts"]) if (Array.isArray(value[field])) {
        const prior = value[field] as JsonObject[], next = prior.filter(r => !selected.has(String(field === "contains" ? r["node"] : (r["target"] as JsonObject)["node"])));
        if (next.length !== prior.length) { linked = true; if (input.links === "remove") value[field] = next; }
      }
      if (linked) {
        linkedNodes.push(String(value["node_id"]));
        if (input.links === "remove") { value["edited_at"] = input.timestamp; changes.push({ action: "write", kind: "contentTime", path: record.path, value, expected: record.sha256 }); }
      }
    }
    const replaced = new Map(changes.filter(c => c.action === "write").map(c => [c.path, c.action === "write" ? c.value : {}]));
    const after = new RecordTimeGraph(catalog.nodes.filter(n => !selected.has(String(n.value["node_id"]))).map(n => replaced.get(n.path) ?? n.value));
    const memo = new Map<string, Promise<string>>(); let visits = 0;
    const signature = (graph: RecordTimeGraph, prefix: string, target: JsonObject): Promise<string> => {
      const key = prefix + canonicalizeJcs(target); let pending = memo.get(key);
      if (!pending) { pending = graph.snapshot(target as TimeTarget, { ...(input.signal ? { signal: input.signal } : {}), charge: () => { if (++visits > RECORD_TIME_GRAPH_LIMITS.states) throw new RecordTimeComputationLimit(); } })
        .then(value => canonicalizeJcs(value)).catch(e => { if (e instanceof RecordTimeComputationLimit || input.signal?.aborted) throw e; return `error:${e instanceof Error ? e.message : String(e)}`; }); memo.set(key, pending); }
      return pending;
    };
    const marks: TimeStoredRecord[] = [];
    for (const file of inventory.filter(p => p.startsWith("Marks/"))) {
      const mark = { path: file, ...await readStoredRecord(root, "mark", file) }; marks.push(mark);
      const time = mark.value["content_time"] as JsonObject | undefined, range = time?.["range"] as JsonObject | undefined;
      for (const endpoint of Object.values(range ?? {})) if (endpoint && typeof endpoint === "object" && !Array.isArray(endpoint) && endpoint["kind"] === "node") {
        input.signal?.throwIfAborted(); const target = endpoint["target"] as JsonObject;
        if (selected.has(String(target["node"])) || selected.has(String(target["timeline"])) || await signature(catalog.graph, "before:", target) !== await signature(after, "after:", target)) { retainedMarks.push(String(mark.value["mark_id"])); break; }
      }
    }
    const order = catalog.order.value["nodes"] as string[], nextOrder = order.filter(id => !selected.has(id));
    if (nextOrder.length !== order.length) changes.push({ action: "write", kind: "contentTimeOrder", path: catalog.order.path, expected: catalog.order.sha256, value: { ...catalog.order.value, nodes: nextOrder, edited_at: input.timestamp } });
    const changed = new Set(changes.map(c => c.path)), reads = [...catalog.nodes, catalog.order, ...marks].filter(r => !changed.has(r.path)).map(r => ({ path: r.path, expected: r.sha256 }));
    return { changes, reads, inventory, nodes: nodes.map(n => ({ id: String(n.value["node_id"]), name: String(n.value["name"]) })), linkedNodes, retainedMarks, links: input.links };
  });
}
export async function commitRecordTimeDelete(root: string, plan: RecordTimeDeletePlan, signal?: AbortSignal) {
  return commitRecords(root, plan.changes, { reads: plan.reads, ...(signal ? { signal } : {}),
    preflight: async () => { if (JSON.stringify(await timeMarkInventory(root)) !== JSON.stringify(plan.inventory)) throw new TypeError("Time or Mark files changed after the deletion preview"); } });
}

export type RecordTimeUnlinkPlan = Readonly<{ changes: readonly RecordChange[]; reads: readonly RecordReadGuard[]; inventory: readonly string[]; targets: readonly { mark: string; conversation: string }[] }>;
/** Cancel reference clears the whole content_time, exactly as the confirmation text promises. */
export async function prepareRecordTimeUnlink(root: string, input: Readonly<{ node: string; marks: readonly string[]; timestamp: string }>): Promise<RecordTimeUnlinkPlan> {
  if (!input.marks.length || new Set(input.marks).size !== input.marks.length) throw new TypeError("Select distinct Marks to unlink");
  return withRecordSnapshot(root, async () => {
    const node = await readStoredRecord(root, "contentTime", `ContentTimes/${input.node}.json`), inventory = await timeMarkInventory(root), changes: RecordChange[] = [], targets: { mark: string; conversation: string }[] = [];
    for (const id of input.marks) {
      const file = `Marks/${id}.json`, mark = await readStoredRecord(root, "mark", file), time = mark.value["content_time"] as JsonObject | undefined;
      const range = time?.["range"] as JsonObject | undefined;
      if (!range || !Object.values(range).some(endpoint => {
        if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint) || endpoint["kind"] !== "node") return false;
        const target = endpoint["target"] as JsonObject; return target["node"] === input.node || target["timeline"] === input.node;
      })) throw new TypeError("Selected Mark no longer references this time");
      const value = { ...mark.value }; delete value["content_time"];
      if (["conversation_title", "models", "names"].some(key => Object.hasOwn(value, key))) {
        value["edited_at"] = input.timestamp; changes.push({ action: "write", kind: "mark", path: file, expected: mark.sha256, value });
      } else changes.push({ action: "delete", path: file, expected: mark.sha256 });
      targets.push({ mark: id, conversation: String(mark.value["target"]) });
    }
    return { changes, reads: [{ path: `ContentTimes/${input.node}.json`, expected: node.sha256 }], inventory, targets };
  });
}
export async function commitRecordTimeUnlink(root: string, plan: RecordTimeUnlinkPlan) {
  return commitRecords(root, plan.changes, { reads: plan.reads, preflight: async () => {
    if (JSON.stringify(await timeMarkInventory(root)) !== JSON.stringify(plan.inventory)) throw new TypeError("Time references changed after the unlink preview");
  } });
}
