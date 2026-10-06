import { INTERACTIVE_LIMITS, INTERACTIVE_PROTOCOL, readInteractiveState, saveInteractiveState, type InteractiveFile, type InteractivePackage, type InteractiveFormat } from "./interactive-protocol.mts";
import { interactiveScrollCss } from "./interactive-scroll.mts";

export type InteractiveWindowOptions = Readonly<{
  document: Document;
  title: string;
  entry: string;
  format?: InteractiveFormat;
  source?: string;
  icons?: readonly Readonly<{ name: string; path: string }>[];
  inlineParent?: HTMLElement;
  stateKey: string;
  theme: "dawn" | "star-night";
  language: "zh" | "en";
  signal: AbortSignal;
  readFiles: (signal: AbortSignal) => Promise<readonly InteractiveFile[]>;
  dependencies?: (files: readonly InteractiveFile[], signal: AbortSignal) => Promise<{ files: readonly InteractiveFile[]; fontCss?: string }>;
  frameUrl?: string;
  /** Website runtime: sandbox the static wrapper into an opaque origin. */
  opaqueOrigin?: boolean;
  onClose?: () => void;
}>;

/** One work, one disposable sandbox. Windows start on demand; light Boxes
 * start when visible. Enlargement retains the same iframe and live state. */
export function openInteractiveWindow(options: InteractiveWindowOptions): { close: () => void; element: HTMLDialogElement } {
  const { document } = options, host = document.defaultView!;
  const say = (zh: string, en: string) => options.language === "en" ? en : zh;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
    const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n;
  };
  const dialog = node("dialog", "cloudig-conversation-renderer cloudig-interactive-window"); dialog.dataset["theme"] = options.theme;
  let expanded = !options.inlineParent, collapsed = false, observer: IntersectionObserver | undefined;
  if (options.inlineParent) dialog.classList.add("cloudig-interactive-box");
  const title = node("h2", "", options.title), header = node("header", "cloudig-interactive-header"), toolbar = node("div", "cloudig-interactive-toolbar"); title.title=options.title;
  const closeButton = node("button", "cloudig-interactive-close", "×"); closeButton.type = "button"; closeButton.title = say("关闭作品", "Close work"); closeButton.setAttribute("aria-label", closeButton.title);
  const body = node("div", "cloudig-interactive-body"), status = node("p", "cloudig-interactive-status", say("正在打开作品…", "Opening work…")); status.setAttribute("role", "status");
  header.append(title, toolbar, closeButton); body.append(status); dialog.append(header, body);
  let closed = false, frame: HTMLIFrameElement | undefined, token = "", timeout: ReturnType<typeof setTimeout> | undefined;
  let runAbort = new AbortController(), packageFiles: readonly InteractiveFile[] = [], fontCss: string | undefined;
  let started = 0;
  const button = (label: string, action: () => void) => { const b = node("button", "cloudig-interactive-button", label); b.type = "button"; b.addEventListener("click", action); toolbar.append(b); return b; };
  const problem = (message: string) => { status.hidden = false; status.textContent = message; dialog.dataset["state"] = "failed"; clearTimeout(timeout); };
  const relay = (event: MessageEvent) => {
    if (closed || !frame || event.source !== frame.contentWindow || event.data?.protocol !== INTERACTIVE_PROTOCOL || event.data?.token !== token) return;
    const { kind, detail } = event.data;
    if (kind === "ready") {
      const payload: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token, entry: options.entry, format: options.format ?? "html", files: packageFiles, state: readInteractiveState(options.stateKey), theme: options.theme, language: options.language, scrollCss: interactiveScrollCss(document),
        ...(options.source ? { source: options.source } : {}), ...(options.icons ? { icons: options.icons } : {}), ...(fontCss ? { fontCss } : {}) };
      frame.contentWindow!.postMessage({ protocol: INTERACTIVE_PROTOCOL, token, kind: "mount", detail: payload }, "*");
    } else if (kind === "loaded") { clearTimeout(timeout); if (dialog.dataset["state"] !== "failed") { status.hidden = true; dialog.dataset["state"] = "ready"; dialog.dataset["loadMs"] = String(Math.round(host.performance.now() - started)); } }
    else if (kind === "resize" && options.inlineParent && !expanded && typeof detail === "number" && Number.isFinite(detail)) {
      dialog.style.setProperty("--cloudig-inline-height", `${Math.max(INTERACTIVE_LIMITS.inlineMinimumHeight, Math.min(INTERACTIVE_LIMITS.inlineMaximumHeight, detail))}px`);
    } else if (kind === "state") {
      try { saveInteractiveState(options.stateKey, detail); }
      catch { problem(say("本次运行的作品进度空间已满；原对话未改动。", "Session progress storage is full; the original conversation is unchanged.")); }
    } else if (kind === "state-full") problem(say("这份作品的临时进度已达上限。", "This work has reached the session progress limit."));
    else if (kind === "error") problem(`${say("作品运行提示", "Work runtime")}: ${typeof detail === "string" ? detail.slice(0, INTERACTIVE_LIMITS.errorMessageCharacters) : say("运行失败", "Could not run")}`);
  };
  host.addEventListener("message", relay);
  const stop = () => { clearTimeout(timeout); runAbort.abort(); frame?.remove(); frame = undefined; };
  const close = () => {
    if (closed) return; closed = true; observer?.disconnect(); stop(); host.removeEventListener("message", relay); options.signal.removeEventListener("abort", close);
    packageFiles = []; dialog.close?.(); dialog.remove(); options.onClose?.();
  };
  const start = async () => {
    observer?.disconnect(); collapsed = false; body.hidden = false;
    if (options.inlineParent && !expanded) { closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title); }
    stop(); runAbort = new AbortController(); const signal = runAbort.signal;
    started = host.performance.now();
    status.hidden = false; status.textContent = say("正在打开作品…", "Opening work…"); body.replaceChildren(status); dialog.dataset["state"] = "loading";
    try {
      const originals = await options.readFiles(signal); if (closed || signal.aborted) return;
      dialog.dataset["readMs"] = String(Math.round(host.performance.now() - started));
      const deps = await options.dependencies?.(originals, signal); if (closed || signal.aborted) return;
      dialog.dataset["prepareMs"] = String(Math.round(host.performance.now() - started));
      packageFiles = [...originals, ...deps?.files ?? []]; fontCss = deps?.fontCss;
      token = host.crypto.randomUUID(); frame = node("iframe", "cloudig-interactive-frame"); frame.title = options.title;
      // This URL MUST be a different origin from the application. The work's
      // own stable origin does not grant same-origin access to Cloudig's UI.
      const frameUrl = options.frameUrl ?? "https://cloudig-work.invalid/runtime/interactive-frame.html";
      if (!options.opaqueOrigin && new URL(frameUrl, document.baseURI).origin === new URL(document.baseURI).origin) throw new Error("Interactive work requires a separate origin");
      frame.setAttribute("sandbox", options.opaqueOrigin ? "allow-scripts" : "allow-scripts allow-same-origin"); frame.src = `${frameUrl}#${token}`;
      frame.setAttribute("allow", "autoplay *; camera 'none'; microphone 'none'; geolocation 'none'"); frame.referrerPolicy = "no-referrer";
      timeout = setTimeout(() => { if (!closed && !signal.aborted) problem(say("作品未能完成加载；可以查看源码或重新运行。", "The work did not finish loading; view its source or try running again.")); }, INTERACTIVE_LIMITS.loadTimeoutMs);
      body.append(frame);
    } catch (error) { if (!closed && !signal.aborted) problem(`${say("无法打开作品", "Could not open work")}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  button(say("作品", "Work"), () => { if (!closed) void start(); });
  button(say("源码", "Source"), () => {
    if (closed) return; const entry = packageFiles.find(file => file.path === options.entry); if (!entry) return;
    stop(); collapsed = false; body.hidden = false;
    if (options.inlineParent && !expanded) { closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title); }
    const source = node("pre", "cloudig-interactive-source", new TextDecoder().decode(entry.bytes)); source.dataset["scrollRegion"] = ""; body.replaceChildren(source); dialog.dataset["state"] = "source";
  });
  const returnInline = () => { dialog.close(); expanded = false; dialog.classList.add("cloudig-interactive-box"); dialog.open = true; closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title); };
  const dismiss = () => {
    if (!options.inlineParent) { close(); return; }
    if (expanded) { returnInline(); return; }
    if (collapsed) { void start(); closeButton.title = say("收起作品", "Collapse work"); }
    else { stop(); observer?.disconnect(); collapsed = true; body.hidden = true; closeButton.title = say("展开作品", "Expand work"); }
    closeButton.setAttribute("aria-label", closeButton.title);
  };
  if (options.inlineParent) {
    closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title);
    const enlarge=button(say("放大", "Enlarge"), () => {
      if (closed || expanded) return; dialog.close(); expanded = true; dialog.classList.remove("cloudig-interactive-box"); dialog.showModal();
      closeButton.title = say("返回对话", "Back to conversation"); closeButton.setAttribute("aria-label", closeButton.title);
      if (collapsed) void start();
    });
    enlarge.classList.add("cloudig-interactive-enlarge");
  }
  closeButton.addEventListener("click", dismiss); dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  options.signal.addEventListener("abort", close, { once: true });
  if (!options.signal.aborted) {
    (options.inlineParent ?? document.body).append(dialog);
    if (!options.inlineParent) { dialog.showModal(); void start(); }
    else {
      dialog.open = true;
      if (typeof host.IntersectionObserver === "function") { observer = new host.IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !closed && !collapsed) void start(); }); observer.observe(dialog); }
      else void start();
    }
  } else close();
  return { close, element: dialog };
}
