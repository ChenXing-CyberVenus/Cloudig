import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";
import { prepareRecordConversationView, DEFAULT_READER_SESSION } from "../../../src/app/reader/view-model.mts";
import { buildRecordMarkdown } from "../../../src/app/export/markdown.mts";
import { createConversationRenderer, type RendererLabels } from "../../../src/ui/shared/conversation-renderer/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import type { RecordPresentation } from "../../../src/core/records/presentation.mts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=", bytes = Buffer.from(png, "base64");
const resolved: RecordPresentation = { conversationName: "Inline images", platform: "chatgpt", models: [], userName: "User", assistantName: "AI", userAvatar: "", assistantAvatar: "", contentTime: { state: "unavailable" }, effectiveEditedAt: "2026-09-21T00:00:00Z" };
const labels: RendererLabels = { reasoning: "Reasoning", toolCall: "Tool", toolResult: "Result", toolActivity: "Activity", references: "References", search: "Search", diagram: "Diagram", source: "Source", loadingResource: "Loading", unavailableResource: "Unavailable", failedResource: "Failed", openAttachment: "Open", externalResource: "External", systemParty: "System", toolParty: "Tool", otherParty: "Other" };
function fixture(): JsonObject {
  const record = JSON.parse(readFileSync(new URL("../records/fixtures/04-1.json", import.meta.url), "utf8"));
  record.resources = [{ id: "r1", kind: "image", availability: "embedded", mime: "image/png", name: "one.png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data_base64: [png] }, { id: "r2", kind: "image", availability: "metadata_only", name: "Only a description" }];
  record.messages.items[0].content = [{ type: "html", html: '<table><tr><td>Before<img data-cloudig-resource="r1" alt="A &amp; B" title="Caption" width="24">After</td></tr></table><p>&lt;img data-cloudig-resource="not-a-reference"&gt;</p>' }];
  record.messages.items[1].content = [{ type: "reasoning", title: "Outer activity", content: [{ type: "reasoning", format: "html", text: '<ul><li>Nested thought<img data-cloudig-resource="r1" alt="Nested"></li></ul>' }, { type: "html", html: '<p>End<img data-cloudig-resource="r2" alt="Only a description"></p>' }] }];
  return record;
}
const request = { page: { offset: 0, limit: 10 }, navigationPage: { offset: 0, limit: 10 }, branchPage: { offset: 0, limit: 10 }, session: { ...DEFAULT_READER_SESSION, expanded: { reasoning: true, tools: true, references: true } } };

for (const theme of ["dawn", "star-night"] as const) test(`inline images keep table/list placement and use metadata-only page resources in ${theme}`, async () => {
  const record = fixture(), page = prepareRecordConversationView({ conversation: record, resolved }).page(request);
  assert(!JSON.stringify(page).includes(png), "A view must not duplicate embedded bytes");
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const requested: string[] = []; let released = 0;
  const renderer = createConversationRenderer({ root, theme, labels, resolveResource: async resource => { requested.push(String(resource["id"])); return { url: `data:image/png;base64,${png}`, release: () => { released++; } }; } });
  try {
    renderer.render(page); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelector("td")!.textContent, "BeforeAfter");
    const image = root.querySelector<HTMLImageElement>("td img")!; assert.equal(image.alt, "A & B"); assert.equal(image.title, "Caption"); assert.equal(image.width, 24);
    assert(root.querySelector("li img")); assert(root.textContent!.includes("Nested thought"));
    assert(root.textContent!.includes("Only a description")); assert(!root.textContent!.includes("Unavailable"));
    assert.deepEqual(requested, ["r1", "r1"]); assert.equal(root.querySelector("img[data-cloudig-resource]"), null);
  } finally { renderer.destroy(); dom.window.close(); }
  assert.equal(released, 2);
});

test("Markdown streams inline bytes in place and retains nested process content without private references", () => {
  const record = fixture(), original = JSON.stringify(record), plan = buildRecordMarkdown({ conversation: record, resolved, locale: "en" });
  const resource = new Map((record["resources"] as JsonObject[]).map(r => [r["id"], r]));
  const output = plan.parts.map(part => typeof part === "string" ? part : part.prefix + (resource.get(part.resource)!["data_base64"] as string[]).join("") + part.suffix).join("");
  const dom = new JSDOM(output);
  assert.equal(dom.window.document.querySelector("td")!.textContent, "BeforeAfter");
  assert.equal(dom.window.document.querySelector<HTMLImageElement>("td img")!.src, `data:image/png;base64,${png}`);
  assert.equal(dom.window.document.querySelector("td img")!.getAttribute("width"), "24");
  assert(dom.window.document.querySelector("details li img")); assert(output.includes("Nested thought")); assert(output.includes("Only a description"));
  assert.equal(dom.window.document.querySelector("img[data-cloudig-resource]"), null);
  assert.equal(plan.parts.filter(part => typeof part !== "string").length, 2);
  assert.equal(output.split("Outer activity").length - 1, 1, "An outer title must not be repeated as its own body");
  assert.equal(JSON.stringify(record), original); dom.window.close();
});

test("late inline image resolution cannot reattach a closed conversation and releases its resource", async () => {
  const page = prepareRecordConversationView({ conversation: fixture(), resolved }).page(request);
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const pending: (() => void)[] = []; let released = 0;
  const renderer = createConversationRenderer({ root, theme: "dawn", labels, resolveResource: () => new Promise(resolve => {
    pending.push(() => resolve({ url: "blob:retired-image", release: () => { released++; } }));
  }) });
  renderer.render(page); assert.equal(pending.length, 2); renderer.destroy();
  pending.forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector("img"), null); assert.equal(released, 2); dom.window.close();
});
