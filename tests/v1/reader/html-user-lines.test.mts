import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { inertHtmlFragment } from "../../../src/adapters/parser/inert-html.mts";
import { createConversationRenderer, type RendererLabels } from "../../../src/ui/shared/conversation-renderer/index.mts";
import { buildConversationMarkdown } from "../../../src/app/export/markdown.mts";

const labels: RendererLabels = { reasoning: "Thought", toolCall: "Tool", toolResult: "Result", toolActivity: "Activity", references: "References", search: "Search", diagram: "Diagram", source: "Source", loadingResource: "Loading", unavailableResource: "", failedResource: "", openAttachment: "Open", externalResource: "External", systemParty: "System", toolParty: "Tool", otherParty: "Other" };
const lines = (root: Element): string => [...root.childNodes].map(node => node.nodeType === 3 ? node.textContent : node.nodeType === 1 && (node as Element).localName === "br" ? "\n" : node.nodeType === 1 ? lines(node as Element) : "").join("");

for (const theme of ["dawn", "star-night"] as const) test(`user HTML, Markdown and text preserve the same lines in ${theme}, without a platform class`, () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme });
  const text = "First\nSecond\nThird\nFourth";
  const input = { messages: [{ party: { role: "user" }, blocks: [
    { category: "content", value: { type: "html", html: `<p>${text}</p>` } },
    { category: "content", value: { type: "markdown", text } },
    { category: "content", value: { type: "text", text } }
  ] }, { party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "html", html: `<p>${text}</p>` } }] }] };
  const before = JSON.stringify(input);
  try {
    renderer.render(input);
    const html = root.querySelector(".cloudig-message-user .cloudig-inert-html p")!;
    assert.equal(html.querySelectorAll("br").length, 3);
    assert.equal(lines(html), text);
    assert.equal(root.querySelectorAll(".cloudig-message-user .cloudig-rich:not(.cloudig-inert-html) p br").length, 3);
    assert.equal(root.querySelector(".cloudig-text")!.textContent, text);
    assert.equal(root.querySelectorAll(".cloudig-message-assistant br").length, 0);
    assert.equal(JSON.stringify(input), before, "Reading must not change the archived value");
  } finally { renderer.destroy(); dom.window.close(); }
});

test("HTML user lines distinguish inline text from structural whitespace and protect code, math and SVG", () => {
  const input = '\n<section>\n<p>First<strong> bold</strong>\n<em>second</em>\n\n  third\tindented</p>\n<ul>\n<li>One\nTwo</li>\n<li>Three</li>\n</ul>\n<table>\n<tbody>\n<tr>\n<td>A\nB</td>\n<td>C</td>\n</tr>\n</tbody>\n</table>\n<pre><code>one\n  two</code></pre><p><code>inline\ncode</code><math><mtext>math\nsource</mtext></math><svg><text>svg\nsource</text></svg></p>\n</section>\n';
  const output = inertHtmlFragment(input, { preserveUserLines: true })!;
  const dom = new JSDOM(output), root = dom.window.document.body;
  try {
    assert.equal(root.querySelector("p")!.querySelectorAll("br").length, 3);
    assert.equal(lines(root.querySelector("p")!), "First bold\nsecond\n\n  third\tindented");
    assert.equal(root.querySelectorAll("section > br, ul > br, table > br, tbody > br, tr > br").length, 0);
    assert.equal(root.querySelectorAll("li br").length, 1);
    assert.equal(root.querySelectorAll("td br").length, 1);
    assert.equal(root.querySelectorAll("pre br, code br, math br, svg br").length, 0);
    assert.equal(root.querySelector("pre code")!.textContent, "one\n  two");
    assert.equal(root.querySelector("p code")!.textContent, "inline\ncode");
    assert.equal(root.querySelector("math mtext")!.textContent, "math\nsource");
    assert.equal(root.querySelector("svg text")!.textContent, "svg\nsource");
    const indent = [...root.querySelectorAll<HTMLElement>("span")].find(node => node.textContent === "  third\tindented");
    assert.equal(indent?.style.whiteSpace, "pre-wrap");
  } finally { dom.window.close(); }
});

test("user HTML handles bare inline flows, CRLF and existing breaks without wrapper blank lines", () => {
  const html = '\n<div>\n<p>A<br>\nB\r\nC</p>\n<p>D</p>\n</div>\n';
  const normalized = inertHtmlFragment(html, { preserveUserLines: true })!;
  const dom = new JSDOM(normalized);
  try {
    assert.equal(dom.window.document.querySelectorAll("p br").length, 2);
    assert.equal(dom.window.document.querySelectorAll("div > br").length, 0);
    assert.equal(lines(dom.window.document.querySelector("p")!), "A\nB\nC");
    assert.equal(inertHtmlFragment(normalized, { preserveUserLines: true }), normalized, "Read-time normalization is idempotent");
    assert.equal(inertHtmlFragment("One\nTwo", { preserveUserLines: true }), "One<br>Two");
    assert.equal(inertHtmlFragment('<p style="white-space:normal">One\nTwo</p>', { preserveUserLines: true }), '<p style="white-space:normal">One\nTwo</p>', "Explicit source whitespace wins");
    assert.equal(inertHtmlFragment('<p style="white-space:pre-wrap">One\nTwo</p>', { preserveUserLines: true }), '<p style="white-space:pre-wrap">One\nTwo</p>');
    assert.equal(inertHtmlFragment('<p>One\nTwo</p>'), '<p>One\nTwo</p>', "Parser's default inert storage does not change");
  } finally { dom.window.close(); }
});

test("Markdown copy/export preserves HTML user breaks and leaves assistant HTML and archive data unchanged", () => {
  const conversation = JSON.parse(readFileSync(new URL("../contracts/fixtures/conversation-full.json", import.meta.url), "utf8")) as JsonObject;
  const messages = conversation["messages"] as JsonObject[];
  messages[0]!["content"] = [{ type: "html", html: "<p>First\nSecond</p>" }];
  messages[1]!["content"] = [{ type: "html", html: "<p>Assistant\nsoft break</p>" }];
  const original = JSON.stringify(conversation);
  const result = buildConversationMarkdown({ conversation, selectedLeaf: "m2", locale: "en", includeHeader: false, resolved: {
    archive: "a2", platform: "claude", archiveLayer: "none", models: [], userName: "User", assistantName: "AI",
    userAvatar: "Assets/Defaults/user.svg", assistantAvatar: "Assets/Defaults/assistant.svg", contentTime: { state: "unavailable" }
  } });
  const output = result.parts.filter(part => typeof part === "string").join("");
  assert.match(output, /<p>First<br>Second<\/p>/u);
  assert.match(output, /<p>Assistant\nsoft break<\/p>/u);
  assert.equal(JSON.stringify(conversation), original);
});
