import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { renderStructuredBox } from "../../../src/ui/shared/conversation-renderer/structured-box.mts";
import { recipeQuantity } from "../../../src/ui/shared/conversation-renderer/recipe-units.mts";
import { MAP_PROTOCOL, mapResourceUrl, validMapPoint } from "../../../src/ui/shared/conversation-renderer/map-protocol.mts";
import { openSavedMap } from "../../../src/ui/shared/conversation-renderer/map-window.mts";

function setup(source: string, input: JsonObject, extra: JsonObject = {}, language: "zh" | "en" = "en") {
  const dom = new JSDOM("<!doctype html><main></main>"), abort = new AbortController(), document = dom.window.document;
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { value(this: HTMLDialogElement) { this.open = false; } });
  const block: JsonObject = { type: "interactive", source: `claude.ai_${source}`, display: "box", format: "structured", data: { input, ...extra } };
  const before = JSON.stringify(block), imageRequests: string[] = [], externalRequests: string[] = [];
  const root = renderStructuredBox({ document, language, signal: abort.signal, image: (path, alt) => {
    imageRequests.push(path); const img = document.createElement("img"); img.alt = alt; return img;
  }, onOpenExternal: url => externalRequests.push(url) }, block);
  document.querySelector("main")!.append(root);
  const click = (text: string) => {
    const b = Array.from(root.querySelectorAll("button")).find(b => b.textContent === text || b.getAttribute("aria-label") === text);
    assert(b, text); b.click(); return b;
  };
  const close = () => { assert.equal(JSON.stringify(block), before, "interacting cannot rewrite saved input/results"); abort.abort(); dom.window.close(); };
  return { root, dom, block, imageRequests, externalRequests, abort, click, close };
}

test("official Claude Cards use the same inert Box renderer as bookmark Cards", () => {
  const table = setup("table_display_v0", { title: "Official table", table: [["Name", "Value"], ["Cloudig", "Reader"]] });
  assert.equal(table.root.querySelectorAll("table tbody tr").length, 1);
  assert(table.root.textContent!.includes("Cloudig"));
  table.close();
  const code = setup("code_block_display_v0", { language: "python", filename: "example.py", code: "print('Cloudig')" });
  assert.equal(code.root.querySelector("pre")?.dataset["language"], "python");
  assert(code.root.textContent!.includes("print('Cloudig')"));
  code.close();
  const rich = setup("rich_content_display_v0", { items: [{ title: "A result", subtitles: ["8 relevant sections"], text: "Saved content" }] });
  assert(rich.root.textContent!.includes("8 relevant sections"));
  rich.close();
});

test("native charts retain numeric gaps, axis labels, table view and keyboard-selected values", () => {
  const v = setup("chart_display_v0", { title: "Count", style: "line", x_axis: { title: "Date", data: ["A", "B", "C"] }, y_axis: { title: "Items" }, series: [{ name: "One", values: [0, null, 3] }, { name: "Two", values: [-2, 1, 5] }] });
  assert.equal(v.root.querySelectorAll("svg path").length, 2);
  assert.equal(v.root.querySelector("svg path")!.getAttribute("d")!.match(/M/gu)!.length, 2, "missing points do not invent a connecting line");
  assert(v.root.textContent!.includes("Date")); v.click("Table"); assert.equal(v.root.querySelector<HTMLElement>(".cloudig-box-data-table")!.hidden, false); assert(v.root.querySelector("table")!.textContent!.includes("—"));
  v.click("Chart"); v.root.querySelector("svg")!.dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(v.root.querySelector(".cloudig-box-chart-selection")!.textContent, "B · One — · Two 1"); v.close();
});

