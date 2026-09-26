import { mountStandardDocument } from './pages/document/document.js';
import { mountHistoryDocument } from './pages/document/history.js';
import { mountLicenseDocument } from './pages/document/license.js';
import { mountBookmarkDocument } from './pages/document/bookmarks.js';
import { mountFeatureDocument } from './pages/document/features.js';
import { publicExampleRoute } from './pages/document/examples-links.js';
const root = document.documentElement, host = document.querySelector('.site-reading');
const topics = ['bookmark', 'archive', 'platforms', 'standard', 'roadmap', 'license'];
const names = { 'zh-CN': ['书签指南', '采云功能', '平台范例', '采云标准', '历史与未来', 'LICENSE'], en: ['Bookmarklets', 'Features', 'Examples', 'Cloudig Standard', 'History & Future', 'LICENSE'] };
const state = { theme: root.dataset.theme, language: root.lang };
const base = new URL('.', import.meta.url);
const url = path => new URL(path, base).href;
const workRuntime = { frameUrl: url('runtime/interactive-frame.html'), dependencies: url('runtime/dependencies/') };
let active = null, generation = 0, currentTopic = 'standard', restoreExamples = {}, currentDemo = null;
const en = () => state.language === 'en';
const errorBox = document.querySelector('.site-error');
function report(error) { console.error(error); errorBox.querySelector('span').textContent = en() ? 'This page could not be loaded. Please retry.' : '这页没有加载完成，请重试。'; errorBox.hidden = false; }
function external(value) { const target = new URL(value, base); if (['http:', 'https:'].includes(target.protocol))
    window.open(target.href, '_blank', 'noopener,noreferrer'); }
function download(path, filename) { const a = document.createElement('a'); a.href = url(path); a.download = filename; document.body.append(a); a.click(); a.remove(); }
async function json(path, signal) { const r = await fetch(url(path), { signal }); if (!r.ok)
    throw new Error(`Unable to load ${path}: ${r.status}`); return r.json(); }
function labels() {
    root.lang = state.language;
    root.dataset.theme = state.theme;
    document.querySelector('[data-site-heading]').innerHTML = en() ? 'From the cloud.<br>Here to stay.' : '从云端带走<br>在此地长存';
    document.querySelector('[data-site-navigation]').innerHTML = topics.map((topic, i) => `<a href="#${topic}" data-site-topic="${topic}" ${topic === currentTopic ? 'aria-current="page"' : ''}><span>${String(i + 1).padStart(2, '0')}</span>${names[state.language][i]}</a>`).join('');
    const theme = document.querySelector('[data-site-theme]');
    theme.textContent = state.theme === 'dawn' ? (en() ? '☾ StarNight' : '☾ 星夜') : (en() ? '☀ Dawn' : '☀ 破晓');
    theme.title = en() ? 'Switch Dawn / StarNight theme' : '切换破晓／星夜主题';
    theme.setAttribute('aria-label', theme.title);
    document.querySelector('[data-site-language]').textContent = en() ? '中文' : 'English';
    document.querySelector('[data-site-download]').textContent = en() ? 'Download ↗' : '下载采云 ↗';
    document.title = `${names[state.language][topics.indexOf(currentTopic)]} · Cloudig`;
}
function savePreferences() { try {
    localStorage.setItem('cloudig-docs-theme', state.theme);
    localStorage.setItem('cloudig-docs-language', state.language);
}
catch { } }
function routeTopic() { const topic = location.hash.slice(1).split('/')[0]; return topics.includes(topic) ? topic : 'standard'; }
function go(topic) { if (!topics.includes(topic))
    topic = 'standard'; if (location.hash === `#${topic}`)
    void openTopic(topic);
else
    location.hash = topic; }
