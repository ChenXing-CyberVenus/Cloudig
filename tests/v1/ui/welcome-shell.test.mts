import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";

const root = process.cwd();
const shellRoot = path.join(root, "src", "ui", "shell");
const assetRoot = path.join(root, "src", "ui", "assets");

async function text(relative: string): Promise<string> {
  return readFile(path.join(shellRoot, relative), "utf8");
}

test("failed Engine connections retain their code and show an actionable message in each language", async () => {
  const source = await text("shell.js");
  const definition = source.slice(source.indexOf("function bridgeError("), source.indexOf("globalThis.chrome?.webview?.addEventListener(\"message\""));
  for (const language of ["zh-CN", "en"]) {
    const explain = new Function("state", definition + ";return bridgeError;")({ language });
    const failed = explain({ code: "CLOUDIG_ENGINE_UNAVAILABLE", message: "native failure" });
    assert.equal(failed.code, "CLOUDIG_ENGINE_UNAVAILABLE");
    assert.match(failed.message, language === "en" ? /Restart Cloudig/u : /重新打开采云/u);
    assert.doesNotMatch(failed.message, /native failure|档案已经变化/u);
    const external = explain({ code: "CLOUDIG_EXTERNAL_OPEN_FAILED", message: "native failure" });
    assert.equal(external.code, "CLOUDIG_EXTERNAL_OPEN_FAILED");
    assert.match(external.message, language === "en" ? /default browser settings/u : /默认浏览器设置/u);
    assert.equal(explain({ code: "OTHER", message: "specific error" }).message, "specific error");
  }
});

