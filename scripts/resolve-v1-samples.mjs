import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { probeExporterManifest } from '../src/adapters/parser/html-envelope.mts';

/** An index over originals, never another copied Sample directory. A dated
 * folder remains an explicit focused input; a parent uses the declared batches. */
export async function resolveV1Samples(root, batches) {
  root = path.resolve(root);
  const direct = (await readdir(root,{withFileTypes:true})).filter(e=>e.isFile()&&/\.html$/iu.test(e.name));
  if (!batches) batches = JSON.parse(await readFile(new URL('../src/adapters/parser/contracts/sample-waterline.json',import.meta.url),'utf8')).batches;
  const folders = direct.length ? [root] : [...new Set(batches ?? [])].sort().map(batch=>{
    if(!/^\d{4}-\d{2}-\d{2}$/u.test(batch)) throw Error('Invalid Sample batch');
    return path.join(root,batch);
  });
  if(!folders.length) throw Error('No HTML or declared Sample batches');
  const selected = new Map();
  for(const folder of folders) {
    const names = (await readdir(folder,{withFileTypes:true})).filter(e=>e.isFile()&&/\.html$/iu.test(e.name)).map(e=>e.name).sort();
    const batchKeys = new Set();
    for(const name of names) {
      const file = path.join(folder,name), manifest = await probeExporterManifest(file);
      if(!manifest) throw Error(`Sample has no supported manifest: ${file}`);
      const version = String(manifest.exporter_version ?? manifest.exporter?.version ?? '');
      const profile = /all[-_]branches|tree/iu.test(version) ? 'tree' : /full/iu.test(version) ? 'full' : /light/iu.test(version) ? 'light' : undefined;
      if(!profile || typeof manifest.platform!=='string') throw Error(`Sample platform/profile missing: ${file}`);
      const identity = [manifest.conversation_id,manifest.source?.conversation_id,manifest.source_url,manifest.source?.url].find(v=>typeof v==='string'&&v.trim());
      const caseName = path.parse(name).name.replace(/ \([12]\)$/u,'');
      // Case name retains deliberately different branches/cases of one chat.
      // A missing source identity cannot justify replacing an older original.
      const key = JSON.stringify([manifest.platform,profile,identity ?? file,caseName]);
      if(batchKeys.has(key)) throw Error(`Ambiguous duplicate Sample case/profile: ${file}`);
      batchKeys.add(key);
      selected.set(key,{file,name,batch:path.basename(folder),platform:manifest.platform,profile,version,caseName});
    }
  }
  const values=[...selected.values()].sort((a,b)=>a.file.localeCompare(b.file,'en'));
  const counts=new Map(); for(const v of values) counts.set(v.name.toLowerCase(),(counts.get(v.name.toLowerCase())??0)+1);
  const used = new Set();
  for(const value of values) {
    value.importName=counts.get(value.name.toLowerCase())>1?`${path.parse(value.name).name} (${value.batch}).html`:value.name;
    if(used.has(value.importName.toLowerCase())) throw Error(`Sample import names collide: ${value.importName}`);
    used.add(value.importName.toLowerCase());
  }
  return values;
}
