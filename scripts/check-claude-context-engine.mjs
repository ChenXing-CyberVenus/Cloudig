import assert from 'node:assert/strict';
import { mkdir, copyFile, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { startRecordEngine } from './record-engine-client.mjs';
import { claudeRecordSelector } from '../src/adapters/parser/claude-export-record.mts';
import { fingerprintFile } from '../src/adapters/storage/stream.mts';

const [sourceArg, outputArg] = process.argv.slice(2);
assert(sourceArg && outputArg);
const source = path.resolve(sourceArg), out = path.resolve(outputArg), base = path.resolve('artifacts/v1-visual-audit');
assert.equal(path.dirname(out), base); await mkdir(out, { recursive: false });
const root = path.join(out, 'Library'); await mkdir(root);
const fingerprint = await fingerprintFile(source), originals = JSON.parse(await readFile(source, 'utf8'));
const bundle = JSON.parse(await readFile('src/adapters/parser/contracts/adapters.json', 'utf8'));
const selected = originals.find(r => r.chat_messages.some(m => m.content?.some(b => b.type === 'injected_prompt_block')));
const flagged = originals.find(r => r.chat_messages.some(m => m.content?.some(b => b.type === 'flag')));
const untitled = originals.find(r => !r.name && r.chat_messages.length);
assert(selected && flagged && untitled);
const engine = startRecordEngine({ packageRoot: path.resolve('artifacts/v1-desktop/app'), libraryRoot: root });
let report;
try {
  await engine.request('library.create');
  await copyFile(source, path.join(root, 'Inbox/conversations.json'));
  const sources = await engine.request('archiver.sources.query', { offset: 0, limit: 200 });
  const indexed = await engine.request('archiver.claude.index', { source: sources.items[0].capability });
  const records = await engine.request('archiver.claude.records.query', { container: indexed.container, offset: 0, limit: 200 });
  assert.equal(records.total, originals.length);
  const emptyRow = records.items.find(row => row.selector === claudeRecordSelector(untitled.uuid));
  assert.equal(emptyRow.empty_messages, untitled.chat_messages.length); assert.equal(emptyRow.messages, untitled.chat_messages.length);
  const preview = await engine.request('archiver.claude.extract.preview', { container: indexed.container, selectors: [claudeRecordSelector(selected.uuid)] });
  const result = await engine.request('archiver.claude.extract.commit', { plans: [preview.plan] });
  assert.equal(result.completed, 1, JSON.stringify(result));
  const record = JSON.parse(await readFile(path.join(root, result.items[0].path), 'utf8'));
  assert.equal(record.parser.version, bundle.parser); assert.equal(record.parser.adapter.version, bundle.adapters.find(a => a.id === 'anthropic-claude-export-json').version);
  const blocks = record.messages.items.flatMap(m => m.content).filter(b => b.type === 'status' && b.title?.startsWith('Claude '));
  const prompts = selected.chat_messages.flatMap(m => m.content ?? []).filter(b => b.type === 'injected_prompt_block').map(b => b.prompt).sort();
  assert.deepEqual(blocks.map(b => b.text).sort(), prompts);
  for (const block of blocks) assert.equal(record.identity.find(f => f.source_id === block.speaker)?.role, 'system');
  const extract = async row => {
    const next = await engine.request('archiver.claude.extract.preview', { container: indexed.container, selectors: [claudeRecordSelector(row.uuid)] });
    const result = await engine.request('archiver.claude.extract.commit', { plans: [next.plan] });
    assert.equal(result.completed, 1, JSON.stringify(result));
    return { path: result.items[0].path, record: JSON.parse(await readFile(path.join(root, result.items[0].path), 'utf8')) };
  };
  const flagResult = await extract(flagged), flagOutput = flagResult.record.messages.items.flatMap(m => m.content).filter(b => b.title === 'Claude platform flag');
  assert(!JSON.stringify(flagResult.record.messages.items).includes('This block is not supported on your current device yet.'));
  const expectedFlags = flagged.chat_messages.flatMap(m => m.content ?? []).filter(b => b.type === 'flag');
  assert.equal(flagOutput.length, expectedFlags.length);
  for (const block of flagOutput) {
    assert.equal(flagResult.record.identity.find(f => f.source_id === block.speaker)?.role, 'system');
    assert.deepEqual(JSON.parse(block.text).helpline, expectedFlags[0].helpline);
  }
  const first = await extract(untitled), second = await extract(untitled);
  assert.equal(first.record.title, undefined); assert.equal(second.record.title, undefined);
  assert.equal(second.record.messages.items.length, untitled.chat_messages.length); assert(second.record.messages.items.every(m => m.content.length === 0));
  assert.equal(first.path, second.path); assert.equal(first.record.conversation_id, second.record.conversation_id);
  assert.equal(first.record.lifecycle.first_parsed_at, second.record.lifecycle.first_parsed_at);
  assert.deepEqual(await fingerprintFile(source), fingerprint);
  report = { source: fingerprint, indexed: records.total, parsed: 3, writes: 4, messages: record.messages.items.length, prompts: blocks.length, flags: flagOutput.length, flagDetailsExact: true, placeholderFallbackAbsent: true, sourceEmpty: { messages: emptyRow.messages, empty_messages: emptyRow.empty_messages, branches: emptyRow.branches }, untitledReparseSameIdentity: true, systemSpeakers: true, promptBytesExact: true, parser: record.parser, sourceUnchanged: true };
} finally { await engine.close(); }
await writeFile(path.join(out, 'engine-evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
assert.equal(path.dirname(await realpath(root)), await realpath(out)); assert.equal((await lstat(root)).isSymbolicLink(), false);
await rm(root, { recursive: true });
console.log(JSON.stringify({ ...report, ownedLibraryRetired: true }));
