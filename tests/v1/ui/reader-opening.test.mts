import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Reader jumps directly across offscreen content but preserves nearby navigation motion", async () => {
  const source = await readFile(new URL("../../../src/ui/shell/pages/reader/reader-conversation.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  const scrollToNavigation ="), source.indexOf("  const watchVisible ="));
  const moves: ScrollIntoViewOptions[] = [];
  let targetTop = 78000;
  const target = { closest: () => null, getBoundingClientRect: () => ({ top: targetTop }), scrollIntoView: (options: ScrollIntoViewOptions) => moves.push(options) };
  const run = new Function("deps", `
    const { target, reduced } = deps;
    const navigationItems = [{anchor:'message-last'}], currentNavigation = 0, refreshOrdinal = 0, disposed = false;
    const rendererRoot = {querySelector:()=>target}, CSS = {escape:value=>value}, view = {};
    const scroll = {clientHeight:800,getBoundingClientRect:()=>({top:240})};
    const setCurrentNavigation = ()=>{}, matchMedia = ()=>({matches:reduced});
    ${body}
    return scrollToNavigation;
  `);
  await run({ target, reduced: false })(0);
  assert.deepEqual(moves.pop(), { block: "start", behavior: "auto" });
  targetTop = 480;
  await run({ target, reduced: false })(0);
  assert.deepEqual(moves.pop(), { block: "start", behavior: "smooth" });
  await run({ target, reduced: true })(0);
  assert.deepEqual(moves.pop(), { block: "start", behavior: "auto" });
});

test("Reader shows the chosen title before native I/O, suppresses repeat clicks and closes superseded views", async () => {
  const source = await readFile(new URL("../../../src/ui/shell/shell.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function disposeActiveConversation("), source.indexOf("function visualInfoPreview("));
  const mounted: any[] = [], reads: any[] = [], closed: string[] = [], transitions: string[] = [];
  const run = new Function("deps", `
    const { mountReaderConversation, requestWithSignal, request, runtimeJson, preload, showTransition, hideTransition } = deps;
    let currentPage = { element: {} }, activeConversation = null, readerBranchArchive, readerSessionState = {}, routeOrdinal = 0, currentRoute, exampleReturn;
    const closeDocument = () => {};
    const root = { dataset: {} }, app = { dataset: {} }, state = {}, screenshotQuery = new URLSearchParams(), conversationTemplate = {}, readerConversationPreload = [];
    const conversationRequest = () => ({}), translate = key => key, applyTheme = () => {}, applyLocale = () => {};
    const showActionError = () => {}, applicationAsset = () => {}, openIdentityEditor = () => {}, openConversationInfo = () => {}, performMarkdownExport = () => {};
    ${body}
    return { open: openReaderConversation, dispose: disposeActiveConversation, root };
  `)({
    mountReaderConversation(options: any) { const result = { options, phases: [] as any[], views: [] as any[], disposed: false,
      setLoading(phase: any) { this.phases.push(phase); }, replaceView(view: any) { this.views.push(view); }, cleanup() { this.disposed = true; } }; mounted.push(result); return result; },
    requestWithSignal(_command: string, payload: any, signal: AbortSignal) { return new Promise(resolve => reads.push({ payload, signal, resolve })); },
    async request(command: string, payload: any) { if (command === "reader.view.close") closed.push(payload.view); },
    async runtimeJson(page: any) { return page; }, async preload() {},
    async showTransition() { transitions.push("show"); }, hideTransition() { transitions.push("hide"); }
  });
  const first = run.open({ capability: "a", title: "First" });
  assert.equal(mounted[0].options.row.title, "First"); assert.equal(mounted[0].options.loading, true);
  await Promise.resolve(); assert.equal(reads.length, 1);
  await run.open({ capability: "a", title: "First" }); assert.equal(reads.length, 1);
  const second = run.open({ capability: "b", title: "Second" }); await Promise.resolve();
  assert.equal(mounted[0].disposed, true); assert.equal(reads[0].signal.aborted, true);
  reads[0].resolve({ token: "old", page: { title: "Old" } }); await first;
  assert.deepEqual(closed, ["old"]); assert.equal(mounted[1].disposed, false);
  reads[1].resolve({ token: "new", page: { title: "New" } }); await second;
  assert.deepEqual(mounted[1].phases, ["preparing"]); assert.deepEqual(mounted[1].views, [{ title: "New" }]);
  assert.equal(run.root.dataset.readerOpenStage, "ready"); assert.deepEqual(transitions, []);
  run.dispose(); assert.deepEqual(closed, ["old", "new"]);
});
