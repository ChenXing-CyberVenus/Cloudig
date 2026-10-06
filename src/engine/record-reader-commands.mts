import { randomBytes } from "node:crypto";
import { setImmediate as yieldToEngine } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import type { BuiltinIdentity } from "../core/library/overlay.mts";
import { readRecordCatalog } from "../adapters/library-data/record-catalog.mts";
import { readConversationRecord, readRecordPresentationContext } from "../adapters/library-data/record-reading.mts";
import { listRecordDirectories, recordArchiveFacts, recordTimeRootOrder } from "../adapters/library-data/record-archive-list.mts";
import { queryRecordArchives, recordArchiveRow, recordArchiveDirectory, RECORD_ARCHIVE_TIME_FIELDS, RECORD_ARCHIVE_LOCATIONS, type RecordArchiveLocation, type RecordArchiveFact, type RecordArchiveQuery } from "../app/reader/record-archive-list.mts";
import { saveConversationMark } from "../adapters/library-data/record-mark.mts";
import { withRecordSnapshot, readStoredConversationMetadata, RecordStoreConflict } from "../adapters/storage/record-store.mts";
import { markSettings, recordInfoDraft, applyRecordInfoDraft, recordInfoTime } from "../app/reader/record-info.mts";
import { resolveRecordPresentation, projectRecordForReading } from "../core/records/presentation.mts";
import { localRecordAnchor } from "./record-library-commands.mts";
import { recordFileIdentity } from "../adapters/storage/record-store.mts";
import { createRecordDirectory, renameRecordDirectory, deleteEmptyRecordDirectory, moveRecordConversation, type RecordDirectory } from "../adapters/library-data/record-file-operations.mts";
import { exportRecordMarkdown, prepareRecordMarkdown } from "../adapters/library-data/record-markdown-export.mts";
import { RecordRecycleSession, pendingRecordRecycles } from "../adapters/library-data/record-recycle.mts";
import type { RecordIdentityNames } from "../adapters/library-data/record-identity.mts";
import { identityName } from "../core/records/identity-edit.mts";
import type { ConversationViewPageInput } from "../app/reader/view-model.mts";
import { RuntimeConversationViews } from "../adapters/runtime/conversation-views.mts";
import { EngineCommandError, type EngineCommandHandler, type EngineCommandContext } from "./protocol.mts";
import { scanConversationMessages, FULL_TEXT_LIMITS } from "../app/reader/full-text-search.mts";
import { SEARCH_CATEGORIES, DEFAULT_SEARCH_CATEGORIES, selectedMessageBlocks, type SearchCategory, type ContentMode } from "../app/reader/content-selection.mts";
import { conversationMessagePath, messageSelectionSummary } from "../app/reader/view-model-core.mts";
import { locateConversationMessage } from "../app/reader/message-location.mts";
import resourceLimits from "../core/contracts/machine/resource-limits.json" with { type: "json" };
import { QueryPages } from "./query-pages.mts";
import { PublicExamples } from '../adapters/reader/public-examples.mts';
import { readReaderPosition, saveReaderPosition } from "../adapters/library-data/reader-state.mts";

