import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { localizePlatformLabel } from '../../../src/ui/shell/platform-labels.js';

const base = 'src/ui/shell/';
test('Reader English welcome keeps the author two-line copy and a separate centered composition', async () => {
  const en = JSON.parse(await readFile(base + 'locales/en.json', 'utf8')).reader;
  const zh = JSON.parse(await readFile(base + 'locales/zh-CN.json', 'utf8')).reader;
  assert.deepEqual([en.sceneLine1, en.sceneLine2], ['Welcome Home,', 'OUR Clouds.']);
  assert.deepEqual([zh.sceneLine1, zh.sceneLine2], ['把云端的对话，', '重新交还给你。']);
  const dom = new JSDOM(await readFile(base + 'index.html', 'utf8'));
  const reader = dom.window.document.getElementById('reader-cover-template').content;
  assert.equal(reader.querySelectorAll('.reader-scene-statement > span').length, 2);
  for (const [page, route] of [['reader-cover', 'archiver'], ['archiver', 'reader']]) {
    const button = dom.window.document.getElementById(`${page}-template`).content.querySelector('.cloudig-page-switch');
    assert.equal(button.dataset.routeTarget, route);
  }
  const css = await readFile(base + 'pages/reader/reader.css', 'utf8');
  assert.match(css, /:root\[lang="en"\] \[data-page="reader"\] \.reader-scene-brand \{[^}]*display: grid;[^}]*justify-content: center;/u);
  assert.match(css, /:root\[lang="en"\] \[data-page="reader"\] \.reader-scene-statement \{[^}]*height: 136\.64px;[^}]*left: var\(--reader-english-copy-left\);[^}]*width: 480px;/u);
  assert.match(css, /:root\[lang="en"\] \[data-page="reader"\] \.reader-scene-statement::before \{[^}]*background: currentColor;[^}]*mask: url\("\/assets\/reader\/Reader-Welcome-Home-English.svg"\)/u);
  assert.doesNotMatch(css, /-webkit-text-stroke:|@font-face|font-family: "Cloudig Welcome"/u, 'The outlined SVG, not a font/stroke override, paints both themes');
  assert.doesNotMatch(css, /\.reader-manage-archives \{[^}]*width: 132px/u);
  const shared = await readFile(base + 'shell.css', 'utf8');
  assert.match(shared, /:root\[lang="en"\] \.cloudig-button\.cloudig-page-switch \{[^}]*padding-inline: 18px;[^}]*width: auto;/u);
  dom.window.close();
});

