export const MARKDOWN_SELECTION_LIMITS = Object.freeze({ chunk: 400, webBytes: 24000 });
/** Whole current branch or explicit messages; process visibility never decides export content. */
export function chooseMarkdown({ host, underlay, language, loadMessages }) {
  return new Promise(resolve => {
    const en = language === "en", previousFocus = document.activeElement, previousInert = underlay.inert; underlay.inert = true;
    const layer = document.createElement("div"); layer.className = "cloudig-dialog-layer";
    const dialog = document.createElement("section"); dialog.className = "cloudig-dialog cloudig-markdown-dialog"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("h2"); title.textContent = en ? "Copy / export Markdown" : "复制 / 导出 Markdown"; dialog.setAttribute("aria-label", title.textContent);
    const scope = document.createElement("fieldset"), content = document.createElement("fieldset"), list = document.createElement("div"), status = document.createElement("p"), more = button(en ? "More messages" : "更多发言", "outline");
    list.className = "cloudig-markdown-messages"; list.dataset.scrollRegion = ""; list.hidden = true; more.hidden = true; status.setAttribute("role", "status");
    let range = "all", mode = "body", snapshot, offset = 0, total = 0, ordinal = 0, closed = false, selected = new Set();
    scope.append(radio("range", "all", en ? "Whole displayed branch" : "全篇 · 当前显示分支", true, () => { range = "all"; list.hidden = true; more.hidden = true; status.textContent = ""; }), radio("range", "partial", en ? "Selected messages" : "部分发言", false, () => { range = "partial"; list.hidden = false; void load(false); }));
    content.append(radio("content", "body", en ? "Body only" : "仅正文", true, () => changeMode("body")), radio("content", "with_process", en ? "Include thoughts, tools, sources and other process" : "包含思考、工具、来源等过程", false, () => changeMode("with_process")));
    const footer = document.createElement("footer"), cancel = button(en ? "Cancel" : "取消", "outline"), copy = button(en ? "Copy Markdown" : "复制 Markdown"), save = button(en ? "Export file" : "导出文件"); footer.append(cancel, copy, save);
    dialog.append(title, scope, content, status, list, more, footer); layer.append(dialog); host.append(layer);
    function button(text, kind = "filled") { const node = document.createElement("button"); node.type = "button"; node.className = `cloudig-button cloudig-button-${kind}`; node.textContent = text; return node; }
    function radio(name, value, text, checked, change) { const label = document.createElement("label"), input = document.createElement("input"), span = document.createElement("span"); label.className = "cloudig-choice"; input.type = "radio"; input.name = `markdown-${name}`; input.value = value; input.checked = checked; span.textContent = text; input.addEventListener("change", change); label.append(input, span); return label; }
    function count() { if (range === "partial") status.textContent = en ? `${selected.size} selected · ${total} messages` : `已选 ${selected.size} 条 · 共 ${total} 条发言`; }
    function changeMode(value) { mode = value; selected.clear(); if (range === "partial") void load(false); }
    async function load(next) {
      const current = ++ordinal; more.disabled = true;
      if (!next) { list.replaceChildren(); selected.clear(); offset = 0; snapshot = undefined; }
      status.textContent = en ? "Loading messages…" : "正在读取发言列表…";
      try {
        const result = await loadMessages(next ? { snapshot, offset, limit: 200 } : { content_mode: mode, offset: 0, limit: 200 });
        if (closed || current !== ordinal || range !== "partial") return;
        snapshot = result.snapshot; total = result.total; offset += result.items.length;
        for (const item of result.items) {
          const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span"); label.className = "cloudig-choice cloudig-checkbox"; input.type = "checkbox"; input.value = item.id;
          const party = item.role === "user" ? (en ? "User" : "用户") : item.role === "assistant" ? (en ? "AI" : "智能") : (en ? "Process" : "过程");
          const timestamp = typeof item.timestamp === "string" ? item.timestamp.replace("T", " ").replace(/\.\d+(?=Z$|[+-]\d\d:\d\d$)/u, "").replace(/Z$/u, " UTC") : "";
          const copy = document.createElement("span"), meta = document.createElement("small"), summary = document.createElement("span");
          copy.className = "cloudig-markdown-message-copy"; meta.textContent = `${party}${timestamp ? ` · ${timestamp}` : ""}`;
          summary.textContent = item.summary || (en ? "Attachment / process" : "附件 / 过程"); copy.append(meta, summary); text.append(copy);
          input.addEventListener("change", () => { if (input.checked) selected.add(item.id); else selected.delete(item.id); count(); }); label.append(input, text); list.append(label);
        }
        more.hidden = offset >= total; count();
      } catch (error) { if (!closed && current === ordinal) status.textContent = error.message || (en ? "Could not load messages." : "未能读取发言列表。"); }
      finally { if (!closed && current === ordinal) more.disabled = false; }
    }
    const finish = action => {
      if (action && range === "partial" && !selected.size) { status.textContent = en ? "Select at least one message." : "请至少选择一条发言。"; return; }
      closed = true; ordinal++; layer.remove(); underlay.inert = previousInert; previousFocus?.focus?.();
      resolve(action ? { action, content_mode: mode, ...(range === "partial" ? { messages: [...selected] } : {}) } : null);
    };
    cancel.addEventListener("click", () => finish(null)); copy.addEventListener("click", () => finish("copy")); save.addEventListener("click", () => finish("export")); more.addEventListener("click", () => { void load(true); });
    layer.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); }
      if (event.key !== "Tab") return; const controls = [...dialog.querySelectorAll("input, button:not(:disabled)")].filter(node => !node.hidden && !node.closest("[hidden]"));
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }); cancel.focus();
  });
}
