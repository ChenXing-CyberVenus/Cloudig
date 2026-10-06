import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, utimes } from "node:fs/promises";
import { moveFileNoReplace } from "./no-replace.mts";
import path from "node:path";
import { decodeRecord, parseRecordJson, type RecordKind } from "../../core/records/index.mts";
import { isInboxImportLocation } from "../../core/records/layout.mts";
import { recordValidationError } from "../../core/records/errors.mts";
import { assertRecordLocation, confinedRelativePath, RECORD_STORAGE_LIMITS } from "../../core/records/layout.mts";
import { uuidV7 } from "../../core/records/ids.mts";
import { prepareRecordEncoding } from "../../core/records/encoding.mts";
import { acquireSingleWriter } from "./writer-lock.mts";
import { fingerprintFile, writeOwnedStagingFile } from "./stream.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { Ajv2020 } from "ajv/dist/2020.js";
import transactionSchema from "./record-transaction.schema.json" with { type: "json" };
import { inspectRecordConversation } from "../reader/record-resource.mts";

export type RecordChange = Readonly<{ path: string; expected: string | null }> & (
  | Readonly<{ action: "write"; kind: RecordKind; value: JsonObject }>
  | Readonly<{ action: "binary"; data: Uint8Array }>
  | Readonly<{ action: "import"; source: () => Readable; sha256: string; bytes: number; modifiedAt?: string; onProgress?: (bytes: number) => void }>
  | Readonly<{ action: "delete" }>
);
export type RecordReadGuard = Readonly<{ path: string; expected: string | null }>;
export type RecordFileIdentity = Readonly<{ device: string; inode: string }>;
export type RecordRelocation = Readonly<{ from: string; to?: string; kind: "file" | "directory" | "empty_directory"; identity: RecordFileIdentity; sha256?: string }>;
type Relocation = RecordRelocation & { to: string; identity_mode?: "content"; tree_sha256?: string };
type Change = { path: string; action: "write" | "delete"; exists: boolean; expected_sha256?: string; after_sha256?: string };
type Journal = { schema: "cloudig/record-transaction/1.0.0"; operation_id: string; recovery_order: number; created_at: string; state: "prepared" | "installing" | "completed"; changes: Change[]; reads: RecordReadGuard[]; relocations?: Relocation[] };
export type RecordStoreFault = "prepared" | `staged_${number}` | `before_${number}` | `displaced_${number}` | `installed_${number}` | `relocation_linked_${number}` | `relocated_${number}` | "completed";
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const isMissing = (e: unknown): boolean => e instanceof Error && "code" in e && e.code === "ENOENT";
const isExisting = (e: unknown): boolean => e instanceof Error && "code" in e && e.code === "EEXIST";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const journalShape = new Ajv2020({ strict: true, strictRequired: false }).compile(transactionSchema);

export class RecordStoreConflict extends Error {
  readonly operationId: string | undefined;
  constructor(message: string, operationId?: string) { super(message); this.name = "RecordStoreConflict"; this.operationId = operationId; }
}

