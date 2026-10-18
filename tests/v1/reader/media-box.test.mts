import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { savedMediaBox } from "../../../src/ui/shared/conversation-renderer/media-box.mts";
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(source:string,local=false){
 const dom=new JSDOM('<!doctype html>',{url:'https://cloudig.local/'}),abort=new AbortController();let plays=0,loads=0,reads=0,revoked=0;
 dom.window.HTMLMediaElement.prototype.play=async()=>{plays++;};dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{loads++;};
 dom.window.URL.createObjectURL=()=> 'blob:local';dom.window.URL.revokeObjectURL=()=>{revoked++;};
 const root=savedMediaBox({document:dom.window.document,source,language:'zh',signal:abort.signal,resolve:()=>local?'saved.webm':undefined,readFile:async()=>{reads++;return{path:'saved.webm',mime:'video/webm',bytes:new Uint8Array([1,2,3]).buffer};}});dom.window.document.body.append(root);
 return{dom,abort,root,counts:()=>({plays,loads,reads,revoked}),close:()=>{abort.abort();dom.window.close();}};
}
test('remote media remains inert until explicit play; captions, alternate sources and cleanup survive',async()=>{
 const s=setup('<div>Before<video controls><source src="https://media.test/a.webm" type="video/webm"><source src="https://media.test/a.mp4" type="video/mp4"></video><p>Original <strong>caption</strong></p><script>throw Error("never")</script></div>');
 try{await pause();const video=s.root.querySelector('video')!;assert(video.controls);assert.equal(video.preload,'none');assert.equal(video.querySelectorAll('source').length,0);assert.equal(s.counts().reads,0);assert.equal(s.counts().loads,0);assert.equal(s.counts().plays,0);assert(s.root.textContent!.includes('Original caption'));assert.equal(s.root.querySelector('script'),null);
 assert(s.root.querySelector('button')!.classList.contains('cloudig-media-play'));
 s.root.querySelector('button')!.click();assert.equal(video.querySelectorAll('source').length,2);assert.equal(video.crossOrigin,'anonymous');assert.equal(s.counts().plays,1);assert.equal(s.root.querySelector('[data-mode=online]')!==null,true);
 s.abort.abort();assert.equal(video.querySelectorAll('source').length,0);
 }finally{s.close();}
});
test('saved media takes precedence over the remote link without fetching it',async()=>{
 const s=setup('<video src="https://media.test/a.webm"></video>',true);
 try{await pause();assert.equal(s.root.querySelector('source')!.src,'blob:local');assert.equal(s.root.querySelector('button')!.hidden,true);assert.equal(s.root.querySelector('[data-mode=offline]')!==null,true);assert.deepEqual(s.counts(),{plays:0,loads:1,reads:1,revoked:0});s.abort.abort();assert.equal(s.counts().revoked,1);}finally{s.close();}
});
test('multiple independent audio/video players keep source order and reject executable URLs',async()=>{
 const s=setup('<p>One</p><audio src="https://media.test/a.ogg"></audio><p>Two</p><video src="javascript:alert(1)"></video><iframe src="https://untrusted.test"></iframe>');
 try{await pause();assert.equal(s.root.querySelectorAll('audio,video').length,2);assert.equal(s.root.querySelectorAll('a').length,1);assert.equal(s.root.querySelectorAll('iframe,script').length,0);assert.equal(s.root.querySelector('audio source'),null);assert.equal(s.root.querySelector('video source'),null);assert.equal([...s.root.querySelectorAll('button')].filter(n=>!n.hidden).length,1);}finally{s.close();}
});
