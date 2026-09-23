import { formatTimeRange } from "/Cloudig/shared/time/endpoint-editor.js";
import { observeTitleLayout } from "./title-layout.js";

const platformDefinitions = Object.freeze({
  chatgpt: ["ChatGPT", "/Cloudig/assets/platforms/platform-chatgpt.svg"],
  claude: ["Claude", "/Cloudig/assets/platforms/platform-claude.svg"],
  gemini: ["Gemini", "/Cloudig/assets/platforms/platform-gemini.svg"],
  grok: ["Grok", "/Cloudig/assets/platforms/platform-grok.svg"],
  deepseek: ["DeepSeek", "/Cloudig/assets/platforms/platform-deepseek.svg"],
  doubao: ["豆包", "/Cloudig/assets/platforms/platform-doubao.png"],
  qwen: ["Qwen", "/Cloudig/assets/platforms/platform-qwen.svg"],
  chatglm: ["ChatGLM", "/Cloudig/assets/platforms/platform-chatglm.svg"],
  yuanbao: ["元宝", "/Cloudig/assets/platforms/platform-yuanbao.svg"],
  zai: ["Z.ai", "/Cloudig/assets/platforms/platform-zai.svg"],
  kimi: ["Kimi", "/Cloudig/assets/platforms/platform-kimi.svg"],
  mistral: ["Mistral", "/Cloudig/assets/platforms/platform-mistral.svg"]
});

export const readerConversationPreload = Object.freeze([
  "/Cloudig/assets/reader/Conversation-Title-Back-Dawn.svg",
  "/Cloudig/assets/reader/Conversation-Title-Back-StarNight.svg",
  "/Cloudig/assets/reader/ToolBar-Pattern-Dawn.svg",
  "/Cloudig/assets/reader/ToolBar-Pattern-StarNight.svg",
  "/Cloudig/assets/reader/ThreeBird-Dawn.svg",
  "/Cloudig/assets/reader/ThreeBird-StarNight.svg",
  "/Cloudig/assets/reader/DecBook-Dawn.svg",
  "/Cloudig/assets/reader/DecBook-StarNight.svg",
  "/Cloudig/assets/reader/SmallButterfly-Dawn.svg",
  "/Cloudig/assets/reader/SmallButterfly-StarNight.svg"
]);

export const defaultReaderSession = Object.freeze({
  expanded: Object.freeze({ reasoning: false, tools: false, references: false }),
  hidden: Object.freeze({ reasoning: false, tools: false }),
  navigation: Object.freeze({ user: true, assistant: true, process: false })
});

function cloneSession(value = defaultReaderSession) {
  return {
    expanded: { ...value.expanded },
    hidden: { ...value.hidden },
    navigation: { ...value.navigation },
    ...(value.selected_leaf ? { selected_leaf: value.selected_leaf } : {}),
    ...(value.branch_choices ? { branch_choices: { ...value.branch_choices } } : {})
  };
}

function dateTimeLabel(value, language) {
  if (!value || typeof value !== "object") return language === "en" ? "Unknown time" : "时间未定";
  const range = value.range && typeof value.range === "object" ? value.range : undefined;
  if (range?.start) {
    try {
      return formatTimeRange(range, language);
    } catch {
      // A malformed view cannot replace the bounded fallback below.
    }
  }
  const start = range?.start;
  if (start?.kind === "calendar" && Number.isInteger(start.year)) {
    const era = start.era === "BC" ? "BC " : "";
    const month = Number.isInteger(start.month) ? `-${String(start.month).padStart(2, "0")}` : "";
    const day = Number.isInteger(start.day) ? `-${String(start.day).padStart(2, "0")}` : "";
    const hour = Number.isInteger(start.hour) ? ` ${String(start.hour).padStart(2, "0")}:${String(start.minute ?? 0).padStart(2, "0")}` : "";
    return `${era}${start.year}${month}${day}${hour}`;
  }
  return language === "en" ? "Unknown time" : "时间未定";
}

function capturedTime(value) {
  const timestamp = value && typeof value === "object" ? value.value : undefined;
  return typeof timestamp === "string" ? timestamp.replace("T", " ").replace(/\.\d+(?=Z$|[+-]\d\d:\d\d$)/u, "").replace(/Z$/u, " (UTC+00:00)").replace(/(?<!UTC)([+-]\d\d:\d\d)$/u, " (UTC$1)") : undefined;
}

