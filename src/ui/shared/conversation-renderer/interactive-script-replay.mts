/** Install an inert document using browser-like script phases. In particular,
 * blocking head scripts run before body insertion; defer/modules run after it.
 * Initial DOM observers/style compilers must not see a fabricated fully-parsed
 * body before the author's head configuration has run. */
export async function replayWorkScripts(document:Document, parsed:Document, token:string):Promise<void>{
 const scripts=[...parsed.querySelectorAll("script")].map((script,index)=>{
  const marker=parsed.createElement("template"),id=`${token}-${index}`,head=!!script.closest("head");
  marker.dataset["cloudigWorkScript"]=id;script.replaceWith(marker);
  return{script,id,head,deferred:script.type==="module"||!!script.src&&(script.hasAttribute("defer")||script.hasAttribute("async"))};
 });
 const tree=document.importNode(parsed.documentElement,true),body=tree.querySelector("body")!;body.remove();document.documentElement.replaceWith(tree);
 let attached=false;
 const attach=async()=>{
  if(attached)return;attached=true;document.documentElement.append(body);
  // One event-loop boundary drains initial observers and their style promises
  // before body code measures the newly inserted visual surface.
  await new Promise<void>(resolve=>document.defaultView!.setTimeout(resolve,0));
 };
 for(const {script,id,head,deferred}of [...scripts.filter(item=>!item.deferred),...scripts.filter(item=>item.deferred)]){
  if(!head||deferred)await attach();
  const target=document.querySelector(`[data-cloudig-work-script="${id}"]`);if(!target)continue;
  const live=document.createElement("script");for(const attr of script.attributes)if(!["async","defer"].includes(attr.name))live.setAttribute(attr.name,attr.value);
  live.textContent=script.textContent;live.async=false;
  if(live.src||live.type==="module")await new Promise<void>((resolve,reject)=>{
   const done=`${token}-module-${id}`,window=document.defaultView!;
   const finish=()=>{window.removeEventListener(done,finish);resolve();};
   if(!live.src&&live.type==="module"){window.addEventListener(done,finish,{once:true});live.textContent+=`\n;window.dispatchEvent(new Event(${JSON.stringify(done)}));`;}
   live.onload=finish;live.onerror=()=>{window.removeEventListener(done,finish);reject(new Error("A saved work script could not load"));};target.replaceWith(live);
  });else target.replaceWith(live);
 }
 await attach();
 const committed=document.createComment("work-mounted");document.body.append(committed);committed.remove();
}

/** DOMContentLoaded bubbles to window in a real document. Compilers such as
 * Babel listen there; dispatching a non-bubbling lookalike leaves JSX inert. */
export async function finishWorkDocument(document:Document):Promise<void>{
 const host=document.defaultView!;
 document.dispatchEvent(new host.Event("DOMContentLoaded",{bubbles:true}));
 await document.fonts?.ready;
 host.dispatchEvent(new host.Event("load"));
}
