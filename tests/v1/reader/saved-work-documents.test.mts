import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { prepareInteractiveHtml } from "../../../src/ui/shared/conversation-renderer/interactive-document.mts";
import { INTERACTIVE_PROTOCOL, type InteractivePackage, type InteractiveFormat } from "../../../src/ui/shared/conversation-renderer/interactive-protocol.mts";
import { interactiveScrollCss } from "../../../src/ui/shared/conversation-renderer/interactive-scroll.mts";

function input(format: InteractiveFormat, entries: Record<string,string>): InteractivePackage {
  return { protocol: INTERACTIVE_PROTOCOL, token: "document", format, entry: Object.keys(entries)[0]!, theme: "dawn", language: "en", state: {},
    files: Object.entries(entries).map(([path, text]) => ({ path, mime: "text/plain", bytes: new TextEncoder().encode(text).buffer })) };
}
function render(work: InteractivePackage): string {
  const dom = new JSDOM("<!doctype html>"), result = prepareInteractiveHtml(work, dom.window.document, (_bytes,_mime) => "blob:work/file"); dom.window.close(); return result;
}
test("saved Docs XML and Markdown render content; pending source stays visibly pending", () => {
  const xml = input("document", { "document.xml": '<doc><paragraph heading="1"><text>Title</text></paragraph><paragraph><date value="2026-09-24"/><text> · </text><mention name="Author"/></paragraph><pending intent="Not yet written"/></doc>' });
  const dom = new JSDOM(render(xml)); assert.equal(dom.window.document.querySelector("h1")!.textContent, "Title");
  assert.equal(dom.window.document.querySelector("time")!.textContent, "2026-09-24"); assert(dom.window.document.querySelector(".pending")!.textContent!.includes("Pending in the saved document"));
  assert.equal(new TextDecoder().decode(xml.files[0]!.bytes).includes("<pending"), true); dom.window.close();
  const md = new JSDOM(render(input("document", { "document.md": "# Test\n\nA **bold** word.\n\n- First\n- Second" })));
  assert.equal(md.window.document.querySelector("strong")!.textContent, "bold"); assert.equal(md.window.document.querySelectorAll("li").length, 2); md.window.close();
});
test("unknown Docs XML nodes remain visible and malformed XML cannot masquerade as a finished document", () => {
  const dom = new JSDOM(render(input("document", { "document.xml": '<doc><novel-widget value="kept">Original</novel-widget></doc>' })));
  assert(dom.window.document.querySelector("pre")!.textContent!.includes('value="kept"')); dom.window.close();
  assert.throws(() => render(input("document", { "document.xml": "<doc><broken></doc>" })), /not valid Docs XML/u);
});
test("saved slide deck retains ordering, local image paths, native canvas and separately available notes", () => {
  const dom = new JSDOM(render(input("slides", { "project/deck.json": JSON.stringify({ order: ["second", "first"], faces: {} }),
    "project/slides/first.html": "<section><h1>First</h1></section>", "project/slides/second.html": '<section style="background:#1a0533"><h1>Second</h1><img src="../photo.svg"><aside>Speaker notes</aside></section>', "project/photo.svg": "<svg/>" })));
  const slides = [...dom.window.document.querySelectorAll<HTMLElement>(".saved-slide")]; assert.deepEqual(slides.map(s => s.querySelector("h1")!.textContent), ["Second","First"]);
  assert.equal(slides[0]!.dataset["notes"], "Speaker notes"); assert.equal(slides[0]!.querySelector("aside"), null); assert.equal(slides[0]!.querySelector("img")!.src, "blob:work/file");
  assert(dom.window.document.querySelector("style")!.textContent!.includes("width:1920px;height:1080px")); dom.window.close();
  assert.throws(() => render(input("slides", { "deck.json": '{"order":["missing"]}' })), /Saved work file is missing/u);
});
test("saved Design replays source-defined props/renderVals only in the isolated running copy", async () => {
  const original = '<!doctype html><script src="./support.js"></script><x-dc><div style="background:{{bg}}"><h1>{{title}}</h1></div></x-dc><script type="text/x-dc" data-props=\'{"bg":{"default":"#1a0533"},"title":{"default":"Original"}}\'>class Component extends DCLogic{renderVals(){return{bg:this.props.bg,title:this.props.title+" view"}}}</script>';
  const work = input("design", { "project/Main.dc.html": original }); const html = render(work); assert(!html.includes('src="./support.js"'));
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://cloudig-work.invalid/runtime/interactive-frame.html" });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(dom.window.document.querySelector("h1")!.textContent, "Original view");
  assert.equal(dom.window.document.querySelector<HTMLElement>("x-dc div")!.style.background, "rgb(26, 5, 51)"); assert.equal(new TextDecoder().decode(work.files[0]!.bytes), original); dom.window.close();
});

