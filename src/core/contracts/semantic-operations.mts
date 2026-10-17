import { canonicalizeJcs } from "./deterministic-json.mts";
import { validateRange, validateUtcTimestamp } from "./semantic-common.mts";
import {
  validateCatalogCacheSchema,
  validateOperationSchema,
  validateSystemLogSchema,
  validateTransactionSchema
} from "./schema-registry.mts";
import type { JsonObject, JsonValue, ValidationIssue, ValidationResult } from "./types.mts";
import { isJsonObject } from "./types.mts";

function issue(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function validateManagedPath(
  value: JsonValue | undefined,
  path: string,
  issues: ValidationIssue[],
  root?: "Inbox" | "Conversations"
): void {
  if (typeof value !== "string") return;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    issue(issues, "CLOUDIG_PATH_NONCANONICAL", path, "Managed relative paths cannot contain empty, dot, or parent segments");
  }
  if (root && segments[0] !== root) {
    issue(issues, "CLOUDIG_PATH_SCOPE_INVALID", path, `Path must remain under ${root}`);
  }
  if (root === "Inbox" && segments.length !== 2) {
    issue(issues, "CLOUDIG_PATH_SCOPE_INVALID", path, "Inbox sources are direct files, not nested paths");
  }
}

function validateKnownProgress(
  value: JsonValue | undefined,
  path: string,
  final: boolean,
  issues: ValidationIssue[]
): void {
  if (!isJsonObject(value)) return;
  const completed = value["completed"];
  const total = value["total"];
  if (typeof completed === "number" && typeof total === "number") {
    if (completed > total) issue(issues, "CLOUDIG_OPERATION_PROGRESS_OVERFLOW", `${path}/completed`, "completed exceeds total");
    if (final && completed !== total) issue(issues, "CLOUDIG_OPERATION_FINAL_PROGRESS_INCOMPLETE", path, "Completed events must close known totals");
  }
}

export function validateOperation(value: unknown): ValidationResult<JsonObject> {
  const schema = validateOperationSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const event = schema.value;
  const issues: ValidationIssue[] = [];
  const final = event["state"] === "completed";
  validateKnownProgress(event["bytes"], "/bytes", final, issues);
  const items = event["items"];
  if (isJsonObject(items) && items["total"] !== undefined) validateKnownProgress(items, "/items", final, issues);
  const file = event["file"];
  if (isJsonObject(file)) {
    validateKnownProgress(file, "/file", final, issues);
    if (typeof file["index"] === "number" && typeof file["total"] === "number" && file["index"] > file["total"]) {
      issue(issues, "CLOUDIG_OPERATION_FILE_INDEX_INVALID", "/file/index", "Current file index exceeds the batch total");
    }
  }
  const error = event["error"];
  if (isJsonObject(error) && isJsonObject(error["capacity"])) {
    const observed = error["capacity"]["observed"];
    const limit = error["capacity"]["limit"];
    if (typeof observed === "number" && typeof limit === "number" && observed <= limit) {
      issue(issues, "CLOUDIG_OPERATION_CAPACITY_NOT_EXCEEDED", "/error/capacity/observed", "Capacity errors require observed to exceed limit");
    }
  }
  return issues.length === 0 ? schema : { ok: false, issues };
}

function isOwnedTransactionPath(value: JsonValue | undefined, transaction: string): boolean {
  return typeof value === "string" && value.startsWith(`Data/Transactions/${transaction}/`);
}

