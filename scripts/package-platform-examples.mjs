import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_EXAMPLES_SITE } from '../src/ui/shell/pages/document/examples-links.js';

/** Desktop distribution carries reference facts and prose, never the large
 * curated HTML/Conversation bodies. The website owns those downloadable bytes. */
export async function packagePlatformExamples(repository, payloadRoot, manifest) {
  const target = path.join(payloadRoot, 'docs/examples'); await mkdir(target, { recursive: true });
  assert.equal(manifest.format, 'cloudig/public-examples/1');
  const published = { ...manifest, distribution: 'online', site: PUBLIC_EXAMPLES_SITE };
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify(published, null, 2) + '\n');
  for (const language of ['zh-CN', 'en']) {
    const original = await readFile(path.join(repository, `src/ui/documents/examples/${language}.md`), 'utf8');
    // Only destinations change. Preserve all author-final prose and link labels.
    const linked = original.replace(/href="examples\/([^"/]+\.html)"/gu, (_all, filename) => {
      const entry = manifest.examples.find(e => e.html.file === filename); assert(entry, `Unknown curated example ${filename}`);
      return `href="${new URL(`examples/html/${encodeURIComponent(filename)}`, PUBLIC_EXAMPLES_SITE).href}"`;
    });
    await writeFile(path.join(target, `Cloudig-Platform-Examples.${language}.md`), linked);
  }
  return { mode: 'online-catalog', count: manifest.examples.length, site: PUBLIC_EXAMPLES_SITE,
    omitted_bytes: manifest.examples.reduce((n, e) => n + e.html.bytes + e.record.bytes, 0) };
}