async function openTopic(topic) {
    const ticket = ++generation;
    active?.close();
    active = null;
    currentDemo = null;
    currentTopic = topic;
    delete host.dataset.ready;
    errorBox.hidden = true;
    labels();
    const page = document.createElement('div');
    page.className = 'site-page';
    page.dataset.page = 'archiver';
    page.innerHTML = `<div class="archiver-center"><p class="site-loading" role="status">${en() ? 'Opening…' : '正在翻开…'}</p></div>`;
    host.replaceChildren(page);
    const mount = ({ archive: mountFeatureDocument, bookmark: mountBookmarkDocument, platforms: mountBookmarkDocument, roadmap: mountHistoryDocument, license: mountLicenseDocument })[topic] ?? mountStandardDocument;
    try {
        const route = topic === 'platforms' ? publicExampleRoute(location.hash) : null;
        const linkedExample = route ? (await catalogReady).examples.find(e => e.id === route.id) : null;
        const exampleRestore = linkedExample ? { ...restoreExamples, example: linkedExample.id, revealExample: true } : restoreExamples;
        const instance = await mount({ page, language: state.language, topic, restore: topic === 'platforms' ? exampleRestore : {}, onClose: () => { document.querySelector(`[data-site-topic="${topic}"]`)?.focus(); }, onError: report, onDocument: go, environment: 'browser',
            onExternal: external, onDemo: openDemo,
            onChrome: async (id) => { const e = catalog.examples.find(item => item.id === id); if (!e)
                throw Error('Unknown example'); external(url(`examples/${e.html.path}`)); return { opened: true }; },
            onDownloadHtml: e => download(`examples/${e.html.path}`, e.html.file),
            onDownloadRecord: e => download(`examples/${e.record.path}`, e.html.file.replace(/\.html$/u, '.json')) });
        if (ticket !== generation) {
            instance?.close();
            return;
        }
        active = instance;
        // There is no desktop cover to return to. This button reveals the website
        // document navigation instead; on wide screens it focuses the current item.
        const back = instance.element.querySelector('.standard-return');
        back.textContent = en() ? '↑ Documents' : '↑ 文档导航';
        back.setAttribute('aria-label', back.textContent);
        page.querySelector('.site-loading')?.remove();
        host.dataset.ready = 'true';
        if (linkedExample && route.action === 'reader') await openDemo(linkedExample, instance.snapshot());
        else if (linkedExample && route.action.startsWith('download-')) {
            // An explicit download link from Cloudig requests this one public
            // file only. The normal buttons remain if the browser blocks it.
            const selector = route.action === 'download-html' ? '[data-example-html-download]' : '[data-example-record]';
            history.replaceState(null, '', `#platforms/${linkedExample.id}/view`);
            instance.element.querySelector(selector).click();
        }
    }
    catch (error) {
        if (ticket === generation)
            report(error);
    }
}
let catalog;
const catalogReady = json('pages/document/content/examples.json').then(value => { catalog = value; return value; });
// Avoid unhandled rejection; routing displays the error when the catalog is used.
catalogReady.catch(() => { });
async function openDemo(example, snapshot) {
    restoreExamples = snapshot;
    const ticket = ++generation;
    active?.close();
    active = null;
    currentDemo = example;
    delete host.dataset.ready;
    errorBox.hidden = true;
    const page = document.createElement('div');
    page.className = 'site-page site-demo';
    page.dataset.page = 'reader';
    page.innerHTML = '<div class="reader-main"></div><aside class="reader-navigation"></aside>';
    host.replaceChildren(page);
    const abort = new AbortController(), objectUrls = new Map();
    let mounted, prepared, record, session;
    active = { close() { abort.abort(); mounted?.cleanup(); for (const u of objectUrls.values())
            URL.revokeObjectURL(u); } };
    try {
        const [{ mountReaderConversation, defaultReaderSession }, { preparePublicReading }, locale] = await Promise.all([import('./pages/reader/reader-conversation.js'), import('./public-reading.js'), json(`locales/${state.language}.json`, abort.signal)]);
        if (ticket !== generation)
            return;
        session = structuredClone(defaultReaderSession);
        const translate = key => key.split('.').reduce((v, k) => v?.[k], locale) ?? key;
        const builtins = { user: { name: '采云用户', avatar: 'Assets/Defaults/user.svg', localizedNames: { 'zh-CN': '采云用户', en: 'User' } }, assistant: { name: '智能伙伴', avatar: 'Assets/Defaults/assistant.svg', localizedNames: { 'zh-CN': '智能伙伴', en: 'AI' } }, platforms: Object.fromEntries(catalog.examples.map(e => [e.platform, { name: e.platform_name, avatar: `Assets/Platforms/${e.platform}.svg` }])) };
        const readerSession = s => ({ ...s, ...(s.selected_leaf ? { selectedLeaf: s.selected_leaf } : {}), ...(s.branch_choices ? { branchChoices: s.branch_choices } : {}) });
        const resourceUrl = id => {
            if (objectUrls.has(id))
                return objectUrls.get(id);
            const resource = record.resources?.find(r => r.id === id), data = resource?.data_base64;
            if (!data)
                throw Error('No embedded resource');
            const bytes = Uint8Array.from(atob(Array.isArray(data) ? data.join('') : data), c => c.charCodeAt(0));
            const link = URL.createObjectURL(new Blob([bytes], { type: resource.mime ?? 'application/octet-stream' }));
            objectUrls.set(id, link);
            return link;
        };
        const avatar = reference => reference === 'Assets/Defaults/user.svg' ? 'assets/welcome/OsisLogo-Cloudig-1024.png' : reference === 'Assets/Defaults/assistant.svg' ? 'assets/welcome/OsisLogo-Simple.svg' : `assets/platforms/platform-${/^Assets\/Platforms\/([a-z0-9-]+)\.svg$/u.exec(reference)?.[1] ?? 'unknown'}.${reference.includes('/doubao.') ? 'png' : 'svg'}`;
        mounted = mountReaderConversation({ page, template: document.querySelector('#reader-conversation-template'), state: { ...state }, row: { example: example.id, title: example.html.file.replace(/\.html$/u, ''), platform: example.platform, messages: example.messages }, view: {}, loading: true, session, translate, readOnly: true, onExampleReturn: () => go('platforms'), onError: report,
            requestPage: async (s, offsets) => prepared.page(readerSession(s), offsets), onSessionChange: s => { session = s; },
            resolveAvatar: async (reference) => ({ url: url(avatar(String(reference))) }), resolveResource: async (resource) => ({ url: resourceUrl(resource.id) }), workRuntime, onOpenExternal: external });
        page.querySelector('[data-route-target="reader-cover"]')?.addEventListener('click', () => go('platforms'));
        record = await json(`examples/${example.record.path}`, abort.signal);
        if (ticket !== generation)
            return;
        prepared = preparePublicReading(record, state.language, builtins);
        mounted.replaceView(prepared.page(readerSession(session)));
        active.updateTheme = () => mounted.updateState({ ...state });
        host.dataset.ready = 'true';
    }
    catch (error) {
        if (ticket === generation && error.name !== 'AbortError') {
            mounted?.setLoading('failed');
            report(error);
        }
    }
}
document.addEventListener('click', event => { const a = event.target.closest('[data-site-topic]'); if (!a)
    return; event.preventDefault(); go(a.dataset.siteTopic); });
