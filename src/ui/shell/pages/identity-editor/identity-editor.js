import { bindRecordTextInput, refreshRecordTextInputs } from "/shared/record-text-input.js";

const COPY = {
  "zh-CN": {
    generalTitle: "全局名称与头像设置",
    conversationDialogTitle: "对话名称设置",
    conversationTitle: "本篇对话名称",
    resetConversation: "恢复本篇默认名称",
    conversationUser: "本篇用户名",
    conversationAssistant: "本篇智能名字",
    globalTitle: "全局名称与头像",
    user: "采云用户",
    assistant: "智能伙伴",
    name: "名称",
    replace: "更换",
    clearAvatar: "×",
    reset: "恢复默认",
    applyAll: "所有对话使用统一智能头像与名字",
    applyAllLine1: "勾选此选项，全局名称将覆盖所有模型名称与头像设定。",
    applyAllLine2: "如不勾选，仅覆盖未设定模型头像和名称的默认选项。",
    userHelper: "用户头像和用户名将应用在所有对话中。",
    current: "当前显示",
    platformTitle: "模型名称与头像设定",
    resetPlatforms: "恢复全部平台默认值",
    scopeNote: "每篇对话可单独改用户名和会话智能名字：打开阅读器→点击会话→点击名字。",
    cancel: "取消",
    save: "保存",
    saving: "正在保存…",
    discard: "再按一次取消，将放弃尚未保存的修改。",
    failed: "身份设置没有保存，请保留当前页面后重试。"
  },
  en: {
    generalTitle: "Global Names and Avatars",
    conversationDialogTitle: "Conversation Names",
    conversationTitle: "Names for This Conversation",
    resetConversation: "Restore conversation defaults",
    conversationUser: "Conversation user name",
    conversationAssistant: "Conversation AI name",
    globalTitle: "Global Names and Avatars",
    user: "User",
    assistant: "AI",
    name: "Name",
    replace: "Replace",
    clearAvatar: "×",
    reset: "Restore default",
    applyAll: "Use one AI name and avatar in every conversation",
    applyAllLine1: "When selected, the global AI identity overrides every model name and avatar.",
    applyAllLine2: "When not selected, it is only the fallback for models without their own identity.",
    userHelper: "The user name and avatar apply to every conversation.",
    current: "Current display",
    platformTitle: "Model Names and Avatars",
    resetPlatforms: "Restore every platform default",
    scopeNote: "Each conversation can have its own user and AI names: open Reader → open a conversation → select a name.",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
    discard: "Select Cancel again to discard the unsaved changes.",
    failed: "Identity settings were not saved. Keep this page open and try again."
  }
};

