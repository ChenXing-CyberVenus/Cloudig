import { mountDocumentNavigation } from './navigation.js';

const directory = '/Cloudig/pages/document';
export const informationValues = Object.freeze(['core', 'important', 'general', 'fold']);
const labels = { 'zh-CN': ['核心', '重要', '常规', '折叠'], en: ['Core', 'Important', 'General', 'Fold'] };
const assetName = value => value[0].toUpperCase() + value.slice(1);
const iconPath = (value, open = true) => `${directory}/assets/InfoValue-${assetName(value)}${open ? '' : '-Grey'}.svg`;
const contents = new Map();

async function loadDocument(language) {
  if (!contents.has(language)) contents.set(language, fetch(`${directory}/content/standard-${language}.json`).then(response => {
    if (!response.ok) throw new Error(`Standard document unavailable: ${response.status}`);
    return response.json();
  }).catch(error => { contents.delete(language); throw error; }));
  return contents.get(language);
}

export async function mountStandardDocument({ page, language = 'zh-CN', onClose, onError }) {
  const center = page.querySelector('.reader-main, .archiver-center');
  if (!center) throw new Error('The document needs an existing central reading surface.');
  const element = document.createElement('section');
  element.className = 'standard-document';
  element.setAttribute('aria-label', language === 'en' ? 'Cloudig Standard' : '采云标准');
  const states = new Map();
  let disposed = false, ordinal = 0, currentLanguage = language;
  let navigation = null;

  function refreshIcon(section, open) {
    const button = section.querySelector(':scope > [data-section-heading] > .standard-value-toggle');
    if (button) {
      button.setAttribute('aria-expanded', String(open));
      button.querySelector('img').src = iconPath(section.dataset.infovalue, open);
      button.title = `${open ? (currentLanguage === 'en' ? 'Collapse' : '折叠') : (currentLanguage === 'en' ? 'Expand' : '展开')} · ${labels[currentLanguage][informationValues.indexOf(section.dataset.infovalue)]}`;
      button.setAttribute('aria-label', button.title);
    }
  }
  function setOpen(section, open) {
    if (section.tagName === 'DETAILS') section.open = open;
    else {
      section.querySelector(':scope > .standard-section-body').hidden = !open;
      section.dataset.collapsed = String(!open);
      refreshIcon(section, open);
    }
    states.set(section.dataset.sectionId, open);
  }
  function isExpanded(section) {
    for (let node = section; node && node !== element; node = node.parentElement) {
      if (node.matches('details[data-infovalue]') && !node.open) return false;
      if (node.matches('section[data-infovalue]') && node.querySelector(':scope > .standard-section-body').hidden) return false;
    }
    return true;
  }
  function toggleValue(value) {
    const nodes = [...element.querySelectorAll('.standard-prose section[data-infovalue], .standard-prose details[data-infovalue]')].filter(node => node.dataset.infovalue === value);
    const open = !nodes.every(isExpanded);
    for (const node of nodes) setOpen(node, open);
    if (open) for (const node of nodes) {
      for (let parent = node.parentElement; parent && parent !== element; parent = parent.parentElement) {
        if (parent.matches('section[data-infovalue], details[data-infovalue]')) setOpen(parent, true);
      }
    }
    navigation?.refresh();
  }
  function reveal(id) {
    const target = [...element.querySelectorAll('[id]')].find(node => node.id === id);
    if (!target) return;
    for (let node = target; node && node !== element; node = node.parentElement) {
      if (node.matches('section[data-infovalue], details[data-infovalue]')) setOpen(node, true);
    }
    navigation?.close(); navigation?.refresh();
    const scroll = element.querySelector('.standard-scroll');
    scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24;
    if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  async function render(nextLanguage) {
    const ticket = ++ordinal;
    const data = await loadDocument(nextLanguage);
    if (disposed || ticket !== ordinal) return;
    const oldScroll = element.querySelector('.standard-scroll')?.scrollTop ?? 0;
    navigation?.dispose(); navigation = null;
    currentLanguage = nextLanguage;
    const en = nextLanguage === 'en';
    element.setAttribute('aria-label', en ? 'Cloudig Standard' : '采云标准');
    element.innerHTML = `<header class="standard-bar"><div class="standard-bar-title"><strong>${en ? 'Cloudig Standard' : '采云标准'}</strong><small>V1.0</small></div>
      <div class="standard-controls" aria-label="${en ? 'Reading controls' : '阅读控制'}"><div class="standard-value-controls">${informationValues.map((value, i) => `<button type="button" class="standard-category-toggle" data-standard-menu="${value}" aria-controls="standard-navigation-panel" aria-expanded="false" aria-pressed="true"><img src="${iconPath(value)}" alt=""><span>${labels[nextLanguage][i]}</span></button>`).join('')}</div><button type="button" class="standard-toc-toggle" data-standard-menu="all" aria-controls="standard-navigation-panel" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>${en ? 'Contents' : '目录'}</span><span aria-hidden="true">⌄</span></button></div>
      <button type="button" class="standard-return cloudig-button cloudig-button-filled"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m9 4-8 8 8 8 2-2-4.5-4.5H23v-3H6.5L11 6Z"/></svg><span>${en ? 'Return' : '返回'}</span></button>
      <section class="standard-nav-panel" id="standard-navigation-panel" hidden><header><div><strong class="standard-nav-heading"></strong><span class="standard-nav-count"></span></div><p>${en ? 'Hover to browse. Click a value icon to collapse or expand its category. A chapter link opens it and any collapsed parents.' : '悬停查看目录，点击图标折叠／展开本档。跳转会展开目标及必要的上级。'}</p></header><nav data-scroll-region tabindex="-1"></nav></section></header>
      <div class="standard-scroll" data-scroll-region tabindex="0">
        <header class="standard-frontispiece"><p class="standard-kicker">CLOUDIG STANDARD · V1.0 · DAWNGLOW</p><h1>${data.title}</h1><p class="standard-byline">${en ? 'Core standard & concepts' : '核心标准与概念'} <span>晨星.CyberVenus</span></p><figure class="standard-art"><img class="standard-art-dawn" src="${directory}/assets/standard-dawn.png" alt="${en ? 'Six figures in conversation beneath a dawn sky' : '晨光中，六位人物相互交谈与阅读'}"><img class="standard-art-night" src="${directory}/assets/standard-night.png" alt="${en ? 'The same gathering beneath the stars' : '星光中，同一场交流仍在继续'}"></figure></header>
        <div class="standard-reading">
        <article class="standard-prose" lang="${nextLanguage}">${data.html}</article>
        <footer class="standard-colophon"><span>CLOUDIG STANDARD</span><span>V1.0 · DawnGlow</span><button type="button" data-standard-top>${en ? 'Back to top ↑' : '回到篇首 ↑'}</button></footer></div>
      </div>`;
    for (const section of element.querySelectorAll('section[data-infovalue]')) {
      const heading = section.querySelector(':scope > [data-section-heading]');
      // Remove only the redundant textual classification: the icon and its
      // accessible name carry the same classification, without changing prose.
      for (const child of heading.childNodes) if (child.nodeType === 3) child.textContent = child.textContent.replace(/\s*〔(?:核心|重要|常规|折叠|Core|Important|General|Fold)〕/gu, '');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'standard-value-toggle';
      button.setAttribute('aria-controls', `${section.id}-body`);
      button.innerHTML = '<img alt="">';
      heading.prepend(button);
      const open = states.get(section.dataset.sectionId) ?? section.dataset.infovalue !== 'fold';
      setOpen(section, open);
      button.addEventListener('click', () => { setOpen(section, button.getAttribute('aria-expanded') !== 'true'); navigation?.refresh(); });
    }
    for (const details of element.querySelectorAll('details[data-infovalue]')) {
      details.id = details.dataset.sectionId;
      const summary = details.querySelector(':scope > summary');
      summary.textContent = summary.textContent.replace(/〔(?:折叠|Fold)〕\s*/gu, '');
      const img = document.createElement('img'); img.alt = ''; img.src = iconPath('fold', false); summary.prepend(img);
      const update = () => { if (disposed || !element.contains(details)) return; img.src = iconPath('fold', details.open); states.set(details.dataset.sectionId, details.open); navigation?.refresh(); };
      details.open = states.get(details.dataset.sectionId) ?? false;
      update(); details.addEventListener('toggle', update);
    }
    addConceptFigure(element, nextLanguage);
    navigation = mountDocumentNavigation({ element, language: nextLanguage, values: informationValues, labels: labels[nextLanguage], iconPath, isExpanded, toggleValue });
    element.querySelector('.standard-return').addEventListener('click', () => onClose());
    element.querySelector('[data-standard-top]').addEventListener('click', () => { element.querySelector('.standard-scroll').scrollTop = 0; });
    element.querySelector('.standard-scroll').scrollTop = oldScroll;
    element.dataset.documentReady = 'true';
  }
  element.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    event.preventDefault(); reveal(decodeURIComponent(link.getAttribute('href').slice(1)));
  });
  await render(language);
  if (disposed) return null;
  center.classList.add('standard-document-host');
  page.dataset.document = 'standard';
  center.append(element);
  page.querySelector('[data-doc-topic="json"]')?.setAttribute('aria-current', 'page');
  return {
    element,
    updateLanguage(value) { if (value !== currentLanguage) return render(value).catch(onError); },
    close() {
      disposed = true; ordinal++;
      navigation?.dispose(); navigation = null;
      element.remove(); center.classList.remove('standard-document-host'); delete page.dataset.document;
      page.querySelector('[data-doc-topic="json"]')?.removeAttribute('aria-current');
    }
  };
}

