import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildConversationPage, conversationMessagePath, DEFAULT_READER_SESSION } from "../../../src/app/reader/index.mts";
import { buildConversationPageCore } from "../../../src/app/reader/view-model-core.mts";
import { projectRecordForReading } from "../../../src/core/records/presentation.mts";
import { finalizeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import type { ResolvedArchiveView } from "../../../src/core/library/overlay.mts";

const oneByte = Buffer.from([0]);

test("disconnected Claude fragments remain readable and real sibling choices stay local", () => {
  const value: JsonObject = { messages: [
    { id: "m1", content: [] }, { id: "m2", parent: "m1", content: [] },
    { id: "m3", parent: "m1", content: [] }, { id: "m4", parent: "m3", content: [] },
    { id: "m5", content: [] }, { id: "m6", parent: "m5", content: [] },
    { id: "m7", parent: "m5", content: [] }, { id: "m8", content: [] }
  ] };
  assert.deepEqual(conversationMessagePath(value).path, [0, 2, 3, 4, 6, 7]);
  const selected = conversationMessagePath(value, undefined, { m1: "m2", m5: "m6" });
  assert.deepEqual(selected.path, [0, 1, 4, 5, 7]);
  assert.deepEqual(selected.controls.get(1), { parent: "m1", selected: "m2", index: 0, total: 2, next: "m3" });
  assert.equal(selected.controls.has(7), false, "an orphan root is not a sibling branch");
  assert.deepEqual(conversationMessagePath(value, undefined, { m1: "m8" }).path, [0, 2, 3, 4, 6, 7]);
  assert.equal(value["current_message"], undefined, "view choices do not invent source facts");
});

function conversation(): JsonObject {
  return finalizeConversation({
    schema: "cloudig/conversation/1.0.0",
    archive: "a1",
    generation: 1,
    content_sha256: "0".repeat(64),
    parser: { version: "1.0.0", adapter: { id: "fixture-tree", version: "1.0.0" } },
    lifecycle: {
      first_parsed_at: { basis: "parser", value: "2026-08-31T20:00:00.000Z" },
      last_parsed_at: "2026-08-31T20:00:00.000Z",
      cloudig_edited_at: "2026-08-31T20:00:00.000Z"
    },
    source: {
      file: "fixture.html",
      sha256: "1".repeat(64),
      bytes: 10,
      format: "exporter-html",
      profile: "tree",
      captured_at: { basis: "manifest", value: "2026-08-31T18:59:00.000Z", field: "captured_at" },
      exporter: { id: "fixture-bookmarklet", version: "1.0.0-tree" }
    },
    content_time: {
      basis: "message_start",
      range: { start: { kind: "calendar", era: "AD", year: 2026, month: 8, day: 31, hour: 19, minute: 0, second: 0, offset: "Z" } }
    },
    provider: "fixture",
    platform: "chatgpt",
    title: "Source title",
    models: ["model-a"],
    message_time: { start: "2026-08-31T19:00:00.000Z", end: "2026-08-31T19:03:00.000Z" },
    current_message: "m4",
    messages: [
      {
        id: "m1",
        role: "user",
        timestamp: "2026-08-31T19:00:00.000Z",
        content: [{ type: "markdown", text: "**Question** from the user" }]
      },
      {
        id: "m2",
        parent: "m1",
        role: "assistant",
        model: "model-a",
        timestamp: "2026-08-31T19:01:00.000Z",
        content: [
          { type: "reasoning_summary", text: "Visible thought", format: "text", duration: 2 },
          { type: "tool", kind: "call", call: "x1", name: "search", input: { query: "Cloudig" } },
          { type: "tool", kind: "result", call: "x1", name: "search", success: true, output: "done" },
          { type: "markdown", text: "Final answer" },
          { type: "citations", sources: ["s1"] },
          { type: "image", resource: "r1", alt: "One pixel" }
        ]
      },
      {
        id: "m3",
        parent: "m1",
        role: "assistant",
        timestamp: "2026-08-31T19:02:00.000Z",
        content: [{ type: "markdown", text: "Alternate answer" }]
      },
      {
        id: "m4",
        parent: "m2",
        role: "other",
        name: "scheduler",
        timestamp: "2026-08-31T19:03:00.000Z",
        content: []
      }
    ],
    resources: [{
      id: "r1",
      kind: "image",
      availability: "embedded",
      name: "pixel.png",
      mime: "image/png",
      bytes: 1,
      sha256: createHash("sha256").update(oneByte).digest("hex"),
      data_base64: [oneByte.toString("base64")]
    }],
    sources: [{ id: "s1", kind: "web", title: "Source", url: "https://example.com/source" }]
  });
}

const resolved: ResolvedArchiveView = {
  archive: "a1",
  platform: "chatgpt",
  archiveLayer: "library",
  conversationName: "Edited title",
  models: ["edited-model"],
  userName: "晨星",
  assistantName: "奥思",
  userAvatar: "Data/Assets/User/user.png",
  assistantAvatar: "Assets/Platforms/chatgpt.svg",
  contentTime: {
    state: "set",
    range: { start: { kind: "calendar", era: "AD", year: 2026, month: 8, day: 31 } }
  },
  effectiveEditedAt: "2026-08-31T20:00:00.000Z"
};

test("Conversation name overrides do not rename external Agent instances or system messages", () => {
  const source: JsonObject = {
    conversation_id: "00000000-0000-7000-8000-000000000001",
    platform: "codex",
    title: { filename: "清辞载云" },
    identity: [
      { schema: "cloudig/identity/1.0.0", source_id: "assistant:gpt-5.5", names: [{ name: "GPT-5.5", claimers: [] }], display_name: 1, kind: { world: "terran", subject: "ai" }, role: "assistant" },
      { schema: "cloudig/identity/1.0.0", source_id: "agent-thread:other", names: [], kind: { world: "terran", subject: "ai" }, role: "assistant" },
      { schema: "cloudig/identity/1.0.0", source_id: "system:context", names: [{ name: "系统", claimers: [] }], display_name: 1, kind: { world: "terran", subject: "program" }, role: "system" }
    ],
    messages: {
      items: [
        { id: "a", speaker: "assistant:gpt-5.5", role: "assistant", content: [{ type: "text", text: "主助手" }] },
        { id: "b", speaker: "agent-thread:other", role: "assistant", content: [{ type: "text", text: "其他实例" }] },
        { id: "c", speaker: "system:context", role: "system", content: [{ type: "text", text: "系统" }] }
      ]
    }
  };
  const projected = projectRecordForReading(source, {
    conversationName: resolved.conversationName ?? "",
    platform: resolved.platform,
    models: resolved.models,
    userName: resolved.userName,
    assistantName: resolved.assistantName,
    userAvatar: resolved.userAvatar,
    assistantAvatar: resolved.assistantAvatar,
    contentTime: resolved.contentTime.state === "set" ? { state: "set", ...(resolved.contentTime.range === undefined ? {} : { range: resolved.contentTime.range }) } : { state: "unavailable" },
    effectiveEditedAt: resolved.effectiveEditedAt ?? ""
  }, { names: { assistant: "本篇助手" } });
  const parties = (projected["messages"] as JsonObject[]).map(message => message["party"] as JsonObject);
  assert.equal(parties[0]?.["name"], "本篇助手");
  assert.equal(parties[1]?.["name"], "其他 Agent 实例");
  assert.equal(parties[1]?.["avatar"], "Assets/Platforms/agent-instance.svg");
  assert.equal(parties[1]?.["avatar_variant"], "agent-instance");
  assert.equal(parties[2]?.["name"], "系统");
  const capabilityView = projectRecordForReading(source, {
    conversationName: resolved.conversationName ?? "",
    platform: resolved.platform,
    models: resolved.models,
    userName: resolved.userName,
    assistantName: resolved.assistantName,
    userAvatar: resolved.userAvatar,
    assistantAvatar: resolved.assistantAvatar,
    contentTime: resolved.contentTime.state === "set" ? { state: "set", ...(resolved.contentTime.range === undefined ? {} : { range: resolved.contentTime.range }) } : { state: "unavailable" },
    effectiveEditedAt: resolved.effectiveEditedAt ?? ""
  }, { names: { assistant: "本篇助手" } }, { resolveAgentAvatar: () => "i_agent_instance" });
  assert.equal(((capabilityView["messages"] as JsonObject[])[1]?.["party"] as JsonObject | undefined)?.["avatar"], "i_agent_instance");
});

const auxiliaryPages = {
  navigationPage: { offset: 0, limit: 20 },
  branchPage: { offset: 0, limit: 20 }
} as const;

test('summary runs use source identity and direct edges, survive paging, and never cross body, tools, branches or empty notices', () => {
  const m = (id: string, parent: string | undefined, content: JsonObject[] = [{ type: 'reasoning_summary', text: id }], speaker = 'ai'): JsonObject => ({ id, ...(parent ? { parent } : {}), role: 'assistant', speaker, content });
  const messages = [m('a', undefined), m('b', 'a'), m('c', 'b'), m('body', 'c', [{ type: 'text', text: 'Answer' }]), m('d', 'body'), m('e', 'd', undefined, 'other-ai'), m('f', 'e', undefined, 'other-ai'), m('tool', 'f', [{ type: 'tool', kind: 'call', input: 'x' }]), m('g', 'tool'), m('h', 'g'), m('alternate', 'g'), m('empty', 'h', [{ type: 'reasoning_summary', title: 'Thought for 2s', duration: 2 }]), m('i', 'empty')];
  const source = { ...conversation(), messages, current_message: 'i' }, before = JSON.stringify(source);
  const page = (offset = 0, limit = 20) => buildConversationPageCore({ conversation: source, resolved, page: { offset, limit }, ...auxiliaryPages }, source)['messages'] as JsonObject[];
  const rows = page();
  assert.deepEqual(rows.slice(0, 3).map(m => m['summary_sequence']), ['message-1', 'message-1', 'message-1']);
  assert.equal(page(2, 1)[0]!['summary_sequence'], 'message-1');
  assert.equal(rows.find(m => m['id'] === 'd')!['summary_sequence'], undefined);
  assert.equal(rows.find(m => m['id'] === 'e')!['summary_sequence'], rows.find(m => m['id'] === 'f')!['summary_sequence']);
  for (const id of ['body', 'tool', 'g', 'h', 'empty', 'i']) assert.equal(rows.find(m => m['id'] === id)!['summary_sequence'], undefined, id);
  assert.equal(JSON.stringify(source), before);
});

test('split assistant reasoning, status and answer use one portrait without merging messages or actors', () => {
  const m = (id: string, parent: string | undefined, type: string, speaker = 'ai', role = 'assistant'): JsonObject => ({ id, ...(parent ? { parent } : {}), role, speaker, content: [{ type, ...(type === 'status' ? { title: 'Thought for 2s' } : { text: id }) }] });
  const messages = [m('thought', undefined, 'reasoning_summary'), m('elapsed', 'thought', 'status', 'platform'), m('answer', 'elapsed', 'text'),
    m('new-answer', 'answer', 'text'), m('next-thought', 'new-answer', 'reasoning'), m('other-actor', 'next-thought', 'text', 'other'),
    m('human', 'other-actor', 'text', 'user', 'user'), m('later', 'human', 'text')];
  const source = { ...conversation(), messages, current_message: 'later' }, before = JSON.stringify(source);
  const page = (offset = 0, limit = 20) => buildConversationPageCore({ conversation: source, resolved, page: { offset, limit }, ...auxiliaryPages }, source)['messages'] as JsonObject[];
  assert.deepEqual(page().filter(m => m['assistant_continuation']).map(m => m['id']), ['elapsed', 'answer']);
  assert.equal(page(2, 1)[0]!['assistant_continuation'], true);
  assert.equal(page().length, messages.length); assert.equal(JSON.stringify(source), before);
});

test("Reader defaults are transient, folded, and select the source current branch", () => {
  const view = buildConversationPage({ conversation: conversation(), resolved, page: { offset: 0, limit: 20 }, ...auxiliaryPages });
  assert.equal(view["schema"], "cloudig/conversation-view/1.0.0");
  assert.equal((view["header"] as JsonObject)["title"], "Edited title");
  assert.deepEqual((view["header"] as JsonObject)["models"], ["edited-model"]);
  assert.deepEqual((view["header"] as JsonObject)["captured_at"], {
    basis: "manifest",
    value: "2026-08-31T18:59:00.000Z",
    field: "captured_at"
  });
  assert.deepEqual(view["branch"], {
    tree: true,
    selected: "m4",
    current: "m4",
    path_length: 3,
    leaves: {
      offset: 0,
      limit: 20,
      returned: 2,
      total: 2,
      has_previous: false,
      has_next: false,
      items: [
        { id: "m3", source_index: 2, text: "Alternate answer" },
        { id: "m4", source_index: 3 }
      ]
    }
  });
  const messages = view["messages"] as JsonObject[];
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => (message["party"] as JsonObject)["name"]), ["晨星", "奥思"]);
  const assistantBlocks = messages[1]!["blocks"] as JsonObject[];
  assert.equal(assistantBlocks[0]!["category"], "reasoning");
  assert.equal(assistantBlocks[0]!["collapsed"], true);
  assert.equal(assistantBlocks[0]!["anchor"], "message-2-process-1");
  assert.equal(assistantBlocks[1]!["category"], "tool");
  assert.equal(assistantBlocks[1]!["collapsed"], true);
  const references = assistantBlocks.find((block) => block["category"] === "references")!;
  assert.deepEqual(references["sources"], [{ id: "s1", kind: "web", title: "Source", url: "https://example.com/source" }]);
  const image = assistantBlocks.at(-1)!;
  const resource = (image["resources"] as JsonObject[])[0]!;
  assert.equal(resource["id"], "r1");
  assert.equal(resource["data_base64"], undefined);
  assert.deepEqual(((view["navigation"] as JsonObject)["items"] as JsonObject[]).map((entry) => entry["kind"]), ["user", "assistant"]);
  assert.equal((view["pagination"] as JsonObject)["total_canonical"], 4);
  assert.equal((view["pagination"] as JsonObject)["total_visible"], 2);
  assert.deepEqual(DEFAULT_READER_SESSION.navigation, { user: true, assistant: true, process: false });
});

