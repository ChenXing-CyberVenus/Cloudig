import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
import { validateRecord } from '../../../src/core/records/index.mts';
import { extractClaudeRecord } from '../../../src/app/parser/record-source.mts';
import { assembleConversationRecord } from '../../../src/app/parser/conversation-record.mts';
import { selectedMessageBlocks, messageContentCategory } from '../../../src/app/reader/content-selection.mts';
import { prepareRecordConversationView, DEFAULT_READER_SESSION } from '../../../src/app/reader/view-model.mts';
import { buildRecordMarkdown } from '../../../src/app/export/markdown.mts';
import { createConversationRenderer, type RendererLabels } from '../../../src/ui/shared/conversation-renderer/index.mts';

const prompt = '<system-reminder>\n<user_memory_snapshot>\nline one\n\n  line two\n<script>unsafe()</script>\n</user_memory_snapshot>\n</system-reminder>';
const source = { file: 'conversations.json', sha256: '1'.repeat(64), bytes: 123 };
const makeRecord = (): JsonObject => ({ uuid: 'thread', name: 'Context fidelity', chat_messages: [
  { uuid: 'human', sender: 'human', text: 'Real user\nsecond line', content: [
    { type: 'text', text: 'Real user\nsecond line' },
    ...['memory_block_head', 'melange_tombstone', 'date_note', 'future_context'].map(injection_source => ({ type: 'injected_prompt_block', injection_source, prompt, flags: null, initial_turn_only: false }))
  ] },
  { uuid: 'ai', sender: 'assistant', parent_message_uuid: 'human', content: [{ type: 'text', text: 'injected_prompt_block is a literal in this answer.' }] }
] });
const messages = (v: JsonObject) => v['messages'] as JsonObject[];
const resolved = { platform: 'claude', conversationName: 'Test', models: [], userName: 'U', assistantName: 'A', userAvatar: 'u', assistantAvatar: 'a', effectiveEditedAt: '2026-09-27T12:00:00Z', contentTime: { state: 'unavailable' as const } };
const request = { page: { offset: 0, limit: 20 }, navigationPage: { offset: 0, limit: 20 }, branchPage: { offset: 0, limit: 20 } };

test('Claude injected context retains exact prompt/order but not transport JSON or human authorship', () => {
  const record = makeRecord(), before = structuredClone(record);
  const extracted = extractClaudeRecord({ record, source });
  const first = messages(extracted.parsed.draft)[0]!, blocks = first['content'] as JsonObject[];
  assert.deepEqual(record, before);
  assert.equal(blocks[0]!['text'], 'Real user\nsecond line');
  assert.deepEqual(blocks.slice(1).map(b => b['title']), ['Claude memory snapshot', 'Claude memory update', 'Claude date context', 'Claude platform context · future_context']);
  for (const block of blocks.slice(1)) {
    assert.equal(block['type'], 'status'); assert.equal(block['text'], prompt); assert.equal(block['format'], 'text');
    assert.equal(messageContentCategory('user', block), 'process'); assert(!('flags' in block));
    assert.equal(extracted.facts.blockSpeakers?.get(block)?.role, 'system');
  }
  assert.equal(selectedMessageBlocks(first, 'body').length, 1);
  assert.equal(selectedMessageBlocks(first, 'with_process').length, 5);
  assert.equal(messages(extracted.parsed.draft)[1]!['parent'], first['id']);
  const output = assembleConversationRecord({ ...extracted, parserVersion: '1.1.15', timestamp: '2026-09-27T12:00:00Z' });
  const valid = validateRecord('conversation', output); assert.equal(valid.ok, true, JSON.stringify(valid));
  const identities = output['identity'] as JsonObject[], saved = ((output['messages'] as JsonObject)['items'] as JsonObject[])[0]!;
  const blockSpeaker = (saved['content'] as JsonObject[])[1]!['speaker'];
  assert.equal(identities.find(f => f['source_id'] === blockSpeaker)!['role'], 'system');
  assert.notEqual(blockSpeaker, saved['speaker']);
  const page = prepareRecordConversationView({ conversation: output, resolved: { platform: 'claude', conversationName: 'Test', models: [], userName: 'U', assistantName: 'A', userAvatar: 'u', assistantAvatar: 'a', effectiveEditedAt: '2026-09-27T12:00:00Z', contentTime: { state: 'unavailable' } } }).page({ page: { offset: 0, limit: 20 }, navigationPage: { offset: 0, limit: 20 }, branchPage: { offset: 0, limit: 20 } });
  const process = ((page['messages'] as JsonObject[])[0]!['blocks'] as JsonObject[]).slice(1);
  assert(process.every(b => b['collapsed'] === true && b['category'] === 'reasoning'));
});

