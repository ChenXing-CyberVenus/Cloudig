import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { installWorkLocalFiles } from "../../../src/ui/shared/conversation-renderer/interactive-local-files.mts";
import { loadInteractiveDependencies } from "../../../src/ui/shared/conversation-renderer/interactive-dependencies.mts";
import { clearInteractiveAssets } from "../../../src/ui/shared/conversation-renderer/interactive-assets.mts";
import catalog from "../../../src/ui/runtime-dependencies/optional-components.json" with { type: "json" };
import { prepareInteractiveHtml } from "../../../src/ui/shared/conversation-renderer/interactive-document.mts";
import { INTERACTIVE_PROTOCOL } from "../../../src/ui/shared/conversation-renderer/interactive-protocol.mts";
import { replayWorkScripts, finishWorkDocument } from "../../../src/ui/shared/conversation-renderer/interactive-script-replay.mts";
import { interactiveClient } from "../../../src/ui/shared/conversation-renderer/interactive-client.mts";

test("Python uses bundled files; only image recognition requests optional routes; licenses are not executable", async t => {
  const fetch = globalThis.fetch, urls: string[] = []; clearInteractiveAssets();
  globalThis.fetch = async input => { urls.push(String(input)); return new Response("pinned component"); };
  t.after(() => { globalThis.fetch = fetch; clearInteractiveAssets(); });
  const html = '<script src="https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js"></script>';
  const result = await loadInteractiveDependencies([{ path: "index.html", mime: "text/html", bytes: new TextEncoder().encode(html).buffer }], new AbortController().signal, "https://cloudig.local/runtime/dependencies/");
  assert.equal(urls.length, 5); assert(urls.every(url => url.startsWith("https://cloudig.local/runtime/dependencies/components/pyodide-0.26.2/")));
  assert.equal(result.files.length, 5); assert(result.files.some(file => file.mime === "application/wasm"));
  urls.length=0;
  const model='<script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1"></script>';
  await loadInteractiveDependencies([{path:'model.html',mime:'text/html',bytes:new TextEncoder().encode(model).buffer}],new AbortController().signal,'https://cloudig.local/runtime/dependencies/');
  assert(urls.length>0);assert(urls.every(url=>url.startsWith('https://cloudig.local/runtime/optional/')));
  assert.deepEqual(catalog.components.filter(c=>c.delivery==='on-demand').map(c=>c.id),['tfjs-4.22.0','mobilenet-2.1.1-tfjs-4.22.0']);
  for (const group of catalog.components) for (const file of group.files) { assert.match(file.sha256, /^[0-9a-f]{64}$/); assert(file.bytes > 0); assert(!file.url.includes("X-Goog-Signature")); }
});

test("video decoder bytes are pinned and bundled; ordinary documents do not load them",async t=>{
 const original=globalThis.fetch,urls:string[]=[];clearInteractiveAssets();globalThis.fetch=async input=>{urls.push(String(input));return new Response('component');};t.after(()=>{globalThis.fetch=original;clearInteractiveAssets();});
 const file={path:'other-name.mp4',mime:'video/mp4',bytes:new Uint8Array([1,2,3]).buffer};
 const result=await loadInteractiveDependencies([file],new AbortController().signal,'https://cloudig.local/runtime/dependencies/','document');
 assert(result.files.some(f=>f.aliases?.includes('cloudig-media-codec:hevc')));assert(result.files.some(f=>f.aliases?.includes('cloudig-media-runtime:avplayer.js')));assert(urls.every(u=>u.startsWith('https://cloudig.local/runtime/dependencies/')));assert(!urls.some(u=>u.includes('COPYING')));
 urls.length=0;clearInteractiveAssets();await loadInteractiveDependencies([{path:'note.txt',mime:'text/plain',bytes:new TextEncoder().encode('note').buffer}],new AbortController().signal,'https://cloudig.local/runtime/dependencies/','document');assert(!urls.some(u=>u.includes('libmedia')));
 assert.equal(catalog.components.find(c=>c.id==='libmedia-1.3.1')!.delivery,'bundled');
});

test("generated Blob and data downloads pass to the browser while ordinary external links stay blocked",()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://cloudig-work.invalid/runtime/interactive-frame.html',runScripts:'outside-only'});
 dom.window.eval(`(${interactiveClient.toString()})(${JSON.stringify({token:'save',state:{},stateLimit:1000,errorLimit:100,theme:'dawn'})})`);
 try {for(const [url,download,allowed]of [['blob:https://cloudig-work.invalid/123',true,true],['data:text/plain,hello',true,true],['https://example.com/file.pdf',true,false],['data:text/plain,hello',false,false]] as const){
  const a=dom.window.document.createElement('a');a.href=url;if(download)a.download='result.bin';dom.window.document.body.append(a);
  const event=new dom.window.MouseEvent('click',{bubbles:true,cancelable:true});a.addEventListener('click',()=>{assert.equal(event.defaultPrevented,!allowed);event.preventDefault();},{once:true});a.dispatchEvent(event);a.remove();
 }}finally{dom.window.close();}
});

