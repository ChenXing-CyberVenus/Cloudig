import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";

import type { JsonObject } from "../../../src/core/contracts/types.mts";
import {
  createConversationRenderer,
  createOfflineContentRuntime,
  type OfflineContentRuntime,
  type RendererLabels,
  type RendererTheme
} from "../../../src/ui/shared/conversation-renderer/index.mts";

const labels: RendererLabels = {
  reasoning: "思考",
  reasoningContent: "思考内容",
  reasoningSummary: "思考摘要",
  processGroup: "思考与工具",
  toolCall: "工具调用",
  toolResult: "工具结果",
  toolActivity: "工具活动",
  references: "参考",
  search: "搜索",
  diagram: "图表",
  source: "源码",
  loadingResource: "正在读取",
  unavailableResource: "资源不可用",
  failedResource: "读取失败",
  openAttachment: "打开附件",
  externalResource: "打开外部链接",
  systemParty: "系统",
  toolParty: "工具",
  otherParty: "其他"
};

test('conversation images are a lazy independent gallery, survive append, and never create an avatar or message', async () => {
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector<HTMLElement>('main')!;let loads=0;
  const renderer=createConversationRenderer({root,labels,theme:'star-night',language:'en',resolveResource:async()=>{loads++;return {url:'data:image/png;base64,AA=='};}});
  renderer.render({messages:[],conversation_images:[{id:'r1',kind:'image',availability:'embedded',name:'Generated.png'}]});
  assert.equal(loads,0); const gallery=root.querySelector<HTMLDetailsElement>('.cloudig-conversation-images')!;
  assert(!gallery.open); assert.match(gallery.textContent!,/Conversation images/);
  gallery.open=true;gallery.dispatchEvent(new dom.window.Event('toggle'));await tick();
  assert.equal(loads,1);assert.equal(root.querySelectorAll('.cloudig-message,.cloudig-avatar').length,0);
  renderer.append({messages:[]});assert.equal(root.querySelectorAll('.cloudig-conversation-images').length,1);
  gallery.open=false;gallery.open=true;gallery.dispatchEvent(new dom.window.Event('toggle'));await tick();assert.equal(loads,1);
  renderer.destroy();assert.equal(root.childElementCount,0);
});

test('assistant continuation omits only the repeated portrait and keeps time, model, body and anchor', async () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
  let avatars = 0;
  const renderer = createConversationRenderer({ root, labels, theme: 'dawn', resolveAvatar: async () => { avatars++; return { url: 'avatar.png' }; } });
  const m = (id: string, continuation = false): JsonObject => ({ anchor: id, party: { role: 'assistant', name: 'AI', avatar: 'ai' }, model: 'o1', timestamp: '2026-09-29T00:00:00Z', ...(continuation ? { assistant_continuation: true } : {}), blocks: [{category:'content',value:{type:'text',text:id}}] });
  renderer.render({messages:[m('first')]}); renderer.append({messages:[m('next',true)]}); await tick();
  assert.equal(root.querySelectorAll('.cloudig-message-identity').length,1); assert.equal(root.querySelectorAll('.cloudig-avatar').length,1); assert.equal(avatars,1);
  assert.equal(root.querySelectorAll('time').length,2); assert.equal(root.querySelectorAll('.cloudig-model-tag').length,2); assert(root.querySelector('#next')!.textContent!.includes('next'));
  renderer.render({messages:[m('focused',true)]}); await tick();
  assert.equal(root.querySelectorAll('.cloudig-message-identity').length,1,'An isolated search result still needs its own identity heading');
  renderer.destroy(); dom.window.close();
});

test('system, reasoning-only and tool messages share one collapsed process fold without repeated identities', () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
  const renderer = createConversationRenderer({ root, labels, theme: 'dawn' });
  const tool = (anchor: string, title: string): JsonObject => ({ anchor, party: { role: 'tool', name: title }, blocks: [{ category: 'tool', collapsed: true, value: { type: 'tool', kind: 'activity', title } }] });
  renderer.render({ messages: [
    { anchor: 'system-1', party: { role: 'system', name: 'System' }, blocks: [{ category: 'content', value: { type: 'status', title: 'system event', text: 'internal event' } }] },
    { anchor: 'reasoning-1', party: { role: 'assistant', name: 'AI' }, blocks: [{ category: 'reasoning', collapsed: true, value: { type: 'reasoning', title: 'Codex encrypted reasoning', text: 'encrypted' } }] },
    tool('tool-1', 'exec'), tool('tool-2', 'read_file'),
    { anchor: 'answer', party: { role: 'assistant', name: 'AI' }, blocks: [{ category: 'content', value: { type: 'text', text: 'done' } }] }
  ] });
  const group = root.querySelector<HTMLDetailsElement>('.cloudig-tool-message-group');
  assert(group); assert.equal(group.open, false); assert.equal(root.querySelectorAll('.cloudig-tool-message-group').length, 1);
  assert.equal(group.querySelectorAll('.cloudig-message').length, 4);
  assert.equal(group.querySelectorAll('.cloudig-message-identity').length, 0);
  assert.equal(group.querySelectorAll('.cloudig-process-group-identity').length, 1);
  assert.equal(root.querySelectorAll('.cloudig-process-axis-row > .cloudig-process-group-axis-avatar').length, 1, 'the first process avatar must remain outside the fold details');
  assert(root.textContent!.includes('exec')); assert(root.textContent!.includes('read_file')); assert(root.textContent!.includes('done'));
  renderer.destroy(); dom.window.close();
});

test('Agent-to-Agent delegation messages stay discoverable as independent assistant articles', () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
  const renderer = createConversationRenderer({ root, labels, theme: 'dawn' });
  renderer.render({ messages: [{ anchor: 'delegation', party: { role: 'assistant', name: 'Codex Agent', avatar: 'codex' }, blocks: [{ category: 'content', value: { type: 'markdown', text: '老婆决定建立新的文档奥思' } }] }] });
  assert.equal(root.querySelectorAll('.cloudig-process-group').length, 0);
  assert.equal(root.querySelectorAll('.cloudig-message').length, 1);
  assert.match(root.textContent ?? '', /老婆决定建立新的文档奥思/u);
  renderer.destroy(); dom.window.close();
});

