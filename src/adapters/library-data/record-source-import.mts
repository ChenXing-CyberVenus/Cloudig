import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isJsonObject } from "../../core/contracts/types.mts";
import { parseRecordJson } from "../../core/records/json.mts";
import { chooseNoReplaceLeaf } from "../storage/names.mts";
import { commitRecords, resolveRecordPath, withRecordSnapshot, type RecordChange, type RecordStoreFault } from "../storage/record-store.mts";
import { fingerprintFile } from "../storage/stream.mts";
import { cleanupRecordPicker, prepareRecordPicker } from "./record-picker.mts";
import { fileTimesCapture, validCaptureTime, type CapturedSourceTime } from "../../core/records/source-time.mts";
import { officialAssetDirectory } from "../parser/official-json-assets.mts";

const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
export const RECORD_IMPORT_LIMITS = Object.freeze({ originBytes: 4096 });
export const recordImportOriginPath = (relative: string): string => `appdata/imports/${createHash("sha256").update(relative).digest("hex")}.json`;

/** Optional import fact, not authority over the Inbox file. Changed bytes invalidate it. */
export async function readRecordImportCapture(root: string, relative: string, sha256: string): Promise<CapturedSourceTime | undefined> {
  if (!/^Inbox\/[^/]+$/u.test(relative)) return undefined;
  try {
    const file = await resolveRecordPath(root, recordImportOriginPath(relative)); if ((await stat(file)).size > RECORD_IMPORT_LIMITS.originBytes) return undefined;
    const raw = parseRecordJson(await readFile(file, "utf8"));
    if (!isJsonObject(raw) || raw["schema"] !== "cloudig/source-import/1.0.0" || raw["path"] !== relative || raw["sha256"] !== sha256) return undefined;
    if (isJsonObject(raw["file_times"])) return fileTimesCapture(raw["file_times"]["created_at"], raw["file_times"]["modified_at"]);
    const captured = raw["captured"];
    // Preserve valid original facts; unusable legacy facts cannot veto the
    // current file's creation/write fallback or invent which original field won.
    if (!isJsonObject(captured) || !["filesystem:creation_time", "filesystem:last_write_time"].includes(String(captured["from"]))) return undefined;
    const at = validCaptureTime(captured["at"]);
    return at ? { at, from: String(captured["from"]) } : undefined;
  } catch (e) { if (missing(e) || e instanceof TypeError || e instanceof SyntaxError) return undefined; throw e; }
}

/** Prefer valid original import facts; otherwise use the existing file's valid times. */
export async function fileCaptureTime(filePath: string, sourceSha256?: string): Promise<CapturedSourceTime | undefined> {
  if (sourceSha256 && path.basename(path.dirname(filePath)) === "Inbox") {
    const imported = await readRecordImportCapture(path.dirname(path.dirname(filePath)), `Inbox/${path.basename(filePath)}`, sourceSha256);
    if (imported) return imported;
  }
  const file = await stat(filePath);
  return fileTimesCapture(file.birthtimeMs, file.mtimeMs);
}

/** Large source bytes use the same journal as their tiny capture fact, without an in-memory copy. */
export async function importRecordPicker(root: string, runtimeRoot: string, pickerToken: string, options: { signal?: AbortSignal; fault?: (point: RecordStoreFault) => void | Promise<void>; onProgress?: (completed: number, total: number) => void } = {}) {
  options.signal?.throwIfAborted(); const picker = await prepareRecordPicker(runtimeRoot, pickerToken);
  // Avatar selection shares this picker transport, but has no source-capture
  // semantics. Only a source import must prove the timestamp's original field.
  if (picker.capturedAt && !picker.capturedFrom)
    throw new TypeError("导入暂存缺少采集时间来源，请重新选择原文件；现有文件未修改。 / Capture provenance is missing; select the original file again.");
  const prepared = await withRecordSnapshot(root, async () => {
    const inbox = await resolveRecordPath(root, "Inbox"), entries = await readdir(inbox);
    const occupied = new Set([...entries, ...entries.filter(n => /\.json\.assets$/iu.test(n)).map(n => n.slice(0, -7))]);
    const leaf = chooseNoReplaceLeaf(picker.filename, occupied), relative = `Inbox/${leaf}`;
    const createdAt = picker.createdAt ?? (picker.capturedFrom === "filesystem:creation_time" ? picker.capturedAt : undefined);
    const modifiedAt = picker.modifiedAt ?? (picker.capturedFrom === "filesystem:last_write_time" ? picker.capturedAt : undefined);
    const capture = fileTimesCapture(createdAt, modifiedAt);
    const changes: RecordChange[] = [{ action: "import", path: relative, expected: null, source: () => createReadStream(picker.payloadPath), ...picker.fingerprint,
      ...(picker.modifiedAt ?? picker.capturedAt ? { modifiedAt: picker.modifiedAt ?? picker.capturedAt! } : {}), ...(options.onProgress ? { onProgress: bytes => options.onProgress!(bytes, picker.fingerprint.bytes) } : {}) }];
    for (const asset of picker.assets) changes.push({ action: "import", path: `${officialAssetDirectory(relative)}/${asset.leaf}`, expected: null, source: () => createReadStream(asset.payloadPath), ...asset.fingerprint });
    {
      const target = recordImportOriginPath(relative); let expected: string | null = null;
      try { expected = (await fingerprintFile(await resolveRecordPath(root, target))).sha256; } catch (e) { if (!missing(e)) throw e; }
      changes.push({ action: "binary", path: target, expected, data: Buffer.from(JSON.stringify({ schema: "cloudig/source-import/1.0.0", path: relative, sha256: picker.fingerprint.sha256,
        captured: capture ?? null, file_times: { ...(createdAt ? { created_at: createdAt } : {}), ...(modifiedAt ? { modified_at: modifiedAt } : {}) } }, null, 2) + "\n") });
    }
    return { changes, relative };
  });
  const result = await commitRecords(root, prepared.changes, { ...options, preflight: async () => {
    const current = await prepareRecordPicker(runtimeRoot, pickerToken); if (current.fingerprint.sha256 !== picker.fingerprint.sha256 || current.manifestFingerprint.sha256 !== picker.manifestFingerprint.sha256
      || JSON.stringify(current.assets) !== JSON.stringify(picker.assets) || JSON.stringify(current.auxiliary) !== JSON.stringify(picker.auxiliary)) throw new TypeError("Selected source changed before import");
  } });
  const warnings = [...(result?.maintenanceWarnings ?? [])]; let cleaned = false;
  try { cleaned = await cleanupRecordPicker(runtimeRoot, picker); } catch { /* Successful import stays successful. Owned cache exits later. */ }
  if (!cleaned) warnings.push("Source imported; temporary picker cleanup is pending");
  return { status: "imported" as const, path: prepared.relative, filename: path.basename(prepared.relative), fingerprint: picker.fingerprint, pickerCleaned: cleaned, maintenanceWarnings: warnings };
}
