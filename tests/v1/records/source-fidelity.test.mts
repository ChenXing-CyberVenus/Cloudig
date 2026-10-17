import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { mkdir, mkdtemp, readdir, realpath, rm, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseStreamingJson } from "../../../src/adapters/parser/json-object-stream.mts";
import { readExporterEnvelope } from "../../../src/adapters/parser/html-envelope.mts";
import { parseChatGptItems, parseChatGptTree, CHATGPT_LIGHT_MANIFEST } from "../../../src/adapters/parser/chatgpt-light.mts";
import { extractHtmlRecord } from "../../../src/app/parser/record-source.mts";
import { assembleConversationRecord, type SourceRecordFacts } from "../../../src/app/parser/conversation-record.mts";
import type { AdapterParseContext, SourceMessageFacts } from "../../../src/app/parser/adapter.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { frontName } from "../../../src/core/records/front.mts";
import { parseJsonRange } from "../../../src/adapters/parser/json-array-stream.mts";
import { extractClaudeRecord } from "../../../src/app/parser/record-source.mts";
import { geminiLightAdapter, geminiFullAdapter } from "../../../src/adapters/parser/gemini.mts";
import { chatGptFullAdapter } from "../../../src/adapters/parser/chatgpt-full.mts";
import { grokLightAdapter, grokFullAdapter, grokTreeAdapter } from "../../../src/adapters/parser/grok.mts";
import { claudeLightAdapter, claudeFullAdapter, claudeTreeAdapter } from "../../../src/adapters/parser/claude-web.mts";
import { doubaoLightAdapter, doubaoFullAdapter } from "../../../src/adapters/parser/doubao.mts";
import { deepSeekLightAdapter, deepSeekFullAdapter, deepSeekTreeAdapter } from "../../../src/adapters/parser/deepseek.mts";
import { kimiLightAdapter, kimiFullAdapter, kimiTreeAdapter } from "../../../src/adapters/parser/kimi.mts";
import { mistralLightAdapter, mistralFullAdapter, mistralTreeAdapter } from "../../../src/adapters/parser/mistral.mts";
import { chatGlmLightAdapter, chatGlmFullAdapter } from "../../../src/adapters/parser/chatglm.mts";
import { zaiFullAdapter } from "../../../src/adapters/parser/zai.mts";
import { yuanbaoLightAdapter, yuanbaoFullAdapter } from "../../../src/adapters/parser/yuanbao.mts";
import { htmlResourceImages } from "../../../src/core/records/html-resources.mts";
import { extractStaticReadingEvidence } from "../../../src/adapters/parser/reading-evidence.mts";

const timestamp = "2026-09-11T17:00:00Z";
const obj = (v: unknown): JsonObject => v as JsonObject;
const rows = (v: unknown): JsonObject[] => Array.isArray(v) ? v as JsonObject[] : Object.values(obj(v ?? {})) as JsonObject[];

test("Kimi and Mistral references retain distinct excerpts of the same page", async () => {
  for (const adapter of [kimiLightAdapter, kimiFullAdapter, kimiTreeAdapter, mistralLightAdapter, mistralFullAdapter, mistralTreeAdapter]) {
    const references = [
      { url: "https://example.test/article", title: "Same page", snippet: "First quoted passage" },
      { url: "https://example.test/article", title: "Same page", snippet: "Different quoted passage" },
      { url: "https://example.test/article", title: "Same page", snippet: "First quoted passage" }
    ];
    const draft = await adapter.parse({ manifest: {}, source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) }, payload: {
      messages: [{ id: "m", role: "assistant", content_markdown: "Answer", api: { blocks: [{ type: "text", value: { content: "Answer" } }] }, sources: references, references }],
      message_order: adapter.manifest.family === "mistral" ? [{ id: "m", version: 0 }] : ["m"], tree: { nodes: [{ id: "m", role: "assistant" }] }
    } });
    assert.deepEqual((draft["sources"] as JsonObject[]).map(s => s["snippet"]), ["First quoted passage", "Different quoted passage"], adapter.manifest.id);
  }
});

test("named file bytes never fall back to a differently named attachment", async t => {
  for (const adapter of [chatGlmFullAdapter, zaiFullAdapter, yuanbaoFullAdapter, mistralFullAdapter]) await t.test(adapter.manifest.id, async () => {
    const draft = await adapter.parse({ manifest: {}, source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) }, payload: {
      messages: [{ id: "m", role: "user", content_markdown: "Files", attachments: [{ kind: "file", name: "first.txt" }, { kind: "file", name: "second.txt" }] }],
      message_order: adapter.manifest.family === "mistral" ? [{ id: "m", version: 0 }] : ["m"]
    }, reading: { images: [], mermaid: [], files: [{ messageId: "m", name: "second.txt", dataUrl: "data:text/plain;base64,c2Vjb25k" }], fragments: [{ messageId: "m", html: "<p>Files</p>" }] } });
    const resources = new Map((draft["resources"] as JsonObject[]).map(r => [r["id"], r]));
    const attachments = ((draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]).filter(b => b["type"] === "attachment").map(b => resources.get(b["resource"])!);
    assert.deepEqual(attachments.map(r => [r["name"], r["availability"]]), [["first.txt", "metadata_only"], ["second.txt", "embedded"]]);
    assert.equal(Buffer.from((attachments[1]!["data_base64"] as string[]).join(""), "base64").toString("utf8"), "second");
  });
});

