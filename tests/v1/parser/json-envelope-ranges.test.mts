import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { streamTopLevelJsonObjectRanges } from '../../../src/adapters/parser/json-envelope-ranges.mts';
import { parseRecordJson } from '../../../src/core/records/json.mts';

async function ranges(value: string | Buffer, size = 1) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), parts: Buffer[] = [];
  for(let i=0;i<bytes.length;i+=size)parts.push(bytes.subarray(i,i+size));
  const result=[]; for await(const range of streamTopLevelJsonObjectRanges(Readable.from(parts)))result.push({ ...range, value: parseRecordJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(range.offset,range.offset+range.length))) });
  return result;
}
test('root envelope preserves exact byte ranges across UTF-8, escaped keys, nested values and BOM chunk boundaries', async()=>{
  const source='\ufeff {"conversations":[{"text":"你说\\\"hi\\\"\\n[{}]"}],"d\\u0061ta":[],"number":-1.25e3,"enabled":true,"none":null,"中文":"字"} \r\n';
  for(const size of [1,2,3,7,512]) {
    const result=await ranges(source,size);
    assert.deepEqual(result.map(r=>r.key),['conversations','data','number','enabled','none','中文']);
    assert.deepEqual(result.map(r=>r.value),[[{text:'你说"hi"\n[{}]'}],[],-1250,true,null,'字']);
  }
  assert.deepEqual(await ranges('{}'),[]);
});
test('envelopes reject ambiguous keys, invalid strings/separators and truncated input',async()=>{
  for(const source of ['[]','{"x":1,"x":2}','{"x":1,"\\u0078":2}','{"x":1,}','{"x":}','{"x":[] "y":0}','{"x":[1}}','{"x":"\\q"}','{"x":true false}','{"x":[]','{"x":[]}suffix'])await assert.rejects(ranges(source),source);
  await assert.rejects(ranges(Buffer.from([123,34,255,34,58,49,125])));
});
test('root object range scan responds to cancellation',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(async()=>{for await(const _ of streamTopLevelJsonObjectRanges(Readable.from(['{}']),{signal:controller.signal})){}},{name:'AbortError'});
});
