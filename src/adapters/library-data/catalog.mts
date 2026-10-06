import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { serializeCatalogCache, validateCatalogCache } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { observeAuxiliarySnapshot, writeAuxiliarySnapshot } from "../storage/auxiliary.mts";
import { safeWindowsLeaf } from "../storage/names.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { openCanonicalConversationFile } from "../reader/conversation-file.mts";

const CATALOG = "Data/Indexes/Catalog/snapshot.json";
const CATALOG_WRITE_ATTEMPTS = 3;

export type FileObservation = Readonly<{
  path: string;
  bytes: number;
  mtime_ns: string;
  archived?: boolean;
}>;

export type LibraryFileScan = Readonly<{
  sources: readonly FileObservation[];
  archives: readonly FileObservation[];
  issues: readonly { path: string; code: string }[];
}>;

async function observeFile(absolute: string, relative: string, archived?: boolean): Promise<FileObservation> {
  const info = await stat(absolute, { bigint: true });
  const bytes = Number(info.size);
  if (!Number.isSafeInteger(bytes)) throw new RangeError(`File is too large for I-JSON byte count: ${relative}`);
  return { path: relative, bytes, mtime_ns: String(info.mtimeNs), ...(archived === undefined ? {} : { archived }) };
}

async function observeListedFile(absolute: string, relative: string, archived?: boolean): Promise<FileObservation | undefined> {
  try { return await observeFile(absolute, relative, archived); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function scanConversations(
  root: string,
  directory: string,
  relative: string,
  archives: FileObservation[],
  issues: Array<{ path: string; code: string }>
): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push({ path: childRelative, code: "reparse-entry-ignored" });
      continue;
    }
    if (entry.isDirectory()) {
      await scanConversations(root, absolute, childRelative, archives, issues);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      const observation = await observeListedFile(absolute, childRelative, childRelative.split("/").includes(".Cloudig-Archive"));
      if (observation) archives.push(observation);
    }
  }
}

export async function scanLibraryFiles(libraryRoot: string): Promise<LibraryFileScan> {
  const sources: FileObservation[] = [];
  const archives: FileObservation[] = [];
  const issues: Array<{ path: string; code: string }> = [];
  const inbox = await resolveManagedPath(libraryRoot, "Inbox", { mustExist: true });
  for (const entry of await readdir(inbox, { withFileTypes: true })) {
    const relative = `Inbox/${entry.name}`;
    if (entry.isSymbolicLink()) issues.push({ path: relative, code: "reparse-entry-ignored" });
    else if (entry.isFile()) {
      const observation = await observeListedFile(path.join(inbox, entry.name), relative);
      if (observation) sources.push(observation);
    }
  }
  const conversations = await resolveManagedPath(libraryRoot, "Conversations", { mustExist: true });
  await scanConversations(libraryRoot, conversations, "Conversations", archives, issues);
  return {
    sources: sources.sort((left, right) => left.path.localeCompare(right.path, "en")),
    archives: archives.sort((left, right) => left.path.localeCompare(right.path, "en")),
    issues: issues.sort((left, right) => left.path.localeCompare(right.path, "en"))
  };
}

export async function readCatalogCache(libraryRoot: string): Promise<JsonObject | undefined> {
  const filePath = await resolveManagedPath(libraryRoot, CATALOG);
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    const validation = validateCatalogCache(value);
    return validation.ok ? validation.value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
    throw error;
  }
}

const listingRefreshes = new Map<string, Promise<{ scan: LibraryFileScan; catalog?: JsonObject }>>();

// A valid cache is not proof that its files still exist. Share only an in-flight
// refresh; never keep a completed result as an alternative filesystem authority.
export function readCurrentListingSnapshot(libraryRoot: string): Promise<{ scan: LibraryFileScan; catalog?: JsonObject }> {
  const key = path.resolve(libraryRoot);
  const pending = listingRefreshes.get(key);
  if (pending) return pending;
  const operation = refreshListingSnapshot(libraryRoot).finally(() => listingRefreshes.delete(key));
  listingRefreshes.set(key, operation);
  return operation;
}

