/** One directory picker/creator for parse confirmations and both settings panels. */
export function mountParseTarget({ language, directories, initialDirectory, onCreate, errorMessage, onBusy, mode = "run", selectElement, id = "cloudig-parse-directory" }) {
  const english = language === "en";
  const element = document.createElement("section");
  element.className = "cloudig-parse-target";
  const label = document.createElement("div");
  label.className = "cloudig-dialog-field";
  const caption = document.createElement("label");
  caption.textContent = english ? "Output directory" : "输出目录";
  const row = document.createElement("div");
  row.className = "cloudig-parse-target-row";
  const select = selectElement ? selectElement.cloneNode(false) : document.createElement("select");
  select.id = id;
  caption.htmlFor = select.id;
  select.dataset.parseDirectory = "";
  select.dataset.scrollPicker = "";
  select.setAttribute("aria-label", caption.textContent);
  const create = document.createElement("button");
  create.type = "button";
  create.className = "cloudig-button cloudig-button-filled";
  create.dataset.parseDirectoryNew = "";
  create.textContent = english ? "New directory" : "新建目录";
  row.append(select, create);
  label.append(caption, row);
  const editor = document.createElement("div");
  editor.className = "cloudig-parse-target-editor";
  editor.hidden = true;
  const nameLabel = document.createElement("label");
  nameLabel.className = "cloudig-dialog-field";
  nameLabel.append(english ? "Directory name" : "目录名称");
  const name = document.createElement("input");
  name.type = "text";
  name.autocomplete = "off";
  name.dataset.parseDirectoryName = "";
  nameLabel.append(name);
  const actions = document.createElement("div");
  actions.className = "cloudig-parse-target-actions";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "cloudig-button cloudig-button-outline";
  back.textContent = english ? "Cancel creation" : "取消新建";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "cloudig-button cloudig-button-filled";
  save.dataset.parseDirectoryCreate = "";
  save.textContent = english ? "Create and select" : "创建并选择";
  actions.append(back, save);
  const error = document.createElement("p");
  error.className = "cloudig-parse-target-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  editor.append(nameLabel, actions, error);
  const note = document.createElement("p");
  note.className = "cloudig-parse-target-note";
  element.append(label, editor, note);
  let changed = false, busy = false, disposed = false;
  const fill = (entries, selected) => {
    const selectedButton = document.createElement("button");
    selectedButton.type = "button";
    selectedButton.append(document.createElement("selectedcontent"));
    select.replaceChildren(selectedButton);
    for (const entry of [{ capability: "root", name: english ? "Conversation root" : "对话根目录" }, ...entries]) {
      const option = document.createElement("option");
      option.value = entry.capability; option.textContent = entry.name; select.append(option);
    }
    select.value = selected;
    select.title = select.selectedOptions[0]?.textContent ?? "";
  };
  const updateNote = () => {
    note.textContent = mode === "settings"
      ? english ? "Save settings to use this default. Created directories remain if you cancel." : "保存设置后作为默认目录；取消设置不会删除已创建的目录。"
      : english ? "For this run only. New and updated archives use this directory; updated archives keep their IDs and Marks." : "仅本次使用；新建与更新的档案均保存到此目录，更新时编号与Mark不变。";
  };
  const initial = initialDirectory === "Conversations" ? "root" : directories.find(d => "Conversations/" + d.name === initialDirectory)?.capability;
  if (!initial) throw new Error(english ? "The output directory is no longer available. Refresh and try again." : "输出目录已不可用，请刷新后重试。");
  fill(directories, initial); updateNote();
  select.addEventListener("change", () => { changed = true; select.title = select.selectedOptions[0]?.textContent ?? ""; updateNote(); });
  select.addEventListener("keydown", event => { if (event.key === "Escape" && select.matches(":open")) event.stopPropagation(); });
  create.addEventListener("click", () => { editor.hidden = false; error.hidden = true; name.focus(); });
  back.addEventListener("click", () => { editor.hidden = true; error.hidden = true; name.value = ""; create.focus(); });
  const submit = async () => {
    if (busy || disposed) return;
    const value = name.value.trim();
    if (!value) { error.textContent = english ? "Enter a directory name." : "请输入目录名称。"; error.hidden = false; name.focus(); return; }
    busy = true; for (const control of [select, create, name, back, save]) control.disabled = true; onBusy?.(true); error.hidden = true;
    try {
      const fresh = await onCreate(value);
      if (disposed) return;
      const added = fresh.find(d => d.name === value);
      if (!added) throw new Error(english ? "Directory created, but the list could not be refreshed." : "目录已创建，但列表未能刷新，请关闭后刷新重试。");
      fill(fresh, added.capability); changed = true; editor.hidden = true; name.value = ""; updateNote(); select.focus();
    } catch (reason) {
      if (!disposed) { error.textContent = errorMessage?.(reason, english) ?? String(reason?.message ?? reason); error.hidden = false; }
    } finally {
      busy = false;
      if (!disposed) { for (const control of [select, create, name, back, save]) control.disabled = false; onBusy?.(false); if (editor.hidden) select.focus(); }
    }
  };
  save.addEventListener("click", submit);
  name.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
  return { element, get busy() { return busy; }, value: () => ({ directory: select.value, changed }), dispose() { disposed = true; } };
}