export async function resolveRecordPath(root: string, relative: string): Promise<string> {
  confinedRelativePath(relative);
  let current = await realpath(root);
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try { if ((await lstat(current)).isSymbolicLink()) throw new TypeError("Record path must not cross a symbolic link or junction"); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  return current;
}

export async function recordFileIdentity(root: string, relative: string, kind: "file" | "directory"): Promise<RecordFileIdentity> {
  const value = await lstat(await resolveRecordPath(root, relative), { bigint: true });
  if (value.isSymbolicLink() || (kind === "file" ? !value.isFile() : !value.isDirectory()) || value.ino === 0n) throw new TypeError("A managed path needs a stable ordinary filesystem identity");
  return { device: String(value.dev), inode: String(value.ino) };
}
const identityEqual = (a: RecordFileIdentity, b: RecordFileIdentity) => a.device === b.device && a.inode === b.inode;
function validateRelocations(j: Journal, targets: Set<string>): void {
  const occupied = [...targets, ...j.reads.map(r => r.path.toLowerCase())];
  for (const [i, r] of (j.relocations ?? []).entries()) {
    confinedRelativePath(r.from); confinedRelativePath(r.to);
    const source = r.from.toLowerCase(), target = r.to.toLowerCase();
    if (!/^(Conversations|Archives)\/.+/u.test(r.from) || (r.kind === "empty_directory" ? r.to !== opPath(j.operation_id, `removed/${i}`) : !/^(Conversations|Archives)\/.+/u.test(r.to))
      || !/^[0-9]+$/u.test(r.identity.device) || !/^[1-9][0-9]*$/u.test(r.identity.inode)
      || (r.kind === "file" ? !SHA.test(r.sha256 ?? "") : r.sha256 !== undefined)
      || (r.identity_mode === "content" && r.kind !== "file" ? !SHA.test(r.tree_sha256 ?? "") : r.tree_sha256 !== undefined)
      || source === target || source.startsWith(`${target}/`) || target.startsWith(`${source}/`)
      || occupied.some(p => [source, target].some(q => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)))) throw new TypeError("Conflicting or invalid record relocation");
    occupied.push(source, target);
  }
}
async function directoryFingerprint(root: string, relative: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(await resolveRecordPath(root, directory), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix + entry.name, next = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new TypeError("A moved directory cannot contain symbolic links");
      if (entry.isDirectory()) { hash.update(JSON.stringify(["directory", name]) + "\n"); await walk(next, name + "/"); }
      else if (entry.isFile()) hash.update(JSON.stringify(["file", name, await fingerprint(root, next)]) + "\n");
      else throw new TypeError("A moved directory contains an unsupported filesystem object");
    }
  }
  await walk(relative, ""); return hash.digest("hex");
}
async function relocationPosition(root: string, r: Relocation, rollback = false): Promise<"before" | "linked" | "after"> {
  const kind = r.kind === "file" ? "file" : "directory";
  const observe = async (relative: string) => {
    try {
      const id = await recordFileIdentity(root, relative, kind);
      const identityMatches = r.identity_mode === "content" ? id.device === r.identity.device : identityEqual(id, r.identity);
      // Cancelling an as-yet-unmoved directory changes nothing inside it. Keep
      // files that arrived after preparation; do not turn rollback into deletion.
      const originalDirectoryUntouched = rollback && relative === r.from && kind === "directory" && identityEqual(id, r.identity);
      if (!identityMatches || (r.kind === "file" ? await fingerprint(root, relative) !== r.sha256
        : !originalDirectoryUntouched && r.identity_mode === "content" && await directoryFingerprint(root, relative) !== r.tree_sha256)) throw new TypeError(`Relocation path changed: ${relative}`);
      return true;
    } catch (e) { if (isMissing(e)) return false; throw e; }
  };
  const before = await observe(r.from), after = await observe(r.to);
  if (before && after && (r.kind !== "file" || r.identity_mode === "content") || !before && !after) throw new TypeError("Relocation identity is ambiguous or missing");
  return before ? after ? "linked" : "before" : "after";
}
async function relocate(root: string, r: Relocation, reverse: boolean, linked?: () => Promise<void>): Promise<void> {
  const position = await relocationPosition(root, r, reverse);
  if (!reverse && r.kind === "empty_directory" && (await readdir(await resolveRecordPath(root, position === "before" ? r.from : r.to))).length) throw new TypeError("Only completely empty directories can be removed");
  if (reverse ? position === "before" : position === "after") return;
  const from = reverse ? r.to : r.from, to = reverse ? r.from : r.to;
  const source = await resolveRecordPath(root, from), target = await resolveRecordPath(root, to);
  await recordFileIdentity(root, to.split("/").slice(0, -1).join("/"), "directory");
  if (r.kind === "file") {
    // Old interrupted hard-link journals can still contain both names. New
    // desktop moves are a single no-replace rename, including on portable disks.
    if (position === "linked") await unlink(source);
    else await moveFileNoReplace(source, target);
    await linked?.();
  } else {
    // Windows refuses replacing an existing directory, including an empty one.
    // The writer adapter itself is Windows-only; a different host needs its own no-replace primitive.
    await rename(source, target);
  }
  if (await relocationPosition(root, r) !== (reverse ? "before" : "after")) throw new TypeError("Relocation did not reach its expected position");
}