async function refreshListingSnapshot(libraryRoot: string): Promise<{ scan: LibraryFileScan; catalog?: JsonObject }> {
  const expected = await observeAuxiliarySnapshot(libraryRoot, CATALOG);
  const catalog = await readCatalogCache(libraryRoot);
  const scan = await scanLibraryFiles(libraryRoot);
  if (!catalog) return { scan };
  const previous = new Map((catalog["archives"] as JsonObject[]).map(row => [String(row["path"]), row]));
  const sameObservation = (row: JsonObject | undefined, file: FileObservation) => row?.["bytes"] === file.bytes && row?.["mtime_ns"] === file.mtime_ns && typeof row?.["parser"] === "string";
  if (previous.size === scan.archives.length && scan.archives.every(file => sameObservation(previous.get(file.path), file))) return { scan, catalog };

  const archives: JsonObject[] = [];
  for (const file of scan.archives) {
    const cached = previous.get(file.path);
    if (sameObservation(cached, file)) { archives.push(structuredClone(cached!)); continue; }
    try {
      const absolute = await resolveManagedPath(libraryRoot, file.path, { mustExist: true });
      const opened = await openCanonicalConversationFile({ filePath: absolute });
      try {
        const after = await observeFile(absolute, file.path, file.archived);
        if (after.bytes !== file.bytes || after.mtime_ns !== file.mtime_ns) continue;
        archives.push({ ...projectCatalogArchiveSummary(opened.index.conversation), ...file, sha256: opened.index.fingerprint.sha256 });
      } finally { await opened.close(); }
    } catch {
      // One removed or invalid JSON must not keep a ghost row or hide other files.
    }
  }
  const next = structuredClone(catalog);
  next["archives"] = archives;
  const byPath = new Map(archives.map(row => [String(row["path"]), row]));
  const identity = (row: JsonObject) => `${row["archive"]}:${row["generation"]}:${row["sha256"]}`;
  const byIdentity = new Map<string, JsonObject[]>();
  for (const row of archives) {
    const key = identity(row);
    const matches = byIdentity.get(key) ?? [];
    matches.push(row);
    byIdentity.set(key, matches);
  }
  for (const source of next["sources"] as JsonObject[]) {
    if (!Array.isArray(source["outputs"])) continue;
    const outputs = source["outputs"].filter(isJsonObject).flatMap(output => {
      const atPath = byPath.get(String(output["path"]));
      if (atPath?.["archive"] === output["archive"] && atPath?.["generation"] === output["generation"]) return [output];
      const old = previous.get(String(output["path"]));
      const moved = old ? byIdentity.get(identity(old)) ?? [] : [];
      return moved.length === 1 ? [{ ...output, path: moved[0]!["path"]! }] : [];
    });
    if (outputs.length) source["outputs"] = outputs;
    else {
      delete source["outputs"];
      if (source["status"] === "complete") source["status"] = "pending";
    }
  }
  next["built_at"] = new Date().toISOString();
  if (!validateCatalogCache(next).ok) throw new TypeError("Refreshed archive catalog is invalid");
  const written = await writeAuxiliarySnapshot(libraryRoot, CATALOG, Buffer.from(serializeCatalogCache(next), "utf8"), expected);
  if (written !== "written") throw new Error("Archive catalog changed during refresh; retry the refresh");
  return { scan, catalog: next };
}

export function projectCatalogArchiveSummary(conversation: JsonObject): JsonObject {
  const source = conversation["source"] as JsonObject;
  const locator = isJsonObject(source["locator"]) ? source["locator"] : undefined;
  const selector = locator?.["kind"] === "account_export_record" && typeof locator["value"] === "string"
    ? locator["value"]
    : undefined;
  const lifecycle = conversation["lifecycle"] as JsonObject;
  const messageTime = isJsonObject(conversation["message_time"]) ? conversation["message_time"] : undefined;
  const contentTime = isJsonObject(conversation["content_time"]) ? conversation["content_time"] : undefined;
  const times: JsonObject = {
    json_edited_at: lifecycle["cloudig_edited_at"]!,
    ...(isJsonObject(lifecycle["first_parsed_at"]) && lifecycle["first_parsed_at"]["basis"] === "parser"
      ? { json_created_at: lifecycle["first_parsed_at"]["value"]! }
      : {}),
    ...(isJsonObject(source["captured_at"]) ? { source_captured_at: source["captured_at"]["value"]! } : {}),
    ...(messageTime?.["start"] ? { message_start: messageTime["start"]! } : {}),
    ...(messageTime?.["end"] ? { message_end: messageTime["end"]! } : {}),
    ...(contentTime?.["range"] ? { content: structuredClone(contentTime["range"]!) } : {})
  };
  return {
    conversation_schema: conversation["schema"]!,
    archive: conversation["archive"]!,
    generation: conversation["generation"]!,
    parser: (conversation["parser"] as JsonObject)["version"]!,
    adapter: structuredClone((conversation["parser"] as JsonObject)["adapter"]!),
    source_file: source["file"]!,
    ...(conversation["title"] ? { source_title: conversation["title"]! } : {}),
    platform: conversation["platform"]!,
    ...(conversation["models"] ? { models: structuredClone(conversation["models"]!) } : {}),
    message_count: Array.isArray(conversation["messages"]) ? conversation["messages"].length : 0,
    resource_count: Array.isArray(conversation["resources"]) ? conversation["resources"].length : 0,
    ...(selector ? { selector } : {}),
    times
  };
}

