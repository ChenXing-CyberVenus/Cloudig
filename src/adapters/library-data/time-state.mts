import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  serializeLibrary,
  serializeTimeSystem,
  validateTimeSystem,
  validateTimeValue
} from "../../core/contracts/index.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import terranPreset from "../../core/contracts/machine/terran-preset.json" with { type: "json" };
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import {
  analyzeVariantImpact,
  analyzeTimeDeleteImpact,
  buildSovereignSnapshot,
  cloneVariantState,
  deleteTimeNodeState,
  normalizeRange,
  type ArchiveTimeReference,
  type TimeDeleteImpact,
  type VariantImpact
} from "../../core/time/index.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { capturePreviousAuthority, readCurrentAuthorityPair, type AuthorityPair } from "../storage/recovery-point.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";
import { readCatalogCache } from "./catalog.mts";

export type TimeNodeMetadata =
  | Readonly<{
    kind: "preset";
    range: JsonObject | null;
  }>
  | Readonly<{
    kind: "timeline";
    name: string;
    author: string;
    standardName: string | null;
    version: string | null;
  }>
  | Readonly<{
    kind: "single";
    name: string;
  }>
  | Readonly<{
    kind: "periodic";
    name: string;
    count: number;
    prefix: string | null;
    unit: string | null;
    displayEmpty: boolean;
  }>;

export type TimeNodeDisplay = Readonly<{ name: string; kind: string; count?: number }>;
export type TimeChildDraft = Readonly<{ node: string; occurrences?: JsonObject; display?: TimeNodeDisplay }>;
export type TimeCounterpartDraft = Readonly<{
  target: Readonly<{ node: string; occurrences?: JsonObject; display?: TimeNodeDisplay }>;
  selfOccurrences?: JsonObject;
}>;
export type TimeMappingDraft = Readonly<{ occurrences?: JsonObject; range: JsonObject }>;

export type TimeNodeDraft = Readonly<{
  metadata: TimeNodeMetadata;
  children: readonly TimeChildDraft[];
  counterparts: readonly TimeCounterpartDraft[];
  mappings: readonly TimeMappingDraft[];
}>;

export type TimeEditAction = "edit" | "create_timeline" | "create_time";

export type TimeEditorContext = Readonly<{
  timeRevision: number;
  libraryRevision: number;
  nodeRevision: number;
  node: string;
  ownerVariant?: string;
  metadata: TimeNodeMetadata;
  createdAt?: string;
  editedAt: string;
  variantNumber?: number;
  children: readonly TimeChildDraft[];
  counterparts: readonly TimeCounterpartDraft[];
  mappings: readonly TimeMappingDraft[];
  references: readonly ArchiveTimeReference[];
}>;

export type TimeEditPlan = Readonly<{
  action: TimeEditAction;
  node?: string;
  ownerVariant?: string;
  expectedTimeRevision: number;
  expectedLibraryRevision: number;
  expectedNodeRevision: number;
  timeFingerprint: Readonly<{ bytes: number; sha256: string }>;
  libraryFingerprint: Readonly<{ bytes: number; sha256: string }>;
  draft: TimeNodeDraft;
  graphChanged: boolean;
  cancelArchives: ReadonlySet<string>;
  noChange: boolean;
  impact: VariantImpact;
  references: readonly ArchiveTimeReference[];
  canCommit: boolean;
}>;

export type TimeEditCommitResult =
  | Readonly<{
    status: "updated";
    timeRevision: number;
    libraryRevision: number;
    node: string;
    ownerVariant?: string;
    editedAt: string;
  }>
  | Readonly<{ status: "unchanged"; timeRevision: number; libraryRevision: number; node?: string }>
  | Readonly<{ status: "conflict"; reason: string }>;

export type TimeDeletePlan = Readonly<{
  node: string;
  expectedTimeRevision: number;
  expectedLibraryRevision: number;
  expectedNodeRevision: number;
  timeFingerprint: Readonly<{ bytes: number; sha256: string }>;
  libraryFingerprint: Readonly<{ bytes: number; sha256: string }>;
  impact: TimeDeleteImpact;
  displays: Readonly<Record<string, TimeNodeDisplay>>;
}>;

export type TimeDeleteCommitResult =
  | Readonly<{
    status: "updated";
    timeRevision: number;
    libraryRevision: number;
    deletedNodes: readonly string[];
    editedAt: string;
  }>
  | Readonly<{ status: "conflict"; reason: string }>;

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function pool(system: JsonObject, name: "lineages" | "variants" | "times" | "contains"): JsonObject {
  const current = object(system[name]);
  if (current) return current;
  const created: JsonObject = {};
  system[name] = created;
  return created;
}

function nonEmpty(value: string | null | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function optionalNonEmpty(value: string | null, label: string): string | undefined {
  if (value === null) return undefined;
  return nonEmpty(value, label);
}

function ownerVariant(system: JsonObject, node: string): string | undefined {
  if (node.startsWith("v") && object(object(system["variants"])?.[node])) return node;
  const time = object(object(system["times"])?.[node]);
  return typeof time?.["owner"] === "string" ? time["owner"] : undefined;
}

function ownedNodes(system: JsonObject, variant: string): Set<string> {
  const result = new Set<string>([variant]);
  for (const [id, raw] of Object.entries(object(system["times"]) ?? {})) {
    if (isJsonObject(raw) && raw["owner"] === variant) result.add(id);
  }
  return result;
}

function nodeRevision(system: JsonObject, node: string): number {
  if (node.startsWith("p")) return system["revision"] as number;
  const variant = ownerVariant(system, node);
  const raw = variant ? object(object(system["variants"])?.[variant]) : undefined;
  if (!raw || typeof raw["revision"] !== "number") throw new TypeError("Time node has no owner revision");
  return raw["revision"];
}

function metadataFor(system: JsonObject, node: string): TimeNodeMetadata {
  if (node.startsWith("p")) {
    const overrides = object(system["terran_values"]);
    return { kind: "preset", range: object(overrides?.[node]) ? structuredClone(overrides![node] as JsonObject) : null };
  }
  const variant = object(object(system["variants"])?.[node]);
  if (variant) {
    return {
      kind: "timeline",
      name: String(variant["name"]),
      author: String(variant["author"]),
      standardName: typeof variant["standard_name"] === "string" ? variant["standard_name"] : null,
      version: typeof variant["version"] === "string" ? variant["version"] : null
    };
  }
  const time = object(object(system["times"])?.[node]);
  if (!time) throw new TypeError("Time node does not exist");
  if (time["kind"] === "single") return { kind: "single", name: String(time["name"]) };
  if (time["kind"] !== "periodic") throw new TypeError("Time node kind is unsupported");
  return {
    kind: "periodic",
    name: String(time["name"]),
    count: time["count"] as number,
    prefix: typeof time["prefix"] === "string" ? time["prefix"] : null,
    unit: typeof time["unit"] === "string" ? time["unit"] : null,
    displayEmpty: time["display_empty"] === true
  };
}

function displayFor(system: JsonObject, node: string): TimeNodeDisplay {
  if (node.startsWith("p")) {
    const preset = (terranPreset.nodes as JsonObject[]).find((entry) => entry["id"] === node);
    if (!preset) throw new TypeError("Terran preset does not exist");
    return { name: String(preset["name"]), kind: String(preset["kind"]) };
  }
  const variant = object(object(system["variants"])?.[node]);
  if (variant) return { name: String(variant["name"]), kind: "timeline" };
  const time = object(object(system["times"])?.[node]);
  if (!time) throw new TypeError("Time node does not exist");
  return { name: String(time["name"]), kind: String(time["kind"]), ...(typeof time["count"] === "number" ? { count: time["count"] } : {}) };
}

function childrenFor(system: JsonObject, node: string): TimeChildDraft[] {
  const raw = object(system["contains"])?.[node];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): TimeChildDraft[] => isJsonObject(entry) && typeof entry["node"] === "string"
    ? [{ node: entry["node"], ...(isJsonObject(entry["occurrences"]) ? { occurrences: structuredClone(entry["occurrences"]) } : {}), display: displayFor(system, entry["node"]) }]
    : []);
}

