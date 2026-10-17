// A local controller for the fixed document bar. No Library preferences or
// page-global state: disposal removes its outside-click and resize listeners.
export function mountDocumentNavigation({ element, language, values, labels, iconPath, isExpanded, toggleValue, entries: suppliedEntries }) {
  const doc = element.ownerDocument, bar = element.querySelector('.standard-bar');
  const panel = bar.querySelector('.standard-nav-panel'), list = panel.querySelector('nav');
  const triggers = [...bar.querySelectorAll('[data-standard-menu]')];
  const entries = suppliedEntries ?? [...element.querySelectorAll('.standard-prose section[data-infovalue], .standard-prose details[data-infovalue]')].map(node => ({
    node, id: node.id, value: node.dataset.infovalue,
    rank: node.tagName === 'DETAILS' ? 4 : Number(node.querySelector(':scope > [data-section-heading]').tagName[1]),
    label: node.querySelector(':scope > [data-section-heading], :scope > summary').textContent.trim()
  }));
  const en = language === 'en';
  let current = null, pinned = false, disposed = false;
  const name = value => labels[values.indexOf(value)];
  function focusLink(link) {
    if (!link) return;
    const item = link.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
    link.focus({ preventScroll: true });
  }

  function place() {
    if (panel.hidden || disposed) return;
    const b = bar.getBoundingClientRect(), d = element.getBoundingClientRect();
    const trigger = triggers.find(button => button.dataset.standardMenu === current);
    const t = trigger.getBoundingClientRect(), width = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(12, Math.min(t.left - b.left, b.width - width - 12))}px`;
    const available = d.bottom - b.bottom - 12;
    if (available > 0) panel.style.maxHeight = `${Math.min(520, available)}px`;
  }
  function close(restoreFocus = false) {
    const trigger = triggers.find(button => button.dataset.standardMenu === current);
    current = null; pinned = false; panel.hidden = true;
    for (const button of triggers) button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }
  function refresh() {
    if (disposed) return;
    for (const button of triggers.filter(b => b.dataset.standardMenu !== 'all')) {
      const value = button.dataset.standardMenu;
      const items = entries.filter(item => item.value === value), expanded = items.filter(item => isExpanded(item.node)).length;
      const state = expanded === 0 ? 'false' : expanded === items.length ? 'true' : 'mixed';
      button.setAttribute('aria-pressed', state);
      button.dataset.openState = state;
      button.querySelector('img').src = iconPath(value, expanded > 0);
      button.setAttribute('aria-label', en
        ? `${name(value)}: ${expanded} of ${items.length} expanded. Click to ${state === 'true' ? 'collapse' : 'expand'} this category; Down arrow opens its contents.`
        : `${name(value)}：${items.length}处中已展开${expanded}处。点击${state === 'true' ? '折叠' : '展开'}本档，按向下键打开目录。`);
    }
    for (const link of list.querySelectorAll('a[data-standard-destination]')) {
      const entry = entries.find(item => item.id === link.dataset.standardDestination);
      if (entry.value) link.querySelector('img').src = iconPath(entry.value, isExpanded(entry.node));
    }
    if (current) {
      const selected = current === 'all' ? entries : entries.filter(item => item.value === current);
      panel.querySelector('.standard-nav-count').textContent = current === 'all'
        ? `${selected.length}${en ? ' entries' : ' 项'}`
        : `${en ? 'Open' : '展开'} ${selected.filter(item => isExpanded(item.node)).length} / ${selected.length}`;
    }
  }
  function open(value, pin = false, focus = null) {
    if (disposed) return;
    if (value !== current) {
      const selected = value === 'all' ? entries : entries.filter(item => item.value === value);
      panel.querySelector('.standard-nav-heading').textContent = value === 'all' ? (en ? 'All chapters' : '全部章节') : `${name(value)} · ${en ? 'Contents' : '目录'}`;
      panel.querySelector('.standard-nav-count').textContent = `${selected.length}${en ? ' entries' : ' 项'}`;
      list.setAttribute('aria-label', panel.querySelector('.standard-nav-heading').textContent);
      list.replaceChildren(...selected.map(item => {
        const link = doc.createElement('a'); link.href = `#${item.id}`; link.dataset.standardDestination = item.id;
        if (item.value) link.dataset.infovalue = item.value;
        link.dataset.rank = String(value === 'all' ? item.rank : 2);
        const icon = doc.createElement(item.value ? 'img' : 'span');
        if (item.value) { icon.alt = ''; icon.src = iconPath(item.value, isExpanded(item.node)); }
        else { icon.className = 'history-contents-ornament'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '◇'; }
        const text = doc.createElement('span'); text.textContent = item.label; link.append(icon, text);
        return link;
      }));
      list.scrollTop = 0;
    }
    current = value; pinned = pin; panel.hidden = false;
    for (const button of triggers) button.setAttribute('aria-expanded', String(button.dataset.standardMenu === value));
    refresh(); place();
    if (focus) {
      const links = list.querySelectorAll('a');
      focusLink(focus === 'last' ? links[links.length - 1] : links[0]);
    }
  }
  for (const button of triggers) {
    const value = button.dataset.standardMenu;
    button.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') open(value); });
    button.addEventListener('click', () => {
      if (value === 'all') {
        if (current === value && pinned) close(); else open(value, true);
      } else { toggleValue(value); refresh(); }
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); open(value, true, event.key === 'ArrowUp' ? 'last' : 'first');
      }
    });
  }
  bar.addEventListener('pointerleave', () => { if (!pinned) close(); });
  bar.addEventListener('focusout', event => { if (event.relatedTarget && !bar.contains(event.relatedTarget)) close(); });
  bar.addEventListener('keydown', event => {
    if (event.key === 'Escape' && current) { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const links = [...list.querySelectorAll('a')], index = links.indexOf(doc.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    event.preventDefault(); focusLink(links[next]);
  });
  const outside = event => { if (!bar.contains(event.target)) close(); };
  doc.addEventListener('pointerdown', outside);
  const Resize = doc.defaultView?.ResizeObserver;
  const observer = Resize ? new Resize(place) : null;
  observer?.observe(bar); observer?.observe(element);
  refresh();
  return { refresh, close, dispose() { close(); disposed = true; observer?.disconnect(); doc.removeEventListener('pointerdown', outside); } };
}
