import { isJsonObject, type JsonObject, type JsonValue } from "../contracts/types.mts";

const obj = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.trim() ? v : undefined;
const first = (...v: (JsonValue | undefined)[]): string | undefined => v.map(text).find(Boolean);
function date(v: JsonValue | undefined): string | undefined {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return;
  const n = typeof v === "number" ? v < 1e12 ? v * 1000 : v : typeof v === "string" ? v : NaN;
  const d = new Date(n); return Number.isFinite(d.valueOf()) ? d.toISOString() : undefined;
}
export function taskStatus(task: JsonObject): "enabled" | "paused" | "completed" | "unknown" {
  if (task["status"] === "completed") return "completed";
  const enabled = task["is_enabled"] ?? task["enabled"];
  if (enabled === false) return "paused";
  if (enabled === true) return "enabled";
  return task["status"] === "active" || task["status"] === "enabled" ? "enabled" : task["status"] === "paused" ? "paused" : "unknown";
}
/** One saved observation, never a live task runner. Full source data remains intact. */
export function taskView(task: JsonObject = {}, row: JsonObject = {}, evidence?: JsonObject): JsonObject {
  const status = taskStatus(task), id = first(task["id"], row["id"]);
  const title = first(task["title"], task["display_title"], row["title"]);
  const schedule = first(task["display_schedule"], row["schedule_label"], task["schedule_label"], task["schedule"]);
  const next = date((Array.isArray(task["next_run_times"]) ? task["next_run_times"][0] : undefined) ?? task["next_run_time"]);
  const last = date(task["last_run_time"]), captured = date(evidence?.["captured_at"]);
  const current = evidence?.["source"] === "automation_api" && captured;
  const conversation = text(task["conversation_id"]), url = first(row["url"], task["url"]);
  const timezone = text(task["default_timezone"]), prompt = first(task["prompt"], row["prompt"]);
  return { status, ...(id ? { id } : {}), ...(title ? { title } : {}), ...(schedule ? { schedule } : {}),
    ...(status === "enabled" || status === "paused" ? { enabled: status === "enabled" } : {}),
    ...(next ? status === "enabled" ? { next_run_at: next } : { planned_run_at: next } : {}),
    ...(last ? { last_run_at: last } : {}), ...(timezone ? { timezone } : {}), ...(prompt ? { prompt } : {}),
    ...(typeof task["notifications_enabled"] === "boolean" ? { notifications_enabled: task["notifications_enabled"] } : {}),
    ...(conversation ? { conversation_url: `https://chatgpt.com/c/${encodeURIComponent(conversation)}` } : {}),
    ...(url ? { url } : {}), ...(current ? { source_evidence: { source: "automation_api", captured_at: captured } } : {}),
    source_task: structuredClone(task) };
}
export function ownedTaskView(components: JsonObject, id: string, row: JsonObject = {}): JsonObject {
  const candidate = obj(obj(components["tasks"])[id]);
  const task = candidate["id"] === id ? candidate : row["id"] === id ? row : { id };
  return taskView(task, row, candidate["id"] === id ? obj(obj(components["task_sources"])[id]) : undefined);
}
/** Legacy JSON remains readable; a paused/completed plan is never labelled next run. */
export function readableTask(view: JsonObject): JsonObject {
  const raw = obj(view["source_task"]), status = taskStatus(Object.keys(raw).length ? raw : view);
  const out: JsonObject = { ...view, status };
  if (status !== "enabled" && out["next_run_at"] !== undefined) { out["planned_run_at"] = out["next_run_at"]!; delete out["next_run_at"]; }
  return out;
}
