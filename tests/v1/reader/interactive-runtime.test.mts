import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { prepareInteractiveHtml } from "../../../src/ui/shared/conversation-renderer/interactive-document.mts";
import { openInteractiveWindow } from "../../../src/ui/shared/conversation-renderer/interactive-window.mts";
import { loadInteractiveDependencies } from "../../../src/ui/shared/conversation-renderer/interactive-dependencies.mts";
import { interactiveReactDocument } from "../../../src/ui/shared/conversation-renderer/interactive-react-document.mts";
import { INTERACTIVE_LIMITS, INTERACTIVE_PROTOCOL, readInteractiveState, saveInteractiveState, type InteractivePackage } from "../../../src/ui/shared/conversation-renderer/interactive-protocol.mts";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
function dialogDom(): JSDOM {
  const dom = new JSDOM("<!doctype html>", { url: "https://cloudig.local/index.html" });
  // JSDOM has no top-layer dialog implementation. These tests cover lifecycle,
  // not modal hit-testing; the real browser/EXE must prove the latter.
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { value(this: HTMLDialogElement) { this.open = false; } });
  return dom;
}

test("public website work bootstrap keeps an opaque sandbox and the same scoped channel lifecycle", async () => {
  const dom=dialogDom(),abort=new AbortController();
  const work=openInteractiveWindow({document:dom.window.document,title:'Public example',entry:'index.html',stateKey:'public',theme:'dawn',language:'en',signal:abort.signal,
    readFiles:async()=>[{path:'index.html',mime:'text/html',bytes:bytes('<p>Original</p>')}],frameUrl:'https://cloudig.local/runtime/interactive-frame.html',opaqueOrigin:true});
  await new Promise(resolve=>setTimeout(resolve,0));
  const frame=dom.window.document.querySelector('iframe')!,suppliedToken=new URL(frame.src).hash.slice(1);assert.equal(frame.getAttribute('sandbox'),'allow-scripts');assert(!frame.hasAttribute('srcdoc'));assert(suppliedToken);
  assert.equal(work.element.dataset['state'],'loading');
  dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{protocol:INTERACTIVE_PROTOCOL,token:suppliedToken,kind:'loaded'}}));
  assert.equal(work.element.dataset['state'],'ready');assert((work.element.querySelector('.cloudig-interactive-status') as HTMLElement).hidden);
  abort.abort();assert.equal(dom.window.document.querySelector('iframe'),null);dom.window.close();
});

test("opening indicator is theme-token driven, scoped to loading, and has reduced-motion fallback",async()=>{
  const css=await readFile('src/ui/shared/conversation-renderer/interactive-window.css','utf8');
  assert.match(css,/\[data-state="loading"\] \.cloudig-interactive-status::before/u);assert.match(css,/border-top-color:var\(--cloudig-accent\)/u);
  assert.match(css,/prefers-reduced-motion:reduce[\s\S]*animation:none/u);
});
test("running copy rewrites only owned resource paths and installs a session-only storage shim", () => {
  const dom = new JSDOM("<!doctype html>");
  const input: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "test", entry: "work/index.html", theme: "dawn", state: { draft: "kept <script> literal" }, files: [
    { path: "work/index.html", mime: "text/html", bytes: bytes('<!doctype html><title>Original</title><base href="https://bad.test"><p>Author words</p><img src="../photo.svg"><script src="main.js"></script>') },
    { path: "photo.svg", mime: "image/svg+xml", bytes: bytes("<svg/>") }, { path: "work/main.js", mime: "text/javascript", bytes: bytes("window.value=4") }
  ] };
  const original = new Uint8Array(input.files[0]!.bytes).slice(); let n = 0;
  const html = prepareInteractiveHtml(input, dom.window.document, () => `blob:null/local-${++n}`);
  assert(html.includes('src="blob:null/local-2"')); assert(html.includes('src="blob:null/local-3"')); assert(!html.includes("<base"));
  assert(html.includes("Author words")); assert(html.includes("localStorage")); assert(html.includes("\\u003cscript>"));
  assert.deepEqual(new Uint8Array(input.files[0]!.bytes), original);
  dom.window.close();
});

test("unknown executable dependencies fail explicitly, never fetch a CDN behind the user's back", () => {
  const dom = new JSDOM("<!doctype html>");
  const input: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "test", entry: "index.html", theme: "dawn", state: {}, files: [{ path: "index.html", mime: "text/html", bytes: bytes('<script src="https://unbundled.test/lib.js"></script>') }] };
  assert.throws(() => prepareInteractiveHtml(input, dom.window.document, () => "blob:null/test"), /Dependency is not bundled/u); dom.window.close();
});

