import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprintFile } from '../src/adapters/storage/stream.mts';
import { extractClaudeRecord } from '../src/app/parser/record-source.mts';
import { assembleConversationRecord } from '../src/app/parser/conversation-record.mts';
import { validateRecord } from '../src/core/records/index.mts';
import type { JsonObject } from '../src/core/contracts/types.mts';
import { isDeepStrictEqual } from 'node:util';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw Error('Provide the readonly source and a new tests/private output directory');
const sourcePath = path.resolve(sourceArg), output = path.resolve(outputArg);
assert(output.startsWith(path.resolve('tests/private') + path.sep));
await mkdir(output, { recursive: false });
const fingerprint = await fingerprintFile(sourcePath), rows = JSON.parse(await readFile(sourcePath, 'utf8')) as JsonObject[];
const bundle = JSON.parse(await readFile('src/adapters/parser/contracts/adapters.json', 'utf8'));
let injected = 0, flags = 0, affected = 0, messages = 0, otherBlocks = 0, selected = false;
const kinds: Record<string, number> = {};
for (const row of rows) {
  const input = { record: row, source: { file: path.basename(sourcePath), ...fingerprint } };
  const result = extractClaudeRecord(input), systemBlocks = result.facts.blockSpeakers ?? new Map();
  const rawMessages = row['chat_messages'] as JsonObject[], allRaw = rawMessages.flatMap(m => Array.isArray(m['content']) ? m['content'] as JsonObject[] : []);
  const prompts = allRaw.filter(b => b['type'] === 'injected_prompt_block'), flagBlocks = allRaw.filter(b => b['type'] === 'flag');
  const actual = [...systemBlocks.keys()].filter(b => !['Claude platform flag', 'Claude token budget'].includes(String(b['title'])));
  assert.equal(actual.length, prompts.length);
  const actualFlags = [...systemBlocks.keys()].filter(b => b['title'] === 'Claude platform flag');
  assert.equal(actualFlags.length, flagBlocks.length);
  const remainingFlags = flagBlocks.map(({ type, start_timestamp, stop_timestamp, ...rest }) => rest);
  for (const block of actualFlags) {
    const index = remainingFlags.findIndex(raw => isDeepStrictEqual(raw, JSON.parse(String(block['text']))));
    assert(index >= 0, 'Flag details changed'); remainingFlags.splice(index, 1);
  }
  for (const facts of systemBlocks.values()) assert.equal(facts.role, 'system');
  // Parent-first order may differ from file order: compare exact text multisets.
  assert.deepEqual(actual.map(b => b['text']).sort(), prompts.map(b => b['prompt']).sort());
  for (const block of actual) assert.equal(block['type'], 'status');
  for (const block of prompts) kinds[String(block['injection_source'])] = (kinds[String(block['injection_source'])] ?? 0) + 1;
  const filtered = structuredClone(row);
  for (const m of filtered['chat_messages'] as JsonObject[]) if (Array.isArray(m['content'])) m['content'] = (m['content'] as JsonObject[]).filter(b => !['injected_prompt_block', 'flag', 'token_budget'].includes(String(b['type'])));
  const baseline = extractClaudeRecord({ ...input, record: filtered });
  const normalized = (result.parsed.draft['messages'] as JsonObject[]).map(m => ({ ...m, content: (m['content'] as JsonObject[]).filter(b => !systemBlocks.has(b)) }));
  assert.deepEqual(normalized, baseline.parsed.draft['messages'], 'Other bodies, source parents and message order changed');
  const record = assembleConversationRecord({ ...result, parserVersion: bundle.parser, timestamp: new Date().toISOString() });
  const valid = validateRecord('conversation', record); assert(valid.ok, JSON.stringify(valid));
  injected += actual.length; flags += actualFlags.length; if (systemBlocks.size) affected++; messages += rawMessages.length;
  otherBlocks += normalized.reduce((n, m) => n + m.content.length, 0);
  if (!selected && actual.length && rawMessages.length < 500) {
    await writeFile(path.join(output, 'reader-source.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    selected = true;
  }
}
assert(selected); assert.deepEqual(await fingerprintFile(sourcePath), fingerprint);
const report = { source: fingerprint, conversations: rows.length, affected, messages, injected, flags, kinds, otherBlocks, schemaValid: true, promptsExact: true, flagDetailsExact: true, sourceUnchanged: true, otherContentAndParentsUnchanged: true };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
