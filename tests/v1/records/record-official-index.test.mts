import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile, readdir, readFile, copyFile, realpath, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRecordLibrary } from '../../../src/adapters/library-data/record-library.mts';
import { RecordArchiverEngineCommands } from '../../../src/engine/record-archiver-commands.mts';
import { indexRecordOfficialContainer } from '../../../src/adapters/parser/record-official-index.mts';
import { assertIpcValue } from '../../../src/engine/protocol.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
import { collectOfficialCompanions, officialAssetDirectory, officialAssetLeaf } from '../../../src/adapters/parser/official-json-assets.mts';
const base = path.resolve('tests/private/platform-json-20260928'), timestamp = '2026-09-28T12:00:00Z';
const obj = (v: unknown) => v as JsonObject;
const items = (v: JsonObject) => v['items'] as JsonObject[];
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'official-')); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: '2026-09-28', offset: 'Z' } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained official test: ${root}`); }
}
test('official DeepSeek index, preview, worker, commit and per-record status use the same Engine pipeline', () => temporary(async root => {
  const fixture = [{ id: 'c1', title: 'Imported original', mapping: { root: { id: 'root', parent: null, message: null }, u: { id: 'u', parent: 'root', message: { fragments: [{ type: 'REQUEST', content: 'First\nSecond' }] } }, a: { id: 'a', parent: 'u', message: { model: 'deepseek-reasoner', fragments: [{ type: 'THINK', content: 'Think' }, { type: 'RESPONSE', content: 'Answer' }] } } } }];
  await writeFile(path.join(root, 'Inbox/renamed.json'), JSON.stringify(fixture));
  const engine = new RecordArchiverEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, 'cache'), clock: () => timestamp });
  const call = async (name: string, payload: JsonObject) => {
    const value = await engine.handlers()[name]!(payload, { request: 'official-test', signal: new AbortController().signal, emit: async e => { assertIpcValue(e); } }); assertIpcValue(value); return obj(value);
  };
  try {
    const source = items(await call('archiver.sources.query', { offset: 0, limit: 200 }))[0]!;
    assert.equal(source['platform'], 'deepseek'); assert.equal(obj(source['adapter'])['id'], 'deepseek-official-json');
    const index = await call('archiver.claude.index', { source: source['capability']! });
    const query = await call('archiver.claude.records.query', { container: index['container']!, offset: 0, limit: 200 });
    assert.equal(query['total'], 1); assert.equal(items(query)[0]!['messages'], 2); assert.equal(items(query)[0]!['empty_messages'], 0);
    const preview = await call('archiver.claude.extract.preview', { container: index['container']!, selectors: [items(query)[0]!['selector']!] });
    assert.equal(preview['total'], 1); assert.deepEqual(await readdir(path.join(root, 'Conversations')), []);
    const result = await call('archiver.claude.extract.commit', { plans: [preview['plan']!] });
    assert.equal(result['completed'], 1, JSON.stringify(result)); assert.equal(result['failed'], 0);
    const file = items(result)[0]!['path']; const value = JSON.parse(await readFile(path.join(root, String(file)), 'utf8'));
    assert.equal(value.platform, 'deepseek'); assert.equal(value.messages.items[1].content[0].text, 'First\nSecond'); assert.equal(value.messages.items[2].parent, 'u');
    assert.equal(value.parser.adapter.id, 'deepseek-official-json'); assert.equal(value.content_time, undefined);
    const after = await call('archiver.claude.records.query', { container: index['container']!, offset: 0, limit: 200 }); assert.equal(items(after)[0]!['status'], 'parsed');
    assert.equal((await indexRecordOfficialContainer(root, 'Inbox/renamed.json')).reused, true);
  } finally { await engine.close(); }
}));
test('official index refuses duplicate native conversation IDs instead of merging records', () => temporary(async root => {
  const r = { id: 'duplicate', mapping: { root: { message: null } } };
  await writeFile(path.join(root, 'Inbox/duplicates.json'), JSON.stringify([r, r]));
  await assert.rejects(indexRecordOfficialContainer(root, 'Inbox/duplicates.json'), /duplicate/);
}));
test('real DeepSeek source indexes all native conversations and reuses its saved projection', { skip: !process.env['CLOUDIG_DEEPSEEK_OFFICIAL'] }, () => temporary(async root => {
  await copyFile(process.env['CLOUDIG_DEEPSEEK_OFFICIAL']!, path.join(root, 'Inbox/native.json'));
  const { index } = await indexRecordOfficialContainer(root, 'Inbox/native.json');
  assert.equal(index.records.length, 20); assert.equal(index.records.reduce((n, r) => n + Number(r['messages']), 0), 2922);
  assert.equal((await indexRecordOfficialContainer(root, 'Inbox/native.json')).reused, true);
}));

test('private four-platform exports pass real Engine indexing and selected-record worker commits', { skip: !process.env['CLOUDIG_OFFICIAL_INVENTORY'] }, async () => {
  const inventory = JSON.parse(await readFile(process.env['CLOUDIG_OFFICIAL_INVENTORY']!, 'utf8')) as Record<string, { file: string }>;
  for (const [key, input] of Object.entries(inventory)) await temporary(async root => {
    const filename = path.basename(input.file); await copyFile(input.file, path.join(root, 'Inbox', filename));
    const companions = await collectOfficialCompanions(input.file); let copiedAssets = 0, embeddedResources = 0;
    for (const assetKey of companions.keys) {
      const original = companions.platform === 'grok' ? path.join(path.dirname(input.file), 'prod-mc-asset-server', assetKey, 'content') : path.join(path.dirname(input.file), path.parse(input.file).name + '-files', assetKey);
      const info = await lstat(original).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; }); if (!info) continue;
      assert(info.isFile() && !info.isSymbolicLink());
      const directory = path.join(root, officialAssetDirectory('Inbox/' + filename)); await mkdir(directory, { recursive: true });
      await copyFile(original, path.join(directory, officialAssetLeaf(companions.platform, assetKey))); copiedAssets++;
    }
    const engine = new RecordArchiverEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, 'cache'), clock: () => timestamp });
    const call = async (name: string, payload: JsonObject) => obj(await engine.handlers()[name]!(payload, { request: 'private-official', signal: new AbortController().signal, emit: async e => { assertIpcValue(e); } }));
    try {
      const started = performance.now(), source = items(await call('archiver.sources.query', { offset: 0, limit: 200 }))[0]!;
      assert.equal(source['platform'], key.split(':')[0]);
      const index = await call('archiver.claude.index', { source: source['capability']! });
      const query = await call('archiver.claude.records.query', { container: index['container']!, offset: 0, limit: 200 });
      const rows = items(query), preview = await call('archiver.claude.extract.preview', { container: index['container']!, selectors: rows.map(r => r['selector']!) });
      assert.equal(preview['total'], rows.length);
      const result = await call('archiver.claude.extract.commit', { plans: [preview['plan']!] });
      assert.equal(result['failed'], 0, JSON.stringify(result)); assert.equal(result['completed'], rows.length);
      for (const item of items(result)) { const record = JSON.parse(await readFile(path.join(root, String(item['path'])), 'utf8')); embeddedResources += (record.resources ?? []).filter((r: any) => r.availability === 'embedded').length; }
      if (copiedAssets) assert(embeddedResources > 0, 'companion bytes must enter Conversation resources');
      const after = await call('archiver.claude.records.query', { container: index['container']!, offset: 0, limit: 200 });
      assert(items(after).every(r => r['status'] === 'parsed')); assert.equal((await readdir(path.join(root, 'Conversations'))).length, rows.length);
      console.log(JSON.stringify({ source: key, records: rows.length, messages: rows.reduce((n, r) => n + Number(r['messages']), 0), copiedAssets, embeddedResources, failed: result['failed'], ms: Math.round(performance.now() - started) }));
    } finally { await engine.close(); }
  });
});
