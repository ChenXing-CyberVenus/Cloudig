// This small script paints independently of the application module graph and
// Library initialization. It uses the same GIF as all major-page transitions.
(async () => {
  let ready = false;
  try {
    const image = document.querySelector(".route-transition img");
    await image.decode();
    // The native window already plays this same GIF while WebView starts.
    // Hand off only once decoded; Library still waits for the painted ack below.
    globalThis.chrome?.webview?.postMessage({
      protocol: "cloudig/web-bridge/1.0.0", request: "w_loading_decoded", command: "shell.loading", payload: { ready: image.naturalWidth > 0, stage: "decoded" }
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    ready = image.naturalWidth > 0;
  } finally {
    document.documentElement.dataset.loadingPainted = String(ready);
    globalThis.chrome?.webview?.postMessage({
      protocol: "cloudig/web-bridge/1.0.0", request: "w_loading", command: "shell.loading", payload: { ready }
    });
  }
})().catch(() => { /* The native host displays the startup failure. */ });
