import { INTERACTIVE_LIMITS, INTERACTIVE_PROTOCOL, readInteractiveState, saveInteractiveState, type InteractiveFile, type InteractivePackage, type InteractiveFormat, type InteractiveBindings } from "./interactive-protocol.mts";
import { interactiveScrollCss, interactiveScrollFallback } from "./interactive-scroll.mts";
import { bindWorkWindowLayout, readWorkSize, type WorkSize } from "./work-window-layout.mts";
import type { JsonObject } from "../../../core/contracts/types.mts";
import { workDocuments } from "./work-documents.mts";
import { previewKind } from "./file-preview-policy.mts";
import { followReaderTheme } from "./reader-theme.mts";

export type InteractiveWindowOptions = Readonly<{
  document: Document;
  title: string;
  entry: string;
  format?: InteractiveFormat;
  source?: string;
  preview?: boolean;
  data?: JsonObject;
  icons?: readonly Readonly<{ name: string; path: string }>[];
  inlineParent?: HTMLElement;
  /** Inside a scrolling work window the host owns overflow, not a second 640px viewport. */
  flowHeight?: boolean;
  stateKey: string;
  theme: "dawn" | "star-night";
  themeRoot?: HTMLElement;
  language: "zh" | "en";
  signal: AbortSignal;
  readFiles: (signal: AbortSignal) => Promise<readonly InteractiveFile[]>;
  dependencies?: (files: readonly InteractiveFile[], signal: AbortSignal, format:InteractiveFormat) => Promise<{ files: readonly InteractiveFile[]; fontCss?: string }>;
  frameUrl?: string;
  /** Website runtime: sandbox the static wrapper into an opaque origin. */
  opaqueOrigin?: boolean;
  onClose?: () => void;
  bindings?: Readonly<{ snapshot: () => InteractiveBindings; subscribe: (update: () => void) => () => void; invoke: (name: string, args: unknown[]) => void }>;
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
  const sizing=bindWorkWindowLayout(dialog,header,body);
  let closed = false, frame: HTMLIFrameElement | undefined, token = "", timeout: ReturnType<typeof setTimeout> | undefined;
  let showingSource = false, runtimeState: "loading" | "ready" | "failed" = "loading";
  let sourceView: HTMLPreElement | undefined, workSize: WorkSize | undefined;
  let currentTheme = options.theme;
  const untheme = followReaderTheme(options.themeRoot ?? options.inlineParent, options.theme, theme => {
    currentTheme = theme; dialog.dataset["theme"] = theme;
    frame?.contentWindow?.postMessage({ protocol: INTERACTIVE_PROTOCOL, token, kind: "theme", theme, scrollCss:interactiveScrollFallback(interactiveScrollCss(document)) }, "*");
  });
  let runAbort = new AbortController(), packageFiles: readonly InteractiveFile[] = [], fontCss: string | undefined;
  let started = 0;
  let activeEntry=options.entry, activeFormat=options.format??"html", documents:ReturnType<typeof workDocuments>=[];
  const stateKey=()=>activeEntry===options.entry?options.stateKey:`${options.stateKey}\u0000${activeEntry}`;
  const button = (label: string, action: () => void) => { const b = node("button", "cloudig-interactive-button", label); b.type = "button"; b.addEventListener("click", action); toolbar.append(b); return b; };
  const problem = (message: string) => { runtimeState = "failed"; status.hidden = showingSource; status.textContent = message; if (!showingSource) dialog.dataset["state"] = "failed"; clearTimeout(timeout); };
  const relay = (event: MessageEvent) => {
    if (closed || !frame || event.source !== frame.contentWindow || event.data?.protocol !== INTERACTIVE_PROTOCOL || event.data?.token !== token) return;
    const { kind, detail } = event.data;
    if (kind === "ready") {
      const payload: InteractivePackage = { protocol: INTERACTIVE_PROTOCOL, token, entry: activeEntry, format: activeFormat, files: packageFiles, state: readInteractiveState(stateKey()), theme: currentTheme, language: options.language, scrollCss: interactiveScrollCss(document),
        ...(options.preview ? { preview: true } : {}), ...(options.data?{data:options.data}:{}), ...(documents.length?{documents:documents.map(item=>item.path)}:{}),
        ...(options.source ? { source: options.source } : {}), ...(options.icons ? { icons: options.icons } : {}), ...(fontCss ? { fontCss } : {}), ...(options.bindings ? { bindings: options.bindings.snapshot() } : {}) };
      frame.contentWindow!.postMessage({ protocol: INTERACTIVE_PROTOCOL, token, kind: "mount", detail: payload }, "*");
    } else if (kind === "loaded") { clearTimeout(timeout); if (runtimeState !== "failed") { runtimeState = "ready"; status.hidden = true; if (!showingSource) dialog.dataset["state"] = "ready"; dialog.dataset["loadMs"] = String(Math.round(host.performance.now() - started)); } }
    else if (kind === "resize") {
      const measured=readWorkSize(detail);if(!measured)return;
      if (showingSource) return;
      workSize = measured;
      sizing.update(measured);
      if(options.inlineParent&&!expanded&&measured.layout==="flow"){
        dialog.style.setProperty("--cloudig-inline-height", `${Math.max(INTERACTIVE_LIMITS.inlineMinimumHeight, measured.height)}px`);
      }
    } else if (kind === "state") {
      try { saveInteractiveState(stateKey(), detail); }
      catch { problem(say("本次运行的作品进度空间已满；原对话未改动。", "Session progress storage is full; the original conversation is unchanged.")); }
    } else if(kind==="document"&&typeof detail==="string"){
      const selected=documents.find(item=>item.path===detail);if(!selected)return;
      chooseDocument(selected.path);
    } else if (kind === "binding" && options.bindings && detail && typeof detail === "object" && typeof detail.name === "string" && Array.isArray(detail.args)) {
      if (options.bindings.snapshot().callbacks.includes(detail.name)) options.bindings.invoke(detail.name, detail.args);
    } else if (kind === "state-full") problem(say("这份作品的临时进度已达上限。", "This work has reached the session progress limit."));
    else if (kind === "runtime-diagnostic") {
      // A saved author's exception is console evidence, not Cloudig UI prose
      // and not a failed mount. Keep interacting with the loaded work.
      dialog.dataset["runtimeDiagnostic"] = typeof detail === "string" ? detail.slice(0, INTERACTIVE_LIMITS.errorMessageCharacters) : "Saved work error";
    }
    else if (kind === "error") problem(`${say("无法打开作品", "Could not open work")}: ${typeof detail === "string" ? detail.slice(0, INTERACTIVE_LIMITS.errorMessageCharacters) : say("运行失败", "Could not run")}`);
  };
  host.addEventListener("message", relay);
  const unbind = options.bindings?.subscribe(() => { if (!closed && frame) frame.contentWindow?.postMessage({ protocol: INTERACTIVE_PROTOCOL, token, kind: "bindings", detail: options.bindings!.snapshot() }, "*"); });
  const stop = () => { clearTimeout(timeout); runAbort.abort(); frame?.remove(); frame = undefined; };
  const close = () => {
    if (closed) return; closed = true; observer?.disconnect(); sizing.close(); stop(); host.removeEventListener("message", relay); options.signal.removeEventListener("abort", close);
    unbind?.(); untheme(); packageFiles = []; dialog.close?.(); dialog.remove(); options.onClose?.();
  };
  const start = async () => {
    observer?.disconnect(); collapsed = false; body.hidden = false;
    if (options.inlineParent && !expanded) { closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title); }
    stop(); runAbort = new AbortController(); const signal = runAbort.signal;
    showingSource = false; runtimeState = "loading"; sourceView = undefined; workSize = undefined;
    started = host.performance.now();
    status.hidden = false; status.textContent = say("正在打开作品…", "Opening work…"); body.replaceChildren(status); dialog.dataset["state"] = "loading";
    sizing.refresh();
    try {
      const originals = await options.readFiles(signal); if (closed || signal.aborted) return;
      const preview=options.preview?originals.find(f=>f.path===options.entry):undefined;
      sourceButton.hidden=!!preview&&["pptx","xlsx","docx","pdf","png","jpg","jpeg","webp","gif","audio","video","glb"].includes(previewKind(preview.path,preview.mime)??"");
      documents=workDocuments(options.data,originals.map(file=>file.path),options.language==="en");
      documentSelect.replaceChildren(); documentSelect.hidden=documents.length===0;
      for(const choice of [{path:options.entry,title:say("本次保存", "Saved work")},...documents]){const option=document.createElement("option");option.value=choice.path;option.textContent=choice.title;documentSelect.append(option);}documentSelect.value=activeEntry;
      dialog.dataset["readMs"] = String(Math.round(host.performance.now() - started));
      const deps = await options.dependencies?.(originals, signal, activeFormat); if (closed || signal.aborted) return;
      dialog.dataset["prepareMs"] = String(Math.round(host.performance.now() - started));
      packageFiles = [...originals, ...deps?.files ?? []]; fontCss = deps?.fontCss;
      token = host.crypto.randomUUID(); frame = node("iframe", "cloudig-interactive-frame"); frame.title = options.title;
      // This URL MUST be a different origin from the application. The work's
      // own stable origin does not grant same-origin access to Cloudig's UI.
      const frameUrl = options.frameUrl ?? "https://cloudig-work.invalid/runtime/interactive-frame.html";
      if (!options.opaqueOrigin && new URL(frameUrl, document.baseURI).origin === new URL(document.baseURI).origin) throw new Error("Interactive work requires a separate origin");
      frame.setAttribute("sandbox", options.opaqueOrigin ? "allow-scripts allow-downloads" : "allow-scripts allow-same-origin allow-downloads"); frame.src = `${frameUrl}#${token}`;
      frame.setAttribute("allow", "autoplay *; camera 'none'; microphone 'none'; geolocation 'none'"); frame.referrerPolicy = "no-referrer";
      timeout = setTimeout(() => { if (!closed && !signal.aborted) problem(say("作品未能完成加载；可以查看源码或重新运行。", "The work did not finish loading; view its source or try running again.")); }, INTERACTIVE_LIMITS.loadTimeoutMs);
      body.append(frame);
    } catch (error) { if (!closed && !signal.aborted) problem(`${say("无法打开作品", "Could not open work")}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  button(say("作品", "Work"), () => {
    if (closed) return;
    if (!frame || runtimeState === "failed") { void start(); return; }
    // A view switch is not a rerun: retain the author's heap, canvas and input.
    showingSource = false; sourceView?.remove(); sourceView = undefined;
    frame.removeAttribute("inert"); frame.removeAttribute("aria-hidden");
    dialog.dataset["state"] = runtimeState; status.hidden = runtimeState === "ready";
    sizing.update(workSize ?? { height: 0, layout: "viewport" });
  });
  function chooseDocument(path:string):void{
    const selected=documents.find(item=>item.path===path);if(path!==options.entry&&!selected)return;
    activeEntry=path;activeFormat=selected?.format??options.format??"html";title.textContent=selected?.title??options.title;title.title=title.textContent;back.hidden=path===options.entry;void start();
  }
  const back=button(say("返回正文", "Back to document"),()=>chooseDocument(options.entry));back.hidden=true;
  const documentSelect=node("select","cloudig-work-documents");documentSelect.hidden=true;documentSelect.setAttribute("aria-label",say("作品与保存记录","Work and saved revisions"));documentSelect.addEventListener("change",()=>chooseDocument(documentSelect.value));toolbar.append(documentSelect);
  const sourceButton=button(say("源码", "Source"), () => {
    if (closed) return; const entry = packageFiles.find(file => file.path === activeEntry); if (!entry) return;
    showingSource = true; collapsed = false; body.hidden = false; status.hidden = true;
    frame?.setAttribute("inert", ""); frame?.setAttribute("aria-hidden", "true");
    if (options.inlineParent && !expanded) { closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title); }
    sourceView?.remove(); sourceView = node("pre", "cloudig-interactive-source", new TextDecoder().decode(entry.bytes)); sourceView.dataset["scrollRegion"] = ""; body.append(sourceView); dialog.dataset["state"] = "source";
  });
  const returnInline = () => { dialog.close(); expanded = false; dialog.classList.add("cloudig-interactive-box"); dialog.open = true; sizing.refresh(); closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title); };
  const dismiss = () => {
    if (!options.inlineParent) { close(); return; }
    if (expanded) { returnInline(); return; }
    if (collapsed) { void start(); closeButton.title = say("收起作品", "Collapse work"); }
    else { stop(); observer?.disconnect(); collapsed = true; body.hidden = true; closeButton.title = say("展开作品", "Expand work"); }
    closeButton.setAttribute("aria-label", closeButton.title);
  };
  if (options.inlineParent) {
    if (options.flowHeight) dialog.dataset["flowHeight"] = "true";
    closeButton.title = say("收起作品", "Collapse work"); closeButton.setAttribute("aria-label", closeButton.title);
    const enlarge=button(say("放大", "Enlarge"), () => {
      if (closed || expanded) return; dialog.close(); expanded = true; dialog.classList.remove("cloudig-interactive-box"); dialog.showModal();sizing.refresh();
      closeButton.title = say("返回对话", "Back to conversation"); closeButton.setAttribute("aria-label", closeButton.title);
      if (collapsed) void start();
    });
    enlarge.classList.add("cloudig-interactive-enlarge");
  }
  closeButton.addEventListener("click", dismiss); dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  options.signal.addEventListener("abort", close, { once: true });
  if (!options.signal.aborted) {
    (options.inlineParent ?? document.body).append(dialog);
    sizing.refresh();
    if (!options.inlineParent) { dialog.showModal(); void start(); }
    else {
      dialog.open = true;
      if (typeof host.IntersectionObserver === "function") { observer = new host.IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !closed && !collapsed) void start(); }); observer.observe(dialog); }
      else void start();
    }
  } else close();
  return { close, element: dialog };
}