test('external Agent messages stay as independent assistant articles outside the process fold', () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
  const renderer = createConversationRenderer({ root, labels, theme: 'dawn' });
  renderer.render({ messages: [{ anchor: 'external-agent', party: { role: 'assistant', name: 'Codex Agent', avatar: 'codex' }, blocks: [{ category: 'content', value: { type: 'markdown', text: '来自另一位奥思的独立来信' } }] }] });
  assert.equal(root.querySelectorAll('.cloudig-process-group').length, 0, 'an external Agent message is not a process/tool group');
  assert.equal(root.querySelectorAll('.cloudig-message').length, 1);
  assert.equal(root.querySelector('.cloudig-message-content')?.textContent?.trim(), '来自另一位奥思的独立来信');
  assert.equal(root.querySelectorAll('.cloudig-message-identity').length, 1, 'the external Agent keeps its own identity heading');
  renderer.destroy(); dom.window.close();
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('saved ChatGPT DIL has a static UI in new and already-parsed records, never a runtime or action', () => {
  const styles = readFileSync(new URL('../../../src/ui/shared/conversation-renderer/structured-box.css', import.meta.url), 'utf8');
  assert.match(styles, /\.cloudig-dil-automation\s*\{[^}]*container-type:\s*normal;[^}]*width:\s*fit-content/u, 'intrinsic-width suggestions must not inherit inline-size containment');
  for (const theme of ['dawn', 'star-night'] as const) for (const language of ['zh', 'en'] as const) {
    const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
    const ref = { type: 'dil', name: 'suggest_automation', dil_url: 'https://example.test/never-fetch', dil: { $onVisibleAction: 'throw Error()', initialState: { label: '<img onerror=alert(1)> Keep the original name', submitted: false }, children: [{ type: 'Button', $onClickAction: 'issue_new_turn' }] } };
    const clock = { type: 'dil', name: 'clock_widget', dil: { initialState: { time_label: '15:14', location: 'Beijing, China (CST)', tz_offset_minutes: 480, hour_angle: 97, minute_angle: 89.9, second_angle: 354 }, children: [{ type: 'RunInterval' }] } };
    const before = JSON.stringify([ref, clock]); let external = 0;
    const renderer = createConversationRenderer({ root, labels, theme, language, onOpenExternal: () => { external++; } });
    renderer.render({ messages: [{ party: { role: 'assistant' }, blocks: [
      { category: 'content', value: { type: 'interactive', display: 'box', source: 'chatgpt.com_dil', format: 'structured', data: ref } },
      { category: 'content', value: { type: 'unknown', kind: 'chatgpt-dil', text: JSON.stringify(ref) } },
      { category: 'content', value: { type: 'unknown', kind: 'chatgpt-dil', text: JSON.stringify(clock) } }
    ] }] });
    assert.equal(root.querySelectorAll('.cloudig-dil-suggestion').length, 2);
    assert.equal(root.querySelector('.cloudig-dil-time')!.textContent, '15:14');
    assert(root.textContent!.includes('UTC+08:00')); assert(root.textContent!.includes('Beijing, China (CST)'));
    const button = root.querySelector<HTMLButtonElement>('.cloudig-dil-suggestion')!; button.click();
    assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(external, 0);
    assert.equal(root.querySelector('iframe,script,img,a,pre'), null);
    assert(!root.textContent!.includes('issue_new_turn')); assert(!root.textContent!.includes('throw Error'));
    assert.equal(JSON.stringify([ref, clock]), before); renderer.destroy(); dom.window.close();
  }
});

test("Reader dispatches structured Boxes with local images, explicit UI language and resource release", async () => {
  const dom = new JSDOM('<html lang="zh"><main></main></html>'), root = dom.window.document.querySelector<HTMLElement>("main")!;
  let requested = 0, released = 0;
  const renderer = createConversationRenderer({ root, labels, theme: "star-night", language: "en", resolveResource: async () => {
    requested++; return { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", release: () => released++ };
  } });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: {
    type: "interactive", source: "claude.ai_recipe_display_v0", display: "box", format: "structured",
    data: { input: { title: "Recipe", base_servings: 1, ingredients: [{ amount: 1, name: "Water" }], steps: [{ title: "Mix", content: "First\nSecond" }] }, images: [{ path: "image.svg" }] },
    files: [{ path: "image.svg", resource: "r1" }]
  }, resources: [{ id: "r1", kind: "image", availability: "embedded" }] }] }] });
  await tick(); assert.equal(requested, 1); assert.equal(root.querySelector(".cloudig-box-image img")?.getAttribute("alt"), "Recipe");
  assert(root.textContent!.includes("Start cooking")); assert(root.textContent!.includes("First\nSecond"));
  const card = root.querySelector(".cloudig-box");
  assert(card, "the recipe is rendered as a card");
  assert.equal(card.closest("details"), null, "cards are content, not folded tool output; an internal units menu may fold");
  renderer.destroy(); assert.equal(released, 1); dom.window.close();
});

test("raw record HTML is inert at the Reader boundary without erasing text, tables or embedded images", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=";
  const html = `<button data-action="toggle-theme">Visible label</button><iframe src="https://example.org/frame" title="Frame description"></iframe><script>untrusted()</script><table><tr><td>Cell</td></tr></table><a href="https://example.org/reference" onclick="untrusted()">Reference</a><img src="${png}" alt="Embedded"><img src="https://example.org/external.png" alt="Remote description">`;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "html", html } }] }] });
  assert.equal(root.querySelector("button[data-action], iframe, script, [onclick]"), null);
  assert(root.textContent!.includes("Visible label")); assert(root.textContent!.includes("Frame description"));
  assert.equal(root.querySelector("td")!.textContent, "Cell");
  assert.equal(root.querySelector<HTMLImageElement>('img[alt="Embedded"]')!.src, png);
  assert.equal(root.querySelector('img[src^="https:"]'), null);
  assert(root.textContent!.includes("Remote description"));
  assert.equal(root.querySelector<HTMLAnchorElement>('a')!.href, "https://example.org/reference");
  renderer.destroy(); dom.window.close();
});

test("captured static KaTeX keeps inline geometry needed by legacy fractions and matrices", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const html = '<span class="osis-katex-shell"><span class="katex"><span class="katex-html"><span class="base"><span class="strut" style="height:0.6833em; vertical-align:-0.1em"></span><span class="mord"><span class="vlist-t"><span class="vlist-r"><span class="vlist" style="height:1.2em"><span style="top:-2.7em; margin-right:0.05em"><span class="pstrut" style="height:2.7em"></span><span class="sizing" style="width:0.8em">x</span></span></span></span></span></span></span></span></span></span><span class="ordinary" style="position:fixed;top:1px;width:100vw">ordinary</span>';
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "html", html } }] }] });
  const strut = root.querySelector<HTMLElement>(".katex .strut")!, positioned = root.querySelector<HTMLElement>(".katex .vlist > span")!, pstrut = root.querySelector<HTMLElement>(".katex .pstrut")!;
  assert.equal(strut.style.height, "0.6833em");
  assert.equal(strut.style.verticalAlign, "-0.1em");
  assert.equal(positioned.style.top, "-2.7em");
  assert.equal(positioned.style.marginRight, "0.05em");
  assert.equal(pstrut.style.height, "2.7em");
  const ordinary = root.querySelector<HTMLElement>(".ordinary")!;
  assert.equal(ordinary.style.position, "");
  assert.equal(ordinary.style.top, "");
  assert.equal(ordinary.style.width, "");
  renderer.destroy(); dom.window.close();
});

test("captured Temml frames keep safe bbox paint and display math alignment", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const html = '<div class="osis-math osis-temml osis-temml-display" data-math-display="block"><span class="osis-temml-frame osis-temml-frame-color" data-frame-kind="bbox" style="--osis-frame-color:#e8f0fe;--osis-frame-border:1px solid #1967d2;--osis-frame-padding:.18em .34em"><math><mrow><mi>x</mi></mrow></math></span></div><span class="ordinary" style="--osis-frame-color:expression(alert(1));position:fixed">ordinary</span>';
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "html", html } }] }] });
  const frame = root.querySelector<HTMLElement>(".osis-temml-frame")!;
  assert.equal(frame.style.getPropertyValue("--osis-frame-color"), "#e8f0fe");
  assert.equal(frame.style.getPropertyValue("--osis-frame-border"), "1px solid #1967d2");
  assert.equal(frame.style.getPropertyValue("--osis-frame-padding"), ".18em .34em");
  assert.equal(root.querySelector<HTMLElement>(".ordinary")!.style.position, "");
  assert.equal(root.querySelector<HTMLElement>(".ordinary")!.style.getPropertyValue("--osis-frame-color"), "");
  renderer.destroy(); dom.window.close();
});

test("Reader routes a light HTML Box inline, but never prestarts a heavy Window", async () => {
  const dom = new JSDOM('<html lang="zh"><main></main></html>', { url: "https://cloudig.local/index.html" }), root = dom.window.document.querySelector<HTMLElement>("main")!;
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { value(this: HTMLDialogElement) { this.open = false; } });
  Object.defineProperty(dom.window, "IntersectionObserver", { value: class { observe() {} disconnect() {} } });
  let requested = 0;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", resolveResource: async () => { requested++; return { url: "data:text/html,Plain" }; } });
  const value = { type: "interactive", source: "claude.ai_visualize", format: "html", title: "Pulse", entry: "index.html", files: [{ path: "index.html", resource: "r1" }] };
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    { category: "content", value: { ...value, display: "box" }, resources: [{ id: "r1", availability: "embedded" }] },
    { category: "content", value: { ...value, display: "window", title: "Heavy" }, resources: [{ id: "r1", availability: "embedded" }] }
  ] }] });
  await tick(); assert.equal(requested, 0); assert.equal(root.querySelectorAll("dialog.cloudig-interactive-box").length, 1);
  assert.equal(root.querySelectorAll(".cloudig-work-open").length, 1);
  assert.equal(root.querySelectorAll(".cloudig-window-entry > .cloudig-attachment").length, 0, "work files are available inside their closed file list, not repeated below the entry");
  assert.equal(root.querySelectorAll("iframe").length, 0); renderer.destroy(); assert.equal(dom.window.document.querySelector("dialog"), null); dom.window.close();
});

