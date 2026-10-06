import path from "node:path";
import type { RecordKind } from "./schema-registry.mts";
import type { JsonObject } from "../contracts/types.mts";

export const CLOUDIG_DIRECTORIES = Object.freeze(["Inbox", "Conversations", "Marks", "ContentTimes", "Identities", "Archives", "Exports", "bookmarks", "docs", "appdata", "app", "cache"] as const);
export const RECORD_STORAGE_LIMITS = Object.freeze({ completedRecoveryGroups: 2, bookmarkBackupGroups: 2 });

/** Companion bytes remain original Inbox data. Only this direct-source-owned
 * shape is added; ordinary recursive source imports are still unsupported. */
export function isInboxImportLocation(relative: string): boolean {
  return /^Inbox\/[^/]+$/u.test(relative) || /^Inbox\/[^/]+\.json\.assets\/[a-f0-9]{64}\.bin$/iu.test(relative);
}

export function confinedRelativePath(relative: string): string {
  const parts = relative.split("/");
  if (!relative || path.isAbsolute(relative) || parts.some(p => !p || p === "." || p === ".." || /[<>:"\\|?*\x00-\x1f]/u.test(p) || /[ .]$/u.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))) throw new TypeError("Expected a confined Windows relative path");
  return relative;
}

/** Record-scope check; callers also enforce confined, non-linked paths. */
export function isConversationLocation(relative: string): boolean {
  return /^(?:Conversations|Archives)\/.+/u.test(relative) && /\.json$/iu.test(relative);
}

export function assertRecordLocation(kind: RecordKind, relative: string, value: JsonObject): void {
  confinedRelativePath(relative);
  const exact: Partial<Record<RecordKind, string>> = {
    library: "CloudigLibrary.json",
    identitySettings: "Identities/identity-settings.json",
    contentTimeOrder: "ContentTimes/order.json",
    identity: `Identities/${value["front_id"]}.json`,
    mark: `Marks/${value["mark_id"]}.json`,
    contentTime: `ContentTimes/${value["node_id"]}.json`
  };
  if (kind === "conversation") {
    if (!isConversationLocation(relative)) throw new TypeError("Conversation belongs under Conversations or Archives");
  } else if (exact[kind] !== relative) throw new TypeError(`Record belongs at ${exact[kind]}`);
}
