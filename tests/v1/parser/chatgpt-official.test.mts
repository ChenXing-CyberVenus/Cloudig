import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
import { extractChatGptOfficial } from '../../../src/adapters/parser/chatgpt-official.mts';
import { assembleConversationRecord } from '../../../src/app/parser/conversation-record.mts';
import { conversationMessagePath } from '../../../src/app/reader/view-model-core.mts';
import { createRecordLibrary } from '../../../src/adapters/library-data/record-library.mts';
import { scanRecordSources } from '../../../src/adapters/library-data/record-parse-status.mts';
import { indexRecordOfficialContainer, extractIndexedOfficialRecord } from '../../../src/adapters/parser/record-official-index.mts';
import { inspectOfficialZip } from '../../../src/adapters/parser/official-zip.mts';
import { RecordArchiverEngineCommands } from '../../../src/engine/record-archiver-commands.mts';
import { fixtureZip } from './zip-fixture.mts';

const timestamp = '2026-09-28T22:00:00Z';
const source = { file: 'conversations-000.json', sha256: 'a'.repeat(64), bytes: 100 };
function fixture(): JsonObject {
  const m = (role: string, content: JsonObject, metadata: JsonObject = {}): JsonObject => ({ author: { role }, content, metadata, create_time: 1780000000, recipient: 'all' });
  return { id: 'conversation', conversation_id: 'conversation', title: 'Native title', current_node: 'u', default_model_slug: 'DO NOT ATTRIBUTE', create_time: 1780000000, update_time: 1780000001,
    mapping: {
      a: { id: 'a', parent: 'u', children: [], message: m('assistant', { content_type: 'text', parts: ['First\n\nAnswer\n```mermaid\ngraph TD; A-->B\n```'] }, { model_slug: 'gpt-test', generated_file_id: 'file-restored' }) },
      root: { id: 'root', parent: null, children: ['u'], message: null },
      u: { id: 'u', parent: 'root', children: ['b', 'a'], message: m('user', { content_type: 'multimodal_text', parts: ['line one\nline two', { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-image', width: 1, height: 1 }] }, { attachments: [{ id: 'file-image', name: 'pixel.png', mime_type: 'image/png' }] }) },
      b: { id: 'b', parent: 'u', children: ['recap'], message: m('assistant', { content_type: 'thoughts', thoughts: [{ summary: 'A thought', content: 'Thinking body', chunks: [] }] }) },
      recap: { id: 'recap', parent: 'b', children: [], message: m('assistant', { content_type: 'reasoning_recap', content: '思考了 2 秒' }) }
    }
  };
}
const assemble = (record: JsonObject) => assembleConversationRecord({ ...extractChatGptOfficial({ record, source }), parserVersion: '1.1.21', timestamp });
test('DIL is a source-preserving static Box at its original marker, not a citation or a trailing code dump', () => {
  const record = fixture(), mapping = record['mapping'] as JsonObject, message = (mapping['a'] as JsonObject)['message'] as JsonObject;
  const card = { type: 'dil', name: 'suggest_automation', matched_text: 'genuix', dil: { type: 'Basic', initialState: { label: 'Watch the stars' }, $onVisibleAction: 'do not run', children: [] } };
  message['metadata'] = { content_references: [card] }; message['content'] = { content_type: 'text', parts: ['Before\n\ngenuix\n\nAfter'] };
  const result = assemble(record), blocks = ((result['messages'] as JsonObject)['items'] as JsonObject[]).at(-1)!['content'] as JsonObject[];
  assert.deepEqual(blocks.map(b => b['type']), ['markdown', 'interactive', 'markdown']);
  assert.equal(result['schema'], 'cloudig/conversation/1.0.1');
  assert.equal(blocks[1]!['source'], 'chatgpt.com_dil'); assert.deepEqual(blocks[1]!['data'], card);
  assert.equal(result['references'], undefined); assert.equal(result['limitations'], undefined);
  assert.match(String(blocks[0]!['text']), /Before/u); assert.match(String(blocks[2]!['text']), /After/u);
  message['content'] = { content_type: 'text', parts: ['No marker'] };
  const missing = (((assemble(record)['messages'] as JsonObject)['items'] as JsonObject[]).at(-1)!['content'] as JsonObject[]);
  assert.equal(missing.filter(b => b['type'] === 'interactive').length, 1, 'an absent marker must not discard the card');
});
test('ChatGPT native trees keep sibling order, internal current, empty root and per-message identity', () => {
  const r = assemble(fixture()), graph = r['messages'] as JsonObject, items = graph['items'] as JsonObject[], identity = r['identity'] as JsonObject[];
  assert.deepEqual(items.map(m => m['id']), ['root', 'u', 'b', 'recap', 'a']);
  assert.equal(graph['current'], 'u'); assert.equal(items[0]!['speaker'], undefined);
  assert.equal(JSON.stringify(r).includes('DO NOT ATTRIBUTE'), false);
  assert(identity.some(f => JSON.stringify(f['names']).includes('gpt-test')));
  assert(identity.some(f => JSON.stringify(f['names']).includes('ChatGPT')));
  assert.equal(((items[1]!['content'] as JsonObject[])[0]!)['text'], 'line one\nline two');
  assert.equal((items[1]!['content'] as JsonObject[]).filter(b => b['type'] === 'image' || b['type'] === 'attachment').length, 1);
  assert.equal((items[2]!['content'] as JsonObject[])[0]!['type'], 'reasoning_summary');
  assert.equal((items[3]!['content'] as JsonObject[])[0]!['type'], 'status');
  assert.equal((items[3]!['content'] as JsonObject[])[0]!['text'], undefined, 'elapsed-only status has no expandable body');
  const view = conversationMessagePath({ messages: items, current_message: graph['current']! });
  assert.deepEqual(view.path.map(i => items[i]!['id']), ['root', 'u', 'a'], 'an internal current must not truncate its descendants');
  assert.deepEqual(conversationMessagePath({ messages: items }, undefined, { u: 'b' }).path.map(i => items[i]!['id']), ['root', 'u', 'b', 'recap']);
  assert.equal((r['resources'] as JsonObject[]).length, 1);
});
test('native references render supplied alternatives; system/tool identity and unknown data are retained', () => {
  const record = fixture(), mapping = record['mapping'] as JsonObject, message = (mapping['a'] as JsonObject)['message'] as JsonObject;
  message['content'] = { content_type: 'text', parts: ['Answer citex\nentityx'] };
  message['metadata'] = { content_references: [{ type: 'webpage', matched_text: 'citex', alt: '[Source](https://example.test)', url: 'https://example.test', title: 'Source' }, { type: 'entity', matched_text: 'entityx', name: 'Earth' }, { type: 'file', id: 'file-doc', name: 'Doc' }] };
  let result = assemble(record), serialized = JSON.stringify(result);
  assert(serialized.includes('[Source](https://example.test)')); assert(!serialized.includes('cite')); assert(serialized.includes('Earth'));
  message['author'] = { role: 'tool', name: 'python' }; message['content'] = { content_type: 'execution_output', text: '42' };
  result = assemble(record); assert((result['identity'] as JsonObject[]).some(f => f['role'] === 'tool' && (f['kind'] as JsonObject)['subject'] === 'program'));
  message['author'] = { role: 'system' }; message['content'] = { content_type: 'text', parts: ['System context'] };
  result = assemble(record); assert((result['identity'] as JsonObject[]).some(f => f['role'] === 'system'));
  message['content'] = { content_type: 'future-visible', text: 'Keep this payload' };
  assert(JSON.stringify(assemble(record)).includes('Keep this payload'));
  assert.equal(((assemble({ ...record, mapping: null, current_node: null })['messages'] as JsonObject)['items'] as unknown[]).length, 0);
  (mapping['root'] as JsonObject)['parent'] = 'a'; (mapping['a'] as JsonObject)['children'] = ['root'];
  assert.throws(() => assemble(record), /cycle/u);
});
const base = path.resolve('tests/private/schema-rebuild');
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'chatgpt-zip-')); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: '2026-09-28', offset: 'Z' } }); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained fixture: ${root}`); }
}

test('independent ChatGPT library images restore exact messages or remain unplaced without inventing graph nodes', () => temporary(async root => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  const file = (id: string, message: string, owner = 'conversation'): JsonObject => ({ file_id: id, mime_type: 'image/png', file_name: id + '.png', origination_thread_id: owner, origination_message_id: message, image_gen_generation_id: 'source-generation' });
  const data = zipBytes([{name:'library_files.json',data:JSON.stringify([
    file('file-restored','a'), file('file-unplaced','missing'), file('file-restored','a'), file('file-vector','u'),
    file('file-missing','a'), file('file-foreign','a','another'),
    {...file('file-conflict','a'),initiating_conversation_id:'another'},
    {file_id:'file-no-owner',mime_type:'image/png'}, {...file('../escape','a')}
  ])}, {name:'file-vector.dat',data:'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>'}, ...['file-restored','file-unplaced','file-foreign','file-conflict','file-no-owner'].map(id=>({name:id+'.dat',data:png}))]);
  await writeFile(path.join(root,'Inbox/library.zip'),data);
  const {index}=await indexRecordOfficialContainer(root,'Inbox/library.zip');
  const row=index.records[0]!, result=await extractIndexedOfficialRecord(root,index,String(row['selector']));
  const record=assembleConversationRecord({...result,parserVersion:'1.1.22',timestamp});
  const items=(record['messages'] as JsonObject)['items'] as JsonObject[], resources=record['resources'] as JsonObject[];
  assert.equal(items.length,Object.keys(fixture()['mapping'] as JsonObject).length,'no synthetic turn');
  const baseline=assembleConversationRecord({...extractChatGptOfficial({record:fixture(),source}),parserVersion:'1.1.22',timestamp});
  assert.deepEqual(items.map(m=>[m['id'],m['parent']]),((baseline['messages'] as JsonObject)['items'] as JsonObject[]).map(m=>[m['id'],m['parent']]));
  const restored=resources.find(r=>(r['original'] as JsonObject)?.['url']==='file-service://file-restored')!;
  const unplaced=resources.find(r=>(r['original'] as JsonObject)?.['url']==='file-service://file-unplaced')!;
  assert(restored&&unplaced); assert.equal(resources.filter(r=>r['id']===restored['id']).length,1);
  assert.equal(resources.find(r=>(r['original'] as JsonObject)?.['url']==='file-service://file-vector')?.['mime'],'image/svg+xml','actual SVG bytes, not DAT extension or incorrect source MIME');
  const vector=resources.find(r=>(r['original'] as JsonObject)?.['url']==='file-service://file-vector')!;
  assert(!items.some(m=>JSON.stringify(m['content']).includes(JSON.stringify(vector['id']))),'an existing origin node without its file reference is not placement proof');
  assert.equal((items.find(m=>m['id']==='a')!['content'] as JsonObject[]).filter(b=>b['resource']===restored['id']).length,1);
  assert(!items.some(m=>JSON.stringify(m['content']).includes(JSON.stringify(unplaced['id']))));
  assert(!JSON.stringify(resources).match(/file-(missing|foreign|conflict|no-owner)/));
  for(const r of [restored,unplaced]) {assert.equal(r['availability'],'embedded');assert.equal(r['sha256'],createHash('sha256').update(png).digest('hex'));}
  assert(index.schema==='cloudig/official-zip-index/1.0.0');
  assert(Number(index.resource_bytes_by_record?.[String(row['selector'])])>=png.length*3,'include library bytes in worker budget');
  assert.deepEqual(await readFile(path.join(root,'Inbox/library.zip')),data);
}));
function zipBytes(extraEntries: { name: string; data: string | Buffer }[] = []) {
  const second = fixture();
  const pool = second['mapping'] as JsonObject;
  delete pool['b']; delete pool['recap']; (pool['u'] as JsonObject)['children'] = ['a'];
  const records = [JSON.stringify([{}, fixture()]), JSON.stringify([{ ...second, id: 'second', conversation_id: 'second', title: 'Second' }, {}])];
  const names = ['conversations-000.json', 'conversations-001.json'];
  const manifest = { version: 1, logical_files: { 'conversations.json': { files: names, sharded: true, shard_count: 2 } }, export_files: names.map((name, i) => ({ path: name, size_bytes: Buffer.byteLength(records[i]!) })) };
  return fixtureZip([...names.map((name, i) => ({ name, data: records[i]! })), { name: 'export_manifest.json', data: JSON.stringify(manifest) },
    { name: 'file-image.dat', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') },
    { name: 'conversation_asset_file_names.json', data: '{"file-image.dat":"pixel.png"}' }, { name: 'user.json', data: '{"private":"NOT CONVERSATION CONTENT"}' }, ...extraEntries]);
}
test('complete ChatGPT ZIP merges shard listings, embeds bytes once and excludes account records', () => temporary(async root => {
  const bytes = zipBytes(); await writeFile(path.join(root, 'Inbox/chat.zip'), bytes);
  const rows = await scanRecordSources(root); assert.equal(rows[0]!.platform, 'chatgpt');
  const { index } = await indexRecordOfficialContainer(root, 'Inbox/chat.zip'); assert.equal(index.records.length, 2);
  assert.equal((await indexRecordOfficialContainer(root, 'Inbox/chat.zip')).reused, true);
  const extracted = await extractIndexedOfficialRecord(root, index, String(index.records[0]!['selector']));
  const record = assembleConversationRecord({ ...extracted, parserVersion: '1.1.21', timestamp });
  assert.equal((record['source'] as JsonObject)['sha256'], createHash('sha256').update(bytes).digest('hex'));
  assert.equal((record['title'] as JsonObject)['filename'], undefined); assert.equal((record['title'] as JsonObject)['original'], 'Native title');
  const resource = (record['resources'] as JsonObject[])[0]!; assert.equal(resource['availability'], 'embedded'); assert.equal(resource['mime'], 'image/png');
  const decoded = Buffer.concat((resource['data_base64'] as string[]).map(s => Buffer.from(s, 'base64'))); assert.equal(resource['sha256'], createHash('sha256').update(decoded).digest('hex'));
  assert(!JSON.stringify(record).includes('NOT CONVERSATION CONTENT')); assert.equal((record['resources'] as unknown[]).length, 1);
  assert.deepEqual(await readFile(path.join(root, 'Inbox/chat.zip')), bytes);
}));
test('mail export ZIP uses the same shard and attachment contract without importing extra account files', () => temporary(async root => {
  const privateMarker = 'EXTRA ACCOUNT DATA IS NOT A CONVERSATION';
  const bytes = zipBytes([
    ...['ads.json', 'user_settings.json', 'library_files.json', 'message_feedback.json', 'shared_conversations.json', 'sites/export_manifest.json']
      .map(name => ({ name, data: JSON.stringify({ text: privateMarker }) })),
    { name: 'chat.html', data: `<p>${privateMarker}</p>` },
    { name: 'file-unused.dat', data: privateMarker }
  ]);
  const source = `Inbox/${'a'.repeat(64)}-2026-09-28-04-14-32-00000000-0000-4000-8000-000000000000.zip`;
  await writeFile(path.join(root, source), bytes);
  const rows = await scanRecordSources(root); assert.equal(rows[0]!.platform, 'chatgpt');
  const { index } = await indexRecordOfficialContainer(root, source); assert.equal(index.records.length, 2);
  for (const item of index.records) {
    const extracted = await extractIndexedOfficialRecord(root, index, String(item['selector']));
    const record = assembleConversationRecord({ ...extracted, parserVersion: '1.1.22', timestamp });
    assert.equal((record['source'] as JsonObject)['file'], path.basename(source));
    assert.equal((record['resources'] as JsonObject[]).length, 1);
    assert.equal((record['resources'] as JsonObject[])[0]!['availability'], 'embedded');
    assert(!JSON.stringify(record).includes(privateMarker));
  }
  assert.deepEqual(await readFile(path.join(root, source)), bytes);
}));

test('manifest omissions, outer privacy ZIP and isolated ChatGPT JSON are not accepted as conversation ZIP', () => temporary(async root => {
  const file = path.join(root, 'Inbox/bad.zip');
  await writeFile(file, fixtureZip([{ name: 'User Online Activity/Conversations__inner.zip', data: zipBytes() }]));
  await assert.rejects(inspectOfficialZip(file), /内层|inner/u);
  await writeFile(file, fixtureZip([{ name: 'conversations-000.json', data: JSON.stringify([fixture()]) }]));
  await assert.rejects(inspectOfficialZip(file), /manifest/u);
  await writeFile(path.join(root, 'Inbox/shard.json'), JSON.stringify([fixture()]));
  await assert.rejects(indexRecordOfficialContainer(root, 'Inbox/shard.json'), /完整ChatGPT/u);
}));
test('ChatGPT ZIP passes the common Engine, worker and per-record reparse history', () => temporary(async root => {
  await writeFile(path.join(root, 'Inbox/chat.zip'), zipBytes());
  const engine = new RecordArchiverEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, 'cache'), clock: () => timestamp });
  const context = { request: 'chatgpt-zip', signal: new AbortController().signal, emit: async () => {} };
  const call = async (name: string, data: JsonObject) => await engine.handlers()[name]!(data, context) as JsonObject;
  try {
    const sources = await call('archiver.sources.query', { offset: 0, limit: 10 });
    const index = await call('archiver.claude.index', { source: (sources['items'] as JsonObject[])[0]!['capability']! });
    const container = index['container']!, rows = await call('archiver.claude.records.query', { container, offset: 0, limit: 10 });
    const selectors = (rows['items'] as JsonObject[]).map(r => r['selector']!);
    for (let i = 0; i < 2; i++) { const plan = await call('archiver.claude.extract.preview', { container, selectors }); const result = await call('archiver.claude.extract.commit', { plans: [plan['plan']!] }); assert.equal(result['failed'], 0, JSON.stringify(result)); assert.equal(result['completed'], 2); }
    assert.equal((await readdir(path.join(root, 'Conversations'))).length, 2);
    const after = await call('archiver.claude.records.query', { container, offset: 0, limit: 10 }); assert((after['items'] as JsonObject[]).every(r => r['status'] === 'parsed'));
  } finally { await engine.close(); }
}));