test("scatter preserves numeric coordinates, zeroes, repeated X values, colours and all table rows", () => {
  const v = setup("chart_display_v0", { title: "Clouds", style: "scatter", x_axis: { title: "Cloud (%)", min: 0, max: 100 }, y_axis: { title: "Rain (mm)", min: 0 }, series: [
    { name: "Morning", color: "#A52525", points: [{ x: 20, y: 0 }, { x: 35, y: .5 }, { x: 90, y: 7.1 }] },
    { name: "Afternoon", color: "#7E5EFF", points: [{ x: 15, y: 0 }, { x: 35, y: 1 }, { x: 95, y: 9.4 }] }
  ] });
  const dots = [...v.root.querySelectorAll("svg circle")]; assert.equal(dots.length, 6); assert.equal(v.root.querySelectorAll("svg path").length, 0);
  assert.equal(dots[0]!.getAttribute("fill"), "#A52525"); assert.equal(dots[3]!.getAttribute("fill"), "#7E5EFF");
  assert.equal(dots[1]!.getAttribute("cx"), dots[4]!.getAttribute("cx")); assert.notEqual(dots[1]!.getAttribute("cy"), dots[4]!.getAttribute("cy"));
  assert(v.root.querySelector("svg")!.textContent!.includes("100")); v.click("Table"); assert.equal(v.root.querySelectorAll("tbody tr").length, 6);
  assert(v.root.querySelector("tbody")!.textContent!.includes("9.4")); v.click("Chart");
  v.root.querySelector("svg")!.dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(v.root.querySelector(".cloudig-box-chart-selection")!.textContent, "Morning · Cloud (%) 35 · Rain (mm) 0.5"); v.close();
});

test("saved weather never invents current readings and retains daily low/precipitation details", () => {
  const v = setup("weather_fetch", { location_name: "Somewhere" }, { result: [{ type: "text", text: JSON.stringify({ current: { temperature: 67, condition_text: "Cloudy" }, daily: [{ day_of_week: "Thursday", date: "2026-09-24", high: 67.8, low: 54, precipitation_chance: 10 }] }) }] });
  assert.equal(v.root.querySelector(".cloudig-box-temperature")!.textContent, "67°"); v.click("Thursday 2026-09-24");
  assert(v.root.textContent!.includes("Low 54°")); assert(v.root.textContent!.includes("Precipitation 10%")); assert.equal(v.root.querySelector("img"), null); v.close();
});

test("place list preserves grouped galleries and reuses them when paging", () => {
  const v = setup("places_list_display_v0", { summary: "Places", places: [{ name: "First", description: "A", tips: ["Early"] }, { name: "Second", description: "B", tips: ["Evening"] }] }, { images: [{ source_id: "place_0_0", path: "one.jpg" }, { source_id: "place_1_0", path: "two.jpg" }] });
  assert.deepEqual(v.imageRequests, ["one.jpg", "two.jpg"]); v.click("View one by one"); assert(!v.root.textContent!.includes("Second")); v.click("Next"); assert(v.root.textContent!.includes("Evening"));
  v.click("View all"); assert.equal(v.root.querySelectorAll(".cloudig-box-product").length, 2); assert.deepEqual(v.imageRequests, ["one.jpg", "two.jpg"]); v.close();
});

test("translation keeps language columns, line breaks, pronunciation and inert source text", () => {
  const v = setup("translation_display_v0", { source_language: "English", source_text: "One\nTwo<script>unsafe()</script>", target_language: "中文", translation: "一\n二", pronunciation: "yī èr" });
  assert.equal(v.root.querySelectorAll(".cloudig-box-translation-column").length, 2);
  assert(v.root.textContent!.includes("One\nTwo<script>unsafe()</script>")); assert(v.root.textContent!.includes("yī èr")); assert.equal(v.root.querySelector("script"), null); v.close();
});

