export function parserReleaseMappings(history) {
  if (history?.schema !== "cloudig/parser-history/1.0.0" || !Array.isArray(history.releases)) throw new TypeError("Invalid Parser history");
  const adapters = {};
  return history.releases.map(release => {
    Object.assign(adapters, release.adapters);
    return { ...release, changed: Object.keys(release.adapters), adapters: { ...adapters } };
  });
}

export function mountParserHistory(root, language, signal) {
  const english = language === "en";
  root.querySelector("summary").textContent = english ? "Parser versions and adapter history" : "Parser版本与适配器沿革";
  const body = root.querySelector("[data-parser-history-body]");
  let loaded = false, loading = false;
  root.addEventListener("toggle", async () => {
    if (!root.open || loaded || loading) return;
    loading = true;
    body.textContent = english ? "Loading bundled version record…" : "读取程序内版本记录…";
    try {
      const response = await fetch("/shared/parser-history.json", { signal });
      if (!response.ok) throw new Error("Parser history resource missing");
      const history = await response.json();
      if (signal.aborted) return;
      body.replaceChildren();
      const note = document.createElement("p");
      note.textContent = english ? "Reparse only when the adapter for this source changes; a total Parser version bump alone does not require it." : "只根据相应来源的适配器判断是否需要重新解析；总Parser升版不等于全部重解析。";
      body.append(note);
      for (const release of parserReleaseMappings(history).reverse()) {
        const item = document.createElement("details"), heading = document.createElement("summary"), mapping = document.createElement("dl");
        item.dataset.parserRelease = release.version;
        heading.textContent = `Parser ${release.version} · ${release.date}${release.version === history.current_parser ? (english ? " · Current" : " · 当前") : ""}`;
        item.append(heading);
        for (const [id, version] of Object.entries(release.adapters)) {
          const name = document.createElement("dt"), value = document.createElement("dd");
          name.textContent = id; value.textContent = version;
          if (release.changed.includes(id)) value.dataset.changed = "true";
          mapping.append(name, value);
        }
        item.append(mapping); body.append(item);
      }
      loaded = true;
    } catch {
      if (!signal.aborted) body.textContent = english ? "The bundled version record could not be read. Reopen this section to retry." : "未能读取程序内的版本记录，请重新展开此栏重试。";
    } finally { loading = false; }
  }, { signal });
}
