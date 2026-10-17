import { randomBytes } from "node:crypto";

import { dismissMissingCatalogSource, importPreparedSourcePicker, listSourceQueueFacts, rebuildCatalogFromAuthority, type SourceQueueFact } from "../adapters/library-data/index.mts";
import { projectArchiverSources, type ArchiverSourceRow } from "../app/archiver/index.mts";
import { prepareClaudeContainerSelection, runPreparedClaudeContainerSelection, type PreparedClaudeSelection } from "../app/parser/claude-batch.mts";
import { prepareParseBatch, runPreparedParseBatch, type PreparedParseBatch, type PreparedParseBatchItem } from "../app/parser/batch.mts";
import { adapterBundleSha256, adapterBundleSnapshot } from "../app/parser/registry.mts";
import { indexClaudeContainer, queryClaudeContainerRecords } from "../adapters/parser/claude-container.mts";
import { pruneMissingSystemLogGroups } from "../adapters/library-data/system-log.mts";
import resourceLimits from "../core/contracts/machine/resource-limits.json" with { type: "json" };
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";
import { engineOperationId, engineTransactionId } from "./transaction.mts";

const SOURCE_CAPABILITY = /^s_[A-Za-z0-9_-]{43}$/u;
const CONTAINER_CAPABILITY = /^c_[A-Za-z0-9_-]{43}$/u;
const SELECTOR = /^[0-9a-f]{64}$/u;
const PARSE_PLAN_CAPABILITY = /^pp_[A-Za-z0-9_-]{43}$/u;
const CLAUDE_PLAN_CAPABILITY = /^ep_[A-Za-z0-9_-]{43}$/u;
const PLAN_CAPABILITY_LIMIT = 512;
const PARSE_SELECTION_LIMIT = Math.floor(resourceLimits.ipc_json_nodes_max / 20);

function rememberPlan<T>(plans: Map<string, T>, token: string, plan: T): void {
  while (plans.size >= PLAN_CAPABILITY_LIMIT) {
    const oldest = plans.keys().next().value as string | undefined;
    if (!oldest) break;
    plans.delete(oldest);
  }
  plans.set(token, plan);
}

type SourceCapability = Readonly<{ fact: SourceQueueFact; row: ArchiverSourceRow }>;
type ContainerCapability = Readonly<{
  source: SourceCapability;
  sourceSha256: string;
  builtAt: string;
  records: number;
}>;

export type ArchiverEngineCommandsOptions = Readonly<{
  libraryRoot: string;
  runtimeRoot: string;
  sourceToken?: () => string;
  containerToken?: () => string;
  operation?: () => string;
  transaction?: () => string;
  parsePlanToken?: () => string;
  claudePlanToken?: () => string;
  clock?: () => string;
  resolveDirectory?: (capability: string) => string;
}>;

function fail(message: string): never {
  throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", message);
}

function exactObject(value: JsonValue | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!isJsonObject(value)) fail("Command payload object is invalid");
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail("Command payload fields are invalid");
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  return value;
}

function sourceKey(value: SourceQueueFact): string {
  return `${value.path}\0${value.bytes}\0${value.mtimeNs}\0${value.missing}`;
}

function compareMtime(left: SourceQueueFact, right: SourceQueueFact): number {
  try {
    const a = BigInt(left.mtimeNs);
    const b = BigInt(right.mtimeNs);
    return a === b ? left.path.localeCompare(right.path, "en") : a > b ? -1 : 1;
  } catch {
    return left.path.localeCompare(right.path, "en");
  }
}

