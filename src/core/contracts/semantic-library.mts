import { validateRange, validateUtcTimestamp } from "./semantic-common.mts";
import { validateLibrarySchema } from "./schema-registry.mts";
import type { JsonObject, JsonValue, ValidationIssue, ValidationResult } from "./types.mts";
import { isJsonObject } from "./types.mts";

function issue(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function validateSafePositiveInteger(
  value: JsonValue | undefined,
  path: string,
  issues: ValidationIssue[]
): void {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) {
    issue(issues, "CLOUDIG_INTEGER_OUT_OF_RANGE", path, "Expected a positive safe integer");
  }
}

function validateManagedAvatar(
  value: JsonValue | undefined,
  path: string,
  issues: ValidationIssue[]
): void {
  if (typeof value === "string" && !value.startsWith("Data/Assets/User/")) {
    issue(issues, "CLOUDIG_USER_ASSET_SCOPE_INVALID", path, "Managed user avatars must stay under Data/Assets/User");
  }
}

function validateIdentity(value: JsonValue | undefined, issues: ValidationIssue[]): void {
  if (!isJsonObject(value)) return;
  const global = value["global"];
  if (isJsonObject(global)) {
    for (const party of ["user", "assistant"] as const) {
      const identity = global[party];
      if (isJsonObject(identity)) validateManagedAvatar(identity["avatar"], `/identity/global/${party}/avatar`, issues);
    }
  }
  const platforms = value["platforms"];
  if (isJsonObject(platforms)) {
    for (const [platform, raw] of Object.entries(platforms)) {
      if (!isJsonObject(raw)) continue;
      const assistant = raw["assistant"];
      if (isJsonObject(assistant)) {
        validateManagedAvatar(assistant["avatar"], `/identity/platforms/${platform}/assistant/avatar`, issues);
      }
    }
  }
}

function validateArchiveContentTime(
  value: JsonValue | undefined,
  path: string,
  issues: ValidationIssue[]
): void {
  if (!isJsonObject(value)) return;
  if (value["range"] !== undefined) validateRange(value["range"]!, `${path}/range`, issues);
}

export function validateLibrary(value: unknown): ValidationResult<JsonObject> {
  const schema = validateLibrarySchema<JsonObject>(value);
  if (!schema.ok) return schema;
  const library = schema.value;
  const issues: ValidationIssue[] = [];

  validateSafePositiveInteger(library["next_archive"], "/next_archive", issues);
  validateSafePositiveInteger(library["revision"], "/revision", issues);
  validateUtcTimestamp(library["edited_at"], "/edited_at", issues);
  validateIdentity(library["identity"], issues);

  const libraryRevision = typeof library["revision"] === "number" ? library["revision"] : 0;
  const libraryEditedAt = typeof library["edited_at"] === "string" ? library["edited_at"] : "";
  const contentTime = library["content_time"];
  if (isJsonObject(contentTime)) {
    validateSafePositiveInteger(contentTime["revision"], "/content_time/revision", issues);
    if (typeof contentTime["revision"] === "number" && contentTime["revision"] > libraryRevision) {
      issue(issues, "CLOUDIG_TIME_REVISION_AHEAD_OF_LIBRARY", "/content_time/revision", "Time revision cannot exceed the Library revision that commits its descriptor");
    }
  }

  let maximumArchive = 0n;
  const archives = library["archives"];
  if (isJsonObject(archives)) {
    for (const [archive, raw] of Object.entries(archives)) {
      const numeric = BigInt(archive.slice(1));
      if (numeric > maximumArchive) maximumArchive = numeric;
      if (!isJsonObject(raw)) continue;
      const path = `/archives/${archive}`;
      validateSafePositiveInteger(raw["revision"], `${path}/revision`, issues);
      validateUtcTimestamp(raw["edited_at"], `${path}/edited_at`, issues);
      if (typeof raw["revision"] === "number" && raw["revision"] > libraryRevision) {
        issue(issues, "CLOUDIG_ARCHIVE_REVISION_AHEAD_OF_LIBRARY", `${path}/revision`, "Archive user-state revision cannot exceed Library revision");
      }
      if (typeof raw["edited_at"] === "string" && libraryEditedAt && raw["edited_at"] > libraryEditedAt) {
        issue(issues, "CLOUDIG_ARCHIVE_EDIT_AHEAD_OF_LIBRARY", `${path}/edited_at`, "Archive user-state timestamp cannot be later than Library edited_at");
      }
      validateArchiveContentTime(raw["content_time"], `${path}/content_time`, issues);
    }
  }
  const nextArchive = library["next_archive"];
  if (typeof nextArchive === "number" && Number.isSafeInteger(nextArchive) && BigInt(nextArchive) <= maximumArchive) {
    issue(issues, "CLOUDIG_NEXT_ARCHIVE_NOT_MONOTONIC", "/next_archive", "next_archive must be greater than every visible archive ID");
  }

  return issues.length === 0 ? { ok: true, value: library } : { ok: false, issues };
}
