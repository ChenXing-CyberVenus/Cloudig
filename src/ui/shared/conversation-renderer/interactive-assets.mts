import { INTERACTIVE_LIMITS } from "./interactive-protocol.mts";

/** Immutable bytes only, bounded to this renderer process. No running frames,
 * author state or disk cache is retained. Aborted loads never populate it. */
const cache = new Map<string, ArrayBuffer>();
let retained = 0;
export function clearInteractiveAssets(): void { cache.clear(); retained = 0; }
export async function readInteractiveAsset(key: string, signal: AbortSignal, load: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  signal.throwIfAborted(); const found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return found; }
  const bytes = await load(); signal.throwIfAborted();
  if (bytes.byteLength <= INTERACTIVE_LIMITS.assetMemoryBytes) {
    while (retained + bytes.byteLength > INTERACTIVE_LIMITS.assetMemoryBytes && cache.size) {
      const oldest = cache.keys().next().value!; retained -= cache.get(oldest)!.byteLength; cache.delete(oldest);
    }
    const previous = cache.get(key); if (previous) retained -= previous.byteLength;
    cache.set(key, bytes); retained += bytes.byteLength;
  }
  return bytes;
}

export async function mapInteractiveAssets<T, R>(values: readonly T[], signal: AbortSignal, read: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(INTERACTIVE_LIMITS.assetReadConcurrency, values.length) }, async () => {
    while (cursor < values.length) { signal.throwIfAborted(); const index = cursor++; result[index] = await read(values[index]!, index); }
  })); return result;
}