function counterpartsFor(system: JsonObject, node: string): TimeCounterpartDraft[] {
  if (!Array.isArray(system["counterparts"])) return [];
  return system["counterparts"].flatMap((entry): TimeCounterpartDraft[] => {
    if (!isJsonObject(entry) || !isJsonObject(entry["left"]) || !isJsonObject(entry["right"])) return [];
    const left = entry["left"];
    const right = entry["right"];
    const leftNode = left["node"];
    const rightNode = right["node"];
    if (leftNode !== node && rightNode !== node) return [];
    const self = leftNode === node ? left : right;
    const target = leftNode === node ? right : left;
    if (typeof target["node"] !== "string") return [];
    return [{
      target: {
        node: target["node"],
        ...(isJsonObject(target["occurrences"]) ? { occurrences: structuredClone(target["occurrences"]) } : {}),
        display: displayFor(system, target["node"])
      },
      ...(isJsonObject(self["occurrences"]) ? { selfOccurrences: structuredClone(self["occurrences"]) } : {})
    }];
  });
}

function mappingsFor(system: JsonObject, node: string): TimeMappingDraft[] {
  if (!Array.isArray(system["terran_mappings"])) return [];
  return system["terran_mappings"].flatMap((entry): TimeMappingDraft[] => {
    if (!isJsonObject(entry) || !isJsonObject(entry["target"]) || entry["target"]["node"] !== node || !isJsonObject(entry["range"])) return [];
    return [{
      ...(isJsonObject(entry["target"]["occurrences"]) ? { occurrences: structuredClone(entry["target"]["occurrences"]) } : {}),
      range: structuredClone(entry["range"])
    }];
  });
}

async function archiveTitles(libraryRoot: string, library: JsonObject): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const catalog = await readCatalogCache(libraryRoot);
  if (catalog && Array.isArray(catalog["archives"])) {
    for (const raw of catalog["archives"]) {
      if (!isJsonObject(raw) || typeof raw["archive"] !== "string") continue;
      result.set(raw["archive"], typeof raw["source_title"] === "string" ? raw["source_title"] : raw["archive"]);
    }
  }
  for (const [archive, raw] of Object.entries(object(library["archives"]) ?? {})) {
    if (isJsonObject(raw) && typeof raw["conversation_name"] === "string") result.set(archive, raw["conversation_name"]);
    else if (!result.has(archive)) result.set(archive, archive);
  }
  return result;
}

function archiveReferences(library: JsonObject, titles: ReadonlyMap<string, string>): ArchiveTimeReference[] {
  const result: ArchiveTimeReference[] = [];
  for (const [archive, raw] of Object.entries(object(library["archives"]) ?? {})) {
    const state = object(raw);
    const content = object(state?.["content_time"]);
    const range = content?.["state"] === "set" ? object(content["range"]) : undefined;
    if (!range) continue;
    const endpoints: ArchiveTimeReference["endpoints"][number][] = [];
    for (const side of ["start", "end"] as const) {
      const endpoint = object(range[side]);
      if (endpoint?.["kind"] !== "sovereign" || !isJsonObject(endpoint["target"])) continue;
      endpoints.push({ side, target: structuredClone(endpoint["target"]) });
    }
    if (endpoints.length > 0) result.push({ archive, title: titles.get(archive) ?? archive, endpoints });
  }
  return result;
}

export async function queryTimeEditorContext(libraryRoot: string, node: string): Promise<TimeEditorContext> {
  const authority = await readCurrentAuthorityPair(libraryRoot);
  const metadata = metadataFor(authority.time, node);
  const owner = ownerVariant(authority.time, node);
  const raw = node.startsWith("p")
    ? undefined
    : object(metadata.kind === "timeline" ? object(authority.time["variants"])?.[node] : object(authority.time["times"])?.[node]);
  const references = archiveReferences(authority.library, await archiveTitles(libraryRoot, authority.library));
  const relevant = owner ? ownedNodes(authority.time, owner) : new Set<string>([node]);
  return {
    timeRevision: authority.time["revision"] as number,
    libraryRevision: authority.library["revision"] as number,
    nodeRevision: nodeRevision(authority.time, node),
    node,
    ...(owner ? { ownerVariant: owner } : {}),
    metadata,
    ...(typeof raw?.["created_at"] === "string" ? { createdAt: raw["created_at"] } : {}),
    editedAt: typeof raw?.["edited_at"] === "string" ? raw["edited_at"] : String(authority.time["edited_at"]),
    ...(typeof raw?.["number"] === "number" ? { variantNumber: raw["number"] } : {}),
    children: childrenFor(authority.time, node),
    counterparts: counterpartsFor(authority.time, node),
    mappings: mappingsFor(authority.time, node),
    references: references.filter((reference) => reference.endpoints.some((endpoint) => relevant.has(String(endpoint.target["node"]))))
  };
}

