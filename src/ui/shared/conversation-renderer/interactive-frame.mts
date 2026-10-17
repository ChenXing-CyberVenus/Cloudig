import { INTERACTIVE_PROTOCOL, type InteractivePackage } from "./interactive-protocol.mts";
import { prepareInteractiveHtml } from "./interactive-document.mts";

const token = location.hash.slice(1), parent = window.parent;
let mounted = false;
const urls: string[] = [];
const send = (kind: string, detail: unknown) => parent.postMessage({ protocol: INTERACTIVE_PROTOCOL, token, kind, detail }, "*");
window.addEventListener("message", async event => {
  const data = event.data;
  if (data?.protocol !== INTERACTIVE_PROTOCOL || data?.token !== token) return;
  if (event.source !== parent) return;
  if (data.kind === "theme") { document.documentElement.dataset["cloudigTheme"] = String(data.theme); return; }
  if (data.kind !== "mount" || mounted) return;
  mounted = true;
  try {
    const input = data.detail as InteractivePackage;
    if (input.token !== token || !Array.isArray(input.files)) throw new TypeError("Invalid work package");
    const createUrl = (bytes: ArrayBuffer | string, mime: string) => { const url = URL.createObjectURL(new Blob([bytes], { type: mime })); urls.push(url); return url; };
    const html = prepareInteractiveHtml(input, document, createUrl);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const scripts = [...parsed.querySelectorAll("script")].map((script, index) => {
      const marker = parsed.createElement("template"), id = `${token}-${index}`;
      marker.dataset["cloudigWorkScript"] = id; script.replaceWith(marker); return { script, id };
    });
    // One sandbox is sufficient. Keep the running document and its Blob assets
    // in the dedicated work origin, never the application's origin.
    // The response's CSP/sandbox remain active when its document tree changes.
    document.documentElement.replaceWith(document.importNode(parsed.documentElement, true));
    for (const { script, id } of scripts) {
      const target = document.querySelector(`[data-cloudig-work-script="${id}"]`); if (!target) continue;
      const live = document.createElement("script");
      for (const attr of script.attributes) if (!["async", "defer"].includes(attr.name)) live.setAttribute(attr.name, attr.value);
      live.textContent = script.textContent; live.async = false;
      if (live.src || live.type === "module") await new Promise<void>((resolve, reject) => {
        live.onload = () => resolve(); live.onerror = () => reject(new Error("A saved work script could not load")); target.replaceWith(live);
      }); else target.replaceWith(live);
    }
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await document.fonts.ready;
    window.dispatchEvent(new Event("load"));
  } catch (error) { send("error", error instanceof Error ? error.message : "Could not open the saved work"); }
});
window.addEventListener("pagehide", () => { for (const url of urls) URL.revokeObjectURL(url); }, { once: true });
send("ready", null);
