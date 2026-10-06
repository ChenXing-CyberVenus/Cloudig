import { bookmarkletPath } from "./bookmarklet-layout.mjs";

export const archiveBookmarkletContract = Object.freeze({
  registrySchema: "ai-chat-archive/archive-bookmarklet-registry-v1",
  manifestSchema: "ai-chat-archive/manifest-v1",
  payloadInterface: "ai-chat-archive/archive-bookmarklet-payload-interface-v1",
  currentPathInterface: "ai-chat-archive/archive-bookmarklet-current-path-v1",
  bookmarkUrlCharacterBudget: 480 * 1024
});

const branchCapablePlatforms = new Set([
  "chatgpt",
  "deepseek",
  "grok",
  "kimi",
  "qwen",
  "zai",
  "mistral",
  "claude"
]);
const platformLabels = new Map([
  ["chatgpt", "ChatGPT"],
  ["deepseek", "DeepSeek"],
  ["gemini", "Gemini"],
  ["grok", "Grok"],
  ["doubao", "豆包"],
  ["chatglm", "ChatGLM"],
  ["kimi", "Kimi"],
  ["mistral", "Mistral"],
  ["qwen", "Qwen"],
  ["zai", "Z.ai"],
  ["yuanbao", "腾讯元宝"],
  ["claude", "Claude"]
]);

function planned(platform, profile) {
  return Object.freeze({
    id: `${platform}:${profile}`,
    platform,
    label: platformLabels.get(platform),
    profile,
    status: "planned",
    version: null,
    source: null,
    min: null,
    platformPayloadSchema: null,
    buildFlags: Object.freeze([]),
    currentPathGate: Object.freeze({
      interface: archiveBookmarkletContract.currentPathInterface,
      pairKey: `${platform}/current-path-v1`
    }),
    plannedReason: "尚未完成实页取证、实现与回归；不得构建或宣称可用"
  });
}
function ready(platform, profile, {
  version,
  source,
  min,
  platformPayloadSchema,
  buildFlags,
  platformPayloadConstant = "PLATFORM_SCHEMA"
}) {
  return Object.freeze({
    id: `${platform}:${profile}`,
    platform,
    label: platformLabels.get(platform),
    profile,
    status: "ready",
    version,
    source: bookmarkletPath("candidate", platform, source),
    min: bookmarkletPath("candidate", platform, min),
    platformPayloadSchema,
    platformPayloadConstant,
    buildFlags: Object.freeze(buildFlags),
    currentPathGate: Object.freeze({
      interface: archiveBookmarkletContract.currentPathInterface,
      pairKey: `${platform}/current-path-v1`
    }),
    plannedReason: null
  });
}

