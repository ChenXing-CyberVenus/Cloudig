import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { transform } from "esbuild";
import { JSDOM } from "jsdom";

const shellRoot = path.join(process.cwd(), "src", "ui", "shell");

test("official JSON and ZIP source rows keep their own platform icon, pin and action tooltip", async () => {
  const source=await readFile(path.join(shellRoot,"pages/archiver/archiver.js"),"utf8");
  const dom=new JSDOM('<main lang="en"><div data-source-list></div></main>');
  try {
    const render=new Function('document','localizePlatformLabel','archiveDateLabel',source.slice(source.indexOf('const platformDefinitions ='),source.indexOf('function contentDate('))+';return renderSourceRows;')(dom.window.document,(_id:string,name:string)=>name,()=> '2026-09-28');
    const platforms=['claude','deepseek','qwen','grok','mistral',undefined];
    const items=platforms.map((platform,index)=>({platform,kind:'claude_json',capability:'s'+index,filename:'export.'+(index>2?'zip':'json'),status:'pending',mtime_ns:'1790600000000000000'}));
    render(dom.window.document.querySelector('main'),{items},new Set(['s3']),{});
    for(const [index,row]of [...dom.window.document.querySelectorAll('.archiver-source-row')].entries()){
      assert.equal(row.querySelector('.archiver-row-platform')!.getAttribute('src'),`/assets/platforms/platform-${platforms[index]??'unknown'}.svg`);
      assert.equal(row.querySelectorAll('.archiver-row-pin').length,2);
      assert.equal(row.getAttribute('data-selected'),String(index===3));
      if(index>0)assert(!row.querySelector<HTMLButtonElement>('[data-source-claude]')!.title.includes('Claude'));
    }
  } finally {dom.window.close();}
});

test("English Archiver instructions retain word boundaries across inline translations", async () => {
  const [html, translation] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "locales/en.json"), "utf8")
  ]);
  const values = JSON.parse(translation);
  const dom = new JSDOM(html);
  try {
    const page = dom.window.document.querySelector<HTMLTemplateElement>("#archiver-template")!.content;
    for (const node of page.querySelectorAll<HTMLElement>("[data-i18n]")) {
      const value = node.dataset["i18n"]!.split(".").reduce((parent, key) => parent?.[key], values);
      if (typeof value === "string") node.textContent = value;
    }
    const paragraph = (key: string) => page.querySelector(`[data-i18n="archiver.${key}"]`)!.closest("p")!.textContent!.replace(/\s+/gu, " ").trim();
    assert.equal(paragraph("workflowAutoLead"), "Automatic: Exit Chrome and choose Light / Full / Tree then select Install All or Install · Light to install only the bookmarklets you need.");
    assert.match(paragraph("workflowManualLead"), /^Manual: Select then create a Chrome bookmark/u);
    assert.equal(paragraph("workflowSaveClaudeBefore"), values.archiver.workflowSaveClaude);
    assert.equal(paragraph("workflowImportBeforeHtml"), "Place bookmarklet HTML files or platform JSON files in the Inbox folder. Open Inbox");
    assert.match(paragraph("workflowReadBefore"), /then choose Start Reading$/u);
    assert.match(paragraph("workflowDocsBefore"), /use Cloudig Documentation · Bookmark Guide and Archive Guide\.$/u);
  } finally { dom.window.close(); }
});

test("Claude English count headings retain desktop-sized columns in compact layouts", async () => {
  const css = await readFile(path.join(shellRoot, "pages/archiver/claude-container.css"), "utf8");
  assert.ok(/:root\[lang="en"\] \[data-page="archiver"\] \{[^}]*--claude-count-column: 72px;/u.test(css), "English count headings need 72px columns");
  assert.ok(/:root\[lang="en"\] \[data-page="archiver"\] \{[^}]*--claude-selection-column: max-content;/u.test(css), "English selection text must not collide with the gear");
  for (const fallback of [72, 58, 52]) {
    assert(css.includes(`var(--claude-count-column, ${fallback}px) var(--claude-count-column, ${fallback}px)`), `Header and rows need the same ${fallback}px fallback`);
  }
});

test("bookmark final-settings failure explains the applied change and retry in both languages", async () => {
  const source = await readFile(path.join(shellRoot, "shell.js"), "utf8");
  const definition = source.slice(source.indexOf("function bookmarkError("), source.indexOf("function libraryMoveError("));
  for (const language of ["zh-CN", "en"]) {
    const explain = new Function("state", definition + ";return bookmarkError;")({ language });
    const error = explain({ code: "CLOUDIG_BOOKMARK_SETTINGS_SAVE_FAILED", message: "raw storage error" });
    assert(error instanceof Error);
    assert.match(error.message, language === "en" ? /bookmarks were updated.*Retry/su : /书签已更新.*重试/su);
    assert.doesNotMatch(error.message, /raw storage error|No bookmark file was changed|没有改动任何书签/u);
  }
});

test("bookmark settings size to their fields while preserving a bounded scroll body", async () => {
  const css = await readFile(path.join(shellRoot, "pages/archiver/archiver.css"), "utf8");
  const popup = /\.archiver-bookmark-target-popover\s*\{([^}]+)\}/u.exec(css)![1]!;
  assert.match(popup, /bottom:\s*auto;/u);
  assert.match(popup, /max-height:\s*calc\(100% - 52px\);/u);
  assert.match(css, /\.archiver-bookmark-target-body\s*\{[^}]*align-content:\s*start;[^}]*overflow:\s*auto;/u);
  assert.match(css, /\.archiver-bookmark-target-body label\s*\{[^}]*align-content:\s*start;/u);
});

