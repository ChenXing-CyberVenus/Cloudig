import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  unlink,
  utimes
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { normalizeLibraryDocument } from "../../library/compat.mjs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import {
  acquireFileTransactionLock,
  atomicWriteText,
  pathExists,
  recoverFileSnapshotTransactions,
  sha256File
} from "../../parser/src/atomic.mjs";

const require = createRequire(import.meta.url);
const libraryCore = require("../../library/core.js");

const MOVE_FORMAT = "cloudig/library-move/0.1.0";
const PLAN_FORMAT = "cloudig/library-move-plan/0.1.0";
const MARKER_DIRECTORY = "LibraryMove";
const MARKER_FILE = "current.json";
const CONTROL_PREFIXES = Object.freeze([
  "Data/Transactions",
  `Data/${MARKER_DIRECTORY}`
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const SPACE_RESERVE_BYTES = 16 * 1024 * 1024;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAborted(signal, label = "Cloudig library move") {
  if (!signal?.aborted) return;
  const error = new Error(`${label} was cancelled`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function normalizeRoot(value, label) {
  const original = String(value || "").trim();
  if (!original) throw new TypeError(`${label} is required`);
  const resolved = path.resolve(original);
  return resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/u, "");
}

function samePath(left, right) {
  const a = normalizeRoot(left, "path");
  const b = normalizeRoot(right, "path");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathContains(parent, candidate) {
  const relative = path.relative(normalizeRoot(parent, "parent path"), normalizeRoot(candidate, "candidate path"));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizedRelative(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isControlPath(relative) {
  const normalized = normalizedRelative(relative);
  return CONTROL_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function markerDirectory(root) {
  return path.join(root, "Data", MARKER_DIRECTORY);
}

function markerPath(root) {
  return path.join(markerDirectory(root), MARKER_FILE);
}

function stagingPath(plan) {
  const parent = path.dirname(plan.target_root);
  const base = path.basename(plan.target_root) || "Library";
  return path.join(parent, `.${base}.cloudig-move-${plan.plan_id.slice(0, 16)}.tmp`);
}

async function plainDirectory(target, label) {
  const information = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!information) return null;
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_UNSAFE_PATH", `${label} must be a regular directory`);
  }
  return information;
}

async function assertEmptyTarget(target) {
  const information = await plainDirectory(target, "Cloudig library move target");
  if (!information) return { existed: false };
  const entries = await readdir(target);
  if (entries.length) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_TARGET_NOT_EMPTY", "Cloudig can move its library only into an empty directory");
  }
  return { existed: true };
}

async function validateLibraryDocument(root) {
  const libraryFile = path.join(root, libraryCore.FILE_NAME);
  const document = JSON.parse(await readFile(libraryFile, "utf8"));
  normalizeLibraryDocument(document);
}

function progress(onProgress, phase, bytesDone, bytesTotal, itemsDone) {
  if (typeof onProgress !== "function") return;
  return onProgress({ phase, bytesDone, bytesTotal, itemsDone });
}

async function enumerateTree(root, {
  signal = null,
  onProgress = null,
  phase = "move_hash",
  requireLibrary = true
} = {}) {
  const resolved = normalizeRoot(root, "library root");
  const rootInfo = await plainDirectory(resolved, "Cloudig library root");
  if (!rootInfo) throw codedError("CLOUDIG_LIBRARY_MOVE_SOURCE_MISSING", "The current Cloudig library no longer exists");
  if (requireLibrary) await validateLibraryDocument(resolved);

  const directories = [];
  const discovered = [];
  const pending = [{ absolute: resolved, relative: "" }];
  while (pending.length) {
    throwIfAborted(signal, "Library move scan");
    const current = pending.shift();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = normalizedRelative(current.relative ? `${current.relative}/${entry.name}` : entry.name);
      if (isControlPath(relative)) continue;
      const absolute = path.join(current.absolute, entry.name);
      const information = await lstat(absolute);
      if (information.isSymbolicLink()) {
        throw codedError("CLOUDIG_LIBRARY_MOVE_UNSAFE_PATH", `Cloudig library contains a symbolic link or junction: ${relative}`);
      }
      if (information.isDirectory()) {
        directories.push(relative);
        pending.push({ absolute, relative });
        continue;
      }
      if (!information.isFile()) {
        throw codedError("CLOUDIG_LIBRARY_MOVE_UNSAFE_PATH", `Cloudig library contains a non-regular file: ${relative}`);
      }
      discovered.push({
        absolute,
        path: relative,
        size_bytes: information.size,
        mtime_ms: information.mtimeMs,
        atime_ms: information.atimeMs,
        mode: information.mode,
        identity: {
          dev: information.dev,
          ino: information.ino,
          size: information.size,
          mtime_ms: information.mtimeMs,
          ctime_ms: information.ctimeMs
        }
      });
    }
  }
  directories.sort(compareText);
  discovered.sort((left, right) => compareText(left.path, right.path));
  const totalBytes = discovered.reduce((sum, entry) => sum + entry.size_bytes, 0);
  let completedBytes = 0;
  const files = [];
  await progress(onProgress, phase, 0, totalBytes, 0);
  for (const [index, entry] of discovered.entries()) {
    throwIfAborted(signal, "Library move hash");
    const base = completedBytes;
    const sha256 = await sha256File(entry.absolute, {
      signal,
      onProgress: (done) => progress(onProgress, phase, base + done, totalBytes, index)
    });
    const after = await lstat(entry.absolute).catch(() => null);
    if (!after?.isFile()
      || after.dev !== entry.identity.dev
      || after.ino !== entry.identity.ino
      || after.size !== entry.identity.size
      || after.mtimeMs !== entry.identity.mtime_ms
      || after.ctimeMs !== entry.identity.ctime_ms) {
      throw codedError("CLOUDIG_LIBRARY_MOVE_SOURCE_CHANGED", `Cloudig library changed while it was being inspected: ${entry.path}`);
    }
    completedBytes += entry.size_bytes;
    files.push({
      path: entry.path,
      size_bytes: entry.size_bytes,
      sha256,
      mtime_ms: entry.mtime_ms,
      atime_ms: entry.atime_ms,
      mode: entry.mode
    });
    await progress(onProgress, phase, completedBytes, totalBytes, index + 1);
  }
  return Object.freeze({ directories, files, total_bytes: totalBytes, total_files: files.length });
}

function manifestIdentity(manifest) {
  return createHash("sha256").update(JSON.stringify({
    directories: manifest.directories,
    files: manifest.files.map((entry) => ({
      path: entry.path,
      size_bytes: entry.size_bytes,
      sha256: entry.sha256
    }))
  })).digest("hex");
}

function publicPlanBody(value) {
  return {
    format: PLAN_FORMAT,
    source_root: normalizeRoot(value.source_root, "library move source"),
    target_root: normalizeRoot(value.target_root, "library move target"),
    strategy: value.strategy === "rename" ? "rename" : "copy_verify",
    target_existed: value.target_existed === true,
    manifest_sha256: String(value.manifest_sha256 || "").toLowerCase(),
    total_bytes: Number(value.total_bytes),
    total_files: Number(value.total_files),
    total_directories: Number(value.total_directories)
  };
}

function planIdentity(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function normalizePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Cloudig library move plan is required");
  const body = publicPlanBody(value);
  if (!SHA256.test(body.manifest_sha256)
    || !Number.isSafeInteger(body.total_bytes) || body.total_bytes < 0
    || !Number.isSafeInteger(body.total_files) || body.total_files < 1
    || !Number.isSafeInteger(body.total_directories) || body.total_directories < 1) {
    throw new TypeError("Cloudig library move plan is invalid");
  }
  const planId = String(value.plan_id || "").toLowerCase();
  if (!SHA256.test(planId) || planIdentity(body) !== planId) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_PLAN_CHANGED", "Cloudig library move plan no longer matches its confirmed source and target");
  }
  return Object.freeze({ ...body, plan_id: planId });
}

async function deviceInformation(source, target) {
  const sourceInfo = await stat(source);
  const targetParent = path.dirname(target);
  const parentInfo = await plainDirectory(targetParent, "Cloudig library move target parent");
  if (!parentInfo) throw codedError("CLOUDIG_LIBRARY_MOVE_TARGET_MISSING", "The selected target parent no longer exists");
  return { sameDevice: sourceInfo.dev === parentInfo.dev, targetParent };
}

async function availableBytes(targetParent) {
  try {
    const information = await statfs(targetParent, { bigint: true });
    const bytes = information.bavail * information.bsize;
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
  } catch {
    return null;
  }
}

function assertRootRelationship(source, target) {
  if (source === path.parse(source).root || target === path.parse(target).root) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_UNSAFE_PATH", "Cloudig will not use a filesystem volume root as a movable library");
  }
  if (samePath(source, target)) throw codedError("CLOUDIG_LIBRARY_MOVE_SAME_PATH", "The new Cloudig library location is the current location");
  if (pathContains(source, target) || pathContains(target, source)) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_NESTED_PATH", "Cloudig cannot move a library into itself or one of its parent directories");
  }
}