export function projectCatalogSourceOutput(conversation: JsonObject, relativePath: string): JsonObject {
  const source = conversation["source"] as JsonObject;
  const parser = conversation["parser"] as JsonObject;
  const adapter = parser["adapter"] as JsonObject;
  const locator = isJsonObject(source["locator"]) ? source["locator"] : undefined;
  const selector = locator?.["kind"] === "account_export_record" && typeof locator["value"] === "string"
    ? locator["value"]
    : undefined;
  return {
    archive: conversation["archive"]!,
    generation: conversation["generation"]!,
    path: relativePath,
    conversation_schema: conversation["schema"]!,
    parser: parser["version"]!,
    adapter: { id: adapter["id"]!, version: adapter["version"]! },
    ...(isJsonObject(source["exporter"]) ? { exporter: structuredClone(source["exporter"]!) } : {}),
    ...(typeof source["profile"] === "string" ? { profile: source["profile"] } : {}),
    ...(typeof source["payload"] === "string" ? { payload_schema: source["payload"] } : {}),
    ...(selector ? { selector } : {})
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

export async function rebuildCatalogFromAuthority(input: Readonly<{
  libraryRoot: string;
  builtAt: string;
  adapterBundleSha256: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}>): Promise<Readonly<{
  status: "written" | "conflict" | "invalid" | "cancelled";
  archives: number;
  sources: number;
  issues: readonly { path: string; code: string }[];
}>> {
  const scan = await scanLibraryFiles(input.libraryRoot);
  const archiveRows: Record<string, JsonObject> = {};
  const sourceEvidence = new Map<string, Array<Readonly<{
    source: JsonObject;
    route: JsonObject;
    output: JsonObject;
    lastParsedAt: string;
  }>>>();
  const issues = [...scan.issues];
  let completed = 0;
  for (const observation of scan.archives) {
    throwIfAborted(input.signal);
    const absolute = await resolveManagedPath(input.libraryRoot, observation.path, { mustExist: true });
    try {
      const opened = await openCanonicalConversationFile({
        filePath: absolute,
        ...(input.signal ? { signal: input.signal } : {})
      });
      try {
        const conversation = opened.index.conversation;
        archiveRows[observation.path] = {
          ...projectCatalogArchiveSummary(conversation),
          sha256: opened.index.fingerprint.sha256
        };
        const source = conversation["source"] as JsonObject;
        const parser = conversation["parser"] as JsonObject;
        const adapter = parser["adapter"] as JsonObject;
        const filename = safeWindowsLeaf(String(source["file"]), "Conversation source filename");
        if (filename !== source["file"]) throw new TypeError("Conversation source filename is not canonical");
        const sourcePath = `Inbox/${filename}`;
        const values = sourceEvidence.get(sourcePath) ?? [];
        values.push({
          source: structuredClone(source),
          route: {
            format: source["format"]!,
            platform: conversation["platform"]!,
            adapter: { id: adapter["id"]!, version: adapter["version"]! },
            ...(typeof source["payload"] === "string" ? { payload_schema: source["payload"] } : {}),
            ...(typeof source["profile"] === "string" ? { profile: source["profile"] } : {})
          },
          output: projectCatalogSourceOutput(conversation, observation.path),
          lastParsedAt: String((conversation["lifecycle"] as JsonObject)["last_parsed_at"])
        });
        sourceEvidence.set(sourcePath, values);
      } finally {
        await opened.close();
      }
    } catch {
      if (input.signal?.aborted) {
        return { status: "cancelled", archives: Object.keys(archiveRows).length, sources: 0, issues };
      }
      issues.push({ path: observation.path, code: "archive-summary-unavailable" });
    }
    completed += 1;
    input.onProgress?.(completed, scan.archives.length);
  }
  if (input.signal?.aborted) return { status: "cancelled", archives: Object.keys(archiveRows).length, sources: 0, issues };

  const observations = new Map(scan.sources.map((entry) => [entry.path, entry]));
  const sourceRows: Record<string, JsonObject> = {};
  for (const [sourcePath, values] of [...sourceEvidence].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    values.sort((left, right) => left.lastParsedAt.localeCompare(right.lastParsedAt, "en") || String(left.output["path"]).localeCompare(String(right.output["path"]), "en"));
    const latest = values.at(-1)!;
    const observed = observations.get(sourcePath);
    sourceRows[sourcePath] = {
      path: sourcePath,
      bytes: observed?.bytes ?? Number(latest.source["bytes"]),
      mtime_ns: observed?.mtime_ns ?? "0",
      sha256: latest.source["sha256"]!,
      status: "complete",
      route: latest.route,
      outputs: values.map((entry) => entry.output)
    };
  }
  for (const observation of scan.sources) {
    if (sourceRows[observation.path]) continue;
    sourceRows[observation.path] = {
      path: observation.path,
      bytes: observation.bytes,
      mtime_ns: observation.mtime_ns,
      status: "pending"
    };
  }
  const rebuilt = await rebuildCatalogCache(input.libraryRoot, {
    builtAt: input.builtAt,
    adapterBundleSha256: input.adapterBundleSha256,
    sourceRows,
    archiveRows
  });
  return {
    status: rebuilt.status,
    archives: Object.keys(archiveRows).length,
    sources: Object.keys(sourceRows).length,
    issues: [...issues, ...rebuilt.issues]
  };
}

export async function rebuildCatalogCache(
  libraryRoot: string,
  input: Readonly<{
    builtAt: string;
    adapterBundleSha256: string;
    sourceRows?: Readonly<Record<string, JsonObject>>;
    archiveRows: Readonly<Record<string, JsonObject>>;
  }>
): Promise<Readonly<{
  status: "written" | "conflict" | "invalid";
  snapshot?: JsonObject;
  issues: readonly { path: string; code: string }[];
}>> {
  const expected = await observeAuxiliarySnapshot(libraryRoot, CATALOG);
  const scan = await scanLibraryFiles(libraryRoot);
  const issues = [...scan.issues];
  const observedSourcePaths = new Set(scan.sources.map((observation) => observation.path));
  const sources: JsonObject[] = scan.sources.map((observation) => ({
    ...(input.sourceRows?.[observation.path] ? structuredClone(input.sourceRows[observation.path]) : { status: "pending" }),
    path: observation.path,
    bytes: observation.bytes,
    mtime_ns: observation.mtime_ns
  }));
  for (const [relative, raw] of Object.entries(input.sourceRows ?? {})) {
    if (observedSourcePaths.has(relative)) continue;
    const prior = structuredClone(raw);
    if (
      prior["path"] !== relative
      || typeof prior["bytes"] !== "number"
      || typeof prior["mtime_ns"] !== "string"
      || typeof prior["status"] !== "string"
    ) continue;
    sources.push(prior);
  }
  sources.sort((left, right) => String(left["path"]).localeCompare(String(right["path"]), "en"));
  const archives: JsonObject[] = [];
  for (const observation of scan.archives) {
    const summary = input.archiveRows[observation.path];
    if (!summary) {
      issues.push({ path: observation.path, code: "archive-summary-unavailable" });
      continue;
    }
    archives.push({
      ...structuredClone(summary),
      path: observation.path,
      bytes: observation.bytes,
      mtime_ns: observation.mtime_ns,
      archived: observation.archived ?? false
    });
  }
  const snapshot: JsonObject = {
    schema: "cloudig/catalog-cache/1.0.0",
    built_at: input.builtAt,
    adapter_bundle_sha256: input.adapterBundleSha256,
    sources,
    archives
  };
  const validation = validateCatalogCache(snapshot);
  if (!validation.ok) {
    return {
      status: "invalid",
      issues: [...issues, ...validation.issues.map((entry) => ({ path: entry.path, code: entry.code }))]
    };
  }
  const status = await writeAuxiliarySnapshot(libraryRoot, CATALOG, Buffer.from(serializeCatalogCache(snapshot), "utf8"), expected);
  return { status, snapshot, issues };
}

// Publishing one parsed archive must not enumerate every file in the Library.
// This cache is advisory: merge the exact delta into the latest snapshot under
// the existing compare-and-swap. Explicit listing still observes the filesystem.
type ParsedCatalogDelta = Readonly<{
  builtAt: string;
  sourcePath: string;
  sourceRow: JsonObject;
  archivePath: string;
  archiveRow: JsonObject;
  retiredSourcePath?: string;
}>;
type ObservedParsedDelta = ParsedCatalogDelta & { observation: FileObservation };

async function observeParsedDelta(libraryRoot: string, input: ParsedCatalogDelta): Promise<ObservedParsedDelta> {
  const archive = await observeFile(
    await resolveManagedPath(libraryRoot, input.archivePath, { mustExist: true }),
    input.archivePath,
    input.archivePath.split("/").includes(".Cloudig-Archive")
  );
  return { ...input, observation: archive };
}

async function publishParsedDeltas(libraryRoot: string, deltas: readonly ObservedParsedDelta[]): Promise<{ status: "written" | "conflict" | "invalid" }> {
  if (deltas.length === 0) return { status: "written" };
  for (let attempt = 0; attempt < CATALOG_WRITE_ATTEMPTS; attempt += 1) {
    const expected = await observeAuxiliarySnapshot(libraryRoot, CATALOG);
    const current = await readCatalogCache(libraryRoot);
    if (!current) return { status: "invalid" };
    const sourceRows = new Map((current["sources"] as JsonObject[]).map(row => [String(row["path"]), row]));
    const archiveRows = new Map((current["archives"] as JsonObject[]).map(row => [String(row["path"]), row]));
    for (const input of deltas) {
      if (input.retiredSourcePath) sourceRows.delete(input.retiredSourcePath);
      sourceRows.set(input.sourcePath, { ...input.sourceRow, path: input.sourcePath });
      archiveRows.set(input.archivePath, { ...input.archiveRow, ...input.observation });
    }
    const byPath = (a: JsonObject, b: JsonObject) => String(a["path"]).localeCompare(String(b["path"]), "en");
    const next = { ...current, built_at: deltas.at(-1)!.builtAt, sources: [...sourceRows.values()].sort(byPath), archives: [...archiveRows.values()].sort(byPath) };
    const validation = validateCatalogCache(next);
    if (!validation.ok) return { status: "invalid" };
    // Catalog is rebuildable, not a transaction recovery point. Atomic rename
    // and the compare-and-swap remain; fsync belongs to the authority files.
    const status = await writeAuxiliarySnapshot(libraryRoot, CATALOG, Buffer.from(serializeCatalogCache(next), "utf8"), expected, { durable: false });
    if (status === "written") return { status };
  }
  return { status: "conflict" };
}

export async function publishParsedCatalogDelta(libraryRoot: string, input: ParsedCatalogDelta): Promise<{ status: "written" | "conflict" | "invalid" }> {
  return publishParsedDeltas(libraryRoot, [await observeParsedDelta(libraryRoot, input)]);
}

// The batch publishes the rebuildable cache once, including on cancellation.
// Conversation and Library authority still commit independently for every file.
export class ParserCatalogBatch {
  readonly #root: string;
  readonly #deltas: ObservedParsedDelta[] = [];
  constructor(root: string) { this.#root = root; }
  async publish(input: ParsedCatalogDelta): Promise<{ status: "deferred" }> {
    this.#deltas.push(await observeParsedDelta(this.#root, input));
    return { status: "deferred" };
  }
  async flush(): Promise<{ status: "written" | "conflict" | "invalid" }> {
    const deltas = this.#deltas.splice(0);
    return publishParsedDeltas(this.#root, deltas);
  }
}

export async function refreshCatalogAfterArchiveAdoption(
  libraryRoot: string,
  input: Readonly<{
    path: string;
    previousArchive: string;
    nextArchive: string;
    generation: number;
    fingerprint: ByteFingerprint;
    builtAt: string;
  }>
): Promise<"written" | "conflict" | "missing" | "invalid"> {
  const expected = await observeAuxiliarySnapshot(libraryRoot, CATALOG);
  const current = await readCatalogCache(libraryRoot);
  if (!current || !expected) return "missing";
  const snapshot = structuredClone(current);
  const archives = snapshot["archives"];
  if (!Array.isArray(archives)) return "invalid";
  const matches = archives.filter((raw) => raw && typeof raw === "object" && !Array.isArray(raw) && raw["path"] === input.path) as JsonObject[];
  if (
    matches.length !== 1
    || matches[0]!["archive"] !== input.previousArchive
    || matches[0]!["generation"] !== input.generation
  ) return "invalid";
  const absolute = await resolveManagedPath(libraryRoot, input.path, { mustExist: true });
  const info = await stat(absolute, { bigint: true });
  matches[0]!["archive"] = input.nextArchive;
  matches[0]!["bytes"] = input.fingerprint.bytes;
  matches[0]!["sha256"] = input.fingerprint.sha256;
  matches[0]!["mtime_ns"] = String(info.mtimeNs);

  const sources = snapshot["sources"];
  if (Array.isArray(sources)) {
    for (const raw of sources) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw["outputs"])) continue;
      for (const output of raw["outputs"]) {
        if (
          output
          && typeof output === "object"
          && !Array.isArray(output)
          && output["path"] === input.path
          && output["archive"] === input.previousArchive
          && output["generation"] === input.generation
        ) output["archive"] = input.nextArchive;
      }
    }
  }
  snapshot["built_at"] = input.builtAt;
  const validation = validateCatalogCache(snapshot);
  if (!validation.ok) return "invalid";
  return writeAuxiliarySnapshot(libraryRoot, CATALOG, Buffer.from(serializeCatalogCache(snapshot), "utf8"), expected);
}

export type CatalogRefreshStatus = "written" | "conflict" | "missing" | "invalid";

type ArchiveCatalogIdentity = Readonly<{
  archive: string;
  generation: number;
  fingerprint: ByteFingerprint;
}>;

function exactArchiveRow(row: JsonObject, pathValue: string, expected: ArchiveCatalogIdentity): boolean {
  return row["path"] === pathValue
    && row["archive"] === expected.archive
    && row["generation"] === expected.generation
    && row["bytes"] === expected.fingerprint.bytes
    && row["sha256"] === expected.fingerprint.sha256;
}

function updateSourceOutputPaths(
  snapshot: JsonObject,
  sourcePath: string,
  targetPath: string,
  expected: ArchiveCatalogIdentity
): void {
  const sources = snapshot["sources"];
  if (!Array.isArray(sources)) return;
  for (const raw of sources) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw["outputs"])) continue;
    for (const output of raw["outputs"]) {
      if (
        output
        && typeof output === "object"
        && !Array.isArray(output)
        && output["path"] === sourcePath
        && output["archive"] === expected.archive
        && output["generation"] === expected.generation
      ) output["path"] = targetPath;
    }
  }
}

