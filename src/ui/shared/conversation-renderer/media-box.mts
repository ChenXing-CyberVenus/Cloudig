import { INTERACTIVE_LIMITS, type InteractiveFile } from "./interactive-protocol.mts";
import { mountAudioControls } from "./media-controls.mts";

export type MediaCue = Readonly<{ start: number; end: number; text: string }>;
/** Read archived cue times; never infer timing by evenly dividing a song. */
export function readMediaCues(source: string): MediaCue[] {
  const time = (value: string): number => {
    const parts = value.replace(",", ".").split(":").map(Number);
    return parts.length >= 2 && parts.length <= 3 && parts.every(Number.isFinite) ? parts.reduce((sum, n) => sum * 60 + n, 0) : NaN;
  };
  return source.replace(/^\uFEFF/u, "").split(/\r?\n\s*\r?\n/u).flatMap(block => {
    const lines = block.split(/\r?\n/u), index = lines.findIndex(line => line.includes(" --> "));
    const match = index < 0 ? undefined : /^(\S+)\s+-->\s+(\S+)/u.exec(lines[index]!);
    if (!match) return [];
    const start = time(match[1]!), end = time(match[2]!);
    return Number.isFinite(start) && end > start ? [{ start, end, text: lines.slice(index + 1).join("\n").replace(/\n+$/u, "") }] : [];
  });
}