async function fingerprint(root: string, relative: string): Promise<string | null> {
  try { return (await fingerprintFile(await resolveRecordPath(root, relative))).sha256; }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

/** Operation-local source read memo. Never used for write targets or persisted in a journal. */
export class RecordSourceReads {
  readonly #files = new Map<string, { stamp: string; sha256: string }>();
  readonly metrics = { hashes: 0, reused: 0 };
  async fingerprint(root: string, relative: string): Promise<string | null> {
    if (!relative.startsWith("Inbox/")) return fingerprint(root, relative);
    const file = await resolveRecordPath(root, relative);
    try {
      const before = await lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) throw new TypeError("Source read requires an ordinary file");
      const stamp = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
      const prior = this.#files.get(file);
      if (prior?.stamp === stamp(before)) { this.metrics.reused++; return prior.sha256; }
      const actual = await fingerprintFile(file), after = await lstat(file, { bigint: true }); this.metrics.hashes++;
      if (stamp(before) !== stamp(after)) throw new RecordStoreConflict(`Source changed while checking: ${relative}`);
      this.#files.set(file, { stamp: stamp(after), sha256: actual.sha256 }); return actual.sha256;
    } catch (e) { if (isMissing(e)) { this.#files.delete(file); return null; } throw e; }
  }
}

async function writeNew(file: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

const opPath = (id: string, suffix: string): string => `appdata/transactions/${id}/${suffix}`;
async function saveJournal(root: string, journal: Journal): Promise<void> {
  const temp = await resolveRecordPath(root, opPath(journal.operation_id, "journal.next"));
  try { await unlink(temp); } catch (error) { if (!isMissing(error)) throw error; }
  await writeNew(temp, JSON.stringify(journal, null, 2) + "\n");
  await rename(temp, await resolveRecordPath(root, opPath(journal.operation_id, "journal.json")));
}

function validateJournal(value: unknown, id: string): Journal {
  if (!journalShape(value)) throw new TypeError("Invalid record journal shape");
  const j = value as Journal;
  if (j.schema !== "cloudig/record-transaction/1.0.0" || !UUID.test(id) || j.operation_id !== id || !["prepared", "installing", "completed"].includes(j.state) || !Array.isArray(j.changes) || !Array.isArray(j.reads) || !Number.isFinite(Date.parse(j.created_at))) throw new TypeError("Invalid record journal identity or state");
  const targets = new Set<string>();
  for (const c of j.changes) {
    confinedRelativePath(c.path);
    const key = c.path.toLowerCase();
    if (targets.has(key) || !managedTarget(c.path) || !["write", "delete"].includes(c.action) || typeof c.exists !== "boolean" || (c.exists ? !SHA.test(c.expected_sha256 ?? "") : c.expected_sha256 !== undefined) || (c.action === "write" ? !SHA.test(c.after_sha256 ?? "") : c.after_sha256 !== undefined)) throw new TypeError("Invalid record journal change");
    if (c.path.startsWith("Inbox/") && (c.action !== "write" || c.exists)) throw new TypeError("Source import can only create a new Inbox file");
    targets.add(key);
  }
  for (const r of j.reads) { confinedRelativePath(r.path); if (r.expected !== null && !SHA.test(r.expected)) throw new TypeError("Invalid read precondition"); }
  if (j.reads.some(r => targets.has(r.path.toLowerCase()))) throw new TypeError("A write target already carries its own precondition");
  validateRelocations(j, targets);
  return j;
}

async function loadJournal(root: string, id: string): Promise<Journal> {
  if (!UUID.test(id)) throw new TypeError("Invalid operation ID");
  let text: string;
  try { text = await readFile(await resolveRecordPath(root, opPath(id, "journal.json")), "utf8"); }
  catch (error) { if (!isMissing(error)) throw error; text = await readFile(await resolveRecordPath(root, opPath(id, "journal.next")), "utf8"); }
  return validateJournal(parseRecordJson(text), id);
}

function managedTarget(relative: string): boolean {
  return relative === "CloudigLibrary.json" || isInboxImportLocation(relative) || /^(?:Conversations|Archives|Marks|ContentTimes|Identities)\/.+/u.test(relative)
    || /^appdata\/(?!transactions(?:\/|$)|recovery(?:\/|$)).+/u.test(relative);
}

async function operationIds(root: string): Promise<string[]> {
  const dir = await resolveRecordPath(root, "appdata/transactions");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some(e => !e.isDirectory() || !UUID.test(e.name))) throw new RecordStoreConflict("Unrecognized transaction material must be preserved");
    return entries.map(e => e.name).sort();
  } catch (error) { if (isMissing(error)) return []; throw error; }
}

async function requireNoPending(root: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const id of await operationIds(root)) {
    let journal: Journal;
    try { journal = await loadJournal(root, id); }
    catch { throw new RecordStoreConflict("Incomplete transaction requires inspection before another write", id); }
    if (journal.state !== "completed") throw new RecordStoreConflict("An unfinished transaction requires recovery", id);
    try { warnings.push(...await retireCompleted(root, journal)); } catch (error) { warnings.push(`Completed ${id}: ${error instanceof Error ? error.message : "cleanup pending"}`); }
  }
  return warnings;
}

