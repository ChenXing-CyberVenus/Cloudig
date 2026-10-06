import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

if (process.platform !== "win32") {
  console.log(JSON.stringify({ skipped: true, reason: "Cloudig fixed-EXE visual audit requires Windows" }));
  process.exit(0);
}

const packageRoot = path.join(process.cwd(), "artifacts", "v1-desktop", "app");
const executable = path.join(packageRoot, "Cloudig.exe");
await stat(executable);
const temporaryParent = path.join(process.cwd(), "tmp");
await mkdir(temporaryParent, { recursive: true });
const scope = await mkdtemp(path.join(temporaryParent, "cloudig-fixed-visual-"));
const output = path.join(scope, "welcome-dawn-1280.png");
const errorFile = path.join(scope, "welcome-dawn-1280.error.txt");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function run() {
  const child = spawn(executable, [
    "--library-root", path.join(scope, "Library"),
    "--visual-audit-output", output,
    "--visual-audit-query", "screenshot=1&fixture=sample&route=welcome&theme=dawn&language=zh-CN&phase=start",
    "--visual-audit-width", "1280",
    "--visual-audit-height", "720"
  ], { stdio: "ignore", windowsHide: false });
  let timer;
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error("Cloudig fixed-EXE visual audit timed out"));
    }, 30_000);
  });
  try {
    const result = await Promise.race([exit, timeout]);
    assert.equal(result.signal, null, `Cloudig visual audit exited by ${result.signal}`);
    assert.equal(result.code, 0, `Cloudig visual audit failed${await readFile(errorFile, "utf8").then((value) => `: ${value.trim()}`).catch(() => "")}`);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await run();
  const png = await readFile(output);
  const manifest = JSON.parse(await readFile(output.replace(/\.png$/u, ".json"), "utf8"));
  const executableBytes = await readFile(executable);
  assert.equal(manifest.schema, "cloudig/visual-audit-run/1.0.0");
  assert.deepEqual(manifest.requested_viewport, { width: 1280, height: 720 });
  assert.equal(manifest.executable.sha256, sha256(executableBytes));
  assert.equal(manifest.png.bytes, png.byteLength);
  assert.equal(manifest.png.sha256, sha256(png));
  assert.equal(manifest.page.ready, true);
  assert.equal(manifest.page.route, "welcome");
  assert.equal(manifest.page.theme, "dawn");
  assert.equal(manifest.page.language, "zh-CN");
  assert.equal(manifest.page.width, 1280);
  assert.equal(manifest.page.height, 720);
  assert.equal(manifest.page.fonts, "loaded");
  assert.equal(manifest.page.images, true);
  assert.equal(manifest.page.transition, false);
  assert.equal(manifest.page.body_scroll_width, manifest.page.body_client_width);
  assert.equal(manifest.page.body_scroll_height, manifest.page.body_client_height);
  assert.ok(manifest.png.pixel_width >= 1280 && manifest.png.pixel_height >= 720);
  assert.ok(Math.abs(manifest.png.pixel_width / 1280 - manifest.png.dpi_scale_x) < .01);
  assert.ok(Math.abs(manifest.png.pixel_height / 720 - manifest.png.dpi_scale_y) < .01);
  console.log(JSON.stringify({
    executable_sha256: manifest.executable.sha256,
    css_viewport: manifest.requested_viewport,
    pixel_viewport: { width: manifest.png.pixel_width, height: manifest.png.pixel_height },
    dpi_scale: { x: manifest.png.dpi_scale_x, y: manifest.png.dpi_scale_y },
    png_bytes: manifest.png.bytes
  }));
} finally {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(scope, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
