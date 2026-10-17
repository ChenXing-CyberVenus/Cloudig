import { readFile, lstat } from "node:fs/promises";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { validateSystemLog } from "../../core/contracts/index.mts";
import { parseRecordJson } from "../../core/records/index.mts";
import { resolveRecordPath, withRecordSnapshot } from "../storage/record-store.mts";
import { writeRecordInternalJson } from "../storage/record-projection.mts";

const FILE = "appdata/logs/parser-errors.json", SCHEMA = "cloudig/parser-error-index/1.0.0";
type UnitErrors = { path: string; locator?: string; recorded_at: string; errors: readonly JsonObject[] };
const key = (u: { path: string; locator?: string }) => JSON.stringify([u.path, u.locator ?? null]);
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
function projection(units: readonly UnitErrors[]): JsonObject {
  const files = new Map<string, JsonObject>();
  for (const u of units) {
    const prior = files.get(u.path);
    if (!prior) files.set(u.path, { path: u.path, recorded_at: u.recorded_at, errors: [...u.errors] });
    else { (prior["errors"] as JsonObject[]).push(...u.errors); if (u.recorded_at > String(prior["recorded_at"])) prior["recorded_at"] = u.recorded_at; }
  }
  return { schema: "cloudig/system-log/1.0.0", files: [...files.values()].sort((a, b) => String(a["path"]).localeCompare(String(b["path"]), "en")) };
}
async function load(root: string): Promise<UnitErrors[]> {
  try {
    const raw = parseRecordJson(await readFile(await resolveRecordPath(root, FILE), "utf8"));
    if (!isJsonObject(raw) || raw["schema"] !== SCHEMA || !Array.isArray(raw["units"])) return [];
    const units = raw["units"] as unknown as UnitErrors[];
    if (units.some(u => !u || typeof u.path !== "string" || u.locator !== undefined && typeof u.locator !== "string" || !Array.isArray(u.errors) || !u.errors.length) || !validateSystemLog(projection(units)).ok) return [];
    return units;
  } catch (e) { if (missing(e) || e instanceof SyntaxError || e instanceof TypeError) return []; throw e; }
}
async function save(root: string, units: readonly UnitErrors[]) {
  if (!validateSystemLog(projection(units)).ok) throw new TypeError("Parser error projection is invalid");
  await writeRecordInternalJson(root, FILE, JSON.stringify({ schema: SCHEMA, units }, null, 2) + "\n");
}

/** Partial Claude selections replace only their own current errors, never another record's. */
export async function updateRecordSystemLog(root: string, updates: readonly UnitErrors[]): Promise<void> {
  if (!updates.length) return;
  await withRecordSnapshot(root, async () => {
    const before = await load(root), units = new Map(before.map(u => [key(u), u]));
    for (const u of updates) { if (u.errors.length) units.set(key(u), { ...u, recorded_at: new Date(u.recorded_at).toISOString() }); else units.delete(key(u)); }
    const next = [...units.values()].sort((a, b) => key(a).localeCompare(key(b), "en"));
    if (JSON.stringify(before) !== JSON.stringify(next)) await save(root, next);
  });
}

export async function readRecordSystemLog(root: string): Promise<JsonObject> {
  return withRecordSnapshot(root, async () => {
    const before = await load(root), next: UnitErrors[] = [], absent = new Set<string>();
    for (const u of before) {
      if (absent.has(u.path)) continue;
      try { await lstat(await resolveRecordPath(root, u.path)); }
      catch (e) { if (missing(e)) { absent.add(u.path); continue; } }
      next.push(u);
    }
    if (next.length !== before.length) await save(root, next);
    return projection(next);
  });
}
export async function removeRecordSystemLogGroups(root: string, paths: ReadonlySet<string>, expected?: readonly JsonObject[]): Promise<{ status: "removed" | "unchanged" | "conflict" }> {
  return withRecordSnapshot(root, async () => {
    const before = await load(root), current = projection(before)["files"] as JsonObject[];
    if (expected && (expected.length !== paths.size || expected.some(group => !paths.has(String(group["path"])) || !current.some(actual => JSON.stringify(actual) === JSON.stringify(group))))) return { status: "conflict" };
    const after = before.filter(u => !paths.has(u.path)); if (after.length === before.length) return { status: "unchanged" };
    await save(root, after); return { status: "removed" };
  });
}