test("quiz preserves each answer, gates next, supports Flashcards and leaves the source untouched", () => {
  const v = setup("quiz_display_v0", { title: "Test", questions: [
    { id: "q1", prompt: "First?", options: [{ id: "a", text: "Yes" }, { id: "b", text: "No" }], correct_option_id: "a", explanation: "Because yes", correct_feedback: "Well done" },
    { id: "q2", prompt: "Second?", options: [{ id: "c", text: "Maybe" }], hint: "No grading data" }
  ] });
  assert.equal(Array.from(v.root.querySelectorAll("button")).find(b => b.textContent === "Next")!.disabled, true);
  v.click("Yes"); assert.equal(v.root.querySelector('[data-result="correct"]')?.getAttribute("aria-pressed"), "true");
  assert(v.root.textContent!.includes("Well done")); assert(v.root.textContent!.includes("Because yes"));
  v.click("Next"); assert(v.root.textContent!.includes("Second?")); v.click("Maybe"); assert(v.root.textContent!.includes("no grading answer"));
  v.click("Page 1"); assert(v.root.textContent!.includes("Well done"));
  v.click("Flashcards"); assert(!v.root.textContent!.includes("Because yes")); v.click("View answer"); assert(v.root.textContent!.includes("Because yes"));
  v.click("Next"); assert(!v.root.textContent!.includes("Because yes")); v.click("View answer"); assert(v.root.textContent!.includes("No answer in the saved record"));
  v.close();
});

test("steps default to one step, page and expand, with no forged source actions", () => {
  const v = setup("step_card_display_v0", { steps: [{ title: "One", description: "First\nline" }, { title: "Two", description: "Second" }] });
  assert.equal(v.root.querySelectorAll(".cloudig-box-step").length, 1); v.click("Next"); assert(v.root.textContent!.includes("Second"));
  v.click("View all steps"); assert.equal(v.root.querySelectorAll(".cloudig-box-step").length, 2); assert(v.root.textContent!.includes("First\nline")); v.close();
});

test("saved maps keep local details/photos offline and only mount on an explicit click", () => {
  const v = setup("places_map_display_v0", { title: "Places", locations: [{ name: "Lake", notes: "First\nline", latitude: 35, longitude: 139, place_id: "p1" }] }, {
    result: [{ type: "text", text: JSON.stringify({ enriched_places: { p1: { rating: 4.7, rating_count: 3, phone_number: "123", website: "https://example.org", photos: [{ url: "https://photos.example/p.jpg", attributions: [{ display_name: "Photographer", uri: "https://example.org/author" }] }] } } }) }],
    images: [{ path: "mine.jpg", source_id: "p1", source_url: "https://photos.example/p.jpg" }, { path: "other.jpg", source_id: "p2" }]
  });
  const document = v.dom.window.document; assert.equal(document.querySelector("iframe"), null); assert.deepEqual(v.imageRequests,["mine.jpg"]);
  assert(v.root.textContent!.includes("First\nline")); assert(v.root.textContent!.includes("4.7")); assert(v.root.textContent!.includes("Photographer"));
  const load = v.click("Load map · Online"); const iframe = document.querySelector("iframe")!, dialog = document.querySelector("dialog")!, token = new URL(iframe.src).hash.slice(1);
  assert.equal(dialog.open,true); assert.equal(iframe.referrerPolicy,"origin"); assert.equal(iframe.getAttribute("sandbox"),"allow-scripts allow-same-origin");
  const signal = (origin:string, kind:string) => v.dom.window.dispatchEvent(new v.dom.window.MessageEvent("message",{origin,source:iframe.contentWindow,data:{protocol:MAP_PROTOCOL,token,kind}}));
  signal("https://cloudig-work.invalid","loaded"); assert.equal(dialog.dataset["state"],"loading"); signal("https://cloudig-map.local","loaded"); assert.equal(dialog.dataset["state"],"ready");
  for (const [origin, url] of [["https://cloudig-work.invalid", "https://openfreemap.org"], ["https://cloudig-map.local", "https://openfreemap.org.attacker.test"], ["https://cloudig-map.local", "https://www.openstreetmap.org/copyright"]] as const) {
    v.dom.window.dispatchEvent(new v.dom.window.MessageEvent("message", { origin, source: iframe.contentWindow, data: { protocol: MAP_PROTOCOL, token, kind: "external", url } }));
  }
  assert.deepEqual(v.externalRequests, ["https://www.openstreetmap.org/copyright"], "only trusted map attribution goes through the host browser route");
  signal("https://cloudig-map.local","error"); assert.equal(dialog.dataset["state"],"failed"); assert(dialog.textContent!.includes("saved place details remain available"));
  dialog.dispatchEvent(new v.dom.window.Event("cancel",{cancelable:true})); assert.equal(document.querySelector("iframe,dialog"),null); assert.equal(document.activeElement,load);
  v.click("Load map · Online"); v.abort.abort(); assert.equal(document.querySelector("iframe,dialog"),null); v.close();
});