test("consecutive reasoning and tools form one closed group and lazy bodies preserve order and line breaks", async () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", formatDuration: value => `${value}秒` });
  const values = [
    { type: "reasoning", format: "markdown", duration: 3.448, text: "First thought.\nSecond thought.\n\nNext paragraph." },
    { type: "reasoning_summary", format: "text", text: "English summary." },
    { type: "reasoning_summary", format: "text", text: "中文摘要。" },
    { type: "tool", kind: "call", name: "python", input: "print('value')" }
  ];
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    ...values.map(value => ({ category: value.type === "tool" ? "tool" : "reasoning", collapsed: true, value })),
    { category: "content", value: { type: "text", text: "Answer remains directly visible." } }
  ] }] });
  const group = root.querySelector<HTMLDetailsElement>(".cloudig-process-group")!;
  assert.equal(group.open, false); assert.match(group.querySelector("summary")!.textContent!, /思考与工具 · 4/u);
  assert.equal(root.querySelector(".cloudig-message-content")!.lastElementChild!.textContent, "Answer remains directly visible.");
  const thoughts = [...group.querySelectorAll<HTMLDetailsElement>("details.cloudig-reasoning")];
  assert.deepEqual(thoughts.map(n => n.querySelector("summary")!.textContent), ["思考内容 · 3.448秒", "思考摘要 · 2"]);
  assert.equal(group.querySelector(".cloudig-rich"), null);
  group.open = true; thoughts[0]!.open = true; await tick(); await tick();
  assert.equal(thoughts[0]!.querySelectorAll("p").length, 2);
  assert.equal(thoughts[0]!.querySelectorAll("br").length, 1);
  assert.equal(thoughts[1]!.open, true, 'opening the process group exposes adjacent summaries together');
  assert.deepEqual([...thoughts[1]!.querySelectorAll('.cloudig-summary-entry')].map(n => n.textContent), ['English summary.', '中文摘要。']);
  assert.equal(thoughts[1]!.querySelectorAll('details').length, 0);
  const stale = thoughts[0]!; renderer.render({ messages: [] }); stale.open = false; stale.open = true; await tick();
  assert.equal(root.querySelector(".cloudig-message"), null, "late toggle cannot rebuild an old page");
  renderer.destroy(); dom.window.close();
});

test("duration-only and visibly empty reasoning is a non-interactive status, not an empty disclosure", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", formatDuration: seconds => `${seconds}秒` });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    { category: "reasoning", collapsed: true, value: { type: "status", title: "思考", duration: 2 } },
    { category: "reasoning", collapsed: true, value: { type: "reasoning", text: " \n\t" } },
    { category: "reasoning", collapsed: true, value: { type: "reasoning", format: "html", text: "<p><br></p>" } },
    { category: "reasoning", collapsed: true, value: { type: "reasoning", title: "有内容", text: "Complete reasoning" } }
  ] }] });
  assert.equal(root.querySelectorAll(".cloudig-process-static").length, 3);
  assert.equal(root.querySelectorAll("details.cloudig-reasoning").length, 1);
  assert.equal(root.querySelector(".cloudig-process-static")!.textContent, "思考 · 2秒");
  assert.equal(root.querySelector(".cloudig-process-static button, .cloudig-process-static summary, .cloudig-process-static [tabindex]"), null);
  assert.equal(root.querySelector("details.cloudig-reasoning .cloudig-fold-body")!.textContent, "");
  renderer.materializeDeferred();
  assert.equal(root.querySelector("details.cloudig-reasoning .cloudig-fold-body")!.textContent, "Complete reasoning");
  renderer.destroy(); dom.window.close();
});

test('summary sequences reveal every entry in one action, retain anchors and stop at tools or body', async () => {
  for (const theme of ['dawn', 'star-night'] as const) {
    const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
    const renderer = createConversationRenderer({ root, labels, theme });
    const summary = (n: number, value: JsonObject) => ({ anchor: `s${n}`, category: 'reasoning', collapsed: true, value: { type: 'reasoning_summary', ...value } });
    const blocks = [summary(1, { title: 'Only a title' }), summary(2, { title: 'Second heading', text: '**Second body**\nLine two', format: 'markdown' }), summary(3, { text: '<p>Third body</p>', format: 'html' }),
      { category: 'tool', collapsed: true, value: { type: 'tool', kind: 'call', input: 'Call' } }, summary(4, { text: 'Separate summary' }), { category: 'content', value: { type: 'text', text: 'Answer' } }];
    const before = JSON.stringify(blocks); renderer.render({ messages: [{ anchor: 'm1', party: { role: 'assistant' }, blocks }] });
    const seq = root.querySelector<HTMLDetailsElement>('.cloudig-summary-sequence')!;
    assert.equal(seq.open, false); assert.equal(root.querySelectorAll('.cloudig-summary-sequence').length, 1);
    assert(root.querySelector('#s1')); assert(root.querySelector('#s2')); assert(root.querySelector('#s3')); assert.equal(seq.querySelector('.cloudig-summary-entry')!.textContent, '');
    const outer = seq.closest<HTMLDetailsElement>('.cloudig-process-group')!; outer.open = true; await tick(); await tick();
    assert(seq.open); assert.equal(seq.querySelectorAll('details').length, 0); assert(seq.textContent!.includes('Only a title')); assert(seq.textContent!.includes('Third body'));
    assert.equal(seq.querySelectorAll('strong').length, 1); assert.equal(seq.querySelectorAll('br').length, 1);
    assert.equal(root.querySelector<HTMLDetailsElement>('#s4')!.open, false, 'a tool interrupts adjacency');
    assert.equal(JSON.stringify(blocks), before); renderer.destroy(); dom.window.close();
  }
});

test('message-spanning summaries append to the same disclosure without losing message IDs, times or lazy content', async () => {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
  const renderer = createConversationRenderer({ root, labels, theme: 'dawn' });
  const message = (n: number): JsonObject => ({ id: `m${n}`, anchor: `message-${n}`, summary_sequence: 'message-1', party: { role: 'assistant', name: 'AI' }, timestamp: `2026-09-28T12:0${n}:00Z`,
    blocks: [{ anchor: `message-${n}-process-1`, category: 'reasoning', collapsed: true, value: { type: 'reasoning_summary', text: `Summary ${n}` } }] });
  renderer.render({ messages: [message(1)] }); renderer.append({ messages: [message(2)] });
  const seq = root.querySelector<HTMLDetailsElement>('.cloudig-summary-message-fold')!;
  assert.equal(root.querySelectorAll('.cloudig-summary-messages').length, 1); assert.equal(seq.querySelector('summary')!.textContent, '思考摘要 · 2');
  assert.equal(seq.querySelectorAll('article').length, 2); assert(root.querySelector('#message-2-process-1')); assert.equal(seq.querySelector('.cloudig-summary-entry')!.textContent, '');
  seq.open = true; await tick(); renderer.append({ messages: [message(3)] });
  assert.equal(root.querySelector('.cloudig-summary-message-fold'), seq); assert(seq.open);
  assert.equal(root.querySelector('#message-3-process-1')!.textContent, 'Summary 3');
  assert.deepEqual([...root.querySelectorAll('article')].map(n => n.id), ['message-1', 'message-2', 'message-3']);
  assert.equal(root.querySelectorAll('time').length, 3); assert.equal(seq.querySelectorAll('details').length, 0);
  renderer.append({ messages: [{ anchor: 'answer', party: { role: 'assistant' }, blocks: [{ category: 'content', value: { type: 'text', text: 'Final answer' } }] }] });
  assert(!seq.contains(root.querySelector('#answer'))); assert.equal(root.querySelector('.cloudig-message-list')!.children.length, 2);
  const old = seq; renderer.render({ messages: [] }); old.open = false; old.open = true; await tick(); assert.equal(root.querySelector('article'), null);
  renderer.destroy(); dom.window.close();
});

