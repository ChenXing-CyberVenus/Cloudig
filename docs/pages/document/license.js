import { mountDocumentNavigation } from './navigation.js';

const directory = '/Cloudig/pages/document';
const icon = (value, open = true) => `${directory}/assets/InfoValue-${value === 'core' ? 'Core' : 'Important'}${open ? '' : '-Grey'}.svg`;
const escape = value => String(value).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const frontispiece = en => `<figure class="standard-art license-hero">${['dawn', 'star-night'].map(theme => `<img class="license-art-${theme}" src="${directory}/assets/license-frontispiece-${theme}.png" width="2172" height="724" alt="${en ? 'Six companions share a luminous book in an open library; butterflies carry its light toward the city.' : '六位伙伴在敞开的书阁中共享发光的书，蝴蝶携着光飞向城邦。'}">`).join('')}</figure>`;

async function load(file) {
  const response = await fetch(`${directory}/content/${file}`);
  if (!response.ok) throw new Error(`License document unavailable: ${response.status}`);
  return response.json();
}

export async function mountLicenseDocument({ page, language = 'zh-CN', onClose, onError, copyText = text => navigator.clipboard.writeText(text) }) {
  const center = page.querySelector('.reader-main, .archiver-center');
  if (!center) throw new Error('The license needs an existing central reading surface.');
  const publication = await load('license.json');
  const element = document.createElement('section');
  element.className = 'standard-document license-document';
  let currentLanguage = language, coreOpen = true, disposed = false, navigation = null;
  let appendix = null, appendixLoading = false, copyBusy = false, noticeOpen = false;
  const expandedComponents = new Set();
  const en = () => currentLanguage === 'en';
  const scroll = () => element.querySelector('.standard-scroll');
  const report = (text, error = false) => {
    const node = element.querySelector('.license-status'); node.textContent = text; node.dataset.error = String(error);
  };
  function setCore(open) {
    coreOpen = open;
    element.querySelector('.license-original').hidden = !open;
    const button = element.querySelector('[data-license-core]');
    button.setAttribute('aria-expanded', String(open)); button.querySelector('img').src = icon('core', open);
    navigation?.refresh();
  }
  function reveal(id) {
    const target = element.querySelector(`#${id}`);
    if (!target) return;
    if (target.closest('.license-core-section')) setCore(true);
    navigation?.close();
    scroll().scrollTop += target.getBoundingClientRect().top - scroll().getBoundingClientRect().top - 24;
    target.tabIndex = -1; target.focus({ preventScroll: true });
  }
  function renderComponents() {
    const container = element.querySelector('.license-components');
    if (!appendix) return;
    const result = document.createDocumentFragment();
    for (const [i, component] of appendix.components.entries()) {
      const item = document.createElement('details'); item.className = 'license-component'; item.open = expandedComponents.has(i);
      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="license-component-name">${escape(component.name)} <small>${escape(component.version)}</small></span><span class="license-component-license">${escape(component.declared_license ?? (en() ? 'See original license' : '见许可原文'))}</span><span class="license-disclosure" aria-hidden="true">⌄</span>`;
      item.append(summary);
      const fill = () => {
        if (!item.open || item.querySelector('pre')) return;
        for (const license of component.licenses) {
          const label = document.createElement('h4'); label.textContent = license.name;
          const text = document.createElement('pre'); text.textContent = license.text;
          item.append(label, text);
        }
      };
      fill(); item.addEventListener('toggle', () => { if (disposed || !element.contains(item)) return; item.open ? expandedComponents.add(i) : expandedComponents.delete(i); fill(); });
      result.append(item);
    }
    container.replaceChildren(result);
  }
  async function openComponents() {
    if (appendixLoading) return;
    appendixLoading = true;
    const button = element.querySelector('[data-license-components]'); button.disabled = true;
    try {
      appendix ??= await load('license-third-party.json');
      if (disposed) return;
      renderComponents();
      element.querySelector('[data-license-components]').hidden = true;
      report(en() ? `${appendix.components.length} bundled components. Open a row to read its original license.` : `共${appendix.components.length}项随包组件，展开条目可读各自许可原文。`);
    } catch {
      if (!disposed) report(en() ? 'Could not load the component notices. Please retry; the JOG license above is still complete.' : '未能读取组件声明，请重试；上方JOG许可全文不受影响。', true);
    } finally {
      appendixLoading = false;
      if (!disposed) element.querySelector('[data-license-components]').disabled = false;
    }
  }
  async function copy() {
    if (copyBusy) return;
    copyBusy = true; element.querySelector('[data-license-copy]').disabled = true;
    try {
      await copyText(publication.full_text);
      if (!disposed) report(en() ? 'Full Chinese and English license copied.' : '已复制完整中英许可原文。');
    } catch {
      if (!disposed) report(en() ? 'Copy failed. You can select and copy the text below, or retry.' : '复制未完成，可直接选择下方正文复制，或再次重试。', true);
    } finally { copyBusy = false; if (!disposed) element.querySelector('[data-license-copy]').disabled = false; }
  }
  function render(nextLanguage) {
    if (disposed) return;
    const oldScroll = scroll()?.scrollTop ?? 0;
    navigation?.dispose(); currentLanguage = nextLanguage;
    const data = publication.languages[currentLanguage];
    const title = publication.titles[en() ? 1 : 0];
    element.setAttribute('aria-label', title);
    element.innerHTML = `<header class="standard-bar license-bar">
      <div class="standard-bar-title"><strong>LICENSE</strong><small>${publication.id}</small></div>
      <div class="standard-controls">
        <button type="button" class="standard-category-toggle" data-standard-menu="core" aria-controls="license-navigation" aria-expanded="false" aria-pressed="true"><img src="${icon('core', coreOpen)}" alt=""><span>${en() ? 'Core' : '核心'}</span></button>
        <button type="button" class="standard-toc-toggle" data-standard-menu="all" aria-controls="license-navigation" aria-expanded="false">☷ ${en() ? 'Contents' : '目录'} ⌄</button>
        <button type="button" class="license-text-button" data-license-language>${en() ? '中文' : 'English'}</button>
        <button type="button" class="license-text-button" data-license-copy>${en() ? 'Copy full license' : '复制全文'}</button>
      </div>
      <button type="button" class="standard-return cloudig-button cloudig-button-filled">↶ ${en() ? 'Return' : '返回'}</button>
      <section id="license-navigation" class="standard-nav-panel" hidden><header><div><strong class="standard-nav-heading"></strong><span class="standard-nav-count"></span></div><p>${en() ? 'The license is one complete Core text. Chapter links reveal it in full.' : '许可全文是一个完整的核心单元；跳转条款会展开全文。'}</p></header><nav data-scroll-region tabindex="-1"></nav></section>
    </header>
    <div class="standard-scroll" data-scroll-region tabindex="0">
      <header class="standard-frontispiece license-frontispiece"><p class="standard-kicker">JUSTICE FOR OPEN GOOD</p><h1>${escape(title)}</h1><p class="standard-byline license-byline">${en() ? 'Version' : '版本'} ${publication.version} · ${publication.date}<br>${en() ? 'Copyright ' : '版权所有 '}${escape(publication.copyright)}</p>${frontispiece(en())}</header>
      <div class="license-reading">
        <section id="license-core" class="license-core-section"><h2 class="license-section-heading"><button type="button" class="license-value-toggle" data-license-core aria-expanded="${coreOpen}" aria-controls="license-original" aria-label="${en() ? 'Collapse or expand the entire license' : '折叠或展开完整许可'}"><img src="${icon('core', coreOpen)}" alt=""></button>${en() ? 'License text' : '许可全文'}<span>${en() ? 'Core' : '核心'}</span></h2>
          <article id="license-original" class="license-original" lang="${currentLanguage}">${data.html}</article>
        </section>
        <section id="license-notices" class="license-notices"><h2 class="license-section-heading"><img src="${icon('important')}" alt="${en() ? 'Important' : '重要'}">${en() ? 'Independent notices' : '独立权利声明'}</h2>
          <p>${en() ? 'Third-party components and service marks keep their own rights and licenses. The following notices are separate from JOG-1.1 and retain their original wording.' : '第三方组件与平台标志保有各自的权利及许可。以下声明独立于JOG-1.1，并保留原文。'}</p>
          <details class="license-notice-original"><summary>${en() ? 'Cloudig notices · original text' : '采云权利声明 · 英文原文'} <span aria-hidden="true">⌄</span></summary><div lang="en">${publication.notice.html}</div></details>
          <h3 id="license-components-title">${en() ? 'Bundled software licenses' : '随包软件组件许可'}</h3>
          <button type="button" class="license-text-button license-load" data-license-components>${en() ? 'Read component licenses →' : '查看组件许可 →'}</button><div class="license-components"></div>
        </section>
        <footer class="license-colophon"><span>${publication.id} · 晨星 ChenXing &amp; 奥思 Osis</span><button type="button" class="license-text-button" data-license-top>${en() ? 'Back to top ↑' : '回到篇首 ↑'}</button></footer>
      </div>
    </div><p class="license-status" role="status" aria-live="polite"></p>`;
    element.querySelector('[data-license-core]').addEventListener('click', () => setCore(!coreOpen));
    element.querySelector('[data-license-copy]').addEventListener('click', copy);
    element.querySelector('[data-license-language]').addEventListener('click', () => render(en() ? 'zh-CN' : 'en'));
    element.querySelector('[data-license-components]').addEventListener('click', openComponents);
    element.querySelector('[data-license-top]').addEventListener('click', () => { scroll().scrollTop = 0; });
    element.querySelector('.standard-return').addEventListener('click', onClose);
    const notice = element.querySelector('.license-notice-original'); notice.open = noticeOpen;
    notice.addEventListener('toggle', () => { if (!disposed && element.contains(notice)) noticeOpen = notice.open; });
    const entries = [{ id: 'license-core', label: en() ? 'Complete license' : '完整许可', rank: 2, value: 'core' }, ...data.sections,
      { id: 'license-notices', label: en() ? 'Independent notices' : '独立权利声明', rank: 2, value: 'important' },
      { id: 'license-components-title', label: en() ? 'Bundled software licenses' : '随包软件组件许可', rank: 3, value: 'important' }];
    for (const entry of entries) entry.node = { value: entry.value };
    navigation = mountDocumentNavigation({ element, language: currentLanguage, values: ['core', 'important'], labels: en() ? ['Core', 'Important'] : ['核心', '重要'], iconPath: icon,
      entries, isExpanded: node => !node || node.value !== 'core' || coreOpen, toggleValue: () => setCore(!coreOpen) });
    setCore(coreOpen);
    if (appendix) { renderComponents(); element.querySelector('[data-license-components]').hidden = true; }
    if (appendixLoading) element.querySelector('[data-license-components]').disabled = true;
    element.querySelector('[data-license-copy]').disabled = copyBusy;
    scroll().scrollTop = oldScroll;
    element.dataset.documentReady = 'true';
  }
  element.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (link) { event.preventDefault(); reveal(link.getAttribute('href').slice(1)); }
  });
  render(language);
  center.classList.add('standard-document-host'); center.append(element); page.dataset.document = 'license';
  page.querySelector('[data-doc-topic="license"]')?.setAttribute('aria-current', 'page');
  return { element, updateLanguage(value) { if (value !== currentLanguage) render(value); }, close() {
    disposed = true; navigation?.dispose(); element.remove(); center.classList.remove('standard-document-host'); delete page.dataset.document;
    page.querySelector('[data-doc-topic="license"]')?.removeAttribute('aria-current');
  } };
}
