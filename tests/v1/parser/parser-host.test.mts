import { testRuntimeRoot } from "../helpers/runtime-root.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { prepareParseBatch, runNewParseBatch, runPreparedParseBatch } from "../../../src/app/parser/batch.mts";
import { parseExporterHtmlToDraft } from "../../../src/app/parser/host.mts";
import { adapterBundleSha256, adapterBundleSnapshot, PARSER_VERSION } from "../../../src/app/parser/registry.mts";
import { extractStaticReadingEvidence } from "../../../src/adapters/parser/reading-evidence.mts";
import { embeddedBase64DataUrl } from "../../../src/adapters/parser/embedded-data.mts";
import {
  commitNewParsedSource,
  commitArchiveUserState,
  commitPlannedParsedSource,
  createLocalLibrary,
  importSourceStream,
  inspectLocalLibrary,
  prepareCatalogForParser,
  prepareParsedSourceWritePlan,
  readCatalogCache,
  readSystemLog
} from "../../../src/adapters/library-data/index.mts";
import { fingerprintFile, readCurrentAuthorityPair, readPreviousAuthorityPair } from "../../../src/adapters/storage/index.mts";
import { RESOURCE_BASE64_DECODED_CHUNK_BYTES } from "../../../src/adapters/storage/stream.mts";
import { finalizeConversation, serializeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";
import { canonicalDiagnosticErrors } from "../../../src/app/parser/diagnostics.mts";

const fixture = new URL("./fixtures/chatgpt-light.html", import.meta.url);
const geminiFixture = new URL("./fixtures/gemini-light.html", import.meta.url);
const deepSeekFixture = new URL("./fixtures/deepseek-light.html", import.meta.url);
const grokFixture = new URL("./fixtures/grok-light.html", import.meta.url);
const doubaoFixture = new URL("./fixtures/doubao-light.html", import.meta.url);
const kimiFixture = new URL("./fixtures/kimi-light.html", import.meta.url);
const qwenFixture = new URL("./fixtures/qwen-light.html", import.meta.url);
const chatGlmFixture = new URL("./fixtures/chatglm-light.html", import.meta.url);
const zaiFixture = new URL("./fixtures/zai-light.html", import.meta.url);
const yuanbaoFixture = new URL("./fixtures/yuanbao-light.html", import.meta.url);
const mistralFixture = new URL("./fixtures/mistral-light.html", import.meta.url);
const bundle = new URL("../../../src/adapters/parser/contracts/adapters.json", import.meta.url);

function filePath(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1));
}

function encodedResourceChunks(bytes: Buffer): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + RESOURCE_BASE64_DECODED_CHUNK_BYTES)).toString("base64"));
  }
  return chunks;
}

function jsonScript(html: string, id: string): JsonObject {
  const marker = `id="${id}"`;
  const markerAt = html.indexOf(marker);
  const start = html.indexOf(">", markerAt) + 1;
  const end = html.indexOf("</script>", start);
  if (markerAt < 0 || start < 1 || end < start) throw new TypeError(`Missing fixture script: ${id}`);
  const value: unknown = JSON.parse(html.slice(start, end));
  if (!isJsonObject(value)) throw new TypeError(`Fixture script is not an object: ${id}`);
  return value;
}

function replaceJsonScript(html: string, id: string, value: JsonObject): string {
  const marker = `id="${id}"`;
  const markerAt = html.indexOf(marker);
  const start = html.indexOf(">", markerAt) + 1;
  const end = html.indexOf("</script>", start);
  if (markerAt < 0 || start < 1 || end < start) throw new TypeError(`Missing fixture script: ${id}`);
  const json = JSON.stringify(value).replaceAll("<", "\\u003c");
  return `${html.slice(0, start)}${json}${html.slice(end)}`;
}

async function disposable(): Promise<{ base: string; root: string; cleanup: () => Promise<void> }> {
  const temporaryRoot = path.join(process.cwd(), "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const base = await mkdtemp(path.join(temporaryRoot, "cloudig-v1-parser-"));
  return { base, root: path.join(base, "Cloudig"), cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(absolute);
      else {
        const info = await stat(absolute, { bigint: true });
        const bytes = await readFile(absolute);
        result[relative] = `${info.size}:${info.mtimeNs}:${createHash("sha256").update(bytes).digest("hex")}`;
      }
    }
  }
  await walk(root);
  return result;
}

function fullConversation(
  draft: JsonObject,
  adapter: Readonly<{ id: string; version: string }> = { id: "chatgpt-light-items-v2", version: "2.0.0" }
): JsonObject {
  assert.deepEqual(draft["content_time"], { basis: "unavailable" }, "every Adapter leaves Content Time for the user");
  return finalizeConversation({
    schema: "cloudig/conversation/1.0.0",
    archive: "a1",
    generation: 1,
    content_sha256: "0".repeat(64),
    parser: {
      version: "1.0.0",
      adapter
    },
    lifecycle: {
      first_parsed_at: { basis: "parser", value: "2026-08-31T21:00:00.000Z" },
      last_parsed_at: "2026-08-31T21:00:00.000Z",
      cloudig_edited_at: "2026-08-31T21:00:00.000Z"
    },
    ...draft
  });
}

test("Adapter registry is deterministic and matches the checked machine bundle", async () => {
  const expected = JSON.parse(await readFile(bundle, "utf8")) as unknown;
  assert.deepEqual(adapterBundleSnapshot(), expected);
  assert.match(adapterBundleSha256(), /^[0-9a-f]{64}$/u);
  assert.equal(adapterBundleSha256(), adapterBundleSha256());
});

test("HTML rejects invalid UTF-8 and normalization yields so a real asynchronous cancel is observed", async () => {
  const scope = await disposable();
  try {
    const original = await readFile(fixture);
    const invalid = path.join(scope.base, "invalid-encoding.html");
    await writeFile(invalid, Buffer.concat([original, Buffer.from([0xff])]));
    await assert.rejects(parseExporterHtmlToDraft({ filePath: invalid }), /encoded data|encoding/iu);
    const controller = new AbortController();
    let normalized = 0;
    await assert.rejects(parseExporterHtmlToDraft({ filePath: filePath(fixture), signal: controller.signal,
      onProgress: event => { if (event.phase === "normalize") { normalized++; setImmediate(() => controller.abort(new Error("cancel normalization"))); } }
    }), /cancel normalization/u);
    assert.equal(normalized, 1);
  } finally { await scope.cleanup(); }
});

test("the inert capture_diagnostics envelope becomes ordered copy-safe System Log errors", async () => {
  const scope = await disposable();
  try {
    await mkdir(scope.root, { recursive: true });
    const html = await readFile(fixture, "utf8");
    const manifest = jsonScript(html, "ai-chat-archive-manifest");
    manifest["capture_diagnostics"] = {
      format: "ai-chat-archive/capture-diagnostics-v1",
      entries: [
        { code: "capture-note", stage: "capture", detail: "资源使用了静态降级", resource_key: "resource:3", user_visible: false },
        { code: "second", detail: "第二条诊断", user_visible: false }
      ]
    };
    const file = path.join(scope.root, "capture.html");
    await writeFile(file, replaceJsonScript(html, "ai-chat-archive-manifest", manifest), "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: file });
    assert.deepEqual(parsed.systemLogErrors, [
      { source: "exporter", code: "capture-note", stage: "capture", message: "资源使用了静态降级", ref: "resource:3" },
      { source: "exporter", code: "second", message: "第二条诊断" }
    ]);
  } finally {
    await scope.cleanup();
  }
});

test("Parser and canonical diagnostics go to System Log without treating platform errors or Light metadata as missing content", () => {
  const errors = canonicalDiagnosticErrors({
    messages: [{ role: "assistant", content: [{ type: "text", text: "Error: 原平台工具失败" }] }],
    limitations: [{ code: "unmapped-format", at: "m1", detail: "无法归组 https://private.example/test" }],
    resources: [{ id: "r1", availability: "metadata_only" }, { id: "r2", availability: "missing" }]
  });
  assert.deepEqual(errors, [
    { source: "parser", code: "unmapped-format", message: "无法归组 [URL omitted]", ref: "m1" },
    { source: "canonical", code: "resource-missing", message: "原文件未取得此资源，保留已有来源描述。", ref: "r2" }
  ]);
});

test("static Mermaid reading evidence is chunk-boundary independent and fingerprints the same bytes", async () => {
  const bytes = await readFile(fixture);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 7) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 7)));
  }
  const evidence = await extractStaticReadingEvidence(Readable.from(chunks));
  assert.deepEqual(evidence.fingerprint, {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
  assert.equal(evidence.mermaid.length, 1);
  assert.equal(evidence.mermaid[0]?.messageId, "private-assistant-1");
  assert.equal(evidence.mermaid[0]?.source, "graph TD\n  A-->B");
  assert.match(evidence.mermaid[0]?.dataUrl ?? "", /^data:image\/svg\+xml/iu);
  assert.equal(evidence.images.length, 0);
});

test("a megabyte data URL is retained across quoted tag boundaries without quadratic rescanning", async () => {
  const data = "data:image/png;base64," + "a".repeat(1024 * 1024);
  const html = Buffer.from(`<article data-message-id="one"><img alt="quote > test" src='${data}'><p>After</p></article>`);
  const chunks = Array.from({ length: Math.ceil(html.length / 1009) }, (_, i) => html.subarray(i * 1009, (i + 1) * 1009));
  const result = await extractStaticReadingEvidence(Readable.from(chunks));
  assert.equal(result.images[0]?.dataUrl, data);
  assert.equal(result.images[0]?.alt, "quote > test");
  assert.match(result.fragments[0]!.html, /<p>After<\/p>$/u);
  assert.equal(result.fingerprint.sha256, createHash("sha256").update(html).digest("hex"));
});

