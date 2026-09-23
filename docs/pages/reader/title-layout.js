export function readerTitleLayout(width, bodyWidth, availableWidth) {
  const l2 = Math.max(0, availableWidth);
  const l1 = Math.max(0, Math.min(bodyWidth, l2));
  return width <= l1 + .5 ? "body" : width <= l2 + .5 ? "center" : "wrap";
}

export function observeTitleLayout(main) {
  const document = main.ownerDocument;
  const view = document.defaultView;
  const requestFrame = view.requestAnimationFrame?.bind(view) ?? (callback => view.setTimeout(callback, 0));
  const cancelFrame = view.cancelAnimationFrame?.bind(view) ?? view.clearTimeout.bind(view);
  const title = main.querySelector("[data-reader-conversation-title]");
  const content = main.querySelector(".reader-conversation-title-content");
  const column = main.querySelector(".reader-message-column");
  const measure = document.createElement("span");
  measure.setAttribute("aria-hidden", "true");
  measure.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;white-space:nowrap;max-width:none;width:max-content;pointer-events:none";
  main.append(measure);
  let frame = 0;
  let stopped = false;
  const layout = () => {
    frame = 0;
    if (stopped || !main.isConnected) return;
    const textStyle = view.getComputedStyle(title);
    measure.style.font = textStyle.font;
    measure.style.letterSpacing = textStyle.letterSpacing;
    measure.textContent = title.textContent;
    const box = content.getBoundingClientRect();
    const body = column.getBoundingClientRect();
    if (box.width < 1 || body.width < 1) return;
    const style = view.getComputedStyle(content);
    const left = parseFloat(style.paddingLeft);
    const available = Math.max(0, box.width - left - parseFloat(style.paddingRight));
    const width = Math.min(body.width, available);
    const inset = Math.max(0, Math.min(available - width, body.left - box.left - left));
    content.style.setProperty("--reader-title-body-width", `${width}px`);
    content.style.setProperty("--reader-title-body-inset", `${inset}px`);
    const measured = measure.getBoundingClientRect().width;
    content.dataset.titleLayout = readerTitleLayout(measured, width, available);
    content.dataset.titleNaturalWidth = String(measured);
    content.dataset.titleL1 = String(width);
    content.dataset.titleL2 = String(available);
  };
  const schedule = () => { if (!stopped && !frame) frame = requestFrame(layout); };
  const observer = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(schedule) : null;
  observer?.observe(main);
  observer?.observe(column);
  view.addEventListener("resize", schedule);
  document.fonts?.ready.then(schedule);
  return { schedule, cleanup() { stopped = true; if (frame) cancelFrame(frame); observer?.disconnect(); view.removeEventListener("resize", schedule); measure.remove(); } };
}
