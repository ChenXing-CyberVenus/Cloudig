import { isJsonObject, type JsonObject } from "../../../core/contracts/types.mts";
import { DilSession, DIL_SOURCE_FORMAT, DIL_VIEW_FORMAT, type DilNode } from "../../../core/records/dil-program.mts";
import { parseRecordJson } from "../../../core/records/json.mts";
import { containerDisplay } from "../../../core/records/content-container.mts";
import { paintDil, morphDilChildren, dilColor, type DilAction } from "./dil-controls.mts";
import { boxImages, boxLink, type BoxContext } from "./box-controls.mts";
import { chartBox } from "./data-boxes.mts";
import { savedDilChart } from "./dil-chart-evidence.mts";
import { mapBox } from "./map-box.mts";
import { openInteractiveWindow } from "./interactive-window.mts";
import { readInteractiveState, saveInteractiveState, type InteractiveFile, type InteractiveBindings } from "./interactive-protocol.mts";
import { loadInteractiveDependencies } from "./interactive-dependencies.mts";

const obj=(v:unknown):JsonObject=>isJsonObject(v)?v:{};
const str=(v:unknown):string=>typeof v==="string"?v:"";
const list=(v:unknown):JsonObject[]=>Array.isArray(v)?v.filter(isJsonObject):[];
// The source's native categorical palette: one bar series distinguishes rows;
// multiple series distinguish series. An explicit source colour always wins.
const DIL_CHART_COLORS=["#0285ff","#924ff7","#fb6a22","#04b84c","#e6aa00"];
type Context={bundle:JsonObject;session:DilSession};
export type DilContexts=Map<string,Promise<Context>>;
export type DilViewOptions=BoxContext&Readonly<{
  theme:"dawn"|"star-night"; stateKey:string;
  readFile:(path:string,signal:AbortSignal)=>Promise<InteractiveFile|undefined>;
  attachment:(path:string,title?:string)=>HTMLElement;
  text:(value:JsonObject)=>HTMLElement;
  frameUrl?:string;dependenciesUrl?:string;
}>;
export const isDilView=(block:JsonObject):boolean=>!!containerDisplay(block)&&obj(block["data"])["format"]===DIL_VIEW_FORMAT;
let viewInstance=0;
const findNode=(v:any,key:string):DilNode|undefined=>{if(v?.key===key)return v;for(const c of Array.isArray(v)?v:v?.children??[]){const n=findNode(c,key);if(n)return n;}return;};

