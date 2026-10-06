import type { AdapterManifest, SourceMessageFacts } from '../../app/parser/adapter.mts';
import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';
import { projectMarkdownWithDiagrams } from './markdown-diagrams.mts';
import { CHATGPT_DIL_SOURCE, savedDil } from './chatgpt-dil.mts';
import { object, list, text, nativeTime, finishOfficial, metadataResource, type OfficialRecordInput } from './official-record.mts';

export const CHATGPT_OFFICIAL_MANIFEST: AdapterManifest = {
  id: 'chatgpt-official-json', version: '1.0.2', family: 'chatgpt',
  routes: [{ format: 'zip-container', platform: 'chatgpt', payload: 'chatgpt-official-json', profile: 'container' }],
  target: 'cloudig/conversation/1.0.1', update_from: [{ adapter: 'chatgpt-official-json', version: '1.0.1', action: 'reparse_source' }]
};
export const chatGptOfficialId = (record: JsonObject): string => {
  const id = text(record['conversation_id']) ?? text(record['id']);
  if (!id) throw new TypeError('ChatGPT conversation has no source identity');
  return id;
};

/** The mapping owns edges; children[] owns sibling order. Empty structural
 * nodes remain in the graph, without inventing a visible system utterance. */
export function chatGptOfficialNodes(record: JsonObject): [string, JsonObject][] {
  chatGptOfficialId(record);
  if (record['mapping'] === null) return [];
  if (!isJsonObject(record['mapping'])) throw new TypeError('ChatGPT conversation needs a mapping');
  const mapping = record['mapping'], keys = Object.keys(mapping), children = new Map<string, string[]>();
  for (const key of keys) {
    const node = mapping[key];
    if (!isJsonObject(node) || node['id'] !== key || node['message'] !== null && !isJsonObject(node['message'])) throw new TypeError('Invalid ChatGPT mapping node');
    const parent = text(node['parent']);
    if (parent) children.set(parent, [...children.get(parent) ?? [], key]);
  }
  for (const key of keys) {
    const declared = list(object(mapping[key])['children']);
    if (declared.some(v => typeof v !== 'string') || new Set(declared).size !== declared.length) throw new TypeError('Invalid ChatGPT child list');
    for (const child of declared) if (mapping[String(child)] && object(mapping[String(child)])['parent'] !== key) throw new TypeError('ChatGPT parent and child edges disagree');
    const actual = children.get(key) ?? [], ordered = declared.filter((v): v is string => typeof v === 'string' && actual.includes(v));
    children.set(key, [...ordered, ...actual.filter(id => !ordered.includes(id))]);
  }
  const result: [string, JsonObject][] = [], visited = new Set<string>();
  const roots = keys.filter(k => !text(object(mapping[k])['parent']) || !mapping[String(object(mapping[k])['parent'])]);
  const pending = roots.reverse();
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) throw new TypeError('ChatGPT mapping contains a repeated edge');
    visited.add(key); result.push([key, object(mapping[key])]); pending.push(...[...children.get(key) ?? []].reverse());
  }
  if (result.length !== keys.length) throw new TypeError('ChatGPT mapping contains a parent cycle');
  return result;
}

const http = (v: unknown) => typeof v === 'string' && /^https?:\/\//iu.test(v) ? v : undefined;
const escapeLabel = (v: string) => v.replace(/[\\\[\]]/gu, '\\$&');
const slug = (v: string) => `chatgpt-${v.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').slice(0, 100) || 'content'}`;

