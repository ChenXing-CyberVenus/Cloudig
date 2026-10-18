import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createOfflineContentRuntime } from "../../../src/ui/shared/conversation-renderer/content-runtime.mts";

test("Markdown task lists preserve source states, rich inline content and nested/loose structure", () => {
  const runtime = createOfflineContentRuntime();
  try {
    const source = "- [ ] **First** with $x^2$\n- [x] [Done](https://example.com)\n  - [X] Nested\n  - ordinary\n\n  another paragraph\n\n1. [ ] Numbered\n2. ordinary\n";
    const html = JSDOM.fragment(runtime.renderMarkdown(source));
    const checks = [...html.querySelectorAll<HTMLInputElement>("input.cloudig-task-check")];
    assert.deepEqual(checks.map(n => n.checked), [false, true, true, false]);
    assert.ok(checks.every(n => n.disabled && n.getAttribute("aria-label")));
    assert.equal(html.querySelectorAll("li.cloudig-task-item").length, 4);
    assert.equal(html.querySelectorAll("strong").length, 1);
    assert.equal(html.querySelectorAll(".katex").length, 1);
    assert.equal(html.querySelector("a")?.textContent, "Done");
    assert.equal(html.querySelectorAll("li li.cloudig-task-item").length, 1);
    assert.equal(html.querySelectorAll("ol>li").length, 2);
    assert.ok(!html.textContent?.includes("[x]"));
    assert.ok(html.textContent?.includes("another paragraph"));
    assert.equal(runtime.renderMarkdown(source), runtime.renderMarkdown(source), "rendering is deterministic, without mutating source");
  } finally { runtime.dispose?.(); }
});

test("task recognition does not convert prose, escaped markers, inline/fenced code or bracket links", () => {
  const runtime = createOfflineContentRuntime();
  try {
    const source = "[ ] prose\n\n- \\[ ] escaped\n- `[x]` code\n- [x](https://example.com) link\n- [ ](https://example.com) blank link\n- [maybe] ordinary\n- [x]word\n\n```md\n- [ ] code block\n```";
    const html = JSDOM.fragment(runtime.renderMarkdown(source));
    assert.equal(html.querySelectorAll("input").length, 0);
    assert.equal(html.querySelectorAll("a").length, 2);
    assert.equal(html.querySelectorAll("code").length, 2);
    assert.ok(html.textContent?.includes("[ ] escaped"));
  } finally { runtime.dispose?.(); }
});

test("task text is escaped, empty markers and line-break labels remain readable", () => {
  const runtime = createOfflineContentRuntime();
  try {
    const html = JSDOM.fragment(runtime.renderMarkdown('- [ ]\n- [X]\n- [ ]\n  next line\n- [ ] <img src=x onerror=bad()> "quoted"'));
    assert.equal(html.querySelectorAll("input").length, 4);
    assert.equal(html.querySelectorAll("img,[onerror]").length, 0);
    assert.equal(html.querySelectorAll("input")[2]?.getAttribute("aria-label"), "next line");
    assert.ok(html.textContent?.includes('<img src=x onerror=bad()> "quoted"'));
  } finally { runtime.dispose?.(); }
});