function context(options:DilViewOptions,cache:DilContexts):Promise<Context>{
  const existing=cache.get(options.stateKey);if(existing)return existing;
  const load=(async()=>{
    const file=await options.readFile("ui.json",options.signal);if(!file)throw new Error("Missing UI definition");
    const bundle=obj(parseRecordJson(new TextDecoder("utf-8",{fatal:true}).decode(file.bytes)));
    if(bundle["format"]!==DIL_SOURCE_FORMAT||!str(bundle["code"]))throw new Error("Unsupported saved UI definition");
    const saved=readInteractiveState(options.stateKey)["dil"];
    const state=saved?obj(parseRecordJson(saved)):obj(bundle["captured_state"]);
    const session=new DilSession(str(bundle["code"]),obj(bundle["constants"]),obj(bundle["app_data"]),state);
    const unsubscribe=session.subscribe(()=>saveInteractiveState(options.stateKey,{dil:JSON.stringify(session.state)}));
    options.signal.addEventListener("abort",unsubscribe,{once:true});
    return {bundle,session};
  })();cache.set(options.stateKey,load);return load;
}
function resolvedPaths(state:unknown,bundle:JsonObject):string[]{
  const urls=obj(bundle["source_links"]),paths:string[]=[],pending=[state];
  while(pending.length){const v=pending.pop();if(typeof v==="string"&&typeof urls[v]==="string")paths.push(String(urls[v]));else if(Array.isArray(v))pending.push(...[...v].reverse());else if(isJsonObject(v))pending.push(...Object.values(v).reverse());}
  return [...new Set(paths)];
}
function chart(ctx:DilViewOptions,v:DilNode):HTMLElement{
  const p=v.props,data=Array.isArray(p["data"])?p["data"]:[],series=Array.isArray(p["series"])?p["series"]:[],x=typeof p["xAxis"]==="string"?p["xAxis"]:p["xAxis"]?.dataKey??"name";
  if(v.tag==="pie-chart"){
    const root=ctx.document.createElement("div"),svg=ctx.document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 600 300");svg.setAttribute("class","cloudig-dil-svg");
    const total=data.reduce((n:number,row:any)=>n+Math.max(0,Number(row[series[0]?.dataKey??"value"])||0),0);let angle=-Math.PI/2;
    data.forEach((row:any,i:number)=>{const value=Math.max(0,Number(row[series[0]?.dataKey??"value"])||0),next=angle+(total?value/total*Math.PI*2:0),path=ctx.document.createElementNS(svg.namespaceURI,"path");
      path.setAttribute("d",`M160,150 L${160+110*Math.cos(angle)},${150+110*Math.sin(angle)} A110,110 0 ${next-angle>Math.PI?1:0},1 ${160+110*Math.cos(next)},${150+110*Math.sin(next)} Z`);path.setAttribute("fill",dilColor(row.color??row.fill)||dilColor(series[0]?.color)||DIL_CHART_COLORS[i%DIL_CHART_COLORS.length]!);svg.append(path);angle=next;
      const label=ctx.document.createElementNS(svg.namespaceURI,"text");label.setAttribute("x","310");label.setAttribute("y",String(60+i*30));label.setAttribute("fill","currentColor");label.textContent=`${String(row[x]??"")}: ${value}`;svg.append(label);
    });root.append(svg);return root;
  }
  const type=series[0]?.type??"bar";
  const input:JsonObject={style:type,title:"",x_axis:{data:data.map((r:any)=>String(r[x]??""))},series:series.map((s:any,i:number)=>({name:String(s.label??s.dataKey??""),values:data.map((r:any)=>typeof r[s.dataKey]==="number"?r[s.dataKey]:null),color:dilColor(s.color)||DIL_CHART_COLORS[i%DIL_CHART_COLORS.length]!,...(type==="bar"?{point_colors:data.map((r:any,j:number)=>dilColor(r.color??r.fill)||dilColor(s.color)||DIL_CHART_COLORS[(series.length===1?j:i)%DIL_CHART_COLORS.length]!)}:{}),...(type==="scatter"?{points:data.map((r:any)=>({x:r[x],y:r[s.dataKey]}))}:{})}))};
  return chartBox(ctx,input);
}