function removeSourceOutput(
  snapshot: JsonObject,
  archivePath: string,
  expected: ArchiveCatalogIdentity
): void {
  const sources = snapshot["sources"];
  if (!Array.isArray(sources)) return;
  for (const raw of sources) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw["outputs"])) continue;
    const outputs = raw["outputs"].filter((output) => !(
      output
      && typeof output === "object"
      && !Array.isArray(output)
      && output["path"] === archivePath
      && output["archive"] === expected.archive
      && output["generation"] === expected.generation
    ));
    if (outputs.length === raw["outputs"].length) continue;
    if (outputs.length > 0) raw["outputs"] = outputs;
    else {
      delete raw["outputs"];
      if (raw["status"] === "complete") raw["status"] = "pending";
    }
  }
}

async function writeCatalogMutation(
  libraryRoot: string,
  builtAt: string,
  mutate: (snapshot: JsonObject) => "changed" | "invalid"
): Promise<CatalogRefreshStatus> {
  for (let attempt = 0; attempt < CATALOG_WRITE_ATTEMPTS; attempt += 1) {
    const expectedSnapshot = await observeAuxiliarySnapshot(libraryRoot, CATALOG);
    const current = await readCatalogCache(libraryRoot);
    if (!current || !expectedSnapshot) return "missing";
    const snapshot = structuredClone(current);
    if (mutate(snapshot) === "invalid") return "invalid";
    snapshot["built_at"] = builtAt;
    const validation = validateCatalogCache(snapshot);
    if (!validation.ok) return "invalid";
    const status = await writeAuxiliarySnapshot(
      libraryRoot,
      CATALOG,
      Buffer.from(serializeCatalogCache(snapshot), "utf8"),
      expectedSnapshot
    );
    if (status === "written") return "written";
  }
  return "conflict";
}

