import { PptxViewer } from "./pptx-runtime.mjs";
import { renderAsync } from "docx-preview";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { unzipSync } from "fflate";
import { INTERACTIVE_LIMITS, type InteractiveFile, type InteractivePackage } from "./interactive-protocol.mts";
import { previewKind } from "./file-preview-policy.mts";
import { savedSpreadsheet } from "./saved-spreadsheet.mts";
import { renderGlb } from "./glb-runtime.mjs";

function packageParts(file: InteractiveFile): Record<string,Uint8Array> {
  let count=0,total=0;
  return unzipSync(new Uint8Array(file.bytes),{filter(entry){
    if(entry.name.endsWith('/'))return false;
    if(++count>INTERACTIVE_LIMITS.officeParts||entry.originalSize>INTERACTIVE_LIMITS.officePartBytes||(total+=entry.originalSize)>INTERACTIVE_LIMITS.officeTotalBytes)throw new RangeError("Office file exceeds the preview budget");
    return true;
  }});
}

/** Runs only in the disposable work origin. No native filesystem/host bridge. */
export async function render(file: InteractiveFile, input: InteractivePackage): Promise<void> {
  const root=document.getElementById("cloudig-file-preview")!,kind=previewKind(file.path,file.mime),en=input.language==="en";
  if (kind === "glb") { await renderGlb(root, file, input); root.dataset["previewReady"] = "true"; return; }
  if(kind!=="pdf")packageParts(file); // Guard the same budget before third-party ZIP readers.
  const toolbar=document.createElement("nav");toolbar.className="office-toolbar";
  const label=document.createElement("span"),previous=document.createElement("button"),next=document.createElement("button");
  previous.textContent=en?"Previous":"上一页";next.textContent=en?"Next":"下一页";
  const host=document.createElement("div");host.className="office-deck";
  toolbar.append(previous,label,next);root.append(toolbar,host);
  if(kind==="pptx") {
    root.classList.add("office-presentation");
    const viewer=await PptxViewer.open(file.bytes,host,{externalMedia:"block",renderMode:"slide",fitMode:"contain",pdfjs:false,lazyMedia:true,lazySlides:true,
      zipLimits:{maxEntries:INTERACTIVE_LIMITS.officeParts,maxEntryUncompressedBytes:INTERACTIVE_LIMITS.officePartBytes,maxTotalUncompressedBytes:INTERACTIVE_LIMITS.officeTotalBytes}});
    const fit=()=>{const available=Math.max(100,window.innerHeight-toolbar.getBoundingClientRect().height-64);host.style.width=`${Math.min(root.clientWidth-40,available*viewer.slideWidth/viewer.slideHeight)}px`;};
    fit();window.addEventListener("resize",fit);
    const update=()=>{label.textContent=`${viewer.currentSlideIndex+1} / ${viewer.slideCount}`;previous.disabled=viewer.currentSlideIndex<=0;next.disabled=viewer.currentSlideIndex>=viewer.slideCount-1;};
    previous.onclick=()=>{void viewer.goToSlide(viewer.currentSlideIndex-1).then(update);};next.onclick=()=>{void viewer.goToSlide(viewer.currentSlideIndex+1).then(update);};update();
    window.addEventListener("pagehide",()=>{viewer.destroy();window.removeEventListener("resize",fit);},{once:true});
  } else if(kind==="docx") {
    toolbar.remove();await renderAsync(file.bytes,host,undefined,{inWrapper:true,className:"office-docx",renderAltChunks:false,useBase64URL:true});
  } else if(kind==="xlsx") {
    toolbar.remove();const parts=packageParts(file),xml:Record<string,string>={};
    for(const [path,bytes] of Object.entries(parts))if(/\.xml(?:\.rels)?$|\.rels$/u.test(path))xml[path]=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    host.innerHTML=savedSpreadsheet(JSON.stringify({source_parts:xml}),document);
  } else if(kind==="pdf") {
    const worker=input.files.find(f=>f.aliases?.includes("cloudig-runtime:pdf-worker"));if(!worker)throw new Error("PDF worker is missing");
    const url=URL.createObjectURL(new Blob([worker.bytes],{type:"text/javascript"}));GlobalWorkerOptions.workerSrc=url;
    const loading=getDocument({data:file.bytes.slice(0),useSystemFonts:true,disableAutoFetch:true});
    const pdf=await loading.promise,canvas=document.createElement("canvas");canvas.className="office-canvas";host.append(canvas);
    let current=1,busy=false;
    const page=async(index:number)=>{if(busy)return;busy=true;previous.disabled=next.disabled=true;
      try{current=Math.max(1,Math.min(pdf.numPages,index));const p=await pdf.getPage(current),natural=p.getViewport({scale:1});
        const viewport=p.getViewport({scale:Math.min(2,window.devicePixelRatio||1)*Math.min(1.5,host.clientWidth/natural.width)});
        canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        await p.render({canvas,canvasContext:canvas.getContext("2d")!,viewport}).promise;label.textContent=`${current} / ${pdf.numPages}`;
      }finally{busy=false;previous.disabled=current<=1;next.disabled=current>=pdf.numPages;}};
    previous.onclick=()=>{void page(current-1);};next.onclick=()=>{void page(current+1);};await page(1);
    window.addEventListener("pagehide",()=>{void loading.destroy();URL.revokeObjectURL(url);},{once:true});
  }
  root.dataset["previewReady"]="true";
}