function validateTransactionTarget(
  raw: JsonObject,
  index: number,
  transaction: string,
  issues: ValidationIssue[]
): void {
  const path = `/targets/${index}`;
  validateManagedPath(raw["path"], `${path}/path`, issues);
  if (typeof raw["path"] === "string" && raw["path"].startsWith("Data/Transactions/")) {
    issue(issues, "CLOUDIG_TRANSACTION_TARGET_IN_STAGING", `${path}/path`, "Formal targets cannot point into transaction staging");
  }
  if (isJsonObject(raw["source"])) validateManagedPath(raw["source"]["path"], `${path}/source/path`, issues);
  for (const field of ["temp", "displaced"] as const) {
    const value = raw[field];
    if (value !== undefined && !isOwnedTransactionPath(value, transaction)) {
      issue(issues, "CLOUDIG_TRANSACTION_OWNERSHIP_INVALID", `${path}/${field}`, `${field} must remain under this transaction directory`);
    }
  }

  const action = raw["action"];
  const status = raw["status"];
  const producesBytes = action !== "remove_generated";
  if ((status === "staged" || status === "displaced" || status === "installed") && producesBytes) {
    if (!isJsonObject(raw["staged_after"]) || typeof raw["temp"] !== "string") {
      issue(issues, "CLOUDIG_TRANSACTION_STAGE_INCOMPLETE", path, "Staged output targets require staged_after and transaction-owned temp");
    }
  }
  if (status === "installed" && producesBytes) {
    if (!isJsonObject(raw["installed"])) {
      issue(issues, "CLOUDIG_TRANSACTION_INSTALL_FINGERPRINT_MISSING", `${path}/installed`, "Installed output requires its observed fingerprint");
    } else if (canonicalizeJcs(raw["installed"]) !== canonicalizeJcs(raw["staged_after"])) {
      issue(issues, "CLOUDIG_TRANSACTION_INSTALL_MISMATCH", `${path}/installed`, "Installed fingerprint must equal staged_after");
    }
    if (action === "replace" && typeof raw["displaced"] !== "string") {
      issue(issues, "CLOUDIG_TRANSACTION_DISPLACED_MISSING", `${path}/displaced`, "Installed replacement must retain its transaction-owned displaced path until cleanup");
    }
  }
  if (status === "displaced" && action !== "replace" && action !== "remove_generated") {
    issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", `${path}/status`, "Only replacement or removal targets can be displaced");
  }
  if (status === "displaced" && typeof raw["displaced"] !== "string") {
    issue(issues, "CLOUDIG_TRANSACTION_DISPLACED_MISSING", `${path}/displaced`, "Displaced target requires its owned rollback path");
  }
  if (action === "remove_generated" && (raw["staged_after"] !== undefined || raw["installed"] !== undefined || raw["temp"] !== undefined)) {
    issue(issues, "CLOUDIG_TRANSACTION_REMOVE_HAS_BYTES", path, "remove_generated cannot claim staged or installed output bytes");
  }
  if (action !== "replace" && action !== "remove_generated" && raw["displaced"] !== undefined) {
    issue(issues, "CLOUDIG_TRANSACTION_DISPLACED_UNEXPECTED", `${path}/displaced`, "Only replacement or removal targets can own displaced bytes");
  }
}

function validateTransactionState(journal: JsonObject, issues: ValidationIssue[]): void {
  const state = journal["state"];
  const targets = journal["targets"];
  if (!Array.isArray(targets)) return;
  const statuses = targets.filter(isJsonObject).map((target) => target["status"]);
  const spools = Array.isArray(journal["spools"])
    ? journal["spools"].filter(isJsonObject).map((spool) => spool["status"])
    : [];
  const all = (...allowed: unknown[]): boolean => statuses.every((status) => allowed.includes(status));
  switch (state) {
    case "planned":
      if (!all("planned")) issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "planned journal requires planned targets");
      break;
    case "staged":
      if (!all("staged")) issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "staged journal requires every target staged");
      break;
    case "installing":
      if (!all("staged", "displaced", "installed", "conflict")) issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "installing journal has an impossible target state");
      break;
    case "committed":
      if (!all("installed")) issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "committed journal requires every target installed");
      break;
    case "rolling_back":
      if (!all("staged", "displaced", "installed", "rolled_back", "conflict")) issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "rolling_back journal has an impossible target state");
      break;
    case "rolled_back":
      if (!all("rolled_back")) issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "rolled_back journal requires every target rolled back");
      break;
    case "conflict":
      if (!statuses.includes("conflict") && !spools.includes("conflict")) {
        issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "conflict journal requires at least one conflicting target or resource spool");
      }
      break;
    case "cleaned":
      if (!all("installed", "rolled_back")) issue(issues, "CLOUDIG_TRANSACTION_STATE_MISMATCH", "/targets", "cleaned journal must describe a complete commit or rollback");
      break;
    default:
      break;
  }
  if (["installing", "committed", "cleaned", "rolled_back"].includes(String(state)) && spools.some((status) => status !== "cleaned")) {
    issue(issues, "CLOUDIG_TRANSACTION_SPOOL_NOT_CLEANED", "/spools", "Published or rolled-back transactions cannot retain decoded resource spools");
  }
}