function sourceCapturedAt(value: SourceQueueFact): string | undefined {
  try {
    const milliseconds = Number(BigInt(value.mtimeNs) / 1_000_000n);
    const timestamp = new Date(milliseconds);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function isClaudeContainerCandidate(value: ArchiverSourceRow): boolean {
  return value.kind === "claude_json" || value.displayFilename.toLowerCase().endsWith(".json");
}

export class ArchiverEngineCommands {
  readonly #libraryRoot: string;
  readonly #runtimeRoot: string;
  readonly #sourceToken: () => string;
  readonly #containerToken: () => string;
  readonly #operation: () => string;
  readonly #transaction: () => string;
  readonly #parsePlanToken: () => string;
  readonly #claudePlanToken: () => string;
  readonly #clock: () => string;
  readonly #resolveDirectory: ((capability: string) => string) | undefined;
  #sources = new Map<string, SourceCapability>();
  #sourceKeys = new Map<string, string>();
  #containers = new Map<string, ContainerCapability>();
  #containerKeys = new Map<string, string>();
  #parsePlans = new Map<string, PreparedParseBatch>();
  #claudePlans = new Map<string, PreparedClaudeSelection>();

  constructor(options: ArchiverEngineCommandsOptions) {
    this.#libraryRoot = options.libraryRoot;
    this.#runtimeRoot = options.runtimeRoot;
    this.#sourceToken = options.sourceToken ?? (() => `s_${randomBytes(32).toString("base64url")}`);
    this.#containerToken = options.containerToken ?? (() => `c_${randomBytes(32).toString("base64url")}`);
    this.#operation = options.operation ?? engineOperationId;
    this.#transaction = options.transaction ?? engineTransactionId;
    this.#parsePlanToken = options.parsePlanToken ?? (() => `pp_${randomBytes(32).toString("base64url")}`);
    this.#claudePlanToken = options.claudePlanToken ?? (() => `ep_${randomBytes(32).toString("base64url")}`);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#resolveDirectory = options.resolveDirectory;
  }

  async close(): Promise<void> {
    const plans = [...this.#parsePlans.values()];
    this.#parsePlans.clear();
    await Promise.all(plans.map(plan => plan.drafts?.dispose()));
  }

  #refreshCapabilities(rows: readonly ArchiverSourceRow[]): void {
    const next = new Map<string, SourceCapability>();
    const keys = new Map<string, string>();
    for (const row of rows) {
      const key = sourceKey(row.fact);
      let capability = this.#sourceKeys.get(key);
      if (!capability) {
        capability = this.#sourceToken();
        if (!SOURCE_CAPABILITY.test(capability)) throw new TypeError("Source token factory returned an invalid capability");
      }
      keys.set(key, capability);
      next.set(capability, { fact: row.fact, row });
    }
    this.#sourceKeys = keys;
    this.#sources = next;
  }

  #source(value: JsonValue | undefined): SourceCapability {
    if (typeof value !== "string" || !SOURCE_CAPABILITY.test(value)) fail("Source capability is invalid");
    const selected = this.#sources.get(value);
    if (!selected) throw new EngineCommandError("CLOUDIG_SOURCE_CAPABILITY_STALE", "Source selection is stale; refresh the source list");
    return selected;
  }

  #registerContainer(value: ContainerCapability): string {
    let capability = this.#containerKeys.get(value.sourceSha256);
    if (!capability) {
      capability = this.#containerToken();
      if (!CONTAINER_CAPABILITY.test(capability)) throw new TypeError("Container token factory returned an invalid capability");
    }
    this.#containerKeys.set(value.sourceSha256, capability);
    this.#containers.set(capability, value);
    return capability;
  }

  #container(value: JsonValue | undefined): ContainerCapability {
    if (typeof value !== "string" || !CONTAINER_CAPABILITY.test(value)) fail("Container capability is invalid");
    const selected = this.#containers.get(value);
    if (!selected) throw new EngineCommandError("CLOUDIG_CONTAINER_CAPABILITY_STALE", "Claude container selection is stale; return to Archiver and reopen it");
    if (!this.#sourceKeys.has(sourceKey(selected.source.fact))) {
      this.#containers.delete(value);
      this.#containerKeys.delete(selected.sourceSha256);
      throw new EngineCommandError("CLOUDIG_CONTAINER_CAPABILITY_STALE", "Claude source changed; return to Archiver and rebuild its index");
    }
    return selected;
  }

  #parsePlan(value: JsonValue | undefined): PreparedParseBatch {
    if (typeof value !== "string" || !PARSE_PLAN_CAPABILITY.test(value)) fail("Parser plan capability is invalid");
    const plan = this.#parsePlans.get(value);
    if (!plan) throw new EngineCommandError("CLOUDIG_PARSE_PLAN_STALE", "Parser preview is stale; preview the selected files again");
    return plan;
  }

  #claudePlan(value: JsonValue | undefined): PreparedClaudeSelection {
    if (typeof value !== "string" || !CLAUDE_PLAN_CAPABILITY.test(value)) fail("Claude extraction plan capability is invalid");
    const plan = this.#claudePlans.get(value);
    if (!plan) throw new EngineCommandError("CLOUDIG_CLAUDE_PLAN_STALE", "Claude extraction preview is stale; preview the selected conversations again");
    return plan;
  }

  #selectors(value: JsonValue | undefined): readonly string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 500 || value.some((entry) => typeof entry !== "string" || !SELECTOR.test(entry))) {
      fail("Claude record selection is invalid");
    }
    if (new Set(value).size !== value.length) fail("Claude record selection contains duplicates");
    return value as string[];
  }

  async #query(payload: JsonObject): Promise<JsonObject> {
    exactObject(payload, ["offset", "limit"], ["search", "statuses", "sort"]);
    const offset = integer(payload["offset"], "Source offset");
    const limit = integer(payload["limit"], "Source limit");
    if (offset < 0 || limit < 1 || limit > resourceLimits.reader_message_page_max) fail("Source query range is invalid");
    const search = payload["search"];
    if (search !== undefined && typeof search !== "string") fail("Source search must be text");
    const statuses = payload["statuses"];
    if (statuses !== undefined && (!Array.isArray(statuses) || statuses.some((value) => typeof value !== "string"))) fail("Source statuses are invalid");
    const sort = payload["sort"];
    if (sort !== undefined && sort !== "modified_desc" && sort !== "title") fail("Source sort is invalid");

    const listed = await listSourceQueueFacts(this.#libraryRoot);
    const rows = projectArchiverSources(
      listed.rows,
      adapterBundleSnapshot().adapters,
      listed.catalogAdapterBundleSha256 !== undefined && listed.catalogAdapterBundleSha256 !== adapterBundleSha256(),
      adapterBundleSha256()
    );
    this.#refreshCapabilities(rows);
    const statusSet = new Set(Array.isArray(statuses) ? statuses as string[] : []);
    const needle = typeof search === "string" ? search.trim().normalize("NFKC").toLocaleLowerCase("und") : "";
    const filtered = rows.filter((row) => (
      (statusSet.size === 0 || statusSet.has(row.status))
      && (needle.length === 0 || row.displayFilename.normalize("NFKC").toLocaleLowerCase("und").includes(needle))
    ));
    filtered.sort((left, right) => sort === "title"
      ? left.displayFilename.localeCompare(right.displayFilename, "und")
      : compareMtime(left.fact, right.fact));
    const totals = rows.reduce((value, row) => {
      if (!row.fact.missing) {
        value.bytes += row.fact.bytes;
        value.files += 1;
        if (row.kind === "bookmark_html") value.bookmark_html += 1;
        if (isClaudeContainerCandidate(row)) value.claude_json += 1;
      }
      value.status[row.status] = (value.status[row.status] ?? 0) + 1;
      return value;
    }, { bytes: 0, files: 0, bookmark_html: 0, claude_json: 0, status: {} as Record<string, number> });
    return {
      degraded: listed.catalogDegraded,
      offset,
      limit,
      total: filtered.length,
      stats: { bytes: totals.bytes, files: totals.files, bookmark_html: totals.bookmark_html, claude_json: totals.claude_json },
      statuses: totals.status,
      items: filtered.slice(offset, offset + limit).map((row) => ({
        capability: this.#sourceKeys.get(sourceKey(row.fact))!,
        filename: row.displayFilename,
        source_file: row.fact.path.split("/").at(-1)!,
        bytes: row.fact.bytes,
        mtime_ns: row.fact.mtimeNs,
        status: row.status,
        kind: row.kind,
        ...(row.platform ? { platform: row.platform } : {}),
        ...(row.exporterVersion ? { exporter_version: row.exporterVersion } : {}),
        ...(row.adapter ? { adapter: { id: row.adapter.id, version: row.adapter.version } } : {}),
        ...(row.action ? { action: row.action } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.retry ? { retry: row.retry } : {})
      }))
    };
  }

  async #selected(values: JsonValue | undefined): Promise<readonly SourceCapability[]> {
    if (!Array.isArray(values) || values.length < 1 || values.length > PARSE_SELECTION_LIMIT) fail("Parse selection is invalid");
    const selected = values.map((value) => this.#source(value));
    if (new Set(values).size !== values.length) fail("Parse selection contains duplicates");
    const current = await listSourceQueueFacts(this.#libraryRoot);
    const keys = new Set(current.rows.map(sourceKey));
    if (selected.some((entry) => !keys.has(sourceKey(entry.fact)))) {
      this.#sources.clear();
      this.#sourceKeys.clear();
      throw new EngineCommandError("CLOUDIG_SOURCE_CAPABILITY_STALE", "Source bytes changed; refresh the source list");
    }
    return selected;
  }

  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      "indexes.rebuild": async (payload, context) => {
        exactObject(payload, []);
        let eventTail = Promise.resolve();
        const result = await rebuildCatalogFromAuthority({
          libraryRoot: this.#libraryRoot,
          builtAt: this.#clock(),
          adapterBundleSha256: adapterBundleSha256(),
          signal: context.signal,
          onProgress: (completed, total) => {
            eventTail = eventTail.then(() => context.emit({ phase: "index", items: { completed, total } }));
          }
        });
        await eventTail;
        if (result.status === "cancelled") return { state: "cancelled", archives: result.archives, sources: result.sources };
        if (result.status !== "written") throw new EngineCommandError("CLOUDIG_INDEX_REBUILD_CONFLICT", "Indexes changed during rebuild; refresh and try again");
        this.#sources.clear();
        this.#sourceKeys.clear();
        this.#containers.clear();
        this.#containerKeys.clear();
        return { state: "completed", archives: result.archives, sources: result.sources, issues: result.issues.length };
      },
      "source.import": async (payload, context) => {
        exactObject(payload, ["pickers"]);
        const pickers = payload["pickers"];
        if (!Array.isArray(pickers) || pickers.length < 1 || pickers.length > 100 || pickers.some((value) => typeof value !== "string")) {
          fail("Source picker selection is invalid");
        }
        if (new Set(pickers).size !== pickers.length) fail("Source picker selection contains duplicates");
        const items: JsonObject[] = [];
        for (let index = 0; index < pickers.length; index += 1) {
          context.signal.throwIfAborted();
          await context.emit({ phase: "import", file: { index: index + 1, total: pickers.length } });
          try {
            const result = await importPreparedSourcePicker({
              libraryRoot: this.#libraryRoot,
              picker: pickers[index] as string,
              transaction: this.#transaction(),
              timestamp: this.#clock(),
              signal: context.signal
            });
            const filename = result.path.split("/").at(-1) ?? result.path;
            items.push({
              index: index + 1,
              status: result.status,
              filename,
              ...(result.status === "imported" ? { bytes: result.fingerprint.bytes, sha256: result.fingerprint.sha256 } : {})
            });
          } catch (error) {
            if (context.signal.aborted) throw error;
            items.push({ index: index + 1, status: "failed", code: "CLOUDIG_SOURCE_IMPORT_FAILED" });
          }
        }
        this.#sources.clear();
        this.#sourceKeys.clear();
        return { state: items.some((item) => item["status"] === "failed") ? "mixed" : "completed", items };
      },
      "archiver.sources.query": async (payload) => this.#query(payload),
      "archiver.claude.index": async (payload, context) => {
        exactObject(payload, ["source"], ["rebuild"]);
        const source = payload["source"];
        if (source === undefined) fail("Source capability is invalid");
        const selected = (await this.#selected([source]))[0]!;
        if (selected.fact.missing || (selected.row.kind !== "claude_json" && !selected.row.displayFilename.toLowerCase().endsWith(".json"))) {
          throw new EngineCommandError("CLOUDIG_CLAUDE_CONTAINER_REQUIRED", "Selected source is not an available Claude conversations.json container");
        }
        const builtAt = this.#clock();
        const rebuild = payload["rebuild"];
        if (rebuild !== undefined && typeof rebuild !== "boolean") fail("Claude rebuild flag is invalid");
        let eventTail = Promise.resolve();
        const result = await indexClaudeContainer({
          libraryRoot: this.#libraryRoot,
          sourcePath: selected.fact.path,
          buildToken: this.#transaction(),
          builtAt,
          ...(rebuild === true ? { rebuild: true } : {}),
          signal: context.signal,
          onProgress: (progress) => {
            eventTail = eventTail.then(() => context.emit({
              phase: "index",
              bytes: { completed: progress.bytesCompleted, total: progress.bytesTotal },
              items: { completed: progress.itemsCompleted, total_known: progress.totalKnown }
            }));
          }
        });
        await eventTail;
        if (result.status === "cancelled") return { state: "cancelled" };
        if (result.status === "conflict") throw new EngineCommandError("CLOUDIG_CONTAINER_INDEX_CONFLICT", "Claude index conflicts with the current source; rebuild it after refreshing Archiver");
        const current = await queryClaudeContainerRecords({ libraryRoot: this.#libraryRoot, sourceSha256: result.source.sha256, limit: 1 });
        const container = this.#registerContainer({
          source: selected,
          sourceSha256: result.source.sha256,
          builtAt: current.builtAt,
          records: result.records
        });
        return {
          state: "completed",
          status: result.status,
          container,
          source: {
            filename: selected.row.displayFilename,
            bytes: result.source.bytes,
            ...(sourceCapturedAt(selected.fact) ? { captured_at: sourceCapturedAt(selected.fact)! } : {})
          },
          records: result.records,
          built_at: current.builtAt
        };
      },
      "archiver.claude.records.query": async (payload) => {
        exactObject(payload, ["container", "offset", "limit"], ["search", "statuses", "time_field", "sort", "direction"]);
        const selected = this.#container(payload["container"]);
        const offset = integer(payload["offset"], "Claude record offset");
        const limit = integer(payload["limit"], "Claude record limit");
        if (offset < 0 || limit < 1 || limit > resourceLimits.reader_message_page_max) fail("Claude record query range is invalid");
        const search = payload["search"];
        if (search !== undefined && typeof search !== "string") fail("Claude record search must be text");
        const statuses = payload["statuses"];
        if (statuses !== undefined && (!Array.isArray(statuses) || statuses.some((status) => !["ready", "parsed", "update", "failed", "unsupported"].includes(String(status))))) fail("Claude record statuses are invalid");
        const timeField = payload["time_field"];
        if (timeField !== undefined && timeField !== "created_at" && timeField !== "updated_at") fail("Claude record time field is invalid");
        const sort = payload["sort"];
        if (sort !== undefined && sort !== "time" && sort !== "title") fail("Claude record sort is invalid");
        const direction = payload["direction"];
        if (direction !== undefined && direction !== "asc" && direction !== "desc") fail("Claude record direction is invalid");
        const result = await queryClaudeContainerRecords({
          libraryRoot: this.#libraryRoot,
          sourceSha256: selected.sourceSha256,
          offset,
          limit,
          ...(typeof search === "string" ? { search } : {}),
          ...(Array.isArray(statuses) ? { statuses: statuses as ("ready" | "parsed" | "update" | "failed" | "unsupported")[] } : {}),
          ...(timeField === "created_at" || timeField === "updated_at" ? { timeField } : {}),
          ...(sort === "time" || sort === "title" ? { sort } : {}),
          ...(direction === "asc" || direction === "desc" ? { direction } : {})
        });
        return {
          container: payload["container"]!,
          source: {
            filename: selected.source.row.displayFilename,
            bytes: selected.source.fact.bytes,
            ...(sourceCapturedAt(selected.source.fact) ? { captured_at: sourceCapturedAt(selected.source.fact)! } : {})
          },
          built_at: result.builtAt,
          total: result.total,
          visible: result.visible,
          offset: result.offset,
          statuses: result.statuses,
          items: result.records.map((record) => ({
            selector: record["selector"]!,
            ordinal: record["ordinal"]!,
            title: record["title"]!,
            messages: record["messages"]!,
            branches: record["branches"] ?? 0,
            ...(typeof record["created_at"] === "string" ? { created_at: record["created_at"] } : {}),
            ...(typeof record["updated_at"] === "string" ? { updated_at: record["updated_at"] } : {}),
            status: record["status"]!,
            ...(isJsonObject(record["failure"]) ? { error: record["failure"]["code"]! } : {})
          }))
        };
      },
      "archiver.claude.extract.preview": async (payload, context) => {
        exactObject(payload, ["container", "selectors"], ["directory", "preserve_previous", "copy_user_state"]);
        const selected = this.#container(payload["container"]);
        const selectors = this.#selectors(payload["selectors"]);
        const targetDirectory = typeof payload["directory"] === "string" && this.#resolveDirectory
          ? this.#resolveDirectory(payload["directory"])
          : undefined;
        if (payload["directory"] !== undefined && !targetDirectory) fail("Target directory capability is invalid");
        if (payload["preserve_previous"] !== undefined && typeof payload["preserve_previous"] !== "boolean") fail("Preserve-previous choice is invalid");
        if (payload["copy_user_state"] !== undefined && typeof payload["copy_user_state"] !== "boolean") fail("Preserve user-state choice is invalid");
        let eventTail = Promise.resolve();
        const result = await prepareClaudeContainerSelection({
          libraryRoot: this.#libraryRoot,
          sourcePath: selected.source.fact.path,
          selectors,
          preservePrevious: payload["preserve_previous"] === true,
          copyUserStateOnPreserve: payload["copy_user_state"] !== false,
          ...(targetDirectory ? { targetDirectory } : {}),
          ...(sourceCapturedAt(selected.source.fact) ? { fileSystemCapturedAt: sourceCapturedAt(selected.source.fact)! } : {}),
          operation: this.#operation(),
          signal: context.signal,
          onEvent: (event) => { eventTail = eventTail.then(() => context.emit(event)); }
        });
        await eventTail;
        const token = this.#claudePlanToken();
        if (!CLAUDE_PLAN_CAPABILITY.test(token)) throw new TypeError("Claude plan token factory returned an invalid capability");
        rememberPlan(this.#claudePlans, token, result);
        return {
          plan: token,
          copy_user_state: result.copyUserStateOnPreserve,
          items: result.items.map((item) => ({ index: item.index, action: item.action, reason: item.reason, ...(item.messages !== undefined ? { messages: item.messages } : {}), ...(item.resources !== undefined ? { resources: item.resources } : {}) }))
        };
      },
      "archiver.claude.extract.commit": async (payload, context) => {
        exactObject(payload, ["plans", "copy_user_state"]);
        if (
          !Array.isArray(payload["plans"])
          || payload["plans"].length < 1
          || payload["plans"].length > PLAN_CAPABILITY_LIMIT
          || payload["plans"].some((entry) => typeof entry !== "string")
          || new Set(payload["plans"]).size !== payload["plans"].length
        ) fail("Claude extraction plan list is invalid");
        const planTokens = payload["plans"] as string[];
        const preparedPlans = planTokens.map((token) => this.#claudePlan(token));
        const firstPlan = preparedPlans[0]!;
        if (preparedPlans.some((plan) => (
          plan.sourcePath !== firstPlan.sourcePath
          || plan.sourceSha256 !== firstPlan.sourceSha256
          || plan.targetDirectory !== firstPlan.targetDirectory
          || plan.preservePrevious !== firstPlan.preservePrevious
          || plan.copyUserStateOnPreserve !== firstPlan.copyUserStateOnPreserve
        ))) fail("Claude extraction plans do not belong to one preview batch");
        let itemIndex = 0;
        const plan: PreparedClaudeSelection = {
          ...firstPlan,
          items: preparedPlans.flatMap((entry) => entry.items.map((item) => ({ ...item, index: ++itemIndex })))
        };
        if (typeof payload["copy_user_state"] !== "boolean") fail("Preserve user-state choice is invalid");
        for (const token of planTokens) this.#claudePlans.delete(token);
        let eventTail = Promise.resolve();
        const result = await runPreparedClaudeContainerSelection({
          libraryRoot: this.#libraryRoot,
          plan,
          copyUserStateOnPreserve: payload["copy_user_state"],
          operation: this.#operation(),
          transactionTokens: plan.items.map(() => this.#transaction()),
          recoveryTransaction: this.#transaction(),
          timestamp: this.#clock(),
          signal: context.signal,
          onEvent: (event) => { eventTail = eventTail.then(() => context.emit(event)); }
        });
        await eventTail;
        return {
          state: result.state,
          items: result.items.map((item) => ({
            index: item.index,
            status: item.status,
            ...(item.status === "created" || item.status === "updated" || item.status === "preserved" ? { archive: item.archive } : {}),
            ...(item.status === "conflict" ? { reason: item.reason } : {}),
            ...(item.status === "failed" ? { code: item.code } : {})
          }))
        };
      },
      "archiver.source.dismissMissing": async (payload) => {
        exactObject(payload, ["source"]);
        const source = payload["source"];
        if (source === undefined) fail("Source capability is invalid");
        const selected = (await this.#selected([source]))[0]!;
        if (!selected.fact.missing) throw new EngineCommandError("CLOUDIG_SOURCE_NOT_MISSING", "Only a missing source queue record can be cleared");
        const result = await dismissMissingCatalogSource(this.#libraryRoot, {
          path: selected.fact.path,
          expected: { bytes: selected.fact.bytes, mtimeNs: selected.fact.mtimeNs },
          builtAt: this.#clock()
        });
        this.#sources.clear();
        this.#sourceKeys.clear();
        if (result !== "written") {
          throw new EngineCommandError("CLOUDIG_SOURCE_DISMISS_CONFLICT", "The missing source record changed; refresh the source list");
        }
        await pruneMissingSystemLogGroups(this.#libraryRoot, [selected.fact.path]).catch(() => undefined);
        return { status: "dismissed" };
      },
      "archiver.parse.plan": async (payload, context) => {
        exactObject(payload, ["sources"], ["directory", "preserve_previous", "copy_user_state"]);
        // Only the currently displayed preview may own retained draft bodies.
        // A new preview invalidates the previous token and releases its memory.
        await this.close();
        const selected = await this.#selected(payload["sources"]);
        if (payload["directory"] !== undefined && (typeof payload["directory"] !== "string" || !this.#resolveDirectory)) fail("Target directory capability is invalid");
        const targetDirectory = typeof payload["directory"] === "string" ? this.#resolveDirectory!(payload["directory"]) : undefined;
        if (payload["preserve_previous"] !== undefined && typeof payload["preserve_previous"] !== "boolean") fail("Preserve-previous choice is invalid");
        if (payload["copy_user_state"] !== undefined && typeof payload["copy_user_state"] !== "boolean") fail("Preserve user-state choice is invalid");
        const preservePrevious = payload["preserve_previous"] === true;
        const copyUserState = payload["copy_user_state"] !== false;
        const eligible = selected.flatMap((entry, originalIndex) => entry.fact.missing || entry.row.status === "unsupported" || isClaudeContainerCandidate(entry.row)
          ? []
          : [{ entry, originalIndex }]);
        let eventTail = Promise.resolve();
        const prepared = eligible.length > 0
          ? await prepareParseBatch({
            libraryRoot: this.#libraryRoot,
            runtimeRoot: this.#runtimeRoot,
            sourcePaths: eligible.map(({ entry }) => entry.fact.path),
            operation: this.#operation(),
            preservePrevious,
            copyUserStateOnPreserve: copyUserState,
            ...(targetDirectory ? { targetDirectory } : {}),
            signal: context.signal,
            onEvent: (event) => { eventTail = eventTail.then(() => context.emit(event)); }
          })
          : { state: "ready" as const, items: [], preservePrevious, copyUserStateOnPreserve: copyUserState, ...(targetDirectory ? { targetDirectory } : {}) };
        await eventTail;
        const byOriginal = new Map<number, PreparedParseBatchItem>();
        eligible.forEach(({ originalIndex }, index) => { const item = prepared.items[index]; if (item) byOriginal.set(originalIndex, item); });
        const items: PreparedParseBatchItem[] = selected.map((entry, originalIndex) => {
          const item = byOriginal.get(originalIndex);
          if (item) return { ...item, index: originalIndex + 1 };
          return {
            index: originalIndex + 1,
            sourcePath: entry.fact.path,
            action: "excluded" as const,
            reason: entry.fact.missing ? "missing" : entry.row.status === "unsupported" ? "unsupported" : "claude_container"
          };
        });
        if (prepared.state === "cancelled") return { state: "cancelled", items: [] };
        const plan: PreparedParseBatch = {
          state: "ready",
          items,
          ...(prepared.drafts ? { drafts: prepared.drafts } : {}),
          ...("knownPresentSourcePaths" in prepared ? { knownPresentSourcePaths: prepared.knownPresentSourcePaths } : {}),
          preservePrevious,
          copyUserStateOnPreserve: copyUserState,
          ...(targetDirectory ? { targetDirectory } : {})
        };
        const token = this.#parsePlanToken();
        if (!PARSE_PLAN_CAPABILITY.test(token)) throw new TypeError("Parser plan token factory returned an invalid capability");
        await this.close();
        rememberPlan(this.#parsePlans, token, plan);
        return {
          state: "ready",
          plan: token,
          copy_user_state: copyUserState,
          items: selected.map((entry, index) => {
            const item = items[index]!;
            return {
            index: item.index,
            source: (payload["sources"] as string[])[index]!,
            filename: entry.row.displayFilename,
            action: item.action,
            reason: item.reason,
            ...(item.bytes !== undefined ? { bytes: item.bytes } : {}),
            ...(item.messages !== undefined ? { messages: item.messages } : {}),
            ...(item.resources !== undefined ? { resources: item.resources } : {})
          };})
        };
      },
      "archiver.parse.commit": async (payload, context) => {
        exactObject(payload, ["plan", "copy_user_state"]);
        const planToken = payload["plan"] as string;
        const plan = this.#parsePlan(planToken);
        if (typeof payload["copy_user_state"] !== "boolean") fail("Preserve user-state choice is invalid");
        this.#parsePlans.delete(planToken);
        let eventTail = Promise.resolve();
        const result = await runPreparedParseBatch({
          libraryRoot: this.#libraryRoot,
          runtimeRoot: this.#runtimeRoot,
          plan,
          operation: this.#operation(),
          transactionTokens: plan.items.map(() => this.#transaction()),
          recoveryTransaction: this.#transaction(),
          timestamp: this.#clock(),
          copyUserStateOnPreserve: payload["copy_user_state"],
          signal: context.signal,
          onEvent: (event) => { eventTail = eventTail.then(() => context.emit(event)); }
        });
        await eventTail;
        this.#sources.clear();
        this.#sourceKeys.clear();
        return {
          state: result.state,
          items: result.items.map((item) => ({
            index: item.index,
            status: item.status,
            ...(item.status === "created" || item.status === "updated" || item.status === "preserved" ? { archive: item.archive } : {}),
            ...(item.status === "conflict" ? { reason: item.reason } : {}),
            ...(item.status === "failed" ? { code: item.code } : {})
          }))
        };
      }
    };
  }
}
