import assert from "node:assert/strict";
import test from "node:test";
import { claudeDeliveries } from "../../../src/adapters/parser/claude-deliveries.mts";
import { ClaudeResourceData } from "../../../src/adapters/parser/claude-resource-data.mts";
import { claudeInteractive } from "../../../src/adapters/parser/claude-interactive.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const deck = '{"order":["cover"]}', cover = '<section id="cover">Slide</section>';
const data = new ClaudeResourceData({ resource_data: { a: `data:application/json;base64,${Buffer.from(deck).toString("base64")}`, b: `data:text/html;base64,${Buffer.from(cover).toString("base64")}` } }, true);
const reading = '<div class="markdown"><p>Before</p><section class="native-card native-published-artifact" data-osis-native-card="slides"><header>Deck · Slides</header><div class="native-card-body">'
  + '<section class="native-file-entry"><div class="native-file-head"><span>deck.json</span><a download="deck.json" data-osis-data-href="a">Save</a></div></section>'
  + '<section class="native-file-entry"><div class="native-file-head"><span>cover.html</span><a download="cover.html" data-osis-data-href="b">Save</a></div></section></div></section><p>After</p></div>';
const message: JsonObject = { blocks: [{ type: "text", rich_html: '<p>Before</p><span data-osis-native-card-id="dom-card"></span><p>After</p>' }],
  dom_native_cards: [{ id: "dom-card", kind: "published-artifact", title: "Deck" }, { id: "unused-synthetic-alias", kind: "published-artifact", title: "Deck" }] };

test("new DOM summaries recover one complete file group at the declared delivery marker, not synthetic aliases", () => {
  const before = JSON.stringify(message), result = claudeDeliveries(message, reading, tree => data.restoreReading(tree));
  assert.deepEqual([...result.cards.keys()], ["dom-card"]);
  const written: unknown[] = [];
  const view = claudeInteractive({ native_card: result.cards.get("dom-card")! }, undefined, (name, source, mime, dataUrl) => { written.push({ name, source, mime, dataUrl }); return `r${written.length}`; });
  assert.equal(view?.["format"], "slides"); assert.equal(view?.["entry"], "deck.json"); assert.equal(written.length, 2);
  assert.ok(result.readingHtml?.includes('data-osis-native-card-id="dom-card"')); assert.equal(JSON.stringify(message), before);
});
test("Light uses the captured message-owned delivery without inventing an API identity or dropping source files", () => {
  const result = claudeDeliveries({ blocks: [{ type: "text", markdown: "Before After" }] }, reading, tree => data.restoreReading(tree));
  assert.equal(result.cards.size, 1); assert.equal((result.cards.get("reading-card:0")!["files"] as unknown[]).length, 2);
});
test("mismatched order/count/descriptor and unowned or remote files never become a guessed group", () => {
  for (const changed of [reading.replace("Deck ·", "Another ·"), reading + reading, reading.replace('data-osis-data-href="a"', 'href="https://example.test/file"')]) {
    assert.equal(claudeDeliveries(message, changed, tree => data.restoreReading(tree)).cards.size, 0);
  }
  assert.equal(claudeDeliveries(message, undefined, () => {}).cards.size, 0);
});
test("published artifact-files keep all relative dependencies and refuse ambiguous executable entry points", () => {
  const files = [{ name: "index.html", source: "<h1>Hello</h1>" }, { name: "styles/main.css", source: "h1{color:orange}" }];
  const view = claudeInteractive({ native_card: { kind: "artifact-files", files } }, undefined, name => name);
  assert.equal(view?.["entry"], "index.html"); assert.equal((view?.["files"] as unknown[]).length, 2);
  assert.equal(claudeInteractive({ native_card: { kind: "artifact-files", files: [...files, { name: "other.html", source: "Other" }] } }, undefined, name => name), undefined);
});