test("Kimi Tree rejects an unreachable cycle instead of silently dropping its nodes", async () => {
  await assert.rejects(kimiTreeAdapter.parse({ manifest: {}, source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) }, payload: {
    messages: [{ id: "root", role: "user" }], message_order: ["root"], tree: { nodes: [
      { id: "root", role: "user" }, { id: "a", parent_id: "b", role: "assistant" }, { id: "b", parent_id: "a", role: "user" }
    ] }
  } }) as Promise<JsonObject>, /Kimi Tree/u);
});

test("Mistral tool arguments keep the complete captured input rather than the short query", async () => {
  const argumentsText = '{\n  "query": "clouds",\n  "date_range": "last_year",\n  "limit": 20\n}';
  for (const adapter of [mistralLightAdapter, mistralFullAdapter, mistralTreeAdapter]) {
    const draft = await adapter.parse({ manifest: {}, source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) }, payload: {
      messages: [{ id: "m", role: "assistant", tools: [{ name: "web_search", query: "clouds", arguments_text: argumentsText }] }], message_order: [{ id: "m", version: 0 }]
    } });
    const tool = ((draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]).find(b => b["type"] === "tool")!;
    assert.equal(tool["input"], argumentsText, adapter.manifest.id);
  }
});

test("Gemini missing images cannot borrow a later image or another message's metadata", async () => {
  const dataUrl = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
  for (const adapter of [geminiLightAdapter, geminiFullAdapter]) {
    const full = adapter === geminiFullAdapter;
    const draft = await adapter.parse({ manifest: {}, source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) },
      payload: { images: [
        { key: "missing", name: "missing.png", alt: "Same preview", availability: "unavailable" },
        { key: "later", name: "later.png", alt: "Same preview", availability: "embedded_original", ...(full ? { data_url: dataUrl } : {}) },
        { key: "now", name: "now.png", alt: "Same preview", availability: "embedded_original", ...(full ? { data_url: dataUrl } : {}) }
      ], messages: [
        { source_id: "m0", role: "user", html: '<osis-image data-key="missing"></osis-image><osis-image data-key="now"></osis-image>',
          attachments: [{ kind: "image", image_key: "missing" }] },
        { source_id: "m1", role: "assistant", html: '<osis-image data-key="later"></osis-image>' }
      ] }, reading: { images: ["m0", "m1"].map(messageId => ({ messageId, dataUrl, alt: "Same preview" })), files: [], mermaid: [], fragments: [] } });
    const resources = new Map((draft["resources"] as JsonObject[]).map(r => [r["id"], r]));
    const messageImages = (draft["messages"] as JsonObject[]).map(m => (m["content"] as JsonObject[]).filter(b => b["type"] === "image").map(b => resources.get(b["resource"])!));
    assert.deepEqual(messageImages.map(images => images.map(r => [r["name"], r["availability"]])), [
      [["missing.png", "missing"], ["now.png", "embedded"]], [["later.png", "embedded"]]
    ], adapter.manifest.id);
  }
});

test("Grok unavailable or different Full images cannot consume another captured image", async () => {
  const dataUrl = (label: string) => "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>`).toString("base64");
  for (const adapter of [grokLightAdapter, grokFullAdapter, grokTreeAdapter]) {
    const full = adapter !== grokLightAdapter;
    const items = [{ response_id: "m", source_id: "response-m", role: "user", raw_message: "Images", attachments: [
      { resource_key: "missing", kind: "image" }, { resource_key: "a", kind: "image" }, { resource_key: "b", kind: "image" }
    ] }];
    const draft = await adapter.parse({ manifest: {}, source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) }, payload: {
      messages: items, nodes: items, resources: [
        { key: "missing", kind: "image", name: "Missing", availability: "unavailable" },
        { key: "a", kind: "image", name: "A", ...(full ? { data_url: dataUrl("A") } : {}), availability: "embedded_original" },
        { key: "b", kind: "image", name: "B", data_url: dataUrl("B"), availability: "embedded_original" }
      ] }, reading: { images: [{ messageId: "response-m", resourceKey: "b", alt: "B", dataUrl: dataUrl("B") }], files: [], mermaid: [], fragments: [] } });
    const resources = new Map((draft["resources"] as JsonObject[]).map(r => [r["id"], r]));
    const images = ((draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]).filter(b => b["type"] === "image").map(b => resources.get(b["resource"])!);
    assert.equal(images[0]!["availability"], "missing", adapter.manifest.id);
    assert.equal(images[1]!["availability"], full ? "embedded" : "metadata_only");
    if (full) assert.match(Buffer.from((images[1]!["data_base64"] as string[]).join(""), "base64").toString("utf8"), /<title>A<\/title>/u);
    assert.match(Buffer.from((images[2]!["data_base64"] as string[]).join(""), "base64").toString("utf8"), /<title>B<\/title>/u);
  }
});

