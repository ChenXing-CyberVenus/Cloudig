import manifest from "../../runtime-dependencies/manifest.json" with {type:"json"};
import { readInteractiveAsset } from "./interactive-assets.mts";
import type { InteractiveFile } from "./interactive-protocol.mts";
const decoded=new WeakMap<ArrayBuffer,Record<string,unknown>>();

/** A pinned standard runtime dependency, not a substitute for user images.
 * Only exact known package/version URLs may resolve locally; saved bytes win. */
export function standardWorkIcon(url:unknown):{file:string;key:string}|undefined {
  if(typeof url!=="string")return;
  let parsed:URL;try{parsed=new URL(url);}catch{return;}
  if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.search||parsed.hash)return;
  const prefix=parsed.hostname==="cdn.jsdelivr.net"?"/npm/":parsed.hostname==="unpkg.com"?"/":undefined;
  if(!prefix)return;
  for(const entry of manifest.icons){
    const start=`${prefix}${entry.package}@${entry.version}/icons/`;
    if(!parsed.pathname.startsWith(start))continue;
    const key=parsed.pathname.slice(start.length);
    if(/^(?:outline|filled)\/[a-z0-9-]+\.svg$/u.test(key))return{file:entry.file,key};
  }
}
export async function readStandardWorkIcon(url:unknown,path:string,base:string,signal:AbortSignal):Promise<InteractiveFile|undefined>{
  const known=standardWorkIcon(url);if(!known)return;
  const local=new URL(known.file,base).href;
  const bytes=await readInteractiveAsset(local,signal,async()=>{
    const response=await fetch(local,{signal});if(!response.ok)throw new Error("Local icon dependency is missing");return response.arrayBuffer();
  });
  let catalog=decoded.get(bytes);if(!catalog){catalog=JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;decoded.set(bytes,catalog);}
  const svg=catalog[known.key];
  if(typeof svg!=="string")return;
  return{path,mime:"image/svg+xml",bytes:new TextEncoder().encode(svg).buffer,aliases:[String(url)]};
}
