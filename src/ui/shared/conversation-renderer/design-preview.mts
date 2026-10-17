/** Replay the captured Design component's defaults/renderVals in its sandbox.
 * This is a read preview, not Claude's design-editor bridge or cloud service. */
export function prepareDesignPreview(parsed: Document): void {
  const component = parsed.querySelector("x-dc"), source = parsed.querySelector<HTMLScriptElement>('script[type="text/x-dc"][data-props]');
  if (!component || !source) throw new Error("The saved Design has no supported component");
  const properties = JSON.parse(source.getAttribute("data-props")!) as Record<string, { default?: unknown }>;
  const defaults = Object.fromEntries(Object.entries(properties).filter(([key]) => !key.startsWith("$")).map(([key, item]) => [key, item.default ?? null]));
  for (const script of parsed.querySelectorAll('script[src="./support.js"],script[src="support.js"]')) script.remove();
  const runtime = parsed.createElement("script");
  runtime.textContent = `(()=>{class DCLogic{constructor(props){this.props=props;}}\n${source.textContent ?? ""}\nconst values=new Component(${JSON.stringify(defaults).replaceAll("<", "\\u003c")}).renderVals();
const root=document.querySelector('x-dc');const replace=text=>text.replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g,(_,key)=>{if(!(key in values))throw new Error('Missing Design value: '+key);return String(values[key]??'')});
for(const element of [root,...root.querySelectorAll('*')])for(const attr of [...element.attributes])if(attr.value.includes('{{'))element.setAttribute(attr.name,replace(attr.value));
const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())if(node.textContent.includes('{{'))node.textContent=replace(node.textContent);
})();`;
  source.replaceWith(runtime);
  const style = parsed.createElement("style"); style.textContent = "html,body{min-height:100%;margin:0}body{display:grid;place-items:center;min-height:100vh}x-dc{display:block}helmet{display:contents}"; parsed.head.append(style);
}
