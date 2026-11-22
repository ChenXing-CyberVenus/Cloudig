import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {validateRecord, encodeRecord, decodeRecord} from '../../../src/core/records/index.mts';
import {referencedResources} from '../../../src/core/records/conversation-images.mts';
import {CONVERSATION_SCHEMA} from '../../../src/core/records/schema-registry.mts';
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/04-1.json',import.meta.url),'utf8'));
test('themed native diagrams validate references and preserve strict earlier schemas',()=>{
 const c=fixture();c.schema=CONVERSATION_SCHEMA;
 c.resources=['light','dark'].map((theme,i)=>{const b=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${theme}</text></svg>`);return{id:`native-${i}`,kind:'diagram',availability:'embedded',mime:'image/svg+xml',bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),data_base64:[b.toString('base64')]};});
 const diagram={type:'diagram',format:'mermaid',source:'graph LR; A-->B',rendered:'native-0',rendered_themes:{light:'native-0',dark:'native-1'}};
 c.messages.items.forEach((m:any)=>m.content=[]);c.messages.items[0].content=[diagram];
 assert.equal(validateRecord('conversation',c).ok,true);
 assert.equal(decodeRecord('conversation',encodeRecord('conversation',c)).ok,true);
 assert.deepEqual([...referencedResources([diagram])].sort(),['native-0','native-1']);
 for(const bad of [{dark:'absent'},{sepia:'native-1'},{}]){const v=structuredClone(c);v.messages.items[0].content[0].rendered_themes=bad;assert.equal(validateRecord('conversation',v).ok,false);}
 const noDefault=structuredClone(c);delete noDefault.messages.items[0].content[0].rendered;assert.equal(validateRecord('conversation',noDefault).ok,false);
 for(const version of ['1.0.0','1.0.1','1.0.2']){const old=structuredClone(c);old.schema=`cloudig/conversation/${version}`;assert.equal(validateRecord('conversation',old).ok,false);delete old.messages.items[0].content[0].rendered_themes;assert.equal(validateRecord('conversation',old).ok,true);}
 const missing=structuredClone(c);missing.resources[1].kind='file';missing.resources[1].mime='text/plain';assert.equal(validateRecord('conversation',missing).ok,false);
});
