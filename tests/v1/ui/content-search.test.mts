import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

async function module(name: string, dom: JSDOM) {
  const compiled = await build({ entryPoints: [path.resolve("src/ui/shell", name)], bundle: true, write: false, format: "iife", globalName: "TestModule" });
  dom.window.eval(compiled.outputFiles[0]!.text); return (dom.window as any).TestModule;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("both search actions are explicit; typing is not title filtering and clear restores an unsearched list", async () => {
  const dom = new JSDOM('<form><input type="search"><button type="button" id="clear" hidden>Clear</button></form>', { runScripts: "outside-only" });
  try {
    const { bindSearchEntry } = await module("search-entry.js", dom), doc = dom.window.document, input = doc.querySelector("input")!, clear = doc.querySelector<HTMLButtonElement>("#clear")!, signal = new dom.window.AbortController();
    const titles: string[] = [], contents: string[] = [];
    bindSearchEntry({ input, form: doc.querySelector("form"), clear, language: () => "en", onTitle: (v: string) => titles.push(v), onContent: (v: string) => contents.push(v), signal: signal.signal });
    input.value = "A needle"; input.dispatchEvent(new dom.window.Event("input")); assert.deepEqual(titles, []); assert.equal(clear.hidden, false);
    assert.equal(doc.querySelector('[data-search-title]')!.textContent, "Search titles");
    assert.equal(doc.querySelector('[data-search-title] > .cloudig-search-action-content > .cloudig-search-action-label')!.textContent, "Search titles");
    assert.equal(doc.querySelector('[data-search-title] svg')!.getAttribute("viewBox"), "4 4 16 16");
    assert.equal(doc.querySelector('[data-search-content] svg')!.getAttribute("viewBox"), "2.5 2.5 19.5 19.5");
    input.dispatchEvent(new dom.window.Event("scroll")); assert.equal((doc.querySelector(".cloudig-search-actions") as HTMLElement).hidden, false, "input horizontal scrolling must keep its search choices open");
    dom.window.dispatchEvent(new dom.window.Event("scroll")); assert.equal((doc.querySelector(".cloudig-search-actions") as HTMLElement).hidden, true);
    input.dispatchEvent(new dom.window.Event("input"));
    doc.querySelector<HTMLButtonElement>("[data-search-content]")!.click(); assert.deepEqual(contents, ["A needle"]); assert.deepEqual(titles, []);
    doc.querySelector<HTMLButtonElement>("[data-search-title]")!.click(); assert.deepEqual(titles, ["A needle"]);
    input.click(); assert.equal((doc.querySelector(".cloudig-search-actions") as HTMLElement).hidden, false, "an already-focused input must reopen both choices after title search");
    clear.click(); assert.equal(input.value, ""); assert.deepEqual(titles, ["A needle", ""]);
    signal.abort(); assert.equal(doc.querySelector(".cloudig-search-actions"), null);
  } finally { dom.window.close(); }
});

test("search dialog inherits multi-scope, excludes old title results, previews and releases a hit, and restores the background", async () => {
  const dom = new JSDOM('<main><button id="before">Before</button></main><aside></aside>', { runScripts: "outside-only" });
  try {
    const { openContentSearch } = await module("content-search.js", dom), doc = dom.window.document, underlay = doc.querySelector("main")!, host = doc.querySelector("aside")!, requests: any[] = [], opened: any[] = [];
    let previews = 0, released = 0; (underlay as any).inert = false; doc.querySelector<HTMLButtonElement>("#before")!.focus();
    const hit = { archive: "a_cap", conversation_id: "uuid", title: "Other branch", message: "m_else", excerpt: "Found needle", categories: ["assistant"] };
    openContentSearch({ host, underlay, language: "en", query: "needle", selection: ["d_one", "archived"], directories: [{ capability: "d_one", name: "One" }], platforms: [{ value: "claude", label: "Claude" }], selectedPlatforms: ["claude"],
      search(payload: any) { requests.push(payload); return { promise: Promise.resolve({ snapshot: "s", total: 1, conversations: 1, items: [hit] }), cancel() {} }; },
      preview: async (_hit: any, node: HTMLElement) => { previews++; node.textContent = "Full message"; return () => { released++; }; }, open: (value: any) => { opened.push(value); }
    });
    await tick(); assert.equal((underlay as any).inert, true); assert.deepEqual(JSON.parse(JSON.stringify(requests[0].scope)), { locations: ["conversations", "archives"], directories: ["d_one"] });
    assert.deepEqual([...requests[0].categories], ["user", "assistant"]); assert(!("search" in requests[0].scope));
    assert.equal(doc.querySelector('.cloudig-search-result mark')?.textContent, "needle");
    const all = doc.querySelector<HTMLInputElement>('.cloudig-content-scope-choices input[value="all"]')!, archived = doc.querySelector<HTMLInputElement>('.cloudig-content-scope-choices input[value="archived"]')!;
    assert.equal(all.type, "radio"); assert.equal(archived.type, "checkbox"); assert(archived.closest(".cloudig-checkbox"));
    all.click(); assert.equal(doc.querySelectorAll('.cloudig-content-scope-choices input:checked').length, 1); assert.equal(archived.checked, false);
    archived.click(); assert.equal(all.checked, false); assert.equal(archived.checked, true);
    const toggle = doc.querySelector<HTMLButtonElement>(".cloudig-search-result-toggle")!; toggle.click(); await tick(); assert.equal(previews, 1); assert.match(doc.querySelector(".cloudig-search-message-preview")!.textContent!, /Full message/);
    doc.querySelector<HTMLButtonElement>(".cloudig-search-result > .cloudig-button")!.click(); await tick(); assert.equal(opened[0].message, "m_else"); assert.equal(released, 1); assert.equal((underlay as any).inert, false); assert.equal(doc.activeElement?.id, "before");
  } finally { dom.window.close(); }
});

test("late results after close are discarded, pending previews are aborted, and limits are not hidden", async () => {
  const dom = new JSDOM('<main></main><aside></aside>', { runScripts: "outside-only" });
  try {
    const { openContentSearch } = await module("content-search.js", dom), doc = dom.window.document; let settle: (v: unknown) => void = () => undefined, cancelled = 0;
    const options = { host: doc.querySelector("aside"), underlay: doc.querySelector("main"), language: "zh-CN", query: "测试", selection: ["all"], directories: [], platforms: [], preview: async () => () => undefined, open() {} };
    const dialog = openContentSearch({ ...options, search: () => ({ promise: new Promise(resolve => { settle = resolve; }), cancel: () => { cancelled++; } }) });
    dialog.close(); settle({ total: 1, items: [{ title: "Late" }] }); await tick(); assert.equal(cancelled, 1); assert.equal(doc.querySelector(".cloudig-search-layer"), null);
    openContentSearch({ ...options, search: () => ({ promise: Promise.resolve({ snapshot: "s", total: 2, matched_messages: 99, conversations: 3, truncated: true, skipped_files: 1, items: [] }), cancel() {} }) });
    await tick(); assert.match(doc.querySelector('[role="status"]')!.textContent!, /99.*前 2.*1 个文件/);
    doc.querySelector<HTMLButtonElement>("[data-search-close]")!.click();
  } finally { dom.window.close(); }
});

test("Markdown options select body or process independently and partial export carries exact selected message IDs", async () => {
  const dom = new JSDOM('<main></main><aside></aside>', { runScripts: "outside-only" });
  try {
    const { chooseMarkdown } = await module("markdown-options.js", dom), doc = dom.window.document, requests: any[] = [];
    const promise = chooseMarkdown({ host: doc.querySelector("aside"), underlay: doc.querySelector("main"), language: "en", loadMessages: async (payload: any) => { requests.push(payload); return { snapshot: "rows", total: 2, items: [{ id: "m1", role: "user", summary: "One" }, { id: "m3", role: "assistant", summary: "Three" }] }; } });
    const partial = doc.querySelector<HTMLInputElement>('input[value="partial"]')!; partial.checked = true; partial.dispatchEvent(new dom.window.Event("change")); await tick();
    assert.equal(requests[0].content_mode, "body");
    const process = doc.querySelector<HTMLInputElement>('input[value="with_process"]')!; process.checked = true; process.dispatchEvent(new dom.window.Event("change")); await tick(); assert.equal(requests.at(-1).content_mode, "with_process");
    const message = doc.querySelector<HTMLInputElement>('.cloudig-markdown-messages input[value="m3"]')!; message.checked = true; message.dispatchEvent(new dom.window.Event("change"));
    assert.equal(message.type, "checkbox"); assert(message.closest(".cloudig-checkbox")); assert.equal(partial.type, "radio"); assert(!partial.closest(".cloudig-checkbox"));
    [...doc.querySelectorAll<HTMLButtonElement>("footer button")].find(b => b.textContent === "Copy Markdown")!.click();
    assert.deepEqual(JSON.parse(JSON.stringify(await promise)), { action: "copy", content_mode: "with_process", messages: ["m3"] }); assert.equal((doc.querySelector("main") as any).inert, undefined);
  } finally { dom.window.close(); }
});

test("highlight is literal, NFKC/case aware, and maps combining characters to intact original text", async () => {
  const dom = new JSDOM('<p></p>', { runScripts: "outside-only" });
  try {
    const { searchMatchRanges, appendHighlightedText } = await module("search-highlight.js", dom), p = dom.window.document.querySelector("p")!;
    const text = "ＮＥＥＤＬＥ needle <img src=x onerror=bad()> Café Cafe\u0301";
    appendHighlightedText(p, text, "needle");
    assert.equal(p.textContent, text); assert.equal(p.querySelectorAll("img").length, 0); assert.deepEqual([...p.querySelectorAll("mark")].map(n => n.textContent), ["ＮＥＥＤＬＥ", "needle"]);
    const accents = searchMatchRanges(text, "café"); assert.deepEqual([...accents].map(([a, b]: number[]) => text.slice(a, b)), ["Café", "Cafe\u0301"]);
    assert.deepEqual([...searchMatchRanges("a.*b", ".*")].map(([a,b]: number[]) => [a,b]), [[1,3]]);
  } finally { dom.window.close(); }
});

test("rich preview uses ranges across inline formatting, preserves DOM, and releases only its own highlight", async () => {
  const dom = new JSDOM('<main><p>A ne<strong>ed</strong>le <a href="#">needle</a></p><button>needle</button><span class="katex">needle</span></main>', { runScripts: "outside-only" });
  try {
    const win = dom.window as any, highlights = new Map(); win.CSS = { highlights }; win.Highlight = class extends Set { constructor(...ranges: Range[]) { super(ranges); } };
    const { highlightSearchPreview } = await module("search-highlight.js", dom), root = win.document.querySelector("main"), original = root.innerHTML;
    const first = highlightSearchPreview(root, "needle"); assert.equal(root.innerHTML, original);
    assert.deepEqual([...highlights.get("cloudig-search-hit")].map((r: any) => r.toString()), ["needle", "needle"]);
    const second = highlightSearchPreview(root, "A"); first(); assert(highlights.has("cloudig-search-hit")); second(); assert.equal(highlights.size, 0);
  } finally { dom.window.close(); }
});

test("changing an unsubmitted query does not change the highlight belonging to existing results", async () => {
  const dom = new JSDOM('<main></main><aside></aside>', { runScripts: "outside-only" });
  try {
    const win = dom.window as any, highlights = new Map(); win.CSS = { highlights }; win.Highlight = class extends Set { constructor(...ranges: Range[]) { super(ranges); } };
    const { openContentSearch } = await module("content-search.js", dom), doc = win.document;
    const dialog = openContentSearch({ host: doc.querySelector("aside"), underlay: doc.querySelector("main"), language: "en", query: "needle", selection: ["all"], directories: [], platforms: [],
      search: () => ({ promise: Promise.resolve({ snapshot: "one", total: 1, items: [{ title: "Test", excerpt: "needle other", message: "m1" }] }), cancel() {} }),
      preview: async (_hit: any, node: HTMLElement) => { node.textContent = "needle other"; return () => {}; }, open() {}
    });
    await tick(); doc.querySelector('[data-content-query]').value = "other"; doc.querySelector('.cloudig-search-result-toggle').click(); await tick();
    assert.deepEqual([...highlights.get("cloudig-search-hit")].map((r: any) => r.toString()), ["needle"]); dialog.close(); assert.equal(highlights.size, 0);
  } finally { dom.window.close(); }
});