export async function refreshCatalogAfterArchiveMove(
  libraryRoot: string,
  input: Readonly<{
    sourcePath: string;
    targetPath: string;
    targetArchived: boolean;
    expected: ArchiveCatalogIdentity;
    builtAt: string;
  }>
): Promise<CatalogRefreshStatus> {
  const absolute = await resolveManagedPath(libraryRoot, input.targetPath, { mustExist: true });
  const [info, fingerprint] = await Promise.all([stat(absolute, { bigint: true }), fingerprintFile(absolute)]);
  if (
    fingerprint.bytes !== input.expected.fingerprint.bytes
    || fingerprint.sha256 !== input.expected.fingerprint.sha256
  ) return "invalid";

  return writeCatalogMutation(libraryRoot, input.builtAt, (snapshot) => {
    const archives = snapshot["archives"];
    if (!Array.isArray(archives)) return "invalid";
    const rows = archives.filter((raw): raw is JsonObject => Boolean(raw) && typeof raw === "object" && !Array.isArray(raw));
    const sourceMatches = rows.filter((row) => exactArchiveRow(row, input.sourcePath, input.expected));
    const targetMatches = rows.filter((row) => exactArchiveRow(row, input.targetPath, input.expected));
    if (sourceMatches.length + targetMatches.length !== 1) return "invalid";
    const row = sourceMatches[0] ?? targetMatches[0]!;
    row["path"] = input.targetPath;
    row["bytes"] = fingerprint.bytes;
    row["sha256"] = fingerprint.sha256;
    row["mtime_ns"] = String(info.mtimeNs);
    row["archived"] = input.targetArchived;
    updateSourceOutputPaths(snapshot, input.sourcePath, input.targetPath, input.expected);
    return "changed";
  });
}

