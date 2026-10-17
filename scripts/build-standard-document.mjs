import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { JSDOM } from 'jsdom';
import emphasis from '../src/ui/documents/standard/emphasis.json' with { type: 'json' };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repository, 'src/ui/documents/standard');
const outputRoot = path.join(repository, 'src/ui/shell/pages/document/content');
const levels = { '核心': 'core', '重要': 'important', '常规': 'general', '折叠': 'fold', Core: 'core', Important: 'important', General: 'general', Fold: 'fold' };
const marker = /〔(核心|重要|常规|折叠|Core|Important|General|Fold)〕/u;
const slug = text => text.replace(marker, '').trim().replace(/\s+/gu, '-');
const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });

// User-approved layout corrections to the signed introduction. Do not rewrite
// the source Markdown, schema examples or later technical chapters.
export function formatStandardOverview(main, language) {
  const document = main.ownerDocument, en = language === 'en';
  const find = (selector, prefix) => {
    const matches = [...main.querySelectorAll(selector)].filter(n => n.textContent.startsWith(prefix));
    if (matches.length !== 1) throw new Error(`Standard introduction changed: ${prefix}`);
    return matches[0];
  };
  const mark = (node, phrase) => {
    const walker = document.createTreeWalker(node, 4); let text;
    while (walker.nextNode()) {
      if (walker.currentNode.parentElement.closest('strong')) continue;
      if (walker.currentNode.textContent.includes(phrase)) { text = walker.currentNode; break; }
    }
    if (!text) throw new Error(`Missing introduction concept: ${phrase}`);
    const part = text.splitText(text.textContent.indexOf(phrase)); part.splitText(phrase.length);
    const strong = document.createElement('strong'); strong.className = 'standard-emphasis-accent'; strong.textContent = phrase; part.replaceWith(strong);
  };
  const lineBreak = (node, ...nextSentences) => {
    let content = node.textContent; const parts = [];
    if (node.children.length) throw new Error(`Unexpected introduction paragraph: ${content}`);
    for (const nextSentence of nextSentences) {
      const at = content.indexOf(nextSentence);
      if (at < 1) throw new Error(`Unexpected introduction paragraph: ${nextSentence}`);
      parts.push(content.slice(0, at).trimEnd(), document.createElement('br')); content = content.slice(at);
    }
    node.replaceChildren(...parts, content);
  };
  const nodes = find('p', en ? 'Identity, time, conversation, mark and narrative are all nodes.' : '身份、时间、对话、标记和叙事，都是节点。');
  lineBreak(nodes, en ? 'The mappings between nodes' : '节点之间的映射', en ? 'The Ordinal is attention' : '序数是注意力'); nodes.dataset.standardFlow = 'nodes';
  for (const term of en ? ['The Earth calendar axis', 'Anchors'] : ['地球公历时间轴历法', '锚点']) mark(find('li', `${term}${en ? ':' : '：'}`), term);
  const presets = find('p', en ? 'Preset Terran timelines:' : '预设此地时间轴：');
  presets.textContent = presets.textContent.replace(/[:：]$/u, '');
  const presetName = document.createElement('strong'); presetName.textContent = presets.textContent; presets.replaceChildren(presetName); presets.dataset.standardFlow = 'presets';

  const first = find('li', en ? 'A timeline has a name, an author and a version number.' : '时间轴：名称、作者、版本号。');
  const list = first.parentElement, items = [...list.children].map(n => n.textContent);
  if (list.tagName !== 'UL' || items.length !== 6) throw new Error('Sovereign introduction list changed');
  const split = items[0].indexOf(en ? 'A time has' : '时间：');
  if (split < 1) throw new Error('Sovereign time definitions changed');
  const group = document.createElement('div'); group.className = 'standard-sovereign-overview'; group.dataset.standardLayout = 'sovereign';
  const pair = (lines, terms, kind) => {
    const ul = document.createElement('ul'); ul.dataset.standardPair = kind;
    lines.forEach((line, i) => { const li = document.createElement('li'); li.textContent = line; mark(li, terms[i]); ul.append(li); });
    group.append(ul);
  };
  const paragraph = text => { const p = document.createElement('p'); p.textContent = text; group.append(p); return p; };
  pair([items[0].slice(0, split).trimEnd(), items[0].slice(split)], en ? ['A timeline', 'A time'] : ['时间轴', '时间'], 'nodes');
  mark(paragraph(items[1]), en ? 'both nodes' : '都是节点');
  pair(items.slice(2, 4), en ? ['Expand', 'Counterpart'] : ['展开', '对映'], 'relations');
  const spectrum = paragraph(items[4]);
  for (const term of en ? ['expansion in time', 'counterpart in time', 'two ends of one spectrum'] : ['时间展开', '时间对映', '光谱两端']) mark(spectrum, term);
  const boundary = paragraph(items[5]);
  lineBreak(boundary, en ? 'Cloudig places no constraint' : '采云不约束');
  const strong = document.createElement('strong'); strong.append(...boundary.childNodes); boundary.append(strong); boundary.className = 'standard-time-boundary';
  list.replaceWith(group);

  const identity = find('p', en ? 'Basic concepts: Subject, Front' : '基本概念：视角 Subject');
  lineBreak(identity, en ? 'The Subject is' : '其中，视角是'); identity.dataset.standardFlow = 'identity';
  for (const term of en ? ['Subject', 'Front', 'NarrativeRelation', 'Interweave', 'Relation'] : ['视角 Subject', '呈现 Front', '叙事关系 NarrativeRelation', '伴生 Interweave', '关系 Relation']) mark(identity, term);
}

