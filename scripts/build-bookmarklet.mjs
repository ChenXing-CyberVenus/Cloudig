import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { packBookmarkletCss } from "./bookmarklet-static-css.mjs";
import { packTemmlSymbols } from "./bookmarklet-temml-symbols.mjs";
import { packAcornTables } from "./bookmarklet-acorn-tables.mjs";

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
const packedTemmlMarker = "/*__OSIS_PACK_TEMML_SYMBOLS__*/";
const packTemmlData = source.includes(packedTemmlMarker);
if (packTemmlData && (!useTemml || useTemmlMhchem)) throw new Error("Symbol table packing requires the plain Temml runtime");
source = source.replace(packedTemmlMarker, "");
let geminiDependencyNotices = "";
const geminiRichMarker = "/*__OSIS_INLINE_GEMINI_RICH_CONTENT__*/";
if (source.includes(geminiRichMarker)) {
  geminiDependencyNotices = ["marked/LICENSE.md", "parse5/LICENSE", "entities/LICENSE"]
    .map(path => `${path}: ${readFileSync(resolve(projectRoot, "node_modules", path), "utf8")}`)
    .join("\n").replace(/\*\//g, "* /").replace(/\s+/g, " ");
  const { buildSync } = await import("esbuild");
  const markdown = buildSync({
    entryPoints: [resolve(projectRoot, "bookmarklets/vendor/gemini-markdown-entry.js")],
    bundle: true, write: false, platform: "browser", format: "iife",
    globalName: "osisGeminiMarkdown", minify: true, legalComments: "inline"
  }).outputFiles[0].text;
  source = source.replace(geminiRichMarker, () => `${markdown}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-math-delimiters.js"), "utf8")}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-gemini-preview.js"), "utf8")}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-gemini-rich-content.js"), "utf8")}`);
}
const intelligentUiMarker = "/*__OSIS_INLINE_CHATGPT_INTELLIGENT_UI__*/";
const useIntelligentUi = source.includes(intelligentUiMarker);
if (useIntelligentUi) {
  const parser = packAcornTables(readFileSync(resolve(projectRoot, "bookmarklets/vendor/acorn-parser-8.11.3.min.js"), "utf8")).source;
  const basic = readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-chatgpt-basic-ui.js"), "utf8");
  const layout = readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-chatgpt-layout-contract.js"), "utf8");
  source = source.replace(intelligentUiMarker, () => `${parser}\n${basic}\n${layout}\n` + readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-chatgpt-intelligent-ui.js"), "utf8"));
}
const delimiterMarker = "/*__OSIS_INLINE_MATH_DELIMITERS__*/";
const qwenTaskMarker = "/*__OSIS_INLINE_QWEN_TASK_LISTS__*/";
const useQwenTaskLists = source.includes(qwenTaskMarker);
if (useQwenTaskLists) {
  geminiDependencyNotices = `marked/LICENSE.md: ${readFileSync(resolve(projectRoot, "node_modules/marked/LICENSE.md"), "utf8")}`.replace(/\*\//g, "* /").replace(/\s+/g, " ");
  const { buildSync } = await import("esbuild");
  const lexer = buildSync({
    entryPoints: [resolve(projectRoot, "bookmarklets/vendor/qwen-task-list-entry.js")],
    bundle: true, write: false, platform: "browser", format: "iife",
    globalName: "osisQwenMarkdown", minify: true, legalComments: "inline"
  }).outputFiles[0].text;
  source = source.replace(qwenTaskMarker, () => `${lexer}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-qwen-task-lists.js"), "utf8")}`);
}
const grokMarkdownMarker = "/*__OSIS_INLINE_GROK_MARKDOWN__*/";
const grokBotMarker = "/*__OSIS_INLINE_GROK_BOT__*/";
if (source.includes(grokBotMarker)) source = source.replace(grokBotMarker, () => readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-grok-bot.js"), "utf8"));
const useGrokMarkdown = source.includes(grokMarkdownMarker);
if (useGrokMarkdown) {
  geminiDependencyNotices = `marked/LICENSE.md: ${readFileSync(resolve(projectRoot, "node_modules/marked/LICENSE.md"), "utf8")}`.replace(/\*\//g, "* /").replace(/\s+/g, " ");
  const { buildSync } = await import("esbuild");
  const markdown = buildSync({
    entryPoints: [resolve(projectRoot, "bookmarklets/vendor/grok-markdown-entry.js")],
    bundle: true, write: false, platform: "browser", format: "iife",
    globalName: "osisGrokMarkdown", minify: true, legalComments: "inline"
  }).outputFiles[0].text;
  source = source.replace(grokMarkdownMarker, () => `${markdown}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-math-delimiters.js"), "utf8")}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-grok-markdown.js"), "utf8")}`);
}
const doubaoRichMarker = "/*__OSIS_INLINE_DOUBAO_RICH_CONTENT__*/";
if (source.includes(doubaoRichMarker)) {
  geminiDependencyNotices = `marked/LICENSE.md: ${readFileSync(resolve(projectRoot, "node_modules/marked/LICENSE.md"), "utf8")}`.replace(/\*\//g, "* /").replace(/\s+/g, " ");
  const { buildSync } = await import("esbuild");
  const markdown = buildSync({
    entryPoints: [resolve(projectRoot, "bookmarklets/vendor/doubao-markdown-entry.js")],
    bundle: true, write: false, platform: "browser", format: "iife",
    globalName: "osisDoubaoMarkdown", minify: true, legalComments: "inline"
  }).outputFiles[0].text;
  source = source.replace(doubaoRichMarker, () => `${markdown}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-math-delimiters.js"), "utf8")}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-doubao-rich-content.js"), "utf8")}`);
}
const deepseekContentMarker = "/*__OSIS_INLINE_DEEPSEEK_CONTENT__*/";
const kimiRichMarker = "/*__OSIS_INLINE_KIMI_RICH_CONTENT__*/";
if (source.includes(kimiRichMarker)) {
  const { buildSync } = await import("esbuild");
  const zip = buildSync({ entryPoints: [resolve(projectRoot, "bookmarklets/vendor/kimi-archive-entry.js")], bundle: true, write: false, platform: "browser", format: "iife", globalName: "osisKimiZip", minify: true, legalComments: "inline" }).outputFiles[0].text;
  geminiDependencyNotices = `fflate/LICENSE: ${readFileSync(resolve(projectRoot, "node_modules/fflate/LICENSE"), "utf8")}`.replace(/\*\//g, "* /").replace(/\s+/g, " ");
  source = source.replace(kimiRichMarker, () => `${zip}\nconst osisKimiZipRuntimeSource=${JSON.stringify(zip)};\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-kimi-rich-content.js"), "utf8")}`);
}
const mistralWorkMarker = "/*__OSIS_INLINE_MISTRAL_WORK__*/";
if (source.includes(mistralWorkMarker)) {
  const { buildSync } = await import("esbuild");
  const lexer = buildSync({entryPoints:[resolve(projectRoot,"bookmarklets/vendor/mistral-slide-markdown-entry.js")],bundle:true,write:false,platform:"browser",format:"iife",globalName:"osisMistralSlideMarkdown",minify:true,legalComments:"inline"}).outputFiles[0].text;
  const rules = readFileSync(resolve(projectRoot,"bookmarklets/vendor/mistral-slide-rules.json"),"utf8");
  const slides = readFileSync(resolve(projectRoot,"bookmarklets/vendor/osis-mistral-slides.js"),"utf8").replace(JSON.stringify("/*__OSIS_MISTRAL_SLIDE_RULES_GZIP__*/"),()=>JSON.stringify(deterministicGzipBase64(rules)));
  geminiDependencyNotices = `marked/LICENSE.md: ${readFileSync(resolve(projectRoot,"node_modules/marked/LICENSE.md"),"utf8")}`.replace(/\*\//g,"* /").replace(/\s+/g," ");
  source = source.replace(mistralWorkMarker, () => `${lexer}\n${slides}\n${readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-mistral-work.js"), "utf8")}`);
}
if (source.includes(deepseekContentMarker)) {
  source = source.replace(deepseekContentMarker, () => readFileSync(resolve(projectRoot, "bookmarklets/vendor/osis-deepseek-content.js"), "utf8"));
}
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
  const temmlRaw = readFileSync(resolve(projectRoot, "bookmarklets/vendor", temmlVendor), "utf8");
  const packed = packTemmlData ? packTemmlSymbols(temmlRaw) : null;
  const temml = packed ? packed.prelude + packed.source : temmlRaw.trim();
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
source = packBookmarkletCss(source).source;
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
  if (geminiDependencyNotices) minified = `javascript:/*! ${geminiDependencyNotices} */${minified.slice("javascript:".length)}`;
  // The Markdown dependencies contain literal %HH (e.g. /%25/g).
  // Preserve it through javascript: URL byte-percent decoding at click time.
  // Acorn's regexp escape decoder also contains arithmetic like value%32.
  // Protect the JavaScript source, then the bookmark URL decodes it back once.
  if (useGrokMarkdown || useQwenTaskLists || useIntelligentUi) minified = minified.replace(/%([0-9a-f]{2})/gi, "%25$1");
  if (minified.length > bookmarkUrlCharacterBudget) {
    throw new Error(`${basename(outputPath)} ${minified.length} characters exceeds the ${bookmarkUrlCharacterBudget}-character Chrome bookmark URL safety budget`);
  }
  writeFileSync(outputPath, minified, "utf8");
  console.log(`${basename(outputPath)} ${Buffer.byteLength(minified, "utf8")} bytes`);
} finally {
  rmSync(assembledPath, { force: true });
  rmSync(minifiedPath, { force: true });
}