function addConceptFigure(element, language) {
  const en = language === 'en';
  const first = element.querySelectorAll('.standard-level-2')[1];
  const point = [...(first?.querySelectorAll('p') ?? [])].find(p => p.textContent.includes(en ? 'nodes' : '节点之间的映射'));
  if (!point) return;
  const figure = document.createElement('figure');
  figure.className = 'standard-concept-figure';
  figure.setAttribute('aria-label', en ? 'Nodes, ordinal and mapping' : '节点、序数与映射');
  figure.innerHTML = `<svg viewBox="0 0 720 176" role="img" aria-label="${en ? 'A node, an ordered set, and relationships between nodes' : '独立的节点，有序的排列，节点间的映射'}"><g class="concept-lines" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="106" cy="67" r="34"/><circle cx="106" cy="67" r="24"/><path d="M280 67H422 M530 40L611 87L661 35M530 40L551 111L611 87"/><circle cx="286" cy="67" r="12"/><circle cx="351" cy="67" r="12"/><circle cx="416" cy="67" r="12"/><circle cx="530" cy="40" r="12"/><circle cx="611" cy="87" r="12"/><circle cx="661" cy="35" r="12"/><circle cx="551" cy="111" r="9"/></g><g fill="currentColor"><circle cx="106" cy="67" r="7"/><circle cx="286" cy="67" r="4"/><circle cx="351" cy="67" r="4"/><circle cx="416" cy="67" r="4"/></g><g text-anchor="middle" fill="currentColor" font-size="18"><text x="106" y="156">${en ? 'Node' : '节点'}</text><text x="351" y="156">${en ? 'Ordinal' : '序数'}</text><text x="600" y="156">${en ? 'Mapping' : '映射'}</text></g></svg>`;
  point.after(figure);
}
