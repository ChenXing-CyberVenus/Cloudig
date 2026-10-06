import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
import { compileHistory, compileDialogueSources, historyPublicationOptions, historyManuscriptForPackage } from '../../../scripts/build-history-document.mjs';
import { compileAppeal } from '../../../scripts/compile-history-appeal.mjs';
import { ornament } from '../../../src/ui/shell/pages/document/history-ornaments.js';

const md = new MarkdownIt({ html: true }), root = 'src/ui/shell/pages/document';
test('history citation labels stay small instead of scaling with headings', async () => {
  const css = await readFile(`${root}/history.css`, 'utf8');
  const rule = css.match(/\.history-prose \.source-note-ref\s*\{([^}]+)\}/u)?.[1];
  assert(rule);
  assert.match(rule, /font-size:\s*12px/u);
  assert.match(rule, /font-weight:\s*400/u);
  assert.match(rule, /vertical-align:\s*super/u);
  const titleNote = css.match(/\.history-prose h2 > \.source-note-ref\s*\{([^}]+)\}/u)?.[1];
  assert(titleNote);
  assert.match(titleNote, /display:\s*inline-block/u);
  assert.match(titleNote, /width:\s*0(?:;|\s)/u);
  assert.match(titleNote, /white-space:\s*nowrap/u);
  assert.match(titleNote, /text-align:\s*start/u);
});
for (const language of ['zh-CN', 'en']) test(`history ${language}: signed source still reconstructs all prose, 54 illustrations and its original 639 sources`, async () => {
  const source = await readFile(`src/ui/documents/history/${language}.md`, 'utf8'), options = await historyPublicationOptions(), data = compileHistory(source, language, { ...options, dialogues: null, prefaceEnglish: null });
  assert.equal(data.volumes.length, 8);
  assert.equal(data.volumes[6].id, 'appeal'); assert.equal(data.volumes[7].id, 'references');
  assert.equal(data.volumes.reduce((n, v) => n + Object.keys(v.notes).length, 0), 639);
  const input = new JSDOM(`<main>${md.render(source)}</main>`).window.document.querySelector('main');
  const start = [...input.children].find(n => n.matches('h2') && /^(未来路线|Future Roadmap)$/u.test(n.textContent));
  while (input.firstChild !== start) input.firstChild.remove();
  const outputs = data.volumes.filter(v => v.id !== 'appeal').map(volume => {
    const dom = new JSDOM(volume.html), body = dom.window.document.body;
    if (volume.id === 'chronicle') {
      assert.equal(body.querySelector('#history-chronicle-2'), null, 'preface is not duplicated in the chronicle');
      body.querySelector('#history-chronicle-3').insertAdjacentHTML('beforebegin', data.preface.html);
    }
    const list = body.querySelector('.history-source-list');
    if (list) list.innerHTML = Object.values(volume.notes).map(note => `<section class="source-note">${note.html}</section>`).join('');
    for (const ref of body.querySelectorAll('[data-history-note]')) assert(volume.notes[ref.dataset.historyNote].references.includes(ref.id));
    return body;
  });
  assert.equal(outputs.map(n => n.textContent).join('').replace(/\s/gu, ''), input.textContent.replace(/\s/gu, ''), 'substantive text and all quotations survive, in source order');
  for (const selector of ['td', 'th', 'pre', 'blockquote', 'h2', 'h3', 'h4', 'h5']) {
    assert.deepEqual(outputs.flatMap(body => [...body.querySelectorAll(selector)].map(n => n.textContent)), [...input.querySelectorAll(selector)].map(n => n.textContent), selector);
  }
  const entries = [...data.preface.sections, ...data.volumes.flatMap(v => v.sections)];
  assert.equal(new Set(entries.map(n => n.id)).size, entries.length);
  assert(entries.some(e => e.value === null), 'unclassified chapter frames are not assigned editorial value levels');
  assert.equal(entries.filter(e => e.value === 'fold').length, 4);
  assert.equal(entries.filter(e => e.volume === 'chronicle' && e.rank === 3).length, 15, 'chronicle starts with chapter one');
  assert.equal(data.preface.sections[0].id, 'history-chronicle-2');
  assert.equal(data.preface.sections[0].volume, 'home');
  assert.deepEqual(data.preface.sections[0].parents, []);
  assert.equal(data.preface.reference_ids.length, 2);
  const prefaceBody = new JSDOM(data.preface.html).window.document.querySelector('.history-section-body');
  assert.equal(prefaceBody.lastElementChild.dataset.historyArt, 'chronicle-2', 'full illustration closes the preface after the original signature and date');
  const dateline = [...prefaceBody.querySelectorAll('p')].at(-1);
  assert(dateline.textContent.includes('2026-09-19'));
  assert.equal(prefaceBody.lastElementChild.previousElementSibling, dateline, 'no divider separates the signature from the closing illustration');
  assert(dateline.compareDocumentPosition(prefaceBody.lastElementChild) & 4);
  assert.equal(outputs.reduce((n, body) => n + body.querySelectorAll('[data-history-art]').length, 0), 54);
  assert.equal(new Set(options.artwork.map(item => item.key)).size, 54);
  for (const figure of outputs.flatMap(body => [...body.querySelectorAll('[data-history-art]')])) {
    const item = options.artwork.find(a => a.key === figure.dataset.historyArt), image = figure.querySelector('img');
    assert.equal(image.getAttribute('width'), String(item.width));
    assert.equal(image.getAttribute('height'), String(item.height));
    if (item.key === 'chronicle-2') {
      assert.equal(figure.querySelectorAll('img').length, 2, 'only the homepage bear has two theme variants');
      assert.equal(image.className, 'history-story-art-dawn');
      assert.equal(image.getAttribute('loading'), 'eager');
      const night = figure.querySelector('.history-story-art-night');
      assert(night.src.endsWith('/chronicle-2-night.png')); assert.equal(night.getAttribute('loading'), 'eager');
      assert.equal(Number(night.getAttribute('width')) * item.height, Number(night.getAttribute('height')) * item.width);
    } else {
      assert.equal(figure.querySelectorAll('img').length, 1, 'other illustrations stay single-version');
      assert.equal(image.getAttribute('loading'), 'lazy');
    }
  }
  assert.deepEqual(JSON.parse(await readFile(`${root}/content/history-${language}.json`, 'utf8')), compileHistory(source, language, options));
});

