import assert from "node:assert/strict";
import test from "node:test";

import { capturedMathIsDisplay, capturedTextPanel, inertHtmlFragment, inertStandaloneSvg, preserveNestedMath, restoreCapturedProcess } from "../../../src/adapters/parser/inert-html.mts";
import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { JSDOM } from "jsdom";

test("math display recognizes current block/inline metadata and legacy booleans", () => {
  for (const [value, expected] of [["block", true], ["true", true], ["inline", false], ["false", false]] as const) {
    const node = parseFragment(`<span data-math-display="${value}"></span>`).childNodes[0] as DefaultTreeAdapterTypes.Element;
    assert.equal(capturedMathIsDisplay(node), expected);
  }
  const native = parseFragment('<span><math display="block"><mi>x</mi></math></span>').childNodes[0] as DefaultTreeAdapterTypes.Element;
  assert.equal(capturedMathIsDisplay(native), true);
});

test("saved process panels preserve ordered lists and code while keeping tool order and fold metadata", () => {
  const blocks = [{ type: "reasoning", text: "Third\nx", title: "Thought", duration: 2 }, { type: "tool", name: "search", kind: "call" }];
  const source = '<details class="osis-thinking"><summary>Thought</summary><div><ol start="3"><li>Third</li></ol><pre><code>x</code></pre></div></details>';
  const restored = restoreCapturedProcess(blocks, source);
  assert.equal(restored[0]!["format"], "html");
  assert.match(String(restored[0]!["text"]), /<ol start="3"><li>Third<\/li><\/ol>/u);
  assert.doesNotMatch(String(restored[0]!["text"]), /<summary/u);
  assert.equal(restored[0]!["duration"], 2);
  assert.deepEqual(restored[1], blocks[1]);
  assert.deepEqual(restoreCapturedProcess(blocks, source + source), blocks, "Ambiguous panel count must keep the existing semantic projection");
  assert.deepEqual(restoreCapturedProcess(blocks, source.replace("Third", "Contradictory unrelated content")), blocks, "A same-owner but contradictory DOM panel must not erase semantic content");
});

test("captured text panels retain their structure and refuse ambiguous or resource-bearing panels", () => {
  const source = '<div class="message-shell"><div class="message-content"><h2>Title</h2><ol start="3"><li>Third</li></ol><p>Formula <span class="katex"><span><math><mi>x</mi></math></span><span class="katex-html">duplicate</span></span></p></div></div>';
  const result = capturedTextPanel(source, "message-content")!;
  assert.match(result, /<ol start="3"><li>Third<\/li><\/ol>/u);
  assert.match(result, /<p>Formula <math><mi>x<\/mi><\/math><\/p>/u);
  assert.doesNotMatch(result, /duplicate/u);
  assert.equal(capturedTextPanel(source + source, "message-content"), undefined);
  assert.equal(capturedTextPanel(source.replace("<h2>", '<img src="data:image/png;base64,AA=="><h2>'), "message-content"), undefined);
  assert.equal(capturedTextPanel(source, "unrelated-owner-panel"), undefined);
  const direct = capturedTextPanel('<div class="assistant-content"><details class="thinking"><summary>Thought</summary><p>Process</p></details><h3>Card</h3><p>Literal \\begin{center}</p><details class="answer-sources">References</details></div>', "assistant-content", undefined, ["thinking", "answer-sources"]);
  assert.match(direct!, /<h3>Card<\/h3><p>Literal \\begin\{center\}<\/p>/u);
  assert.doesNotMatch(direct!, /Process|References/u);
});

test("nested math stays inside its paragraph, list or table cell, with native MathML or an inert TeX slot", () => {
  for (const wrapper of ["p", "li", "td"]) for (const native of [false, true]) {
    const outer = wrapper === "li" ? "ol" : wrapper === "td" ? "table" : "div";
    const source = `<${outer}><${wrapper}>Before <span class="osis-math">${native ? '<math><mi>x</mi></math>' : 'x'}</span> after</${wrapper}></${outer}>`;
    const tree = parseFragment(source);
    const visit = (parent: DefaultTreeAdapterTypes.ParentNode): void => {
      parent.childNodes = parent.childNodes.map(child => {
        if (!("tagName" in child)) return child;
        if (child.tagName === "span") { const kept = preserveNestedMath(parent, child, "x", false)!; kept.parentNode = parent; return kept; }
        visit(child); return child;
      });
    };
    visit(tree);
    const dom = new JSDOM(serialize(tree));
    const target = dom.window.document.querySelector(wrapper)!;
    assert.equal(dom.window.document.querySelectorAll(wrapper).length, 1);
    assert.equal(target.firstChild?.textContent, "Before ");
    assert.equal(target.lastChild?.textContent, " after");
    assert.ok(target.querySelector(native ? "math mi" : '[data-cloudig-math="inline"]'));
    dom.window.close();
  }
});

