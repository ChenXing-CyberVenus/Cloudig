import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { frontName, userModelFront } from "../../core/records/front.mts";
import { normalizeRange } from "../../core/time/range.mts";
import { validateRecordRange } from "../../core/records/index.mts";
import { formatRecordTimeRange, recordTimeRangeDirection } from "../../core/records/time-display.mts";
import { RECORD_TEXT_LIMITS, withinRecordTextLimit } from "../../core/records/text-limits.mts";

export const RECORD_INFO_LIMITS = Object.freeze({ title: RECORD_TEXT_LIMITS.title, models: 128, modelName: RECORD_TEXT_LIMITS.name, name: RECORD_TEXT_LIMITS.name });
export function markSettings(mark?: JsonObject): JsonObject { return Object.fromEntries(Object.entries(mark ?? {}).filter(([key]) => ["conversation_title", "models", "names", "content_time"].includes(key))); }
export function recordInfoDraft(settings: JsonObject): JsonObject {
  return { conversation_name: settings["conversation_title"] === undefined ? { state: "inherit" } : { state: "set", value: settings["conversation_title"]! },
    models: settings["models"] === undefined ? { state: "inherit" } : { state: "set", values: (settings["models"] as JsonObject[]).map(frontName).filter((s): s is string => Boolean(s)) },
    content_time: isJsonObject(settings["content_time"]) ? { state: "set", range: structuredClone(settings["content_time"]["range"]!) } : { state: "inherit" } };
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!isJsonObject(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new TypeError("Invalid conversation editor fields"); return value;
}
export function applyRecordInfoDraft(before: JsonObject, draft: JsonObject, userId: string, timestamp: string): JsonObject {
  exact(draft, ["conversation_name", "models", "content_time"], ["names"]); const next = structuredClone(before);
  const title = exact(draft["conversation_name"], ["state"], ["value"]);
  if (title["state"] === "inherit" && title["value"] === undefined) delete next["conversation_title"];
  else if (title["state"] === "set" && typeof title["value"] === "string" && withinRecordTextLimit(title["value"], RECORD_INFO_LIMITS.title)) { if (title["value"].trim()) next["conversation_title"] = title["value"]; else delete next["conversation_title"]; }
  else throw new TypeError("Invalid edited title");
  const models = exact(draft["models"], ["state"], ["values"]);
  if (models["state"] === "inherit" && models["values"] === undefined) delete next["models"];
  else if (models["state"] === "set" && Array.isArray(models["values"]) && models["values"].length <= RECORD_INFO_LIMITS.models && models["values"].every(n => typeof n === "string" && n.length > 0 && withinRecordTextLimit(n, RECORD_INFO_LIMITS.modelName)) && new Set(models["values"]).size === models["values"].length) {
    const names = models["values"] as string[], old = before["models"] as JsonObject[] | undefined;
    next["models"] = old && isDeepStrictEqual(old.map(frontName), names) ? structuredClone(old) : names.map(n => userModelFront(n, userId, timestamp));
  } else throw new TypeError("Invalid model names");
  const time = exact(draft["content_time"], ["state"], ["range"]);
  if ((time["state"] === "inherit" || time["state"] === "cleared") && time["range"] === undefined) delete next["content_time"];
  else if (time["state"] === "set" && isJsonObject(time["range"])) {
    const range = normalizeRange(time["range"]); if (!validateRecordRange(range).ok) throw new TypeError("Invalid content time range"); next["content_time"] = { range };
  } else throw new TypeError("Invalid content time choice");
  if (draft["names"] !== undefined) {
    const names = exact(draft["names"], [], ["user", "assistant"]), saved = isJsonObject(next["names"]) ? next["names"] : {};
    for (const [key, value] of Object.entries(names)) { if (value === null) delete saved[key]; else if (typeof value === "string" && value.length > 0 && withinRecordTextLimit(value, RECORD_INFO_LIMITS.name)) saved[key] = value; else throw new TypeError("Invalid edited name"); }
    if (Object.keys(saved).length) next["names"] = saved; else delete next["names"];
  }
  return next;
}
export function recordInfoTime(settings: JsonObject, language: "zh-CN" | "en"): JsonObject {
  const range = isJsonObject(settings["content_time"]) ? settings["content_time"]["range"] as JsonObject : undefined;
  return range ? { state: "set", range: structuredClone(range), summary: formatRecordTimeRange(range, language), direction: recordTimeRangeDirection(range) } : { state: "unavailable" };
}
