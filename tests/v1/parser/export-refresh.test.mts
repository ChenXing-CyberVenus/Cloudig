import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { isJsonObject, type JsonObject, type JsonValue } from "../../../src/core/contracts/types.mts";
import { mistralLightAdapter, mistralFullAdapter, mistralTreeAdapter } from "../../../src/adapters/parser/mistral.mts";
import { readExporterEnvelope, probeExporterRoute } from "../../../src/adapters/parser/html-envelope.mts";
import { createOfflineContentRuntime } from "../../../src/ui/shared/conversation-renderer/content-runtime.mts";
import { inertHtmlFragment } from "../../../src/adapters/parser/inert-html.mts";

const rows = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter(isJsonObject) : [];
const object = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const text = (node: DefaultTreeAdapterTypes.Node): string => "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
const plain = (html: string): string => text(parseFragment(html)).replace(/\s+/gu, " ").trim();
const nodes = (node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Node[] => [node, ...("childNodes" in node ? node.childNodes.flatMap(nodes) : [])];
const texValues = (html: string): string[] => nodes(parseFragment(html)).flatMap(n => "tagName" in n && n.tagName === "annotation" && n.attrs.some(a => a.name === "encoding" && a.value === "application/x-tex") ? [text(n).replace(/\s+/gu, "")] : []);

for (const adapter of [mistralLightAdapter, mistralFullAdapter, mistralTreeAdapter]) {
  test(adapter.manifest.id + " keeps API-only post-tool reasoning in source order", async () => {
    const before = "Before the tool", after = "Complete post-tool result analysis";
    const message: JsonObject = { id: "m", version: 0, role: "assistant", public_thoughts: [{ body_text: before, label: "Thought", seconds: 8 }],
      reasoning_segments: [{ body_text: before, duration_ms: 2000 }, { body_text: after, duration_ms: 1250 }],
      tools: [{ name: "web_search", query: "query", after_reasoning_index: 1 }] };
    const draft = await adapter.parse({ manifest: {}, payload: { messages: [message], message_order: [{ id: "m", version: 0 }] },
      source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) },
      reading: { images: [], files: [], mermaid: [], fragments: [{ messageId: "m", messageVersion: "0",
        html: '<details class="osis-public-thinking"><summary>Thought</summary><p>Before the tool</p></details><div class="osis-rich"><p>Final answer</p></div>' }] } });
    const blocks = rows(rows(draft["messages"])[0]?.["content"]);
    assert.deepEqual(blocks.map(b => b["type"]), ["reasoning", "tool", "reasoning", "html"]);
    assert.equal(plain(String(blocks[0]!["text"])), before);
    assert.equal(blocks[0]!["format"], "html");
    assert.equal(blocks[2]!["text"], after);
    assert.equal(blocks[2]!["duration"], 1.25);
    assert.equal(plain(String(blocks[3]!["html"])), "Final answer");
  });
}

test("Mistral excludes outer exporter metadata without stripping authored time or model content", async () => {
  const timestamp = "2026-09-15T12:00:00Z";
  const draft = await mistralLightAdapter.parse({ manifest: {}, payload: {
    messages: [{ id: "m", version: 0, role: "assistant", model: "Model A", created_at: timestamp }],
    message_order: [{ id: "m", version: 0 }]
  }, source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) }, reading: { images: [], files: [], mermaid: [],
    fragments: [{ messageId: "m", html: '<div class="osis-message"><div class="assistant-model">Outer model</div><div class="osis-rich"><p>Answer</p><time>Authored date</time><span class="assistant-model">Authored model</span></div></div><div class="osis-turn-meta"><time>Outer timestamp</time></div>' }] } });
  const message = rows(draft["messages"])[0]!, body = rows(message["content"]).map(b => plain(String(b["html"] ?? ""))).join("");
  assert.doesNotMatch(body, /Outer model|Outer timestamp/u);
  assert.match(body, /AnswerAuthored dateAuthored model/u);
  assert.equal(message["model"], "Model A"); assert.equal(message["timestamp"], "2026-09-15T12:00:00.000Z");
});

