import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { allocateArchive, recoverNextArchive } from "../../core/archive/ids.mts";
import {
  decideArchiveWrite,
  type ArchiveWriteDecision,
  type SourceLineIdentity
} from "../../core/archive/safe-replace.mts";
import {
  computeConversationContentSha256,
  ContractValidationError,
  serializeLibrary,
  validateConversation,
  validateConversationMetadata
} from "../../core/contracts/index.mts";
import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import type { ParsedSourceDraft } from "../../app/parser/adapter.mts";
import { adapterBundleSha256, PARSER_VERSION } from "../../app/parser/registry.mts";
import { copyArchiveStateWithoutInventingEdit } from "../../core/library/overlay.mts";
import { openCanonicalConversationFile } from "../reader/conversation-file.mts";
import {
  cleanupJournal,
  installJournal,
  persistJournal,
  prepareJournalTargets,
  recoverJournal,
  removeCleanJournalFiles,
  rollbackJournal,
  stagePreparedJournalTargets
} from "../storage/journal.mts";
import {
  deleteVerifiedResourceSpools,
  detachConversationResourceBodies,
  spoolDetachedResourceBodies,
  streamCanonicalConversation,
  verifyStagedConversationResources,
  type ResourceSpool
} from "../storage/conversation-stream.mts";
import { chooseNoReplaceLeaf, safeWindowsLeaf } from "../storage/names.mts";
import { parseManagedRelativePath, resolveManagedPath } from "../storage/path.mts";
import {
  capturePreviousAuthority,
  readCurrentAuthorityPair,
  readPreviousAuthorityPair
} from "../storage/recovery-point.mts";
import { fingerprintFile, type ByteFingerprint } from "../storage/stream.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";
import {
  projectCatalogArchiveSummary,
  projectCatalogSourceOutput,
  publishParsedCatalogDelta,
  type ParserCatalogBatch,
  readCatalogCache,
  rebuildCatalogCache,
  scanLibraryFiles
} from "./catalog.mts";

type CatalogRefreshInput = {
  sourceRows: Record<string, JsonObject>;
  archiveRows: Record<string, JsonObject>;
};

function stripObservation(row: JsonObject, fields: readonly string[]): JsonObject {
  const copy = structuredClone(row);
  for (const field of fields) delete copy[field];
  return copy;
}

function catalogRefreshInput(catalog: JsonObject | undefined): CatalogRefreshInput {
  const sourceRows: Record<string, JsonObject> = {};
  const archiveRows: Record<string, JsonObject> = {};
  if (catalog && Array.isArray(catalog["sources"])) {
    for (const raw of catalog["sources"]) {
      if (!isJsonObject(raw) || typeof raw["path"] !== "string") continue;
      sourceRows[raw["path"]] = structuredClone(raw);
    }
  }
  if (catalog && Array.isArray(catalog["archives"])) {
    for (const raw of catalog["archives"]) {
      if (!isJsonObject(raw) || typeof raw["path"] !== "string") continue;
      archiveRows[raw["path"]] = stripObservation(raw, ["path", "bytes", "mtime_ns", "archived"]);
    }
  }
  return { sourceRows, archiveRows };
}

export async function prepareCatalogForParser(
  libraryRoot: string,
  builtAt: string
): Promise<Readonly<{
  status: "ready" | "conflict" | "invalid" | "archive_summary_required";
  issues: readonly { path: string; code: string }[];
}>> {
  const current = await readCatalogCache(libraryRoot);
  const input = catalogRefreshInput(current);
  const result = await rebuildCatalogCache(libraryRoot, {
    builtAt,
    adapterBundleSha256: adapterBundleSha256(),
    sourceRows: input.sourceRows,
    archiveRows: input.archiveRows
  });
  if (result.status === "conflict") return { status: "conflict", issues: result.issues };
  if (result.status === "invalid") return { status: "invalid", issues: result.issues };
  if (result.issues.some((entry) => entry.code === "archive-summary-unavailable")) {
    return { status: "archive_summary_required", issues: result.issues };
  }
  return { status: "ready", issues: result.issues };
}

function inboxSourcePath(value: string): string {
  const segments = parseManagedRelativePath(value);
  if (segments.length !== 2 || segments[0] !== "Inbox") throw new TypeError("Parser source must be a direct Inbox file");
  safeWindowsLeaf(segments[1]!, "Inbox source filename");
  return segments.join("/");
}

function titleFilename(title: unknown, archive: string): string {
  const raw = typeof title === "string" ? title : "conversation";
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[ .]+$/u, "");
  const suffix = `--${archive}.json`;
  const available = 240 - suffix.length;
  const stem = Array.from(cleaned || "conversation").slice(0, available).join("").replace(/[ .]+$/u, "") || "conversation";
  return safeWindowsLeaf(`${stem}${suffix}`, "Conversation filename");
}

function initialFileConversationName(parsed: ParsedSourceDraft): string | undefined {
  const source = isJsonObject(parsed.draft["source"]) ? parsed.draft["source"] : {};
  // A container filename belongs to all its records, not to an individual
  // conversation. Ordinary source files supply the initial editable name.
  if (isJsonObject(source["locator"]) && source["locator"]["kind"] === "account_export_record") return undefined;
  const filename = source["file"];
  return typeof filename === "string" ? path.parse(filename).name || undefined : undefined;
}