test("blocking head configuration precedes body insertion and body observers see the complete initial content",async()=>{
 const dom=new JSDOM("<!doctype html>",{runScripts:"dangerously"}),document=dom.window.document;
 const parsed=new dom.window.DOMParser().parseFromString('<html><head><script>window.order=[document.body===null?"head-empty":"wrong"];new MutationObserver(()=>{if(document.body)document.body.dataset.initial="observed"}).observe(document.documentElement,{childList:true});</script><script>window.config=42</script></head><body><p id="present">Original</p><script>window.order.push(document.body.dataset.initial);window.order.push(window.config);window.order.push(document.querySelector("#present").textContent)</script></body></html>',"text/html");
 await replayWorkScripts(document,parsed,"phases");assert.deepEqual(Array.from(dom.window["order"] as unknown[]),["head-empty","observed",42,"Original"]);dom.window.close();
});

test("host size reporting observes the body after parsing, not the empty head phase",async()=>{
 const dom=new JSDOM("<!doctype html>",{runScripts:"dangerously"}),seen:Element[]=[];
 await new Promise<void>(resolve=>dom.window.addEventListener("load",()=>resolve(),{once:true}));
 Object.assign(dom.window,{ResizeObserver:class{observe(node:Element){assert(node instanceof dom.window.Element);seen.push(node);}disconnect(){}}});
 const parsed=new dom.window.DOMParser().parseFromString(`<head><script>(${interactiveClient.toString()})(${JSON.stringify({token:"host",state:{},stateLimit:1024,errorLimit:1024,theme:"dawn"})})</script></head><body>Original</body>`,"text/html");
 await replayWorkScripts(dom.window.document,parsed,"host");assert.equal(seen.length,0);
 dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));assert.equal(seen[0],dom.window.document.body);dom.window.close();
});

test("source compilers listening on window receive the real bubbling DOM ready phase",async()=>{
 const dom=new JSDOM("<!doctype html>",{runScripts:"dangerously"});await new Promise<void>(resolve=>dom.window.addEventListener("load",()=>resolve(),{once:true}));
 const parsed=new dom.window.DOMParser().parseFromString('<head><script>window.addEventListener("DOMContentLoaded",()=>{document.querySelector("#compiled").textContent=document.querySelector("script[type=\\"text/babel\\"]").textContent;})</script></head><body><div id="compiled"></div><script type="text/babel">Original JSX</script></body>',"text/html");
 await replayWorkScripts(dom.window.document,parsed,"compiler");await finishWorkDocument(dom.window.document);
 assert.equal(dom.window.document.querySelector("#compiled")!.textContent,"Original JSX");dom.window.close();
});

test("work-local fetch and dynamic scripts resolve owned aliases and Pyodide keeps its sibling base", async () => {
  const dom = new JSDOM("<!doctype html>", { runScripts: "outside-only" }), requests: string[] = [];
  Object.assign(dom.window, { fetch: async (input: unknown) => { requests.push(String(input)); return new Response("local bytes"); } });
  const base = "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/";
  dom.window.eval(`(${installWorkLocalFiles.toString()})(${JSON.stringify([[base + "pyodide.asm.wasm", "blob:work/wasm"], [base + "pyodide.asm.js", "blob:work/js"]])},${JSON.stringify(base)});`);
  const response = await dom.window.fetch(base + "pyodide.asm.wasm"); assert.equal(requests[0], "blob:work/wasm"); assert.equal(response.url, base + "pyodide.asm.wasm");
  const script = dom.window.document.createElement("script"); script.src = base + "pyodide.asm.js"; assert.equal(script.src, "blob:work/js");
  script.setAttribute("src", base + "pyodide.asm.js"); assert.equal(script.getAttribute("src"), "blob:work/js");
  dom.window.eval('globalThis.loadPyodide = options => options;');
  assert.equal(dom.window.eval('loadPyodide().indexURL'), base); assert.equal(dom.window.eval('loadPyodide({indexURL:"explicit"}).indexURL'), "explicit");
  dom.window.close();
});

test("code compilation/WASM capabilities stay on the work frame; no remote connect or native bridge is added", async () => {
  const frame = await readFile("src/ui/shared/conversation-renderer/interactive-frame.html", "utf8");
  assert.match(frame, /connect-src blob:;/); assert.match(frame, /worker-src blob:;/); assert.match(frame, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(frame, /connect-src[^;]*(https:|\*)/);
  const shell = await readFile("src/ui/shell/index.html", "utf8").catch(() => "");
  if (shell) assert.doesNotMatch(shell, /'unsafe-eval'/);
});

test("authored module aliases and Google font imports resolve only in the running copy", () => {
  const source='<style>@import url("https://fonts.googleapis.com/css2?family=Google+Sans+Code:wght@400");p{color:red}</style><script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js"}}</script><script type="module">import * as T from "three";</script>';
  const dom=new JSDOM("<!doctype html>");let index=0;
  const result=prepareInteractiveHtml({protocol:INTERACTIVE_PROTOCOL,token:"module",entry:"index.html",theme:"dawn",state:{},fontCss:'@font-face{font-family:"Google Sans Code";src:url("cloudig-font:code")}',files:[
    {path:"index.html",mime:"text/html",bytes:new TextEncoder().encode(source).buffer},
    {path:"three.js",mime:"text/javascript",bytes:new TextEncoder().encode("export const test=1").buffer,aliases:["https://unpkg.com/three@0.160.0/build/three.module.js"]}
  ]},dom.window.document,()=>`blob:test/${++index}`);
  assert(result.includes('"three":"blob:test/2"'));assert(!result.includes('@import url("https://fonts.googleapis'));assert(result.includes("p{color:red}"));
  assert(source.includes("@import"));dom.window.close();
});
