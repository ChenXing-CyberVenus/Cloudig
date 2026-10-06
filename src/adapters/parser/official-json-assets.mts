import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExtractedRecord } from '../../app/parser/record-source.mts';
import { resolveRecordPath } from '../storage/record-store.mts';
import { confinedRelativePath } from '../../core/records/layout.mts';
import { base64Chunks } from './embedded-data.mts';
import { object, list, text } from './official-record.mts';
import type { JsonObject } from '../../core/contracts/types.mts';
import { inspectOfficialJson, officialJsonArrayRanges } from './official-json-layout.mts';
import { parseJsonRange } from './json-array-stream.mts';

export const OFFICIAL_ASSET_LIMITS = Object.freeze({ keyCharacters: 1024, signatureBytes: 4096 });
export function officialAssetLeaf(platform: string, key: string): string {
  if (!['grok', 'mistral'].includes(platform) || !key || key.length > OFFICIAL_ASSET_LIMITS.keyCharacters) throw new TypeError('Invalid official attachment key');
  return createHash('sha256').update(`${platform}\0${key}`, 'utf8').digest('hex') + '.bin';
}
export function officialAssetDirectory(sourcePath: string): string {
  if (!/^Inbox\/[^/\\]+\.json$/iu.test(sourcePath)) throw new TypeError('Official attachment needs its direct Inbox JSON');
  return confinedRelativePath(`${sourcePath}.assets`);
}
export async function officialCompanionBytes(root: string, sourcePath: string): Promise<number> {
  const relative = officialAssetDirectory(sourcePath), directory = await resolveRecordPath(root, relative);
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return 0; throw e; }
  let bytes = 0;
  for (const entry of entries) if (/^[a-f0-9]{64}\.bin$/u.test(entry.name)) {
    const info = await lstat(await resolveRecordPath(root, `${relative}/${entry.name}`));
    if (!info.isFile() || info.isSymbolicLink()) throw new TypeError('Official companion is not an ordinary file');
    bytes += info.size;
  }
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Official companion byte budget is not representable');
  return bytes;
}
export function officialResourceKey(platform: string, resource: JsonObject): string | undefined {
  const name = text(resource['name']);
  if (platform === 'chatgpt') {
    const pointer = text(object(resource['original'])['url']);
    return pointer ? /^(?:file-service|sediment):\/\/(file[-_][a-z0-9_-]+)$/iu.exec(pointer)?.[1] : undefined;
  }
  if (platform === 'mistral') {
    if (!name) return;
    try { confinedRelativePath(name); } catch { return; }
    return name.includes('/') ? undefined : name;
  }
  if (platform !== 'grok') return;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (name && uuid.test(name)) return name;
  const url = text(object(resource['original'])['url']);
  return url ? /(?:^|\/)generated\/([0-9a-f-]{36})\/image\.[a-z]+(?:\?|$)/iu.exec(url)?.[1] : undefined;
}

/** Inspect one native record at a time. The Windows picker receives only these
 * source-backed keys; it never needs to parse the entire export into a DOM. */
export async function collectOfficialCompanions(file: string, signal?: AbortSignal): Promise<{ platform: string; keys: string[] }> {
  const layout = await inspectOfficialJson(file, signal ? { signal } : {}), keys = new Set<string>();
  if (layout.platform !== 'grok' && layout.platform !== 'mistral') return { platform: layout.platform, keys: [] };
  for await (const range of officialJsonArrayRanges(file, layout.range, signal ? { signal } : {})) {
    const parsed = await parseJsonRange(file, range, signal ? { signal } : {}), record = object(parsed.value);
    const messages = layout.platform === 'grok' ? list(record['responses']).map(r => object(object(r)['response'])) : [record];
    for (const message of messages) {
      if (layout.platform === 'mistral') {
        for (const raw of list(message['files'])) { const key = officialResourceKey('mistral', object(raw)); if (key) keys.add(key); }
      } else {
        for (const raw of list(message['file_attachments'])) { const key = officialResourceKey('grok', { name: typeof raw === 'string' ? raw : object(raw)['name'] ?? '' }); if (key) keys.add(key); }
        const urls = list(message['generated_image_urls']).filter((v): v is string => typeof v === 'string');
        for (const raw of list(message['card_attachments_json'])) {
          try { const card = object(typeof raw === 'string' ? JSON.parse(raw) : raw), url = text(object(card['image_chunk'])['imageUrl']); if (url) urls.push(url); } catch { /* Parsing retains this unknown card; it grants no file access. */ }
        }
        for (const url of urls) { const key = officialResourceKey('grok', { original: { url } }); if (key) keys.add(key); }
      }
    }
  }
  return { platform: layout.platform, keys: [...keys] };
}
function mediaType(bytes: Buffer, name?: string): { mime: string; extension: string } {
  const head = bytes.subarray(0, 16);
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: '.png' };
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return { mime: 'image/jpeg', extension: '.jpg' };
  if (['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', extension: '.gif' };
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', extension: '.webp' };
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(bytes.subarray(0, OFFICIAL_ASSET_LIMITS.signatureBytes).toString('utf8'))) return { mime: 'image/svg+xml', extension: '.svg' };
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') return { mime: 'application/pdf', extension: '.pdf' };
  if (head[0] === 80 && head[1] === 75 && bytes.includes(Buffer.from('[Content_Types].xml'))) {
    if (bytes.includes(Buffer.from('word/document.xml'))) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx' };
    if (bytes.includes(Buffer.from('ppt/presentation.xml'))) return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx' };
    if (bytes.includes(Buffer.from('xl/workbook.xml'))) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' };
  }
  const extension = path.extname(name ?? '').toLowerCase(), known: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.tex': 'application/x-tex', '.csv': 'text/csv', '.json': 'application/json' };
  return { mime: known[extension] ?? 'application/octet-stream', extension: extension || '.bin' };
}

