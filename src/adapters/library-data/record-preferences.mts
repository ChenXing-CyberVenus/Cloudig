import { lstat, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { validateRecord } from "../../core/records/index.mts";
import { frontName } from "../../core/records/front.mts";
import { RecordSchemaError } from "../../core/records/errors.mts";
import { createLibraryMetadata } from "../../app/library/record-defaults.mts";
import path from "node:path";
import { commitRecords, pendingRecordOperations, readStoredRecord, resolveRecordPath, withRecordSnapshot, RecordStoreConflict } from "../storage/record-store.mts";

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export type RecordLibraryInspection = Readonly<{ status: "missing" | "valid" | "settings_recovery" | "unsupported" | "unsafe" | "transaction_recovery"; revision?: string; operations?: string[]; reason?: string }>;

async function inspectLayout(root: string): Promise<RecordLibraryInspection> {
  try { const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: "unsafe", reason: "root_not_ordinary_directory" }; }
  catch (error) { if (missing(error)) return { status: "missing" }; throw error; }
  const entries = await readdir(root, { withFileTypes: true }), names = new Set(entries.map(n => n.name.toLowerCase()));
  if (names.has("cloudiglibrary.json")) return { status: "valid" };
  if (names.has("cloudig-library.json") || names.has("data") || names.has("library") && names.has("device")) return { status: "unsupported", reason: "old_development_library" };
  for (const entry of entries) if (["library", "cloudig"].includes(entry.name.toLowerCase())) {
    if (entry.isSymbolicLink()) return { status: "unsafe", reason: "nested_library_link" };
    if (!entry.isDirectory()) continue;
    const children = new Set((await readdir(path.join(root, entry.name))).map(n => n.toLowerCase()));
    if (children.has("cloudig-library.json") || children.has("cloudiglibrary.json") || children.has("data")) return { status: "unsupported", reason: "nested_library_preserved" };
  }
  // Existing identity/time/Mark facts must never be initialized a second time.
  // Empty shipped directories, or only imported Conversations, remain safe for
  // the first initialization, which does not rewrite Conversation files.
  for (const entry of entries) if (["identities", "contenttimes", "marks"].includes(entry.name.toLowerCase())) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) return { status: "unsafe", reason: "record_directory_not_ordinary" };
    if ((await readdir(path.join(root, entry.name))).length) return { status: "settings_recovery", reason: "library_settings_missing_preserve_nodes" };
  }
  return { status: "missing" };
}

/** Inspection never initializes, repairs or migrates an existing Library. */
export async function inspectRecordLibrary(root: string): Promise<RecordLibraryInspection> {
  const layout = await inspectLayout(root);
  if (layout.status === "unsupported" || layout.status === "unsafe") return layout;
  const operations = await pendingRecordOperations(root).catch(error => { if (missing(error) && layout.status === "missing") return [] as string[]; throw error; });
  if (operations.length) return { status: "transaction_recovery", operations };
  if (layout.status !== "valid") return layout;
  try { return await withRecordSnapshot(root, async () => ({ status: "valid" as const, revision: (await readStoredRecord(root, "library", "CloudigLibrary.json")).sha256 })); }
  catch (error) { if (error instanceof RecordStoreConflict) throw error; if (error instanceof RecordSchemaError) return { status: "unsupported", reason: "schema_update_required" }; if (error instanceof TypeError) return { status: "unsupported", reason: "invalid_or_unsupported_library_record" }; throw error; }
}

export async function requireFreshRecordLayout(root: string): Promise<void> {
  if ((await inspectLayout(root)).status !== "missing") throw new RecordStoreConflict("Existing Library or node files are preserved; full initialization requires a fresh record layout");
}

/** Explicit local recovery: write exactly the missing settings record. */
export async function restoreMissingLibrarySettings(root: string, timestamp: string) {
  if ((await inspectRecordLibrary(root)).status !== "settings_recovery") throw new RecordStoreConflict("Default settings can only be restored when the settings file is missing beside existing records");
  const result = await commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", value: createLibraryMetadata({ timestamp }), expected: null }], {
    preflight: async () => { if ((await inspectLayout(root)).status !== "settings_recovery") throw new RecordStoreConflict("Library layout changed before restoring settings; existing files were preserved"); }
  });
  return { maintenanceWarnings: result?.maintenanceWarnings ?? [] };
}

export async function readRecordPreferences(root: string) {
  return withRecordSnapshot(root, async () => {
    const library = await readStoredRecord(root, "library", "CloudigLibrary.json"), settings = library.value["settings"] as JsonObject;
    let userName: string | undefined, assistantName: string | undefined;
    try {
      const bindings = (await readStoredRecord(root, "identitySettings", "Identities/identity-settings.json")).value;
      for (const key of ["subject", "assistant"] as const) {
        try { const name = frontName((await readStoredRecord(root, "identity", `Identities/${bindings[key]}.json`)).value); if (key === "subject") userName = name; else assistantName = name; }
        catch (error) { if (error instanceof RecordSchemaError || !missing(error) && !(error instanceof TypeError)) throw error; }
      }
    } catch (error) { if (error instanceof RecordSchemaError || !missing(error) && !(error instanceof TypeError)) throw error; }
    return { library: library.value, revision: library.sha256, userName: userName ?? (settings["language"] === "en" ? "User" : "采云用户"), assistantName: assistantName ?? (settings["language"] === "en" ? "AI" : "智能伙伴") };
  });
}

/** UI patches merge only the three declared settings groups; defaults remain explicit. */
export async function commitRecordPreferences(root: string, input: Readonly<{ expected: string; patch: JsonObject; timestamp: string }>) {
  const prepared = await withRecordSnapshot(root, async () => {
    const current = await readStoredRecord(root, "library", "CloudigLibrary.json");
    if (current.sha256 !== input.expected) throw new RecordStoreConflict("Library settings changed; refresh before saving");
    const value = structuredClone(current.value), before = value["settings"] as JsonObject, settings = structuredClone(before);
    for (const [key, entry] of Object.entries(input.patch)) {
      if (!["language", "theme", "default_output_directory", "time_type", "sort", "one_click_parse"].includes(key)) throw new TypeError(`Not a persistent setting: ${key}`);
      if (["time_type", "sort", "one_click_parse"].includes(key)) {
        if (!isJsonObject(entry)) throw new TypeError(`Invalid settings group: ${key}`);
        settings[key] = { ...(settings[key] as JsonObject), ...structuredClone(entry) };
      } else settings[key] = entry;
    }
    if (settings["theme"] !== before["theme"]) settings["theme_guide_completed"] = true;
    value["settings"] = settings;
    const valid = validateRecord("library", value); if (!valid.ok) throw new TypeError(`Invalid Library settings: ${JSON.stringify(valid.issues)}`);
    if (settings["default_output_directory"] !== before["default_output_directory"]) {
      const directory = await resolveRecordPath(root, String(settings["default_output_directory"]));
      if (!(await lstat(directory)).isDirectory()) throw new TypeError("Default output must be an existing archive directory");
    }
    if (isDeepStrictEqual(settings, before)) return null;
    value["edited_at"] = input.timestamp;
    return { value, expected: current.sha256 };
  });
  if (!prepared) return { changed: false, maintenanceWarnings: [] as readonly string[] };
  const result = await commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", ...prepared }]);
  return { changed: true, maintenanceWarnings: result?.maintenanceWarnings ?? [] };
}
