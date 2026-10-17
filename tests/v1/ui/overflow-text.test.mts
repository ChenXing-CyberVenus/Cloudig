import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../../../src/ui/shell/overflow-text.js", import.meta.url), "utf8");
const { bindOverflowText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function fixture() {
  const dom = new JSDOM('<main><span data-overflow-text><b>完整的长标题 branch01 (2)</b></span><span data-overflow-text>短名</span><i>outside</i></main>');
  const { document } = dom.window;
  const root = document.querySelector("main")!;
  const [long, short] = [...root.querySelectorAll<HTMLElement>("[data-overflow-text]")];
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0, width = 100;
  dom.window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  Object.defineProperties(long!, { clientWidth: { get: () => width }, scrollWidth: { get: () => 350 } });
  Object.defineProperties(short!, { clientWidth: { get: () => 100 }, scrollWidth: { get: () => 40 } });
  const controller = new dom.window.AbortController();
  bindOverflowText(root, controller.signal);
  const frame = (now: number) => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(now)); };
  const pointer = (target: Element, type: string, relatedTarget: EventTarget | null = null) =>
    target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, relatedTarget }));
  return { dom, root, long: long!, short: short!, frames, frame, pointer, resize: (next: number) => { width = next; dom.window.dispatchEvent(new dom.window.Event("resize")); },
    cleanup: () => { controller.abort(); dom.window.close(); }, controller };
}

test("only overflowing titles move, reach their exact end, and reset when leaving a nested child", () => {
  const scope = fixture();
  try {
    scope.pointer(scope.short, "pointerover");
    assert.equal(scope.frames.size, 0);
    assert.equal(scope.short.dataset["scrolling"], undefined);
    const original = scope.long.textContent;
    const child = scope.long.querySelector("b")!;
    scope.pointer(child, "pointerover");
    scope.frame(0); scope.frame(300);
    assert.equal(scope.long.scrollLeft, 0);
    scope.frame(1000);
    assert.equal(scope.long.scrollLeft, 31.2);
    scope.pointer(child, "pointerout", scope.long);
    assert.equal(scope.long.dataset["scrolling"], "true", "moving inside a title must not reset it");
    scope.frame(10000);
    assert.equal(scope.long.scrollLeft, 250);
    assert.equal(scope.frames.size, 0, "no permanent animation loop at the end");
    scope.pointer(child, "pointerout", scope.root.querySelector("i"));
    assert.equal(scope.long.scrollLeft, 0);
    assert.equal(scope.long.dataset["scrolling"], undefined);
    assert.equal(scope.long.textContent, original);
  } finally { scope.cleanup(); }
});

test("responsive resize, replacement and cleanup cannot leave a shifted title or a live frame", () => {
  const scope = fixture();
  try {
    scope.pointer(scope.long, "pointerover"); scope.frame(0); scope.frame(1000);
    scope.resize(400);
    assert.equal(scope.long.scrollLeft, 0);
    assert.equal(scope.frames.size, 0);
    scope.resize(100);
    scope.pointer(scope.long, "pointerover"); scope.frame(2000); scope.frame(3000);
    scope.long.remove(); scope.frame(4000);
    assert.equal(scope.frames.size, 0);
    assert.equal(scope.long.scrollLeft, 0);
    scope.root.prepend(scope.long);
    scope.pointer(scope.long, "pointerover"); scope.frame(5000); scope.frame(6000);
    scope.controller.abort();
    assert.equal(scope.long.scrollLeft, 0);
    assert.equal(scope.frames.size, 0);
    scope.pointer(scope.long, "pointerover");
    assert.equal(scope.frames.size, 0);
  } finally { scope.cleanup(); }
});

test("fractional display scaling cannot keep requesting frames after reaching the end", () => {
  const scope = fixture();
  try {
    let position = 0;
    Object.defineProperty(scope.long, "scrollLeft", { get: () => position, set: value => { position = Math.min(value, 249.333); } });
    scope.pointer(scope.long, "pointerover"); scope.frame(0); scope.frame(10000);
    assert.equal(position, 249.333);
    assert.equal(scope.frames.size, 0);
  } finally { scope.cleanup(); }
});
