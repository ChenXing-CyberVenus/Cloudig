import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, rmdir, statfs, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import cachePolicy from "../../core/contracts/machine/cache-policy.json" with { type: "json" };
import { validateCachePolicySchema } from "../../core/contracts/schema-registry.mts";
import { acquireSingleWriter, requireNoPendingMove } from "./writer-lock.mts";

const SESSION = /^s_[0-9a-f]{32}$/u;
const SCHEMA = "cloudig/cache-session/1.1.0";
const LEGACY_SCHEMA = "cloudig/cache-session/1.0.0";
if (!validateCachePolicySchema(cachePolicy).ok) throw new TypeError("Invalid internal cache policy");

export async function checkCacheSpace(root: string): Promise<void> {
  const info = await statfs(root, { bigint: true });
  if (info.bavail * info.bsize < BigInt(cachePolicy.disk_reserve_bytes)) {
    const error = new Error("采云缓存所在磁盘的可用空间不足，请释放空间后重试；没有删除或截断档案。");
    Object.assign(error, { code: "ENOSPC" });
    throw error;
  }
}

function endpoint(root: string): string {
  const key = createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex");
  return `\\\\.\\pipe\\Cloudig-Cache-${key}`;
}

async function lease(directory: string, storedEndpoint?: string): Promise<Server | undefined> {
  if (process.platform !== "win32") throw new Error("Cache ownership currently requires Windows named pipes");
  const server = createServer(socket => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(storedEndpoint ?? endpoint(directory), () => { server.removeAllListeners("error"); resolve(); });
    });
    server.unref();
    return server;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return undefined;
    throw error;
  }
}

function release(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// Only this new, explicitly owned subtree is eligible. No legacy Runtime,
// indexes, backups or user assets enter this cleanup path.
async function plainTree(directory: string): Promise<boolean> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return false;
    if (entry.isDirectory() && !await plainTree(path.join(directory, entry.name))) return false;
  }
  return true;
}

async function removeOwnedSession(directory: string): Promise<void> {
  // Keep the ownership evidence until every possibly locked payload is gone.
  // A failed cleanup can therefore be retried at the next startup.
  for (const entry of await readdir(directory)) {
    if (entry !== "owner.json") await rm(path.join(directory, entry), { recursive: true });
  }
  await unlink(path.join(directory, "owner.json"));
  await rmdir(directory);
}

export type RuntimeCacheSession = Readonly<{ root: string; ensure(): Promise<void>; close(): Promise<void> }>;

export async function createRuntimeCacheSession(cacheRoot: string, libraryRoot: string): Promise<RuntimeCacheSession> {
  if (!path.isAbsolute(cacheRoot) || !path.isAbsolute(libraryRoot)) throw new TypeError("Cache and Library roots must be explicit absolute paths");
  const creation = await acquireSingleWriter(libraryRoot, { waitForLocal: true });
  try { return await createSessionUnderLibraryLease(cacheRoot, libraryRoot); }
  finally { await creation.release(); }
}