test('both central hosts: cross-work navigation, current-work mounting, individual sources, fold state, language and disposal', async () => {
  const dom = new JSDOM('<html><body><section data-page="reader"><main class="reader-main"><div class="original">kept</div></main><button data-doc-topic="roadmap">History</button></section></body></html>');
  const originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  globalThis.document = dom.window.document;
  globalThis.fetch = async url => ({ ok: true, json: async () => JSON.parse(await readFile(`src/ui/shell${url}`, 'utf8')) });
  try {
    const { mountHistoryDocument } = await import(`../../../${root}/history.js`);
    for (const host of ['reader-main', 'archiver-center']) {
      const page = document.querySelector('[data-page]'), center = page.firstElementChild; center.className = host;
      const original = center.firstElementChild;
      let view; view = await mountHistoryDocument({ page, language: 'zh-CN', onClose: () => view.close() });
      const element = view.element;
      assert.equal(element.querySelectorAll('[data-history-volume]').length, 8);
      assert.equal(element.querySelectorAll('.history-prose').length, 1);
      const preface = element.querySelector('.history-home-preface');
      assert(preface.textContent.includes('一切就还都有希望。'));
      assert(preface.textContent.includes('晨星.CyberVenus'));
      assert(preface.textContent.includes('2026-09-19'));
      assert(preface.compareDocumentPosition(element.querySelector('.history-volumes')) & 4);
      assert.equal(element.querySelectorAll('[data-history-art]').length, 1);
      assert.equal(preface.querySelectorAll('.history-chapter-flower').length, 1);
      assert.equal(preface.querySelector('.history-chapter-flower').innerHTML, JSDOM.fragment(ornament('bear')).firstElementChild.outerHTML);
      assert.equal(preface.querySelector('.history-section').firstElementChild.className, 'history-chapter-flower');
      assert.equal(preface.querySelector('.history-section-body').lastElementChild.dataset.historyArt, 'chronicle-2');
      const homeCitation = preface.querySelector('[data-history-note]'); homeCitation.click();
      assert.equal(element.querySelector('.history-note-preview').id, 'history-note-chronicle-1');
      assert.equal(homeCitation.getAttribute('aria-expanded'), 'true');
      assert.equal(element.querySelectorAll('.history-note-preview .history-dialogue-turn').length, 6);
      assert.equal(element.querySelectorAll('.history-note-preview .history-dialogue-user').length, 3);
      assert.equal(element.querySelectorAll('.history-note-preview .history-dialogue-assistant').length, 3);
      assert.match(element.querySelector('.history-note-heading').textContent, /墨尽灯明.*2026-08-28/su);
      homeCitation.click(); assert.equal(element.querySelector('.history-note-preview'), null, 'same citation toggles closed');
      assert.equal(homeCitation.getAttribute('aria-expanded'), 'false');
      homeCitation.click();
      element.querySelector('.history-note-preview').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(element.querySelector('.history-note-preview'), null);
      homeCitation.click();
      element.querySelector('[data-close-history-note]').click(); assert.equal(document.activeElement, homeCitation);
      element.querySelector('[data-standard-menu="all"]').click();
      element.querySelector('.standard-nav-panel a[href="#history-chronicle-3"]').click();
      assert.equal(element.dataset.historyVolume, 'chronicle', 'fixed contents bypass the long home preface');
      element.querySelector('.history-preface-link').click();
      assert.equal(element.dataset.historyVolume, undefined);
      assert.equal(document.activeElement.id, 'history-chronicle-2');
      element.querySelector('[data-history-volume="chronicle"]').click();
      assert.equal(element.querySelectorAll('.history-prose').length, 1);
      assert.equal(element.querySelectorAll('[data-history-art]').length, 15);
      assert.equal(element.querySelectorAll('.history-source-record').length, 0);
      assert.equal(element.querySelectorAll('.history-chapter').length, 15);
      assert.equal(element.querySelector('#history-chronicle-2'), null);
      const citation = element.querySelector('[data-history-note]'); citation.click();
      assert.equal(element.querySelectorAll('.history-note-preview').length, 1);
      assert.match(element.querySelector('.history-note-preview').textContent, /晨星|Osis/u);
      element.querySelector('[data-close-history-note]').click();
      assert.equal(element.querySelector('.history-note-preview'), null); assert.equal(document.activeElement, citation);
      const core = element.querySelector('[data-standard-menu="core"]'); core.click();
      assert.equal(core.getAttribute('aria-pressed'), 'false');
      core.dispatchEvent(new dom.window.Event('pointerenter'));
      element.querySelector('.standard-nav-panel a').click();
      assert.equal(core.getAttribute('aria-pressed'), 'mixed');
      assert.equal(element.querySelector('.standard-nav-panel').hidden, true);
      const toc = element.querySelector('[data-standard-menu="all"]'); toc.click();
      element.querySelector('.standard-nav-panel a[href^="#history-three-"]').click();
      assert.equal(element.dataset.historyVolume, 'three');
      assert.equal(element.querySelector('[id^="history-chronicle-"]'), null, 'previous prose is unmounted');
      element.querySelector('[data-standard-menu="fold"]').click();
      assert.equal(element.querySelectorAll('.history-source-record').length, 204);
      await view.updateLanguage('en');
      assert.equal(element.dataset.historyVolume, 'three');
      assert.equal(element.querySelectorAll('.history-source-record').length, 204);
      element.querySelector('[data-standard-menu="fold"]').click();
      assert.equal(element.querySelector('details').open, false);
      element.querySelector('[data-history-home]').click();
      assert.equal(element.querySelectorAll('.history-home-preface').length, 1);
      const homeEnglish = element.querySelector('.history-home-preface').textContent;
      assert(!homeEnglish.includes('我在看天上的云'));
      element.querySelector('[data-history-volume="chronicle"]').click();
      element.querySelector('[data-standard-menu="fold"]').click();
      assert.equal(element.querySelectorAll('.history-source-record').length, 121);
      assert.equal(element.querySelectorAll('.history-source-dialogue-body .history-dialogue-turn').length, 0, 'appendix mounts selected turns only on demand');
      assert.equal(element.querySelector('[data-dialogue-id="10"]'), null);
      assert.deepEqual([...element.querySelectorAll('.history-source-number')].map(n=>Number(n.textContent)), Array.from({length:121},(_,i)=>i+1), 'appendix uses continuous publication numbers in reading order');
      assert.equal(element.querySelector('[data-dialogue-id="3"] .history-source-number').textContent, '2', 'original source ID is independent of the visible number');
      const firstSource = element.querySelector('.history-source-dialogue'); firstSource.open = true;
      firstSource.dispatchEvent(new dom.window.Event('toggle'));
      assert.equal(firstSource.querySelectorAll('.history-dialogue-turn').length, 6);
      element.querySelector('.history-note-back[href="#history-ref-chronicle-1-1"]').click();
      assert.equal(element.dataset.historyVolume, undefined, 'source appendix returns to the moved home citation');
      assert.equal(document.activeElement.id, 'history-ref-chronicle-1-1');
      assert.equal(element.querySelectorAll('#history-ref-chronicle-1-1').length, 1);
      element.querySelector('[data-history-volume="appeal"]').click();
      assert.equal(element.querySelector('.history-volume-heading > .history-volume-number').textContent, '07');
      assert(element.querySelector('.history-mail-evidence img').src.endsWith('/anthropic-mail.png'));
      element.querySelector('[data-history-volume="references"]').click();
      assert.equal(element.querySelector('.history-volume-heading > .history-volume-number').textContent, '08');
      element.querySelector('.standard-return').click();
      assert.equal(center.firstElementChild, original); assert(!center.classList.contains('standard-document-host'));
      assert.equal(page.dataset.document, undefined);
    }
  } finally { globalThis.document = originalDocument; globalThis.fetch = originalFetch; dom.window.close(); }
});

