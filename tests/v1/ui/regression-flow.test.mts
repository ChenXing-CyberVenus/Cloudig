import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createLocalLibrary, readWelcomeLibraryState } from "../../../src/adapters/library-data/index.mts";
import { LibraryEngineCommands } from "../../../src/engine/library-commands.mts";
import { RecordTimeEngineCommands as TimeEngineCommands } from "../../../src/engine/record-time-commands.mts";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { RecordReaderEngineCommands } from "../../../src/engine/record-reader-commands.mts";
import { RecordIdentityEngineCommands } from "../../../src/engine/record-identity-commands.mts";
import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
import { commitRecords, withRecordSnapshot } from "../../../src/adapters/storage/record-store.mts";
import { readRecordCatalog } from "../../../src/adapters/library-data/record-catalog.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const shell = path.join(process.cwd(), "src/ui/shell");
test("default user avatar is the same named artwork in Reader, cover and identity settings", async () => {
  const source = await readFile(path.join(shell, "shell.js"), "utf8");
  const resolver = source.slice(source.indexOf("function applicationAsset(asset)"), source.indexOf("async function showTransition()"));
  for (const theme of ["dawn", "star-night"]) {
    const resolve = new Function("state", `${resolver}; return applicationAsset;`)({ theme });
    assert.equal(resolve("Assets/Defaults/user.svg"), "/assets/welcome/OsisLogo-Cloudig-1024.png");
    assert.equal(resolve("Assets/Defaults/assistant.svg"), "/assets/welcome/OsisLogo-Simple.svg");
    assert.equal(resolve("Assets/Platforms/chatgpt.svg"), "/assets/platforms/platform-chatgpt.svg");
    assert.equal(resolve("Assets/Platforms/doubao.svg"), "/assets/platforms/platform-doubao.png");
  }
  assert.doesNotMatch(source, /identityApplicationAsset/u, "all presentation routes must use the same application asset resolver");
});
test("metadata dates use the device day without changing civil dates or source timestamp bytes", () => {
  const script = `import {archiveDateLabel,archiveInstantLabel} from './src/ui/shell/archive-workflow.js';const value='2026-09-12T01:00:00Z';console.log(JSON.stringify({date:archiveDateLabel(value),full:archiveInstantLabel(value),civil:archiveDateLabel('2026-09-12'),invalid:archiveDateLabel(null),value}));`;
  for (const [zone, date, offset] of [["America/Los_Angeles", "2026-09-11", "UTC-07:00"], ["Asia/Tokyo", "2026-09-12", "UTC+09:00"]]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, TZ: zone }, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
    assert.equal(result.date, date); assert(result.full.endsWith(offset)); assert.equal(result.civil, "2026-09-12"); assert.equal(result.invalid, "—"); assert.equal(result.value, "2026-09-12T01:00:00Z");
  }
});
async function ui(file: string) {
  const result = await build({ entryPoints: [path.join(shell, file)], bundle: true, write: false, format: "esm", platform: "node", plugins: [{ name: "ui-root", setup(builder) {
    builder.onResolve({ filter: /^\/shared\// }, args => ({ path: args.path === "/shared/time/record-format.js" ? path.join(process.cwd(), "src/core/records/time-labels.mts") : args.path === "/shared/time/core-format.js" ? path.join(process.cwd(), "src/core/time/format-endpoint.mts") : path.join(process.cwd(), "src/ui", args.path.slice(1)) }));
  } }] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text + `\n//# sourceURL=cloudig-ui-test/${file}\n`).toString("base64")}`);
}
async function environment(run: (document: Document, window: JSDOM["window"], expose: (key: string, value: unknown) => void) => Promise<void>) {
  const dom = new JSDOM(await readFile(path.join(shell, "index.html"), "utf8"));
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const expose = (key: string, value: unknown) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  expose("document", dom.window.document); expose("AbortController", dom.window.AbortController);
  expose("Option", dom.window["Option"]);
  expose("addEventListener", dom.window.addEventListener.bind(dom.window)); expose("requestAnimationFrame", () => 0);
  expose("CSS", { escape: (value: string) => value }); expose("matchMedia", () => ({ matches: true }));
  expose("IntersectionObserver", class { observe() {} disconnect() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  expose("ResizeObserver", dom.window["ResizeObserver"]);
  try { await run(dom.window.document, dom.window, expose); }
  finally {
    for (const [key, original] of originals) { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test("Claude empty-source notices do not replace parse status or the real message and branch counts", async () => environment(async document => {
  const module = await ui('pages/archiver/claude-container.js');
  for (const language of ['zh-CN', 'en']) {
    const root = document.querySelector<HTMLTemplateElement>('#archiver-template')!.content.firstElementChild!.cloneNode(true) as HTMLElement; document.body.append(root);
    const index = module.visualClaudeContainerFixture(); index.items = index.items.slice(0, 2); Object.assign(index.items[0], { messages: 32, branches: 2, empty_messages: 32, status: 'parsed' });
    Object.assign(index.items[1], { messages: 32, branches: 2, empty_messages: 1, status: 'parsed' });
    const controller = module.mountClaudeContainer({ root, index, state: { language, theme: 'dawn' }, query: async () => index }); await settle();
    const row = root.querySelector('[data-claude-row]')!; assert.equal(row.getAttribute('data-status'), 'parsed');
    assert.equal(row.querySelector('.archiver-claude-empty-note')!.textContent, language === 'en' ? 'Empty source' : '原导出无正文');
    assert(row.textContent!.includes('32')); assert(row.textContent!.includes('2'));
    assert.equal(root.querySelectorAll('.archiver-claude-empty-note').length, 1, 'Partial empty nodes have no note or tooltip');
    controller.cleanup(); root.remove();
  }
}));

test("Reader explains only an entirely empty source, never individual empty nodes or hidden content", async () => environment(async (document, _window, expose) => {
  const module = await ui('pages/reader/reader-conversation.js');
  expose('CloudigConversationRenderer', { createConversationRenderer: () => ({ render() {}, append() {}, destroy() {}, setTheme() {} }) });
  const root = document.querySelector<HTMLTemplateElement>('#reader-cover-template')!.content.firstElementChild!.cloneNode(true) as HTMLElement; document.body.append(root);
  const view = { header: {}, messages: [], pagination: { total_canonical: 32, total_contentful: 0, empty_messages: 32, total_visible: 0 }, navigation: { items: [] }, branch: { leaves: { items: [], total: 2 } } };
  const controller = module.mountReaderConversation({ page: root, template: document.querySelector('#reader-conversation-template'), row: {}, view, state: { language: 'zh-CN', theme: 'dawn' }, translate: (key: string) => key });
  const notice = root.querySelector<HTMLElement>('[data-reader-source-notice]')!;
  assert(!notice.hidden); assert.equal(notice.dataset['kind'], 'source'); assert.match(notice.textContent!, /32条消息记录和2个分支/u); assert.equal(root.querySelectorAll('.cloudig-message').length, 0);
  controller.setLoading('reading'); assert(notice.hidden); controller.setLoading(null); assert(!notice.hidden);
  controller.replaceView({ ...view, pagination: { ...view.pagination, total_contentful: 4, empty_messages: 28 } }); assert(notice.hidden);
  controller.replaceView({ ...view, pagination: { ...view.pagination, total_contentful: 4, empty_messages: 28, total_visible: 4 } }); assert(notice.hidden);
  controller.updateState({ language: 'en', theme: 'star-night' }); assert(notice.hidden);
  controller.replaceView(view); assert(!notice.hidden); assert.match(notice.textContent!, /32 message records and 2 branches/u);
  controller.replaceView({ ...view, pagination: { ...view.pagination, total_contentful: 32, empty_messages: 0, total_visible: 32 } }); assert(notice.hidden);
  controller.cleanup(); root.remove();
}));

test("Archive deletion paints zero first, counts native successes, then refreshes and removes progress", async () => environment(async (document) => {
  const { runArchiveDeletion } = await ui("operation-progress.js");
  const rows = [{ filename: "A.json" }, { filename: "B.json" }, { filename: "C.json" }];
  const counts: number[] = [], names: string[] = [];
  let refreshed = false;
  const pending = runArchiveDeletion({ host: document.body, rows, language: "zh-CN", recycle: async (row: any) => {
    const region = document.querySelector("[data-delete-progress]")!;
    counts.push(region.querySelector<HTMLProgressElement>("progress")!.value);
    names.push(region.querySelector("[data-progress-file]")!.textContent!);
    assert.match(region.textContent!, /正在移入回收站/u);
    assert.equal(names.at(-1), row.filename);
  }, refresh: async () => {
    const region = document.querySelector("[data-delete-progress]")!;
    assert.equal(region.querySelector<HTMLProgressElement>("progress")!.value, 3);
    assert.equal(region.querySelector("[data-progress-counter]")!.textContent, "3 / 3");
    refreshed = true;
  } });
  assert.equal(document.querySelector<HTMLProgressElement>("[data-delete-progress] progress")!.value, 0);
  assert.equal(await pending, 3);
  assert.deepEqual(counts, [0, 1, 2]);
  assert.deepEqual(names, rows.map(row => row.filename));
  assert.equal(refreshed, true);
  assert.equal(document.querySelector("[data-delete-progress]"), null);
}));

test("Failed deletion neither counts a failed file nor starts the next one, and leaves no stuck progress", async () => environment(async (document) => {
  const { runArchiveDeletion } = await ui("operation-progress.js");
  let attempted = 0, refreshed = false;
  await assert.rejects(runArchiveDeletion({ host: document.body, rows: [{ filename: "A.json" }, { filename: "B.json" }, { filename: "C.json" }], language: "en", recycle: async () => {
    attempted++;
    assert.equal(document.querySelector<HTMLProgressElement>("[data-delete-progress] progress")!.value, attempted - 1);
    if (attempted === 2) throw new Error("fixture recycle failed");
  }, refresh: async () => { refreshed = true; } }), /fixture recycle failed/u);
  assert.equal(attempted, 2); assert.equal(refreshed, false);
  assert.equal(document.querySelector("[data-delete-progress]"), null);
}));

test("Both time entry points use selectable offsets and shared precision-aware calendar labels", async () => environment(async (document) => {
  const module = await ui("../shared/time/endpoint-editor.js");
  const empty = module.timeZoneSelect(undefined, "zh-CN") as HTMLSelectElement;
  assert.equal(empty.tagName, "SELECT"); assert.equal(empty.value, "");
  assert.equal(empty.hasAttribute("data-scroll-picker"), true);
  assert.equal(empty.options[0]!.textContent, "不设时区");
  for (const zone of ["Z", "+05:30", "+05:45", "-03:30", "+14:00", "-12:00"]) assert.ok([...empty.options].some(option => option.value === zone), zone);
  assert.equal(module.timeZoneSelect("+08:07", "en").value, "+08:07", "Existing legal minute offsets remain selectable");
  assert.equal(module.timeZoneSelect("+00:00", "en").value, "Z");
  const css = await readFile(path.join(process.cwd(), "src/ui/shared/time/endpoint-editor.css"), "utf8");
  assert.match(css, /\.cloudig-endpoint-zone, \.cloudig-endpoint-zone::picker\(select\) \{ appearance: base-select;/u);
  assert.match(css, /--endpoint-zone-fill: #f1ded2;/u);
  assert.match(css, /data-theme="star-night"[\s\S]*--endpoint-zone-fill: #2d2d2d;/u);
  assert.doesNotMatch(css, /scrollbar-(?:color|width)|box-shadow/u, "Timezone control must not invent a private scrollbar or box shadow");
  const host = document.createElement("div");
  module.appendCalendarFields(host, { kind: "calendar", era: "AD", year: 2026, month: 9, day: 8, hour: 12 }, "exact", "zh-CN");
  assert.equal(host.querySelector("input[data-endpoint-field=offset]"), null);
  const select = host.querySelector<HTMLSelectElement>("select[data-endpoint-field=offset]")!;
  select.value = "+05:45";
  assert.equal(module.readCalendarFields(host, { era: "AD" }).offset, "+05:45");
  select.value = "";
  assert.equal("offset" in module.readCalendarFields(host, { era: "AD" }), false);
  for (const [endpoint, expected] of [
    [{ kind: "calendar", era: "AD", year: 2026 }, "2026年"],
    [{ kind: "calendar", era: "AD", year: 2026, month: 9 }, "2026年9月"],
    [{ kind: "calendar", era: "AD", year: 2026, month: 9, day: 8 }, "2026-09-08"]
  ]) assert.equal(module.formatTimeEndpoint(endpoint, "zh-CN"), expected);
  assert.equal(module.formatTimeEndpoint({ kind: "calendar", era: "AD", year: 2026, month: 9 }, "en"), "September 2026");
  assert.match(module.timeInputError({ code: "CLOUDIG_TIME_RANGE_INVALID", message: "CLOUDIG_TIME_INVALID_CALENDAR_DATE" }), /日期不存在/u);
  assert.doesNotMatch(module.timeInputError({ code: "CLOUDIG_COMMAND_FAILED", message: "Command failed" }), /Command failed/u);
  assert.equal(module.timeInputError({ message: "此时段已经映射到同一时间轴" }), "此时段已经映射到同一时间轴");
}));

test("Conversation Info keeps its default empty even when the source carries an old inferred time", async () => environment(async (document) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  const info = module.visualConversationInfoFixture();
  info.draft.content_time = { state: "inherit" };
  info.effective.content_time = { state: "unavailable" };
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info, state: { language: "zh-CN" }, terranPresets: [] });
  const root: HTMLElement = controller.element; document.body.append(root);
  const summary = root.querySelector("[data-conversation-time-display]")!;
  assert.match(summary.textContent!, /内容覆盖的时间/u);
  assert.doesNotMatch(summary.textContent!, /2026|默认内容时间|来自首条/u);
  assert.equal(root.querySelector("[data-conversation-time-inherit]"), null);
  controller.cleanup();
}));

test("Archiver hover information carries actual filename, dates, exporter or Parser version and lazy Claude count", async () => environment(async (document, window) => {
  const module = await ui("pages/archiver/archiver.js");
  const model = module.visualArchiverFixture();
  const source = model.sources.items.find((row: any) => !row.filename.endsWith(".json"));
  source.source_file = "capture (2).html"; source.exporter_version = "3.7.34-light"; source.platform = "chatgpt";
  const archive = model.archives.items[0];
  archive.parser = "1.0.7"; archive.mtime_ns = "1788768000000000000"; archive.content_time = { state: "unavailable" };
  let counted = 0;
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model, state: { language: "zh-CN", theme: "dawn" }, querySourceInfo: async () => { counted++; return { records: 17 }; } });
  const root: HTMLElement = controller.element; document.body.append(root);
  const inspect = (selector: string) => root.querySelector(selector)!.dispatchEvent(new window.Event("pointerenter"));
  inspect(`[data-source-capability='${source.capability}']`);
  const sourceInfo = root.querySelector("[data-source-info]")!;
  assert.match(sourceInfo.textContent!, /capture \(2\)\.html/u);
  assert.match(sourceInfo.textContent!, /采集时间/u);
  assert.match(sourceInfo.textContent!, /书签版本：ChatGPT-3\.7\.34-Light/u);
  inspect(`[data-archive-capability='${archive.capability}']`);
  const archiveInfo = root.querySelector("[data-archive-info]")!;
  assert.match(archiveInfo.textContent!, /内容时间：未设置/u);
  assert.match(archiveInfo.textContent!, /解析器版本：1\.0\.7/u);
  const json = model.sources.items.find((row: any) => row.filename.endsWith(".json"));
  assert.ok(json);
  inspect(`[data-source-capability='${json.capability}']`); await settle();
  assert.match(sourceInfo.textContent!, /JSON中的对话数：17/u);
  inspect(`[data-source-capability='${json.capability}']`); await settle(); assert.equal(counted, 1);
  controller.cleanup();
}));

test("both Archiver refresh buttons update sources and archives together and report failures", async () => environment(async (document) => {
  const module = await ui("pages/archiver/archiver.js");
  const model = module.visualArchiverFixture();
  let sources = 0; let archives = 0; let errors = 0; let fail = false;
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model, state: { language: "zh-CN", theme: "dawn" },
    querySources: async () => { sources++; if (fail) throw new Error("refresh failed"); return { ...model.sources, items: [], total: 0 }; },
    queryArchives: async () => { archives++; return { ...model.archives, items: [], total: 0, directories: [] }; },
    onError: () => errors++
  });
  const root: HTMLElement = controller.element; document.body.append(root);
  for (const selector of ["[data-source-refresh]", "[data-archive-refresh]"]) {
    root.querySelector<HTMLButtonElement>(selector)!.click(); await settle();
  }
  assert.equal(sources, 2); assert.equal(archives, 2);
  assert.equal(root.querySelectorAll("[data-source-list] [data-source-capability]").length, 0);
  assert.equal(root.querySelectorAll("[data-archive-list] [data-archive-capability]").length, 0);
  assert.equal(root.querySelector("[data-archive-info]")!.textContent, "选择或指向档案查看信息");
  fail = true;
  root.querySelector<HTMLButtonElement>("[data-archive-refresh]")!.click(); await settle();
  assert.equal(errors, 1, "refresh failures must not look like a button with no response");
  controller.cleanup();
}));

test("a missing archive cache is rebuilt without reparsing and retry drops expired directory capabilities", async () => {
  const source = await readFile(path.join(shell, "shell.js"), "utf8");
  const body = source.slice(source.indexOf("async function queryArchives("), source.indexOf("\nasync function querySources("));
  const calls: any[] = [];
  const run = new Function("screenshotQuery", "request", "ensureIndexes", `${body}; return queryArchives;`)(new URLSearchParams(),
    async (command: string, payload: unknown) => { calls.push([command, payload]); return { degraded: calls.length === 1 }; },
    async () => { calls.push(["indexes.rebuild"]); });
  assert.equal((await run({ limit: 200, directory: "i_expired", sort: "content_desc" })).degraded, false);
  assert.deepEqual(calls, [["reader.archives.query", { limit: 200, directory: "i_expired", sort: "content_desc" }], ["indexes.rebuild"], ["reader.archives.query", { limit: 200, sort: "content_desc" }]]);
});

test("changing articles cancels queued native resource work and detaches the cancellation listener", async () => {
  const source = await readFile(path.join(shell, "shell.js"), "utf8");
  const body = source.match(/async function requestWithSignal\([\s\S]*?\n\}/u)![0];
  let cancelled = 0; let finish: (value: unknown) => void = () => {};
  const call = new Function("beginRequest", `${body}; return requestWithSignal;`)(() => ({ promise: new Promise(resolve => { finish = resolve; }), cancel: async () => { cancelled++; } }));
  const controller = new AbortController();
  const pending = call("reader.resource.materialize", {}, controller.signal);
  controller.abort(); finish({ done: true }); await pending;
  assert.equal(cancelled, 1);
  const after = new AbortController(); const completed = call("reader.identity.resolve", {}, after.signal);
  finish({ done: true }); await completed; after.abort(); assert.equal(cancelled, 1);
});

test("ordinary parsing confirms the complete metadata-only plan before any execution, including an unloaded page", async () => {
  const source = await readFile(path.join(shell, "shell.js"), "utf8");
  const start = source.indexOf("async function performArchiverParse(");
  const end = source.indexOf("\nfunction showClaudeExtractionConfirmation", start);
  const body = source.slice(start, end).replace("async function performArchiverParse", "async function run");
  for (const consent of [null, { changed: false, directory: "root" }, { changed: true, directory: "d_folder" }]) {
    const calls: string[] = [];
    const load = new Function("beginRequest", "showParseConfirmation", "currentPage", "showActionError", "queryArchives", "request", `let activeParseOperation=null; ${body}; return run;`);
    const run = load((command: string) => { calls.push(command); return { promise: Promise.resolve(command.endsWith("plan") ? {state:"ready",plan:"pp_test", items:[{filename:"sample"},{filename:"outside the loaded page"}]} : {state:"completed"}) }; },
      async (items: any[]) => { assert.deepEqual(items.map(i => i.filename), ["sample", "outside the loaded page"]); calls.push("confirm"); return consent; }, { clearProgress() {}, refreshAll: async () => {} }, async (error: unknown) => { throw error; }, async () => ({ directories: [] }), async (command: string, payload: any) => { calls.push(command); assert.equal(payload.directory, consent?.directory); return { plans: ["pp_retargeted"] }; });
    await run([{capability:"s_test",filename:"sample"}], {one_click:true});
    assert.deepEqual(calls, consent ? ["archiver.parse.plan", "confirm", "archiver.parse.retarget", "archiver.parse.commit"] : ["archiver.parse.plan", "confirm"]);
  }
});

test("Archiver one-click is enabled for off-page pending files and passes only actual selected rows; default output persists from the existing selector", async () => environment(async (document) => {
  const module = await ui("pages/archiver/archiver.js"), model = module.visualArchiverFixture();
  model.sources.items = model.sources.items.filter((r: any) => r.kind === "bookmark_html").map((r: any) => ({ ...r, status: "complete", selected: false })); model.sources.statuses = { pending: 213, complete: model.sources.items.length }; model.sources.total = 213 + model.sources.items.length;
  model.archives.directories = [{ capability: "d_folder", name: "Folder", count: 0 }]; let parsed: any, saved: any;
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model, state: { language: "zh-CN", theme: "dawn", defaultOutputDirectory: "Conversations/Folder" }, onParse: (...args: any[]) => { parsed = args; }, onParseSettings: async (...args: any[]) => { saved = args; return args[0]; } });
  const root: HTMLElement = controller.element; document.body.append(root); const button = root.querySelector<HTMLButtonElement>("[data-archiver-parse-all]")!; assert.equal(button.disabled, false); button.click(); assert.deepEqual(parsed[0], []); assert.equal(parsed[1].one_click, true);
  root.querySelector<HTMLButtonElement>("[data-archiver-parse-settings]")!.click(); const select = root.querySelector<HTMLSelectElement>("[data-parse-target-directory]")!; assert.equal(select.value, "d_folder"); select.value = "root";
  root.querySelector<HTMLButtonElement>("[data-parse-settings-save]")!.click(); await settle(); assert.equal(saved[1], "Conversations"); controller.cleanup();
}));

test("Both one-click settings create directories in place without saving cancelled drafts, in Chinese and English", async () => environment(async (document, window) => {
  const archiver = await ui("pages/archiver/archiver.js"), claude = await ui("pages/archiver/claude-container.js");
  for (const language of ["zh-CN", "en"]) for (const kind of ["html", "claude"]) {
    let directories = [{ capability: "d_old", name: "Original", count: 0 }], completeCreate: (() => void) | undefined;
    const saved: any[] = [], parsed: any[] = [], errors: unknown[] = [];
    const create = async (name: string) => {
      if (directories.some(d => d.name === name)) throw new Error("already exists");
      await new Promise<void>(resolve => { completeCreate = resolve; });
      directories = [...directories, { capability: "d_new", name, count: 0 }]; return directories;
    };
    const state = { language, theme: "dawn", defaultOutputDirectory: "Conversations/Original", parseOrdinary: { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false }, parseClaude: { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false } };
    const model = archiver.visualArchiverFixture(); model.archives.directories = directories;
    let root: HTMLElement, controller: any;
    if (kind === "html") {
      controller = archiver.mountArchiver({ template: document.querySelector("#archiver-template"), model, state,
        onCreateParseDirectory: create, onParseSettings: async (...args: any[]) => { saved.push(args); return args[0]; }, onParse: (...args: any[]) => parsed.push(args), onError: (error: unknown) => errors.push(error) });
      root = controller.element; document.body.append(root);
    } else {
      root = document.querySelector<HTMLTemplateElement>("#archiver-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement; document.body.append(root);
      const fixture = claude.visualClaudeContainerFixture();
      controller = claude.mountClaudeContainer({ root, index: fixture, state, directories, createDirectory: create,
        query: async () => fixture, savePreferences: async (...args: any[]) => { saved.push(args); return { parse: args[0], workflow: args[1] }; }, extract: (...args: any[]) => parsed.push(args), onError: (error: unknown) => errors.push(error) });
    }
    await settle();
    const prefix = kind === "html" ? "parse" : "claude", panel = root.querySelector<HTMLElement>(kind === "html" ? "[data-archiver-parse-settings-popover]" : "[data-claude-settings-popover]")!;
    assert(panel.hasAttribute("data-scroll-region"), "Settings share Cloudig scrollbar states when the creator increases their height");
    const open = () => root.querySelector<HTMLButtonElement>(kind === "html" ? "[data-archiver-parse-settings]" : "[data-claude-settings]")!.click();
    const click = (selector: string) => panel.querySelector<HTMLButtonElement>(selector)!.click();
    open();
    assert.equal(panel.querySelector<HTMLSelectElement>("[data-parse-directory]")!.value, "d_old");
    const preserved = panel.querySelector<HTMLInputElement>(`[data-${prefix}-setting='preserve_previous']`)!;
    preserved.checked = true;
    click("[data-parse-directory-new]"); click("[data-parse-directory-create]");
    assert.equal(panel.querySelector<HTMLElement>("[role=alert]")!.hidden, false); assert.equal(completeCreate, undefined);
    const input = panel.querySelector<HTMLInputElement>("[data-parse-directory-name]")!;
    input.value = "Original"; click("[data-parse-directory-create]"); await settle();
    assert.match(panel.querySelector("[role=alert]")!.textContent!, /already exists/u);
    input.value = "Created"; click("[data-parse-directory-create]"); await settle();
    assert.equal(panel.querySelector<HTMLButtonElement>(`[data-${prefix}-settings-save]`)!.disabled, true);
    root.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })); assert.equal(panel.hidden, false);
    assert.deepEqual(saved, []); completeCreate!(); await settle();
    assert.equal(panel.querySelector<HTMLSelectElement>("[data-parse-directory]")!.value, "d_new"); assert.equal(preserved.checked, true);
    assert.doesNotMatch(panel.querySelector(".cloudig-parse-target-note")!.textContent!, /仅本次|For this run only/u);
    click(`[data-${prefix}-settings-cancel]`); open();
    assert.equal(panel.querySelector<HTMLSelectElement>("[data-parse-directory]")!.value, "d_old"); assert.deepEqual(saved, []);
    assert.equal(panel.querySelector<HTMLInputElement>(`[data-${prefix}-setting='preserve_previous']`)!.checked, false);
    assert.equal(panel.querySelectorAll("option[value=d_new]").length, 1, "Cancelled settings do not delete the explicitly created directory");
    panel.querySelector<HTMLSelectElement>("[data-parse-directory]")!.value = "d_new";
    panel.querySelector<HTMLInputElement>(`[data-${prefix}-setting='preserve_previous']`)!.checked = true;
    click(`[data-${prefix}-settings-save]`); await settle();
    assert.equal(saved.length, 1); const savedCall: any = saved.at(0); assert(savedCall); assert.equal(savedCall[kind === "html" ? 1 : 2], "Conversations/Created");
    open(); assert.equal(panel.querySelector<HTMLSelectElement>("[data-parse-directory]")!.value, "d_new"); click(`[data-${prefix}-settings-cancel]`);
    root.querySelector<HTMLButtonElement>(kind === "html" ? "[data-archiver-parse-all]" : "[data-claude-one-click]")!.click(); await settle();
    assert.equal(kind === "html" ? parsed[0][1].directory : parsed[0][1], "d_new"); assert.equal(parsed[0][kind === "html" ? 1 : 2].preserve_previous, true);
    assert.deepEqual(errors, []); controller.cleanup(); root.remove();
  }
}));

test("Archiver selects the full snapshot without rendering every row, keeps off-page selection on refresh and dispatches all selected rows", async () => environment(async (document, window) => {
  const module = await ui("pages/archiver/archiver.js"), fixture = module.visualArchiverFixture();
  const sourceSeed = fixture.sources.items.find((row: any) => row.kind === "bookmark_html"), archiveSeed = fixture.archives.items[0];
  const sourceRows = Array.from({ length: 453 }, (_, i) => ({ ...sourceSeed, capability: `s${i}`, filename: `source${i}`, status: "pending", selected: false }));
  const archiveRows = Array.from({ length: 453 }, (_, i) => ({ ...archiveSeed, capability: `a${i}`, filename: `archive${i}`, selected: false }));
  fixture.sources = { ...fixture.sources, snapshot: "source-snapshot", total: 453, items: sourceRows.slice(0, 200) };
  fixture.archives = { ...fixture.archives, snapshot: "archive-snapshot", total: 453, items: archiveRows.slice(0, 200) };
  const calls: any[] = []; let parsed: any[] = [], acted: any[] = [];
  const query = (kind: "source" | "archive", payload: any) => {
    calls.push([kind, payload]); const rows = kind === "source" ? sourceRows : archiveRows;
    if (payload.snapshot) assert.deepEqual(Object.keys(payload).sort(), ["limit", "offset", "snapshot"]);
    return Promise.resolve({ ...(kind === "source" ? fixture.sources : fixture.archives), offset: payload.offset, items: rows.slice(payload.offset, payload.offset + payload.limit) });
  };
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model: fixture, state: { language: "zh-CN", theme: "dawn" },
    querySources: (payload: any) => query("source", payload), queryArchives: (payload: any) => query("archive", payload),
    onParse: (rows: any[]) => { parsed = rows; }, onArchiveAction: (_action: string, rows: any[]) => { acted = rows; }, onError: (error: unknown) => { throw error; } });
  const root: HTMLElement = controller.element; document.body.append(root);
  for (const kind of ["source", "archive"]) { root.querySelector<HTMLButtonElement>(`[data-${kind}-select-all]`)!.click(); await settle(); }
  assert.equal(root.querySelectorAll("[data-source-list] [data-source-capability]").length, 200);
  assert.equal(root.querySelectorAll("[data-archive-list] [data-archive-capability]").length, 200);
  assert.equal(root.querySelector("[data-source-select-all]")!.getAttribute("aria-pressed"), "true");
  root.querySelector<HTMLButtonElement>("[data-archiver-parse-all]")!.click(); assert.equal(parsed.length, 453);
  root.querySelector<HTMLButtonElement>("[data-archive-action='delete']")!.click(); assert.equal(acted.length, 453);
  await controller.refreshAll(); assert.equal(root.querySelector("[data-archive-select-all]")!.getAttribute("aria-pressed"), "true");
  root.querySelector<HTMLElement>("[data-source-list]")!.dispatchEvent(new window.Event("scroll")); await settle();
  assert.equal(root.querySelectorAll("[data-source-list] [data-source-capability]").length, 400);
  root.querySelector<HTMLButtonElement>("[data-archiver-parse-all]")!.click(); assert.equal(parsed.length, 453);
  root.querySelector<HTMLButtonElement>("[data-source-select-all]")!.click(); assert.equal(root.querySelector("[data-source-select-all]")!.getAttribute("aria-pressed"), "false");
  assert(calls.some(([kind, payload]) => kind === "source" && payload.offset === 400 && payload.snapshot === "source-snapshot")); controller.cleanup();
}));

test("source selection is uploaded in native-sized chunks and one-click resolves only once after the final chunk", async () => {
  const source = await readFile(path.join(shell, "shell.js"), "utf8"), start = source.indexOf("async function performArchiverParse("), end = source.indexOf("\nfunction showClaudeExtractionConfirmation", start);
  const body = source.slice(start, end), calls: any[] = [];
  const run = new Function("beginRequest", "showParseConfirmation", "currentPage", "showActionError", "queryArchives", `let activeParseOperation=null; ${body}; return performArchiverParse;`)(
    (command: string, payload: any) => { calls.push([command, payload]); return { promise: Promise.resolve(command.endsWith("select") ? { selection: "selection-test" } : { state: "ready", plan: "plan-test", items: [] }) }; },
    async () => null, { clearProgress() {} }, async (e: unknown) => { throw e; }, async () => ({ directories: [] }));
  await run(Array.from({ length: 1203 }, (_, i) => ({ capability: `s_${i}` })), { one_click: true });
  assert.deepEqual(calls.map(([command, payload]) => [command, payload.sources?.length]), [["archiver.sources.select", 500], ["archiver.sources.select", 500], ["archiver.sources.select", 203], ["archiver.parse.plan", undefined]]);
  assert.equal(calls[1][1].selection, "selection-test"); assert.equal(calls[3][1].one_click, true); assert.equal(calls[3][1].selection, "selection-test");
});

test("a parse or refresh failure closes progress before waiting for the error dialog", async () => {
  const source = await readFile(path.join(shell, "shell.js"), "utf8"), start = source.indexOf("async function performArchiverParse("), end = source.indexOf("\nfunction showClaudeExtractionConfirmation", start);
  let clear = false;
  const run = new Function("beginRequest", "showParseConfirmation", "currentPage", "showActionError", `let activeParseOperation=null; ${source.slice(start, end)}; return performArchiverParse;`)(
    () => ({ promise: Promise.reject(new Error("test failure")) }), async () => true,
    { clearProgress() { clear = true; } }, async () => { assert.equal(clear, true); });
  assert.equal(await run([{ capability: "test" }]), false);
});

test("a saved conversation beyond the first Reader page reopens by its ID without a loading transition", async () => {
  const source = await readFile(path.join(shell, "shell.js"), "utf8"), start = source.indexOf("async function refreshConversationInfoSource("), end = source.indexOf("\nasync function openIdentityEditor", start);
  const calls: any[] = [], page = {}, row = { archive: "target-id", capability: "fresh-cap" };
  const run = new Function("mountReader", "queryArchives", "openReaderConversation", "currentPage", `${source.slice(start, end)}; return refreshConversationInfoSource;`)(
    async () => ({ total: 402, snapshot: "snapshot-test", items: Array.from({ length: 200 }, (_, i) => ({ archive: `a${i}` })) }),
    async (p: any) => { calls.push(p); return { total: 402, snapshot: "snapshot-test", items: p.offset === 200 ? Array.from({ length: 200 }, (_, i) => ({ archive: `b${i}` })) : [row] }; },
    async (...args: any[]) => calls.push(args), page);
  await run("reader/conversation/target-id", "target-id");
  assert.deepEqual(calls, [{ offset: 200, limit: 200, snapshot: "snapshot-test" }, { offset: 400, limit: 200, snapshot: "snapshot-test" }, [row, false]]);
});

test("Time Cover manual order stays a draft until confirmed, cancels cleanly and survives language changes", async () => environment(async (document, window) => {
  const module = await ui("pages/time-cover/time-cover.js");
  const model = module.visualTimeCoverFixture();
  const writes: any[] = []; let fail = false; let reported = 0; let returned = 0;
  const controller = module.mountTimeCover({ host: document.body, template: document.querySelector("#time-cover-template"), model, state: { language: "zh-CN" }, returnTo: "reader-cover", children: async () => ({ items: [] }), onReturn: () => returned++, onError: () => reported++,
    saveOrder: async (payload: any) => { writes.push(payload); if (fail) throw new Error("changed"); return { revision: model.revision + 1, library_revision: model.library_revision + 1, items: payload.nodes.map((node: string) => model.sovereign.items.find((row: any) => row.node === node)) }; }
  });
  const root: HTMLElement = controller.element;
  const names = () => [...root.querySelectorAll("[data-time-sovereign-list] strong")].map(node => node.textContent);
  const original = names();
  const moved = [original[1], original[0], ...original.slice(2)];
  root.querySelector<HTMLButtonElement>("[data-time-sort]")!.click();
  root.querySelector<HTMLButtonElement>("[data-time-sovereign-list] [data-time-node-action='down']")!.click();
  assert.deepEqual(names(), moved); assert.equal(writes.length, 0);
  root.querySelector<HTMLButtonElement>("[data-time-sort-cancel]")!.click(); assert.deepEqual(names(), original);
  root.querySelector<HTMLButtonElement>("[data-time-sort]")!.click();
  root.querySelectorAll("[data-time-sovereign-list] .time-cover-row-body")[1]!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
  controller.updateState({ language: "en" });
  assert.deepEqual(names(), moved);
  assert.equal(root.querySelector("[data-time-sort-confirm]")!.textContent, "Confirm");
  root.querySelector<HTMLButtonElement>("[data-time-sort-confirm]")!.click(); await settle();
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].nodes, [model.sovereign.items[1], model.sovereign.items[0], ...model.sovereign.items.slice(2)].map((row: any) => row.node));
  assert.equal(root.querySelector<HTMLElement>("[data-time-sort-actions]")!.hidden, true);
  fail = true; root.querySelector<HTMLButtonElement>("[data-time-sort]")!.click();
  root.querySelector<HTMLButtonElement>("[data-time-sort-confirm]")!.click(); await settle();
  assert.equal(reported, 1); assert.equal(root.querySelector<HTMLElement>("[data-time-sort-actions]")!.hidden, false);
  root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(returned, 0); assert.equal(root.querySelector<HTMLElement>("[data-time-sort-actions]")!.hidden, true);
  controller.cleanup();
}));

test("Theme round trips use the latest real Library revision after another write and persist across reload", async () => {
  const { commitPreferencePatch } = await ui("preferences.js");
  const temporary = path.join(process.cwd(), "tmp"); await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "theme-roundtrip-"));
  const libraryRoot = path.join(base, "Library");
  try {
    await createLocalLibrary({ root: libraryRoot, transaction: "x_THEMEROUNDTRIPCREATE", timestamp: "2026-09-06T10:00:00.000Z", localDate: "2026-09-06", offset: "Z", language: "zh-CN" });
    const handlers = new LibraryEngineCommands(libraryRoot).handlers();
    const context = { request: "q_theme_roundtrip", signal: new AbortController().signal, emit: async () => {} };
    const request = async (command: string, payload: JsonObject = {}): Promise<JsonObject> => {
      const handler = handlers[command]; assert.ok(handler); return await handler(payload, context) as JsonObject;
    };
    const night = await commitPreferencePatch(request, { theme: "star-night" });
    await request("library.preferences.commit", { expected_revision: night.revision, parse_ordinary: { parse_unparsed: true, parse_selected: true, update_outdated: true, preserve_previous: true } });
    await assert.rejects(request("library.preferences.commit", { expected_revision: night.revision, theme: "dawn" }), { code: "CLOUDIG_LIBRARY_REVISION_CONFLICT" }, "The old UI path silently failed at precisely this boundary");
    const dawn = await commitPreferencePatch(request, { theme: "dawn" });
    assert.equal(dawn.theme, "dawn"); assert.equal(dawn.theme_switched, true);
    for (const theme of ["star-night", "dawn", "star-night", "dawn"]) {
      await commitPreferencePatch(request, { theme });
      const saved = await readWelcomeLibraryState(libraryRoot);
      assert.equal(saved.theme, theme); assert.equal(saved.themeSwitched, true);
      assert.equal(saved.ordinaryParse.preserve_previous, true, "Theme changes must preserve unrelated preferences");
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("Preference patches retry only one revision conflict and surface persistent or unrelated failures", async () => {
  const { commitPreferencePatch } = await ui("preferences.js");
  const revisions: number[] = []; let commits = 0;
  const result = await commitPreferencePatch(async (command: string, payload: any) => {
    if (command.endsWith("query")) return { revision: 10 + commits };
    revisions.push(payload.expected_revision); commits++;
    if (commits === 1) throw Object.assign(new Error("changed"), { code: "CLOUDIG_LIBRARY_REVISION_CONFLICT" });
    return { theme: payload.theme, revision: 12 };
  }, { theme: "dawn" });
  assert.equal(result.theme, "dawn"); assert.deepEqual(revisions, [10, 11]);
  commits = 0;
  await assert.rejects(commitPreferencePatch(async (command: string) => {
    if (command.endsWith("query")) return { revision: 20 };
    commits++; throw Object.assign(new Error("still changed"), { code: "CLOUDIG_LIBRARY_REVISION_CONFLICT" });
  }, { theme: "dawn" }), /still changed/u);
  assert.equal(commits, 2);
  await assert.rejects(commitPreferencePatch(async () => { throw new Error("disk unavailable"); }, { theme: "dawn" }), /disk unavailable/u);
});

test("starting an Archiver import closes its initial workflow before dispatch, while settings remain an overlay", async () => environment(async (document) => {
  const module = await ui("pages/archiver/archiver.js");
  for (const action of ["import-html", "import-claude"]) {
    const model = module.visualArchiverFixture(true);
    model.sources.total = 0; model.sources.items = []; model.archives.total = 0; model.archives.catalog_total = 0; model.archives.items = [];
    let called = false;
    const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model, state: { language: "zh-CN", theme: "dawn" },
      onShellAction: (value: string) => { assert.equal(value, action); assert.equal(root.dataset["workflowOpen"], "false"); called = true; } });
    const root: HTMLElement = controller.element; document.body.append(root);
    assert.equal(root.dataset["workflowOpen"], "true");
    root.querySelector<HTMLButtonElement>("[data-archiver-parse-settings]")!.click();
    assert.equal(root.dataset["workflowOpen"], "true", "merely configuring options must not dismiss the instructions");
    root.querySelector<HTMLButtonElement>("[data-parse-settings-cancel]")!.click();
    root.querySelector<HTMLButtonElement>(`[data-archiver-shell-action='${action}']`)!.click();
    assert.equal(called, true);
    assert.equal(root.querySelector<HTMLElement>("[data-archiver-workflow]")!.hidden, true);
    controller.updateState({ language: "zh-CN", theme: "star-night" });
    assert.equal(root.dataset["workflowOpen"], "false");
    root.querySelector<HTMLButtonElement>("[data-archiver-workflow-open]")!.click();
    assert.equal(root.dataset["workflowOpen"], "true", "the user can deliberately reopen the instructions");
    controller.cleanup(); root.remove();
  }
}));

test("Archiver shows capture time or localized unknown, keeps raw mtime separate and requests capture sorting", async () => environment(async (document) => {
  const module = await ui("pages/archiver/archiver.js"), claude = await ui("pages/archiver/claude-container.js");
  for (const language of ["zh-CN", "en"]) for (const theme of ["dawn", "star-night"]) {
    const model = module.visualArchiverFixture(); model.sources.items = model.sources.items.slice(0, 2);
    model.sources.items[0].captured_at = "2026-09-23T12:00:00Z"; model.sources.items[1].captured_at = null;
    const queries: any[] = [];
    const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model, state: { language, theme }, querySources: async (p: any) => { queries.push(p); return model.sources; } });
    const root: HTMLElement = controller.element; document.body.append(root);
    const dates = [...root.querySelectorAll<HTMLElement>("[data-source-list] span[title]")].filter(node => node.title.startsWith(language === "en" ? "Original file modified:" : "原文件修改时间："));
    assert.equal(dates.length, 2); assert.match(dates[0]!.textContent!, /2026-09-23/); assert.equal(dates[1]!.textContent, language === "en" ? "Unknown" : "未知");
    root.querySelector<HTMLButtonElement>("[data-source-sort]")!.click(); await settle(); assert.equal(queries.at(-1).sort, "captured_asc");
    controller.cleanup(); root.remove();
    const host = document.querySelector<HTMLTemplateElement>("#archiver-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement; document.body.append(host);
    const index = claude.visualClaudeContainerFixture(); index.source.captured_at = null;
    const view = claude.mountClaudeContainer({ root: host, index, state: { language, theme }, query: async () => index }); await settle();
    assert.equal(host.querySelector("[data-claude-source-captured]")!.textContent, language === "en" ? "Unknown" : "未知");
    view.cleanup(); host.remove();
  }
}));

test("Archiver parse settings open and cancel in their own layer without replacing the workspace or scenery", async () => environment(async (document) => {
  const module = await ui("pages/archiver/archiver.js");
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model: module.visualArchiverFixture(), state: { language: "zh-CN", theme: "dawn" } });
  const root: HTMLElement = controller.element; document.body.append(root);
  const popup = root.querySelector<HTMLElement>("[data-archiver-parse-settings-popover]")!;
  const scene = root.querySelector(".archiver-center-scenes")!;
  const sceneMarkup = scene.outerHTML;
  const list = root.querySelector("[data-source-list]");
  assert.equal(popup.hidden, true);
  root.querySelector<HTMLButtonElement>("[data-archiver-parse-settings]")!.click();
  assert.equal(popup.hidden, false);
  assert.equal(popup.parentElement, root.querySelector(".archiver-center"));
  assert.equal(root.querySelector(".archiver-center-scenes"), scene);
  assert.equal(scene.outerHTML, sceneMarkup);
  assert.equal(root.querySelector("[data-source-list]"), list);
  popup.querySelector<HTMLButtonElement>("[data-parse-settings-cancel]")!.click();
  assert.equal(popup.hidden, true);
  assert.equal(scene.outerHTML, sceneMarkup);
  controller.cleanup();
}));

test("Archiver theme and background clicks never become time-field actions; only the light-cone opens its anchored bubble", async () => environment(async (document, window) => {
  const module = await ui("pages/archiver/archiver.js");
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model: module.visualArchiverFixture(), state: { language: "zh-CN", theme: "dawn" } });
  const root: HTMLElement = controller.element; document.body.append(root);
  const click = (selector: string) => root.querySelector(selector)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  click("[data-action='toggle-theme'] img");
  assert.equal(root.querySelector(".archiver-filter-popover"), null, "theme click must not open a time menu on the page root");
  controller.updateState({ language: "zh-CN", theme: "star-night" });
  click(".archiver-workspace-header");
  assert.equal(root.querySelector(".archiver-filter-popover"), null, "background clicks are not time-field actions");
  assert.equal(root.matches("[data-archive-time-field]"), false, "page state and button action use different markers");
  const anchor = root.querySelector<HTMLElement>("button[data-archive-time-field]")!;
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() {} });
  root.getBoundingClientRect = () => rect(0, 0, 1920, 1080);
  anchor.getBoundingClientRect = () => rect(1120, 200, 28, 28);
  (anchor.closest(".archiver-workspace") as HTMLElement).getBoundingClientRect = () => rect(1036, 48, 636, 1032);
  click("button[data-archive-time-field] img");
  const popup = root.querySelector<HTMLElement>(".archiver-filter-popover")!;
  assert.ok(popup);
  assert.equal(popup.style.top, "234px");
  assert.equal(popup.style.left, "1120px");
  assert.equal(popup.querySelectorAll("input[type='radio']").length, 8);
  popup.querySelector<HTMLButtonElement>("footer button")!.click();
  assert.equal(root.querySelector(".archiver-filter-popover"), null);
  controller.cleanup();
}));

test("Bookmark install, install-all and copy clicks reach their native callbacks and recover after failure", async () => environment(async (document) => {
  const module = await ui("pages/archiver/archiver.js");
  const fixture = module.visualArchiverFixture();
  const calls: any[] = []; let failures = 0;
  fixture.bookmarks.browser_state = "open"; // stale query, user has since closed Chrome
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model: fixture, state: { language: "zh-CN", theme: "dawn" },
    onBookmarkInstall: async (profile: string, platforms: string[]) => { calls.push([profile, platforms]); return fixture.bookmarks; },
    onBookmarkCopy: async () => { throw new Error("copy failed"); }, onBookmarkError: async () => { failures++; }
  });
  document.body.append(controller.element);
  controller.element.querySelector("[data-bookmark-operation='install']").click();
  await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "light"); assert.equal(calls[0][1].length, 1);
  controller.element.querySelector("[data-bookmark-install-all]").click(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[1][1].length, 12);
  controller.element.querySelector("[data-bookmark-copy]").click(); await settle();
  assert.equal(failures, 1); assert.notEqual(controller.element.dataset.bookmarkBusy, "true");
  assert.equal(controller.element.querySelector("[data-bookmark-install-all]").disabled, false);
  controller.cleanup();
}));

test("Bookmark rail keeps two caption lines and moves installed/latest versions into the status icon tooltip", async () => environment(async (document, window) => {
  const module = await ui("pages/archiver/archiver.js");
  const fixture = module.visualArchiverFixture();
  const controller = module.mountArchiver({ template: document.querySelector("#archiver-template"), model: fixture, state: { language: "zh-CN", theme: "dawn" } });
  const root: HTMLElement = controller.element; document.body.append(root);
  const captions = root.querySelectorAll(".archiver-bookmark-caption");
  assert.equal(captions.length, 12);
  for (const caption of captions) { assert.equal(caption.children.length, 2); assert.equal(caption.querySelectorAll("em").length, 0); }
  const installed = root.querySelector<HTMLButtonElement>(".archiver-bookmark-row[data-platform='chatgpt'] .archiver-bookmark-state")!;
  assert.equal(installed.querySelectorAll("svg circle, svg path").length, 2);
  installed.dispatchEvent(new window.Event("pointerenter"));
  const hint = root.querySelector<HTMLElement>("[data-bookmark-version-help]")!;
  assert.equal(hint.dataset["visible"], "true"); assert.match(hint.textContent!, /ChatGPT-3\.7\.34-Light/u);
  installed.dispatchEvent(new window.Event("pointerleave")); assert.equal(hint.dataset["visible"], undefined);
  const update = root.querySelector<HTMLButtonElement>(".archiver-bookmark-row[data-status='outdated'] .archiver-bookmark-state")!;
  update.focus(); assert.match(hint.textContent!, /已安装：Gemini-1\.2\.0-Light\n最新：Gemini-1\.3\.0-Light/u);
  const light = root.querySelector<HTMLButtonElement>("[data-bookmark-profile='light']")!;
  light.dispatchEvent(new window.Event("pointerenter"));
  const description = root.querySelector<HTMLElement>("[data-archiver-profile-help]")!;
  assert.equal(description.dataset["visible"], "true"); assert.match(description.textContent!, /不保存隐藏分支/u);
  assert.equal(light.hasAttribute("title"), false, "the arrow bubble must not compete with a second native title tooltip");
  assert.equal(root.querySelectorAll(".archiver-profile-options [data-bookmark-profile]").length, 3);
  controller.cleanup();
}));

test("Reader consumes page 51 and distinguishes no platform selection from all platforms", async () => environment(async (document, _window) => {
  const module = await ui("pages/reader/reader-cover.js");
  const all = Array.from({ length: 51 }, (_, i) => ({ capability: `a_${i + 1}`, title: `Archive ${i + 1}`, platform: "chatgpt", messages: 1 }));
  const initial = { items: all.slice(0, 50), total: 51, catalog_total: 51, directories: [] };
  const opened: string[] = [], offsets: number[] = [];
  const controller = module.mountReaderCover({ template: document.querySelector("#reader-cover-template"), model: initial,
    state: { theme: "dawn", language: "zh-CN", userName: "User", assistantName: "AI" }, onOpen: (row: { capability: string }) => opened.push(row.capability),
    queryArchives: async (query: { offset: number; limit: number; platforms?: string[] }) => {
      offsets.push(query.offset); const selected = query.platforms === undefined ? all : all.filter(row => query.platforms!.includes(row.platform));
      return { ...initial, total: selected.length, items: selected.slice(query.offset, query.offset + query.limit) };
    }
  });
  document.body.append(controller.element);
  await controller.refreshAll();
  controller.element.querySelectorAll(".reader-row-open")[49].click();
  controller.element.querySelector("[data-reader-next]").click(); await settle();
  assert.deepEqual(opened, ["a_50", "a_51"]); assert.deepEqual(offsets, [0, 50]);
  for (const button of controller.element.querySelectorAll(".reader-platform-button")) button.click();
  await settle(); assert.equal(controller.element.querySelectorAll(".reader-row-open").length, 0);
  controller.cleanup();
}));

test("Reader searches beyond message 200, navigates beyond 500 and switches siblings at a paged message", async () => environment(async (document, window, expose) => {
  const module = await ui("pages/reader/reader-conversation.js");
  const all = Array.from({ length: 503 }, (_, i) => ({ anchor: `message-${i + 1}`, text: i === 502 ? "needle at the end" : `message ${i + 1}` }));
  const nav = all.map((item, i) => ({ ...item, kind: "assistant", source_index: i }));
  const leaves = Array.from({ length: 201 }, (_, i) => ({ id: `b${i + 1}`, text: `Branch ${i + 1}` }));
  const page = (session: { selected_leaf?: string; branch_choices?: Record<string, string> } = {}, offsets: Record<string, number> = {}) => {
    const slice = (items: unknown[], key: string, limit: number) => { const offset = offsets[key] ?? 0, result = items.slice(offset, offset + limit); return { offset, returned: result.length, total: items.length, has_next: offset + result.length < items.length, items: result }; };
    const messages = slice(all, "messages", 200);
    messages.items = (messages.items as any[]).map(message => message.anchor === "message-250" ? { ...message, branch_controls: [{ parent: "m249", index: session.branch_choices?.["m249"] === "m251" ? 1 : 0, total: 2, ...(session.branch_choices?.["m249"] === "m251" ? { previous: "m250" } : { next: "m251" }) }] } : message);
    return { header: { title: "Long conversation" }, messages: messages.items, pagination: { ...messages, total_visible: 503, total_canonical: 503 }, navigation: slice(nav, "navigation", 500), branch: { tree: true, selected: session.selected_leaf ?? "b201", leaves: slice(leaves, "branches", 200) } };
  };
  const root = document.querySelector<HTMLTemplateElement>("#reader-cover-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement;
  document.body.append(root);
  const append = (host: HTMLElement, view: { messages: { anchor: string; text: string }[] }) => { for (const item of view.messages) {
    const node = document.createElement("article"); node.className = "cloudig-message"; node.id = item.anchor;
    const header = document.createElement("header"); header.className = "cloudig-message-header";
    const body = document.createElement("div"); body.className = "cloudig-message-content"; body.textContent = item.text;
    node.append(header, body); host.append(node);
  } };
  expose("CloudigConversationRenderer", { createConversationRenderer: ({ root: host }: { root: HTMLElement }) => ({ render(view: any) { host.replaceChildren(); append(host, view); }, append(view: any) { append(host, view); }, destroy() { host.replaceChildren(); }, setTheme() {} }) });
  let selected: string | undefined;
  const controller = module.mountReaderConversation({ page: root, template: document.querySelector("#reader-conversation-template"), row: {}, view: page(), state: { language: "zh-CN", theme: "dawn" }, translate: (key: string) => key,
    requestPage: async (session: { selected_leaf?: string; branch_choices?: Record<string, string> }, offsets: Record<string, number>) => page(session, offsets), onSessionChange: (session: { branch_choices?: Record<string, string> }) => { selected = session.branch_choices?.["m249"]; }, onError: (error: unknown) => { throw error; } });
  const input = root.querySelector<HTMLInputElement>("[data-reader-current-search-input]")!; input.value = "needle";
  root.querySelector("[data-reader-current-search]")!.dispatchEvent(new window.Event("submit", { cancelable: true })); await settle();
  assert.equal(root.querySelectorAll(".cloudig-message").length, 503);
  assert.equal(root.querySelector("[data-reader-search-count]")!.textContent, "1/1");
  root.querySelector<HTMLButtonElement>("[data-reader-navigation-jump='last']")!.click(); await settle();
  assert.equal(root.querySelectorAll(".reader-navigation-item").length, 503);
  assert.equal(root.querySelector(".reader-branch-picker"), null);
  const branch = root.querySelector<HTMLButtonElement>("#message-250 [data-branch-child='m251']")!;
  assert.equal(branch.closest(".reader-message-branches")!.parentElement, root.querySelector("#message-250"), "branch controls own a separate message grid row, not the display-contents header");
  assert.equal(branch.title, "下一分支"); branch.click(); await settle();
  assert.equal(selected, "m251");
  assert.match(root.querySelector("#message-250 [data-branch-parent='m249']")!.textContent!, /2 \/ 2/u);
  assert.ok(root.querySelector("#message-250 [data-branch-child='m250']")); controller.cleanup();
}));

test("Claude entire rows toggle themed pins and one-click uses the configured union across title filtering", async () => environment(async (document, window) => {
  const module = await ui("pages/archiver/claude-container.js");
  const root = document.querySelector<HTMLTemplateElement>("#archiver-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement;
  document.body.append(root);
  const fixture = module.visualClaudeContainerFixture();
  const rows = fixture.items.slice(0, 7);
  rows[0].title = "match"; rows[5].title = "match parsed";
  const extracted: any[] = [];
  const controller = module.mountClaudeContainer({ root, index: fixture, state: { language: "zh-CN" },
    query: async (query: any) => {
      const filtered = rows.filter((row: any) => (!query.statuses || query.statuses.includes(row.status)) && (!query.search || row.title.includes(query.search)));
      return { ...fixture, total: rows.length, visible: filtered.length, items: filtered.slice(query.offset, query.offset + query.limit) };
    }, savePreferences: async (parse: any) => ({ parse }), extract: async (...args: any[]) => extracted.push(args), onError: (error: unknown) => { throw error; } });
  await settle();
  const input = root.querySelector<HTMLInputElement>("[data-claude-search]")!;
  input.value = "match"; input.dispatchEvent(new window.Event("change")); await settle();
  const parsed = root.querySelectorAll<HTMLElement>("[data-claude-row]")[1]!; parsed.querySelector<HTMLElement>(".archiver-claude-row-title")!.click();
  assert.equal(root.querySelectorAll(".archiver-claude-select[aria-pressed='true']").length, 1);
  assert.deepEqual([...root.querySelectorAll(".archiver-claude-select[aria-pressed='true'] img")].map(image => image.getAttribute("src")), ["/assets/reader/Pushpin-Red.svg", "/assets/reader/Pushpin-Purple.svg"]);
  root.querySelector<HTMLButtonElement>("[data-claude-one-click]")!.click(); await settle();
  assert.deepEqual(new Set(extracted[0][0].map((row: any) => row.selector)), new Set([...rows.filter((row: any) => row.status === "ready"), rows[5]].map((row: any) => row.selector)));
  root.querySelector<HTMLButtonElement>("[data-claude-settings]")!.click();
  root.querySelector<HTMLInputElement>("[data-claude-setting='parse_unparsed']")!.checked = false;
  root.querySelector<HTMLInputElement>("[data-claude-setting='preserve_previous']")!.checked = true;
  root.querySelector<HTMLButtonElement>("[data-claude-settings-save]")!.click(); await settle();
  root.querySelector<HTMLButtonElement>("[data-claude-one-click]")!.click(); await settle();
  assert.deepEqual(extracted[1][0].map((row: any) => row.selector), [rows[5].selector]);
  assert.equal(extracted[1][2].preserve_previous, true);
  const reparse = root.querySelector<HTMLButtonElement>("[data-claude-extract][data-status=parsed]")!;
  assert.equal(reparse.disabled, false); assert.equal(reparse.title, "重新解析"); reparse.click(); await settle();
  assert.deepEqual(extracted[2][0].map((row: any) => row.selector), [rows[5].selector]);
  controller.cleanup();
}));

test("platform JSON status counts and filters keep Parser updates separate from complete and pending records", async () => environment(async document => {
  const module = await ui('pages/archiver/claude-container.js');
  for (const language of ['zh-CN', 'en']) for (const platform of ['claude', 'deepseek']) {
    const root = document.querySelector<HTMLTemplateElement>('#archiver-template')!.content.firstElementChild!.cloneNode(true) as HTMLElement; document.body.append(root);
    const fixture = module.visualClaudeContainerFixture();
    const rows = fixture.items.slice(0, 4).map((r: any, i: number) => ({ ...r, status: ['ready', 'parsed', 'update', 'failed'][i] }));
    const query = async (q: any) => {
      const filtered = rows.filter((r: any) => !q.statuses || q.statuses.includes(r.status));
      return { ...fixture, total: rows.length, visible: filtered.length, items: filtered, statuses: Object.fromEntries(['ready', 'parsed', 'update', 'failed'].map(s => [s, rows.filter((r: any) => r.status === s).length])) };
    };
    const controller = module.mountClaudeContainer({ root, index: fixture, state: { language, theme: 'dawn' }, query, presentation: platform === 'claude' ? undefined : { id: platform, name: 'DeepSeek', icon: 'platform-deepseek.svg' } });
    await settle();
    const button = (value: string) => root.querySelector<HTMLButtonElement>(`[data-claude-status="${value}"]`)!;
    assert.equal(button('update').textContent, language === 'en' ? 'Parser update 1' : '解析器更新 1');
    assert.equal(button('parsed').textContent, language === 'en' ? 'Complete 1' : '已完成 1');
    for (const value of ['update', 'parsed', 'ready']) {
      button(value).click(); await settle();
      assert.deepEqual([...root.querySelectorAll<HTMLElement>('[data-claude-row]')].map(r => r.dataset['status']), [value]);
      assert.equal(button(value).getAttribute('aria-pressed'), 'true');
    }
    button('update').click(); await settle(); rows[2].status = 'parsed'; await controller.refresh();
    assert.equal(button('update').textContent, language === 'en' ? 'Parser update 0' : '解析器更新 0');
    assert.equal(root.querySelectorAll('[data-claude-row]').length, 0);
    button('parsed').click(); await settle(); assert.equal(root.querySelectorAll('[data-claude-row]').length, 2);
    controller.cleanup(); root.remove();
  }
}));

test("Claude whole-list selection retains its container on snapshot pages and later scrolling still paints selected rows", async () => environment(async (document, window) => {
  const module = await ui("pages/archiver/claude-container.js"), root = (document.querySelector("#archiver-template") as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement;
  document.body.append(root); const fixture = module.visualClaudeContainerFixture(), requests: any[] = [];
  const rows = Array.from({ length: 405 }, (_, i) => ({ ...fixture.items[0], selector: `r${i}`, title: `Record ${i}`, status: "ready" }));
  const controller = module.mountClaudeContainer({ root, index: fixture, state: { language: "zh-CN" }, query: async (p: any) => {
    requests.push(p); assert.equal(p.container, fixture.container);
    if (p.snapshot) assert.deepEqual(Object.keys(p).sort(), ["container", "limit", "offset", "snapshot"]);
    return { ...fixture, snapshot: "claude-snapshot", total: rows.length, visible: rows.length, items: rows.slice(p.offset, p.offset + p.limit) };
  }, onError: (e: unknown) => { throw e; } });
  await settle(); root.querySelector<HTMLButtonElement>("[data-claude-select-all]")!.click(); await settle();
  assert.equal(root.querySelector("[data-claude-selection]")!.textContent, "已选 405");
  const before = root.querySelectorAll("[data-claude-row]").length;
  root.querySelector<HTMLElement>("[data-claude-records]")!.dispatchEvent(new window.Event("scroll")); await settle();
  assert(root.querySelectorAll("[data-claude-row]").length > before);
  assert(requests.some(p => p.snapshot && p.offset === 400)); controller.cleanup();
}));

test("set content-time summary has only centered start, separator and end lines", async () => environment(async (document) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), state: { language: "zh-CN" }, info: module.visualConversationInfoFixture("zh-CN"), onClose() {}, onError: (error: unknown) => { throw error; } });
  const summary = document.querySelector("[data-conversation-time-display]")!;
  assert.doesNotMatch(summary.textContent!, /用户设定内容时间/u);
  assert.deepEqual([...summary.querySelectorAll("strong > span")].map(node => node.textContent).slice(1, 2), ["—"]);
  controller.cleanup();
}));

test("Time bank ignores an earlier response and an in-flight response after returning to the top", async () => environment(async (document) => {
  const module = await ui("pages/time-cover/time-cover.js");
  const pending: ((value: unknown) => void)[] = [];
  const controller = module.mountTimeCover({ host: document.body, template: document.querySelector("#time-cover-template"), state: { language: "zh-CN" }, model: module.visualTimeCoverFixture(false),
    children: () => new Promise(resolve => pending.push(resolve)), onError: (error: unknown) => { throw error; } });
  const list = controller.element.querySelector("[data-time-sovereign-list]");
  const buttons = list.querySelectorAll(".time-cover-row-body"); buttons[0].click(); buttons[1].click();
  pending[1]!({ items: [{ node: "new", name: "NEW", kind: "single" }] }); await settle();
  pending[0]!({ items: [{ node: "old", name: "OLD", kind: "single" }] }); await settle();
  assert.match(list.textContent, /NEW/u); assert.doesNotMatch(list.textContent, /OLD/u);
  list.querySelector(".time-cover-row-body").click(); controller.element.querySelector("[data-time-bank-top='sovereign']").click();
  pending[2]!({ items: [{ node: "late", name: "LATE", kind: "single" }] }); await settle();
  assert.doesNotMatch(list.textContent, /LATE/u); controller.cleanup();
}));

test("Conversation preset shortcuts select a node snapshot instead of copying the preset's concrete range", async () => environment(async (document) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), state: { language: "zh-CN" }, info: module.visualConversationInfoFixture("zh-CN"),
    terranPresets: [{ node: "preset_current", name: "现代社会", range: { start: { kind: "calendar", era: "AD", year: 777 } } }], previewSovereign: async (node: string) => { assert.equal(node, "preset_current"); return { endpoint: { kind: "sovereign", selection: "te_preset", display: { target: { kind: "single", name: "现代社会" }, sort: { start: { kind: "calendar", era: "AD", year: 777 } } } } }; }, onClose() {}, onError: (error: unknown) => { throw error; } });
  document.querySelector<HTMLButtonElement>("[data-conversation-presets] button")!.click();
  await settle(); assert(![...document.querySelectorAll("input")].some(input => input.value === "777"));
  assert.match(document.querySelector("[data-conversation-time-summary]")?.textContent ?? document.body.textContent!, /现代社会/);
  assert.equal(document.querySelectorAll("[data-conversation-presets] button").length, 1);
  controller.cleanup();
}));

test("Terran mapping shows both endpoints, flat fuzzy choices and confirm-before-save without losing the other endpoint", async () => environment(async (document, window) => {
  const module = await ui("../shared/time/endpoint-editor.js");
  const host = document.createElement("div"); document.body.append(host);
  const saved: any[] = [];
  const controller = module.mountEndpointEditor({ host, language: "zh-CN", anchor: { date: "2026-09-05", offset: "Z" },
    previewRange: async (range: any) => ({ range, direction: "forward" }), onConfirm: (range: any) => saved.push(range) });
  const side = (name: string) => host.querySelector<HTMLElement>(`[data-endpoint-side-section='${name}']`)!;
  const input = (name: string, field: string, value: string) => { const node = side(name).querySelector<HTMLInputElement>(`[data-endpoint-field='${field}']`)!; node.value = value; node.dispatchEvent(new window.Event("input", { bubbles: true })); };
  input("start", "year", "2020"); input("start", "month", "1"); input("start", "day", "2");
  assert.equal(side("end").querySelector("[data-endpoint-option='special'][data-value='same']")!.getAttribute("aria-pressed"), "true");
  side("end").querySelector<HTMLInputElement>("[data-endpoint-kind='fuzzy']")!.click();
  assert.equal(side("end").querySelectorAll("[data-endpoint-option='precision']").length, 4);
  assert.equal(side("start").querySelector<HTMLInputElement>("[data-endpoint-field='year']")!.value, "2020");
  side("end").querySelector<HTMLButtonElement>("[data-endpoint-option='precision'][data-value='month']")!.click();
  input("end", "year", "2024"); input("end", "month", "6");
  host.querySelector<HTMLButtonElement>("[data-endpoint-confirm]")!.click(); await settle();
  assert.equal(saved.length, 0);
  host.querySelector<HTMLButtonElement>("[data-endpoint-save]")!.click(); await settle();
  assert.deepEqual(saved[0], { start: { kind: "calendar", era: "AD", year: 2020, month: 1, day: 2 }, end: { kind: "calendar", era: "AD", year: 2024, month: 6 } });
  input("start", "year", "2021");
  assert.equal(host.querySelector<HTMLButtonElement>("[data-endpoint-save]")!.disabled, true);
  side("start").querySelector<HTMLInputElement>("[data-endpoint-kind='relative']")!.click();
  assert.equal(side("start").querySelectorAll("[data-endpoint-option='unit']").length, 2);
  side("start").querySelector<HTMLButtonElement>("[data-endpoint-option='direction'][data-value='after']")!.click();
  assert.equal(side("start").querySelectorAll("[data-endpoint-option='unit']").length, 10);
  assert.equal(module.formatTimeEndpoint({ kind: "relative", direction: "after", value: "1", unit: "zheng" }, "zh-CN"), "1正年后");
  controller.cleanup();
}));

test("Unchanged Terran mapping confirmation and locale redraw preserve stored time anchors", async () => environment(async (document, window) => {
  const module = await ui("../shared/time/endpoint-editor.js"), host = document.createElement("div"); document.body.append(host);
  const oldAnchor = { date: "2020-01-02", offset: "+08:00" }, currentAnchor = { date: "2026-09-21", offset: "Z" };
  const initialRange = { start: { kind: "relative", direction: "before", unit: "wan", value: "1.5", anchor: oldAnchor }, end: { kind: "now", anchor: oldAnchor } };
  const previews: any[] = [];
  const controller = module.mountEndpointEditor({ host, initialRange, language: "zh-CN", anchor: currentAnchor,
    previewRange: async (range: any) => { previews.push(range); return { range, direction: "forward" }; } });
  controller.updateLanguage("en");
  host.querySelector<HTMLButtonElement>("[data-endpoint-confirm]")!.click(); await settle();
  assert.deepEqual(previews[0], initialRange);
  const input = host.querySelector<HTMLInputElement>("[data-endpoint-field='value']")!; input.value = "2"; input.dispatchEvent(new window.Event("input", { bubbles: true }));
  host.querySelector<HTMLButtonElement>("[data-endpoint-confirm]")!.click(); await settle();
  assert.deepEqual(previews[1].start, { ...initialRange.start, value: "2", anchor: currentAnchor });
  assert.deepEqual(previews[1].end, initialRange.end);
  controller.cleanup();
}));

test("Conversation time fields read old relative and Now anchors without refreshing them", async () => environment(async (document, window) => {
  const module = await ui("../shared/time/terran-point-fields.js"), host = document.createElement("div"); document.body.append(host);
  const oldAnchor = { date: "2020-01-02", offset: "+08:00" }, currentAnchor = { date: "2026-09-21", offset: "Z" };
  for (const endpoint of [{ kind: "relative", direction: "before", unit: "yi", value: "100", anchor: oldAnchor }, { kind: "now", anchor: oldAnchor }]) {
    const editor = module.mountTerranPointFields({ host, endpoint, anchor: currentAnchor, language: "zh-CN" });
    assert.deepEqual(editor.read(), endpoint);
    const snapshot = editor.snapshot(); editor.cleanup();
    const reopened = module.mountTerranPointFields({ host, endpoint, anchor: currentAnchor, language: "en" }); reopened.restore(snapshot);
    assert.deepEqual(reopened.read(), endpoint);
    if (endpoint.kind === "relative") {
      const input = host.querySelector<HTMLInputElement>("[data-point-band='historical'] [data-endpoint-field='value']")!; input.value = "99"; input.dispatchEvent(new window.Event("input", { bubbles: true }));
      assert.deepEqual(reopened.read(), { ...endpoint, value: "99", anchor: currentAnchor });
    }
    reopened.cleanup();
  }
}));

test("An older endpoint preview cannot confirm fields edited while it was running", async () => environment(async (document, window) => {
  const module = await ui("../shared/time/endpoint-editor.js");
  const host = document.createElement("div"); document.body.append(host);
  let resolve!: (value: any) => void;
  const initialRange = { start: { kind: "calendar", era: "AD", year: 2020, month: 1, day: 1 } };
  const controller = module.mountEndpointEditor({ host, initialRange, language: "zh-CN", anchor: { date: "2026-09-05", offset: "Z" }, previewRange: () => new Promise(done => { resolve = done; }) });
  host.querySelector<HTMLButtonElement>("[data-endpoint-confirm]")!.click();
  const year = host.querySelector<HTMLInputElement>("[data-endpoint-field='year']")!; year.value = "2024"; year.dispatchEvent(new window.Event("input", { bubbles: true }));
  resolve({ range: initialRange, direction: "forward" }); await settle();
  assert.equal(host.querySelector<HTMLButtonElement>("[data-endpoint-save]")!.disabled, true);
  assert.doesNotMatch(host.querySelector("[data-endpoint-preview]")!.textContent!, /2020/u);
  controller.cleanup();
}));

test("Conversation Terran fields expose all three era bands and share canonical calendar semantics", async () => environment(async (document, window) => {
  const module = await ui("../shared/time/terran-point-fields.js");
  const host = document.createElement("div"); document.body.append(host);
  const picker = module.mountTerranPointFields({ host, language: "zh-CN", anchor: { date: "2026-09-06", offset: "Z" }, endpoint: { kind: "calendar", era: "AD" } });
  const band = (id: string) => host.querySelector(`[data-point-band='${id}']`)!;
  assert.equal(host.querySelectorAll("[data-point-band]").length, 3);
  assert.equal(band("future").querySelectorAll("[data-endpoint-option='unit']").length, 10);
  assert.equal(band("future").querySelectorAll("[data-endpoint-option='unit'][aria-pressed='true']").length, 0, "Inactive future band must not look selected");
  assert.equal(band("ancient").querySelectorAll("[data-point-special]").length, 4);
  assert.equal(band("historical").querySelectorAll(".cloudig-endpoint-input-frame").length, 1);
  assert.equal("year" in picker.read(), false, "Empty year must not become year zero");
  assert.throws(() => picker.read(true), /年份/u, "Confirmation explains a missing year while draft reads remain possible");
  band("historical").querySelector<HTMLInputElement>("[data-point-mode][value='fuzzy']")!.click();
  assert.equal(band("historical").querySelectorAll("[data-endpoint-option='precision']").length, 4);
  assert.throws(() => picker.read(), /请先选择模糊公历/u);
  band("historical").querySelector<HTMLButtonElement>("[data-endpoint-option='precision'][data-value='decade']")!.click();
  const year = band("historical").querySelector<HTMLInputElement>("[data-endpoint-field='year']")!; year.value = "194"; year.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(picker.read(), { kind: "decade", era: "AD", index: 194 }, "1940s is index 194, not 1940");
  band("historical").querySelector<HTMLInputElement>("[data-point-mode][value='relative']")!.click();
  assert.equal(band("historical").querySelectorAll("[data-endpoint-option='unit']").length, 2);
  band("future").querySelector<HTMLButtonElement>("[data-endpoint-option='unit'][data-value='zheng']")!.click();
  const futureValue = band("future").querySelector<HTMLInputElement>("[data-endpoint-field='value']")!; futureValue.value = "1"; futureValue.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(picker.read(), { kind: "relative", direction: "after", unit: "zheng", value: "1", anchor: { date: "2026-09-06", offset: "Z" } });
  band("ancient").querySelector<HTMLButtonElement>("[data-point-special='whenever']")!.click();
  assert.deepEqual(picker.read(), { kind: "whenever" });
  picker.cleanup();
}));

test("Conversation locale redraw preserves incomplete fuzzy input and requires explicit time confirmation", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  let saved = 0;
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info: module.visualConversationInfoFixture(), state: { language: "zh-CN" }, commit: async () => { saved++; } });
  const root: HTMLElement = controller.element;
  root.querySelector<HTMLInputElement>("[data-point-band='historical'] [data-point-mode][value='fuzzy']")!.click();
  controller.updateLanguage("en");
  assert.equal(root.querySelectorAll("[data-point-band='historical'] [data-endpoint-option='precision']").length, 4);
  root.querySelector<HTMLButtonElement>("[data-endpoint-option='precision'][data-value='decade']")!.click();
  const year = root.querySelector<HTMLInputElement>("[data-point-band='historical'] [data-endpoint-field='year']")!;
  year.value = "19"; year.dispatchEvent(new window.Event("input", { bubbles: true }));
  controller.updateLanguage("zh-CN");
  assert.equal(root.querySelector<HTMLInputElement>("[data-point-band='historical'] [data-endpoint-field='year']")!.value, "19");
  root.querySelector("[data-conversation-info-dialog]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.equal(saved, 0); assert.equal(root.querySelector<HTMLElement>("[data-conversation-time-warning]")!.hidden, false);
  controller.cleanup();
}));

test("Conversation endpoint strip follows the design while expanded Now still confirms and saves", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  const info = module.visualConversationInfoFixture();
  let saved: any;
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info, state: { language: "zh-CN" },
    preview: async (draft: any) => ({ draft, changed: true, content_time: { range: draft.content_time.range, direction: "forward" } }),
    commit: async (value: any) => { saved = structuredClone(value); return { status: "updated" }; } });
  const root: HTMLElement = controller.element;
  const strip = root.querySelector<HTMLElement>(".conversation-info-other-endpoint")!;
  assert.equal(root.querySelector("[data-conversation-other-now]"), null);
  assert.equal(strip.dataset["endpoint"], "end");
  root.querySelector<HTMLButtonElement>("[data-conversation-edit-other]")!.click();
  assert.equal(strip.dataset["endpoint"], "start");
  assert.equal(root.querySelector<HTMLButtonElement>("[data-conversation-other-same]")!.hidden, true);
  root.querySelector<HTMLInputElement>("[data-point-mode][value='now']")!.click();
  root.querySelector<HTMLButtonElement>("[data-conversation-time-confirm]")!.click(); await settle();
  root.querySelector<HTMLButtonElement>("[data-conversation-edit-other]")!.click();
  assert.equal(strip.dataset["endpoint"], "end");
  assert.match(root.querySelector<HTMLButtonElement>("[data-conversation-edit-other]")!.title, /现今/u);
  root.querySelector<HTMLFormElement>("[data-conversation-info-dialog]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(saved.draft.content_time.range.end, { kind: "now", anchor: info.anchor });
  assert.deepEqual(saved.draft.content_time.range.start, info.draft.content_time.range.start);
  controller.cleanup();
}));

test("Conversation modal consumes the outside click and restores the background once", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  const background = document.querySelector<HTMLElement>(".route-host")!;
  let closed = 0, bubbled = 0;
  document.querySelector(".app-root")!.addEventListener("click", () => { bubbled++; });
  const controller = module.mountConversationInfo({ host: document.querySelector(".overlay-root"), background, template: document.querySelector("#conversation-info-template"), info: module.visualConversationInfoFixture(), state: { language: "zh-CN" }, onClose: () => { closed++; } });
  assert.equal(background.inert, true);
  controller.element.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(closed, 0, "Do not expose the underlying control before the click completes");
  const click = new window.MouseEvent("click", { bubbles: true, cancelable: true }); controller.element.dispatchEvent(click); await settle();
  assert.equal(click.defaultPrevented, true); assert.equal(closed, 1); assert.equal(bubbled, 0); assert.equal(background.inert, false);
  controller.cleanup(); assert.equal(closed, 1);
}));

test("Conversation modal keeps dirty content on Stay and coalesces repeated close requests", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  const background = document.querySelector<HTMLElement>(".route-host")!;
  let closed = 0, childOpen = true;
  const controller = module.mountConversationInfo({ host: document.querySelector(".overlay-root"), background, canClose: () => !childOpen, template: document.querySelector("#conversation-info-template"), info: module.visualConversationInfoFixture(), state: { language: "zh-CN" }, onClose: () => { closed++; } });
  const layer: HTMLElement = controller.element, name = layer.querySelector<HTMLInputElement>("[data-conversation-name]")!;
  name.value = "Unsaved title"; name.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(await controller.close(), false); assert.equal(closed, 0, "A child Time page must keep its parent editor alive");
  childOpen = false;
  const first = controller.close(); assert.equal(controller.close(), first);
  assert.equal(layer.querySelector<HTMLFormElement>("[data-conversation-info-dialog]")!.inert, true);
  layer.querySelector<HTMLButtonElement>("[data-conversation-confirm-secondary]")!.click(); assert.equal(await first, false);
  assert.equal(name.value, "Unsaved title"); assert.equal(background.inert, true); assert.equal(closed, 0);
  const discard = controller.close(); layer.querySelector<HTMLButtonElement>("[data-conversation-confirm-primary]")!.click(); assert.equal(await discard, true);
  assert.equal(closed, 1); assert.equal(background.inert, false);
}));

test("Flat time pickers continue past 500 nodes and ignore replaced search results", async () => environment(async (document, window) => {
  const { createTimeNodePager } = await ui("../shared/time/paged-nodes.js");
  const host = document.createElement("div"); document.body.append(host);
  Object.defineProperties(host, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
  const abort = new window.AbortController();
  const all = Array.from({ length: 501 }, (_, index) => ({ node: `tn_${index}`, name: `Node ${index}` }));
  let shown: any[] = [], oldResolve!: (value: any) => void;
  const offsets: number[] = [];
  const pager = createTimeNodePager({ host, signal: abort.signal, render: (rows: any[]) => { shown = [...rows]; }, query: async ({ offset, limit, search }: any) => {
    if (search === "old") return new Promise(done => { oldResolve = done; });
    const source = search === "new" ? [all[500]] : all; offsets.push(offset);
    return { items: source.slice(offset, offset + limit), total: source.length };
  } });
  await pager.refresh();
  for (let page = 0; page < 5; page++) { host.scrollTop = 900; host.dispatchEvent(new window.Event("scroll")); await settle(); }
  assert.equal(shown.length, 501); assert.equal(shown.at(-1).node, "tn_500"); assert.deepEqual(offsets, [0, 100, 200, 300, 400, 500]);
  const old = pager.refresh({ search: "old" }); await settle(); await pager.refresh({ search: "new" });
  oldResolve({ items: [all[0]], total: 1 }); await old;
  assert.deepEqual(shown.map(row => row.node), ["tn_500"]);
  abort.abort(); pager.dispose();
}));

test("Conversation Time confirmation rejects a late preview and retains independently edited title", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  let resolve!: (value: any) => void, pending: any;
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info: module.visualConversationInfoFixture(), state: { language: "zh-CN" },
    preview: (draft: any) => { pending = structuredClone(draft); return new Promise(done => { resolve = done; }); } });
  const root: HTMLElement = controller.element;
  const original = root.querySelector("[data-conversation-time-display]")!.textContent;
  root.querySelector<HTMLButtonElement>("[data-conversation-time-confirm]")!.click();
  const year = root.querySelector<HTMLInputElement>("[data-point-band='historical'] [data-endpoint-field='year']")!; year.value = "2050"; year.dispatchEvent(new window.Event("input", { bubbles: true }));
  resolve({ draft: pending, content_time: { range: pending.content_time.range, direction: "forward" } }); await settle();
  assert.equal(root.querySelector("[data-conversation-time-display]")!.textContent, original);
  root.querySelector<HTMLButtonElement>("[data-conversation-time-confirm]")!.click();
  const name = root.querySelector<HTMLInputElement>("[data-conversation-name]")!; name.value = "时间预览过程中编辑的标题"; name.dispatchEvent(new window.Event("input", { bubbles: true }));
  resolve({ draft: pending, content_time: { range: pending.content_time.range, direction: "forward" } }); await settle();
  assert.equal(name.value, "时间预览过程中编辑的标题");
  assert.match(root.querySelector("[data-conversation-time-display]")!.textContent!, /2050/u);
  controller.cleanup();
}));

test("Returning from Time refreshes choices without resetting the open conversation draft", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js");
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info: module.visualConversationInfoFixture(), state: { language: "zh-CN" },
    reloadTime: async () => ({ terran: { items: [{ node: "latest-preset", name: "现代社会", range: { start: { kind: "calendar", era: "AD", year: 2045 } } }] } }) });
  const root: HTMLElement = controller.element;
  const name = root.querySelector<HTMLInputElement>("[data-conversation-name]")!; name.value = "尚未保存的会话名"; name.dispatchEvent(new window.Event("input", { bubbles: true }));
  const year = root.querySelector<HTMLInputElement>("[data-point-band='historical'] [data-endpoint-field='year']")!; year.value = "2077"; year.dispatchEvent(new window.Event("input", { bubbles: true }));
  await controller.refreshTimeContext();
  assert.equal(name.value, "尚未保存的会话名"); assert.equal(year.value, "2077");
  assert.equal(root.querySelector("[data-conversation-presets] button")!.getAttribute("data-preset"), "latest-preset");
  controller.cleanup();
}));

test("Conversation save checks only source and Mark, never an unrelated Library revision", async () => {
  const { commitCurrentConversationInfo } = await ui("pages/conversation-info/conversation-info.js");
  let saved: any;
  const payload = { expected_conversation: "source", expected_mark: null, draft: { conversation_name: { state: "set", value: "unsaved" } } };
  await commitCurrentConversationInfo(async (command: string, value: any) => command.endsWith("query") ? { revision: { conversation: "source", mark: null } } : (saved = value), "a_current", payload);
  assert.equal(saved.expected_conversation, "source"); assert.equal(saved.expected_mark, null); assert.deepEqual(saved.draft, payload.draft); assert(!("expected_library_revision" in saved));
  let committed = false;
  await assert.rejects(commitCurrentConversationInfo(async (command: string) => command.endsWith("query") ? { revision: { conversation: "source", mark: "new" } } : (committed = true), "a_current", payload), { code: "CLOUDIG_ARCHIVE_INFO_CONFLICT" });
  assert.equal(committed, false);
});

test("Conversation form keeps explicit model declarations and honors a no-touch preview without inventing a Mark", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js"), info = module.visualConversationInfoFixture(); let draft: any, committed = false;
  const mounted = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info, state: { language: "zh-CN" },
    preview: async (value: any) => { draft = value; return { changed: false, can_touch: false }; }, commit: async () => { committed = true; } });
  const root: HTMLElement = mounted.element;
  assert.match(root.querySelector("[data-conversation-fact='first_parsed']")!.textContent!, /2026-07-14/);
  assert.match(root.querySelector("[data-conversation-fact='captured_at']")!.textContent!, /2026-07-14/);
  root.querySelector<HTMLButtonElement>("[data-conversation-models] button")!.click();
  const input = root.querySelector<HTMLInputElement>("[data-conversation-model-input]")!; input.value = info.source.models[0]; root.querySelector<HTMLButtonElement>("[data-conversation-model-add]")!.click();
  root.querySelector<HTMLFormElement>("[data-conversation-info-dialog]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(draft.models, { state: "set", values: info.source.models });
  assert.equal(committed, false); assert(!root.isConnected); mounted.cleanup();
}));

test("readonly and editable time labels both use selected periodic occurrences, never a raw node kind or total count", async () => {
  const module = await ui("../shared/time/endpoint-editor.js"), node = { name: "月", kind: "periodic", count: 12, prefix: "第", unit: "月" }, occurrences = { first: 2, step: 2, last: 6 };
  const canonical = { kind: "node", target: { occurrences }, snapshot: { node, timeline: { name: "年" } } }, editor = { kind: "sovereign", selection: "cap", display: { target: node, timeline: { name: "年" }, occurrences } };
  for (const language of ["zh-CN", "en"]) { const expected = module.formatTimeEndpoint(canonical, language); assert.equal(module.formatTimeEndpoint(editor, language), expected); assert.match(expected, /2/); assert.match(expected, /6/); assert.doesNotMatch(expected, /12|node|undefined/); }
});

test("record time labels really bundle for a browser without hashing or Node modules", async () => {
  const result = await build({ entryPoints: [path.resolve("src/core/records/time-labels.mts")], bundle: true, write: false, platform: "browser", format: "esm", target: ["chrome120"], metafile: true });
  assert(result.outputFiles[0]!.contents.length > 0); assert(!Object.keys(result.metafile!.inputs).some(p => /deterministic-json|node:/u.test(p)));
});

test("clearing a conversation title restores the source instead of being blocked by a required input", async () => environment(async (document, window) => {
  const module = await ui("pages/conversation-info/conversation-info.js"); let captured: any;
  const controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info: module.visualConversationInfoFixture(), state: { language: "zh-CN" },
    preview: async (draft: any) => { captured = draft; return { changed: false, can_touch: false }; } });
  const layer: HTMLElement = controller.element, name = layer.querySelector<HTMLInputElement>("[data-conversation-name]")!; assert.equal(name.required, false); name.value = "  "; name.dispatchEvent(new window.Event("input", { bubbles: true }));
  layer.querySelector<HTMLFormElement>("[data-conversation-info-dialog]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(captured.conversation_name, { state: "inherit" }); controller.cleanup();
}));

test("existing Conversation form saves through the real new Reader Engine and reopens only its Mark", async () => environment(async (document, window) => {
  const base = path.resolve("tests/private/schema-rebuild"); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "reader-form-")); let passed = false;
  const builtins = { user: { name: "User", avatar: "app/user.svg" }, assistant: { name: "AI", avatar: "app/ai.svg" }, platforms: {} };
  const times = new TimeEngineCommands({ libraryRoot: root }), engine = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: path.join(root, "cache"), builtins,
    projectTimeRange: range => times.projectDraftRange(range), resolveTimeRange: range => times.resolveDraftRange(range) });
  let controller: any;
  try {
    await createRecordLibrary(root, { timestamp: "2026-09-11T10:00:00Z", anchor: { date: "2026-09-11", offset: "Z" } });
    const conversation = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8"));
    const file = path.join(root, "Conversations/form.json"); await commitRecords(root, [{ action: "write", path: "Conversations/form.json", kind: "conversation", value: conversation, expected: null }]); const before = await readFile(file);
    const request = async (name: string, payload: JsonObject): Promise<any> => engine.handlers()[name]!(payload, { request: "q_form", signal: new AbortController().signal, emit: async () => undefined });
    const archive = (await request("reader.archives.query", { offset: 0, limit: 200 })).items[0].capability, info = await request("reader.archive.info.query", { archive }), module = await ui("pages/conversation-info/conversation-info.js"); let closed = false;
    controller = module.mountConversationInfo({ host: document.body, template: document.querySelector("#conversation-info-template"), info, state: { language: "zh-CN" },
      preview: (draft: JsonObject, language: string) => request("reader.archive.info.preview", { archive, draft, language }), commit: (payload: JsonObject) => module.commitCurrentConversationInfo(request, archive, payload), onClose: () => { closed = true; } });
    const layer: HTMLElement = controller.element, name = layer.querySelector<HTMLInputElement>("[data-conversation-name]")!; name.value = "Real form title"; name.dispatchEvent(new window.Event("input", { bubbles: true }));
    layer.querySelector<HTMLButtonElement>("[data-conversation-models] button")!.click(); layer.querySelector<HTMLFormElement>("[data-conversation-info-dialog]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 200 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert(closed, layer.querySelector("[data-conversation-time-warning]")!.textContent!);
    const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.equal(catalog.marks.length, 1); assert.equal(catalog.marks[0]!.value["conversation_title"], "Real form title"); assert.deepEqual(catalog.marks[0]!.value["models"], []); assert(!("content_time" in catalog.marks[0]!.value));
    assert.deepEqual(await readFile(file), before); const reopened = await request("reader.archive.info.query", { archive }); assert.equal(reopened.effective.conversation_name, "Real form title"); assert.deepEqual(reopened.draft.models, { state: "set", values: [] }); passed = true;
  } finally { controller?.cleanup(); await engine.close(); times.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained Reader form: ${root}`); }
}));