test("an inline Markmap becomes a standalone SVG image with explicit SVG and XHTML namespaces", () => {
  const original = '<svg width="100" height="60"><foreignObject width="100" height="60"><div>Label <br><b>bold &amp; clear</b></div></foreignObject></svg>';
  const value = inertStandaloneSvg(original)!;
  const dom = new JSDOM("");
  const parsed = new dom.window.DOMParser().parseFromString(value, "image/svg+xml");
  assert.equal(parsed.querySelector("parsererror"), null);
  assert.equal(parsed.documentElement.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(parsed.querySelector("div")?.namespaceURI, "http://www.w3.org/1999/xhtml");
  assert.equal(parsed.querySelector("b")?.textContent, "bold & clear");
  assert.equal(parsed.querySelector("br")?.namespaceURI, "http://www.w3.org/1999/xhtml");
  assert.equal(inertStandaloneSvg(value), value);
  dom.window.close();
});

test("SVG local gradient, clip and arrow rules survive standalone serialization", () => {
  const original = '<svg viewBox="0 0 20 20"><style>.edge{marker-end:url(#arrow);fill:url("#paint")}</style><defs><linearGradient id="paint"><stop stop-color="red"/></linearGradient><clipPath id="clip"><rect width="20" height="20"/></clipPath></defs><path class="edge" style="clip-path:url(#clip);stroke:blue" d="M0 0L20 20"/></svg>';
  const value = inertStandaloneSvg(original)!;
  const dom = new JSDOM("");
  const xml = new dom.window.DOMParser().parseFromString(value, "image/svg+xml");
  assert.equal(xml.querySelector("parsererror"), null);
  assert.match(xml.querySelector("style")!.textContent!, /marker-end:url\(#arrow\)/u);
  assert.match(xml.querySelector("path")!.getAttribute("style")!, /clip-path:url\(#clip\)/u);
  assert.equal(inertStandaloneSvg(value), value);
  dom.window.close();
});

test("rich HTML becomes inert without losing visible structure or text", () => {
  const source = '<section onclick="steal()"><h2>Hello</h2><script>steal()</script><a href="javascript:steal()">bad</a><a href="https://example.test/a">good</a><iframe src="https://example.test/frame" title="Frame"></iframe><input value="Visible"><img src="https://example.test/image.png" alt="Image"><p style="color: red; background: url(https://example.test/x)">World</p></section>';
  const first = inertHtmlFragment(source)!;
  const second = inertHtmlFragment(source)!;
  assert.equal(first, second);
  assert.doesNotMatch(first, /<(?:script|iframe|input)\b|\sonclick=|javascript:|\ssrc=|url\s*\(/iu);
  assert.match(first, /<h2>Hello<\/h2>/u);
  assert.match(first, /<a>bad<\/a>/u);
  assert.match(first, /<a href="https:\/\/example\.test\/a">good<\/a>/u);
  assert.match(first, /data-cloudig-inert="iframe"[^>]*>Frame/u);
  assert.match(first, /data-cloudig-inert="input"[^>]*>Visible/u);
  assert.match(first, /<p style="color: red">World<\/p>/u);
});

test("Reader image preservation is explicit, inert and idempotent without changing Parser extraction", () => {
  const image = "data:image/png;base64,AA==";
  const source = `<img src="${image}" alt="Inline"><img src="https://example.test/a.png" alt="Reference"><svg><image href="${image}"/><image href="https://example.test/b.png"/></svg><button data-action="delete">Source text</button>`;
  assert.doesNotMatch(inertHtmlFragment(source)!, /(?:src|href)="data:/u, "Parser still extracts images into resource blocks");
  const result = inertHtmlFragment(source, { preserveEmbeddedImages: true })!;
  assert.match(result, /<img src="data:image\/png;base64,AA==" alt="Inline">/u);
  assert.match(result, /<image href="data:image\/png;base64,AA==">/u);
  assert.match(result, />Reference<\/span>/u);
  assert.match(result, />Source text<\/span>/u);
  assert.doesNotMatch(result, /https:|<button|data-action/u);
  assert.equal(inertHtmlFragment(result, { preserveEmbeddedImages: true }), result);
});

test("captured checkbox and radio values survive as non-interactive reading marks", () => {
  const source = '<ul><li><input class="task-checkbox" type="checkbox" disabled checked>Done</li><li><input type="checkbox" disabled>Pending</li></ul><input type="radio" checked><input type="radio">';
  const value = inertHtmlFragment(source)!;
  const dom = new JSDOM(value);
  assert.equal(dom.window.document.querySelector("input"), null);
  assert.deepEqual([...dom.window.document.querySelectorAll('[data-cloudig-inert="input"]')].map(n => n.textContent), ["☑", "☐", "◉", "○"]);
  assert.deepEqual([...dom.window.document.querySelectorAll("li")].map(n => n.textContent), ["☑Done", "☐Pending"]);
  assert.equal(inertHtmlFragment(value, { preserveEmbeddedImages: true }), value);
  dom.window.close();
});

test("static math, tables, lists, and SVG geometry remain renderable", () => {
  const source = '<table><tbody><tr><td colspan="2">Cell</td></tr></tbody></table><ol start="4"><li>Four</li></ol><span class="katex" data-tex="x^2">Math</span><svg viewBox="0 0 10 10"><style>.a{fill:red}</style><script>bad()</script><circle class="a" cx="5" cy="5" r="4" onclick="bad()"></circle><animate attributeName="x"></animate></svg>';
  const result = inertHtmlFragment(source)!;
  assert.match(result, /colspan="2"/u);
  assert.match(result, /<ol start="4">/u);
  assert.match(result, /class="katex" data-tex="x\^2"/u);
  assert.match(result, /<svg viewBox="0 0 10 10">/u);
  assert.match(result, /<circle class="a" cx="5" cy="5" r="4"><\/circle>/u);
  assert.doesNotMatch(result, /onclick|<animate|<script/iu);
});