// The signed CN source uses [n] prose notes; EN uses [^n]: definitions.
// Adapt both only in the publication layer, retaining their inline markup.
export function formatStandardFootnotes(main, language) {
  const document = main.ownerDocument, notes = new Map(), groups = new Map();
  for (const paragraph of [...main.querySelectorAll('p')]) {
    if (!/^\[\^?\d+\]:?\s/u.test(paragraph.textContent)) continue;
    const parts = paragraph.innerHTML.split(/\n(?=\[\^?\d+\]:?\s)/u);
    const body = paragraph.parentElement;
    let group = groups.get(body);
    if (!group) {
      group = document.createElement('aside');
      group.className = 'standard-footnotes';
      group.setAttribute('role', 'doc-endnotes');
      group.setAttribute('aria-label', language === 'en' ? 'Section notes' : '本节注释');
      group.append(document.createElement('ol'));
      groups.set(body, group);
    }
    for (const part of parts) {
      const match = /^\[\^?(\d+)\]:?\s+([\s\S]*)$/u.exec(part);
      if (!match || notes.has(match[1])) throw new Error('Invalid or duplicate Standard footnote');
      const number = match[1], note = document.createElement('li');
      note.className = 'standard-footnote'; note.id = `standard-note-${number}`;
      note.innerHTML = `<span class="standard-footnote-number">${number}.</span><div class="standard-footnote-copy">${match[2]}</div><span class="standard-footnote-returns"></span>`;
      group.firstElementChild.append(note);
      notes.set(number, { note, references: [] });
    }
    paragraph.remove();
  }
  const walker = document.createTreeWalker(main, 4), textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const text of textNodes) {
    if (text.parentElement.closest('pre, code, a')) continue;
    const matches = [...text.textContent.matchAll(/\[\^?(\d+)\]/gu)].filter(match => notes.has(match[1]));
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(text.textContent.slice(offset, match.index));
      const record = notes.get(match[1]), reference = document.createElement('sup');
      const id = `standard-note-ref-${match[1]}-${record.references.length + 1}`;
      reference.className = 'standard-note-reference'; reference.dataset.sourceMarker = match[0];
      const link = document.createElement('a'); link.id = id; link.href = `#${record.note.id}`;
      link.setAttribute('role', 'doc-noteref');
      link.setAttribute('aria-label', `${language === 'en' ? 'Note' : '注释'} ${match[1]}`);
      link.textContent = match[1]; reference.append(link); fragment.append(reference);
      record.references.push(id); offset = match.index + match[0].length;
    }
    fragment.append(text.textContent.slice(offset)); text.replaceWith(fragment);
  }
  for (const [number, record] of notes) {
    if (!record.references.length) throw new Error(`Unreferenced Standard footnote: ${number}`);
    for (const [index, id] of record.references.entries()) {
      const back = document.createElement('a'); back.href = `#${id}`; back.setAttribute('role', 'doc-backlink');
      back.setAttribute('aria-label', language === 'en' ? `Return to note ${number} reference ${index + 1}` : `返回注释${number}的第${index + 1}处引用`);
      back.textContent = record.references.length === 1 ? '↩' : `↩${index + 1}`;
      record.note.querySelector('.standard-footnote-returns').append(back);
    }
  }
  for (const [body, group] of groups) body.append(group);
}

