import path from "node:path";
import { fileURLToPath } from 'node:url';
import { createRuntimeCacheSession } from "../adapters/storage/runtime-cache.mts";

import { RecordLibraryEngineCommands } from "./record-library-commands.mts";
import { RecordArchiverEngineCommands } from "./record-archiver-commands.mts";
import { RecordReaderEngineCommands } from "./record-reader-commands.mts";
import { RecordTimeEngineCommands } from "./record-time-commands.mts";
import { RecordSystemLogEngineCommands } from "./record-system-log-commands.mts";
import { RecordIdentityEngineCommands } from "./record-identity-commands.mts";
import { serveEngineJsonl } from "./protocol.mts";

const ENGINE_VERSION = "0.1.0-dev";

function storageArguments(values: readonly string[]): { libraryRoot: string; cacheRoot: string } {
  if (values.length !== 4 || values[0] !== "--library-root" || values[2] !== "--cache-root" || !path.isAbsolute(values[1]!) || !path.isAbsolute(values[3]!)) {
    throw new TypeError("Engine requires absolute --library-root and --cache-root startup arguments");
  }
  const libraryRoot = path.resolve(values[1]!), cacheRoot = path.resolve(values[3]!);
  const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(cacheRoot) !== comparable(path.join(libraryRoot, "cache"))) throw new TypeError("Engine cache must belong to this Cloudig root");
  return { libraryRoot, cacheRoot };
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  doubao: "豆包",
  kimi: "Kimi",
  qwen: "Qwen",
  chatglm: "ChatGLM",
  zai: "Z.ai",
  yuanbao: "元宝",
  mistral: "Mistral",
  cline: "Cline",
  sillytavern: "SillyTavern",
  "kimi-code": "Kimi Code",
  "claude-code": "Claude Code",
  codex: "Codex"
};

function builtins() {
  return {
    user: {
      name: "采云用户",
      avatar: "Assets/Defaults/user.svg",
      localizedNames: { "zh-CN": "采云用户", en: "User" }
    },
    assistant: {
      name: "智能伙伴",
      avatar: "Assets/Defaults/assistant.svg",
      localizedNames: { "zh-CN": "智能伙伴", en: "AI" }
    },
    platforms: Object.fromEntries(Object.entries(PLATFORM_NAMES).map(([platform, name]) => [platform, {
      name,
      avatar: `Assets/Platforms/${platform}.svg`
    }]))
  };
}

async function main(): Promise<void> {
  const { libraryRoot, cacheRoot } = storageArguments(process.argv.slice(2));
  const cache = await createRuntimeCacheSession(cacheRoot, libraryRoot);
  const time = new RecordTimeEngineCommands({ libraryRoot });
  const builtinIdentity = builtins();
  const commands = new RecordReaderEngineCommands({
    examplesRoot: fileURLToPath(new URL('../../docs/examples/', import.meta.url)),
    libraryRoot,
    runtimeRoot: cache.root,
    builtins: builtinIdentity,
    projectTimeRange: (range) => time.projectDraftRange(range),
    resolveTimeRange: (range) => time.resolveDraftRange(range)
  });
  const library = new RecordLibraryEngineCommands(libraryRoot);
  const archiver = new RecordArchiverEngineCommands({
    libraryRoot,
    runtimeRoot: cache.root,
    resolveDirectory: (capability) => commands.directoryNameForCapability(capability)
  });
  const systemLog = new RecordSystemLogEngineCommands(libraryRoot);
  const identity = new RecordIdentityEngineCommands({
    libraryRoot,
    runtimeRoot: cache.root,
    builtins: builtinIdentity,
    resolveConversation: value => commands.resolveIdentityDraft(value)
  });
  try {
    await serveEngineJsonl({
      readable: process.stdin,
      writable: process.stdout,
      engineVersion: ENGINE_VERSION,
      handlers: Object.fromEntries(Object.entries({ "engine.storage": async () => ({ runtime_root: cache.root }), ...library.handlers(), ...identity.handlers(), ...commands.handlers(), ...archiver.handlers(), ...time.handlers(), ...systemLog.handlers() })
        .map(([name, handler]) => [name, async (...args: Parameters<typeof handler>) => { await cache.ensure(); return handler(...args); }])),
      onShutdown: async () => { time.close(); systemLog.close(); await archiver.close(); await identity.close(); await commands.close(); }
    });
  } finally {
    time.close();
    systemLog.close();
    await archiver.close();
    await identity.close();
    await commands.close();
    await cache.close();
    process.stdin.destroy();
    if (process.env["CLOUDIG_PARSER_METRICS"] === "1") {
      const usage = process.resourceUsage();
      process.stderr.write(`CLOUDIG_ENGINE_METRICS ${JSON.stringify({ peakRss: usage.maxRSS * 1024, userCpuMs: usage.userCPUTime / 1000, systemCpuMs: usage.systemCPUTime / 1000 })}\n`);
    }
  }
}

main().catch(() => {
  process.stderr.write("CLOUDIG_ENGINE_START_FAILED\n");
  process.exitCode = 1;
});
