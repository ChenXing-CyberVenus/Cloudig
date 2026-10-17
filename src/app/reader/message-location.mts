import { isJsonObject, type JsonObject } from "../../core/contracts/types.mts";
import { conversationMessagePath } from "./view-model-core.mts";

/** Resolve a search hit using real parent edges. No date inference or source mutation. */
export function locateConversationMessage(conversation: JsonObject, messageId: string): Readonly<{ selectedLeaf: string; sourceIndex: number; pathIndex: number; visibleIndex: number; anchor: string }> {
  const messages = (Array.isArray(conversation["messages"]) ? conversation["messages"] : []).filter(isJsonObject);
  const sourceIndex = messages.findIndex(message => message["id"] === messageId);
  if (sourceIndex < 0) throw new TypeError("Search message no longer exists; search again");
  const lastChildren = new Map<string, string>();
  for (const message of messages) if (typeof message["parent"] === "string" && typeof message["id"] === "string") lastChildren.set(message["parent"], message["id"]);
  let selectedLeaf = messageId; const visited = new Set<string>();
  while (lastChildren.has(selectedLeaf)) {
    if (visited.has(selectedLeaf)) throw new TypeError("Conversation message cycle");
    visited.add(selectedLeaf); selectedLeaf = lastChildren.get(selectedLeaf)!;
  }
  const path = conversationMessagePath(conversation, selectedLeaf), pathIndex = path.path.indexOf(sourceIndex);
  if (pathIndex < 0) throw new TypeError("Search message is not reachable by its source parent path");
  const visibleIndex = path.path.slice(0, pathIndex).filter(index => Array.isArray(messages[index]!["content"]) && (messages[index]!["content"] as unknown[]).length > 0).length;
  return { selectedLeaf, sourceIndex, pathIndex, visibleIndex, anchor: `message-${sourceIndex + 1}` };
}