export async function refreshCatalogAfterArchiveRemoval(
  libraryRoot: string,
  input: Readonly<{
    path: string;
    expected: ArchiveCatalogIdentity;
    builtAt: string;
  }>
): Promise<CatalogRefreshStatus> {
  const absolute = await resolveManagedPath(libraryRoot, input.path);
  try {
    await stat(absolute);
    return "invalid";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  return writeCatalogMutation(libraryRoot, input.builtAt, (snapshot) => {
    const archives = snapshot["archives"];
    if (!Array.isArray(archives)) return "invalid";
    const exactIndexes: number[] = [];
    for (const [index, raw] of archives.entries()) {
      if (raw && typeof raw === "object" && !Array.isArray(raw) && exactArchiveRow(raw, input.path, input.expected)) {
        exactIndexes.push(index);
      }
    }
    if (exactIndexes.length > 1) return "invalid";
    if (exactIndexes.length === 1) archives.splice(exactIndexes[0]!, 1);
    removeSourceOutput(snapshot, input.path, input.expected);
    return "changed";
  });
}

export async function refreshCatalogAfterDirectoryRename(
  libraryRoot: string,
  input: Readonly<{ from: string; to: string; builtAt: string }>
): Promise<CatalogRefreshStatus> {
  const sourcePrefix = `Conversations/${input.from}/`;
  const targetPrefix = `Conversations/${input.to}/`;
  return writeCatalogMutation(libraryRoot, input.builtAt, (snapshot) => {
    const archives = snapshot["archives"];
    if (!Array.isArray(archives)) return "invalid";
    const rows = archives.filter((raw): raw is JsonObject => Boolean(raw) && typeof raw === "object" && !Array.isArray(raw));
    const sourceRows = rows.filter((row) => typeof row["path"] === "string" && row["path"].startsWith(sourcePrefix));
    const targetPaths = new Set(rows
      .map((row) => row["path"])
      .filter((value): value is string => typeof value === "string" && value.startsWith(targetPrefix)));
    for (const row of sourceRows) {
      const next = `${targetPrefix}${String(row["path"]).slice(sourcePrefix.length)}`;
      if (targetPaths.has(next)) return "invalid";
      row["path"] = next;
    }
    const sources = snapshot["sources"];
    if (Array.isArray(sources)) {
      for (const raw of sources) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw["outputs"])) continue;
        for (const output of raw["outputs"]) {
          if (output && typeof output === "object" && !Array.isArray(output) && typeof output["path"] === "string" && output["path"].startsWith(sourcePrefix)) {
            output["path"] = `${targetPrefix}${output["path"].slice(sourcePrefix.length)}`;
          }
        }
      }
    }
    return "changed";
  });
}

