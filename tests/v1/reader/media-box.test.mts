import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { savedMediaBox, storedMediaBox, readMediaCues } from "../../../src/ui/shared/conversation-renderer/media-box.mts";
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('resource-backed native media reuses the explicit online path and cancels before a delayed load',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://cloudig.local/'}),abort=new AbortController();
 dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{};
 const entry={path:'player.html',mime:'text/html',bytes:new TextEncoder().encode('<video src="https://example.test/video.mp4"></video>').buffer};
 const root=storedMediaBox({document:dom.window.document,entry:'player.html',language:'en',title:'Saved video',signal:abort.signal,resolve:()=>undefined,readFile:async()=>entry});
 await pause();assert.equal(root.querySelector('iframe'),null);assert.equal(root.querySelector('video source'),null);assert.equal(root.querySelector('button')?.textContent,'Play online');
 let finish!:(v:typeof entry)=>void;const delayed=new AbortController();
 const other=storedMediaBox({document:dom.window.document,entry:'player.html',language:'en',signal:delayed.signal,resolve:()=>undefined,readFile:()=>new Promise(resolve=>{finish=resolve;})});
 delayed.abort();finish(entry);await pause();assert.equal(other.querySelector('video'),null);abort.abort();dom.window.close();
});
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
 s.root.querySelector('button')!.click();assert.equal(video.querySelectorAll('source').length,2);assert.equal(video.crossOrigin,null);assert.equal(s.counts().plays,1);assert.equal(s.root.querySelector('[data-mode=online]')!==null,true);
 s.abort.abort();assert.equal(video.querySelectorAll('source').length,0);
 }finally{s.close();}
});

test('source errors and rejected playback show failure and retry rather than an endless loading state',async()=>{
 const s=setup('<video><source src="https://media.test/one.mp4"><source src="https://media.test/two.mp4"></video>');
 try{await pause();const button=s.root.querySelector('button')!,video=s.root.querySelector('video')!;button.click();
 const sources=video.querySelectorAll('source');sources[0]!.dispatchEvent(new s.dom.window.Event('error'));assert.equal(button.hidden,true);
 sources[1]!.dispatchEvent(new s.dom.window.Event('error'));assert.equal(button.hidden,false);assert.equal(s.root.querySelector('[data-playback=failed]')!==null,true);assert(s.root.textContent!.includes('需要平台登录'));
 video.play=async()=>{throw new s.dom.window.DOMException('Unsupported','NotSupportedError');};button.click();await pause();assert.equal(button.hidden,false);assert(!s.root.textContent!.includes('点击播放器开始播放'));
 }finally{s.close();}
});

test('captions keep original times, synchronize only the lyric viewport, and no timings are invented',async()=>{
 const raw='WEBVTT\n\n1\n00:00.000 --> 00:02.000\nFirst\n\n00:02.000 --> 00:04.000\n<b>Second</b>\n';
 assert.deepEqual(readMediaCues('plain lyrics'),[]);assert.equal(readMediaCues(raw)[1]!.start,2);
 const dom=new JSDOM('<!doctype html>',{url:'https://cloudig.local/'}),abort=new AbortController();
 dom.window.HTMLMediaElement.prototype.load=()=>{};dom.window.HTMLMediaElement.prototype.pause=()=>{};
 const root=savedMediaBox({document:dom.window.document,source:'<audio src="https://example.test/song.mp3"><track src="captions.vtt" default></audio>',language:'en',signal:abort.signal,resolve:url=>url==='captions.vtt'?url:undefined,readFile:async path=>({path,mime:'text/vtt',bytes:new TextEncoder().encode(raw).buffer})});
 try{await pause();const media=root.querySelector('audio')!,track=root.querySelector<HTMLElement>('.cloudig-timed-lyrics')!;
 Object.defineProperty(track.children[1],'offsetTop',{value:90});media.currentTime=2.5;media.dispatchEvent(new dom.window.Event('timeupdate'));assert.equal(root.querySelector('[aria-current=true]')!.textContent,'Second');assert.equal(root.querySelectorAll('.cloudig-media-lyrics li').length,2);assert.equal(root.querySelector('.cloudig-media-lyrics b'),null);
 assert.equal(track.style.transform,'translateY(-90px)');assert.equal(track.hasAttribute('data-scroll-region'),false);assert(track.closest('.cloudig-lyrics-viewport'));}
 finally{abort.abort();dom.window.close();}
});
test('saved media takes precedence over the remote link without fetching it',async()=>{
 const s=setup('<video src="https://media.test/a.webm"></video>',true);
 try{await pause();assert.equal(s.root.querySelector('source')!.src,'blob:local');assert.equal(s.root.querySelector('button')!.hidden,true);assert.equal(s.root.querySelector('[data-mode=offline]')!==null,true);assert.deepEqual(s.counts(),{plays:0,loads:1,reads:1,revoked:0});s.abort.abort();assert.equal(s.counts().revoked,1);}finally{s.close();}
});

