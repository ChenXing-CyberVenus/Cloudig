import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { curateClaudeExample, readJsonScript } from '../../../scripts/curate-claude-example.mjs';

function source() {
  const messages = [ ['original-a',null,'user'],['original-b','original-a','assistant'],['original-c','original-b','user'],['original-d','original-c','assistant'],['original-e','original-c','assistant'] ].map(([id,parent_id,role],index)=>({id,parent_id,role,index,
    blocks:[{type:'text',markdown:`Literal ${id}`,rich_html:`<p id="note-${id}">Literal ${id}</p><a href="#note-${id}">Note</a>`}]}));
  const payload={format:'osis.claude.chat-export/all-branches-v1',version:'test-tree',messages,conversation:{id:'private-id',title:'Original'},source_url:'https://claude.ai/chat/private-id',current_leaf_message_id:'original-e',active_message_ids:['original-a','original-b','original-c','original-e'],
    http_capture:{secret:'excluded'},raw_conversation:{secret:'excluded'},mounted_dom_articles:[{secret:'excluded'}],resources:[{key:'image-original-b',message_id:'original-b',data_ref:'r1'},{key:'image-original-c',message_id:'original-c',data_ref:'r2'}],resource_data:{r1:'data:text/plain;base64,b2xk',r2:'data:text/plain;base64,a2VwdA=='},artifacts:[]};
  const manifest={format:'ai-chat-archive/manifest-v1',platform:'claude',source:{organization_id:'private-org',url:payload.source_url},counts:{messages:99},capture:{complete:false},capture_diagnostics:{entries:[{message_id:'original-b',code:'removed'},{message_id:'original-c',code:'retained',resource_key:'image-original-c'}]}};
  const nav='<nav class="node-branch-nav assistant" data-parent-message-id="original-c"><button data-delta="-1">‹</button><span>1/2</span><button data-delta="1">›</button></nav>';
  return '<!doctype html><html><head><style>article{color:red}</style></head><body><main><header class="top"><h1>Original</h1><div class="meta">99</div></header><section class="conversation-tree">'+messages.map(m=>`<div class="tree-node" data-tree-message-id="${m.id}"><article class="turn ${m.role}" data-message-id="${m.id}">${m.blocks[0].rich_html}</article></div>`).join('')+`<section class="node-branch-group"><div class="node-branch-option" hidden>${nav}</div></section></section></main>`+
    `<script id="ai-chat-archive-manifest" type="application/json">${JSON.stringify(manifest)}</script><script id="claude-export-data" type="application/json">${JSON.stringify(payload)}</script><script id="claude-branch-navigation" type="application/json">{}</script><script>/* exporter script kept */</script></body></html>`;
}
test('curated tree owns its local IDs, topology, active path, markup references and resource ownership',()=>{
  const result=curateClaudeExample(source(),[0,2,3,4],'Claude-整树-Chat','source.html'), payload=readJsonScript(result.html,'claude-export-data').value, manifest=readJsonScript(result.html,'ai-chat-archive-manifest').value;
  assert.deepEqual(payload.messages.map(m=>m.id),['example-message-1','example-message-2','example-message-3','example-message-4']);
  assert.deepEqual(payload.messages.map(m=>m.parent_id),[null,'example-message-1','example-message-2','example-message-2']);
  assert.deepEqual(payload.active_message_ids,['example-message-1','example-message-2','example-message-4']);
  assert.equal(payload.branches.length,2); assert.equal(payload.tree_topology.max_depth,3); assert.equal(manifest.counts.messages,4);
  assert.equal(payload.messages[1].blocks[0].markdown,'Literal original-c'); assert.match(payload.messages[1].blocks[0].rich_html,/id="note-example-message-2">Literal original-c/u);
  assert.deepEqual(payload.resources,[{key:'image-example-message-2',message_id:'example-message-2',data_ref:'r2'}]);assert.deepEqual(Object.keys(payload.resource_data),['r2']);
  assert(!('raw_conversation' in payload));assert(!('mounted_dom_articles' in payload));assert(!('organization_id' in manifest.source));assert.equal(manifest.capture.complete,false);
  assert.deepEqual(manifest.capture_diagnostics.entries,[{message_id:'example-message-2',code:'retained',resource_key:'image-example-message-2'}]);
  const dom=new JSDOM(result.html),document=dom.window.document;
  assert.equal(document.querySelectorAll('article.turn').length,4); assert.equal(document.querySelectorAll('.node-branch-option').length,2);
  assert.equal(document.querySelector('.node-branch-group').dataset.selectedChildId,'example-message-4');
  assert.equal(document.querySelector('.node-branch-option:not([hidden])').dataset.childMessageId,'example-message-4');
  assert.deepEqual(JSON.parse(document.getElementById('claude-branch-navigation').textContent).children_by_id,payload.tree_topology.children_by_id);
  assert.equal(document.querySelector('style').textContent,'article{color:red}');assert.equal([...document.scripts].at(-1).textContent,'/* exporter script kept */');dom.window.close();
});
test('curation is deterministic and rejects incomplete selections rather than guessing',()=>{
  assert.equal(curateClaudeExample(source(),[0,2,3,4],'Example','source.html').html,curateClaudeExample(source(),[0,2,3,4],'Example','source.html').html);
  assert.throws(()=>curateClaudeExample(source(),[0,0],'Example','source.html'),/Duplicate selection/u);
  assert.throws(()=>curateClaudeExample(source(),[99],'Example','source.html'),/Invalid index/u);
});
