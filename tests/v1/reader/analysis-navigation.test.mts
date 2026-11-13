import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createConversationRenderer, type RendererLabels } from "../../../src/ui/shared/conversation-renderer/index.mts";
const labels:RendererLabels={reasoning:"思考",processGroup:"思考与工具",toolCall:"调用",toolResult:"结果",toolActivity:"活动",references:"参考",search:"搜索",diagram:"图表",source:"源码",loadingResource:"加载",unavailableResource:"不可用",failedResource:"失败",openAttachment:"附件",externalResource:"外部",systemParty:"系统",toolParty:"工具",otherParty:"其他"};

for (const language of ["zh","en"] as const) test(`analysis navigation opens the existing paired process only (${language})`,()=>{
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector<HTMLElement>('main')!;
  const renderer=createConversationRenderer({root,labels,theme:"dawn",language});
  const blocks=[
    {category:"tool",collapsed:true,value:{type:"tool",kind:"call",call:"same-id",name:"python",input:"print('saved only')\n"}},
    {category:"tool",collapsed:true,value:{type:"tool",kind:"result",call:"same-id",name:"python",output:"first\nsecond\n"}},
    {category:"content",value:{type:"text",text:"Answer"}}
  ];
  try {
    renderer.render({messages:[{anchor:"a",party:{role:"assistant"},blocks},{anchor:"b",party:{role:"assistant"},blocks}]});
    const button=root.querySelector<HTMLButtonElement>('#a .cloudig-analysis-open')!;
    assert.match(button.textContent!,language==='en'?/View analysis/u:/查看分析/u);
    assert.equal(root.querySelectorAll('pre').length,0);
    button.click();
    assert.equal(root.querySelectorAll('#a details:not([open])').length,0);
    assert.equal(root.querySelectorAll('#b details[open]').length,0);
    assert.equal(root.querySelector('#a code')?.textContent,"print('saved only')\n");
    assert.equal(root.querySelector('#a .cloudig-tool-result pre')?.textContent,"first\nsecond\n");
    button.click(); assert.equal(root.querySelectorAll('#a code').length,1);
    renderer.render({messages:[{anchor:"replacement",party:{role:"assistant"},blocks:[{category:"content",value:{type:"text",text:"Other branch"}}]}]});
    assert.equal(root.querySelector('.cloudig-analysis-open'),null);
  } finally {renderer.destroy();dom.window.close();}
});

test("ordinary tools, unpaired outputs and legacy code do not acquire fake analysis navigation",()=>{
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector<HTMLElement>('main')!;
  const renderer=createConversationRenderer({root,labels,theme:"star-night"});
  try {
    renderer.render({messages:[{party:{role:"assistant"},blocks:[
      {category:"tool",collapsed:true,value:{type:"tool",kind:"call",call:"web",name:"web.run",input:"query"}},
      {category:"tool",collapsed:true,value:{type:"tool",kind:"result",call:"missing",name:"python",output:"value"}},
      {category:"tool",collapsed:true,value:{type:"tool",kind:"call",name:"python",input:"legacy"}},
      {category:"content",value:{type:"text",text:"Answer"}}
    ]}]}); assert.equal(root.querySelector('.cloudig-analysis-open'),null);
  } finally {renderer.destroy();dom.window.close();}
});