test("HTML navigation reads visible text rather than SVG CSS, comments or encoded entities", () => {
  const input = conversation();
  const items = input["messages"] as JsonObject[];
  items[0]!["content"] = [{ type: "text", text: "literal <Front> & 2 > 1" }];
  const html = '<svg><style>div:not(:has(.mt-2)){color:red}</style><text>图示</text></svg><!-- hidden comment --><script>hiddenScript()</script><template>hidden template</template><p>正<strong>文</strong> &amp; &lt;Front&gt;</p><p>下一段</p>';
  items[1]!["content"] = [{ type: "html", html: "<style>.hidden{color:red}</style>" }, { type: "html", html }];
  items[2]!["content"] = [{ type: "html", html }];
  const view = buildConversationPage({ conversation: finalizeConversation(input), resolved, page: { offset: 0, limit: 20 }, ...auxiliaryPages });
  const navigation = (view["navigation"] as JsonObject)["items"] as JsonObject[];
  assert.equal(navigation[1]!["text"], "图示 正文 & <Front> 下一段");
  assert.equal(navigation[0]!["text"], "literal <Front> & 2 > 1");
  const leaves = ((view["branch"] as JsonObject)["leaves"] as JsonObject)["items"] as JsonObject[];
  assert.equal(leaves[0]!["text"], "图示 正文 & <Front> 下一段");
  const displayedBlock = ((view["messages"] as JsonObject[])[1]!["blocks"] as JsonObject[])[1]!["value"] as JsonObject;
  assert.equal(displayedBlock["html"], html, "summary extraction does not rewrite the captured body");
});

