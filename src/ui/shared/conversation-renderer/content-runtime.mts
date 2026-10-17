import katex from "katex";
import "katex/contrib/mhchem";
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItInstance } from "markdown-it";
import texmath from "markdown-it-texmath";
import hljs from "highlight.js";
import { osisInlineDollarRanges, type InlineDollarRange } from "./dollar-boundaries.mjs";

export type RendererTheme = "dawn" | "star-night";

export type OfflineContentRuntime = Readonly<{
  renderMarkdown(source: string, preserveLineBreaks?: boolean): string;
  highlightCode?(source: string, language?: string): string;
  renderMath(source: string, display: boolean): string;
  renderMermaid(source: string, id: string, theme: RendererTheme): Promise<string>;
  dispose?(): void;
}>;

function externalHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function markdownRuntime(): MarkdownItInstance {
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
    highlight: highlightCode
  });
  markdown.validateLink = externalHttpUrl;
  markdown.renderer.rules["softbreak"] = (_tokens, _index, _options, env) => env?.["preserveLineBreaks"] ? "<br>\n" : "\n";
  markdown.use(texmath, {
    engine: katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: {
      displayMode: false,
      output: "htmlAndMathml",
      throwOnError: false,
      strict: "ignore",
      trust: false
    }
  });
  // texmath registers dollars first, then brackets; replace only the first
  // single-dollar rule. Explicit brackets, $$ blocks and environments retain
  // their established renderer. Never rewrite the source into placeholders.
  const dollarRanges = new WeakMap<object, ReadonlyMap<number, InlineDollarRange>>();
  markdown.inline.ruler.at("math_inline", (state, silent) => {
    if (state.src[state.pos] !== "$") return false;
    let ranges = dollarRanges.get(state);
    if (!ranges) { ranges = new Map(osisInlineDollarRanges(state.src).map(range => [range.start, range])); dollarRanges.set(state, ranges); }
    const range = ranges.get(state.pos);
    if (!range || range.end > state.posMax) return false;
    if (!silent) { const token = state.push("math_inline", "math", 0); token.content = range.tex; token.markup = "$"; }
    state.pos = range.end;
    return true;
  });
  const original = markdown.renderer.rules["link_open"];
  markdown.renderer.rules["link_open"] = (tokens, index, options, env, renderer) => {
    const token = tokens[index]!;
    token.attrSet("rel", "noopener noreferrer");
    token.attrSet("data-cloudig-external", "true");
    return original ? original(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
  };
  // Embedded image bytes use canonical resource blocks. A URL still present in
  // Markdown is only a source reference, not an offline image: keep its exact
  // position, alt and title as a readable link, just like the exported HTML.
  markdown.renderer.rules["image"] = (tokens, index, options, env, renderer) => {
    const token = tokens[index]!;
    const url = String(token.attrGet("src") ?? "");
    const alt = renderer.renderInlineAsText(token.children ?? [], options, env);
    const title = String(token.attrGet("title") ?? "");
    const escape = markdown.utils.escapeHtml;
    return `<a class="cloudig-external-resource" href="${escape(url)}" data-cloudig-external="true" rel="noopener noreferrer"${title ? ` title="${escape(title)}"` : ""}>${escape(alt || url)}</a>`;
  };
  return markdown;
}

function highlightCode(source: string, language = ""): string {
  // No language guessing over large archives. Unsupported/very large blocks
  // keep every character, without paying an unbounded highlighting cost.
  if (language && source.length <= 250_000 && hljs.getLanguage(language)) {
    try { return hljs.highlight(source, { language, ignoreIllegals: true }).value; } catch { /* Literal code remains readable. */ }
  }
  return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function createOfflineContentRuntime(): OfflineContentRuntime {
  const markdown = markdownRuntime();
  let mermaidQueue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let frame: HTMLIFrameElement | undefined;
  let frameReady: Promise<HTMLIFrameElement> | undefined;
  let rejectFrame: ((reason: Error) => void) | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const layoutFrame = (): Promise<HTMLIFrameElement> => frameReady ??= new Promise((resolve, reject) => {
    rejectFrame = reject;
    frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.style.cssText = "position:fixed;left:-20000px;top:0;width:1200px;height:1000px;opacity:0;pointer-events:none;border:0";
    frameTimer = setTimeout(() => reject(new Error("Offline diagram layout did not load")), 15000);
    frame.addEventListener("load", () => { clearTimeout(frameTimer); resolve(frame!); }, { once: true });
    frame.addEventListener("error", () => { clearTimeout(frameTimer); reject(new Error("Offline diagram layout failed")); }, { once: true });
    frame.src = new URL("/runtime/mermaid-frame.html", document.baseURI).href;
    document.body.append(frame);
  });
  return {
    renderMarkdown: (source, preserveLineBreaks = false) => markdown.render(source, { preserveLineBreaks }),
    highlightCode,
    renderMath: (source, display) => katex.renderToString(source, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: false,
      strict: "ignore",
      trust: false
    }),
    renderMermaid: (source, id, theme) => {
      const task = mermaidQueue.then(async () => {
        if (disposed) throw new Error("Diagram layout disposed");
        const owner = await layoutFrame();
        const runtime = owner.contentWindow as (Window & { cloudigRenderMermaid?: (source: string, id: string, theme: RendererTheme) => Promise<string> }) | null;
        if (!runtime?.cloudigRenderMermaid) throw new Error("Offline diagram layout is unavailable");
        return runtime.cloudigRenderMermaid(source, id, theme);
      });
      mermaidQueue = task.catch(() => undefined);
      return task;
    },
    dispose: () => { disposed = true; clearTimeout(frameTimer); rejectFrame?.(new Error("Diagram layout disposed")); frame?.remove(); frame = undefined; frameReady = undefined; }
  };
}
