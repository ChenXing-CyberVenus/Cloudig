import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { buildPlatformExamples, exampleBuildRoot } from '../../../scripts/build-platform-examples.mts';
import { RecordReaderEngineCommands } from '../../../src/engine/record-reader-commands.mts';
import { assertIpcValue } from '../../../src/engine/protocol.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';

test('39 public source pairs traverse the production Reader/branches/resources with no Library writes or archive capabilities', async () => {
  const manifest = await buildPlatformExamples(true, { reuseExisting: true });
  const base = path.resolve('tests/private/schema-rebuild'); await mkdir(base,{recursive:true});
  const root = await mkdtemp(path.join(base,'public-examples-')), library = path.join(root,'Library'), runtime = path.join(root,'Runtime');
  await mkdir(library); await mkdir(runtime); let passed=false;
  const builtins={user:{name:'User',avatar:'Assets/user.svg'},assistant:{name:'AI',avatar:'Assets/ai.svg'},platforms:{}};
  const engine=new RecordReaderEngineCommands({libraryRoot:library,runtimeRoot:runtime,examplesRoot:exampleBuildRoot,builtins});
  const context={request:'q_example',signal:new AbortController().signal,emit:async()=>{}};
  const call=async(name:string,payload:JsonObject)=>{const r=await engine.handlers()[name]!(payload,context);assertIpcValue(r);return r as any;};
  const request={messages:{offset:0,limit:20},navigation:{offset:0,limit:30},branches:{offset:0,limit:20}};
  try {
    let resources=0, trees=0;
    for(const example of manifest.examples) {
      const original=await call('reader.example.original',{example:example.id});assert.equal(original.path,path.join(exampleBuildRoot,example.html.path));
      const opened=await call('reader.example.open',{example:example.id,language:'en',request});
      const view=JSON.parse(await readFile(path.join(runtime,'Views',opened.page.virtual_path.slice(1)),'utf8'));
      assert.equal(view.header.platform,example.platform);assert.equal(view.pagination.total_canonical,example.messages);
      const record=JSON.parse(await readFile(path.join(exampleBuildRoot,example.record.path),'utf8'));
      if(example.profile==='tree') {assert(record.messages.items.some((m:any)=>m.parent));trees++;}
      for(const resource of (record.resources??[]).filter((r:any)=>r.data_base64).slice(0,1)) {
        const asset=await call('reader.resource.materialize',{view:opened.token,resource:resource.id});assert(asset.bytes>0);resources++;
      }
      await assert.rejects(()=>call('reader.archive.info.query',{archive:example.id}));
      await call('reader.view.close',{view:opened.token});
    }
    assert(resources>20);assert.equal(trees,9);assert.deepEqual(await readdir(library),[]);
    await assert.rejects(()=>call('reader.example.original',{example:'../private.html'}));
    await assert.rejects(()=>call('reader.example.open',{example:manifest.examples[0].id,language:'en',request,sourceRoot:library}));
    passed=true;
  } finally {await engine.close();if(passed){assert.equal(path.dirname(await realpath(root)),await realpath(base));assert(!(await lstat(root)).isSymbolicLink());await rm(root,{recursive:true});}else console.error(`Retained public-example test: ${root}`);}
});
