import { canonicalizeJcs } from "../contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";

export type BuiltinParty = Readonly<{
  name: string;
  avatar: string;
  localizedNames?: Readonly<Partial<Record<"zh-CN" | "en", string>>>;
}>;

export type BuiltinIdentity = Readonly<{
  user: BuiltinParty;
  assistant: BuiltinParty;
  platforms: Readonly<Record<string, BuiltinParty>>;
}>;

export type ResolvedArchiveView = Readonly<{
  archive: string;
  platform: string;
  archiveLayer: "library" | "conversation_snapshot" | "none";
  conversationName?: string;
  models: readonly string[];
  userName: string;
  assistantName: string;
  userAvatar: string;
  assistantAvatar: string;
  contentTime: { state: "set" | "cleared" | "unavailable"; range?: JsonValue };
  effectiveEditedAt?: string;
}>;

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function string(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function resolveUserContentTime(values: JsonObject | undefined): ResolvedArchiveView["contentTime"] {
  const time = object(values?.["content_time"]);
  if (time?.["state"] === "set") return { state: "set", range: structuredClone(time["range"]!) };
  return { state: time?.["state"] === "cleared" ? "cleared" : "unavailable" };
}

function availableManagedAvatar(
  identity: JsonObject | undefined,
  availableAssets: ReadonlySet<string>
): string | undefined {
  const avatar = string(identity?.["avatar"]);
  return avatar && availableAssets.has(avatar) ? avatar : undefined;
}

function builtinName(party: BuiltinParty, language: "zh-CN" | "en"): string {
  return party.localizedNames?.[language] ?? party.name;
}

function chooseArchiveLayer(conversation: JsonObject, library: JsonObject): {
  layer?: JsonObject;
  origin: "library" | "conversation_snapshot" | "none";
} {
  const archive = string(conversation["archive"]);
  const archives = object(library["archives"]);
  const libraryLayer = archive ? object(archives?.[archive]) : undefined;
  if (libraryLayer) return { layer: libraryLayer, origin: "library" };
  const snapshot = object(conversation["user"]);
  if (snapshot) return { layer: snapshot, origin: "conversation_snapshot" };
  return { origin: "none" };
}

export function resolveArchiveView(
  conversation: JsonObject,
  library: JsonObject,
  builtins: BuiltinIdentity,
  availableAssets: ReadonlySet<string>
): ResolvedArchiveView {
  const archive = string(conversation["archive"]) ?? "";
  const platform = string(conversation["platform"]) ?? "";
  const { layer, origin } = chooseArchiveLayer(conversation, library);
  const archiveNames = object(layer?.["names"]);
  const identity = object(library["identity"]);
  const global = object(identity?.["global"]);
  const globalUser = object(global?.["user"]);
  const globalAssistant = object(global?.["assistant"]);
  const platforms = object(identity?.["platforms"]);
  const platformIdentity = object(platforms?.[platform]);
  const platformAssistant = object(platformIdentity?.["assistant"]);
  const platformBuiltin = builtins.platforms[platform];
  const applyToAll = globalAssistant?.["apply_to_all"] === true;
  const preferences = object(library["preferences"]);
  const language = preferences?.["language"] === "en" ? "en" : "zh-CN";

  const userName = string(archiveNames?.["user"])
    ?? string(globalUser?.["name"])
    ?? builtinName(builtins.user, language);
  const assistantName = string(archiveNames?.["assistant"])
    ?? (applyToAll ? string(globalAssistant?.["name"]) : undefined)
    ?? string(platformAssistant?.["name"])
    ?? string(globalAssistant?.["name"])
    ?? platformBuiltin?.name
    ?? builtinName(builtins.assistant, language);
  const userAvatar = availableManagedAvatar(globalUser, availableAssets) ?? builtins.user.avatar;
  const assistantAvatar = (applyToAll ? availableManagedAvatar(globalAssistant, availableAssets) : undefined)
    ?? availableManagedAvatar(platformAssistant, availableAssets)
    ?? availableManagedAvatar(globalAssistant, availableAssets)
    ?? platformBuiltin?.avatar
    ?? builtins.assistant.avatar;

  const conversationName = string(layer?.["conversation_name"])
    ?? string(conversation["title"]);
  const layerModels = layer && Object.hasOwn(layer, "models") && Array.isArray(layer["models"])
    ? layer["models"].filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const sourceModels = Array.isArray(conversation["models"])
    ? conversation["models"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const models = layerModels ?? sourceModels;

  const contentTime = resolveUserContentTime(layer);

  const lifecycle = object(conversation["lifecycle"]);
  const conversationEdited = string(lifecycle?.["cloudig_edited_at"]);
  const libraryEdited = origin === "library" ? string(layer?.["edited_at"]) : undefined;
  const effectiveEditedAt = [conversationEdited, libraryEdited].filter((entry): entry is string => entry !== undefined).sort().at(-1);

  return {
    archive,
    platform,
    archiveLayer: origin,
    ...(conversationName === undefined ? {} : { conversationName }),
    models,
    userName,
    assistantName,
    userAvatar,
    assistantAvatar,
    contentTime,
    ...(effectiveEditedAt === undefined ? {} : { effectiveEditedAt })
  };
}

const USER_FIELDS = ["conversation_name", "models", "names", "content_time"] as const;

export function sparseArchiveUserValues(value: JsonObject | undefined): JsonObject {
  const result: JsonObject = {};
  if (!value) return result;
  for (const field of USER_FIELDS) {
    if (value[field] !== undefined) result[field] = structuredClone(value[field]!);
  }
  return result;
}

export function archiveUserValuesEqual(left: JsonObject | undefined, right: JsonObject | undefined): boolean {
  return canonicalizeJcs(sparseArchiveUserValues(left)) === canonicalizeJcs(sparseArchiveUserValues(right));
}

export function copyArchiveStateWithoutInventingEdit(value: JsonObject | undefined): JsonObject | undefined {
  if (!value) return undefined;
  const copy: JsonObject = {};
  for (const field of ["revision", "edited_at", ...USER_FIELDS] as const) {
    if (value[field] !== undefined) copy[field] = structuredClone(value[field]!);
  }
  return copy;
}
