import type { AdapterManifest, SourceAdapter } from "../../app/parser/adapter.mts";
import { parseChatGptItems } from "./chatgpt-light.mts";

export const CHATGPT_FULL_MANIFEST: AdapterManifest = {
  id: "chatgpt-full-v1",
  version: "3.0.4",
  family: "chatgpt",
  routes: [{
    format: "exporter-html",
    platform: "chatgpt",
    payload: "osis.chatgpt.chat-export/full-v1",
    profile: "full"
  }],
  target: "cloudig/conversation/1.0.0",
  update_from: [{
    adapter: "chatgpt-full-v1",
    version: "1.3.0",
    action: "reparse_source"
  }, ...["2.0.0", "2.0.1", "3.0.0", "3.0.1", "3.0.2", "3.0.3"].map(version => ({ adapter: "chatgpt-full-v1", version, action: "reparse_source" as const }))]
};

export const chatGptFullAdapter: SourceAdapter = Object.freeze({
  manifest: CHATGPT_FULL_MANIFEST,
  parse: (context) => parseChatGptItems(context, {
    payload: "osis.chatgpt.chat-export/full-v1",
    profile: "full"
  })
});
