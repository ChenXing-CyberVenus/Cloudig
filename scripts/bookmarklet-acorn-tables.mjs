// Opt-in lossless packing of Acorn's literal Unicode/keyword tables only.
// The parser program and its evaluation order are unchanged; no eval/loader.
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {parse} from 'acorn';
export function packAcornTables(source,{sharePropertyKeys=false}={}){
  if(createHash('sha256').update(source).digest('hex')!=='331335e0c261753e7f12cd7dcc7a0d50c82ff4d0c3ba6ca3ac27395a087399a9')throw Error('Unsupported Acorn table input');
  const edits=[],values=[],indices=new Map(),members=new Map();
  const add=(n,value)=>{const key=JSON.stringify(value);let index=indices.get(key);if(index===undefined){index=values.length;indices.set(key,index);values.push(value)}edits.push({start:n.start,end:n.end,text:` osisAcornTables[${index}]`})};
  function walk(n,parent,key){if(!n||typeof n!=='object')return;
    if(sharePropertyKeys && n.type==='MemberExpression' && !n.computed && !n.optional && n.property.type==='Identifier'){
      const name=n.property.name, start=n.property.start-1;
      if(source.slice(start,n.property.end)==='.'+name){if(!members.has(name))members.set(name,[]);members.get(name).push({start,end:n.property.end})}
    }
    if(n.type==='VariableDeclarator'){
      const v=n.init,isString=v?.type==='Literal'&&typeof v.value==='string'&&v.value.length>500&&gzipSync(Buffer.from(JSON.stringify(v.value)),{level:9}).toString('base64').length<JSON.stringify(v.value).length;
      const isArray=v?.type==='ArrayExpression'&&v.elements.length>80&&v.elements.every(x=>x?.type==='Literal'&&Number.isSafeInteger(x.value));
      if(isString||isArray){add(v,isString?v.value:v.elements.map(x=>x.value));return}
    }
    if(n.type==='Literal'&&typeof n.value==='string'&&n.value.length>=8&&/^[\x00-\x7f]*$/.test(n.value)&&!(key==='key'&&!parent.computed)){add(n,n.value);return}
    for(const [k,v]of Object.entries(n)){if(k==='start'||k==='end')continue;if(Array.isArray(v))v.forEach(x=>walk(x,n,k));else if(v&&typeof v==='object')walk(v,n,k)}
  }walk(parse(source,{ecmaVersion:'latest'}));
  if(values.length<5)throw Error('Acorn literal tables missing');
  // Only transform dot accesses in this SHA-pinned vendor. obj.method(...)
  // and obj[key](...) have the same receiver and key; no property is renamed.
  // The decoder is an existing JSON table, not a script loader. Member access
  // spans do not overlap and are checked against the exact source spelling.
  const keys=[...members].filter(([name,uses])=>(name.length-3)*uses.length-name.length-7>10);
  const keyIndex=values.length;
  if(keys.length)values.push(keys.map(([name])=>name));
  for(let i=0;i<keys.length;i++)for(const span of keys[i][1])edits.push({...span,text:'[osisAcornKey'+i+']'});
  const json=JSON.stringify(values),bytes=gzipSync(Buffer.from(json),{level:9});
  if(gunzipSync(bytes).toString()!==json)throw Error('Acorn table round-trip failed');
  bytes.fill(0,4,8);bytes[9]=255;
  for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  const prelude=`const osisAcornTables=JSON.parse(await new Response(new Blob([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).text());\n`;
  const aliases=keys.length?'const ['+keys.map((_,i)=>'osisAcornKey'+i).join(',')+']=osisAcornTables['+keyIndex+'];\n':'';
  return {source:prelude+aliases+source,values};
}
