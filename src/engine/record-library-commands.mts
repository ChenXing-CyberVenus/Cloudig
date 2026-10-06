import type { JsonObject } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { createRecordLibrary } from "../adapters/library-data/record-library.mts";
import { commitRecordPreferences, inspectRecordLibrary, readRecordPreferences, restoreMissingLibrarySettings } from "../adapters/library-data/record-preferences.mts";
import { pendingRecordOperations, recoverRecords, RecordStoreConflict } from "../adapters/storage/record-store.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";
import { pendingRecordRecycles } from "../adapters/library-data/record-recycle.mts";
import { singleWriterEndpoint } from "../adapters/storage/writer-lock.mts";
import path from "node:path";

export function localRecordAnchor(now = new Date()): Readonly<{ date: string; offset: string }> {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const minutes = -now.getTimezoneOffset(), absolute = Math.abs(minutes);
  return { date, offset: minutes === 0 ? "Z" : `${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}` };
}

function state(value: Awaited<ReturnType<typeof readRecordPreferences>>): JsonObject {
  const settings = value.library["settings"] as JsonObject, times = settings["time_type"] as JsonObject, sorts = settings["sort"] as JsonObject, parses = settings["one_click_parse"] as JsonObject;
  const parse = (v: JsonObject): JsonObject => ({ parse_unparsed: v["include_unparsed"]!, parse_selected: v["include_selected"]!, update_outdated: v["include_outdated"]!, preserve_previous: v["keep_previous"]! });
  return { revision: value.revision, theme: settings["theme"] === "Dawn" ? "dawn" : "star-night", language: settings["language"]!, theme_switched: settings["theme_guide_completed"]!, user_name: value.userName, assistant_name: value.assistantName,
    default_output_directory: settings["default_output_directory"]!, parse_ordinary: parse(parses["parser"] as JsonObject), parse_claude: parse(parses["claude_json"] as JsonObject),
    workflow_parser: { sort: sorts["parser"]! }, workflow_archiver: { sort: sorts["archiver"]!, time_field: times["archiver"]! }, workflow_reader: { sort: sorts["reader"]!, time_field: times["reader"]! },
    workflow_claude: { sort: sorts["claude_json"]!, time_field: times["claude_json"] === "conversation_created_at" ? "created_at" : "updated_at" } };
}

function empty(payload: JsonObject): void { if (Object.keys(payload).length) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "This Library command expects no fields"); }
function preferencePatch(payload: JsonObject): JsonObject {
  const allowed = ["expected_revision", "theme", "language", "default_output_directory", "parse_ordinary", "parse_claude", "workflow_parser", "workflow_archiver", "workflow_reader", "workflow_claude"];
  if (Object.keys(payload).some(k => !allowed.includes(k)) || typeof payload["expected_revision"] !== "string" || !/^[a-f0-9]{64}$/u.test(payload["expected_revision"])) throw new TypeError("Invalid preference token or fields");
  const patch: JsonObject = {}, times: JsonObject = {}, sorts: JsonObject = {}, parses: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "expected_revision") continue;
    if (key === "theme") { if (value !== "dawn" && value !== "star-night") throw new TypeError("Invalid preference theme"); patch[key] = value === "dawn" ? "Dawn" : "StarNight"; }
    else if (key === "language" || key === "default_output_directory") patch[key] = value;
    else if (key.startsWith("parse_")) {
      if (!isJsonObject(value) || Object.keys(value).sort().join("|") !== "parse_selected|parse_unparsed|preserve_previous|update_outdated" || Object.values(value).some(v => typeof v !== "boolean")) throw new TypeError("Invalid parse settings");
      parses[key === "parse_ordinary" ? "parser" : "claude_json"] = { include_unparsed: value["parse_unparsed"]!, include_selected: value["parse_selected"]!, include_outdated: value["update_outdated"]!, keep_previous: value["preserve_previous"]! };
    } else {
      const page = key.slice("workflow_".length), fields = page === "parser" ? "sort" : "sort|time_field";
      if (!isJsonObject(value) || Object.keys(value).sort().join("|") !== fields) throw new TypeError("Invalid page sorting settings");
      sorts[page === "claude" ? "claude_json" : page] = value["sort"]!;
      if (page !== "parser") {
        if (page === "claude") { if (value["time_field"] !== "created_at" && value["time_field"] !== "updated_at") throw new TypeError("Invalid Claude time field"); times["claude_json"] = `conversation_${value["time_field"]}`; }
        else times[page] = value["time_field"]!;
      }
    }
  }
  if (Object.keys(times).length) patch["time_type"] = times;
  if (Object.keys(sorts).length) patch["sort"] = sorts;
  if (Object.keys(parses).length) patch["one_click_parse"] = parses;
  return patch;
}

