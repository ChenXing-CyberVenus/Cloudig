import type { JsonObject, JsonValue } from "../contracts/types.mts";
import type { BuiltinIdentity } from "../library/overlay.mts";
import { frontName, findPlatformFront, isAgentInstanceSourceId } from "./front.mts";

const object = (v: JsonValue | undefined): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length ? v : undefined;
export type RecordPresentation = Readonly<{
  conversationName: string; platform: string; models: readonly string[];
  userName: string; assistantName: string; userAvatar: string; assistantAvatar: string;
  contentTime: Readonly<{ state: "set" | "unavailable"; range?: JsonValue }>;
  effectiveEditedAt: string;
}>;

const AGENT_INSTANCE_NAME = "其他 Agent 实例";
const AGENT_INSTANCE_AVATAR = "Assets/Platforms/agent-instance.svg";

export function resolveRecordPresentation(input: Readonly<{
  conversation: JsonObject; mark?: JsonObject; language: "zh-CN" | "en";
  bindings: JsonObject; identities: ReadonlyMap<string, JsonObject>; builtins: BuiltinIdentity; availableAssets: ReadonlySet<string>;
}>): RecordPresentation {
  const { conversation, mark, bindings, identities, builtins, availableAssets } = input;
  if (mark && mark["target"] !== conversation["conversation_id"]) throw new TypeError("Mark belongs to another Conversation");
  const platform = String(conversation["platform"]), defaults = Object.hasOwn(builtins.platforms, platform) ? builtins.platforms[platform]! : builtins.assistant;
  const sourceDefault = findPlatformFront(platform), title = object(conversation["title"]), names = object(mark?.["names"]);
  const user = identities.get(String(bindings["subject"])), assistant = identities.get(String(bindings["assistant"]));
  const platformIdentity = identities.get(String(object(bindings["platforms"])[platform]));
  const localDefaultName = (p: typeof defaults): string => p.localizedNames?.[input.language] ?? p.name;
  const avatar = (f: JsonObject | undefined): string | undefined => {
    const image = text(f?.["image"]); return image && availableAssets.has(image) ? image : undefined;
  };
  const assistantOrder = bindings["apply_assistant_to_all"] === true ? [assistant] : [platformIdentity, assistant];
  const models = mark && Object.hasOwn(mark, "models")
    ? (mark["models"] as JsonObject[]).length ? (mark["models"] as JsonObject[]).map(f => frontName(f)!) : [frontName(sourceDefault) ?? localDefaultName(builtins.assistant)]
    : [...new Set([...(conversation["models"] ?? []) as string[], ...(conversation["identity"] as JsonObject[]).filter(f => f["role"] === "assistant").map(frontName).filter((n): n is string => Boolean(n))])];
  const sourceEdit = String(object(conversation["lifecycle"])["cloudig_edited_at"]), markEdit = text(mark?.["edited_at"]);
  return {
    conversationName: text(mark?.["conversation_title"]) ?? text(title["filename"]) ?? text(title["original"]) ?? (input.language === "en" ? "Untitled conversation" : "未命名会话"),
    platform, models,
    userName: text(names["user"]) ?? frontName(user) ?? localDefaultName(builtins.user),
    assistantName: text(names["assistant"]) ?? assistantOrder.map(frontName).find(Boolean) ?? localDefaultName(defaults),
    userAvatar: avatar(user) ?? builtins.user.avatar,
    assistantAvatar: assistantOrder.map(avatar).find(Boolean) ?? defaults.avatar,
    contentTime: mark?.["content_time"] ? { state: "set", range: object(mark["content_time"])["range"]! } : { state: "unavailable" },
    effectiveEditedAt: markEdit && Date.parse(markEdit) > Date.parse(sourceEdit) ? markEdit : sourceEdit
  };
}

/** Transient Reader/Markdown input. Never serialized back as Conversation. */
export function projectRecordForReading(conversation: JsonObject, resolved: RecordPresentation, mark?: JsonObject, options?: Readonly<{ resolveAgentAvatar?: (reference: string) => string }>): JsonObject {
  const fronts = new Map((conversation["identity"] as JsonObject[]).map(f => [String(f["source_id"]), f]));
  // The current one-user editor is not authority to rename every member of a group chat.
  const userOverride = [...fronts.values()].filter(f => f["role"] === "user").length === 1 ? text(object(mark?.["names"])["user"]) : undefined;
  const assistantOverride = text(object(mark?.["names"])["assistant"]);
  const blocks = (list: JsonObject[], inherited: string | undefined): JsonObject[] => list.map(raw => {
    const b = { ...raw }, speaker = text(b["speaker"]) ?? inherited;
    const front = fronts.get(speaker ?? "");
    // Reading-only attribution. Keep source messages/parents intact while
    // allowing a system block inside a human message to stand on its own.
    if (front?.["role"] === "system") b["party"] = { role: "system", ...(frontName(front) ? { name: frontName(front)! } : {}) };
    if (Array.isArray(b["content"])) b["content"] = blocks(b["content"] as JsonObject[], speaker);
    if (b["references"] !== undefined) { b["sources"] = b["references"]!; delete b["references"]; }
    if (b["type"] === "tool") {
      const tool = b["kind"] === "result" ? speaker : text(b["recipient"]);
      const name = frontName(fronts.get(tool ?? "")); if (name) b["name"] = name;
    }
    return b;
  });
  const tree = object(conversation["messages"]);
  const messages = (tree["items"] as JsonObject[]).map(message => {
    const sourceId = text(message["speaker"]), front = fronts.get(sourceId ?? ""), role = text(front?.["role"]) ?? "system", name = frontName(front);
    const agentInstance = role === "assistant" && isAgentInstanceSourceId(sourceId);
    const party: JsonObject = role === "user" ? { role, name: userOverride ?? name ?? resolved.userName, avatar: resolved.userAvatar }
      : role === "assistant" ? { role, name: agentInstance ? name ?? AGENT_INSTANCE_NAME : assistantOverride ?? name ?? resolved.assistantName, avatar: agentInstance ? options?.resolveAgentAvatar?.(AGENT_INSTANCE_AVATAR) ?? AGENT_INSTANCE_AVATAR : resolved.assistantAvatar, ...(agentInstance ? { avatar_variant: "agent-instance" } : {}) }
        : { role, ...(name ? { name } : {}) };
    return { ...message, role, ...(name ? { name } : {}), party,
      ...(role === "assistant" && name && (!mark || !Object.hasOwn(mark, "models")) ? { model: name } : {}),
      content: blocks(message["content"] as JsonObject[], sourceId) };
  });
  return { conversation_id: conversation["conversation_id"]!, platform: conversation["platform"]!, source: conversation["source"]!,
    title: resolved.conversationName, messages, ...(tree["current"] ? { current_message: tree["current"]! } : {}),
    ...(conversation["resources"] ? { resources: conversation["resources"]! } : {}), ...(conversation["references"] ? { sources: conversation["references"]! } : {}) };
}
