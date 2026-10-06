import { isJsonObject, type JsonObject } from '../../core/contracts/types.mts';

/** A reading grouping, not a mutation or a new persisted message type. */
export function isSummaryContent(value: JsonObject): boolean {
  if (value['type'] !== 'reasoning_summary') return false;
  if (isJsonObject(value['party']) && value['party']['role'] !== 'assistant') return false;
  const body = typeof value['text'] === 'string' ? value['text'] : '';
  const visible = value['format'] === 'html' ? body.replace(/<[^>]*>|&(?:nbsp|#160|#xa0);/giu, '') : body;
  if (visible.trim() || /<(?:img|svg|math)\b/iu.test(body) || Array.isArray(value['content']) && value['content'].length) return true;
  // Source-authored titles can themselves be the complete summary. Empty
  // elapsed-only notices must remain non-expandable, not become fake bodies.
  const title = typeof value['title'] === 'string' ? value['title'].trim() : '';
  return Boolean(title && !/^(?:思考(?:摘要|过程|了.*)?|thinking|thoughts?|thought process|reasoning(?: summary)?|thought for .*)$/iu.test(title));
}

export function isSummaryView(block: JsonObject): boolean {
  if (isJsonObject(block['value']) && isJsonObject(block['value']['party']) && block['value']['party']['role'] !== 'assistant') return false;
  return block['category'] === 'reasoning' && isJsonObject(block['value']) &&
    (isSummaryContent(block['value']) || block['value']['type'] === 'reasoning_summary' && Array.isArray(block['blocks']) && block['blocks'].length > 0);
}

export function sameSummarySpeaker(left: JsonObject, right: JsonObject): boolean {
  return left['speaker'] === right['speaker'] && JSON.stringify(left['party'] ?? null) === JSON.stringify(right['party'] ?? null);
}
