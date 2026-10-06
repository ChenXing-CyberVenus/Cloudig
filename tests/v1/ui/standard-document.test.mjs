import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';
import { JSDOM } from 'jsdom';
import { compileStandard, formatStandardFootnotes } from '../../../scripts/build-standard-document.mjs';

const sourceRoot = 'src/ui/documents/standard';
const moduleRoot = 'src/ui/shell/pages/document';
const md = new MarkdownIt({ html: true });
for (const language of ['zh-CN', 'en']) test(`standard ${language}: all substantive content, examples, table cells and value levels survive`, async () => {
  const source = await readFile(`${sourceRoot}/${language}.md`, 'utf8');
  const compiled = compileStandard(source, language);
  const original = new JSDOM(`<main>${md.render(source)}</main>`).window.document;
  const result = new JSDOM(compiled.html).window.document;
  const readable = result.body.cloneNode(true);
  for (const reference of readable.querySelectorAll('.standard-note-reference')) reference.replaceWith(reference.dataset.sourceMarker);
  for (const selector of ['pre code', 'td', 'th', 'h2', 'h3']) assert.deepEqual([...readable.querySelectorAll(selector)].map(n => n.textContent), [...original.querySelectorAll(selector)].map(n => n.textContent), selector);
  const main = original.querySelector('main');
  main.querySelector('h1').remove(); main.firstElementChild.remove(); main.querySelector(':scope > ul').remove();
  const sourceNotes = [...main.querySelectorAll('p')].filter(p => /^\[\^?\d+\]:?\s/u.test(p.textContent));
  const expectedNotes = sourceNotes.flatMap(p => p.innerHTML.split(/\n(?=\[\^?\d+\]:?\s)/u).map(html => {
    const content = original.createElement('div'); content.innerHTML = html.replace(/^\[\^?\d+\]:?\s+/u, '');
    return content.textContent;
  }));
  assert.equal(expectedNotes.length, 3);
  assert.deepEqual([...result.querySelectorAll('.standard-footnote-copy')].map(n => n.textContent), expectedNotes, 'all original note text survives');
  sourceNotes.forEach(p => p.remove());
  readable.querySelectorAll('.standard-footnotes').forEach(n => n.remove());
  const authorizedText = main.textContent.replace(language === 'en' ? 'Preset Terran timelines:' : '预设此地时间轴：', language === 'en' ? 'Preset Terran timelines' : '预设此地时间轴');
  assert.equal(readable.textContent.replace(/\s+/gu, ''), authorizedText.replace(/\s+/gu, ''));
  assert.equal(result.querySelectorAll('.standard-footnotes').length, 2, 'notes belong to their sections');
  assert.equal(result.querySelectorAll('sup a[role="doc-noteref"]').length, 3);
  assert.deepEqual([...result.querySelectorAll('.standard-concept-heading')].map(p => p.textContent), [...main.querySelectorAll('p')].filter(p => p.children.length === 1 && p.firstElementChild.tagName === 'STRONG' && p.textContent.trim() === p.firstElementChild.textContent.trim()).map(p => p.textContent), 'only author-marked standalone concepts receive spacing');
  assert.equal(result.querySelectorAll('.standard-concept-heading').length, 6);
  for (const reference of result.querySelectorAll('[role="doc-noteref"]')) {
    const note = result.getElementById(reference.getAttribute('href').slice(1));
    assert(note?.querySelector(`[role="doc-backlink"][href="#${reference.id}"]`), 'every note returns to its reference');
  }
  if (language === 'en') assert.match(result.querySelector('#standard-note-3 em').textContent, /Presentation of Self/u);
  assert.equal(compiled.toc.length, language === 'en' ? 14 : 13); // English retains its translators section.
  assert(result.querySelectorAll('[data-infovalue="core"]').length > 10);
  assert(result.querySelectorAll('details[data-infovalue="fold"]').length >= 13);
  assert.equal(result.querySelector('script, iframe'), null);
  assert(result.querySelectorAll('strong.standard-emphasis-accent').length >= 6, 'key judgments have explicit emphasis');
  assert(result.querySelectorAll('strong.standard-emphasis-bold').length >= 12, 'selected definitions and boundaries are bold');
  assert.equal(result.querySelector('pre strong, code strong, table strong.standard-emphasis-accent'), null, 'editorial emphasis never rewrites examples or field tables');
  const sovereign = result.querySelector('[data-standard-layout=sovereign]');
  assert.deepEqual([...sovereign.children].map(n => n.tagName), ['UL','P','UL','P','P']);
  assert.deepEqual([...sovereign.querySelectorAll('ul')].map(n => n.children.length), [2,2], 'node definitions and operations are two separate parallel lists');
  assert.equal(sovereign.querySelectorAll('li > strong').length, 4);
  assert.equal(sovereign.querySelector('.standard-time-boundary > strong > br').tagName, 'BR');
  const nodes = result.querySelector('[data-standard-flow=nodes]');
  assert.equal(nodes.querySelectorAll(':scope > br').length, 2, 'node, mapping and ordinal statements each start their own line');
  const ordinalLine = result.createRange(); ordinalLine.setStartAfter(nodes.querySelector('br:last-of-type')); ordinalLine.setEndAfter(nodes.lastChild);
  assert(ordinalLine.toString().startsWith(language === 'en' ? 'The Ordinal is attention' : '序数是注意力'));
  assert.equal(result.querySelector('[data-standard-flow=identity] > br').tagName, 'BR');
  assert.equal(result.querySelectorAll('[data-standard-flow=identity] > strong').length, 5);
  const preset = result.querySelector('[data-standard-flow=presets]');
  assert.equal(preset.firstElementChild.tagName, 'STRONG'); assert(!/[:：]$/u.test(preset.textContent));
  for (const term of language === 'en' ? ['The Earth calendar axis','Anchors'] : ['地球公历时间轴历法','锚点']) assert([...result.querySelectorAll('li > strong')].some(n => n.textContent === term));
  assert.deepEqual(JSON.parse(await readFile(`${moduleRoot}/content/standard-${language}.json`, 'utf8')), compiled);
});

