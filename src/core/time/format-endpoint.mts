import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";

export type TimeLocale = "zh-CN" | "en";

const ZH_UNITS: Record<string, string> = {
  wan: "万",
  yi: "亿",
  zhao: "兆",
  jing: "京",
  gai: "垓",
  zi: "秭",
  rang: "穰",
  gou: "沟",
  jian: "涧",
  zheng: "正"
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function ordinal(value: number): string {
  const remainder100 = value % 100;
  if (remainder100 >= 11 && remainder100 <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th"}`;
}

export function formatCalendar(endpoint: JsonObject, locale: TimeLocale): string {
  const era = endpoint["era"] as "AD" | "BC";
  const year = endpoint["year"] as number;
  const month = endpoint["month"] as number | undefined;
  const day = endpoint["day"] as number | undefined;
  const hour = endpoint["hour"] as number | undefined;
  const minute = endpoint["minute"] as number | undefined;
  const second = endpoint["second"] as number | undefined;
  const offset = endpoint["offset"] as string | undefined;
  const zh = locale === "zh-CN";
  if (day === undefined) {
    if (zh) return `${era === "BC" ? "公元前" : ""}${year}年${month === undefined ? "" : `${month}月`}`;
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${month === undefined ? "" : `${months[month - 1]} `}${year}${era === "BC" ? " BC" : ""}`;
  }
  let result = `${String(year).padStart(4, "0")}-${pad(month!)}-${pad(day)}`;
  if (hour !== undefined) result += minute === undefined ? ` ${pad(hour)}${zh ? "时" : "h"}` : ` ${pad(hour)}:${pad(minute)}`;
  if (second !== undefined) result += `:${pad(second)}`;
  if (offset !== undefined) result += ` (UTC${offset === "Z" ? "+00:00" : offset})`;
  return era === "BC" ? (zh ? `公元前${result}` : `${result} BC`) : result;
}

function formatSovereign(endpoint: JsonObject, locale: TimeLocale): string {
  const snapshot = isJsonObject(endpoint["snapshot"]) ? endpoint["snapshot"] : undefined;
  const timeline = snapshot && isJsonObject(snapshot["timeline"]) ? snapshot["timeline"] : undefined;
  const target = snapshot && isJsonObject(snapshot["target"]) ? snapshot["target"] : undefined;
  const reference = isJsonObject(endpoint["target"]) ? endpoint["target"] : undefined;
  const timelineName = typeof timeline?.["name"] === "string" ? timeline["name"] : "";
  const targetName = typeof target?.["name"] === "string" ? target["name"] : String(reference?.["node"] ?? "");
  const occurrences = reference && isJsonObject(reference["occurrences"]) ? reference["occurrences"] : undefined;
  let occurrence = "";
  if (occurrences?.["mode"] === "progression") {
    const first = occurrences["first"];
    const last = occurrences["last"];
    const step = occurrences["step"];
    occurrence = locale === "zh-CN"
      ? `（第${first}${first === last ? "" : `–${last}${step === 1 ? "" : `，步长${step}`}`}）`
      : ` (${first}${first === last ? "" : `–${last}${step === 1 ? "" : `, step ${step}`}`})`;
  }
  return timelineName && timelineName !== targetName ? `${timelineName} · ${targetName}${occurrence}` : `${targetName}${occurrence}`;
}

export function formatEndpoint(value: JsonValue, locale: TimeLocale): string {
  if (!isJsonObject(value)) throw new TypeError("Endpoint must be an object");
  switch (value["kind"]) {
    case "calendar":
      return formatCalendar(value, locale);
    case "decade": {
      const label = `${(value["index"] as number) * 10}s`;
      return value["era"] === "BC" ? `${label} BC` : label;
    }
    case "century": {
      const index = value["index"] as number;
      if (locale === "zh-CN") return `${value["era"] === "BC" ? "公元前" : "公元"}${index}世纪`;
      return `${ordinal(index)} century ${value["era"]}`;
    }
    case "relative": {
      const unit = String(value["unit"]);
      const amount = String(value["value"]);
      const before = value["direction"] === "before";
      return locale === "zh-CN"
        ? `${amount}${ZH_UNITS[unit] ?? unit}年${before ? "前" : "后"}`
        : `${amount} ${unit} years ${before ? "before" : "after"}`;
    }
    case "now": return locale === "zh-CN" ? "现今" : "Now";
    case "infinite_past": return locale === "zh-CN" ? "无限久前" : "Infinite past";
    case "infinite_future": return locale === "zh-CN" ? "无限久后" : "Infinite future";
    case "unknown": return locale === "zh-CN" ? "不知何时" : "Unknown time";
    case "whenever": return locale === "zh-CN" ? "无论何时" : "Whenever";
    case "sovereign": return formatSovereign(value, locale);
    default: throw new TypeError(`Unsupported endpoint kind ${String(value["kind"])}`);
  }
}
