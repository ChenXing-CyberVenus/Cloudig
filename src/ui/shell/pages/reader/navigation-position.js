/** Follow only inside the navigation pane; never scroll an ancestor/Reader. */
export function followNavigationItem(list, item) {
  if (!item || list.clientHeight <= 0) return;
  const viewport = list.getBoundingClientRect(), row = item.getBoundingClientRect();
  const top = viewport.top + list.clientTop, bottom = top + list.clientHeight;
  if (row.top < top + 4) list.scrollTop += row.top - top - 4;
  else if (row.bottom > bottom - 4) list.scrollTop += row.bottom - bottom + 4;
}

/** Intersection callbacks contain changes, not the complete visible set.
 * Use current geometry so large messages and the final viewport remain valid. */
export function visibleNavigationIndex(scroll, anchors) {
  const top = scroll.getBoundingClientRect().top + scroll.clientTop;
  const bottom = top + scroll.clientHeight;
  const atEnd = scroll.scrollTop > 0 && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
  let current = -1;
  for (const { index, node } of anchors) {
    const rect = node.getBoundingClientRect();
    if (!rect.height || !rect.width) continue;
    if (atEnd || rect.top <= top + 4) current = index;
    else if (current < 0 && rect.top < bottom && rect.bottom > top) { current = index; break; }
  }
  return current;
}
