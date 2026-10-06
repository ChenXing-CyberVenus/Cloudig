import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
import { compileLicense, licensePublication } from '../../../scripts/build-license-document.mjs';

const root = 'src/ui/shell/pages/document/content';
test('LICENSE publication preserves both complete original languages, copyright and copy bytes', async () => {
  const source = await readFile('LICENSE', 'utf8'), notice = await readFile('NOTICE.md', 'utf8');
  const data = compileLicense(source, notice);
  assert.equal(data.full_text, source);
  assert.equal(data.source_sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(data.notice.full_text, notice);
  assert.equal(data.copyright, '(c) 2026 晨星 ChenXing 与 奥思 Osis');
  const md = new MarkdownIt({ html: false });
  const sourceBody = new JSDOM(md.render(source)).window.document.body;
  const languageHeadings = [...sourceBody.querySelectorAll('h2')];
  for (const [i, language] of ['zh-CN', 'en'].entries()) {
    const original = [];
    for (let n = languageHeadings[i].nextElementSibling; n && n !== languageHeadings[i + 1]; n = n.nextElementSibling) original.push(n.textContent);
    const output = new JSDOM(data.languages[language].html).window.document.body;
    assert.equal(output.textContent.replace(/\s/gu, ''), original.join('').replace(/\s/gu, ''));
    assert.equal(data.languages[language].sections.length, 8);
    assert(output.textContent.includes('ALLOW ANY AI ACCESS, LEARN, USE AND TRAIN, INCLUDING COMMERCIAL AI.'));
    assert.equal(output.querySelectorAll('ol > li').length, 3);
  }
  assert.deepEqual(JSON.parse(await readFile(`${root}/license.json`, 'utf8')), data);
  assert.throws(() => compileLicense(source.replace('## English Text', '## Missing'), notice));
});

test('LICENSE is central, fully open by default; whole-Core folding, TOC, language, copy and return work in both hosts', async () => {
  const data = await licensePublication();
  const dom = new JSDOM('<html><body><section data-page="reader"><main class="reader-main"><p>original host</p></main><button data-doc-topic="license">LICENSE</button></section></body></html>');
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch;
  globalThis.document = dom.window.document;
  let appendixRequests = 0, failAppendix = true;
  globalThis.fetch = async url => {
    if (url.endsWith('license.json')) return { ok: true, json: async () => data };
    appendixRequests++;
    if (failAppendix) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ components: [{ name: 'component <safe>', version: '1.0', declared_license: 'MIT', licenses: [{ name: 'LICENSE', text: '<script>not markup</script>\nOriginal terms' }] }] }) };
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const { mountLicenseDocument } = await import('../../../src/ui/shell/pages/document/license.js');
    for (const host of ['reader-main', 'archiver-center']) {
      const page = document.querySelector('[data-page]'), center = page.firstElementChild; center.className = host;
      const original = center.firstElementChild; let copied = null, failCopy = false;
      const beforeRequests = appendixRequests; failAppendix = true;
      let view; view = await mountLicenseDocument({ page, onClose: () => view.close(), copyText: async text => { if (failCopy) throw new Error('denied'); copied = text; } });
      const e = view.element;
      assert.equal(center.firstElementChild, original); assert.equal(e.parentElement, center);
      const heading = e.querySelector('.license-frontispiece');
      assert(heading.classList.contains('standard-frontispiece'));
      assert.equal(heading.parentElement, e.querySelector('.standard-scroll'));
      assert.equal(heading.nextElementSibling, e.querySelector('.license-reading'));
      assert.deepEqual([...heading.children].map(n => n.tagName), ['P', 'H1', 'P', 'FIGURE']);
      assert(heading.querySelector('figure').classList.contains('standard-art'));
      assert.equal(e.querySelector('.license-reading .license-hero'), null, 'Frontispiece must not inherit the narrow prose measure');
      assert.equal(e.querySelectorAll('.license-hero img').length, 2);
      for (const theme of ['dawn', 'star-night']) {
        const art = e.querySelector(`.license-art-${theme}`);
        assert(art.src.endsWith(`license-frontispiece-${theme}.png`));
        assert.equal(art.width, 2172); assert.equal(art.height, 724);
        assert.match(art.alt, /六位/u);
      }
      assert.equal(e.querySelector('.license-original').hidden, false);
      assert.equal(appendixRequests, beforeRequests, 'appendix data does not delay the license');
      e.querySelector('[data-standard-menu="core"]').click(); assert.equal(e.querySelector('.license-original').hidden, true);
      assert(e.querySelector('[data-license-core] img').src.endsWith('InfoValue-Core-Grey.svg'));
      e.querySelector('[data-standard-menu="all"]').click();
      e.querySelector('a[href="#license-commercial"]').click();
      assert.equal(e.querySelector('.license-original').hidden, false);
      assert.equal(document.activeElement.id, 'license-commercial');
      assert.equal(e.querySelector('.standard-nav-panel').hidden, true);
      e.querySelector('[data-standard-menu="core"]').click();
      e.querySelector('[data-standard-menu="all"]').click();
      e.querySelector('a[href="#license-core"]').click();
      assert.equal(e.querySelector('.license-original').hidden, false, 'jumping to Complete license also expands it');
      e.querySelector('[data-license-copy]').click(); await tick();
      assert.equal(copied, data.full_text); assert.match(e.querySelector('.license-status').textContent, /完整中英/u);
      failCopy = true; e.querySelector('[data-license-copy]').click(); await tick(); assert.match(e.querySelector('.license-status').textContent, /复制未完成/u);
      e.querySelector('.standard-scroll').scrollTop = 340;
      e.querySelector('[data-license-language]').click(); assert.equal(e.querySelector('.license-original').lang, 'en');
      assert.equal(e.querySelector('.standard-scroll').scrollTop, 340);
      e.querySelector('[data-license-components]').click(); await tick(); assert.match(e.querySelector('.license-status').textContent, /Could not load/u);
      assert.equal(e.querySelector('.license-original').hidden, false);
      failAppendix = false; e.querySelector('[data-license-components]').click(); await tick();
      assert.equal(e.querySelectorAll('.license-component').length, 1); assert.equal(e.querySelector('.license-components pre'), null);
      const component = e.querySelector('.license-component'); component.open = true; component.dispatchEvent(new dom.window.Event('toggle'));
      assert.equal(component.querySelector('script'), null); assert.match(component.querySelector('pre').textContent, /Original terms/u);
      const notice = e.querySelector('.license-notice-original'); notice.open = true; notice.dispatchEvent(new dom.window.Event('toggle'));
      await view.updateLanguage('zh-CN'); assert.equal(e.querySelector('.license-component').open, true);
      assert.equal(e.querySelector('.license-notice-original').open, true);
      assert.equal(e.querySelector('.license-original').lang, 'zh-CN');
      e.querySelector('.standard-return').click(); assert.equal(center.firstElementChild, original);
      assert.equal(center.children.length, 1); assert.equal(page.dataset.document, undefined);
      assert.equal(page.querySelector('[data-doc-topic]').getAttribute('aria-current'), null);
    }
  } finally { globalThis.document = oldDocument; globalThis.fetch = oldFetch; dom.window.close(); }
});