test("HTML and Claude confirmations share the one-run directory selector, inline creation, validation and cancellation", async () => {
  const shell = await readFile(path.join(shellRoot, "shell.js"), "utf8");
  const css = await readFile(path.join(shellRoot, "shell.css"), "utf8");
  assert.match(css, /\.cloudig-parse-target \.cloudig-button\s*\{[^}]*min-width:\s*115px;[^}]*padding:\s*6px 14px;[^}]*width:\s*auto;/u);
  const widget = (await readFile(path.join(shellRoot, "parse-target.js"), "utf8")).replace("export function", "function");
  for (const language of ["zh-CN", "en"]) for (const kind of ["html", "claude"]) for (const cancel of [false, true]) {
    const dom = new JSDOM("<main></main>"), document = dom.window.document;
    const mount = new Function("document", widget + ";return mountParseTarget;")(document);
    const name = kind === "html" ? "showParseConfirmation" : "showClaudeExtractionConfirmation";
    const end = kind === "html" ? "function showMissingSourceConfirmation" : "async function indexClaudeSource";
    const definition = shell.slice(shell.indexOf("function " + name + "("), shell.indexOf(end, shell.indexOf("function " + name + "(")));
    const created: string[] = [];
    const create = async (value: string) => { created.push(value); if (value === "Existing") throw new Error("already exists"); return [{ capability: "d_existing", name: "Existing" }, { capability: "d_new", name: value }]; };
    const show = new Function("document", "state", "translated", "overlayRoot", "mountParseTarget", "createParseDirectory", "directoryCreateErrorMessage", definition + ";return " + name + ";")(
      document, { language }, (_key: string, fallback: string) => fallback, document.querySelector("main"), mount, create, (error: Error) => error.message);
    const settings = { directoryLabel: "Conversations/Existing", directories: [{ capability: "d_existing", name: "Existing" }] };
    const answer = kind === "html" ? show([{ filename: "One.html", action: "parse" }], settings) : show([{ title: "Claude one" }], [{ action: "parse" }], settings);
    const select = document.querySelector<HTMLSelectElement>("[data-parse-directory]")!;
    assert.equal(select.value, "d_existing"); assert.equal(document.querySelectorAll(".cloudig-dialog").length, 1);
    if (cancel) {
      select.value = "root"; select.dispatchEvent(new dom.window.Event("change"));
      document.querySelector<HTMLButtonElement>(".cloudig-dialog footer .cloudig-button-outline")!.click();
      assert.equal(await answer, null); assert.deepEqual(created, []);
    } else {
      document.querySelector<HTMLButtonElement>("[data-parse-directory-new]")!.click();
      const input = document.querySelector<HTMLInputElement>("[data-parse-directory-name]")!;
      const save = document.querySelector<HTMLButtonElement>("[data-parse-directory-create]")!;
      const confirm = document.querySelector<HTMLButtonElement>(".cloudig-dialog footer .cloudig-button-filled")!;
      save.click(); assert(!document.querySelector<HTMLElement>(".cloudig-parse-target-error")!.hidden); assert.deepEqual(created, []);
      input.value = "Existing"; save.click(); assert(confirm.disabled);
      await new Promise(resolve => setTimeout(resolve, 0)); assert(!confirm.disabled); assert.equal(document.querySelector(".cloudig-parse-target-error")!.textContent, "already exists");
      input.value = "New"; save.click(); await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(select.value, "d_new"); assert(document.querySelector<HTMLElement>(".cloudig-parse-target-editor")!.hidden);
      confirm.click(); assert.deepEqual(await answer, { directory: "d_new", changed: true }); assert.deepEqual(created, ["Existing", "New"]);
    }
    assert.equal(document.querySelectorAll(".cloudig-dialog-layer").length, 0); dom.window.close();
  }
});

test("pending toolbar and row text share the two measured AI theme colors", async () => {
  for (const [theme, expected] of [["Dawn", "5125a5"], ["StarNight", "7e5eff"]]) {
    const metrics = JSON.parse(await readFile(`release/v1-design-dossiers/Cloudig-Archiver-${theme}.design-metrics.json`, "utf8"));
    const labels = metrics.text_runs.filter((run: { text: string }) => run.text === "待解析");
    assert.ok(labels.length >= 2);
    assert.ok(labels.every((run: { fill: number[] }) => run.fill.map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("") === expected));
  }
  const css = await readFile(path.join(shellRoot, "pages/archiver/archiver.css"), "utf8");
  assert.match(css, /--archiver-pending-copy: var\(--cloudig-purple\)/u);
  assert.match(css, /--archiver-pending-copy: var\(--cloudig-base-blue\)/u);
  assert.equal((css.match(/\[data-(?:source-)?status="pending"\] \{ color: var\(--archiver-pending-copy\); \}/gu) ?? []).length, 2);
});

test("missing-source confirmation offers current/all scopes with the specified defaults and shared choices", async () => {
  const shell = await readFile(path.join(shellRoot, "shell.js"), "utf8");
  const definition = shell.slice(shell.indexOf("function showMissingSourceConfirmation("), shell.indexOf("function showActionError("));
  for (const language of ["zh-CN", "en"]) {
    const labels = JSON.parse(await readFile(path.join(shellRoot, "locales", language + ".json"), "utf8"));
    for (const scope of ["current", "all", "both", "cancel"]) {
      const dom = new JSDOM("<main></main>"), document = dom.window.document;
      const show = new Function("document", "state", "translated", "overlayRoot", definition + ";return showMissingSourceConfirmation;")(
        document, { language }, (key: string, fallback: string) => labels.archiver[key.slice(9)] ?? labels.reader[key.slice(7)] ?? fallback, document.querySelector("main"));
      const answer = show({ filename: "Missing.html" });
      const current = document.querySelector<HTMLInputElement>("[data-missing-record-choice=current]")!;
      const all = document.querySelector<HTMLInputElement>("[data-missing-record-choice=all]")!;
      const confirm = document.querySelector<HTMLButtonElement>("[data-missing-record-confirm]")!;
      assert.equal(current.checked, true); assert.equal(all.checked, false);
      assert.equal(current.parentElement!.className, "cloudig-choice");
      assert.equal(all.parentElement!.textContent, labels.archiver.missingDismissAll);
      if (scope === "all" || scope === "cancel") { current.click(); assert.equal(confirm.disabled, true); }
      if (scope === "all" || scope === "both") all.click();
      if (scope === "cancel") {
        document.querySelector<HTMLButtonElement>("footer button")!.click();
        assert.equal(await answer, false);
      } else {
        assert.equal(confirm.disabled, false); confirm.click();
        assert.deepEqual(await answer, { all_missing: scope !== "current" });
      }
      assert.equal(document.querySelector("[role=dialog]"), null);
      dom.window.close();
    }
  }
});