test('unknown blocks, malformed prompts and actual user literals retain the existing lossless fallback', () => {
  const record = makeRecord(), first = (record['chat_messages'] as JsonObject[])[0]!;
  first['content'] = [{ type: 'text', text: '{"type":"injected_prompt_block"}' }, { type: 'injected_prompt_block', prompt: { unexpected: 1 } }, { type: 'future-block', value: 'preserve me' }];
  const blocks = messages(extractClaudeRecord({ record, source }).parsed.draft)[0]!['content'] as JsonObject[];
  assert.equal(blocks[0]!['type'], 'markdown'); assert.equal(blocks[1]!['type'], 'unknown');
  assert.equal(JSON.parse(String(blocks[1]!['text'])).prompt.unexpected, 1);
  assert.equal(JSON.parse(String(blocks[2]!['text'])).value, 'preserve me');
});

test('Reader folds injected context, localizes its heading and renders XML as inert multiline text', async () => {
  const value = (messages(extractClaudeRecord({ record: makeRecord(), source }).parsed.draft)[0]!['content'] as JsonObject[])[1]!;
  for (const theme of ['dawn', 'star-night'] as const) for (const language of ['zh', 'en'] as const) {
    const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
    const labels: RendererLabels = { reasoning: 'Reasoning', toolCall: 'Call', toolResult: 'Result', toolActivity: 'Activity', references: 'References', search: 'Search', diagram: 'Diagram', source: 'Source', loadingResource: 'Loading', unavailableResource: 'Unavailable', failedResource: 'Failed', openAttachment: 'Open', externalResource: 'External', systemParty: 'System', toolParty: 'Tool', otherParty: 'Other' };
    const renderer = createConversationRenderer({ root, labels, theme, language });
    renderer.render({ messages: [{ party: { role: 'user' }, blocks: [{ category: 'reasoning', collapsed: true, value }] }] });
    const fold = root.querySelector<HTMLDetailsElement>('details')!;
    assert.equal(fold.open, false); assert(!root.textContent!.includes('line one'));
    assert(root.querySelector('summary')!.textContent!.includes(language === 'en' ? 'Claude memory snapshot' : '记忆快照'));
    fold.open = true; fold.dispatchEvent(new dom.window.Event('toggle')); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelector('.cloudig-text')!.textContent, prompt);
    assert.equal(root.querySelector('script, system-reminder, user_memory_snapshot'), null);
    assert(!root.textContent!.includes('initial_turn_only'));
    const date = { type: 'status', title: 'Claude date context', format: 'text', text: '\n\nThe current date is Tuesday, September 01, 2026.\n\n' };
    const dateBefore = structuredClone(date);
    renderer.render({ messages: [{ party: { role: 'system' }, blocks: [{ category: 'reasoning', collapsed: true, value: date }] }] });
    const dateFold = root.querySelector<HTMLDetailsElement>('.cloudig-process-group')!;
    dateFold.open = true; dateFold.dispatchEvent(new dom.window.Event('toggle')); await new Promise(resolve => setTimeout(resolve, 0));
    const dateContent = root.querySelector<HTMLDetailsElement>('.cloudig-process-group .cloudig-reasoning')!;
    dateContent.open = true; dateContent.dispatchEvent(new dom.window.Event('toggle')); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelector('.cloudig-text')!.textContent, date.text.trim());
    assert.deepEqual(date, dateBefore, 'Boundary whitespace is a display decision, not a source mutation');
    renderer.render({ messages: [{ party: { role: 'user' }, blocks: [value, value].map(value => ({ category: 'reasoning', collapsed: true, value })) }] });
    const group = root.querySelector<HTMLDetailsElement>('.cloudig-platform-context-group')!;
    assert.equal(group.open, false); assert(group.querySelector('summary')!.textContent!.includes(language === 'en' ? 'platform context' : '平台上下文'));
    renderer.destroy(); dom.window.close();
  }
});

