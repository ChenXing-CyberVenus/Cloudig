import assert from 'node:assert/strict';
import { cp,mkdir,readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startRecordEngine } from './record-engine-client.mjs';

// The same fixed package, in a complete owned portable folder. Preview/cancel only.
const output=path.resolve(process.argv[2]);
assert(output.startsWith(path.resolve('artifacts/v1-visual-audit')+path.sep));
await mkdir(output);const source=path.join(output,'Cloudig'),target=path.join(output,'New location');await mkdir(source);await mkdir(target);
for(const name of ['Cloudig.exe','app','docs','bookmarks','LICENSE'])await cp(path.resolve('artifacts/v1-desktop/app',name),path.join(source,name),{recursive:true,errorOnExist:true,force:false});
const engine=startRecordEngine({packageRoot:source,libraryRoot:source});try{await engine.request('library.create');}finally{await engine.close();}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');const exe=path.join(source,'Cloudig.exe');
assert.equal(sha(await readFile(exe)),sha(await readFile('artifacts/v1-desktop/app/Cloudig.exe')));
for(const language of ['zh-CN','en'])for(const theme of ['dawn','star-night']){
  const directory=path.join(output,`${language}-${theme}`);await mkdir(directory);
  const file=path.join(directory,'move.png');const query=new URLSearchParams({screenshot:'1',fixture:'real',route:'archiver',theme,language,phase:'motion-freeze',interaction:'library-move','guide-preview':'1'});
  const child=spawn(exe,['--visual-audit-output',file,'--visual-audit-query',query.toString(),'--visual-audit-width','1920','--visual-audit-height','1080','--visual-audit-move-target',target],{cwd:source,windowsHide:true,stdio:'ignore'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0);
  const error=await readFile(file.replace('.png','.error.txt'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return null;});assert.equal(error,null);
  assert.match(await readFile(file.replace('.png','.trace.txt'),'utf8'),/feature-guide-move-preview-only/u);
  assert.deepEqual(await readdir(target),[]);
  console.log(`${language}/${theme}: actual move preview cancelled; target empty`);
}
await writeFile(path.join(output,'evidence.json'),JSON.stringify({source,target,executable_sha256:sha(await readFile(exe)),target_empty:true,preview_only:true})+'\n');
