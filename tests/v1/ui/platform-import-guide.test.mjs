import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { platformImportGuides, guideImagePath } from '../../../src/ui/shell/pages/archiver/platform-import-guide-content.js';
import { mountPlatformJsonIndex } from '../../../src/ui/shell/pages/archiver/platform-json.js';
const html = await readFile('src/ui/shell/index.html', 'utf8');

test('guide reproduces the complete author manuscript in order, including every figure', async () => {
  const lines = [];
  for (const guide of platformImportGuides) {
    lines.push(`${guide.name}：`);
    for (const [i, method] of guide.methods.entries()) {
      if (method.title) lines.push(method.title[0]);
      if (!i && !guide.websiteInline) lines.push(`登录网站：${guide.website}`);
      for (const step of method.steps) { lines.push(step.zh); for (const n of step.figures) lines.push(`图${String(n).padStart(2, '0')}`); }
    }
  }
  const manuscript = await readFile('src/ui/documents/platform-import/zh-CN.txt', 'utf8');
  assert.deepEqual(lines, manuscript.split(/\r?\n/u).filter(line => line.trim()));
  assert.deepEqual(platformImportGuides.find(guide => guide.id === 'chatgpt').methods.map(method => method.title[0]), ['方法1:', '方法2:']);
});

test('31 original screenshot bytes and dimensions match the approved asset manifest', async () => {
  const root = 'src/ui/shell/pages/archiver/assets/import-guide/';
  const manifest = JSON.parse(await readFile(`${root}manifest.json`, 'utf8'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(manifest.entries.length, 31);
  assert.equal(hash(await readFile('src/ui/documents/platform-import/zh-CN.txt')), manifest.manuscript_sha256);
  for (const entry of manifest.entries) {
    const bytes = await readFile(root + entry.file);
    assert.equal(hash(bytes), entry.sha256); assert.equal(bytes.length, entry.bytes);
    assert.equal(bytes.readUInt32BE(16), entry.width); assert.equal(bytes.readUInt32BE(20), entry.height);
  }
});

test('per-card help is separate from file selection; guides retain text, scrolling, language and focus', async () => {
  const dom = new JSDOM(html, { url: 'https://cloudig.local' });
  const saved = { document: globalThis.document, window: globalThis.window, AbortController: globalThis.AbortController };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, AbortController: dom.window.AbortController });
  const document = dom.window.document, root = document.importNode(document.querySelector('#archiver-template').content.firstElementChild, true); document.body.append(root);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const imports = []; let closed = 0;
  const view = mountPlatformJsonIndex({ root, state: { language: 'zh-CN' }, onImport: platform => imports.push(platform), onClose: () => { closed++; } });
  try {
    assert.equal(root.querySelectorAll('[data-json-help]').length, 6);
    assert.equal(root.querySelector('button button'), null);
    assert(root.querySelector('[data-json-help=chatgpt]'));
    for (const guide of platformImportGuides) {
      root.querySelector('.archiver-json-groups').scrollTop = 81;
      root.querySelector(`[data-json-help=${guide.id}]`).click();
      const panel = root.querySelector('[data-import-guide]');
      assert.equal(panel.dataset.importGuide, guide.id);
      assert.deepEqual(imports, []); assert.equal(closed, 0);
      assert.deepEqual([...panel.querySelectorAll('[data-guide-step]')].map(node => node.textContent), guide.methods.flatMap(method => method.steps.map(step => step.zh)));
      assert.equal(panel.querySelector('[data-guide-website]').href, guide.website);
      assert.equal(panel.querySelector('[data-guide-website]').target, '_blank');
      assert.deepEqual([...panel.querySelectorAll('.archiver-guide-image img')].map(node => node.getAttribute('src')), guide.methods.flatMap(method => method.steps.flatMap(step => step.figures.map(n => guideImagePath(guide, n)))));
      panel.querySelector('[data-guide-scroll]').scrollTop = 123;
      view.updateState({ language: 'en', theme: 'star-night' });
      assert.equal(panel.querySelector('[data-guide-scroll]').scrollTop, 123);
      assert.deepEqual([...panel.querySelectorAll('[data-guide-step]')].map(node => node.textContent), guide.methods.flatMap(method => method.steps.map(step => step.en)));
      const image = panel.querySelector('[data-guide-zoom]'); image.click();
      assert.equal(root.querySelector('[data-guide-lightbox]').open, true);
      root.querySelector('[data-guide-zoom-close]').click();
      assert.equal(root.querySelector('[data-guide-lightbox]'), null); assert.equal(document.activeElement, image);
      panel.querySelector('[data-guide-back]').click();
      assert.equal(root.querySelector('[data-import-guide]'), null);
      assert.equal(root.querySelector('.archiver-json-groups').scrollTop, 81);
      assert.equal(document.activeElement.dataset.jsonHelp, guide.id);
      view.updateState({ language: 'zh-CN' });
    }
    root.querySelector('[data-json-help=claude]').click();
    root.querySelector('[data-guide-scroll]').scrollTop = 456;
    root.querySelector('[data-guide-platform=qwen]').click();
    assert.equal(root.querySelector('[data-import-guide]').dataset.importGuide, 'qwen');
    root.querySelector('[data-guide-platform=claude]').click();
    assert.equal(root.querySelector('[data-guide-scroll]').scrollTop, 456);
    root.querySelector('[data-guide-zoom]').click(); view.cleanup();
    assert.equal(root.querySelector('[data-guide-lightbox]'), null);
    assert.equal(root.querySelector('[data-json-index]'), null);
  } finally { view.cleanup(); Object.assign(globalThis, saved); dom.window.close(); }
});

test('guide uses the shared scrolling discipline and preserves screenshots without distortion', async () => {
  const css = await readFile('src/ui/shell/pages/archiver/platform-import-guide.css', 'utf8');
  assert.doesNotMatch(css, /::-webkit-scrollbar|scrollbar-color/u);
  assert.match(css, /grid-template-rows: auto auto minmax\(0, 1fr\)/u);
  assert.match(css, /max-width: 100%; width: auto; height: auto/u);
  assert.match(css, /font-size: 16px; line-height: 1\.7/u);
});
