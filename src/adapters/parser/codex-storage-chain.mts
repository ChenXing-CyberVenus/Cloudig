import path from "node:path";
import { isJsonObject, type JsonObject } from "../../core/contracts/types.mts";
import { streamAgentJsonl } from "./agent-jsonl-stream.mts";

export type CodexHeader = Readonly<{
  storageId?: string; sessionId?: string; ordinal?: number;
  base?: { id: string; ordinal: number; bytes: number };
}>;
export type CodexSegment = Readonly<{ file: string; header: CodexHeader; end?: number; nextOrdinal?: number }>;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const storageName = new RegExp(`(?:^|-)(${uuid})(?: \\(\\d+\\))?\\.jsonl(?:\\.zst)?$`, "i");
const validId = (value: unknown): value is string => typeof value === "string" && new RegExp(`^${uuid}$`, "i").test(value);

export async function inspectCodexHeader(file: string, signal?: AbortSignal): Promise<CodexHeader> {
  for await (const { value } of streamAgentJsonl(file, { ...(signal ? { signal } : {}) })) {
    if (value["type"] !== "session_meta" || !isJsonObject(value["payload"])) return {};
    const p = value["payload"], raw = p["history_base"], session = p["session_id"] ?? p["id"];
    const sessionId = validId(session) ? session : undefined;
    let base: CodexHeader["base"];
    if (raw !== undefined && raw !== null) {
      if (!isJsonObject(raw) || !validId(raw["thread_id"]) || !Number.isSafeInteger(raw["end_ordinal_exclusive"]) || Number(raw["end_ordinal_exclusive"]) < 0
        || !Number.isSafeInteger(raw["end_byte_offset"]) || Number(raw["end_byte_offset"]) < 0)
        throw new TypeError("Codex history_base 格式无效 / invalid history_base");
      base = { id: raw["thread_id"], ordinal: Number(raw["end_ordinal_exclusive"]), bytes: Number(raw["end_byte_offset"]) };
    }
    // Root session identity is a storage identity only without inheritance.
    // A renamed continuation cannot obtain physical identity from its logical session_id.
    const storageId = validId(p["storage_id"]) ? p["storage_id"] : storageName.exec(path.basename(file))?.[1] ?? (!base ? sessionId : undefined);
    return { ...(storageId ? { storageId } : {}), ...(sessionId ? { sessionId } : {}),
      ...(Number.isSafeInteger(value["ordinal"]) ? { ordinal: Number(value["ordinal"]) } : {}), ...(base ? { base } : {}) };
  }
  return {};
}

/** A selected leaf may use only explicitly supplied siblings. No private manifests,
 * filesystem-wide search, filename sequence guesses or automatic tail merging. */
export async function planCodexChain(leaf: string, files: readonly string[], signal?: AbortSignal): Promise<CodexSegment[]> {
  const headers = new Map<string, CodexHeader>();
  for (const file of new Set([leaf, ...files])) headers.set(file, await inspectCodexHeader(file, signal));
  return resolveCodexChain(leaf, headers);
}

export function resolveCodexChain(leaf: string, headers: ReadonlyMap<string, CodexHeader>): CodexSegment[] {
  if (!headers.has(leaf)) throw new TypeError("Codex source is not in the observed shard set");
  const chain: CodexSegment[] = [], visited = new Set<string>();
  let file = leaf, end: number | undefined, nextOrdinal: number | undefined;
  while (true) {
    if (visited.has(file)) throw new TypeError("Codex 分片继承成环 / cyclic history_base");
    visited.add(file);
    const header = headers.get(file)!;
    chain.unshift({ file, header, ...(end !== undefined ? { end } : {}), ...(nextOrdinal !== undefined ? { nextOrdinal } : {}) });
    if (!header.base) break;
    if (header.ordinal !== header.base.ordinal) throw new TypeError("Codex 续片首 ordinal 与继承边界不一致 / continuation ordinal mismatch");
    const parents = [...headers].filter(([, h]) => h.storageId === header.base!.id);
    if (parents.length !== 1) throw new TypeError(`Codex ${parents.length ? "分片身份重复" : "缺少前序分片"}：${header.base.id}。请一并导入保留原始 rollout 名称的分片。 / Missing or ambiguous Codex storage shard: ${header.base.id}`);
    end = header.base.bytes; nextOrdinal = header.base.ordinal; file = parents[0]![0];
  }
  return chain;
}

export async function* codexChainRecords(chain: readonly CodexSegment[], options: {
  signal?: AbortSignal; onProgress?: (bytes: number) => void;
} = {}): AsyncGenerator<JsonObject> {
  let physical = 0;
  for (const segment of chain) {
    let read = 0, lastOrdinal: number | undefined;
    for await (const { value } of streamAgentJsonl(segment.file, {
      ...(segment.end !== undefined ? { end: segment.end } : {}), ...(options.signal ? { signal: options.signal } : {}),
      onProgress: bytes => { read = bytes; options.onProgress?.(physical + read); }
    })) {
      const ordinal = value["ordinal"];
      if (ordinal !== undefined) {
        if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0 || (lastOrdinal !== undefined && Number(ordinal) !== lastOrdinal + 1))
          throw new TypeError("Codex 分片 ordinal 不连续 / discontinuous shard ordinal");
        lastOrdinal = Number(ordinal);
      }
      yield value;
    }
    if (segment.nextOrdinal !== undefined && (lastOrdinal === undefined || lastOrdinal + 1 !== segment.nextOrdinal))
      throw new TypeError("Codex 字节范围与 ordinal 边界不匹配 / inherited byte and ordinal ranges disagree");
    physical += read;
  }
}
