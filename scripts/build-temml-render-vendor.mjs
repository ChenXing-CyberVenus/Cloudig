import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const TEMML_VERSION = "0.13.3";
const TEMML_INTEGRITY = "sha512-GLNEdf5qBWux3adbOxFus4jlds8nCdEIkkKq99m/4GGTfqnsjlVlK/i371Ux7yYSg/WNmOyAkNT/GJlZoJ0v+w==";
const ESBUILD_VERSION = "0.25.10";
const TERSER_VERSION = "5.44.0";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--mhchem")) {
  throw new Error("用法：node scripts/build-temml-render-vendor.mjs [--mhchem]");
}
const useMhchem = args.includes("--mhchem");
const entryPath = resolve(projectRoot, `bookmarklets/vendor/temml-render${useMhchem ? "-mhchem" : ""}-entry.js`);
const outputPath = resolve(projectRoot, `bookmarklets/vendor/temml-render${useMhchem ? "-mhchem" : ""}-${TEMML_VERSION}.min.js`);
const projectTmpRoot = resolve(projectRoot, "tmp");
mkdirSync(projectTmpRoot, { recursive: true });
const workRoot = mkdtempSync(join(projectTmpRoot, `osis-temml-render${useMhchem ? "-mhchem" : ""}-`));

function run(command, args, cwd = projectRoot) {
  const executable = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : command;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, commandArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} 退出码 ${result.status}`);
  return result.stdout.trim();
}

try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const packed = JSON.parse(run(npm, ["pack", `temml@${TEMML_VERSION}`, "--json", "--pack-destination", workRoot]));
  const artifact = packed[0];
  if (!artifact || artifact.integrity !== TEMML_INTEGRITY) throw new Error("Temml npm 包完整性与固定值不一致");
  const tarball = join(workRoot, artifact.filename);
  run("tar", ["-xf", tarball, "-C", workRoot]);

  const packageRoot = join(workRoot, "package");
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== TEMML_VERSION || metadata.license !== "MIT") throw new Error("Temml 版本或许可证校验失败");
  if (useMhchem) {
    const upstreamMhchemPath = join(packageRoot, "contrib", "mhchem", "mhchem.js");
    const adapterPath = join(packageRoot, "contrib", "mhchem", "osis-mhchem-adapter.js");
    const upstreamMhchem = readFileSync(upstreamMhchemPath, "utf8");
    const macroCalls = upstreamMhchem.match(/temml\.__defineMacro/g) || [];
    if (macroCalls.length !== 8) throw new Error(`Temml mhchem 上游宏注册数量异常：${macroCalls.length}`);
    const adapter = `import defineMacro from "../../src/defineMacro.js";\n${upstreamMhchem.replaceAll("temml.__defineMacro", "defineMacro")}`;
    writeFileSync(adapterPath, adapter, "utf8");
  }
  const packageEntry = join(packageRoot, basename(entryPath));
  const bundledPath = join(workRoot, "temml-render.bundle.js");
  const minifiedPath = join(workRoot, "temml-render.min.js");
  copyFileSync(entryPath, packageEntry);

  run(npx, [
    "--yes", `--package=esbuild@${ESBUILD_VERSION}`, "esbuild", packageEntry,
    "--bundle", "--format=iife", "--global-name=temml", "--platform=browser", "--target=chrome105",
    `--outfile=${bundledPath}`
  ]);
  run(npx, [
    "--yes", `--package=terser@${TERSER_VERSION}`, "terser", bundledPath,
    "--compress", "passes=3", "--mangle", "--output", minifiedPath
  ]);

  const minified = readFileSync(minifiedPath, "utf8").trim().replace(/[\r\n]+/g, "");
  if (!minified.includes("renderToString")) throw new Error("瘦身 Temml 产物缺少公开渲染入口");
  if (useMhchem) {
    const sandbox = {};
    vm.runInNewContext(`${minified};globalThis.__osisTemml=temml;`, sandbox);
    const rendered = sandbox.__osisTemml.renderToString(String.raw`\ce{2H2 + O2 -> 2H2O}`, {
      displayMode: true,
      annotate: true,
      xml: true,
      throwOnError: true,
      trust: false
    });
    if (!rendered.includes("<math") || !rendered.includes("H") || !rendered.includes("O") || !rendered.includes("→")) {
      throw new Error("瘦身 Temml mhchem 产物未正确渲染固定化学方程式");
    }
  }
  writeFileSync(outputPath, minified, "utf8");
  console.log(`${basename(outputPath)} ${Buffer.byteLength(minified, "utf8")} bytes`);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
