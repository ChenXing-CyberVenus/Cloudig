export const bookmarkletStates = Object.freeze(["stable", "candidate", "legacy"]);

export const bookmarkletPlatforms = Object.freeze([
  "chatgpt",
  "deepseek",
  "gemini",
  "grok",
  "doubao",
  "chatglm",
  "kimi",
  "mistral",
  "qwen",
  "zai",
  "yuanbao",
  "claude"
]);

const stateSet = new Set(bookmarkletStates);
const platformSet = new Set(bookmarkletPlatforms);

function leafName(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/");
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!filename || filename === "." || filename === ".." || filename.includes("/")) {
    throw new Error(`Invalid bookmarklet filename: ${filePath}`);
  }
  return filename;
}

export function bookmarkletPath(state, platform, filePath) {
  if (!stateSet.has(state)) throw new Error(`Unknown bookmarklet state: ${state}`);
  if (!platformSet.has(platform)) throw new Error(`Unknown bookmarklet platform: ${platform}`);
  return `${state}/${platform}/${leafName(filePath)}`;
}

export function versionedBookmarkletName(filePath, version) {
  const filename = leafName(filePath);
  if (!version || !filename.includes("-GPT-5.6-Sol")) {
    throw new Error(`Cannot freeze bookmarklet filename: ${filePath}`);
  }
  return filename.replace("-GPT-5.6-Sol", `-${version}-GPT-5.6-Sol`);
}

export function legacyBookmarkletPath(platform, filePath, version) {
  return bookmarkletPath("legacy", platform, versionedBookmarkletName(filePath, version));
}

function claudeVariant(state, profile, version, source, min) {
  return Object.freeze({
    state,
    platform: "claude",
    profile,
    version,
    source: bookmarkletPath(state, "claude", source),
    min: bookmarkletPath(state, "claude", min)
  });
}

export const claudeLayoutVariants = Object.freeze([
  claudeVariant(
    "stable",
    "light",
    "1.0.3-light",
    "2026-07-27_Claude会话导出HTML轻量书签-1.0.3-light-GPT-5.6-Sol.js",
    "2026-07-27_Claude会话导出HTML轻量书签单行版-1.0.3-light-GPT-5.6-Sol.min.js"
  ),
  claudeVariant(
    "stable",
    "full",
    "1.0.8-full",
    "2026-07-27_Claude会话导出HTML全量取证书签-1.0.8-full-GPT-5.6-Sol.js",
    "2026-07-27_Claude会话导出HTML全量取证书签单行版-1.0.8-full-GPT-5.6-Sol.min.js"
  ),
  claudeVariant(
    "stable",
    "all-branches",
    "1.0.7-all-branches",
    "2026-07-27_Claude会话导出HTML全分支取证书签-1.0.7-all-branches-GPT-5.6-Sol.js",
    "2026-07-27_Claude会话导出HTML全分支取证书签单行版-1.0.7-all-branches-GPT-5.6-Sol.min.js"
  ),
  claudeVariant(
    "candidate",
    "light",
    "1.1.64-light",
    "2026-07-28_Claude会话导出HTML轻量书签-1.1.4-light-GPT-5.6-Sol.js",
    "2026-07-28_Claude会话导出HTML轻量书签单行版-1.1.4-light-GPT-5.6-Sol.min.js"
  )
]);
