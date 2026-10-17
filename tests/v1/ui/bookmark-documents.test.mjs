import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { bookmarkPublications, compileBookmarkDocument, assertBookmarkAuthorText, bookmarkDocumentText } from '../../../scripts/build-bookmark-documents.mjs';
import { mountBookmarkDocument } from '../../../src/ui/shell/pages/document/bookmarks.js';

test('bilingual guide derivatives keep six pictures and author-approved prose without compiler rewriting', async () => {
  await bookmarkPublications(true);
  for (const language of ['zh-CN','en']) {
    const source = await readFile(`src/ui/documents/bookmarks/${language}.md`, 'utf8');
    const output = compileBookmarkDocument(source, 'bookmark', language);
    assert.equal(bookmarkDocumentText(source, 'bookmark', language), source);
    assert.equal(output.sections.length, 9);
    assert.equal(output.sections.find(s => s.label === (language === 'en' ? 'The Shortest Possible Guide:' : '极简使用方法：')).value, 'core');
    const dom = new JSDOM(output.sections.map(s => s.html).join(''));
    assert.equal(dom.window.document.querySelectorAll('img').length, 6);
    assert.equal(dom.window.document.querySelectorAll('[data-document-target=platforms]').length, 1);
    const directory = dom.window.document.querySelector('[data-platform-directory]');
    assert(directory); assert.equal(directory.open, false); assert.equal(directory.querySelectorAll('tbody tr').length, 12);
    assert.equal(directory.querySelectorAll('a[href^="https://"]').length, 12);
    assert.doesNotMatch(dom.window.document.body.textContent, /本文档作者|终稿：|Authors of This Document|Osis.ClearWordsCarryCloud|Osis.FuckTheFourthWall/u);
    assert.doesNotMatch(dom.window.document.body.textContent, /可以多选|one or more profiles|整理中|being organized/u);
    dom.window.close();
  }
});

test('ChenXing text equality gate rejects expansion, softened requirements and changed retry advice', async () => {
  const source = await readFile('src/ui/documents/bookmarks/zh-CN.md', 'utf8');
  const author = await readFile('src/ui/documents/bookmarks/author-zh-CN.txt', 'utf8');
  assertBookmarkAuthorText(source, author);
  for (const changed of [
    source.replace('原始图片与完整附件', '原始图片与能够取得的完整附件'),
    source.replace('请附：', '请尽量附上：'),
    source.replace('按需选择书签版本再次下载文件', '按需换用全量或整树重新下载'),
    `${source}\n请放心使用采云。\n`,
  ]) assert.throws(() => assertBookmarkAuthorText(changed, author), /differs from ChenXing/u);
});

test('guide official-directory disclosure is independent and keeps its open state across language changes', async () => {
  const dom = new JSDOM('<section data-page="reader"><main class="reader-main"></main></section>');
  const prior = {document:globalThis.document,fetch:globalThis.fetch}; globalThis.document = dom.window.document;
  globalThis.fetch = async url => ({ok:true,json:async()=>JSON.parse(await readFile(`src/ui/shell${url}`, 'utf8'))});
  try {
    const view = await mountBookmarkDocument({page:document.querySelector('section'),topic:'bookmark',language:'zh-CN'});
    const quickStart = () => view.element.querySelector('#bookmark-section-1');
    assert.equal(quickStart().dataset.infovalue, 'core');
    assert.match(quickStart().querySelector('h2 img').src, /InfoValue-Core\.svg$/u);
    view.element.querySelector('[data-standard-menu=important]').click();
    assert.equal(quickStart().querySelector('.standard-section-body').hidden, false, 'folding Important must not hide the essential guide');
    view.element.querySelector('[data-standard-menu=core]').click();
    assert.equal(quickStart().querySelector('.standard-section-body').hidden, true);
    view.element.querySelector('[data-standard-menu=core]').click();
    let directory = view.element.querySelector('[data-platform-directory]'); assert.equal(directory.open,false);
    directory.querySelector('summary').click(); assert.equal(directory.open,true);
    view.updateLanguage('en'); directory=view.element.querySelector('[data-platform-directory]'); assert.equal(directory.open,true);
    assert.equal(view.element.querySelectorAll('.standard-prose img[src*=bookmark-guide]').length,6);
    directory.querySelector('summary').click(); assert.equal(directory.open,false);
    view.updateLanguage('zh-CN'); assert.equal(view.element.querySelector('[data-platform-directory]').open,false);
    view.close();
  } finally {Object.assign(globalThis,prior);dom.window.close();}
});