test("Light is displayed as 轻装 without changing its machine profile", async () => {
  const [html, script, zh, en] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages/archiver/archiver.js"), "utf8"),
    readFile(path.join(shellRoot, "locales/zh-CN.json"), "utf8"),
    readFile(path.join(shellRoot, "locales/en.json"), "utf8")
  ]);
  const definition = script.slice(script.indexOf("function profileName("), script.indexOf("function bookmarkVersionLabel("));
  const profileName = new Function(`${definition};return profileName;`)();
  assert.equal(profileName("light", "zh-CN"), "轻装");
  assert.equal(profileName("light", "en"), "Light");
  assert.equal(JSON.parse(zh).archiver.light, "轻装");
  assert.equal(JSON.parse(en).archiver.light, "Light");
  assert.doesNotMatch(html + script + zh, /轻量/u);
  assert.match(html, /data-bookmark-profile="light"/u);
});

test("platform file imports and settings form one compact group in both languages", async () => {
  const html = await readFile(path.join(shellRoot, "index.html"), "utf8");
  const css = await readFile(path.join(shellRoot, "pages", "archiver", "archiver.css"), "utf8");
  const dom = new JSDOM(html);
  const page = dom.window.document.querySelector<HTMLTemplateElement>("#archiver-template")!.content;
  const group = page.querySelector(".archiver-import-actions")!;
  assert.equal(group.children.length, 3);
  assert.equal(group.children[0]!.getAttribute("data-archiver-shell-action"), "import-html");
  assert.equal(group.children[1]!.getAttribute("data-archiver-shell-action"), "import-claude");
  assert(group.children[2]!.hasAttribute("data-archiver-parse-settings"));
  assert.match(css, /\.archiver-import-actions\s*\{[^}]*align-items: center;[^}]*display: flex;[^}]*flex: none;[^}]*gap: inherit;/u);
  assert.doesNotMatch(css, /margin-left: 31px|grid-template-columns: 26px 118px/u);
  assert.match(css, /\.archiver-archive-toolbar :is\(\[data-archive-time-field\], \[data-archive-sort\], \[data-archive-refresh\]\) \{[^}]*height: 34px;[^}]*min-width: 34px;[^}]*width: 34px;/u);
  assert.match(css, /\[data-page="archiver"\] \[data-archive-refresh\] svg \{[^}]*height: 28px;[^}]*width: 28px;/u);
  assert.match(css, /\.archiver-archive-toolbar \{[^}]*grid-template-columns: minmax\(140px, 1fr\) minmax\(96px, \.7fr\) minmax\(120px, \.9fr\) repeat\(3, 34px\)/u);
  for (const [language, label] of [["zh-CN", "导入平台文件"], ["en", "Import Platform Files"]]) {
    const labels = JSON.parse(await readFile(path.join(shellRoot, "locales", `${language}.json`), "utf8"));
    assert.equal(labels.archiver.importClaude, label);
    assert(labels.archiver.workflowImportButtons.includes(label));
  }
  assert.equal(page.querySelector('[data-highlight-target="import-claude"]')!.textContent, "导入平台文件");
  assert.equal(page.querySelector('[data-highlight-source="import-claude"]')!.textContent, "导入平台文件");
  dom.window.close();
});

test("Archiver information text is centered on its artwork, excluding the list gap", async () => {
  const css = await readFile(path.join(shellRoot, "pages", "archiver", "archiver.css"), "utf8");
  assert.match(css, /--archiver-workspace-scene-height: calc\(var\(--archiver-information-height\) \+ var\(--archiver-scene-gap\)\);/u);
  assert.match(css, /\.archiver-info-copy\s*\{[^}]*align-content: safe center;[^}]*align-self: end;[^}]*height: var\(--archiver-information-height\);/u);
  assert.match(css, /\.archiver-info-copy\s*\{[^}]*grid-auto-rows: max-content;/u, "A wrapping information line must not shrink the ellipsized title into a clipped grid track");
  assert.match(css, /\.archiver-wave,\s*\[data-page="archiver"\] \.archiver-village\s*\{[^}]*grid-area: 1 \/ 1;[^}]*height: auto;[^}]*width: 100%;/u);
  assert.doesNotMatch(css, /clip-path: inset\(0 (?:50% 0 0|0 0 50%)\)/u);
  assert.match(css, /clip-path: inset\(0 calc\(100% - var\(--archiver-parser-basis\)\) 0 0\)/u);
  assert.match(css, /clip-path: inset\(0 0 0 var\(--archiver-parser-basis\)\)/u);
  assert.doesNotMatch(css, /\.archiver-info-copy\s*\{[^}]*(?:transform:|translate:|top:)/u);
  assert.match(css, /\.archiver-info-copy\s*\{[^}]*font-size: clamp\(13px, 2\.515723cqw, 16px\)/u);
  assert.match(css, /@container archiver-workspace \(max-width: 620px\)/u);
  assert.match(css, /@container archiver-workspace \(max-width: 620px\)[\s\S]*?\.archiver-settings-button\s*\{[^}]*margin-left: 0;/u);
});

