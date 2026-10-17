import type { JsonObject } from "../../../core/contracts/types.mts";
import type { DilViewOptions } from "./dil-view.mts";

const objects=(v:unknown):JsonObject[]=>Array.isArray(v)?v.filter(x=>x&&typeof x==="object"&&!Array.isArray(x)):[];
const text=(v:unknown)=>v==null?"—":String(v);
const literalColor=(v:string|null)=>v&&/^(?:#[a-f\d]{3,8}|rgba?\([\d\s.,%/]+\))$/iu.test(v)?v:undefined;

/** A captured SVG is the plot, not the complete chart: HTML legends are
 * siblings of it. Keep the plot bytes and expose its saved data/legend here. */
export function savedDilChart(ctx:DilViewOptions,snapshot:string,data:JsonObject):HTMLElement {
 const {document}=ctx,spec=(data["content"]??{}) as JsonObject,rows=objects(spec["data"]),formatted=objects(spec["formattedData"]),series=objects(spec["series"]);
 const pie=spec["chartType"]==="pie",nameKey=String(spec["nameKey"]??spec["xKey"]??"name"),valueKey=String(spec["valueKey"]??series[0]?.["dataKey"]??"value");
 const root=document.createElement("div"),plot=document.createElement("div"),legend=document.createElement("ul");
 root.className="cloudig-dil-chart-evidence";plot.className="cloudig-dil-chart-original";plot.dataset["chartType"]=String(spec["chartType"]??"");legend.className="cloudig-dil-chart-legend";
 plot.append(ctx.image(snapshot,String(data["title"]??(ctx.language==="en"?"Chart":"图表"))));root.append(plot);
 const entries=pie?rows.map((r,i)=>({label:`${text(r[nameKey])}: ${text(formatted[i]?.[valueKey]??r[valueKey])}`,name:text(r[nameKey]),key:valueKey,index:i,color:literalColor(typeof r["color"]==="string"?r["color"]:typeof r["fill"]==="string"?r["fill"]:null)}))
  :series.map((s,i)=>({label:text(s["label"]??s["dataKey"]),name:"",key:String(s["dataKey"]??""),index:i,color:literalColor(typeof s["color"]==="string"?s["color"]:null)}));
 const swatches=entries.map(entry=>{const item=document.createElement("li"),swatch=document.createElement("i"),label=document.createElement("span");swatch.className="cloudig-dil-chart-key";swatch.setAttribute("aria-hidden","true");swatch.hidden=!entry.color;if(entry.color)swatch.style.backgroundColor=entry.color;label.textContent=entry.label;item.append(swatch,label);legend.append(item);return swatch;});
 if(entries.length)root.append(legend);
 // Data stays readable without opening a raw JSON source dump. Columns and
 // formatted values come only from the source; zeros and duplicate names stay.
 if(rows.length){
  const details=document.createElement("details"),summary=document.createElement("summary"),scroll=document.createElement("div"),table=document.createElement("table"),head=document.createElement("tr"),body=document.createElement("tbody");
  summary.textContent=ctx.language==="en"?"Data":"数据";scroll.className="cloudig-dil-chart-data";scroll.dataset["scrollRegion"]="";
  const columns=[{key:nameKey,label:ctx.language==="en"?"Category":"类别"},...(pie?[{key:valueKey,label:text(series[0]?.["label"]??valueKey)}]:series.map(s=>({key:String(s["dataKey"]??""),label:text(s["label"]??s["dataKey"])})))];
  for(const c of columns){const cell=document.createElement("th");cell.textContent=c.label;cell.scope="col";head.append(cell);}const thead=document.createElement("thead");thead.append(head);table.append(thead,body);
  rows.forEach((row,i)=>{const tr=document.createElement("tr");for(const c of columns){const td=document.createElement("td");td.textContent=text(formatted[i]?.[c.key]??row[c.key]);tr.append(td);}body.append(tr);});
  scroll.append(table);details.append(summary,scroll);root.append(details);
 }
 // Recover paint from the already-declared inert SVG. Never execute it or
 // guess a palette by global path order. Match the chart's own item identity.
 void ctx.readFile(snapshot,ctx.signal).then(file=>{
  if(!file||ctx.signal.aborted||!file.mime.includes("svg"))return;
  const svg=new document.defaultView!.DOMParser().parseFromString(new TextDecoder().decode(file.bytes),"image/svg+xml");
  if(svg.querySelector("parsererror"))return;
  // Charts beside each other share the captured plot height, even when their
  // SVG widths differ (e.g. a pie and a Cartesian plot). Fit each image inside
  // that viewport, rather than deriving unequal heights from stretched widths.
  const graphic=svg.documentElement,rawHeight=graphic.getAttribute("height")??"",viewBox=graphic.getAttribute("viewBox")?.trim().split(/[\s,]+/u).map(Number);
  const height=/^\d+(?:\.\d+)?(?:px)?$/u.test(rawHeight)?parseFloat(rawHeight):viewBox?.length===4?viewBox[3]:undefined;
  if(height!==undefined&&Number.isFinite(height)&&height>0)plot.style.setProperty("--cloudig-dil-plot-height",`${height}px`);
  const shapes=[...svg.querySelectorAll('[data-recharts-item-data-key]')];
  entries.forEach((entry,i)=>{
   const matches=shapes.filter(n=>n.getAttribute("data-recharts-item-data-key")===entry.key&&(!pie||n.getAttribute("data-recharts-item-index")===String(entry.index)&&n.getAttribute("name")===entry.name));
   const colors=[...new Set(matches.map(n=>literalColor(n.getAttribute("fill"))).filter((v):v is string=>!!v))];
   if(colors.length!==1)return;swatches[i]!.style.backgroundColor=colors[0]!;swatches[i]!.hidden=false;
  });
 }).catch(()=>{/* The plot/data still remain useful if optional colour evidence is unavailable. */});
 return root;
}