function sourceRoute(parsed: ParsedSourceDraft): Readonly<{
  format: string;
  platform: string;
  payload_schema: string;
  profile: string;
}> {
  const route = parsed.adapter.routes[0];
  if (!route) throw new TypeError("Parsed source Adapter has no route");
  return {
    format: route.format,
    platform: route.platform,
    payload_schema: route.payload,
    profile: route.profile
  };
}

function parsedSourceIdentity(parsed: ParsedSourceDraft): SourceLineIdentity {
  const route = parsed.adapter.routes[0];
  const source = isJsonObject(parsed.draft["source"]) ? parsed.draft["source"] : {};
  const payload = typeof source["payload"] === "string" ? source["payload"] : route?.payload;
  const profile = typeof source["profile"] === "string" ? source["profile"] : route?.profile;
  return {
    format: typeof source["format"] === "string" ? source["format"] : route?.format ?? "exporter-html",
    platform: typeof parsed.draft["platform"] === "string" ? parsed.draft["platform"] : route?.platform ?? "unknown",
    family: parsed.adapter.family,
    ...(payload ? { payload } : {}),
    ...(profile ? { profile } : {}),
    ...(isJsonObject(source["locator"]) ? { selector: structuredClone(source["locator"]) } : {})
  };
}

function priorSourceIdentity(parsed: ParsedSourceDraft, conversation: JsonObject): SourceLineIdentity {
  const source = isJsonObject(conversation["source"]) ? conversation["source"] : {};
  const parser = isJsonObject(conversation["parser"]) ? conversation["parser"] : {};
  const adapter = isJsonObject(parser["adapter"]) ? parser["adapter"] : {};
  const recognized = adapter["id"] === parsed.adapter.id
    || parsed.adapter.update_from.some((entry) => entry.adapter === adapter["id"] && entry.version === adapter["version"]);
  return {
    format: typeof source["format"] === "string" ? source["format"] : "unknown",
    platform: typeof conversation["platform"] === "string" ? conversation["platform"] : "unknown",
    family: recognized ? parsed.adapter.family : `unknown:${String(adapter["id"] ?? "adapter")}`,
    ...(typeof source["payload"] === "string" ? { payload: source["payload"] } : {}),
    ...(typeof source["profile"] === "string" ? { profile: source["profile"] } : {}),
    ...(isJsonObject(source["locator"]) ? { selector: structuredClone(source["locator"]) } : {})
  };
}

function translationCompatibility(parsed: ParsedSourceDraft, conversation: JsonObject): "same_adapter" | "none" | "reparse_source" | "redownload_source" | "upgrade_cloudig" | "unsupported" | "unknown_policy" {
  const parser = isJsonObject(conversation["parser"]) ? conversation["parser"] : {};
  const adapter = isJsonObject(parser["adapter"]) ? parser["adapter"] : {};
  if (adapter["id"] === parsed.adapter.id && adapter["version"] === parsed.adapter.version) return "same_adapter";
  const rule = parsed.adapter.update_from.find((entry) => entry.adapter === adapter["id"] && entry.version === adapter["version"]);
  return rule?.action ?? "unknown_policy";
}

function planAction(decision: ArchiveWriteDecision): ParsedSourcePlanAction {
  if (decision.action === "unchanged") return "unchanged";
  if (decision.action === "replace") return "safe_update";
  if (decision.action === "create_new") return decision.reason === "new_source_unit"
    ? "new"
    : decision.reason === "preserve_previous"
      ? "preserve"
      : "conservative_new";
  return "excluded";
}

function sourceOutputs(row: JsonObject | undefined, selector: string | undefined): JsonObject[] {
  return row && Array.isArray(row["outputs"])
    ? row["outputs"].filter((entry): entry is JsonObject => (
      isJsonObject(entry)
      && (selector ? entry["selector"] === selector : entry["selector"] === undefined)
    ))
    : [];
}

async function proveRegisteredSourceMigration(input: Readonly<{
  libraryRoot: string;
  currentPath: string;
  fingerprint: ByteFingerprint;
  selector?: string;
  catalog: JsonObject;
  knownPresentSourcePaths?: ReadonlySet<string>;
}>): Promise<JsonObject | undefined> {
  if (!Array.isArray(input.catalog["sources"])) return undefined;
  // A new source normally has no possible predecessor. Do not scan the whole
  // Library just to discover that; batch-known present paths cannot be missing.
  if (!input.catalog["sources"].some(entry => isJsonObject(entry)
    && entry["path"] !== input.currentPath
    && !input.knownPresentSourcePaths?.has(String(entry["path"]))
    && entry["sha256"] === input.fingerprint.sha256
    && entry["bytes"] === input.fingerprint.bytes
    && sourceOutputs(entry, input.selector).length > 0)) return undefined;
  const scan = await scanLibraryFiles(input.libraryRoot);
  const observed = new Map(scan.sources.map((entry) => [entry.path, entry]));
  if (!observed.has(input.currentPath)) return undefined;
  const missingMatches = input.catalog["sources"].filter((entry): entry is JsonObject => (
    isJsonObject(entry)
    && typeof entry["path"] === "string"
    && entry["path"] !== input.currentPath
    && !observed.has(entry["path"] as string)
    && entry["sha256"] === input.fingerprint.sha256
    && entry["bytes"] === input.fingerprint.bytes
    && sourceOutputs(entry, input.selector).length > 0
  ));
  if (missingMatches.length !== 1) return undefined;

  let sameShaObserved = 0;
  const catalogRows = new Map(
    input.catalog["sources"].filter(isJsonObject).map((entry) => [entry["path"] as string, entry])
  );
  for (const entry of scan.sources) {
    if (entry.bytes !== input.fingerprint.bytes) continue;
    let sha256: string;
    if (entry.path === input.currentPath) sha256 = input.fingerprint.sha256;
    else {
      const cached = catalogRows.get(entry.path);
      if (cached?.["bytes"] === entry.bytes && cached["mtime_ns"] === entry.mtime_ns && typeof cached["sha256"] === "string") {
        sha256 = cached["sha256"];
      } else {
        // Missing cached proof makes migration conservative instead of starting a hidden second-file hash.
        return undefined;
      }
    }
    if (sha256 === input.fingerprint.sha256) sameShaObserved += 1;
    if (sameShaObserved > 1) return undefined;
  }
  return sameShaObserved === 1 ? missingMatches[0] : undefined;
}