test("archive delete confirmation uses singular or plural copy from the actual selected rows", async () => {
  const source = await readFile(path.join(shellRoot, "shell.js"), "utf8");
  const definition = source.slice(source.indexOf("function archiveActionCopy("), source.indexOf("function showArchiveConfirmation("));
  for (const language of ["zh-CN", "en"]) {
    const labels = JSON.parse(await readFile(path.join(shellRoot, "locales", `${language}.json`), "utf8"));
    const copy = new Function("state", "translated", `${definition};return archiveActionCopy;`)({ language }, (key: string, fallback: string) => labels.reader[key.slice(7)] ?? fallback);
    const single = copy({ action: "delete", row: { filename: "one.json" } });
    const multiple = copy({ action: "delete", rows: [{ filename: "one.json" }, { filename: "two.json" }] });
    assert.equal(single.agreement, labels.reader.recycleAgreement);
    assert.equal(multiple.agreement, labels.reader.recycleManyAgreement);
    assert.equal(multiple.message, labels.reader.recycleManyDialogMessage);
    if (language === "zh-CN") assert.equal(multiple.agreement, "将以上文件移入 Windows 回收站");
  }
});

test("delete confirmation explicitly lists the paired Mark even for one conversation", async () => {
  const source = await readFile(path.join(shellRoot, "shell.js"), "utf8");
  const functions = source.slice(source.indexOf("function archiveActionCopy("), source.indexOf("function showTimeDeleteConfirmation("));
  for (const language of ["zh-CN", "en"]) {
    const dom = new JSDOM("<main></main>"), document = dom.window.document, labels = JSON.parse(await readFile(path.join(shellRoot, "locales", `${language}.json`), "utf8"));
    try {
      const show = new Function("document", "state", "translated", "overlayRoot", "ordinal", `${functions};return showArchiveConfirmation;`)(document, { language }, (key: string, fallback: string) => labels.reader[key.slice(7)] ?? fallback, document.querySelector("main"), 1);
      const answer = show({ action: "delete", row: { filename: "Conversation.json", mark_file: "01993520-0000-7000-8000-000000000111.json" } });
      const list = document.querySelector(".cloudig-dialog-list")!; assert.match(list.textContent!, /Conversation\.json/); assert.match(list.textContent!, /Mark · 01993520/);
      assert.equal(document.querySelector<HTMLButtonElement>(".cloudig-button-filled")!.disabled, true);
      document.querySelector<HTMLButtonElement>(".cloudig-button-outline")!.click(); assert.equal(await answer, false); assert.equal(document.querySelector(".cloudig-dialog"), null);
    } finally { dom.window.close(); }
  }
});

