import type {InteractivePackage} from "./interactive-protocol.mts";
import {playbackControls,type PlaybackTarget} from "./media-controls.mts";

// The pinned LGPL player is a separate, replaceable local distribution. It is
// loaded only after native decoding fails; original media is never transcoded.
type SoftwarePlayer={load(file:File):Promise<void>;play():Promise<void>;pause():Promise<void>;seek(time:bigint):Promise<void>;destroy():Promise<void>;currentTime:bigint;getDuration():bigint;setVolume(value:number):void;on(name:string,listener:(...args:unknown[])=>void):void};
type PlayerConstructor=new(options:Record<string,unknown>)=>SoftwarePlayer;
const codecNames:Readonly<Record<number,string>>={27:"h264",173:"hevc",86018:"aac",86017:"mp3"};

export function installVideoPreview(video:HTMLVideoElement,input:InteractivePackage):void {
 const doc=video.ownerDocument,en=input.language==="en",host=video.parentElement!;
 const note=doc.createElement("p");note.className="saved-video-status";note.setAttribute("role","status");host.append(note);
 const style=doc.createElement("style");style.textContent=`main.saved-media{flex-direction:column;gap:16px}.saved-video-status:empty{display:none}.saved-video-status{margin:0!important;color:var(--muted)}.saved-video-fallback{width:100%;display:grid;gap:14px}.saved-video-canvas{width:100%;height:min(52vw,calc(100dvh - 150px));min-height:180px;position:relative;background:#16131c;border-radius:10px;overflow:hidden}.saved-video-canvas canvas{max-width:100%;max-height:100%}`;doc.head.append(style);
 let started=false,closed=false,player:SoftwarePlayer|undefined;const urls:string[]=[];
 const fail=()=>{if(!closed)note.textContent=en?"This video's encoding could not be played.":"暂时无法播放这段视频的编码格式。";};
 const fallback=async()=>{
  if(started||closed)return;started=true;video.pause();video.hidden=true;
  note.textContent=en?"Preparing compatible playback…":"正在准备兼容播放…";
  const root=doc.createElement("div");root.className="saved-video-fallback";root.dataset["state"]="loading";
  const canvas=doc.createElement("div");canvas.className="saved-video-canvas";root.append(canvas);video.before(root);
  try{
   const scripts=input.files.filter(f=>f.aliases?.some(a=>a.startsWith("cloudig-media-runtime:")));
   const main=scripts.find(f=>f.aliases?.includes("cloudig-media-runtime:avplayer.js"));if(!main)throw Error("Local video decoder missing");
   const load=(file:typeof main)=>new Promise<void>((resolve,reject)=>{const script=doc.createElement("script");const url=URL.createObjectURL(new Blob([file.bytes],{type:"text/javascript"}));urls.push(url);script.src=url;script.onload=()=>resolve();script.onerror=()=>reject(Error("Local video decoder failed"));doc.head.append(script);});
   // Register the pinned webpack chunks before its entry. No network paths,
   // dynamic remapping or additional privileges in the work origin.
   await Promise.all(scripts.filter(f=>f!==main).map(load));await load(main);
   if(closed)return;
   const Ctor=(globalThis as unknown as {AVPlayer:PlayerConstructor}).AVPlayer;
   player=new Ctor({container:canvas,enableWorker:false,enableAudioWorklet:false,enableWebCodecs:false,enableHardware:false,checkUseMSE:()=>false,
    getWasm:(type:string,id:number)=>{const name=type==="decoder"?codecNames[id]:type==="resampler"?"resample":"stretchpitch";const file=input.files.find(f=>f.aliases?.includes(`cloudig-media-codec:${name}`));if(!file)throw Error("Unsupported saved media codec");return file.bytes;}});
   let paused=true,ended=false,muted=video.muted,volume=video.volume;
   const target=new doc.defaultView!.EventTarget() as unknown as PlaybackTarget;
   let serial=Promise.resolve();const queue=(f:()=>Promise<void>)=>{const next=serial.then(f);serial=next.catch(()=>{});return next;};
   let seekTarget:number|undefined,seeking=false;
   const seek=async()=>{if(seeking)return;seeking=true;try{while(seekTarget!==undefined){const value=seekTarget;seekTarget=undefined;await queue(()=>player!.seek(BigInt(Math.round(value*1000))));}}catch{fail();}finally{seeking=false;}};
   Object.defineProperties(target,{paused:{get:()=>paused},ended:{get:()=>ended},duration:{get:()=>Number(player!.getDuration())/1000},currentTime:{get:()=>Number(player!.currentTime)/1000,set:(value:number)=>{seekTarget=value;void seek();}},volume:{get:()=>volume,set:(value:number)=>{volume=value;player!.setVolume(muted?0:volume);}},muted:{get:()=>muted,set:(value:boolean)=>{muted=value;player!.setVolume(muted?0:volume);}}});
   const event=(name:string)=>target.dispatchEvent(new doc.defaultView!.Event(name));
   target.play=()=>queue(async()=>{ended=false;await player!.play();paused=false;event("play");});target.pause=()=>{void queue(async()=>{await player!.pause();paused=true;event("pause");}).catch(fail);};
   player.on("time",()=>{root.dataset["time"]=String(Number(player!.currentTime)/1000);event("timeupdate");});
   player.on("firstVideoRendered",()=>{root.dataset["decoded"]="true";note.textContent="";});
   player.on("ended",()=>{ended=true;paused=true;event("ended");});player.on("error",fail);
   const file=input.files.find(f=>f.path===input.entry)!;
   await player.load(new File([file.bytes],file.path,{type:file.mime}));if(closed){await player.destroy();return;}
   player.setVolume(muted?0:volume);root.append(playbackControls(target,doc,en));root.dataset["state"]="ready";note.textContent="";
  }catch{root.dataset["state"]="failed";fail();}
 };
 // A browser may accept the MP4 audio track while silently dropping HEVC:
 // duration/canplay alone do not prove that any video frames were decoded.
 const check=()=>{if(video.readyState>=1&&video.videoWidth===0)void fallback();};
 video.addEventListener("loadedmetadata",check);video.addEventListener("error",()=>void fallback());check();
 doc.defaultView!.addEventListener("pagehide",()=>{closed=true;void player?.destroy();for(const url of urls)URL.revokeObjectURL(url);},{once:true});
}