test("session state is isolated, bounded, immutable to callers and not a disk record", () => {
  saveInteractiveState("work-one", { strokes: "one", __proto__: "not a property literal" }); saveInteractiveState("work-two", { strokes: "two" });
  const value = readInteractiveState("work-one") as Record<string,string>; value["strokes"] = "modified";
  assert.equal(readInteractiveState("work-one")["strokes"], "one"); assert.equal(readInteractiveState("work-two")["strokes"], "two");
  assert.throws(() => saveInteractiveState("work-one", { strokes: "x".repeat(INTERACTIVE_LIMITS.statePerWorkBytes) }), /full/u);
  assert.equal(readInteractiveState("work-one")["strokes"], "one"); assert.throws(() => saveInteractiveState("work-one", { strokes: 42 }), /Invalid/u);
  saveInteractiveState("work-one", {}); saveInteractiveState("work-two", {}); assert.deepEqual(readInteractiveState("work-one"), {});
});

test("closing during asynchronous file loading never starts a hidden work", async () => {
  const dom = dialogDom(), controller = new AbortController();
  let release: ((files: []) => void) | undefined, closed = 0;
  const opened = openInteractiveWindow({ document: dom.window.document, title: "Work", entry: "index.html", stateKey: "cancel", theme: "dawn", language: "en", signal: controller.signal,
    readFiles: () => new Promise(resolve => { release = resolve; }), onClose: () => closed++ });
  opened.close(); release?.([]); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dom.window.document.querySelector("iframe,dialog"), null); assert.equal(closed, 1); opened.close(); assert.equal(closed, 1); dom.window.close();
});

test("the runtime only accepts messages from its own wrapper and destroys it on route cancellation", async () => {
  const dom = dialogDom(), controller = new AbortController();
  const opened = openInteractiveWindow({ document: dom.window.document, title: "Work", entry: "index.html", stateKey: "owned", theme: "star-night", language: "zh", signal: controller.signal,
    readFiles: async () => [{ path: "index.html", mime: "text/html", bytes: bytes("<p>Work</p>") }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const frame = opened.element.querySelector("iframe")!; assert(frame); assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  assert.notEqual(new URL(frame.src).origin, new URL(dom.window.location.href).origin);
  const token = new URL(frame.src).hash.slice(1);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window as unknown as Window, data: { protocol: INTERACTIVE_PROTOCOL, token, kind: "state", detail: { stolen: "no" } } }));
  assert.deepEqual(readInteractiveState("owned"), {});
  controller.abort(); assert.equal(dom.window.document.querySelector("iframe,dialog"), null); dom.window.close();
});