function mountView(options:DilViewOptions,ctx:Context,index:number,parent:HTMLElement):void{
  const {document,signal}=options,{bundle,session}=ctx;
  const idPrefix=`cloudig-dil-${++viewInstance}`;
  const views=new Map<string,()=>void>(),updates=new Map<string,()=>void>();let actions=new Map<string,DilAction>();
  const mounts=new Map<string,(node:HTMLElement)=>void>();
  const localSignal=(abort:AbortController)=>{if(signal.aborted)abort.abort();else signal.addEventListener("abort",()=>abort.abort(),{once:true});};
  const action=(fn:unknown,args:unknown[]=[])=>{
    if(signal.aborted)return;
    const result=session.dispatch(fn,args) as {action?:string;value?:string}|undefined;
    if(result?.action==="copy"&&typeof result.value==="string")void document.defaultView?.navigator.clipboard?.writeText(result.value);
    if(result?.action==="openUrl"&&/^https?:\/\//u.test(result.value??""))options.onOpenExternal?.(result!.value!);
  };
  const placeholder=(v:DilNode,key:string,build:(host:HTMLElement)=>void):HTMLElement=>{
    const node=document.createElement("div");node.className="cloudig-dil-widget";node.dataset["dilKey"]=key;node.dataset["dilPreserve"]=key;
    mounts.set(key,build);return node;
  };
  const work=(v:DilNode,key:string,ref:JsonObject,referenceIndex:number):HTMLElement=>placeholder(v,key,host=>{
    host.classList.add("cloudig-dil-work");const data=obj(ref["data"]),source=str(data["content"]),title=str(data["title"])||str(data["language"])||"Work";
    const mediaOnly=ref["category"]==="app_block"&&!/<script\b|<canvas\b/iu.test(source)&&/<(?:video|audio)\b/iu.test(source);
    if(mediaOnly){const saved=list(bundle["media"]).filter(m=>m["reference_index"]===referenceIndex),available=saved.find(m=>obj(bundle["resource_paths"])[str(m["resource_id"])]);if(!available){host.classList.add("cloudig-dil-readonly");host.textContent=title;return;}}
    const editorKey=`${options.stateKey}:editor:${referenceIndex}`;
    let currentSource=readInteractiveState(editorKey)["source"]??source,closeRun:(()=>void)|undefined;const controller=new AbortController();localSignal(controller);
    const liveNode=()=>findNode(session.render(index),v.key)??v;
    const bindings={snapshot:():InteractiveBindings=>{const binds=liveNode().props["bind"]??{},values:Record<string,any>={},callbacks:string[]=[];for(const [name,raw]of Object.entries(binds)as [string,any][]){if(raw?.__appBlockBindEntry==="callback")callbacks.push(name);else if(raw?.__appBlockBindEntry==="value"){try{values[name]=JSON.parse(raw.value);}catch{}}}return {values,callbacks};},subscribe:(update:()=>void)=>session.subscribe(update),invoke:(name:string,args:unknown[])=>{const bind=liveNode().props["bind"]?.[name];if(bind?.__appBlockBindEntry==="callback")action(bind.value,args);}};
    const run=()=>{
      closeRun?.();
      const entry="work.html";
      const instance=openInteractiveWindow({document,title,entry,format:"html",source:"chatgpt.com_app_block",inlineParent:host,stateKey:`${options.stateKey}:${referenceIndex}`,theme:options.theme,language:options.language,signal:controller.signal,
        ...(options.frameUrl?{frameUrl:options.frameUrl,opaqueOrigin:true}:{}),bindings,
        readFiles:async readSignal=>{
          const files:InteractiveFile[]=[{path:entry,mime:"text/html",bytes:new TextEncoder().encode(currentSource).buffer as ArrayBuffer}];
          for(const [url,path]of Object.entries(obj(bundle["source_links"])))if(typeof path==="string"&&currentSource.includes(url)){const file=await options.readFile(path,readSignal);if(file)files.push({...file,aliases:[...file.aliases??[],url]});}
          return files;
        },dependencies:(files,s)=>loadInteractiveDependencies(files,s,options.dependenciesUrl??new URL("/runtime/dependencies/",document.baseURI).href,"html")});closeRun=instance.close;
    };
    if(ref["category"]==="code_block"&&data["editable"]===true){const details=document.createElement("details"),label=document.createElement("summary"),editor=document.createElement("textarea"),apply=document.createElement("button");label.textContent=options.language==="en"?"Edit source":"编辑源码";editor.className="cloudig-dil-editor";editor.value=currentSource;apply.type="button";apply.className="cloudig-box-button";apply.textContent=options.language==="en"?"Preview":"预览";apply.addEventListener("click",()=>{if(controller.signal.aborted)return;currentSource=editor.value;saveInteractiveState(editorKey,{source:currentSource});run();});details.append(label,editor,apply);host.append(details);}
    run();views.set(key,()=>{controller.abort();closeRun?.();});
  });
  const widget=(v:DilNode,key:string):HTMLElement|undefined=>{
    const p=v.props;
    if(v.tag==="icon"){
      const n=placeholder(v,key,h=>{const path=obj(bundle["icons"])[String(p["name"])];if(typeof path==="string")h.append(options.image(path,String(p["name"]),"current"));else h.textContent="◇";});n.className="cloudig-dil-icon";n.setAttribute("aria-hidden","true");
      return n;
    }
    if(v.tag==="chart"||v.tag==="pie-chart")return placeholder(v,key,h=>{const update=()=>{const current=findNode(session.render(index),v.key)??v;h.replaceChildren(chart(options,current));};update();updates.set(key,update);});
    if(["AsyncImage","AsyncImageGroup","Cite","Link","Entity"].includes(v.tag)){
      const result=obj(obj(obj(bundle["app_data"])["opGenui"])["componentResults"]),state=obj(obj(result[String(p["__resolutionId"])])["state"]);
      if(v.tag.startsWith("AsyncImage"))return placeholder(v,key,host=>{host.classList.add("cloudig-box","cloudig-dil-gallery");const gallery=boxImages(options,resolvedPaths(state,bundle),String(p["alt"]??p["query"]??""));if(gallery)host.append(gallery);});
      if(v.tag==="Entity"){const n=document.createElement("span");n.className="cloudig-source-link";n.textContent=str(state["value"])||String(p["value"]??"");return n;}
      if(v.tag==="Cite"){const n=document.createElement("span");for(const item of list(state["items"]))n.append(boxLink(options,str(item["source_label"])||str(item["title"])||str(item["url"]),str(item["url"])));return n;}
      const url=str(state["url"])||String(p["url"]??""),title=str(state["title"])||String(p["title"]??url),path=obj(bundle["source_links"])[url];
      return typeof path==="string"?placeholder(v,key,h=>h.append(options.attachment(path,title))):boxLink(options,title,url);
    }
    if(v.tag==="favicon"){const n=document.createElement("span");n.textContent="↗";n.setAttribute("aria-hidden","true");return n;}
    if(v.tag!=="__chatgptClientDefinedWidget")return;
    const refIndex=Number(obj(obj(bundle["widgets"])[String(p["invocationId"])])["refIndex"]),ref=list(bundle["references"])[refIndex];if(!ref)return document.createElement("span");
    const data=obj(ref["data"]),snapshot=obj(bundle["snapshots"])[String(refIndex)];
    if(ref["category"]==="visualization")return placeholder(v,key,host=>{
      if(typeof snapshot==="string")host.append(savedDilChart(options,snapshot,data));
      else {const spec=obj(data["content"]),series=list(spec["series"]).map(s=>({...s,type:spec["chartType"]}));host.append(chart(options,{tag:spec["chartType"]==="pie"?"pie-chart":"chart",key:v.key,children:[],props:{data:spec["data"],series,xAxis:spec["xKey"]??spec["nameKey"]}}));}
    });
    if(ref["category"]==="map")return placeholder(v,key,host=>{
      if(typeof snapshot==="string")host.append(options.image(snapshot,str(data["title"])));
      const locations=list(data["points"]).map(p=>({place_id:str(p["id"]),name:str(p["name"]),latitude:p["latitude"]!,longitude:p["longitude"]!,address:str(p["address"]),notes:str(p["description"])}));
      const enriched:JsonObject={},images:JsonObject[]=[];
      for(const point of list(data["points"])){
        const id=str(point["id"]),e=obj(point["entity"]);
        enriched[id]={...(typeof e["rating"]==="number"?{rating:e["rating"]}:{}),...(typeof e["review_count"]==="number"?{rating_count:e["review_count"]}:{}),website:str(e["website_url"]),maps_url:str(e["provider_url"]),phone_number:str(e["phone"])};
        for(const path of resolvedPaths(e,bundle))images.push({source_id:id,path});
      }
      if(str(data["narrative"]))host.append(options.text({type:"markdown",text:data["narrative"]!}));
      for(const group of list(data["groups"])){
        const section=document.createElement("section"),heading=document.createElement("h4"),ordered=document.createElement("ol");heading.textContent=str(group["title"]);
        for(const place of list(group["locations"])){const item=document.createElement("li");item.textContent=str(place["name"]);ordered.append(item);}
        section.append(heading,ordered);
        const route=obj(group["route"]),facts=document.createElement("p");
        facts.textContent=[str(route["route_mode"]),typeof route["distance_meters"]==="number"?`${(route["distance_meters"]/1000).toFixed(2)} km`:"",typeof route["duration_seconds"]==="number"?`${Math.round(route["duration_seconds"]/60)} min`:""].filter(Boolean).join(" · ");
        if(facts.textContent)section.append(facts);host.append(section);
      }
      host.append(mapBox(options,{title:data["title"]??"Map",locations},{enriched_places:enriched},images));
    });
    if(ref["category"]==="writing_block")return placeholder(v,key,h=>h.append(options.text({type:"markdown",text:str(data["content"])})));
    if(ref["category"]==="app_block"||ref["category"]==="code_block"&&data["language"]==="html")return work(v,key,ref,refIndex);
    if(ref["category"]==="code_block")return options.text({type:"code",language:str(data["language"]),code:str(data["content"])});
    const fallback=document.createElement("div");fallback.textContent=str(ref["alt"]);return fallback;
  };
  const paint=()=>{
    if(signal.aborted)return;const nextActions=new Map<string,DilAction>(),fresh=document.createElement("div");mounts.clear();
    fresh.append(paintDil({document,session,actions:nextActions,special:widget,language:options.language,idPrefix,math:(tex,display)=>options.text({type:"math",tex,display})},session.render(index)));
    morphDilChildren(parent,fresh);actions=nextActions;
    const live=new Set<string>();
    for(const node of parent.querySelectorAll<HTMLElement>("[data-dil-preserve]")){const key=node.dataset["dilPreserve"]!;live.add(key);if(node.dataset["dilMounted"])continue;node.dataset["dilMounted"]="true";mounts.get(key)?.(node);}
    for(const [key,close]of views)if(!live.has(key)){close();views.delete(key);}
    for(const [key,update]of updates){if(live.has(key))update();else updates.delete(key);}
  };
  for(const event of ["click","input","change","submit"]){const handle=(e:Event)=>{
    const target=e.target instanceof document.defaultView!.Element?e.target.closest<HTMLElement>("[data-dil-action]"):null;
    const a=target?actions.get(target.dataset["dilAction"]!):undefined;
    if(event==="submit")e.preventDefault();if(!a||a.event!==event||signal.aborted)return;
    const input=target as HTMLInputElement;
    action(a.fn,Object.hasOwn(a,"value")?[a.value]:a.boolean?[input.checked]:a.number?[Number(input.value)]:event==="click"||event==="submit"?[]:[input.value]);
  };parent.addEventListener(event,handle);signal.addEventListener("abort",()=>parent.removeEventListener(event,handle),{once:true});}
  paint();const stop=session.subscribe(paint);signal.addEventListener("abort",()=>{stop();for(const close of views.values())close();views.clear();},{once:true});
}

export function renderDilView(options:DilViewOptions,block:JsonObject,cache:DilContexts):HTMLElement{
  const {document,signal}=options,index=Number(obj(block["data"])["root"]),host=document.createElement("section"),title=str(block["title"])||(options.language==="en"?"Work":"作品");
  host.className="cloudig-dil-view";host.dataset["dilView"]=String(index);
  const mount=async(parent:HTMLElement,viewOptions:DilViewOptions)=>{
    const loading=document.createElement("div");loading.className="cloudig-dil-loading";loading.textContent=options.language==="en"?"Opening…":"正在打开…";parent.append(loading);
    try{const ctx=await context(options,cache);if(viewOptions.signal.aborted)return;loading.remove();mountView(viewOptions,ctx,index,parent);}
    catch(error){if(viewOptions.signal.aborted)return;loading.remove();parent.textContent=str(obj(block["data"])["text"]);console.warn("Saved UI could not mount",error);}
  };
  if(containerDisplay(block)==="window"){
    host.classList.add("cloudig-box","cloudig-window-entry");const h=document.createElement("h3"),open=document.createElement("button");h.className="cloudig-work-title";h.textContent=title;open.type="button";open.className="cloudig-box-button cloudig-work-open";open.textContent=options.language==="en"?"Open":"打开";
    let close:(()=>void)|undefined;
    open.addEventListener("click",()=>{
      if(signal.aborted||close)return;const abort=new AbortController(),dialog=document.createElement("dialog"),header=document.createElement("header"),caption=document.createElement("h2"),done=document.createElement("button"),body=document.createElement("div"),view=document.createElement("div");
      dialog.className="cloudig-conversation-renderer cloudig-interactive-window cloudig-dil-window";dialog.dataset["theme"]=options.theme;header.className="cloudig-interactive-header";caption.textContent=title;done.type="button";done.className="cloudig-interactive-close";done.textContent="×";done.setAttribute("aria-label",options.language==="en"?"Close":"关闭");body.className="cloudig-interactive-body";body.dataset["scrollRegion"]="";view.className="cloudig-dil-view";
      close=()=>{if(!close)return;close=undefined;abort.abort();dialog.close();dialog.remove();signal.removeEventListener("abort",dismiss);if(!signal.aborted)open.focus();};const dismiss=()=>close?.();
      done.addEventListener("click",dismiss);dialog.addEventListener("cancel",e=>{e.preventDefault();dismiss();});signal.addEventListener("abort",dismiss,{once:true});header.append(caption,done);body.append(view);dialog.append(header,body);document.body.append(dialog);dialog.showModal();void mount(view,{...options,signal:abort.signal});
    });host.append(h,open);
  }else void mount(host,options);
  return host;
}
