import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = name => typeof name === 'string' && name.split('/').every(part => /^[A-Za-z0-9_.,\[\]-]+$/.test(part) && !['.', '..'].includes(part));

/** Fixed public build inputs, not per-work runtime downloads. A verified
 * developer copy can seed them; clean builds obtain the same pinned bytes. */
export async function buildBundledWorkComponents(repository, output, catalog, obtain = async file => {
  const response = await fetch(file.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Component input unavailable: ${response.status} ${file.url}`);
  return Buffer.from(await response.arrayBuffer());
}) {
  const cache = path.join(repository, 'artifacts/work-component-inputs');
  const result = [];
  for (const component of catalog.components) {
    if (!['bundled','on-demand'].includes(component.delivery)) throw new Error(`Unknown component delivery: ${component.id}`);
    if (component.delivery !== 'bundled') continue;
    if (!plain(component.id) || component.id.includes('/')) throw new Error('Invalid component ID');
    for (const file of component.files) {
      if (!plain(file.file) || !/^https:\/\//.test(file.url) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid component input');
      const valid = bytes => bytes.length === file.bytes && digest(bytes) === file.sha256;
      const input = path.join(cache, component.id, file.file);
      let bytes, cached = false;
      for (const candidate of [input, path.join(repository, 'artifacts/v1-desktop/app/app/optional-components', component.id, file.file)]) {
        try { const value = await readFile(candidate); if (valid(value)) { bytes = value; cached = candidate === input; break; } }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!bytes) bytes = await obtain(file);
      if (!valid(bytes)) throw new Error(`Component input hash/length mismatch: ${component.id}/${file.file}`);
      if (!cached) {
        await mkdir(path.dirname(input), { recursive: true });
        // One fixed cache entry per pinned file, not a new directory per build.
        const staging = input + `.building-${process.pid}`;
        try { await writeFile(staging, bytes); await rename(staging, input); }
        finally { await rm(staging, {force:true}); }
      }
      const relative = `components/${component.id}/${file.file}`;
      const target = path.join(output, relative);
      await mkdir(path.dirname(target), {recursive:true}); await writeFile(target, bytes);
      result.push({ file: relative, bytes: bytes.length, sha256: file.sha256 });
    }
  }
  return result;
}