function labels(translate) {
  const value = (key, fallback) => translate(`reader.renderer.${key}`) ?? fallback;
  return {
    reasoning: value("reasoning", "思考"),
    reasoningContent: value("reasoningContent", "思考内容"),
    reasoningSummary: value("reasoningSummary", "思考摘要"),
    processGroup: value("processGroup", "思考与工具"),
    toolCall: value("toolCall", "工具调用"),
    toolResult: value("toolResult", "工具结果"),
    toolActivity: value("toolActivity", "工具活动"),
    references: value("references", "参考"),
    search: value("search", "搜索"),
    diagram: value("diagram", "图表"),
    source: value("source", "源码"),
    loadingResource: value("loadingResource", "正在读取资源"),
    unavailableResource: value("unavailableResource", "资源不可用"),
    failedResource: value("failedResource", "资源读取失败"),
    openAttachment: value("openAttachment", "保存附件"),
    externalResource: value("externalResource", "打开原链接"),
    systemParty: value("systemParty", "系统"),
    toolParty: value("toolParty", "工具"),
    otherParty: value("otherParty", "其他"),
    schedule: {
      enabled: value("scheduleEnabled", "采集时已启用"), disabled: value("scheduleDisabled", "采集时已停用"),
      timezone: value("scheduleTimezone", "时区"), lastRun: value("scheduleLastRun", "上次执行"), nextRun: value("scheduleNextRun", "下次执行"),
      settings: value("scheduleSettings", "原始设置"), allTasks: value("scheduleAllTasks", "查看所有任务"), conversation: value("scheduleConversation", "原会话"),
      prompt: value("schedulePrompt", "任务指令"), notifications: value("scheduleNotifications", "通知"), on: value("scheduleOn", "开启"), off: value("scheduleOff", "关闭")
    }
  };
}

function platform(value, language) {
  return Object.hasOwn(platformDefinitions, value) ? platformDefinitions[value] : [language === "en" ? "Unknown" : "未知", "/Cloudig/assets/platforms/platform-unknown.svg"];
}

function renderHeader(root, view, row, state, translate) {
  const header = view.header ?? {};
  const platformId = String(header.platform ?? row.platform ?? "");
  const [platformName, platformAsset] = platform(platformId, state.language);
  root.dataset.platform = platformId;
  const logoHost = root.querySelector(".reader-conversation-platform-logo");
  logoHost.dataset.platform = platformId;
  const logo = root.querySelector("[data-reader-conversation-platform-logo]");
  logo.src = platformAsset;
  logo.alt = platformName;
  logo.title = `${platformName} · ${platformId}`;
  root.querySelector("[data-reader-conversation-platform]").textContent = platformName;
  root.querySelector("[data-reader-conversation-title]").textContent = String(header.title ?? row.title ?? row.filename ?? "");
  const models = root.querySelector("[data-reader-conversation-models]");
  models.replaceChildren();
  for (const model of Array.isArray(header.models) ? header.models : []) {
    const tag = document.createElement("span");
    tag.className = "reader-conversation-model-tag";
    tag.textContent = String(model);
    tag.title = tag.textContent;
    models.append(tag);
  }
  const language = state.language;
  const demoBack = root.querySelector('[data-example-return]');
  if (demoBack) {
    demoBack.textContent = language === 'en' ? '↶ Back to examples' : '↶ 返回平台范例';
    root.querySelector('.example-reading-label').textContent = language === 'en' ? 'Read-only example' : '范例 · 只读演示';
    const sideBack = root.querySelector('[data-route-target="reader-cover"]');
    if (sideBack) { delete sideBack.dataset.i18n; sideBack.textContent = language === 'en' ? '↶ Examples' : '返回平台范例'; sideBack.title = language === 'en' ? 'Back to platform examples' : '返回平台范例'; }
  }
  root.querySelector("[data-reader-content-time]").textContent = `${translate("reader.contentTimeLabel")}: ${dateTimeLabel(header.content_time, language)}`;
  const captured = capturedTime(header.captured_at);
  const capturedNode = root.querySelector("[data-reader-captured-time]");
  capturedNode.textContent = captured ? `${translate("reader.exportTimeLabel")}: ${captured}` : "";
  capturedNode.hidden = !captured;
  const count = Number(view.pagination?.total_canonical ?? row.messages ?? 0);
  root.querySelector("[data-reader-message-count]").textContent = `${translate("reader.messageCountLabel")}: ${count}`;
}

function rendererFactory() {
  const factory = globalThis.CloudigConversationRenderer?.createConversationRenderer;
  if (typeof factory !== "function") throw new Error("Cloudig offline renderer is unavailable");
  return factory;
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("und");
}

