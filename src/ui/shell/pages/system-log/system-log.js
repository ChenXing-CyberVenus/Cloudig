function errorText(path, error, labels) {
  const facts = [labels.sources?.[error.source] ?? error.source, error.code, error.stage].filter(Boolean).join(" · ");
  return [path, facts, error.message, error.ref ? `${labels.reference}: ${error.ref}` : ""].filter(Boolean).join("\n");
}

function groupText(item, labels) {
  return item.errors.map((error) => errorText(item.path, error, labels)).join("\n\n");
}

function button(label, action, className) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.dataset.systemLogAction = action;
  node.textContent = label;
  return node;
}

function errorRow(item, error, labels, copyText, setStatus) {
  const row = document.createElement("article");
  row.className = "system-log-error-row";
  const heading = document.createElement("div");
  heading.className = "system-log-error-heading";
  const facts = document.createElement("span");
  facts.textContent = [labels.sources?.[error.source] ?? error.source, error.code, error.stage].filter(Boolean).join(" · ");
  const copy = button(labels.copy, "copy-error", "system-log-copy-button");
  copy.addEventListener("click", async () => {
    try { await copyText(errorText(item.path, error, labels)); setStatus(labels.copied); }
    catch { setStatus(labels.copyFailed); }
  });
  heading.append(facts, copy);
  const message = document.createElement("p");
  message.textContent = error.message;
  row.append(heading, message);
  if (error.ref) {
    const reference = document.createElement("small");
    reference.textContent = `${labels.reference}: ${error.ref}`;
    row.append(reference);
  }
  return row;
}

export function visualSystemLogFixture() {
  return {
    offset: 0,
    limit: 100,
    total: 2,
    items: [
      {
        capability: `sl_${"a".repeat(43)}`,
        path: "Inbox/2026-08-25-奥思·情炽电波-Gemini-3.5-Flash.html",
        recorded_at: "2026-09-01T12:30:00.000Z",
        errors: [{ source: "exporter", code: "capture-note", stage: "capture", message: "原始公式排版存在可恢复差异；原文已经保留。", ref: "message:18" }]
      },
      {
        capability: `sl_${"b".repeat(43)}`,
        path: "Inbox/example.html",
        recorded_at: "2026-09-01T12:31:00.000Z",
        errors: [{ source: "parser", code: "unsupported-source", stage: "probe", message: "Parser does not support this source format." }]
      }
    ]
  };
}

