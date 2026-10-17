import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { JsonObject, JsonValue } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";
import { chatGptLightAdapter } from "../../../src/adapters/parser/chatgpt-light.mts";
import { chatGptFullAdapter } from "../../../src/adapters/parser/chatgpt-full.mts";
import { chatGptTreeAdapter } from "../../../src/adapters/parser/chatgpt-tree.mts";
import { readExporterEnvelope, probeExporterRoute } from "../../../src/adapters/parser/html-envelope.mts";
import { extractMermaidCardsFromFragment } from "../../../src/adapters/parser/reading-evidence.mts";
import { embeddedImageDataUrl } from "../../../src/adapters/parser/embedded-data.mts";
import { normalizeMermaidSource } from "../../../src/adapters/parser/markdown-diagrams.mts";

const rows = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];
const object = (value: JsonValue | undefined): JsonObject => isJsonObject(value) ? value : {};

test("ChatGPT prefers corrected captured prices/math and keeps search excerpts literal", async () => {
  const snippet = "Price $0.435/$0.87; `echo $HOME`; <b>plain quote</b>";
  const html = '<div class="answer"><p>Price $0.435/$0.87 <span class="osis-emoji">👩🏽‍💻✨</span></p><math><mi>x</mi><mo>+</mo><mn>1</mn></math></div>';
  const draft = await chatGptLightAdapter.parse({
    manifest: {}, source: { file: "capture.html", bytes: 1, sha256: "0".repeat(64) },
    payload: { items: [
      { kind: "tool", message_id: "tool", name: "web.run", text: snippet, sources: [{ url: "https://example.com/quote", snippet }] },
      { kind: "assistant", message_id: "answer", parts: [{ type: "md", text: "Fallback must not replace saved typography" }] }
    ] },
    reading: { fragments: [{ messageId: "answer", html }], mermaid: [], images: [], files: [] }
  });
  const blocks = rows(draft["messages"]).flatMap(message => rows(message["content"]));
  const rich = blocks.find(block => block["type"] === "html")!;
  assert.match(String(rich["html"]), /Price \$0\.435\/\$0\.87/u);
  assert.match(String(rich["html"]), /class="osis-emoji">👩🏽‍💻✨/u);
  assert.match(String(rich["html"]), /<math><mi>x<\/mi><mo>\+<\/mo><mn>1<\/mn><\/math>/u);
  assert.doesNotMatch(JSON.stringify(blocks), /Fallback must not/u);
  assert.equal(blocks.find(block => block["kind"] === "result")!["output"], snippet);
  assert.equal(rows(draft["sources"])[0]!["snippet"], snippet);
});

test("all ChatGPT profiles retain captured nested links, link titles and literal escaped emphasis", async () => {
  const url = "https://example.com/article_(part)?utm_source=a_b";
  const saved = `<p><a href="${url}" title="A quoted title">Link</a> **Meaning:** <code>$x$</code></p><math><mi>x</mi><mo>+</mo><mn>1</mn></math>`;
  const items: JsonObject[] = ["user", "assistant"].map(kind => ({ kind, message_id: kind, node_id: kind,
    parts: [{ type: "md", text: "The saved HTML is the presentation evidence" }] }));
  const captured = (kind: string) => `<article data-message-id="${kind}"><div class="${kind === "user" ? "user-bubble" : "answer"}">${saved}</div></article>`;
  for (const adapter of [chatGptLightAdapter, chatGptFullAdapter, chatGptTreeAdapter]) {
    const tree = adapter === chatGptTreeAdapter;
    const payload: JsonObject = tree ? {
      turns: { user: { id: "user", children: ["assistant"], node_ids: ["user"], role: "user" },
        assistant: { id: "assistant", parent: "user", children: [], node_ids: ["assistant"], role: "assistant" } },
      turn_roots: ["user"], current_turn: "assistant",
      items_by_node: { user: [items[0]!], assistant: [items[1]!] },
      rendered_turns: { user: captured("user"), assistant: captured("assistant") }
    } : { items };
    const draft = await adapter.parse({ manifest: {}, source: { file: "links.html", bytes: 1, sha256: "0".repeat(64) }, payload,
      reading: { fragments: ["user", "assistant"].map(messageId => ({ messageId, html: captured(messageId) })), mermaid: [], images: [], files: [] } });
    const html = rows(draft["messages"]).flatMap(message => rows(message["content"])).filter(block => block["type"] === "html");
    assert.equal(html.length, 2, adapter.manifest.id);
    for (const block of html) {
      const fragment = JSDOM.fragment(String(block["html"]));
      assert.equal(fragment.querySelector("a")?.getAttribute("href"), url);
      assert.equal(fragment.querySelector("a")?.getAttribute("title"), "A quoted title");
      assert.match(fragment.textContent ?? "", /\*\*Meaning:\*\*/u);
      assert.equal(fragment.querySelectorAll("strong").length, 0);
      assert.equal(fragment.querySelector("code")?.textContent, "$x$");
      assert.equal(fragment.querySelectorAll("math").length, 1);
      assert.equal(fragment.querySelector("math")?.textContent, "x+1");
    }
  }
});

