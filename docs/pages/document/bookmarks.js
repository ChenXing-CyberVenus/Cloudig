import { mountDocumentNavigation } from './navigation.js';

const base = '/Cloudig/pages/document';
const values = ['core', 'important', 'general', 'fold'];
const names = ['Core', 'Important', 'General', 'Fold'];
const escape = value => String(value).replace(/[&<>"']/gu, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const icon = (value, open = true) => `${base}/assets/InfoValue-${names[values.indexOf(value)]}${open ? '' : '-Grey'}.svg`;
const profiles = ['light', 'full', 'tree'];
const platformOrder = ['chatgpt','claude','gemini','deepseek','grok','kimi','mistral','qwen','chatglm','zai','yuanbao','doubao'];
const svg = `<svg class="bookmark-pair-art" viewBox="0 0 460 150" aria-hidden="true"><g stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="22" y="18" width="132" height="100" rx="10"/><path d="M22 40h132M36 29h1m8 0h1m8 0h1M61 64L47 79l14 15m50-30 14 15-14 15m-19-34-13 38M164 78h120m-12-8 12 8-12 8M328 27c27-8 48-2 62 12v87c-14-14-35-20-62-12zm62 12c14-14 35-20 62-12v87c-27-8-48-2-62 12M341 48l35 10m-35 5 35 10m-35 5 35 10m29-30 34-10m-34 25 34-10m-34 25 34-10"/></g><circle cx="222" cy="78" r="19" fill="var(--standard-paper)" stroke="currentColor" stroke-width="2"/><path d="m213 78 6 6 12-13" fill="none" stroke="currentColor" stroke-width="3"/></svg>`;
async function load(name) { const r = await fetch(`${base}/content/${name}.json`); if (!r.ok) throw new Error('Public documentation unavailable'); return r.json(); }

export async function mountBookmarkDocument({ page, language, topic = 'bookmark', restore = {}, onClose, onDocument, onDemo, onChrome, onExternal, onError, environment = 'desktop', onDownloadRecord }) {
  const center = page.querySelector('.reader-main, .archiver-center');
  if (!center) throw new Error('Bookmark documents need the existing central surface');
  const [zh, english, catalog] = await Promise.all([load(`${topic}-zh-CN`), load(`${topic}-en`), topic === 'platforms' ? load('examples') : null]);
  const element = document.createElement('section'); element.className = 'standard-document bookmark-document';
  let lang = language, selected = restore.example ?? catalog?.examples.find(e => e.platform === 'chatgpt' && e.profile === 'light')?.id;
  let navigation, disposed = false, busy = false;
  let platformDirectoryOpen = Boolean(restore.platformDirectoryOpen);
  const collapsed = new Set(restore.collapsed ?? []);
  const browser = environment === 'browser';
  const en = () => lang === 'en', scroll = () => element.querySelector('.standard-scroll');
  const entry = () => catalog?.examples.find(e => e.id === selected);
  const scenarioLabel = scenario => en() ? ({'快速模式':'Fast mode','识图模式':'Vision mode'})[scenario] ?? scenario : ({Chat:'普通对话',Schedule:'定时任务',Cowork:'Cowork'})[scenario] ?? scenario;
  const profileLabel = profile => en() ? ['Light','Full','Tree'][profiles.indexOf(profile)] : ['轻装 Light','全量 Full','整树 Tree'][profiles.indexOf(profile)];
  function reveal(id) {
    const section = element.querySelector(`#${id}`); if (!section) return;
    collapsed.delete(id); applyFold(); navigation.close();
    scroll().scrollTop += section.getBoundingClientRect().top - scroll().getBoundingClientRect().top - 24;
  }
  function applyFold() {
    for (const section of element.querySelectorAll('[data-public-section]')) {
      const open = !collapsed.has(section.id); section.dataset.collapsed = String(!open);
      section.querySelector('.standard-section-body').hidden = !open;
      const button = section.querySelector('.standard-value-toggle'); button.setAttribute('aria-expanded', String(open)); button.querySelector('img').src = icon(section.dataset.infovalue, open);
    }
    navigation?.refresh();
  }
  function toggleValue(value) {
    const sections = [...element.querySelectorAll(`[data-public-section][data-infovalue="${value}"]`)];
    const allOpen = sections.every(s => !collapsed.has(s.id)); for (const s of sections) allOpen ? collapsed.add(s.id) : collapsed.delete(s.id); applyFold();
  }
  function choose(id) { if (!catalog.examples.some(e => e.id === id)) return; selected = id; renderCatalog(); }
  function renderCatalog() {
    const e = entry(), host = element.querySelector('.platform-catalog-body'); if (!e || !host) return;
    const group = catalog.examples.filter(i => i.platform === e.platform);
    const scenarios = [...new Set(group.map(i => i.scenario))];
    const version = e.exporter?.version ?? '—';
    const platformName = item => en() ? ({yuanbao:'Tencent Yuanbao',doubao:'Doubao'})[item.platform] ?? item.platform_name : item.platform_name;
    host.innerHTML = `<p class="bookmark-step-label">01 · ${en() ? 'Choose a platform' : '选择平台'}</p><div class="example-platforms" role="group" aria-label="${en() ? 'Platforms' : '平台'}">${platformOrder.map(p => catalog.examples.find(i => i.platform === p)).filter(Boolean).map(i => `<button type="button" data-example-platform="${i.platform}" aria-pressed="${i.platform === e.platform}"><span class="example-platform-logo" data-platform="${i.platform}"><img src="/Cloudig/assets/platforms/platform-${i.platform}.${i.platform === 'doubao' ? 'png' : 'svg'}" alt=""></span>${escape(platformName(i))}</button>`).join('')}</div>
      <div class="example-choice-line"><div><p class="bookmark-step-label">02 · ${en() ? 'Conversation scenario' : '会话场景'}</p><div class="example-scenarios" role="group" aria-label="${en() ? 'Scenarios' : '场景'}">${scenarios.map(s => `<button type="button" class="example-choice" data-example-scenario="${escape(s)}" aria-pressed="${s === e.scenario}">${escape(scenarioLabel(s))}</button>`).join('')}</div></div><div><p class="bookmark-step-label">03 · ${en() ? 'Export profile' : '导出档位'}</p><div class="example-profiles" role="group" aria-label="${en() ? 'Profiles' : '档位'}">${profiles.map(p => `<button type="button" class="example-choice" data-example-profile="${p}" aria-pressed="${p === e.profile}" ${!group.some(i => i.scenario === e.scenario && i.profile === p) ? 'disabled' : ''}>${profileLabel(p)}</button>`).join('')}</div></div></div>
      <article class="example-pair" data-example-id="${e.id}"><p class="example-pair-kicker">${en() ? 'ONE SOURCE · TWO VIEWS' : '同一份原件 · 两种阅读'}</p><h3>${escape(platformName(e))} <span>· ${escape(scenarioLabel(e.scenario))} · ${profileLabel(e.profile)}</span></h3><p class="example-pair-note">${browser ? (en() ? 'Open the original HTML in a new tab, or read the parsed conversation with the same Cloudig Reader.' : '在新标签阅读原HTML，或用与采云同源的Reader查看解析结果。') : (en() ? 'Open the original export in Chrome, or explore its parsed counterpart with the real Cloudig Reader.' : '在Chrome阅读书签导出的原HTML，或在采云真实Reader里查看对应解析结果。')}</p>
      <div class="example-pair-actions"><button type="button" class="cloudig-button cloudig-button-outline" data-example-chrome>${browser ? (en() ? 'Original HTML ↗' : '原始 HTML ↗') : (en() ? 'Original HTML · Chrome ↗' : '原始 HTML · Chrome ↗')}</button><button type="button" class="cloudig-button cloudig-button-filled" data-example-reader>${en() ? 'Explore in Reader →' : '在采云中演示 →'}</button>${browser ? `<button type="button" class="cloudig-button cloudig-button-outline" data-example-record>${en() ? 'Download JSON ↓' : '下载 JSON ↓'}</button>` : ''}</div>
      <dl class="example-facts"><div><dt>${en() ? 'Bookmarklet' : '书签版本'}</dt><dd>${escape(version)}</dd></div><div><dt>Parser / Adapter</dt><dd>${escape(e.parser.version)} / ${escape(e.parser.adapter.version)}</dd></div><div><dt>${en() ? 'Messages / embedded resources' : '消息 / 内嵌资源'}</dt><dd>${e.messages} / ${e.resources}</dd></div></dl>
      <p class="example-readonly">${browser ? (en() ? 'Read-only public examples. Original HTML and Conversation JSON are also available to download.' : '公开范例只读演示；也可下载原HTML与Conversation JSON。') : (en() ? 'Read-only demonstration: no imports, Marks or Library changes. Use the original HTML in Chrome to download attachments. Unsupported profiles remain unavailable.' : '只读演示，不导入文件、不创建Mark、不修改资料库；如需下载附件，请在Chrome打开原HTML。不支持的档位不可选。')}</p><p class="example-status" role="status" aria-live="polite"></p></article>`;
    host.querySelectorAll('[data-example-platform]').forEach(b => b.addEventListener('click', () => { const candidates = catalog.examples.filter(i => i.platform === b.dataset.examplePlatform); choose((candidates.find(i => i.profile === e.profile) ?? candidates[0]).id); }));
    host.querySelectorAll('[data-example-scenario]').forEach(b => b.addEventListener('click', () => { const candidates = group.filter(i => i.scenario === b.dataset.exampleScenario); choose((candidates.find(i => i.profile === e.profile) ?? candidates[0]).id); }));
    host.querySelectorAll('[data-example-profile]').forEach(b => b.addEventListener('click', () => choose(group.find(i => i.scenario === e.scenario && i.profile === b.dataset.exampleProfile).id)));
    const run = async (kind) => {
      if (busy) return; busy = true; host.querySelectorAll('button').forEach(b => b.disabled = true);
      const status = host.querySelector('.example-status'); status.textContent = en() ? 'Opening…' : '正在打开…';
      try {
        if (kind === 'reader') await onDemo(e, snapshot());
        else { const result = await onChrome(e.id); if (!disposed) status.textContent = result.opened ? (browser ? (en() ? 'Requested a new browser tab.' : '已请求在新标签打开。') : (en() ? 'Opened in Chrome.' : '已在Chrome打开。')) : (en() ? 'Chrome launch plan verified (offscreen audit).' : '已验证Chrome启动计划（离屏审查）。'); }
      } catch (error) { if (!disposed) { status.textContent = en() ? 'Could not open. Please retry.' : '未能打开，请重试。'; onError(error); } }
      finally { busy = false; if (!disposed) { const message = status.textContent; renderCatalog(); host.querySelector('.example-status').textContent = message; } }
    };
    host.querySelector('[data-example-reader]').addEventListener('click', () => run('reader'));
    host.querySelector('[data-example-chrome]').addEventListener('click', () => run('chrome'));
    host.querySelector('[data-example-record]')?.addEventListener('click', () => onDownloadRecord?.(e));
  }
  function snapshot() { return { example: selected, collapsed: [...collapsed], scroll: scroll()?.scrollTop ?? 0, platformDirectoryOpen: element.querySelector('[data-platform-directory]')?.open ?? platformDirectoryOpen }; }
  function render(language, initialScroll = scroll()?.scrollTop ?? 0) {
    platformDirectoryOpen = element.querySelector('[data-platform-directory]')?.open ?? platformDirectoryOpen;
    navigation?.dispose(); lang = language;
    const publication = en() ? english : zh, labels = en() ? names : ['核心','重要','常规','折叠'];
    const sections = [...publication.sections];
    if (topic === 'platforms') sections.splice(1, 0, { id: 'platform-catalog', label: en() ? 'Explore the paired examples' : '阅读平台范例', value: 'general', html: '<div class="platform-catalog-body"></div>' });
    element.innerHTML = `<header class="standard-bar"><div class="standard-bar-title"><strong>${topic === 'bookmark' ? (en() ? 'Bookmarklets' : '书签指南') : (en() ? 'Examples' : '平台范例')}</strong></div><div class="standard-controls">${values.map((v,i) => `<button type="button" class="standard-category-toggle" data-standard-menu="${v}" aria-controls="bookmark-navigation" aria-expanded="false"><img src="${icon(v)}" alt=""><span>${labels[i]}</span></button>`).join('')}<button type="button" class="standard-toc-toggle" data-standard-menu="all" aria-controls="bookmark-navigation" aria-expanded="false">☷ ${en() ? 'Contents' : '目录'} ⌄</button></div><button type="button" class="standard-return cloudig-button cloudig-button-filled">↶ ${en() ? 'Return' : '返回'}</button><section id="bookmark-navigation" class="standard-nav-panel" hidden><header><div><strong class="standard-nav-heading"></strong><span class="standard-nav-count"></span></div><p>${en() ? 'Hover a value to navigate; click it to fold or reveal the category.' : '悬停信息价值查看目录；点击图标折叠或展开该档。'}</p></header><nav data-scroll-region tabindex="-1"></nav></section></header>
      <div class="standard-scroll" data-scroll-region tabindex="0"><div class="bookmark-reading"><header class="bookmark-frontispiece">${svg}<p class="bookmark-kicker">${topic === 'bookmark' ? 'KEEP THE CONVERSATION' : 'FROM SOURCE TO READER'}</p><h1>${escape(publication.title)}</h1><p>${en() ? 'Export it. Keep it. Read it your way.' : '从云端带走，在此地长存。'}</p><button type="button" class="bookmark-crosslink" data-document-target="${topic === 'bookmark' ? 'platforms' : 'bookmark'}">${topic === 'bookmark' ? (en() ? 'Explore real examples →' : '查看真实平台范例 →') : (en() ? 'Read the bookmarklet guide →' : '阅读书签指南 →')}</button></header><article class="standard-prose">${sections.map(s => `<section class="standard-section" id="${s.id}" data-public-section data-infovalue="${s.value}"><h2 data-section-heading><button type="button" class="standard-value-toggle" aria-expanded="true" aria-controls="${s.id}-body" aria-label="${en() ? 'Fold or expand' : '折叠或展开'} ${escape(s.label)}"><img src="${icon(s.value)}" alt=""></button>${escape(s.label)}</h2><div class="standard-section-body" id="${s.id}-body">${s.html}</div></section>`).join('')}</article><footer class="bookmark-colophon">Cloudig · <button type="button" data-bookmark-top>${en() ? 'Back to top ↑' : '回到篇首 ↑'}</button></footer></div></div>`;
    navigation = mountDocumentNavigation({ element, language: lang, values, labels, iconPath: icon, isExpanded: node => !collapsed.has(node.id), toggleValue });
    element.querySelectorAll('.standard-value-toggle').forEach(button => button.addEventListener('click', () => { const id = button.closest('section').id; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); applyFold(); }));
    element.querySelector('.standard-return').addEventListener('click', onClose);
    const platformDirectory = element.querySelector('[data-platform-directory]');
    if (platformDirectory) platformDirectory.open = platformDirectoryOpen;
    element.querySelector('[data-bookmark-top]').addEventListener('click', () => { scroll().scrollTop = 0; });
    if (catalog) renderCatalog(); applyFold(); scroll().scrollTop = initialScroll;
    element.dataset.documentReady = 'true';
  }
  element.addEventListener('click', event => {
    const target = event.target.closest('[data-document-target], a'); if (!target) return;
    event.preventDefault();
    if (target.dataset.documentTarget) onDocument(target.dataset.documentTarget);
    else if (target.dataset.exampleFile && catalog) { const found = catalog.examples.find(e => e.html.file === target.dataset.exampleFile); if (found) { choose(found.id); reveal('platform-catalog'); } }
    else if (target.getAttribute('href')?.startsWith('#')) reveal(target.getAttribute('href').slice(1));
    else if (/^https?:\/\//u.test(target.href)) onExternal(target.href);
  });
  render(lang, restore.scroll ?? 0); center.classList.add('standard-document-host'); center.append(element); page.dataset.document = topic;
  page.querySelector(`[data-doc-topic="${topic}"]`)?.setAttribute('aria-current','page');
  // Set after mounting: scroll ranges do not exist while detached.
  scroll().scrollTop = restore.scroll ?? 0;
  return { element, snapshot, updateLanguage(value) { if (value !== lang) render(value); }, close() { disposed = true; navigation?.dispose(); element.remove(); center.classList.remove('standard-document-host'); delete page.dataset.document; page.querySelector(`[data-doc-topic="${topic}"]`)?.removeAttribute('aria-current'); } };
}
