import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { AdapterParseContext } from "../../../src/app/parser/adapter.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { grokLightAdapter, grokFullAdapter, grokTreeAdapter } from "../../../src/adapters/parser/grok.mts";
import { qwenLightAdapter, qwenFullAdapter, qwenTreeAdapter } from "../../../src/adapters/parser/qwen.mts";
import { capturedPanelWithMermaid } from "../../../src/adapters/parser/inert-html.mts";

const diagramSource = "flowchart TD\nA --> B";
const diagramData = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><text>fixture</text></svg>')}`;
const code = "const x =  1;\n  run(x);";
const body = `<div><h3>Custom card</h3><div style="background:#1a1a2e;color:#eee;padding:16px;border-radius:12px"><p>Kept content</p></div>
<pre data-language="javascript"><code>${code}</code></pre>
<blockquote><ol start="4"><li>Nested table<table><tbody><tr><td style="text-align:center">left</td><td rowspan="2">right</td></tr><tr><td>next</td></tr></tbody></table></li></ol></blockquote>
<section class="osis-mermaid-card"><div class="osis-mermaid-panel"><svg xmlns="http://www.w3.org/2000/svg"><text>fixture</text></svg></div><pre data-osis-mermaid-panel="source" data-language="mermaid" hidden><code>${diagramSource}</code></pre></section>
<p>After diagram <a href="#fn1">1</a></p><section><h2>Footnotes</h2><ol><li id="fn1">Footnote content <a href="#ref1">back</a></li></ol></section></div>`;

for (const adapter of [grokLightAdapter, grokFullAdapter, grokTreeAdapter, qwenLightAdapter, qwenFullAdapter, qwenTreeAdapter]) {
  test(`${adapter.manifest.id} retains rich blocks around a message-owned Mermaid card`, async () => {
    const grok = adapter.manifest.family === "grok";
    const tree = adapter.manifest.routes[0]!.profile === "tree";
    const owner = grok ? "response-owner" : "owner";
    const item: JsonObject = { id: "owner", response_id: "owner", source_id: owner, role: "assistant", content_markdown: "Lossy fallback", raw_message: "Lossy fallback", thoughts: [], sources: [], attachments: [], media: [] };
    const context: AdapterParseContext = {
      manifest: { source: { title: "fixture" } },
      payload: { messages: [item], nodes: [item], message_order: ["owner"], ...(tree ? { current_leaf_message_id: "owner", current_path_response_ids: ["owner"] } : {}) },
      source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) },
      reading: {
        images: [], files: [], mermaid: [{ messageId: owner, source: diagramSource, dataUrl: diagramData }],
        fragments: [{ messageId: owner, html: `<div class="${grok ? "assistant-content" : "message-content"}">${body}</div>` }]
      }
    };
    const draft = await adapter.parse(context);
    const content = (draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
    assert.deepEqual(content.map(block => block["type"]), ["html", "diagram", "html"]);
    const before = new JSDOM(String(content[0]!["html"])), after = new JSDOM(String(content[2]!["html"]));
    try {
      assert.equal(before.window.document.querySelector("h3")?.textContent, "Custom card");
      assert.equal(before.window.document.querySelector("pre code")?.textContent, code);
      assert.equal(before.window.document.querySelector("blockquote ol")?.getAttribute("start"), "4");
      assert.equal(before.window.document.querySelectorAll("blockquote table tr").length, 2);
      assert.equal(before.window.document.querySelector("td")?.getAttribute("style"), "text-align:center");
      assert.equal(after.window.document.querySelector("h2")?.textContent, "Footnotes");
      assert.equal(after.window.document.querySelector("a")?.getAttribute("href"), "#fn1");
      assert.equal(content[1]!["source"], diagramSource);
      assert.equal((draft["resources"] as JsonObject[]).length, 1);
      assert.ok(content[1]!["rendered"]);
      assert.ok(!JSON.stringify(content).includes("Lossy fallback"));
      assert.ok(!JSON.stringify(content).includes("data:image"));
    } finally { before.window.close(); after.window.close(); }
  });
}

test("rich panel partition keeps complete sibling containers and does not consume an ambiguous panel", () => {
  assert.equal(capturedPanelWithMermaid(`<div class="body">${body}</div><div class="body">other</div>`, "body"), undefined);
  assert.equal(capturedPanelWithMermaid(`<div class="body">${body}<img src="data:image/png;base64,AAAA"></div>`, "body"), undefined);
  const nested = `<div class="body"><ol><li>${body}</li></ol></div>`;
  assert.equal(capturedPanelWithMermaid(nested, "body"), undefined, "a graph inside a list must not split the list into unrelated containers");
  const excluded = capturedPanelWithMermaid(`<div class="body"><details class="thinking"><summary>Thought</summary><p>process</p></details>${body}<details class="answer-sources"><summary>Sources</summary></details></div>`, "body", ["thinking", "answer-sources"]);
  assert.equal(excluded?.length, 3);
  assert.doesNotMatch(JSON.stringify(excluded), /process|answer-sources|thinking/);
});
