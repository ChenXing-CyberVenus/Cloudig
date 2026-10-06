export function updateOperationProgress(region, event, filenames = []) {
  region.hidden = false;
  region.querySelector("[data-progress-stage]").textContent = event.phase ?? "parse";
  const index = event.file?.index;
  const filename = Number.isInteger(index) ? filenames[index - 1] ?? "" : "";
  const file = region.querySelector("[data-progress-file]");
  file.textContent = filename; file.title = filename;
  const amount = event.bytes ?? event.items ?? event.file;
  const bar = region.querySelector("[data-progress-bar]");
  if (Number.isFinite(amount?.total) && amount.total > 0) { bar.max = amount.total; bar.value = Math.max(0, Math.min(amount.completed ?? 0, amount.total)); }
  else bar.removeAttribute("value");
  region.querySelector("[data-progress-counter]").textContent = Number.isFinite(amount?.total) ? `${amount.completed ?? 0} / ${amount.total}` : "";
}

export async function runArchiveDeletion({ host, rows, language, recycle, refresh }) {
  const document = host.ownerDocument;
  const view = document.defaultView;
  const region = document.createElement("section");
  region.className = "cloudig-operation-progress cloudig-delete-progress";
  region.dataset.deleteProgress = "";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  region.innerHTML = '<div><strong data-progress-stage></strong><span data-progress-file></span></div><progress data-progress-bar max="1" value="0"></progress><span data-progress-counter></span>';
  const filenames = rows.map(row => row.filename ?? row.title ?? "");
  let completed = 0;
  const update = index => updateOperationProgress(region, { phase: language === "en" ? "Moving to Recycle Bin" : "正在移入回收站", file: { index: index + 1 }, items: { completed, total: rows.length } }, filenames);
  host.append(region); update(0);
  try {
    // Let the first progress state paint before the native operation begins.
    await new Promise(resolve => {
      const timeout = view.setTimeout(resolve, 100);
      view.requestAnimationFrame?.(() => view.requestAnimationFrame(() => { view.clearTimeout(timeout); resolve(); }));
    });
    for (let index = 0; index < rows.length; index++) {
      update(index);
      await recycle(rows[index]);
      completed += 1;
      update(index);
    }
    await refresh?.();
    return completed;
  } finally { region.remove(); }
}