export async function planLibraryMove(sourceRoot, targetRoot, {
  signal = null,
  onProgress = null,
  strategyOverride = "",
  availableBytesOverride = null
} = {}) {
  const source = normalizeRoot(sourceRoot, "library move source");
  const target = normalizeRoot(targetRoot, "library move target");
  assertRootRelationship(source, target);
  const targetState = await assertEmptyTarget(target);
  const devices = await deviceInformation(source, target);
  const manifest = await enumerateTree(source, { signal, onProgress, phase: "move_hash" });
  const strategy = strategyOverride === "copy_verify"
    ? "copy_verify"
    : strategyOverride === "rename"
      ? "rename"
      : devices.sameDevice ? "rename" : "copy_verify";
  const freeBytes = availableBytesOverride === null
    ? await availableBytes(devices.targetParent)
    : Number(availableBytesOverride);
  if (freeBytes !== null && (!Number.isSafeInteger(freeBytes) || freeBytes < 0)) {
    throw new TypeError("availableBytesOverride must be null or a non-negative safe integer");
  }
  const requiredBytes = strategy === "copy_verify" ? manifest.total_bytes + SPACE_RESERVE_BYTES : 0;
  if (freeBytes !== null && freeBytes < requiredBytes) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_SPACE", "The selected location does not have enough free space for a verified Cloudig library copy");
  }
  const body = publicPlanBody({
    source_root: source,
    target_root: target,
    strategy,
    target_existed: targetState.existed,
    manifest_sha256: manifestIdentity(manifest),
    total_bytes: manifest.total_bytes,
    total_files: manifest.total_files,
    total_directories: manifest.directories.length
  });
  return Object.freeze({
    ...body,
    plan_id: planIdentity(body),
    available_bytes: freeBytes,
    required_bytes: requiredBytes
  });
}

