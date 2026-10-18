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
  const s = String(value ?? "");
  if (["danger", "success", "warning", "info"].includes(s)) {
    const fallback: Record<string,string> = { danger:"#bd4545", success:"#168653", warning:"#bc791b", info:"#428bd2" };
    return `var(--cloudig-dil-${s},${fallback[s]})`;
  }
  const tokens: Record<string,string> = { primary:"var(--cloudig-text)", secondary:"var(--cloudig-muted)", tertiary:"var(--cloudig-muted)", surface:"var(--cloudig-dil-canvas)", "surface-primary":"var(--cloudig-dil-canvas)", "surface-secondary":"var(--cloudig-dil-surface)", "surface-tertiary":"var(--cloudig-dil-surface-strong)", "surface-elevated":"var(--cloudig-dil-elevated)", accent:"var(--cloudig-accent)", discovery:"#924ff7", danger:"#bd4545", success:"#168653", warning:"#bc791b", info:"#428bd2", blue:"#0285ff", purple:"#924ff7", orange:"#fb6a22", green:"#04b84c" };
  return tokens[s] ?? (/^(?:#[a-f\d]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/+-]+\)|transparent|currentColor|white|black)$/iu.test(s) ? s : "");
};
function style(element: HTMLElement, node: DilNode): void {
  const p=node.props,s=element.style,t=node.tag;
  if (["box","col","row","card","form"].includes(t)) { s.display="flex";s.flexDirection=t==="row"?"row":"column"; }
  for (const [key,css] of [["gap","gap"],["padding","padding"],["paddingX","padding-inline"],["paddingY","padding-block"]]) if (typeof p[key!] === "number") s.setProperty(css!,`${Math.max(0,p[key!])*4}px`);
  for (const key of ["width","height","minHeight","maxHeight","minWidth","maxWidth"] as const) if (typeof p[key]==="number"||/^(?:\d+(?:\.\d+)?(?:px|%|rem|em|vh|vw)|auto)$/u.test(String(p[key]))) (s as any)[key]=typeof p[key]==="number"?`${p[key]}px`:p[key];
  if(p["background"]&&dilColor(p["background"])){s.backgroundColor=dilColor(p["background"]);element.dataset["dilSurface"]="explicit";} if(p["color"]&&dilColor(p["color"]))s.color=dilColor(p["color"]);
  if(p["border"]){s.border="1px solid var(--cloudig-border)";element.dataset["dilBorder"]="true";}
  if(p["radius"])s.borderRadius=({full:"999px",sm:"4px",md:"6px",lg:"8px",xl:"12px","2xl":"16px"} as Record<string,string>)[p["radius"]]??"8px";
  if(p["align"])s.alignItems=({start:"flex-start",end:"flex-end"} as Record<string,string>)[p["align"]]??p["align"];
  if(p["justify"])s.justifyContent=({between:"space-between",start:"flex-start",end:"flex-end"} as Record<string,string>)[p["justify"]]??p["justify"];
  if(p["wrap"])s.flexWrap="wrap";if(typeof p["flex"]==="number"||/^\d+(?:\.\d+)?$/u.test(String(p["flex"])))s.flex=String(p["flex"]);
  if(p["weight"])s.fontWeight=String(({medium:500,semibold:600,bold:700} as Record<string,number>)[p["weight"]]??p["weight"]);
  if(p["size"]&&["text","title","label","icon"].includes(t))s.fontSize=`${({"2xs":11,xs:12,sm:14,md:16,lg:20,xl:24,"2xl":30,"3xl":36} as Record<string,number>)[p["size"]]??16}px`;
  if(p["textAlign"]&&["left","right","center","start","end"].includes(p["textAlign"]))s.textAlign=p["textAlign"];
  if(p["preserveWhitespace"])s.whiteSpace="pre-wrap";if(p["tabularNums"])s.fontVariantNumeric="tabular-nums";
  if(p["block"])s.width="100%";
  if(["grid","flow"].includes(t)){s.display="grid";const columns=Math.max(1,Math.min(12,Number(p["columns"]??p["cols"])||2));s.gridTemplateColumns=`repeat(${columns},minmax(0,1fr))`;s.setProperty("--dil-columns",String(columns));}
  if(["grid-item","flow-item"].includes(t)&&Number.isInteger(p["span"]))s.gridColumn=`span ${Math.max(1,Math.min(12,p["span"]))}`;
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
  const n=d.createElement(t==="text"&&p["inline"]?"span":t==="table-cell"&&p["header"]?"th":tags[t]??"div");n.dataset["dilKey"]=key;n.dataset["dilTag"]=t;n.className=`cloudig-dil-node cloudig-dil-${t}`;style(n,v);
  if(t==="table-cell"&&["left","right","center"].includes(p["align"]))n.style.textAlign=p["align"];
  if(t==="table-row"&&p["header"]){n.style.fontWeight="700";n.dataset["dilHeader"]="true";}
  if(t==="checkbox"&&p["checked"]&&p["lineThrough"])n.style.textDecoration="line-through";
  const action=(element:HTMLElement,event:string,fn:unknown,extra:Omit<DilAction,"event"|"fn">={})=>{if(!fn)return;const id=`${key}:${event}:${ctx.actions.size}`;ctx.actions.set(id,{event,fn,...extra});element.dataset["dilAction"]=id;};
  const children=()=>n.append(paintDil(ctx,v.children,key,group));
  if(t==="popover"){
    for(const [i,child]of v.children.entries()){if(child?.tag==="popover-content"&&!p["open"])continue;n.append(paintDil(ctx,child,`${key}.${i}`,group));}return n;
  }
  if(t==="carousel"){
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
