import { parseChatGptWithDescriptor } from "./chatgpt.mjs";
import { finalizeGenericConversation } from "./common.mjs";

function genericAdapter(definition) {
  const adapter = {
    ...definition,
    profile: "full",
    parse(context) {
      return finalizeGenericConversation(context, adapter);
    }
  };
  return Object.freeze(adapter);
}

export const chatgptFullAdapter = Object.freeze({
  id: "chatgpt-full-v1",
  profile: "full",
  provider: "openai",
  platform: "chatgpt",
  payloadSchema: "osis.chatgpt.chat-export/full-v1",
  parse(context) {
    return parseChatGptWithDescriptor(context, chatgptFullAdapter);
  }
});

export const geminiFullAdapter = genericAdapter({
  id: "gemini-full-v1",
  provider: "google",
  platform: "gemini",
  payloadSchema: "osis.gemini.chat-export/full-v1"
});

export const grokFullAdapter = genericAdapter({
  id: "grok-full-v1",
  provider: "xai",
  platform: "grok",
  payloadSchema: "osis.grok.chat-export/full-v1"
});

export const deepseekFullAdapter = genericAdapter({
  id: "deepseek-full-v1",
  provider: "deepseek",
  platform: "deepseek",
  payloadSchema: "osis.deepseek.chat-export/full-v1"
});

export const doubaoFullAdapter = genericAdapter({
  id: "doubao-full-dom-v1",
  provider: "bytedance",
  platform: "doubao",
  payloadSchema: "osis.doubao.chat-export/full-dom-v1"
});

export const kimiFullAdapter = genericAdapter({
  id: "kimi-full-dom-v1",
  provider: "moonshot",
  platform: "kimi",
  defaultModel: "Kimi",
  payloadSchema: "osis.kimi.chat-export/full-dom-v1"
});

export const qwenFullAdapter = genericAdapter({
  id: "qwen-full-v1",
  provider: "alibaba",
  platform: "qwen",
  payloadSchema: "osis.qwen.chat-export/full-v1"
});

export const chatglmFullAdapter = genericAdapter({
  id: "chatglm-full-v1",
  provider: "zhipu",
  platform: "chatglm",
  payloadSchema: "osis.chatglm.chat-export/full-v1"
});

export const zaiFullAdapter = genericAdapter({
  id: "zai-full-v1",
  provider: "zhipu",
  platform: "zai",
  payloadSchema: "osis.zai.chat-export/full-v1"
});

export const yuanbaoFullAdapter = genericAdapter({
  id: "yuanbao-full-dom-v1",
  provider: "tencent",
  platform: "yuanbao",
  payloadSchema: "osis.yuanbao.chat-export/full-dom-v1"
});

export const mistralFullAdapter = genericAdapter({
  id: "mistral-full-v1",
  provider: "mistral",
  platform: "mistral",
  payloadSchema: "osis.mistral.chat-export/full-v1"
});

export const FULL_ADAPTERS = Object.freeze([
  chatgptFullAdapter,
  geminiFullAdapter,
  grokFullAdapter,
  deepseekFullAdapter,
  doubaoFullAdapter,
  kimiFullAdapter,
  qwenFullAdapter,
  chatglmFullAdapter,
  zaiFullAdapter,
  yuanbaoFullAdapter,
  mistralFullAdapter
]);
