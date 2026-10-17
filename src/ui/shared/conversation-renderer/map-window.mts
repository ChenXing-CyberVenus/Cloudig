import { MAP_LIMITS, MAP_PROTOCOL, type SavedMapPoint } from "./map-protocol.mts";
import { boxElement as el, boxButton as button, boxLabel as tr, type BoxContext } from "./box-controls.mts";

export function openSavedMap(ctx: BoxContext, title: string, places: readonly SavedMapPoint[], anchor: HTMLElement, frameUrl = "https://cloudig-map.local/runtime/map-frame.html"): () => void {
  const document = ctx.document, host = document.defaultView!;
  const dialog = el(ctx, "dialog", "cloudig-conversation-renderer cloudig-interactive-window cloudig-map-window");
  const theme = anchor.closest<HTMLElement>("[data-theme]")?.dataset["theme"] === "star-night" ? "star-night" : "dawn";
  dialog.dataset["theme"] = theme; dialog.setAttribute("aria-label", title);
  const header = el(ctx, "header", "cloudig-interactive-header"), body = el(ctx, "div", "cloudig-interactive-body");
  const status = el(ctx, "p", "cloudig-interactive-status", tr(ctx, "正在加载地图…", "Loading map…")); status.setAttribute("role", "status");
  let frame: HTMLIFrameElement | undefined, timer: ReturnType<typeof setTimeout> | undefined, token = "", closed = false;
  const origin = new URL(frameUrl, document.baseURI).origin;
  if (!ctx.mapSameOrigin && origin === new URL(document.baseURI).origin) throw new Error("Map runtime requires a separate origin");
  const stop = () => { clearTimeout(timer); if (frame) frame.contentWindow?.postMessage({ protocol: MAP_PROTOCOL, token, kind: "dispose" }, origin); frame?.remove(); frame = undefined; };
  const fail = () => { clearTimeout(timer); status.hidden = false; status.textContent = tr(ctx, "地图暂时无法加载，请检查网络后重试。已保存的地点资料不受影响。", "Map unavailable. Check your connection and retry; saved place details remain available."); dialog.dataset["state"] = "failed"; };
  const receive = (event: MessageEvent) => {
    if (closed || !frame || event.source !== frame.contentWindow || event.origin !== origin || event.data?.protocol !== MAP_PROTOCOL || event.data?.token !== token) return;
    if (event.data.kind === "ready") frame.contentWindow!.postMessage({ protocol: MAP_PROTOCOL, token, kind: "mount", places, theme, language: ctx.language }, origin);
    else if (event.data.kind === "loaded") { clearTimeout(timer); status.hidden = true; dialog.dataset["state"] = "ready"; }
    else if (event.data.kind === "error") fail();
    else if (event.data.kind === "external" && typeof event.data.url === "string") {
      try { const url = new URL(event.data.url); if (url.protocol === "https:" && ["openfreemap.org", "www.openmaptiles.org", "www.openstreetmap.org", "maplibre.org"].includes(url.hostname) && !url.username && !url.password) ctx.onOpenExternal?.(url.href); } catch { /* An invalid attribution is not navigation. */ }
    }
  };
  const start = () => {
    if (closed || ctx.signal.aborted) return;
    stop(); token = host.crypto.randomUUID(); dialog.dataset["state"] = "loading"; status.hidden = false;
    status.textContent = tr(ctx, "正在加载地图…", "Loading map…");
    frame = el(ctx, "iframe", "cloudig-interactive-frame"); frame.title = title; frame.referrerPolicy = "origin";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
    frame.src = `${frameUrl}#${token}`; body.replaceChildren(status, frame); timer = setTimeout(fail, MAP_LIMITS.loadTimeoutMs);
  };
  const close = () => {
    if (closed) return; closed = true; stop(); host.removeEventListener("message", receive); ctx.signal.removeEventListener("abort", close);
    dialog.close(); dialog.remove(); if (!ctx.signal.aborted) anchor.focus();
  };
  const dismiss = button(ctx, "×", close, "cloudig-interactive-close"); dismiss.setAttribute("aria-label", tr(ctx, "关闭地图", "Close map")); dismiss.title = dismiss.getAttribute("aria-label")!;
  const retry = button(ctx, tr(ctx, "重新加载", "Reload"), start, "cloudig-interactive-button");
  header.append(el(ctx, "h2", "", title), retry, dismiss); body.append(status); dialog.append(header, body);
  host.addEventListener("message", receive); ctx.signal.addEventListener("abort", close, { once: true });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  if (!ctx.signal.aborted) { document.body.append(dialog); dialog.showModal(); start(); } else close();
  return close;
}
