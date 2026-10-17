import { searchIcon } from "./search-icons.js";
/** The same two explicit search actions in Reader and Archiver. Typing never narrows the list. */
export function bindSearchEntry({ input, form, clear, language, onTitle, onContent, signal }) {
  const window = input.ownerDocument.defaultView ?? document.defaultView;
  const actions = document.createElement("div");
  actions.className = "cloudig-search-actions";
  actions.hidden = true;
  const title = document.createElement("button"), content = document.createElement("button");
  for (const button of [title, content]) { button.type = "button"; button.className = "cloudig-button cloudig-button-filled"; }
  title.className = "cloudig-button cloudig-button-outline";
  title.dataset.searchTitle = ""; content.dataset.searchContent = "";
  actions.append(title, content); document.body.append(actions);
  const hide = () => { actions.hidden = true; };
  const setLabel = (button, icon, text) => {
    const group = document.createElement("span"), label = document.createElement("span");
    group.className = "cloudig-search-action-content"; label.className = "cloudig-search-action-label"; label.textContent = text;
    group.append(searchIcon(icon, true), label); button.replaceChildren(group);
  };
  const refresh = () => {
    const en = language() === "en";
    setLabel(title, "title", en ? "Search titles" : "搜标题");
    setLabel(content, "search", en ? "Search content" : "搜内容");
    clear.hidden = !input.value.trim();
    actions.hidden = !input.value.trim() || input.disabled;
    if (actions.hidden) return;
    const rect = input.getBoundingClientRect();
    actions.style.width = `${Math.min(innerWidth - 16, Math.max(rect.width, en ? 372 : 304))}px`;
    actions.style.top = `${rect.bottom + 6}px`;
    actions.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - actions.offsetWidth - 8))}px`;
  };
  const submit = event => { event.preventDefault(); hide(); onTitle(input.value.trim()); };
  input.addEventListener("input", refresh, { signal }); input.addEventListener("focus", refresh, { signal }); input.addEventListener("click", refresh, { signal });
  if (form) form.addEventListener("submit", submit, { signal });
  else input.addEventListener("keydown", event => { if (event.key === "Enter") submit(event); }, { signal });
  title.addEventListener("click", submit, { signal });
  content.addEventListener("click", () => { hide(); onContent(input.value.trim()); }, { signal });
  clear.addEventListener("click", () => { input.value = ""; clear.hidden = true; hide(); onTitle(""); input.focus(); }, { signal });
  actions.addEventListener("pointerdown", event => event.preventDefault(), { signal });
  document.addEventListener("pointerdown", event => { if (event.target !== input && !actions.contains(event.target)) hide(); }, { signal });
  input.addEventListener("keydown", event => { if (event.key === "Escape") hide(); }, { signal });
  window.addEventListener("resize", () => { if (!actions.hidden) refresh(); }, { signal });
  window.addEventListener("scroll", event => {
    // Long input text scrolls inside the input after typing. That is not a
    // scrolled page/rail and must not dismiss its freshly opened actions.
    if (event.target !== input && !(event.target instanceof window.Node && actions.contains(event.target))) hide();
  }, { capture: true, passive: true, signal });
  signal.addEventListener("abort", () => actions.remove(), { once: true });
  return { hide };
}
