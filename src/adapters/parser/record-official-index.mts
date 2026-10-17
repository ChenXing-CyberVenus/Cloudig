import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';
import { parseRecordJson } from '../../core/records/index.mts';
import { validateContainerRecordSchema } from '../../core/contracts/index.mts';
import { resolveRecordPath, withRecordSnapshot } from '../storage/record-store.mts';
import { writeRecordProjection } from '../storage/record-projection.mts';
import { fingerprintFile } from '../storage/stream.mts';
import { fileCaptureTime } from '../../app/parser/record-source.mts';
import { indexRecordClaudeContainer, extractIndexedClaudeRecord, type RecordClaudeIndex } from './record-claude-index.mts';
import { inspectOfficialJson, officialJsonArrayFileRange, officialJsonArrayRanges, assertOfficialRecord } from './official-json-layout.mts';
import { parseJsonRange } from './json-array-stream.mts';
import { extractDeepSeekOfficial, DEEPSEEK_OFFICIAL_MANIFEST, deepSeekOfficialSelector } from './deepseek-official.mts';
import { extractQwenOfficial, QWEN_OFFICIAL_MANIFEST } from './qwen-official.mts';
import { object, list, text, nativeTime, officialSelector } from './official-record.mts';
import { extractGrokOfficial, GROK_OFFICIAL_MANIFEST, grokOfficialTime } from './grok-official.mts';
import { extractMistralOfficial, MISTRAL_OFFICIAL_MANIFEST } from './mistral-official.mts';
import { extractChatGptOfficial, CHATGPT_OFFICIAL_MANIFEST, chatGptOfficialId, chatGptOfficialNodes } from './chatgpt-official.mts';
import { attachChatGptLibraryAssets, chatGptLibraryAssets } from './chatgpt-library-assets.mts';
import { embedOfficialResources, embedOfficialResourceBytes, OFFICIAL_ASSET_LIMITS } from './official-json-assets.mts';
import { OfficialZip, prepareOfficialZipWorkspace, splitZipRecordSelector, zipRecordSelector, zipSourceStamp, type ZipWorkspace } from './official-zip.mts';
import { createRuntimeCacheSession } from '../storage/runtime-cache.mts';

export type RecordZipIndex = Readonly<{
  schema: 'cloudig/official-zip-index/1.0.0'; platform: 'grok' | 'mistral' | 'chatgpt'; adapter_version: string; source_stamp?: string;
  built_at: string; source: RecordClaudeIndex['source']; records: readonly JsonObject[];
  entries: Readonly<Record<string, { bytes: number; sha256: string }>>; resource_bytes: number;
  resource_bytes_by_record?: Readonly<Record<string, number>>;
}>;
export type RecordOfficialIndex = RecordClaudeIndex | RecordZipIndex | Readonly<{
  schema: 'cloudig/official-json-index/1.0.0'; projection_version: number; platform: 'deepseek' | 'qwen' | 'grok' | 'mistral'; adapter_version: string;
  built_at: string; source: RecordClaudeIndex['source']; records: readonly JsonObject[];
}>;
export const officialIndexPlatform = (index: RecordOfficialIndex) => index.schema === 'cloudig/claude-index/1.0.0' ? 'claude' : index.platform;
type Options = NonNullable<Parameters<typeof indexRecordClaudeContainer>[2]>;
const indexPath = (relative: string) => `appdata/indexes/platform-json/${createHash('sha256').update(relative).digest('hex')}.json`;
const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined;
const manifests = { deepseek: DEEPSEEK_OFFICIAL_MANIFEST, qwen: QWEN_OFFICIAL_MANIFEST, grok: GROK_OFFICIAL_MANIFEST, mistral: MISTRAL_OFFICIAL_MANIFEST, chatgpt: CHATGPT_OFFICIAL_MANIFEST };
const OFFICIAL_INDEX_PROJECTION_VERSION = 3;

