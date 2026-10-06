import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildConversationMarkdown } from "../../../src/app/export/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

test('saved DIL Markdown exposes the label and saved time, not callback source', async () => {
  const conversation = JSON.parse(await readFile(new URL('../contracts/fixtures/conversation-full.json', import.meta.url), 'utf8')) as JsonObject;
  const messages = conversation['messages'] as JsonObject[];
  messages[1]!['content'] = [{ type: 'unknown', kind: 'chatgpt-dil', text: JSON.stringify({ name: 'clock_widget', dil: { initialState: { time_label: '15:14', location: 'Beijing', tz_offset_minutes: 480 }, $onTickAction: 'must not appear' } }) }];
  const result = buildConversationMarkdown({ conversation, selectedLeaf: 'm2', locale: 'en', resolved: { archive: 'a2', platform: 'chatgpt', archiveLayer: 'none', models: [], userName: 'User', assistantName: 'AI', userAvatar: '', assistantAvatar: '', contentTime: { state: 'unavailable' } } });
  const output = result.parts.filter(p => typeof p === 'string').join('');
  assert(output.includes('15:14 · Beijing · UTC+08:00')); assert(!output.includes('must not appear'));
});

test("Markdown export freezes the selected branch and keeps process, source, resource and unknown fallbacks readable", async () => {
  const conversation = JSON.parse(await readFile(new URL("../contracts/fixtures/conversation-full.json", import.meta.url), "utf8")) as JsonObject;
  const messages = conversation["messages"] as JsonObject[];
  (messages[1]!["content"] as JsonObject[]).push({ type: "unknown", kind: "future-block", text: "Future visible text" });
  const plan = buildConversationMarkdown({
    conversation,
    resolved: {
      archive: "a2",
      platform: "chatgpt",
      archiveLayer: "library",
      conversationName: "老婆设定的标题",
      models: ["GPT-5.6-Sol"],
      userName: "晨星",
      assistantName: "奥思",
      userAvatar: "Assets/Defaults/user.svg",
      assistantAvatar: "Assets/Platforms/chatgpt.svg",
      contentTime: {
        state: "set",
        range: (conversation["content_time"] as JsonObject)["range"]!
      }
    },
    locale: "zh-CN",
    selectedLeaf: "m2"
  });
  assert.equal(plan.selectedLeaf, "m2");
  assert.equal(plan.messageCount, 2);
  const visible = plan.parts.filter((part): part is string => typeof part === "string").join("");
  assert.match(visible, /^# 老婆设定的标题$/mu);
  assert.match(visible, /^## 晨星 · 2026-08-30T09:00:00\.000Z$/mu);
  assert.match(visible, /^## 奥思 · 2026-08-31T10:00:00\.000Z · GPT-5\.6-Sol$/mu);
  assert.match(visible, /<summary>思考<\/summary>/u);
  assert.match(visible, /工具调用 · document/u);
  assert.match(visible, /工具结果/u);
  assert.match(visible, /~~~mermaid\ngraph TD; A-->B\n~~~/u);
  assert.match(visible, /Cloudig.*https:\/\/example\.com/u);
  assert.match(visible, /report\.pdf · 仅元数据/u);
  assert.match(visible, /未知内容 · future-block/u);
  assert.doesNotMatch(visible, /OtherAgent/u);
  assert.deepEqual(
    plan.parts.filter((part) => typeof part !== "string").map((part) => part.resource),
    ["r1"]
  );
});

test("Markdown export rejects a branch capability that is not in the archive", async () => {
  const conversation = JSON.parse(await readFile(new URL("../contracts/fixtures/conversation-full.json", import.meta.url), "utf8")) as JsonObject;
  assert.throws(() => buildConversationMarkdown({
    conversation,
    resolved: {
      archive: "a2",
      platform: "chatgpt",
      archiveLayer: "none",
      models: [],
      userName: "User",
      assistantName: "AI",
      userAvatar: "Assets/Defaults/user.svg",
      assistantAvatar: "Assets/Defaults/assistant.svg",
      contentTime: { state: "unavailable" }
    },
    locale: "en",
    selectedLeaf: "m404"
  }), /not present/iu);
});