test("Mistral keeps repeated occurrences, unmatched public panels and empty API-backed status", async () => {
  const message: JsonObject = { id: "m", version: 0, role: "assistant",
    public_thoughts: [{ body_text: "Same" }, { raw: "Thought", label: "Thought", body_text: "■\nThinking" }, { body_text: "Same" }, { body_text: "DOM-only panel" }],
    reasoning_segments: [{ body_text: "Same" }, { body_text: "" }, { body_text: "Same" }, { body_text: "Last API-only panel" }] };
  const draft = await mistralLightAdapter.parse({ manifest: {}, payload: { messages: [message], message_order: [{ id: "m", version: 0 }] }, source: { file: "fixture.html", bytes: 1, sha256: "0".repeat(64) } });
  const thoughts = rows(rows(draft["messages"])[0]?.["content"]).filter(b => b["type"] === "reasoning");
  assert.deepEqual(thoughts.map(b => b["text"]), ["Same", undefined, "Same", "Last API-only panel", "DOM-only panel"]);
  assert.equal(thoughts[1]!["title"], "Thought");
});

test("Reader math follows accepted dollar boundaries and inline-position display matrices", () => {
  const runtime = createOfflineContentRuntime();
  for (const source of ["Price $0.435/$0.87", "$x$2", "\\$price\\$", String.fromCharCode(96) + "$x$" + String.fromCharCode(96), "$ x$"]) {
    assert.doesNotMatch(runtime.renderMarkdown(source), /class="katex"/u, source);
  }
  for (const source of ["$1/2$", "$a|b$", "$符号的文字$", "\\(x\\)2"]) assert.match(runtime.renderMarkdown(source), /class="katex"/u, source);
  assert.match(runtime.renderMarkdown("圆括号：$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$"), /display="block"/u);
  runtime.dispose?.();
});

