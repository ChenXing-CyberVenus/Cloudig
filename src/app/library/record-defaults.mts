import type { JsonObject } from "../../core/contracts/types.mts";
import { uuidV7 } from "../../core/records/ids.mts";
import { validateRecord, type RecordKind } from "../../core/records/index.mts";
import frontPresets from "../../core/records/front-presets.json" with { type: "json" };
import timePresets from "../../core/records/time-presets.json" with { type: "json" };
import { builtinTimeNode } from "../../core/records/time-presets.mts";
import { CLOUDIG_STANDARD, recordSchemas } from "../../core/records/schema-registry.mts";

export type NewRecord = Readonly<{ path: string; kind: RecordKind; value: JsonObject }>;
export type LibraryDefaultsInput = Readonly<{ timestamp: string; anchor: Readonly<{ date: string; offset: string }>; language?: "zh-CN" | "en" }>;

/** Settings recovery must not generate replacement Front IDs or Time nodes. */
export function createLibraryMetadata(input: Pick<LibraryDefaultsInput, "timestamp" | "language">): JsonObject {
  const parseDefaults = (): JsonObject => ({ include_unparsed: true, include_selected: true, include_outdated: false, keep_previous: false });
  return {
    cloudig_standard: CLOUDIG_STANDARD,
    schema: recordSchemas.library.properties.schema.const,
    schemas: Object.fromEntries(Object.entries(recordSchemas.library.properties.schemas.properties).map(([kind, value]) => [kind, value.const])),
    edited_at: input.timestamp,
    settings: {
      language: input.language ?? "zh-CN", theme: "Dawn", theme_guide_completed: false, default_output_directory: "Conversations",
      time_type: { archiver: "file_modified_at", reader: "file_modified_at", claude_json: "conversation_updated_at" },
      sort: { parser: "time_desc", archiver: "time_desc", reader: "time_desc", claude_json: "time_desc" },
      one_click_parse: { parser: parseDefaults(), claude_json: parseDefaults() }
    }
  };
}

export function createLibraryRecords(input: LibraryDefaultsInput): NewRecord[] {
  const records: NewRecord[] = [];
  const add = (path: string, kind: RecordKind, value: JsonObject): void => {
    const valid = validateRecord(kind, value);
    if (!valid.ok) throw new TypeError(`Invalid default ${path}: ${JSON.stringify(valid.issues)}`);
    records.push({ path, kind, value });
  };
  const createFront = (names: JsonObject[], subject: "human" | "ai", front_id = uuidV7(Date.parse(input.timestamp))): string => {
    add(`Identities/${front_id}.json`, "identity", {
      schema: "cloudig/identity/1.0.0", front_id, names,
      kind: { world: "terran", subject }, created_at: input.timestamp, edited_at: input.timestamp
    });
    return front_id;
  };
  const subject = createFront([], "human"), assistant = createFront([], "ai");
  const platforms: JsonObject = {};
  for (const preset of frontPresets.presets) if (preset.usage === "platform_fallback" && "platform" in preset) {
    // Platform identity is shared across new libraries, not inferred from its company.
    // Keep this outside identity templates so source-local Fronts never inherit it.
    if (!("front_id" in preset) || typeof preset.front_id !== "string") throw new TypeError(`Platform ${preset.platform} has no fixed Front ID`);
    if (Object.values(platforms).includes(preset.front_id)) throw new TypeError("Platform Front IDs must be distinct");
    platforms[preset.platform] = createFront(structuredClone(preset.identity.names) as JsonObject[], "ai", preset.front_id);
  }
  add("Identities/identity-settings.json", "identitySettings", {
    schema: "cloudig/identity-settings/1.0.0", edited_at: input.timestamp, subject, assistant, apply_assistant_to_all: false, platforms
  });
  add("CloudigLibrary.json", "library", createLibraryMetadata(input));
  const presetNodes = timePresets.nodes as readonly JsonObject[];
  for (const preset of presetNodes) {
    const node = builtinTimeNode(String(preset["node_id"]), input);
    add(`ContentTimes/${node["node_id"]}.json`, "contentTime", node);
  }
  add("ContentTimes/order.json", "contentTimeOrder", { schema: "cloudig/content-time-order/1.0.0", edited_at: input.timestamp, nodes: [presetNodes[0]!["node_id"]!] });
  return records;
}