test("nested captured process groups use themed folds without flattening their tree or adding message-axis dots", async () => {
  for (const theme of ["dawn", "star-night"] as const) {
    const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
    const renderer = createConversationRenderer({ root, labels, theme });
    const html = '<details><summary>已思考<strong>2</strong>次</summary><div><p>First paragraph.</p><details><summary>已完成思考</summary><div><p>Second paragraph.</p><a href="https://example.com/source">Source</a></div></details></div></details>';
    const render = (collapsed: boolean) => renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
      { category: "reasoning", collapsed, value: { type: "reasoning", title: "已处理", format: "html", text: html } },
      { category: "content", value: { type: "text", text: "Final answer." } }
    ] }] });
    render(true);
    const outer = root.querySelector<HTMLDetailsElement>(".cloudig-reasoning")!;
    assert.equal(outer.open, false); assert.equal(outer.querySelector("details"), null, "body stays lazy");
    outer.open = true; await tick();
    const nested = [...outer.querySelectorAll<HTMLDetailsElement>("details.cloudig-nested-process")];
    assert.equal(nested.length, 2); assert(nested.every(n => !n.open));
    assert(nested[0]!.contains(nested[1]!));
    assert.deepEqual(nested.map(n => n.querySelector(":scope > summary.cloudig-fold-title > .cloudig-fold-label")!.textContent), ["已思考2次", "已完成思考"]);
    assert.equal(nested[0]!.querySelector("summary strong")!.textContent, "2");
    assert.equal(root.querySelectorAll(".cloudig-process").length, 1, "one source process, one axis marker");
    assert.equal(root.querySelectorAll('a[href="https://example.com/source"]').length, 1);
    assert.equal(root.querySelectorAll(".cloudig-message-content > .cloudig-text").length, 1);
    nested[0]!.open = true; assert.equal(nested[1]!.open, false, "levels remain independent");
    render(false); assert([...root.querySelectorAll<HTMLDetailsElement>("details")].every(n => n.open), "explicit expand-all opens the inner levels too");
    render(true); renderer.materializeDeferred(); assert([...root.querySelectorAll<HTMLDetailsElement>("details")].every(n => !n.open), "collapse-all restores closed groups");
    renderer.destroy(); dom.window.close();
  }
});

test("long tool headings have a compact label slot without deleting any captured summary", async () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "star-night" });
  const title = "First line\n" + "Full captured explanation. ".repeat(40);
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "tool", collapsed: true,
    value: { type: "tool", kind: "activity", title, output: "Original result" } }] }] });
  const fold = root.querySelector<HTMLDetailsElement>("details.cloudig-tool")!;
  assert.equal(fold.open, false);
  assert.equal(fold.querySelector("summary > .cloudig-fold-label")?.textContent, title);
  assert.equal(fold.querySelector(".cloudig-tool-data"), null);
  fold.open = true;
  await tick();
  assert.equal(fold.querySelector(".cloudig-tool-data")?.textContent, "Original result");
  assert.equal(fold.querySelector("summary")?.textContent, title);
  renderer.destroy(); dom.window.close();
});

test("multi-part tool results keep text newlines and separately readable typed payloads", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "star-night" });
  const reference = { type: "tool_reference", tool_name: "WebSearch" };
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "tool", collapsed: false, value: {
    type: "tool", kind: "result", output: ["First line\nSecond line", reference, "Final text"]
  } }] }] });
  const parts = [...root.querySelectorAll(".cloudig-tool-data")].map(n => n.textContent);
  assert.equal(parts[0], "First line\nSecond line"); assert.deepEqual(JSON.parse(parts[1]!), reference); assert.equal(parts[2], "Final text");
  renderer.destroy(); dom.window.close();
});

test("tool result reference IDs and search image attribution display their actual linked sources", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    { category: "tool", collapsed: false, value: { type: "tool", kind: "activity", output: { sources: ["s1"] } }, sources: [{ id: "s1", url: "https://example.com/ref", title: "Named reference", snippet: "Excerpt" }] },
    { category: "content", value: { type: "image", resource: "r1", purpose: "search-result", caption: "Image caption" }, resources: [{ id: "r1", name: "image", availability: "embedded", original: { url: "https://example.com/image" } }] }
  ] }] });
  assert.equal(root.querySelector(".cloudig-tool-data"), null);
  assert.equal(root.querySelector<HTMLAnchorElement>(".cloudig-source-list a")!.href, "https://example.com/ref");
  assert.equal(root.querySelector<HTMLAnchorElement>("figcaption a")!.href, "https://example.com/image");
  renderer.destroy(); dom.window.close();
});

test("captured scheduled tasks read as folded cards without executing or rewriting their original settings", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const opened: string[] = [];
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", onOpenExternal: url => opened.push(url) });
  const sourceTask: JsonObject = { id: "job", title: "Daily check", prompt: "Keep $10 / $20 and <script> literal.\nSecond line", schedule: "BEGIN:VEVENT", is_enabled: true, untouched: [1, 2] };
  const input: JsonObject = { kind: "task-list", tasks: [{ title: "Daily check", schedule: "Every day", enabled: true, timezone: "Europe/London", prompt: sourceTask["prompt"]!, source_task: sourceTask }], all_tasks_url: "https://example.com/tasks" };
  const before = JSON.stringify(input);
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "tool", collapsed: false, value: { type: "tool", kind: "activity", name: "schedule", title: "已安排", input } }] }] });
  const task = root.querySelector<HTMLDetailsElement>(".cloudig-schedule-task")!;
  assert.ok(task, "a task list must not fall back to a single raw JSON block");
  assert.equal(task.open, false);
  assert.match(task.querySelector("summary")!.textContent!, /Daily check.*Every day/u);
  assert.equal(task.querySelector(".cloudig-schedule-prompt"), null);
  task.open = true; await tick();
  assert.equal(root.querySelector("details.cloudig-schedule"), null, "the task-list heading itself is not another disclosure");
  assert.equal(task.querySelector(".cloudig-schedule-prompt")!.textContent!.trim(), sourceTask["prompt"]);
  assert.equal(root.querySelector("script"), null);
  assert.equal(task.querySelector(".cloudig-tool-data"), null);
  renderer.materializeDeferred();
  assert.deepEqual(JSON.parse(task.querySelector(".cloudig-tool-data")!.textContent!), sourceTask);
  root.querySelector<HTMLAnchorElement>(".cloudig-schedule-all")!.click();
  assert.deepEqual(opened, ["https://example.com/tasks"]);
  renderer.setTheme("star-night");
  assert.equal(root.querySelectorAll(".cloudig-schedule-task").length, 1);
  assert.equal(JSON.stringify(input), before);
  renderer.destroy(); dom.window.close();
});

test("search quotations stay literal and captured emoji keeps the complete Unicode grapheme", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "star-night" });
  const snippet = "Price $0.435/$0.87; `echo $HOME`; <b>not markup</b>";
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    { category: "tool", value: { type: "tool", kind: "result", name: "web.run", output: snippet } },
    { category: "references", value: { type: "search" }, sources: [{ kind: "web", title: "Quoted text", url: "https://example.com/price", snippet }] },
    { category: "content", value: { type: "html", html: '<p>Price $0.435/$0.87 <span class="osis-emoji">👩🏽‍💻🇨🇳✨</span></p>' } }
  ] }] });
  assert.equal(root.querySelector(".cloudig-tool-data")!.textContent, snippet);
  assert.equal(root.querySelector(".cloudig-source-snippet")!.textContent, snippet);
  assert.equal(root.querySelector(".osis-emoji")!.textContent, "👩🏽‍💻🇨🇳✨");
  assert.equal(root.querySelectorAll("math, .katex, .cloudig-source-snippet b").length, 0);
  renderer.destroy(); dom.window.close();
});

