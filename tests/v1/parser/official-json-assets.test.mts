import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { officialAssetLeaf, officialAssetDirectory, embedOfficialResources, officialResourceKey, officialCompanionBytes } from '../../../src/adapters/parser/official-json-assets.mts';
import { extractGrokOfficial } from '../../../src/adapters/parser/grok-official.mts';
import { extractMistralOfficial } from '../../../src/adapters/parser/mistral-official.mts';
import { assembleConversationRecord } from '../../../src/app/parser/conversation-record.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';

test('native attachment bytes become self-contained resources without reading other paths or fetching URLs', async () => {
  const base = path.resolve('tests/private/platform-json-20260928'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'assets-')); let passed = false;
  try {
    const sourcePath = 'Inbox/native.json', directory = path.join(root, officialAssetDirectory(sourcePath)); await mkdir(directory, { recursive: true });
    const key = '12345678-1234-1234-1234-123456789012', png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jUioAAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(directory, officialAssetLeaf('grok', key)), png);
    assert.equal(await officialCompanionBytes(root, sourcePath), png.length);
    const source = { file: 'native.json', bytes: 100, sha256: 'a'.repeat(64) };
    const grok = extractGrokOfficial({ source, record: { conversation: { id: 'c' }, responses: [{ response: { _id: 'u', sender: 'human', message: 'Picture', file_attachments: [key, key] } }] } });
    const enriched = await embedOfficialResources(grok, root, sourcePath, 'grok');
    const out = assembleConversationRecord({ ...enriched, parserVersion: '1.1.18', timestamp: '2026-09-28T12:00:00Z' });
    const resource = (out['resources'] as JsonObject[])[0]!;
    assert.equal((out['resources'] as JsonObject[]).length, 1, 'one byte payload, both source occurrences retained');
    assert.equal((((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['content'] as JsonObject[]).filter(b => b['type'] === 'image' && b['resource'] === resource['id']).length, 2);
    assert.equal(resource['availability'], 'embedded'); assert.equal(resource['mime'], 'image/png'); assert.equal(resource['sha256'], createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(Buffer.from((resource['data_base64'] as string[]).join(''), 'base64'), png);
    assert.equal((((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['content'] as JsonObject[])[1]!['type'], 'image');
    const body = Buffer.from('Original\nattachment\n'); await writeFile(path.join(directory, officialAssetLeaf('mistral', 'notes.txt')), body);
    assert.equal(await officialCompanionBytes(root, sourcePath), png.length + body.length);
    const mistral = extractMistralOfficial({ source, records: [{ id: 'u', version: 0, chatId: 'c', role: 'user', content: 'Read', files: [{ name: 'notes.txt', type: 'text' }] }] });
    await embedOfficialResources(mistral, root, sourcePath, 'mistral');
    assert.equal((mistral.parsed.draft['resources'] as JsonObject[])[0]!['availability'], 'embedded');
    assert.equal(officialResourceKey('mistral', { name: '../outside.txt' }), undefined);
    assert.throws(() => officialAssetDirectory('Conversations/source.json')); assert.throws(() => officialAssetDirectory('Inbox/../outside.json'));
    assert.notEqual(officialAssetLeaf('grok', key), officialAssetLeaf('mistral', key)); passed = true;
  } finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained asset test: ${root}`); }
});
