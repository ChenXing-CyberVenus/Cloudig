import { createHash } from 'node:crypto';
import type { AdapterManifest, SourceMessageFacts } from '../../app/parser/adapter.mts';
import type { ExtractedRecord, CapturedSourceTime } from '../../app/parser/record-source.mts';
import type { JsonObject, JsonValue } from '../../core/contracts/types.mts';
import { isJsonObject } from '../../core/contracts/types.mts';
import { projectMarkdownWithDiagrams } from './markdown-diagrams.mts';

export const DEEPSEEK_OFFICIAL_MANIFEST: AdapterManifest = {
  id: 'deepseek-official-json', version: '1.0.0', family: 'deepseek',
  routes: [{ format: 'json-container', platform: 'deepseek', payload: 'deepseek-official-json', profile: 'container' }],
  target: 'cloudig/conversation/1.0.0', update_from: []
};
const text = (v: unknown) => typeof v === 'string' && v.length ? v : undefined;
const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
const list = (v: unknown): JsonValue[] => Array.isArray(v) ? v : [];
const time = (v: unknown) => { const s=text(v); if(!s)return; const date=new Date(s);return Number.isFinite(date.valueOf())?date.toISOString():undefined; };
export const deepSeekOfficialSelector = (id: string): string => createHash('sha256').update('deepseek-official\0'+id).digest('hex');

/** Native export fragments are not bookmarklet payloads. Preserve their exact
 * trees and block order; in particular SEARCH.results has no content string. */
export function extractDeepSeekOfficial(input: Readonly<{
  record: JsonObject; source: Readonly<{ file: string; bytes: number; sha256: string }>; captured?: CapturedSourceTime;
}>): ExtractedRecord {
  const {record}=input, id=text(record['id']);
  if(!id||!isJsonObject(record['mapping']))throw new TypeError('DeepSeek export record needs id and mapping');
  const messages: JsonObject[]=[], facts: SourceMessageFacts[]=[], references: JsonObject[]=[], resources: JsonObject[]=[], limitations: JsonObject[]=[], models=new Set<string>();
  const addReference=(raw: JsonValue):string=>{
    const v=object(raw), ref:JsonObject={id:`s${references.length+1}`,kind:'web'};
    for(const key of ['url','title','snippet','text'])if(typeof v[key]==='string'&&(v[key]!==''||key==='text'||key==='snippet'))ref[key]=v[key]!;
    if(Object.keys(ref).length===2){ref['kind']='other';ref['text']=JSON.stringify(raw);}
    references.push(ref);return String(ref['id']);
  };
  for(const [key, value] of Object.entries(record['mapping'])) {
    if(!isJsonObject(value))throw new TypeError('DeepSeek mapping node must be an object');
    if(value['id']!==undefined&&String(value['id'])!==key)throw new TypeError('DeepSeek mapping key and node id disagree');
    if(value['message']!==null&&!isJsonObject(value['message']))throw new TypeError('DeepSeek message is malformed');
    const raw=object(value['message']), fragments=list(raw['fragments']);
    if(value['message']!==null&&!Array.isArray(raw['fragments']))throw new TypeError('DeepSeek message fragments are missing');
    const role=value['message']===null?'system':fragments.some(f=>object(f)['type']==='REQUEST'||object(f)['type']==='FILE')?'user':'assistant';
    const model=role==='assistant'?text(raw['model']):undefined; if(model)models.add(model);
    const parent=text(value['parent']), timestamp=time(raw['inserted_at']), content:JsonObject[]=[];
    for(const fragment of fragments) {
      if(!isJsonObject(fragment))throw new TypeError('DeepSeek fragment is not an object');
      const kind=text(fragment['type']), body=typeof fragment['content']==='string'?fragment['content']:undefined;
      if((kind==='REQUEST'||kind==='RESPONSE')&&body!==undefined)content.push(...projectMarkdownWithDiagrams(body));
      else if(kind==='THINK'&&body!==undefined)content.push({type:'reasoning',text:body,format:'markdown'});
      else if(kind==='FILE'&&Array.isArray(fragment['files'])) {
        for(const f of fragment['files']) {
          if(!isJsonObject(f))throw new TypeError('DeepSeek file metadata is malformed');
          const resource:JsonObject={id:`r${resources.length+1}`,kind:'file',availability:'metadata_only'};
          if(text(f['file_name']))resource['name']=f['file_name']!;
          if(Number.isSafeInteger(f['file_size'])&&Number(f['file_size'])>=0)resource['bytes']=f['file_size']!;
          resources.push(resource);content.push({type:'attachment',resource:resource['id']!});
        }
      } else if(kind==='SEARCH'||kind==='TOOL_SEARCH') {
        const refs=list(fragment['results']).map(addReference), query=text(fragment['query']);
        content.push({type:'search',...(query?{query}:{}),...(refs.length?{sources:refs}:{})});
      } else if(kind==='TOOL_OPEN') content.push({type:'tool',kind:'activity',name:'web-open',title:'Open page',...(Object.keys(fragment).length>1?{output:Object.fromEntries(Object.entries(fragment).filter(([k])=>k!=='type'))}:{})});
      else if(kind==='TIP'&&body!==undefined)content.push({type:'status',text:body});
      else {
        content.push({type:'unknown',kind:'deepseek-official-fragment',text:JSON.stringify(fragment)});
        limitations.push({code:'official_fragment_unmapped',detail:`DeepSeek fragment ${kind??'(no type)'} retained as data`});
      }
    }
    messages.push({id:key,...(parent?{parent}:{}),role,...(timestamp?{timestamp}:{}),content});
    facts.push({id:key,...(parent?{parent}:{}),role,...(model?{model}:{})});
  }
  const known=new Set(messages.map(m=>m['id']));
  if(facts.some(f=>f.parent&&!known.has(f.parent)))limitations.push({code:'source_parent_omitted',detail:'The native export refers to a parent absent from its mapping; no replacement edge was invented.'});
  const current=text(record['current_node']);
  const created=time(record['inserted_at']), updated=time(record['updated_at']), dates=messages.flatMap(m=>typeof m['timestamp']==='string'?[m['timestamp']]:[]).sort();
  const source:JsonObject={...input.source,format:'json-container',locator:deepSeekOfficialSelector(id),...(created?{conversation_created_at:created}:{}),...(updated?{conversation_updated_at:updated}:{})};
  const draft:JsonObject={platform:'deepseek',source,messages,...(text(record['title'])?{title:record['title']}:{}),...(models.size?{models:[...models]}:{}),...(dates.length?{message_time:{start:dates[0]!,end:dates.at(-1)!}}:{}),...(resources.length?{resources}:{}),...(references.length?{sources:references}:{}),...(limitations.length?{limitations}:{} )};
  return {parsed:{draft,adapter:DEEPSEEK_OFFICIAL_MANIFEST,sourceFingerprint:{bytes:input.source.bytes,sha256:input.source.sha256},systemLogErrors:[]},facts:{messages:facts,...(current&&known.has(current)?{current}:{}),...(input.captured?{captured:input.captured}:{})}};
}