test("slide navigation and the notes button operate independently of each slide's notes data", () => {
  const html = render(input("slides", { "deck.json": '{"order":["one","two"]}', "slides/one.html": "<section><h1>One</h1><aside>First note</aside></section>", "slides/two.html": "<section><h1>Two</h1><aside>Second note</aside></section>" }));
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://cloudig-work.invalid/runtime/interactive-frame.html", beforeParse(window) { Object.defineProperty(window,"ResizeObserver", { value: class { observe() {} disconnect() {} } }); } });
  const doc = dom.window.document, notes = doc.querySelector<HTMLElement>(".slide-notes")!, button = doc.querySelector<HTMLButtonElement>("[data-toggle-notes]")!;
  assert(notes.hidden); button.click(); assert.equal(notes.hidden, false); assert.equal(button.getAttribute("aria-expanded"), "true"); assert.equal(notes.textContent, "First note");
  doc.querySelector<HTMLButtonElement>("[data-next]")!.click(); assert.equal(notes.textContent, "Second note"); assert.equal(doc.querySelector(".slide-count")!.textContent, "2 / 2");
  button.click(); assert(notes.hidden); dom.window.close();
});

test("generated documents inherit the host scroll rules, not a separate native or hardcoded skin", () => {
  const host = new JSDOM('<!doctype html><style>:root{--cloudig-scroll-idle:#d3af95;--cloudig-scroll-active:#d68c80}[data-scroll-region]::-webkit-scrollbar{width:8px}p{color:red}@supports not selector(::-webkit-scrollbar){[data-scroll-region]{scrollbar-width:thin}}</style>');
  const css = interactiveScrollCss(host.window.document); assert(css.includes("#d3af95")); assert(css.includes("width: 8px")); assert(css.includes("@supports not selector")); assert(!css.includes("color: red"));
  const work = input("document", { "page.md": "# Heading" }); const html = render({ ...work, scrollCss: css }), dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector("main")!.getAttribute("data-scroll-region"), ""); assert(dom.window.document.querySelector("main")!.style.overflow === "auto");
  assert(html.includes("#d68c80")); dom.window.close(); host.window.close();
});
test("Design System displays both saved color themes, text values and layout tokens", () => {
  const dom = new JSDOM(render(input("design-system", { "project/design-system.json": '{"title":"Tokens","docs":{"readme":"project/README.md"}}', "project/README.md": "# Tokens\n\nPreserved description.",
    "project/tokens.json": JSON.stringify({ color: { themes: [{id:"dawn",name:"Dawn"},{id:"night",name:"Night"}], tokens: [{name:"accent",value:{dawn:"#a52525",night:"#ffa92e"},usage:"Primary"}] }, type: { families:{sans:"system-ui"},groups:[{name:"Text",family:"sans",styles:[{name:"body",fontSize:"16px",lineHeight:"24px",fontWeight:400}]}] }, spacing:{tokens:[{name:"space-4",value:"16px"}]},radius:{tokens:[{name:"radius-md",value:"8px"}]} }) })));
  assert.equal(dom.window.document.querySelectorAll(".swatch").length, 2); assert(dom.window.document.body.textContent!.includes("#ffa92e"));
  for (const value of ["Preserved description.","Text/body","system-ui","space-4","radius-md"]) assert(dom.window.document.body.textContent!.includes(value)); dom.window.close();
});