function summarizeDeepSeek(record: JsonObject, ordinal: number, offset: number, length: number, hash: string): JsonObject {
  const mapping = record['mapping'] as JsonObject, nodes = Object.entries(mapping), children = new Map<string, number>();
  let empty = 0, orphan = 0, messages = 0;
  for (const [, value] of nodes) {
    const node = value as JsonObject, parent = node['parent'];
    if (typeof parent === 'string' && parent) {
      if (Object.hasOwn(mapping, parent)) children.set(parent, (children.get(parent) ?? 0) + 1); else orphan++;
    }
    if (isJsonObject(node['message'])) { messages++; if (Array.isArray(node['message']['fragments']) && !node['message']['fragments'].length) empty++; }
  }
  const leaves = nodes.filter(([id]) => !children.has(id)).length, forks = [...children.values()].filter(count => count > 1).length;
  const created = iso(record['inserted_at']), updated = iso(record['updated_at']);
  return { schema: 'cloudig/container-record/1.0.0', selector: deepSeekOfficialSelector(String(record['id'])), ordinal, offset, length, item_sha256: hash,
    title: typeof record['title'] === 'string' && record['title'].trim() ? record['title'] : 'DeepSeek conversation', messages, empty_messages: empty,
    ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}),
    ...(leaves ? { branches: leaves } : {}), ...(forks ? { fork_points: forks } : {}), ...(orphan ? { orphan_parents: orphan } : {}) };
}

function summarizeQwen(record: JsonObject, ordinal: number, offset: number, length: number, hash: string): JsonObject {
  const pool = object(object(object(record['chat'])['history'])['messages']), children = new Map<string, number>(); let empty = 0, orphan = 0;
  for (const [key, raw] of Object.entries(pool)) {
    const message = object(raw); if (message['id'] !== key) throw new TypeError('Qwen mapping key and message id disagree');
    const parent = message['parentId']; if (typeof parent === 'string' && parent) { if (Object.hasOwn(pool, parent)) children.set(parent, (children.get(parent) ?? 0) + 1); else orphan++; }
    if (!message['content'] && !message['reasoning_content'] && !message['error'] && !list(message['content_list']).length && !list(message['files']).length) empty++;
  }
  const leaves = Object.keys(pool).filter(id => !children.has(id)).length, forks = [...children.values()].filter(n => n > 1).length;
  const created = nativeTime(record['created_at'], 'seconds'), updated = nativeTime(record['updated_at'], 'seconds');
  return { schema: 'cloudig/container-record/1.0.0', selector: officialSelector('qwen', String(record['id'])), ordinal, offset, length, item_sha256: hash,
    title: typeof record['title'] === 'string' && record['title'].trim() ? record['title'] : 'Qwen conversation', messages: Object.keys(pool).length, empty_messages: empty,
    ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}), ...(leaves ? { branches: leaves } : {}), ...(forks ? { fork_points: forks } : {}), ...(orphan ? { orphan_parents: orphan } : {}) };
}

function summarizeGrok(record: JsonObject, ordinal: number, offset: number, length: number, hash: string): JsonObject {
  const conversation = object(record['conversation']), messages = list(record['responses']).map(r => object(object(r)['response']));
  const ids = new Set(messages.map(m => m['_id'])); if (ids.size !== messages.length || messages.some(m => typeof m['_id'] !== 'string')) throw new TypeError('Invalid or duplicate Grok response identity');
  const children = new Map<string, number>(); let orphan = 0;
  for (const message of messages) { const parent = message['parent_response_id']; if (typeof parent === 'string' && parent) { if (ids.has(parent)) children.set(parent, (children.get(parent) ?? 0) + 1); else orphan++; } }
  const leaves = [...ids].filter(id => !children.has(String(id))).length, forks = [...children.values()].filter(n => n > 1).length;
  const created = grokOfficialTime(conversation['create_time']), updated = grokOfficialTime(conversation['modify_time']);
  return { schema: 'cloudig/container-record/1.0.0', selector: officialSelector('grok', String(conversation['id'])), ordinal, offset, length, item_sha256: hash,
    title: typeof conversation['title'] === 'string' && conversation['title'].trim() ? conversation['title'] : 'Grok conversation', messages: messages.length,
    empty_messages: messages.filter(m => !m['message'] && !m['query'] && !m['error'] && !m['thinking_trace'] && ['steps', 'agent_thinking_traces', 'file_attachments', 'card_attachments_json', 'web_search_results', 'cited_web_search_results', 'generated_image_urls'].every(k => !list(m[k]).length)).length,
    ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}), ...(leaves ? { branches: leaves } : {}), ...(forks ? { fork_points: forks } : {}), ...(orphan ? { orphan_parents: orphan } : {}) };
}

