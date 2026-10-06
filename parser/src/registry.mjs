import { loadSourceRegistry } from "./contract.mjs";
import { chatgptAdapter } from "./adapters/chatgpt.mjs";
import { geminiAdapter } from "./adapters/gemini.mjs";
import { grokAdapter } from "./adapters/grok.mjs";
import { deepseekAdapter } from "./adapters/deepseek.mjs";
import { doubaoAdapter } from "./adapters/doubao.mjs";
import { kimiAdapter } from "./adapters/kimi.mjs";
import { qwenAdapter } from "./adapters/qwen.mjs";
import { chatglmAdapter } from "./adapters/chatglm.mjs";
import { zaiAdapter } from "./adapters/zai.mjs";
import { yuanbaoAdapter } from "./adapters/yuanbao.mjs";
import { mistralAdapter } from "./adapters/mistral.mjs";
import { FULL_ADAPTERS } from "./adapters/full.mjs";
import {
  claudeWebFullAdapter,
  claudeWebLightAdapter
} from "./adapters/claude-web.mjs";
import { BRANCH_ADAPTERS } from "./adapters/branches.mjs";
import { parserAdapterVersion } from "./version-history.mjs";

const IMPLEMENTATIONS = [
  chatgptAdapter,
  geminiAdapter,
  grokAdapter,
  deepseekAdapter,
  doubaoAdapter,
  kimiAdapter,
  qwenAdapter,
  chatglmAdapter,
  zaiAdapter,
  yuanbaoAdapter,
  mistralAdapter,
  ...FULL_ADAPTERS,
  claudeWebLightAdapter,
  claudeWebFullAdapter,
  ...BRANCH_ADAPTERS
];

export const ADAPTERS = Object.freeze(IMPLEMENTATIONS.map((adapter) => Object.freeze({
  ...adapter,
  version: parserAdapterVersion(adapter.id)
})));

function validateAdapters() {
  const registry = loadSourceRegistry();
  if (ADAPTERS.length !== registry.sources.length) {
    throw new Error(`Adapter/source count mismatch: ${ADAPTERS.length} != ${registry.sources.length}`);
  }
  const ids = new Set();
  for (const adapter of ADAPTERS) {
    if (ids.has(adapter.id)) throw new Error(`Duplicate adapter id: ${adapter.id}`);
    ids.add(adapter.id);
    const source = registry.sources.find((candidate) => candidate.id === adapter.id);
    if (!source) throw new Error(`Adapter is not registered: ${adapter.id}`);
    if (!adapter.version) throw new Error(`Adapter version is not registered: ${adapter.id}`);
    for (const [field, adapterField] of [
      ["profile", "profile"],
      ["provider", "provider"],
      ["platform", "platform"],
      ["payload_schema", "payloadSchema"]
    ]) {
      if (source[field] !== adapter[adapterField]) {
        throw new Error(`Adapter ${adapter.id} ${field} mismatch`);
      }
    }
  }
}

validateAdapters();

export function selectAdapter(context) {
  const matches = ADAPTERS.filter((adapter) => adapter.id === context.source.id);
  if (matches.length !== 1) {
    throw new Error(`Parser adapter must match exactly once; got ${matches.length}`);
  }
  return matches[0];
}
