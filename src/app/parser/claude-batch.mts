import {
  commitPlannedParsedSource,
  commitNewParsedSource,
  prepareParsedSourceWritePlan,
  prepareCatalogForParser,
  readCatalogCache,
  updateSystemLog,
  type ParsedSourceWritePlan,
  type NewParseCommitResult
} from "../../adapters/library-data/index.mts";
import { readCurrentAuthorityPair } from "../../adapters/storage/recovery-point.mts";
import {
  CLAUDE_CONTAINER_ADAPTER_VERSION,
  parsePreparedClaudeContainerRecord,
  prepareClaudeContainerExtraction,
  queryClaudeContainerRecords,
  writeClaudeContainerOutputState
} from "../../adapters/parser/claude-container.mts";
import { validateOperation } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { isSourceContentError, nextContentFailureAttempts } from "./failure-policy.mts";

export type ClaudeSelectionItemResult =
  | Readonly<{ index: number; status: "created" | "updated" | "preserved"; archive: string; path: string }>
  | Readonly<{ index: number; status: "unchanged" }>
  | Readonly<{ index: number; status: "unsupported" }>
  | Readonly<{ index: number; status: "conflict"; reason: string }>
  | Readonly<{ index: number; status: "failed"; code: string }>
  | Readonly<{ index: number; status: "cancelled" }>
  | Readonly<{ index: number; status: "not_started" }>;

export type ClaudeSelectionResult = Readonly<{
  state: "completed" | "cancelled";
  items: readonly ClaudeSelectionItemResult[];
}>;

export type PreparedClaudeSelectionItem = Readonly<{
  index: number;
  selector: string;
  action: "new" | "safe_update" | "conservative_new" | "preserve" | "unchanged" | "excluded";
  reason: string;
  messages?: number;
  resources?: number;
  plan?: ParsedSourceWritePlan;
}>;

export type PreparedClaudeSelection = Readonly<{
  sourcePath: string;
  sourceSha256: string;
  targetDirectory?: string;
  preservePrevious: boolean;
  copyUserStateOnPreserve: boolean;
  items: readonly PreparedClaudeSelectionItem[];
}>;