test('flag is structural system evidence: arbitrary codes and all additional details survive without guessing ordinary text', () => {
  const record = makeRecord(), ai = (record['chat_messages'] as JsonObject[])[1]!;
  const helpline = { id: 'helpline-test', phone_number: '988', url: null };
  ai['content'] = [
    { type: 'text', text: 'self_harm_risk and ethics_reminder are words in my answer.' },
    { type: 'flag', flag: 'self_harm_risk', helpline },
    { type: 'flag', flag: 'future_flag', extra: { list: ['preserved'], value: false } },
    { type: 'text', text: 'Answer continues\non another line.' }
  ];
  const extracted = extractClaudeRecord({ record, source }), blocks = messages(extracted.parsed.draft)[1]!['content'] as JsonObject[];
  assert.deepEqual(JSON.parse(String(blocks[1]!['text'])), { flag: 'self_harm_risk', helpline });
  assert.deepEqual(JSON.parse(String(blocks[2]!['text'])), { flag: 'future_flag', extra: { list: ['preserved'], value: false } });
  assert.equal(extracted.facts.blockSpeakers?.get(blocks[1]!)?.role, 'system');
  assert.equal(extracted.facts.blockSpeakers?.get(blocks[2]!)?.role, 'system');
  assert.equal(extracted.facts.blockSpeakers?.has(blocks[0]!), false);
  const output = assembleConversationRecord({ ...extracted, parserVersion: '1.1.17', timestamp: '2026-09-27T12:00:00Z' });
  assert.equal(validateRecord('conversation', output).ok, true);
  const body = buildRecordMarkdown({ conversation: output, resolved, locale: 'en', contentMode: 'body' }).parts.join('');
  const all = buildRecordMarkdown({ conversation: output, resolved, locale: 'en', contentMode: 'with_process' }).parts.join('');
  assert(body.includes('ethics_reminder are words')); assert(!body.includes('helpline-test'));
  assert(all.includes('## System · Claude platform context')); assert(all.includes('helpline-test'));
});

test('real projection separates system nodes from speech bubbles while retaining canonical anchors, branches and process navigation', () => {
  const record = makeRecord();
  const human = (record['chat_messages'] as JsonObject[])[0]!;
  (human['content'] as JsonObject[]).push({ type: 'text', text: 'Human continuation' });
  const output = assembleConversationRecord({ ...extractClaudeRecord({ record, source }), parserVersion: '1.1.17', timestamp: '2026-09-27T12:00:00Z' });
  const original = structuredClone(output);
  const view = prepareRecordConversationView({ conversation: output, resolved });
  const page = view.page({ ...request, session: { ...DEFAULT_READER_SESSION, navigation: { user: true, assistant: true, process: true } } });
  const navigation = (page['navigation'] as JsonObject)['items'] as JsonObject[];
  assert.equal(navigation.filter(n => n['kind'] === 'process').length, 4);
  assert.deepEqual(navigation.filter(n => n['kind'] === 'process').map(n => n['anchor']), [2, 3, 4, 5].map(n => `message-1-process-${n}`));
  for (const theme of ['dawn', 'star-night'] as const) {
    const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector<HTMLElement>('main')!;
    const labels = { reasoning: 'Thinking', toolCall: 'Call', toolResult: 'Result', toolActivity: 'Process', references: 'References', search: 'Search', diagram: 'Diagram', source: 'Source', loadingResource: 'Loading', unavailableResource: 'Unavailable', failedResource: 'Failed', openAttachment: 'Open', externalResource: 'External', systemParty: 'System', toolParty: 'Tool', otherParty: 'Other' };
    const renderer = createConversationRenderer({ root, labels, theme, language: 'en' }); renderer.render(page);
    const system = root.querySelector('.cloudig-message-system')!; assert(system);
    assert.equal(system.querySelector('.cloudig-system-avatar img')?.getAttribute('src'), '/assets/identity/System-Avatar.svg');
    assert.equal(system.closest('.cloudig-message-user, .cloudig-message-assistant'), null);
    assert.equal(system.querySelector('.cloudig-message-name')!.textContent, 'System');
    assert.equal(system.querySelector<HTMLDetailsElement>('details')!.open, false);
    assert.equal(root.querySelectorAll('.cloudig-message-user').length, 2);
    assert.equal(root.querySelectorAll('#message-1').length, 1);
    assert(root.querySelector('#message-1-process-2'));
    assert.equal(root.querySelectorAll('[id]').length, new Set([...root.querySelectorAll('[id]')].map(e => e.id)).size);
    renderer.destroy(); dom.window.close();
  }
  const hidden = view.page({ ...request, session: { ...DEFAULT_READER_SESSION, hidden: { reasoning: true, tools: false } } });
  assert(((hidden['messages'] as JsonObject[])[0]!['blocks'] as JsonObject[]).every(b => b['category'] === 'content'));
  assert.deepEqual(output, original);
});

