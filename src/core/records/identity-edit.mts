import { isDeepStrictEqual } from "node:util";
import { frontName } from "./front.mts";
import { isJsonObject, type JsonObject } from "../contracts/types.mts";
import { RECORD_TEXT_LIMITS, withinRecordTextLimit } from "./text-limits.mts";

export const RECORD_IDENTITY_LIMITS = Object.freeze({ nameCharacters: RECORD_TEXT_LIMITS.name });
export type RecordAvatarEdit = { state: "keep" | "clear" } | { state: "picker"; picker: string };
export type RecordPartyEdit = { name?: string; avatar: RecordAvatarEdit };
export type RecordIdentityDraft = { global: { user: RecordPartyEdit; assistant: RecordPartyEdit & { applyToAll: boolean } }; platforms: Record<string, RecordPartyEdit> };
function exact(v: unknown, required: string[], optional: string[] = []): JsonObject {
  if (!isJsonObject(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new TypeError("Invalid identity editor fields"); return v;
}
export function identityName(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !withinRecordTextLimit(value, RECORD_TEXT_LIMITS.name)) throw new TypeError("Identity name is invalid"); return value.trim() || undefined;
}
function party(raw: unknown): RecordPartyEdit {
  const value = exact(raw, ["avatar"], ["name"]), name = identityName(value["name"]), avatar = exact(value["avatar"], ["state"], ["picker"]);
  if ((avatar["state"] === "keep" || avatar["state"] === "clear") && avatar["picker"] === undefined) return { ...(name ? { name } : {}), avatar: { state: avatar["state"] } };
  if (avatar["state"] === "picker" && typeof avatar["picker"] === "string" && /^p_[A-Za-z0-9_-]{43}$/u.test(avatar["picker"])) return { ...(name ? { name } : {}), avatar: { state: "picker", picker: avatar["picker"] } };
  throw new TypeError("Identity avatar choice is invalid");
}
export function parseRecordIdentityDraft(raw: unknown, platforms: ReadonlySet<string>): RecordIdentityDraft {
  const root = exact(raw, ["global", "platforms"]), global = exact(root["global"], ["user", "assistant"]), assistant = exact(global["assistant"], ["avatar", "apply_to_all"], ["name"]);
  if (typeof assistant["apply_to_all"] !== "boolean" || !isJsonObject(root["platforms"])) throw new TypeError("Invalid platform identity choices");
  const { apply_to_all: _apply, ...base } = assistant;
  return { global: { user: party(global["user"]), assistant: { ...party(base), applyToAll: assistant["apply_to_all"] } }, platforms: Object.fromEntries(Object.entries(root["platforms"]).map(([key, value]) => {
    if (!platforms.has(key)) throw new TypeError("Unknown platform identity"); return [key, party(value)];
  })) };
}
/** Display selection is not a new identity, and restoring it never deletes name claims. */
export function editRecordFront(front: JsonObject, input: RecordPartyEdit, userId: string, timestamp: string, image: string | undefined): JsonObject {
  const result = structuredClone(front), names = result["names"] as JsonObject[];
  if (input.name === undefined) delete result["display_name"];
  else if (frontName(result) !== input.name) {
    let index = names.findIndex(n => n["name"] === input.name);
    if (index < 0) { names.push({ name: input.name, claimers: [{ front: userId }] }); index = names.length - 1; }
    result["display_name"] = index + 1;
  }
  if (image === undefined) delete result["image"]; else result["image"] = image;
  if (!isDeepStrictEqual(result, front)) result["edited_at"] = timestamp;
  return result;
}
