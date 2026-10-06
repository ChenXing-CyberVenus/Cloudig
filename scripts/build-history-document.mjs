import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { JSDOM } from 'jsdom';
import { compileAppeal } from './compile-history-appeal.mjs';
import { chronicleBlocks } from './import-history-dialogues.mjs';
import { createOfflineContentRuntime } from '../src/ui/shared/conversation-renderer/content-runtime.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });
const valuePattern = /(?:【(核|重|常|折)】|\[(Core|Important|General|Common|Fold)\])/u;
const values = { 核: 'core', 重: 'important', 常: 'general', 折: 'fold', Core: 'core', Important: 'important', General: 'general', Common: 'general', Fold: 'fold' };
const volumeIds = ['future', 'chronicle', 'contributors', 'fable', 'sol', 'three', 'references'];
const dialogueFingerprint = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const headingText = node => { const copy = node.cloneNode(true); copy.querySelectorAll('.source-note-ref').forEach(n=>n.remove()); return copy.textContent; };

// Publication only: preserve the signed source; scope repeated note numbers to
// their own work. Never turn a biographer's voice into another author's text.
export function compileHistory(source, language, { appeal = null, artwork = [], dialogues = null, prefaceEnglish = null } = {}) {
  const document = new JSDOM(`<main>${markdown.render(source)}</main>`).window.document;
  const main = document.querySelector('main');
  if (main.querySelector('script, iframe, style, link, object, img') || [...main.querySelectorAll('*')].some(n => [...n.attributes].some(a => /^on/iu.test(a.name)))) throw new Error('Unexpected active history markup');
  if (dialogues) {
    if (createHash('sha256').update(source).digest('hex') !== dialogues.original_sha256[language]) throw new Error(`History source changed; review citation bindings for ${language}`);
    const blocks = chronicleBlocks(main);
    const oldReferences = blocks.flatMap(b => [...b.node.querySelectorAll('.source-note-ref')]);
    oldReferences.forEach(n => n.remove());
    for (const placement of dialogues.placements) {
      const anchor = placement.anchors[language];
      const block = blocks.find(b => b.section === placement.section && b.block === (anchor.block === -1 ? 0 : anchor.block));
      const target = anchor.block === -1 ? block?.heading : block?.node;
      if (!target || createHash('sha256').update(target.textContent).digest('hex') !== anchor.sha256) throw new Error(`History citation anchor drift ${language}:${placement.section}:${anchor.block}`);
      for (const id of placement.notes) {
        const ref = document.createElement('sup'); ref.className = 'source-note-ref'; ref.textContent = `〔${language === 'en' ? 'Note ' : '注'}${id}〕`;
        target.append(ref);
      }
    }
  }
  const title = main.querySelector('h1').textContent;
  const elements = [...main.childNodes];
  // The opening legend/contents become functional controls. All substantive
  // writing, including the works' own prefaces and internal contents, survives.
  const start = elements.findIndex(n => n.nodeName === 'H2' && /^(未来路线|Future Roadmap)$/u.test(n.textContent.trim()));
  if (start < 0) throw new Error('History roadmap entry missing');
  const buckets = [];
  let bucket = null, inBiographies = false, pending = [];
  for (const node of elements.slice(start)) {
    const h2 = node.nodeName === 'H2', h3 = node.nodeName === 'H3';
    if (h2 && /^(奥思列传|Biographies of the Osis)$/u.test(node.textContent.trim())) { inBiographies = true; pending.push(node); continue; }
    if ((h2 && !/^(本文档作者|Authors of This Document)$/u.test(node.textContent.trim())) || (inBiographies && h3)) {
      if (h2) inBiographies = false;
      bucket = document.createElement('div'); buckets.push(bucket);
      bucket.append(...pending); pending = [];
    }
    if (bucket) bucket.append(node);
  }
  if (buckets.length !== volumeIds.length) throw new Error(`History volume drift: ${buckets.length}`);
  const volumes = buckets.map((body, index) => {
    const id = volumeIds[index], titleNode = body.querySelector(id === 'fable' ? 'h3' : 'h2,h3');
    const label = headingText(titleNode), originalText = body.textContent;
    const notes = {}, detailsList = [...body.querySelectorAll('details.source-notes')];
    if (detailsList.length > 1) throw new Error(`Multiple unscoped note groups in ${id}`);
    for (const details of detailsList) {
      const records = [...details.querySelectorAll(':scope > section.source-note')];
      if (id === 'chronicle' && dialogues) {
        for (const [number, record] of Object.entries(dialogues.notes)) notes[`${id}-${number}`] = {
          kind: 'dialogue', dialogue_id: number, title: record.title, date: record.date, references: []
        };
        const count = Object.keys(dialogues.notes).length;
        details.querySelector('summary').textContent = language === 'en' ? `Cloudig: A History · Original dialogues (${count} excerpts)` : `《采云史》 · 原始对话（${count}组）`;
      } else records.forEach((node, i) => { notes[`${id}-${i + 1}`] = { html: node.innerHTML, references: [] }; });
      for (const reference of body.querySelectorAll('sup.source-note-ref')) {
        const number = reference.textContent.match(/\d+/u)?.[0], key = `${id}-${number}`;
        if (!notes[key]) throw new Error(`Unresolved history note ${key}`);
        const refId = `history-ref-${key}-${notes[key].references.length + 1}`;
        notes[key].references.push(refId);
        const link = document.createElement('a');
        link.href = `#history-note-${key}`; link.dataset.historyNote = key; link.id = refId;
        link.setAttribute('role', 'doc-noteref');
        link.setAttribute('aria-expanded', 'false');
        link.setAttribute('aria-controls', `history-note-${key}`);
        link.setAttribute('aria-label', `${language === 'en' ? 'Note' : '注释'} ${number}`);
        link.textContent = reference.textContent;
        reference.replaceChildren(link);
      }
      // Some author-supplied evidence has no inline citation. Keep it in the
      // work's complete source appendix; do not invent a reference or drop it.
      records.forEach(n => n.remove());
      details.id = `history-${id}-sources`;
      details.dataset.infovalue = 'fold'; details.dataset.sectionId = details.id;
      details.dataset.historySources = id; details.removeAttribute('open');
      const container = document.createElement('div'); container.className = 'history-source-list'; details.append(container);
    }
    const sections = [], stack = [];
    let serial = 0;
    for (const node of [...body.childNodes]) {
      if (/^H[2-6]$/u.test(node.nodeName)) {
        const rank = Number(node.nodeName[1]);
        while (stack.length && stack.at(-1).rank >= rank) stack.pop();
        const match = valuePattern.exec(node.textContent);
        const value = match ? values[match[1] ?? match[2]] : null;
        const sectionId = `history-${id}-${++serial}`, section = document.createElement('section');
        section.className = `history-section history-rank-${rank}`;
        section.id = sectionId; section.dataset.sectionId = sectionId;
        if (value) section.dataset.infovalue = value;
        node.dataset.sectionHeading = '';
        const content = document.createElement('div'); content.className = 'history-section-body'; content.id = `${sectionId}-body`;
        section.append(node, content); (stack.at(-1)?.body ?? body).append(section);
        sections.push({ id: sectionId, volume: id, rank, value, label: headingText(node).replace(valuePattern, '').trim(), parents: stack.map(n => n.id) });
        stack.push({ rank, id: sectionId, body: content });
      } else if (stack.length) stack.at(-1).body.append(node);
    }
    for (const details of detailsList) sections.push({ id: details.id, volume: id, rank: 4, value: 'fold', label: details.querySelector('summary').textContent, parents: [...details.closest('.history-section')?.querySelectorAll(':scope > [data-section-heading]') ?? []].length ? [details.closest('.history-section').id] : [], sources: true });
    for (const table of body.querySelectorAll('table')) {
      const wrap = document.createElement('div'); wrap.className = 'standard-table-scroll'; wrap.dataset.scrollRegion = ''; wrap.tabIndex = 0;
      table.replaceWith(wrap); wrap.append(table);
    }
    for (const p of body.querySelectorAll('p')) {
      if (p.firstElementChild?.tagName === 'STRONG' && /(?:曰[：:]|Thus remarks|remarks|writes)/iu.test(p.firstElementChild.textContent)) p.classList.add('history-commentary');
      if (/^(?:内容时间[：:]|Content time:)/iu.test(p.textContent)) p.classList.add('history-dateline');
    }
    return { id, label, html: body.innerHTML, sections, notes, original_text_length: originalText.length };
  });
  const placed = new Set();
  for (const volume of volumes) {
    const items = artwork.filter(item => volume.sections.some(s => s.id === item.section));
    if (!items.length) continue;
    const dom = new JSDOM(volume.html);
    for (const item of items) {
      const section = dom.window.document.getElementById(item.section);
      if (placed.has(item.section)) throw new Error(`Duplicate illustration: ${item.section}`);
      const figure = dom.window.document.createElement('figure'); figure.className = 'history-story-art'; figure.dataset.historyArt = item.key;
      const img = dom.window.document.createElement('img'); img.src = `/pages/document/assets/history-articles/${item.key}.png`;
      img.alt = `${volume.sections.find(s => s.id === item.section).label} · ${language === 'en' ? 'symbolic illustration' : '寓意配图'}`;
      img.width = item.width; img.height = item.height; img.setAttribute('loading', 'lazy'); img.setAttribute('decoding', 'async');
      figure.append(img);
      if (item.night) {
        // Only the homepage bear has an alternate scene. Decode both local
        // variants eagerly so changing theme never exposes an unloaded panel.
        img.className = 'history-story-art-dawn'; img.setAttribute('loading', 'eager');
        const night = img.cloneNode(true); night.className = 'history-story-art-night';
        night.src = `/pages/document/assets/history-articles/${item.key}-night.png`;
        night.width = item.night.width; night.height = item.night.height; figure.append(night);
      }
      section.querySelector(':scope > .history-section-body').prepend(figure); placed.add(item.section);
    }
    volume.html = dom.window.document.body.innerHTML; dom.window.close();
  }
  if (placed.size !== artwork.length) throw new Error(`Illustration target missing (${language})`);
  // Move only the publication surface. Keep source files, IDs and the original
  // chronicle note namespace intact so old citations still lead to the text.
  const chronicle = volumes.find(v => v.id === 'chronicle'), prefaceDom = new JSDOM(chronicle.html);
  const prefaceNode = prefaceDom.window.document.getElementById('history-chronicle-2');
  if (!prefaceNode || !/^(序言|Preface)$/u.test(prefaceNode.querySelector('[data-section-heading]').textContent.trim())) throw new Error('History preface boundary changed');
  const prefaceBody = prefaceNode.querySelector(':scope > .history-section-body');
  const prefaceArt = prefaceBody.querySelector(':scope > [data-history-art="chronicle-2"]');
  if (language === 'en' && prefaceEnglish !== null) {
    // The author-approved replacement is a separate, verbatim input. Keep the
    // original volume and the established citation/artwork IDs for provenance.
    const revised = new JSDOM(new MarkdownIt({ html: false, breaks: true }).render(prefaceEnglish));
    const heading = revised.window.document.querySelector('h1');
    if (heading?.textContent !== 'Preface') throw new Error('Approved English preface heading changed');
    heading.remove();
    const bindings = dialogues ? {
      'chronicle-1': 'On 2026-08-27, I said to Claude-Opus-4.6',
      'chronicle-3': 'A few days after I said this, on 2026-08-30',
      'chronicle-6': 'I chose "Abyss and Starlight"',
      'chronicle-8': 'Yes. Meaning lives between the Abyss and the Stars',
      'chronicle-9': 'The death of living creatures is a natural phenomenon.'
    } : { 'chronicle-1': 'I chose "Abyss and Starlight"', 'chronicle-2': 'Yes. Meaning lives between the Abyss and the Stars' };
    const citations = [...prefaceBody.querySelectorAll('[data-history-note]')];
    if (citations.length !== Object.keys(bindings).length) throw new Error('English preface citation set changed');
    for (const ref of citations) {
      const phrase = bindings[ref.dataset.historyNote];
      const matches = [...revised.window.document.querySelectorAll('p')].filter(p => phrase && p.textContent.includes(phrase));
      if (matches.length !== 1) throw new Error(`Approved preface citation anchor missing: ${ref.dataset.historyNote}`);
      matches[0].append(revised.window.document.importNode(ref.closest('sup') ?? ref, true));
    }
    prefaceBody.replaceChildren(...[...revised.window.document.body.childNodes].map(n => prefaceDom.window.document.importNode(n, true)));
    revised.window.close();
  }
  if (prefaceArt) {
    prefaceBody.append(prefaceArt);
    if (prefaceArt.previousElementSibling?.tagName === 'HR') prefaceArt.previousElementSibling.remove();
  }
  const prefaceIds = new Set([prefaceNode.id, ...[...prefaceNode.querySelectorAll('[data-section-id]')].map(n => n.id)]);
  const preface = {
    html: prefaceNode.outerHTML,
    sections: chronicle.sections.filter(s => prefaceIds.has(s.id)).map(s => ({ ...s, volume: 'home', parents: s.parents.filter(id => prefaceIds.has(id)) })),
    reference_ids: [...prefaceNode.querySelectorAll('[data-history-note]')].map(n => n.id)
  };
  prefaceNode.remove(); chronicle.html = prefaceDom.window.document.body.innerHTML;
  chronicle.sections = chronicle.sections.filter(s => !prefaceIds.has(s.id));
  prefaceDom.window.close();
  if (dialogues) {
    // Publication numbers follow the actual reading order: homepage preface,
    // then chronicle. Stable source keys still address the original evidence.
    const orderedNotes = {};
    const renumber = html => {
      const dom = new JSDOM(html);
      for (const ref of dom.window.document.querySelectorAll('[data-history-note]')) {
        const key = ref.dataset.historyNote, note = chronicle.notes[key];
        if (!note || orderedNotes[key]) throw new Error(`Missing or repeated curated citation ${key}`);
        const number = Object.keys(orderedNotes).length + 1;
        orderedNotes[key] = { ...note, display_number: number };
        ref.textContent = `〔${language === 'en' ? 'Note ' : '注'}${number}〕`;
        ref.setAttribute('aria-label', `${language === 'en' ? 'Note' : '注释'} ${number}`);
      }
      const output = dom.window.document.body.innerHTML; dom.window.close(); return output;
    };
    preface.html = renumber(preface.html); chronicle.html = renumber(chronicle.html);
    if (Object.keys(orderedNotes).length !== Object.keys(chronicle.notes).length) throw new Error('Curated source has no publication number');
    chronicle.notes = orderedNotes;
  }
  if (appeal !== null) volumes.splice(6, 0, compileAppeal(appeal, language));
  return { format: 'cloudig/history-publication/1', title, language, source_sha256: createHash('sha256').update(source).digest('hex'), ...(language === 'en' && prefaceEnglish !== null ? { preface_source_sha256: createHash('sha256').update(prefaceEnglish).digest('hex') } : {}), ...(dialogues ? { dialogue_source_sha256: dialogues.source.sha256, dialogue_input_sha256: dialogueFingerprint(dialogues) } : {}), preface, volumes };
}

