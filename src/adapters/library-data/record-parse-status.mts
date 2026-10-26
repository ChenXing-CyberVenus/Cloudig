import { createHash } from "node:crypto";
import { readFile, readdir, lstat, unlink } from "node:fs/promises";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { parseRecordJson } from "../../core/records/index.mts";
import type { AdapterManifest } from "../../app/parser/adapter.mts";
import { adapterBundleSnapshot, adapterBundleSha256, findSourceAdapter } from "../../app/parser/registry.mts";
import { nextContentFailureAttempts, sourceFailureWatermark } from "../../app/parser/failure-policy.mts";
import { probeExporterManifest, probeExporterCapture } from "../parser/html-envelope.mts";
import { fingerprintFile } from "../storage/stream.mts";
import { resolveRecordPath, withRecordSnapshot } from "../storage/record-store.mts";
import { writeRecordProjection, writeRecordInternalJson } from "../storage/record-projection.mts";
import { readRecordCatalog, uniqueConversation } from "./record-catalog.mts";
import { createRecordHistoryReader, recordHistoryMatches, recordSourceUnitKey, recordSourcePartsFingerprint, type RecordSourcePart } from "./record-parser-commit.mts";
import { fileCaptureTime } from "./record-source-import.mts";
import type { CapturedSourceTime } from "../../core/records/source-time.mts";
import { inspectOfficialJson } from "../parser/official-json-layout.mts";
import { inspectOfficialZip } from "../parser/official-zip.mts";
import { probeAgentFile } from "../parser/agent-json.mts";
import { inspectCodexHeader, resolveCodexChain, type CodexHeader } from "../parser/codex-storage-chain.mts";

const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export type RecordSource = Readonly<{ path: string; bytes: number; sha256: string; modifiedAt: string; captured?: CapturedSourceTime; stamp: string; format: "exporter-html" | "json-container" | "zip-container" | "json" | "jsonl" | "unknown"; platform?: string; adapterId?: string; declaration?: JsonObject; exporterVersion?: string; agentShards?: readonly string[]; agentParts?: readonly RecordSourcePart[]; chainError?: string; missing?: boolean }>;
export type RecordParseUnit = Readonly<{ source: RecordSource; locator?: string }>;
export type RecordParseStatus = Readonly<{ unit: RecordParseUnit; status: "ready" | "parsed" | "failed" | "unsupported" | "missing"; outdated: boolean; error?: string; conversationId?: string }>;
export const unitKey = (unit: RecordParseUnit): JsonObject => recordSourceUnitKey(unit.source.path, unit.source.format, unit.source.platform ?? "unknown", unit.locator);
const failurePath = (unit: RecordParseUnit) => `appdata/parse-failures/${digest(JSON.stringify(unitKey(unit)))}.json`;
async function readObject(root: string, file: string): Promise<JsonObject> {
  try { return object(parseRecordJson(await readFile(await resolveRecordPath(root, file), "utf8"))); }
  catch (e) { if (missing(e) || e instanceof TypeError || e instanceof SyntaxError) return {}; throw e; }
}

