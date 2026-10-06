import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import {
  serializeContainerIndex,
  serializeContainerRecord,
  validateContainerIndexSchema,
  validateContainerRecordSchema
} from "../../core/contracts/index.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import type { SourceAdapter } from "../../app/parser/adapter.mts";
import type { ParsedSourceDraft } from "../../app/parser/adapter.mts";
import { canonicalDiagnosticErrors } from "../../app/parser/diagnostics.mts";
import { parseManagedRelativePath, resolveManagedPath } from "../storage/path.mts";
import { fingerprintFile, writeOwnedStagingFile, type ByteFingerprint } from "../storage/stream.mts";
import { writeAuxiliarySnapshot } from "../storage/auxiliary.mts";
import { parseJsonRange, streamTopLevelJsonArrayRanges } from "./json-array-stream.mts";
import { claudeRecordSelector, claudeRecordToDraft, claudeMessageIsEmpty } from "./claude-export-record.mts";

export const CLAUDE_CONTAINER_FORMAT = "anthropic/claude-conversations-export";
export const CLAUDE_CONTAINER_ADAPTER_ID = "anthropic-claude-export-json";
export const CLAUDE_CONTAINER_ADAPTER_VERSION = "2.0.8";

export const claudeContainerAdapter = Object.freeze({
  manifest: {
    id: CLAUDE_CONTAINER_ADAPTER_ID,
    version: CLAUDE_CONTAINER_ADAPTER_VERSION,
    family: "claude-account-export",
    routes: [{
      format: "json-container",
      platform: "claude",
      payload: CLAUDE_CONTAINER_FORMAT,
      profile: "container"
    }],
    target: "cloudig/conversation/1.0.0",
    update_from: ["1.0.0", "2.0.0", "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.0.5", "2.0.6", "2.0.7"].map(version => ({ adapter: CLAUDE_CONTAINER_ADAPTER_ID, version, action: "reparse_source" as const }))
  },
  parse(): JsonObject {
    throw new TypeError("Claude account exports require a byte-range index and explicit record selection");
  }
} as const satisfies SourceAdapter);

type ClaudeIndexProgress = Readonly<{
  phase: "scan" | "record" | "publish";
  bytesCompleted: number;
  bytesTotal: number;
  itemsCompleted: number;
  totalKnown: boolean;
}>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function cleanString(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n?/gu, "\n").trim();
  return text || undefined;
}

function utcTimestamp(value: JsonValue | undefined): string | undefined {
  const text = cleanString(value);
  if (!text || !Number.isFinite(Date.parse(text))) return undefined;
  return new Date(text).toISOString();
}

