import { finalizeGenericConversation } from "./common.mjs";

export const qwenAdapter = Object.freeze({
  id: "qwen-light-messages-v2",
  profile: "light",
  provider: "alibaba",
  platform: "qwen",
  payloadSchema: "osis.qwen.chat-export/light-messages-v2",
  parse(context) { return finalizeGenericConversation(context, qwenAdapter); }
});
