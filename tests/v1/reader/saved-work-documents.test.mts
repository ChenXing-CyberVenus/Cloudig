import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { prepareInteractiveHtml } from "../../../src/ui/shared/conversation-renderer/interactive-document.mts";
import { INTERACTIVE_PROTOCOL, type InteractivePackage, type InteractiveFormat } from "../../../src/ui/shared/conversation-renderer/interactive-protocol.mts";
import { interactiveScrollCss } from "../../../src/ui/shared/conversation-renderer/interactive-scroll.mts";
import { nativeSlideText, nativeSlides } from "../../../src/ui/shared/conversation-renderer/native-slides.mts";
import { zipSync, strToU8 } from "fflate";

function input(format: InteractiveFormat, entries: Record<string,string>): InteractivePackage {
  return { protocol: INTERACTIVE_PROTOCOL, token: "document", format, entry: Object.keys(entries)[0]!, theme: "dawn", language: "en", state: {},
    files: Object.entries(entries).map(([path, text]) => ({ path, mime: "text/plain", bytes: new TextEncoder().encode(text).buffer })) };
}
function render(work: InteractivePackage): string {
  const dom = new JSDOM("<!doctype html>"), result = prepareInteractiveHtml(work, dom.window.document, (_bytes,_mime) => "blob:work/file"); dom.window.close(); return result;
}
test("saved office outlines show a first page and preserve locally scrollable cells without rewriting files",()=>{
 const raw='<details class="osis-work-slide"><summary>Page 1</summary><div class="osis-rich"><h1>Original title</h1></div></details><details class="osis-work-slide"><summary>Page 2</summary>Second</details><table><tr><td colspan="2">Original wide heading</td></tr></table>';
 for(const theme of ['dawn','star-night'] as const){const work={...input('document',{'preview.html':raw}),source:'chat.mistral.ai_slides',theme},dom=new JSDOM(render(work));
 assert(dom.window.document.querySelector('details')!.open);assert.equal(dom.window.document.querySelectorAll('details[open]').length,1);assert.equal(dom.window.document.querySelector('.saved-sheet-scroll td')!.getAttribute('colspan'),'2');assert.equal(new TextDecoder().decode(work.files[0]!.bytes),raw);dom.window.close();}
});

test("Office bytes use a dedicated file preview, not UTF-8 decoding or the Markdown outline",()=>{
 const bytes=new Uint8Array([0x50,0x4b,0xff,0xff]).buffer;
 const work={...input("document",{"preview.html":"<p>Outline</p>"}),source:"chat.mistral.ai_slides",files:[...input("document",{"preview.html":"<p>Outline</p>"}).files,{path:"deck.pptx",mime:"application/octet-stream",bytes},{path:"runtime.js",mime:"text/javascript",bytes:new TextEncoder().encode("// runtime").buffer,aliases:["cloudig-runtime:file-preview"]}]};
 const doc=new JSDOM(render(work)).window.document;assert(doc.querySelector("#cloudig-file-preview"));assert(!doc.body.textContent!.includes("Outline"));assert(doc.querySelector('script[src="blob:work/file"]'));
 const direct={...work,entry:"deck.pptx",preview:true};assert(render(direct).includes("cloudig-file-preview"));
 assert.deepEqual(new Uint8Array(work.files[1]!.bytes),new Uint8Array([0x50,0x4b,0xff,0xff]));doc.defaultView!.close();
});

test("HTML attachments retain static layout without author scripts; image bytes are not decoded as text",()=>{
 const raw='<html><head><style>p{color:#123456}</style></head><body><script>alert("never")</script><p onclick="alert(1)">Literal</p><iframe srcdoc="active"></iframe><a href="javascript:alert(1)">Unsafe</a></body></html>';
 const work={...input("document",{"page.HTML":raw}),preview:true},html=render(work),doc=new JSDOM(html).window.document;
 assert.equal(doc.querySelector("p")!.textContent,"Literal");assert(!doc.querySelector('p[onclick],iframe,a[href^="javascript:"]'));assert([...doc.querySelectorAll("style")].some(s=>s.textContent!.includes('p{color:#123456}')));assert(![...doc.querySelectorAll("script")].some(s=>s.textContent!.includes('alert("never")')));assert.equal(new TextDecoder().decode(work.files[0]!.bytes),raw);doc.defaultView!.close();
 const image={...input("document",{}),preview:true,entry:"image.png",files:[{path:"image.png",mime:"image/png",bytes:new Uint8Array([255,0,255]).buffer}]};assert(render(image).includes('<img'));
});

