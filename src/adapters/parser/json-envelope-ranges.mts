import type { Readable } from 'node:stream';
import { parseRecordJson } from '../../core/records/json.mts';
import type { JsonArrayRange } from './json-array-stream.mts';

export const JSON_ENVELOPE_LIMITS = Object.freeze({ propertyBytes: 4096, cancellationInterval: 65536 });
export type JsonPropertyRange = JsonArrayRange & Readonly<{ key: string }>;
const space = (b: number) => b === 9 || b === 10 || b === 13 || b === 32;

/** Locate root-object values without materializing a large conversation array.
 * Values are decoded/validated by the range consumer. Keys and the envelope are
 * strict, including duplicates, separators, UTF-8, BOM and trailing bytes. */
export async function* streamTopLevelJsonObjectRanges(source: Readable, options: Readonly<{
  signal?: AbortSignal; onProgress?: (bytes: number, properties: number) => void;
}> = {}): AsyncGenerator<JsonPropertyRange> {
  let stage: 'root'|'key'|'key-body'|'colon'|'value'|'value-body'|'separator'|'closed' = 'root';
  let offset = 0, index = 0, key = '', keyBytes: number[] = [], escaped = false, inString = false;
  let start = 0, end = 0, allowEnd = true, bom = 0;
  const seen = new Set<string>(), stack: number[] = [];
  for await (const raw of source) {
    options.signal?.throwIfAborted(); const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (let i = 0; i < chunk.length; i++) {
      if (i % JSON_ENVELOPE_LIMITS.cancellationInterval === 0) options.signal?.throwIfAborted();
      const b = chunk[i]!, at = offset + i;
      if (at === 0 && b === 0xef) { bom = 1; continue; }
      if (bom > 0 && bom < 3) { if (b !== (bom === 1 ? 0xbb : 0xbf)) throw new SyntaxError('Invalid JSON BOM'); bom++; continue; }
      if (stage === 'root') { if (space(b)) continue; if (b !== 123) throw new SyntaxError('Expected a JSON object'); stage = 'key'; continue; }
      if (stage === 'closed') { if (!space(b)) throw new SyntaxError('Unexpected data after JSON object'); continue; }
      if (stage === 'key') {
        if (space(b)) continue;
        if (b === 125 && allowEnd) { stage = 'closed'; continue; }
        if (b !== 34) throw new SyntaxError('Expected a JSON property name');
        keyBytes = [b]; escaped = false; stage = 'key-body'; continue;
      }
      if (stage === 'key-body') {
        keyBytes.push(b); if (keyBytes.length > JSON_ENVELOPE_LIMITS.propertyBytes) throw new RangeError('JSON property name exceeds the envelope limit');
        if (escaped) { escaped = false; continue; }
        if (b === 92) { escaped = true; continue; }
        if (b !== 34) continue;
        const decoded = parseRecordJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(keyBytes)));
        if (typeof decoded !== 'string' || seen.has(decoded)) throw new SyntaxError('Duplicate or invalid JSON property');
        key = decoded; seen.add(key); stage = 'colon'; continue;
      }
      if (stage === 'colon') { if (space(b)) continue; if (b !== 58) throw new SyntaxError('Expected a property colon'); stage = 'value'; continue; }
      if (stage === 'separator') {
        if (space(b)) continue;
        if (b === 125) { stage = 'closed'; continue; }
        if (b !== 44) throw new SyntaxError('Expected a property separator');
        stage = 'key'; allowEnd = false; continue;
      }
      if (stage === 'value') {
        if (space(b)) continue;
        if (b === 44 || b === 125) throw new SyntaxError('Empty JSON property value');
        start = at; end = at; stack.length = 0; inString = false; escaped = false; stage = 'value-body';
      }
      if (!inString && stack.length === 0 && (b === 44 || b === 125)) {
        yield { key, index: index++, offset: start, length: end - start };
        if (b === 125) stage = 'closed'; else { stage = 'key'; allowEnd = false; }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (b === 92) escaped = true;
        else if (b === 34) inString = false;
      } else if (b === 34) inString = true;
      else if (b === 123 || b === 91) stack.push(b === 123 ? 125 : 93);
      else if (b === 125 || b === 93) {
        if (stack.pop() !== b) throw new SyntaxError('Mismatched JSON container close');
      }
      if (!space(b)) end = at + 1;
      // Compound and quoted values end exactly here; primitive values are
      // delimited on the next comma/brace and checked by parseJsonRange.
      if (!inString && stack.length === 0 && (b === 125 || b === 93 || b === 34)) {
        yield { key, index: index++, offset: start, length: end - start }; stage = 'separator';
      }
    }
    offset += chunk.length; options.onProgress?.(offset, index);
  }
  options.signal?.throwIfAborted();
  if (stage !== 'closed') throw new SyntaxError('JSON object ended before its envelope closed');
}
