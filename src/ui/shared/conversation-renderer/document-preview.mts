import mermaid from "mermaid";

// Runs in the same isolated origin as every saved work. Only fenced Mermaid
// blocks are diagrams; original code stays available beside the rendering.
export async function render(): Promise<void> {
  const dark = document.documentElement.dataset["cloudigTheme"] === "star-night";
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
  let ordinal = 0;
  for (const code of document.querySelectorAll("pre > code.language-mermaid")) {
    const pre = code.parentElement!, source = code.textContent ?? "";
    const figure = document.createElement("figure"), image = document.createElement("div"), toggle = document.createElement("button");
    figure.className = "saved-diagram"; toggle.type = "button";
    const english = document.documentElement.lang === "en";
    toggle.textContent = english ? "Source" : "源码";
    pre.replaceWith(figure); figure.append(toggle, image, pre);
    try {
      const result = await mermaid.render(`saved-diagram-${ordinal++}`, source);
      image.innerHTML = result.svg; pre.hidden = true;
      toggle.addEventListener("click", () => { pre.hidden = !pre.hidden; image.hidden = !pre.hidden; toggle.textContent = pre.hidden ? english ? "Source" : "源码" : english ? "Diagram" : "图表"; });
    } catch { image.remove(); toggle.remove(); }
  }
}