test("research read views resolve native placeholders and citations without rewriting source or exposing arbitrary work paths",()=>{
  const original="# Report\n\nBefore [cite: 1].\n\nhttp://googleusercontent.com/visual_element_9\n\nAfter.\n\n`[cite: 1]`\n";
  const work={...input("document",{"report.md":original,"visuals/chart.html":"<html><body>Graph</body></html>","visuals/preview":"saved image"}),source:"gemini.google.com_research",data:{research:{entry:"report.md",visuals:[{path:"visuals/chart.html",placeholder:"http://googleusercontent.com/visual_element_9",title:"Native <b>graph</b>",previews:["visuals/preview"]}],sources:[{index:1,title:"Original source",url:"https://example.test/report"}],process:[{action:[1,"Reading sources",null,[]]}]}}};
  const dom=new JSDOM(render(work)),doc=dom.window.document;
  assert.equal(doc.querySelector(".research-visual button")!.getAttribute("data-cloudig-document"),"visuals/chart.html");assert.equal(doc.querySelector("figcaption")!.textContent,"Native graph");
  assert.equal(doc.querySelector("sup>a")!.getAttribute("href"),"#research-source-1");assert.equal(doc.querySelector("code")!.textContent,"[cite: 1]");
  assert(doc.querySelector(".research-process")!.textContent!.includes("Reading sources"));assert(!doc.querySelector("main")!.textContent!.includes("visual_element_9"));
  assert.equal(new TextDecoder().decode(work.files[0]!.bytes),original);dom.window.close();
});

test("native slide text removes only attributed paragraph sentinels, not user asterisks or Unicode", () => {
  const text={content:{apool:{numToAttrib:{0:["lmkr","1"],1:["bold","true"]}},initialAttributedTexts:{text:{0:"*A*B😀"},attribs:{0:"*0+1+3*1+2"}}}};
  assert.equal(nativeSlideText(text),"A*B<strong>😀</strong>");assert.equal(nativeSlideText(text,true),"A*B😀");
  assert.equal(nativeSlideText({content:{initialAttributedTexts:{text:{0:"*Literal"},attribs:{}}}}),"*Literal");
});