test("div-based Mermaid cards retain their SVG stylesheet across stream chunks", async () => {
  const html = '<style>body{background:red}</style><article data-message-id="one"><div class="osis-mermaid-card"><svg><style>.node{fill:red;clip-path:url(#clip)}</style><text>A</text></svg></div><script>not reading</script></article>';
  const result = await extractStaticReadingEvidence(Readable.from(Array.from(html, c => Buffer.from(c))));
  assert.match(result.fragments[0]!.html, /<style>\.node\{fill:red;clip-path:url\(#clip\)\}<\/style>/u);
  assert.doesNotMatch(result.fragments[0]!.html, /not reading|body\{/u);
});

test("a retained preview still rejects a same-size source edit with restored mtime", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({ root: scope.root, transaction: "x_PREVIEWEDITCREATE", timestamp: "2026-09-07T00:00:00.000Z", localDate: "2026-09-07", offset: "Z", language: "zh-CN" });
    const source = path.join(scope.root, "Inbox", "edit.html"), original = await readFile(fixture, "utf8");
    await writeFile(source, original);
    const before = await stat(source);
    const plan = await prepareParseBatch({ runtimeRoot: testRuntimeRoot(scope.root), libraryRoot: scope.root, sourcePaths: ["Inbox/edit.html"], operation: "o_PREVIEWEDITPLANAA", preservePrevious: false, copyUserStateOnPreserve: true });
    assert.ok(plan.drafts?.has("Inbox/edit.html"));
    const changed = original.replace("Fixture", "FixturE");
    assert.notEqual(changed, original); assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    await writeFile(source, changed); await utimes(source, before.atime, before.mtime);
    const result = await runPreparedParseBatch({ runtimeRoot: testRuntimeRoot(scope.root), libraryRoot: scope.root, plan, operation: "o_PREVIEWEDITRUNAAA", transactionTokens: ["x_PREVIEWEDITCOMMIT"], recoveryTransaction: "x_PREVIEWEDITRECOVR", timestamp: "2026-09-07T00:01:00.000Z", copyUserStateOnPreserve: true });
    assert.equal(result.items[0]?.status, "conflict");
    assert.deepEqual(await readdir(path.join(scope.root, "Conversations")), []);
  } finally { await scope.cleanup(); }
});

test("Kimi standalone label images retain the saved HTML paragraph and overflow rules", async () => {
  const scope = await disposable();
  try {
    const file = path.join(scope.base, "kimi-labels.html");
    const source = (await readFile(kimiFixture, "utf8")).replace('<text>mind</text>', '<foreignObject width="60" height="26"><div><p>Visible label</p></div></foreignObject>');
    await writeFile(file, source);
    const parsed = await parseExporterHtmlToDraft({ filePath: file });
    const figures = (parsed.draft["resources"] as JsonObject[]).filter(r => r["mime"] === "image/svg+xml").map(r => Buffer.from((r["data_base64"] as string[]).join(""), "base64").toString("utf8"));
    const label = figures.find(svg => svg.includes("Visible label"))!;
    assert.match(label, /overflow: visible/u);
    assert.match(label, /margin: 0 !important/u);
  } finally { await scope.cleanup(); }
});

test("embedded data URLs are inspected and normalized in fixed decoded chunks without a whole decoded Buffer result", () => {
  const bytes = Buffer.alloc(RESOURCE_BASE64_DECODED_CHUNK_BYTES * 2 + 7, 0x6b);
  const embedded = embeddedBase64DataUrl(`data:application/octet-stream;base64,${bytes.toString("base64")}`);
  assert.equal(embedded.byteLength, bytes.byteLength);
  assert.equal(embedded.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(embedded.dataBase64, encodedResourceChunks(bytes));
  assert.equal("bytes" in embedded, false);
  assert.throws(
    () => embeddedBase64DataUrl("data:application/octet-stream;base64,YQ= ="),
    /canonical Base64/u
  );
});

test("ChatGPT Light manifest and payload become one deterministic semantic Conversation draft", async () => {
  const progress: Array<{ phase: string; completed: number; total: number }> = [];
  const first = await parseExporterHtmlToDraft({
    filePath: filePath(fixture),
    onProgress: (event) => progress.push(event)
  });
  const second = await parseExporterHtmlToDraft({
    filePath: filePath(fixture)
  });
  assert.equal(first.adapter.id, "chatgpt-light-items-v2");
  assert.equal(first.adapter.version, "3.0.4");
  assert.deepEqual(first.draft, second.draft);
  assert.deepEqual(first.sourceFingerprint, second.sourceFingerprint);
  assert.ok(progress.some((entry) => entry.phase === "fingerprint" && entry.completed === entry.total));
  assert.ok(progress.some((entry) => entry.phase === "extract" && entry.completed === entry.total));
  assert.ok(progress.some((entry) => entry.phase === "normalize" && entry.completed === entry.total));

  const conversation = fullConversation(first.draft);
  assert.equal(conversation["title"], "Fixture Conversation");
  assert.deepEqual(conversation["models"], ["gpt-fixture"]);
  const messages = conversation["messages"] as JsonObject[];
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((entry) => entry["role"]), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual((messages[1]!["content"] as JsonObject[]).map((entry) => entry["type"]), [
    "reasoning_summary", "tool", "tool", "search", "markdown", "diagram", "image", "citations", "citations"
  ]);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["diagram", "embedded"], ["image", "embedded"], ["file", "metadata_only"]
  ]);
  const diagram = (messages[1]!["content"] as JsonObject[]).find((entry) => entry["type"] === "diagram");
  assert.deepEqual({ format: diagram?.["format"], source: diagram?.["source"], rendered: diagram?.["rendered"] }, {
    format: "mermaid",
    source: "graph TD\n  A-->B",
    rendered: "r1"
  });
  assert.deepEqual((conversation["sources"] as JsonObject[]).map((entry) => entry["kind"]), ["web", "saved_memory"]);
  assert.equal((conversation["source"] as JsonObject)["locator"] !== undefined, true);
  assert.deepEqual(conversation["content_time"], { basis: "unavailable" });
  assert.equal(serializeConversation(conversation), serializeConversation(fullConversation(second.draft)));
  assert.equal((globalThis as { __must_not_run?: boolean }).__must_not_run, undefined);
});

test("ChatGPT Full reuses semantic grouping but embeds captured attachment bytes", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(fixture, "utf8");
    const full = light
      .replaceAll("osis.chatgpt.chat-export/light-items-v2", "osis.chatgpt.chat-export/full-v1")
      .replace(
        '{ "type": "attachment", "id": "private-file-1", "name": "notes.txt", "mime_type": "text/plain", "size_bytes": 12, "availability": "metadata_only" }',
        '{ "type": "attachment", "id": "private-file-1", "name": "notes.txt", "mime_type": "text/plain", "size_bytes": 13, "embedded_size": 13, "availability": "embedded_original", "src": "data:text/plain;charset=utf-8;base64,aGVsbG8gY2xvdWRpZw==" }'
      );
    const source = path.join(scope.base, "chatgpt-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "chatgpt-full-v1");
    assert.equal(parsed.adapter.version, "3.0.4");
    const conversation = fullConversation(parsed.draft, {
      id: parsed.adapter.id,
      version: parsed.adapter.version
    });
    const sourceFacts = conversation["source"] as JsonObject;
    assert.equal(sourceFacts["profile"], "full");
    assert.equal(sourceFacts["payload"], "osis.chatgpt.chat-export.full-v1");
    const file = (conversation["resources"] as JsonObject[]).find((entry) => entry["kind"] === "file");
    assert.equal(file?.["availability"], "embedded");
    assert.equal(file?.["bytes"], 13);
    assert.equal(Buffer.from((file?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello cloudig");
  } finally {
    await scope.cleanup();
  }
});

test("ChatGPT captured rich bodies preserve literal user text, headings, writing documents and inline MathML", async () => {
  const scope = await disposable();
  try {
    let html = await readFile(fixture, "utf8");
    const payload = jsonScript(html, "chatgpt-export-data");
    payload["items"] = [
      { kind: "user", message_id: "u-captured", parts: [{ type: "md", text: "literal\n===\n<tag>" }] },
      { kind: "assistant", message_id: "a-captured", parts: [{ type: "md", text: "Fallback is not the rendered document" }] }
    ];
    html = replaceJsonScript(html, "chatgpt-export-data", payload).replace("</main>", '<article data-message-id="u-captured"><div class="user-bubble">literal<br>===<br>&lt;tag&gt;</div></article><article data-message-id="a-captured"><div class="answer"><h2>Captured title</h2><p>Formula <span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">duplicate layout</span></span>.</p><div class="writing-block"><div class="writing-content"><h1>Document</h1><p>Body</p></div></div></div></article></main>');
    const file = path.join(scope.base, "captured.html"); await writeFile(file, html);
    const result = await parseExporterHtmlToDraft({ filePath: file });
    const messages = result.draft["messages"] as JsonObject[];
    const user = (messages[0]!["content"] as JsonObject[])[0]!;
    assert.equal(user["type"], "html");
    assert.match(String(user["html"]), /literal<br>===<br>&lt;tag&gt;/u);
    assert.doesNotMatch(String(user["html"]), /<h1>|<tag>/u);
    const body = messages[1]!["content"] as JsonObject[];
    assert.match(String(body[0]!["html"]), /<h2>Captured title<\/h2><p>Formula <math><mi>x<\/mi><\/math>\.<\/p>/u);
    assert.doesNotMatch(JSON.stringify(body), /Fallback|duplicate layout/u);
    assert.equal(body[1]!["format"], "writing-block");
    assert.match(String(body[1]!["html"]), /<h1>Document<\/h1>/u);
  } finally { await scope.cleanup(); }
});

test("ChatGPT Tree preserves parent-first branches, current leaf, schedules, and owned diagrams", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(fixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const linear = jsonScript(light, "chatgpt-export-data");
    const items = structuredClone(linear["items"] as JsonObject[]);
    const imagePart = (items[4]!["parts"] as JsonObject[]).find((part) => part["type"] === "img")!;
    const centralImage: JsonObject = { ...imagePart, id: "central-image" };
    delete imagePart["src"];
    imagePart["src"] = "cloudig-resource:central-image";
    imagePart["resource_id"] = "central-image";
    const branchUser = structuredClone(items[5]!);
    branchUser["message_id"] = "private-user-branch";
    branchUser["node_id"] = "private-node-8";
    (branchUser["parts"] as JsonObject[])[0]!["text"] = "Please read the branch copy.";
    const branchAssistant = structuredClone(items[6]!);
    branchAssistant["message_id"] = "private-assistant-branch";
    branchAssistant["node_id"] = "private-node-9";
    (branchAssistant["parts"] as JsonObject[])[0]!["text"] = "This is the selected branch.";
    const allItems = [...items, branchUser, branchAssistant];
    const itemsByNode: JsonObject = {};
    for (const item of allItems) itemsByNode[String(item["node_id"])] = [item];
    const treePayload: JsonObject = {
      ...linear,
      format: "osis.chatgpt.chat-export/all-branches-v1",
      tree_scope: "all_branches",
      branch_capability: "tree",
      roots: ["private-node-1"],
      current_node: "private-node-9",
      current_path: allItems.map((item) => item["node_id"] as string),
      turn_roots: ["turn-1"],
      current_turn: "turn-6",
      turns: {
        "turn-1": { id: "turn-1", role: "user", children: ["turn-2"], node_ids: ["private-node-1"], raw_node_ids: ["private-node-1"] },
        "turn-2": { id: "turn-2", role: "assistant", parent: "turn-1", children: ["turn-3", "turn-5"], node_ids: ["private-node-2", "private-node-3", "private-node-4", "private-node-5"], raw_node_ids: ["private-node-2", "private-node-3", "private-node-4", "private-node-5"] },
        "turn-3": { id: "turn-3", role: "user", parent: "turn-2", children: ["turn-4"], node_ids: ["private-node-6"], raw_node_ids: ["private-node-6"] },
        "turn-4": { id: "turn-4", role: "assistant", parent: "turn-3", children: [], node_ids: ["private-node-7"], raw_node_ids: ["private-node-7"] },
        "turn-5": { id: "turn-5", role: "user", parent: "turn-2", children: ["turn-6"], node_ids: ["private-node-8"], raw_node_ids: ["private-node-8"] },
        "turn-6": { id: "turn-6", role: "assistant", parent: "turn-5", children: [], node_ids: ["private-node-9"], raw_node_ids: ["private-node-9"] }
      },
      rendered_turns: {
        "turn-2": '<section class="osis-mermaid-card"><div><img src="data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctext%3Efixture%3C%2Ftext%3E%3C%2Fsvg%3E"></div><div><pre><code>graph TD\n  A--&gt;B</code></pre></div></section>'
      },
      items_by_node: itemsByNode,
      resources: { "central-image": centralImage },
      scheduled_components: {
        lists: [{
          message_id: "private-assistant-1",
          heading: "Scheduled",
          all_tasks_url: "https://chatgpt.com/scheduled",
          tasks: [{ id: "fixture-task", title: "Fixture Task", schedule_label: "Daily" }]
        }],
        tasks: {
          "fixture-task": {
            id: "fixture-task",
            title: "Fixture Task",
            display_schedule: "Daily",
            is_enabled: true,
            notifications_enabled: false,
            prompt: "Run the fixture task."
          }
        }
      }
    };
    delete treePayload["items"];
    const treeManifest: JsonObject = {
      ...manifest,
      payload: { format: "osis.chatgpt.chat-export/all-branches-v1", element_id: "chatgpt-export-data" }
    };
    let tree = replaceJsonScript(light, "ai-chat-archive-manifest", treeManifest);
    tree = replaceJsonScript(tree, "chatgpt-export-data", treePayload);
    const source = path.join(scope.base, "chatgpt-tree.html");
    await writeFile(source, tree, "utf8");

    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "chatgpt-all-branches-v1");
    const conversation = fullConversation(parsed.draft, {
      id: parsed.adapter.id,
      version: parsed.adapter.version
    });
    const messages = conversation["messages"] as JsonObject[];
    assert.deepEqual(messages.map((message) => [message["id"], message["parent"] ?? null, message["role"]]), [
      ["m1", null, "user"],
      ["m2", "m1", "assistant"],
      ["m3", "m2", "user"],
      ["m4", "m3", "assistant"],
      ["m5", "m2", "user"],
      ["m6", "m5", "assistant"]
    ]);
    assert.equal(conversation["current_message"], "m6");
    const selected = messages[1]!["content"] as JsonObject[];
    assert.equal(selected.some((block) => block["type"] === "diagram" && block["format"] === "mermaid"), true);
    const image = (conversation["resources"] as JsonObject[]).find((entry) => entry["kind"] === "image");
    assert.equal(image?.["availability"], "embedded");
    const schedule = selected.find((block) => block["type"] === "tool" && block["name"] === "schedule");
    assert.equal((schedule?.["input"] as JsonObject)["kind"], "task-list");
  } finally {
    await scope.cleanup();
  }
});

test("Gemini Light preserves public thinking, inert rich HTML, citations, and thumbnail bytes", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(geminiFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(geminiFixture) });
  assert.equal(first.adapter.id, "gemini-light-dom-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.equal(messages.length, 2);
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]), ["attachment", "image", "html"]);
  const assistant = messages[1]!["content"] as JsonObject[];
  assert.deepEqual(assistant.map((block) => block["type"]), ["reasoning", "html", "citations"]);
  assert.equal(assistant[0]?.["format"], "html");
  assert.doesNotMatch(String(assistant[1]?.["html"]), /onclick|<script/iu);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["file", "metadata_only"], ["image", "embedded"]
  ]);
  assert.equal((conversation["sources"] as JsonObject[]).length, 1);
  assert.equal((globalThis as { __gemini_must_not_run?: boolean }).__gemini_must_not_run, undefined);
});

test("Gemini public thoughts have one canonical fold even when the HTML repeats an open thinking shell", async () => {
  const scope = await disposable();
  try {
    const original = await readFile(geminiFixture, "utf8");
    const payload = jsonScript(original, "gemini-archive-data");
    const assistant = (payload["messages"] as JsonObject[])[1]!;
    const thought = (assistant["thoughts"] as JsonObject[])[0]!;
    assistant["html"] = `<details class="thinking" open><summary>Thinking</summary><div class="thinking-body">${String(thought["html"])}</div></details><p>Final reply</p><details open><summary>User-visible other details</summary>Keep this content</details>`;
    const source = path.join(scope.base, "gemini-thinking.html");
    await writeFile(source, replaceJsonScript(original, "gemini-archive-data", payload), "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    const blocks = ((parsed.draft["messages"] as JsonObject[])[1]!["content"] as JsonObject[]);
    assert.equal(blocks.filter((block) => block["type"] === "reasoning").length, 1);
    const body = blocks.filter((block) => block["type"] === "html").map((block) => block["html"]).join("");
    assert.doesNotMatch(body, /thinking-body/u);
    assert.match(body, /Final reply/u);
    assert.match(body, /Keep this content/u);
    assistant["html"] = `<details class="thinking" open><div class="thinking-body">A genuinely different captured thought</div></details>`;
    await writeFile(source, replaceJsonScript(original, "gemini-archive-data", payload), "utf8");
    const divergent = await parseExporterHtmlToDraft({ filePath: source });
    assert.match(JSON.stringify(divergent.draft), /A genuinely different captured thought/u);
  } finally { await scope.cleanup(); }
});

test("Gemini Full embeds captured image and file bytes without changing the message sequence", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(geminiFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    manifest["exporter"] = { name: "Fixture Gemini Exporter", version: "1.0.0-full", mode: "full" };
    manifest["payload"] = { script_id: "gemini-archive-data", schema: "osis.gemini.chat-export/full-v1" };
    const payload = jsonScript(light, "gemini-archive-data");
    payload["format"] = "osis.gemini.chat-export/full-v1";
    payload["version"] = "1.0.0-full";
    const image = (payload["images"] as JsonObject[])[0]!;
    image["data_url"] = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=";
    payload["files"] = [{
      key: "fixture-file",
      kind: "file",
      name: "notes.txt",
      mime_type: "text/plain",
      availability: "embedded_original",
      data_url: "data:text/plain;charset=utf-8;base64,aGVsbG8="
    }];
    let full = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "gemini-archive-data", payload);
    const source = path.join(scope.base, "gemini-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "gemini-full-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    assert.equal((conversation["messages"] as JsonObject[]).length, 2);
    assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
      ["file", "embedded"], ["image", "embedded"]
    ]);
  } finally {
    await scope.cleanup();
  }
});

