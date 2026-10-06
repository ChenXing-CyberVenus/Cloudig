import {
  computeConversationContentSha256,
  serializeDeterministic
} from "./deterministic-json.mts";
import { validateConversation } from "./semantic-conversation.mts";
import { validateLibrary } from "./semantic-library.mts";
import {
  validateCatalogCache,
  validateOperation,
  validateSystemLog,
  validateTransaction
} from "./semantic-operations.mts";
import {
  validateSovereignSnapshot,
  validateTerranPreset,
  validateTimeLimits,
  validateTimeSystem,
  validateTimeValue
} from "./semantic-time.mts";
import terranPreset from "./machine/terran-preset.json" with { type: "json" };
import timeLimits from "./machine/time-limits.json" with { type: "json" };
import resourceLimits from "./machine/resource-limits.json" with { type: "json" };
import type { JsonObject, ValidationIssue, ValidationResult } from "./types.mts";
import { isJsonObject } from "./types.mts";
import { validateResourceLimitsSchema } from "./schema-registry.mts";
import { validateContainerIndexSchema, validateContainerRecordSchema } from "./schema-registry.mts";
import { orderJson } from "./deterministic-json.mts";

export {
  machineSchemas,
  validateCachePolicySchema,
  validateCatalogCacheSchema,
  validateContainerIndexSchema,
  validateContainerRecordSchema,
  validateConversationSchema,
  validateLibrarySchema,
  validateOperationSchema,
  validateResourceLimitsSchema,
  validateSovereignSnapshotSchema,
  validateTerranPresetSchema,
  validateTimeLimitsSchema,
  validateTimeSchema,
  validateTimeSystemSchema,
  validateTransactionSchema,
  validateSystemLogSchema
} from "./schema-registry.mts";
export { computeConversationContentSha256, serializeDeterministic } from "./deterministic-json.mts";
export {
  validateConversation,
  validateConversationMetadata,
  type ObservedResourceBody
} from "./semantic-conversation.mts";
export { validateLibrary } from "./semantic-library.mts";
export {
  validateCatalogCache,
  validateOperation,
  validateSystemLog,
  validateTransaction
} from "./semantic-operations.mts";
export {
  validateSovereignSnapshot,
  validateTerranPreset,
  validateTimeLimits,
  validateTimeSystem,
  validateTimeValue
} from "./semantic-time.mts";
export type { JsonObject, JsonValue, ValidationIssue, ValidationResult } from "./types.mts";

export const machineFiles = Object.freeze({
  resourceLimits,
  timeLimits,
  terranPreset
});

export class ContractValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

function requireValid(
  result: ValidationResult<JsonObject>,
  label: string
): JsonObject {
  if (result.ok) return result.value;
  throw new ContractValidationError(`${label} failed contract validation`, result.issues);
}

export function finalizeConversation(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new ContractValidationError("Conversation must be a JSON object", [{
      code: "CLOUDIG_SCHEMA_INVALID",
      path: "",
      message: "Conversation must be a JSON object"
    }]);
  }
  const candidate = structuredClone(value);
  candidate["content_sha256"] = computeConversationContentSha256(candidate);
  return requireValid(validateConversation(candidate), "Conversation");
}

export function serializeConversation(value: unknown): string {
  return serializeDeterministic(requireValid(validateConversation(value), "Conversation"));
}

export function serializeContainerIndex(value: unknown): string {
  return serializeDeterministic(requireValid(validateContainerIndexSchema<JsonObject>(value), "Container index"));
}

export function serializeContainerRecord(value: unknown): string {
  return `${JSON.stringify(orderJson(requireValid(validateContainerRecordSchema<JsonObject>(value), "Container record")))}\n`;
}

export function serializeLibrary(value: unknown): string {
  return serializeDeterministic(requireValid(validateLibrary(value), "Library"));
}

export function serializeOperation(value: unknown): string {
  return serializeDeterministic(requireValid(validateOperation(value), "Operation"));
}

export function serializeResourceLimits(value: unknown): string {
  return serializeDeterministic(requireValid(validateResourceLimitsSchema<JsonObject>(value), "Resource limits"));
}

export function serializeTransaction(value: unknown): string {
  return serializeDeterministic(requireValid(validateTransaction(value), "Transaction"));
}

export function serializeCatalogCache(value: unknown): string {
  return serializeDeterministic(requireValid(validateCatalogCache(value), "Catalog cache"));
}

export function serializeSystemLog(value: unknown): string {
  return serializeDeterministic(requireValid(validateSystemLog(value), "System Log"));
}

export function serializeTimeValue(value: unknown): string {
  return serializeDeterministic(requireValid(validateTimeValue(value), "Time value"));
}

export function serializeSovereignSnapshot(value: unknown): string {
  return serializeDeterministic(requireValid(validateSovereignSnapshot(value), "Sovereign snapshot"));
}

export function serializeTimeSystem(value: unknown): string {
  return serializeDeterministic(requireValid(validateTimeSystem(value), "Time System"));
}

export function serializeTimeLimits(value: unknown): string {
  return serializeDeterministic(requireValid(validateTimeLimits(value), "Time limits"));
}

export function serializeTerranPreset(value: unknown): string {
  return serializeDeterministic(requireValid(validateTerranPreset(value), "Terran preset"));
}