test('both hosts preserve original children, disclose actual body, use grey icons and restore cleanly', async () => {
  const dom = new JSDOM('<html><body><section data-page="reader"><main class="reader-main"><div class="original">kept</div></main><button data-doc-topic="json">采云标准</button></section></body></html>');
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.document = dom.window.document;
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  globalThis.fetch = async url => ({ ok: true, json: async () => JSON.parse(await readFile(`src/ui/shell${url}`, 'utf8')) });
  try {
    const { mountStandardDocument } = await import(`../../../${moduleRoot}/document.js`);
    for (const hostClass of ['reader-main', 'archiver-center']) {
      const page = document.querySelector('[data-page]'), center = page.firstElementChild;
      center.className = hostClass;
      const original = center.firstElementChild;
      let view;
      view = await mountStandardDocument({ page, language: 'zh-CN', onClose: () => view.close() });
      assert.equal(center.firstElementChild, original);
      assert(center.classList.contains('standard-document-host'));
      assert(view.element.querySelector('.standard-return').classList.contains('cloudig-button-filled'));
      assert.equal(view.element.querySelector('.standard-reading-hint'), null);
      view.element.querySelector('a[href="#standard-note-3"]').click();
      assert.equal(document.activeElement.id, 'standard-note-3');
      view.element.querySelector('#standard-note-3 [role="doc-backlink"]').click();
      assert.equal(document.activeElement.id, 'standard-note-ref-3-1');
      assert.equal(document.activeElement.tabIndex, 0, 'returning preserves the reference in keyboard navigation');
      const button = view.element.querySelector('.standard-value-toggle');
      const section = button.closest('section');
      assert.equal(button.getAttribute('aria-expanded'), 'true');
      button.click();
      assert.equal(button.getAttribute('aria-expanded'), 'false');
      assert(button.querySelector('img').src.endsWith('-Grey.svg'));
      assert.equal(section.querySelector(':scope > .standard-section-body').hidden, true);
      assert.equal(section.querySelector('h2').hidden, false);
      button.click();
      assert(!button.querySelector('img').src.endsWith('-Grey.svg'));
      const bar = view.element.querySelector('.standard-bar'), panel = bar.querySelector('.standard-nav-panel');
      assert.equal(bar.querySelectorAll('.standard-category-toggle').length, 4);
      assert.equal(view.element.querySelector('.standard-reading-tools, .standard-value-legend, .standard-toc'), null);
      const hover = value => bar.querySelector(`[data-standard-menu="${value}"]`).dispatchEvent(new dom.window.Event('pointerenter'));
      hover('core');
      assert.equal(panel.hidden, false);
      assert([...panel.querySelectorAll('nav a')].every(a => a.dataset.infovalue === 'core'));
      const core = bar.querySelector('[data-standard-menu="core"]');
      if (core.getAttribute('aria-pressed') !== 'true') core.click();
      core.click();
      assert.equal(core.getAttribute('aria-pressed'), 'false');
      assert(core.querySelector('img').src.endsWith('-Grey.svg'));
      assert([...view.element.querySelectorAll('.standard-prose section[data-infovalue="core"]')].every(s => s.querySelector(':scope > .standard-section-body').hidden));
      panel.querySelector('a[href="#standard-3"]').click();
      assert.equal(panel.hidden, true);
      assert.equal(view.element.querySelector('#standard-3 > .standard-section-body').hidden, false);
      assert.equal(view.element.querySelector('#standard-2 > .standard-section-body').hidden, false);
      assert.equal(core.getAttribute('aria-pressed'), 'mixed');
      assert.equal(view.element.querySelector('#standard-1 > .standard-section-body').hidden, true, 'jumping does not reopen unrelated chapters');
      const fold = bar.querySelector('[data-standard-menu="fold"]');
      fold.click();
      assert([...view.element.querySelectorAll('details[data-infovalue="fold"]')].every(d => d.open));
      assert.equal(fold.getAttribute('aria-pressed'), 'true');
      fold.click();
      assert([...view.element.querySelectorAll('details[data-infovalue="fold"]')].every(d => !d.open));
      hover('all');
      assert.equal(panel.querySelectorAll('nav a').length, view.element.querySelectorAll('.standard-prose [data-infovalue]').length);
      const contents = bar.querySelector('[data-standard-menu="all"]');
      contents.click();
      bar.dispatchEvent(new dom.window.Event('pointerleave'));
      assert.equal(panel.hidden, false, 'a clicked contents menu stays open');
      contents.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      assert.equal(document.activeElement, panel.querySelector('nav a'));
      document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      assert.equal(document.activeElement, panel.querySelector('nav a:last-child'));
      document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(panel.hidden, true); assert.equal(document.activeElement, contents);
      hover('important');
      document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
      assert.equal(panel.hidden, true);
      const collapsedBeforeLanguage = view.element.querySelector('#standard-1 > .standard-section-body').hidden;
      await view.updateLanguage('en');
      assert.equal(view.element.querySelector('#standard-1 > .standard-section-body').hidden, collapsedBeforeLanguage);
      assert.equal(view.element.querySelector('[data-standard-menu="all"] span').textContent, 'Contents');
      view.element.querySelector('.standard-return').click();
      assert.equal(center.children.length, 1); assert.equal(center.firstElementChild, original);
      assert.equal(center.classList.contains('standard-document-host'), false);
    }
  } finally {
    for (const key of ['document', 'fetch']) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else delete globalThis[key]; }
    dom.window.close();
  }
});