function element(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function cleanName(value) {
  const next = value.trim();
  return next.length ? next : null;
}

function serializableDraft(draft, conversation) {
  return JSON.stringify({
    global: {
      user: { name: cleanName(draft.global.user.input.value), avatar: draft.global.user.avatar },
      assistant: { name: cleanName(draft.global.assistant.input.value), avatar: draft.global.assistant.avatar, apply_to_all: draft.global.assistant.apply.checked }
    },
    platforms: Object.fromEntries([...draft.platforms.entries()].map(([key, value]) => [key, { name: cleanName(value.input.value), avatar: value.avatar }])),
    ...(conversation ? { conversation: { user: cleanName(conversation.user.value), assistant: cleanName(conversation.assistant.value) } } : {})
  });
}

export function mountIdentityEditor(options) {
  const language = options.state.language === "en" ? "en" : "zh-CN";
  const copy = COPY[language];
  const fragment = options.template.content.cloneNode(true);
  const layer = fragment.querySelector("[data-identity-layer]");
  const dialog = layer.querySelector("[data-identity-dialog]");
  const model = options.model;
  const conversationModel = options.conversation ?? null;
  const staged = new Set();
  const draft = { global: {}, platforms: new Map() };
  let closed = false;
  let cancelArmed = false;
  let cancelTimer = null;
  let operation = null;
  const priorDisabled = new Map();
  let baseline = "";

  function setBusy(next) {
    operation = next;
    dialog.dataset.saving = String(next === "save");
    dialog.setAttribute("aria-busy", String(next !== null));
    for (const control of dialog.querySelectorAll("button, input, select")) {
      if (next) {
        if (!priorDisabled.has(control)) priorDisabled.set(control, control.disabled);
        control.disabled = next === "avatar" && control.hasAttribute("data-identity-cancel") ? priorDisabled.get(control) : true;
      } else control.disabled = priorDisabled.get(control) ?? control.disabled;
    }
    if (!next) priorDisabled.clear();
  }

  async function changeAvatar(action) {
    if (closed || operation) return;
    setBusy("avatar");
    try { await action(); }
    catch {
      if (!closed) showStatus(language === "en" ? "Could not use this image. Choose a PNG, JPEG, GIF or WebP within the allowed size." : "无法使用这张图片，请选择大小合规的 PNG、JPEG、GIF 或 WebP。");
    } finally { if (!closed) setBusy(null); }
  }

  layer.querySelector("[data-identity-title]").textContent = conversationModel ? copy.conversationDialogTitle : copy.generalTitle;
  const context = layer.querySelector("[data-identity-context]");
  if (conversationModel) { context.hidden = false; context.textContent = conversationModel.title; }
  for (const node of layer.querySelectorAll("[data-identity-copy]")) node.textContent = copy[node.dataset.identityCopy] ?? node.textContent;

  const conversation = conversationModel ? {
    section: layer.querySelector("[data-identity-conversation]"),
    user: layer.querySelector("[data-identity-conversation-user]"),
    assistant: layer.querySelector("[data-identity-conversation-assistant]")
  } : null;
  if (conversation) {
    conversation.section.hidden = false;
    conversation.user.value = conversationModel.names.user ?? "";
    conversation.assistant.value = conversationModel.names.assistant ?? "";
    bindRecordTextInput(conversation.user);
    bindRecordTextInput(conversation.assistant);
    layer.querySelector("[data-identity-reset-conversation]").addEventListener("click", () => {
      if (closed || operation) return;
      conversation.user.value = "";
      conversation.assistant.value = "";
      refreshPreview();
    });
  }

  async function descriptorUrl(descriptor) {
    try { return await options.resolveAvatar(descriptor); }
    catch { return options.applicationAsset("Assets/Defaults/assistant.svg"); }
  }

  async function discardPicker(picker) {
    if (!picker || !staged.has(picker)) return;
    staged.delete(picker);
    await options.discardAvatar(picker).catch(() => undefined);
  }

  function card(scope, source, title, platform) {
    const root = element("article", "identity-card");
    const avatarColumn = element("div", "identity-card-avatar");
    const frame = element("span", "identity-avatar-frame");
    if (platform) frame.dataset.platform = platform;
    const image = element("img");
    image.alt = "";
    const clear = element("button", "identity-avatar-clear", copy.clearAvatar);
    clear.type = "button";
    clear.hidden = source.custom_avatar !== true;
    clear.title = language === "en" ? "Restore default avatar" : "恢复默认头像";
    frame.append(image, clear);
    const avatarActions = element("span", "identity-avatar-actions");
    const replace = element("button", "", copy.replace);
    replace.type = "button";
    avatarActions.append(replace);
    avatarColumn.append(frame, avatarActions);

    const head = element("div", "identity-card-head");
    head.append(element("strong", "", title));
    const reset = element("button", "identity-card-reset", copy.reset);
    reset.type = "button";
    head.append(reset);
    const label = element("label", "identity-card-name");
    label.append(element("span", "", copy.name));
    const input = element("input");
    input.type = "text";
    input.autocomplete = "off";
    input.value = source.name ?? "";
    bindRecordTextInput(input);
    label.append(input);
    const preview = element("p", "identity-card-preview");
    preview.append(element("span", "", `${copy.current}：`), element("b", "", source.resolved_name));
    root.append(avatarColumn, head, label, preview);

    const value = {
      root, image, input, clear, preview: preview.querySelector("b"),
      avatar: { state: "keep" },
      initial: source,
      previewDescriptor: source.resolved_avatar,
      selectedUrl: null,
      sourceDescriptor: source.source_avatar
    };
    replace.addEventListener("click", () => changeAvatar(async () => {
      const picked = await options.pickAvatar();
      if (!picked) return;
      // A native picker may complete after Cancel. Account for its capability
      // before any further await, so closing always retires unsaved images.
      staged.add(picked.picker);
      if (closed) { await discardPicker(picked.picker); return; }
      if (value.avatar.state === "picker") await discardPicker(value.avatar.picker);
      if (closed) { await discardPicker(picked.picker); return; }
      value.avatar = { state: "picker", picker: picked.picker };
      value.selectedUrl = picked.url;
      image.src = picked.url;
      clear.hidden = false;
    }));
    clear.addEventListener("click", () => changeAvatar(() => clearCardAvatar(value)));
    reset.addEventListener("click", () => changeAvatar(async () => {
      input.value = "";
      await clearCardAvatar(value);
    }));
    input.addEventListener("input", refreshPreview);
    descriptorUrl(source.resolved_avatar).then((url) => { if (!closed && !image.src) image.src = url; });
    return value;
  }

  const globalGrid = layer.querySelector("[data-identity-global-grid]");
  draft.global.user = card("user", model.global.user, copy.user);
  draft.global.assistant = card("assistant", model.global.assistant, copy.assistant);
  draft.global.user.root.append(element("p", "identity-card-helper", copy.userHelper));
  const apply = element("label", "identity-apply-all cloudig-choice");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.checked = model.global.assistant.apply_to_all;
  const applyCopy = element("span");
  applyCopy.textContent = copy.applyAll;
  apply.append(checkbox, applyCopy);
  const applyHelper = element("p", "identity-apply-helper");
  applyHelper.append(element("i", "", "!"), element("span", "", `${copy.applyAllLine1}\n${copy.applyAllLine2}`));
  draft.global.assistant.root.append(apply, applyHelper);
  draft.global.assistant.apply = checkbox;
  checkbox.addEventListener("change", refreshPreview);
  globalGrid.append(draft.global.user.root, draft.global.assistant.root);

  const platformGrid = layer.querySelector("[data-identity-platform-grid]");
  for (const source of model.platforms) {
    const value = card(source.platform, source, source.source_name, source.platform);
    draft.platforms.set(source.platform, value);
    platformGrid.append(value.root);
  }

  function assistantFallback(platformValue) {
    const globalName = cleanName(draft.global.assistant.input.value);
    if (draft.global.assistant.apply.checked) return globalName ?? platformValue.initial.source_name;
    return cleanName(platformValue.input.value) ?? globalName ?? platformValue.initial.source_name;
  }

  function refreshPreview() {
    draft.global.user.preview.textContent = cleanName(draft.global.user.input.value) ?? model.global.user.source_name;
    draft.global.assistant.preview.textContent = cleanName(draft.global.assistant.input.value) ?? model.global.assistant.source_name;
    for (const value of draft.platforms.values()) value.preview.textContent = assistantFallback(value);
  }
  refreshPreview();

  async function clearCardAvatar(value) {
    const previous = value.avatar;
    value.avatar = { state: "clear" };
    value.clear.hidden = true;
    value.selectedUrl = null;
    if (previous.state === "picker") await discardPicker(previous.picker);
    if (closed) return;
    const url = await descriptorUrl(value.sourceDescriptor);
    if (closed) return;
    value.image.src = url;
    refreshPreview();
  }

  layer.querySelector("[data-identity-reset-platforms]").addEventListener("click", () => changeAvatar(async () => {
    for (const value of draft.platforms.values()) {
      if (closed) return;
      value.input.value = "";
      await clearCardAvatar(value);
    }
  }));

  const status = layer.querySelector("[data-identity-status]");
  const cancel = layer.querySelector("[data-identity-cancel]");
  function showStatus(message) { status.hidden = !message; status.textContent = message ?? ""; }
  async function close(result) {
    if (closed || (!result?.saved && operation === "save")) return;
    closed = true;
    clearTimeout(cancelTimer);
    if (!result?.saved) await Promise.all([...staged].map(discardPicker));
    staged.clear();
    layer.remove();
    options.onClose(result ?? { saved: false });
  }
  async function tryCancel() {
    if (closed || operation === "save") return;
    if (serializableDraft(draft, conversation) === baseline || cancelArmed) { await close({ saved: false }); return; }
    cancelArmed = true;
    showStatus(copy.discard);
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => { cancelArmed = false; }, 3500);
  }
  cancel.addEventListener("click", () => { tryCancel().catch(() => undefined); });
  layer.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); tryCancel().catch(() => undefined); } });
  dialog.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (closed || operation) return;
    refreshRecordTextInputs(dialog);
    if (!dialog.reportValidity()) return;
    setBusy("save");
    showStatus(copy.saving);
    const globalDraft = {
      global: {
        user: { name: cleanName(draft.global.user.input.value), avatar: draft.global.user.avatar },
        assistant: { name: cleanName(draft.global.assistant.input.value), avatar: draft.global.assistant.avatar, apply_to_all: draft.global.assistant.apply.checked }
      },
      platforms: Object.fromEntries([...draft.platforms.entries()].map(([key, value]) => [key, { name: cleanName(value.input.value), avatar: value.avatar }]))
    };
    const conversationNames = conversation ? { user: cleanName(conversation.user.value), assistant: cleanName(conversation.assistant.value) } : null;
    try {
      const result = await options.save({ globalDraft, conversationNames });
      staged.clear();
      await close({ saved: true, result });
    } catch (error) {
      setBusy(null);
      showStatus(["CLOUDIG_IDENTITY_EDIT_INVALID", "CLOUDIG_ARCHIVE_INFO_CONFLICT"].includes(error?.code)
        ? language === "en" ? "These settings or this conversation changed. Your input is still here; reopen the editor before saving again." : "身份设置或本篇对话已变化。当前输入仍保留，请重新打开编辑页后再保存。"
        : error?.message || copy.failed);
    }
  });

  options.host.append(layer);
  baseline = serializableDraft(draft, conversation);
  (conversation?.user ?? draft.global.user.input).focus();
  return { element: layer, cleanup: () => close({ saved: false }) };
}