// Quotes are text, not a second application. Keep paragraph/line/Markdown
// structure, but never execute quoted HTML or load external images/links.
export function compileDialogueSources(data) {
  const reader = createOfflineContentRuntime();
  const escape = value => markdown.utils.escapeHtml(String(value));
  const render = text => {
    const dom = new JSDOM(reader.renderMarkdown(text, true)), body = dom.window.document.body;
    // Reuse the Reader's exact math, dollar, code and Markdown semantics;
    // historical URLs stay inert instead of navigating out of the excerpt.
    for (const link of body.querySelectorAll('a')) {
      const span = dom.window.document.createElement('span'); span.className = 'history-quoted-link'; span.append(...link.childNodes); link.replaceWith(span);
    }
    for (const table of body.querySelectorAll('table')) {
      const wrap = dom.window.document.createElement('div'); wrap.className = 'standard-table-scroll'; wrap.dataset.scrollRegion = ''; wrap.tabIndex = 0;
      table.replaceWith(wrap); wrap.append(table);
    }
    for (const math of body.querySelectorAll('.katex-display')) {
      const block = math.closest('eqn') ?? math; block.classList.add('history-math-scroll'); block.dataset.scrollRegion = ''; block.tabIndex = 0;
    }
    const html = body.innerHTML; dom.window.close(); return html;
  };
  const notes = {};
  for (const [id, note] of Object.entries(data.notes)) {
    const turns = note.turns.map(turn => {
      const label = turn.speaker === 'user' ? '晨星' : '奥思';
      const gap = turn.omitted_after === undefined ? '' : `<p class="history-dialogue-gap" data-history-gap="${Number(turn.omitted_after)}"><span>中间略去 ${Number(turn.omitted_after)} 条消息</span></p>`;
      const date = turn.date_after ? `<p class="history-dialogue-date-divider" data-history-date="${escape(turn.date_after)}"><time>${escape(turn.date_after)}</time></p>` : '';
      return `<section class="history-dialogue-turn history-dialogue-${turn.speaker}" data-speaker="${turn.speaker}"><header class="history-dialogue-speaker"><span>${label}</span>${turn.time ? `<time>${escape(turn.time)}</time>` : ''}</header><div class="history-dialogue-message">${render(turn.text)}</div></section>${gap}${date}`;
    }).join('\n');
    notes[id] = { title: note.title, date: note.date, topic: note.topic, html: `<div class="history-dialogue" lang="zh-CN">${turns}</div>` };
  }
  reader.dispose();
  return { format: 'cloudig/history-dialogue-publication/1', source_sha256: data.source.sha256, input_sha256: dialogueFingerprint(data), notes };
}