test("maps reject unusable coordinates and non-provider resource URLs without guessing", () => {
  assert(validMapPoint({name:"Equator",notes:"",latitude:0,longitude:0}));
  for (const latitude of [NaN,91,"35"]) assert(!validMapPoint({name:"Bad",notes:"",latitude,longitude:0}));
  assert.equal(mapResourceUrl("https://tiles.openfreemap.org/styles/liberty"),"https://tiles.openfreemap.org/styles/liberty");
  for(const url of ["http://tiles.openfreemap.org/a","https://tiles.openfreemap.org.attacker.test/a","https://u@tiles.openfreemap.org/a","file:///a"] ) assert.throws(()=>mapResourceUrl(url));
  const v=setup("places_map_display_v0",{locations:[{name:"Still readable",latitude:100,longitude:0}]});
  assert(v.root.textContent!.includes("Still readable")); assert(v.root.querySelector("button")!.disabled); v.close();
});

test("public website can explicitly host trusted map UI while desktop still rejects same-origin maps",()=>{
  const dom=new JSDOM('<button id="load">Map</button>',{url:'https://example.test/Cloudig/'}),document=dom.window.document,abort=new AbortController();
  Object.defineProperty(dom.window.HTMLDialogElement.prototype,'showModal',{value(this:HTMLDialogElement){this.open=true;}});
  Object.defineProperty(dom.window.HTMLDialogElement.prototype,'close',{value(this:HTMLDialogElement){this.open=false;}});
  const ctx={document,signal:abort.signal,language:'en' as const,image:()=>document.createElement('img')},anchor=document.querySelector<HTMLButtonElement>('button')!,points=[{name:'Lake',notes:'Saved',latitude:35,longitude:139}];
  assert.throws(()=>openSavedMap(ctx,'Map',points,anchor,'https://example.test/Cloudig/runtime/map-frame.html'),/separate origin/u);
  const close=openSavedMap({...ctx,mapSameOrigin:true},'Map',points,anchor,'https://example.test/Cloudig/runtime/map-frame.html');
  const frame=document.querySelector('iframe')!;assert(frame.src.startsWith('https://example.test/Cloudig/runtime/map-frame.html#'));assert(!frame.srcdoc);
  close();assert.equal(document.querySelector('iframe,dialog'),null);dom.window.close();
});

test("a structured Window honors its display field and ends local controls on close", () => {
  const dom = new JSDOM('<html><body><main data-theme="star-night"></main></body></html>'), document = dom.window.document, abort = new AbortController();
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { value(this: HTMLDialogElement) { this.open = false; } });
  const value: JsonObject = { type: "interactive", display: "window", source: "claude.ai_quiz_display_v0", format: "structured", data: { input: { title: "Question", questions: [{ prompt: "Pick", options: [{ id: "a", text: "A" }], correct_option_id: "a" }] } } };
  const before = JSON.stringify(value), entry = renderStructuredBox({ document, signal: abort.signal, language: "en", image: () => document.createElement("img") }, value);
  document.querySelector("main")!.append(entry); assert.equal(document.querySelector(".cloudig-box-quiz,dialog"), null);
  entry.querySelector("button")!.click(); const dialog = document.querySelector("dialog")!;
  assert(dialog.open); assert.equal(dialog.dataset["theme"], "star-night"); const choice = dialog.querySelector<HTMLButtonElement>(".cloudig-box-choice")!;
  choice.click(); assert.equal(dialog.querySelector(".cloudig-box-feedback")!.textContent, "Correct");
  dialog.dispatchEvent(new dom.window.Event("cancel", { cancelable: true })); assert.equal(document.querySelector("dialog"), null);
  entry.querySelector("button")!.click(); assert.equal(document.querySelector(".cloudig-box-feedback"), null, "a closed card does not keep active controls");
  abort.abort(); assert.equal(document.querySelector("dialog"), null); assert.equal(JSON.stringify(value), before); dom.window.close();
});

