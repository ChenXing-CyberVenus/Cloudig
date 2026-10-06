import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { openUpdateCheck, checkStartupUpdate, releasePage } from '../../../src/ui/shell/update-check.js';

test('Update dialog distinguishes outcomes, uses safe external links, and restores focus/inert state',async()=>{
  for(const language of ['zh-CN','en']){
    const dom=new JSDOM('<main id="page"><button id="opener">Updates</button></main><div id="overlay"></div>');
    const before=globalThis.document;globalThis.document=dom.window.document;
    try{
      const background=document.querySelector('main'),host=document.querySelector('#overlay'),opener=document.querySelector('button');opener.focus();
      let calls=0,resolveCheck,signal;
      const check=s=>{calls++;signal=s;return new Promise(r=>{resolveCheck=r;});};
      const view=openUpdateCheck({host,background,language,check});
      assert.equal(view.element.querySelectorAll(':scope > p').length,1,'Only the functional status, no defensive disclaimer');
      assert.equal(calls,1);assert.equal(background.inert,true);assert.equal(view.element.dataset.updateStatus,'checking');
      assert.equal(openUpdateCheck({host,background,language,check}),view);assert.equal(calls,1);
      for(const status of ['no_release','available','current','ahead','timeout','rate_limited','invalid_response','invalid_version','unavailable']){
        resolveCheck({status,current_version:'1.0.0-dev',latest_version:status==='available'?'v1.1.0':null,release_url:'javascript:alert(1)'});await new Promise(r=>setImmediate(r));
        assert.equal(view.element.dataset.updateStatus,status);
        assert.equal(view.element.querySelector('a').href,releasePage);assert.equal(view.element.querySelector('a').target,'_blank');
        assert(view.element.textContent.includes('1.0.0-dev'));assert(!view.element.textContent.includes('command failed'));
        if(status==='no_release')assert(view.element.textContent.includes(language==='en'?'not published':'尚未发布'));
        view.element.querySelector('[data-update-retry]').click();assert.equal(view.element.dataset.updateStatus,'checking');
      }
      view.element.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert.equal(host.children.length,0);assert.equal(background.inert,undefined);assert.equal(document.activeElement,opener);assert(signal.aborted);
      resolveCheck({status:'available'});await new Promise(r=>setImmediate(r));assert.equal(host.children.length,0);
    } finally {globalThis.document=before;dom.window.close();}
  }
});

test('Network rejection is readable and a backdrop click cancels the dialog',async()=>{
  const dom=new JSDOM('<main></main><aside></aside>'),before=globalThis.document;globalThis.document=dom.window.document;
  try{
    const host=document.querySelector('aside'),background=document.querySelector('main');
    openUpdateCheck({host,background,language:'zh-CN',check:()=>Promise.reject(new Error('secret internal transport stack'))});
    await new Promise(r=>setImmediate(r));assert.equal(host.querySelector('section').dataset.updateStatus,'unavailable');assert(!host.textContent.includes('secret'));
    host.firstElementChild.click();assert.equal(host.children.length,0);
  }finally{globalThis.document=before;dom.window.close();}
});

test('All three manual buttons share one dialog; startup uses its once-per-process native command',async()=>{
  const html=new JSDOM(await readFile('src/ui/shell/index.html','utf8'));
  assert(html.window.document.querySelector('[data-action=check-update]'));
  for(const id of ['reader-cover-template','archiver-template'])assert(html.window.document.getElementById(id).content.querySelector('[data-action=check-update]'));
  const shell=await readFile('src/ui/shell/shell.js','utf8');
  assert.equal(shell.match(/requestWithSignal\("shell\.checkUpdates"/gu)?.length,1);
  assert(shell.split('\n').find(l=>l.includes('button.dataset.action === "check-update"'))?.includes('showUpdateCheck'));
  assert(shell.includes('request("shell.checkStartupUpdate", {})')); assert(shell.indexOf('root.dataset.ready = "true"') < shell.indexOf('void checkStartupUpdate'));
  const policy=await readFile('src/desktop/Cloudig.Desktop.Core/BridgePolicy.cs','utf8');assert(policy.includes('"shell.checkUpdates"'));
  html.window.close();
});

test('startup discovery is silent for failures/no update and never downloads until the user chooses',async()=>{
  const dom=new JSDOM('<aside></aside>'),before=globalThis.document;globalThis.document=dom.window.document;
  try {
    const host=document.querySelector('aside'); let opened=0;
    for(const status of ['current','ahead','unavailable','timeout','already_checked']) { await checkStartupUpdate({host,language:'zh-CN',check:async()=>({status}),open:()=>opened++}); assert.equal(host.children.length,0); }
    await checkStartupUpdate({host,language:'zh-CN',check:async()=>{throw Error('offline')},open:()=>opened++}); assert.equal(host.children.length,0);
    await checkStartupUpdate({host,language:'zh-CN',check:async()=>({status:'available',latest_version:'1.0.3'}),open:()=>opened++});
    assert.equal(opened,0); assert(host.textContent.includes('1.0.3'));host.querySelector('button').click();assert.equal(opened,1);assert.equal(host.children.length,0);
    let editing=true;await checkStartupUpdate({host,language:'zh-CN',check:async()=>({status:'available',latest_version:'1.0.3'}),open:()=>editing?false:++opened});
    host.querySelector('button').click();assert.equal(opened,1);assert(host.textContent.includes('完成并关闭'));editing=false;host.querySelector('button').click();assert.equal(opened,2);assert.equal(host.children.length,0);
  }finally{globalThis.document=before;dom.window.close();}
});

test('update action shows progress, forwards only the native capability and handles installation failure',async()=>{
  const dom=new JSDOM('<main></main><aside></aside>'),before=globalThis.document;globalThis.document=dom.window.document;
  try {
    let prepared=0,installed=0;
    const view=openUpdateCheck({host:document.querySelector('aside'),background:document.querySelector('main'),language:'en',initial:{status:'available',can_install:true,current_version:'1.0.2',latest_version:'1.0.3'},
      prepare:async(signal,progress)=>{prepared++;assert(!signal.aborted);progress({bytes:50,total:100});return{capability:'native-only'};},
      install:async capability=>{installed++;assert.equal(capability,'native-only');throw Error('Test failure');}});
    assert.equal(prepared,0);view.element.querySelector('[data-update-install]').click();await new Promise(r=>setImmediate(r));
    assert.equal(prepared,1);assert.equal(installed,1);assert.equal(view.element.querySelector('progress').value,50);assert.equal(view.element.dataset.updateStatus,'failed');view.close();
  }finally{globalThis.document=before;dom.window.close();}
});
