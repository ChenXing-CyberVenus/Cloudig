import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountPlatformJsonIndex } from '../../../src/ui/shell/pages/archiver/platform-json.js';
import { platformJsonDefinitions, platformJsonImportGuides, platformJsonQuotes } from '../../../src/ui/shell/pages/archiver/platform-json-presentation.js';

const html = await readFile('src/ui/shell/index.html', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('every available platform card reaches the real shell import callback', async () => {
  const shell = await readFile('src/ui/shell/shell.js', 'utf8');
  const callback = shell.match(/^\s*onJsonImport: (.+),\r?$/mu)?.[1];
  assert(callback, 'The actual mounted Archiver callback must be tested');
  const calls = [];
  const importSource = new Function('platformJsonDefinitions', 'performSourceImport', `return (${callback});`)(
    platformJsonDefinitions, async (kind, platform) => { calls.push({ kind, platform }); return true; });
  for (const { id } of platformJsonDefinitions.filter(item => item.available)) {
    assert.equal(await importSource(id), true, `${id} must reach the native picker, not silently return false`);
    assert.deepEqual(calls.at(-1), { kind: 'platform_json', platform: id });
  }
  const count = calls.length;
  assert.equal(await importSource('unknown'), false);
  assert.equal(calls.length, count);
});
test('file index routes official and Agent Tool sources through the native picker', async () => {
  const dom = new JSDOM(html, { url: 'https://cloudig.local' });
  const saved = { document: globalThis.document, window: globalThis.window, AbortController: globalThis.AbortController };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, AbortController: dom.window.AbortController });
  const root = dom.window.document.importNode(dom.window.document.querySelector('#archiver-template').content.firstElementChild, true);
  dom.window.document.body.append(root);
  const imports = [], originals = [...root.querySelectorAll('.archiver-claude-quote')].map(n => n.innerHTML);
  let view;
  try {
    view = mountPlatformJsonIndex({ root, state: { language: 'zh-CN', theme: 'dawn' }, onImport: platform => imports.push(platform), onClose: () => view.cleanup() });
    assert.equal(root.querySelectorAll('[data-json-platform]').length, 11);
    assert.equal(root.querySelector('.archiver-json-heading h1').textContent, '导入平台文件');
    assert.deepEqual(platformJsonDefinitions.filter(d => d.available).map(d => d.id), ['chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'mistral', 'cline', 'sillytavern', 'kimi-code', 'claude-code', 'codex']);
    assert.match(root.querySelector('.archiver-json-heading p').textContent, /选JSON.*选完整会话ZIP.*不选择文件夹/u);
    assert.equal(root.querySelectorAll('[data-json-input="json"]').length, 4);
    assert.equal(root.querySelectorAll('[data-json-input="jsonl"]').length, 4);
    assert.equal(root.querySelectorAll('[data-json-input="zip"]').length, 3);
    assert.equal(root.querySelectorAll('.archiver-json-desk').length, 1);
    assert.equal(root.querySelector('.archiver-json-desk').getAttribute('aria-hidden'), 'true');
    assert.equal(root.querySelector('.archiver-json-desk text'), null, 'Hero contains no user-facing copy');
    assert.equal(root.querySelectorAll('[data-json-group="agent"] [data-json-platform]').length, 5);
    for (const [platform, guide] of Object.entries(platformJsonImportGuides)) {
      const card = root.querySelector(`[data-json-platform="${platform}"]`);
      assert.equal(card.querySelector('code').textContent, guide.file);
      assert.equal(card.querySelector('.archiver-json-import-hint').textContent, guide.zh);
      assert.match(card.querySelector('small').textContent, /选择(JSON|ZIP).*可多选/u);
      assert.equal(card.querySelector('.archiver-json-file-art').getAttribute('aria-hidden'), 'true');
      assert.equal(card.querySelector('button'), null, 'File art must not turn the card into nested controls');
    }
    assert.match(root.querySelector('[data-json-platform="grok"]').textContent, /完整ZIP.*无需解压/u);
    assert.match(root.querySelector('[data-json-platform="mistral"]').textContent, /完整ZIP.*包内多篇会话/u);
    assert.match(root.querySelector('[data-json-platform="codex"]').textContent, /JSONL/u);
    assert.equal(root.querySelector('[data-json-platform="chatgpt"] code').textContent, '*.zip');
    assert.match(root.querySelector('[data-json-platform="chatgpt"]').textContent, /邮件导出的ZIP.*隐私导出的内层Conversations ZIP.*不选隐私总包或Files包/u);
    root.querySelector('[data-json-platform="codex"]').click(); await tick();
    assert.deepEqual(imports, ['codex']);
    view = mountPlatformJsonIndex({ root, state: { language: 'zh-CN', theme: 'dawn' }, onImport: platform => imports.push(platform), onClose: () => view.cleanup() });
    view.updateState({ language: 'en', theme: 'star-night' }); await tick();
    assert.equal(root.querySelector('.archiver-json-heading h1').textContent, 'Import Platform Files');
    assert.match(root.querySelector('.archiver-json-heading p').textContent, /Do not extract ZIPs or select folders/u);
    for (const [platform, guide] of Object.entries(platformJsonImportGuides)) assert.equal(root.querySelector(`[data-json-platform="${platform}"] .archiver-json-import-hint`).textContent, guide.en);
    for (const platform of ['chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'mistral', 'cline', 'sillytavern', 'kimi-code', 'claude-code', 'codex']) {
      root.querySelector(`[data-json-platform="${platform}"]`).click(); await tick();
      assert.equal(imports.at(-1), platform); assert.equal(root.querySelector('[data-json-index]'), null);
      view = mountPlatformJsonIndex({ root, state: { language: 'zh-CN', theme: 'dawn' }, onImport: platform => imports.push(platform), onClose: () => view.cleanup() });
    }
    assert.deepEqual(imports, ['codex', 'chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'mistral', 'cline', 'sillytavern', 'kimi-code', 'claude-code', 'codex']);
  } finally { view?.cleanup(); Object.assign(globalThis, saved); dom.window.close(); }
});

test('new platform decorations and controls reuse Claude layout; author epigraphs are exact', async () => {
  const specification = await readFile('../采云界面原型标准-2026-08-28.md', 'utf8');
  for (const line of Object.values(platformJsonQuotes).flat()) assert(specification.includes(line));
  const css = await readFile('src/ui/shell/pages/archiver/platform-json.css', 'utf8');
  assert.match(css, /data-scroll-region|overflow-y: auto/u);
  assert.doesNotMatch(css, /::-webkit-scrollbar/u, 'Use the established shared scrollbar, not a new skin');
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /height: fit-content; max-height: calc\(100% - 46px\)/u, 'Chooser fits its content up to the viewport cap');
  assert.match(css, /\[data-showing-guide\] \{ height: calc\(100% - 46px\); display: grid;/u, 'Guide keeps a bounded reading body independently of card height');
  assert.match(css, /archiver-json-desk \{[^}]*pointer-events: none;/u, 'Decoration never intercepts import/help clicks');
  assert.match(css, /archiver-json-heading h1 \{[^}]*width: fit-content;[^}]*background: transparent;/u, 'Title copy must not carry a hard-ended background');
  assert.match(css, /archiver-json-heading h1 \{[^}]*padding: 8px var\(--import-heading-inset\);[^}]*border-radius: 0;/u, 'Title strip is a straight rectangle with symmetric copy padding, not an arbitrary rounded tail');
  assert.match(css, /archiver-json-heading \{[^}]*#e2b6a3 58%[^}]*#c7e6e9 100%/u, 'The lighter header bridges warm paper and cool illustration colors');
  assert.match(css, /\[data-theme="star-night"\] \.archiver-json-heading \{[^}]*#463556 58%[^}]*#716399 100%/u);
  assert.match(css, /archiver-json-heading h1 \{[^}]*color: #fff;/u);
  assert.match(css, /archiver-json-heading \{[^}]*container-type: inline-size; isolation: isolate;/u);
  assert.match(css, /archiver-json-heading h1::before \{[^}]*top: 0; bottom: 0;[^}]*width: calc\(100cqw \+ 2 \* var\(--import-heading-inset\)\);[^}]*pointer-events: none;/u, 'Ribbon follows title height and header width without obstructing controls');
  assert.match(css, /#bd635700 60%/u, 'Dawn ribbon ends around the description area, before the illustration');
  assert.match(css, /\[data-theme="star-night"\] \.archiver-json-heading h1 \{ color: var\(--cloudig-orange\);/u);
  assert.match(css, /\[data-theme="star-night"\] \.archiver-json-heading h1::before \{[^}]*#7e5eff00 60%/u);
  assert.match(css, /footer button \{[^}]*flex: none; width: auto;/u, 'English return copy sizes the button, not the reverse');
  assert.match(css, /:not\(\.archiver-parser-workspace\):not\(\.archiver-archive-workspace\)/u, 'Preserve the real backdrop planes behind the entry');
  assert.doesNotMatch(css, /\[data-json-group="agent"\][^}]*grid-template-rows: 42px auto/u, 'Agent cards keep room for filename, hint and action rows');
  assert.match(css, /platform-kimi-code\.svg[^}]*background: #000/u, 'Kimi Code white mark receives its black source field');
});
