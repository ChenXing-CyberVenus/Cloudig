import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { DilSession, DIL_SOURCE_FORMAT, DIL_VIEW_FORMAT } from "../../../src/core/records/dil-program.mts";
import { renderDilView } from "../../../src/ui/shared/conversation-renderer/dil-view.mts";

test("source-backed top-level headings retain section spacing and citation links stay separated",()=>{
 const css=readFileSync('src/ui/shared/conversation-renderer/dil-view.css','utf8');
 assert.match(css,/\.cloudig-message-content>\.cloudig-dil-view:not\(:first-child\)>\[data-dil-tag="title"\] \{margin-block:1\.15em \.5em;/u);
 assert.match(css,/\.cloudig-dil-citations>a\+a[^{]*\{margin-inline-start:\.45em;/u);
});

test("resolved suggestions remain display-only; empty memory evidence is not invented",async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://cloudig.test/'}),controller=new AbortController(),document=dom.window.document;
 const code='DIL.render(__dil.jsx("box",null,__dil.jsx(SuggestAutomation,{label:"Fallback",__resolutionId:"a"}),__dil.jsx(MemoryCite,{__resolutionId:"b"}),__dil.jsx(MemoryCite,{__resolutionId:"c"}),__dil.jsx("title",{size:"xl",color:"danger"},"12")));';
 const app_data={opGenui:{componentResults:{a:{componentName:"SuggestAutomation",state:{label:"Keep observing",submitted:false,creation_guidelines:"PRIVATE INSTRUCTION"}},b:{componentName:"MemoryCite",state:{}},c:{componentName:"MemoryCite",state:{items:[{title:"Saved memory",url:"https://example.test/memory"}]}}}}};
 const bytes=new TextEncoder().encode(JSON.stringify({format:DIL_SOURCE_FORMAT,source_message:"m",code,constants:{},app_data,captured:{palette:{danger:"#e02e2a","surface-primary":"#fff"}}}));
 try{
 const root=renderDilView({document,language:"en",theme:"dawn",signal:controller.signal,stateKey:"resolved",
  readFile:async()=>({path:"ui.json",mime:"application/json",bytes:bytes.buffer}),image:()=>document.createElement("img"),attachment:()=>document.createElement("span"),text:()=>document.createElement("span")},
 {type:"box",source:"chatgpt.com_dil",format:"structured",data:{format:DIL_VIEW_FORMAT,root:0}},new Map());document.body.append(root);
 await new Promise(resolve=>setImmediate(resolve));assert.match(root.textContent!,/Keep observing/u);assert.doesNotMatch(root.textContent!,/PRIVATE INSTRUCTION|Fallback/u);
 assert.equal(root.querySelector('.cloudig-dil-suggestion')!.getAttribute('aria-disabled'),'true');assert.equal(root.querySelectorAll('.cloudig-dil-memory-cite a').length,1);
 assert.equal(root.style.getPropertyValue('--cloudig-dil-danger'),'#e02e2a');assert.equal(root.style.backgroundColor,'');assert.equal(root.querySelector<HTMLElement>('[data-dil-tag=title]')!.style.fontSize,'24px');
 }finally{controller.abort();dom.window.close();}
});
test("padding is a bounded pure string operation, not general method execution",()=>{
 const make=(expression:string)=>new DilSession(`DIL.render(__dil.jsx("text",null,${expression}));`,{});
 assert.deepEqual(make('String(3).padStart(2,"0")').render(0).children,['03']);
 assert.deepEqual(make('"x".padEnd(3,".")').render(0).children,['x..']);
 assert.throws(()=>make('"x".padStart(1000000000)').render(0),/budget/u);
 assert.throws(()=>make('"x".constructor("return globalThis")').render(0),/Unsupported/u);
});
