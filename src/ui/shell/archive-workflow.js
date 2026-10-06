export const defaultArchiveWorkflow = Object.freeze({
  sort: "time_desc",
  time_field: "file_modified_at"
});

const storedToQueryTime = Object.freeze({
  file_modified_at: "json_modified",
  cloudig_edited_at: "cloudig_edited",
  first_parsed_at: "json_created",
  source_captured_at: "source_captured",
  message_start: "message_start",
  message_end: "message_end",
  content_time_start: "content_start",
  content_time_end: "content_end"
});

const queryToStoredTime = new Map(Object.entries(storedToQueryTime).map(([stored, query]) => [query, stored]));

// Metadata timestamps are instants; their calendar label uses this device's
// local date, just like Windows file dates. Civil/content-time values do not use this path.
export function archiveDateLabel(value) {
  if (typeof value !== "string") return "—";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "—";
  return `${String(instant.getFullYear()).padStart(4, "0")}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`;
}

export function archiveInstantLabel(value) {
  const date = archiveDateLabel(value);
  if (date === "—" || /^\d{4}-\d{2}-\d{2}$/u.test(value)) return date;
  const instant = new Date(value), pad = number => String(number).padStart(2, "0"), offset = -instant.getTimezoneOffset();
  return `${date} ${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())} UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function normalizeArchiveWorkflow(value) {
  const sort = value?.sort === "time_asc" || value?.sort === "title" ? value.sort : "time_desc";
  const timeField = Object.hasOwn(storedToQueryTime, value?.time_field) ? value.time_field : defaultArchiveWorkflow.time_field;
  return { sort, time_field: timeField };
}

export function archiveQuerySort(value) {
  return value === "time_asc" ? "content_asc" : value === "title" ? "title" : "content_desc";
}

export function archivePreferenceSort(value) {
  return value === "content_asc" ? "time_asc" : value === "title" ? "title" : "time_desc";
}

export function archiveQueryTimeField(value) {
  return storedToQueryTime[value] ?? storedToQueryTime[defaultArchiveWorkflow.time_field];
}

export function archivePreferenceTimeField(value) {
  return queryToStoredTime.get(value) ?? defaultArchiveWorkflow.time_field;
}

export function archiveTimeFieldLabels(language) {
  return language === "en"
    ? { json_modified: "File last modified", cloudig_edited: "Last Cloudig edit", json_created: "First parsed", source_captured: "Source captured", message_start: "First message", message_end: "Last message", content_start: "Content start", content_end: "Content end" }
    : { json_modified: "文件最后修改时间", cloudig_edited: "采云最后编辑时间", json_created: "首次解析时间", source_captured: "原文件采集时间", message_start: "消息起始时间", message_end: "消息终止时间", content_start: "内容时间起始", content_end: "内容时间终止" };
}

// Both lists use the same display projection. A filesystem observation is not
// a lifecycle timestamp and must never fall back to one when it is absent.
export function archiveRowTimestamp(row, field) {
  if (field === "json_modified") {
    if (typeof row.mtime_ns !== "string" || !/^-?\d+$/u.test(row.mtime_ns)) return undefined;
    const date = new Date(Number(BigInt(row.mtime_ns) / 1_000_000n));
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (field === "cloudig_edited") return row.edited_at ?? row.times?.json_edited_at;
  const key = field === "json_created" ? "json_created_at" : field === "source_captured" ? "source_captured_at" : field;
  return row.times?.[key];
}
