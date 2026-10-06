import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { inspectOfficialZip } from "../adapters/parser/official-zip.mts";
import { scanRecordSources, readRecordParseStatuses, dismissMissingRecordSources, unitKey, type RecordSource, type RecordParseStatus } from "../adapters/library-data/record-parse-status.mts";
import { importRecordPicker } from "../adapters/library-data/record-source-import.mts";
import { prepareRecordPicker, RECORD_PICKER_LIMITS } from "../adapters/library-data/record-picker.mts";
import { collectOfficialCompanions } from "../adapters/parser/official-json-assets.mts";
import { readRecordCatalog } from "../adapters/library-data/record-catalog.mts";
import { readRecordSystemLog, updateRecordSystemLog } from "../adapters/library-data/record-system-log.mts";
import { indexRecordOfficialContainer, type RecordOfficialIndex } from "../adapters/parser/record-official-index.mts";
import { resolveRecordPath, withRecordSnapshot, recordFileIdentity, RecordStoreConflict } from "../adapters/storage/record-store.mts";
import { fileCaptureTime } from "../app/parser/record-source.mts";
import { prepareRecordParsePlan, type RecordParsePlan } from "../app/parser/record-plan.mts";
import { runRecordParseBatch } from "../app/parser/record-batch.mts";
import { PARSER_VERSION, adapterBundleSnapshot } from "../app/parser/registry.mts";
import { parserErrorMessage } from "../app/parser/diagnostics.mts";
import { EngineCommandError, type EngineCommandHandler, type EngineCommandContext } from "./protocol.mts";
import resourceLimits from "../core/contracts/machine/resource-limits.json" with { type: "json" };
import { QueryPages } from "./query-pages.mts";
import { ContainerIndexRequests } from "./container-index-requests.mts";