test('both sidebars place platform examples after Features and keep Standard beside History', async () => {
  const dom = new JSDOM(await readFile('src/ui/shell/index.html', 'utf8'));
  for (const [template, selector] of [['reader-cover-template','.reader-doc-content'], ['archiver-template','.archiver-doc-card']]) {
    const content = dom.window.document.getElementById(template).content;
    assert.deepEqual([...content.querySelectorAll(`${selector} [data-doc-topic]`)].map(n => n.dataset.docTopic), ['bookmark','archive','platforms','json','roadmap','license']);
  }
  dom.window.close();
});

test('both central hosts use real catalogue IDs, preserve selection/scroll, fold and return without loading HTML', async () => {
  const dom = new JSDOM('<section data-page="reader"><main class="reader-main"><p>original</p></main></section>');
  const prior = {document:globalThis.document,fetch:globalThis.fetch};
  globalThis.document = dom.window.document;
  const requested = [];
  globalThis.fetch = async url => { requested.push(url); return {ok:true,json:async()=>JSON.parse(await readFile(`src/ui/shell${url}`, 'utf8'))}; };
  const tick = () => new Promise(r => setTimeout(r,0));
  try {
    for (const host of ['reader-main','archiver-center']) {
      const page = document.querySelector('section'), center = page.firstElementChild; center.className = host;
      let next = null, view; const opened = [];
      view = await mountBookmarkDocument({page,topic:'platforms',language:'zh-CN',onClose:()=>view.close(),onDemo:()=>{throw Error('Desktop must not load local examples');},onExternal:async url=>{opened.push(url);},onError:e=>{throw e;},onDocument:t=>{next=t;}});
      const el = view.element;
      assert.equal(el.parentElement,center);
      assert.equal(el.querySelectorAll('[data-example-platform]').length,12);
      el.querySelector('[data-example-platform=claude]').click();
      el.querySelector('[data-example-scenario=Cowork]').click();
      assert(el.querySelector('[data-example-profile=tree]').disabled);
      el.querySelector('[data-example-profile=full]').click();
      el.querySelector('.standard-scroll').scrollTop=432;
      el.querySelector('[data-example-online]').click(); await tick();
      assert.match(opened[0], new RegExp(`#platforms/${view.snapshot().example}/view$`));
      assert.equal(view.snapshot().scroll,432); assert.equal(el.querySelector('[data-example-reader]'),null); assert.equal(el.querySelector('[data-example-chrome]'),null);
      el.querySelector('[data-example-html-download]').click(); await tick(); assert.match(opened[1], /\/download-html$/u);
      el.querySelector('[data-example-record]').click(); await tick(); assert.match(opened[2], /\/download-json$/u);
      assert.equal(el.querySelectorAll('.example-downloads small').length,2); assert.match(el.querySelector('.example-pair-note').textContent,/联网/u);
      view.updateLanguage('en'); assert.equal(el.querySelector('[data-example-profile=full]').getAttribute('aria-pressed'),'true');
      assert.match(el.querySelector('.example-readonly').textContent,/does not include example files/u);
      el.querySelector('[data-standard-menu=general]').click(); assert(el.querySelector('#platform-catalog-body').hidden);
      el.querySelector('[data-standard-menu=all]').click(); el.querySelector('a[href="#platform-catalog"]').click(); assert(!el.querySelector('#platform-catalog-body').hidden);
      el.querySelector('[data-document-target=bookmark]').click(); assert.equal(next,'bookmark');
      const state = view.snapshot(); el.querySelector('.standard-return').click(); assert.equal(center.children.length,1);
      view = await mountBookmarkDocument({page,topic:'platforms',language:'en',restore:state}); assert.equal(view.snapshot().example,state.example); view.close();
    }
    assert(requested.every(url=>url.endsWith('.json')),'Original HTML must never be fetched into the WebView');
  } finally {Object.assign(globalThis,prior);dom.window.close();}
});