test("recipe scales ingredients and references, checks locally, and reuses the captured images", () => {
  const v = setup("recipe_display_v0", { title: "Tea", base_servings: 2, ingredients: [{ id: "a", amount: 100, unit: "ml", name: "Milk" }],
    steps: [{ title: "Pour", content: "Pour {a}." }, { title: "Wait", content: "Wait.", timer_seconds: 30 }], notes: ["Hot", "Careful"] }, { images: [{ path: "assets/image-1.png" }] });
  assert.deepEqual(v.imageRequests, ["assets/image-1.png"]); v.click("More servings"); assert(v.root.textContent!.includes("150 ml Milk"));
  assert(v.root.textContent!.includes("Pour 150 ml Milk.")); v.click("150 ml Milk"); assert.equal(v.root.querySelector(".cloudig-box-ingredient")!.getAttribute("aria-pressed"), "true");
  v.click("Mark step complete 1"); assert.equal(v.root.querySelector('.cloudig-box-step-number[aria-pressed="true"]')!.textContent, "✓");
  v.click("Start cooking"); assert.equal(v.root.querySelectorAll(".cloudig-box-step").length, 1); v.click("Next"); assert.equal(v.root.querySelector("output")!.getAttribute("aria-label"), "30 seconds");
  v.click("Full recipe"); assert.equal(v.root.querySelector(".cloudig-box-ingredient")!.getAttribute("aria-pressed"), "true");
  assert.deepEqual(v.imageRequests, ["assets/image-1.png"], "changing servings must not allocate images again"); v.close();
});

test("recipe timers are user-started, keep elapsed time through paging and release on Reader exit", t => {
  const v = setup("recipe_display_v0", { title: "Timed", steps: [{ title: "Wait", content: "Wait", timer_seconds: 30 }, { title: "Serve", content: "Done" }] });
  let now = 1000, tick: (() => void) | undefined, starts = 0, clears = 0;
  t.mock.method(Date, "now", () => now);
  v.dom.window.setInterval = ((fn: () => void) => { tick = fn; starts++; return 42; }) as typeof v.dom.window.setInterval;
  v.dom.window.clearInterval = () => { clears++; };
  assert.equal(starts, 0); v.click("Start timer"); assert.equal(starts, 1);
  now += 6500; tick!(); assert.equal(v.root.querySelector("output")!.textContent, "00:24");
  v.click("Start cooking"); v.click("Next"); assert.equal(v.root.querySelector("output"), null);
  now += 4000; tick!(); v.click("Page 1"); assert.equal(v.root.querySelector("output")!.textContent, "00:20");
  v.click("Pause"); assert.equal(clears, 1); now += 50000; v.click("Start timer");
  now += 20000; tick!(); assert.equal(v.root.querySelector("output")!.textContent, "00:00"); assert(v.root.textContent!.includes("Timer finished")); assert.equal(clears, 2);
  v.click("Restart timer"); const stale = [...v.root.querySelectorAll("button")].find(b => b.textContent === "Pause")!;
  v.abort.abort(); assert.equal(clears, 3); stale.click(); assert.equal(starts, 3); v.close();
});