test("body hiding and navigation selection are independent session state", () => {
  const view = buildConversationPage({
    conversation: conversation(),
    resolved,
    session: {
      expanded: { reasoning: true, tools: true, references: true },
      hidden: { reasoning: true, tools: true },
      navigation: { user: false, assistant: true, process: true }
    },
    page: { offset: 0, limit: 20 },
    ...auxiliaryPages
  });
  const messages = view["messages"] as JsonObject[];
  const assistantTypes = (messages[1]!["blocks"] as JsonObject[]).map((block) => (block["value"] as JsonObject)["type"]);
  assert.deepEqual(assistantTypes, ["markdown", "citations", "image"]);
  const navigation = (view["navigation"] as JsonObject)["items"] as JsonObject[];
  assert.ok(navigation.every((entry) => entry["kind"] !== "user"));
  assert.ok(navigation.some((entry) => entry["kind"] === "assistant"));
  assert.equal(navigation.filter((entry) => entry["kind"] === "process").length, 3);
});

test("a session branch choice replaces only the displayed path", () => {
  const view = buildConversationPage({
    conversation: conversation(),
    resolved,
    session: {
      selectedLeaf: "m3",
      expanded: { reasoning: false, tools: false, references: false },
      hidden: { reasoning: false, tools: false },
      navigation: { user: true, assistant: true, process: false }
    },
    page: { offset: 0, limit: 20 },
    ...auxiliaryPages
  });
  assert.equal((view["branch"] as JsonObject)["path_length"], 2);
  assert.equal((view["branch"] as JsonObject)["selected"], "m3");
  assert.deepEqual((view["messages"] as JsonObject[]).map((message) => message["source_index"]), [0, 2]);
  assert.equal((view["pagination"] as JsonObject)["total_visible"], 2);
});