function emit(event: JsonObject, callback?: (event: JsonObject) => void): void {
  const validation = validateOperation(event);
  if (!validation.ok) throw new TypeError(`Internal Claude operation event is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  callback?.(structuredClone(validation.value));
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function claudeLogError(code: string, error?: unknown): JsonObject {
  const message = code === "unsupported"
    ? "Parser does not support one selected Claude conversation record with the current Adapter."
    : code === "missing"
      ? "One selected Claude conversation record is no longer present in the current container index."
      : "Parser could not convert one selected Claude conversation record into a Conversation archive.";
  const detail = error instanceof Error ? error.message.replace(/(?:[A-Za-z]:[\\/]|\\\\)\S+/gu, "[path omitted]").slice(0, 4096) : undefined;
  return { source: "parser", code, stage: "extract", message: detail || message };
}

async function finishClaudeSystemLog(libraryRoot: string, sourcePath: string, timestamp: string, errors: readonly JsonObject[]): Promise<void> {
  try {
    await updateSystemLog(libraryRoot, [errors.length > 0
      ? { path: sourcePath, outcome: "errors", recordedAt: timestamp, errors }
      : { path: sourcePath, outcome: "success_no_errors" }]);
  } catch {
    // System Log failure cannot roll back valid extracted archives or container state.
  }
}

function selectors(value: readonly string[]): string[] {
  if (value.length === 0) throw new TypeError("Claude selection requires at least one record");
  const result: string[] = [];
  for (const selector of value) {
    if (!/^[0-9a-f]{64}$/u.test(selector)) throw new TypeError("Claude selection contains an invalid selector");
    if (result.includes(selector)) throw new TypeError("Claude selection contains a duplicate selector");
    result.push(selector);
  }
  return result;
}

function noteClaudeFailure(failures: Map<string, JsonObject>, selector: string, timestamp: string, contentFailure: boolean): string {
  const prior = failures.get(selector);
  const previous = prior?.["adapter_version"] === CLAUDE_CONTAINER_ADAPTER_VERSION ? Number(prior["attempts"]) : 0;
  const code = contentFailure ? "claude-record-invalid" : "claude-record-failed";
  failures.set(selector, { selector, code, attempts: nextContentFailureAttempts(previous, contentFailure), adapter_version: CLAUDE_CONTAINER_ADAPTER_VERSION, failed_at: timestamp });
  return code;
}

export async function prepareClaudeContainerSelection(input: Readonly<{
  libraryRoot: string;
  sourcePath: string;
  selectors: readonly string[];
  preservePrevious: boolean;
  copyUserStateOnPreserve: boolean;
  targetDirectory?: string;
  fileSystemCapturedAt?: string;
  operation?: string;
  signal?: AbortSignal;
  onEvent?: (event: JsonObject) => void;
}>): Promise<PreparedClaudeSelection> {
  const selected = selectors(input.selectors);
  const prepared = await prepareClaudeContainerExtraction({
    libraryRoot: input.libraryRoot,
    sourcePath: input.sourcePath,
    ...(input.fileSystemCapturedAt ? { fileSystemCapturedAt: input.fileSystemCapturedAt } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  const query = await queryClaudeContainerRecords({ libraryRoot: input.libraryRoot, sourceSha256: prepared.sourceFingerprint.sha256 });
  const records = new Map(query.records.map((record) => [record["selector"] as string, record]));
  const items: PreparedClaudeSelectionItem[] = [];
  let completed = 0;
  if (input.operation) emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "discover", state: "started", file: { index: 1, completed, total: selected.length } }, input.onEvent);
  for (const [offset, selector] of selected.entries()) {
    const index = offset + 1;
    const record = records.get(selector);
    if (!record) { completed += 1; items.push({ index, selector, action: "excluded", reason: "missing" }); continue; }
    if (record["status"] === "unsupported") { completed += 1; items.push({ index, selector, action: "excluded", reason: "unsupported" }); continue; }
    try {
      const parsed = await parsePreparedClaudeContainerRecord({
        prepared,
        selector,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.operation ? {
          onProgress: (itemsCompleted, itemsTotal) => emit({
            schema: "cloudig/operation/1.0.0", operation: input.operation!, phase: "normalize", state: "progress",
            file: { index, completed, total: selected.length }, items: { completed: itemsCompleted, total: itemsTotal }
          }, input.onEvent)
        } : {})
      });
      const plan = await prepareParsedSourceWritePlan({
        libraryRoot: input.libraryRoot,
        sourcePath: prepared.sourcePath,
        parsed,
        preservePrevious: input.preservePrevious,
        copyUserStateOnPreserve: input.copyUserStateOnPreserve,
        ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {})
      });
      completed += 1;
      items.push({
        index, selector, action: plan.action, reason: plan.reason,
        messages: Array.isArray(parsed.draft["messages"]) ? parsed.draft["messages"].length : 0,
        resources: Array.isArray(parsed.draft["resources"]) ? parsed.draft["resources"].length : 0,
        plan
      });
    } catch (error) {
      if (aborted(error) || input.signal?.aborted) throw error;
      completed += 1;
      items.push({ index, selector, action: "excluded", reason: isSourceContentError(error) ? "claude-record-invalid" : "claude-record-failed" });
    }
  }
  if (input.operation) emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "plan", state: "completed", file: { index: selected.length, completed: selected.length, total: selected.length }, items: { completed: selected.length, total: selected.length } }, input.onEvent);
  return {
    sourcePath: prepared.sourcePath,
    sourceSha256: prepared.sourceFingerprint.sha256,
    preservePrevious: input.preservePrevious,
    copyUserStateOnPreserve: input.copyUserStateOnPreserve,
    ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {}),
    items
  };
}

export async function previewClaudeContainerSelection(input: Readonly<{
  libraryRoot: string;
  sourceSha256: string;
  selectors: readonly string[];
  targetDirectory?: string;
  preservePrevious?: boolean;
  copyUserStateOnPreserve?: boolean;
}>): Promise<Readonly<{
  sourcePath: string;
  targetDirectory: string;
  items: readonly Readonly<{ index: number; action: "new" | "safe_update" | "conservative_new" | "preserve" | "unchanged" | "excluded" | "missing" }>[];
}>> {
  const selected = selectors(input.selectors);
  const query = await queryClaudeContainerRecords({ libraryRoot: input.libraryRoot, sourceSha256: input.sourceSha256 });
  const sourcePath = String(query.source["path"]);
  const known = new Set(query.records.map((record) => record["selector"] as string));
  const present = selected.filter((selector) => known.has(selector));
  const prepared = present.length > 0 ? await prepareClaudeContainerSelection({
    libraryRoot: input.libraryRoot,
    sourcePath,
    selectors: present,
    preservePrevious: input.preservePrevious === true,
    copyUserStateOnPreserve: input.copyUserStateOnPreserve !== false,
    ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {})
  }) : undefined;
  const planned = new Map(prepared?.items.map((item) => [item.selector, item.action]) ?? []);
  return {
    sourcePath,
    targetDirectory: input.targetDirectory ?? "Conversations",
    items: selected.map((selector, index) => ({
      index: index + 1,
      action: !known.has(selector) ? "missing" : planned.get(selector) ?? "excluded"
    }))
  };
}

export async function runPreparedClaudeContainerSelection(input: Readonly<{
  libraryRoot: string;
  plan: PreparedClaudeSelection;
  copyUserStateOnPreserve: boolean;
  operation: string;
  transactionTokens: readonly string[];
  recoveryTransaction: string;
  timestamp: string;
  fileSystemCapturedAt?: string;
  signal?: AbortSignal;
  onEvent?: (event: JsonObject) => void;
}>): Promise<ClaudeSelectionResult> {
  if (input.transactionTokens.length !== input.plan.items.length) throw new TypeError("Every planned Claude record requires one transaction token");
  const total = input.plan.items.length;
  const results: ClaudeSelectionItemResult[] = [];
  const logErrors: JsonObject[] = [];
  let logProcessed = false;
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
      state: "completed",
      items: input.plan.items.map((item) => item.plan
        ? { index: item.index, status: "conflict", reason: "library_changed_after_preview" }
        : item.reason === "unsupported"
          ? { index: item.index, status: "unsupported" }
          : { index: item.index, status: "failed", code: item.reason })
    };
  }
  if (input.plan.items.some((item) => item.plan && item.action !== "unchanged")) {
    const catalog = await prepareCatalogForParser(input.libraryRoot, input.timestamp);
    if (catalog.status !== "ready") return {
      state: "completed",
      items: input.plan.items.map((item) => ({ index: item.index, status: "failed", code: "catalog-not-ready" }))
    };
  }
  emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "discover", state: "started", file: { index: 1, completed, total } }, input.onEvent);
  const prepared = await prepareClaudeContainerExtraction({
    libraryRoot: input.libraryRoot,
    sourcePath: input.plan.sourcePath,
    ...(input.fileSystemCapturedAt ? { fileSystemCapturedAt: input.fileSystemCapturedAt } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  if (prepared.sourceFingerprint.sha256 !== input.plan.sourceSha256) return { state: "completed", items: input.plan.items.map((item) => ({ index: item.index, status: "conflict", reason: "container_changed_after_preview" })) };
  const current = await queryClaudeContainerRecords({ libraryRoot: input.libraryRoot, sourceSha256: prepared.sourceFingerprint.sha256 });
  const failures = new Map(current.records.filter((record) => isJsonObject(record["failure"])).map((record) => [record["selector"] as string, structuredClone(record["failure"] as JsonObject)]));
  const finish = async (state: "completed" | "cancelled"): Promise<ClaudeSelectionResult> => {
    try {
      const currentCatalog = await readCatalogCache(input.libraryRoot);
      const rows = Array.isArray(currentCatalog?.["sources"])
        ? currentCatalog["sources"].filter((entry): entry is JsonObject => isJsonObject(entry) && entry["path"] === prepared.sourcePath && entry["sha256"] === prepared.sourceFingerprint.sha256)
        : [];
      const outputs = rows.length === 1 && Array.isArray(rows[0]!["outputs"]) ? rows[0]!["outputs"].filter((entry): entry is JsonObject => isJsonObject(entry)) : [];
      await writeClaudeContainerOutputState({ libraryRoot: input.libraryRoot, sourceSha256: prepared.sourceFingerprint.sha256, outputs, failures: [...failures.values()] });
    } catch {
      // Container state is rebuildable and never owns archive truth.
    }
    if (state === "completed" && logProcessed) await finishClaudeSystemLog(input.libraryRoot, prepared.sourcePath, input.timestamp, logErrors);
    return { state, items: results };
  };
  for (const [offset, item] of input.plan.items.entries()) {
    const index = item.index;
    if (input.signal?.aborted) {
      results.push({ index, status: "cancelled" });
      for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
      return finish("cancelled");
    }
    if (item.action === "excluded" || !item.plan) {
      completed += 1;
      logProcessed = true;
      if (item.reason === "unsupported") {
        results.push({ index, status: "unsupported" });
        logErrors.push(claudeLogError("unsupported"));
      }
      else {
        if (item.reason === "claude-record-invalid" || item.reason === "claude-record-failed") noteClaudeFailure(failures, item.selector, input.timestamp, item.reason === "claude-record-invalid");
        results.push({ index, status: "failed", code: item.reason });
        logErrors.push(claudeLogError(item.reason));
      }
      continue;
    }
    if (input.signal?.aborted) {
      results.push({ index, status: "cancelled" });
      for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
      return finish("cancelled");
    }
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    if (authority.libraryFingerprint.bytes !== expectedAuthority.libraryFingerprint.bytes || authority.libraryFingerprint.sha256 !== expectedAuthority.libraryFingerprint.sha256) {
      results.push({ index, status: "conflict", reason: "library_changed_after_preview" });
      for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
      return finish("completed");
    }
    try {
      const parsed = await parsePreparedClaudeContainerRecord({
        prepared,
        selector: item.selector,
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: (itemsCompleted, itemsTotal) => emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "normalize", state: "progress", file: { index, completed, total }, items: { completed: itemsCompleted, total: itemsTotal } }, input.onEvent)
      });
      const effectivePlan: ParsedSourceWritePlan = {
        ...item.plan,
        copyUserState: item.plan.action === "preserve" ? input.copyUserStateOnPreserve : item.plan.copyUserState,
        expectedLibraryRevision: authority.library["revision"] as number,
        expectedLibraryFingerprint: authority.libraryFingerprint
      };
      const committed = await commitPlannedParsedSource({
        libraryRoot: input.libraryRoot,
        plan: effectivePlan,
        parsed,
        transaction: input.transactionTokens[offset]!,
        recoveryTransaction: input.recoveryTransaction,
        recoveryAlreadyCapturedThisBatch: recoveryCaptured,
        timestamp: input.timestamp,
        initialSourceFingerprint: prepared.sourceFingerprint,
        ...(input.signal ? { signal: input.signal } : {}),
        onPhase: (phase) => emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase, state: phase === "commit" ? "waiting_commit" : "progress", file: { index, completed, total } }, input.onEvent)
      });
      if (committed.status === "cancelled") {
        results.push({ index, status: "cancelled" });
        for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
        return finish("cancelled");
      }
      completed += 1;
      if (committed.status === "created" || committed.status === "updated" || committed.status === "preserved") {
        logProcessed = true;
        failures.delete(item.selector);
        recoveryCaptured = true;
        results.push({ index, status: committed.status, archive: committed.archive, path: committed.path });
        expectedAuthority = await readCurrentAuthorityPair(input.libraryRoot);
      } else if (committed.status === "unchanged") {
        logProcessed = true;
        failures.delete(item.selector);
        results.push({ index, status: "unchanged" });
      } else if (committed.status === "conflict") {
        results.push({ index, status: "conflict", reason: committed.reason });
      } else throw new TypeError("Claude commit returned an unknown status");
    } catch (error) {
      if (aborted(error) || input.signal?.aborted) {
        results.push({ index, status: "cancelled" });
        for (const later of input.plan.items.slice(offset + 1)) results.push({ index: later.index, status: "not_started" });
        return finish("cancelled");
      }
      completed += 1;
      logProcessed = true;
      const code = noteClaudeFailure(failures, item.selector, input.timestamp, isSourceContentError(error));
      results.push({ index, status: "failed", code });
      logErrors.push(claudeLogError(code, error));
    }
  }
  emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "verify", state: "completed", file: { index: total, completed: total, total }, items: { completed: total, total } }, input.onEvent);
  return finish("completed");
}

export async function runClaudeContainerSelection(input: Readonly<{
  libraryRoot: string;
  sourcePath: string;
  selectors: readonly string[];
  operation: string;
  transactionTokens: readonly string[];
  recoveryTransaction: string;
  timestamp: string;
  targetDirectory?: string;
  fileSystemCapturedAt?: string;
  signal?: AbortSignal;
  onEvent?: (event: JsonObject) => void;
}>): Promise<ClaudeSelectionResult> {
  const selected = selectors(input.selectors);
  if (input.transactionTokens.length !== selected.length) throw new TypeError("Every selected Claude record requires one transaction token");
  const total = selected.length;
  const results: ClaudeSelectionItemResult[] = [];
  const logErrors: JsonObject[] = [];
  let logProcessed = false;
  let completed = 0;
  let recoveryCaptured = false;
  emit({
    schema: "cloudig/operation/1.0.0",
    operation: input.operation,
    phase: "discover",
    state: "started",
    file: { index: 1, completed: 0, total }
  }, input.onEvent);
  const catalog = await prepareCatalogForParser(input.libraryRoot, input.timestamp);
  if (catalog.status !== "ready") {
    return {
      state: "completed",
      items: selected.map((_, index) => ({ index: index + 1, status: "failed", code: "catalog-not-ready" }))
    };
  }
  let prepared;
  try {
    prepared = await prepareClaudeContainerExtraction({
      libraryRoot: input.libraryRoot,
      sourcePath: input.sourcePath,
      ...(input.fileSystemCapturedAt ? { fileSystemCapturedAt: input.fileSystemCapturedAt } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
  } catch (error) {
    if (aborted(error) || input.signal?.aborted) {
      return { state: "cancelled", items: selected.map((_, index) => ({ index: index + 1, status: index === 0 ? "cancelled" : "not_started" })) };
    }
    return { state: "completed", items: selected.map((_, index) => ({ index: index + 1, status: "failed", code: "container-not-ready" })) };
  }

  const current = await queryClaudeContainerRecords({
    libraryRoot: input.libraryRoot,
    sourceSha256: prepared.sourceFingerprint.sha256
  });
  const completedSelectors = new Set(
    current.records
      .filter((record) => record["status"] === "parsed")
      .map((record) => record["selector"] as string)
  );
  const unsupportedSelectors = new Set(
    current.records
      .filter((record) => record["status"] === "unsupported")
      .map((record) => record["selector"] as string)
  );
  const failures = new Map(
    current.records
      .filter((record) => isJsonObject(record["failure"]))
      .map((record) => [record["selector"] as string, structuredClone(record["failure"] as JsonObject)])
  );

  const finish = async (state: "completed" | "cancelled", items: readonly ClaudeSelectionItemResult[]): Promise<ClaudeSelectionResult> => {
    try {
      const currentCatalog = await readCatalogCache(input.libraryRoot);
      const rows = Array.isArray(currentCatalog?.["sources"])
        ? currentCatalog["sources"].filter((entry): entry is JsonObject => (
          isJsonObject(entry)
          && entry["path"] === prepared.sourcePath
          && entry["sha256"] === prepared.sourceFingerprint.sha256
        ))
        : [];
      const outputs = rows.length === 1 && Array.isArray(rows[0]!["outputs"])
        ? rows[0]!["outputs"].filter((entry): entry is JsonObject => isJsonObject(entry))
        : [];
      await writeClaudeContainerOutputState({
        libraryRoot: input.libraryRoot,
        sourceSha256: prepared.sourceFingerprint.sha256,
        outputs,
        failures: [...failures.values()]
      });
    } catch {
      // Container state is rebuildable. A refresh failure never rolls back valid archives.
    }
    if (state === "completed" && logProcessed) await finishClaudeSystemLog(input.libraryRoot, prepared.sourcePath, input.timestamp, logErrors);
    return { state, items };
  };

  for (const [offset, selector] of selected.entries()) {
    const index = offset + 1;
    if (input.signal?.aborted) {
      results.push({ index, status: "cancelled" });
      for (let later = index + 1; later <= total; later += 1) results.push({ index: later, status: "not_started" });
      emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "extract", state: "cancelled", file: { index, completed, total } }, input.onEvent);
      return finish("cancelled", results);
    }
    if (completedSelectors.has(selector)) {
      logProcessed = true;
      completed += 1;
      results.push({ index, status: "unchanged" });
      emit({
        schema: "cloudig/operation/1.0.0",
        operation: input.operation,
        phase: "extract",
        state: "completed",
        file: { index, completed, total }
      }, input.onEvent);
      continue;
    }
    if (unsupportedSelectors.has(selector)) {
      logProcessed = true;
      logErrors.push(claudeLogError("unsupported"));
      completed += 1;
      results.push({ index, status: "unsupported" });
      emit({
        schema: "cloudig/operation/1.0.0",
        operation: input.operation,
        phase: "extract",
        state: "completed",
        file: { index, completed, total }
      }, input.onEvent);
      continue;
    }
    emit({ schema: "cloudig/operation/1.0.0", operation: input.operation, phase: "extract", state: "started", file: { index, completed, total } }, input.onEvent);
    try {
      const parsed = await parsePreparedClaudeContainerRecord({
        prepared,
        selector,
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: (itemsCompleted, itemsTotal) => emit({
          schema: "cloudig/operation/1.0.0",
          operation: input.operation,
          phase: "normalize",
          state: "progress",
          file: { index, completed, total },
          items: { completed: itemsCompleted, total: itemsTotal }
        }, input.onEvent)
      });
      const committed: NewParseCommitResult = await commitNewParsedSource({
        libraryRoot: input.libraryRoot,
        sourcePath: input.sourcePath,
        parsed,
        ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {}),
        transaction: input.transactionTokens[offset]!,
        recoveryTransaction: input.recoveryTransaction,
        recoveryAlreadyCapturedThisBatch: recoveryCaptured,
        timestamp: input.timestamp,
        initialSourceFingerprint: prepared.sourceFingerprint,
        ...(input.signal ? { signal: input.signal } : {}),
        onPhase: (phase) => emit({
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
        return finish("cancelled", results);
      }
      completed += 1;
      if (committed.status === "created") {
        logProcessed = true;
        failures.delete(selector);
        recoveryCaptured = true;
        results.push({ index, status: "created", archive: committed.archive, path: committed.path });
      } else {
        results.push({ index, status: "conflict", reason: committed.reason });
      }
    } catch (error) {
      if (aborted(error) || input.signal?.aborted) {
        results.push({ index, status: "cancelled" });
        for (let later = index + 1; later <= total; later += 1) results.push({ index: later, status: "not_started" });
        return finish("cancelled", results);
      }
      completed += 1;
      logProcessed = true;
      const code = noteClaudeFailure(failures, selector, input.timestamp, isSourceContentError(error));
      results.push({ index, status: "failed", code });
      logErrors.push(claudeLogError(code, error));
      emit({
        schema: "cloudig/operation/1.0.0",
        operation: input.operation,
        phase: "extract",
        state: "failed",
        file: { index, completed, total },
        error: { code, retry: code === "claude-record-invalid" && Number(failures.get(selector)?.["attempts"]) >= 2 ? "after_adapter_change" : "immediate" }
      }, input.onEvent);
    }
  }
  emit({
    schema: "cloudig/operation/1.0.0",
    operation: input.operation,
    phase: "verify",
    state: "completed",
    file: { index: total, completed: total, total },
    items: { completed: total, total }
  }, input.onEvent);
  return finish("completed", results);
}
