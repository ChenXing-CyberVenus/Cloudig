// Lossless packing of named, build-owned CSS and the existing Tree bootstrap
// literal. No captured program is packed/executed and no eval is introduced.
import {parse} from 'acorn';
import {gzipSync} from 'node:zlib';
export function packBookmarkletCss(source){
  const marker='/*__OSIS_PACK_STATIC_CSS__*/';
  if(!source.includes(marker))return {source,values:[]};
  const fixedText=source.includes('/*__OSIS_PACK_FIXED_TEXT__*/');
  const ast=parse(source,{ecmaVersion:'latest'}),serialized=new Set(),literalCounts=new Map();
  // Function source is observable when exported with .toString(): moving its
  // strings into this invocation's closure would break the standalone copy.
  function findSerialized(n){
    if(!n||typeof n!=='object')return;
    if(n.type==='Literal'&&typeof n.value==='string')literalCounts.set(n.value,(literalCounts.get(n.value)||0)+1);
    if(n.type==='MemberExpression'&&(n.property?.name||n.property?.value)==='toString'){
      const object=n.object,name=object?.type==='Identifier'?object.name:object?.type==='MemberExpression'?(object.property?.name||object.property?.value):null;
      if(name)serialized.add(name);
    }
    for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(findSerialized);else if(v&&typeof v==='object')findSerialized(v)}
  }
  if(fixedText)findSerialized(ast);
  const names=new Set(['css','taskCss','sourceCss','mermaidCss','osisArchiveMarkdownCss','osisTemmlCss','branchCss','style','basicStyle','stylePropertyNames']);
  if(fixedText)names.add('activityRuntime');
  if(source.includes('const osisGptLayout =')){names.add('extras');if(fixedText)names.add('scheduledCss')}
  if(source.includes('function osisCreateGeminiRichArchive('))for(const name of ['osisGeminiRichCss','panelCss','mathCss'])names.add(name);
  const edits=[],values=[];
  function add(n,v,quasi=false){
    let index=fixedText?values.indexOf(v):-1;
    if(index<0){index=values.length;values.push(v)}
    edits.push({start:n.start,end:n.end,text:quasi?'${osisPackedCss['+index+']}':`${fixedText?' ':''}osisPackedCss[${index}]`});
  }
  function walk(n,parent,key){
    if(!n||typeof n!=='object')return;
    if(fixedText&&((n.type==='FunctionDeclaration'&&serialized.has(n.id?.name))
      ||(n.type==='VariableDeclarator'&&/FunctionExpression$/.test(n.init?.type||'')&&serialized.has(n.id?.name))
      ||((n.type==='Property'||n.type==='MethodDefinition')&&/FunctionExpression$/.test(n.value?.type||'')&&serialized.has(n.key?.name||n.key?.value))))return;
    if(n.type==='VariableDeclarator'&&(names.has(n.id?.name)||(n.id?.name==='runtime'&&n.init?.type==='TemplateLiteral'&&!n.init.expressions.length&&n.init.quasis[0].value.cooked.startsWith('(function(){const data=JSON.parse(document.getElementById("chatgpt-export-data").textContent);')))){
      const v=n.init?.type==='Literal'?n.init.value:n.init?.type==='TemplateLiteral'&&!n.init.expressions.length?n.init.quasis[0].value.cooked:null;
      if(typeof v==='string'&&v.length>400){add(n.init,v);return}
    }
    // GPT opt-in only: immutable build literals, never captured content or code
    // execution. Exclude syntax positions that require a literal rather than an
    // expression; named bootstrap/CSS initializers above remain one intact value.
    if(fixedText&&n.type==='TemplateLiteral'&&!n.expressions.length&&n.quasis[0].value.cooked?.length>=80&&parent?.type!=='TaggedTemplateExpression'){
      add(n,n.quasis[0].value.cooked);return;
    }
    if(fixedText&&n.type==='TemplateLiteral'&&n.expressions.length&&parent?.type!=='TaggedTemplateExpression'){
      for(const q of n.quasis)if(q.value.cooked?.length>=32)add(q,q.value.cooked,true);
    }
    if(fixedText&&n.type==='Literal'&&typeof n.value==='string'&&(n.value.length>=16||n.value.length>=6&&literalCounts.get(n.value)>=3)&&!/^H4sI/.test(n.value)
      &&!(key==='key'&&!parent.computed)&&!parent?.type?.startsWith('Import')&&!parent?.type?.startsWith('Export')
      &&!(parent?.type==='ExpressionStatement'&&parent.directive)){
      add(n,n.value);return;
    }
    for(const [k,v] of Object.entries(n)){if(['start','end','loc'].includes(k))continue;if(Array.isArray(v))v.forEach(child=>walk(child,n,k));else if(v&&typeof v==='object')walk(v,n,k)}
  }
  walk(ast);
  if(!values.length)throw Error('CSS packing marker has no static styles');
  const bytes=gzipSync(Buffer.from(JSON.stringify(values)),{level:9});bytes.fill(0,4,8);bytes[9]=255;
  for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
  source=source.replace(marker,`const osisPackedCss=JSON.parse(await new Response(new Blob([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).text());`);
  if(fixedText)source=source.replace('/*__OSIS_PACK_FIXED_TEXT__*/','');
  return {source,values};
}
