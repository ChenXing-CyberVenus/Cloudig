import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { yuanbaoLightAdapter, yuanbaoFullAdapter } from "../../../src/adapters/parser/yuanbao.mts";
import { extractHtmlRecord } from "../../../src/app/parser/record-source.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import { PARSER_VERSION } from "../../../src/app/parser/registry.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const processed = '<details class="osis-process-group"><summary>已思考2次</summary><div><p>First paragraph.</p><details class="osis-process-group"><summary>已完成思考</summary><div><p>Second paragraph.</p><a href="https://example.com/source">Source</a><math><mi>x</mi></math><pre><code>print(1)\nprint(2)</code></pre></div></details></div></details>';
for (const adapter of [yuanbaoLightAdapter, yuanbaoFullAdapter]) {
  test(`${adapter.manifest.id} keeps old thinking and nested processed groups separate from the final answer`, async () => {
    const messages = [
      { id: "old", role: "assistant", public_reasoning_label: "深度思考", public_reasoning_html: "<p>Legacy first.</p><p>Legacy second.</p>" },
      { id: "new", role: "assistant", public_reasoning_label: "已处理", public_reasoning_html: processed }
    ];
    const draft = await adapter.parse({ source: { file: "source.html", bytes: 1, sha256: "1".repeat(64) }, manifest: {},
      payload: { messages, message_order: ["old", "new"] }, reading: { images: [], files: [], mermaid: [], fragments: messages.map(m => ({ messageId: m.id,
        html: `<div class="osis-message"><details class="osis-thinking"><summary>${m.public_reasoning_label}</summary>${m.public_reasoning_html}</details><div class="osis-rich"><p>Final ${m.id}.</p></div></div>` })) } });
    for (const [i, message] of (draft["messages"] as JsonObject[]).entries()) {
      const blocks = message["content"] as JsonObject[];
      assert.equal(blocks.filter(b => b["type"] === "reasoning").length, 1);
      const thought = blocks[0]!; assert.equal(thought["title"], messages[i]!.public_reasoning_label); assert.equal(thought["format"], "html");
      const dom = new JSDOM(String(thought["text"])), body = new JSDOM(blocks.slice(1).map(b => b["html"] ?? "").join(""));
      try {
        assert.equal(body.window.document.body.textContent, `Final ${messages[i]!.id}.`);
        const groups = [...dom.window.document.querySelectorAll("details")];
        assert.equal(groups.length, i === 0 ? 0 : 2); assert(groups.every(g => !g.open));
        if (i === 1) {
          assert(groups[0]!.contains(groups[1]!));
          assert.deepEqual(groups.map(g => g.querySelector(":scope > summary")!.textContent), ["已思考2次", "已完成思考"]);
          assert.equal(dom.window.document.querySelector("code")!.textContent, "print(1)\nprint(2)");
          assert.equal(dom.window.document.querySelectorAll("math").length, 1);
          assert.equal(dom.window.document.querySelector("a")!.href, "https://example.com/source");
        }
      } finally { dom.window.close(); body.window.close(); }
    }
  });
}

const sample = process.env["CLOUDIG_RECORD_SAMPLE"];
test("latest Yuanbao source preserves every old/new public reasoning group, paragraph and formula in the record", { skip: !sample }, async () => {
  let checked = 0, thoughts = 0, processedCount = 0;
  for (const file of await readdir(sample!)) {
    if (!file.endsWith(".html")) continue;
    const filePath = path.join(sample!, file), source = await readFile(filePath, "utf8");
    if (!source.includes('id="yuanbao-export-data"')) continue;
    const dom = new JSDOM(source);
    try {
      const payload = JSON.parse(dom.window.document.querySelector("#yuanbao-export-data")!.textContent!) as JsonObject;
      const extracted = await extractHtmlRecord({ filePath, temporaryRoot: path.resolve("tests/private/schema-rebuild") });
      const record = assembleConversationRecord({ ...extracted, parserVersion: PARSER_VERSION, timestamp: "2026-09-19T00:00:00Z" });
      const records = (record["messages"] as JsonObject)["items"] as JsonObject[];
      assert.equal(records.length, (payload["messages"] as JsonObject[]).length);
      for (const message of payload["messages"] as JsonObject[]) {
        if (!message["public_reasoning_html"]) continue;
        const item = records.find(m => m["id"] === message["id"])!;
        const blocks = item["content"] as JsonObject[], reasoning = blocks.filter(b => b["type"] === "reasoning");
        assert.equal(reasoning.length, 1); assert.equal(reasoning[0]!["title"], message["public_reasoning_label"]);
        const original = new JSDOM(String(message["public_reasoning_html"])), parsed = new JSDOM(String(reasoning[0]!["text"]));
        try {
          assert.equal(parsed.window.document.body.textContent, original.window.document.body.textContent);
          for (const selector of ["details", "summary", "p", "br", "pre", "a", "math"]) assert.equal(parsed.window.document.querySelectorAll(selector).length, original.window.document.querySelectorAll(selector).length, selector);
          const groups = [...parsed.window.document.querySelectorAll("details")]; assert(groups.every(d => !d.open));
          if (message["public_reasoning_label"] === "已处理") { assert(groups.length >= 2); processedCount++; }
          thoughts++;
        } finally { original.window.close(); parsed.window.close(); }
      }
      checked++;
    } finally { dom.window.close(); }
  }
  assert.equal(checked, 2); assert(processedCount >= 2);
  console.log(JSON.stringify({ yuanbao_files: checked, reasoning: thoughts, processed: processedCount }));
});
