import { readFile } from 'node:fs/promises';
import type { JsonObject } from '../../core/contracts/types.mts';
import type { BuiltinIdentity } from '../../core/library/overlay.mts';
import { resolveRecordPath } from '../storage/record-store.mts';
import { fingerprintFile } from '../storage/stream.mts';
import { inspectRecordConversation } from './record-resource.mts';
import { resolveRecordPresentation } from '../../core/records/presentation.mts';

/** Bundled public documents only. No Library catalog, Mark, parse history or write capability. */
export class PublicExamples {
  readonly root: string;
  readonly builtins: BuiltinIdentity;
  constructor(root: string, builtins: BuiltinIdentity) { this.root = root; this.builtins = builtins; }
  async entry(id: unknown) {
    if (typeof id !== 'string' || !/^example-[a-f0-9]{20}$/u.test(id)) throw new TypeError('Invalid public example ID');
    const manifest = JSON.parse(await readFile(await resolveRecordPath(this.root, 'manifest.json'), 'utf8'));
    if (manifest.format !== 'cloudig/public-examples/1' || !Array.isArray(manifest.examples)) throw new TypeError('Invalid public example manifest');
    const entries = manifest.examples.filter((e: any) => e.id === id);
    if (entries.length !== 1) throw new TypeError('Public example is not in this package');
    const e = entries[0];
    if (e.record?.path !== `records/${id}.json` || typeof e.html?.file !== 'string' || !/^[^\\/:\x00-\x1f]+\.html$/u.test(e.html.file) || e.html.path !== `html/${e.html.file}`
      || !/^[a-f0-9]{64}$/u.test(e.html.sha256) || !/^[a-f0-9]{64}$/u.test(e.record.sha256)) throw new TypeError('Invalid public example paths or fingerprints');
    return e;
  }
  async original(id: unknown, signal?: AbortSignal) {
    const entry = await this.entry(id), file = await resolveRecordPath(this.root, entry.html.path);
    const actual = await fingerprintFile(file, signal);
    if (actual.sha256 !== entry.html.sha256 || actual.bytes !== entry.html.bytes) throw new TypeError('Public HTML differs from the bundled example');
    return { path: file };
  }
  async reading(id: unknown, language: 'zh-CN' | 'en', signal?: AbortSignal) {
    const entry = await this.entry(id), record = await inspectRecordConversation(await resolveRecordPath(this.root, entry.record.path), signal);
    if (record.fingerprint.sha256 !== entry.record.sha256 || record.fingerprint.bytes !== entry.record.bytes) throw new TypeError('Public Conversation differs from the bundled example');
    const source = record.conversation['source'] as JsonObject;
    if (source['sha256'] !== entry.html.sha256 || record.conversation['conversation_id'] !== entry.record.conversation_id) throw new TypeError('Public HTML and Conversation do not match');
    const resolved = resolveRecordPresentation({ conversation: record.conversation, language, bindings: {}, identities: new Map(), builtins: this.builtins, availableAssets: new Set() });
    return { conversation: record.conversation, resourceBodies: record.resourceBodies, resolved,
      evidence: { conversation: { path: entry.record.path as string, sha256: entry.record.sha256 as string }, mark: null }, issues: [] };
  }
}
