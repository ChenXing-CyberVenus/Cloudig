import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptIntelligentUi } from "../../../src/adapters/parser/chatgpt-intelligent.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

function project(code:string,html=""){
 const writes:JsonObject[]=[],extension:JsonObject={records:{m:{message_id:"m",raw:{metadata:{model_dil_v2:{code,constants:{},appData:{}}}},capture:{palette:{danger:"#e02e2a"}}}},resources:{}};
 const adapter=new ChatGptIntelligentUi(extension,p=>{writes.push(p);return`r${writes.length}`;});
 const blocks=adapter.project({intelligent_ui:{record_id:"m"},html},["m"])!;
 const entry=writes.find(p=>p["name"]==="ui.json");const bundle=entry?JSON.parse(Buffer.from(String(entry["src"]).split(",")[1]!,"base64").toString()):undefined;
 return{writes,blocks,bundle};
}
test("static text shortcut cannot discard authored hierarchy, emphasis or inline units",()=>{
 const p=project('DIL.render(__dil.jsx(()=>{return __dil.jsx(__dil.Fragment,null,__dil.jsx("text",null,"Plain"),__dil.jsx("title",{size:"lg",color:"danger"},"Heading"),__dil.jsx("text",{inline:true,size:"sm"},"kg"));}));');
 assert.deepEqual(p.blocks.map(b=>b["type"]),["html","box","box"]);assert.equal(p.blocks[0]!["html"],"<p>Plain</p>");
 assert.equal(p.bundle.captured.palette.danger,"#e02e2a");assert.match(p.bundle.code,/inline:true/u);
});
test("icons align inside their own text/table cell, not an unrelated global SVG ordinal",()=>{
 const code='DIL.render(__dil.jsx("table",null,__dil.jsx("table-row",null,__dil.jsx("table-cell",null,__dil.jsx("text",null,__dil.jsx("icon",{name:"sun"}),"Meal")))));';
 const html='<svg data-d-component="icon"><path d="M99 99"/></svg><table data-osis-native-component="table"><tr data-osis-native-component="table-row"><td data-osis-native-component="table-cell"><p data-osis-native-component="text"><svg data-d-component="icon" viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>Meal</p></td></tr></table>';
 const p=project(code,html);assert.ok(p.bundle.icons.sun);const svg=p.writes.find(w=>w["name"]==="sun.svg")!;
 assert.match(Buffer.from(String(svg["src"]).split(",")[1]!,"base64").toString(),/M1 1L2 2/u);
 const ambiguous=project(code,html+html);assert.equal(ambiguous.bundle.icons.sun,undefined);
});
