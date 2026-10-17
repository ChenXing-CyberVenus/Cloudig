(function initCloudigTooltip(root, factory) {
  "use strict";
  const api = factory();
  root.CloudigTooltip = api;
  if (typeof module === "object" && module?.exports) module.exports = api;
}(typeof globalThis === "object" ? globalThis : this, function createCloudigTooltip() {
  "use strict";

  const TARGET_SELECTOR = [
    "[data-cloudig-tooltip]",
    "[data-cloudig-tooltip-key]",
    "[data-tooltip-key]",
    "[data-cloudig-tooltip-auto]"
  ].join(",");
  const TOOLTIP_ID = "cloudig-tooltip-portal";

  function install(options = {}) {
    const documentObject = options.document || globalThis.document;
    const windowObject = options.window || documentObject?.defaultView || globalThis;
    if (!documentObject?.body || typeof documentObject.addEventListener !== "function") return null;
    if (documentObject.__cloudigTooltipController) return documentObject.__cloudigTooltipController;

    const resolveText = typeof options.resolveText === "function"
      ? options.resolveText
      : (_key, target) => target?.getAttribute("aria-label") || "";
    const tooltip = documentObject.createElement("div");
    tooltip.id = TOOLTIP_ID;
    tooltip.className = "cloudig-tooltip-portal";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("popover", "manual");
    tooltip.hidden = true;
    documentObject.body.append(tooltip);

    let activeTarget = null;
    let activeMode = "pointer";
    let pointerX = 0;
    let pointerY = 0;
    let showTimer = 0;
    let frame = 0;
    let previousDescribedBy = null;

    function targetFrom(node) {
      return node instanceof windowObject.Element ? node.closest(TARGET_SELECTOR) : null;
    }

    function textFor(target) {
      if (!target) return "";
      const literal = String(target.dataset.cloudigTooltip || "").trim();
      if (literal) return literal;
      const key = String(target.dataset.cloudigTooltipKey || target.dataset.tooltipKey || "").trim();
      if (key) return String(resolveText(key, target) || "").trim();
      if (Object.prototype.hasOwnProperty.call(target.dataset, "cloudigTooltipAuto")) {
        return String(target.getAttribute("aria-label") || target.dataset.cloudigOriginalTitle || target.title || "").trim();
      }
      return "";
    }

    function suppressNativeTitle(target) {
      if (!target?.hasAttribute("title")) return;
      target.dataset.cloudigOriginalTitle = target.getAttribute("title") || "";
      target.removeAttribute("title");
    }

    function restoreDescription(target) {
      if (!target) return;
      if (previousDescribedBy === null) target.removeAttribute("aria-describedby");
      else target.setAttribute("aria-describedby", previousDescribedBy);
      previousDescribedBy = null;
    }

    function describe(target) {
      previousDescribedBy = target.hasAttribute("aria-describedby") ? target.getAttribute("aria-describedby") : null;
      const ids = new Set(String(previousDescribedBy || "").split(/\s+/u).filter(Boolean));
      ids.add(TOOLTIP_ID);
      target.setAttribute("aria-describedby", [...ids].join(" "));
    }

    function viewport() {
      const visual = windowObject.visualViewport;
      return {
        left: Number.isFinite(visual?.offsetLeft) ? visual.offsetLeft : 0,
        top: Number.isFinite(visual?.offsetTop) ? visual.offsetTop : 0,
        width: Math.max(1, Number(visual?.width) || Number(windowObject.innerWidth) || documentObject.documentElement.clientWidth || 1),
        height: Math.max(1, Number(visual?.height) || Number(windowObject.innerHeight) || documentObject.documentElement.clientHeight || 1)
      };
    }

    function position() {
      frame = 0;
      if (!activeTarget || tooltip.hidden || !activeTarget.isConnected) return;
      const bounds = viewport();
      const margin = 10;
      const gap = 12;
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      let left;
      let top;
      let placement;

      if (activeMode === "focus") {
        const rect = activeTarget.getBoundingClientRect();
        left = rect.left + rect.width / 2 - width / 2;
        top = rect.bottom + gap;
        placement = "bottom";
        if (top + height > bounds.top + bounds.height - margin) {
          top = rect.top - height - gap;
          placement = "top";
        }
      } else {
        left = pointerX + 16;
        top = pointerY + 18;
        placement = "cursor-bottom";
        if (left + width > bounds.left + bounds.width - margin) left = pointerX - width - 16;
        if (top + height > bounds.top + bounds.height - margin) {
          top = pointerY - height - 14;
          placement = "cursor-top";
        }
      }

      left = Math.max(bounds.left + margin, Math.min(left, bounds.left + bounds.width - width - margin));
      top = Math.max(bounds.top + margin, Math.min(top, bounds.top + bounds.height - height - margin));
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
      tooltip.dataset.placement = placement;
    }

    function schedulePosition() {
      if (frame) return;
      frame = windowObject.requestAnimationFrame(position);
    }

    function reveal(target, mode) {
      const text = textFor(target);
      if (!text || target.matches(":disabled") || target.getAttribute("aria-disabled") === "true") return;
      if (activeTarget !== target) {
        restoreDescription(activeTarget);
        activeTarget = target;
        describe(target);
      }
      suppressNativeTitle(target);
      activeMode = mode;
      tooltip.textContent = text;
      tooltip.hidden = false;
      if (typeof tooltip.showPopover === "function") {
        try { tooltip.showPopover(); } catch { /* older WebView fallback stays visible in the document layer */ }
      }
      tooltip.dataset.visible = "true";
      schedulePosition();
    }

    function queueReveal(target, mode) {
      windowObject.clearTimeout(showTimer);
      showTimer = windowObject.setTimeout(() => reveal(target, mode), mode === "focus" ? 0 : 140);
    }

    function hide() {
      windowObject.clearTimeout(showTimer);
      showTimer = 0;
      if (frame) windowObject.cancelAnimationFrame(frame);
      frame = 0;
      restoreDescription(activeTarget);
      activeTarget = null;
      if (typeof tooltip.hidePopover === "function") {
        try { tooltip.hidePopover(); } catch { /* it may not currently be in the top layer */ }
      }
      tooltip.hidden = true;
      delete tooltip.dataset.visible;
      tooltip.textContent = "";
    }

    function onPointerOver(event) {
      const target = targetFrom(event.target);
      if (!target) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (target !== activeTarget) {
        hide();
        pointerX = event.clientX;
        pointerY = event.clientY;
        queueReveal(target, "pointer");
      }
    }

    function onPointerMove(event) {
      const target = targetFrom(event.target);
      if (!target) return;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (target === activeTarget && activeMode === "pointer") schedulePosition();
    }

    function onPointerOut(event) {
      const target = targetFrom(event.target);
      if (!target) return;
      const next = event.relatedTarget instanceof windowObject.Node ? event.relatedTarget : null;
      if (next && target.contains(next)) return;
      if (target === activeTarget || !activeTarget) hide();
    }

    function onFocusIn(event) {
      const target = targetFrom(event.target);
      if (target) queueReveal(target, "focus");
    }

    function onFocusOut(event) {
      const target = targetFrom(event.target);
      if (!target) return;
      const next = event.relatedTarget instanceof windowObject.Node ? event.relatedTarget : null;
      if (next && target.contains(next)) return;
      if (target === activeTarget || !activeTarget) hide();
    }

    function onKeyDown(event) {
      if (event.key === "Escape" && activeTarget) hide();
    }

    documentObject.addEventListener("pointerover", onPointerOver, true);
    documentObject.addEventListener("pointermove", onPointerMove, true);
    documentObject.addEventListener("pointerout", onPointerOut, true);
    documentObject.addEventListener("focusin", onFocusIn, true);
    documentObject.addEventListener("focusout", onFocusOut, true);
    documentObject.addEventListener("keydown", onKeyDown, true);
    documentObject.addEventListener("scroll", hide, true);
    windowObject.addEventListener("resize", hide);
    windowObject.visualViewport?.addEventListener("resize", hide);
    windowObject.visualViewport?.addEventListener("scroll", hide);

    const controller = Object.freeze({
      hide,
      refresh() {
        if (!activeTarget) return;
        const text = textFor(activeTarget);
        if (!text) hide();
        else {
          tooltip.textContent = text;
          schedulePosition();
        }
      },
      destroy() {
        hide();
        documentObject.removeEventListener("pointerover", onPointerOver, true);
        documentObject.removeEventListener("pointermove", onPointerMove, true);
        documentObject.removeEventListener("pointerout", onPointerOut, true);
        documentObject.removeEventListener("focusin", onFocusIn, true);
        documentObject.removeEventListener("focusout", onFocusOut, true);
        documentObject.removeEventListener("keydown", onKeyDown, true);
        documentObject.removeEventListener("scroll", hide, true);
        windowObject.removeEventListener("resize", hide);
        windowObject.visualViewport?.removeEventListener("resize", hide);
        windowObject.visualViewport?.removeEventListener("scroll", hide);
        tooltip.remove();
        delete documentObject.__cloudigTooltipController;
      }
    });
    documentObject.__cloudigTooltipController = controller;
    return controller;
  }

  return Object.freeze({ install, TARGET_SELECTOR, TOOLTIP_ID });
}));
