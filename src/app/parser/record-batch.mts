import type { JsonObject } from "../../core/contracts/types.mts";
import { savePreparedRecord } from "../../adapters/library-data/record-parser-commit.mts";
import { RecordSourceReads, RecordStoreConflict, recordFileIdentity, type RecordFileIdentity } from "../../adapters/storage/record-store.mts";
import { prepareRecordJobs, recordJobSelector, type RecordParseJob, type RecordWorkerProgress } from "./record-workers.mts";
import { parserErrorMessage } from "./diagnostics.mts";
import { isSourceContentError } from "./failure-policy.mts";
import { scanRecordSources, recordParseFailure, clearRecordParseFailure, type RecordParseUnit } from "../../adapters/library-data/record-parse-status.mts";
import { updateRecordSystemLog } from "../../adapters/library-data/record-system-log.mts";

export type RecordBatchItem = Readonly<{ index: number; sourcePath: string; locator?: string }> & (
  | Readonly<{ status: "created" | "updated"; conversationId: string; path: string; errors: readonly JsonObject[]; maintenanceWarnings: readonly string[] }>
  | Readonly<{ status: "failed"; message: string; contentFailure: boolean }>
  | Readonly<{ status: "cancelled" | "not_started" }>
);
export type RecordBatchProgress = Readonly<{ index: number; completed: number; total: number; phase: "start" | "extract" | "commit" | "item_done" | "done"; detail?: RecordWorkerProgress }>;

/** The caller confirms the metadata-only range before invoking this execution function. */
export async function runRecordParseBatch(root: string, jobs: readonly RecordParseJob[], options: Readonly<{
  parserVersion: string; timestamp: string; keepPrevious?: boolean; directory?: string; directoryIdentity?: RecordFileIdentity; relocateExisting?: boolean; signal?: AbortSignal; workers?: number;
  units?: readonly RecordParseUnit[];
  onProgress?: (event: RecordBatchProgress) => void; onWorkerMetrics?: Parameters<typeof prepareRecordJobs>[2]["onMetrics"];
}>): Promise<Readonly<{ state: "completed" | "cancelled" | "recovery_required"; items: readonly RecordBatchItem[]; sourceChecks: { hashes: number; reused: number }; maintenanceWarnings: readonly string[] }>> {
  const sourceReads = new RecordSourceReads(), items: RecordBatchItem[] = jobs.map((job, index) => ({ index, sourcePath: job.sourcePath,
    ...(recordJobSelector(job) ? { locator: recordJobSelector(job)! } : {}), status: "not_started" }));
  let completed = 0, active = -1, state: "completed" | "cancelled" | "recovery_required" = "completed";
  const maintenanceWarnings: string[] = [];
  const sources = options.units ? [] : await scanRecordSources(root);
  const units = options.units ?? jobs.map(job => ({ source: sources.find(s => s.path === job.sourcePath)!, ...(recordJobSelector(job) ? { locator: recordJobSelector(job)! } : {}) }));
  if (units.length !== jobs.length || units.some((u, i) => u?.source?.path !== jobs[i]?.sourcePath || (u.locator ?? null) !== (recordJobSelector(jobs[i]!) ?? null))) throw new TypeError("Parse units must match confirmed jobs");
  if (options.directoryIdentity) {
    if (!options.directory) throw new TypeError("Output identity requires a directory");
    const actual = await recordFileIdentity(root, options.directory, "directory");
    if (actual.device !== options.directoryIdentity.device || actual.inode !== options.directoryIdentity.inode) throw new RecordStoreConflict("Output directory changed after preview; select it again");
  }
  const emit = (index: number, phase: RecordBatchProgress["phase"], detail?: RecordWorkerProgress) => options.onProgress?.({ index, completed, total: jobs.length, phase, ...(detail ? { detail } : {}) });
  try {
    emit(0, "start");
    for await (const outcome of prepareRecordJobs(root, jobs, { ...options,
      onProgress: (index, detail) => emit(index, "extract", detail), ...(options.onWorkerMetrics ? { onMetrics: options.onWorkerMetrics } : {}) })) {
      active = outcome.index; const prior = items[active]!, job = jobs[active]!;
      if ("error" in outcome) items[active] = { ...prior, status: "failed", message: parserErrorMessage(outcome.error, "Source parsing failed"), contentFailure: isSourceContentError(outcome.error) };
      else {
        emit(active, "commit");
        try {
          if ((outcome.prepared.conversation["source"] as JsonObject)["sha256"] !== units[active]!.source.sha256) throw new TypeError("Source changed after the confirmed selection; refresh before parsing it");
          const saved = await savePreparedRecord(root, { conversation: outcome.prepared.conversation, sourcePath: job.sourcePath, sourceReads,
            ...(options.keepPrevious === undefined ? {} : { keepPrevious: options.keepPrevious }), ...(options.directory ? { directory: options.directory } : {}), ...(options.directoryIdentity ? { directoryIdentity: options.directoryIdentity } : {}), ...(options.relocateExisting ? { relocateExisting: true } : {}), ...(options.signal ? { signal: options.signal } : {}) });
          items[active] = { ...prior, status: saved.replaced ? "updated" : "created", path: saved.path, conversationId: String(saved.conversation["conversation_id"]), errors: outcome.prepared.errors, maintenanceWarnings: saved.maintenanceWarnings };
        } catch (e) {
          if (options.signal?.aborted || e instanceof Error && e.name === "AbortError") throw e;
          items[active] = { ...prior, status: "failed", message: parserErrorMessage(e, "Saving the parsed record failed"), contentFailure: false };
          if (e instanceof RecordStoreConflict && e.operationId) { state = "recovery_required"; completed++; emit(active, "item_done"); break; }
        }
      }
      completed++; emit(active, "item_done"); active = -1;
    }
  } catch (e) {
    if (!options.signal?.aborted && !(e instanceof Error && e.name === "AbortError")) throw e;
    state = "cancelled"; if (active >= 0 && items[active]?.status === "not_started") items[active] = { ...items[active]!, status: "cancelled" };
  }
  const logs: Parameters<typeof updateRecordSystemLog>[1][number][] = [];
  for (const item of items) {
    if (item.status === "not_started" || item.status === "cancelled") continue;
    const unit = units[item.index]!;
    try {
      if (item.status === "failed") await recordParseFailure(root, unit, item.message, item.contentFailure);
      else await clearRecordParseFailure(root, unit);
    } catch (e) { maintenanceWarnings.push(parserErrorMessage(e, "Parser status could not be saved")); }
    logs.push({ path: item.sourcePath, ...(item.locator ? { locator: item.locator } : {}), recorded_at: options.timestamp,
      errors: item.status === "failed" ? [{ source: "parser", code: "parse-failed", message: item.message }] : "errors" in item ? item.errors : [] });
  }
  try { await updateRecordSystemLog(root, logs); } catch (e) { maintenanceWarnings.push(parserErrorMessage(e, "System Log could not be saved")); }
  emit(Math.max(0, active), "done"); return { state, items, sourceChecks: sourceReads.metrics, maintenanceWarnings };
}
