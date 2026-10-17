import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, readdir, realpath, lstat, rm, copyFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixtureZip } from './zip-fixture.mts';
import { OfficialZip, inspectOfficialZip, zipRecordSelector, splitZipRecordSelector } from '../../../src/adapters/parser/official-zip.mts';
import { indexRecordOfficialContainer, extractIndexedOfficialRecord } from '../../../src/adapters/parser/record-official-index.mts';
import { assembleConversationRecord } from '../../../src/app/parser/conversation-record.mts';
import { createRecordLibrary } from '../../../src/adapters/library-data/record-library.mts';
import { scanRecordSources } from '../../../src/adapters/library-data/record-parse-status.mts';
import { RecordArchiverEngineCommands } from '../../../src/engine/record-archiver-commands.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
import { uuidV7 } from '../../../src/core/records/ids.mts';
const base = path.resolve('tests/private/schema-rebuild'), timestamp = '2026-09-28T14:00:00Z';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'official-zip-'));let passed=false;
  try { await createRecordLibrary(root,{timestamp,anchor:{date:'2026-09-28',offset:'Z'}});await run(root);passed=true; }
  finally { if(passed){assert.equal(path.dirname(await realpath(root)),await realpath(base));assert(!(await lstat(root)).isSymbolicLink());await rm(root,{recursive:true});}else console.error(`Retained ZIP fixture: ${root}`); }
}
const mistral = (id='chat', content='One\nTwo') => JSON.stringify([{id:'u',chatId:id,version:0,role:'user',content,createdAt:timestamp,files:[{name:'note.txt'}]},{id:'a',chatId:id,version:0,role:'assistant',content:'Answer',createdAt:timestamp}]);
test('ZIP keeps UTF-8 member names, validates CRC and rejects unsafe/duplicate paths; cancellation is local',()=>temporary(async root=>{
  const f=path.join(root,'Inbox/a.zip');await writeFile(f,fixtureZip([{name:'chat-测试.json',data:mistral()},{name:'chat-测试-files/note.txt',data:'test',stored:true}]));
  const z=await OfficialZip.open(f);try{assert.equal(z.layout().platform,'mistral');assert.equal((await z.bytes('chat-测试-files/note.txt')).toString(),'test');const c=new AbortController();c.abort();await assert.rejects(z.bytes('chat-测试.json',c.signal),{name:'AbortError'});}finally{await z.close();}
  const locator=zipRecordSelector('chat-测试.json','a'.repeat(64));assert.equal(splitZipRecordSelector(locator).entry,'chat-测试.json');
  await writeFile(f,fixtureZip([{name:'../chat-x.json',data:'[]'}]));await assert.rejects(OfficialZip.open(f));
  await writeFile(f,fixtureZip([{name:'chat-x.json',data:'[]'},{name:'chat-x.json',data:'[]'}]));await assert.rejects(OfficialZip.open(f),/duplicate/);
  await writeFile(f,fixtureZip([{name:'chat-x.json',data:mistral(),wrongCrc:true}]));const bad=await OfficialZip.open(f);try{await assert.rejects(bad.bytes('chat-x.json'),/CRC/);}finally{await bad.close();}
}));
test('Mistral ZIP combines member conversations without merging equal native IDs; raw ZIP is source and filename title is the member',()=>temporary(async root=>{
  const bytes=fixtureZip([{name:'chat-first.json',data:mistral()},{name:'chat-first-files/note.txt',data:'attachment'},{name:'chat-second.json',data:mistral('chat','Other')},{name:'knowledge/index.json',data:'{"topics":[]}'},{name:'knowledge/memories/context.md',data:'DO NOT APPEND TO CHAT'}]);
  const f=path.join(root,'Inbox/renamed.zip');await writeFile(f,bytes);
  const sources=await scanRecordSources(root);assert.equal(sources.length,1);assert.equal(sources[0]!.format,'zip-container');assert.equal(sources[0]!.platform,'mistral');
  const {index}=await indexRecordOfficialContainer(root,'Inbox/renamed.zip');assert.equal(index.records.length,2);assert.notEqual(index.records[0]!['selector'],index.records[1]!['selector']);
  assert.equal((await indexRecordOfficialContainer(root,'Inbox/renamed.zip')).reused,true);
  for(const row of index.records){const extracted=await extractIndexedOfficialRecord(root,index,String(row['selector']));const record=assembleConversationRecord({...extracted,parserVersion:'1.1.20',timestamp});
    const source=record['source'] as JsonObject;assert.equal(source['format'],'zip-container');assert.equal(source['sha256'],sha(bytes));assert.equal(source['bytes'],bytes.length);assert.equal(source['file'],'renamed.zip');
    assert.equal(source['locator'],row['selector']);assert.match(String((record['title'] as JsonObject)['filename']),/^chat-(first|second)$/);assert(!JSON.stringify(record).includes('DO NOT APPEND TO CHAT'));
    if(row['title']==='chat-first')assert.equal(Buffer.from(((record['resources'] as JsonObject[])[0]!['data_base64'] as string[]).join(''),'base64').toString(),'attachment');
  }
  assert.deepEqual(await readFile(f),bytes);assert(!(await readdir(path.join(root,'Inbox'))).some(n=>n.endsWith('.assets')));
}));
test('manual ZIP copy uses normal Engine record selection, workers, history and per-record reparse',()=>temporary(async root=>{
  const bytes=fixtureZip([{name:'chat-first.json',data:mistral()},{name:'chat-second.json',data:mistral('second')}]);await writeFile(path.join(root,'Inbox/native.zip'),bytes);
  const engine=new RecordArchiverEngineCommands({libraryRoot:root,runtimeRoot:path.join(root,'cache'),clock:()=>timestamp});const context={request:'zip-test',signal:new AbortController().signal,emit:async()=>undefined};
  const call=async(name:string,payload:JsonObject)=>await engine.handlers()[name]!(payload,context) as JsonObject;
  try{const list=await call('archiver.sources.query',{offset:0,limit:50}),source=(list['items'] as JsonObject[])[0]!;
    const indexed=await call('archiver.claude.index',{source:source['capability']!}),container=indexed['container']!;
    const rows=await call('archiver.claude.records.query',{container,offset:0,limit:50}),selectors=(rows['items'] as JsonObject[]).map(r=>r['selector']!);
    let markPath='',mark='';
    for(const selected of [[selectors[0]!],[selectors[0]!,selectors[1]!]]){const p=await call('archiver.claude.extract.preview',{container,selectors:selected});const out=await call('archiver.claude.extract.commit',{plans:[p['plan']!]});assert.equal(out['failed'],0);assert.equal(out['completed'],selected.length);
      if(!mark){const saved=JSON.parse(await readFile(path.join(root,'Conversations',(await readdir(path.join(root,'Conversations')))[0]!),'utf8'));const markId=uuidV7();markPath=path.join(root,'Marks',markId+'.json');mark=JSON.stringify({schema:'cloudig/mark/1.0.0',mark_id:markId,target:saved.conversation_id,edited_at:timestamp,conversation_title:'Keep this title'});await writeFile(markPath,mark);}
      else assert.equal(await readFile(markPath,'utf8'),mark,'ZIP reparse must retain the exact user Mark');
    }
    assert.equal((await readdir(path.join(root,'Conversations'))).length,2,'reparse keeps its Conversation rather than adding a duplicate');
    const after=await call('archiver.claude.records.query',{container,offset:0,limit:50});assert((after['items'] as JsonObject[]).every(r=>r['status']==='parsed'));
  }finally{await engine.close();}
}));
test('an indexed ZIP changed on disk is refused, and cancelled indexing leaves no prepared JSON in cache',()=>temporary(async root=>{
  const file=path.join(root,'Inbox/change.zip');await writeFile(file,fixtureZip([{name:'chat-a.json',data:mistral()}]));
  const {index}=await indexRecordOfficialContainer(root,'Inbox/change.zip');await writeFile(file,fixtureZip([{name:'chat-a.json',data:mistral('changed')} ]));
  await assert.rejects(extractIndexedOfficialRecord(root,index,String(index.records[0]!['selector'])),/ZIP changed/);
  const cancel=new AbortController();await assert.rejects(indexRecordOfficialContainer(root,'Inbox/change.zip',{rebuild:true,signal:cancel.signal,onProgress:()=>cancel.abort()}),{name:'AbortError'});
  const remaining=await readdir(path.join(root,'cache'),{recursive:true});assert(!remaining.some(n=>/[a-f0-9]{64}\.json$/u.test(n)),'temporary decompressed JSON must be retired');
}));
test('unknown or incomplete ZIP does not prevent other Inbox sources being listed',()=>temporary(async root=>{
  await writeFile(path.join(root,'Inbox/bad.zip'),'not finished copying');await writeFile(path.join(root,'Inbox/good.json'),mistral());
  const rows=await scanRecordSources(root);assert.equal(rows.length,2);assert.equal(rows.find(r=>r.path.endsWith('good.json'))!.platform,'mistral');
}));
test('warm ZIP index reads no members; monotonic cold progress, source replacement, and legacy cache promotion',()=>temporary(async root=>{
  const file=path.join(root,'Inbox/warm.zip'),bytes=fixtureZip([{name:'chat-a.json',data:mistral('aa')},{name:'chat-b.json',data:mistral('bb')}]);
  await writeFile(file,bytes);const progress:{bytes:number;total:number}[]=[];
  const first=await indexRecordOfficialContainer(root,'Inbox/warm.zip',{onProgress:e=>progress.push(e)});
  assert(progress.every((e,i)=>e.bytes<=e.total&&(!i||e.bytes/e.total>=progress[i-1]!.bytes/progress[i-1]!.total)),'progress must not reset between staging and validation');
  const cache=path.join(root,'appdata/indexes/platform-json',sha(Buffer.from('Inbox/warm.zip'))+'.json');
  let opens=0;const original=OfficialZip.prototype.stage;
  OfficialZip.prototype.stage=async function(...args){opens++;return original.apply(this,args);};
  try{
    const hot=await indexRecordOfficialContainer(root,'Inbox/warm.zip');assert(hot.reused);assert.equal(opens,0);assert.deepEqual(hot.index,first.index);
    const legacy=JSON.parse(await readFile(cache,'utf8'));delete legacy.source_stamp;await writeFile(cache,JSON.stringify(legacy));
    assert((await indexRecordOfficialContainer(root,'Inbox/warm.zip')).reused);assert.equal(typeof JSON.parse(await readFile(cache,'utf8')).source_stamp,'string');assert.equal(opens,0);
    const previous=await lstat(file);await writeFile(file,fixtureZip([{name:'chat-a.json',data:mistral('cc')},{name:'chat-b.json',data:mistral('dd')}]));await utimes(file,previous.atime,previous.mtime);
    const changed=await indexRecordOfficialContainer(root,'Inbox/warm.zip');assert(!changed.reused);assert.notEqual(changed.index.source.sha256,first.index.source.sha256);assert.equal(opens,2);
    const cancel=new AbortController();cancel.abort();await assert.rejects(indexRecordOfficialContainer(root,'Inbox/warm.zip',{signal:cancel.signal}),{name:'AbortError'});
  }finally{OfficialZip.prototype.stage=original;}
}));
test('concurrent Engine hover and opening stage each ZIP member once',()=>temporary(async root=>{
  await writeFile(path.join(root,'Inbox/concurrent.zip'),fixtureZip([{name:'chat-a.json',data:mistral()}]));
  const engine=new RecordArchiverEngineCommands({libraryRoot:root,runtimeRoot:path.join(root,'cache')});
  const context={request:'concurrent',signal:new AbortController().signal,emit:async()=>{}};
  const call=async(name:string,payload:JsonObject)=>await engine.handlers()[name]!(payload,context) as JsonObject;
  const sources=await call('archiver.sources.query',{offset:0,limit:50}),source=(sources['items'] as JsonObject[])[0]!;
  let stages=0;const original=OfficialZip.prototype.stage;OfficialZip.prototype.stage=async function(...args){stages++;await new Promise(r=>setTimeout(r,30));return original.apply(this,args);};
  try{const values=await Promise.all([call('archiver.claude.index',{source:source['capability']!}),call('archiver.claude.index',{source:source['capability']!})]);assert.equal(stages,1);assert.equal(values[0]!['container'],values[1]!['container']);assert.equal(values[0]!['records'],1);}
  finally{OfficialZip.prototype.stage=original;await engine.close();}
}));
test('both private official ZIPs index every conversation and preserve the complete source bytes', {skip:!process.env['CLOUDIG_GROK_ZIP']||!process.env['CLOUDIG_MISTRAL_ZIP']},async()=>{
  for(const [platform,file] of [['grok',process.env['CLOUDIG_GROK_ZIP']],['mistral',process.env['CLOUDIG_MISTRAL_ZIP']]] as const)await temporary(async root=>{
    await copyFile(file!,path.join(root,'Inbox/source.zip'));const raw=await readFile(file!),{index}=await indexRecordOfficialContainer(root,'Inbox/source.zip');assert.equal(index.schema,'cloudig/official-zip-index/1.0.0');
    let embedded=0,nodes=0;for(const row of index.records){const x=await extractIndexedOfficialRecord(root,index,String(row['selector']));const record=assembleConversationRecord({...x,parserVersion:'1.1.20',timestamp});nodes+=(record['messages'] as JsonObject)['items'] instanceof Array?((record['messages'] as JsonObject)['items'] as unknown[]).length:0;embedded+=(record['resources'] as JsonObject[]??[]).filter(r=>r['availability']==='embedded').length;}
    assert.equal(sha(await readFile(file!)),sha(raw));console.log(JSON.stringify({platform,records:index.records.length,nodes,embedded,zipBytes:raw.length}));
  });
});