export function projectClaudeContainerRecord(value: JsonValue, ordinal: number, offset: number, length: number, itemSha256: string): JsonObject {
  if (!isJsonObject(value) || typeof value["uuid"] !== "string" || !Array.isArray(value["chat_messages"])) {
    throw new TypeError(`Claude export record ${ordinal} has no supported uuid/chat_messages shape`);
  }
  const messages = value["chat_messages"];
  const identifiers = new Set<string>();
  for (const raw of messages) {
    if (isJsonObject(raw) && typeof raw["uuid"] === "string" && raw["uuid"].trim()) identifiers.add(raw["uuid"].trim());
  }
  const childCounts = new Map<string, number>();
  let orphanParents = 0;
  for (const raw of messages) {
    if (!isJsonObject(raw)) continue;
    const parent = cleanString(raw["parent_message_uuid"]);
    if (!parent) continue;
    if (!identifiers.has(parent)) {
      orphanParents += 1;
      continue;
    }
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  const branches = [...identifiers].filter((identifier) => !childCounts.has(identifier)).length;
  const forkPoints = [...childCounts.values()].filter((count) => count > 1).length;
  const selector = claudeRecordSelector(value["uuid"]);
  const record: JsonObject = {
    schema: "cloudig/container-record/1.0.0",
    selector,
    ordinal,
    offset,
    length,
    item_sha256: itemSha256,
    title: cleanString(value["name"]) ?? "Claude conversation",
    ...(utcTimestamp(value["created_at"]) ? { created_at: utcTimestamp(value["created_at"])! } : {}),
    ...(utcTimestamp(value["updated_at"]) ? { updated_at: utcTimestamp(value["updated_at"])! } : {}),
    messages: messages.length,
    empty_messages: messages.filter(raw => isJsonObject(raw) && claudeMessageIsEmpty(raw)).length,
    ...(branches > 0 ? { branches } : {}),
    ...(forkPoints > 0 ? { fork_points: forkPoints } : {}),
    ...(orphanParents > 0 ? { orphan_parents: orphanParents } : {})
  };
  const validation = validateContainerRecordSchema<JsonObject>(record);
  if (!validation.ok) throw new TypeError(`Claude container record projection is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  return validation.value;
}

function directInboxPath(value: string): string {
  const segments = parseManagedRelativePath(value);
  if (segments.length !== 2 || segments[0] !== "Inbox") throw new TypeError("Claude container source must be a direct Inbox file");
  return segments.join("/");
}

function buildToken(value: string): string {
  if (!/^x_[A-Z2-7]{16,52}$/u.test(value)) throw new TypeError("Claude container index build token is invalid");
  return value;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

async function cleanupOwnedBuild(directory: string): Promise<void> {
  await unlinkIfPresent(path.join(directory, "records.jsonl"));
  await unlinkIfPresent(path.join(directory, "state.json"));
  try {
    await rmdir(directory);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTEMPTY"].includes(String(error.code))) throw error;
  }
}

async function existingIndexStatus(
  directory: string,
  expectedSource: ByteFingerprint,
  sourcePath: string
): Promise<"unchanged" | "conflict" | "missing"> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return "conflict";
    const stateValue: unknown = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    const validation = validateContainerIndexSchema<JsonObject>(stateValue);
    if (!validation.ok) return "conflict";
    const source = validation.value["source"];
    const records = validation.value["records"];
    if (!isJsonObject(source) || !isJsonObject(records)) return "conflict";
    const fingerprint = await fingerprintFile(path.join(directory, "records.jsonl"));
    return source["path"] === sourcePath
      && source["bytes"] === expectedSource.bytes
      && source["sha256"] === expectedSource.sha256
      && records["bytes"] === fingerprint.bytes
      && records["sha256"] === fingerprint.sha256
      && isJsonObject(validation.value["adapter"])
      && validation.value["adapter"]["id"] === CLAUDE_CONTAINER_ADAPTER_ID
      && validation.value["adapter"]["version"] === CLAUDE_CONTAINER_ADAPTER_VERSION
      ? "unchanged"
      : "conflict";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    return "conflict";
  }
}

export type ClaudeContainerIndexResult = Readonly<{
  status: "created" | "rebuilt" | "unchanged" | "conflict" | "cancelled";
  source: ByteFingerprint;
  records: number;
  directory: string;
}>;

export async function indexClaudeContainer(input: Readonly<{
  libraryRoot: string;
  sourcePath: string;
  buildToken: string;
  builtAt: string;
  rebuild?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ClaudeIndexProgress) => void;
}>): Promise<ClaudeContainerIndexResult> {
  const sourcePath = directInboxPath(input.sourcePath);
  const token = buildToken(input.buildToken);
  const sourceAbsolute = await resolveManagedPath(input.libraryRoot, sourcePath, { mustExist: true });
  const sourceInfo = await lstat(sourceAbsolute);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1) throw new TypeError("Claude container source must be a non-empty confined file");
  const containers = await resolveManagedPath(input.libraryRoot, "Data/Indexes/Containers");
  await mkdir(containers, { recursive: true });
  const building = path.join(containers, `.building-${token}`);
  await mkdir(building);
  const recordsPath = path.join(building, "records.jsonl");
  const statePath = path.join(building, "state.json");
  let sourceFingerprint: ByteFingerprint = { bytes: 0, sha256: "0".repeat(64) };
  let recordCount = 0;
  let builtState: JsonObject | undefined;
  try {
    // A warm open must not parse every conversation merely to discover that the
    // byte-bound index already exists. Hash the source once, then validate the
    // small projection. Never trust mtime/size alone for this source binding.
    if (!input.rebuild && (await readdir(containers)).some((entry) => /^[0-9a-f]{64}$/u.test(entry))) {
      input.onProgress?.({ phase: "scan", bytesCompleted: 0, bytesTotal: sourceInfo.size, itemsCompleted: 0, totalKnown: false });
      sourceFingerprint = await fingerprintFile(sourceAbsolute, input.signal);
      const targetRelative = `Data/Indexes/Containers/${sourceFingerprint.sha256}`;
      const target = await resolveManagedPath(input.libraryRoot, targetRelative);
      if (await existingIndexStatus(target, sourceFingerprint, sourcePath) === "unchanged") {
        const current = await readClaudeProjection(input.libraryRoot, sourceFingerprint.sha256);
        input.onProgress?.({ phase: "publish", bytesCompleted: sourceFingerprint.bytes, bytesTotal: sourceFingerprint.bytes, itemsCompleted: current.records.length, totalKnown: true });
        throwIfAborted(input.signal);
        await cleanupOwnedBuild(building);
        return { status: "unchanged", source: sourceFingerprint, records: current.records.length, directory: targetRelative };
      }
    }
    const handle = await open(sourceAbsolute, "r");
    const sourceHash = createHash("sha256");
    let scannedBytes = 0;
    const selectors = new Set<string>();
    try {
      async function* fingerprinted(): AsyncGenerator<Buffer> {
        for await (const raw of handle.createReadStream({ autoClose: false, highWaterMark: 512 * 1024 })) {
          throwIfAborted(input.signal);
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          sourceHash.update(chunk);
          scannedBytes += chunk.byteLength;
          yield chunk;
        }
      }
      async function* rows(): AsyncGenerator<string> {
        for await (const range of streamTopLevelJsonArrayRanges(Readable.from(fingerprinted()), {
          ...(input.signal ? { signal: input.signal } : {}),
          onProgress: (completedBytes, completedItems) => input.onProgress?.({
            phase: "scan",
            bytesCompleted: completedBytes,
            bytesTotal: sourceInfo.size,
            itemsCompleted: completedItems,
            totalKnown: false
          })
        })) {
          const parsed = await parseJsonRange(sourceAbsolute, range, input.signal ? { signal: input.signal } : {});
          const record = projectClaudeContainerRecord(parsed.value, range.index + 1, range.offset, range.length, parsed.fingerprint.sha256);
          const selector = record["selector"] as string;
          if (selectors.has(selector)) throw new TypeError("Claude container contains a duplicate conversation UUID");
          selectors.add(selector);
          recordCount += 1;
          input.onProgress?.({
            phase: "record",
            bytesCompleted: scannedBytes,
            bytesTotal: sourceInfo.size,
            itemsCompleted: recordCount,
            totalKnown: false
          });
          yield serializeContainerRecord(record);
        }
      }
      const recordsFingerprint = await writeOwnedStagingFile(Readable.from(rows()), recordsPath, input.signal ? { signal: input.signal } : {});
      sourceFingerprint = { bytes: scannedBytes, sha256: sourceHash.digest("hex") };
      if (sourceFingerprint.bytes !== sourceInfo.size) throw new TypeError("Claude container size changed during indexing");
      const observedAfter = await fingerprintFile(sourceAbsolute, input.signal);
      if (observedAfter.bytes !== sourceFingerprint.bytes || observedAfter.sha256 !== sourceFingerprint.sha256) {
        throw new TypeError("Claude container changed during indexing");
      }
      if (recordCount < 1) throw new TypeError("Claude container contains no conversations");
      const state: JsonObject = {
        schema: "cloudig/container-index/1.0.0",
        format: CLAUDE_CONTAINER_FORMAT,
        source: { path: sourcePath, ...sourceFingerprint },
        adapter: { id: CLAUDE_CONTAINER_ADAPTER_ID, version: CLAUDE_CONTAINER_ADAPTER_VERSION },
        built_at: input.builtAt,
        records: { count: recordCount, ...recordsFingerprint }
      };
      const stateValidation = validateContainerIndexSchema<JsonObject>(state);
      if (!stateValidation.ok) throw new TypeError(`Claude container index state is invalid: ${stateValidation.issues.map((entry) => entry.code).join(",")}`);
      builtState = stateValidation.value;
      await writeOwnedStagingFile(
        Readable.from([serializeContainerIndex(stateValidation.value)]),
        statePath,
        input.signal ? { signal: input.signal } : {}
      );
    } finally {
      await handle.close();
    }

    throwIfAborted(input.signal);
    const targetRelative = `Data/Indexes/Containers/${sourceFingerprint.sha256}`;
    const target = await resolveManagedPath(input.libraryRoot, targetRelative);
    const existing = await existingIndexStatus(target, sourceFingerprint, sourcePath);
    if (existing !== "missing") {
      if (!input.rebuild || existing !== "unchanged" || !builtState) {
        await cleanupOwnedBuild(building);
        return { status: existing, source: sourceFingerprint, records: recordCount, directory: targetRelative };
      }
      const prior = await readClaudeProjection(input.libraryRoot, sourceFingerprint.sha256);
      const state: JsonObject = {
        ...structuredClone(builtState),
        ...(Array.isArray(prior.state["outputs"]) ? { outputs: structuredClone(prior.state["outputs"]) } : {}),
        ...(Array.isArray(prior.state["failures"]) ? { failures: structuredClone(prior.state["failures"]) } : {})
      };
      const validation = validateContainerIndexSchema<JsonObject>(state);
      if (!validation.ok) throw new TypeError("Rebuilt Claude index state is invalid");
      await unlink(statePath);
      await writeOwnedStagingFile(Readable.from([serializeContainerIndex(validation.value)]), statePath, input.signal ? { signal: input.signal } : {});
      const displaced = path.join(containers, `.displaced-${token}`);
      await rename(target, displaced);
      try {
        await rename(building, target);
      } catch (error) {
        await rename(displaced, target);
        throw error;
      }
      await cleanupOwnedBuild(displaced);
      return { status: "rebuilt", source: sourceFingerprint, records: recordCount, directory: targetRelative };
    }
    input.onProgress?.({
      phase: "publish",
      bytesCompleted: sourceFingerprint.bytes,
      bytesTotal: sourceFingerprint.bytes,
      itemsCompleted: recordCount,
      totalKnown: true
    });
    try {
      await rename(building, target);
    } catch (error) {
      const raced = await existingIndexStatus(target, sourceFingerprint, sourcePath);
      if (raced !== "missing") {
        await cleanupOwnedBuild(building);
        return { status: raced, source: sourceFingerprint, records: recordCount, directory: targetRelative };
      }
      throw error;
    }
    return { status: "created", source: sourceFingerprint, records: recordCount, directory: targetRelative };
  } catch (error) {
    await cleanupOwnedBuild(building);
    if (error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError") {
      return { status: "cancelled", source: sourceFingerprint, records: recordCount, directory: "" };
    }
    throw error;
  }
}

type ClaudeProjection = Readonly<{
  state: JsonObject;
  stateFingerprint: ByteFingerprint;
  records: readonly JsonObject[];
  directory: string;
}>;

async function readClaudeProjection(libraryRoot: string, sourceSha256: string): Promise<ClaudeProjection> {
  if (!/^[0-9a-f]{64}$/u.test(sourceSha256)) throw new TypeError("Claude container source SHA-256 is invalid");
  const directory = `Data/Indexes/Containers/${sourceSha256}`;
  const absolute = await resolveManagedPath(libraryRoot, directory, { mustExist: true });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("Claude container index path is not a confined directory");
  const statePath = path.join(absolute, "state.json");
  const stateValue: unknown = JSON.parse(await readFile(statePath, "utf8"));
  const stateFingerprint = await fingerprintFile(statePath);
  const stateValidation = validateContainerIndexSchema<JsonObject>(stateValue);
  if (!stateValidation.ok) throw new TypeError(`Claude container index state is invalid: ${stateValidation.issues.map((entry) => entry.code).join(",")}`);
  const source = stateValidation.value["source"];
  const recordSummary = stateValidation.value["records"];
  if (!isJsonObject(source) || source["sha256"] !== sourceSha256 || !isJsonObject(recordSummary)) {
    throw new TypeError("Claude container index source identity is inconsistent");
  }
  const recordsPath = path.join(absolute, "records.jsonl");
  const observed = await fingerprintFile(recordsPath);
  if (recordSummary["bytes"] !== observed.bytes || recordSummary["sha256"] !== observed.sha256) {
    throw new TypeError("Claude container records projection fingerprint changed");
  }
  const records: JsonObject[] = [];
  const selectors = new Set<string>();
  let priorEnd = -1;
  const lines = createInterface({ input: createReadStream(recordsPath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) throw new TypeError("Claude container records projection contains an empty line");
      const value: unknown = JSON.parse(line);
      const validation = validateContainerRecordSchema<JsonObject>(value);
      if (!validation.ok) throw new TypeError(`Claude container record projection is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
      const record = validation.value;
      if (record["ordinal"] !== records.length + 1) throw new TypeError("Claude container record ordinals are not contiguous");
      const selector = record["selector"] as string;
      if (selectors.has(selector)) throw new TypeError("Claude container records projection contains a duplicate selector");
      selectors.add(selector);
      const offset = record["offset"] as number;
      const length = record["length"] as number;
      if (offset <= priorEnd) throw new TypeError("Claude container record ranges overlap or are out of order");
      priorEnd = offset + length - 1;
      records.push(record);
    }
  } finally {
    lines.close();
  }
  if (recordSummary["count"] !== records.length) throw new TypeError("Claude container record count changed");
  return { state: stateValidation.value, stateFingerprint, records, directory };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function queryClaudeContainerRecords(input: Readonly<{
  libraryRoot: string;
  sourceSha256: string;
  search?: string;
  statuses?: readonly ("ready" | "parsed" | "update" | "failed" | "unsupported")[];
  timeField?: "created_at" | "updated_at";
  sort?: "time" | "title";
  direction?: "asc" | "desc";
  offset?: number;
  limit?: number;
}>): Promise<Readonly<{
  source: JsonObject;
  builtAt: string;
  total: number;
  visible: number;
  offset: number;
  statuses: Readonly<Record<"ready" | "parsed" | "update" | "failed" | "unsupported", number>>;
  records: readonly JsonObject[];
}>> {
  const projection = await readClaudeProjection(input.libraryRoot, input.sourceSha256);
  const search = input.search?.trim().toLowerCase() ?? "";
  const timeField = input.timeField ?? "updated_at";
  const sort = input.sort ?? "time";
  const direction = input.direction ?? "desc";
  const offset = input.offset ?? 0;
  const limit = input.limit ?? projection.records.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Claude container query offset/limit are invalid");
  }
  const outputs = Array.isArray(projection.state["outputs"])
    ? new Map(projection.state["outputs"].filter(isJsonObject).map((output) => [output["selector"] as string, output]))
    : new Map<string, JsonObject>();
  const failures = Array.isArray(projection.state["failures"])
    ? new Map(projection.state["failures"].filter(isJsonObject).map((failure) => [failure["selector"] as string, failure]))
    : new Map<string, JsonObject>();
  const recordStatus = (record: JsonObject): "ready" | "parsed" | "update" | "failed" | "unsupported" => {
    const selector = record["selector"] as string;
    const output = outputs.get(selector);
    if (output) {
      const adapter = isJsonObject(output["adapter"]) ? output["adapter"] : undefined;
      return adapter?.["version"] === CLAUDE_CONTAINER_ADAPTER_VERSION ? "parsed" : "update";
    }
    const failure = failures.get(selector);
    if (!failure || failure["adapter_version"] !== CLAUDE_CONTAINER_ADAPTER_VERSION) return "ready";
    return failure["code"] === "claude-record-invalid" && Number(failure["attempts"]) >= 2 ? "unsupported" : "failed";
  };
  const statusCounts = { ready: 0, parsed: 0, update: 0, failed: 0, unsupported: 0 };
  for (const record of projection.records) statusCounts[recordStatus(record)] += 1;
  const statusSet = new Set(input.statuses ?? []);
  const filtered = projection.records.filter((record) => {
    const status = recordStatus(record);
    return (!search || String(record["title"]).toLowerCase().includes(search))
      && (statusSet.size === 0 || statusSet.has(status));
  });
  const ordered = [...filtered].sort((left, right) => {
    let result: number;
    if (sort === "title") {
      result = compareText(String(left["title"]).toLowerCase(), String(right["title"]).toLowerCase());
    } else {
      const leftTime = typeof left[timeField] === "string" ? left[timeField] as string : undefined;
      const rightTime = typeof right[timeField] === "string" ? right[timeField] as string : undefined;
      if (!leftTime && !rightTime) result = 0;
      else if (!leftTime) return 1;
      else if (!rightTime) return -1;
      else result = compareText(leftTime, rightTime);
    }
    if (result !== 0) return direction === "asc" ? result : -result;
    return (left["ordinal"] as number) - (right["ordinal"] as number);
  });
  return {
    source: structuredClone(projection.state["source"] as JsonObject),
    builtAt: projection.state["built_at"] as string,
    total: projection.records.length,
    visible: ordered.length,
    offset,
    statuses: statusCounts,
    records: ordered.slice(offset, offset + limit).map((record) => {
      const output = outputs.get(record["selector"] as string);
      const failure = failures.get(record["selector"] as string);
      return {
        ...structuredClone(record),
        status: recordStatus(record),
        ...(output ? { output: structuredClone(output) } : {}),
        ...(failure && failure["adapter_version"] === CLAUDE_CONTAINER_ADAPTER_VERSION ? { failure: structuredClone(failure) } : {})
      };
    })
  };
}

