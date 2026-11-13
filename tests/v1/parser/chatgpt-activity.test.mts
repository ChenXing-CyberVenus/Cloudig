import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { prepareChatGptActivities } from "../../../src/adapters/parser/chatgpt-activity.mts";
import { chatGptLightAdapter } from "../../../src/adapters/parser/chatgpt-light.mts";
import { chatGptFullAdapter } from "../../../src/adapters/parser/chatgpt-full.mts";
import { chatGptTreeAdapter } from "../../../src/adapters/parser/chatgpt-tree.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import type { SourceMessageFacts } from "../../../src/app/parser/adapter.mts";

const source = { file: "analysis.html", bytes: 1, sha256: "0".repeat(64) };
const body = (id: string, text = "Answer"): JsonObject => ({kind:"assistant",message_id:id,parts:[{type:"md",text}]});
const code = (id: string): JsonObject => ({kind:"code",message_id:id,analysis_call_id:id,recipient:"python.run",text:"print('same code')\n",reasoning_title:"Public title",reasoning_titles:["Public title","Second title"]});
const output = (id: string, call: string): JsonObject => ({kind:"tool",message_id:id,analysis_call_id:call,content_type:"execution_output",name:"python",text:"same output\nsecond line\n"});
const summary = (id: string, owner?: string): JsonObject => ({kind:"tool",message_id:id,presentation:"source_summary",name:"检索来源",...(owner?{source_owner_id:owner}:{}),queries:[],sources:[{title:"A",url:"https://example.test/a",domain:"example.test",snippet:"$5 and $6 <plain>"}],text:"结果：\n- [A](https://example.test/a) · example.test\n  $5 and $6 <plain>"});

test("analysis links never pair repeated text across user turns or mutate source payload",()=>{
  const original: JsonObject[]=[code("c1"),output("r1","c1"),body("a"),{kind:"user",message_id:"u",parts:[]},output("r2","c1"),code("c2"),output("r3","c2")];
  const frozen=structuredClone(original), prepared=prepareChatGptActivities(original);
  assert.deepEqual(original,frozen); assert.equal(prepared[1]!["analysis_call_id"],"c1");
  assert.equal(prepared[4]!["analysis_call_id"],undefined); assert.equal(prepared[6]!["analysis_call_id"],"c2");
  assert.equal(prepared.filter(i=>i["kind"]==="code").length,2);
});

test("ambiguous or forward calls and cross-turn source ownership stay independent",()=>{
  const values=prepareChatGptActivities([output("forward","c"),code("c"),code("c"),body("owner"),{kind:"user",parts:[]},summary("s","owner")]);
  assert(values.every(i=>!i["analysis_call_id"])); assert.equal(values.at(-1)!["message_id"],"s");
});

for(const adapter of [chatGptLightAdapter,chatGptFullAdapter,chatGptTreeAdapter]) test(`${adapter.manifest.id}: canonical calls, source Fronts and exact code/output survive`,async()=>{
  const items:JsonObject[]=[code("c"),output("r","c"),body("answer"),{kind:"thinking",thoughts:[{content:"Later thought"}]},summary("s","answer"),{kind:"tool",message_id:"web",name:"web.run",text:"Real search",queries:["query"]}];
  const payload=adapter===chatGptTreeAdapter?{turns:{a:{id:"a",role:"assistant",node_ids:["n"],children:[]}},turn_roots:["a"],current_turn:"a",items_by_node:{n:items}}:{items};
  const facts: SourceMessageFacts[]=[];
  const draft=await adapter.parse({source,manifest:{},payload,record:{message(i,f){facts[i]=f;},block(){},current(){},conversationModel(){}}});
  const content=(draft["messages"] as JsonObject[]).flatMap(m=>m["content"] as JsonObject[]);
  const call=content.find(b=>b["type"]==="tool"&&b["kind"]==="call")!;
  assert.equal(call["call"],"c"); assert.equal(call["input"],items[0]!["text"]); assert.equal(call["title"],"Public title · Second title");
  assert.equal(content.find(b=>b["call"]==="c"&&b["kind"]==="result")!["output"],items[1]!["text"]);
  const citation=content.findIndex(b=>b["type"]==="citations"&&b["label"]==="检索来源");
  assert(citation>0); assert.equal(content[citation-1]!["text"],"Answer"); assert.equal(content[citation+1]!["type"],"reasoning");
  assert.equal(content.filter(b=>b["type"]==="tool"&&b["kind"]==="result").length,2);
  assert.equal(content.filter(b=>b["type"]==="search").length,1);
  const record=assembleConversationRecord({parsed:{draft,adapter:adapter.manifest,sourceFingerprint:{bytes:1,sha256:source.sha256},systemLogErrors:[]},facts:{messages:facts,...(adapter===chatGptTreeAdapter?{current:"a"}:{})},parserVersion:"1.1.52",timestamp:"2026-11-04T20:00:00Z"});
  assert(!(record["identity"] as JsonObject[]).some(front=>JSON.stringify(front).includes("检索来源")));
  assert.equal((record["references"] as JsonObject[])[0]!["snippet"],"$5 and $6 <plain>");
});

test("extra source-summary prose is preserved; legacy Python and real search are not guessed",async()=>{
  const s=summary("s"); s["text"]="An original remark <not a source list>";
  const legacy=code("legacy"); delete legacy["analysis_call_id"];
  const draft=await chatGptLightAdapter.parse({source,manifest:{},payload:{items:[legacy,s]}});
  const content=(draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
  assert.equal(content[0]!["call"],undefined);
  assert(content.some(b=>b["type"]==="html"&&String(b["html"]).includes("An original remark &lt;not a source list&gt;")));
  assert(content.some(b=>b["type"]==="citations"));
});
