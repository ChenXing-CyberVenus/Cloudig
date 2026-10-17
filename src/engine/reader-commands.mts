import { randomBytes } from "node:crypto";
import { pruneMissingSystemLogGroups } from "../adapters/library-data/system-log.mts";

import {
  applyArchiveUserPatch,
  archivePatchUsesAnchor,
  archiveConversation,
  commitArchiveUserState,
  createArchiveDirectory,
  deleteEmptyArchiveDirectory,
  exportConversationMarkdown,
  listArchiveDirectories,
  listArchiveRows,
  moveArchiveFile,
  parseEditableConversationPath,
  planRecycleConversation,
  queryArchiveUserContext,
  recycledConversationIsMissing,
  refreshCatalogAfterArchiveMove,
  refreshCatalogAfterArchiveRemoval,
  refreshCatalogAfterDirectoryRename,
  renameArchiveDirectory,
  restoreConversation
} from "../adapters/library-data/index.mts";
import { RuntimeConversationViews, type RuntimeConversationViewsOptions } from "../adapters/runtime/index.mts";
import { readCurrentAuthorityPair } from "../adapters/storage/recovery-point.mts";
import {
  queryReaderArchives,
  readerArchiveDirectory,
  readerArchiveRow,
  type ConversationPageRequest,
  type ConversationViewPageInput,
  type ReaderArchiveFact,
  type ReaderArchiveQuery,
  type ReaderSessionPreferences
} from "../app/reader/index.mts";
import resourceLimits from "../core/contracts/machine/resource-limits.json" with { type: "json" };
import { normalizeRange, orderedTimeVariants } from "../core/time/index.mts";
import { validateTimeValue } from "../core/contracts/index.mts";
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { archiveUserValuesEqual, resolveUserContentTime } from "../core/library/overlay.mts";
import { formatRange, rangeDirection } from "../core/time/index.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";
import { engineTransactionId } from "./transaction.mts";

const ARCHIVE_CAPABILITY = /^a_[A-Za-z0-9_-]{43}$/u;
const DIRECTORY_CAPABILITY = /^d_[A-Za-z0-9_-]{43}$/u;
const VIEW_CAPABILITY = /^v_[A-Za-z0-9_-]{43}$/u;
const RESOURCE_ID = /^r[1-9][0-9]*$/u;
const IDENTITY_CAPABILITY = /^i_[A-Za-z0-9_-]{43}$/u;
const RECYCLE_CAPABILITY = /^z_[A-Za-z0-9_-]{43}$/u;

type ArchiveCapability = Readonly<{
  fact: ReaderArchiveFact;
}>;

type DirectoryCapability = Readonly<{
  name: string;
  count: number;
}>;

type RecycleCapability = Readonly<{
  fact: ReaderArchiveFact;
  path: string;
  bytes: number;
  sha256: string;
}>;

export type ReaderEngineCommandsOptions = RuntimeConversationViewsOptions & Readonly<{
  archiveToken?: () => string;
  directoryToken?: () => string;
  recycleToken?: () => string;
  transaction?: () => string;
  clock?: () => string;
  anchor?: () => Readonly<{ date: string; offset: string }>;
  projectTimeRange?: (range: JsonObject) => Promise<JsonObject>;
  resolveTimeRange?: (range: JsonObject) => Promise<JsonObject>;
}>;

function fail(message: string): never {
  throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", message);
}

function exactObject(
  value: JsonValue | undefined,
  required: readonly string[],
  optional: readonly string[] = []
): JsonObject {
  if (!isJsonObject(value)) fail("Command payload object is invalid");
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail("Command payload fields are invalid");
  }
  return value;
}

function object(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  return value;
}

function page(value: JsonValue | undefined, label: string): ConversationPageRequest {
  const object = exactObject(value, ["offset", "limit"]);
  return { offset: integer(object["offset"], `${label} offset`), limit: integer(object["limit"], `${label} limit`) };
}

function booleans(value: JsonValue | undefined, fields: readonly string[], label: string): Record<string, boolean> {
  const object = exactObject(value, fields);
  const result: Record<string, boolean> = {};
  for (const field of fields) {
    if (typeof object[field] !== "boolean") fail(`${label} must contain booleans only`);
    result[field] = object[field] as boolean;
  }
  return result;
}

