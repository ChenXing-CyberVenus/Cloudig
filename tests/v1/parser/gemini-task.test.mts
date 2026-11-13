import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { geminiLightAdapter, geminiFullAdapter } from "../../../src/adapters/parser/gemini.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import type { SourceMessageFacts } from "../../../src/app/parser/adapter.mts";
import { validateRecord } from "../../../src/core/records/index.mts";
import type { JsonObject, JsonValue } from "../../../src/core/contracts/types.mts";
import { hydrateDocumentCitations } from "../../../src/ui/shared/conversation-renderer/document-citations.mts";
import { inertHtmlFragment } from "../../../src/adapters/parser/inert-html.mts";
import { renderTaskList } from "../../../src/ui/shared/conversation-renderer/task-card.mts";
import { htmlResourceImages } from "../../../src/core/records/html-resources.mts";

async function convert(messages: JsonObject[], rich: JsonObject = {}, full = false, images: JsonObject[] = []) {
  const facts: SourceMessageFacts[] = [], speakers = new Map<JsonObject, SourceMessageFacts>();
  const adapter = full ? geminiFullAdapter : geminiLightAdapter;
  const draft = await adapter.parse({ source: { file: "sample.html", bytes: 1, sha256: "1".repeat(64) }, manifest: {},
    payload: { messages, images, files: [], sources: [] }, extensions: { geminiRichContent: { artifacts: [], resources: [], media: [], ...rich } },
    record: { message(i, f) { facts[i] = f; }, block(b, f) { speakers.set(b, f); }, current() {}, conversationModel() {} } });
  const record = assembleConversationRecord({ parsed: { draft, adapter: adapter.manifest, sourceFingerprint: { bytes: 1, sha256: "1".repeat(64) }, systemLogErrors: [] },
    facts: { messages: facts, blockSpeakers: speakers }, parserVersion: "1.1.54", timestamp: "2026-11-12T00:00:00Z" });
  const valid = validateRecord("conversation", record); assert.equal(valid.ok, true, valid.ok ? "" : JSON.stringify(valid)); return record;
}
const items = (r: JsonObject) => (r["messages"] as JsonObject)["items"] as JsonObject[];
const walk = (blocks: JsonObject[]): JsonObject[] => blocks.flatMap(b => [b, ...walk((b["content"] ?? []) as JsonObject[])]);
const message = (id: string, html: string, extra: JsonObject = {}): JsonObject => ({ source_id: id, role: "assistant", html, thoughts: [], attachments: [], ...extra });
const event = (narrative: string, calls: JsonValue[] = [], children: JsonValue[] = []): JsonValue[] => {
  const state: JsonValue[] = Array(13).fill(null); state[0] = calls; state[3] = narrative; state[10] = children;
  const result: JsonValue[] = Array(13).fill(null); result[12] = state; return result;
};
const turn = (id: string, events: JsonValue[] = [], answer = "Answer"): JsonValue[] => [["conversation", id], null, null, [[[null, [answer]]], null, null, null, events], [1794441600, 0]];

test("Gemini image keys retain exact paragraph/table order and repeated occurrences without moving pictures to the tail", async () => {
  const image = (key: string, color: string) => ({ key, alt: key, data_url: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="${color}"/></svg>`).toString('base64')}` });
  for (const full of [false, true]) {
    const record = await convert([message("first", '<p>BEFORE<osis-image data-key="red"></osis-image>BETWEEN</p><table><tr><td><osis-image data-key="blue"></osis-image>AFTER</td></tr></table><p>AGAIN<osis-image data-key="red"></osis-image>END</p>')], {}, full, [image('red','red'),image('blue','blue')]);
    const blocks=items(record)[0]!["content"] as JsonObject[];assert.equal(blocks.length,1);assert.equal(blocks[0]!["type"],'html');
    const html=String(blocks[0]!["html"]),refs=htmlResourceImages(html);assert.equal(refs.length,3);assert.equal(refs[0]!.id,refs[2]!.id);assert.notEqual(refs[0]!.id,refs[1]!.id);
    const dom=new JSDOM(html);assert(dom.window.document.querySelector('td > img'));assert.equal(dom.window.document.body.textContent,'BEFOREBETWEENAFTERAGAINEND');assert.equal((record['resources'] as JsonObject[]).length,2);dom.window.close();
  }
});