document.querySelector('.site-skip').addEventListener('click', event => { event.preventDefault(); host.focus(); });
document.querySelector('[data-site-theme]').addEventListener('click', () => { state.theme = state.theme === 'dawn' ? 'star-night' : 'dawn'; savePreferences(); labels(); active?.updateTheme?.(); });
document.querySelector('[data-site-language]').addEventListener('click', () => { state.language = en() ? 'zh-CN' : 'en'; savePreferences(); labels(); if (currentDemo)
    void openDemo(currentDemo, restoreExamples);
else
    void openTopic(currentTopic); });
document.querySelector('[data-site-retry]').addEventListener('click', () => { if (currentDemo)
    void openDemo(currentDemo, restoreExamples);
else
    void openTopic(currentTopic); });
document.querySelector('[data-site-dismiss]').addEventListener('click', () => { errorBox.hidden = true; });
window.addEventListener('hashchange', () => void openTopic(routeTopic()));
// Same scrollbar interaction rule as the desktop shell: region hover is idle,
// the thumb hit/drag is active. Only this controller is website-owned.
let dragged = null;
const owners = () => [...document.querySelectorAll('[data-scroll-region]')];
function hit(node, e) { const r = node.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && ((node.scrollHeight > node.clientHeight + 1 && e.clientX >= r.right - Math.max(node.offsetWidth - node.clientWidth, 8)) || (node.scrollWidth > node.clientWidth + 1 && e.clientY >= r.bottom - Math.max(node.offsetHeight - node.clientHeight, 8))); }
function scrollState(e) { for (const node of owners())
    node.classList.toggle('cloudig-scroll-operating', node === dragged || hit(node, e)); }
document.addEventListener('pointermove', scrollState, { passive: true });
document.addEventListener('pointerdown', e => { dragged = owners().find(n => hit(n, e)); scrollState(e); }, { passive: true });
for (const name of ['pointerup', 'pointercancel'])
    window.addEventListener(name, e => { dragged = null; scrollState(e); }, { passive: true });
window.addEventListener('blur', () => { dragged = null; owners().forEach(n => n.classList.remove('cloudig-scroll-operating')); });
labels();
await catalogReady.catch(report);
await openTopic(routeTopic());
