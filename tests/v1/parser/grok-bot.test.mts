// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { grokLightAdapter, grokTreeAdapter } from "../../../src/adapters/parser/grok.mts";

test("BOT preserves Light scope, source time, independent system identity and readonly card facts",async()=>{
 const facts=[],base={manifest:{platform:"grok",scope:"bot_timeline"},source:{file:"bot.html",sha256:"0".repeat(64),bytes:1},payload:{messages:[
 {source_id:"a",role:"user",text:"Question",timestamp:"2026-10-23T00:00:00Z"},
 {source_id:"b",role:"assistant",text:"Choose",bot_kind:"widget"},
 {source_id:"c",role:"system",text:"Name changed",bot_kind:"system"}
 ],bot:{format:"osis.grok.bot-timeline/v1",projections:[{entryId:"b",kind:"widget",prompt:"Choose a name",options:["One","Two"],respondedValue:"Custom",skipped:false},{entryId:"c",kind:"system",event:{type:"name-changed",from:"A",to:"B"}}]},
 images:[],artifacts:[]},reading:{images:[],mermaid:[],fragments:[{messageId:"a",html:'<div class="user-bubble"><time class="bot-time">Duplicated timestamp</time><p>Question</p></div>'}]},record:{message(i,f){facts[i]=f}}};
 const light=await grokLightAdapter.parse(base);
 assert.equal(light.source.profile,"light");assert.equal(light.messages[0].timestamp,"2026-10-23T00:00:00.000Z");
 assert.ok(!JSON.stringify(light.messages[0].content).includes("Duplicated timestamp"));
 assert.equal(light.messages[1].content[0].title,"Choose a name");assert.equal(light.messages[1].content[0].data.entry.respondedValue,"Custom");assert.equal(facts[2].role,"system");
 const tree=await grokTreeAdapter.parse(base);assert.equal(tree.messages.length,3);assert.equal(tree.source.profile,"full");
});
