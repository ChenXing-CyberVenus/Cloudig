export const CLOUDIG_VIEWPORT_EVENT = "cloudig:viewportchange";

function finite(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readViewport(windowObject = globalThis) {
  const documentObject = windowObject.document;
  const visual = windowObject.visualViewport;
  const width = finite(visual?.width, finite(windowObject.innerWidth, documentObject?.documentElement?.clientWidth || 1920));
  const height = finite(visual?.height, finite(windowObject.innerHeight, documentObject?.documentElement?.clientHeight || 1080));
  const offsetLeft = Number.isFinite(visual?.offsetLeft) ? visual.offsetLeft : 0;
  const offsetTop = Number.isFinite(visual?.offsetTop) ? visual.offsetTop : 0;
  const dpr = finite(windowObject.devicePixelRatio, 1);
  const band = width >= 1920 && height >= 1000
    ? "design"
    : width >= 1440 && height >= 800
      ? "desktop"
      : width >= 1280 && height >= 640
        ? "compact"
        : "defensive";
  return Object.freeze({ width, height, offsetLeft, offsetTop, dpr, band });
}

export function installViewportContract({ windowObject = globalThis, root = windowObject.document?.documentElement } = {}) {
  if (!root || typeof windowObject.addEventListener !== "function") {
    return Object.freeze({ snapshot: () => readViewport(windowObject), dispose() {} });
  }
  let frame = 0;
  let current = null;
  const requestFrame = typeof windowObject.requestAnimationFrame === "function"
    ? (callback) => windowObject.requestAnimationFrame(callback)
    : (callback) => windowObject.setTimeout(callback, 0);
  const cancelFrame = typeof windowObject.cancelAnimationFrame === "function"
    ? (handle) => windowObject.cancelAnimationFrame(handle)
    : (handle) => windowObject.clearTimeout(handle);
  const createViewportEvent = (detail) => typeof windowObject.CustomEvent === "function"
    ? new windowObject.CustomEvent(CLOUDIG_VIEWPORT_EVENT, { detail })
    : Object.assign(new windowObject.Event(CLOUDIG_VIEWPORT_EVENT), { detail });
  const commit = () => {
    frame = 0;
    const next = readViewport(windowObject);
    const signature = JSON.stringify(next);
    if (signature === current) return;
    current = signature;
    root.style.setProperty("--cloudig-viewport-width", `${next.width}px`);
    root.style.setProperty("--cloudig-viewport-height", `${next.height}px`);
    root.style.setProperty("--cloudig-viewport-offset-left", `${next.offsetLeft}px`);
    root.style.setProperty("--cloudig-viewport-offset-top", `${next.offsetTop}px`);
    root.style.setProperty("--cloudig-device-pixel-ratio", String(next.dpr));
    root.dataset.cloudigViewport = next.band;
    root.dispatchEvent(createViewportEvent(next));
  };
  const schedule = () => {
    if (frame) return;
    frame = requestFrame(commit);
  };
  windowObject.addEventListener("resize", schedule, { passive: true });
  windowObject.visualViewport?.addEventListener("resize", schedule, { passive: true });
  windowObject.visualViewport?.addEventListener("scroll", schedule, { passive: true });
  commit();
  return Object.freeze({
    snapshot: () => readViewport(windowObject),
    dispose() {
      if (frame) cancelFrame(frame);
      windowObject.removeEventListener("resize", schedule);
      windowObject.visualViewport?.removeEventListener("resize", schedule);
      windowObject.visualViewport?.removeEventListener("scroll", schedule);
    }
  });
}