async function requireReads(root: string, reads: readonly RecordReadGuard[], sourceReads?: RecordSourceReads): Promise<void> {
  for (const r of reads) if (await (sourceReads ? sourceReads.fingerprint(root, r.path) : fingerprint(root, r.path)) !== r.expected) throw new RecordStoreConflict(`Read dependency changed: ${r.path}`);
}

async function removeVerified(root: string, relative: string, expected: string): Promise<void> {
  const observed = await fingerprint(root, relative);
  if (observed === null) return;
  if (observed !== expected) throw new RecordStoreConflict(`Changed file must be preserved: ${relative}`);
  await unlink(await resolveRecordPath(root, relative));
}

async function install(root: string, j: Journal, options: Readonly<{ signal?: AbortSignal; sourceReads?: RecordSourceReads; fault?: (point: RecordStoreFault) => void | Promise<void> }> = {}): Promise<string[]> {
  await requireReads(root, j.reads, options.sourceReads);
  for (const r of j.relocations ?? []) await relocationPosition(root, r);
  j.state = "installing"; await saveJournal(root, j);
  for (const [i, c] of j.changes.entries()) {
    options.signal?.throwIfAborted(); await options.fault?.(`before_${i}`);
    const target = await resolveRecordPath(root, c.path), before = c.expected_sha256 ?? null, after = c.after_sha256 ?? null;
    const current = await fingerprint(root, c.path);
    if (current === after) continue;
    const displacedRelative = opPath(j.operation_id, `displaced/${i}.bin`);
    const displacedHash = await fingerprint(root, displacedRelative);
    if (current !== before && !(current === null && displacedHash === before && before !== null)) throw new RecordStoreConflict(`Write target changed: ${c.path}`, j.operation_id);
    if (c.exists && current !== null) {
      if (displacedHash !== null) throw new RecordStoreConflict(`Displaced target is occupied: ${c.path}`, j.operation_id);
      await rename(target, await resolveRecordPath(root, displacedRelative));
      if (await fingerprint(root, displacedRelative) !== before) {
        try { await moveFileNoReplace(await resolveRecordPath(root, displacedRelative), target); } catch (e) { if (!isExisting(e)) throw e; }
        throw new RecordStoreConflict(`Target changed during replacement: ${c.path}`, j.operation_id);
      }
      await options.fault?.(`displaced_${i}`);
    }
    if (c.action === "write") {
      const staged = opPath(j.operation_id, `after/${i}.bin`);
      if (await fingerprint(root, staged) !== after) throw new RecordStoreConflict("Staged bytes changed", j.operation_id);
      await mkdir(path.dirname(target), { recursive: true });
      await resolveRecordPath(root, c.path);
      // A successful rename consumes staging. Recovery first checks installed
      // bytes, so interruption after this step does not require a second copy.
      await moveFileNoReplace(await resolveRecordPath(root, staged), target);
    }
    if (await fingerprint(root, c.path) !== after) throw new RecordStoreConflict("Installed bytes do not match the plan", j.operation_id);
    await options.fault?.(`installed_${i}`);
  }
  for (const [i, r] of (j.relocations ?? []).entries()) {
    options.signal?.throwIfAborted(); await relocate(root, r, false, async () => { await options.fault?.(`relocation_linked_${i}`); }); await options.fault?.(`relocated_${i}`);
  }
  j.state = "completed"; await saveJournal(root, j); await options.fault?.("completed");
  try { return await retireCompleted(root, j); }
  catch (error) { return [`Completed ${j.operation_id}: ${error instanceof Error ? error.message : "cleanup pending"}`]; }
}