test("DeepSeek Light preserves reasoning/search order, references, resources, and native Mermaid", async () => {
  const parsed = await parseExporterHtmlToDraft({ filePath: filePath(deepSeekFixture) });
  assert.equal(parsed.adapter.id, "deepseek-light-messages-v2");
  const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]), ["image", "attachment", "markdown"]);
  const assistant = messages[1]!["content"] as JsonObject[];
  assert.deepEqual(assistant.map((block) => block["type"]), ["reasoning", "search", "markdown", "diagram", "citations"]);
  assert.equal(assistant[3]?.["rendered"], "r3");
  assert.match(String(assistant[2]?.["text"]), /\[Fixture source\]\(<https:\/\/example\.test\/source>\)/u);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["image", "embedded"], ["file", "metadata_only"], ["diagram", "embedded"]
  ]);
  assert.equal((globalThis as { __deepseek_must_not_run?: boolean }).__deepseek_must_not_run, undefined);
});

test("DeepSeek Full central resources and Tree parent/current identity remain separate profile facts", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(deepSeekFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "deepseek-export-data");
    const fileOccurrence = ((payload["items"] as JsonObject[])[0]!["attachments"] as JsonObject[])[1]!;
    fileOccurrence["resource_key"] = "central-file";
    payload["resources"] = [{
      resource_key: "central-file",
      id: "central-file",
      is_image: false,
      name: "notes.txt",
      mime_type: "text/plain",
      availability: "embedded_original",
      embedded_size: 5,
      data_url: "data:text/plain;charset=utf-8;base64,aGVsbG8="
    }];
    payload["format"] = "osis.deepseek.chat-export/full-v1";
    manifest["payload"] = { format: "osis.deepseek.chat-export/full-v1", element_id: "deepseek-export-data" };
    let full = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "deepseek-export-data", payload);
    const fullPath = path.join(scope.base, "deepseek-full.html");
    await writeFile(fullPath, full, "utf8");
    const fullParsed = await parseExporterHtmlToDraft({ filePath: fullPath });
    assert.equal(fullParsed.adapter.id, "deepseek-full-v1");
    assert.equal((fullParsed.draft["resources"] as JsonObject[]).find((entry) => entry["kind"] === "file")?.["availability"], "embedded");

    payload["format"] = "osis.deepseek.chat-export/all-branches-v1";
    payload["active_leaf_id"] = "ds-assistant";
    manifest["payload"] = { format: "osis.deepseek.chat-export/all-branches-v1", element_id: "deepseek-export-data" };
    let tree = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    tree = replaceJsonScript(tree, "deepseek-export-data", payload);
    const treePath = path.join(scope.base, "deepseek-tree.html");
    await writeFile(treePath, tree, "utf8");
    const treeParsed = await parseExporterHtmlToDraft({ filePath: treePath });
    assert.equal(treeParsed.adapter.id, "deepseek-all-branches-v1");
    const treeMessages = treeParsed.draft["messages"] as JsonObject[];
    assert.deepEqual(treeMessages.map((message) => [message["id"], message["parent"] ?? null]), [["m1", null], ["m2", "m1"]]);
    assert.equal(treeParsed.draft["current_message"], "m2");
  } finally {
    await scope.cleanup();
  }
});

test("Grok image commands cannot turn the following Markdown into flattened HTML", async () => {
  const scope = await disposable();
  try {
    const original = await readFile(grokFixture, 'utf8'), payload = jsonScript(original, 'grok-export-data');
    const message = (payload['messages'] as JsonObject[])[1]!;
    const command = '<grok:render card_id="card" card_type="image_card" type="render_searched_image"><argument name="image_id">image-token</argument></grok:render>';
    const copy = '**First**  \nSecond\n\nThird\n\n```xml\n' + command + '\n```';
    message['raw_message'] = command + '\n' + command + '\n\n' + copy;
    const file = path.join(scope.base, 'grok-prefix.html');
    await writeFile(file, replaceJsonScript(original, 'grok-export-data', payload));
    const parsed = await parseExporterHtmlToDraft({ filePath: file });
    const content = (parsed.draft['messages'] as JsonObject[])[1]!['content'] as JsonObject[];
    const body = content.find(block => block['type'] === 'markdown' && String(block['text']).includes('First'))!;
    assert.equal(body['text'], copy);
    assert.ok(content.some(block => block['type'] === 'image'), 'Captured images must not disappear with the API control tokens');
    assert.ok(!content.some(block => block['type'] === 'html' && String(block['html']).includes('**First**')));
  } finally { await scope.cleanup(); }
});

test("Grok Light preserves public thought, user newlines, owned images, Mermaid, and citations", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(grokFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(grokFixture) });
  assert.equal(first.adapter.id, "grok-light-dom-v2");
  assert.equal(first.adapter.version, "3.0.7");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  assert.deepEqual(conversation["models"], ["grok-fixture"]);
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]), ["image", "attachment", "markdown"]);
  assert.equal((messages[0]!["content"] as JsonObject[])[2]?.["text"], "Hello\nline two");
  assert.deepEqual((messages[1]!["content"] as JsonObject[]).map((block) => block["type"]), [
    "reasoning", "markdown", "diagram", "image", "citations"
  ]);
  assert.equal((messages[1]!["content"] as JsonObject[])[2]?.["rendered"], "r3");
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["image", "embedded"], ["file", "metadata_only"], ["diagram", "embedded"], ["image", "embedded"]
  ]);
  assert.equal((conversation["sources"] as JsonObject[]).length, 1);
  assert.equal((globalThis as { __grok_must_not_run?: boolean }).__grok_must_not_run, undefined);
});

test("Grok Full orders API steps without duplicating the aggregate thought and embeds original resources", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(grokFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "grok-export-data");
    manifest["exporter_version"] = "1.0.6-full";
    manifest["payload"] = { format: "osis.grok.chat-export/full-v1", element_id: "grok-export-data" };
    payload["format"] = "osis.grok.chat-export/full-v1";
    payload["exporter_version"] = "1.0.6-full";
    const messages = payload["messages"] as JsonObject[];
    messages[0]!["create_time"] = "2026-08-31T20:59:00.000Z";
    messages[1]!["create_time"] = "2026-08-31T21:00:00.000Z";
    const occurrences = messages[0]!["attachments"] as JsonObject[];
    occurrences[0]!["resource_key"] = "fixture-image";
    occurrences[1]!["resource_key"] = "fixture-file";
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=";
    payload["resources"] = [
      {
        key: "fixture-image", kind: "attachment_image", is_image: true, name: "Fixture upload",
        mime_type: "image/png", availability: "embedded_original", data_url: png,
        width: 1, height: 1, original_width: 64, original_height: 64, source_response_id: "grok-user"
      },
      {
        key: "fixture-file", kind: "attachment", is_image: false, name: "notes.txt",
        mime_type: "text/plain", availability: "embedded_original",
        data_url: "data:text/plain;charset=utf-8;base64,aGVsbG8=", source_response_id: "grok-user"
      },
      {
        key: "fixture-search-image", kind: "public_search_image", is_image: true,
        name: "Fixture search image", alt: "Fixture search image", mime_type: "image/png",
        availability: "embedded_original", data_url: png, width: 1, height: 1,
        original_width: 128, original_height: 128, source_response_id: "grok-assistant"
      }
    ];
    delete payload["images"];
    payload["raw_api"] = {
      conversation: { title: "Fixture Grok" },
      inflight_responses: [],
      responses: [
        {
          responseId: "grok-user", parentResponseId: "", sender: "human", model: "",
          createTime: "2026-08-31T20:59:00.000Z", message: "Hello\nline two", steps: []
        },
        {
          responseId: "grok-assistant", parentResponseId: "grok-user", sender: "assistant",
          model: "grok-fixture", createTime: "2026-08-31T21:00:00.000Z",
          message: String(messages[1]!["raw_message"] ?? ""),
          steps: [
            { tags: ["header"], text: "Examining the fixture.", toolUsageCards: [], toolUsageResults: [], webSearchResults: [], ragResults: [], connectorSearchResults: [], collectionSearchResults: [], xposts: [], xpostIds: [] },
            { tags: ["tool_usage_card"], text: "Searching the fixture docs.", toolUsageCards: [{ toolUsageCardId: "vendor-call-1", webSearch: { query: "fixture query" } }], toolUsageResults: [], webSearchResults: [], ragResults: [], connectorSearchResults: [], collectionSearchResults: [], xposts: [], xpostIds: [] },
            { tags: ["tool_usage_card"], text: "Reviewing the fixture result.", toolUsageCards: [], toolUsageResults: [{ toolUsageCardId: "vendor-call-1", webSearchResults: [{ title: "Fixture source", url: "https://example.test/grok-source" }] }], webSearchResults: [], ragResults: [], connectorSearchResults: [], collectionSearchResults: [], xposts: [], xpostIds: [] },
            { tags: ["raw_function_result"], text: "", toolUsageCards: [], toolUsageResults: [], webSearchResults: [{ title: "Fixture source", url: "https://example.test/grok-source" }], ragResults: [], connectorSearchResults: [], collectionSearchResults: [], xposts: [], xpostIds: [] }
          ]
        }
      ]
    };
    let full = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "grok-export-data", payload);
    const source = path.join(scope.base, "grok-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "grok-full-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const assistant = ((conversation["messages"] as JsonObject[])[1]!["content"] as JsonObject[]);
    assert.deepEqual(assistant.map((block) => block["type"]), [
      "reasoning", "reasoning", "tool", "reasoning", "tool", "search", "markdown", "diagram", "image", "citations"
    ]);
    assert.equal(assistant.filter((block) => block["type"] === "reasoning").length, 3);
    assert.equal(assistant.some((block) => block["type"] === "reasoning" && block["text"] === "I examined the fixture source."), false);
    assert.equal(assistant.find((block) => block["kind"] === "call")?.["call"], "x1");
    assert.equal(assistant.find((block) => block["kind"] === "result")?.["call"], "x1");
    assert.doesNotMatch(JSON.stringify(assistant), /vendor-call-1/u);
    assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
      ["image", "embedded"], ["file", "embedded"], ["diagram", "embedded"], ["image", "embedded"]
    ]);
  } finally {
    await scope.cleanup();
  }
});