export async function prepareParsedSourceWritePlan(input: Readonly<{
  libraryRoot: string;
  sourcePath: string;
  parsed: ParsedSourceDraft;
  preservePrevious: boolean;
  copyUserStateOnPreserve: boolean;
  targetDirectory?: string;
  knownPresentSourcePaths?: ReadonlySet<string>;
}>): Promise<ParsedSourceWritePlan> {
  const sourceRelative = inboxSourcePath(input.sourcePath);
  const authority = await readCurrentAuthorityPair(input.libraryRoot);
  const sourceIdentity = parsedSourceIdentity(input.parsed);
  const catalog = await readCatalogCache(input.libraryRoot);
  const sourceRows = catalog && Array.isArray(catalog["sources"])
    ? catalog["sources"].filter((entry): entry is JsonObject => isJsonObject(entry) && entry["path"] === sourceRelative)
    : [];
  let sourceRow = sourceRows.length === 1 ? sourceRows[0] : undefined;
  const candidateSource = isJsonObject(input.parsed.draft["source"]) ? input.parsed.draft["source"] : {};
  const candidateLocator = isJsonObject(candidateSource["locator"]) ? candidateSource["locator"] : undefined;
  const candidateSelector = candidateLocator?.["kind"] === "account_export_record" && typeof candidateLocator["value"] === "string"
    ? candidateLocator["value"]
    : undefined;
  let outputs = sourceOutputs(sourceRow, candidateSelector);
  let registeredSourcePath = sourceRelative;
  let registeredPathMigrationProven = false;
  if (outputs.length === 0 && catalog) {
    const migrated = await proveRegisteredSourceMigration({
      libraryRoot: input.libraryRoot,
      currentPath: sourceRelative,
      fingerprint: input.parsed.sourceFingerprint,
      ...(candidateSelector ? { selector: candidateSelector } : {}),
      catalog,
      ...(input.knownPresentSourcePaths ? { knownPresentSourcePaths: input.knownPresentSourcePaths } : {})
    });
    if (migrated) {
      sourceRow = migrated;
      outputs = sourceOutputs(migrated, candidateSelector);
      registeredSourcePath = migrated["path"] as string;
      registeredPathMigrationProven = true;
    }
  }
  const output = outputs.at(-1);
  let binding: ParsedSourceWritePlan["binding"];
  let target: Readonly<{ path: string; fingerprint: ByteFingerprint; schemaSupported: boolean; archive: string; generation: number }> | undefined;
  let compatibility: ReturnType<typeof translationCompatibility> = "same_adapter";

  if (output && typeof output["path"] === "string" && typeof output["archive"] === "string" && typeof output["generation"] === "number") {
    const archiveRows = catalog && Array.isArray(catalog["archives"])
      ? catalog["archives"].filter((entry): entry is JsonObject => isJsonObject(entry) && entry["path"] === output["path"])
      : [];
    const archiveRow = archiveRows.length === 1 ? archiveRows[0] : undefined;
    try {
      const absolute = await resolveManagedPath(input.libraryRoot, output["path"] as string, { mustExist: true });
      const opened = await openCanonicalConversationFile({ filePath: absolute });
      try {
        const conversation = opened.index.conversation;
        const source = isJsonObject(conversation["source"]) ? conversation["source"] : {};
        const priorFingerprint = typeof source["bytes"] === "number" && typeof source["sha256"] === "string"
          ? { bytes: source["bytes"], sha256: source["sha256"] }
          : input.parsed.sourceFingerprint;
        const priorIdentity = priorSourceIdentity(input.parsed, conversation);
        const catalogFresh = catalog?.["adapter_bundle_sha256"] === adapterBundleSha256()
          && archiveRow?.["archive"] === output["archive"]
          && archiveRow?.["generation"] === output["generation"]
          && archiveRow?.["bytes"] === opened.index.fingerprint.bytes
          && archiveRow?.["sha256"] === opened.index.fingerprint.sha256
          && conversation["archive"] === output["archive"]
          && conversation["generation"] === output["generation"];
        binding = {
          registeredSourcePath,
          archive: output["archive"] as string,
          generation: output["generation"] as number,
          targetPath: output["path"] as string,
          targetFingerprint: opened.index.fingerprint,
          sourceFingerprint: priorFingerprint,
          sourceIdentity: priorIdentity,
          ...(isJsonObject(conversation["user"]) ? { user: structuredClone(conversation["user"] as JsonObject) } : {}),
          ...(isJsonObject(conversation["lifecycle"]) ? { lifecycle: structuredClone(conversation["lifecycle"] as JsonObject) } : {})
        };
        compatibility = translationCompatibility(input.parsed, conversation);
        target = {
          path: output["path"] as string,
          fingerprint: opened.index.fingerprint,
          schemaSupported: conversation["schema"] === "cloudig/conversation/1.0.0" && catalogFresh,
          archive: String(conversation["archive"]),
          generation: Number(conversation["generation"])
        };
      } finally {
        await opened.close();
      }
    } catch {
      binding = {
        registeredSourcePath,
        archive: output["archive"] as string,
        generation: output["generation"] as number,
        targetPath: output["path"] as string,
        targetFingerprint: { bytes: 0, sha256: "0".repeat(64) },
        sourceFingerprint: input.parsed.sourceFingerprint,
        sourceIdentity
      };
      compatibility = "unknown_policy";
    }
  }

  const decision = decideArchiveWrite({
    source: { path: sourceRelative, fingerprint: input.parsed.sourceFingerprint, identity: sourceIdentity },
    ...(binding ? {
      binding: {
        fresh: target?.schemaSupported === true,
        sourcePath: binding.registeredSourcePath,
        sourceFingerprint: binding.sourceFingerprint,
        sourceIdentity: binding.sourceIdentity,
        archive: binding.archive,
        generation: binding.generation,
        targetPath: binding.targetPath,
        targetFingerprint: binding.targetFingerprint
      }
    } : {}),
    ...(target ? { target } : {}),
    candidate: binding ? { valid: true, archive: binding.archive, generation: binding.generation + 1 } : { valid: true },
    compatibility,
    preservePrevious: input.preservePrevious,
    copyUserStateOnPreserve: input.copyUserStateOnPreserve,
    expectedStillCurrent: true,
    registeredPathMigrationProven
  });
  return {
    sourcePath: sourceRelative,
    sourceFingerprint: input.parsed.sourceFingerprint,
    sourceIdentity,
    action: planAction(decision),
    reason: decision.reason,
    preservePrevious: input.preservePrevious,
    copyUserState: decision.copyUserState === true,
    expectedLibraryRevision: authority.library["revision"] as number,
    expectedLibraryFingerprint: authority.libraryFingerprint,
    ...(input.targetDirectory ? { targetDirectory: safeWindowsLeaf(input.targetDirectory, "target directory") } : {}),
    ...(binding ? { binding } : {})
  };
}