/** Cache source observations, not parse results. Header probing never extracts a message. */
export async function scanRecordSources(root: string, options: { includeMissing?: boolean } = {}): Promise<readonly RecordSource[]> {
  // 1.7 adds Zstd probing and derives Codex groups from physical observations;
  // existing 1.6 observations/capture times remain valid. Dropping that cache
  // forces every unchanged multi-GB export through a cold scan on page entry.
  const indexPath = "appdata/indexes/sources.json", prior = await readObject(root, indexPath), currentIndex = prior["schema"] === "cloudig/source-index/1.7.0",
    currentCapturePolicy = currentIndex || prior["schema"] === "cloudig/source-index/1.6.0",
    cached = currentCapturePolicy || ["cloudig/source-index/1.5.0", "cloudig/source-index/1.4.0", "cloudig/source-index/1.3.0", "cloudig/source-index/1.2.0", "cloudig/source-index/1.1.0"].includes(String(prior["schema"])) ? object(prior["files"]) : {}, files: JsonObject = {}, result: RecordSource[] = [];
  for (const entry of await readdir(await resolveRecordPath(root, "Inbox"), { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const relative = `Inbox/${entry.name}`, absolute = await resolveRecordPath(root, relative), info = await lstat(absolute, { bigint: true });
    const stamp = (s: typeof info) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
    const old = object(cached[relative]); let source: RecordSource, manifest: JsonObject | undefined;
    const needsNewProbe = !currentIndex && /\.jsonl\.zst$/iu.test(entry.name);
    const unchanged = !needsNewProbe && (currentCapturePolicy || old["format"] === "exporter-html") && !old["missing"] && old["path"] === relative && old["stamp"] === stamp(info) && /^[a-f0-9]{64}$/u.test(String(old["sha256"])) && Number.isSafeInteger(old["bytes"]) && ["unknown", "exporter-html", "json-container", "zip-container", "json", "jsonl"].includes(String(old["format"]));
    if (unchanged) source = old as unknown as RecordSource;
    else {
      const fingerprint = await fingerprintFile(absolute);
      const format = /\.html?$/iu.test(entry.name) ? "exporter-html" : /\.jsonl(?:\.zst)?$/iu.test(entry.name) ? "jsonl" : /\.json$/iu.test(entry.name) ? "json-container" : /\.zip$/iu.test(entry.name) ? "zip-container" : "unknown";
      manifest = format === "exporter-html" ? await probeExporterManifest(absolute).catch(() => undefined) : undefined;
      const declaration = manifest ? { ...(typeof manifest["platform"] === "string" ? { platform: manifest["platform"] } : {}),
        ...(typeof object(manifest["payload"])["format"] === "string" ? { payload: { format: object(manifest["payload"])["format"]! } } : {}) } : undefined;
      const official = format === "json-container" ? await inspectOfficialJson(absolute, { emptyPlatform: "claude" }).then(layout => layout.platform === "chatgpt" ? undefined : layout).catch(e => { if (e instanceof TypeError || e instanceof SyntaxError) return undefined; throw e; })
        : format === "zip-container" ? await inspectOfficialZip(absolute).catch(e => { if (e instanceof TypeError || e instanceof SyntaxError) return undefined; throw e; }) : undefined;
      const agent = format === "jsonl" ? await probeAgentFile(absolute, "jsonl").catch(e => { if (e instanceof TypeError || e instanceof SyntaxError) return undefined; throw e; })
        : format === "json-container" && !official ? await probeAgentFile(absolute, "json").catch(e => { if (e instanceof TypeError || e instanceof SyntaxError) return undefined; throw e; }) : undefined;
      const effectiveFormat = agent?.format ?? format;
      const platform = agent?.platform ?? official?.platform ?? (typeof declaration?.["platform"] === "string" ? declaration["platform"] : undefined);
      const payload = object(declaration?.["payload"])["format"];
      const exporterVersion = manifest?.["exporter_version"] ?? object(manifest?.["exporter"])["version"];
      const adapter = agent?.adapter ?? (platform && typeof payload === "string" ? findSourceAdapter({ format: "exporter-html", platform, payload }) : undefined);
      const adapterId = agent?.adapter.id ?? (adapter && "manifest" in adapter ? adapter.manifest.id : adapter?.id) ?? (official ? official.platform === "claude" ? "anthropic-claude-export-json" : `${official.platform}-official-json` : undefined);
      if (stamp(info) !== stamp(await lstat(absolute, { bigint: true }))) throw new TypeError("Source changed during list inspection");
      source = { path: relative, ...fingerprint, stamp: stamp(info), modifiedAt: new Date(Number(info.mtimeMs)).toISOString(), format: effectiveFormat,
        ...(platform ? { platform } : {}), ...(adapterId ? { adapterId } : {}), ...(declaration ? { declaration } : {}), ...(typeof exporterVersion === "string" ? { exporterVersion } : {}) };
    }
    if (!unchanged || !currentCapturePolicy) {
      // Upgrade metadata without hashing every large unchanged source again; warm scans reuse it.
      if (!manifest && source.format === "exporter-html") manifest = await probeExporterManifest(absolute).catch(() => undefined);
      const captured = (manifest ? await probeExporterCapture(absolute, manifest).catch(() => undefined) : undefined) ?? await fileCaptureTime(absolute, source.sha256);
      const { captured: _oldCapture, ...facts } = source;
      source = { ...facts, ...(captured ? { captured } : {}) };
      if (stamp(info) !== stamp(await lstat(absolute, { bigint: true }))) throw new TypeError("Source changed during capture-time inspection");
    }
    files[relative] = source as unknown as JsonObject; result.push(source);
  }
  // Keep physical observations cached independently. Group only verified storage
  // ancestry for display/jobs; arbitrary lifeNN filenames are not chain evidence.
  const codex = result.filter(s => s.platform === "codex" && s.format === "jsonl");
  const absolute = new Map(await Promise.all(codex.map(async s => [await resolveRecordPath(root, s.path), s] as const)));
  const headers = new Map(await Promise.all([...absolute.keys()].map(async file => [file, await inspectCodexHeader(file).catch((): CodexHeader => ({}))] as const)));
  const referenced = new Set([...headers.values()].flatMap(h => h.base ? [h.base.id] : []));
  const leaves = [...headers].filter(([, h]) => !h.storageId || !referenced.has(h.storageId));
  const brokenSessions = new Map<string, string>();
  // A known unresolved continuation makes the logical session incomplete.
  // Never publish a convenient earlier prefix over its existing full archive.
  for (const [file, h] of headers) if (h.base && h.sessionId) {
    try { resolveCodexChain(file, headers); }
    catch (e) { brokenSessions.set(h.sessionId, e instanceof Error ? e.message : String(e)); }
  }
  const groups: { members: RecordSource[]; leaf: RecordSource }[] = [];
  for (const [file,h] of leaves) {
    if (h.sessionId && brokenSessions.has(h.sessionId)) continue;
    try { const chain = resolveCodexChain(file, headers); if (chain.length > 1) groups.push({ members: chain.map(s => absolute.get(s.file)!), leaf: absolute.get(file)! }); }
    catch { /* Keep the source selectable; parsing reports exact missing/ambiguous ancestry. */ }
  }
  for (const [file, h] of headers) {
    const error = h.sessionId ? brokenSessions.get(h.sessionId) : undefined;
    if (error) {
      const index = result.indexOf(absolute.get(file)!);
      if (index >= 0) result[index] = { ...result[index]!, chainError: error };
    }
  }
  const used = new Set(groups.flatMap(g => g.members));
  for (let i = result.length - 1; i >= 0; i--) if (used.has(result[i]!)) result.splice(i, 1);
  for (const group of groups) {
    const ordered = group.members, first = ordered[0]!;
    // One chain keeps its original root row stable as new pages arrive. Distinct
    // leaves sharing a root are real branches, not silently concatenated tails.
    const leader = groups.filter(g => g.members[0] === first).length === 1 ? first : group.leaf;
    const parts=ordered.map(s=>({path:s.path,bytes:s.bytes,sha256:s.sha256}));
    result.push({ ...leader, ...recordSourcePartsFingerprint(parts), stamp: ordered.map(s => s.stamp).join("\n"),
      modifiedAt: ordered.map(s => s.modifiedAt).sort().at(-1)!, agentShards: ordered.map(s => s.path),agentParts:parts });
  }
  for (const [relative, raw] of Object.entries(cached)) {
    if (files[relative] || !/^Inbox\/[^/]+$/u.test(relative)) continue;
    const old = object(raw); if (old["path"] !== relative || !Number.isSafeInteger(old["bytes"]) || !/^[a-f0-9]{64}$/u.test(String(old["sha256"])) || !["unknown", "exporter-html", "json-container", "zip-container", "json", "jsonl"].includes(String(old["format"])) || !Number.isFinite(Date.parse(String(old["modifiedAt"])))) continue;
    // A missing indicator is not authority to delete the source, its outputs or parse history.
    try { await lstat(await resolveRecordPath(root, relative)); continue; } catch (e) { if (!missing(e)) throw e; }
    const absent = { ...old, missing: true } as unknown as RecordSource; files[relative] = absent as unknown as JsonObject; if (options.includeMissing) result.push(absent);
  }
  const value = { schema: "cloudig/source-index/1.7.0", files };
  if (JSON.stringify(value) !== JSON.stringify(prior)) await withRecordSnapshot(root, () => writeRecordProjection(root, indexPath, JSON.stringify(value, null, 2) + "\n"));
  return result;
}

function watermark(unit: RecordParseUnit, adapters: readonly AdapterManifest[], bundle: string): string {
  const adapter = adapters.find(a => a.id === unit.source.adapterId);
  return adapter ? `${adapter.id}@${adapter.version}` : sourceFailureWatermark(unit.source.platform ? { platform: unit.source.platform } : undefined, adapters, bundle);
}
function laterVersion(current: string, saved: unknown): boolean {
  if (typeof saved !== "string" || !/^\d+(?:\.\d+)*$/u.test(saved) || !/^\d+(?:\.\d+)*$/u.test(current)) return false;
  const a = current.split(".").map(BigInt), b = saved.split(".").map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0n) !== (b[i] ?? 0n)) return (a[i] ?? 0n) > (b[i] ?? 0n);
  return false;
}