async function retireCompleted(root: string, j: Journal): Promise<string[]> {
  // Remove stage/displaced copies only after final bytes and the completed marker exist.
  for (const [i, c] of j.changes.entries()) {
    if (c.after_sha256) {
      const relative = opPath(j.operation_id, `after/${i}.bin`);
      const observed = await fingerprint(root, relative);
      if (observed !== null && observed !== c.after_sha256) {
        const staged = await lstat(await resolveRecordPath(root, relative), { bigint: true });
        const target = await lstat(await resolveRecordPath(root, c.path), { bigint: true });
        if (staged.ino === 0n || staged.dev !== target.dev || staged.ino !== target.ino || staged.nlink < 2n) throw new RecordStoreConflict("Changed completed staging is not a proven live-file link", j.operation_id);
        await unlink(await resolveRecordPath(root, relative));
      } else await removeVerified(root, relative, c.after_sha256);
    }
    if (c.expected_sha256) await removeVerified(root, opPath(j.operation_id, `displaced/${i}.bin`), c.expected_sha256);
  }
  for (const leaf of ["after", "displaced"]) {
    try { await rmdir(await resolveRecordPath(root, opPath(j.operation_id, leaf))); } catch (e) { if (!isMissing(e)) throw e; }
  }
  for (const r of j.relocations ?? []) if (r.kind === "empty_directory") {
    try {
      await lstat(await resolveRecordPath(root, r.to)); // May already be retired after a completed-marker interruption.
      if (await relocationPosition(root, r) !== "after") throw new TypeError("Removed directory identity changed");
      await rmdir(await resolveRecordPath(root, r.to));
    } catch (e) { if (!isMissing(e)) throw e; }
  }
  try { await rmdir(await resolveRecordPath(root, opPath(j.operation_id, "removed"))); } catch (e) { if (!isMissing(e)) throw e; }
  const recoveryRoot = await resolveRecordPath(root, "appdata/recovery"); await mkdir(recoveryRoot, { recursive: true });
  await rename(await resolveRecordPath(root, `appdata/transactions/${j.operation_id}`), path.join(recoveryRoot, j.operation_id));
  return pruneRecovery(root);
}

async function recoveryHistory(root: string): Promise<{ entries: { id: string; journal: Journal }[]; warnings: string[] }> {
  const recovery = await resolveRecordPath(root, "appdata/recovery");
  const entries: { id: string; journal: Journal }[] = [], warnings: string[] = [];
  let children;
  try { children = await readdir(recovery, { withFileTypes: true }); } catch (e) { if (isMissing(e)) return { entries, warnings }; throw e; }
  for (const entry of children) if (entry.isDirectory() && UUID.test(entry.name)) {
    try {
      const journal = validateJournal(parseRecordJson(await readFile(await resolveRecordPath(root, `appdata/recovery/${entry.name}/journal.json`), "utf8")), entry.name);
      if (journal.state !== "completed") throw new TypeError("Retired history is not completed");
      entries.push({ id: entry.name, journal });
    } catch (e) {
      // Retired history is not an active transaction or current business data.
      // Preserve unknown bytes, report maintenance, but do not block new saves.
      warnings.push(`Preserved recovery history ${entry.name}: ${e instanceof Error ? e.message : "inspection required"}`);
    }
  }
  return { entries, warnings };
}

async function pruneRecovery(root: string): Promise<string[]> {
  const { entries, warnings } = await recoveryHistory(root);
  entries.sort((a, b) => a.journal.recovery_order - b.journal.recovery_order);
  for (const { id, journal: j } of entries.slice(0, -RECORD_STORAGE_LIMITS.completedRecoveryGroups)) {
    const relative = `appdata/recovery/${id}`;
    if (j.state !== "completed") throw new RecordStoreConflict("Unfinished recovery history is not disposable", id);
    for (const [i, c] of j.changes.entries()) if (c.expected_sha256) await removeVerified(root, `${relative}/before/${i}.bin`, c.expected_sha256);
    // No recursive deletion: unexpected files prevent directory retirement and remain intact.
    await rmdir(await resolveRecordPath(root, `${relative}/before`));
    await unlink(await resolveRecordPath(root, `${relative}/journal.json`));
    await rmdir(await resolveRecordPath(root, relative));
  }
  return warnings;
}

async function nextRecoveryOrder(root: string): Promise<number> {
  const { entries } = await recoveryHistory(root);
  let max = 0; for (const entry of entries) max = Math.max(max, entry.journal.recovery_order);
  if (!Number.isSafeInteger(max + 1)) throw new RangeError("Recovery order exceeds the JSON integer envelope");
  return max + 1;
}

