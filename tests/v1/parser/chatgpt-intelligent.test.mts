import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptIntelligentUi } from "../../../src/adapters/parser/chatgpt-intelligent.mts";
import { DilSession, DIL_VIEW_FORMAT } from "../../../src/core/records/dil-program.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const code = `DIL.render(__dil.jsx(()=>{const c=DIL.useConstants();const [score,setScore]=DIL.useState(2,{key:"score"});return __dil.jsx(__dil.Fragment,null,
 __dil.jsx("text",null,"Example"),
 __dil.jsx("box",null,__dil.jsx("text",null,"Calculator"),__dil.jsx("slider",{min:0,max:100,value:score,onChange:setScore}),__dil.jsx("AsyncImage",{__resolutionId:"image"}),__dil.jsx("Link",{url:"sandbox:/sample.zip",title:"sample.zip"})),
 __dil.jsx("box",null,__dil.jsx("text",null,score*score)),
 __dil.jsx("__chatgptClientDefinedWidget",{invocationId:"app"}),
 __dil.jsx("__chatgptClientDefinedWidget",{invocationId:"diagram"})
 );}));`;
function fixture(){
 const writes:JsonObject[]=[];
 const record:JsonObject={message_id:"m1",resource_ids:["file","alias"],attachments:[{resource_id:"file",name:"sample.zip",sandbox_path:"/sample.zip"}],resolved_images:[{resource_id:"alias",source:{url:"https://images.test/one"}}],
  raw:{content:{parts:["Original UI"]},metadata:{model_dil_v2:{code,constants:{title:"Example"},appData:{opGenui:{componentResults:{image:{state:{url:"https://images.test/one"}}}}},clientDefinedWidgets:{app:{refIndex:0},diagram:{refIndex:1}}},content_references:[{category:"app_block",data:{title:"Canvas",content:"<canvas></canvas><script>draw()</script>"}},{category:"code_block",data:{language:"mermaid",content:"graph TD; A-->B"}}]}}};
 const extension:JsonObject={records:{m1:record},resources:{file:{id:"file",src:"data:application/zip;base64,eA==",mime_type:"application/zip"},alias:{alias_of:"image"},image:{id:"image",src:"data:image/png;base64,eA==",mime_type:"image/png"}}};
 const parser=new ChatGptIntelligentUi(extension,p=>{writes.push(p);return`r${writes.length}`;});
 const blocks=parser.project({intelligent_ui:{record_id:"m1"},html:'<div data-osis-native-component="box">Calculator<div data-osis-native-component="slider">7 (0–100)</div></div>'},["m1"],()=>"original-diagram")!;
 const bundle=JSON.parse(Buffer.from(String(writes.find(p=>p["name"]==="ui.json")!["src"]).split(",")[1]!,"base64").toString());
 return{parser,writes,blocks,bundle};
}
test("owned UI definition is saved once, split by native units, not by sparse fallback offsets",()=>{
 const f=fixture();assert.deepEqual(f.blocks.map(b=>b["type"]),["html","box","box","box","diagram"]);
 assert.equal(f.blocks[4]!["rendered"],"original-diagram");assert.equal(f.writes.filter(w=>w["name"]==="ui.json").length,1);
 const boxes=f.blocks.filter(b=>b["data"]);assert.ok(boxes.every(b=>(b["data"]as JsonObject)["format"]===DIL_VIEW_FORMAT));
 assert.deepEqual(boxes[0]!["files"],boxes[2]!["files"]);assert.equal(f.writes[0]!["name"],"sample.zip");
 const assets=(boxes[0]!["data"]as JsonObject)["assets"]as JsonObject[];assert.deepEqual(assets.map(a=>a["kind"]),["image","attachment"]);
 assert.equal(f.bundle.captured_state.score,7);const session=new DilSession(f.bundle.code,f.bundle.constants,f.bundle.app_data,f.bundle.captured_state);assert.match(JSON.stringify(session.render(2)),/49/u);
});
test("message ownership is mandatory and repeated projection cannot mutate the cached result",()=>{
 const f=fixture();assert.throws(()=>f.parser.project({intelligent_ui:{record_id:"m1"}},["m2"]),/different source message/u);
 f.blocks[1]!["type"]="changed";assert.equal(f.parser.project({intelligent_ui:{record_id:"m1"}},["m1"])![1]!["type"],"box");
 assert.equal(f.parser.project({type:"html",html:"old HTML"},["m1"]),undefined);
});
test("literal map icon evidence retains item order, ignores attachment chrome, and requires matching owner arity",()=>{
 const code='DIL.render(__dil.jsx("box",null,__dil.jsx("box",null,__dil.jsx("text",null,"Repeat label")),__dil.jsx("icon",{name:"arrow-down"}),[{label:"Alpha",icon:"first"},{label:"Beta",icon:"second"}].map(x=>__dil.jsx("row",null,__dil.jsx("icon",{name:x.icon}),__dil.jsx("text",null,x.label)))));';
 const svg=(d:string)=>`<svg data-d-component="icon" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
 const html=`<div data-osis-native-component="box"><div data-osis-native-component="box">Repeat label</div>${svg('M0 0v4')}<div data-osis-native-component="row">${svg('M1 0v4')}Alpha<a data-osis-ui-file-resource="attachment">${svg('M9 0v4')}</a></div><div data-osis-native-component="row">${svg('M2 0v4')}Beta</div></div>`;
 const writes:JsonObject[]=[],extension:JsonObject={records:{m:{message_id:"m",raw:{metadata:{model_dil_v2:{code,constants:{}}}}}}};
 const parser=new ChatGptIntelligentUi(extension,p=>{writes.push(p);return`r${writes.length}`;});parser.project({intelligent_ui:{record_id:"m"},html},["m"]);
 const bundle=JSON.parse(Buffer.from(String(writes.find(p=>p["name"]==="ui.json")!["src"]).split(',')[1]!,"base64").toString());assert.equal(bundle.code,code);assert.deepEqual(Object.keys(bundle.icons).sort(),["arrow-down","first","second"]);
 for(const[name,path]of[["first","M1 0v4"],["second","M2 0v4"]]){const value=writes.find(p=>p["name"]===`${name}.svg`)!;assert.ok(Buffer.from(String(value["src"]).split(',')[1]!,"base64").toString().includes(path!));}
 const ambiguous=new ChatGptIntelligentUi(extension,p=>{if(String(p["name"]).endsWith('.svg'))throw new Error('Ambiguous glyph claimed');return 'r';});
 ambiguous.project({intelligent_ui:{record_id:"m"},html:html+html},["m"]);
});
