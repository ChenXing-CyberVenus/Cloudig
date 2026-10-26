import test from "node:test";
import assert from "node:assert/strict";
import {kimiLightAdapter,kimiFullAdapter,kimiTreeAdapter} from "../../../src/adapters/parser/kimi.mts";
import {yuanbaoLightAdapter,yuanbaoFullAdapter} from "../../../src/adapters/parser/yuanbao.mts";
import {assembleConversationRecord} from "../../../src/app/parser/conversation-record.mts";
import {frontName} from "../../../src/core/records/front.mts";
import type {JsonObject} from "../../../src/core/contracts/types.mts";
import type {SourceMessageFacts} from "../../../src/app/parser/adapter.mts";

test("Kimi Light/Full/Tree keep per-message time without turning the final selector into historical authorship",async()=>{
 for(const adapter of [kimiLightAdapter,kimiFullAdapter,kimiTreeAdapter]){
  const messages:SourceMessageFacts[]=[], models:string[]=[];
  const raw=[{id:"u",role:"user",api:{create_time:{seconds:"1784163705",nanos:818491000}}},{id:"a",role:"assistant",parent_id:"u",api:{create_time:{seconds:"1784163707",nanos:123456789}}}];
  const draft=await adapter.parse({manifest:{source:{model:"Selector A"}},source:{file:"title Model B.html",sha256:"a".repeat(64),bytes:1},payload:{chat:{model:"Selector A",lastRequest:{options:{model:"Selector A"}}},messages:raw,message_order:["u","a"],tree:{nodes:raw},active_path_message_ids:["u","a"]},reading:{fragments:[{messageId:"u",html:"<p>Question</p>"},{messageId:"a",html:"<p>Answer</p>"}],images:[],files:[],mermaid:[]},record:{message(i,f){messages[i]=f},current(){},block(){},conversationModel(v){models.push(v)}}});
  assert.deepEqual(models,[]);
  const record=assembleConversationRecord({parsed:{draft,adapter:adapter.manifest,sourceFingerprint:{sha256:"a".repeat(64),bytes:1},systemLogErrors:[]},facts:{messages,current:"a"},parserVersion:"1.1.49",timestamp:"2026-10-25T00:00:00.000Z"});
  const items=(record["messages"] as JsonObject)["items"] as JsonObject[],fronts=record["identity"] as JsonObject[];
  assert.deepEqual(items.map(m=>m["timestamp"]),["2026-07-16T01:01:45.818Z","2026-07-16T01:01:47.123Z"]);
  assert.equal(frontName(fronts.find(f=>f["source_id"]===items[1]!["speaker"])),"Kimi");
  assert.deepEqual(record["models"]??[],[]);
 }
});

test("Yuanbao binds native seconds/ISO to each message and never borrows export or adjacent times",async()=>{
 for(const adapter of [yuanbaoLightAdapter,yuanbaoFullAdapter]){
  const raw=[{id:"u",role:"user",timestamps:{create_time:1784185775,created_at:"2026-07-16T07:09:35.000Z",source:"native_convs.createTime"}},{id:"a",role:"assistant",timestamps:{created_at:"2026-07-16T07:09:39.000Z"}},{id:"old",role:"assistant"},{id:"bad",role:"user",timestamps:{create_time:-1,created_at:"invalid"}}];
  const context={manifest:{exported_at:"2026-10-25T00:00:00Z"},source:{file:"old.html",sha256:"b".repeat(64),bytes:1},payload:{messages:raw,message_order:raw.map(m=>m.id)},reading:{fragments:raw.map(m=>({messageId:m.id,html:"<p>Same source content</p>"})),images:[],files:[],mermaid:[]}};
  const draft=await adapter.parse(context),messages=draft["messages"] as JsonObject[];
  assert.deepEqual(messages.map(m=>m["timestamp"]),["2026-07-16T07:09:35.000Z","2026-07-16T07:09:39.000Z",undefined,undefined]);
  assert.deepEqual(draft["message_time"],{start:"2026-07-16T07:09:35.000Z",end:"2026-07-16T07:09:39.000Z"});
  const legacy=await adapter.parse({...context,payload:{...context.payload,messages:raw.map(({timestamps,...m})=>m)}});
  assert.equal(legacy["message_time"],undefined);
  assert.deepEqual((legacy["messages"] as JsonObject[]).map(m=>m["content"]),messages.map(m=>m["content"]));
 }
});
