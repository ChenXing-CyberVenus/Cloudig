import assert from "node:assert/strict";
import test from "node:test";
import { clearInteractiveAssets, mapInteractiveAssets, readInteractiveAsset } from "../../../src/ui/shared/conversation-renderer/interactive-assets.mts";
import { INTERACTIVE_LIMITS } from "../../../src/ui/shared/conversation-renderer/interactive-protocol.mts";

test("work asset reads are bounded parallel and preserve source order", async () => {
  let active = 0, maximum = 0; const abort = new AbortController();
  const values = await mapInteractiveAssets([0, 1, 2, 3, 4, 5, 6], abort.signal, async value => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 3)); active--; return value * 2; });
  assert.deepEqual(values, [0, 2, 4, 6, 8, 10, 12]); assert.equal(maximum, INTERACTIVE_LIMITS.assetReadConcurrency);
});
test("read-only bytes are reused across reopen; abort and failures do not poison the cache", async () => {
  clearInteractiveAssets(); let reads = 0; const abort = new AbortController(), load = async () => { reads++; return new ArrayBuffer(4); };
  const first = await readInteractiveAsset("a", abort.signal, load); assert.equal(await readInteractiveAsset("a", abort.signal, load), first); assert.equal(reads, 1);
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(readInteractiveAsset("a", cancelled.signal, load), { name: "AbortError" });
  await assert.rejects(readInteractiveAsset("bad", abort.signal, async () => { throw Error("missing"); }), /missing/u); await readInteractiveAsset("bad", abort.signal, load); assert.equal(reads, 2); clearInteractiveAssets();
});
test("asset memory evicts oldest entries at the explicit budget rather than growing with every work", async () => {
  clearInteractiveAssets(); const signal = new AbortController().signal; let reads = 0;
  const load = async () => { reads++; return new ArrayBuffer(INTERACTIVE_LIMITS.assetMemoryBytes / 2 + 1); };
  await readInteractiveAsset("one", signal, load); await readInteractiveAsset("two", signal, load); await readInteractiveAsset("one", signal, load); assert.equal(reads, 3); clearInteractiveAssets();
});
