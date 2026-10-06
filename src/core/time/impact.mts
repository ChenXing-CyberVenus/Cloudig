import { canonicalizeJcs } from "../contracts/deterministic-json.mts";
import { validateTimeSystem } from "../contracts/semantic-time.mts";
import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";

export type ArchiveTimeReference = Readonly<{
  archive: string;
  title: string;
  endpoints: ReadonlyArray<Readonly<{
    side: "start" | "end";
    target: JsonObject;
  }>>;
}>;

export type VariantImpact = Readonly<{
  variant: string;
  affectedArchives: ReadonlyArray<{ archive: string; title: string; endpoints: number }>;
  externalLinks: ReadonlyArray<{ kind: "contains_incoming" | "contains_outgoing" | "counterpart"; path: string; externalNode: string; ownedNode: string }>;
  invalidSelectors: ReadonlyArray<{ kind: "archive" | "contains" | "counterpart" | "mapping"; path: string; node: string; newCount: number }>;
  strategies: readonly ("in_place" | "all_references" | "selected_references" | "future_only")[];
}>;

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function ownedNodes(system: JsonObject, variant: string): Set<string> {
  const owned = new Set<string>([variant]);
  const times = object(system["times"]);
  if (times) {
    for (const [id, raw] of Object.entries(times)) {
      if (isJsonObject(raw) && raw["owner"] === variant) owned.add(id);
    }
  }
  return owned;
}

function selectorExceeds(selector: JsonValue | undefined, newCount: number): boolean {
  if (!isJsonObject(selector) || selector["mode"] === "all") return false;
  if (selector["mode"] === "prefix") return typeof selector["count"] === "number" && selector["count"] > newCount;
  return selector["mode"] === "progression" && typeof selector["last"] === "number" && selector["last"] > newCount;
}

export function analyzeVariantImpact(
  system: JsonObject,
  variant: string,
  archiveReferences: readonly ArchiveTimeReference[],
  proposedPeriodicCounts: Readonly<Record<string, number>> = {}
): VariantImpact {
  const owned = ownedNodes(system, variant);
  const affectedArchives: Array<{ archive: string; title: string; endpoints: number }> = [];
  const invalidSelectors: Array<{ kind: "archive" | "contains" | "counterpart" | "mapping"; path: string; node: string; newCount: number }> = [];
  for (const reference of archiveReferences) {
    let count = 0;
    reference.endpoints.forEach((endpoint, index) => {
      const node = endpoint.target["node"];
      if (typeof node !== "string" || !owned.has(node)) return;
      count += 1;
      const newCount = proposedPeriodicCounts[node];
      if (newCount !== undefined && selectorExceeds(endpoint.target["occurrences"], newCount)) {
        invalidSelectors.push({ kind: "archive", path: `/archives/${reference.archive}/endpoints/${index}`, node, newCount });
      }
    });
    if (count > 0) affectedArchives.push({ archive: reference.archive, title: reference.title, endpoints: count });
  }

  const externalLinks: Array<{ kind: "contains_incoming" | "contains_outgoing" | "counterpart"; path: string; externalNode: string; ownedNode: string }> = [];
  const contains = object(system["contains"]);
  if (contains) {
    for (const [parent, rawLinks] of Object.entries(contains)) {
      if (!Array.isArray(rawLinks)) continue;
      rawLinks.forEach((raw, index) => {
        if (!isJsonObject(raw) || typeof raw["node"] !== "string") return;
        const child = raw["node"];
        if (!owned.has(parent) && owned.has(child)) {
          externalLinks.push({ kind: "contains_incoming", path: `/contains/${parent}/${index}`, externalNode: parent, ownedNode: child });
        } else if (owned.has(parent) && !owned.has(child)) {
          externalLinks.push({ kind: "contains_outgoing", path: `/contains/${parent}/${index}`, externalNode: child, ownedNode: parent });
        }
        const newCount = proposedPeriodicCounts[child];
        if (newCount !== undefined && selectorExceeds(raw["occurrences"], newCount)) {
          invalidSelectors.push({ kind: "contains", path: `/contains/${parent}/${index}`, node: child, newCount });
        }
      });
    }
  }

  const counterparts = system["counterparts"];
  if (Array.isArray(counterparts)) {
    counterparts.forEach((raw, index) => {
      if (!isJsonObject(raw)) return;
      const left = object(raw["left"]);
      const right = object(raw["right"]);
      if (!left || !right || typeof left["node"] !== "string" || typeof right["node"] !== "string") return;
      const leftOwned = owned.has(left["node"]);
      const rightOwned = owned.has(right["node"]);
      if (leftOwned !== rightOwned) {
        externalLinks.push({
          kind: "counterpart",
          path: `/counterparts/${index}`,
          externalNode: leftOwned ? right["node"] : left["node"],
          ownedNode: leftOwned ? left["node"] : right["node"]
        });
      }
      for (const [side, reference] of [["left", left], ["right", right]] as const) {
        const node = reference["node"] as string;
        const newCount = proposedPeriodicCounts[node];
        if (newCount !== undefined && selectorExceeds(reference["occurrences"], newCount)) {
          invalidSelectors.push({ kind: "counterpart", path: `/counterparts/${index}/${side}`, node, newCount });
        }
      }
    });
  }

  const mappings = system["terran_mappings"];
  if (Array.isArray(mappings)) {
    mappings.forEach((raw, index) => {
      const target = isJsonObject(raw) ? object(raw["target"]) : undefined;
      const node = target?.["node"];
      if (typeof node !== "string") return;
      const newCount = proposedPeriodicCounts[node];
      if (newCount !== undefined && selectorExceeds(target?.["occurrences"], newCount)) {
        invalidSelectors.push({ kind: "mapping", path: `/terran_mappings/${index}/target`, node, newCount });
      }
    });
  }

  const requiresChoice = affectedArchives.length > 0 || externalLinks.length > 0;
  return {
    variant,
    affectedArchives,
    externalLinks,
    invalidSelectors,
    strategies: requiresChoice ? ["all_references", "selected_references", "future_only"] : ["in_place"]
  };
}