export async function commitRecords(rootInput: string, changes: readonly RecordChange[], options: Readonly<{ reads?: readonly RecordReadGuard[]; relocations?: readonly RecordRelocation[]; sourceReads?: RecordSourceReads; signal?: AbortSignal; preflight?: () => Promise<void>; fault?: (point: RecordStoreFault) => void | Promise<void> }> = {}): Promise<Readonly<{ operationId: string; maintenanceWarnings: readonly string[] }> | null> {
  const root = await realpath(rootInput), lock = await acquireSingleWriter(root, { waitForLocal: true });
  let id: string | undefined;
  try {
    const warnings = await requireNoPending(root); await requireReads(root, options.reads ?? [], options.sourceReads); options.signal?.throwIfAborted();
    await options.preflight?.();
    const prepared: { c: Change; data?: Uint8Array; encoding?: ReturnType<typeof prepareRecordEncoding>; imported?: Extract<RecordChange, { action: "import" }>; oldPath?: string }[] = [];
    for (const change of changes) {
      confinedRelativePath(change.path);
      if (!managedTarget(change.path)) throw new TypeError("This is not a managed record target");
      if (change.path.startsWith("Inbox/") && change.action !== "import") throw new TypeError("Inbox originals only enter through explicit no-replace import");
      let data: Uint8Array | undefined;
      let encoding: ReturnType<typeof prepareRecordEncoding> | undefined;
      if (change.action === "write") { assertRecordLocation(change.kind, change.path, change.value); encoding = prepareRecordEncoding(change.kind, change.value); }
      else if (change.action === "binary") {
        if (!/^(?:Identities\/Images\/|appdata\/(?!transactions\/|recovery\/))/u.test(change.path)) throw new TypeError("Binary data is restricted to user images and internal state");
        data = Buffer.from(change.data);
      }
      else if (change.action === "import" && (!isInboxImportLocation(change.path) || change.expected !== null || !SHA.test(change.sha256) || !Number.isSafeInteger(change.bytes) || change.bytes < 0 || change.modifiedAt !== undefined && !Number.isFinite(Date.parse(change.modifiedAt)))) throw new TypeError("Invalid source import proof");
      const oldHash = await fingerprint(root, change.path);
      if (oldHash !== change.expected) throw new RecordStoreConflict(`Target changed before preparation: ${change.path}`);
      if (change.action === "write" && oldHash !== null) {
        const previous = change.kind === "conversation"
          ? { ok: true as const, value: (await inspectRecordConversation(await resolveRecordPath(root, change.path), options.signal)).conversation }
          : decodeRecord(change.kind, await readFile(await resolveRecordPath(root, change.path)));
        if (!previous.ok) throw new RecordStoreConflict("Existing record is not in the new format");
        const identityKey: Partial<Record<RecordKind, string>> = { conversation: "conversation_id", identity: "front_id", contentTime: "node_id", mark: "mark_id" };
        const key = identityKey[change.kind];
        if (key && previous.value[key] !== change.value[key]) throw new RecordStoreConflict("In-place saves cannot change record identity");
        if (change.kind === "mark" && previous.value["target"] !== change.value["target"]) throw new RecordStoreConflict("In-place Mark saves cannot change their Conversation target");
      }
      const afterHash = change.action === "import" ? change.sha256 : encoding?.fingerprint.sha256 ?? (data ? sha(data) : null);
      if (afterHash === change.expected) continue;
      const c: Change = { path: change.path, action: change.action === "delete" ? "delete" : "write", exists: oldHash !== null, ...(oldHash ? { expected_sha256: oldHash } : {}), ...(afterHash ? { after_sha256: afterHash } : {}) };
      prepared.push({ c, ...(data ? { data } : {}), ...(encoding ? { encoding } : {}), ...(change.action === "import" ? { imported: change } : {}), ...(oldHash ? { oldPath: change.path } : {}) });
    }
    if (!prepared.length && !options.relocations?.length) return null;
    id = uuidV7();
    const relocations: Relocation[] | undefined = options.relocations ? [] : undefined;
    for (const [i, r] of (options.relocations ?? []).entries()) {
      if (!identityEqual(await recordFileIdentity(root, r.from, r.kind === "file" ? "file" : "directory"), r.identity)) throw new RecordStoreConflict("Relocation source changed before preparation");
      const contentProof = process.env["CLOUDIG_PORTABLE_FILE_IDENTITIES"] === "1";
      relocations!.push({ ...r, to: r.kind === "empty_directory" ? opPath(id!, `removed/${i}`) : r.to!, ...(contentProof ? {
        identity_mode: "content" as const, ...(r.kind !== "file" ? { tree_sha256: await directoryFingerprint(root, r.from) } : {})
      } : {}) });
    }
    const journal: Journal = { schema: "cloudig/record-transaction/1.0.0", operation_id: id, recovery_order: await nextRecoveryOrder(root), created_at: new Date().toISOString(), state: "prepared", changes: prepared.map(p => p.c), reads: [...(options.reads ?? [])], ...(relocations?.length ? { relocations } : {}) };
    validateJournal(journal, id);
    for (const r of relocations ?? []) {
      if (await relocationPosition(root, r) !== "before") throw new RecordStoreConflict("Relocation destination is already occupied");
      if (r.kind === "empty_directory" && (await readdir(await resolveRecordPath(root, r.from))).length) throw new RecordStoreConflict("Only completely empty directories can be removed");
    }
    for (const dir of ["before", "after", "displaced"]) await mkdir(await resolveRecordPath(root, opPath(id, dir)), { recursive: true });
    if (relocations?.some(r => r.kind === "empty_directory")) await mkdir(await resolveRecordPath(root, opPath(id, "removed")), { recursive: true });
    // A prepared journal means no target has changed yet; incomplete staging can still be rolled back.
    await saveJournal(root, journal);
    for (const [i, p] of prepared.entries()) {
      options.signal?.throwIfAborted();
      if (p.oldPath) {
        const copied = await writeOwnedStagingFile(createReadStream(await resolveRecordPath(root, p.oldPath)), await resolveRecordPath(root, opPath(id, `before/${i}.bin`)), options.signal ? { signal: options.signal } : {});
        if (copied.sha256 !== p.c.expected_sha256) throw new RecordStoreConflict("Original changed while preparing recovery copy", id);
      }
      if (p.data) await writeNew(await resolveRecordPath(root, opPath(id, `after/${i}.bin`)), p.data);
      if (p.encoding) {
        const staged = await writeOwnedStagingFile(Readable.from(p.encoding.chunks()), await resolveRecordPath(root, opPath(id, `after/${i}.bin`)), options.signal ? { signal: options.signal } : {});
        if (staged.sha256 !== p.c.after_sha256) throw new RecordStoreConflict("Record value changed while preparing staged bytes", id);
      }
      if (p.imported) {
        const target = await resolveRecordPath(root, opPath(id, `after/${i}.bin`));
        const staged = await writeOwnedStagingFile(p.imported.source(), target, { ...(options.signal ? { signal: options.signal } : {}), ...(p.imported.onProgress ? { onProgress: p.imported.onProgress } : {}) });
        if (staged.sha256 !== p.imported.sha256 || staged.bytes !== p.imported.bytes) throw new RecordStoreConflict("Selected source changed while importing", id);
        if (p.imported.modifiedAt) { const when = new Date(p.imported.modifiedAt); await utimes(target, when, when); }
      }
      await options.fault?.(`staged_${i}`);
    }
    await options.fault?.("prepared");
    warnings.push(...await install(root, journal, options)); return { operationId: id, maintenanceWarnings: warnings };
  } catch (error) {
    if (options.signal?.aborted) {
      const cancelled = new RecordStoreConflict("Record save cancelled; any unfinished operation can be recovered", id);
      cancelled.name = "AbortError";
      throw cancelled;
    }
    if (error instanceof RecordStoreConflict) throw error;
    throw new RecordStoreConflict(error instanceof Error ? error.message : "Record save failed", id);
  } finally { await lock.release(); }
}

