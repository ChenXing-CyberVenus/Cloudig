import { finalizeGenericConversation } from "./common.mjs";

export const geminiAdapter = Object.freeze({
  id: "gemini-light-dom-v2",
  profile: "light",
  provider: "google",
  platform: "gemini",
  payloadSchema: "osis.gemini.chat-export/light-dom-v2",
  parse(context) { return finalizeGenericConversation(context, geminiAdapter); }
});