export function mountSystemLog(options) {
  const fragment = options.template.content.cloneNode(true);
  const element = fragment.querySelector("[data-system-log-layer]");
  const dialog = element.querySelector("[data-system-log-dialog]");
  const list = element.querySelector("[data-system-log-list]");
  const status = element.querySelector("[data-system-log-status]");
  const title = element.querySelector("[data-system-log-title]");
  const close = element.querySelector("[data-system-log-close]");
  const refresh = element.querySelector("[data-system-log-refresh]");
  const clear = element.querySelector("[data-system-log-clear]");
  const labels = options.labels;
  const items = [...options.model.items];
  let total = options.model.total;
  let loading = false;
  let disposed = false;
  let mutating = false;
  let confirmation;
  let revision = 0;

  title.textContent = labels.title;
  close.textContent = labels.close;
  refresh.textContent = labels.refresh;
  clear.textContent = labels.clear;
  const setStatus = (value) => { status.textContent = value; status.hidden = !value; };

  const render = () => {
    clear.disabled = total === 0 || mutating;
    refresh.disabled = mutating;
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "system-log-empty";
      empty.textContent = labels.empty;
      list.append(empty);
      return;
    }
    for (const item of items) {
      const card = document.createElement("section");
      card.className = "system-log-file-card";
      const header = document.createElement("header");
      const path = document.createElement("h2");
      path.textContent = item.path;
      path.title = item.path;
      const actions = document.createElement("div");
      const reveal = button(labels.reveal, "reveal", "cloudig-button cloudig-button-outline");
      const copyGroup = button(labels.copyFile, "copy-file", "cloudig-button cloudig-button-filled");
      const remove = button(labels.remove, "delete-file", "cloudig-button cloudig-button-outline");
      remove.disabled = mutating;
      remove.addEventListener("click", () => mutate(() => options.onDelete(item.capability)));
      reveal.addEventListener("click", async () => {
        reveal.disabled = true;
        try { await options.onReveal(item.capability); setStatus(labels.located); }
        catch (error) { setStatus(error?.code === "CLOUDIG_SYSTEM_LOG_FILE_MISSING" ? labels.missing : labels.revealFailed); }
        finally { reveal.disabled = false; }
      });
      copyGroup.addEventListener("click", async () => {
        try { await options.copyText(groupText(item, labels)); setStatus(labels.copied); }
        catch { setStatus(labels.copyFailed); }
      });
      actions.append(reveal, copyGroup, remove);
      header.append(path, actions);
      const time = document.createElement("time");
      time.dateTime = item.recorded_at;
      time.textContent = item.recorded_at.replace("T", " ").replace(/\.000Z$/u, "Z");
      const errors = document.createElement("div");
      errors.className = "system-log-errors";
      for (const error of item.errors) errors.append(errorRow(item, error, labels, options.copyText, setStatus));
      card.append(header, time, errors);
      list.append(card);
    }
  };

  const reload = async () => {
    const requested = ++revision;
    const next = await options.onRefresh();
    if (disposed || requested !== revision) return;
    items.splice(0, items.length, ...next.items);
    total = next.total;
    list.scrollTop = 0;
    render();
  };
  const mutate = async (action) => {
    if (mutating) return;
    revision += 1; mutating = true; render();
    try { await action(); await reload(); if (!disposed) setStatus(labels.removed); }
    catch { if (!disposed) setStatus(labels.removeFailed); }
    finally { mutating = false; if (!disposed) render(); }
  };
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    try { await reload(); setStatus(""); } catch { setStatus(labels.readFailed); }
    finally { refresh.disabled = false; }
  });
  const closeConfirmation = () => { confirmation?.remove(); confirmation = undefined; clear.focus(); };
  clear.addEventListener("click", () => {
    if (confirmation || mutating) return;
    confirmation = document.createElement("section");
    confirmation.className = "system-log-confirmation";
    const message = document.createElement("p"); message.textContent = labels.clearConfirm;
    const confirm = button(labels.confirm, "confirm-clear", "cloudig-button cloudig-button-filled");
    const cancel = button(labels.cancel, "cancel-clear", "cloudig-button cloudig-button-outline");
    confirm.addEventListener("click", () => { closeConfirmation(); void mutate(() => options.onClear()); });
    cancel.addEventListener("click", closeConfirmation);
    confirmation.append(message, confirm, cancel); dialog.append(confirmation); cancel.focus();
  });

  const loadMore = async () => {
    if (loading || disposed || items.length >= total || !options.onLoadMore) return;
    loading = true;
    const requested = revision;
    try {
      const next = await options.onLoadMore(items.length, Math.min(100, total - items.length));
      if (disposed || requested !== revision) return;
      items.push(...next.items);
      total = next.total;
      render();
    } catch { setStatus(labels.readFailed); }
    finally { loading = false; }
  };
  const onScroll = () => {
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 240) loadMore();
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") { if (confirmation) closeConfirmation(); else options.onClose(); }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not(:disabled)")];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  list.addEventListener("scroll", onScroll, { passive: true });
  close.addEventListener("click", options.onClose);
  element.addEventListener("keydown", onKeydown);
  render();

  return {
    element,
    focus: () => close.focus(),
    cleanup: () => {
      disposed = true;
      list.removeEventListener("scroll", onScroll);
      element.removeEventListener("keydown", onKeydown);
      element.remove();
    }
  };
}