function markerDocument(plan, manifest, phase = "preparing") {
  return {
    format: MOVE_FORMAT,
    plan,
    phase,
    manifest: {
      directories: manifest.directories,
      files: manifest.files
    }
  };
}

function normalizeMarker(value, expectedPlan) {
  if (!value || typeof value !== "object" || value.format !== MOVE_FORMAT || !value.manifest) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_RECOVERY_CONFLICT", "Cloudig found an invalid library move recovery marker");
  }
  const plan = normalizePlan(value.plan);
  if (expectedPlan && plan.plan_id !== expectedPlan.plan_id) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_RECOVERY_CONFLICT", "Cloudig found a recovery marker for a different library move");
  }
  const directories = Array.isArray(value.manifest.directories)
    ? value.manifest.directories.map(normalizedRelative).filter(Boolean).sort(compareText)
    : [];
  const files = Array.isArray(value.manifest.files) ? value.manifest.files.map((entry) => ({
    path: normalizedRelative(entry?.path),
    size_bytes: Number(entry?.size_bytes),
    sha256: String(entry?.sha256 || "").toLowerCase(),
    mtime_ms: Number(entry?.mtime_ms),
    atime_ms: Number(entry?.atime_ms),
    mode: Number(entry?.mode)
  })) : [];
  if (!files.length || files.some((entry) => !entry.path || !SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0)) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_RECOVERY_CONFLICT", "Cloudig library move recovery manifest is incomplete");
  }
  const manifest = { directories, files, total_files: files.length, total_bytes: files.reduce((sum, entry) => sum + entry.size_bytes, 0) };
  if (manifestIdentity(manifest) !== plan.manifest_sha256
    || manifest.total_files !== plan.total_files
    || manifest.total_bytes !== plan.total_bytes
    || directories.length !== plan.total_directories) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_RECOVERY_CONFLICT", "Cloudig library move recovery manifest no longer matches its plan");
  }
  return Object.freeze({ plan, phase: String(value.phase || "preparing"), manifest });
}