test("a work is refused when its frame endpoint would share the application origin", async () => {
  const dom = dialogDom(), controller = new AbortController();
  const opened = openInteractiveWindow({ document: dom.window.document, title: "Unsafe origin", entry: "index.html", stateKey: "same-origin", theme: "dawn", language: "en", signal: controller.signal,
    frameUrl: "https://cloudig.local/runtime/interactive-frame.html", readFiles: async () => [{ path: "index.html", mime: "text/html", bytes: bytes("<p>Work</p>") }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opened.element.querySelector("iframe"), null); assert(opened.element.textContent!.includes("requires a separate origin")); opened.close(); dom.window.close();
});

test("inline Boxes enlarge and return without recreating their live iframe; collapse releases it", async () => {
  const dom = dialogDom(), controller = new AbortController(), parent = dom.window.document.createElement("section"); dom.window.document.body.append(parent);
  const opened = openInteractiveWindow({ document: dom.window.document, title: "Pulse", entry: "index.html", inlineParent: parent, stateKey: "inline", source: "claude.ai_visualize",
    theme: "dawn", language: "en", signal: controller.signal, readFiles: async () => [{ path: "index.html", mime: "text/html", bytes: bytes("<p>0</p>") }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const frame = opened.element.querySelector("iframe")!, token = new URL(frame.src).hash.slice(1); assert(frame);
  const buttons = () => [...opened.element.querySelectorAll("button")];
  assert.equal(opened.element.parentElement, parent); assert(opened.element.classList.contains("cloudig-interactive-box"));
  const post = (detail: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: frame.contentWindow, data: { protocol: INTERACTIVE_PROTOCOL, token, kind: "resize", detail } }));
  post(234); assert.equal(opened.element.style.getPropertyValue("--cloudig-inline-height"), "234px");
  post(10000); assert.equal(opened.element.style.getPropertyValue("--cloudig-inline-height"), `${INTERACTIVE_LIMITS.inlineMaximumHeight}px`);
  buttons().find(b => b.textContent === "Enlarge")!.click(); assert(!opened.element.classList.contains("cloudig-interactive-box"));
  assert.equal(opened.element.querySelector("iframe"), frame); post(400); assert.equal(opened.element.style.getPropertyValue("--cloudig-inline-height"), "640px");
  buttons().find(b => b.getAttribute("aria-label") === "Back to conversation")!.click();
  assert(opened.element.classList.contains("cloudig-interactive-box")); assert.equal(opened.element.querySelector("iframe"), frame);
  buttons().find(b => b.getAttribute("aria-label") === "Collapse work")!.click(); assert.equal(opened.element.querySelector("iframe"), null);
  assert(opened.element.querySelector<HTMLElement>(".cloudig-interactive-body")!.hidden);
  buttons().find(b => b.textContent === "Work")!.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert(opened.element.querySelector("iframe")); assert(buttons().some(b => b.getAttribute("aria-label") === "Collapse work"));
  controller.abort(); assert.equal(parent.childElementCount, 0); dom.window.close();
});

test("an offscreen light Box does not start and cannot start after route cancellation", async () => {
  const dom = dialogDom(), controller = new AbortController(), parent = dom.window.document.createElement("section");
  let observed = 0, disconnected = 0, reads = 0, notify: IntersectionObserverCallback | undefined;
  Object.defineProperty(dom.window, "IntersectionObserver", { value: class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe() { observed++; } disconnect() { disconnected++; }
  } });
  const opened = openInteractiveWindow({ document: dom.window.document, title: "Hidden", entry: "index.html", inlineParent: parent, stateKey: "hidden", theme: "dawn", language: "en", signal: controller.signal,
    readFiles: async () => { reads++; return []; } });
  assert.equal(observed, 1); assert.equal(reads, 0); assert.equal(opened.element.querySelector("iframe"), null);
  controller.abort(); notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); await Promise.resolve();
  assert.equal(reads, 0); assert.equal(disconnected, 1); dom.window.close();
});

test("Visualize receives its native ramps and saved icon masks without changing authored artifact colors", () => {
  const dom = new JSDOM("<!doctype html>"), source = '<svg><g class="c-purple"><rect width="40" height="20"/><text class="th">Title</text></g></svg><i class="ti ti-heart"></i>';
  const input: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "icons", entry: "index.html", source: "claude.ai_visualize", theme: "star-night", state: {}, icons: [{ name: "heart", path: "icons/heart.svg" }], files: [
    { path: "index.html", mime: "text/html", bytes: bytes(source) }, { path: "icons/heart.svg", mime: "image/svg+xml", bytes: bytes("<svg/>") }
  ] };
  let n = 0; const html = prepareInteractiveHtml(input, dom.window.document, () => `blob:work/icon-${++n}`), parsed = new JSDOM(html);
  assert(parsed.window.document.querySelector("style")!.textContent!.includes("--node-fill:#3C3489"));
  assert.equal(parsed.window.document.querySelector<HTMLElement>(".ti")!.style.maskImage, 'url("blob:work/icon-2")');
  assert.equal(new TextDecoder().decode(input.files[0]!.bytes), source);
  const artifact = prepareInteractiveHtml({ ...input, source: "claude.ai_artifact" }, dom.window.document, () => "blob:work/plain");
  assert(!artifact.includes("--node-fill")); parsed.window.close(); dom.window.close();
});

test("Visualize dynamic cloud icons keep their saved mask after every slider draw", async () => {
  const host = new JSDOM("<!doctype html>"), source = `<input id="clouds" type="range" min="0" max="12" value="5" oninput="draw(this.value)"><span id="count"></span><div id="sky"></div><script>function draw(v){count.textContent=v;sky.innerHTML=Number(v)?'<i class="ti ti-cloud"></i>'.repeat(Number(v)):'None'}draw(5)</script>`;
  const input: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "clouds", entry: "index.html", source: "claude.ai_visualize", theme: "dawn", state: {}, icons: [{ name: "cloud", path: "cloud.svg" }], files: [{ path: "index.html", mime: "text/html", bytes: bytes(source) }, { path: "cloud.svg", mime: "image/svg+xml", bytes: bytes("<svg/>") }] };
  let n = 0; const html = prepareInteractiveHtml(input, host.window.document, () => `blob:work/icon-${++n}`), dom = new JSDOM(html, { runScripts: "dangerously", url: "https://cloudig-work.invalid" });
  const check = (number: number) => { const range = dom.window.document.querySelector<HTMLInputElement>("input")!; range.value = String(number); range.dispatchEvent(new dom.window.Event("input")); assert.equal(dom.window.document.querySelectorAll(".ti-cloud").length, number); for (const icon of dom.window.document.querySelectorAll(".ti-cloud")) assert.equal(dom.window.getComputedStyle(icon).maskImage, 'url("blob:work/icon-2")'); };
  assert(html.includes("--text-accent:#534AB7")); check(5); check(0); check(12); assert.equal(new TextDecoder().decode(input.files[0]!.bytes), source); dom.window.close(); host.window.close();
});