test("an attachment thumbnail stays inside its matching file card, not as a full-size white page", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "star-night", resolveResource: async resource => ({ url: `https://cloudig.local/${resource["id"]}.webp` }) });
  renderer.render({ messages: [{ party: { role: "user" }, blocks: [
    { category: "content", value: { type: "image", resource: "r1", alt: "sample.pdf", purpose: "attachment-thumbnail" }, resources: [{ id: "r1", name: "sample.pdf", availability: "embedded" }] },
    { category: "content", value: { type: "attachment", resource: "r2" }, resources: [{ id: "r2", name: "sample.pdf", availability: "embedded" }] },
    { category: "content", value: { type: "image", resource: "r3", alt: "photo.png", purpose: "inline" }, resources: [{ id: "r3", name: "photo.png", availability: "embedded" }] }
  ] }] });
  await tick();
  assert.equal(root.querySelectorAll(".cloudig-attachment .cloudig-attachment-thumbnail img").length, 1);
  assert.equal(root.querySelectorAll(".cloudig-message-content > .cloudig-image").length, 1);
  assert.equal(root.querySelectorAll("img").length, 2);
  assert.equal(root.querySelectorAll(".cloudig-attachment-open").length, 1);
  renderer.destroy(); dom.window.close();
});

test("captured rich cards and table alignment replay static styles without page positioning", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: {
    type: "html", html: '<div style="background:#1a1a2e;color:#eee;padding:16px;border-radius:12px;position:fixed"><h3>Authored card</h3></div><div class="expanded-style" style="border-top-left-radius:12px;border-left-color:#123456;border-left-style:solid;border-left-width:2px;background-color:#1a1a2e;padding-bottom:16px">Expanded declarations</div><table><tr><td style="text-align:center">Cell</td></tr></table><math style="color:red"><mi>x</mi></math>'
  } }] }] });
  const card = root.querySelector<HTMLElement>(".cloudig-rich > div")!;
  assert.equal(card.style.background, "rgb(26, 26, 46)");
  assert.equal(card.style.color, "rgb(238, 238, 238)");
  assert.equal(card.style.padding, "16px");
  assert.equal(card.style.borderRadius, "12px");
  assert.equal(card.style.position, "");
  const expanded = root.querySelector<HTMLElement>(".expanded-style")!;
  assert.equal(expanded.style.borderTopLeftRadius, "12px");
  assert.equal(expanded.style.borderLeftColor, "rgb(18, 52, 86)");
  assert.equal(expanded.style.borderLeftWidth, "2px");
  assert.equal(expanded.style.paddingBottom, "16px");
  assert.equal(root.querySelector<HTMLElement>("td")!.style.textAlign, "center");
  assert.equal(root.querySelector("math")?.getAttribute("style"), "color: red;");
  renderer.destroy(); dom.window.close();
});

test("rich tables own one local scroll container without swallowing nearby content or changing cells", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  const table = '<table><caption>Caption</caption><tr><th colspan="2">Heading</th></tr><tr><td data-osis-align="right">Text</td><td><pre><code>one\ntwo</code></pre></td></tr></table>';
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "html", html:
    `<div class="table-wrap" dir="ltr">${table}</div><div class="old-table"> ${table} </div><section><p>Before</p>${table}<p>After</p></section><div class="table-wrap"><p>Not a table-only wrapper</p>${table}</div>`
  } }] }] });
  const tables = [...root.querySelectorAll("table")];
  assert.equal(tables.length, 4);
  for (const t of tables) {
    const wrapper = t.parentElement!;
    assert(wrapper.classList.contains("cloudig-table-scroll"));
    assert(wrapper.hasAttribute("data-scroll-region"));
    assert.equal(wrapper.children.length, 1);
    assert(!t.hasAttribute("data-scroll-region"));
    assert.equal(t.querySelector("caption")!.textContent, "Caption");
    assert.equal(t.querySelector("th")!.colSpan, 2);
    assert.equal(t.querySelector("td")!.dataset["osisAlign"], "right");
    assert.equal(t.querySelector("code")!.textContent, "one\ntwo");
    assert(t.querySelector("pre")!.hasAttribute("data-scroll-region"));
  }
  assert.equal(root.querySelectorAll(".cloudig-table-scroll").length, 4);
  assert.equal(tables[0]!.parentElement!.getAttribute("dir"), "ltr");
  assert(tables[1]!.parentElement!.classList.contains("old-table"));
  assert.equal(root.querySelector("section")!.children[0]!.textContent, "Before");
  assert.equal(root.querySelector("section")!.children[2]!.textContent, "After");
  assert.equal(tables[3]!.parentElement!.previousElementSibling!.textContent, "Not a table-only wrapper");
  renderer.destroy(); dom.window.close();
});

test("generated Markdown tables use the same local scrolling and retain column alignment", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "star-night" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "markdown",
    text: "Before\n\n| Left | Right |\n| :--- | ---: |\n| Value | Other |\n\nAfter" } }] }] });
  const t = root.querySelector("table")!;
  assert(t.parentElement!.classList.contains("cloudig-table-scroll"));
  assert.equal(t.rows.length, 2);
  assert.deepEqual([...t.rows[1]!.cells].map(c => c.style.textAlign), ["left", "right"]);
  assert.equal(t.parentElement!.previousElementSibling!.textContent, "Before");
  assert.equal(t.parentElement!.nextElementSibling!.textContent, "After");
  renderer.destroy(); dom.window.close();
});

test("Light metadata-only attachments and images show their known names, not a missing-resource warning", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  let resolved = 0;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", resolveResource: async () => { resolved++; return { url: "https://cloudig.local/image.png" }; } });
  renderer.render({ messages: [{ party: { role: "user" }, blocks: [
    { category: "content", value: { type: "attachment", resource: "r1" }, resources: [{ id: "r1", kind: "file", name: "notes.pdf", availability: "metadata_only" }] },
    { category: "content", value: { type: "image", resource: "r2", alt: "Photo description" }, resources: [{ id: "r2", kind: "image", availability: "metadata_only", name: "photo.png" }] }
  ] }] });
  await tick();
  assert.match(root.textContent!, /notes\.pdf/u);
  assert.doesNotMatch(root.textContent!, /资源不可用|读取失败/u);
  assert.equal(resolved, 0);
  assert.equal(root.querySelector(".cloudig-attachment-open"), null);
  renderer.destroy(); dom.window.close();
});

test("resource failures keep source descriptions but not application errors in the conversation", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", resolveResource: async () => { throw new Error("runtime materialization failed"); } });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    { category: "content", value: { type: "text", text: "平台原本显示的错误：工具调用失败" } },
    { category: "content", value: { type: "image", resource: "r1", alt: "保留的图片描述" }, resources: [{ id: "r1", availability: "embedded", name: "image.png" }] },
    { category: "content", value: { type: "image", resource: "r2", alt: "未取得的图片描述" } }
  ] }] });
  await tick();
  assert.match(root.textContent!, /平台原本显示的错误：工具调用失败/u);
  assert.match(root.textContent!, /保留的图片描述/u);
  assert.match(root.textContent!, /未取得的图片描述/u);
  assert.doesNotMatch(root.textContent!, /资源不可用|读取失败|runtime materialization/u);
  assert.equal(root.querySelectorAll("[data-cloudig-resource-error=true]").length, 1, "audits must still detect the actual failed materialization");
  renderer.destroy(); dom.window.close();
});