/** Companion bytes are imported source material, never a network fetch or
 * cache dependency. A missing companion does not erase its source metadata. */
export async function embedOfficialResources(extracted: ExtractedRecord, root: string, sourcePath: string, platform: string, signal?: AbortSignal): Promise<ExtractedRecord> {
  if (platform !== 'grok' && platform !== 'mistral') return extracted;
  const directory = officialAssetDirectory(sourcePath);
  return embedOfficialResourceBytes(extracted, platform, async key => {
    const relative = `${directory}/${officialAssetLeaf(platform, key)}`, file = await resolveRecordPath(root, relative);
    let before;
    try { before = await lstat(file, { bigint: true }); } catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined; throw e; }
    if (!before.isFile() || before.isSymbolicLink()) throw new TypeError('Official companion is not an ordinary file');
    const bytes = await readFile(file, signal ? { signal } : {}), after = await lstat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size) throw new TypeError('Official companion changed during parsing');
    return bytes;
  }, signal);
}
/** Source readers prove the bytes; embedding semantics are identical for ZIP
 * members and the old direct-JSON companion format. */
export async function embedOfficialResourceBytes(extracted: ExtractedRecord, platform: string, read: (key: string) => Promise<Buffer | undefined>, signal?: AbortSignal): Promise<ExtractedRecord> {
  const resources = list(extracted.parsed.draft['resources']);
  for (const raw of resources) {
    signal?.throwIfAborted(); const resource = object(raw), key = officialResourceKey(platform, resource); if (!key || resource['availability'] === 'embedded') continue;
    const bytes = await read(key); if (!bytes) continue;
    const detected = mediaType(bytes, text(resource['name']));
    resource['availability'] = 'embedded'; resource['mime'] = detected.mime; resource['bytes'] = bytes.length; resource['sha256'] = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length) resource['data_base64'] = base64Chunks(bytes);
    if (detected.mime.startsWith('image/')) resource['kind'] = 'image';
    if ((platform === 'grok' || platform === 'chatgpt') && text(resource['name']) === key) resource['name'] = `${key}${detected.extension}`;
  }
  const canonical = new Map<string, string>(), aliases = new Map<string, string>(), compact: JsonObject[] = [];
  for (const raw of resources) {
    const resource = object(raw), id = String(resource['id']);
    if (resource['availability'] !== 'embedded') { compact.push(resource); continue; }
    // Identical resource metadata and proven bytes may share a resource ID.
    // Every message occurrence remains in place; no message/version is removed.
    const key = JSON.stringify({ ...resource, id: undefined, data_base64: undefined }), prior = canonical.get(key);
    if (prior) aliases.set(id, prior); else { canonical.set(key, id); compact.push(resource); }
  }
  if (aliases.size) extracted.parsed.draft['resources'] = compact;
  // The export calls uploaded pictures 'file_attachments'. Their actual bytes
  // decide image presentation; non-image file cards retain their source place.
  const imageIds = new Set(resources.filter(r => object(r)['kind'] === 'image' && object(r)['availability'] === 'embedded').map(r => object(r)['id']));
  const pending = list(extracted.parsed.draft['messages']).flatMap(m => list(object(m)['content']));
  while (pending.length) {
    const b = object(pending.pop());
    if (b['type'] === 'attachment' && imageIds.has(b['resource'])) b['type'] = 'image';
    for (const field of ['resource', 'rendered', 'input_resource', 'output_resource']) { const alias = aliases.get(String(b[field])); if (alias) b[field] = alias; }
    pending.push(...list(b['content']));
  }
  return extracted;
}