type MediaOptions = Readonly<{
  document: Document; source: string; language: "zh" | "en"; signal: AbortSignal;
  resolve: (url: string) => string | undefined;
  readFile: (path: string, signal: AbortSignal) => Promise<InteractiveFile | undefined>;
  openExternal?: (url: string) => void;
  openPreview?: (path: string) => void;
}>;
export function storedMediaBox(options: Omit<MediaOptions, "source"> & Readonly<{ entry: string; title?: string }>): HTMLElement {
  const root = options.document.createElement("section"); root.className = "cloudig-box cloudig-saved-media";
  if (options.title) { const title = options.document.createElement("h3"); title.className = "cloudig-box-heading"; title.textContent = options.title; root.append(title); }
  const body = options.document.createElement("div"); body.setAttribute("role", "status"); body.textContent = options.language === "en" ? "Loading media…" : "正在加载媒体…"; root.append(body);
  void options.readFile(options.entry, options.signal).then(file => {
    if (options.signal.aborted) return;
    if (!file) throw new Error("Missing saved media entry");
    body.removeAttribute("role"); body.replaceChildren(savedMediaBox({ ...options, source: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) }));
  }).catch(() => { if (!options.signal.aborted) body.textContent = options.language === "en" ? "The saved media could not be opened." : "暂时无法打开已保存的媒体。"; });
  return root;
}
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
  const urls: string[] = [], players: HTMLMediaElement[] = [], cleanups: (() => void)[] = [];
  const player = (original: Element): HTMLElement => {
    const wrap = document.createElement("div"), media = document.createElement(original.localName as "video" | "audio");
    wrap.className = "cloudig-media-player"; wrap.dataset["mediaKind"] = original.localName; media.controls = true; media.preload = "none";
    const stage = document.createElement("div"); stage.className = "cloudig-music-stage";
    // Playback does not read cross-origin pixels. Forcing anonymous CORS here
    // rejects otherwise playable public files and cannot supply platform login.
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
    const compatible=document.createElement("button");compatible.type="button";compatible.className="cloudig-box-button cloudig-media-play cloudig-media-compatible";compatible.textContent=en?"Compatible playback":"兼容播放";compatible.hidden=true;
    let nativePath:string|undefined,needsFallback=false;
    compatible.addEventListener("click",()=>{if(nativePath&&!signal.aborted){media.pause();options.openPreview?.(nativePath);}});
    let timer: ReturnType<typeof setTimeout> | undefined, attempt = 0, failedSources = 0;
    const clearTimer = () => { clearTimeout(timer); timer = undefined; };
    cleanups.push(clearTimer);
    const failed = (timeout = false) => {
      if (signal.aborted) return; clearTimer(); wrap.dataset["playback"] = "failed";
      status.textContent = timeout ? (en ? "Loading timed out. Retry or open the original media in your browser." : "加载超时，可重试或在浏览器打开原始媒体。")
        : (en ? "This media could not play. The link may have expired, need platform sign-in, or be unavailable. Retry or open it in your browser." : "媒体未能播放，链接可能已失效、需要平台登录或暂时不可用。可重试或在浏览器打开。") ;
      online.hidden = !remote.length; online.textContent = en ? "Retry online" : "重试联网播放";
    };
    const loading = () => {
      if (signal.aborted || timer !== undefined) return; wrap.dataset["playback"] = "loading";
      status.textContent = en ? "Loading video/audio…" : "正在加载音视频…";
      timer = setTimeout(() => failed(true), INTERACTIVE_LIMITS.loadTimeoutMs);
    };
    const ready = () => { if (!signal.aborted) { clearTimer(); if(!needsFallback){wrap.dataset["playback"] = "ready"; status.textContent = "";} } };
    const checkVideo=()=>{if(media.localName==="video"&&(media as HTMLVideoElement).videoWidth===0&&nativePath&&options.openPreview){needsFallback=true;media.pause();clearTimer();compatible.hidden=false;wrap.dataset["playback"]="needs-decoder";status.textContent=en?"Use compatible playback for this video encoding.":"此视频编码请使用兼容播放。";}};
    media.addEventListener("loadedmetadata",checkVideo);
    const appendSource = (url:string,type:string) => {
      const n=document.createElement("source"), currentAttempt=attempt; n.src=url;if(type)n.type=type;
      n.addEventListener("error",()=>{if(currentAttempt===attempt && ++failedSources>=media.querySelectorAll("source").length)failed();});media.append(n);
    };
    online.addEventListener("click",()=>{
      if(signal.aborted)return;
      attempt++; failedSources=0;media.replaceChildren();for(const s of remote)appendSource(s.url,s.type);
      online.hidden=true;wrap.dataset["mode"]="online";loading();
      media.preload="metadata";media.load();void media.play().catch(error=>{
        if(signal.aborted)return;
        if(error?.name==="NotAllowedError"){clearTimer();status.textContent=en?"Press play to begin.":"点击播放器开始播放。";}
        else if(error?.name!=="AbortError")failed();
      });
    });
    media.addEventListener("canplay",ready);media.addEventListener("playing",ready);
    media.addEventListener("waiting",loading);media.addEventListener("stalled",loading);
    media.addEventListener("error",()=>{failed();checkVideo();});
    for(const [index,s] of remote.entries()){
      const link=document.createElement("a");link.href=s.url;link.target="_blank";link.rel="noopener noreferrer";link.className="cloudig-media-link";
      link.textContent=(en?"Original media":"原始媒体")+(remote.length>1?` ${index+1}`:"");
      if(options.openExternal)link.addEventListener("click",event=>{event.preventDefault();options.openExternal!(s.url);});controls.append(link);
    }
    controls.prepend(online,compatible);wrap.append(stage,media);if(media.localName==="audio")wrap.append(mountAudioControls(media,en,signal));wrap.append(controls,status);wrap.dataset["mode"]="pending";
    const tracks = [...original.querySelectorAll('track[src]')];
    if (tracks.length) void (async () => {
      const track = tracks.find(t => t.hasAttribute("default")) ?? tracks[0]!, path = options.resolve(track.getAttribute("src")!);
      if (!path) return; const file = await options.readFile(path, signal); if (!file || signal.aborted) return;
      const cues = readMediaCues(new TextDecoder().decode(file.bytes)); if (!cues.length) return;
      const viewport = document.createElement("div"); viewport.className = "cloudig-lyrics-viewport";
      const lyrics = document.createElement("ol"); lyrics.className = "cloudig-media-lyrics cloudig-timed-lyrics";
      lyrics.setAttribute("aria-label", en ? "Lyrics / captions" : "歌词 / 字幕");
      const lines = cues.map(cue => {
        const line = document.createElement("li"), plain = new document.defaultView!.DOMParser().parseFromString(cue.text, "text/html");
        line.textContent = plain.body.textContent; lyrics.append(line); return line;
      }); viewport.append(lyrics); stage.append(viewport); let current = -1;
      const position = () => {
        const line = lines[Math.max(0,current)]!;
        // Move the lyric track, not a scrollbar and never the conversation.
        lyrics.style.transform = `translateY(${viewport.clientHeight / 2 - line.offsetTop - line.offsetHeight / 2}px)`;
      };
      const update = () => {
        const next = cues.findIndex(cue => media.currentTime >= cue.start && media.currentTime < cue.end); if (next === current) return;
        if (current >= 0) lines[current]!.removeAttribute("aria-current"); current = next;
        if (next >= 0) { lines[next]!.setAttribute("aria-current", "true"); position(); }
      };
      media.addEventListener("timeupdate", update); media.addEventListener("seeked", update);
      const Resize = document.defaultView!.ResizeObserver;
      if (Resize) { const observer = new Resize(position); observer.observe(viewport); cleanups.push(() => observer.disconnect()); }
      position(); update();
    })().catch(() => { /* An unavailable caption does not discard playable media. */ });
    void (async()=>{
      const poster = original.getAttribute("poster"), posterPath = poster ? options.resolve(poster) : undefined;
      if (posterPath) {
        try {
        const file = await options.readFile(posterPath, signal); if (signal.aborted) return;
        if (file?.mime.startsWith("image/")) {
          // The Reader allows owned data images, not arbitrary Blob image
          // origins. Reuse that boundary instead of weakening its CSP.
          const url = await new Promise<string>((resolve,reject)=>{
            const reader=new document.defaultView!.FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);
            reader.readAsDataURL(new document.defaultView!.Blob([file.bytes],{type:file.mime}));
          }); if(signal.aborted)return;
          if(media instanceof document.defaultView!.HTMLVideoElement)media.poster=url;
          else {const cover=document.createElement("img");cover.src=url;cover.alt="";cover.className="cloudig-media-cover";stage.prepend(cover);}
        }
        } catch { /* A missing cover must not prevent audio/video playback. */ }
      }
      let local=0;
      for(const s of sources){
        const path=options.resolve(s.url);
        if(path){const file=await options.readFile(path,signal);if(signal.aborted)return;if(file&&/^(?:video|audio)\//u.test(file.mime)){
          const url=document.defaultView!.URL.createObjectURL(new Blob([file.bytes],{type:file.mime}));urls.push(url);appendSource(url,file.mime);nativePath??=path;local++;
        }}else if(/^data:(?:video|audio)\/[\w.+-]+(?:;[^,]*)?,/iu.test(s.url)){appendSource(s.url,s.type);local++;}
      }
      if(signal.aborted)return;
      if(local){wrap.dataset["mode"]="offline";media.preload="metadata";loading();media.load();}
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
    const next=document.createElement(safe);
    if(element.hasAttribute("data-cloudig-lyrics")){next.className="cloudig-media-lyrics";next.dataset["scrollRegion"]="";}
    for(const child of element.childNodes)copy(child,next);target.appendChild(next);
  };
  for(const child of parsed.body.childNodes)copy(child,root);
  const close=()=>{for(const cleanup of cleanups)cleanup();for(const media of players){media.pause();media.removeAttribute("src");media.replaceChildren();media.load();}for(const url of urls)document.defaultView!.URL.revokeObjectURL(url);};
  if(signal.aborted)close();else signal.addEventListener("abort",close,{once:true});
  return root;
}
