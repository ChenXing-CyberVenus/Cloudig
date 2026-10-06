import { readFile } from "node:fs/promises";

import { classifyArchiveConflict } from "../../core/archive/ids.mts";
import { validateConversation } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { resolveArchiveView, type BuiltinIdentity, type ResolvedArchiveView } from "../../core/library/overlay.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { readCurrentAuthorityPair } from "../storage/recovery-point.mts";
import { readCurrentListingSnapshot } from "./catalog.mts";

export type ArchiveListRow = Readonly<{
  path: string;
  bytes: number;
  mtimeNs: string;
  sha256: string;
  archive: string;
  generation: number;
  archived: boolean;
  access: "normal" | "read_only_conflict";
  view: ResolvedArchiveView;
  messageCount: number;
  resourceCount: number;
  times: JsonObject;
  sourceFile?: string;
  parserVersion?: string;
  adapter?: Readonly<{ id: string; version: string }>;
}>;

function syntheticConversation(row: JsonObject, portableUser?: JsonObject): JsonObject {
  const times = row["times"] && typeof row["times"] === "object" && !Array.isArray(row["times"])
    ? row["times"] as JsonObject
    : {};
  return {
    archive: row["archive"]!,
    generation: row["generation"]!,
    platform: row["platform"]!,
    ...(row["source_title"] === undefined ? {} : { title: row["source_title"]! }),
    ...(row["models"] === undefined ? {} : { models: row["models"]! }),
    lifecycle: {
      ...(times["json_created_at"] === undefined ? {} : { first_parsed_at: { basis: "parser", value: times["json_created_at"]! } }),
      ...(times["json_edited_at"] === undefined ? {} : { cloudig_edited_at: times["json_edited_at"]! })
    },
    content_time: { basis: "unavailable" },
    ...(portableUser === undefined ? {} : { user: portableUser })
  };
}

export async function listArchiveRows(
  libraryRoot: string,
  input: Readonly<{
    builtins: BuiltinIdentity;
    availableAssets: ReadonlySet<string>;
    portableUserSnapshots?: Readonly<Record<string, JsonObject>>;
  }>
): Promise<Readonly<{ degraded: boolean; rows: readonly ArchiveListRow[] }>> {
  const pair = await readCurrentAuthorityPair(libraryRoot);
  const { catalog } = await readCurrentListingSnapshot(libraryRoot);
  if (!catalog || !Array.isArray(catalog["archives"])) return { degraded: true, rows: [] };
  const observed = catalog["archives"]
    .filter((entry): entry is JsonObject => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({ archive: String(entry["archive"]), path: String(entry["path"]) }));
  const rows = catalog["archives"].flatMap((raw): ArchiveListRow[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as JsonObject;
    const archive = String(row["archive"]);
    const relativePath = String(row["path"]);
    const conflict = classifyArchiveConflict(archive, relativePath, observed);
    return [{
      path: relativePath,
      bytes: row["bytes"] as number,
      mtimeNs: row["mtime_ns"] as string,
      sha256: row["sha256"] as string,
      archive,
      generation: row["generation"] as number,
      archived: row["archived"] === true,
      access: conflict === "read_only_conflict" ? "read_only_conflict" : "normal",
      view: resolveArchiveView(
        syntheticConversation(row, input.portableUserSnapshots?.[relativePath]),
        pair.library,
        input.builtins,
        input.availableAssets
      ),
      messageCount: row["message_count"] as number,
      resourceCount: row["resource_count"] as number,
      times: row["times"] && typeof row["times"] === "object" && !Array.isArray(row["times"])
        ? structuredClone(row["times"] as JsonObject)
        : {},
      ...(typeof row["source_file"] === "string" ? { sourceFile: row["source_file"] } : {}),
      ...(typeof row["parser"] === "string" ? { parserVersion: row["parser"] } : {}),
      ...(row["adapter"] && typeof row["adapter"] === "object" && !Array.isArray(row["adapter"])
        && typeof row["adapter"]["id"] === "string" && typeof row["adapter"]["version"] === "string"
        ? { adapter: { id: row["adapter"]["id"], version: row["adapter"]["version"] } }
        : {})
    }];
  });
  return { degraded: false, rows };
}

export async function openConversationExact(
  libraryRoot: string,
  relativePath: string,
  builtins: BuiltinIdentity,
  availableAssets: ReadonlySet<string>
): Promise<Readonly<{ conversation: JsonObject; view: ResolvedArchiveView }>> {
  if (!relativePath.startsWith("Conversations/") || !relativePath.toLowerCase().endsWith(".json")) {
    throw new TypeError("Conversation open requires an exact managed JSON path");
  }
  const absolute = await resolveManagedPath(libraryRoot, relativePath, { mustExist: true });
  const value: unknown = JSON.parse(await readFile(absolute, "utf8"));
  const validation = validateConversation(value);
  if (!validation.ok) throw new TypeError(`Conversation is invalid: ${validation.issues.map((entry) => entry.code).join(",")}`);
  const pair = await readCurrentAuthorityPair(libraryRoot);
  return {
    conversation: validation.value,
    view: resolveArchiveView(validation.value, pair.library, builtins, availableAssets)
  };
}
