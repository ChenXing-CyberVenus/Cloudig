import { finalizeGenericConversation } from "./common.mjs";

export const mistralAdapter = Object.freeze({
  id: "mistral-light-dom-rsc-v2",
  profile: "light",
  provider: "mistral",
  platform: "mistral",
  payloadSchema: "osis.mistral.chat-export/light-dom-rsc-v2",
  parse(context) { return finalizeGenericConversation(context, mistralAdapter); }
});