export async function readStoredRecord(root: string, kind: RecordKind, relative: string): Promise<Readonly<{ value: JsonObject; sha256: string }>> {
  const bytes = await readFile(await resolveRecordPath(root, relative)), decoded = decodeRecord(kind, bytes);
  if (!decoded.ok) throw recordValidationError(decoded.issues);
  assertRecordLocation(kind, relative, decoded.value);
  return { value: decoded.value, sha256: sha(bytes) };
}

export async function readStoredConversationMetadata(root: string, relative: string, signal?: AbortSignal) {
  const result = await inspectRecordConversation(await resolveRecordPath(root, relative), signal);
  assertRecordLocation("conversation", relative, result.conversation);
  return { value: result.conversation, sha256: result.fingerprint.sha256, resourceBodies: result.resourceBodies };
}

/** Same writer exclusion can span an external native operation; its owner must release it. */
export async function acquireRecordSnapshot(rootInput: string, options: Readonly<{ waitForLocal?: boolean }> = {}) {
  const root = await realpath(rootInput), lock = await acquireSingleWriter(root, options);
  try {
    for (const id of await operationIds(root)) {
      const journal = await loadJournal(root, id);
      if (journal.state !== "completed") throw new RecordStoreConflict("Complete recovery before reading a combined record view", id);
    }
    return lock;
  } catch (error) { await lock.release(); throw error; }
}
/** A composed view must not observe half of a multi-file save. This does not write/repair anything. */
export async function withRecordSnapshot<T>(rootInput: string, read: () => Promise<T>): Promise<T> {
  const lock = await acquireRecordSnapshot(rootInput, { waitForLocal: true });
  try { return await read(); } finally { await lock.release(); }
}

