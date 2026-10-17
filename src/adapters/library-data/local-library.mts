import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { createInitialAuthority, type InitialAuthority } from "../../app/library/defaults.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";
import { cleanupJournal, installJournal, readJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { readCurrentAuthorityPair, readPreviousAuthorityPair, type AuthorityPair } from "../storage/recovery-point.mts";

const DIRECTORIES = [
  "Inbox",
  "Conversations",
  "Exports",
  "Data/State",
  "Data/Assets/User",
  "Data/Indexes",
  "Data/Transactions",
  "Data/Recovery/Previous",
  "Data/Runtime",
  "Data/Logs"
] as const;

async function rootState(root: string): Promise<"missing" | "empty" | "nonempty" | "not_directory"> {
  try {
    const observed = await stat(root);
    if (!observed.isDirectory()) return "not_directory";
    return (await readdir(root)).length === 0 ? "empty" : "nonempty";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function createJournal(initial: InitialAuthority, transaction: string, timestamp: string): JsonObject {
  return {
    schema: "cloudig/transaction/1.0.0",
    transaction,
    state: "planned",
    intent: "create-library",
    created_at: timestamp,
    updated_at: timestamp,
    authority: { library: { state: "missing" }, time: { state: "missing" } },
    targets: [
      {
        action: "create",
        path: "cloudig-library.json",
        status: "planned",
        expected_before: { state: "missing" },
        semantic: { kind: "library" }
      },
      {
        action: "create",
        path: "Data/State/content-time.json",
        status: "planned",
        expected_before: { state: "missing" },
        semantic: { kind: "time_system" }
      }
    ]
  };
}

export async function createLocalLibrary(input: Readonly<{
  root: string;
  transaction: string;
  timestamp: string;
  localDate: string;
  offset: string;
  language: "zh-CN" | "en";
}>): Promise<AuthorityPair> {
  const state = await rootState(input.root);
  if (state === "not_directory" || state === "nonempty") throw new TypeError("Library target must be missing or an explicitly empty directory");
  if (state === "missing") await mkdir(input.root, { recursive: false });
  for (const relative of DIRECTORIES) await mkdir(path.join(input.root, ...relative.split("/")), { recursive: true });
  const writer = await acquireSingleWriter(input.root);
  try {
    const initial = createInitialAuthority(input);
    const staged = await stageJournalTargets(input.root, createJournal(initial, input.transaction, input.timestamp), new Map([
      [0, Readable.from([initial.libraryBytes])],
      [1, Readable.from([initial.timeBytes])]
    ]));
    const committed = await installJournal(input.root, staged);
    if (committed["state"] !== "committed") throw new TypeError(`Library creation did not commit: ${String(committed["state"])}`);
    const pair = await readCurrentAuthorityPair(input.root);
    const cleaned = await cleanupJournal(input.root, committed);
    await removeCleanJournalFiles(input.root, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Library creation cleanup failed");
    return pair;
  } finally {
    await writer.release();
  }
}

export type LibraryInspection =
  | Readonly<{ status: "valid"; pair: AuthorityPair }>
  | Readonly<{ status: "transaction_recovery"; transactions: readonly string[] }>
  | Readonly<{ status: "recovery_available"; previous: AuthorityPair; currentError: string }>
  | Readonly<{ status: "unsupported"; schema: string }>
  | Readonly<{ status: "unsafe"; currentError: string; previousError?: string }>
  | Readonly<{ status: "missing" }>;

async function unresolvedTransactions(root: string): Promise<string[]> {
  const directory = path.join(root, "Data", "Transactions");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const unresolved: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^x_[A-Z2-7]{16,52}$/u.test(entry.name)) continue;
    try {
      const journal = await readJournal(root, entry.name);
      if (!["cleaned", "rolled_back"].includes(String(journal["state"]))) unresolved.push(entry.name);
    } catch {
      unresolved.push(entry.name);
    }
  }
  return unresolved.sort();
}

export async function inspectLocalLibrary(root: string): Promise<LibraryInspection> {
  const observedRoot = await rootState(root);
  if (observedRoot === "missing" || observedRoot === "empty") return { status: "missing" };
  const transactions = await unresolvedTransactions(root);
  if (transactions.length > 0) return { status: "transaction_recovery", transactions };
  try {
    return { status: "valid", pair: await readCurrentAuthorityPair(root) };
  } catch (currentError) {
    try {
      const raw = JSON.parse(await readFile(path.join(root, "cloudig-library.json"), "utf8")) as unknown;
      if (raw && typeof raw === "object" && "schema" in raw && typeof raw.schema === "string" && raw.schema !== "cloudig/library/1.0.0") {
        return { status: "unsupported", schema: raw.schema };
      }
    } catch {
      // The bounded current error below remains authoritative.
    }
    const message = currentError instanceof Error ? currentError.message : "Current authority is invalid";
    try {
      return { status: "recovery_available", previous: await readPreviousAuthorityPair(root), currentError: message };
    } catch (previousError) {
      return {
        status: "unsafe",
        currentError: message,
        ...(previousError instanceof Error ? { previousError: previousError.message } : {})
      };
    }
  }
}
