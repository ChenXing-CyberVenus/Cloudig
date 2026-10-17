import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { platformImportGuides, guideImagePath } from '../src/ui/shell/pages/archiver/platform-import-guide-content.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(root, '../阅读器美术素材/功能文档截图');
const target = path.join(root, 'src/ui/shell/pages/archiver/assets/import-guide');
const manuscript = path.resolve(root, '../研究报告文档/采云功能文档/V1.0东方既白/2026-09-09-正式功能文档-ChenXing/平台文件导入指南.txt');
const savedManuscript = path.join(root, 'src/ui/documents/platform-import/zh-CN.txt');
const writing = process.argv.includes('--write');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (writing) { await mkdir(target, { recursive: true }); await mkdir(path.dirname(savedManuscript), { recursive: true }); }
const entries = [];
for (const guide of platformImportGuides) for (const method of guide.methods) for (const step of method.steps) for (const n of step.figures) {
  const original = `${guide.imagePrefix ?? guide.name}导出-${String(n).padStart(2, '0')}.png`;
  const destination = path.join(target, path.basename(guideImagePath(guide, n)));
  const bytes = await readFile(path.join(source, original));
  if (writing) await copyFile(path.join(source, original), destination);
  assert.equal(sha(await readFile(destination)), sha(bytes), original);
  entries.push({ source: original, file: path.basename(destination), bytes: bytes.length, sha256: sha(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}
assert.equal(entries.length, 27);
// Publish the six approved guides, including only GPT's completed method 2.
const originalManuscript = await readFile(manuscript);
let completedManuscript = originalManuscript.toString('utf8');
// The author is editing the live original. Fill her explicit production marker
// in the publication copy instead of repeatedly overwriting her editor buffer.
for (const guide of platformImportGuides) completedManuscript = completedManuscript.replace(
  new RegExp(`(${guide.name}：\\r?\\n(?:方法1\\r?\\n)?)登录网站：附上他们的网址`, 'u'), `$1登录网站：${guide.website}`);
const normalizedManuscript = Buffer.from(completedManuscript.replaceAll('\r\n', '\n').trimEnd() + '\n');
if (writing) await writeFile(savedManuscript, normalizedManuscript);
assert.equal(sha(await readFile(savedManuscript)), sha(normalizedManuscript), 'Author manuscript changed; reread before synchronizing, never overwrite her edits');
const manifest = { author: '晨星 ChenXing.CyberVenus', scope: platformImportGuides.map(guide => guide.id), manuscript_sha256: sha(normalizedManuscript), entries };
const manifestPath = path.join(target, 'manifest.json');
if (writing) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);
console.log(JSON.stringify({ mode: writing ? 'write' : 'check', images: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), manuscript_sha256: manifest.manuscript_sha256 }));
