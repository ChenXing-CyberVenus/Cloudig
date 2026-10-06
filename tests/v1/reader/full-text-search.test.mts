import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { searchConversationMessages, searchableHtmlText } from "../../../src/app/reader/full-text-search.mts";
import type { SearchCategory } from "../../../src/app/reader/content-selection.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { locateConversationMessage } from "../../../src/app/reader/message-location.mts";

const record = JSON.parse(await readFile(new URL("../records/fixtures/04-1.json", import.meta.url), "utf8")) as JsonObject;
const messages = (record["messages"] as JsonObject)["items"] as JsonObject[];
messages[0]!["content"] = [{ type: "html", html: "<p>用户 <b>发言</b> &amp; 第二行</p><script>HIDDEN_SCRIPT</script>" }];
messages[1]!["content"] = [{ type: "reasoning", text: "Only thinking needle" }, { type: "tool", content: [{ type: "text", text: "Only tool needle" }] }, { type: "markdown", text: "**Final** output" }, { type: "citations", references: ["r"] }];
messages.push({ id: "branch", parent: "m1", speaker: "assistant-1", content: [{ type: "markdown", text: "INACTIVE branch needle" }] });
record["references"] = [{ id: "r", title: "Reference needle", snippet: "Document evidence" }];
record["resources"] = [{ id: "blob", name: "attachment.pdf", data_base64: ["RESOURCE_BYTES_NEVER_SEARCH"] }];
const hits = (query: string, categories?: readonly SearchCategory[]) => [...searchConversationMessages(record, { query, ...(categories ? { categories } : {}) })];

test("search visits noncurrent branches without altering the source current pointer", () => {
  const before = structuredClone(record); assert.equal(hits("inactive")[0]?.message, "branch"); assert.deepEqual(record, before);
});
test("default user + assistant search excludes reasoning, nested tools and reference text", () => {
  assert.equal(hits("Final output").length, 1); assert.equal(hits("用户 发言 & 第二行").length, 1);
  for (const query of ["thinking", "tool needle", "Reference needle"]) { assert.equal(hits(query).length, 0); assert.equal(hits(query, ["process"]).length, 1); }
  assert.equal(hits("Final", ["process"]).length, 0); assert.equal(hits("用户", ["assistant"]).length, 0);
});
test("multiple matching process blocks share one message result; all categories may be unchecked", () => {
  assert.equal(hits("needle", ["process"]).length, 1); assert.equal(hits("needle", []).length, 0);
});
test("search ignores resource bytes, scripts, hidden layout and structural IDs", () => {
  for (const query of ["RESOURCE_BYTES_NEVER_SEARCH", "HIDDEN_SCRIPT", "assistant-1"]) assert.equal(hits(query, ["user", "assistant", "process"]).length, 0);
  assert.equal(searchableHtmlText('<div>One<span> word</span><br>Two<img alt="Picture"><span hidden>SECRET</span></div>'), "One word\nTwoPicture");
});
test("NFKC and case matching leaves the original excerpt readable; no regex interpretation", () => {
  const c: JsonObject = { messages: [{ id: "u", role: "user", content: [{ type: "text", text: "Ｈｅｌｌｏ [a+b] ﬃ X" }] }] };
  const find = (query: string) => [...searchConversationMessages(c, { query })];
  assert.equal(find("hello").length, 1); assert.equal(find("[a+b]").length, 1); assert.equal(find("ffi").length, 1);
  assert.match(find("X")[0]!.excerpt, /Ｈｅｌｌｏ/); assert.equal(find(".*").length, 0);
});
test("empty/overlong queries, malformed categories and cancellation are explicit", () => {
  assert.throws(() => hits(" ")); assert.throws(() => hits("x".repeat(257)));
  assert.throws(() => hits("x", ["assistant", "assistant"]));
  const controller = new AbortController(); controller.abort();
  assert.throws(() => [...searchConversationMessages(record, { query: "x", signal: controller.signal })], { name: "AbortError" });
});

test("a hit in an alternate branch resolves its true path and descendants without reconnecting orphan fragments", () => {
  const c: JsonObject = { current_message: "other", messages: [
    { id: "root", content: [] }, { id: "other", parent: "root" }, { id: "hit", parent: "root" }, { id: "descendant", parent: "hit" }, { id: "orphan", parent: "missing" }
  ] }, before = structuredClone(c);
  assert.deepEqual(locateConversationMessage(c, "hit"), { selectedLeaf: "descendant", sourceIndex: 2, pathIndex: 1, visibleIndex: 0, anchor: "message-3" });
  assert.equal(locateConversationMessage(c, "orphan").selectedLeaf, "orphan");
  assert.deepEqual(c, before); assert.throws(() => locateConversationMessage(c, "gone"), /no longer exists/);
});