export type TimeDeleteContainsLink = Readonly<{
  parent: string;
  child: string;
  occurrences?: JsonObject;
}>;

export type TimeDeleteImpact = Readonly<{
  node: string;
  kind: "variant" | "time";
  deletedNodes: readonly string[];
  parents: readonly TimeDeleteContainsLink[];
  children: readonly TimeDeleteContainsLink[];
  internalContains: readonly TimeDeleteContainsLink[];
  counterparts: ReadonlyArray<Readonly<{ left: JsonObject; right: JsonObject }>>;
  mappings: ReadonlyArray<Readonly<{ target: JsonObject; range: JsonObject }>>;
  affectedArchives: readonly ArchiveTimeReference[];
  currentVariant: boolean;
  replacementVariants: readonly string[];
}>;

function numericNodeOrder(left: string, right: string): number {
  const prefix = left[0]!.localeCompare(right[0]!, "en");
  return prefix || Number(left.slice(1)) - Number(right.slice(1));
}

export function analyzeTimeDeleteImpact(
  system: JsonObject,
  node: string,
  archiveReferences: readonly ArchiveTimeReference[]
): TimeDeleteImpact {
  const variants = object(system["variants"]);
  const times = object(system["times"]);
  const variant = variants ? object(variants[node]) : undefined;
  const time = times ? object(times[node]) : undefined;
  if (!variant && !time) throw new TypeError("Time delete target does not exist or is built in");
  const deleted = variant ? ownedNodes(system, node) : new Set([node]);
  const parents: TimeDeleteContainsLink[] = [];
  const children: TimeDeleteContainsLink[] = [];
  const internalContains: TimeDeleteContainsLink[] = [];
  for (const [parent, rawLinks] of Object.entries(object(system["contains"]) ?? {})) {
    if (!Array.isArray(rawLinks)) continue;
    for (const raw of rawLinks) {
      if (!isJsonObject(raw) || typeof raw["node"] !== "string") continue;
      const child = raw["node"];
      const link: TimeDeleteContainsLink = {
        parent,
        child,
        ...(isJsonObject(raw["occurrences"]) ? { occurrences: structuredClone(raw["occurrences"]) } : {})
      };
      const parentDeleted = deleted.has(parent);
      const childDeleted = deleted.has(child);
      if (parentDeleted && childDeleted) internalContains.push(link);
      else if (childDeleted) parents.push(link);
      else if (parentDeleted) children.push(link);
    }
  }

  const counterparts = Array.isArray(system["counterparts"])
    ? system["counterparts"].flatMap((raw): Array<{ left: JsonObject; right: JsonObject }> => {
      if (!isJsonObject(raw) || !isJsonObject(raw["left"]) || !isJsonObject(raw["right"])) return [];
      const leftNode = raw["left"]["node"];
      const rightNode = raw["right"]["node"];
      return (typeof leftNode === "string" && deleted.has(leftNode)) || (typeof rightNode === "string" && deleted.has(rightNode))
        ? [{ left: structuredClone(raw["left"]), right: structuredClone(raw["right"]) }]
        : [];
    })
    : [];
  const mappings = Array.isArray(system["terran_mappings"])
    ? system["terran_mappings"].flatMap((raw): Array<{ target: JsonObject; range: JsonObject }> => {
      if (!isJsonObject(raw) || !isJsonObject(raw["target"]) || !isJsonObject(raw["range"])) return [];
      return typeof raw["target"]["node"] === "string" && deleted.has(raw["target"]["node"] as string)
        ? [{ target: structuredClone(raw["target"]), range: structuredClone(raw["range"]) }]
        : [];
    })
    : [];
  const affectedArchives = archiveReferences.flatMap((reference): ArchiveTimeReference[] => {
    const endpoints = reference.endpoints.filter((endpoint) => typeof endpoint.target["node"] === "string" && deleted.has(endpoint.target["node"] as string));
    return endpoints.length > 0 ? [{ ...reference, endpoints }] : [];
  });

  let currentVariant = false;
  let replacementVariants: string[] = [];
  if (variant && typeof variant["lineage"] === "string") {
    const lineage = object(object(system["lineages"])?.[variant["lineage"]]);
    currentVariant = lineage?.["current"] === node;
    replacementVariants = Object.entries(variants ?? {})
      .filter(([id, raw]) => id !== node && isJsonObject(raw) && raw["lineage"] === variant["lineage"])
      .sort((left, right) => Number((left[1] as JsonObject)["number"]) - Number((right[1] as JsonObject)["number"]))
      .map(([id]) => id);
  }
  return {
    node,
    kind: variant ? "variant" : "time",
    deletedNodes: [...deleted].sort(numericNodeOrder),
    parents,
    children,
    internalContains,
    counterparts,
    mappings,
    affectedArchives,
    currentVariant,
    replacementVariants
  };
}

