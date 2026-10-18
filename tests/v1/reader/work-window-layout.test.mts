import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindWorkWindowLayout, readWorkSize, workWindowHeight } from "../../../src/ui/shared/conversation-renderer/work-window-layout.mts";
import { interactiveClient } from "../../../src/ui/shared/conversation-renderer/interactive-client.mts";

test("flow windows fit contents while viewport works and long content share the available cap",()=>{
 assert.equal(workWindowHeight(900,60,{height:300,layout:"flow"}),360);
 assert.equal(workWindowHeight(900,60,{height:3000,layout:"flow"}),900);
 assert.equal(workWindowHeight(900,60,{height:1,layout:"viewport"}),900);
 assert.equal(readWorkSize(-1),undefined);assert.equal(readWorkSize({height:Infinity,layout:"flow"}),undefined);
 assert.equal(readWorkSize({height:50,layout:"bogus"}),undefined);assert.deepEqual(readWorkSize(250),{height:250,layout:"flow"});
});
test("size updates and viewport resize do not replace the running content; cleanup disconnects",()=>{
 const dom=new JSDOM('<dialog><header></header><div><iframe></iframe></div></dialog>'),d=dom.window.document,dialog=d.querySelector('dialog')!,header=d.querySelector('header')!,body=d.querySelector('div')!,frame=d.querySelector('iframe');
 Object.defineProperty(header,'getBoundingClientRect',{value:()=>({height:60})});
 const layout=bindWorkWindowLayout(dialog,header,body);layout.update({height:250,layout:"flow"});assert.equal(dialog.style.getPropertyValue('--cloudig-window-height'),'310px');
 layout.update({height:5000,layout:"flow"});assert.equal(dialog.style.getPropertyValue('--cloudig-window-height'),'744px');assert.equal(d.querySelector('iframe'),frame);
 Object.defineProperty(dom.window,'innerHeight',{value:900,writable:true});dom.window.dispatchEvent(new dom.window.Event('resize'));assert.equal(dialog.style.getPropertyValue('--cloudig-window-height'),'852px');
 layout.close();layout.update({height:1,layout:"flow"});assert.equal(dialog.style.getPropertyValue('--cloudig-window-height'),'852px');dom.window.close();
});
test("runtime detects authored viewport roots but not an internal control height",()=>{
 for(const [style,body,expected]of [
  ['body{height:100%}','<canvas></canvas>','viewport'],['.work{min-height:100vh}','<div id="root"><div class="work">Scene</div></div>','viewport'],
  ['button{height:100%}','<p>Text</p><button>Button</button>','flow'],['.chart{height:380px}','<div class="chart">Graph</div>','flow']]){
  const dom=new JSDOM(`<style>${style}</style>${body}`,{url:'https://work.test/',runScripts:'outside-only'}),sent:any[]=[];
  dom.window.postMessage=(v:any)=>{sent.push(v);};
  dom.window.eval(`(${interactiveClient.toString()})(${JSON.stringify({token:'size',state:{},stateLimit:1000,errorLimit:100,theme:'dawn'})})`);
  dom.window.dispatchEvent(new dom.window.Event('load'));assert.equal(sent.find(v=>v.kind==='resize')?.detail.layout,expected);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();
 }
});
