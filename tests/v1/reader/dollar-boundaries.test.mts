import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createOfflineContentRuntime } from "../../../src/ui/shared/conversation-renderer/content-runtime.mts";
import { osisInlineDollarRanges } from "../../../src/ui/shared/conversation-renderer/dollar-boundaries.mjs";

test("Reader carries an exact mechanical copy of the accepted bookmark recognizer", () => {
  const original = readFileSync("bookmarklets/vendor/osis-math-delimiters.js", "utf8").replaceAll("\r\n", "\n").trimEnd();
  const carried = readFileSync("src/ui/shared/conversation-renderer/dollar-boundaries.mjs", "utf8").replaceAll("\r\n", "\n");
  assert.equal(carried.slice(carried.indexOf("/* Single-dollar"), carried.indexOf("\n\nexport {")), original);
});
test("single dollars follow bookmark boundaries while code/escapes/links and explicit math keep their roles", () => {
  const runtime = createOfflineContentRuntime();
  const cases = ["$E=mc^2$", "$1/2$", "$0.435/$0.87", "$ x$", "$x $", "$x$2", "1$x$", "$a `b` c$", "$x$$y$", "$x\ny$", "\\$100", "`$x$`", "```text\n$x$\n```", "[link](https://example.com/a$x$)", "$-0.5/$+0.75", "$0.1/1M，公式$x^2$"];
  try {
    for (const input of cases) {
      const output = JSDOM.fragment(runtime.renderMarkdown(input));
      assert.deepEqual([...output.querySelectorAll('annotation[encoding="application/x-tex"]')].map(n => n.textContent), osisInlineDollarRanges(input).map(r => r.tex), input);
    }
    const code = JSDOM.fragment(runtime.renderMarkdown("$a `b` c$")); assert.equal(code.querySelector("code")?.textContent, "b");
    for (const input of [String.raw`\(x\)2`, String.raw`\[x^2\]`, "$$x^2$$", String.raw`\begin{matrix}a&b\\c&d\end{matrix}`])
      assert.equal(JSDOM.fragment(runtime.renderMarkdown(input)).querySelectorAll(".katex").length, 1, input);
    assert.equal(JSDOM.fragment(runtime.renderMath(String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`, true)).querySelectorAll(".katex-error").length, 0);
  } finally { runtime.dispose?.(); }
});

test("Reader Markdown keeps titled nested links and escaped punctuation outside math", () => {
  const runtime = createOfflineContentRuntime();
  const source = String.raw`[Link](https://example.com/article_(part)?utm_source=a_b "A quoted title") \*\*Meaning:\*\* \$100 and $x^2$`;
  try {
    const fragment = JSDOM.fragment(runtime.renderMarkdown(source));
    const link = fragment.querySelector("a")!;
    assert.equal(link.getAttribute("href"), "https://example.com/article_(part)?utm_source=a_b");
    assert.equal(link.getAttribute("title"), "A quoted title");
    assert.match(fragment.textContent ?? "", /\*\*Meaning:\*\* \$100/u);
    assert.equal(fragment.querySelectorAll("strong").length, 0);
    assert.deepEqual([...fragment.querySelectorAll('annotation[encoding="application/x-tex"]')].map(n => n.textContent), ["x^2"]);
  } finally { runtime.dispose?.(); }
});