async function writeMarker(root, plan, manifest, phase) {
  await mkdir(markerDirectory(root), { recursive: true });
  await atomicWriteText(markerPath(root), `${JSON.stringify(markerDocument(plan, manifest, phase), null, 2)}\n`);
}

async function readMarker(root, expectedPlan) {
  try {
    return normalizeMarker(JSON.parse(await readFile(markerPath(root), "utf8")), expectedPlan);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeMarker(root) {
  await unlink(markerPath(root)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await rmdir(markerDirectory(root)).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
  });
}

async function assertManifest(root, expected, options = {}) {
  const actual = await enumerateTree(root, options);
  if (actual.total_files !== expected.total_files
    || actual.total_bytes !== expected.total_bytes
    || actual.directories.length !== expected.directories.length
    || manifestIdentity(actual) !== manifestIdentity(expected)) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_VERIFY_FAILED", "Cloudig library changed or failed verification during the move");
  }
  return actual;
}

async function sourceIsSafeCleanupSubset(root, expected, options = {}) {
  if (!await pathExists(root)) return true;
  const actual = await enumerateTree(root, { ...options, requireLibrary: false });
  const expectedDirectories = new Set(expected.directories);
  const expectedFiles = new Map(expected.files.map((entry) => [entry.path, entry]));
  return actual.directories.every((entry) => expectedDirectories.has(entry))
    && actual.files.every((entry) => {
      const known = expectedFiles.get(entry.path);
      return known && known.size_bytes === entry.size_bytes && known.sha256 === entry.sha256;
    });
}

async function copyManifest(source, target, manifest, { signal = null, onProgress = null } = {}) {
  await mkdir(target, { recursive: false });
  for (const relative of manifest.directories) {
    throwIfAborted(signal, "Library directory copy");
    await mkdir(path.join(target, ...relative.split("/")), { recursive: true });
  }
  let completedBytes = 0;
  await progress(onProgress, "move_copy", 0, manifest.total_bytes, 0);
  for (const [index, entry] of manifest.files.entries()) {
    throwIfAborted(signal, "Library file copy");
    const from = path.join(source, ...entry.path.split("/"));
    const to = path.join(target, ...entry.path.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    let fileBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        fileBytes += chunk.length;
        void progress(onProgress, "move_copy", completedBytes + fileBytes, manifest.total_bytes, index);
        callback(null, chunk);
      }
    });
    await pipeline(
      createReadStream(from),
      meter,
      createWriteStream(to, { flags: "wx" }),
      ...(signal ? [{ signal }] : [])
    );
    await chmod(to, entry.mode).catch(() => {});
    await utimes(to, new Date(entry.atime_ms), new Date(entry.mtime_ms)).catch(() => {});
    completedBytes += entry.size_bytes;
    await progress(onProgress, "move_copy", completedBytes, manifest.total_bytes, index + 1);
  }
}

async function removeEmptyTargetForCommit(plan) {
  if (!await pathExists(plan.target_root)) return;
  await assertEmptyTarget(plan.target_root);
  await rmdir(plan.target_root);
}

async function restoreSelectedEmptyTarget(plan) {
  if (!plan.target_existed || await pathExists(plan.target_root)) return;
  await mkdir(plan.target_root, { recursive: false }).catch(() => {});
}

async function checkpoint(onCheckpoint, plan) {
  if (typeof onCheckpoint !== "function") {
    throw codedError("CLOUDIG_LIBRARY_MOVE_COMMIT_REQUIRED", "Cloudig library move requires its desktop host to commit the new library pointer");
  }
  await onCheckpoint({
    phase: "move_target_ready",
    plan_id: plan.plan_id,
    source_root: plan.source_root,
    target_root: plan.target_root,
    strategy: plan.strategy,
    bytes_done: plan.total_bytes,
    bytes_total: plan.total_bytes,
    items_done: plan.total_files
  });
}

