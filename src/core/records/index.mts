import type { JsonObject, ValidationResult } from "../contracts/types.mts";
import { parseRecordJson } from "./json.mts";
import { validateRecordShape, validateRecordRangeShape, CLOUDIG_STANDARD, type RecordKind } from "./schema-registry.mts";
import { isJsonObject } from "../contracts/types.mts";
import { validateRecordSemantics, validateRecordRangeSemantics } from "./semantics.mts";

export { recordSchemas, type RecordKind } from "./schema-registry.mts";
export { parseRecordJson, assertRecordJson } from "./json.mts";
export { inspectTimeLinks } from "./semantics.mts";
export type { ObservedRecordResource } from "./semantics.mts";

export function validateRecord(kind: RecordKind, value: unknown): ValidationResult<JsonObject> {
  const shape = validateRecordShape(kind, value);
  if (!shape.ok) return shape;
  const issues = validateRecordSemantics(kind, shape.value);
  return issues.length ? { ok: false, issues } : shape;
}
export function validateRecordRange(value: unknown): ValidationResult<JsonObject> {
  const shape = validateRecordRangeShape(value); if (!shape.ok) return shape;
  const issues = validateRecordRangeSemantics(shape.value); return issues.length ? { ok: false, issues } : shape;
}

export function validateConversationRecordMetadata(value: unknown, observed: ReadonlyMap<string, import("./semantics.mts").ObservedRecordResource>): ValidationResult<JsonObject> {
  const shape = validateRecordShape("conversation", value, true);
  if (!shape.ok) return shape;
  const issues = validateRecordSemantics("conversation", shape.value, observed);
  return issues.length ? { ok: false, issues } : shape;
}

export function decodeRecord(kind: RecordKind, bytes: Uint8Array | string): ValidationResult<JsonObject> {
  try {
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // Accept one UTF-8 BOM at the file boundary only; it is not JSON content.
    const value = parseRecordJson(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    // The previously shipped development Library omitted only this declaration.
    // Adapt in memory; the complete current field/version checks still apply,
    // and reading never rewrites the file or fills any user setting.
    return validateRecord(kind, kind === "library" && isJsonObject(value)
      && value["schema"] === "cloudig/library/1.0.0" && !Object.hasOwn(value, "cloudig_standard")
      ? { cloudig_standard: CLOUDIG_STANDARD, ...value } : value);
  } catch (error) {
    return { ok: false, issues: [{ code: "CLOUDIG_RECORD_JSON", path: "", message: error instanceof Error ? error.message : "Invalid record JSON" }] };
  }
}

export function encodeRecord(kind: RecordKind, value: unknown): string {
  const result = validateRecord(kind, value);
  if (!result.ok) throw new TypeError(result.issues.map(x => `${x.path}: ${x.message}`).join("; "));
  // Keep human ordering and text exactly; no content hash/revision or default fields are injected.
  return JSON.stringify(kind === "library" ? { cloudig_standard: CLOUDIG_STANDARD, ...result.value } : result.value, null, 2) + "\n";
}
