/** Runtime geometry only: never persisted into Conversation or session state. */
export type WorkSize = Readonly<{ height: number; layout: "flow" | "viewport" }>;
export const WORK_WINDOW_LAYOUT = Object.freeze({ margin:24, compactMargin:12, compactHeight:800, minimumBody:120, tolerance:1 });

export function readWorkSize(value: unknown): WorkSize | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return {height:value,layout:"flow"};
  if (!value || typeof value !== "object") return;
  const v=value as Partial<WorkSize>;
  if (typeof v.height !== "number" || !Number.isFinite(v.height) || v.height < 0 || !["flow","viewport"].includes(v.layout??"")) return;
  return {height:v.height,layout:v.layout!};
}

export function workWindowHeight(available:number, chrome:number, size?:WorkSize):number {
  return Math.min(available, size?.layout==="flow" ? Math.max(WORK_WINDOW_LAYOUT.minimumBody,size.height)+chrome : available);
}

/** Both native work frames and GPT compositions share one viewport cap.
 * Composition width may depend on this cap, never on the resulting height. */
export function bindWorkWindowLayout(dialog:HTMLDialogElement, header:HTMLElement, body:HTMLElement, content?:HTMLElement):{
  update:(size:WorkSize)=>void; refresh:()=>void; close:()=>void;
} {
  const host=dialog.ownerDocument.defaultView!;
  let size:WorkSize|undefined, closed=false, pending:number|undefined;
  const px=(v:string)=>parseFloat(v)||0;
  const apply=()=>{
    pending=undefined;if(closed||!dialog.isConnected)return;
    const height=host.visualViewport?.height??host.innerHeight;
    const margin=height<=WORK_WINDOW_LAYOUT.compactHeight?WORK_WINDOW_LAYOUT.compactMargin:WORK_WINDOW_LAYOUT.margin;
    const available=Math.max(0,height-margin*2), shell=host.getComputedStyle(dialog), bs=host.getComputedStyle(body);
    const chrome=header.getBoundingClientRect().height+px(shell.borderTopWidth)+px(shell.borderBottomWidth)+px(bs.paddingTop)+px(bs.paddingBottom);
    dialog.style.setProperty("--cloudig-window-body-limit",`${Math.max(0,available-chrome)}px`);
    if(content&&!content.querySelector('.cloudig-dil-loading'))size={height:content.getBoundingClientRect().height,layout:"flow"};
    const target=workWindowHeight(available,chrome,size), previous=parseFloat(dialog.style.getPropertyValue("--cloudig-window-height"));
    if(!Number.isFinite(previous)||Math.abs(previous-target)>WORK_WINDOW_LAYOUT.tolerance)dialog.style.setProperty("--cloudig-window-height",`${target}px`);
    dialog.dataset["workLayout"]=size?.layout??"pending";
  };
  const refresh=()=>{if(closed||pending!==undefined)return;if(typeof host.requestAnimationFrame==="function")pending=host.requestAnimationFrame(apply);else apply();};
  const observer=typeof host.ResizeObserver==="function"?new host.ResizeObserver(refresh):undefined;
  observer?.observe(header);if(content)observer?.observe(content);
  host.addEventListener("resize",refresh);host.visualViewport?.addEventListener("resize",refresh);refresh();
  return {update(value){size=value;refresh();},refresh,close(){closed=true;observer?.disconnect();if(pending!==undefined)host.cancelAnimationFrame?.(pending);host.removeEventListener("resize",refresh);host.visualViewport?.removeEventListener("resize",refresh);}};
}
