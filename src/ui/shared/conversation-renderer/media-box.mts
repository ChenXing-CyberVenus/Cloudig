import type { InteractiveFile } from "./interactive-protocol.mts";

type MediaOptions = Readonly<{
  document: Document; source: string; language: "zh" | "en"; signal: AbortSignal;
  resolve: (url: string) => string | undefined;
  readFile: (path: string, signal: AbortSignal) => Promise<InteractiveFile | undefined>;
  openExternal?: (url: string) => void;
}>;
const webUrl = (value: string): string | undefined => {
  try { const url = new URL(value); return /^https?:$/u.test(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return; }
};

/** Plain authored audio/video is DOM content, not executable work. Preserve
 * its order and captions; remote sources remain inert until explicit consent.
 * File resolution uses this conversation's resource map, never the network. */
export function savedMediaBox(options: MediaOptions): HTMLElement {
  const {document, signal} = options, en = options.language === "en";
  const parsed = new document.defaultView!.DOMParser().parseFromString(options.source, "text/html");
  const root = document.createElement("div"); root.className = "cloudig-media-box";
  const urls: string[] = [], players: HTMLMediaElement[] = [];
  const player = (original: Element): HTMLElement => {
    const wrap = document.createElement("div"), media = document.createElement(original.localName as "video" | "audio");
    wrap.className = "cloudig-media-player"; media.controls = true; media.preload = "none"; media.crossOrigin = "anonymous";
    if (media instanceof document.defaultView!.HTMLVideoElement) media.playsInline = true;
    const authoredMaximum=(original as HTMLElement).style.maxHeight;
    if(/^\d+(?:\.\d+)?(?:px|%|vh|dvh)$/u.test(authoredMaximum))media.style.maxHeight=authoredMaximum;
    if (original.hasAttribute("loop")) media.loop = true;
    if (original.hasAttribute("muted")) media.muted = true;
    players.push(media);
    const sources = [...(original.getAttribute("src") ? [{url:original.getAttribute("src")!,type:original.getAttribute("type")??""}] : []),
      ...[...original.querySelectorAll("source[src]")].map(n=>({url:n.getAttribute("src")!,type:n.getAttribute("type")??""}))];
    const remote = sources.flatMap(s=>{const url=webUrl(s.url);return url?[{...s,url}]:[];});
    const status = document.createElement("span"); status.className = "cloudig-media-status"; status.setAttribute("role","status");
    const controls = document.createElement("div"); controls.className = "cloudig-media-actions";
    const online = document.createElement("button"); online.type="button"; online.className="cloudig-box-button cloudig-media-play"; online.textContent=en?"Play online":"联网播放"; online.hidden=true;
    const appendSource = (url:string,type:string) => {const n=document.createElement("source");n.src=url;if(type)n.type=type;media.append(n);};
    online.addEventListener("click",()=>{
      if(signal.aborted)return;
      media.replaceChildren();for(const s of remote)appendSource(s.url,s.type);
      online.hidden=true;wrap.dataset["mode"]="online";status.textContent=en?"Loading video/audio…":"正在加载音视频…";
      media.preload="metadata";media.load();void media.play().catch(()=>{if(!signal.aborted&&!media.error)status.textContent=en?"Press play to begin.":"点击播放器开始播放。";});
    });
    media.addEventListener("loadedmetadata",()=>{if(!signal.aborted)status.textContent="";});
    media.addEventListener("error",()=>{if(signal.aborted)return;status.textContent=en?"Unable to play this source. You can open the original link.":"暂时无法播放，可以打开原始视频或音频链接。";online.hidden=!remote.length;});
    for(const [index,s] of remote.entries()){
      const link=document.createElement("a");link.href=s.url;link.target="_blank";link.rel="noopener noreferrer";link.className="cloudig-media-link";
      link.textContent=(en?"Original media":"原始媒体")+(remote.length>1?` ${index+1}`:"");
      if(options.openExternal)link.addEventListener("click",event=>{event.preventDefault();options.openExternal!(s.url);});controls.append(link);
    }
    controls.prepend(online);wrap.append(media,controls,status);wrap.dataset["mode"]="pending";
    void (async()=>{
      let local=0;
      for(const s of sources){
        const path=options.resolve(s.url);
        if(path){const file=await options.readFile(path,signal);if(signal.aborted)return;if(file&&/^(?:video|audio)\//u.test(file.mime)){
          const url=document.defaultView!.URL.createObjectURL(new Blob([file.bytes],{type:file.mime}));urls.push(url);appendSource(url,file.mime);local++;
        }}else if(/^data:(?:video|audio)\/[\w.+-]+(?:;[^,]*)?,/iu.test(s.url)){appendSource(s.url,s.type);local++;}
      }
      if(signal.aborted)return;
      if(local){wrap.dataset["mode"]="offline";media.preload="metadata";media.load();}
      else{wrap.dataset["mode"]="remote";online.hidden=!remote.length;status.textContent=remote.length?(en?"Not stored offline.":"未保存离线视频或音频。"):(en?"No saved media or playable source link.":"原件未包含音视频或可播放的来源链接。");}
    })().catch(()=>{if(!signal.aborted){wrap.dataset["mode"]="unavailable";online.hidden=!remote.length;status.textContent=en?"The saved media could not be opened.":"暂时无法打开已保存的音视频。";}});
    return wrap;
  };
  const copy = (node: Node, target: Node): void => {
    if(node.nodeType===3){target.appendChild(document.createTextNode(node.textContent??""));return;}
    if(node.nodeType!==1)return;const element=node as Element, tag=element.localName;
    if(["script","style","link","meta","iframe","object","embed","img","source","track"].includes(tag))return;
    if(tag==="video"||tag==="audio"){target.appendChild(player(element));return;}
    const safe = /^(?:div|p|span|strong|b|em|i|small|br|figure|figcaption|ul|ol|li)$/u.test(tag)?tag:"div";
    const next=document.createElement(safe);for(const child of element.childNodes)copy(child,next);target.appendChild(next);
  };
  for(const child of parsed.body.childNodes)copy(child,root);
  const close=()=>{for(const media of players){media.pause();media.removeAttribute("src");media.replaceChildren();media.load();}for(const url of urls)document.defaultView!.URL.revokeObjectURL(url);};
  if(signal.aborted)close();else signal.addEventListener("abort",close,{once:true});
  return root;
}