function validateTransactionSpool(
  raw: JsonObject,
  index: number,
  transaction: string,
  issues: ValidationIssue[]
): void {
  const path = `/spools/${index}`;
  if (!isOwnedTransactionPath(raw["path"], transaction)) {
    issue(issues, "CLOUDIG_TRANSACTION_OWNERSHIP_INVALID", `${path}/path`, "Resource spool must remain under this transaction directory");
  }
  const expected = raw["expected"];
  const observed = raw["observed"];
  if (["written", "verified"].includes(String(raw["status"]))) {
    if (!isJsonObject(expected) || !isJsonObject(observed) || canonicalizeJcs(expected) !== canonicalizeJcs(observed)) {
      issue(issues, "CLOUDIG_TRANSACTION_SPOOL_FINGERPRINT_MISMATCH", path, "Completed resource spool must match its expected fingerprint");
    }
  } else if (raw["status"] === "cleaned" && observed !== undefined) {
    if (!isJsonObject(expected) || !isJsonObject(observed) || canonicalizeJcs(expected) !== canonicalizeJcs(observed)) {
      issue(issues, "CLOUDIG_TRANSACTION_SPOOL_FINGERPRINT_MISMATCH", path, "Cleaned resource spool observation must match its expected fingerprint");
    }
  } else if (observed !== undefined && raw["status"] === "planned") {
    issue(issues, "CLOUDIG_TRANSACTION_SPOOL_OBSERVED_EARLY", `${path}/observed`, "Planned resource spool cannot claim observed bytes");
  }
}

export function validateTransaction(value: unknown): ValidationResult<JsonObject> {
  const schema = validateTransactionSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const journal = schema.value;
  const issues: ValidationIssue[] = [];
  validateUtcTimestamp(journal["created_at"], "/created_at", issues);
  validateUtcTimestamp(journal["updated_at"], "/updated_at", issues);
  if (typeof journal["created_at"] === "string" && typeof journal["updated_at"] === "string" && journal["created_at"] > journal["updated_at"]) {
    issue(issues, "CLOUDIG_TRANSACTION_TIME_ORDER_INVALID", "/updated_at", "updated_at precedes created_at");
  }
  const transaction = typeof journal["transaction"] === "string" ? journal["transaction"] : "";
  const seenPaths = new Set<string>();
  const targets = journal["targets"];
  if (Array.isArray(targets)) {
    targets.forEach((raw, index) => {
      if (!isJsonObject(raw)) return;
      validateTransactionTarget(raw, index, transaction, issues);
      const targetPath = raw["path"];
      if (typeof targetPath === "string") {
        if (seenPaths.has(targetPath)) issue(issues, "CLOUDIG_TRANSACTION_TARGET_DUPLICATE", `/targets/${index}/path`, "A transaction cannot target the same path twice");
        seenPaths.add(targetPath);
      }
    });
  }
  const spools = journal["spools"];
  if (Array.isArray(spools)) {
    const seenResources = new Set<string>();
    const seenSpoolPaths = new Set<string>();
    spools.forEach((raw, index) => {
      if (!isJsonObject(raw)) return;
      validateTransactionSpool(raw, index, transaction, issues);
      const resource = raw["resource"];
      const spoolPath = raw["path"];
      if (typeof resource === "string") {
        if (seenResources.has(resource)) issue(issues, "CLOUDIG_TRANSACTION_SPOOL_DUPLICATE", `/spools/${index}/resource`, "A transaction cannot spool one resource twice");
        seenResources.add(resource);
      }
      if (typeof spoolPath === "string") {
        if (seenSpoolPaths.has(spoolPath)) issue(issues, "CLOUDIG_TRANSACTION_SPOOL_DUPLICATE", `/spools/${index}/path`, "A transaction cannot reuse one resource spool path");
        seenSpoolPaths.add(spoolPath);
      }
    });
  }
  validateTransactionState(journal, issues);
  return issues.length === 0 ? schema : { ok: false, issues };
}

function validateCatalogTimes(value: JsonValue | undefined, path: string, issues: ValidationIssue[]): void {
  if (!isJsonObject(value)) return;
  for (const field of ["json_edited_at", "json_created_at", "source_captured_at", "message_start", "message_end"] as const) {
    if (value[field] !== undefined) validateUtcTimestamp(value[field], `${path}/${field}`, issues);
  }
  if (typeof value["json_created_at"] === "string" && typeof value["json_edited_at"] === "string" && value["json_created_at"] > value["json_edited_at"]) {
    issue(issues, "CLOUDIG_CATALOG_TIME_ORDER_INVALID", `${path}/json_edited_at`, "JSON edit time precedes creation time");
  }
  if (typeof value["message_start"] === "string" && typeof value["message_end"] === "string" && value["message_start"] > value["message_end"]) {
    issue(issues, "CLOUDIG_CATALOG_TIME_ORDER_INVALID", `${path}/message_end`, "Message end precedes message start");
  }
  if (value["content"] !== undefined) validateRange(value["content"]!, `${path}/content`, issues);
}

