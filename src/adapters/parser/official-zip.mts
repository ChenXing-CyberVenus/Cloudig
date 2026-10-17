import { openPromise, type Entry, type ZipFile } from 'yauzl';
import { lstat, mkdir } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import path from 'node:path';
import { parseRecordJson } from '../../core/records/json.mts';
import { isJsonObject } from '../../core/contracts/types.mts';
import { writeOwnedStagingFile, fingerprintFile } from '../storage/stream.mts';

export const OFFICIAL_ZIP_LIMITS = Object.freeze({ entries: 100000, pathBytes: 4096, memberBytes: 4 * 1024 ** 3, metadataBytes: 16 * 1024 ** 2 });
export type OfficialZipPlatform = 'grok' | 'mistral' | 'chatgpt';
export type ZipLayout = Readonly<{ platform: OfficialZipPlatform; jsonEntries: readonly string[]; resourceBytes: number }>;
export type ZipWorkspace = Readonly<{ sourceStamp: string; files: Readonly<Record<string, string>> }>;
export const zipSourceStamp = async (file: string): Promise<string> => {
  const s = await lstat(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) throw new TypeError('ZIP source must be an ordinary file');
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
};
/** Paths stay inside the ZIP; they are never used as filesystem output paths. */
export function normalizedZipPath(name: string): string {
  if (!name || Buffer.byteLength(name) > OFFICIAL_ZIP_LIMITS.pathBytes || /^[\\/]|^[a-z]:/iu.test(name) || /[\\\x00-\x1f]/u.test(name)) throw new TypeError('Unsafe ZIP member path');
  const parts = name.split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '.' || p === '..')) throw new TypeError('Unsafe ZIP member path');
  return parts.join('/');
}
export function zipRecordSelector(entry: string, selector: string): string {
  if (!/^[a-f0-9]{64}$/u.test(selector)) throw new TypeError('Invalid ZIP record selector');
  return `zip:${encodeURIComponent(normalizedZipPath(entry))}#${selector}`;
}
export function splitZipRecordSelector(value: string): { entry: string; selector: string } {
  const match = /^zip:(.+)#([a-f0-9]{64})$/u.exec(value);
  if (!match) throw new TypeError('Invalid ZIP record locator');
  const entry = normalizedZipPath(decodeURIComponent(match[1]!));
  if (zipRecordSelector(entry, match[2]!) !== value) throw new TypeError('Noncanonical ZIP record locator');
  return { entry, selector: match[2]! };
}
export class OfficialZip {
  readonly file: string; readonly handle: ZipFile; readonly entries: ReadonlyMap<string, Entry>; readonly stamp: string;
  private constructor(file: string, handle: ZipFile, entries: ReadonlyMap<string, Entry>, stamp: string) { this.file=file; this.handle=handle; this.entries=entries; this.stamp=stamp; }
  static async open(file: string, signal?: AbortSignal): Promise<OfficialZip> {
    signal?.throwIfAborted(); const stamp = await zipSourceStamp(file);
    let zip: ZipFile;
    try { zip = await openPromise(file, { autoClose: false, validateEntrySizes: true, strictFileNames: true }); }
    catch (error) { throw new TypeError(`无法读取ZIP，请确认复制已完成且压缩包完整。 / Cannot read ZIP; finish copying and check the archive. ${error instanceof Error ? error.message : ''}`); }
    const entries = new Map<string, Entry>();
    try {
      let count = 0;
      for await (const entry of zip.eachEntry()) {
        signal?.throwIfAborted();
        if (++count > OFFICIAL_ZIP_LIMITS.entries) throw new TypeError('ZIP has too many entries');
        const name = normalizedZipPath(entry.fileName);
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new TypeError('ZIP symbolic links are not supported');
        if (entry.fileName.endsWith('/')) continue;
        if (entries.has(name)) throw new TypeError('ZIP contains ambiguous duplicate paths');
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw new TypeError('Invalid ZIP member size');
        entries.set(name, entry);
      }
      if (await zipSourceStamp(file) !== stamp) throw new TypeError('ZIP changed while reading; finish copying and refresh');
      return new OfficialZip(file, zip, entries, stamp);
    } catch (error) { zip.close(); signal?.throwIfAborted(); throw new TypeError(`Invalid ZIP directory: ${error instanceof Error ? error.message : String(error)}`); }
  }
  layout(): ZipLayout {
    const names = [...this.entries.keys()];
    const grok = names.filter(n => path.posix.basename(n) === 'prod-grok-backend.json');
    const mistral = names.filter(n => /^chat-[^/]+\.json$/u.test(path.posix.basename(n)) && !n.split('/').some(p => p.endsWith('-files') || p === 'knowledge'));
    const chatgpt = names.filter(n => /^conversations(?:-\d+)?\.json$/u.test(path.posix.basename(n)));
    if (chatgpt.length && !grok.length && !mistral.length && new Set(chatgpt.map(n => path.posix.dirname(n))).size === 1) {
      if (chatgpt.length > 1 && chatgpt.some(n => path.posix.basename(n) === 'conversations.json')) throw new TypeError('Mixed whole and sharded ChatGPT conversations');
      const directory = path.posix.dirname(chatgpt[0]!);
      return { platform: 'chatgpt', jsonEntries: chatgpt.sort(), resourceBytes: this.#resourceBytes(n => path.posix.dirname(n) === directory && n.endsWith('.dat')) };
    }
    if (chatgpt.length || names.some(n => /(?:^|\/)Conversations__[^/]+\.zip$/u.test(n)))
      throw new TypeError('请选择内层Conversations会话ZIP，不选择OpenAI隐私总包。 / Choose the inner Conversations ZIP, not the OpenAI privacy bundle.');
    if (grok.length === 1 && !mistral.length) {
      const prefix = path.posix.join(path.posix.dirname(grok[0]!), 'prod-mc-asset-server') + '/';
      return { platform: 'grok', jsonEntries: grok, resourceBytes: this.#resourceBytes(n => n.startsWith(prefix)) };
    }
    if (!grok.length && mistral.length && new Set(mistral.map(n => path.posix.dirname(n))).size === 1) {
      const prefixes = mistral.map(n => n.slice(0, -5) + '-files/');
      return { platform: 'mistral', jsonEntries: mistral.sort(), resourceBytes: this.#resourceBytes(n => prefixes.some(p => n.startsWith(p))) };
    }
    throw new TypeError('不支持的官方ZIP结构，或压缩包混合了多套导出。 / Unsupported or mixed official ZIP export.');
  }
  #resourceBytes(predicate: (name: string) => boolean): number {
    let total = 0; for (const [name, entry] of this.entries) if (predicate(name)) total += entry.uncompressedSize;
    if (!Number.isSafeInteger(total)) throw new TypeError('ZIP resource size is not representable'); return total;
  }
  async metadata(name: string, signal?: AbortSignal) {
    const entry = this.entries.get(name); if (!entry) return undefined;
    if (entry.uncompressedSize > OFFICIAL_ZIP_LIMITS.metadataBytes) throw new TypeError('ZIP metadata exceeds its supported size');
    return parseRecordJson(new TextDecoder('utf-8', { fatal: true }).decode(await this.bytes(name, signal)));
  }
  async validatedLayout(signal?: AbortSignal): Promise<ZipLayout> {
    const layout = this.layout(); if (layout.platform !== 'chatgpt') return layout;
    const directory = path.posix.dirname(layout.jsonEntries[0]!);
    const manifest = await this.metadata(path.posix.join(directory, 'export_manifest.json'), signal);
    if (manifest === undefined) {
      if (layout.jsonEntries.length !== 1 || path.posix.basename(layout.jsonEntries[0]!) !== 'conversations.json') throw new TypeError('ChatGPT分片包缺少export_manifest.json。 / Sharded ChatGPT ZIP needs export_manifest.json.');
      return layout;
    }
    if (!isJsonObject(manifest) || !isJsonObject(manifest['logical_files']) || !isJsonObject(manifest['logical_files']['conversations.json'])) throw new TypeError('Invalid ChatGPT export manifest');
    const declaration = manifest['logical_files']['conversations.json'], files = declaration['files'];
    if (!Array.isArray(files) || files.some(n => typeof n !== 'string') || (declaration['sharded'] === true && declaration['shard_count'] !== files.length)) throw new TypeError('Invalid ChatGPT shard declaration');
    const members = files.map(n => path.posix.join(directory, normalizedZipPath(String(n))));
    if (new Set(members).size !== members.length || members.length !== layout.jsonEntries.length || members.some(n => !layout.jsonEntries.includes(n))) throw new TypeError('ChatGPT会话分片不完整或与清单不符。 / ChatGPT conversation shards are incomplete or disagree with the manifest.');
    if (Array.isArray(manifest['export_files'])) for (const raw of manifest['export_files']) {
      if (!isJsonObject(raw) || typeof raw['path'] !== 'string') throw new TypeError('Invalid ChatGPT file manifest');
      const name = path.posix.join(directory, normalizedZipPath(raw['path']));
      if (members.includes(name) && raw['size_bytes'] !== this.entries.get(name)?.uncompressedSize) throw new TypeError('ChatGPT shard size disagrees with manifest');
    }
    return { ...layout, jsonEntries: members };
  }
  async *chunks(name: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    signal?.throwIfAborted(); const entry = this.entries.get(normalizedZipPath(name));
    if (!entry) throw new TypeError('ZIP member is missing');
    if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new TypeError('Encrypted or unsupported ZIP compression');
    if (entry.uncompressedSize > OFFICIAL_ZIP_LIMITS.memberBytes) throw new TypeError('ZIP member exceeds the supported size limit');
    const stream = await this.handle.openReadStreamPromise(entry); let size = 0, crc = 0;
    const abort = () => stream.destroy(new DOMException('ZIP read cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of stream) { signal?.throwIfAborted(); const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > entry.uncompressedSize) throw new TypeError('ZIP expanded beyond its declared size');
        crc = crc32(bytes, crc); yield bytes;
      }
      if (size !== entry.uncompressedSize || crc !== entry.crc32) throw new TypeError('ZIP member size or CRC does not match');
      if (await zipSourceStamp(this.file) !== this.stamp) throw new TypeError('ZIP changed while reading; refresh before parsing');
    } finally { signal?.removeEventListener('abort', abort); stream.destroy(); }
  }
  async bytes(name: string, signal?: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = []; for await (const chunk of this.chunks(name, signal)) chunks.push(chunk); return Buffer.concat(chunks);
  }
  async stage(name: string, directory: string, signal?: AbortSignal, onProgress?: (bytes: number) => void) {
    const target = path.join(directory, createHash('sha256').update(name).digest('hex') + '.json');
    // Decompressed JSON is scoped cache, never a committed user record.
    const fingerprint = await writeOwnedStagingFile(Readable.from(this.chunks(name, signal)), target, { durable: false, ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) });
    return { file: target, ...fingerprint };
  }
  async close(): Promise<void> { if (!this.handle.isOpen) return; const closed = once(this.handle, 'close'); this.handle.close(); await closed; }
}
export async function inspectOfficialZip(file: string, signal?: AbortSignal): Promise<ZipLayout> {
  const zip = await OfficialZip.open(file, signal); try { return await zip.validatedLayout(signal); } finally { await zip.close(); }
}
export async function prepareOfficialZipWorkspace(file: string, expected: { sha256: string; bytes: number }, names: readonly string[], directory: string, signal?: AbortSignal, onProgress?: (bytes: number, total: number) => void): Promise<ZipWorkspace> {
  const zip = await OfficialZip.open(file, signal);
  try {
    const fingerprint = await fingerprintFile(file, signal);
    if (fingerprint.sha256 !== expected.sha256 || fingerprint.bytes !== expected.bytes || await zipSourceStamp(file) !== zip.stamp) throw new TypeError('ZIP changed; rebuild its index');
    const allowed = new Set((await zip.validatedLayout(signal)).jsonEntries), selected = [...new Set(names)];
    if (selected.some(n => !allowed.has(n))) throw new TypeError('Index selected a non-conversation ZIP member');
    await mkdir(directory, { recursive: false });
    const files: Record<string, string> = {}, total = selected.reduce((n, key) => n + zip.entries.get(key)!.uncompressedSize, 0); let completed = 0;
    for (const name of selected) { const staged = await zip.stage(name, directory, signal, bytes => onProgress?.(completed + bytes, total)); files[name] = staged.file; completed += staged.bytes; }
    return { sourceStamp: zip.stamp, files };
  } finally { await zip.close(); }
}