function branchChoices(value: JsonValue | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value) || Object.keys(value).length > 5000) fail("Branch choices must be a bounded object");
  const entries = Object.entries(value);
  for (const [parent, child] of entries) {
    if (!/^m[1-9]\d*$/u.test(parent) || typeof child !== "string" || !/^m[1-9]\d*$/u.test(child)) fail("Branch choice is invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function session(value: JsonValue | undefined): ReaderSessionPreferences {
  const object = exactObject(value, ["expanded", "hidden", "navigation"], ["selected_leaf", "branch_choices"]);
  const expanded = booleans(object["expanded"], ["reasoning", "tools", "references"], "Expanded state");
  const hidden = booleans(object["hidden"], ["reasoning", "tools"], "Hidden state");
  const navigation = booleans(object["navigation"], ["user", "assistant", "process"], "Navigation state");
  const selectedLeaf = object["selected_leaf"];
  if (selectedLeaf !== undefined && (typeof selectedLeaf !== "string" || selectedLeaf.length < 1 || selectedLeaf.length > 256)) {
    fail("Selected branch leaf is invalid");
  }
  return {
    ...(typeof selectedLeaf === "string" ? { selectedLeaf } : {}),
    ...(object["branch_choices"] !== undefined ? { branchChoices: branchChoices(object["branch_choices"])! } : {}),
    expanded: {
      reasoning: expanded["reasoning"]!,
      tools: expanded["tools"]!,
      references: expanded["references"]!
    },
    hidden: { reasoning: hidden["reasoning"]!, tools: hidden["tools"]! },
    navigation: {
      user: navigation["user"]!,
      assistant: navigation["assistant"]!,
      process: navigation["process"]!
    }
  };
}

function viewRequest(value: JsonValue | undefined): ConversationViewPageInput {
  const object = exactObject(value, ["messages", "navigation", "branches"], ["session", "summary_characters"]);
  const summary = object["summary_characters"];
  if (summary !== undefined && (typeof summary !== "number" || !Number.isSafeInteger(summary))) fail("Navigation summary bound is invalid");
  return {
    page: page(object["messages"], "Message page"),
    navigationPage: page(object["navigation"], "Navigation page"),
    branchPage: page(object["branches"], "Branch page"),
    ...(object["session"] === undefined ? {} : { session: session(object["session"]) }),
    ...(typeof summary === "number" ? { navigationSummaryCharacters: summary } : {})
  };
}

function archiveQuery(value: JsonObject): ReaderArchiveQuery {
  exactObject(value, ["offset", "limit"], ["search", "platforms", "directory", "directories", "sort", "time_field", "archived"]);
  const offset = integer(value["offset"], "Archive query offset");
  const limit = integer(value["limit"], "Archive query limit");
  if (limit < 1 || limit > resourceLimits.reader_message_page_max) fail("Archive query limit is outside the configured bound");
  const search = value["search"];
  if (search !== undefined && typeof search !== "string") fail("Archive search must be text");
  const platforms = value["platforms"];
  if (platforms !== undefined && (!Array.isArray(platforms) || platforms.some((entry) => typeof entry !== "string"))) fail("Archive platforms must be a text array");
  const directory = value["directory"];
  if (directory !== undefined && (typeof directory !== "string" || !DIRECTORY_CAPABILITY.test(directory))) fail("Archive directory capability is invalid");
  const directories = value["directories"];
  if (directories !== undefined && (!Array.isArray(directories) || directories.length > 64 || directories.some((entry) => typeof entry !== "string" || !DIRECTORY_CAPABILITY.test(entry)))) {
    fail("Archive directory capabilities are invalid");
  }
  if (directory !== undefined && directories !== undefined) fail("Archive directory filters are mutually exclusive");
  const sort = value["sort"];
  if (sort !== undefined && !["content_asc", "content_desc", "title"].includes(String(sort))) fail("Archive sort is invalid");
  const timeField = value["time_field"];
  if (timeField !== undefined && !["json_modified", "cloudig_edited", "json_created", "source_captured", "message_start", "message_end", "content_start", "content_end"].includes(String(timeField))) fail("Archive time field is invalid");
  const archived = value["archived"];
  if (archived !== undefined && typeof archived !== "boolean") fail("Archive status filter is invalid");
  return {
    offset,
    limit,
    ...(typeof search === "string" ? { search } : {}),
    ...(Array.isArray(platforms) ? { platforms: platforms as string[] } : {}),
    ...(sort === "content_asc" || sort === "content_desc" || sort === "title" ? { sort } : {}),
    ...(typeof timeField === "string" ? { timeField: timeField as NonNullable<ReaderArchiveQuery["timeField"]> } : {}),
    ...(typeof archived === "boolean" ? { archived } : {})
  };
}

function timeSortFacts(time: JsonObject): Readonly<{
  variantOrder: Readonly<Record<string, number>>;
  nodeEditedAt: Readonly<Record<string, string>>;
}> {
  const variantOrder: Record<string, number> = {};
  for (const [index, value] of orderedTimeVariants(time).entries()) variantOrder[value] = index;
  const nodeEditedAt: Record<string, string> = {};
  for (const section of ["variants", "times"] as const) {
    const values = time[section];
    if (!isJsonObject(values)) continue;
    for (const [id, raw] of Object.entries(values)) {
      if (isJsonObject(raw) && typeof raw["edited_at"] === "string") nodeEditedAt[id] = raw["edited_at"];
    }
  }
  return { variantOrder, nodeEditedAt };
}

function localAnchor(): Readonly<{ date: string; offset: string }> {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const minutes = -now.getTimezoneOffset();
  if (minutes === 0) return { date, offset: "Z" };
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return { date, offset: `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}` };
}

function archiveUserPatch(value: JsonValue | undefined): import("../adapters/library-data/index.mts").ArchiveUserPatch {
  const draft = exactObject(value, ["conversation_name", "models", "content_time"]);
  const conversationName = exactObject(draft["conversation_name"], ["state"], ["value"]);
  if (conversationName["state"] !== "inherit" && conversationName["state"] !== "set") fail("Conversation-name state is invalid");
  if (conversationName["state"] === "inherit" && conversationName["value"] !== undefined) fail("Inherited conversation name cannot carry a value");
  if (conversationName["state"] === "set" && (typeof conversationName["value"] !== "string" || conversationName["value"].length < 1 || conversationName["value"].length > 4096)) {
    fail("Conversation name is invalid");
  }
  const models = exactObject(draft["models"], ["state"], ["values"]);
  if (models["state"] !== "inherit" && models["state"] !== "set") fail("Model state is invalid");
  if (models["state"] === "inherit" && models["values"] !== undefined) fail("Inherited models cannot carry values");
  if (models["state"] === "set") {
    if (!Array.isArray(models["values"]) || models["values"].length > 128 || models["values"].some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 1024)) {
      fail("Model values are invalid");
    }
    if (new Set(models["values"]).size !== models["values"].length) fail("Model values must be unique");
  }
  const contentTime = exactObject(draft["content_time"], ["state"], ["range"]);
  if (!['inherit', 'cleared', 'set'].includes(String(contentTime["state"]))) fail("Content-time state is invalid");
  if (contentTime["state"] === "set" && !isJsonObject(contentTime["range"])) fail("Set content time requires a range");
  if (contentTime["state"] !== "set" && contentTime["range"] !== undefined) fail("Only set content time can carry a range");
  return {
    conversationName: conversationName["state"] === "set"
      ? { state: "set", value: conversationName["value"] as string }
      : { state: "inherit" },
    models: models["state"] === "set"
      ? { state: "set", values: models["values"] as string[] }
      : { state: "inherit" },
    contentTime: contentTime["state"] === "set"
      ? { state: "set", range: contentTime["range"] as JsonObject }
      : contentTime["state"] === "cleared"
        ? { state: "cleared" }
        : { state: "inherit" }
  };
}