test("existing Identity form saves global Front and this conversation's Mark through the real Engine", async () => environment(async (document, window) => {
  const base = path.resolve("tests/private/schema-rebuild"); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "identity-form-")); let passed = false;
  const builtins = { user: { name: "User", avatar: "app/user.svg" }, assistant: { name: "AI", avatar: "app/ai.svg" }, platforms: {} };
  await createRecordLibrary(root, { timestamp: "2026-09-11T10:00:00Z", anchor: { date: "2026-09-11", offset: "Z" } }); const cache = await createRuntimeCacheSession(path.join(root, "cache"), root);
  const reader = new RecordReaderEngineCommands({ libraryRoot: root, runtimeRoot: cache.root, builtins }), identity = new RecordIdentityEngineCommands({ libraryRoot: root, runtimeRoot: cache.root, builtins, resolveConversation: value => reader.resolveIdentityDraft(value) }); let controller: any;
  try {
    const c = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8")); await commitRecords(root, [{ action: "write", kind: "conversation", path: "Conversations/a.json", value: c, expected: null }]); const original = await readFile(path.join(root, "Conversations/a.json"));
    const handlers = { ...reader.handlers(), ...identity.handlers() }, request = async (name: string, payload: JsonObject): Promise<any> => handlers[name]!(payload, { request: "q_identity_form", signal: new AbortController().signal, emit: async () => undefined });
    const model = await request("identity.query", {}), archive = (await request("reader.archives.query", { offset: 0, limit: 200 })).items[0].capability, conversation = await request("reader.archive.identity.query", { archive }), module = await ui("pages/identity-editor/identity-editor.js"); let closed = false;
    controller = module.mountIdentityEditor({ host: document.body, template: document.querySelector("#identity-editor-template"), state: { language: "zh-CN" }, model, conversation,
      applicationAsset: (s: string) => s, resolveAvatar: async (v: any) => v.asset, discardAvatar: async () => undefined, pickAvatar: async () => null,
      save: ({ globalDraft, conversationNames }: any) => request("identity.commit", { expected_revision: model.revision, draft: globalDraft, conversation: { archive, expected_conversation: conversation.revision.conversation, expected_mark: conversation.revision.mark, names: conversationNames } }), onClose: () => { closed = true; } });
    const layer: HTMLElement = controller.element, global = layer.querySelector<HTMLInputElement>("[data-identity-global-grid] .identity-card-name input")!, user = layer.querySelector<HTMLInputElement>("[data-identity-conversation-user]")!;
    global.value = "All conversations"; user.value = "Only this one"; global.dispatchEvent(new window.Event("input", { bubbles: true }));
    layer.querySelector<HTMLFormElement>("[data-identity-dialog]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 200 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 25)); assert(closed, layer.querySelector("[data-identity-status]")!.textContent!);
    assert.equal((await request("identity.query", {})).global.user.resolved_name, "All conversations");
    const catalog = await withRecordSnapshot(root, () => readRecordCatalog(root)); assert.equal(catalog.marks.length, 1); assert.deepEqual(catalog.marks[0]!.value["names"], { user: "Only this one" }); assert(!catalog.marks[0]!.value["content_time"]); assert.deepEqual(await readFile(path.join(root, "Conversations/a.json")), original); passed = true;
  } finally { await controller?.cleanup(); await identity.close(); await reader.close(); await cache.close(); if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained Identity form: ${root}`); }
}));

test("Identity save locks its draft and cannot report cancellation while the commit is pending", async () => environment(async (document, window) => {
  const module = await ui("pages/identity-editor/identity-editor.js"), closed: any[] = [];
  let resolveSave!: (value: unknown) => void, saveCalls = 0;
  const pending = new Promise(resolve => { resolveSave = resolve; });
  const controller = module.mountIdentityEditor({ host: document.body, template: document.querySelector("#identity-editor-template"), state: { language: "zh-CN" }, model: module.visualIdentityFixture(),
    applicationAsset: (s: string) => s, resolveAvatar: async (v: any) => v.asset, discardAvatar: async () => undefined, pickAvatar: async () => null,
    save: async () => { saveCalls++; return pending; }, onClose: (value: unknown) => closed.push(value) });
  const layer: HTMLElement = controller.element, form = layer.querySelector<HTMLFormElement>("[data-identity-dialog]")!;
  const input = layer.querySelector<HTMLInputElement>(".identity-card-name input")!;
  input.value = "Saving name";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  layer.querySelector<HTMLButtonElement>("[data-identity-cancel]")!.click();
  layer.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
  const during = { closed: closed.length, inputDisabled: input.disabled, cancelDisabled: layer.querySelector<HTMLButtonElement>("[data-identity-cancel]")!.disabled };
  resolveSave({ status: "saved" }); await settle();
  assert.deepEqual(during, { closed: 0, inputDisabled: true, cancelDisabled: true });
  assert.equal(saveCalls, 1); assert.equal(closed.length, 1); assert.equal(closed[0].saved, true);
  assert.equal(layer.isConnected, false);
}));

test("Identity rejects saving during avatar selection and discards a result arriving after close", async () => environment(async (document, window) => {
  const module = await ui("pages/identity-editor/identity-editor.js"), discarded: string[] = [], closed: any[] = [];
  let resolvePick!: (value: unknown) => void, saves = 0;
  const pending = new Promise(resolve => { resolvePick = resolve; });
  const controller = module.mountIdentityEditor({ host: document.body, template: document.querySelector("#identity-editor-template"), state: { language: "en" }, model: module.visualIdentityFixture("en"),
    applicationAsset: (s: string) => s, resolveAvatar: async (v: any) => v.asset, discardAvatar: async (id: string) => { discarded.push(id); }, pickAvatar: () => pending,
    save: async () => { saves++; return {}; }, onClose: (value: unknown) => closed.push(value) });
  const layer: HTMLElement = controller.element;
  layer.querySelector<HTMLButtonElement>(".identity-avatar-actions button")!.click(); await settle();
  const saveDisabled = layer.querySelector<HTMLButtonElement>("[data-identity-save]")!.disabled;
  layer.querySelector("[data-identity-dialog]")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  await controller.cleanup();
  resolvePick({ picker: "late_avatar", url: "https://cloudig-runtime.local/late.png" }); await settle();
  assert.equal(saveDisabled, true); assert.equal(saves, 0);
  assert.deepEqual(discarded, ["late_avatar"]); assert.equal(closed.length, 1); assert.equal(closed[0].saved, false);
  assert.equal(layer.isConnected, false);
}));

test("Identity failed save restores controls and retains the selected avatar for retry", async () => environment(async (document, window) => {
  const module = await ui("pages/identity-editor/identity-editor.js"), discarded: string[] = [], drafts: any[] = [];
  let rejectSave!: (error: Error) => void;
  const pending = new Promise((_resolve, reject) => { rejectSave = reject; });
  const controller = module.mountIdentityEditor({ host: document.body, template: document.querySelector("#identity-editor-template"), state: { language: "zh-CN" }, model: module.visualIdentityFixture(),
    applicationAsset: (s: string) => s, resolveAvatar: async (v: any) => v.asset, discardAvatar: async (id: string) => { discarded.push(id); }, pickAvatar: async () => ({ picker: "retry_avatar", url: "https://cloudig-runtime.local/retry.png" }),
    save: async (value: unknown) => { drafts.push(value); if (drafts.length === 1) return pending; return { status: "saved" }; }, onClose: () => undefined });
  const layer: HTMLElement = controller.element, form = layer.querySelector<HTMLFormElement>("[data-identity-dialog]")!;
  layer.querySelector<HTMLButtonElement>(".identity-avatar-actions button")!.click(); await settle();
  form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  rejectSave(new Error("Retry this save")); await settle();
  assert.equal(layer.isConnected, true); assert.equal(layer.querySelector<HTMLInputElement>(".identity-card-name input")!.disabled, false);
  assert.equal(layer.querySelector<HTMLButtonElement>("[data-identity-cancel]")!.disabled, false); assert.deepEqual(discarded, []);
  assert.equal(layer.querySelector("[data-identity-status]")!.textContent, "Retry this save");
  form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  assert.equal(drafts.length, 2); assert.deepEqual(drafts[1], drafts[0]); assert.equal(layer.isConnected, false); assert.deepEqual(discarded, []);
}));

test("New time is independent and never asks for a timeline owner", async () => environment(async (document, window) => {
  const module = await ui("pages/time-editor/time-editor.js"), coverModule = await ui("pages/time-cover/time-cover.js");
  const cover = coverModule.visualTimeCoverFixture();
  cover.sovereign.items = [];
  for (const row of cover.terran.items) if (row.endpoint) { row.range = { start: row.endpoint }; delete row.endpoint; }
  let payload: any;
  const controller = module.mountTimeEditor({ host: document.body, template: document.querySelector("#time-editor-template"), model: module.visualTimeEditorFixture("time", "create_time"), cover, state: { language: "zh-CN" }, anchor: { date: "2026-09-06", offset: "Z" },
    preview: async (value: any) => { payload = value; throw new Error("stop before durable write"); } });
  const root: HTMLElement = controller.element;
  for (const meaning of ["跨越时间的意义", "某时某刻", "一切之前", "一切之后"]) assert(root.querySelector("[data-time-editor-terran-list]")!.textContent!.includes(meaning));
  root.querySelector<HTMLInputElement>("[name='name']")!.value = "独立时间";
  assert.equal(root.querySelector("[name='owner']"), null);
  controller.updateLanguage("en");
  assert(root.querySelector("[data-time-editor-terran-list]")!.textContent!.includes("Meaning across time"));
  root.querySelector("[data-time-editor-dialog]")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  assert.equal(Object.hasOwn(payload, "owner"), false);
  assert.equal(payload.draft.metadata.name, "独立时间");
  controller.cleanup();
}));

test("Real time UI creates, reopens and edits a timeline plus single and periodic nodes through the real Engine", async () => environment(async (document, window) => {
  const temporary = path.join(process.cwd(), "tmp"); await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "time-ui-engine-cycle-")), libraryRoot = path.join(base, "Library");
  const module = await ui("pages/time-editor/time-editor.js"), coverModule = await ui("pages/time-cover/time-cover.js");
  let commands: TimeEngineCommands | undefined;
  let active: any;
  const context = () => ({ request: "q_time_ui", signal: new AbortController().signal, emit: async () => undefined });
  try {
    await createRecordLibrary(libraryRoot, { timestamp: "2026-09-09T10:00:00.000Z", anchor: { date: "2026-09-09", offset: "Z" } });
    commands = new TimeEngineCommands({ libraryRoot });
    let handlers = commands.handlers();
    const call = async (name: string, payload: any) => handlers[name]!(JSON.parse(JSON.stringify(payload)), context()) as Promise<any>;
    const coverQuery = () => call("time.cover.query", { return_to: "archiver" });
    const save = async (cover: any, model: any, edits: Record<string, string>, language = "zh-CN") => {
      let submitted: any, committed: any, failure: unknown;
      active = module.mountTimeEditor({ host: document.body, template: document.querySelector("#time-editor-template"), model, cover, state: { language }, anchor: { date: "2026-09-09", offset: "Z" },
        preview: async (payload: any) => { submitted = structuredClone(payload); try { return await call("time.editor.preview", { route: cover.route, ...payload }); } catch (error) { failure = error; throw error; } },
        commit: async (payload: any) => { try { return await call("time.editor.commit", payload); } catch (error) { failure = error; throw error; } },
        onCommitted: (result: any) => { committed = result; } });
      const root: HTMLElement = active.element;
      for (const [name, value] of Object.entries(edits)) { const input = root.querySelector<HTMLInputElement>(`[name='${name}']`)!; input.value = value; input.dispatchEvent(new window.Event("input", { bubbles: true })); }
      root.querySelector("[data-time-editor-dialog]")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
      const deadline = Date.now() + 5000;
      while (!committed && !failure && Date.now() < deadline) { const modal = root.querySelector<HTMLElement>("[data-time-editor-impact]"); if (modal && !modal.hidden) modal.querySelector<HTMLButtonElement>("[data-time-impact-confirm]")!.click(); await new Promise(resolve => setTimeout(resolve, 10)); }
      if (failure) throw failure;
      assert.equal(committed?.status, "updated", root.querySelector("[data-time-editor-status]")?.textContent ?? "Save did not finish");
      if (model.action === "edit") { assert.equal(submitted.node, model.node); assert.equal(Object.hasOwn(submitted, "owner"), false); }
      else if (model.action === "create_time") { assert.equal(Object.hasOwn(submitted, "owner"), false); assert.equal(Object.hasOwn(submitted, "node"), false); }
      else { assert.equal(Object.hasOwn(submitted, "node"), false); assert.equal(Object.hasOwn(submitted, "owner"), false); }
      active.cleanup(); active = undefined; return committed;
    };
    let cover = await coverQuery();
    // The real UI used to replace stored relative anchors merely by reading
    // its inputs. That made an unchanged mapping look like a durable edit.
    const preset = cover.terran.items.find((row: any) => row.name === "宇宙诞生");
    const presetEditor = await call("time.editor.query", { route: cover.route, node: preset.node });
    const presetDraft = { metadata: presetEditor.metadata, children: presetEditor.children, counterparts: presetEditor.counterparts, mappings: presetEditor.mappings };
    let mappingPreview: any, returned = false;
    active = module.mountTimeEditor({ host: document.body, template: document.querySelector("#time-editor-template"), model: { ...presetEditor, action: "edit" }, cover,
      state: { language: "zh-CN" }, anchor: { date: "2030-01-01", offset: "+12:00" },
      previewRange: (range: any) => call("time.range.preview", { range, allow_sovereign: false, language: "en" }),
      preview: async (payload: any) => { mappingPreview = await call("time.editor.preview", { route: cover.route, ...payload }); return mappingPreview; },
      commit: async () => { throw new Error("Unchanged mapping must not commit without explicit refresh"); }, onReturn: () => { returned = true; } });
    active.element.querySelector("[data-time-editor-action='edit-mapping:0']").click(); active.updateLanguage("en");
    active.element.querySelector("[data-endpoint-confirm]").click(); await settle();
    active.element.querySelector("[data-endpoint-save]").click(); await settle();
    active.element.querySelector("[data-time-editor-dialog]").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
    for (let i = 0; i < 200 && !mappingPreview; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(mappingPreview?.no_change, true);
    active.element.querySelector("[data-time-impact-cancel]").click(); await settle(); assert.equal(returned, true);
    active.cleanup(); active = undefined;
    const unchanged = await call("time.editor.query", { route: cover.route, node: preset.node });
    assert.equal(unchanged.node_revision, presetEditor.node_revision);
    assert.deepEqual({ metadata: unchanged.metadata, children: unchanged.children, counterparts: unchanged.counterparts, mappings: unchanged.mappings }, presetDraft);
    const fresh = { action: "create_timeline", time_revision: cover.revision, library_revision: cover.library_revision, node_revision: cover.revision, metadata: { kind: "timeline", name: "", author: "", standard_name: null, version: "1.0" }, children: [], counterparts: [], mappings: [], references: [] };
    await save(cover, fresh, { name: "1", author: "1" });
    commands.close(); commands = new TimeEngineCommands({ libraryRoot }); handlers = commands.handlers();
    cover = await coverQuery();
    const timeline = cover.sovereign.items.find((row: any) => row.name === "1"); assert.equal(timeline.version, "1.0");
    const list = coverModule.mountTimeCover({ host: document.body, template: document.querySelector("#time-cover-template"), model: cover, state: { language: "zh-CN" }, returnTo: "archiver", onReturn: () => {} });
    assert.equal(list.element.querySelector("[data-time-sovereign-list] .time-cover-row-body span").textContent, "· 1 · V1.0"); list.cleanup();
    const editor = await call("time.editor.query", { route: cover.route, node: timeline.node }); assert.equal(Object.hasOwn(editor, "owner"), false);
    await assert.rejects(call("time.editor.preview", { route: cover.route, action: "edit", node: editor.node, owner: timeline.node,
      expected_time_revision: editor.time_revision, expected_library_revision: editor.library_revision, expected_node_revision: editor.node_revision,
      draft: { metadata: editor.metadata, children: editor.children, counterparts: editor.counterparts, mappings: editor.mappings } }), /Invalid time command fields/u);
    await save(cover, { ...editor, action: "edit" }, { name: "可编辑时间轴", author: "作者乙", version: "999.999" }, "en");
    for (const kind of ["single", "periodic"]) {
      cover = await coverQuery();
      const created = await save(cover, { action: "create_time", time_revision: cover.revision, library_revision: cover.library_revision, node_revision: cover.revision,
        metadata: kind === "single" ? { kind, name: "" } : { kind, name: "", count: 12, prefix: "第", unit: "月", display_empty: true }, children: [], counterparts: [], mappings: [], references: [] }, { name: kind });
      cover = await coverQuery(); const model = await call("time.editor.query", { route: cover.route, node: created.node });
      await save(cover, { ...model, action: "edit" }, { name: `${kind}-edited` });
    }
    commands.close(); commands = new TimeEngineCommands({ libraryRoot }); handlers = commands.handlers(); cover = await coverQuery();
    const all = await call("time.sovereign.query", { route: cover.route, offset: 0, limit: 100 });
    assert.deepEqual(all.items.map((row: any) => row.name).sort(), ["periodic-edited", "single-edited", "可编辑时间轴"].sort());
    assert.equal(all.items.find((row: any) => row.kind === "timeline").version, "999.999");
  } finally { active?.cleanup(); commands?.close(); await rm(base, { recursive: true, force: true }); }
}));

test("Timeline version is a fixed V-prefixed numeric format with bounded input and localized guidance", async () => environment(async (document, window) => {
  const module = await ui("pages/time-editor/time-editor.js"), coverModule = await ui("pages/time-cover/time-cover.js");
  let previewed = false;
  const controller = module.mountTimeEditor({ host: document.body, template: document.querySelector("#time-editor-template"), model: module.visualTimeEditorFixture(), cover: coverModule.visualTimeCoverFixture(), state: { language: "zh-CN" },
    preview: async () => { previewed = true; throw new Error("invalid version should not preview"); } });
  const root: HTMLElement = controller.element, input = root.querySelector<HTMLInputElement>("[name='version']")!;
  assert.equal(root.querySelector(".time-editor-version > span")!.textContent, "V"); assert.equal(input.maxLength, 7); assert.equal(input.inputMode, "decimal");
  for (const value of ["0.0", "1.0", "999.999", ""]) { input.value = value; input.dispatchEvent(new window.Event("input")); assert.equal(input.checkValidity(), true, value); }
  for (const value of ["abc", "1000.0", "1.1000", "1.2.3", "1", "1."]) { input.value = value; input.dispatchEvent(new window.Event("input")); assert.equal(input.checkValidity(), false, value); assert.match(input.validationMessage, /版本格式/u); }
  input.value = "1.0"; input.setSelectionRange(3, 3);
  const letter = new window.InputEvent("beforeinput", { data: "x", inputType: "insertText", cancelable: true }); input.dispatchEvent(letter); assert.equal(letter.defaultPrevented, true);
  input.value = "bad"; input.dispatchEvent(new window.Event("input"));
  root.querySelector("[data-time-editor-dialog]")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle(); assert.equal(previewed, false);
  controller.updateLanguage("en"); assert.match(root.querySelector<HTMLInputElement>("[name='version']")!.validationMessage, /Version:/u);
  controller.cleanup();
}));

test("Time Editor retains typed metadata through inline range saving and confirms child ordering separately", async () => environment(async (document, window) => {
  const module = await ui("pages/time-editor/time-editor.js"), cover = await ui("pages/time-cover/time-cover.js");
  let payload: any;
  const controller = module.mountTimeEditor({ host: document.body, template: document.querySelector("#time-editor-template"), model: module.visualTimeEditorFixture(), cover: cover.visualTimeCoverFixture(), state: { language: "zh-CN" }, anchor: { date: "2026-09-05", offset: "Z" },
    previewRange: async (range: any) => ({ range, direction: "forward" }),
    queryNodes: async () => ({ items: [{ node: "period12", name: "十二月", kind: "periodic", count: 12 }] }),
    preview: async (draft: any) => { payload = structuredClone(draft); throw new Error("test stops before durable write"); } });
  const root: HTMLElement = controller.element;
  const name = root.querySelector<HTMLInputElement>("[data-time-editor-metadata] [name='name']")!; name.value = "尚未保存的名字";
  root.querySelector<HTMLButtonElement>("[data-time-editor-add-mapping]")!.click();
  const fields = root.querySelector("[data-endpoint-side-section='start']")!;
  for (const [key, value] of [["year", "2040"], ["month", "2"], ["day", "3"]]) fields.querySelector<HTMLInputElement>(`[data-endpoint-field='${key}']`)!.value = value!;
  root.querySelector<HTMLButtonElement>("[data-endpoint-confirm]")!.click(); await settle();
  root.querySelector<HTMLButtonElement>("[data-endpoint-save]")!.click(); await settle();
  assert.equal(root.querySelector<HTMLInputElement>("[name='name']")!.value, "尚未保存的名字");
  assert.equal(root.querySelectorAll(".time-editor-mapping-pill").length, 2);
  const names = () => [...root.querySelectorAll("[data-time-editor-children] strong")].map(node => node.textContent);
  const before = names();
  root.querySelector<HTMLButtonElement>("[data-time-editor-sort-children]")!.click();
  root.querySelector<HTMLButtonElement>("[data-time-editor-action='move-child-down:0']")!.click();
  assert.deepEqual(names(), [...before].reverse());
  root.querySelector<HTMLButtonElement>("[data-time-editor-order-cancel]")!.click(); assert.deepEqual(names(), before);
  root.querySelector<HTMLButtonElement>("[data-time-editor-add-counterpart]")!.click(); await settle();
  assert.equal(root.querySelectorAll(".time-editor-preset-tags button").length, 9);
  root.querySelector<HTMLButtonElement>(".time-editor-node-results [data-pick-node='period12']")!.click();
  root.querySelector<HTMLInputElement>("[name='picker-occurrences'][value='partial']")!.click();
  for (const [key, value] of [["first", "2"], ["step", "2"], ["last", "12"]]) root.querySelector<HTMLInputElement>(`.time-editor-periodic-inputs [name='${key}']`)!.value = value!;
  root.querySelector<HTMLButtonElement>("[data-time-editor-action='confirm-node']")!.click();
  root.querySelector("[data-time-editor-dialog]")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  assert.equal(payload.draft.metadata.name, "尚未保存的名字");
  assert.deepEqual(payload.draft.counterparts[0].target.occurrences, { first: 2, step: 2, last: 12 });
  controller.cleanup();
}));

test("periodic mappings keep independent source and target selections instead of conflating their occurrence ranges", async () => environment(async (document, window) => {
  const module = await ui("pages/time-editor/time-editor.js"), cover = await ui("pages/time-cover/time-cover.js"); let submitted: any;
  const controller = module.mountTimeEditor({ host: document.body, template: document.querySelector("#time-editor-template"), model: module.visualTimeEditorFixture("time"), cover: cover.visualTimeCoverFixture(), state: { language: "zh-CN" }, anchor: { date: "2026-09-11", offset: "Z" },
    queryNodes: async () => ({ items: [{ node: "target12", name: "目标月份", kind: "periodic", count: 12 }] }), previewRange: async (range: any) => ({ range, direction: "forward" }),
    preview: async (payload: any) => { submitted = payload; throw new Error("stop before save"); } });
  const root: HTMLElement = controller.element;
  root.querySelector<HTMLButtonElement>("[data-time-editor-add-counterpart]")!.click(); await settle();
  root.querySelector<HTMLInputElement>("[data-source-occurrences] [value='partial']")!.click();
  for (const [key, value] of [["first", "1"], ["step", "2"], ["last", "11"]]) root.querySelector<HTMLInputElement>(`[name='source-${key}']`)!.value = value!;
  root.querySelector<HTMLButtonElement>("[data-pick-node='target12']")!.click();
  root.querySelector<HTMLInputElement>("[name='picker-occurrences'][value='partial']")!.click();
  for (const [key, value] of [["first", "2"], ["step", "2"], ["last", "12"]]) root.querySelector<HTMLInputElement>(`[name='${key}']`)!.value = value!;
  root.querySelector<HTMLButtonElement>("[data-time-editor-action='confirm-node']")!.click();
  root.querySelector<HTMLButtonElement>("[data-time-editor-add-mapping]")!.click();
  root.querySelector<HTMLInputElement>("[data-source-occurrences] [value='partial']")!.click();
  for (const [key, value] of [["first", "3"], ["step", "3"], ["last", "12"]]) root.querySelector<HTMLInputElement>(`[name='source-${key}']`)!.value = value!;
  const start = root.querySelector("[data-endpoint-side-section='start']")!;
  for (const [key, value] of [["year", "2040"], ["month", "2"], ["day", "3"]]) start.querySelector<HTMLInputElement>(`[data-endpoint-field='${key}']`)!.value = value!;
  root.querySelector<HTMLButtonElement>("[data-endpoint-confirm]")!.click(); await settle(); root.querySelector<HTMLButtonElement>("[data-endpoint-save]")!.click(); await settle();
  root.querySelector("[data-time-editor-dialog]")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  assert.deepEqual(submitted.draft.counterparts[0].self_occurrences, { first: 1, step: 2, last: 11 });
  assert.deepEqual(submitted.draft.counterparts[0].target.occurrences, { first: 2, step: 2, last: 12 });
  assert.deepEqual(submitted.draft.mappings[0].occurrences, { first: 3, step: 3, last: 12 }); controller.cleanup();
}));

test("independent-copy confirmation shows actual names and counts and cancelling it never dispatches a save", async () => environment(async (document, window) => {
  const module = await ui("pages/time-editor/time-editor.js"), cover = await ui("pages/time-cover/time-cover.js"); let commits = 0, queries = 0;
  const controller = module.mountTimeEditor({ host: document.body, template: document.querySelector("#time-editor-template"), model: module.visualTimeEditorFixture(), cover: cover.visualTimeCoverFixture(), state: { language: "zh-CN" },
    preview: async () => ({ plan: "tp_scope", no_change: false, can_commit: true, impact: { strategies: ["in_place", "future_only"], external_links: [], affected_references: [] } }),
    previewSelection: async () => { queries++; return { copy_count: 3, updated_count: 0, cancelled_count: 0, offset: 0, limit: 100, copies: [{ name: "独立时间" }, { name: "甲轴" }, { name: "乙轴" }], references: [] }; },
    commit: async () => { commits++; return { status: "updated" }; } });
  const root: HTMLElement = controller.element;
  root.querySelector("[data-time-editor-dialog]")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  root.querySelector<HTMLInputElement>("[name='strategy'][value='future_only']")!.click(); root.querySelector<HTMLButtonElement>("[data-time-impact-confirm]")!.click(); await settle();
  const modal = root.querySelector<HTMLElement>("[data-time-editor-impact]")!; assert.equal(modal.hidden, false); assert.match(modal.textContent!, /新建 3 个独立节点/); assert.match(modal.textContent!, /甲轴/); assert.match(modal.textContent!, /乙轴/);
  root.querySelector<HTMLButtonElement>("[data-time-impact-cancel]")!.click(); await settle(); assert.equal(queries, 1); assert.equal(commits, 0); controller.cleanup();
}));
