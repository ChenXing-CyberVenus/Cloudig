// Session-only directory selection shared by list/search. "all" means active
// directories. "all" excludes every checkbox, including Archives; named
// directories and Archives may still be selected together.
export function archiveScopeQuery(selection) {
  const selected = new Set(selection);
  const directories = [...selected].filter(value => value !== "all" && value !== "archived");
  return {
    locations: [...(selected.has("all") || directories.length ? ["conversations"] : []), ...(selected.has("archived") ? ["archives"] : [])],
    ...(selected.has("all") || !directories.length ? {} : { directories })
  };
}

export function archiveScopeLabel(selection, directories, language) {
  const selected = new Set(selection), en = language === "en";
  if (!selected.size) return en ? "No directories selected" : "未选择目录";
  if (selected.has("all")) return selected.has("archived") ? (en ? "All + Archived" : "全部目录与归档区") : (en ? "All active directories" : "全部未归档目录");
  const named = directories.filter(row => selected.has(row.capability));
  if (named.length === 1 && !selected.has("archived")) return named[0].name;
  if (!named.length && selected.has("archived")) return en ? "Archived" : "归档区";
  const count = named.length + Number(selected.has("archived"));
  return en ? `${count} locations selected` : `已选 ${count} 个目录`;
}

export function toggleArchiveScope(selection, value, checked) {
  const next = new Set(selection);
  if (checked) {
    if (value === "all") {
      next.clear();
    } else next.delete("all");
    next.add(value);
  } else next.delete(value);
  return next;
}