function directInboxPath(value: string): string {
  const segments = value.split("/");
  if (segments.length !== 2 || segments[0] !== "Inbox" || segments[1]!.length === 0) {
    throw new TypeError("Source Catalog mutation requires one direct Inbox file");
  }
  return value;
}

export async function recordCatalogSourceFailure(
  libraryRoot: string,
  input: Readonly<{
    path: string;
    expected: Readonly<{ bytes: number; mtimeNs: string }>;
    status: "failed" | "unsupported";
    failure?: Readonly<{ sourceSha256: string; watermark: string; contentFailure: boolean }>;
    error: Readonly<{
      code: string;
      phase: "discover" | "probe" | "fingerprint" | "extract" | "normalize" | "validate" | "plan" | "stage" | "commit" | "verify";
      retry: "immediate" | "after_source_change" | "after_adapter_change" | "after_conflict_resolution" | "after_recovery" | "never_for_this_version";
      detail?: string;
    }>;
    builtAt: string;
  }>
): Promise<CatalogRefreshStatus> {
  const relative = directInboxPath(input.path);
  const absolute = await resolveManagedPath(libraryRoot, relative, { mustExist: true });
  const info = await stat(absolute, { bigint: true });
  if (Number(info.size) !== input.expected.bytes || String(info.mtimeNs) !== input.expected.mtimeNs) return "invalid";
  return writeCatalogMutation(libraryRoot, input.builtAt, (snapshot) => {
    const sources = snapshot["sources"];
    if (!Array.isArray(sources)) return "invalid";
    const matches = sources.filter((raw): raw is JsonObject => isJsonObject(raw) && raw["path"] === relative);
    if (matches.length !== 1) return "invalid";
    const row = matches[0]!;
    if (row["bytes"] !== input.expected.bytes || row["mtime_ns"] !== input.expected.mtimeNs) return "invalid";
    row["status"] = input.status;
    row["error"] = structuredClone(input.error as unknown as JsonObject);
    if (input.failure) {
      const prior = isJsonObject(row["failure"]) ? row["failure"] : undefined;
      const previousAttempts = prior?.["source_sha256"] === input.failure.sourceSha256 && prior["watermark"] === input.failure.watermark
        ? Number(prior["attempts"] ?? 0) : 0;
      const attempts = Math.min(2, previousAttempts + (input.failure.contentFailure ? 1 : 0));
      row["failure"] = { source_sha256: input.failure.sourceSha256, watermark: input.failure.watermark, attempts };
      row["status"] = input.failure.contentFailure && attempts >= 2 ? "unsupported" : "failed";
      (row["error"] as JsonObject)["retry"] = row["status"] === "unsupported" ? "after_adapter_change" : "immediate";
    }
    delete row["sha256"];
    delete row["route"];
    delete row["action"];
    return "changed";
  });
}

export async function dismissMissingCatalogSource(
  libraryRoot: string,
  input: Readonly<{
    path: string;
    expected: Readonly<{ bytes: number; mtimeNs: string }>;
    builtAt: string;
  }>
): Promise<CatalogRefreshStatus> {
  const relative = directInboxPath(input.path);
  const absolute = await resolveManagedPath(libraryRoot, relative);
  try {
    await stat(absolute);
    return "invalid";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return writeCatalogMutation(libraryRoot, input.builtAt, (snapshot) => {
    const sources = snapshot["sources"];
    if (!Array.isArray(sources)) return "invalid";
    const indexes = sources.flatMap((raw, index) => raw && typeof raw === "object" && !Array.isArray(raw)
      && raw["path"] === relative
      && raw["bytes"] === input.expected.bytes
      && raw["mtime_ns"] === input.expected.mtimeNs
      ? [index]
      : []);
    if (indexes.length !== 1) return "invalid";
    sources.splice(indexes[0]!, 1);
    return "changed";
  });
}
