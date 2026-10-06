import { once } from "node:events";
import { createReadStream } from "node:fs";
import { lstat, readFile, rmdir, unlink } from "node:fs/promises";

import { isJsonObject } from "../../core/contracts/types.mts";
import { safeWindowsLeaf } from "../storage/names.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { importSourceStream, type SourceImportResult } from "./source-import.mts";

const PICKER_TOKEN = /^p_[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_MANIFEST_BYTES = 8_192;

export type PreparedSourcePicker = Readonly<{
  picker: string;
  filename: string;
  fingerprint: ByteFingerprint;
  payloadPath: string;
  manifestPath: string;
  manifestFingerprint: ByteFingerprint;
  capturedAt?: string;
}>;

function pickerRelative(token: string, leaf: string): string {
  if (!PICKER_TOKEN.test(token)) throw new TypeError("Source picker capability is invalid");
  return `Data/Runtime/Pickers/${token}/${leaf}`;
}

async function ordinaryFile(filePath: string, label: string): Promise<void> {
  const observed = await lstat(filePath);
  if (!observed.isFile() || observed.isSymbolicLink()) throw new TypeError(`${label} is not an ordinary file`);
}

export async function prepareSourcePicker(libraryRoot: string, token: string): Promise<PreparedSourcePicker> {
  const manifestPath = await resolveManagedPath(libraryRoot, pickerRelative(token, "manifest.json"), { mustExist: true });
  const payloadPath = await resolveManagedPath(libraryRoot, pickerRelative(token, "payload.bin"), { mustExist: true });
  await Promise.all([ordinaryFile(manifestPath, "Source picker manifest"), ordinaryFile(payloadPath, "Source picker payload")]);
  const manifestFingerprint = await fingerprintFile(manifestPath);
  if (manifestFingerprint.bytes > MAXIMUM_MANIFEST_BYTES) throw new TypeError("Source picker manifest exceeds its bound");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isJsonObject(raw)
    || raw["schema"] !== "cloudig/picker/1.0.0"
    || raw["picker"] !== token
    || typeof raw["filename"] !== "string"
    || typeof raw["bytes"] !== "number"
    || !Number.isSafeInteger(raw["bytes"])
    || raw["bytes"] < 0
    || typeof raw["sha256"] !== "string"
    || !SHA256.test(raw["sha256"])
    || (raw["captured_at"] !== undefined && (typeof raw["captured_at"] !== "string" || !Number.isFinite(Date.parse(raw["captured_at"]))))
    || Object.keys(raw).some((key) => !["schema", "picker", "filename", "bytes", "sha256", "captured_at"].includes(key))) {
    throw new TypeError("Source picker manifest is invalid");
  }
  const filename = safeWindowsLeaf(raw["filename"], "picked filename");
  const fingerprint = await fingerprintFile(payloadPath);
  if (fingerprint.bytes !== raw["bytes"] || fingerprint.sha256 !== raw["sha256"]) {
    throw new TypeError("Source picker payload changed after selection");
  }
  return {
    picker: token,
    filename,
    fingerprint,
    payloadPath,
    manifestPath,
    manifestFingerprint,
    ...(typeof raw["captured_at"] === "string" ? { capturedAt: new Date(raw["captured_at"]).toISOString() } : {})
  };
}

async function unlinkExact(filePath: string, expected: ByteFingerprint): Promise<boolean> {
  try {
    const observed = await fingerprintFile(filePath);
    if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) return false;
    await unlink(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

export async function cleanupPreparedSourcePicker(libraryRoot: string, picker: PreparedSourcePicker): Promise<boolean> {
  if (!(await unlinkExact(picker.payloadPath, picker.fingerprint))) return false;
  if (!(await unlinkExact(picker.manifestPath, picker.manifestFingerprint))) return false;
  const root = await resolveManagedPath(libraryRoot, `Data/Runtime/Pickers/${picker.picker}`, { mustExist: true });
  try {
    await rmdir(root);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTEMPTY"].includes(String(error.code))) throw error;
    if (error.code === "ENOTEMPTY") return false;
  }
  return true;
}

export async function importPreparedSourcePicker(input: Readonly<{
  libraryRoot: string;
  picker: string;
  transaction: string;
  timestamp: string;
  signal?: AbortSignal;
}>): Promise<Readonly<SourceImportResult & { picker_cleaned: boolean }>> {
  const picker = await prepareSourcePicker(input.libraryRoot, input.picker);
  const source = createReadStream(picker.payloadPath);
  try {
    const result = await importSourceStream({
      libraryRoot: input.libraryRoot,
      filename: picker.filename,
      source,
      transaction: input.transaction,
      timestamp: input.timestamp,
      ...(picker.capturedAt ? { capturedAt: picker.capturedAt } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (!source.closed) {
      source.destroy();
      await once(source, "close").catch(() => undefined);
    }
    const pickerCleaned = await cleanupPreparedSourcePicker(input.libraryRoot, picker);
    return { ...result, picker_cleaned: pickerCleaned };
  } catch (error) {
    if (!source.closed) {
      source.destroy();
      await once(source, "close").catch(() => undefined);
    }
    await cleanupPreparedSourcePicker(input.libraryRoot, picker).catch(() => false);
    throw error;
  }
}
