/** The original JSX stays in its resource; this is a disposable running shell. */
export function interactiveReactDocument(source: string, filename: string): string {
  const input = JSON.stringify({ source, filename }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}#cloudig-react-root{min-height:100vh}</style>
<script src="cloudig-runtime:react"></script><script src="cloudig-runtime:tailwind"></script></head><body>
<div id="cloudig-react-root"></div><script type="application/json" id="cloudig-react-input">${input}</script>
<script>const input=JSON.parse(document.getElementById("cloudig-react-input").textContent);CloudigReactWork.mount(input.source,input.filename);</script>
</body></html>`;
}
