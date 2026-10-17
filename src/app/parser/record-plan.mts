import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { confinedRelativePath } from "../../core/records/layout.mts";
import { readStoredRecord, withRecordSnapshot, recordFileIdentity, type RecordFileIdentity } from "../../adapters/storage/record-store.mts";
import { scanRecordSources, readRecordParseStatuses, selectRecordParseRange, type RecordParseUnit } from "../../adapters/library-data/record-parse-status.mts";
import type { RecordOfficialIndex } from "../../adapters/parser/record-official-index.mts";
import type { RecordParseJob } from "./record-workers.mts";

export type RecordParseSettings = Readonly<{ include_unparsed: boolean; include_selected: boolean; include_outdated: boolean; keep_previous: boolean }>;
export type RecordParsePlan = Readonly<{ units: readonly RecordParseUnit[]; jobs: readonly RecordParseJob[]; directory: string; directoryIdentity: RecordFileIdentity; relocateExisting?: boolean; settings: RecordParseSettings;
  preview: readonly { filename: string; title?: string; locator?: string }[] }>;
const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};

/** Header/index reads only. No message extraction, output allocation or worker/cache startup before confirmation. */
export async function prepareRecordParsePlan(root: string, input: Readonly<{
  mode: "parser" | "claude_json"; selected: ReadonlySet<string>; claudeIndex?: RecordOfficialIndex; settings?: RecordParseSettings; directory?: string;
}>): Promise<RecordParsePlan> {
  const library = await withRecordSnapshot(root, () => readStoredRecord(root, "library", "CloudigLibrary.json"));
  const stored = object(library.value["settings"]), settings = input.settings ?? object(stored["one_click_parse"])[input.mode] as unknown as RecordParseSettings;
  if (!settings || Object.keys(settings).length !== 4 || ["include_unparsed", "include_selected", "include_outdated", "keep_previous"].some(key => typeof (settings as unknown as JsonObject)[key] !== "boolean")) throw new TypeError("One-click settings are incomplete");
  const directory = input.directory ?? String(stored["default_output_directory"]); confinedRelativePath(directory);
  if (directory !== "Conversations" && !directory.startsWith("Conversations/")) throw new TypeError("Output directory must be within Conversations");
  const directoryIdentity = await recordFileIdentity(root, directory, "directory");
  const sources = await scanRecordSources(root);
  let units: RecordParseUnit[];
  if (input.mode === "claude_json") {
    const index = input.claudeIndex; if (!index) throw new TypeError("Claude page needs its current container index");
    const source = sources.find(s => s.path === index.source.path);
    if (!source || source.sha256 !== index.source.sha256) throw new TypeError("Claude container changed; rebuild its index first");
    units = index.records.map(record => ({ source, locator: String(record["selector"]) }));
  } else units = sources.map(source => ({ source }));
  const chosen = selectRecordParseRange(await readRecordParseStatuses(root, units), input.selected, settings, input.mode);
  return { units: chosen, settings: { ...settings }, directory, directoryIdentity,
    // An explicit directory chosen before preview has the same intent as retargeting.
    // An implicit default still updates existing archives in place.
    relocateExisting: input.directory !== undefined,
    jobs: chosen.map(unit => ({ sourcePath: unit.source.path,
      ...(unit.locator && input.claudeIndex ? { official: { ...input.claudeIndex, records: [input.claudeIndex.records.find(r => r["selector"] === unit.locator)!] } } : {}),
      ...(!unit.locator && ["json", "jsonl"].includes(unit.source.format) && unit.source.platform && unit.source.adapterId ? { agent: { family: unit.source.platform === "cline" ? (unit.source.adapterId.includes("ui") ? "cline-ui" : "cline-api") : unit.source.platform === "sillytavern" ? "sillytavern" : unit.source.platform === "kimi-code" ? "kimi-code" : unit.source.platform === "claude-code" ? "claude-code" : "codex", format: unit.source.format as "json" | "jsonl", source: { bytes: unit.source.bytes, sha256: unit.source.sha256 }, ...(unit.source.agentShards ? { shards: unit.source.agentShards } : {}) } } : {}) })),
    preview: chosen.map(unit => ({ filename: unit.source.path.slice("Inbox/".length), ...(unit.locator ? { locator: unit.locator,
      title: String(input.claudeIndex?.records.find(r => r["selector"] === unit.locator)?.["title"] ?? "") } : {}) })) };
}
