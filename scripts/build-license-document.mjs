import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdown = new MarkdownIt({ html: false });
const hash = text => createHash('sha256').update(text).digest('hex');
const ids = ['preamble', 'grant', 'conditions', 'attribution', 'commercial', 'malicious', 'disclaimer', 'version'];

export function compileLicense(source, notice) {
  const dom = new JSDOM(markdown.render(source)), body = dom.window.document.body;
  const languageHeadings = [...body.querySelectorAll('h2')];
  assert.deepEqual(languageHeadings.map(n => n.textContent), ['中文文本', 'English Text']);
  const version = source.match(/版本 (\d+\.\d+) · (\d{4}-\d{2}-\d{2})/u);
  assert(version, 'License version/date missing');
  const languages = {};
  for (const [index, language] of ['zh-CN', 'en'].entries()) {
    const article = dom.window.document.createElement('article');
    for (let node = languageHeadings[index].nextElementSibling; node && node !== languageHeadings[index + 1]; node = node.nextElementSibling) {
      if (node.tagName !== 'HR') article.append(node.cloneNode(true));
    }
    const headings = [...article.querySelectorAll('h3,h4')];
    assert.equal(headings.length, ids.length, 'License heading structure changed; review the publication');
    const sections = headings.map((node, i) => {
      node.id = `license-${ids[i]}`;
      return { id: node.id, label: node.textContent, rank: node.tagName === 'H3' ? 2 : 3, value: 'core' };
    });
    const opening = article.querySelector('p');
    opening.className = 'license-opening';
    languages[language] = { html: article.innerHTML, sections };
  }
  const titles = [...body.querySelectorAll('h1')].map(n => n.textContent);
  const copyright = source.match(/^版权所有 (.+)$/mu)?.[1];
  assert(copyright, 'License copyright missing');
  dom.window.close();
  return { format: 'cloudig/license-publication/1', id: `JOG-${version[1]}`, version: version[1], date: version[2], titles, copyright,
    source_sha256: hash(source), full_text: source, languages, notice: { source_sha256: hash(notice), html: markdown.render(notice), full_text: notice } };
}

export async function licensePublication() {
  return compileLicense(await readFile(path.join(root, 'LICENSE'), 'utf8'), await readFile(path.join(root, 'NOTICE.md'), 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(root, 'src/ui/shell/pages/document/content/license.json');
  const output = JSON.stringify(await licensePublication()) + '\n';
  if (process.argv.includes('--check')) assert.equal(await readFile(file, 'utf8'), output, 'Rebuild LICENSE publication');
  else await writeFile(file, output);
  console.log(`${process.argv.includes('--check') ? 'checked' : 'built'} LICENSE: unchanged bilingual original and NOTICE`);
}
