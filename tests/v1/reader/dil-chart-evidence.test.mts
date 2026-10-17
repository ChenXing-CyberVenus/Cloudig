import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
import {savedDilChart} from "../../../src/ui/shared/conversation-renderer/dil-chart-evidence.mts";
import type {DilViewOptions} from "../../../src/ui/shared/conversation-renderer/dil-view.mts";

test("saved pie retains its original image and exposes named colours, zeros, duplicate labels and formatted values",async()=>{
 const dom=new JSDOM(),document=dom.window.document,abort=new AbortController();
 const source='<svg xmlns="http://www.w3.org/2000/svg" width="353" height="432"><path name="Same" data-recharts-item-index="0" data-recharts-item-data-key="n" fill="#123456"/><path name="Same" data-recharts-item-index="1" data-recharts-item-data-key="n" fill="#654321"/></svg>';
 let reads=0;const ctx={document,signal:abort.signal,language:"en",image:(path:string)=>{const i=document.createElement("img");i.dataset["path"]=path;return i;},readFile:async()=>{reads++;return{path:"plot.svg",mime:"image/svg+xml",bytes:new TextEncoder().encode(source).buffer};}} as unknown as DilViewOptions;
 const root=savedDilChart(ctx,"plot.svg",{content:{chartType:"pie",nameKey:"kind",valueKey:"n",series:[{dataKey:"n",label:"Amount"}],data:[{kind:"Same",n:0},{kind:"Same",n:3}],formattedData:[{n:"0.00"},{n:"3.00"}]}});document.body.append(root);
 await new Promise(r=>setImmediate(r));assert.equal(reads,1);assert.equal(root.querySelector('img')!.dataset['path'],'plot.svg');assert.deepEqual([...root.querySelectorAll('.cloudig-dil-chart-legend li')].map(n=>n.textContent),['Same: 0.00','Same: 3.00']);
 assert.deepEqual([...root.querySelectorAll<HTMLElement>('.cloudig-dil-chart-key')].map(n=>n.style.backgroundColor),['rgb(18, 52, 86)','rgb(101, 67, 33)']);assert.equal(root.querySelectorAll('tbody tr').length,2);assert.match(root.querySelector('thead')!.textContent!,/Amount/);assert.equal(root.querySelector<HTMLElement>('.cloudig-dil-chart-original')!.style.getPropertyValue('--cloudig-dil-plot-height'),'432px');dom.window.close();
});

test("saved charts do not invent colour matching and ignore cancelled evidence loads",async()=>{
 const dom=new JSDOM(),document=dom.window.document,abort=new AbortController();let resolve:(v:any)=>void=()=>{};
 const ctx={document,signal:abort.signal,language:"zh",image:()=>document.createElement('img'),readFile:()=>new Promise(r=>{resolve=r;})} as unknown as DilViewOptions;
 const root=savedDilChart(ctx,'plot.svg',{content:{chartType:'pie',data:[{name:'A',value:2}]}});assert.equal(root.querySelector<HTMLElement>('.cloudig-dil-chart-key')!.hidden,true);
 abort.abort();resolve({mime:'image/svg+xml',bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#123456"/></svg>').buffer});await new Promise(r=>setImmediate(r));assert.equal(root.querySelector<HTMLElement>('.cloudig-dil-chart-key')!.hidden,true);assert.match(root.textContent!,/A: 2/);dom.window.close();
});

test("split rich headings keep their spacing and native choices opt out of browser white fill",()=>{
 const css=readFileSync(new URL('../../../src/ui/shared/conversation-renderer/renderer.css',import.meta.url),'utf8'),dil=readFileSync(new URL('../../../src/ui/shared/conversation-renderer/dil-view.css',import.meta.url),'utf8');
 assert.match(css,/\.cloudig-rich > :first-child:not\(h1,h2,h3,h4,h5,h6\)/);assert.match(css,/\.cloudig-rich > :last-child:not\(h1,h2,h3,h4,h5,h6\)/);
 assert.match(dil,/input\[type="radio"\]\)\s*\{appearance:none;/);assert.match(dil,/background:var\(--cloudig-choice-off,#d68c80\)/);assert.match(dil,/--cloudig-choice-off:#7e5eff/);assert.match(dil,/height:var\(--cloudig-dil-plot-height,auto\)/);assert.doesNotMatch(dil,/data-chart-type="pie"\][^}]*height:/);
});
