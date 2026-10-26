import type { DilNode, DilSession } from "../../../core/records/dil-program.mts";

export type DilAction = { event: string; fn: unknown; value?: unknown; boolean?: boolean; number?: boolean };
export type DilPaint = {
  document: Document; session: DilSession; actions: Map<string, DilAction>;
  special: (node: DilNode, key: string) => HTMLElement | undefined;
  math: (tex: string, display: boolean) => HTMLElement;
  language: "zh" | "en";
  idPrefix: string;
};
const svgTags = new Set(["svg", "g", "defs", "linearGradient", "radialGradient", "stop", "line", "circle", "ellipse", "rect", "path", "polygon", "polyline", "text", "tspan", "clipPath", "mask"]);
const svgAttrs = new Set(["viewBox", "preserveAspectRatio", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "d", "points", "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeDashoffset", "opacity", "fillOpacity", "strokeOpacity", "offset", "stopColor", "stopOpacity", "gradientUnits", "gradientTransform", "transform", "id", "clipPath", "textAnchor", "fontSize", "fontWeight"]);
export const dilColor = (value: unknown): string => {
  const s = typeof value === "string" ? value : "";
  if (["danger", "success", "warning", "info"].includes(s)) {
    const fallback: Record<string,string> = { danger:"#bd4545", success:"#168653", warning:"#bc791b", info:"#428bd2" };
    return `var(--cloudig-dil-${s},${fallback[s]})`;
  }
  const tokens: Record<string,string> = { border:"var(--cloudig-border)", primary:"var(--cloudig-text)", secondary:"var(--cloudig-muted)", tertiary:"var(--cloudig-muted)", surface:"var(--cloudig-dil-canvas)", "surface-primary":"var(--cloudig-dil-canvas)", "surface-secondary":"var(--cloudig-dil-surface)", "surface-tertiary":"var(--cloudig-dil-surface-strong)", "surface-elevated":"var(--cloudig-dil-elevated)", accent:"var(--cloudig-accent)", discovery:"#924ff7", danger:"#bd4545", success:"#168653", warning:"#bc791b", info:"#428bd2", blue:"#0285ff", purple:"#924ff7", orange:"#fb6a22", green:"#04b84c" };
  return tokens[s] ?? (/^(?:#[a-f\d]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/+-]+\)|transparent|currentColor|white|black)$/iu.test(s) ? s : "");
};
function style(element: HTMLElement, node: DilNode): void {
  const p=node.props,s=element.style,t=node.tag;
  const container=["box","col","row","card","form","grid-item"].includes(t),direction=t==="row"?"row":t==="col"?"column":p["direction"]==="row"?"row":"column";
  const scalar=(v:unknown):string=>typeof v==="string"||typeof v==="number"?String(v):"";
  const dimension=(v:unknown):string=>typeof v==="number"&&Number.isFinite(v)?`${v}px`:typeof v==="string"&&/^(?:\d+(?:\.\d+)?(?:px|%|rem|em|vh|vw|dvh|dvw)|auto|fit-content|min-content|max-content)$/u.test(v)?v:"";
  const spacing=(v:unknown):string=>typeof v==="number"&&Number.isFinite(v)?`${Math.max(0,v)*4}px`:dimension(v);
  if(container){s.display="flex";s.flexDirection=direction;}
  for(const [key,css]of [["gap","gap"],["rowGap","row-gap"],["columnGap","column-gap"],["padding","padding"],["paddingX","padding-inline"],["paddingY","padding-block"]]){const value=spacing(p[key!]);if(value)s.setProperty(css!,value);}
  if(p["padding"]&&typeof p["padding"]==="object")for(const [key,value]of Object.entries(p["padding"])){const side=({top:"top",bottom:"bottom",left:"left",right:"right",x:"inline",y:"block",inline:"inline",block:"block",inlineStart:"inline-start",inlineEnd:"inline-end",blockStart:"block-start",blockEnd:"block-end"}as Record<string,string>)[key];if(side&&spacing(value))s.setProperty(`padding-${side}`,spacing(value));}
  const width=p["width"]??(container?p["size"]:undefined),height=p["height"]??(container?p["size"]:undefined);
  for(const [key,value]of Object.entries({width,height,minWidth:p["minWidth"]??(container?p["minSize"]:undefined),maxWidth:p["maxWidth"]??(container?p["maxSize"]:undefined),minHeight:p["minHeight"]??(container?p["minSize"]:undefined),maxHeight:p["maxHeight"]??(container?p["maxSize"]:undefined)}))if(dimension(value))(s as any)[key]=dimension(value);
  const background=["primary","secondary","tertiary"].includes(p["background"])?`surface-${p["background"]}`:p["background"];
  if(background&&dilColor(background)){s.backgroundColor=dilColor(background);element.dataset["dilSurface"]="explicit";} if(p["color"]&&dilColor(p["color"]))s.color=dilColor(p["color"]);
  if(p["border"]){s.border=typeof p["border"]==="number"?`${Math.max(0,p["border"])}px solid var(--cloudig-border)`:typeof p["border"]==="string"&&/^[\w\s#.,%()-]+$/u.test(p["border"])?p["border"]:"1px solid var(--cloudig-border)";element.dataset["dilBorder"]="true";}
  if(typeof p["radius"]==="number"||typeof p["radius"]==="string")s.borderRadius=typeof p["radius"]==="number"?`${Math.max(0,p["radius"])}px`:({none:"0",full:"9999px","2xs":"2px",xs:"3px",sm:"4px",md:"6px",lg:"8px",xl:"12px","2xl":"16px","3xl":"24px","4xl":"32px"} as Record<string,string>)[p["radius"]]??"8px";
  if(typeof p["align"]==="string")s.alignItems=({start:"flex-start",end:"flex-end"} as Record<string,string>)[p["align"]]??p["align"];
  if(typeof p["justify"]==="string")s.justifyContent=({between:"space-between",start:"flex-start",end:"flex-end"} as Record<string,string>)[p["justify"]]??p["justify"];
  if(p["wrap"])s.flexWrap=p["wrap"]==="reverse"?"wrap-reverse":"wrap";
  if(typeof p["flex"]==="number"||/^(?:\d+(?:\.\d+)?(?: \d+(?:\.\d+)?(?: (?:auto|\d+(?:px|%|rem)?))?)?|auto|none)$/u.test(scalar(p["flex"])))s.flex=scalar(p["flex"]);
  else if(container){const fixed=direction==="row"?width:height;if(p["flexInRow"])s.flex=`var(--cloudig-flex-in-row,${fixed!=null&&fixed!=="auto"?"0 0 auto":"0 1 auto"})`;else if(fixed!=null&&fixed!=="auto")s.flexShrink="0";}
  if(p["aspectRatio"]!==undefined&&/^(?:\d+(?:\.\d+)?)(?:\s*[:/]\s*\d+(?:\.\d+)?)?$/u.test(scalar(p["aspectRatio"])))s.aspectRatio=scalar(p["aspectRatio"]).replace(":"," / ");
  if(p["clip"])s.overflow="hidden";else if(p["scrollable"]){s.overflow="auto";element.dataset["scrollRegion"]="";}
  if(p["disableAutoSpacing"]&&p["gap"]==null&&p["rowGap"]==null&&p["columnGap"]==null)s.gap="0";
  if(scalar(p["weight"]))s.fontWeight=String(({medium:500,semibold:600,bold:700} as Record<string,number>)[scalar(p["weight"])]??scalar(p["weight"]));
  if(typeof p["size"]==="string"&&["text","title","label","icon"].includes(t))s.fontSize=`${({"2xs":11,xs:12,sm:14,md:16,lg:20,xl:24,"2xl":30,"3xl":36} as Record<string,number>)[p["size"]]??16}px`;
  if(p["fontSize"]!==undefined&&dimension(p["fontSize"]))s.fontSize=dimension(p["fontSize"]);
  if(p["lineHeight"]!==undefined&&dimension(p["lineHeight"]))s.lineHeight=dimension(p["lineHeight"]);
  if(p["strong"]&&p["weight"]==null)s.fontWeight="600";if(p["italic"])s.fontStyle="italic";
  if(p["underline"])s.textDecoration=p["underline"]==="dotted"?"underline dotted":"underline";else if(p["lineThrough"])s.textDecoration="line-through";
  if(p["truncate"]){s.whiteSpace="nowrap";s.overflow="hidden";s.textOverflow="ellipsis";}
  if(Number.isInteger(p["maxLines"])&&p["maxLines"]>0){s.display="-webkit-box";s.webkitBoxOrient="vertical";s.webkitLineClamp=String(p["maxLines"]);s.overflow="hidden";}
  if(Number.isInteger(p["minLines"])&&p["minLines"]>0)s.minHeight=`${p["minLines"]}lh`;
  if(p["textAlign"]&&["left","right","center","start","end"].includes(p["textAlign"]))s.textAlign=p["textAlign"];
  if(p["preserveWhitespace"])s.whiteSpace="pre-wrap";if(p["tabularNums"])s.fontVariantNumeric="tabular-nums";
  if(p["block"])s.width="100%";
  if(["grid","flow"].includes(t)){
    s.display="grid";const value=p["columns"]??p["cols"]??(t==="grid"?"md":2);
    const tracks=(v:unknown):string=>typeof v==="number"&&Number.isFinite(v)?`repeat(${Math.max(1,Math.floor(v))},minmax(0,1fr))`:Array.isArray(v)&&v.every(x=>typeof x==="number"&&Number.isFinite(x)||typeof x==="string"&&/^(?:\d+(?:\.\d+)?(?:fr|px|%|rem)|auto)$/u.test(x))?v.map(x=>typeof x==="number"?`${x}fr`:x).join(" "):typeof v==="string"&&/^[\d\s.frpx%]+$/u.test(v)?v:"";
    if(["sm","md","lg"].includes(value)){element.dataset["dilGridSize"]=value;s.gridTemplateColumns=`repeat(var(--cloudig-grid-${value},${value==="lg"?1:2}),minmax(0,1fr))`;}
    else if(tracks(value))s.gridTemplateColumns=tracks(value);
    if(dimension(p["minChildWidth"]))s.gridTemplateColumns=`repeat(auto-fit,minmax(min(${dimension(p["minChildWidth"])},100%),1fr))`;
    if(tracks(p["rows"]))s.gridTemplateRows=tracks(p["rows"]);
    if(p["gap"]==null){if(p["rowGap"]==null)s.rowGap="16px";if(p["columnGap"]==null)s.columnGap="12px";}
  }
  if(["grid-item","flow-item"].includes(t)&&Number.isInteger(p["span"]))s.gridColumn=`span ${Math.max(1,Math.min(12,p["span"]))}`;
  if(t==="grid-item"&&Number.isInteger(p["rowSpan"]))s.gridRow=`span ${Math.max(1,p["rowSpan"])}`;
  if(p["ariaLabel"]!=null)element.setAttribute("aria-label",String(p["ariaLabel"]));if(p["ariaHidden"])element.setAttribute("aria-hidden","true");
  if(t==="spacer")s.flex="1";
}
export function paintDil(ctx: DilPaint, value: any, path="r", group?: { value: unknown; fn: unknown; name: string }, svg=false): Node {
  const d=ctx.document;
  if(Array.isArray(value)){const f=d.createDocumentFragment();value.forEach((v,i)=>f.append(paintDil(ctx,v,`${path}.${i}`,group,svg)));return f;}
  if(value==null||typeof value==="boolean")return d.createTextNode("");
  if(typeof value!=="object")return d.createTextNode(String(value));
  const v=value as DilNode,p=v.props??{},t=v.tag,key=`${path}:${v.key}`;
  if(t==="fragment")return paintDil(ctx,v.children,key,group,svg);
  const special=ctx.special(v,key);if(special){
    // Native chart height describes the plot, not our toolbar/legend/table
    // wrapper. Keep that wrapper in normal flow so following content cannot
    // overlap a chart whose responsive SVG needs more vertical space.
    if(t==="chart"||t==="pie-chart"){
      const {height,maxHeight,...props}=p;style(special,{...v,props});
      if(typeof height==="number"&&height>0)special.style.minHeight=`${height}px`;
    }else if(t==="AsyncImage"||t==="AsyncImageGroup"){
      // The source ratio belongs to the image viewport, not the outer card
      // (which may also contain paging controls/captions). One box owns it.
      style(special,v);
      if(special.style.aspectRatio){special.dataset["imageRatio"]="true";special.style.setProperty("--cloudig-image-ratio",special.style.aspectRatio);special.style.aspectRatio="";}
    }else style(special,v);
    return special;
  }
  if(t==="math")return ctx.math(String(p["value"]??""),p["block"]===true);
  if(t==="svg"||svg){
    if(!svgTags.has(t))return d.createTextNode("");
    const n=d.createElementNS("http://www.w3.org/2000/svg",t);n.setAttribute("data-dil-key",key);
    for(const [a,value]of Object.entries(p))if(svgAttrs.has(a)&&(typeof value==="string"||typeof value==="number")){
      let encoded=String(value);
      if(/url\(/iu.test(encoded)&&!/^url\(#[^\s()]+\)$/u.test(encoded))continue;
      if(a==="id")encoded=`${ctx.idPrefix}-${encoded}`;
      else encoded=encoded.replace(/url\(#([^\s()]+)\)/gu,(_all,id:string)=>`url(#${ctx.idPrefix}-${id})`);
      n.setAttribute(["viewBox","preserveAspectRatio","gradientUnits","gradientTransform"].includes(a)?a:a.replace(/[A-Z]/gu,x=>"-"+x.toLowerCase()),encoded);
    }
    if(t==="svg"){n.setAttribute("role","img");n.setAttribute("class","cloudig-dil-svg");}
    n.append(paintDil(ctx,v.children,key,group,true));return n;
  }
  const tags: Record<string,string>={box:"div",row:"div",col:"div",card:"section",grid:"div","grid-item":"div",flow:"div","flow-item":"div",text:"div",title:"h3",bold:"strong",italic:"em",underline:"u",strikethrough:"s",code:"code",caption:"figcaption",divider:"hr",spacer:"span",badge:"span",table:"table","table-row":"tr","table-cell":"td","table-section":"tbody",list:p["ordered"]?"ol":"ul","list-item":"li",blockquote:"blockquote",label:"label",form:"form",button:"button",pressable:"button",slider:"input",checkbox:"label",input:"input",textarea:"textarea",select:"select","date-picker":"input","segmented-control":"div","radio-group":"div",radio:"label",carousel:"section","carousel-item":"div",popover:"div","popover-trigger":"button","popover-content":"div"};
  const n=d.createElement(t==="text"&&p["inline"]?"span":t==="table-cell"&&p["header"]?"th":t==="list"&&(p["marker"]==="number"||p["ordered"])?"ol":tags[t]??"div");n.dataset["dilKey"]=key;n.dataset["dilTag"]=t;n.className=`cloudig-dil-node cloudig-dil-${t}`;style(n,v);
  if(t==="list"){if(Number.isInteger(p["start"]))n.setAttribute("start",String(p["start"]));if(p["reversed"])n.setAttribute("reversed","");}
  if(t==="list-item"){if(Number.isInteger(p["value"]))n.setAttribute("value",String(p["value"]));for(const name of ["label","description"])if(p[name]!=null){const part=d.createElement("div");part.append(paintDil(ctx,p[name],`${key}.${name}`,group));n.append(part);}}
  if(t==="table-cell"&&["left","right","center"].includes(p["align"]))n.style.textAlign=p["align"];
  if(t==="table-row"&&p["header"]){n.style.fontWeight="700";n.dataset["dilHeader"]="true";}
  if(t==="checkbox"&&p["checked"]&&p["lineThrough"])n.style.textDecoration="line-through";
  const action=(element:HTMLElement,event:string,fn:unknown,extra:Omit<DilAction,"event"|"fn">={})=>{if(!fn)return;const id=`${key}:${event}:${ctx.actions.size}`;ctx.actions.set(id,{event,fn,...extra});element.dataset["dilAction"]=id;};
  const children=()=>n.append(paintDil(ctx,v.children,key,group));
  if(t==="popover"){
    for(const [i,child]of v.children.entries()){if(child?.tag==="popover-content"&&!p["open"])continue;n.append(paintDil(ctx,child,`${key}.${i}`,group));}return n;
  }
  if(t==="carousel"){
    // Native carousels do not require an authored activeIndex/onChange. Their
    // children carry widths and scroll in one horizontal rail. Treating them
    // as a one-item controlled pager hid every subsequent item forever.
    if(p["activeIndex"]===undefined&&p["visibleItems"]===undefined&&p["onChange"]===undefined){
      n.dataset["dilCarousel"]="scroll";
      const stage=d.createElement("div");stage.className="cloudig-dil-carousel-stage";stage.dataset["scrollRegion"]="";stage.tabIndex=0;stage.style.gap=n.style.gap||"12px";
      stage.append(paintDil(ctx,v.children,key,group));n.append(stage);
      if(p["showArrows"]!==false&&v.children.length>1){const controls=d.createElement("div");controls.className="cloudig-dil-carousel-controls";for(const direction of [-1,1]){const b=d.createElement("button");b.type="button";b.textContent=direction<0?"‹":"›";b.dataset["dilScrollDirection"]=String(direction);b.setAttribute("aria-label",ctx.language==="en"?(direction<0?"Previous":"Next"):(direction<0?"上一组":"下一组"));controls.append(b);}n.append(controls);}return n;
    }
    const count=v.children.length,visible=Math.max(1,Math.min(count,Number(p["visibleItems"])||1)),index=Math.max(0,Math.min(Math.max(0,count-visible),Number(p["activeIndex"])||0));
    const stage=d.createElement("div");stage.className="cloudig-dil-carousel-stage";stage.style.gridTemplateColumns=`repeat(${visible},minmax(0,1fr))`;
    for(let i=index;i<Math.min(count,index+visible);i++)stage.append(paintDil(ctx,v.children[i],`${key}.${i}`,group));n.append(stage);
    if(count>visible){const controls=d.createElement("div");controls.className="cloudig-dil-carousel-controls";for(const [label,next]of [["‹",index-1],["›",index+1]]as const){const b=d.createElement("button");b.type="button";b.textContent=label;b.disabled=next<0||next>count-visible;b.setAttribute("aria-label",label==="‹"?"Previous":"Next");action(b,"click",p["onChange"],{value:next});controls.append(b);}n.append(controls);}return n;
  }
  if(t==="segmented-control"){
    n.setAttribute("role","group");for(const item of p["options"]??p["items"]??[]){const b=d.createElement("button");b.type="button";b.textContent=String(item.label??item.value);b.setAttribute("aria-pressed",String(item.value===p["value"]));action(b,"click",p["onChange"],{value:item.value});n.append(b);}return n;
  }
  if(t==="radio-group"){n.setAttribute("role","radiogroup");n.append(paintDil(ctx,v.children,key,{name:key,value:p["value"],fn:p["onChange"]}));return n;}
  if(t==="checkbox"||t==="radio"){
    const input=d.createElement("input");input.type=t;input.checked=t==="radio"?group?.value===p["value"]:!!p["checked"];input.disabled=!!p["disabled"];if(group)input.name=group.name;
    action(input,"change",t==="radio"?group?.fn:p["onChange"],t==="radio"?{value:p["value"]}:{boolean:true});n.append(input,paintDil(ctx,v.children,key,group));return n;
  }
  if(["slider","input","textarea","date-picker","select"].includes(t)){
    const input=n as HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
    if(t==="select"){n.classList.add("cloudig-themed-select");n.dataset["scrollPicker"]="";for(const item of p["options"]??[]){const o=d.createElement("option");o.value=String(item.value);o.textContent=String(item.label??item.value);o.disabled=!!item.disabled;input.append(o);}}
    else if(n instanceof d.defaultView!.HTMLInputElement)n.type=t==="slider"?"range":t==="date-picker"?"date":["text","number","email","url","password"].includes(p["type"])?p["type"]:"text";
    for(const a of ["min","max","step","placeholder","rows","maxLength"])if(typeof p[a]==="string"||typeof p[a]==="number")input.setAttribute(a,String(p[a]));
    // Range value sanitization is immediate: install its real bounds before
    // assigning state, otherwise values outside the browser's default 0–100
    // silently clamp on every repaint while the saved program keeps advancing.
    input.value=String(p["value"]??"");input.setAttribute("aria-label",String(p["aria-label"]??p["label"]??p["placeholder"]??(t==="slider"?"Value":t)));
    if(p["required"])input.setAttribute("required","");if(p["disabled"])input.disabled=true;
    if(t==="textarea")n.dataset["scrollRegion"]="";
    action(input,t==="select"?"change":"input",p["onChange"],{number:t==="slider"||p["type"]==="number"});
    if(t==="date-picker"){
      const field=d.createElement("div"),open=d.createElement("button");field.className="cloudig-date-field";field.dataset["dilKey"]=`${key}:field`;
      open.type="button";open.dataset["dilDateOpen"]="";open.disabled=!!p["disabled"];open.setAttribute("aria-label",ctx.language==="en"?"Choose date":"选择日期");open.setAttribute("aria-haspopup","dialog");
      open.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6m10-6v6M3 11h18M7 15h3m4 0h3m-10 3h3"/></svg>';
      field.append(n,open);return field;
    }return n;
  }
  if(["button","pressable","popover-trigger"].includes(t)){
    (n as HTMLButtonElement).type=p["submit"]?"submit":"button";(n as HTMLButtonElement).disabled=!!p["disabled"];
    n.dataset["dilVariant"]=p["variant"]==="outline"||p["variant"]==="ghost"?p["variant"]:p["color"]==="secondary"||t!=="button"?"outline":"solid";
    const semantic=!p["color"]||["primary","secondary","accent"].includes(p["color"]);
    if(semantic)n.style.color="";if(!p["background"]&&semantic)n.dataset["dilDefaultColor"]="true";
    action(n,"click",p["onClick"]);
  }
  if(t==="form")action(n,"submit",p["onSubmit"]);
  if(t==="table-cell")for(const a of ["colSpan","rowSpan"])if(Number.isInteger(p[a]))n.setAttribute(a.toLowerCase(),String(p[a]));
  if(t==="label"&&p["htmlFor"])n.setAttribute("for",String(p["htmlFor"]));
  children();return n;
}

/** Local viewport navigation only; never calls an authored program callback. */
export function bindDilCarousels(parent: HTMLElement, signal: AbortSignal): () => void {
  const update = () => {
    for(const rail of parent.querySelectorAll<HTMLElement>('[data-dil-carousel="scroll"]')){
      const stage=rail.querySelector<HTMLElement>(":scope > .cloudig-dil-carousel-stage");if(!stage)continue;
      for(const button of rail.querySelectorAll<HTMLButtonElement>(":scope > .cloudig-dil-carousel-controls > button"))button.disabled=Number(button.dataset["dilScrollDirection"])<0?stage.scrollLeft<=1:stage.scrollLeft+stage.clientWidth>=stage.scrollWidth-1;
    }
  };
  const click=(event:Event)=>{
    if(signal.aborted||!(event.target instanceof parent.ownerDocument.defaultView!.Element))return;
    const button=event.target.closest<HTMLElement>("[data-dil-scroll-direction]"),stage=button?.closest('[data-dil-carousel="scroll"]')?.querySelector<HTMLElement>(":scope > .cloudig-dil-carousel-stage");
    if(stage){event.preventDefault();stage.scrollBy({left:Number(button!.dataset["dilScrollDirection"])*Math.max(1,stage.clientWidth*.8),behavior:"smooth"});}
  };
  parent.addEventListener("click",click);parent.addEventListener("scroll",update,true);
  const Observer=parent.ownerDocument.defaultView?.ResizeObserver,observer=Observer?new Observer(update):undefined;observer?.observe(parent);
  signal.addEventListener("abort",()=>{parent.removeEventListener("click",click);parent.removeEventListener("scroll",update,true);observer?.disconnect();},{once:true});
  return update;
}

/** Keyed patching keeps focused inputs and running AppBlock iframes alive. */
export function morphDil(old: Node, fresh: Node): void {
  if(old.nodeType!==fresh.nodeType||old.nodeName!==fresh.nodeName){old.parentNode?.replaceChild(fresh.cloneNode(true),old);return;}
  if(old.nodeType===3){if(old.nodeValue!==fresh.nodeValue)old.nodeValue=fresh.nodeValue;return;}
  if(old.nodeType!==1)return;
  const a=old as Element,b=fresh as Element;
  if(a.hasAttribute("data-dil-preserve")&&a.getAttribute("data-dil-preserve")===b.getAttribute("data-dil-preserve"))return;
  for(const attr of [...a.attributes])if(!b.hasAttribute(attr.name))a.removeAttribute(attr.name);
  for(const attr of [...b.attributes])if(a.getAttribute(attr.name)!==attr.value){
    // Only paintDil's allowlisted, renderer-generated styles reach this patch.
    // The shell disallows inline style attributes: setAttribute silently loses
    // live changes there, while the initial CSSOM render succeeds. Keep both
    // paths on CSSOM; never relax CSP or forward arbitrary captured CSS.
    if(attr.name==="style"&&"style"in a)(a as HTMLElement).style.cssText=(b as HTMLElement).style.cssText;
    else a.setAttribute(attr.name,attr.value);
  }
  if(["INPUT","TEXTAREA","SELECT"].includes(a.tagName)){const x=a as HTMLInputElement,y=b as HTMLInputElement;if(x.value!==y.value)x.value=y.value;if("checked"in x)x.checked=y.checked;}
  morphDilChildren(a,b);
}
export function morphDilChildren(old: Element, fresh: Element): void {
  let i=0;
  while(i<fresh.childNodes.length||i<old.childNodes.length){
    const next=fresh.childNodes[i];if(!next){old.childNodes[i]!.remove();continue;}
    const key=next.nodeType===1?(next as Element).getAttribute("data-dil-key"):null;
    if(key){const found=[...old.childNodes].find(n=>n.nodeType===1&&(n as Element).getAttribute("data-dil-key")===key);if(found&&found!==old.childNodes[i])old.insertBefore(found,old.childNodes[i]??null);else if(!found)old.insertBefore(next.cloneNode(true),old.childNodes[i]??null);}
    if(!old.childNodes[i])old.append(next.cloneNode(true));else morphDil(old.childNodes[i]!,next);i++;
  }
}