test("Grok Tree preserves parent-first identity, selected leaf, and inert HTML details", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(grokFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "grok-export-data");
    manifest["exporter_version"] = "1.0.6-all-branches";
    manifest["payload"] = { format: "osis.grok.chat-export/all-branches-v1", element_id: "grok-export-data" };
    payload["format"] = "osis.grok.chat-export/all-branches-v1";
    payload["exporter_version"] = "1.0.6-all-branches";
    const linear = structuredClone(payload["messages"] as JsonObject[]);
    linear[0]!["create_time"] = "2026-08-31T20:59:00.000Z";
    linear[1]!["create_time"] = "2026-08-31T21:00:00.000Z";
    const branchUser: JsonObject = {
      role: "user", source_id: "response-grok-branch-user", response_id: "grok-branch-user",
      parent_response_id: "grok-assistant", model: "", create_time: "2026-08-31T21:01:00.000Z",
      raw_message: "Open the branch.", thoughts: [], sources: [], attachments: [], child_response_ids: ["grok-branch-assistant"]
    };
    const branchAssistant: JsonObject = {
      role: "assistant", source_id: "response-grok-branch-assistant", response_id: "grok-branch-assistant",
      parent_response_id: "grok-branch-user", model: "grok-branch", create_time: "2026-08-31T21:02:00.000Z",
      raw_message: "<details open onclick=\"globalThis.bad=true\"><summary>Branch detail</summary><p>Visible branch body</p><script>globalThis.bad=true</script></details>",
      thoughts: [], sources: [], attachments: [], child_response_ids: []
    };
    linear[0]!["child_response_ids"] = ["grok-assistant"];
    linear[1]!["child_response_ids"] = ["grok-branch-user"];
    payload["nodes"] = [...linear, branchUser, branchAssistant];
    delete payload["messages"];
    payload["roots"] = ["grok-user"];
    payload["leaves"] = ["grok-branch-assistant"];
    payload["current_path_response_ids"] = ["grok-user", "grok-assistant", "grok-branch-user", "grok-branch-assistant"];
    payload["resources"] = [];
    delete payload["images"];
    payload["raw_api"] = {
      conversation: {}, inflight_responses: [],
      responses: [
        { responseId: "grok-user", parentResponseId: "", sender: "human", createTime: "2026-08-31T20:59:00.000Z", message: String(linear[0]!["raw_message"] ?? ""), steps: [] },
        { responseId: "grok-assistant", parentResponseId: "grok-user", sender: "assistant", model: "grok-fixture", createTime: "2026-08-31T21:00:00.000Z", message: String(linear[1]!["raw_message"] ?? ""), steps: [] },
        { responseId: "grok-branch-user", parentResponseId: "grok-assistant", sender: "human", createTime: "2026-08-31T21:01:00.000Z", message: String(branchUser["raw_message"] ?? ""), steps: [] },
        { responseId: "grok-branch-assistant", parentResponseId: "grok-branch-user", sender: "assistant", model: "grok-branch", createTime: "2026-08-31T21:02:00.000Z", message: String(branchAssistant["raw_message"] ?? ""), steps: [{ tags: ["header"], text: "Opening the branch.", toolUsageCards: [], toolUsageResults: [], webSearchResults: [], ragResults: [], connectorSearchResults: [], collectionSearchResults: [], xposts: [], xpostIds: [] }] }
      ]
    };
    let tree = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    tree = replaceJsonScript(tree, "grok-export-data", payload);
    const source = path.join(scope.base, "grok-tree.html");
    await writeFile(source, tree, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "grok-all-branches-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const messages = conversation["messages"] as JsonObject[];
    assert.deepEqual(messages.map((message) => [message["id"], message["parent"] ?? null, message["role"]]), [
      ["m1", null, "user"], ["m2", "m1", "assistant"], ["m3", "m2", "user"], ["m4", "m3", "assistant"]
    ]);
    assert.equal(conversation["current_message"], "m4");
    const branch = messages[3]!["content"] as JsonObject[];
    const html = String(branch.find((block) => block["type"] === "html")?.["html"] ?? "");
    assert.match(html, /<details open="">/u);
    assert.match(html, /Visible branch body/u);
    assert.doesNotMatch(html, /onclick|<script|globalThis/u);
  } finally {
    await scope.cleanup();
  }
});

test("Doubao Light uses payload order while preserving rich DOM, public thought, attachments, images, and Mermaid", async () => {
  const evidence = await extractStaticReadingEvidence(createReadStream(filePath(doubaoFixture)));
  const fixtureBytes = await readFile(doubaoFixture);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < fixtureBytes.byteLength; offset += 11) {
    chunks.push(fixtureBytes.subarray(offset, Math.min(fixtureBytes.byteLength, offset + 11)));
  }
  const chunkedEvidence = await extractStaticReadingEvidence(Readable.from(chunks));
  assert.deepEqual(chunkedEvidence, evidence);
  assert.equal(evidence.fragments.length, 2);
  assert.equal(evidence.fragments[0]?.messageId, "doubao-user");
  assert.equal(evidence.images.length, 1);
  assert.equal(evidence.files.length, 0);
  assert.equal(evidence.mermaid.length, 1);

  const first = await parseExporterHtmlToDraft({ filePath: filePath(doubaoFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(doubaoFixture) });
  assert.equal(first.adapter.id, "doubao-light-dom-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual(messages.map((message) => message["role"]), ["user", "assistant"]);
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]), ["attachment", "image", "html"]);
  assert.deepEqual((messages[1]!["content"] as JsonObject[]).map((block) => block["type"]), ["reasoning", "diagram", "html"]);
  assert.match(String((messages[0]!["content"] as JsonObject[])[2]?.["html"]), /<strong>message<\/strong>/u);
  assert.match(String((messages[1]!["content"] as JsonObject[])[2]?.["html"]), /Assistant heading/u);
  assert.doesNotMatch(String((messages[1]!["content"] as JsonObject[])[2]?.["html"]), /osis-thinking|Reasoning from the visible page/u);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["file", "metadata_only"], ["image", "embedded"], ["diagram", "embedded"]
  ]);
  assert.equal(conversation["limitations"], undefined);
  assert.equal((globalThis as { __doubao_must_not_run?: boolean }).__doubao_must_not_run, undefined);
});

test("Doubao Full streams embedded file bytes out of rich DOM without duplicating the attachment card", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(doubaoFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "doubao-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.4-full";
    (manifest["exporter"] as JsonObject)["mode"] = "full";
    payload["schema"] = "osis.doubao.chat-export/full-dom-v1";
    payload["version"] = "1.0.4-full";
    const attachment = ((payload["messages"] as JsonObject[])[0]!["attachments"] as JsonObject[])[0]!;
    attachment["status"] = "embedded-original";
    let full = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "doubao-export-data", payload);
    full = full.replace(
      '<div class="osis-attachment-item"><div class="osis-attachment-label">notes.txt</div></div>',
      '<div class="osis-attachment-item" data-osis-attachment-identifier="fixture-file"><div class="osis-attachment-label">notes.txt</div><a class="osis-file-download" href="data:text/plain;base64,aGVsbG8=" download="notes.txt">download</a></div>'
    );
    const source = path.join(scope.base, "doubao-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "doubao-full-dom-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const file = (conversation["resources"] as JsonObject[]).find((entry) => entry["kind"] === "file");
    assert.equal(file?.["availability"], "embedded");
    assert.equal(Buffer.from((file?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello");
    const html = (conversation["messages"] as JsonObject[])
      .flatMap((message) => message["content"] as JsonObject[])
      .filter((block) => block["type"] === "html")
      .map((block) => block["html"])
      .join("");
    assert.doesNotMatch(String(html), /data:text\/plain|osis-file-download|download/u);
  } finally {
    await scope.cleanup();
  }
});

test("Kimi Light preserves public process order, rich DOM, exact TeX, Mermaid, Markmap, resources, and cited sources", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(kimiFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(kimiFixture) });
  assert.equal(first.adapter.id, "kimi-light-dom-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]), ["attachment", "image", "html"]);
  const assistant = messages[1]!["content"] as JsonObject[];
  assert.deepEqual(assistant.map((block) => block["type"]), [
    "reasoning", "diagram", "tool", "html", "diagram", "html", "image", "citations"
  ]);
  assert.equal(assistant.filter((block) => block["type"] === "diagram").length, 2);
  const html = assistant.filter((block) => block["type"] === "html").map((block) => block["html"]).join("");
  assert.match(String(html), /<p>Formula <math[^>]*><msup><mi>x<\/mi><mn>2<\/mn><\/msup><\/math>\.<\/p>/u);
  assert.doesNotMatch(String(html), /osis-thinking|osis-search|Visible thought/u);
  assert.match(String(html), /Assistant heading/u);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["file", "metadata_only"], ["image", "embedded"], ["diagram", "embedded"], ["diagram", "embedded"], ["image", "embedded"]
  ]);
  assert.equal((conversation["sources"] as JsonObject[]).length, 1);
  assert.equal((globalThis as { __kimi_must_not_run?: boolean }).__kimi_must_not_run, undefined);
});

test("Kimi Full keeps complete search-task output and embedded files without vendor tool identity", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(kimiFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "kimi-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.6-full";
    (manifest["exporter"] as JsonObject)["mode"] = "full";
    payload["schema"] = "osis.kimi.chat-export/full-dom-v1";
    payload["version"] = "1.0.6-full";
    payload["active_path_message_ids"] = ["kimi-user", "kimi-assistant"];
    const messages = payload["messages"] as JsonObject[];
    const file = (messages[0]!["attachments"] as JsonObject[])[0]!;
    file["status"] = "embedded-original";
    file["file_id"] = "fixture-file";
    file["mime_type"] = "text/plain";
    messages[0]!["api"] = {
      id: "kimi-user", role: "user", parent_id: "", children_ids: ["kimi-assistant"],
      create_time: { seconds: "1788210000", nanos: 0 }, references: [],
      blocks: [{ id: "b1", parent_id: "", type: "text", value: { content: "User rich body." } }]
    };
    messages[1]!["api"] = {
      id: "kimi-assistant", role: "assistant", parent_id: "kimi-user", children_ids: [],
      create_time: { seconds: "1788210060", nanos: 0 }, references: [],
      blocks: [
        { id: "b2", parent_id: "", type: "think", value: { summary: "思考", content: "Visible thought.\n\n```mermaid\ngraph TD\n  A-->B\n```" } },
        {
          id: "b3", parent_id: "b2", type: "tool",
          value: {
            toolCallId: "vendor-kimi-call", name: "web_search", args: "{\"query\":\"fixture\"}",
            isError: false, errorCode: 0, source: {},
            contents: [
              { content: { title: "Result one", url: "https://example.test/one", site: "example.test", snippet: "one", index: 1 } },
              { content: { title: "Result two", url: "https://example.test/two", site: "example.test", snippet: "two", index: 2 } }
            ],
            status: 2, meta: {}, action: {}, loadType: 0, contentCount: 2
          }
        },
        { id: "b4", parent_id: "b3", type: "text", value: { content: "Assistant rich body." } }
      ]
    };
    let full = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "kimi-export-data", payload);
    full = full.replace(
      '<div class="osis-attachment" data-resource-key="fixture-file">notes.txt</div>',
      '<div class="osis-attachment" data-resource-key="fixture-file">notes.txt<a class="osis-file-download" href="data:text/plain;base64,aGVsbG8=" download="notes.txt">download</a></div>'
    );
    const source = path.join(scope.base, "kimi-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "kimi-full-dom-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const assistant = (conversation["messages"] as JsonObject[])[1]!["content"] as JsonObject[];
    const tool = assistant.find((block) => block["type"] === "tool");
    assert.equal(tool?.["name"], "web_search");
    assert.equal(((tool?.["output"] as JsonObject)["contents"] as JsonObject[]).length, 2);
    assert.doesNotMatch(JSON.stringify(conversation), /vendor-kimi-call/u);
    const embedded = (conversation["resources"] as JsonObject[]).find((entry) => entry["kind"] === "file");
    assert.equal(embedded?.["availability"], "embedded");
    assert.equal(Buffer.from((embedded?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello");
    assert.deepEqual(conversation["content_time"], { basis: "unavailable" });
  } finally {
    await scope.cleanup();
  }
});

test("Kimi Tree retains topology-only system roots, real parents, and the selected source leaf", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(kimiFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "kimi-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.6-all-branches";
    (manifest["exporter"] as JsonObject)["mode"] = "tree";
    payload["schema"] = "osis.kimi.chat-export/all-branches-v1";
    payload["version"] = "1.0.6-all-branches";
    payload["active_path_message_ids"] = ["kimi-user", "kimi-assistant"];
    const messages = payload["messages"] as JsonObject[];
    messages[0]!["parent_id"] = "kimi-system";
    messages[1]!["parent_id"] = "kimi-user";
    payload["tree"] = {
      roots: ["kimi-system"],
      nodes: [
        { id: "kimi-system", parent_id: "missing-parent", children_ids: ["kimi-user"], role: "system" },
        { id: "kimi-user", parent_id: "kimi-system", children_ids: ["kimi-assistant"], role: "user" },
        { id: "kimi-assistant", parent_id: "kimi-user", children_ids: [], role: "assistant" }
      ]
    };
    let tree = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    tree = replaceJsonScript(tree, "kimi-export-data", payload);
    const source = path.join(scope.base, "kimi-tree.html");
    await writeFile(source, tree, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "kimi-all-branches-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const output = conversation["messages"] as JsonObject[];
    assert.deepEqual(output.map((message) => [message["id"], message["parent"] ?? null, message["role"], (message["content"] as JsonObject[]).length]), [
      ["m1", null, "system", 0], ["m2", "m1", "user", 3], ["m3", "m2", "assistant", 8]
    ]);
    assert.equal(conversation["current_message"], "m3");
    assert.equal((conversation["limitations"] as JsonObject[]).some((entry) => entry["code"] === "source_parent_omitted"), true);
  } finally {
    await scope.cleanup();
  }
});

test("Qwen Light preserves public thought, search, citations, occurrence-owned images, and native Mermaid", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(qwenFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(qwenFixture) });
  assert.equal(first.adapter.id, "qwen-light-messages-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]), ["attachment", "image", "markdown"]);
  assert.deepEqual((messages[1]!["content"] as JsonObject[]).map((block) => block["type"]), [
    "reasoning_summary", "search", "diagram", "markdown", "image", "citations"
  ]);
  const diagram = (messages[1]!["content"] as JsonObject[]).find((block) => block["type"] === "diagram");
  assert.equal(diagram?.["source"], "graph TD\n  A-->B");
  assert.equal((conversation["sources"] as JsonObject[])[0]?.["url"], "https://example.test/qwen-source");
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["file", "metadata_only"], ["image", "embedded"], ["diagram", "embedded"], ["image", "embedded"]
  ]);
  assert.deepEqual(conversation["content_time"], { basis: "unavailable" });
  assert.equal((globalThis as { __qwen_must_not_run?: boolean }).__qwen_must_not_run, undefined);
});

