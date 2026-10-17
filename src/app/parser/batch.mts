import { stat } from "node:fs/promises";

import {
  commitPlannedParsedSource,
  commitNewParsedSource,
  prepareParsedSourceWritePlan,
  prepareCatalogForParser,
  type ParsedSourceWritePlan,
  type NewParseCommitResult
} from "../../adapters/library-data/parser-commit.mts";
import { updateSystemLog, type SystemLogUpdate } from "../../adapters/library-data/system-log.mts";
import { recordCatalogSourceFailure } from "../../adapters/library-data/catalog.mts";
import { validateOperation } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { resolveManagedPath } from "../../adapters/storage/path.mts";
import { readCurrentAuthorityPair } from "../../adapters/storage/recovery-point.mts";
import { parseExporterHtmlToDraft, parserErrorMessage } from "./host.mts";
import type { ParsedSourceDraft } from "./adapter.mts";
import { PreparedDraftStore } from "./prepared-drafts.mts";
import { ParserCatalogBatch, scanLibraryFiles } from "../../adapters/library-data/catalog.mts";
import { fingerprintFile } from "../../adapters/storage/stream.mts";
import { probeExporterRoute } from "../../adapters/parser/html-envelope.mts";
import { adapterBundleSnapshot, adapterBundleSha256 } from "./registry.mts";
import { isSourceContentError, sourceFailureWatermark } from "./failure-policy.mts";

export type ParseBatchItemResult =
  | Readonly<{ index: number; status: "created" | "updated" | "preserved"; archive: string; path: string }>
  | Readonly<{ index: number; status: "unchanged" }>
  | Readonly<{ index: number; status: "unsupported" }>
  | Readonly<{ index: number; status: "conflict"; reason: string }>
  | Readonly<{ index: number; status: "failed"; code: string }>
  | Readonly<{ index: number; status: "cancelled" }>
  | Readonly<{ index: number; status: "not_started" }>;

export type ParseBatchResult = Readonly<{
  state: "completed" | "failed" | "cancelled";
  items: readonly ParseBatchItemResult[];
}>;

export type PreparedParseBatchItem = Readonly<{
  index: number;
  sourcePath: string;
  action: "new" | "safe_update" | "conservative_new" | "preserve" | "unchanged" | "excluded";
  reason: string;
  bytes?: number;
  mtimeNs?: string;
  messages?: number;
  resources?: number;
  errorMessage?: string;
  contentFailure?: boolean;
  plan?: ParsedSourceWritePlan;
}>;