function archiveUserDraft(value: JsonObject): JsonObject {
  return {
    conversation_name: typeof value["conversation_name"] === "string"
      ? { state: "set", value: value["conversation_name"] }
      : { state: "inherit" },
    models: Array.isArray(value["models"])
      ? { state: "set", values: structuredClone(value["models"]!) }
      : { state: "inherit" },
    content_time: isJsonObject(value["content_time"])
      ? structuredClone(value["content_time"]!)
      : { state: "inherit" }
  };
}

function archiveIdentityNames(value: JsonValue | undefined): NonNullable<import("../adapters/library-data/index.mts").ArchiveUserPatch["names"]> {
  const names = exactObject(value, ["user", "assistant"]);
  const party = (raw: JsonValue | undefined, label: string) => {
    if (raw === null) return { state: "inherit" } as const;
    if (typeof raw !== "string" || raw.length < 1 || raw.length > 1024) fail(`${label} name is invalid`);
    return { state: "set", value: raw } as const;
  };
  return { user: party(names["user"], "User"), assistant: party(names["assistant"], "Assistant") };
}

function contentTimeResult(
  values: JsonObject,
  language: "zh-CN" | "en"
): JsonObject {
  const time = resolveUserContentTime(values);
  if (!isJsonObject(time.range)) return { state: time.state };
  const range = time.range;
  return {
    state: "set",
    range: structuredClone(range),
    summary: formatRange(range, language),
    direction: rangeDirection(range)
  };
}

function factKey(value: ReaderArchiveFact): string {
  return `${value.path}\0${value.bytes}\0${value.sha256}\0${value.archive}\0${value.generation}`;
}

export class ReaderEngineCommands {
  readonly #libraryRoot: string;
  readonly #builtins: ReaderEngineCommandsOptions["builtins"];
  #availableAssets: ReaderEngineCommandsOptions["availableAssets"];
  readonly #runtime: RuntimeConversationViews;
  readonly #archiveToken: () => string;
  readonly #directoryToken: () => string;
  readonly #recycleToken: () => string;
  readonly #transaction: () => string;
  readonly #clock: () => string;
  readonly #anchor: () => Readonly<{ date: string; offset: string }>;
  readonly #projectTimeRange: (range: JsonObject) => Promise<JsonObject>;
  readonly #resolveTimeRange: (range: JsonObject) => Promise<JsonObject>;
  #archives = new Map<string, ArchiveCapability>();
  #archiveKeys = new Map<string, string>();
  #directories = new Map<string, DirectoryCapability>();
  #directoryKeys = new Map<string, string>();
  #recyclePlans = new Map<string, RecycleCapability>();

  constructor(options: ReaderEngineCommandsOptions) {
    this.#libraryRoot = options.libraryRoot;
    this.#builtins = options.builtins;
    this.#availableAssets = options.availableAssets;
    this.#runtime = new RuntimeConversationViews(options);
    this.#archiveToken = options.archiveToken ?? (() => `a_${randomBytes(32).toString("base64url")}`);
    this.#directoryToken = options.directoryToken ?? (() => `d_${randomBytes(32).toString("base64url")}`);
    this.#recycleToken = options.recycleToken ?? (() => `z_${randomBytes(32).toString("base64url")}`);
    this.#transaction = options.transaction ?? engineTransactionId;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#anchor = options.anchor ?? localAnchor;
    this.#projectTimeRange = options.projectTimeRange ?? (async (range) => structuredClone(range));
    this.#resolveTimeRange = options.resolveTimeRange ?? (async (range) => structuredClone(range));
  }

  setAvailableIdentityAssets(values: ReadonlySet<string>): void {
    this.#availableAssets = values;
  }

  #refreshCapabilities(values: readonly ReaderArchiveFact[], directoryNames: readonly string[]): void {
    const nextArchives = new Map<string, ArchiveCapability>();
    const nextKeys = new Map<string, string>();
    for (const fact of values) {
      const key = factKey(fact);
      let capability = this.#archiveKeys.get(key);
      if (!capability) {
        capability = this.#archiveToken();
        if (!ARCHIVE_CAPABILITY.test(capability)) throw new TypeError("Archive token factory returned an invalid capability");
      }
      nextKeys.set(key, capability);
      nextArchives.set(capability, { fact });
    }
    this.#archiveKeys = nextKeys;
    this.#archives = nextArchives;