test("native slides retain source order, coordinates, alpha and notes; images come from the saved PPTX", () => {
  const image=Uint8Array.from([137,80,78,71,13,10,26,10]);
  const zip=zipSync({
    "ppt/presentation.xml":strToU8('<p:presentation xmlns:p="p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>'),
    "ppt/_rels/presentation.xml.rels":strToU8('<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>'),
    "ppt/slides/slide2.xml":strToU8('<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:pic><a:blip r:embed="picture"/></p:pic></p:sld>'),
    "ppt/slides/_rels/slide2.xml.rels":strToU8('<Relationships><Relationship Id="picture" Target="../media/source.png"/></Relationships>'),
    "ppt/media/source.png":image
  });
  const text=(value:string)=>({content:{initialAttributedTexts:{text:{0:value}}}});
  const data={native_snapshot:{block_map:{
    deck:{data:{type:"presentation",slides:["b","a"],size:{width:960,height:540}}},
    a:{data:{type:"slide",children:[],page:{size:{width:640,height:480}},slide:{}}},
    b:{data:{type:"slide",children:["pic","title"],page:{background:{fill:{color:{rgb_color:"#abcdef"}}}},slide:{note:"notes"}}},
    pic:{data:{type:"image",element:{size:{width:960,height:540},transform:{}},image:{size:image.length,mimeType:"image/png",name:"owned.png"}}},
    title:{data:{type:"shape",element:{size:{width:300,height:90},transform:{translateX:40,translateY:60},background:{inherit_mode:1,fill:{color:{rgb_color:"#123456"}},alpha:.55}},shape:{type:3,text:{...text("<Literal>"),font_color:"#ffffff",text_font_size:"32px"}}}},
    notes:{data:{type:"note",note:{text:text("Original notes")}}}
  }}};
  const raw=JSON.stringify(data),work={...input("document",{"source.json":raw}),source:"www.doubao.com_slides",files:[...input("document",{"source.json":raw}).files,{path:"downloads/deck.pptx",mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",bytes:zip.buffer as ArrayBuffer}]};
  const dom=new JSDOM("<!doctype html>"),slides=nativeSlides(work,raw,dom.window.document);
  assert.equal(slides.length,2);assert.equal(slides[1]!.width,640);assert.equal(slides[0]!.notes,"Original notes");
  assert(slides[0]!.body.includes("matrix(1,0,0,1,40,60)"));assert(slides[0]!.body.includes("55.00000000000001%"));assert(slides[0]!.body.includes("&lt;Literal&gt;"));assert(slides[0]!.body.includes("data:image/png;base64,"));
  assert.equal(new TextDecoder().decode(work.files[0]!.bytes),raw);
  assert.throws(()=>nativeSlides({...work,files:[work.files[0]!]},raw,dom.window.document),/image cannot be bound/);
  dom.window.close();
});
test("saved spreadsheet follows workbook relationships, preserves sparse cells and never executes formulas", () => {
  const source = JSON.stringify({ source_parts: {
    "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="First" r:id="b"/><sheet name="Second" r:id="a"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="a" Type="office/worksheet" Target="worksheets/not-first.xml"/><Relationship Id="b" Type="office/worksheet" Target="worksheets/first.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<sst><si><r><t>Preserved </t></r><r><t>words</t></r></si></sst>',
    "xl/worksheets/first.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Full-width heading</t></is></c><c r="B1"/><c r="C1"/></row><row r="3"><c r="A3" t="inlineStr"><is><t>Two rows</t></is></c><c r="C3"><v>3</v></c></row><row r="4"><c r="A4"/><c r="B4"/><c r="C4"><v>4</v></c></row><row r="8"><c r="A8" t="s"><v>0</v></c><c r="C8"><f>1+1</f><v>2</v></c></row></sheetData><mergeCells><mergeCell ref="A1:C1"/><mergeCell ref="A3:B4"/></mergeCells></worksheet>',
    "xl/worksheets/not-first.xml": '<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>&lt;script&gt;literal&lt;/script&gt;</t></is></c></row></sheetData></worksheet>'
  } });
  for (const theme of ["dawn", "star-night"] as const) {
    const work = { ...input("document", { "source.json": source }), source: "www.doubao.com_spreadsheet", theme }, dom = new JSDOM(render(work));
    const doc = dom.window.document; assert.deepEqual([...doc.querySelectorAll(".saved-sheet>summary")].map(n => n.textContent), ["First", "Second"]);
    assert.equal(doc.querySelector('[data-cell="A8"]')!.textContent, "Preserved words"); assert.equal(doc.querySelector('[data-cell="C8"]')!.getAttribute("title"), "=1+1");
    assert.equal(doc.querySelector('[data-cell="C8"]')!.textContent, "2"); assert.equal(doc.querySelector('[data-cell="C8"]')!.parentElement!.querySelector(".sheet-gap")!.getAttribute("colspan"), "1");
    assert.equal(doc.querySelector('.saved-sheet table tbody')!.children.length,8,"intentional empty rows retain their worksheet positions");
    assert.equal(doc.querySelector('[data-cell="A1"]')!.getAttribute("colspan"),"3");assert.equal(doc.querySelector('[data-cell="A3"]')!.getAttribute("rowspan"),"2");
    assert.equal(doc.querySelector('[data-cell="C4"]')!.parentElement!.querySelectorAll("td").length,1);assert.equal(doc.querySelector('.saved-sheet')!.querySelector('[data-cell="B1"]'),null);
    assert(doc.querySelector('[data-cell="B1"]')!.textContent!.includes("<script>literal</script>")); assert.equal(new TextDecoder().decode(work.files[0]!.bytes), source); dom.window.close();
  }
});

test("empty saved Docs remain visibly empty without fabricating source body text", () => {
  const work = input("document", { "document.xml": '<doc rev="1"><paragraph id="empty"/></doc>' }), before = new Uint8Array(work.files[0]!.bytes).slice();
  for (const language of ["zh", "en"] as const) {
    const dom = new JSDOM(render({ ...work, language }));
    assert.match(dom.window.document.querySelector(".saved-document-empty")!.textContent!, language === "en" ? /no body text/u : /没有正文/u); dom.window.close();
  }
  assert.deepEqual(new Uint8Array(work.files[0]!.bytes), before);
});
test("flat and nested slide file groups share the same Reader and ambiguous duplicate paths are rejected", () => {
  const files = { "deck.json": '{"order":["cover"]}', "cover.html": "<section><h1>Flat delivery</h1></section>" };
  const dom = new JSDOM(render(input("slides", files))); assert.equal(dom.window.document.querySelector("h1")!.textContent, "Flat delivery"); dom.window.close();
  assert.throws(() => render(input("slides", { ...files, "slides/cover.html": "<section>Another revision</section>" })), /ambiguous/u);
});
test("saved Docs XML and Markdown render content; pending source stays visibly pending", () => {
  const xml = input("document", { "document.xml": '<doc><paragraph heading="1"><text>Title</text></paragraph><paragraph><date value="2026-09-24"/><text> · </text><mention name="Author"/></paragraph><pending intent="Not yet written"/></doc>' });
  const dom = new JSDOM(render(xml)); assert.equal(dom.window.document.querySelector("h1")!.textContent, "Title");
  assert.equal(dom.window.document.querySelector("time")!.textContent, "2026-09-24"); assert(dom.window.document.querySelector(".pending")!.textContent!.includes("Pending in the saved document"));
  assert.equal(new TextDecoder().decode(xml.files[0]!.bytes).includes("<pending"), true); dom.window.close();
  const md = new JSDOM(render(input("document", { "document.md": "# Test\n\nA **bold** word.\n\n- First\n- Second" })));
  assert.equal(md.window.document.querySelector("strong")!.textContent, "bold"); assert.equal(md.window.document.querySelectorAll("li").length, 2); md.window.close();
});

test("saved Markdown shares formula, currency, tasks and local-resource rules with the Reader", () => {
  const raw = '# Formula\n\n$$E=mc^2$$\n\nInline $x^2$; price $0.435/$0.87.\n\n- [x] Done\n\n> Quote\n\n![Local](image.png)\n\n`$literal$`';
  const work = input("document", { "note.md": raw, "image.png": "image bytes" });
  const dom = new JSDOM(render(work)), doc = dom.window.document;
  assert.equal(doc.querySelectorAll(".katex").length, 2); assert(doc.querySelector(".katex-display"));
  assert(doc.body.textContent!.includes('$0.435/$0.87')); assert.equal(doc.querySelector("code")!.textContent, '$literal$');
  assert(doc.querySelector('input[type="checkbox"]:checked:disabled')); assert.equal(doc.querySelector("img")!.src, "blob:work/file");
  assert.equal(doc.querySelector("blockquote")!.textContent!.trim(), "Quote");
  assert.equal(new TextDecoder().decode(work.files[0]!.bytes), raw); dom.window.close();
});

test("pretty-printed Docs whitespace does not create blank quote lines but text whitespace stays authored", () => {
  const raw = '<doc>\n  <blockquote>\n    <paragraph>\n      <text>Quote</text>\n    </paragraph>\n  </blockquote>\n  <paragraph><text>First\nSecond\n</text></paragraph>\n</doc>';
  const dom = new JSDOM(render(input("document", { "document.xml": raw })));
  assert.equal(dom.window.document.querySelector("blockquote")!.textContent, "Quote");
  assert.equal(dom.window.document.querySelector("main>p")!.textContent, "First\nSecond\n"); dom.window.close();
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
  // The runtime may prepend shared theme/scroll rules. Inspect the actual
  // slide canvas, not whichever stylesheet happens to be first in <head>.
  const canvas = dom.window.getComputedStyle(slides[0]!);
  assert.equal(canvas.width, "1920px"); assert.equal(canvas.height, "1080px"); dom.window.close();
  assert.throws(() => render(input("slides", { "deck.json": '{"order":["missing"]}' })), /Saved work file is missing/u);
});
test("saved Design replays source-defined props/renderVals only in the isolated running copy", async () => {
  const original = '<!doctype html><script src="./support.js"></script><x-dc><div style="background:{{bg}}"><h1>{{title}}</h1></div></x-dc><script type="text/x-dc" data-props=\'{"bg":{"default":"#1a0533"},"title":{"default":"Original"}}\'>class Component extends DCLogic{renderVals(){return{bg:this.props.bg,title:this.props.title+" view"}}}</script>';
  const work = input("design", { "project/Main.dc.html": original }); const html = render(work); assert(!html.includes('src="./support.js"'));
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://cloudig-work.invalid/runtime/interactive-frame.html", beforeParse(window) { Object.assign(window,{fetch:globalThis.fetch}); } });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(dom.window.document.querySelector("h1")!.textContent, "Original view");
  assert.equal(dom.window.document.querySelector<HTMLElement>("x-dc div")!.style.background, "rgb(26, 5, 51)"); assert.equal(new TextDecoder().decode(work.files[0]!.bytes), original); dom.window.close();
});

test("slide navigation and the notes button operate independently of each slide's notes data", () => {
  const html = render(input("slides", { "deck.json": '{"order":["one","two"]}', "slides/one.html": "<section><h1>One</h1><aside>First note</aside></section>", "slides/two.html": "<section><h1>Two</h1><aside>Second note</aside></section>" }));
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://cloudig-work.invalid/runtime/interactive-frame.html", beforeParse(window) { Object.assign(window,{fetch:globalThis.fetch}); Object.defineProperty(window,"ResizeObserver", { value: class { observe() {} disconnect() {} } }); } });
  const doc = dom.window.document, notes = doc.querySelector<HTMLElement>(".slide-notes")!, button = doc.querySelector<HTMLButtonElement>("[data-toggle-notes]")!;
  assert(notes.hidden); button.click(); assert.equal(notes.hidden, false); assert.equal(button.getAttribute("aria-expanded"), "true"); assert.equal(notes.textContent, "First note");
  doc.querySelector<HTMLButtonElement>("[data-next]")!.click(); assert.equal(notes.textContent, "Second note"); assert.equal(doc.querySelector(".slide-count")!.textContent, "2 / 2");
  button.click(); assert(notes.hidden); dom.window.close();
});

test("generated documents inherit host scroll rules and natural flow height, not a forced viewport", () => {
  const host = new JSDOM('<!doctype html><style>:root{--cloudig-scroll-idle:#d3af95;--cloudig-scroll-active:#d68c80}[data-scroll-region]::-webkit-scrollbar{width:8px}p{color:red}@supports not selector(::-webkit-scrollbar){[data-scroll-region]{scrollbar-width:thin}}</style>');
  const css = interactiveScrollCss(host.window.document); assert(css.includes("#d3af95")); assert(css.includes("width: 8px")); assert(css.includes("@supports not selector")); assert(!css.includes("color: red"));
  const work = input("document", { "page.md": "# Heading" }); const html = render({ ...work, scrollCss: css }), dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector("main")!.getAttribute("data-scroll-region"), "");
  for(const n of [dom.window.document.documentElement,dom.window.document.body,dom.window.document.querySelector("main")!]) assert.equal(n.style.height, "");
  assert(html.includes("#d68c80")); dom.window.close(); host.window.close();
});
test("Design System displays both saved color themes, text values and layout tokens", () => {
  const dom = new JSDOM(render(input("design-system", { "project/design-system.json": '{"title":"Tokens","docs":{"readme":"project/README.md"}}', "project/README.md": "# Tokens\n\nPreserved description.",
    "project/tokens.json": JSON.stringify({ color: { themes: [{id:"dawn",name:"Dawn"},{id:"night",name:"Night"}], tokens: [{name:"accent",value:{dawn:"#a52525",night:"#ffa92e"},usage:"Primary"}] }, type: { families:{sans:"system-ui"},groups:[{name:"Text",family:"sans",styles:[{name:"body",fontSize:"16px",lineHeight:"24px",fontWeight:400}]}] }, spacing:{tokens:[{name:"space-4",value:"16px"}]},radius:{tokens:[{name:"radius-md",value:"8px"}]} }) })));
  assert.equal(dom.window.document.querySelectorAll(".swatch").length, 2); assert(dom.window.document.body.textContent!.includes("#ffa92e"));
  for (const value of ["Preserved description.","Text/body","system-ui","space-4","radius-md"]) assert(dom.window.document.body.textContent!.includes(value)); dom.window.close();
});
