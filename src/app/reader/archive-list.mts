import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import type { ResolvedArchiveView } from "../../core/library/overlay.mts";
import { buildContentTimeSortDescriptor, compareContentTimeSortDescriptors } from "../../core/time/index.mts";

export type ReaderArchiveFact = Readonly<{
  path: string;
  bytes: number;
  mtimeNs: string;
  sha256: string;
  archive: string;
  generation: number;
  archived: boolean;
  access: "normal" | "read_only_conflict";
  view: ResolvedArchiveView;
  messageCount: number;
  resourceCount: number;
  times: JsonObject;
  sourceFile?: string;
  parserVersion?: string;
  adapter?: Readonly<{ id: string; version: string }>;
}>;

export type ArchiveTimeField = "json_modified" | "cloudig_edited" | "json_created" | "source_captured" | "message_start" | "message_end" | "content_start" | "content_end";

export type ReaderArchiveQuery = Readonly<{
  offset: number;
  limit: number;
  search?: string;
  platforms?: readonly string[];
  directory?: string;
  directories?: readonly string[];
  sort?: "content_asc" | "content_desc" | "title";
  timeField?: ArchiveTimeField;
  archived?: boolean;
  variantOrder?: Readonly<Record<string, number>>;
  nodeEditedAt?: Readonly<Record<string, string>>;
}>;

function filename(value: string): string {
  return value.split("/").at(-1) ?? value;
}

export function readerArchiveDirectory(value: ReaderArchiveFact): string {
  const segments = value.path.split("/");
  return segments[0] === "Conversations" && segments.length > 2 ? segments[1]! : "";
}