test('a saved video with audio-only native decoding offers the shared compatible preview',async()=>{
 const dom=new JSDOM('<!doctype html>'),abort=new AbortController();let opened='';dom.window.HTMLMediaElement.prototype.load=()=>{};dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.URL.createObjectURL=()=> 'blob:owned';dom.window.URL.revokeObjectURL=()=>{};
 const root=savedMediaBox({document:dom.window.document,source:'<video src="clip"></video>',language:'zh',signal:abort.signal,resolve:u=>u==='clip'?'clip':undefined,readFile:async()=>({path:'clip',mime:'video/mp4',bytes:new Uint8Array([1]).buffer}),openPreview:path=>{opened=path;}});
 try{await pause();const media=root.querySelector('video')!;Object.defineProperties(media,{readyState:{value:4},videoWidth:{value:0}});media.dispatchEvent(new dom.window.Event('loadedmetadata'));media.dispatchEvent(new dom.window.Event('canplay'));
 const action=root.querySelector<HTMLButtonElement>('.cloudig-media-compatible')!;assert(!action.hidden);assert.match(root.textContent!,/兼容播放/);action.click();assert.equal(opened,'clip');assert.equal(root.querySelector('[data-playback=needs-decoder]')!==null,true);
 }finally{abort.abort();dom.window.close();}
});
test('owned music covers use CSP-permitted data images, not Blob image origins',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://cloudig.local/'}),abort=new AbortController();
 dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{};
 const root=savedMediaBox({document:dom.window.document,source:'<audio poster="cover.png" src="https://media.test/song.mp3"></audio>',language:'en',signal:abort.signal,resolve:url=>url==='cover.png'?url:undefined,readFile:async path=>({path,mime:'image/png',bytes:new Uint8Array([1,2,3]).buffer})});
 try{for(let i=0;i<40&&!root.querySelector('img');i++)await new Promise(r=>setTimeout(r,5));assert.equal(root.querySelector('img')?.src,'data:image/png;base64,AQID');assert.equal(root.querySelector('audio source'),null);}finally{abort.abort();dom.window.close();}
});
test('multiple independent audio/video players keep source order and reject executable URLs',async()=>{
 const s=setup('<p>One</p><audio src="https://media.test/a.ogg"></audio><p>Two</p><video src="javascript:alert(1)"></video><iframe src="https://untrusted.test"></iframe>');
 try{await pause();assert.equal(s.root.querySelectorAll('audio,video').length,2);assert.equal(s.root.querySelectorAll('a').length,1);assert.equal(s.root.querySelectorAll('iframe,script').length,0);assert.equal(s.root.querySelector('audio source'),null);assert.equal(s.root.querySelector('video source'),null);assert.equal([...s.root.querySelectorAll('.cloudig-media-play')].filter(n=>!(n as HTMLButtonElement).hidden).length,1);}finally{s.close();}
});
