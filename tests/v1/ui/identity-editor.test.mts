import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { transform } from "esbuild";
import { JSDOM } from "jsdom";

const shellRoot = path.join(process.cwd(), "src", "ui", "shell");

test("identity editor keeps one themed card dialog, conversation-name scope and avatar capability actions", async () => {
  const [html, css, module, shell, bridge] = await Promise.all([
    readFile(path.join(shellRoot, "index.html"), "utf8"),
    readFile(path.join(shellRoot, "pages", "identity-editor", "identity-editor.css"), "utf8"),
    readFile(path.join(shellRoot, "pages", "identity-editor", "identity-editor.js"), "utf8"),
    readFile(path.join(shellRoot, "shell.js"), "utf8"),
    readFile(path.join(process.cwd(), "src", "desktop", "Cloudig.Desktop.Core", "BridgePolicy.cs"), "utf8")
  ]);
  const document = new JSDOM(html).window.document;
  const template = document.querySelector<HTMLTemplateElement>("#identity-editor-template");
  assert.ok(template);
  assert.equal(template.content.querySelectorAll("[data-identity-dialog]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-identity-body][data-scroll-region]").length, 1);
  assert.equal(template.content.querySelectorAll("[data-identity-conversation-user], [data-identity-conversation-assistant]").length, 2);
  assert.doesNotMatch(css, /(^|\n)\s*(?:button|input|form|\.cloudig-)[^{,]*\{/u, "Identity CSS must not address shared elements without an identity root");
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.match(css, /identity-editor-platform-grid[^}]*grid-template-columns:\s*repeat\(3/u);
  assert.doesNotMatch(css, /identity-editor-platform-grid[^}]*grid-template-columns:\s*repeat\(4/u);
  assert.match(css, /width:\s*min\(1080px, calc\(100vw - 48px\)\)/u);
  assert.match(css, /identity-editor-global-grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(css, /identity-apply-all,[\s\S]*identity-card-helper\s*\{\s*grid-column:\s*2/u);
  assert.match(css, /identity-apply-all[^}]*font-weight:\s*400/u);
  assert.match(css, /identity-apply-helper[^}]*font-weight:\s*400/u);
  assert.match(css, /identity-editor-callout[^}]*font-weight:\s*400/u);
  assert.match(css, /identity-avatar-frame\s*>\s*\.identity-avatar-clear[^}]*position:\s*absolute/u);
  assert.match(css, /data-platform="chatgpt"[^\n]*data-platform="grok"[^\n]*data-platform="zai"[^}]*background:\s*#ffffff/u);
  assert.match(css, /@media \(max-width:\s*1320px\)[\s\S]*repeat\(3/u);
  assert.doesNotMatch(css, /font:[^;]*\bInter\b/u);
  assert.match(module, /userHelper/u);
  assert.match(module, /所有对话使用统一智能头像与名字/u);
  assert.match(module, /identity-apply-helper/u);
  assert.match(module, /clear\.hidden\s*=\s*source\.custom_avatar\s*!==\s*true/u);
  assert.doesNotMatch(module, /applyCopy\.append\(element\("strong"/u);
  assert.match(module, /options\.pickAvatar/u);
  assert.match(module, /options\.discardAvatar/u);
  assert.match(shell, /request\("identity\.query"/u);
  assert.match(shell, /request\("identity\.commit"/u);
  const open = shell.slice(shell.indexOf("async function openIdentityEditor("), shell.indexOf("async function openConversationInfo("));
  assert.match(open, /const screenshot = screenshotQuery\.get\("screenshot"\) === "1" && screenshotQuery\.get\("fixture"\) !== "real"/u, "An actual-Library WPF audit must not substitute an Identity mock or skip saving");
  assert.doesNotMatch(shell, /request\("reader\.archive\.identity\.commit"/u, "one save must not perform a second independently committing identity write");
  assert.match(bridge, /"shell\.pickIdentityAvatar"/u);
  await transform(module, { format: "esm", loader: "js", target: "chrome120" });
  await transform(shell, { format: "esm", loader: "js", target: "chrome120" });
  const refresh = shell.slice(shell.indexOf("async function refreshShellIdentity("), shell.indexOf("async function setOrdinaryParse("));
  assert.doesNotMatch(refresh, /state\.revision\s*=/u, "an Identity SHA must never replace the Library settings proof");
  assert.match(shell, /expected_conversation:\s*conversation\.revision\.conversation/u);
  assert.match(shell, /expected_mark:\s*conversation\.revision\.mark/u);
});
