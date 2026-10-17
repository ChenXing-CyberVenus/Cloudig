import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';
import type { SourceMessageFacts } from '../../app/parser/adapter.mts';
import { projectMarkdownWithDiagrams } from './markdown-diagrams.mts';
import { object, list, text, nativeTime, officialManifest, finishOfficial, metadataResource, type OfficialRecordInput } from './official-record.mts';

export const GROK_OFFICIAL_MANIFEST = officialManifest('grok');
export const grokOfficialTime = (v: unknown) => {
  if (isJsonObject(v)) { const date = v['$date']; return isJsonObject(date) ? nativeTime(date['$numberLong'], 'milliseconds') : nativeTime(date); }
  return nativeTime(v);
};
export function extractGrokOfficial(input: OfficialRecordInput) {
  const record = input.record, conversation = object(record['conversation']), id = text(conversation['id']);
  if (!id || !Array.isArray(record['responses'])) throw new TypeError('Grok export needs conversation.id and responses');
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], resources: JsonObject[] = [], references: JsonObject[] = [], limitations: JsonObject[] = [], ids = new Set<string>();
  const addReferences = (raws: unknown): string[] => list(raws).map(raw => {
    const rawRef = object(raw), ref: JsonObject = { id: `s${references.length + 1}`, kind: 'web' };
    for (const field of ['url', 'title']) if (text(rawRef[field])) ref[field] = rawRef[field]!;
    const snippet = text(rawRef['preview']) ?? text(rawRef['description']); if (snippet) ref['snippet'] = snippet;
    if (Object.keys(ref).length === 2) { ref['kind'] = 'other'; ref['text'] = JSON.stringify(raw); }
    references.push(ref); return String(ref['id']);
  });
  for (const wrapper of record['responses']) {
    const raw = object(object(wrapper)['response']), messageId = text(raw['_id']), sender = String(raw['sender']).toLowerCase();
    if (!messageId || ids.has(messageId) || !['human', 'assistant'].includes(sender)) throw new TypeError('Grok response identity or sender is invalid');
    ids.add(messageId); const role = sender === 'human' ? 'user' : 'assistant', parent = text(raw['parent_response_id']);
    const model = role === 'assistant' ? text(raw['model']) ?? text(object(object(raw['metadata'])['request_metadata'])['resolved_model']) : undefined;
    const content: JsonObject[] = [], stepTexts: string[] = [];
    for (const stepRaw of list(raw['steps'])) {
      const step = object(stepRaw), tagged = object(step['tagged_text']), ordered = [...new Set([...list(step['tag_order']).filter((v): v is string => typeof v === 'string'), ...Object.keys(tagged)])];
      const consumed = new Set<string>();
      for (const tag of ordered) {
        const body = text(tagged[tag]); if (!body) continue;
        if (tag === 'tool_usage_card') {
          let matched = false;
          for (const match of body.matchAll(/<xai:tool_usage_card>([\s\S]*?)<\/xai:tool_usage_card>/giu)) {
            matched = true; const xml = match[1]!;
            const field = (key: string) => new RegExp(`<xai:${key}>([\\s\\S]*?)</xai:${key}>`, 'iu').exec(xml)?.[1]?.trim();
            const call = field('tool_usage_card_id'), name = field('tool_name'), args = field('tool_args');
            const results = list(step['tool_usage_results']).filter(r => call && object(r)['tool_usage_card_id'] === call);
            if (call) consumed.add(call);
            content.push({ type: 'tool', kind: 'activity', ...(call ? { call } : {}), ...(name ? { name, title: name } : {}),
              ...(args ? { input: args.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1') } : {}), ...(results.length ? { output: results } : {}) });
          }
          if (!matched) content.push({ type: 'tool', kind: 'activity', name: 'Grok tool', output: body });
        } else if (tag === 'raw_function_result') content.push({ type: 'tool', kind: 'result', output: body });
        else { stepTexts.push(body); content.push({ type: tag === 'header' || tag === 'summary' ? 'reasoning_summary' : 'reasoning', text: body, format: 'markdown' }); }
      }
      for (const result of list(step['tool_usage_results'])) if (!consumed.has(String(object(result)['tool_usage_card_id']))) content.push({ type: 'tool', kind: 'result', output: result });
      const refs = addReferences(step['web_search_results']);
      for (const post of list(step['x_posts_ids'])) if (typeof post === 'string') { const ref = { id: `s${references.length + 1}`, kind: 'web', url: `https://x.com/i/status/${encodeURIComponent(post)}` }; references.push(ref); refs.push(ref.id); }
      if (refs.length) content.push({ type: 'search', sources: refs });
      for (const key of ['rag_results', 'connector_search_results', 'collection_search_results']) if (list(step[key]).length) content.push({ type: 'tool', kind: 'result', name: key, output: step[key]! });
    }
    const trace = text(raw['thinking_trace']); if (trace && trace !== stepTexts.join('') && trace !== stepTexts.join('\n')) content.push({ type: 'reasoning', text: trace, format: 'markdown' });
    for (const agent of list(raw['agent_thinking_traces'])) {
      const thought = text(object(agent)['thinking_trace']);
      if (thought && thought !== trace && thought !== stepTexts.join('') && thought !== stepTexts.join('\n')) content.push({ type: 'reasoning', text: thought, format: 'markdown' });
    }
    const cards = new Map<string, JsonObject>();
    for (const cardRaw of list(raw['card_attachments_json'])) {
      let card: JsonObject = object(cardRaw);
      if (typeof cardRaw === 'string') { try { card = object(JSON.parse(cardRaw)); } catch { content.push({ type: 'unknown', kind: 'grok-card', text: cardRaw }); continue; } }
      if (text(card['id'])) cards.set(String(card['id']), card); else content.push({ type: 'unknown', kind: 'grok-card', text: JSON.stringify(cardRaw) });
    }
    const renderCard = (card: JsonObject): JsonObject[] => {
      if (card['cardType'] === 'citation_card' && text(card['url'])) return [{ type: 'citations', sources: addReferences([card]) }];
      const searched = object(card['image']), original = text(searched['original']) ?? text(searched['thumbnail']);
      if (card['cardType'] === 'image_card' && original) {
        const caption = text(card['caption']) ?? text(searched['description']) ?? text(searched['title']);
        const resource = metadataResource(resources, { kind: 'image', url: original, ...(text(searched['title']) ? { name: String(searched['title']) } : {}) });
        const blocks: JsonObject[] = [{ type: 'image', resource, ...(caption ? { alt: caption } : {}) }];
        if (text(searched['link'])) blocks.push({ type: 'citations', sources: addReferences([{ url: searched['link']!, ...(text(searched['title']) ? { title: searched['title']! } : {}) }]) });
        return blocks;
      }
      const image = object(card['image_chunk']), url = text(image['imageUrl']);
      if (card['type'] === 'render_generated_image' && url) {
        const resource = metadataResource(resources, { kind: 'image', name: text(image['imageTitle']) ?? 'Generated image', url });
        return [{ type: 'image', resource, ...(text(card['prompt']) ? { alt: card['prompt']! } : {}) }];
      }
      limitations.push({ code: 'official_fragment_unmapped', detail: `Grok card ${String(card['type'])} retained as data` });
      return [{ type: 'unknown', kind: 'grok-card', text: JSON.stringify(card) }];
    };
    const body = text(raw['message']) ?? text(raw['query']) ?? ''; let offset = 0;
    for (const match of body.matchAll(/<grok:render\b[^>]*\bcard_id=["']([^"']+)["'][^>]*>[\s\S]*?<\/grok:render>/giu)) {
      const card = cards.get(match[1]!); if (!card) continue;
      content.push(...projectMarkdownWithDiagrams(body.slice(offset, match.index)), ...renderCard(card)); cards.delete(match[1]!); offset = match.index! + match[0].length;
    }
    content.push(...projectMarkdownWithDiagrams(body.slice(offset))); for (const card of cards.values()) content.push(...renderCard(card));
    for (const attachment of list(raw['file_attachments'])) {
      const name = typeof attachment === 'string' ? attachment : text(object(attachment)['name']) ?? 'Attachment';
      content.push({ type: 'attachment', resource: metadataResource(resources, { name }) });
    }
    for (const url of list(raw['generated_image_urls'])) if (typeof url === 'string' && !resources.some(r => object(r['original'])['url'] === url)) content.push({ type: 'image', resource: metadataResource(resources, { kind: 'image', url }) });
    const refs = addReferences([ ...list(raw['web_search_results']), ...list(raw['cited_web_search_results']) ]);
    if (refs.length) content.push({ type: 'citations', sources: refs });
    if (text(raw['error'])) content.push({ type: 'status', title: 'Grok', text: raw['error']! });
    const timestamp = grokOfficialTime(raw['create_time']);
    messages.push({ id: messageId, role, ...(parent ? { parent } : {}), ...(timestamp ? { timestamp } : {}), content });
    facts.push({ id: messageId, role, ...(parent ? { parent } : {}), ...(model ? { model } : {}) });
  }
  const title = text(conversation['title']), current = text(conversation['leaf_response_id']), created = grokOfficialTime(conversation['create_time']), updated = grokOfficialTime(conversation['modify_time']);
  return finishOfficial(input, GROK_OFFICIAL_MANIFEST, id, { messages, facts, resources, references, limitations,
    ...(title ? { title } : {}), ...(current ? { current } : {}), ...(created ? { created } : {}), ...(updated ? { updated } : {}) });
}