test('footnotes preserve code, support repeated references and reject duplicate/orphan notes', () => {
  const dom = new JSDOM('<main><div><p>First[1], again[1]; <code>[1]</code>; literal[99].</p><p>[1] Original <em>note</em>.</p></div></main>');
  const main = dom.window.document.querySelector('main');
  formatStandardFootnotes(main, 'en');
  assert.equal(main.querySelectorAll('[role="doc-noteref"]').length, 2);
  assert.equal(main.querySelectorAll('[role="doc-backlink"]').length, 2);
  assert.equal(main.querySelector('code').textContent, '[1]');
  assert(main.textContent.includes('literal[99]'));
  assert.equal(main.querySelector('.standard-footnote-copy').innerHTML, 'Original <em>note</em>.');
  for (const [html, expected] of [['<p>[1] No reference.</p>', /Unreferenced/u], ['<p>Ref[1]</p><p>[1] A</p><p>[1] B</p>', /duplicate/u]]) {
    const invalid = new JSDOM(`<main>${html}</main>`);
    assert.throws(() => formatStandardFootnotes(invalid.window.document.querySelector('main'), 'en'), expected);
    invalid.window.close();
  }
  dom.window.close();
});

test('all four grey icons retain the authored geometry and multiple tonal levels', async () => {
  for (const name of ['Core', 'Important', 'General', 'Fold']) {
    const colour = await readFile(`${moduleRoot}/assets/InfoValue-${name}.svg`, 'utf8');
    const grey = await readFile(`${moduleRoot}/assets/InfoValue-${name}-Grey.svg`, 'utf8');
    assert.equal(grey.replace(/#[\da-f]{3,6}\b/giu, '#'), colour.replace(/#[\da-f]{3,6}\b/giu, '#'));
    const tones = [...grey.matchAll(/#([\da-f]{6})\b/giu)].map(m => m[1]);
    assert(new Set(tones).size >= 2);
    assert(tones.every(tone => tone.slice(0,2) === tone.slice(2,4) && tone.slice(2,4) === tone.slice(4,6)));
  }
});