function summarizeChatGpt(record: JsonObject, ordinal: number, offset: number, length: number, hash: string): JsonObject {
  const nodes = chatGptOfficialNodes(record), children = new Map<string, number>(); let messages = 0, empty = 0;
  for (const [, node] of nodes) {
    const parent = text(node['parent']); if (parent) children.set(parent, (children.get(parent) ?? 0) + 1);
    if (node['message'] !== null) {
      messages++; const content = object(object(node['message'])['content']);
      if (!list(content['parts']).length && !list(content['thoughts']).length && !text(content['content']) && !text(content['text'])) empty++;
    }
  }
  const created = nativeTime(record['create_time'], 'seconds'), updated = nativeTime(record['update_time'], 'seconds'), forks = [...children.values()].filter(n => n > 1).length;
  return { schema: 'cloudig/container-record/1.0.0', selector: officialSelector('chatgpt', chatGptOfficialId(record)), ordinal, offset, length, item_sha256: hash,
    title: text(record['title'])?.trim() ? record['title']! : 'ChatGPT conversation', messages, empty_messages: empty,
    ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}),
    ...(nodes.length ? { branches: nodes.filter(([key]) => !children.has(key)).length } : {}),
    ...(forks ? { fork_points: forks } : {}) };
}

function chatGptResourceBudget(record: JsonObject, zip: OfficialZip, directory: string, library: unknown): number {
  const seen = new Set<string>(), pending: unknown[] = [record, ...chatGptLibraryAssets(record, library).map(file => file['file_id'])]; let bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && value.length <= OFFICIAL_ASSET_LIMITS.keyCharacters) {
      const key = /^(?:(?:file-service|sediment):\/\/)?(file[-_][a-z0-9_-]+)$/iu.exec(value)?.[1];
      if (key && !seen.has(key)) { seen.add(key); bytes += zip.entries.get(path.posix.join(directory, key + '.dat'))?.uncompressedSize ?? 0; }
    } else if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push(child);
  }
  return bytes;
}

function mistralRecords(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || !value.length) throw new TypeError('Mistral export requires a nonempty message array');
  for (const raw of value) { assertOfficialRecord('mistral', raw); if (raw['chatId'] !== value[0]['chatId']) throw new TypeError('Mistral source mixes different chats'); }
  return value as JsonObject[];
}
function summarizeMistral(records: JsonObject[], offset: number, length: number, hash: string, filename: string): JsonObject {
  const dates = records.flatMap(m => { const t = nativeTime(m['createdAt']); return t ? [t] : []; }).sort(), created = dates[0], updated = dates.at(-1);
  return { schema: 'cloudig/container-record/1.0.0', selector: officialSelector('mistral', String(records[0]!['chatId'])), ordinal: 1, offset, length, item_sha256: hash,
    title: path.parse(filename).name, messages: records.length, empty_messages: records.filter(m => !m['content'] && !list(m['contentChunks']).length && !list(m['files']).length && !list(m['canvas']).length).length,
    ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}) };
}

/** Keep Claude's accepted streaming route and cache intact; other official
 * envelopes share one range-index publication and worker contract. */