// Session-only capabilities. These are not business IDs or persistent indexes.
export const RECORD_READER_LIMITS = Object.freeze({ queryPage: 200, directoryFilters: 128, platformFilters: 64, searchCharacters: 256, exportProgressIntervalMs: 100, pendingMarkdownCopies: 2, markdownSummaryCharacters: 160, markdownSelectionChunk: 400, retainedMarkdownSelections: 2 });
type Reading = Awaited<ReturnType<typeof readConversationRecord>>;
type ArchiveHandle = { id: string; path: string; conversationSha: string; markSha: string | null; access: RecordArchiveFact["access"]; messageCount: number };
const token = (prefix: string): string => `${prefix}_${randomBytes(32).toString("base64url")}`;
function object(value: JsonValue | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!isJsonObject(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Unexpected command fields");
  return value;
}
function page(value: JsonValue | undefined, maximum: number): { offset: number; limit: number } {
  const v = object(value, ["offset", "limit"]);
  if (!Number.isSafeInteger(v["offset"]) || Number(v["offset"]) < 0 || !Number.isSafeInteger(v["limit"]) || Number(v["limit"]) < 1 || Number(v["limit"]) > maximum) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Page is outside its limits");
  return { offset: Number(v["offset"]), limit: Number(v["limit"]) };
}
export function recordReaderViewRequest(value: JsonValue | undefined): ConversationViewPageInput {
  const raw = object(value, ["messages", "navigation", "branches"], ["session", "summary_characters"]);
  const result: ConversationViewPageInput = { page: page(raw["messages"], resourceLimits.reader_message_page_max), navigationPage: page(raw["navigation"], resourceLimits.reader_navigation_page_max), branchPage: page(raw["branches"], resourceLimits.reader_branch_page_max) };
  let session: ConversationViewPageInput["session"];
  if (raw["session"] !== undefined) {
    const s = object(raw["session"], ["expanded", "hidden", "navigation"], ["selected_leaf", "branch_choices"]);
    const flags = (name: string, fields: readonly string[]): Record<string, boolean> => { const value = object(s[name], fields); if (Object.values(value).some(v => typeof v !== "boolean")) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Reader state flags must be boolean"); return value as Record<string, boolean>; };
    const expanded = flags("expanded", ["reasoning", "tools", "references"]), hidden = flags("hidden", ["reasoning", "tools"]), navigation = flags("navigation", ["user", "assistant", "process"]);
    if (s["selected_leaf"] !== undefined && (typeof s["selected_leaf"] !== "string" || !s["selected_leaf"])) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid branch leaf");
    if (s["branch_choices"] !== undefined && (!isJsonObject(s["branch_choices"]) || Object.entries(s["branch_choices"]).some(([parent, child]) => !parent || typeof child !== "string" || !child))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid branch choices");
    session = { expanded: { reasoning: expanded["reasoning"]!, tools: expanded["tools"]!, references: expanded["references"]! }, hidden: { reasoning: hidden["reasoning"]!, tools: hidden["tools"]! }, navigation: { user: navigation["user"]!, assistant: navigation["assistant"]!, process: navigation["process"]! },
      ...(typeof s["selected_leaf"] === "string" ? { selectedLeaf: s["selected_leaf"] } : {}), ...(isJsonObject(s["branch_choices"]) ? { branchChoices: s["branch_choices"] as Record<string, string> } : {}) };
  }
  if (raw["summary_characters"] !== undefined && (!Number.isSafeInteger(raw["summary_characters"]) || Number(raw["summary_characters"]) < 1)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid navigation summary bound");
  return { ...result, ...(session ? { session } : {}), ...(raw["summary_characters"] !== undefined ? { navigationSummaryCharacters: Number(raw["summary_characters"]) } : {}) };
}

/** New record consumers; main.mts switches once all S3-S5 routes are ready. */
export class RecordReaderEngineCommands {
  readonly #root: string; readonly #builtins: BuiltinIdentity; readonly #clock: () => string;
  readonly #archives = new Map<string, ArchiveHandle>();
  readonly #pages = new QueryPages();
  readonly #searchPages = new QueryPages(FULL_TEXT_LIMITS.retainedSnapshots);
  readonly #markdownCopies = new Map<string, Awaited<ReturnType<typeof prepareRecordMarkdown>>>();
  readonly #markdownSelections = new Map<string, { archive: string; ids: Set<string> }>();
  #pendingCopies = 0;
  readonly #archiveKeys = new Map<string, string>();
  readonly #directories = new Map<string, RecordDirectory>();
  readonly #directoryKeys = new Map<string, string>();
  readonly #runtime: RuntimeConversationViews;
  readonly #examples?: PublicExamples;
  readonly #recycle: RecordRecycleSession;
  readonly #projectTime: (range: JsonObject) => Promise<JsonObject>;
  readonly #resolveTime: (range: JsonObject) => Promise<JsonObject>;
  constructor(input: Readonly<{ libraryRoot: string; runtimeRoot: string; builtins: BuiltinIdentity; clock?: () => string; examplesRoot?: string;
    projectTimeRange?: (range: JsonObject) => Promise<JsonObject>; resolveTimeRange?: (range: JsonObject) => Promise<JsonObject> }>) {
    this.#root = input.libraryRoot; this.#builtins = input.builtins; this.#clock = input.clock ?? (() => new Date().toISOString());
    this.#runtime = new RuntimeConversationViews({ libraryRoot: input.libraryRoot, runtimeRoot: input.runtimeRoot, now: this.#clock });
    if (input.examplesRoot) this.#examples = new PublicExamples(input.examplesRoot, input.builtins);
    this.#recycle = new RecordRecycleSession(input.libraryRoot);
    this.#projectTime = input.projectTimeRange ?? (async range => structuredClone(range));
    this.#resolveTime = input.resolveTimeRange ?? (async range => structuredClone(range));
  }
  #key(fact: RecordArchiveFact): string { return JSON.stringify([fact.path, fact.id, fact.sha256, fact.markSha]); }
  #refresh(facts: readonly RecordArchiveFact[], directories: readonly RecordDirectory[]): void {
    const keep = new Set<string>();
    for (const fact of facts) {
      const key = this.#key(fact); keep.add(key); let capability = this.#archiveKeys.get(key);
      if (!capability) { capability = token("a"); this.#archiveKeys.set(key, capability); }
      this.#archives.set(capability, { id: fact.id, path: fact.path, conversationSha: fact.sha256, markSha: fact.markSha, access: fact.access, messageCount: fact.messages });
    }
    for (const [key, capability] of this.#archiveKeys) if (!keep.has(key)) { this.#archiveKeys.delete(key); this.#archives.delete(capability); }
    for (const directory of directories) {
      const prior = this.#directoryKeys.get(directory.name), known = prior ? this.#directories.get(prior) : undefined;
      if (known && known.identity.device === directory.identity.device && known.identity.inode === directory.identity.inode) continue;
      if (prior) this.#directories.delete(prior); const capability = token("d"); this.#directoryKeys.set(directory.name, capability); this.#directories.set(capability, directory);
    }
    const present = new Set(directories.map(d => d.name));
    for (const [name, capability] of this.#directoryKeys) if (!present.has(name)) { this.#directoryKeys.delete(name); this.#directories.delete(capability); }
  }
  directoryNameForCapability(value: string): string {
    return this.#directory(value).name;
  }
  #directory(value: JsonValue | undefined): RecordDirectory {
    const found = typeof value === "string" ? this.#directories.get(value) : undefined; if (!found) throw new EngineCommandError("CLOUDIG_READER_DIRECTORY_STALE", "Directory changed; refresh the list"); return found;
  }
  async #query(payload: JsonObject): Promise<JsonObject> {
    if (Object.hasOwn(payload, "snapshot")) { object(payload, ["snapshot", "offset", "limit"]); const p = page({ offset: payload["offset"]!, limit: payload["limit"]! }, RECORD_READER_LIMITS.queryPage); return this.#pages.read("archives", payload["snapshot"], p.offset, p.limit); }
    object(payload, ["offset", "limit"], ["search", "platforms", "directory", "directories", "sort", "time_field", "archived", "locations"]);
    const requested = page({ offset: payload["offset"]!, limit: payload["limit"]! }, RECORD_READER_LIMITS.queryPage);
    const search = payload["search"], platforms = payload["platforms"], directories = payload["directories"], directory = payload["directory"], sort = payload["sort"], time = payload["time_field"], archived = payload["archived"];
    const rawLocations = payload["locations"];
    if (rawLocations !== undefined && (!Array.isArray(rawLocations) || rawLocations.length > RECORD_ARCHIVE_LOCATIONS.length || new Set(rawLocations).size !== rawLocations.length || rawLocations.some(v => !RECORD_ARCHIVE_LOCATIONS.includes(v as RecordArchiveLocation)) || archived !== undefined)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid archive locations");
    const locations: readonly RecordArchiveLocation[] = Array.isArray(rawLocations) ? rawLocations as RecordArchiveLocation[] : [archived === true ? "archives" : "conversations"];
    if (search !== undefined && (typeof search !== "string" || [...search].length > RECORD_READER_LIMITS.searchCharacters)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid title search");
    if (platforms !== undefined && (!Array.isArray(platforms) || platforms.length > RECORD_READER_LIMITS.platformFilters || platforms.some(p => typeof p !== "string" || !p))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid platform filter");
    if (directories !== undefined && (!Array.isArray(directories) || directories.length > RECORD_READER_LIMITS.directoryFilters || directories.some(d => typeof d !== "string")) || directory !== undefined && (typeof directory !== "string" || directories !== undefined)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid directory filter");
    if (sort !== undefined && !["content_asc", "content_desc", "title"].includes(String(sort)) || time !== undefined && !RECORD_ARCHIVE_TIME_FIELDS.includes(time as typeof RECORD_ARCHIVE_TIME_FIELDS[number]) || archived !== undefined && typeof archived !== "boolean") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid archive sort or time field");
    const selected = (Array.isArray(directories) ? directories as string[] : typeof directory === "string" ? [directory] : []).map(d => this.directoryNameForCapability(d));
    return withRecordSnapshot(this.#root, async () => {
      const catalog = await readRecordCatalog(this.#root), context = await readRecordPresentationContext(this.#root, this.#builtins), facts = recordArchiveFacts(catalog, context), names = await listRecordDirectories(this.#root);
      const actualDirectories = []; for (const name of names) actualDirectories.push({ name, identity: await recordFileIdentity(this.#root, `Conversations/${name}`, "directory") });
      this.#refresh(facts, actualDirectories);
      let roots: ReadonlyMap<string, number> = new Map();
      const issues = catalog.issues.map(i => ({ path: i.path, message: i.error, ...(i.code ? { code: i.code } : {}) }));
      if (time === "content_start" || time === "content_end") try { roots = await recordTimeRootOrder(this.#root); } catch { issues.push({ path: "ContentTimes/order.json", message: "Time display order is unavailable; unknown roots use stable IDs" }); }
      const query: RecordArchiveQuery = { ...requested, ...(typeof search === "string" ? { search } : {}), ...(Array.isArray(platforms) ? { platforms: platforms as string[] } : {}), directories: selected,
        ...(sort !== undefined ? { sort: sort as NonNullable<RecordArchiveQuery["sort"]> } : {}), ...(time !== undefined ? { timeField: time as NonNullable<RecordArchiveQuery["timeField"]> } : {}), locations, roots };
      const result = queryRecordArchives(facts, { ...query, offset: 0, limit: facts.length }), active = facts.filter(f => f.path.startsWith("Conversations/")), archivedRows = facts.filter(f => f.path.startsWith("Archives/"));
      for (const f of facts) if (f.access !== "normal") issues.push({ path: f.path, message: "Conversation or Mark identity conflict; original records are preserved read-only" });
      return this.#pages.create("archives", result.rows.map(f => ({ capability: this.#archiveKeys.get(this.#key(f))!, ...recordArchiveRow(f) })), { degraded: false, total: result.total, catalog_total: (locations.includes("archives") ? archivedRows.length : 0) + (locations.includes("conversations") ? active.length : 0), stats: { bytes: active.reduce((n, f) => n + f.bytes, 0), files: active.length, directories: names.length, archived_bytes: archivedRows.reduce((n, f) => n + f.bytes, 0), archived_files: archivedRows.length },
        directories: names.map(name => ({ capability: this.#directoryKeys.get(name)!, name, count: active.filter(f => recordArchiveDirectory(f.path) === name || recordArchiveDirectory(f.path).startsWith(`${name}/`)).length })),
        issues }, requested.offset, requested.limit);
    });
  }
  #archive(value: JsonValue | undefined): ArchiveHandle {
    const found = typeof value === "string" ? this.#archives.get(value) : undefined;
    if (!found) throw new EngineCommandError("CLOUDIG_CAPABILITY_EXPIRED", "Reopen this conversation from the list");
    return found;
  }
  #markdownMessages(payload: JsonObject): JsonValue | undefined {
    if (payload["selection"] === undefined) return payload["messages"];
    if (payload["messages"] !== undefined) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Use message selection or direct messages, not both");
    const found = this.#markdownSelections.get(String(payload["selection"]));
    if (!found || found.archive !== payload["archive"]) throw new EngineCommandError("CLOUDIG_CAPABILITY_EXPIRED", "Message selection expired; select messages again");
    return [...found.ids];
  }
  async #search(payload: JsonObject, context: EngineCommandContext): Promise<JsonObject> {
    const requested = page({ offset: payload["offset"]!, limit: payload["limit"]! }, FULL_TEXT_LIMITS.page);
    if (Object.hasOwn(payload, "snapshot")) {
      object(payload, ["snapshot", "offset", "limit"]);
      return this.#searchPages.read("content", payload["snapshot"], requested.offset, requested.limit);
    }
    object(payload, ["query", "scope", "offset", "limit"], ["categories"]);
    const query = payload["query"], scope = object(payload["scope"], [], ["platforms", "directories", "locations"]), rawCategories = payload["categories"];
    if (typeof query !== "string" || !query.trim() || [...query].length > FULL_TEXT_LIMITS.queryCharacters) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Search text is empty or too long");
    if (rawCategories !== undefined && (!Array.isArray(rawCategories) || rawCategories.length > SEARCH_CATEGORIES.length || new Set(rawCategories).size !== rawCategories.length || rawCategories.some(v => !SEARCH_CATEGORIES.includes(v as SearchCategory)))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid search categories");
    const categories = Array.isArray(rawCategories) ? rawCategories as SearchCategory[] : DEFAULT_SEARCH_CATEGORIES;
    context.signal.throwIfAborted();
    const catalog = await this.#query({ ...scope, offset: 0, limit: RECORD_READER_LIMITS.queryPage, sort: "title" });
    const archives = [...catalog["items"] as JsonObject[]];
    for (let offset = RECORD_READER_LIMITS.queryPage; offset < Number(catalog["total"]); offset += RECORD_READER_LIMITS.queryPage) {
      archives.push(...this.#pages.read("archives", catalog["snapshot"], offset, RECORD_READER_LIMITS.queryPage)["items"] as JsonObject[]);
    }
    const hits: JsonObject[] = [], skipped: JsonObject[] = [], matchedArchives = new Set<string>(); let completed = 0, messages = 0, matchedMessages = 0, skippedFiles = 0, lastProgress = 0;
    const progress = async (force = false) => {
      const now = Date.now(); if (!force && now - lastProgress < FULL_TEXT_LIMITS.progressIntervalMs) return;
      lastProgress = now; await context.emit({ phase: "content-search", files: { completed, total: archives.length }, messages, matches: matchedMessages });
    };
    await progress(true);
    for (const row of categories.length ? archives : []) {
      context.signal.throwIfAborted();
      try {
        const handle = this.#archive(row["capability"]), actual = await withRecordSnapshot(this.#root, () => readStoredConversationMetadata(this.#root, handle.path, context.signal));
        if (actual.sha256 !== handle.conversationSha || actual.value["conversation_id"] !== handle.id) throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", "Conversation changed during search; search again");
        for (const hit of scanConversationMessages(actual.value, { query, categories, signal: context.signal })) {
          messages++;
          if (hit) {
            matchedMessages++; matchedArchives.add(String(row["capability"]));
            if (hits.length < FULL_TEXT_LIMITS.resultRows) hits.push({ archive: row["capability"]!, conversation_id: handle.id, title: row["title"]!, platform: row["platform"]!, filename: row["filename"]!, archived: row["archived"]!, message: hit.message, source_index: hit.index, categories: [...hit.categories], excerpt: hit.excerpt });
          }
          if (messages % FULL_TEXT_LIMITS.yieldEveryMessages === 0) { await yieldToEngine(undefined, { signal: context.signal }); await progress(); }
        }
      } catch (error) {
        context.signal.throwIfAborted();
        skippedFiles++;
        if (skipped.length < FULL_TEXT_LIMITS.issueDetails) skipped.push({ title: row["title"]!, filename: row["filename"]!, code: error instanceof EngineCommandError ? error.code : "CLOUDIG_SEARCH_FILE_UNAVAILABLE" });
      }
      completed++; await progress(); await yieldToEngine(undefined, { signal: context.signal });
    }
    context.signal.throwIfAborted(); await progress(true);
    return this.#searchPages.create("content", hits, { total: hits.length, matched_messages: matchedMessages, truncated: matchedMessages > hits.length, conversations: matchedArchives.size, scanned_files: completed, scanned_messages: messages, skipped_files: skippedFiles, skipped, query, categories: [...categories] }, requested.offset, requested.limit);
  }
  // Small validated headers suffice for list/info. Only opening the body reads messages/resources.
  async #inspect(handle: ArchiveHandle, acceptSavedMark = false) {
    const catalog = await readRecordCatalog(this.#root), context = await readRecordPresentationContext(this.#root, this.#builtins);
    const fact = recordArchiveFacts(catalog, context).find(f => f.path === handle.path && f.id === handle.id);
    if (!fact || fact.sha256 !== handle.conversationSha || !acceptSavedMark && fact.markSha !== handle.markSha) throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", "Conversation or Mark changed; reopen the editor");
    const mark = fact.mark ? catalog.marks.find(m => m.sha256 === fact.markSha && m.value["target"] === fact.id) : undefined;
    return { fact, context, issues: catalog.issues, mark };
  }
  async #header(handle: ArchiveHandle) { return withRecordSnapshot(this.#root, () => this.#inspect(handle)); }
  async resolveIdentityDraft(value: JsonValue): Promise<RecordIdentityNames> {
    const payload = object(value, ["archive", "expected_conversation", "expected_mark", "names"]), handle = this.#archive(payload["archive"]);
    if (payload["expected_conversation"] !== handle.conversationSha || payload["expected_mark"] !== handle.markSha) throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", "Conversation names changed; reopen the editor");
    const names = object(payload["names"], [], ["user", "assistant"]), current = await this.#header(handle);
    if (current.fact.access !== "normal") throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", "Conflicting records are read-only");
    return { ...handle, names: { user: identityName(names["user"]) ?? null, assistant: identityName(names["assistant"]) ?? null } };
  }
  async #read(handle: ArchiveHandle, signal?: AbortSignal): Promise<Reading> {
    return withRecordSnapshot(this.#root, async () => {
      signal?.throwIfAborted();
      const { fact, context, issues, mark } = await this.#inspect(handle), actual = await readStoredConversationMetadata(this.#root, fact.path, signal);
      if (actual.sha256 !== fact.sha256 || actual.value["conversation_id"] !== fact.id) throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", "Conversation changed; reopen it");
      return { conversation: actual.value, resourceBodies: actual.resourceBodies, ...(fact.mark ? { mark: fact.mark } : {}),
        resolved: resolveRecordPresentation({ conversation: actual.value, ...(fact.mark ? { mark: fact.mark } : {}), ...context }),
        evidence: { conversation: { path: fact.path, sha256: fact.sha256 }, mark: mark ? { path: mark.path, sha256: mark.sha256 } : null }, issues };
    });
  }
  async #projectInfo(value: JsonObject): Promise<JsonObject> {
    const result = structuredClone(value);
    for (const host of [result, result["effective"], result["draft"], result["user_state"]]) if (isJsonObject(host)) {
      const time = host["content_time"]; if (isJsonObject(time) && isJsonObject(time["range"])) time["range"] = await this.#projectTime(time["range"]);
    }
    return result;
  }
  async #info(handle: ArchiveHandle): Promise<JsonObject> {
    const { fact, context } = await this.#header(handle), source = fact.header["source"] as JsonObject, lifecycle = fact.header["lifecycle"] as JsonObject;
    const original = resolveRecordPresentation({ conversation: fact.header, ...context }), settings = markSettings(fact.mark);
    return this.#projectInfo({ revision: { conversation: fact.sha256, mark: fact.markSha }, archive: fact.id, conversation_id: fact.id, access: fact.access,
      effective: { conversation_name: fact.resolved.conversationName, models: [...fact.resolved.models], content_time: recordInfoTime(settings, context.language) }, draft: recordInfoDraft(settings),
      source: { platform: fact.resolved.platform, title: original.conversationName, models: [...original.models], filename: source["file"]!, ...(source["captured_at"] ? { captured_at: source["captured_at"]!, captured_from: source["captured_from"]! } : {}) },
      file: { filename: fact.path.split("/").at(-1)! }, facts: { cloudig_edited_at: fact.resolved.effectiveEditedAt, first_parsed_at: lifecycle["first_parsed_at"]!, last_parsed_at: lifecycle["last_parsed_at"]!, parser: fact.header["parser"]!, ...(fact.header["message_time"] ? { message_time: fact.header["message_time"]! } : {}) },
      anchor: { ...localRecordAnchor(new Date(this.#clock())) }, language: context.language });
  }
  async #draft(handle: ArchiveHandle, value: JsonValue | undefined) {
    const current = await this.#header(handle);
    if (current.fact.access !== "normal") throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", "Conflicting records are read-only");
    const draft = structuredClone(object(value, ["conversation_name", "models", "content_time"], ["names"])), time = draft["content_time"];
    if (isJsonObject(time) && isJsonObject(time["range"])) time["range"] = await this.#resolveTime(time["range"]);
    const before = markSettings(current.fact.mark); let settings: JsonObject;
    try { settings = applyRecordInfoDraft(before, draft, String(current.context.bindings["subject"]), this.#clock()); }
    catch (error) { throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", error instanceof Error ? error.message : "Invalid edit"); }
    return { current, before, settings, changed: !isDeepStrictEqual(before, settings), timeChanged: !isDeepStrictEqual(before["content_time"], settings["content_time"]) };
  }
  async #fileOperation<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) { if (error instanceof EngineCommandError || error instanceof Error && error.name === "AbortError") throw error; throw new EngineCommandError("CLOUDIG_ARCHIVE_WRITE_CONFLICT", error instanceof Error ? error.message : "File operation could not be completed"); }
  }
  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      "reader.archives.query": async payload => {
        return this.#query(payload);
      },
      "reader.search.query": async (payload, context) => this.#search(payload, context),
      "reader.search.open": async (payload, context) => {
        object(payload, ["archive", "message", "request"]);
        if (typeof payload["message"] !== "string" || !payload["message"]) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid search message");
        const reading = await this.#read(this.#archive(payload["archive"]), context.signal), requested = recordReaderViewRequest(payload["request"]);
        const location = locateConversationMessage(projectRecordForReading(reading.conversation, reading.resolved, reading.mark), payload["message"]);
        const rawSession: JsonObject = isJsonObject(payload["request"]) && isJsonObject(payload["request"]["session"]) ? structuredClone(payload["request"]["session"]) : { expanded: { reasoning: false, tools: false, references: false }, hidden: { reasoning: false, tools: false }, navigation: { user: true, assistant: true, process: false } };
        delete rawSession["branch_choices"]; rawSession["selected_leaf"] = location.selectedLeaf;
        rawSession["hidden"] = { reasoning: false, tools: false };
        const rawRequest = { ...(payload["request"] as JsonObject), session: rawSession, messages: { offset: location.visibleIndex, limit: requested.page.limit } };
        return { ...await this.#runtime.openRecord({ reading, page: recordReaderViewRequest(rawRequest), signal: context.signal }),
          session: rawSession, focus: { message: payload["message"], source_index: location.sourceIndex, path_index: location.pathIndex, visible_index: location.visibleIndex, anchor: location.anchor } };
      },
      "reader.archive.identity.query": async payload => {
        object(payload, ["archive"]); const { fact } = await this.#header(this.#archive(payload["archive"])), names = isJsonObject(fact.mark?.["names"]) ? fact.mark["names"] : {};
        return { revision: { conversation: fact.sha256, mark: fact.markSha }, archive: fact.id, title: fact.resolved.conversationName, platform: fact.resolved.platform,
          names: { user: names["user"] ?? null, assistant: names["assistant"] ?? null }, resolved: { user: fact.resolved.userName, assistant: fact.resolved.assistantName } };
      },
      "reader.archive.info.query": async payload => {
        object(payload, ["archive"]); return this.#info(this.#archive(payload["archive"]));
      },
      "reader.archive.info.preview": async payload => {
        object(payload, ["archive", "draft"], ["language"]); if (payload["language"] !== undefined && !["zh-CN", "en"].includes(String(payload["language"]))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid language");
        const value = await this.#draft(this.#archive(payload["archive"]), payload["draft"]);
        return this.#projectInfo({ changed: value.changed, can_touch: Object.keys(value.settings).length > 0, draft: recordInfoDraft(value.settings), content_time: recordInfoTime(value.settings, payload["language"] === "en" ? "en" : "zh-CN") });
      },
      "reader.archive.info.commit": async payload => {
        object(payload, ["archive", "expected_conversation", "expected_mark", "draft", "touch_on_noop"], ["refresh_anchor"]); const handle = this.#archive(payload["archive"]);
        if (typeof payload["touch_on_noop"] !== "boolean" || payload["refresh_anchor"] !== undefined && typeof payload["refresh_anchor"] !== "boolean") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Refresh choices must be boolean");
        if (payload["expected_conversation"] !== handle.conversationSha || payload["expected_mark"] !== handle.markSha) throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", "Conversation or Mark changed; reopen the editor");
        const value = await this.#draft(handle, payload["draft"]), timestamp = this.#clock(); let saved: JsonObject | undefined;
        try { saved = await saveConversationMark(this.#root, { conversationId: handle.id, expectedConversation: handle.conversationSha, expectedMark: handle.markSha, settings: value.settings, timestamp,
          forceEditedAt: payload["touch_on_noop"], ...((value.timeChanged || payload["touch_on_noop"] || payload["refresh_anchor"]) && value.settings["content_time"] ? { refreshAnchor: localRecordAnchor(new Date(timestamp)) } : {}) }); }
        catch (error) { if (error instanceof TypeError || error instanceof RecordStoreConflict) throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", error.message); throw error; }
        const fresh = await withRecordSnapshot(this.#root, () => this.#inspect(handle, true)); handle.markSha = fresh.fact.markSha;
        return this.#projectInfo({ status: isDeepStrictEqual(saved, value.current.fact.mark) ? "unchanged" : "updated", revision: { conversation: handle.conversationSha, mark: handle.markSha }, user_state: recordInfoDraft(markSettings(saved)), ...(saved ? { edited_at: saved["edited_at"]! } : {}) });
      },
      "reader.directory.create": async (payload, context) => {
        object(payload, ["name"]); if (typeof payload["name"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Directory name must be text");
        await this.#fileOperation(() => createRecordDirectory(this.#root, payload["name"] as string, context.signal)); return { status: "created" };
      },
      "reader.directory.rename": async (payload, context) => {
        object(payload, ["directory", "name"]); if (typeof payload["name"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Directory name must be text");
        const selected = this.#directory(payload["directory"]); return this.#fileOperation(async () => ({ ...await renameRecordDirectory(this.#root, selected, payload["name"] as string, this.#clock(), context.signal) }));
      },
      "reader.directory.delete": async (payload, context) => { object(payload, ["directory"]); const selected = this.#directory(payload["directory"]); return this.#fileOperation(async () => ({ ...await deleteEmptyRecordDirectory(this.#root, selected, this.#clock(), context.signal) })); },
      "reader.archive.move": async (payload, context) => {
        object(payload, ["archive"], ["directory"]); const selected = this.#archive(payload["archive"]);
        if (selected.path.startsWith("Archives/")) throw new EngineCommandError("CLOUDIG_ARCHIVE_ALREADY_ARCHIVED", "Restore before moving to a Conversation directory");
        const directory = payload["directory"] === undefined ? undefined : this.#directory(payload["directory"]);
        return this.#fileOperation(async () => ({ ...await moveRecordConversation(this.#root, selected, "Conversations", directory, context.signal) }));
      },
      "reader.archive.archive": async (payload, context) => {
        object(payload, ["archive"]); const selected = this.#archive(payload["archive"]);
        if (selected.path.startsWith("Archives/")) throw new EngineCommandError("CLOUDIG_ARCHIVE_ALREADY_ARCHIVED", "Already archived");
        return this.#fileOperation(async () => ({ ...await moveRecordConversation(this.#root, selected, "Archives", undefined, context.signal) }));
      },
      "reader.archive.restore": async (payload, context) => {
        object(payload, ["archive"], ["directory"]); const selected = this.#archive(payload["archive"]);
        if (!selected.path.startsWith("Archives/")) throw new EngineCommandError("CLOUDIG_ARCHIVE_NOT_ARCHIVED", "Only archived conversations can be restored");
        const directory = payload["directory"] === undefined ? undefined : this.#directory(payload["directory"]);
        return this.#fileOperation(async () => ({ ...await moveRecordConversation(this.#root, selected, "Conversations", directory, context.signal) }));
      },
      "reader.archive.exportMarkdown": async (payload, context) => {
        object(payload, ["archive"], ["selected_leaf", "branch_choices", "content_mode", "messages", "selection"]); const selected = this.#archive(payload["archive"]), leaf = payload["selected_leaf"], choices = payload["branch_choices"], mode = payload["content_mode"], messages = this.#markdownMessages(payload);
        if (leaf !== undefined && (typeof leaf !== "string" || !leaf) || choices !== undefined && (!isJsonObject(choices) || Object.entries(choices).some(([parent, child]) => !parent || typeof child !== "string" || !child))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid branch selection");
        if (mode !== undefined && mode !== "body" && mode !== "with_process" || messages !== undefined && (!Array.isArray(messages) || !messages.length || new Set(messages).size !== messages.length || messages.some(id => typeof id !== "string" || !id))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid Markdown content selection");
        let eventTail = Promise.resolve(), last = 0;
        try {
          const result = await exportRecordMarkdown(this.#root, { conversationId: selected.id, expectedConversation: selected.conversationSha, expectedMark: selected.markSha, builtins: this.#builtins,
            ...(typeof leaf === "string" ? { selectedLeaf: leaf } : {}), ...(isJsonObject(choices) ? { branchChoices: choices as Record<string, string> } : {}), signal: context.signal,
            ...(mode ? { contentMode: mode as ContentMode } : {}), ...(Array.isArray(messages) ? { messageIds: messages as string[] } : {}),
            onProgress: (completed, total) => { const now = Date.now(); if (completed !== 0 && completed !== total && now - last < RECORD_READER_LIMITS.exportProgressIntervalMs) return; last = now; eventTail = eventTail.then(() => context.emit({ phase: "export-scan", bytes: { completed, total } })); } });
          await eventTail;
          return { status: "exported", filename: result.filename, bytes: result.fingerprint.bytes, sha256: result.fingerprint.sha256, messages: result.messages, maintenanceWarnings: result.maintenanceWarnings, ...(result.selectedLeaf ? { selected_leaf: result.selectedLeaf } : {}) };
        } catch (error) { await eventTail; if (context.signal.aborted) throw context.signal.reason; if (error instanceof EngineCommandError) throw error; throw new EngineCommandError("CLOUDIG_EXPORT_FAILED", error instanceof Error ? error.message : "Markdown export failed"); }
      },
      "reader.archive.markdown.messages": async (payload, context) => {
        const requested = page({ offset: payload["offset"]!, limit: payload["limit"]! }, RECORD_READER_LIMITS.queryPage);
        if (payload["snapshot"] !== undefined) { object(payload, ["snapshot", "offset", "limit"]); return this.#pages.read("markdown", payload["snapshot"], requested.offset, requested.limit); }
        object(payload, ["archive", "offset", "limit"], ["selected_leaf", "branch_choices", "content_mode"]);
        const leaf = payload["selected_leaf"], choices = payload["branch_choices"], mode = payload["content_mode"] ?? "body";
        if (mode !== "body" && mode !== "with_process" || leaf !== undefined && typeof leaf !== "string" || choices !== undefined && (!isJsonObject(choices) || Object.values(choices).some(v => typeof v !== "string"))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid Markdown scope");
        const reading = await this.#read(this.#archive(payload["archive"]), context.signal), projected = projectRecordForReading(reading.conversation, reading.resolved, reading.mark), path = conversationMessagePath(projected, leaf as string | undefined, choices as Record<string, string> | undefined);
        const messages = projected["messages"] as JsonObject[];
        const items = path.path.flatMap(index => { const message = messages[index]!, blocks = selectedMessageBlocks(message, mode as ContentMode); return mode === "body" && !blocks.length ? [] : [{ id: message["id"]!, role: message["role"]!, summary: messageSelectionSummary({ ...message, content: blocks }, RECORD_READER_LIMITS.markdownSummaryCharacters), ...(message["timestamp"] ? { timestamp: message["timestamp"] } : {}) }]; });
        return this.#pages.create("markdown", items, { total: items.length }, requested.offset, requested.limit);
      },
      "reader.archive.markdown.select": async payload => {
        object(payload, ["archive", "messages"], ["selection"]); const archive = String(payload["archive"]), handle = this.#archive(payload["archive"]), messages = payload["messages"];
        if (!Array.isArray(messages) || !messages.length || messages.length > RECORD_READER_LIMITS.markdownSelectionChunk || messages.some(id => typeof id !== "string" || !id)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid message selection chunk");
        let key = typeof payload["selection"] === "string" ? payload["selection"] : undefined, selected = key ? this.#markdownSelections.get(key) : undefined;
        if (payload["selection"] !== undefined && (!selected || selected.archive !== archive)) throw new EngineCommandError("CLOUDIG_CAPABILITY_EXPIRED", "Message selection expired");
        const ids = new Set([...(selected?.ids ?? []), ...messages as string[]]);
        if (ids.size > handle.messageCount) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Selection exceeds this conversation");
        if (!key) { while (this.#markdownSelections.size >= RECORD_READER_LIMITS.retainedMarkdownSelections) this.#markdownSelections.delete(this.#markdownSelections.keys().next().value!); key = token("ms"); }
        this.#markdownSelections.set(key, { archive, ids }); return { selection: key, count: ids.size };
      },
      "reader.archive.markdown.releaseSelection": async payload => { object(payload, ["selection"]); return { released: this.#markdownSelections.delete(String(payload["selection"])) }; },
      // Native-only transfer: no large Markdown text or filesystem path crosses the Web bridge.
      "reader.archive.copyMarkdown.prepare": async (payload, context) => {
        object(payload, ["archive"], ["selected_leaf", "branch_choices", "content_mode", "messages", "include_header", "selection"]);
        const selected = this.#archive(payload["archive"]), leaf = payload["selected_leaf"], choices = payload["branch_choices"], mode = payload["content_mode"] ?? "body", messages = this.#markdownMessages(payload), header = payload["include_header"];
        if (leaf !== undefined && (typeof leaf !== "string" || !leaf) || choices !== undefined && (!isJsonObject(choices) || Object.entries(choices).some(([parent, child]) => !parent || typeof child !== "string" || !child)) || mode !== "body" && mode !== "with_process" || header !== undefined && typeof header !== "boolean" || messages !== undefined && (!Array.isArray(messages) || !messages.length || new Set(messages).size !== messages.length || messages.some(id => typeof id !== "string" || !id))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid Markdown selection");
        if (this.#markdownCopies.size + this.#pendingCopies >= RECORD_READER_LIMITS.pendingMarkdownCopies) throw new EngineCommandError("CLOUDIG_MARKDOWN_COPY_BUSY", "Wait for the current Markdown copy to finish");
        this.#pendingCopies++;
        try {
        let tail = Promise.resolve(), last = 0;
        const prepared = await prepareRecordMarkdown(this.#root, { conversationId: selected.id, expectedConversation: selected.conversationSha, expectedMark: selected.markSha, builtins: this.#builtins, signal: context.signal,
          contentMode: mode as ContentMode, ...(typeof leaf === "string" ? { selectedLeaf: leaf } : {}), ...(isJsonObject(choices) ? { branchChoices: choices as Record<string, string> } : {}), ...(Array.isArray(messages) ? { messageIds: messages as string[] } : {}), ...(header !== undefined ? { includeHeader: header as boolean } : {}),
          onProgress: (completed, total) => { const now = Date.now(); if (completed && completed !== total && now - last < RECORD_READER_LIMITS.exportProgressIntervalMs) return; last = now; tail = tail.then(() => context.emit({ phase: "markdown-copy", bytes: { completed, total } })); }
        });
        try { await tail; context.signal.throwIfAborted(); } catch (error) { await prepared.close(); throw error; }
        const copy = token("md"); this.#markdownCopies.set(copy, prepared);
        return { copy, file: prepared.file, bytes: prepared.fingerprint.bytes, sha256: prepared.fingerprint.sha256, messages: prepared.messages };
        } finally { this.#pendingCopies--; }
      },
      "reader.archive.copyMarkdown.release": async payload => {
        object(payload, ["copy"]); const key = String(payload["copy"]), prepared = this.#markdownCopies.get(key);
        if (!prepared) return { released: false };
        await prepared.close(); this.#markdownCopies.delete(key); return { released: true };
      },
      // Native-only commands: BridgePolicy does not expose these to page JavaScript.
      "reader.archive.recycle.plan": async (payload, context) => {
        object(payload, ["archive"]); context.signal.throwIfAborted(); const selected = this.#archive(payload["archive"]);
        return this.#fileOperation(async () => ({ ...await this.#recycle.prepare(selected, this.#clock(), context.signal) }));
      },
      "reader.archive.recycle.complete": async payload => { object(payload, ["plan"]); if (typeof payload["plan"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid recycle plan"); return this.#fileOperation(async () => ({ ...await this.#recycle.finish(payload["plan"] as string, true) })); },
      "reader.archive.recycle.begin": async (payload, context) => { object(payload, ["plan"]); if (typeof payload["plan"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid recycle plan"); return this.#fileOperation(async () => ({ ...await this.#recycle.begin(payload["plan"] as string, context.signal) })); },
      "reader.archive.recycle.release": async payload => { object(payload, ["plan"]); if (typeof payload["plan"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid recycle plan"); return this.#fileOperation(async () => ({ ...await this.#recycle.finish(payload["plan"] as string, false) })); },
      "reader.archive.recycle.pending": async payload => { object(payload, []); return { ...await pendingRecordRecycles(this.#root) }; },
      "reader.archive.recycle.resume": async (payload, context) => { object(payload, ["operation"]); if (typeof payload["operation"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid recycle operation"); context.signal.throwIfAborted(); return this.#fileOperation(async () => ({ ...await this.#recycle.resume(payload["operation"] as string, context.signal) })); },
      "reader.archive.recycle.keepRemaining": async payload => { object(payload, ["operation"]); if (typeof payload["operation"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid recycle operation"); return this.#fileOperation(async () => ({ ...await this.#recycle.keepRemaining(payload["operation"] as string) })); },
      "reader.example.open": async (payload, context) => {
        object(payload, ["example", "language", "request"]);
        if (!this.#examples || !['zh-CN', 'en'].includes(String(payload['language']))) throw new EngineCommandError('CLOUDIG_EXAMPLE_UNAVAILABLE', 'Public examples are unavailable');
        const reading = await this.#examples.reading(payload['example'], payload['language'] as 'zh-CN' | 'en', context.signal);
        return { ...await this.#runtime.openRecord({ reading, sourceRoot: this.#examples.root, page: recordReaderViewRequest(payload['request']), signal: context.signal }) };
      },
      // Native-only lookup; not exposed through BridgePolicy. The desktop explicitly selects Chrome.
      "reader.example.original": async (payload, context) => {
        object(payload, ['example']);
        if (!this.#examples) throw new EngineCommandError('CLOUDIG_EXAMPLE_UNAVAILABLE', 'Public examples are unavailable');
        return this.#examples.original(payload['example'], context.signal);
      },
      "reader.view.open": async (payload, context) => {
        object(payload, ["archive", "request"]); const reading = await this.#read(this.#archive(payload["archive"]));
        return { ...await this.#runtime.openRecord({ reading, page: recordReaderViewRequest(payload["request"]), signal: context.signal }) };
      },
      "reader.position.query": async (payload) => {
        object(payload, ["archive"]);
        const selected = this.#archive(payload["archive"]);
        const position = await readReaderPosition(this.#root, selected.id, selected.conversationSha, this.#clock());
        return { position: position ? structuredClone(position) : null };
      },
      "reader.position.save": async (payload) => {
        const raw = object(payload, ["archive", "message_id"], ["selected_leaf", "branch_choices"]);
        const selected = this.#archive(raw["archive"]);
        const messageId = raw["message_id"];
        const selectedLeaf = raw["selected_leaf"];
        const choices = raw["branch_choices"];
        if (typeof messageId !== "string" || !messageId || messageId.length > 512
          || selectedLeaf !== undefined && (typeof selectedLeaf !== "string" || !selectedLeaf || selectedLeaf.length > 512)
          || choices !== undefined && (!isJsonObject(choices) || Object.entries(choices).some(([parent, child]) => !parent || parent.length > 512 || typeof child !== "string" || !child || child.length > 512))) {
          throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid reader position");
        }
        await saveReaderPosition(this.#root, selected.id, {
          source_sha256: selected.conversationSha,
          message_id: messageId,
          ...(typeof selectedLeaf === "string" ? { selected_leaf: selectedLeaf } : {}),
          ...(isJsonObject(choices) ? { branch_choices: choices as Record<string, string> } : {}),
          updated_at: this.#clock()
        }, this.#clock());
        return { saved: true };
      },
      "reader.view.page": async payload => {
        object(payload, ["view", "request"]); if (typeof payload["view"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid reading view");
        return { ...await this.#runtime.page(payload["view"], recordReaderViewRequest(payload["request"])) };
      },
      "reader.resource.materialize": async (payload, context) => { object(payload, ["view", "resource"]); if (typeof payload["view"] !== "string" || typeof payload["resource"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid resource request"); return { ...await this.#runtime.materializeResource({ token: payload["view"], resource: payload["resource"], signal: context.signal }) }; },
      "reader.identity.resolve": async (payload, context) => { object(payload, ["view", "identity"]); if (typeof payload["view"] !== "string" || typeof payload["identity"] !== "string") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid identity request"); return { ...await this.#runtime.resolveIdentity({ token: payload["view"], identity: payload["identity"], signal: context.signal }) }; },
      "reader.view.close": async payload => { object(payload, ["view"]); return { status: await this.#runtime.close(String(payload["view"])) }; }
    };
  }
  async close(): Promise<void> { this.#pages.clear(); this.#searchPages.clear(); this.#markdownSelections.clear(); this.#archives.clear(); this.#archiveKeys.clear(); this.#directories.clear(); this.#directoryKeys.clear(); for (const prepared of this.#markdownCopies.values()) await prepared.close(); this.#markdownCopies.clear(); await this.#recycle.close(); await this.#runtime.closeAll(); }
}
