import assert from "node:assert/strict";
import test from "node:test";
import { claudeInteractive } from "../../../src/adapters/parser/claude-interactive.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

function project(block: JsonObject, result?: JsonObject) {
  const files: Array<{ name: string; source: string; mime: string }> = [];
  return { view: claudeInteractive(block, result, (name, source, mime) => { files.push({ name, source, mime }); return `r${files.length}`; }), files };
}
test("native content uses full site/native-type source and never exporter preview HTML as layout", () => {
  const input = { source_text: "line1\nline2", translation: "first\nsecond", source_language: "English", target_language: "French" };
  const block = { type: "tool_use", id: "t1", name: "translation_display_v0", input, native_card: { kind: "translation", title: "Translate", html: "<h1>WRONG EXPORTER LAYOUT</h1>" } };
  const original = JSON.stringify(block), { view, files } = project(block);
  assert.deepEqual(view, { type: "interactive", source: "claude.ai_translation_display_v0", title: "Translate", display: "box", format: "structured", data: { input } });
  assert.equal(JSON.stringify(block), original); assert.equal(files.length, 0);
});
test("quiz fields/answers and weather result survive without inventing absent facts", () => {
  for (const kind of ["quiz", "weather", "ask_user_input"]) {
    const input = { questions: [{ prompt: "Q", options: [{ id: "a", text: "A" }], hint: "Hint", explanation: "Explain" }] };
    const content = [{ type: "text", text: '{"answer":"A"}' }];
    const { view } = project({ name: `${kind}_display_v0`, input, native_card: { kind } }, { content });
    assert.deepEqual(view?.["data"], { input, result: content });
    assert.equal(JSON.stringify(view).includes("correct_option_id"), false);
  }
});
test("all accepted structured card families have an inert Box representation", () => {
  for (const kind of ["translation", "recipe", "quiz", "step_card", "options_card", "comparison_card", "featured_card", "product_carousel", "itinerary", "link_preview", "message_compose", "chart", "weather", "places_map", "places_list", "ask_user_input"]) {
    assert.equal(project({ input: { sample: kind }, name: `${kind}_display_v0`, native_card: { kind } }).view?.["display"], "box");
  }
  assert.equal(project({ input: { sample: true }, native_card: { kind: "unknown" } }).view, undefined);
});
test("Visualize preserves original source; heavy runtime starts as Window, simple widget as Box", () => {
  for (const code of ['<script src="https://cdn.example.test/three.js"></script>', '<script type="module">import x from "x"</script>', '<canvas/><script>requestAnimationFrame(draw)</script>', '<script>new AudioContext()</script>']) {
    const { view, files } = project({ name: "mcp__visualize__show_widget", input: { widget_code: code }, native_card: { kind: "visualize" } });
    assert.equal(view?.["display"], "window"); assert.equal(view?.["source"], "claude.ai_visualize"); assert.equal(files[0]!.source, code);
  }
  const code = '<button onclick="count++">Pulse</button><script>let count=0</script>';
  const { view, files } = project({ input: { widget_code: code }, native_card: { kind: "visualize" } });
  assert.equal(view?.["display"], "box"); assert.equal(files[0]!.source, code);
});
test("document groups retain relative paths and identify the real manifest, not a fabricated HTML editor", () => {
  for (const [kind, entry, format] of [["docs", "document.xml", "document"], ["slides", "project/deck.json", "slides"], ["design", "project/Main.dc.html", "design"], ["design-system", "project/design-system.json", "design-system"]]) {
    const { view, files } = project({ native_card: { kind: kind!, files: [{ name: entry!, source: "original source" }, { name: "project/assets/data.txt", source: "" }] } });
    assert.equal(view?.["entry"], entry); assert.equal(view?.["format"], format); assert.equal(view?.["display"], "window");
    assert.equal(files.length, 2); assert.equal(files[1]!.source, "");
  }
  for (const files of [[{ name: "../deck.json", source: "{}" }], [{ name: "deck.json", source: "{}" }, { name: "deck.json", source: "[]" }], [{ name: "page.html", source: "ok" }]]) {
    const result = project({ native_card: { kind: "slides", files } }); assert.equal(result.view, undefined); assert.equal(result.files.length, 0);
  }
});
