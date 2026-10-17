#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const readerRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(readerRoot, "src");
const vendorRoot = path.join(readerRoot, "vendor");
const assetRoot = path.join(readerRoot, "assets");
const DEFAULT_OUTPUT_PATH = path.join(readerRoot, "reader.html");
const MAX_LIBRARY_FILES = 20_000;
const MAX_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 48 * 1024 * 1024;
const require = createRequire(import.meta.url);
const cloudigLibraryCore = require("../library/core.js");
const readerCore = require(path.join(sourceRoot, "core.js"));

function parseArguments(argv) {
  const options = { outputPath: DEFAULT_OUTPUT_PATH, libraryDir: null, desktopCatalog: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--desktop-catalog") {
      options.desktopCatalog = true;
    } else if (argument === "--output" || argument === "--library-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      if (argument === "--output") options.outputPath = path.resolve(value);
      else options.libraryDir = path.resolve(value);
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.desktopCatalog && !options.libraryDir) {
    throw new Error("--desktop-catalog requires --library-dir");
  }
  return options;
}

async function readInlinedKatexStaticCss() {
  const cssPath = path.join(vendorRoot, "katex", "katex-static-0.18.0.min.css");
  let css = await readFile(cssPath, "utf8");
  const references = [...new Set([...css.matchAll(/url\((?:["']?)(\.\/fonts\/[A-Za-z0-9._-]+\.woff2)(?:["']?)\)/gu)]
    .map((match) => match[1]))];
  if (references.length !== 12) {
    throw new Error(`KaTeX static CSS must reference exactly 12 audited WOFF2 files, received ${references.length}`);
  }
  for (const reference of references) {
    const bytes = await readFile(path.resolve(path.dirname(cssPath), ...reference.split("/")));
    const dataUrl = `data:font/woff2;base64,${bytes.toString("base64")}`;
    css = css.replaceAll(`url(${reference})`, `url(${dataUrl})`)
      .replaceAll(`url("${reference}")`, `url("${dataUrl}")`)
      .replaceAll(`url('${reference}')`, `url('${dataUrl}')`);
  }
  if (/url\((?!["']?data:font\/woff2;base64,)/u.test(css)) {
    throw new Error("KaTeX static CSS retained a non-embedded URL");
  }
  if ((css.match(/@font-face/gu) || []).length !== 12 || (css.match(/data:font\/woff2;base64,/gu) || []).length !== 12) {
    throw new Error("KaTeX static CSS did not inline all 12 audited font faces");
  }
  return css;
}

async function readEmbeddedLibrary(libraryDir, { includeConversations = true } = {}) {
  if (!libraryDir) return [];
  const files = [];
  async function visit(directory, relativeRoot = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Embedded library cannot contain symlinks: ${path.join(directory, entry.name)}`);
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeRoot, entry.name).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        if (includeConversations) await visit(absolute, relative);
      }
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".json") {
        const normalizedRelative = `/${relative.replaceAll("\\", "/").toLowerCase()}/`;
        if (normalizedRelative.includes("/inbox/") || normalizedRelative.includes("/data/")) continue;
        const information = await lstat(absolute);
        const fileTimes = {
          modified_at: information.mtime.toISOString(),
          created_at: information.birthtime.toISOString()
        };
        const serialized = await readFile(absolute, "utf8");
        const isLibraryFile = entry.name.toLowerCase() === cloudigLibraryCore.FILE_NAME;
        let document;
        try {
          document = JSON.parse(serialized);
        } catch {
          files.push({
            kind: isLibraryFile ? "invalid_library" : "invalid_conversation",
            name: entry.name,
            relative_path: relative,
            bytes: Buffer.byteLength(serialized),
            sha256: createHash("sha256").update(serialized).digest("hex"),
            parse_error: "invalid_json",
            serialized: ""
          });
          if (files.length > MAX_LIBRARY_FILES) throw new Error(`Embedded library exceeds ${MAX_LIBRARY_FILES} JSON files`);
          continue;
        }
        if (isLibraryFile) {
          try {
            cloudigLibraryCore.assertLibrary(document);
          } catch {
            files.push({
              kind: "invalid_library",
              name: entry.name,
              relative_path: relative,
              bytes: Buffer.byteLength(serialized),
              sha256: createHash("sha256").update(serialized).digest("hex"),
              parse_error: "invalid_json",
              serialized: ""
            });
            if (files.length > MAX_LIBRARY_FILES) throw new Error(`Embedded library exceeds ${MAX_LIBRARY_FILES} JSON files`);
            continue;
          }
        } else {
          const compatibility = readerCore.conversationCompatibility(document);
          if (compatibility.supported) {
            try {
              readerCore.assertConversation(document);
            } catch (error) {
              if (error?.name !== "ConversationValidationError") throw error;
              files.push({
                kind: "invalid_conversation",
                name: entry.name,
                relative_path: relative,
                bytes: Buffer.byteLength(serialized),
                sha256: createHash("sha256").update(serialized).digest("hex"),
                schema: compatibility.schema,
                parser_version: compatibility.parser_version,
                reader_version: compatibility.reader_version,
                parse_error: "invalid_conversation",
                serialized: ""
              });
              if (files.length > MAX_LIBRARY_FILES) throw new Error(`Embedded library exceeds ${MAX_LIBRARY_FILES} JSON files`);
              continue;
            }
          } else if (readerCore.SCHEMAS.has(compatibility.schema)) {
            files.push({
              kind: "invalid_conversation",
              name: entry.name,
              relative_path: relative,
              bytes: Buffer.byteLength(serialized),
              sha256: createHash("sha256").update(serialized).digest("hex"),
              schema: compatibility.schema,
              parser_version: compatibility.parser_version,
              reader_version: compatibility.reader_version,
              parse_error: "invalid_conversation",
              serialized: ""
            });
            if (files.length > MAX_LIBRARY_FILES) throw new Error(`Embedded library exceeds ${MAX_LIBRARY_FILES} JSON files`);
            continue;
          }
        }
        const kind = isLibraryFile ? "library" : "conversation";
        files.push({
          kind,
          name: entry.name,
          relative_path: relative,
          ...fileTimes,
          bytes: Buffer.byteLength(serialized),
          sha256: createHash("sha256").update(serialized).digest("hex"),
          schema_supported: kind === "conversation"
            ? readerCore.conversationCompatibility(document).supported
            : undefined,
          serialized
        });
        if (files.length > MAX_LIBRARY_FILES) throw new Error(`Embedded library exceeds ${MAX_LIBRARY_FILES} JSON files`);
      }
    }
  }
  await visit(libraryDir);
  const libraryEntry = files
    .filter((entry) => entry.kind === "library" || entry.kind === "invalid_library")
    .sort((left, right) => left.relative_path.split(/[\\/]/u).length - right.relative_path.split(/[\\/]/u).length)[0];
  if (libraryEntry) {
    const normalizedLibraryPath = libraryEntry.relative_path.replaceAll("\\", "/");
    const slash = normalizedLibraryPath.lastIndexOf("/");
    const rootPrefix = slash < 0 ? "" : normalizedLibraryPath.slice(0, slash);
    const conversationPrefix = `${rootPrefix ? `${rootPrefix}/` : ""}Conversations/`.toLowerCase();
    const selected = files.filter((entry) => entry === libraryEntry
      || (["conversation", "invalid_conversation"].includes(entry.kind)
        && entry.relative_path.replaceAll("\\", "/").toLowerCase().startsWith(conversationPrefix)));
    if (libraryEntry.kind === "library") {
      const library = cloudigLibraryCore.normalizeLibrary(JSON.parse(libraryEntry.serialized));
      const references = [...new Set([
        library.user?.avatar,
        library.assistant?.avatar,
        library.project?.icon,
        library.project?.cover?.path,
        ...Object.values(library.platform_overrides || {}).flatMap((value) => [
          value?.icon,
          value?.assistant_avatar
        ])
      ].filter(Boolean))];
      const libraryRoot = path.dirname(path.resolve(libraryDir, ...normalizedLibraryPath.split("/")));
      const realLibraryRoot = await realpath(libraryRoot);
      let assetBytes = 0;
      for (const relativePath of references) {
        const absolute = path.resolve(libraryRoot, ...relativePath.split("/"));
        let information;
        try { information = await lstat(absolute); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
        if (information.isSymbolicLink()) throw new Error(`Embedded library asset cannot be a symlink: ${relativePath}`);
        if (!information.isFile() || information.size < 1 || information.size > MAX_ASSET_BYTES) continue;
        const resolved = await realpath(absolute);
        if (!resolved.startsWith(`${realLibraryRoot}${path.sep}`)) throw new Error(`Embedded library asset escaped its library: ${relativePath}`);
        const bytes = await readFile(resolved);
        const mimeType = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          ? "image/png"
          : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            ? "image/jpeg"
            : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
              ? "image/gif"
              : bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
                ? "image/webp" : "";
        if (!mimeType) continue;
        assetBytes += bytes.length;
        if (assetBytes > MAX_ASSET_TOTAL_BYTES) throw new Error(`Embedded library assets exceed ${MAX_ASSET_TOTAL_BYTES} bytes`);
        selected.push({
          kind: "asset",
          name: path.basename(relativePath),
          relative_path: relativePath,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mime_type: mimeType,
          data_url: `data:${mimeType};base64,${bytes.toString("base64")}`
        });
      }
    }
    files.length = 0;
    files.push(...selected);
  }
  if (!files.length) throw new Error(`Embedded library contains no JSON files: ${libraryDir}`);
  return files;
}

const options = parseArguments(process.argv.slice(2));
const outputPath = options.outputPath;
const embeddedLibrary = await readEmbeddedLibrary(options.libraryDir, {
  includeConversations: !options.desktopCatalog
});

const files = {
  template: path.join(sourceRoot, "index.html"),
  tokens: path.join(readerRoot, "..", "ui", "tokens", "cloudig-tokens.css"),
  foundation: path.join(readerRoot, "..", "ui", "components", "cloudig-foundation.css"),
  docsCss: path.join(readerRoot, "..", "ui", "components", "cloudig-docs.css"),
  tooltip: path.join(readerRoot, "..", "ui", "runtime", "tooltip.js"),
  docsRuntime: path.join(readerRoot, "..", "ui", "runtime", "docs.js"),
  docsData: path.join(readerRoot, "..", "ui", "content", "cloudig-docs.json"),
  css: path.join(sourceRoot, "reader.css"),
  coverCss: path.join(sourceRoot, "reader-cover.css"),
  markdownIt: path.join(vendorRoot, "markdown-it-14.3.0.min.js"),
  temml: path.join(vendorRoot, "temml-render-0.13.3.min.js"),
  temmlRuntime: path.join(vendorRoot, "osis-temml-runtime.js"),
  libraryCore: path.join(readerRoot, "..", "library", "core.js"),
  i18n: path.join(sourceRoot, "i18n.js"),
  timeLimits: path.join(readerRoot, "..", "time", "limits-1.0.0.json"),
  timeCore: path.join(readerRoot, "..", "time", "core.js"),
  core: path.join(sourceRoot, "core.js"),
  coverApp: path.join(sourceRoot, "reader-cover.js"),
  app: path.join(sourceRoot, "reader.js")
};

const [template, tokens, foundation, docsCss, tooltip, docsRuntime, docsData, css, coverCss, markdownIt, temml, temmlRuntime, libraryCore, i18n, timeLimits, timeCore, core, coverApp, app, katexStaticCss] = await Promise.all([
  ...Object.values(files).map((file) => readFile(file, "utf8")),
  readInlinedKatexStaticCss()
]);

const fixedReaderAssetFiles = {
  "brand.cloudig_logo": ["brand", "OsisLogo-Cloudig-RedBackWhiteAbyss-1024.png"],
  "brand.seal": ["brand", "OsisLogo-Simple-Mono-Red-1024.png"],
  "brand.waiting_sun": ["brand", "Waiting-Sun.gif"],
  "brand.theme_switch": ["brand", "OsisLogo-Simple-Mono-Red-1024.png"],
  "brand.title_zh": ["brand", "Cloudig-Title-Chinese-Grey-1024.png"],
  "brand.slogan_zh": ["brand", "Cloudig-Slogan-Chinese-Grey-1024.png"],
  "avatar.doubao": ["avatars", "doubao-avatar.png"],
  "platform.chatgpt": ["platforms", "openai.svg"],
  "platform.claude": ["platforms", "claude.svg"],
  "platform.gemini": ["platforms", "gemini-color.svg"],
  "platform.grok": ["platforms", "grok.svg"],
  "platform.deepseek": ["platforms", "deepseek-color.svg"],
  "platform.doubao": ["platforms", "doubao-color.svg"],
  "platform.qwen": ["platforms", "qwen-color.svg"],
  "platform.chatglm": ["platforms", "qingyan-color.svg"],
  "platform.yuanbao": ["platforms", "yuanbao-color.svg"],
  "platform.zai": ["platforms", "zai.svg"],
  "platform.kimi": ["platforms", "kimi-color.svg"],
  "platform.mistral": ["platforms", "mistral-color.svg"]
};
const coverAssetEntries = (await readdir(path.join(assetRoot, "cover"), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && [".png", ".svg"].includes(path.extname(entry.name).toLowerCase()))
  .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }))
  .map((entry) => [`cover.${entry.name}`, ["cover", entry.name]]);
const readerAssetFiles = Object.freeze({ ...fixedReaderAssetFiles, ...Object.fromEntries(coverAssetEntries) });
const readerAssets = Object.fromEntries(await Promise.all(Object.entries(readerAssetFiles).map(async ([key, segments]) => {
  const file = path.join(assetRoot, ...segments);
  const bytes = await readFile(file);
  const extension = path.extname(file).toLowerCase();
  const mimeType = extension === ".svg" ? "image/svg+xml" : extension === ".gif" ? "image/gif" : "image/png";
  return [key, `data:${mimeType};base64,${bytes.toString("base64")}`];
})));

function scriptSafe(value) {
  return String(value).replace(/<\/script/giu, "<\\/script");
}

function styleSafe(value) {
  return String(value).replace(/<\/style/giu, "<\\/style");
}

const replacements = new Map([
  ["/*__READER_CSS__*/", styleSafe(`${katexStaticCss}\n${tokens}\n${foundation}\n${css}\n${coverCss}\n${docsCss}`)],
  ["/*__CLOUDIG_TOOLTIP__*/", scriptSafe(tooltip)],
  ["/*__CLOUDIG_DOCS_RUNTIME__*/", scriptSafe(docsRuntime)],
  ["/*__CLOUDIG_DOCS_DATA__*/", scriptSafe(docsData)],
  ["/*__MARKDOWN_IT__*/", scriptSafe(markdownIt)],
  ["/*__TEMML_VENDOR__*/", scriptSafe(temml)],
  ["/*__TEMML_RUNTIME__*/", scriptSafe(temmlRuntime)],
  ["/*__CLOUDIG_LIBRARY_CORE__*/", scriptSafe(libraryCore)],
  ["/*__READER_I18N__*/", scriptSafe(i18n)],
  ["/*__CLOUDIG_TIME_LIMITS__*/", scriptSafe(timeLimits.trim())],
  ["/*__CLOUDIG_TIME_CORE__*/", scriptSafe(timeCore)],
  ["/*__READER_CORE__*/", scriptSafe(core)],
  ["/*__READER_ASSETS__*/", scriptSafe(JSON.stringify(readerAssets))],
  ["/*__READER_BUILD_MODE__*/", scriptSafe(JSON.stringify(options.desktopCatalog ? "desktop_catalog" : "portable"))],
  ["/*__EMBEDDED_LIBRARY__*/", scriptSafe(JSON.stringify(embeddedLibrary))],
  ["/*__READER_COVER_APP__*/", scriptSafe(coverApp)],
  ["/*__READER_APP__*/", scriptSafe(app)]
]);

let output = template;
for (const [token, value] of replacements) {
  if (!output.includes(token)) throw new Error(`Reader template token missing: ${token}`);
  output = output.replace(token, () => value);
}
if (/\/\*__[A-Z_]+__\*\//u.test(output)) throw new Error("Reader template still contains unresolved tokens.");
output = `${output.trimEnd()}\n`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");
const sha256 = createHash("sha256").update(output).digest("hex");
process.stdout.write(`${JSON.stringify({
  ok: true,
  version: readerCore.READER_VERSION,
  mode: options.desktopCatalog ? "desktop_catalog" : "portable",
  output: path.relative(process.cwd(), outputPath).replaceAll(path.sep, "/"),
  bytes: Buffer.byteLength(output),
  sha256,
  embedded: {
    markdown_it: "14.3.0",
    temml: "0.13.3",
    katex_static_css: "0.18.0",
    katex_font_faces: 12,
    library_files: embeddedLibrary.filter((file) => file.kind !== "asset").length,
    library_bytes: embeddedLibrary.filter((file) => file.kind !== "asset").reduce((sum, file) => sum + file.bytes, 0),
    asset_files: embeddedLibrary.filter((file) => file.kind === "asset").length,
    asset_bytes: embeddedLibrary.filter((file) => file.kind === "asset").reduce((sum, file) => sum + file.bytes, 0)
  }
}, null, 2)}\n`);