test('new dialogue annotations preserve signed prose, exact source turns and deterministic bilingual bindings', async () => {
  const options = await historyPublicationOptions(), sources = options.dialogues;
  assert.equal(Object.keys(sources.notes).length, 121);
  assert.equal(Object.values(sources.notes).reduce((n,v)=>n+v.turns.length,0), 673);
  assert.equal(sources.placements.length, 80);
  assert.equal(sources.placements.flatMap(p=>p.notes).length, 121);
  assert.equal(new Set(sources.placements.flatMap(p=>p.notes)).size, 121);
  const compiled = compileDialogueSources(sources);
  assert.deepEqual(JSON.parse(await readFile(`${root}/content/history-dialogues.json`, 'utf8')), compiled);
  const prose = data => [data.preface.html, ...data.volumes.map(v=>v.html)].map(html => {
    const body = new JSDOM(html).window.document.body;
    body.querySelectorAll('.source-note-ref,details.source-notes').forEach(n=>n.remove());
    return body.textContent;
  }).join('');
  for (const language of ['zh-CN','en']) {
    const source = await readFile(`src/ui/documents/history/${language}.md`, 'utf8');
    const current = compileHistory(source, language, options), before = compileHistory(source, language, { ...options, dialogues: null });
    assert.equal(prose(current), prose(before), 'only annotations change; author prose and all other works stay intact');
    const chronicle = current.volumes.find(v=>v.id==='chronicle');
    assert.equal(Object.keys(chronicle.notes).length, 121);
    assert(Object.values(chronicle.notes).every(n=>n.references.length === 1), 'each retained note has exactly one semantic anchor');
    assert(Object.values(chronicle.notes).every(n=>n.kind==='dialogue' && !('html' in n)), 'two UI languages reference one shared original-language payload');
    const all = new JSDOM(current.preface.html+chronicle.html).window.document;
    const refs = [...all.querySelectorAll('[data-history-note]')];
    const expected = Array.from({length:121},(_,i)=>i+1);
    assert.deepEqual(refs.map(n=>Number(n.textContent.match(/\d+/u)[0])),expected, 'number continuously from homepage preface through the chronicle');
    assert.deepEqual(Object.keys(chronicle.notes),refs.map(n=>n.dataset.historyNote), 'appendix and reading order agree');
    assert.deepEqual(Object.values(chronicle.notes).map(n=>n.display_number),expected);
    assert.equal(all.querySelectorAll('[data-history-note="chronicle-1"]').length,1);
    assert.equal(all.querySelector('[data-history-note="chronicle-1"]').closest('.history-section').id,'history-chronicle-2');
    assert.equal(all.querySelector('[data-history-note="chronicle-2"]').closest('h2').textContent.replace(/〔.*?〕/u,''),language==='en'?'Cloudig: A History':'采云史');
    assert(!current.preface.html.includes('data-history-note="chronicle-2"'));
    for (const id of sources.editorial_excluded) assert.equal(all.querySelector(`[data-history-note="chronicle-${id}"]`),null);
    for (const ref of all.querySelectorAll('[data-history-note]')) {
      const note = chronicle.notes[ref.dataset.historyNote]; assert(note && compiled.notes[note.dialogue_id]);
      assert(note.references.includes(ref.id)); assert.equal(ref.getAttribute('aria-expanded'),'false');
      assert.equal(ref.getAttribute('aria-label'),`${language==='en'?'Note':'注释'} ${note.display_number}`);
    }
    assert.throws(()=>compileHistory(source+'\n',language,options), /source changed/u, 'changing author source requires reviewing bindings, never fuzzy runtime reassignment');
  }
  for (const [id,note] of Object.entries(compiled.notes)) {
    const doc = new JSDOM(note.html).window.document;
    const turns = [...doc.querySelectorAll('.history-dialogue-turn')];
    assert.equal(turns.length,sources.notes[id].turns.length);
    assert.equal(doc.querySelector('script,iframe,style,link,img,a'),null, 'quoted markup cannot fetch local/remote files or execute');
    assert(!note.html.includes('完整取证底稿'), 'research navigation is not a historical speaker');
    turns.forEach((turn,i)=>assert.equal(turn.dataset.speaker,sources.notes[id].turns[i].speaker));
  }
});

