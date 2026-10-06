import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import commonSchema from "./schemas/common.schema.json" with { type: "json" };
import containerIndexSchema from "./schemas/container-index.schema.json" with { type: "json" };
import containerRecordSchema from "./schemas/container-record.schema.json" with { type: "json" };
import catalogCacheSchema from "./schemas/catalog-cache.schema.json" with { type: "json" };
import conversationSchema from "./schemas/conversation.schema.json" with { type: "json" };
import librarySchema from "./schemas/library.schema.json" with { type: "json" };
import operationSchema from "./schemas/operation.schema.json" with { type: "json" };
import resourceLimitsSchema from "./schemas/resource-limits.schema.json" with { type: "json" };
import sovereignSnapshotSchema from "./schemas/sovereign-snapshot.schema.json" with { type: "json" };
import systemLogSchema from "./schemas/system-log.schema.json" with { type: "json" };
import terranPresetSchema from "./schemas/terran-preset.schema.json" with { type: "json" };
import timeLimitsSchema from "./schemas/time-limits.schema.json" with { type: "json" };
import timeSchema from "./schemas/time.schema.json" with { type: "json" };
import timeSystemSchema from "./schemas/time-system.schema.json" with { type: "json" };
import transactionSchema from "./schemas/transaction.schema.json" with { type: "json" };

import { assertJsonValue } from "./deterministic-json.mts";
import cachePolicySchema from "./schemas/cache-policy.schema.json" with { type: "json" };
import type { ValidationIssue, ValidationResult } from "./types.mts";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  validateFormats: false
});

ajv.addSchema(commonSchema);

const conversationValidator = ajv.compile(conversationSchema);
const containerIndexValidator = ajv.compile(containerIndexSchema);
const containerRecordValidator = ajv.compile(containerRecordSchema);
const libraryValidator = ajv.compile(librarySchema);
const operationValidator = ajv.compile(operationSchema);
const resourceLimitsValidator = ajv.compile(resourceLimitsSchema);
const transactionValidator = ajv.compile(transactionSchema);
const catalogCacheValidator = ajv.compile(catalogCacheSchema);
const systemLogValidator = ajv.compile(systemLogSchema);
const timeValidator = ajv.compile(timeSchema);
const sovereignSnapshotValidator = ajv.compile(sovereignSnapshotSchema);
const timeSystemValidator = ajv.compile(timeSystemSchema);
const timeLimitsValidator = ajv.compile(timeLimitsSchema);
const terranPresetValidator = ajv.compile(terranPresetSchema);
const cachePolicyValidator = ajv.compile(cachePolicySchema);

export function validateCachePolicySchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(cachePolicyValidator, value);
}

function schemaIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    code: "CLOUDIG_SCHEMA_INVALID",
    path: error.instancePath || "",
    message: `${error.keyword}: ${error.message ?? "invalid value"}`,
    details: {
      schema_path: error.schemaPath
    }
  }));
}

function runSchema<T>(validator: ValidateFunction, value: unknown): ValidationResult<T> {
  try {
    assertJsonValue(value);
  } catch (error) {
    return {
      ok: false,
      issues: [{
        code: "CLOUDIG_IJSON_INVALID",
        path: "",
        message: error instanceof Error ? error.message : "Value is not valid I-JSON"
      }]
    };
  }
  if (validator(value)) return { ok: true, value: value as T };
  return { ok: false, issues: schemaIssues(validator.errors) };
}

export function validateConversationSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(conversationValidator, value);
}

export function validateContainerIndexSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(containerIndexValidator, value);
}

export function validateContainerRecordSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(containerRecordValidator, value);
}

export function validateLibrarySchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(libraryValidator, value);
}

export function validateOperationSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(operationValidator, value);
}

export function validateResourceLimitsSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(resourceLimitsValidator, value);
}

export function validateTransactionSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(transactionValidator, value);
}

export function validateCatalogCacheSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(catalogCacheValidator, value);
}

export function validateSystemLogSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(systemLogValidator, value);
}

export function validateTimeSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(timeValidator, value);
}

export function validateSovereignSnapshotSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(sovereignSnapshotValidator, value);
}

export function validateTimeSystemSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(timeSystemValidator, value);
}

export function validateTimeLimitsSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(timeLimitsValidator, value);
}

export function validateTerranPresetSchema<T = unknown>(value: unknown): ValidationResult<T> {
  return runSchema<T>(terranPresetValidator, value);
}

export const machineSchemas = Object.freeze({
  cachePolicy: cachePolicySchema,
  common: commonSchema,
  containerIndex: containerIndexSchema,
  containerRecord: containerRecordSchema,
  catalogCache: catalogCacheSchema,
  conversation: conversationSchema,
  library: librarySchema,
  operation: operationSchema,
  resourceLimits: resourceLimitsSchema,
  transaction: transactionSchema,
  systemLog: systemLogSchema,
  time: timeSchema,
  sovereignSnapshot: sovereignSnapshotSchema,
  timeSystem: timeSystemSchema,
  timeLimits: timeLimitsSchema,
  terranPreset: terranPresetSchema
});
