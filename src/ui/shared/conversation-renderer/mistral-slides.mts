import createDOMPurify from "dompurify";
import type { InteractivePackage } from "./interactive-protocol.mts";
import type { SavedSlide } from "./native-slides.mts";
import { isJsonObject } from "../../../core/contracts/types.mts";

export function savedMistralSlides(input: InteractivePackage, document: Document): { slides: SavedSlide[]; css: string } {
  const read=(name:unknown)=>{const file=input.files.find(f=>f.path===name);if(!file)throw new TypeError("Saved Mistral presentation file is missing");return new TextDecoder("utf-8",{fatal:true}).decode(file.bytes);};
  const deck=JSON.parse(read(input.data?.["rendered_file"]??input.entry));
  if(!Array.isArray(deck.html)||!deck.html.length||typeof deck.css!=="string")throw new TypeError("Invalid saved Mistral presentation");
  const purifier=createDOMPurify(document.defaultView!), parser=new document.defaultView!.DOMParser();
  const aliases=isJsonObject(input.data?.["aliases"])?input.data["aliases"]:{};
  const slides=deck.html.map((body:unknown,i:number)=>{
    if(typeof body!=="string")throw new TypeError("Invalid saved Mistral slide");
    const html=purifier.sanitize(body,{ADD_TAGS:["foreignobject"],HTML_INTEGRATION_POINTS:{foreignobject:true}});
    const parsed=parser.parseFromString(html,"text/html"),svg=parsed.querySelector("svg[data-marpit-svg]"),viewbox=svg?.getAttribute("viewBox")?.trim().split(/\s+/u).map(Number);
    for(const node of parsed.querySelectorAll("[src],[href],[xlink\\:href]"))for(const attr of ["src","href","xlink:href"]){const url=node.getAttribute(attr);if(url&&typeof aliases[url]==="string")node.setAttribute(attr,`/${aliases[url]}`);}
    if(!svg||!viewbox||viewbox.length!==4||!viewbox.every(Number.isFinite)||viewbox[2]!<=0||viewbox[3]!<=0)throw new TypeError("Saved slide has no valid viewport");
    return {name:String(i+1),width:viewbox[2]!,height:viewbox[3]!,notes:Array.isArray(deck.comments?.[i])?deck.comments[i].join("\n"):"",body:`<div class="osis-mistral-slides">${parsed.body.innerHTML}</div>`};
  });
  // The captured ./default.css import was already applied by this exact engine.
  const overlay=read(input.data?.["theme_css"]).replace(/@import\s+(?:url\(\s*)?["']\.\/default\.css["']\s*\)?\s*;/giu,"");
  const rawCss=[read(input.data?.["page_css"]),deck.css,overlay].join("\n");
  const css=rawCss.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gu,(full:string,_q:string,url:string)=>typeof aliases[url]==="string"?`url(${JSON.stringify('/'+aliases[url])})`:full);
  return {slides,css};
}