export function deleteTimeNodeState(
  source: JsonObject,
  node: string,
  replacementVariant: string | undefined,
  editedAt: string
): Readonly<{ system: JsonObject; deletedNodes: readonly string[] }> {
  const next = structuredClone(source);
  const variants = object(next["variants"]);
  const times = object(next["times"]);
  const variant = variants ? object(variants[node]) : undefined;
  const time = times ? object(times[node]) : undefined;
  if (!variant && !time) throw new TypeError("Time delete target does not exist or is built in");
  const deleted = variant ? ownedNodes(next, node) : new Set([node]);

  if (variant) {
    if (typeof variant["lineage"] !== "string") throw new TypeError("Deleted variant has no lineage");
    const lineages = object(next["lineages"]);
    const lineage = object(lineages?.[variant["lineage"]]);
    if (!lineages || !lineage) throw new TypeError("Deleted variant lineage does not exist");
    const siblings = Object.entries(variants ?? {})
      .filter(([id, raw]) => id !== node && isJsonObject(raw) && raw["lineage"] === variant["lineage"])
      .map(([id]) => id);
    const deletingCurrent = lineage["current"] === node;
    if (deletingCurrent && siblings.length > 0) {
      if (!replacementVariant || !siblings.includes(replacementVariant)) throw new TypeError("Deleting the current variant requires a surviving replacement");
      lineage["current"] = replacementVariant;
    } else if (replacementVariant !== undefined) {
      throw new TypeError("A replacement variant is not available for this deletion");
    }
    delete variants![node];
    for (const id of deleted) if (id !== node && times) delete times[id];
    if (times && Object.keys(times).length === 0) delete next["times"];
    if (siblings.length === 0) delete lineages[variant["lineage"] as string];
    if (Object.keys(variants!).length === 0) delete next["variants"];
    if (Object.keys(lineages).length === 0) delete next["lineages"];
    const display = Array.isArray(next["display_order"])
      ? next["display_order"].filter((entry) => entry !== node)
      : [];
    if (display.length > 0) next["display_order"] = display;
    else delete next["display_order"];
  } else {
    const owner = typeof time!["owner"] === "string" ? object(variants?.[time!["owner"]]) : undefined;
    delete times![node];
    if (Object.keys(times!).length === 0) delete next["times"];
    if (owner) {
      owner["revision"] = (owner["revision"] as number) + 1;
      owner["edited_at"] = editedAt;
    }
  }

  const contains = object(next["contains"]);
  if (contains) {
    for (const id of deleted) delete contains[id];
    for (const [parent, rawLinks] of Object.entries(contains)) {
      if (!Array.isArray(rawLinks)) continue;
      const kept = rawLinks.filter((raw) => !isJsonObject(raw) || typeof raw["node"] !== "string" || !deleted.has(raw["node"]));
      if (kept.length > 0) contains[parent] = kept;
      else delete contains[parent];
    }
    if (Object.keys(contains).length === 0) delete next["contains"];
  }
  if (Array.isArray(next["counterparts"])) {
    const kept = next["counterparts"].filter((raw) => !isJsonObject(raw)
      || !isJsonObject(raw["left"])
      || !isJsonObject(raw["right"])
      || ![raw["left"]["node"], raw["right"]["node"]].some((id) => typeof id === "string" && deleted.has(id)));
    if (kept.length > 0) next["counterparts"] = kept;
    else delete next["counterparts"];
  }
  if (Array.isArray(next["terran_mappings"])) {
    const kept = next["terran_mappings"].filter((raw) => !isJsonObject(raw)
      || !isJsonObject(raw["target"])
      || typeof raw["target"]["node"] !== "string"
      || !deleted.has(raw["target"]["node"] as string));
    if (kept.length > 0) next["terran_mappings"] = kept;
    else delete next["terran_mappings"];
  }
  next["revision"] = (next["revision"] as number) + 1;
  next["edited_at"] = editedAt;
  const validation = validateTimeSystem(next);
  if (!validation.ok) throw new TypeError(`Time deletion produced invalid Time System: ${validation.issues.map((entry) => entry.code).join(",")}`);
  return { system: next, deletedNodes: [...deleted].sort(numericNodeOrder) };
}