test("writing documents render rich content and diagram HTML snapshots are not replaced by an unavailable label", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    { category: "content", value: { type: "diagram", format: "writing-block", source: "# 文稿标题\n\n> 引用\n\n1. 第一条\n2. 第二条\n\n$e^{i\\pi}+1=0$" } },
    { category: "content", value: { type: "diagram", format: "svg", html: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>' } }
  ] }] });
  await tick();
  assert.equal(root.querySelector(".cloudig-writing h1")?.textContent, "文稿标题");
  assert.ok(root.querySelector(".cloudig-writing blockquote"));
  assert.equal(root.querySelectorAll(".cloudig-writing li").length, 2);
  assert.ok(root.querySelector(".cloudig-writing .katex"));
  assert.equal(root.querySelector(".cloudig-writing .cloudig-diagram-zoom"), null);
  assert.ok(root.querySelector(".cloudig-diagram-display svg rect"));
  assert.doesNotMatch(root.textContent!, /资源不可用/u);
  renderer.destroy(); dom.window.close();
});

test("inert TeX slots render inline without breaking the source paragraph, list or table", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "html", html: '<p>Before <span data-cloudig-math="inline">x^2</span> after</p><ol start="5"><li>List <span data-cloudig-math="inline">y^2</span> end</li></ol><table><tr><td>Cell <span data-cloudig-math="inline">z^2</span> end</td></tr></table>' } }] }] });
  for (const selector of ["p", "li", "td"]) { assert.equal(root.querySelectorAll(selector).length, 1); assert.ok(root.querySelector(`${selector} .katex`)); }
  assert.equal(root.querySelector("ol")?.getAttribute("start"), "5");
  assert.equal(root.querySelectorAll("[data-cloudig-math]").length, 0);
  renderer.destroy(); dom.window.close();
});

test("hundreds of messages and appended pages share one avatar request per identity and release it once", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  let requested = 0, released = 0;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", resolveAvatar: async reference => {
    requested++; await tick(); return { url: `https://cloudig.local/${reference}.svg`, release: () => { released++; } };
  } });
  const messages = Array.from({ length: 200 }, (_, index) => ({ anchor: `m${index}`, party: { role: index % 2 ? "assistant" : "user", avatar: index % 2 ? "ai" : "user" }, blocks: [] }));
  renderer.render({ messages }); await tick(); await tick();
  assert.equal(requested, 2); assert.equal(root.querySelectorAll(".cloudig-avatar img").length, 200);
  renderer.append({ messages }); await tick();
  assert.equal(requested, 2); assert.equal(root.querySelectorAll(".cloudig-avatar img").length, 400);
  renderer.setTheme("star-night"); await tick(); await tick();
  assert.equal(requested, 4); assert.equal(released, 2);
  renderer.destroy(); assert.equal(released, 4); dom.window.close();
});

test("offline content runtime renders Markdown and full KaTeX locally without enabling raw HTML", () => {
  const runtime = createOfflineContentRuntime();
  const html = runtime.renderMarkdown([
    "<script>globalThis.__must_not_run = true</script>",
    "",
    "[Open](https://example.com/path)",
    "",
    "Inline chemistry: $\\ce{H2O}$"
  ].join("\n"));

  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;/u);
  assert.match(html, /data-cloudig-external="true"/u);
  assert.match(html, /class="katex"/u);
  assert.match(html, /<math/u);
  const code = runtime.renderMarkdown("```javascript\nconst value = '<tag>';\n```");
  assert.match(code, /hljs-keyword/u);
  assert.match(code, /hljs-string/u);
  assert.doesNotMatch(code, /<tag>/u);
  for (const formula of [String.raw`\begin{gather}a+b=c\\d+e=f\end{gather}`, String.raw`f(x)=ax^2+bx+c\tag{1.1}`]) {
    const rendered = runtime.renderMath(formula, true);
    assert.doesNotMatch(rendered, /katex-error/u);
    assert.match(rendered, /katex-display/u);
  }
});

test("user newlines survive while assistant Markdown keeps semantic soft breaks and code gets a scroll owner", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  const markdown = "First line\nSecond line\n\n```js\nconst value = 1;\nconsole.log(value);\n```";
  renderer.render({ messages: ["user", "assistant"].map(role => ({ party: { role }, blocks: [
    { category: "content", value: { type: "markdown", text: markdown } },
    { category: "content", value: { type: "text", text: "One\nTwo" } }
  ] })) });
  assert.equal(root.querySelectorAll(".cloudig-message-user .cloudig-rich p br").length, 1);
  assert.equal(root.querySelectorAll(".cloudig-message-assistant .cloudig-rich p br").length, 0);
  assert.equal(root.querySelectorAll("pre.cloudig-code[data-scroll-region]").length, 2);
  assert.equal(root.querySelector(".cloudig-text")?.textContent, "One\nTwo");
  renderer.destroy(); dom.window.close();
});

test("captured code captions become one Reader header without removing prose or code", () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  const html = '<p>python</p><div class="osis-code-block"><div class="osis-code-language">python</div><pre><code data-language="python">print(1)</code></pre></div><section><div class="osis-code-language">plaintext</div><div><div><pre><code class="language-plaintext">keep this text</code></pre></div></div></section><div><div class="osis-code-language">An authored explanation</div><pre data-language="js"><code>const x = 1;</code></pre></div>';
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "html", html } }] }] });
  assert.deepEqual([...root.querySelectorAll(".osis-code-language")].map(node => node.textContent), ["An authored explanation"]);
  assert.deepEqual([...root.querySelectorAll<HTMLElement>("pre")].map(node => node.dataset["language"]), ["python", "plaintext", "js"]);
  assert.deepEqual([...root.querySelectorAll("pre code")].map(node => node.textContent), ["print(1)", "keep this text", "const x = 1;"]);
  assert.equal(root.querySelector(".cloudig-rich > p")!.textContent, "python");
  renderer.destroy(); dom.window.close();
});

test("HTML data-language and fenced language labels survive with exact code and local highlighting", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  const source = "const value = 1;\nconsole.log(value);";
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [
    { category: "content", value: { type: "html", html: `<pre data-language="javascript"><code>${source}</code></pre>` } },
    { category: "content", value: { type: "markdown", text: "```python\nprint(1)\n```" } },
    { category: "content", value: { type: "code", language: "bash", code: "echo hello" } }
  ] }] });
  const code = root.querySelector("pre code")!;
  assert.equal(code.textContent, source);
  assert.ok(code.querySelector(".hljs-keyword"));
  assert.deepEqual([...root.querySelectorAll<HTMLElement>("pre")].map(node => node.dataset["language"]), ["javascript", "python", "bash"]);
  renderer.destroy(); dom.window.close();
});

test("Cowork user paragraphs use the same explicit line breaks as other user HTML, without platform CSS", () => {
  const dom = new JSDOM("<main></main>");
  const style = dom.window.document.createElement("style");
  // JSDOM does not apply @layer. Test the selector's scope here; the fixed-EXE
  // audit checks the real layered stylesheet and paragraph geometry.
  style.textContent = readFileSync(new URL("../../../src/ui/shared/conversation-renderer/renderer.css", import.meta.url), "utf8")
    .replace(/^@layer components\s*\{/u, "").replace(/\}\s*$/u, "");
  dom.window.document.head.append(style);
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  renderer.render({ messages: [{ party: { role: "user" }, blocks: [
    { category: "content", value: { type: "html", html: '<section class="cowork-timeline"><p>First line\nSecond <code>inline</code> line</p></section>' } },
    { category: "content", value: { type: "markdown", text: "First line\nSecond line" } }
  ] }] });
  const paragraphs = [...root.querySelectorAll("p")];
  assert.equal(paragraphs[0]!.textContent, "First lineSecond inline line");
  assert.equal(paragraphs[0]!.querySelectorAll("br").length, 1);
  assert.notEqual(dom.window.getComputedStyle(paragraphs[0]!).whiteSpace, "pre-wrap");
  assert.notEqual(dom.window.getComputedStyle(paragraphs[1]!).whiteSpace, "pre-wrap");
  assert.equal(paragraphs[1]!.querySelectorAll("br").length, 1);
  renderer.destroy(); dom.window.close();
});

