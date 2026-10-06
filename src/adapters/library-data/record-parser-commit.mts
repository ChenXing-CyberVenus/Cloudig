import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { assembleConversationRecord } from "../../app/parser/conversation-record.mts";
import type { ExtractedRecord } from "../../app/parser/record-source.mts";
import { parseRecordJson } from "../../core/records/index.mts";
import { prepareRecordEncoding } from "../../core/records/encoding.mts";
import { confinedRelativePath } from "../../core/records/layout.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { chooseNoReplaceLeaf, safeWindowsLeaf } from "../storage/names.mts";
import { commitRecords, readStoredRecord, readStoredConversationMetadata, resolveRecordPath, withRecordSnapshot, recordFileIdentity, RecordStoreConflict, type RecordFileIdentity, type RecordReadGuard, type RecordSourceReads } from "../storage/record-store.mts";
import { readRecordCatalog, uniqueConversation } from "./record-catalog.mts";
import { CONVERSATION_SCHEMA, LIBRARY_SCHEMA, recordSchemas } from "../../core/records/schema-registry.mts";

const hash = (v: Uint8Array | string): string => createHash("sha256").update(v).digest("hex");
const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
export function recordSourceUnitKey(path: string, format: string, platform: string, locator?: string): JsonObject {
  // An ordinary HTML file is one unit. Only a multi-record container needs a
  // locator to distinguish units; its platform conversation ID is just fact.
  return { path, format, platform, ...(["json-container", "zip-container"].includes(format) && locator ? { locator } : {}) };
}
export function recordHistoryKey(sourcePath: string, conversation: JsonObject): JsonObject {
  const source = object(conversation["source"]), locator = source["locator"];
  return recordSourceUnitKey(sourcePath, String(source["format"]), String(conversation["platform"]), typeof locator === "string" ? locator : undefined);
}
export const recordHistoryPath = (key: JsonObject): string => `appdata/parse-history/${hash(JSON.stringify(key))}.json`;
export function recordHistoryMatches(value: JsonObject, key: JsonObject): boolean {
  const source = object(value["source"]);
  return value["schema"] === "cloudig/parse-history/1.0.0" && source["path"] === key["path"] && source["format"] === key["format"] && source["platform"] === key["platform"]
    && (!["json-container", "zip-container"].includes(String(key["format"])) || source["locator"] === key["locator"]);
}
type StoredHistory = Readonly<{ path: string; value: JsonObject; sha256: string }>;
/** Read-only compatibility: old HTML histories included a non-unit locator.
 * At most one legacy-directory scan per query; never infer ownership by title,
 * URL or matching content, and never choose between ambiguous old histories. */
export function createRecordHistoryReader(root: string): (key: JsonObject, legacyLocator?: string | null) => Promise<StoredHistory | undefined> {
  const read = async (path: string): Promise<StoredHistory | undefined> => {
    try {
      const bytes = await readFile(await resolveRecordPath(root, path));
      let value: JsonObject = {};
      try { value = object(parseRecordJson(bytes.toString("utf8"))); }
      catch (e) { if (!(e instanceof TypeError || e instanceof SyntaxError)) throw e; }
      // Unreadable history gives no right to replace a Conversation. Keep its
      // actual fingerprint so an explicit successful parse can replace the
      // damaged history atomically, without treating an existing file as absent.
      return { path, value, sha256: hash(bytes) };
    }
    catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return; throw e; }
  };
  let legacy: Promise<Map<string, StoredHistory[]>> | undefined;
  return async (key, legacyLocator) => {
    const exact = await read(recordHistoryPath(key));
    if (exact || key["format"] !== "exporter-html") return exact;
    // A writer already has the extracted locator: use its exact old address,
    // rather than rescanning the history directory for every newly saved file.
    if (legacyLocator !== undefined) return legacyLocator ? read(recordHistoryPath({ ...key, locator: legacyLocator })) : undefined;
    legacy ??= (async () => {
      const byUnit = new Map<string, StoredHistory[]>();
      let entries;
      try { entries = await readdir(await resolveRecordPath(root, "appdata/parse-history"), { withFileTypes: true }); }
      catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return byUnit; throw e; }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
        let stored;
        try { stored = await read(`appdata/parse-history/${entry.name}`); }
        catch (e) { if (e instanceof TypeError || e instanceof SyntaxError) continue; throw e; }
        const source = object(stored?.value["source"]);
        if (!stored || stored.value["schema"] !== "cloudig/parse-history/1.0.0" || source["format"] !== "exporter-html"
          || typeof source["path"] !== "string" || typeof source["platform"] !== "string" || typeof source["locator"] !== "string" || !source["locator"]
          || stored.path !== recordHistoryPath(source)) continue;
        const unit = recordHistoryPath(recordSourceUnitKey(source["path"], source["format"], source["platform"]));
        const found = byUnit.get(unit) ?? []; found.push(stored); byUnit.set(unit, found);
      }
      return byUnit;
    })();
    const found = (await legacy).get(recordHistoryPath(key));
    return found?.length === 1 ? found[0] : undefined;
  };
}
function outputLeaf(record: JsonObject): string {
  const title = object(record["title"]), raw = String(title["filename"] ?? title["original"] ?? "Conversation");
  let stem = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ").trim().replace(/[ .]+$/u, "") || "Conversation";
  // Windows counts UTF-16 units; do not split a surrogate pair at the bound.
  while (stem.length > 225) stem = Array.from(stem).slice(0, -1).join("");
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
  return safeWindowsLeaf(`${stem}.json`, "Conversation filename");
}
function newer(saved: JsonObject, current: JsonObject): boolean {
  const compare = (a: unknown, b: unknown): number | undefined => {
    if (typeof a !== "string" || typeof b !== "string" || !/^\d+(?:\.\d+)*$/u.test(a) || !/^\d+(?:\.\d+)*$/u.test(b)) return undefined;
    const aa = a.split(".").map(BigInt), bb = b.split(".").map(BigInt);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) if ((aa[i] ?? 0n) !== (bb[i] ?? 0n)) return (aa[i] ?? 0n) > (bb[i] ?? 0n) ? 1 : -1;
    return 0;
  };
  const oldAdapter = object(saved["adapter"]), adapter = object(current["adapter"]);
  // Unknown/different adapter lineage is not permission to overwrite.
  return oldAdapter["id"] !== adapter["id"] || (compare(saved["version"], current["version"]) ?? 1) > 0 || (compare(oldAdapter["version"], adapter["version"]) ?? 1) > 0;
}

