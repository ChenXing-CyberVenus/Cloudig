import { lstat, readFile } from "node:fs/promises";

import { serializeSystemLog, validateSystemLog } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { observeAuxiliarySnapshot, writeAuxiliarySnapshot } from "../storage/auxiliary.mts";
import { resolveManagedPath } from "../storage/path.mts";

const SYSTEM_LOG = "Data/Logs/system-log.json";

export function isMissingSystemLogFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function removeSystemLogGroups(libraryRoot: string, selected: readonly JsonObject[]): Promise<{ status: "written" | "unchanged" | "conflict"; removed: number }> {
  if (selected.length === 0) return { status: "unchanged", removed: 0 };
  const expected = await observeAuxiliarySnapshot(libraryRoot, SYSTEM_LOG);
  const current = await readSystemLog(libraryRoot);
  const groups = Array.isArray(current["files"]) ? current["files"].filter(isJsonObject) : [];
  const keys = new Map(selected.map(group => [String(group["path"]), JSON.stringify(group)]));
  for (const group of groups) {
    const key = keys.get(String(group["path"]));
    if (key && key !== JSON.stringify(group)) return { status: "conflict", removed: 0 };
  }
  const remaining = groups.filter(group => !keys.has(String(group["path"])));
  const removed = groups.length - remaining.length;
  if (removed === 0) return { status: "unchanged", removed: 0 };
  const status = await writeAuxiliarySnapshot(libraryRoot, SYSTEM_LOG, Buffer.from(serializeSystemLog({ schema: "cloudig/system-log/1.0.0", files: remaining }), "utf8"), expected);
  return { status, removed: status === "written" ? removed : 0 };
}

export async function pruneMissingSystemLogGroups(libraryRoot: string, paths?: readonly string[]): Promise<void> {
  // Opening/refreshing the log checks only its recorded paths, not the Library
  // tree. Inaccessible, unsafe or changed files are not proof of deletion.
  const current = await readSystemLog(libraryRoot);
  const selected = paths ? new Set(paths) : undefined;
  const missing: JsonObject[] = [];
  for (const group of Array.isArray(current["files"]) ? current["files"].filter(isJsonObject) : []) {
    const file = String(group["path"]);
    if (selected && !selected.has(file)) continue;
    try { await lstat(await resolveManagedPath(libraryRoot, file)); }
    catch (error) { if (isMissingSystemLogFile(error)) missing.push(group); }
  }
  await removeSystemLogGroups(libraryRoot, missing);
}

export type SystemLogUpdate = Readonly<{
  path: string;
  outcome: "errors" | "success_no_errors" | "cancelled";
  recordedAt?: string;
  errors?: readonly JsonObject[];
}>;

export async function readSystemLog(libraryRoot: string): Promise<JsonObject> {
  const filePath = await resolveManagedPath(libraryRoot, SYSTEM_LOG);
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    const validation = validateSystemLog(value);
    return validation.ok ? validation.value : { schema: "cloudig/system-log/1.0.0", files: [] };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { schema: "cloudig/system-log/1.0.0", files: [] };
    if (error instanceof SyntaxError) return { schema: "cloudig/system-log/1.0.0", files: [] };
    throw error;
  }
}

export async function updateSystemLog(
  libraryRoot: string,
  updates: readonly SystemLogUpdate[]
): Promise<"written" | "conflict"> {
  const expected = await observeAuxiliarySnapshot(libraryRoot, SYSTEM_LOG);
  const current = await readSystemLog(libraryRoot);
  const files = new Map<string, JsonObject>();
  const currentFiles = current["files"];
  if (Array.isArray(currentFiles)) {
    for (const group of currentFiles) if (group && typeof group === "object" && !Array.isArray(group) && typeof group["path"] === "string") files.set(group["path"], structuredClone(group));
  }
  for (const update of updates) {
    if (update.outcome === "cancelled") continue;
    if (update.outcome === "success_no_errors") {
      files.delete(update.path);
      continue;
    }
    if (!update.recordedAt || !update.errors || update.errors.length === 0) throw new TypeError("Error updates require recordedAt and nonempty errors");
    files.set(update.path, {
      path: update.path,
      recorded_at: update.recordedAt,
      errors: update.errors.map((error) => structuredClone(error))
    });
  }
  const next: JsonObject = {
    schema: "cloudig/system-log/1.0.0",
    files: [...files.values()].sort((left, right) => String(left["path"]).localeCompare(String(right["path"]), "en"))
  };
  const validation = validateSystemLog(next);
  if (!validation.ok) throw new TypeError(`System Log update is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  return writeAuxiliarySnapshot(libraryRoot, SYSTEM_LOG, Buffer.from(serializeSystemLog(next), "utf8"), expected);
}
