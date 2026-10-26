const clock = (seconds:number):string => {
  if(!Number.isFinite(seconds)||seconds<0)return "0:00";
  const whole=Math.floor(seconds),minutes=Math.floor(whole/60);return `${minutes}:${String(whole%60).padStart(2,"0")}`;
};
export type PlaybackTarget = Pick<HTMLMediaElement,"paused"|"ended"|"currentTime"|"duration"|"muted"|"volume"|"play"|"pause"|"addEventListener"|"removeEventListener"|"dispatchEvent">;
export const DEFAULT_PLAYBACK_VOLUME = 0.5;
export function playbackControls(media: PlaybackTarget, doc:Document, en: boolean, signal?: AbortSignal): HTMLElement {
  media.volume=DEFAULT_PLAYBACK_VOLUME;
  let audibleVolume=DEFAULT_PLAYBACK_VOLUME;
  const root=doc.createElement("div");root.className="cloudig-audio-controls";
  const button=(name:string,className:string)=>{const b=doc.createElement("button");b.type="button";b.className=className;b.setAttribute("aria-label",name);b.title=name;return b;};
  const play=button(en?"Play":"播放","cloudig-audio-toggle"),mute=button(en?"Mute":"静音","cloudig-audio-mute");
  const seek=doc.createElement("input");seek.type="range";seek.className="cloudig-audio-seek";seek.min="0";seek.max="1000";seek.value="0";seek.setAttribute("aria-label",en?"Playback position":"播放进度");seek.disabled=true;
  const time=doc.createElement("span");time.className="cloudig-audio-time";
  const volumeGroup=doc.createElement("div");volumeGroup.className="cloudig-audio-volume";
  const volume=doc.createElement("input");volume.type="range";volume.className="cloudig-audio-volume-range";volume.min="0";volume.max="100";volume.step="1";volume.setAttribute("aria-label",en?"Volume":"音量");
  const volumeLabel=doc.createElement("output");volumeLabel.className="cloudig-audio-volume-value";
  volumeGroup.append(mute,volume,volumeLabel);
  const status=doc.createElement("p");status.className="cloudig-audio-status";status.setAttribute("role","status");
  const icon=(b:HTMLButtonElement,path:string)=>{const svg=doc.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");const p=doc.createElementNS(svg.namespaceURI,"path");p.setAttribute("d",path);svg.append(p);b.replaceChildren(svg);};
  const update=()=>{
    const running=!media.paused&&!media.ended,label=running?(en?"Pause":"暂停"):(en?"Play":"播放");play.title=label;play.setAttribute("aria-label",label);
    icon(play,running?"M6 4h4v16H6zm8 0h4v16h-4z":"M7 4v16l13-8z");
    const muted=media.muted||media.volume===0;mute.title=muted?(en?"Unmute":"取消静音"):(en?"Mute":"静音");mute.setAttribute("aria-label",mute.title);mute.setAttribute("aria-pressed",String(muted));
    if(media.volume>0)audibleVolume=media.volume;
    const percent=Math.round((media.muted?0:media.volume)*100);volume.value=String(percent);volume.style.setProperty("--media-progress",`${percent}%`);volumeLabel.value=`${percent}%`;volume.setAttribute("aria-valuetext",`${percent}%`);volume.title=`${en?"Volume":"音量"} ${percent}%`;
    icon(mute,muted?"M3 9h4l5-5v16l-5-5H3zm12-2 2-2 3 4 3-4 2 2-3 4 3 4-2 2-3-4-3 4-2-2 3-4z":"M3 9h4l5-5v16l-5-5H3zm12-2v10a6 6 0 0 0 0-10zm3-4v2a8 8 0 0 1 0 14v2a10 10 0 0 0 0-18z");
    const duration=media.duration,valid=Number.isFinite(duration)&&duration>0;seek.disabled=!valid;seek.value=String(valid?Math.round(media.currentTime/duration*1000):0);seek.style.setProperty("--media-progress",`${Number(seek.value)/10}%`);time.textContent=`${clock(media.currentTime)} / ${clock(duration)}`;seek.setAttribute("aria-valuetext",time.textContent);
  };
  let starting=false;
  play.addEventListener("click",()=>{if(starting||signal?.aborted)return;if(!media.paused){media.pause();return;}status.textContent="";starting=true;play.disabled=true;void media.play().catch(()=>{status.textContent=en?"This media could not be played.":"暂时无法播放这段音视频。";}).finally(()=>{starting=false;play.disabled=false;update();});});
  mute.addEventListener("click",()=>{
    if(signal?.aborted)return;
    const silent=media.muted||media.volume===0;
    media.muted=!silent;
    if(silent&&media.volume===0)media.volume=audibleVolume;
    update();
  });
  volume.addEventListener("input",()=>{if(signal?.aborted)return;media.volume=Number(volume.value)/100;media.muted=false;update();});
  seek.addEventListener("input",()=>{if(signal?.aborted)return;if(Number.isFinite(media.duration)&&media.duration>0)media.currentTime=Number(seek.value)/1000*media.duration;update();});
  const events=["play","pause","ended","timeupdate","durationchange","loadedmetadata","volumechange"];
  for(const name of events)media.addEventListener(name,update);
  signal?.addEventListener("abort",()=>{for(const name of events)media.removeEventListener(name,update);},{once:true});
  root.append(play,seek,time,volumeGroup,status);update();return root;
}

export function mountAudioControls(media: HTMLMediaElement,en:boolean,signal?:AbortSignal):HTMLElement {
  media.controls=false;media.dataset["cloudigControls"]="";return playbackControls(media,media.ownerDocument,en,signal);
}
