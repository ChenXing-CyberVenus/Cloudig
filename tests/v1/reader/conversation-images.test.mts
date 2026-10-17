import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationImages } from '../../../src/core/records/conversation-images.mts';
import { buildConversationMarkdown } from '../../../src/app/export/markdown.mts';
import { buildConversationPageCore } from '../../../src/app/reader/view-model-core.mts';
import type { JsonObject } from '../../../src/core/contracts/types.mts';
const resources=['body','other-branch','inline','nested','work','orphan','remote'].map(id=>({id,kind:'image',availability:id==='remote'?'metadata_only':'embedded',name:id+'.png',mime:'image/png',bytes:1,data_base64:['AA==']}));
const value:JsonObject={schema:'cloudig/conversation/1.0.0',archive:'a1',platform:'chatgpt',source:{file:'source.zip'},resources,messages:[
  {id:'root',role:'user',content:[{type:'image',resource:'body'}]},
  {id:'a',parent:'root',role:'assistant',content:[{type:'text',text:'answer'}]},
  {id:'b',parent:'root',role:'assistant',content:[{type:'image',resource:'other-branch'},{type:'html',html:'<img data-cloudig-resource="inline">'},
    {type:'tool',kind:'activity',content:[{type:'image',resource:'nested'}]}, {type:'interactive',files:[{path:'img.png',resource:'work'}]}]}
],current_message:'a'};
const resolved={archive:'a1',platform:'chatgpt',archiveLayer:'none' as const,models:[],userName:'User',assistantName:'AI',userAvatar:'',assistantAvatar:'',contentTime:{state:'unavailable' as const}};
test('unplaced images exclude all branches, inline/process/work references and missing bytes',()=>{
  assert.deepEqual(conversationImages(value).map(r=>r['id']),['orphan']);
  assert.deepEqual(conversationImages({...value,messages:{items:value['messages']!}}).map(r=>r['id']),['orphan']);
  const page={offset:0,limit:40};const view=buildConversationPageCore({conversation:value,resolved,page,navigationPage:page,branchPage:page},value);
  assert.deepEqual((view['conversation_images'] as JsonObject[]).map(r=>r['id']),['orphan']);
  assert.equal((view['conversation_images'] as JsonObject[])[0]!['data_base64'],undefined);
  assert.equal((view['pagination'] as JsonObject)['total_canonical'],3);
});
test('whole Markdown includes unplaced images; selected-message copy does not',()=>{
  const plan=buildConversationMarkdown({conversation:value,resolved,locale:'en'});
  const text=plan.parts.filter(p=>typeof p==='string').join('');assert.match(text,/Conversation images/);assert.match(text,/orphan.png/);assert(!text.includes('other-branch.png'));
  assert(plan.parts.some(p=>typeof p!=='string'&&p.resource==='orphan'));
  const partial=buildConversationMarkdown({conversation:value,resolved,locale:'en',messageIds:['a']});assert(!partial.parts.some(p=>typeof p==='string'&&p.includes('Conversation images')));
});
