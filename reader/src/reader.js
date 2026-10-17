(function startAiChatArchiveReader() {
  "use strict";

  const core = globalThis.OsisReaderCore;
  if (!core) throw new Error("OsisReaderCore 未加载。");
  const libraryCore = globalThis.CloudigLibraryCore;
  if (!libraryCore) throw new Error("CloudigLibraryCore 未加载。");
  const i18n = globalThis.CloudigReaderI18n;
  if (!i18n) throw new Error("CloudigReaderI18n 未加载。");
  const readerCover = globalThis.CloudigReaderCover;
  if (!readerCover) throw new Error("CloudigReaderCover 未加载。");

  const VERSION = core.READER_VERSION;
  const NAME_RULE_VERSION = 1;
  const THEME_SWITCH_GUIDE_VERSION = 1;
  const THEME_SWITCH_GUIDE_KEY = "cloudig.onboarding.themeSwitchUsedVersion";
  const GENERATED_BODY_BLOCK_TYPES = new Set([
    "markdown", "text", "code", "math", "image", "attachment", "diagram", "html", "unknown"
  ]);
  const REASONING_BLOCK_TYPES = new Set(["reasoning", "reasoning_summary"]);
  const PROCESS_BLOCK_TYPES = new Set(["reasoning", "reasoning_summary", "status", "search", "citations", "tool"]);
  const DISCLOSURE_PREFERENCES_KEY = "cloudig-reader-disclosure-preferences-v1";
  const DIRECTORY_PICKER_ID = "ai-chat-archive-default";
  const DIRECTORY_DATABASE = "ai-chat-archive-reader";
  const DIRECTORY_STORE = "preferences";
  const DIRECTORY_HANDLE_KEY = "default-directory";
  const DIRECTORY_LABEL_KEY = "ai-chat-archive-reader-directory-label";
  const EMBEDDED_LIBRARY = Object.freeze(Array.isArray(globalThis.__AI_CHAT_ARCHIVE_EMBEDDED_LIBRARY__)
    ? globalThis.__AI_CHAT_ARCHIVE_EMBEDDED_LIBRARY__ : []);
  const READER_BUILD_MODE = String(globalThis.__CLOUDIG_READER_BUILD_MODE__ || "portable");
  const READER_ASSETS = Object.freeze(globalThis.__CLOUDIG_READER_ASSETS__ || {});
  const EMBEDDED_ASSETS = new Map(EMBEDDED_LIBRARY
    .filter((entry) => entry?.kind === "asset" && entry.relative_path && entry.data_url)
    .map((entry) => [String(entry.relative_path).replaceAll("\\", "/").toLowerCase(), String(entry.data_url)]));
  const EMBEDDED_JSON_COUNT = EMBEDDED_LIBRARY.filter((entry) => entry?.kind !== "asset").length;
  const EMBEDDED_CONVERSATION_COUNT = EMBEDDED_LIBRARY.filter((entry) => entry?.kind === "conversation").length;
  const DESKTOP_READER = globalThis.location?.protocol === "https:"
    && globalThis.location?.hostname === "reader.cloudig.local"
    && Boolean(globalThis.chrome?.webview);
  const DESKTOP_CATALOG_READER = DESKTOP_READER && READER_BUILD_MODE === "desktop_catalog";
  const desktopPendingRequests = new Map();
  let desktopRequestSequence = 0;
  let conversationLoadSequence = 0;
  let readingGeometryFrame = 0;
  let waypointScrollFrame = 0;
  let readingGeometryObserver = null;
  let tooltipController = null;
  let docsController = null;
  let docsReturnFocus = null;
  const MAX_DIRECTORY_DEPTH = 32;
  const MAX_DIRECTORY_JSON_FILES = 20000;

  function afterCloudigPaint() {
    if (globalThis.__CLOUDIG_NATIVE_TRANSITION__ === true) {
      return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    return new Promise((resolve) => {
      const schedule = typeof globalThis.requestAnimationFrame === "function"
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback) => globalThis.setTimeout(callback, 0);
      schedule(() => schedule(resolve));
    });
  }

  function cloudigImageReady(image) {
    if (image.complete) {
      return typeof image.decode === "function" ? image.decode().catch(() => {}) : Promise.resolve();
    }
    return new Promise((resolve) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    });
  }

  async function revealCloudigPage() {
    const visibleImages = [...document.images].filter((image) => (
      !image.closest(".cloudig-boot-screen")
        && image.loading !== "lazy"
        && image.getClientRects().length > 0
    ));
    const fontsReady = document.fonts?.ready
      ? Promise.resolve(document.fonts.ready).catch(() => {})
      : Promise.resolve();
    await Promise.race([
      Promise.all([fontsReady, ...visibleImages.map(cloudigImageReady)]),
      new Promise((resolve) => globalThis.setTimeout(resolve, 1500))
    ]);
    await afterCloudigPaint();
    document.documentElement.dataset.cloudigReady = "true";
    byId("cloudig-boot-screen")?.setAttribute("aria-hidden", "true");
  }

  async function navigateWithCloudigBoot(url) {
    if (DESKTOP_READER && globalThis.__CLOUDIG_NATIVE_TRANSITION__ === true) {
      const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      const duration = reduced ? 0 : 140;
      document.body.style.transition = duration ? "opacity 140ms ease-in" : "none";
      document.body.style.opacity = "0";
      if (duration) await new Promise((resolve) => globalThis.setTimeout(resolve, duration));
      globalThis.location.assign(url);
      return;
    }
    byId("cloudig-boot-screen")?.removeAttribute("aria-hidden");
    document.documentElement.dataset.cloudigReady = "false";
    await afterCloudigPaint();
    globalThis.location.assign(url);
  }
  const PLATFORM_COLORS = Object.freeze({
    chatgpt: "#a52525", claude: "#d26f32", gemini: "#4285f4", grok: "#282828",
    deepseek: "#4d6bfe", doubao: "#d64f86", qwen: "#7e5eff", chatglm: "#367bd3",
    zai: "#5b5b5b", yuanbao: "#318a68", kimi: "#171717", mistral: "#f26b38"
  });
  const PLATFORM_BUBBLES_LIGHT = Object.freeze({
    chatgpt: "#d68c80", claude: "#ccaa93", gemini: "#82b7d8", grok: "#818181",
    deepseek: "#8ab4b6", doubao: "#db8ab7", qwen: "#ae9bdd", chatglm: "#86a5ea",
    yuanbao: "#b5ba80", zai: "#99b5a4", kimi: "#e5b477", mistral: "#ed9569"
  });
  const PLATFORM_BUBBLES_DARK = Object.freeze({
    chatgpt: "#625977", claude: "#665041", gemini: "#364e66", grok: "#111111",
    deepseek: "#26517f", doubao: "#9b4b93", qwen: "#434575", chatglm: "#25355b",
    yuanbao: "#586d4a", zai: "#346d62", kimi: "#a06c47", mistral: "#9e4c28"
  });
  const PLATFORM_ASSET_KEYS = Object.freeze({
    chatgpt: "platform.chatgpt", claude: "platform.claude", gemini: "platform.gemini",
    grok: "platform.grok", deepseek: "platform.deepseek", doubao: "platform.doubao",
    qwen: "platform.qwen", chatglm: "platform.chatglm", yuanbao: "platform.yuanbao",
    zai: "platform.zai", kimi: "platform.kimi", mistral: "platform.mistral"
  });
  const PLATFORM_ORDER = Object.freeze([
    "chatgpt", "claude", "gemini", "grok", "mistral", "zai",
    "deepseek", "doubao", "qwen", "kimi", "yuanbao", "chatglm"
  ]);
  const IDENTITY_PLATFORM_ORDER = Object.freeze([
    "chatgpt", "claude", "gemini", "grok", "qwen", "chatglm",
    "yuanbao", "zai", "deepseek", "kimi", "doubao", "mistral"
  ]);
  const ROLE_COLORS = Object.freeze({
    user: "#9a633c", assistant: "#176b5b", system: "#58616c", developer: "#6a55a1", tool: "#2f7194", other: "#777b73"
  });
  const SAFE_HTML_TAGS = new Set([
    "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote",
    "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details",
    "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2",
    "h3", "h4", "h5", "h6", "header", "hr", "i", "kbd", "label", "li", "main", "mark",
    "nav", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section",
    "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
    "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr"
  ]);
  const RICH_STYLE_PROPERTIES = new Set([
    "align-items", "background-color", "border", "border-bottom", "border-bottom-color",
    "border-bottom-style", "border-bottom-width", "border-collapse", "border-color",
    "border-left", "border-left-color", "border-left-style", "border-left-width",
    "border-radius", "border-right", "border-right-color", "border-right-style",
    "border-right-width", "border-spacing", "border-style", "border-top",
    "border-top-color", "border-top-style", "border-top-width", "border-width",
    "box-sizing", "color", "display", "font-family", "font-size", "font-style", "font-variant",
    "font-weight", "height", "justify-content", "letter-spacing", "line-height", "list-style-position",
    "list-style-type", "margin", "margin-bottom", "margin-left", "margin-right",
    "margin-top", "max-height", "max-width", "min-height", "min-width", "padding",
    "padding-bottom", "padding-left", "padding-right", "padding-top", "tab-size",
    "text-align", "text-decoration", "text-indent", "text-transform", "vertical-align",
    "white-space", "width", "word-break", "word-spacing", "word-wrap", "overflow-wrap"
  ]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_TAG_CASE = Object.freeze({
    clippath: "clipPath", lineargradient: "linearGradient", radialgradient: "radialGradient",
    textpath: "textPath", foreignobject: "foreignObject"
  });
  const SAFE_SVG_TAGS = new Set([
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "textpath", "defs", "marker", "clippath", "mask", "pattern",
    "lineargradient", "radialgradient", "mesh", "meshgradient", "meshrow", "meshpatch",
    "solidcolor", "hatch", "hatchpath", "stop", "title", "desc", "metadata", "switch",
    "view", "foreignobject", "use", "symbol", "image",
    "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix",
    "fecomponenttransfer", "fefunca", "fefuncr", "fefuncg", "fefuncb", "femerge",
    "femergenode", "feflood", "fecomposite", "fedropshadow", "femorphology",
    "feturbulence", "fedisplacementmap", "feimage", "fediffuselighting",
    "fespecularlighting", "fedistantlight", "fepointlight", "fespotlight", "fetile",
    "feconvolvematrix"
  ]);
  const SAFE_SVG_ATTRS = new Set([
    "id", "class", "role", "aria-label", "aria-roledescription", "data-osis-static-diagram", "xmlns", "viewbox",
    "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "d", "points",
    "transform", "preserveaspectratio", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
    "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "font-family", "font-size", "font-style", "font-weight",
    "text-anchor", "dominant-baseline", "alignment-baseline", "dx", "dy", "offset", "stop-color", "stop-opacity",
    "marker-start", "marker-mid", "marker-end", "clip-path", "mask", "filter", "refx", "refy", "markerwidth", "markerheight",
    "orient", "gradientunits", "gradienttransform", "spreadmethod", "pathlength", "href", "open"
  ]);
  const SAFE_MATHML_TAGS = new Set([
    "math", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace", "mphantom", "mpadded", "mstyle", "merror",
    "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtable", "mtr", "mlabeledtr", "mtd", "mover", "munder",
    "munderover", "mmultiscripts", "mprescripts", "none", "menclose", "semantics", "annotation"
  ]);
  const SAFE_MATHML_ATTRS = new Set([
    "display", "mathvariant", "mathsize", "mathcolor", "mathbackground", "stretchy", "symmetric", "fence", "separator",
    "form", "accent", "accentunder", "linethickness", "bevelled", "notation", "rowspan", "columnspan", "columnalign",
    "rowalign", "frame", "columnlines", "rowlines", "scriptlevel", "displaystyle", "encoding", "width", "height", "depth"
  ]);
  const STATIC_KATEX_LABELS = new Set([
    "cloudig-static-katex-inline",
    "cloudig-static-katex-display"
  ]);
  const STATIC_KATEX_STYLE_PROPERTIES = new Set([
    "height", "margin-right", "top", "vertical-align", "margin-left", "position",
    "padding-left", "min-width", "width", "border-right-width", "border-top-width",
    "bottom", "color", "border-bottom-width", "border-style", "border-width"
  ]);
  const STATIC_KATEX_SVG_ATTRS = Object.freeze({
    svg: new Set(["xmlns", "width", "height", "viewbox", "preserveaspectratio"]),
    path: new Set(["d", "fill", "fill-rule"])
  });
  const STATIC_KATEX_SVG_NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const STATIC_KATEX_VIEWBOX = new RegExp(
    `^${STATIC_KATEX_SVG_NUMBER}(?:[\\s,]+${STATIC_KATEX_SVG_NUMBER}){3}$`,
    "u"
  );
  const STATIC_KATEX_PATH_DATA = /^[\s,.\d+\-MmZzLlHhVvCcSsQqTtAaEe]+$/u;

  const state = {
    entries: [], activeEntry: null, resources: new Map(), sources: new Map(), markdown: null,
    groups: [],
    libraryQuery: "", messageQuery: "", platforms: new Set(PLATFORM_ORDER), sort: "oldest", theme: "light", language: i18n.DEFAULT_LANGUAGE,
    themeSwitchUsedVersion: loadThemeSwitchUsedVersion(), themeCoachmarkDismissed: false, themeCoachmarkTimer: 0,
    messageMatches: [], activeMessageMatch: -1, waypointIndex: 0, waypointKey: "",
    branchModel: null, branchPath: [], branchPathSet: new Set(), branchSelection: new Map(),
    library: null, libraryFile: null, libraryRootPrefix: "", libraryPersistence: "none", librarySha256: "",
    defaultDirectoryHandle: null, defaultDirectoryLabel: "", defaultDirectoryPersistence: "none",
    directoryRestored: false, directoryRevision: 0, nameRuleScanDone: false,
    directorySelection: new Set(), directoryDraftSelection: new Set(), directoryPanelOpen: false,
    archiveRevision: "", archiveDirectories: [], archiveFiles: [],
    directoryManagerMode: "", directoryManagerName: "", directoryManagerRevision: "",
    directoryManagerDeleteArmed: false, directoryManagerMoveEntryId: "",
    embeddedLibraryPending: EMBEDDED_CONVERSATION_COUNT > 0 || DESKTOP_CATALOG_READER,
    identityDraft: null, identityDraftAssets: new Map(), identityMode: "global",
    conversationEditDraft: null,
    compatibilityIssues: []
  };
  let canvasRenderSequence = 0;
  const dom = Object.create(null);
  const byId = (id) => document.getElementById(id);
  const t = (key, variables = {}) => i18n.translate(state.language, key, variables);

  function loadThemeSwitchUsedVersion() {
    try {
      const value = Number.parseInt(localStorage.getItem(THEME_SWITCH_GUIDE_KEY) || "0", 10);
      return Number.isInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function identityPlatformLabel(platform) {
    const key = `identity.platforms.${platform}`;
    const translated = t(key);
    return translated === key ? platform : translated;
  }

  function identityPlatformNames() {
    return Object.fromEntries(
      IDENTITY_PLATFORM_ORDER.map((platform) => [platform, identityPlatformLabel(platform)])
    );
  }

  function initialLanguage() {
    try {
      const stored = localStorage.getItem("cloudig-reader-language");
      if (i18n.languages.includes(stored)) return stored;
    } catch { /* file mode may deny storage */ }
    return String(globalThis.navigator?.language || "").toLowerCase().startsWith("en") ? "en" : i18n.DEFAULT_LANGUAGE;
  }

  function applyStaticTranslations() {
    document.title = t("page.title");
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
    for (const node of document.querySelectorAll("[data-i18n-aria-label]")) node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
    for (const node of document.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
    for (const node of document.querySelectorAll("[data-i18n-alt]")) node.alt = t(node.dataset.i18nAlt);
    tooltipController?.refresh();
    if (dom.toggleLanguage) dom.toggleLanguage.textContent = state.language === "en" ? "简体中文" : "ENGLISH";
    if (dom.returnManager) dom.returnManager.textContent = state.language === "en" ? "Archiver" : "管理档案";
    if (dom.welcomeManager) dom.welcomeManager.textContent = state.language === "en" ? "Capture & Parse" : "采集与解析";
    if (dom.returnCover) dom.returnCover.textContent = state.language === "en" ? "Reader Cover" : "返回封面";
    if (dom.saveMarkdown) dom.saveMarkdown.textContent = state.language === "en" ? "Export Markdown" : "导出 Markdown";
    if (dom.saveJson) dom.saveJson.textContent = state.language === "en" ? "Open JSON File" : "打开 JSON 文件";
    if (dom.editConversation) dom.editConversation.textContent = state.language === "en" ? "Edit" : "编辑";
    if (dom.profileEditDialog?.open && state.identityDraft) renderIdentityEditor();
    if (!dom.readerThemeCoachmark?.hidden) globalThis.setTimeout(positionThemeCoachmark, 0);
    updateCompatibilityBanner();
    if (dom.compatibilityDialog?.open) renderCompatibilityNotice();
  }

  function setLanguage(locale, { remember = true, rerender = true } = {}) {
    state.language = i18n.language(locale);
    document.documentElement.lang = state.language;
    applyStaticTranslations();
    applyProjectBrand(state.library);
    if (remember) {
      try { localStorage.setItem("cloudig-reader-language", state.language); }
      catch { /* file mode may deny storage */ }
    }
    if (rerender) {
      updatePlatformFilterLabel();
      renderLibrary();
      updateDefaultDirectoryUi();
      if (state.activeEntry) renderConversation(state.activeEntry);
      else showReaderCover();
    }
    refreshReaderCover();
    docsController?.setLocale(state.language);
    return state.language;
  }

  function openCloudigDocs(topic = "bookmark", trigger = document.activeElement) {
    const docsRuntime = globalThis.CloudigDocs;
    const docsData = globalThis.__CLOUDIG_DOCS_DATA__;
    if (!docsRuntime || !docsData) {
      toast(state.language === "en" ? "The offline guide is unavailable." : "离线功能文档不可用。", true);
      return;
    }
    try {
      docsController ||= docsRuntime.mount({
        host: dom.cloudigDocsHost,
        data: docsData,
        locale: state.language,
        version: "V1.0.0-dev",
        initialTopic: topic
      });
      docsController.setLocale(state.language);
      docsController.select(topic);
      docsReturnFocus = trigger instanceof HTMLElement ? trigger : null;
      if (!dom.cloudigDocsDialog.open) dom.cloudigDocsDialog.showModal();
      globalThis.setTimeout(() => dom.cloudigDocsHost.querySelector(`button[data-docs-topic="${docsController.selectedTopic()}"]`)?.focus({ preventScroll: true }), 0);
    } catch (error) {
      toast(error?.message || String(error), true, 7000);
    }
  }

  function closeCloudigDocs() {
    if (dom.cloudigDocsDialog?.open) dom.cloudigDocsDialog.close();
  }

  function restoreCloudigDocsFocus() {
    const target = docsReturnFocus;
    docsReturnFocus = null;
    if (target?.isConnected && !target.disabled) globalThis.setTimeout(() => target.focus({ preventScroll: true }), 0);
  }

  function desktopBridge(command, payload = {}) {
    if (!DESKTOP_READER) return Promise.reject(new Error("Cloudig desktop bridge is unavailable"));
    desktopRequestSequence += 1;
    const id = `reader-${Date.now()}-${desktopRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        desktopPendingRequests.delete(id);
        reject(new Error("采云窗口等待本地写入超时，请返回管理页后重新打开 Reader。"));
      }, 2 * 60 * 1000);
      desktopPendingRequests.set(id, { resolve, reject, timeout });
      globalThis.chrome.webview.postMessage({ id, command, payload });
    });
  }

  function receiveDesktopBridgeMessage(event) {
    const message = event.data;
    if (!message || typeof message !== "object" || !message.id) return;
    const pending = desktopPendingRequests.get(message.id);
    if (!pending) return;
    globalThis.clearTimeout(pending.timeout);
    desktopPendingRequests.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message || "采云本地写入失败。");
      error.code = String(message.error?.code || "native_command_failed");
      error.kind = String(message.error?.kind || "");
      error.retryable = Boolean(message.error?.retryable);
      pending.reject(error);
    }
  }

  if (DESKTOP_READER) globalThis.chrome.webview.addEventListener("message", receiveDesktopBridgeMessage);

  function makeElement(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = String(text);
    return node;
  }

  function readerAsset(key) {
    return String(READER_ASSETS[key] || "");
  }

  function platformAsset(platform) {
    return readerAsset(PLATFORM_ASSET_KEYS[String(platform || "").toLowerCase()]);
  }

  function assistantAvatarAsset(platform) {
    return String(platform || "").toLowerCase() === "doubao"
      ? readerAsset("avatar.doubao")
      : platformAsset(platform);
  }

  function identityPlatformAvatars() {
    return Object.fromEntries(PLATFORM_ORDER.map((platform) => [platform, assistantAvatarAsset(platform)]));
  }

  function coverIdentity() {
    const defaults = state.language === "en"
      ? { user: "User", assistant: "AI" }
      : { user: "采云用户", assistant: "智能伙伴" };
    const userAvatar = libraryCore.cleanString(state.library?.user?.avatar);
    const assistantAvatar = libraryCore.cleanString(state.library?.assistant?.avatar);
    return Object.freeze({
      userName: libraryCore.cleanString(state.library?.user?.display_name) || defaults.user,
      assistantName: libraryCore.cleanString(state.library?.assistant?.display_name) || defaults.assistant,
      userAvatar: identityAvatarUrl(userAvatar, readerAsset("cover.OsisLogo-Cloudig-1024.png")),
      assistantAvatar: identityAvatarUrl(assistantAvatar, readerAsset("cover.OsisLogo-Simple.svg")),
      userAvatarCustom: Boolean(userAvatar),
      assistantAvatarCustom: Boolean(assistantAvatar)
    });
  }

  function refreshReaderCover() {
    if (!dom.defaultDirectoryLabel) return;
    readerCover.update({
      language: state.language,
      path: dom.defaultDirectoryLabel.textContent,
      ...coverIdentity()
    });
  }

  function identityForDocument(documentData = state.activeEntry?.document || {}) {
    return libraryCore.resolveConversationIdentity(documentData, state.library, {
      language: state.language,
      platformNames: identityPlatformNames(),
      platformAvatars: identityPlatformAvatars(),
      defaultUserAvatar: readerAsset("cover.OsisLogo-Cloudig-1024.png"),
      defaultAssistantAvatar: readerAsset("cover.OsisLogo-Simple.svg")
    });
  }

  function identityAvatarUrl(value, fallback = "") {
    const source = libraryCore.cleanString(value);
    if (!source) return fallback;
    if (/^(?:data|blob):/iu.test(source)) return source;
    return EMBEDDED_ASSETS.get(source.replaceAll("\\", "/").toLowerCase()) || fallback;
  }

  function platformIcon(platform, className = "") {
    const image = makeElement("img", className);
    const normalizedPlatform = String(platform || "").toLowerCase();
    const source = assistantAvatarAsset(normalizedPlatform);
    image.dataset.platform = normalizedPlatform || "unknown";
    image.dataset.generic = source ? "false" : "true";
    image.src = source || readerAsset("brand.seal");
    image.alt = source ? platformLabel({ platform: normalizedPlatform }) : t("catalog.compatibility.generic_icon");
    image.loading = "lazy";
    return image;
  }

  function applyReaderAssets() {
    for (const image of document.querySelectorAll("img[data-reader-asset]")) {
      const value = readerAsset(image.dataset.readerAsset);
      if (value) image.src = value;
    }
    const dawnPattern = readerAsset("cover.ToolBar-Pattern-Dawn.svg");
    const nightPattern = readerAsset("cover.ToolBar-Pattern-StarNight.svg");
    if (dawnPattern) document.documentElement.style.setProperty("--rc-toolbar-pattern-dawn", `url("${dawnPattern}")`);
    if (nightPattern) document.documentElement.style.setProperty("--rc-toolbar-pattern-night", `url("${nightPattern}")`);
  }

  function addTemmlCss() {
    if (typeof globalThis.osisTemmlCss !== "string") return;
    const style = document.createElement("style");
    style.dataset.osisVendor = "temml-0.13.3";
    style.textContent = globalThis.osisTemmlCss;
    document.head.append(style);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function findUnescaped(source, marker, start) {
    for (let index = start; index <= source.length - marker.length; index += 1) {
      if (!source.startsWith(marker, index)) continue;
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) return index;
    }
    return -1;
  }

  function countUnescaped(source, marker) {
    let count = 0;
    let cursor = 0;
    while (cursor < source.length) {
      const found = findUnescaped(source, marker, cursor);
      if (found < 0) break;
      count += 1;
      cursor = found + marker.length;
    }
    return count;
  }

  function hasOpenInlineMathBefore(blockState, startLine) {
    const lines = [];
    for (let line = startLine - 1; line >= 0; line -= 1) {
      const value = blockState.src.slice(blockState.bMarks[line] + blockState.tShift[line], blockState.eMarks[line]);
      if (!value.trim() && lines.length) break;
      lines.unshift(value);
    }
    const paragraph = lines.join("\n");
    return countUnescaped(paragraph, "\\(") > countUnescaped(paragraph, "\\)");
  }

  function installMathRules(md) {
    md.inline.ruler.before("escape", "osis_math_inline", (inlineState, silent) => {
      const source = inlineState.src;
      const start = inlineState.pos;
      let open = "";
      let close = "";
      if (source.startsWith("\\(", start)) {
        open = "\\("; close = "\\)";
      } else if (source[start] === "$" && source[start + 1] !== "$" && !/\s/u.test(source[start + 1] || "")) {
        open = "$"; close = "$";
      } else return false;
      const end = findUnescaped(source, close, start + open.length);
      if (end < 0 || (close === "$" && /\s/u.test(source[end - 1] || ""))) return false;
      if (!silent) {
        const token = inlineState.push("osis_math_inline", "math", 0);
        token.content = source.slice(start + open.length, end);
        token.markup = open;
      }
      inlineState.pos = end + close.length;
      return true;
    });

    md.block.ruler.before("fence", "osis_math_block", (blockState, startLine, endLine, silent) => {
      const start = blockState.bMarks[startLine] + blockState.tShift[startLine];
      const max = blockState.eMarks[startLine];
      const first = blockState.src.slice(start, max).trim();
      let open = "";
      let close = "";
      let environment = "";
      if (first.startsWith("$$")) { open = "$$"; close = "$$"; }
      else if (first.startsWith("\\[")) { open = "\\["; close = "\\]"; }
      else {
        const match = first.match(/^\\begin\{([A-Za-z*]+)\}/u);
        if (!match) return false;
        if (hasOpenInlineMathBefore(blockState, startLine)) return false;
        environment = match[1];
        close = `\\end{${environment}}`;
      }
      if (silent) return true;
      let nextLine = startLine;
      let content = "";
      if (environment) {
        const lines = [];
        for (; nextLine < endLine; nextLine += 1) {
          const line = blockState.src.slice(blockState.bMarks[nextLine] + blockState.tShift[nextLine], blockState.eMarks[nextLine]);
          lines.push(line);
          if (line.includes(close)) { nextLine += 1; break; }
        }
        if (!lines.at(-1)?.includes(close)) return false;
        content = lines.join("\n");
      } else {
        const firstBody = first.slice(open.length);
        const sameEnd = findUnescaped(firstBody, close, 0);
        if (sameEnd >= 0) {
          content = firstBody.slice(0, sameEnd);
          nextLine = startLine + 1;
        } else {
          const lines = [firstBody];
          for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
            const line = blockState.src.slice(blockState.bMarks[nextLine] + blockState.tShift[nextLine], blockState.eMarks[nextLine]);
            const end = findUnescaped(line, close, 0);
            if (end >= 0) {
              lines.push(line.slice(0, end));
              nextLine += 1;
              break;
            }
            lines.push(line);
          }
          if (nextLine > endLine || !blockState.src.slice(blockState.bMarks[nextLine - 1], blockState.eMarks[nextLine - 1]).includes(close)) return false;
          content = lines.join("\n");
        }
      }
      const token = blockState.push("osis_math_block", "math", 0);
      token.block = true;
      token.content = content.trim();
      token.map = [startLine, nextLine];
      blockState.line = nextLine;
      return true;
    }, { alt: ["paragraph", "reference", "blockquote", "list"] });

    md.renderer.rules.osis_math_inline = (tokens, index) => renderTemmlHtml(tokens[index].content, false);
    md.renderer.rules.osis_math_block = (tokens, index) => `${renderTemmlHtml(tokens[index].content, true)}\n`;
  }

  function installTaskListRule(md) {
    md.core.ruler.after("inline", "osis_task_list", (tokenState) => {
      for (let index = 2; index < tokenState.tokens.length; index += 1) {
        const token = tokenState.tokens[index];
        if (token.type !== "inline" || tokenState.tokens[index - 1]?.type !== "paragraph_open" || tokenState.tokens[index - 2]?.type !== "list_item_open") continue;
        const first = token.children?.[0];
        const match = first?.type === "text" ? first.content.match(/^\[([ xX])\]\s+/u) : null;
        if (!match) continue;
        first.content = first.content.slice(match[0].length);
        const checkbox = new tokenState.Token("osis_checkbox", "input", 0);
        checkbox.meta = { checked: match[1].toLowerCase() === "x" };
        token.children.unshift(checkbox);
      }
    });
    md.renderer.rules.osis_checkbox = (tokens, index) => `<input class="task-checkbox" type="checkbox" disabled${tokens[index].meta?.checked ? " checked" : ""} aria-label="${escapeHtml(t("markdown.task_item"))}">`;
  }

  function createMarkdownRenderer() {
    if (typeof globalThis.markdownit !== "function") throw new Error("markdown-it 未加载。");
    const md = globalThis.markdownit({ html: false, linkify: true, breaks: false, typographer: false });
    md.validateLink = (url) => url.startsWith("#") || Boolean(core.safeExternalUrl(url));
    md.renderer.rules.link_open = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const hrefIndex = token.attrIndex("href");
      const raw = hrefIndex >= 0 ? token.attrs[hrefIndex][1] : "";
      const safe = raw.startsWith("#") ? raw : core.safeExternalUrl(raw);
      if (!safe) {
        if (hrefIndex >= 0) token.attrs[hrefIndex][1] = "#";
        token.attrJoin("class", "unsafe-link");
      } else if (!safe.startsWith("#")) {
        token.attrs[hrefIndex][1] = safe;
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noopener noreferrer nofollow");
        token.attrSet("referrerpolicy", "no-referrer");
      }
      return self.renderToken(tokens, index, options);
    };
    md.renderer.rules.image = (tokens, index) => {
      const token = tokens[index];
      const url = token.attrGet("src") || "";
      const alt = token.content || token.attrGet("alt") || t("markdown.image");
      return `<span class="md-image-placeholder" title="${escapeHtml(t("markdown.external_image"))}">▧ ${escapeHtml(alt)} · ${escapeHtml(url)}</span>`;
    };
    md.renderer.rules.fence = (tokens, index) => {
      const token = tokens[index];
      const language = (token.info || "").trim().split(/\s+/u)[0];
      return codeCardHtml(token.content, language, "");
    };
    md.renderer.rules.code_block = (tokens, index) => codeCardHtml(tokens[index].content, "", "");
    installMathRules(md);
    installTaskListRule(md);
    return md;
  }

  function codeCardHtml(code, language, filename) {
    const title = filename || language || t("markdown.code");
    return `<div class="code-card"><div class="code-head"><strong>${escapeHtml(title)}</strong>${language && filename ? `<span>${escapeHtml(language)}</span>` : ""}<button class="copy-code" type="button">${escapeHtml(t("action.copy"))}</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
  }

  function normalizeTemmlSource(value) {
    let source = String(value || "").trim();
    source = source.replace(/\\begin\{array\}\{([^}]*)\}/gu, (_whole, alignment) => {
      return `\\begin{array}{${alignment.replaceAll("\\|", "|")}}`;
    });
    if (source.startsWith("\\begin{") && source.endsWith("\\)")) source = source.slice(0, -2).trimEnd();
    return source;
  }

  function renderTemmlPrimitive(tex, display) {
    try {
      if (typeof globalThis.osisRenderTemmlHtml !== "function") throw new Error("Temml runtime missing");
      return globalThis.osisRenderTemmlHtml(normalizeTemmlSource(tex), display, {
        repairNestedFrames: true, repairTaggedFrames: true, repairTextFrames: true
      });
    } catch (error) {
      return `<code class="math-error" title="${escapeHtml(error.message)}">${escapeHtml(tex)}</code>`;
    }
  }

  function renderLatexPlainText(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    return source.split(/\n{2,}/u).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
  }

  function renderMixedLatexText(value) {
    const source = String(value || "");
    const markers = [
      { open: "\\[", close: "\\]", display: true },
      { open: "\\(", close: "\\)", display: false },
      { open: "$$", close: "$$", display: true },
      { open: "$", close: "$", display: false }
    ];
    let cursor = 0;
    let output = "";
    while (cursor < source.length) {
      let selected = null;
      let selectedAt = source.length;
      for (const marker of markers) {
        const at = findUnescaped(source, marker.open, cursor);
        if (at < 0 || at >= selectedAt) continue;
        if (marker.open === "$" && source[at + 1] === "$") continue;
        selected = marker;
        selectedAt = at;
      }
      if (!selected) {
        output += renderLatexPlainText(source.slice(cursor));
        break;
      }
      output += renderLatexPlainText(source.slice(cursor, selectedAt));
      const contentStart = selectedAt + selected.open.length;
      const end = findUnescaped(source, selected.close, contentStart);
      if (end < 0) {
        output += renderLatexPlainText(source.slice(selectedAt));
        break;
      }
      output += renderTemmlPrimitive(source.slice(contentStart, end), selected.display);
      cursor = end + selected.close.length;
    }
    return output;
  }

  function renderDocumentLatex(value) {
    const source = String(value || "").trim();
    const match = source.match(/^\\begin\{(theorem|lemma|proof|corollary|proposition|definition|remark|example|quote)\}(?:\[([^\]]*)\])?\s*([\s\S]*?)\\end\{\1\}\s*$/u);
    if (!match) return "";
    const labels = Object.fromEntries([
      "theorem", "lemma", "proof", "corollary", "proposition", "definition", "remark", "example", "quote"
    ].map((kind) => [kind, t(`writing.${kind}`)]));
    const [, environment, title, body] = match;
    const heading = [labels[environment] || environment, title].filter(Boolean).join(" · ");
    return `<section class="latex-document-frame latex-${escapeHtml(environment)}"><header>${escapeHtml(heading)}</header><div class="latex-document-body">${renderMixedLatexText(body)}</div></section>`;
  }

  function renderTemmlHtml(tex, display) {
    return renderDocumentLatex(tex) || renderTemmlPrimitive(tex, display);
  }

  function renderMarkdown(value) {
    const node = makeElement("div", "prose markdown");
    node.innerHTML = state.markdown.render(String(value || ""));
    return node;
  }

  function staticClassTokens(value, maximum = 128) {
    const result = [];
    const seen = new Set();
    for (const token of String(value || "").split(/\s+/u)) {
      if (!token || token.length > 128 || /[\u0000-\u001f"'<>=`]/u.test(token) || seen.has(token)) continue;
      seen.add(token);
      result.push(token);
      if (result.length >= maximum) break;
    }
    return result;
  }

  function safeRichStyle(value) {
    const declarations = [];
    for (const raw of String(value || "").split(";")) {
      const separator = raw.indexOf(":");
      if (separator < 1) continue;
      const property = raw.slice(0, separator).trim().toLowerCase();
      const styleValue = raw.slice(separator + 1).trim();
      if (!RICH_STYLE_PROPERTIES.has(property) || !styleValue || styleValue.length > 256) continue;
      if (/[\u0000-\u001f<>]/u.test(styleValue)) continue;
      if (/(?:url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding)/iu.test(styleValue)) continue;
      declarations.push(`${property}:${styleValue}`);
    }
    return declarations.join(";");
  }

  function copyStaticRichAttributes(node, output) {
    const classes = staticClassTokens(node.getAttribute("class"));
    if (classes.length) output.className = classes.join(" ");
    const style = safeRichStyle(node.getAttribute("style"));
    if (style) output.setAttribute("style", style);
    for (const name of [
      "title", "aria-label", "role", "lang", "dir",
      "data-cloudig-source-class", "data-cloudig-original-tag", "data-cloudig-attribute",
      "data-cloudig-source-href"
    ]) {
      const value = String(node.getAttribute(name) || "").trim();
      if (value && value.length <= 1024 && !/[\u0000-\u001f<>]/u.test(value)) output.setAttribute(name, value);
    }
    const id = String(node.getAttribute("id") || "").trim();
    if (/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(id)) output.id = id;
    for (const attribute of node.attributes || []) {
      const name = String(attribute.name || "").toLowerCase();
      const value = String(attribute.value || "").trim();
      if (
        output.hasAttribute(name)
        || !/^data-[a-z0-9_.:-]{1,122}$/u.test(name)
        || !value
        || value.length > 8192
        || /[\u0000-\u001f<>]/u.test(value)
      ) {
        continue;
      }
      output.setAttribute(name, value);
    }
  }

  function cloneSafeHtmlNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const tag = node.localName.toLowerCase();
    if (["script", "style", "template", "iframe", "object", "embed", "link", "meta", "base", "noscript"].includes(tag)) {
      return document.createDocumentFragment();
    }
    if (tag === "svg") return cloneSafeSvgNode(node);
    if (tag === "math") return cloneSafeMathNode(node);
    if (node.classList.contains("osis-katex-shell")) {
      const display = node.classList.contains("osis-math-display");
      const wrapper = makeElement(display ? "div" : "span", `static-katex-render ${display ? "is-display" : "is-inline"}`);
      wrapper.append(cloneStaticKatexNode(node));
      return wrapper;
    }
    const fragment = document.createDocumentFragment();
    if (!SAFE_HTML_TAGS.has(tag)) {
      const output = document.createElement("span");
      output.className = "cloudig-unknown-element";
      output.dataset.cloudigOriginalTag = tag;
      for (const child of node.childNodes) output.append(cloneSafeHtmlNode(child));
      return output;
    }
    const output = document.createElement(tag);
    copyStaticRichAttributes(node, output);
    if (["td", "th"].includes(tag)) {
      for (const name of ["rowspan", "colspan"]) {
        const value = node.getAttribute(name);
        if (/^[1-9]\d{0,2}$/u.test(value || "")) output.setAttribute(name, value);
      }
    }
    if (tag === "ol" && /^\d{1,6}$/u.test(node.getAttribute("start") || "")) output.setAttribute("start", node.getAttribute("start"));
    if (tag === "li" && /^-?\d{1,6}$/u.test(node.getAttribute("value") || "")) output.setAttribute("value", node.getAttribute("value"));
    if (tag === "col" && /^[1-9]\d{0,2}$/u.test(node.getAttribute("span") || "")) output.setAttribute("span", node.getAttribute("span"));
    if (tag === "details" && node.hasAttribute("open")) output.open = true;
    if (tag === "time") {
      const datetime = String(node.getAttribute("datetime") || "").trim();
      if (datetime && datetime.length <= 128 && !/[\u0000-\u001f"'<>]/u.test(datetime)) output.dateTime = datetime;
    }
    if (tag === "a") {
      const href = core.safeExternalUrl(node.getAttribute("href"));
      if (href) {
        output.href = href; output.target = "_blank"; output.rel = "noopener noreferrer nofollow";
        output.referrerPolicy = "no-referrer";
      }
    }
    for (const child of node.childNodes) output.append(cloneSafeHtmlNode(child));
    return output;
  }

  function renderSafeHtml(value) {
    const wrapper = makeElement("div", "prose safe-html");
    const parsed = new DOMParser().parseFromString(String(value || ""), "text/html");
    for (const child of parsed.body.childNodes) wrapper.append(cloneSafeHtmlNode(child));
    return wrapper;
  }

  function cssTopLevelRules(value) {
    const source = String(value || "");
    const rules = [];
    let cursor = 0;
    const skipComment = (index) => {
      const end = source.indexOf("*/", index + 2);
      return end < 0 ? source.length : end + 2;
    };
    while (cursor < source.length) {
      while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
      if (source.startsWith("/*", cursor)) {
        cursor = skipComment(cursor);
        continue;
      }
      if (cursor >= source.length) break;
      const preludeStart = cursor;
      let quote = "";
      let opening = -1;
      while (cursor < source.length) {
        if (source.startsWith("/*", cursor) && !quote) {
          cursor = skipComment(cursor);
          continue;
        }
        const character = source[cursor];
        if (quote) {
          if (character === "\\") cursor += 2;
          else {
            if (character === quote) quote = "";
            cursor += 1;
          }
          continue;
        }
        if (character === "'" || character === "\"") {
          quote = character;
          cursor += 1;
          continue;
        }
        if (character === "{") {
          opening = cursor;
          break;
        }
        if (character === ";") {
          rules.push({ prelude: source.slice(preludeStart, cursor).trim(), body: null });
          cursor += 1;
          opening = -1;
          break;
        }
        cursor += 1;
      }
      if (opening < 0) {
        if (cursor >= source.length) break;
        continue;
      }
      const prelude = source.slice(preludeStart, opening).trim();
      cursor = opening + 1;
      const bodyStart = cursor;
      let depth = 1;
      quote = "";
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor) && !quote) {
          cursor = skipComment(cursor);
          continue;
        }
        const character = source[cursor];
        if (quote) {
          if (character === "\\") cursor += 2;
          else {
            if (character === quote) quote = "";
            cursor += 1;
          }
          continue;
        }
        if (character === "'" || character === "\"") quote = character;
        else if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        cursor += 1;
      }
      if (depth !== 0) break;
      rules.push({ prelude, body: source.slice(bodyStart, cursor - 1) });
    }
    return rules;
  }

  function splitCssSelectors(value) {
    const selectors = [];
    let cursor = 0;
    let start = 0;
    let quote = "";
    let squareDepth = 0;
    let roundDepth = 0;
    while (cursor < value.length) {
      const character = value[cursor];
      if (quote) {
        if (character === "\\") cursor += 2;
        else {
          if (character === quote) quote = "";
          cursor += 1;
        }
        continue;
      }
      if (character === "'" || character === "\"") quote = character;
      else if (character === "[") squareDepth += 1;
      else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
      else if (character === "(") roundDepth += 1;
      else if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
      else if (character === "," && squareDepth === 0 && roundDepth === 0) {
        selectors.push(value.slice(start, cursor).trim());
        start = cursor + 1;
      }
      cursor += 1;
    }
    selectors.push(value.slice(start).trim());
    return selectors.filter(Boolean);
  }

  function replaceCssIdentifiers(value, replacements) {
    let result = String(value || "");
    for (const [source, target] of replacements) {
      const escaped = source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      result = result.replace(new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "gu"), `$1${target}`);
    }
    return result;
  }

  function scopeCanvasCssRules(value, scopeSelector, suffix, inheritedKeyframes = new Map()) {
    const rules = cssTopLevelRules(value);
    const keyframes = new Map(inheritedKeyframes);
    for (const rule of rules) {
      const match = /^@(?:-webkit-)?keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)$/iu.exec(rule.prelude);
      if (match && !keyframes.has(match[1])) {
        keyframes.set(match[1], `${match[1]}-${suffix}-${keyframes.size + 1}`);
      }
    }
    const output = [];
    for (const rule of rules) {
      if (!rule.prelude || rule.body === null) continue;
      const keyframe = /^(@(?:-webkit-)?keyframes)\s+([A-Za-z_][A-Za-z0-9_-]*)$/iu.exec(rule.prelude);
      if (keyframe) {
        output.push(`${keyframe[1]} ${keyframes.get(keyframe[2]) || keyframe[2]}{${rule.body}}`);
        continue;
      }
      if (/^@(?:media|supports|container|layer)\b/iu.test(rule.prelude)) {
        output.push(`${rule.prelude}{${scopeCanvasCssRules(rule.body, scopeSelector, suffix, keyframes)}}`);
        continue;
      }
      if (rule.prelude.startsWith("@")) continue;
      const selectors = splitCssSelectors(rule.prelude).map((selector) => {
        const rooted = selector.replace(/^(?::root|html|body)(?=\b|\s|[.:[#>+~])/iu, scopeSelector);
        return rooted.startsWith(scopeSelector) ? rooted : `${scopeSelector} ${rooted}`;
      });
      if (!selectors.length) continue;
      output.push(`${selectors.join(",")}{${replaceCssIdentifiers(rule.body, keyframes)}}`);
    }
    return output.join("\n");
  }

  function scopeCanvasCss(value, scopeSelector, suffix) {
    const source = String(value || "");
    if (!source.trim() || source.length > 200000) return "";
    if (/@import\b|expression\s*\(|(?:javascript|vbscript)\s*:|behavior\s*:|-moz-binding/iu.test(source)) return "";
    for (const match of source.matchAll(/url\s*\(([^)]*)\)/giu)) {
      const target = String(match[1] || "").trim().replace(/^(['"])([\s\S]*)\1$/u, "$2");
      if (!/^#[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(target)) return "";
    }
    return scopeCanvasCssRules(source, scopeSelector, suffix);
  }

  function clearCanvasStyles() {
    for (const style of document.head.querySelectorAll("style[data-cloudig-canvas-style]")) style.remove();
  }

  function renderCanvasHtml(value) {
    const wrapper = makeElement("div", "prose safe-html canvas-html");
    const scopeToken = `canvas-${++canvasRenderSequence}`;
    const scopeSelector = `[data-cloudig-canvas-scope="${scopeToken}"]`;
    wrapper.dataset.cloudigCanvasScope = scopeToken;
    const parsed = new DOMParser().parseFromString(String(value || ""), "text/html");
    [...parsed.querySelectorAll("style")].forEach((sourceStyle, index) => {
      const css = scopeCanvasCss(sourceStyle.textContent, scopeSelector, `${scopeToken}-${index + 1}`);
      if (!css) return;
      const style = document.createElement("style");
      style.dataset.cloudigCanvasStyle = scopeToken;
      style.textContent = css;
      document.head.append(style);
    });
    for (const child of parsed.body.childNodes) wrapper.append(cloneSafeHtmlNode(child));
    return wrapper;
  }

  function safeStaticKatexStyle(value) {
    const declarations = [];
    for (const raw of String(value || "").split(";")) {
      const separator = raw.indexOf(":");
      if (separator < 1) continue;
      const property = raw.slice(0, separator).trim().toLowerCase();
      const styleValue = raw.slice(separator + 1).trim();
      if (!STATIC_KATEX_STYLE_PROPERTIES.has(property)) continue;
      if (!/^(?:-?\d*\.?\d+(?:em|px|%)?|relative|currentColor|red|green|solid)$/u.test(styleValue)) continue;
      declarations.push(`${property}:${styleValue}`);
    }
    return declarations.join(";");
  }

  function safeStaticKatexSvgAttribute(tag, name, value) {
    const lowerName = String(name || "").toLowerCase();
    const raw = String(value || "").trim();
    if (!STATIC_KATEX_SVG_ATTRS[tag]?.has(lowerName) || !raw) return null;
    if (lowerName === "xmlns") {
      return raw === SVG_NS ? ["xmlns", raw] : null;
    }
    if (lowerName === "width" || lowerName === "height") {
      return new RegExp(`^${STATIC_KATEX_SVG_NUMBER}(?:em|ex|px|%)?$`, "u").test(raw)
        ? [lowerName, raw]
        : null;
    }
    if (lowerName === "viewbox") {
      return STATIC_KATEX_VIEWBOX.test(raw) ? ["viewBox", raw] : null;
    }
    if (lowerName === "preserveaspectratio") {
      return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/u.test(raw)
        ? ["preserveAspectRatio", raw]
        : null;
    }
    if (lowerName === "d") {
      return STATIC_KATEX_PATH_DATA.test(raw) ? ["d", raw] : null;
    }
    if (lowerName === "fill") {
      return /^(?:currentColor|none|#[0-9a-f]{3,8})$/iu.test(raw) ? ["fill", raw] : null;
    }
    if (lowerName === "fill-rule") {
      return /^(?:evenodd|nonzero)$/u.test(raw) ? ["fill-rule", raw] : null;
    }
    return null;
  }

  function cloneStaticKatexSvgNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const tag = node.localName.toLowerCase();
    if (!["svg", "path"].includes(tag)) return document.createDocumentFragment();
    const output = document.createElementNS(SVG_NS, tag);
    for (const attribute of node.attributes) {
      const safe = safeStaticKatexSvgAttribute(tag, attribute.name, attribute.value);
      if (safe) output.setAttribute(safe[0], safe[1]);
    }
    if (tag === "path" && !output.hasAttribute("d")) return document.createDocumentFragment();
    if (tag === "svg") {
      for (const child of node.childNodes) output.append(cloneStaticKatexSvgNode(child));
    }
    return output;
  }

  function cloneStaticKatexNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const tag = node.localName.toLowerCase();
    if (tag === "svg") return cloneStaticKatexSvgNode(node);
    const fragment = document.createDocumentFragment();
    if (!["span", "div", "br"].includes(tag)) {
      for (const child of node.childNodes) fragment.append(cloneStaticKatexNode(child));
      return fragment;
    }
    const output = document.createElement(tag);
    const classes = staticClassTokens(node.getAttribute("class"));
    if (classes.length) output.className = classes.join(" ");
    const style = safeStaticKatexStyle(node.getAttribute("style"));
    if (style) output.setAttribute("style", style);
    for (const name of ["aria-hidden", "aria-label", "role"]) {
      const value = String(node.getAttribute(name) || "").trim();
      if (value) output.setAttribute(name, value);
    }
    for (const child of node.childNodes) output.append(cloneStaticKatexNode(child));
    return output;
  }

  function renderStaticKatex(value, display) {
    const wrapper = makeElement("div", `static-katex-render ${display ? "is-display" : "is-inline"}`);
    const parsed = new DOMParser().parseFromString(String(value || ""), "text/html");
    const root = parsed.body.querySelector(".osis-katex-shell");
    if (root) wrapper.append(cloneStaticKatexNode(root));
    else wrapper.append(makeElement("span", "math-error", t("fallback.invalid_mathml")));
    return wrapper;
  }

  function svgValueUsesOnlyLocalUrls(value) {
    const remainder = String(value || "").replace(
      /url\s*\(\s*(?:"#[^"]+"|'#[^']+'|#[^)"'\s]+)\s*\)/giu,
      ""
    );
    return !/url\s*\(/iu.test(remainder);
  }

  function safeSvgStyle(value) {
    const declarations = [];
    for (const raw of String(value || "").split(";")) {
      const separator = raw.indexOf(":");
      if (separator < 1) continue;
      const property = raw.slice(0, separator).trim().toLowerCase();
      const styleValue = raw.slice(separator + 1).trim();
      if (!property || !styleValue || property.length > 64 || styleValue.length > 512) continue;
      if (/[\u0000-\u001f<>]/u.test(styleValue)) continue;
      if (/(?:javascript\s*:|vbscript\s*:|expression\s*\(|@import|behavior\s*:|-moz-binding)/iu.test(styleValue)) continue;
      if (!svgValueUsesOnlyLocalUrls(styleValue)) continue;
      declarations.push(`${property}:${styleValue}`);
    }
    return declarations.join(";");
  }

  function safeSvgAttribute(tag, name, value) {
    const lower = String(name || "").toLowerCase();
    const text = String(value || "").trim();
    if (!text || lower.startsWith("on") || ["src", "srcdoc", "action", "formaction"].includes(lower)) return null;
    if (!/^[a-z_:][a-z0-9_.:-]{0,127}$/iu.test(name)) return null;
    if (/[\u0000-\u001f<>]/u.test(text)) return null;
    if (lower.startsWith("data-")) {
      return text.length <= 8192 ? [lower, text] : null;
    }
    if (lower === "style") {
      const style = safeSvgStyle(text);
      return style ? [name, style] : null;
    }
    if (lower === "class") {
      const classes = staticClassTokens(text).join(" ");
      return classes ? ["class", classes] : null;
    }
    if (lower === "data-cloudig-source-href") {
      const source = core.safeExternalUrl(text);
      return source ? [lower, source] : null;
    }
    if (["href", "xlink:href"].includes(lower)) {
      if (/^#[^\s"'<>]+$/u.test(text)) return [name, text];
      if (
        ["image", "feimage"].includes(tag)
        && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/iu.test(text)
      ) {
        return [name, text];
      }
      return null;
    }
    if (/(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|(?:https?:)?\/\//iu.test(text)) return null;
    if (!svgValueUsesOnlyLocalUrls(text)) return null;
    return [name, text];
  }

  function cloneSafeForeignHtml(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const tag = node.localName.toLowerCase();
    if (["script", "style", "template", "link", "meta"].includes(tag)) return document.createDocumentFragment();
    const outputTag = SAFE_HTML_TAGS.has(tag) ? tag : "span";
    const output = document.createElementNS(XHTML_NS, outputTag);
    if (outputTag !== tag) {
      output.setAttribute("class", "cloudig-unknown-element");
      output.setAttribute("data-cloudig-original-tag", tag);
    }
    copyStaticRichAttributes(node, output);
    for (const child of node.childNodes) output.append(cloneSafeForeignHtml(child));
    return output;
  }

  function cloneSafeSvgNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const lower = node.localName.toLowerCase();
    if (["script", "style", "template", "link", "meta", "iframe", "object", "embed", "audio", "video"].includes(lower)) {
      return document.createDocumentFragment();
    }
    if (["a", "animate", "animatecolor", "animatemotion", "animatetransform", "discard", "mpath", "set"].includes(lower)) {
      const neutral = document.createElementNS(SVG_NS, "g");
      neutral.setAttribute("class", "cloudig-inert-element");
      neutral.setAttribute("data-cloudig-original-tag", lower);
      for (const child of node.childNodes) neutral.append(cloneSafeSvgNode(child));
      return neutral;
    }
    if (!SAFE_SVG_TAGS.has(lower)) {
      const neutral = document.createElementNS(SVG_NS, "g");
      neutral.setAttribute("class", "cloudig-unknown-element");
      neutral.setAttribute("data-cloudig-original-tag", lower);
      for (const child of node.childNodes) neutral.append(cloneSafeSvgNode(child));
      return neutral;
    }
    const output = document.createElementNS(SVG_NS, node.localName || SVG_TAG_CASE[lower] || lower);
    for (const attribute of node.attributes) {
      const safe = safeSvgAttribute(lower, attribute.name, attribute.value);
      if (!safe) continue;
      output.setAttribute(safe[0], safe[1]);
    }
    if (["image", "feimage"].includes(lower) && !output.hasAttribute("href") && !output.hasAttribute("xlink:href")) {
      const neutral = document.createElementNS(SVG_NS, "g");
      neutral.setAttribute("class", "cloudig-inert-element");
      neutral.setAttribute("data-cloudig-original-tag", lower);
      const source = String(
        node.getAttribute("data-cloudig-source-href")
        || node.getAttribute("href")
        || node.getAttribute("xlink:href")
        || ""
      ).trim();
      if (source) neutral.setAttribute("data-cloudig-source-href", source.slice(0, 4096));
      for (const child of node.childNodes) neutral.append(cloneSafeSvgNode(child));
      return neutral;
    }
    if (lower === "foreignobject") {
      for (const child of node.childNodes) output.append(cloneSafeForeignHtml(child));
    } else {
      for (const child of node.childNodes) output.append(cloneSafeSvgNode(child));
    }
    return output;
  }

  function renderSafeSvg(value) {
    const wrapper = makeElement("div", "diagram-card");
    const parsed = new DOMParser().parseFromString(String(value || ""), "image/svg+xml");
    if (parsed.querySelector("parsererror") || parsed.documentElement.localName.toLowerCase() !== "svg") {
      wrapper.append(makeElement("pre", "diagram-source", String(value || "")));
      return wrapper;
    }
    wrapper.append(cloneSafeSvgNode(parsed.documentElement));
    return wrapper;
  }

  function cloneSafeMathNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const lower = node.localName.toLowerCase();
    const fragment = document.createDocumentFragment();
    if (!SAFE_MATHML_TAGS.has(lower)) {
      for (const child of node.childNodes) fragment.append(cloneSafeMathNode(child));
      return fragment;
    }
    const output = document.createElementNS("http://www.w3.org/1998/Math/MathML", lower);
    for (const attribute of node.attributes) {
      if (SAFE_MATHML_ATTRS.has(attribute.name.toLowerCase()) && !/url\s*\(|javascript:/iu.test(attribute.value)) output.setAttribute(attribute.name, attribute.value);
    }
    for (const child of node.childNodes) output.append(cloneSafeMathNode(child));
    return output;
  }

  function renderMathBlock(block) {
    const wrapper = makeElement("div", "content-block content-math");
    if (block.tex) {
      wrapper.innerHTML = renderTemmlHtml(block.tex, block.display !== false);
      return wrapper;
    }
    const parsed = new DOMParser().parseFromString(String(block.mathml || ""), "application/xml");
    if (!parsed.querySelector("parsererror") && parsed.documentElement.localName.toLowerCase() === "math") {
      wrapper.append(cloneSafeMathNode(parsed.documentElement));
    } else wrapper.append(makeElement("code", "math-error", block.mathml || t("fallback.invalid_mathml")));
    return wrapper;
  }

  function formattedBlockBody(block) {
    if (block.markdown) return renderMarkdown(block.markdown);
    if (block.text) {
      const text = makeElement("div", "prose", block.text);
      text.style.whiteSpace = "pre-wrap";
      return text;
    }
    if (block.html) return renderSafeHtml(block.html);
    return null;
  }

  function blockWrapper(type) {
    const wrapper = makeElement("div", `content-block content-${type}`);
    wrapper.dataset.blockType = type;
    return wrapper;
  }

  function renderReasoning(block) {
    const wrapper = blockWrapper(block.type);
    wrapper.classList.add("reasoning-block");
    const details = makeElement("details", "reasoning-card");
    details.dataset.reasoning = block.type;
    details.__cloudigSearchText = core.normalizeText(core.collectBlockText(block));
    const summary = document.createElement("summary");
    summary.append(makeElement("span", "", block.title || t(`block.${block.type}`)));
    const meta = [core.formatDuration(block.duration_seconds), block.effort].filter(Boolean).join(" · ");
    if (meta) summary.append(makeElement("span", "reasoning-meta", meta));
    const body = makeElement("div", "reasoning-body");
    const content = formattedBlockBody(block);
    if (content) body.append(content);
    else body.append(makeElement("div", "prose", t("fallback.no_public_body")));
    details.append(summary, body);
    wrapper.append(details);
    return wrapper;
  }

  function renderReasoningCollection(blocks) {
    const wrapper = blockWrapper("reasoning");
    wrapper.classList.add("reasoning-block", "reasoning-collection");
    const details = makeElement("details", "reasoning-card");
    details.dataset.reasoning = "reasoning";
    details.__cloudigSearchText = core.normalizeText(blocks.map(core.collectBlockText).join("\n"));
    const summary = document.createElement("summary");
    summary.append(makeElement("span", "", t("block.reasoning")));
    const duration = blocks.map((block) => block.duration_seconds).findLast((value) => Number(value) > 0);
    const effort = blocks.map((block) => block.effort).findLast((value) => core.cleanString(value));
    const meta = [core.formatDuration(duration), effort].filter(Boolean).join(" · ");
    if (meta) summary.append(makeElement("span", "reasoning-meta", meta));
    const body = makeElement("div", "reasoning-body");
    let rendered = 0;
    for (const block of blocks.filter((candidate) => REASONING_BLOCK_TYPES.has(candidate?.type))) {
      const content = formattedBlockBody(block);
      const title = core.cleanString(block.title);
      if (!content && !title) continue;
      const segment = makeElement("section", "reasoning-segment");
      if (title && core.normalizeText(title) !== core.normalizeText(t("block.reasoning"))) {
        segment.append(makeElement("strong", "reasoning-segment-title", title));
      }
      if (content) segment.append(content);
      body.append(segment);
      rendered += 1;
    }
    if (!rendered) body.append(makeElement("div", "prose", t("fallback.no_public_body")));
    details.append(summary, body);
    wrapper.append(details);
    return wrapper;
  }

  function renderStatus(block) {
    const wrapper = blockWrapper("status");
    wrapper.dataset.statusKind = isReasoningStatus(block) ? "reasoning" : "status";
    const card = makeElement("div", "status-card");
    card.append(makeElement("span", "status-dot"), makeElement("strong", "", block.title || t("block.status")));
    if (block.text) card.append(makeElement("span", "", block.text));
    const duration = core.formatDuration(block.duration_seconds);
    if (duration) card.append(makeElement("span", "", duration));
    wrapper.append(card);
    if (block.markdown || block.html) wrapper.append(formattedBlockBody(block));
    return wrapper;
  }

  function makeExternalAnchor(url, label) {
    const safe = core.safeExternalUrl(url);
    if (!safe) return makeElement("span", "", label || url || t("fallback.no_address"));
    const link = makeElement("a", "", label || safe);
    link.href = safe; link.target = "_blank"; link.rel = "noopener noreferrer nofollow"; link.referrerPolicy = "no-referrer";
    return link;
  }

  function resourceMeta(resource) {
    return [resource?.mime_type, core.formatBytes(resource?.size_bytes), resource?.availability].filter(Boolean).join(" · ");
  }

  function renderResourceCard(resource, fallbackId, kind = "attachment") {
    const card = makeElement("div", "resource-card");
    card.append(makeElement("span", "resource-icon", kind === "image" ? "▧" : "▤"));
    const copy = makeElement("div", "resource-copy");
    copy.append(makeElement("strong", "", resource?.name || fallbackId || t("fallback.unnamed_resource")));
    const meta = resourceMeta(resource);
    if (meta) copy.append(makeElement("span", "", meta));
    if (resource?.url) copy.append(makeExternalAnchor(resource.url, resource.url));
    card.append(copy, makeElement("span", "resource-state", resource?.availability || "missing"));
    return card;
  }

  function renderImage(block) {
    const wrapper = blockWrapper("image");
    const resource = state.resources.get(block.resource_id);
    const dataUrl = core.safeEmbeddedImage(resource);
    if (!dataUrl) {
      wrapper.append(renderResourceCard(resource, block.resource_id, "image"));
      return wrapper;
    }
    const figure = makeElement("figure", "image-card");
    const button = makeElement("button", "image-button");
    button.type = "button";
    const alt = block.alt || resource.name || t("fallback.archive_image");
    const image = document.createElement("img");
    image.src = dataUrl; image.alt = alt; image.loading = "lazy"; image.decoding = "async";
    if (Number.isFinite(resource.width)) image.width = resource.width;
    if (Number.isFinite(resource.height)) image.height = resource.height;
    button.append(image);
    button.addEventListener("click", () => openImage(dataUrl, alt, block.caption || resource.name || ""));
    figure.append(button);
    const caption = [block.caption, resource.name, resourceMeta(resource)].filter(Boolean).join(" · ");
    if (caption) figure.append(makeElement("figcaption", "", caption));
    wrapper.append(figure);
    return wrapper;
  }

  function renderAttachment(block) {
    const resource = state.resources.get(block.resource_id);
    if (resource?.kind === "image" && core.safeEmbeddedImage(resource)) {
      return renderImage({ type: "image", resource_id: block.resource_id, purpose: "uploaded", alt: resource.name });
    }
    const wrapper = blockWrapper("attachment");
    wrapper.append(renderResourceCard(resource, block.resource_id, "attachment"));
    if (block.text) {
      const details = makeElement("details", "attachment-extracted");
      details.append(makeElement("summary", "", t("attachment.extracted")));
      const body = makeElement("div", "attachment-extracted-body", block.text);
      details.append(body);
      wrapper.append(details);
    }
    return wrapper;
  }

  function sourceChip(sourceId) {
    const source = state.sources.get(sourceId);
    const label = source?.title || source?.site_name || sourceId;
    const safe = core.safeExternalUrl(source?.url);
    const node = makeElement(safe ? "a" : "span");
    if (safe) {
      node.href = safe; node.target = "_blank"; node.rel = "noopener noreferrer nofollow"; node.referrerPolicy = "no-referrer";
    }
    node.className = "citation-chip";
    node.append(makeElement("b", "", "↗"), makeElement("span", "", label));
    if (source?.snippet) node.title = source.snippet;
    return node;
  }

  function activityStatus(block) {
    const raw = String(block.status || "").trim();
    const normalized = raw.toLowerCase();
    const known = {
      complete: "status.complete",
      completed: "status.complete",
      success: "status.success",
      succeeded: "status.success",
      failed: "status.failed",
      failure: "status.failed",
      error: "status.failed",
      running: "status.running",
      pending: "status.pending",
      cancelled: "status.cancelled",
      canceled: "status.cancelled"
    };
    if (raw) return known[normalized] ? t(known[normalized]) : raw;
    if (block.success === true) return t("status.success");
    if (block.success === false) return t("status.failed");
    return "";
  }

  function activityHeading(block, type) {
    if (type === "search") return [t("block.search"), block.query || ""];
    if (type === "citations") return [block.label || t("block.citations"), ""];
    return [t("block.tool"), block.title || block.name || `${block.kind || t("role.tool")}`];
  }

  function renderActivitySummary(block, type, expandable) {
    const summary = makeElement(expandable ? "summary" : "div", "activity-summary");
    summary.append(makeElement("span", "activity-icon", type === "search" ? "⌕" : type === "citations" ? "↗" : "◇"));
    const copy = makeElement("span", "activity-summary-copy");
    const [heading, preview] = activityHeading(block, type);
    copy.append(makeElement("strong", "activity-title", heading));
    if (preview && preview !== heading) copy.append(makeElement("span", "activity-preview", preview));
    summary.append(copy);
    const sourceCount = Array.isArray(block.source_ids) ? block.source_ids.length : 0;
    const meta = [
      activityStatus(block),
      core.formatDuration(block.duration_seconds),
      sourceCount ? t("meta.source_count", { count: sourceCount }) : ""
    ].filter(Boolean).join(" · ");
    if (meta) summary.append(makeElement("span", "activity-meta", meta));
    return summary;
  }

  function hasActivityBody(block, type) {
    if (block.markdown || block.text || block.html) return true;
    return ["search", "citations"].includes(type) && Array.isArray(block.source_ids) && block.source_ids.length > 0;
  }

  function populateActivityBody(body, block, type) {
    if (type === "search" && block.query) {
      const query = makeElement("div", "activity-query");
      query.append(makeElement("span", "", t("block.query")), makeElement("strong", "", block.query));
      body.append(query);
    }
    const content = formattedBlockBody(block);
    if (content) body.append(content);
    if (["search", "citations"].includes(type) && block.source_ids?.length) {
      const chips = makeElement("div", "citation-strip");
      for (const id of block.source_ids) chips.append(sourceChip(id));
      body.append(chips);
    }
  }

  function renderActivity(block, type) {
    const wrapper = blockWrapper(type);
    wrapper.classList.add("activity-block");
    wrapper.dataset.activityType = type;
    const className = `${type === "search" ? "search-card" : type === "citations" ? "citation-card" : "tool-card"} activity-card`;
    if (!hasActivityBody(block, type)) {
      const card = makeElement("div", `${className} activity-static`);
      card.append(renderActivitySummary(block, type, false));
      wrapper.append(card);
      return wrapper;
    }
    const card = makeElement("details", className);
    card.dataset.activity = type;
    card.dataset.rendered = "false";
    card.__cloudigSearchText = core.normalizeText(core.collectBlockText(block));
    card.append(renderActivitySummary(block, type, true));
    const body = makeElement("div", "activity-body");
    const renderBody = () => {
      if (card.dataset.rendered === "true") return;
      populateActivityBody(body, block, type);
      card.dataset.rendered = "true";
    };
    card.__cloudigRenderBody = renderBody;
    card.addEventListener("toggle", () => { if (card.open) renderBody(); });
    card.append(body);
    wrapper.append(card);
    return wrapper;
  }

  function renderCitations(block) {
    return renderActivity(block, "citations");
  }

  function renderSchedule(block) {
    const wrapper = blockWrapper("schedule");
    wrapper.classList.add("schedule-block");
    const content = formattedBlockBody(block);
    if (content) wrapper.append(content);
    else wrapper.append(makeElement("div", "prose", block.title || t("block.tool")));
    return wrapper;
  }

  function renderWritingBlock(block) {
    const card = makeElement("section", "writing-block-card");
    const bar = makeElement("header", "writing-block-bar");
    bar.append(
      makeElement("span", "writing-block-label", t("block.writing_block")),
      makeElement("span", "writing-block-kind", "document")
    );
    const body = makeElement("div", "writing-block-body");
    if (block.source) body.append(renderMarkdown(block.source));
    else if (block.html) body.append(renderSafeHtml(block.html));
    else body.append(makeElement("div", "prose", t("fallback.missing_diagram", { format: block.format })));
    card.append(bar, body);
    return card;
  }

  function renderDiagram(block) {
    const wrapper = blockWrapper("diagram");
    if (block.format === "writing_block") {
      wrapper.append(renderWritingBlock(block));
      return wrapper;
    }
    if (block.title) wrapper.append(makeElement("div", "block-label", `${block.format} · ${block.title}`));
    if (block.svg) wrapper.append(renderSafeSvg(block.svg));
    else if (block.resource_id) wrapper.append(renderImage({ type: "image", resource_id: block.resource_id, purpose: "diagram", alt: block.title }));
    else if (block.html) wrapper.append(block.format === "canvas" ? renderCanvasHtml(block.html) : renderSafeHtml(block.html));
    else {
      const card = makeElement("div", "diagram-card");
      card.append(makeElement("pre", "diagram-source", block.source || t("fallback.missing_diagram", { format: block.format })));
      wrapper.append(card);
    }
    return wrapper;
  }

  function renderUnknown(block) {
    const wrapper = blockWrapper("unknown");
    const card = makeElement("div", "unknown-card");
    card.append(makeElement("strong", "", t("fallback.unknown_component", { label: block.label })));
    if (block.text) {
      const text = makeElement("div", "", block.text); text.style.whiteSpace = "pre-wrap"; card.append(text);
    }
    if (block.html) card.append(renderSafeHtml(block.html));
    wrapper.append(card);
    return wrapper;
  }

  function renderContentBlock(block) {
    if (block.type === "markdown") {
      const wrapper = blockWrapper("markdown"); wrapper.append(renderMarkdown(block.text)); return wrapper;
    }
    if (block.type === "text") {
      const wrapper = blockWrapper("text"); const text = makeElement("div", "prose", block.text); text.style.whiteSpace = "pre-wrap"; wrapper.append(text); return wrapper;
    }
    if (["reasoning", "reasoning_summary"].includes(block.type)) return renderReasoning(block);
    if (block.type === "status") return renderStatus(block);
    if (block.type === "code") {
      const wrapper = blockWrapper("code"); wrapper.innerHTML = codeCardHtml(block.code, block.language || "", block.filename || ""); return wrapper;
    }
    if (block.type === "math") return renderMathBlock(block);
    if (block.type === "image") return renderImage(block);
    if (block.type === "attachment") return renderAttachment(block);
    if (block.type === "search") return renderActivity(block, "search");
    if (block.type === "citations") return renderCitations(block);
    if (block.type === "tool" && block.name === "schedule") return renderSchedule(block);
    if (block.type === "tool") return renderActivity(block, "tool");
    if (block.type === "diagram") return renderDiagram(block);
    if (block.type === "html") {
      const wrapper = blockWrapper("html");
      if (STATIC_KATEX_LABELS.has(block.label)) {
        const display = block.label === "cloudig-static-katex-display";
        wrapper.classList.add("static-katex-block", display ? "is-display" : "is-inline");
        wrapper.append(renderStaticKatex(block.html, display));
        return wrapper;
      }
      if (block.label) wrapper.append(makeElement("div", "block-label", block.label));
      wrapper.append(renderSafeHtml(block.html));
      return wrapper;
    }
    return renderUnknown(block);
  }

  function blockPreviewText(block) {
    if (!block || typeof block !== "object") return "";
    const direct = [
      block.title, block.label, block.text, block.markdown, block.query, block.name,
      block.caption, block.alt, block.filename, block.status, block.code, block.tex
    ].filter((value) => typeof value === "string" && value.trim());
    if (direct.length) return direct.join(" ");
    if (typeof block.html === "string") return block.html.replace(/<[^>]*>/gu, " ");
    for (const collection of [block.items, block.results, block.sources]) {
      if (!Array.isArray(collection)) continue;
      const nested = collection.map((item) => blockPreviewText(item)).filter(Boolean);
      if (nested.length) return nested.join(" ");
    }
    return "";
  }

  function messagePreview(message) {
    const raw = (message.content || []).map(blockPreviewText).filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
    return raw.slice(0, 92) || t("fallback.empty_message");
  }

  function groupPreview(group) {
    const presented = core.presentationMessages(group, state.activeEntry?.document.platform);
    const messages = group?.role === "assistant"
      ? presented.filter((message) => message.role === "assistant")
      : presented;
    const raw = messages.flatMap((message) => (message.content || [])
      .filter((block) => GENERATED_BODY_BLOCK_TYPES.has(block?.type))
      .map(blockPreviewText))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    return raw.slice(0, 92) || t("fallback.empty_message");
  }

  function messageIsInternal(message) {
    const types = (message?.content || []).map((block) => block?.type).filter(Boolean);
    return message?.role === "tool"
      || (types.length > 0 && types.every((type) => PROCESS_BLOCK_TYPES.has(type)));
  }

  function isReasoningStatus(block) {
    if (block?.type !== "status") return false;
    const title = core.normalizeText(block.title).toLocaleLowerCase("en-US");
    return /(?:思考|推理|thinking|reasoning)/iu.test(title);
  }

  function renderMessageGroup(group, index) {
    const article = makeElement("article", "message");
    article.id = `message-${index + 1}`;
    article.dataset.role = group.role;
    article.dataset.index = String(index);
    article.dataset.turnId = group.id;
    const platform = state.activeEntry?.document.platform || "";
    article.style.setProperty("--role-color", ROLE_COLORS[group.role] || ROLE_COLORS.other);
    article.style.setProperty("--user-bubble-light", PLATFORM_BUBBLES_LIGHT[platform] || PLATFORM_BUBBLES_LIGHT.chatgpt);
    article.style.setProperty("--user-bubble-dark", PLATFORM_BUBBLES_DARK[platform] || PLATFORM_BUBBLES_DARK.chatgpt);
    if (platform === "grok") article.classList.add("dark-user-bubble");
    const head = makeElement("header", "message-head");
    const messages = core.presentationMessages(group, platform);
    const first = messages[0] || {};
    const resolvedIdentity = identityForDocument(state.activeEntry?.document || { platform });
    const label = group.role === "user"
      ? resolvedIdentity.user.display_name
      : group.role === "assistant"
        ? resolvedIdentity.assistant.display_name
        : (i18n.catalogs[state.language][`role.${group.role}`] ? t(`role.${group.role}`) : group.role);
    const identityEditable = ["user", "assistant"].includes(group.role) && Boolean(state.library);
    const avatar = makeElement(identityEditable ? "button" : "span", "role-avatar", label.slice(0, 1));
    if (identityEditable) {
      avatar.type = "button";
      avatar.dataset.identityEditor = "conversation";
      avatar.dataset.cloudigTooltipAuto = "";
      avatar.setAttribute("aria-label", t("identity.edit_conversation_names"));
      avatar.setAttribute("aria-haspopup", "dialog");
      avatar.setAttribute("aria-controls", "profile-edit-dialog");
    }
    const avatarValue = group.role === "user"
      ? resolvedIdentity.user.avatar
      : group.role === "assistant" ? resolvedIdentity.assistant.avatar : "";
    const assistantUsesIdentityAvatar = group.role === "assistant" && (
      resolvedIdentity.apply_to_all
      || Boolean(libraryCore.cleanString(state.library?.platform_overrides?.[platform]?.assistant_avatar))
      || Boolean(libraryCore.cleanString(state.library?.assistant?.avatar))
      || !assistantAvatarAsset(platform)
    );
    if (group.role === "user" || assistantUsesIdentityAvatar) {
      avatar.classList.add("identity-avatar");
    }
    const defaultAvatarUrl = group.role === "assistant"
      ? assistantAvatarAsset(platform) || readerAsset("cover.OsisLogo-Simple.svg")
      : group.role === "user" ? readerAsset("cover.OsisLogo-Cloudig-1024.png") : readerAsset("brand.seal");
    const avatarUrl = identityAvatarUrl(avatarValue, defaultAvatarUrl);
    if (avatarUrl || defaultAvatarUrl) {
      const image = document.createElement("img");
      image.src = avatarUrl || defaultAvatarUrl;
      image.alt = "";
      avatar.replaceChildren(image);
    }
    if (group.role === "assistant") {
      if (!assistantUsesIdentityAvatar) avatar.classList.add("platform-avatar");
      avatar.dataset.platform = platform;
    }
    const identity = makeElement("span", "message-identity");
    const identityLine = makeElement("span", "message-identity-line");
    const roleLabel = makeElement(identityEditable ? "button" : "span", "message-role", label);
    if (identityEditable) {
      roleLabel.type = "button";
      roleLabel.classList.add("message-identity-trigger");
      roleLabel.dataset.identityEditor = "conversation";
      roleLabel.dataset.cloudigTooltipAuto = "";
      roleLabel.setAttribute("aria-label", t("identity.edit_conversation_names"));
      roleLabel.setAttribute("aria-haspopup", "dialog");
      roleLabel.setAttribute("aria-controls", "profile-edit-dialog");
    }
    identityLine.append(roleLabel);
    if (first.name && first.name !== label) {
      identityLine.append(makeElement("span", "message-name", first.name));
    }
    const groupModels = [...new Set(messages.map((message) => message.model).filter(Boolean))].join(" · ");
    if (groupModels) identityLine.append(makeElement("span", "message-model", groupModels));
    identity.append(identityLine);
    const timestamp = messages.map((message) => message.timestamp).find(Boolean);
    if (timestamp) identity.append(makeElement("time", "message-time", formatDate(timestamp)));
    head.append(avatar, identity);
    const body = makeElement("div", "message-body");
    const reasoningBlocks = messages.flatMap((message) =>
      (message.content || []).filter((block) => REASONING_BLOCK_TYPES.has(block?.type)));
    const reasoningStatuses = messages.flatMap((message) =>
      (message.content || []).filter((block) => isReasoningStatus(block) || (platform === "kimi" && block?.type === "status")));
    const consolidateThoughts = group.role === "assistant"
      && (reasoningBlocks.length > 0 || (platform === "kimi" && reasoningStatuses.length > 0));
    const consolidatedThoughtBlocks = new Set(consolidateThoughts
      ? [...reasoningBlocks, ...reasoningStatuses]
      : []);
    if (consolidatedThoughtBlocks.size) {
      const className = platform === "kimi"
        ? "message-subrecord is-internal thought-record kimi-thought-record"
        : "message-subrecord is-internal thought-record";
      const thoughtRecord = makeElement("div", className);
      const orderedThoughtBlocks = messages.flatMap((message) =>
        (message.content || []).filter((block) => consolidatedThoughtBlocks.has(block)));
      thoughtRecord.append(renderReasoningCollection(orderedThoughtBlocks));
      body.append(thoughtRecord);
    }
    for (const message of messages) {
      const content = (message.content || []).filter((block) => !consolidatedThoughtBlocks.has(block));
      if (!content.length) continue;
      const record = makeElement("div", "message-subrecord");
      if (messageIsInternal({ ...message, content })) record.classList.add("is-internal");
      for (const block of content) record.append(renderContentBlock(block));
      body.append(record);
    }
    article.append(head, body);
    return article;
  }

  function renderWarnings(documentData) {
    const warnings = documentData.warnings || [];
    dom.warnings.hidden = !warnings.length;
    dom.warnings.replaceChildren();
    if (!warnings.length) return;
    dom.warnings.append(makeElement("h2", "", t("warning.heading", { count: warnings.length })));
    const list = document.createElement("ul");
    for (const warning of warnings) {
      const context = [warning.message_index !== undefined ? t("warning.message", { index: warning.message_index + 1 }) : "", warning.resource_id].filter(Boolean).join(" · ");
      const item = makeElement("li", "", [warning.message || t("fallback.warning_code", { code: warning.code }), context].filter(Boolean).join(" · "));
      item.dataset.warningCode = warning.code;
      item.title = warning.code;
      list.append(item);
    }
    dom.warnings.append(list);
  }

  function buildBranchModel(documentData) {
    const messages = documentData.messages || [];
    if (!messages.some((message) => message.parent_id)) return null;
    const indexById = new Map();
    messages.forEach((message, index) => { if (message.id) indexById.set(message.id, index); });
    const parentsWithChildren = new Set();
    for (const message of messages) if (message.parent_id && indexById.has(message.parent_id)) parentsWithChildren.add(message.parent_id);
    const leaves = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.id && !parentsWithChildren.has(message.id))
      .map(({ index }) => index);
    if (!leaves.length) return null;
    const paths = leaves.map((leafIndex) => {
      const path = [];
      const seen = new Set();
      let current = leafIndex;
      while (Number.isInteger(current) && !seen.has(current)) {
        seen.add(current);
        path.unshift(current);
        const parentId = messages[current]?.parent_id;
        current = parentId && indexById.has(parentId) ? indexById.get(parentId) : null;
      }
      return path;
    });
    return { leaves, paths };
  }

  function activeBranchPosition() {
    if (!state.branchModel) return -1;
    const stored = state.branchSelection.get(state.activeEntry?.id);
    const storedPosition = state.branchModel.leaves.findIndex((index) => state.activeEntry.document.messages[index]?.id === stored);
    if (storedPosition >= 0) return storedPosition;
    const lastMessageIndex = state.activeEntry.document.messages.length - 1;
    const lastPosition = state.branchModel.leaves.indexOf(lastMessageIndex);
    return lastPosition >= 0 ? lastPosition : state.branchModel.leaves.length - 1;
  }

  function groupIndexesForRawPath(rawPath) {
    const selected = new Set(rawPath || []);
    return state.groups
      .map((group, index) => group.indexes.some((rawIndex) => selected.has(rawIndex)) ? index : -1)
      .filter((index) => index >= 0);
  }

  function renderBranchNavigation() {
    const model = state.branchModel;
    dom.branchNavigation.hidden = !model || model.leaves.length <= 1;
    if (!model) {
      state.branchPath = state.groups.map((_group, index) => index);
      state.branchPathSet = new Set(state.branchPath);
      return;
    }
    const position = activeBranchPosition();
    state.branchPath = groupIndexesForRawPath(model.paths[position] || []);
    state.branchPathSet = new Set(state.branchPath);
    if (!state.branchPathSet.has(state.waypointIndex)) {
      state.waypointIndex = state.branchPath[0] || 0;
      state.waypointKey = "";
    }
    const leaf = model.leaves[position];
    const leafId = state.activeEntry.document.messages[leaf]?.id;
    if (leafId) state.branchSelection.set(state.activeEntry.id, leafId);
    const options = model.leaves.map((leafIndex, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = t("branch.option", {
        current: index + 1,
        messages: groupIndexesForRawPath(model.paths[index]).length,
        preview: messagePreview(state.activeEntry.document.messages[leafIndex]).slice(0, 48)
      });
      return option;
    });
    dom.branchSelect.replaceChildren(...options);
    dom.branchSelect.value = String(position);
    dom.branchSummary.textContent = t("branch.summary", {
      current: position + 1,
      total: model.leaves.length,
      messages: state.branchPath.length
    });
    dom.previousBranch.disabled = position <= 0;
    dom.nextBranch.disabled = position >= model.leaves.length - 1;
  }

  function chooseBranch(position) {
    if (!state.branchModel) return;
    const next = Math.max(0, Math.min(state.branchModel.leaves.length - 1, Number(position) || 0));
    const leafIndex = state.branchModel.leaves[next];
    const leafId = state.activeEntry.document.messages[leafIndex]?.id;
    if (leafId) state.branchSelection.set(state.activeEntry.id, leafId);
    state.messageQuery = "";
    dom.messageSearch.value = "";
    state.waypointIndex = groupIndexesForRawPath(state.branchModel.paths[next] || [])[0] || 0;
    state.waypointKey = "";
    renderBranchNavigation();
    applyMessageFilter();
    dom.conversationScroll.scrollTo({ top: 0, behavior: "smooth" });
  }

  function outlineCandidateIndexes() {
    const needle = core.normalizeText(state.messageQuery);
    const result = [];
    for (const [index, group] of state.groups.entries()) {
      if (!outlineTextIsVisible(group.role)) continue;
      if (!state.messageQuery && state.branchModel && !state.branchPathSet.has(index)) continue;
      if (state.messageQuery && !core.normalizeText(core.collectGroupText(group)).includes(needle)) continue;
      result.push(index);
    }
    return result;
  }

  function syncOutlineWaypoint({ follow = false } = {}) {
    let current = null;
    for (const button of dom.outlineList.querySelectorAll(".outline-link")) {
      const selected = state.waypointKey
        ? button.dataset.waypointKey === state.waypointKey
        : Number(button.dataset.index) === state.waypointIndex;
      button.classList.toggle("current", selected);
      if (selected) {
        button.setAttribute("aria-current", "true");
        current = button;
      } else {
        button.removeAttribute("aria-current");
      }
    }
    if (follow && current) current.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  function outlineProcessPreview(block) {
    const preferred = block.querySelector(".activity-title, .reasoning-segment-title, summary, .status-card, .prose");
    const value = String(preferred?.textContent || block.textContent || "").replace(/\s+/gu, " ").trim();
    return value.slice(0, 92) || (state.language === "en" ? "Process" : "过程");
  }

  function outlineNodes() {
    const candidates = new Set(outlineCandidateIndexes());
    const nodes = [];
    for (const [index, group] of state.groups.entries()) {
      if (!candidates.has(index)) continue;
      const article = byId(`message-${index + 1}`);
      if (!article) continue;
      const role = group.role;
      const mainVisible = outlineTextIsVisible(role);
      const processVisible = role === "assistant"
        && dom.showAiMessages?.checked !== false
        && dom.showProcessMessages?.checked !== false;
      let order = 0;
      let mainAdded = false;
      const addNode = (kind, preview, target) => {
        if (!target.id) target.id = `message-${index + 1}-outline-${order + 1}`;
        nodes.push({
          key: `${index}:${kind}:${order}`,
          index,
          role,
          kind,
          targetId: target.id,
          preview,
          firstInGroup: order === 0
        });
        order += 1;
      };
      if (role === "user") {
        if (mainVisible) addNode("message", groupPreview(group), article);
        continue;
      }
      const outlineBlocks = [...article.querySelectorAll(":scope > .message-body > .message-subrecord > .content-block")];
      outlineBlocks.forEach((block, blockIndex) => {
        block.id = `message-${index + 1}-outline-${blockIndex + 1}`;
      });
      for (const block of outlineBlocks) {
        if (block.hidden) continue;
        const process = block.classList.contains("reasoning-block")
          || block.classList.contains("activity-block")
          || block.classList.contains("content-status");
        if (process) {
          if (processVisible) addNode("process", outlineProcessPreview(block), block);
        } else if (mainVisible && !mainAdded) {
          addNode("message", groupPreview(group), block);
          mainAdded = true;
        }
      }
      if (mainVisible && !mainAdded && !processVisible) addNode("message", groupPreview(group), article);
    }
    return nodes;
  }

  function revealOutlineNode(node, { smooth = true } = {}) {
    const target = byId(node.targetId);
    if (!target) return;
    state.waypointIndex = node.index;
    state.waypointKey = node.key;
    syncOutlineWaypoint({ follow: true });
    target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }

  function renderOutline(documentData) {
    const nodes = outlineNodes();
    if (nodes.length && !nodes.some((node) => node.key === state.waypointKey)) {
      const next = nodes.find((node) => node.index >= state.waypointIndex) || nodes.at(-1);
      state.waypointIndex = next.index;
      state.waypointKey = next.key;
    }
    dom.outlineList.replaceChildren();
    for (const node of nodes) {
      const button = makeElement("button", "outline-link");
      button.type = "button";
      button.dataset.index = String(node.index);
      button.dataset.role = node.role;
      button.dataset.kind = node.kind;
      button.dataset.waypointKey = node.key;
      button.dataset.targetId = node.targetId;
      button.classList.toggle("group-start", node.firstInGroup);
      button.title = node.preview;
      const butterflyDawn = document.createElement("img");
      butterflyDawn.className = "outline-butterfly reader-theme-dawn";
      butterflyDawn.src = readerAsset("cover.SmallButterfly-Dawn.svg");
      butterflyDawn.alt = "";
      const butterflyNight = document.createElement("img");
      butterflyNight.className = "outline-butterfly reader-theme-night";
      butterflyNight.src = readerAsset("cover.SmallButterfly-StarNight.svg");
      butterflyNight.alt = "";
      const marker = makeElement("span", "outline-marker", "");
      marker.append(butterflyDawn, butterflyNight, makeElement("span", "outline-node", ""));
      button.append(
        marker,
        makeElement("span", "outline-number", String(node.index + 1).padStart(3, "0")),
        makeElement("span", "outline-text", node.preview)
      );
      button.addEventListener("click", () => revealOutlineNode(node));
      button.addEventListener("pointerenter", () => {
        const outlineRect = dom.outline.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        dom.outlinePreviewPopover.textContent = node.preview;
        dom.outlinePreviewPopover.style.top = `${Math.max(6, Math.min(outlineRect.height - 90, buttonRect.top - outlineRect.top - 12))}px`;
        dom.outlinePreviewPopover.hidden = false;
      });
      button.addEventListener("pointerleave", () => { dom.outlinePreviewPopover.hidden = true; });
      button.addEventListener("focus", () => {
        const outlineRect = dom.outline.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        dom.outlinePreviewPopover.textContent = node.preview;
        dom.outlinePreviewPopover.style.top = `${Math.max(6, Math.min(outlineRect.height - 90, buttonRect.top - outlineRect.top - 12))}px`;
        dom.outlinePreviewPopover.hidden = false;
      });
      button.addEventListener("blur", () => { dom.outlinePreviewPopover.hidden = true; });
      dom.outlineList.append(button);
    }
    syncOutlineWaypoint();
  }

  function renderStats(documentData) {
    const stats = core.documentStats(documentData);
    dom.outlineStats.replaceChildren();
    for (const [value, label] of [[stats.messages, t("stats.messages")], [stats.resources, t("stats.resources")], [stats.sources, t("stats.sources")], [stats.warnings, t("stats.warnings")]]) {
      const card = makeElement("div", "stat"); card.append(makeElement("strong", "", value), makeElement("span", "", label)); dom.outlineStats.append(card);
    }
  }

  function revealMatchingDisclosures(article) {
    const needle = core.normalizeText(state.messageQuery);
    if (!needle) return;
    for (const details of article.querySelectorAll("details[data-reasoning], details[data-activity]")) {
      if (!details.__cloudigSearchText?.includes(needle)) continue;
      details.__cloudigRenderBody?.();
      details.open = true;
    }
  }

  function updateMatchSummary() {
    const total = state.messageMatches.length;
    const active = Boolean(state.messageQuery) && total > 0;
    dom.conversationSearchShell?.classList.toggle("has-query", Boolean(state.messageQuery));
    dom.previousMatch.disabled = !active;
    dom.nextMatch.disabled = !active;
    if (!state.messageQuery) dom.matchSummary.textContent = "";
    else if (!total) dom.matchSummary.textContent = t("search.none");
    else dom.matchSummary.textContent = t("search.position", { current: state.activeMessageMatch + 1, total });
  }

  function revealMessage(index, { smooth = true } = {}) {
    const article = byId(`message-${index + 1}`);
    if (!article || article.classList.contains("no-match")) return;
    state.waypointIndex = index;
    state.waypointKey = "";
    for (const message of dom.timeline.querySelectorAll(".message")) message.classList.toggle("search-current", message === article && Boolean(state.messageQuery));
    revealMatchingDisclosures(article);
    syncOutlineWaypoint({ follow: true });
    article.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }

  function moveMessageMatch(delta) {
    if (!state.messageMatches.length) return;
    state.activeMessageMatch = (state.activeMessageMatch + delta + state.messageMatches.length) % state.messageMatches.length;
    revealMessage(state.messageMatches[state.activeMessageMatch]);
    updateMatchSummary();
  }

  function moveWaypoint(delta) {
    if (!state.activeEntry) return;
    const candidates = outlineCandidateIndexes();
    if (!candidates.length) return;
    const currentPosition = Math.max(0, candidates.indexOf(state.waypointIndex));
    const nextPosition = Math.max(0, Math.min(candidates.length - 1, currentPosition + delta));
    revealMessage(candidates[nextPosition]);
  }

  function applyMessageFilter() {
    if (!state.activeEntry) return;
    state.messageMatches = [];
    const needle = core.normalizeText(state.messageQuery);
    for (const [index, group] of state.groups.entries()) {
      const queryMatch = !needle || core.normalizeText(core.collectGroupText(group)).includes(needle);
      const branchMatch = !state.branchModel || state.branchPathSet.has(index);
      const match = state.messageQuery ? queryMatch : branchMatch;
      const article = byId(`message-${index + 1}`);
      article?.classList.toggle("no-match", !match);
      article?.classList.remove("search-current");
      if (queryMatch && state.messageQuery) state.messageMatches.push(index);
    }
    state.activeMessageMatch = state.messageMatches.length ? 0 : -1;
    if (state.messageQuery && state.messageMatches.length) {
      state.waypointIndex = state.messageMatches[0];
      state.waypointKey = "";
      byId(`message-${state.waypointIndex + 1}`)?.classList.add("search-current");
    } else if (!state.messageQuery) {
      applyReasoningControls();
      applyActivityControls();
    }
    updateMatchSummary();
    let empty = dom.timeline.querySelector(".empty-matches");
    if (state.messageQuery && !state.messageMatches.length) {
      if (!empty) { empty = makeElement("div", "empty-matches", t("search.none")); dom.timeline.append(empty); }
    } else empty?.remove();
    renderOutline(state.activeEntry.document);
  }

  function syncControlledRecordVisibility() {
    for (const record of dom.timeline.querySelectorAll(".message-subrecord")) {
      const blocks = [...record.children].filter((node) => node.classList?.contains("content-block"));
      record.hidden = blocks.length > 0 && blocks.every((block) => block.hidden);
    }
    for (const article of dom.timeline.querySelectorAll(".message")) {
      const records = [...article.querySelectorAll(":scope > .message-body > .message-subrecord")];
      article.classList.toggle(
        "content-controls-hidden",
        records.length > 0 && records.every((record) => record.hidden)
      );
    }
  }

  function applyReasoningControls() {
    const hidden = dom.hideReasoning.checked;
    for (const block of dom.timeline.querySelectorAll(
      '.reasoning-block, .content-status[data-status-kind="reasoning"]'
    )) block.hidden = hidden;
    for (const details of dom.timeline.querySelectorAll("details[data-reasoning]")) details.open = dom.expandReasoning.checked;
    syncControlledRecordVisibility();
    if (state.activeEntry) renderOutline(state.activeEntry.document);
  }

  function applyActivityControls() {
    const hideTools = dom.hideActivities.checked;
    for (const block of dom.timeline.querySelectorAll(".activity-block[data-activity-type]")) {
      block.hidden = hideTools && block.dataset.activityType === "tool";
    }
    for (const details of dom.timeline.querySelectorAll("details[data-activity]")) {
      const open = ["search", "citations"].includes(details.dataset.activity)
        ? dom.expandSources.checked
        : dom.expandActivities.checked;
      if (open) details.__cloudigRenderBody?.();
      details.open = open;
    }
    syncControlledRecordVisibility();
    if (state.activeEntry) renderOutline(state.activeEntry.document);
  }

  function outlineTextIsVisible(role) {
    if (role === "user") return dom.showUserMessages?.checked !== false;
    if (role === "assistant") return dom.showAiMessages?.checked !== false;
    return true;
  }

  function applyOutlineTextVisibility() {
    if (state.activeEntry) renderOutline(state.activeEntry.document);
  }

  function applyOutlineVisibilityControls() {
    const assistantVisible = dom.showAiMessages.checked;
    dom.showProcessMessages.disabled = !assistantVisible;
    if (!assistantVisible) dom.showProcessMessages.checked = false;
    applyOutlineTextVisibility();
  }

  function disclosurePreferences() {
    return {
      expand_reasoning: dom.expandReasoning.checked,
      expand_tools: dom.expandActivities.checked,
      expand_references: dom.expandSources.checked,
      hide_reasoning: dom.hideReasoning.checked,
      hide_tools: dom.hideActivities.checked
    };
  }

  function saveDisclosurePreferences() {
    try { localStorage.setItem(DISCLOSURE_PREFERENCES_KEY, JSON.stringify(disclosurePreferences())); } catch { /* file mode may deny storage */ }
  }

  function restoreDisclosurePreferences() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(DISCLOSURE_PREFERENCES_KEY) || "null"); } catch { stored = null; }
    if (!stored || typeof stored !== "object") return;
    dom.expandReasoning.checked = stored.expand_reasoning === true;
    dom.expandActivities.checked = stored.expand_tools === true;
    dom.expandSources.checked = stored.expand_references === true;
    dom.hideReasoning.checked = stored.hide_reasoning === true;
    dom.hideActivities.checked = stored.hide_tools === true;
  }

  function syncWaypointFromScroll() {
    waypointScrollFrame = 0;
    if (!state.activeEntry || dom.conversation.hidden) return;
    const scrollRect = dom.conversationScroll.getBoundingClientRect();
    const readableTop = Number(scrollRect.top) || 0;
    const readableBottom = Number(scrollRect.bottom) || globalThis.innerHeight || 0;
    for (const button of dom.outlineList.querySelectorAll(".outline-link")) {
      const target = byId(button.dataset.targetId);
      if (!target || target.closest(".message")?.classList.contains("no-match")) continue;
      const rect = target.getBoundingClientRect();
      if (Number(rect.bottom) <= readableTop || Number(rect.top) >= readableBottom) continue;
      state.waypointIndex = Number(button.dataset.index) || 0;
      state.waypointKey = button.dataset.waypointKey || "";
      syncOutlineWaypoint({ follow: true });
      return;
    }
  }

  function scheduleWaypointFromScroll() {
    if (waypointScrollFrame) return;
    waypointScrollFrame = globalThis.requestAnimationFrame(syncWaypointFromScroll);
  }

  function updateReadingGeometry() {
    globalThis.cancelAnimationFrame?.(readingGeometryFrame);
    readingGeometryFrame = globalThis.requestAnimationFrame(() => {
      const readerRect = dom.reader.getBoundingClientRect();
      const columnRight = readerRect.right;
      const rightOffset = Math.max(0, globalThis.innerWidth - columnRight);
      document.documentElement.style.setProperty("--reading-column-right-offset", `${Math.round(rightOffset * 1000) / 1000}px`);
      document.documentElement.dataset.readingColumnRight = String(Math.round(columnRight * 1000) / 1000);
    });
  }

  function formatDate(value) {
    if (libraryCore.isRecord(value)) return libraryCore.formatContentTime(value, state.language);
    const timestamp = typeof value === "number" ? value : Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return String(value || "");
    return new Intl.DateTimeFormat(state.language, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
  }

  function platformLabel(documentData) {
    if (documentData.platform === "claude") return "Claude";
    if (documentData.platform === "chatglm") return "ChatGLM.cn";
    if (documentData.platform === "zai") return "z.ai";
    if (documentData.platform === "yuanbao") return "元宝";
    if (documentData.platform === "doubao") return "豆包";
    if (documentData.platform === "kimi") return "Kimi";
    return documentData.platform;
  }

  function providerLabel(documentData) {
    const labels = {
      openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI",
      deepseek: "DeepSeek", bytedance: "字节跳动", alibaba: "阿里云",
      zhipu: "智谱", moonshot: "Moonshot AI", tencent: "腾讯", mistral: "Mistral AI"
    };
    return labels[documentData.provider] || documentData.provider || platformLabel(documentData);
  }

  function releaseInactiveConversationBodies(activeId = "") {
    if (!DESKTOP_CATALOG_READER) return;
    state.entries = state.entries.map((entry) => {
      if (!entry.catalogRecord || (activeId && entry.id === activeId)) return entry;
      const next = makeCatalogConversationEntry({
        ...entry.catalogRecord,
        relative_path: entry.fileName
      });
      next.fileObject = entry.fileObject;
      return next;
    });
  }

  async function openConversationEntry(entry, { openEditor = false } = {}) {
    if (!entry) return null;
    if (!entry.catalogRecord || entry.bodyLoaded) {
      renderConversation(entry);
      if (openEditor) openConversationEditor();
      return entry;
    }
    if (!DESKTOP_CATALOG_READER) throw new Error("A catalog-only conversation requires the Cloudig desktop bridge");
    conversationLoadSequence += 1;
    const sequence = conversationLoadSequence;
    dom.libraryList.setAttribute("aria-busy", "true");
    try {
      const result = await desktopBridge("reader.read-conversation", {
        relative_path: entry.fileName,
        expected_sha256: entry.catalogSha256
      });
      if (sequence !== conversationLoadSequence) return null;
      const documentData = result?.document;
      const compatibility = core.conversationCompatibility(documentData);
      if (!compatibility.supported) throw new Error("The selected conversation schema is no longer supported");
      core.assertConversation(documentData);
      const record = {
        ...entry.catalogRecord,
        relative_path: String(result.relative_path || entry.fileName),
        size_bytes: Number(result.size_bytes) || entry.fileSize,
        modified_at: String(result.modified_at || entry.catalogRecord.modified_at || ""),
        sha256: String(result.sha256 || entry.catalogSha256).toLowerCase()
      };
      const loaded = makeLoadedCatalogEntry(documentData, record);
      if (loaded.id !== entry.id) throw new Error("The selected conversation identity changed after the catalog was opened");
      releaseInactiveConversationBodies(loaded.id);
      state.entries = state.entries.map((candidate) => candidate.id === loaded.id ? loaded : candidate);
      renderConversation(loaded);
      if (openEditor) openConversationEditor();
      return loaded;
    } catch (error) {
      if (error?.code === "CLOUDIG_CONVERSATION_CHANGED") {
        await refreshDesktopArchiveSnapshot().catch(() => {});
      }
      toast(error?.message || String(error), true, 7000);
      return null;
    } finally {
      if (sequence === conversationLoadSequence) dom.libraryList.removeAttribute("aria-busy");
    }
  }

  function showReaderCover() {
    clearCanvasStyles();
    document.body.classList.remove("reader-conversation-active");
    conversationLoadSequence += 1;
    dom.libraryList?.removeAttribute("aria-busy");
    releaseInactiveConversationBodies();
    state.activeEntry = null;
    state.groups = [];
    state.messageQuery = "";
    state.messageMatches = [];
    state.waypointIndex = 0;
    state.waypointKey = "";
    dom.messageSearch.value = "";
    dom.conversation.hidden = true;
    dom.welcome.hidden = false;
    dom.outline.hidden = true;
    readerCover.setVisible(true);
    dom.welcomeManager.hidden = !DESKTOP_READER || state.entries.length !== 0 || state.embeddedLibraryPending;
    dom.coverSummary.textContent = state.language === "en"
      ? (state.entries.length
        ? `${state.entries.length} conversations loaded. Choose one from the catalog to begin.`
        : "Choose a library to list every conversation for local, offline reading.")
      : (state.entries.length
        ? `已载入 ${state.entries.length} 篇对话。请选择左侧一篇开始阅读。`
        : "选择资料库后，全部会话会在本机离线列出。");
    renderLibrary();
    refreshReaderCover();
    dom.reader.scrollTo({ top: 0 });
  }

  function renderConversation(entry) {
    if (entry?.catalogRecord && !entry.bodyLoaded) {
      void openConversationEntry(entry);
      return;
    }
    clearCanvasStyles();
    document.body.classList.add("reader-conversation-active");
    state.activeEntry = entry;
    state.resources = core.resourceMap(entry.document);
    state.sources = core.sourceMap(entry.document);
    state.groups = core.groupMessages(entry.document.messages);
    state.messageQuery = "";
    state.messageMatches = [];
    state.activeMessageMatch = -1;
    state.waypointIndex = 0;
    state.waypointKey = "";
    dom.messageSearch.value = "";
    dom.welcome.hidden = true;
    dom.conversation.hidden = false;
    dom.outline.hidden = false;
    readerCover.setVisible(false);
    const documentData = entry.document;
    state.branchModel = buildBranchModel(documentData);
    renderBranchNavigation();
    dom.editConversation.disabled = !state.library;
    dom.editConversation.title = state.library ? "编辑写入 cloudig-library.json" : "当前目录没有 cloudig-library.json";
    dom.editProfile.disabled = !state.library;
    dom.platformBadge.textContent = providerLabel(documentData);
    dom.platformBadge.style.setProperty("--platform", PLATFORM_COLORS[documentData.platform] || "#186a5a");
    const modelNames = [...new Set((documentData.models || []).map((model) => String(model || "").trim()).filter(Boolean))];
    if (!modelNames.length) modelNames.push(platformLabel(documentData));
    dom.conversationModels.setAttribute("aria-label", state.language === "en" ? "Models" : "模型");
    dom.conversationModels.replaceChildren(...modelNames.map((model) => {
      const tag = makeElement("span", "cloudig-tag is-outline conversation-model-tag", model);
      tag.setAttribute("role", "listitem");
      tag.dataset.cloudigTooltip = model;
      return tag;
    }));
    dom.conversationPlatformIcon.src = platformAsset(documentData.platform);
    dom.conversationPlatformIcon.alt = platformLabel(documentData);
    dom.conversationPlatformIcon.parentElement.classList.toggle("kimi", documentData.platform === "kimi");
    dom.conversationTitle.textContent = documentData.title;
    dom.conversationMeta.replaceChildren();
    const stats = core.documentStats(documentData);
    const meta = [
      [state.language === "en" ? "Content time" : "内容时间", formatDate(core.effectiveContentTime(documentData))],
      [state.language === "en" ? "Exported" : "导出时间", formatDate(documentData.exported_at)],
      [state.language === "en" ? "Messages" : "消息数", state.language === "en" ? String(stats.messages) : `${stats.messages} 条`]
    ];
    for (const [label, value] of meta) if (value) dom.conversationMeta.append(makeElement("span", "", `${label} · ${value}`));
    renderWarnings(documentData);
    dom.timeline.replaceChildren();
    const fragment = document.createDocumentFragment();
    state.groups.forEach((group, index) => fragment.append(renderMessageGroup(group, index)));
    dom.timeline.append(fragment);
    applyMessageFilter();
    renderStats(documentData);
    renderOutline(documentData);
    applyReasoningControls();
    applyActivityControls();
    applyOutlineTextVisibility();
    updateMatchSummary();
    renderLibrary();
    renderSourceDialog();
    dom.conversationScroll.scrollTo({ top: 0 });
    if (innerWidth <= 820) dom.library.classList.remove("open");
  }

  function entryDate(entry) {
    const value = core.effectiveContentTime(entry.document);
    if (libraryCore.isRecord(value)) return libraryCore.formatContentTime(value, state.language);
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(state.language, { year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp) : "";
  }

  function entryDirectory(entry) {
    const segments = String(entry?.fileName || "")
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);
    const conversationsIndex = segments.findLastIndex((segment) => segment.toLowerCase() === "conversations");
    const directorySegments = conversationsIndex >= 0
      ? segments.slice(conversationsIndex + 1, -1)
      : segments.slice(0, -1);
    return directorySegments.join("/");
  }

  function catalogDirectories() {
    return [...new Set([
      ...state.archiveDirectories.map((directory) => String(directory?.name || "")).filter(Boolean),
      ...state.entries.map(entryDirectory).filter(Boolean)
    ])]
      .sort((left, right) => left.localeCompare(right, state.language, { numeric: true, sensitivity: "base" }));
  }

  function applyArchiveSnapshot(archive) {
    if (!archive || typeof archive !== "object") return false;
    const previousActiveId = state.activeEntry?.id || "";
    state.archiveRevision = String(archive.revision || "");
    state.archiveDirectories = Array.isArray(archive.directories)
      ? archive.directories.map((directory) => ({
          name: String(directory?.name || ""),
          files: Number(directory?.files) || 0,
          size_bytes: Number(directory?.size_bytes) || 0
        })).filter((directory) => directory.name)
      : [];
    state.archiveFiles = Array.isArray(archive.files) ? archive.files.map((file) => ({ ...file })) : [];
    if (DESKTOP_CATALOG_READER) {
      const existingByKey = new Map(state.entries.map((entry) => [String(entry.id || ""), entry]));
      const nextEntries = [];
      const nextIssues = [];
      for (const record of state.archiveFiles.filter((file) => !file.archived)) {
        if (record.compatibility !== "supported" || !record.conversation_key) {
          nextIssues.push(catalogCompatibilityIssue(record));
          continue;
        }
        const existing = existingByKey.get(String(record.conversation_key));
        const next = existing?.bodyLoaded && existing.catalogSha256 === String(record.sha256 || "").toLowerCase()
          ? makeLoadedCatalogEntry(existing.baseDocument || existing.document, record)
          : makeCatalogConversationEntry(record);
        next.fileObject = existing?.fileObject;
        nextEntries.push(next);
      }
      state.entries = nextEntries;
      state.compatibilityIssues = nextIssues.sort((left, right) =>
        left.file_name.localeCompare(right.file_name, "zh-CN", { numeric: true, sensitivity: "base" }));
      state.activeEntry = state.entries.find((entry) => entry.id === previousActiveId && entry.bodyLoaded) || null;
      updateCompatibilityBanner();
      updatePlatformFilter();
      return Boolean(previousActiveId && !state.activeEntry);
    }
    const activeByKey = new Map(state.archiveFiles
      .filter((file) => !file.archived && file.conversation_key && file.relative_path)
      .map((file) => [String(file.conversation_key), file]));
    for (const entry of state.entries) {
      const record = activeByKey.get(String(entry.libraryKey || entry.id || ""));
      if (!record) continue;
      entry.fileName = String(record.relative_path);
      if (entry.catalogRecord) entry.catalogRecord = { ...entry.catalogRecord, ...record };
      if (entry.fileObject) entry.fileObject = { ...entry.fileObject, archiveRelativePath: entry.fileName };
    }
    return false;
  }

  async function refreshDesktopArchiveSnapshot({ rerender = true } = {}) {
    if (!DESKTOP_READER) return null;
    const archive = await desktopBridge("reader.archive-list");
    const activeInvalidated = applyArchiveSnapshot(archive);
    if (rerender) {
      if (activeInvalidated) showReaderCover();
      else renderLibrary();
    }
    return archive;
  }

  function directoryErrorMessage(error) {
    const message = String(error?.message || error || "");
    if (error?.code === "CLOUDIG_ARCHIVE_REVISION_CONFLICT" || /archive changed|window was open/iu.test(message)) return t("directory_manager.changed");
    if (/already exists|EEXIST/iu.test(message)) return t("directory_manager.duplicate");
    if (/1-80 characters/iu.test(message)) return t("directory_manager.required");
    if (/not valid on Windows/iu.test(message)) return t("directory_manager.invalid");
    if (/only an empty conversation directory/iu.test(message)) return t("directory_manager.not_empty");
    return message || t("directory_manager.failed");
  }

  function setDirectoryManagerError(message = "") {
    dom.directoryManagerError.textContent = message;
    dom.directoryManagerError.hidden = !message;
  }

  function validateDirectoryName(value, previous = "") {
    const name = String(value || "").normalize("NFC").trim();
    if (!name) return { name, error: t("directory_manager.required") };
    if (Array.from(name).length > 80) return { name, error: t("directory_manager.too_long") };
    if (name === "." || name === ".." || name.startsWith(".") || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
      || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) {
      return { name, error: t("directory_manager.invalid") };
    }
    const duplicate = state.archiveDirectories.some((directory) => directory.name !== previous
      && directory.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
    return { name, error: duplicate ? t("directory_manager.duplicate") : "" };
  }

  function selectedManagedDirectory() {
    return state.archiveDirectories.find((directory) => directory.name === state.directoryManagerName) || null;
  }

  function directoryHasNestedChildren(name) {
    return state.archiveDirectories.some((directory) => directory.name.startsWith(`${name}/`));
  }

  function directoryManagerRow(directory) {
    const button = makeElement("button", "reader-directory-row");
    button.type = "button";
    button.dataset.directoryName = directory.name;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(
      state.directoryManagerMode === "edit" && state.directoryManagerName === directory.name
    ));
    button.dataset.cloudigTooltip = directory.name;
    button.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 9h11l4 5h11v15H3z"/><path d="M3 14h26"/></svg>';
    const copy = makeElement("span");
    const title = makeElement("strong", "", directoryLabel(directory.name));
    title.title = directory.name;
    const detail = makeElement("small", "", directory.files
      ? t("directory_manager.contains", { count: directory.files, size: core.formatBytes(directory.size_bytes) })
      : directoryHasNestedChildren(directory.name)
        ? t("directory_manager.contains_nested")
        : t("directory_manager.empty_directory"));
    copy.append(title, detail);
    button.append(copy);
    return button;
  }

  function renderDirectoryManager() {
    if (!dom.directoryManagerList) return;
    const directories = state.archiveDirectories;
    if (state.directoryManagerMode === "edit" && !selectedManagedDirectory()) {
      state.directoryManagerMode = "";
      state.directoryManagerName = "";
      state.directoryManagerDeleteArmed = false;
    }
    dom.directoryManagerCount.textContent = String(directories.length);
    dom.directoryManagerList.replaceChildren(...directories.map(directoryManagerRow));
    dom.directoryManagerEmpty.hidden = directories.length > 0;
    const editing = state.directoryManagerMode === "create" || state.directoryManagerMode === "edit";
    const directory = state.directoryManagerMode === "edit" ? selectedManagedDirectory() : null;
    const nested = Boolean(directory?.name.includes("/"));
    const hasNestedChildren = Boolean(directory && directoryHasNestedChildren(directory.name));
    dom.directoryManagerEditor.hidden = !editing;
    dom.directoryManagerEditorEmpty.hidden = editing;
    dom.directoryManagerDelete.hidden = state.directoryManagerMode !== "edit";
    if (!editing) {
      dom.directoryManagerSave.disabled = true;
      setDirectoryManagerError();
      return;
    }
    dom.directoryManagerMode.textContent = state.directoryManagerMode === "create" ? "NEW DIRECTORY" : "EDIT DIRECTORY";
    dom.directoryManagerName.value = directory?.name || "";
    dom.directoryManagerName.disabled = nested;
    dom.directoryManagerFiles.textContent = String(directory?.files || 0);
    dom.directoryManagerSize.textContent = core.formatBytes(Number(directory?.size_bytes) || 0);
    dom.directoryManagerDelete.disabled = nested || hasNestedChildren || Number(directory?.files) > 0;
    dom.directoryManagerDelete.title = hasNestedChildren ? t("directory_manager.has_nested") : "";
    dom.directoryManagerDelete.textContent = t(state.directoryManagerDeleteArmed
      ? "directory_manager.confirm_delete"
      : "directory_manager.delete_empty");
    dom.directoryManagerSave.disabled = nested;
    dom.directoryManagerSave.textContent = t(state.directoryManagerMode === "create"
      ? "directory_manager.create"
      : "directory_manager.save");
    setDirectoryManagerError(nested
      ? t("directory_manager.nested_readonly")
      : state.directoryManagerDeleteArmed ? t("directory_manager.delete_note") : "");
  }

  function startDirectoryManagerDraft(mode, name = "") {
    state.directoryManagerMode = mode;
    state.directoryManagerName = name;
    state.directoryManagerDeleteArmed = false;
    renderDirectoryManager();
    requestAnimationFrame(() => {
      dom.directoryManagerName.focus({ preventScroll: true });
      dom.directoryManagerName.select();
    });
  }

  async function openDirectoryManager({ create = false, moveEntryId = "" } = {}) {
    if (!DESKTOP_READER) {
      toast(t("directory_manager.desktop_only"), true, 6500);
      return;
    }
    state.directoryManagerMoveEntryId = moveEntryId;
    state.directoryManagerMode = "";
    state.directoryManagerName = "";
    state.directoryManagerDeleteArmed = false;
    setDirectoryManagerError();
    try {
      await refreshDesktopArchiveSnapshot({ rerender: false });
      state.directoryManagerRevision = state.archiveRevision;
      if (!dom.directoryManagerDialog.open) dom.directoryManagerDialog.showModal();
      if (create) startDirectoryManagerDraft("create");
      else {
        renderDirectoryManager();
        requestAnimationFrame(() => dom.directoryManagerNew.focus({ preventScroll: true }));
      }
    } catch (error) {
      toast(directoryErrorMessage(error), true, 7000);
    }
  }

  function closeDirectoryManager() {
    state.directoryManagerMode = "";
    state.directoryManagerName = "";
    state.directoryManagerRevision = "";
    state.directoryManagerDeleteArmed = false;
    state.directoryManagerMoveEntryId = "";
    setDirectoryManagerError();
    if (dom.directoryManagerDialog.open) dom.directoryManagerDialog.close();
  }

  function remapDirectorySelection(previous, next = "") {
    const remap = (selection) => new Set([...selection].map((directory) => {
      if (directory === previous) return next;
      if (directory.startsWith(`${previous}/`)) return next ? `${next}${directory.slice(previous.length)}` : "";
      return directory;
    }).filter(Boolean));
    state.directorySelection = remap(state.directorySelection);
    state.directoryDraftSelection = remap(state.directoryDraftSelection);
  }

  function closeLibraryItemMenus() {
    for (const shell of document.querySelectorAll(".library-item-shell.menu-open")) {
      shell.classList.remove("menu-open");
      shell.querySelector(".library-item-editor")?.setAttribute("hidden", "");
      shell.querySelector(".library-item-move-menu")?.setAttribute("hidden", "");
      shell.querySelector(".library-item-menu-trigger")?.setAttribute("aria-expanded", "false");
    }
  }

  async function moveEntryToDirectory(entry, destination) {
    if (!DESKTOP_READER) {
      toast(t("directory_manager.desktop_only"), true, 6500);
      return false;
    }
    const current = entryDirectory(entry);
    if (current === destination) {
      closeLibraryItemMenus();
      toast(t("directory_manager.already_there"));
      return true;
    }
    try {
      if (!state.archiveRevision) await refreshDesktopArchiveSnapshot({ rerender: false });
      const result = await desktopBridge("reader.archive-move", {
        relative_paths: [entry.fileName],
        destination,
        expected_revision: state.archiveRevision
      });
      applyArchiveSnapshot(result.archive);
      closeLibraryItemMenus();
      renderLibrary();
      toast(t("directory_manager.moved", { directory: destination || t("directory_manager.root") }));
      return true;
    } catch (error) {
      toast(directoryErrorMessage(error), true, 7000);
      return false;
    }
  }

  async function saveDirectoryManager(event) {
    event?.preventDefault?.();
    const mode = state.directoryManagerMode;
    if (!mode || !DESKTOP_READER) return;
    const previous = mode === "edit" ? state.directoryManagerName : "";
    const validation = validateDirectoryName(dom.directoryManagerName.value, previous);
    setDirectoryManagerError(validation.error);
    if (validation.error) {
      dom.directoryManagerName.focus();
      return;
    }
    dom.directoryManagerSave.disabled = true;
    try {
      const result = mode === "create"
        ? await desktopBridge("reader.directory-create", {
            name: validation.name,
            expected_revision: state.directoryManagerRevision
          })
        : await desktopBridge("reader.directory-rename", {
            old_name: previous,
            new_name: validation.name,
            expected_revision: state.directoryManagerRevision
          });
      if (mode === "edit") remapDirectorySelection(previous, result.directory);
      applyArchiveSnapshot(result.archive);
      state.directoryManagerRevision = state.archiveRevision;
      const moveEntry = state.entries.find((entry) => entry.id === state.directoryManagerMoveEntryId) || null;
      if (moveEntry && mode === "create") {
        const destination = result.directory;
        closeDirectoryManager();
        await moveEntryToDirectory(moveEntry, destination);
      } else {
        state.directoryManagerMode = "edit";
        state.directoryManagerName = result.directory;
        state.directoryManagerDeleteArmed = false;
        renderDirectoryManager();
        renderLibrary();
        toast(t(mode === "create" ? "directory_manager.created" : "directory_manager.renamed"));
      }
    } catch (error) {
      setDirectoryManagerError(directoryErrorMessage(error));
    } finally {
      if (dom.directoryManagerDialog.open) dom.directoryManagerSave.disabled = false;
    }
  }

  async function removeDirectoryManager() {
    const directory = selectedManagedDirectory();
    if (!directory || directory.files || directory.name.includes("/") || directoryHasNestedChildren(directory.name) || !DESKTOP_READER) return;
    if (!state.directoryManagerDeleteArmed) {
      state.directoryManagerDeleteArmed = true;
      renderDirectoryManager();
      dom.directoryManagerDelete.focus();
      return;
    }
    dom.directoryManagerDelete.disabled = true;
    try {
      const result = await desktopBridge("reader.directory-remove", {
        name: directory.name,
        expected_revision: state.directoryManagerRevision
      });
      remapDirectorySelection(directory.name);
      applyArchiveSnapshot(result.archive);
      state.directoryManagerRevision = state.archiveRevision;
      state.directoryManagerMode = "";
      state.directoryManagerName = "";
      state.directoryManagerDeleteArmed = false;
      renderDirectoryManager();
      renderLibrary();
      toast(t("directory_manager.removed"));
    } catch (error) {
      setDirectoryManagerError(directoryErrorMessage(error));
      dom.directoryManagerDelete.disabled = false;
    }
  }

  function directoryLabel(directory) {
    return String(directory || "").split("/").filter(Boolean).at(-1) || t("catalog.all_directories");
  }

  function directoryAssetVariant(selected, index, shelfPlacement = null) {
    if (!shelfPlacement) return selected ? index % 4 + 1 : index % 2 + 1;
    const lowerRow = shelfPlacement.row === "lower";
    if (!selected) return lowerRow ? 2 : 1;
    const evenColumn = shelfPlacement.column % 2 === 0;
    if (lowerRow) return evenColumn ? 2 : 4;
    return evenColumn ? 1 : 3;
  }

  function directoryAsset(themeName, selected, index, shelfPlacement = null) {
    const variant = directoryAssetVariant(selected, index, shelfPlacement);
    return `cover.Directory-${selected ? "Selected" : "UnSelected"}-${themeName}-0${variant}.svg`;
  }

  function appendDirectoryArtwork(button, selected, index, shelfPlacement = null) {
    const dawn = makeElement("img", "reader-theme-dawn");
    dawn.alt = "";
    dawn.src = readerAsset(directoryAsset("Dawn", selected, index, shelfPlacement));
    const night = makeElement("img", "reader-theme-night");
    night.alt = "";
    night.src = readerAsset(directoryAsset("StarNight", selected, index, shelfPlacement));
    button.append(dawn, night);
  }

  function renderDirectoryPanel(directories = catalogDirectories()) {
    if (!dom.directoryPanelList) return;
    dom.directoryPanelList.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let shelfIndex = 0; shelfIndex < Math.ceil(directories.length / 6); shelfIndex += 1) {
      const shelf = makeElement("section", "rr-directory-panel-shelf");
      shelf.setAttribute("aria-label", t("catalog.directory_shelf", { index: shelfIndex + 1 }));
      const grid = makeElement("div", "rr-directory-panel-grid");
      directories.slice(shelfIndex * 6, shelfIndex * 6 + 6).forEach((directory, localIndex) => {
        const index = shelfIndex * 6 + localIndex;
        const selected = state.directoryDraftSelection.has(directory);
        const button = makeElement("button", "rr-directory-panel-item");
        button.type = "button";
        button.dataset.directory = directory;
        button.dataset.cloudigTooltip = directory;
        button.setAttribute("aria-pressed", String(selected));
        appendDirectoryArtwork(button, selected, index, {
          row: localIndex < 3 ? "lower" : "upper",
          column: localIndex % 3
        });
        button.append(makeElement("span", "rr-directory-name", directoryLabel(directory)));
        grid.append(button);
      });
      shelf.append(grid, makeElement("i", "rr-directory-panel-rail"));
      fragment.append(shelf);
    }
    dom.directoryPanelList.append(fragment);
  }

  function setDirectoryPanelOpen(open) {
    state.directoryPanelOpen = Boolean(open);
    dom.directoryPanel.hidden = !state.directoryPanelOpen;
    byId("directory-selector")?.classList.toggle("panel-open", state.directoryPanelOpen);
    if (state.directoryPanelOpen) {
      state.directoryDraftSelection = new Set(state.directorySelection);
      renderDirectoryPanel();
    }
  }

  function renderDirectorySelector(directories = catalogDirectories()) {
    if (!dom.directoryBookSlots) return;
    const available = new Set(directories);
    state.directorySelection = new Set([...state.directorySelection].filter((directory) => available.has(directory)));
    state.directoryDraftSelection = new Set([...state.directoryDraftSelection].filter((directory) => available.has(directory)));
    const allSelected = state.directorySelection.size === 0;
    dom.allDirectories.setAttribute("aria-current", String(allSelected));
    dom.allDirectories.querySelector(".reader-theme-dawn").src = readerAsset(`cover.AllDirectory-${allSelected ? "Selected" : "UnSelected"}-Dawn.svg`);
    dom.allDirectories.querySelector(".reader-theme-night").src = readerAsset(`cover.AllDirectory-${allSelected ? "Selected" : "UnSelected"}-StarNight.svg`);
    dom.directoryBookSlots.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 4; index += 1) {
      const directory = directories[index];
      if (!directory) {
        const placeholder = makeElement("i", "rr-directory-placeholder");
        placeholder.setAttribute("aria-hidden", "true");
        appendDirectoryArtwork(placeholder, false, index);
        fragment.append(placeholder);
        continue;
      }
      const selected = state.directorySelection.has(directory);
      const button = makeElement("button", "rr-directory-book");
      button.type = "button";
      button.dataset.directory = directory;
      button.dataset.cloudigTooltip = directory;
      button.setAttribute("aria-pressed", String(selected));
      appendDirectoryArtwork(button, selected, index);
      button.append(makeElement("span", "rr-directory-name", directoryLabel(directory)));
      fragment.append(button);
    }
    dom.directoryBookSlots.append(fragment);
    dom.expandDirectories.hidden = directories.length <= 4;
    if (state.directoryPanelOpen) renderDirectoryPanel(directories);
  }

  function filteredEntries() {
    return core.sortedEntries(state.entries.filter((entry) => {
      const platform = entry.document.platform;
      const selected = !PLATFORM_ORDER.includes(platform) || state.platforms.has(platform);
      const directorySelected = state.directorySelection.size === 0 || state.directorySelection.has(entryDirectory(entry));
      return selected && directorySelected && core.matchesEntry(entry, state.libraryQuery);
    }), state.sort);
  }

  function updateFoldedConversationNavigation(entries = filteredEntries()) {
    const activeIndex = entries.findIndex((entry) => entry.id === state.activeEntry?.id);
    dom.previousConversation.disabled = activeIndex <= 0;
    dom.nextConversation.disabled = activeIndex < 0 || activeIndex >= entries.length - 1;
  }

  function navigateFilteredConversation(offset) {
    const entries = filteredEntries();
    const activeIndex = entries.findIndex((entry) => entry.id === state.activeEntry?.id);
    const target = entries[activeIndex + offset];
    if (target) void openConversationEntry(target);
  }

  function compatibilityIssueText(issue) {
    const issueStatus = issue.kind === "invalid_json"
      ? t("dialog.compatibility.invalid_json")
      : issue.kind === "invalid_conversation"
        ? t("dialog.compatibility.invalid_conversation")
        : t("catalog.compatibility.requires_update");
    return core.normalizeText([
      issue.file_name,
      issue.title,
      issue.platform,
      issue.schema,
      issue.parser_version,
      issue.parser_adapter,
      issue.reader_version,
      issueStatus
    ].filter(Boolean).join("\n"));
  }

  function parserAdapterLabel(value) {
    const id = String(value?.id || "").trim();
    const version = String(value?.version || "").trim();
    return id && version ? `${id} ${version}` : "";
  }

  function filteredCompatibilityIssues() {
    const query = core.normalizeText(state.libraryQuery);
    return state.compatibilityIssues.filter((issue) => {
      const platform = String(issue.platform || "").toLowerCase();
      const selected = !PLATFORM_ORDER.includes(platform) || state.platforms.has(platform);
      return selected && (!query || compatibilityIssueText(issue).includes(query));
    });
  }

  function compatibilityFileName(issue) {
    return String(issue.file_name || "").replaceAll("\\", "/").split("/").at(-1) || t("dialog.compatibility.unknown");
  }

  function renderCompatibilityLibraryItem(issue, index) {
    const button = makeElement("button", "library-item library-item-incompatible");
    const invalidJson = issue.kind === "invalid_json";
    const invalidConversation = issue.kind === "invalid_conversation";
    const status = invalidJson
      ? t("catalog.compatibility.invalid_json")
      : invalidConversation
        ? t("catalog.compatibility.invalid_conversation")
        : t("catalog.compatibility.requires_update");
    const action = invalidJson || invalidConversation
      ? t("catalog.compatibility.repair_action")
      : t("catalog.compatibility.update_action");
    const detailId = `compatibility-catalog-detail-${index}`;
    button.type = "button";
    button.dataset.compatibilityFile = issue.file_name;
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("aria-describedby", detailId);
    button.setAttribute("aria-label", `${issue.title || compatibilityFileName(issue)}。${status}。${action}`);
    button.title = action;
    button.append(makeElement("span", "library-item-title", issue.title || compatibilityFileName(issue)));
    const meta = makeElement("span", "library-item-meta library-item-compatibility-meta");
    meta.append(platformIcon(issue.platform, "library-item-platform-icon"));
    meta.append(makeElement(
      "span",
      "library-item-model",
      issue.platform ? platformLabel({ platform: issue.platform }) : t("catalog.compatibility.generic_file")
    ));
    meta.append(makeElement("span", "library-item-compatibility-status", status));
    button.append(meta);
    button.append(makeElement("span", "library-item-files", compatibilityFileName(issue)));
    const versions = invalidJson
      ? t("dialog.compatibility.invalid_json")
      : [
        invalidConversation ? t("dialog.compatibility.invalid_conversation") : "",
        `${t("dialog.compatibility.schema")} · ${issue.schema || t("dialog.compatibility.unknown")}`,
        `${t("dialog.compatibility.parser")} · ${issue.parser_version || t("dialog.compatibility.unknown")}`,
        issue.parser_adapter ? `${t("dialog.compatibility.adapter")} · ${issue.parser_adapter}` : "",
        invalidConversation ? `${t("dialog.compatibility.reader")} · ${issue.reader_version || VERSION}` : ""
      ].filter(Boolean).join(" · ");
    button.append(makeElement("span", "library-item-compatibility-versions", versions));
    const detail = makeElement("span", "library-item-compatibility-detail", action);
    detail.id = detailId;
    button.append(detail);
    button.addEventListener("click", () => openCompatibilityNotice(issue));
    return button;
  }

  function renderLibrary() {
    const directories = catalogDirectories();
    renderDirectorySelector(directories);
    const entries = filteredEntries();
    updateFoldedConversationNavigation(entries);
    const compatibilityIssues = filteredCompatibilityIssues();
    const shownCount = entries.length + compatibilityIssues.length;
    const totalCount = state.entries.length + state.compatibilityIssues.length;
    const filteredCompatibilityNote = compatibilityIssues.length
      ? ` · ${t("catalog.compatibility.count_note", { count: compatibilityIssues.length })}`
      : "";
    dom.libraryList.replaceChildren();
    dom.librarySummary.textContent = totalCount
      ? `${t("catalog.visible_count", { shown: shownCount, total: totalCount })}${filteredCompatibilityNote}`
      : t("catalog.no_conversations");
    dom.totalConversationCount.textContent = state.entries.length
      ? (state.language === "en"
        ? `${state.entries.length} ${state.entries.length === 1 ? "conversation" : "conversations"}`
        : `总${state.entries.length}篇对话`)
      : t("catalog.no_conversations_top");
    for (const button of document.querySelectorAll("[data-catalog-sort]")) {
      button.setAttribute("aria-pressed", button.dataset.catalogSort === state.sort ? "true" : "false");
    }
    dom.editProfile.disabled = !state.library;
    if (!entries.length && !compatibilityIssues.length) {
      if (totalCount) dom.libraryList.append(makeElement("div", "empty-list", t("catalog.no_match")));
      else {
        const themeName = state.theme === "dark" ? "StarNight" : "Dawn";
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < 8; index += 1) {
          const placeholder = makeElement("div", "library-item library-item-placeholder");
          placeholder.setAttribute("aria-hidden", "true");
          const paper = makeElement("img", "library-item-paper");
          paper.alt = "";
          paper.src = readerAsset(index === 0
            ? `cover.Title-Paper-Selected-${themeName}.svg`
            : `cover.Title-Paper-UnSelected-${themeName}-0${(index - 1) % 2 + 1}.svg`);
          placeholder.append(paper);
          if (index === 0) {
            const pin = makeElement("img", "library-item-pin");
            pin.alt = "";
            pin.src = readerAsset(state.theme === "dark" ? "cover.Pushpin-Purple.svg" : "cover.Pushpin-Red.svg");
            placeholder.append(pin);
          }
          fragment.append(placeholder);
        }
        dom.libraryList.append(fragment);
      }
      return;
    }
    const fragment = document.createDocumentFragment();
    let unselectedPaperIndex = 0;
    entries.forEach((entry) => {
      const shell = makeElement("div", "library-item-shell");
      const button = makeElement("button", "library-item");
      button.type = "button";
      const active = entry.id === state.activeEntry?.id;
      const paperVariant = active ? 0 : (unselectedPaperIndex % 2) + 1;
      if (!active) unselectedPaperIndex += 1;
      shell.dataset.paperVariant = String(paperVariant);
      button.classList.toggle("active", active);
      const themeName = state.theme === "dark" ? "StarNight" : "Dawn";
      const paper = makeElement("img", "library-item-paper");
      paper.classList.add("library-item-paper-base");
      paper.alt = "";
      paper.src = readerAsset(active
        ? `cover.Title-Paper-Selected-${themeName}.svg`
        : `cover.Title-Paper-UnSelected-${themeName}-0${paperVariant}.svg`);
      button.append(paper);
      if (!active) {
        const hoverPaper = makeElement("img", "library-item-paper library-item-paper-hover");
        hoverPaper.alt = "";
        hoverPaper.src = readerAsset(`cover.Title-Paper-Selected-${themeName}.svg`);
        button.append(hoverPaper);
      }
      if (active) {
        const pin = makeElement("img", "library-item-pin");
        pin.alt = "";
        pin.src = readerAsset(state.theme === "dark" ? "cover.Pushpin-Purple.svg" : "cover.Pushpin-Red.svg");
        button.append(pin);
      }
      button.append(makeElement("span", "library-item-title", entry.document.title));
      const meta = makeElement("span", "library-item-meta");
      meta.append(platformIcon(entry.document.platform, "library-item-platform-icon"));
      meta.append(makeElement("span", "library-item-model", entry.document.models?.join(" / ") || platformLabel(entry.document)));
      meta.append(makeElement("span", "library-item-date", entryDate(entry)));
      meta.append(makeElement("span", "library-item-count", t("catalog.message_count", { count: entryMessageCount(entry) })));
      button.append(meta);
      button.addEventListener("click", () => { void openConversationEntry(entry); });
      const menuTrigger = makeElement("button", "library-item-menu-trigger");
      menuTrigger.type = "button";
      menuTrigger.innerHTML = '<svg viewBox="0 0 36 12" aria-hidden="true"><circle cx="5" cy="6" r="4"/><circle cx="18" cy="6" r="4"/><circle cx="31" cy="6" r="4"/></svg>';
      menuTrigger.dataset.cloudigTooltip = t("catalog.more_actions");
      menuTrigger.setAttribute("aria-label", `${entry.document.title} · ${t("catalog.more_actions")}`);
      menuTrigger.setAttribute("aria-expanded", "false");

      const editor = makeElement("section", "library-item-editor");
      editor.hidden = true;
      const editorDawn = makeElement("img", "reader-theme-dawn");
      editorDawn.alt = "";
      editorDawn.src = readerAsset("cover.Title-Paper-Editor-Dawn.svg");
      const editorNight = makeElement("img", "reader-theme-night");
      editorNight.alt = "";
      editorNight.src = readerAsset("cover.Title-Paper-Editor-StarNight.svg");
      editor.append(editorDawn, editorNight);

      const menuAction = (label, icon, className = "") => {
        const action = makeElement("button", className);
        action.type = "button";
        action.innerHTML = `${icon}<span>${label}</span>`;
        return action;
      };
      const edit = menuAction(t("catalog.edit"), '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11 8-8 2 2-8 8-3 1zM9.5 4.5l2 2"/></svg>');
      const move = menuAction(t("catalog.move_to_directory"), '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h5l1 2h6v7H2z"/></svg>');
      const archive = menuAction(t("catalog.archive"), '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12v9H2zM1 2h14v3H1zM6 8h4"/></svg>');
      const remove = menuAction(t("catalog.delete"), '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 2h4l1 2M5 6v6m3-6v6m3-6v6M4 4l1 10h6l1-10"/></svg>', "danger");
      editor.append(edit, move, archive, remove);

      const moveMenu = makeElement("section", "library-item-move-menu");
      moveMenu.hidden = true;
      const moveMenuDawn = makeElement("img", "reader-theme-dawn");
      moveMenuDawn.alt = "";
      moveMenuDawn.src = readerAsset("cover.Title-Paper-Editor-Dawn.svg");
      const moveMenuNight = makeElement("img", "reader-theme-night");
      moveMenuNight.alt = "";
      moveMenuNight.src = readerAsset("cover.Title-Paper-Editor-StarNight.svg");
      const moveTitle = makeElement("strong", "library-item-move-title", t("catalog.move_to_directory"));
      const createMoveDirectory = makeElement("button", "library-item-move-create");
      createMoveDirectory.type = "button";
      createMoveDirectory.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg><span></span>';
      createMoveDirectory.querySelector("span").textContent = t("directory_manager.new_for_move");
      const destinationEntries = ["", ...directories.filter((directory) => !directory.includes("/"))];
      moveMenu.append(moveMenuDawn, moveMenuNight, moveTitle, createMoveDirectory);
      for (const directory of destinationEntries) {
        const destination = makeElement("button", "", directory || t("directory_manager.root"));
        destination.type = "button";
        destination.dataset.directory = directory;
        destination.classList.toggle("library-item-move-current", entryDirectory(entry) === directory);
        destination.disabled = entryDirectory(entry) === directory;
        destination.addEventListener("click", (event) => {
          event.stopPropagation();
          void moveEntryToDirectory(entry, directory);
        });
        moveMenu.append(destination);
      }

      menuTrigger.addEventListener("click", (event) => {
        event.stopPropagation();
        for (const other of document.querySelectorAll(".library-item-shell.menu-open")) {
          if (other === shell) continue;
          other.classList.remove("menu-open");
          other.querySelector(".library-item-editor")?.setAttribute("hidden", "");
          other.querySelector(".library-item-move-menu")?.setAttribute("hidden", "");
          other.querySelector(".library-item-menu-trigger")?.setAttribute("aria-expanded", "false");
        }
        const open = !shell.classList.contains("menu-open");
        shell.classList.toggle("menu-open", open);
        editor.hidden = !open;
        moveMenu.hidden = true;
        menuTrigger.setAttribute("aria-expanded", String(open));
      });
      edit.addEventListener("click", (event) => {
        event.stopPropagation();
        shell.classList.remove("menu-open");
        editor.hidden = true;
        menuTrigger.setAttribute("aria-expanded", "false");
        if (state.activeEntry?.id === entry.id && state.activeEntry.bodyLoaded) openConversationEditor();
        else void openConversationEntry(entry, { openEditor: true });
      });
      move.addEventListener("click", (event) => {
        event.stopPropagation();
        moveMenu.hidden = !moveMenu.hidden;
      });
      createMoveDirectory.addEventListener("click", (event) => {
        event.stopPropagation();
        void openDirectoryManager({ create: true, moveEntryId: entry.id });
      });
      for (const unavailable of [archive, remove]) {
        unavailable.disabled = true;
        unavailable.title = t("catalog.directory_pending");
      }
      shell.append(button, menuTrigger, editor, moveMenu);
      fragment.append(shell);
    });
    compatibilityIssues.forEach((issue, index) => fragment.append(renderCompatibilityLibraryItem(issue, index)));
    dom.libraryList.append(fragment);
  }

  function updatePlatformFilterLabel() {
    const selected = [...state.platforms];
    dom.platformFilterLabel.textContent = selected.length === PLATFORM_ORDER.length
      ? t("catalog.all_platforms")
      : selected.length === 0
        ? t("catalog.selected_platforms", { count: 0 })
        : selected.length === 1
          ? platformLabel({ platform: selected[0] })
          : t("catalog.selected_platforms", { count: selected.length });
  }

  function updatePlatformFilter() {
    const available = new Set(state.entries.map((entry) => entry.document.platform));
    state.platforms = new Set([...state.platforms].filter((platform) => PLATFORM_ORDER.includes(platform)));
    dom.platformFilterOptions.replaceChildren();
    for (const platform of PLATFORM_ORDER) {
      const button = makeElement("button", "platform-filter-button");
      button.type = "button";
      button.dataset.platform = platform;
      button.classList.toggle("selected", state.platforms.has(platform));
      button.classList.toggle("unavailable", !available.has(platform));
      button.style.setProperty("--platform-color", PLATFORM_COLORS[platform] || "#a52525");
      button.dataset.cloudigTooltipAuto = "";
      button.setAttribute("aria-label", platformLabel({ platform }));
      button.setAttribute("aria-pressed", state.platforms.has(platform) ? "true" : "false");
      button.append(platformIcon(platform));
      dom.platformFilterOptions.append(button);
    }
    updatePlatformFilterLabel();
  }

  function fileRelativePath(file) {
    return file.archiveRelativePath || file.webkitRelativePath || file.name;
  }

  function normalizedRelativePath(file) {
    return String(fileRelativePath(file) || file.name || "")
      .replaceAll("\\", "/")
      .replace(/^\.\//u, "")
      .replace(/\/{2,}/gu, "/");
  }

  function currentJsonFileName(entry) {
    return String(entry?.fileName || "").replaceAll("\\", "/").split("/").at(-1) || "conversation.json";
  }

  function libraryCandidateScore(file) {
    const relative = normalizedRelativePath(file).toLowerCase();
    const segments = relative.split("/").filter(Boolean);
    return segments.length;
  }

  function chooseLibraryCandidate(files) {
    return files
      .filter((file) => file.name.toLowerCase() === libraryCore.FILE_NAME)
      .sort((left, right) => libraryCandidateScore(left) - libraryCandidateScore(right)
        || normalizedRelativePath(left).length - normalizedRelativePath(right).length
        || normalizedRelativePath(left).localeCompare(normalizedRelativePath(right), "en"))[0] || null;
  }

  function libraryRootPrefixFromFile(file) {
    const relative = normalizedRelativePath(file);
    const slash = relative.lastIndexOf("/");
    return slash < 0 ? "" : relative.slice(0, slash);
  }

  function isLibraryConversationFile(file, libraryRootPrefix) {
    const relative = normalizedRelativePath(file).toLowerCase();
    const prefix = libraryRootPrefix ? `${libraryRootPrefix.toLowerCase()}/conversations/` : "conversations/";
    const withinConversations = relative.startsWith(prefix);
    const libraryRelative = withinConversations ? relative.slice(prefix.length) : "";
    return withinConversations
      && !libraryRelative.startsWith(".cloudig-archive/")
      && file.name.toLowerCase().endsWith(".json");
  }

  function isArchivedConversationFile(file) {
    const segments = normalizedRelativePath(file).toLowerCase().split("/").filter(Boolean);
    return segments.includes(".cloudig-archive");
  }

  function makeConversationEntry(baseDocument, fileName, fileSize = 0, fileMetadata = {}) {
    core.assertConversation(baseDocument);
    const presentationBase = core.presentationDocument(baseDocument);
    const effectiveDocument = libraryCore.applyConversationOverlay(presentationBase, state.library);
    const entry = core.makeProjectedEntry(effectiveDocument, fileName, baseDocument);
    entry.baseDocument = presentationBase;
    entry.sourceDocument = baseDocument;
    entry.fileSize = Number.isFinite(fileSize) && fileSize >= 0 ? fileSize : 0;
    entry.fileModifiedAt = Number(fileMetadata.lastModified) || 0;
    entry.fileCreatedAt = String(fileMetadata.createdAt || "");
    entry.libraryKey = libraryCore.conversationKey(presentationBase);
    entry.hasOverride = Boolean(libraryCore.conversationOverride(state.library, presentationBase));
    return entry;
  }

  function catalogBaseDocument(record) {
    return {
      schema: String(record?.schema || ""),
      parser_version: String(record?.parser_version || ""),
      parser_adapter: record?.parser_adapter || undefined,
      exporter_version: String(record?.exporter_version || "") || undefined,
      parsed_at: String(record?.last_parsed_at || record?.parsed_at || "") || undefined,
      first_parsed_at: record?.first_parsed_at || undefined,
      cloudig_edited_at: String(record?.cloudig_edited_at || "") || undefined,
      conversation_key: String(record?.conversation_key || record?.sha256 || ""),
      archive_id: String(record?.archive_id || "") || undefined,
      title: String(record?.original_title ?? record?.title ?? ""),
      provider: String(record?.original_provider ?? record?.provider ?? ""),
      platform: String(record?.original_platform ?? record?.platform ?? ""),
      models: Array.isArray(record?.original_models) ? record.original_models.map(String) : [],
      content_time: record?.original_content_time ?? record?.content_time ?? "",
      exported_at: String(record?.exported_at || "") || undefined,
      source_captured_at: record?.source_captured_at || undefined,
      source_created_at: String(record?.source_captured_at?.value || record?.source_created_at || "") || undefined,
      source_modified_at: String(record?.source_modified_at || "") || undefined,
      source_file: String(record?.source_file || "") || undefined,
      messages: []
    };
  }

  function catalogSearchText(documentData, fileName) {
    return core.normalizeText([
      documentData?.title,
      documentData?.provider,
      documentData?.platform,
      ...(documentData?.models || []),
      documentData?.source_file,
      currentJsonFileName({ fileName })
    ].filter(Boolean).join("\n"));
  }

  function attachCatalogRecord(entry, record, { bodyLoaded = false } = {}) {
    entry.catalogRecord = { ...record };
    entry.catalogSha256 = String(record?.sha256 || "").toLowerCase();
    entry.messageCount = Number(record?.messages) || 0;
    entry.bodyLoaded = bodyLoaded;
    return entry;
  }

  function makeCatalogConversationEntry(record) {
    const baseDocument = catalogBaseDocument(record);
    const effectiveDocument = libraryCore.applyConversationOverlay(baseDocument, state.library);
    return attachCatalogRecord({
      id: baseDocument.conversation_key,
      fileName: String(record.relative_path || "Conversations/conversation.json"),
      document: effectiveDocument,
      baseDocument,
      fileSize: Number(record.size_bytes) || 0,
      fileModifiedAt: Number.isFinite(Date.parse(record.modified_at)) ? Date.parse(record.modified_at) : 0,
      fileCreatedAt: String(record.created_at || ""),
      libraryKey: baseDocument.conversation_key,
      hasOverride: Boolean(libraryCore.conversationOverride(state.library, baseDocument)),
      searchText: catalogSearchText(effectiveDocument, record.relative_path)
    }, record);
  }

  function makeLoadedCatalogEntry(documentData, record) {
    const entry = makeConversationEntry(documentData, String(record.relative_path), Number(record.size_bytes) || 0, {
      lastModified: Number.isFinite(Date.parse(record.modified_at)) ? Date.parse(record.modified_at) : 0,
      createdAt: String(record.created_at || "")
    });
    entry.searchText = catalogSearchText(entry.document, record.relative_path);
    return attachCatalogRecord(entry, record, { bodyLoaded: true });
  }

  function entryMessageCount(entry) {
    return Number.isInteger(entry?.messageCount)
      ? entry.messageCount
      : core.documentStats(entry?.document || {}).messages;
  }

  function compatibilityIssueKey(issue) {
    return String(issue?.file_name || "").replaceAll("\\", "/").toLowerCase();
  }

  function compatibilityMetadata(value) {
    const clean = (candidate, limit = 240) => typeof candidate === "string"
      ? candidate.trim().slice(0, limit)
      : "";
    return Object.freeze({
      title: clean(value?.title),
      platform: clean(value?.platform, 64).toLowerCase()
    });
  }

  function invalidJsonIssue(file) {
    return Object.freeze({
      kind: "invalid_json",
      file_name: normalizedRelativePath(file),
      title: "",
      platform: "",
      schema: "",
      parser_version: "",
      parser_adapter: "",
      reader_version: VERSION,
      parse_error: "invalid_json"
    });
  }

  function invalidConversationIssue(file, compatibility = null) {
    return Object.freeze({
      kind: "invalid_conversation",
      file_name: normalizedRelativePath(file),
      title: "",
      platform: "",
      schema: compatibility?.schema || String(file.compatibilitySchema || "").trim(),
      parser_version: compatibility?.parser_version || String(file.compatibilityParserVersion || "").trim(),
      parser_adapter: parserAdapterLabel(compatibility?.parser_adapter),
      reader_version: compatibility?.reader_version || String(file.compatibilityReaderVersion || "").trim() || VERSION,
      parse_error: "invalid_conversation"
    });
  }

  function unsupportedSchemaIssue(file, value, compatibility) {
    const metadata = compatibilityMetadata(value);
    return Object.freeze({
      kind: "unsupported_schema",
      file_name: normalizedRelativePath(file),
      title: metadata.title,
      platform: metadata.platform,
      schema: compatibility.schema,
      parser_version: compatibility.parser_version,
      parser_adapter: parserAdapterLabel(compatibility.parser_adapter),
      reader_version: compatibility.reader_version
    });
  }

  function catalogCompatibilityIssue(record) {
    const file = {
      name: currentJsonFileName({ fileName: record?.relative_path }),
      archiveRelativePath: String(record?.relative_path || ""),
      compatibilitySchema: String(record?.schema || ""),
      compatibilityParserVersion: String(record?.parser_version || ""),
      compatibilityReaderVersion: VERSION
    };
    if (record?.compatibility === "invalid") {
      return record.error_code === "invalid_json"
        ? invalidJsonIssue(file)
        : invalidConversationIssue(file);
    }
    return unsupportedSchemaIssue(file, {
      title: String(record?.title || ""),
      platform: String(record?.platform || "")
    }, {
      schema: String(record?.schema || ""),
      parser_version: String(record?.parser_version || ""),
      parser_adapter: record?.parser_adapter || null,
      reader_version: VERSION
    });
  }

  function updateCompatibilityBanner() {
    const count = state.compatibilityIssues.length;
    dom.compatibilityBanner.hidden = count === 0;
    dom.compatibilityBannerText.textContent = t("dialog.compatibility.banner", { count });
    if (!count && dom.compatibilityDialog.open) dom.compatibilityDialog.close();
  }

  function renderCompatibilityNotice(issues = state.compatibilityIssues) {
    dom.compatibilityList.replaceChildren();
    for (const issue of issues) {
      const item = makeElement("li", "compatibility-item");
      item.append(makeElement("strong", "", issue.file_name));
      const details = makeElement("dl");
      const rows = issue.kind === "invalid_json"
        ? [[t("dialog.compatibility.parse_error"), t("dialog.compatibility.invalid_json")]]
        : issue.kind === "invalid_conversation"
          ? [
            [t("dialog.compatibility.parse_error"), t("dialog.compatibility.invalid_conversation")],
            [t("dialog.compatibility.schema"), issue.schema || t("dialog.compatibility.unknown")],
            [t("dialog.compatibility.parser"), issue.parser_version || t("dialog.compatibility.unknown")],
            [t("dialog.compatibility.adapter"), issue.parser_adapter || t("dialog.compatibility.unknown")],
            [t("dialog.compatibility.reader"), issue.reader_version || VERSION]
          ]
        : [
          [t("dialog.compatibility.schema"), issue.schema || t("dialog.compatibility.unknown")],
          [t("dialog.compatibility.parser"), issue.parser_version || t("dialog.compatibility.unknown")],
          [t("dialog.compatibility.adapter"), issue.parser_adapter || t("dialog.compatibility.unknown")],
          [t("dialog.compatibility.reader"), issue.reader_version || VERSION]
        ];
      for (const [label, value] of rows) {
        details.append(makeElement("dt", "", label), makeElement("dd", "", value));
      }
      item.append(details);
      dom.compatibilityList.append(item);
    }
  }

  function openCompatibilityNotice(issue = null) {
    if (!state.compatibilityIssues.length) return;
    if (dom.nameRuleDialog.open) return;
    const selectedIssue = issue?.file_name ? issue : null;
    renderCompatibilityNotice(selectedIssue ? [selectedIssue] : state.compatibilityIssues);
    if (!dom.compatibilityDialog.open) dom.compatibilityDialog.showModal();
  }

  function reapplyLibraryOverlays() {
    const activeId = state.activeEntry?.id || "";
    state.entries = state.entries.map((entry) => {
      const record = entry.catalogRecord
        ? { ...entry.catalogRecord, relative_path: entry.fileName }
        : null;
      const next = record
        ? entry.bodyLoaded
          ? makeLoadedCatalogEntry(entry.baseDocument || entry.document, record)
          : makeCatalogConversationEntry(record)
        : makeConversationEntry(entry.baseDocument || entry.document, entry.fileName, entry.fileSize, {
            lastModified: entry.fileModifiedAt,
            createdAt: entry.fileCreatedAt
          });
      next.fileObject = entry.fileObject;
      return next;
    });
    state.activeEntry = state.entries.find((entry) => entry.id === activeId) || null;
  }

  async function loadFiles(fileList, { fromFolder = false, folderName = "", replaceEntries = false } = {}) {
    const files = [...fileList]
      .filter((file) => file.name.toLowerCase().endsWith(".json"))
      .sort((left, right) => fileRelativePath(left).localeCompare(
        fileRelativePath(right),
        "zh-CN",
        { numeric: true, sensitivity: "base" }
      ));
    if (!files.length) {
      toast(fromFolder ? "所选文件夹及其子目录中没有找到 .json 档案。" : "没有找到 .json 文件。", true);
      return Object.freeze({ loaded: 0, failures: [], incompatible: [] });
    }
    let loaded = 0;
    const failures = [];
    const newEntries = [];
    const incompatible = [];
    const libraryFile = chooseLibraryCandidate(files);
    if (libraryFile && fromFolder) replaceEntries = true;
    let libraryLoaded = false;
    if (libraryFile) {
      try {
        if (libraryFile.size > 16 * 1024 * 1024) throw new Error("覆盖文件超过 16 MB 安全上限");
        if (libraryFile.parseError) {
          incompatible.push(invalidJsonIssue(libraryFile));
          throw new SyntaxError("Invalid embedded Library JSON");
        }
        const value = JSON.parse(await libraryFile.text());
        state.library = libraryCore.normalizeLibrary(value);
        applyLibraryPreferences(state.library);
        state.libraryFile = libraryFile;
        state.librarySha256 = String(libraryFile.archiveSha256 || "").toLowerCase();
        state.libraryRootPrefix = libraryRootPrefixFromFile(libraryFile);
        state.libraryPersistence = libraryFile.handle?.kind === "file"
          ? "writable-handle"
          : DESKTOP_READER && libraryFile.kind === "library" ? "desktop"
            : libraryFile.kind === "library" ? "embedded" : "read-only-file";
        state.nameRuleScanDone = false;
        libraryLoaded = true;
      } catch (error) {
        if (error?.name === "SyntaxError") {
          if (!incompatible.some((issue) => compatibilityIssueKey(issue) === normalizedRelativePath(libraryFile).toLowerCase())) {
            incompatible.push(invalidJsonIssue(libraryFile));
          }
        } else failures.push(`${libraryFile.name}：${error.message.split("\n")[0]}`);
        if (replaceEntries) {
          state.library = null;
          state.libraryFile = null;
          state.librarySha256 = "";
          state.libraryPersistence = "invalid";
        }
      }
    } else if (replaceEntries) {
      state.library = null;
      state.libraryFile = null;
      state.librarySha256 = "";
      state.libraryRootPrefix = "";
      state.libraryPersistence = "none";
    }

    const conversationFiles = libraryFile
      ? files.filter((file) => file !== libraryFile && isLibraryConversationFile(file, libraryRootPrefixFromFile(libraryFile)))
      : files.filter((file) => file.name.toLowerCase() !== libraryCore.FILE_NAME && !isArchivedConversationFile(file));
    const loadedPaths = new Set(conversationFiles.map((file) => normalizedRelativePath(file).toLowerCase()));
    if (replaceEntries) {
      state.compatibilityIssues = [];
      if (dom.compatibilityDialog.open) dom.compatibilityDialog.close();
    } else {
      state.compatibilityIssues = state.compatibilityIssues
        .filter((issue) => !loadedPaths.has(compatibilityIssueKey(issue)));
    }
    updateCompatibilityBanner();
    for (const file of conversationFiles) {
      let compatibility = null;
      try {
        if (file.size > 256 * 1024 * 1024) throw new Error("文件超过 256 MB 安全上限");
        if (file.parseError) {
          incompatible.push(file.parseError === "invalid_conversation"
            ? invalidConversationIssue(file)
            : invalidJsonIssue(file));
          continue;
        }
        const value = JSON.parse(await file.text());
        compatibility = core.conversationCompatibility(value);
        if (!compatibility.supported) {
          incompatible.push(core.SCHEMAS.has(compatibility.schema)
            ? invalidConversationIssue(file, compatibility)
            : unsupportedSchemaIssue(file, value, compatibility));
          continue;
        }
        const entry = makeConversationEntry(value, normalizedRelativePath(file), file.size, {
          lastModified: file.lastModified,
          createdAt: file.createdAt
        });
        entry.fileObject = file;
        newEntries.push(entry);
        loaded += 1;
      } catch (error) {
        if (error?.name === "SyntaxError") incompatible.push(invalidJsonIssue(file));
        else if (error?.name === "ConversationValidationError") incompatible.push(invalidConversationIssue(file, compatibility));
        else failures.push(`${file.name}：${error.message.split("\n")[0]}`);
      }
    }
    const previousActiveId = state.activeEntry?.id || "";
    if (replaceEntries) state.entries = [...new Map(newEntries.map((entry) => [entry.id, entry])).values()];
    else {
      if (libraryLoaded) reapplyLibraryOverlays();
      const merged = new Map(state.entries.map((entry) => [entry.id, entry]));
      for (const entry of newEntries) merged.set(entry.id, entry);
      state.entries = [...merged.values()];
    }
    state.activeEntry = state.entries.find((entry) => entry.id === previousActiveId) || null;
    if (incompatible.length) {
      const merged = new Map(state.compatibilityIssues.map((issue) => [compatibilityIssueKey(issue), issue]));
      for (const issue of incompatible) merged.set(compatibilityIssueKey(issue), issue);
      state.compatibilityIssues = [...merged.values()].sort((left, right) =>
        left.file_name.localeCompare(right.file_name, "zh-CN", { numeric: true, sensitivity: "base" }));
    }
    updateCompatibilityBanner();
    updatePlatformFilter();
    renderLibrary();
    if (state.activeEntry && (replaceEntries || libraryLoaded)) renderConversation(state.activeEntry);
    else if (!state.activeEntry) showReaderCover();
    if (libraryLoaded) {
      if (dom.compatibilityDialog.open) dom.compatibilityDialog.close();
      maybeShowNameRuleNotice();
    }
    if (loaded || libraryLoaded) {
      const folderLabel = folderName ? `默认目录“${folderName}”` : "文件夹";
      const libraryLabel = libraryLoaded ? "，并应用用户覆盖" : "";
      toast(fromFolder ? `已从${folderLabel}自动载入 ${loaded} 份档案${libraryLabel}。` : `已在本机载入 ${loaded} 份档案${libraryLabel}。`);
    }
    if (failures.length) toast(`有 ${failures.length} 个文件未载入：${failures.slice(0, 3).join("；")}`, true, 7000);
    dom.fileInput.value = "";
    dom.folderInput.value = "";
    updateDefaultDirectoryUi();
    return Object.freeze({ loaded, libraryLoaded, failures: [...failures], incompatible: [...incompatible] });
  }

  function supportsDirectoryHandles() {
    return globalThis.isSecureContext !== false && typeof globalThis.showDirectoryPicker === "function";
  }

  function openDirectoryDatabase() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      let request;
      try { request = globalThis.indexedDB.open(DIRECTORY_DATABASE, 1); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DIRECTORY_STORE)) request.result.createObjectStore(DIRECTORY_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开目录偏好数据库"));
      request.onblocked = () => reject(new Error("目录偏好数据库被其他页面占用"));
    });
  }

  async function readStoredDirectoryHandle() {
    const database = await openDirectoryDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction(DIRECTORY_STORE, "readonly").objectStore(DIRECTORY_STORE).get(DIRECTORY_HANDLE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("无法读取默认目录"));
      });
    } finally { database.close(); }
  }

  async function writeStoredDirectoryHandle(handle) {
    const database = await openDirectoryDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(DIRECTORY_STORE, "readwrite");
        transaction.objectStore(DIRECTORY_STORE).put(handle, DIRECTORY_HANDLE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error("无法保存默认目录"));
        transaction.onerror = () => { /* handled by abort */ };
      });
    } finally { database.close(); }
  }

  function readStoredDirectoryLabel() {
    try { return localStorage.getItem(DIRECTORY_LABEL_KEY) || ""; }
    catch { return ""; }
  }

  function writeStoredDirectoryLabel(label) {
    try { localStorage.setItem(DIRECTORY_LABEL_KEY, label); }
    catch { /* file mode may deny storage */ }
  }

  function updateDefaultDirectoryUi() {
    const handle = state.defaultDirectoryHandle;
    const embedded = DESKTOP_CATALOG_READER ? state.entries.length : EMBEDDED_JSON_COUNT;
    const desktopLabel = state.defaultDirectoryPersistence === "desktop" ? state.defaultDirectoryLabel : "";
    const label = handle?.name || desktopLabel
      || (embedded ? t("directory.embedded_label", { count: embedded }) : state.defaultDirectoryLabel || t("welcome.not_selected"));
    dom.defaultDirectoryLabel.textContent = label;
    if (!state.directoryRestored) {
      dom.defaultDirectoryNote.textContent = t("directory.restoring");
    } else if (handle && state.defaultDirectoryPersistence === "stored") {
      dom.defaultDirectoryNote.textContent = t("directory.stored");
    } else if (handle) {
      dom.defaultDirectoryNote.textContent = t("directory.session");
    } else if (embedded) {
      dom.defaultDirectoryNote.textContent = t("directory.embedded");
    } else if (state.defaultDirectoryLabel) {
      dom.defaultDirectoryNote.textContent = t("directory.remembered_name", { name: state.defaultDirectoryLabel });
    } else {
      dom.defaultDirectoryNote.textContent = t("directory.choose_once");
    }
    dom.openFolder.textContent = handle || embedded ? t("action.open_default_library") : t("action.choose_library_folder");
    dom.welcomeFolder.textContent = handle || embedded ? t("action.open_default_library") : t("action.choose_library_folder");
    refreshReaderCover();
  }

  async function rememberDefaultDirectory(handle) {
    state.directoryRevision += 1;
    state.defaultDirectoryHandle = handle;
    state.defaultDirectoryLabel = handle.name;
    state.defaultDirectoryPersistence = "session";
    writeStoredDirectoryLabel(handle.name);
    try {
      await writeStoredDirectoryHandle(handle);
      state.defaultDirectoryPersistence = "stored";
    } catch { /* fallback remains valid for this page */ }
    updateDefaultDirectoryUi();
  }

  async function restoreDefaultDirectory() {
    if (EMBEDDED_LIBRARY.length) {
      if (DESKTOP_READER) {
        try {
          const libraryInfo = await desktopBridge("reader.library-info");
          const nativeThemeGuideVersion = Number(libraryInfo?.theme_switch_used_version) || 0;
          const promoteThemeGuideVersion = state.themeSwitchUsedVersion >= THEME_SWITCH_GUIDE_VERSION
            && nativeThemeGuideVersion < state.themeSwitchUsedVersion;
          adoptThemeSwitchUsedVersion(nativeThemeGuideVersion);
          if (promoteThemeGuideVersion) syncDesktopTheme({ markSwitchUsed: true });
          state.defaultDirectoryLabel = String(libraryInfo?.path || "").trim() || "内嵌默认档案库";
          state.defaultDirectoryPersistence = libraryInfo?.path ? "desktop" : "embedded";
        } catch {
          state.defaultDirectoryLabel = "内嵌默认档案库";
          state.defaultDirectoryPersistence = "embedded";
        }
      } else {
        state.defaultDirectoryLabel = "内嵌默认档案库";
        state.defaultDirectoryPersistence = "embedded";
      }
      state.directoryRestored = true;
      updateDefaultDirectoryUi();
      return;
    }
    const restoreRevision = state.directoryRevision;
    state.defaultDirectoryLabel = readStoredDirectoryLabel();
    try {
      const handle = await readStoredDirectoryHandle();
      if (restoreRevision === state.directoryRevision && handle?.kind === "directory") {
        state.defaultDirectoryHandle = handle;
        state.defaultDirectoryLabel = handle.name;
        state.defaultDirectoryPersistence = "stored";
      }
    } catch { /* unsupported or denied storage uses the folder-input fallback */ }
    state.directoryRestored = true;
    updateDefaultDirectoryUi();
  }

  async function verifyDirectoryPermission(handle, mode = "read") {
    const options = { mode };
    if (typeof handle.queryPermission !== "function") return true;
    if (await handle.queryPermission(options) === "granted") return true;
    return typeof handle.requestPermission === "function" && await handle.requestPermission(options) === "granted";
  }

  async function collectDirectoryJsonFiles(directoryHandle, relativeRoot = directoryHandle.name, depth = 0, output = []) {
    if (depth > MAX_DIRECTORY_DEPTH) throw new Error(`目录层级超过 ${MAX_DIRECTORY_DEPTH} 层安全上限`);
    const entries = [];
    for await (const entry of directoryHandle.values()) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    for (const entry of entries) {
      const relativePath = `${relativeRoot}/${entry.name}`;
      if (entry.kind === "directory") {
        await collectDirectoryJsonFiles(entry, relativePath, depth + 1, output);
      } else if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".json")) {
        const file = await entry.getFile();
        output.push({
          name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
          archiveRelativePath: relativePath, handle: entry, text: () => file.text()
        });
        if (output.length > MAX_DIRECTORY_JSON_FILES) throw new Error(`JSON 文件超过 ${MAX_DIRECTORY_JSON_FILES} 份安全上限`);
      }
    }
    return output;
  }

  async function loadDirectoryHandle(handle) {
    if (!handle || handle.kind !== "directory") throw new Error("默认目录句柄无效");
    const files = await collectDirectoryJsonFiles(handle);
    return loadFiles(files, { fromFolder: true, folderName: handle.name });
  }

  async function loadEmbeddedLibrary({ announce = true } = {}) {
    if (!EMBEDDED_LIBRARY.length) return Object.freeze({ loaded: 0, failures: [], incompatible: [] });
    const files = EMBEDDED_LIBRARY.filter((entry) => entry?.kind !== "asset").map((entry) => ({
      kind: String(entry.kind || "conversation"),
      name: String(entry.name || "archive.json"),
      size: Number(entry.bytes || String(entry.serialized || "").length),
      type: "application/json",
      createdAt: String(entry.created_at || ""),
      lastModified: Number.isFinite(Date.parse(entry.modified_at)) ? Date.parse(entry.modified_at) : 0,
      archiveRelativePath: String(entry.relative_path || entry.name || "archive.json"),
      archiveSha256: String(entry.sha256 || ""),
      parseError: String(entry.parse_error || ""),
      compatibilitySchema: String(entry.schema || ""),
      compatibilityParserVersion: String(entry.parser_version || ""),
      compatibilityReaderVersion: String(entry.reader_version || ""),
      text: async () => String(entry.serialized || "")
    }));
    let result;
    try {
      result = await loadFiles(files, {
        fromFolder: announce,
        folderName: "内嵌档案库",
        replaceEntries: true
      });
    } finally {
      if (!DESKTOP_CATALOG_READER) state.embeddedLibraryPending = false;
      if (!state.activeEntry) showReaderCover();
    }
    if (!announce && result.failures.length) toast(`内嵌档案库有 ${result.failures.length} 份未载入。`, true, 7000);
    return result;
  }

  async function chooseDefaultDirectory() {
    if (!supportsDirectoryHandles()) { dom.folderInput.click(); return null; }
    const options = { id: DIRECTORY_PICKER_ID, mode: "readwrite" };
    if (state.defaultDirectoryHandle) options.startIn = state.defaultDirectoryHandle;
    try {
      const handle = await globalThis.showDirectoryPicker(options);
      await rememberDefaultDirectory(handle);
      await loadDirectoryHandle(handle);
      return handle;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      toast(`无法打开默认目录：${error?.message || error}`, true, 7000);
      return null;
    }
  }

  async function openDefaultDirectory() {
    const handle = state.defaultDirectoryHandle;
    if (!handle && EMBEDDED_LIBRARY.length) {
      const result = await loadEmbeddedLibrary();
      if (DESKTOP_CATALOG_READER) {
        await refreshDesktopArchiveSnapshot({ rerender: false });
        state.embeddedLibraryPending = false;
        showReaderCover();
      }
      return result;
    }
    if (!handle) return chooseDefaultDirectory();
    try {
      if (!await verifyDirectoryPermission(handle)) {
        toast("默认目录尚未获得读取权限，请点击“更改目录”重新授权。", true, 7000);
        return null;
      }
      await loadDirectoryHandle(handle);
      return handle;
    } catch (error) {
      toast(`无法读取默认目录：${error?.message || error}`, true, 7000);
      return null;
    }
  }

  function rememberFolderInputSelection(fileList) {
    const first = [...fileList].find((file) => file.webkitRelativePath) || null;
    const label = first?.webkitRelativePath?.split("/")[0] || "已选择的档案目录";
    state.directoryRevision += 1;
    state.defaultDirectoryHandle = null;
    state.defaultDirectoryLabel = label;
    state.defaultDirectoryPersistence = "label-only";
    state.directoryRestored = true;
    writeStoredDirectoryLabel(label);
    updateDefaultDirectoryUi();
    return label;
  }

  function renderSourceDialog() {
    dom.sourceDialogBody.replaceChildren();
    if (!state.activeEntry) return;
    const documentData = state.activeEntry.document;
    const sources = documentData.sources || [];
    const resources = (documentData.resources || []).filter((resource) => resource.url);
    if (!sources.length && !resources.length) {
      dom.sourceDialogBody.append(makeElement("div", "empty-list", t("fallback.no_sources")));
      return;
    }
    if (sources.length) {
      const section = makeElement("section", "source-section"); section.append(makeElement("h3", "", t("sources.search_section", { count: sources.length })));
      for (const source of sources) {
        const card = makeElement("div", "source-entry");
        card.append(makeElement("strong", "", source.title || source.site_name || source.id), makeExternalAnchor(source.url, source.url));
        if (source.snippet) card.append(makeElement("span", "", source.snippet));
        section.append(card);
      }
      dom.sourceDialogBody.append(section);
    }
    if (resources.length) {
      const section = makeElement("section", "source-section"); section.append(makeElement("h3", "", t("sources.resource_section", { count: resources.length })));
      for (const resource of resources) {
        const card = makeElement("div", "source-entry");
        card.append(makeElement("strong", "", resource.name || resource.id), makeExternalAnchor(resource.url, resource.url));
        const meta = resourceMeta(resource); if (meta) card.append(makeElement("span", "", meta));
        section.append(card);
      }
      dom.sourceDialogBody.append(section);
    }
  }

  function openImage(dataUrl, alt, caption) {
    dom.imageDialogImage.src = dataUrl;
    dom.imageDialogImage.alt = alt || t("fallback.archive_image");
    dom.imageDialogCaption.textContent = caption || alt || "";
    dom.imageDialog.showModal();
  }

  function downloadTextFile(serialized, fileName) {
    const blob = new Blob([serialized], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function persistLibrary(nextLibrary) {
    const normalized = libraryCore.normalizeLibrary(nextLibrary);
    const serialized = libraryCore.serializeLibrary(normalized);
    const handle = state.libraryFile?.handle;
    let persistence = "download";
    if (DESKTOP_READER) {
      if (!/^[0-9a-f]{64}$/u.test(state.librarySha256)) throw new Error("当前 Reader 缺少覆盖文件版本，请返回管理页后重新打开。");
      const saved = await desktopBridge("reader.save-library", {
        library: normalized,
        expected_sha256: state.librarySha256
      });
      state.librarySha256 = String(saved.sha256 || "").toLowerCase();
      state.libraryFile = {
        ...state.libraryFile,
        size: Number(saved.bytes) || new Blob([serialized]).size,
        archiveSha256: state.librarySha256,
        text: async () => serialized
      };
      state.libraryPersistence = "desktop";
      persistence = "desktop";
    } else if (handle?.kind === "file" && typeof handle.createWritable === "function") {
      if (!await verifyDirectoryPermission(handle, "readwrite")) throw new Error("没有 cloudig-library.json 的写入权限");
      const writable = await handle.createWritable();
      try {
        await writable.write(serialized);
        await writable.close();
      } catch (error) {
        try { await writable.abort?.(); } catch { /* best-effort rollback */ }
        throw error;
      }
      state.libraryFile = {
        ...state.libraryFile,
        size: new Blob([serialized]).size,
        text: async () => serialized,
        handle
      };
      state.libraryPersistence = "written";
      persistence = "written";
    } else {
      downloadTextFile(serialized, libraryCore.FILE_NAME);
      state.libraryPersistence = "downloaded-copy";
    }
    const activeId = state.activeEntry?.id || "";
    state.library = normalized;
    applyLibraryPreferences(state.library);
    reapplyLibraryOverlays();
    const active = state.entries.find((entry) => entry.id === activeId) || state.entries[0] || null;
    updatePlatformFilter();
    renderLibrary();
    if (active) renderConversation(active);
    if (persistence === "desktop") toast(t("toast.library_saved_desktop"));
    else if (persistence === "written") toast(t("toast.library_saved"));
    else toast("当前入口没有资料库写权限，已下载新的 cloudig-library.json；当前页面已应用，请用下载文件替换原覆盖文件。", true, 8000);
    return persistence;
  }

  function maybeShowNameRuleNotice() {
    if (!state.library || state.nameRuleScanDone) return false;
    state.nameRuleScanDone = true;
    const acknowledged = Number(state.library.preferences?.name_rule_ack_version) || 0;
    if (acknowledged >= NAME_RULE_VERSION) return false;
    const mismatch = state.entries.find((entry) => !core.conversationNameMatchesFile(
      entry.document?.title,
      currentJsonFileName(entry)
    ));
    if (!mismatch) return false;
    dom.nameRuleAck.checked = false;
    dom.nameRuleDialog.showModal();
    return true;
  }

  async function closeNameRuleNotice() {
    if (!dom.nameRuleDialog.open) return;
    if (!dom.nameRuleAck.checked) {
      dom.nameRuleDialog.close();
      return;
    }
    if (!state.library) {
      dom.nameRuleDialog.close();
      return;
    }
    try {
      const next = libraryCore.updateLibrarySettings(state.library, {
        preferences: { name_rule_ack_version: NAME_RULE_VERSION }
      });
      await persistLibrary(next);
      dom.nameRuleDialog.close();
    } catch (error) {
      toast(`名称规则已阅状态保存失败：${error?.message || error}`, true, 8000);
    }
  }

  function sameStringArray(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function editorRadioValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || "";
  }

  function setEditorRadio(name, value) {
    const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (radio) radio.checked = true;
  }

  function editorInput(prefix, field) {
    return dom[`edit${prefix[0].toUpperCase()}${prefix.slice(1)}${field[0].toUpperCase()}${field.slice(1)}`];
  }

  function endpointPrimaryType(endpoint, isEnd = false) {
    if (isEnd && !endpoint) return "same";
    if (!endpoint || endpoint.type === "exact") return "exact";
    if (endpoint.type === "unknown") return "unknown";
    return "general";
  }

  function fillTimeEndpoint(prefix, endpoint, { end = false } = {}) {
    const primary = endpointPrimaryType(endpoint, end);
    setEditorRadio(`edit-${prefix}-type`, primary);
    setEditorRadio(`edit-${prefix}-era`, endpoint?.era === "BC" ? "BC" : "AD");
    editorInput(prefix, "precision").value = ["month", "year", "decade"].includes(endpoint?.type) ? endpoint.type : "month";
    for (const field of ["year", "month", "day", "hour", "minute"]) {
      editorInput(prefix, field).value = endpoint?.[field] ?? "";
    }
    editorInput(prefix, "timezone").value = endpoint?.timezone || "";
    updateTimeEndpointFields(prefix);
  }

  function updateTimeEndpointFields(prefix) {
    const primary = editorRadioValue(`edit-${prefix}-type`);
    const fields = editorInput(prefix, "fields");
    const precision = editorInput(prefix, "precision");
    const isGeneral = primary === "general";
    const isExact = primary === "exact";
    fields.hidden = ["unknown", "same"].includes(primary);
    if (fields.hidden) return;
    const generalPrecision = precision.value || "month";
    const visibility = {
      precision: isGeneral,
      year: true,
      month: isExact || (isGeneral && generalPrecision === "month"),
      day: isExact,
      hour: isExact,
      minute: isExact,
      timezone: isExact
    };
    for (const [field, visible] of Object.entries(visibility)) {
      editorInput(prefix, field).dataset.timeHidden = visible ? "false" : "true";
    }
    fields.querySelector(".conversation-time-colon").dataset.timeHidden = isExact ? "false" : "true";
  }

  function integerTimeField(prefix, field, label, minimum, maximum) {
    const raw = editorInput(prefix, field).value.trim();
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(t("dialog.edit.invalid_number", { field: label, min: minimum, max: maximum }));
    }
    return value;
  }

  function validContentCalendarDate(year, month, day) {
    const monthDays = [31, ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= monthDays[month - 1];
  }

  function readTimeEndpoint(prefix) {
    const primary = editorRadioValue(`edit-${prefix}-type`);
    if (primary === "same") return null;
    if (primary === "unknown") return { type: "unknown" };
    const era = editorRadioValue(`edit-${prefix}-era`) === "BC" ? "BC" : undefined;
    const year = integerTimeField(prefix, "year", t("dialog.edit.unit_year"), 1, 9999);
    if (primary === "general") {
      const type = editorInput(prefix, "precision").value;
      if (type === "decade" && year % 10 !== 0) throw new Error(t("dialog.edit.decade_multiple"));
      const endpoint = { type, ...(era ? { era } : {}), year };
      if (type === "month") endpoint.month = integerTimeField(prefix, "month", t("dialog.edit.unit_month"), 1, 12);
      return endpoint;
    }
    const month = integerTimeField(prefix, "month", t("dialog.edit.unit_month"), 1, 12);
    const day = integerTimeField(prefix, "day", t("dialog.edit.unit_day"), 1, 31);
    if (!validContentCalendarDate(year, month, day)) throw new Error(t("dialog.edit.invalid_date"));
    const endpoint = { type: "exact", ...(era ? { era } : {}), year, month, day };
    const hourText = editorInput(prefix, "hour").value.trim();
    const minuteText = editorInput(prefix, "minute").value.trim();
    if (Boolean(hourText) !== Boolean(minuteText)) throw new Error(t("dialog.edit.hour_minute_pair"));
    if (hourText) {
      endpoint.hour = integerTimeField(prefix, "hour", t("dialog.edit.unit_hour"), 0, 23);
      endpoint.minute = integerTimeField(prefix, "minute", t("dialog.edit.unit_minute"), 0, 59);
    }
    const timezone = editorInput(prefix, "timezone").value;
    if (timezone) endpoint.timezone = timezone;
    return endpoint;
  }

  function readConversationTimeDraft() {
    const start = readTimeEndpoint("start");
    const end = readTimeEndpoint("end");
    return libraryCore.normalizeContentTime({ start, ...(end ? { end } : {}) });
  }

  function updateConversationTimePreview() {
    const applied = state.conversationEditDraft?.appliedTime;
    dom.editTimePreview.textContent = applied
      ? libraryCore.formatContentTime(applied, state.language)
      : t("dialog.edit.time_placeholder");
    const startKey = applied ? libraryCore.contentTimeSortKey(applied) : null;
    const endKey = applied?.end ? libraryCore.contentTimeSortKey({ start: applied.end }) : null;
    const reversed = Number.isFinite(startKey) && Number.isFinite(endKey) && startKey > endKey;
    dom.editTimeWarning.hidden = !reversed;
    dom.editTimeWarning.textContent = reversed ? t("dialog.edit.reverse_warning") : "";
    dom.editTimeInstruction.dataset.dirty = state.conversationEditDraft?.timeDirty ? "true" : "false";
  }

  function markConversationTimeDirty() {
    if (!state.conversationEditDraft) return;
    state.conversationEditDraft.timeDirty = true;
    updateConversationTimePreview();
  }

  function confirmConversationTime() {
    try {
      state.conversationEditDraft.appliedTime = readConversationTimeDraft();
      state.conversationEditDraft.timeDirty = false;
      updateConversationTimePreview();
    } catch (error) {
      toast(error.message, true, 7000);
    }
  }

  function clearConversationTime() {
    if (!state.conversationEditDraft) return;
    state.conversationEditDraft.appliedTime = null;
    state.conversationEditDraft.timeDirty = false;
    updateConversationTimePreview();
  }

  function renderConversationEditorModels() {
    const models = state.conversationEditDraft?.models || [];
    dom.editConversationModels.replaceChildren(...models.map((model, index) => {
      const chip = makeElement("span", "conversation-info-model-chip");
      chip.append(makeElement("span", "", model));
      const remove = makeElement("button", "", "×");
      remove.type = "button";
      remove.dataset.modelIndex = String(index);
      remove.dataset.cloudigTooltipAuto = "";
      remove.setAttribute("aria-label", t("dialog.edit.remove_model", { model }));
      chip.append(remove);
      return chip;
    }));
  }

  function commitConversationModelInput(input) {
    const model = input.value.trim();
    input.remove();
    if (model && state.conversationEditDraft && !state.conversationEditDraft.models.includes(model)) {
      state.conversationEditDraft.models.push(model);
      renderConversationEditorModels();
    }
  }

  function startConversationModelInput() {
    const existing = dom.editConversationModels.querySelector("input");
    if (existing) { existing.focus(); return; }
    const input = makeElement("input", "conversation-info-model-chip conversation-info-model-input");
    input.type = "text";
    input.maxLength = 120;
    input.placeholder = t("dialog.edit.model_placeholder");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); commitConversationModelInput(input); }
      else if (event.key === "Escape") input.remove();
    });
    input.addEventListener("blur", () => commitConversationModelInput(input), { once: true });
    dom.editConversationModels.append(input);
    input.focus();
  }

  function conversationMessageRange(documentData) {
    const timestamps = (documentData.messages || []).map((message) => message.timestamp).filter((value) => Number.isFinite(Date.parse(value)));
    if (!timestamps.length) return "";
    const start = formatDate(timestamps[0]);
    const end = formatDate(timestamps.at(-1));
    return start === end ? start : `${start} — ${end}`;
  }

  function fillConversationEditor(entry) {
    const base = entry.baseDocument || entry.document;
    const effective = entry.document;
    const override = libraryCore.conversationOverride(state.library, base) || {};
    const appliedTime = override.content_time ? libraryCore.normalizeContentTime(override.content_time) : null;
    const seedTime = appliedTime || libraryCore.normalizeContentTime(base.content_time) || { start: { type: "exact" } };
    state.conversationEditDraft = {
      models: [...(effective.models || [])],
      appliedTime: appliedTime ? JSON.parse(JSON.stringify(appliedTime)) : null,
      timeDirty: false
    };
    dom.editConversationTitle.value = effective.title || "";
    dom.editConversationPlatform.value = effective.platform || "";
    const editorPlatform = String(effective.platform || "").trim().toLowerCase();
    dom.editConversationPlatformIcon.src = platformAsset(editorPlatform) || readerAsset("brand.seal");
    dom.editConversationPlatformIcon.alt = platformLabel(effective);
    dom.editConversationPlatformIcon.dataset.platform = editorPlatform;
    dom.editConversationFileName.textContent = currentJsonFileName(entry);
    const fileModified = Number(entry.fileObject?.lastModified || entry.fileModifiedAt) || 0;
    const created = base.parsed_at || entry.fileCreatedAt || "";
    dom.editConversationJsonTimes.textContent = `${t("dialog.edit.json_modified")}：${fileModified ? formatDate(fileModified) : "—"}　${t("dialog.edit.json_created")}：${created ? formatDate(created) : "—"}`;
    const messageRange = conversationMessageRange(base);
    dom.editConversationMessageTimes.textContent = `${t("dialog.edit.message_time")}：${messageRange || "—"}`;
    dom.editConversationSourceFile.textContent = `${t("dialog.edit.source_file")}：${base.source_file || "—"}`;
    const sourceTime = base.source_created_at || base.exported_at || "";
    dom.editConversationSourceTime.textContent = `${t("dialog.edit.source_time")}：${sourceTime ? formatDate(sourceTime) : "—"}`;
    dom.conversationInfoArtDawn.src = readerAsset("cover.EditorBack-Tao.svg");
    dom.conversationInfoArtNight.src = readerAsset("cover.EditorBack-Drawer.svg");
    renderConversationEditorModels();
    fillTimeEndpoint("start", seedTime.start || { type: "unknown" });
    fillTimeEndpoint("end", seedTime.end, { end: true });
    updateConversationTimePreview();
  }

  function openConversationEditor() {
    if (!state.activeEntry) return;
    if (state.activeEntry.sourceDocument?.schema === core.V1_SCHEMA) {
      if (DESKTOP_READER) {
        const relativePath = String(state.activeEntry.fileName || "").replaceAll("\\", "/");
        void navigateWithCloudigBoot(`https://cloudig.local/index.html?open=conversation&path=${encodeURIComponent(relativePath)}#manager`);
      } else toast(t("dialog.edit.desktop_time_system"), true, 8000);
      return;
    }
    if (!state.library) {
      toast("当前载入的是旧式 JSON 目录，没有 cloudig-library.json；请先初始化采云资料库。", true, 7000);
      return;
    }
    fillConversationEditor(state.activeEntry);
    dom.conversationEditDialog.showModal();
  }

  function openContentTimeSystem() {
    if (DESKTOP_READER) {
      void navigateWithCloudigBoot("https://cloudig.local/index.html?open=time&origin=reader#manager");
    } else toast(t("dialog.edit.desktop_time_system"), true, 8000);
  }

  async function saveConversationEditor(event) {
    event.preventDefault();
    if (!state.activeEntry || !state.library) return;
    if (state.conversationEditDraft?.timeDirty) {
      toast(t("dialog.edit.confirm_time_first"), true, 7000);
      dom.editTimeConfirm.focus();
      return;
    }
    const base = state.activeEntry.baseDocument || state.activeEntry.document;
    const models = state.conversationEditDraft?.models || [];
    const baseModels = Array.isArray(base.models) ? base.models : [];
    const appliedTime = state.conversationEditDraft?.appliedTime || null;
    const patch = {
      conversation_name: dom.editConversationTitle.value.trim() === base.title ? "" : dom.editConversationTitle.value,
      content_time: appliedTime && !libraryCore.sameContentTime(appliedTime, base.content_time) ? appliedTime : "",
      platform: dom.editConversationPlatform.value.trim() === base.platform ? "" : dom.editConversationPlatform.value,
      models: sameStringArray(models, baseModels) ? [] : models
    };
    try {
      const next = libraryCore.setConversationOverride(state.library, state.activeEntry.libraryKey, patch);
      await persistLibrary(next);
      dom.conversationEditDialog.close();
      state.conversationEditDraft = null;
    } catch (error) {
      toast(`会话覆盖保存失败：${error?.message || error}`, true, 8000);
    }
  }

  function identityDraftAvatarUrl(pathValue, fallback) {
    const path = libraryCore.cleanString(pathValue);
    if (!path) return fallback;
    const key = path.replaceAll("\\", "/").toLowerCase();
    return state.identityDraftAssets.get(key) || EMBEDDED_ASSETS.get(key) || fallback;
  }

  function identityIcon(symbol) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "reader-ui-icon");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#${symbol}`);
    svg.append(use);
    return svg;
  }

  function pruneIdentityPlatform(platform) {
    const override = state.identityDraft?.platform_overrides?.[platform];
    if (!override) return;
    if (!override.icon && !override.assistant_name && !override.assistant_avatar) {
      delete state.identityDraft.platform_overrides[platform];
    }
  }

  function pruneIdentityDraft() {
    if (!state.identityDraft) return;
    const user = state.identityDraft.user;
    if (user && !user.display_name && !user.avatar) delete state.identityDraft.user;
    const assistant = state.identityDraft.assistant;
    if (assistant && !assistant.display_name && !assistant.avatar && assistant.apply_to_all !== true) {
      delete state.identityDraft.assistant;
    }
    for (const platform of Object.keys(state.identityDraft.platform_overrides || {})) {
      pruneIdentityPlatform(platform);
    }
    if (state.identityDraft.platform_overrides
      && Object.keys(state.identityDraft.platform_overrides).length === 0) {
      delete state.identityDraft.platform_overrides;
    }
  }

  function renderIdentityPlatformGrid() {
    if (!state.identityDraft) return;
    const overrides = state.identityDraft.platform_overrides || {};
    const cards = IDENTITY_PLATFORM_ORDER.map((platform) => {
      const override = overrides[platform] || {};
      const card = makeElement("article", "identity-platform-card");
      card.dataset.platform = platform;
      card.style.setProperty("--platform-color", PLATFORM_COLORS[platform] || "#7e5eff");

      const avatar = makeElement("div", "identity-platform-avatar");
      avatar.dataset.platform = platform;
      const image = document.createElement("img");
      image.alt = "";
      image.src = identityDraftAvatarUrl(override.assistant_avatar, assistantAvatarAsset(platform));
      avatar.append(image);

      const copy = makeElement("div", "identity-platform-copy");
      const heading = makeElement("div", "identity-platform-heading");
      const label = makeElement("strong", "", identityPlatformLabel(platform));
      const actions = makeElement("div", "identity-platform-actions");

      const upload = makeElement("button", "identity-platform-upload");
      upload.type = "button";
      upload.dataset.identityAction = "upload-platform-avatar";
      upload.dataset.platform = platform;
      upload.dataset.cloudigTooltipAuto = "";
      upload.setAttribute("aria-label", t("identity.upload_platform_avatar", { platform: label.textContent }));
      upload.append(identityIcon("reader-icon-upload"));

      const remove = makeElement("button", "identity-platform-remove");
      remove.type = "button";
      remove.dataset.identityAction = "remove-platform-avatar";
      remove.dataset.platform = platform;
      remove.dataset.cloudigTooltipAuto = "";
      remove.hidden = !override.assistant_avatar;
      remove.setAttribute("aria-label", t("identity.remove_platform_avatar", { platform: label.textContent }));
      remove.append(identityIcon("reader-icon-close"));
      avatar.append(remove);
      actions.append(upload);
      heading.append(label, actions);

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 100;
      input.className = "identity-platform-name";
      input.dataset.platformName = platform;
      input.value = override.assistant_name || "";
      input.placeholder = identityPlatformLabel(platform);
      input.setAttribute("aria-label", t("identity.platform_name_label", { platform: input.placeholder }));
      copy.append(heading, input);
      card.append(avatar, copy);
      return card;
    });
    dom.identityPlatformGrid.replaceChildren(...cards);
  }

  function setIdentityAvatarPreview(image, remove, pathValue, fallback) {
    image.src = identityDraftAvatarUrl(pathValue, fallback);
    remove.hidden = !libraryCore.cleanString(pathValue);
  }

  function renderIdentityEditor() {
    if (!state.identityDraft) return;
    const user = state.identityDraft.user || {};
    const assistant = state.identityDraft.assistant || {};
    const conversationMode = state.identityMode === "conversation" && Boolean(state.activeEntry);
    const conversationOverride = conversationMode
      ? libraryCore.conversationOverride(state.identityDraft, state.activeEntry.baseDocument || state.activeEntry.document) || {}
      : {};
    dom.conversationNameSection.hidden = !conversationMode;
    dom.identityDialogTitle.textContent = t(conversationMode ? "identity.conversation_dialog_title" : "identity.global_title");
    dom.identityDialogIntro.textContent = t(conversationMode ? "identity.conversation_dialog_intro" : "identity.global_intro");
    dom.identityConversationUserName.value = conversationOverride.user_name || "";
    dom.identityConversationAssistantName.value = conversationOverride.assistant_name || "";
    dom.editUserName.value = user.display_name || "";
    dom.editAssistantName.value = assistant.display_name || "";
    dom.identityApplyToAll.checked = assistant.apply_to_all === true;
    setIdentityAvatarPreview(
      dom.identityUserAvatarPreview,
      dom.identityUserAvatarRemove,
      user.avatar,
      readerAsset("cover.OsisLogo-Cloudig-1024.png")
    );
    setIdentityAvatarPreview(
      dom.identityAssistantAvatarPreview,
      dom.identityAssistantAvatarRemove,
      assistant.avatar,
      readerAsset("cover.OsisLogo-Simple.svg")
    );
    renderIdentityPlatformGrid();
  }

  function captureIdentityEditor() {
    if (!state.identityDraft) return;
    state.identityDraft.user ||= {};
    state.identityDraft.assistant ||= {};
    state.identityDraft.platform_overrides ||= {};
    const userName = dom.editUserName.value.trim();
    const assistantName = dom.editAssistantName.value.trim();
    if (userName) state.identityDraft.user.display_name = userName;
    else delete state.identityDraft.user.display_name;
    if (assistantName) state.identityDraft.assistant.display_name = assistantName;
    else delete state.identityDraft.assistant.display_name;
    if (dom.identityApplyToAll.checked) state.identityDraft.assistant.apply_to_all = true;
    else delete state.identityDraft.assistant.apply_to_all;
    for (const input of dom.identityPlatformGrid.querySelectorAll("[data-platform-name]")) {
      const platform = input.dataset.platformName;
      state.identityDraft.platform_overrides[platform] ||= {};
      const value = input.value.trim();
      if (value) state.identityDraft.platform_overrides[platform].assistant_name = value;
      else delete state.identityDraft.platform_overrides[platform].assistant_name;
      pruneIdentityPlatform(platform);
    }
    pruneIdentityDraft();
    if (state.identityMode === "conversation" && state.activeEntry?.libraryKey) {
      state.identityDraft = libraryCore.setConversationOverride(
        state.identityDraft,
        state.activeEntry.libraryKey,
        {
          user_name: dom.identityConversationUserName.value,
          assistant_name: dom.identityConversationAssistantName.value
        }
      );
    }
  }

  function openProfileEditor(mode = "global") {
    if (!state.library) {
      toast("当前目录没有 cloudig-library.json；请先初始化采云资料库。", true, 7000);
      return;
    }
    state.identityMode = mode === "conversation" && state.activeEntry ? "conversation" : "global";
    state.identityDraft = JSON.parse(JSON.stringify(state.library));
    state.identityDraftAssets = new Map();
    renderIdentityEditor();
    dom.profileEditDialog.showModal();
    globalThis.setTimeout(() => {
      (state.identityMode === "conversation" ? dom.identityConversationUserName : dom.editUserName).focus();
    }, 0);
  }

  function closeIdentityEditor() {
    state.identityDraft = null;
    state.identityDraftAssets = new Map();
    state.identityMode = "global";
    dom.profileEditDialog.close();
  }

  function identityAvatarTarget(usage, platform = "") {
    if (usage === "user_avatar") {
      state.identityDraft.user ||= {};
      return { owner: state.identityDraft.user, field: "avatar", serviceUsage: usage };
    }
    if (usage === "assistant_avatar") {
      state.identityDraft.assistant ||= {};
      return { owner: state.identityDraft.assistant, field: "avatar", serviceUsage: usage };
    }
    state.identityDraft.platform_overrides ||= {};
    state.identityDraft.platform_overrides[platform] ||= {};
    return {
      owner: state.identityDraft.platform_overrides[platform],
      field: "assistant_avatar",
      serviceUsage: `platform_assistant_avatar:${platform}`
    };
  }

  async function chooseIdentityAvatar(usage, platform = "") {
    if (!state.identityDraft) return;
    captureIdentityEditor();
    if (!DESKTOP_READER) {
      toast(t("identity.avatar_desktop_only"), true, 7000);
      return;
    }
    const target = identityAvatarTarget(usage, platform);
    try {
      const selection = await desktopBridge("reader.choose-asset", { usage: target.serviceUsage });
      if (!selection?.file) return;
      const asset = await desktopBridge("reader.import-asset", {
        file: selection.file,
        usage: target.serviceUsage
      });
      target.owner[target.field] = asset.path;
      const key = String(asset.path || "").replaceAll("\\", "/").toLowerCase();
      if (key && asset.data_url) {
        state.identityDraftAssets.set(key, asset.data_url);
        EMBEDDED_ASSETS.set(key, asset.data_url);
      }
      renderIdentityEditor();
    } catch (error) {
      toast(`${t("identity.avatar_failed")}：${error?.message || error}`, true, 8000);
    }
  }

  function removeIdentityAvatar(usage, platform = "") {
    if (!state.identityDraft) return;
    captureIdentityEditor();
    const target = identityAvatarTarget(usage, platform);
    const oldPath = libraryCore.cleanString(target.owner[target.field]);
    delete target.owner[target.field];
    if (oldPath) state.identityDraftAssets.delete(oldPath.replaceAll("\\", "/").toLowerCase());
    if (platform) pruneIdentityPlatform(platform);
    pruneIdentityDraft();
    renderIdentityEditor();
  }

  async function saveProfileEditor(event) {
    event.preventDefault();
    if (!state.identityDraft) return;
    try {
      captureIdentityEditor();
      const next = libraryCore.normalizeLibrary(state.identityDraft);
      await persistLibrary(next);
      closeIdentityEditor();
    } catch (error) {
      toast(`${t("identity.save_failed")}：${error?.message || error}`, true, 8000);
    }
  }

  async function openActiveJson() {
    if (!state.activeEntry) return;
    if (DESKTOP_READER) {
      try {
        await desktopBridge("reader.open-json", { relative_path: state.activeEntry.fileName });
      } catch (error) {
        toast(`无法打开 JSON 文件：${error?.message || error}`, true, 7000);
      }
      return;
    }
    const parserDocument = state.activeEntry.baseDocument || state.activeEntry.document;
    const blob = state.activeEntry.fileObject instanceof Blob
      ? state.activeEntry.fileObject
      : new Blob([`${JSON.stringify(parserDocument, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    globalThis.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function activeMarkdown() {
    if (!state.activeEntry) return "";
    const identity = identityForDocument(state.activeEntry.document);
    return core.documentToMarkdown(state.activeEntry.document, {
      userName: identity.user.display_name,
      assistantName: identity.assistant.display_name
    });
  }

  function showMarkdownPreview() {
    if (!state.activeEntry) return;
    dom.markdownPreview.value = activeMarkdown();
    dom.markdownDialog.showModal();
  }

  async function copyActiveMarkdown() {
    const markdown = activeMarkdown();
    if (!markdown) return false;
    try {
      await navigator.clipboard.writeText(markdown);
      toast(t("toast.markdown_copied"));
      return true;
    } catch {
      dom.markdownPreview.value = markdown;
      dom.markdownPreview.focus();
      dom.markdownPreview.select();
      const copied = typeof document.execCommand === "function" && document.execCommand("copy");
      if (copied) toast(t("toast.markdown_copied"));
      else toast(t("toast.markdown_manual_copy"), true, 7000);
      if (!dom.markdownDialog.open) dom.markdownDialog.showModal();
      return Boolean(copied);
    }
  }

  async function saveActiveMarkdown() {
    if (!state.activeEntry) return null;
    const markdown = activeMarkdown();
    const fileName = core.markdownFileName(state.activeEntry.document);
    try {
      if (DESKTOP_READER) {
        const result = await desktopBridge("reader.save-markdown", { file_name: fileName, markdown });
        toast(t("toast.markdown_saved_desktop", { name: result.file_name || fileName }));
        return result;
      }
      downloadTextFile(markdown, fileName);
      toast(t("toast.markdown_saved", { name: fileName }));
      return { ok: true, status: "downloaded", file_name: fileName };
    } catch (error) {
      toast(t("toast.markdown_failed", { message: error?.message || error }), true, 8000);
      return null;
    }
  }

  async function copyCode(button) {
    const code = button.closest(".code-card")?.querySelector("code")?.textContent || "";
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = t("toast.code_copied");
      setTimeout(() => { button.textContent = t("action.copy"); }, 1200);
    } catch { toast(t("toast.copy_denied"), true); }
  }

  function toast(message, isError = false, duration = 3600) {
    const node = makeElement("div", `toast${isError ? " error" : ""}`, message);
    dom.toastRegion.append(node);
    setTimeout(() => node.remove(), duration);
  }

  function adoptThemeSwitchUsedVersion(value) {
    const version = Number(value) || 0;
    if (version <= state.themeSwitchUsedVersion) return;
    state.themeSwitchUsedVersion = version;
    try { localStorage.setItem(THEME_SWITCH_GUIDE_KEY, String(version)); }
    catch { /* The desktop setting remains authoritative. */ }
    if (version >= THEME_SWITCH_GUIDE_VERSION) hideThemeCoachmark();
  }

  function completeThemeSwitchGuide() {
    adoptThemeSwitchUsedVersion(THEME_SWITCH_GUIDE_VERSION);
  }

  function hideThemeCoachmark({ dismissSession = false } = {}) {
    globalThis.clearTimeout(state.themeCoachmarkTimer);
    state.themeCoachmarkTimer = 0;
    if (dismissSession) state.themeCoachmarkDismissed = true;
    dom.readerThemeCoachmark?.setAttribute("hidden", "");
    dom.toggleTheme?.classList.remove("cloudig-theme-coachmark-target");
  }

  function positionThemeCoachmark() {
    const coachmark = dom.readerThemeCoachmark;
    const anchor = dom.toggleTheme;
    if (!coachmark || coachmark.hidden || !anchor) return;
    const margin = 12;
    const gap = 11;
    const anchorRect = anchor.getBoundingClientRect();
    const width = coachmark.offsetWidth || 260;
    const height = coachmark.offsetHeight || 50;
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    const left = Math.min(Math.max(margin, anchorCenter - width / 2), Math.max(margin, globalThis.innerWidth - width - margin));
    const below = anchorRect.bottom + gap;
    const placeBelow = below + height <= globalThis.innerHeight - margin;
    const top = placeBelow ? below : Math.max(margin, anchorRect.top - height - gap);
    coachmark.dataset.placement = placeBelow ? "bottom" : "top";
    coachmark.style.left = `${Math.round(left)}px`;
    coachmark.style.top = `${Math.round(top)}px`;
    coachmark.style.setProperty("--cloudig-theme-coachmark-arrow-x", `${Math.round(Math.min(Math.max(20, anchorCenter - left), width - 20))}px`);
  }

  function showThemeCoachmark({ immediate = false } = {}) {
    if (state.themeSwitchUsedVersion >= THEME_SWITCH_GUIDE_VERSION || state.themeCoachmarkDismissed || !dom.readerThemeCoachmark) return;
    globalThis.clearTimeout(state.themeCoachmarkTimer);
    const reveal = () => {
      if (state.themeSwitchUsedVersion >= THEME_SWITCH_GUIDE_VERSION || state.themeCoachmarkDismissed) return;
      dom.readerThemeCoachmark.hidden = false;
      dom.toggleTheme.classList.remove("cloudig-theme-coachmark-target");
      void dom.toggleTheme.offsetWidth;
      dom.toggleTheme.classList.add("cloudig-theme-coachmark-target");
      positionThemeCoachmark();
    };
    if (immediate) reveal();
    else state.themeCoachmarkTimer = globalThis.setTimeout(reveal, 650);
  }

  function syncDesktopTheme({ markSwitchUsed = false } = {}) {
    if (!DESKTOP_READER) return;
    const payload = {
      theme: state.theme === "dark" ? "star_night" : "dawn",
      surface: "reader"
    };
    if (markSwitchUsed) payload.theme_switch_used_version = THEME_SWITCH_GUIDE_VERSION;
    void desktopBridge("window.set-theme", payload)
      .then((result) => adoptThemeSwitchUsedVersion(result?.theme_switch_used_version))
      .catch(() => {});
  }

  function setTheme(theme, { remember = true, markSwitchUsed = false } = {}) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    dom.toggleTheme.dataset.currentTheme = theme;
    if (remember) {
      try { localStorage.setItem("ai-chat-archive-reader-theme", theme); }
      catch { /* file mode may deny storage */ }
    }
    if (markSwitchUsed) completeThemeSwitchGuide();
    if (dom.libraryList) renderLibrary();
    readerCover.layout();
    syncDesktopTheme({ markSwitchUsed });
  }

  function preferredTheme(themePreference) {
    if (themePreference === "dawn") return "light";
    if (themePreference === "star_night") return "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyLibraryPreferences(library) {
    if (!library) return;
    setLanguage(library.preferences?.language || state.language, { remember: true, rerender: false });
    setTheme(preferredTheme(library.preferences?.theme || "platform"), { remember: false });
    applyProjectBrand(library);
    updateDefaultDirectoryUi();
  }

  function applyProjectBrand(library) {
    if (!dom.readerBrandTitle || !library) return;
    const customTitle = libraryCore.cleanString(library.project?.title);
    const title = customTitle || (state.language === "en" ? "Cloudig" : "采云 Cloudig");
    const iconPath = libraryCore.cleanString(library?.project?.icon);
    const iconUrl = iconPath ? EMBEDDED_ASSETS.get(iconPath.replaceAll("\\", "/").toLowerCase()) : "";
    dom.readerBrandTitle.textContent = title;
    dom.readerBrandIcon.hidden = !iconUrl;
    dom.readerBrandMark.hidden = Boolean(iconUrl);
    if (iconUrl) dom.readerBrandIcon.src = iconUrl;
    else dom.readerBrandIcon.removeAttribute("src");
    document.title = customTitle ? `${title} · Reader` : t("page.title");
  }

  function initialTheme() {
    const prepaintTheme = document.documentElement.dataset.theme;
    if (["light", "dark"].includes(prepaintTheme)) return prepaintTheme;
    try {
      const stored = localStorage.getItem("ai-chat-archive-reader-theme");
      if (["light", "dark"].includes(stored)) return stored;
    } catch { /* use media preference */ }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function setCatalogCollapsed(collapsed) {
    const next = Boolean(collapsed);
    document.body.classList.toggle("catalog-collapsed", next);
    dom.library.dataset.collapsed = next ? "true" : "false";
    dom.collapseLibrary.setAttribute("aria-expanded", next ? "false" : "true");
    dom.expandLibrary.setAttribute("aria-expanded", next ? "false" : "true");
    updateReadingGeometry();
  }

  function cacheDom() {
    const ids = [
      "reader-topbar", "reader-brand-home", "library", "toggle-library", "close-library", "return-manager", "reader-brand-mark", "reader-brand-icon", "reader-brand-title", "open-folder", "change-folder", "library-change-folder", "open-files", "edit-profile", "toggle-theme", "reader-theme-coachmark", "reader-theme-coachmark-close", "file-input", "folder-input", "cloudig-docs-dialog", "cloudig-docs-host",
      "toggle-language", "total-conversation-count", "collapse-library", "expand-library", "previous-conversation", "next-conversation", "library-search", "platform-filter", "platform-filter-label", "platform-filter-options", "sort-select", "library-summary", "library-list", "reader", "welcome", "welcome-open",
      "catalog-search-shell", "library-search-go", "library-search-clear", "cover-navigation", "reader-cover-stage",
      "all-directories", "directory-book-slots", "create-directory", "expand-directories", "manage-directories", "directory-panel", "directory-panel-list", "directory-panel-confirm", "directory-panel-cancel",
      "directory-manager-dialog", "directory-manager-form", "directory-manager-close", "directory-manager-new", "directory-manager-count", "directory-manager-list", "directory-manager-empty",
      "directory-manager-editor-empty", "directory-manager-editor", "directory-manager-mode", "directory-manager-name", "directory-manager-files", "directory-manager-size", "directory-manager-error",
      "directory-manager-delete", "directory-manager-cancel", "directory-manager-save",
      "welcome-manager", "welcome-folder", "welcome-change-folder", "default-directory-label", "default-directory-note", "drop-zone", "conversation", "platform-badge", "conversation-models", "conversation-title", "conversation-meta",
      "cover-summary", "conversation-platform-icon", "conversation-scroll", "message-search", "message-search-go", "message-search-clear", "previous-match", "next-match",
      "expand-disclosure", "expand-disclosure-button", "expand-reasoning", "expand-activities", "expand-sources",
      "hide-disclosure", "hide-disclosure-button", "hide-reasoning", "hide-activities",
      "show-sources", "edit-conversation", "show-markdown", "copy-markdown", "save-markdown", "save-json", "match-summary", "warnings", "timeline",
      "branch-navigation", "branch-summary", "previous-branch", "branch-select", "next-branch",
      "outline", "return-cover", "show-user-messages", "show-ai-messages", "show-process-messages", "outline-stats", "scroll-top", "previous-message", "next-message", "scroll-bottom", "outline-list", "outline-preview-popover", "toast-region", "source-dialog", "source-dialog-body", "image-dialog", "image-dialog-image", "image-dialog-caption",
      "markdown-dialog", "markdown-preview", "dialog-copy-markdown", "dialog-save-markdown",
      "conversation-edit-dialog", "conversation-edit-form", "edit-conversation-title", "edit-conversation-platform", "edit-conversation-platform-icon", "edit-conversation-models", "edit-conversation-add-model", "edit-conversation-file-name",
      "edit-conversation-json-times", "edit-conversation-message-times", "edit-conversation-source-file", "edit-conversation-source-time",
      "edit-time-clear", "edit-time-system", "edit-time-preview", "edit-time-warning", "edit-time-confirm", "edit-time-instruction",
      "conversation-info-art-dawn", "conversation-info-art-night",
      "edit-start-fields", "edit-start-precision", "edit-start-year", "edit-start-month", "edit-start-day", "edit-start-hour", "edit-start-minute", "edit-start-timezone",
      "edit-end-fields", "edit-end-precision", "edit-end-year", "edit-end-month", "edit-end-day", "edit-end-hour", "edit-end-minute", "edit-end-timezone",
      "name-rule-dialog", "name-rule-close-icon", "name-rule-ack", "name-rule-close",
      "compatibility-banner", "compatibility-banner-text", "compatibility-dialog", "compatibility-list", "compatibility-close",
      "profile-edit-dialog", "profile-edit-form", "identity-dialog-title", "identity-dialog-intro",
      "conversation-name-section", "identity-conversation-user-name", "identity-conversation-assistant-name", "identity-reset-conversation",
      "identity-user-avatar-pick", "identity-user-avatar-preview", "identity-user-avatar-remove", "edit-user-name", "identity-reset-user",
      "identity-assistant-avatar-pick", "identity-assistant-avatar-preview", "identity-assistant-avatar-remove", "edit-assistant-name", "identity-reset-assistant",
      "identity-apply-to-all", "identity-reset-platform-names", "identity-platform-grid"
    ];
    for (const id of ids) dom[id.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = byId(id);
    dom.conversationSearchShell = document.querySelector(".conversation-search");
  }

  function bindToolbarPopover(container, trigger) {
    let suppressFocusOpen = false;
    let pointerInside = false;
    const setOpen = (open) => {
      if (open) {
        for (const other of document.querySelectorAll(".toolbar-popover.is-open")) {
          if (other === container) continue;
          other.classList.remove("is-open");
          other.querySelector(".toolbar-menu-trigger")?.setAttribute("aria-expanded", "false");
        }
      }
      container.classList.toggle("is-open", open);
      trigger.setAttribute("aria-expanded", String(open));
    };
    container.addEventListener("pointerenter", () => {
      pointerInside = true;
      setOpen(true);
    });
    container.addEventListener("pointerleave", () => {
      pointerInside = false;
      setOpen(false);
    });
    container.addEventListener("focusin", () => {
      if (!suppressFocusOpen) setOpen(true);
    });
    container.addEventListener("focusout", (event) => {
      if (!pointerInside && !container.contains(event.relatedTarget)) setOpen(false);
    });
    trigger.addEventListener("click", () => {
      setOpen(true);
      container.querySelector("input")?.focus({ preventScroll: true });
    });
    container.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      suppressFocusOpen = true;
      trigger.focus({ preventScroll: true });
      setOpen(false);
      queueMicrotask(() => { suppressFocusOpen = false; });
    });
  }

  function bindEvents() {
    const openFiles = () => dom.fileInput.click();
    const openFolder = () => {
      if (DESKTOP_READER) void desktopBridge("reader.open-library").catch((error) => toast(error.message, true));
      else void openDefaultDirectory();
    };
    const changeFolder = () => {
      if (DESKTOP_READER) void navigateWithCloudigBoot(`${globalThis.location.protocol}//cloudig.local/index.html`);
      else void chooseDefaultDirectory();
    };
    dom.coverNavigation.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-reader-doc-topic]");
      if (button) openCloudigDocs(button.dataset.readerDocTopic, button);
    });
    dom.cloudigDocsHost.addEventListener("cloudig-docs-close", closeCloudigDocs);
    dom.cloudigDocsDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeCloudigDocs();
    });
    dom.cloudigDocsDialog.addEventListener("close", restoreCloudigDocsFocus);
    dom.openFiles.addEventListener("click", openFiles);
    dom.returnManager.addEventListener("click", () => {
      if (DESKTOP_READER) void navigateWithCloudigBoot(`${globalThis.location.protocol}//cloudig.local/index.html#manager`);
    });
    dom.readerBrandHome.addEventListener("click", () => {
      if (DESKTOP_READER) void navigateWithCloudigBoot("https://cloudig.local/index.html#cover");
      else showReaderCover();
    });
    dom.welcomeManager.addEventListener("click", () => dom.returnManager.click());
    dom.welcomeOpen.addEventListener("click", openFiles);
    dom.openFolder.addEventListener("click", openFolder);
    dom.welcomeFolder.addEventListener("click", openFolder);
    dom.changeFolder.addEventListener("click", changeFolder);
    dom.libraryChangeFolder.addEventListener("click", changeFolder);
    dom.welcomeChangeFolder.addEventListener("click", changeFolder);
    dom.fileInput.addEventListener("change", () => loadFiles(dom.fileInput.files));
    dom.folderInput.addEventListener("change", () => {
      const folderName = rememberFolderInputSelection(dom.folderInput.files);
      void loadFiles(dom.folderInput.files, { fromFolder: true, folderName });
    });
    const runLibrarySearch = () => {
      state.libraryQuery = dom.librarySearch.value;
      dom.catalogSearchShell.classList.toggle("has-value", Boolean(dom.librarySearch.value));
      renderLibrary();
    };
    dom.librarySearch.addEventListener("input", runLibrarySearch);
    dom.librarySearchGo.addEventListener("click", runLibrarySearch);
    dom.librarySearchClear.addEventListener("click", () => {
      dom.librarySearch.value = "";
      runLibrarySearch();
      dom.librarySearch.focus({ preventScroll: true });
    });
    dom.platformFilterOptions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-platform]");
      if (!button) return;
      const platform = button.dataset.platform;
      if (state.platforms.has(platform)) state.platforms.delete(platform);
      else state.platforms.add(platform);
      updatePlatformFilterLabel();
      updatePlatformFilter();
      renderLibrary();
    });
    dom.allDirectories.addEventListener("click", () => {
      state.directorySelection.clear();
      renderLibrary();
    });
    dom.directoryBookSlots.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-directory]");
      if (!button) return;
      const directory = button.dataset.directory;
      const onlyCurrent = state.directorySelection.size === 1 && state.directorySelection.has(directory);
      state.directorySelection = onlyCurrent ? new Set() : new Set([directory]);
      renderLibrary();
    });
    const openDirectoryPanel = () => setDirectoryPanelOpen(true);
    dom.createDirectory.addEventListener("click", () => { void openDirectoryManager({ create: true }); });
    dom.expandDirectories.addEventListener("click", openDirectoryPanel);
    dom.manageDirectories.addEventListener("click", () => { void openDirectoryManager(); });
    dom.directoryPanelCancel.addEventListener("click", () => setDirectoryPanelOpen(false));
    dom.directoryPanelList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-directory]");
      if (!button) return;
      const directory = button.dataset.directory;
      if (state.directoryDraftSelection.has(directory)) state.directoryDraftSelection.delete(directory);
      else state.directoryDraftSelection.add(directory);
      renderDirectoryPanel();
    });
    dom.directoryPanelConfirm.addEventListener("click", () => {
      state.directorySelection = new Set(state.directoryDraftSelection);
      setDirectoryPanelOpen(false);
      renderLibrary();
    });
    dom.directoryManagerClose.addEventListener("click", closeDirectoryManager);
    dom.directoryManagerCancel.addEventListener("click", closeDirectoryManager);
    dom.directoryManagerNew.addEventListener("click", () => startDirectoryManagerDraft("create"));
    dom.directoryManagerList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-directory-name]");
      if (!button) return;
      startDirectoryManagerDraft("edit", button.dataset.directoryName);
    });
    dom.directoryManagerForm.addEventListener("submit", (event) => { void saveDirectoryManager(event); });
    dom.directoryManagerDelete.addEventListener("click", () => { void removeDirectoryManager(); });
    dom.directoryManagerName.addEventListener("input", () => {
      state.directoryManagerDeleteArmed = false;
      setDirectoryManagerError(validateDirectoryName(
        dom.directoryManagerName.value,
        state.directoryManagerMode === "edit" ? state.directoryManagerName : ""
      ).error);
    });
    dom.directoryManagerDialog.addEventListener("click", (event) => {
      if (event.target === dom.directoryManagerDialog) closeDirectoryManager();
    });
    dom.directoryManagerDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDirectoryManager();
    });
    dom.sortSelect.addEventListener("change", () => { state.sort = dom.sortSelect.value; renderLibrary(); });
    dom.previousConversation.addEventListener("click", () => navigateFilteredConversation(-1));
    dom.nextConversation.addEventListener("click", () => navigateFilteredConversation(1));
    document.querySelector(".catalog-sort-buttons")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-catalog-sort]");
      if (!button) return;
      state.sort = button.dataset.catalogSort;
      dom.sortSelect.value = state.sort;
      renderLibrary();
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest(".library-item-shell")) return;
      closeLibraryItemMenus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (state.directoryPanelOpen) setDirectoryPanelOpen(false);
      closeLibraryItemMenus();
    });
    dom.messageSearch.addEventListener("input", () => { state.messageQuery = dom.messageSearch.value; applyMessageFilter(); });
    dom.messageSearchGo.addEventListener("click", () => {
      state.messageQuery = dom.messageSearch.value;
      applyMessageFilter();
      if (state.messageMatches.length) revealMessage(state.messageMatches[0]);
    });
    dom.messageSearchClear.addEventListener("click", () => {
      dom.messageSearch.value = "";
      state.messageQuery = "";
      applyMessageFilter();
      dom.messageSearch.focus({ preventScroll: true });
    });
    dom.branchSelect.addEventListener("change", () => chooseBranch(dom.branchSelect.value));
    dom.previousBranch.addEventListener("click", () => chooseBranch(Number(dom.branchSelect.value) - 1));
    dom.nextBranch.addEventListener("click", () => chooseBranch(Number(dom.branchSelect.value) + 1));
    dom.previousMatch.addEventListener("click", () => moveMessageMatch(-1));
    dom.nextMatch.addEventListener("click", () => moveMessageMatch(1));
    dom.expandReasoning.addEventListener("change", () => { applyReasoningControls(); saveDisclosurePreferences(); });
    dom.expandActivities.addEventListener("change", () => { applyActivityControls(); saveDisclosurePreferences(); });
    dom.expandSources.addEventListener("change", () => { applyActivityControls(); saveDisclosurePreferences(); });
    dom.hideReasoning.addEventListener("change", () => { applyReasoningControls(); saveDisclosurePreferences(); });
    dom.hideActivities.addEventListener("change", () => { applyActivityControls(); saveDisclosurePreferences(); });
    bindToolbarPopover(dom.expandDisclosure, dom.expandDisclosureButton);
    bindToolbarPopover(dom.hideDisclosure, dom.hideDisclosureButton);
    dom.showSources.addEventListener("click", () => dom.sourceDialog.showModal());
    dom.editConversation.addEventListener("click", openConversationEditor);
    dom.showMarkdown.addEventListener("click", showMarkdownPreview);
    dom.copyMarkdown.addEventListener("click", () => { void copyActiveMarkdown(); });
    dom.saveMarkdown.addEventListener("click", () => { void saveActiveMarkdown(); });
    dom.dialogCopyMarkdown.addEventListener("click", () => { void copyActiveMarkdown(); });
    dom.dialogSaveMarkdown.addEventListener("click", () => { void saveActiveMarkdown(); });
    dom.editProfile.addEventListener("click", () => openProfileEditor("global"));
    dom.saveJson.addEventListener("click", () => { void openActiveJson(); });
    dom.toggleTheme.addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark", { markSwitchUsed: true }));
    dom.readerThemeCoachmarkClose.addEventListener("click", () => hideThemeCoachmark({ dismissSession: true }));
    document.addEventListener("pointerdown", (event) => {
      if (dom.readerThemeCoachmark.hidden) return;
      if (dom.readerThemeCoachmark.contains(event.target) || dom.toggleTheme.contains(event.target)) return;
      hideThemeCoachmark({ dismissSession: true });
    }, { capture: true });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !dom.readerThemeCoachmark.hidden) hideThemeCoachmark({ dismissSession: true });
    });
    dom.toggleLanguage.addEventListener("click", () => setLanguage(state.language === "en" ? "zh-CN" : "en"));
    dom.returnCover.addEventListener("click", showReaderCover);
    dom.showUserMessages.addEventListener("change", applyOutlineTextVisibility);
    dom.showAiMessages.addEventListener("change", applyOutlineVisibilityControls);
    dom.showProcessMessages.addEventListener("change", applyOutlineTextVisibility);
    dom.collapseLibrary.addEventListener("click", () => setCatalogCollapsed(true));
    dom.expandLibrary.addEventListener("click", () => setCatalogCollapsed(false));
    dom.toggleLibrary.addEventListener("click", () => dom.library.classList.add("open"));
    dom.closeLibrary.addEventListener("click", () => dom.library.classList.remove("open"));
    dom.scrollTop.addEventListener("click", () => {
      state.waypointIndex = outlineCandidateIndexes()[0] ?? 0;
      state.waypointKey = "";
      syncOutlineWaypoint({ follow: true });
      dom.conversationScroll.scrollTo({ top: 0, behavior: "smooth" });
    });
    dom.previousMessage.addEventListener("click", () => moveWaypoint(-1));
    dom.nextMessage.addEventListener("click", () => moveWaypoint(1));
    dom.scrollBottom.addEventListener("click", () => {
      const last = outlineCandidateIndexes().at(-1);
      if (Number.isInteger(last) && last >= 0) revealMessage(last);
    });
    dom.conversationScroll.addEventListener("scroll", scheduleWaypointFromScroll, { passive: true });
    dom.timeline.addEventListener("click", (event) => {
      const identityTarget = event.target.closest("[data-identity-editor='conversation']");
      if (identityTarget) {
        openProfileEditor("conversation");
        return;
      }
      const button = event.target.closest(".copy-code");
      if (button) copyCode(button);
    });
    for (const eventName of ["dragenter", "dragover"]) {
      document.addEventListener(eventName, (event) => { event.preventDefault(); dom.dropZone.classList.add("dragging"); });
    }
    for (const eventName of ["dragleave", "drop"]) {
      document.addEventListener(eventName, (event) => { event.preventDefault(); dom.dropZone.classList.remove("dragging"); });
    }
    document.addEventListener("drop", (event) => loadFiles(event.dataTransfer?.files || []));
    dom.sourceDialog.addEventListener("click", (event) => { if (event.target === dom.sourceDialog) dom.sourceDialog.close(); });
    dom.markdownDialog.addEventListener("click", (event) => { if (event.target === dom.markdownDialog) dom.markdownDialog.close(); });
    dom.imageDialog.addEventListener("click", (event) => { if (event.target === dom.imageDialog) dom.imageDialog.close(); });
    dom.conversationEditForm.addEventListener("submit", (event) => { void saveConversationEditor(event); });
    dom.editConversationAddModel.addEventListener("click", startConversationModelInput);
    dom.editConversationModels.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-model-index]");
      if (!button || !state.conversationEditDraft) return;
      state.conversationEditDraft.models.splice(Number(button.dataset.modelIndex), 1);
      renderConversationEditorModels();
    });
    dom.editTimeSystem.addEventListener("click", openContentTimeSystem);
    dom.editConversationPlatform.addEventListener("input", () => {
      const platform = String(dom.editConversationPlatform.value || "").trim().toLowerCase();
      dom.editConversationPlatformIcon.src = platformAsset(platform) || readerAsset("brand.seal");
      dom.editConversationPlatformIcon.alt = platformLabel({ platform });
      dom.editConversationPlatformIcon.dataset.platform = platform;
    });
    dom.editTimeClear.addEventListener("click", clearConversationTime);
    dom.editTimeConfirm.addEventListener("click", confirmConversationTime);
    dom.conversationEditForm.addEventListener("change", (event) => {
      if (event.target.matches('input[name^="edit-start-"], input[name^="edit-end-"], #edit-start-precision, #edit-end-precision')) {
        updateTimeEndpointFields("start");
        updateTimeEndpointFields("end");
        markConversationTimeDirty();
      }
    });
    dom.conversationEditForm.addEventListener("input", (event) => {
      if (event.target.closest(".conversation-time-fields")) markConversationTimeDirty();
    });
    dom.conversationEditDialog.addEventListener("close", () => { state.conversationEditDraft = null; });
    dom.profileEditForm.addEventListener("submit", (event) => { void saveProfileEditor(event); });
    dom.identityUserAvatarPick.addEventListener("click", () => { void chooseIdentityAvatar("user_avatar"); });
    dom.identityAssistantAvatarPick.addEventListener("click", () => { void chooseIdentityAvatar("assistant_avatar"); });
    dom.identityUserAvatarRemove.addEventListener("click", () => removeIdentityAvatar("user_avatar"));
    dom.identityAssistantAvatarRemove.addEventListener("click", () => removeIdentityAvatar("assistant_avatar"));
    dom.identityResetUser.addEventListener("click", () => { dom.editUserName.value = ""; });
    dom.identityResetAssistant.addEventListener("click", () => { dom.editAssistantName.value = ""; });
    dom.identityResetConversation.addEventListener("click", () => {
      dom.identityConversationUserName.value = "";
      dom.identityConversationAssistantName.value = "";
    });
    dom.identityResetPlatformNames.addEventListener("click", () => {
      for (const input of dom.identityPlatformGrid.querySelectorAll("[data-platform-name]")) input.value = "";
    });
    dom.identityPlatformGrid.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-identity-action]");
      if (!button) return;
      const platform = button.dataset.platform || "";
      if (button.dataset.identityAction === "upload-platform-avatar") {
        void chooseIdentityAvatar("platform", platform);
      } else if (button.dataset.identityAction === "remove-platform-avatar") {
        removeIdentityAvatar("platform", platform);
      }
    });
    dom.profileEditDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeIdentityEditor();
    });
    dom.profileEditDialog.addEventListener("click", (event) => {
      if (event.target === dom.profileEditDialog) closeIdentityEditor();
    });
    dom.nameRuleClose.addEventListener("click", () => { void closeNameRuleNotice(); });
    dom.nameRuleCloseIcon.addEventListener("click", () => { void closeNameRuleNotice(); });
    dom.nameRuleDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      void closeNameRuleNotice();
    });
    dom.compatibilityBanner.addEventListener("click", openCompatibilityNotice);
    dom.compatibilityClose.addEventListener("click", () => dom.compatibilityDialog.close());
    for (const button of document.querySelectorAll("[data-close-dialog]")) {
      button.addEventListener("click", () => {
        if (button.dataset.closeDialog === "profile-edit-dialog") closeIdentityEditor();
        else byId(button.dataset.closeDialog)?.close();
      });
    }
  }

  function publicSmokeCheck() {
    const checks = [
      core.SCHEMA === "ai-chat-archive/conversation/0.1.5",
      VERSION === core.READER_VERSION && core.isSemanticVersion(VERSION),
      libraryCore.FORMAT === "cloudig/library"
        && libraryCore.SUPPORTED_VERSIONS?.includes(libraryCore.VERSION),
      i18n.languages.length === 2 && i18n.languages.includes("zh-CN") && i18n.languages.includes("en"),
      typeof globalThis.markdownit === "function",
      typeof globalThis.temml?.renderToString === "function",
      typeof globalThis.osisRenderTemmlHtml === "function",
      typeof readerCover.update === "function",
      state.markdown.render("| A | B |\n|---|---|\n| 1 | 2 |").includes("<table>"),
      renderTemmlHtml("\\boxed{E=mc^2}", true).includes("<math")
    ];
    if (checks.some((value) => !value)) throw new Error("Reader 离线运行时自检失败。");
    document.documentElement.dataset.readerReady = VERSION;
  }

  function configureDesktopReader() {
    if (!DESKTOP_READER) {
      dom.createDirectory.hidden = true;
      dom.manageDirectories.hidden = true;
      return;
    }
    document.body.classList.add("cloudig-desktop-reader");
    for (const element of [
      dom.openFiles, dom.libraryChangeFolder, dom.welcomeOpen, dom.dropZone,
      dom.fileInput, dom.folderInput
    ]) element.hidden = true;
  }

  function init() {
    cacheDom();
    applyReaderAssets();
    readerCover.setup({
      onArchive: () => dom.returnManager.click(),
      onIdentity: () => openProfileEditor("global")
    });
    configureDesktopReader();
    dom.expandReasoning.checked = false;
    dom.expandActivities.checked = false;
    dom.expandSources.checked = false;
    dom.hideReasoning.checked = false;
    dom.hideActivities.checked = false;
    dom.showUserMessages.checked = true;
    dom.showAiMessages.checked = true;
    dom.showProcessMessages.checked = false;
    restoreDisclosurePreferences();
    applyOutlineVisibilityControls();
    updateReadingGeometry();
    if (typeof globalThis.ResizeObserver === "function") {
      readingGeometryObserver = new globalThis.ResizeObserver(updateReadingGeometry);
      readingGeometryObserver.observe(dom.reader);
    }
    addTemmlCss();
    state.markdown = createMarkdownRenderer();
    bindEvents();
    setLanguage(initialLanguage(), { remember: false, rerender: false });
    setTheme(initialTheme());
    tooltipController = globalThis.CloudigTooltip?.install({ resolveText: (key) => t(key) }) || null;
    updatePlatformFilter();
    showReaderCover();
    updateDefaultDirectoryUi();
    globalThis.addEventListener("resize", updateReadingGeometry);
    globalThis.addEventListener("resize", positionThemeCoachmark);
    void (async () => {
      try {
        await restoreDefaultDirectory();
        await loadEmbeddedLibrary({ announce: false });
        await refreshDesktopArchiveSnapshot({ rerender: false });
        if (DESKTOP_CATALOG_READER) {
          state.embeddedLibraryPending = false;
          showReaderCover();
        }
      } catch (error) {
        if (DESKTOP_READER) toast(directoryErrorMessage(error), true, 7000);
      } finally {
        await revealCloudigPage();
        showThemeCoachmark();
      }
    })();
    publicSmokeCheck();
  }

  init();
  globalThis.OsisReaderApp = Object.freeze({
    version: VERSION,
    loadFiles,
    loadDirectoryHandle,
    loadEmbeddedLibrary,
    openDefaultDirectory,
    chooseDefaultDirectory,
    setLanguage,
    activeMarkdown,
    saveActiveMarkdown,
    stateSummary: () => Object.freeze({
      entries: state.entries.length,
      active: state.activeEntry?.fileName || "",
      platform: state.activeEntry?.document.platform || "",
      defaultDirectory: state.defaultDirectoryHandle?.name || state.defaultDirectoryLabel || "",
      defaultDirectoryPersistence: state.defaultDirectoryPersistence
      , library: state.library ? `${state.library.format}/${state.library.version}` : ""
      , libraryUser: state.library?.user?.display_name || ""
      , libraryPersistence: state.libraryPersistence
      , desktop: DESKTOP_READER
      , language: state.language
      , theme: state.theme
      , themeSwitchUsedVersion: state.themeSwitchUsedVersion
      , themeCoachmarkVisible: !dom.readerThemeCoachmark.hidden
      , incompatible: state.compatibilityIssues.length
      , archiveRevision: state.archiveRevision
      , directories: state.archiveDirectories.map((directory) => directory.name)
    })
  });
}());
