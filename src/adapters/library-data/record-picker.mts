import { createHash } from "node:crypto";
import { lstat, open, readFile, rmdir, unlink } from "node:fs/promises";
import { parseRecordJson } from "../../core/records/json.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { resolveRecordPath } from "../storage/record-store.mts";
import { safeWindowsLeaf } from "../storage/names.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };
import type { RecordAvatarBytes } from "./record-identity.mts";
import { officialAssetLeaf } from "../parser/official-json-assets.mts";

export const RECORD_PICKER_LIMITS = Object.freeze({ manifestBytes: 8192, signatureBytes: 16, companionManifestBytes: 4 * 1024 * 1024, companionFiles: 10000 });
export const RECORD_PICKER_TOKEN = /^p_[A-Za-z0-9_-]{43}$/u;
export type PreparedPickerAsset = Readonly<{ key: string; leaf: string; payloadPath: string; fingerprint: ByteFingerprint }>;
export type PreparedRecordPicker = Readonly<{ picker: string; filename: string; fingerprint: ByteFingerprint; payloadPath: string; manifestPath: string; manifestFingerprint: ByteFingerprint; capturedAt?: string; capturedFrom?: string; createdAt?: string; modifiedAt?: string;
  assets: readonly PreparedPickerAsset[]; auxiliary: readonly Readonly<{ leaf: string; fingerprint: ByteFingerprint }>[] }>;
