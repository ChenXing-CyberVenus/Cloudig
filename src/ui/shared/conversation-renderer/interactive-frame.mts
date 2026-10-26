import { INTERACTIVE_PROTOCOL, type InteractivePackage } from "./interactive-protocol.mts";
import { prepareInteractiveHtml } from "./interactive-document.mts";
import { replayWorkScripts, finishWorkDocument } from "./interactive-script-replay.mts";
import { isBinaryPreview, previewTarget } from "./file-preview-policy.mts";
import { mountAudioControls } from "./media-controls.mts";
import { installVideoPreview } from "./media-video-preview.mts";

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
    // One sandbox is sufficient. Keep the running document and its Blob assets
    // in the dedicated work origin, never the application's origin.
    // The response's CSP/sandbox remain active when its document tree changes.
    await replayWorkScripts(document,parsed,token);
    if(input.preview)for(const media of document.querySelectorAll<HTMLAudioElement>(".saved-media audio"))media.after(mountAudioControls(media,input.language==="en"));
    if(input.preview)for(const video of document.querySelectorAll<HTMLVideoElement>(".saved-media video"))installVideoPreview(video,input);
    const preview = previewTarget(input);
    if (preview && isBinaryPreview(preview)) {
      const runtime = (window as unknown as { CloudigFilePreview?: { render: (file: typeof preview, input: InteractivePackage) => Promise<void> } }).CloudigFilePreview;
      if (!runtime) throw new Error("File preview runtime is missing");
      await runtime.render(preview,input);
    }
    await finishWorkDocument(document);
    const diagrams = (window as unknown as { CloudigDocumentPreview?: { render(): Promise<void> } }).CloudigDocumentPreview;
    if (diagrams) await diagrams.render();
  } catch (error) { send("error", error instanceof Error ? error.message : "Could not open the saved work"); }
});
window.addEventListener("pagehide", () => { for (const url of urls) URL.revokeObjectURL(url); }, { once: true });
send("ready", null);
