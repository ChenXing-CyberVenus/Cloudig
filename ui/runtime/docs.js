(function initCloudigDocs(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CloudigDocs = api;
}(typeof globalThis === "object" ? globalThis : this, function createCloudigDocs() {
  "use strict";

  const SCHEMA = "cloudig/docs/0.1.0";
  const LOCALES = Object.freeze(["zh-CN", "en"]);
  const BLOCK_TYPES = new Set(["steps", "bullets", "table", "notice", "quote", "pre", "paragraph"]);

  function localized(value, locale) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return String(value[locale] ?? value["zh-CN"] ?? value.en ?? "");
  }

  function assertLocalized(value, field) {
    if (typeof value === "string") return;
    if (!value || typeof value !== "object") throw new TypeError(`${field} must be localized text`);
    for (const locale of LOCALES) {
      if (typeof value[locale] !== "string" || !value[locale].trim()) throw new TypeError(`${field}.${locale} is required`);
    }
  }

  function validate(data) {
    if (!data || typeof data !== "object" || data.schema !== SCHEMA) throw new TypeError(`Unsupported Cloudig docs schema: ${data?.schema || "missing"}`);
    if (!Array.isArray(data.topics) || data.topics.length !== 6) throw new TypeError("Cloudig docs require exactly six public topics");
    for (const field of ["title", "subtitle", "local_badge", "contents", "close", "privacy_title", "privacy", "safety_title", "safety", "author", "version_prefix"]) {
      assertLocalized(data.meta?.[field], `meta.${field}`);
    }
    const ids = new Set();
    for (const [topicIndex, topic] of data.topics.entries()) {
      if (!/^[a-z][a-z0-9-]*$/u.test(topic?.id || "") || ids.has(topic.id)) throw new TypeError(`Invalid or duplicate docs topic id at ${topicIndex}`);
      ids.add(topic.id);
      assertLocalized(topic.label, `topics.${topic.id}.label`);
      assertLocalized(topic.title, `topics.${topic.id}.title`);
      assertLocalized(topic.lead, `topics.${topic.id}.lead`);
      if (!Array.isArray(topic.blocks) || !topic.blocks.length) throw new TypeError(`topics.${topic.id}.blocks is required`);
      for (const [blockIndex, block] of topic.blocks.entries()) {
        if (!BLOCK_TYPES.has(block?.type)) throw new TypeError(`Unsupported docs block: ${topic.id}.${blockIndex}.${block?.type || "missing"}`);
        if (block.title) assertLocalized(block.title, `topics.${topic.id}.blocks.${blockIndex}.title`);
        if (["steps", "bullets"].includes(block.type) && (!Array.isArray(block.items) || !block.items.length)) throw new TypeError(`${topic.id}.${blockIndex}.items is required`);
        if (block.type === "table" && (!Array.isArray(block.headers) || !Array.isArray(block.rows))) throw new TypeError(`${topic.id}.${blockIndex} table is incomplete`);
      }
    }
    if (!ids.has(data.default_topic)) throw new TypeError("Cloudig docs default topic is not registered");
    return true;
  }

  function node(tag, className = "", text = "") {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== "") result.textContent = text;
    return result;
  }

  function heading(block, locale) {
    if (!block.title) return null;
    return node("h3", "cloudig-docs-section-title", localized(block.title, locale));
  }

  function renderBlock(block, locale) {
    if (block.type === "steps" || block.type === "bullets") {
      const section = node("section", `cloudig-docs-section is-${block.type}`);
      const title = heading(block, locale);
      if (title) section.append(title);
      const list = node(block.type === "steps" ? "ol" : "ul");
      for (const item of block.items || []) list.append(node("li", "", localized(item, locale)));
      section.append(list);
      return section;
    }
    if (block.type === "table") {
      const section = node("section", "cloudig-docs-section is-table");
      const title = heading(block, locale);
      if (title) section.append(title);
      const wrapper = node("div", "cloudig-docs-table-scroll");
      const table = node("table");
      const thead = node("thead");
      const headRow = node("tr");
      for (const cell of block.headers || []) headRow.append(node("th", "", localized(cell, locale)));
      thead.append(headRow);
      const tbody = node("tbody");
      for (const row of block.rows || []) {
        const tr = node("tr");
        for (const cell of row) tr.append(node("td", "", localized(cell, locale)));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrapper.append(table);
      section.append(wrapper);
      return section;
    }
    if (block.type === "notice") {
      const aside = node("aside", `cloudig-docs-notice is-${block.tone === "warning" ? "warning" : "info"}`);
      aside.setAttribute("role", "note");
      const title = heading(block, locale);
      if (title) aside.append(title);
      aside.append(node("p", "", localized(block.text, locale)));
      return aside;
    }
    if (block.type === "quote") return node("blockquote", "cloudig-docs-quote", localized(block.text, locale));
    if (block.type === "pre") return node("pre", "cloudig-docs-license", localized(block.text, locale));
    const section = node("section", "cloudig-docs-section is-paragraph");
    const title = heading(block, locale);
    if (title) section.append(title);
    section.append(node("p", "", localized(block.text, locale)));
    return section;
  }

  function mount({ host, data, locale = "zh-CN", version = "V1.0.0-dev", initialTopic = "" } = {}) {
    if (!host || typeof host.replaceChildren !== "function") throw new TypeError("Cloudig docs host is required");
    validate(data);
    const state = {
      locale: LOCALES.includes(locale) ? locale : "zh-CN",
      version: String(version || "V1.0.0-dev"),
      topic: data.topics.some((topic) => topic.id === initialTopic) ? initialTopic : data.default_topic
    };

    function render() {
      const topic = data.topics.find((entry) => entry.id === state.topic) || data.topics[0];
      const book = node("section", "cloudig-docs-book");
      book.dataset.topic = topic.id;

      const header = node("header", "cloudig-docs-header");
      const mark = node("span", "cloudig-docs-mark");
      mark.setAttribute("aria-hidden", "true");
      const titleGroup = node("div", "cloudig-docs-title-group");
      const title = node("h2", "", localized(data.meta.title, state.locale));
      title.id = "cloudig-docs-heading";
      titleGroup.append(title, node("p", "", localized(data.meta.subtitle, state.locale)));
      const meta = node("div", "cloudig-docs-meta");
      meta.append(node("strong", "", localized(data.meta.local_badge, state.locale)), node("small", "", `${localized(data.meta.version_prefix, state.locale)} · ${state.version}`));
      const close = node("button", "cloudig-docs-close", "×");
      close.type = "button";
      close.dataset.cloudigDocsClose = "true";
      close.setAttribute("aria-label", localized(data.meta.close, state.locale));
      header.append(mark, titleGroup, meta, close);

      const body = node("div", "cloudig-docs-body");
      const navigation = node("nav", "cloudig-docs-navigation");
      navigation.setAttribute("aria-label", localized(data.meta.contents, state.locale));
      navigation.append(node("h3", "", localized(data.meta.contents, state.locale)));
      const tabs = node("div", "cloudig-docs-tabs");
      tabs.setAttribute("role", "tablist");
      for (const entry of data.topics) {
        const button = node("button", "", localized(entry.label, state.locale));
        button.type = "button";
        button.dataset.docsTopic = entry.id;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(entry.id === topic.id));
        button.tabIndex = entry.id === topic.id ? 0 : -1;
        const dot = node("i");
        dot.setAttribute("aria-hidden", "true");
        button.prepend(dot);
        tabs.append(button);
      }
      navigation.append(tabs, node("p", "cloudig-docs-author", localized(data.meta.author, state.locale)));

      const article = node("article", "cloudig-docs-article");
      article.setAttribute("role", "tabpanel");
      article.tabIndex = 0;
      const articleHeader = node("header", "cloudig-docs-article-header");
      articleHeader.append(node("span", "cloudig-docs-kicker", String(topic.kicker || "GUIDE")), node("h2", "", localized(topic.title, state.locale)), node("p", "", localized(topic.lead, state.locale)));
      const articleBody = node("div", "cloudig-docs-article-body");
      for (const block of topic.blocks) articleBody.append(renderBlock(block, state.locale));
      const guardrails = node("footer", "cloudig-docs-guardrails");
      for (const kind of ["privacy", "safety"]) {
        const card = node("section", `cloudig-docs-guardrail is-${kind}`);
        card.append(node("h3", "", localized(data.meta[`${kind}_title`], state.locale)), node("p", "", localized(data.meta[kind], state.locale)));
        guardrails.append(card);
      }
      article.append(articleHeader, articleBody, guardrails);
      body.append(navigation, article);
      book.append(header, body);
      host.replaceChildren(book);
      host.dataset.locale = state.locale;
      host.dataset.topic = state.topic;
      host.closest("dialog")?.setAttribute("aria-label", localized(data.meta.title, state.locale));
    }

    function select(topicId, { focus = false } = {}) {
      if (!data.topics.some((topic) => topic.id === topicId)) return false;
      state.topic = topicId;
      render();
      if (focus) host.querySelector(".cloudig-docs-article")?.focus({ preventScroll: true });
      host.dispatchEvent(new CustomEvent("cloudig-docs-topic-change", { bubbles: true, detail: { topic: topicId } }));
      return true;
    }

    function click(event) {
      if (event.target.closest("[data-cloudig-docs-close]")) {
        host.dispatchEvent(new CustomEvent("cloudig-docs-close", { bubbles: true }));
        return;
      }
      const topicButton = event.target.closest("button[data-docs-topic]");
      if (topicButton) select(topicButton.dataset.docsTopic, { focus: true });
    }

    function keydown(event) {
      if (!event.target.matches("button[data-docs-topic]") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = data.topics.findIndex((topic) => topic.id === state.topic);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? data.topics.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + data.topics.length) % data.topics.length;
      select(data.topics[nextIndex].id);
      host.querySelector(`button[data-docs-topic="${data.topics[nextIndex].id}"]`)?.focus({ preventScroll: true });
    }

    host.addEventListener("click", click);
    host.addEventListener("keydown", keydown);
    render();
    return Object.freeze({
      select,
      setLocale(nextLocale) {
        state.locale = LOCALES.includes(nextLocale) ? nextLocale : "zh-CN";
        render();
      },
      setVersion(nextVersion) {
        state.version = String(nextVersion || "V1.0.0-dev");
        render();
      },
      selectedTopic() { return state.topic; },
      dispose() {
        host.removeEventListener("click", click);
        host.removeEventListener("keydown", keydown);
        host.replaceChildren();
      }
    });
  }

  return Object.freeze({ schema: SCHEMA, validate, mount, localized });
}));