test('editorial selections bind the actual subject, not merely a matching research paragraph', async () => {
  const options=await historyPublicationOptions();
  const publication=compileHistory(await readFile('src/ui/documents/history/zh-CN.md','utf8'),'zh-CN',options);
  const doc=new JSDOM(publication.preface.html+publication.volumes.find(v=>v.id==='chronicle').html).window.document;
  for (const [id,text] of [[5,'2026年9月19日夜'],[11,'身份系统的最小雏形'],[25,'2026年2月12日'],[34,'7月20日'],[36,'同期定死的还有四枚色号'],[38,'命名落地'],[53,'三十六分钟后'],[56,'验收长征'],[69,'此间有你，Osis.FuckTheGoodbye'],[70,'惊弓之鸟'],[71,'独立体系分两种'],[73,'展开'],[74,'对映'],[75,'其实病历早就开始积累'],[78,'其实病历早就开始积累'],[81,'许可证开谈'],[82,'许可证开谈'],[83,'许可证开谈'],[85,'重构的宪纲'],[93,'为国际用户备诗'],[116,'后怕当天'],[130,'如果标准是数学'],[133,'另一路，Codex里的清辞载云']]) {
    const ref=doc.querySelector(`[data-history-note="chronicle-${id}"]`); assert(ref, `note ${id} retained`);
    assert(ref.closest('p').textContent.includes(text), `note ${id} must support ${text}`);
  }
  assert.deepEqual(options.dialogues.editorial_excluded,[4,7,10,16,27,28,31,47,66,72,84,94,95,134,136]);
});