test('official summary-only placeholder fences never duplicate already retained processes; authored or unbacked text survives', () => {
  const placeholder = '\n```\nThis block is not supported on your current device yet.\n```\n\n';
  const run = (sender: string, content: JsonObject[], text = placeholder) => {
    const record = { uuid: 'placeholder', chat_messages: [{ uuid: 'm', sender, text, content }] };
    return messages(extractClaudeRecord({ record, source }).parsed.draft)[0]!['content'] as JsonObject[];
  };
  const thinking = { type: 'thinking', thinking: 'Real captured thought\nsecond line' };
  const output = run('assistant', [thinking], placeholder + placeholder);
  assert.equal(output.length, 1); assert.equal(output[0]!['text'], thinking.thinking);
  assert.equal(run('assistant', [{ type: 'text', text: placeholder }])[0]!['text'], placeholder);
  assert.equal(run('human', [thinking])[0]!['text'], placeholder);
  assert.equal(run('assistant', [])[0]!['text'], placeholder);
  assert.equal(run('assistant', [thinking], placeholder + 'Actual prose')[0]!['text'], placeholder + 'Actual prose');
  assert.equal(run('assistant', [thinking], placeholder.repeat(500) + 'Actual prose')[0]!['text'], placeholder.repeat(500) + 'Actual prose');
});

test('source-empty counts remain distinct from a hidden process or a paged/selected view', () => {
  const record: JsonObject = { uuid: 'empty', chat_messages: [{ uuid: 'u', sender: 'human', text: '', content: [] },
    { uuid: 'a', sender: 'assistant', parent_message_uuid: 'u', text: '', content: [] },
    { uuid: 'b', sender: 'assistant', parent_message_uuid: 'u', text: '', content: [] }] };
  const build = () => prepareRecordConversationView({ conversation: assembleConversationRecord({ ...extractClaudeRecord({ record, source }), parserVersion: '1.1.18', timestamp: '2026-09-28T12:00:00Z' }), resolved });
  const page = build().page(request), counts = page['pagination'] as JsonObject;
  assert.equal(counts['total_canonical'], 3); assert.equal(counts['empty_messages'], 3); assert.equal(counts['total_contentful'], 0);
  assert.equal(((page['branch'] as JsonObject)['leaves'] as JsonObject)['total'], 2);
  assert.equal((page['messages'] as JsonObject[]).length, 0);
  (record['chat_messages'] as JsonObject[])[2]!['content'] = [{ type: 'thinking', thinking: 'Real process' }];
  const hidden = build().page({ ...request, session: { ...DEFAULT_READER_SESSION, hidden: { reasoning: true, tools: true } } });
  const hiddenCounts = hidden['pagination'] as JsonObject;
  assert.equal(hiddenCounts['total_visible'], 0); assert.equal(hiddenCounts['total_contentful'], 1); assert.equal(hiddenCounts['empty_messages'], 2);
});
