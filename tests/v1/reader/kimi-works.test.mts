import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { prepareInteractiveHtml } from "../../../src/ui/shared/conversation-renderer/interactive-document.mts";
import { INTERACTIVE_PROTOCOL, type InteractivePackage } from "../../../src/ui/shared/conversation-renderer/interactive-protocol.mts";
import { previewKind, isBinaryPreview } from "../../../src/ui/shared/conversation-renderer/file-preview-policy.mts";
import { kimiCard } from "../../../src/ui/shared/conversation-renderer/kimi-cards.mts";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

test("saved media files and Markdown footnotes use platform-independent themed previews", () => {
  const dom=new JSDOM();
  for(const theme of ["dawn","star-night"] as const)for(const [entry,mime] of [["sound.mp3","audio/mpeg"],["movie.mp4","video/mp4"]]){
    const html=prepareInteractiveHtml({protocol:INTERACTIVE_PROTOCOL,token:"media",format:"document",theme,state:{},preview:true,entry:entry!,files:[{path:entry!,mime:mime!,bytes:new Uint8Array([255,0,128]).buffer}]},dom.window.document,()=>"blob:saved");
    const parsed=new dom.window.DOMParser().parseFromString(html,"text/html");const media=parsed.querySelector("audio,video");assert(media);assert(media.hasAttribute("controls"));assert.equal(media.getAttribute("src"),"blob:saved");
  }
  const raw="Text[^a]\n\n[^a]: Note with **emphasis**.\n\n```python\nx = 1\n```\n\n$x^2$";
  const html=prepareInteractiveHtml({protocol:INTERACTIVE_PROTOCOL,token:"md",format:"document",theme:"dawn",state:{},preview:true,entry:"note.md",files:[{path:"note.md",mime:"text/markdown",bytes:bytes(raw)}]},dom.window.document,()=>"blob:saved");
  const parsed=new dom.window.DOMParser().parseFromString(html,"text/html");assert.equal(parsed.querySelector(".footnote-ref a")?.getAttribute("href"),"#fn1");assert(parsed.querySelector(".footnotes strong"));assert(parsed.querySelector("code.language-python .hljs-number"));assert(parsed.querySelector(".katex"));dom.window.close();
});
const base: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "test", source: "kimi.com_widget", format: "html", theme: "dawn", state: {}, entry: "index.html", files: [{ path: "index.html", mime: "text/html", bytes: bytes('<p style="color:var(--kimi-color-text-primary)">Original</p><script>customElements.define("my-view",class extends HTMLElement{})</script>') }], data: { host_style: { "--kimi-color-text-primary": "#222", "--kimi-font-sans": "Arial" } } };
test("Kimi host variables and opaque runtime are supplied without rewriting author code in either theme", () => {
  const dom = new JSDOM(); for (const theme of ["dawn", "star-night"] as const) {
    const html = prepareInteractiveHtml({ ...base, theme }, dom.window.document, () => "blob:local");
    assert.match(html, /customElements.define/); assert.match(html, /--kimi-color-surface:/);
    assert.match(html, theme === "dawn" ? /#f4e9de/ : /#292631/); assert(!html.includes("window.sendPrompt=function"), "do not advertise an unavailable host message bridge");
  } dom.window.close();
});
test("PPTD preserves native page size, styles, element positions, math and page order", () => {
  const dom = new JSDOM(), pptd = 'size: [800, 450]\ntheme:\n  colors: {ink: "#142536"}\n  textStyles: {body: {fontSize: 22, color: "$ink"}}\npages: [pages/a.page, pages/b.page]\n';
  const page = 'background: {type: solid, color: "#faf0e0"}\nelements:\n  - elementType: text\n    bounds: [30, 40, 500, 80]\n    content: {style: "$body", text: "First <strong>bold</strong> $x^2$"}\n';
  const input: InteractivePackage = { ...base, source: "kimi.com_pptd", format: "slides", entry: "deck.pptd", files: [{ path: "deck.pptd", mime: "text/yaml", bytes: bytes(pptd) }], data: { presentation: { pptdContent: pptd, pages: [{ path: "pages/a.page", content: page }, { path: "pages/b.page", content: page.replace("First", "Second") }] } } };
  const doc = new dom.window.DOMParser().parseFromString(prepareInteractiveHtml(input, dom.window.document, () => "blob:local"), "text/html");
  assert.equal(doc.querySelectorAll(".saved-slide").length, 2); assert.equal(doc.querySelector(".saved-slide")!.getAttribute("data-width"), "800");
  assert.equal((doc.querySelector(".kimi-slide-text") as HTMLElement).style.left, "30px"); assert.equal((doc.querySelector(".kimi-slide-text") as HTMLElement).style.fontSize, "22px"); assert(doc.querySelector(".katex")); assert(doc.body.textContent!.indexOf("First") < doc.body.textContent!.indexOf("Second"));
  assert.equal(doc.querySelector(".kimi-slide-text strong")?.textContent, "bold"); assert(!doc.body.textContent!.includes("<strong>"));
  assert.equal(doc.querySelector(".kimi-slide-text")!.children.length, 1, "inline text and emphasis must share a single flow box, not become vertical flex items");
  dom.window.close();
});
test("Kimi file catalog is lazy and service cards do not create live installation/scheduling actions", async () => {
  const dom = new JSDOM(), signal = new AbortController().signal; let calls = 0;
  const ctx = { document: dom.window.document, signal, language: "en" as const, image: () => dom.window.document.createElement("img"), file: () => { calls++; return dom.window.document.createElement("p"); } };
  const catalog = kimiCard(ctx, { source: "kimi.com_files", data: {}, files: [{ path: "one.txt", resource: "r1" }] }); assert.equal(calls, 0);
  const details = catalog.querySelector("details")!; details.open = true; details.dispatchEvent(new dom.window.Event("toggle")); assert.equal(calls, 1);
  details.dispatchEvent(new dom.window.Event("toggle")); assert.equal(calls, 1);
  const card = kimiCard(ctx, { source: "kimi.com_scheduled_task", title: "Task", data: { input: { content: "Saved task", once_at: "2026-10-25" } } }); assert.match(card.textContent!, /Saved task/); assert.equal(card.querySelectorAll("button,input").length, 0);
  const question = kimiCard(ctx, { source: "kimi.com_question", data: { input: { questions: [{ question: "Choose", options: [{ option: "One" }] }] }, native: { contents: [{ content: { case: "text", value: '[{"question":"Choose","answer":"No preference"}]' } }] } } }); assert.match(question.textContent!, /Saved answerNo preference/); assert.equal(question.querySelectorAll("button,input").length, 0);
  assert.equal(previewKind("model.glb"), "glb"); assert(isBinaryPreview({ path: "model.glb", mime: "model/gltf-binary", bytes: new ArrayBuffer(0) })); dom.window.close();
});
test("PPTD nested images and captured fonts resolve once from the package root", () => {
  const dom = new JSDOM(), pptd = 'size: [800, 450]\ncustomFonts: [{family: NativeFont, src: "https://example.test/NativeFont.ttf"}]\npages: [p.page]\n';
  const input: InteractivePackage = { ...base, source: "kimi.com_pptd", format: "slides", entry: "folder/deck.pptd", files: [
    { path: "folder/deck.pptd", mime: "text/yaml", bytes: bytes(pptd) }, { path: "folder/media/p.png", mime: "image/png", bytes: new ArrayBuffer(0) }, { path: "external/font/NativeFont.ttf", mime: "font/ttf", bytes: new ArrayBuffer(0) }
  ], data: { presentation: { base: "folder/", pptdContent: pptd, pages: [{ path: "p.page", content: 'elements: [{elementType: image, bounds: [0, 0, 800, 450], src: media/p.png}]' }] } } };
  let index = 0; const html = prepareInteractiveHtml(input, dom.window.document, () => `blob:local/${++index}`), parsed = new dom.window.DOMParser().parseFromString(html, "text/html");
  assert.match(parsed.querySelector(".kimi-slide img")!.getAttribute("src")!, /^blob:/u);
  assert.match([...parsed.querySelectorAll("style")].map(s => s.textContent).join("\n"), /font-family:"NativeFont";src:url\("blob:/u); dom.window.close();
});