export type VariantPatch = Readonly<{
  name?: string;
  author?: string;
  standard_name?: string | null;
  version?: string | null;
}>;

export type CloneVariantResult = Readonly<{
  system: JsonObject;
  nodeMap: Readonly<Record<string, string>>;
  archiveRetargets: ReadonlyArray<ArchiveTimeReference>;
}>;

function numericId(left: string, right: string): number {
  return Number(left.slice(1)) - Number(right.slice(1));
}

function mappedRef(value: JsonObject, nodeMap: Readonly<Record<string, string>>): JsonObject {
  const copy = structuredClone(value);
  const node = copy["node"];
  if (typeof node === "string" && nodeMap[node]) copy["node"] = nodeMap[node]!;
  return copy;
}

function canonicalCounterpart(value: JsonObject): JsonObject {
  const left = object(value["left"]);
  const right = object(value["right"]);
  if (!left || !right) return value;
  return canonicalizeJcs(left) <= canonicalizeJcs(right) ? { left, right } : { left: right, right: left };
}

function applyVariantPatch(variant: JsonObject, patch: VariantPatch): void {
  for (const field of ["name", "author"] as const) {
    if (patch[field] !== undefined) variant[field] = patch[field]!;
  }
  for (const field of ["standard_name", "version"] as const) {
    const value = patch[field];
    if (value === null) delete variant[field];
    else if (value !== undefined) variant[field] = value;
  }
}

