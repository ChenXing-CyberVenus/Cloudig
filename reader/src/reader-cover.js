(function createCloudigReaderCover() {
  "use strict";

  const DESIGN_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
  const DESIGN_SCENE = Object.freeze({ width: 1272, height: 1032 });

  let configured = false;
  let visible = false;
  let sceneViewport = null;
  let resizeObserver = null;
  let currentLibraryPath = "";
  let pathMeasureContext = null;
  let scrollbarDragTarget = null;

  const COVER_SCROLL_SELECTOR = ".rr-directory-panel-list, .rr-list, .library-item-move-menu, body.reader-conversation-active .conversation-scroll, body.reader-conversation-active .outline-list";

  function coverScrollAreas() {
    return Array.from(document.querySelectorAll(COVER_SCROLL_SELECTOR));
  }

  function scrollbarHit(node, event) {
    const rect = node.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return false;
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rr-scale")) || 1;
    const verticalWidth = Math.max(node.offsetWidth - node.clientWidth, 8 * scale);
    const horizontalHeight = Math.max(node.offsetHeight - node.clientHeight, 8 * scale);
    const vertical = node.scrollHeight > node.clientHeight + 1 && event.clientX >= rect.right - verticalWidth;
    const horizontal = node.scrollWidth > node.clientWidth + 1 && event.clientY >= rect.bottom - horizontalHeight;
    return vertical || horizontal;
  }

  function updateScrollbarState(event) {
    for (const node of coverScrollAreas()) {
      node.classList.toggle("rr-scrollbar-operating", node === scrollbarDragTarget || scrollbarHit(node, event));
    }
  }

  function beginScrollbarOperation(event) {
    scrollbarDragTarget = coverScrollAreas().find((node) => scrollbarHit(node, event)) || null;
    updateScrollbarState(event);
  }

  function endScrollbarOperation(event) {
    scrollbarDragTarget = null;
    updateScrollbarState(event);
  }

  function availableViewport() {
    const viewport = globalThis.visualViewport;
    return {
      width: Math.max(1, Number(viewport?.width) || globalThis.innerWidth || DESIGN_VIEWPORT.width),
      height: Math.max(1, Number(viewport?.height) || globalThis.innerHeight || DESIGN_VIEWPORT.height)
    };
  }

  function fit(container, design) {
    if (!container) return 1;
    const rect = container.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return 1;
    return Math.max(.01, Math.min(rect.width / design.width, rect.height / design.height));
  }

  function measurePath(node, value) {
    if (!pathMeasureContext) pathMeasureContext = document.createElement("canvas").getContext("2d");
    if (!pathMeasureContext) return String(value).length * 9;
    pathMeasureContext.font = getComputedStyle(node).font;
    return pathMeasureContext.measureText(String(value)).width;
  }

  function elideMiddle(value, node, maxWidth) {
    const source = String(value || "");
    if (!source || measurePath(node, source) <= maxWidth) return source;
    if (measurePath(node, "…") > maxWidth) return "";
    let low = 2;
    let high = Math.max(2, source.length - 1);
    let best = "…";
    while (low <= high) {
      const keep = Math.floor((low + high) / 2);
      const left = Math.ceil(keep / 2);
      const right = Math.floor(keep / 2);
      const candidate = `${source.slice(0, left)}…${right ? source.slice(-right) : ""}`;
      if (measurePath(node, candidate) <= maxWidth) {
        best = candidate;
        low = keep + 1;
      } else {
        high = keep - 1;
      }
    }
    return best;
  }

  function splitDisplayPath(value) {
    const source = String(value || "").trim();
    const drive = source.match(/^([a-z]:)[\\/]+/iu);
    if (drive) {
      const parts = source.slice(drive[0].length).split(/[\\/]+/u).filter(Boolean);
      return { root: `${drive[1]}\\`, leaf: parts.at(-1) || "", separator: "\\" };
    }
    const unc = source.match(/^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)[/\\]*/u);
    if (unc) {
      const parts = source.slice(unc[0].length).split(/[\\/]+/u).filter(Boolean);
      return { root: `\\\\${unc[1]}\\${unc[2]}\\`, leaf: parts.at(-1) || "", separator: "\\" };
    }
    if (source.startsWith("/")) {
      const parts = source.split("/").filter(Boolean);
      return { root: "/", leaf: parts.at(-1) || "", separator: "/" };
    }
    const parts = source.split(/[\\/]+/u).filter(Boolean);
    return { root: parts.length > 1 ? `${parts[0]}${source.includes("\\") ? "\\" : "/"}` : "", leaf: parts.at(-1) || source, separator: source.includes("\\") ? "\\" : "/" };
  }

  function displayPath(node, value) {
    const source = String(value || "");
    const maxWidth = Math.max(0, node.clientWidth);
    if (!source || !maxWidth || measurePath(node, source) <= maxWidth) return source;
    const { root, leaf, separator } = splitDisplayPath(source);
    if (!root || !leaf) return elideMiddle(source, node, maxWidth);
    const prefix = `${root}…${separator}`;
    const leafWidth = maxWidth - measurePath(node, prefix);
    if (leafWidth <= measurePath(node, "…")) return elideMiddle(source, node, maxWidth);
    return `${prefix}${elideMiddle(leaf, node, leafWidth)}`;
  }

  function renderLibraryPath() {
    for (const node of document.querySelectorAll(".cover-library-path")) {
      node.textContent = displayPath(node, currentLibraryPath);
      node.title = currentLibraryPath;
    }
  }

  function layout() {
    const viewport = availableViewport();
    const interfaceScale = Math.min(1,
      viewport.width / DESIGN_VIEWPORT.width,
      viewport.height / DESIGN_VIEWPORT.height
    );
    document.documentElement.style.setProperty("--rr-scale", interfaceScale.toFixed(6));
    if (!visible) return;
    globalThis.requestAnimationFrame(() => {
      document.documentElement.style.setProperty("--rr-scene-scale", fit(sceneViewport, DESIGN_SCENE).toFixed(6));
      renderLibraryPath();
      updateIdentityNameAlignments();
    });
  }

  function setText(selector, value) {
    for (const node of document.querySelectorAll(selector)) node.textContent = value;
  }

  function identityNameUnits(value) {
    return [...String(value || "")].reduce((total, character) => (
      total + (/^[\x00-\x7F]$/u.test(character) ? .56 : 1)
    ), 0);
  }

  function updateIdentityNameAlignment(node) {
    if (!node) return;
    const units = identityNameUnits(node.textContent);
    node.classList.remove("is-long-name", "is-very-long-name", "is-extreme-name");
    const isLong = node.clientWidth > 0
      ? node.scrollWidth > node.clientWidth + 1
      : units > 4.5;
    node.classList.toggle("is-long-name", isLong);
    node.classList.toggle("is-very-long-name", isLong && units > 9.5);
    node.classList.toggle("is-extreme-name", isLong && units > 12.5);
  }

  function updateIdentityNameAlignments() {
    for (const node of document.querySelectorAll(".rr-scene-person strong")) {
      updateIdentityNameAlignment(node);
    }
  }

  function setIdentityName(selector, value) {
    const name = String(value || "");
    for (const node of document.querySelectorAll(selector)) {
      node.textContent = name;
      node.title = name;
      updateIdentityNameAlignment(node);
    }
  }

  function setImage(selector, source) {
    for (const node of document.querySelectorAll(selector)) {
      if (source) node.src = source;
      else node.removeAttribute("src");
    }
  }

  function update(options = {}) {
    const language = options.language === "en" ? "en" : "zh-CN";
    const copy = language === "en"
      ? {
          archive: "Archiver",
          documents: ["Bookmark guide", "Archiver guide", "JSON contract", "Platform examples", "History & roadmap", "LICENSE"],
          contact: "ChenXing.CyberVenus",
          cat: "Feifei, a dignified brown-tabby British Shorthair, left for Cat Planet at fourteen."
        }
      : {
          archive: "管理档案",
          documents: ["书签使用方法", "档案管理方法", "JSON规范", "各平台范例", "历史与更新计划", "LICENSE"],
          contact: "晨星.CyberVenus",
          cat: "肥肥，威武雄壮有绅士精神的棕虎斑英国短毛猫，14岁时去了猫星。"
        };
    const defaultUserName = language === "en" ? "User" : "采云用户";
    const defaultAssistantName = language === "en" ? "AI" : "智能伙伴";
    const userName = String(options.userName || defaultUserName);
    const assistantName = String(options.assistantName || defaultAssistantName);
    currentLibraryPath = String(options.libraryPath || options.path || "");
    const hasNameOverrides = userName !== defaultUserName || assistantName !== defaultAssistantName;

    setIdentityName(".cover-user-name", userName);
    setIdentityName(".cover-assistant-name", assistantName);
    document.querySelector(".rr-scene-design")?.classList.toggle("has-name-overrides", hasNameOverrides);
    document.querySelector(".rr-scene-user")?.classList.toggle("has-custom-avatar", Boolean(options.userAvatarCustom));
    document.querySelector(".rr-scene-assistant")?.classList.toggle("has-custom-avatar", Boolean(options.assistantAvatarCustom));
    setImage(".cover-user-avatar", options.userAvatar);
    setImage(".cover-assistant-avatar", options.assistantAvatar);
    setText(".rr-archive-copy strong", copy.archive);
    renderLibraryPath();
    setText("#cover-cat-note", copy.cat);
    document.querySelectorAll(".cover-doc-content li span").forEach((node, index) => {
      node.textContent = copy.documents[index] || node.textContent;
    });
    setText(".cover-contact-name", copy.contact);
    layout();
  }

  function setVisible(nextVisible) {
    visible = Boolean(nextVisible);
    document.body.classList.toggle("reader-cover-active", visible);
    const navigation = document.getElementById("cover-navigation");
    if (navigation) navigation.hidden = !visible;
    layout();
  }

  function setup(options = {}) {
    if (configured) return;
    configured = true;
    sceneViewport = document.getElementById("reader-cover-stage");
    document.querySelectorAll("[data-cover-action='archive']").forEach((button) => {
      button.addEventListener("click", () => options.onArchive?.());
    });
    document.querySelectorAll("[data-cover-action='identity']").forEach((button) => {
      button.addEventListener("click", () => options.onIdentity?.());
    });
    document.querySelectorAll(".cover-doc-content li button").forEach((button) => {
      button.addEventListener("click", () => {
        const item = button.closest("li");
        if (!item) return;
        for (const other of document.querySelectorAll(".cover-doc-content li")) {
          const selected = other === item;
          other.classList.toggle("selected", selected);
          const otherButton = other.querySelector("button");
          if (selected) otherButton?.setAttribute("aria-current", "page");
          else otherButton?.removeAttribute("aria-current");
        }
        options.onDocument?.(item.textContent.trim());
      });
    });
    if (typeof globalThis.ResizeObserver === "function") {
      resizeObserver = new globalThis.ResizeObserver(layout);
      if (sceneViewport) resizeObserver.observe(sceneViewport);
      resizeObserver.observe(document.documentElement);
    }
    globalThis.visualViewport?.addEventListener("resize", layout, { passive: true });
    globalThis.addEventListener("resize", layout, { passive: true });
    document.fonts?.addEventListener?.("loadingdone", updateIdentityNameAlignments);
    document.addEventListener("pointermove", updateScrollbarState, { passive: true });
    document.addEventListener("pointerdown", beginScrollbarOperation, { passive: true });
    globalThis.addEventListener("pointerup", endScrollbarOperation, { passive: true });
    globalThis.addEventListener("blur", () => {
      scrollbarDragTarget = null;
      for (const node of coverScrollAreas()) node.classList.remove("rr-scrollbar-operating");
    });
    layout();
  }

  globalThis.CloudigReaderCover = Object.freeze({ setup, setVisible, update, layout });
})();
