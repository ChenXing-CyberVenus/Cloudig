import test from 'node:test';
import assert from 'node:assert/strict';
import {followNavigationItem,visibleNavigationIndex} from '../../../src/ui/shell/pages/reader/navigation-position.js';

test('navigation follows the visible message and the final viewport, ignoring hidden processes',()=>{
  const scroll={scrollTop:600,scrollHeight:2000,clientHeight:400,clientTop:0,getBoundingClientRect:()=>({top:100})};
  const node=(top,height)=>({getBoundingClientRect:()=>({top,bottom:top+height,height,width:600})});
  const anchors=[{index:0,node:node(-500,400)},{index:1,node:node(-100,650)},{index:2,node:node(550,300)},{index:3,node:node(0,0)}];
  assert.equal(visibleNavigationIndex(scroll,anchors),1,'a tall message stays current even when its heading is far above the viewport');
  scroll.scrollTop=1600;assert.equal(visibleNavigationIndex(scroll,anchors),2,'the final viewport follows the final rendered message');
  scroll.scrollTop=0;assert.equal(visibleNavigationIndex(scroll,[{index:7,node:node(120,90)}]),7);
});

test('following a navigation row scrolls only its pane and does nothing when already visible',()=>{
  const list={scrollTop:0,clientTop:0,clientHeight:300,getBoundingClientRect:()=>({top:200})};
  followNavigationItem(list,{getBoundingClientRect:()=>({top:610,bottom:640})});assert.equal(list.scrollTop,144);
  followNavigationItem(list,{getBoundingClientRect:()=>({top:250,bottom:280})});assert.equal(list.scrollTop,144);
  followNavigationItem(list,{getBoundingClientRect:()=>({top:180,bottom:210})});assert.equal(list.scrollTop,120);
});
