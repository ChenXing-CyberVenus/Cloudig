import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { publicExampleUrl, publicExampleRoute, exampleFileSize } from '../../../src/ui/shell/pages/document/examples-links.js';
import { packagePlatformExamples } from '../../../scripts/package-platform-examples.mjs';

test('public example links encode exact catalog IDs/actions and retain requested UI language/theme', () => {
  const id='example-0123456789abcdefabcd';
  for(const action of ['view','reader','download-html','download-json']) {
    const url = new URL(publicExampleUrl(id,action,'en','star-night'));
    assert.equal(url.origin,'https://chenxing-cybervenus.github.io'); assert.equal(url.pathname,'/Cloudig/');
    assert.equal(url.searchParams.get('lang'),'en'); assert.equal(url.searchParams.get('theme'),'star-night'); assert.deepEqual(publicExampleRoute(url.hash),{id,action});
  }
  assert.throws(()=>publicExampleUrl('../private')); assert.equal(publicExampleRoute('#platforms/../../etc'),null);
  assert.equal(exampleFileSize(1024),'1.0 KiB'); assert.equal(exampleFileSize(1024*1024),'1.0 MiB'); assert.throws(()=>exampleFileSize(-1));
});

test('desktop example packaging preserves prose and ships no HTML or Conversation bodies', async () => {
  const manifest=JSON.parse(await readFile('artifacts/v1-document-examples/manifest.json','utf8'));
  const root=path.resolve('tmp'); await mkdir(root,{recursive:true}); const target=await mkdtemp(path.join(root,'example-distribution-')); let passed=false;
  try {
    const result=await packagePlatformExamples(process.cwd(),target,manifest);
    assert.equal(result.mode,'online-catalog'); assert.equal(result.count,39); assert(result.omitted_bytes>200_000_000);
    assert.deepEqual((await readdir(path.join(target,'docs/examples'))).sort(),['Cloudig-Platform-Examples.en.md','Cloudig-Platform-Examples.zh-CN.md','manifest.json']);
    const facts=JSON.parse(await readFile(path.join(target,'docs/examples/manifest.json'),'utf8')); assert.equal(facts.distribution,'online'); assert.deepEqual(facts.examples,manifest.examples);
    for(const language of ['zh-CN','en']) {
      const before=await readFile(`src/ui/documents/examples/${language}.md`,'utf8'),after=await readFile(path.join(target,`docs/examples/Cloudig-Platform-Examples.${language}.md`),'utf8');
      assert.equal(after.replace(/href="https:\/\/chenxing-cybervenus\.github\.io\/Cloudig\/examples\/html\/([^"]+)"/gu,(_all,name)=>`href="examples/${decodeURIComponent(name)}"`),before,'Only link destinations may change');
    }
    passed=true;
  } finally { if(passed)await rm(target,{recursive:true});else console.error(`Retained failed example distribution fixture: ${target}`); }
});