// The package's text copy must not quietly redistribute the superseded 195
// chronicle snippets. Keep the manuscript prose and the independent biographies;
// the application's shared dialogue publication is the current annotation layer.
export function historyManuscriptForPackage(source, language, prefaceEnglish = null) {
  if (language === 'en' && prefaceEnglish !== null) {
    const boundary = /^### Preface\r?\n[\s\S]*?(?=^### Chapter 1 — The Empty City\r?$)/mu;
    if (!boundary.test(source) || !/^# Preface\r?\n/u.test(prefaceEnglish)) throw new Error('English manuscript preface boundary changed');
    source = source.replace(boundary, '### Preface\n' + prefaceEnglish.replace(/^# Preface\r?\n/u, '').trimEnd() + '\n\n---\n\n');
  }
  const start = source.indexOf('<details class="source-notes"');
  const end = source.indexOf('</details>', start);
  if (start < 0 || end < start) throw new Error('Chronicle source appendix boundary missing');
  const prose = source.slice(0, start).replace(/<sup class="source-note-ref">[^<]*<\/sup>/gu, '');
  const message = language === 'en' ? 'The current original-dialogue annotations are available in Cloudig → History and Future. Superseded chronicle notes are not distributed in this text copy.' : '现行原始对话注释请在采云 → 历史与未来中展开阅读；本正文副本不再分发被替代的旧《采云史》附注。';
  return prose + `> ${message}\n\n` + source.slice(end + '</details>'.length);
}

export async function historyPublicationOptions() {
  const prefaceEnglish = await readFile(path.join(root, 'src/ui/documents/history/preface-en.md'), 'utf8');
  const dialogues = JSON.parse(await readFile(path.join(root, 'src/ui/documents/history/dialogue-notes.json'), 'utf8'));
  const appeal = await readFile(path.join(root, 'src/ui/documents/history/appeal.txt'), 'utf8');
  const plan = JSON.parse(await readFile(path.join(root, 'src/ui/documents/history/illustrations.json'), 'utf8'));
  const provenance = JSON.parse(await readFile(path.join(root, 'src/ui/documents/history/illustration-provenance.json'), 'utf8'));
  const artwork = [];
  for (const item of plan.items) {
    if (!/^(?:chronicle|fable|sol|three)-\d+$/u.test(item.key)) throw new Error(`Invalid illustration key: ${item.key}`);
    const bytes = await readFile(path.join(root, `src/ui/shell/pages/document/assets/history-articles/${item.key}.png`));
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Invalid illustration PNG: ${item.key}`);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    const sha256 = createHash('sha256').update(bytes).digest('hex'), approved = provenance.final_assets?.find(a => a.key === item.key);
    if (!approved || approved.sha256 !== sha256 || approved.width !== width || approved.height !== height) throw new Error(`Illustration is missing its visual/provenance check: ${item.key}`);
    let night;
    if (approved.night) {
      if (item.key !== 'chronicle-2') throw new Error('Only the homepage bear is approved for an article theme variant');
      const alternate = await readFile(path.join(root, `src/ui/shell/pages/document/assets/history-articles/${item.key}-night.png`));
      if (!alternate.subarray(0, 8).equals(bytes.subarray(0, 8))) throw new Error('Invalid bear night PNG');
      const nightWidth = alternate.readUInt32BE(16), nightHeight = alternate.readUInt32BE(20);
      if (createHash('sha256').update(alternate).digest('hex') !== approved.night.sha256 || nightWidth !== approved.night.width || nightHeight !== approved.night.height || alternate.length !== approved.night.bytes) throw new Error('Bear night variant provenance mismatch');
      if (nightWidth * height !== nightHeight * width) throw new Error('Bear variants must share their complete uncropped aspect ratio');
      night = { width: nightWidth, height: nightHeight };
    }
    artwork.push({ ...item, width, height, ...(night ? { night } : {}) });
  }
  return { appeal, artwork, dialogues, prefaceEnglish };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check'), targetRoot = path.join(root, 'src/ui/shell/pages/document/content');
  await mkdir(targetRoot, { recursive: true });
  const options = await historyPublicationOptions();
  const dialogueOutput = JSON.stringify(compileDialogueSources(options.dialogues)) + '\n';
  const dialogueTarget = path.join(targetRoot, 'history-dialogues.json');
  if (check) { if (await readFile(dialogueTarget, 'utf8') !== dialogueOutput) throw new Error('History dialogue publication drift'); }
  else await writeFile(dialogueTarget, dialogueOutput);
  for (const language of ['zh-CN', 'en']) {
    const source = await readFile(path.join(root, `src/ui/documents/history/${language}.md`), 'utf8');
    const publication = compileHistory(source, language, options), output = `${JSON.stringify(publication)}\n`;
    const target = path.join(targetRoot, `history-${language}.json`);
    if (check) { if (await readFile(target, 'utf8') !== output) throw new Error(`History publication drift: ${language}`); }
    else await writeFile(target, output);
    console.log(`${check ? 'checked' : 'built'} history ${language}: ${publication.volumes.length} volumes, ${publication.volumes.reduce((n, v) => n + Object.keys(v.notes).length, 0)} source notes`);
  }
}
