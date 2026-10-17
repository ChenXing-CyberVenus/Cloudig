import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildPlatformExamples, exampleBuildRoot } from '../../../scripts/build-platform-examples.mts';

test('explicit reuse validates all existing source/HTML/JSON pairs without refreshing their identities or waterlines', async () => {
  const before = await readFile(`${exampleBuildRoot}/manifest.json`);
  const catalog = await readFile('src/ui/shell/pages/document/content/examples.json');
  const verified = await buildPlatformExamples(true, { reuseExisting: true });
  assert.equal(verified.examples.length, 39);
  assert.deepEqual(verified, JSON.parse(before));
  assert.deepEqual(await readFile(`${exampleBuildRoot}/manifest.json`), before);
  assert.deepEqual(await readFile('src/ui/shell/pages/document/content/examples.json'), catalog);
  await assert.rejects(buildPlatformExamples(false, { reuseExisting: true }), /only be verified/);
  await assert.rejects(buildPlatformExamples(true, { refreshFiles: ['Claude-全量-Artifacts.html'] }), /write operation/);
  await assert.rejects(buildPlatformExamples(false, { refreshFiles: ['missing.html'] }), /Unknown refresh source/);
});
