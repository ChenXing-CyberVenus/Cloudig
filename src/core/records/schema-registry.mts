import { Ajv2020 } from "ajv/dist/2020.js";
import common from "./schemas/common.schema.json" with { type: "json" };
import library from "./schemas/library.schema.json" with { type: "json" };
import identity from "./schemas/identity.schema.json" with { type: "json" };
import identitySettings from "./schemas/identity-settings.schema.json" with { type: "json" };
import conversation from "./schemas/conversation.schema.json" with { type: "json" };
import conversation100 from "./schemas/compat/conversation-1.0.0.schema.json" with { type: "json" };
import library100 from "./schemas/compat/library-1.0.0.schema.json" with { type: "json" };
import mark from "./schemas/mark.schema.json" with { type: "json" };
import contentTime from "./schemas/content-time.schema.json" with { type: "json" };
import contentTimeOrder from "./schemas/content-time-order.schema.json" with { type: "json" };
import type { JsonObject, ValidationResult } from "../contracts/types.mts";
import { assertRecordJson } from "./json.mts";
import { RECORD_SCHEMA_UNSUPPORTED } from "./errors.mts";

export const recordSchemas = Object.freeze({ library, identity, identitySettings, conversation, mark, contentTime, contentTimeOrder });
export type RecordKind = keyof typeof recordSchemas;
export const CLOUDIG_STANDARD = library.properties.cloudig_standard.const;
export const CONVERSATION_SCHEMA = conversation.properties.schema.const;
export const LEGACY_CONVERSATION_SCHEMA = conversation100.properties.schema.const;
export const LIBRARY_SCHEMA = library.properties.schema.const;
const compatibilitySchemas = { conversation: [conversation100], library: [library100] };
const schemasFor = (kind: RecordKind) => [recordSchemas[kind], ...(kind === "conversation" || kind === "library" ? compatibilitySchemas[kind] : [])];
const declaredSchema = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject)["schema"] : undefined;
const schemaFor = (kind: RecordKind, value: unknown) => schemasFor(kind).find(schema => schema.properties.schema.const === declaredSchema(value));
export const supportsConversationSchema = (value: unknown): boolean => schemasFor("conversation").some(schema => schema.properties.schema.const === value);
export function recordSchemaIssue(kind: RecordKind, value: JsonObject) {
  const selected = schemaFor(kind, value);
  const libraryVersions = (selected ?? library).properties as unknown as { schemas?: { properties: Record<string, { const: string }> } };
  const expectedVersions = libraryVersions.schemas?.properties ?? library.properties.schemas.properties;
  const unsupported = typeof value["schema"] === "string" && !selected
    || kind === "library" && (value["cloudig_standard"] !== undefined && value["cloudig_standard"] !== CLOUDIG_STANDARD
      || value["schemas"] && typeof value["schemas"] === "object" && !Array.isArray(value["schemas"])
        && Object.entries(value["schemas"]).some(([key, version]) => !Object.hasOwn(expectedVersions, key)
          || version !== (expectedVersions as Record<string, { const: string }>)[key]!.const));
  return unsupported ? { code: RECORD_SCHEMA_UNSUPPORTED, path: "/schema", message: "此文件的数据标准不受当前采云支持，请更新采云或使用支持该标准的版本。原文件未改写。 / Unsupported data standard. Update Cloudig or use a compatible version; the original file was preserved." } : undefined;
}
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
ajv.addSchema(common);
for (const schema of Object.values(recordSchemas)) ajv.addSchema(schema);
for (const schema of [...compatibilitySchemas.conversation, ...compatibilitySchemas.library]) ajv.addSchema(schema);
// Reader-only projection: the actual body was streamed and is validated by
// byte/hash evidence, not replaced with dummy Base64 or a second record format.
const conversationProjections = new Map([conversation, conversation100].map(schema => {
  const metadataSchema = structuredClone(schema);
  metadataSchema.$id = schema.$id.replace("/records/", "/internal/") + "/metadata";
  const projectedResource = metadataSchema.$defs.resource as unknown as JsonObject;
  projectedResource["not"] = { required: ["data_base64"] };
  delete ((projectedResource["allOf"] as JsonObject[])[0]!["then"] as JsonObject)["allOf"];
  const headerSchema = structuredClone(schema);
  headerSchema.$id = schema.$id.replace("/records/", "/internal/") + "/header";
  headerSchema.required = headerSchema.required.filter(k => k !== "messages");
  for (const field of ["messages", "resources", "references", "limitations"]) delete (headerSchema.properties as unknown as JsonObject)[field];
  return [schema.properties.schema.const, { metadata: ajv.compile(metadataSchema), header: ajv.compile(headerSchema) }];
}));
const timeRangeValidator = ajv.compile({ $ref: `${common.$id}#/$defs/range` });

/** An internal list projection, not a Conversation eligible for saving. */
export function validateConversationHeader(value: unknown): value is JsonObject { return conversationProjections.get(String(declaredSchema(value)))?.header(value) === true; }

export function validateRecordRangeShape(value: unknown): ValidationResult<JsonObject> {
  try { assertRecordJson(value); } catch (e) { return { ok: false, issues: [{ code: "CLOUDIG_RECORD_JSON", path: "", message: e instanceof Error ? e.message : "Invalid time JSON" }] }; }
  if (timeRangeValidator(value)) return { ok: true, value: value as JsonObject };
  return { ok: false, issues: (timeRangeValidator.errors ?? []).map(e => ({ code: "CLOUDIG_RECORD_SHAPE", path: e.instancePath, message: `${e.keyword}: ${e.message}` })) };
}

export function validateRecordShape(kind: RecordKind, value: unknown, metadata = false): ValidationResult<JsonObject> {
  try { assertRecordJson(value); }
  catch (error) { return { ok: false, issues: [{ code: "CLOUDIG_RECORD_JSON", path: "", message: error instanceof Error ? error.message : "Invalid JSON" }] }; }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const issue = recordSchemaIssue(kind, value as JsonObject); if (issue) return { ok: false, issues: [issue] };
  }
  const selected = schemaFor(kind, value) ?? recordSchemas[kind];
  const validator = metadata && kind === "conversation" ? conversationProjections.get(selected.properties.schema.const)!.metadata : ajv.getSchema(selected.$id)!;
  if (validator(value)) return { ok: true, value: value as JsonObject };
  return { ok: false, issues: (validator.errors ?? []).map(error => ({ code: "CLOUDIG_RECORD_SHAPE", path: error.instancePath, message: `${error.keyword}: ${error.message ?? "invalid field"}` })) };
}
