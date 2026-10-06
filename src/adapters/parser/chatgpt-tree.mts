import type { AdapterManifest, SourceAdapter } from "../../app/parser/adapter.mts";
import { parseChatGptTree } from "./chatgpt-light.mts";

export const CHATGPT_TREE_MANIFEST: AdapterManifest = {
  id: "chatgpt-all-branches-v1",
  version: "3.0.4",
  family: "chatgpt",
  routes: [{
    format: "exporter-html",
    platform: "chatgpt",
    payload: "osis.chatgpt.chat-export/all-branches-v1",
    profile: "tree"
  }],
  target: "cloudig/conversation/1.0.0",
  update_from: [{
    adapter: "chatgpt-all-branches-v1",
    version: "1.3.0",
    action: "reparse_source"
  }, ...["2.0.0", "2.0.1", "3.0.0", "3.0.1", "3.0.2", "3.0.3"].map(version => ({ adapter: "chatgpt-all-branches-v1", version, action: "reparse_source" as const }))]
};

export const chatGptTreeAdapter: SourceAdapter = Object.freeze({
  manifest: CHATGPT_TREE_MANIFEST,
  parse: (context) => parseChatGptTree(context, {
    payload: "osis.chatgpt.chat-export/all-branches-v1",
    profile: "tree"
  })
});
