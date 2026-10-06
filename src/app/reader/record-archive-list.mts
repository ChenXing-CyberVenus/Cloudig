import type { JsonObject } from "../../core/contracts/types.mts";
import type { RecordPresentation } from "../../core/records/presentation.mts";
import { recordContentTimeOrder, compareRecordContentTimes } from "../../core/records/time-display.mts";

export type RecordArchiveFact = Readonly<{ path: string; id: string; sha256: string; markSha: string | null; bytes: number; mtimeNs: string; messages: number; resources: number; header: JsonObject; mark?: JsonObject; resolved: RecordPresentation; access: "normal" | "read_only_conflict" }>;
export const RECORD_ARCHIVE_TIME_FIELDS = Object.freeze(["json_modified", "cloudig_edited", "json_created", "source_captured", "message_start", "message_end", "content_start", "content_end"] as const);
export type RecordArchiveTimeField = typeof RECORD_ARCHIVE_TIME_FIELDS[number];
export const RECORD_ARCHIVE_LOCATIONS = Object.freeze(["conversations", "archives"] as const);
export type RecordArchiveLocation = typeof RECORD_ARCHIVE_LOCATIONS[number];
export type RecordArchiveQuery = Readonly<{ offset: number; limit: number; search?: string; platforms?: readonly string[]; directories?: readonly string[]; locations?: readonly RecordArchiveLocation[]; sort?: "content_asc" | "content_desc" | "title"; timeField?: RecordArchiveTimeField; archived?: boolean; roots?: ReadonlyMap<string, number> }>;
const object = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
const normalized = (s: string) => s.normalize("NFKC").toLocaleLowerCase("und");
const compare = (a: string | bigint | number, b: typeof a) => a === b ? 0 : a < b ? -1 : 1;
export const recordArchiveDirectory = (file: string) => file.split("/").slice(1, -1).join("/");
export function recordArchiveTimes(fact: RecordArchiveFact): JsonObject {
  const lifecycle = object(fact.header["lifecycle"]), source = object(fact.header["source"]), messages = object(fact.header["message_time"]), result: JsonObject = {};
  for (const [key, value] of Object.entries({ json_created_at: lifecycle["first_parsed_at"], json_edited_at: fact.resolved.effectiveEditedAt, source_captured_at: source["captured_at"], message_start: messages["start"], message_end: messages["end"] ?? messages["start"] })) if (value !== undefined) result[key] = value;
  return result;
}
export function queryRecordArchives(facts: readonly RecordArchiveFact[], query: RecordArchiveQuery): Readonly<{ total: number; rows: readonly RecordArchiveFact[] }> {
  const search = normalized(query.search?.trim() ?? ""), platforms = query.platforms === undefined ? undefined : new Set(query.platforms), directories = query.directories ?? [], sort = query.sort ?? "content_desc", field = query.timeField ?? "json_modified";
  const locations = new Set(query.locations ?? [query.archived ? "archives" : "conversations"]);
  const filtered = facts.filter(f => locations.has(f.path.startsWith("Archives/") ? "archives" : "conversations")
    && (!platforms || platforms.has(f.resolved.platform))
    && (f.path.startsWith("Archives/") || !directories.length || directories.some(d => recordArchiveDirectory(f.path) === d || recordArchiveDirectory(f.path).startsWith(`${d}/`)))
    && (!search || normalized(f.resolved.conversationName).includes(search) || normalized(f.path.split("/").at(-1)!).includes(search)));
  const contentSort = sort !== "title" && (field === "content_start" || field === "content_end");
  const descriptors = new Map((contentSort ? filtered : []).map(f => {
    let range = f.resolved.contentTime.range as JsonObject | undefined;
    if (field === "content_end" && range) {
      const endpoint = structuredClone(range["end"] ?? range["start"]) as JsonObject;
      if (endpoint["kind"] === "node") { const snapshot = object(endpoint["snapshot"]), intrinsic = object(snapshot["sort"]); if (intrinsic["end"]) snapshot["sort"] = { start: intrinsic["end"] }; }
      range = { start: endpoint };
    }
    return [f.path, recordContentTimeOrder({ ...(range ? { range } : {}), fileModifiedAt: new Date(Number(BigInt(f.mtimeNs) / 1_000_000n)).toISOString(), title: f.resolved.conversationName, conversationId: f.id })];
  }));
  const tie = (a: RecordArchiveFact, b: RecordArchiveFact) => compare(normalized(a.resolved.conversationName), normalized(b.resolved.conversationName)) || compare(a.id, b.id) || compare(a.path, b.path);
  const timestamp = (f: RecordArchiveFact) => { const key = field === "cloudig_edited" ? "json_edited_at" : field === "json_created" ? "json_created_at" : field === "source_captured" ? "source_captured_at" : field; const value = recordArchiveTimes(f)[key]; return typeof value === "string" ? Date.parse(value) : undefined; };
  filtered.sort((a, b) => {
    if (sort === "title") return tie(a, b);
    if (field === "content_start" || field === "content_end") return compareRecordContentTimes(descriptors.get(a.path)!, descriptors.get(b.path)!, sort === "content_asc" ? "asc" : "desc", query.roots) || compare(a.path, b.path);
    if (field === "json_modified") return compare(BigInt(a.mtimeNs), BigInt(b.mtimeNs)) * (sort === "content_asc" ? 1 : -1) || tie(a, b);
    const left = timestamp(a), right = timestamp(b); if (left === undefined || right === undefined) return left === right ? tie(a, b) : left === undefined ? 1 : -1;
    return compare(left, right) * (sort === "content_asc" ? 1 : -1) || tie(a, b);
  });
  return { total: filtered.length, rows: filtered.slice(query.offset, query.offset + query.limit) };
}
export function recordArchiveRow(f: RecordArchiveFact): JsonObject {
  const source = object(f.header["source"]), parser = object(f.header["parser"]);
  return { archive: f.id, conversation_id: f.id, title: f.resolved.conversationName, filename: f.path.split("/").at(-1)!, platform: f.resolved.platform, models: [...f.resolved.models],
    content_time: structuredClone(f.resolved.contentTime as unknown as JsonObject), times: recordArchiveTimes(f), edited_at: f.resolved.effectiveEditedAt, bytes: f.bytes, mtime_ns: f.mtimeNs, messages: f.messages, resources: f.resources,
    directory: recordArchiveDirectory(f.path), archived: f.path.startsWith("Archives/"), access: f.access, ...(f.mark ? { mark_file: `${f.mark["mark_id"]}.json` } : {}), ...(source["file"] ? { source_file: source["file"] } : {}), ...(parser["version"] ? { parser: parser["version"] } : {}), ...(parser["adapter"] ? { adapter: structuredClone(parser["adapter"]!) } : {}) };
}
