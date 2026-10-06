import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { transform } from "esbuild";
import { JSDOM } from "jsdom";

const shellRoot = path.join(process.cwd(), "src", "ui", "shell");

test("System Log keeps one quiet dialog and scroll owner with explicit approved log-only cleanup", async () => {
  const [html, css, module, shell, zh, en] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages", "system-log", "system-log.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "system-log", "system-log.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8"),
    readFile(path.join(shellRoot, "locales", "zh-CN.json"), "utf8"),
    readFile(path.join(shellRoot, "locales", "en.json"), "utf8")
  ]);
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#system-log-template");
  assert.ok(template);
  assert.equal(template.content.querySelectorAll("[data-system-log-dialog][role='dialog']").length, 1);
  assert.equal(template.content.querySelectorAll("[data-system-log-list][data-scroll-region]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-system-log-close]").length, 1);
  assert.equal(/(^|\n)\s*\.system-log-[^{,]+/u.test(css), false, "System Log selectors must begin at the page layer root");
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.match(css, /:root\[data-theme="star-night"\] \[data-system-log-layer\] \.system-log-dialog/u);
  assert.match(module, /options\.copyText/u, "clipboard remains a shell-injected page action rather than a backend log command");
  assert.match(shell, /navigator\.clipboard\.writeText/u);
  assert.match(shell, /request\("systemLog\.list"/u);
  const open = shell.slice(shell.indexOf("async function openSystemLog("), shell.indexOf("async function mountArchiverPage("));
  assert.match(open, /const screenshot = screenshotQuery\.get\("screenshot"\) === "1" && screenshotQuery\.get\("fixture"\) !== "real"/u, "Actual Library audits must read the current error projection, not the demonstration log");
  assert.match(shell, /request\("systemLog\.reveal"/u);
  assert.match(shell, /request\("systemLog\.delete"/u);
  assert.match(shell, /request\("systemLog\.clear"/u);
  assert.doesNotMatch(shell, /systemLog\.search|systemLog\.repair/u);
  assert.equal(template.content.querySelectorAll("[data-system-log-clear]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-system-log-refresh]").length, 1);
  assert.match(JSON.parse(zh).systemLog.clearConfirm, /不会删除任何源文件或会话档案/u);
  assert.equal(JSON.parse(zh).systemLog.empty, "当前没有系统日志");
  assert.equal(JSON.parse(en).systemLog.title, "System Log");
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
  await transform(shell, { format: "esm", loader: "js", target: "chrome120" });
});

test("System Log delete, clear confirmation and late pagination cannot restore cleared entries", async () => {
  const dom = new JSDOM(await readFile(path.join(shellRoot, "index.html"), "utf8"), { pretendToBeVisual: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals["document"];
  globals["document"] = dom.window.document;
  const { mountSystemLog } = await import(new URL("../../../src/ui/shell/pages/system-log/system-log.js", import.meta.url).href);
  const labels = JSON.parse(await readFile(path.join(shellRoot, "locales/zh-CN.json"), "utf8")).systemLog;
  let records = ["one", "two", "three"].map(name => ({ capability: name, path: `Inbox/${name}.html`, recorded_at: "2026-09-08T00:00:00Z", errors: [{ source: "parser", message: name }] }));
  const page = () => ({ offset: 0, limit: 2, total: records.length, items: records.slice(0, 2) });
  let finishPage: (value: unknown) => void = () => undefined;
  let closes = 0;
  const controller = mountSystemLog({ template: dom.window.document.querySelector("#system-log-template"), model: page(), labels, copyText: async () => undefined, onReveal: async () => undefined, onRefresh: async () => page(), onDelete: async (file: string) => { records = records.filter(row => row.capability !== file); }, onClear: async () => { records = []; }, onLoadMore: () => new Promise(resolve => { finishPage = resolve; }), onClose: () => { closes += 1; } });
  try {
    dom.window.document.body.append(controller.element);
    const find = (selector: string) => controller.element.querySelector(selector) as HTMLElement;
    find("[data-system-log-list]").dispatchEvent(new dom.window.Event("scroll"));
    const stale = { offset: 2, limit: 1, total: 3, items: [records[2]] };
    find("[data-system-log-action='delete-file']").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    finishPage(stale);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(controller.element.querySelectorAll(".system-log-file-card").length, 2);
    assert.equal(controller.element.textContent.includes("Inbox/one.html"), false);
    find("[data-system-log-clear]").click();
    assert.match(find(".system-log-confirmation").textContent ?? "", /不会删除任何源文件或会话档案/u);
    find("[data-system-log-action='cancel-clear']").click();
    assert.equal(records.length, 2);
    find("[data-system-log-clear]").click();
    find("[data-system-log-action='confirm-clear']").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(records.length, 0);
    assert.equal(controller.element.querySelectorAll(".system-log-file-card").length, 0);
    assert.equal(closes, 0);
  } finally { controller.cleanup(); dom.window.close(); if (previous === undefined) delete globals["document"]; else globals["document"] = previous; }
});