export function extractChatGptOfficial(input: OfficialRecordInput) {
  const record = input.record, id = chatGptOfficialId(record), messages: JsonObject[] = [], facts: SourceMessageFacts[] = [];
  const resources: JsonObject[] = [], references: JsonObject[] = [], limitations: JsonObject[] = [], resourceIds = new Map<string, string>();
  const limit = (code: string, detail: string) => { if (!limitations.some(l => l['code'] === code && l['detail'] === detail)) limitations.push({ code, detail }); };
  function resource(pointer: string, value: JsonObject = {}, kind = 'file'): string {
    const canonical = pointer.replace(/^sediment:\/\/(file[-_][a-z0-9_-]+)$/iu, 'file-service://$1');
    const existing = resourceIds.get(canonical);
    if (existing) {
      const known = resources.find(r => r['id'] === existing)!;
      if (!known['name'] && text(value['name'])) known['name'] = value['name']!;
      if (!known['mime'] && text(value['mime_type'])) known['mime'] = value['mime_type']!;
      if (kind === 'image') known['kind'] = 'image';
      return existing;
    }
    const name = text(value['name']), mime = text(value['mime_type']), bytes = value['size'] ?? value['size_bytes'];
    const key = metadataResource(resources, { kind, url: pointer, ...(name ? { name } : {}), ...(mime ? { mime } : {}), ...(typeof bytes === 'number' ? { bytes } : {}) });
    const width = value['width'], height = value['height'];
    if (Number.isSafeInteger(width) && Number(width) > 0 && Number.isSafeInteger(height) && Number(height) > 0) resources.at(-1)!['dimensions'] = { width: width!, height: height! };
    resourceIds.set(canonical, key); return key;
  }
  function reference(raw: JsonObject): string | undefined {
    const url = http(raw['url']) ?? http(raw['cloud_doc_url']), title = text(raw['title']) ?? text(raw['display_title']) ?? text(raw['name']), snippet = text(raw['snippet']) ?? text(raw['description']);
    if (!url && !title && !snippet) return;
    const ref: JsonObject = { id: `s${references.length + 1}`, kind: raw['type'] === 'file' ? 'file' : url ? 'web' : 'other', ...(url ? { url } : {}), ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) };
    references.push(ref); return String(ref['id']);
  }
  for (const [key, node] of chatGptOfficialNodes(record)) {
    const raw = object(node['message']), author = object(raw['author']), metadata = object(raw['metadata']), body = object(raw['content']);
    const role = node['message'] === null ? 'system' : text(author['role']); if (!role) throw new TypeError('ChatGPT message has no author role');
    const content: JsonObject[] = [], refs: string[] = [], replacements = new Map<string, string>(), referenceExtras: JsonObject[] = [];
    const cards = new Map<string, JsonObject>();
    for (const value of list(metadata['content_references'])) {
      const ref = object(value), type = String(ref['type']), token = text(ref['matched_text']);
      if (type === 'dil' && isJsonObject(ref['dil'])) {
        const card: JsonObject = { type: 'interactive', display: 'box', source: CHATGPT_DIL_SOURCE, format: 'structured', data: ref };
        if (token?.trim()) cards.set(token, card); else referenceExtras.push(card);
        if (!savedDil(ref)) limit('official_fragment_unmapped', 'ChatGPT DIL retained as source data; this native card layout is not yet recognized.');
        continue;
      }
      const pending: JsonObject[] = [ref];
      while (pending.length) {
        const r = pending.pop()!, added = reference(r); if (added) refs.push(added);
        for (const field of ['sources', 'items', 'entries']) pending.push(...list(r[field]).filter(isJsonObject));
        if (isJsonObject(r['item'])) pending.push(r['item']);
      }
      let fallback = typeof ref['alt'] === 'string' ? ref['alt'] : text(ref['prompt_text']);
      const url = http(ref['url']) ?? http(object(ref['item'])['url']);
      if (fallback === undefined && url) fallback = `[${escapeLabel(text(ref['title']) ?? url)}](<${url.replace(/>/gu, '%3E')}>)`;
      if (fallback === undefined && type === 'entity') fallback = text(ref['name']);
      if (type === 'hidden') fallback = '';
      if (type === 'file') {
        const fileId = text(ref['id']); if (fileId) referenceExtras.push({ type: 'attachment', resource: resource(`file-service://${fileId}`, ref) });
        fallback ??= text(ref['name']);
      }
      if (type === 'image_group') for (const rawImage of list(ref['images'])) {
        const image = object(object(rawImage)['image_result']), imageUrl = http(image['content_url']) ?? http(image['thumbnail_url']);
        if (imageUrl) referenceExtras.push({ type: 'image', resource: resource(imageUrl, { name: image['title'] ?? 'Image' }, 'image'), ...(text(image['title']) ? { alt: image['title']! } : {}) });
        const imageRef = reference(image); if (imageRef) refs.push(imageRef);
      }
      if (fallback === undefined && ['navigation', 'sources_footnote', 'grouped_webpages', 'image_group', 'file_navlist'].includes(type)) fallback = '';
      if (fallback === undefined) {
        fallback = text(ref['name']) ?? text(ref['title']) ?? '';
        referenceExtras.push({ type: 'unknown', kind: slug(type), text: JSON.stringify(ref) });
        limit('official_fragment_unmapped', `ChatGPT ${type} retained as source data without executing it.`);
      }
      // Empty/whitespace markers are source-list anchors, not text replacements.
      if (token?.trim() && /[\uE200-\uE2FF]|【/u.test(token)) replacements.set(token, fallback);
    }
    const markdown = (value: string): JsonObject[] => {
      let result = value; for (const [token, replacement] of replacements) result = result.split(token).join(replacement);
      const out: JsonObject[] = []; let start = 0;
      while (start < result.length) {
        let next = result.length, found: [string, JsonObject] | undefined;
        for (const entry of cards) { const at = result.indexOf(entry[0], start); if (at >= 0 && at < next) { next = at; found = entry; } }
        out.push(...projectMarkdownWithDiagrams(result.slice(start, next)));
        if (!found) break;
        out.push(found[1]); start = next + found[0].length;
      }
      return out;
    };
    function part(rawPart: unknown): JsonObject[] {
      if (typeof rawPart === 'string') return markdown(rawPart);
      const p = object(rawPart), type = text(p['content_type']);
      if (type === 'image_asset_pointer' && text(p['asset_pointer'])) return [{ type: 'image', resource: resource(String(p['asset_pointer']), p, 'image') }];
      if (type === 'audio_transcription' || type === 'text') return text(p['text']) ? [{ type: 'text', text: p['text']! }] : [];
      if (type === 'audio_asset_pointer' && text(p['asset_pointer'])) return [{ type: 'attachment', resource: resource(String(p['asset_pointer']), p, 'audio') }];
      if (type === 'real_time_user_audio_video_asset_pointer') {
        const blocks = [p['audio_asset_pointer'], ...list(p['video_asset_pointers'])].filter(v => v !== undefined && v !== null).flatMap(part);
        return blocks.length ? blocks : [{ type: 'unknown', kind: slug(type), text: JSON.stringify(p) }];
      }
      if (type === 'text_audio') return [...(p['text'] ? part(p['text']) : []), ...(p['audio'] ? part(p['audio']) : [])];
      if (!Object.keys(p).length) return [];
      limit('official_fragment_unmapped', `ChatGPT ${type ?? 'part'} retained as source data.`);
      return [{ type: 'unknown', kind: slug(type ?? 'part'), text: JSON.stringify(rawPart) }];
    }
    const type = text(body['content_type']);
    if (type === 'text' || type === 'multimodal_text') content.push(...list(body['parts']).flatMap(part));
    else if (type === 'thoughts') {
      for (const value of list(body['thoughts'])) {
        const thought = object(value), summary = text(thought['summary']), detail = text(thought['content']);
        if (summary || detail) content.push({ type: summary ? 'reasoning_summary' : 'reasoning', ...(summary ? { title: summary } : {}), ...(detail ? { text: detail, format: 'markdown' } : {}) });
        else if (typeof value === 'string' && value) content.push({ type: 'reasoning', text: value, format: 'markdown' });
        else if (Object.keys(thought).length && list(thought['chunks']).length) content.push({ type: 'unknown', kind: 'chatgpt-thought', text: JSON.stringify(value) });
      }
    } else if (type === 'reasoning_recap') {
      const title = text(body['content']); if (title) content.push({ type: 'status', title });
    } else if (type === 'code') {
      const code = text(body['text']); if (code) content.push({ type: 'code', code, ...(text(body['language']) ? { language: body['language']! } : {}) });
    } else if (type === 'execution_output') {
      if (text(body['text'])) content.push({ type: 'tool', kind: 'result', ...(text(author['name']) ? { name: author['name']! } : {}), output: body['text']! });
    } else if (type) content.push(...part(body));
    const recipient = text(raw['recipient']), name = text(author['name']);
    if (role === 'assistant' && recipient && recipient !== 'all') {
      content.splice(0, content.length, { type: 'tool', kind: 'call', name: recipient, call: text(metadata['tool_call_id']) ?? key, input: body });
    } else if (role === 'assistant' && ['analysis', 'commentary'].includes(String(raw['channel']))) {
      for (const block of content) if (block['type'] === 'markdown' || block['type'] === 'text') { block['format'] = block['type'] === 'markdown' ? 'markdown' : 'text'; block['type'] = raw['channel'] === 'analysis' ? 'reasoning' : 'reasoning_summary'; }
    } else if (role === 'tool' && type !== 'execution_output' && content.length) {
      content.splice(0, content.length, { type: 'tool', kind: 'result', ...(name ? { name } : {}), ...(text(metadata['tool_call_id']) ? { call: metadata['tool_call_id']! } : {}), output: body });
    }
    for (const a of list(metadata['attachments'])) {
      const attachment = object(a), fileId = text(attachment['id']);
      if (!fileId) continue; const res = resource(`file-service://${fileId}`, attachment);
      if (!content.some(b => b['resource'] === res)) content.push({ type: 'attachment', resource: res });
    }
    content.push(...referenceExtras, ...[...cards.values()].filter(card => !content.includes(card)));
    if (refs.length) content.push({ type: 'citations', sources: [...new Set(refs)] });
    for (const group of list(object(metadata['work_activity'])['groups'])) for (const item of list(object(group)['items'])) {
      const activity = object(item); content.push({ type: 'tool', kind: 'activity', ...(text(activity['kind']) ? { name: activity['kind']!, title: activity['kind']! } : {}), output: activity });
    }
    const parent = text(node['parent']), timestamp = nativeTime(raw['create_time'], 'seconds');
    const model = role === 'assistant' ? text(metadata['model_slug']) ?? text(metadata['resolved_model_slug']) : undefined;
    const authorId = text(author['id']);
    messages.push({ id: key, role, ...(parent ? { parent } : {}), ...(timestamp ? { timestamp } : {}), content });
    facts.push({ id: key, role, ...(parent ? { parent } : {}), ...(model ? { model } : {}), ...(name ? { name } : {}), ...(authorId ? { sourceId: authorId } : {}), ...(role === 'developer' ? { subject: 'program' } : {}) });
  }
  const title = text(record['title']), current = text(record['current_node']), created = nativeTime(record['create_time'], 'seconds'), updated = nativeTime(record['update_time'], 'seconds');
  const result = finishOfficial(input, CHATGPT_OFFICIAL_MANIFEST, id, { messages, facts, resources, references, limitations, ...(title ? { title } : {}), ...(current ? { current } : {}), ...(created ? { created } : {}), ...(updated ? { updated } : {}) });
  object(result.parsed.draft['source'])['url'] = `https://chatgpt.com/c/${encodeURIComponent(id)}`;
  return result;
}
