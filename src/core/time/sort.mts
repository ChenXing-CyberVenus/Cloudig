import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";
import { rangeDirection, type DirectionState } from "./range.mts";
import { compareTerranProjection, projectTerranEndpoint, type TerranOrderedProjection } from "./terran.mts";

type TieBreak = Readonly<{
  editedAt?: string;
  title: string;
  archive: string;
  path: string;
}>;

type TerranSortDescriptor = TieBreak & Readonly<{
  domain: 0;
  start: TerranOrderedProjection;
  point: boolean;
  end?: TerranOrderedProjection;
  direction: DirectionState;
}>;

type SovereignSortDescriptor = TieBreak & Readonly<{
  domain: 1;
  variantOrder: number;
  variant: string;
  ordinalPath?: readonly number[];
  occurrence: readonly number[];
  nodeEditedAt?: string;
  node: string;
  point: boolean;
  direction: DirectionState;
}>;

type SpecialSortDescriptor = TieBreak & Readonly<{
  domain: 2;
  kind: "unknown" | "whenever";
  point: boolean;
  direction: DirectionState;
}>;

type UnsetSortDescriptor = TieBreak & Readonly<{
  domain: 3;
  point: boolean;
  direction: DirectionState;
}>;

export type ContentTimeSortDescriptor =
  | TerranSortDescriptor
  | SovereignSortDescriptor
  | SpecialSortDescriptor
  | UnsetSortDescriptor;

export type ContentTimeSortFacts = Readonly<{
  range?: JsonObject;
  editedAt?: string;
  title: string;
  archive: string;
  path: string;
  variantOrder?: Readonly<Record<string, number>>;
  nodeEditedAt?: Readonly<Record<string, string>>;
}>;

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function mappedProjection(endpoint: JsonObject): TerranOrderedProjection | undefined {
  const snapshot = object(endpoint["snapshot"]);
  const sort = object(snapshot?.["sort"]);
  const start = sort?.["start"];
  if (start === undefined) return undefined;
  const projection = projectTerranEndpoint(start);
  return projection.domain === "terran_ordered" ? projection : undefined;
}

function terranProjection(value: JsonValue | undefined): TerranOrderedProjection | undefined {
  if (!isJsonObject(value)) return undefined;
  if (value["kind"] === "sovereign") return mappedProjection(value);
  const projection = projectTerranEndpoint(value);
  return projection.domain === "terran_ordered" ? projection : undefined;
}

function occurrenceKey(target: JsonObject | undefined): number[] {
  const occurrences = object(target?.["occurrences"]);
  if (!occurrences) return [];
  return ["first", "last", "step"].map((field) => typeof occurrences[field] === "number" ? occurrences[field] : 0);
}

function sovereignDescriptor(
  start: JsonObject,
  facts: ContentTimeSortFacts,
  point: boolean,
  direction: DirectionState
): SovereignSortDescriptor | undefined {
  const target = object(start["target"]);
  const snapshot = object(start["snapshot"]);
  const timeline = object(snapshot?.["timeline"]);
  const path = snapshot?.["path"];
  const variant = timeline?.["variant"];
  const node = target?.["node"];
  if (typeof variant !== "string" || typeof node !== "string") return undefined;
  return {
    domain: 1,
    variantOrder: facts.variantOrder?.[variant] ?? Number.MAX_SAFE_INTEGER,
    variant,
    ...(Array.isArray(path) && path.every((entry) => typeof entry === "number") ? { ordinalPath: path as number[] } : {}),
    occurrence: occurrenceKey(target),
    ...(facts.nodeEditedAt?.[node] === undefined ? {} : { nodeEditedAt: facts.nodeEditedAt[node] }),
    node,
    point,
    direction,
    ...(facts.editedAt === undefined ? {} : { editedAt: facts.editedAt }),
    title: facts.title,
    archive: facts.archive,
    path: facts.path
  };
}