test("Archiver document navigation keeps named theme butterflies outside localized copy", async () => {
  const html = await readFile(path.join(shellRoot, "index.html"), "utf8");
  const document = new JSDOM(html).window.document;
  const page = document.querySelector<HTMLTemplateElement>("#archiver-template")!.content;
  const entries = [...page.querySelectorAll(".archiver-doc-card li button")];
  assert.deepEqual(entries.map(entry => entry.getAttribute("data-doc-topic")), ["bookmark", "archive", "platforms", "json", "roadmap", "license"]);
  for (const entry of entries) {
    assert.equal(entry.getAttribute("type"), "button");
    assert.equal(entry.hasAttribute("data-i18n"), false, "Translation must not replace butterfly nodes");
    assert.ok(entry.querySelector(":scope > span"));
    assert.equal(entry.querySelector(".archiver-theme-dawn")?.getAttribute("src"), "/assets/reader/SmallButterfly-Dawn.svg");
    assert.equal(entry.querySelector(".archiver-theme-star-night")?.getAttribute("src"), "/assets/reader/SmallButterfly-StarNight.svg");
    assert.equal(entry.querySelectorAll("img[alt='']").length, 2);
  }
  const css = await readFile(path.join(shellRoot, "pages", "archiver", "archiver.css"), "utf8");
  assert.match(css, /button:is\(:hover, :focus-visible\)/u);
  assert.match(css, /--archiver-doc-highlight:\s*#cd7d7c/u);
  assert.match(css, /--archiver-doc-highlight:\s*#7e5eff/u);
  assert.match(css, /li button > img\s*\{[^}]*pointer-events:\s*none/u);
  assert.match(css, /li\[data-highlight="true"\]\s*\{[^}]*outline:\s*0/u);
});

test("Archiver template preserves the approved four-region scene and two independent list scroll owners", async () => {
  const html = await readFile(path.join(shellRoot, "index.html"), "utf8");
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#archiver-template");
  assert.ok(template);
  const page = template.content.querySelector("[data-page='archiver']");
  assert.ok(page);
  assert.equal(page.querySelectorAll(":scope > .archiver-topbar").length, 1);
  assert.equal(page.querySelectorAll(".archiver-version.cloudig-version-block").length, 1);
  assert.equal(page.querySelectorAll(".archiver-body > .archiver-bookmark-rail").length, 1);
  assert.equal(page.querySelectorAll(".archiver-body > .archiver-center").length, 1);
  assert.equal(page.querySelectorAll(".archiver-body > .archiver-docs-rail").length, 1);
  assert.equal(page.querySelectorAll(".archiver-center > .archiver-workspace").length, 2);
  assert.equal(page.querySelector("[data-archiver-parse-settings-popover]")!.parentElement, page.querySelector(".archiver-center"), "Parse settings float independently of either opaque workspace");
  assert.equal(page.querySelectorAll(".archiver-list-body[data-scroll-region]").length, 2);
  assert.equal(page.querySelectorAll(".archiver-column-header[data-scroll-region]").length, 0);
  assert.equal(page.querySelectorAll("[data-archiver-progress]").length, 1);
  assert.equal(page.querySelectorAll("[data-archiver-parse-settings-popover]").length, 1);
  assert.equal(page.querySelectorAll("[data-bookmark-target-popover]").length, 1);
  assert.equal(page.querySelectorAll("[data-bookmark-target-store], [data-bookmark-target-parent], [data-bookmark-target-name]").length, 3);
  assert.equal(page.querySelectorAll(".archiver-bookmark-list[data-scroll-region]").length, 1);
  assert.equal(page.querySelectorAll(".archiver-doc-card ul[data-scroll-region]").length, 0, "the fixed six-row document card is not a scroll owner");
  assert.equal(page.querySelectorAll(".archiver-theme-switch img").length, 2);
  assert.equal(page.querySelector(".archiver-theme-icon-dawn")?.getAttribute("src"), "/assets/reader/OsisLogo-Simple-Mono-Red.svg");
  assert.equal(page.querySelector(".archiver-theme-icon-star-night")?.getAttribute("src"), "/assets/welcome/OsisLogo-Simple-Mono-Orange.svg");
  assert.equal(page.querySelectorAll("[data-source-sort] img, [data-archive-time-field] img, [data-archive-sort] img").length, 3);
  assert.equal(page.querySelector("[data-claude-time] img")?.getAttribute("src"), "/assets/reader/Button-Time-LightCone.svg");
  assert.equal(page.querySelectorAll("[data-source-refresh] svg, [data-archive-refresh] svg").length, 2);
  assert.equal(page.querySelectorAll("[data-archiver-parse-settings] svg").length, 1);
  assert.equal(page.querySelectorAll("[data-bookmark-profile-indicator]").length, 1);
  assert.equal(page.querySelectorAll(".archiver-contact strong").length, 1);
  assert.equal(page.querySelectorAll("[data-parse-setting]").length, 4);
  assert.equal(page.querySelectorAll("[data-parse-target-directory]").length, 1);
  assert.equal(page.querySelectorAll("[data-archiver-splitter][role='separator']").length, 1);
  assert.equal(page.querySelectorAll(".archiver-info-copy[data-scroll-region]").length, 2);
  assert.equal(page.querySelectorAll(".archiver-source-decoration img").length, 2);
  assert.equal(page.querySelectorAll(".archiver-archive-decoration img").length, 2);
  assert.equal(page.querySelectorAll("[data-archiver-workflow]").length, 1);
  assert.equal(page.querySelectorAll("[data-archiver-workflow] > h1").length, 1);
  assert.equal(page.querySelectorAll("[data-archiver-workflow] .archiver-workflow-scroll > h1").length, 0);
  assert.equal(page.querySelectorAll("[data-archiver-workflow-open] svg, .archiver-workflow-usage-action svg").length, 2);
  assert.equal([...page.querySelectorAll("[data-archiver-workflow-open], .archiver-workflow-usage-action")].some((node) => node.textContent?.includes("●")), false);
  assert.equal(page.querySelectorAll(".archiver-weather-phase").length, 4);
  assert.equal(page.querySelectorAll("[data-source-select-all], [data-archive-select-all]").length, 2);
  assert.equal(page.querySelectorAll("[src*='Cloudig-Archiver-'][src$='.png']").length, 0);
});

test("Archiver page code is page-scoped, module-valid and connected to real source commands", async () => {
  const [css, module, shell, shellCss, zh, en, cock] = await Promise.all([
    readFile(path.join(shellRoot, "pages", "archiver", "archiver.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "archiver", "archiver.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.css"), "utf8"),
    readFile(path.join(shellRoot, "locales", "zh-CN.json"), "utf8"),
    readFile(path.join(shellRoot, "locales", "en.json"), "utf8"),
    readFile(path.join(process.cwd(), "src", "ui", "assets", "archiver", "Cock.svg"), "utf8")
  ]);
  assert.equal(/(^|\n)\s*\.archiver-[^{,]+/u.test(css), false, "Archiver selectors must begin at the page root");
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.match(css, /\.archiver-topbar\s*\{[^}]*grid-template-columns:\s*var\(--archiver-bookmark-width\) minmax\(0, 1fr\) max-content;[^}]*padding:\s*0 12px;/u);
  assert.doesNotMatch(css, /\.archiver-topbar-actions\s*\{[^}]*position:\s*absolute/u, "Actions must own a grid column instead of covering the Library controls");
  assert.match(css, /\.archiver-doc-card::before\s*\{[^}]*opacity:\s*\.3/u, "Plate opacity applies after its own shadow and never to the document text");
  assert.match(css, /\.archiver-brand-logo\s*\{[^}]*border-radius:\s*7px;/u);
  assert.doesNotMatch(css, /\.archiver-version\s*\{/u);
  assert.match(shellCss, /\.cloudig-version-block\s*\{[^}]*gap:\s*2px;[^}]*grid-template-rows:\s*11px 11px;[^}]*height:\s*24px;/u);
  assert.match(css, /grid-template-columns:\s*var\(--archiver-bookmark-width\) minmax\(720px, 1fr\) var\(--archiver-docs-width\)/u);
  assert.match(css, /--archiver-side-shadow:\s*rgb\(0 0 0 \/ 30%\)/u);
  assert.match(css, /data-theme="star-night"[^}]*--archiver-side-shadow:\s*rgb\(0 0 0 \/ 80%\)/u);
  assert.match(css, /\.archiver-bookmark-rail\s*\{[^}]*filter:\s*drop-shadow\(3px 0 4px var\(--archiver-side-shadow\)\)/u);
  assert.match(css, /\.archiver-docs-rail\s*\{[^}]*filter:\s*drop-shadow\(-3px 0 4px var\(--archiver-side-shadow\)\)[^}]*overflow:\s*visible;/u);
  assert.match(css, /\.archiver-brand-title\s*\{[^}]*left:\s*48px;[^}]*width:\s*64\.131404px;/u);
  assert.match(css, /\.archiver-brand-slogan\s*\{[^}]*left:\s*124\.131404px;[^}]*width:\s*252\.14468px;/u);
  assert.match(css, /\.archiver-center\s*\{[^}]*grid-template-columns:\s*minmax\(360px, var\(--archiver-parser-basis\)\) minmax\(360px, 1fr\)/u);
  assert.doesNotMatch(css, /grid-template-columns:\s*minmax\(360px, var\(--archiver-parser-basis\)\) 4px/u);
  assert.match(css, /\.archiver-list-body\s*\{[^}]*overflow:\s*auto;/u);
  assert.match(css, /\.archiver-doc-card ul\s*\{[^}]*grid-template-rows:\s*repeat\(6,[^}]*overflow:\s*hidden;/u);
  assert.match(css, /\.archiver-bookmark-panel\s*\{[^}]*height:\s*auto;[^}]*max-height:\s*calc\(100% - 190px\)/u);
  assert.match(css, /\.archiver-bookmark-row\s*\{[^}]*grid-template-columns:\s*32px minmax\(0, 1fr\) 90px 20px;[^}]*height:\s*var\(--bookmark-row-height\);/u);
  assert.match(css, /\.archiver-bookmark-row strong\s*\{[^}]*font-size:\s*14px;/u);
  assert.match(css, /\.archiver-bookmark-row small\s*\{[^}]*font-size:\s*11px;/u);
  assert.match(css, /\.archiver-import-actions > \[data-archiver-shell-action\] \{ width: auto; min-width: 0; padding-inline: 10px; white-space: nowrap;/u);
  assert.doesNotMatch(css, /data-archiver-shell-action="import-claude"\]\s*\{\s*width:/u, 'Import labels own their width in both languages');
  assert.match(css, /\.archiver-profile-selector\s*\{[^}]*background:\s*#eb6c5a;/u);
  assert.match(css, /\.archiver-profile-selector\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 96\.58px;[^}]*height:\s*52px;[^}]*padding:\s*0 13\.42px 0 4px;[^}]*width:\s*306px;/u);
  assert.match(css, /\.archiver-profile-options button\s*\{[^}]*gap:\s*3\.44px;/u);
  assert.match(css, /\.archiver-bookmark-row > img\s*\{[^}]*background:\s*#ffffff;[^}]*border-radius:\s*0;/u);
  assert.doesNotMatch(css, /\.archiver-bookmark-row em\s*\{/u);
  assert.match(css, /\.archiver-bookmark-hint::before\s*\{[^}]*clip-path:\s*polygon/u);
  assert.match(css, /grid-template-columns:\s*repeat\(3, max-content\)/u);
  assert.match(css, /data-theme="star-night"[^\n]*\.archiver-profile-selector \.archiver-install-all\s*\{[^}]*background:\s*var\(--cloudig-base-blue\);[^}]*color:\s*#ffffff;/u);
  assert.match(module, /copyButton\.append\(copyIcon\(\)\)/u);
  assert.match(module, /Button-Name-Flower\.svg/u);
  assert.match(module, /archivePreferenceTimeField\(archiveTimeField\)/u);
  assert.match(module, /onArchiveWorkflow/u);
  assert.match(module, /data-bookmark-profile-indicator/u);
  assert.doesNotMatch(module, /copyButton\.textContent\s*=\s*"⧉"/u);
  assert.match(css, /\.archiver-wave-blue,[\s\S]*clip-path:\s*inset\(0 calc\(100% - var\(--archiver-parser-basis\)\) 0 0\)/u);
  for (const animation of ["archiver-phoenix-breathe", "archiver-rocket-drift", "archiver-ship-float", "archiver-astronaut-float", "archiver-sunflower-turn"]) {
    assert.match(css, new RegExp(`@keyframes ${animation}`, "u"));
  }
  assert.doesNotMatch(css, /archiver-cock-life/u);
  assert.match(css, /\.archiver-right-poem\s*\{[^}]*color:\s*#cec4bc;[^}]*filter:\s*drop-shadow/u);
  assert.match(css, /:root\[data-theme="star-night"\][^\n]*\.archiver-right-poem\s*\{[^}]*color:\s*#ffffff;[^}]*filter:\s*drop-shadow/u);
  assert.match(css, /\.archiver-weather-phase\s*\{[^}]*archiver-season-cycle 24s/u);
  assert.doesNotMatch(css, /🌸|❄|archiver-weather-fall|31vh|16vh/u);
  const weatherHtml = await readFile(path.join(shellRoot, "index.html"), "utf8");
  for (const shape of ["archiver-blossom", "archiver-maple-leaf", "archiver-snow-crystal"]) {
    assert.match(weatherHtml, new RegExp(`<symbol id="${shape}"`, "u"));
    assert.match(weatherHtml, new RegExp(`<use href="#${shape}"`, "u"));
  }
  assert.match(css, /\.archiver-weather\s*\{[^}]*pointer-events:\s*none;[^}]*z-index:\s*0;/u);
  assert.match(css, /\.archiver-weather-rain > i\s*\{[^}]*animation-duration:\s*calc\(var\(--weather-duration\) \* \.3\)/u);
  for (const motion of ["rooster-crest-sway", "rooster-wattle-sway", "rooster-head-response", "rooster-tail-feather-lift", "rooster-tail-glint", "rooster-eye-blink", "rooster-feather-sheen", "rooster-tail-feather-motion"]) {
    assert.match(cock, new RegExp(motion, "u"));
  }
  assert.doesNotMatch(cock, /7\.2s/u);
  const frozenCock = await readFile(path.join(process.cwd(), "ui/assets/archiver/Cock.svg"), "utf8");
  assert.equal(cock.replace(/<style>[\s\S]*?<\/style>/u, ""), frozenCock.replace(/<style>[\s\S]*?<\/style>/u, ""), "Rooster motion must not alter the drawing, viewBox, feet or layering");
  assert.match(module, /visualArchiverFixture/u);
  assert.match(module, /visualArchiverEmptyFixture/u);
  assert.match(module, /updateOperationProgress\(region, event, filenames\)/u);
  const sharedProgress = await readFile(path.join(shellRoot, "operation-progress.js"), "utf8");
  assert.match(sharedProgress, /data-progress-bar/u);
  assert.match(module, /root\.dataset\.parseSettingsOpen\s*=\s*String\(open\)/u);
  assert.match(module, /dataset\.bookmarkExpanded/u);
  assert.match(module, /archiver-source-file/u);
  assert.match(module, /selectionMarker/u);
  assert.match(module, /Pushpin-Red\.svg/u);
  assert.match(module, /Pushpin-Purple\.svg/u);
  assert.doesNotMatch(module, /className = "archiver-row-select"/u);
  assert.match(module, /dataset\.sourceActionState\s*=\s*row\.status/u);
  assert.match(css, /\.archiver-source-parse:not\(:disabled\)::before\s*\{[^}]*border-left:\s*19px solid var\(--cloudig-purple\)/u);
  assert.doesNotMatch(css, /\[data-workflow-open="true"\] \.archiver-center-scenes/u);
  assert.match(css, /\.archiver-workflow\s*\{[^}]*bottom:\s*var\(--archiver-workspace-scene-height\);[^}]*top:\s*var\(--archiver-workspace-header-height\);/u);
  assert.match(css, /\.archiver-workflow::before\s*\{[^}]*background:\s*#cec4bc;[^}]*opacity:\s*\.3/u);
  assert.doesNotMatch(css, /\.archiver-workflow\s*\{[^}]*filter:\s*drop-shadow/u, "Only the background plate casts the shadow, not the workflow text");
  assert.match(css, /\.archiver-workflow p\s*\{[^}]*display:\s*block/u, "Guide sentences flow around inline actions rather than wrapping each text span as a flex item");
  assert.match(css, /data-workflow-open="true"[^\n]*\.archiver-list-card\s*\{[^}]*visibility:\s*hidden;/u);
  assert.doesNotMatch(css, /data-parse-settings-open="true"[^\n]*\.archiver-parser-workspace/u, "Opening settings must not lift the opaque Parser workspace above the shared scene");
  assert.match(css, /\.archiver-parse-settings-popover\s*\{[\s\S]*?z-index:\s*70;/u);
  assert.match(css, /:root\[lang="en"\][^\n]*\.archiver-parse-settings-popover footer \.cloudig-button\s*\{[^}]*white-space:\s*nowrap;[^}]*width:\s*auto;/u, "English settings actions fit their labels without changing the page font size");
  assert.match(css, /\.archiver-list-row \.archiver-row-marker \.archiver-row-pin\s*\{[^}]*display:\s*none;/u);
  assert.match(css, /\.archiver-selected-actions\s*\{\s*max-width:\s*100%;\s*width:\s*100%;/u);
  assert.match(css, /\.archiver-doc-card ul\s*\{[^}]*grid-template-rows:\s*repeat\(6, 45\.13px\);[^}]*height:\s*270\.78px;/u);
  assert.match(css, /\.archiver-contact img\s*\{[^}]*border:\s*6px solid var\(--cloudig-seal-red\);[^}]*height:\s*40px;[^}]*width:\s*40px;/u);
  assert.match(css, /data-theme="star-night"[^\n]*\.archiver-contact img\s*\{[^}]*border-color:\s*var\(--cloudig-base-blue\)/u);
  assert.match(css, /\.archiver-right-scene\s*\{[^}]*overflow:\s*visible;[^}]*transform:\s*scale\(var\(--archiver-right-scale\)\);[^}]*width:\s*248px;/u);
  assert.match(css, /@media \(max-width:\s*1320px\)[\s\S]*--archiver-right-scale:\s*\.6;[\s\S]*\.archiver-doc-card\s*\{[^}]*height:\s*360px;[^}]*top:\s*80px;/u);
  assert.match(css, /\.archiver-workflow h1::before\s*\{[^}]*OsisLogo-Cloudig-RedBackWhiteAbyss\.svg/u);
  assert.match(shell, /archiver\.sources\.query/u);
  assert.match(shell, /indexes\.rebuild/u);
  assert.match(shell, /if \(archives\.degraded\)/u);
  assert.match(shell, /archiver\.parse\.plan/u);
  assert.match(shell, /archiver\.parse\.commit/u);
  assert.match(shell, /\{ plan: plan\.plan \}/u);
  assert.doesNotMatch(shell, /copy_user_state/u, "preserving an old result does not copy its Mark to a different Conversation");
  assert.match(shell, /safe_update: "安全更新同一档案"/u);
  assert.match(shell, /shell\.pickSource/u);
  assert.match(shell, /source\.import/u);
  assert.match(shell, /archiver\.source\.dismissMissing/u);
  assert.match(shell, /仅清除来源队列记录，不删除已经生成的对话档案、用户设置或资源/u);
  assert.match(shell, /reader\.directory\.create/u);
  assert.match(shell, /reader\.directory\.rename/u);
  assert.match(shell, /reader\.directory\.delete/u);
  assert.match(shell, /performArchiverArchiveAction/u);
  assert.match(shell, /reader\.archive\.exportMarkdown/u);
  assert.match(shell, /shell\.openManagedFolder", \{ folder: "exports" \}/u);
  for (const command of ["query", "target.query", "target.save", "copy", "install", "remove"]) {
    assert.match(shell, new RegExp(`shell\\.bookmarks\\.${command.replace(".", "\\.")}`, "u"));
  }
  assert.match(shell, /shell\.library\.info/u);
  assert.match(shell, /shell\.libraryMove\.plan/u);
  assert.match(shell, /shell\.libraryMove\.commit/u);
  assert.match(shell, /showLibraryMoveConfirmation/u);
  assert.match(shell, /showLibraryMoveProgress/u);
  assert.match(module, /data-bookmark-operation/u);
  assert.match(module, /data-bookmark-target-save/u);
  assert.match(module, /Gemini、豆包、智谱清言、元宝/u);
  assert.match(shell, /requestedRoute === "archiver"/u);
  assert.match(shell, /requestedRoute === "identity-conversation"/u);
  assert.match(shell, /requestedRoute === "identity-editor"/u);
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
  await transform(shell, { format: "esm", loader: "js", target: "chrome120" });
  const zhValues = JSON.parse(zh);
  const enValues = JSON.parse(en);
  assert.deepEqual(Object.keys(enValues.archiver).sort(), Object.keys(zhValues.archiver).sort());
  assert.equal(enValues.archiver.startReader, "Start Reading");
  assert.equal(enValues.archiver.usage, "Guide");
  assert.equal(zhValues.archiver.usage, "使用方法");
  assert.equal(zhValues.archiver.missingDismissMessage, "仅清除所选范围的解析区记录与错误日志，不删除已生成的对话档案、用户设置或资源。");
  assert.equal(zhValues.archiver.phoenixPoemLine2, "浮云蔽日可采集，平台变迁何须愁？");
  assert.equal(enValues.archiver.phoenixPoemLine1, "Death is NOT the phoenix' nest,");
  assert.equal(enValues.archiver.phoenixPoemLine3, "To Cloudig never-ending fest.");
  assert.equal(enValues.archiver.cockPoemLine1, "Beside the lake, beneath the trees,");
  assert.equal(enValues.archiver.cockPoemLine2, "Cloudig sees.");
});