export function validateCatalogCache(value: unknown): ValidationResult<JsonObject> {
  const schema = validateCatalogCacheSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const catalog = schema.value;
  const issues: ValidationIssue[] = [];
  validateUtcTimestamp(catalog["built_at"], "/built_at", issues);
  const sources = catalog["sources"];
  const archives = catalog["archives"];
  const archiveByPath = new Map<string, JsonObject>();
  if (Array.isArray(archives)) {
    archives.forEach((raw, index) => {
      if (!isJsonObject(raw)) return;
      const path = `/archives/${index}`;
      validateManagedPath(raw["path"], `${path}/path`, issues, "Conversations");
      if (typeof raw["path"] === "string") {
        if (!raw["path"].toLowerCase().endsWith(".json")) issue(issues, "CLOUDIG_CATALOG_ARCHIVE_EXTENSION_INVALID", `${path}/path`, "Catalog archive paths must name JSON files");
        if (archiveByPath.has(raw["path"])) issue(issues, "CLOUDIG_CATALOG_PATH_DUPLICATE", `${path}/path`, "Archive path is duplicated");
        archiveByPath.set(raw["path"], raw);
      }
      validateCatalogTimes(raw["times"], `${path}/times`, issues);
    });
  }
  const sourcePaths = new Set<string>();
  const outputPaths = new Set<string>();
  if (Array.isArray(sources)) {
    sources.forEach((raw, index) => {
      if (!isJsonObject(raw)) return;
      const path = `/sources/${index}`;
      validateManagedPath(raw["path"], `${path}/path`, issues, "Inbox");
      if (typeof raw["path"] === "string") {
        if (sourcePaths.has(raw["path"])) issue(issues, "CLOUDIG_CATALOG_PATH_DUPLICATE", `${path}/path`, "Source path is duplicated");
        sourcePaths.add(raw["path"]);
      }
      if (raw["status"] === "failed" && !isJsonObject(raw["error"])) {
        issue(issues, "CLOUDIG_CATALOG_ERROR_REQUIRED", `${path}/error`, "Failed source rows require a bounded error");
      }
      if (raw["error"] !== undefined && raw["status"] !== "failed" && raw["status"] !== "unsupported") {
        issue(issues, "CLOUDIG_CATALOG_ERROR_STALE", `${path}/error`, "Only failed or unsupported source rows may retain an error");
      }
      if (raw["status"] === "complete" && !Array.isArray(raw["outputs"])) {
        issue(issues, "CLOUDIG_CATALOG_OUTPUT_REQUIRED", `${path}/outputs`, "Complete source rows require at least one current output");
      }
      const outputs = raw["outputs"];
      if (!Array.isArray(outputs)) return;
      outputs.forEach((output, outputIndex) => {
        if (!isJsonObject(output)) return;
        const outputPath = `${path}/outputs/${outputIndex}`;
        validateManagedPath(output["path"], `${outputPath}/path`, issues, "Conversations");
        if (typeof output["path"] !== "string") return;
        if (outputPaths.has(output["path"])) issue(issues, "CLOUDIG_CATALOG_OUTPUT_DUPLICATE", `${outputPath}/path`, "An archive output is bound to more than one source row");
        outputPaths.add(output["path"]);
        const archive = archiveByPath.get(output["path"]);
        if (
          !archive
          || archive["archive"] !== output["archive"]
          || archive["generation"] !== output["generation"]
          || archive["selector"] !== output["selector"]
        ) {
          issue(issues, "CLOUDIG_CATALOG_OUTPUT_MISMATCH", outputPath, "Source output must match an observed archive path, aN, generation, and optional container selector");
        }
      });
    });
  }
  return issues.length === 0 ? schema : { ok: false, issues };
}

export function validateSystemLog(value: unknown): ValidationResult<JsonObject> {
  const schema = validateSystemLogSchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const log = schema.value;
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const files = log["files"];
  if (Array.isArray(files)) {
    files.forEach((raw, index) => {
      if (!isJsonObject(raw)) return;
      const path = `/files/${index}`;
      validateManagedPath(raw["path"], `${path}/path`, issues);
      if (typeof raw["path"] === "string") {
        const root = raw["path"].split("/")[0];
        if (root !== "Inbox" && root !== "Conversations") {
          issue(issues, "CLOUDIG_SYSTEM_LOG_PATH_SCOPE_INVALID", `${path}/path`, "System Log paths must identify an Inbox or Conversations file");
        }
        if (seen.has(raw["path"])) issue(issues, "CLOUDIG_SYSTEM_LOG_FILE_DUPLICATE", `${path}/path`, "System Log contains duplicate file groups");
        seen.add(raw["path"]);
      }
      validateUtcTimestamp(raw["recorded_at"], `${path}/recorded_at`, issues);
    });
  }
  return issues.length === 0 ? schema : { ok: false, issues };
}