export const archiveBookmarkletTargets = Object.freeze([
  ready("chatgpt", "full", {
    version: "1.0.49-full",
    source: "2026-07-28_ChatGPT会话导出HTML全量书签-1.0.49-full-GPT-5.6-Sol.js",
    min: "2026-07-28_ChatGPT会话导出HTML全量书签单行版-1.0.49-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.chatgpt.chat-export/full-v1",
    buildFlags: ["--temml"]
  }),
  ready("chatgpt", "all-branches", {
    version: "1.0.49-all-branches",
    source: "2026-07-28_ChatGPT会话导出HTML整树书签-1.0.49-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_ChatGPT会话导出HTML整树书签单行版-1.0.49-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.chatgpt.chat-export/all-branches-v1",
    buildFlags: ["--temml"]
  }),
  ready("deepseek", "full", {
    version: "1.0.7-full",
    source: "2026-07-28_DeepSeek会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_DeepSeek会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.deepseek.chat-export/full-v1",
    buildFlags: ["--temml"]
  }),
  ready("deepseek", "all-branches", {
    version: "1.0.8-all-branches",
    source: "2026-07-28_DeepSeek会话导出HTML全分支书签-1.0.1-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_DeepSeek会话导出HTML全分支书签单行版-1.0.1-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.deepseek.chat-export/all-branches-v1",
    buildFlags: ["--temml"]
  }),
  ready("gemini", "full", {
    version: "1.0.8-full",
    source: "2026-07-28_Gemini会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_Gemini会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.gemini.chat-export/full-v1",
    platformPayloadConstant: "SCHEMA",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("grok", "full", {
    version: "1.0.8-full",
    source: "2026-07-28_Grok会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_Grok会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.grok.chat-export/full-v1",
    platformPayloadConstant: "SCHEMA",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("grok", "all-branches", {
    version: "1.0.10-all-branches",
    source: "2026-07-28_Grok会话导出HTML全分支书签-1.0.1-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_Grok会话导出HTML全分支书签单行版-1.0.1-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.grok.chat-export/all-branches-v1",
    platformPayloadConstant: "SCHEMA",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("doubao", "full", {
    version: "1.0.5-full",
    source: "2026-07-28_豆包会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_豆包会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.doubao.chat-export/full-dom-v1",
    platformPayloadConstant: "SCHEMA",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("chatglm", "full", {
    version: "1.0.8-full",
    source: "2026-07-28_ChatGLM会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_ChatGLM会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.chatglm.chat-export/full-v1",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("kimi", "full", {
    version: "1.0.7-full",
    source: "2026-07-28_Kimi会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_Kimi会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.kimi.chat-export/full-dom-v1",
    platformPayloadConstant: "SCHEMA",
    buildFlags: ["--temml"]
  }),
  ready("kimi", "all-branches", {
    version: "1.0.7-all-branches",
    source: "2026-07-28_Kimi会话导出HTML全分支书签-1.0.1-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_Kimi会话导出HTML全分支书签单行版-1.0.1-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.kimi.chat-export/all-branches-v1",
    platformPayloadConstant: "SCHEMA",
    buildFlags: ["--temml"]
  }),
  ready("mistral", "full", {
    version: "1.0.9-full",
    source: "2026-07-28_Mistral会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_Mistral会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.mistral.chat-export/full-v1",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("mistral", "all-branches", {
    version: "1.0.9-all-branches",
    source: "2026-07-28_Mistral会话导出HTML全分支书签-1.0.1-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_Mistral会话导出HTML全分支书签单行版-1.0.1-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.mistral.chat-export/all-branches-v1",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("qwen", "full", {
    version: "1.0.11-full",
    source: "2026-07-28_Qwen会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_Qwen会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.qwen.chat-export/full-v1",
    buildFlags: ["--temml"]
  }),
  ready("qwen", "all-branches", {
    version: "1.0.11-all-branches",
    source: "2026-07-28_Qwen会话导出HTML全分支书签-1.0.1-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_Qwen会话导出HTML全分支书签单行版-1.0.1-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.qwen.chat-export/all-branches-v1",
    buildFlags: ["--temml"]
  }),
  ready("zai", "full", {
    version: "1.0.8-full",
    source: "2026-07-28_Z.ai会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_Z.ai会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.zai.chat-export/full-v1",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("zai", "all-branches", {
    version: "1.0.8-all-branches",
    source: "2026-07-28_Z.ai会话导出HTML全分支书签-1.0.1-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_Z.ai会话导出HTML全分支书签单行版-1.0.1-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.zai.chat-export/all-branches-v1",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("yuanbao", "full", {
    version: "1.0.9-full",
    source: "2026-07-28_腾讯元宝会话导出HTML全量书签-1.0.1-full-GPT-5.6-Sol.js",
    min: "2026-07-28_腾讯元宝会话导出HTML全量书签单行版-1.0.1-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.yuanbao.chat-export/full-dom-v1",
    buildFlags: ["--temml", "--katex-runtime"]
  }),
  ready("claude", "full", {
    version: "1.1.64-full",
    source: "2026-07-28_Claude会话导出HTML全量取证书签-1.1.4-full-GPT-5.6-Sol.js",
    min: "2026-07-28_Claude会话导出HTML全量取证书签单行版-1.1.4-full-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.claude.chat-export/full-capture-v1",
    buildFlags: ["--temml-mhchem"]
  }),
  ready("claude", "all-branches", {
    version: "1.1.64-all-branches",
    source: "2026-07-28_Claude会话导出HTML全分支取证书签-1.1.4-all-branches-GPT-5.6-Sol.js",
    min: "2026-07-28_Claude会话导出HTML全分支取证书签单行版-1.1.4-all-branches-GPT-5.6-Sol.min.js",
    platformPayloadSchema: "osis.claude.chat-export/all-branches-v1",
    buildFlags: ["--temml-mhchem"]
  })
]);

export function readyArchiveBookmarkletTargets(targets = archiveBookmarkletTargets) {
  return targets.filter((target) => target.status === "ready");
}

function readConstant(sourceText, constantName, target) {
  const escapedName = constantName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declarations = [...String(sourceText).matchAll(new RegExp(`\\bconst ${escapedName} = "([^"]+)";`, "gu"))];
  if (declarations.length !== 1) {
    throw new Error(`${target.id} source must declare exactly one ${constantName}; got ${declarations.length}`);
  }
  return declarations[0][1];
}

export function validateArchiveCurrentPathPairs(targets = archiveBookmarkletTargets) {
  const byId = new Map(targets.map((target) => [target.id, target]));
  for (const target of targets) {
    if (target.profile !== "all-branches") continue;
    const full = byId.get(`${target.platform}:full`);
    if (!full) throw new Error(`${target.id} has no matching Full target`);
    if (!branchCapablePlatforms.has(target.platform)) {
      throw new Error(`${target.id} is registered for a platform without branch support`);
    }
    if (target.currentPathGate?.interface !== archiveBookmarkletContract.currentPathInterface
      || full.currentPathGate?.interface !== archiveBookmarkletContract.currentPathInterface
      || target.currentPathGate?.pairKey !== full.currentPathGate?.pairKey) {
      throw new Error(`${target.platform} Full/AllBranches current-path gate is not aligned`);
    }
    if (target.status === "ready" && full.status !== "ready") {
      throw new Error(`${target.id} cannot be ready while its matching Full target is not ready`);
    }
  }
  return targets;
}

export function validateArchiveBookmarkletTargets(targets = archiveBookmarkletTargets, {
  readSourceText
} = {}) {
  if (!Array.isArray(targets) || targets.length !== 20) {
    throw new Error(`Archive registry expects exactly 20 targets, got ${Array.isArray(targets) ? targets.length : "non-array"}`);
  }

  const fullTargets = targets.filter((target) => target.profile === "full");
  const allBranchTargets = targets.filter((target) => target.profile === "all-branches");
  if (fullTargets.length !== 12 || allBranchTargets.length !== 8) {
    throw new Error(`Archive registry expects 12 Full and 8 AllBranches targets; got ${fullTargets.length} and ${allBranchTargets.length}`);
  }

  const seenIds = new Set();
  const seenSources = new Set();
  const seenArtifacts = new Set();
  for (const target of targets) {
    if (!/^[a-z][a-z0-9-]*:(?:full|all-branches)$/u.test(target?.id || "")
      || target.id !== `${target.platform}:${target.profile}`
      || seenIds.has(target.id)) {
      throw new Error(`Invalid or duplicate archive target: ${target?.id || "(missing)"}`);
    }
    if (target.label !== platformLabels.get(target.platform)) {
      throw new Error(`${target.id} has an invalid platform label`);
    }
    if (target.currentPathGate?.interface !== archiveBookmarkletContract.currentPathInterface
      || target.currentPathGate?.pairKey !== `${target.platform}/current-path-v1`) {
      throw new Error(`${target.id} has an invalid current-path gate`);
    }
    seenIds.add(target.id);

    if (target.status === "planned") {
      if (target.version !== null || target.source !== null || target.min !== null
        || target.platformPayloadSchema !== null || !target.plannedReason) {
        throw new Error(`${target.id} planned target must not masquerade as a buildable artifact`);
      }
      continue;
    }
    if (target.status !== "ready") throw new Error(`${target.id} has invalid status ${target.status}`);
    if (!target.version || !target.source || !target.min || !target.platformPayloadSchema) {
      throw new Error(`${target.id} ready target is missing build metadata`);
    }
    if (target.source !== bookmarkletPath("candidate", target.platform, target.source)
      || target.min !== bookmarkletPath("candidate", target.platform, target.min)) {
      throw new Error(`${target.id} files must stay under candidate/${target.platform}/`);
    }
    if (!["PLATFORM_SCHEMA", "SCHEMA"].includes(target.platformPayloadConstant)) {
      throw new Error(`${target.id} has an invalid platform payload constant`);
    }
    if (seenSources.has(target.source) || seenArtifacts.has(target.min)) {
      throw new Error(`${target.id} reuses a source or artifact path`);
    }
    if (!Array.isArray(target.buildFlags)
      || target.buildFlags.some((flag) => !["--temml", "--temml-mhchem", "--katex-runtime"].includes(flag))) {
      throw new Error(`${target.id} has unsupported build flags`);
    }
    seenSources.add(target.source);
    seenArtifacts.add(target.min);

    if (readSourceText) {
      const sourceText = readSourceText(target);
      if (readConstant(sourceText, "VERSION", target) !== target.version) {
        throw new Error(`${target.id} source VERSION does not match registry`);
      }
      if (readConstant(sourceText, "MANIFEST_SCHEMA", target) !== archiveBookmarkletContract.manifestSchema) {
        throw new Error(`${target.id} source MANIFEST_SCHEMA does not match the archive contract`);
      }
      if (readConstant(sourceText, target.platformPayloadConstant, target) !== target.platformPayloadSchema) {
        throw new Error(`${target.id} source ${target.platformPayloadConstant} does not match registry`);
      }
    }
  }

  validateArchiveCurrentPathPairs(targets);
  return targets;
}
