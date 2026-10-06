import { finalizeGenericConversation } from "./common.mjs";

export const kimiAdapter = Object.freeze({
  id: "kimi-light-dom-v2",
  profile: "light",
  provider: "moonshot",
  platform: "kimi",
  defaultModel: "Kimi",
  payloadSchema: "osis.kimi.chat-export/light-dom-v2",
  parse(context) { return finalizeGenericConversation(context, kimiAdapter); }
});