test("Gemini uses existing message timestamps, retains missing times and keeps unknown source scope out of Schema", async () => {
  for (const full of [false, true]) {
    const r = await convert([message("u", "<p>User</p>", { role: "user", timestamp: "2026-11-12T00:01:02Z", timestamp_scope: "turn" }), message("a", "<p>Answer</p>", { timestamp: "2026-11-12T00:01:02Z" }), message("b", "<p>No time</p>")], {}, full);
    assert.deepEqual(items(r).map(m => m["timestamp"]), ["2026-11-12T00:01:02.000Z", "2026-11-12T00:01:02.000Z", undefined]);
    assert(!JSON.stringify(r).includes("timestamp_scope"));
  }
});

test("document citations retain paragraph continuation, every member and source ownership across malformed outer spans", async () => {
  const citation = (path: string) => `<span class="gemini-document-citation" data-citation-path="${path}"><button>Old label</button><span class="gemini-document-sources" hidden><span>Old members</span></span>`;
  for (const full of [false, true]) {
    const r = await convert([message("a", `<p>Before ${citation("0")} between ${citation("1")} AFTER</p><p>LAST</p>`)], { document_citations: [
      { message_id: "a", path: "0,1", complete: true, sources: [{ title: "Same.tex", filename: "Same.tex", mime: "application/x-latex" }, { title: "Other.tex" }] },
      { message_id: "a", path: "1,0", complete: true, sources: [{ title: "Same.tex" }] },
      { message_id: "elsewhere", path: "0,1", complete: true, sources: [{ title: "DO NOT LEAK" }] }
    ] }, full);
    const html = (items(r)[0]!["content"] as JsonObject[]).map(b => b["html"] ?? "").join("");
    const dom = new JSDOM(`<main>${inertHtmlFragment(html)}</main>`), root = dom.window.document.querySelector<HTMLElement>("main")!;
    assert(root.textContent!.includes("between")); assert(root.textContent!.includes("AFTER")); assert(root.textContent!.includes("LAST")); assert(!root.textContent!.includes("DO NOT LEAK"));
    assert.equal((r["references"] as JsonObject[]).length, 3);
    const broken = structuredClone(r); broken["references"] = [];
    assert.equal(validateRecord("conversation", broken).ok, false, "Inline references must resolve in this Conversation");
    const controller = new dom.window.AbortController(); hydrateDocumentCitations(root, controller.signal as unknown as AbortSignal);
    const buttons = root.querySelectorAll<HTMLButtonElement>(".cloudig-document-citation-toggle"); assert.equal(buttons.length, 2);
    assert.equal(buttons[0]!.textContent, "Same.tex + 1");
    buttons[0]!.click(); assert.equal(buttons[0]!.getAttribute("aria-expanded"), "true");
    assert.equal(root.querySelectorAll(".cloudig-document-sources:not([hidden])").length, 1);
    buttons[0]!.click(); assert.equal(root.querySelectorAll(".cloudig-document-sources:not([hidden])").length, 0);
    controller.abort(); dom.window.close();
  }
});