export async function readRecordParseStatuses(root: string, units: readonly RecordParseUnit[], options: Readonly<{ adapters?: readonly AdapterManifest[]; bundle?: string }> = {}): Promise<readonly RecordParseStatus[]> {
  const adapters = options.adapters ?? adapterBundleSnapshot().adapters, bundle = options.bundle ?? adapterBundleSha256();
  return withRecordSnapshot(root, async () => {
    const catalog = await readRecordCatalog(root), result: RecordParseStatus[] = [], readHistory = createRecordHistoryReader(root);
    for (const unit of units) {
      if (unit.source.missing) { result.push({ unit, status: "missing", outdated: false }); continue; }
      if (unit.source.chainError) { result.push({ unit, status: "failed", outdated: false, error: unit.source.chainError }); continue; }
      const key = unitKey(unit), failure = await readObject(root, failurePath(unit));
      let history: JsonObject = {};
      try { history = (await readHistory(key))?.value ?? {}; } catch (e) { if (!(e instanceof TypeError || e instanceof SyntaxError)) throw e; }
      const output = recordHistoryMatches(history, key) ? object(history["output"]) : {};
      const conversation = typeof output["conversation_id"] === "string" ? uniqueConversation(catalog, output["conversation_id"]) : undefined;
      const savedAdapter = object(object(conversation?.header["parser"])["adapter"]), current = adapters.find(a => a.id === savedAdapter["id"]);
      const outdated = !!current && laterVersion(current.version, savedAdapter["version"]);
      if (failure["schema"] === "cloudig/parse-failure/1.0.0" && failure["source_sha256"] === unit.source.sha256 && failure["watermark"] === watermark(unit, adapters, bundle)) {
        result.push({ unit, status: Number(failure["content_attempts"]) >= 2 ? "unsupported" : "failed", outdated, error: String(failure["message"]), ...(conversation ? { conversationId: String(conversation.header["conversation_id"]) } : {}) }); continue;
      }
      result.push({ unit, status: conversation && object(conversation.header["source"])["sha256"] === unit.source.sha256 ? "parsed" : unit.source.format === "unknown" ? "unsupported" : "ready", outdated,
        ...(conversation ? { conversationId: String(conversation.header["conversation_id"]) } : {}) });
    }
    return result;
  });
}