const sample = process.env["CLOUDIG_RECORD_SAMPLE"];
test("latest ChatGPT exports retain exact diagrams, quoted excerpts, tools and scheduled task settings", { skip: !sample }, async () => {
  const waterline = JSON.parse(await readFile(new URL("../../../src/adapters/parser/contracts/sample-waterline.json", import.meta.url), "utf8"));
  let files = 0, diagrams = 0, snippets = 0, tasks = 0;
  const profiles = new Set<string>();
  for (const file of (await readdir(sample!)).filter(file => file.endsWith(".html"))) {
    const filePath = path.join(sample!, file);
    if ((await probeExporterRoute(filePath))?.["platform"] !== "chatgpt") continue;
    const envelope = await readExporterEnvelope({ filePath });
    const { manifest, payload, reading, adapter } = envelope;
    const profile = adapter.manifest.routes[0]!.profile;
    const version = manifest["exporter_version"] ?? object(manifest["exporter"])["version"];
    assert.ok(waterline.routes.find((route: { platform: string; profile: string; exporter_versions: string[] }) => route.platform === "chatgpt" && route.profile === profile)?.exporter_versions.includes(version), "sample versions must be covered by the current waterline");
    const draft = await adapter.parse({ manifest, payload, reading, source: { file, ...envelope.fingerprint } });
    const blocks = rows(draft["messages"]).flatMap(message => rows(message["content"]));
    const items = rows(payload["items"]).length ? rows(payload["items"]) : Object.values(object(payload["items_by_node"])).flatMap(rows);
    const outputs = new Set(blocks.filter(block => block["type"] === "tool" && block["kind"] === "result").map(block => block["output"]));
    for (const item of items) if (item["kind"] === "tool" && typeof item["text"] === "string" && item["text"].trim()) assert.ok(outputs.has(item["text"]), "tool text must survive literally");
    const retained = new Set(rows(draft["sources"]).map(source => source["snippet"]));
    for (const source of items.flatMap(item => [...rows(item["sources"]), ...rows(item["memory_sources"])])) {
      if (typeof source["snippet"] !== "string" || !source["snippet"].trim()) continue;
      if (!source["kind"] && !/^https?:\/\//u.test(String(source["url"] ?? ""))) continue;
      assert.ok(retained.has(source["snippet"]), "quoted text must not be parsed as Markdown or truncated"); snippets++;
    }
    const rendered = Object.entries(object(payload["rendered_turns"])).flatMap(([id, value]) => typeof value === "string" ? extractMermaidCardsFromFragment(value, id) : []);
    const expected = (rendered.length ? rendered : reading.mermaid).map(card => `${normalizeMermaidSource(card.source)}\0${embeddedImageDataUrl(card.dataUrl).sha256}`).sort();
    const resources = new Map(rows(draft["resources"]).map(resource => [resource["id"], resource]));
    const actual = blocks.filter(block => block["type"] === "diagram" && block["format"] === "mermaid" && block["rendered"]).map(block => `${normalizeMermaidSource(String(block["source"] ?? ""))}\0${resources.get(block["rendered"])?.["sha256"]}`).sort();
    assert.deepEqual(actual, expected, "every saved diagram keeps its exact SVG and matching source"); diagrams += actual.length;
    const components = object(payload["scheduled_components"]), originalTasks = object(components["tasks"]);
    const lists = blocks.filter(block => block["name"] === "schedule" && object(block["input"])["kind"] === "task-list");
    assert.equal(lists.length, rows(components["lists"]).length);
    for (const block of lists) for (const task of rows(object(block["input"])["tasks"])) {
      const original = object(task["source_task"]);
      assert.deepEqual(original, originalTasks[String(original["id"])]); tasks++;
    }
    assert.equal(rows(draft["limitations"]).length, 0);
    files++; profiles.add(profile);
  }
  assert.equal(files, 4); assert.deepEqual(profiles, new Set(["light", "full", "tree"]));
  assert.equal(diagrams, 24); assert.equal(tasks, 3); assert.equal(snippets, 509);
  console.log(JSON.stringify({ chatgpt_compatibility: { files, exact_diagrams: diagrams, exact_quoted_excerpts: snippets, exact_task_settings: tasks } }));
});