test("task IDs preserve updates, separate same-name children and keep child identity stable across renamed snapshots", async () => {
  const row: JsonValue[] = ["Tool title", "", "", 1, "Search", "", null, null, "run", "call1"];
  const event1 = event("Repeated thought", [row], [["Same title", "child1", []], ["Same title", "child2", []]]);
  const event2 = event("Repeated thought", [row]); (event2[12] as JsonValue[])[6] = [row];
  const event3 = event("Later thought", [], [["Renamed snapshot", "child1", []]]);
  const rich: JsonObject = { native_turns: [turn("a", [event1, event2]), turn("b", [event3])], task_turns: [{ message_id: "a", automatic: false }, { message_id: "b", automatic: true }], task_children: [
    { conversation_id: "child1", complete: true, native_turns: [turn("ca", [], "First child answer")] },
    { conversation_id: "child2", complete: false, native_turns: [turn("cb", [], "Second child answer")] }
  ] };
  const oldThought = '<details class="thinking gemini-task-process"><summary>Summary</summary><div class="thinking-body"><p>Rendered mirror</p></div></details>';
  const r = await convert([message("a", oldThought + "<p>BODY A</p>", { thoughts: [{ label: "Summary", html: oldThought }] }), message("b", "<p>BODY B</p>")], rich);
  assert.equal(items(r).length, 2); const blocks = walk(items(r).flatMap(m => m["content"] as JsonObject[]));
  assert.equal(blocks.filter(b => b["type"] === "tool" && b["call"] === "call1").length, 1);
  assert.equal(((blocks.find(b => b["call"] === "call1")!["input"]) as JsonObject[]).length, 2);
  const children = (r["identity"] as JsonObject[]).filter(f => String(f["source_id"]).startsWith("agent-thread:"));
  assert.equal(children.length, 2); assert.notEqual(children[0]!["source_id"], children[1]!["source_id"]);
  assert.equal(blocks.filter(b => b["type"] === "html" && String(b["html"]).includes("Rendered mirror")).length, 0);
  assert.equal(blocks.filter(b => b["title"] === "Gemini task source").length, 2);
  assert.deepEqual(JSON.parse(String(blocks.find(b => b["title"] === "Gemini task source")!["text"])).events, [event1, event2]);
});

test("saved cloud files bind only to their declared messages and reuse bytes; schedules reuse the themed read-only card", async () => {
  const raw: JsonObject = { id: "task", message_id: "a", title: "Monitor", enabled: false, timezone: "Europe/Paris", trigger: ["When the source changes"], instructions: "Read the saved source", captured_at: "2026-11-12T00:00:00Z" };
  const r = await convert([message("a", '<section class="gemini-rich-artifact"><a data-gemini-resource="doc">Saved file</a></section><details class="gemini-task-schedule"><summary>Old schedule</summary></details>'), message("b", "<p>Next</p>")], {
    resources: [{ key: "doc", name: "saved.txt", mime: "text/plain", text: "Exact file bytes" }],
    cloud_documents: [{ id: "d", resource: "doc", message_ids: ["a", "b"], version_scope: "current_at_export" }], task_schedules: [raw]
  });
  const attachments = items(r).flatMap(m => (m["content"] as JsonObject[]).filter(b => b["type"] === "attachment"));
  assert.equal(attachments.length, 2); assert.equal(attachments[0]!["resource"], attachments[1]!["resource"]);
  assert.equal((r["resources"] as JsonObject[]).length, 1);
  const card = (items(r)[0]!["content"] as JsonObject[]).find(b => b["source"] === "gemini.google.com_scheduled_task")!;
  assert(card); assert.deepEqual((card["data"] as JsonObject)["source_task"], raw);
  for (const language of ["zh", "en"] as const) {
    const dom = new JSDOM("<main></main>"), host = dom.window.document.querySelector<HTMLElement>("main")!;
    assert(renderTaskList(host, card["data"] as JsonObject, { language, richText: text => { const p = dom.window.document.createElement("p"); p.textContent = text; return p; }, defer: (_f, build) => build() }));
    assert(host.textContent!.includes(language === "en" ? "Paused" : "已暂停")); assert(host.textContent!.includes("Europe/Paris")); assert(host.textContent!.includes("When the source changes")); assert(!host.textContent!.includes("ChatGPT")); dom.window.close();
  }
});
