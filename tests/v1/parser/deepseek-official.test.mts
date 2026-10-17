import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {extractDeepSeekOfficial} from '../../../src/adapters/parser/deepseek-official.mts';
import {assembleConversationRecord} from '../../../src/app/parser/conversation-record.mts';
import type {JsonObject} from '../../../src/core/contracts/types.mts';
import {projectMarkdownWithDiagrams} from '../../../src/adapters/parser/markdown-diagrams.mts';
const source={file:'conversations.json',bytes:123,sha256:'a'.repeat(64)};
const make=(record:JsonObject)=>assembleConversationRecord({...extractDeepSeekOfficial({record,source}),parserVersion:'1.1.18',timestamp:'2026-09-28T12:00:00Z'});
test('DeepSeek official fragments preserve source tree, explicit models, processes and resource metadata',()=>{
  const record:JsonObject={id:'c1',title:'Original',mapping:{root:{id:'root',parent:null,message:null},u:{id:'u',parent:'root',message:{model:'selected-not-authorship',fragments:[{type:'REQUEST',content:'first\nsecond'},{type:'FILE',files:[{file_id:'f1',file_name:'paper.docx',file_size:25}]}]}},a:{id:'a',parent:'u',message:{model:'deepseek-reasoner',fragments:[{type:'THINK',content:'Thought\nline'},{type:'SEARCH',results:[{url:'https://example.com',title:'Evidence'}]},{type:'TOOL_OPEN'},{type:'RESPONSE',content:'Answer'}]}},b:{id:'b',parent:'u',message:{model:'deepseek-chat',fragments:[{type:'RESPONSE',content:'Other branch'}]}}},current_node:'b'};
  const before=structuredClone(record), out=make(record), messages=(out['messages'] as JsonObject)['items'] as JsonObject[];
  assert.deepEqual(record,before);assert.deepEqual(messages.map(m=>[m['id'],m['parent']]),[['root',undefined],['u','root'],['a','u'],['b','u']]);
  assert.equal((out['messages'] as JsonObject)['current'],'b');
  assert.deepEqual((messages[2]!['content'] as JsonObject[]).map(b=>b['type']),['reasoning','search','tool','markdown']);
  assert.equal((messages[1]!['content'] as JsonObject[])[0]!['text'],'first\nsecond');
  assert.deepEqual(out['models'],['deepseek-reasoner','deepseek-chat']);
  assert.equal((out['resources'] as JsonObject[])[0]!['availability'],'metadata_only');
  assert.equal((out['references'] as JsonObject[])[0]!['title'],'Evidence');
  assert.equal(out['content_time'],undefined);
});
test('unknown fragments remain readable and duplicate identity disagreement is rejected',()=>{
  const r:JsonObject={id:'c',mapping:{a:{id:'a',parent:'missing',message:{fragments:[{type:'FUTURE',extra:{value:42}}]}}}};
  const out=make(r), content=((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['content'] as JsonObject[];
  assert.equal(JSON.parse(String(content[0]!['text'])).extra.value,42);assert.equal(((out['messages'] as JsonObject)['items'] as JsonObject[])[0]!['parent'],'missing');
  (r['mapping'] as JsonObject)['a']={id:'different',message:null};assert.throws(()=>make(r),/disagree/);
});
test('full private official DeepSeek export preserves all source nodes, parents and text fragments',{skip:!process.env['CLOUDIG_DEEPSEEK_OFFICIAL']},async()=>{
  const records=JSON.parse(await readFile(process.env['CLOUDIG_DEEPSEEK_OFFICIAL']!,'utf8')) as JsonObject[];let messages=0;
  for(const record of records){
    const out=make(record), projected=(out['messages'] as JsonObject)['items'] as JsonObject[], mapping=record['mapping'] as JsonObject;
    assert.equal(projected.length,Object.keys(mapping).length);messages+=projected.length;
    for(const message of projected){
      const node=mapping[String(message['id'])] as JsonObject; assert.equal(message['parent'],node['parent']??undefined);
      const raw=node['message'] as JsonObject|null;
      const actual=message['content'] as JsonObject[]; let cursor=0;
      for(const f of raw?.['fragments'] as JsonObject[]??[])if(['REQUEST','RESPONSE','THINK'].includes(String(f['type']))) {
        const expected=f['type']==='THINK'?[{type:'reasoning',text:f['content'],format:'markdown'}]:projectMarkdownWithDiagrams(String(f['content']));
        for(const block of expected){const index=actual.findIndex((b,i)=>i>=cursor&&JSON.stringify(b)===JSON.stringify(block));assert(index>=0,`Source text/diagram order differs at ${message['id']}`);cursor=index+1;}
      }
    }
  }
  console.log(JSON.stringify({records:records.length,nodes:messages}));
});