async function createSessionUnderLibraryLease(cacheRoot: string, libraryRoot: string): Promise<RuntimeCacheSession> {
  if (!path.isAbsolute(cacheRoot) || !path.isAbsolute(libraryRoot)) throw new TypeError("Cache and Library roots must be explicit absolute paths");
  await requireNoPendingMove(libraryRoot);
  const libraryIdentity = await lstat(libraryRoot, { bigint: true });
  if (!libraryIdentity.isDirectory() || libraryIdentity.isSymbolicLink()) throw new TypeError("Library root must be an existing ordinary directory");
  const requireSameLibrary = async () => {
    const current = await lstat(libraryRoot, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== libraryIdentity.dev || current.ino !== libraryIdentity.ino)
      throw Object.assign(new Error("资料库目录已移动或被替换，请重新打开采云；没有在旧位置创建缓存。"), { code: "CLOUDIG_LIBRARY_ROOT_CHANGED" });
  };
  const root = path.resolve(cacheRoot);
  const library = path.resolve(libraryRoot).toLowerCase();
  const flatCache = root.toLowerCase() === path.join(library, "cache");
  if (!flatCache && (root.toLowerCase() === library || root.toLowerCase().startsWith(`${library}${path.sep}`) || library.startsWith(`${root.toLowerCase()}${path.sep}`))) throw new TypeError("Cache must be the Library cache directory or a separate legacy runtime root");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new TypeError("Cache root cannot be a reparse point");
  await checkCacheSpace(root);
  const key = createHash("sha256").update(path.resolve(libraryRoot).toLowerCase()).digest("hex").slice(0, 32);
  // One immutable Library per Engine owner already provides isolation. Do not
  // nest another hash directory: long native WebView paths have a real limit.
  const parent = path.join(root, "Engine");
  for (const directory of [parent]) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("Cache subtree cannot be a reparse point");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await mkdir(directory).catch(async error => { if (error.code !== "EEXIST" || (await lstat(directory)).isSymbolicLink()) throw error; });
    }
  }
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION.test(entry.name) || entry.isSymbolicLink()) continue;
    const directory = path.join(parent, entry.name);
    let marker: { schema?: string; session?: string; library_key?: string; lease_endpoint?: string };
    try { marker = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")); } catch { continue; }
    if (!marker || typeof marker !== "object" || Array.isArray(marker) || marker.session !== entry.name) continue;
    const storedLease = marker.schema === SCHEMA && typeof marker.lease_endpoint === "string" && /^\\\\\.\\pipe\\Cloudig-Cache-[a-f0-9]{64}$/u.test(marker.lease_endpoint) ? marker.lease_endpoint : undefined;
    if (!storedLease && !(marker.schema === LEGACY_SCHEMA && marker.library_key === key)) continue;
    const guard = await lease(directory, storedLease);
    if (!guard) continue;
    try {
      const current = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
      if (JSON.stringify(current) === JSON.stringify(marker) && await plainTree(directory)) await removeOwnedSession(directory);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(String(error.code))) {
        // Unknown/incomplete ownership is kept, never inferred from age or PID.
      }
    } finally { await release(guard); }
  }
  const token = `s_${randomBytes(16).toString("hex")}`;
  const directory = path.join(parent, token);
  const guard = await lease(directory);
  if (!guard) throw new Error("Cache owner token collision");
  try {
    await mkdir(directory);
    await writeFile(path.join(directory, "owner.json"), JSON.stringify({ schema: SCHEMA, session: token, library_key: key, lease_endpoint: endpoint(directory) }), { flag: "wx" });
    await mkdir(path.join(directory, "Views"));
  } catch (error) { await release(guard); throw error; }
  let closed = false;
  let ensureTail: Promise<void> = Promise.resolve();
  return {
    root: directory,
    ensure() {
      const pending = ensureTail.then(async () => {
      if (closed) throw new Error("Cache session is closed");
      await requireSameLibrary();
      await requireNoPendingMove(libraryRoot);
      try {
        const marker = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
        if (marker?.schema !== SCHEMA || marker.session !== token) throw new Error("Cache ownership changed");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        const recreation = await acquireSingleWriter(libraryRoot, { waitForLocal: true });
        try {
          await requireSameLibrary();
          await mkdir(path.join(directory, "Views"), { recursive: true });
          await writeFile(path.join(directory, "owner.json"), JSON.stringify({ schema: SCHEMA, session: token, library_key: key, lease_endpoint: endpoint(directory) }), { flag: "wx" });
        } finally { await recreation.release(); }
      }
      });
      ensureTail = pending.catch(() => undefined);
      return pending;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        const marker = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
        if (marker?.schema === SCHEMA && marker.session === token && await plainTree(directory)) await removeOwnedSession(directory);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      } finally { await release(guard); }
    }
  };
}
