import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { build, transform } from "esbuild";
import { JSDOM } from "jsdom";

const shellRoot = path.join(process.cwd(), "src", "ui", "shell");

test("Reader directory fields keep valid inherited typography rather than a rejected font shorthand", async () => {
  const css = await readFile(path.join(shellRoot, "shell.css"), "utf8");
  const dom = new JSDOM();
  try {
    for (const [className, size] of [["reader-directory-create-dialog", "16px"], ["reader-directory-editor", "14px"]]) {
      const rule = css.match(new RegExp(`\\.${className} input \\{([^}]+)\\}`, "u"))?.[1];
      assert.ok(rule, `${className} input rule must exist`);
      const input = dom.window.document.createElement("input");
      for (const [, value] of rule.matchAll(/(?:^|;)\s*font:\s*([^;]+)/gu)) {
        input.style.cssText = ""; input.style.font = value!.trim();
        assert.notEqual(input.style.font, "", `${className}: invalid font shorthand`);
      }
      input.style.cssText = rule;
      assert.equal(input.style.fontSize, size);
      assert.equal(input.style.fontWeight, "400");
      assert.equal(input.style.fontFamily, "inherit");
    }
  } finally { dom.window.close(); }
});

test("Reader directory theme separates the dark fill from readable text and outline accents", async () => {
  const css = await readFile(path.join(shellRoot, "shell.css"), "utf8");
  assert.match(css, /:root\[data-theme="star-night"\] \.reader-directory-card \{[^}]*--rd-outline:\s*#ffa92e;/u);
  for (const selector of [".reader-directory-editor .eyebrow", ".reader-directory-cancel"]) {
    const rule = css.match(new RegExp(`^\\s*${selector.replaceAll(".", "\\.")} \\{([^}]+)\\}`, "mu"))?.[1];
    assert.ok(rule?.includes("color: var(--rd-outline)"), selector);
  }
  assert.match(css, /\.reader-directory-save \{[^}]*background: var\(--rd-accent\);/u);
});

test("Reader total uses singular for one conversation and both hosts describe title or content search", async () => {
  const source = await readFile(path.join(shellRoot, "pages/reader/reader-cover.js"), "utf8");
  const definition = source.slice(source.indexOf("function renderRows("), source.indexOf("function renderDust("));
  const dom = new JSDOM(await readFile(path.join(shellRoot, "index.html"), "utf8"));
  try {
    const document = dom.window.document;
    const root = document.querySelector<HTMLTemplateElement>("#reader-cover-template")!.content.querySelector<HTMLElement>("[data-page=reader]")!;
    const render = new Function("document", "rowPaper", definition + ";return renderRows;")(document, () => document.createDocumentFragment());
    for (const [count, expected] of [[0, "No conversations"], [1, "Total 1 conversation"], [2, "Total 2 conversations"]]) {
      render(root, { items: [], total: 0, catalog_total: count }, "en");
      assert.equal(root.querySelector("[data-reader-total]")!.textContent, expected);
    }
    render(root, { items: [], total: 0, catalog_total: 1 }, "zh-CN");
    assert.equal(root.querySelector("[data-reader-total]")!.textContent, "总1篇对话");
    const en = JSON.parse(await readFile(path.join(shellRoot, "locales/en.json"), "utf8"));
    assert.equal(en.reader.searchPlaceholder, "Title or content");
    assert.equal(en.archiver.searchArchive, "Title or content");
    const zh = JSON.parse(await readFile(path.join(shellRoot, "locales/zh-CN.json"), "utf8"));
    assert.equal(zh.reader.searchPlaceholder, "搜索标题或正文");
    assert.equal(zh.archiver.searchArchive, "搜索标题或正文");
    assert.equal(root.querySelector<HTMLInputElement>("[data-reader-search-input]")!.placeholder, "搜索标题或正文");
  } finally { dom.window.close(); }
});

async function conversationModule(entry = "reader-conversation") {
  const bundled = await build({ entryPoints: [path.join(shellRoot, `pages/reader/${entry}.js`)], bundle: true, write: false, format: "esm", platform: "node", plugins: [{ name: "shared-ui-path", setup(builder) {
    builder.onResolve({ filter: /^\/shared\// }, args => ({ path: args.path === "/shared/time/record-format.js" ? path.join(process.cwd(), "src/core/records/time-labels.mts") : args.path === "/shared/time/core-format.js" ? path.join(process.cwd(), "src/core/time/format-endpoint.mts") : path.join(process.cwd(), "src/ui", args.path.slice(1)) }));
  } }] });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString("base64")}`);
}

test("choosing a conversation closes the narrow overlay without folding a wide catalog", async () => {
  const module = await conversationModule("reader-cover");
  const html = await readFile(path.join(shellRoot, "index.html"), "utf8");
  for (const width of [1280, 1440]) {
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    const globals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ document: dom.window.document, AbortController: dom.window.AbortController, innerWidth: width,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), addEventListener: dom.window.addEventListener.bind(dom.window) })) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    let controller;
    try {
      const opened: string[] = [];
      controller = module.mountReaderCover({ template: dom.window.document.querySelector("#reader-cover-template"),
        state: { language: "en", theme: "dawn", userName: "User", assistantName: "AI" }, model: module.visualReaderFixture(),
        onOpen: (row: { capability: string }) => opened.push(row.capability) });
      const root = controller.element as HTMLElement;
      dom.window.document.body.append(root);
      await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
      if (width === 1280) root.querySelector<HTMLButtonElement>("[data-reader-catalog-toggle=expand]")!.click();
      assert.equal(root.dataset["catalogCollapsed"] ?? "false", "false");
      root.querySelector<HTMLButtonElement>(".reader-row-open")!.click();
      assert.equal(opened.length, 1);
      assert.equal(root.dataset["catalogCollapsed"] ?? "false", width === 1280 ? "true" : "false");
      if (width === 1280) root.querySelector<HTMLButtonElement>("[data-reader-catalog-toggle=expand]")!.click();
      controller.selectForReading(module.visualReaderFixture().items[0]);
      assert.equal(opened.length, 1, "search preparation must not start a second ordinary open");
      assert.equal(root.dataset["catalogCollapsed"] ?? "false", width === 1280 ? "true" : "false", "search hits use the same narrow-catalog boundary");
      if (width === 1280) {
        root.querySelector<HTMLButtonElement>("[data-reader-next]")!.click();
        assert.equal(opened.length, 2);
        assert.equal(root.dataset["catalogCollapsed"], "true");
      } else {
        Object.defineProperty(globalThis, "innerWidth", { value: 1280, configurable: true });
        dom.window.dispatchEvent(new dom.window.Event("resize"));
        assert.equal(root.dataset["catalogCollapsed"], "true", "entering the narrow layout does not cover an already open article");
        root.querySelector<HTMLButtonElement>("[data-reader-catalog-toggle=expand]")!.click();
        dom.window.dispatchEvent(new dom.window.Event("resize"));
        assert.equal(root.dataset["catalogCollapsed"], "false", "remaining inside the narrow layout preserves an intentional open catalog");
      }
    } finally {
      controller?.cleanup(); dom.window.close();
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});

test("Reader Conversation really mounts, tears down a failed mount and ignores late refresh after cleanup", async () => {
  const html = await readFile(path.join(shellRoot, "index.html"), "utf8");
  const module = await conversationModule();
  const dom = new JSDOM(html);
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const expose = (key: string, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  let created = 0, rendered = 0, destroyed = 0;
  let fail = false;
  expose("document", dom.window.document);
  expose("AbortController", dom.window.AbortController);
  expose("CloudigConversationRenderer", { createConversationRenderer: () => {
    created++;
    return { render() { rendered++; if (fail) throw new Error("fixture render failure"); }, destroy() { destroyed++; }, setTheme() {} };
  } });
  try {
    const document = dom.window.document;
    const page = document.querySelector<HTMLTemplateElement>("#reader-cover-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement;
    document.body.append(page);
    const view = { header: { title: "Real mount" }, messages: [], navigation: { items: [] } };
    let finishRefresh: (value: unknown) => void = () => {};
    const sessionChanges: any[] = [];
    const options = { page, template: document.querySelector("#reader-conversation-template"), row: {}, view,
      state: { language: "zh-CN", theme: "dawn" }, translate: (key: string) => key,
      onSessionChange: (next: unknown) => sessionChanges.push(next),
      requestPage: () => new Promise(resolve => { finishRefresh = resolve; }) };
    const controller = module.mountReaderConversation(options);
    assert.equal(page.dataset["conversationReady"], "true");
    assert.equal(created, 1);
    const check = page.querySelector<HTMLInputElement>("[data-reader-session='expand-tools']")!;
    check.checked = true;
    check.dispatchEvent(new dom.window.Event("change"));
    page.querySelector<HTMLButtonElement>("[data-i18n='reader.expandThoughtsTools']")!.click();
    assert.equal(page.querySelector<HTMLInputElement>("[data-reader-session='expand-reasoning']")!.checked, true);
    assert.equal(page.querySelector<HTMLInputElement>("[data-reader-session='expand-tools']")!.checked, true);
    assert.equal(page.querySelector<HTMLInputElement>("[data-reader-session='expand-references']")!.checked, true);
    assert.equal(sessionChanges.at(-1)?.hidden.reasoning, false);
    page.querySelector<HTMLButtonElement>("[data-i18n='reader.hideThoughtsTools']")!.click();
    assert.equal(page.querySelector<HTMLInputElement>("[data-reader-session='hide-reasoning']")!.checked, true);
    assert.equal(page.querySelector<HTMLInputElement>("[data-reader-session='hide-tools']")!.checked, true);
    controller.cleanup();
    controller.cleanup();
    finishRefresh(view);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rendered, 1, "resolved old request must not recreate a detached reader");
    assert.equal(destroyed, 1);
    assert.equal(page.dataset["readerView"], "cover");
    assert.equal(page.querySelector("[data-reader-conversation-main]"), null);
    fail = true;
    assert.throws(() => module.mountReaderConversation(options), /fixture render failure/u);
    assert.equal(created, 2);
    assert.equal(destroyed, 2, "failed mount owns and destroys its renderer");
    assert.equal(page.dataset["conversationReady"], undefined);
    assert.equal(page.querySelector("[data-reader-conversation-navigation], .reader-navigation-preview"), null);
    fail = false;
    const loading = module.mountReaderConversation({ ...options, view: {}, row: { title: "Selected title" }, loading: true });
    assert.equal(page.querySelector("[data-reader-conversation-title]")!.textContent, "Selected title");
    assert.equal(page.dataset["conversationReady"], "false");
    assert.equal(page.querySelector<HTMLElement>("[data-reader-conversation-main]")!.getAttribute("aria-busy"), "true");
    assert.equal(page.querySelector<HTMLElement>(".reader-conversation-loading")!.hidden, false);
    assert.equal(page.querySelector(".reader-conversation-loading [role='progressbar']")!.hasAttribute("aria-valuenow"), false, "unknown progress must not invent a percentage");
    loading.setLoading("preparing");
    assert.equal(page.querySelector(".reader-conversation-loading p")!.textContent, "reader.loadingPreparing");
    loading.replaceView(view);
    assert.equal(page.querySelector("[data-reader-conversation-title]")!.textContent, "Real mount");
    assert.equal(page.dataset["conversationReady"], "true");
    assert.equal(page.querySelector<HTMLElement>(".reader-conversation-loading")!.hidden, true);
    loading.cleanup();
  } finally {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test("a search-opened middle page loads earlier/later without duplicates and navigation seeks the requested page", async () => {
  const module = await conversationModule(), dom = new JSDOM(await readFile(path.join(shellRoot, "index.html"), "utf8"), { pretendToBeVisual: true });
  const globals = new Map<string, PropertyDescriptor | undefined>(), requested: number[] = [], copied: string[] = [], errors: Error[] = [];
  const expose = (key: string, value: unknown) => { globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const document = dom.window.document, page = document.querySelector<HTMLTemplateElement>("#reader-cover-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement;
  document.body.append(page);
  const messages = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, anchor: `message-${i + 1}`, source_index: i, party: { role: "assistant", name: "AI" }, blocks: [{ category: "content", value: { type: "text", text: `Body ${i}` } }] }));
  const model = (offset: number) => ({ header: { title: "Middle page" }, messages: messages.slice(offset, offset + 2), pagination: { offset, limit: 2, returned: Math.min(2, 6 - offset), total_visible: 6, has_next: offset + 2 < 6 }, navigation: { offset: 0, returned: 6, items: messages.map((m, i) => ({ anchor: m.anchor, kind: "assistant", source_index: i, message_offset: i, text: `Body ${i}` })) } });
  let mounted;
  try {
    expose("document", document); expose("AbortController", dom.window.AbortController); expose("CSS", { escape: (v: string) => v }); expose("matchMedia", () => ({ matches: true }));
    expose("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window)); expose("IntersectionObserver", class { observe() {} disconnect() {} });
    dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    expose("CloudigConversationRenderer", { createConversationRenderer: ({ root }: { root: HTMLElement }) => {
      const append = (value: any) => { for (const m of value.messages) { const node = document.createElement("article"); node.className = "cloudig-message"; node.id = m.anchor; root.append(node); } };
      return { render(value: any) { root.replaceChildren(); append(value); }, append, destroy() { root.replaceChildren(); }, setTheme() {} };
    } });
    mounted = module.mountReaderConversation({ page, template: document.querySelector("#reader-conversation-template"), row: {}, view: model(2), state: { language: "en", theme: "dawn" }, translate: (k: string) => k,
      requestPage: async (_session: any, pages: any) => { requested.push(pages?.messages ?? 0); return model(pages?.messages ?? 0); }, onCopy: (id: string) => { copied.push(id); }, onError: (e: Error) => errors.push(e) });
    const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
    page.querySelector<HTMLButtonElement>("[data-reader-load-earlier]")!.click(); await settle();
    assert.deepEqual(requested, [0]); assert.deepEqual([...page.querySelectorAll(".cloudig-message")].map(n => n.id), ["message-1", "message-2", "message-3", "message-4"]);
    page.querySelector(".reader-conversation-scroll")!.dispatchEvent(new dom.window.Event("scroll")); await settle();
    assert.deepEqual(requested, [0, 4]); assert.equal(page.querySelectorAll(".cloudig-message").length, 6);
    page.querySelector<HTMLButtonElement>("#message-4 .reader-message-copy")!.click(); await settle(); assert.deepEqual(copied, ["m3"]);
    mounted.replaceView(model(4)); page.querySelector<HTMLButtonElement>(".reader-navigation-item button")!.click(); await settle();
    assert.equal(requested.at(-1), 0); assert(page.querySelector("#message-1")); assert.equal(errors.length, 0);
    const node = page.querySelector('#message-1')!, fold = document.createElement('details'); fold.append(document.createElement('summary')); node.replaceWith(fold); fold.append(node);
    mounted.focusMessage('message-1'); assert.equal(fold.open, true, 'search result inside a summary group is revealed');
    requested.length = 0;
    const scroll = page.querySelector('.reader-conversation-scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { get: () => page.querySelectorAll('.cloudig-message').length < 6 ? 120 : 800, configurable: true });
    mounted.replaceView(model(0));
    for (let n = 0; n < 20 && requested.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(requested, [2, 4], 'a short collapsed page fetches the following body without an impossible scroll');
    assert.equal(page.querySelectorAll('.cloudig-message').length, 6); assert.equal(errors.length, 0);
  } finally { mounted?.cleanup(); dom.window.close(); for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
});

test("Reader and Archiver share one explicit persisted-time workflow mapping", async () => {
  const source = await readFile(path.join(shellRoot, "archive-workflow.js"), "utf8");
  const workflow = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as {
    normalizeArchiveWorkflow(value: unknown): { sort: string; time_field: string };
    archiveQuerySort(value: string): string;
    archiveQueryTimeField(value: string): string;
    archivePreferenceTimeField(value: string): string;
    archiveTimeFieldLabels(language: string): Record<string, string>;
    archiveRowTimestamp(row: unknown, field: string): string | undefined;
  };
  assert.deepEqual(workflow.normalizeArchiveWorkflow(undefined), { sort: "time_desc", time_field: "file_modified_at" });
  assert.equal(workflow.archiveQuerySort("time_desc"), "content_desc");
  assert.equal(workflow.archiveQueryTimeField("cloudig_edited_at"), "cloudig_edited");
  assert.equal(workflow.archiveQueryTimeField("file_modified_at"), "json_modified");
  assert.equal(workflow.archivePreferenceTimeField("json_modified"), "file_modified_at");
  assert.equal(workflow.archiveTimeFieldLabels("zh-CN")["json_created"], "首次解析时间");
  const row = { mtime_ns: String(BigInt(Date.parse("2026-09-09T05:00:00.000Z")) * 1_000_000n), edited_at: "2025-01-01T00:00:00.000Z", times: { json_created_at: "2024-01-01T00:00:00.000Z" } };
  assert.equal(workflow.archiveRowTimestamp(row, "json_modified"), "2026-09-09T05:00:00.000Z");
  assert.equal(workflow.archiveRowTimestamp(row, "cloudig_edited"), row.edited_at);
  assert.equal(workflow.archiveRowTimestamp(row, "json_created"), row.times.json_created_at);
  assert.equal(workflow.archiveRowTimestamp({ edited_at: row.edited_at }, "json_modified"), undefined);
  assert.equal(workflow.archiveQueryTimeField("first_parsed_at"), "json_created");
  assert.equal(workflow.archivePreferenceTimeField("content_end"), "content_time_end");
});

test("Reader to Archiver routing does not wait for Chrome bookmark inventory and exposes route failures", async () => {
  const [shell, archiver] = await Promise.all([
    readFile(path.join(shellRoot, "shell.js"), "utf8"),
    readFile(path.join(shellRoot, "pages", "archiver", "archiver.js"), "utf8")
  ]);
  const modelBody = shell.match(/async function archiverModel\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
  assert.doesNotMatch(modelBody, /bookmarkQuery\(/u);
  assert.match(shell, /const bookmarkLoad = screenshotQuery[\s\S]*bookmarkQuery\("light"\)[\s\S]*mountedPage\.replaceBookmarks/u);
  assert.match(shell, /revealRoute\(route === "reader" \? "reader\/cover" : route\)\.catch\(\(error\) => showActionError\(error\)\)/u);
  assert.match(archiver, /replaceBookmarks\(bookmarks\) \{ bookmarkModel = bookmarks; render\(\); \}/u);
});

test("Reader process state resets expanded, hidden and navigation choices on a fresh app session", async () => {
  const loaded = await conversationModule() as {
    defaultReaderSession: {
      expanded: { reasoning: boolean; tools: boolean; references: boolean };
      hidden: { reasoning: boolean; tools: boolean };
      navigation: { user: boolean; assistant: boolean; process: boolean };
    };
  };
  const { defaultReaderSession } = loaded;
  const active = structuredClone(defaultReaderSession);
  active.expanded.reasoning = true;
  active.hidden.tools = true;
  active.navigation.process = true;
  const restarted = structuredClone(defaultReaderSession);
  assert.deepEqual(restarted, {
    expanded: { reasoning: false, tools: false, references: false },
    hidden: { reasoning: false, tools: false },
    navigation: { user: true, assistant: true, process: false }
  });
});

test("Reader Cover template preserves the approved region and scroll ownership tree", async () => {
  const html = await readFile(path.join(shellRoot, "index.html"), "utf8");
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#reader-cover-template");
  assert.ok(template);
  const page = template.content.querySelector("[data-page='reader']");
  assert.ok(page);
  assert.equal(page.querySelectorAll(":scope > .reader-topbar").length, 1);
  assert.equal(page.querySelectorAll(".reader-version.cloudig-version-block").length, 1);
  assert.equal(page.querySelectorAll(".reader-body > .reader-catalog").length, 1);
  assert.equal(page.querySelectorAll(".reader-body > .reader-main").length, 1);
  assert.equal(page.querySelectorAll(".reader-body > .reader-navigation").length, 1);
  assert.equal(page.querySelectorAll(".reader-conversation-list[data-scroll-region]").length, 1);
  assert.equal(page.querySelectorAll(".reader-doc-content ul[data-scroll-region]").length, 0, "the six fixed document rows are not a scroll owner");
  assert.equal(page.querySelectorAll(".reader-scene-theme").length, 2);
  assert.equal(page.querySelector(".reader-night-sill")?.getAttribute("src"), "/assets/reader/RCSS-光锥影响下的部分亮光窗台.svg");
  assert.equal(page.querySelectorAll(".reader-audio-reactor").length, 2);
  assert.equal(page.querySelectorAll(".reader-music-note").length, 7);
  assert.equal(page.querySelectorAll(".reader-archive-wake").length, 1);
  assert.equal(page.querySelectorAll(".reader-platform-filter").length, 1);
  assert.equal(page.querySelectorAll(".reader-sort-count [data-i18n='reader.visiblePrefix']").length, 1);
  assert.equal(page.querySelectorAll("[data-reader-time-field][aria-haspopup='dialog']").length, 1);
  assert.equal(page.querySelector("[data-reader-sort-action='time_desc']")?.getAttribute("data-selected"), "true");
  assert.equal(page.querySelector("[data-reader-sort-action='time_asc']")?.getAttribute("data-selected"), "false");
  assert.equal(page.querySelectorAll(".reader-catalog-toggle").length, 2);
  assert.equal(page.querySelectorAll("[data-reader-directory-overlay]").length, 1);
  assert.equal(page.querySelectorAll(".reader-directory-region > .reader-directory-actions").length, 1, "directory commands must escape the shelf stacking context");
  assert.equal(page.querySelectorAll(".reader-directory-shelf .reader-directory-actions").length, 0);
  assert.equal(page.querySelectorAll("[data-reader-directory-overlay-list][data-scroll-region]").length, 1);
  assert.equal(page.querySelectorAll("[data-reader-row-menu-portal]").length, 1);
  assert.equal(page.querySelectorAll("[data-route-target='time/cover']").length, 1);
  assert.equal(page.querySelectorAll("[data-route-target='system/log']").length, 1);
  assert.equal(page.querySelectorAll("[data-route-target='welcome']").length, 1);
  assert.equal(page.querySelectorAll(".reader-doc-assembly").length, 2);
  assert.equal(page.querySelectorAll(".reader-contact-avatar, .reader-contact-copy").length, 2);
  assert.equal(page.querySelectorAll(".reader-doc-backboard, .reader-doc-paper, .reader-doc-title-paper, .reader-doc-clip").length, 0);
  assert.equal(page.querySelectorAll("[src*='Cloudig-Reader-Cover-Scene']").length, 0);
  assert.equal(page.querySelectorAll(".reader-scene-brand-slogan.reader-language-zh").length, 2);
  assert.equal(page.querySelectorAll(".reader-scene-brand-slogan.reader-language-en").length, 2);
  assert.equal(page.querySelectorAll(".reader-scene-brand-slogan[src*='Cloudig-Slogan-English']").length, 2);
});

test("Reader keeps Agent Tool sources out of the fixed official platform rail and labels Code sources", async () => {
  const [module, css, conversationCss, rendererCss] = await Promise.all([
    readFile(path.join(shellRoot, "pages", "reader", "reader-cover.js"), "utf8"),
    readFile(path.join(shellRoot, "pages", "reader", "reader.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "reader", "conversation.css"), "utf8"),
    readFile(path.join(process.cwd(), "src", "ui", "shared", "conversation-renderer", "renderer.css"), "utf8")
  ]);
  assert.match(module, /const platformDefinitions = Object\.freeze\(\[/u);
  assert.match(module, /const agentPlatformDefinitions = Object\.freeze\(\[/u);
  assert.match(module, /const allPlatformDefinitions = Object\.freeze\(\[\.\.\.platformDefinitions, \.\.\.agentPlatformDefinitions\]\)/u);
  const officialRail = module.slice(module.indexOf("const platformDefinitions"), module.indexOf("const agentPlatformDefinitions"));
  for (const id of ["cline", "sillytavern", "kimi-code", "claude-code", "codex"]) assert.equal(officialRail.includes(`["${id}"`), false, `${id} must not occupy the official rail`);
  assert.match(css, /\.reader-platform-filter \{[^}]*grid-template-rows: 96px 40px;[^}]*height: 188px;[^}]*row-gap: 16px;/u);
  assert.match(css, /\.reader-platform-filter \{[^}]*grid-template-rows: 96px; height: 132px;[^}]*padding: 18px 28px;/u);
  assert.match(css, /\.reader-official-platforms \{[^}]*grid-template-columns: repeat\(6, minmax\(0, 40px\)\)/u);
  assert.match(css, /\.reader-official-platforms \{[^}]*row-gap: 16px;/u);
  assert.match(css, /\.reader-agent-platforms \{[^}]*display: flex;[^}]*width: calc\(80% \+ 8px\)/u);
  assert.match(css, /\.reader-platform-toggle \{[^}]*position: absolute;/u);
  assert.match(css, /data-platform-filter-collapsed="true"/u);
  assert.match(css, /\.reader-platform-region \{ height: 220px;/u);
  assert.match(css, /data-platform-filter-collapsed="false"\] \.reader-conversation-list \{ top: 489\.149222px;/u);
  assert.match(css, /reader-platform-button\[data-platform="kimi-code"\][\s\S]*content: "CODE"/u);
  assert.match(css, /reader-platform-mark\[data-platform="claude-code"\][\s\S]*content: "CODE"/u);
  assert.match(conversationCss, /reader-conversation-platform-logo\[data-platform="kimi-code"\][\s\S]*content: "CODE"/u);
  assert.match(conversationCss, /cloudig-avatar:has\(img\[src\$="platform-kimi-code\.svg"\]\)[\s\S]*background: #111111/u);
  assert.match(conversationCss, /cloudig-avatar:has\(img\[src\$="platform-claude-code\.svg"\]\)[\s\S]*background: #111111/u);
  assert.match(conversationCss, /:root\[data-theme="star-night"\][\s\S]*cloudig-avatar:has\(img\[src\$="platform-cline\.svg"\]\)[\s\S]*background: #e2e1e1; border-color: #ffa92e/u);
  assert.match(conversationCss, /:root\[data-theme="star-night"\][\s\S]*cloudig-avatar:has\(img\[src\$="platform-codex\.svg"\]\)[\s\S]*background: #e2e1e1; border-color: #ffa92e/u);
  assert.match(rendererCss, /--cloudig-panel-strong:\s*#f0e3d2/u);
  assert.match(rendererCss, /data-theme="star-night"[\s\S]*--cloudig-panel-strong:\s*#45434a/u);
  assert.match(rendererCss, /data-theme="star-night"[\s\S]*cloudig-process-group-avatar:has\(img\[src\$="platform-cline\.svg"\]\)[\s\S]*background: #e2e1e1; border-color: #ffa92e/u);
  assert.match(rendererCss, /data-theme="star-night"[\s\S]*cloudig-process-group-avatar:has\(img\[src\$="platform-codex\.svg"\]\)[\s\S]*background: #e2e1e1; border-color: #ffa92e/u);
  assert.match(conversationCss, /cloudig-avatar:has\(img\[src\$="platform-kimi-code\.svg"\]\)::after[\s\S]*content: "CODE"/u);
});

test("Reader menu keeps its binding at native height above the compact action rows", async () => {
  const css = await readFile(path.join(shellRoot, "pages", "reader", "reader.css"), "utf8");
  assert.match(css, /\.reader-row-action-panel,\s*\[data-page="reader"\] \.reader-row-destination-panel\s*\{[^}]*background: linear-gradient\(transparent 7\.1px, var\(--reader-menu-paper\) 7\.1px\);[^}]*padding: 31px 10px 10px;/u);
  assert.match(css, /:is\(\.reader-row-action-panel, \.reader-row-destination-panel\)::before\s*\{[^}]*\/ 100% 131\.91px no-repeat;[^}]*height: 27px;[^}]*z-index: 1;/u);
  assert.match(css, /:root\[lang="en"\][^{]*\.reader-row-action-panel::before\s*\{ background-size: 120px 131\.91px;/u);
  assert.doesNotMatch(css, /\.reader-row-(?:action|destination)-panel\s*\{[^}]*padding: 4[34]px/u);
  for (const theme of ["Dawn", "StarNight"]) {
    const svg = await readFile(path.join(process.cwd(), "src", "ui", "assets", "editor", `Title-Paper-Editor-${theme}.svg`), "utf8");
    const artwork = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
    assert.equal(artwork.documentElement.getAttribute("viewBox"), "0 0 77.11 131.91");
    assert.equal(artwork.querySelector('[data-name="背景"]')?.getAttribute("y"), "7.1");
    assert.equal(artwork.querySelectorAll('[data-name="上部装饰"] path').length, 3);
  }
});

test("Reader page code stays page-scoped, module-valid, and free of old graph imports", async () => {
  const summaryCss = await readFile(path.join(shellRoot, 'pages/reader/conversation.css'), 'utf8');
  assert.match(summaryCss, /\.cloudig-summary-message \.cloudig-message-meta\s*\{\s*margin-top:\s*0/u, 'summary entry times must not inherit the avatar overlap');
  const [css, conversationCss, module, conversationModule, shell, shellCss] = await Promise.all([
    readFile(path.join(shellRoot, "pages", "reader", "reader.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "reader", "conversation.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "reader", "reader-cover.js"), "utf8"),
    readFile(path.join(shellRoot, "pages", "reader", "reader-conversation.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.css"), "utf8")
  ]);
  assert.equal(/(^|\n)\s*\.reader-[^{,]+/u.test(css), false, "Reader selectors must begin at the page root");
  assert.equal(/(^|\n)\s*\.reader-[^{,]+/u.test(conversationCss), false, "Conversation selectors must begin at the Reader page root");
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.doesNotMatch(conversationCss, /box-shadow\s*:/u);
  assert.doesNotMatch(`${css}\n${conversationCss}\n${module}\n${conversationModule}\n${shell}`, /manager[\\/]|reader\/src|Cloudig-Reader-Cover-Scene/iu);
  assert.match(css, /grid-template-rows:\s*48px minmax\(0, 1fr\)/u);
  assert.match(shellCss, /@layer pages\s*\{\s*:root\[lang="en"\] \.cloudig-button\.cloudig-page-switch\s*\{[^}]*padding-inline:\s*18px;[^}]*white-space:\s*nowrap;[^}]*width:\s*auto;/u);
  assert.match(css, /:root\[data-theme\]\s+\[data-page="reader"\]\s+\.reader-brand\s+\.reader-brand-slogan\s*\{\s*display:\s*none;/u);
  assert.match(css, /:root\[data-theme\]\s+\[data-page="reader"\]\s+\.reader-scene-brand-slogan\s*\{\s*display:\s*none;/u);
  assert.match(css, /\.reader-platform-region\s*\{[^}]*height:\s*164px;[^}]*padding-block:\s*16px;/u);
  assert.match(css, /\.reader-brand-logo\s*\{[^}]*border-radius:\s*7px;/u);
  assert.match(css, /\.reader-total-pill\s*\{[^}]*top:\s*8px;/u);
  assert.doesNotMatch(css, /\.reader-version\s*\{/u);
  assert.match(shellCss, /\.cloudig-version-block\s*\{[^}]*gap:\s*2px;[^}]*grid-template-rows:\s*11px 11px;[^}]*height:\s*24px;/u);
  assert.match(shellCss, /\.cloudig-version-block :is\(strong, small\)\s*\{[^}]*font-size:\s*11px;[^}]*font-weight:\s*400;[^}]*line-height:\s*11px;/u);
  assert.match(css, /data-platform="kimi"\]\s*\{\s*background:\s*#111111;/u);
  assert.doesNotMatch(css, /:root\[data-theme="star-night"\][^\n{]*\.reader-platform-button\s*\{[^}]*background:\s*#111111/u, "Night keeps the supplied logo backing; only the white Kimi source needs black");
  assert.doesNotMatch(css, /reader-platform-button[^\n]*img\s*\{[^}]*invert\(/u, "Do not recolor the user's platform SVGs to compensate for an invented dark backing");
  assert.match(css, /data-platform="doubao"\]\s*\{[^}]*background:\s*#ffffff;[^}]*padding:\s*0;/u);
  assert.doesNotMatch(css, /data-platform="doubao"\]\s*\{[^}]*overflow:\s*hidden;/u);
  assert.match(css, /data-platform="doubao"\]\s+img\s*\{[^}]*border-radius:\s*7px;[^}]*clip-path:\s*inset\(0 round 7px\);/u);
  assert.match(css, /\.reader-dawn-identity-shelf\s*\{[^}]*height:\s*37px;[^}]*left:\s*610\.436429872145px;[^}]*top:\s*472\.14094899881px;[^}]*width:\s*443px;/u);
  assert.match(css, /\.reader-night-sill\s*\{[^}]*left:\s*-15\.33px;[^}]*top:\s*778\.92px;[^}]*z-index:\s*3;/u);
  assert.match(css, /\.reader-night-curtain\s*\{[^}]*z-index:\s*4;/u);
  assert.match(css, /\.reader-night-desk\s*\{[^}]*z-index:\s*5;/u);
  assert.match(css, /\.reader-night-lit-desk\s*\{[^}]*height:\s*456\.38px;[^}]*left:\s*97px;[^}]*top:\s*575\.62px;[^}]*width:\s*940\.34px;[^}]*z-index:\s*6;/u);
  assert.match(css, /\.reader-night-screen\s*\{[^}]*z-index:\s*7;/u);
  assert.match(css, /\.reader-night-light-cone\s*\{[^}]*z-index:\s*8;/u);
  assert.doesNotMatch(css, /\.reader-night-light-cone\s*\{[^}]*(?:mix-blend-mode|opacity):/u);
  assert.match(css, /@keyframes\s+reader-night-cone\s*\{\s*0%,\s*100%\s*\{[^}]*opacity:\s*1;/u);
  assert.match(css, /\.reader-night-plant\s*\{[^}]*z-index:\s*9;/u);
  assert.match(css, /\.reader-night-parrot\s*\{[^}]*z-index:\s*10;/u);
  assert.match(css, /\.reader-wood-rail-bottom\s*\{\s*bottom:\s*0;\s*\}/u);
  assert.match(css, /\.reader-directory-rail-bottom\s*\{[^}]*background:\s*var\(--reader-directory-rail\);[^}]*filter:\s*drop-shadow\(0 4px 3px rgb\(0 0 0 \/ 42%\)\);[^}]*height:\s*14\.214430px;/u);
  assert.doesNotMatch(css, /\.reader-wood-rail-bottom\s*,\s*\n\s*\[data-page="reader"\]\s+\.reader-directory-rail-bottom/u);
  assert.match(css, /--reader-catalog-art-scale:\s*1/u);
  assert.match(css, /\.reader-directory-books\s*\{[^}]*width:\s*calc\(240px \* var\(--reader-catalog-art-scale\)\)/u);
  assert.match(css, /\.reader-directory-book:nth-child\(4\)\s*\{[^}]*right:\s*0;[^}]*width:\s*calc\(103px \* var\(--reader-catalog-art-scale\)\)/u);
  assert.match(css, /--reader-directory-top:\s*268px[\s\S]*--reader-sort-top:\s*346\.512027px/u);
  assert.match(css, /:root\[data-theme="star-night"\][^{]*\{[\s\S]*--reader-directory-top:\s*272px;[\s\S]*--reader-sort-top:\s*350\.512027px;/u);
  assert.match(css, /\.reader-directory-shelf\s*\{[^}]*z-index:\s*2;[^}]*\}[\s\S]*\.reader-directory-region \.reader-directory-rail-bottom\s*\{\s*z-index:\s*3;/u);
  assert.match(css, /\.reader-sort-region\s*\{[^}]*background:\s*transparent;[^}]*height:\s*66\.637195px;[^}]*top:\s*var\(--reader-sort-top\);/u);
  assert.match(css, /\.reader-time-field-popover\s*\{[^}]*filter:\s*drop-shadow\([^}]*width:\s*min\(260px, calc\(100% - 16px\)\);[^}]*z-index:\s*70;/u);
  assert.match(css, /data-theme="star-night"[^}]*\.reader-time-field-popover\s*\{[^}]*background:\s*#3b383c;[^}]*border-color:\s*#282828;/u);
  assert.doesNotMatch(css, /\.reader-sort-region\s*\{[^}]*z-index:/u);
  assert.match(css, /button:nth-of-type\(1\)\s*\{[^}]*height:\s*calc\(40px \* var\(--reader-catalog-art-scale\)\)[^}]*width:\s*calc\(26\.991290px \* var\(--reader-catalog-art-scale\)\)/u);
  assert.match(css, /button:nth-of-type\(4\)\s*\{[^}]*height:\s*calc\(51\.310291px \* var\(--reader-catalog-art-scale\)\)[^}]*width:\s*calc\(32\.622618px \* var\(--reader-catalog-art-scale\)\)/u);
  assert.match(module, /--reader-catalog-art-scale[\s\S]*catalog\.clientWidth \/ 400/u);
  assert.match(css, /\.reader-directory-overlay\s*\{[^}]*top:\s*398px;/u);
  assert.match(css, /\.reader-directory-overlay\s*\{[^}]*height:\s*min\(calc\(var\(--reader-directory-overlay-shelves, 1\) \* 100px \+ 100px\), calc\(100% - 398px\)\);/u);
  assert.match(css, /\.reader-directory-overlay-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*repeat\(2, 36px\);/u);
  assert.match(css, /\.reader-directory-overlay footer \.cloudig-button-filled\s*\{[^}]*--cloudig-button-fill:\s*var\(--cloudig-seal-red\);[^}]*color:\s*#ffffff;/u);
  assert.match(css, /:root\[data-theme="star-night"\] \[data-page="reader"\] \.reader-directory-overlay footer \.cloudig-button-filled\s*\{[^}]*--cloudig-button-fill:\s*var\(--cloudig-purple\);[^}]*color:\s*var\(--cloudig-orange\);/u);
  assert.match(css, /\.reader-directory-actions\s*\{[^}]*background:\s*var\(--reader-directory\);[^}]*bottom:\s*-40px;[^}]*height:\s*48px;[^}]*padding:\s*8px 14px;[^}]*z-index:\s*50;/u);
  assert.match(css, /Title-Paper-Editor-Dawn\.svg/u);
  for (const animation of ["reader-audio-cone-pulse", "reader-radio-cone-pulse", "reader-radio-needle-tremble", "reader-music-note-rise", "reader-screen-wake", "reader-identity-beacon"]) {
    assert.match(css, new RegExp(`@keyframes\\s+${animation}`, "u"), `${animation} must survive visual reconstruction`);
  }
  assert.match(shellCss, /\[data-scroll-region\]::-webkit-scrollbar\s*\{\s*height:\s*8px;\s*width:\s*8px/u);
  assert.match(shellCss, /@supports not selector\(::-webkit-scrollbar\)[\s\S]*scrollbar-color:\s*var\(--cloudig-scroll-active\) transparent;/u);
  assert.match(shellCss, /--cloudig-scroll-idle:\s*#d3af95;[\s\S]*--cloudig-scroll-active:\s*#d68c80;/u);
  assert.match(shellCss, /data-theme="star-night"[\s\S]*--cloudig-scroll-idle:\s*#3b383c;[\s\S]*--cloudig-scroll-active:\s*#ffa92e;/u);
  assert.match(css, /\.reader-doc-content ul\s*\{[^}]*grid-template-rows:\s*repeat\(6,[^}]*overflow:\s*hidden;/u);
  assert.match(css, /\.reader-doc-board\s*\{[^}]*height:\s*calc\(517\.846962931781px \* var\(--reader-right-scale\)\);[^}]*top:\s*calc\(361\.94616885649px \* var\(--reader-right-scale\)\);[^}]*width:\s*calc\(226\.53237410072px \* var\(--reader-right-scale\)\);/u);
  assert.match(css, /\.reader-doc-content header\s*\{[^}]*gap:\s*calc\(21px \* var\(--reader-right-scale\)\);[^}]*top:\s*calc\(79\.05383114351px \* var\(--reader-right-scale\)\);/u);
  assert.match(css, /\.reader-system-log\s*\{[^}]*left:\s*50%;[^}]*top:\s*calc\(144\.05383114351px \* var\(--reader-right-scale\)\);[^}]*width:\s*calc\(200px \* var\(--reader-right-scale\)\);/u);
  assert.match(css, /\.reader-doc-content ul\s*\{[^}]*top:\s*calc\(166\.05383114351px \* var\(--reader-right-scale\)\);/u);
  assert.match(css, /\.reader-doc-assembly\s*\{[^}]*height:\s*100%;[^}]*object-fit:\s*fill;/u);
  assert.match(css, /--reader-contact-copy:\s*#65626d/u);
  assert.match(css, /data-theme="star-night"[\s\S]*--reader-contact-copy:\s*#ffffff;/u);
  assert.match(css, /\.reader-contact-avatar\s*\{[^}]*height:\s*calc\(66px \* var\(--reader-right-scale\)\);[^}]*left:\s*calc\(21\.16061px \* var\(--reader-right-scale\)\);[^}]*top:\s*calc\(15px \* var\(--reader-right-scale\)\);/u);
  assert.match(css, /\.reader-contact strong\s*\{[^}]*font-size:\s*calc\(16px \* var\(--reader-right-scale\)\);[^}]*left:\s*calc\(98\.8306px \* var\(--reader-right-scale\)\);[^}]*top:\s*calc\(31\.6694px \* var\(--reader-right-scale\)\);/u);
  assert.match(css, /\.reader-contact small\s*\{[^}]*font-size:\s*calc\(12px \* var\(--reader-right-scale\)\);[^}]*gap:\s*calc\(10\.1364px \* var\(--reader-right-scale\)\);[^}]*left:\s*calc\(105\.6099px \* var\(--reader-right-scale\)\);[^}]*top:\s*calc\(57\.8549px \* var\(--reader-right-scale\)\);/u);
  assert.match(css, /\.reader-catalog-toggle-zone\s*\{[^}]*height:\s*84px;[^}]*right:\s*-22px;[^}]*width:\s*22px;/u);
  assert.match(css, /\.reader-catalog-toggle svg rect\s*\{[^}]*fill:\s*var\(--reader-catalog-toggle\);[^}]*stroke:\s*none;/u);
  assert.match(css, /data-catalog-collapsed="true"[^}]*\.reader-catalog-folded-navigation\s*\{[^}]*border:\s*2px solid var\(--reader-catalog-toggle\);[^}]*inset:\s*50% 0 auto;/u);
  assert.match(shell, /function scrollRegionHit[\s\S]*function updateScrollRegionState[\s\S]*cloudig-scroll-operating/u);
  assert.match(module, /platform-doubao\.png/u);
  assert.match(module, /data-reader-catalog-toggle/u);
  assert.match(module, /index \+= 6/u);
  assert.match(module, /--reader-directory-overlay-shelves[\s\S]*Math\.max\(1, Math\.ceil\(values\.length \/ 6\)\)/u);
  assert.match(module, /row:\s*offset < 3 \? "lower" : "upper"/u);
  assert.match(module, /let selectedDirectories = new Set\(\);[\s\S]*pendingDirectories = new Set\(selectedDirectories\)/u);
  assert.match(module, /selectedDirectories\.size > 0 \? \{ directories: \[\.\.\.selectedDirectories\] \} : \{\}/u);
  assert.match(module, /pendingDirectories\.has\(capability\)[\s\S]*pendingDirectories\.delete\(capability\)[\s\S]*pendingDirectories\.add\(capability\)/u);
  assert.match(module, /function dateLabel\(row, field, language\)[\s\S]*archiveRowTimestamp\(row, field\)[\s\S]*formatTimeRange\(\{ start: endpoint \}, language\)/u);
  assert.match(module, /openTimeFieldPopover[\s\S]*archiveTimeFieldLabels[\s\S]*radio\.type = "radio"[\s\S]*applyReaderWorkflow/u);
  assert.match(module, /time_field:\s*query\.time_field/u);
  assert.match(shell, /workflowArchiver:\s*normalizeArchiveWorkflow\(result\.workflow_archiver\)[\s\S]*workflowReader:\s*normalizeArchiveWorkflow\(result\.workflow_reader\)/u);
  assert.match(shell, /onWorkflowChange:\s*\(workflow\) => setArchiveWorkflow\("reader", workflow\)/u);
  assert.match(module, /data-directory-capability/u);
  assert.match(shell, /showArchiveConfirmation/u);
  assert.match(shell, /function showDirectoryCreator[\s\S]*reader-directory-create-dialog[\s\S]*reader-directory-create-error/u);
  assert.match(shell, /function directoryCreateErrorMessage[\s\S]*EEXIST[\s\S]*ENAMETOOLONG[\s\S]*Windows 不允许/u);
  assert.match(shell, /function dialogCloseIcon[\s\S]*M6\.5 6\.5 17\.5 17\.5M17\.5 6\.5 6\.5 17\.5/u);
  assert.match(shell, /function showDirectoryManager[\s\S]*reader-directory-card[\s\S]*NEW DIRECTORY[\s\S]*EDIT DIRECTORY/u);
  assert.match(shell, /async function openDirectoryManager\(action\)[\s\S]*action === "new"[\s\S]*showDirectoryCreator[\s\S]*reader\.directory\.create[\s\S]*queryArchives[\s\S]*manageArchiverDirectories/u);
  assert.match(shell, /requestedRoute === "reader-directory-new"[\s\S]*openDirectoryManager\("new"\)/u);
  assert.match(shellCss, /\.reader-directory-create-layer\s*\{\s*z-index:\s*240;/u);
  assert.match(shellCss, /:is\(\.reader-directory-close, \.reader-directory-create-close\) svg\s*\{[^}]*stroke:\s*currentColor;[^}]*stroke-linecap:\s*round;[^}]*stroke-width:\s*2;/u);
  assert.match(shellCss, /\.reader-directory-create-dialog\s*\{[^}]*width:\s*min\(440px, calc\(100vw - 40px\)\);/u);
  assert.doesNotMatch(shell, /openArchiverDirectoryAction/u);
  assert.match(shell, /request\("reader\.archive\.move"/u);
  assert.match(shell, /request\("reader\.archive\.archive"/u);
  assert.match(shell, /request\("shell\.recycleArchive"/u);
  assert.match(shell, /reader\.archive\.exportMarkdown/u);
  assert.match(conversationModule, /options\.onExport/u);
  assert.doesNotMatch(shell, /reader\.archive\.recycle\.(?:plan|complete)/u);
  assert.match(shellCss, /\.cloudig-dialog-layer/u);
  assert.doesNotMatch(shellCss, /box-shadow\s*:/u);
  assert.match(conversationCss, /width:\s*900px/u);
  assert.match(conversationCss, /max-width:\s*calc\(100%\s*-\s*40px\)/u);
  assert.doesNotMatch(conversationCss, /max-width:\s*calc\(100%\s*-\s*38px\)/u);
  assert.match(conversationCss, /object-fit:\s*fill/u);
  assert.match(conversationCss, /\[data-platform="mistral"\]/u);
  assert.doesNotMatch(conversationCss, /::-webkit-scrollbar|scrollbar-color|scrollbar-width/u);
  assert.doesNotMatch(conversationModule, /updateScrollbar|scrollbarThumb|role=["']scrollbar/u);
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
  await transform(conversationModule, { format: "esm", loader: "js", target: "chrome120" });
  await transform(shell, { format: "esm", loader: "js", target: "chrome120" });
});

test("Reader Conversation template keeps one Main scroll owner and an independent dashed navigation", async () => {
  const [html, conversationModule] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages", "reader", "reader-conversation.js"), "utf8")
  ]);
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#reader-conversation-template");
  assert.ok(template);
  assert.equal(template.content.querySelectorAll("[data-reader-conversation-main]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-reader-conversation-scroll][data-scroll-region]").length, 1);
  const main = template.content.querySelector("[data-reader-conversation-main]");
  const scroll = template.content.querySelector("[data-reader-conversation-scroll]");
  assert.ok(main && scroll);
  assert.equal(main.querySelector(":scope > .reader-conversation-title") !== null, true);
  assert.equal(main.querySelector(":scope > .reader-conversation-toolbar") !== null, true);
  assert.equal(scroll.querySelector(".reader-conversation-title, .reader-conversation-toolbar"), null, "title and toolbar must not share the Main scroll owner");
  assert.equal(scroll.querySelector(":scope > .reader-message-column") !== null, true);
  assert.equal(template.content.querySelectorAll("[data-reader-conversation-scrollbar], [role='scrollbar']").length, 0);
  assert.equal(template.content.querySelectorAll("[data-reader-conversation-scroll-thumb]").length, 0);
  assert.equal(template.content.querySelectorAll("[data-reader-renderer]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-reader-conversation-navigation]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-reader-navigation-list][data-scroll-region]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-reader-navigation]").length, 3);
  assert.equal(template.content.querySelectorAll("[data-route-target='reader-cover']").length, 1);
  assert.match(html, /runtime\/conversation-renderer\.js/u);
  assert.match(html, /runtime\/conversation-renderer\.css/u);
  assert.doesNotMatch(html, /Cloudig-Reader-Conversation-(?:Dawn|StarNight)\.png/iu);
  assert.match(conversationModule, /fragment\.querySelectorAll\("\[data-i18n\]"\)[\s\S]*options\.translate/u);
  assert.match(conversationModule, /fragment\.querySelectorAll\("\[data-i18n-placeholder\]"\)/u);
  assert.match(conversationModule, /suppressPosition = true;[\s\S]*scroll\.style\.overflowAnchor = "none";[\s\S]*ResizeObserver/u);
  assert.match(conversationModule, /observer\?\.observe\(main\);[\s\S]*suppressPosition = false;[\s\S]*schedulePosition\(\)/u);
});

test("Conversation Info is an independent 1200x1000 editor with one low-height scroll owner and current archive commands", async () => {
  const [html, css, module, shell] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages", "conversation-info", "conversation-info.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "conversation-info", "conversation-info.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8")
  ]);
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#conversation-info-template");
  assert.ok(template);
  assert.equal(template.content.querySelectorAll("[data-conversation-info-dialog]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-conversation-info-scroll][data-scroll-region]").length, 1);
  assert.equal(template.content.querySelectorAll(".conversation-info-footer [data-scroll-region]").length, 0);
  assert.equal(template.content.querySelectorAll(".conversation-info-scene").length, 2);
  assert.equal(template.content.querySelectorAll("[data-conversation-name]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-conversation-time-confirm]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-conversation-other-now]").length, 0, "The collapsed end row follows the AI: same start, edit end, confirm; Now stays inside the expanded Terran picker");
  assert.equal(template.content.querySelectorAll(".conversation-info-endpoint-label").length, 2, "Both endpoint labels share one explicit typography rule");
  assert.match(css, /\.conversation-info-endpoint-label\s*\{[^}]*font-size:\s*18px;[^}]*font-weight:\s*700;[^}]*text-align:\s*left;/u);
  assert.match(css, /\.conversation-info-other-endpoint\s*>\s*strong\s*\{\s*margin-right:\s*var\(--conversation-endpoint-label-gap\);/u, "The lower choice must use the same label-to-choice gap as the upper row");
  assert.doesNotMatch(css, /data-endpoint="end"\]\s*>\s*strong/u, "Do not offset the end label's choice independently");
  assert.doesNotMatch(css, /\.conversation-info-time-mode-actions\s*>\s*button:first-child/u, "Deleting the old Parser-default action must not restyle the remaining filled timeline button");
  assert.match(css, /width:\s*1200px/u);
  assert.match(css, /height:\s*min\(1000px, calc\(100vh - 48px\)\)/u);
  assert.match(css, /grid-template-rows:\s*112px minmax\(0, 1fr\) 250px/u);
  assert.match(css, /padding:\s*48px 248px 0 400px/u);
  assert.match(css, /\.conversation-info-layer\s*\{[^}]*top:\s*0;/u);
  assert.equal(template.content.querySelector("[data-conversation-info-dialog]")?.getAttribute("aria-modal"), "true");
  assert.match(css, /@media \(max-width:\s*1600px\)[\s\S]*padding-inline:\s*320px 216px/u);
  assert.doesNotMatch(css, /font:[^;]*\bInter\b/u);
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.match(css, /data-platform="kimi"/u);
  assert.equal(template.content.querySelectorAll(".conversation-info-time-facts:first-child > span").length, 3, "The three dates share one decorated text row, not three equal columns");
  assert.match(css, /grid-template-columns:\s*320px minmax\(0, 1fr\)/u);
  assert.equal(template.content.querySelectorAll(".conversation-info-era-tabs").length, 0, "The obsolete four-tab field layout must not survive beside the approved era bands");
  assert.equal(template.content.querySelector(".conversation-info-time-mode-actions > h3")?.getAttribute("data-conversation-copy"), "presets");
  assert.ok(template.content.querySelector(".conversation-info-time-mode-actions > [data-conversation-time-open]"));
  assert.match(css, /conversation-info-presets\s*\{[^}]*gap:\s*15px 12px;[^}]*repeat\(3, minmax\(0, 88px\)\)/u);
  assert.match(css, /conversation-info-scene\s*\{[^}]*drop-shadow\(0 0 calc\(30px \* var\(--conversation-scene-scale\)\) rgb\(0 0 0 \/ 50%\)\)[^}]*height:\s*calc\(300px/u);
  assert.match(css, /conversation-info-scene-star-night\s*\{[^}]*drop-shadow\(0 0 calc\(30px \* var\(--conversation-scene-scale\)\) rgb\(0 0 0 \/ 80%\)\)[^}]*height:\s*calc\(319\.891px/u);
  assert.match(css, /--conversation-field:\s*#ae8b7f/u);
  assert.match(css, /--conversation-field:\s*#2d2d2d/u);
  assert.match(css, /conversation-info-title-field input[\s\S]*?height:\s*60px/u);
  assert.match(css, /conversation-info-facts li::before[^}]*background:\s*#000000;[^}]*border:\s*2px solid #edebeb;[^}]*height:\s*10px/u);
  assert.match(module, /draft\.content_time\s*=\s*\{ state: "cleared" \}/u);
  assert.match(module, /primaryButton\.disabled = false;\s*secondaryButton\.disabled = false;/u);
  assert.match(shell, /reader\.archive\.info\.query/u);
  assert.match(shell, /reader\.archive\.info\.preview/u);
  assert.match(shell, /commitCurrentConversationInfo\(request, row\.capability, payload\)/u);
  assert.match(module, /reader\.archive\.info\.commit/u);
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
});

test("Content Time Cover keeps exact 300/600/300 banks, three scroll owners and opaque time commands", async () => {
  const [html, css, module, shell] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages", "time-cover", "time-cover.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "time-cover", "time-cover.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8")
  ]);
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#time-cover-template");
  assert.ok(template);
  assert.equal(template.content.querySelectorAll(".time-cover-bank").length, 2);
  assert.equal(template.content.querySelectorAll(".time-cover-center").length, 1);
  assert.equal(template.content.querySelectorAll("[data-scroll-region]").length, 3);
  assert.equal(template.content.querySelectorAll("[data-time-return-source]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-time-create]").length, 2);
  assert.match(css, /grid-template-columns:\s*300px 600px 300px/u);
  assert.match(css, /height:\s*min\(1000px, calc\(100vh - 48px\)\)/u);
  assert.match(css, /\.time-cover-layer[^\n]*padding:\s*0 248px 0 400px[^\n]*top:\s*48px/u);
  assert.match(css, /--time-major-dot-fill:\s*#a52525/u);
  assert.match(css, /--time-minor-dot-fill:\s*#d68c80/u);
  assert.match(css, /time-cover-center-scroll h2 i[^}]*border:\s*3px solid var\(--time-major-dot-stroke\)[^}]*height:\s*12px/u);
  assert.match(css, /time-cover-center-scroll li::before[^}]*border:\s*2px solid var\(--time-minor-dot-stroke\)[^}]*height:\s*8px/u);
  assert.match(css, /time-cover-center-scroll li[^}]*grid-template-columns:\s*40px minmax\(0, 1fr\)/u);
  assert.equal(template.content.querySelectorAll(".time-cover-detail-copy").length, 6);
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.match(module, /Terran\/Sovereign英文翻译来自Claude-Fable-5/u);
  assert.match(shell, /time\.cover\.query/u);
  assert.match(shell, /time\.route\.resolve/u);
  assert.match(shell, /time\.nodes\.children/u);
  assert.match(shell, /time\.delete\.preview/u);
  assert.match(shell, /time\.delete\.commit/u);
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
});

test("Time Editor keeps the approved three banks, one center scroll owner and preview-before-commit controls", async () => {
  const [html, css, module, endpointCss, endpointModule, shell] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages", "time-editor", "time-editor.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "time-editor", "time-editor.js"), "utf8"),
    readFile(path.join(shellRoot, "..", "shared", "time", "endpoint-editor.css"), "utf8"),
    readFile(path.join(shellRoot, "..", "shared", "time", "endpoint-editor.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8")
  ]);
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#time-editor-template");
  assert.ok(template);
  assert.equal(template.content.querySelectorAll(".time-editor-bank").length, 2);
  assert.equal(template.content.querySelectorAll(".time-editor-center").length, 1);
  assert.equal(template.content.querySelectorAll("[data-scroll-region]").length, 5);
  assert.equal(template.content.querySelectorAll("[data-time-editor-impact-body][data-scroll-region]").length, 1);
  assert.match(css, /\.time-editor-layer[^\n]*padding:\s*0 248px 0 400px[^\n]*top:\s*48px/u);
  assert.equal(template.content.querySelectorAll(".time-editor-footer [data-scroll-region]").length, 0);
  assert.equal(template.content.querySelectorAll("[data-time-editor-impact]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-time-editor-delete]").length, 0, "Delete belongs to the node hover actions, not an invented third footer button");
  assert.match(module, /yes\.disabled = false; no\.disabled = false;/u);
  assert.match(module, /visualTimeEditorFixture\(kind = "timeline", action = "edit"\)/u);
  assert.match(module, /action === "create_timeline"/u);
  assert.match(module, /action === "create_time"/u);
  assert.match(css, /grid-template-columns:\s*300px 600px 300px/u);
  assert.match(css, /height:\s*min\(1000px, calc\(100vh - 48px\)\)/u);
  assert.match(css, /--time-input-fill:\s*#ae8b7f/u);
  assert.match(css, /--time-input-border:\s*#a52525/u);
  assert.match(css, /--time-input-fill:\s*#2d2d2d/u);
  assert.match(css, /--time-input-border:\s*#5125a5/u);
  assert.match(css, /\.time-editor-field-grid\[data-kind="timeline"\][^\n]*132px/u);
  assert.match(css, /\.time-editor-version \{[^\n]*height:\s*42px[^\n]*width:\s*132px/u);
  assert.match(css, /:root\[lang="en"\] \.time-editor-node-picker \.cloudig-button[^\n]*font-size:\s*15px[^\n]*padding-inline:\s*8px[^\n]*white-space:\s*nowrap/u);
  assert.match(endpointCss, /--endpoint-input-fill:\s*#ae8b7f/u);
  assert.match(endpointCss, /--endpoint-input-border:\s*#5125a5/u);
  assert.match(module, /time-editor-checkbox cloudig-choice/u);
  assert.match(module, /line\.className = "cloudig-choice"/u);
  assert.doesNotMatch(`${css}\n${endpointCss}`, /box-shadow\s*:/u);
  assert.match(module, /cancel_references/u);
  assert.match(module, /selected_references/u);
  assert.match(module, /options\.onDelete/u);
  assert.match(shell, /time\.editor\.query/u);
  assert.match(shell, /time\.editor\.preview/u);
  assert.match(shell, /time\.editor\.commit/u);
  assert.match(shell, /time\.range\.preview/u);
  assert.match(shell, /time\.endpoint\.preview/u);
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
  await transform(endpointModule, { format: "esm", loader: "js", target: "chrome120" });
});

test("Reader locale keys remain aligned in Chinese and English", async () => {
  const [zh, en] = await Promise.all([
    readFile(path.join(shellRoot, "locales", "zh-CN.json"), "utf8"),
    readFile(path.join(shellRoot, "locales", "en.json"), "utf8")
  ]);
  const zhValues = JSON.parse(zh);
  const enValues = JSON.parse(en);
  assert.deepEqual(Object.keys(enValues.reader).sort(), Object.keys(zhValues.reader).sort());
  assert.equal(enValues.reader.manageArchives, "Manage Archives");
  assert.equal(enValues.reader.contactZhihu, "Zhihu");
  assert.equal(enValues.reader.noConversations, "No conversations");
  assert.equal(enValues.reader.sceneLine1, "Welcome Home,");
  assert.equal(enValues.reader.sceneLine2, "OUR Clouds.");
  assert.match(enValues.reader.chubbs, /^Chubbs,/u);
});