export async function saveExtractedRecord(root: string, input: Readonly<{
  extracted: ExtractedRecord; sourcePath: string; parserVersion: string; timestamp: string; keepPrevious?: boolean; directory?: string; signal?: AbortSignal; sourceReads?: RecordSourceReads;
}>): Promise<Readonly<{ path: string; conversation: JsonObject; replaced: boolean; maintenanceWarnings: readonly string[] }>> {
  return savePreparedRecord(root, { ...input, conversation: assembleConversationRecord({ ...input.extracted, parserVersion: input.parserVersion, timestamp: input.timestamp }) });
}

/** Worker output is a complete new-schema Conversation; no V8/worker fields enter it. */
export async function savePreparedRecord(root: string, input: Readonly<{
  conversation: JsonObject; sourcePath: string; keepPrevious?: boolean; directory?: string; directoryIdentity?: RecordFileIdentity; relocateExisting?: boolean; signal?: AbortSignal; sourceReads?: RecordSourceReads;
}>): Promise<Readonly<{ path: string; conversation: JsonObject; replaced: boolean; maintenanceWarnings: readonly string[] }>> {
  confinedRelativePath(input.sourcePath);
  if (!input.sourcePath.startsWith("Inbox/")) throw new TypeError("Parser source must be in Inbox");
  const prepared = await withRecordSnapshot(root, async () => {
    const library = await readStoredRecord(root, "library", "CloudigLibrary.json");
    const directory = input.directory ?? String(object(library.value["settings"])["default_output_directory"]);
    confinedRelativePath(directory);
    if (directory !== "Conversations" && !directory.startsWith("Conversations/")) throw new TypeError("Output directory must be in Conversations");
    const key = recordHistoryKey(input.sourcePath, input.conversation);
    const historyPath = recordHistoryPath(key);
    const locator = object(input.conversation["source"])["locator"];
    const storedHistory = await createRecordHistoryReader(root)(key, typeof locator === "string" ? locator : null), history = storedHistory?.value ?? {};
    const historySha = storedHistory?.path === historyPath ? storedHistory.sha256 : null;
    const validHistory = recordHistoryMatches(history, key);
    const output = validHistory ? object(history["output"]) : {};
    let previous: JsonObject | undefined, previousPath: string | undefined, previousSha: string | undefined;
    if (!input.keepPrevious && typeof output["conversation_id"] === "string") {
      // Parse history already records the exact archive path produced for this
      // source unit. Prefer that path over a title/ID catalog lookup: a stale
      // or duplicated catalog must not turn an adapter reparse into a second
      // `(2)` archive. The catalog remains the compatibility fallback for old
      // histories that predate the path field.
      const outputPath = typeof output["path"] === "string" && output["path"].startsWith("Conversations/") ? output["path"] : undefined;
      const candidates = outputPath ? [outputPath] : [];
      if (!outputPath) {
        const catalog = await readRecordCatalog(root);
        const found = uniqueConversation(catalog, output["conversation_id"]);
        if (found) candidates.push(found.path);
      }
      for (const candidatePath of candidates) {
        let actual;
        try {
          actual = await readStoredConversationMetadata(root, candidatePath);
        } catch (error) {
          // A user may delete a Conversation while keeping Inbox and
          // parse-history. Missing historical output means "create again";
          // it is not a parser failure. Other storage errors remain fatal.
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        if (actual.value["conversation_id"] === output["conversation_id"] && actual.sha256 === output["sha256"] && !newer(object(actual.value["parser"]), object(input.conversation["parser"]))) {
          previous = actual.value; previousPath = candidatePath; previousSha = actual.sha256; break;
        }
      }
    }
    const conversation = { ...input.conversation };
    if (previous) {
      conversation["conversation_id"] = previous["conversation_id"]!;
      conversation["lifecycle"] = { ...object(conversation["lifecycle"]), first_parsed_at: object(previous["lifecycle"])["first_parsed_at"]! };
      const title = { ...object(conversation["title"]) }, oldTitle = object(previous["title"]);
      delete title["filename"]; if (Object.hasOwn(oldTitle, "filename")) title["filename"] = oldTitle["filename"]!;
      if (Object.keys(title).length) conversation["title"] = title;
      else delete conversation["title"];
    }
    const relocating = !!previousPath && input.relocateExisting === true && previousPath.slice(0, previousPath.lastIndexOf("/")) !== directory;
    let target = relocating ? undefined : previousPath;
    if (!target) {
      let occupied: string[] = [];
      try { occupied = await readdir(await resolveRecordPath(root, directory)); }
      catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
      const leaf = relocating ? previousPath!.slice(previousPath!.lastIndexOf("/") + 1) : outputLeaf(conversation);
      target = `${directory}/${chooseNoReplaceLeaf(leaf, new Set(occupied))}`;
    }
    const reads: RecordReadGuard[] = [ { path: "CloudigLibrary.json", expected: library.sha256 },
      { path: input.sourcePath, expected: String(object(input.conversation["source"])["sha256"]) } ];
    if (storedHistory && storedHistory.path !== historyPath) reads.push({ path: storedHistory.path, expected: storedHistory.sha256 });
    // Only an explicit successful write of the new format upgrades the Library
    // declaration, in the same transaction. Reads and ordinary old-format
    // parses never rewrite Library settings or unrelated Conversation files.
    const libraryUpgrade = conversation["schema"] === CONVERSATION_SCHEMA && library.value["schema"] !== LIBRARY_SCHEMA
      ? { action: "write" as const, kind: "library" as const, path: "CloudigLibrary.json", expected: library.sha256,
        value: { ...library.value, schema: LIBRARY_SCHEMA,
          schemas: Object.fromEntries(Object.entries(recordSchemas.library.properties.schemas.properties).map(([kind, v]) => [kind, v.const])),
          edited_at: object(conversation["lifecycle"])["last_parsed_at"]! } }
      : undefined;
    return { target, conversation, previousSha, previousPath, relocating, historyPath, historySha, key, reads, libraryUpgrade };
  });
  // Same human-readable bytes used for write and parse-history fingerprint.
  const history = { schema: "cloudig/parse-history/1.0.0", source: prepared.key,
    output: { path: prepared.target, conversation_id: prepared.conversation["conversation_id"], sha256: prepareRecordEncoding("conversation", prepared.conversation).fingerprint.sha256 },
    parser: prepared.conversation["parser"], parsed_at: object(prepared.conversation["lifecycle"])["last_parsed_at"] };
  const saved = await commitRecords(root, [
    ...(prepared.libraryUpgrade ? [prepared.libraryUpgrade] : []),
    { action: "write", path: prepared.target, kind: "conversation", value: prepared.conversation, expected: prepared.relocating ? null : prepared.previousSha ?? null },
    ...(prepared.relocating ? [{ action: "delete" as const, path: prepared.previousPath!, expected: prepared.previousSha! }] : []),
    { action: "binary", path: prepared.historyPath, data: Buffer.from(JSON.stringify(history, null, 2) + "\n"), expected: prepared.historySha }
  ], { reads: prepared.libraryUpgrade ? prepared.reads.filter(read => read.path !== "CloudigLibrary.json") : prepared.reads, ...(input.sourceReads ? { sourceReads: input.sourceReads } : {}), ...(input.signal ? { signal: input.signal } : {}),
    ...(input.directoryIdentity ? { preflight: async () => {
      if (!input.directory) throw new TypeError("Output identity requires a directory");
      const actual = await recordFileIdentity(root, input.directory, "directory");
      if (actual.device !== input.directoryIdentity!.device || actual.inode !== input.directoryIdentity!.inode) throw new RecordStoreConflict("Output directory changed after preview; select it again");
    } } : {}) });
  return { path: prepared.target, conversation: prepared.conversation, replaced: prepared.previousSha !== undefined, maintenanceWarnings: saved?.maintenanceWarnings ?? [] };
}