test("Startup paints the original sun before releasing native Library initialization", async () => {
  const script = await text("startup.js");
  for (const decodes of [true, false]) {
    const dom = new JSDOM('<img class="sun"><div class="route-transition"><img></div>', { runScripts: "outside-only" });
    const image = dom.window.document.querySelector<HTMLImageElement>(".route-transition img")!;
    const frames: FrameRequestCallback[] = [], messages: any[] = [];
    image.decode = async () => { if (!decodes) throw new Error("Missing GIF"); };
    Object.defineProperty(image, "naturalWidth", { value: 232 });
    dom.window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
    Object.defineProperty(dom.window, "chrome", { value: { webview: { postMessage: (message: unknown) => messages.push(message) } } });
    const completion = dom.window.eval(script);
    await new Promise(resolve => setImmediate(resolve));
    if (decodes) {
      assert.equal(messages.length, 1, "decode only hands visibility over from the native GIF");
      assert.equal(messages[0].payload.ready, true);
      assert.equal(messages[0].payload.stage, "decoded");
      frames.shift()!(0); assert.equal(messages.length, 1, "decode alone is not a rendered frame");
      frames.shift()!(16);
    }
    await completion;
    assert.equal(messages.length, decodes ? 2 : 1);
    assert.equal(messages.at(-1).command, "shell.loading");
    assert.equal(messages.at(-1).payload.ready, decodes);
    assert.equal(messages.at(-1).payload.stage, undefined);
    assert.equal(dom.window.document.documentElement.dataset["loadingPainted"], String(decodes));
    dom.window.close();
  }
  const native = await readFile(path.join(root, "src/desktop/Cloudig.Desktop/MainWindow.xaml.cs"), "utf8");
  const xaml = await readFile(path.join(root, "src/desktop/Cloudig.Desktop/MainWindow.xaml"), "utf8");
  assert.match(xaml, /DefaultBackgroundColor="Black"/u);
  assert.match(xaml, /x:Name="WebView"[^>]*Visibility="Hidden"/u);
  assert.match(xaml, /x:Name="StartupSun"[^>]*Width="96"[^>]*Height="96"[^>]*Stretch="Uniform"/u);
  assert.doesNotMatch(native, /DefaultBackgroundColor = System.Drawing.Color.White/u);
  const position = (text: string) => { const value = native.indexOf(text); assert(value >= 0, `Missing startup operation: ${text}`); return value; };
  const navigate = position("WebView.Source ="), loading = position("await _loadingVisible.Task");
  assert.ok(position("new StartupSunAnimation(StartupSun)") < position("webview-environment-starting"), "The native GIF must exist before browser initialization");
  assert.ok(position('TraceVisualAudit("native-loading-visible"') < position("await _prepareStorage()"), "Storage probes must follow the native loading frame, not hide window creation");
  assert.ok(position("await _prepareStorage()") < position("webview-environment-starting"), "WebView and Engine must still wait for successful storage/move preparation");
  const app = await readFile(path.join(root, "src/desktop/Cloudig.Desktop/App.xaml.cs"), "utf8");
  const earlyStartup = app.slice(app.indexOf("protected override async void OnStartup"), app.indexOf("private static async Task<bool> PrepareStorageAsync"));
  assert.doesNotMatch(earlyStartup, /PortableStorageBoundary\.Verify|PortableMoveStartup\.ResolveAsync/u, "Pre-window startup must not perform write probes or move recovery");
  assert.match(app, /Task\.Run\(\(\) => PortableStorageBoundary\.Verify\(layout\.LibraryRoot!\)\)/u);
  assert.match(app, /Task\.Run\(\(\) => PortableStorageBoundary\.Verify\(new\[\] \{ layout\.DeviceRoot, layout\.CacheRoot, layout\.WebViewUserDataRoot \}\)\)/u);
  const probes = await readFile(path.join(root, "src/desktop/Cloudig.Desktop.Core/PortableStorageBoundary.cs"), "utf8");
  assert.doesNotMatch(probes, /\.Flush\(true\)|FileOptions\.WriteThrough/u, "Disposable permission probes cannot force physical disk flushes");
  assert.ok(navigate < loading);
  assert.ok(loading < position("await InitializeLibraryAsync()"));
  assert.ok(position("Task.WhenAll(environmentTask, PrepareEngineAsync())") < navigate);
  assert.ok(position("BindLocalContent();") < navigate, "Program and runtime content must be served before navigation");
  assert.doesNotMatch(native.slice(native.indexOf("private async Task PrepareEngineAsync()"), native.indexOf("private async Task InitializeLibraryAsync()")), /library\.startup\.recover|library\.create|PortableStorageBoundary\.Verify/u, "Preparing the transport cannot repeat permission probes or start recovery before the loading frame");
  assert.match(native, /if \(!await _libraryReady.Task\)/u);
});

