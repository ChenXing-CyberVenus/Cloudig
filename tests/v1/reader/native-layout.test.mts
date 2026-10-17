import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { parseFragment } from "parse5";
import { chatGptNative, isChatGptNative } from "../../../src/adapters/parser/chatgpt-native.mts";
import { renderStructuredBox } from "../../../src/ui/shared/conversation-renderer/structured-box.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

test("GPT native layout preserves flex/grid, icons and literal copy without source execution", async () => {
  const tree = parseFragment('<div data-osis-native-component="box" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;position:fixed;background:url(https://example.test/pixel)"><div data-osis-native-component="row" style="display:flex;align-items:center;color:var(--muted)"><span data-osis-native-component="icon" style="width:24px;height:24px"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></span><strong>Native title</strong></div><button data-osis-native-component="button" data-osis-copy="A &amp; B" onclick="throw 1">Copy value</button><script>throw 2</script></div>');
  const node = tree.childNodes[0]!; assert("tagName" in node && isChatGptNative(node));
  const svg: string[] = [], block = chatGptNative(node, value => { svg.push(value); return `r${svg.length}`; });
  assert.equal(block["source"], "chatgpt.com_genui"); assert.equal(svg.length, 1);
  assert.doesNotMatch(JSON.stringify(block), /onclick|throw 1|throw 2|position|example\.test/u);
  const dom = new JSDOM("<!doctype html>"), controller = new AbortController(), copies: string[] = [], images: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (v: string) => { copies.push(v); } } });
  try {
    const root = renderStructuredBox({ document: dom.window.document, language: "en", signal: controller.signal, image: path => {
      images.push(path); return dom.window.document.createElement("img");
    } }, block);
    dom.window.document.body.append(root);
    assert.equal(root.querySelector<HTMLElement>('[data-native-component="box"]')!.style.display, "grid");
    assert.equal(root.querySelector<HTMLElement>('[data-native-component="row"]')!.style.alignItems, "center");
    assert.deepEqual(images, ["icons/1.svg"]); assert.equal(root.querySelectorAll("button").length, 1);
    root.querySelector("button")!.click(); await Promise.resolve(); assert.deepEqual(copies, ["A & B"]);
    controller.abort(); root.querySelector("button")!.click(); assert.equal(copies.length, 1);
  } finally { controller.abort(); dom.window.close(); }
});
test("Reader revalidates hand-authored layout data; unknown operations stay inert", () => {
  const dom = new JSDOM("<!doctype html>"), controller = new AbortController();
  try {
    const block: JsonObject = { type: "interactive", display: "box", format: "structured", source: "chatgpt.com_genui", data: { layout: [
      { tag: "iframe", style: { position: "fixed", color: "red", background: "url(https://example.test/x)" }, children: ["kept text"] },
      { tag: "button", onclick: "alert(1)", children: ["Unsupported action"] }, { tag: "a", href: "javascript:alert(1)", children: ["Unsafe URL"] }
    ] } };
    const root = renderStructuredBox({ document: dom.window.document, language: "zh", signal: controller.signal, image: () => dom.window.document.createElement("img") }, block);
    assert.equal(root.querySelectorAll("iframe,script,button,a").length, 0); assert.match(root.textContent!, /kept text/u);
    assert.doesNotMatch(root.innerHTML, /position|https:|javascript:|onclick/u);
  } finally { controller.abort(); dom.window.close(); }
});

test("fixed light and dark paper retain readable inherited text without recolouring authored palettes", () => {
  const dom = new JSDOM("<!doctype html>"), controller = new AbortController();
  try {
    const root = renderStructuredBox({ document: dom.window.document, language: "en", signal: controller.signal, image: () => dom.window.document.createElement("img") }, {
      type: "interactive", source: "chatgpt.com_genui", format: "structured", display: "box", data: { layout: [
        { tag: "div", style: { background: "#fff" }, children: ["Light paper"] },
        { tag: "div", style: { background: "black" }, children: ["Dark paper"] },
        { tag: "div", style: { background: "white", color: "purple" }, children: ["Authored colour"] }
      ] }
    });
    assert.equal((root.children[0] as HTMLElement).style.color, "rgb(41, 36, 38)");
    assert.equal((root.children[1] as HTMLElement).style.color, "rgb(231, 226, 227)");
    assert.equal((root.children[2] as HTMLElement).style.color, "purple");
  } finally { controller.abort(); dom.window.close(); }
});
