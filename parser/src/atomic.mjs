import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  utimes
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const SNAPSHOT_TRANSACTION_FORMAT = "cloudig/file-snapshot-transaction/0.1.0";
const SNAPSHOT_TRANSACTION_DIRECTORY = "Transactions";
const SNAPSHOT_JOURNAL_NAME = "journal.json";
const LIBRARY_LOCK_OWNER_NAME = ".active-owner.json";
const LIBRARY_LOCK_BRAND = Symbol("cloudig-library-transaction-lock");
const LIBRARY_LOCK_CONNECTIONS = Symbol("cloudig-library-lock-connections");
const PROCESS_INSTANCE_TOKEN = randomUUID();
const DEFAULT_LIBRARY_LOCK_WAIT_MS = 30_000;
const DEFAULT_LIBRARY_LOCK_POLL_MS = 40;

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal, operation) {
  if (!signal?.aborted) return;
  const error = new Error(`${operation} was cancelled`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function libraryLockIdentity(value) {
  const original = String(value);
  const identity = process.platform === "win32" ? original.toLowerCase() : original;
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function libraryLockEndpoint(lockIdentity) {
  const identity = libraryLockIdentity(lockIdentity);
  if (process.platform === "win32") return `\\\\.\\pipe\\cloudig-library-${identity}`;
  const port = 49_152 + (Number.parseInt(identity.slice(0, 8), 16) % 16_383);
  return Object.freeze({ host: "127.0.0.1", port, exclusive: true });
}

function waitForLibraryLock(milliseconds, signal) {
  throwIfAborted(signal, "Library transaction lock");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal, "Library transaction lock");
      } catch (error) {
        reject(error);
      }
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function listenForLibraryLock(endpoint) {
  const connections = new Set();
  const server = createServer((connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
    connection.destroy();
  });
  server[LIBRARY_LOCK_CONNECTIONS] = connections;
  return new Promise((resolve, reject) => {
    function cleanup() {
      server.off("error", onError);
      server.off("listening", onListening);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onListening() {
      cleanup();
      resolve(server);
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function closeLibraryLockServer(server) {
  if (!server?.listening) return Promise.resolve();
  for (const connection of server[LIBRARY_LOCK_CONNECTIONS] || []) connection.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function processIdIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function recordedLibraryOwnerMayBeAlive(ownerPath) {
  let recorded;
  try {
    recorded = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
  if (recorded?.format !== "cloudig/library-transaction-owner/0.1.0"
    || typeof recorded.token !== "string" || !recorded.token
    || !Number.isSafeInteger(Number(recorded.pid)) || Number(recorded.pid) < 1) {
    return true;
  }
  if (Number(recorded.pid) === process.pid
    && recorded.process_instance === PROCESS_INSTANCE_TOKEN) {
    // The kernel endpoint was acquired before this check, so no live lock from
    // this process instance exists. A matching record is therefore residue
    // from a token edit or failed diagnostic-file cleanup, not an active owner.
    return false;
  }
  // A reused PID is deliberately treated as live. False blocking is safer
  // than deleting or recovering a journal that may still have a live owner.
  return processIdIsAlive(Number(recorded.pid));
}

function assertLibraryTransactionLock(rootPath, lock) {
  if (!lock || lock[LIBRARY_LOCK_BRAND] !== true) {
    throw new TypeError("A Cloudig library transaction lock is required");
  }
  lock.assertOwned(rootPath);
  return lock;
}

export async function acquireFileTransactionLock(rootPath, {
  signal = null,
  waitTimeoutMs = DEFAULT_LIBRARY_LOCK_WAIT_MS,
  pollIntervalMs = DEFAULT_LIBRARY_LOCK_POLL_MS
} = {}) {
  const root = path.resolve(rootPath);
  const timeout = Number(waitTimeoutMs);
  const poll = Number(pollIntervalMs);
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new TypeError("waitTimeoutMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(poll) || poll < 1) throw new TypeError("pollIntervalMs must be a positive safe integer");
  throwIfAborted(signal, "Library transaction lock");
  const transactions = transactionRoot(root);
  await mkdir(transactions, { recursive: true });
  let canonicalTransactions = transactions;
  try { canonicalTransactions = await realpath(transactions); } catch { /* resolved path remains the conservative identity */ }
  let lockIdentity = canonicalTransactions;
  try {
    const information = await lstat(canonicalTransactions);
    if (information.isDirectory()
      && Number.isSafeInteger(Number(information.dev))
      && Number.isSafeInteger(Number(information.ino))
      && Number(information.ino) > 0) {
      lockIdentity = `device:${information.dev}:inode:${information.ino}`;
    }
  } catch { /* canonical path identity remains conservative */ }
  const endpoint = libraryLockEndpoint(lockIdentity);
  const deadline = Date.now() + timeout;
  const ownerPath = path.join(canonicalTransactions, LIBRARY_LOCK_OWNER_NAME);
  const token = randomUUID();
  let server = null;
  while (!server) {
    throwIfAborted(signal, "Library transaction lock");
    try {
      server = await listenForLibraryLock(endpoint);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (Date.now() >= deadline) {
        const locked = new Error("Cloudig library is busy in another live process");
        locked.code = "CLOUDIG_LIBRARY_LOCK_TIMEOUT";
        throw locked;
      }
      await waitForLibraryLock(Math.min(poll, Math.max(1, deadline - Date.now())), signal);
      continue;
    }
    const ownerPrecondition = await fingerprintFile(ownerPath, { signal });
    const ownerMayBeAlive = ownerPrecondition.exists
      && (ownerPrecondition.regularFile !== true
        || ownerPrecondition.stable === false
        || await recordedLibraryOwnerMayBeAlive(ownerPath));
    if (ownerMayBeAlive) {
      await closeLibraryLockServer(server);
      server = null;
      if (Date.now() >= deadline) {
        const locked = new Error("Cloudig library owner metadata still belongs to a live process");
        locked.code = "CLOUDIG_LIBRARY_LOCK_TIMEOUT";
        throw locked;
      }
      await waitForLibraryLock(Math.min(poll, Math.max(1, deadline - Date.now())), signal);
      continue;
    }
    const owner = {
      format: "cloudig/library-transaction-owner/0.1.0",
      token,
      pid: process.pid,
      process_instance: PROCESS_INSTANCE_TOKEN,
      acquired_at: new Date().toISOString(),
      endpoint: typeof endpoint === "string" ? endpoint : `${endpoint.host}:${endpoint.port}`
    };
    try {
      await atomicWriteText(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
        signal,
        precondition: ownerPrecondition
      });
    } catch (error) {
      await closeLibraryLockServer(server).catch(() => {});
      server = null;
      if (error?.code !== "CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT") throw error;
      if (Date.now() >= deadline) {
        const locked = new Error("Cloudig library owner metadata changed during lock acquisition");
        locked.code = "CLOUDIG_LIBRARY_LOCK_TIMEOUT";
        throw locked;
      }
      await waitForLibraryLock(Math.min(poll, Math.max(1, deadline - Date.now())), signal);
    }
  }
  let released = false;
  let lost = false;
  server.once("close", () => { lost = true; });

  const lock = {
    [LIBRARY_LOCK_BRAND]: true,
    root,
    token,
    assertOwned(candidateRoot = root) {
      const candidate = path.resolve(candidateRoot);
      const sameRoot = process.platform === "win32"
        ? candidate.toLowerCase() === root.toLowerCase()
        : candidate === root;
      if (!sameRoot || released || lost || !server.listening) {
        const error = new Error("Cloudig library transaction lock is no longer owned");
        error.code = "CLOUDIG_LIBRARY_LOCK_LOST";
        throw error;
      }
    },
    async release() {
      if (released) return;
      released = true;
      try {
        const recorded = JSON.parse(await readFile(ownerPath, "utf8"));
        if (recorded?.token === token) await unlink(ownerPath);
      } catch { /* diagnostic owner metadata never outranks releasing the kernel lock */ }
      finally {
        await closeLibraryLockServer(server);
      }
    }
  };
  return Object.freeze(lock);
}

export async function sha256File(filePath, { signal = null, onProgress = null } = {}) {
  const hash = createHash("sha256");
  let bytesDone = 0;
  throwIfAborted(signal, "File hashing");
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal, "File hashing");
    hash.update(chunk);
    bytesDone += chunk.length;
    if (typeof onProgress === "function") await onProgress(bytesDone);
    throwIfAborted(signal, "File hashing");
  }
  return hash.digest("hex");
}

function normalizeFileFingerprint(value, label = "file fingerprint") {
  if (!value || typeof value !== "object" || typeof value.exists !== "boolean") {
    throw new TypeError(`${label} is invalid`);
  }
  if (!value.exists) return Object.freeze({ exists: false });
  const sizeBytes = Number(value.sizeBytes);
  const sha256 = String(value.sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({ exists: true, sizeBytes, sha256 });
}

export async function fingerprintFile(target, { signal = null } = {}) {
  throwIfAborted(signal, "File fingerprint");
  let information;
  try {
    information = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!information) return Object.freeze({ exists: false });
  if (!information.isFile()) return Object.freeze({ exists: true, regularFile: false });
  const sha256 = await sha256File(target, { signal });
  let after;
  try {
    after = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  throwIfAborted(signal, "File fingerprint");
  if (!after?.isFile()
    || after.dev !== information.dev
    || after.ino !== information.ino
    || after.size !== information.size
    || after.mtimeMs !== information.mtimeMs
    || after.ctimeMs !== information.ctimeMs) {
    return Object.freeze({ exists: true, regularFile: true, stable: false });
  }
  return Object.freeze({ exists: true, regularFile: true, stable: true, sizeBytes: information.size, sha256 });
}

function fileFingerprintMatches(current, expected) {
  return current.exists === expected.exists
    && (!current.exists || (
      current.regularFile === true
      && current.stable !== false
      && current.sizeBytes === expected.sizeBytes
      && current.sha256 === expected.sha256
    ));
}

export async function assertFileFingerprint(target, expectedValue, {
  signal = null,
  operation = "File optimistic-concurrency precondition"
} = {}) {
  const expected = normalizeFileFingerprint(expectedValue, `${operation} fingerprint`);
  const current = await fingerprintFile(target, { signal });
  if (!fileFingerprintMatches(current, expected)) {
    const error = new Error(`${operation} conflict: ${path.basename(target)}`);
    error.code = "CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT";
    throw error;
  }
  return current;
}

export async function atomicWriteText(target, contents, {
  signal = null,
  precondition = null
} = {}) {
  const serialized = String(contents);
  throwIfAborted(signal, "Atomic text write");
  await mkdir(path.dirname(target), { recursive: true });
  if (precondition) await assertFileFingerprint(target, precondition, { signal });
  const existed = await pathExists(target);
  if (existed && (signal
    ? await readFile(target, { encoding: "utf8", signal })
    : await readFile(target, "utf8")) === serialized) {
    throwIfAborted(signal, "Atomic text write");
    return "unchanged";
  }

  const token = `${process.pid}-${randomUUID()}`;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.cloudig-new-${token}`);
  const previous = path.join(path.dirname(target), `.${path.basename(target)}.cloudig-old-${token}`);
  const handle = await open(temporary, "wx");
  try {
    throwIfAborted(signal, "Atomic text write");
    await handle.writeFile(serialized, { encoding: "utf8" });
    throwIfAborted(signal, "Atomic text write");
    await handle.sync();
    throwIfAborted(signal, "Atomic text write");
  } finally {
    await handle.close();
  }
  try {
    if (precondition) await assertFileFingerprint(target, precondition, { signal });
    throwIfAborted(signal, "Atomic text write");
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!existed || !["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      await rename(target, previous);
      try {
        await rename(temporary, target);
      } catch (replacementError) {
        try { await rename(previous, target); } catch { /* leave both recovery files for manual inspection */ }
        throw replacementError;
      }
      try { await unlink(previous); } catch { /* replacement is already authoritative; stale sidecar is non-fatal */ }
    }
    throwIfAborted(signal, "Atomic text write");
    return existed ? "replaced" : "created";
  } finally {
    try { await unlink(temporary); } catch { /* already committed or never created */ }
  }
}

function transactionRoot(rootPath) {
  return path.join(path.resolve(rootPath), "Data", SNAPSHOT_TRANSACTION_DIRECTORY);
}

function safeRootRelative(rootPath, target, label) {
  const root = path.resolve(rootPath);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
    throw new TypeError(`${label} must stay below the Cloudig library root`);
  }
  return relative;
}

function resolveJournalRelative(rootPath, relative, label) {
  const value = String(relative || "").replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[a-z]:/iu.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`${label} is not a safe relative path`);
  }
  const root = path.resolve(rootPath);
  const absolute = path.resolve(root, ...value.split("/"));
  if (safeRootRelative(root, absolute, label) !== value) {
    throw new TypeError(`${label} does not resolve to its recorded path`);
  }
  return absolute;
}

async function durableCopy(source, target, { signal = null } = {}) {
  throwIfAborted(signal, "Transaction snapshot copy");
  try {
    if (signal) {
      await pipeline(
        createReadStream(source),
        createWriteStream(target, { flags: "wx" }),
        { signal }
      );
    } else {
      await copyFile(source, target);
    }
  } catch (error) {
    try { await unlink(target); } catch { /* absent or retained by an external actor */ }
    throw error;
  }
  throwIfAborted(signal, "Transaction snapshot copy");
  const handle = await open(target, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  throwIfAborted(signal, "Transaction snapshot copy");
}

function recoveryConflict(message) {
  const error = new Error(message);
  error.code = "CLOUDIG_TRANSACTION_RECOVERY_CONFLICT";
  return error;
}

async function restoreCapturedTarget(target, displaced) {
  if (!await pathExists(displaced)) return;
  if (!await pathExists(target)) {
    try { await rename(displaced, target); } catch { /* preserved beside target for manual recovery */ }
  }
}

async function replaceFromSnapshot(target, snapshot, metadata, expected) {
  await mkdir(path.dirname(target), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.cloudig-restore-${token}`);
  const displaced = path.join(path.dirname(target), `.${path.basename(target)}.cloudig-displaced-${token}`);
  await durableCopy(snapshot, temporary);
  let displacedExisting = false;
  try {
    const current = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!current?.isFile()) {
      throw recoveryConflict(`Cloudig transaction target changed before snapshot restore: ${path.basename(target)}`);
    }
    await rename(target, displaced);
    displacedExisting = true;
    const captured = await fingerprintFile(displaced);
    if (!fileFingerprintMatches(captured, normalizeFileFingerprint(expected, "snapshot restore expected fingerprint"))) {
      await restoreCapturedTarget(target, displaced);
      throw recoveryConflict(`Cloudig transaction target changed while snapshot restore was being applied: ${path.basename(target)}`);
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await restoreCapturedTarget(target, displaced);
      throw error;
    }
    if (Number.isInteger(metadata?.mode)) await chmod(target, metadata.mode);
    if (Number.isFinite(metadata?.atime_ms) && Number.isFinite(metadata?.mtime_ms)) {
      await utimes(target, new Date(metadata.atime_ms), new Date(metadata.mtime_ms));
    }
    if (displacedExisting) await unlink(displaced);
  } finally {
    try { await unlink(temporary); } catch { /* already installed or never created */ }
  }
}

async function removeExpectedSnapshotTarget(target, expected) {
  const token = `${process.pid}-${randomUUID()}`;
  const displaced = path.join(path.dirname(target), `.${path.basename(target)}.cloudig-displaced-${token}`);
  const current = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current?.isFile()) {
    throw recoveryConflict(`Cloudig transaction target changed before rollback removal: ${path.basename(target)}`);
  }
  await rename(target, displaced);
  const captured = await fingerprintFile(displaced);
  if (!fileFingerprintMatches(captured, normalizeFileFingerprint(expected, "rollback removal expected fingerprint"))) {
    await restoreCapturedTarget(target, displaced);
    throw recoveryConflict(`Cloudig transaction target changed while rollback removal was being applied: ${path.basename(target)}`);
  }
  await unlink(displaced);
}

function normalizeSnapshotJournal(value) {
  if (!value || typeof value !== "object" || value.format !== SNAPSHOT_TRANSACTION_FORMAT) {
    throw new TypeError("Unsupported Cloudig file snapshot transaction journal");
  }
  if (!new Set(["prepared", "mutating", "committed"]).has(value.phase)) {
    throw new TypeError("Cloudig file snapshot transaction has an invalid phase");
  }
  if (!Array.isArray(value.targets) || !Array.isArray(value.cleanup_paths)) {
    throw new TypeError("Cloudig file snapshot transaction journal is incomplete");
  }
  const paths = new Set();
  const targets = value.targets.map((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.existed !== "boolean") {
      throw new TypeError(`Cloudig file snapshot target ${index} is invalid`);
    }
    if (paths.has(entry.path)) throw new TypeError(`Duplicate Cloudig file snapshot target: ${entry.path}`);
    paths.add(entry.path);
    if (entry.existed && typeof entry.backup !== "string") {
      throw new TypeError(`Cloudig file snapshot target ${entry.path} has no backup`);
    }
    if (typeof entry.expected_exists !== "boolean") {
      throw new TypeError(`Cloudig file snapshot target ${entry.path} has no expected state`);
    }
    if (entry.existed && (!Number.isSafeInteger(Number(entry.size_bytes))
      || Number(entry.size_bytes) < 0 || !/^[0-9a-f]{64}$/u.test(String(entry.sha256 || "")))) {
      throw new TypeError(`Cloudig file snapshot target ${entry.path} has an invalid prior fingerprint`);
    }
    if (entry.expected_exists && (!Number.isSafeInteger(Number(entry.expected_size_bytes))
      || Number(entry.expected_size_bytes) < 0 || !/^[0-9a-f]{64}$/u.test(String(entry.expected_sha256 || "")))) {
      throw new TypeError(`Cloudig file snapshot target ${entry.path} has an invalid expected fingerprint`);
    }
    return {
      path: entry.path,
      existed: entry.existed,
      ...(entry.existed ? {
        backup: entry.backup,
        size_bytes: Number(entry.size_bytes),
        sha256: String(entry.sha256),
        atime_ms: Number(entry.atime_ms),
        mtime_ms: Number(entry.mtime_ms),
        mode: Number(entry.mode)
      } : {}),
      expected_exists: entry.expected_exists,
      ...(entry.expected_exists ? {
        expected_size_bytes: Number(entry.expected_size_bytes),
        expected_sha256: String(entry.expected_sha256)
      } : {})
    };
  });
  const cleanupPaths = [...new Set(value.cleanup_paths.map((entry) => String(entry || "")))];
  return { ...value, targets, cleanup_paths: cleanupPaths };
}

async function writeSnapshotJournal(transactionDirectory, journal, { signal = null } = {}) {
  await atomicWriteText(
    path.join(transactionDirectory, SNAPSHOT_JOURNAL_NAME),
    `${JSON.stringify(normalizeSnapshotJournal(journal), null, 2)}\n`,
    { signal }
  );
}

async function currentSnapshotTargetFingerprint(root, entry, { signal = null } = {}) {
  throwIfAborted(signal, "Transaction target fingerprint");
  const target = resolveJournalRelative(root, entry.path, "snapshot target");
  let information;
  try {
    information = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!information) return { exists: false };
  if (!information.isFile()) return { exists: true, regular_file: false };
  const sha256 = await sha256File(target, { signal });
  let after;
  try {
    after = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!after?.isFile()
    || after.dev !== information.dev
    || after.ino !== information.ino
    || after.size !== information.size
    || after.mtimeMs !== information.mtimeMs
    || after.ctimeMs !== information.ctimeMs) {
    return { exists: true, regular_file: true, stable: false };
  }
  return {
    exists: true,
    regular_file: true,
    stable: true,
    size_bytes: information.size,
    sha256,
    identity: Object.freeze({
      dev: information.dev,
      ino: information.ino,
      size: information.size,
      mtime_ms: information.mtimeMs,
      ctime_ms: information.ctimeMs
    })
  };
}

function matchesExpectedSnapshotTarget(current, entry) {
  return current.exists === entry.expected_exists
    && (!current.exists || (
      current.regular_file === true
      && current.stable !== false
      && current.size_bytes === entry.expected_size_bytes
      && current.sha256 === entry.expected_sha256
    ));
}

function matchesBeforeSnapshotTarget(current, entry) {
  return current.exists === entry.existed
    && (!current.exists || (
      current.regular_file === true
      && current.stable !== false
      && current.size_bytes === entry.size_bytes
      && current.sha256 === entry.sha256
    ));
}

async function assertSnapshotTargetsBefore(rootPath, journal, { signal = null, onlyPath = "" } = {}) {
  const root = path.resolve(rootPath);
  const relativeOnly = onlyPath ? safeRootRelative(root, onlyPath, "transaction precondition target") : "";
  const entries = relativeOnly
    ? journal.targets.filter((entry) => entry.path === relativeOnly)
    : journal.targets;
  if (relativeOnly && entries.length !== 1) throw new TypeError("Transaction precondition target is not registered");
  const mismatches = [];
  for (const entry of entries) {
    const current = await currentSnapshotTargetFingerprint(root, entry, { signal });
    if (!matchesBeforeSnapshotTarget(current, entry)) {
      mismatches.push(`${entry.path}:${current.regular_file === false ? "non-file" : "unexpected-fingerprint"}`);
    }
  }
  if (mismatches.length) {
    const error = new Error(`Cloudig transaction optimistic-concurrency conflict: ${mismatches.join(", ")}`);
    error.code = "CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT";
    throw error;
  }
}

async function assertSnapshotTargetsExpected(rootPath, journal, { signal = null } = {}) {
  const root = path.resolve(rootPath);
  const mismatches = [];
  const fences = [];
  for (const entry of journal.targets) {
    const current = await currentSnapshotTargetFingerprint(root, entry, { signal });
    if (!matchesExpectedSnapshotTarget(current, entry)) {
      mismatches.push(`${entry.path}:${current.regular_file === false ? "non-file" : "unexpected-fingerprint"}`);
    } else {
      fences.push({ entry, identity: current.identity || null });
    }
  }
  if (mismatches.length) {
    const error = new Error(`Cloudig transaction targets do not match their expected committed state: ${mismatches.join(", ")}`);
    error.code = "CLOUDIG_TRANSACTION_COMMIT_MISMATCH";
    throw error;
  }
  // Hashing a later large target must not leave an earlier small target with a
  // long unchecked window. This metadata fence is intentionally a second,
  // quick pass after every content hash; the library writer lock separately
  // excludes another Cloudig process for the whole transaction.
  for (const { entry, identity } of fences) {
    throwIfAborted(signal, "Transaction commit identity fence");
    const target = resolveJournalRelative(root, entry.path, "snapshot target");
    let current;
    try {
      current = await lstat(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!entry.expected_exists) {
      if (!current) continue;
    } else if (identity && current?.isFile()
      && current.dev === identity.dev
      && current.ino === identity.ino
      && current.size === identity.size
      && current.mtimeMs === identity.mtime_ms
      && current.ctimeMs === identity.ctime_ms) {
      continue;
    }
    if (!identity || !current?.isFile()
      || current.dev !== identity.dev
      || current.ino !== identity.ino
      || current.size !== identity.size
      || current.mtimeMs !== identity.mtime_ms
      || current.ctimeMs !== identity.ctime_ms) {
      const error = new Error(`Cloudig transaction target changed during final commit verification: ${entry.path}`);
      error.code = "CLOUDIG_TRANSACTION_COMMIT_MISMATCH";
      throw error;
    }
  }
}

function invalidSnapshotPhase(operation, expected, actual) {
  const error = new Error(`File snapshot transaction ${operation} requires phase ${expected}; current phase is ${actual}`);
  error.code = "CLOUDIG_TRANSACTION_INVALID_PHASE";
  return error;
}

async function restoreSnapshotTransaction(rootPath, transactionDirectory, journal) {
  const root = path.resolve(rootPath);
  const conflicts = new Set();
  // Validate every required snapshot before changing any live target, so a
  // missing later backup cannot leave a partially restored library.
  for (const entry of journal.targets) {
    if (!entry.existed) continue;
    const snapshot = resolveJournalRelative(transactionDirectory, entry.backup, "snapshot backup");
    let information;
    try {
      information = await lstat(snapshot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Cloudig transaction backup is missing or incomplete: ${entry.path}`, { cause: error });
      }
      throw error;
    }
    if (!information.isFile() || information.size !== entry.size_bytes
      || await sha256File(snapshot) !== entry.sha256) {
      throw new Error(`Cloudig transaction backup is missing or incomplete: ${entry.path}`);
    }
  }
  for (const entry of [...journal.targets].reverse()) {
    // Classification immediately precedes this target's action; a long hash
    // of another target can no longer make this decision stale.
    const current = await currentSnapshotTargetFingerprint(root, entry);
    const matchesBefore = matchesBeforeSnapshotTarget(current, entry);
    const matchesExpected = matchesExpectedSnapshotTarget(current, entry);
    if (matchesBefore) continue;
    const target = resolveJournalRelative(root, entry.path, "snapshot target");
    if (!matchesExpected) {
      conflicts.add(`${entry.path}:unknown-fingerprint`);
      continue;
    }
    try {
      if (entry.existed) {
        const snapshot = resolveJournalRelative(transactionDirectory, entry.backup, "snapshot backup");
        await replaceFromSnapshot(target, snapshot, entry, {
          exists: true,
          sizeBytes: entry.expected_size_bytes,
          sha256: entry.expected_sha256
        });
      } else {
        await removeExpectedSnapshotTarget(target, {
          exists: true,
          sizeBytes: entry.expected_size_bytes,
          sha256: entry.expected_sha256
        });
      }
    } catch (error) {
      if (error?.code !== "CLOUDIG_TRANSACTION_RECOVERY_CONFLICT") throw error;
      conflicts.add(`${entry.path}:unknown-fingerprint`);
    }
  }
  for (const relative of journal.cleanup_paths) {
    const cleanup = resolveJournalRelative(root, relative, "transaction cleanup path");
    await rm(cleanup, { recursive: true, force: true });
  }
  if (conflicts.size) {
    const error = new Error(
      `Cloudig transaction recovery conflict; safe targets were rolled back and unknown targets were preserved: ${[...conflicts].join(", ")}`
    );
    error.code = "CLOUDIG_TRANSACTION_RECOVERY_CONFLICT";
    error.conflicts = Object.freeze([...conflicts]);
    throw error;
  }
  await rm(transactionDirectory, { recursive: true, force: true });
}

async function recoverFileSnapshotTransactionsLocked(rootPath) {
  const root = path.resolve(rootPath);
  const directory = transactionRoot(root);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ recovered: 0, finalized: 0, discarded: 0 });
    throw error;
  }
  let recovered = 0;
  let finalized = 0;
  let discarded = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!entry.isDirectory() || !/^tx-[0-9]+-[0-9a-f-]+$/iu.test(entry.name)) continue;
    const current = path.join(directory, entry.name);
    const journalPath = path.join(current, SNAPSHOT_JOURNAL_NAME);
    let journal;
    try {
      journal = normalizeSnapshotJournal(JSON.parse(await readFile(journalPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") {
        await rm(current, { recursive: true, force: true });
        discarded += 1;
        continue;
      }
      throw new Error(`Cannot recover Cloudig transaction ${entry.name}: ${error.message}`, { cause: error });
    }
    if (journal.phase === "committed") {
      await rm(current, { recursive: true, force: true });
      finalized += 1;
      continue;
    }
    await restoreSnapshotTransaction(root, current, journal);
    recovered += 1;
  }
  return Object.freeze({ recovered, finalized, discarded });
}

export async function recoverFileSnapshotTransactions(rootPath, {
  lock = null,
  signal = null,
  waitTimeoutMs = DEFAULT_LIBRARY_LOCK_WAIT_MS
} = {}) {
  const root = path.resolve(rootPath);
  const heldLock = lock
    ? assertLibraryTransactionLock(root, lock)
    : await acquireFileTransactionLock(root, { signal, waitTimeoutMs });
  try {
    return await recoverFileSnapshotTransactionsLocked(root);
  } finally {
    if (!lock) await heldLock.release();
  }
}

function normalizeTransactionTargetStates(root, values, label) {
  const result = new Map();
  for (const entry of values) {
    if (!entry || typeof entry !== "object") throw new TypeError(`${label} must be an object`);
    const relative = safeRootRelative(root, entry.target, label);
    if (result.has(relative)) throw new TypeError(`Duplicate ${label}: ${relative}`);
    const normalized = normalizeFileFingerprint({
      exists: entry.exists !== false,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256
    }, `${label} ${relative}`);
    result.set(relative, {
      exists: normalized.exists,
      ...(normalized.exists ? {
        size_bytes: normalized.sizeBytes,
        sha256: normalized.sha256
      } : {})
    });
  }
  return result;
}

export async function beginFileSnapshotTransaction(rootPath, targets, {
  cleanupPaths = [],
  expectedTargets = [],
  preconditionTargets = [],
  signal = null,
  lock = null,
  waitTimeoutMs = DEFAULT_LIBRARY_LOCK_WAIT_MS
} = {}) {
  const root = path.resolve(rootPath);
  if (!Array.isArray(targets) || !targets.length) throw new TypeError("A file snapshot transaction needs at least one target");
  if (!Array.isArray(cleanupPaths)) throw new TypeError("cleanupPaths must be an array");
  if (!Array.isArray(expectedTargets)) throw new TypeError("expectedTargets must be an array");
  if (!Array.isArray(preconditionTargets)) throw new TypeError("preconditionTargets must be an array");
  throwIfAborted(signal, "File snapshot transaction");
  const heldLock = lock
    ? assertLibraryTransactionLock(root, lock)
    : await acquireFileTransactionLock(root, { signal, waitTimeoutMs });
  const ownsLock = !lock;
  let lockReleased = false;
  async function releaseOwnedLock() {
    if (!ownsLock || lockReleased) return;
    lockReleased = true;
    await heldLock.release();
  }
  try {
  await recoverFileSnapshotTransactions(root, { lock: heldLock });
  throwIfAborted(signal, "File snapshot transaction recovery");
  const directory = transactionRoot(root);
  await mkdir(directory, { recursive: true });
  const normalizedTargets = [...new Set(targets.map((target) => safeRootRelative(root, target, "transaction target")))];
  const normalizedCleanup = [...new Set(cleanupPaths.map((target) => safeRootRelative(root, target, "transaction cleanup path")))];
  const expectedByPath = normalizeTransactionTargetStates(root, expectedTargets, "expected transaction target");
  const preconditionByPath = normalizeTransactionTargetStates(root, preconditionTargets, "transaction precondition target");
  for (const relative of normalizedTargets) {
    if (!expectedByPath.has(relative)) throw new TypeError(`Missing expected transaction state: ${relative}`);
    if (preconditionTargets.length && !preconditionByPath.has(relative)) {
      throw new TypeError(`Missing transaction precondition state: ${relative}`);
    }
  }
  if (expectedByPath.size !== normalizedTargets.length) {
    throw new TypeError("Expected transaction states must match the target set exactly");
  }
  if (preconditionTargets.length && preconditionByPath.size !== normalizedTargets.length) {
    throw new TypeError("Transaction precondition states must match the target set exactly");
  }
  const transactionDirectory = path.join(directory, `tx-${process.pid}-${randomUUID()}`);
  await mkdir(transactionDirectory, { recursive: false });
  const journal = {
    format: SNAPSHOT_TRANSACTION_FORMAT,
    phase: "prepared",
    created_at: new Date().toISOString(),
    targets: [],
    cleanup_paths: normalizedCleanup
  };
  let closed = false;
  try {
    const backupDirectory = path.join(transactionDirectory, "backups");
    await mkdir(backupDirectory, { recursive: false });
    for (let index = 0; index < normalizedTargets.length; index += 1) {
      throwIfAborted(signal, "Transaction snapshot");
      const relative = normalizedTargets[index];
      const target = resolveJournalRelative(root, relative, "transaction target");
      let information;
      try {
        information = await lstat(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!information) {
        const current = { exists: false };
        const precondition = preconditionByPath.get(relative);
        if (precondition && !matchesBeforeSnapshotTarget(current, {
          existed: precondition.exists,
          size_bytes: precondition.size_bytes,
          sha256: precondition.sha256
        })) {
          const error = new Error(`Cloudig transaction optimistic-concurrency conflict: ${relative}:unexpected-fingerprint`);
          error.code = "CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT";
          throw error;
        }
        const expected = expectedByPath.get(relative);
        journal.targets.push({
          path: relative,
          existed: false,
          expected_exists: expected.exists,
          ...(expected.exists ? {
            expected_size_bytes: expected.size_bytes,
            expected_sha256: expected.sha256
          } : {})
        });
        continue;
      }
      if (!information.isFile()) throw new TypeError(`Transaction target is not a regular file: ${relative}`);
      const currentSha256 = await sha256File(target, { signal });
      const current = {
        exists: true,
        regular_file: true,
        size_bytes: information.size,
        sha256: currentSha256
      };
      const precondition = preconditionByPath.get(relative);
      if (precondition && !matchesBeforeSnapshotTarget(current, {
        existed: precondition.exists,
        size_bytes: precondition.size_bytes,
        sha256: precondition.sha256
      })) {
        const error = new Error(`Cloudig transaction optimistic-concurrency conflict: ${relative}:unexpected-fingerprint`);
        error.code = "CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT";
        throw error;
      }
      const backup = `backups/${String(index).padStart(8, "0")}.bin`;
      const backupPath = resolveJournalRelative(transactionDirectory, backup, "snapshot backup");
      await durableCopy(target, backupPath, { signal });
      const backupInformation = await lstat(backupPath);
      if (!backupInformation.isFile() || backupInformation.size !== information.size
        || await sha256File(backupPath, { signal }) !== currentSha256) {
        const error = new Error(`Cloudig transaction target changed while its snapshot was being captured: ${relative}`);
        error.code = "CLOUDIG_TRANSACTION_PRECONDITION_CONFLICT";
        throw error;
      }
      const expected = expectedByPath.get(relative);
      journal.targets.push({
        path: relative,
        existed: true,
        backup,
        size_bytes: information.size,
        sha256: currentSha256,
        atime_ms: information.atimeMs,
        mtime_ms: information.mtimeMs,
        mode: information.mode,
        expected_exists: expected.exists,
        ...(expected.exists ? {
          expected_size_bytes: expected.size_bytes,
          expected_sha256: expected.sha256
        } : {})
      });
    }
    await writeSnapshotJournal(transactionDirectory, journal, { signal });
    throwIfAborted(signal, "Transaction snapshot journal");
  } catch (error) {
    await rm(transactionDirectory, { recursive: true, force: true });
    throw error;
  }

  async function beginMutation({ signal: mutationSignal = null } = {}) {
    if (closed) throw new Error("File snapshot transaction is already closed");
    if (journal.phase !== "prepared") throw invalidSnapshotPhase("beginMutation", "prepared", journal.phase);
    await assertSnapshotTargetsBefore(root, journal, { signal: mutationSignal });
    throwIfAborted(mutationSignal, "Transaction beginMutation");
    journal.phase = "mutating";
    await writeSnapshotJournal(transactionDirectory, journal, { signal: mutationSignal });
    throwIfAborted(mutationSignal, "Transaction beginMutation");
  }

  async function assertBefore(target, { signal: assertionSignal = null } = {}) {
    if (closed) throw new Error("File snapshot transaction is already closed");
    if (journal.phase !== "mutating") throw invalidSnapshotPhase("assertBefore", "mutating", journal.phase);
    await assertSnapshotTargetsBefore(root, journal, { signal: assertionSignal, onlyPath: target });
  }

  async function commit({ signal: commitSignal = null } = {}) {
    if (closed) throw new Error("File snapshot transaction is already closed");
    if (journal.phase !== "mutating") throw invalidSnapshotPhase("commit", "mutating", journal.phase);
    await assertSnapshotTargetsExpected(root, journal, { signal: commitSignal });
    throwIfAborted(commitSignal, "Transaction commit");
    journal.phase = "committed";
    // The durable committed marker is the transaction's final atomic point.
    // Cancellation remains active through the complete expected-state hash pass
    // and final check above; once marker persistence begins it must not split
    // live rollback semantics from next-operation crash recovery semantics.
    await writeSnapshotJournal(transactionDirectory, journal);
    closed = true;
    try { await rm(transactionDirectory, { recursive: true, force: true }); } catch { /* committed journal is finalized next time */ }
    await releaseOwnedLock();
  }

  async function rollback() {
    if (closed) return;
    closed = true;
    try {
      await restoreSnapshotTransaction(root, transactionDirectory, normalizeSnapshotJournal(journal));
    } finally {
      await releaseOwnedLock();
    }
  }

  async function abandonForRecovery() {
    if (closed) return;
    if (!ownsLock) throw new Error("Cannot abandon a transaction whose lock is owned by its caller");
    closed = true;
    await releaseOwnedLock();
  }

  return Object.freeze({
    beginMutation,
    assertBefore,
    commit,
    rollback,
    abandonForRecovery,
    get phase() { return journal.phase; }
  });
  } catch (error) {
    await releaseOwnedLock();
    throw error;
  }
}
