import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractMistralOfficial } from '../../../src/adapters/parser/mistral-official.mts';
import { assembleConversationRecord } from '../../../src/app/parser/conversation-record.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
import { conversationMessagePath } from '../../../src/app/reader/view-model-core.mts';
const make = (records: JsonObject[], file = 'chat.json') => assembleConversationRecord({ ...extractMistralOfficial({ records, source: { file, bytes: 100, sha256: 'a'.repeat(64) } }), parserVersion: '1.1.18', timestamp: '2026-09-28T12:00:00Z' });
test('Mistral keeps message revisions and repeated occurrences, separates thought from text, never invents a native branch', () => {
  const u = { id: 'u', chatId: 'c', version: 0, role: 'user', content: 'One\nTwo', createdAt: '2026-01-01T00:00:00Z' };
  const out = make([{ id: 'a', chatId: 'c', version: 0, role: 'assistant', content: 'ThoughtAnswer', contentChunks: [{ type: 'text', text: 'Thought', _context: { type: 'reasoning' } }, { type: 'text', text: 'Answer' }], createdAt: '2026-01-01T00:00:01Z' }, u, { ...u, version: 1, content: 'Edited', createdAt: '2026-01-01T00:01:00Z' }, u]);
  const rows = (out['messages'] as JsonObject)['items'] as JsonObject[];
  assert.equal(rows.length, 4); assert.equal(new Set(rows.map(m => m['id'])).size, 4);
  assert.deepEqual(rows.map(m => JSON.parse(String(m['id']))), [['u', 0, 1], ['u', 0, 2], ['a', 0, 1], ['u', 1, 1]]);
  assert.deepEqual((rows[2]!['content'] as JsonObject[]).map(b => b['type']), ['reasoning', 'markdown']);
  assert.equal((out['limitations'] as JsonObject[])[0]!['code'], 'official_branch_graph_unavailable'); assert.equal(out['models'], undefined);
  assert.deepEqual(out['title'], { filename: 'chat' }, 'a source filename is not an invented native platform title');
  assert(rows.every(m => !Object.hasOwn(m, 'parent')));
  const reading = conversationMessagePath({ messages: rows }); assert.equal(reading.path.length, 4); assert.equal(reading.controls.size, 0);
});
test('all private Mistral exports retain their full message-version occurrence counts', { skip: !process.env['CLOUDIG_MISTRAL_OFFICIAL'] }, async () => {
  const directory = process.env['CLOUDIG_MISTRAL_OFFICIAL']!; let count = 0, files = 0;
  for (const file of (await readdir(directory)).filter(n => n.startsWith('chat-') && n.endsWith('.json'))) {
    const original = JSON.parse(await readFile(path.join(directory, file), 'utf8')), out = make(original, file), rows = (out['messages'] as JsonObject)['items'] as JsonObject[];
    assert.equal(rows.length, original.length); assert.equal(new Set(rows.map(m => m['id'])).size, rows.length); count += rows.length; files++;
    const keys = original.map((m: any) => JSON.stringify([m.id, m.version])).sort();
    assert.deepEqual(rows.map(m => JSON.stringify(JSON.parse(String(m['id'])).slice(0, 2))).sort(), keys);
  }
  assert.equal(count, 385); assert.equal(files, 4); console.log(JSON.stringify({ mistralRecords: files, nodes: count }));
});
test('Mistral public tool results resolve native citation IDs instead of displaying opaque IDs', () => {
  const result = { native1: { url: 'https://example.com', title: 'Evidence', snippets: ['First', 'Second'] } };
  const out = make([{ id: 'a', version: 0, chatId: 'c', role: 'assistant', content: 'Answer', contentChunks: [
    { type: 'tool_call', id: 'call1', name: 'web_search', publicArguments: 'Query', publicResult: result },
    { type: 'text', text: 'Answer' }, { type: 'reference', referenceIds: ['native1'] }
  ] }]);
  const blocks = (((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['content']) as JsonObject[];
  assert.deepEqual(blocks[0]!['output'], result); assert.equal((out['references'] as JsonObject[])[0]!['url'], 'https://example.com');
  assert.deepEqual(blocks.at(-1)!['references'], ['s1']);
});
