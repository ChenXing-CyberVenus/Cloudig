import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import { chatGptFullAdapter } from "../../adapters/parser/chatgpt-full.mts";
import { chatGptLightAdapter } from "../../adapters/parser/chatgpt-light.mts";
import { chatGptTreeAdapter } from "../../adapters/parser/chatgpt-tree.mts";
import { geminiFullAdapter, geminiLightAdapter } from "../../adapters/parser/gemini.mts";
import { deepSeekFullAdapter, deepSeekLightAdapter, deepSeekTreeAdapter } from "../../adapters/parser/deepseek.mts";
import { grokFullAdapter, grokLightAdapter, grokTreeAdapter } from "../../adapters/parser/grok.mts";
import { doubaoFullAdapter, doubaoLightAdapter } from "../../adapters/parser/doubao.mts";
import { kimiFullAdapter, kimiLightAdapter, kimiTreeAdapter } from "../../adapters/parser/kimi.mts";
import { qwenFullAdapter, qwenLightAdapter, qwenTreeAdapter } from "../../adapters/parser/qwen.mts";
import { chatGlmFullAdapter, chatGlmLightAdapter } from "../../adapters/parser/chatglm.mts";
import { zaiFullAdapter, zaiLightAdapter, zaiTreeAdapter } from "../../adapters/parser/zai.mts";
import { yuanbaoFullAdapter, yuanbaoLightAdapter } from "../../adapters/parser/yuanbao.mts";
import { mistralFullAdapter, mistralLightAdapter, mistralTreeAdapter } from "../../adapters/parser/mistral.mts";
import { claudeFullAdapter, claudeLightAdapter, claudeTreeAdapter } from "../../adapters/parser/claude-web.mts";
import { claudeContainerAdapter } from "../../adapters/parser/claude-container.mts";
import { agentManifest } from "../../adapters/parser/agent-json.mts";
import { DEEPSEEK_OFFICIAL_MANIFEST } from "../../adapters/parser/deepseek-official.mts";
import { QWEN_OFFICIAL_MANIFEST } from "../../adapters/parser/qwen-official.mts";
import { GROK_OFFICIAL_MANIFEST } from "../../adapters/parser/grok-official.mts";
import { MISTRAL_OFFICIAL_MANIFEST } from "../../adapters/parser/mistral-official.mts";
import { CHATGPT_OFFICIAL_MANIFEST } from "../../adapters/parser/chatgpt-official.mts";
import type { AdapterManifest, SourceAdapter } from "./adapter.mts";

const STRICT_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SLUG = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u;

const ADAPTERS = [
  chatGptLightAdapter,
  chatGptFullAdapter,
  chatGptTreeAdapter,
  geminiLightAdapter,
  geminiFullAdapter,
  deepSeekLightAdapter,
  deepSeekFullAdapter,
  deepSeekTreeAdapter,
  grokLightAdapter,
  grokFullAdapter,
  grokTreeAdapter,
  doubaoLightAdapter,
  doubaoFullAdapter,
  kimiLightAdapter,
  kimiFullAdapter,
  kimiTreeAdapter,
  qwenLightAdapter,
  qwenFullAdapter,
  qwenTreeAdapter,
  chatGlmLightAdapter,
  chatGlmFullAdapter,
  zaiLightAdapter,
  zaiFullAdapter,
  zaiTreeAdapter,
  yuanbaoLightAdapter,
  yuanbaoFullAdapter,
  mistralLightAdapter,
  mistralFullAdapter,
  mistralTreeAdapter,
  claudeLightAdapter,
  claudeFullAdapter,
  claudeTreeAdapter,
  claudeContainerAdapter,
  ...[DEEPSEEK_OFFICIAL_MANIFEST, QWEN_OFFICIAL_MANIFEST, GROK_OFFICIAL_MANIFEST, MISTRAL_OFFICIAL_MANIFEST, CHATGPT_OFFICIAL_MANIFEST].map(manifest => ({ manifest, parse(): never { throw new TypeError("Official exports require a byte-range index and record selection"); } })),
  ...(["cline-api", "cline-ui", "sillytavern", "kimi-code", "claude-code", "codex"] as const).map(agentManifest).map(manifest => ({ manifest, parse(): never { throw new TypeError("Agent JSON sources are parsed through the streaming record worker"); } }))
] as const satisfies readonly SourceAdapter[];

function routeKey(route: AdapterManifest["routes"][number]): string {
  return `${route.format}\u0000${route.platform}\u0000${route.payload}\u0000${route.profile}`;
}

function validateRegistry(adapters: readonly SourceAdapter[]): void {
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const adapter of adapters) {
    const manifest = adapter.manifest;
    if (!SLUG.test(manifest.id) || !SLUG.test(manifest.family) || !STRICT_SEMVER.test(manifest.version)) {
      throw new TypeError(`Invalid Adapter manifest identity: ${manifest.id}`);
    }
    if (ids.has(manifest.id)) throw new TypeError(`Duplicate Adapter id: ${manifest.id}`);
    ids.add(manifest.id);
    if (manifest.routes.length === 0) throw new TypeError(`Adapter has no routes: ${manifest.id}`);
    for (const route of manifest.routes) {
      const key = routeKey(route);
      if (routes.has(key)) throw new TypeError(`Duplicate Adapter route: ${key}`);
      routes.add(key);
    }
  }
}

validateRegistry(ADAPTERS);

export function findSourceAdapter(input: Readonly<{
  format: AdapterManifest["routes"][number]["format"];
  platform: string;
  payload: string;
}>): SourceAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.manifest.routes.some((route) => (
    route.format === input.format && route.platform === input.platform && route.payload === input.payload
  )));
}

export function fallbackPayloadId(platform: string): string | undefined {
  if (platform === "chatgpt") return "chatgpt-export-data";
  if (platform === "gemini") return "gemini-archive-data";
  if (platform === "grok") return "grok-export-data";
  if (platform === "deepseek") return "deepseek-export-data";
  if (platform === "doubao") return "doubao-export-data";
  if (platform === "kimi") return "kimi-export-data";
  if (platform === "qwen") return "qwen-export-data";
  if (platform === "chatglm") return "chatglm-export-data";
  if (platform === "zai") return "zai-export-data";
  if (platform === "yuanbao") return "yuanbao-export-data";
  if (platform === "mistral") return "mistral-export-data";
  if (platform === "claude") return "claude-export-data";
  return undefined;
}

export const PARSER_VERSION = "1.1.35";

export function adapterBundleSnapshot(): Readonly<{
  schema: "cloudig/adapter-bundle/1.0.0";
  parser: string;
  adapters: readonly AdapterManifest[];
}> {
  return {
    schema: "cloudig/adapter-bundle/1.0.0",
    parser: PARSER_VERSION,
    adapters: ADAPTERS.map((adapter) => structuredClone(adapter.manifest))
  };
}

export function adapterBundleSha256(): string {
  return createHash("sha256").update(canonicalizeJcs(adapterBundleSnapshot()), "utf8").digest("hex");
}
