import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = new MarkdownIt({ html: true });
export function bookmarkDocumentText(source, topic, language) {
  // Publication must not rewrite prose. Approved wording lives in the source.
  return source;
}
export function assertBookmarkAuthorText(source, author) {
  const dom = new JSDOM(md.render(source));
  try {
    const body = dom.window.document.body;
    const directory = body.querySelector('table');
    const platforms = author.match(/^支持的平台：\r?\n([^\r\n]+)/mu)?.[1];
    assert(platforms, 'Author platform list missing');
    assert.deepEqual([...directory.querySelectorAll('tbody tr')].map(row => row.firstElementChild.textContent), platforms.replace(/。$/u, '').split('、'));
    directory.remove(); // The author explicitly requested official website links.
    for (const img of body.querySelectorAll('img')) img.remove();
    const approved = author.replace(/\r\n/gu, '\n')
      .replace(platforms, '').replace('（附上官网地址）', '')
      .replace(/^图：G:\\GPT截图\\阅读器美术素材\\功能文档截图\\$/mu, '')
      .replace(/^手动安装书签示意图-0[12]\.png$/gmu, '')
      .replace('"平台范例入口"', '平台范例入口')
      .replace('左侧选择档位，可多选。', '在左侧选择一个档位。需要多个档位时，分别选择并增量安装。')
      .replace(/^\s*\d+[.）]\s*/gmu, '').replace(/^-\s*/gmu, '')
      .replace(/^\|[-|]+\|$/gmu, '').replace(/\|/gu, '');
    const compact = value => value.replace(/\s/gu, '');
    assert.equal(compact(body.textContent), compact(approved), 'Bookmark guide prose differs from ChenXing\'s approved text');
  } finally { dom.window.close(); }
}
export function compileBookmarkDocument(source, topic, language) {
  const dom = new JSDOM(md.render(bookmarkDocumentText(source, topic, language))), body = dom.window.document.body;
  const title = body.querySelector('h1').textContent; body.querySelector('h1').remove();
  const sections = []; let section;
  for (const node of [...body.children]) {
    if (!section || node.tagName === 'H2') {
      const i = sections.length, label = node.tagName === 'H2' ? node.textContent : (language === 'en' ? 'Overview' : '概览');
      const quickStart = topic === 'bookmark' && /^(极简使用方法|The Shortest Possible Guide)[：:]?$/u.test(label);
      const value = /^(本文档作者|Authors of This Document)$/u.test(label) ? 'fold' : /美元|Dollars|原站|Original-Site/u.test(label) ? 'important' : i === 0 || quickStart ? 'core' : topic === 'bookmark' ? (/联系|Contact/u.test(label) ? 'general' : 'important') : 'general';
      section = { id: `${topic}-section-${i}`, label, value, html: '' }; sections.push(section);
    }
    if (node.tagName === 'H2') continue;
    section.html += node.outerHTML;
  }
  for (const section of sections) {
    const fragment = new JSDOM(section.html), doc = fragment.window.document;
    if (topic === 'bookmark' && section.id === 'bookmark-section-0') {
      const table = doc.querySelector('table');
      assert.equal(table?.querySelectorAll('tbody tr').length, 12, 'Official platform directory changed');
      const disclosure = doc.createElement('details'); disclosure.className = 'bookmark-platform-directory'; disclosure.dataset.platformDirectory = '';
      const summary = doc.createElement('summary');
      summary.innerHTML = `<span>${language === 'en' ? 'Platforms · Official conversation sites' : '平台 · 官方会话网址'}</span><span class="bookmark-directory-arrow" aria-hidden="true">⌄</span>`;
      const scroll = doc.createElement('div'); scroll.className = 'bookmark-platform-table'; scroll.dataset.scrollRegion = ''; scroll.tabIndex = 0;
      table.replaceWith(disclosure); scroll.append(table); disclosure.append(summary, scroll);
    }
    for (const img of doc.querySelectorAll('img')) { assert(img.src.startsWith('assets/bookmark-guide/')); img.setAttribute('src', `/pages/document/${img.getAttribute('src')}`); img.setAttribute('loading', 'lazy'); }
    for (const a of doc.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      if (href.startsWith('examples/')) { a.dataset.exampleFile = decodeURIComponent(href.slice(9)); a.setAttribute('href', '#platform-catalog'); a.removeAttribute('target'); }
      if (href.startsWith('cloudig:')) { a.dataset.documentTarget = href.slice(8); a.setAttribute('href', '#'); }
    }
    section.html = doc.body.innerHTML; fragment.window.close();
  }
  dom.window.close();
  return { format: 'cloudig/bookmark-publication/1', topic, language, title, source_sha256: createHash('sha256').update(source).digest('hex'), sections };
}
export async function bookmarkPublications(check = false) {
  for (const [topic, dir] of [['bookmark', 'bookmarks'], ['platforms', 'examples']]) for (const language of ['zh-CN', 'en']) {
    const source = await readFile(path.join(root, `src/ui/documents/${dir}/${language}.md`), 'utf8');
    if (topic === 'bookmark' && language === 'zh-CN') assertBookmarkAuthorText(source, await readFile(path.join(root, 'src/ui/documents/bookmarks/author-zh-CN.txt'), 'utf8'));
    const output = JSON.stringify(compileBookmarkDocument(source, topic, language)) + '\n';
    const file = path.join(root, `src/ui/shell/pages/document/content/${topic}-${language}.json`);
    if (check) assert.equal(await readFile(file, 'utf8'), output, `Rebuild ${topic}/${language}`); else await writeFile(file, output);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await bookmarkPublications(process.argv.includes('--check')); console.log('Bookmark guide and platform documents checked/built'); }
