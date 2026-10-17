import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
const layoutSource = await readFile(new URL("../../../src/ui/shell/pages/archiver/archiver-layout.js", import.meta.url), "utf8");
const { bindArchiverLayout, clampArchiverSplit } = await import(`data:text/javascript,${encodeURIComponent(layoutSource)}`) as {
  bindArchiverLayout: (root: HTMLElement, signal: AbortSignal, environment: {
    ResizeObserver: new (callback: () => void) => { observe: () => void; disconnect: () => void };
    addEventListener: (type: string, callback: () => void, options: { signal: AbortSignal }) => void;
  }) => void;
  clampArchiverSplit: (width: number, preferred: number) => number;
};

test("Archiver split keeps both lists usable without a fixed 50 percent clip", () => {
  assert.equal(clampArchiverSplit(0, .1), .5);
  assert.equal(clampArchiverSplit(720, .1), .5);
  for (const width of [904, 1016, 1272, 1385]) {
    assert.ok(Math.abs(clampArchiverSplit(width, .01) * width - 360) < .00001);
    assert.ok(Math.abs((1 - clampArchiverSplit(width, .99)) * width - 360) < .00001);
    assert.equal(clampArchiverSplit(width, .5), .5);
  }
});

test("actual panorama height, pointer drag, keyboard, resize restoration and cleanup share one layout", () => {
  const dom = new JSDOM('<template><main><div data-archiver-center><header class="archiver-workspace-header"></header><header class="archiver-workspace-header"></header><div class="archiver-list-toolbar-content"></div><div class="archiver-list-toolbar-content"></div><div class="archiver-column-header"><span></span><span></span></div><div class="archiver-center-scenes"></div><div data-archiver-splitter></div></div></main></template>');
  const view = dom.window;
  const root = view.document.querySelector("template")!.content.querySelector("main")!;
  assert.equal(root.ownerDocument.defaultView, null, "Production pages are initially cloned inside an inert template document");
  const center = root.querySelector<HTMLElement>("[data-archiver-center]")!;
  const scene = root.querySelector<HTMLElement>(".archiver-center-scenes")!;
  const splitter = root.querySelector<HTMLElement>("[data-archiver-splitter]")!;
  let width = 1272, height = 117.88, resize = () => {}, disconnected = false;
  center.getBoundingClientRect = () => new view["DOMRect"](400, 48, width, 1032);
  scene.getBoundingClientRect = () => new view["DOMRect"](400, 1080 - height, width, height);
  const headers = [...root.querySelectorAll<HTMLElement>(".archiver-workspace-header")];
  headers[0]!.getBoundingClientRect = () => new view["DOMRect"](400, 48, width / 2, width < 1000 ? 156 : 128);
  headers[1]!.getBoundingClientRect = () => new view["DOMRect"](400 + width / 2, 48, width / 2, 128);
  const toolbars = [...root.querySelectorAll<HTMLElement>(".archiver-list-toolbar-content")];
  toolbars[0]!.getBoundingClientRect = () => new view["DOMRect"](0, 0, width / 2, 42);
  toolbars[1]!.getBoundingClientRect = () => new view["DOMRect"](0, 0, width / 2, width < 1000 ? 64 : 42);
  for (const label of root.querySelectorAll<HTMLElement>(".archiver-column-header > *")) label.getBoundingClientRect = () => new view["DOMRect"](0, 0, 80, width < 1000 ? 60 : 20);
  class Observer {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  let captured = false;
  const bodies = [0, 1].map(() => {
    const card = root.ownerDocument.createElement('section'), body = root.ownerDocument.createElement('div');
    body.className = 'archiver-list-body'; card.append(body); center.append(card);
    return body;
  });
  let gutter = 8;
  for (const [index, body] of bodies.entries()) {
    Object.defineProperty(body, 'offsetWidth', { get: () => 400 });
    Object.defineProperty(body, 'clientWidth', { get: () => 400 - (index ? gutter : 0) });
  }
  splitter.setPointerCapture = () => { captured = true; };
  splitter.hasPointerCapture = () => captured;
  splitter.releasePointerCapture = () => { captured = false; };
  const controller = new view.AbortController();
  bindArchiverLayout(root, controller.signal, { ResizeObserver: Observer, addEventListener: (type, callback, options) => view.addEventListener(type, callback, options) });
  const ratio = () => parseFloat(root.style.getPropertyValue("--archiver-parser-basis")) / 100;
  const pointer = (type: string, clientX: number) => {
    const event = new view.MouseEvent(type, { clientX, button: 0, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    splitter.dispatchEvent(event);
  };
  assert.equal(ratio(), .5);
  assert.equal(bodies[0]!.parentElement!.style.getPropertyValue('--archiver-list-gutter'), '0px');
  assert.equal(bodies[1]!.parentElement!.style.getPropertyValue('--archiver-list-gutter'), '8px');
  gutter = 0; resize();
  assert.equal(bodies[1]!.parentElement!.style.getPropertyValue('--archiver-list-gutter'), '0px', 'No phantom space after rows are filtered or removed');
  gutter = 8; resize();
  assert.equal(root.style.getPropertyValue("--archiver-workspace-header-height"), "128px");
  assert.equal(root.style.getPropertyValue("--archiver-information-height"), "117.88px");
  assert.equal(root.style.getPropertyValue("--archiver-table-toolbar-height"), "58px");
  assert.equal(root.style.getPropertyValue("--archiver-column-header-height"), "44px");
  pointer("pointerdown", 400 + width * .3);
  assert.ok(captured);
  assert.equal(root.dataset["splitDragging"], "true");
  pointer("pointermove", 400 + width * .7);
  pointer("pointerup", 400 + width * .7);
  assert.equal(captured, false);
  assert.equal(root.dataset["splitDragging"], undefined);
  assert.equal(ratio(), .7);
  assert.equal(root.style.getPropertyValue("--archiver-information-height"), "117.88px", "Dragging must not independently resize either background half");
  width = 720; height = 120 * width / 1272; resize();
  assert.equal(ratio(), .5);
  assert.equal(root.style.getPropertyValue("--archiver-workspace-header-height"), "156px", "Both lists must reserve the taller wrapped header");
  assert.equal(root.style.getPropertyValue("--archiver-table-toolbar-height"), "80px", "Search wrapping and status wrapping share one row");
  assert.equal(root.style.getPropertyValue("--archiver-column-header-height"), "61px", "Long time-field labels cannot offset the first data row");
  assert.equal(parseFloat(root.style.getPropertyValue("--archiver-information-height")), height);
  width = 1272; height = 120; view.dispatchEvent(new view.Event("resize"));
  assert.equal(ratio(), .7, "Temporary small-window clamp must not erase the session ratio");
  assert.equal(root.style.getPropertyValue("--archiver-table-toolbar-height"), "58px", "Allocated row height must shrink back, not feed its own observer");
  assert.equal(root.style.getPropertyValue("--archiver-column-header-height"), "44px");
  assert.equal(parseFloat(root.style.getPropertyValue("--archiver-information-height")), 120, "Native viewport resize must not wait for a later image observer frame");
  const key = new view.KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true });
  splitter.dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  assert.ok(Math.abs(ratio() - .68) < .00001);
  controller.abort();
  assert.equal(disconnected, true);
  pointer("pointerdown", 400 + width * .5);
  assert.ok(Math.abs(ratio() - .68) < .00001, "Unmount must remove pointer work");
  dom.window.close();
});
