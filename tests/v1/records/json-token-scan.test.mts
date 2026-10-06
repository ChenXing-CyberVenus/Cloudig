import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRecordJson} from '../../../src/core/records/json.mts';
test('native quote search preserves escape parity, Unicode, all controls and duplicate keys',()=>{
  for(let n=0;n<32;n++){
    const value={['k'+ '\\'.repeat(n)+'"']:['\\'.repeat(n)+'"',String.fromCharCode(n),'中文😀'+'x'.repeat(20000)]};
    const text=JSON.stringify(value,null,2);assert.deepEqual(parseRecordJson(text),value);
  }
  for(const bad of ['{"a":1,"\\u0061":2}','"\\x00"','"\\uD800"','"\\uDC00"','"raw\nline"','"unterminated\\"','[1,]','[9007199254740993]','1e9999','0.10000000000000001','{} true'])assert.throws(()=>parseRecordJson(bad),SyntaxError,bad);
  let seed=7;const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  for(let i=0;i<2000;i++){let str='';for(let n=0;n<40;n++)str+=String.fromCodePoint(next()%0xd800);const value={text:str,n:i,a:[null,true,false,{},[]]};assert.deepEqual(parseRecordJson(JSON.stringify(value,null,i%5)),value);}
});