test("DeepSeek separate FILE fragments keep only their own attachments at the original position", async () => {
  for (const adapter of [deepSeekLightAdapter, deepSeekFullAdapter, deepSeekTreeAdapter]) {
    const draft = await adapter.parse({ manifest: {}, source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) }, payload: { items: [{
      message_id: "m", role: "user", raw_fragments: [
        { type: "FILE", files: [{ id: "a", file_name: "first.txt" }] },
        { type: "REQUEST", content: "Between the two files" },
        { type: "FILE", files: [{ id: "b", file_name: "second.txt" }] }
      ], attachments: [{ id: "a", name: "first.txt" }, { id: "b", name: "second.txt" }]
    }] } });
    const resources = new Map((draft["resources"] as JsonObject[]).map(r => [r["id"], r]));
    const content = ((draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]);
    assert.deepEqual(content.map(b => b["type"] === "attachment" ? resources.get(b["resource"])!["name"] : b["text"]),
      ["first.txt", "Between the two files", "second.txt"], adapter.manifest.id);
  }
});

test("ChatGPT Full byte deduplication does not erase attachment names or image dimensions", async () => {
  const file = (name: string) => ({ type: "attachment", name, src: "data:text/plain;base64,aGVsbG8=", mime_type: "text/plain", embedded_size: 5 });
  const image = (name: string, width: number) => ({ type: "img", name, width, height: 1, src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" });
  const draft = await chatGptFullAdapter.parse({ manifest: {}, payload: { items: [{ kind: "user", parts: [file("first.txt"), file("second.txt"), file("first.txt"), image("First image", 10), image("Second image", 20)] }] },
    source: { file: "source.html", bytes: 1, sha256: "0".repeat(64) } });
  const content = (draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
  const resources = new Map((draft["resources"] as JsonObject[]).map(r => [r["id"], r]));
  assert.deepEqual(content.slice(0, 3).map(b => resources.get(b["resource"])!["name"]), ["first.txt", "second.txt", "first.txt"]);
  assert.equal(content[0]!["resource"], content[2]!["resource"], "Identical bytes and metadata still share one resource");
  assert.deepEqual(content.slice(3).map(b => resources.get(b["resource"])!["name"]), ["First image", "Second image"]);
  assert.deepEqual(content.slice(3).map(b => (resources.get(b["resource"])!["dimensions"] as JsonObject)["width"]), [10, 20]);
});

test("Grok tool calls from separate messages keep separate identities through Conversation assembly", async () => {
  const names = ["webSearch", "codeExecution"];
  const items = names.map((name, index) => ({ role: "assistant", source_id: `response-m${index}`, response_id: `m${index}`, ...(index ? { parent_response_id: "m0" } : {}), raw_message: name }));
  const responses = names.map((name, index) => ({ responseId: `m${index}`, steps: [{
    toolUsageCards: [{ toolUsageCardId: `vendor-${index}`, [name]: { input: name } }],
    toolUsageResults: [{ toolUsageCardId: `vendor-${index}`, [name]: { output: name } }]
  }] }));
  for (const adapter of [grokLightAdapter, grokFullAdapter, grokTreeAdapter]) {
    const draft = await adapter.parse({ manifest: {}, payload: { messages: items, nodes: items, raw_api: { responses } }, source: { file: "source.html", bytes: 1, sha256: "1".repeat(64) } });
    const record = assembleConversationRecord({ parsed: { draft, adapter: adapter.manifest, sourceFingerprint: { bytes: 1, sha256: "1".repeat(64) }, systemLogErrors: [] }, facts: {}, parserVersion: "1.1.5", timestamp });
    const fronts = new Map((record["identity"] as JsonObject[]).map(f => [f["source_id"], f]));
    const messages = (record["messages"] as JsonObject)["items"] as JsonObject[];
    const calls: string[] = [];
    for (const [i, message] of messages.entries()) {
      const tools = (message["content"] as JsonObject[]).filter(b => b["type"] === "tool");
      assert.deepEqual(tools.map(b => frontName(fronts.get(b[b["kind"] === "result" ? "speaker" : "recipient"]))), [names[i], names[i]], adapter.manifest.id);
      assert.equal(tools[0]!["call"], tools[1]!["call"]); calls.push(String(tools[0]!["call"]));
    }
    assert.equal(new Set(calls).size, 2);
  }
});

test("a Claude inline image cannot split its table into incomplete independent fragments", async () => {
  const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Ccircle cx='4' cy='4' r='4'/%3E%3C/svg%3E";
  const html = `<table><tbody><tr><td>Before<img src="${image}" alt="Cell picture">After</td><td>Other cell</td></tr></tbody></table>`;
  const draft = await claudeFullAdapter.parse({ manifest: {}, payload: { messages: [{ id: "m1", role: "assistant", blocks: [{ type: "text", rich_html: html }] }] },
    source: { file: "source.html", bytes: 1, sha256: "1".repeat(64) } });
  const content = (draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
  const tables = content.filter(b => b["type"] === "html").map(b => parseFragment(String(b["html"])));
  const cells: string[] = [];
  const plain = (n: DefaultTreeAdapterTypes.Node): string => "value" in n ? n.value : "childNodes" in n ? n.childNodes.map(plain).join("") : "";
  const visit = (n: DefaultTreeAdapterTypes.ParentNode): void => { for (const child of n.childNodes) if ("tagName" in child) { if (child.tagName === "td") cells.push(plain(child)); else visit(child); } };
  tables.forEach(visit);
  assert.deepEqual(cells, ["BeforeAfter", "Other cell"]);
});

test("all rich-fragment profiles keep inline pictures inside their table, list and paragraph", async t => {
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=";
  for (const adapter of [claudeLightAdapter, claudeFullAdapter, claudeTreeAdapter, doubaoLightAdapter, doubaoFullAdapter, kimiLightAdapter, kimiFullAdapter, kimiTreeAdapter,
    chatGlmLightAdapter, chatGlmFullAdapter, yuanbaoLightAdapter, yuanbaoFullAdapter, mistralLightAdapter, mistralFullAdapter, mistralTreeAdapter, geminiLightAdapter, geminiFullAdapter]) await t.test(adapter.manifest.id, async () => {
    const gemini = adapter.manifest.family === "gemini", picture = `<img src="${image}" alt="Inline picture" width="24"${gemini ? ' class="attachment"' : ""}>`;
    const html = `<div class="rich-content"><table><tr><td>Before${picture}After</td></tr></table><ul><li>List${picture}End</li></ul><p>${picture}</p></div>`;
    const message = { id: "m", source_id: "m", role: "assistant", html, blocks: [{ type: "text", rich_html: html }], ...(gemini ? { attachments: [0, 1, 2].map(index => ({ kind: "image", image_key: `i${index}`, name: "Inline picture" })) } : {}) };
    const draft = await adapter.parse({ manifest: {}, payload: { messages: [message], message_order: adapter.manifest.family === "mistral" ? [{ id: "m", version: 0 }] : ["m"], tree: { nodes: [message] },
      ...(gemini ? { images: [0, 1, 2].map(index => ({ key: `i${index}`, name: "Inline picture", alt: "Inline picture", availability: "embedded_original", ...(adapter === geminiFullAdapter ? { data_url: image } : {}) })) } : {}) },
      source: { file: "inline.html", bytes: 1, sha256: "1".repeat(64) }, reading: { images: gemini ? [0, 1, 2].map(() => ({ messageId: "m", dataUrl: image, alt: "Inline picture" })) : [], mermaid: [], files: [], fragments: [{ messageId: "m", messageVersion: "0", html }] } });
    const blocks = rows(rows(draft["messages"])[0]!["content"]), stored = blocks.filter(b => b["type"] === "html").map(b => String(b["html"])).join("");
    const references = htmlResourceImages(stored), resources = new Map(rows(draft["resources"]).map(r => [r["id"], r]));
    assert.equal(references.length, 3, stored); assert(!stored.includes("base64,"));
    for (const reference of references) { assert.equal(resources.get(reference.id)?.["availability"], "embedded"); assert.equal(reference.alt, "Inline picture"); }
    const cells: string[] = [], entries: string[] = [];
    const plain = (n: DefaultTreeAdapterTypes.Node): string => "value" in n ? n.value : "childNodes" in n ? n.childNodes.map(plain).join("") : "";
    const visit = (n: DefaultTreeAdapterTypes.ParentNode): void => { for (const child of n.childNodes) if ("tagName" in child) { if (child.tagName === "td") cells.push(plain(child)); if (child.tagName === "li") entries.push(plain(child)); visit(child); } };
    visit(parseFragment(stored)); assert.deepEqual(cells, ["BeforeAfter"]); assert.deepEqual(entries, ["ListEnd"]);
  });
});

test("Claude artifacts retain separate captured versions across messages even when the artifact ID repeats", async () => {
  const draft = await claudeFullAdapter.parse({ manifest: {}, payload: {
    messages: ["one", "two"].map(id => ({ id, role: "assistant", blocks: [{ type: "text", markdown: id }] })),
    artifacts: ["one", "two"].map(message_id => ({ id: "same-artifact", message_id, name: "result.txt", extension: "txt", file_data_url: `data:text/plain;base64,${Buffer.from(message_id).toString("base64")}` }))
  }, source: { file: "source.html", bytes: 1, sha256: "1".repeat(64) } });
  const resources = new Map((draft["resources"] as JsonObject[]).map(r => [r["id"], r]));
  const captured = (draft["messages"] as JsonObject[]).map(m => {
    const block = (m["content"] as JsonObject[]).find(b => b["type"] === "attachment")!;
    return Buffer.from((resources.get(block["resource"])!["data_base64"] as string[]).join(""), "base64").toString("utf8");
  });
  assert.deepEqual(captured, ["one", "two"]);
});

test("public task lists retain every checked and unchecked state in source order", async () => {
  const sourceRoot = path.resolve("src/ui/documents/examples/html"); let files = 0, marks = 0;
  const temporaryRoot = path.resolve("tests/private/schema-rebuild"); await mkdir(temporaryRoot, { recursive: true });
  const states = (tree: DefaultTreeAdapterTypes.ParentNode, output: boolean[], captured: boolean): void => {
    for (const node of tree.childNodes) if ("tagName" in node) {
      if (captured && node.tagName === "input" && node.attrs.some(a => a.name === "type" && a.value === "checkbox")) output.push(node.attrs.some(a => a.name === "checked"));
      if (!captured && node.tagName === "span" && node.attrs.some(a => a.name === "data-cloudig-inert" && a.value === "input")) {
        const value = node.childNodes.map(n => "value" in n ? n.value : "").join("");
        assert(["☑", "☐"].includes(value), "A saved checkbox must retain its state"); output.push(value === "☑");
      }
      states(node, output, captured);
    }
  };
  for (const file of (await readdir(sourceRoot)).filter(f => f.endsWith(".html"))) {
    const filePath = path.join(sourceRoot, file), expected: boolean[] = [];
    states(parse(await readFile(filePath, "utf8")), expected, true);
    if (!expected.length) continue;
    const extracted = await extractHtmlRecord({ filePath, temporaryRoot });
    const record = assembleConversationRecord({ ...extracted, parserVersion: "1.1.5", timestamp });
    const actual: boolean[] = [];
    for (const message of (record["messages"] as JsonObject)["items"] as JsonObject[]) for (const block of message["content"] as JsonObject[]) {
      if (block["type"] === "html") states(parseFragment(String(block["html"])), actual, false);
      else if (block["format"] === "html") states(parseFragment(String(block["text"])), actual, false);
    }
    assert.deepEqual(actual, expected, file); files++; marks += actual.length;
  }
  assert(files > 0 && marks > 0); console.log(JSON.stringify({ task_list_files: files, exact_task_states: marks }));
});

test("Full image and diagram evidence is not rejected by stream chunk boundaries or an 8 MiB tag cap", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><desc>${"x".repeat(7 * 1024 * 1024)}</desc><rect width="2" height="2"/></svg>`;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  for (const diagram of [false, true]) {
    const image = `<img src="${dataUrl}" alt="Complete large image">`;
    const html = `<article data-message-id="m">${diagram ? `<section class="osis-mermaid-card"><code>graph TD; A--&gt;B</code>${image}</section>` : image}<p>After</p></article>`;
    const bytes = Buffer.from(html);
    for (const size of [bytes.length, 64 * 1024]) {
      const stream = Readable.from((function* () { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); })());
      const evidence = await extractStaticReadingEvidence(stream);
      assert.equal(evidence.fragments.length, 1);
      assert(evidence.fragments[0]!.html.endsWith("<p>After</p>"));
      assert.equal(diagram ? evidence.mermaid[0]?.dataUrl : evidence.images[0]?.dataUrl, dataUrl);
      if (diagram) assert.equal(evidence.mermaid[0]?.source, "graph TD; A-->B");
    }
  }
});

test("a complete large message has no hidden 64 MiB reading-fragment ceiling", async () => {
  const chunk = "x".repeat(1024 * 1024), count = 65;
  const stream = Readable.from((function* () { yield '<article data-message-id="m"><p>'; for (let i = 0; i < count; i++) yield chunk; yield '</p></article>'; })());
  const evidence = await extractStaticReadingEvidence(stream);
  assert.equal(evidence.fragments.length, 1);
  assert.equal(evidence.fragments[0]!.html.length, count * chunk.length + 7);
  assert(evidence.fragments[0]!.html.startsWith("<p>xxx")); assert(evidence.fragments[0]!.html.endsWith("xxx</p>"));
});

test("Gemini, Grok and DeepSeek identify the documented payload when its manifest descriptor is omitted", async () => {
  const base = path.resolve("tests/private/schema-rebuild"); await mkdir(base, { recursive: true }); const temporary = await mkdtemp(path.join(base, "payload-fallback-")); let passed = false;
  try {
    for (const platform of ["gemini", "grok", "deepseek"]) {
      const html = await readFile(new URL(`../parser/fixtures/${platform}-light.html`, import.meta.url), "utf8");
      const marker = html.indexOf('id="ai-chat-archive-manifest"'), start = html.indexOf(">", marker) + 1, end = html.indexOf("</script>", start);
      assert(marker > 0 && end > start);
      const manifest = JSON.parse(html.slice(start, end)); delete manifest.payload;
      const input = html.slice(0, start) + JSON.stringify(manifest) + html.slice(end), filePath = path.join(temporary, `${platform}.html`);
      await writeFile(filePath, input);
      const envelope = await readExporterEnvelope({ filePath, temporaryRoot: temporary });
      assert.equal(envelope.manifest["platform"], platform);
      assert.equal(envelope.adapter.manifest.family, platform);
      assert(Object.keys(envelope.payload).length > 1);
      const extracted = await extractHtmlRecord({ filePath, temporaryRoot: temporary });
      const record = assembleConversationRecord({ ...extracted, parserVersion: "1.1.5", timestamp });
      assert.equal(record["platform"], platform);
      assert(((record["messages"] as JsonObject)["items"] as JsonObject[]).length > 0);
    }
    passed = true;
  } finally { if (passed) { assert.equal(path.dirname(await realpath(temporary)), await realpath(base)); assert.equal((await lstat(temporary)).isSymbolicLink(), false); await rm(temporary, { recursive: true }); } else console.error(`Retained payload fallback fixture: ${temporary}`); }
});

test("Claude official JSON cannot turn a top-level choice or title into historical model attribution", () => {
  const extracted = extractClaudeRecord({
    record: { uuid: "conversation", name: "Opus in a user title", model: "Current choice",
      chat_messages: [
        { uuid: "a", sender: "assistant", text: "Unknown model" },
        { uuid: "b", parent_message_uuid: "a", sender: "assistant", text: "Known model", model: "Actual message model" }
      ] },
    source: { file: "conversations.json", bytes: 1, sha256: "1".repeat(64) },
    captured: { at: timestamp, from: "filesystem:last_write_time" }
  });
  assert.equal(extracted.facts.conversationModel, undefined);
  const conversation = assembleConversationRecord({ ...extracted, parserVersion: "1.1.3", timestamp });
  assert.deepEqual((conversation["identity"] as JsonObject[]).filter(f => f["role"] === "assistant").map(frontName), ["Claude", "Actual message model"]);
  assert.deepEqual(conversation["models"], ["Actual message model"]);
});

test("Claude official attachment text keeps source indentation and boundary newlines", () => {
  const extractedText = "\n    print('source indentation')\n\n";
  const extracted = extractClaudeRecord({ record: { uuid: "record", chat_messages: [{ uuid: "m", sender: "human", text: "Read this file", attachments: [{ file_name: "fragment.py", extracted_content: extractedText }] }] },
    source: { file: "conversations.json", bytes: 1, sha256: "1".repeat(64) }, captured: { at: timestamp, from: "filesystem:creation_time" } });
  const attachment = ((extracted.parsed.draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]).find(b => b["type"] === "attachment")!;
  assert.equal(attachment["text"], extractedText);
});

test("streamed JSON rejects duplicate decoded keys, lossy numbers and invalid Unicode before normalizing", async () => {
  for (const source of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '[9007199254740993]', '[0.100000000000000005]', '{"x":"\\ud800"}']) {
    for (const size of [1, 7, 64]) {
      const bytes = Buffer.from(source), parts = Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
      await assert.rejects(parseStreamingJson(Readable.from(parts)));
    }
  }
  assert.deepEqual(await parseStreamingJson(Readable.from(['{"n":1.25e2,"emoji":"', '🌈', '"}'])), { n: 125, emoji: "🌈" });
});

test("the actual HTML memory/spool and official-record byte-range boundaries reject discarded source facts", async () => {
  const base = path.resolve("tests/private/schema-rebuild"); await mkdir(base, { recursive: true }); const temporary = await mkdtemp(path.join(base, "raw-boundary-")); let passed = false;
  try {
    const original = await readFile(path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), "utf8");
    const marker = original.indexOf('id="ai-chat-archive-manifest"'), start = original.indexOf(">", marker) + 1;
    assert(marker > 0 && start > marker);
    const brace = original.indexOf("{", start);
    const malformed = original.slice(0, brace + 1) + '"discarded":1,"discarded":2,' + original.slice(brace + 1);
    const file = path.join(temporary, "source.html"); await writeFile(file, malformed);
    for (const threshold of [Number.MAX_SAFE_INTEGER, 1]) await assert.rejects(readExporterEnvelope({ filePath: file, temporaryRoot: temporary, jsonScriptMemoryThresholdBytes: threshold }));
    const badRecord = '{"uuid":"one","uuid":"two","chat_messages":[]}'; const container = path.join(temporary, "conversations.json"); await writeFile(container, `[${badRecord}]`);
    await assert.rejects(parseJsonRange(container, { index: 0, offset: 1, length: Buffer.byteLength(badRecord) }));
    assert.deepEqual((await readdir(temporary)).sort(), ["conversations.json", "source.html"]); passed = true;
  } finally { if (passed) { assert.equal(path.dirname(await realpath(temporary)), await realpath(base)); assert.equal((await lstat(temporary)).isSymbolicLink(), false); await rm(temporary, { recursive: true }); } else console.error(`Retained input boundary test: ${temporary}`); }
});

async function gpt(payload: JsonObject, tree = false) {
  const messages: SourceMessageFacts[] = [], blockSpeakers = new Map<JsonObject, SourceMessageFacts>();
  const context: AdapterParseContext = { payload, manifest: {}, source: { file: "source.html", bytes: 1, sha256: "1".repeat(64) },
    record: { message(i, f) { messages[i] = f; }, block(b, f) { blockSpeakers.set(b, f); }, current() {}, conversationModel() {} } };
  const draft = await (tree ? parseChatGptTree(context, { payload: "test", profile: "tree" }) : parseChatGptItems(context, { payload: "test", profile: "light" }));
  const current = draft["current_message"] ? messages[(draft["messages"] as JsonObject[]).findIndex(m => m["id"] === draft["current_message"])]?.id : undefined;
  const facts: SourceRecordFacts = { messages, blockSpeakers, ...(current ? { current } : {}) };
  return assembleConversationRecord({ parsed: { draft, adapter: CHATGPT_LIGHT_MANIFEST, sourceFingerprint: { bytes: 1, sha256: "1".repeat(64) }, systemLogErrors: [] }, facts, parserVersion: "1.1.0", timestamp });
}

test("consecutive scheduled runs without a user message stay separate, while each run keeps tools beside its answer", async () => {
  const item = (id: string, kind: string): JsonObject => ({ message_id: id, node_id: id, kind, scheduled_task_id: "job", ...(kind === "tool" ? { name: "web.run", text: "results" } : { model: "Model A", parts: [{ type: "md", text: `Answer ${id}` }] }) });
  const c = await gpt({ items: [item("run1", "tool"), item("run1", "assistant"), item("run2", "tool"), item("run2", "assistant")] });
  const messages = obj(c["messages"])["items"] as JsonObject[];
  assert.deepEqual(messages.map(m => [m["id"], m["parent"]]), [["run1", undefined], ["run2", "run1"]]);
  assert(messages.every(m => (m["content"] as JsonObject[]).length === 2));
});

test("a grouped answer keeps per-block model evidence without duplicating inherited speaker fields", async () => {
  const c = await gpt({ items: [
    { kind: "assistant", message_id: "one", model: "Model A", parts: [{ type: "md", text: "First" }] },
    { kind: "assistant", message_id: "two", model: "Model B", parts: [{ type: "md", text: "Second" }] }
  ] });
  const message = (obj(c["messages"])["items"] as JsonObject[])[0]!, blocks = message["content"] as JsonObject[];
  const fronts = new Map((c["identity"] as JsonObject[]).map(f => [String(f["source_id"]), f]));
  assert.equal(frontName(fronts.get(String(message["speaker"]))), "Model A"); assert(!blocks[0]!["speaker"]);
  assert.equal(frontName(fronts.get(String(blocks[1]!["speaker"]))), "Model B");
});

test("a Tree keeps the actual missing parent and the source current node instead of reparenting", async () => {
  const c = await gpt({ turns: { a: { id: "a", parent: "outside", children: ["b"], node_ids: ["n1"], role: "user" }, b: { id: "b", parent: "a", children: [], node_ids: ["n2"], role: "assistant" } },
    turn_roots: ["a"], current_turn: "b", items_by_node: { n1: [{ kind: "user", parts: [{ type: "md", text: "Q" }] }], n2: [{ kind: "assistant", model: "Model", parts: [{ type: "md", text: "A" }] }] } }, true);
  const tree = obj(c["messages"]);
  assert.equal(tree["current"], "b"); assert.deepEqual((tree["items"] as JsonObject[]).map(m => [m["id"], m["parent"]]), [["a", "outside"], ["b", "a"]]);
});

test("the same URL or citation token does not erase different quoted reference text", async () => {
  const url = "https://example.com/article", citations = [{ url, snippet: "First", citation_uuid: "shared" }, { url, snippet: "Second", citation_uuid: "shared" }];
  const chatgpt = await gpt({ items: [{ kind: "assistant", model: "Model", parts: [{ type: "md", text: "Answer" }], sources: citations }] });
  assert.equal((chatgpt["references"] as JsonObject[]).length, 2);
  const official = extractClaudeRecord({ record: { uuid: "record", chat_messages: [{ uuid: "m", sender: "assistant", content: [{ type: "text", text: "A", citations }] }] },
    source: { file: "conversations.json", bytes: 1, sha256: "1".repeat(64) }, captured: { at: timestamp, from: "filesystem:creation_time" } });
  assert.equal((official.parsed.draft["sources"] as JsonObject[]).length, 2);
  const gemini = await geminiLightAdapter.parse({ source: { file: "gemini.html", bytes: 1, sha256: "1".repeat(64) }, manifest: {}, payload: { sources: citations,
    messages: [{ role: "assistant", source_id: "m", html: `<p><a href="${url}">reference</a></p>` }] } });
  assert.equal((gemini["sources"] as JsonObject[]).length, 2);
});

function rawTree(platform: string, payload: JsonObject): Map<string, string | undefined> {
  const pairs: [string, string | undefined][] = [];
  const add = (id: unknown, parent: unknown): void => { assert.equal(typeof id, "string"); assert(id); pairs.push([String(id), typeof parent === "string" && parent ? parent : undefined]); };
  if (platform === "chatgpt") for (const [id, raw] of Object.entries(obj(payload["turns"]))) add(id, obj(raw)["parent"]);
  else if (platform === "deepseek") for (const m of rows(payload["items"])) add(m["message_id"], m["parent_id"]);
  else if (platform === "grok") for (const m of rows(payload["nodes"])) add(m["response_id"], m["parent_response_id"]);
  else if (platform === "kimi") {
    for (const m of rows(obj(payload["tree"])["nodes"])) add(m["id"], m["parent_id"]);
    const found = new Set(pairs.map(([id]) => id)); for (const m of rows(payload["messages"])) if (!found.has(String(m["id"]))) add(m["id"], m["parent_id"]);
  } else if (platform === "mistral") for (const m of rows(payload["messages"])) add(m["key"] ?? `${m["id"]}::${m["version"] ?? "0"}`, m["parent_id"] ? `${m["parent_id"]}::${m["parent_version"] ?? "0"}` : undefined);
  else for (const m of rows(payload["messages"])) add(m["id"], platform === "claude" && m["parent_id"] === "00000000-0000-4000-8000-000000000000" ? undefined : m["parent_id"]);
  assert.equal(new Set(pairs.map(([id]) => id)).size, pairs.length); return new Map(pairs);
}

const sample = process.env["CLOUDIG_RECORD_SAMPLE"];
test("all latest source files retain their exact tree parents, known model declarations, resources and complete witnesses", { skip: !sample }, async () => {
  const base = path.resolve("tests/private/schema-rebuild"); await mkdir(base, { recursive: true }); const temporary = await mkdtemp(path.join(base, "fidelity-")); let passed = false;
  const platforms = new Set<string>(), profiles = new Set<string>(); let count = 0, trees = 0, scheduledMessages = 0;
  try {
    for (const file of (await readdir(sample!)).filter(f => f.endsWith(".html"))) {
      const filePath = path.join(sample!, file), extracted = await extractHtmlRecord({ filePath, temporaryRoot: temporary });
      const c = assembleConversationRecord({ ...extracted, parserVersion: "1.1.0", timestamp });
      const messages = obj(c["messages"])["items"] as JsonObject[], platform = String(c["platform"]), profile = String(obj(c["source"])["profile"]);
      assert.equal(extracted.facts.messages?.length, messages.length, file); platforms.add(platform); profiles.add(profile); count++;
      if (profile === "tree") {
        const envelope = await readExporterEnvelope({ filePath, temporaryRoot: temporary });
        const expected = rawTree(platform, envelope.payload), actual = new Map(messages.map(m => [String(m["id"]), m["parent"]]));
        assert.deepEqual(actual, expected, `${platform}: original direct parents`); trees++;
      }
      if (file.includes("巡穹织网")) { scheduledMessages = messages.length; assert(scheduledMessages > 15, "separate scheduled executions must not collapse into the old 15 groups"); }
      if (platform === "claude") {
        assert.equal(extracted.facts.conversationModel, undefined, "Claude's current selector is not authorship evidence");
        const fronts = new Map((c["identity"] as JsonObject[]).map(f => [f["source_id"], f]));
        for (const [i, witness] of extracted.facts.messages!.entries()) if (witness.role === "assistant") {
          assert.equal(frontName(fronts.get(messages[i]!["speaker"])), witness.model ?? "Claude", "historical model is determined only by this message's evidence");
        }
        assert.deepEqual(c["models"] ?? [], [...new Set(extracted.facts.messages!.flatMap(f => f.role === "assistant" && f.model ? [f.model] : []))]);
      }
    }
    const waterline = JSON.parse(await readFile(new URL("../../../src/adapters/parser/contracts/sample-waterline.json", import.meta.url), "utf8"));
    assert.equal(count, waterline.summary.files); assert.equal(platforms.size, waterline.summary.platforms);
    assert.equal(trees, waterline.summary.profile_counts.tree); assert.deepEqual(profiles, new Set(["full", "light", "tree"]));
    console.log(JSON.stringify({ source_fidelity_files: count, platforms: platforms.size, tree_parent_checks: trees, scheduled_messages: scheduledMessages })); passed = true;
  } finally { if (passed) { assert.equal(path.dirname(await realpath(temporary)), await realpath(base)); assert.equal((await lstat(temporary)).isSymbolicLink(), false); await rm(temporary, { recursive: true }); } else console.error(`Retained source fidelity scratch: ${temporary}`); }
});