function relative(token: string, leaf: string): string {
  if (!RECORD_PICKER_TOKEN.test(token)) throw new TypeError("Invalid picker capability");
  return `Pickers/${token}/${leaf}`;
}
/** runtimeRoot is the existing owned cache session, never the Library or AppData. */
export async function prepareRecordPicker(runtimeRoot: string, token: string, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<PreparedRecordPicker> {
  const manifestPath = await resolveRecordPath(runtimeRoot, relative(token, "manifest.json")), payloadPath = await resolveRecordPath(runtimeRoot, relative(token, "payload.bin"));
  const [manifestStat, payloadStat] = await Promise.all([lstat(manifestPath), lstat(payloadPath)]);
  if (!manifestStat.isFile() || manifestStat.size > RECORD_PICKER_LIMITS.manifestBytes || !payloadStat.isFile() || payloadStat.size > maximumBytes) throw new TypeError("Picker file is unavailable or exceeds its limit");
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > RECORD_PICKER_LIMITS.manifestBytes) throw new TypeError("Picker manifest exceeds its limit");
  const raw = parseRecordJson(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  if (!isJsonObject(raw) || raw["schema"] !== "cloudig/picker/1.0.0" || raw["picker"] !== token
    || typeof raw["filename"] !== "string" || !Number.isSafeInteger(raw["bytes"]) || Number(raw["bytes"]) < 0
    || typeof raw["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(raw["sha256"])
    || raw["captured_at"] !== undefined && (typeof raw["captured_at"] !== "string" || !Number.isFinite(Date.parse(raw["captured_at"])))
    || raw["captured_from"] !== undefined && (raw["captured_at"] === undefined || !["filesystem:creation_time", "filesystem:last_write_time"].includes(String(raw["captured_from"])))
    || raw["modified_at"] !== undefined && (typeof raw["modified_at"] !== "string" || !Number.isFinite(Date.parse(raw["modified_at"])))
    || raw["created_at"] !== undefined && (typeof raw["created_at"] !== "string" || !Number.isFinite(Date.parse(raw["created_at"])))
    || Object.keys(raw).some(k => !["schema", "picker", "filename", "bytes", "sha256", "captured_at", "captured_from", "created_at", "modified_at"].includes(k))) throw new TypeError("Invalid picker manifest");
  const fingerprint = await fingerprintFile(payloadPath);
  if (fingerprint.bytes > maximumBytes || fingerprint.bytes !== raw["bytes"] || fingerprint.sha256 !== raw["sha256"]) throw new TypeError("Picker bytes changed after selection");
  const assets: PreparedPickerAsset[] = [], auxiliary: { leaf: string; fingerprint: ByteFingerprint }[] = [];
  for (const leaf of ["assets-plan.json", "assets.json"]) {
    const file = await resolveRecordPath(runtimeRoot, relative(token, leaf));
    let info; try { info = await lstat(file); } catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") continue; throw e; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > RECORD_PICKER_LIMITS.companionManifestBytes) throw new TypeError("Companion manifest exceeds its limit");
    const bytes = await readFile(file); if (bytes.length > RECORD_PICKER_LIMITS.companionManifestBytes) throw new TypeError("Companion manifest exceeds its limit");
    const document = parseRecordJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isJsonObject(document) || document["source_sha256"] !== fingerprint.sha256 || !["grok", "mistral"].includes(String(document["platform"]))) throw new TypeError("Companion manifest belongs to another source");
    auxiliary.push({ leaf, fingerprint: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
    if (leaf === "assets-plan.json") continue;
    if (document["schema"] !== "cloudig/picker-assets/1.0.0" || !Array.isArray(document["items"]) || document["items"].length > RECORD_PICKER_LIMITS.companionFiles) throw new TypeError("Invalid companion manifest");
    const seen = new Set<string>();
    for (const value of document["items"]) {
      if (!isJsonObject(value) || typeof value["key"] !== "string" || typeof value["sha256"] !== "string" || !Number.isSafeInteger(value["bytes"]) || Number(value["bytes"]) < 0) throw new TypeError("Invalid companion entry");
      const assetLeaf = officialAssetLeaf(String(document["platform"]), value["key"]);
      if (value["leaf"] !== assetLeaf || seen.has(assetLeaf)) throw new TypeError("Invalid or duplicate companion filename"); seen.add(assetLeaf);
      const payloadPath = await resolveRecordPath(runtimeRoot, relative(token, assetLeaf)), actual = await fingerprintFile(payloadPath);
      if (actual.sha256 !== value["sha256"] || actual.bytes !== value["bytes"]) throw new TypeError("Companion bytes changed after selection");
      assets.push({ key: value["key"], leaf: assetLeaf, payloadPath, fingerprint: actual });
    }
  }
  return { picker: token, filename: safeWindowsLeaf(raw["filename"], "selected filename"), payloadPath, manifestPath, fingerprint, assets, auxiliary,
    manifestFingerprint: { bytes: manifestBytes.length, sha256: createHash("sha256").update(manifestBytes).digest("hex") },
    ...(typeof raw["captured_at"] === "string" ? { capturedAt: new Date(raw["captured_at"]).toISOString() } : {}),
    ...(typeof raw["captured_from"] === "string" ? { capturedFrom: raw["captured_from"] } : {}),
    ...(typeof raw["created_at"] === "string" ? { createdAt: new Date(raw["created_at"]).toISOString() } : {}),
    ...(typeof raw["modified_at"] === "string" ? { modifiedAt: new Date(raw["modified_at"]).toISOString() } : {}) };
}
export async function cleanupRecordPicker(runtimeRoot: string, picker: PreparedRecordPicker): Promise<boolean> {
  // Re-resolve both exact paths: never follow a replaced junction during cleanup.
  const files: (readonly [string, ByteFingerprint])[] = [["payload.bin", picker.fingerprint], ["manifest.json", picker.manifestFingerprint],
    ...picker.assets.map(a => [a.leaf, a.fingerprint] as const), ...picker.auxiliary.map(a => [a.leaf, a.fingerprint] as const)];
  for (const [leaf, expected] of files) {
    const file = await resolveRecordPath(runtimeRoot, relative(picker.picker, leaf));
    try { const actual = await fingerprintFile(file); if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) return false; }
    catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
  }
  for (const [leaf] of files) await unlink(await resolveRecordPath(runtimeRoot, relative(picker.picker, leaf))).catch(e => { if (e.code !== "ENOENT") throw e; });
  try { await rmdir(await resolveRecordPath(runtimeRoot, `Pickers/${picker.picker}`)); return true; }
  catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return true; if (e instanceof Error && "code" in e && e.code === "ENOTEMPTY") return false; throw e; }
}
export async function prepareRecordAvatar(runtimeRoot: string, token: string) {
  const picker = await prepareRecordPicker(runtimeRoot, token, resourceLimits.avatar_file_max_bytes), handle = await open(picker.payloadPath, "r");
  let extension: RecordAvatarBytes["extension"];
  try {
    const header = Buffer.alloc(RECORD_PICKER_LIMITS.signatureBytes), { bytesRead } = await handle.read(header, 0, header.length, 0), value = header.subarray(0, bytesRead);
    if (value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = "png";
    else if (value.length >= 3 && value[0] === 255 && value[1] === 216 && value[2] === 255) extension = "jpg";
    else if (["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString("ascii"))) extension = "gif";
    else if (value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") extension = "webp";
    else throw new TypeError("Select a PNG, JPEG, GIF or WebP avatar");
  } finally { await handle.close(); }
  return { picker, extension };
}
export async function readPreparedRecordAvatar(prepared: Awaited<ReturnType<typeof prepareRecordAvatar>>, signal?: AbortSignal): Promise<RecordAvatarBytes> {
  const bytes = await readFile(prepared.picker.payloadPath, { ...(signal ? { signal } : {}) });
  if (bytes.length > resourceLimits.avatar_file_max_bytes || bytes.length !== prepared.picker.fingerprint.bytes || createHash("sha256").update(bytes).digest("hex") !== prepared.picker.fingerprint.sha256) throw new TypeError("Avatar bytes changed after selection");
  return { bytes, extension: prepared.extension };
}
