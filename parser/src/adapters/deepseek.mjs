import { finalizeGenericConversation } from "./common.mjs";

export const deepseekAdapter = Object.freeze({
  id: "deepseek-light-messages-v2",
  profile: "light",
  provider: "deepseek",
  platform: "deepseek",
  payloadSchema: "osis.deepseek.chat-export/light-messages-v2",
  parse(context) { return finalizeGenericConversation(context, deepseekAdapter); }
});
