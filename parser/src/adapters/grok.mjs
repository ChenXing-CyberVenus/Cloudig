import { finalizeGenericConversation } from "./common.mjs";

export const grokAdapter = Object.freeze({
  id: "grok-light-dom-v2",
  profile: "light",
  provider: "xai",
  platform: "grok",
  payloadSchema: "osis.grok.chat-export/light-dom-v2",
  parse(context) { return finalizeGenericConversation(context, grokAdapter); }
});
