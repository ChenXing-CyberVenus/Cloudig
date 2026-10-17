import mermaid from "mermaid";

// A private layout document gives the bundled renderer its own CSS metrics.
// Shell CSS/CSP cannot change label measurements; returned SVG is displayed as
// an inert image. No captured HTML, script, network or application bridge runs.
const target = window as Window & { cloudigRenderMermaid?: (source: string, id: string, theme: string) => Promise<string> };
target.cloudigRenderMermaid = async (source, id, theme) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "star-night" ? "dark" : "default", fontFamily: "Segoe UI, Noto Sans CJK SC, sans-serif", suppressErrorRendering: true });
  return (await mermaid.render(id, source)).svg;
};
