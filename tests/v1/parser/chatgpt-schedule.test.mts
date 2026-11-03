import assert from "node:assert/strict";
import test from "node:test";
import { chatGptLightAdapter } from "../../../src/adapters/parser/chatgpt-light.mts";
import { taskView, ownedTaskView, readableTask } from "../../../src/core/records/chatgpt-task.mts";
import { DilSession } from "../../../src/core/records/dil-program.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

test("task observations separate paused/completed plans, null dates and current evidence", () => {
  const task = { id: "t", title: "Task", is_enabled: false, next_run_times: ["2026-11-08T20:00:00-08:00"], last_run_time: null };
  const paused = taskView(task, {}, { source: "automation_api", captured_at: "2026-11-02T00:00:00Z" });
  assert.equal(paused["status"], "paused"); assert.equal(paused["next_run_at"], undefined);
  assert.equal(paused["last_run_at"], undefined); assert.equal(paused["planned_run_at"], "2026-11-09T04:00:00.000Z");
  assert.deepEqual(paused["source_task"], task); assert.ok(paused["source_evidence"]);
  assert.equal(taskView({ ...task, status: "completed", is_enabled: true })["status"], "completed");
  assert.equal(taskView({ title: "Unknown", next_run_time: null })["status"], "unknown");
  const bad = ownedTaskView({ tasks: { t: { id: "other", title: "Wrong" } }, task_sources: { t: { source: "automation_api", captured_at: "2026-11-02" } } }, "t", { id: "t", title: "Right", status: "active" });
  assert.equal(bad["title"], "Right"); assert.equal(bad["source_evidence"], undefined);
  const old: JsonObject = { enabled: false, next_run_at: "2026-11-03", source_task: task };
  assert.equal(readableTask(old)["next_run_at"], undefined); assert.equal(old["next_run_at"], "2026-11-03");
});

const code='DIL.render(__dil.jsx(__dil.Fragment,null,__dil.jsx("text",null,"Before"),__dil.jsx(DisplayAutomation,{automation_id:"task",__resolutionId:"resolution"}),__dil.jsx("text",null,"After")));';
async function project(inline = true, definition = code, owner = "m") {
  const state = { id: "task", title: "Saved task", status: "active" };
  const components: JsonObject = { lists: [{ message_id: "m", inline, tasks: [state] }], tasks: { task: { ...state, is_enabled: false }, other: { id: "other", title: "Query result, not a card" } }, task_sources: { task: { source: "automation_api", captured_at: "2026-11-02T00:00:00Z" } } };
  return chatGptLightAdapter.parse({manifest:{},source:{file:"task.html",bytes:1,sha256:"0".repeat(64)},
    payload:{items:[{kind:"assistant",message_id:"m",parts:[{type:"html",intelligent_ui:{record_id:owner}}]}],scheduled_components:components},
    extensions:{chatgptIntelligentUi:{records:{m:{message_id:"m",raw:{metadata:{model_dil_v2:{code:definition,constants:{},appData:{opGenui:{componentResults:{resolution:{state}}}}}}}}}}},
    record:{message(){},current(){},conversationModel(){},block(){}}});
}
test("new tasks stay between surrounding prose once, preserve matched snapshots and source program",async()=>{
  const d=await project(), blocks=(d["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
  assert.deepEqual(blocks.map(x=>x["type"]),["html","box","html"]);
  assert.match(String(blocks[0]!["html"]),/Before/);assert.match(String(blocks[2]!["html"]),/After/);
  assert.match(String((blocks[1]!["data"] as JsonObject)["text"]),/Saved task/);
  const resource=(d["resources"] as JsonObject[]).find(x=>x["name"]==="ui.json")!;
  const data=resource["data_base64"] as string|string[];
  const bundle=JSON.parse(Buffer.from(Array.isArray(data)?data.join(""):data,"base64").toString());
  assert.equal(bundle.code,code); assert.deepEqual(Object.keys(bundle.task_snapshots),["task"]);
  assert.equal(bundle.task_snapshots.task.status,"paused");
  const session=new DilSession(bundle.code,bundle.constants,bundle.app_data,{});
  assert.equal(session.render(1).tag,"DisplayAutomation");
});
test("legacy lists and unresolved inline evidence retain their fallback; another owner is refused",async()=>{
  for(const [inline,definition] of [[false,code],[true,'DIL.render(__dil.jsx("text",null,"Missing component"));']] as const){
    const d=await project(inline,definition),blocks=(d["messages"]as JsonObject[])[0]!["content"]as JsonObject[];
    assert.equal(blocks.filter(x=>x["name"]==="schedule").length,1);
  }
  await assert.rejects(project(true,code,"wrong"),/different source message/);
});
