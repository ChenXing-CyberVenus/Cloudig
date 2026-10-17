import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';
import type { SourceMessageFacts } from '../../app/parser/adapter.mts';
import { projectMarkdownWithDiagrams } from './markdown-diagrams.mts';
import { object, list, text, nativeTime, officialManifest, finishOfficial, metadataResource, type OfficialRecordInput } from './official-record.mts';

export const MISTRAL_OFFICIAL_MANIFEST = officialManifest('mistral');
export type MistralOfficialInput = Omit<OfficialRecordInput, 'record'> & Readonly<{ records: readonly JsonObject[] }>;
function coveredByFragments(body: string, fragments: readonly string[]): boolean {
  let remaining = body;
  // This compares two representations inside one native message only. It is
  // not deduplication of messages, versions, canvases or repeated occurrences.
  for (const fragment of fragments) if (fragment) remaining = remaining.replace(fragment, '');
  return !remaining.trim();
}
/** No parent graph is present in this export. The readable projection is a
 * chronology, not a guessed native tree. Revisions and repeated rows survive. */
export function extractMistralOfficial(input: MistralOfficialInput) {
  const id = text(input.records[0]?.['chatId']); if (!id) throw new TypeError('Mistral export has no chatId');
  const rows = input.records.map((raw, ordinal) => {
    if (!isJsonObject(raw) || raw['chatId'] !== id || !text(raw['id']) || !['user', 'assistant', 'system', 'tool'].includes(String(raw['role'])) || !Number.isSafeInteger(raw['version']) || Number(raw['version']) < 0) throw new TypeError('Mistral message identity, version or chatId is invalid');
    return { raw, ordinal, timestamp: nativeTime(raw['createdAt']) };
  }).sort((a, b) => a.timestamp && b.timestamp ? a.timestamp.localeCompare(b.timestamp) || a.ordinal - b.ordinal : Number(!a.timestamp) - Number(!b.timestamp) || a.ordinal - b.ordinal);
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], resources: JsonObject[] = [], references: JsonObject[] = [], seen = new Map<string, number>();
  const nativeReferences = new Map<string, JsonObject>(), referenceIds = new Map<string, string>(), ambiguousReferences = new Set<string>();
  for (const { raw } of rows) for (const chunk of list(raw['contentChunks'])) {
    for (const [key, result] of Object.entries(object(object(chunk)['publicResult']))) if (isJsonObject(result) && text(result['url'])) {
      const old = nativeReferences.get(key);
      if (old && (old['url'] !== result['url'] || old['title'] !== result['title'])) ambiguousReferences.add(key);
      else nativeReferences.set(key, result);
    }
  }
  const reference = (key: string): string => {
    const prior = referenceIds.get(key); if (prior) return prior;
    const raw = ambiguousReferences.has(key) ? undefined : nativeReferences.get(key), id = `s${references.length + 1}`;
    const value: JsonObject = { id, kind: raw ? 'web' : 'other' };
    if (raw) {
      value['url'] = raw['url']!; if (text(raw['title'])) value['title'] = raw['title']!;
      const snippets = list(raw['snippets']).filter((v): v is string => typeof v === 'string');
      const snippet = snippets.join('\n\n') || text(raw['description']); if (snippet) value['snippet'] = snippet;
    } else value['text'] = key;
    references.push(value); referenceIds.set(key, id); return id;
  };
  const limitations: JsonObject[] = [{ code: 'official_branch_graph_unavailable', detail: 'The Mistral export has no parent/selected-branch fields. All exported occurrences and versions are retained in timestamp order as a readable chronology, not a reconstructed native tree.' }];
  for (const { raw, timestamp } of rows) {
    const baseId = JSON.stringify([raw['id'], raw['version']]), occurrence = (seen.get(baseId) ?? 0) + 1; seen.set(baseId, occurrence);
    const messageId = JSON.stringify([raw['id'], raw['version'], occurrence]), role = String(raw['role']), content: JsonObject[] = [];
    const chunks = list(raw['contentChunks']), canvases = list(raw['canvas']).filter(isJsonObject), usedCanvases = new Set<JsonObject>(), represented: string[] = [], answers: string[] = [];
    const canvas = (value: JsonObject) => {
      usedCanvases.add(value); const body = text(value['content']);
      if (body) { represented.push(body); content.push(...projectMarkdownWithDiagrams(body)); }
      else content.push({ type: 'unknown', kind: 'mistral-canvas', text: JSON.stringify(value) });
    };
    for (const value of chunks) {
      const block = object(value), kind = block['type'];
      if (kind === 'text' && typeof block['text'] === 'string') {
        const body = block['text'], context = object(block['_context']); represented.push(body);
        if (context['type'] === 'reasoning') {
          const duration = (Number(context['endTime']) - Number(context['startTime'])) / 1000;
          content.push({ type: 'reasoning', text: body, format: 'markdown', ...(Number.isFinite(duration) && duration >= 0 ? { duration } : {}) });
        } else { answers.push(body); content.push(...projectMarkdownWithDiagrams(body)); }
      } else if (kind === 'tool_call') {
        const name = text(block['name']), call = text(block['id']), duration = (Number(block['endTime']) - Number(block['startTime'])) / 1000;
        content.push({ type: 'tool', kind: 'activity', ...(name ? { name, title: name } : {}), ...(call ? { call } : {}),
          ...(typeof block['success'] === 'boolean' ? { success: block['success'] } : {}), ...(Number.isFinite(duration) && duration >= 0 ? { duration } : {}),
          ...(block['publicArguments'] != null ? { input: block['publicArguments'] } : {}), ...(block['publicResult'] != null || block['result'] != null ? { output: block['publicResult'] ?? block['result']! } : {}) });
        const ids = Object.entries(object(block['publicResult'])).filter(([, raw]) => text(object(raw)['url'])).map(([key]) => reference(key));
        if (ids.length) content.push({ type: 'search', ...(text(block['publicArguments']) ? { query: block['publicArguments']! } : {}), sources: ids });
      } else if (kind === 'canva') {
        const exact = canvases.filter(c => c['id'] === block['id'] && c['version'] === block['version']);
        const selected = exact.length === 1 ? exact[0] : canvases.length === 1 && chunks.filter(c => object(c)['type'] === 'canva').length === 1 ? canvases[0] : undefined;
        if (selected) canvas(selected); else content.push({ type: 'unknown', kind: 'mistral-canvas-reference', text: JSON.stringify(value) });
      } else if (kind === 'draft_canva') {
        if (text(block['content'])) represented.push(String(block['content']));
        content.push({ type: 'tool', kind: 'activity', name: 'write_canvas', title: text(block['title']) ?? 'Canvas draft', output: block });
      }
      else if (kind === 'image_url' && text(block['imageUrl'])) content.push({ type: 'image', resource: metadataResource(resources, { kind: 'image', url: String(block['imageUrl']) }) });
      else if (kind === 'reference') {
        const ids = list(block['referenceIds']).map(id => reference(String(id)));
        if (ids.length) content.push({ type: 'citations', sources: ids });
      } else {
        content.push({ type: 'unknown', kind: `mistral-${String(kind ?? 'chunk')}`, text: JSON.stringify(value) });
        limitations.push({ code: 'official_fragment_unmapped', detail: `Mistral ${String(kind ?? '(no type)')} retained as data` });
      }
    }
    for (const value of canvases) if (!usedCanvases.has(value)) canvas(value);
    const body = text(raw['content']);
    if (body && body !== represented.join('') && body !== answers.join('') && !coveredByFragments(body, represented)) content.push(...projectMarkdownWithDiagrams(body));
    for (const value of list(raw['files'])) {
      const file = object(value), name = text(file['name']), kind = file['type'] === 'image' ? 'image' : 'file';
      content.push({ type: kind === 'image' ? 'image' : 'attachment', resource: metadataResource(resources, { kind, ...(name ? { name } : {}) }) });
    }
    // Reader already reads every disconnected source component in item order.
    // Chronological display therefore needs no invented parent edges.
    messages.push({ id: messageId, role, ...(timestamp ? { timestamp } : {}), content });
    facts.push({ id: messageId, role });
  }
  const dates = rows.flatMap(r => r.timestamp ? [r.timestamp] : []), created = dates[0], updated = dates.at(-1);
  const extracted = finishOfficial({ ...input, record: {} }, MISTRAL_OFFICIAL_MANIFEST, id, { messages, facts, resources, references, limitations,
    ...(created ? { created } : {}), ...(updated ? { updated } : {}) });
  return { ...extracted, facts: { ...extracted.facts, singleConversationFile: true } };
}
