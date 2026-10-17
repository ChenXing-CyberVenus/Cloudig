import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText } from "../../parser/src/atomic.mjs";

const require = createRequire(import.meta.url);
const limits = require("../../time/limits-1.0.0.json");

export const USER_STATE_HISTORY_FORMAT = "cloudig/user-state-history";
export const USER_STATE_HISTORY_VERSION = "0.1.0";
export const LIBRARY_HISTORY_MAX_VERSIONS = limits.user_state.history_max_versions;
export const LIBRARY_HISTORY_MAX_TOTAL_BYTES = limits.user_state.history_max_total_bytes;
export const LIBRARY_HISTORY_MAX_FILE_BYTES = limits.user_state.library_max_bytes;

const BACKUP_ID = /^(\d{8}T\d{9}Z)-([0-9a-f]{64})\.json$/u;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function semanticHistoryDigest(value) {
  try {
    const document = JSON.parse(String(value));
    if (document?.format === "cloudig/library" && document?.version === "1.0.0") delete document.edited_at;
    return digest(JSON.stringify(document));
  } catch {
    return digest(String(value));
  }
}

function backupTimestamp(clock) {
  const date = clock();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError("Cloudig backup clock returned an invalid date");
  return date.toISOString().replace(/[-:.]/gu, "");
}

function timestampIso(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(value);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`
    : "";
}

function backupId(value) {
  const id = String(value || "");
  if (!BACKUP_ID.test(id)) {
    const error = new Error("Cloudig Library backup id is invalid");
    error.code = "CLOUDIG_LIBRARY_BACKUP_INVALID";
    throw error;
  }
  return id;
}

async function ensureDirectDirectory(parent, target) {
  const parentInformation = await lstat(parent);
  if (!parentInformation.isDirectory() || parentInformation.isSymbolicLink()) {
    const error = new Error("Cloudig Library backup directory is unsafe");
    error.code = "CLOUDIG_LIBRARY_BACKUP_UNSAFE";
    throw error;
  }
  let information;
  try { information = await lstat(target); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(target, { recursive: false });
    information = await lstat(target);
  }
  const [parentReal, targetReal] = await Promise.all([realpath(parent), realpath(target)]);
  const inside = path.relative(parentReal, targetReal);
  if (!information.isDirectory() || information.isSymbolicLink()
    || !inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)
    || inside.includes(path.sep)) {
    const error = new Error("Cloudig Library backup directory is unsafe");
    error.code = "CLOUDIG_LIBRARY_BACKUP_UNSAFE";
    throw error;
  }
  return targetReal;
}

async function safeBackupDirectory(paths) {
  await ensureDirectDirectory(paths.root, paths.data);
  await ensureDirectDirectory(paths.data, paths.backups);
  await ensureDirectDirectory(paths.backups, paths.userStateBackups);
  return ensureDirectDirectory(paths.userStateBackups, paths.libraryBackups);
}

async function inspectBackup(directory, id, validate, { includeText = false } = {}) {
  const match = BACKUP_ID.exec(id);
  if (!match) return null;
  const absolute = path.join(directory, id);
  let information;
  try { information = await lstat(absolute); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const base = {
    backup_id: id,
    created_at: timestampIso(match[1]),
    bytes: Number(information.size) || 0,
    sha256: match[2],
    restorable: false,
    error_code: ""
  };
  if (!information.isFile() || information.isSymbolicLink()) return { ...base, error_code: "unsafe_file" };
  if (information.size < 1 || information.size > LIBRARY_HISTORY_MAX_FILE_BYTES) return { ...base, error_code: "size_limit" };
  const text = await readFile(absolute, "utf8");
  if (Buffer.byteLength(text) !== information.size || digest(text) !== match[2]) return { ...base, error_code: "hash_mismatch" };
  try {
    validate(text);
  } catch {
    return { ...base, error_code: "invalid_library", ...(includeText ? { text } : {}) };
  }
  return { ...base, restorable: true, ...(includeText ? { text } : {}) };
}

export async function listLibraryBackups(paths, validate) {
  const directory = await safeBackupDirectory(paths);
  const entries = await readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const record = await inspectBackup(directory, entry.name, validate);
    if (record) records.push(record);
  }
  records.sort((left, right) => right.created_at.localeCompare(left.created_at)
    || right.backup_id.localeCompare(left.backup_id));
  return records;
}

async function pruneLibraryBackups(paths) {
  const records = await listLibraryBackups(paths, () => {});
  const owned = records.filter((record) => !record.error_code);
  let kept = 0;
  let bytes = 0;
  const removed = [];
  for (const record of owned) {
    const retain = kept < LIBRARY_HISTORY_MAX_VERSIONS
      && bytes + record.bytes <= LIBRARY_HISTORY_MAX_TOTAL_BYTES;
    if (retain) {
      kept += 1;
      bytes += record.bytes;
      continue;
    }
    await unlink(path.join(paths.libraryBackups, backupId(record.backup_id)));
    removed.push(record.backup_id);
  }
  return { kept, bytes, removed };
}

export async function createLibraryBackup(paths, text, { clock = () => new Date() } = {}) {
  const serialized = String(text);
  const bytes = Buffer.byteLength(serialized);
  if (bytes < 1 || bytes > LIBRARY_HISTORY_MAX_FILE_BYTES) {
    const error = new Error(`cloudig-library.json backup exceeds ${LIBRARY_HISTORY_MAX_FILE_BYTES} bytes`);
    error.code = "CLOUDIG_LIBRARY_BACKUP_SIZE";
    throw error;
  }
  const sha256 = digest(serialized);
  const records = await listLibraryBackups(paths, () => {});
  const existing = records.find((record) =>
    record.sha256 === sha256 && !record.error_code);
  if (existing) return { ...existing, status: "reused", pruned: [] };
  const semanticDigest = semanticHistoryDigest(serialized);
  const directory = await safeBackupDirectory(paths);
  for (const record of records.filter((item) => !item.error_code)) {
    const inspected = await inspectBackup(directory, record.backup_id, () => {}, { includeText: true });
    if (inspected?.restorable && semanticHistoryDigest(inspected.text) === semanticDigest) {
      const { text: _text, ...equivalent } = inspected;
      return { ...equivalent, status: "equivalent", pruned: [] };
    }
  }
  const id = `${backupTimestamp(clock)}-${sha256}.json`;
  await atomicWriteText(path.join(paths.libraryBackups, id), serialized);
  const written = await inspectBackup(directory, id, () => {});
  if (!written || written.error_code) {
    const error = new Error("Cloudig could not verify the Library backup it wrote");
    error.code = "CLOUDIG_LIBRARY_BACKUP_VERIFY";
    throw error;
  }
  const retention = await pruneLibraryBackups(paths);
  return { ...written, status: "created", pruned: retention.removed };
}

export async function readLibraryBackup(paths, value, validate) {
  const id = backupId(value);
  const directory = await safeBackupDirectory(paths);
  const record = await inspectBackup(directory, id, validate, { includeText: true });
  if (!record || !record.restorable) {
    const error = new Error("The selected Cloudig Library backup is unavailable or invalid");
    error.code = "CLOUDIG_LIBRARY_BACKUP_INVALID";
    throw error;
  }
  return record;
}
