import type { ValidationIssue } from "../contracts/types.mts";

export const RECORD_SCHEMA_UNSUPPORTED = "CLOUDIG_RECORD_SCHEMA_UNSUPPORTED";
export class RecordSchemaError extends TypeError {
  readonly code = RECORD_SCHEMA_UNSUPPORTED;
}
export function recordValidationError(issues: readonly ValidationIssue[]): TypeError {
  const incompatible = issues.find(issue => issue.code === RECORD_SCHEMA_UNSUPPORTED);
  return incompatible ? new RecordSchemaError(incompatible.message) : new TypeError(`Invalid record: ${JSON.stringify(issues)}`);
}