function title(value: ReaderArchiveFact): string {
  return value.view.conversationName ?? filename(value.path);
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function compareText(left: string, right: string): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function descriptor(value: ReaderArchiveFact, query: ReaderArchiveQuery) {
  const original = isJsonObject(value.view.contentTime.range) ? value.view.contentTime.range : undefined;
  const endpoint = query.timeField === "content_end" && isJsonObject(original?.["end"]) ? original["end"] : undefined;
  return buildContentTimeSortDescriptor({
    ...(endpoint ? { range: { start: endpoint } } : original ? { range: original } : {}),
    ...(value.view.effectiveEditedAt ? { editedAt: value.view.effectiveEditedAt } : {}),
    title: title(value),
    archive: value.archive,
    path: value.path,
    ...(query.variantOrder ? { variantOrder: query.variantOrder } : {}),
    ...(query.nodeEditedAt ? { nodeEditedAt: query.nodeEditedAt } : {})
  });
}

function timestamp(value: ReaderArchiveFact, field: ArchiveTimeField): string | undefined {
  if (field === "cloudig_edited") return value.view.effectiveEditedAt ?? (typeof value.times["json_edited_at"] === "string" ? value.times["json_edited_at"] : undefined);
  const key = field === "json_created"
    ? "json_created_at"
    : field === "source_captured"
      ? "source_captured_at"
      : field;
  return typeof value.times[key] === "string" ? value.times[key] as string : undefined;
}

function compareRowTie(left: ReaderArchiveFact, right: ReaderArchiveFact): -1 | 0 | 1 {
  const byTitle = compareText(normalized(title(left)), normalized(title(right)));
  if (byTitle !== 0) return byTitle;
  const byArchive = compareText(left.archive, right.archive);
  return byArchive !== 0 ? byArchive : compareText(left.path, right.path);
}

export function queryReaderArchives(
  values: readonly ReaderArchiveFact[],
  query: ReaderArchiveQuery
): Readonly<{ total: number; rows: readonly ReaderArchiveFact[] }> {
  if (!Number.isSafeInteger(query.offset) || query.offset < 0) throw new RangeError("Archive query offset is invalid");
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > resourceLimits.reader_message_page_max) {
    throw new RangeError("Archive query limit is outside the configured bound");
  }
  const search = query.search === undefined ? undefined : normalized(query.search.trim());
  if (search !== undefined && Array.from(search).length > 256) throw new RangeError("Archive query search is too long");
  const platforms = new Set(query.platforms ?? []);
  if (platforms.size > 64 || [...platforms].some((value) => value.length < 1 || value.length > 64)) throw new RangeError("Archive platform filter is invalid");
  if (query.directory !== undefined && (query.directory.length < 1 || query.directory.length > 256)) {
    throw new RangeError("Archive directory filter is invalid");
  }
  if (query.directories !== undefined && (query.directories.length > 64 || query.directories.some((value) => value.length < 1 || value.length > 256))) {
    throw new RangeError("Archive directory filters are invalid");
  }
  if (query.directory !== undefined && query.directories !== undefined) throw new RangeError("Archive directory filters are mutually exclusive");
  const directories = new Set(query.directories ?? (query.directory === undefined ? [] : [query.directory]));
  const filtered = values.filter((value) => {
    if (value.archived !== (query.archived ?? false)) return false;
    if (query.platforms !== undefined && !platforms.has(value.view.platform)) return false;
    if (directories.size > 0 && !directories.has(readerArchiveDirectory(value))) return false;
    return search === undefined || search.length === 0 || normalized(title(value)).includes(search) || normalized(filename(value.path)).includes(search);
  });
  const sort = query.sort ?? "content_desc";
  const timeField = query.timeField ?? "json_modified";
  const descriptors = new Map(filtered.map((value) => [value.path, descriptor(value, query)]));
  filtered.sort((left, right) => {
    if (sort === "title") {
      const byTitle = compareText(normalized(title(left)), normalized(title(right)));
      if (byTitle !== 0) return byTitle;
      return compareText(left.path, right.path);
    }
    if (timeField === "content_start" || timeField === "content_end") {
      return compareContentTimeSortDescriptors(descriptors.get(left.path)!, descriptors.get(right.path)!, sort === "content_desc" ? "desc" : "asc");
    }
    if (timeField === "json_modified") {
      const leftNs = BigInt(left.mtimeNs), rightNs = BigInt(right.mtimeNs);
      if (leftNs !== rightNs) return (leftNs < rightNs ? -1 : 1) * (sort === "content_desc" ? -1 : 1);
      return compareRowTie(left, right);
    }
    const leftTime = timestamp(left, timeField);
    const rightTime = timestamp(right, timeField);
    if (leftTime === undefined || rightTime === undefined) return leftTime === rightTime ? compareRowTie(left, right) : leftTime === undefined ? 1 : -1;
    const comparison = compareText(leftTime, rightTime);
    if (comparison !== 0) return sort === "content_desc" ? comparison === -1 ? 1 : -1 : comparison;
    return compareRowTie(left, right);
  });
  return { total: filtered.length, rows: filtered.slice(query.offset, query.offset + query.limit) };
}

export function readerArchiveRow(value: ReaderArchiveFact): JsonObject {
  return {
    archive: value.archive,
    generation: value.generation,
    title: title(value),
    filename: filename(value.path),
    platform: value.view.platform,
    models: [...value.view.models],
    content_time: structuredClone(value.view.contentTime as unknown as JsonObject),
    times: structuredClone(value.times),
    ...(value.view.effectiveEditedAt ? { edited_at: value.view.effectiveEditedAt } : {}),
    bytes: value.bytes,
    mtime_ns: value.mtimeNs,
    messages: value.messageCount,
    resources: value.resourceCount,
    directory: readerArchiveDirectory(value),
    archived: value.archived,
    ...(value.sourceFile ? { source_file: value.sourceFile } : {}),
    ...(value.parserVersion ? { parser: value.parserVersion } : {}),
    ...(value.adapter ? { adapter: { id: value.adapter.id, version: value.adapter.version } } : {}),
    access: value.access
  };
}