test("recipe copy uses the displayed servings and ingredient references, without changing original data", async () => {
  const v = setup("recipe_display_v0", { title: "Tea", base_servings: 1, ingredients: [{ id: "milk", amount: 200, unit: "ml", name: "Milk" }], steps: [{ title: "Pour", content: "Add {milk}." }], notes: "Warm" });
  let copied = ""; Object.defineProperty(v.dom.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
  v.click("More servings"); v.click("Copy"); await Promise.resolve();
  assert(copied.includes("2 servings")); assert(copied.includes("Add 400 ml Milk.")); assert(copied.includes("Warm")); v.close();
});

test("cooking opens a separate modal, returns the same controls and cancels cleanly on route exit", () => {
  const v = setup("recipe_display_v0", { title: "Cooking", steps: [{ title: "One", content: "First", timer_seconds: 10 }, { title: "Two", content: "Second" }] });
  const content = v.root.querySelector(".cloudig-box-stack");
  assert.equal(v.root.querySelector("dialog"), null);
  v.click("Start cooking"); assert.equal(v.root.querySelector("dialog")!.open, true);
  assert.equal(v.root.querySelector("dialog .cloudig-box-stack"), content); assert.equal(v.root.querySelectorAll(".cloudig-box-step").length, 1);
  v.click("Exit cooking mode"); assert.equal(v.root.querySelector("dialog"), null); assert.equal(v.root.querySelector(".cloudig-box-stack"), content);
  assert.equal(v.root.querySelectorAll(".cloudig-box-step").length, 2); assert.equal(v.root.style.minHeight, "");
  v.click("Start cooking"); v.root.querySelector("dialog")!.dispatchEvent(new v.dom.window.Event("cancel", { cancelable: true })); assert.equal(v.root.querySelector("dialog"), null);
  v.click("Start cooking"); v.abort.abort(); assert.equal(v.root.querySelector("dialog"), null); v.close();
});

test("recipe units are reversible view state and preserve unknown units and mass/volume distinctions", () => {
  const v = setup("recipe_display_v0", { title: "Units", ingredients: [{ id: "m", name: "Milk", amount: 200, unit: "ml" }, { id: "s", name: "Honey", amount: 1, unit: "tsp" }], steps: [{ title: "Pour", content: "Add {m} and {s}." }] });
  v.click("US"); assert(v.root.textContent!.includes("0.8 cup Milk")); assert(v.root.textContent!.includes("1 tsp Honey"));
  v.click("Metric"); assert(v.root.textContent!.includes("200 ml Milk")); v.click("More servings"); v.click("US"); assert(v.root.textContent!.includes("1.7 cup Milk"));
  v.click("As written"); assert(v.root.textContent!.includes("400 ml Milk")); v.close();
  assert.deepEqual(recipeQuantity(1, "oz", "metric"), { amount: 28.349523125, unit: "g", converted: true });
  assert.equal(recipeQuantity(1, "cup", "metric").amount, 236.5882365);
  assert.deepEqual(recipeQuantity(2, "bunch", "metric"), { amount: 2, unit: "bunch", converted: false });
});

test("comparison rows align by attribute without dropping absent or repeated labels", () => {
  const v = setup("comparison_card_display_v0", { products: [
    { name: "One", attributes: [{ label: "Size", value: "Small" }, { label: "Color", value: "Red" }, { label: "Color", value: "Blue" }] },
    { name: "Two", attributes: [{ label: "Color", value: "Green" }, { label: "Size", value: "Large" }, { label: "Weight", value: "Light" }] }
  ] });
  assert.deepEqual([...v.root.querySelectorAll("thead th h3")].map(n => n.textContent), ["One", "Two"]);
  assert.deepEqual([...v.root.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("dd")].map(n => n.textContent)), [["Small", "Large"], ["Red", "Green"], ["Blue", "—"], ["—", "Light"]]);
  assert(v.root.querySelector("[data-scroll-region]")); v.close();
});

