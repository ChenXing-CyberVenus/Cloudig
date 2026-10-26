import { createMarkdownRenderer } from "./content-runtime.mts";
import type { InteractivePackage } from "./interactive-protocol.mts";
import { workDocuments } from "./work-documents.mts";
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const rows=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.map(object):[];
const markdown=createMarkdownRenderer({localResources:true});
const escape=(value:unknown)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

/** Original Markdown/source stays in files; only this read view resolves native
 * visual placeholders and citations to their owned resources. */
export function savedResearch(input:InteractivePackage,raw:string,document:Document):string|undefined{
 const research=object(input.data?.["research"]);if(research["entry"]!==input.entry)return;
 const doc=new document.defaultView!.DOMParser().parseFromString(`<main>${markdown.render(raw)}</main>`,"text/html"),main=doc.querySelector("main")!;
 const english=input.language==="en",paths=input.files.map(file=>file.path),documents=workDocuments(input.data,paths,english);
 for(const visual of rows(research["visuals"])){
  const choice=documents.find(item=>item.path===visual["path"]);if(!choice)continue;
  const placeholders=[...main.querySelectorAll("p")].filter(node=>node.textContent?.trim()===visual["placeholder"]);
  for(const node of placeholders){
   const figure=doc.createElement("figure"),button=doc.createElement("button"),caption=doc.createElement("figcaption");figure.className="research-visual";
   button.type="button";button.dataset["cloudigDocument"]=choice.path;
   const previews=Array.isArray(visual["previews"])?visual["previews"]:[],preview=previews.find(path=>typeof path==="string"&&paths.includes(path));
   if(typeof preview==="string"){const image=doc.createElement("img");image.src="/"+preview;image.alt=choice.title;button.append(image);}
   const label=doc.createElement("span");label.textContent=english?"Open visualization":"打开可视化";button.append(label);caption.textContent=choice.title;
   figure.append(button,caption);node.replaceWith(figure);
  }
 }
 const sources=rows(research["sources"]).filter(row=>Number.isInteger(Number(row["index"]))&&Number(row["index"])>0);
 const known=new Set(sources.map(row=>String(row["index"]))),walker=doc.createTreeWalker(main,4),texts:Text[]=[];let current:Node|null;
 while((current=walker.nextNode()))if(!current.parentElement?.closest("pre,code,a"))texts.push(current as Text);
 for(const node of texts){
  const value=node.data;let cursor=0;const fragment=doc.createDocumentFragment();
  for(const match of value.matchAll(/\[cite:\s*([\d,\s]+)\]/gu)){
   const ids=match[1]!.split(",").map(v=>v.trim()).filter(Boolean);if(!ids.length||ids.some(id=>!known.has(id)))continue;
   fragment.append(doc.createTextNode(value.slice(cursor,match.index)));const sup=doc.createElement("sup");
   ids.forEach((id,i)=>{if(i)sup.append(", ");const a=doc.createElement("a");a.href=`#research-source-${id}`;a.textContent=id;sup.append(a);});fragment.append(sup);cursor=match.index+match[0].length;
  }
  if(cursor){fragment.append(doc.createTextNode(value.slice(cursor)));node.replaceWith(fragment);}
 }
 if(sources.length){const section=doc.createElement("section");section.className="research-sources";section.innerHTML=`<h2>${english?"Sources":"来源"}</h2><ol>${sources.map(source=>`<li id="research-source-${escape(source["index"])}" value="${Number(source["index"])}"><strong>${escape(source["title"])}</strong><div class="research-url">${escape(source["url"])}</div></li>`).join("")}</ol>`;main.append(section);}
 const process=rows(research["process"]);if(process.length){const details=doc.createElement("details");details.className="research-process";details.innerHTML=`<summary>${english?"Research process":"研究过程"} (${process.length})</summary>`+process.map((step,index)=>{
  const action=Array.isArray(step["action"])?step["action"]:[],label=typeof action[1]==="string"?action[1]:`${english?"Step":"步骤"} ${index+1}`;
  return `<details><summary>${escape(label)}</summary><pre>${escape(JSON.stringify(step,null,2))}</pre></details>`;
 }).join("");main.append(details);}
 const revisions=documents.filter(item=>item.path.startsWith("history/"));if(revisions.length){const details=doc.createElement("details");details.innerHTML=`<summary>${english?"Saved revisions":"保存记录"}</summary>`;for(const revision of revisions){const button=doc.createElement("button");button.type="button";button.dataset["cloudigDocument"]=revision.path;button.textContent=revision.title;details.append(button);}main.append(details);}
 return main.innerHTML;
}
