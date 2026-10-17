import common from "./schemas/common.schema.json" with { type: "json" };

// The two Schema definitions are the single numerical authority. Count Unicode
// code points, exactly as JSON Schema maxLength does (not UTF-16 code units).
export const RECORD_TEXT_LIMITS = Object.freeze({
  name: common.$defs.nameText.maxLength,
  title: common.$defs.titleText.maxLength
});
export function recordTextLength(value: string): number { return Array.from(value).length; }
export function withinRecordTextLimit(value: string, limit: number): boolean {
  let length = 0;
  for (const _character of value) if (++length > limit) return false;
  return true;
}
