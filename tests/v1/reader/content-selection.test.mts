import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationMarkdown } from "../../../src/app/export/markdown.mts";
import { blockCategory, messageContentCategory, selectedMessageBlocks } from "../../../src/app/reader/content-selection.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const resolved = { platform: "claude", conversationName: "Branches", models: [], userName: "U", assistantName: "A", userAvatar: "u", assistantAvatar: "a", effectiveEditedAt: "2026-09-26T00:00:00Z", contentTime: { state: "unavailable" as const } };
const conversation: JsonObject = { conversation_id: "local-test", messages: [
  { id: "u", role: "user", content: [{ type: "text", text: "User body" }] },
  { id: "a", parent: "u", role: "assistant", content: [{ type: "reasoning", text: "Private process" }, { type: "tool", name: "read", content: [{ type: "text", text: "Tool output" }] }, { type: "markdown", text: "Final answer" }, { type: "citations", sources: ["s"] }] },
  { id: "other", parent: "u", role: "assistant", content: [{ type: "markdown", text: "Other branch" }] },
  { id: "t", parent: "a", role: "tool", content: [{ type: "text", text: "Standalone tool" }] }
], sources: [{ id: "s", title: "Reference", snippet: "Reference evidence" }], resources: [] };
const output = (overrides: Parameters<typeof buildConversationMarkdown>[0] extends infer T ? Partial<T> : never = {}) => buildConversationMarkdown({ conversation, resolved, locale: "en", selectedLeaf: "t", ...overrides });
const visible = (plan: ReturnType<typeof output>) => plan.parts.filter(p => typeof p === "string").join("");

test("navigation/search/export share process categories, including assistant reasoning and standalone tools", () => {
  for (const type of ["reasoning", "reasoning_summary", "status", "tool", "search", "citations"]) {
    assert.notEqual(blockCategory({ type }), "content"); assert.equal(messageContentCategory("assistant", { type }), "process");
  }
  assert.equal(messageContentCategory("assistant", { type: "markdown" }), "assistant");
  assert.equal(messageContentCategory("user", { type: "html" }), "user");
  assert.equal(messageContentCategory("tool", { type: "text" }), "process");
});
test("body export keeps current path and excludes all process blocks and standalone process messages", () => {
  const before = structuredClone(conversation), plan = output({ contentMode: "body" });
  assert.equal(plan.messageCount, 2); assert.match(visible(plan), /User body/); assert.match(visible(plan), /Final answer/);
  assert.doesNotMatch(visible(plan), /Private process|Tool output|Standalone tool|Reference evidence|Other branch/);
  assert.deepEqual(conversation, before);
});
test("include-process export retains reasoning, sources and tools but never adds an undisplayed branch", () => {
  const plan = output({ contentMode: "with_process" }); assert.equal(plan.messageCount, 3);
  for (const text of ["Private process", "Tool output", "Standalone tool", "Reference evidence"]) assert(visible(plan).includes(text));
  assert(!visible(plan).includes("Other branch"));
});
test("partial Markdown uses current-path order, not click order, and single copy omits document metadata", () => {
  const plan = output({ contentMode: "body", messageIds: ["a", "u"], includeHeader: false });
  assert.equal(plan.messageCount, 2); assert(visible(plan).indexOf("User body") < visible(plan).indexOf("Final answer"));
  assert.doesNotMatch(visible(plan), /# Branches|Cloudig Markdown export|\*\*Platform\*\*/);
  const single = output({ contentMode: "body", messageIds: ["a"], includeHeader: false });
  assert.equal(single.messageCount, 1); assert.doesNotMatch(visible(single), /User body/);
});
test("stale, duplicate and off-branch partial selections fail instead of silently changing exported scope", () => {
  for (const ids of [[], ["a", "a"], ["missing"], ["other"]]) assert.throws(() => output({ messageIds: ids }), /selection|displayed branch/);
});
test("unknown body containers keep their structure while nested process stays excluded", () => {
  const message: JsonObject = { role: "assistant", content: [{ type: "unknown", kind: "future", text: "Body", content: [{ type: "tool", content: [{ type: "text", text: "Not body" }] }, { type: "markdown", text: "Child body" }] }] };
  const selected = selectedMessageBlocks(message, "body"); assert.equal((selected[0]!["content"] as JsonObject[]).length, 1);
  assert.equal(((message["content"] as JsonObject[])[0]!["content"] as JsonObject[]).length, 2);
});
