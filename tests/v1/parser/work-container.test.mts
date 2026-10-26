import test from "node:test";
import assert from "node:assert/strict";
import {workContainer,WORK_CONTAINER_LIMITS} from "../../../src/adapters/parser/work-container.mts";

test("presentation role and outer size, never the framework, determine a container",()=>{
  for(const source of ['<script src="chart.js"></script>','<canvas></canvas><script>requestAnimationFrame(draw);setInterval(tick,10)</script>','<script type="module">new THREE.WebGLRenderer()</script>']){
    assert.equal(workContainer({role:"component",source}),"box");
    assert.equal(workContainer({role:"workspace",source}),"window");
  }
  for(const source of ['<body style="min-height:100vh">Editor</body>','<style>.application{height:900px}</style><div class="application">Work</div>','<main style="min-width:1400px">Canvas</main>'])assert.equal(workContainer({role:"component",source}),"window");
  assert.equal(workContainer({role:"component",source:'<style>.icon{height:900px}</style><main><section><aside><i class="icon"></i></aside></section></main>'}),"box");
  assert.equal(workContainer({role:"unknown",source:'<html><body><main style="height:380px">Chart</main></body></html>'}),"box");
  assert.equal(workContainer({role:"unknown",source:'<html><body>Unknown document</body></html>'}),"window");
  assert.equal(workContainer({role:"component",previewHeight:WORK_CONTAINER_LIMITS.inlineHeight+1}),"window");
  assert.equal(workContainer({role:"component",previewHeight:300}),"box");
  assert.equal(workContainer({role:"inline",previewHeight:900}),"box","explicit native inline semantics survive a tall capture");
});
