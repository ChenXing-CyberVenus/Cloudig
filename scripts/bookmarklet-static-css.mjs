// Lossless packing of named, build-owned CSS literals. No captured code or eval.
import {parse} from 'acorn';
import {gzipSync} from 'node:zlib';
export function packBookmarkletCss(source){
  const marker='/*__OSIS_PACK_STATIC_CSS__*/';
  if(!source.includes(marker))return {source,values:[]};
  const names=new Set(['css','taskCss','sourceCss','mermaidCss','osisArchiveMarkdownCss','osisTemmlCss','branchCss']);
  const edits=[],values=[];
  function walk(n){
    if(!n||typeof n!=='object')return;
    if(n.type==='VariableDeclarator'&&names.has(n.id?.name)){
      const v=n.init?.type==='Literal'?n.init.value:n.init?.type==='TemplateLiteral'&&!n.init.expressions.length?n.init.quasis[0].value.cooked:null;
      if(typeof v==='string'&&v.length>400){edits.push({start:n.init.start,end:n.init.end,text:`osisPackedCss[${values.length}]`});values.push(v)}
    }
    for(const [k,v] of Object.entries(n)){if(['start','end','loc'].includes(k))continue;if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v)}
  }
  walk(parse(source,{ecmaVersion:'latest'}));
  if(!values.length)throw Error('CSS packing marker has no static styles');
  const bytes=gzipSync(Buffer.from(JSON.stringify(values)),{level:9});bytes.fill(0,4,8);bytes[9]=255;
  for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
  source=source.replace(marker,`const osisPackedCss=JSON.parse(await new Response(new Blob([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).text());`);
  return {source,values};
}
