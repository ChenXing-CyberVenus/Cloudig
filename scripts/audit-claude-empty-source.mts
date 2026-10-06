import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { fingerprintFile } from '../src/adapters/storage/stream.mts';
import { claudeRecordSelector } from '../src/adapters/parser/claude-export-record.mts';
import { extractClaudeRecord } from '../src/app/parser/record-source.mts';
import { assembleConversationRecord } from '../src/app/parser/conversation-record.mts';
import { projectClaudeContainerRecord } from '../src/adapters/parser/claude-container.mts';
import { validateRecord } from '../src/core/records/index.mts';
import type { JsonObject } from '../src/core/contracts/types.mts';

const [sourceArg, outputArg, baselineCommit] = process.argv.slice(2);
assert(sourceArg && outputArg && baselineCommit && /^[a-f0-9]{40}$/u.test(baselineCommit));
const sourcePath = path.resolve(sourceArg), output = path.resolve(outputArg);
assert(output.startsWith(path.resolve('tests/private') + path.sep)); await mkdir(output, { recursive: false });
// Read the exact pre-fix adapter from Git, bundle in memory, never overwrite the
// working tree or create an alternative production checkout.
const original = execFileSync('git', ['show', `${baselineCommit}:src/adapters/parser/claude-export-record.mts`], { encoding: 'utf8', windowsHide: true });
const compiled = await build({ stdin: { contents: original, loader: 'ts', resolveDir: path.resolve('src/adapters/parser') }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' });
const prior = { exports: {} as { claudeRecordToDraft?: (value: unknown) => JsonObject } };
new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(createRequire(import.meta.url), prior, prior.exports);
assert(prior.exports.claudeRecordToDraft);
const fingerprint = await fingerprintFile(sourcePath), rows = JSON.parse(await readFile(sourcePath, 'utf8')) as JsonObject[];
const bundle = JSON.parse(await readFile('src/adapters/parser/contracts/adapters.json', 'utf8'));
let removed = 0, messages = 0, emptyRecords = 0, emptyMessages = 0, wroteSystem = false;
const needle = 'This block is not supported on your current device yet.';
for (const [index, row] of rows.entries()) {
  const source = { file: path.basename(sourcePath), ...fingerprint }, input = { record: row, source };
  const result = extractClaudeRecord(input), before = prior.exports.claudeRecordToDraft({ ...input, selector: claudeRecordSelector(String(row['uuid'])) });
  const oldMessages = before['messages'] as JsonObject[], actual = result.parsed.draft['messages'] as JsonObject[];
  for (const [i, message] of oldMessages.entries()) {
    const old = message['content'] as JsonObject[], current = actual[i]!['content'] as JsonObject[];
    if (old.length === current.length + 1) {
      assert.equal(old[0]!['type'], 'markdown'); assert(String(old[0]!['text']).includes(needle));
      old.shift(); removed++;
    }
  }
  if (!isDeepStrictEqual(result.parsed.draft, before)) {
    const firstDifference = (a: unknown, b: unknown, at = ''): string => {
      if (a === b) return '';
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return at;
      const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
      for (const key of new Set([...Object.keys(aa), ...Object.keys(bb)])) { const found = firstDifference(aa[key], bb[key], `${at}.${key}`); if (found) return found; }
      return '';
    };
    throw Error(`Unexpected content difference in record ${index}: ${firstDifference(result.parsed.draft, before)}`);
  }
  const canonical = assembleConversationRecord({ ...result, parserVersion: bundle.parser, timestamp: new Date().toISOString() });
  assert(validateRecord('conversation', canonical).ok);
  const summary = projectClaudeContainerRecord(row, index + 1, 0, 1, '1'.repeat(64)); messages += Number(summary['messages']);
  if (Number(summary['empty_messages']) === Number(summary['messages'])) {
    emptyRecords++; emptyMessages += Number(summary['empty_messages']);
    await writeFile(path.join(output, 'reader-empty-source.json'), JSON.stringify(canonical, null, 2) + '\n', { flag: 'wx' });
  }
  if (!wroteSystem && result.facts.blockSpeakers?.size && actual.length < 100) {
    await writeFile(path.join(output, 'reader-system-source.json'), JSON.stringify(canonical, null, 2) + '\n', { flag: 'wx' }); wroteSystem = true;
  }
}
assert.deepEqual(await fingerprintFile(sourcePath), fingerprint);
const report = { source: fingerprint, baselineCommit, conversations: rows.length, messages, placeholderFallbacksRemoved: removed, emptyRecords, emptyMessages, otherContentAndTopologyUnchanged: true, schemaValid: true, sourceUnchanged: true };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report));