export type PreparedParseBatch = Readonly<{
  state: "ready" | "cancelled";
  items: readonly PreparedParseBatchItem[];
  preservePrevious: boolean;
  copyUserStateOnPreserve: boolean;
  targetDirectory?: string;
  drafts?: PreparedDraftStore;
  knownPresentSourcePaths?: ReadonlySet<string>;
}>;

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function emitOperation(
  event: JsonObject,
  callback?: (event: JsonObject) => void
): void {
  const validation = validateOperation(event);
  if (!validation.ok) {
    throw new TypeError(`Internal Parser operation event is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  }
  callback?.(structuredClone(validation.value));
}

function errorProjection(error: unknown): Readonly<{
  code: string;
  retry: "immediate" | "after_adapter_change";
  status: "failed" | "unsupported";
  phase: "probe" | "extract";
}> {
  if (error instanceof SyntaxError) return { code: "invalid-json", retry: "immediate", status: "failed", phase: "extract" };
  if (error instanceof TypeError && /manifest|payload|Adapter route|Exporter HTML/iu.test(error.message)) {
    return { code: "unsupported-source", retry: "immediate", status: "failed", phase: "probe" };
  }
  return { code: "parser-failed", retry: "immediate", status: "failed", phase: "extract" };
}

async function recordSourceFailure(libraryRoot: string, input: Parameters<typeof recordCatalogSourceFailure>[1], contentFailure: boolean): Promise<void> {
  const absolute = await resolveManagedPath(libraryRoot, input.path, { mustExist: true });
  const [fingerprint, route] = await Promise.all([fingerprintFile(absolute), probeExporterRoute(absolute).catch(() => undefined)]);
  await recordCatalogSourceFailure(libraryRoot, {
    ...input,
    failure: { sourceSha256: fingerprint.sha256, watermark: sourceFailureWatermark(route, adapterBundleSnapshot().adapters, adapterBundleSha256()), contentFailure }
  });
}

function conflictRetry(reason: string): "after_source_change" | "after_conflict_resolution" | "after_recovery" {
  if (/source|catalog_selection/u.test(reason)) return "after_source_change";
  if (/recovery/u.test(reason)) return "after_recovery";
  return "after_conflict_resolution";
}

function parserLogError(code: string, phase: "probe" | "extract", detail?: string): JsonObject {
  const message = code === "unsupported-source"
    ? "Parser does not support this source format."
    : code === "invalid-json"
      ? "Parser could not read the source JSON data."
      : "Parser could not convert this source into a Conversation archive.";
  return { source: "parser", code, stage: phase, message: detail || message };
}

async function finishSystemLog(libraryRoot: string, updates: readonly SystemLogUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  try {
    await updateSystemLog(libraryRoot, updates);
  } catch {
    // System Log is a small diagnostic projection. Its failure never rolls back valid archives.
  }
}

export async function prepareParseBatch(input: Readonly<{
  libraryRoot: string;
  runtimeRoot: string;
  sourcePaths: readonly string[];
  operation: string;
  preservePrevious: boolean;
  copyUserStateOnPreserve: boolean;
  targetDirectory?: string;
  jsonScriptMemoryThresholdBytes?: number;
  signal?: AbortSignal;
  onEvent?: (event: JsonObject) => void;
}>): Promise<PreparedParseBatch> {
  if (input.sourcePaths.length === 0) throw new TypeError("Parse preview requires at least one source");
  const total = input.sourcePaths.length;
  const items: PreparedParseBatchItem[] = [];
  let completed = 0;
  emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "discover", state: "started", file: { index: 1, completed, total } }, input.onEvent);
  const knownPresentSourcePaths = new Set((await scanLibraryFiles(input.libraryRoot)).sources.map(row => row.path));
  const drafts = await PreparedDraftStore.create(input.libraryRoot, input.sourcePaths, {
    runtimeRoot: input.runtimeRoot,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.jsonScriptMemoryThresholdBytes === undefined ? {} : { threshold: input.jsonScriptMemoryThresholdBytes }),
    onProgress: (offset, progress) => emitOperation({
      schema: "cloudig/operation/1.0.0", operation: input.operation, phase: progress.phase, state: "progress",
      file: { index: offset + 1, completed, total },
      ...(progress.phase === "normalize" ? { items: { completed: progress.completed, total: progress.total } } : { bytes: { completed: progress.completed, total: progress.total } })
    }, input.onEvent)
  });
  let retained = false;
  try {
  for (const [offset, sourcePath] of input.sourcePaths.entries()) {
    const index = offset + 1;
    if (input.signal?.aborted) {
      emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "probe", state: "cancelled", file: { index, completed, total } }, input.onEvent);
      return {
        state: "cancelled",
        items,
        preservePrevious: input.preservePrevious,
        copyUserStateOnPreserve: input.copyUserStateOnPreserve,
        ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {})
      };
    }
    let sourceObservation: Readonly<{ bytes: number; mtimeNs: string }> | undefined;
    try {
      sourceObservation = drafts.observation(sourcePath);
      const preview = await drafts.preview(offset);
      const parsed = preview.parsed;
      sourceObservation = { bytes: parsed.sourceFingerprint.bytes, mtimeNs: preview.mtimeNs };
      const plan = await prepareParsedSourceWritePlan({
        libraryRoot: input.libraryRoot,
        sourcePath,
        parsed,
        preservePrevious: input.preservePrevious,
        copyUserStateOnPreserve: input.copyUserStateOnPreserve,
        knownPresentSourcePaths,
        ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {})
      });
      completed += 1;
      items.push({
        index,
        sourcePath,
        action: plan.action,
        reason: plan.reason,
        bytes: parsed.sourceFingerprint.bytes,
        mtimeNs: sourceObservation.mtimeNs,
        messages: preview.messages,
        resources: preview.resources,
        plan
      });
    } catch (error) {
      if (abortError(error) || input.signal?.aborted) {
        emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "extract", state: "cancelled", file: { index, completed, total } }, input.onEvent);
        return {
          state: "cancelled",
          items,
          preservePrevious: input.preservePrevious,
          copyUserStateOnPreserve: input.copyUserStateOnPreserve,
          ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {})
        };
      }
      completed += 1;
      const projected = errorProjection(error);
      items.push({
        index, sourcePath, action: "excluded", reason: projected.code,
        errorMessage: parserErrorMessage(error, "Parser could not read this source."),
        contentFailure: isSourceContentError(error),
        ...(sourceObservation ? { bytes: sourceObservation.bytes, mtimeNs: sourceObservation.mtimeNs } : {})
      });
    }
  }
  await drafts.finish();
  if (process.env["CLOUDIG_PARSER_METRICS"] === "1") process.stderr.write(`CLOUDIG_PARSER_METRICS ${JSON.stringify(drafts.metrics)}\n`);
  emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "plan", state: "completed", file: { index: total, completed: total, total }, items: { completed: total, total } }, input.onEvent);
  retained = true;
  return {
    state: "ready",
    items,
    drafts,
    knownPresentSourcePaths,
    preservePrevious: input.preservePrevious,
    copyUserStateOnPreserve: input.copyUserStateOnPreserve,
    ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {})
  };
  } finally { if (!retained) await drafts.dispose(); }
}

async function runPreparedParseBatchImpl(input: Readonly<{
  libraryRoot: string;
  runtimeRoot: string;
  plan: PreparedParseBatch;
  operation: string;
  transactionTokens: readonly string[];
  recoveryTransaction: string;
  timestamp: string;
  copyUserStateOnPreserve: boolean;
  jsonScriptMemoryThresholdBytes?: number;
  signal?: AbortSignal;
  onEvent?: (event: JsonObject) => void;
  catalogBatch?: ParserCatalogBatch;
}>): Promise<ParseBatchResult> {
  if (input.plan.state !== "ready") return { state: "cancelled", items: [] };
  if (input.transactionTokens.length !== input.plan.items.length) throw new TypeError("Every planned parse item requires one transaction token");
  const total = input.plan.items.length;
  const results: ParseBatchItemResult[] = [];
  const logUpdates: SystemLogUpdate[] = [];
  let completed = 0;
  let recoveryCaptured = false;
  let expectedAuthority = await readCurrentAuthorityPair(input.libraryRoot);
  const plannedAuthority = input.plan.items.find((item) => item.plan)?.plan;
  if (plannedAuthority && (
    expectedAuthority.library["revision"] !== plannedAuthority.expectedLibraryRevision
    || expectedAuthority.libraryFingerprint.bytes !== plannedAuthority.expectedLibraryFingerprint.bytes
    || expectedAuthority.libraryFingerprint.sha256 !== plannedAuthority.expectedLibraryFingerprint.sha256
  )) {
    return {
      state: "failed",
      items: input.plan.items.map((item) => item.plan
        ? { index: item.index, status: "conflict", reason: "library_changed_after_preview" }
        : { index: item.index, status: "failed", code: item.reason })
    };
  }
  if (input.plan.items.some((item) => item.action !== "unchanged")) {
    const preparedCatalog = await prepareCatalogForParser(input.libraryRoot, input.timestamp);
    if (preparedCatalog.status !== "ready") return {
      state: "failed",
      items: input.plan.items.map((item) => ({ index: item.index, status: "failed", code: "catalog-not-ready" }))
    };
  }
  emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "discover", state: "started", file: { index: 1, completed, total } }, input.onEvent);
  for (const [offset, item] of input.plan.items.entries()) {
    const index = item.index;
    if (input.signal?.aborted) {
      results.push({ index, status: "cancelled" });
      for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
      await finishSystemLog(input.libraryRoot, logUpdates);
      return { state: "cancelled", items: results };
    }
    if (item.action === "excluded" || !item.plan) {
      completed += 1;
      if (item.reason === "unsupported" || item.reason === "claude_container") {
        results.push({ index, status: "unsupported" });
      } else {
        results.push({ index, status: "failed", code: item.reason });
        if (item.bytes !== undefined && item.mtimeNs !== undefined && ["invalid-json", "unsupported-source", "parser-failed"].includes(item.reason)) {
          const projected = { status: "failed" as const, phase: item.reason === "unsupported-source" ? "probe" as const : "extract" as const, retry: "immediate" as const };
          emitOperation({
            schema: "cloudig/operation/1.0.0",
            operation: input.operation,
            phase: projected.phase,
            state: "failed",
            file: { index, completed, total },
            error: { code: item.reason, retry: projected.retry }
          }, input.onEvent);
          try {
            await recordSourceFailure(input.libraryRoot, {
              path: item.sourcePath,
              expected: { bytes: item.bytes, mtimeNs: item.mtimeNs },
              status: projected.status,
              error: { code: item.reason, phase: projected.phase, retry: projected.retry },
              builtAt: input.timestamp
            }, item.contentFailure === true);
          } catch {
            // Catalog is rebuildable; a projection write failure cannot change the parse result.
          }
          logUpdates.push({
            path: item.sourcePath,
            outcome: "errors",
            recordedAt: input.timestamp,
            errors: [parserLogError(item.reason, projected.phase, item.errorMessage)]
          });
        }
      }
      continue;
    }
    if (input.signal?.aborted) {
      results.push({ index, status: "cancelled" });
      for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
      await finishSystemLog(input.libraryRoot, logUpdates);
      return { state: "cancelled", items: results };
    }
    const currentAuthority = await readCurrentAuthorityPair(input.libraryRoot);
    if (
      currentAuthority.libraryFingerprint.bytes !== expectedAuthority.libraryFingerprint.bytes
      || currentAuthority.libraryFingerprint.sha256 !== expectedAuthority.libraryFingerprint.sha256
    ) {
      results.push({ index, status: "conflict", reason: "library_changed_after_preview" });
      for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
      await finishSystemLog(input.libraryRoot, logUpdates);
      return { state: "failed", items: results };
    }
    try {
      const sourceAbsolute = await resolveManagedPath(input.libraryRoot, item.sourcePath, { mustExist: true });
      const lastBytes = new Map<string, number>();
      const lastItems = new Map<string, number>();
      const cached = await input.plan.drafts?.take(item.sourcePath);
      if (input.plan.drafts && !cached) throw new TypeError("Prepared Parser draft is missing; preview again");
      // commitPlannedParsedSource still fingerprints the current source and
      // checks it against the exact preview hash before any write, then again
      // immediately before install. Reusing a draft does not trust size/mtime.
      const parsed = cached ?? await parseExporterHtmlToDraft({
        filePath: sourceAbsolute,
        temporaryRoot: input.runtimeRoot,
        ...(input.jsonScriptMemoryThresholdBytes === undefined ? {} : { jsonScriptMemoryThresholdBytes: input.jsonScriptMemoryThresholdBytes }),
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: (progress) => {
          if (progress.phase === "normalize") {
            const stride = Math.max(1, Math.ceil(progress.total / 100));
            const previous = lastItems.get(progress.phase) ?? -stride;
            if (progress.completed !== progress.total && progress.completed - previous < stride) return;
            lastItems.set(progress.phase, progress.completed);
            emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: progress.phase, state: "progress", file: { index, completed, total }, items: { completed: progress.completed, total: progress.total } }, input.onEvent);
          } else {
            const previous = lastBytes.get(progress.phase) ?? -262_144;
            if (progress.completed !== progress.total && progress.completed - previous < 262_144) return;
            lastBytes.set(progress.phase, progress.completed);
            emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: progress.phase, state: "progress", file: { index, completed, total }, bytes: { completed: progress.completed, total: progress.total } }, input.onEvent);
          }
        }
      });
      const effectivePlan: ParsedSourceWritePlan = {
        ...item.plan,
        copyUserState: item.plan.action === "preserve" ? input.copyUserStateOnPreserve : item.plan.copyUserState,
        expectedLibraryRevision: currentAuthority.library["revision"] as number,
        expectedLibraryFingerprint: currentAuthority.libraryFingerprint
      };
      const committed = await commitPlannedParsedSource({
        libraryRoot: input.libraryRoot,
        plan: effectivePlan,
        parsed,
        transaction: input.transactionTokens[offset]!,
        recoveryTransaction: input.recoveryTransaction,
        recoveryAlreadyCapturedThisBatch: recoveryCaptured,
        timestamp: input.timestamp,
        ...(input.catalogBatch ? { catalogBatch: input.catalogBatch } : {}),
        ...(input.plan.knownPresentSourcePaths ? { knownPresentSourcePaths: input.plan.knownPresentSourcePaths } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        onPhase: (phase) => emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase, state: phase === "commit" ? "waiting_commit" : "progress", file: { index, completed, total } }, input.onEvent)
      });
      completed += 1;
      if (committed.status === "created" || committed.status === "updated" || committed.status === "preserved") {
        recoveryCaptured = true;
        results.push({ index, status: committed.status, archive: committed.archive, path: committed.path });
        expectedAuthority = await readCurrentAuthorityPair(input.libraryRoot);
        logUpdates.push(parsed.systemLogErrors.length > 0
          ? { path: item.sourcePath, outcome: "errors", recordedAt: input.timestamp, errors: parsed.systemLogErrors }
          : { path: item.sourcePath, outcome: "success_no_errors" });
      } else if (committed.status === "unchanged") {
        results.push({ index, status: "unchanged" });
        logUpdates.push(parsed.systemLogErrors.length > 0
          ? { path: item.sourcePath, outcome: "errors", recordedAt: input.timestamp, errors: parsed.systemLogErrors }
          : { path: item.sourcePath, outcome: "success_no_errors" });
      } else if (committed.status === "cancelled") {
        results.push({ index, status: "cancelled" });
        for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
        await finishSystemLog(input.libraryRoot, logUpdates);
        return { state: "cancelled", items: results };
      } else if (committed.status === "conflict") {
        results.push({ index, status: "conflict", reason: committed.reason });
      } else throw new TypeError("Parser commit returned an unknown status");
    } catch (error) {
      if (abortError(error) || input.signal?.aborted) {
        results.push({ index, status: "cancelled" });
        for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
        return { state: "cancelled", items: results };
      }
      completed += 1;
      const projected = errorProjection(error);
      results.push({ index, status: "failed", code: projected.code });
      logUpdates.push({ path: item.sourcePath, outcome: "errors", recordedAt: input.timestamp, errors: [parserLogError(projected.code, projected.phase, parserErrorMessage(error, "Parser conversion failed."))] });
      if (item.bytes !== undefined && item.mtimeNs !== undefined) {
        await recordSourceFailure(input.libraryRoot, {
          path: item.sourcePath, expected: { bytes: item.bytes, mtimeNs: item.mtimeNs }, status: projected.status,
          error: { code: projected.code, phase: projected.phase, retry: projected.retry }, builtAt: input.timestamp
        }, isSourceContentError(error)).catch(() => undefined);
      }
    }
  }
  emitOperation({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "verify", state: "completed", file: { index: total, completed: total, total }, items: { completed: total, total } }, input.onEvent);
  await finishSystemLog(input.libraryRoot, logUpdates);
  return { state: results.some((item) => item.status === "failed" || item.status === "conflict") ? "failed" : "completed", items: results };
}

export async function runPreparedParseBatch(input: Parameters<typeof runPreparedParseBatchImpl>[0]): Promise<ParseBatchResult> {
  const catalogBatch = new ParserCatalogBatch(input.libraryRoot);
  try { return await runPreparedParseBatchImpl({ ...input, catalogBatch }); }
  finally {
    // A cache failure cannot undo committed archives. Listing can reconstruct it.
    await catalogBatch.flush().catch(() => undefined);
    await input.plan.drafts?.dispose();
  }
}

export async function runNewParseBatch(input: Readonly<{
  libraryRoot: string;
  runtimeRoot: string;
  sourcePaths: readonly string[];
  operation: string;
  transactionTokens: readonly string[];
  recoveryTransaction: string;
  timestamp: string;
  targetDirectory?: string;
  jsonScriptMemoryThresholdBytes?: number;
  signal?: AbortSignal;
  onEvent?: (event: JsonObject) => void;
}>): Promise<ParseBatchResult> {
  if (input.sourcePaths.length === 0) throw new TypeError("Parse batch requires at least one source");
  if (input.transactionTokens.length !== input.sourcePaths.length) throw new TypeError("Every parse source requires one transaction token");
  const total = input.sourcePaths.length;
  const results: ParseBatchItemResult[] = [];
  let completed = 0;
  let recoveryCaptured = false;
  emitOperation({
    schema: "cloudig/operation/1.0.0",
    operation: input.operation,
    phase: "discover",
    state: "started",
    file: { index: 1, completed: 0, total }
  }, input.onEvent);

  const prepared = await prepareCatalogForParser(input.libraryRoot, input.timestamp);
  if (prepared.status !== "ready") {
    emitOperation({
      schema: "cloudig/operation/1.0.0",
      operation: input.operation,
      phase: "plan",
      state: "failed",
      file: { index: 1, completed: 0, total },
      error: {
        code: prepared.status === "archive_summary_required" ? "catalog-summary-required" : "catalog-not-ready",
        retry: "after_conflict_resolution"
      }
    }, input.onEvent);
    return {
      state: "failed",
      items: input.sourcePaths.map((_, index) => ({ index: index + 1, status: "failed", code: "catalog-not-ready" }))
    };
  }

  for (const [offset, sourcePath] of input.sourcePaths.entries()) {
    const index = offset + 1;
    if (input.signal?.aborted) {
      results.push({ index, status: "cancelled" });
      for (let later = index + 1; later <= total; later += 1) results.push({ index: later, status: "not_started" });
      emitOperation({
        schema: "cloudig/operation/1.0.0",
        operation: input.operation,
        phase: "probe",
        state: "cancelled",
        file: { index, completed, total }
      }, input.onEvent);
      return { state: "cancelled", items: results };
    }
    emitOperation({
      schema: "cloudig/operation/1.0.0",
      operation: input.operation,
      phase: "probe",
      state: "started",
      file: { index, completed, total }
    }, input.onEvent);
    const lastBytes = new Map<string, number>();
    const lastItems = new Map<string, number>();
    let sourceObservation: { bytes: number; mtimeNs: string } | undefined;
    try {
      const sourceAbsolute = await resolveManagedPath(input.libraryRoot, sourcePath, { mustExist: true });
      const sourceInfo = await stat(sourceAbsolute, { bigint: true });
      const sourceBytes = Number(sourceInfo.size);
      if (!Number.isSafeInteger(sourceBytes)) throw new RangeError("Parser source byte count exceeds the I-JSON range");
      sourceObservation = { bytes: sourceBytes, mtimeNs: String(sourceInfo.mtimeNs) };
      const parsed = await parseExporterHtmlToDraft({
        filePath: sourceAbsolute,
        temporaryRoot: input.runtimeRoot,
        ...(input.jsonScriptMemoryThresholdBytes === undefined ? {} : { jsonScriptMemoryThresholdBytes: input.jsonScriptMemoryThresholdBytes }),
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: (progress) => {
          if (progress.phase === "normalize") {
            const stride = Math.max(1, Math.ceil(progress.total / 100));
            const previous = lastItems.get(progress.phase) ?? -stride;
            if (progress.completed !== progress.total && progress.completed - previous < stride) return;
            lastItems.set(progress.phase, progress.completed);
            emitOperation({
              schema: "cloudig/operation/1.0.0",
              operation: input.operation,
              phase: progress.phase,
              state: "progress",
              file: { index, completed, total },
              items: { completed: progress.completed, total: progress.total }
            }, input.onEvent);
          } else {
            const previous = lastBytes.get(progress.phase) ?? -262_144;
            if (progress.completed !== progress.total && progress.completed - previous < 262_144) return;
            lastBytes.set(progress.phase, progress.completed);
            emitOperation({
              schema: "cloudig/operation/1.0.0",
              operation: input.operation,
              phase: progress.phase,
              state: "progress",
              file: { index, completed, total },
              bytes: { completed: progress.completed, total: progress.total }
            }, input.onEvent);
          }
        }
      });
      const committed: NewParseCommitResult = await commitNewParsedSource({
        libraryRoot: input.libraryRoot,
        sourcePath,
        parsed,
        ...(input.targetDirectory === undefined ? {} : { targetDirectory: input.targetDirectory }),
        transaction: input.transactionTokens[offset]!,
        recoveryTransaction: input.recoveryTransaction,
        recoveryAlreadyCapturedThisBatch: recoveryCaptured,
        timestamp: input.timestamp,
        ...(input.signal ? { signal: input.signal } : {}),
        onResourceProgress: (resourceCompleted, resourceTotal) => {
          const previous = lastBytes.get("resource") ?? -262_144;
          if (resourceCompleted !== resourceTotal && resourceCompleted - previous < 262_144) return;
          lastBytes.set("resource", resourceCompleted);
          emitOperation({
            schema: "cloudig/operation/1.0.0",
            operation: input.operation,
            phase: "extract",
            state: "progress",
            file: { index, completed, total },
            bytes: { completed: resourceCompleted, total: resourceTotal }
          }, input.onEvent);
        },
        onPhase: (phase) => emitOperation({
          schema: "cloudig/operation/1.0.0",
          operation: input.operation,
          phase,
          state: phase === "commit" ? "waiting_commit" : "progress",
          file: { index, completed, total }
        }, input.onEvent)
      });
      if (committed.status === "cancelled") {
        results.push({ index, status: "cancelled" });
        for (let later = index + 1; later <= total; later += 1) results.push({ index: later, status: "not_started" });
        emitOperation({
          schema: "cloudig/operation/1.0.0",
          operation: input.operation,
          phase: "stage",
          state: "cancelled",
          file: { index, completed, total }
        }, input.onEvent);
        return { state: "cancelled", items: results };
      }
      completed += 1;
      if (committed.status === "created") {
        recoveryCaptured = true;
        results.push({ index, status: "created", archive: committed.archive, path: committed.path });
      } else {
        results.push({ index, status: "conflict", reason: committed.reason });
        emitOperation({
          schema: "cloudig/operation/1.0.0",
          operation: input.operation,
          phase: "commit",
          state: "failed",
          file: { index, completed, total },
          error: { code: "parse-conflict", retry: conflictRetry(committed.reason) }
        }, input.onEvent);
      }
    } catch (error) {
      if (abortError(error) || input.signal?.aborted) {
        results.push({ index, status: "cancelled" });
        for (let later = index + 1; later <= total; later += 1) results.push({ index: later, status: "not_started" });
        emitOperation({
          schema: "cloudig/operation/1.0.0",
          operation: input.operation,
          phase: "extract",
          state: "cancelled",
          file: { index, completed, total }
        }, input.onEvent);
        return { state: "cancelled", items: results };
      }
      completed += 1;
      const projected = errorProjection(error);
      results.push({ index, status: "failed", code: projected.code });
      emitOperation({
        schema: "cloudig/operation/1.0.0",
        operation: input.operation,
        phase: projected.phase,
        state: "failed",
        file: { index, completed, total },
        error: {
          code: projected.code,
          retry: projected.retry
        }
      }, input.onEvent);
      if (sourceObservation) {
        try {
          await recordSourceFailure(input.libraryRoot, {
            path: sourcePath,
            expected: sourceObservation,
            status: projected.status,
            error: { code: projected.code, phase: projected.phase, retry: projected.retry },
            builtAt: input.timestamp
          }, isSourceContentError(error));
        } catch {
          // Catalog is rebuildable; a projection write failure cannot change the parse result.
        }
      }
    }
  }

  emitOperation({
    schema: "cloudig/operation/1.0.0",
    operation: input.operation,
    phase: "verify",
    state: "completed",
    file: { index: total, completed: total, total },
    items: { completed: total, total }
  }, input.onEvent);
  return { state: "completed", items: results };
}
