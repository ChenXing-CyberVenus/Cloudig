// Both color versions are one panorama. Resizing changes its intrinsic height;
// dragging changes only the shared clipping boundary and the two workspaces.
export function clampArchiverSplit(width, preferred) {
  if (!(width > 0)) return .5;
  const minimum = Math.min(360, width / 2) / width;
  return Math.max(minimum, Math.min(1 - minimum, preferred));
}

export function bindArchiverLayout(root, signal, view = globalThis) {
  const center = root.querySelector("[data-archiver-center]");
  const scene = root.querySelector(".archiver-center-scenes");
  const splitter = root.querySelector("[data-archiver-splitter]");
  const headers = [...root.querySelectorAll(".archiver-workspace-header")];
  const toolbarContents = [...root.querySelectorAll(".archiver-list-toolbar-content")];
  const columnLabels = [...root.querySelectorAll(".archiver-column-header > *")];
  const lists = [...root.querySelectorAll(".archiver-list-body")];
  let preferred = .5;

  const sync = () => {
    const ratio = clampArchiverSplit(center.getBoundingClientRect().width, preferred);
    root.style.setProperty("--archiver-parser-basis", `${ratio * 100}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    const height = scene.getBoundingClientRect().height;
    if (height > 0) root.style.setProperty("--archiver-information-height", `${height}px`);
    const headerHeight = Math.max(0, ...headers.map(header => header.getBoundingClientRect().height));
    if (headerHeight > 0) root.style.setProperty("--archiver-workspace-header-height", `${headerHeight}px`);
    // Measure intrinsic children, never the allocated shared row; otherwise
    // the two sides can grow together but cannot shrink on resize back.
    const toolbarHeight = Math.max(58, ...toolbarContents.map(content => content.getBoundingClientRect().height + 16));
    root.style.setProperty("--archiver-table-toolbar-height", `${toolbarHeight}px`);
    const columnHeight = Math.max(44, ...columnLabels.map(label => label.getBoundingClientRect().height + 1));
    root.style.setProperty("--archiver-column-header-height", `${columnHeight}px`);
    // Only the body scrolls. Its real scrollbar reduces the row grid width;
    // reserve exactly that same width in the non-scrolling header, not in data.
    for (const body of lists) body.parentElement.style.setProperty("--archiver-list-gutter", `${Math.max(0, body.offsetWidth - body.clientWidth)}px`);
    return ratio;
  };
  const move = (clientX) => {
    const box = center.getBoundingClientRect();
    if (!(box.width > 0)) return;
    preferred = clampArchiverSplit(box.width, (clientX - box.left) / box.width);
    sync();
  };
  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    root.dataset.splitDragging = "true";
    move(event.clientX);
  }, { signal });
  splitter.addEventListener("pointermove", (event) => {
    if (splitter.hasPointerCapture(event.pointerId)) move(event.clientX);
  }, { signal });
  const release = (event) => {
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
    delete root.dataset.splitDragging;
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) splitter.addEventListener(type, release, { signal });
  splitter.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    preferred = clampArchiverSplit(center.getBoundingClientRect().width, sync() + (event.key === "ArrowLeft" ? -.02 : .02));
    sync();
  }, { signal });

  // The scene's intrinsic grid height is independent of the reserved list row,
  // so updating the row cannot create a ResizeObserver feedback loop.
  // The page is cloned from a <template> before adoption; its inert owner
  // document has no defaultView. The observer belongs to the live window.
  const observer = new view.ResizeObserver(sync);
  observer.observe(center);
  observer.observe(scene);
  for (const header of headers) observer.observe(header);
  for (const content of [...toolbarContents, ...columnLabels]) observer.observe(content);
  for (const body of lists) observer.observe(body);
  // WebView zoom changes CSS coordinates during window resize; sync that
  // viewport event too, rather than waiting for a later observed image frame.
  view.addEventListener("resize", sync, { signal });
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  sync();
}