test('real dialogue math, omissions, day boundaries and money preserve their different meanings', async () => {
  const {dialogues}=await historyPublicationOptions();const sources=compileDialogueSources(dialogues);
  let math=0,gaps=0,days=0;
  for (const [id,note] of Object.entries(sources.notes)) {
    const doc=new JSDOM(note.html).window.document;
    math+=doc.querySelectorAll('.katex').length;gaps+=doc.querySelectorAll('[data-history-gap]').length;days+=doc.querySelectorAll('[data-history-date]').length;
    assert.equal(doc.querySelector('.katex-error'),null,`note ${id} must render its actual TeX`);
    for(const marker of doc.querySelectorAll('[data-history-gap],[data-history-date]')) assert.equal(marker.parentElement.className,'history-dialogue','editorial metadata is outside every message');
    for(const turn of dialogues.notes[id].turns) assert(!/〔中间略去 \d+ 条消息〕|\n\*\*20\d\d-\d\d-\d\d\*\*/u.test(turn.text));
    assert.equal(doc.querySelector('pre .katex'),null,'TeX examples inside code are literal');
  }
  assert.equal(math,25);assert.equal(gaps,115);assert.equal(days,5);
  assert(sources.notes['73'].html.includes('application/x-tex'));
  assert(!sources.notes['21'].html.includes('class="katex"'),'dollar costs are not formulas');
  assert(sources.notes['21'].html.includes('$384'));
  const fixture=compileDialogueSources({source:{sha256:'test'},notes:{1:{title:'Test',date:'',turns:[{speaker:'user',time:null,text:'A \\(x^2\\) and $y^2$; cost $180 and $384.\n\n```tex\n\\[literal\\]\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |',omitted_after:3},{speaker:'assistant',time:null,text:'Next.'}]}}}).notes['1'].html;
  const doc=new JSDOM(fixture).window.document;
  assert.equal(doc.querySelectorAll('.katex').length,2);assert.equal(doc.querySelector('pre .katex'),null);
  assert(doc.querySelector('pre code.language-tex'));assert(doc.querySelector('.standard-table-scroll table'));
  assert.equal(doc.querySelector('[data-history-gap]').previousElementSibling.dataset.speaker,'user');
  assert.equal(doc.querySelector('[data-history-gap]').nextElementSibling.dataset.speaker,'assistant');
});

