// Bounded integration evidence for the packaged Engine. All files are owned
// synthetic fixtures; no Parser, real Library or Chrome profile is touched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, realpath, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { startRecordEngine } from './record-engine-client.mjs';
import { uuidV7 } from '../src/core/records/ids.mts';
import { validateRecord } from '../src/core/records/index.mts';
const project = process.cwd(), packageRoot = path.join(project, 'artifacts/v1-desktop/app');
const output = path.resolve(process.argv[2] ?? 'artifacts/v1-release/evidence/schema-sync-final-20260916');
assert.ok(output.startsWith(path.join(project, 'artifacts') + path.sep));
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
const root = path.join(output, 'Library'); await mkdir(root);
const sha = v => createHash('sha256').update(v).digest('hex'), text = v => JSON.stringify(v, null, 2) + '\n';
const record = {
  schema: 'cloudig/conversation/1.0.0', conversation_id: uuidV7(),
  parser: { version: '0.0.0', adapter: { id: 'external-fixture', version: '0.0.0' } },
  lifecycle: { first_parsed_at: '2026-09-16T20:00:00Z', last_parsed_at: '2026-09-16T20:00:00Z', cloudig_edited_at: '2026-09-16T20:00:00Z' },
  source: { file: 'manual.txt', sha256: sha('EXTERNAL_BODY'), bytes: 13, format: 'external-json' },
  platform: 'myplatform',
  identity: [{ schema: 'cloudig/identity/1.0.0', source_id: 'user', names: [{ name: '外来作者', claimers: [] }], kind: { world: 'terran', subject: 'human' }, role: 'user' }],
  messages: { items: [{ id: 'm1', speaker: 'user', content: [{ type: 'markdown', text: 'EXTERNAL_BODY\n\n公式 $x^2$；金额 $0.435/$0.87；代码 `$x$`。' }] }] }
};
assert.equal(validateRecord('conversation', record).ok, true);
await writeFile(path.join(output, 'unknown-platform.fixture.json'), text(record));
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const bom = structuredClone(record); bom.conversation_id = uuidV7(); bom.platform = 'chatgpt';
bom.resources = [{ id: 'r1', kind: 'image', mime: 'image/gif', availability: 'embedded', bytes: image.length, sha256: sha(image), data_base64: [image.toString('base64')] }];
bom.messages.items[0].content.push({ type: 'image', resource: 'r1' });
assert.equal(validateRecord('conversation', bom).ok, true);
const rows = [], file = path.join(root, 'Conversations/external.json'), bomFile = path.join(root, 'Conversations/bom.json');
const engine = startRecordEngine({ packageRoot, libraryRoot: root });
const command = engine.request;
const result = { executable_sha256: sha(await readFile(path.join(packageRoot, 'Cloudig.exe'))), engine_sha256: sha(await readFile(path.join(packageRoot, 'app/engine/engine.mjs'))), observations: rows };
let passed = false;
const observed = (id, detail = true) => { rows.push({ id, passed: true, detail }); console.log(id + ': pass'); };
async function materialized(virtualPath) {
  assert.match(virtualPath, /^\//); assert(!virtualPath.includes('..'));
  const suffix = path.join('Views', ...virtualPath.slice(1).split('/'));
  const matches = (await readdir(path.join(root, 'cache'), { recursive: true })).filter(name => name.endsWith(suffix));
  assert.equal(matches.length, 1); return readFile(path.join(root, 'cache', matches[0]));
}
try {
  await command('library.create'); const libraryFile = path.join(root, 'CloudigLibrary.json');
  const library = JSON.parse(await readFile(libraryFile, 'utf8')); assert.equal(Object.keys(library)[0], 'cloudig_standard'); assert.equal(library.cloudig_standard, '1.0');
  observed('total-standard');
  delete library.cloudig_standard; const legacy = text(library); await writeFile(libraryFile, legacy);
  assert.equal((await command('library.startup.recover')).status, 'valid');
  const prefs = await command('library.preferences.query'); assert.equal(await readFile(libraryFile, 'utf8'), legacy);
  await command('library.preferences.commit', { expected_revision: prefs.revision, language: 'en' });
  assert.equal(JSON.parse(await readFile(libraryFile, 'utf8')).cloudig_standard, '1.0'); observed('known-old-library-no-startup-write');
  await writeFile(file, text(record)); await writeFile(bomFile, '\uFEFF' + text(bom));
  const invalid = { ...structuredClone(record), conversation_id: uuidV7(), extra: true };
  const invalidSpeaker = structuredClone(record); invalidSpeaker.conversation_id = uuidV7(); invalidSpeaker.messages.items[0].speaker = 'missing';
  const future = { ...record, schema: 'cloudig/conversation/1.1.0', conversation_id: uuidV7() };
  for (const [name, value] of [['extra', invalid], ['speaker', invalidSpeaker], ['future', future]]) await writeFile(path.join(root, 'Conversations', name + '.json'), text(value));
  const originals = [file, bomFile, path.join(root, 'Conversations/extra.json'), path.join(root, 'Conversations/speaker.json'), path.join(root, 'Conversations/future.json')];
  const before = await Promise.all(originals.map(async p => sha(await readFile(p))));
  const list = await command('reader.archives.query', { offset: 0, limit: 100 }); assert.equal(list.total, 2);
  assert.equal(list.issues.filter(i => i.code === 'CLOUDIG_RECORD_SCHEMA_UNSUPPORTED').length, 1);
  assert.equal((await command('systemLog.list', { offset: 0, limit: 100 })).total, 0);
  observed('mixed-catalog-and-no-log-spam', { total: list.total, unsupported: 1 });
  for (const row of list.items) {
    const page = { offset: 0, limit: 100 };
    const opened = await command('reader.view.open', { archive: row.capability, request: { messages: page, navigation: page, branches: page } });
    assert((await materialized(opened.page.virtual_path)).toString('utf8').includes('EXTERNAL_BODY'));
    if (row.platform === 'chatgpt') {
      const resource = await command('reader.resource.materialize', { view: opened.token, resource: 'r1' });
      assert.deepEqual(await materialized(resource.virtual_path), image); observed('bom-resource-bytes-and-hash');
    }
    await command('reader.view.close', { view: opened.token });
  }
  const archive = list.items.find(row => row.platform === 'myplatform').capability;
  await command('reader.archive.identity.query', { archive }); observed('unknown-platform-reader-and-identity');
  const info = await command('reader.archive.info.query', { archive }), draft = structuredClone(info.draft);
  draft.conversation_name = { state: 'set', value: '外来标题 😀' };
  await command('reader.archive.info.commit', { archive, expected_conversation: info.revision.conversation, expected_mark: info.revision.mark, draft, touch_on_noop: false });
  const exported = await command('reader.archive.exportMarkdown', { archive });
  const markdown = await readFile(path.join(root, 'Exports', exported.filename), 'utf8');
  assert(markdown.includes('外来标题 😀')); assert(markdown.includes('EXTERNAL_BODY')); observed('unknown-platform-mark-and-markdown');
  const changedInfo = await command('reader.archive.info.query', { archive });
  const resetModels = structuredClone(changedInfo.draft); resetModels.models = { state: 'set', values: [] };
  await command('reader.archive.info.commit', { archive, expected_conversation: changedInfo.revision.conversation, expected_mark: changedInfo.revision.mark, draft: resetModels, touch_on_noop: false });
  assert.deepEqual((await command('reader.archive.info.query', { archive })).effective.models, ['AI']); observed('unknown-platform-explicit-model-reset');
  assert.deepEqual(await Promise.all(originals.map(async p => sha(await readFile(p)))), before); observed('all-source-bytes-preserved');
  assert.deepEqual(await readdir(path.join(root, 'appdata/parse-history')).catch(() => []), []); observed('no-parser-or-parse-history-required');
  const timeCover = await command('time.cover.query', { return_to: 'reader-cover' });
  const timeFiles = (await readdir(path.join(root, 'ContentTimes'))).filter(name => name !== 'order.json');
  const timeRecords = await Promise.all(timeFiles.map(async name => ({ file: path.join(root, 'ContentTimes', name), bytes: await readFile(path.join(root, 'ContentTimes', name)) })));
  const selectedTime = timeRecords.find(item => JSON.parse(item.bytes.toString('utf8')).name === '现代社会');
  assert(selectedTime);
  const futureTime = JSON.parse(selectedTime.bytes.toString('utf8')); futureTime.schema = 'cloudig/content-time/1.1.0';
  const futureTimeBytes = Buffer.from(text(futureTime)), timeOrder = await readFile(path.join(root, 'ContentTimes/order.json'));
  await writeFile(selectedTime.file, futureTimeBytes);
  const updateRequired = error => error.code === 'CLOUDIG_RECORD_SCHEMA_UNSUPPORTED' && error.message.includes('请更新采云') && error.message.includes(path.basename(selectedTime.file));
  await assert.rejects(command('time.cover.query', { return_to: 'reader-cover' }), updateRequired);
  await assert.rejects(command('time.order.commit', { route: timeCover.route, expected_time_revision: timeCover.revision, expected_library_revision: timeCover.library_revision, nodes: [] }), updateRequired);
  assert.deepEqual(await readFile(path.join(root, 'ContentTimes/order.json')), timeOrder);
  for (const item of timeRecords) assert.deepEqual(await readFile(item.file), item === selectedTime ? futureTimeBytes : item.bytes);
  observed('newer-time-query-and-stale-order-refused', { code: 'CLOUDIG_RECORD_SCHEMA_UNSUPPORTED', all_time_bytes_preserved: true });
  const unaffected = await command('reader.archives.query', { offset: 0, limit: 100 }); assert.equal(unaffected.total, 2);
  const page = { offset: 0, limit: 100 }, opened = await command('reader.view.open', { archive: unaffected.items[0].capability, request: { messages: page, navigation: page, branches: page } });
  assert((await materialized(opened.page.virtual_path)).toString('utf8').includes('EXTERNAL_BODY'));
  await command('reader.view.close', { view: opened.token }); observed('newer-time-does-not-block-archive-reading');
  await writeFile(selectedTime.file, selectedTime.bytes);
  const recoveredTime = await command('time.cover.query', { return_to: 'reader-cover' }); assert.equal(recoveredTime.terran.items.length, timeCover.terran.items.length);
  assert.deepEqual(await readFile(path.join(root, 'ContentTimes/order.json')), timeOrder); observed('compatible-time-recovers-without-restart');
  const newer = JSON.parse(await readFile(libraryFile, 'utf8')); newer.schemas.mark = '1.1.0'; await writeFile(libraryFile, text(newer));
  const refused = await command('library.startup.recover'); assert.equal(refused.reason, 'schema_update_required'); observed('new-library-component-update-message', refused);
  passed = true;
} finally {
  await engine.close();
  if (passed) {
    assert.equal(path.dirname(await realpath(root)), await realpath(output)); assert(!(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true }); result.owned_library_retired = true;
  } else result.retained_library = root;
  await writeFile(path.join(output, 'report.json'), text(result));
}
console.log(JSON.stringify({ checks: rows.length, passed, output }));
