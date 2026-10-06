import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const configured = process.env.CLOUDIG_DOTNET;
const local = path.join(process.cwd(), "manager", ".cache", "dotnet", "dotnet.exe");
const dotnet = configured && existsSync(configured) ? configured : local;
assert.ok(existsSync(dotnet), "Cloudig .NET 10 SDK was not found");
const node = path.join(process.cwd(), "manager", ".cache", "node-v24.18.0-win-x64", "node.exe");
assert.ok(existsSync(node), "Cloudig fixed Node test runtime was not found");
const packages = path.join(process.env.USERPROFILE ?? "", ".nuget", "packages");
const appLayoutSource = readFileSync("src/desktop/Cloudig.Desktop/AppLayout.cs", "utf8");
const dataRootPolicySource = readFileSync("src/desktop/Cloudig.Desktop.Core/CloudigDataRootPolicy.cs", "utf8");
const mainWindowSource = readFileSync("src/desktop/Cloudig.Desktop/MainWindow.xaml.cs", "utf8");
const mainWindowMarkup = readFileSync("src/desktop/Cloudig.Desktop/MainWindow.xaml", "utf8");
const desktopProject = readFileSync("src/desktop/Cloudig.Desktop/Cloudig.Desktop.csproj", "utf8");
const taskbarIcon = readFileSync("src/desktop/Cloudig.Desktop/Assets/Cloudig-Taskbar.ico");
const testLauncher = readFileSync("启动当前采云测试版.cmd", "utf8");
assert.doesNotMatch(appLayoutSource, /Environment\.SpecialFolder\.LocalApplicationData/u);
assert.match(appLayoutSource, /Path\.Combine\(dataRoots\.CacheRoot, "WebView2"\)/u);
assert.match(appLayoutSource, /"--data-root"/u);
assert.match(appLayoutSource, /CloudigDataRootPolicy\.Resolve\(root, dataRootArgument, libraryArgument, visualAudit\?\.OutputFile\)/u);
assert.match(dataRootPolicySource, /Path\.Combine\(libraryRoot, "appdata"\)/u);
assert.doesNotMatch(dataRootPolicySource, /Path\.Combine\([^\n]*"(?:Library|Device|Cloudig)"/u);
assert.match(appLayoutSource, /CloudigProgramLayout\.Resolve\(Environment\.ProcessPath/u);
assert.match(appLayoutSource, /Path\.Combine\(program\.App, "engine", "engine\.mjs"\)/u);
assert.match(mainWindowSource, /RecordStartupBoundary\.InitializeAsync/u);
assert.match(testLauncher, /artifacts\\v1-desktop\\app\\Cloudig\.exe/u);
assert.match(testLauncher, /--data-root "%CLOUDIG_TEST_DATA%"/u);
assert.match(mainWindowSource, /WebViewCacheSession\.Create\(_layout\.WebViewUserDataRoot\)/u);
assert.match(mainWindowSource, /CreateAsync\(userDataFolder: _webViewCache\.ProfileRoot,/u);
assert.match(mainWindowSource, /await _browserExited\.Task\.WaitAsync/u);
assert.doesNotMatch(mainWindowSource, /Path\.Combine\(_layout\.DeviceRoot, "WebView2"\)/u);
assert.match(mainWindowSource, /const double margin = 24;/u);
assert.match(mainWindowSource, /var scale = Math\.Min\(1, Math\.Min\(/u);
assert.match(mainWindowSource, /Width = Math\.Min\(area\.Width, 1920 \* scale\);/u);
assert.match(mainWindowSource, /Height = Math\.Min\(area\.Height, 1080 \* scale \+ title\);/u);
assert.match(mainWindowSource, /scale = Math\.Max\(2d \/ 3d, scale\);/u);
assert.match(mainWindowSource, /WebView\.SizeChanged \+=/u);
assert.match(mainWindowSource, /ViewportScale\.ForClient\(WebView\.ActualWidth, WebView\.ActualHeight\)/u);
assert.match(mainWindowSource, /WebView\.ZoomFactor = scale/u);
assert.match(mainWindowSource, /cloudig-build=/u);
assert.doesNotMatch(mainWindowSource, /WebView\.ZoomFactor = 1;/u);
assert.match(appLayoutSource, /auditWidth is < 1280 or > 7680/u);
assert.match(mainWindowSource, /ShowActivated = false;/u);
assert.match(mainWindowSource, /ShowInTaskbar = false;/u);
assert.match(mainWindowSource, /Left = SystemParameters\.VirtualScreenLeft - Width - 64;/u);
assert.match(mainWindowMarkup, /Icon="Assets\/Cloudig-Taskbar\.ico"/u);
assert.match(desktopProject, /<ApplicationIcon>Assets\\Cloudig-Taskbar\.ico<\/ApplicationIcon>/u);
assert.match(desktopProject, /<Resource Include="Assets\\Cloudig-Taskbar\.ico"\s*\/>/u);
assert.equal(taskbarIcon.readUInt16LE(0), 0);
assert.equal(taskbarIcon.readUInt16LE(2), 1);
assert.equal(taskbarIcon.readUInt16LE(4), 9);

const bookmarkPackageTest = spawnSync(process.execPath, ["--test", "tests/v1/desktop/bookmark-package.test.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});
if (bookmarkPackageTest.status !== 0) throw new Error(`${bookmarkPackageTest.stdout}\n${bookmarkPackageTest.stderr}`);

function run(args) {
  const result = spawnSync(dotnet, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const property = `-p:RestorePackagesPath=${packages}`;
run(["build", "src/desktop/Cloudig.Desktop/Cloudig.Desktop.csproj", "-c", "Debug", property, "--nologo"]);
const output = run(["run", "--project", "src/desktop/Cloudig.Desktop.Tests/Cloudig.Desktop.Tests.csproj", "-c", "Debug", property, "--", node]);
assert.match(output, /Cloudig desktop core checks passed\./u);

console.log(JSON.stringify({ sdk: "10.0.302", webview2: "1.0.4078.44", node: "24.18.0", checks: 27, viewportScalingChecks: 7 }));
