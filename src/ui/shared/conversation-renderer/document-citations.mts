/** Enhance inert inline document groups. Full member text stays in the HTML
 * for export and noninteractive readers; no captured script is executed. */
export function hydrateDocumentCitations(root: HTMLElement, signal: AbortSignal): void {
  for (const group of root.querySelectorAll<HTMLElement>(".cloudig-document-citation,.gemini-document-citation")) {
    const members = group.querySelector<HTMLElement>(":scope > .cloudig-document-sources,:scope > .gemini-document-sources");
    const label = group.firstElementChild;
    if (!members || !label || label === members) continue;
    group.classList.add("cloudig-document-citation"); members.classList.add("cloudig-document-sources"); members.hidden = true;
    const button = root.ownerDocument.createElement("button"); button.type = "button"; button.className = "cloudig-document-citation-toggle";
    button.textContent = label.textContent; button.setAttribute("aria-expanded", "false"); label.replaceWith(button);
    button.addEventListener("click", () => { members.hidden = !members.hidden; button.setAttribute("aria-expanded", String(!members.hidden)); }, { signal });
  }
}
