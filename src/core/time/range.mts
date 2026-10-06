import { canonicalizeJcs } from "../contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";
import { projectTerranEndpoint } from "./terran.mts";

export type DirectionState = "point" | "forward" | "reversed" | "indeterminate";

export function normalizeEndpoint(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) return value;
  const endpoint = structuredClone(value);
  if (endpoint["kind"] === "relative" && typeof endpoint["value"] === "string" && !endpoint["value"].includes(".")) {
    endpoint["value"] = `${endpoint["value"]}.0`;
  }
  if (isJsonObject(endpoint["anchor"]) && (endpoint["anchor"]["offset"] === "+00:00" || endpoint["anchor"]["offset"] === "-00:00")) {
    endpoint["anchor"]["offset"] = "Z";
  }
  if (endpoint["offset"] === "+00:00" || endpoint["offset"] === "-00:00") endpoint["offset"] = "Z";
  return endpoint;
}

export function endpointEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalizeJcs(normalizeEndpoint(left)) === canonicalizeJcs(normalizeEndpoint(right));
}

export function normalizeRange(value: JsonObject): JsonObject {
  const start = normalizeEndpoint(value["start"]!);
  const end = value["end"] === undefined ? undefined : normalizeEndpoint(value["end"]);
  return end === undefined || endpointEqual(start, end) ? { start } : { start, end };
}

function isSovereign(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value["kind"] === "sovereign";
}

function sovereignVariant(value: JsonObject): string | undefined {
  const snapshot = value["snapshot"];
  const timeline = isJsonObject(snapshot) ? snapshot["timeline"] : undefined;
  return isJsonObject(timeline) && typeof timeline["variant"] === "string" ? timeline["variant"] : undefined;
}

function sovereignPath(value: JsonObject): number[] | undefined {
  const snapshot = value["snapshot"];
  const path = isJsonObject(snapshot) ? snapshot["path"] : undefined;
  return Array.isArray(path) && path.every((entry) => typeof entry === "number") ? path as number[] : undefined;
}

function sovereignTarget(value: JsonObject): JsonObject | undefined {
  return isJsonObject(value["target"]) ? value["target"] : undefined;
}

function compareOccurrences(left: JsonValue | undefined, right: JsonValue | undefined): -1 | 0 | 1 | undefined {
  if (left === undefined && right === undefined) return 0;
  if (!isJsonObject(left) || !isJsonObject(right)) return undefined;
  for (const field of ["first", "last", "step"] as const) {
    const leftValue = left[field];
    const rightValue = right[field];
    if (typeof leftValue !== "number" || typeof rightValue !== "number") return undefined;
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

function compareNumberArrays(left: readonly number[], right: readonly number[]): -1 | 0 | 1 {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

export function rangeDirection(value: JsonObject): DirectionState {
  const range = normalizeRange(value);
  const start = range["start"]!;
  const end = range["end"];
  if (end === undefined || endpointEqual(start, end)) return "point";
  if (isSovereign(start) || isSovereign(end)) {
    if (!isSovereign(start) || !isSovereign(end)) return "indeterminate";
    if (sovereignVariant(start) !== sovereignVariant(end)) return "indeterminate";
    const startPath = sovereignPath(start);
    const endPath = sovereignPath(end);
    if (!startPath || !endPath) return "indeterminate";
    const order = compareNumberArrays(startPath, endPath);
    if (order !== 0) return order < 0 ? "forward" : "reversed";
    const startTarget = sovereignTarget(start);
    const endTarget = sovereignTarget(end);
    if (!startTarget || !endTarget || startTarget["node"] !== endTarget["node"]) return "indeterminate";
    const occurrenceOrder = compareOccurrences(startTarget["occurrences"], endTarget["occurrences"]);
    if (occurrenceOrder === undefined) return "indeterminate";
    return occurrenceOrder === 0 ? "point" : occurrenceOrder < 0 ? "forward" : "reversed";
  }
  const startProjection = projectTerranEndpoint(start);
  const endProjection = projectTerranEndpoint(end);
  if (startProjection.domain !== "terran_ordered" || endProjection.domain !== "terran_ordered") return "indeterminate";
  if (startProjection.segment !== endProjection.segment) {
    return startProjection.segment < endProjection.segment ? "forward" : "reversed";
  }
  if (startProjection.segment !== 20) return "point";
  if (startProjection.lower! > endProjection.upper!) return "reversed";
  if (startProjection.upper! < endProjection.lower!) return "forward";
  return "indeterminate";
}
