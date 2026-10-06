import type { InteractiveState } from "./interactive-protocol.mts";

/** This self-contained function is serialized into the sandboxed work document.
 * Its only outward capability is reporting this one work's in-memory progress.
 * No bridge commands, resource reads, network proxies or filesystem paths. */
export function interactiveClient(config: { token: string; state: InteractiveState; stateLimit: number; errorLimit: number; theme: string; scrollRegions?: boolean }): void {
  const protocol = "cloudig/interactive-runtime/1";
  const send = (kind: string, detail: unknown) => window.parent.postMessage({ protocol, token: config.token, kind, detail }, "*");
  const storage = (initial: Readonly<Record<string, string>>, persistent: boolean): Storage => {
    let entries = new Map(Object.entries(initial));
    const replace = (next: Map<string, string>) => {
      const result = Object.fromEntries(next);
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > config.stateLimit) {
        send("state-full", null); throw new DOMException("Interactive session progress is full", "QuotaExceededError");
      }
      entries = next; if (persistent) send("state", result);
    };
    const api = {
      get length() { return entries.size; },
      getItem(key: string) { return entries.get(String(key)) ?? null; },
      setItem(key: string, value: string) { const next = new Map(entries); next.set(String(key), String(value)); replace(next); },
      removeItem(key: string) { const next = new Map(entries); next.delete(String(key)); replace(next); },
      clear() { replace(new Map()); },
      key(index: number) { return [...entries.keys()][index] ?? null; }
    };
    return new Proxy(api, {
      get(target, key) { return typeof key === "string" && !(key in target) ? entries.get(key) : Reflect.get(target, key); },
      set(_target, key, value) { if (typeof key !== "string") return false; api.setItem(key, String(value)); return true; },
      deleteProperty(_target, key) { if (typeof key !== "string") return false; api.removeItem(key); return true; },
      ownKeys() { return [...entries.keys()]; },
      getOwnPropertyDescriptor(_target, key) { return typeof key === "string" && entries.has(key) ? { configurable: true, enumerable: true, writable: true, value: entries.get(key) } : undefined; }
    }) as Storage;
  };
  Object.defineProperty(window, "localStorage", { value: storage(config.state, true), configurable: false });
  Object.defineProperty(window, "sessionStorage", { value: storage({}, false), configurable: false });
  // Authored themes continue to work. This hint is available to future works,
  // but no broad CSS recolouring is applied to the author's canvas or artwork.
  document.documentElement.dataset["cloudigTheme"] = config.theme;
  window.addEventListener("error", event => send("error", String(event.message).slice(0, config.errorLimit)));
  window.addEventListener("unhandledrejection", () => send("error", "Unhandled error in saved work"));
  window.addEventListener("load", () => send("loaded", null), { once: true });
  const reportHeight = () => {
    const body = document.body; if (!body) return;
    const style = getComputedStyle(body);
    send("resize", Math.ceil(body.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)));
  };
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(reportHeight) : undefined; resize?.observe(document.body);
  window.addEventListener("load", reportHeight, { once: true });
  window.addEventListener("pagehide", () => resize?.disconnect(), { once: true });
  if (config.scrollRegions) {
    let dragged: HTMLElement | undefined;
    const active = new Set<HTMLElement>();
    // Walk the event path, not the entire React/Three document on every move.
    const owners = (event: PointerEvent) => [...new Set([...event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement), document.scrollingElement as HTMLElement, ...(dragged ? [dragged] : [])])].filter(node => {
      if (!node) return false; const style = getComputedStyle(node);
      return node === document.scrollingElement || /auto|scroll/u.test(`${style.overflowX} ${style.overflowY}`);
    });
    const hit = (node: HTMLElement, event: PointerEvent) => {
      const viewport = node === document.scrollingElement;
      const rect = viewport ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : node.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom &&
        (node.scrollHeight > node.clientHeight + 1 && event.clientX >= rect.right - Math.max((viewport ? innerWidth : node.offsetWidth) - node.clientWidth, 8) ||
         node.scrollWidth > node.clientWidth + 1 && event.clientY >= rect.bottom - Math.max((viewport ? innerHeight : node.offsetHeight) - node.clientHeight, 8));
    };
    const update = (event: PointerEvent) => {
      const next = new Set(owners(event).filter(node => node === dragged || hit(node, event)));
      for (const node of active) if (!next.has(node)) node.classList.remove("cloudig-scroll-operating");
      active.clear(); for (const node of next) { node.classList.add("cloudig-scroll-operating"); active.add(node); }
    };
    document.addEventListener("pointermove", update, { passive: true });
    document.addEventListener("pointerdown", event => { dragged = owners(event).find(node => hit(node, event)); update(event); }, { passive: true });
    for (const name of ["pointerup", "pointercancel"] as const) window.addEventListener(name, event => { dragged = undefined; update(event); }, { passive: true });
    const clear = () => { dragged = undefined; active.forEach(node => node.classList.remove("cloudig-scroll-operating")); active.clear(); };
    window.addEventListener("blur", clear); document.addEventListener("pointerleave", () => { if (!dragged) clear(); });
  }
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.protocol !== protocol || event.data?.token !== config.token) return;
    if (event.data.kind === "theme") document.documentElement.dataset["cloudigTheme"] = String(event.data.theme);
  });
  document.addEventListener("click", event => {
    const link = (event.target instanceof Element ? event.target : null)?.closest("a");
    // Do not let a source page turn the runtime surface into an external web
    // browser. Fragment navigation inside this work remains available.
    if (link && !link.getAttribute("href")?.startsWith("#")) event.preventDefault();
  }, true);
}
