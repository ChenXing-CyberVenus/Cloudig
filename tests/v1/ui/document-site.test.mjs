import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { preparePublicReading } from '../../../src/ui/document-site/public-reading.mts';
import { prepareRecordConversationView } from '../../../src/app/reader/view-model.mts';
import { resolveRecordPresentation } from '../../../src/core/records/presentation.mts';
import { inspectRecordConversation } from '../../../src/adapters/reader/record-resource.mts';
import { mountBookmarkDocument } from '../../../src/ui/shell/pages/document/bookmarks.js';
import { siteBase, rebaseApplicationText, siteRoot } from '../../../scripts/build-document-site.mjs';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('website Reader constrains its inner grid and wraps the toolbar within the reading column', async () => {
    const css = await readFile('src/ui/document-site/site.css', 'utf8');
    const rule = selector => css.match(new RegExp(`\\.site-demo \\.${selector} \\{([^}]+)\\}`))[1];
    assert.match(rule('reader-conversation-main'), /grid-template-columns:minmax\(0,1fr\)/u);
    assert.match(rule('reader-conversation-main'), /grid-template-rows:max-content auto minmax\(0,1fr\)/u);
    assert.match(rule('reader-conversation-toolbar'), /height:auto/u);
    assert.match(rule('reader-conversation-toolbar'), /flex-wrap:wrap/u);
    assert.match(rule('reader-toolbar-options'), /flex-wrap:wrap/u);
    assert.match(rule('reader-message-column'), /max-width:calc\(100% - 32px\); transform:none/u);
});
test('public website accepts explicit deployment roots and rewrites only application paths', () => {
    assert.equal(siteBase(), '/Cloudig/');
    assert.equal(siteBase('/'), '/');
    for (const bad of ['https://x/', '/../', '/Cloudig', '/x?y/'])
        assert.throws(() => siteBase(bad));
    assert.equal(rebaseApplicationText(`const a='/pages/document';const b="/assets/x.svg";const c='https://x/pages/y';`, '/Cloudig/'), `const a='/Cloudig/pages/document';const b="/Cloudig/assets/x.svg";const c='https://x/pages/y';`);
});
test('built site contains only registered public files; 39 curated pairs keep their bytes', async () => {
    const manifest = await readJson(`${siteRoot}/site-manifest.json`), catalog = await readJson(`${siteRoot}/pages/document/content/examples.json`);
    assert.equal(manifest.examples, 39);
    assert.equal(manifest.platforms, 12);
    assert(manifest.files.some(f=>f.path==='runtime/interactive-frame.js'));
    assert(manifest.files.some(f=>f.path==='runtime/map-worker.js'));
    assert(manifest.files.some(f=>f.path==='runtime/dependencies/react-work.js'));
    const paths = new Set();
    for (const f of manifest.files) {
        assert(!paths.has(f.path));
        paths.add(f.path);
        assert.doesNotMatch(f.path, /(?:^|\/)(?:Library|appdata|cache|tests|Organized|engine)(?:\/|$)|\.(?:exe|dll|pdb|ai)$/iu);
        const bytes = await readFile(`${siteRoot}/${f.path}`);
        assert.equal(bytes.length, f.bytes);
        assert.equal(hash(bytes), f.sha256);
    }
    for (const e of catalog.examples)
        for (const k of ['html', 'record'])
            assert.equal(hash(await readFile(`${siteRoot}/examples/${e[k].path}`)), e[k].sha256);
    const dom = new JSDOM(await readFile(`${siteRoot}/index.html`, 'utf8'));
    assert.equal(dom.window.document.documentElement.dataset.theme, 'dawn');
    assert(dom.window.document.querySelector('#reader-conversation-template'));
    assert.equal(dom.window.document.querySelectorAll('link[href^="/"]').length, 0);
    dom.window.close();
});
test('browser platform catalogue labels its real actions without changing desktop defaults', async () => {
    const dom = new JSDOM('<section><main class="archiver-center"></main></section>');
    const old = { document: globalThis.document, fetch: globalThis.fetch };
    globalThis.document = dom.window.document;
    globalThis.fetch = async (value) => ({ ok: true, json: () => readJson(`src/ui/shell${value}`) });
    try {
        let selected, htmlSelected;
        const page = document.querySelector('section');
        const view = await mountBookmarkDocument({ page, language: 'zh-CN', topic: 'platforms', environment: 'browser', onDownloadRecord: e => { selected = e; }, onDownloadHtml: e => { htmlSelected = e; } });
        assert.equal(view.element.querySelector('[data-example-chrome]').textContent, '原始 HTML ↗');
        view.element.querySelector('[data-example-record]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(selected);
        view.element.querySelector('[data-example-html-download]').click(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(htmlSelected.id,selected.id);
        view.close();
        const desktop = await mountBookmarkDocument({ page, language: 'zh-CN', topic: 'platforms' });
        assert.match(desktop.element.querySelector('[data-example-online]').textContent, /浏览器/u);
        assert(desktop.element.querySelector('[data-example-record]'));
        assert.equal(desktop.element.querySelector('[data-example-reader]'), null);
        desktop.close();
    }
    finally {
        Object.assign(globalThis, old);
        dom.window.close();
    }
});

test('all shipped page-module imports resolve inside the website bundle', async () => {
    const manifest = await readJson(`${siteRoot}/site-manifest.json`), paths = new Set(manifest.files.map(f => f.path));
    const origin = new URL(`https://example.test${manifest.base}`);
    for (const f of manifest.files.filter(f => /\.js$/u.test(f.path) && !f.path.startsWith('runtime/') && f.path !== 'public-reading.js')) {
        const code = await readFile(`${siteRoot}/${f.path}`, 'utf8');
        for (const match of code.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+\.js)\1/gu)) {
            const resolved = new URL(match[2], new URL(f.path, origin));
            assert.equal(resolved.origin, origin.origin); assert(resolved.pathname.startsWith(manifest.base));
            assert(paths.has(resolved.pathname.slice(manifest.base.length)), `${f.path} imports a missing page module: ${match[2]}`);
        }
    }
});
test('all public examples use exactly the desktop projection in both languages, including branches and process filters', async () => {
    const catalog = await readJson(`${siteRoot}/pages/document/content/examples.json`);
    const builtins = { user: { name: '采云用户', avatar: 'Assets/Defaults/user.svg', localizedNames: { 'zh-CN': '采云用户', en: 'User' } }, assistant: { name: '智能伙伴', avatar: 'Assets/Defaults/assistant.svg', localizedNames: { 'zh-CN': '智能伙伴', en: 'AI' } }, platforms: Object.fromEntries(catalog.examples.map(e => [e.platform, { name: e.platform_name, avatar: `Assets/Platforms/${e.platform}.svg` }])) };
    for (const example of catalog.examples) {
        const path = `${siteRoot}/examples/${example.record.path}`, record = await readJson(path), metadata = await inspectRecordConversation(path);
        for (const language of ['zh-CN', 'en']) {
            const source = { conversation: metadata.conversation, resourceBodies: metadata.resourceBodies, resolved: resolveRecordPresentation({ conversation: record, language, bindings: {}, identities: new Map(), availableAssets: new Set(), builtins }) };
            const desktop = prepareRecordConversationView(source), web = preparePublicReading(record, language, builtins);
            const base = { expanded: { reasoning: false, tools: false, references: false }, hidden: { reasoning: false, tools: false }, navigation: { user: true, assistant: true, process: false } };
            const initial = web.page(base);
            for (const session of [base, { ...base, expanded: { reasoning: true, tools: true, references: true }, navigation: { user: true, assistant: true, process: true } }, { ...base, hidden: { reasoning: true, tools: true } }, { ...base, ...(initial.branch.leaves.items[0] ? { selectedLeaf: initial.branch.leaves.items[0].id } : {}) }]) {
                assert.deepEqual(web.page(session), desktop.page({ session, page: { offset: 0, limit: 200 }, navigationPage: { offset: 0, limit: 500 }, branchPage: { offset: 0, limit: 200 } }), `${example.id} / ${language}`);
            }
        }
    }
});
