import { finalizeGenericConversation } from "./common.mjs";

export const zaiAdapter = Object.freeze({
  id: "zai-light-messages-v2",
  profile: "light",
  provider: "zhipu",
  platform: "zai",
  payloadSchema: "osis.zai.chat-export/light-messages-v2",
  parse(context) { return finalizeGenericConversation(context, zaiAdapter); }
});
