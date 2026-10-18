/** Themeable calendar for the declarative date control. Keep its native date
 * input (validation, form value and keyboard segments); only replace the
 * browser-owned popup, whose colours cannot follow the Reader palette. */
export function bindDilDatePicker(root: HTMLElement, language: "zh" | "en", signal: AbortSignal): () => void {
  const d=root.ownerDocument,w=d.defaultView!,en=language==="en";
  let panel: HTMLElement|undefined, input: HTMLInputElement|undefined, trigger: HTMLButtonElement|undefined;
  let shown=new Date(), focusDay="";
  const iso=(date:Date)=>`${String(date.getFullYear()).padStart(4,"0")}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const parse=(s:string)=>{if(!/^\d{4,}-\d\d-\d\d$/u.test(s))return undefined;const [y,m,day]=s.split("-").map(Number);const date=new Date(0);date.setFullYear(y!,m!-1,day!);date.setHours(12,0,0,0);return iso(date)===s?date:undefined;};
  const dateAt=(y:number,m:number,day:number)=>{const date=new Date(0);date.setFullYear(y,m,day);date.setHours(12,0,0,0);return date;};
  const allowed=(value:string)=>{
    if(!input)return false;
    // Use the same browser constraints as keyboard input, including step.
    const probe=d.createElement("input");probe.type="date";
    for(const name of ["min","max","step"])if(input.hasAttribute(name))probe.setAttribute(name,input.getAttribute(name)!);
    probe.value=value;return !!probe.value&&probe.validity.valid;
  };
  const close=(restore=false)=>{
    const button=trigger,old=panel;panel=undefined;input=undefined;trigger=undefined;
    observer.disconnect();d.removeEventListener("pointerdown",outside,true);w.removeEventListener("resize",position);d.removeEventListener("scroll",position,true);
    button?.setAttribute("aria-expanded","false");old?.remove();
    if(restore&&button?.isConnected)button.focus({preventScroll:true});
  };
  const position=()=>{
    if(!panel||!input?.isConnected){close();return;}
    const r=input.getBoundingClientRect(),p=panel.getBoundingClientRect(),gap=8;
    panel.style.left=`${Math.max(gap,Math.min(r.left,w.innerWidth-p.width-gap))}px`;
    panel.style.top=`${Math.max(gap,Math.min(r.bottom+6,w.innerHeight-p.height-gap))}px`;
    if(r.bottom+6+p.height>w.innerHeight-gap&&r.top-p.height-6>=gap)panel.style.top=`${r.top-p.height-6}px`;
  };
  const commit=(value:string)=>{
    if(!input||input.disabled||input.readOnly||value&&!allowed(value))return;
    const target=input;close(true);target.value=value;
    target.dispatchEvent(new w.Event("input",{bubbles:true}));
    target.dispatchEvent(new w.Event("change",{bubbles:true}));
  };
  const render=(moveFocus=false)=>{
    if(!panel||!input)return;
    panel.replaceChildren();const year=shown.getFullYear(),month=shown.getMonth();
    const button=(text:string,label:string,run:()=>void)=>{const b=d.createElement("button");b.type="button";b.textContent=text;b.setAttribute("aria-label",label);b.addEventListener("click",run);return b;};
    const header=d.createElement("header");header.className="cloudig-date-heading";
    const changeMonth=(delta:number)=>{const next=dateAt(year,month+delta,1);if(next.getFullYear()<1||next.getFullYear()>275760)return;shown=next;focusDay=iso(shown);render(true);};
    const previous=button("‹",en?"Previous month":"上个月",()=>changeMonth(-1)),next=button("›",en?"Next month":"下个月",()=>changeMonth(1));
    const monthSelect=d.createElement("select");monthSelect.className="cloudig-themed-select";monthSelect.dataset["scrollPicker"]="";monthSelect.setAttribute("aria-label",en?"Month":"月");
    for(let m=0;m<12;m++){const option=d.createElement("option");option.value=String(m);option.textContent=new Intl.DateTimeFormat(en?"en":"zh-CN",{month:"long"}).format(dateAt(2024,m,1));monthSelect.append(option);}monthSelect.value=String(month);
    monthSelect.addEventListener("change",()=>{shown=dateAt(year,Number(monthSelect.value),1);focusDay=iso(shown);render(true);});
    const yearInput=d.createElement("input");yearInput.type="number";yearInput.min="1";yearInput.max="275760";yearInput.value=String(year);yearInput.setAttribute("aria-label",en?"Year":"年");
    yearInput.addEventListener("change",()=>{const y=Number(yearInput.value);if(Number.isInteger(y)&&y>=1&&y<=275760){shown=dateAt(y,month,1);focusDay=iso(shown);render(true);}else yearInput.value=String(year);});
    header.append(previous,monthSelect,yearInput,next);panel.append(header);
    const grid=d.createElement("div");grid.className="cloudig-date-grid";grid.setAttribute("role","group");grid.setAttribute("aria-label",`${year}-${String(month+1).padStart(2,"0")}`);
    for(const name of en?["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]:["日","一","二","三","四","五","六"]){const day=d.createElement("span");day.textContent=name;day.className="cloudig-date-weekday";grid.append(day);}
    const first=dateAt(year,month,1),last=dateAt(year,month+1,0).getDate();
    for(let n=0;n<first.getDay();n++){const space=d.createElement("span");space.setAttribute("aria-hidden","true");grid.append(space);}
    for(let day=1;day<=last;day++){
      const value=iso(dateAt(year,month,day));const b=button(String(day),value,()=>commit(value));b.dataset["dateValue"]=value;b.disabled=!allowed(value);b.setAttribute("aria-pressed",String(value===input.value));
      if(value===iso(new Date()))b.setAttribute("aria-current","date");grid.append(b);
    }
    panel.append(grid);const footer=d.createElement("footer");footer.className="cloudig-date-footer";
    const today=iso(new Date()),now=button(en?"Today":"今天",en?"Today":"今天",()=>commit(today));now.disabled=!allowed(today);
    footer.append(button(en?"Clear":"清空",en?"Clear date":"清空日期",()=>commit("")),now,button(en?"Close":"关闭",en?"Close calendar":"关闭日历",()=>close(true)));panel.append(footer);
    if(moveFocus){const selected=[...grid.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].find(b=>b.dataset["dateValue"]===focusDay)??grid.querySelector<HTMLButtonElement>("button:not(:disabled)");(selected??previous).focus({preventScroll:true});}
    position();
  };
  const open=(field:HTMLElement)=>{
    const target=field.querySelector<HTMLInputElement>('input[type="date"]'),button=field.querySelector<HTMLButtonElement>("[data-dil-date-open]");
    if(!target||!button||target.disabled||target.readOnly)return;
    if(input===target){close(true);return;}close();input=target;trigger=button;
    shown=parse(target.value)??parse(target.min)??new Date();focusDay=iso(shown);
    panel=d.createElement("section");panel.className="cloudig-date-picker";panel.setAttribute("popover","auto");panel.setAttribute("role","dialog");panel.setAttribute("aria-label",en?"Choose date":"选择日期");panel.dataset["scrollRegion"]="";
    panel.id=`${root.dataset["dilView"]??"view"}-date-${Math.random().toString(36).slice(2)}`;button.setAttribute("aria-controls",panel.id);button.setAttribute("aria-expanded","true");
    // Stay inside an active dialog for focus/inert semantics, but outside the
    // keyed DIL subtree so sibling state updates do not destroy the popup.
    const owner=root.closest(".cloudig-conversation-renderer")??d.body;owner.append(panel);
    panel.addEventListener("toggle",e=>{if((e as ToggleEvent).newState==="closed"&&panel===e.target)close();});
    panel.addEventListener("keydown",e=>{
      if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close(true);return;}
      const selected=(e.target as HTMLElement).dataset["dateValue"],day=selected?parse(selected):undefined;if(!day)return;
      const delta=({ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7} as Record<string,number>)[e.key];
      if(delta!==undefined){e.preventDefault();day.setDate(day.getDate()+delta);if(day.getFullYear()<1)return;shown=day;focusDay=iso(day);render(true);}
    });
    render();panel.showPopover?.();render(true);
    observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:["disabled","readonly"]});
    d.addEventListener("pointerdown",outside,true);w.addEventListener("resize",position);d.addEventListener("scroll",position,true);
  };
  const click=(e:Event)=>{const el=e.target as Element,button=el.closest<HTMLElement>("[data-dil-date-open]");if(button&&root.contains(button)){e.preventDefault();open(button.parentElement!);}};
  const key=(e:KeyboardEvent)=>{if(e.altKey&&e.key==="ArrowDown"&&(e.target as HTMLElement).matches('input[data-dil-tag="date-picker"]')){e.preventDefault();open((e.target as HTMLElement).parentElement!);}};
  const outside=(e:Event)=>{if(panel&&!panel.contains(e.target as Node)&&!trigger?.parentElement?.contains(e.target as Node))close();};
  const changed=()=>{if(input&&(!input.isConnected||input.disabled||input.readOnly))close();};
  const observer=new w.MutationObserver(changed);
  root.addEventListener("click",click);root.addEventListener("keydown",key);
  const destroy=()=>{close();observer.disconnect();root.removeEventListener("click",click);root.removeEventListener("keydown",key);d.removeEventListener("pointerdown",outside,true);w.removeEventListener("resize",position);d.removeEventListener("scroll",position,true);};
  signal.addEventListener("abort",destroy,{once:true});if(signal.aborted)destroy();return destroy;
}
