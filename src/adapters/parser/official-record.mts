import { createHash } from 'node:crypto';
import type { AdapterManifest, SourceMessageFacts } from '../../app/parser/adapter.mts';
import type { ExtractedRecord, CapturedSourceTime } from '../../app/parser/record-source.mts';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/contracts/types.mts';

export const object = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
export const list = (v: unknown): JsonValue[] => Array.isArray(v) ? v : [];
export const text = (v: unknown): string | undefined => typeof v === 'string' && v.length ? v : undefined;
export function nativeTime(value: unknown, unit: 'iso' | 'seconds' | 'milliseconds' = 'iso'): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const date = new Date(unit === 'iso' ? value : Number(value) * (unit === 'seconds' ? 1000 : 1));
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}
export const officialSelector = (platform: string, id: string) => createHash('sha256').update(`${platform}-official\0${id}`).digest('hex');
export const officialManifest = (platform: string): AdapterManifest => {
  const zipped = platform === 'grok' || platform === 'mistral', id = `${platform}-official-json`;
  return { id, version: zipped ? '1.0.2' : '1.0.0', family: platform,
    routes: [{ format: 'json-container', platform, payload: id, profile: 'container' }, ...(zipped ? [{ format: 'zip-container' as const, platform, payload: id, profile: 'container' as const }] : [])],
    target: 'cloudig/conversation/1.0.0', update_from: zipped ? [{ adapter: id, version: '1.0.1', action: 'reparse_source' }] : [] };
};
export type OfficialRecordInput = Readonly<{ record: JsonObject; source: Readonly<{ file: string; bytes: number; sha256: string }>; captured?: CapturedSourceTime }>;
export function finishOfficial(input: OfficialRecordInput, manifest: AdapterManifest, id: string, content: Readonly<{
  messages: JsonObject[]; facts: SourceMessageFacts[]; title?: string; current?: string; created?: string; updated?: string;
  resources?: JsonObject[]; references?: JsonObject[]; limitations?: JsonObject[];
}>): ExtractedRecord {
  const platform = manifest.routes[0]!.platform, dates = content.messages.flatMap(m => text(m['timestamp']) ? [String(m['timestamp'])] : []).sort();
  const models = [...new Set(content.facts.flatMap(f => f.role === 'assistant' && f.model ? [f.model] : []))];
  const known = new Set(content.messages.map(m => m['id'])), limitations = [...content.limitations ?? []];
  if (content.facts.some(f => f.parent && !known.has(f.parent))) limitations.push({ code: 'source_parent_omitted', detail: 'Native parent absent from the export; its edge is preserved without inventing a replacement.' });
  if (content.current && !known.has(content.current)) limitations.push({ code: 'source_current_omitted', detail: 'The export names a selected message absent from its message pool; no replacement default was invented.' });
  const draft: JsonObject = { platform, source: { ...input.source, format: 'json-container', locator: officialSelector(platform, id),
    ...(content.created ? { conversation_created_at: content.created } : {}), ...(content.updated ? { conversation_updated_at: content.updated } : {}) },
    messages: content.messages, ...(content.title ? { title: content.title } : {}), ...(models.length ? { models } : {}),
    ...(dates.length ? { message_time: { start: dates[0]!, end: dates.at(-1)! } } : {}),
    ...(content.resources?.length ? { resources: content.resources } : {}), ...(content.references?.length ? { sources: content.references } : {}), ...(limitations.length ? { limitations } : {}) };
  return { parsed: { draft, adapter: manifest, sourceFingerprint: { bytes: input.source.bytes, sha256: input.source.sha256 }, systemLogErrors: [] },
    facts: { messages: content.facts, ...(content.current && known.has(content.current) ? { current: content.current } : {}), ...(input.captured ? { captured: input.captured } : {}) } };
}

/** An export URL is source evidence, not permission for a Parser network fetch. */
export function metadataResource(resources: JsonObject[], input: Readonly<{ kind?: string; name?: string; mime?: string; bytes?: number; url?: string }>): string {
  const resource: JsonObject = { id: `r${resources.length + 1}`, kind: input.kind ?? 'file', availability: 'metadata_only',
    ...(input.name ? { name: input.name } : {}), ...(input.mime ? { mime: input.mime } : {}),
    ...(Number.isSafeInteger(input.bytes) && input.bytes! >= 0 ? { bytes: input.bytes! } : {}), ...(input.url ? { original: { url: input.url } } : {}) };
  resources.push(resource); return String(resource['id']);
}