test("Qwen Full embeds central resources once and does not duplicate attachment images", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(qwenFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "qwen-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.3-full";
    (manifest["exporter"] as JsonObject)["mode"] = "full";
    payload["schema"] = "osis.qwen.chat-export/full-v1";
    payload["version"] = "1.0.3-full";
    const messages = payload["messages"] as JsonObject[];
    const userAttachments = messages[0]!["attachments"] as JsonObject[];
    userAttachments[0]!["resource_id"] = "qwen-file";
    userAttachments[0]!["status"] = "embedded-original";
    userAttachments[1]!["resource_id"] = "qwen-upload";
    userAttachments[1]!["status"] = "embedded-original";
    (messages[0]!["media"] as JsonObject[])[0]!["resource_id"] = "qwen-upload";
    const assistantMedia = messages[1]!["media"] as JsonObject[];
    assistantMedia[0]!["resource_id"] = "qwen-diagram";
    assistantMedia[1]!["resource_id"] = "qwen-generated";
    payload["resources"] = [
      { id: "qwen-file", kind: "attachment", name: "notes.txt", mime: "text/plain; charset=utf-8", data_url: "data:text/plain;base64,aGVsbG8=" },
      { id: "qwen-upload", kind: "attachment-image", name: "fixture-upload.png", mime: "image/png", data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=" },
      { id: "qwen-diagram", kind: "diagram", name: "fixture-diagram.svg", mime: "image/svg+xml; charset=utf-8", data_url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0ZXh0PmZpeHR1cmU8L3RleHQ+PC9zdmc+" },
      { id: "qwen-generated", kind: "generated-image", name: "fixture-generated.png", mime: "image/png", data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=" }
    ];
    let full = light
      .replaceAll('src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII="', 'src="https://example.test/image.png"')
      .replace("osis-mermaid-card", "qwen-static-diagram");
    full = replaceJsonScript(full, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "qwen-export-data", payload);
    const source = path.join(scope.base, "qwen-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "qwen-full-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
      ["file", "embedded"], ["image", "embedded"], ["diagram", "embedded"], ["image", "embedded"]
    ]);
    assert.equal((conversation["messages"] as JsonObject[]).flatMap((message) => message["content"] as JsonObject[]).filter((block) => block["type"] === "image").length, 2);
    const embedded = (conversation["resources"] as JsonObject[]).find((entry) => entry["kind"] === "file");
    assert.equal(Buffer.from((embedded?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello");
  } finally {
    await scope.cleanup();
  }
});

test("Qwen Tree preserves parent-first sibling branches and the selected source leaf", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(qwenFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "qwen-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.3-all-branches";
    (manifest["exporter"] as JsonObject)["mode"] = "tree";
    payload["schema"] = "osis.qwen.chat-export/all-branches-v1";
    payload["version"] = "1.0.3-all-branches";
    const messages = payload["messages"] as JsonObject[];
    messages[0]!["parent_id"] = null;
    messages[1]!["parent_id"] = "qwen-user";
    messages.push({
      id: "qwen-alternate", parent_id: "qwen-user", role: "assistant", model: "Qwen3.7-Plus",
      timestamp: "2026-08-31T20:59:30.000Z", content_markdown: "Alternate answer.",
      public_processes: [], search_queries: [], sources: [], attachments: [], media: []
    });
    payload["message_order"] = ["qwen-user", "qwen-assistant", "qwen-alternate"];
    payload["current_leaf_message_id"] = "qwen-alternate";
    payload["tree_topology"] = {
      root_ids: ["qwen-user"],
      children_by_id: { "qwen-user": ["qwen-assistant", "qwen-alternate"] },
      current_path_message_ids: ["qwen-user", "qwen-alternate"],
      terminal_leaf_ids: ["qwen-assistant", "qwen-alternate"],
      fork_points: ["qwen-user"]
    };
    let tree = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    tree = replaceJsonScript(tree, "qwen-export-data", payload);
    const source = path.join(scope.base, "qwen-tree.html");
    await writeFile(source, tree, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "qwen-all-branches-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const output = conversation["messages"] as JsonObject[];
    assert.deepEqual(output.map((message) => [message["id"], message["parent"] ?? null, message["role"]]), [
      ["m1", null, "user"], ["m2", "m1", "assistant"], ["m3", "m1", "assistant"]
    ]);
    assert.equal(conversation["current_message"], "m3");
  } finally {
    await scope.cleanup();
  }
});

test("ChatGLM Mermaid source accepts explicit source panels and data-language without a language class", async () => {
  const scope = await disposable();
  try {
    const original = await readFile(chatGlmFixture, "utf8");
    for (const explicitPanel of [false, true]) {
      const changed = original
        .replace('<code class="language-mermaid">', explicitPanel ? "<code>" : '<code data-language="mermaid">')
        .replace('<div class="osis-mermaid-panel"><pre>', explicitPanel ? '<div class="osis-mermaid-panel" data-osis-mermaid-panel="source"><pre>' : '<div class="osis-mermaid-panel"><pre>');
      const file = path.join(scope.base, "chatglm-source-panel.html");
      await writeFile(file, changed, "utf8");
      const parsed = await parseExporterHtmlToDraft({ filePath: file });
      const diagram = (parsed.draft["messages"] as JsonObject[]).flatMap(message => message["content"] as JsonObject[]).find(block => block["type"] === "diagram");
      assert.equal(diagram?.["source"], "graph TD\n  A-->B");
      assert.ok(diagram?.["rendered"]);
    }
  } finally { await scope.cleanup(); }
});

test("ChatGLM Light uses runtime order with rich DOM, public process, tools, exact math, Mermaid, resources, and sources", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(chatGlmFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(chatGlmFixture) });
  assert.equal(first.adapter.id, "chatglm-light-messages-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]).filter((type) => type !== "html"), ["image", "attachment"]);
  const assistant = messages[1]!["content"] as JsonObject[];
  assert.deepEqual(assistant.map((block) => block["type"]).filter((type) => type !== "html"), [
    "reasoning", "tool", "search", "diagram", "citations"
  ]);
  assert.match(String(assistant.find((block) => block["type"] === "reasoning")?.["text"]), /\$y\^2\$/u);
  assert.equal(assistant.find((block) => block["type"] === "diagram")?.["source"], "graph TD\n  A-->B");
  const html = assistant.filter((block) => block["type"] === "html").map((block) => block["html"]).join("");
  assert.match(String(html), /<p>Formula <math[^>]*><msup><mi>x<\/mi><mn>2<\/mn><\/msup><\/math>\.<\/p>/u);
  assert.doesNotMatch(String(html), /Duplicate DOM thought|Duplicate tool state|Duplicate search state|Duplicate sources/u);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["image", "embedded"], ["file", "metadata_only"], ["diagram", "embedded"]
  ]);
  assert.equal((conversation["sources"] as JsonObject[]).length, 1);
  assert.equal((globalThis as { __chatglm_must_not_run?: boolean }).__chatglm_must_not_run, undefined);
});

test("ChatGLM Full upgrades owned attachment bytes without changing the semantic message sequence", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(chatGlmFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "chatglm-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.4-full";
    (manifest["exporter"] as JsonObject)["mode"] = "full";
    payload["schema"] = "osis.chatglm.chat-export/full-v1";
    payload["version"] = "1.0.4-full";
    const attachments = ((payload["messages"] as JsonObject[])[0]!["attachments"] as JsonObject[]);
    for (const attachment of attachments) attachment["status"] = "embedded-original";
    let full = light.replace(
      "<strong>notes.txt</strong><span>txt · 5 B</span>",
      '<strong>notes.txt</strong><span>txt · 5 B</span><a href="data:text/plain;base64,aGVsbG8=" download="notes.txt">download</a>'
    ).replace(
      "<strong>fixture-upload.png</strong><span>png</span>",
      '<strong>fixture-upload.png</strong><span>png</span><a href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=" download="fixture-upload.png">download</a>'
    );
    full = replaceJsonScript(full, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "chatglm-export-data", payload);
    const source = path.join(scope.base, "chatglm-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "chatglm-full-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    assert.deepEqual((conversation["messages"] as JsonObject[]).map((message) => message["role"]), ["user", "assistant"]);
    const resources = conversation["resources"] as JsonObject[];
    assert.deepEqual(resources.map((entry) => [entry["kind"], entry["availability"]]), [
      ["image", "embedded"], ["file", "embedded"], ["diagram", "embedded"]
    ]);
    const file = resources.find((entry) => entry["kind"] === "file");
    assert.equal(Buffer.from((file?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello");
    assert.equal((conversation["limitations"] as JsonObject[] | undefined)?.length ?? 0, 0);
  } finally {
    await scope.cleanup();
  }
});

test("Z.ai Light keeps API Markdown authoritative while pairing owned images, reasoning, sources, and DOM Mermaid", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(zaiFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(zaiFixture) });
  assert.equal(first.adapter.id, "zai-light-messages-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]), ["attachment", "image", "markdown"]);
  const assistant = messages[1]!["content"] as JsonObject[];
  assert.deepEqual(assistant.map((block) => block["type"]), [
    "reasoning", "search", "markdown", "image", "diagram", "markdown", "citations"
  ]);
  assert.equal(assistant[0]?.["duration"], 2.5);
  assert.equal(assistant[0]?.["effort"], "high");
  assert.match(assistant.filter((block) => block["type"] === "markdown").map((block) => block["text"]).join(""), /\$\$x\^2\$\$/u);
  assert.doesNotMatch(assistant.filter((block) => block["type"] === "markdown").map((block) => block["text"]).join(""), /generated\.png/u);
  const diagram = assistant.find((block) => block["type"] === "diagram");
  assert.equal(diagram?.["source"], "graph TD\n  A-->B");
  assert.match(String(diagram?.["rendered"]), /^r[1-9][0-9]*$/u);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["file", "metadata_only"], ["image", "embedded"], ["image", "embedded"], ["diagram", "embedded"]
  ]);
  assert.equal((conversation["sources"] as JsonObject[]).length, 1);
  assert.equal((globalThis as { __zai_must_not_run?: boolean }).__zai_must_not_run, undefined);
});

test("Z.ai Full embeds central attachment/image bytes exactly once", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(zaiFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "zai-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.5-full";
    (manifest["exporter"] as JsonObject)["mode"] = "full";
    manifest["payload"] = { element_id: "zai-export-data", format: "osis.zai.chat-export/full-v1" };
    payload["schema"] = "osis.zai.chat-export/full-v1";
    payload["version"] = "1.0.5-full";
    const messages = payload["messages"] as JsonObject[];
    const attachments = messages[0]!["attachments"] as JsonObject[];
    attachments[0]!["resource_key"] = "zai-file";
    attachments[0]!["status"] = "embedded-original-bytes";
    attachments[1]!["resource_key"] = "zai-upload";
    attachments[1]!["status"] = "embedded-original-bytes";
    (messages[0]!["media"] as JsonObject[])[0]!["resource_key"] = "zai-upload";
    (messages[1]!["media"] as JsonObject[])[0]!["resource_key"] = "zai-generated";
    payload["resources"] = [
      { key: "zai-file", kind: "attachment-file", name: "notes.txt", declared_mime: "text/plain", status: "embedded-original-bytes", message_ids: ["zai-user"], data_url: "data:text/plain;base64,aGVsbG8=" },
      { key: "zai-upload", kind: "attachment-image", name: "fixture-upload.png", declared_mime: "image/png", status: "embedded-original-bytes", message_ids: ["zai-user"], data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=" },
      { key: "zai-generated", kind: "inline-image", name: "fixture-generated.png", declared_mime: "image/png", status: "embedded-original-bytes", message_ids: ["zai-assistant"], data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=" }
    ];
    let full = light
      .replaceAll('src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII="', 'src="https://example.test/image.png"');
    full = replaceJsonScript(full, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "zai-export-data", payload);
    const source = path.join(scope.base, "zai-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "zai-full-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const resources = conversation["resources"] as JsonObject[];
    assert.deepEqual(resources.map((entry) => [entry["kind"], entry["availability"]]), [
      ["file", "embedded"], ["image", "embedded"], ["image", "embedded"], ["diagram", "embedded"]
    ]);
    assert.equal((conversation["messages"] as JsonObject[]).flatMap((message) => message["content"] as JsonObject[]).filter((block) => block["type"] === "image").length, 2);
    const file = resources.find((entry) => entry["kind"] === "file");
    assert.equal(Buffer.from((file?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello");
  } finally {
    await scope.cleanup();
  }
});

test("Z.ai Tree keeps parent-first sibling branches and the selected source leaf", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(zaiFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "zai-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.5-all-branches";
    (manifest["exporter"] as JsonObject)["mode"] = "all-branches";
    manifest["payload"] = { element_id: "zai-export-data", format: "osis.zai.chat-export/all-branches-v1" };
    payload["schema"] = "osis.zai.chat-export/all-branches-v1";
    payload["version"] = "1.0.5-all-branches";
    const messages = payload["messages"] as JsonObject[];
    messages[0]!["parent_id"] = null;
    messages[1]!["parent_id"] = "zai-user";
    messages.push({
      id: "zai-alternate", parent_id: "zai-user", role: "assistant", model: "glm-5.2",
      timestamp: "2026-08-31T20:59:30.000Z", content_markdown: "Alternate answer.",
      public_processes: [], search_queries: [], sources: [], attachments: [], media: []
    });
    payload["message_order"] = ["zai-user", "zai-assistant", "zai-alternate"];
    payload["current_leaf_message_id"] = "zai-alternate";
    let tree = replaceJsonScript(light, "ai-chat-archive-manifest", manifest);
    tree = replaceJsonScript(tree, "zai-export-data", payload);
    const source = path.join(scope.base, "zai-tree.html");
    await writeFile(source, tree, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "zai-all-branches-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const output = conversation["messages"] as JsonObject[];
    assert.deepEqual(output.map((message) => [message["id"], message["parent"] ?? null, message["role"]]), [
      ["m1", null, "user"], ["m2", "m1", "assistant"], ["m3", "m1", "assistant"]
    ]);
    assert.equal(conversation["current_message"], "m3");
  } finally {
    await scope.cleanup();
  }
});

test("Yuanbao Light preserves visible duplicates and author 展开 while projecting only exact controls, local sources, math, images, and Mermaid", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(yuanbaoFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(yuanbaoFixture) });
  assert.equal(first.adapter.id, "yuanbao-light-dom-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  const user = messages[0]!["content"] as JsonObject[];
  assert.deepEqual(user.map((block) => block["type"]).filter((type) => type !== "html"), ["image", "attachment"]);
  const userHtml = user.filter((block) => block["type"] === "html").map((block) => block["html"]).join("");
  assert.equal((String(userHtml).match(/Visible duplicate\./gu) ?? []).length, 2);
  assert.match(String(userHtml), /Author details/u);
  assert.match(String(userHtml), />展开</u);
  assert.doesNotMatch(String(userHtml), /expand-toggle/u);
  const assistant = messages[1]!["content"] as JsonObject[];
  assert.deepEqual(assistant.map((block) => block["type"]).filter((type) => type !== "html"), [
    "reasoning", "search", "math", "diagram", "image", "citations"
  ]);
  const reasoning = assistant.find((block) => block["type"] === "reasoning");
  assert.equal(reasoning?.["format"], "html");
  assert.match(String(reasoning?.["text"]), /<strong>rich thought<\/strong>/u);
  assert.doesNotMatch(String(reasoning?.["text"]), /script|bad\(\)/u);
  assert.equal(assistant.find((block) => block["type"] === "math")?.["tex"], "x^2");
  assert.equal(assistant.find((block) => block["type"] === "diagram")?.["source"], "graph TD\n  A-->B");
  assert.deepEqual((assistant.find((block) => block["type"] === "citations")?.["sources"] as string[]), ["s2", "s1"]);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["image", "embedded"], ["file", "metadata_only"], ["diagram", "embedded"], ["image", "embedded"]
  ]);
  assert.deepEqual((conversation["limitations"] as JsonObject[]).map((entry) => entry["code"]), ["math_source_missing"]);
  assert.equal((globalThis as { __yuanbao_must_not_run?: boolean }).__yuanbao_must_not_run, undefined);
});

test("Yuanbao Full embeds available file bytes and leaves an explicit missing resource without changing message order", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(yuanbaoFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "yuanbao-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.7-full";
    (manifest["exporter"] as JsonObject)["mode"] = "full";
    payload["schema"] = "osis.yuanbao.chat-export/full-dom-v1";
    payload["version"] = "1.0.7-full";
    const attachments = ((payload["messages"] as JsonObject[])[0]!["attachments"] as JsonObject[]);
    attachments[1]!["status"] = "embedded-original";
    attachments.push({ kind: "file", type: "application/pdf", name: "missing.pdf", extension: "pdf", size: 10, status: "unavailable", error: "expired" });
    let full = light.replace(
      '<strong class="osis-file-name">notes.txt</strong>',
      '<strong class="osis-file-name">notes.txt</strong><a href="data:text/plain;base64,aGVsbG8=" download="notes.txt">download</a><div class="osis-attachment"><strong class="osis-file-name">missing.pdf</strong></div>'
    );
    full = replaceJsonScript(full, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "yuanbao-export-data", payload);
    const source = path.join(scope.base, "yuanbao-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "yuanbao-full-dom-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    assert.deepEqual((conversation["messages"] as JsonObject[]).map((message) => message["role"]), ["user", "assistant"]);
    const files = (conversation["resources"] as JsonObject[]).filter((entry) => entry["kind"] === "file");
    assert.deepEqual(files.map((entry) => entry["availability"]), ["embedded", "missing"]);
    assert.equal(Buffer.from((files[0]?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello");
    assert.deepEqual((conversation["limitations"] as JsonObject[]).map((entry) => entry["code"]), ["yuanbao_resource_unavailable", "math_source_missing"]);
  } finally {
    await scope.cleanup();
  }
});

test("Yuanbao file_warning is original platform file-processing content, not an exporter diagnostic", async () => {
  const scope = await disposable();
  try {
    const html = await readFile(yuanbaoFixture, "utf8");
    const payload = jsonScript(html, "yuanbao-export-data");
    (payload["messages"] as JsonObject[])[0]!["file_warning"] = "原平台提示：文件处理失败";
    const file = path.join(scope.base, "platform-warning.html");
    await writeFile(file, replaceJsonScript(html, "yuanbao-export-data", payload));
    const parsed = await parseExporterHtmlToDraft({ filePath: file });
    assert.match(JSON.stringify(parsed.draft["messages"]), /原平台提示：文件处理失败/u);
    assert.equal(parsed.systemLogErrors.some(error => String(error["message"]).includes("原平台提示")), false);
  } finally { await scope.cleanup(); }
});

test("Yuanbao uses the saved static text frame for minipage/parbox instead of reparsing unsupported TeX", async () => {
  const scope = await disposable();
  try {
    const source = await readFile(yuanbaoFixture, "utf8");
    const frame = String.raw`<div class="osis-math osis-temml-display" data-math-display="block" data-tex="\begin{minipage}Text\end{minipage}"><span class="osis-temml-frame"><span class="osis-temml-textbox-content"><strong>Saved conclusion</strong><br>Exact body</span></span></div>`;
    const file = path.join(scope.base, "text-frame.html");
    await writeFile(file, source.replace('<p>Rendered-only formula', frame + '<p>Rendered-only formula'));
    const parsed = await parseExporterHtmlToDraft({ filePath: file });
    const content = (parsed.draft["messages"] as JsonObject[]).flatMap(message => message["content"] as JsonObject[]);
    assert.ok(content.some(block => block["type"] === "html" && String(block["html"]).includes("Saved conclusion")));
    assert.equal(content.some(block => block["type"] === "math" && String(block["tex"]).includes("minipage")), false);
  } finally { await scope.cleanup(); }
});

test("Mistral reading evidence keeps message version separate from vendor ID", async () => {
  const evidence = await extractStaticReadingEvidence(createReadStream(filePath(mistralFixture)));
  assert.deepEqual(evidence.fragments.map((entry) => [entry.messageId, entry.messageVersion]), [
    ["mistral-user", "0"], ["mistral-assistant", "0"]
  ]);
  assert.ok(evidence.images.every((entry) => entry.messageVersion === "0"));
  assert.deepEqual(evidence.mermaid.map((entry) => [entry.messageId, entry.messageVersion, entry.source]), [
    ["mistral-assistant", "0", "graph TD\n  A-->B"]
  ]);
});

test("Mistral Light orders public Thought and tools while preserving rich body, Canvas, math, resources, diagrams, and references", async () => {
  const first = await parseExporterHtmlToDraft({ filePath: filePath(mistralFixture) });
  const second = await parseExporterHtmlToDraft({ filePath: filePath(mistralFixture) });
  assert.equal(first.adapter.id, "mistral-light-dom-rsc-v2");
  assert.deepEqual(first.draft, second.draft);
  const conversation = fullConversation(first.draft, { id: first.adapter.id, version: first.adapter.version });
  const messages = conversation["messages"] as JsonObject[];
  assert.deepEqual((messages[0]!["content"] as JsonObject[]).map((block) => block["type"]).filter((type) => type !== "html"), ["image", "attachment"]);
  const assistant = messages[1]!["content"] as JsonObject[];
  assert.deepEqual(assistant.map((block) => block["type"]).filter((type) => type !== "html"), [
    "reasoning", "tool", "reasoning", "diagram", "image", "citations"
  ]);
  assert.equal(assistant[0]?.["text"], "First public thought.");
  assert.equal(assistant[1]?.["name"], "web_search");
  assert.deepEqual((assistant[1]?.["output"] as JsonObject)["sources"], ["s1"]);
  assert.equal(assistant[2]?.["text"], "Second public thought.");
  const html = assistant.filter((block) => block["type"] === "html").map((block) => block["html"]).join("");
  assert.match(String(html), /<p>Formula <math[^>]*><msup><mi>x<\/mi><mn>2<\/mn><\/msup><\/math>\.<\/p>/u);
  assert.match(String(html), /Canvas title|Canvas body/u);
  assert.doesNotMatch(String(html), /Duplicate DOM thought|Duplicate DOM tool|osis-public-thinking|osis-tool-section/u);
  assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
    ["image", "embedded"], ["file", "metadata_only"], ["diagram", "embedded"]
  ]);
  assert.equal((conversation["sources"] as JsonObject[]).length, 1);
  assert.equal((globalThis as { __mistral_must_not_run?: boolean }).__mistral_must_not_run, undefined);
});

test("Mistral Full embeds central attachment and image bytes without changing the semantic sequence", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(mistralFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "mistral-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.7-full";
    (manifest["exporter"] as JsonObject)["mode"] = "full";
    payload["schema"] = "osis.mistral.chat-export/full-v1";
    payload["version"] = "1.0.7-full";
    const messages = payload["messages"] as JsonObject[];
    const attachments = messages[0]!["attachments"] as JsonObject[];
    attachments[0]!["resource_key"] = "mistral-upload";
    attachments[0]!["status"] = "embedded-original-bytes";
    attachments[1]!["resource_key"] = "mistral-file";
    attachments[1]!["status"] = "embedded-original-bytes";
    payload["resources"] = [
      { key: "mistral-upload", kind: "image", name: "fixture-upload.png", status: "embedded-original-bytes", message_keys: ["mistral-user::0"], data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=" },
      { key: "mistral-file", kind: "attachment-file", name: "notes.txt", status: "embedded-original-bytes", message_keys: ["mistral-user::0"], data_url: "data:text/plain;base64,aGVsbG8=" },
      { key: "mistral-generated", kind: "image", name: "generated.png", status: "embedded-original-bytes", message_keys: ["mistral-assistant::0"], data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=" }
    ];
    let full = light.replaceAll('src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII="', 'src="https://example.test/image.png"');
    full = replaceJsonScript(full, "ai-chat-archive-manifest", manifest);
    full = replaceJsonScript(full, "mistral-export-data", payload);
    const source = path.join(scope.base, "mistral-full.html");
    await writeFile(source, full, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "mistral-full-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    assert.deepEqual((conversation["resources"] as JsonObject[]).map((entry) => [entry["kind"], entry["availability"]]), [
      ["image", "embedded"], ["file", "embedded"], ["diagram", "embedded"]
    ]);
    const file = (conversation["resources"] as JsonObject[]).find((entry) => entry["kind"] === "file");
    assert.equal(Buffer.from((file?.["data_base64"] as string[]).join(""), "base64").toString("utf8"), "hello");
  } finally {
    await scope.cleanup();
  }
});

test("Mistral Tree treats duplicate vendor IDs with different versions as separate parent-first nodes", async () => {
  const scope = await disposable();
  try {
    const light = await readFile(mistralFixture, "utf8");
    const manifest = jsonScript(light, "ai-chat-archive-manifest");
    const payload = jsonScript(light, "mistral-export-data");
    (manifest["exporter"] as JsonObject)["version"] = "1.0.7-all-branches";
    (manifest["exporter"] as JsonObject)["mode"] = "all-branches";
    manifest["payload"] = { element_id: "mistral-export-data", format: "osis.mistral.chat-export/all-branches-v1" };
    payload["schema"] = "osis.mistral.chat-export/all-branches-v1";
    payload["version"] = "1.0.7-all-branches";
    const messages = payload["messages"] as JsonObject[];
    messages[0]!["key"] = "mistral-user::0";
    messages[1]!["key"] = "mistral-assistant::0";
    messages.push({
      ...messages[1]!, key: "mistral-assistant::1", version: 1, content_markdown: "Alternate answer.",
      public_thoughts: [], reasoning_segments: [], tools: [], references: [], reference_placements: [], diagram_sources: [], attachments: []
    });
    payload["message_order"] = [
      { id: "mistral-user", version: 0, key: "mistral-user::0" },
      { id: "mistral-assistant", version: 0, key: "mistral-assistant::0" },
      { id: "mistral-assistant", version: 1, key: "mistral-assistant::1" }
    ];
    payload["current_leaf_message_key"] = "mistral-assistant::1";
    payload["active_message_keys"] = ["mistral-user::0", "mistral-assistant::1"];
    const alternate = '<article class="osis-turn assistant" data-message-id="mistral-assistant" data-message-version="1"><div class="osis-message"><div class="osis-rich"><p>Alternate answer.</p></div></div></article>';
    let tree = light.replace("<script>globalThis.__mistral_must_not_run", `${alternate}<script>globalThis.__mistral_must_not_run`);
    tree = replaceJsonScript(tree, "ai-chat-archive-manifest", manifest);
    tree = replaceJsonScript(tree, "mistral-export-data", payload);
    const source = path.join(scope.base, "mistral-tree.html");
    await writeFile(source, tree, "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: source });
    assert.equal(parsed.adapter.id, "mistral-all-branches-v1");
    const conversation = fullConversation(parsed.draft, { id: parsed.adapter.id, version: parsed.adapter.version });
    const output = conversation["messages"] as JsonObject[];
    assert.deepEqual(output.map((message) => [message["id"], message["parent"] ?? null, message["role"]]), [
      ["m1", null, "user"], ["m2", "m1", "assistant"], ["m3", "m1", "assistant"]
    ]);
    assert.equal(conversation["current_message"], "m3");
  } finally {
    await scope.cleanup();
  }
});

test("JSON script memory threshold spills without becoming a format limit or changing semantics", async () => {
  const scope = await disposable();
  try {
  const normal = await parseExporterHtmlToDraft({ filePath: filePath(fixture) });
  const spilled = await parseExporterHtmlToDraft({
    filePath: filePath(fixture),
    temporaryRoot: testRuntimeRoot(scope.root),
    jsonScriptMemoryThresholdBytes: 128
  });
  assert.deepEqual(spilled, normal);
  } finally { await scope.cleanup(); }
});

test("explicit parse commits one new archive with recovery and Catalog watermarks, while repeat commit is zero-write", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({
      root: scope.root,
      transaction: "x_CREATEPARSERLIBAB",
      timestamp: "2026-08-31T22:10:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const imported = await importSourceStream({
      libraryRoot: scope.root,
      filename: "fixture.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_IMPORTPARSERHTMLA",
      timestamp: "2026-08-31T22:11:00.000Z"
    });
    assert.equal(imported.status, "imported");
    if (imported.status !== "imported") return;
    assert.deepEqual(await readdir(path.join(scope.root, "Conversations")), []);
    const sourcePath = "Inbox/branch01 (2).html";
    await rename(path.join(scope.root, ...imported.path.split("/")), path.join(scope.root, ...sourcePath.split("/")));
    assert.equal((await prepareCatalogForParser(scope.root, "2026-08-31T22:12:00.000Z")).status, "ready");
    const sourceAbsolute = path.join(scope.root, ...sourcePath.split("/"));
    const parsed = await parseExporterHtmlToDraft({ filePath: sourceAbsolute });
    const expectedConversation = finalizeConversation({
      schema: "cloudig/conversation/1.0.0",
      archive: "a1",
      generation: 1,
      content_sha256: "0".repeat(64),
      parser: { version: PARSER_VERSION, adapter: { id: parsed.adapter.id, version: parsed.adapter.version } },
      lifecycle: {
        first_parsed_at: { basis: "parser", value: "2026-08-31T22:13:00.000Z" },
        last_parsed_at: "2026-08-31T22:13:00.000Z",
        cloudig_edited_at: "2026-08-31T22:13:00.000Z"
      },
      ...parsed.draft,
      user: { revision: 1, edited_at: "2026-08-31T22:13:00.000Z", conversation_name: "branch01 (2)" }
    });
    const expectedConversationBytes = serializeConversation(expectedConversation);
    const created = await commitNewParsedSource({
      libraryRoot: scope.root,
      sourcePath,
      parsed,
      transaction: "x_PARSEFIXTUREABCDE",
      recoveryTransaction: "x_PARSEFIXRECOVERYA",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-08-31T22:13:00.000Z"
    });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    assert.equal(created.archive, "a1");
    assert.equal(created.catalog, "written");
    assert.equal(created.path, "Conversations/branch01 (2)--a1.json");
    const installedConversationBytes = await readFile(path.join(scope.root, ...created.path.split("/")), "utf8");
    assert.equal(installedConversationBytes, expectedConversationBytes);
    const output = JSON.parse(installedConversationBytes) as JsonObject;
    assert.equal(output["schema"], "cloudig/conversation/1.0.0");
    assert.equal(output["archive"], "a1");
    assert.equal(output["title"], parsed.draft["title"], "the original conversation title remains source evidence");
    assert.equal((output["messages"] as JsonObject[]).length, 4);
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "valid");
    if (inspection.status === "valid") {
      assert.equal(inspection.pair.library["revision"], 2);
      assert.equal(inspection.pair.library["next_archive"], 2);
      assert.deepEqual((inspection.pair.library["archives"] as JsonObject)["a1"], output["user"]);
    }
    const previous = await readPreviousAuthorityPair(scope.root);
    assert.equal(previous.library["revision"], 1);
    assert.equal(previous.library["next_archive"], 1);
    const catalog = await readCatalogCache(scope.root);
    assert.ok(catalog);
    assert.equal((catalog["sources"] as JsonObject[])[0]!["status"], "complete");
    assert.equal(((catalog["sources"] as JsonObject[])[0]!["outputs"] as JsonObject[]).length, 1);
    assert.equal((catalog["archives"] as JsonObject[]).length, 1);
    assert.deepEqual(await fingerprintFile(sourceAbsolute), imported.fingerprint);

    const beforeRetry = await inventory(scope.root);
    const retry = await commitNewParsedSource({
      libraryRoot: scope.root,
      sourcePath,
      parsed: await parseExporterHtmlToDraft({ filePath: sourceAbsolute }),
      transaction: "x_PARSEFIXTUREBCDEF",
      recoveryTransaction: "x_PARSEFIXRECOVERYB",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-08-31T22:14:00.000Z"
    });
    assert.deepEqual(retry, { status: "conflict", reason: "source_already_has_output" });
    assert.deepEqual(await inventory(scope.root), beforeRetry);
  } finally {
    await scope.cleanup();
  }
});

test("safe update keeps aN and user state while preserve_previous creates a new aN without rewriting the old generation", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({
      root: scope.root,
      transaction: "x_CCCCCCCCCCCCCCCC",
      timestamp: "2026-09-01T01:00:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00",
      language: "zh-CN"
    });
    const imported = await importSourceStream({
      libraryRoot: scope.root,
      filename: "safe-update.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_DDDDDDDDDDDDDDDD",
      timestamp: "2026-09-01T01:01:00.000Z"
    });
    assert.equal(imported.status, "imported");
    if (imported.status !== "imported") return;
    assert.equal((await prepareCatalogForParser(scope.root, "2026-09-01T01:02:00.000Z")).status, "ready");
    const sourceAbsolute = path.join(scope.root, ...imported.path.split("/"));
    const first = await commitNewParsedSource({
      libraryRoot: scope.root,
      sourcePath: imported.path,
      parsed: await parseExporterHtmlToDraft({ filePath: sourceAbsolute }),
      transaction: "x_EEEEEEEEEEEEEEEE",
      recoveryTransaction: "x_FFFFFFFFFFFFFFFF",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-09-01T01:03:00.000Z"
    });
    assert.equal(first.status, "created");
    if (first.status !== "created") return;
    const edited = await commitArchiveUserState({
      libraryRoot: scope.root,
      relativePath: first.path,
      expected: { ...first.fingerprint, archive: first.archive, generation: first.generation },
      expectedLibraryRevision: 2,
      expectedArchiveRevision: 1,
      patch: {
        conversationName: { state: "set", value: "老婆编辑的标题" },
        models: { state: "inherit" },
        contentTime: { state: "inherit" }
      },
      touchOnNoop: false,
      anchor: { date: "2026-09-01", offset: "-07:00" },
      transaction: "x_GGGGGGGGGGGGGGGG",
      recoveryTransaction: "x_HHHHHHHHHHHHHHHH",
      timestamp: "2026-09-01T01:04:00.000Z"
    });
    assert.equal(edited.status, "updated");
    await appendFile(sourceAbsolute, "\n", "utf8");
    const changed = await parseExporterHtmlToDraft({ filePath: sourceAbsolute });
    const updatePlan = await prepareParsedSourceWritePlan({
      libraryRoot: scope.root,
      sourcePath: imported.path,
      parsed: changed,
      preservePrevious: false,
      copyUserStateOnPreserve: true
    });
    assert.equal(updatePlan.action, "safe_update");
    assert.equal(updatePlan.binding?.archive, "a1");
    assert.equal(Object.hasOwn(updatePlan.binding ?? {}, "conversation"), false, "safe-update plans must not retain the old Conversation body");
    const updated = await commitPlannedParsedSource({
      libraryRoot: scope.root,
      plan: updatePlan,
      parsed: changed,
      transaction: "x_JJJJJJJJJJJJJJJJ",
      recoveryTransaction: "x_KKKKKKKKKKKKKKKK",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-09-01T01:05:00.000Z"
    });
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    assert.equal(updated.archive, "a1");
    assert.equal(updated.generation, 2);
    assert.equal(updated.path, first.path);
    const updatedConversation = JSON.parse(await readFile(path.join(scope.root, ...updated.path.split("/")), "utf8")) as JsonObject;
    assert.equal(updatedConversation["generation"], 2);
    assert.equal(((updatedConversation["user"] as JsonObject)["conversation_name"]), "老婆编辑的标题");
    assert.deepEqual((updatedConversation["lifecycle"] as JsonObject)["first_parsed_at"], { basis: "parser", value: "2026-09-01T01:03:00.000Z" });
    const afterUpdate = await readCurrentAuthorityPair(scope.root);
    assert.equal(afterUpdate.library["revision"], 3);
    assert.equal((((afterUpdate.library["archives"] as JsonObject)["a1"] as JsonObject)["conversation_name"]), "老婆编辑的标题");

    const preserveParsed = await parseExporterHtmlToDraft({ filePath: sourceAbsolute });
    const preservePlan = await prepareParsedSourceWritePlan({
      libraryRoot: scope.root,
      sourcePath: imported.path,
      parsed: preserveParsed,
      preservePrevious: true,
      copyUserStateOnPreserve: true
    });
    assert.equal(preservePlan.action, "preserve");
    const preserved = await commitPlannedParsedSource({
      libraryRoot: scope.root,
      plan: preservePlan,
      parsed: preserveParsed,
      transaction: "x_LLLLLLLLLLLLLLLL",
      recoveryTransaction: "x_MMMMMMMMMMMMMMMM",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-09-01T01:06:00.000Z"
    });
    assert.equal(preserved.status, "preserved");
    if (preserved.status !== "preserved") return;
    assert.equal(preserved.archive, "a2");
    assert.equal(preserved.generation, 1);
    assert.notEqual(preserved.path, updated.path);
    const original = JSON.parse(await readFile(path.join(scope.root, ...updated.path.split("/")), "utf8")) as JsonObject;
    const copy = JSON.parse(await readFile(path.join(scope.root, ...preserved.path.split("/")), "utf8")) as JsonObject;
    assert.equal(original["generation"], 2);
    assert.equal(((copy["user"] as JsonObject)["conversation_name"]), "老婆编辑的标题");
    const afterPreserve = await readCurrentAuthorityPair(scope.root);
    assert.equal(afterPreserve.library["next_archive"], 3);
    assert.equal((((afterPreserve.library["archives"] as JsonObject)["a2"] as JsonObject)["conversation_name"]), "老婆编辑的标题");
  } finally {
    await scope.cleanup();
  }
});

