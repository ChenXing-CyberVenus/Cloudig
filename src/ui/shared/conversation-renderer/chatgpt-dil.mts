import type { JsonObject } from '../../../core/contracts/types.mts';
import { dilReference, savedDil } from '../../../adapters/parser/chatgpt-dil.mts';

export function renderSavedDil(document: Document, block: JsonObject, language: 'zh' | 'en'): HTMLElement | undefined {
  const ref = dilReference(block), value = ref && savedDil(ref); if (!value) return;
  const el = (tag: string, className: string, text = '') => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
  const root = el('section', `cloudig-box cloudig-dil cloudig-dil-${value.kind}`);
  root.dataset['source'] = 'chatgpt.com_dil'; root.dataset['savedOnly'] = 'true';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('aria-hidden', 'true');
  const shape = (tag: string, attrs: Record<string, string>) => { const n = document.createElementNS(svg.namespaceURI, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
  shape('circle', { cx: '50', cy: '50', r: '43', fill: 'none', stroke: 'currentColor', 'stroke-width': '4' });
  if (value.kind === 'automation') {
    svg.classList.add('cloudig-dil-icon');
    shape('path', { d: value.submitted ? 'M28 50 L43 65 L73 34' : 'M50 23 V50 L68 61', fill: 'none', stroke: 'currentColor', 'stroke-width': '5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const button = document.createElement('button'); button.type = 'button'; button.className = 'cloudig-dil-suggestion'; button.setAttribute('aria-disabled', 'true');
    button.title = language === 'en' ? 'Saved suggestion · display only' : '已保存的建议 · 仅展示';
    button.append(svg, el('span', 'cloudig-dil-label', value.label)); root.append(button);
    // No action handler, IPC, remote URL, optimistic checkmark or state patch.
    return root;
  }
  svg.classList.add('cloudig-dil-dial');
  for (let i = 0; i < 12; i++) shape('path', { d: 'M50 12 V17', transform: `rotate(${i * 30} 50 50)`, fill: 'none', stroke: 'currentColor', 'stroke-width': i % 3 === 0 ? '3' : '1.5' });
  for (const [i, angle] of value.angles.entries()) if (angle !== undefined) shape('path', { d: `M50 50 V${[28, 19, 15][i]}`, transform: `rotate(${angle} 50 50)`, fill: 'none', stroke: i === 2 ? 'var(--cloudig-accent)' : 'currentColor', 'stroke-width': String([4, 3, 1.5][i]), 'stroke-linecap': 'round' });
  shape('circle', { cx: '50', cy: '50', r: '3', fill: 'currentColor' });
  const info = el('div', 'cloudig-dil-clock-info');
  info.append(el('span', 'cloudig-box-muted', language === 'en' ? 'Saved time' : '已保存的时间'), el('div', 'cloudig-dil-time', value.label || '—'));
  if (value.location) info.append(el('div', 'cloudig-dil-location', value.location));
  if (value.offset) info.append(el('div', 'cloudig-box-muted', value.offset));
  root.append(info, svg); return root;
}
