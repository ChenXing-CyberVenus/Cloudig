/** The original JSX stays in its resource; this is a disposable running shell. */
export function interactiveReactDocument(source: string, filename: string): string {
  const input = JSON.stringify({ source, filename }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;font-family:system-ui,sans-serif}</style>
<script src="cloudig-runtime:react"></script><script src="cloudig-runtime:tailwind"></script></head><body>
<div id="cloudig-react-root"></div><script type="application/json" id="cloudig-react-input">${input}</script>
<script>const input=JSON.parse(document.getElementById("cloudig-react-input").textContent);CloudigReactWork.mount(input.source,input.filename);</script>
</body></html>`;
}

export function interactiveProjectDocument(files: readonly { path: string; source?: string; url: string }[], entry: string, english: boolean): string {
  const input = JSON.stringify({ files, entry }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font-family:system-ui,sans-serif}.cloudig-project-note{padding:8px 16px;background:#292a2c;color:#e2e1e1;border-bottom:1px solid #71657e;font:13px/1.5 system-ui}</style>
<script src="cloudig-runtime:react"></script><script src="cloudig-runtime:tailwind"></script></head><body>
<aside class="cloudig-project-note">${english ? "Saved frontend preview · Original online services are unavailable offline." : "已保存的前端预览 · 原平台的在线服务无法离线调用。"}</aside>
<div id="root"></div><script type="application/json" id="cloudig-project-input">${input}</script>
<script>const p=JSON.parse(document.getElementById('cloudig-project-input').textContent);CloudigReactWork.mountProject(p.files,p.entry);</script></body></html>`;
}