function normalizedRange(value: JsonObject): JsonObject {
  const range = normalizeRange(value);
  const validation = validateTimeValue(range);
  if (!validation.ok) throw new TypeError(`Time range is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  return validation.value;
}

function normalizeDraft(draft: TimeNodeDraft): TimeNodeDraft {
  let metadata: TimeNodeMetadata;
  if (draft.metadata.kind === "preset") {
    metadata = { kind: "preset", range: draft.metadata.range === null ? null : normalizedRange(draft.metadata.range) };
  } else if (draft.metadata.kind === "timeline") {
    const version = optionalNonEmpty(draft.metadata.version, "Timeline version");
    if (version !== undefined && !/^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/u.test(version)) throw new TypeError("Timeline version is invalid");
    metadata = {
      kind: "timeline",
      name: nonEmpty(draft.metadata.name, "Timeline name"),
      author: nonEmpty(draft.metadata.author, "Timeline author"),
      standardName: optionalNonEmpty(draft.metadata.standardName, "Timeline standard name") ?? null,
      version: version ?? null
    };
  } else if (draft.metadata.kind === "single") {
    metadata = { kind: "single", name: nonEmpty(draft.metadata.name, "Time name") };
  } else {
    if (!Number.isSafeInteger(draft.metadata.count) || draft.metadata.count < 1 || draft.metadata.count > 99_999_999) throw new TypeError("Periodic count is invalid");
    if (draft.metadata.displayEmpty && draft.metadata.count > 20) throw new TypeError("Empty periodic expansion exceeds the V1 limit");
    metadata = {
      kind: "periodic",
      name: nonEmpty(draft.metadata.name, "Time name"),
      count: draft.metadata.count,
      prefix: optionalNonEmpty(draft.metadata.prefix, "Periodic prefix") ?? null,
      unit: optionalNonEmpty(draft.metadata.unit, "Periodic unit") ?? null,
      displayEmpty: draft.metadata.displayEmpty
    };
  }
  return {
    metadata,
    children: draft.children.map((entry) => ({
      node: entry.node,
      ...(entry.occurrences ? { occurrences: structuredClone(entry.occurrences) } : {}),
      ...(entry.display ? { display: { ...entry.display } } : {})
    })),
    counterparts: draft.counterparts.map((entry) => ({
      target: {
        node: entry.target.node,
        ...(entry.target.occurrences ? { occurrences: structuredClone(entry.target.occurrences) } : {}),
        ...(entry.target.display ? { display: { ...entry.target.display } } : {})
      },
      ...(entry.selfOccurrences ? { selfOccurrences: structuredClone(entry.selfOccurrences) } : {})
    })),
    mappings: draft.mappings.map((entry) => ({
      ...(entry.occurrences ? { occurrences: structuredClone(entry.occurrences) } : {}),
      range: normalizedRange(entry.range)
    }))
  };
}

function canonicalCounterpart(left: JsonObject, right: JsonObject): JsonObject {
  return canonicalizeJcs(left) <= canonicalizeJcs(right) ? { left, right } : { left: right, right: left };
}

function assignOptional(target: JsonObject, key: string, value: string | null): void {
  if (value === null) delete target[key];
  else target[key] = value;
}

function replaceRelations(system: JsonObject, node: string, draft: TimeNodeDraft, editedAt: string): void {
  const contains = pool(system, "contains");
  if (draft.children.length === 0) delete contains[node];
  else contains[node] = draft.children.map((entry) => ({
    node: entry.node,
    ...(entry.occurrences ? { occurrences: structuredClone(entry.occurrences) } : {})
  }));
  if (Object.keys(contains).length === 0) delete system["contains"];

  const counterparts = Array.isArray(system["counterparts"])
    ? system["counterparts"].filter((entry) => !isJsonObject(entry)
      || !isJsonObject(entry["left"])
      || !isJsonObject(entry["right"])
      || (entry["left"]["node"] !== node && entry["right"]["node"] !== node)) as JsonObject[]
    : [];
  for (const entry of draft.counterparts) {
    const self: JsonObject = { node, ...(entry.selfOccurrences ? { occurrences: structuredClone(entry.selfOccurrences) } : {}) };
    const target: JsonObject = { node: entry.target.node, ...(entry.target.occurrences ? { occurrences: structuredClone(entry.target.occurrences) } : {}) };
    counterparts.push(canonicalCounterpart(self, target));
  }
  if (counterparts.length === 0) delete system["counterparts"];
  else system["counterparts"] = counterparts;

  const currentMappings = Array.isArray(system["terran_mappings"])
    ? system["terran_mappings"].filter((entry): entry is JsonObject => isJsonObject(entry) && isJsonObject(entry["target"]) && entry["target"]["node"] === node)
    : [];
  const preservedEditedAt = new Map(currentMappings.map((entry) => [
    `${canonicalizeJcs(entry["target"])}|${canonicalizeJcs(entry["range"])}`,
    String(entry["edited_at"])
  ]));
  const mappings = Array.isArray(system["terran_mappings"])
    ? system["terran_mappings"].filter((entry) => !isJsonObject(entry) || !isJsonObject(entry["target"]) || entry["target"]["node"] !== node) as JsonObject[]
    : [];
  for (const entry of draft.mappings) {
    const target: JsonObject = { node, ...(entry.occurrences ? { occurrences: structuredClone(entry.occurrences) } : {}) };
    const range = structuredClone(entry.range);
    const key = `${canonicalizeJcs(target)}|${canonicalizeJcs(range)}`;
    mappings.push({
      target,
      range,
      edited_at: preservedEditedAt.get(key) ?? editedAt
    });
  }
  mappings.sort((left, right) => {
    const leftKey = `${canonicalizeJcs(left["target"])}|${canonicalizeJcs(left["range"])}|${String(left["edited_at"])}`;
    const rightKey = `${canonicalizeJcs(right["target"])}|${canonicalizeJcs(right["range"])}|${String(right["edited_at"])}`;
    return leftKey.localeCompare(rightKey, "en");
  });
  if (mappings.length === 0) delete system["terran_mappings"];
  else system["terran_mappings"] = mappings;
}

type AppliedDraft = Readonly<{ system: JsonObject; node: string; ownerVariant?: string }>;

function applyDraft(
  source: JsonObject,
  action: TimeEditAction,
  requestedNode: string | undefined,
  requestedOwner: string | undefined,
  draft: TimeNodeDraft,
  editedAt: string
): AppliedDraft {
  const system = structuredClone(source);
  if (action === "edit") {
    if (!requestedNode) throw new TypeError("Time edit requires a node");
    if (requestedNode.startsWith("p")) {
      if (draft.metadata.kind !== "preset" || draft.children.length || draft.counterparts.length || draft.mappings.length) throw new TypeError("Terran preset edits only accept one range override");
      const values = object(system["terran_values"]) ?? {};
      if (draft.metadata.range === null) delete values[requestedNode];
      else values[requestedNode] = structuredClone(draft.metadata.range);
      if (Object.keys(values).length === 0) delete system["terran_values"];
      else system["terran_values"] = values;
      return { system, node: requestedNode };
    }
    const owner = ownerVariant(system, requestedNode);
    if (!owner) throw new TypeError("Time node owner is missing");
    const variants = object(system["variants"]);
    const times = object(system["times"]);
    if (requestedNode.startsWith("v")) {
      if (draft.metadata.kind !== "timeline" || !variants || !isJsonObject(variants[requestedNode])) throw new TypeError("Timeline metadata is invalid");
      const raw = variants[requestedNode] as JsonObject;
      raw["name"] = draft.metadata.name;
      raw["author"] = draft.metadata.author;
      assignOptional(raw, "standard_name", draft.metadata.standardName);
      assignOptional(raw, "version", draft.metadata.version);
    } else {
      if ((draft.metadata.kind !== "single" && draft.metadata.kind !== "periodic") || !times || !isJsonObject(times[requestedNode])) throw new TypeError("Time metadata is invalid");
      const raw = times[requestedNode] as JsonObject;
      raw["kind"] = draft.metadata.kind;
      raw["name"] = draft.metadata.name;
      for (const key of ["count", "prefix", "unit", "display_empty"] as const) delete raw[key];
      if (draft.metadata.kind === "periodic") {
        raw["count"] = draft.metadata.count;
        if (draft.metadata.prefix !== null) raw["prefix"] = draft.metadata.prefix;
        if (draft.metadata.unit !== null) raw["unit"] = draft.metadata.unit;
        if (draft.metadata.displayEmpty) raw["display_empty"] = true;
      }
    }
    replaceRelations(system, requestedNode, draft, editedAt);
    return { system, node: requestedNode, ownerVariant: owner };
  }

  const next = object(system["next"]);
  if (!next) throw new TypeError("Time allocation watermarks are missing");
  if (action === "create_timeline") {
    if (draft.metadata.kind !== "timeline") throw new TypeError("New timeline metadata is invalid");
    const lineageId = `l${next["lineage"]}`;
    const variantId = `v${next["variant"]}`;
    const lineages = pool(system, "lineages");
    const variants = pool(system, "variants");
    lineages[lineageId] = { id: lineageId, current: variantId, next_variant: 2 };
    variants[variantId] = {
      id: variantId,
      lineage: lineageId,
      number: 1,
      revision: 1,
      name: draft.metadata.name,
      author: draft.metadata.author,
      ...(draft.metadata.standardName === null ? {} : { standard_name: draft.metadata.standardName }),
      ...(draft.metadata.version === null ? {} : { version: draft.metadata.version }),
      created_at: editedAt,
      edited_at: editedAt
    };
    next["lineage"] = (next["lineage"] as number) + 1;
    next["variant"] = (next["variant"] as number) + 1;
    const display = Array.isArray(system["display_order"]) ? system["display_order"].filter((entry): entry is string => typeof entry === "string") : [];
    system["display_order"] = [variantId, ...display];
    replaceRelations(system, variantId, draft, editedAt);
    return { system, node: variantId, ownerVariant: variantId };
  }

  if ((draft.metadata.kind !== "single" && draft.metadata.kind !== "periodic") || !requestedOwner) throw new TypeError("New time requires a timeline owner");
  const variants = object(system["variants"]);
  if (!variants || !isJsonObject(variants[requestedOwner])) throw new TypeError("New time owner is invalid");
  const timeId = `t${next["time"]}`;
  const times = pool(system, "times");
  times[timeId] = {
    id: timeId,
    owner: requestedOwner,
    kind: draft.metadata.kind,
    name: draft.metadata.name,
    ...(draft.metadata.kind === "periodic" ? {
      count: draft.metadata.count,
      ...(draft.metadata.prefix === null ? {} : { prefix: draft.metadata.prefix }),
      ...(draft.metadata.unit === null ? {} : { unit: draft.metadata.unit }),
      ...(draft.metadata.displayEmpty ? { display_empty: true } : {})
    } : {}),
    created_at: editedAt,
    edited_at: editedAt
  };
  next["time"] = (next["time"] as number) + 1;
  const contains = pool(system, "contains");
  const existing = Array.isArray(contains[requestedOwner]) ? contains[requestedOwner] as JsonValue[] : [];
  contains[requestedOwner] = [{
    node: timeId,
    ...(draft.metadata.kind === "periodic" ? { occurrences: { mode: "prefix", count: draft.metadata.count } } : {})
  }, ...existing];
  replaceRelations(system, timeId, draft, editedAt);
  return { system, node: timeId, ownerVariant: requestedOwner };
}

function systemSemanticKey(system: JsonObject): string {
  const copy = structuredClone(system);
  delete copy["revision"];
  delete copy["edited_at"];
  for (const raw of Object.values(object(copy["variants"]) ?? {})) {
    if (isJsonObject(raw)) {
      delete raw["revision"];
      delete raw["edited_at"];
    }
  }
  for (const raw of Object.values(object(copy["times"]) ?? {})) if (isJsonObject(raw)) delete raw["edited_at"];
  return canonicalizeJcs(copy);
}

function proposedCounts(node: string, draft: TimeNodeDraft): Readonly<Record<string, number>> {
  return draft.metadata.kind === "periodic" && !node.startsWith("p") ? { [node]: draft.metadata.count } : {};
}

function selectorRemovalImpacts(
  candidate: JsonObject,
  node: string,
  draft: TimeNodeDraft,
  references: readonly ArchiveTimeReference[],
  wasPeriodic: boolean
): VariantImpact["invalidSelectors"] {
  if (!wasPeriodic || draft.metadata.kind !== "single") return [];
  const result: VariantImpact["invalidSelectors"][number][] = [];
  for (const reference of references) {
    reference.endpoints.forEach((endpoint, index) => {
      if (endpoint.target["node"] === node && endpoint.target["occurrences"] !== undefined) {
        result.push({ kind: "archive", path: `/archives/${reference.archive}/endpoints/${index}`, node, newCount: 0 });
      }
    });
  }
  for (const [parent, raw] of Object.entries(object(candidate["contains"]) ?? {})) {
    if (!Array.isArray(raw)) continue;
    raw.forEach((entry, index) => {
      if (isJsonObject(entry) && entry["node"] === node && entry["occurrences"] !== undefined) {
        result.push({ kind: "contains", path: `/contains/${parent}/${index}`, node, newCount: 0 });
      }
    });
  }
  if (Array.isArray(candidate["counterparts"])) candidate["counterparts"].forEach((entry, index) => {
    if (!isJsonObject(entry)) return;
    for (const side of ["left", "right"] as const) {
      const ref = object(entry[side]);
      if (ref?.["node"] === node && ref["occurrences"] !== undefined) result.push({ kind: "counterpart", path: `/counterparts/${index}/${side}`, node, newCount: 0 });
    }
  });
  if (Array.isArray(candidate["terran_mappings"])) candidate["terran_mappings"].forEach((entry, index) => {
    const target = isJsonObject(entry) ? object(entry["target"]) : undefined;
    if (target?.["node"] === node && target["occurrences"] !== undefined) result.push({ kind: "mapping", path: `/terran_mappings/${index}/target`, node, newCount: 0 });
  });
  return result;
}

export async function prepareTimeEditPlan(input: Readonly<{
  libraryRoot: string;
  action: TimeEditAction;
  node?: string;
  ownerVariant?: string;
  expectedTimeRevision: number;
  expectedLibraryRevision: number;
  expectedNodeRevision: number;
  draft: TimeNodeDraft;
  cancelArchives?: ReadonlySet<string>;
}>): Promise<TimeEditPlan> {
  const authority = await readCurrentAuthorityPair(input.libraryRoot);
  if (authority.time["revision"] !== input.expectedTimeRevision || authority.library["revision"] !== input.expectedLibraryRevision) throw new TypeError("Time authority changed before preview");
  if (input.action === "edit" && (!input.node || nodeRevision(authority.time, input.node) !== input.expectedNodeRevision)) throw new TypeError("Time node changed before preview");
  if (input.action === "create_time" && (!input.ownerVariant || nodeRevision(authority.time, input.ownerVariant) !== input.expectedNodeRevision)) throw new TypeError("Timeline owner changed before preview");
  const draft = normalizeDraft(input.draft);
  const previewTimestamp = "2000-01-01T00:00:00.000Z";
  const applied = applyDraft(authority.time, input.action, input.node, input.ownerVariant, draft, previewTimestamp);
  const graphChanged = input.action !== "edit" || systemSemanticKey(applied.system) !== systemSemanticKey(authority.time);
  const allReferences = archiveReferences(authority.library, await archiveTitles(input.libraryRoot, authority.library));
  const cancelArchives = input.cancelArchives ?? new Set<string>();
  if (input.action !== "edit" && cancelArchives.size > 0) throw new TypeError("New time nodes cannot cancel existing references");
  const applicable = applied.ownerVariant ? ownedNodes(authority.time, applied.ownerVariant) : new Set<string>([applied.node]);
  const cancellable = new Set(allReferences.filter((reference) => reference.endpoints.some((endpoint) => applicable.has(String(endpoint.target["node"])))).map((reference) => reference.archive));
  if ([...cancelArchives].some((archive) => !cancellable.has(archive))) throw new TypeError("Time reference cancellation is invalid");
  const references = allReferences.filter((reference) => !cancelArchives.has(reference.archive));
  const noChange = !graphChanged && cancelArchives.size === 0;
  const analyzed = applied.ownerVariant && input.action === "edit" && graphChanged
    ? analyzeVariantImpact(applied.system, applied.ownerVariant, references, proposedCounts(applied.node, draft))
    : {
      variant: applied.ownerVariant ?? applied.node,
      affectedArchives: [],
      externalLinks: [],
      invalidSelectors: [],
      strategies: ["in_place"] as const
    };
  const selectorRemoval = input.action === "edit" && input.node
    ? selectorRemovalImpacts(
      applied.system,
      input.node,
      draft,
      references,
      object(object(authority.time["times"])?.[input.node])?.["kind"] === "periodic"
    )
    : [];
  const invalidSelectors = [...analyzed.invalidSelectors];
  for (const entry of selectorRemoval) {
    if (!invalidSelectors.some((current) => current.kind === entry.kind && current.path === entry.path)) invalidSelectors.push(entry);
  }
  const impact: VariantImpact = { ...analyzed, invalidSelectors };
  const validation = validateTimeSystem(applied.system);
  if (!validation.ok) {
    const expectedSelectorIssue = (issue: { code: string; path: string }) => issue.code === "CLOUDIG_TIME_INVALID_SELECTOR"
      && impact.invalidSelectors.some((entry) => issue.path.startsWith(entry.path));
    if (!validation.issues.every(expectedSelectorIssue)) throw new TypeError(`Time draft is invalid: ${validation.issues.map((entry) => `${entry.path}:${entry.code}`).join(",")}`);
  }
  return {
    action: input.action,
    ...(input.node ? { node: input.node } : {}),
    ...(applied.ownerVariant ? { ownerVariant: applied.ownerVariant } : {}),
    expectedTimeRevision: input.expectedTimeRevision,
    expectedLibraryRevision: input.expectedLibraryRevision,
    expectedNodeRevision: input.expectedNodeRevision,
    timeFingerprint: authority.timeFingerprint,
    libraryFingerprint: authority.libraryFingerprint,
    draft,
    graphChanged,
    cancelArchives,
    noChange,
    impact,
    references,
    canCommit: impact.invalidSelectors.length === 0
  };
}

export async function prepareTimeDeletePlan(input: Readonly<{
  libraryRoot: string;
  node: string;
  expectedTimeRevision: number;
  expectedLibraryRevision: number;
  expectedNodeRevision: number;
}>): Promise<TimeDeletePlan> {
  if (input.node.startsWith("p")) throw new TypeError("Built-in Terran presets cannot be deleted");
  const authority = await readCurrentAuthorityPair(input.libraryRoot);
  if (authority.time["revision"] !== input.expectedTimeRevision || authority.library["revision"] !== input.expectedLibraryRevision) {
    throw new TypeError("Time authority changed before delete preview");
  }
  if (nodeRevision(authority.time, input.node) !== input.expectedNodeRevision) throw new TypeError("Time node changed before delete preview");
  const references = archiveReferences(authority.library, await archiveTitles(input.libraryRoot, authority.library));
  const impact = analyzeTimeDeleteImpact(authority.time, input.node, references);
  const displayIds = new Set<string>(impact.deletedNodes);
  for (const link of [...impact.parents, ...impact.children, ...impact.internalContains]) {
    displayIds.add(link.parent);
    displayIds.add(link.child);
  }
  for (const relation of impact.counterparts) {
    if (typeof relation.left["node"] === "string") displayIds.add(relation.left["node"]);
    if (typeof relation.right["node"] === "string") displayIds.add(relation.right["node"]);
  }
  for (const id of impact.replacementVariants) displayIds.add(id);
  const displays: Record<string, TimeNodeDisplay> = {};
  for (const id of displayIds) displays[id] = displayFor(authority.time, id);
  return {
    node: input.node,
    expectedTimeRevision: input.expectedTimeRevision,
    expectedLibraryRevision: input.expectedLibraryRevision,
    expectedNodeRevision: input.expectedNodeRevision,
    timeFingerprint: authority.timeFingerprint,
    libraryFingerprint: authority.libraryFingerprint,
    impact,
    displays
  };
}

function refreshEndpointAnchor(value: JsonValue, anchor: Readonly<{ date: string; offset: string }>): JsonValue {
  if (!isJsonObject(value)) return structuredClone(value);
  const next = structuredClone(value);
  if (next["kind"] === "now" || next["kind"] === "relative") next["anchor"] = { ...anchor };
  return next;
}

function refreshRangeAnchor(range: JsonObject, anchor: Readonly<{ date: string; offset: string }>): JsonObject {
  const next: JsonObject = { start: refreshEndpointAnchor(range["start"]!, anchor) };
  if (range["end"] !== undefined) next["end"] = refreshEndpointAnchor(range["end"]!, anchor);
  return normalizedRange(next);
}

function refreshDraftAnchors(draft: TimeNodeDraft, anchor: Readonly<{ date: string; offset: string }>): TimeNodeDraft {
  const metadata = draft.metadata.kind === "preset" && draft.metadata.range !== null
    ? { kind: "preset" as const, range: refreshRangeAnchor(draft.metadata.range, anchor) }
    : draft.metadata;
  return {
    metadata,
    children: draft.children,
    counterparts: draft.counterparts,
    mappings: draft.mappings.map((entry) => ({ ...entry, range: refreshRangeAnchor(entry.range, anchor) }))
  };
}

function finalizeInPlace(system: JsonObject, node: string, owner: string | undefined, timestamp: string): void {
  system["revision"] = (system["revision"] as number) + 1;
  system["edited_at"] = timestamp;
  if (!owner) return;
  const variant = object(object(system["variants"])?.[owner]);
  if (!variant) throw new TypeError("Edited timeline owner disappeared");
  variant["revision"] = (variant["revision"] as number) + 1;
  variant["edited_at"] = timestamp;
  const time = object(object(system["times"])?.[node]);
  if (time) time["edited_at"] = timestamp;
}

function fingerprint(bytes: Buffer): Readonly<{ bytes: number; sha256: string }> {
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function sameFingerprint(left: Readonly<{ bytes: number; sha256: string }>, right: Readonly<{ bytes: number; sha256: string }>): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function updateArchiveSnapshots(
  library: JsonObject,
  system: JsonObject,
  impactedVariant: string,
  timestamp: string,
  selected: ReadonlySet<string> | undefined,
  nodeMap: Readonly<Record<string, string>> = {}
): void {
  const owned = ownedNodes(system, nodeMap[impactedVariant] ?? impactedVariant);
  const archives = object(library["archives"]);
  if (!archives) return;
  for (const [archive, raw] of Object.entries(archives)) {
    if (selected && !selected.has(archive)) continue;
    const state = object(raw);
    const content = object(state?.["content_time"]);
    const range = content?.["state"] === "set" ? object(content["range"]) : undefined;
    if (!state || !range) continue;
    let changed = false;
    const nextRange = structuredClone(range);
    for (const side of ["start", "end"] as const) {
      const endpoint = object(nextRange[side]);
      const target = object(endpoint?.["target"]);
      const oldNode = typeof target?.["node"] === "string" ? target["node"] : undefined;
      if (endpoint?.["kind"] !== "sovereign" || !target || !oldNode) continue;
      const mappedNode = nodeMap[oldNode] ?? oldNode;
      if (!owned.has(mappedNode)) continue;
      const mappedTarget = structuredClone(target);
      mappedTarget["node"] = mappedNode;
      const snapshot = buildSovereignSnapshot(system, mappedTarget, 100_000);
      if (snapshot.status !== "ok") throw new TypeError(`Sovereign snapshot refresh failed: ${snapshot.status}`);
      nextRange[side] = { kind: "sovereign", target: mappedTarget, snapshot: snapshot.snapshot };
      changed = true;
    }
    if (!changed) continue;
    state["content_time"] = { state: "set", range: normalizeRange(nextRange) };
    state["revision"] = (state["revision"] as number) + 1;
    state["edited_at"] = timestamp;
  }
}

function clearArchiveReferences(library: JsonObject, archivesToClear: ReadonlySet<string>, timestamp: string): void {
  const archives = object(library["archives"]);
  if (!archives) return;
  for (const archive of archivesToClear) {
    const state = object(archives[archive]);
    if (!state) throw new TypeError("Time reference disappeared before cancellation");
    state["content_time"] = { state: "cleared" };
    state["revision"] = (state["revision"] as number) + 1;
    state["edited_at"] = timestamp;
  }
}

function authorityMatches(authority: AuthorityPair, plan: Readonly<{
  expectedTimeRevision: number;
  expectedLibraryRevision: number;
  timeFingerprint: Readonly<{ bytes: number; sha256: string }>;
  libraryFingerprint: Readonly<{ bytes: number; sha256: string }>;
}>): boolean {
  return authority.time["revision"] === plan.expectedTimeRevision
    && authority.library["revision"] === plan.expectedLibraryRevision
    && sameFingerprint(authority.timeFingerprint, plan.timeFingerprint)
    && sameFingerprint(authority.libraryFingerprint, plan.libraryFingerprint);
}

async function installAuthorityPair(input: Readonly<{
  libraryRoot: string;
  authority: AuthorityPair;
  nextTime: JsonObject;
  nextLibrary: JsonObject;
  timeChanged: boolean;
  timestamp: string;
  transaction: string;
  recoveryTransaction: string;
  intent: string;
}>): Promise<Readonly<{ status: "updated"; authority: AuthorityPair }> | Readonly<{ status: "conflict"; reason: string }>> {
  const timeBytes = input.timeChanged ? Buffer.from(serializeTimeSystem(input.nextTime), "utf8") : input.authority.timeBytes;
  const timeFingerprint = input.timeChanged ? fingerprint(timeBytes) : input.authority.timeFingerprint;
  input.nextLibrary["content_time"] = {
    schema: "cloudig/time-system/1.0.0",
    revision: input.nextTime["revision"]!,
    sha256: timeFingerprint.sha256
  };
  const libraryBytes = Buffer.from(serializeLibrary(input.nextLibrary), "utf8");
  const recovery = await capturePreviousAuthority(input.libraryRoot, {
    transaction: input.recoveryTransaction,
    recordedAt: input.timestamp,
    alreadyCapturedThisBatch: false
  });
  if (recovery === "conflict") return { status: "conflict", reason: "recovery_point_conflict" };
  const targets: JsonObject[] = [{
    action: "replace",
    path: "cloudig-library.json",
    status: "planned",
    expected_before: { state: "present", ...input.authority.libraryFingerprint },
    semantic: { kind: "library" }
  }];
  const streams = new Map<number, Readable>([[0, Readable.from([libraryBytes])]]);
  if (input.timeChanged) {
    targets.push({
      action: "replace",
      path: "Data/State/content-time.json",
      status: "planned",
      expected_before: { state: "present", ...input.authority.timeFingerprint },
      semantic: { kind: "time_system" }
    });
    streams.set(1, Readable.from([timeBytes]));
  }
  const journal: JsonObject = {
    schema: "cloudig/transaction/1.0.0",
    transaction: input.transaction,
    state: "planned",
    intent: input.intent,
    created_at: input.timestamp,
    updated_at: input.timestamp,
    authority: {
      library: { state: "present", revision: input.authority.library["revision"]!, sha256: input.authority.libraryFingerprint.sha256 },
      time: { state: "present", revision: input.authority.time["revision"]!, sha256: input.authority.timeFingerprint.sha256 }
    },
    targets
  };
  const staged = await stageJournalTargets(input.libraryRoot, journal, streams);
  const committed = await installJournal(input.libraryRoot, staged);
  if (committed["state"] !== "committed") return { status: "conflict", reason: "transaction_precondition_changed" };
  const installed = await readCurrentAuthorityPair(input.libraryRoot);
  if (installed.time["revision"] !== input.nextTime["revision"] || installed.library["revision"] !== input.nextLibrary["revision"]) {
    throw new TypeError("Time transaction installed the wrong authority revisions");
  }
  const cleaned = await cleanupJournal(input.libraryRoot, committed);
  await removeCleanJournalFiles(input.libraryRoot, input.transaction);
  if (cleaned["state"] !== "cleaned") throw new TypeError("Time transaction cleanup failed");
  return { status: "updated", authority: installed };
}

export async function commitTimeDisplayOrder(input: Readonly<{
  libraryRoot: string;
  expectedTimeRevision: number;
  expectedLibraryRevision: number;
  order: readonly string[];
  timestamp: string;
  transaction: string;
  recoveryTransaction: string;
}>): Promise<Readonly<{ status: "updated" | "unchanged"; timeRevision: number; libraryRevision: number }> | Readonly<{ status: "conflict"; reason: string }>> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Order and recovery transactions must differ");
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    if (authority.time["revision"] !== input.expectedTimeRevision || authority.library["revision"] !== input.expectedLibraryRevision) return { status: "conflict", reason: "authority_changed" };
    const variants = new Set(Object.keys(object(authority.time["variants"]) ?? {}));
    if (input.order.length !== variants.size || new Set(input.order).size !== variants.size || input.order.some(id => !variants.has(id))) throw new TypeError("Display order must contain every current timeline exactly once");
    const previous = Array.isArray(authority.time["display_order"]) ? authority.time["display_order"] : [];
    if (previous.length === input.order.length && previous.every((id, index) => id === input.order[index])) return { status: "unchanged", timeRevision: input.expectedTimeRevision, libraryRevision: input.expectedLibraryRevision };
    const nextTime = structuredClone(authority.time);
    if (input.order.length) nextTime["display_order"] = [...input.order]; else delete nextTime["display_order"];
    nextTime["revision"] = input.expectedTimeRevision + 1;
    nextTime["edited_at"] = input.timestamp;
    const nextLibrary = structuredClone(authority.library);
    nextLibrary["revision"] = input.expectedLibraryRevision + 1;
    nextLibrary["edited_at"] = input.timestamp;
    const result = await installAuthorityPair({ libraryRoot: input.libraryRoot, authority, nextTime, nextLibrary, timeChanged: true, timestamp: input.timestamp, transaction: input.transaction, recoveryTransaction: input.recoveryTransaction, intent: "reorder-content-time" });
    if (result.status === "conflict") return result;
    return { status: "updated", timeRevision: result.authority.time["revision"] as number, libraryRevision: result.authority.library["revision"] as number };
  } finally { await writer.release(); }
}

export async function commitTimeEditPlan(input: Readonly<{
  libraryRoot: string;
  plan: TimeEditPlan;
  strategy: "in_place" | "all_references" | "selected_references" | "future_only";
  selectedArchives: ReadonlySet<string>;
  touchOnNoop: boolean;
  anchor: Readonly<{ date: string; offset: string }>;
  timestamp: string;
  transaction: string;
  recoveryTransaction: string;
}>): Promise<TimeEditCommitResult> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Time edit and recovery transactions must differ");
  if (!input.plan.canCommit) throw new TypeError("Time edit has unresolved selector impacts");
  if (input.plan.noChange && !input.touchOnNoop) {
    if (input.selectedArchives.size > 0) throw new TypeError("A zero-write time edit cannot select references");
    return {
      status: "unchanged",
      timeRevision: input.plan.expectedTimeRevision,
      libraryRevision: input.plan.expectedLibraryRevision,
      ...(input.plan.node ? { node: input.plan.node } : {})
    };
  }
  if (!input.plan.impact.strategies.includes(input.strategy)) throw new TypeError("Time edit strategy is not available");
  if (input.strategy === "selected_references") {
    const allowed = new Set(input.plan.impact.affectedArchives.map((entry) => entry.archive));
    if (input.selectedArchives.size < 1 || [...input.selectedArchives].some((archive) => !allowed.has(archive))) throw new TypeError("Selected time references are invalid");
  } else if (input.selectedArchives.size > 0) throw new TypeError("Selected references require selected_references strategy");
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    if (!authorityMatches(authority, input.plan)) return { status: "conflict", reason: "authority_changed" };
    const draft = refreshDraftAnchors(input.plan.draft, input.anchor);
    let node = input.plan.node;
    let owner = input.plan.ownerVariant;
    let nodeMap: Readonly<Record<string, string>> = {};
    let nextTime: JsonObject;
    const timeChanged = input.plan.graphChanged || input.plan.noChange;

    if (input.plan.noChange) {
      if (!node) throw new TypeError("No-op time edit lost its node");
      nextTime = applyDraft(authority.time, "edit", node, owner, draft, input.timestamp).system;
      owner = ownerVariant(nextTime, node);
      finalizeInPlace(nextTime, node, owner, input.timestamp);
    } else if (!input.plan.graphChanged) {
      nextTime = structuredClone(authority.time);
      if (!node) throw new TypeError("Reference cancellation lost its edited node");
      owner = ownerVariant(nextTime, node);
    } else if (input.strategy === "selected_references" || input.strategy === "future_only") {
      if (!input.plan.node || !owner) throw new TypeError("Variant fork requires an existing user node");
      const cloned = cloneVariantState(
        authority.time,
        owner,
        input.strategy,
        input.plan.references,
        input.selectedArchives,
        input.timestamp
      );
      nodeMap = cloned.nodeMap;
      node = cloned.nodeMap[input.plan.node];
      owner = cloned.nodeMap[owner];
      if (!node || !owner) throw new TypeError("Variant fork did not map the edited node");
      const forkDraft: TimeNodeDraft = {
        ...draft,
        children: draft.children.map(child => ({ ...child, node: nodeMap[child.node] ?? child.node })),
        counterparts: draft.counterparts.map(link => ({ ...link, target: { ...link.target, node: nodeMap[link.target.node] ?? link.target.node } }))
      };
      nextTime = applyDraft(cloned.system, "edit", node, owner, forkDraft, input.timestamp).system;
      const time = object(object(nextTime["times"])?.[node]);
      if (time) time["edited_at"] = input.timestamp;
    } else {
      const applied = applyDraft(authority.time, input.plan.action, input.plan.node, input.plan.ownerVariant, draft, input.timestamp);
      nextTime = applied.system;
      node = applied.node;
      owner = applied.ownerVariant;
      if (input.plan.action === "create_timeline") {
        nextTime["revision"] = (nextTime["revision"] as number) + 1;
        nextTime["edited_at"] = input.timestamp;
      } else {
        finalizeInPlace(nextTime, node, owner, input.timestamp);
      }
    }

    const validation = validateTimeSystem(nextTime);
    if (!validation.ok) throw new TypeError(`Committed Time System is invalid: ${validation.issues.map((entry) => `${entry.path}:${entry.code}`).join(",")}`);
    const nextLibrary = structuredClone(authority.library);
    nextLibrary["revision"] = (nextLibrary["revision"] as number) + 1;
    nextLibrary["edited_at"] = input.timestamp;
    clearArchiveReferences(nextLibrary, input.plan.cancelArchives, input.timestamp);
    const impacted = input.plan.impact.variant;
    if (input.plan.noChange && owner) {
      updateArchiveSnapshots(nextLibrary, nextTime, owner, input.timestamp, undefined);
    } else if (input.strategy === "all_references" && owner) {
      updateArchiveSnapshots(nextLibrary, nextTime, owner, input.timestamp, undefined);
    } else if (input.strategy === "selected_references" && owner) {
      updateArchiveSnapshots(nextLibrary, nextTime, impacted, input.timestamp, input.selectedArchives, nodeMap);
    }
    const installedResult = await installAuthorityPair({
      libraryRoot: input.libraryRoot,
      authority,
      nextTime,
      nextLibrary,
      timeChanged,
      timestamp: input.timestamp,
      transaction: input.transaction,
      recoveryTransaction: input.recoveryTransaction,
      intent: "update-content-time"
    });
    if (installedResult.status === "conflict") return installedResult;
    const installed = installedResult.authority;
    return {
      status: "updated",
      timeRevision: installed.time["revision"] as number,
      libraryRevision: installed.library["revision"] as number,
      node: node!,
      ...(owner ? { ownerVariant: owner } : {}),
      editedAt: input.timestamp
    };
  } finally {
    await writer.release();
  }
}

export async function commitTimeDeletePlan(input: Readonly<{
  libraryRoot: string;
  plan: TimeDeletePlan;
  replacementVariant?: string;
  clearReferences: boolean;
  timestamp: string;
  transaction: string;
  recoveryTransaction: string;
}>): Promise<TimeDeleteCommitResult> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Time deletion and recovery transactions must differ");
  const hasReferences = input.plan.impact.affectedArchives.length > 0;
  if (hasReferences !== input.clearReferences) {
    throw new TypeError(hasReferences ? "Time deletion requires explicit reference clearing" : "Time deletion has no references to clear");
  }
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    if (!authorityMatches(authority, input.plan)) return { status: "conflict", reason: "authority_changed" };
    if (nodeRevision(authority.time, input.plan.node) !== input.plan.expectedNodeRevision) return { status: "conflict", reason: "node_changed" };
    const deleted = deleteTimeNodeState(authority.time, input.plan.node, input.replacementVariant, input.timestamp);
    const nextLibrary = structuredClone(authority.library);
    nextLibrary["revision"] = (nextLibrary["revision"] as number) + 1;
    nextLibrary["edited_at"] = input.timestamp;
    clearArchiveReferences(nextLibrary, new Set(input.plan.impact.affectedArchives.map((entry) => entry.archive)), input.timestamp);
    const installedResult = await installAuthorityPair({
      libraryRoot: input.libraryRoot,
      authority,
      nextTime: deleted.system,
      nextLibrary,
      timeChanged: true,
      timestamp: input.timestamp,
      transaction: input.transaction,
      recoveryTransaction: input.recoveryTransaction,
      intent: "delete-content-time-node"
    });
    if (installedResult.status === "conflict") return installedResult;
    return {
      status: "updated",
      timeRevision: installedResult.authority.time["revision"] as number,
      libraryRevision: installedResult.authority.library["revision"] as number,
      deletedNodes: deleted.deletedNodes,
      editedAt: input.timestamp
    };
  } finally {
    await writer.release();
  }
}