export function visualIdentityFixture(language = "zh-CN") {
  const names = language === "en" ? { user: "User", assistant: "AI" } : { user: "采云用户", assistant: "智能伙伴" };
  const platforms = ["chatgpt", "claude", "gemini", "grok", "deepseek", "doubao", "kimi", "qwen", "chatglm", "zai", "yuanbao", "mistral"];
  return {
    revision: 7,
    language,
    global: {
      user: { source_name: names.user, source_avatar: { kind: "application", asset: "Assets/Defaults/user.svg" }, name: null, custom_avatar: false, resolved_name: names.user, resolved_avatar: { kind: "application", asset: "Assets/Defaults/user.svg" } },
      assistant: { source_name: names.assistant, source_avatar: { kind: "application", asset: "Assets/Defaults/assistant.svg" }, name: null, custom_avatar: false, apply_to_all: false, resolved_name: names.assistant, resolved_avatar: { kind: "application", asset: "Assets/Defaults/assistant.svg" } }
    },
    platforms: platforms.map((platform) => ({ platform, source_name: platform === "chatgpt" ? "ChatGPT" : platform === "zai" ? "Z.ai" : platform[0].toUpperCase() + platform.slice(1), source_avatar: { kind: "application", asset: `Assets/Platforms/${platform}.svg` }, name: null, custom_avatar: false, resolved_name: platform === "chatgpt" ? "ChatGPT" : platform, resolved_avatar: { kind: "application", asset: `Assets/Platforms/${platform}.svg` } }))
  };
}