export type NewParseCommitResult =
  | Readonly<{
    status: "created";
    archive: string;
    generation: 1;
    path: string;
    fingerprint: ByteFingerprint;
    catalog: "written" | "conflict" | "invalid" | "deferred";
  }>
  | Readonly<{ status: "conflict"; reason: string }>
  | Readonly<{ status: "cancelled" }>;

export type ParsedSourcePlanAction = "new" | "safe_update" | "conservative_new" | "preserve" | "unchanged" | "excluded";

export type ParsedSourceWritePlan = Readonly<{
  sourcePath: string;
  sourceFingerprint: ByteFingerprint;
  sourceIdentity: SourceLineIdentity;
  action: ParsedSourcePlanAction;
  reason: string;
  preservePrevious: boolean;
  copyUserState: boolean;
  expectedLibraryRevision: number;
  expectedLibraryFingerprint: ByteFingerprint;
  targetDirectory?: string;
  binding?: Readonly<{
    registeredSourcePath: string;
    archive: string;
    generation: number;
    targetPath: string;
    targetFingerprint: ByteFingerprint;
    sourceFingerprint: ByteFingerprint;
    sourceIdentity: SourceLineIdentity;
    user?: JsonObject;
    lifecycle?: JsonObject;
  }>;
}>;

export type ParsedSourceCommitResult =
  | Readonly<{
    status: "created" | "updated" | "preserved";
    archive: string;
    generation: number;
    path: string;
    fingerprint: ByteFingerprint;
    catalog: "written" | "conflict" | "invalid" | "deferred";
  }>
  | Readonly<{ status: "unchanged"; archive: string; generation: number; path: string }>
  | Readonly<{ status: "conflict"; reason: string }>
  | Readonly<{ status: "cancelled" }>;