export function cloneVariantState(
  system: JsonObject,
  variantId: string,
  strategy: "selected_references" | "future_only",
  archiveReferences: readonly ArchiveTimeReference[],
  selectedArchives: ReadonlySet<string>,
  editedAt: string,
  patch: VariantPatch = {}
): CloneVariantResult {
  const nextSystem = structuredClone(system);
  const variants = object(nextSystem["variants"]);
  const times = object(nextSystem["times"]);
  const lineages = object(nextSystem["lineages"]);
  const next = object(nextSystem["next"]);
  const oldVariant = variants ? object(variants[variantId]) : undefined;
  if (!variants || !times || !lineages || !next || !oldVariant || typeof oldVariant["lineage"] !== "string") {
    throw new TypeError("Variant clone requires a validated user Time System");
  }
  const lineage = object(lineages[oldVariant["lineage"]]);
  if (!lineage || typeof next["variant"] !== "number" || typeof next["time"] !== "number" || typeof lineage["next_variant"] !== "number") {
    throw new TypeError("Variant clone allocation state is incomplete");
  }

  const newVariantId = `v${next["variant"]}`;
  const ownedTimeIds = Object.entries(times)
    .filter(([, raw]) => isJsonObject(raw) && raw["owner"] === variantId)
    .map(([id]) => id)
    .sort(numericId);
  const nodeMap: Record<string, string> = { [variantId]: newVariantId };
  ownedTimeIds.forEach((id, index) => { nodeMap[id] = `t${next["time"] as number + index}`; });

  const newVariant = structuredClone(oldVariant);
  newVariant["id"] = newVariantId;
  newVariant["number"] = lineage["next_variant"];
  newVariant["revision"] = 1;
  newVariant["created_at"] = editedAt;
  newVariant["edited_at"] = editedAt;
  applyVariantPatch(newVariant, patch);
  variants[newVariantId] = newVariant;

  for (const oldId of ownedTimeIds) {
    const oldTime = object(times[oldId])!;
    const newTime = structuredClone(oldTime);
    newTime["id"] = nodeMap[oldId]!;
    newTime["owner"] = newVariantId;
    newTime["created_at"] = editedAt;
    newTime["edited_at"] = editedAt;
    times[nodeMap[oldId]!] = newTime;
  }

  const contains = object(nextSystem["contains"]);
  if (contains) {
    for (const oldParent of [variantId, ...ownedTimeIds]) {
      const links = contains[oldParent];
      if (!Array.isArray(links)) continue;
      contains[nodeMap[oldParent]!] = links.map((raw) => isJsonObject(raw) ? mappedRef(raw, nodeMap) : raw);
    }
  }

  const counterparts = nextSystem["counterparts"];
  if (Array.isArray(counterparts)) {
    const additions: JsonObject[] = [];
    const existing = new Set(counterparts.filter(isJsonObject).map((entry) => canonicalizeJcs(entry)));
    for (const raw of counterparts) {
      if (!isJsonObject(raw) || !isJsonObject(raw["left"]) || !isJsonObject(raw["right"])) continue;
      const leftNode = raw["left"]["node"];
      const rightNode = raw["right"]["node"];
      if ((typeof leftNode !== "string" || !nodeMap[leftNode]) && (typeof rightNode !== "string" || !nodeMap[rightNode])) continue;
      const copy = canonicalCounterpart({ left: mappedRef(raw["left"], nodeMap), right: mappedRef(raw["right"], nodeMap) });
      const key = canonicalizeJcs(copy);
      if (!existing.has(key)) {
        existing.add(key);
        additions.push(copy);
      }
    }
    counterparts.push(...additions);
  }

  const mappings = nextSystem["terran_mappings"];
  if (Array.isArray(mappings)) {
    const additions: JsonObject[] = [];
    for (const raw of mappings) {
      if (!isJsonObject(raw) || !isJsonObject(raw["target"]) || typeof raw["target"]["node"] !== "string") continue;
      if (!nodeMap[raw["target"]["node"]]) continue;
      const copy = structuredClone(raw);
      copy["target"] = mappedRef(raw["target"], nodeMap);
      copy["edited_at"] = editedAt;
      additions.push(copy);
    }
    mappings.push(...additions);
    mappings.sort((left, right) => {
      const leftObject = left as JsonObject;
      const rightObject = right as JsonObject;
      const leftKey = `${canonicalizeJcs(leftObject["target"])}|${canonicalizeJcs(leftObject["range"])}|${String(leftObject["edited_at"])}`;
      const rightKey = `${canonicalizeJcs(rightObject["target"])}|${canonicalizeJcs(rightObject["range"])}|${String(rightObject["edited_at"])}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }

  lineage["current"] = newVariantId;
  lineage["next_variant"] = (lineage["next_variant"] as number) + 1;
  next["variant"] = (next["variant"] as number) + 1;
  next["time"] = (next["time"] as number) + ownedTimeIds.length;
  nextSystem["revision"] = (nextSystem["revision"] as number) + 1;
  nextSystem["edited_at"] = editedAt;

  const archiveRetargets: ArchiveTimeReference[] = [];
  if (strategy === "selected_references") {
    for (const reference of archiveReferences) {
      if (!selectedArchives.has(reference.archive)) continue;
      let changed = false;
      const endpoints = reference.endpoints.map((endpoint) => {
        const node = endpoint.target["node"];
        if (typeof node === "string" && nodeMap[node]) changed = true;
        return { side: endpoint.side, target: mappedRef(endpoint.target, nodeMap) };
      });
      if (changed) archiveRetargets.push({ ...reference, endpoints });
    }
  }

  const validation = validateTimeSystem(nextSystem);
  if (!validation.ok) throw new TypeError(`Variant clone produced invalid Time System: ${validation.issues.map((entry) => entry.code).join(",")}`);
  return { system: nextSystem, nodeMap, archiveRetargets };
}
