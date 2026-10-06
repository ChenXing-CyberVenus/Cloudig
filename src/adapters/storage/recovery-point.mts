import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import {
  serializeLibrary,
  serializeDeterministic,
  serializeTimeSystem,
  validateLibrary,
  validateTimeSystem
} from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "./journal.mts";
import { resolveManagedPath } from "./path.mts";
import { fingerprintFile, type ByteFingerprint } from "./stream.mts";
import { acquireSingleWriter } from "./writer-lock.mts";

const CURRENT_LIBRARY = "cloudig-library.json";
const CURRENT_TIME = "Data/State/content-time.json";
const PREVIOUS_LIBRARY = "Data/Recovery/Previous/cloudig-library.json";
const PREVIOUS_TIME = "Data/Recovery/Previous/content-time.json";
const PREVIOUS_MANIFEST = "Data/Recovery/Previous/manifest.json";

export type AuthorityPair = Readonly<{
  library: JsonObject;
  time: JsonObject;
  libraryBytes: Buffer;
  timeBytes: Buffer;
  libraryFingerprint: ByteFingerprint;
  timeFingerprint: ByteFingerprint;
}>;

function fingerprint(bytes: Buffer): ByteFingerprint {
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function parseObject(bytes: Buffer, label: string): JsonObject {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isJsonObject(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

export function validateAuthorityPairBytes(libraryBytes: Buffer, timeBytes: Buffer): AuthorityPair {
  const library = parseObject(libraryBytes, "Library");
  const time = parseObject(timeBytes, "Time System");
  const libraryValidation = validateLibrary(library);
  if (!libraryValidation.ok) throw new TypeError(`Library is invalid: ${libraryValidation.issues.map((entry) => entry.code).join(",")}`);
  const timeValidation = validateTimeSystem(time);
  if (!timeValidation.ok) throw new TypeError(`Time System is invalid: ${timeValidation.issues.map((entry) => entry.code).join(",")}`);
  const timeFingerprint = fingerprint(timeBytes);
  const descriptor = library["content_time"];
  if (
    !isJsonObject(descriptor)
    || descriptor["schema"] !== time["schema"]
    || descriptor["revision"] !== time["revision"]
    || descriptor["sha256"] !== timeFingerprint.sha256
  ) {
    throw new TypeError("Library content_time descriptor does not match the Time System bytes");
  }
  return {
    library,
    time,
    libraryBytes,
    timeBytes,
    libraryFingerprint: fingerprint(libraryBytes),
    timeFingerprint
  };
}

export async function readCurrentAuthorityPair(libraryRoot: string): Promise<AuthorityPair> {
  const libraryPath = await resolveManagedPath(libraryRoot, CURRENT_LIBRARY, { mustExist: true });
  const timePath = await resolveManagedPath(libraryRoot, CURRENT_TIME, { mustExist: true });
  return validateAuthorityPairBytes(await readFile(libraryPath), await readFile(timePath));
}

export async function readPreviousAuthorityPair(libraryRoot: string): Promise<AuthorityPair> {
  const libraryPath = await resolveManagedPath(libraryRoot, PREVIOUS_LIBRARY, { mustExist: true });
  const timePath = await resolveManagedPath(libraryRoot, PREVIOUS_TIME, { mustExist: true });
  const manifestPath = await resolveManagedPath(libraryRoot, PREVIOUS_MANIFEST, { mustExist: true });
  const libraryBytes = await readFile(libraryPath);
  const timeBytes = await readFile(timePath);
  const pair = validateAuthorityPairBytes(libraryBytes, timeBytes);
  const manifest = parseObject(await readFile(manifestPath), "Recovery manifest");
  const library = isJsonObject(manifest["library"]) ? manifest["library"] : undefined;
  const time = isJsonObject(manifest["time"]) ? manifest["time"] : undefined;
  if (
    manifest["schema"] !== "cloudig/recovery-point/1.0.0"
    || !library
    || !time
    || library["revision"] !== pair.library["revision"]
    || library["bytes"] !== pair.libraryFingerprint.bytes
    || library["sha256"] !== pair.libraryFingerprint.sha256
    || time["revision"] !== pair.time["revision"]
    || time["bytes"] !== pair.timeFingerprint.bytes
    || time["sha256"] !== pair.timeFingerprint.sha256
  ) throw new TypeError("Recovery manifest does not match previous authority bytes");
  return pair;
}

function recoveryManifest(pair: AuthorityPair, recordedAt: string): JsonObject {
  return {
    schema: "cloudig/recovery-point/1.0.0",
    recorded_at: recordedAt,
    library: {
      path: CURRENT_LIBRARY,
      revision: pair.library["revision"]!,
      ...pair.libraryFingerprint
    },
    time: {
      path: CURRENT_TIME,
      revision: pair.time["revision"]!,
      ...pair.timeFingerprint
    }
  };
}

async function fingerprintIfExists(filePath: string): Promise<ByteFingerprint | undefined> {
  try {
    return await fingerprintFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function target(path: string, observed: ByteFingerprint | undefined, kind: "library" | "time_system" | "recovery_manifest"): JsonObject {
  return {
    action: observed ? "replace" : "create",
    path,
    status: "planned",
    expected_before: observed ? { state: "present", ...observed } : { state: "missing" },
    semantic: { kind }
  };
}

export async function capturePreviousAuthority(
  libraryRoot: string,
  options: Readonly<{
    transaction: string;
    recordedAt: string;
    alreadyCapturedThisBatch: boolean;
  }>
): Promise<"captured" | "unchanged" | "skipped_batch" | "conflict"> {
  if (options.alreadyCapturedThisBatch) return "skipped_batch";
  const pair = await readCurrentAuthorityPair(libraryRoot);
  const previousLibraryPath = await resolveManagedPath(libraryRoot, PREVIOUS_LIBRARY);
  const previousTimePath = await resolveManagedPath(libraryRoot, PREVIOUS_TIME);
  const previousManifestPath = await resolveManagedPath(libraryRoot, PREVIOUS_MANIFEST);
  const observedLibrary = await fingerprintIfExists(previousLibraryPath);
  const observedTime = await fingerprintIfExists(previousTimePath);
  if (
    observedLibrary
    && observedTime
    && observedLibrary.sha256 === pair.libraryFingerprint.sha256
    && observedLibrary.bytes === pair.libraryFingerprint.bytes
    && observedTime.sha256 === pair.timeFingerprint.sha256
    && observedTime.bytes === pair.timeFingerprint.bytes
  ) return "unchanged";

  const manifestBytes = Buffer.from(serializeDeterministic(recoveryManifest(pair, options.recordedAt)), "utf8");
  const observedManifest = await fingerprintIfExists(previousManifestPath);
  const journal: JsonObject = {
    schema: "cloudig/transaction/1.0.0",
    transaction: options.transaction,
    state: "planned",
    intent: "refresh-recovery-point",
    created_at: options.recordedAt,
    updated_at: options.recordedAt,
    authority: {
      library: { state: "present", revision: pair.library["revision"]!, sha256: pair.libraryFingerprint.sha256 },
      time: { state: "present", revision: pair.time["revision"]!, sha256: pair.timeFingerprint.sha256 }
    },
    targets: [
      target(PREVIOUS_LIBRARY, observedLibrary, "library"),
      target(PREVIOUS_TIME, observedTime, "time_system"),
      target(PREVIOUS_MANIFEST, observedManifest, "recovery_manifest")
    ]
  };
  const staged = await stageJournalTargets(libraryRoot, journal, new Map([
    [0, Readable.from([pair.libraryBytes])],
    [1, Readable.from([pair.timeBytes])],
    [2, Readable.from([manifestBytes])]
  ]));
  const committed = await installJournal(libraryRoot, staged);
  if (committed["state"] === "conflict") return "conflict";
  const cleaned = await cleanupJournal(libraryRoot, committed);
  await removeCleanJournalFiles(libraryRoot, options.transaction);
  return cleaned["state"] === "cleaned" ? "captured" : "conflict";
}

export async function restorePreviousAuthority(
  libraryRoot: string,
  options: Readonly<{ transaction: string; restoredAt: string }>
): Promise<AuthorityPair> {
  const writer = await acquireSingleWriter(libraryRoot);
  try {
    const previous = await readPreviousAuthorityPair(libraryRoot);
    const currentLibraryPath = await resolveManagedPath(libraryRoot, CURRENT_LIBRARY);
    const currentTimePath = await resolveManagedPath(libraryRoot, CURRENT_TIME);
    const currentLibrary = await fingerprintIfExists(currentLibraryPath);
    const currentTime = await fingerprintIfExists(currentTimePath);
    if (currentLibrary && currentTime) {
      let currentIsValid = false;
      try {
        await readCurrentAuthorityPair(libraryRoot);
        currentIsValid = true;
      } catch {
        // Recovery is only authorized when the current pair is unusable.
      }
      if (currentIsValid) throw new TypeError("Current authority is valid; recovery restore is not applicable");
    }

    const nextTime = structuredClone(previous.time);
    nextTime["revision"] = (nextTime["revision"] as number) + 1;
    nextTime["edited_at"] = options.restoredAt;
    const nextTimeBytes = Buffer.from(serializeTimeSystem(nextTime), "utf8");
    const nextTimeFingerprint = fingerprint(nextTimeBytes);
    const nextLibrary = structuredClone(previous.library);
    nextLibrary["revision"] = (nextLibrary["revision"] as number) + 1;
    nextLibrary["edited_at"] = options.restoredAt;
    nextLibrary["content_time"] = {
      schema: "cloudig/time-system/1.0.0",
      revision: nextTime["revision"]!,
      sha256: nextTimeFingerprint.sha256
    };
    const nextLibraryBytes = Buffer.from(serializeLibrary(nextLibrary), "utf8");
    const targetFor = (path: string, observed: ByteFingerprint | undefined, kind: "library" | "time_system"): JsonObject => ({
      action: observed ? "replace" : "create",
      path,
      status: "planned",
      expected_before: observed ? { state: "present", ...observed } : { state: "missing" },
      semantic: { kind }
    });
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: options.transaction,
      state: "planned",
      intent: "restore-recovery-point",
      created_at: options.restoredAt,
      updated_at: options.restoredAt,
      authority: {
        library: currentLibrary ? { state: "unusable", ...currentLibrary } : { state: "missing" },
        time: currentTime ? { state: "unusable", ...currentTime } : { state: "missing" }
      },
      targets: [
        targetFor(CURRENT_LIBRARY, currentLibrary, "library"),
        targetFor(CURRENT_TIME, currentTime, "time_system")
      ]
    };
    const staged = await stageJournalTargets(libraryRoot, journal, new Map([
      [0, Readable.from([nextLibraryBytes])],
      [1, Readable.from([nextTimeBytes])]
    ]));
    const committed = await installJournal(libraryRoot, staged);
    if (committed["state"] !== "committed") throw new TypeError(`Recovery restore did not commit: ${String(committed["state"])}`);
    const restored = await readCurrentAuthorityPair(libraryRoot);
    const cleaned = await cleanupJournal(libraryRoot, committed);
    await removeCleanJournalFiles(libraryRoot, options.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Recovery restore cleanup failed");
    return restored;
  } finally {
    await writer.release();
  }
}
