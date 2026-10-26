import assert from "node:assert/strict";
import test from "node:test";
import { deepSeekLightAdapter } from "../../../src/adapters/parser/deepseek.mts";
import { deepSeekCodeProjector } from "../../../src/adapters/parser/deepseek-code.mts";
import { restoreCapturedProcess } from "../../../src/adapters/parser/inert-html.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import type { SourceMessageFacts } from "../../../src/app/parser/adapter.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const html = '<!doctype html>\n<html><title>Two waves</title><body><canvas></canvas><script src="https://cdn.example/library.js"></script></body></html>\n';
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="50" height="30"/></svg>\n';
function artifact(id: string, source: string, fragment_type = "RESPONSE", language = "html"): JsonObject {
  return { id, message_id: "reply", fragment_type, language, source, provenance: "message_code_fence", filename: `${id}.html`, preview_mode: "source" };
}
test("DeepSeek source-owned programs replace their exact fence in place, keeping newline and source dependencies", async () => {
  const facts: SourceMessageFacts[] = [];
  const draft = await deepSeekLightAdapter.parse({ source: { file: "example.html", bytes: 1, sha256: "a".repeat(64) },
    manifest: {}, payload: { items: [{ message_id: "reply", role: "assistant", main: [`Before\n\n\`\`\`html\n${html}\`\`\`\n\nAfter`],
      thoughts: [`Considering\n\n\`\`\`svg\n${svg}\`\`\`\nDone`], code_artifacts: [artifact("answer", html), artifact("thought", svg, "THINK", "svg")] }] },
    record: { message(i, f) { facts[i] = f; }, current() {}, block() {}, conversationModel() {} } });
  const record = assembleConversationRecord({ parsed: { draft, adapter: deepSeekLightAdapter.manifest, sourceFingerprint: { bytes: 1, sha256: "a".repeat(64) }, systemLogErrors: [] },
    facts: { messages: facts }, parserVersion: "1.1.39", timestamp: "2026-10-21T00:00:00.000Z" });
  assert.equal(record["schema"], "cloudig/conversation/1.0.2");
  const content = ((record["messages"] as JsonObject)["items"] as JsonObject[])[0]!["content"] as JsonObject[];
  assert.deepEqual(content.map(b => b["type"]), ["reasoning", "markdown", "window", "markdown"]);
  assert.equal(((content[0]!["content"] as JsonObject[])[1]!)["type"], "box");
  assert.equal(content[2]!["title"], "Two waves");
  const resources = record["resources"] as JsonObject[];
  const answer = resources.find(r => r["name"] === "answer.html")!;
  assert.equal(Buffer.from((answer["data_base64"] as string[]).join(""), "base64").toString(), html);
  assert.match(String(content[1]!["text"]), /Before/); assert.match(String(content[3]!["text"]), /After/);
  const restored = restoreCapturedProcess([content[0]!], '<details class="thinking"><summary>Thinking</summary>Flattened copy</details>', "thinking");
  assert.deepEqual(restored, [content[0]!]);
});
test("code examples without a display surface remain code; ownership is not inferred from matching strings", () => {
  const writes: string[] = [];
  const snippet = '<script src="example.js"></script>\n';
  const projector = deepSeekCodeProjector({ message_id: "reply", code_artifacts: [artifact("a", html), artifact("b", snippet)] }, (_, s) => { writes.push(s); return "r1"; });
  const input: JsonObject[] = [{ type: "markdown", text: `\`\`\`html\n${snippet}\`\`\`\n` }, { type: "reasoning", format: "markdown", text: `\`\`\`html\n${html}\`\`\`\n` }];
  assert.deepEqual(projector.project(input), input); assert.deepEqual(writes, []);
  assert.throws(() => deepSeekCodeProjector({ message_id: "another-message", code_artifacts: [artifact("a", html)] }, () => "r1"), /ownership/);
});
test("complete-looking fences with unfinished JavaScript stay original code, while JSX and valid spread syntax remain works", () => {
  const unfinished = '<html><body><script type="module">import * as THREE from "three";const scene = new THREE.Scene();\n...\n</script></body></html>\n';
  const valid = '<html><body><script>const list = [\n...\n[1,2]];</script><script type="application/json">{"key":"..."}</script><script type="text/babel">const node = <p>Example</p>;</script></body></html>\n';
  const writes: string[] = [], projector = deepSeekCodeProjector({ message_id: "reply", code_artifacts: [artifact("draft", unfinished), artifact("complete", valid)] }, (_, text) => { writes.push(text); return "r1"; });
  const result = projector.project([{ type: "markdown", text: `\`\`\`html\n${unfinished}\`\`\`\n\n\`\`\`html\n${valid}\`\`\`\n` }]);
  assert.equal(result[0]!["type"], "markdown"); assert.ok(String(result[0]!["text"]).includes(unfinished));
  assert.equal(result.at(-1)!["type"], "window"); assert.deepEqual(writes, [valid]);
});
test("repeated equal code remains two occurrences; nested fences do not create a false program", () => {
  const projector = deepSeekCodeProjector({ message_id: "reply", code_artifacts: [artifact("a", html), artifact("b", html)] }, () => "r1");
  const fence = `\`\`\`html\n${html}\`\`\`\n`;
  const output = projector.project([{ type: "markdown", text: fence + "Between\n\n" + fence }]);
  assert.deepEqual(output.map(b => b["type"]), ["window", "markdown", "window"]);
  const nested = deepSeekCodeProjector({ message_id: "reply", code_artifacts: [artifact("a", html)] }, () => "r1");
  assert.equal(nested.project([{ type: "markdown", text: "````markdown\n" + fence + "````\n" }])[0]!["type"], "markdown");
});
