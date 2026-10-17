import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { chatGlmLightAdapter, chatGlmFullAdapter } from "../../../src/adapters/parser/chatglm.mts";
import { yuanbaoLightAdapter, yuanbaoFullAdapter } from "../../../src/adapters/parser/yuanbao.mts";
import { zaiLightAdapter, zaiFullAdapter, zaiTreeAdapter } from "../../../src/adapters/parser/zai.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { capturedReferences } from "../../../src/adapters/parser/captured-references.mts";
import { kimiLightAdapter } from "../../../src/adapters/parser/kimi.mts";
import { grokLightAdapter } from "../../../src/adapters/parser/grok.mts";

test("captured reference recovery is limited to the named search/image slots", async () => {
  const search = '<details class="osis-search"><ol><li><a class="osis-search-result-title" href="https://example.com/source">Title</a><div class="osis-search-result-meta">Site · ref-1</div><p>First\nSecond</p></li></ol></details>';
  assert.deepEqual(capturedReferences(search + '<a href="https://example.com/body">Body</a>', "kimi-search"), [{ url: "https://example.com/source", title: "Title", hostname: "Site · ref-1", snippet: "First\nSecond" }]);
  const context = { manifest: {}, payload: { messages: [{ id: "m", role: "assistant", public_processes: [], sources: [] }], message_order: ["m"] }, source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) }, reading: { images: [], files: [], mermaid: [], fragments: [{ messageId: "m", html: search + '<div class="rich-content"><p>Answer</p></div>' }] } };
  const kimi = await kimiLightAdapter.parse(context);
  assert.equal((kimi["sources"] as JsonObject[])[0]!["snippet"], "First\nSecond");
  assert.ok(((kimi["messages"] as JsonObject[])[0]!["content"] as JsonObject[]).some(b => b["type"] === "citations"));
  const grok = await grokLightAdapter.parse({ ...context, payload: { messages: [{ id: "m", source_id: "m", role: "assistant", raw_message: "Answer" }] }, reading: { ...context.reading, fragments: [{ messageId: "m", html: '<div class="assistant-content">Answer</div><div class="image-source-link"><a href="https://example.com/image-page">Image source</a></div>' }] } });
  assert.equal((grok["sources"] as JsonObject[])[0]!["url"], "https://example.com/image-page");
});

for (const adapter of [chatGlmLightAdapter, chatGlmFullAdapter, yuanbaoLightAdapter, yuanbaoFullAdapter]) {
  test(`${adapter.manifest.id} removes only the exported outer model label`, async () => {
    const shell = adapter.manifest.family === "chatglm" ? "message-shell" : "osis-message";
    const draft = await adapter.parse({ manifest: {}, payload: { messages: [{ id: "m", role: "assistant", model: "Exact model" }], message_order: ["m"] },
      source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) }, reading: { images: [], files: [], mermaid: [], fragments: [{ messageId: "m",
        html: `<div class="${shell}"><div class="assistant-model">Outer model label</div><div class="message-content"><p>Actual answer.</p><span class="assistant-model">Authored model name</span></div></div>` }] } });
    const blocks = ((draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]);
    const dom = new JSDOM(blocks.map(b => b["html"] ?? "").join(""));
    try { assert.equal(dom.window.document.body.textContent, "Actual answer.Authored model name"); }
    finally { dom.window.close(); }
  });
}

for (const adapter of [zaiLightAdapter, zaiFullAdapter, zaiTreeAdapter]) {
  test(`${adapter.manifest.id} keeps user raw newlines instead of flattened captured HTML`, async () => {
    const original = "First line\nSecond line\n\nNext paragraph";
    const draft = await adapter.parse({ manifest: {}, payload: { messages: [{ id: "m", role: "user", content_markdown: original }], message_order: ["m"], current_leaf_message_id: "m" },
      source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) }, reading: { images: [], files: [], mermaid: [], fragments: [{ messageId: "m", html: `<div class="message-content">${original}</div>` }] } });
    const blocks = (draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
    assert.deepEqual(blocks.map(b => b["type"]), ["markdown"]);
    assert.equal(blocks[0]!["text"], original);
  });
}
test("Grok source tool cards become ordered folded activities without losing XML arguments or returned API records", async () => {
  const card = { toolUsageCardId: "c1", readFile: { path: "source.txt", extra: 1 } };
  const returned = { toolUsageCardId: "c1", readFile: { text: "First\nSecond" } };
  const args = '{"file_path":"source.txt","limit":null}';
  const raw = `Before\n<xai:tool_usage_card><xai:tool_usage_card_id>c1</xai:tool_usage_card_id><xai:tool_name>read_file</xai:tool_name><xai:tool_args><![CDATA[${args}]]></xai:tool_args></xai:tool_usage_card>\nAfter`;
  const draft = await grokLightAdapter.parse({ manifest: {}, source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) },
    payload: { messages: [{ response_id: "m", role: "assistant", raw_message: "Final" }], raw_api: { responses: [{ responseId: "m", steps: [{ text: [raw], toolUsageCards: [card], toolUsageResults: [returned] }] }] } } });
  const blocks = (draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
  assert.deepEqual(blocks.slice(0, 3).map(b => b["type"]), ["reasoning", "tool", "reasoning"]);
  assert.equal(blocks[0]!["text"], "Before"); assert.equal(blocks[2]!["text"], "After");
  assert.equal(blocks[1]!["name"], "read_file"); assert.equal(blocks[1]!["input"], args);
  assert.deepEqual(blocks[1]!["output"], [returned, card]);
  assert.equal(blocks.filter(b => b["type"] === "tool").length, 1);
});
