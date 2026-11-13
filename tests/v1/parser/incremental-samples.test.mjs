import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {resolveV1Samples} from '../../../scripts/resolve-v1-samples.mjs';

test('incremental Sample replaces one identified case/profile and keeps other platforms, branches and older profiles',async()=>{
  const parent=path.resolve('tests/private');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'incremental-samples-'));
  const batches=['2026-10-30','2026-11-04'];
  const put=async(batch,name,platform,id,version)=>{const f=path.join(root,batch,name);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,`<script id="ai-chat-archive-manifest" type="application/json">${JSON.stringify({format:'ai-chat-archive/manifest-v1',platform,conversation_id:id,exporter_version:version})}</script>`);return f;};
  try {
    const original=await put(batches[0],'case.html','chatgpt','chat-1','1.0.0-light'), bytes=await readFile(original);
    await put(batches[0],'case (1).html','chatgpt','chat-1','1.0.0-full');
    await put(batches[0],'another.html','claude','chat-2','1.0.0-light');
    await put(batches[0],'branch01.html','chatgpt','chat-1','1.0.0-light');
    await put(batches[1],'case.html','chatgpt','chat-1','1.0.1-light');
    await put(batches[1],'unknown.html','chatgpt',undefined,'1.0.1-light');
    await put(batches[0],'unknown.html','chatgpt',undefined,'1.0.0-light');
    const selected=await resolveV1Samples(root,batches);
    assert.equal(selected.length,6);assert.equal(selected.find(x=>x.name==='case.html').version,'1.0.1-light');
    assert.equal(selected.filter(x=>x.platform==='claude').length,1);assert.equal(selected.filter(x=>x.profile==='full').length,1);
    assert.equal(new Set(selected.map(x=>x.importName)).size,6);assert.deepEqual(await readFile(original),bytes);
    assert.equal((await resolveV1Samples(path.join(root,batches[1]),batches)).length,2);
  } finally {assert.equal(path.dirname(root),parent);await rm(root,{recursive:true});}
});
