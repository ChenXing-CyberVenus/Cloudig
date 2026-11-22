import test from "node:test";
import assert from "node:assert/strict";
import { ChatGptWork } from "../../../src/adapters/parser/chatgpt-work.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import type { SourceMessageFacts } from "../../../src/app/parser/adapter.mts";

test("Work activity associates each reply with its child turn and leaves parent waits unassigned", () => {
  const speakers = new Map<JsonObject,SourceMessageFacts>();
  const turn = (id:string) => ({id,items:[{type:"agentMessage",phase:"final_answer",text:id}]});
  const project = new ChatGptWork({subagent_cards:[{thread_id:"child",displayName:"Editor",turns:[turn("two"),turn("one")]}]},undefined,
    {block(value,facts){speakers.set(value,facts);},current(){},conversationModel(){},message(){}});
  for(const id of ["one","two","absent"]){
    const block=project.activity({subagent_event:{thread:"child",action:"completed",raw:{id:"subagent-completed-"+id}}});
    assert.equal(speakers.get(block)?.sourceId,"agent-thread:child");
    assert.deepEqual(block["content"],id==="absent"?undefined:[{type:"markdown",text:id}]);
  }
  const waiting=project.activity({subagent_event:{action:"wait",raw:{}}});
  assert(!speakers.has(waiting));assert(!waiting["content"]);
});

test("only the owning message receives a Site, with a Window only for an actual saved document", () => {
  const project={project_id:"p",url:"https://example.org",preview:"data:image/png;base64,example",version_at_capture:4};
  const messages=[{message_id:"m",project_id:"p"}];
  for(const embedded of [false,true]){
    const work=new ChatGptWork({}, {messages,projects:[{...project,...(embedded?{document:"data:text/html;base64,PGgxPkE8L2gxPg==",document_bytes:10}:{})}]});
    const write=(part:JsonObject)=>part["type"]==="img"?"preview-id":"document-id";
    assert.deepEqual(work.siteBlocks({message_id:"other"},write),[]);
    const blocks=work.siteBlocks({message_id:"m"},write);
    assert.deepEqual(blocks.map(b=>b["type"]),embedded?["box","window"]:["box"]);
    assert.deepEqual(blocks[0]!["files"],[{path:"preview",resource:"preview-id"}]);
    if(embedded)assert.deepEqual(blocks[1]!["files"],[{path:"index.html",resource:"document-id"}]);
  }
});
