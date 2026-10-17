import { finalizeGenericConversation } from "./common.mjs";

export const chatglmAdapter = Object.freeze({
  id: "chatglm-light-messages-v2",
  profile: "light",
  provider: "zhipu",
  platform: "chatglm",
  payloadSchema: "osis.chatglm.chat-export/light-messages-v2",
  parse(context) { return finalizeGenericConversation(context, chatglmAdapter); }
});
