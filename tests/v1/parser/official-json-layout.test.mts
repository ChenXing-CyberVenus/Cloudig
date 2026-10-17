import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {inspectOfficialJson,officialJsonArrayRanges,assertOfficialRecord} from '../../../src/adapters/parser/official-json-layout.mts';
import {parseJsonRange} from '../../../src/adapters/parser/json-array-stream.mts';
const base=path.resolve('tests/private/platform-json-layout');
test('official JSON routing uses record evidence, streams wrapped ranges and keeps offsets byte exact',async()=>{
  await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'owned-'));let passed=false;
  try {
    const samples=[
      ['claude',[{uuid:'c',chat_messages:[]}]],
      ['deepseek',[{id:'d',mapping:{root:{id:'root',message:null}}}]],
      ['grok',{metadata:'not a conversation',conversations:[{conversation:{id:'g'},responses:[]}],other:[]}],
      ['qwen',{success:true,data:[{id:'q',chat:{history:{messages:{}}}}]}],
      ['mistral',[{chatId:'m',id:'1',role:'user',content:'文字\nline'}]]
    ] as const;
    for(const [platform,value] of samples){
      const file=path.join(root,'misleading-conversations.json');await writeFile(file,'\ufeff  '+JSON.stringify(value));
      const layout=await inspectOfficialJson(file);assert.equal(layout.platform,platform);
      const ranges=[];for await(const range of officialJsonArrayRanges(file,layout.range))ranges.push(range);
      assert.equal(ranges.length,1);const parsed=await parseJsonRange(file,ranges[0]!);assertOfficialRecord(platform,parsed.value);
      assert.deepEqual(parsed.value,Array.isArray(value)?value[0]:(value as any).conversations?.[0]??(value as any).data[0]);
    }
    const file=path.join(root,'empty.json');await writeFile(file,'[]');await assert.rejects(inspectOfficialJson(file),/Unsupported/);
    assert.equal((await inspectOfficialJson(file,{emptyPlatform:'claude'})).platform,'claude');
    await writeFile(file,'{"conversations":[{"conversation":{"id":"g"},"responses":[]}],"conversations":[]}');await assert.rejects(inspectOfficialJson(file),/Duplicate/);
    const controller=new AbortController();controller.abort();await assert.rejects(inspectOfficialJson(file,{signal:controller.signal}),{name:'AbortError'});
    passed=true;
  } finally {if(passed){assert.equal(path.dirname(await realpath(root)),await realpath(base));assert(!(await lstat(root)).isSymbolicLink());await rm(root,{recursive:true});}}
});
