import { canonicalizeJcs } from "../contracts/deterministic-json.mts";
import { validateSovereignSnapshot } from "../contracts/semantic-time.mts";
import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";
import { selectorIntersects } from "./selectors.mts";
import { compareTerranProjection, projectTerranEndpoint } from "./terran.mts";

export type CanonicalPathResult =
  | Readonly<{ status: "found"; path: readonly number[]; visited: number }>
  | Readonly<{ status: "unreachable"; visited: number }>
  | Readonly<{ status: "budget_exceeded"; visited: number }>;

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

/** The same top-level order feeds the Time sidebar and unmapped archive sorting. */
export function orderedTimeVariants(system: JsonObject): string[] {
  const variants = object(system["variants"]) ?? {};
  const explicit = Array.isArray(system["display_order"])
    ? system["display_order"].filter((id): id is string => typeof id === "string" && isJsonObject(variants[id]))
    : [];
  const selected = new Set(explicit);
  const remaining = Object.keys(variants).filter(id => !selected.has(id) && isJsonObject(variants[id]));
  remaining.sort((left, right) => String((variants[right] as JsonObject)["edited_at"]).localeCompare(String((variants[left] as JsonObject)["edited_at"]), "en") || left.localeCompare(right, "en"));
  return [...explicit, ...remaining];
}

function ownerVariant(system: JsonObject, node: string): string | undefined {
  if (node.startsWith("v") && object(object(system["variants"])?.[node])) return node;
  const time = object(object(system["times"])?.[node]);
  return typeof time?.["owner"] === "string" ? time["owner"] : undefined;
}

export function canonicalPath(system: JsonObject, target: string, traversalBudget: number): CanonicalPathResult {
  if (!Number.isSafeInteger(traversalBudget) || traversalBudget < 1) throw new RangeError("traversalBudget must be a positive safe integer");
  const root = ownerVariant(system, target);
  if (!root) return { status: "unreachable", visited: 0 };
  const contains = object(system["contains"]);
  const visited = new Set<string>();
  const stack: Array<{ node: string; path: number[] }> = [{ node: root, path: [] }];
  let visitCount = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.node)) continue;
    visitCount += 1;
    if (visitCount > traversalBudget) return { status: "budget_exceeded", visited: traversalBudget };
    visited.add(current.node);
    if (current.node === target) return { status: "found", path: current.path, visited: visitCount };
    const links = contains?.[current.node];
    if (!Array.isArray(links)) continue;
    for (let index = links.length - 1; index >= 0; index -= 1) {
      const link = links[index];
      if (!isJsonObject(link) || typeof link["node"] !== "string" || visited.has(link["node"])) continue;
      stack.push({ node: link["node"], path: [...current.path, index + 1] });
    }
  }
  return { status: "unreachable", visited: visitCount };
}

function targetFacts(system: JsonObject, target: string): JsonObject | undefined {
  const variants = object(system["variants"]);
  const variant = object(variants?.[target]);
  if (variant) return { id: target, kind: "variant", name: variant["name"]! };
  const time = object(object(system["times"])?.[target]);
  if (!time) return undefined;
  const facts: JsonObject = { id: target, kind: time["kind"]!, name: time["name"]! };
  for (const field of ["count", "prefix", "unit"] as const) {
    if (time[field] !== undefined) facts[field] = time[field]!;
  }
  return facts;
}

function timelineFacts(system: JsonObject, variantId: string): JsonObject | undefined {
  const variant = object(object(system["variants"])?.[variantId]);
  if (!variant || typeof variant["lineage"] !== "string") return undefined;
  const result: JsonObject = {
    lineage: variant["lineage"],
    variant: variantId,
    number: variant["number"]!,
    revision: variant["revision"]!,
    name: variant["name"]!,
    author: variant["author"]!
  };
  for (const field of ["standard_name", "version"] as const) {
    if (variant[field] !== undefined) result[field] = variant[field]!;
  }
  return result;
}

function mappingMatches(
  mappingTarget: JsonObject,
  endpointTarget: JsonObject,
  periodCount: number | undefined
): boolean {
  if (mappingTarget["node"] !== endpointTarget["node"]) return false;
  if (periodCount === undefined) return mappingTarget["occurrences"] === undefined && endpointTarget["occurrences"] === undefined;
  const left = mappingTarget["occurrences"];
  const right = endpointTarget["occurrences"];
  return left !== undefined && right !== undefined && selectorIntersects(left, right, periodCount);
}

function earliestDirectMapping(system: JsonObject, endpointTarget: JsonObject, facts: JsonObject): JsonObject | undefined {
  const mappings = system["terran_mappings"];
  if (!Array.isArray(mappings)) return undefined;
  const periodCount = facts["kind"] === "periodic" && typeof facts["count"] === "number" ? facts["count"] : undefined;
  let selected: { range: JsonObject; projection: ReturnType<typeof projectTerranEndpoint>; key: string } | undefined;
  for (const raw of mappings) {
    if (!isJsonObject(raw) || !isJsonObject(raw["target"]) || !isJsonObject(raw["range"])) continue;
    if (!mappingMatches(raw["target"], endpointTarget, periodCount)) continue;
    const start = raw["range"]["start"];
    if (start === undefined) continue;
    const projection = projectTerranEndpoint(start);
    if (projection.domain !== "terran_ordered") continue;
    const key = canonicalizeJcs(raw);
    if (!selected) {
      selected = { range: raw["range"], projection, key };
      continue;
    }
    const comparison = compareTerranProjection(projection, selected.projection);
    if (comparison === -1 || (comparison === 0 && key < selected.key)) {
      selected = { range: raw["range"], projection, key };
    }
  }
  return selected ? structuredClone(selected.range) : undefined;
}

export type SnapshotBuildResult =
  | Readonly<{ status: "ok"; snapshot: JsonObject }>
  | Readonly<{ status: "invalid_target" }>
  | Readonly<{ status: "budget_exceeded" }>;

export function buildSovereignSnapshot(
  system: JsonObject,
  endpointTarget: JsonObject,
  traversalBudget: number
): SnapshotBuildResult {
  const target = endpointTarget["node"];
  if (typeof target !== "string") return { status: "invalid_target" };
  const variant = ownerVariant(system, target);
  const targetSnapshot = targetFacts(system, target);
  if (!variant || !targetSnapshot) return { status: "invalid_target" };
  const timeline = timelineFacts(system, variant);
  if (!timeline) return { status: "invalid_target" };
  const pathResult = canonicalPath(system, target, traversalBudget);
  if (pathResult.status === "budget_exceeded") return { status: "budget_exceeded" };
  const snapshot: JsonObject = { timeline, target: targetSnapshot };
  if (pathResult.status === "found") snapshot["path"] = [...pathResult.path];
  const sort = earliestDirectMapping(system, endpointTarget, targetSnapshot);
  if (sort) snapshot["sort"] = sort;
  const validation = validateSovereignSnapshot(snapshot);
  return validation.ok ? { status: "ok", snapshot } : { status: "invalid_target" };
}
