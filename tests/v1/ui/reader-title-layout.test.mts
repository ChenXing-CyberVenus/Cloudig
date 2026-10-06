import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const { readerTitleLayout } = await import(new URL("../../../src/ui/shell/pages/reader/title-layout.js", import.meta.url).href);

test("Reader title uses body-left, expanded-center, then full-width wrapped-left across responsive sizes", () => {
  for (const [l1, l2] of [[900, 1192], [670, 750], [480, 560], [900, 2100]] as const) {
    assert.equal(readerTitleLayout(l1 - 20, l1, l2), "body");
    assert.equal(readerTitleLayout(l1, l1, l2), "body");
    assert.equal(readerTitleLayout((l1 + l2) / 2, l1, l2), "center");
    assert.equal(readerTitleLayout(l2, l1, l2), "center");
    assert.equal(readerTitleLayout(l2 + 20, l1, l2), "wrap");
  }
  assert.equal(readerTitleLayout(800, 900, 600), "wrap", "a narrowed title container must not inherit a stale wider L1");
});

test("Reader header row grows with wrapped title instead of clipping its tags and dates", async () => {
  const css = await readFile(new URL("../../../src/ui/shell/pages/reader/conversation.css", import.meta.url), "utf8");
  assert.match(css, /\.reader-conversation-main\s*\{[^}]*grid-template-rows:\s*max-content 48px minmax\(0, 1fr\)/u);
  assert.match(css, /\.reader-conversation-model-tags\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/u);
  assert.match(css, /\.reader-conversation-model-tag\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/u);
});