test("all authored works receive a lowest-priority host scroll fallback without deleting author CSS", () => {
  const host = new JSDOM("<!doctype html>"), original = '<style>@layer author{.custom::-webkit-scrollbar{width:19px}.custom::-webkit-scrollbar-thumb{background:red}}</style><div class="custom">Original</div>';
  const input: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "scroll", entry: "index.html", theme: "star-night", state: {}, scrollCss: ':root{--cloudig-scroll-idle:#3b383c}[data-scroll-region]::-webkit-scrollbar{width:8px}', files: [{ path: "index.html", mime: "text/html", bytes: bytes(original) }] };
  const html = prepareInteractiveHtml(input, host.window.document, () => "blob:work/test"), result = new JSDOM(html);
  const styles = [...result.window.document.querySelectorAll("style")]; assert.match(styles[0]!.textContent!, /@layer cloudig-work-scroll-default/u); assert(styles[0]!.textContent!.includes(":where(*)::-webkit-scrollbar")); assert(styles[1]!.textContent!.includes("width:19px")); assert(!styles[0]!.textContent!.includes("!important"));
  assert(html.includes('"scrollRegions":true')); assert.equal(new TextDecoder().decode(input.files[0]!.bytes), original); result.window.close(); host.window.close();
});

test("known UMD libraries load only from the local runtime and retain their exact source aliases", async () => {
  const originalFetch = globalThis.fetch, requests: string[] = [];
  globalThis.fetch = async request => { requests.push(String(request)); return new Response("/* pinned local library */"); };
  try {
    const result = await loadInteractiveDependencies([{ path: "index.html", mime: "text/html", bytes: bytes('<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>') }], new AbortController().signal, "https://cloudig.local/runtime/dependencies/");
    assert.equal(result.files.length, 2); assert.equal(result.fontCss, "");
    assert(requests.every(url => url.startsWith("https://cloudig.local/runtime/dependencies/libraries/")));
    const dom = new JSDOM("<!doctype html>"); let i = 0;
    const input: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "umd", entry: "index.html", theme: "dawn", state: {}, files: [
      { path: "index.html", mime: "text/html", bytes: bytes('<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script><script>document.body.dataset.ready="yes"</script>') }, ...result.files] };
    const html = prepareInteractiveHtml(input, dom.window.document, () => `blob:work/lib-${++i}`);
    assert(html.includes('src="blob:work/lib-2"')); assert(!html.includes("https://cdnjs.cloudflare.com")); dom.window.close();
  } finally { globalThis.fetch = originalFetch; }
});

test("unused work dependencies are not loaded and a missing bundled dependency is explicit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected request"); };
  try {
    assert.deepEqual(await loadInteractiveDependencies([{ path: "index.html", mime: "text/html", bytes: bytes("<p>Plain</p>") }], new AbortController().signal, "https://cloudig.local/runtime/dependencies/"), { files: [], fontCss: "" });
    globalThis.fetch = async () => new Response("", { status: 404 });
    await assert.rejects(loadInteractiveDependencies([{ path: "index.html", mime: "text/html", bytes: bytes('<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>') }], new AbortController().signal, "https://cloudig.local/runtime/dependencies/"), /three 0.128.0/u);
  } finally { globalThis.fetch = originalFetch; }
});

test("the React running shell keeps JSX as literal source data and requires local compiler/styles", () => {
  const source = 'export default function Test(){return <p>{"</script><script>oops</script>"}</p>}';
  const dom = new JSDOM(interactiveReactDocument(source, "caiyun.jsx"));
  assert.equal(JSON.parse(dom.window.document.querySelector("#cloudig-react-input")!.textContent!).source, source);
  assert.equal(dom.window.document.querySelectorAll("script").length, 4);
  const input: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token: "jsx", entry: "main.jsx", format: "react", theme: "dawn", state: {}, files: [
    { path: "main.jsx", mime: "text/jsx", bytes: bytes(source) },
    { path: "runtime.js", mime: "text/javascript", bytes: bytes("/* runtime */"), aliases: ["cloudig-runtime:react"] },
    { path: "tailwind.js", mime: "text/javascript", bytes: bytes("/* styles */"), aliases: ["cloudig-runtime:tailwind"] }
  ] };
  let n = 0; const html = prepareInteractiveHtml(input, dom.window.document, () => `blob:work/jsx-${++n}`);
  assert(html.includes('src="blob:work/jsx-2"')); assert(html.includes('src="blob:work/jsx-3"'));
  assert(html.includes("cloudig-react-root")); assert.equal(new TextDecoder().decode(input.files[0]!.bytes), source); dom.window.close();
});