test("Claude JSON route keeps the Archiver rails, one center card, bounded progress and one list scroll owner", async () => {
  const [html, css, module, shell] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages", "archiver", "claude-container.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "archiver", "claude-container.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8")
  ]);
  const document = new JSDOM(html).window.document;
  const page = document.querySelector<HTMLTemplateElement>("#archiver-template")!.content.querySelector("[data-page='archiver']")!;
  const view = page.querySelector("[data-archiver-claude-view]")!;
  const coworkWarning = page.querySelector(".archiver-claude-cowork-warning")!;
  assert.deepEqual(Array.from(coworkWarning.querySelectorAll(":scope > .archiver-claude-cowork-line"), row => row.textContent!.replace(/\s+/gu, "")), [
    "截止2026-08，", "Claude的官方导出不包含Cowork数据。", "可在Chrome中打开具体cowork对话，", "使用Claude书签下载。"
  ]);
  assert.equal(coworkWarning.querySelectorAll("svg circle, svg path").length, 2);
  assert.equal(coworkWarning.querySelectorAll("i").length, 0);
  assert.match(css, /archiver-claude-cowork-warning svg\s*\{\s*color:\s*#d97757;/u);
  assert.match(css, /archiver-claude-cowork-warning > \.archiver-claude-cowork-line \{ display: block; \}/u);
  assert.equal(page.querySelectorAll(".archiver-body > .archiver-bookmark-rail").length, 1);
  assert.equal(page.querySelectorAll(".archiver-body > .archiver-docs-rail").length, 1);
  assert.equal(page.querySelectorAll(".archiver-center > [data-archiver-claude-view]").length, 1);
  assert.equal(view.querySelectorAll("[data-claude-records][data-scroll-region]").length, 1);
  assert.equal(view.querySelectorAll("[data-claude-progress]").length, 1);
  assert.equal(view.querySelectorAll("[data-claude-progress-cancel]").length, 1);
  assert.equal(view.querySelectorAll("[data-claude-settings-popover]").length, 1);
  assert.equal(view.querySelectorAll("[data-claude-setting]").length, 4);
  assert.equal(view.querySelectorAll(".archiver-claude-columns > span:first-child").length, 0);
  assert.equal(view.querySelectorAll("[data-claude-rebuild], [data-claude-return]").length, 2);
  assert.equal(view.querySelectorAll("[src*='TitleDec-']").length, 4);
  assert.equal(/(^|\n)\s*\.archiver-[^{,]+/u.test(css), false, "Claude selectors must begin at the Archiver page root");
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.match(css, /data-archiver-mode="claude"/u);
  assert.match(css, /grid-template-rows:\s*auto 72px auto 40px minmax\(0, 1fr\) 62px/u);
  assert.match(css, /112\.2446px minmax\(54px, auto\)/u);
  assert.match(css, /inset:\s*22px 36px 24px/u);
  assert.match(module, /queryPageSize/u);
  assert.match(module, /commitBatchSize/u);
  assert.match(module, /statusQuery/u);
  assert.match(module, /className = "archiver-claude-select"/u);
  assert.doesNotMatch(module, /select\.type = "checkbox"/u);
  assert.match(css, /archiver-claude-select\[aria-pressed="true"\] img/u);
  assert.match(module, /Pushpin-\$\{color\}/u);
  for (const color of ["Red", "Purple"]) assert.match(await readFile(path.join(shellRoot, "..", "assets", "reader", `Pushpin-${color}.svg`), "utf8"), /<svg/u);
  assert.match(css, /#e8d6c4 0%, 87%, #c7e6e9 100%/u);
  assert.match(css, /#2d2d2d 0%, 87%, #1e1e1e 100%/u);
  assert.match(css, /archiver-claude-footer \.cloudig-button \{ --cloudig-button-fill: #777777; color: #ffffff;/u);
  assert.match(module, /data-claude-progress-bar/u);
  for (const command of ["index", "records.query", "extract.preview", "extract.commit"]) {
    assert.match(shell, new RegExp(`archiver\\.claude\\.${command.replace(".", "\\.")}`, "u"));
  }
  assert.match(shell, /\{ plans \}/u);
  assert.match(shell, /preserve_previous: context\.preserve_previous === true/u);
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
});
