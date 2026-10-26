// Written prototype: a clipped single line reveals its complete text on hover.
// This is a reading interaction, not decorative motion; it also works when
// reduced motion is requested. Multi-line headings are deliberately not bound.
export function bindOverflowText(root, signal) {
  // Cloned <template> content belongs to an inert document until it is mounted.
  const view = root.ownerDocument.defaultView ?? document.defaultView;
  const inside = (node, target) => target instanceof view.Node && node.contains(target);
  let active = null;
  const stop = () => {
    if (!active) return;
    view.cancelAnimationFrame(active.frame);
    active.node.scrollLeft = 0;
    delete active.node.dataset.scrolling;
    active = null;
  };
  const start = (node, area = node) => {
    stop();
    if (!node.isConnected || node.scrollWidth <= node.clientWidth + 1) return;
    const state = { node, area, frame: 0, started: null };
    active = state;
    node.dataset.scrolling = "true";
    const tick = now => {
      if (active !== state) return;
      if (!node.isConnected) { stop(); return; }
      const distance = Math.max(0, node.scrollWidth - node.clientWidth);
      if (distance <= 1) { stop(); return; }
      state.started ??= now;
      const offset = Math.min(distance, Math.max(0, now - state.started - 350) * .048);
      node.scrollLeft = offset;
      if (offset < distance) state.frame = view.requestAnimationFrame(tick);
    };
    state.frame = view.requestAnimationFrame(tick);
  };
  root.addEventListener("pointerover", event => {
    const scope = event.target.closest?.("[data-overflow-scope]");
    const node = scope?.querySelector("[data-overflow-text]") ?? event.target.closest?.("[data-overflow-text]");
    const area = scope ?? node;
    if (node && root.contains(node) && !inside(area, event.relatedTarget)) start(node, area);
  }, { signal });
  root.addEventListener("pointerout", event => {
    if (active && inside(active.area, event.target) && !inside(active.area, event.relatedTarget)) stop();
  }, { signal });
  root.addEventListener("pointerleave", stop, { signal });
  view.addEventListener("resize", () => { if (active) start(active.node, active.area); }, { signal, passive: true });
  signal.addEventListener("abort", stop, { once: true });
}