test("options and itinerary preserve the source order through pagination", () => {
  const options = setup("options_card_display_v0", { title: "Choose", options: [{ title: "First", description: "a", bullets: ["one"] }, { title: "Second", description: "b", bullets: ["two"] }] });
  options.click("Next"); assert(options.root.textContent!.includes("Second")); assert.equal(options.root.querySelector("li")!.textContent, "two"); options.close();
  const trip = setup("itinerary_display_v0", { title: "Trip", days: [{ day_label: "Day 1", stops: [{ name: "Lake", time: "09:00", blurb: "Rest" }] }, { day_label: "Day 2", stops: [{ name: "Hill", time: "10:00", blurb: "Climb" }] }] });
  trip.click("Day 2"); assert(trip.root.textContent!.includes("10:00")); assert(trip.root.textContent!.includes("Hill")); assert(!trip.root.textContent!.includes("Lake")); trip.close();
});

test("product cards keep comparison values and carousel overflow entries", () => {
  const products = [{ name: "One", price: "$2", attributes: [{ label: "Height", value: "20cm" }] }, { name: "Two", blurb: "Second" }, { name: "Three", price: "$4" }];
  const comparison = setup("comparison_card_display_v0", { products }); assert.equal(comparison.root.querySelector("dd")!.textContent, "20cm"); comparison.close();
  const carousel = setup("product_carousel_display_v0", { products }); assert.equal(carousel.root.querySelectorAll(".cloudig-box-product").length, 2);
  carousel.click("Next"); assert(carousel.root.textContent!.includes("Three")); carousel.close();
  const featured = setup("featured_card_display_v0", { products: products.slice(0, 1) }); assert(featured.root.textContent!.includes("$2")); featured.close();
});

test("links use the Reader external-link route; unknown protocols never become anchors", () => {
  const v = setup("link_preview_display_v0", { links: [{ title: "Safe", url: "https://example.org", domain: "example.org", snippet: "Text" }, { title: "Unsafe", url: "javascript:alert(1)", snippet: "Preserved" }] });
  assert.equal(v.root.querySelectorAll("a").length, 1); assert.equal(v.root.querySelector("a")!.dataset["cloudigExternal"], "true"); assert(v.root.textContent!.includes("Unsafe")); v.close();
});

test("compose edits survive variant switches locally and never expose a send button", () => {
  const v = setup("message_compose_v1", { kind: "email", summary_title: "Drafts", variants: [{ label: "A", subject: "Subject", body: "First\nline" }, { label: "B", body: "Other" }] });
  const body = v.root.querySelector("textarea")!; body.value = "Edited locally"; body.dispatchEvent(new v.dom.window.Event("input"));
  v.click("B"); assert.equal(v.root.querySelector("textarea")!.value, "Other"); v.click("A"); assert.equal(v.root.querySelector("textarea")!.value, "Edited locally");
  assert(!Array.from(v.root.querySelectorAll("button")).some(b => /send/i.test(b.textContent!))); v.close();
});

test("saved question answers stay readable, including free text, without a submit action", () => {
  const v = setup("ask_user_input_v0", { questions: [{ type: "single_select", question: "Which?", options: ["A", "B"] }] }, { result: [{ type: "text", text: '{"answers":["Neither; my own answer"]}' }] });
  assert(v.root.textContent!.includes("Neither; my own answer")); assert.equal(v.root.querySelector("button,input"), null); v.close();
  const echo = setup("ask_user_input_v0", { questions: [{ question: "Original?", options: ["A"] }] }, { result: [{ type: "text", text: '{"questions":[{"question":"Original?"}]}' }] });
  assert(!echo.root.textContent!.includes("Saved answers"), "the tool's question echo is not a human answer"); echo.close();
});