test("a uniquely moved source migrates its Catalog line without rewriting the archive, then safely updates from the new path", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({
      root: scope.root,
      transaction: "x_NNNNNNNNNNNNNNNN",
      timestamp: "2026-09-01T01:10:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00",
      language: "zh-CN"
    });
    const imported = await importSourceStream({
      libraryRoot: scope.root,
      filename: "before.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_PPPPPPPPPPPPPPPP",
      timestamp: "2026-09-01T01:11:00.000Z"
    });
    assert.equal(imported.status, "imported");
    if (imported.status !== "imported") return;
    assert.equal((await prepareCatalogForParser(scope.root, "2026-09-01T01:12:00.000Z")).status, "ready");
    const beforeAbsolute = path.join(scope.root, "Inbox", "before.html");
    const first = await commitNewParsedSource({
      libraryRoot: scope.root,
      sourcePath: imported.path,
      parsed: await parseExporterHtmlToDraft({ filePath: beforeAbsolute }),
      transaction: "x_QQQQQQQQQQQQQQQQ",
      recoveryTransaction: "x_RRRRRRRRRRRRRRRR",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-09-01T01:13:00.000Z"
    });
    assert.equal(first.status, "created");
    if (first.status !== "created") return;

    const afterAbsolute = path.join(scope.root, "Inbox", "after.html");
    await rename(beforeAbsolute, afterAbsolute);
    assert.equal((await prepareCatalogForParser(scope.root, "2026-09-01T01:14:00.000Z")).status, "ready");
    let catalog = (await readCatalogCache(scope.root))!;
    assert.deepEqual((catalog["sources"] as JsonObject[]).map((row) => row["path"]), ["Inbox/after.html", "Inbox/before.html"]);
    const movedDraft = await parseExporterHtmlToDraft({ filePath: afterAbsolute });
    const movedPlan = await prepareParsedSourceWritePlan({
      libraryRoot: scope.root,
      sourcePath: "Inbox/after.html",
      parsed: movedDraft,
      preservePrevious: false,
      copyUserStateOnPreserve: true
    });
    assert.equal(movedPlan.action, "unchanged");
    assert.equal(movedPlan.reason, "registered_source_moved");
    assert.equal(movedPlan.binding?.registeredSourcePath, "Inbox/before.html");
    const libraryBefore = await readFile(path.join(scope.root, "cloudig-library.json"));
    const archiveBefore = await readFile(path.join(scope.root, ...first.path.split("/")));
    const moved = await commitPlannedParsedSource({
      libraryRoot: scope.root,
      plan: movedPlan,
      parsed: movedDraft,
      transaction: "x_SSSSSSSSSSSSSSSS",
      recoveryTransaction: "x_TTTTTTTTTTTTTTTT",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-09-01T01:15:00.000Z"
    });
    assert.equal(moved.status, "unchanged");
    assert.deepEqual(await readFile(path.join(scope.root, "cloudig-library.json")), libraryBefore);
    assert.deepEqual(await readFile(path.join(scope.root, ...first.path.split("/"))), archiveBefore);
    catalog = (await readCatalogCache(scope.root))!;
    const migratedSources = catalog["sources"] as JsonObject[];
    assert.deepEqual(migratedSources.map((row) => row["path"]), ["Inbox/after.html"]);
    assert.equal(((migratedSources[0]!["outputs"] as JsonObject[])[0] as JsonObject)["archive"], "a1");

    await appendFile(afterAbsolute, "\n", "utf8");
    const changedDraft = await parseExporterHtmlToDraft({ filePath: afterAbsolute });
    const updatePlan = await prepareParsedSourceWritePlan({
      libraryRoot: scope.root,
      sourcePath: "Inbox/after.html",
      parsed: changedDraft,
      preservePrevious: false,
      copyUserStateOnPreserve: true
    });
    assert.equal(updatePlan.action, "safe_update");
    const updated = await commitPlannedParsedSource({
      libraryRoot: scope.root,
      plan: updatePlan,
      parsed: changedDraft,
      transaction: "x_UUUUUUUUUUUUUUUU",
      recoveryTransaction: "x_VVVVVVVVVVVVVVVV",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-09-01T01:16:00.000Z"
    });
    assert.equal(updated.status, "updated");
    if (updated.status === "updated") {
      assert.equal(updated.archive, "a1");
      assert.equal(updated.generation, 2);
      const output = JSON.parse(await readFile(path.join(scope.root, ...updated.path.split("/")), "utf8")) as JsonObject;
      assert.equal((output["source"] as JsonObject)["file"], "after.html");
      assert.equal((output["user"] as JsonObject)["conversation_name"], "before", "renaming the source and reparsing do not reinitialize the name");
      assert.equal(updated.path, first.path);
    }
  } finally {
    await scope.cleanup();
  }
});