export async function writeClaudeContainerOutputState(input: Readonly<{
  libraryRoot: string;
  sourceSha256: string;
  outputs: readonly JsonObject[];
  failures?: readonly JsonObject[];
}>): Promise<"written" | "unchanged" | "conflict"> {
  const projection = await readClaudeProjection(input.libraryRoot, input.sourceSha256);
  const known = new Set(projection.records.map((record) => record["selector"] as string));
  const outputs = input.outputs
    .filter((output) => typeof output["selector"] === "string" && known.has(output["selector"] as string))
    .map((output) => ({
      selector: output["selector"]!,
      archive: output["archive"]!,
      generation: output["generation"]!,
      path: output["path"]!,
      conversation_schema: output["conversation_schema"]!,
      parser: output["parser"]!,
      adapter: structuredClone(output["adapter"]!)
    }));
  const order = new Map(projection.records.map((record, index) => [record["selector"] as string, index]));
  outputs.sort((left, right) => order.get(left["selector"] as string)! - order.get(right["selector"] as string)!);
  const failures = (input.failures ?? [])
    .filter((failure) => typeof failure["selector"] === "string" && known.has(failure["selector"] as string))
    .map((failure) => ({
      selector: failure["selector"]!,
      code: failure["code"]!,
      attempts: failure["attempts"]!,
      adapter_version: failure["adapter_version"]!,
      failed_at: failure["failed_at"]!
    }))
    .sort((left, right) => order.get(left["selector"] as string)! - order.get(right["selector"] as string)!);
  const state: JsonObject = {
    ...structuredClone(projection.state),
    ...(outputs.length > 0 ? { outputs } : {}),
    ...(failures.length > 0 ? { failures } : {})
  };
  if (outputs.length === 0) delete state["outputs"];
  if (failures.length === 0) delete state["failures"];
  const validation = validateContainerIndexSchema<JsonObject>(state);
  if (!validation.ok) throw new TypeError(`Claude container output state is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  const serialized = serializeContainerIndex(validation.value);
  if (serialized === serializeContainerIndex(projection.state)) return "unchanged";
  return writeAuxiliarySnapshot(
    input.libraryRoot,
    `${projection.directory}/state.json`,
    Buffer.from(serialized, "utf8"),
    projection.stateFingerprint
  );
}

function earliestFileTime(info: Awaited<ReturnType<typeof lstat>>): string | undefined {
  const candidates = [Number(info.birthtimeMs), Number(info.mtimeMs)].filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? new Date(Math.min(...candidates)).toISOString() : undefined;
}

export type PreparedClaudeContainer = Readonly<{
  libraryRoot: string;
  sourcePath: string;
  sourceAbsolute: string;
  sourceFingerprint: ByteFingerprint;
  capturedAt?: string;
  records: readonly JsonObject[];
}>;

export async function prepareClaudeContainerExtraction(input: Readonly<{
  libraryRoot: string;
  sourcePath: string;
  fileSystemCapturedAt?: string;
  signal?: AbortSignal;
}>): Promise<PreparedClaudeContainer> {
  const sourcePath = directInboxPath(input.sourcePath);
  const sourceAbsolute = await resolveManagedPath(input.libraryRoot, sourcePath, { mustExist: true });
  const sourceInfo = await lstat(sourceAbsolute);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1) throw new TypeError("Claude container source must be a non-empty confined file");
  const sourceFingerprint = await fingerprintFile(sourceAbsolute, input.signal);
  const projection = await readClaudeProjection(input.libraryRoot, sourceFingerprint.sha256);
  const indexedSource = projection.state["source"];
  if (!isJsonObject(indexedSource) || indexedSource["path"] !== sourcePath || indexedSource["bytes"] !== sourceFingerprint.bytes) {
    throw new TypeError("Claude container changed after indexing");
  }
  const capturedAt = input.fileSystemCapturedAt ?? earliestFileTime(sourceInfo);
  return {
    libraryRoot: input.libraryRoot,
    sourcePath,
    sourceAbsolute,
    sourceFingerprint,
    ...(capturedAt ? { capturedAt } : {}),
    records: projection.records
  };
}

export async function parsePreparedClaudeContainerRecord(input: Readonly<{
  prepared: PreparedClaudeContainer;
  selector: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}>): Promise<ParsedSourceDraft> {
  if (!/^[0-9a-f]{64}$/u.test(input.selector)) throw new TypeError("Claude container record selector is invalid");
  throwIfAborted(input.signal);
  const summary = input.prepared.records.find((record) => record["selector"] === input.selector);
  if (!summary) throw new TypeError("Selected Claude container record is absent from the current index");
  const range = {
    index: (summary["ordinal"] as number) - 1,
    offset: summary["offset"] as number,
    length: summary["length"] as number
  };
  const parsed = await parseJsonRange(input.prepared.sourceAbsolute, range, input.signal ? { signal: input.signal } : {});
  if (parsed.fingerprint.sha256 !== summary["item_sha256"]) throw new TypeError("Selected Claude container record bytes changed after indexing");
  if (!isJsonObject(parsed.value) || typeof parsed.value["uuid"] !== "string") throw new TypeError("Selected Claude container record has no UUID");
  if (claudeRecordSelector(parsed.value["uuid"]) !== input.selector) throw new TypeError("Selected Claude container record identity changed after indexing");
  const draft = claudeRecordToDraft({
    record: parsed.value,
    selector: input.selector,
    source: {
      file: path.basename(input.prepared.sourceAbsolute),
      bytes: input.prepared.sourceFingerprint.bytes,
      sha256: input.prepared.sourceFingerprint.sha256,
      ...(input.prepared.capturedAt ? { capturedAt: input.prepared.capturedAt } : {})
    },
    ...(input.onProgress ? { onProgress: input.onProgress } : {})
  });
  return { draft, adapter: claudeContainerAdapter.manifest, sourceFingerprint: input.prepared.sourceFingerprint, systemLogErrors: canonicalDiagnosticErrors(draft) };
}

export async function parseClaudeContainerRecord(input: Readonly<{
  libraryRoot: string;
  sourcePath: string;
  selector: string;
  fileSystemCapturedAt?: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}>): Promise<ParsedSourceDraft> {
  const prepared = await prepareClaudeContainerExtraction({
    libraryRoot: input.libraryRoot,
    sourcePath: input.sourcePath,
    ...(input.fileSystemCapturedAt ? { fileSystemCapturedAt: input.fileSystemCapturedAt } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  return parsePreparedClaudeContainerRecord({
    prepared,
    selector: input.selector,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {})
  });
}
