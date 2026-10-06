import { open, lstat } from 'node:fs/promises';
import { streamTopLevelJsonObjectRanges } from './json-envelope-ranges.mts';
import { streamTopLevelJsonArrayRanges, parseJsonRange, type JsonArrayRange } from './json-array-stream.mts';
import { isJsonObject } from '../../core/contracts/types.mts';
import type { JsonObject } from '../../core/contracts/types.mts';

export type OfficialJsonPlatform = 'claude'|'deepseek'|'grok'|'qwen'|'mistral'|'chatgpt';
export type OfficialJsonLayout = Readonly<{
  platform: OfficialJsonPlatform;
  mode: 'conversations'|'message-array';
  range: Readonly<{offset:number;length:number}>;
}>;
export const OFFICIAL_JSON_LIMITS = Object.freeze({ readChunkBytes: 512 * 1024, headerBytes: 4096 });

async function firstByte(file: string, offset: number, length: number): Promise<{byte:number;offset:number}> {
  const handle=await open(file,'r'), buffer=Buffer.alloc(Math.min(OFFICIAL_JSON_LIMITS.headerBytes,length));
  let position=offset;
  try {
    while(position<offset+length) {
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,offset+length-position),position);
      if(!bytesRead)break;
      for(let i=0;i<bytesRead;i++) {
        const at=position+i,b=buffer[i]!;
        if(at<3&&offset===0&&b===[0xef,0xbb,0xbf][at])continue;
        if(![9,10,13,32].includes(b))return {byte:b,offset:at};
      }
      position+=bytesRead;
    }
    throw new SyntaxError('JSON source is empty');
  } finally {await handle.close();}
}

/** ZIP layout already identifies the platform. Validate its array envelope
 * here; the indexing pass validates every record, without parsing the first
 * (potentially huge) conversation twice just to identify it again. */
export async function officialJsonArrayFileRange(file: string, signal?: AbortSignal): Promise<{offset:number;length:number}> {
  signal?.throwIfAborted();
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new TypeError('Official JSON must be an ordinary file');
  const first = await firstByte(file, 0, info.size);
  if (first.byte !== 91) throw new TypeError('Expected a conversation JSON array');
  return {offset:first.offset,length:info.size-first.offset};
}

export async function* officialJsonArrayRanges(file: string, range: Readonly<{offset:number;length:number}>, options: Readonly<{
  signal?:AbortSignal;onProgress?:(completed:number)=>void;
}>={}):AsyncGenerator<JsonArrayRange> {
  if(!Number.isSafeInteger(range.offset)||range.offset<0||!Number.isSafeInteger(range.length)||range.length<1)throw new TypeError('Invalid official JSON range');
  const handle=await open(file,'r');
  try {
    const stream=handle.createReadStream({start:range.offset,end:range.offset+range.length-1,autoClose:false,highWaterMark:OFFICIAL_JSON_LIMITS.readChunkBytes});
    try {
      for await(const item of streamTopLevelJsonArrayRanges(stream,{...(options.signal?{signal:options.signal}:{}),onProgress:bytes=>options.onProgress?.(bytes)}))yield {...item,offset:item.offset+range.offset};
    } finally {stream.destroy();}
  } finally {await handle.close();}
}

function identify(record:unknown, wrapper?:string):OfficialJsonPlatform|undefined {
  if(!isJsonObject(record))return;
  if(wrapper==='conversations'&&isJsonObject(record['conversation'])&&typeof record['conversation']['id']==='string'&&Array.isArray(record['responses']))return 'grok';
  if(wrapper==='data'&&typeof record['id']==='string'&&isJsonObject(record['chat'])&&isJsonObject(record['chat']['history']))return 'qwen';
  if(wrapper)return;
  if(typeof record['uuid']==='string'&&Array.isArray(record['chat_messages']))return 'claude';
  if(typeof record['conversation_id']==='string'&&Object.hasOwn(record,'current_node')&&(record['mapping']===null||isJsonObject(record['mapping'])))return 'chatgpt';
  if(typeof record['id']==='string'&&isJsonObject(record['mapping'])&&Object.values(record['mapping']).every(v=>isJsonObject(v)&&(v['message']===null||isJsonObject(v['message'])&&Array.isArray(v['message']['fragments']))))return 'deepseek';
  if(typeof record['chatId']==='string'&&typeof record['id']==='string'&&typeof record['role']==='string'&&Object.hasOwn(record,'content'))return 'mistral';
}

/** Read just an envelope and one record to route. Full index/extraction must
 * validate every selected record later; a file extension is not platform proof. */
export async function inspectOfficialJson(file:string,options:Readonly<{signal?:AbortSignal;emptyPlatform?:OfficialJsonPlatform}>={}):Promise<OfficialJsonLayout> {
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new TypeError('Official JSON must be an ordinary file');
  options.signal?.throwIfAborted();const root=await firstByte(file,0,info.size);
  const candidate=async(range:{offset:number;length:number},wrapper?:string):Promise<OfficialJsonLayout|undefined>=>{
    if((await firstByte(file,range.offset,range.length)).byte!==91)return;
    for await(const first of officialJsonArrayRanges(file,range,options)) {
      const parsed=await parseJsonRange(file,first,options.signal?{signal:options.signal}:{});
      // The manifest identifies a ChatGPT shard; {} is an export placeholder,
      // not an anonymous conversation or evidence for a different platform.
      if(options.emptyPlatform==='chatgpt'&&isJsonObject(parsed.value)&&Object.keys(parsed.value).length===0)continue;
      const platform=identify(parsed.value,wrapper);
      return platform?{platform,mode:platform==='mistral'?'message-array':'conversations',range}:undefined;
    }
    // An empty array contains no platform evidence: only a caller's explicit
    // platform choice can identify it, never the source filename.
    return !wrapper&&options.emptyPlatform?{platform:options.emptyPlatform,mode:options.emptyPlatform==='mistral'?'message-array':'conversations',range}:undefined;
  };
  if(root.byte===91) {
    const found=await candidate({offset:root.offset,length:info.size-root.offset});if(found)return found;
  } else if(root.byte===123) {
    const handle=await open(file,'r');let found:OfficialJsonLayout|undefined;
    try {
      const stream=handle.createReadStream({autoClose:false,highWaterMark:OFFICIAL_JSON_LIMITS.readChunkBytes});
      try {
        for await(const field of streamTopLevelJsonObjectRanges(stream,options.signal?{signal:options.signal}:{})) {
          if(field.key!=='conversations'&&field.key!=='data')continue;
          const next=await candidate(field,field.key);
          if(next) {if(found)throw new TypeError('Ambiguous official JSON export envelope');found=next;}
        }
      } finally {stream.destroy();}
    } finally {await handle.close();}
    if(found)return found;
  }
  throw new TypeError('Unsupported official platform JSON structure');
}

export function assertOfficialRecord(platform:OfficialJsonPlatform,record:unknown):asserts record is JsonObject {
  if(identify(record,platform==='grok'?'conversations':platform==='qwen'?'data':undefined)!==platform)throw new TypeError(`Record does not match the selected ${platform} export format`);
}
