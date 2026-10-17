import type { JsonObject } from "../contracts/types.mts";
import table from "./time-presets.json" with { type: "json" };
export const builtinTimeIds: ReadonlySet<string> = new Set(table.nodes.map(n => n.node_id));
export function builtinTimeNode(id: string, input: Readonly<{ timestamp: string; anchor: Readonly<{ date: string; offset: string }> }>): JsonObject {
  const presets = table.nodes as readonly JsonObject[], preset = presets.find(n => n["node_id"] === id); if (!preset) throw new TypeError("Unknown builtin time node");
  const node: JsonObject = { schema: "cloudig/content-time/1.0.0", node_id: id, kind: preset["kind"]!, name: preset["name"]!, edited_at: input.timestamp };
  if (node["kind"] === "timeline") Object.assign(node, { author: "采云", standard_name: "采云此地时间轴", version: "1.0", created_at: input.timestamp, contains: presets.filter(p => p["node_id"] !== id).map(p => ({ node: p["node_id"] })) });
  else if (preset["range"]) {
    const range = structuredClone(preset["range"]) as JsonObject;
    for (const side of ["start", "end"]) {
      const endpoint = range[side] as JsonObject | undefined;
      if (endpoint && ["now", "relative"].includes(String(endpoint["kind"]))) endpoint["anchor"] = { ...input.anchor };
    }
    node["terran_mappings"] = [{ range, edited_at: input.timestamp }];
  }
  return node;
}
export function assertBuiltinTimeRules(node: JsonObject): void {
  const preset = (table.nodes as readonly JsonObject[]).find(p => p["node_id"] === node["node_id"]); if (!preset) return;
  if (node["kind"] !== preset["kind"]) throw new TypeError("A builtin time node keeps its original kind");
  const range = preset["range"] as JsonObject | undefined, start = range?.["start"] as JsonObject | undefined;
  if (!start || !["unknown", "whenever", "infinite_past", "infinite_future"].includes(String(start["kind"]))) return;
  const mappings = node["terran_mappings"] as JsonObject[] | undefined, current = mappings?.[0]?.["range"] as JsonObject | undefined;
  if (mappings?.length !== 1 || !current || Object.keys(current).length !== 1 || JSON.stringify(current["start"]) !== JSON.stringify(start)) throw new TypeError("This special builtin time cannot be assigned a concrete time");
}
