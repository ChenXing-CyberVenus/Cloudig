import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderDilView, type DilContexts, type DilViewOptions } from "../../../src/ui/shared/conversation-renderer/dil-view.mts";
import { DIL_SOURCE_FORMAT, DIL_VIEW_FORMAT } from "../../../src/core/records/dil-program.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const code=`DIL.render(__dil.jsx(()=>{const [score,setScore]=DIL.useState(62,{key:"score"});const [open,setOpen]=DIL.useState(false,{key:"open"});return __dil.jsx(__dil.Fragment,null,
 __dil.jsx("box",null,__dil.jsx("text",null,score),__dil.jsx("slider",{value:score,min:0,max:100,onChange:setScore})),
 __dil.jsx("box",null,__dil.jsx("text",null,score*score),__dil.jsx("input",{value:String(score),onChange:s=>setScore(Number(s))})),
 __dil.jsx("box",null,__dil.jsx("popover",{open},__dil.jsx("popover-trigger",{onClick:()=>setOpen(!open)},"Details"),__dil.jsx("popover-content",null,"Hidden content")))
 );}));`;
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(program=code){
  const dom=new JSDOM("<!doctype html>",{url:"https://cloudig.test/"}),document=dom.window.document,controller=new AbortController(),cache:DilContexts=new Map();let reads=0;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const source=new TextEncoder().encode(JSON.stringify({format:DIL_SOURCE_FORMAT,source_message:"one",code:program,constants:{},captured_state:{score:62}}));
  const options:DilViewOptions={document,language:"en",theme:"dawn",signal:controller.signal,stateKey:crypto.randomUUID(),
    readFile:async()=>{reads++;return{path:"ui.json",mime:"application/json",bytes:source.buffer as ArrayBuffer};},
    attachment:()=>document.createElement("button"),image:()=>document.createElement("img"),text:v=>{const n=document.createElement("div");n.textContent=String(v["tex"]??v["text"]??"");return n;}};
  const mount=(root:number,type="box")=>{const block:JsonObject={type,source:"chatgpt.com_dil",format:"structured",title:"Example",data:{format:DIL_VIEW_FORMAT,root,text:"Saved"}};const el=renderDilView(options,block,cache);document.body.append(el);return el;};
  return{dom,document,controller,cache,options,mount,reads:()=>reads,close(){controller.abort();dom.window.close();}};
}
test("actual Box inputs update sibling cards through one loaded source context",async()=>{
  const s=setup();try{const a=s.mount(0),b=s.mount(1);await pause();assert.equal(s.reads(),1);
    const slider=a.querySelector<HTMLInputElement>('input[type="range"]')!,input=b.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.focus();input.value="63";input.dispatchEvent(new s.dom.window.Event("input",{bubbles:true}));
    assert.equal(a.querySelector<HTMLInputElement>('input[type="range"]'),slider);assert.equal(slider.value,"63");assert.match(b.textContent!,/3969/u);assert.equal(s.document.activeElement,input);
    slider.value="64";slider.dispatchEvent(new s.dom.window.Event("input",{bubbles:true}));assert.equal(input.value,"64");
    s.controller.abort();slider.value="65";slider.dispatchEvent(new s.dom.window.Event("input",{bubbles:true}));assert.equal(input.value,"64");
  }finally{s.close();}
});

test("range bounds precede value assignment through repaint, including negative and fractional domains",async()=>{
  for(const [min,max,step,start,values] of [[0,360,1,270,[180,359,360,0]],[-500,-100,1,-220,[-499,-100,-400]],[1000,2000,.25,1750.25,[1000,1999.75,2000]]] as const){
    const s=setup(`DIL.render(__dil.jsx(()=>{const [v,setV]=DIL.useState(${start},{key:"v"});return __dil.jsx("box",null,__dil.jsx("text",null,v),__dil.jsx("slider",{min:${min},max:${max},step:${step},value:v,onChange:setV}));}));`);
    try{const box=s.mount(0);await pause();const slider=box.querySelector<HTMLInputElement>('input[type=range]')!;assert.equal(Number(slider.value),start);
      for(const value of values){slider.value=String(value);slider.dispatchEvent(new s.dom.window.Event("input",{bubbles:true}));assert.equal(box.querySelector('input'),slider);assert.equal(Number(slider.value),value);assert.equal(box.querySelector('[data-dil-tag=text]')!.textContent,String(value));}
    }finally{s.close();}
  }
});

test("UI mounts and plain forms are unpainted; explicit content backgrounds remain source-owned",async()=>{
  const css=readFileSync(new URL('../../../src/ui/shared/conversation-renderer/dil-view.css',import.meta.url),'utf8');
  const mountRule=css.match(/\.cloudig-dil-view\s*\{([^}]+)\}/u)![1]!;
  assert.doesNotMatch(mountRule,/(?:^|;)\s*background(?:-color)?\s*:/u);
  assert.match(css,/\.cloudig-dil-view \.cloudig-dil-icon\s*\{[^}]*color:inherit;/u);
  const s=setup('DIL.render(__dil.jsx("box",null,__dil.jsx("form",{gap:2},__dil.jsx("input",{value:"name"})),__dil.jsx("box",{background:"surface-secondary"},"Preview"),__dil.jsx("box",{background:"#0B1530"},"Drawing"),__dil.jsx("form",{background:"#123456"},"Explicit source style")));');
  try{const root=s.mount(0);await pause();assert.equal(root.style.backgroundColor,'');
    const forms=root.querySelectorAll<HTMLElement>('[data-dil-tag=form]');assert.equal(forms[0]!.style.backgroundColor,'');assert.equal(forms[1]!.style.backgroundColor,'rgb(18, 52, 86)');
    const boxes=root.querySelectorAll<HTMLElement>('[data-dil-tag=box]');assert.equal(boxes[0]!.style.backgroundColor,'');assert.equal(boxes[1]!.style.backgroundColor,'var(--cloudig-dil-surface)');assert.equal(boxes[2]!.style.backgroundColor,'rgb(11, 21, 48)');
  }finally{s.close();}
});

test("native categorical charts distinguish points while explicit and multi-series colours remain authoritative",async()=>{
  for(const [series,data,expected]of [
    [[{type:"bar",dataKey:"a"}],[{label:"one",a:10},{label:"two",a:20},{label:"three",a:30}],["#0285ff","#924ff7","#fb6a22"]],
    [[{type:"bar",dataKey:"a",color:"#123456"}],[{label:"one",a:10},{label:"two",a:20,color:"#654321"}],["#123456","#654321"]],
    [[{type:"bar",dataKey:"a",color:"purple"},{type:"bar",dataKey:"b",color:"blue"}],[{label:"one",a:10,b:12},{label:"two",a:20,b:22}],["#924ff7","#924ff7","#0285ff","#0285ff"]]
  ]as const){
    const s=setup(`DIL.render(__dil.jsx("box",null,__dil.jsx("chart",{series:${JSON.stringify(series)},data:${JSON.stringify(data)},xAxis:"label",height:280})));`);
    try{const box=s.mount(0);await pause();assert.deepEqual([...box.querySelectorAll('.cloudig-box-chart-svg rect')].map(n=>n.getAttribute('fill')),expected);
      const wrapper=box.querySelector<HTMLElement>('.cloudig-dil-widget')!;assert.equal(wrapper.style.height,'');assert.equal(wrapper.style.minHeight,'280px');
    }finally{s.close();}
  }
});

test("source composition frames survive headings, layouts and nested surfaces",async()=>{
 const s=setup('DIL.render(__dil.jsx("grid",{columns:2},__dil.jsx("box",{border:true,radius:"xl",padding:3},__dil.jsx("text",null,__dil.jsx("bold",null,"Heading")),__dil.jsx("box",{background:"#123456",border:true,padding:3},"Content")),__dil.jsx("box",{border:true},"Bare callout")));');
 try{const root=s.mount(0);await pause();const section=root.querySelector<HTMLElement>('[data-dil-border]')!;assert.ok(section.style.border);assert.equal(section.style.borderRadius,'12px');assert.equal(section.style.backgroundColor,'');assert.equal(section.style.padding,'12px');
   const nested=section.querySelector<HTMLElement>('[data-dil-surface]')!;assert.equal(nested.style.backgroundColor,'rgb(18, 52, 86)');assert.ok(nested.style.border);assert.equal(root.querySelectorAll('[data-dil-section]').length,0);assert.ok([...root.querySelectorAll<HTMLElement>('[data-dil-border]')].find(n=>n.textContent==='Bare callout')!.style.border);
 }finally{s.close();}
});

test("neutral UI surfaces reuse the schedule panel, not opaque file backgrounds",()=>{
 const css=readFileSync(new URL('../../../src/ui/shared/conversation-renderer/dil-view.css',import.meta.url),'utf8');
 assert.match(css,/--cloudig-dil-canvas:transparent;/u);
 assert.match(css,/--cloudig-dil-surface:var\(--cloudig-panel\);/u);
 assert.match(css,/--cloudig-box-surface:var\(--cloudig-panel\);/u);
 assert.doesNotMatch(css,/--cloudig-file-surface/u);
 const boxes=readFileSync(new URL('../../../src/ui/shared/conversation-renderer/structured-box.css',import.meta.url),'utf8');
 assert.match(boxes,/background: var\(--cloudig-box-surface, var\(--cloudig-diagram-local-canvas\)\)/u);
 assert.match(boxes,/background: var\(--cloudig-box-surface, var\(--cloudig-file-surface,#ead8c0\)\)/u);
 assert.match(css,/data-dil-tag="card"\]\s*\{[^}]*border:1px solid var\(--cloudig-border\);[^}]*background:var\(--cloudig-panel\);/u);
});

test("native button variants have theme roles while literal artwork colours stay explicit",async()=>{
 const s=setup('DIL.render(__dil.jsx("box",null,__dil.jsx("button",null,"Primary"),__dil.jsx("button",{color:"secondary"},"Secondary"),__dil.jsx("button",{variant:"outline"},"Outline"),__dil.jsx("button",{background:"#123456",color:"#ffffff"},"Artwork")));');
 try{const root=s.mount(0);await pause();const buttons=[...root.querySelectorAll<HTMLElement>('button')];assert.deepEqual(buttons.map(n=>n.dataset['dilVariant']),['solid','outline','outline','solid']);assert.equal(buttons[0]!.dataset['dilDefaultColor'],'true');assert.equal(buttons[1]!.style.color,'');assert.equal(buttons[3]!.style.backgroundColor,'rgb(18, 52, 86)');assert.equal(buttons[3]!.style.color,'rgb(255, 255, 255)');assert.equal(buttons[3]!.dataset['dilDefaultColor'],undefined);
 }finally{s.close();}
});
test("hidden local content is not a separate Window and opens without losing state",async()=>{
  const s=setup();try{const a=s.mount(2);await pause();assert.doesNotMatch(a.textContent!,/Hidden content/u);
    a.querySelector<HTMLButtonElement>("button")!.click();assert.match(a.textContent!,/Hidden content/u);assert.equal(s.document.querySelectorAll("dialog").length,0);
    a.querySelector<HTMLButtonElement>("button")!.click();assert.doesNotMatch(a.textContent!,/Hidden content/u);
  }finally{s.close();}
});
test("Window delays source loading until open, shares its source with Box and closes on cancellation",async()=>{
  const s=setup();try{const work=s.mount(1,"window");await pause();assert.equal(s.reads(),0);
    work.querySelector<HTMLButtonElement>("button")!.click();await pause();assert.equal(s.document.querySelectorAll("dialog[open]").length,1);assert.equal(s.reads(),1);
    const box=s.mount(0);await pause();const slider=box.querySelector<HTMLInputElement>('input[type="range"]')!;slider.value="7";slider.dispatchEvent(new s.dom.window.Event("input",{bubbles:true}));
    assert.match(s.document.querySelector("dialog")!.textContent!,/49/u);assert.equal(s.reads(),1);
    s.controller.abort();assert.equal(s.document.querySelectorAll("dialog").length,0);
  }finally{s.close();}
});
