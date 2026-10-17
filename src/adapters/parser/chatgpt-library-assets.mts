import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';
import type { ExtractedRecord } from '../../app/parser/record-source.mts';
import { list, object, text, metadataResource } from './official-record.mts';
import { officialResourceKey, OFFICIAL_ASSET_LIMITS } from './official-json-assets.mts';
import { referencedResources } from '../../core/records/conversation-images.mts';

/** The library is an independent source index, not an extra conversation or
 * permission to guess an absent turn from a filename/date. Conflicting owners
 * stay in the original ZIP rather than being attached to both conversations. */
export function chatGptLibraryAssets(record: JsonObject, library: unknown): JsonObject[] {
  const conversation = text(record['conversation_id']) ?? text(record['id']);
  const mapping = object(record['mapping']);
  return list(library).filter(isJsonObject).filter(file => {
    const id = text(file['file_id']);
    if (!id || id.length > OFFICIAL_ASSET_LIMITS.keyCharacters || !/^file[-_][a-z0-9_-]+$/iu.test(id) || !String(file['mime_type'] ?? '').startsWith('image/')) return false;
    const owners = [...new Set([text(file['origination_thread_id']), text(file['initiating_conversation_id'])].filter(Boolean))];
    const message = text(file['origination_message_id']);
    return owners.length ? owners.length === 1 && owners[0] === conversation : !!message && Object.hasOwn(mapping, message);
  });
}

export function attachChatGptLibraryAssets(extracted: ExtractedRecord, record: JsonObject, library: unknown, hasBytes: (key: string) => boolean): void {
  const draft = extracted.parsed.draft;
  const resources = list(draft['resources']).filter(isJsonObject);
  const messages = list(draft['messages']).filter(isJsonObject);
  for (const file of chatGptLibraryAssets(record, library)) {
    const key = String(file['file_id']);
    if (!hasBytes(key)) continue;
    let resource = resources.find(r => officialResourceKey('chatgpt', r) === key);
    if (!resource) {
      metadataResource(resources, { kind: 'image', url: `file-service://${key}`,
        ...(text(file['file_name']) ? { name: String(file['file_name']) } : {}) });
      resource = resources.at(-1)!;
    }
    // Native library origination_message_id may name the last assistant turn
    // even for a later upload. Require corroborating file identity in the
    // actual message; mere node existence/date/filename is not placement proof.
    const origin = text(file['origination_message_id']);
    const sourceMessage = origin ? object(object(object(record['mapping'])[origin])['message']) : {};
    const pending: unknown[] = [sourceMessage]; let corroborated = false;
    while (pending.length && !corroborated) {
      const value = pending.pop();
      if (typeof value === 'string') corroborated = [key, `file-service://${key}`, `sediment://${key}`].includes(value);
      else if (value && typeof value === 'object') pending.push(...Object.values(value));
    }
    const target = corroborated ? messages.find(m => m['id'] === origin) : undefined;
    if (target) {
      const content = list(target['content']).filter(isJsonObject);
      if (!referencedResources(content).has(String(resource['id']))) content.push({ type: 'image', resource: resource['id']! });
      target['content'] = content;
    }
  }
  if (resources.length) draft['resources'] = resources;
}
