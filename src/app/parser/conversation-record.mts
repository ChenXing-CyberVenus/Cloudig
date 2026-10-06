import path from "node:path";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { validateRecord, validateConversationRecordMetadata, type ObservedRecordResource } from "../../core/records/index.mts";
import { isAgentInstanceSourceId, SourceFronts } from "../../core/records/front.mts";
import { uuidV7 } from "../../core/records/ids.mts";
import { CONVERSATION_SCHEMA, LEGACY_CONVERSATION_SCHEMA } from "../../core/records/schema-registry.mts";
import type { ParsedSourceDraft, SourceMessageFacts } from "./adapter.mts";

// Adapter extraction evidence, not another persisted participant/schema layer.
export type SourceRecordFacts = Readonly<{
  captured?: Readonly<{ at: string; from: string }>;
  // A source-backed attribution to the whole conversation, never a current
  // model selector. Claude HTML must not populate this fallback.
  conversationModel?: string;
  messages?: readonly SourceMessageFacts[];
  current?: string;
  // Evidence that the source file itself is one conversation (not a multi-chat
  // container). It may use its first filename without claiming a platform title.
  singleConversationFile?: boolean;
  // Original single-conversation member name inside a ZIP (not the ZIP title).
  filenameSource?: string;
  blockSpeakers?: ReadonlyMap<JsonObject, SourceMessageFacts>;
}>;
const obj = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const list = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v as JsonObject[] : [];
const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length ? v : undefined;