function planKey(value: ParsedSourceWritePlan): string {
  return canonicalizeJcs({
    source_path: value.sourcePath,
    source_fingerprint: value.sourceFingerprint,
    source_identity: value.sourceIdentity,
    action: value.action,
    reason: value.reason,
    preserve_previous: value.preservePrevious,
    copy_user_state: value.copyUserState,
    expected_library_revision: value.expectedLibraryRevision,
    expected_library_fingerprint: value.expectedLibraryFingerprint,
    ...(value.targetDirectory ? { target_directory: value.targetDirectory } : {}),
    ...(value.binding ? {
      binding: {
        registered_source_path: value.binding.registeredSourcePath,
        archive: value.binding.archive,
        generation: value.binding.generation,
        target_path: value.binding.targetPath,
        target_fingerprint: value.binding.targetFingerprint,
        source_fingerprint: value.binding.sourceFingerprint,
        source_identity: value.binding.sourceIdentity
      }
    } : {})
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function finalizeOwnedConversation(value: JsonObject, verifiedBodies?: ParsedSourceDraft["verifiedResources"]): JsonObject {
  value["content_sha256"] = computeConversationContentSha256(value);
  if (verifiedBodies) {
    const originalResources = (value["resources"] ?? []) as JsonObject[];
    const originals = new Map(originalResources.map(resource => [resource["id"] as string, resource]));
    const resources = originalResources.map(resource => {
      if (resource["availability"] !== "embedded" || !verifiedBodies[resource["id"] as string]) return resource;
      const metadata = { ...resource }; delete metadata["data_base64"]; return metadata;
    });
    const metadata = { ...value, ...(value["resources"] === undefined ? {} : { resources }) };
    const validation = validateConversationMetadata(metadata, new Map(Object.entries(verifiedBodies)));
    if (!validation.ok) throw new ContractValidationError("Conversation failed prepared metadata validation", validation.issues);
    for (const resource of (validation.value["resources"] ?? []) as JsonObject[]) {
      const chunks = originals.get(resource["id"] as string)?.["data_base64"];
      if (Array.isArray(chunks)) resource["data_base64"] = [...chunks];
    }
    return validation.value;
  }
  const validation = validateConversation(value);
  if (!validation.ok) throw new ContractValidationError("Conversation failed contract validation", validation.issues);
  return validation.value;
}

async function cleanRolledBackParserTransaction(
  libraryRoot: string,
  journal: JsonObject,
  transaction: string
): Promise<"rolled_back" | "conflict"> {
  const rolled = await rollbackJournal(libraryRoot, journal);
  if (rolled["state"] !== "rolled_back") return "conflict";
  const cleaned = await cleanupJournal(libraryRoot, rolled);
  if (cleaned["state"] !== "cleaned") return "conflict";
  await removeCleanJournalFiles(libraryRoot, transaction);
  return "rolled_back";
}

async function recoverFailedParserStaging(libraryRoot: string, transaction: string): Promise<void> {
  try {
    const rolled = await recoverJournal(libraryRoot, transaction);
    if (rolled["state"] === "rolled_back") {
      const cleaned = await cleanupJournal(libraryRoot, rolled);
      if (cleaned["state"] === "cleaned") await removeCleanJournalFiles(libraryRoot, transaction);
    }
  } catch {
    // The durable journal remains for the normal recovery path.
  }
}

export async function commitPlannedParsedSource(input: Readonly<{
  libraryRoot: string;
  plan: ParsedSourceWritePlan;
  parsed: ParsedSourceDraft;
  transaction: string;
  recoveryTransaction: string;
  recoveryAlreadyCapturedThisBatch: boolean;
  timestamp: string;
  initialSourceFingerprint?: ByteFingerprint;
  signal?: AbortSignal;
  onPhase?: (phase: "validate" | "plan" | "stage" | "commit" | "verify") => void;
  onResourceProgress?: (completed: number, total: number) => void;
  knownPresentSourcePaths?: ReadonlySet<string>;
  catalogBatch?: ParserCatalogBatch;
}>): Promise<ParsedSourceCommitResult> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Parser and recovery transactions require distinct tokens");
  const sourceRelative = inboxSourcePath(input.plan.sourcePath);
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    throwIfAborted(input.signal);
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    const sourceAbsolute = await resolveManagedPath(input.libraryRoot, sourceRelative, { mustExist: true });
    const sourceInfo = await lstat(sourceAbsolute, { bigint: true });
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) return { status: "conflict", reason: "source_is_not_a_confined_file" };
    const observedSource = input.initialSourceFingerprint ?? await fingerprintFile(sourceAbsolute);
    if (Number(sourceInfo.size) !== observedSource.bytes) return { status: "conflict", reason: "source_bytes_changed" };
    if (
      observedSource.bytes !== input.parsed.sourceFingerprint.bytes
      || observedSource.sha256 !== input.parsed.sourceFingerprint.sha256
    ) return { status: "conflict", reason: "source_bytes_changed" };
    const draftSource = isJsonObject(input.parsed.draft["source"]) ? input.parsed.draft["source"] : undefined;
    if (!draftSource || draftSource["file"] !== path.basename(sourceAbsolute)) {
      return { status: "conflict", reason: "parsed_source_identity_changed" };
    }

    if (
      authority.library["revision"] !== input.plan.expectedLibraryRevision
      || authority.libraryFingerprint.bytes !== input.plan.expectedLibraryFingerprint.bytes
      || authority.libraryFingerprint.sha256 !== input.plan.expectedLibraryFingerprint.sha256
      || input.parsed.sourceFingerprint.bytes !== input.plan.sourceFingerprint.bytes
      || input.parsed.sourceFingerprint.sha256 !== input.plan.sourceFingerprint.sha256
      || canonicalizeJcs(parsedSourceIdentity(input.parsed)) !== canonicalizeJcs(input.plan.sourceIdentity)
    ) return { status: "conflict", reason: "planned_evidence_changed" };
    const currentPlan = await prepareParsedSourceWritePlan({
      libraryRoot: input.libraryRoot,
      sourcePath: sourceRelative,
      parsed: input.parsed,
      preservePrevious: input.plan.preservePrevious,
      copyUserStateOnPreserve: input.plan.copyUserState,
      ...(input.knownPresentSourcePaths ? { knownPresentSourcePaths: input.knownPresentSourcePaths } : {}),
      ...(input.plan.targetDirectory ? { targetDirectory: input.plan.targetDirectory } : {})
    });
    if (planKey(currentPlan) !== planKey(input.plan)) return { status: "conflict", reason: "planned_action_changed" };
    if (input.plan.action === "excluded") return { status: "conflict", reason: input.plan.reason };
    if (input.plan.action === "unchanged") {
      if (!input.plan.binding) return { status: "conflict", reason: "unchanged_binding_missing" };
      if (input.plan.binding.registeredSourcePath !== sourceRelative) {
        const sourceBeforeMigration = await fingerprintFile(sourceAbsolute);
        if (
          sourceBeforeMigration.bytes !== observedSource.bytes
          || sourceBeforeMigration.sha256 !== observedSource.sha256
        ) return { status: "conflict", reason: "source_changed_before_commit" };
        const catalog = await readCatalogCache(input.libraryRoot);
        if (!catalog) return { status: "conflict", reason: "catalog_missing_or_stale" };
        const refresh = catalogRefreshInput(catalog);
        const priorSource = refresh.sourceRows[input.plan.binding.registeredSourcePath];
        if (!priorSource) return { status: "conflict", reason: "registered_source_migration_stale" };
        refresh.sourceRows[sourceRelative] = {
          ...structuredClone(priorSource),
          path: sourceRelative,
          bytes: observedSource.bytes,
          sha256: observedSource.sha256,
          mtime_ns: String((await lstat(sourceAbsolute, { bigint: true })).mtimeNs)
        };
        delete refresh.sourceRows[input.plan.binding.registeredSourcePath];
        const migrated = await rebuildCatalogCache(input.libraryRoot, {
          builtAt: input.timestamp,
          adapterBundleSha256: adapterBundleSha256(),
          sourceRows: refresh.sourceRows,
          archiveRows: refresh.archiveRows
        });
        if (migrated.status !== "written") return { status: "conflict", reason: "registered_source_migration_conflict" };
        const sourceAfterMigration = await fingerprintFile(sourceAbsolute);
        if (
          sourceAfterMigration.bytes !== observedSource.bytes
          || sourceAfterMigration.sha256 !== observedSource.sha256
        ) return { status: "conflict", reason: "source_changed_before_commit" };
      }
      return {
        status: "unchanged",
        archive: input.plan.binding.archive,
        generation: input.plan.binding.generation,
        path: input.plan.binding.targetPath
      };
    }

    const catalog = await readCatalogCache(input.libraryRoot);
    if (!catalog) return { status: "conflict", reason: "catalog_missing_or_stale" };
    const archiveRows = Array.isArray(catalog["archives"])
      ? catalog["archives"].filter((entry): entry is JsonObject => isJsonObject(entry))
      : [];
    const libraryArchives = isJsonObject(authority.library["archives"])
      ? Object.keys(authority.library["archives"])
      : [];
    const replacing = input.plan.action === "safe_update";
    const sourceUser = input.plan.binding
      ? (isJsonObject(authority.library["archives"]) && isJsonObject(authority.library["archives"][input.plan.binding.archive])
        ? authority.library["archives"][input.plan.binding.archive] as JsonObject
        : input.plan.binding.user)
      : undefined;
    const retainedUser = replacing || input.plan.copyUserState ? copyArchiveStateWithoutInventingEdit(sourceUser) : undefined;
    const initialName = !replacing && !retainedUser ? initialFileConversationName(input.parsed) : undefined;
    const archiveUser = retainedUser ?? (initialName ? { revision: 1, edited_at: input.timestamp, conversation_name: initialName } : undefined);
    let archive: string;
    let generation: number;
    let targetRelative: string;
    let nextArchive: number | undefined;
    if (replacing) {
      if (!input.plan.binding) return { status: "conflict", reason: "safe_update_binding_missing" };
      archive = input.plan.binding.archive;
      generation = input.plan.binding.generation + 1;
      targetRelative = input.plan.binding.targetPath;
    } else {
      const visible = [...archiveRows.map((entry) => String(entry["archive"])), ...libraryArchives];
      const recovered = recoverNextArchive(visible);
      const allocation = allocateArchive(Math.max(authority.library["next_archive"] as number, recovered), visible);
      archive = allocation.archive;
      generation = 1;
      nextArchive = allocation.nextArchive;
      const directory = input.plan.targetDirectory;
      if (directory === ".Cloudig-Archive") throw new TypeError("Parser output cannot target the archive directory");
      const parentRelative = directory ? `Conversations/${directory}` : "Conversations";
      const parent = await resolveManagedPath(input.libraryRoot, parentRelative, { mustExist: true });
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new TypeError("Parser output parent must be a confined directory");
      const filename = chooseNoReplaceLeaf(titleFilename(archiveUser?.["conversation_name"] ?? input.parsed.draft["title"], archive), new Set(await readdir(parent)));
      targetRelative = `${parentRelative}/${filename}`;
    }

    const priorLifecycle = input.plan.binding?.lifecycle;
    const candidate: JsonObject = {
      ...input.parsed.draft,
      schema: "cloudig/conversation/1.0.0",
      archive,
      generation,
      content_sha256: "0".repeat(64),
      // Content Time is a user assertion, never a Parser inference from dates.
      content_time: { basis: "unavailable" },
      parser: { version: PARSER_VERSION, adapter: { id: input.parsed.adapter.id, version: input.parsed.adapter.version } },
      lifecycle: {
        first_parsed_at: replacing && isJsonObject(priorLifecycle?.["first_parsed_at"])
          ? structuredClone(priorLifecycle!["first_parsed_at"] as JsonObject)
          : { basis: "parser", value: input.timestamp },
        last_parsed_at: input.timestamp,
        cloudig_edited_at: input.timestamp
      }
    };
    if (archiveUser) candidate["user"] = archiveUser;
    else delete candidate["user"];
    const conversation = finalizeOwnedConversation(candidate, input.parsed.verifiedResources);
    input.onPhase?.("validate");
    const expectedResources = new Map<string, { fingerprint: ByteFingerprint }>();
    for (const resource of (conversation["resources"] ?? []) as JsonObject[]) {
      if (resource["availability"] === "embedded" && typeof resource["bytes"] === "number" && resource["bytes"] > 0) {
        expectedResources.set(resource["id"] as string, { fingerprint: { bytes: resource["bytes"], sha256: resource["sha256"] as string } });
      }
    }
    const detached = detachConversationResourceBodies(conversation, input.transaction, 8 * 1024 * 1024);
    const resourceBytes = [...expectedResources.values()].reduce((total, row) => total + row.fingerprint.bytes, 0);
    const inlineBytes = resourceBytes - detached.bodies.reduce((total, body) => total + body.expected.bytes, 0);
    const nextLibrary = structuredClone(authority.library);
    const libraryChanged = !replacing;
    if (libraryChanged) {
      nextLibrary["next_archive"] = nextArchive!;
      nextLibrary["revision"] = (nextLibrary["revision"] as number) + 1;
      nextLibrary["edited_at"] = input.timestamp;
      if (archiveUser) {
        const archives = isJsonObject(nextLibrary["archives"]) ? nextLibrary["archives"] as JsonObject : {};
        archives[archive] = structuredClone(archiveUser);
        nextLibrary["archives"] = archives;
      }
    }
    const libraryBytes = libraryChanged ? Buffer.from(serializeLibrary(nextLibrary), "utf8") : undefined;
    input.onPhase?.("plan");

    const targets: JsonObject[] = [{
      action: replacing ? "replace" : "create",
      path: targetRelative,
      status: "planned",
      expected_before: replacing ? { state: "present", ...input.plan.binding!.targetFingerprint } : { state: "missing" },
      source: { path: sourceRelative, ...observedSource },
      semantic: { kind: "conversation", archive, generation, schema: "cloudig/conversation/1.0.0" }
    }];
    if (libraryChanged) targets.push({
      action: "replace",
      path: "cloudig-library.json",
      status: "planned",
      expected_before: { state: "present", ...authority.libraryFingerprint },
      semantic: { kind: "library" }
    });
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: replacing ? "parse-safe-update" : input.plan.action === "preserve" ? "parse-preserve-previous" : "parse-new-source",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: authority.library["revision"]!, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets,
      ...(detached.journalRows.length > 0 ? { spools: detached.journalRows } : {})
    };
    let staged: JsonObject;
    let resourceSpools: ReadonlyMap<string, ResourceSpool> = new Map();
    try {
      let prepared = await prepareJournalTargets(input.libraryRoot, journal);
      if (inlineBytes > 0) input.onResourceProgress?.(inlineBytes, resourceBytes);
      if (detached.bodies.length > 0) {
        const spooled = await spoolDetachedResourceBodies({
          libraryRoot: input.libraryRoot,
          bodies: detached.bodies,
          journal: prepared,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onResourceProgress ? { onProgress: (completed: number) => input.onResourceProgress?.(inlineBytes + completed, resourceBytes) } : {})
        });
        prepared = spooled.journal;
        resourceSpools = spooled.spools;
        await persistJournal(input.libraryRoot, prepared);
      }
      const streams = new Map<number, Readable>([[0, streamCanonicalConversation(conversation, resourceSpools, input.signal)]]);
      if (libraryBytes) streams.set(1, Readable.from([libraryBytes]));
      staged = await stagePreparedJournalTargets(input.libraryRoot, prepared, streams, input.signal, async (index, stagedPath) => {
        if (index === 0) await verifyStagedConversationResources(stagedPath, expectedResources, input.signal);
      });
      if (resourceSpools.size > 0) {
        staged = await deleteVerifiedResourceSpools(input.libraryRoot, staged, resourceSpools);
        await persistJournal(input.libraryRoot, staged);
      }
    } catch (error) {
      await recoverFailedParserStaging(input.libraryRoot, input.transaction);
      if (isAbort(error)) return { status: "cancelled" };
      throw error;
    }
    input.onPhase?.("stage");
    const sourceBeforeCommit = await fingerprintFile(sourceAbsolute);
    if (
      sourceBeforeCommit.bytes !== observedSource.bytes
      || sourceBeforeCommit.sha256 !== observedSource.sha256
    ) {
      await cleanRolledBackParserTransaction(input.libraryRoot, staged, input.transaction);
      return { status: "conflict", reason: "source_changed_before_commit" };
    }
    if (input.signal?.aborted) {
      await cleanRolledBackParserTransaction(input.libraryRoot, staged, input.transaction);
      return { status: "cancelled" };
    }
    const recovery = await capturePreviousAuthority(input.libraryRoot, {
      transaction: input.recoveryTransaction,
      recordedAt: input.timestamp,
      alreadyCapturedThisBatch: input.recoveryAlreadyCapturedThisBatch
    });
    if (recovery === "conflict") {
      await cleanRolledBackParserTransaction(input.libraryRoot, staged, input.transaction);
      return { status: "conflict", reason: "recovery_point_conflict" };
    }
    if (recovery === "skipped_batch") await readPreviousAuthorityPair(input.libraryRoot);
    if (input.signal?.aborted) {
      await cleanRolledBackParserTransaction(input.libraryRoot, staged, input.transaction);
      return { status: "cancelled" };
    }
    input.onPhase?.("commit");
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") {
      await cleanRolledBackParserTransaction(input.libraryRoot, committed, input.transaction);
      return { status: "conflict", reason: "transaction_precondition_changed" };
    }
    const installedPair = await readCurrentAuthorityPair(input.libraryRoot);
    input.onPhase?.("verify");
    if (libraryChanged) {
      if (installedPair.library["revision"] !== nextLibrary["revision"] || installedPair.library["next_archive"] !== nextArchive) {
        throw new TypeError("Parser commit did not install the expected Library watermark");
      }
    } else if (
      installedPair.libraryFingerprint.bytes !== authority.libraryFingerprint.bytes
      || installedPair.libraryFingerprint.sha256 !== authority.libraryFingerprint.sha256
    ) throw new TypeError("Parser safe update changed Library authority unexpectedly");
    const targetAbsolute = await resolveManagedPath(input.libraryRoot, targetRelative, { mustExist: true });
    const installedFingerprint = await fingerprintFile(targetAbsolute);
    // The transaction is committed. Finish verification and cache publication
    // even if the user cancels the remaining batch now.
    // Resources were decoded and verified after staging. Prove that the
    // installed file is those exact verified bytes instead of decoding it again.
    const stagedAfter = (committed["targets"] as JsonObject[])[0]?.["staged_after"];
    if (!isJsonObject(stagedAfter) || stagedAfter["bytes"] !== installedFingerprint.bytes || stagedAfter["sha256"] !== installedFingerprint.sha256) {
      throw new TypeError("Installed Conversation changed after its verified staging");
    }
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Parser commit cleanup failed");

    const route = sourceRoute(input.parsed);
    const priorSourceRow = (catalog["sources"] as JsonObject[]).find(row => row["path"] === sourceRelative);
    const priorOutputs = Array.isArray(priorSourceRow?.["outputs"])
      ? priorSourceRow["outputs"] as JsonObject[]
      : [];
    const nextOutput = projectCatalogSourceOutput(conversation, targetRelative);
    let replacedOutput = false;
    const nextOutputs = replacing && input.plan.binding
      ? priorOutputs.map((entry) => {
        if (
          entry["archive"] === input.plan.binding!.archive
          && entry["generation"] === input.plan.binding!.generation
          && entry["path"] === input.plan.binding!.targetPath
        ) {
          replacedOutput = true;
          return nextOutput;
        }
        return structuredClone(entry);
      })
      : [...priorOutputs.map((entry) => structuredClone(entry)), nextOutput];
    if (replacing && !replacedOutput) throw new TypeError("Parser safe update lost its Catalog binding");
    const nextSourceRow: JsonObject = {
      status: "complete",
      bytes: observedSource.bytes,
      mtime_ns: String(sourceInfo.mtimeNs),
      sha256: observedSource.sha256,
      route: {
        ...route,
        adapter: { id: input.parsed.adapter.id, version: input.parsed.adapter.version }
      },
      outputs: nextOutputs
    };
    const nextArchiveRow: JsonObject = {
      ...projectCatalogArchiveSummary(conversation),
      sha256: installedFingerprint.sha256
    };
    const catalogDelta = {
      builtAt: input.timestamp,
      sourcePath: sourceRelative,
      sourceRow: nextSourceRow,
      archivePath: targetRelative,
      archiveRow: nextArchiveRow,
      ...(input.plan.binding && input.plan.binding.registeredSourcePath !== sourceRelative ? { retiredSourcePath: input.plan.binding.registeredSourcePath } : {})
    };
    const catalogResult = input.catalogBatch
      ? await input.catalogBatch.publish(catalogDelta)
      : await publishParsedCatalogDelta(input.libraryRoot, catalogDelta);
    return {
      status: replacing ? "updated" : input.plan.action === "preserve" ? "preserved" : "created",
      archive,
      generation,
      path: targetRelative,
      fingerprint: installedFingerprint,
      catalog: catalogResult.status
    };
  } finally {
    await writer.release();
  }
}