    const directoryCounts = new Map<string, number>();
    for (const name of directoryNames) directoryCounts.set(name, 0);
    for (const fact of values) {
      if (fact.archived) continue;
      const name = readerArchiveDirectory(fact);
      if (name) directoryCounts.set(name, (directoryCounts.get(name) ?? 0) + 1);
    }
    const nextDirectoryKeys = new Map<string, string>();
    const nextDirectories = new Map<string, DirectoryCapability>();
    for (const [name, count] of [...directoryCounts].sort(([left], [right]) => left.localeCompare(right, "en"))) {
      let capability = this.#directoryKeys.get(name);
      if (!capability) {
        capability = this.#directoryToken();
        if (!DIRECTORY_CAPABILITY.test(capability)) throw new TypeError("Directory token factory returned an invalid capability");
      }
      nextDirectoryKeys.set(name, capability);
      nextDirectories.set(capability, { name, count });
    }
    this.#directoryKeys = nextDirectoryKeys;
    this.#directories = nextDirectories;
  }

  async #query(payload: JsonObject): Promise<JsonObject> {
    const query = archiveQuery(payload);
    // Resolve an existing selection before replacing capabilities with current
    // filesystem facts. An externally removed directory is no longer a filter.
    const selectedDirectory = payload["directory"] === undefined ? undefined : this.#directory(payload["directory"]).name;
    const selectedDirectories = Array.isArray(payload["directories"])
      ? payload["directories"].map((value) => this.#directory(value).name)
      : undefined;
    const [listed, authority, directoryNames] = await Promise.all([
      listArchiveRows(this.#libraryRoot, { builtins: this.#builtins, availableAssets: this.#availableAssets }),
      readCurrentAuthorityPair(this.#libraryRoot),
      listArchiveDirectories(this.#libraryRoot)
    ]);
    if (listed.degraded) {
      this.#archives.clear();
      this.#archiveKeys.clear();
      this.#directories.clear();
      this.#directoryKeys.clear();
      return { degraded: true, offset: query.offset, limit: query.limit, total: 0, catalog_total: 0, directories: [], items: [] };
    }
    const facts = listed.rows as readonly ReaderArchiveFact[];
    this.#refreshCapabilities(facts, directoryNames);
    const time = timeSortFacts(authority.time);
    const directory = selectedDirectory && directoryNames.includes(selectedDirectory) ? selectedDirectory : undefined;
    const directories = selectedDirectories?.filter(name => directoryNames.includes(name));
    const archived = query.archived ?? false;
    const result = queryReaderArchives(facts, {
      ...query,
      ...time,
      archived,
      ...(directories && directories.length > 0 ? { directories } : directory ? { directory } : {})
    });
    const activeFacts = facts.filter((fact) => !fact.archived);
    const archivedFacts = facts.filter((fact) => fact.archived);
    return {
      degraded: false,
      offset: query.offset,
      limit: query.limit,
      total: result.total,
      catalog_total: facts.filter((fact) => fact.archived === archived).length,
      stats: {
        bytes: activeFacts.reduce((sum, fact) => sum + fact.bytes, 0),
        files: activeFacts.length,
        directories: this.#directories.size,
        archived_bytes: archivedFacts.reduce((sum, fact) => sum + fact.bytes, 0),
        archived_files: archivedFacts.length
      },
      directories: [...this.#directories.entries()].map(([capability, value]) => ({ capability, name: value.name, count: value.count })),
      items: result.rows.map((fact) => ({
        capability: this.#archiveKeys.get(factKey(fact))!,
        ...readerArchiveRow(fact)
      }))
    };
  }

  #archive(value: JsonValue | undefined): ArchiveCapability {
    if (typeof value !== "string" || !ARCHIVE_CAPABILITY.test(value)) fail("Archive capability is invalid");
    const capability = this.#archives.get(value);
    if (!capability) throw new EngineCommandError("CLOUDIG_ARCHIVE_CAPABILITY_STALE", "Archive selection is stale; refresh the list");
    return capability;
  }

  #directory(value: JsonValue | undefined): DirectoryCapability {
    if (typeof value !== "string" || !DIRECTORY_CAPABILITY.test(value)) fail("Archive directory capability is invalid");
    const capability = this.#directories.get(value);
    if (!capability) throw new EngineCommandError("CLOUDIG_DIRECTORY_CAPABILITY_STALE", "Directory selection is stale; refresh the list");
    return capability;
  }

  directoryNameForCapability(value: string): string {
    return this.#directory(value).name;
  }

  identityArchiveDraft(value: JsonValue): import("../adapters/library-data/index.mts").IdentityArchiveDraft {
    const payload = exactObject(value, ["archive", "expected_revision", "names"]);
    const selected = this.#writableArchive(payload["archive"]);
    const expectedArchiveRevision = integer(payload["expected_revision"], "Expected archive revision");
    const names = archiveIdentityNames(payload["names"]);
    return {
      relativePath: selected.fact.path,
      expected: { archive: selected.fact.archive, generation: selected.fact.generation, bytes: selected.fact.bytes, sha256: selected.fact.sha256 },
      expectedArchiveRevision,
      names: {
        ...(names.user?.state === "set" ? { user: names.user.value } : {}),
        ...(names.assistant?.state === "set" ? { assistant: names.assistant.value } : {})
      }
    };
  }

  #writableArchive(value: JsonValue | undefined): ArchiveCapability {
    const capability = this.#archive(value);
    if (capability.fact.access !== "normal") {
      throw new EngineCommandError("CLOUDIG_ARCHIVE_READ_ONLY_CONFLICT", "This archive has a conflicting local identity and is read-only");
    }
    return capability;
  }

  #recycle(value: JsonValue | undefined): RecycleCapability {
    if (typeof value !== "string" || !RECYCLE_CAPABILITY.test(value)) fail("Recycle capability is invalid");
    const capability = this.#recyclePlans.get(value);
    if (!capability) throw new EngineCommandError("CLOUDIG_RECYCLE_CAPABILITY_STALE", "Recycle confirmation is stale; choose the archive again");
    return capability;
  }

  async #revokeArchiveState(): Promise<void> {
    this.#archives.clear();
    this.#archiveKeys.clear();
    this.#directories.clear();
    this.#directoryKeys.clear();
    this.#recyclePlans.clear();
  }

  #revokeArchiveFact(fact: ReaderArchiveFact): void {
    // A row mutation must not revoke the remaining rows in an already confirmed
    // batch. Their own fingerprint checks still run before each operation.
    const key = factKey(fact);
    const capability = this.#archiveKeys.get(key);
    if (capability) this.#archives.delete(capability);
    this.#archiveKeys.delete(key);
    for (const [token, plan] of this.#recyclePlans) {
      if (factKey(plan.fact) === key) this.#recyclePlans.delete(token);
    }
  }

  async #archiveInfo(selected: ArchiveCapability): Promise<Readonly<{
    context: Awaited<ReturnType<typeof queryArchiveUserContext>>;
    response: JsonObject;
  }>> {
    const context = await queryArchiveUserContext({
      libraryRoot: this.#libraryRoot,
      relativePath: selected.fact.path,
      expected: {
        archive: selected.fact.archive,
        generation: selected.fact.generation,
        bytes: selected.fact.bytes,
        sha256: selected.fact.sha256
      },
      builtins: this.#builtins,
      availableAssets: this.#availableAssets
    });
    const conversation = context.conversation;
    const source = isJsonObject(conversation["source"]) ? conversation["source"] : {};
    const lifecycle = isJsonObject(conversation["lifecycle"]) ? conversation["lifecycle"] : {};
    const parser = isJsonObject(conversation["parser"]) ? conversation["parser"] : {};
    const adapter = isJsonObject(parser["adapter"]) ? parser["adapter"] : {};
    const messageTime = isJsonObject(conversation["message_time"]) ? conversation["message_time"] : undefined;
    return {
      context,
      response: {
        revision: { library: context.libraryRevision, archive: context.archiveRevision },
        archive: context.view.archive,
        generation: selected.fact.generation,
        effective: {
          conversation_name: context.view.conversationName ?? context.filename.replace(/\.json$/iu, ""),
          models: [...context.view.models],
          content_time: contentTimeResult(context.userValues, "zh-CN")
        },
        draft: archiveUserDraft(context.userValues),
        source: {
          provider: conversation["provider"]!,
          platform: conversation["platform"]!,
          ...(typeof conversation["title"] === "string" ? { title: conversation["title"] } : {}),
          models: Array.isArray(conversation["models"]) ? structuredClone(conversation["models"]!) : [],
          content_time: { basis: "unavailable" },
          filename: source["file"]!,
          ...(isJsonObject(source["captured_at"]) ? { captured_at: structuredClone(source["captured_at"]!) } : {})
        },
        file: { filename: context.filename },
        facts: {
          cloudig_edited_at: context.view.effectiveEditedAt ?? lifecycle["cloudig_edited_at"]!,
          first_parsed_at: structuredClone(lifecycle["first_parsed_at"]!),
          last_parsed_at: lifecycle["last_parsed_at"]!,
          ...(messageTime ? { message_time: structuredClone(messageTime) } : {}),
          parser: {
            version: parser["version"]!,
            adapter: { id: adapter["id"]!, version: adapter["version"]! }
          }
        },
        anchor: this.#anchor()
      }
    };
  }

  async #projectArchiveInfoResponse(value: JsonObject): Promise<JsonObject> {
    const response = structuredClone(value);
    const ranges: Array<{ parent: JsonObject; key: string }> = [];
    const effective = object(response["effective"]);
    const effectiveTime = object(effective["content_time"]);
    if (isJsonObject(effectiveTime["range"])) ranges.push({ parent: effectiveTime, key: "range" });
    const draft = object(response["draft"]);
    const draftTime = object(draft["content_time"]);
    if (draftTime["state"] === "set" && isJsonObject(draftTime["range"])) ranges.push({ parent: draftTime, key: "range" });
    const previewTime = object(response["content_time"]);
    if (isJsonObject(previewTime["range"])) ranges.push({ parent: previewTime, key: "range" });
    const userState = object(response["user_state"]);
    const userTime = object(userState["content_time"]);
    if (userTime["state"] === "set" && isJsonObject(userTime["range"])) ranges.push({ parent: userTime, key: "range" });
    const source = object(response["source"]);
    const sourceTime = object(source["content_time"]);
    if (isJsonObject(sourceTime["range"])) ranges.push({ parent: sourceTime, key: "range" });
    for (const entry of ranges) entry.parent[entry.key] = await this.#projectTimeRange(entry.parent[entry.key] as JsonObject);
    return response;
  }

  async #resolvedArchiveUserPatch(value: JsonValue | undefined): Promise<import("../adapters/library-data/index.mts").ArchiveUserPatch> {
    if (!isJsonObject(value)) fail("Conversation information draft is invalid");
    const draft = structuredClone(value);
    const contentTime = object(draft["content_time"]);
    if (contentTime["state"] === "set") {
      if (!isJsonObject(contentTime["range"])) fail("Conversation content time range is invalid");
      const range = normalizeRange(await this.#resolveTimeRange(contentTime["range"] as JsonObject));
      const checked = validateTimeValue(range);
      if (!checked.ok) throw new EngineCommandError("CLOUDIG_TIME_RANGE_INVALID", `Content time is invalid: ${checked.issues.map(issue => issue.code).join(",")}`);
      contentTime["range"] = checked.value;
    }
    return archiveUserPatch(draft);
  }

  async #moveArchive(selected: ArchiveCapability, target: string, targetArchived: boolean): Promise<JsonObject> {
    if (selected.fact.path === target) return { status: "unchanged", catalog: "written" };
    const timestamp = this.#clock();
    const result = targetArchived
      ? await archiveConversation({
          libraryRoot: this.#libraryRoot,
          source: selected.fact.path,
          transaction: this.#transaction(),
          timestamp,
          expectedSource: { bytes: selected.fact.bytes, sha256: selected.fact.sha256 }
        })
      : await moveArchiveFile({
          libraryRoot: this.#libraryRoot,
          source: selected.fact.path,
          target,
          transaction: this.#transaction(),
          timestamp,
          expectedSource: { bytes: selected.fact.bytes, sha256: selected.fact.sha256 }
        });
    if (result !== "moved") {
      await this.#revokeArchiveState();
      throw new EngineCommandError("CLOUDIG_ARCHIVE_WRITE_CONFLICT", "Archive bytes or destination changed; refresh the archive list");
    }
    let catalog: "written" | "conflict" | "missing" | "invalid" = "invalid";
    try {
      catalog = await refreshCatalogAfterArchiveMove(this.#libraryRoot, {
        sourcePath: selected.fact.path,
        targetPath: target,
        targetArchived,
        expected: {
          archive: selected.fact.archive,
          generation: selected.fact.generation,
          fingerprint: { bytes: selected.fact.bytes, sha256: selected.fact.sha256 }
        },
        builtAt: this.#clock()
      });
    } catch {
      catalog = "invalid";
    }
    this.#revokeArchiveFact(selected.fact);
    return { status: "moved", catalog };
  }

  #view(value: JsonValue | undefined): string {
    if (typeof value !== "string" || !VIEW_CAPABILITY.test(value)) fail("View capability is invalid");
    return value;
  }

  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      "reader.archives.query": async (payload) => this.#query(payload),
      "reader.archive.info.query": async (payload) => {
        exactObject(payload, ["archive"]);
        return this.#projectArchiveInfoResponse((await this.#archiveInfo(this.#writableArchive(payload["archive"]))).response);
      },
      "reader.archive.identity.query": async (payload) => {
        exactObject(payload, ["archive"]);
        const info = await this.#archiveInfo(this.#writableArchive(payload["archive"]));
        const names = object(info.context.userValues["names"]);
        return {
          revision: { library: info.context.libraryRevision, archive: info.context.archiveRevision },
          archive: info.context.view.archive,
          title: info.context.view.conversationName ?? info.context.filename.replace(/\.json$/iu, ""),
          platform: info.context.view.platform,
          names: {
            user: typeof names["user"] === "string" ? names["user"] : null,
            assistant: typeof names["assistant"] === "string" ? names["assistant"] : null
          },
          resolved: { user: info.context.view.userName, assistant: info.context.view.assistantName }
        };
      },
      "reader.archive.identity.commit": async (payload) => {
        exactObject(payload, ["archive", "expected_library_revision", "expected_archive_revision", "names"]);
        const expectedLibraryRevision = integer(payload["expected_library_revision"], "Expected Library revision");
        const expectedArchiveRevision = integer(payload["expected_archive_revision"], "Expected archive revision");
        if (expectedLibraryRevision < 1 || expectedArchiveRevision < 0) fail("Expected revisions are invalid");
        const selected = this.#writableArchive(payload["archive"]);
        const result = await commitArchiveUserState({
          libraryRoot: this.#libraryRoot,
          relativePath: selected.fact.path,
          expected: {
            archive: selected.fact.archive,
            generation: selected.fact.generation,
            bytes: selected.fact.bytes,
            sha256: selected.fact.sha256
          },
          expectedLibraryRevision,
          expectedArchiveRevision,
          patch: { names: archiveIdentityNames(payload["names"]) },
          touchOnNoop: false,
          anchor: this.#anchor(),
          transaction: this.#transaction(),
          recoveryTransaction: this.#transaction(),
          timestamp: this.#clock()
        });
        if (result.status === "conflict") {
          await this.#revokeArchiveState();
          throw new EngineCommandError("CLOUDIG_ARCHIVE_IDENTITY_CONFLICT", `Conversation identity changed: ${result.reason}`);
        }
        if (result.status === "updated") await this.#revokeArchiveState();
        const values = object(result.userValues["names"]);
        return {
          status: result.status,
          revision: { library: result.libraryRevision, archive: result.archiveRevision },
          names: {
            user: typeof values["user"] === "string" ? values["user"] : null,
            assistant: typeof values["assistant"] === "string" ? values["assistant"] : null
          }
        };
      },
      "reader.archive.info.preview": async (payload) => {
        exactObject(payload, ["archive", "draft"], ["language"]);
        const language = payload["language"] === "en" ? "en" : "zh-CN";
        const selected = this.#writableArchive(payload["archive"]);
        const patch = await this.#resolvedArchiveUserPatch(payload["draft"]);
        const info = await this.#archiveInfo(selected);
        const next = applyArchiveUserPatch(info.context.userValues, patch);
        return this.#projectArchiveInfoResponse({
          changed: !archiveUserValuesEqual(info.context.userValues, next),
          anchor_sensitive: archivePatchUsesAnchor(patch),
          content_time: contentTimeResult(next, language),
          draft: archiveUserDraft(next)
        });
      },
      "reader.archive.info.commit": async (payload) => {
        exactObject(payload, ["archive", "expected_library_revision", "expected_archive_revision", "draft", "touch_on_noop"]);
        const expectedLibraryRevision = integer(payload["expected_library_revision"], "Expected Library revision");
        const expectedArchiveRevision = integer(payload["expected_archive_revision"], "Expected archive revision");
        if (expectedLibraryRevision < 1 || expectedArchiveRevision < 0) fail("Expected revisions are invalid");
        if (typeof payload["touch_on_noop"] !== "boolean") fail("No-op touch choice is invalid");
        const selected = this.#writableArchive(payload["archive"]);
        const result = await commitArchiveUserState({
          libraryRoot: this.#libraryRoot,
          relativePath: selected.fact.path,
          expected: {
            archive: selected.fact.archive,
            generation: selected.fact.generation,
            bytes: selected.fact.bytes,
            sha256: selected.fact.sha256
          },
          expectedLibraryRevision,
          expectedArchiveRevision,
          patch: await this.#resolvedArchiveUserPatch(payload["draft"]),
          touchOnNoop: payload["touch_on_noop"],
          anchor: this.#anchor(),
          transaction: this.#transaction(),
          recoveryTransaction: this.#transaction(),
          timestamp: this.#clock()
        });
        if (result.status === "conflict") {
          await this.#revokeArchiveState();
          throw new EngineCommandError("CLOUDIG_ARCHIVE_INFO_CONFLICT", `Conversation information changed: ${result.reason}`);
        }
        if (result.status === "updated") await this.#revokeArchiveState();
        return this.#projectArchiveInfoResponse({
          status: result.status,
          revision: { library: result.libraryRevision, archive: result.archiveRevision },
          user_state: archiveUserDraft(result.userValues),
          ...(result.status === "updated" ? { edited_at: result.editedAt } : {})
        });
      },
      "reader.directory.create": async (payload) => {
        exactObject(payload, ["name"]);
        if (typeof payload["name"] !== "string") fail("Directory name is invalid");
        await createArchiveDirectory(this.#libraryRoot, payload["name"]);
        return { status: "created" };
      },
      "reader.directory.rename": async (payload) => {
        exactObject(payload, ["directory", "name"]);
        if (typeof payload["name"] !== "string") fail("Directory name is invalid");
        const selected = this.#directory(payload["directory"]);
        await renameArchiveDirectory(this.#libraryRoot, selected.name, payload["name"]);
        let catalog: "written" | "conflict" | "missing" | "invalid" = "invalid";
        try {
          catalog = await refreshCatalogAfterDirectoryRename(this.#libraryRoot, {
            from: selected.name,
            to: payload["name"],
            builtAt: this.#clock()
          });
        } catch {
          catalog = "invalid";
        }
        await this.#revokeArchiveState();
        return { status: "renamed", catalog };
      },
      "reader.directory.delete": async (payload) => {
        exactObject(payload, ["directory"]);
        const selected = this.#directory(payload["directory"]);
        await deleteEmptyArchiveDirectory(this.#libraryRoot, selected.name);
        await this.#revokeArchiveState();
        return { status: "deleted" };
      },
      "reader.archive.move": async (payload) => {
        exactObject(payload, ["archive"], ["directory"]);
        const selected = this.#writableArchive(payload["archive"]);
        if (selected.fact.archived) throw new EngineCommandError("CLOUDIG_ARCHIVE_ALREADY_ARCHIVED", "Restore the archive before moving it");
        const source = parseEditableConversationPath(selected.fact.path);
        const directory = payload["directory"] === undefined ? undefined : this.#directory(payload["directory"]);
        const target = directory ? `Conversations/${directory.name}/${source.filename}` : `Conversations/${source.filename}`;
        return this.#moveArchive(selected, target, false);
      },
      "reader.archive.archive": async (payload) => {
        exactObject(payload, ["archive"]);
        const selected = this.#writableArchive(payload["archive"]);
        if (selected.fact.archived) throw new EngineCommandError("CLOUDIG_ARCHIVE_ALREADY_ARCHIVED", "Archive is already in the archive area");
        const source = parseEditableConversationPath(selected.fact.path);
        return this.#moveArchive(selected, `Conversations/.Cloudig-Archive/${source.filename}`, true);
      },
      "reader.archive.restore": async (payload) => {
        exactObject(payload, ["archive"], ["directory"]);
        const selected = this.#writableArchive(payload["archive"]);
        if (!selected.fact.archived) throw new EngineCommandError("CLOUDIG_ARCHIVE_NOT_ARCHIVED", "Only archived conversations can be restored");
        const directory = payload["directory"] === undefined ? undefined : this.#directory(payload["directory"]);
        const source = parseEditableConversationPath(selected.fact.path);
        const target = directory ? `Conversations/${directory.name}/${source.filename}` : `Conversations/${source.filename}`;
        const result = await restoreConversation({
          libraryRoot: this.#libraryRoot,
          source: selected.fact.path,
          ...(directory ? { targetDirectory: directory.name } : {}),
          transaction: this.#transaction(),
          timestamp: this.#clock(),
          expectedSource: { bytes: selected.fact.bytes, sha256: selected.fact.sha256 }
        });
        if (result !== "moved") {
          await this.#revokeArchiveState();
          throw new EngineCommandError("CLOUDIG_ARCHIVE_WRITE_CONFLICT", "Archive bytes or destination changed; refresh the archive list");
        }
        let catalog: "written" | "conflict" | "missing" | "invalid" = "invalid";
        try {
          catalog = await refreshCatalogAfterArchiveMove(this.#libraryRoot, {
            sourcePath: selected.fact.path,
            targetPath: target,
            targetArchived: false,
            expected: {
              archive: selected.fact.archive,
              generation: selected.fact.generation,
              fingerprint: { bytes: selected.fact.bytes, sha256: selected.fact.sha256 }
            },
            builtAt: this.#clock()
          });
        } catch {
          catalog = "invalid";
        }
        this.#revokeArchiveFact(selected.fact);
        return { status: "moved", catalog };
      },
      "reader.archive.exportMarkdown": async (payload, context) => {
        exactObject(payload, ["archive"], ["selected_leaf", "branch_choices"]);
        const selected = this.#archive(payload["archive"]);
        const selectedLeaf = payload["selected_leaf"];
        if (selectedLeaf !== undefined && (typeof selectedLeaf !== "string" || selectedLeaf.length < 1 || selectedLeaf.length > 256)) {
          fail("Selected branch leaf is invalid");
        }
        let eventTail = Promise.resolve();
        try {
          const result = await exportConversationMarkdown({
            libraryRoot: this.#libraryRoot,
            relativePath: selected.fact.path,
            expectedArchive: selected.fact.archive,
            expectedGeneration: selected.fact.generation,
            expectedFingerprint: { bytes: selected.fact.bytes, sha256: selected.fact.sha256 },
            builtins: this.#builtins,
            availableAssets: this.#availableAssets,
            transaction: this.#transaction(),
            timestamp: this.#clock(),
            ...(typeof selectedLeaf === "string" ? { selectedLeaf } : {}),
            ...(payload["branch_choices"] !== undefined ? { branchChoices: branchChoices(payload["branch_choices"])! } : {}),
            signal: context.signal,
            onProgress: (completed, total) => {
              eventTail = eventTail.then(() => context.emit({ phase: "export-scan", bytes: { completed, total } }));
            }
          });
          await eventTail;
          if (result.status === "conflict") {
            throw new EngineCommandError("CLOUDIG_EXPORT_CONFLICT", "Export destination changed; run the export again");
          }
          return {
            status: "exported",
            filename: result.filename,
            bytes: result.fingerprint.bytes,
            sha256: result.fingerprint.sha256,
            messages: result.messages,
            ...(result.selectedLeaf ? { selected_leaf: result.selectedLeaf } : {})
          };
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason;
          if (error instanceof EngineCommandError) throw error;
          throw new EngineCommandError("CLOUDIG_EXPORT_FAILED", "Markdown export could not be completed; refresh the archive list and try again");
        }
      },
      "reader.archive.recycle.plan": async (payload) => {
        exactObject(payload, ["archive"]);
        const selected = this.#writableArchive(payload["archive"]);
        const planned = await planRecycleConversation(this.#libraryRoot, selected.fact.path);
        if (planned.bytes !== selected.fact.bytes || planned.sha256 !== selected.fact.sha256) {
          await this.#revokeArchiveState();
          throw new EngineCommandError("CLOUDIG_ARCHIVE_WRITE_CONFLICT", "Archive bytes changed; refresh the archive list");
        }
        const capability = this.#recycleToken();
        if (!RECYCLE_CAPABILITY.test(capability)) throw new TypeError("Recycle token factory returned an invalid capability");
        this.#recyclePlans.set(capability, {
          fact: selected.fact,
          path: planned.path,
          bytes: planned.bytes,
          sha256: planned.sha256
        });
        return { plan: capability, path: planned.path, bytes: planned.bytes, sha256: planned.sha256 };
      },
      "reader.archive.recycle.complete": async (payload) => {
        exactObject(payload, ["plan"]);
        const plan = this.#recycle(payload["plan"]);
        if (!(await recycledConversationIsMissing(this.#libraryRoot, plan.path))) {
          throw new EngineCommandError("CLOUDIG_RECYCLE_NOT_COMPLETED", "Archive is still present; it was not removed from the Library");
        }
        let catalog: "written" | "conflict" | "missing" | "invalid" = "invalid";
        try {
          catalog = await refreshCatalogAfterArchiveRemoval(this.#libraryRoot, {
            path: plan.path,
            expected: {
              archive: plan.fact.archive,
              generation: plan.fact.generation,
              fingerprint: { bytes: plan.bytes, sha256: plan.sha256 }
            },
            builtAt: this.#clock()
          });
        } catch {
          catalog = "invalid";
        }
        this.#recyclePlans.delete(payload["plan"] as string);
        this.#revokeArchiveFact(plan.fact);
        await pruneMissingSystemLogGroups(this.#libraryRoot, [plan.path]).catch(() => undefined);
        return { status: "recycled", catalog };
      },
      "reader.view.open": async (payload, context) => {
        exactObject(payload, ["archive", "request"]);
        const selected = this.#archive(payload["archive"]);
        try {
          return await this.#runtime.open({
            relativePath: selected.fact.path,
            expectedArchive: selected.fact.archive,
            expectedGeneration: selected.fact.generation,
            expectedFingerprint: { bytes: selected.fact.bytes, sha256: selected.fact.sha256 },
            page: viewRequest(payload["request"]),
            signal: context.signal
          });
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason;
          throw new EngineCommandError("CLOUDIG_READER_OPEN_FAILED", "Conversation could not be opened; refresh the archive list");
        }
      },
      "reader.view.page": async (payload) => {
        exactObject(payload, ["view", "request"]);
        try {
          return await this.#runtime.page(this.#view(payload["view"]), viewRequest(payload["request"]));
        } catch {
          throw new EngineCommandError("CLOUDIG_READER_VIEW_STALE", "Conversation view is stale; open the archive again");
        }
      },
      "reader.resource.materialize": async (payload, context) => {
        exactObject(payload, ["view", "resource"]);
        if (typeof payload["resource"] !== "string" || !RESOURCE_ID.test(payload["resource"])) fail("Resource ID is invalid");
        try {
          return await this.#runtime.materializeResource({
            token: this.#view(payload["view"]),
            resource: payload["resource"],
            signal: context.signal
          });
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason;
          throw new EngineCommandError("CLOUDIG_READER_RESOURCE_FAILED", "Resource could not be materialized");
        }
      },
      "reader.identity.resolve": async (payload, context) => {
        exactObject(payload, ["view", "identity"]);
        if (typeof payload["identity"] !== "string" || !IDENTITY_CAPABILITY.test(payload["identity"])) fail("Identity capability is invalid");
        try {
          return await this.#runtime.resolveIdentity({
            token: this.#view(payload["view"]),
            identity: payload["identity"],
            signal: context.signal
          });
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason;
          throw new EngineCommandError("CLOUDIG_READER_IDENTITY_FAILED", "Identity image could not be resolved");
        }
      },
      "reader.view.close": async (payload) => {
        exactObject(payload, ["view"]);
        const status = await this.#runtime.close(this.#view(payload["view"]));
        return { status };
      }
    };
  }

  async close(): Promise<void> {
    await this.#runtime.closeAll();
  }
}
