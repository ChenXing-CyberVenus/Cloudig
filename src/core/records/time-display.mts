import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";
import type { TimeLocale } from "../time/format-endpoint.mts";
import { formatRecordTimeEndpoint } from "./time-labels.mts";
export { formatRecordTimeEndpoint } from "./time-labels.mts";
import { projectTerranEndpoint, compareTerranProjection, type TerranProjection } from "../time/terran.mts";
import { endpointEqual, rangeDirection, type DirectionState } from "../time/range.mts";

const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
export function recordTimeRangeLabels(range: JsonObject, locale: TimeLocale): Readonly<{ start: string; end?: string }> {
  const start = formatRecordTimeEndpoint(object(range["start"]), locale);
  return range["end"] === undefined || endpointEqual(range["start"]!, range["end"]!) ? { start } : { start, end: formatRecordTimeEndpoint(object(range["end"]), locale) };
}
export function formatRecordTimeRange(range: JsonObject, locale: TimeLocale): string {
  const labels = recordTimeRangeLabels(range, locale); return labels.end === undefined ? labels.start : `${labels.start} – ${labels.end}`;
}
export function recordTimeRangeDirection(range: JsonObject): DirectionState {
  if (range["end"] === undefined || endpointEqual(range["start"]!, range["end"]!)) return "point";
  const start = object(range["start"]), end = object(range["end"]);
  const mapped = (v: JsonObject, side: "start" | "end"): JsonValue | undefined => {
    if (v["kind"] !== "node") return v;
    const sort = object(object(v["snapshot"])["sort"]); return side === "end" ? sort["end"] ?? sort["start"] : sort["start"];
  };
  const a = mapped(start, "start"), b = mapped(end, "end"); if (a && b) return rangeDirection({ start: a, end: b });
  if (start["kind"] === "node" && end["kind"] === "node") {
    const ta = object(start["target"]), tb = object(end["target"]);
    if ((ta["timeline"] ?? ta["node"]) !== (tb["timeline"] ?? tb["node"])) return "indeterminate";
    const pa = object(start["snapshot"])["path"], pb = object(end["snapshot"])["path"];
    let order = Array.isArray(pa) && Array.isArray(pb) ? sequence(pa as number[], pb as number[]) : 0;
    if (!order && ta["node"] === tb["node"]) {
      const sa = object(ta["occurrences"]), sb = object(tb["occurrences"]);
      order = sequence(["first", "last", "step"].map(k => Number(sa[k] ?? 0)), ["first", "last", "step"].map(k => Number(sb[k] ?? 0)));
    }
    return order < 0 ? "forward" : order > 0 ? "reversed" : "indeterminate";
  }
  return "indeterminate";
}

type EndpointOrder = { domain: 0; terran: TerranProjection } | { domain: 1; root: string; path: number[]; occurrences: number[]; node: string } | { domain: 2; name: string };
export type RecordContentTimeOrder = Readonly<{ start?: EndpointOrder; end?: EndpointOrder; fileModifiedAt: string; title: string; conversationId: string }>;
function endpointOrder(endpoint: JsonObject, side: "start" | "end"): EndpointOrder {
  if (endpoint["kind"] === "node") {
    const snapshot = object(endpoint["snapshot"]), sort = object(snapshot["sort"]), mapped = side === "end" ? sort["end"] ?? sort["start"] : sort["start"];
    if (mapped) {
      const terran = projectTerranEndpoint(mapped); return terran.domain === "terran_ordered" ? { domain: 0, terran } : { domain: 2, name: String(object(mapped)["kind"]) };
    }
    const target = object(endpoint["target"]), selected = object(target["occurrences"]);
    return { domain: 1, root: String(target["timeline"] ?? target["node"]), node: String(target["node"]), path: Array.isArray(snapshot["path"]) ? snapshot["path"] as number[] : [],
      occurrences: ["first", "last", "step"].filter(k => selected[k] !== undefined).map(k => Number(selected[k])) };
  }
  const terran = projectTerranEndpoint(endpoint);
  return terran.domain === "terran_ordered" ? { domain: 0, terran } : { domain: 2, name: String(endpoint["kind"]) };
}
export function recordContentTimeOrder(input: Readonly<{ range?: JsonObject; fileModifiedAt: string; title: string; conversationId: string }>): RecordContentTimeOrder {
  if (!input.range) return { fileModifiedAt: input.fileModifiedAt, title: input.title, conversationId: input.conversationId };
  const start = object(input.range["start"]), end = input.range["end"];
  const intrinsicEnd = start["kind"] === "node" && object(object(start["snapshot"])["sort"])["end"] !== undefined;
  return { ...input, start: endpointOrder(start, "start"), ...(end !== undefined ? { end: endpointOrder(object(end), "end") } : intrinsicEnd ? { end: endpointOrder(start, "end") } : {}) };
}
const compare = (a: number | string, b: number | string) => a === b ? 0 : a < b ? -1 : 1;
const sequence = (a: readonly number[], b: readonly number[]) => { for (let i = 0; i < Math.min(a.length, b.length); i++) { const result = compare(a[i]!, b[i]!); if (result) return result; } return compare(a.length, b.length); };
function compareEndpoint(a: EndpointOrder, b: EndpointOrder, roots: ReadonlyMap<string, number>): number {
  if (a.domain !== b.domain) return a.domain - b.domain;
  if (a.domain === 0 && b.domain === 0) return compareTerranProjection(a.terran, b.terran) ?? 0;
  if (a.domain === 1 && b.domain === 1) return compare(roots.get(a.root) ?? Number.MAX_SAFE_INTEGER, roots.get(b.root) ?? Number.MAX_SAFE_INTEGER)
    || compare(a.root, b.root) || sequence(a.path, b.path) || sequence(a.occurrences, b.occurrences) || compare(a.node, b.node);
  if (a.domain === 2 && b.domain === 2) return compare(a.name, b.name);
  return 0;
}
export function compareRecordContentTimes(a: RecordContentTimeOrder, b: RecordContentTimeOrder, order: "asc" | "desc", roots: ReadonlyMap<string, number> = new Map()): number {
  if (!a.start || !b.start) { if (!!a.start !== !!b.start) return a.start ? -1 : 1; }
  else {
    // Unmapped and unset values remain after real time in both directions.
    if (a.start.domain !== b.start.domain) return a.start.domain - b.start.domain;
    const sign = order === "asc" ? 1 : -1, beginning = compareEndpoint(a.start, b.start, roots); if (beginning) return beginning * sign;
    if (a.end && b.end) { const ending = compareEndpoint(a.end, b.end, roots); if (ending) return ending * sign; }
    else if (!!a.end !== !!b.end) return a.end ? 1 : -1;
  }
  return compare(Date.parse(b.fileModifiedAt), Date.parse(a.fileModifiedAt)) || compare(a.title, b.title) || compare(a.conversationId, b.conversationId);
}