test("non-embedded Markdown images keep their position, alt, title and URL without a broken network image", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const opened: string[] = [];
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", onOpenExternal: url => opened.push(url) });
  renderer.render({ messages: [{ party: { role: "assistant", name: "AI" }, blocks: [{
    category: "content", value: { type: "markdown", text: 'Before ![A & B](https://example.com/image_(1).png?x=1&y=2 "Original title") after.' }
  }] }] });
  const link = root.querySelector<HTMLAnchorElement>(".cloudig-external-resource")!;
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.querySelector(".cloudig-rich")?.textContent, "Before A & B after.\n");
  assert.equal(link.title, "Original title");
  assert.equal(link.href, "https://example.com/image_(1).png?x=1&y=2");
  link.click();
  assert.deepEqual(opened, ["https://example.com/image_(1).png?x=1&y=2"]);
  renderer.destroy(); dom.window.close();
});

test("diagram zoom changes only the local view and is inert while the source tab is shown", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "star-night", resolveResource: async () => ({url:"https://cloudig-runtime.local/diagram.svg"}) });
  renderer.render({ messages: [{party:{role:"assistant"},blocks:[{category:"content",value:{type:"diagram",format:"markmap",source:"# A",rendered:"r1"},resources:[{id:"r1",availability:"embedded"}]}]}] });
  await tick();
  const graphic = root.querySelector<HTMLImageElement>(".cloudig-resource-image")!;
  graphic.getBoundingClientRect = () => ({ width: 300 } as DOMRect);
  const zoom = root.querySelectorAll<HTMLButtonElement>(".cloudig-diagram-zoom");
  zoom[1]!.click(); assert.equal(graphic.style.width, "450px");
  root.querySelectorAll<HTMLButtonElement>(".cloudig-diagram-tab")[1]!.click();
  assert.equal(root.querySelector<HTMLButtonElement>('[data-diagram-view="source"]')!.getAttribute("aria-pressed"), "true");
  assert.equal(root.querySelector<HTMLElement>(".cloudig-diagram-display")!.hidden, true);
  assert.equal(root.querySelector<HTMLElement>(".cloudig-diagram-source")!.hidden, false);
  assert.equal(root.querySelector(".cloudig-diagram-source")!.textContent, "# A");
  zoom[1]!.click(); assert.equal(graphic.style.width, "450px");
  root.querySelectorAll<HTMLButtonElement>(".cloudig-diagram-tab")[0]!.click();
  assert.equal(root.querySelector<HTMLButtonElement>('[data-diagram-view="diagram"]')!.getAttribute("aria-pressed"), "true");
  assert.equal(root.querySelector<HTMLElement>(".cloudig-diagram-display")!.hidden, false);
  assert.equal(root.querySelector<HTMLElement>(".cloudig-diagram-source")!.hidden, true);
  zoom[0]!.click(); assert.equal(graphic.style.width, "");
  renderer.destroy(); dom.window.close();
});

test("exported KaTeX is rebuilt through trusted layout and tool output links preserve their text", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const content = createOfflineContentRuntime();
  let reRendered = 0;
  const opened: string[] = [];
  const output = 'Links: [{"title":"Page","url":"https://example.com/page"}]';
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", runtime: { ...content, renderMath(source, display) { reRendered++; return content.renderMath(source, display); } }, onOpenExternal: url => opened.push(url) });
  renderer.render({ messages: [{ anchor: "test", party: { role: "assistant", name: "AI" }, blocks: [
    { category: "content", value: { type: "html", html: content.renderMath("\\sqrt{\\frac{x}{y}}", true) } },
    { category: "tool", collapsed: true, value: { type: "tool", kind: "result", output } }
  ] }] });
  assert.equal(reRendered, 1);
  assert.ok(root.querySelector<HTMLElement>(".katex .katex-strut")!.style.height);
  assert.equal(root.querySelector("[data-cloudig-layout]"), null);
  renderer.materializeDeferred();
  assert.equal(root.querySelector(".cloudig-tool-data")!.textContent, output);
  root.querySelector<HTMLAnchorElement>(".cloudig-tool-data a")!.click();
  assert.deepEqual(opened, ["https://example.com/page"]);
  renderer.destroy(); dom.window.close();
});

test("captured legacy KaTeX 0.16 static DOM keeps its layout instead of becoming formula noise", () => {
  const dom = new JSDOM("<main></main>");
  const style = dom.window.document.createElement("style");
  style.textContent = readFileSync(new URL("../../../src/ui/shared/conversation-renderer/katex-legacy-static.css", import.meta.url), "utf8");
  dom.window.document.head.append(style);
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn" });
  // Yuanbao and Kimi can capture this older KaTeX DOM without an annotation;
  // it must be displayed as captured, not treated as plain text or re-parsed.
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: {
    type: "html",
    html: '<div class="osis-math osis-katex-shell osis-math-display" data-math-display="block"><span class="katex osis-katex"><span class="katex-html"><span class="base"><span class="strut" style="height:1.2em"></span><span class="mord mathnormal">x</span><span class="mrel">=</span><span class="mord"><span class="mord mathnormal">y</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span style="top:-2.4em"><span class="pstrut" style="height:2.7em"></span><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">2</span></span></span></span></span></span></span></span></span></span></span></span></div>'
  } }] }] });
  const base = root.querySelector<HTMLElement>(".katex .base")!;
  const strut = root.querySelector<HTMLElement>(".katex .strut")!;
  assert.ok(base, "legacy KaTeX base was discarded");
  assert.equal(dom.window.getComputedStyle(base).display, "inline-block");
  assert.equal(dom.window.getComputedStyle(base).whiteSpace, "nowrap");
  assert.equal(dom.window.getComputedStyle(strut).display, "inline-block");
  assert.equal(root.querySelectorAll(".katex-error").length, 0);
  renderer.destroy(); dom.window.close();
});

test("a source thinking heading that already includes elapsed time does not gain a second duration label", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", formatDuration: value => `${value} seconds` });
  for (const title of ["Thought for 4s", "思考了4秒", "思考用时 2 秒", "思考用时 1 分钟 3 秒"]) {
    renderer.render({ messages: [{ party: { role: "assistant", name: "AI" }, blocks: [{
      category: "reasoning", collapsed: true, value: { type: "reasoning_summary", title, text: "Summary", duration: 4.3 }
    }] }] });
    assert.match(root.querySelector<HTMLDetailsElement>(".cloudig-process-group > summary")?.textContent ?? "", /思考与工具 · 1/u);
    assert.equal(root.querySelector<HTMLDetailsElement>(".cloudig-process-group .cloudig-reasoning > summary")?.textContent, title);
    assert.equal(root.querySelectorAll("details").length, 2);
    renderer.materializeDeferred();
    assert.equal(root.querySelector<HTMLDetailsElement>(".cloudig-process-group .cloudig-reasoning > .cloudig-fold-body")?.textContent, "Summary");
  }
  renderer.destroy(); dom.window.close();
});

test("original Mermaid snapshots retain their bytes in both themes and source toggling never recolors them", async () => {
  const url = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#CC785C"/></svg>').toString('base64');
  for (const theme of ['dawn', 'star-night'] as const) {
    const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
    let localCalls = 0;
    const renderer = createConversationRenderer({ root, labels, theme,
      runtime: { renderMarkdown: text => text, renderMath: text => text, renderMermaid: async () => { localCalls++; return '<svg/>'; } },
      resolveResource: async () => ({ url }) });
    renderer.render({ messages: [{ party: { role: 'assistant' }, blocks: [{ category: 'content', value: { type: 'diagram', format: 'mermaid', rendered: 'r1', source: 'graph TD; A-->B' },
      resources: [{ id: 'r1', availability: 'embedded', kind: 'diagram', mime: 'image/svg+xml', name: 'Original chart' }] }] }] });
    await tick();
    assert.equal(root.querySelector<HTMLImageElement>('.cloudig-diagram-display img')!.src, url);
    root.querySelector<HTMLButtonElement>('[data-diagram-view=source]')!.click();
    assert.equal(root.querySelector<HTMLElement>('.cloudig-diagram-source')!.hidden, false);
    assert.equal(root.querySelector('.cloudig-diagram-source')!.textContent, 'graph TD; A-->B');
    root.querySelector<HTMLButtonElement>('[data-diagram-view=diagram]')!.click();
    assert.equal(root.querySelector<HTMLImageElement>('.cloudig-diagram-display img')!.src, url);
    assert.equal(localCalls, 0);
    renderer.destroy(); dom.window.close();
  }
});

