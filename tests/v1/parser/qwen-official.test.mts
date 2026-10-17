import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { extractQwenOfficial } from '../../../src/adapters/parser/qwen-official.mts';
import { assembleConversationRecord } from '../../../src/app/parser/conversation-record.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
const source = { file: 'qwen.json', bytes: 100, sha256: 'a'.repeat(64) };
const make = (record: JsonObject) => assembleConversationRecord({ ...extractQwenOfficial({ record, source }), parserVersion: '1.1.18', timestamp: '2026-09-28T12:00:00Z' });
test('Qwen uses the full history, content_list answers, separate summaries, explicit model and file evidence', () => {
  const out = make({ id: 'chat', title: 'Native', chat: { history: { currentId: 'b', messages: {
    u: { id: 'u', role: 'user', models: ['selected-not-authorship'], content: 'A\nB', files: [{ name: 'x.pdf', size: 10, type: 'file' }] },
    a: { id: 'a', parentId: 'u', role: 'assistant', modelName: 'Qwen', content: '', content_list: [
      { phase: 'thinking_summary', extra: { summary_title: { content: ['Summary one', 'Summary two'] }, summary_thought: { content: ['Thought one', 'Thought two'] } } },
      { phase: 'web_search', extra: { web_search_info: [{ title: 'Result', url: 'https://example.com' }] } }, { phase: 'answer', content: 'Answer\nline' }] },
    b: { id: 'b', parentId: 'u', role: 'assistant', model: 'native-model', content: 'Alternate' }
  } }, messages: [] } });
  const rows = (out['messages'] as JsonObject)['items'] as JsonObject[];
  assert.equal(rows.length, 3); assert.equal((out['messages'] as JsonObject)['current'], 'b');
  assert.deepEqual((rows[1]!['content'] as JsonObject[]).map(b => b['type']), ['reasoning_summary', 'reasoning_summary', 'search', 'markdown']);
  assert.equal((rows[1]!['content'] as JsonObject[])[3]!['text'], 'Answer\nline'); assert.deepEqual(out['models'], ['Qwen', 'native-model']);
  assert.equal((out['resources'] as JsonObject[])[0]!['name'], 'x.pdf');
});
test('real Qwen export keeps all messages and every explicit parent, not merely the current path', { skip: !process.env['CLOUDIG_QWEN_OFFICIAL'] }, async () => {
  const raw = JSON.parse(await readFile(process.env['CLOUDIG_QWEN_OFFICIAL']!, 'utf8')); let count = 0;
  for (const record of raw.data) {
    const out = make(record), rows = (out['messages'] as JsonObject)['items'] as JsonObject[];
    assert.equal(rows.length, Object.keys(record.chat.history.messages).length); count += rows.length;
    for (const row of rows) {
      const native = record.chat.history.messages[String(row['id'])]; assert.equal(row['parent'], native.parentId ?? undefined);
      if (native.error?.details) assert((row['content'] as JsonObject[]).some(b => b['type'] === 'status' && String(b['text']).includes(native.error.details)));
    }
    assert.equal((out['messages'] as JsonObject)['current'], record.chat.history.currentId);
  }
  assert.equal(count, 398); console.log(JSON.stringify({ qwenRecords: raw.data.length, nodes: count }));
});
test('Qwen native failure text is source content, not a Parser diagnostic or an empty message', () => {
  const out = make({ id: 'c', chat: { history: { messages: { a: { id: 'a', role: 'assistant', content: '', error: { code: 'internal_error', details: 'Native failure\nDetail' } } } } } });
  const blocks = (((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['content']) as JsonObject[];
  assert.deepEqual(blocks, [{ type: 'status', title: 'Qwen', text: 'internal_error\nNative failure\nDetail' }]);
});
test('Qwen public search arguments and observations are not reduced to a list of links', () => {
  const out = make({ id: 'c', chat: { history: { messages: { a: { id: 'a', role: 'assistant', content: '', content_list: [
    { phase: 'web_search', function_id: 'call1', function_call: { name: 'web_search', arguments: '{"queries":["Example"]}' }, extra: { tool_result: { docs: ['Observed'], tool_observation: 'Done' }, web_search_info: [{ url: 'https://example.com' }] } }
  ] } } } } });
  const blocks = (((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['content']) as JsonObject[];
  assert.deepEqual(blocks.map(b => b['type']), ['tool', 'search']); assert.equal(blocks[0]!['input'], '{"queries":["Example"]}');
  assert.deepEqual(blocks[0]!['output'], { docs: ['Observed'], tool_observation: 'Done' });
});