test('Welcome keeps bilingual artwork; Reader uses one reproducible outlined SVG with the source license', async () => {
  const html = await readFile(base + 'index.html', 'utf8');
  const dom = new JSDOM(html);
  const title = dom.window.document.getElementById('welcome-title');
  assert.equal(title.tagName, 'IMG');
  assert.equal(title.getAttribute('src'), '/assets/welcome/Cloudig-Logo-Title-Slogan.svg');
  assert.equal(title.hasAttribute('data-brand-english'), false);
  assert.equal(dom.window.document.querySelector('.welcome-wordmark-en'), null);
  const css = await readFile(base + 'welcome.css', 'utf8');
  assert.doesNotMatch(css, /welcome-wordmark|:root\[lang="en"\][^{]*welcome-product-title/u);
  const fontRoot = base + 'fonts/bodoni-moda/';
  const source = JSON.parse(await readFile(fontRoot + 'source.json', 'utf8'));
  const bytes = await readFile(fontRoot + source.file);
  assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
  assert.equal(bytes.length, source.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  const license = await readFile(fontRoot + source.license_file);
  assert.equal(createHash('sha256').update(license).digest('hex'), source.license_sha256);
  assert.match(license.toString(), /SIL OPEN FONT LICENSE Version 1.1/u);
  assert.equal(source.text, 'Welcome Home,OUR Clouds.');
  assert.doesNotMatch(html, /rel="preload" as="font"[^>]+welcome-black/u);
  const outline = await readFile(source.outline.file);
  assert.equal(createHash('sha256').update(outline).digest('hex'), source.outline.sha256);
  const vector = new JSDOM(outline.toString(), { contentType: 'image/svg+xml' });
  assert.equal(vector.window.document.documentElement.getAttribute('viewBox'), '0 0 480 136.64');
  assert.equal(vector.window.document.querySelector('g').getAttribute('stroke-width'), '0.4');
  assert.equal(vector.window.document.querySelectorAll('path').length, 2);
  assert.equal(vector.window.document.querySelectorAll('text,image,use,foreignObject,script').length, 0);
  assert.equal(vector.window.document.querySelector('title').textContent, 'Welcome Home, / OUR Clouds.');
  vector.window.close();
  dom.window.close();
});

test('four author English vectors are copied exactly and used without raster substitutes', async () => {
  const manifest = JSON.parse(await readFile('src/ui/assets/asset-sources.json', 'utf8'));
  const html = await readFile(base + 'index.html', 'utf8');
  for (const part of ['Title', 'Slogan']) for (const shade of ['Light', 'Dark']) {
    const name = `Cloudig-${part}-English-Grey-${shade}.svg`;
    const entry = manifest.assets.find(a => a.output === `reader/${name}`);
    assert.equal(entry.transform, 'copy');
    const source = await readFile('../' + entry.source);
    assert.deepEqual(await readFile('src/ui/assets/' + entry.output), source);
    assert.equal(createHash('sha256').update(source).digest('hex'), entry.source_sha256);
    assert(html.includes(name));
  }
  assert.doesNotMatch(html, /Cloudig-Slogan-English[^"\s]*\.png/u);
});

test('brand language roundtrip preserves the exact Chinese originals in both headers and Reader scene', async () => {
  const html = await readFile(base + 'index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'https://cloudig.local' });
  for (const id of ['reader-cover-template', 'archiver-template']) dom.window.document.body.append(dom.window.document.getElementById(id).content.cloneNode(true));
  const source = await readFile(base + 'shell.js', 'utf8');
  const loop = source.match(/  for \(const image of document\.querySelectorAll\("img\[data-brand-english\]"\)\) \{[\s\S]*?\n  \}/u)?.[0];
  assert(loop);
  const apply = new Function('document', 'state', loop);
  const images = [...dom.window.document.querySelectorAll('img[data-brand-english]')];
  assert.equal(images.length, 6);
  const before = images.map(n => n.getAttribute('src'));
  for (const language of ['en', 'zh-CN', 'en', 'zh-CN']) {
    apply(dom.window.document, { language });
    images.forEach((n, index) => assert.equal(n.getAttribute('src'), language === 'en' ? n.dataset.brandEnglish : before[index]));
  }
  dom.window.close();
});

test('Archiver renders English platform names and all three operation labels without changing profiles', async () => {
  const source = await readFile(base + 'pages/archiver/archiver.js', 'utf8');
  const definitions = source.slice(source.indexOf('const platformDefinitions'), source.indexOf('function renderSourceStatuses'));
  const dom = new JSDOM('<main lang="en"><div data-archiver-bookmark-list></div><p data-bookmark-version-help></p></main>');
  const root = dom.window.document.querySelector('main');
  const render = new Function('document', 'localizePlatformLabel', definitions + '; return renderBookmarks;')(dom.window.document, localizePlatformLabel);
  for (const profile of ['light', 'full', 'all-branches']) for (const status of ['missing', 'outdated', 'current']) {
    render(root, profile, { target: {}, platforms: ['doubao', 'chatglm', 'yuanbao'].map(id => ({ id, status })) });
    for (const [id, label] of [['doubao', 'Doubao'], ['chatglm', 'ChatGLM'], ['yuanbao', 'Yuanbao']]) {
      const row = root.querySelector(`[data-platform=${id}]`);
      assert.equal(row.querySelector('strong > span').textContent, label);
      const action = row.querySelector('.archiver-bookmark-install');
      assert.equal(action.dataset.bookmarkOperation, status === 'current' ? 'remove' : 'install');
      assert.equal(action.textContent, `${status === 'current' ? 'Remove' : status === 'outdated' ? 'Update' : 'Install'}·${profile === 'all-branches' ? 'Tree' : profile === 'light' ? 'Light' : 'Full'}`);
    }
  }
  root.lang = 'zh-CN'; render(root, 'light', { target: {} });
  assert.equal(root.querySelector('[data-platform=doubao] strong > span').textContent, '豆包');
  assert.equal(localizePlatformLabel('unregistered', '原有名称', 'en'), '原有名称');
  dom.window.close();
});

test('StarNight quotes retain all four author-final lines and independent sentence spans', async () => {
  const locale = JSON.parse(await readFile(base + 'locales/en.json', 'utf8')).archiver;
  assert.deepEqual([locale.rocketPoemLine1, locale.rocketPoemLine2, locale.astronautPoemLine1, locale.astronautPoemLine2], [
    'We will not go gentle into that good night.', 'Cloudig refuses to fade with the platforms.',
    'Every heart holds a fire.', 'Cloudig refuses to let it die out in a wisp of smoke.'
  ]);
  const dom = new JSDOM(await readFile(base + 'index.html', 'utf8'));
  const page = dom.window.document.getElementById('archiver-template').content;
  for (const className of ['archiver-bookmark-poem', 'archiver-right-poem']) assert.equal(page.querySelector(`.${className}.archiver-theme-star-night`).children.length, 2);
  const css = await readFile(base + 'pages/archiver/archiver.css', 'utf8');
  assert.match(css, /:is\(\.archiver-bookmark-poem, \.archiver-right-poem\)\s*\{[^}]*font-size: var\(--archiver-english-poem-size\);[^}]*left: 50%;[^}]*text-align: left;[^}]*transform: translateX\(-50%\);/u);
  assert.doesNotMatch(css, /:root\[lang="en"\][^\n]*\.archiver-right-poem \{[^}]*font-size: (?:10|11|13)px/u);
  dom.window.close();
});