test("message paging never changes navigation or canonical counts", () => {
  const view = buildConversationPage({ conversation: conversation(), resolved, page: { offset: 1, limit: 1 }, ...auxiliaryPages });
  assert.equal((view["messages"] as JsonObject[]).length, 1);
  assert.equal((view["messages"] as JsonObject[])[0]!["source_index"], 1);
  assert.deepEqual(view["pagination"], {
    offset: 1,
    limit: 1,
    returned: 1,
    total_visible: 2,
    total_canonical: 4,
    total_contentful: 3,
    empty_messages: 0,
    has_previous: true,
    has_next: false
  });
  assert.equal(((view["navigation"] as JsonObject)["items"] as JsonObject[]).length, 2);
});

test("navigation and branch leaves have independent bounded pages", () => {
  const view = buildConversationPage({
    conversation: conversation(),
    resolved,
    page: { offset: 0, limit: 20 },
    navigationPage: { offset: 0, limit: 1 },
    branchPage: { offset: 1, limit: 1 }
  });
  assert.deepEqual(view["navigation"], {
    offset: 0,
    limit: 1,
    returned: 1,
    total: 2,
    has_previous: false,
    has_next: true,
    items: [{ anchor: "message-1", kind: "user", source_index: 0, message_offset: 0, text: "Question from the user" }]
  });
  assert.deepEqual((view["branch"] as JsonObject)["leaves"], {
    offset: 1,
    limit: 1,
    returned: 1,
    total: 2,
    has_previous: true,
    has_next: false,
    items: [{ id: "m4", source_index: 3 }]
  });
});

test("invalid page requests are rejected before rendering", () => {
  assert.throws(() => buildConversationPage({ conversation: conversation(), resolved, page: { offset: -1, limit: 1 }, ...auxiliaryPages }), RangeError);
  assert.throws(() => buildConversationPage({ conversation: conversation(), resolved, page: { offset: 0, limit: 0 }, ...auxiliaryPages }), RangeError);
  assert.throws(() => buildConversationPage({ conversation: conversation(), resolved, page: { offset: 0, limit: 201 }, ...auxiliaryPages }), /configured bound/iu);
});