test("large embedded resources finish committed verification and Catalog publication despite cancellation during verify", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({
      root: scope.root,
      transaction: "x_CREATELARGERESAB",
      timestamp: "2026-08-31T22:15:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const imported = await importSourceStream({
      libraryRoot: scope.root,
      filename: "large-resource.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_IMPORTLARGERESAB",
      timestamp: "2026-08-31T22:16:00.000Z"
    });
    assert.equal(imported.status, "imported");
    if (imported.status !== "imported") return;
    assert.equal((await prepareCatalogForParser(scope.root, "2026-08-31T22:17:00.000Z")).status, "ready");
    const parsed = await parseExporterHtmlToDraft({ filePath: path.join(scope.root, ...imported.path.split("/")) });
    const resources = parsed.draft["resources"];
    assert.ok(Array.isArray(resources));
    const embedded = resources.find((entry): entry is JsonObject => isJsonObject(entry) && entry["availability"] === "embedded");
    assert.ok(embedded);
    const payload = Buffer.alloc(8 * 1024 * 1024 + 17, 0x5a);
    embedded["bytes"] = payload.byteLength;
    embedded["sha256"] = createHash("sha256").update(payload).digest("hex");
    embedded["data_base64"] = encodedResourceChunks(payload);
    const expectedEmbeddedBytes = resources.reduce<number>((sum, entry) => (
      isJsonObject(entry) && entry["availability"] === "embedded" && typeof entry["bytes"] === "number"
        ? sum + entry["bytes"]
        : sum
    ), 0);
    const progress: Array<readonly [number, number]> = [];
    const cancellation = new AbortController();
    const created = await commitNewParsedSource({
      libraryRoot: scope.root,
      sourcePath: imported.path,
      parsed,
      transaction: "x_PARSELARGERESABC",
      recoveryTransaction: "x_PARSELARGERECOVX",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-08-31T22:18:00.000Z",
      signal: cancellation.signal,
      onPhase: phase => { if (phase === "verify") cancellation.abort(new Error("cancel remaining work")); },
      onResourceProgress: (completed, total) => progress.push([completed, total])
    });
    assert.equal(created.status, "created");
    assert.equal(cancellation.signal.aborted, true);
    if (created.status !== "created") return;
    assert.deepEqual(progress.at(-1), [expectedEmbeddedBytes, expectedEmbeddedBytes]);
    assert.ok((await stat(path.join(scope.root, ...created.path.split("/")))).size > payload.byteLength);
    assert.deepEqual(await readdir(path.join(scope.root, "Data", "Transactions")), []);
    const catalog = await readCatalogCache(scope.root);
    assert.ok(catalog);
    assert.equal((catalog["archives"] as JsonObject[]).length, 1);
    const movedRoot = path.join(scope.base, "Moved-Library");
    await rename(scope.root, movedRoot);
    await rename(movedRoot, scope.root);
  } finally {
    await scope.cleanup();
  }
});

