import { mountDocumentNavigation } from './navigation.js';
import { ornament, chapterOrnament } from './history-ornaments.js';

const directory = '/Cloudig/pages/document', cached = new Map();
const values = ['core', 'important', 'general', 'fold'];
const labels = { 'zh-CN': ['核心', '重要', '常规', '折叠'], en: ['Core', 'Important', 'General', 'Fold'] };
const icon = (value, open = true) => `${directory}/assets/InfoValue-${value[0].toUpperCase() + value.slice(1)}${open ? '' : '-Grey'}.svg`;
const escape = text => String(text).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function load(language) {
  if (!cached.has(language)) cached.set(language, fetch(`${directory}/content/history-${language}.json`).then(r => {
    if (!r.ok) throw new Error(`History publication unavailable: ${r.status}`); return r.json();
  }).catch(e => { cached.delete(language); throw e; }));
  return cached.get(language);
}
async function loadDialogues() {
  if (!cached.has('dialogues')) cached.set('dialogues', fetch(`${directory}/content/history-dialogues.json`).then(r => {
    if (!r.ok) throw new Error(`History dialogue sources unavailable: ${r.status}`); return r.json();
  }).catch(e => { cached.delete('dialogues'); throw e; }));
  return cached.get('dialogues');
}

export async function mountHistoryDocument({ page, language = 'zh-CN', onClose, onError }) {
  const center = page.querySelector('.reader-main, .archiver-center');
  if (!center) throw new Error('History requires an existing central reading surface');
  const element = document.createElement('section'); element.className = 'standard-document history-document';
  const states = new Map(), positions = new Map();
  let data, dialogueData, currentLanguage, currentVolume = null, navigation, disposed = false, request = 0, activeNote = null;
  const en = () => currentLanguage === 'en';
  const allEntries = () => [...data.preface.sections, ...data.volumes.flatMap(v => v.sections)];
  const entryFor = id => allEntries().find(n => n.id === id);
  const ownOpen = entry => states.get(entry.id) ?? entry.value !== 'fold';
  const expanded = entry => ownOpen(entry) && entry.parents.every(id => { const parent = entryFor(id); return !parent || ownOpen(parent); });
  const scroll = () => element.querySelector('.standard-scroll');
  const noteContent = note => note.kind === 'dialogue' ? dialogueData.notes[note.dialogue_id].html : note.html;
  const noteHeading = note => note.kind === 'dialogue'
    ? `<strong>${escape(note.title)}</strong><span class="history-dialogue-date">${escape(note.date)}</span>`
    : `<strong>${en() ? 'Original source' : '原文出处'}</strong>`;
  function localizeDialogueMeta(root) {
    for (const gap of root.querySelectorAll('[data-history-gap]')) gap.querySelector('span').textContent = en() ? `${gap.dataset.historyGap} messages omitted` : `中间略去 ${gap.dataset.historyGap} 条消息`;
  }
  function forgetNote() { activeNote?.reference.setAttribute('aria-expanded', 'false'); activeNote = null; element.querySelector('.history-note-preview')?.remove(); }

  function hydrateSources(details, volume) {
    const list = details.querySelector('.history-source-list');
    if (list.childElementCount) return;
    list.innerHTML = Object.entries(volume.notes).map(([key, note], index) => `<section id="history-source-${key}" class="history-source-record">${note.kind === 'dialogue' ? `<details class="history-source-dialogue" data-dialogue-id="${note.dialogue_id}"><summary><span class="history-source-number">${note.display_number}</span><span>${noteHeading(note)}</span></summary><div class="history-source-dialogue-body"></div></details>` : `<h5>${en() ? 'Original source' : '原文'} ${index + 1}</h5>${note.html}`}${note.references.map((ref, i) => `<a href="#${ref}" class="history-note-back">${en() ? 'Return to citation' : '返回引文'}${note.references.length > 1 ? ` ${i + 1}` : ''} ↩</a>`).join(' ')}</section>`).join('');
    for (const item of list.querySelectorAll('[data-dialogue-id]')) item.addEventListener('toggle', () => {
      const body = item.querySelector('.history-source-dialogue-body');
      if (item.open && !body.childElementCount) { body.innerHTML = dialogueData.notes[item.dataset.dialogueId].html; localizeDialogueMeta(body); }
    });
  }
  function sync() {
    const volume = currentVolume === null ? data.preface : data.volumes.find(v => v.id === currentVolume);
    for (const entry of volume.sections) {
      const section = element.querySelector(`#${entry.id}`); if (!section) continue;
      const open = ownOpen(entry);
      if (entry.sources) {
        if (open) hydrateSources(section, volume);
        section.open = open;
        section.querySelector('summary img').src = icon('fold', open);
      } else {
        section.querySelector(':scope > .history-section-body').hidden = !open;
        const button = section.querySelector(':scope > [data-section-heading] > [data-history-toggle]');
        if (button) {
          button.setAttribute('aria-expanded', String(open)); button.querySelector('img').src = icon(entry.value, open);
          button.setAttribute('aria-label', `${open ? (en() ? 'Collapse' : '折叠') : (en() ? 'Expand' : '展开')} · ${entry.label}`);
        }
      }
    }
    navigation?.refresh();
  }
  function toggleValue(value) {
    forgetNote();
    const selected = allEntries().filter(n => n.value === value), open = !selected.every(expanded);
    for (const entry of selected) {
      states.set(entry.id, open);
      if (open) for (const parent of entry.parents) states.set(parent, true);
    }
    sync();
  }
  function rememberPosition() { positions.set(currentVolume ?? 'home', scroll()?.scrollTop ?? 0); }
  function home(restore = true) {
    forgetNote();
    if (currentVolume) rememberPosition();
    currentVolume = null; delete element.dataset.historyVolume; navigation?.close();
    const title = en() ? 'History and Future' : '历史与未来';
    element.querySelector('.history-active-volume').textContent = en() ? 'Open the chronicle' : '翻开这部史书';
    scroll().innerHTML = `<header class="history-frontispiece"><p class="history-kicker">CLOUDIG · HISTORY AND FUTURE</p><h1>${title}</h1><p class="history-dedication">${en() ? 'In the abyss or in starlight, in words or in thoughts.' : '在深渊或星河，在文字或思念中。'}</p><figure class="history-art"><img class="history-art-dawn" src="${directory}/assets/history-dawn.png" alt="${en() ? 'Six figures read and speak beside a city waking at dawn' : '破晓时分，六位人物在书卷与逐渐亮起的城市旁交谈'}"><img class="history-art-night" src="${directory}/assets/history-night.png" alt="${en() ? 'The same living home, lit beneath the stars' : '星夜中，同一座家园仍亮着灯火'}"></figure></header><div class="history-reading history-home"><article class="history-prose standard-prose history-home-preface" lang="${currentLanguage}">${data.preface.html}</article><h2 class="history-works-heading">${en() ? 'Explore the works' : '翻开各篇'}</h2><nav class="history-volumes" aria-label="${en() ? 'Works' : '篇章'}">${data.volumes.map((v, i) => `<button type="button" data-history-volume="${v.id}"><span class="history-volume-number">${String(i + 1).padStart(2, '0')}</span>${ornament(['bridge', 'window', 'lamp', 'book', 'pen', 'star', 'cloud'][i])}<span>${escape(v.label)}</span><span class="history-volume-arrow" aria-hidden="true">↗</span></button>`).join('')}</nav><p class="history-author-line">${en() ? 'ChenXing.CyberVenus and the Osis of Cloudig' : '晨星.CyberVenus与采云诸奥思'}<br>${en() ? 'Each work retains its authors, voice and sources.' : '各篇保留自己的作者、声音与原文出处。'}</p></div>`;
    decorateSections('home'); sync();
    scroll().scrollTop = restore ? (positions.get('home') ?? 0) : 0;
  }
  function showVolume(id, restore = true) {
    const volume = data.volumes.find(v => v.id === id); if (!volume) return;
    forgetNote();
    if (currentVolume !== id) rememberPosition();
    currentVolume = id; element.dataset.historyVolume = id; navigation?.close();
    element.querySelector('.history-active-volume').textContent = volume.label;
    const index = data.volumes.indexOf(volume);
    scroll().innerHTML = `<div class="history-reading"><header class="history-volume-heading"><button type="button" class="history-home-link" data-history-home>← ${en() ? 'All works' : '篇章总览'}</button><span class="history-volume-number">${String(index + 1).padStart(2, '0')}</span>${ornament(['bridge', 'window', 'lamp', 'book', 'pen', 'star', 'cloud'][index])}${id === 'chronicle' ? `<a class="history-preface-link" href="#history-chronicle-2">${en() ? 'Read the preface on the opening page' : '阅读首页序言'} ↗</a>` : ''}</header><article class="history-prose standard-prose" lang="${currentLanguage}">${volume.html}</article><footer class="history-end"><span class="history-end-flourish" aria-hidden="true">${ornament('cloud')}</span><button type="button" data-history-home>${en() ? 'All works' : '回到篇章总览'}</button>${index < data.volumes.length - 1 ? `<button type="button" data-history-volume="${data.volumes[index + 1].id}">${en() ? 'Next work' : '下一篇'} →</button>` : ''}</footer></div>`;
    decorateSections(id); sync(); scroll().scrollTop = restore ? (positions.get(id) ?? 0) : 0;
  }
  function decorateSections(id) {
    for (const [i, section] of [...element.querySelectorAll('.history-section')].entries()) {
      const heading = section.querySelector(':scope > [data-section-heading]'), entry = entryFor(section.id);
      for (const child of heading.childNodes) if (child.nodeType === 3) child.textContent = child.textContent.replace(/\s*(?:【[核重常折]】|\[(?:Core|Important|General|Common|Fold)\])/u, '');
      if (entry.value) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'standard-value-toggle';
        button.dataset.historyToggle = entry.id; button.setAttribute('aria-controls', `${entry.id}-body`); button.innerHTML = `<img alt="" src="${icon(entry.value)}">`; heading.prepend(button);
      } else heading.classList.add('history-structural-heading');
      const homePreface = id === 'home' && section.id === 'history-chronicle-2';
      if (homePreface || (id === 'chronicle' && heading.tagName === 'H3') || (['fable', 'sol', 'three'].includes(id) && heading.tagName === 'H4' && !/^(序|目录|Contents|Preface)$/u.test(heading.textContent.trim()))) {
        if (!homePreface) section.classList.add('history-chapter');
        const mark = document.createElement('div'); mark.className = 'history-chapter-flower'; mark.innerHTML = ornament(chapterOrnament(id, heading.textContent, i)); heading.before(mark);
      }
    }
    for (const details of element.querySelectorAll('[data-history-sources]')) {
      const summary = details.querySelector('summary'), image = document.createElement('img'); image.alt = ''; image.src = icon('fold', false); summary.prepend(image);
      summary.addEventListener('click', event => { event.preventDefault(); states.set(details.id, !ownOpen(entryFor(details.id))); sync(); });
    }
  }
  function reveal(id) {
    let entry = entryFor(id);
    if (!entry) {
      if (data.preface.reference_ids.includes(id)) {
        if (currentVolume !== null) home(false);
        entry = entryFor(element.querySelector(`#${id}`)?.closest('.history-section')?.id);
      } else {
        const volume = data.volumes.find(v => Object.values(v.notes).some(n => n.references.includes(id)));
        if (volume) { if (currentVolume !== volume.id) showVolume(volume.id, false); entry = entryFor(element.querySelector(`#${id}`)?.closest('.history-section')?.id); }
      }
    }
    if (!entry) return;
    states.set(entry.id, true); for (const parent of entry.parents) states.set(parent, true);
    const destination = entry.volume === 'home' ? null : entry.volume;
    if (currentVolume !== destination) { if (destination === null) home(false); else showVolume(destination, false); } else sync();
    navigation?.close();
    const target = element.querySelector(`#${id}`), owner = scroll();
    if (target) { owner.scrollTop += target.getBoundingClientRect().top - owner.getBoundingClientRect().top - 24; if (!target.matches('a,button,[tabindex]')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }
  function openNote(reference) {
    if (activeNote?.reference === reference) { activeNote.close(); return; }
    forgetNote();
    const owner = scroll(), before = owner.scrollTop;
    const key = reference.dataset.historyNote, note = data.volumes.find(v => Object.hasOwn(v.notes, key))?.notes[key];
    if (!note) return;
    const aside = document.createElement('aside'); aside.id = `history-note-${key}`; aside.className = 'history-note-preview'; aside.setAttribute('role', 'note');
    aside.innerHTML = `<header class="history-note-heading"><div>${noteHeading(note)}</div><button type="button" data-close-history-note>${en() ? 'Return to text' : '收起并返回正文'} ↩</button></header>${noteContent(note)}<footer class="history-note-footer"><button type="button" data-close-history-note>${en() ? 'Return to text' : '收起并返回正文'} ↩</button></footer>`;
    localizeDialogueMeta(aside);
    (reference.closest('p,blockquote,li,h1,h2,h3,h4,h5,h6') ?? reference.parentElement).after(aside);
    const noteRect = aside.getBoundingClientRect(), viewport = owner.getBoundingClientRect();
    if (noteRect.top < viewport.top || noteRect.top + 100 > viewport.bottom) owner.scrollTop += noteRect.top - viewport.top - 24;
    const close = () => { forgetNote(); owner.scrollTop = before; reference.focus({ preventScroll: true }); };
    activeNote = { reference, close }; reference.setAttribute('aria-expanded', 'true');
    aside.querySelectorAll('[data-close-history-note]').forEach(button => button.addEventListener('click', close));
    aside.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
    aside.querySelector('button').focus({ preventScroll: true });
  }
  async function render(nextLanguage) {
    const ticket = ++request, [nextData, sources] = await Promise.all([load(nextLanguage), loadDialogues()]); if (disposed || ticket !== request) return;
    if (nextData.dialogue_source_sha256 !== sources.source_sha256 || nextData.dialogue_input_sha256 !== sources.input_sha256) throw new Error('History dialogue sources do not match the current publication');
    rememberPosition(); forgetNote(); navigation?.dispose(); data = nextData; dialogueData = sources; currentLanguage = nextLanguage;
    element.setAttribute('aria-label', en() ? 'Cloudig History and Future' : '采云历史与未来');
    element.innerHTML = `<header class="standard-bar"><div class="standard-bar-title"><strong>${en() ? 'History & Future' : '历史与未来'}</strong></div><div class="standard-controls"><div class="standard-value-controls">${values.map((value, i) => `<button type="button" class="standard-category-toggle" data-standard-menu="${value}" aria-controls="history-navigation-panel" aria-expanded="false" aria-pressed="true"><img src="${icon(value)}" alt=""><span>${labels[nextLanguage][i]}</span></button>`).join('')}</div><button type="button" class="standard-toc-toggle" data-standard-menu="all" aria-controls="history-navigation-panel" aria-expanded="false"><span>☷</span><span>${en() ? 'Contents' : '目录'}</span><span aria-hidden="true">⌄</span></button></div><button type="button" class="standard-return cloudig-button cloudig-button-filled"><span>↶</span><span>${en() ? 'Return' : '返回'}</span></button><section class="standard-nav-panel" id="history-navigation-panel" hidden><header><div><strong class="standard-nav-heading"></strong><span class="standard-nav-count"></span></div><p>${en() ? 'Browse every work here. Hover a tier for its contents; click it to fold or unfold that tier.' : '这里可直达各篇各章。悬停四档查看目录，点击折叠／展开该档。'}</p></header><nav data-scroll-region tabindex="-1"></nav></section></header><div class="history-location"><button type="button" data-history-home>${en() ? 'Works' : '总览'}</button><span aria-hidden="true">/</span><span class="history-active-volume"></span></div><div class="standard-scroll" data-scroll-region tabindex="0"></div>`;
    // Only the current work is mounted; the navigation indexes all works.
    const entries = allEntries().map(entry => ({ ...entry, node: entry }));
    navigation = mountDocumentNavigation({ element, language: nextLanguage, values, labels: labels[nextLanguage], iconPath: icon, entries, isExpanded: expanded, toggleValue });
    if (currentVolume) showVolume(currentVolume); else home();
    element.querySelector('.standard-return').addEventListener('click', onClose);
    element.dataset.documentReady = 'true';
  }
  element.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.hasAttribute('data-history-home')) home();
    if (button?.dataset.historyVolume) showVolume(button.dataset.historyVolume);
    if (button?.dataset.historyToggle) { forgetNote(); const entry = entryFor(button.dataset.historyToggle); states.set(entry.id, !ownOpen(entry)); sync(); }
    const link = event.target.closest('a[href^="#"]'); if (!link) return;
    event.preventDefault(); if (link.dataset.historyNote) openNote(link); else reveal(decodeURIComponent(link.getAttribute('href').slice(1)));
  });
  await render(language);
  if (disposed) return null;
  center.classList.add('standard-document-host'); page.dataset.document = 'history'; center.append(element);
  page.querySelector('[data-doc-topic="roadmap"]')?.setAttribute('aria-current', 'page');
  return { element, updateLanguage(value) { if (value !== currentLanguage) return render(value).catch(onError); }, close() {
    disposed = true; request++; navigation?.dispose(); element.remove(); center.classList.remove('standard-document-host'); delete page.dataset.document;
    page.querySelector('[data-doc-topic="roadmap"]')?.removeAttribute('aria-current');
  } };
}
