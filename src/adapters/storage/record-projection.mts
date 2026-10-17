import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { resolveRecordPath } from "./record-store.mts";
import { uuidV7 } from "../../core/records/ids.mts";

/** Caller owns the Library lock. Rebuildable indexes do not evict user recovery groups. */
export async function writeRecordProjection(root: string, relative: string, text: string, options: Readonly<{rebuildable?:boolean}> = {}): Promise<void> {
  if (!relative.startsWith("appdata/indexes/") || !relative.endsWith(".json")) throw new TypeError("Projection path must be an appdata JSON index");
  if (options.rebuildable && !relative.startsWith("appdata/indexes/platform-json/")) throw new TypeError("Only the disposable platform-container index opts out of durable publication");
  return publishInternalJson(root, relative, text, !options.rebuildable);
}

/** Small non-business program state; caller owns the Library lock. Not disposable cache. */
export async function writeRecordInternalJson(root: string, relative: string, text: string): Promise<void> {
  return publishInternalJson(root, relative, text, true);
}

async function publishInternalJson(root: string, relative: string, text: string, durable:boolean): Promise<void> {
  if (!/^appdata\/(?:indexes\/|logs\/|parse-failures\/).+\.json$/u.test(relative)) throw new TypeError("Unexpected internal JSON path");
  const target = await resolveRecordPath(root, relative); await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.projection-${uuidV7()}.next`), handle = await open(temporary, "wx", 0o600);
  let owned: { dev: bigint; ino: bigint } | undefined, installed = false;
  try {
    try { owned = await handle.stat({ bigint: true }); await handle.writeFile(text); if (durable) await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target); installed = true;
  } finally {
    if (!installed && owned) try { const current = await lstat(temporary, { bigint: true }); if (current.dev === owned.dev && current.ino === owned.ino) await unlink(temporary); }
    catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
  }
}
