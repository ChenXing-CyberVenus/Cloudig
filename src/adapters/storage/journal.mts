import { link, mkdir, open, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { serializeTransaction, validateTransaction } from "../../core/contracts/index.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { resolveManagedPath } from "./path.mts";
import { fingerprintFile, writeOwnedStagingFile, type ByteFingerprint } from "./stream.mts";

export type FaultPoint = `before_install_${number}` | `after_displace_${number}` | `after_install_${number}` | "after_commit";

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function sameFingerprint(left: JsonObject | ByteFingerprint | undefined, right: JsonObject | ByteFingerprint | undefined): boolean {
  return left?.["bytes"] === right?.["bytes"] && left?.["sha256"] === right?.["sha256"];
}

async function existsFingerprint(filePath: string): Promise<ByteFingerprint | undefined> {
  try {
    return await fingerprintFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function transactionRelative(transaction: string, suffix: string): string {
  return `Data/Transactions/${transaction}/${suffix}`;
}

export async function persistJournal(libraryRoot: string, journal: JsonObject): Promise<void> {
  const validation = validateTransaction(journal);
  if (!validation.ok) throw new TypeError(`Invalid transaction journal: ${validation.issues.map((entry) => entry.code).join(",")}`);
  const transaction = journal["transaction"] as string;
  const directory = await resolveManagedPath(libraryRoot, transactionRelative(transaction, "journal.json"));
  const temporary = `${directory}.tmp`;
  try { await unlink(temporary); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serializeTransaction(journal), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, directory);
}

export async function readJournal(libraryRoot: string, transaction: string): Promise<JsonObject> {
  const filePath = await resolveManagedPath(libraryRoot, transactionRelative(transaction, "journal.json"), { mustExist: true });
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const validation = validateTransaction(value);
  if (!validation.ok) throw new TypeError(`Invalid transaction journal: ${validation.issues.map((entry) => entry.code).join(",")}`);
  return validation.value;
}

export async function prepareJournalTargets(
  libraryRoot: string,
  journalInput: JsonObject
): Promise<JsonObject> {
  const journal = structuredClone(journalInput);
  const transaction = journal["transaction"];
  const targets = journal["targets"];
  if (typeof transaction !== "string" || !Array.isArray(targets) || journal["state"] !== "planned") {
    throw new TypeError("prepareJournalTargets requires a planned transaction");
  }
  const root = await resolveManagedPath(libraryRoot, `Data/Transactions/${transaction}`);
  await mkdir(path.join(root, "staged"), { recursive: true });
  await mkdir(path.join(root, "displaced"), { recursive: true });
  for (const [index, raw] of targets.entries()) {
    if (!isJsonObject(raw)) continue;
    if (raw["action"] === "remove_generated") {
      raw["displaced"] = transactionRelative(transaction, `displaced/${index}.bin`);
      continue;
    }
    if (raw["action"] === "move") throw new TypeError("move staging belongs to the Phase 4 archive command adapter");
    raw["temp"] = transactionRelative(transaction, `staged/${index}.bin`);
    if (raw["action"] === "replace" || raw["action"] === "remove_generated") {
      raw["displaced"] = transactionRelative(transaction, `displaced/${index}.bin`);
    }
  }
  await persistJournal(libraryRoot, journal);
  return journal;
}

export async function stagePreparedJournalTargets(
  libraryRoot: string,
  journalInput: JsonObject,
  payloads: ReadonlyMap<number, Readable>,
  signal?: AbortSignal,
  verifyTarget?: (index: number, stagedPath: string, fingerprint: ByteFingerprint) => Promise<void>
): Promise<JsonObject> {
  const journal = structuredClone(journalInput);
  const transaction = journal["transaction"];
  const targets = journal["targets"];
  if (typeof transaction !== "string" || !Array.isArray(targets) || journal["state"] !== "planned") {
    throw new TypeError("stagePreparedJournalTargets requires a prepared planned transaction");
  }
  const fingerprints: Array<ByteFingerprint | undefined> = [];
  for (const [index, raw] of targets.entries()) {
    if (!isJsonObject(raw) || raw["action"] === "remove_generated") continue;
    const payload = payloads.get(index);
    if (!payload || typeof raw["temp"] !== "string") throw new TypeError(`Missing payload for transaction target ${index}`);
    const temp = await resolveManagedPath(libraryRoot, raw["temp"]);
    fingerprints[index] = await writeOwnedStagingFile(payload, temp, signal ? { signal } : {});
    await verifyTarget?.(index, temp, fingerprints[index]!);
  }
  for (const [index, raw] of targets.entries()) {
    if (!isJsonObject(raw)) continue;
    raw["status"] = "staged";
    if (raw["action"] !== "remove_generated") raw["staged_after"] = fingerprints[index]!;
  }
  journal["state"] = "staged";
  await persistJournal(libraryRoot, journal);
  return journal;
}

export async function stageJournalTargets(
  libraryRoot: string,
  journalInput: JsonObject,
  payloads: ReadonlyMap<number, Readable>,
  signal?: AbortSignal
): Promise<JsonObject> {
  const prepared = await prepareJournalTargets(libraryRoot, journalInput);
  return stagePreparedJournalTargets(libraryRoot, prepared, payloads, signal);
}

async function expectedMatches(targetPath: string, expected: JsonObject): Promise<boolean> {
  const observed = await existsFingerprint(targetPath);
  return expected["state"] === "missing" ? observed === undefined : observed !== undefined && sameFingerprint(observed, expected);
}

export async function installJournal(
  libraryRoot: string,
  journalInput: JsonObject,
  fault?: (point: FaultPoint) => void
): Promise<JsonObject> {
  const journal = structuredClone(journalInput);
  const transaction = journal["transaction"];
  const targets = journal["targets"];
  if (typeof transaction !== "string" || !Array.isArray(targets) || journal["state"] !== "staged") {
    throw new TypeError("installJournal requires a staged transaction");
  }
  journal["state"] = "installing";
  await persistJournal(libraryRoot, journal);
  for (const [index, raw] of targets.entries()) {
    if (!isJsonObject(raw) || !isJsonObject(raw["expected_before"]) || typeof raw["path"] !== "string") continue;
    fault?.(`before_install_${index}`);
    const targetPath = await resolveManagedPath(libraryRoot, raw["path"]);
    try {
      if (!(await stat(path.dirname(targetPath))).isDirectory()) throw new TypeError("Transaction target parent is not a directory");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        raw["status"] = "conflict";
        journal["state"] = "conflict";
        await persistJournal(libraryRoot, journal);
        return journal;
      }
      throw error;
    }
    if (!(await expectedMatches(targetPath, raw["expected_before"]))) {
      raw["status"] = "conflict";
      journal["state"] = "conflict";
      await persistJournal(libraryRoot, journal);
      return journal;
    }
    if (raw["action"] === "create") {
      const temp = await resolveManagedPath(libraryRoot, raw["temp"] as string, { mustExist: true });
      try {
        await link(temp, targetPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          raw["status"] = "conflict";
          journal["state"] = "conflict";
          await persistJournal(libraryRoot, journal);
          return journal;
        }
        throw error;
      }
    } else if (raw["action"] === "replace" || raw["action"] === "remove_generated") {
      const displaced = await resolveManagedPath(libraryRoot, raw["displaced"] as string);
      await rename(targetPath, displaced);
      const displacedFingerprint = await fingerprintFile(displaced);
      if (!sameFingerprint(displacedFingerprint, raw["expected_before"])) {
        // Restore only into an empty name. A new external occupant must survive.
        try { await link(displaced, targetPath); await unlink(displaced); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
        raw["status"] = "conflict";
        journal["state"] = "conflict";
        await persistJournal(libraryRoot, journal);
        return journal;
      }
      raw["status"] = "displaced";
      await persistJournal(libraryRoot, journal);
      fault?.(`after_displace_${index}`);
      if (raw["action"] === "replace") {
        const temp = await resolveManagedPath(libraryRoot, raw["temp"] as string, { mustExist: true });
        try { await link(temp, targetPath); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          raw["status"] = "conflict";
          journal["state"] = "conflict";
          await persistJournal(libraryRoot, journal);
          return journal;
        }
      }
    } else {
      throw new TypeError(`Unsupported transaction action ${String(raw["action"])}`);
    }
    if (raw["action"] !== "remove_generated") {
      const installed = await fingerprintFile(targetPath);
      if (!sameFingerprint(installed, object(raw["staged_after"]))) throw new TypeError("Installed bytes do not match staged_after");
      raw["installed"] = installed;
    }
    raw["status"] = "installed";
    await persistJournal(libraryRoot, journal);
    fault?.(`after_install_${index}`);
  }
  journal["state"] = "committed";
  await persistJournal(libraryRoot, journal);
  fault?.("after_commit");
  return journal;
}

async function unlinkIfFingerprint(filePath: string, expected: JsonObject | undefined): Promise<boolean> {
  const observed = await existsFingerprint(filePath);
  if (!observed) return true;
  if (!expected || !sameFingerprint(observed, expected)) return false;
  await unlink(filePath);
  return true;
}

async function unlinkOwnedTransactionPath(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

async function cleanupResourceSpools(libraryRoot: string, journal: JsonObject): Promise<boolean> {
  const spools = journal["spools"];
  if (!Array.isArray(spools)) return true;
  for (const raw of spools) {
    if (!isJsonObject(raw) || typeof raw["path"] !== "string") continue;
    const spoolPath = await resolveManagedPath(libraryRoot, raw["path"]);
    const observed = await existsFingerprint(spoolPath);
    if (!observed) {
      raw["status"] = "cleaned";
      continue;
    }
    const expected = object(raw["observed"]) ?? object(raw["expected"]);
    if (!expected || !sameFingerprint(observed, expected)) {
      raw["status"] = "conflict";
      return false;
    }
    if (!isJsonObject(raw["observed"])) raw["observed"] = { ...observed };
    await unlink(spoolPath);
    raw["status"] = "cleaned";
  }
  return true;
}

export async function rollbackJournal(libraryRoot: string, journalInput: JsonObject): Promise<JsonObject> {
  const journal = structuredClone(journalInput);
  const targets = journal["targets"];
  if (!Array.isArray(targets)) throw new TypeError("Journal targets are missing");
  if (journal["state"] !== "planned") {
    journal["state"] = "rolling_back";
    await persistJournal(libraryRoot, journal);
  }
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const raw = targets[index];
    if (!isJsonObject(raw) || typeof raw["path"] !== "string") continue;
    const targetPath = await resolveManagedPath(libraryRoot, raw["path"]);
    if (raw["action"] === "create") {
      const current = await existsFingerprint(targetPath);
      const ownedInstalled = object(raw["installed"]) ?? object(raw["staged_after"]);
      if (current) {
        if (!ownedInstalled || !sameFingerprint(current, ownedInstalled)) {
          raw["status"] = "conflict";
          journal["state"] = "conflict";
          await persistJournal(libraryRoot, journal);
          return journal;
        }
        await unlink(targetPath);
      }
    } else if (raw["action"] === "replace" || raw["action"] === "remove_generated") {
      const displaced = await resolveManagedPath(libraryRoot, raw["displaced"] as string);
      const displacedFingerprint = await existsFingerprint(displaced);
      if (displacedFingerprint) {
        if (!sameFingerprint(displacedFingerprint, object(raw["expected_before"]))) {
          raw["status"] = "conflict";
          journal["state"] = "conflict";
          await persistJournal(libraryRoot, journal);
          return journal;
        }
        const current = await existsFingerprint(targetPath);
        const ownedInstalled = object(raw["installed"]) ?? object(raw["staged_after"]);
        if (current && (raw["action"] === "remove_generated" || !ownedInstalled || !sameFingerprint(current, ownedInstalled))) {
          raw["status"] = "conflict";
          journal["state"] = "conflict";
          await persistJournal(libraryRoot, journal);
          return journal;
        }
        if (current) await unlink(targetPath);
        try { await link(displaced, targetPath); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          raw["status"] = "conflict";
          journal["state"] = "conflict";
          await persistJournal(libraryRoot, journal);
          return journal;
        }
        await unlink(displaced);
      } else if (raw["status"] === "displaced" || raw["status"] === "installed") {
        raw["status"] = "conflict";
        journal["state"] = "conflict";
        await persistJournal(libraryRoot, journal);
        return journal;
      }
    }
    if (typeof raw["temp"] === "string") {
      const temp = await resolveManagedPath(libraryRoot, raw["temp"]);
      const staged = object(raw["staged_after"]);
      if (staged) await unlinkIfFingerprint(temp, staged);
      else await unlinkOwnedTransactionPath(temp);
    }
    raw["status"] = "rolled_back";
    delete raw["installed"];
  }
  if (!(await cleanupResourceSpools(libraryRoot, journal))) {
    journal["state"] = "conflict";
    await persistJournal(libraryRoot, journal);
    return journal;
  }
  journal["state"] = "rolled_back";
  await persistJournal(libraryRoot, journal);
  return journal;
}

export async function recoverJournal(libraryRoot: string, transaction: string): Promise<JsonObject> {
  const journal = await readJournal(libraryRoot, transaction);
  if (journal["state"] === "committed") return journal;
  if (journal["state"] === "conflict" || journal["state"] === "cleaned" || journal["state"] === "rolled_back") return journal;
  return rollbackJournal(libraryRoot, journal);
}

export async function cleanupJournal(libraryRoot: string, journalInput: JsonObject): Promise<JsonObject> {
  const journal = structuredClone(journalInput);
  if (journal["state"] !== "committed" && journal["state"] !== "rolled_back") throw new TypeError("Only committed or rolled-back journals can be cleaned");
  const targets = journal["targets"];
  if (!Array.isArray(targets)) throw new TypeError("Journal targets are missing");
  for (const raw of targets) {
    if (!isJsonObject(raw)) continue;
    if (typeof raw["temp"] === "string") {
      const temp = await resolveManagedPath(libraryRoot, raw["temp"]);
      if (!(await unlinkIfFingerprint(temp, object(raw["staged_after"])))) throw new TypeError("Staged cleanup ownership mismatch");
    }
    if (typeof raw["displaced"] === "string") {
      const displaced = await resolveManagedPath(libraryRoot, raw["displaced"]);
      if (!(await unlinkIfFingerprint(displaced, raw["expected_before"] as JsonObject))) throw new TypeError("Displaced cleanup ownership mismatch");
    }
  }
  if (!(await cleanupResourceSpools(libraryRoot, journal))) throw new TypeError("Resource spool cleanup ownership mismatch");
  journal["state"] = "cleaned";
  await persistJournal(libraryRoot, journal);
  return journal;
}

export async function removeCleanJournalFiles(libraryRoot: string, transaction: string): Promise<void> {
  const root = await resolveManagedPath(libraryRoot, `Data/Transactions/${transaction}`);
  for (const file of ["journal.json", "journal.json.tmp"]) {
    try { await unlink(path.join(root, file)); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  for (const directory of ["staged", "displaced", "resources"]) {
    try { await rmdir(path.join(root, directory)); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTEMPTY"].includes(String(error.code))) throw error;
    }
  }
  try { await rmdir(root); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTEMPTY"].includes(String(error.code))) throw error;
  }
}