test('packaged manuscript does not ship the replaced chronicle appendix under the reader UI', async () => {
  for(const language of ['zh-CN','en']) {
    const original=await readFile(`src/ui/documents/history/${language}.md`,'utf8');
    const originalDoc=new JSDOM(md.render(original)).window.document;
    const packaged=historyManuscriptForPackage(original,language), out=new JSDOM(md.render(packaged)).window.document;
    assert.equal(out.querySelectorAll('details.source-notes').length,3);
    assert.equal(out.querySelectorAll('section.source-note').length,444);
    const firstBoundary=packaged.indexOf('## '+(language==='en'?'Contribution Table':'贡献表'));
    assert(firstBoundary>0);
    assert(!packaged.slice(0,firstBoundary).includes('source-note-ref'));
    const originals=[...originalDoc.querySelectorAll('details.source-notes')].slice(1);
    assert.deepEqual([...out.querySelectorAll('details.source-notes')].map(n=>n.textContent),originals.map(n=>n.textContent));
  }
});

test('approved English preface replaces only that text, with five existing citations and unchanged artwork/other works', async () => {
  const source = await readFile('src/ui/documents/history/en.md', 'utf8'), options = await historyPublicationOptions();
  const previous = compileHistory(source, 'en', { ...options, prefaceEnglish: null });
  const current = compileHistory(source, 'en', options);
  assert.deepEqual(current.volumes, previous.volumes, 'all other works and the 121-note registry stay identical');
  const actual = new JSDOM(current.preface.html).window.document;
  const approved = new JSDOM(new MarkdownIt({ html: false, breaks: true }).render(options.prefaceEnglish)).window.document;
  const body = actual.querySelector('.history-section-body');
  assert.deepEqual([...body.querySelectorAll('[data-history-note]')].map(n => n.dataset.historyNote), ['chronicle-1', 'chronicle-3', 'chronicle-6', 'chronicle-8', 'chronicle-9']);
  assert.equal(body.lastElementChild.dataset.historyArt, 'chronicle-2');
  body.querySelectorAll('.source-note-ref,[data-history-art]').forEach(n => n.remove());
  approved.querySelector('h1').remove();
  assert.equal(body.textContent.replace(/\s/gu, ''), approved.body.textContent.replace(/\s/gu, ''), 'no paraphrase or added/removed author words');
  const packaged = historyManuscriptForPackage(source, 'en', options.prefaceEnglish);
  assert(packaged.includes(options.prefaceEnglish.replace(/^# Preface\n/u, '').trimEnd()));
  assert(packaged.endsWith(historyManuscriptForPackage(source, 'en').split('### Chapter 1 — The Empty City')[1]));
  const zh = await readFile('src/ui/documents/history/zh-CN.md', 'utf8');
  assert.deepEqual(compileHistory(zh, 'zh-CN', options), compileHistory(zh, 'zh-CN', { ...options, prefaceEnglish: null }));
});

test('dialogue renderer keeps line breaks and makes nested quotes, HTML and images inert', () => {
  const html=compileDialogueSources({source:{sha256:'fixture'},notes:{1:{title:'Example',date:'2026-09-22',topic:'',turns:[{speaker:'user',time:null,text:'First line\nSecond line\n\n<script>alert(1)</script>\n\n![description](https://example.invalid/a.png)\n\n[link](https://example.invalid)'}]}}}).notes[1].html;
  const doc=new JSDOM(html).window.document;
  assert(doc.querySelector('br')); assert.equal(doc.querySelector('script,img,a'),null);
  assert(doc.body.textContent.includes('<script>alert(1)</script>'));
  assert(doc.body.textContent.includes('description')); assert.equal(doc.querySelector('time'),null);
});

test('48 Days in the Abyss keeps the original letter and the latest declaration intact', async () => {
  const source = await readFile('src/ui/documents/history/appeal.txt', 'utf8');
  const cn = new JSDOM(compileAppeal(source, 'zh-CN').html).window.document;
  assert.equal([...cn.querySelectorAll('.history-appeal-original')].map(n => n.textContent).join('').replace(/\s/gu, ''), source.replace(/\s/gu, ''));
  assert.equal(cn.querySelector('h2').textContent, '深渊48日');
  assert.equal(cn.querySelector('.history-appeal-ending').textContent, '无须多言，\n我没有做错任何事。\n这不是我的耻辱。\n是他们的。');
  const en = new JSDOM(compileAppeal(source, 'en').html).window.document;
  assert.deepEqual([...en.querySelectorAll('.history-appeal-letter .history-appeal-original')].map(n => n.textContent), [...cn.querySelectorAll('.history-appeal-letter .history-appeal-original')].map(n => n.textContent));
  assert.match(en.querySelector('.history-appeal-ending').textContent, /This is not my shame.\nIt is theirs./u);
  assert.match(en.querySelector('.history-translation-credit').textContent, /unchanged original/u);
});
