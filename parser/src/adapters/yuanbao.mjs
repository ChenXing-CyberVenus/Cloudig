import { finalizeGenericConversation } from "./common.mjs";

export const yuanbaoAdapter = Object.freeze({
  id: "yuanbao-light-dom-v2",
  profile: "light",
  provider: "tencent",
  platform: "yuanbao",
  payloadSchema: "osis.yuanbao.chat-export/light-dom-v2",
  parse(context) { return finalizeGenericConversation(context, yuanbaoAdapter); }
});
