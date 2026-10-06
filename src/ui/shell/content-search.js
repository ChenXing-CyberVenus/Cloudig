import { archiveScopeQuery, archiveScopeLabel, toggleArchiveScope } from "./archive-scope.js";
import { appendHighlightedText, highlightSearchPreview } from "./search-highlight.js";
import { searchIcon } from "./search-icons.js";
export const CONTENT_SEARCH_PAGE_SIZE = 30; // matches FULL_TEXT_LIMITS.page; bounded even for 4096-code-point titles

/** Only draft scope and result UI live here. Search and rich-message rendering use the real Engine. */
export function openContentSearch({ host, underlay, language, query, selection, directories, platforms, selectedPlatforms, search, preview, open, onClose }) {
  const en = language === "en", previousFocus = document.activeElement, previousInert = underlay.inert;
  underlay.inert = true;
  const layer = document.createElement("div"); layer.className = "cloudig-dialog-layer cloudig-search-layer";
  const dialog = document.createElement("section"); dialog.className = "cloudig-dialog cloudig-content-search";
  dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", en ? "Search conversations" : "搜索对话内容");
  const heading = document.createElement("header"), title = document.createElement("h2"), close = button(en ? "Close" : "关闭", "outline");
  title.append(searchIcon("search"), document.createTextNode(en ? "Search conversations" : "搜索对话内容"));
  close.dataset.searchClose = ""; close.className = "cloudig-search-close"; close.setAttribute("aria-label", en ? "Close search" : "关闭搜索"); close.title = en ? "Close search" : "关闭搜索"; close.replaceChildren(searchIcon("close")); heading.append(title, close);
  const form = document.createElement("form"), field = document.createElement("label"), input = document.createElement("input"), submit = button(en ? "Search content" : "搜内容");
  form.className = "cloudig-content-search-form"; field.className = "cloudig-dialog-field"; input.type = "search"; input.value = query; input.maxLength = 256; input.dataset.contentQuery = ""; input.setAttribute("aria-label", en ? "Search text" : "搜索文字");
  input.placeholder = en ? "Find words in your conversations" : "输入你想找的文字";
  field.append(searchIcon("search"), input); submit.prepend(searchIcon("search")); submit.type = "submit"; form.append(field, submit);
  let scope = new Set(selection), chosenPlatforms = new Set(selectedPlatforms ?? platforms.map(p => p.value));
  const categories = new Set(["user", "assistant"]), filters = document.createElement("div"); filters.className = "cloudig-content-search-filters";
  const scopeDetails = document.createElement("details"), scopeSummary = document.createElement("summary"), scopeChoices = document.createElement("div");
  scopeChoices.className = "cloudig-content-scope-choices"; scopeChoices.dataset.scrollRegion = "";
  const directoryItems = [{ value: "all", label: en ? "All unarchived directories" : "全部未归档目录" }, ...directories.map(d => ({ value: d.capability, label: d.name })), { value: "archived", label: en ? "Archived conversations" : "归档区" }];
  const syncScope = () => { scopeSummary.textContent = `${en ? "Directories" : "目录"} · ${archiveScopeLabel(scope, directories, language)}`; for (const control of scopeChoices.querySelectorAll("input")) control.checked = scope.has(control.value); };
  for (const item of directoryItems) scopeChoices.append(choice(item.value, item.label, scope.has(item.value), checked => { scope = toggleArchiveScope(scope, item.value, checked); syncScope(); }, item.value === "all" ? "radio" : "checkbox"));
  scopeDetails.append(scopeSummary, scopeChoices); syncScope();
  const platformDetails = document.createElement("details"), platformSummary = document.createElement("summary"), platformChoices = document.createElement("div");
  platformChoices.className = "cloudig-content-platform-choices"; platformChoices.dataset.scrollRegion = "";
  const syncPlatforms = () => { platformSummary.textContent = `${en ? "Platforms" : "平台"} · ${chosenPlatforms.size}/${platforms.length}`; };
  for (const item of platforms) platformChoices.append(choice(item.value, item.label, chosenPlatforms.has(item.value), checked => { if (checked) chosenPlatforms.add(item.value); else chosenPlatforms.delete(item.value); syncPlatforms(); }));
  platformDetails.append(platformSummary, platformChoices); syncPlatforms();
  for (const details of [scopeDetails, platformDetails]) details.addEventListener("toggle", () => { if (details.open) for (const other of [scopeDetails, platformDetails]) if (other !== details) other.open = false; });
  const categoryGroup = document.createElement("fieldset"), legend = document.createElement("legend"); categoryGroup.className = "cloudig-content-categories"; legend.textContent = en ? "Search in" : "检索内容"; categoryGroup.append(legend);
  for (const [value, label] of [["user", en ? "User" : "用户"], ["assistant", en ? "AI · final output" : "智能 · 最终输出"], ["process", en ? "Process · thoughts, tools, sources" : "过程 · 思考、工具、来源等"]]) categoryGroup.append(choice(value, label, categories.has(value), checked => { if (checked) categories.add(value); else categories.delete(value); }));
  filters.append(scopeDetails, platformDetails, categoryGroup);
  const status = document.createElement("p"), progress = document.createElement("progress"), cancel = button(en ? "Cancel search" : "取消搜索", "outline"), toolbar = document.createElement("div");
  toolbar.className = "cloudig-content-search-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); progress.hidden = true; cancel.hidden = true; progress.max = 1; toolbar.append(status, progress, cancel);
  const results = document.createElement("div"), more = button(en ? "More results" : "更多结果", "outline"); results.className = "cloudig-content-search-results"; results.dataset.scrollRegion = ""; results.dataset.searchResults = ""; more.hidden = true;
  dialog.append(heading, form, filters, toolbar, results, more); layer.append(dialog); host.append(layer);
  let closed = false, ordinal = 0, operation, snapshot, resultQuery = query.trim(), offset = 0, total = 0, previewAbort, previewRelease, previewNode;
  function button(text, kind = "filled") { const b = document.createElement("button"); b.type = "button"; b.className = `cloudig-button cloudig-button-${kind}`; b.textContent = text; return b; }
  function choice(value, text, checked, changed, type = "checkbox") { const label = document.createElement("label"), control = document.createElement("input"), copy = document.createElement("span"); label.className = `cloudig-choice${type === "checkbox" ? " cloudig-checkbox" : ""}`; control.type = type; if (type === "radio") control.name = "content-search-directory"; control.value = value; control.checked = checked; copy.textContent = text; control.addEventListener("change", () => changed(control.checked)); label.append(control, copy); return label; }
  const releasePreview = () => { previewAbort?.abort(); previewAbort = undefined; previewRelease?.(); previewRelease = undefined; previewNode?.remove(); previewNode = undefined; for (const toggle of results.querySelectorAll("[aria-expanded]")) toggle.setAttribute("aria-expanded", "false"); };
  const finish = () => { if (closed) return; closed = true; ordinal++; operation?.cancel(); releasePreview(); layer.remove(); underlay.inert = previousInert; previousFocus?.focus?.(); onClose?.(); };
  const setBusy = busy => { progress.hidden = !busy; cancel.hidden = !busy; dialog.setAttribute("aria-busy", String(busy)); more.disabled = busy; };
  const report = error => { status.textContent = error?.message || (en ? "Search could not be completed. Please try again." : "搜索未完成，请重试。"); };
  const append = items => {
    for (const hit of items) {
      const item = document.createElement("article"), toggle = document.createElement("button"), name = document.createElement("strong"), snippet = document.createElement("span"), read = button(en ? "Open conversation" : "打开日志", "outline");
      const hitQuery = resultQuery, meta = document.createElement("small"), cue = document.createElement("small");
      meta.className = "cloudig-search-result-meta"; cue.className = "cloudig-search-result-cue";
      const categoryLabels = { user: en ? "User" : "用户", assistant: en ? "AI · final output" : "智能 · 最终输出", process: en ? "Process" : "过程" };
      meta.textContent = [platforms.find(platform => platform.value === hit.platform)?.label, ...(hit.categories ?? []).map(value => categoryLabels[value]).filter(Boolean)].filter(Boolean).join(" · ");
      cue.textContent = en ? "Preview message" : "展开命中发言";
      item.className = "cloudig-search-result"; toggle.type = "button"; toggle.className = "cloudig-search-result-toggle"; toggle.setAttribute("aria-expanded", "false");
      appendHighlightedText(name, hit.title, hitQuery); appendHighlightedText(snippet, hit.excerpt, hitQuery); toggle.append(meta, name, snippet, cue); read.append(searchIcon("open")); item.append(toggle, read);
      read.addEventListener("click", () => { finish(); Promise.resolve(open(hit)).catch(report); });
      toggle.addEventListener("click", async () => {
        const closing = toggle.getAttribute("aria-expanded") === "true"; releasePreview(); if (closing) return;
        toggle.setAttribute("aria-expanded", "true"); previewNode = document.createElement("div"); previewNode.className = "cloudig-search-message-preview"; item.append(previewNode);
        const node = previewNode, abort = new AbortController(); previewAbort = abort; node.dataset.loading = "true"; node.textContent = en ? "Opening message…" : "正在打开这一条发言…";
        try { const release = await preview(hit, node, abort.signal); if (closed || abort.signal.aborted) release?.(); else { const clearHighlight = highlightSearchPreview(node, hitQuery); previewRelease = () => { clearHighlight(); release?.(); }; delete node.dataset.loading; } }
        catch (error) { if (!abort.signal.aborted && !closed) { delete node.dataset.loading; node.textContent = error.message || (en ? "Message unavailable; search again." : "这条发言已变化，请重新搜索。"); } }
      });
      results.append(item);
    }
  };
  const run = async (nextPage = false) => {
    const current = ++ordinal; operation?.cancel(); releasePreview();
    if (!nextPage) { results.replaceChildren(); offset = 0; snapshot = undefined; total = 0; more.hidden = true; }
    if (!input.value.trim()) { setBusy(false); status.textContent = en ? "Enter search text." : "请输入搜索文字。"; return; }
    if (!nextPage) resultQuery = input.value.trim();
    scopeDetails.open = false; platformDetails.open = false;
    setBusy(true); progress.removeAttribute("value"); status.textContent = en ? "Searching…" : "正在搜索…";
    const payload = nextPage ? { snapshot, offset, limit: CONTENT_SEARCH_PAGE_SIZE } : { query: input.value.trim(), scope: { ...archiveScopeQuery(scope), ...(chosenPlatforms.size === platforms.length ? {} : { platforms: [...chosenPlatforms] }) }, categories: [...categories], offset: 0, limit: CONTENT_SEARCH_PAGE_SIZE };
    try {
      operation = search(payload, event => { if (closed || current !== ordinal) return; progress.max = Math.max(1, event.files?.total ?? 1); progress.value = event.files?.completed ?? 0; status.textContent = en ? `Searched ${event.files?.completed ?? 0}/${event.files?.total ?? 0} files · ${event.matches ?? 0} matches` : `已搜索 ${event.files?.completed ?? 0}/${event.files?.total ?? 0} 个文件 · ${event.matches ?? 0} 条命中`; });
      const model = await operation.promise; if (closed || current !== ordinal) return;
      snapshot = model.snapshot; offset += model.items.length; total = model.total; append(model.items); more.hidden = offset >= total;
      const matches = model.matched_messages ?? total, conversations = model.conversations ?? 0;
      status.textContent = en ? `${matches} matching ${matches === 1 ? "message" : "messages"} in ${conversations} ${conversations === 1 ? "conversation" : "conversations"}` : `${conversations} 篇对话 · ${matches} 条命中`;
      if (model.truncated) status.textContent += en ? ` · Showing the first ${total}; narrow the scope or search text.` : ` · 仅显示前 ${total} 条，请缩小范围或细化关键词。`;
      if (model.skipped_files) status.textContent += en ? ` · ${model.skipped_files} changed or unreadable files skipped; refresh and retry.` : ` · ${model.skipped_files} 个文件已变化或无法读取，请刷新后重试。`;
    } catch (error) { if (!closed && current === ordinal) report(error); }
    finally { if (!closed && current === ordinal) { setBusy(false); operation = undefined; } }
  };
  form.addEventListener("submit", event => { event.preventDefault(); void run(); }); more.addEventListener("click", () => { void run(true); }); close.addEventListener("click", finish);
  cancel.addEventListener("click", () => { ordinal++; operation?.cancel(); operation = undefined; setBusy(false); status.textContent = en ? "Search cancelled." : "已取消搜索。"; });
  layer.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); return; }
    if (event.key !== "Tab") return;
    const choices = [...dialog.querySelectorAll("button:not(:disabled), input, summary, a[href], [tabindex]:not([tabindex='-1'])")].filter(node => !node.hidden && !node.closest("[hidden]") && (!node.closest("details") || node.tagName === "SUMMARY" || node.closest("details").open));
    const first = choices[0], last = choices.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  input.focus(); void run();
  return { close: finish };
}
