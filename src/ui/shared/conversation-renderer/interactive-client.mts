import type { InteractiveState, InteractiveBindings } from "./interactive-protocol.mts";

/** This self-contained function is serialized into the sandboxed work document.
 * Its only outward capability is reporting this one work's in-memory progress.
 * No bridge commands, resource reads, network proxies or filesystem paths. */
export function interactiveClient(config: { token: string; state: InteractiveState; stateLimit: number; errorLimit: number; theme: string; scrollRegions?: boolean; bindings?: InteractiveBindings }): void {
  const protocol = "cloudig/interactive-runtime/1";
  const send = (kind: string, detail: unknown) => window.parent.postMessage({ protocol, token: config.token, kind, detail }, "*");
  let bindings = config.bindings;
  const effects = new Set<() => void>();
  if (bindings) {
    const live = new Proxy(Object.create(null), { get(_object, key) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) return undefined;
      if (bindings?.callbacks.includes(key)) return (...args: unknown[]) => send("binding", { name: key, args });
      return bindings?.values[key];
    } });
    Object.defineProperty(window, "__bindings", { value: live, configurable: false });
    Object.defineProperty(window, "__effect", { value: (effect: () => void) => { if (typeof effect !== "function") return; effects.add(effect); effect(); return () => effects.delete(effect); }, configurable: false });
    window.addEventListener("pagehide", () => effects.clear(), { once: true });
  }
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
  let heightSignature="", viewportSelectors:string[]=[], layoutReady=false;
  const relativeHeight=(value:string)=>/100(?:\.0+)?%|\d+(?:\.\d+)?(?:d|s|l)?vh/iu.test(value);
  const collectViewportSelectors=()=>{
    viewportSelectors=[];
    const scan=(rules:CSSRuleList)=>{for(const rule of rules){
      if("selectorText" in rule&&"style" in rule){const style=(rule as CSSStyleRule).style;if(relativeHeight(`${style.height} ${style.minHeight}`))viewportSelectors.push((rule as CSSStyleRule).selectorText);}
      else if("cssRules" in rule){if("media" in rule&&!matchMedia((rule as CSSMediaRule).conditionText).matches)continue;scan((rule as CSSGroupingRule).cssRules);}
    }};
    for(const sheet of document.styleSheets)try{if(!sheet.disabled)scan(sheet.cssRules);}catch{/* An inaccessible author sheet grants no inspection capability. */}
  };
  const reportHeight = () => {
    const body = document.body; if (!body||!layoutReady) return;
    const style = getComputedStyle(body);
    // Examine the outer layout chain, not every canvas/button with a height.
    // Percent/vh roots need a stable viewport, not a feedback-driven auto size.
    const roots:HTMLElement[]=[document.documentElement,body];let parent=body;
    for(let depth=0;depth<4;depth++){
      const children=[...parent.children].filter((n):n is HTMLElement=>n instanceof HTMLElement&&!['SCRIPT','STYLE','LINK','TEMPLATE'].includes(n.tagName)&&getComputedStyle(n).display!=="none");
      if(children.length!==1)break;parent=children[0]!;roots.push(parent);
    }
    const viewport=roots.some(node=>relativeHeight(`${node.style.height} ${node.style.minHeight}`)||viewportSelectors.some(selector=>{try{return node.matches(selector);}catch{return false;}}))||[...body.children].some(node=>{
      if(!(node instanceof HTMLElement))return false;const css=getComputedStyle(node),rect=node.getBoundingClientRect();return css.position==="fixed"&&rect.height>=innerHeight-1&&rect.width>=innerWidth-1;
    });
    const height=Math.ceil(Math.max(body.getBoundingClientRect().height,body.scrollHeight)+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0));
    const detail={height,layout:viewport?"viewport":"flow"},signature=JSON.stringify(detail);
    if(signature!==heightSignature){heightSignature=signature;send("resize",detail);}
  };
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(reportHeight) : undefined; resize?.observe(document.body);
  const resized=()=>{collectViewportSelectors();layoutReady=true;reportHeight();};
  window.addEventListener("load", resized, { once: true });window.addEventListener("resize",resized);
  window.addEventListener("pagehide", () => {resize?.disconnect();window.removeEventListener("resize",resized);}, { once: true });
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
    if (event.data.kind === "bindings" && bindings && event.data.detail?.values && Array.isArray(event.data.detail.callbacks)) { bindings = event.data.detail; for (const effect of effects) effect(); }
  });
  document.addEventListener("click", event => {
    const link = (event.target instanceof Element ? event.target : null)?.closest("a");
    // Do not let a source page turn the runtime surface into an external web
    // browser. Fragment navigation inside this work remains available.
    if (link && !link.getAttribute("href")?.startsWith("#")) event.preventDefault();
  }, true);
}