async function finalizeCommittedMove(plan, manifest, { onProgress = null } = {}) {
  await writeMarker(plan.target_root, plan, manifest, "target_current");
  let cleanupPending = false;
  if (await pathExists(plan.source_root)) {
    const safe = await sourceIsSafeCleanupSubset(plan.source_root, manifest, {
      onProgress,
      phase: "move_cleanup_verify"
    });
    if (safe) {
      try { await rm(plan.source_root, { recursive: true, force: false }); }
      catch { cleanupPending = true; }
    } else cleanupPending = true;
  }
  if (!cleanupPending) await removeMarker(plan.target_root);
  return cleanupPending;
}

export async function executeLibraryMove(confirmedPlan, {
  signal = null,
  onProgress = null,
  onCheckpoint = null
} = {}) {
  const plan = normalizePlan(confirmedPlan);
  assertRootRelationship(plan.source_root, plan.target_root);
  const lock = await acquireFileTransactionLock(plan.source_root, { signal });
  let targetReady = false;
  let hostCommitted = false;
  let stage = "";
  try {
    await recoverFileSnapshotTransactions(plan.source_root, { lock, signal });
    await assertEmptyTarget(plan.target_root);
    const manifest = await enumerateTree(plan.source_root, { signal, onProgress, phase: "move_source_verify" });
    if (manifestIdentity(manifest) !== plan.manifest_sha256
      || manifest.total_bytes !== plan.total_bytes
      || manifest.total_files !== plan.total_files
      || manifest.directories.length !== plan.total_directories) {
      throw codedError("CLOUDIG_LIBRARY_MOVE_PLAN_CHANGED", "Cloudig library changed after the move plan was confirmed");
    }
    await writeMarker(plan.source_root, plan, manifest, "preparing");
    if (plan.strategy === "rename") {
      await removeEmptyTargetForCommit(plan);
      try {
        await rename(plan.source_root, plan.target_root);
      } catch (error) {
        await restoreSelectedEmptyTarget(plan);
        throw error;
      }
      targetReady = true;
    } else {
      stage = stagingPath(plan);
      if (await pathExists(stage)) {
        throw codedError("CLOUDIG_LIBRARY_MOVE_RECOVERY_CONFLICT", "Cloudig found a previous staging directory for this library move");
      }
      await copyManifest(plan.source_root, stage, manifest, { signal, onProgress });
      await writeMarker(stage, plan, manifest, "target_ready");
      await assertManifest(stage, manifest, { signal, onProgress, phase: "move_target_verify" });
      await assertManifest(plan.source_root, manifest, { signal, onProgress, phase: "move_source_final" });
      await removeEmptyTargetForCommit(plan);
      try {
        await rename(stage, plan.target_root);
        stage = "";
      } catch (error) {
        await restoreSelectedEmptyTarget(plan);
        throw error;
      }
      targetReady = true;
    }
    await assertManifest(plan.target_root, manifest, { signal, onProgress, phase: "move_target_verify" });
    await writeMarker(plan.target_root, plan, manifest, "target_ready");
    await checkpoint(onCheckpoint, plan);
    hostCommitted = true;
    const cleanupPending = await finalizeCommittedMove(plan, manifest, { onProgress });
    return Object.freeze({
      ok: true,
      mode: "library-move",
      plan_id: plan.plan_id,
      root: plan.target_root,
      source_root: plan.source_root,
      target_root: plan.target_root,
      strategy: plan.strategy,
      total_bytes: plan.total_bytes,
      total_files: plan.total_files,
      cleanup_pending: cleanupPending
    });
  } catch (error) {
    if (!hostCommitted && targetReady) {
      if (plan.strategy === "rename" && await pathExists(plan.target_root) && !await pathExists(plan.source_root)) {
        try {
          await rename(plan.target_root, plan.source_root);
          targetReady = false;
          await restoreSelectedEmptyTarget(plan);
        } catch { /* the recovery marker and desktop pending record preserve the exact continuation */ }
      } else if (plan.strategy === "copy_verify" && await pathExists(plan.target_root)) {
        try {
          const marker = await readMarker(plan.target_root, plan);
          if (marker) {
            await rm(plan.target_root, { recursive: true, force: false });
            targetReady = false;
            await restoreSelectedEmptyTarget(plan);
          }
        } catch { /* preserve a target that no longer proves it is our generated copy */ }
      }
    }
    throw error;
  } finally {
    if (stage && await pathExists(stage)) await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (!hostCommitted && await pathExists(plan.source_root)) await removeMarker(plan.source_root).catch(() => {});
    await lock.release();
    if (plan.strategy === "rename" && await pathExists(plan.target_root)) {
      const staleOwner = path.join(plan.target_root, "Data", "Transactions", ".active-owner.json");
      await unlink(staleOwner).catch(() => {});
    }
  }
}

