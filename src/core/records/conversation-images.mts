import { isJsonObject, type JsonObject } from '../contracts/types.mts';
import { blockHtml, htmlResourceImages } from './html-resources.mts';

/** Inspect ALL branches, including hidden process content. An image used on
 * another branch is not an unplaced attachment of the currently visible one. */
export function referencedResources(blocks: readonly JsonObject[]): Set<string> {
  const used = new Set<string>(), pending = [...blocks];
  while (pending.length) {
    const block = pending.pop()!;
    for (const field of ['resource', 'rendered', 'input_resource', 'output_resource', 'preview']) {
      if (typeof block[field] === 'string') used.add(block[field]);
    }
    const html = blockHtml(block);
    if (html !== undefined) for (const image of htmlResourceImages(html)) used.add(image.id);
    for (const field of ['content', 'files']) if (Array.isArray(block[field])) pending.push(...block[field].filter(isJsonObject));
  }
  return used;
}

export function conversationImages(conversation: JsonObject): JsonObject[] {
  const messages = Array.isArray(conversation['messages']) ? conversation['messages'] : isJsonObject(conversation['messages']) ? conversation['messages']['items'] : [];
  const blocks = (Array.isArray(messages) ? messages : []).filter(isJsonObject).flatMap(m => Array.isArray(m['content']) ? m['content'].filter(isJsonObject) : []);
  const used = referencedResources(blocks);
  return (Array.isArray(conversation['resources']) ? conversation['resources'] : []).filter(isJsonObject)
    .filter(r => r['kind'] === 'image' && r['availability'] === 'embedded' && !used.has(String(r['id'])));
}