export async function recordParseFailure(root: string, unit: RecordParseUnit, message: string, contentFailure: boolean): Promise<void> {
  await withRecordSnapshot(root, async () => {
    const target = failurePath(unit), prior = await readObject(root, target), mark = watermark(unit, adapterBundleSnapshot().adapters, adapterBundleSha256());
    const same = prior["source_sha256"] === unit.source.sha256 && prior["watermark"] === mark;
    const contentAttempts = nextContentFailureAttempts(same ? Number(prior["content_attempts"]) : 0, contentFailure);
    await writeRecordInternalJson(root, target, JSON.stringify({ schema: "cloudig/parse-failure/1.0.0", source: unitKey(unit), source_sha256: unit.source.sha256, watermark: mark, content_attempts: contentAttempts, message }, null, 2) + "\n");
  });
}
export async function clearRecordParseFailure(root: string, unit: RecordParseUnit): Promise<void> {
  await withRecordSnapshot(root, async () => { try { await unlink(await resolveRecordPath(root, failurePath(unit))); } catch (e) { if (!missing(e)) throw e; } });
}

/** Union, not precedence: selected rows may request a retry; unsupported rows wait for source/adapter change. */
export function selectRecordParseRange(rows: readonly RecordParseStatus[], selected: ReadonlySet<string>, settings: Readonly<{ include_unparsed: boolean; include_selected: boolean; include_outdated: boolean }>, mode: "parser" | "claude_json"): readonly RecordParseUnit[] {
  return rows.filter(row => row.status !== "unsupported" && row.status !== "missing" && (mode === "claude_json" ? ["json-container", "zip-container"].includes(row.unit.source.format) && !!row.unit.locator : !["json-container", "zip-container"].includes(row.unit.source.format))
    && (settings.include_unparsed && row.status === "ready" || settings.include_selected && selected.has(JSON.stringify(unitKey(row.unit))) || settings.include_outdated && row.outdated)).map(row => row.unit);
}

export async function dismissMissingRecordSources(root: string, sources: readonly RecordSource[]): Promise<number> {
  if (sources.some(source => !source.missing)) throw new TypeError("Only missing source entries can be dismissed");
  if (!sources.length) return 0;
  return withRecordSnapshot(root, async () => {
    const indexPath = "appdata/indexes/sources.json", prior = await readObject(root, indexPath), files = object(prior["files"]);
    let dismissed = 0;
    for (const source of sources) {
      const old = object(files[source.path]);
      if (old["sha256"] !== source.sha256 || old["stamp"] !== source.stamp) continue;
      // A file may have returned after the scan. Keep it and continue clearing
      // the other absent records; never delete a file or a Conversation here.
      try { await lstat(await resolveRecordPath(root, source.path)); continue; } catch (e) { if (!missing(e)) throw e; }
      delete files[source.path]; dismissed++;
    }
    if (dismissed) await writeRecordProjection(root, indexPath, JSON.stringify({ ...prior, files }, null, 2) + "\n");
    return dismissed;
  });
}