export const RECORD_ARCHIVER_LIMITS = Object.freeze({ page: 200, sourceSelection: Math.floor(resourceLimits.ipc_json_nodes_max / 20), selectionChunk: 500, retainedSelections: 8, selectorsPerPreview: 500, retainedPlans: 512, imports: 100, searchCharacters: 1024, progressIntervalMs: 80 });
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const sourceKey = (s: RecordSource) => JSON.stringify([s.path, s.sha256, s.stamp, !!s.missing]);
const obj = (value: unknown): JsonObject => isJsonObject(value) ? value : {};
function exact(v: JsonValue | undefined, required: string[], optional: string[] = []): JsonObject {
  if (!isJsonObject(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Unexpected Archiver fields"); return v;
}
function pagination(p: JsonObject) {
  const offset = p["offset"], limit = p["limit"]; if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > RECORD_ARCHIVER_LIMITS.page) throw new TypeError("Invalid page range"); return { offset: Number(offset), limit: Number(limit) };
}
function strings(value: JsonValue | undefined, limit: number, allowEmpty = true): string[] {
  if (!Array.isArray(value) || !allowEmpty && !value.length || value.length > limit || value.some(v => typeof v !== "string") || new Set(value).size !== value.length) throw new TypeError("Invalid or duplicate selection"); return value as string[];
}
const matches = (text: string, query: string) => text.normalize("NFKC").toLocaleLowerCase("und").includes(query.trim().normalize("NFKC").toLocaleLowerCase("und"));
function search(p: JsonObject): string { const v = p["search"]; if (v !== undefined && (typeof v !== "string" || v.length > RECORD_ARCHIVER_LIMITS.searchCharacters)) throw new TypeError("Invalid title search"); return typeof v === "string" ? v : ""; }
function wireStatus(row: RecordParseStatus, claude = false): string { return claude ? row.status === "parsed" && row.outdated ? "update" : row.status : row.status === "ready" ? "pending" : row.status === "parsed" ? row.outdated ? "update_action" : "complete" : row.status; }
function sourceRow(source: RecordSource, row: RecordParseStatus, capability: string): JsonObject {
  const filename = source.path.slice(6), bookmark = source.format === "exporter-html" && !!source.declaration, adapter = adapterBundleSnapshot().adapters.find(a => a.id === source.adapterId);
  return { capability, filename: bookmark ? filename.replace(/\.html?$/iu, "") : filename, source_file: filename, bytes: source.bytes,
    mtime_ns: String(BigInt(Date.parse(source.modifiedAt)) * 1000000n), captured_at: source.captured?.at ?? null,
    ...(source.captured ? { captured_from: source.captured.from } : {}), status: wireStatus(row), kind: ["json-container", "zip-container"].includes(source.format) ? "claude_json" : ["json", "jsonl"].includes(source.format) ? "agent_json" : bookmark ? "bookmark_html" : "other",
    ...(source.platform ? { platform: source.platform } : {}), ...(source.exporterVersion ? { exporter_version: source.exporterVersion } : {}), ...(adapter ? { adapter: { id: adapter.id, version: adapter.version } } : {}), ...(row.error ? { error: row.error } : {}) };
}
type Container = { source: RecordSource; index: RecordOfficialIndex };
type Plan = { value: RecordParsePlan; sourcePath?: string };
function planItems(value: RecordParsePlan, offset: number, limit: number): JsonObject[] {
  return value.preview.slice(offset, offset + limit).map((p, i) => ({ index: offset + i + 1, filename: p.filename, ...(p.title ? { title: p.title } : {}), ...(p.locator ? { selector: p.locator } : {}), action: "parse", reason: "confirmed_source_unit" }));
}

/** Metadata plans do not extract messages. The same S3 batch runs only after confirmation. */
export class RecordArchiverEngineCommands {
  readonly #root: string; readonly #runtime: string; readonly #clock: () => string; readonly #directory: ((capability: string) => string) | undefined;
  readonly #sources = new Map<string, RecordSource>(); readonly #sourceKeys = new Map<string, string>(); readonly #containers = new Map<string, Container>(); readonly #containerKeys = new Map<string, string>(); readonly #plans = new Map<string, Plan>();
  readonly #pages = new QueryPages(); readonly #selections = new Map<string, Set<string>>();
  readonly #indexRequests = new ContainerIndexRequests<Awaited<ReturnType<typeof indexRecordOfficialContainer>>>();
  constructor(input: { libraryRoot: string; runtimeRoot: string; clock?: () => string; resolveDirectory?: (capability: string) => string }) { this.#root = input.libraryRoot; this.#runtime = input.runtimeRoot; this.#clock = input.clock ?? (() => new Date().toISOString()); this.#directory = input.resolveDirectory; }
  async #scan(): Promise<readonly RecordSource[]> {
    const sources = await scanRecordSources(this.#root, { includeMissing: true }), keep = new Set(sources.map(sourceKey));
    for (const [key, cap] of this.#sourceKeys) if (!keep.has(key)) { this.#sourceKeys.delete(key); this.#sources.delete(cap); }
    for (const source of sources) { const key = sourceKey(source); let cap = this.#sourceKeys.get(key); if (!cap) { cap = token("s"); this.#sourceKeys.set(key, cap); } this.#sources.set(cap, source); }
    for (const [cap, c] of this.#containers) if (!keep.has(sourceKey(c.source))) { this.#containers.delete(cap); this.#containerKeys.delete(sourceKey(c.source)); }
    return sources;
  }
  #source(value: JsonValue | undefined): RecordSource { const source = typeof value === "string" ? this.#sources.get(value) : undefined; if (!source) throw new EngineCommandError("CLOUDIG_SOURCE_CAPABILITY_STALE", "Source changed; refresh the source list"); return source; }
  async #container(value: JsonValue | undefined): Promise<Container> { await this.#scan(); const found = typeof value === "string" ? this.#containers.get(value) : undefined; if (!found) throw new EngineCommandError("CLOUDIG_CONTAINER_CAPABILITY_STALE", "Claude source changed; reopen its index"); return found; }
  #output(payload: JsonObject): string | undefined {
    const value = payload["directory"]; if (value === undefined) return undefined; if (value === "root") return "Conversations";
    if (typeof value !== "string" || !this.#directory) throw new TypeError("Invalid output directory"); return `Conversations/${this.#directory(value)}`;
  }
  #remember(plan: Plan, prefix: string): string { while (this.#plans.size >= RECORD_ARCHIVER_LIMITS.retainedPlans) this.#plans.delete(this.#plans.keys().next().value!); const cap = token(prefix); this.#plans.set(cap, plan); return cap; }
  async #prepare(payload: JsonObject, claude: boolean): Promise<JsonObject> {
    exact(payload, claude ? ["container", "selectors"] : [], ["directory", "preserve_previous", "one_click", ...(claude ? [] : ["sources", "selection"])]);
    if (!claude && Object.hasOwn(payload, "sources") === Object.hasOwn(payload, "selection")) throw new TypeError("Provide exactly one source selection");
    if (payload["preserve_previous"] !== undefined && typeof payload["preserve_previous"] !== "boolean" || payload["one_click"] !== undefined && typeof payload["one_click"] !== "boolean") throw new TypeError("Invalid parse settings");
    await this.#scan(); const container = claude ? await this.#container(payload["container"]) : undefined;
    const selected = new Set<string>();
    if (container) {
      const ids = strings(payload["selectors"], RECORD_ARCHIVER_LIMITS.selectorsPerPreview); const valid = new Set(container.index.records.map(r => r["selector"]));
      for (const locator of ids) { if (!valid.has(locator)) throw new TypeError("Claude record is outside this container"); selected.add(JSON.stringify(unitKey({ source: container.source, locator }))); }
    } else {
      const caps = payload["selection"] === undefined ? strings(payload["sources"], RECORD_ARCHIVER_LIMITS.sourceSelection) : this.#selections.get(String(payload["selection"]));
      if (!caps) throw new EngineCommandError("CLOUDIG_SOURCE_CAPABILITY_STALE", "Selection expired; select the source files again");
      for (const cap of caps) selected.add(JSON.stringify(unitKey({ source: this.#source(cap) })));
    }
    const directory = this.#output(payload), settings = { include_unparsed: false, include_selected: true, include_outdated: false, keep_previous: payload["preserve_previous"] === true };
    let value = await prepareRecordParsePlan(this.#root, { mode: claude ? "claude_json" : "parser", selected, ...(container ? { claudeIndex: container.index } : {}), ...(directory ? { directory } : {}), ...(payload["one_click"] === true ? {} : { settings }) });
    if (payload["preserve_previous"] !== undefined) value = { ...value, settings: { ...value.settings, keep_previous: payload["preserve_previous"] as boolean } };
    const cap = this.#remember({ value, ...(container ? { sourcePath: container.source.path } : {}) }, claude ? "ep" : "pp");
    if (typeof payload["selection"] === "string") this.#selections.delete(payload["selection"]);
    return { state: "ready", plan: cap, directory: value.directory, preserve_previous: value.settings.keep_previous, total: value.preview.length, items: planItems(value, 0, RECORD_ARCHIVER_LIMITS.page) };
  }
  async #commit(payload: JsonObject, context: EngineCommandContext, claude: boolean): Promise<JsonObject> {
    exact(payload, claude ? ["plans"] : ["plan"]); const caps = claude ? strings(payload["plans"], RECORD_ARCHIVER_LIMITS.retainedPlans, false) : [String(payload["plan"])];
    const plans = caps.map(cap => { const p = this.#plans.get(cap); if (!p || claude !== !!p.sourcePath) throw new EngineCommandError("CLOUDIG_PARSE_PLAN_STALE", "Parse preview expired; confirm the range again"); return p; });
    const first = plans[0]!; if (plans.some(p => p.sourcePath !== first.sourcePath || p.value.directory !== first.value.directory || p.value.relocateExisting !== first.value.relocateExisting || JSON.stringify(p.value.directoryIdentity) !== JSON.stringify(first.value.directoryIdentity) || JSON.stringify(p.value.settings) !== JSON.stringify(first.value.settings))) throw new TypeError("Parse previews do not belong to the same batch");
    const units = plans.flatMap(p => p.value.units), jobs = plans.flatMap(p => p.value.jobs); if (new Set(units.map(u => JSON.stringify(unitKey(u)))).size !== units.length) throw new TypeError("Parse previews contain duplicate records");
    for (const cap of caps) this.#plans.delete(cap);
    let tail = Promise.resolve();
    const result = await runRecordParseBatch(this.#root, jobs, { parserVersion: PARSER_VERSION, timestamp: this.#clock(), directory: first.value.directory, directoryIdentity: first.value.directoryIdentity, ...(first.value.relocateExisting ? { relocateExisting: true } : {}), keepPrevious: first.value.settings.keep_previous, units, signal: context.signal,
      onProgress: event => {
        // Workers already throttle each file and preserve phase boundaries/final values.
        // A second batch-wide throttle loses another worker's entire short-file progress.
        const detail = event.detail, normalization = detail?.phase === "normalize";
        const update: JsonObject = { phase: detail?.phase ?? event.phase, file: { index: event.index + 1, completed: event.completed, total: event.total },
          items: normalization ? { completed: detail.completed, total: detail.total } : { completed: event.completed, total: event.total },
          ...(detail && !normalization ? { bytes: { completed: detail.completed, total: detail.total } } : {}) };
        tail = tail.then(() => context.emit(update));
      } });
    await tail;
    return { state: result.state, total: result.items.length, completed: result.items.filter(i => i.status === "created" || i.status === "updated").length, failed: result.items.filter(i => i.status === "failed").length, items: result.items.slice(0, RECORD_ARCHIVER_LIMITS.page).map(item => ({ index: item.index + 1, status: item.status,
      ...("conversationId" in item ? { archive: item.conversationId, path: item.path } : {}), ...(item.status === "failed" ? { code: "CLOUDIG_PARSE_FAILED", message: item.message } : {}) })),
      ...(result.maintenanceWarnings.length ? { maintenance_warnings: [...result.maintenanceWarnings] } : {}) };
  }
  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    const guard = (handler: EngineCommandHandler): EngineCommandHandler => async (p, c) => { try { c.signal.throwIfAborted(); return await handler(p, c); } catch (e) { if (e instanceof EngineCommandError || e instanceof Error && e.name === "AbortError") throw e; throw new EngineCommandError("CLOUDIG_ARCHIVER_OPERATION_FAILED", e instanceof Error ? e.message : "Archiver operation failed"); } };
    return {
      "archiver.sources.query": guard(async payload => {
        if (Object.hasOwn(payload, "snapshot")) { exact(payload, ["snapshot", "offset", "limit"]); const p = pagination(payload); return this.#pages.read("sources", payload["snapshot"], p.offset, p.limit); }
        exact(payload, ["offset", "limit"], ["search", "statuses", "sort"]); const page = pagination(payload), needle = search(payload), statuses = payload["statuses"] === undefined ? [] : strings(payload["statuses"], 6), sort = payload["sort"] ?? "captured_desc";
        if (statuses.some(s => !["pending", "complete", "update_action", "failed", "missing", "unsupported"].includes(s)) || !["captured_desc", "captured_asc", "modified_desc", "modified_asc", "title"].includes(String(sort))) throw new TypeError("Invalid source filter or order");
        const sources = await this.#scan(), parsed = await readRecordParseStatuses(this.#root, sources.map(source => ({ source }))), rows = sources.map((s, i) => sourceRow(s, parsed[i]!, this.#sourceKeys.get(sourceKey(s))!));
        const visible = rows.filter(r => (!statuses.length || statuses.includes(String(r["status"]))) && matches(String(r["filename"]), needle));
        visible.sort((a, b) => {
          const titleOrder = String(a["filename"]).localeCompare(String(b["filename"]), "und");
          if (sort === "title") return titleOrder;
          const left = typeof a["captured_at"] === "string" ? Date.parse(a["captured_at"]) : NaN;
          const right = typeof b["captured_at"] === "string" ? Date.parse(b["captured_at"]) : NaN;
          if (!Number.isFinite(left) || !Number.isFinite(right)) return Number(!Number.isFinite(left)) - Number(!Number.isFinite(right)) || titleOrder;
          return (left - right) * (String(sort).endsWith("_asc") ? 1 : -1) || titleOrder;
        });
        const totals: JsonObject = {}; for (const row of rows) totals[String(row["status"])] = Number(totals[String(row["status"])] ?? 0) + 1;
        return this.#pages.create("sources", visible, { degraded: false, total: visible.length, statuses: totals, stats: { files: sources.filter(s => !s.missing).length, bytes: sources.filter(s => !s.missing).reduce((sum, s) => sum + s.bytes, 0), bookmark_html: rows.filter(r => r["status"] !== "missing" && r["kind"] === "bookmark_html").length, claude_json: rows.filter(r => r["status"] !== "missing" && r["kind"] === "claude_json").length } }, page.offset, page.limit);
      }),
      "archiver.sources.select": guard(async payload => {
        exact(payload, ["sources"], ["selection"]);
        const caps = strings(payload["sources"], RECORD_ARCHIVER_LIMITS.selectionChunk);
        for (const cap of caps) this.#source(cap);
        let selection = typeof payload["selection"] === "string" ? payload["selection"] : undefined;
        if (Object.hasOwn(payload, "selection") && (!selection || !this.#selections.has(selection))) throw new EngineCommandError("CLOUDIG_SOURCE_CAPABILITY_STALE", "Selection expired; select the source files again");
        if (!selection) {
          while (this.#selections.size >= RECORD_ARCHIVER_LIMITS.retainedSelections) this.#selections.delete(this.#selections.keys().next().value!);
          selection = token("ss"); this.#selections.set(selection, new Set());
        }
        const selected = this.#selections.get(selection)!; for (const cap of caps) selected.add(cap);
        return { selection, total: selected.size };
      }),
      "source.assets.plan": guard(async (payload, context) => {
        exact(payload, ["picker"]); if (typeof payload["picker"] !== "string") throw new TypeError("Invalid source picker");
        const picker = await prepareRecordPicker(this.#runtime, payload["picker"]);
        if (/\.zip$/iu.test(picker.filename)) { const zip = await inspectOfficialZip(picker.payloadPath, context.signal); return { available: false, platform: zip.platform, files: 0 }; }
        const plan = await collectOfficialCompanions(picker.payloadPath, context.signal);
        if (!plan.keys.length) return { available: false, platform: plan.platform };
        const data = Buffer.from(JSON.stringify({ schema: "cloudig/picker-assets-plan/1.0.0", source_sha256: picker.fingerprint.sha256, ...plan }));
        if (plan.keys.length > RECORD_PICKER_LIMITS.companionFiles || data.length > RECORD_PICKER_LIMITS.companionManifestBytes) throw new TypeError("Official attachment selection exceeds its configured limit");
        context.signal.throwIfAborted(); await writeFile(await resolveRecordPath(this.#runtime, `Pickers/${picker.picker}/assets-plan.json`), data, { flag: "wx" });
        return { available: true, platform: plan.platform, files: plan.keys.length };
      }),
      "source.import": guard(async (payload, context) => {
        exact(payload, ["pickers"]); const pickers = strings(payload["pickers"], RECORD_ARCHIVER_LIMITS.imports, false), items: JsonObject[] = []; let recovery = false;
        for (const [index, picker] of pickers.entries()) {
          context.signal.throwIfAborted(); await context.emit({ phase: "import", file: { index: index + 1, total: pickers.length }, items: { completed: index, total: pickers.length } }); let tail = Promise.resolve(), last = 0;
          try { const result = await importRecordPicker(this.#root, this.#runtime, picker, { signal: context.signal, onProgress: (completed, total) => { const now = Date.now(); if (completed !== total && now - last < RECORD_ARCHIVER_LIMITS.progressIntervalMs) return; last = now; tail = tail.then(() => context.emit({ phase: "import", file: { index: index + 1, total: pickers.length }, bytes: { completed, total } })); } });
            await tail; items.push({ index: index + 1, status: "imported", filename: result.filename, ...result.fingerprint, ...(result.maintenanceWarnings.length ? { maintenance_warnings: [...result.maintenanceWarnings] } : {}) });
          } catch (error) { await tail; if (context.signal.aborted) throw error; items.push({ index: index + 1, status: "failed", code: "CLOUDIG_SOURCE_IMPORT_FAILED" }); if (error instanceof RecordStoreConflict && error.operationId) { recovery = true; break; } }
        }
        await context.emit({ phase: "done", items: { completed: items.length, total: pickers.length } }); return { state: recovery ? "recovery_required" : items.some(i => i["status"] === "failed") ? "mixed" : "completed", items };
      }),
      "indexes.rebuild": guard(async (payload, context) => {
        exact(payload, []); await context.emit({ phase: "index", items: { completed: 0 } });
        const catalog = await withRecordSnapshot(this.#root, () => readRecordCatalog(this.#root, { force: true })), sources = await this.#scan();
        await context.emit({ phase: "index", items: { completed: catalog.conversations.length, total: catalog.conversations.length } });
        return { state: "completed", archives: catalog.conversations.length, sources: sources.filter(s => !s.missing).length, issues: catalog.issues.length };
      }),
      "archiver.source.dismissMissing": guard(async payload => {
        exact(payload, ["source"], ["all_missing"]);
        if (typeof payload["source"] !== "string" || payload["all_missing"] !== undefined && typeof payload["all_missing"] !== "boolean") throw new TypeError("Invalid missing-record scope");
        const sources = await this.#scan();
        const selected = payload["all_missing"] === true ? sources.filter(source => source.missing) : [this.#source(payload["source"])];
        const dismissed = await dismissMissingRecordSources(this.#root, selected);
        await readRecordSystemLog(this.#root);
        return { status: dismissed ? "dismissed" : "unchanged", dismissed };
      }),
      "archiver.claude.index": guard(async (payload, context) => {
        exact(payload, ["source"], ["rebuild"]); if (payload["rebuild"] !== undefined && typeof payload["rebuild"] !== "boolean") throw new TypeError("Invalid rebuild choice"); await this.#scan(); const source = this.#source(payload["source"]);
        if (source.missing || !["json-container", "zip-container"].includes(source.format)) throw new TypeError("Select an available platform JSON or ZIP file");
        const warnings: string[] = [];
        let tail = Promise.resolve(), last = 0;
        const result = await this.#indexRequests.run(JSON.stringify([sourceKey(source), payload["rebuild"] === true]), context.signal,
          e => { const now = Date.now(); if (e.phase !== "ready" && e.bytes !== 0 && now - last < RECORD_ARCHIVER_LIMITS.progressIntervalMs) return; last = now; tail = tail.then(() => context.emit({ phase: "index", bytes: { completed: e.bytes, total: e.total }, items: { completed: e.records } })); },
          (signal, onProgress) => indexRecordOfficialContainer(this.#root, source.path, {signal, onProgress, ...(payload["rebuild"] === true ? {rebuild:true} : {})})).catch(async error => {
          await tail;
          if (!context.signal.aborted && !(error instanceof Error && error.name === "AbortError")) await updateRecordSystemLog(this.#root, [{ path: source.path, recorded_at: this.#clock(), errors: [{ source: "parser", code: `${source.platform ?? 'claude'}-index-failed`, message: parserErrorMessage(error, "Platform JSON indexing failed") }] }]).catch(() => undefined);
          throw error;
        }); await tail;
        await updateRecordSystemLog(this.#root, [{ path: source.path, recorded_at: this.#clock(), errors: [] }]).catch(() => { warnings.push("Index succeeded; System Log cleanup is pending"); });
        const key = sourceKey(source); let cap = this.#containerKeys.get(key); if (!cap) { cap = token("c"); this.#containerKeys.set(key, cap); } this.#containers.set(cap, { source, index: result.index });
        return { state: "completed", status: result.reused ? "reused" : "indexed", container: cap, source: { filename: source.path.slice(6), bytes: source.bytes, captured_at: (await fileCaptureTime(await resolveRecordPath(this.#root, source.path), source.sha256))?.at ?? null }, records: result.index.records.length, built_at: result.index.built_at!, ...(warnings.length ? { maintenance_warnings: warnings } : {}) };
      }),
      "archiver.claude.records.query": guard(async payload => {
        if (Object.hasOwn(payload, "snapshot")) { exact(payload, ["container", "snapshot", "offset", "limit"]); const p = pagination(payload); return this.#pages.read(`claude:${String(payload["container"])}`, payload["snapshot"], p.offset, p.limit); }
        exact(payload, ["container", "offset", "limit"], ["search", "statuses", "time_field", "sort", "direction"]); const page = pagination(payload), needle = search(payload), c = await this.#container(payload["container"]), statuses = payload["statuses"] === undefined ? [] : strings(payload["statuses"], 5), time = payload["time_field"] ?? "updated_at", sort = payload["sort"] ?? "time", direction = payload["direction"] ?? "desc";
        if (statuses.some(s => !["ready", "parsed", "update", "failed", "unsupported"].includes(s)) || !["created_at", "updated_at"].includes(String(time)) || !["time", "title"].includes(String(sort)) || !["asc", "desc"].includes(String(direction))) throw new TypeError("Invalid Claude filter or order");
        const facts = await readRecordParseStatuses(this.#root, c.index.records.map(r => ({ source: c.source, locator: String(r["selector"]) }))), totals: JsonObject = {};
        const rows = c.index.records.map((r, i) => { const status = wireStatus(facts[i]!, true); totals[status] = Number(totals[status] ?? 0) + 1; return { selector: r["selector"]!, ordinal: r["ordinal"]!, title: r["title"]!, messages: r["messages"]!, empty_messages: r["empty_messages"] ?? 0, branches: r["branches"] ?? 0,
          ...(typeof r["created_at"] === "string" ? { created_at: r["created_at"] } : {}), ...(typeof r["updated_at"] === "string" ? { updated_at: r["updated_at"] } : {}), status, ...(facts[i]!.error ? { error: facts[i]!.error! } : {}) } as JsonObject; });
        const visible = rows.filter(r => (!statuses.length || statuses.includes(String(r["status"]))) && matches(String(r["title"]), needle));
        visible.sort((a, b) => (sort === "title" ? String(a["title"]).localeCompare(String(b["title"]), "und") : (Date.parse(String(a[String(time)])) || 0) - (Date.parse(String(b[String(time)])) || 0)) * (direction === "asc" ? 1 : -1) || Number(a["ordinal"]) - Number(b["ordinal"]));
        return this.#pages.create(`claude:${String(payload["container"])}`, visible, { container: payload["container"]!, source: { filename: c.source.path.slice(6), bytes: c.source.bytes, captured_at: (await fileCaptureTime(await resolveRecordPath(this.#root, c.source.path), c.source.sha256))?.at ?? null }, built_at: c.index.built_at!, total: rows.length, visible: visible.length, statuses: totals }, page.offset, page.limit);
      }),
      "archiver.parse.plan": guard(payload => this.#prepare(payload, false)),
      "archiver.parse.retarget": guard(async payload => {
        exact(payload, ["plans", "directory"]);
        const caps = strings(payload["plans"], RECORD_ARCHIVER_LIMITS.retainedPlans, false);
        const plans = caps.map(cap => { const plan = this.#plans.get(cap); if (!plan) throw new EngineCommandError("CLOUDIG_PARSE_PLAN_STALE", "Parse preview expired; confirm the range again"); return plan; });
        const directory = this.#output(payload); if (!directory) throw new TypeError("Choose an output directory");
        const directoryIdentity = await recordFileIdentity(this.#root, directory, "directory");
        // Change only destination, never rescan or expand the confirmed range.
        // No parsing, output writes or persistent preference changes occur here.
        for (const cap of caps) this.#plans.delete(cap);
        const updated = plans.map(plan => this.#remember({ ...plan, value: { ...plan.value, directory, directoryIdentity, relocateExisting: true } }, plan.sourcePath ? "ep" : "pp"));
        return { plans: updated, directory };
      }),
      "archiver.parse.items": guard(async payload => {
        exact(payload, ["plan", "offset", "limit"]); const page = pagination(payload), plan = typeof payload["plan"] === "string" ? this.#plans.get(payload["plan"]) : undefined;
        if (!plan) throw new EngineCommandError("CLOUDIG_PARSE_PLAN_STALE", "Parse preview expired; confirm the range again");
        return { ...page, total: plan.value.preview.length, items: planItems(plan.value, page.offset, page.limit) };
      }),
      "archiver.parse.commit": guard((payload, context) => this.#commit(payload, context, false)),
      "archiver.claude.extract.preview": guard(payload => this.#prepare(payload, true)),
      "archiver.claude.extract.commit": guard((payload, context) => this.#commit(payload, context, true))
    };
  }
  async close(): Promise<void> { await this.#indexRequests.close(); this.#pages.clear(); this.#selections.clear(); this.#plans.clear(); this.#sources.clear(); this.#sourceKeys.clear(); this.#containers.clear(); this.#containerKeys.clear(); }
}