test("cancelling resource decode removes only the current transaction spool and publishes no archive", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({
      root: scope.root,
      transaction: "x_CREATECANCELRESAB",
      timestamp: "2026-08-31T22:19:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const imported = await importSourceStream({
      libraryRoot: scope.root,
      filename: "cancel-resource.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_IMPORTCANCELRESAB",
      timestamp: "2026-08-31T22:20:00.000Z"
    });
    assert.equal(imported.status, "imported");
    if (imported.status !== "imported") return;
    assert.equal((await prepareCatalogForParser(scope.root, "2026-08-31T22:21:00.000Z")).status, "ready");
    const parsed = await parseExporterHtmlToDraft({ filePath: path.join(scope.root, ...imported.path.split("/")) });
    const resources = parsed.draft["resources"];
    assert.ok(Array.isArray(resources));
    const embedded = resources.find((entry): entry is JsonObject => isJsonObject(entry) && entry["availability"] === "embedded");
    assert.ok(embedded);
    const payload = Buffer.alloc(2 * 1024 * 1024 + 7, 0x31);
    embedded["bytes"] = payload.byteLength;
    embedded["sha256"] = createHash("sha256").update(payload).digest("hex");
    embedded["data_base64"] = encodedResourceChunks(payload);
    const controller = new AbortController();
    const cancelled = await commitNewParsedSource({
      libraryRoot: scope.root,
      sourcePath: imported.path,
      parsed,
      transaction: "x_PARSECANCELRESABC",
      recoveryTransaction: "x_PARSECANCELRECOV",
      recoveryAlreadyCapturedThisBatch: false,
      timestamp: "2026-08-31T22:22:00.000Z",
      signal: controller.signal,
      onResourceProgress: (completed) => {
        if (completed >= RESOURCE_BASE64_DECODED_CHUNK_BYTES) controller.abort();
      }
    });
    assert.deepEqual(cancelled, { status: "cancelled" });
    assert.deepEqual(await readdir(path.join(scope.root, "Conversations")), []);
    assert.deepEqual(await readdir(path.join(scope.root, "Data", "Transactions")), []);
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "valid");
    if (inspection.status === "valid") assert.equal(inspection.pair.library["revision"], 1);
  } finally {
    await scope.cleanup();
  }
});

test("mixed parse batch isolates an unsupported file, commits the valid file, and emits path-free operation events", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({
      root: scope.root,
      transaction: "x_CREATEMIXEDLIBRARY",
      timestamp: "2026-08-31T22:20:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const invalid = await importSourceStream({
      libraryRoot: scope.root,
      filename: "invalid.html",
      source: Readable.from([Buffer.from("<!doctype html><p>not an archive</p>", "utf8")]),
      transaction: "x_IMPORTINVALIDHTML",
      timestamp: "2026-08-31T22:21:00.000Z"
    });
    const valid = await importSourceStream({
      libraryRoot: scope.root,
      filename: "valid.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_IMPORTVALIDHTMLAB",
      timestamp: "2026-08-31T22:21:00.000Z"
    });
    assert.equal(invalid.status, "imported");
    assert.equal(valid.status, "imported");
    if (invalid.status !== "imported" || valid.status !== "imported") return;
    const events: JsonObject[] = [];
    const plan = await prepareParseBatch({ runtimeRoot: testRuntimeRoot(scope.root),
      libraryRoot: scope.root,
      sourcePaths: [invalid.path, valid.path],
      operation: "o_MIXEDPREVIEWABCD",
      preservePrevious: false,
      copyUserStateOnPreserve: true,
      onEvent: (event) => events.push(event)
    });
    assert.deepEqual(plan.items.map((entry) => entry.action), ["excluded", "new"]);
    assert.ok(plan.drafts?.has(valid.path));
    const previewEventCount = events.length;
    const result = await runPreparedParseBatch({ runtimeRoot: testRuntimeRoot(scope.root),
      libraryRoot: scope.root,
      plan,
      operation: "o_MIXEDBATCHABCDEF",
      transactionTokens: ["x_MIXEDINVALIDABCD", "x_MIXEDVALIDABCDEF"],
      recoveryTransaction: "x_MIXEDRECOVERYABC",
      timestamp: "2026-08-31T22:22:00.000Z",
      copyUserStateOnPreserve: true,
      onEvent: (event) => events.push(event)
    });
    assert.equal(result.state, "failed");
    assert.deepEqual(result.items.map((entry) => entry.status), ["failed", "created"]);
    assert.equal(plan.drafts?.size, 0);
    assert.equal(events.slice(previewEventCount).some(event => event["phase"] === "normalize"), false, "confirmed preview must not normalize the same bytes twice");
    assert.equal((await readdir(path.join(scope.root, "Conversations"))).length, 1);
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "valid");
    if (inspection.status === "valid") assert.equal(inspection.pair.library["next_archive"], 2);
    assert.ok(events.some((event) => event["state"] === "failed"));
    assert.equal(events.at(-1)?.["state"], "completed");
    const eventText = JSON.stringify(events);
    assert.equal(eventText.includes("invalid.html"), false);
    assert.equal(eventText.includes("valid.html"), false);
    assert.equal(eventText.includes("Inbox/"), false);
    const catalog = (await readCatalogCache(scope.root))!;
    const sourceRows = catalog["sources"] as JsonObject[];
    const invalidRow = sourceRows.find((entry) => entry["path"] === invalid.path)!;
    const validRow = sourceRows.find((entry) => entry["path"] === valid.path)!;
    assert.equal(invalidRow["status"], "failed", "The first source-content failure retains one explicit retry");
    assert.deepEqual(invalidRow["error"], { code: "unsupported-source", phase: "probe", retry: "immediate" });
    assert.equal((invalidRow["failure"] as JsonObject)["attempts"], 1);
    assert.equal(validRow["status"], "complete");
    let log = await readSystemLog(scope.root);
    assert.deepEqual((log["files"] as JsonObject[]).map((entry) => entry["path"]), [invalid.path]);
    assert.deepEqual((((log["files"] as JsonObject[])[0]!)["errors"] as JsonObject[])[0], {
      source: "parser",
      code: "unsupported-source",
      stage: "probe",
      message: "Manifest JSON script is missing"
    });

    await writeFile(path.join(scope.root, ...invalid.path.split("/")), await readFile(fixture));
    const repairedPlan = await prepareParseBatch({ runtimeRoot: testRuntimeRoot(scope.root),
      libraryRoot: scope.root,
      sourcePaths: [invalid.path],
      operation: "o_REPAIREDPREVIEWA",
      preservePrevious: false,
      copyUserStateOnPreserve: true
    });
    const repaired = await runPreparedParseBatch({ runtimeRoot: testRuntimeRoot(scope.root),
      libraryRoot: scope.root,
      plan: repairedPlan,
      operation: "o_REPAIREDBATCHABC",
      transactionTokens: ["x_REPAIREDSOURCEAA"],
      recoveryTransaction: "x_REPAIREDRECOVERY",
      timestamp: "2026-08-31T22:23:00.000Z",
      copyUserStateOnPreserve: true
    });
    assert.equal(repaired.items[0]?.status, "created");
    log = await readSystemLog(scope.root);
    assert.deepEqual(log, { schema: "cloudig/system-log/1.0.0", files: [] });
  } finally {
    await scope.cleanup();
  }
});

test("parse cancellation stops the current file, leaves later work unstarted, and commits no archive", async () => {
  const scope = await disposable();
  try {
    await createLocalLibrary({
      root: scope.root,
      transaction: "x_CREATECANCELLIBAB",
      timestamp: "2026-08-31T22:30:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const first = await importSourceStream({
      libraryRoot: scope.root,
      filename: "first.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_IMPORTCANCELFIRST",
      timestamp: "2026-08-31T22:31:00.000Z"
    });
    const second = await importSourceStream({
      libraryRoot: scope.root,
      filename: "second.html",
      source: createReadStream(filePath(fixture)),
      transaction: "x_IMPORTCANCELSECON",
      timestamp: "2026-08-31T22:31:00.000Z"
    });
    assert.equal(first.status, "imported");
    assert.equal(second.status, "imported");
    if (first.status !== "imported" || second.status !== "imported") return;
    const controller = new AbortController();
    const events: JsonObject[] = [];
    const result = await runNewParseBatch({ runtimeRoot: testRuntimeRoot(scope.root),
      libraryRoot: scope.root,
      sourcePaths: [first.path, second.path],
      operation: "o_CANCELBATCHABCDE",
      transactionTokens: ["x_CANCELFIRSTABCDE", "x_CANCELSECONDABCD"],
      recoveryTransaction: "x_CANCELRECOVERYABC",
      timestamp: "2026-08-31T22:32:00.000Z",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event["phase"] === "fingerprint" && isJsonObject(event["bytes"])) {
          if (event["bytes"]["completed"] === event["bytes"]["total"]) controller.abort();
        }
      }
    });
    assert.equal(result.state, "cancelled");
    assert.deepEqual(result.items.map((entry) => entry.status), ["cancelled", "not_started"]);
    assert.deepEqual(await readdir(path.join(scope.root, "Conversations")), []);
    const inspection = await inspectLocalLibrary(scope.root);
    assert.equal(inspection.status, "valid");
    if (inspection.status === "valid") {
      assert.equal(inspection.pair.library["revision"], 1);
      assert.equal(inspection.pair.library["next_archive"], 1);
    }
    assert.equal(events.at(-1)?.["state"], "cancelled");
  } finally {
    await scope.cleanup();
  }
});
