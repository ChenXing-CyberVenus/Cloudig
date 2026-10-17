import { platformImportGuides, guideImagePath } from './platform-import-guide-content.js';

export function appendGuideText(element, text) {
  // Emphasis only: never rewrite the author's text or insert explanations.
  for (const part of text.split(/(privacy\.openai\.com|Cloudig\\Inbox\\|conversations(?:-000|\*)?\.(?:json|zip)|chat-export-\*\.(?:json|zip)|manifest-\*\.json|OpenAI-export\.zip|User Online Activity|export_url|Download data|Export your data)/g)) {
    if (!part) continue;
    if (part === 'privacy.openai.com') {
      const link = element.ownerDocument.createElement('a'); link.href = 'https://privacy.openai.com/'; link.textContent = part;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.guideWebsite = ''; element.append(link);
    } else if (/^(?:Cloudig\\|conversations|chat-export-|manifest-|OpenAI-export|User Online Activity|export_url|Download data|Export your data)/.test(part)) {
      const strong = element.ownerDocument.createElement('strong'); strong.textContent = part; element.append(strong);
    } else element.append(element.ownerDocument.createTextNode(part));
  }
}

export function mountPlatformImportGuide({ host, platform, language, onBack }) {
  const document = host.ownerDocument, controller = new AbortController();
  const view = document.createElement('section'); view.className = 'archiver-import-guide'; view.dataset.importGuide = platform;
  host.append(view);
  let current = platform, locale = language, zoom = null;
  const positions = new Map();
  const en = () => locale === 'en';
  function closeZoom() { const closing = zoom; zoom = null; if (closing) { closing.close?.(); closing.remove(); } }
  function remember() { positions.set(current, view.querySelector('[data-guide-scroll]')?.scrollTop ?? 0); }
  function render() {
    closeZoom();
    const guide = platformImportGuides.find(item => item.id === current);
    if (!guide) throw new Error('Platform guide unavailable');
    view.dataset.importGuide = current; view.replaceChildren();
    const header = document.createElement('header'); header.className = 'archiver-guide-heading';
    const title = document.createElement('h1'); title.textContent = en() ? `${guide.name} · Import Guide` : `${guide.name} · 平台文件导入指南`;
    const back = document.createElement('button'); back.type = 'button'; back.className = 'cloudig-button cloudig-button-filled'; back.dataset.guideBack = '';
    back.textContent = en() ? 'Back to Import' : '返回导入'; header.append(title, back);
    const tabs = document.createElement('nav'); tabs.className = 'archiver-guide-platforms'; tabs.setAttribute('aria-label', en() ? 'Platform guides' : '平台指南');
    for (const item of platformImportGuides) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.guidePlatform = item.id;
      button.textContent = item.name; button.setAttribute('aria-pressed', String(item.id === current)); tabs.append(button);
    }
    const body = document.createElement('div'); body.className = 'archiver-guide-scroll'; body.dataset.scrollRegion = ''; body.dataset.guideScroll = '';
    for (const [methodIndex, method] of guide.methods.entries()) {
      const section = document.createElement('section'); section.className = 'archiver-guide-method';
      if (method.title) { const h2 = document.createElement('h2'); h2.textContent = method.title[en() ? 1 : 0]; section.append(h2); }
      if (methodIndex === 0 && !guide.websiteInline) {
        const website = document.createElement('p'), link = document.createElement('a'); website.className = 'archiver-guide-website';
        website.append(document.createTextNode(en() ? 'Sign in: ' : '登录网站：'));
        link.href = guide.website; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.guideWebsite = ''; link.textContent = guide.website;
        website.append(link); section.append(website);
      }
      const steps = document.createElement('ol'); steps.className = 'archiver-guide-steps';
      for (const step of method.steps) {
        const item = document.createElement('li'), text = document.createElement('p'); text.dataset.guideStep = '';
        appendGuideText(text, step[en() ? 'en' : 'zh']); item.append(text);
        for (const figure of step.figures) {
          const image = document.createElement('img'), button = document.createElement('button');
          image.src = guideImagePath(guide, figure); image.alt = `${guide.name} · ${en() ? 'Figure' : '图'} ${String(figure).padStart(2, '0')}`;
          button.type = 'button'; button.className = 'archiver-guide-image'; button.dataset.guideZoom = String(figure);
          button.title = en() ? 'Enlarge image' : '放大图片'; button.setAttribute('aria-label', `${button.title} · ${image.alt}`);
          button.append(image); item.append(button);
        }
        steps.append(item);
      }
      section.append(steps); body.append(section);
    }
    view.append(header, tabs, body); body.scrollTop = positions.get(current) ?? 0;
  }
  view.addEventListener('click', event => {
    if (event.target.closest('[data-guide-back]')) { onBack(); return; }
    const target = event.target.closest('[data-guide-platform]');
    if (target) { remember(); current = target.dataset.guidePlatform; render(); view.querySelector(`[data-guide-platform="${current}"]`).focus({ preventScroll: true }); return; }
    const imageButton = event.target.closest('[data-guide-zoom]');
    if (!imageButton) return;
    closeZoom();
    const dialog = document.createElement('dialog'); dialog.className = 'archiver-guide-lightbox'; dialog.dataset.guideLightbox = '';
    const heading = document.createElement('header'), label = document.createElement('span'), close = document.createElement('button');
    label.textContent = imageButton.querySelector('img').alt;
    close.type = 'button'; close.className = 'cloudig-button cloudig-button-filled'; close.textContent = en() ? 'Close' : '关闭'; close.dataset.guideZoomClose = '';
    heading.append(label, close);
    const scroll = document.createElement('div'); scroll.dataset.scrollRegion = ''; scroll.className = 'archiver-guide-lightbox-scroll';
    scroll.append(imageButton.querySelector('img').cloneNode(true)); dialog.append(heading, scroll); host.append(dialog); zoom = dialog;
    dialog.setAttribute('aria-label', label.textContent);
    close.addEventListener('click', closeZoom, { signal: controller.signal });
    dialog.addEventListener('close', () => { dialog.remove(); if (zoom === dialog) zoom = null; imageButton.focus({ preventScroll: true }); }, { once: true });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeZoom(); } });
    dialog.showModal();
  }, { signal: controller.signal });
  render(); view.querySelector('[data-guide-back]').focus({ preventScroll: true });
  return { updateLanguage(next) { if (next === locale) return; remember(); locale = next; render(); }, cleanup() { closeZoom(); controller.abort(); view.remove(); } };
}
