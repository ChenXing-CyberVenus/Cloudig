import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHtmlRecord } from '../src/app/parser/record-source.mts';
import { assembleConversationRecord } from '../src/app/parser/conversation-record.mts';
import { prepareRecordEncoding } from '../src/core/records/encoding.mts';
import { inspectRecordConversation } from '../src/adapters/reader/record-resource.mts';
import parserHistory from '../src/adapters/parser/contracts/parser-history.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'src/ui/documents/examples/html');
export const exampleBuildRoot = path.join(root, 'artifacts/v1-document-examples');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
async function parserInputHash() {
  const digest = createHash('sha256');
  for (const folder of ['src/app/parser', 'src/adapters/parser', 'src/core/records']) {
    const entries = (await readdir(path.join(root, folder), { recursive: true })).filter(f => /\.(mts|json)$/u.test(f)).sort();
    for (const entry of entries) { digest.update(`${folder}/${entry.replaceAll('\\', '/')}\0`); digest.update(await readFile(path.join(root, folder, entry))); }
  }
  return digest.digest('hex');
}
export async function buildPlatformExamples(check = false, { reuseExisting = false, refreshFiles }: { reuseExisting?: boolean; refreshFiles?: readonly string[] } = {}) {
  assert(!reuseExisting || check, 'Existing examples can only be verified, not rewritten');
  assert(!refreshFiles || !check, 'A scoped refresh is a write operation');
  const files = (await readdir(input)).filter(n => n.endsWith('.html')).sort(); assert.equal(files.length, 39);
  if (refreshFiles) assert(refreshFiles.length > 0 && refreshFiles.every(file => files.includes(file)), 'Unknown refresh source');
  const codeHash = await parserInputHash();
  const previous = await readJson(path.join(exampleBuildRoot, 'manifest.json')).catch(() => null);
  const entries: any[] = [];
  if (!check) await mkdir(path.join(exampleBuildRoot, 'records'), { recursive: true });
  if (!check) await mkdir(path.join(exampleBuildRoot, 'html'), { recursive: true });
  for (const file of files) {
    const bytes = await readFile(path.join(input, file)), sha = hash(bytes);
    const id = `example-${hash(file).slice(0, 20)}`;
    const recordPath = `records/${id}.json`;
    const untouched = refreshFiles && !refreshFiles.includes(file);
    const candidate = previous?.examples.find((e: any) => e.id === id && e.html.sha256 === sha && e.html.file === file && e.html.path === `html/${file}` && e.record.path === recordPath);
    const prior = candidate && (reuseExisting || untouched || (candidate.parser_input_sha256 ?? previous.parser_input_sha256) === codeHash) ? candidate : null;
    if (prior) {
      const stored = await readFile(path.join(exampleBuildRoot, recordPath)).catch(() => null);
      const html = await readFile(path.join(exampleBuildRoot, prior.html.path)).catch(() => null);
      if (stored && html && stored.length === prior.record.bytes && html.length === prior.html.bytes && hash(stored) === prior.record.sha256 && hash(html) === sha) { entries.push(prior); continue; }
    }
    assert(!untouched, `Unchanged example drifted; scoped refresh may not rewrite ${file}`);
    assert(!check, `Build platform example ${file} before packaging`);
    const extracted = await extractHtmlRecord({ filePath: path.join(input, file), temporaryRoot: path.join(exampleBuildRoot, 'work') });
    const timestamp = new Date().toISOString();
    const record = assembleConversationRecord({ ...extracted, parserVersion: parserHistory.current_parser, timestamp });
    const encoding = prepareRecordEncoding('conversation', record);
    await writeFile(path.join(exampleBuildRoot, recordPath), encoding.chunks());
    const inspected = await inspectRecordConversation(path.join(exampleBuildRoot, recordPath));
    assert.equal(inspected.fingerprint.sha256, encoding.fingerprint.sha256);
    await cp(path.join(input, file), path.join(exampleBuildRoot, 'html', file));
    const [platformName, profileName, ...scenario] = path.basename(file, '.html').split('-');
    const source = record['source'] as any;
    const messages = (record['messages'] as any).items;
    entries.push({ id, platform: record['platform'], platform_name: platformName, scenario: scenario.join('-') || 'Chat', profile: ({ '轻装': 'light', '全量': 'full', '整树': 'tree' } as any)[profileName!],
      html: { path: `html/${file}`, file, bytes: bytes.length, sha256: sha },
      record: { path: recordPath, ...encoding.fingerprint, conversation_id: record['conversation_id'] },
      parser: record['parser'], parser_input_sha256: codeHash, exporter: source.exporter ?? null, generated_at: timestamp,
      messages: messages.length, resources: inspected.resourceBodies.size, limitations: record['limitations'] ?? [], diagnostics: extracted.parsed.systemLogErrors ?? [] });
    console.log(`${entries.length}/${files.length} ${file}: ${messages.length} messages, ${encoding.fingerprint.bytes} JSON bytes`);
  }
  // Old entries retain their own historical producer; an explicit scope does
  // not refresh other platforms' UUIDs, lifecycle dates, or parsed bytes.
  const manifest = { format: 'cloudig/public-examples/1', parser_input_sha256: reuseExisting || refreshFiles ? previous.parser_input_sha256 : codeHash, examples: entries };
  if (check) assert.deepEqual(previous, manifest);
  else await writeFile(path.join(exampleBuildRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // UI sees facts and IDs only; no local absolute path or embedded conversation content.
  const catalog = { format: manifest.format, examples: entries.map(({ diagnostics, limitations, parser_input_sha256: _cacheHash, ...entry }) => ({ ...entry, limitations: limitations.length, diagnostics: diagnostics.length })) };
  const webFile = path.join(root, 'src/ui/shell/pages/document/content/examples.json');
  if (check) assert.deepEqual(await readJson(webFile), catalog); else await writeFile(webFile, JSON.stringify(catalog) + '\n');
  console.log(JSON.stringify({ examples: entries.length, html_bytes: entries.reduce((n, e) => n + e.html.bytes, 0), json_bytes: entries.reduce((n, e) => n + e.record.bytes, 0) }));
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refresh = process.argv.find(arg => arg.startsWith('--refresh='))?.slice('--refresh='.length).split(',');
  await buildPlatformExamples(process.argv.includes('--check'), { reuseExisting: process.argv.includes('--reuse-existing'), ...(refresh ? { refreshFiles: refresh } : {}) });
}
