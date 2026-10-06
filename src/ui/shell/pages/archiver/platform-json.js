import { mountClaudeContainer } from './claude-container.js';
import { platformJsonDefinitions, platformJsonImportGuides, restorePlatformJson } from './platform-json-presentation.js';
import { platformImportGuides } from './platform-import-guide-content.js';
import { mountPlatformImportGuide } from './platform-import-guide.js';
import { importDeskArt, importFileArt } from './platform-import-art.js';

// Available sources share the existing record-selection UI, not the Claude Adapter.
// Deferred sources remain explicit disposable previews.
export function mountPlatformJsonIndex({ root, state, onImport, onClose }) {
  const document = root.ownerDocument, controller = new AbortController();
  const host = document.createElement('section'); host.className = 'archiver-json-index'; host.dataset.jsonIndex = '';
  root.querySelector('[data-archiver-center]').append(host);
  let preview = null, previewNote = null, help = null;
  const en = () => state.language === 'en';
  function stopPreview() {
    preview?.cleanup(); preview = null; previewNote?.remove(); previewNote = null;
    const page = root.querySelector('[data-archiver-claude-view]'); restorePlatformJson(page); page.hidden = true;
    delete root.dataset.jsonPreview;
  }
  function render() {
    if (help) { help.updateLanguage(state.language); return; }
    if (preview) { preview.updateState(state); return; }
    root.dataset.archiverMode = 'json'; host.hidden = false;
    host.replaceChildren();
    const header = document.createElement('header'); header.className = 'archiver-json-heading';
    const intro = document.createElement('div'); intro.className = 'archiver-json-intro';
    const title = document.createElement('h1'); title.textContent = en() ? 'Import Platform Files' : '导入平台文件';
    const caption = document.createElement('p'); caption.textContent = en() ? 'Claude, DeepSeek and Qwen: JSON. ChatGPT, Mistral and Grok: conversation ZIP exports. Do not extract ZIPs or select folders.' : 'Claude、DeepSeek、Qwen选JSON；ChatGPT、Mistral、Grok选完整会话ZIP。无需解压，不选择文件夹。';
    intro.append(title, caption); header.append(intro); header.insertAdjacentHTML('beforeend', importDeskArt);
    const body = document.createElement('div'); body.className = 'archiver-json-groups'; body.dataset.scrollRegion = '';
    for (const [group, label] of [['official', en() ? 'Official AI Platform Exports' : 'AI平台官方导出文件'], ['agent', 'Agent Tool']]) {
      const section = document.createElement('section'), heading = document.createElement('h2'), grid = document.createElement('div');
      section.dataset.jsonGroup = group;
      heading.textContent = label; grid.className = 'archiver-json-grid';
      for (const definition of platformJsonDefinitions.filter(item => item.group === group)) {
        const card = document.createElement('div'); card.className = 'archiver-json-card-wrap';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'cloudig-button archiver-json-card'; button.dataset.jsonPlatform = definition.id;
        const icon = document.createElement('img'); icon.src = `/assets/platforms/${definition.icon}`; icon.alt = '';
        const words = document.createElement('span'), name = document.createElement('strong'), action = document.createElement('small'), arrow = document.createElement('span');
        words.className = 'archiver-json-card-copy'; name.textContent = definition.name;
        const guide = platformJsonImportGuides[definition.id], inputKind = guide?.input ?? 'json', zipped = inputKind === 'zip';
        action.className = 'archiver-json-card-action';
         action.textContent = definition.available ? (en() ? `Choose ${inputKind === 'jsonl' ? 'JSONL' : zipped ? 'ZIP' : 'JSON'} · Multi-select` : `选择${inputKind === 'jsonl' ? 'JSONL' : zipped ? 'ZIP' : 'JSON'} · 可多选`) : definition.deferred ? (en() ? 'New export pending · Preview' : '等待新导出 · 界面预览') : (en() ? 'Preview only · Import unavailable' : '仅界面预览 · 暂不导入');
        arrow.className = 'archiver-json-card-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
        words.append(name, action);
        if (definition.available && guide) {
           button.dataset.jsonInput = inputKind;
          const file = document.createElement('span'), filename = document.createElement('code'), hint = document.createElement('small');
          file.className = 'archiver-json-file'; file.innerHTML = importFileArt(zipped);
          filename.className = 'archiver-json-filename'; filename.textContent = guide.file;
          hint.className = 'archiver-json-import-hint'; hint.textContent = en() ? guide.en : guide.zh;
          file.append(filename); words.append(file, hint);
        }
        button.append(icon, words, arrow); card.append(button);
        if (platformImportGuides.some(guide => guide.id === definition.id)) {
          const helpButton = document.createElement('button'); helpButton.type = 'button'; helpButton.className = 'archiver-json-help'; helpButton.dataset.jsonHelp = definition.id;
          helpButton.title = en() ? `${definition.name} import guide` : `查看 ${definition.name} 导入指南`; helpButton.setAttribute('aria-label', helpButton.title);
          helpButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 8.5a3 3 0 0 1 6 .5c0 2-3 2-3 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.15" fill="currentColor"/></svg>';
          card.classList.add('has-guide'); card.append(helpButton);
        }
        grid.append(card);
      }
      section.append(heading, grid); body.append(section);
    }
    const footer = document.createElement('footer'), note = document.createElement('p'), back = document.createElement('button');
    note.textContent = en() ? 'You can also copy supported JSON, JSONL, or ZIP files into Inbox, then refresh. The original files are kept.' : '也可直接把受支持的JSON、JSONL或ZIP复制进Inbox，再刷新列表。原文件完整保留。'; note.className = 'archiver-json-stage';
    back.type = 'button'; back.className = 'cloudig-button cloudig-button-filled'; back.dataset.jsonClose = ''; back.textContent = en() ? 'Return to Archiver' : '返回档案馆'; footer.append(note, back);
    host.append(header, body, footer);
  }
  function openPreview(definition) {
    stopPreview(); host.hidden = true;
    root.dataset.archiverMode = 'claude'; root.dataset.jsonPreview = definition.id;
    const page = root.querySelector('[data-archiver-claude-view]'); page.hidden = false;
    const items = Array.from({ length: 12 }, (_, index) => ({ selector: `preview-${index + 1}`, ordinal: index + 1,
      title: `${definition.name} · ${en() ? 'Sample conversation' : '示例对话'} ${String(index + 1).padStart(2, '0')}`,
      messages: 6 + index * 3, branches: index % 4 ? 1 : 3, created_at: '2026-09-01T09:00:00Z', updated_at: '2026-09-02T18:00:00Z', status: 'ready' }));
    const index = { container: 'ui-preview', source: { filename: en() ? 'Preview — sample data' : '界面预览 — 示例数据', bytes: 0 }, total: items.length, items, statuses: { ready: items.length, parsed: 0, update: 0, failed: 0, unsupported: 0 } };
    previewNote = document.createElement('span'); previewNote.className = 'archiver-json-preview-note'; page.querySelector('footer').prepend(previewNote);
    const notify = () => { previewNote.textContent = en() ? 'Preview only · No files are created.' : '仅界面预览，不生成或修改文件。'; };
    preview = mountClaudeContainer({ root, index, state, presentation: definition, directories: [], returnLabel: locale => locale === 'en' ? 'Import Sources' : '返回导入入口',
      query: async query => {
        let visible = items.filter(row => (!query.search || row.title.toLowerCase().includes(query.search.toLowerCase())) && (!query.statuses?.length || query.statuses.includes(row.status)));
        if (query.direction === 'desc') visible = [...visible].reverse();
        return { ...index, visible: visible.length, offset: query.offset ?? 0, items: visible.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 200)) };
      }, extract: async () => notify(), rebuild: async () => notify(), cancel() {}, savePreferences: async () => undefined,
      createDirectory: async () => { throw Error(en() ? 'Preview does not create folders.' : '界面预览不创建目录。'); },
      onError: () => notify(), returnToArchiver: () => { stopPreview(); render(); }
    });
    notify();
  }
  host.addEventListener('click', async event => {
    const helpButton = event.target.closest('[data-json-help]');
    if (helpButton) {
      const body = host.querySelector('.archiver-json-groups'), scroll = body.scrollTop;
      const indexParts = [...host.children]; indexParts.forEach(node => { node.hidden = true; });
      host.dataset.showingGuide = '';
      help = mountPlatformImportGuide({ host, platform: helpButton.dataset.jsonHelp, language: state.language, onBack: () => {
        help?.cleanup(); help = null; delete host.dataset.showingGuide; render();
        host.querySelector('.archiver-json-groups').scrollTop = scroll;
        host.querySelector(`[data-json-help="${helpButton.dataset.jsonHelp}"]`)?.focus({ preventScroll: true });
      } }); return;
    }
    if (event.target.closest('[data-json-close]')) { onClose(); return; }
    const id = event.target.closest('[data-json-platform]')?.dataset.jsonPlatform;
    const definition = platformJsonDefinitions.find(item => item.id === id); if (!definition) return;
    if (definition.available) { onClose(); await onImport(definition.id); }
    else openPreview(definition);
  }, { signal: controller.signal });
  render();
  return { updateState(next) { state = next; render(); if (previewNote) previewNote.textContent = en() ? 'Preview only · No files are created.' : '仅界面预览，不生成或修改文件。'; },
    preview(platform) { const definition = platformJsonDefinitions.find(item => item.id === platform); if (definition && !definition.available) openPreview(definition); },
    cleanup() { help?.cleanup(); help = null; stopPreview(); controller.abort(); host.remove(); delete root.dataset.archiverMode; } };
}