test("Welcome is one approved semantic stack with deterministic theme and responsive boundaries", async () => {
  const [html, shellCss, welcomeCss, script, zh, en] = await Promise.all([
    text("index.html"),
    text("shell.css"),
    text("welcome.css"),
    text("shell.js"),
    text(path.join("locales", "zh-CN.json")),
    text(path.join("locales", "en.json"))
  ]);
  const css = `${shellCss}\n${welcomeCss}`;
  const document = new JSDOM(html).window.document;
  assert.equal(document.documentElement.dataset["theme"], "dawn");
  assert.equal(document.documentElement.dataset["ready"], "false");
  assert.equal(document.querySelectorAll("main[data-page='welcome']").length, 1);
  assert.equal(document.querySelectorAll(".welcome-stage").length, 1);
  assert.equal(document.querySelectorAll(".welcome-background-set").length, 2);
  assert.equal(document.querySelectorAll(".welcome-background-layer").length, 4);

  const focusOrder = [...document.querySelectorAll("button")].map((node) =>
    node.getAttribute("data-party") ?? node.getAttribute("data-route-target") ?? node.getAttribute("data-action")
  );
  assert.deepEqual(focusOrder, [
    "user", "assistant", "reader", "archiver", "toggle-theme", "check-update", "open-docs", "toggle-language"
  ]);
  assert.equal(document.querySelector("[data-identity-name='user']")?.textContent, "采云用户");
  assert.equal(document.querySelector("[data-identity-name='assistant']")?.textContent, "智能伙伴");
  assert.equal(document.querySelectorAll(".boot-cover, .boot-mark").length, 0);
  assert.equal(document.querySelector(".route-transition img")?.getAttribute("src"), "/assets/reader/Waiting-Sun.gif");

  assert.match(css, /height:\s*1080px[\s\S]*width:\s*1920px/u);
  assert.match(css, /scale\(var\(--welcome-scale, 1\)\)/u);
  assert.match(css, /welcome-background-first 24s linear infinite/u);
  assert.match(css, /welcome-background-second 24s linear infinite/u);
  assert.match(welcomeCss, /data-ready="false"[\s\S]*welcome-background-set[\s\S]*transition:\s*none/u);
  assert.match(welcomeCss, /data-screenshot-phase[\s\S]*welcome-background-set[\s\S]*transition:\s*none/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
  assert.match(shellCss, /data-screenshot-phase="motion-freeze"[\s\S]*animation-play-state:\s*paused/u);
  assert.match(shellCss, /data-screenshot-phase="motion-middle"[\s\S]*animation-delay:\s*-2\.4s/u);
  assert.match(shellCss, /\.route-transition\s*\{[^}]*background:\s*#000000/u);
  assert.match(script, /root\.dataset\.ready = "true";\s*hideTransition\(routeOrdinal\);/u);
  assert.match(shellCss, /--cloudig-font-ui:\s*"Microsoft YaHei UI"/u);
  assert.match(shellCss, /:root\[lang="en"\][\s\S]*--cloudig-font-ui:\s*"Segoe UI Variable Text"/u);
  assert.match(shellCss, /\.cloudig-button\s*\{[^}]*isolation:\s*isolate;/u);
  assert.doesNotMatch(shellCss, /font-family:\s*Inter/u);
  assert.doesNotMatch(css, /box-shadow\s*:/u);
  assert.match(html, /href="\/welcome\.css"/u);
  assert.equal(/(^|\n)\s*\.welcome-[^{,]+/u.test(welcomeCss), false, "Welcome selectors must begin at the page root");
  assert.match(script, /Math\.min\(1, innerWidth \/ 1920, innerHeight \/ 1080\)/u);
  assert.match(script, /state\.userName\s*=\s*language === "en" \? "User" : "采云用户"/u);
  assert.match(script, /state\.assistantName\s*=\s*language === "en" \? "AI" : "智能伙伴"/u);
  assert.match(script, /if \(!state\.userNameCustom\) state\.userName = state\.language === "en" \? "User" : "采云用户"/u);
  assert.match(script, /if \(!state\.assistantNameCustom\) state\.assistantName = state\.language === "en" \? "AI" : "智能伙伴"/u);
  assert.match(script, /currentLocale = values;[\s\S]*applyLocale\(\);/u);
  assert.doesNotMatch(script, /if \(reopen\) await openReaderConversation\(reopen\)/u);

  const zhLocale = JSON.parse(zh);
  const enLocale = JSON.parse(en);
  assert.deepEqual(Object.keys(enLocale.welcome).sort(), Object.keys(zhLocale.welcome).sort());
  assert.equal(zhLocale.welcome.themeTooltip, "切换破晓 / 星夜主题");
  assert.equal(enLocale.welcome.reader, "Reader");
  assert.equal(enLocale.welcome.archiver, "Archiver");
  assert.equal(zhLocale.welcome.releaseName, "东方既白");
  assert.equal(enLocale.welcome.releaseName, "DawnGlow");
  assert.equal((html.match(/data-i18n="welcome\.releaseName"/gu) ?? []).length, 5,
    "Welcome, Reader, Archiver and both documentation panels share the release translation");
});

test("Production UI assets match their recorded derivation manifest", async () => {
  const manifest = JSON.parse(await readFile(path.join(assetRoot, "asset-sources.json"), "utf8"));
  assert.equal(manifest.schema, "cloudig/asset-sources/1.0.0");
  assert.equal(manifest.assets.length, 158);
  const required = new Set([
    "archiver/TitleDec-Conquer.svg",
    "archiver/TitleDec-Planet.svg",
    "platforms/platform-codex.svg",
    "platforms/platform-agent-instance.svg",
    "platforms/Codex-LICENSE.txt",
    "welcome/Back-Light-start-1920.png",
    "welcome/Back-Light-1920.png",
    "welcome/Back-Abyss-1920.png",
    "welcome/Back-Horizon-1920.png",
    "welcome/OsisLogo-Main-1024.png",
    "welcome/OsisLogo-Cloudig-1024.png",
    "welcome/Cloudig-Logo-Title-Slogan.svg",
    "welcome/OsisLogo-Simple.svg",
    "welcome/OsisLogo-Simple-Mono-Purple.svg",
    "welcome/OsisLogo-Simple-Mono-Orange.svg",
    "welcome/Cover-PhotoFrame-Dawn.svg",
    "welcome/Cover-PhotoFrame-StarNight.svg",
    "reader/Waiting-Sun.gif",
    "reader/Cloudig-Title-English-Grey-Dark.svg",
    "reader/Cloudig-Title-English-Grey-Light.svg",
    "reader/Cloudig-Slogan-English-Grey-Dark.svg",
    "reader/Cloudig-Slogan-English-Grey-Light.svg",
    "reader/DocBack-Dawn.svg",
    "reader/DocBack-StarNight.svg",
    "reader/Conversation-Title-Back-Dawn.svg",
    "reader/Conversation-Title-Back-StarNight.svg",
    "reader/ToolBar-Pattern-Dawn.svg",
    "reader/ToolBar-Pattern-StarNight.svg",
    "reader/RCSD-桌面与杂物.svg",
    "reader/RCSD-爬相框的猫.svg",
    "reader/RCSS-桌面与电脑-黑灯.svg",
    "reader/RCSS-光锥蒙版下的桌面与电脑.svg",
    "reader/RCSS-鹦鹉.svg",
    "reader/Windbell-Dawn.svg",
    "reader/Windbell-StarNight.svg",
    "reader/AllDirectory-Selected-Dawn.svg",
    "platforms/platform-chatgpt.svg",
    "platforms/platform-doubao.png",
    "platforms/platform-kimi.svg",
    "platforms/platform-mistral.svg",
    "archiver/Phoenix.svg",
    "archiver/Rocket.svg",
    "archiver/Cock.svg",
    "archiver/RockStage.svg",
    "archiver/Astronaut.svg",
    "archiver/Sunflower.svg",
    "archiver/Wave-Blue.svg",
    "archiver/Wave-Green.svg",
    "archiver/Village-Dusk.svg",
    "archiver/Village-Night.svg",
    "editor/EditorBack-Tao.svg",
    "editor/EditorBack-Drawer.svg",
    "editor/ContentTimeTitleBack-Dawn.svg",
    "editor/ContentTimeTitleBack-StarNight.svg",
    "editor/TimeCloud-Blue.svg",
    "editor/TimeCloud-DarkGrey.svg",
    "editor/TimeCloud-LightGrey.svg",
    "editor/TimeCloud-Red.svg",
    "editor/TimeLOGO-Sovereign.svg",
    "editor/TimeLOGO-Terran.svg",
    "editor/Title-Paper-Editor-Dawn.svg",
    "editor/Title-Paper-Editor-StarNight.svg"
  ]);
  for (const asset of manifest.assets) {
    required.delete(asset.output);
    assert.match(asset.source, /^(?:阅读器美术素材\/(?:Cloudig-Image|AI-Icon)|AIChatArchive\/(?:reader\/assets\/cover|ui\/assets\/archiver|src\/ui\/(?:vendor\/lobe-icons|assets\/platforms)))\//u);
    assert.ok(["copy", "clean-svg", "accepted-derivative", "accepted-window-foreground", "rooster-detail-motion", "stretch-menu-paper", "stretch-title-background"].includes(asset.transform), `unknown derivation: ${asset.output} / ${asset.transform}`);
    const source = await readFile(path.join(root, "..", ...asset.source.split("/")));
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      asset.source_sha256,
      `stale formal source watermark: ${asset.source}`
    );
    const bytes = await readFile(path.join(assetRoot, ...asset.output.split("/")));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.output_sha256);
    if (asset.transform === "stretch-menu-paper") {
      assert.equal(bytes.toString("utf8"), source.toString("utf8").replace("<svg ", '<svg preserveAspectRatio="none" '));
    }
    if (asset.motion_source) {
      const motion = await readFile(path.join(root, "..", ...asset.motion_source.split("/")));
      assert.equal(createHash("sha256").update(motion).digest("hex"), asset.motion_sha256);
    }
  }
  assert.equal(required.size, 0);
  assert.equal(manifest.assets.some((asset: { output: string }) => /\.ai$/iu.test(asset.output)), false);
  assert.equal(manifest.assets.some((asset: { output: string }) => /Cloudig-Reader-Cover-Scene/iu.test(asset.output)), false);
});

test("Only the shared Cloudig ScrollRegion owns native scrollbar presentation", async () => {
  const pageRoot = path.join(shellRoot, "pages");
  const pageCss = (await readdir(pageRoot, { recursive: true }))
    .filter((file) => file.endsWith(".css"));
  assert.ok(pageCss.length > 0);
  for (const file of pageCss) {
    const css = await readFile(path.join(pageRoot, file), "utf8");
    assert.doesNotMatch(css, /::-webkit-scrollbar|scrollbar-(?:color|width)/u, `${file} invented a page-local scrollbar skin`);
    assert.doesNotMatch(css, /box-shadow\s*:/u, `${file} replaced a designed vector or line shadow with box-shadow`);
  }
  const shellCss = await text("shell.css");
  assert.match(shellCss, /\[data-scroll-region\]::?-webkit-scrollbar/u);
  assert.match(shellCss, /--cloudig-scroll-idle:\s*#d3af95;[\s\S]*--cloudig-scroll-active:\s*#d68c80;/u);
  assert.match(shellCss, /data-theme="star-night"[\s\S]*--cloudig-scroll-idle:\s*#3b383c;[\s\S]*--cloudig-scroll-active:\s*#ffa92e;/u);
  assert.doesNotMatch(shellCss, /scrollbar-thumb:is\(:hover, :active\)/u);
  assert.match(shellCss, /::-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*border-box;[^}]*border:\s*0;/u);
  const standardsFallback = shellCss.indexOf("@supports not selector(::-webkit-scrollbar)");
  assert.ok(standardsFallback >= 0, "standards scrollbar-color is fallback-only");
  assert.equal(shellCss.slice(0, standardsFallback).includes("scrollbar-color"), false, "WebView2 must not run two competing scrollbar color systems");
  assert.match(shellCss.slice(standardsFallback), /\[data-scroll-region\]\.cloudig-scroll-operating[\s\S]*var\(--cloudig-scroll-active\)/u);
  assert.doesNotMatch(shellCss, /scrollbar-width:\s*none/u);
  assert.doesNotMatch(shellCss, /scrollbar-gutter:\s*stable/u);
  const shell = await text("shell.js");
  assert.match(shell, /overlayScrollOwners[\s\S]*cloudig-dialog-list[\s\S]*dataset\.scrollRegion/u);
  assert.match(shell, /scrollRegionHit[\s\S]*scrollRegionDragTarget[\s\S]*cloudig-scroll-operating/u);
});