// One section owns the content through the next heading of equal/lower rank.
// Information value remains data, not a colour or a naming convention.
export function compileStandard(source, language) {
  const document = new JSDOM(`<main>${markdown.render(source)}</main>`).window.document;
  const main = document.querySelector('main');
  const originalText = main.textContent;
  const title = main.querySelector('h1').textContent;
  // The author uses six standalone bold paragraphs as concept subheadings.
  // Identify them before adding editorial emphasis; ordinary bold text is not
  // another heading, and the source hierarchy/value levels remain unchanged.
  for (const paragraph of main.querySelectorAll('p')) {
    if (paragraph.children.length === 1 && paragraph.firstElementChild.tagName === 'STRONG'
      && paragraph.textContent.trim() === paragraph.firstElementChild.textContent.trim()) {
      paragraph.classList.add('standard-concept-heading');
    }
  }
  // An explicitly curated presentation layer, never a rewrite of the signed
  // Markdown originals, value classifications, code examples or field tables.
  formatStandardOverview(main, language);
  for (const [style, phrases] of Object.entries(emphasis[language])) {
    for (const phrase of phrases) {
      let matches = 0;
      const walker = document.createTreeWalker(main, 4);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const text of textNodes) {
        const parent = text.parentElement;
        if (!parent.closest('p, li') || parent.closest('pre, code, table, strong, a')) continue;
        const index = text.textContent.indexOf(phrase);
        if (index < 0) continue;
        const marked = document.createElement('strong');
        marked.className = `standard-emphasis-${style}`;
        marked.textContent = phrase;
        const remainder = text.splitText(index);
        remainder.splitText(phrase.length);
        remainder.replaceWith(marked);
        matches++;
      }
      if (!matches) throw new Error(`Missing editorial emphasis (${language}): ${phrase}`);
    }
  }
  main.querySelector('h1').remove();
  // The opening legend and TOC are represented once in the page's controls.
  main.firstElementChild.remove();
  const tocSource = main.querySelector(':scope > ul');
  tocSource.remove();
  const stack = [], toc = [];
  let serial = 0;
  for (const node of [...main.childNodes]) {
    if (node.nodeType === 1 && /^H[23]$/u.test(node.tagName)) {
      const rank = Number(node.tagName[1]);
      while (stack.length && stack.at(-1).rank >= rank) stack.pop();
      const text = node.textContent;
      const level = levels[text.match(marker)?.[1]] ?? stack.at(-1)?.level ?? (serial === 0 ? 'core' : 'general');
      const id = `standard-${++serial}`;
      const section = document.createElement('section');
      section.className = `standard-section standard-level-${rank}`;
      section.dataset.infovalue = level;
      section.dataset.sectionId = id;
      section.id = id;
      const anchor = slug(text);
      const original = document.createElement('span');
      original.id = anchor;
      original.className = 'standard-anchor';
      node.prepend(original);
      node.dataset.sectionHeading = '';
      const body = document.createElement('div');
      body.className = 'standard-section-body';
      body.id = `${id}-body`;
      section.append(node, body);
      (stack.at(-1)?.body ?? main).append(section);
      stack.push({ rank, body, level });
      if (rank === 2) toc.push({ id, title: text.replace(marker, '').trim(), level });
    } else if (stack.length) stack.at(-1).body.append(node);
  }
  for (const details of main.querySelectorAll('details')) {
    details.dataset.infovalue = 'fold';
    details.dataset.sectionId = `standard-detail-${++serial}`;
    details.removeAttribute('open');
  }
  for (const table of main.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'standard-table-scroll';
    wrap.setAttribute('data-scroll-region', '');
    wrap.tabIndex = 0;
    table.replaceWith(wrap); wrap.append(table);
  }
  for (const pre of main.querySelectorAll('pre')) { pre.dataset.scrollRegion = ''; pre.tabIndex = 0; }
  // Resolve source TOC links against the real heading IDs, rather than relying
  // on a renderer-specific Markdown slug algorithm.
  for (const link of main.querySelectorAll('a[href^="#"]')) {
    const target = decodeURIComponent(link.getAttribute('href').slice(1));
    const element = document.getElementById(target);
    if (element) link.setAttribute('href', `#${element.closest('section')?.id ?? element.id}`);
  }
  formatStandardFootnotes(main, language);
  if (main.querySelector('script, iframe, style, link, object') || [...main.querySelectorAll('*')].some(el => [...el.attributes].some(a => /^on/iu.test(a.name)))) throw new Error('Unexpected active document markup');
  return { format: 'cloudig/standard-publication/1', language, title, source_sha256: createHash('sha256').update(source).digest('hex'), toc, html: main.innerHTML, original_text_length: originalText.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  await mkdir(outputRoot, { recursive: true });
  for (const language of ['zh-CN', 'en']) {
    const source = await readFile(path.join(sourceRoot, `${language}.md`), 'utf8');
    const output = `${JSON.stringify(compileStandard(source, language))}\n`;
    const target = path.join(outputRoot, `standard-${language}.json`);
    if (check) {
      if (await readFile(target, 'utf8') !== output) throw new Error(`Document drift: ${language}`);
    } else await writeFile(target, output);
    console.log(`${check ? 'checked' : 'built'} standard ${language}`);
  }
}
