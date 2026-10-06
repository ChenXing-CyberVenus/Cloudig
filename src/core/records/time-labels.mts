import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";
import { formatEndpoint, type TimeLocale } from "../time/format-endpoint.mts";

// Shared by browser and Engine. No persistence, hashing or node-only imports.
const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
export function formatRecordTimeEndpoint(value: JsonObject, locale: TimeLocale): string {
  if (value["kind"] !== "node") return formatEndpoint(value, locale);
  const snapshot = object(value["snapshot"]), node = object(snapshot["node"]), timeline = object(snapshot["timeline"]), target = object(value["target"]), selected = object(target["occurrences"]);
  const name = String(node["name"] ?? ""), axis = String(timeline["name"] ?? "");
  let occurrence = "";
  if (node["kind"] === "periodic") {
    const prefix = typeof node["prefix"] === "string" ? node["prefix"] : locale === "zh-CN" ? "第" : "", unit = String(node["unit"] ?? "");
    const item = (v: JsonValue | undefined) => `${prefix}${v}${unit}`;
    occurrence = `（${item(selected["first"])}${selected["last"] === selected["first"] ? "" : `–${item(selected["last"])}${selected["step"] === 1 ? "" : locale === "zh-CN" ? `，步长${selected["step"]}` : `, step ${selected["step"]}`}`}）`;
    if (locale === "en") occurrence = ` ${occurrence.replace("（", "(").replace("）", ")")}`;
  }
  return `${axis && axis !== name ? `${axis} · ` : ""}${name}${occurrence}`;
}
