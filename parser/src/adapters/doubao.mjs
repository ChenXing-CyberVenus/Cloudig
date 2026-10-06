import { finalizeGenericConversation } from "./common.mjs";

export const doubaoAdapter = Object.freeze({
  id: "doubao-light-dom-v2",
  profile: "light",
  provider: "bytedance",
  platform: "doubao",
  payloadSchema: "osis.doubao.chat-export/light-dom-v2",
  parse(context) { return finalizeGenericConversation(context, doubaoAdapter); }
});