export async function pendingRecordOperations(root: string): Promise<string[]> {
  return operationIds(root);
}

export async function recoverRecords(rootInput: string, id: string, action: "complete" | "rollback"): Promise<void> {
  const root = await realpath(rootInput), lock = await acquireSingleWriter(root, { waitForLocal: true });
  try {
    const j = await loadJournal(root, id);
    if (j.state === "completed") { await retireCompleted(root, j); return; }
    if (action === "complete") { await install(root, j); return; }
    // Preflight the entire rollback before touching any target; external edits remain intact.
    for (const r of j.relocations ?? []) await relocationPosition(root, r, true);
    for (const [i, c] of j.changes.entries()) {
      const current = await fingerprint(root, c.path), before = c.expected_sha256 ?? null, after = c.after_sha256 ?? null;
      if (current !== before && current !== after && current !== null) throw new RecordStoreConflict(`Cannot roll back externally changed file: ${c.path}`, id);
      if (before && current !== before && await fingerprint(root, opPath(id, `before/${i}.bin`)) !== before) throw new RecordStoreConflict("Missing or changed original recovery bytes", id);
    }
    for (const r of [...(j.relocations ?? [])].reverse()) await relocate(root, r, true);
    for (const [i, c] of [...j.changes.entries()].reverse()) {
      const before = c.expected_sha256 ?? null, current = await fingerprint(root, c.path);
      if (current !== before) {
        if (current !== null) await removeVerified(root, c.path, c.after_sha256!);
        if (before !== null) {
          await mkdir(await resolveRecordPath(root, opPath(id, "after")), { recursive: true });
          const restore = opPath(id, `after/${i}.restore`);
          if (await fingerprint(root, restore) === null) await writeOwnedStagingFile(createReadStream(await resolveRecordPath(root, opPath(id, `before/${i}.bin`))), await resolveRecordPath(root, restore));
          if (await fingerprint(root, restore) !== before) throw new RecordStoreConflict("Restore copy changed", id);
          await moveFileNoReplace(await resolveRecordPath(root, restore), await resolveRecordPath(root, c.path));
          await removeVerified(root, restore, before);
        }
      }
    }
    for (const c of j.changes) if (await fingerprint(root, c.path) !== (c.expected_sha256 ?? null)) throw new RecordStoreConflict("Rollback targets changed before completion", id);
    // Explicit rollback discards only this journal's named staging copies, including partial writes.
    // Every original is verified in place first; unexpected files prevent rmdir and remain intact.
    for (const [i] of j.changes.entries()) for (const relative of [`before/${i}.bin`, `after/${i}.bin`, `after/${i}.restore`, `displaced/${i}.bin`]) {
      try { await unlink(await resolveRecordPath(root, opPath(id, relative))); } catch (e) { if (!isMissing(e)) throw e; }
    }
    for (const dir of ["before", "after", "displaced", "removed"]) { try { await rmdir(await resolveRecordPath(root, opPath(id, dir))); } catch (e) { if (!isMissing(e)) throw e; } }
    for (const file of ["journal.json", "journal.next"]) { try { await unlink(await resolveRecordPath(root, opPath(id, file))); } catch (error) { if (!isMissing(error)) throw error; } }
    await rmdir(await resolveRecordPath(root, `appdata/transactions/${id}`));
  } finally { await lock.release(); }
}