export function mountReaderConversation(options) {
  const fragment = options.template.content.cloneNode(true);
  for (const node of fragment.querySelectorAll("[data-i18n]")) node.textContent = options.translate(node.dataset.i18n);
  for (const node of fragment.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = options.translate(node.dataset.i18nPlaceholder);
  for (const node of fragment.querySelectorAll("[data-i18n-title]")) {
    const value = options.translate(node.dataset.i18nTitle);
    node.title = value;
    node.setAttribute("aria-label", value);
  }
  const main = fragment.querySelector("[data-reader-conversation-main]");
  if (options.readOnly) {
    const actions = main.querySelector('.reader-conversation-title-actions');
    const label = document.createElement('span'); label.className = 'example-reading-label'; label.textContent = options.state.language === 'en' ? 'Read-only example' : '范例 · 只读演示';
    const back = document.createElement('button'); back.type = 'button'; back.className = 'cloudig-button cloudig-button-outline'; back.dataset.exampleReturn = '';
    back.textContent = options.state.language === 'en' ? '↶ Back to examples' : '↶ 返回平台范例';
    back.addEventListener('click', options.onExampleReturn); actions.replaceChildren(label, back);
  }
  const navigation = fragment.querySelector("[data-reader-conversation-navigation]");
  const controller = new AbortController();
  const scroll = main.querySelector("[data-reader-conversation-scroll]");
  const rendererRoot = main.querySelector("[data-reader-renderer]");
  const navigationList = navigation.querySelector("[data-reader-navigation-list]");
  const preview = document.createElement("div");
  preview.className = "reader-navigation-preview";
  preview.setAttribute("role", "tooltip");
  options.page.append(preview);
  options.page.querySelector(".reader-main").append(main);
  options.page.querySelector(".reader-navigation").append(navigation);
  options.page.dataset.readerView = "conversation";
  const titleLayout = observeTitleLayout(main);
  let view = options.view ?? {};
  let state = options.state;
  let session = cloneSession(options.session);
  let renderer;
  let observer;
  let refreshOrdinal = 0;
  let navigationItems = [];
  let currentNavigation = 0;
  let searchMatches = [];
  let currentSearch = 0;
  let disposed = false;
  const pendingPages = new Map();
  let loadingPhase = options.loading ? "reading" : null;
  const loading = document.createElement("div");
  loading.className = "reader-conversation-loading";
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  const loadingText = document.createElement("p");
  const loadingBar = document.createElement("span");
  loadingBar.className = "reader-conversation-loading-bar";
  loadingBar.setAttribute("role", "progressbar");
  loadingBar.setAttribute("aria-label", options.translate("reader.loadingReading"));
  loading.append(loadingText, loadingBar);
  rendererRoot.before(loading);
  const showLoading = (phase) => {
    loadingPhase = phase;
    loading.hidden = !phase;
    loading.dataset.failed = String(phase === "failed");
    loadingText.textContent = options.translate(phase === "failed" ? "reader.loadingFailed" : phase === "preparing" ? "reader.loadingPreparing" : "reader.loadingReading");
    rendererRoot.hidden = Boolean(phase);
    main.setAttribute("aria-busy", String(Boolean(phase && phase !== "failed")));
    for (const host of main.querySelectorAll(".reader-conversation-toolbar, .reader-conversation-title-actions")) host.inert = Boolean(phase);
    navigation.querySelector(".reader-navigation-controls").inert = Boolean(phase);
    options.page.dataset.conversationReady = String(!phase);
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    refreshOrdinal++;
    controller.abort();
    observer?.disconnect();
    titleLayout.cleanup();
    try { renderer?.destroy(); }
    finally {
      renderer = undefined;
      preview.remove();
      main.remove();
      navigation.remove();
      delete options.page.dataset.platform;
      delete options.page.dataset.conversationReady;
      options.page.dataset.readerView = "cover";
    }
  };
  const reportError = (error) => { if (!disposed) options.onError?.(error); };

  const resolveAvatar = (reference, signal) => options.resolveAvatar(reference, signal);
  const resolveResource = (resource, purpose, signal) => options.resolveResource(resource, purpose, signal);

  const createRenderer = () => rendererFactory()({
    root: rendererRoot,
    labels: labels(options.translate),
    theme: state.theme,
    resolveAvatar,
    resolveResource,
    onOpenExternal: options.onOpenExternal,
    onOpenResource: options.onOpenResource,
    onEditIdentity: options.onEditIdentity,
    formatDuration: (seconds) => state.language === "en" ? `${seconds}s` : `${seconds}秒`,
    formatTimestamp: (timestamp) => timestamp.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/u, "")
  });

  const setCurrentNavigation = (index) => {
    if (navigationItems.length === 0) return;
    currentNavigation = Math.max(0, Math.min(index, navigationItems.length - 1));
    for (const [ordinal, node] of [...navigationList.children].entries()) node.dataset.current = String(ordinal === currentNavigation);
    navigationList.querySelector(".reader-navigation-butterfly-host")?.remove();
    const butterfly = document.createElement("span");
    butterfly.className = "reader-navigation-butterfly-host";
    butterfly.innerHTML = '<img class="reader-navigation-butterfly reader-theme-dawn" src="/Cloudig/assets/reader/SmallButterfly-Dawn.svg" alt=""><img class="reader-navigation-butterfly reader-theme-star-night" src="/Cloudig/assets/reader/SmallButterfly-StarNight.svg" alt="">';
    navigationList.children[currentNavigation]?.append(butterfly);
  };

  const scrollToNavigation = async (index) => {
    if (navigationItems.length === 0) return;
    setCurrentNavigation(index);
    const anchor = String(navigationItems[currentNavigation].anchor);
    const find = () => rendererRoot.querySelector(`#${CSS.escape(anchor)}`)
      ?? rendererRoot.querySelector(`#${CSS.escape(anchor.replace(/-process-[0-9]+$/u, ""))}`);
    const ordinal = refreshOrdinal;
    while (!find() && view.pagination?.has_next && !disposed && ordinal === refreshOrdinal) await loadMore("messages");
    if (disposed || ordinal !== refreshOrdinal) return;
    const target = find();
    let unfolded = false;
    for (let fold = target?.closest("details"); fold; fold = fold.parentElement?.closest("details")) { unfolded ||= !fold.open; fold.open = true; }
    if (unfolded) await new Promise(resolve => setTimeout(resolve, 0));
    if (!target) return;
    // A long smooth traversal wakes lazy images between the old and new
    // positions. Their new heights can leave its precomputed endpoint pages
    // short of the chosen message. Jump directly over offscreen content;
    // retain the gentle movement for nearby navigation.
    const distance = Math.abs(target.getBoundingClientRect().top - scroll.getBoundingClientRect().top);
    target.scrollIntoView({ block: "start", behavior: distance > scroll.clientHeight || matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const watchVisible = () => {
    observer?.disconnect();
    const anchors = navigationItems.flatMap((item) => {
      const node = rendererRoot.querySelector(`#${CSS.escape(String(item.anchor))}`);
      return node ? [node] : [];
    });
    if (anchors.length === 0) return;
    observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      if (visible.length === 0) return;
      const index = navigationItems.findIndex((item) => item.anchor === visible[0].target.id);
      if (index >= 0) setCurrentNavigation(index);
    }, { root: scroll, rootMargin: "0px 0px -72% 0px", threshold: 0 });
    anchors.forEach((node) => observer.observe(node));
  };

  const renderNavigation = () => {
    navigationItems = Array.isArray(view.navigation?.items) ? view.navigation.items : [];
    navigationList.replaceChildren();
    let primaryKind;
    for (const [index, item] of navigationItems.entries()) {
      const entry = document.createElement("li");
      entry.className = "reader-navigation-item";
      const kind = String(item.kind ?? "process");
      const boundary = kind !== "process" && kind !== primaryKind;
      if (kind !== "process") primaryKind = kind;
      entry.dataset.boundary = String(boundary);
      entry.dataset.current = String(index === currentNavigation);
      const button = document.createElement("button");
      button.type = "button";
      const number = document.createElement("span");
      number.className = "reader-navigation-number";
      number.textContent = String(index + 1).padStart(3, "0");
      const copy = document.createElement("span");
      copy.className = "reader-navigation-copy";
      copy.textContent = String(item.text ?? "");
      copy.title = copy.textContent;
      button.append(number, copy);
      button.addEventListener("click", () => { void scrollToNavigation(index).catch(reportError); }, { signal: controller.signal });
      entry.addEventListener("pointerenter", () => {
        const rect = entry.getBoundingClientRect();
        preview.textContent = copy.textContent;
        preview.dataset.visible = "true";
        requestAnimationFrame(() => {
          if (disposed) return;
          const width = preview.getBoundingClientRect().width;
          preview.style.left = `${Math.max(8, rect.left - width - 12)}px`;
          preview.style.top = `${Math.max(52, Math.min(innerHeight - preview.offsetHeight - 8, rect.top - 8))}px`;
        });
      }, { signal: controller.signal });
      entry.addEventListener("pointerleave", () => { preview.dataset.visible = "false"; }, { signal: controller.signal });
      entry.append(button);
      navigationList.append(entry);
    }
    if (navigationItems.length > 0) setCurrentNavigation(Math.min(currentNavigation, navigationItems.length - 1));
    watchVisible();
  };

  const applySearch = (move = false) => {
    const input = main.querySelector("[data-reader-current-search-input]");
    const query = normalize(input.value.trim());
    const messages = [...rendererRoot.querySelectorAll(".cloudig-message")];
    for (const message of messages) {
      delete message.dataset.searchMatch;
      delete message.dataset.searchCurrent;
    }
    if (query) renderer.materializeDeferred?.();
    searchMatches = query ? messages.filter((message) => normalize(message.textContent).includes(query)) : [];
    currentSearch = searchMatches.length === 0 ? 0 : Math.min(currentSearch, searchMatches.length - 1);
    searchMatches.forEach((message, index) => {
      message.dataset.searchMatch = "true";
      message.dataset.searchCurrent = String(index === currentSearch);
    });
    const count = main.querySelector("[data-reader-search-count]");
    count.hidden = query.length === 0;
    count.textContent = query.length === 0 ? "" : `${searchMatches.length === 0 ? 0 : currentSearch + 1}/${searchMatches.length}`;
    main.querySelector("[data-reader-current-search-clear]").hidden = query.length === 0;
    if (move && searchMatches.length > 0) searchMatches[currentSearch].scrollIntoView({ block: "center" });
  };

  const rebuildRenderer = () => {
    renderer?.destroy();
    renderer = createRenderer();
    renderer.render(view);
    renderNavigation();
    applySearch();
    renderBranches();
  };

  const renderBranches = () => {
    for (const message of view.messages ?? []) {
      const article = document.getElementById(message.anchor);
      if (!article || article.querySelector(".reader-message-branches")) continue;
      if (!message.branch_controls?.length) continue;
      const host = document.createElement("nav"); host.className = "reader-message-branches";
      for (const branch of message.branch_controls) {
        const group = document.createElement("span"); group.dataset.branchParent = branch.parent;
        group.dataset.branchSelected = branch.selected ?? "";
        group.setAttribute("aria-label", state.language === "en" ? "Message branches" : "消息分支");
        for (const direction of ["previous", "next"]) {
          if (direction === "next") {
            const count = document.createElement("span"); count.textContent = `${branch.index + 1} / ${branch.total}`;
            group.append(count);
          }
          const button = document.createElement("button"); button.type = "button";
          button.dataset.branchChild = branch[direction] ?? ""; button.disabled = !branch[direction];
          button.title = state.language === "en" ? (direction === "previous" ? "Previous branch" : "Next branch") : (direction === "previous" ? "上一分支" : "下一分支");
          button.setAttribute("aria-label", button.title);
          button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${direction === "previous" ? "m12 4-6 6 6 6" : "m8 4 6 6-6 6"}"/></svg>`;
          group.append(button);
        }
        host.append(group);
      }
      // The header is display:contents. A branch nav placed there becomes an
      // implicit avatar-column grid item and spills underneath the next bubble.
      article.append(host);
    }
  };
  const loadMore = async (kind) => {
    if (pendingPages.has(kind)) return pendingPages.get(kind);
    const previous = kind === "messages" ? view.pagination : kind === "navigation" ? view.navigation : view.branch?.leaves;
    if (disposed || !previous?.has_next) return;
    const ordinal = refreshOrdinal;
    const task = (async () => {
      const offset = kind === "messages" ? view.messages.length : kind === "navigation" ? view.navigation.items.length : view.branch.leaves.items.length;
      const next = await options.requestPage(cloneSession(session), { [kind]: offset });
      if (disposed || ordinal !== refreshOrdinal) return;
      const page = kind === "messages" ? next.pagination : kind === "navigation" ? next.navigation : next.branch?.leaves;
      if (!page || page.returned < 1 || page.offset !== offset) throw new Error("Conversation paging made no progress");
      if (kind === "messages") {
        view = { ...view, messages: [...view.messages, ...next.messages], pagination: page };
        renderer.append(next); renderBranches(); watchVisible(); applySearch();
      } else if (kind === "navigation") {
        view = { ...view, navigation: { ...page, items: [...view.navigation.items, ...page.items] } };
        renderNavigation();
      } else {
        view = { ...view, branch: { ...view.branch, leaves: { ...page, items: [...view.branch.leaves.items, ...page.items] } } };
        renderBranches();
      }
    })();
    pendingPages.set(kind, task);
    try { await task; } finally { if (pendingPages.get(kind) === task) pendingPages.delete(kind); }
  };

  for (const [owner, kind] of [[scroll, "messages"], [navigationList, "navigation"]]) {
    owner.addEventListener("scroll", () => {
      if (owner.scrollHeight - owner.scrollTop - owner.clientHeight < 250) void loadMore(kind).catch(reportError);
    }, { passive: true, signal: controller.signal });
  }
  let branchBusy = false;
  main.addEventListener("click", (event) => {
    const button = event.target.closest("[data-branch-child]");
    if (!button || button.disabled || branchBusy) return;
    const group = button.closest("[data-branch-parent]");
    const parent = group.dataset.branchParent;
    const top = group.getBoundingClientRect().top;
    session.branch_choices = { ...session.branch_choices, [parent]: button.dataset.branchChild };
    delete session.selected_leaf;
    options.onSessionChange?.(cloneSession(session));
    branchBusy = true;
    void (async () => {
      await refreshView();
      const find = () => [...main.querySelectorAll("[data-branch-parent]")].find(item => item.dataset.branchParent === parent);
      while (!disposed && !find() && view.pagination?.has_next) await loadMore("messages");
      const target = find();
      if (target) scroll.scrollTop += target.getBoundingClientRect().top - top;
    })().catch(reportError).finally(() => { branchBusy = false; });
  }, { signal: controller.signal });

  const refreshView = async () => {
    const ordinal = ++refreshOrdinal;
    pendingPages.clear();
    const next = await options.requestPage(session);
    if (disposed || ordinal !== refreshOrdinal) return;
    view = next;
    rebuildRenderer();
  };

  const setSession = (key, checked) => {
    if (key === "expand-reasoning") session.expanded.reasoning = checked;
    if (key === "expand-tools") session.expanded.tools = checked;
    if (key === "expand-references") session.expanded.references = checked;
    if (key === "hide-reasoning") session.hidden.reasoning = checked;
    if (key === "hide-tools") session.hidden.tools = checked;
    options.onSessionChange?.(cloneSession(session));
    void refreshView().catch(reportError);
  };

  const sessionChecks = {
    "expand-reasoning": session.expanded.reasoning,
    "expand-tools": session.expanded.tools,
    "expand-references": session.expanded.references,
    "hide-reasoning": session.hidden.reasoning,
    "hide-tools": session.hidden.tools
  };
  for (const input of main.querySelectorAll("[data-reader-session]")) {
    input.checked = sessionChecks[input.dataset.readerSession] === true;
    input.addEventListener("change", () => setSession(input.dataset.readerSession, input.checked), { signal: controller.signal });
  }
  for (const input of navigation.querySelectorAll("[data-reader-navigation]")) {
    input.checked = session.navigation[input.dataset.readerNavigation] === true;
    input.addEventListener("change", () => {
      const kind = input.dataset.readerNavigation;
      const assistant = navigation.querySelector("[data-reader-navigation='assistant']");
      const process = navigation.querySelector("[data-reader-navigation='process']");
      if (kind === "process" && !assistant.checked) input.checked = false;
      session.navigation[kind] = input.checked;
      if (kind === "assistant" && !input.checked) {
        session.navigation.process = false;
        process.checked = false;
      }
      process.disabled = !assistant.checked;
      options.onSessionChange?.(cloneSession(session));
      void refreshView().catch(reportError);
    }, { signal: controller.signal });
  }
  navigation.querySelector("[data-reader-navigation='process']").disabled = !session.navigation.assistant;
  for (const button of navigation.querySelectorAll("[data-reader-navigation-jump]")) {
    button.addEventListener("click", () => { void (async () => {
      const action = button.dataset.readerNavigationJump;
      const ordinal = refreshOrdinal;
      if (action === "last") while (view.navigation?.has_next && !disposed && ordinal === refreshOrdinal) await loadMore("navigation");
      if (action === "next" && currentNavigation === navigationItems.length - 1) await loadMore("navigation");
      if (disposed || ordinal !== refreshOrdinal) return;
      if (action === "first") await scrollToNavigation(0);
      if (action === "previous") await scrollToNavigation(currentNavigation - 1);
      if (action === "next") await scrollToNavigation(currentNavigation + 1);
      if (action === "last") await scrollToNavigation(navigationItems.length - 1);
    })().catch(reportError);
    }, { signal: controller.signal });
  }
  main.querySelector("[data-reader-current-search]").addEventListener("submit", (event) => {
    event.preventDefault();
    currentSearch = 0;
    const ordinal = refreshOrdinal;
    const query = main.querySelector("[data-reader-current-search-input]").value;
    void (async () => {
      while (view.pagination?.has_next && !disposed && ordinal === refreshOrdinal && query === main.querySelector("[data-reader-current-search-input]").value) await loadMore("messages");
      if (!disposed && ordinal === refreshOrdinal) applySearch(true);
    })().catch(reportError);
  }, { signal: controller.signal });
  main.querySelector("[data-reader-current-search-clear]").addEventListener("click", () => {
    main.querySelector("[data-reader-current-search-input]").value = "";
    currentSearch = 0;
    applySearch();
  }, { signal: controller.signal });
  main.querySelector("[data-reader-search-next]").addEventListener("click", () => {
    if (searchMatches.length === 0) return;
    currentSearch = (currentSearch + 1) % searchMatches.length;
    applySearch(true);
  }, { signal: controller.signal });
  main.querySelector("[data-reader-search-previous]").addEventListener("click", () => {
    if (searchMatches.length === 0) return;
    currentSearch = (currentSearch - 1 + searchMatches.length) % searchMatches.length;
    applySearch(true);
  }, { signal: controller.signal });
  main.querySelector("[data-action='export-markdown']")?.addEventListener("click", () => {
    void options.onExport?.(session.selected_leaf, session.branch_choices);
  }, { signal: controller.signal });
  main.querySelector("[data-action='edit-conversation']")?.addEventListener("click", () => {
    void options.onEditConversation?.(options.row);
  }, { signal: controller.signal });
  try {
    renderHeader(options.page, view, options.row, state, options.translate);
    titleLayout.schedule();
    rebuildRenderer();
    showLoading(loadingPhase);
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    setLoading: showLoading,
    replaceView(nextView) {
      if (disposed) return;
      view = nextView;
      renderHeader(options.page, view, options.row, state, options.translate);
      rebuildRenderer();
      showLoading(null);
      titleLayout.schedule();
    },
    updateState(nextState) {
      if (disposed) return;
      const languageChanged = nextState.language !== state.language;
      const themeChanged = nextState.theme !== state.theme;
      state = nextState;
      renderHeader(options.page, view, options.row, state, options.translate);
      titleLayout.schedule();
      if (languageChanged) rebuildRenderer();
      else if (themeChanged) { renderer.setTheme(state.theme); renderBranches(); watchVisible(); applySearch(); }
      if (loadingPhase) showLoading(loadingPhase);
    },
    cleanup
  };
}

export function visualConversationFixture(state, requestedSession = defaultReaderSession, titleCase = null) {
  const session = cloneSession(requestedSession);
  const user = state.language === "en" ? "User" : "采云用户";
  const assistant = "ChatGPT";
  const middleTitle = state.language === "en" ? "Cloudig - A conversation title extends beyond the text column while remaining centered" : "这一条标题超出正文宽度后向两侧舒展并且继续保持水平居中对齐";
  const fixtureTitle = titleCase === "short" ? (state.language === "en" ? "Short Title" : "短标题") : titleCase === "medium" ? middleTitle : titleCase === "long" ? Array(4).fill(middleTitle).join(" · ") : "2026-07-14 GPT-5.6-Sol·奥思·绯缎缠骨 Osis.CrimsonSilkBind";
  const platformSamples = [
    ["ChatGPT", "#D68C80", "chatgpt"], ["Claude", "#CCAA93", "claude"], ["Gemini", "#82B7D8", "gemini"], ["Grok", "#818181", "grok"],
    ["DeepSeek", "#8AB4B6", "deepseek"], ["豆包", "#DB8AB7", "doubao"], ["Qwen", "#AE9BDD", "qwen"], ["ChatGLM", "#86A5EA", "chatglm"],
    ["元宝", "#B5BA80", "yuanbao"], ["Z.ai", "#99B5A4", "zai"], ["Kimi", "#E5B477", "kimi"], ["Mistral", "#ED9569", "mistral"]
  ];
  const introHtml = state.language === "en"
    ? "<div class=\"cloudig-visual-fixture-intro\">Cloudig currently supports ChatGPT, DeepSeek, Claude, Gemini, Grok, Doubao, Kimi, Qwen, ChatGLM, Z.ai, Yuanbao and Mistral.<br>These twelve platforms will be maintained over time. Cloudig can also import Claude.ai conversations.json exports for local reading and search.<br>Future versions may support JSON from Codex, Cline, Silly Tavern and Claude Code.<br>Tell us if there is another platform you want Cloudig to support.</div>"
    : "<div class=\"cloudig-visual-fixture-intro\">采云当前支持：ChatGPT、DeepSeek、Claude、Gemini、Grok、豆包、Kimi、Qwen、智谱清言、Z.ai、腾讯元宝、Mistral。<br>这12个平台采云会长期维护。采云也支持一次导入Claude.ai平台导出的conversations.json数据，以便阅读和查询。<br>未来采云还会支持Codex、Cline、Silly Tavern、Claude Code等一系列harness的json文件。<br>如果你有其他平台希望采云支持，联系我们吧！</div>";
  const platformRow = (offset) => ({
    category: "content",
    value: {
      type: "html",
      html: `<div class="cloudig-visual-fixture-platform-row">${platformSamples.slice(offset, offset + 4).map(([name, color, slug]) => `<span class="cloudig-visual-fixture-platform-${slug}">${name} ${color}</span>`).join("")}</div>`
    }
  });
  const blocks = [
    { anchor: "message-2-process-1", category: "reasoning", collapsed: !session.expanded.reasoning, value: { type: "reasoning_summary", title: state.language === "en" ? "Reasoning" : "思考", text: state.language === "en" ? "A bounded visible thought." : "一段有边界的可见思考。", format: "text", duration: 29 } },
    { anchor: "message-2-process-2", category: "tool", collapsed: !session.expanded.tools, value: { type: "tool", kind: "call", name: "bio", title: state.language === "en" ? "Tool · bio" : "工具调用 · bio", input: { value: "fixture" } } },
    { anchor: "message-2-process-3", category: "content", value: { type: "markdown", text: state.language === "en" ? "## Evaluation framework\n\nCloudig keeps **visible content** readable and offline." : "## 评估项目架构\n\n采云让**页面可见内容**在离线状态下仍然清晰可读。" } },
    { anchor: "message-2-process-4", category: "references", collapsed: !session.expanded.references, value: { type: "citations", label: state.language === "en" ? "References" : "参考来源" }, sources: [{ id: "s1", kind: "web", title: "Cloudig", url: "https://example.com/cloudig" }] }
  ].filter((block) => !(block.category === "reasoning" && session.hidden.reasoning) && !(block.category === "tool" && session.hidden.tools));
  const navigationItems = [
    ...(session.navigation.user ? platformSamples.map(([name, color], index) => ({ anchor: `message-${2 + Math.floor(index / 4)}`, kind: "user", source_index: 1 + Math.floor(index / 4), text: `${name} ${color}` })) : []),
    ...(session.navigation.assistant ? [{ anchor: "message-5", kind: "assistant", source_index: 4, text: state.language === "en" ? "Evaluation framework" : "评估项目架构" }] : []),
    ...(session.navigation.process ? [
      { anchor: "message-2-process-1", kind: "process", source_index: 4, block_index: 0, text: state.language === "en" ? "Reasoning" : "思考" },
      { anchor: "message-2-process-2", kind: "process", source_index: 4, block_index: 1, text: state.language === "en" ? "Tool · bio" : "工具调用 · bio" }
    ] : []),
    ...(session.navigation.assistant ? [{ anchor: "message-2-process-4", kind: "assistant", source_index: 4, block_index: 3, text: state.language === "en" ? "My first impression: this…" : "我的第一感觉是：这……" }] : [])
  ];
  return {
    schema: "cloudig/conversation-view/1.0.0",
    archive: "a1",
    header: {
      title: fixtureTitle,
      provider: "openai",
      platform: "chatgpt",
      models: titleCase === "models" ? Array.from({ length: 12 }, (_, index) => `Model-${index + 1}-Thinking`) : ["GPT-5.6-Sol"],
      content_time: { state: "unavailable" },
      captured_at: { basis: "manifest", value: "2026-07-21T10:10:00.000Z", field: "captured_at" },
      source_file: "fixture.html"
    },
    pagination: { offset: 0, limit: 200, returned: 5, total_visible: 5, total_canonical: 100, has_previous: false, has_next: false },
    messages: [
      { anchor: "message-1", source_index: 0, party: { role: "user", name: user, avatar: "Assets/Defaults/user.svg" }, timestamp: "2026-07-14T10:10:00.000Z", blocks: [{ category: "content", value: { type: "html", html: introHtml } }] },
      { anchor: "message-2", source_index: 1, party: { role: "user", name: user, avatar: "Assets/Defaults/user.svg" }, timestamp: "2026-07-14T10:10:20.000Z", blocks: [platformRow(0)] },
      { anchor: "message-3", source_index: 2, party: { role: "user", name: user, avatar: "Assets/Defaults/user.svg" }, timestamp: "2026-07-14T10:10:40.000Z", blocks: [platformRow(4)] },
      { anchor: "message-4", source_index: 3, party: { role: "user", name: user, avatar: "Assets/Defaults/user.svg" }, timestamp: "2026-07-14T10:11:00.000Z", blocks: [platformRow(8)] },
      { anchor: "message-5", source_index: 4, party: { role: "assistant", name: assistant, avatar: "Assets/Platforms/chatgpt.svg" }, model: "GPT-5.6-Sol", timestamp: "2026-07-14T10:12:00.000Z", blocks: [...blocks, { category: "content", value: { type: "math", tex: "\\sqrt{\\frac{x^2+1}{y}}", display: true } }] }
    ],
    navigation: {
      offset: 0,
      limit: 500,
      returned: navigationItems.length,
      total: navigationItems.length,
      has_previous: false,
      has_next: false,
      items: navigationItems
    },
    branch: { tree: false, path_length: 5, leaves: { offset: 0, limit: 200, returned: 0, total: 0, has_previous: false, has_next: false, items: [] } }
  };
}