export function assembleConversationRecord(input: Readonly<{
  parsed: ParsedSourceDraft; facts: SourceRecordFacts; parserVersion: string; timestamp: string; previous?: JsonObject;
  previousResources?: ReadonlyMap<string, ObservedRecordResource>;
}>): JsonObject {
  const { parsed, facts, timestamp, previous } = input, draft = parsed.draft;
  if (previous) { const valid = input.previousResources ? validateConversationRecordMetadata(previous, input.previousResources) : validateRecord("conversation", previous); if (!valid.ok) throw new TypeError("Invalid previous Conversation"); }
  const rawSource = obj(draft["source"]), source: JsonObject = {};
  for (const key of ["file", "sha256", "bytes", "format", "exporter", "url", "conversation_created_at", "conversation_updated_at"]) if (rawSource[key] !== undefined) source[key] = rawSource[key]!;
  if (["light", "full", "tree"].includes(String(rawSource["profile"]))) source["profile"] = rawSource["profile"]!;
  const locator = text(obj(rawSource["locator"])["value"]) ?? text(rawSource["locator"]);
  if (locator) source["locator"] = locator;
  if (facts.captured) { source["captured_at"] = facts.captured.at; source["captured_from"] = facts.captured.from; }
  else if (rawSource["captured_at"] !== undefined) throw new TypeError("Captured source time requires its actual field or filesystem basis");
  const fronts = new SourceFronts(String(draft["platform"]));
  const rawMessages = list(draft["messages"]);
  if (facts.messages && facts.messages.length !== rawMessages.length) throw new TypeError("Source identity evidence must match extracted messages");
  const calls = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const scan = rawMessages.flatMap(m => list(m["content"]));
  while (scan.length) {
    const b = scan.pop()!; scan.push(...list(b["content"]));
    if (b["type"] === "tool" && b["kind"] === "call" && text(b["call"]) && (text(b["name"]) || text(b["title"]))) toolNames.set(String(b["call"]), String(b["name"] ?? b["title"]));
  }
  const blocks = (values: JsonObject[]): JsonObject[] => values.map(raw => {
    const b: JsonObject = { ...raw };
    const actor = facts.blockSpeakers?.get(raw);
    if (actor?.role) {
      const name = actor.role === "assistant"
        ? actor.sourceId ? actor.name ?? actor.model ?? (isAgentInstanceSourceId(actor.sourceId) ? undefined : facts.conversationModel) : actor.model ?? actor.name ?? facts.conversationModel
        : actor.name;
      b["speaker"] = fronts.get({ role: actor.role, ...(name ? { name } : {}), ...(actor.sourceId ? { sourceId: actor.sourceId } : {}), ...(actor.subject ? { subject: actor.subject } : {}) });
    }
    if (b["sources"] !== undefined) { b["references"] = b["sources"]!; delete b["sources"]; }
    if (Array.isArray(b["content"])) b["content"] = blocks(list(b["content"]));
    if (b["type"] === "tool") {
      const call = text(b["call"]), name = (call ? toolNames.get(call) : undefined) ?? text(b["name"]) ?? text(b["title"]);
      const tool = (call ? calls.get(call) : undefined) ?? fronts.get({ role: "tool", ...(name && name !== "Claude tool" ? { name } : {}) });
      if (call) calls.set(call, tool);
      if (b["kind"] === "result") b["speaker"] = tool;
      else b["recipient"] = tool;
      delete b["name"];
    }
    return b;
  });
  const linear = !rawMessages.some(m => m["id"] !== undefined);
  const inheritSpeaker = (content: JsonObject[], inherited: string | undefined): void => {
    for (const b of content) {
      const current = text(b["speaker"]) ?? inherited;
      if (b["speaker"] === inherited) delete b["speaker"];
      if (Array.isArray(b["content"])) inheritSpeaker(b["content"] as JsonObject[], current);
    }
  };
  const messages = rawMessages.map((raw, i): JsonObject => {
    const f = facts.messages?.[i], role = f?.role ?? String(raw["role"]);
    const name = role === "assistant"
      ? f?.sourceId ? f.name ?? f.model ?? text(raw["model"]) ?? (isAgentInstanceSourceId(f.sourceId) ? undefined : facts.conversationModel) : f?.model ?? f?.name ?? text(raw["model"]) ?? facts.conversationModel
      : f ? f.name : text(raw["name"]);
    const content = blocks(list(raw["content"]));
    const speaker = content.length || role !== "system" ? fronts.get({ role, ...(name ? { name } : {}), ...(f?.sourceId ? { sourceId: f.sourceId } : {}), ...(f?.subject ? { subject: f.subject } : {}) }) : undefined;
    inheritSpeaker(content, speaker);
    const id = f?.id ?? text(raw["id"]) ?? `m${i + 1}`;
    // Only a genuinely linear extraction gets sequential parents. Explicit trees
    // keep missing parents and multiple roots exactly as the source says.
    const parent = f ? f.parent : text(raw["parent"]) ?? (linear && i > 0 ? `m${i}` : undefined);
    return { id, ...(parent ? { parent } : {}),
      ...(speaker ? { speaker } : {}),
      ...(raw["timestamp"] !== undefined ? { timestamp: raw["timestamp"]! } : {}), content };
  });
  const resources = list(draft["resources"]).map(raw => {
    const resource: JsonObject = { ...raw }, original: JsonObject = { ...obj(raw["original"]) };
    for (const field of ["name", "mime", "url", "bytes", "sha256"]) {
      const key = `original_${field}`; if (resource[key] !== undefined) { original[field] = resource[key]!; delete resource[key]; }
    }
    if (Object.keys(original).length) resource["original"] = original;
    return resource;
  });
  const previousTitle = obj(previous?.["title"]), title: JsonObject = {};
  if (Object.hasOwn(previousTitle, "filename")) title["filename"] = previousTitle["filename"]!;
  else if (!previous && (!["json-container", "zip-container"].includes(String(source["format"])) || facts.singleConversationFile)) {
    const stem = path.parse(facts.filenameSource ?? String(source["file"])).name; if (stem) title["filename"] = stem;
  }
  if (text(draft["title"])) title["original"] = draft["title"]!;
  const current = facts.current ?? text(draft["current_message"]);
  const pending = messages.flatMap(message => list(message["content"]));
  let hasInteractive = false;
  while (pending.length) { const block = pending.pop()!; if (block["type"] === "interactive") hasInteractive = true; pending.push(...list(block["content"])); }
  const record: JsonObject = {
    schema: hasInteractive || previous?.["schema"] === CONVERSATION_SCHEMA ? CONVERSATION_SCHEMA : LEGACY_CONVERSATION_SCHEMA, conversation_id: previous?.["conversation_id"] ?? uuidV7(Date.parse(timestamp)),
    parser: { version: input.parserVersion, adapter: { id: parsed.adapter.id, version: parsed.adapter.version } },
    lifecycle: { first_parsed_at: obj(previous?.["lifecycle"])["first_parsed_at"] ?? timestamp, last_parsed_at: timestamp, cloudig_edited_at: timestamp },
    source, platform: draft["platform"]!, ...(Object.keys(title).length ? { title } : {}),
    ...(draft["models"] !== undefined ? { models: draft["models"]! } : {}),
    ...(draft["message_time"] !== undefined ? { message_time: draft["message_time"]! } : {}),
    identity: fronts.values, messages: { ...(current ? { current } : {}), items: messages },
    ...(resources.length ? { resources } : {}),
    ...(draft["sources"] !== undefined ? { references: draft["sources"]! } : {}),
    ...(draft["limitations"] !== undefined ? { limitations: draft["limitations"]! } : {})
  };
  const valid = validateRecord("conversation", record);
  if (!valid.ok) throw new TypeError(`Extracted Conversation does not satisfy the record contract: ${JSON.stringify(valid.issues)}`);
  return record;
}