/** Existing UI command names, new record authority; no persisted revision or legacy format conversion. */
export class RecordLibraryEngineCommands {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      // Native folder picker only: this command is deliberately not in the Web bridge allowlist.
      "library.move.endpoints": async payload => {
        if (Object.keys(payload).join() !== "target" || typeof payload["target"] !== "string" || !path.isAbsolute(payload["target"])) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Move endpoints require the native selected absolute directory");
        return { source: await singleWriterEndpoint(this.root), target: await singleWriterEndpoint(payload["target"]) };
      },
      "library.create": async payload => {
        empty(payload); if ((await inspectRecordLibrary(this.root)).status !== "missing") throw new EngineCommandError("CLOUDIG_LIBRARY_ALREADY_EXISTS", "Existing Library or node files are preserved; creation requires an empty authority");
        await createRecordLibrary(this.root, { timestamp: new Date().toISOString(), anchor: localRecordAnchor() });
        return { status: "created", revision: (await readRecordPreferences(this.root)).revision };
      },
      "library.startup.recover": async payload => {
        empty(payload); const status = await inspectRecordLibrary(this.root); if (status.status !== "valid") return { ...status };
        const recycle = await pendingRecordRecycles(this.root); return { ...status, ...(recycle.items.length || recycle.issues.length ? { pending_recycles: recycle.items, recycle_issues: recycle.issues } : {}) };
      },
      "library.settings.recover": async payload => {
        empty(payload);
        try {
          const restored = await restoreMissingLibrarySettings(this.root, new Date().toISOString());
          return { ...await inspectRecordLibrary(this.root), ...(restored.maintenanceWarnings.length ? { maintenance_warnings: [...restored.maintenanceWarnings] } : {}) };
        } catch (error) {
          if (error instanceof RecordStoreConflict) throw new EngineCommandError("CLOUDIG_LIBRARY_RECOVERY_CONFLICT", error.message);
          throw error;
        }
      },
      "library.recovery.commit": async (payload, context) => {
        if (Object.keys(payload).sort().join("|") !== "action|operation" || typeof payload["operation"] !== "string" || !["complete", "rollback"].includes(String(payload["action"]))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Recovery needs one pending operation and an explicit action");
        if (!(await pendingRecordOperations(this.root)).includes(payload["operation"])) throw new EngineCommandError("CLOUDIG_TRANSACTION_RECOVERY_FAILED", "This operation is no longer pending");
        context.signal.throwIfAborted(); await recoverRecords(this.root, payload["operation"], payload["action"] as "complete" | "rollback");
        return { ...await inspectRecordLibrary(this.root) };
      },
      "library.preferences.query": async payload => { empty(payload); return state(await readRecordPreferences(this.root)); },
      "library.preferences.commit": async payload => {
        let patch: JsonObject;
        try { patch = preferencePatch(payload); } catch (error) { throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", error instanceof Error ? error.message : "Invalid preferences"); }
        try {
          const result = await commitRecordPreferences(this.root, { expected: String(payload["expected_revision"]), patch, timestamp: new Date().toISOString() });
          return { status: result.changed ? "committed" : "unchanged", ...state(await readRecordPreferences(this.root)), ...(result.maintenanceWarnings.length ? { maintenance_warnings: [...result.maintenanceWarnings] } : {}) };
        } catch (error) {
          if (error instanceof RecordStoreConflict) throw new EngineCommandError(error.operationId ? "CLOUDIG_TRANSACTION_RECOVERY_FAILED" : "CLOUDIG_LIBRARY_REVISION_CONFLICT", error.message);
          if (error instanceof TypeError) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", error.message);
          throw error;
        }
      }
    };
  }
}
