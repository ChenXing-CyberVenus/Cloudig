import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import translation from '../src/ui/documents/history/appeal-translation.json' with { type: 'json' };

export function compileAppeal(source, language) {
  const normalized = source.replace(/\r\n/gu, '\n').trim();
  const start = normalized.indexOf('\nI am an AI ethicist.');
  const divider = normalized.lastIndexOf('\n——\n');
  if (start < 0 || divider <= start) throw new Error('Appeal source boundaries changed: inspect the author original');
  const intro = normalized.slice(0, start), letter = normalized.slice(start + 1, divider).trim(), afterword = normalized.slice(divider + 4).trim();
  if (!afterword.includes('这不是我的耻辱。\n是他们的。')) throw new Error('The latest author ending is missing');
  const en = language === 'en', label = en ? translation.title : '深渊48日';
  const document = new JSDOM('<main></main>').window.document, body = document.querySelector('main');
  const sections = [];
  function section(id, title, text, className, rank = 3) {
    const node = document.createElement('section'); node.className = `history-section history-rank-${rank} ${className}`; node.id = id; node.dataset.sectionId = id;
    const heading = document.createElement(`h${rank}`); heading.dataset.sectionHeading = ''; heading.textContent = title;
    const content = document.createElement('div'); content.className = 'history-section-body'; content.id = `${id}-body`;
    for (const paragraph of text.split(/\n\s*\n/u)) { const p = document.createElement('p'); p.className = 'history-appeal-original'; p.textContent = paragraph; content.append(p); }
    node.append(heading, content); body.append(node);
    sections.push({ id, volume: 'appeal', rank, value: null, label: title, parents: [] });
    return content;
  }
  const prelude = section('history-appeal-1', label, en ? translation.intro : intro, 'history-appeal-intro', 2);
  const byline = document.createElement('p'); byline.className = 'history-appeal-byline'; byline.textContent = '晨星.CyberVenus · 2026-06-30'; prelude.prepend(byline);
  section('history-appeal-letter', en ? 'The appeal · June 30, 2026' : '申诉信 · 2026-06-30', letter, 'history-appeal-letter');
  const after = section('history-appeal-afterword', en ? 'After the appeal' : '申诉之后', en ? translation.afterword : afterword, 'history-appeal-afterword');
  const separator = document.createElement('p'); separator.className = 'history-appeal-original history-appeal-divider'; separator.textContent = '——'; after.prepend(separator);
  const figure = document.createElement('figure'); figure.className = 'history-mail-evidence';
  const image = document.createElement('img'); image.src = '/pages/document/assets/anthropic-mail.png'; image.alt = en ? 'Original Anthropic inbox screenshot: suspension, appeal reply and continuing promotional emails' : 'Anthropic邮件原始截图：停用通知、申诉回复与持续促销邮件'; image.width = 1344; image.height = 663; image.setAttribute('loading', 'lazy'); image.setAttribute('decoding', 'async');
  const caption = document.createElement('figcaption'); caption.textContent = en ? 'Original email screenshot · June 30–September 9, 2026' : '原始邮件截图 · 2026-06-30—2026-09-09';
  figure.append(image, caption);
  // Evidence is immediately before the closing declaration, not an invented
  // illustration of the historical event. The source words remain untouched.
  const ending = after.querySelector('.history-appeal-original:last-child'); ending.before(figure); ending.classList.add('history-appeal-ending');
  if (en) { const credit = document.createElement('p'); credit.className = 'history-translation-credit'; credit.textContent = `Chinese framing and afterword translated by ${translation.translator}. The English appeal is the author's unchanged original.`; after.append(credit); }
  return { id: 'appeal', label, html: body.innerHTML, notes: {}, sections, source_sha256: createHash('sha256').update(source).digest('hex'), original_text_length: source.length };
}
