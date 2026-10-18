import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readStandardWorkIcon, standardWorkIcon } from '../../../src/ui/shared/conversation-renderer/work-icons.mts';
import { clearInteractiveAssets } from '../../../src/ui/shared/conversation-renderer/interactive-assets.mts';
test('only pinned standard icon addresses resolve; no guessing user images or unknown versions',()=>{
 assert.deepEqual(standardWorkIcon('https://cdn.jsdelivr.net/npm/@tabler/icons@3.42.0/icons/outline/cloud.svg'),{file:'icons/tabler-3.42.0.json',key:'outline/cloud.svg'});
 assert(standardWorkIcon('https://unpkg.com/@tabler/icons@3.42.0/icons/filled/star.svg'));
 for(const url of ['https://evil.test/npm/@tabler/icons@3.42.0/icons/outline/cloud.svg','https://cdn.jsdelivr.net/npm/@tabler/icons@999.0.0/icons/outline/cloud.svg','https://cdn.jsdelivr.net/npm/@tabler/icons@3.42.0/icons/outline/cloud.svg?q=x','javascript:alert(1)'])assert.equal(standardWorkIcon(url),undefined);
});
test('external glyph dependencies use only the local catalog, preserve paths and share one bounded read',async()=>{
 const original=globalThis.fetch;let reads=0;clearInteractiveAssets();
 const cloud=await readFile(new URL('../../../node_modules/@tabler/icons/icons/outline/cloud.svg',import.meta.url),'utf8');
 globalThis.fetch=async input=>{assert.equal(String(input),'https://cloudig.local/runtime/dependencies/icons/tabler-3.42.0.json');reads++;return new Response(JSON.stringify({'outline/cloud.svg':cloud,'filled/star.svg':'<svg><path d="M1 2"/></svg>'}));};
 try{const signal=new AbortController().signal,base='https://cloudig.local/runtime/dependencies/';
  const a=await readStandardWorkIcon('https://cdn.jsdelivr.net/npm/@tabler/icons@3.42.0/icons/outline/cloud.svg','assets/icon.svg',base,signal);
  assert.equal(a?.path,'assets/icon.svg');assert.equal(new TextDecoder().decode(a?.bytes),cloud);
  assert(await readStandardWorkIcon('https://unpkg.com/@tabler/icons@3.42.0/icons/filled/star.svg','star.svg',base,signal));
  assert.equal(await readStandardWorkIcon('https://unpkg.com/@tabler/icons@3.42.0/icons/outline/not-real.svg','x.svg',base,signal),undefined);
  assert.equal(reads,1);
 }finally{globalThis.fetch=original;clearInteractiveAssets();}
});
