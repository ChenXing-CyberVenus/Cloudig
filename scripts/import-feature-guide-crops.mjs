import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { featureFigures } from './build-feature-document.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
export async function guideUiFingerprint(root=path.resolve('artifacts/v1-desktop/app/app/web'),nonvisual=[]) {
  const files=[];async function scan(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){const r=prefix+e.name;if(r==='pages/document')continue;if(e.isDirectory())await scan(path.join(dir,e.name),r+'/');else if(e.isFile())files.push(r);else throw new Error('Unexpected link in packaged web');}}
  await scan(root);const lines=[];for(const f of files.sort()){let hash=sha(await readFile(path.join(root,f)));const change=nonvisual.find(c=>c.file===f);if(change){assert.equal(hash,change.after);if(change.before===null)continue;hash=change.before;}lines.push(f+'\0'+hash+'\n');}return sha(lines.join(''));
}
const roots=process.argv.slice(2);assert(roots.length,'Pass only completed capture directories');
const images={},fingerprint=await guideUiFingerprint();
if(roots[0]==='--record-welcome-route'){
  const manifest=JSON.parse(await readFile('src/ui/documents/features/screenshots.json','utf8'));assert.equal(manifest.ui_sha256,fingerprint);
  const before=await readFile('artifacts/v1-desktop/app/app/web/shell.js','utf8'),after=await readFile('src/ui/shell/shell.js','utf8');
  assert.equal(after.replace(/^  if \(button\.dataset\.action === "open-docs"\).*\r?\n/mu,''),before,'Only the explicit Welcome documentation dispatch may differ');
  manifest.nonvisual_updates=[{file:'shell.js',before:sha(before),after:sha(after),reason:'Welcome documentation button now navigates to Reader and opens Features; no captured UI appearance changes'}];
  await writeFile('src/ui/documents/features/screenshots.json',JSON.stringify(manifest,null,2)+'\n');console.log('Recorded exact nonvisual Welcome route delta');process.exit(0);
}
if (roots[0] === '--check-ui') {
  const manifest=JSON.parse(await readFile('src/ui/documents/features/screenshots.json','utf8'));
  const checked=manifest.nonvisual_updates?.length?await guideUiFingerprint(undefined,manifest.nonvisual_updates):fingerprint;
  assert.equal(manifest.ui_sha256,checked,'Final packaged UI differs from the screenshot source');
  console.log('Screenshot inputs match; any explicit nonvisual route delta is separately hash-verified');process.exit(0);
}
const expected=new Set(Object.values(featureFigures).flat());
const target=path.resolve('src/ui/shell/pages/document/assets/function-guide');
async function readGuide(dir){for(const file of (await readdir(dir)).filter(f=>f.endsWith('.json'))){
  const id=file.slice(0,-5);assert(expected.has(id),`Unexpected illustration ${id}`);
  const record=JSON.parse(await readFile(path.join(dir,file),'utf8'));assert.equal(record.kind,'native-webview-crop');assert.equal(record.ui_sha256,fingerprint,'Capture UI differs from the fixed package');
  const language=record.bounds.language,theme=record.bounds.theme;assert(['zh-CN','en'].includes(language));assert(['dawn','star-night'].includes(theme));
  const key=`${language}/${theme}/${id}`;assert(!images[key],`Duplicate capture ${key}`);
  const bytes=await readFile(path.join(dir,id+'.png'));assert.equal(sha(bytes),record.sha256);assert.equal(bytes.readUInt32BE(16),record.pixels.width);assert.equal(bytes.readUInt32BE(20),record.pixels.height);
  const relative=key+'.png';await mkdir(path.dirname(path.join(target,relative)),{recursive:true});await copyFile(path.join(dir,id+'.png'),path.join(target,relative));
  if(['07-branches','14-entry'].includes(id)){
    const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/refine-feature-guide-crop.ps1'),'-Source',path.join(dir,id+'.png'),'-Target',path.join(target,relative),'-Region',id],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);const rectangle=JSON.parse(result.stdout);
    record.native_crop_sha256=record.sha256;record.native_crop_pixels=record.pixels;record.refinement=rectangle;
    record.sha256=sha(await readFile(path.join(target,relative)));record.pixels={width:rectangle.width,height:rectangle.height};
  }
  images[key]={...record,file:relative,capture:path.relative(process.cwd(),path.join(dir,file)).replaceAll('\\','/')};
}}
for(const root of roots){const full=path.resolve(root);assert(full.startsWith(path.resolve('artifacts/v1-visual-audit')+path.sep));for(const e of await readdir(full,{withFileTypes:true})){if(e.name==='guide'&&e.isDirectory())await readGuide(path.join(full,e.name));else if(e.isDirectory()&&/^(zh-CN|en)-(dawn|star-night)$/u.test(e.name))await readGuide(path.join(full,e.name,'guide'));}}
for(const l of ['zh-CN','en'])for(const t of ['dawn','star-night'])for(const id of expected)assert(images[`${l}/${t}/${id}`],`Missing ${l}/${t}/${id}`);
await writeFile('src/ui/documents/features/screenshots.json',JSON.stringify({format:'cloudig/feature-guide-crops/1',ui_sha256:fingerprint,images:Object.fromEntries(Object.entries(images).sort())},null,2)+'\n');
console.log(JSON.stringify({crops:Object.keys(images).length,ui_sha256:fingerprint}));
