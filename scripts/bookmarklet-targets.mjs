import {
  bookmarkletPath,
  legacyBookmarkletPath,
  versionedBookmarkletName
} from "./bookmarklet-layout.mjs";

export const bookmarkSetVersion = "2026.10.02.1";

export const bookmarkletTargets = [
  { id: "deepseek", label: "DeepSeek", version: "2.8.10-light", baselineVersion: "2.8.0", source: bookmarkletPath("stable", "deepseek", "2026-07-14_DeepSeek会话导出HTML书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "deepseek", "2026-07-14_DeepSeek会话导出HTML书签单行版-GPT-5.6-Sol.min.js"), katex: false },
  { id: "chatgpt", label: "ChatGPT", version: "3.7.52-light", baselineVersion: "3.7.2", source: bookmarkletPath("stable", "chatgpt", "2026-07-15_ChatGPT会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "chatgpt", "2026-07-15_ChatGPT会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: false },
  { id: "gemini", label: "Gemini", version: "2.7.12-light", baselineVersion: "2.7.0", source: bookmarkletPath("stable", "gemini", "2026-07-16_Gemini会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "gemini", "2026-07-16_Gemini会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: true },
  { id: "grok", label: "Grok", version: "2.8.10-light", baselineVersion: "2.6.0", source: bookmarkletPath("stable", "grok", "2026-07-16_Grok会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "grok", "2026-07-16_Grok会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: true },
  { id: "doubao", label: "豆包", version: "3.5.7-light", baselineVersion: "3.4.0", source: bookmarkletPath("stable", "doubao", "2026-07-16_豆包会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "doubao", "2026-07-16_豆包会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: true },
  { id: "chatglm", label: "ChatGLM", version: "2.5.12-light", baselineVersion: "2.5.0", source: bookmarkletPath("stable", "chatglm", "2026-07-17_ChatGLM会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "chatglm", "2026-07-17_ChatGLM会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: true },
  { id: "kimi", label: "Kimi", version: "2.9.11-light", baselineVersion: "2.9.0", source: bookmarkletPath("stable", "kimi", "2026-07-17_Kimi会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "kimi", "2026-07-17_Kimi会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: false },
  { id: "mistral", label: "Mistral", version: "2.5.13-light", baselineVersion: "2.5.0", source: bookmarkletPath("stable", "mistral", "2026-07-17_Mistral会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "mistral", "2026-07-17_Mistral会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: true },
  { id: "qwen", label: "Qwen", version: "2.6.14-light", baselineVersion: "2.6.0", source: bookmarkletPath("stable", "qwen", "2026-07-17_Qwen会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "qwen", "2026-07-17_Qwen会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: false },
  { id: "zai", label: "Z.ai", version: "2.7.12-light", baselineVersion: "2.7.0", source: bookmarkletPath("stable", "zai", "2026-07-17_Z.ai会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "zai", "2026-07-17_Z.ai会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: true },
  { id: "yuanbao", label: "腾讯元宝", version: "2.10.10-light", baselineVersion: "2.9.0", source: bookmarkletPath("stable", "yuanbao", "2026-07-17_腾讯元宝会话导出HTML轻量书签-GPT-5.6-Sol.js"), min: bookmarkletPath("stable", "yuanbao", "2026-07-17_腾讯元宝会话导出HTML轻量书签单行版-GPT-5.6-Sol.min.js"), katex: true }
];

export function validateBookmarkSetVersion(value, label = "registry") {
  const match = /^(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])\.(\d+)$/u.exec(String(value));
  if (!match) throw new Error(`${label} bookmark_set_version must use YYYY.MM.DD.N: ${value}`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) {
    throw new Error(`${label} bookmark_set_version is not a valid calendar date: ${value}`);
  }
  return value;
}

export function validateBookmarkletTargets(targets, { expectedCount = 11, readSourceText } = {}) {
  if (!Array.isArray(targets) || targets.length !== expectedCount) {
    throw new Error(`Cloudig expects exactly ${expectedCount} bookmark targets, got ${Array.isArray(targets) ? targets.length : "non-array"}`);
  }

  const seenIds = new Set();
  const seenSources = new Set();
  const seenArtifacts = new Set();
  for (const target of targets) {
    if (!/^[a-z][a-z0-9-]*$/u.test(target?.id || "") || seenIds.has(target.id)) {
      throw new Error(`Invalid or duplicate bookmark target: ${target?.id || "(missing)"}`);
    }
    if (typeof target.source !== "string" || !target.source || seenSources.has(target.source)) {
      throw new Error(`Invalid or duplicate bookmark source: ${target.source || "(missing)"}`);
    }
    if (typeof target.min !== "string" || !target.min || seenArtifacts.has(target.min)) {
      throw new Error(`Invalid or duplicate bookmark artifact: ${target.min || "(missing)"}`);
    }
    if (target.source !== bookmarkletPath("stable", target.id, target.source)
      || target.min !== bookmarkletPath("stable", target.id, target.min)) {
      throw new Error(`${target.label} A-Light files must stay under stable/${target.id}/`);
    }
    seenIds.add(target.id);
    seenSources.add(target.source);
    seenArtifacts.add(target.min);

    if (readSourceText) {
      const sourceText = readSourceText(target);
      const declarations = [...String(sourceText).matchAll(/\bconst VERSION = "([^"]+)";/gu)];
      if (declarations.length !== 1 || declarations[0][1] !== target.version) {
        const actual = declarations.length === 1 ? declarations[0][1] : `${declarations.length} declarations`;
        throw new Error(`${target.label} source VERSION ${actual || "(missing)"} does not exactly match target ${target.version}`);
      }
    }
  }
  return targets;
}

export function frozenName(filename, version) {
  return versionedBookmarkletName(filename, version);
}

export function frozenPath(target, filename, version) {
  return legacyBookmarkletPath(target.id, filename, version);
}