const sample = process.env["CLOUDIG_RECORD_SAMPLE"];
test("current source delta keeps Mistral segments, Claude memory tools, ChatGLM models and Z.ai matrices", { skip: !sample }, async () => {
  const waterline = JSON.parse(await readFile(new URL("../../../src/adapters/parser/contracts/sample-waterline.json", import.meta.url), "utf8"));
  const runtime = createOfflineContentRuntime();
  let files = 0, segments = 0, memories = 0, models = 0, matrices = 0;
  try {
    for (const file of (await readdir(sample!)).filter(f => f.endsWith(".html"))) {
      const filePath = path.join(sample!, file), platform = (await probeExporterRoute(filePath))?.["platform"];
      if (!["claude", "chatglm", "mistral", "zai"].includes(String(platform))) continue;
      const envelope = await readExporterEnvelope({ filePath });
      const { manifest, payload, reading, adapter } = envelope;
      const version = manifest["exporter_version"] ?? object(manifest["exporter"])["version"];
      const route = waterline.routes.find((r: { platform: string; profile: string }) => r.platform === platform && r.profile === adapter.manifest.routes[0]!.profile);
      assert.ok(route?.exporter_versions.includes(version));
      const witnesses: string[] = [];
      const draft = await adapter.parse({ manifest, payload, reading, source: { file, ...envelope.fingerprint }, record: {
        message(index, facts) { witnesses[index] = facts.id!; }, block() {}, current() {}, conversationModel() {}
      } });
      const parsed = new Map(rows(draft["messages"]).map((m, i) => [witnesses[i], m]));
      for (const raw of rows(payload["messages"])) {
        const id = platform === "mistral" ? String(raw["key"] ?? String(raw["id"]) + "::" + String(raw["version"] ?? "0")) : String(raw["id"]);
        const message = parsed.get(id); assert.ok(message, "source message remains addressable");
        const blocks = rows(message["content"]);
        if (platform === "mistral") {
          const thoughts = blocks.filter(b => b["type"] === "reasoning"), used = new Set<number>();
          const publicThoughts = rows(raw["public_thoughts"]);
          const captured = reading.fragments.filter(f => f.messageId === raw["id"] && (f.messageVersion ?? "0") === String(raw["version"] ?? "0"))
            .flatMap(f => nodes(parseFragment(f.html)).filter(n => "tagName" in n && n.attrs.some(a => a.name === "class" && a.value.split(/\s+/u).includes("osis-public-thinking"))))
            .map(n => inertHtmlFragment("childNodes" in n ? n.childNodes.filter(c => !("tagName" in c) || c.tagName !== "summary").map(c => serializeOuter(c)).join("") : ""));
          for (const segment of rows(raw["reasoning_segments"])) {
            const body = String(segment["body_text"] ?? "").trim(); if (!body) continue;
            const publicIndex = publicThoughts.findIndex(t => String(t["body_text"] ?? "").trim() === body);
            const saved = captured.length === publicThoughts.length && publicIndex >= 0 ? captured[publicIndex] : undefined;
            const at = thoughts.findIndex((b, index) => !used.has(index) && (String(b["text"] ?? "").trim() === body ||
              (saved && b["format"] === "html" && b["text"] === saved)));
            assert.ok(at >= 0, "every actual API reasoning occurrence survives, including post-tool text");
            used.add(at); segments++;
          }
        }
        if (platform === "claude") {
          const tools = [...rows(raw["blocks"]), ...rows(raw["cowork_page_tools"])], calls = new Set<string>();
          for (const tool of tools) if (tool["type"] === "tool_use" && /^(?:memory_|mcp__memory__)/u.test(String(tool["name"]))) {
            if (calls.has(String(tool["id"]))) continue; calls.add(String(tool["id"]));
            const call = blocks.find(b => b["type"] === "tool" && b["kind"] === "call" && b["name"] === tool["name"] && JSON.stringify(b["input"]) === JSON.stringify(tool["input"]));
            assert.ok(call, "memory arguments survive unchanged");
            const sourceResult = tools.find(t => t["type"] === "tool_result" && t["tool_use_id"] === tool["id"]);
            if (sourceResult) {
              const result = blocks.find(b => b["type"] === "tool" && b["kind"] === "result" && b["call"] === call["call"]);
              assert.ok(result, "memory result stays paired to its call");
              for (const item of rows(sourceResult["content"])) if (typeof item["text"] === "string") {
                assert.ok(JSON.stringify(result["output"]).includes(JSON.stringify(item["text"]).slice(1, -1)), "complete memory text survives");
              }
            }
            memories++;
          }
        }
        if (platform === "chatglm" && raw["model"]) { assert.equal(message["model"], raw["model"]); models++; }
        if (platform === "zai") for (const process of rows(raw["public_processes"])) {
          const body = String(process["content"] ?? "");
          if (!body.includes("\\begin{pmatrix}")) continue;
          const rendered = blocks.filter(b => b["type"] === "reasoning").map(b => b["format"] === "html" ? String(b["text"] ?? "") : runtime.renderMarkdown(String(b["text"] ?? ""))).join("");
          const expected = texValues(runtime.renderMarkdown(body)).filter(t => t.includes("\\begin{pmatrix}"));
          for (const matrix of expected) {
            assert.ok(texValues(rendered).some(t => t === matrix), "matrix outside code remains an actual formula");
            matrices++;
          }
          if (expected.length) assert.match(rendered, /display="block"/u);
        }
      }
      files++;
    }
    assert.equal(files, 16); assert.equal(segments, 79); assert.equal(memories, 16); assert.equal(models, 46); assert.ok(matrices >= 3);
    console.log(JSON.stringify({ export_refresh: { files, exact_reasoning_segments: segments, memory_calls: memories, model_labels: models, matrix_messages: matrices } }));
  } finally { runtime.dispose?.(); }
});
