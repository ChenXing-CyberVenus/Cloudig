import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { extractGrokOfficial } from '../../../src/adapters/parser/grok-official.mts';
import { assembleConversationRecord } from '../../../src/app/parser/conversation-record.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
const source = { file: 'grok.json', bytes: 100, sha256: 'a'.repeat(64) };
const make = (record: JsonObject) => assembleConversationRecord({ ...extractGrokOfficial({ record, source }), parserVersion: '1.1.18', timestamp: '2026-09-28T12:00:00Z' });
test('Grok native response tree, process, inline image card, source errors and explicit model are retained', () => {
  const out = make({ conversation: { id: 'c', title: 'Native', leaf_response_id: 'b' }, responses: [
    { response: { _id: 'u', sender: 'human', message: 'First\nSecond', create_time: { $date: { $numberLong: '1780000000000' } } } },
    { response: { _id: 'a', parent_response_id: 'u', sender: 'assistant', model: 'grok-4', message: 'Answer<grok:render card_id="image"></grok:render>After', steps: [{ tag_order: ['header'], tagged_text: { header: 'Thinking' } }], card_attachments_json: [JSON.stringify({ id: 'image', type: 'render_generated_image', image_chunk: { imageUrl: 'https://example.com/image.jpg' } })] } },
    { response: { _id: 'b', parent_response_id: 'u', sender: 'ASSISTANT', message: '', error: 'Failed to respond.' } }
  ] });
  const rows = (out['messages'] as JsonObject)['items'] as JsonObject[];
  assert.equal(rows.length, 3); assert.equal((out['messages'] as JsonObject)['current'], 'b'); assert.equal(rows[2]!['parent'], 'u');
  assert.deepEqual((rows[1]!['content'] as JsonObject[]).map(b => b['type']), ['reasoning_summary', 'markdown', 'image', 'markdown']);
  assert.equal((rows[0]!['content'] as JsonObject[])[0]!['text'], 'First\nSecond'); assert.deepEqual(out['models'], ['grok-4']);
  assert.equal((rows[2]!['content'] as JsonObject[])[0]!['text'], 'Failed to respond.');
});
test('Grok legacy and typed citation/image cards become readable references and image metadata', () => {
  const out = make({ conversation: { id: 'c' }, responses: [{ response: { _id: 'a', sender: 'assistant', message: 'Answer<grok:render card_id="ref"></grok:render>After', card_attachments_json: [
    JSON.stringify({ id: 'ref', cardType: 'citation_card', url: 'https://example.com/source' }),
    JSON.stringify({ id: 'image', type: 'render_searched_image', cardType: 'image_card', caption: 'Caption', image: { original: 'https://example.com/image.png', title: 'Image title', link: 'https://example.com/page' } })
  ] } }] });
  const blocks = (((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['content']) as JsonObject[];
  assert.deepEqual(blocks.map(b => b['type']), ['markdown', 'citations', 'markdown', 'image', 'citations']);
  assert.equal(blocks[3]!['alt'], 'Caption'); assert.equal((out['resources'] as JsonObject[])[0]!['availability'], 'metadata_only');
  assert.deepEqual((out['references'] as JsonObject[]).map(r => r['url']), ['https://example.com/source', 'https://example.com/page']);
});
test('full private Grok export preserves every native response and parent', { skip: !process.env['CLOUDIG_GROK_OFFICIAL'] }, async () => {
  const raw = JSON.parse(await readFile(process.env['CLOUDIG_GROK_OFFICIAL']!, 'utf8')); let count = 0;
  for (const record of raw.conversations) {
    const out = make(record), rows = (out['messages'] as JsonObject)['items'] as JsonObject[], original = new Map(record.responses.map((r: any) => [r.response._id, r.response]));
    assert.equal(rows.length, record.responses.length); count += rows.length;
    for (const row of rows) assert.equal(row['parent'], (original.get(row['id']) as any).parent_response_id || undefined);
  }
  assert.equal(count, 8213); console.log(JSON.stringify({ grokRecords: raw.conversations.length, nodes: count }));
});