export async function recoverLibraryMove(pendingPlan, {
  signal = null,
  onProgress = null,
  onCheckpoint = null
} = {}) {
  const plan = normalizePlan(pendingPlan);
  const sourceExists = await pathExists(plan.source_root);
  const targetExists = await pathExists(plan.target_root);
  const lockRoot = sourceExists ? plan.source_root : targetExists ? plan.target_root : "";
  if (!lockRoot) {
    throw codedError("CLOUDIG_LIBRARY_MOVE_RECOVERY_CONFLICT", "Both Cloudig library move locations are missing");
  }
  const lock = await acquireFileTransactionLock(lockRoot, { signal });
  try {
    const sourceMarker = sourceExists ? await readMarker(plan.source_root, plan) : null;
    const targetMarker = targetExists ? await readMarker(plan.target_root, plan) : null;
    const stage = stagingPath(plan);

    if (targetMarker) {
      await assertManifest(plan.target_root, targetMarker.manifest, { signal, onProgress, phase: "move_target_verify" });
      await checkpoint(onCheckpoint, plan);
      const cleanupPending = await finalizeCommittedMove(plan, targetMarker.manifest, { onProgress });
      if (await pathExists(stage)) await rm(stage, { recursive: true, force: true });
      return Object.freeze({
        ok: true,
        mode: "library-move-recovery",
        status: cleanupPending ? "cleanup_pending" : "completed",
        root: plan.target_root,
        plan_id: plan.plan_id,
        cleanup_pending: cleanupPending
      });
    }

    if (sourceMarker && !targetExists) {
      if (await pathExists(stage)) await rm(stage, { recursive: true, force: true });
      await removeMarker(plan.source_root);
      await restoreSelectedEmptyTarget(plan);
      return Object.freeze({
        ok: true,
        mode: "library-move-recovery",
        status: "rolled_back",
        root: plan.source_root,
        plan_id: plan.plan_id,
        cleanup_pending: false
      });
    }

    if (sourceExists && !targetMarker) {
      if (targetExists) await assertEmptyTarget(plan.target_root);
      if (await pathExists(stage)) await rm(stage, { recursive: true, force: true });
      await removeMarker(plan.source_root).catch(() => {});
      return Object.freeze({
        ok: true,
        mode: "library-move-recovery",
        status: "source_current",
        root: plan.source_root,
        plan_id: plan.plan_id,
        cleanup_pending: false
      });
    }

    if (!sourceExists && targetExists && !targetMarker) {
      const manifest = await enumerateTree(plan.target_root, { signal, onProgress, phase: "move_target_verify" });
      if (manifestIdentity(manifest) === plan.manifest_sha256
        && manifest.total_bytes === plan.total_bytes
        && manifest.total_files === plan.total_files
        && manifest.directories.length === plan.total_directories) {
        return Object.freeze({
          ok: true,
          mode: "library-move-recovery",
          status: "completed",
          root: plan.target_root,
          plan_id: plan.plan_id,
          cleanup_pending: false
        });
      }
    }

    throw codedError(
      "CLOUDIG_LIBRARY_MOVE_RECOVERY_CONFLICT",
      "Cloudig could not prove which library copy is authoritative; both locations were preserved"
    );
  } finally {
    await lock.release();
    if (!sourceExists && targetExists) {
      await unlink(path.join(plan.target_root, "Data", "Transactions", ".active-owner.json")).catch(() => {});
    }
  }
}
