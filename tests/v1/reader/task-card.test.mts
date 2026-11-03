import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderTaskList, taskTimeLabel } from "../../../src/ui/shared/conversation-renderer/task-card.mts";
import { renderDilView } from "../../../src/ui/shared/conversation-renderer/dil-view.mts";
import { DIL_SOURCE_FORMAT, DIL_VIEW_FORMAT } from "../../../src/core/records/dil-program.mts";
const pause=()=>new Promise<void>(r=>setImmediate(r));
test("task dates use the declared zone and retain explicit instants when the zone is absent or invalid",()=>{
 assert.equal(taskTimeLabel("2026-11-09T04:00:00.000Z","America/Los_Angeles"),"2026-11-08 20:00 GMT-8");
 assert.equal(taskTimeLabel("2026-07-06T03:00:00.000Z","America/Los_Angeles"),"2026-07-05 20:00 GMT-7");
 for(const zone of ["","Invalid/Zone"])assert.equal(taskTimeLabel("2026-11-09T04:00:00.000Z",zone),"2026-11-09T04:00:00.000Z");
});
test("task status is on the closed face; historical plans stay distinct and source cannot execute",async()=>{
 for(const language of ["zh","en"]as const){const dom=new JSDOM('<div id="root"></div>'),d=dom.window.document,root=d.querySelector<HTMLElement>('#root')!;
 try{renderTaskList(root,{kind:"task-list",tasks:[{title:"<script>Task</script>",enabled:false,next_run_at:"2026-11-09",prompt:"Details",source_task:{is_enabled:false},url:"javascript:alert(1)"}]},{language,richText:s=>{const p=d.createElement('p');p.textContent=s;return p;}});
 const fold=root.querySelector('details')!,summary=fold.querySelector('summary')!;assert.equal(fold.open,false);assert.match(summary.textContent!,language==='en'?/Recorded: Paused/:/记录状态：已暂停/);assert.equal(root.querySelector('script,a'),null);
 assert.equal(root.querySelector('.cloudig-fold-body')!.textContent,'');fold.open=true;fold.dispatchEvent(new dom.window.Event('toggle'));
 assert.match(fold.textContent!,language==='en'?/Previously scheduled/:/原计划时间/);assert.doesNotMatch(fold.textContent!,language==='en'?/Next scheduled run/:/下次计划/);
 }finally{dom.window.close();}}
});
test("DisplayAutomation supports new and preexisting DIL bundles, without live service actions",async()=>{
 for(const snapshot of [false,true]){const dom=new JSDOM('<body></body>'),d=dom.window.document,abort=new AbortController();
 const code='DIL.render(__dil.jsx(DisplayAutomation,{automation_id:"t",__resolutionId:"r"}));';
 const state={id:"t",title:"Task",status:"active",url:"https://chatgpt.com/scheduled/automation/t"};
 const source=new TextEncoder().encode(JSON.stringify({format:DIL_SOURCE_FORMAT,source_message:"m",code,constants:{},app_data:{opGenui:{componentResults:{r:{state}}}},...(snapshot?{task_snapshots:{t:{id:"t",title:"Task",enabled:false,status:"paused",source_evidence:{source:"automation_api",captured_at:"2026-11-02T00:00:00Z"}}}}:{})}));
 try{const view=renderDilView({document:d,language:"en",theme:"star-night",signal:abort.signal,stateKey:crypto.randomUUID(),readFile:async()=>({path:"ui.json",mime:"application/json",bytes:source.buffer}),attachment:()=>d.createElement('button'),image:()=>d.createElement('img'),text:v=>{const n=d.createElement('p');n.textContent=String(v['text']);return n;}},{type:"box",source:"chatgpt.com_dil",data:{format:DIL_VIEW_FORMAT,root:0}},new Map());d.body.append(view);await pause();
 assert.equal(view.querySelectorAll('.cloudig-schedule-task').length,1);assert.match(view.textContent!,snapshot?/At capture: Paused/:/Recorded: Enabled/);assert.equal(view.querySelectorAll('button').length,0);
 }finally{abort.abort();dom.window.close();}}
});
