import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const useTemmlMhchem = args.includes("--temml-mhchem");
const useTemml = args.includes("--temml") || useTemmlMhchem;
const useKatexRuntime = args.includes("--katex-runtime");
const positional = args.filter((arg) => !["--temml", "--temml-mhchem", "--katex-runtime"].includes(arg));

if (args.includes("--temml") && useTemmlMhchem) {
  console.error("--temml 与 --temml-mhchem 只能选择一个");
  process.exit(2);
}

if (positional.length !== 2) {
  console.error("用法：node scripts/build-bookmarklet.mjs <维护源码.js> <单行版.min.js> [--temml|--temml-mhchem] [--katex-runtime]");
  process.exit(2);
}

const inputPath = resolve(projectRoot, positional[0]);
const outputPath = resolve(projectRoot, positional[1]);
const marker = "/*__OSIS_INLINE_TEMML__*/";
const temmlRuntimeMarker = "/*__OSIS_INLINE_TEMML_RUNTIME__*/";
const katexMarker = "/*__OSIS_INLINE_KATEX_RUNTIME__*/";
const katexCssGzipMarker = "/*__OSIS_INLINE_KATEX_CSS_GZIP_BASE64__*/";
const bookmarkUrlCharacterBudget = 480 * 1024;
let source = readFileSync(inputPath, "utf8");
const delimiterMarker = "/*__OSIS_INLINE_MATH_DELIMITERS__*/";
if (source.includes(delimiterMarker)) {
  source = source.replace(delimiterMarker, () => readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-math-delimiters.js"), "utf8"));
}

function deterministicGzipBase64(value) {
  const payload = gzipSync(Buffer.from(value, "utf8"), { level: 9 });
  payload.fill(0, 4, 8);
  payload[9] = 255;
  return payload.toString("base64");
}

if (useTemml) {
  if (!source.includes(marker)) throw new Error(`${basename(inputPath)} 缺少 ${marker} 构建标记`);
  const temmlVendor = useTemmlMhchem
    ? "temml-render-mhchem-0.13.3.min.js"
    : "temml-render-0.13.3.min.js";
  const temml = readFileSync(resolve(projectRoot, "bookmarklets/vendor", temmlVendor), "utf8").trim();
  source = source.replace(marker, () => `${temml}\n`);
  if (source.includes(temmlRuntimeMarker)) {
    const temmlRuntime = readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-temml-runtime.js"), "utf8").trim();
    source = source.replace(temmlRuntimeMarker, () => `${temmlRuntime}\n`);
  }
} else if (source.includes(marker)) {
  throw new Error(`${basename(inputPath)} 需要 --temml，不能生成缺少公式转换器的书签`);
} else if (source.includes(temmlRuntimeMarker)) {
  throw new Error(`${basename(inputPath)} 需要 --temml，不能生成缺少精确 TeX 运行时的书签`);
}

if (useKatexRuntime) {
  if (!source.includes(katexMarker)) throw new Error(`${basename(inputPath)} 缺少 ${katexMarker} 构建标记`);
  let runtime = readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-katex-runtime.js"), "utf8").trim();
  if (!runtime.includes(katexCssGzipMarker)) throw new Error(`osis-katex-runtime.js 缺少 ${katexCssGzipMarker} 构建标记`);
  const katexCss = readFileSync(resolve(projectRoot, "bookmarklets/vendor/katex-0.18.0.min.css"), "utf8").trim();
  const katexCssGzipBase64 = deterministicGzipBase64(katexCss);
  runtime = runtime.replace(JSON.stringify(katexCssGzipMarker), () => JSON.stringify(katexCssGzipBase64));
  source = source.replace(katexMarker, () => `${runtime}\n`);
} else if (source.includes(katexMarker)) {
  throw new Error(`${basename(inputPath)} 需要 --katex-runtime，不能生成缺少 KaTeX 离线运行时的书签`);
}

const nonce = `${process.pid}-${Date.now()}`;
const projectTmpRoot = resolve(projectRoot, "tmp");
mkdirSync(projectTmpRoot, { recursive: true });
const assembledPath = join(projectTmpRoot, `osis-bookmarklet-${nonce}.js`);
const minifiedPath = join(projectTmpRoot, `osis-bookmarklet-${nonce}.min.js`);
writeFileSync(assembledPath, source, "utf8");

try {
  const terserCli = resolve(projectRoot, "node_modules/terser/bin/terser");
  const terserArgs = [
    assembledPath,
    "--compress",
    "passes=3",
    "--mangle",
    "--output",
    minifiedPath
  ];
  const result = spawnSync(process.execPath, [terserCli, ...terserArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Terser 退出码 ${result.status}`);
  let minified = readFileSync(minifiedPath, "utf8").trim().replace(/[\r\n]+/g, "");
  if (!minified.startsWith("javascript:")) minified = `javascript:${minified}`;
  if (minified.length > bookmarkUrlCharacterBudget) {
    throw new Error(`${basename(outputPath)} ${minified.length} characters exceeds the ${bookmarkUrlCharacterBudget}-character Chrome bookmark URL safety budget`);
  }
  writeFileSync(outputPath, minified, "utf8");
  console.log(`${basename(outputPath)} ${Buffer.byteLength(minified, "utf8")} bytes`);
} finally {
  rmSync(assembledPath, { force: true });
  rmSync(minifiedPath, { force: true });
}
