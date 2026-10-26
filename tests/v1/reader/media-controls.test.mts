import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {mountAudioControls} from "../../../src/ui/shared/conversation-renderer/media-controls.mts";

test("audio starts at half volume and volume adjustment/mute restore remain independent of seeking",()=>{
 const dom=new JSDOM("<!doctype html><audio></audio>"),media=dom.window.document.querySelector("audio")!,abort=new AbortController();
 const root=mountAudioControls(media,false,abort.signal),slider=root.querySelector<HTMLInputElement>(".cloudig-audio-volume-range")!,mute=root.querySelector<HTMLButtonElement>(".cloudig-audio-mute")!;
 try{assert.equal(media.volume,.5);assert.equal(slider.value,"50");
 slider.value="23";slider.dispatchEvent(new dom.window.Event("input"));assert.equal(media.volume,.23);assert.equal(root.querySelector("output")!.textContent,"23%");assert.equal(media.currentTime,0);
 mute.click();assert(media.muted);assert.equal(slider.value,"0");mute.click();assert(!media.muted);assert.equal(media.volume,.23);
 slider.value="0";slider.dispatchEvent(new dom.window.Event("input"));mute.click();assert.equal(media.volume,.23);
 }finally{abort.abort();dom.window.close();}
});

test("Unmute restores audible volume from zero and preserves a nonzero chosen volume",()=>{
 const dom=new JSDOM("<!doctype html><audio></audio>"),media=dom.window.document.querySelector("audio")!,abort=new AbortController();
 const root=mountAudioControls(media,true,abort.signal),mute=root.querySelector<HTMLButtonElement>(".cloudig-audio-mute")!;
 try {
  for(const muted of [false,true]){media.volume=0;media.muted=muted;media.dispatchEvent(new dom.window.Event("volumechange"));assert.equal(mute.title,"Unmute");mute.click();assert.equal(media.muted,false);assert(media.volume>0);assert.equal(mute.title,"Mute");}
  media.volume=.4;media.muted=true;mute.click();assert.equal(media.volume,.4);assert.equal(media.muted,false);mute.click();assert.equal(media.muted,true);
 } finally {abort.abort();dom.window.close();}
});
test("audio controls follow media state, seek and mute without changing original media",async()=>{
 const dom=new JSDOM("<!doctype html><audio src='blob:saved'></audio>"),doc=dom.window.document,media=doc.querySelector("audio")!,abort=new AbortController();
 let paused=true;Object.defineProperties(media,{duration:{value:120},paused:{get:()=>paused}});
 media.play=async()=>{paused=false;media.dispatchEvent(new dom.window.Event("play"));};media.pause=()=>{paused=true;media.dispatchEvent(new dom.window.Event("pause"));};
 const root=mountAudioControls(media,false,abort.signal);media.after(root);
 try{
  assert.equal(media.controls,false);const play=root.querySelector<HTMLButtonElement>(".cloudig-audio-toggle")!;play.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(play.title,"暂停");
  const seek=root.querySelector<HTMLInputElement>("input")!;seek.value="250";seek.dispatchEvent(new dom.window.Event("input"));assert.equal(media.currentTime,30);assert.equal(root.querySelector(".cloudig-audio-time")!.textContent,"0:30 / 2:00");
  root.querySelector<HTMLButtonElement>(".cloudig-audio-mute")!.click();assert(media.muted);play.click();assert(paused);assert.equal(media.getAttribute("src"),"blob:saved");
  abort.abort();media.currentTime=60;media.dispatchEvent(new dom.window.Event("timeupdate"));assert.equal(root.querySelector(".cloudig-audio-time")!.textContent,"0:30 / 2:00");
 }finally{abort.abort();dom.window.close();}
});