export async function indexRecordOfficialContainer(root: string, relative: string, options: Options = {}): Promise<{ index: RecordOfficialIndex; reused: boolean }> {
  if (!/^Inbox\/[^/\\]+$/u.test(relative)) throw new TypeError('Official JSON must be a direct Inbox file');
  if (/\.zip$/iu.test(relative)) return indexOfficialZip(root, relative, options);
  const absolute = await resolveRecordPath(root, relative);
  const layout = await inspectOfficialJson(absolute, { ...(options.signal ? { signal: options.signal } : {}), emptyPlatform: 'claude' });
  if (layout.platform === 'chatgpt') throw new TypeError('请导入完整ChatGPT会话ZIP，不导入单个JSON分片。 / Import the complete ChatGPT Conversations ZIP, not an individual JSON shard.');
  if (layout.platform === 'claude') return indexRecordClaudeContainer(root, relative, options);
  const manifest = manifests[layout.platform];
  const before = await fingerprintFile(absolute, options.signal), cache = indexPath(relative);
  if (!options.rebuild) {
    try {
      const prior = parseRecordJson(await readFile(await resolveRecordPath(root, cache), 'utf8'));
      if (isJsonObject(prior) && prior['schema'] === 'cloudig/official-json-index/1.0.0' && prior['projection_version'] === OFFICIAL_INDEX_PROJECTION_VERSION && prior['platform'] === layout.platform
        && prior['adapter_version'] === manifest.version && typeof prior['built_at'] === 'string' && isJsonObject(prior['source'])
        && prior['source']['path'] === relative && prior['source']['sha256'] === before.sha256 && prior['source']['bytes'] === before.bytes
        && Array.isArray(prior['records']) && prior['records'].every(r => validateContainerRecordSchema(r).ok)
        && new Set(prior['records'].map(r => (r as JsonObject)['selector'])).size === prior['records'].length) {
        options.onProgress?.({ phase: 'ready', bytes: before.bytes, total: before.bytes, records: prior['records'].length });
        return { index: prior as unknown as RecordOfficialIndex, reused: true };
      }
    } catch (e) { if (!(e instanceof TypeError || e instanceof SyntaxError || e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e; }
  }
  const records: JsonObject[] = [], selectors = new Set<string>();
  options.onProgress?.({ phase: 'scan', bytes: 0, total: before.bytes, records: 0 });
  if (layout.mode === 'message-array') {
    const parsed = await parseJsonRange(absolute, { ...layout.range, index: 0 }, options.signal ? { signal: options.signal } : {});
    records.push(summarizeMistral(mistralRecords(parsed.value), layout.range.offset, layout.range.length, parsed.fingerprint.sha256, relative));
  } else for await (const range of officialJsonArrayRanges(absolute, layout.range, {
    ...(options.signal ? { signal: options.signal } : {}), onProgress: bytes => options.onProgress?.({ phase: 'scan', bytes, total: before.bytes, records: records.length })
  })) {
    const parsed = await parseJsonRange(absolute, range, options.signal ? { signal: options.signal } : {});
    assertOfficialRecord(layout.platform, parsed.value);
    const project = layout.platform === 'deepseek' ? summarizeDeepSeek : layout.platform === 'qwen' ? summarizeQwen : summarizeGrok;
    const row = project(parsed.value, range.index + 1, range.offset, range.length, parsed.fingerprint.sha256);
    if (!validateContainerRecordSchema(row).ok || selectors.has(String(row['selector']))) throw new TypeError('Invalid or duplicate official conversation identity');
    selectors.add(String(row['selector'])); records.push(row);
    options.onProgress?.({ phase: 'record', bytes: range.offset + range.length, total: before.bytes, records: records.length });
  }
  const after = await fingerprintFile(absolute, options.signal);
  if (after.sha256 !== before.sha256 || after.bytes !== before.bytes) throw new TypeError('Official JSON source changed during indexing');
  const index: RecordOfficialIndex = { schema: 'cloudig/official-json-index/1.0.0', projection_version: OFFICIAL_INDEX_PROJECTION_VERSION, platform: layout.platform, adapter_version: manifest.version,
    source: { path: relative, ...before }, built_at: new Date().toISOString(), records };
  options.signal?.throwIfAborted(); await withRecordSnapshot(root, () => writeRecordProjection(root, cache, JSON.stringify(index, null, 2) + '\n'));
  options.onProgress?.({ phase: 'ready', bytes: before.bytes, total: before.bytes, records: records.length });
  return { index, reused: false };
}

export async function extractIndexedOfficialRecord(root: string, index: RecordOfficialIndex, selector: string, signal?: AbortSignal, zipWorkspace?: ZipWorkspace) {
  if (index.schema === 'cloudig/claude-index/1.0.0') return extractIndexedClaudeRecord(root, index, selector, signal);
  if (index.schema === 'cloudig/official-zip-index/1.0.0') return extractZipRecord(root, index, selector, signal, zipWorkspace);
  if (!/^Inbox\/[^/\\]+$/u.test(index.source.path)) throw new TypeError('Official JSON must be a direct Inbox file');
  const row = index.records.find(r => r['selector'] === selector); if (!row) throw new TypeError('Official record is absent from its index');
  const absolute = await resolveRecordPath(root, index.source.path), info = await lstat(absolute);
  if (info.size !== index.source.bytes) throw new TypeError('Official source changed; refresh its index');
  const parsed = await parseJsonRange(absolute, { index: Number(row['ordinal']) - 1, offset: Number(row['offset']), length: Number(row['length']) }, signal ? { signal } : {});
  if (parsed.fingerprint.sha256 !== row['item_sha256']) throw new TypeError('Official record bytes changed; refresh its index');
  const captured = await fileCaptureTime(absolute, index.source.sha256);
  const source = { file: path.basename(index.source.path), bytes: index.source.bytes, sha256: index.source.sha256 };
  if (index.platform === 'mistral') {
    const records = mistralRecords(parsed.value);
    if (officialSelector('mistral', String(records[0]!['chatId'])) !== selector) throw new TypeError('Mistral record identity changed');
    return embedOfficialResources(extractMistralOfficial({ records, source, ...(captured ? { captured } : {}) }), root, index.source.path, index.platform, signal);
  }
  assertOfficialRecord(index.platform, parsed.value);
  const id = index.platform === 'grok' ? object(parsed.value['conversation'])['id'] : parsed.value['id'];
  if (officialSelector(index.platform, String(id)) !== selector) throw new TypeError('Official record identity changed');
  const extract = index.platform === 'deepseek' ? extractDeepSeekOfficial : index.platform === 'qwen' ? extractQwenOfficial : extractGrokOfficial;
  return embedOfficialResources(extract({ record: parsed.value, source, ...(captured ? { captured } : {}) }), root, index.source.path, index.platform, signal);
}

async function indexOfficialZip(root: string, relative: string, options: Options): Promise<{ index: RecordZipIndex; reused: boolean }> {
  const file = await resolveRecordPath(root, relative), zip = await OfficialZip.open(file, options.signal);
  let session: Awaited<ReturnType<typeof createRuntimeCacheSession>> | undefined;
  try {
    const layout = await zip.validatedLayout(options.signal), manifest = manifests[layout.platform];
    let before: {bytes:number;sha256:string} | undefined;
    if (await zipSourceStamp(file) !== zip.stamp) throw new TypeError('ZIP changed; finish copying before indexing');
    if (!options.rebuild) {
      try {
        const value = parseRecordJson(await readFile(await resolveRecordPath(root, indexPath(relative)), 'utf8'));
        if (isJsonObject(value) && value['schema'] === 'cloudig/official-zip-index/1.0.0' && value['platform'] === layout.platform && value['adapter_version'] === manifest.version
          && isJsonObject(value['source']) && value['source']['path'] === relative && /^[a-f0-9]{64}$/u.test(String(value['source']['sha256'])) && value['source']['bytes'] === Number(zip.stamp.split(':')[2])
          && typeof value['built_at'] === 'string' && isJsonObject(value['entries']) && value['resource_bytes'] === layout.resourceBytes && Array.isArray(value['records'])
          && (layout.platform !== 'chatgpt' || isJsonObject(value['resource_bytes_by_record']) && value['records'].every(r => { const n = object(value['resource_bytes_by_record'])[String(object(r)['selector'])]; return Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= layout.resourceBytes; }))
          && Object.keys(value['entries']).length === layout.jsonEntries.length && layout.jsonEntries.every(name => { const e = object(object(value['entries'])[name]); return /^[a-f0-9]{64}$/u.test(String(e['sha256'])) && e['bytes'] === zip.entries.get(name)!.uncompressedSize; })
          && value['records'].every(r => { if (!isJsonObject(r) || !validateContainerRecordSchema(r).ok) return false; const loc = splitZipRecordSelector(String(r['selector'])); const e = object(object(value['entries'])[loc.entry]); return Number(r['offset']) + Number(r['length']) <= Number(e['bytes']); })
          && new Set(value['records'].map(r => object(r)['selector'])).size === value['records'].length) {
          // This is a disposable reading index, not authority to overwrite a
          // Conversation. Extraction/commit still verify actual source bytes.
          if (value['source_stamp'] !== zip.stamp) before = await fingerprintFile(file, options.signal);
          if ((!before || value['source']['sha256'] === before.sha256) && await zipSourceStamp(file) === zip.stamp) {
            if (value['source_stamp'] !== zip.stamp) {
              value['source_stamp'] = zip.stamp;
              options.signal?.throwIfAborted();
              await withRecordSnapshot(root, () => writeRecordProjection(root, indexPath(relative), JSON.stringify(value, null, 2) + '\n', {rebuildable:true}));
            }
            options.onProgress?.({ phase: 'ready', bytes: Number(value['source']['bytes']), total: Number(value['source']['bytes']), records: value['records'].length });
            return { index: value as unknown as RecordZipIndex, reused: true };
          }
        }
      } catch (error) { if (!(error instanceof TypeError || error instanceof SyntaxError || error instanceof URIError || error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    before ??= await fingerprintFile(file, options.signal);
    if (await zipSourceStamp(file) !== zip.stamp) throw new TypeError('ZIP changed while checking its fingerprint');
    session = await createRuntimeCacheSession(await resolveRecordPath(root, 'cache'), root);
    const entries: Record<string, { bytes: number; sha256: string }> = {}, records: JsonObject[] = [], resourceBudgets: Record<string, number> = {};
    const library = layout.platform === 'chatgpt' ? await zip.metadata(path.posix.join(path.posix.dirname(layout.jsonEntries[0]!), 'library_files.json'), options.signal) : undefined;
    // Decompression and record validation each consume one pass, not the same
    // range twice. One fixed denominator keeps progress monotonic across shards.
    const total = 2 * layout.jsonEntries.reduce((n, key) => n + zip.entries.get(key)!.uncompressedSize, 0); let completed = 0;
    for (const name of layout.jsonEntries) {
      options.signal?.throwIfAborted();
      const staged = await zip.stage(name, session.root, options.signal, bytes => options.onProgress?.({ phase: 'scan', bytes: completed + bytes, total, records: records.length }));
      entries[name] = { bytes: staged.bytes, sha256: staged.sha256 };
      completed += staged.bytes;
      const json = layout.platform === 'chatgpt'
        ? {platform:layout.platform,range:await officialJsonArrayFileRange(staged.file, options.signal)}
        : await inspectOfficialJson(staged.file, { ...(options.signal ? { signal: options.signal } : {}), emptyPlatform: layout.platform });
      if (json.platform !== layout.platform) throw new TypeError('ZIP member does not match its platform export');
      if (layout.platform === 'mistral') {
        const parsed = await parseJsonRange(staged.file, { ...json.range, index: 0 }, options.signal ? { signal: options.signal } : {});
        const row = summarizeMistral(mistralRecords(parsed.value), json.range.offset, json.range.length, parsed.fingerprint.sha256, name);
        records.push({ ...row, ordinal: records.length + 1, selector: zipRecordSelector(name, String(row['selector'])) });
      } else for await (const range of officialJsonArrayRanges(staged.file, json.range, options.signal ? { signal: options.signal } : {})) {
        const parsed = await parseJsonRange(staged.file, range, options.signal ? { signal: options.signal } : {});
        if (layout.platform === 'chatgpt' && isJsonObject(parsed.value) && Object.keys(parsed.value).length === 0) continue;
        assertOfficialRecord(layout.platform, parsed.value);
        const row = (layout.platform === 'chatgpt' ? summarizeChatGpt : summarizeGrok)(parsed.value, records.length + 1, range.offset, range.length, parsed.fingerprint.sha256);
        const selector = zipRecordSelector(name, String(row['selector']));
        records.push({ ...row, selector });
        if (layout.platform === 'chatgpt') resourceBudgets[selector] = chatGptResourceBudget(parsed.value, zip, path.posix.dirname(name), library);
        options.onProgress?.({ phase: 'record', bytes: completed + range.offset + range.length, total, records: records.length });
      }
      completed += staged.bytes;
    }
    if (new Set(records.map(r => r['selector'])).size !== records.length || records.some(r => !validateContainerRecordSchema(r).ok)) throw new TypeError('Invalid or duplicate ZIP conversation index');
    if (await zipSourceStamp(file) !== zip.stamp) throw new TypeError('ZIP changed during indexing');
    const index: RecordZipIndex = { schema: 'cloudig/official-zip-index/1.0.0', platform: layout.platform, adapter_version: manifest.version, source_stamp: zip.stamp, built_at: new Date().toISOString(), source: { path: relative, ...before }, entries, resource_bytes: layout.resourceBytes, ...(layout.platform === 'chatgpt' ? { resource_bytes_by_record: resourceBudgets } : {}), records };
    options.signal?.throwIfAborted(); await withRecordSnapshot(root, () => writeRecordProjection(root, indexPath(relative), JSON.stringify(index, null, 2) + '\n', {rebuildable:true}));
    options.onProgress?.({ phase: 'ready', bytes: total, total, records: records.length }); return { index, reused: false };
  } finally { await zip.close(); await session?.close(); }
}

async function extractZipRecord(root: string, index: RecordZipIndex, selector: string, signal?: AbortSignal, workspace?: ZipWorkspace) {
  if (!/^Inbox\/[^/\\]+\.zip$/iu.test(index.source.path)) throw new TypeError('ZIP must be a direct Inbox source');
  const file = await resolveRecordPath(root, index.source.path), row = index.records.find(r => r['selector'] === selector), loc = splitZipRecordSelector(selector);
  if (!row || !index.entries[loc.entry]) throw new TypeError('ZIP record is absent from its index');
  let session: Awaited<ReturnType<typeof createRuntimeCacheSession>> | undefined;
  try {
    if (!workspace) {
      session = await createRuntimeCacheSession(await resolveRecordPath(root, 'cache'), root);
      workspace = await prepareOfficialZipWorkspace(file, index.source, [loc.entry], path.join(session.root, 'json'), signal);
    }
    if (await zipSourceStamp(file) !== workspace.sourceStamp || !workspace.files[loc.entry]) throw new TypeError('ZIP source changed before extraction');
    const parsed = await parseJsonRange(workspace.files[loc.entry]!, { offset: Number(row['offset']), length: Number(row['length']), index: Number(row['ordinal']) - 1 }, signal ? { signal } : {});
    if (parsed.fingerprint.sha256 !== row['item_sha256']) throw new TypeError('Indexed ZIP member bytes changed');
    const source = { file: path.posix.basename(loc.entry), ...index.entries[loc.entry]! }, captured = await fileCaptureTime(file, index.source.sha256);
    const extracted = index.platform === 'mistral'
      ? extractMistralOfficial({ records: mistralRecords(parsed.value), source, ...(captured ? { captured } : {}) })
      : (index.platform === 'chatgpt' ? extractChatGptOfficial : extractGrokOfficial)({ record: object(parsed.value), source, ...(captured ? { captured } : {}) });
    if (object(extracted.parsed.draft['source'])['locator'] !== loc.selector) throw new TypeError('ZIP record identity changed');
    extracted.parsed.draft['source'] = { ...object(extracted.parsed.draft['source']), file: path.basename(index.source.path), bytes: index.source.bytes, sha256: index.source.sha256, format: 'zip-container', locator: selector };
    const result = { ...extracted, parsed: { ...extracted.parsed, sourceFingerprint: { bytes: index.source.bytes, sha256: index.source.sha256 } }, facts: { ...extracted.facts, ...(index.platform === 'mistral' ? { filenameSource: path.posix.basename(loc.entry) } : {}) } };
    const zip = await OfficialZip.open(file, signal);
    try {
      if (zip.stamp !== workspace.sourceStamp || zip.layout().platform !== index.platform) throw new TypeError('ZIP changed while extracting');
      if (index.platform === 'chatgpt') {
        const directory = path.posix.dirname(loc.entry);
        attachChatGptLibraryAssets(result, object(parsed.value), await zip.metadata(path.posix.join(directory, 'library_files.json'), signal), key => zip.entries.has(path.posix.join(directory, key + '.dat')));
        const names = object(await zip.metadata(path.posix.join(path.posix.dirname(loc.entry), 'conversation_asset_file_names.json'), signal));
        for (const raw of list(result.parsed.draft['resources'])) {
          const resource = object(raw), pointer = text(object(resource['original'])['url']), id = pointer && /^(?:file-service|sediment):\/\/(file[-_][a-z0-9_-]+)$/iu.exec(pointer)?.[1];
          if (id && !text(resource['name'])) resource['name'] = text(names[`${id}.dat`]) ?? id;
        }
      }
      return await embedOfficialResourceBytes(result, index.platform, async key => {
        const name = index.platform === 'chatgpt' ? path.posix.join(path.posix.dirname(loc.entry), key + '.dat') : index.platform === 'grok' ? path.posix.join(path.posix.dirname(loc.entry), 'prod-mc-asset-server', key, 'content') : loc.entry.slice(0, -5) + '-files/' + key;
        return zip.entries.has(name) ? zip.bytes(name, signal) : undefined;
      }, signal);
    } finally { await zip.close(); }
  } finally { await session?.close(); }
}
