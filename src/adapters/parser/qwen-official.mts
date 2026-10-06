import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';
import type { SourceMessageFacts } from '../../app/parser/adapter.mts';
import { projectMarkdownWithDiagrams } from './markdown-diagrams.mts';
import { object, list, text, nativeTime, officialManifest, finishOfficial, metadataResource, type OfficialRecordInput } from './official-record.mts';

export const QWEN_OFFICIAL_MANIFEST = officialManifest('qwen');
export function extractQwenOfficial(input: OfficialRecordInput) {
  const record = input.record, chat = object(record['chat']), history = object(chat['history']), pool = history['messages'], id = text(record['id']);
  if (!id || !isJsonObject(pool)) throw new TypeError('Qwen export requires id and history.messages');
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], resources: JsonObject[] = [], references: JsonObject[] = [], limitations: JsonObject[] = [];
  for (const [key, value] of Object.entries(pool)) {
    if (!isJsonObject(value) || value['id'] !== key || !['user', 'assistant', 'system', 'tool'].includes(String(value['role']))) throw new TypeError('Qwen message identity or role is invalid');
    const role = String(value['role']), parent = text(value['parentId']), model = role === 'assistant' ? text(value['modelName']) ?? text(value['model']) : undefined;
    const content: JsonObject[] = [], answerParts: string[] = [], reasoning = text(value['reasoning_content']);
    if (reasoning) content.push({ type: 'reasoning', text: reasoning, format: 'markdown' });
    for (const raw of list(value['content_list'])) {
      const block = object(raw), phase = text(block['phase']), body = text(block['content']), extra = object(block['extra']);
      if (phase === 'answer' && body) { answerParts.push(body); content.push(...projectMarkdownWithDiagrams(body)); }
      else if (phase === 'thinking_summary') {
        const titles = list(object(extra['summary_title'])['content']), thoughts = list(object(extra['summary_thought'])['content']);
        for (let i = 0; i < Math.max(titles.length, thoughts.length); i++) {
          const title = text(titles[i]), thought = text(thoughts[i]);
          if (title || thought) content.push({ type: 'reasoning_summary', ...(title ? { title } : {}), ...(thought ? { text: thought, format: 'markdown' } : {}) });
        }
        if (body) content.push({ type: 'reasoning_summary', text: body, format: 'markdown' });
      } else if (phase === 'web_search') {
        const call = object(block['function_call']);
        if (call['arguments'] !== undefined || extra['tool_result'] !== undefined) content.push({ type: 'tool', kind: 'activity', name: text(call['name']) ?? 'web_search', title: 'Web search',
          ...(text(block['function_id']) ? { call: block['function_id']! } : {}), ...(call['arguments'] !== undefined ? { input: call['arguments'] } : {}),
          ...(extra['tool_result'] !== undefined ? { output: extra['tool_result'] } : {}) });
        const ids = list(extra['web_search_info']).map(raw => {
          const r = object(raw), ref: JsonObject = { id: `s${references.length + 1}`, kind: 'web' };
          for (const field of ['url', 'title', 'snippet']) if (text(r[field])) ref[field] = r[field]!;
          references.push(ref); return ref['id']!;
        });
        content.push({ type: 'search', ...(ids.length ? { sources: ids } : {}), ...(body ? { query: body } : {}) });
      } else if (phase === 'bio') {
        const call = object(block['function_call']);
        content.push({ type: 'tool', kind: 'activity', name: text(call['name']) ?? 'bio', title: 'Memory',
          ...(call['arguments'] !== undefined ? { input: call['arguments'] } : {}), ...(extra['tool_result'] !== undefined ? { output: extra['tool_result'] } : {}) });
      } else if (phase === 'image_gen' && body) {
        for (const url of body.split(/\s+/u).filter(Boolean)) {
          const resource = metadataResource(resources, { kind: 'image', url }); content.push({ type: 'image', resource });
        }
      } else if (!(phase === 'answer' && !body)) {
        content.push({ type: 'unknown', kind: `qwen-${phase ?? 'phase'}`, text: JSON.stringify(raw) });
        limitations.push({ code: 'official_fragment_unmapped', detail: `Qwen ${phase ?? '(no phase)'} retained as data` });
      }
    }
    // Current exports leave message.content empty and put the complete answer
    // in content_list. A non-identical nonempty legacy body remains visible.
    const body = text(value['content']);
    if (body && body !== answerParts.join('')) content.push(...projectMarkdownWithDiagrams(body));
    for (const raw of list(value['files'])) {
      const file = object(raw), meta = object(object(file['file'])['meta']), mime = text(file['file_type']) ?? text(meta['content_type']), name = text(file['name']) ?? text(meta['name']);
      const kind = file['type'] === 'image' || mime?.startsWith('image/') ? 'image' : 'file', url = text(file['url']);
      const bytes = typeof file['size'] === 'number' ? file['size'] : typeof meta['size'] === 'number' ? meta['size'] : undefined;
      const resource = metadataResource(resources, { kind, ...(name ? { name } : {}), ...(mime ? { mime } : {}), ...(url ? { url } : {}), ...(bytes !== undefined ? { bytes } : {}) });
      content.push({ type: kind === 'image' ? 'image' : 'attachment', resource });
    }
    const error = value['error'];
    if (typeof error === 'string' && error || isJsonObject(error) && Object.keys(error).length || error === true) {
      const info = object(error), known = Object.keys(info).every(k => ['code', 'details', 'message'].includes(k));
      const description = known ? [text(info['code']), text(info['details']) ?? text(info['message'])].filter(Boolean).join('\n') : undefined;
      content.push({ type: 'status', title: 'Qwen', text: description || (typeof error === 'string' ? error : JSON.stringify(error)) });
    }
    const timestamp = nativeTime(value['timestamp'], 'seconds');
    messages.push({ id: key, role, ...(parent ? { parent } : {}), ...(timestamp ? { timestamp } : {}), content });
    facts.push({ id: key, role, ...(parent ? { parent } : {}), ...(model ? { model } : {}), ...(role === 'tool' && text(value['name']) ? { name: String(value['name']) } : {}) });
  }
  const title = text(record['title']) ?? text(chat['title']), current = text(history['currentId']) ?? text(record['currentId']);
  const created = nativeTime(record['created_at'], 'seconds'), updated = nativeTime(record['updated_at'], 'seconds');
  return finishOfficial(input, QWEN_OFFICIAL_MANIFEST, id, { messages, facts, resources, references, limitations,
    ...(title ? { title } : {}), ...(current ? { current } : {}), ...(created ? { created } : {}), ...(updated ? { updated } : {}) });
}