test("product galleries retain source ownership and paging reuses their image nodes", () => {
  const v = setup("product_carousel_display_v0", { products: [{ name: "One" }, { name: "Two" }, { name: "Three" }] }, {
    images: [{ source_id: "product_0_0", path: "one.jpg" }, { source_id: "product_0_1", path: "one-detail.jpg" }, { source_id: "product_2_0", path: "three.jpg" }]
  });
  assert.equal(v.root.querySelector(".cloudig-box-product")!.querySelectorAll("img").length, 2);
  assert.equal(v.root.querySelector(".cloudig-gallery-controls"),null);
  v.click("Next"); assert.equal(v.root.querySelector("img")!.alt, "Three"); v.click("Previous"); v.click("Next");
  assert.deepEqual(v.imageRequests, ["one.jpg", "one-detail.jpg", "three.jpg"]); v.close();
});

test("galleries show up to three equal cells per page and reuse images across arbitrary page counts", () => {
  for (const count of [0,1,2,3,4,5,6,7,17]) {
    const paths=Array.from({length:count},(_,index)=>`photo-${index}.jpg`);
    const v=setup("featured_card_display_v0",{products:[{name:"Long title ".repeat(40)}]},{images:paths.map((path,index)=>({source_id:`product_0_${index}`,path}))});
    assert.equal(v.root.querySelectorAll(".cloudig-box-images").length,count?1:0);
    assert.equal(v.imageRequests.length,Math.min(count,3),"only the initially visible page is resolved");
    assert.equal(v.root.querySelectorAll(".cloudig-gallery-stage > img").length,Math.min(count,3));
    if(count>3) {
      const pages=Math.ceil(count/3);
      for(let page=1;page<pages;page++) {
        v.click("Next images"); const first=page*3,end=Math.min(first+3,count),visible=end-first;
        assert.equal(v.root.querySelector(".cloudig-gallery-count")!.textContent,`${first+1}${visible>1?`–${end}`:""} / ${count}`);
        assert.equal(v.root.querySelectorAll(".cloudig-gallery-stage > img").length,visible);
        assert.equal((v.root.querySelector(".cloudig-gallery-stage") as HTMLElement).dataset["visibleCount"],String(visible));
      }
      assert(v.click("Next images").disabled);for(let page=pages-1;page>0;page--)v.click("Previous images");assert(v.click("Previous images").disabled);
      const gallery=v.root.querySelector(".cloudig-box-images")!;
      gallery.dispatchEvent(new v.dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
      assert.equal(v.root.querySelector(".cloudig-gallery-count")!.textContent,`4${count>4?`–${Math.min(6,count)}`:""} / ${count}`);
      v.abort.abort(); gallery.dispatchEvent(new v.dom.window.KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));
      assert.equal(v.root.querySelector(".cloudig-gallery-count")!.textContent,`4${count>4?`–${Math.min(6,count)}`:""} / ${count}`);
    } else assert.equal(v.root.querySelector(".cloudig-gallery-controls"),null);
    assert.deepEqual(v.imageRequests,paths,"every image is reachable and revisiting never reallocates it");v.close();
  }
  for(const [kind,key,prefix] of [["featured_card_display_v0","products","product"],["places_list_display_v0","places","place"]]) {
    const v=setup(kind!,{[key!]:[{name:"One"}]},{images:[{source_id:`${prefix}_9_0`,path:"unassigned.jpg"}]});
    assert.deepEqual(v.imageRequests,["unassigned.jpg"],"an out-of-range association cannot silently erase an image");v.close();
  }
});

test("unrecognized source remains inert and aborted readers cannot page old controls", () => {
  const v = setup("other_platform_quiz", { title: "Unknown", payload: "<img onerror=unsafe()>" }); assert(v.root.textContent!.includes("<img onerror=unsafe()>")); assert.equal(v.root.querySelector("img"), null); v.close();
  const old = setup("step_card_display_v0", { steps: [{ title: "First" }, { title: "Second" }] }); old.abort.abort(); old.click("Next"); assert(old.root.textContent!.includes("First")); old.close();
});