export async function commitNewParsedSource(input: Readonly<{
  libraryRoot: string;
  sourcePath: string;
  parsed: ParsedSourceDraft;
  targetDirectory?: string;
  transaction: string;
  recoveryTransaction: string;
  recoveryAlreadyCapturedThisBatch: boolean;
  timestamp: string;
  initialSourceFingerprint?: ByteFingerprint;
  signal?: AbortSignal;
  onPhase?: (phase: "validate" | "plan" | "stage" | "commit" | "verify") => void;
  onResourceProgress?: (completed: number, total: number) => void;
}>): Promise<NewParseCommitResult> {
  const plan = await prepareParsedSourceWritePlan({
    libraryRoot: input.libraryRoot,
    sourcePath: input.sourcePath,
    parsed: input.parsed,
    preservePrevious: false,
    copyUserStateOnPreserve: false,
    ...(input.targetDirectory ? { targetDirectory: input.targetDirectory } : {})
  });
  if (plan.action !== "new" && plan.action !== "conservative_new") {
    const selector = isJsonObject(input.parsed.draft["source"])
      && isJsonObject((input.parsed.draft["source"] as JsonObject)["locator"])
      && ((input.parsed.draft["source"] as JsonObject)["locator"] as JsonObject)["kind"] === "account_export_record";
    return { status: "conflict", reason: selector ? "source_record_already_has_output" : "source_already_has_output" };
  }
  const result = await commitPlannedParsedSource({
    ...input,
    plan
  });
  if (result.status === "created" && result.generation === 1) return result as NewParseCommitResult;
  if (result.status === "conflict" || result.status === "cancelled") return result;
  return { status: "conflict", reason: "new_source_commit_changed_action" };
}