test("a captured Mermaid rendering never falls back to a locally redrawn chart when its resource fails", async () => {
  const dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector<HTMLElement>("main")!;
  let localCalls = 0;
  const renderer = createConversationRenderer({ root, labels, theme: "dawn",
    runtime: { renderMarkdown: text => text, renderMath: text => text, renderMermaid: async () => { localCalls++; return "<svg/>"; } },
    resolveResource: async () => { throw new Error("captured resource unavailable"); }
  });
  renderer.render({ messages: [{ party: { role: "assistant" }, blocks: [{ category: "content", value: { type: "diagram", format: "mermaid", rendered: "r1", source: "graph TD; A-->B" }, resources: [{ id: "r1", availability: "embedded", kind: "diagram", mime: "image/svg+xml", name: "Original chart" }] }] }] });
  await tick();
  assert.equal(localCalls, 0);
  assert.equal(root.querySelector(".cloudig-mermaid-image"), null);
  renderer.destroy(); dom.window.close();
});

test("shared renderer keeps roles, process folds, sources, resources and diagram states in one bounded DOM", async () => {
  const dom = new JSDOM("<!doctype html><main id='reader'></main>", { url: "https://cloudig.local/reader" });
  const root = dom.window.document.querySelector<HTMLElement>("#reader")!;
  const openedExternal: string[] = [];
  const openedResources: string[] = [];
  const editedRoles: string[] = [];
  const resolvedResources: string[] = [];
  const released: string[] = [];
  const diagrams: Array<{ source: string; theme: RendererTheme }> = [];
  const runtime: OfflineContentRuntime = {
    renderMarkdown: (source) => `<p data-markdown="true">${source}</p>`,
    renderMath: (source) => `<span data-math="true">${source}</span>`,
    renderMermaid: async (source, _id, theme) => {
      diagrams.push({ source, theme });
      return `<svg data-theme="${theme}"><title>${source}</title></svg>`;
    }
  };
  const embedded = (id: string, name: string): JsonObject => ({
    id,
    availability: "embedded",
    name,
    mime: "image/png",
    bytes: 3,
    sha256: "0".repeat(64)
  });
  const view: JsonObject = {
    messages: [
      {
        anchor: "message-1",
        source_index: 0,
        party: { role: "user", name: "晨星", avatar: "user-avatar" },
        blocks: [{ category: "content", value: { type: "markdown", text: "用户正文" } }]
      },
      {
        anchor: "message-2",
        source_index: 1,
        party: { role: "assistant", name: "ChatGPT", avatar: "chatgpt-avatar" },
        model: "GPT-5.6-Sol",
        timestamp: "2026-08-31T19:01:00.000Z",
        blocks: [
          { category: "reasoning", collapsed: true, value: { type: "reasoning", title: "思考", text: "过程" } },
          { category: "tool", collapsed: true, value: { type: "tool", kind: "call", name: "bio", input: { value: 1 } } },
          {
            category: "references",
            collapsed: true,
            value: { type: "citations", label: "参考" },
            sources: [{ id: "s1", kind: "web", title: "来源", url: "https://example.com/source", snippet: "摘要" }]
          },
          { category: "content", value: { type: "image", resource: "r1", caption: "缩略图" }, resources: [embedded("r1", "image.png")] },
          { category: "content", value: { type: "attachment", resource: "r2" }, resources: [embedded("r2", "notes.pdf")] },
          { category: "content", value: { type: "diagram", format: "mermaid", source: "graph TD; A-->B" } },
          {
            category: "content",
            value: { type: "image", resource: "r3", alt: "remote" },
            resources: [{ id: "r3", availability: "external", name: "remote.png", mime: "image/png", url: "https://example.com/remote.png" }]
          }
        ]
      }
    ]
  };

  const renderer = createConversationRenderer({
    root,
    labels,
    theme: "dawn",
    runtime,
    resolveResource: async (resource) => {
      const id = String(resource["id"]);
      resolvedResources.push(id);
      return { url: `data:image/png;base64,${id}`, release: () => released.push(id) };
    },
    resolveAvatar: async (reference) => ({
      url: `data:image/png;base64,${reference}`,
      release: () => released.push(reference)
    }),
    onOpenExternal: (url) => openedExternal.push(url),
    onOpenResource: (id) => openedResources.push(id),
    onEditIdentity: (role) => editedRoles.push(role)
  });

  renderer.render(view);
  await tick();

  assert.equal(root.dataset["theme"], "dawn");
  assert.equal(root.querySelectorAll(".cloudig-message").length, 2);
  assert.ok(root.querySelector(".cloudig-message-user .cloudig-message-content"));
  assert.ok(root.querySelector(".cloudig-message-assistant .cloudig-message-content"));
  assert.equal(root.querySelector(".cloudig-model-tag")?.textContent, "GPT-5.6-Sol");
  assert.equal(root.querySelector(".cloudig-message-time")?.textContent, "2026-08-31T19:01:00.000Z");
  assert.equal(root.querySelector("#message-2-process-1")?.getAttribute("data-category"), "reasoning");
  assert.equal(root.querySelector("#message-2-process-2")?.getAttribute("data-category"), "tool");
  assert.equal(root.querySelectorAll("details:not([open])").length, 4);
  assert.equal(root.querySelectorAll("details.cloudig-process-group:not([open])").length, 1);
  assert.deepEqual(resolvedResources, ["r1"]);
  assert.match(root.querySelector<HTMLImageElement>(".cloudig-image img")?.src ?? "", /^data:image\/png;base64,r1$/u);
  assert.equal(root.querySelector(".cloudig-image figcaption")?.textContent, "缩略图");
  assert.equal(root.querySelector(".cloudig-attachment-name")?.textContent, "notes.pdf");
  assert.equal(diagrams.at(-1)?.theme, "dawn");
  assert.match(decodeURIComponent(root.querySelector<HTMLImageElement>(".cloudig-mermaid-image")!.src.split(",").slice(1).join(",")), /data-theme="dawn"/u);
  assert.equal(resolvedResources.includes("r3"), false);
  assert.equal(root.querySelector(".cloudig-external-resource")?.textContent, "remote");

  root.querySelector<HTMLButtonElement>(".cloudig-attachment-open")!.click();
  root.querySelector<HTMLButtonElement>(".cloudig-message-identity")!.click();
  renderer.materializeDeferred();
  root.querySelector<HTMLAnchorElement>(".cloudig-source-link")!.click();
  root.querySelector<HTMLAnchorElement>(".cloudig-external-resource")!.click();
  assert.deepEqual(openedResources, ["r2"]);
  assert.deepEqual(editedRoles, ["user"]);
  assert.deepEqual(openedExternal, ["https://example.com/source", "https://example.com/remote.png"]);

  renderer.setTheme("star-night");
  await tick();
  assert.equal(root.dataset["theme"], "star-night");
  assert.equal(diagrams.at(-1)?.theme, "star-night");
  assert.match(decodeURIComponent(root.querySelector<HTMLImageElement>(".cloudig-mermaid-image")!.src.split(",").slice(1).join(",")), /data-theme="star-night"/u);
  assert.ok(released.includes("r1"));
  assert.ok(released.includes("user-avatar"));

  renderer.destroy();
  assert.equal(root.childElementCount, 0);
  dom.window.close();
});
