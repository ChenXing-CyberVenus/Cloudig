// Opt-in packing of Temml's immutable registration arguments, not executable code.
// Keep each run at its original expression position and preserve registration order.
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parse } from 'acorn';

const supportedSha = 'ea1b1ca203a8bfff4ecb49db949eca7e00dc7bb3ae9e03f36df7186d3ef11161';
export function packTemmlSymbols(source, { packStrings = true } = {}) {
  if (createHash('sha256').update(source).digest('hex') !== supportedSha) throw Error('Unsupported Temml symbol packing input');
  const ast = parse(source, { ecmaVersion: 'latest' });
  const values = new Map(), declarations = new Map(), writes = new Set(), sequences = [];
  function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) value.forEach(child => walk(child, visit));
      else if (value && typeof value === 'object') walk(value, visit);
    }
  }
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      declarations.set(node.id.name, (declarations.get(node.id.name) || 0) + 1);
      if (node.init?.type === 'Literal') values.set(node.id.name, node.init.value);
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') writes.add(node.left.name);
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') writes.add(node.argument.name);
    if (node.type === 'SequenceExpression') sequences.push(node);
  });
  function literal(node) {
    if (node.type === 'Literal') return { value: node.value };
    if (node.type === 'UnaryExpression' && node.operator === '!' && node.argument.type === 'Literal') return { value: !node.argument.value };
    if (node.type === 'Identifier' && declarations.get(node.name) === 1 && values.has(node.name) && !writes.has(node.name)) return { value: values.get(node.name) };
    return null;
  }
  function registration(node) {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'V') return null;
    const args = node.arguments.map(literal);
    if (args.length < 4 || args.some(value => !value) || !['math', 'text'].includes(args[0].value)) return null;
    return args.map(value => value.value);
  }
  const edits = [], tables = [];
  for (const sequence of sequences) {
    let run = [];
    const flush = () => {
      if (run.length >= 8) {
        const index = tables.length;
        tables.push(run.map(entry => entry.args));
        edits.push({ start: run[0].node.start, end: run.at(-1).node.end, text: `osisTemmlSymbolTables[${index}].forEach(args=>V(...args))` });
      }
      run = [];
    };
    for (const node of sequence.expressions) {
      const args = registration(node);
      if (args) run.push({ node, args }); else flush();
    }
    flush();
  }
  if (!tables.length) throw Error('Temml registration runs not found');
  for (const edit of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  // Only fixed vendor string values, never program text or captured content.
  const literals=[],literalIndices=new Map(),literalEdits=[];
  function collect(node,parent,key){if(!node||typeof node!=='object')return;
    if(node.type==='Literal'&&typeof node.value==='string'&&node.value.length>=10&&/^[\x00-\x7f]*$/.test(node.value)&&!(key==='key'&&!parent.computed)){
      let index=literalIndices.get(node.value);if(index===undefined){index=literals.length;literalIndices.set(node.value,index);literals.push(node.value)}
      literalEdits.push({start:node.start,end:node.end,text:` osisTemmlLiterals[${index}]`});
    }
    for(const[k,v]of Object.entries(node)){if(k==='start'||k==='end')continue;if(Array.isArray(v))v.forEach(n=>collect(n,node,k));else if(v&&typeof v==='object')collect(v,node,k)}
  }
  if(packStrings)collect(parse(source,{ecmaVersion:'latest'}));
  for(const edit of literalEdits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  const json = JSON.stringify([tables,literals]), gzip = gzipSync(Buffer.from(json), { level: 9 });
  if (gunzipSync(gzip).toString('utf8') !== json) throw Error('Temml symbols did not round-trip');
  gzip.fill(0, 4, 8); gzip[9] = 255;
  const prelude = `const [osisTemmlSymbolTables,osisTemmlLiterals]=JSON.parse(await new Response(new Blob([Uint8Array.from(atob(${JSON.stringify(gzip.toString('base64'))}),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).text());\n`;
  return { source, prelude, tables, literals, registrations: tables.reduce((sum, rows) => sum+rows.length,0) };
}
