import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startRecordEngine } from './record-engine-client.mjs';

// Real installer, real portable roots, actual signed EXE. Never touch the user Library.
const project = process.cwd();
const versionIndex = process.argv.indexOf('--version');
const version = versionIndex < 0 ? '1.0.0' : process.argv[versionIndex + 1];
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
const candidateIndex = process.argv.indexOf('--candidate');
const candidate = candidateIndex < 0 ? '' : process.argv[candidateIndex + 1];
if (candidateIndex >= 0) assert.match(candidate, /^[a-z0-9][a-z0-9-]{0,63}$/u);
const release = path.resolve(`releases/${version}`, candidate);
const manifest = JSON.parse(await readFile(path.join(release, 'SHA256-signed-payload.json')));
assert.equal(manifest.product_version, version);
const scope = path.resolve(`tests/private/windows-installer-${version}${candidate ? `-${candidate}` : ''}`);
const evidence = path.join(release, 'installer-test');
const installed = path.join(scope, '原始 Cloudig');
const moved = path.join(scope, 'Moved Cloudig');
const phase = process.argv[2] ?? 'install';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let engine;
async function run(exe, args, cwd = project, timeoutMs = 180000) {
  const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', s => { out = (out + s).slice(-32000); });
  child.stderr.on('data', s => { err = (err + s).slice(-32000); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned test PID=${child.pid} timed out; preserve state`)), timeoutMs);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${exe}: exit=${code}\n${err}\n${out}`)); });
  });
}
async function verifyProgram(root) {
  for (const file of manifest.files) assert.equal(sha(await readFile(path.join(root, file.path))), file.sha256, file.path);
}
async function inventory(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!(await lstat(path.join(root, name))).isSymbolicLink());
    if (name === 'cache') continue;
    if (entry.isDirectory()) Object.assign(result, await inventory(root, name));
    else result[name] = sha(await readFile(path.join(root, name)));
  }
  return result;
}
async function install(label, lock) {
  const args = ['-NoProfile', '-File', path.resolve('scripts/test-windows-installer-native.ps1'), '-Version', version, '-Installer', path.join(release, `Cloudig-${version}-Setup.exe`), '-Destination', installed, '-Log', path.join(evidence, `${label}.log`)];
  if (candidate) args.push('-CandidateName', candidate);
  if (lock) args.push('-LockPath', lock);
  const result = JSON.parse(await run('pwsh', args));
  assert.equal(result.temporary_files, 0, 'Installer must retire its extraction files');
  return result;
}
async function native(root, label, theme) {
  const output = path.join(evidence, `${label}.png`);
  await run(path.join(root, 'Cloudig.exe'), ['--visual-audit-output', output, '--visual-audit-query', `screenshot=1&fixture=real&route=reader&theme=${theme}&language=zh-CN&phase=motion-freeze&interaction=reader-catalog-open`, '--visual-audit-width', '1280', '--visual-audit-height', '720'], project);
  const result = JSON.parse(await readFile(output.replace(/\.png$/, '.json')));
  assert.equal(result.page.ready, true); assert.equal(result.page.surface, 'reader');
  assert.equal(result.page.theme, theme);
  assert.deepEqual(result.page.images_failed, []);
  const trace = await readFile(output.replace(/\.png$/, '.trace.txt'), 'utf8');
  assert.match(trace, /reader-catalog-open-passed/);
  assert.match(trace, /cache-profile-removed/);
  return { evidence: path.relative(release, output), ready: true, catalog_reader_archiver_roundtrip: true, profile_retired: true, theme, physical_pointer: false, hit_tested_cdp_pointer: true };
}
try {
  await mkdir(evidence, { recursive: true });
  if (phase === 'upgrade') {
    // Real published previous version -> candidate, with an owned populated Library.
    // Never install over the frozen release or the user's test Library.
    const previousIndex = process.argv.indexOf('--from-version');
    const previousVersion = previousIndex < 0 ? '1.0.0' : process.argv[previousIndex + 1];
    assert.match(previousVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
    assert.notEqual(previousVersion, version);
    const previousCandidateIndex = process.argv.indexOf('--from-candidate');
    const previousCandidate = previousCandidateIndex < 0 ? '' : process.argv[previousCandidateIndex + 1];
    if (previousCandidateIndex >= 0) assert.match(previousCandidate, /^[a-z0-9][a-z0-9-]{0,63}$/u);
    const previousRelease = path.resolve(`releases/${previousVersion}`, previousCandidate);
    const previousRoot = path.join(previousRelease, 'Cloudig');
    const previous = JSON.parse(await readFile(path.join(previousRelease, 'SHA256-signed-payload.json')));
    assert.equal(previous.product_version, previousVersion);
    await mkdir(scope);
    await cp(previousRoot, installed, { recursive: true, errorOnExist: true, force: false });
    for (const file of previous.files) assert.equal(sha(await readFile(path.join(installed, file.path))), file.sha256);
    engine = startRecordEngine({ packageRoot: installed, libraryRoot: installed });
    await engine.request('library.create');
    await copyFile(path.resolve('tests/fixtures/chatgpt-light-items-v2.html'), path.join(installed, 'Inbox', '升级保留.html'));
    const plan = await engine.request('archiver.parse.plan', { sources: [], one_click: true });
    assert.equal((await engine.request('archiver.parse.commit', { plan: plan.plan })).completed, 1);
    const oldRow = (await engine.request('reader.archives.query', { offset: 0, limit: 200 })).items[0];
    const info = await engine.request('reader.archive.info.query', { archive: oldRow.capability });
    const preservedTitle = `Keep my title through the ${version} upgrade`;
    info.draft.conversation_name = { state: 'set', value: preservedTitle };
    await engine.request('reader.archive.info.commit', { archive: oldRow.capability, expected_conversation: info.revision.conversation, expected_mark: info.revision.mark, draft: info.draft, touch_on_noop: false });
    await engine.close(); engine = null;
    await writeFile(path.join(installed, 'docs', 'user-note.txt'), 'My own document.\n');
    await writeFile(path.join(installed, 'bookmarks', 'user-note.txt'), 'My own bookmark note.\n');
    const oldProgram = new Set(previous.files.map(file => file.path));
    const userFiles = Object.fromEntries(Object.entries(await inventory(installed)).filter(([file]) => !oldProgram.has(file)));
    assert(Object.keys(userFiles).some(file => file.startsWith('Marks/')));
    assert(Object.keys(userFiles).some(file => file.startsWith('Conversations/')));
    const upgraded = await install('upgrade'); assert.equal(upgraded.exit_code, 0);
    await verifyProgram(installed);
    for (const [file, hash] of Object.entries(userFiles)) assert.equal(sha(await readFile(path.join(installed, file))), hash, `Upgrade changed user file: ${file}`);
    engine = startRecordEngine({ packageRoot: installed, libraryRoot: installed });
    assert.equal((await engine.request('library.startup.recover')).status, 'valid');
    const rows = await engine.request('reader.archives.query', { offset: 0, limit: 200 });
    assert.equal(rows.total, 1); assert.equal(rows.items[0].conversation_id, oldRow.conversation_id);
    assert.equal(rows.items[0].title, preservedTitle);
    await engine.close(); engine = null;
    const visual = await native(installed, 'upgraded-reader', 'dawn');
    await verifyProgram(installed);
    await writeFile(path.join(evidence, 'upgrade.json'), JSON.stringify({ status: 'passed', from: previousVersion, from_candidate: previousCandidate || null, from_source_build: previous.source_build.commit, to: version, installation: upgraded, preserved_user_files: Object.keys(userFiles).length, conversation_id_retained: true, mark_retained: true, program_files: manifest.file_count, visual }, null, 2) + '\n');
    console.log(`Published ${previousVersion} -> ${version} upgrade passed: all user bytes, Conversation identity and Mark title retained; signed program verified.`);
  } else if (phase === 'install') {
    await mkdir(scope); // Refuse an unknown/stale test root.
    await writeFile(path.join(scope, 'owner.json'), JSON.stringify({ purpose: `Windows installer ${version} test`, created: new Date().toISOString() }));
    const fresh = await install('fresh'); assert.equal(fresh.exit_code, 0);
    await verifyProgram(installed);
    engine = startRecordEngine({ packageRoot: installed, libraryRoot: installed });
    await engine.request('library.create');
    await copyFile(path.resolve('tests/fixtures/chatgpt-light-items-v2.html'), path.join(installed, 'Inbox', '安装与搬家.html'));
    const plan = await engine.request('archiver.parse.plan', { sources: [], one_click: true });
    assert.equal((await engine.request('archiver.parse.commit', { plan: plan.plan })).completed, 1);
    const row = (await engine.request('reader.archives.query', { offset: 0, limit: 200 })).items[0];
    const info = await engine.request('reader.archive.info.query', { archive: row.capability });
    info.draft.conversation_name = { state: 'set', value: 'Installed, moved, and still mine' };
    await engine.request('reader.archive.info.commit', { archive: row.capability, expected_conversation: info.revision.conversation, expected_mark: info.revision.mark, draft: info.draft, touch_on_noop: false });
    await engine.close(); engine = null;
    const visual = await native(installed, 'installed-reader', 'dawn');
    await writeFile(path.join(installed, 'docs', 'user-note.txt'), 'Keep my own document.\n');
    await writeFile(path.join(installed, 'bookmarks', 'user-note.txt'), 'Keep my own bookmark note.\n');
    const before = await inventory(installed);
    const blocked = await install('locked', path.join(installed, 'Cloudig.exe'));
    assert.notEqual(blocked.exit_code, 0);
    assert.match(await readFile(path.join(evidence, 'locked.log'), 'utf8'), /in use or not writable/);
    assert.deepEqual(await inventory(installed), before, 'Busy install changes nothing');
    const repair = await install('repair'); assert.equal(repair.exit_code, 0);
    assert.deepEqual(await inventory(installed), before, 'Repair preserves all original program/user bytes');
    await cp(installed, moved, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    assert.deepEqual(await inventory(moved), before, 'Entire portable root copies byte-for-byte');
    await verifyProgram(moved);
    await writeFile(path.join(evidence, 'install.json'), JSON.stringify({ status: 'passed', fresh, blocked, repair, visual, conversation_id: row.conversation_id, preserved_file_count: Object.keys(before).length, program_files: manifest.file_count, same_volume_copy: true, physical_cross_volume: false }, null, 2) + '\n');
    console.log('Installation, actual Reader roundtrip, busy-file refusal, repair and copy passed. Remove only original test root, then run after-removal.');
  } else if (phase === 'after-removal') {
    assert.equal(await lstat(installed).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }), false, 'Original test installation must actually be removed');
    engine = startRecordEngine({ packageRoot: moved, libraryRoot: moved });
    assert.equal((await engine.request('library.startup.recover')).status, 'valid');
    const rows = await engine.request('reader.archives.query', { offset: 0, limit: 200 });
    assert.equal(rows.total, 1); assert.equal(rows.items[0].title, 'Installed, moved, and still mine');
    await engine.close(); engine = null;
    const visual = await native(moved, 'moved-reader', 'star-night');
    await verifyProgram(moved);
    await verifyProgram(path.join(release, 'Cloudig'));
    await writeFile(path.join(evidence, 'after-removal.json'), JSON.stringify({ status: 'passed', original_removed: true, moved_copy_runs_independently: true, mark_retained: true, signed_program_unchanged: true, visual }, null, 2) + '\n');
    console.log('Copied app still runs after original removal; Mark and all signed program bytes preserved.');
  } else throw new Error('Unknown test phase');
} finally { if (engine) await engine.close(); }