export function buildContentTimeSortDescriptor(facts: ContentTimeSortFacts): ContentTimeSortDescriptor {
  const tie: TieBreak = {
    ...(facts.editedAt === undefined ? {} : { editedAt: facts.editedAt }),
    title: facts.title,
    archive: facts.archive,
    path: facts.path
  };
  const range = facts.range;
  const start = range?.["start"];
  const end = range?.["end"];
  const point = end === undefined;
  const direction = range ? rangeDirection(range) : "indeterminate";
  if (!isJsonObject(start)) return { domain: 3, point, direction, ...tie };
  const startProjection = terranProjection(start);
  if (startProjection) {
    const endProjection = terranProjection(end);
    return {
      domain: 0,
      start: startProjection,
      point,
      ...(endProjection === undefined ? {} : { end: endProjection }),
      direction,
      ...tie
    };
  }
  if (start["kind"] === "sovereign") {
    return sovereignDescriptor(start, facts, point, direction) ?? { domain: 3, point, direction, ...tie };
  }
  if (start["kind"] === "unknown" || start["kind"] === "whenever") {
    return { domain: 2, kind: start["kind"], point, direction, ...tie };
  }
  return { domain: 3, point, direction, ...tie };
}

function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareNumberArrays(left: readonly number[] | undefined, right: readonly number[] | undefined): -1 | 0 | 1 {
  if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? 1 : -1;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return compareNumbers(left.length, right.length);
}

function reverse(comparison: -1 | 0 | 1, descending: boolean): -1 | 0 | 1 {
  return descending ? comparison === 0 ? 0 : comparison === -1 ? 1 : -1 : comparison;
}

const DIRECTION_ORDER: Record<DirectionState, number> = {
  point: 0,
  forward: 1,
  indeterminate: 2,
  reversed: 3
};

function compareTie(left: TieBreak, right: TieBreak): -1 | 0 | 1 {
  const edited = compareStrings(right.editedAt ?? "", left.editedAt ?? "");
  if (edited !== 0) return edited;
  const title = compareStrings(left.title, right.title);
  if (title !== 0) return title;
  const leftArchive = /^a([1-9][0-9]*)$/u.exec(left.archive);
  const rightArchive = /^a([1-9][0-9]*)$/u.exec(right.archive);
  if (leftArchive && rightArchive) {
    const leftNumber = BigInt(leftArchive[1]!);
    const rightNumber = BigInt(rightArchive[1]!);
    if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
  } else {
    const archive = compareStrings(left.archive, right.archive);
    if (archive !== 0) return archive;
  }
  return compareStrings(left.path, right.path);
}

export function compareContentTimeSortDescriptors(
  left: ContentTimeSortDescriptor,
  right: ContentTimeSortDescriptor,
  order: "asc" | "desc"
): -1 | 0 | 1 {
  if (left.domain !== right.domain) return left.domain < right.domain ? -1 : 1;
  const descending = order === "desc";
  if (left.domain === 0 && right.domain === 0) {
    let comparison = compareTerranProjection(left.start, right.start) ?? 0;
    if (comparison !== 0) return reverse(comparison, descending);
    comparison = compareNumbers(left.point ? 0 : 1, right.point ? 0 : 1);
    if (comparison !== 0) return comparison;
    if (left.end && right.end) {
      comparison = compareTerranProjection(left.end, right.end) ?? 0;
      if (comparison !== 0) return reverse(comparison, descending);
    } else if (left.end || right.end) {
      return left.end ? -1 : 1;
    }
  } else if (left.domain === 1 && right.domain === 1) {
    let comparison = compareNumbers(left.variantOrder, right.variantOrder);
    if (comparison === 0) comparison = compareNumberArrays(left.ordinalPath, right.ordinalPath);
    if (comparison === 0) comparison = compareNumberArrays(left.occurrence, right.occurrence);
    if (comparison === 0) comparison = compareStrings(right.nodeEditedAt ?? "", left.nodeEditedAt ?? "");
    if (comparison === 0) comparison = compareStrings(left.node, right.node);
    if (comparison !== 0) return reverse(comparison, descending);
  } else if (left.domain === 2 && right.domain === 2) {
    const comparison = compareStrings(left.kind, right.kind);
    if (comparison !== 0) return comparison;
  }
  const direction = compareNumbers(DIRECTION_ORDER[left.direction], DIRECTION_ORDER[right.direction]);
  return direction !== 0 ? direction : compareTie(left, right);
}
